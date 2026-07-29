import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";

const SERVER_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const BASE_ENVIRONMENT_KEYS = new Set([
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR"
]);

function boundedTimeout(value) {
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new TypeError("timeoutMs must be an integer between 100 and 120000");
  }
  return value;
}

function requireServerRef(value) {
  if (typeof value !== "string" || !SERVER_REF.test(value)) {
    throw new TypeError("serverRef must be a portable identifier");
  }
  return value;
}

function selectedEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => (
    BASE_ENVIRONMENT_KEYS.has(name.toUpperCase()) &&
    typeof value === "string" &&
    value.length > 0
  )));
}

function parseJson(value, maxBytes = MAX_CONFIG_BYTES) {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function validateTransport(config, serverRef, environment) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    config.name !== serverRef ||
    config.enabled !== true
  ) return undefined;
  const transport = config.transport;
  if (
    !transport ||
    typeof transport !== "object" ||
    Array.isArray(transport) ||
    transport.type !== "stdio" ||
    typeof transport.command !== "string" ||
    transport.command.length === 0 ||
    !Array.isArray(transport.args) ||
    transport.args.some((argument) => typeof argument !== "string") ||
    !transport.env ||
    typeof transport.env !== "object" ||
    Array.isArray(transport.env) ||
    Object.entries(transport.env).some(([name, value]) => (
      !ENVIRONMENT_NAME.test(name) || typeof value !== "string"
    )) ||
    !Array.isArray(transport.env_vars) ||
    transport.env_vars.some((name) => (
      typeof name !== "string" || !ENVIRONMENT_NAME.test(name)
    )) ||
    !(transport.cwd === null || transport.cwd === undefined || (
      typeof transport.cwd === "string" && path.isAbsolute(transport.cwd)
    ))
  ) return undefined;
  const inherited = {};
  for (const name of transport.env_vars) {
    const value = environment[name];
    if (typeof value !== "string") return undefined;
    inherited[name] = value;
  }
  return {
    command: transport.command,
    args: [...transport.args],
    cwd: transport.cwd ?? undefined,
    env: {
      ...selectedEnvironment(environment),
      ...inherited,
      ...transport.env
    }
  };
}

function defaultGetServerConfig(serverRef, {
  codexBin,
  environment,
  timeoutMs
}) {
  const result = spawnSync(codexBin, ["mcp", "get", serverRef, "--json"], {
    encoding: "utf8",
    env: selectedEnvironment(environment),
    timeout: timeoutMs,
    maxBuffer: MAX_CONFIG_BYTES
  });
  if (result.status !== 0 || result.error) return undefined;
  return parseJson(result.stdout);
}

class StdioMcpServer {
  constructor({ transport, timeoutMs, spawnProcess }) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
  }

  async #request(method, params) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnProcess(this.transport.command, this.transport.args, {
          cwd: this.transport.cwd,
          env: this.transport.env,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch {
        reject(new Error("MCP process could not start"));
        return;
      }
      let phase = "active";
      let initialized = false;
      let buffer = "";
      let bytes = 0;
      let forceKillTimer;
      let completion;
      const timer = setTimeout(() => stop(new Error("MCP request timed out")), this.timeoutMs);

      function settle() {
        if (phase === "settled") return;
        phase = "settled";
        clearTimeout(timer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        child.stdout?.removeAllListeners();
        child.stdin?.removeAllListeners();
        child.removeAllListeners();
        if (completion.error) reject(completion.error);
        else resolve(completion.value);
      }

      function stop(error, value) {
        if (phase !== "active") return;
        phase = "stopping";
        completion = { error, value };
        clearTimeout(timer);
        child.stdout?.removeAllListeners("data");
        try {
          child.stdin?.end();
        } catch {
          // The process will still be terminated below.
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          settle();
          return;
        }
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 250);
        try {
          child.kill("SIGTERM");
        } catch {
          settle();
        }
      }

      function send(value) {
        if (phase !== "active") return;
        try {
          child.stdin.write(`${JSON.stringify(value)}\n`);
        } catch {
          stop(new Error("MCP process input failed"));
        }
      }

      child.once("error", () => {
        if (phase !== "active") return;
        phase = "stopping";
        completion = { error: new Error("MCP process failed") };
        settle();
      });
      child.once("close", () => {
        if (phase === "active") {
          phase = "stopping";
          completion = { error: new Error("MCP process closed before responding") };
        }
        settle();
      });
      child.stdin.once("error", () => stop(new Error("MCP process input failed")));
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          stop(new Error("MCP response exceeded the size limit"));
          return;
        }
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const message = parseJson(line, MAX_RESPONSE_BYTES);
          if (!message || message.jsonrpc !== "2.0") continue;
          if (message.id === 1 && !initialized) {
            if (message.error || !message.result) {
              stop(new Error("MCP initialization failed"));
              return;
            }
            initialized = true;
            send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
            send({ jsonrpc: "2.0", id: 2, method, params });
          } else if (message.id === 2) {
            if (message.error || message.result === undefined) {
              stop(new Error("MCP request failed"));
              return;
            }
            stop(null, message.result);
            return;
          }
        }
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "feishu-digital-twin", version: "1" }
        }
      });
    });
  }

  async listTools() {
    return this.#request("tools/list", {});
  }

  async callTool(request) {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      typeof request.name !== "string" ||
      request.name.length === 0 ||
      !request.arguments ||
      typeof request.arguments !== "object" ||
      Array.isArray(request.arguments)
    ) {
      throw new TypeError("MCP tool request is invalid");
    }
    return this.#request("tools/call", {
      name: request.name,
      arguments: structuredClone(request.arguments)
    });
  }
}

export function createCodexMcpResolver({
  codexBin = "codex",
  environment = process.env,
  timeoutMs = 10_000,
  getServerConfig,
  spawnProcess = spawn
} = {}) {
  if (typeof codexBin !== "string" || codexBin.length === 0) {
    throw new TypeError("codexBin is required");
  }
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  const bounded = boundedTimeout(timeoutMs);
  if (getServerConfig !== undefined && typeof getServerConfig !== "function") {
    throw new TypeError("getServerConfig must be a function");
  }
  if (typeof spawnProcess !== "function") throw new TypeError("spawnProcess must be a function");
  return async (rawServerRef) => {
    const serverRef = requireServerRef(rawServerRef);
    let config;
    try {
      config = getServerConfig
        ? await getServerConfig(serverRef)
        : defaultGetServerConfig(serverRef, {
            codexBin,
            environment,
            timeoutMs: bounded
          });
    } catch {
      return undefined;
    }
    const transport = validateTransport(config, serverRef, environment);
    return transport
      ? new StdioMcpServer({ transport, timeoutMs: bounded, spawnProcess })
      : undefined;
  };
}

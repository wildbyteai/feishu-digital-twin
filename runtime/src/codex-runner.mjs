import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { selectEnvironment } from "../../shared/subprocess-environment.mjs";
import { buildDecisionPrompt } from "./prompt.mjs";

const decisionSchema = fileURLToPath(new URL("../schemas/codex-decision.schema.json", import.meta.url));
const ENV_ALLOWLIST = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS"
]);

function privateDirectory(directory, { create = false } = {}) {
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`Codex isolation path must be a real directory: ${directory}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new TypeError("Codex isolation directories must use mode 0700");
  }
  return realpathSync(directory);
}

function isInside(parent, candidate) {
  return candidate.startsWith(`${parent}${path.sep}`);
}

function removeLegacyScratch(root, name) {
  const directory = path.join(root, name);
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("legacy Codex scratch path must be a real directory");
  }
  const resolved = realpathSync(directory);
  if (!isInside(root, resolved)) throw new TypeError("legacy Codex scratch path escaped its root");
  rmSync(resolved, { recursive: true, force: true });
}

export function resolveCodexExecutable(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("an absolute Codex executable path is required");
  }
  const executable = realpathSync(value);
  if (!lstatSync(executable).isFile()) throw new TypeError("Codex executable must be a file");
  return executable;
}

export function prepareCodexIsolation(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("an absolute Codex isolation root is required");
  }
  const root = privateDirectory(value);
  const isolation = {
    root,
    skillsHome: privateDirectory(path.join(root, "home"), { create: true }),
    codexHome: privateDirectory(path.join(root, "codex-home"), { create: true })
  };
  removeLegacyScratch(root, "tmp");
  removeLegacyScratch(root, "workspace");
  try {
    const skill = lstatSync(path.join(
      isolation.skillsHome,
      ".agents/skills/lark-shared/SKILL.md"
    ));
    if (!skill.isFile()) throw new Error("not a file");
  } catch {
    throw new TypeError("official lark Skills are not installed in the isolated Codex HOME");
  }
  return isolation;
}

function createCodexRunIsolation(isolation) {
  const runRoot = mkdtempSync(path.join(isolation.root, ".run-"));
  chmodSync(runRoot, 0o700);
  try {
    const run = {
      ...isolation,
      runRoot,
      home: privateDirectory(path.join(runRoot, "home"), { create: true }),
      tmp: privateDirectory(path.join(runRoot, "tmp"), { create: true }),
      workspace: privateDirectory(path.join(runRoot, "workspace"), { create: true })
    };
    cpSync(
      path.join(isolation.skillsHome, ".agents"),
      path.join(run.home, ".agents"),
      { recursive: true, dereference: true, errorOnExist: true, force: false }
    );
    return run;
  } catch (error) {
    rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
}

function cleanupCodexRunIsolation(isolation) {
  const metadata = lstatSync(isolation.runRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("Codex private run path must be a real directory");
  }
  const resolved = realpathSync(isolation.runRoot);
  if (!isInside(isolation.root, resolved)) {
    throw new TypeError("Codex private run path escaped its root");
  }
  rmSync(resolved, { recursive: true, force: true });
}

export function buildCodexEnvironment(environment, isolation) {
  return {
    ...selectEnvironment(environment, ENV_ALLOWLIST),
    PATH: [...new Set([path.dirname(process.execPath), "/usr/bin", "/bin"])].join(path.delimiter),
    HOME: isolation.home,
    CODEX_HOME: isolation.codexHome,
    TMPDIR: isolation.tmp,
    TMP: isolation.tmp,
    TEMP: isolation.tmp
  };
}

export function buildCodexArguments(workspace) {
  return [
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--strict-config",
    "--sandbox",
    "read-only",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-c",
    "shell_environment_policy.inherit=none",
    "-C",
    workspace,
    "--output-schema",
    decisionSchema,
    "--json",
    "-"
  ];
}

function finalDecision(stdout) {
  const messages = stdout.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line);
      return event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
        ? [event.item.text]
        : [];
    } catch {
      return [];
    }
  });
  if (messages.length === 0) throw new Error("Codex returned no final agent message");
  return JSON.parse(messages.at(-1));
}

export function runCodexDecision(event, {
  codexBin,
  isolationRoot,
  timeoutMs = 120000,
  promptContext = {}
} = {}) {
  const executable = resolveCodexExecutable(codexBin);
  const persistentIsolation = prepareCodexIsolation(isolationRoot);
  const isolation = createCodexRunIsolation(persistentIsolation);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, buildCodexArguments(isolation.workspace), {
        cwd: isolation.workspace,
        env: buildCodexEnvironment(process.env, isolation),
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      try {
        cleanupCodexRunIsolation(isolation);
      } catch {
        reject(new Error("Codex private run cleanup failed"));
        return;
      }
      reject(error);
      return;
    }
    let stdout = "";
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    function finish(error, decision) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        cleanupCodexRunIsolation(isolation);
      } catch {
        reject(new Error("Codex private run cleanup failed"));
        return;
      }
      if (error) reject(error);
      else resolve(decision);
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      finish(error);
    });
    child.once("close", (code, signal) => {
      if (timedOut) return finish(new Error(`Codex timed out after ${timeoutMs}ms`));
      if (code !== 0) {
        return finish(new Error(`Codex exited with code ${code} signal ${signal ?? "none"}`));
      }
      try {
        finish(null, finalDecision(stdout));
      } catch (error) {
        finish(error);
      }
    });
    try {
      child.stdin.end(buildDecisionPrompt(event, promptContext));
    } catch (error) {
      child.kill("SIGTERM");
      finish(error);
    }
  });
}

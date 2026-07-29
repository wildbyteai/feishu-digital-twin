import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexMcpResolver } from "../../runtime/src/codex-mcp-resolver.mjs";

function writeFixture(filename, source) {
  writeFileSync(filename, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
}

test("Codex MCP resolver 只解析精确服务器并执行标准 stdio tools 调用", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-codex-mcp-"));
  const server = path.join(directory, "server.mjs");
  const codex = path.join(directory, "codex.mjs");
  try {
    writeFixture(server, String.raw`
import process from "node:process";
process.stdin.setEncoding("utf8");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" }
        }
      }) + "\n");
    } else if (request.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [{
            name: "records.get",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true, destructiveHint: false }
          }]
        }
      }) + "\n");
    } else if (request.method === "tools/call") {
      const structuredContent = {
        name: request.params.name,
        arguments: request.params.arguments,
        stateDirVisible: process.env.FIXTURE_STATE_DIR === "private-state"
      };
      if (request.params.arguments.record_id === "large") {
        structuredContent.payload = "x".repeat(70 * 1024);
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: "ok" }],
          structuredContent
        }
      }) + "\n");
    }
  }
}
`);
    writeFixture(codex, String.raw`
import process from "node:process";
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(["mcp", "get", "fixture-records", "--json"])) {
  process.exitCode = 2;
} else {
  process.stdout.write(JSON.stringify({
    name: "fixture-records",
    enabled: true,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [${JSON.stringify(server)}],
      env: { FIXTURE_STATE_DIR: "private-state" },
      env_vars: [],
      cwd: null
    }
  }));
}
`);

    const resolveServer = createCodexMcpResolver({
      codexBin: codex,
      environment: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5_000
    });
    const resolved = await resolveServer("fixture-records");

    assert.deepEqual(await resolved.listTools(), {
      tools: [{
        name: "records.get",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false }
      }]
    });
    assert.deepEqual(await resolved.callTool({
      name: "records.get",
      arguments: { record_id: "fixture-42" }
    }), {
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        name: "records.get",
        arguments: { record_id: "fixture-42" },
        stateDirVisible: true
      }
    });
    const large = await resolved.callTool({
      name: "records.get",
      arguments: { record_id: "large" }
    });
    assert.equal(large.structuredContent.payload.length, 70 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex MCP resolver 对禁用、非 stdio 和非法服务器配置失败关闭", async () => {
  const configurations = [
    { name: "fixture", enabled: false, transport: { type: "stdio", command: "fixture", args: [], env: {}, env_vars: [], cwd: null } },
    { name: "fixture", enabled: true, transport: { type: "http", url: "https://example.invalid" } },
    { name: "other", enabled: true, transport: { type: "stdio", command: "fixture", args: [], env: {}, env_vars: [], cwd: null } },
    { name: "fixture", enabled: true, transport: { type: "stdio", command: "", args: [], env: {}, env_vars: [], cwd: null } }
  ];
  for (const configuration of configurations) {
    const resolved = await createCodexMcpResolver({
      codexBin: "codex",
      getServerConfig: async () => configuration
    })("fixture");
    assert.equal(resolved, undefined);
  }
});

test("Codex MCP resolver 超时后强制回收忽略 SIGTERM 的子进程", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-codex-mcp-timeout-"));
  const server = path.join(directory, "server.mjs");
  const pidFile = path.join(directory, "server.pid");
  try {
    writeFixture(server, String.raw`
import { writeFileSync } from "node:fs";
import process from "node:process";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
    const resolveServer = createCodexMcpResolver({
      timeoutMs: 500,
      getServerConfig: async () => ({
        name: "fixture-timeout",
        enabled: true,
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [server],
          env: {},
          env_vars: [],
          cwd: null
        }
      })
    });
    const resolved = await resolveServer("fixture-timeout");

    await assert.rejects(resolved.listTools(), /timed out/u);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === "ESRCH"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

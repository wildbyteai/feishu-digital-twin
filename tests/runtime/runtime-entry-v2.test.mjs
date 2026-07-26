import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const runtimeBin = path.join(
  projectRoot,
  "runtime/bin/feishu-digital-twin-runtime.mjs"
);
const fakeCodex = path.join(projectRoot, "tests/fixtures/bin/codex");
const fakeLark = path.join(projectRoot, "tests/fixtures/bin/lark-cli-read");
const RUNTIME_SETTLE_TIMEOUT_MS = 10_000;

function installLarkSkill(isolationRoot) {
  let directory = path.join(isolationRoot, "home");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const segment of [".agents", "skills", "lark-shared"]) {
    directory = path.join(directory, segment);
    mkdirSync(directory, { mode: 0o700 });
  }
  writeFileSync(path.join(directory, "SKILL.md"), [
    "---",
    "name: lark-shared",
    "description: synthetic fixture",
    "---",
    ""
  ].join("\n"));
}

function waitForReady(child, readStderr) {
  if (readStderr().includes('"type":"ready"')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(
      `runtime did not become ready: ${readStderr()}`
    )), RUNTIME_SETTLE_TIMEOUT_MS);
    function onData() {
      if (readStderr().includes('"type":"ready"')) finish();
    }
    function onClose(code, signal) {
      finish(new Error(`runtime exited before ready: code=${code} signal=${signal ?? "none"}`));
    }
    function finish(error) {
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    child.stderr.on("data", onData);
    child.once("close", onClose);
  });
}

function waitForCloseOrOutput(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("runtime command did not settle")),
      RUNTIME_SETTLE_TIMEOUT_MS
    );
    function onData(chunk) {
      finish(null, { type: "output", value: chunk.toString() });
    }
    function onClose(code, signal) {
      finish(null, { type: "close", code, signal });
    }
    function onErrorData(chunk) {
      finish(null, { type: "error", value: chunk.toString() });
    }
    function finish(error, result) {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve(result);
    }
    child.stdout.once("data", onData);
    child.stderr.once("data", onErrorData);
    child.once("close", onClose);
  });
}

function writeDecisionCodex(filename, command) {
  writeFileSync(filename, `#!/usr/bin/env node
import process from "node:process";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const eventId = [...prompt.matchAll(/"event_id"\\s*:\\s*"([^"]+)"/gu)].at(-1)?.[1];
const messageId = [...prompt.matchAll(/"message_id"\\s*:\\s*"([^"]+)"/gu)].at(-1)?.[1];
const hasFeedback = /"execution_feedback"\\s*:\\s*\\[\\s*\\{/u.test(prompt);
const decision = hasFeedback ? {
  event_id: eventId,
  outcome: "ignore",
  reason: "动作已完成",
  response: null,
  commands: [],
  source_refs: [messageId]
} : {
  event_id: eventId,
  outcome: "reply",
  reason: "验证可信资源保护",
  response: { mode: "representative", text: "测试完成。" },
  commands: [{
    argv: ${JSON.stringify(command)},
    reason: "验证可信资源保护",
    confirmation: "auto"
  }],
  source_refs: [messageId]
};
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: JSON.stringify(decision) }
}) + "\\n");
`, { mode: 0o700 });
}

function writeRecordingLark(filename, logPath) {
  writeFileSync(filename, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import process from "node:process";
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, data: {} }) + "\\n");
`, { mode: 0o700 });
}

function protectedEvent(index) {
  return {
    event_id: `evt_protected_${index}`,
    source: "event",
    chat_id: "oc_fixture_team",
    chat_type: "group",
    message_id: `om_protected_${index}`,
    sender_open_id: "ou_fixture_member",
    sent_at: "2026-07-24T09:00:00.000Z",
    update_time: "2026-07-24T09:00:00.000Z",
    message_type: "text",
    text: "验证可信运行时保护",
    thread_id: null,
    root_message_id: null,
    reply_to_message_id: null,
    signals: { direct_mention: true },
    context: []
  };
}

test("runtime state 只读查看不修改状态文件权限", {
  skip: process.platform === "win32"
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-runtime-state-readonly-"));
  chmodSync(directory, 0o700);
  const databasePath = path.join(directory, "state.sqlite");
  try {
    const frozen = spawnSync(process.execPath, [runtimeBin, "freeze", databasePath], {
      encoding: "utf8"
    });
    assert.equal(frozen.status, 0, frozen.stderr);
    chmodSync(databasePath, 0o400);

    const state = spawnSync(process.execPath, [runtimeBin, "state", databasePath], {
      encoding: "utf8"
    });

    assert.equal(state.status, 0, state.stderr);
    assert.equal(JSON.parse(state.stdout).frozen, true);
    assert.equal(statSync(databasePath).mode & 0o777, 0o400);
  } finally {
    chmodSync(databasePath, 0o600);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime 入口直接使用私有配置中的 Codex CLI 环境启动", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-runtime-entry-"));
  chmodSync(directory, 0o700);
  const configPath = path.join(directory, "config.json");
  const databasePath = path.join(directory, "state.sqlite");
  const isolationRoot = path.join(directory, "codex-runtime");
  mkdirSync(path.join(isolationRoot, "codex-home"), { recursive: true, mode: 0o700 });
  chmodSync(isolationRoot, 0o700);
  installLarkSkill(isolationRoot);
  writeFileSync(path.join(isolationRoot, "codex-home/config.toml"), [
    'model = "fixture-model"',
    'model_provider = "fixture-provider"',
    ""
  ].join("\n"), { mode: 0o600 });
  writeFileSync(configPath, `${JSON.stringify({
    schema_version: 2,
    instance_id: "fixture-instance",
    profile: "fixture-profile",
    message_scope: "bot_only",
    lark_cli_bin: fakeLark,
    codex_bin: fakeCodex,
    codex_environment_root: isolationRoot,
    codex_timeout_ms: 5000,
    max_ai_action_rounds: 3,
    production_data_approved: true,
    control: { mode: "local", enabled: false },
    principal: {
      name: "示例用户",
      open_id: "ou_fixture_principal",
      timezone: "Asia/Shanghai"
    },
    schedule: {
      workday_start_hour: 9,
      workday_end_hour: 18,
      work_interval_seconds: 30,
      quiet_interval_seconds: 300,
      daily_memory_hour: 0,
      daily_memory_minute: 10
    },
    allowed_lark_domains: ["im"]
  }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [runtimeBin, "serve", configPath, databasePath], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForReady(child, () => stderr);
    assert.match(stderr, /"type":"ready"/u);
    assert.doesNotMatch(stderr, /fixture-provider|fixture-model|twin-runtime-entry/u);
    child.stdin.end();
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime 入口允许引用主体身份，但保护日报文件夹和日报排除群", async () => {
  const cases = [
    {
      command: ["im", "+messages-send", "--user-id", "ou_fixture_principal", "--text", "测试"],
      blocked: false
    },
    {
      command: ["drive", "+delete", "--token", "fld_daily_memory", "--type", "folder"],
      blocked: true
    },
    {
      command: ["drive", "+search", "--query", "数字分身每日工作记忆"],
      blocked: true
    },
    {
      command: ["im", "+messages-search", "--chat-id", "oc_private_daily_memory"],
      blocked: true
    }
  ];

  for (const [index, { command, blocked }] of cases.entries()) {
    const directory = mkdtempSync(path.join(tmpdir(), "twin-runtime-protected-"));
    chmodSync(directory, 0o700);
    const configPath = path.join(directory, "config.json");
    const databasePath = path.join(directory, "state.sqlite");
    const isolationRoot = path.join(directory, "codex-runtime");
    const codexBin = path.join(directory, "codex-fixture.mjs");
    const larkBin = path.join(directory, "lark-fixture.mjs");
    const larkLog = path.join(directory, "lark.log");
    mkdirSync(path.join(isolationRoot, "codex-home"), { recursive: true, mode: 0o700 });
    chmodSync(isolationRoot, 0o700);
    installLarkSkill(isolationRoot);
    writeDecisionCodex(codexBin, command);
    writeRecordingLark(larkBin, larkLog);
    writeFileSync(larkLog, "", { mode: 0o600 });
    writeFileSync(configPath, `${JSON.stringify({
      schema_version: 2,
      instance_id: `fixture-protected-${index}`,
      profile: "fixture-profile",
      message_scope: "bot_only",
      lark_cli_bin: larkBin,
      codex_bin: codexBin,
      codex_environment_root: isolationRoot,
      codex_timeout_ms: 5000,
      max_ai_action_rounds: 3,
      production_data_approved: true,
      control: { mode: "local", enabled: true },
      principal: {
        name: "示例用户",
        open_id: "ou_fixture_principal",
        timezone: "Asia/Shanghai"
      },
      schedule: {
        workday_start_hour: 9,
        workday_end_hour: 18,
        work_interval_seconds: 30,
        quiet_interval_seconds: 300,
        daily_memory_hour: 0,
        daily_memory_minute: 10
      },
      daily_memory: {
        folder_token: "fld_daily_memory",
        folder_name: "数字分身每日工作记忆",
        excluded_chat_ids: ["oc_private_daily_memory"],
        excluded_topics: ["薪酬"]
      },
      allowed_lark_domains: ["im", "drive"]
    }, null, 2)}\n`, { mode: 0o600 });

    const child = spawn(process.execPath, [runtimeBin, "serve", configPath, databasePath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await waitForReady(child, () => stderr);
      child.stdin.write(`${JSON.stringify(protectedEvent(index))}\n`);
      const result = await waitForCloseOrOutput(child);
      assert.equal(result.type, blocked ? "error" : "output");
      child.stdin.end();
      const [code, signal] = await once(child, "close");
      assert.equal(code, blocked ? 1 : 0, stderr);
      assert.equal(signal, null);
      const larkCalls = readFileSync(larkLog, "utf8");
      if (blocked) assert.equal(larkCalls, "");
      else {
        assert.match(larkCalls, /ou_fixture_principal/u);
        assert.match(larkCalls, /--as","user/u);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) await once(child, "close");
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("runtime 入口把隐私配置的状态保留天数交给 RuntimeState", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-runtime-retention-"));
  chmodSync(directory, 0o700);
  const configPath = path.join(directory, "config.json");
  const databasePath = path.join(directory, "state.sqlite");
  const isolationRoot = path.join(directory, "codex-runtime");
  mkdirSync(path.join(isolationRoot, "codex-home"), { recursive: true, mode: 0o700 });
  chmodSync(isolationRoot, 0o700);
  installLarkSkill(isolationRoot);
  writeFileSync(configPath, `${JSON.stringify({
    schema_version: 2,
    instance_id: "fixture-retention",
    profile: "fixture-profile",
    message_scope: "bot_only",
    lark_cli_bin: fakeLark,
    codex_bin: fakeCodex,
    codex_environment_root: isolationRoot,
    codex_timeout_ms: 5000,
    max_ai_action_rounds: 3,
    production_data_approved: true,
    control: { mode: "local", enabled: false },
    principal: {
      name: "示例用户",
      open_id: "ou_fixture_principal",
      timezone: "Asia/Shanghai"
    },
    schedule: {
      workday_start_hour: 9,
      workday_end_hour: 18,
      work_interval_seconds: 30,
      quiet_interval_seconds: 300,
      daily_memory_hour: 0,
      daily_memory_minute: 10
    },
    privacy: { state_retention_days: 1 },
    allowed_lark_domains: ["im"]
  }, null, 2)}\n`, { mode: 0o600 });

  async function start() {
    const child = spawn(process.execPath, [runtimeBin, "serve", configPath, databasePath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitForReady(child, () => stderr);
    return { child, stderr: () => stderr };
  }

  let active;
  try {
    active = await start();
    active.child.stdin.end();
    assert.equal((await once(active.child, "close"))[0], 0, active.stderr());
    active = null;

    const database = new DatabaseSync(databasePath);
    const oldTimestamp = new Date(Date.now() - 2 * 86_400_000).toISOString();
    database.prepare(`
      INSERT INTO processed_events (
        event_id, status, claimed_at, claim_expires_at, completed_at
      ) VALUES (?, 'complete', ?, ?, ?)
    `).run("old-retained-event", oldTimestamp, oldTimestamp, oldTimestamp);
    database.close();

    active = await start();
    const output = once(active.child.stdout, "data");
    active.child.stdin.write(`${JSON.stringify(protectedEvent("retention"))}\n`);
    assert.equal(JSON.parse((await output)[0]).outcome, "ignore");
    active.child.stdin.end();
    assert.equal((await once(active.child, "close"))[0], 0, active.stderr());
    active = null;

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(verified.prepare(
      "SELECT COUNT(*) AS count FROM processed_events WHERE event_id = ?"
    ).get("old-retained-event").count, 0);
    verified.close();
  } finally {
    if (active?.child.exitCode === null && active.child.signalCode === null) {
      active.child.kill("SIGTERM");
      await once(active.child, "close");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

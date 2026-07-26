import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeJsonLine } from "../../intake/src/ndjson-output.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const intakeBin = path.join(projectRoot, "intake/bin/feishu-digital-twin-intake.mjs");
const fakeLarkCli = path.join(projectRoot, "tests/fixtures/bin/lark-cli-event");

function instanceConfig(overrides = {}) {
  return {
    schema_version: 2,
    profile: "example_profile",
    message_scope: "all_visible",
    lark_cli_bin: fakeLarkCli,
    codex_bin: "/opt/feishu-digital-twin/bin/codex",
    codex_environment_root: "/opt/feishu-digital-twin/codex-environment",
    production_data_approved: true,
    control: { mode: "local", enabled: false },
    principal: {
      name: "模拟负责人",
      open_id: "ou_principal",
      timezone: "Asia/Shanghai",
      address_names: ["模拟负责人"]
    },
    schedule: {
      workday_start_hour: 9,
      workday_end_hour: 18,
      work_interval_seconds: 30,
      quiet_interval_seconds: 300,
      daily_memory_hour: 0,
      daily_memory_minute: 10
    },
    allowed_lark_domains: ["im", "task"],
    ...overrides
  };
}

function capture(stream) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
  });
  return () => output;
}

function waitForOutput(child, readOutput, expected, timeout = 3_000, stream = child.stderr) {
  if (readOutput().includes(expected)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(
      `timed out waiting for ${JSON.stringify(expected)} in ${JSON.stringify(readOutput())}`
    )), timeout);
    const onData = () => {
      if (readOutput().includes(expected)) finish();
    };
    const onClose = (code, signal) => finish(new Error(
      `intake exited before ${JSON.stringify(expected)}: code=${code} signal=${signal ?? "none"}`
    ));
    function finish(error) {
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    stream.on("data", onData);
    child.once("close", onClose);
  });
}

async function startIntake(t, scenario = "idle", overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "twin-intake-test-"));
  const configPath = path.join(directory, "config.json");
  await writeFile(path.join(directory, "lark-event-scenario"), scenario);
  await writeFile(configPath, JSON.stringify(instanceConfig(overrides)), { mode: 0o600 });
  const child = spawn(process.execPath, [intakeBin, "event-run", configPath], {
    env: { ...process.env, TMPDIR: directory },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  t.after(async () => {
    child.stdout.resume();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    await rm(directory, { recursive: true, force: true });
  });
  return { child, stdout, stderr };
}

async function runSupplement(t, scenario, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "twin-supplement-test-"));
  const configPath = path.join(directory, "config.json");
  const databasePath = path.join(directory, "state.sqlite");
  await writeFile(path.join(directory, "lark-event-scenario"), scenario);
  await writeFile(configPath, JSON.stringify(instanceConfig(overrides)), { mode: 0o600 });
  const child = spawn(process.execPath, [
    intakeBin,
    "supplement-once",
    configPath,
    databasePath
  ], {
    env: { ...process.env, TMPDIR: directory },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    await rm(directory, { recursive: true, force: true });
  });
  const [code, signal] = await closed;
  return { code, signal, stdout: stdout(), stderr: stderr() };
}

test("官方事件源 ready 后 intake 才向 supervisor 宣告 ready", async (t) => {
  const { child, stderr } = await startIntake(t);

  await waitForOutput(child, stderr, "[intake] ready");

  assert.equal(stderr(), "[intake] ready\n");
});

test("官方事件源 stderr 中的正文、私链和凭据提示不会进入 intake 日志", async (t) => {
  const { child, stderr } = await startIntake(t, "sensitive-stderr");

  await waitForOutput(child, stderr, "[intake] ready");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(stderr(), "[intake] ready\n");
});

test("intake 收到进程信号时用 SIGTERM 关闭官方事件源并等待退出", async (t) => {
  const { child, stderr } = await startIntake(t, "slow-stop");
  await waitForOutput(child, stderr, "[intake] ready");
  const closed = once(child, "close");
  const startedAt = Date.now();

  child.kill("SIGINT");

  const [code, signal] = await closed;
  assert.ok(Date.now() - startedAt >= 100, "intake must wait for lark-cli shutdown");
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr(), "[intake] ready\n");
});

test("intake 处理事件异常时关闭官方事件源并等待退出", async (t) => {
  const { child, stderr } = await startIntake(t, "invalid-event");
  await waitForOutput(child, stderr, "[intake] ready");
  const closed = once(child, "close");

  const [code, signal] = await closed;
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(stderr(), /"type":"error"/u);
  assert.doesNotMatch(stderr(), /\[fixture\]|not-json/u);
});

test("bot_only 的官方实时入口不枚举用户聊天，仍保留外部群 Bot 事件", async (t) => {
  const { child, stdout, stderr } = await startIntake(t, "event-external", {
    message_scope: "bot_only"
  });
  await waitForOutput(child, stderr, "[intake] ready");
  await waitForOutput(child, stdout, '"message_id":"om_event-external"', 3_000, child.stdout);

  const event = JSON.parse(stdout().trim());
  assert.equal(event.source, "event");
  assert.equal(event.is_external, true);
});

test("internal_visible 不丢弃外部群中 Bot 已收到的官方实时事件", async (t) => {
  const external = await startIntake(t, "event-external", {
    message_scope: "internal_visible"
  });
  await waitForOutput(external.child, external.stderr, "[intake] ready");
  await waitForOutput(
    external.child,
    external.stdout,
    '"message_id":"om_event-external"',
    3_000,
    external.child.stdout
  );
  const event = JSON.parse(external.stdout().trim());
  assert.equal(event.source, "event");
  assert.equal(event.is_external, true);
});

test("all_visible 继续处理 Bot 已收到的官方实时事件", async (t) => {
  const { child, stdout, stderr } = await startIntake(t, "event-external", {
    message_scope: "all_visible"
  });
  await waitForOutput(child, stderr, "[intake] ready");
  await waitForOutput(child, stdout, '"message_id":"om_event-external"', 3_000, child.stdout);

  const event = JSON.parse(stdout().trim());
  assert.equal(event.source, "event");
  assert.equal(event.is_external, true);
});

test("Bot 群元数据读取失败时仍处理实时事件并保留未知属性", async (t) => {
  const { child, stdout, stderr } = await startIntake(t, "event-metadata-failure", {
    message_scope: "internal_visible"
  });
  await waitForOutput(child, stderr, "[intake] ready");
  await waitForOutput(
    child,
    stdout,
    '"message_id":"om_event-metadata-failure"',
    3_000,
    child.stdout
  );

  const event = JSON.parse(stdout().trim());
  assert.equal(event.source, "event");
  assert.equal(event.is_external, null);
  assert.equal(event.tenant_key, null);
});

test("stdout 出现背压时 intake 等待 drain 后才继续", async () => {
  const output = new PassThrough({ highWaterMark: 1 });
  output.pause();
  let completed = false;
  const writing = writeJsonLine(output, { event_id: "evt_backpressure" }).then(() => {
    completed = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);

  output.resume();
  await writing;
  assert.equal(completed, true);
});

test("等待 drain 时下游关闭或报错会立即失败", async () => {
  for (const failure of [null, new Error("downstream failed")]) {
    const output = new PassThrough({ highWaterMark: 1 });
    output.pause();
    const writing = writeJsonLine(output, { event_id: "evt_closed_output" });
    output.destroy(failure ?? undefined);

    let timer;
    const bounded = Promise.race([
      writing,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("writeJsonLine timed out")), 250);
      })
    ]).finally(() => clearTimeout(timer));
    await assert.rejects(
      bounded,
      failure ? /downstream failed/u : /output stream closed/u
    );
  }
});

test("用户补读跳过缺少有效寻址字段的非业务消息", async (t) => {
  const result = await runSupplement(t, "supplement-invalid-messages");

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const events = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(
    events.filter((event) => event.type !== "supplement_checkpoint")
      .map((event) => event.message_id),
    ["om_business"]
  );
});

test("用户补读在群消息之后输出由下游确认的 checkpoint marker", async (t) => {
  const result = await runSupplement(t, "supplement-invalid-messages");
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  const checkpoint = events.at(-1);
  const businessEvent = events.find((event) => event.message_id === "om_business");

  assert.equal(checkpoint.type, "supplement_checkpoint");
  assert.equal(checkpoint.chat_id, "oc_event_fixture");
  assert.equal(checkpoint.event_id, `checkpoint:oc_event_fixture:${checkpoint.last_read_at}`);
  assert.deepEqual(checkpoint.event_ids, [businessEvent.event_id]);
  assert.equal(Number.isNaN(Date.parse(checkpoint.last_read_at)), false);
});

test("用户补读在 AI 前跳过带可信标签的应用消息以阻止数字分身回流", async (t) => {
  const result = await runSupplement(t, "supplement-authority-loop");

  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  const messages = events.filter((event) => event.type !== "supplement_checkpoint");
  assert.deepEqual(
    messages.map((event) => event.message_id),
    [
      "om_human_labeled",
      "om_other_app_plain",
      "om_other_app_labeled",
      "om_twin_plain"
    ]
  );
  assert.deepEqual(events.at(-1).event_ids, messages.map((event) => event.event_id));
});

test("公共默认 bot_only 不启动主体用户补读", async (t) => {
  const result = await runSupplement(t, "supplement-invalid-messages", {
    message_scope: "bot_only"
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
});

test("internal_visible 跳过外部群但继续补读企业内部聊天", async (t) => {
  const result = await runSupplement(t, "supplement-mixed-chats", {
    message_scope: "internal_visible"
  });

  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(events.some((event) => event.chat_id === "oc_external_fixture"), false);
  assert.equal(events.some((event) => event.chat_id === "oc_unknown_fixture"), false);
  assert.equal(events.some((event) => event.chat_id === "oc_event_fixture"), true);
});

test("all_visible 在一次性明确选择后补读内部、外部和属性未知聊天", async (t) => {
  const result = await runSupplement(t, "supplement-mixed-chats", {
    message_scope: "all_visible"
  });

  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const chatId of ["oc_event_fixture", "oc_external_fixture", "oc_unknown_fixture"]) {
    assert.equal(events.some((event) => event.chat_id === chatId), true, chatId);
  }
  assert.equal(
    events.find((event) => event.chat_id === "oc_event_fixture" && event.message_id)?.is_external,
    false
  );
  assert.equal(
    events.find((event) => event.chat_id === "oc_external_fixture" && event.message_id)?.is_external,
    true
  );
  assert.equal(
    events.find((event) => event.chat_id === "oc_unknown_fixture" && event.message_id)?.is_external,
    null
  );
});

test("intake 入口拒绝统一实例配置未允许的字段", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "twin-intake-config-test-"));
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(instanceConfig({
    provider_endpoint: "https://provider.example.invalid"
  })), { mode: 0o600 });
  const child = spawn(process.execPath, [intakeBin, "event-run", configPath], {
    env: { ...process.env, TMPDIR: directory },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderr = capture(child.stderr);
  const [code, signal] = await once(child, "close");

  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(stderr(), /"component":"intake"/u);
  assert.doesNotMatch(stderr(), /provider\.example/u);
  await rm(directory, { recursive: true, force: true });
});

test("公开 intake 入口拒绝缺失 message_scope 的配置", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "twin-intake-scope-test-"));
  const configPath = path.join(directory, "config.json");
  const source = instanceConfig();
  delete source.message_scope;
  await writeFile(configPath, JSON.stringify(source), { mode: 0o600 });
  const child = spawn(process.execPath, [intakeBin, "event-run", configPath], {
    env: { ...process.env, TMPDIR: directory },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderr = capture(child.stderr);
  const [code, signal] = await once(child, "close");

  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(stderr(), /"component":"intake"/u);
  await rm(directory, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  resolveLogPolicy,
  writeServiceSignalLog
} from "../../ops/service-result-log.mjs";
import { writeLauncher } from "../../product/src/installation.mjs";
import {
  installServices,
  serviceStatus,
  startServices
} from "../../product/src/service-host.mjs";

const loggerPath = path.resolve("ops/service-result-log.mjs");

function runLogger(
  logPath,
  maxBytes,
  results,
  maxAgeSeconds,
  mode,
  component
) {
  return new Promise((resolve, reject) => {
    const args = [loggerPath, logPath, String(maxBytes)];
    if (maxAgeSeconds !== undefined) args.push(String(maxAgeSeconds));
    if (mode !== undefined) args.push(mode);
    if (component !== undefined) args.push(component);
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(results.map((result) => `${JSON.stringify(result)}\n`).join(""));
  });
}

function initializedRoot(instance) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "twin-service-root-")), "install");
  const result = spawnSync(process.execPath, [
    path.resolve("bin/feishu-digital-twin.mjs"),
    "--root",
    root,
    "init",
    "--instance",
    instance
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

function convergingLaunchctl(directory, { failRealtime = false } = {}) {
  const filename = path.join(directory, "launchctl");
  const stateDirectory = path.join(directory, "state");
  const log = path.join(directory, "launchctl.log");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(filename, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const stateDirectory = ${JSON.stringify(stateDirectory)};`,
    `const log = ${JSON.stringify(log)};`,
    `const failRealtime = ${JSON.stringify(failRealtime)};`,
    'const [command, first = "", second = ""] = process.argv.slice(2);',
    'fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");',
    'const target = command === "bootstrap" ? second : first;',
    'const label = path.basename(target, command === "bootstrap" ? ".plist" : undefined);',
    'const state = path.join(stateDirectory, label + ".json");',
    'if (command === "bootstrap") {',
    '  fs.writeFileSync(state, JSON.stringify({ checks: 0 }));',
    '} else if (command === "bootout") {',
    '  fs.rmSync(state, { force: true });',
    '} else if (command === "print") {',
    '  if (!fs.existsSync(state)) process.exit(113);',
    '  const value = JSON.parse(fs.readFileSync(state, "utf8"));',
    '  value.checks += 1;',
    '  fs.writeFileSync(state, JSON.stringify(value));',
    '  if (label.endsWith(".realtime")) {',
    '    if (failRealtime) process.stdout.write("state = exited\\nlast exit code = 1\\n");',
    '    else if (value.checks === 1) process.stdout.write("state = starting\\nlast exit code = 0\\n");',
    '    else process.stdout.write("state = running\\npid = 123\\nlast exit code = 0\\n");',
    '  } else {',
    '    process.stdout.write("state = exited\\nlast exit code = 9\\n");',
    '  }',
    '}',
    ""
  ].join("\n"), { mode: 0o700 });
  return { filename, log, stateDirectory };
}

test("后台错误信号只保存固定脱敏状态，不保存 stderr 原文", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-signal-log-"));
  const logPath = path.join(directory, "realtime.stderr.log");
  const result = await runLogger(logPath, 1024, [
    "含业务正文的非结构化错误",
    { type: "ready", message: "不应保留的启动原文" },
    { type: "error", code: "PRIVATE_VALUE", message: "私聊正文和私有端点" }
  ], 7 * 86400, "signal", "realtime");

  assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(({ type }) => type), ["ready", "error"]);
  assert.equal(lines.every(({ component }) => component === "realtime"), true);
  assert.equal(lines.every(({ logged_at }) => Number.isFinite(Date.parse(logged_at))), true);
  assert.doesNotMatch(content, /业务正文|启动原文|私聊正文|私有端点|PRIVATE_VALUE/u);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("长驻服务即使没有新 stderr 也会按墙钟清理超期信号", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-signal-age-"));
  const logPath = path.join(directory, "realtime.stderr.log");
  const base = Date.parse("2026-07-24T08:00:00.000Z");
  writeFileSync(logPath, `${JSON.stringify({
    logged_at: new Date(base - 500).toISOString(),
    component: "realtime",
    type: "ready"
  })}\n`, { mode: 0o600 });
  let reads = 0;
  const input = new PassThrough();
  const logging = writeServiceSignalLog({
    input,
    logPath,
    component: "realtime",
    maxAgeSeconds: 1,
    maintenanceIntervalMs: 10,
    clock: () => (reads++ === 0 ? base : base + 2000)
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  input.end();
  await logging;

  assert.equal(readFileSync(logPath, "utf8"), "");
});

test("结果和信号日志都执行上游传入的更严格限额与保留期", async () => {
  const now = Date.now();
  for (const fixture of [{
    mode: "result",
    component: undefined,
    input: { outcome: "reply", executions: [], confirmations: [] },
    existing: (index, loggedAt) => ({
      trace_id: `trace_${String(index).padStart(32, "0")}`,
      logged_at: loggedAt,
      outcome: "reply",
      executions: [],
      confirmations: []
    })
  }, {
    mode: "signal",
    component: "realtime",
    input: { type: "ready", message: "不得落盘的业务正文" },
    existing: (_index, loggedAt) => ({
      logged_at: loggedAt,
      component: "realtime",
      type: "ready"
    })
  }]) {
    const directory = mkdtempSync(path.join(tmpdir(), `twin-${fixture.mode}-policy-`));
    const logPath = path.join(directory, `${fixture.mode}.log`);
    const recent = new Date(now - 1000).toISOString();
    const old = new Date(now - 2 * 86400000).toISOString();
    writeFileSync(logPath, [
      JSON.stringify(fixture.existing(0, old)),
      ...Array.from({ length: 12 }, (_, index) => (
        JSON.stringify(fixture.existing(index + 1, recent))
      )),
      ""
    ].join("\n"), { mode: 0o600 });

    const result = await runLogger(
      logPath,
      512,
      [fixture.input],
      86400,
      fixture.mode,
      fixture.component
    );

    assert.equal(result.code, 0, result.stderr);
    const content = readFileSync(logPath, "utf8");
    assert.ok(statSync(logPath).size <= 512, fixture.mode);
    assert.equal(content.includes(old), false, fixture.mode);
    assert.doesNotMatch(content, /不得落盘的业务正文/u);
  }
});

test("日志维护会重新投影近期旧 JSON 并清除历史正文、ID 和多余字段", async () => {
  const loggedAt = new Date(Date.now() - 1000).toISOString();
  const fixtures = [{
    mode: "result",
    component: undefined,
    existing: {
      trace_id: `trace_${"a".repeat(32)}`,
      logged_at: loggedAt,
      outcome: "control",
      executions: [{
        status: "failed",
        error_type: "timeout",
        command_hash: "private-command-id",
        execution_hash: "c".repeat(64)
      }],
      confirmations: [{ status: "pending", nonce: "private-confirmation-id" }],
      event_id: "private-event-id",
      response: { text: "历史聊天正文" },
      arbitrary: "private-extra-value"
    },
    expected: {
      trace_id: `trace_${"a".repeat(32)}`,
      logged_at: loggedAt,
      outcome: "control",
      executions: [{
        status: "failed",
        error_type: "timeout"
      }],
      confirmations: [{ status: "pending" }]
    }
  }, {
    mode: "signal",
    component: "realtime",
    existing: {
      logged_at: loggedAt,
      component: "realtime",
      type: "error",
      event_id: "private-signal-id",
      code: "PRIVATE_CODE",
      message: "历史错误正文",
      arbitrary: "private-extra-value"
    },
    expected: {
      logged_at: loggedAt,
      component: "realtime",
      type: "error"
    }
  }];

  for (const fixture of fixtures) {
    const directory = mkdtempSync(path.join(tmpdir(), `twin-${fixture.mode}-reproject-`));
    const logPath = path.join(directory, `${fixture.mode}.log`);
    writeFileSync(logPath, `${JSON.stringify(fixture.existing)}\n`, { mode: 0o600 });

    const result = await runLogger(
      logPath,
      4096,
      [],
      7 * 86400,
      fixture.mode,
      fixture.component
    );

    assert.equal(result.code, 0, result.stderr);
    const content = readFileSync(logPath, "utf8");
    assert.deepEqual(JSON.parse(content), fixture.expected);
    assert.doesNotMatch(
      content,
      /历史聊天正文|历史错误正文|private-event-id|private-signal-id|private-command-id|private-confirmation-id|PRIVATE_CODE|private-extra-value/u
    );
  }
});

test("日志参数严格校验、不能扩大硬上限且不会回显原值", async () => {
  assert.throws(() => resolveLogPolicy({
    mode: "result",
    maxBytes: 50 * 1024 * 1024,
    maxAgeSeconds: 7 * 86400
  }), /privacy maximum/u);
  assert.throws(() => resolveLogPolicy({
    mode: "signal",
    maxBytes: 10 * 1024 * 1024,
    maxAgeSeconds: 7 * 86400
  }), /privacy maximum/u);

  for (const value of ["private-value", String(10 * 1024 * 1024 + 1), "1e6"]) {
    const directory = mkdtempSync(path.join(tmpdir(), "twin-invalid-log-policy-"));
    const logPath = path.join(directory, "result.log");
    const result = await runLogger(
      logPath,
      value,
      [{ outcome: "reply", executions: [], confirmations: [] }],
      7 * 86400,
      "result",
      undefined
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /service result log failed/u);
    assert.equal(result.stderr.includes(value), false);
  }
});

test("版本 launcher 同时等待业务进程和脱敏 logger，保留业务退出码且不会漏掉短进程退出", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "twin-launcher-pipe-"));
  const versionRoot = path.join(root, "versions/1.0.0");
  for (const directory of [
    path.join(versionRoot, "bin"),
    path.join(versionRoot, "ops"),
    path.join(versionRoot, "runtime/src"),
    path.join(versionRoot, "shared"),
    path.join(root, "private/logs")
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(root, "installation.json"), JSON.stringify({
    active_version: "1.0.0",
    config_path: "private/config.json"
  }), { mode: 0o600 });
  writeFileSync(path.join(root, "private/config.json"), JSON.stringify({
    schema_version: 1,
    profile: "example_profile",
    lark_cli_bin: "/opt/feishu-digital-twin/bin/lark-cli",
    codex_bin: "/opt/feishu-digital-twin/bin/codex",
    codex_environment_root: "/opt/feishu-digital-twin/codex-environment",
    production_data_approved: true,
    production_enabled: false,
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
    allowed_lark_domains: ["im"],
    privacy: {
      result_log_retention_days: 2,
      result_log_max_bytes: 65536,
      signal_log_retention_days: 1,
      signal_log_max_bytes: 65536
    }
  }), { mode: 0o600 });
  writeFileSync(path.join(versionRoot, "bin/feishu-digital-twin.mjs"), [
    "#!/usr/bin/env node",
    'process.stderr.write(JSON.stringify({ type: "ready", message: "private ready" }) + "\\n");',
    'process.stderr.write(JSON.stringify({ type: "error", message: "private body" }) + "\\n");',
    "process.exitCode = 7;",
    ""
  ].join("\n"), { mode: 0o700 });
  cpSync(path.resolve("ops/service-result-log.mjs"), path.join(versionRoot, "ops/service-result-log.mjs"));
  cpSync(path.resolve("runtime/src/result-summary.mjs"), path.join(versionRoot, "runtime/src/result-summary.mjs"));
  cpSync(path.resolve("runtime/src/decision-diagnostics.mjs"), path.join(
    versionRoot,
    "runtime/src/decision-diagnostics.mjs"
  ));
  cpSync(path.resolve("shared/daily-memory-trigger.mjs"), path.join(
    versionRoot,
    "shared/daily-memory-trigger.mjs"
  ));
  writeFileSync(path.join(root, "private/logs/realtime.stderr.log"), `${JSON.stringify({
    logged_at: "2026-07-20T00:00:00.000Z",
    component: "realtime",
    type: "ready"
  })}\n`, { mode: 0o600 });
  await writeLauncher(root);

  const result = spawnSync(process.execPath, [
    path.join(root, "launcher.mjs"),
    "service",
    "run",
    "realtime"
  ], { encoding: "utf8", timeout: 5000 });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 7);
  const content = readFileSync(path.join(root, "private/logs/realtime.stderr.log"), "utf8");
  assert.deepEqual(
    content.trim().split("\n").map(JSON.parse).map(({ type }) => type),
    ["ready", "error"]
  );
  assert.equal(content.includes("2026-07-20T00:00:00.000Z"), false);
  assert.doesNotMatch(content, /private ready|private body/u);

  writeFileSync(path.join(versionRoot, "bin/feishu-digital-twin.mjs"), [
    "#!/usr/bin/env node",
    'setInterval(() => process.stderr.write("untrusted stderr\\n"), 10);',
    ""
  ].join("\n"), { mode: 0o700 });
  writeFileSync(path.join(versionRoot, "ops/service-result-log.mjs"), [
    "#!/usr/bin/env node",
    "process.exitCode = 9;",
    ""
  ].join("\n"), { mode: 0o700 });
  const failedLogger = spawnSync(process.execPath, [
    path.join(root, "launcher.mjs"),
    "service",
    "run",
    "realtime"
  ], { encoding: "utf8", timeout: 5000 });
  assert.equal(failedLogger.error, undefined);
  assert.equal(failedLogger.status, 1);
});

test("首次服务启动等待 realtime 状态收敛，定时角色只要求调度已加载，失败则回退本次启动", async () => {
  const root = initializedRoot("health-readback");
  const launchAgentsDirectory = path.join(root, "launch-agents");
  await installServices(root, { launchAgentsDirectory, start: false });
  const fake = convergingLaunchctl(mkdtempSync(path.join(tmpdir(), "twin-launchctl-health-")));

  await startServices(root, {
    launchAgentsDirectory,
    launchctlBin: fake.filename,
    healthTimeoutMs: 3000,
    healthPollIntervalMs: 10
  });
  const healthy = await serviceStatus(root, {
    launchAgentsDirectory,
    launchctlBin: fake.filename
  });
  assert.equal(healthy.services.realtime.running, true);
  assert.equal(healthy.services.realtime.pid_present, true);
  assert.equal(healthy.services.supplement.loaded, true);
  assert.equal(healthy.services.supplement.last_exit_ok, false);
  assert.equal(healthy.services.daily_memory.loaded, true);
  assert.equal(healthy.services.daily_memory.last_exit_ok, false);
  const commands = readFileSync(fake.log, "utf8").trim().split("\n");
  assert.equal(commands.filter((line) => (
    line.startsWith("print ") && line.endsWith(".realtime")
  )).length >= 2, true);

  const failedRoot = initializedRoot("health-rollback");
  const failedLaunchAgents = path.join(failedRoot, "launch-agents");
  await installServices(failedRoot, { launchAgentsDirectory: failedLaunchAgents, start: false });
  const failed = convergingLaunchctl(
    mkdtempSync(path.join(tmpdir(), "twin-launchctl-failed-")),
    { failRealtime: true }
  );
  await assert.rejects(() => startServices(failedRoot, {
    launchAgentsDirectory: failedLaunchAgents,
    launchctlBin: failed.filename,
    healthTimeoutMs: 300,
    healthPollIntervalMs: 10
  }), (error) => error?.code === "SERVICE_START_FAILED");
  assert.match(readFileSync(failed.log, "utf8"), /bootout .*\.realtime/u);
});

test("补读结果日志忽略正常噪声并只保存有意义的脱敏摘要", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-result-log-"));
  const logPath = path.join(directory, "supplement.stdout.log");
  const commandHash = "a".repeat(64);
  const executionHash = `execution_${"b".repeat(64)}`;
  const result = await runLogger(logPath, 10 * 1024 * 1024, [
    { event_id: "checkpoint:1", outcome: "checkpoint" },
    { event_id: "checkpoint:2", outcome: "checkpoint-deferred" },
    { event_id: "message:1", outcome: "ignore" },
    {
      event_id: "message:2",
      outcome: "reply",
      response: { text: "不应进入日志的聊天正文" },
      executions: [],
      confirmations: []
    },
    {
      event_id: "message:3",
      outcome: "control",
      response: { text: "仍然不能进入日志" },
      executions: [{ status: "failed", command_hash: commandHash, execution_hash: executionHash }],
      confirmations: []
    }
  ]);

  assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(({ outcome }) => outcome), ["reply", "control"]);
  assert.equal(lines.every(({ trace_id }) => /^trace_[a-f0-9]{32}$/u.test(trace_id)), true);
  assert.equal(readFileSync(logPath, "utf8").includes("message:2"), false);
  assert.equal(readFileSync(logPath, "utf8").includes("message:3"), false);
  assert.deepEqual(lines[1].executions, [{ status: "failed", execution_hash: executionHash }]);
  assert.equal(readFileSync(logPath, "utf8").includes(commandHash), false);
  assert.equal(readFileSync(logPath, "utf8").includes(executionHash), true);
  assert.equal(readFileSync(logPath, "utf8").includes("聊天正文"), false);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("正式结果 logger 保留合法每日记忆目标日期并丢弃无效值", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-daily-target-log-"));
  const logPath = path.join(directory, "daily-memory.stdout.log");
  const result = await runLogger(logPath, 10 * 1024 * 1024, [{
    outcome: "reply",
    target_date: "2026-07-27",
    response: { text: "不得落盘的每日记忆正文" },
    executions: [],
    confirmations: []
  }, {
    outcome: "reply",
    target_date: "2026-02-30",
    private_url: "https://private.example.invalid/daily-memory",
    executions: [],
    confirmations: []
  }]);

  assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].target_date, "2026-07-27");
  assert.equal(Object.hasOwn(lines[1], "target_date"), false);
  assert.doesNotMatch(content, /每日记忆正文|private\.example/u);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("正式结果 logger 保留带合法目标日期的静默日报幂等结果", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-daily-idempotent-log-"));
  const logPath = path.join(directory, "daily-memory.stdout.log");
  const result = await runLogger(logPath, 10 * 1024 * 1024, [{
    outcome: "ignore",
    target_date: "2026-07-27",
    reason: "不得落盘的幂等检查正文",
    executions: [],
    confirmations: []
  }, {
    outcome: "ignore",
    target_date: "2026-02-30",
    executions: [],
    confirmations: []
  }, {
    outcome: "ignore",
    executions: [],
    confirmations: []
  }, {
    outcome: "checkpoint",
    executions: [],
    confirmations: []
  }]);

  assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, "ignore");
  assert.equal(lines[0].target_date, "2026-07-27");
  assert.doesNotMatch(content, /幂等检查正文/u);
});

test("补读结果日志超过上限时清空旧代际再继续写入", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-result-cap-"));
  const logPath = path.join(directory, "supplement.stdout.log");
  writeFileSync(logPath, "x".repeat(256), { mode: 0o600 });

  const result = await runLogger(logPath, 180, [{
    event_id: "message:new",
    outcome: "control",
    executions: [],
    confirmations: []
  }]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.ok(statSync(logPath).size <= 180);
  assert.equal(readFileSync(logPath, "utf8").includes("x".repeat(20)), false);
  assert.match(JSON.parse(readFileSync(logPath, "utf8")).trace_id, /^trace_[a-f0-9]{32}$/u);
  assert.equal(readFileSync(logPath, "utf8").includes("message:new"), false);
});

test("结果日志按时间清理超期和旧格式记录", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-result-age-"));
  const logPath = path.join(directory, "supplement.stdout.log");
  const now = Date.now();
  writeFileSync(logPath, [
    JSON.stringify({ trace_id: "trace_old", logged_at: new Date(now - 8 * 86400000).toISOString(), outcome: "reply" }),
    JSON.stringify({ trace_id: "trace_recent", logged_at: new Date(now - 86400000).toISOString(), outcome: "reply" }),
    JSON.stringify({ trace_id: "trace_legacy", outcome: "reply" }),
    ""
  ].join("\n"), { mode: 0o600 });

  const result = await runLogger(logPath, 10 * 1024 * 1024, [{
    event_id: "message:new",
    outcome: "control",
    executions: [],
    confirmations: []
  }], 7 * 86400);

  assert.equal(result.code, 0);
  const content = readFileSync(logPath, "utf8");
  assert.equal(content.includes("trace_old"), false);
  assert.equal(content.includes("trace_legacy"), false);
  assert.equal(content.includes("trace_recent"), true);
  const lines = content.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines.every((line) => Number.isFinite(Date.parse(line.logged_at))), true);
});

test("补读后台任务把运行结果交给十兆受控日志而不是由 launchd 直接追加", () => {
  const template = readFileSync(
    path.resolve("deploy/launchd/supplement.plist.template"),
    "utf8"
  );
  const serviceHost = readFileSync(
    path.resolve("product/src/service-host.mjs"),
    "utf8"
  );
  const installation = readFileSync(
    path.resolve("product/src/installation.mjs"),
    "utf8"
  );
  assert.equal(template.includes("launcher.mjs"), true);
  assert.equal(serviceHost.includes("ops/service-result-log.mjs"), true);
  assert.equal(serviceHost.includes('"10485760"'), true);
  assert.equal(serviceHost.includes('"supplement.stdout.log"'), true);
  assert.match(template, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/u);
  for (const filename of [
    "deploy/launchd/realtime.plist.template",
    "deploy/launchd/supplement.plist.template",
    "deploy/launchd/daily-memory.plist.template"
  ]) {
    const content = readFileSync(path.resolve(filename), "utf8");
    assert.match(content, /<key>StandardErrorPath<\/key>\s*<string>\/dev\/null<\/string>/u);
    assert.doesNotMatch(content, /__.*SIGNAL_LOG__/u);
  }
  assert.equal(installation.includes('"1048576"'), true);
  assert.equal(installation.includes('"604800"'), true);
  assert.equal(installation.includes('"signal"'), true);
  assert.equal(installation.includes(".stderr.log"), true);
});

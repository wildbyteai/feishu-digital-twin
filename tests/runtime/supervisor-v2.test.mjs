import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";

import { runSupervisor } from "../../bin/supervisor-core.mjs";

function childScript(directory, name, source) {
  const script = path.join(directory, name);
  writeFileSync(script, source, { mode: 0o700 });
  return [process.execPath, script];
}

function capture() {
  const stream = new PassThrough();
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { text += chunk; });
  return { stream, text: () => text };
}

function fallbackAfter(milliseconds, value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), milliseconds).unref();
  });
}

test("公开 supervisor 固定使用公开运行入口，旧实例保留独立私有包装", () => {
  const publicSource = readFileSync(
    path.resolve("bin/feishu-digital-twin-supervisor.mjs"),
    "utf8"
  );
  assert.match(publicSource, /runtime\/bin\/feishu-digital-twin-runtime\.mjs/u);
  assert.doesNotMatch(publicSource, /runtime\/bin\/twin-runtime\.mjs/u);
  const legacyWrapper = path.resolve("bin/twin-supervisor.mjs");
  const legacyRuntime = path.resolve("runtime/bin/twin-runtime.mjs");
  assert.equal(existsSync(legacyWrapper), existsSync(legacyRuntime));
  if (existsSync(legacyWrapper)) {
    const legacySource = readFileSync(legacyWrapper, "utf8");
    assert.match(legacySource, /runtime\/bin\/twin-runtime\.mjs/u);
  }
});

test("官方事件 ready 后把 intake NDJSON 接入已就绪的 runtime", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-"));
  const intakeCommand = childScript(directory, "intake.mjs", `
    process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
    setTimeout(() => {
      process.stderr.write("[intake] ready\\n");
      process.stdout.write('{"event_id":"evt_pipeline"}\\n');
    }, 50);
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const runtimeCommand = childScript(directory, "runtime.mjs", `
    process.stderr.write('{"type":"ready","frozen":true}\\n');
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      process.stdout.write("runtime-received:" + chunk);
      setTimeout(() => process.exit(0), 20);
    });
  `);
  const stdout = capture();
  const stderr = capture();
  const startedAt = Date.now();
  let readyAt;
  stderr.stream.on("data", (chunk) => {
    if (chunk.includes('"component":"supervisor"')) readyAt ??= Date.now();
  });

  const code = await runSupervisor({
    intakeCommand,
    runtimeCommand,
    startupTimeoutMs: 1000,
    signalSource: new EventEmitter(),
    stdout: stdout.stream,
    stderr: stderr.stream
  });

  assert.equal(code, 0);
  assert.match(stdout.text(), /runtime-received:\{"event_id":"evt_pipeline"\}/u);
  assert.match(stderr.text(), /\{"type":"ready","component":"supervisor"\}/u);
  assert.ok(readyAt - startedAt >= 35, "supervisor must wait for [intake] ready");
  assert.doesNotMatch(stderr.text(), /\[event\]|\[intake\]/u);
});

test("任一组件未在期限内 ready 时终止两端并失败", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-timeout-"));
  const intakeCommand = childScript(directory, "intake.mjs", `
    process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
    process.stderr.write("[intake] ready\\n");
    process.on("SIGTERM", () => {
      process.stderr.write("intake-terminated\\n");
      setTimeout(() => process.exit(0), 40);
    });
    setTimeout(() => process.exit(0), 800);
  `);
  const runtimeCommand = childScript(directory, "runtime.mjs", `
    process.stderr.write('{"type":"starting"}\\n');
    process.on("SIGTERM", () => {
      process.stderr.write("runtime-terminated\\n");
      setTimeout(() => process.exit(0), 70);
    });
    setTimeout(() => process.exit(0), 800);
  `);
  const stderr = capture();
  const startedAt = Date.now();

  const code = await Promise.race([
    runSupervisor({
      intakeCommand,
      runtimeCommand,
      startupTimeoutMs: 100,
      signalSource: new EventEmitter(),
      stdout: capture().stream,
      stderr: stderr.stream
    }),
    fallbackAfter(600, 99)
  ]);

  assert.equal(code, 1);
  assert.match(stderr.text(), /startup timed out after 100ms/u);
  assert.ok(Date.now() - startedAt >= 150, "supervisor must wait for both children");
});

test("任一端退出后 SIGTERM 另一端并传播任一明确非零状态", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-exit-"));
  const intakeCommand = childScript(directory, "intake.mjs", `
    process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
    process.stderr.write("[intake] ready\\n");
    setTimeout(() => process.exit(0), 80);
  `);
  const runtimeCommand = childScript(directory, "runtime.mjs", `
    process.stderr.write('{"type":"ready","frozen":true}\\n');
    process.on("SIGTERM", () => {
      process.stderr.write("runtime-received-sigterm\\n");
      process.exit(9);
    });
    setInterval(() => {}, 1000);
  `);
  const stderr = capture();

  const code = await runSupervisor({
    intakeCommand,
    runtimeCommand,
    startupTimeoutMs: 1000,
    signalSource: new EventEmitter(),
    stdout: capture().stream,
    stderr: stderr.stream
  });

  assert.equal(code, 9);
});

test("runtime 先退出时断管错误不会让 supervisor 自身崩溃", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-epipe-"));
  const intakeCommand = childScript(directory, "intake.mjs", `
    process.stderr.write("[intake] ready\\n");
    const chunk = '{"event_id":"evt_stream"}\\n'.repeat(4096);
    const write = () => {
      if (process.stdout.write(chunk)) setImmediate(write);
      else process.stdout.once("drain", write);
    };
    process.on("SIGTERM", () => {
      process.stderr.write("intake-stopped-after-runtime-exit\\n");
      process.exit(0);
    });
    write();
  `);
  const runtimeCommand = childScript(directory, "runtime.mjs", `
    process.stderr.write('{"type":"ready","frozen":true}\\n');
    setTimeout(() => process.exit(7), 40);
    process.stdin.resume();
  `);
  const stderr = capture();

  const code = await runSupervisor({
    intakeCommand,
    runtimeCommand,
    startupTimeoutMs: 1000,
    signalSource: new EventEmitter(),
    stdout: capture().stream,
    stderr: stderr.stream
  });

  assert.equal(code, 7);
});

test("子进程被信号终止时传播非零信号状态", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-child-signal-"));
  const intakeCommand = childScript(directory, "intake.mjs", `
    process.stderr.write("[intake] ready\\n");
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
  `);
  const runtimeCommand = childScript(directory, "runtime.mjs", `
    process.stderr.write('{"type":"ready","frozen":true}\\n');
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `);

  const code = await runSupervisor({
    intakeCommand,
    runtimeCommand,
    startupTimeoutMs: 1000,
    signalSource: new EventEmitter(),
    stdout: capture().stream,
    stderr: capture().stream
  });

  assert.equal(code, 143);
});

for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`收到 ${signal} 后 SIGTERM 两端、等待退出并返回信号状态`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-signal-"));
    const intakeCommand = childScript(directory, "intake.mjs", `
      process.on("SIGTERM", () => {
        process.stderr.write("intake-graceful-stop\\n");
        setTimeout(() => process.exit(0), 40);
      });
      process.stderr.write("[event] ready event_key=im.message.receive_v1\\n");
      process.stderr.write("[intake] ready\\n");
      setTimeout(() => process.exit(0), 500);
    `);
    const runtimeCommand = childScript(directory, "runtime.mjs", `
      process.on("SIGTERM", () => {
        process.stderr.write("runtime-graceful-stop\\n");
        setTimeout(() => process.exit(0), 70);
      });
      process.stderr.write('{"type":"ready","frozen":true}\\n');
      setTimeout(() => process.exit(0), 500);
    `);
    const signals = new EventEmitter();
    const stderr = capture();
    const ready = new Promise((resolve) => {
      stderr.stream.on("data", (chunk) => {
        if (chunk.includes('"component":"supervisor"')) resolve();
      });
    });

    const running = runSupervisor({
      intakeCommand,
      runtimeCommand,
      startupTimeoutMs: 1000,
      signalSource: signals,
      stdout: capture().stream,
      stderr: stderr.stream
    });
    await ready;
    const signaledAt = Date.now();
    signals.emit(signal);
    const code = await running;

    assert.equal(code, expectedCode);
    assert.ok(Date.now() - signaledAt >= 50, "supervisor must await graceful child exit");
  });
}

test("子进程启动失败时收束已启动的另一端", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-spawn-"));
  const intakeCommand = childScript(directory, "intake.mjs", `
    process.on("SIGTERM", () => {
      process.stderr.write("intake-stopped-after-spawn-error\\n");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 500);
  `);
  const stderr = capture();

  const code = await runSupervisor({
    intakeCommand,
    runtimeCommand: [path.join(directory, "missing-runtime")],
    startupTimeoutMs: 1000,
    signalSource: new EventEmitter(),
    stdout: capture().stream,
    stderr: stderr.stream
  });

  assert.equal(code, 1);
  assert.match(stderr.text(), /"component":"runtime","message":"failed to start"/u);
});

test("不把子进程 stderr 中的正文、私链或端点写入 supervisor 日志", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-supervisor-redaction-"));
  const intakeCommand = childScript(directory, "intake.mjs", `
    process.stderr.write("[intake] ready\\n");
    process.stderr.write("private message body and console_url\\n");
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const runtimeCommand = childScript(directory, "runtime.mjs", `
    process.stderr.write('{"type":"ready","frozen":true}\\n');
    process.stderr.write("https://private-provider.invalid/v1\\n");
    setTimeout(() => process.exit(0), 50);
  `);
  const stderr = capture();

  const code = await runSupervisor({
    intakeCommand,
    runtimeCommand,
    startupTimeoutMs: 1000,
    signalSource: new EventEmitter(),
    stdout: capture().stream,
    stderr: stderr.stream
  });

  assert.equal(code, 0);
  assert.doesNotMatch(stderr.text(), /private message body|console_url|private-provider/u);
});

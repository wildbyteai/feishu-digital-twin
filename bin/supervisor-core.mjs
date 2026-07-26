import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import process from "node:process";
import readline from "node:readline";

function waitForLine(stream, predicate) {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  return new Promise((resolve) => {
    lines.on("line", (line) => {
      if (predicate(line)) resolve();
    });
  });
}

function waitForExit(child, component) {
  return new Promise((resolve) => {
    let error;
    child.once("error", (cause) => { error = cause; });
    child.once("close", (code, signal) => resolve({ component, code, signal, error }));
  });
}

function runtimeIsReady(line) {
  try {
    return JSON.parse(line).type === "ready";
  } catch {
    return false;
  }
}

function terminate(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

function propagatedCode(firstExit, exits) {
  if (Number.isInteger(firstExit.code) && firstExit.code > 0) return firstExit.code;
  if (firstExit.signal) return signalExitCode(firstExit.signal);
  const otherFailure = exits.find((exit) => Number.isInteger(exit.code) && exit.code > 0);
  return otherFailure?.code ?? 0;
}

function watchSignals(source) {
  const handlers = new Map();
  const promise = new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => resolve({ type: "signal", signal });
      handlers.set(signal, handler);
      source.once(signal, handler);
    }
  });
  return {
    promise,
    close() {
      for (const [signal, handler] of handlers) source.removeListener(signal, handler);
    }
  };
}

function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] ?? 1);
}

export async function runSupervisor({
  intakeCommand,
  runtimeCommand,
  startupTimeoutMs = 60_000,
  signalSource = process,
  stdout = process.stdout,
  stderr = process.stderr
}) {
  const runtime = spawn(runtimeCommand[0], runtimeCommand.slice(1), {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const intake = spawn(intakeCommand[0], intakeCommand.slice(1), {
    stdio: ["pipe", "pipe", "pipe"]
  });

  intake.stdout.pipe(runtime.stdin);
  runtime.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") {
      stderr.write(`${JSON.stringify({
        type: "error",
        component: "supervisor",
        message: "intake-runtime pipeline failed"
      })}\n`);
    }
  });
  runtime.stdout.pipe(stdout, { end: false });

  const intakeReady = waitForLine(intake.stderr, (line) => (
    line === "[intake] ready"
  ));
  const runtimeReady = waitForLine(runtime.stderr, runtimeIsReady);
  const intakeExit = waitForExit(intake, "intake");
  const runtimeExit = waitForExit(runtime, "runtime");
  const exitEvents = [
    intakeExit.then((exit) => ({ type: "exit", exit })),
    runtimeExit.then((exit) => ({ type: "exit", exit }))
  ];
  const signals = watchSignals(signalSource);

  let timeout;
  try {
    let event = await Promise.race([
      Promise.all([intakeReady, runtimeReady]).then(() => ({ type: "ready" })),
      ...exitEvents,
      signals.promise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timeout" }), startupTimeoutMs);
      })
    ]);
    clearTimeout(timeout);

    const started = event.type === "ready";
    if (started) {
      stderr.write(`${JSON.stringify({ type: "ready", component: "supervisor" })}\n`);
      event = await Promise.race([...exitEvents, signals.promise]);
    }
    if (!started && event.type === "timeout") {
      stderr.write(`${JSON.stringify({
        type: "error",
        component: "supervisor",
        message: `startup timed out after ${startupTimeoutMs}ms`
      })}\n`);
    }
    if (event.type === "exit" && (
      !started || event.exit.error || event.exit.code !== 0 || event.exit.signal
    )) {
      stderr.write(`${JSON.stringify({
        type: "error",
        component: event.exit.component,
        message: event.exit.error
          ? "failed to start"
          : (started ? "child exited" : "exited before ready"),
        code: event.exit.code,
        signal: event.exit.signal
      })}\n`);
    }

    terminate(intake);
    terminate(runtime);
    const exits = await Promise.all([intakeExit, runtimeExit]);
    if (event.type === "signal") return signalExitCode(event.signal);
    if (event.type === "timeout") return 1;
    const code = propagatedCode(event.exit, exits);
    return code || (started ? 0 : 1);
  } finally {
    clearTimeout(timeout);
    signals.close();
  }
}

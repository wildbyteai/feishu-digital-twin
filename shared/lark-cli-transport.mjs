import { spawn } from "node:child_process";
import process from "node:process";

import { buildLarkEnvironment } from "./subprocess-environment.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

function boundedInteger(value, name, { minimum, maximum }) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function stableFailure(type) {
  return {
    exit_code: 1,
    stdout: "",
    stderr: JSON.stringify({ ok: false, error: { type } })
  };
}

export function runLarkCommand(argv, {
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS
} = {}) {
  const boundedTimeoutMs = boundedInteger(timeoutMs, "timeoutMs", {
    minimum: 1,
    maximum: MAX_TIMEOUT_MS
  });
  const boundedMaxOutputBytes = boundedInteger(
    maxOutputBytes,
    "maxOutputBytes",
    { minimum: 1, maximum: DEFAULT_MAX_OUTPUT_BYTES }
  );
  const boundedTerminationGraceMs = boundedInteger(
    terminationGraceMs,
    "terminationGraceMs",
    { minimum: 0, maximum: DEFAULT_TERMINATION_GRACE_MS }
  );

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stopReason = null;
    let forceKillAttempted = false;
    let timeoutTimer;
    let forceKillTimer;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      resolve(result);
    };

    const stop = (reason) => {
      if (settled || stopReason !== null) return;
      stopReason = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        // The forced termination below remains the stable fallback.
      }
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        forceKillAttempted = true;
        try {
          if (!child.kill("SIGKILL")) finish(stableFailure(stopReason));
        } catch {
          finish(stableFailure(stopReason));
        }
      }, boundedTerminationGraceMs);
    };

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: buildLarkEnvironment(),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      finish(stableFailure("spawn_failed"));
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stopReason !== null) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > boundedMaxOutputBytes) stop("output_limit");
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stopReason !== null) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > boundedMaxOutputBytes) stop("output_limit");
      else stderr += chunk;
    });
    child.on("error", () => {
      if (stopReason === null) finish(stableFailure("spawn_failed"));
      else if (forceKillAttempted) finish(stableFailure(stopReason));
    });
    child.once("close", (code) => finish(stopReason === null
      ? { exit_code: code ?? 1, stdout, stderr }
      : stableFailure(stopReason)));
    timeoutTimer = setTimeout(() => stop("timeout"), boundedTimeoutMs);
  });
}

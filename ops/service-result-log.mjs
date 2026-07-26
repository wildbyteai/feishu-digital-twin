#!/usr/bin/env node

import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  shouldEmitServiceResult,
  summarizeServiceResult
} from "../runtime/src/result-summary.mjs";

const RESULT_MAX_BYTES = 10 * 1024 * 1024;
const SIGNAL_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const SIGNAL_COMPONENT = /^[a-z][a-z0-9_-]{0,31}$/u;
const POLICY = Object.freeze({
  result: Object.freeze({
    maxBytes: RESULT_MAX_BYTES,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS
  }),
  signal: Object.freeze({
    maxBytes: SIGNAL_MAX_BYTES,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS
  })
});

function requirePositiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value === "string" && !/^[1-9]\d*$/u.test(value)) {
    throw new TypeError(`${name} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  if (parsed > maximum) throw new TypeError(`${name} exceeds the built-in privacy maximum`);
  return parsed;
}

export function resolveLogPolicy({
  mode = "result",
  maxBytes,
  maxAgeSeconds
} = {}) {
  const policy = POLICY[mode];
  if (!policy) throw new TypeError("unknown service log mode");
  return {
    maxBytes: requirePositiveInteger(
      maxBytes ?? policy.maxBytes,
      "max bytes",
      policy.maxBytes
    ),
    maxAgeSeconds: requirePositiveInteger(
      maxAgeSeconds ?? policy.maxAgeSeconds,
      "max age seconds",
      policy.maxAgeSeconds
    )
  };
}

function retainedLog(content, { cutoffMs, maxBytes, project }) {
  const retained = [];
  let retainedBytes = 0;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const loggedAt = Date.parse(parsed?.logged_at ?? "");
    if (!Number.isFinite(loggedAt) || loggedAt < cutoffMs) continue;
    let projected;
    try {
      projected = project(parsed);
    } catch {
      continue;
    }
    if (!projected) continue;
    const encoded = Buffer.from(`${JSON.stringify(projected)}\n`);
    if (encoded.byteLength > maxBytes) continue;
    retained.push(encoded);
    retainedBytes += encoded.byteLength;
    while (retainedBytes > maxBytes && retained.length > 0) {
      retainedBytes -= retained.shift().byteLength;
    }
  }
  return Buffer.concat(retained, retainedBytes);
}

async function maintainLog({ logPath, maxBytes, maxAgeMs, nowMs, project }) {
  let content = "";
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const retained = retainedLog(content, {
    cutoffMs: nowMs - maxAgeMs,
    maxBytes,
    project
  });
  if (retained.equals(Buffer.from(content))) return;
  await writeFile(logPath, retained, { mode: 0o600 });
}

async function writeProjectedLog({
  input = process.stdin,
  logPath,
  maxBytes = RESULT_MAX_BYTES,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  clock = () => Date.now(),
  maintenanceIntervalMs = MAINTENANCE_INTERVAL_MS,
  project,
  projectRetained
}) {
  if (typeof logPath !== "string" || logPath.length === 0) {
    throw new TypeError("log path must be a non-empty string");
  }
  const limit = requirePositiveInteger(maxBytes, "max bytes");
  const maxAgeMs = requirePositiveInteger(maxAgeSeconds, "max age seconds") * 1000;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs <= 0) {
    throw new TypeError("maintenance interval must be a positive integer");
  }
  if (typeof project !== "function") throw new TypeError("project must be a function");
  if (typeof projectRetained !== "function") {
    throw new TypeError("retained record projector must be a function");
  }
  const handle = await open(logPath, "a", 0o600);
  await handle.chmod(0o600);
  let lines;
  let maintenanceTimer;
  let maintainedAt = clock();
  let serialized = Promise.resolve();
  let backgroundError = null;
  const enqueue = (operation) => {
    const pending = serialized.then(() => {
      if (backgroundError) throw backgroundError;
      return operation();
    });
    serialized = pending.catch((error) => {
      backgroundError ??= error;
    });
    return pending;
  };
  const maintain = async (nowMs) => {
    await maintainLog({
      logPath,
      maxBytes: limit,
      maxAgeMs,
      nowMs,
      project: projectRetained
    });
    maintainedAt = nowMs;
  };
  try {
    await enqueue(() => maintain(maintainedAt));
    lines = readline.createInterface({ input, crlfDelay: Infinity });
    maintenanceTimer = setInterval(() => {
      void enqueue(() => maintain(clock())).catch(() => lines?.close());
    }, maintenanceIntervalMs);
    for await (const line of lines) {
      if (!line.trim()) continue;
      await enqueue(async () => {
        const currentTime = clock();
        if (currentTime - maintainedAt >= maintenanceIntervalMs) {
          await maintain(currentTime);
        }
        const projected = project(line, currentTime);
        if (!projected) return;
        const encoded = Buffer.from(`${JSON.stringify(projected)}\n`);
        if (encoded.byteLength > limit) {
          throw new Error("service result exceeds log size limit");
        }
        const { size } = await handle.stat();
        if (size + encoded.byteLength > limit) await handle.truncate(0);
        await handle.write(encoded);
      });
    }
  } finally {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    lines?.close();
    await serialized;
    await handle.close();
  }
  if (backgroundError) throw backgroundError;
}

export function summarizeServiceSignal(line, {
  component,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof component !== "string" || !SIGNAL_COMPONENT.test(component)) {
    throw new TypeError("component must be a logical service role");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || !new Set(["ready", "error"]).has(value.type)) return null;
  const loggedAt = now();
  if (typeof loggedAt !== "string" || Number.isNaN(Date.parse(loggedAt))) {
    throw new TypeError("now must return an ISO timestamp");
  }
  return {
    logged_at: new Date(Date.parse(loggedAt)).toISOString(),
    component,
    type: value.type
  };
}

export function writeServiceResultLog(options = {}) {
  const policy = resolveLogPolicy({
    mode: "result",
    maxBytes: options.maxBytes,
    maxAgeSeconds: options.maxAgeSeconds
  });
  return writeProjectedLog({
    ...options,
    ...policy,
    projectRetained: (value) => {
      const summary = summarizeServiceResult(value, {
        traceId: () => value.trace_id,
        now: () => value.logged_at
      });
      return shouldEmitServiceResult(summary) ? summary : null;
    },
    project: (line, currentTime) => {
      const summary = summarizeServiceResult(JSON.parse(line), {
        now: () => new Date(currentTime).toISOString()
      });
      return shouldEmitServiceResult(summary) ? summary : null;
    }
  });
}

export function writeServiceSignalLog({ component, ...options } = {}) {
  const policy = resolveLogPolicy({
    mode: "signal",
    maxBytes: options.maxBytes,
    maxAgeSeconds: options.maxAgeSeconds
  });
  return writeProjectedLog({
    ...options,
    ...policy,
    projectRetained: (value) => summarizeServiceSignal(JSON.stringify(value), {
      component,
      now: () => value.logged_at
    }),
    project: (line, currentTime) => summarizeServiceSignal(line, {
      component,
      now: () => new Date(currentTime).toISOString()
    })
  });
}

async function main() {
  const [logPath, maxBytes, maxAgeSeconds, mode = "result", component] = process.argv.slice(2);
  const options = { logPath, ...resolveLogPolicy({ mode, maxBytes, maxAgeSeconds }) };
  if (mode === "result") await writeServiceResultLog(options);
  else if (mode === "signal") await writeServiceSignalLog({ ...options, component });
  else throw new TypeError("unknown service log mode");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      type: "error",
      component: "service-result-log",
      message: "service result log failed"
    })}\n`);
    process.exitCode = 1;
  });
}

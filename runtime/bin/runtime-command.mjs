import readline from "node:readline";

import { previousDateInTimeZone } from "../../shared/daily-memory-trigger.mjs";
import { summarizeServiceResult } from "../src/result-summary.mjs";
import { readRuntimeState, RuntimeState } from "../src/runtime-state.mjs";

async function serve(configPath, databasePath, createRuntime, stdout, stderr) {
  if (!databasePath) throw new Error("serve requires a SQLite state path");
  const target = await createRuntime(configPath, databasePath);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    stderr.write(`${JSON.stringify({
      type: "ready",
      frozen: target.state.getRuntimeState().frozen
    })}\n`);
    for await (const line of input) {
      if (!line.trim()) continue;
      const result = await target.handle(JSON.parse(line));
      stdout.write(`${JSON.stringify(summarizeServiceResult(result))}\n`);
    }
  } finally {
    target.state.close();
  }
}

async function runDailyMemory(
  configPath,
  databasePath,
  targetDate,
  createRuntime,
  stdout
) {
  if (!databasePath) throw new Error("daily-memory requires a SQLite state path");
  const target = await createRuntime(configPath, databasePath);
  try {
    if (
      typeof target.config.daily_memory?.folder_token !== "string" ||
      !target.config.daily_memory.folder_token
    ) {
      throw new Error("daily-memory requires config.daily_memory.folder_token");
    }
    const now = new Date();
    const resolvedDate = targetDate ?? previousDateInTimeZone(
      now,
      target.config.principal.timezone ?? "Asia/Shanghai"
    );
    const result = await target.runDailyMemory(resolvedDate, { now });
    stdout.write(`${JSON.stringify({
      ...summarizeServiceResult(result),
      target_date: resolvedDate
    })}\n`);
  } finally {
    target.state.close();
  }
}

function changeFreeze(databasePath, frozen, reason, stdout) {
  if (!databasePath) throw new Error("a SQLite state path is required");
  const state = new RuntimeState(databasePath);
  try {
    stdout.write(`${JSON.stringify(state.setFrozen(frozen, reason))}\n`);
  } finally {
    state.close();
  }
}

function showState(databasePath, stdout) {
  if (!databasePath) throw new Error("a SQLite state path is required");
  stdout.write(`${JSON.stringify(readRuntimeState(databasePath))}\n`);
}

export async function runRuntimeCommand({
  argv,
  createRuntime,
  usage,
  stdout = process.stdout,
  stderr = process.stderr
}) {
  if (!Array.isArray(argv) || typeof createRuntime !== "function" || typeof usage !== "string") {
    throw new TypeError("runtime command requires argv, createRuntime and usage");
  }
  const [command, first, second, third] = argv;
  if (command === "serve") {
    await serve(first, second, createRuntime, stdout, stderr);
    return 0;
  }
  if (command === "daily-memory") {
    await runDailyMemory(first, second, third, createRuntime, stdout);
    return 0;
  }
  if (command === "freeze") {
    changeFreeze(first, true, "LOCAL_OPERATOR", stdout);
    return 0;
  }
  if (command === "resume") {
    changeFreeze(first, false, "LOCAL_OPERATOR", stdout);
    return 0;
  }
  if (command === "state") {
    showState(first, stdout);
    return 0;
  }
  stderr.write(`${usage}\n`);
  return 64;
}

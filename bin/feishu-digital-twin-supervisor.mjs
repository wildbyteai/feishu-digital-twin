#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { runSupervisor } from "./supervisor-core.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const [configPath, databasePath] = process.argv.slice(2);
  if (!configPath || !databasePath) {
    process.stderr.write("usage: feishu-digital-twin-supervisor CONFIG_JSON STATE_DB\n");
    return 64;
  }
  return runSupervisor({
    intakeCommand: [
      process.execPath,
      path.join(projectRoot, "intake/bin/feishu-digital-twin-intake.mjs"),
      "event-run",
      configPath
    ],
    runtimeCommand: [
      process.execPath,
      path.join(projectRoot, "runtime/bin/feishu-digital-twin-runtime.mjs"),
      "serve",
      configPath,
      databasePath
    ]
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      type: "error",
      component: "supervisor",
      message: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  });
}

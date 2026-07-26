#!/usr/bin/env node

import process from "node:process";

import { LarkGuard } from "../../executor/src/lark-guard.mjs";
import { LarkImReader } from "../../intake/src/lark-im-reader.mjs";
import {
  createBaseConsoleRefresher,
  loadBaseConsole
} from "../src/base-console.mjs";
import { loadInstanceConfig } from "../src/config-loader.mjs";
import { CodexInferenceAdapter } from "../src/inference-adapter.mjs";
import { projectRuntimeError } from "../src/privacy-projection.mjs";
import { RuntimeState } from "../src/runtime-state.mjs";
import { TwinRuntime } from "../src/twin-runtime.mjs";
import { runRuntimeCommand } from "./runtime-command.mjs";

function trustedProtectedValues(config) {
  return [...new Set([
    config.daily_memory?.folder_token,
    config.daily_memory?.folder_name,
    ...(config.daily_memory?.excluded_chat_ids ?? []),
    config.console?.base_token,
    config.console?.runtime_table,
    config.console?.group_rules_table
  ].filter((value) => typeof value === "string" && value.length > 0))];
}

async function createRuntime(configPath, databasePath) {
  if (!configPath) throw new Error("a config JSON file is required");
  const staticConfig = await loadInstanceConfig(configPath);
  if (staticConfig.production_data_approved !== true) {
    throw new Error("runtime requires production_data_approved=true");
  }
  const config = await loadBaseConsole(staticConfig);
  const state = new RuntimeState(databasePath, {
    stateRetentionMs: (config.privacy?.state_retention_days ?? 30) * 86_400_000
  });
  const createGuard = (runtimeConfig) => new LarkGuard({
    larkBin: runtimeConfig.lark_cli_bin ?? "lark-cli",
    profile: runtimeConfig.profile,
    principalName: runtimeConfig.principal.name,
    allowedDomains: runtimeConfig.allowed_lark_domains,
    protectedValues: trustedProtectedValues(runtimeConfig)
  });
  const reader = new LarkImReader({
    larkBin: config.lark_cli_bin ?? "lark-cli",
    profile: config.profile,
    productionDataApproved: true
  });
  const runtime = new TwinRuntime({
    config,
    state,
    guard: createGuard(config),
    createGuard,
    refreshConfig: createBaseConsoleRefresher(staticConfig, { initialConfig: config }),
    reader,
    inferenceAdapter: new CodexInferenceAdapter({
      codexBin: staticConfig.codex_bin,
      codexEnvironmentRoot: staticConfig.codex_environment_root,
      timeoutMs: config.codex_timeout_ms ?? 120000
    })
  });
  return {
    config,
    state,
    handle: (event) => runtime.handle(event),
    runDailyMemory: (targetDate, options) => runtime.runDailyMemory(targetDate, options)
  };
}

runRuntimeCommand({
  argv: process.argv.slice(2),
  createRuntime,
  usage: "usage: feishu-digital-twin-runtime <serve CONFIG_JSON STATE_DB|daily-memory CONFIG_JSON STATE_DB [YYYY-MM-DD]|freeze STATE_DB|resume STATE_DB|state STATE_DB>"
}).then((code) => {
  process.exitCode = code;
}).catch(() => {
  process.stderr.write(`${JSON.stringify(projectRuntimeError({
    component: "runtime",
    code: "RUNTIME_COMMAND_FAILED"
  }))}\n`);
  process.exitCode = 1;
});

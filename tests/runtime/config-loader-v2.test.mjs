import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTANCE_CONFIG_FIELDS,
  loadInstanceConfig,
  validateInstanceConfig
} from "../../runtime/src/config-loader.mjs";
import { LARK_CAPABILITY_CATALOG } from "../../shared/lark-capability-catalog.mjs";

const instanceConfigSchema = fileURLToPath(new URL(
  "../../runtime/schemas/instance-config.schema.json",
  import.meta.url
));

function config(overrides = {}) {
  return {
    schema_version: 2,
    profile: "fixture-user",
    message_scope: "bot_only",
    production_data_approved: false,
    control: { mode: "local", enabled: false },
    principal: {
      name: "示例用户",
      open_id: "ou_fixture_principal",
      timezone: "Asia/Shanghai",
      address_names: ["示例用户"]
    },
    schedule: {
      workdays: [1, 2, 3, 4, 5],
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

test("实例配置不选择模型 Provider，只保存本机 Codex 运行路径", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "twin-config-loader-"));
  const configPath = path.join(directory, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify(config({
      codex_bin: "/fixture/bin/codex",
      codex_environment_root: "/fixture/codex-runtime"
    })), { mode: 0o600 });
    const loaded = await loadInstanceConfig(configPath);

    assert.equal(loaded.codex_bin, "/fixture/bin/codex");
    assert.equal(loaded.codex_environment_root, "/fixture/codex-runtime");
    assert.equal(Object.hasOwn(loaded, "provider_ref"), false);
    assert.equal(Object.hasOwn(loaded, "api_key"), false);
    assert.equal(Object.hasOwn(loaded, "base_url"), false);
    assert.equal(Object.hasOwn(loaded, "codex_isolation_root"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("实例配置拒绝 Secret、模型 Provider 和旧隔离字段", () => {
  for (const unsafe of [
    config({ api_key: "fixture-secret" }),
    config({ auth: { access_token: "fixture-secret" } }),
    config({ base_url: "https://provider.example.invalid/v1" }),
    config({ provider_ref: "legacy-provider" }),
    config({ model_provider: "custom-provider" }),
    config({ codex_isolation_root: "/fixture/legacy-runtime" })
  ]) {
    assert.throws(() => validateInstanceConfig(unsafe), /not allowed|unknown/u);
  }
});

test("实例配置校验完整的非秘密声明式配置并拒绝未知嵌套字段", () => {
  const source = config({
    instance_id: "fixture-instance",
    lark_cli_bin: "lark-cli",
    codex_timeout_ms: 120000,
    max_ai_action_rounds: 3,
    supplement_lookback_minutes: 5,
    daily_memory: {
      folder_token: "fixture_daily_folder",
      folder_name: "示例数字分身每日记忆",
      excluded_chat_ids: ["oc_fixture_sensitive"],
      excluded_topics: ["薪酬明细"]
    },
    privacy: {
      state_retention_days: 14,
      result_log_retention_days: 3,
      result_log_max_bytes: 5242880,
      signal_log_retention_days: 2,
      signal_log_max_bytes: 524288
    },
    group_rules: [{
      chat_id: "oc_fixture_team",
      rules: ["只有与本群工作相关时才介入"]
    }],
    authority_rules: ["所有权转让必须由主体用户本人操作。"]
  });

  const validated = validateInstanceConfig(source);
  assert.deepEqual(validated, source);
  assert.notEqual(validated, source);

  assert.throws(() => validateInstanceConfig(config({
    control: { mode: "base" },
    allowed_lark_domains: ["im", "base"],
    console: {
      base_token: "fixture_console_base",
      runtime_table: "tbl_fixture_runtime",
      group_rules_table: "tbl_fixture_rules",
      provider_endpoint: "https://provider.example.invalid"
    }
  })), /config\.console\.provider_endpoint is unknown/u);
  assert.throws(() => validateInstanceConfig(config({
    group_rules: [{ chat_id: "oc_fixture_team", rules: [], mode: "custom" }]
  })), /config\.group_rules\[0\]\.mode is unknown/u);
});

test("实例配置只允许 local 或 Base 成为唯一运行开关与规则来源", async () => {
  const local = config({
    control: { mode: "local", enabled: false },
    authority_rules: ["使用本机自然语言规则。"],
    group_rules: [{ chat_id: "oc_fixture_team", rules: ["使用本机群规则。"] }]
  });
  assert.deepEqual(validateInstanceConfig(local), local);

  const base = config({
    control: { mode: "base" },
    allowed_lark_domains: ["im", "base"],
    console: {
      base_token: "fixture_console_base",
      runtime_table: "tbl_fixture_runtime",
      group_rules_table: "tbl_fixture_rules"
    }
  });
  assert.deepEqual(validateInstanceConfig(base), base);

  const missingControl = config();
  delete missingControl.control;
  for (const invalid of [
    missingControl,
    config({ control: { mode: "local" } }),
    config({
      control: { mode: "local", enabled: true },
      console: base.console
    }),
    config({ control: { mode: "base", enabled: true }, console: base.console }),
    config({ control: { mode: "base" } }),
    config({ control: { mode: "base" }, console: base.console }),
    config({
      control: { mode: "base" },
      console: base.console,
      authority_rules: ["不得与 Base 双写。"]
    }),
    config({
      control: { mode: "base" },
      console: base.console,
      group_rules: [{ chat_id: "oc_fixture_team", rules: ["不得与 Base 双写。"] }]
    }),
    config({ control: { mode: "local", enabled: true }, production_enabled: true })
  ]) {
    assert.throws(() => validateInstanceConfig(invalid), /config\.(control|console|authority_rules|group_rules|production_enabled|allowed_lark_domains)/u);
  }

  const schema = JSON.parse(await readFile(instanceConfigSchema, "utf8"));
  assert.deepEqual(schema.properties.schema_version.enum, [1, 2]);
  assert.equal(schema.properties.production_enabled.deprecated, true);
  assert.deepEqual(schema.properties.control.properties.mode.enum, ["local", "base"]);
});

test("旧版 v1 配置保持只读兼容，新配置使用 v2 单一控制源", async () => {
  const legacyLocal = config({
    schema_version: 1,
    production_enabled: true
  });
  delete legacyLocal.control;
  assert.deepEqual(validateInstanceConfig(legacyLocal), legacyLocal);

  const legacyBase = config({
    schema_version: 1,
    production_enabled: false,
    console: {
      base_token: "fixture_console_base",
      runtime_table: "tbl_fixture_runtime",
      group_rules_table: "tbl_fixture_rules"
    },
    authority_rules: ["旧版 Base 空规则时使用的本机规则。"],
    group_rules: [{ chat_id: "oc_fixture_team", rules: ["旧版群规则。"] }]
  });
  delete legacyBase.control;
  assert.deepEqual(validateInstanceConfig(legacyBase), legacyBase);

  assert.throws(
    () => validateInstanceConfig(config({ schema_version: 1 })),
    /config\.control/u
  );
  assert.throws(
    () => validateInstanceConfig(config({ production_enabled: true })),
    /config\.production_enabled/u
  );

  const schema = JSON.parse(await readFile(instanceConfigSchema, "utf8"));
  assert.equal(schema.allOf.length > 0, true);
});

test("实例配置对超时、反馈轮次、补读窗口和数组内容执行边界校验", () => {
  for (const invalid of [
    config({ codex_timeout_ms: 999 }),
    config({ max_ai_action_rounds: 0 }),
    config({ max_ai_action_rounds: 4 }),
    config({ supplement_lookback_minutes: 0 }),
    config({ allowed_lark_domains: ["im", "im"] }),
    config({ authority_rules: [""] }),
    config({ group_rules: [{ chat_id: "oc_fixture_team", rules: "not-an-array" }] })
  ]) {
    assert.throws(() => validateInstanceConfig(invalid), /config\./u);
  }
});

test("公共实例配置必须显式选择消息发现范围", async () => {
  for (const messageScope of ["bot_only", "internal_visible", "all_visible"]) {
    const source = config({ message_scope: messageScope });
    assert.equal(validateInstanceConfig(source).message_scope, messageScope);
  }

  const missing = config();
  delete missing.message_scope;
  assert.throws(
    () => validateInstanceConfig(missing),
    /config\.message_scope/u
  );
  assert.throws(
    () => validateInstanceConfig(config({ message_scope: "selected_chats" })),
    /config\.message_scope/u
  );

  const schema = JSON.parse(await readFile(instanceConfigSchema, "utf8"));
  assert.deepEqual(schema.properties.message_scope.enum, [
    "bot_only",
    "internal_visible",
    "all_visible"
  ]);
  assert.equal(schema.required.includes("message_scope"), true);
});

test("实例配置只接受能力目录声明的官方业务域", async () => {
  const officialBusinessDomains = [
    "approval",
    "apps",
    "attendance",
    "base",
    "calendar",
    "contact",
    "docs",
    "drive",
    "im",
    "mail",
    "markdown",
    "mindnotes",
    "minutes",
    "note",
    "okr",
    "sheets",
    "slides",
    "task",
    "vc",
    "whiteboard",
    "wiki"
  ];
  const source = config({ allowed_lark_domains: officialBusinessDomains });
  assert.deepEqual(validateInstanceConfig(source), source);

  for (const domain of ["event", "telepathy"]) {
    assert.throws(
      () => validateInstanceConfig(config({ allowed_lark_domains: ["im", domain] })),
      /config\.allowed_lark_domains/u
    );
  }

  const schema = JSON.parse(await readFile(instanceConfigSchema, "utf8"));
  assert.deepEqual(
    schema.properties.allowed_lark_domains.items.enum,
    officialBusinessDomains
  );
});

test("声明式能力目录保持产品能力到最小业务域的单一映射", () => {
  assert.deepEqual(LARK_CAPABILITY_CATALOG.capabilities, {
    message: ["im"],
    task: ["task"],
    calendar: ["calendar"],
    docs: ["docs", "drive"],
    base: ["base"],
    enterprise_knowledge: ["drive", "wiki", "docs", "base", "sheets", "markdown"],
    daily_memory: ["im", "task", "calendar", "drive", "docs"],
    console: ["base"]
  });
});

test("隐私保留期只能缩短硬上限且每日记忆支持敏感范围排除", async () => {
  const source = config({
    privacy: {
      state_retention_days: 7,
      result_log_retention_days: 2,
      result_log_max_bytes: 1048576,
      signal_log_retention_days: 1,
      signal_log_max_bytes: 131072
    },
    daily_memory: {
      folder_token: "fixture_daily_folder",
      folder_name: "示例数字分身每日记忆",
      excluded_chat_ids: ["oc_fixture_sensitive"],
      excluded_topics: ["薪酬", "法务调查"]
    }
  });
  assert.deepEqual(validateInstanceConfig(source), source);

  for (const invalid of [
    config({ privacy: { state_retention_days: 31 } }),
    config({ privacy: { result_log_retention_days: 8 } }),
    config({ privacy: { result_log_max_bytes: 10485761 } }),
    config({ privacy: { signal_log_retention_days: 8 } }),
    config({ privacy: { signal_log_max_bytes: 1048577 } }),
    config({ daily_memory: {
      folder_token: "fixture_daily_folder",
      folder_name: "示例数字分身每日记忆",
      excluded_chat_ids: ["oc_duplicate", "oc_duplicate"]
    } })
  ]) {
    assert.throws(() => validateInstanceConfig(invalid), /config\.(privacy|daily_memory)/u);
  }

  const schema = JSON.parse(await readFile(instanceConfigSchema, "utf8"));
  assert.equal(schema.properties.privacy.properties.state_retention_days.maximum, 30);
  assert.equal(schema.properties.privacy.properties.result_log_retention_days.maximum, 7);
  assert.equal(schema.properties.privacy.properties.result_log_max_bytes.maximum, 10485760);
  assert.equal(schema.properties.privacy.properties.signal_log_max_bytes.maximum, 1048576);
});

test("实例配置校验主体用户时区和后台调度边界", async () => {
  const source = config({
    principal: {
      name: "示例用户",
      open_id: "ou_fixture_principal",
      timezone: "America/Los_Angeles"
    },
    schedule: {
      workdays: [1, 2, 3, 4, 5],
      workday_start_hour: 8,
      workday_end_hour: 17,
      work_interval_seconds: 45,
      quiet_interval_seconds: 420,
      daily_memory_hour: 1,
      daily_memory_minute: 25
    }
  });
  assert.deepEqual(validateInstanceConfig(source), source);

  const legacySchedule = structuredClone(config());
  delete legacySchedule.schedule.workdays;
  const validatedLegacy = validateInstanceConfig(legacySchedule);
  assert.equal(Object.hasOwn(validatedLegacy.schedule, "workdays"), false);

  for (const invalid of [
    config({ principal: { ...config().principal, timezone: "not/a-timezone" } }),
    config({ schedule: { ...config().schedule, workday_start_hour: -1 } }),
    config({ schedule: { ...config().schedule, workday_end_hour: 25 } }),
    config({
      schedule: {
        ...config().schedule,
        workday_start_hour: 18,
        workday_end_hour: 9
      }
    }),
    config({ schedule: { ...config().schedule, work_interval_seconds: 29 } }),
    config({ schedule: { ...config().schedule, quiet_interval_seconds: 29 } }),
    config({ schedule: { ...config().schedule, quiet_interval_seconds: 86401 } }),
    config({ schedule: { ...config().schedule, daily_memory_hour: 24 } }),
    config({ schedule: { ...config().schedule, daily_memory_minute: 60 } }),
    config({ schedule: { ...config().schedule, workdays: [] } }),
    config({ schedule: { ...config().schedule, workdays: [0, 1] } }),
    config({ schedule: { ...config().schedule, workdays: [1, 8] } }),
    config({ schedule: { ...config().schedule, workdays: [1, 1] } }),
    config({ schedule: { ...config().schedule, workdays: [1, 2.5] } }),
    config({ schedule: { ...config().schedule, custom_mode: true } })
  ]) {
    assert.throws(() => validateInstanceConfig(invalid), /config\.(principal\.timezone|schedule)/u);
  }

  const schema = JSON.parse(await readFile(instanceConfigSchema, "utf8"));
  assert.equal(schema.properties.schedule.required.includes("workdays"), false);
  assert.equal(schema.properties.schedule.properties.workdays.minItems, 1);
  assert.equal(schema.properties.schedule.properties.workdays.uniqueItems, true);
  assert.deepEqual(schema.properties.schedule.properties.workdays.items, {
    type: "integer",
    minimum: 1,
    maximum: 7
  });
});

test("实例配置文件必须是绝对路径下仅当前用户可访问的普通文件", async () => {
  await assert.rejects(() => loadInstanceConfig("config.json"), /absolute instance config path/u);

  const directory = mkdtempSync(path.join(tmpdir(), "twin-config-permissions-"));
  const configPath = path.join(directory, "config.json");
  const linkedPath = path.join(directory, "linked.json");
  try {
    writeFileSync(configPath, JSON.stringify(config()), { mode: 0o600 });
    chmodSync(configPath, 0o644);
    await assert.rejects(() => loadInstanceConfig(configPath), /group or other users/u);

    chmodSync(configPath, 0o600);
    symlinkSync(configPath, linkedPath);
    await assert.rejects(() => loadInstanceConfig(linkedPath), /regular file/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("公开实例配置 Schema 只描述 Codex 运行路径而不描述模型 Provider", async () => {
  const schema = JSON.parse(await readFile(instanceConfigSchema, "utf8"));

  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.codex_bin.type, "string");
  assert.equal(schema.properties.codex_environment_root.type, "string");
  assert.equal(Object.hasOwn(schema.properties, "provider_ref"), false);
  assert.equal(schema.required.includes("provider_ref"), false);
  assert.equal(Object.hasOwn(schema.properties, "api_key"), false);
  assert.equal(Object.hasOwn(schema.properties, "base_url"), false);
  assert.equal(Object.hasOwn(schema.properties, "codex_isolation_root"), false);
  assert.equal(schema.properties.principal.additionalProperties, false);
  assert.equal(schema.properties.console.additionalProperties, false);
  assert.deepEqual(
    Object.keys(schema.properties).sort((left, right) => left.localeCompare(right, "en")),
    [...INSTANCE_CONFIG_FIELDS]
  );
});

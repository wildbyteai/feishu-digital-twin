import { runLarkCommand } from "../../executor/src/lark-guard.mjs";

export const BASE_CONSOLE_DEFAULT_REFRESH_SECONDS = 10;
export const BASE_CONSOLE_SETUP_SCHEMA = Object.freeze({
  runtime_table: Object.freeze({
    record_requirement: "exactly_one",
    fields: Object.freeze([
      Object.freeze({
        name: "名称",
        type: "text",
        required: false,
        initial_value: "默认配置"
      }),
      Object.freeze({
        name: "数字分身启用",
        type: "checkbox",
        required: true,
        role: "daily_master_switch",
        legacy_aliases: Object.freeze(["生产执行"]),
        initial_value: false
      }),
      Object.freeze({
        name: "允许域",
        type: "multi_select",
        required: true,
        initial_value: Object.freeze(["继承"])
      }),
      Object.freeze({
        name: "允许能力",
        type: "multi_select",
        required: false,
        initial_value: Object.freeze(["继承"])
      }),
      Object.freeze({
        name: "个性化规则",
        type: "multiline_text",
        required: true,
        initial_value: ""
      })
    ])
  }),
  group_rules_table: Object.freeze({
    record_requirement: "zero_or_more",
    fields: Object.freeze([
      Object.freeze({ name: "群名称", type: "text", required: false }),
      Object.freeze({ name: "群ID", type: "text", required: true }),
      Object.freeze({ name: "启用", type: "checkbox", required: true }),
      Object.freeze({ name: "个性化规则", type: "multiline_text", required: true })
    ])
  })
});

const runtimeMasterSwitch = BASE_CONSOLE_SETUP_SCHEMA.runtime_table.fields.find(
  ({ role }) => role === "daily_master_switch"
);
const RUNTIME_TABLE_FIELDS = Object.freeze({
  all: Object.freeze(BASE_CONSOLE_SETUP_SCHEMA.runtime_table.fields
    .filter(({ required, name }) => required && name !== runtimeMasterSwitch.name)
    .map(({ name }) => name)),
  any: Object.freeze([
    runtimeMasterSwitch.name,
    ...runtimeMasterSwitch.legacy_aliases
  ])
});
const GROUP_RULES_TABLE_FIELDS = Object.freeze({
  all: Object.freeze(BASE_CONSOLE_SETUP_SCHEMA.group_rules_table.fields
    .filter(({ required }) => required)
    .map(({ name }) => name)),
  any: Object.freeze([])
});

function cellValue(value) {
  if (!Array.isArray(value)) return value;
  return value.map((item) =>
    typeof item === "string" ? item : item?.text ?? item?.name ?? item?.value
  ).filter(Boolean);
}

function enabled(value) {
  const normalized = cellValue(value);
  return normalized === true || normalized === 1 || normalized === "true" || normalized === "是";
}

function lines(value) {
  const normalized = cellValue(value);
  if (Array.isArray(normalized)) return normalized;
  if (typeof normalized !== "string") return [];
  return normalized.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function allowedDomains(fields, localDomains) {
  if (!Object.hasOwn(fields, "允许域")) return [...localDomains];
  const raw = fields.允许域;
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) {
    throw new Error("Base console 允许域 must be 继承 or a non-empty domain list");
  }
  const domains = values.flatMap((item) => {
    const value = typeof item === "string"
      ? item
      : item?.text ?? item?.name ?? item?.value;
    if (typeof value !== "string") {
      throw new Error("Base console 允许域 contains a non-text value");
    }
    return value.split(/\r?\n/u).map((domain) => {
      const trimmed = domain.trim();
      if (!trimmed) throw new Error("Base console 允许域 contains an empty value");
      return trimmed;
    });
  });
  if (domains.length === 1 && domains[0] === "继承") return [...localDomains];
  if (domains.includes("继承")) {
    throw new Error("Base console 允许域 cannot mix 继承 with explicit domains");
  }
  if (new Set(domains).size !== domains.length) {
    throw new Error("Base console 允许域 cannot contain duplicate domains");
  }
  const localDomainSet = new Set(localDomains);
  const invalidDomains = domains.filter((domain) => !localDomainSet.has(domain));
  if (invalidDomains.length > 0) {
    throw new Error(
      `Base console 允许域 exceeds the local permission ceiling: ${invalidDomains.join(", ")}`
    );
  }
  return domains;
}

function localCapabilityMaximum(config) {
  if (Array.isArray(config.allowed_capabilities)) return [...config.allowed_capabilities];
  return config.public_web_search_approved === true ? ["public.web.search"] : [];
}

function allowedCapabilities(fields, config) {
  const localCapabilities = localCapabilityMaximum(config);
  if (!Object.hasOwn(fields, "允许能力")) return localCapabilities;
  const raw = fields.允许能力;
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length === 0) {
    throw new Error("Base console 允许能力 must be 继承 or a non-empty capability list");
  }
  const capabilities = values.flatMap((item) => {
    const value = typeof item === "string"
      ? item
      : item?.text ?? item?.name ?? item?.value;
    if (typeof value !== "string") {
      throw new Error("Base console 允许能力 contains a non-text value");
    }
    return value.split(/\r?\n/u).map((capability) => {
      const trimmed = capability.trim();
      if (!trimmed) throw new Error("Base console 允许能力 contains an empty value");
      return trimmed;
    });
  });
  if (capabilities.length === 1 && capabilities[0] === "继承") return localCapabilities;
  if (capabilities.includes("继承")) {
    throw new Error("Base console 允许能力 cannot mix 继承 with explicit capabilities");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Base console 允许能力 cannot contain duplicate capabilities");
  }
  const localCapabilitySet = new Set(localCapabilities);
  const invalidCapabilities = capabilities.filter((capability) => (
    !localCapabilitySet.has(capability)
  ));
  if (invalidCapabilities.length > 0) {
    throw new Error("Base console 允许能力 exceeds the local permission ceiling");
  }
  return capabilities;
}

function requireTableFields(fields, requirements, { requiredPrimaryField = null } = {}) {
  const available = new Set(fields.filter((field) => typeof field === "string"));
  const missing = requirements.all.filter((field) => !available.has(field));
  const missingAlternative = requirements.any.length > 0 &&
    requirements.any.every((field) => !available.has(field));
  const missingPrimary = requiredPrimaryField !== null && !available.has(requiredPrimaryField);
  if (missing.length > 0 || missingAlternative || missingPrimary) {
    throw new Error("Base console table is missing required fields");
  }
}

async function records(config, tableId, runner, fieldRequirements, fieldOptions = {}) {
  const pageSize = 200;
  const maximumPages = 1_000;
  const rows = [];
  let fields = null;
  let offset = 0;
  for (let page = 0; page < maximumPages; page += 1) {
    const argv = [
      config.lark_cli_bin ?? "lark-cli",
      "--profile",
      config.profile,
      "base",
      "+record-list",
      "--base-token",
      config.console.base_token,
      "--table-id",
      tableId,
      "--offset",
      String(offset),
      "--limit",
      String(pageSize),
      "--as",
      "user",
      "--format",
      "json"
    ];
    const result = await runner(argv);
    if (result.exit_code !== 0) throw new Error(`Base console read failed for ${tableId}`);
    const envelope = JSON.parse(result.stdout);
    const pageFields = envelope.data?.fields;
    const pageRows = envelope.data?.data;
    if (envelope.ok !== true || !Array.isArray(pageFields) || !Array.isArray(pageRows)) {
      throw new Error(`Base console returned an invalid record list for ${tableId}`);
    }
    requireTableFields(pageFields, fieldRequirements, fieldOptions);
    if (fields === null) {
      fields = pageFields;
    } else if (
      fields.length !== pageFields.length ||
      fields.some((field, index) => field !== pageFields[index])
    ) {
      throw new Error(`Base console returned inconsistent record pages for ${tableId}`);
    }
    rows.push(...pageRows);
    const explicitHasMore = typeof envelope.data?.has_more === "boolean"
      ? envelope.data.has_more
      : typeof envelope.data?.hasMore === "boolean"
        ? envelope.data.hasMore
        : null;
    const hasMore = explicitHasMore ?? pageRows.length === pageSize;
    if (!hasMore) {
      return rows.map((row) => ({
        fields: Object.fromEntries(fields.map((field, index) => [field, row[index]]))
      }));
    }
    if (pageRows.length === 0) {
      throw new Error(`Base console returned an invalid pagination page for ${tableId}`);
    }
    offset += pageRows.length;
  }
  throw new Error(`Base console pagination exceeded the safety limit for ${tableId}`);
}

function validateConsole(config) {
  for (const field of ["base_token", "runtime_table", "group_rules_table"]) {
    if (typeof config.console?.[field] !== "string" || config.console[field].length === 0) {
      throw new TypeError(`config.console.${field} is required`);
    }
  }
}

function runtimeSwitch(runtimeRecords) {
  if (runtimeRecords.length !== 1) {
    throw new Error("Base console must contain exactly one runtime row");
  }
  const fields = runtimeRecords[0].fields ?? {};
  return enabled(fields.数字分身启用 ?? fields.生产执行);
}

function usesBaseConsole(config) {
  if (config.control?.mode === "base") return true;
  if (config.control?.mode === "local") return false;
  return Boolean(config.console);
}

function localRuntimeSwitch(config) {
  return config.control?.mode === "local"
    ? config.control.enabled === true
    : config.production_enabled === true;
}

function withLocalRuntimeSwitch(config) {
  return {
    ...config,
    production_enabled: localRuntimeSwitch(config)
  };
}

export async function loadBaseRuntimeSwitch(config, {
  runner = runLarkCommand,
  requirePrimaryMasterSwitch = false
} = {}) {
  if (!usesBaseConsole(config)) return localRuntimeSwitch(config);
  validateConsole(config);
  const runtimeRecords = await records(
    config,
    config.console.runtime_table,
    runner,
    RUNTIME_TABLE_FIELDS,
    {
      requiredPrimaryField: requirePrimaryMasterSwitch ? runtimeMasterSwitch.name : null
    }
  );
  return runtimeSwitch(runtimeRecords);
}

export function createBaseRuntimeSwitchRefresher(config, {
  runner = runLarkCommand,
  ttlMs = BASE_CONSOLE_DEFAULT_REFRESH_SECONDS * 1_000,
  now = () => Date.now()
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new TypeError("ttlMs must be a non-negative integer");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  let current = config.production_enabled === true || localRuntimeSwitch(config);
  let refreshAfter = now() + ttlMs;
  return async () => {
    const currentTime = now();
    if (!usesBaseConsole(config) || currentTime < refreshAfter) return current;
    current = await loadBaseRuntimeSwitch(config, { runner });
    refreshAfter = currentTime + ttlMs;
    return current;
  };
}

export function createBaseConsoleRefresher(config, {
  runner = runLarkCommand,
  ttlMs = BASE_CONSOLE_DEFAULT_REFRESH_SECONDS * 1_000,
  now = () => Date.now(),
  initialConfig = config
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new TypeError("ttlMs must be a non-negative integer");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  let current = structuredClone(
    usesBaseConsole(config) ? initialConfig : withLocalRuntimeSwitch(initialConfig)
  );
  let refreshAfter = now() + ttlMs;
  return async () => {
    const currentTime = now();
    if (!usesBaseConsole(config) || currentTime < refreshAfter) {
      return structuredClone(current);
    }
    current = await loadBaseConsole(config, { runner });
    refreshAfter = currentTime + ttlMs;
    return structuredClone(current);
  };
}

export async function loadBaseConsole(config, {
  runner = runLarkCommand,
  requirePrimaryMasterSwitch = false
} = {}) {
  if (!usesBaseConsole(config)) return withLocalRuntimeSwitch(config);
  validateConsole(config);

  const [runtimeRecords, groupRuleRecords] = await Promise.all([
    records(config, config.console.runtime_table, runner, RUNTIME_TABLE_FIELDS, {
      requiredPrimaryField: requirePrimaryMasterSwitch ? runtimeMasterSwitch.name : null
    }),
    records(config, config.console.group_rules_table, runner, GROUP_RULES_TABLE_FIELDS)
  ]);
  const productionEnabled = runtimeSwitch(runtimeRecords);
  const fields = runtimeRecords[0].fields ?? {};
  const effectiveAllowedDomains = allowedDomains(fields, config.allowed_lark_domains);
  const effectiveAllowedCapabilities = allowedCapabilities(fields, config);
  const authorityRules = lines(fields.个性化规则);
  const groupRules = groupRuleRecords.filter((record) => enabled(record.fields?.启用));

  return {
    ...config,
    production_enabled: productionEnabled,
    allowed_lark_domains: effectiveAllowedDomains,
    allowed_capabilities: effectiveAllowedCapabilities,
    authority_rules: authorityRules.length > 0
      ? authorityRules
      : config.control?.mode === "base"
        ? []
        : config.authority_rules,
    group_rules: groupRules.flatMap((record) => {
      const chatId = cellValue(record.fields?.群ID);
      const rules = lines(record.fields?.个性化规则);
      return typeof chatId === "string" && chatId.length > 0 && rules.length > 0
        ? [{ chat_id: chatId, rules }]
        : [];
    })
  };
}

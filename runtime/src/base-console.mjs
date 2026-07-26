import { runLarkCommand } from "../../executor/src/lark-guard.mjs";

const RUNTIME_TABLE_FIELDS = Object.freeze({
  all: Object.freeze(["允许域", "个性化规则"]),
  any: Object.freeze(["数字分身启用", "生产执行"])
});
const GROUP_RULES_TABLE_FIELDS = Object.freeze({
  all: Object.freeze(["启用", "群ID", "个性化规则"]),
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

function requireTableFields(fields, requirements) {
  const available = new Set(fields.filter((field) => typeof field === "string"));
  const missing = requirements.all.filter((field) => !available.has(field));
  const missingAlternative = requirements.any.length > 0 &&
    requirements.any.every((field) => !available.has(field));
  if (missing.length > 0 || missingAlternative) {
    throw new Error("Base console table is missing required fields");
  }
}

async function records(config, tableId, runner, fieldRequirements) {
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
    "--limit",
    "200",
    "--as",
    "user",
    "--format",
    "json"
  ];
  const result = await runner(argv);
  if (result.exit_code !== 0) throw new Error(`Base console read failed for ${tableId}`);
  const envelope = JSON.parse(result.stdout);
  const fields = envelope.data?.fields;
  const rows = envelope.data?.data;
  if (envelope.ok !== true || !Array.isArray(fields) || !Array.isArray(rows)) {
    throw new Error(`Base console returned an invalid record list for ${tableId}`);
  }
  requireTableFields(fields, fieldRequirements);
  return rows.map((row) => ({
    fields: Object.fromEntries(fields.map((field, index) => [field, row[index]]))
  }));
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

export async function loadBaseRuntimeSwitch(config, { runner = runLarkCommand } = {}) {
  if (!usesBaseConsole(config)) return localRuntimeSwitch(config);
  validateConsole(config);
  const runtimeRecords = await records(
    config,
    config.console.runtime_table,
    runner,
    RUNTIME_TABLE_FIELDS
  );
  return runtimeSwitch(runtimeRecords);
}

export function createBaseRuntimeSwitchRefresher(config, {
  runner = runLarkCommand,
  ttlMs = 10_000,
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
  ttlMs = 10_000,
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

export async function loadBaseConsole(config, { runner = runLarkCommand } = {}) {
  if (!usesBaseConsole(config)) return withLocalRuntimeSwitch(config);
  validateConsole(config);

  const [runtimeRecords, groupRuleRecords] = await Promise.all([
    records(config, config.console.runtime_table, runner, RUNTIME_TABLE_FIELDS),
    records(config, config.console.group_rules_table, runner, GROUP_RULES_TABLE_FIELDS)
  ]);
  const productionEnabled = runtimeSwitch(runtimeRecords);
  const fields = runtimeRecords[0].fields ?? {};
  const effectiveAllowedDomains = allowedDomains(fields, config.allowed_lark_domains);
  const authorityRules = lines(fields.个性化规则);
  const groupRules = groupRuleRecords.filter((record) => enabled(record.fields?.启用));

  return {
    ...config,
    production_enabled: productionEnabled,
    allowed_lark_domains: effectiveAllowedDomains,
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

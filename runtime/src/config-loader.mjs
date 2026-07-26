import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { OFFICIAL_LARK_BUSINESS_DOMAINS } from "../../shared/lark-capability-catalog.mjs";

export const INSTANCE_CONFIG_FIELDS = Object.freeze([
  "allowed_lark_domains",
  "authority_rules",
  "codex_bin",
  "codex_environment_root",
  "codex_timeout_ms",
  "console",
  "control",
  "daily_memory",
  "group_rules",
  "instance_id",
  "lark_cli_bin",
  "max_ai_action_rounds",
  "message_scope",
  "principal",
  "privacy",
  "production_data_approved",
  "production_enabled",
  "profile",
  "schedule",
  "schema_version",
  "supplement_lookback_minutes"
]);
const ROOT_FIELDS = new Set(INSTANCE_CONFIG_FIELDS);
const SECRET_FIELDS = new Set([
  "access_token",
  "api_key",
  "app_secret",
  "authorization",
  "client_secret",
  "cookie",
  "credentials",
  "oauth_token",
  "password",
  "refresh_token"
]);
const PRINCIPAL_FIELDS = new Set(["address_names", "name", "open_id", "timezone"]);
const CONSOLE_FIELDS = new Set([
  "base_token",
  "group_rules_table",
  "runtime_table"
]);
const CONTROL_FIELDS = new Set(["enabled", "mode"]);
const DAILY_MEMORY_FIELDS = new Set([
  "excluded_chat_ids",
  "excluded_topics",
  "folder_name",
  "folder_token"
]);
const GROUP_RULE_FIELDS = new Set(["chat_id", "rules"]);
const PRIVACY_FIELDS = new Set([
  "result_log_max_bytes",
  "result_log_retention_days",
  "signal_log_max_bytes",
  "signal_log_retention_days",
  "state_retention_days"
]);
const SCHEDULE_FIELDS = new Set([
  "daily_memory_hour",
  "daily_memory_minute",
  "quiet_interval_seconds",
  "work_interval_seconds",
  "workdays",
  "workday_end_hour",
  "workday_start_hour"
]);

function rejectSecretFields(value, location = "config") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, `${location}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) {
      throw new TypeError(`${location}.${key} is secret material and is not allowed`);
    }
    rejectSecretFields(child, `${location}.${key}`);
  }
}

function rejectUnknownFields(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${location}.${key} is unknown`);
  }
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function validateStringArray(value, name, { nonEmpty = false, unique = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${nonEmpty ? "a non-empty " : "an "}array`);
  }
  value.forEach((item, index) => requireText(item, `${name}[${index}]`));
  if (unique && new Set(value).size !== value.length) {
    throw new TypeError(`${name} must not contain duplicate values`);
  }
}

function validateOptionalInteger(value, name, minimum, maximum) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validateInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validateTimeZone(value, name) {
  requireText(value, name);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new TypeError(`${name} must be a valid IANA timezone`);
  }
}

function validatePrincipal(value) {
  const principal = requireObject(value, "config.principal");
  rejectUnknownFields(principal, PRINCIPAL_FIELDS, "config.principal");
  requireText(principal.name, "config.principal.name");
  requireText(principal.open_id, "config.principal.open_id");
  validateTimeZone(principal.timezone, "config.principal.timezone");
  if (principal.address_names !== undefined) {
    validateStringArray(principal.address_names, "config.principal.address_names");
  }
}

function validateSchedule(value) {
  const schedule = requireObject(value, "config.schedule");
  rejectUnknownFields(schedule, SCHEDULE_FIELDS, "config.schedule");
  validateInteger(schedule.workday_start_hour, "config.schedule.workday_start_hour", 0, 23);
  validateInteger(schedule.workday_end_hour, "config.schedule.workday_end_hour", 1, 24);
  if (schedule.workday_start_hour >= schedule.workday_end_hour) {
    throw new TypeError("config.schedule workday start must be before workday end");
  }
  validateInteger(schedule.work_interval_seconds, "config.schedule.work_interval_seconds", 30, 86400);
  validateInteger(schedule.quiet_interval_seconds, "config.schedule.quiet_interval_seconds", 30, 86400);
  validateInteger(schedule.daily_memory_hour, "config.schedule.daily_memory_hour", 0, 23);
  validateInteger(schedule.daily_memory_minute, "config.schedule.daily_memory_minute", 0, 59);
  if (schedule.workdays !== undefined) {
    if (!Array.isArray(schedule.workdays) || schedule.workdays.length === 0) {
      throw new TypeError("config.schedule.workdays must be a non-empty array");
    }
    schedule.workdays.forEach((workday, index) => {
      validateInteger(workday, `config.schedule.workdays[${index}]`, 1, 7);
    });
    if (new Set(schedule.workdays).size !== schedule.workdays.length) {
      throw new TypeError("config.schedule.workdays must not contain duplicate values");
    }
  }
}

function validateConsole(value) {
  const consoleConfig = requireObject(value, "config.console");
  rejectUnknownFields(consoleConfig, CONSOLE_FIELDS, "config.console");
  for (const field of ["base_token", "runtime_table", "group_rules_table"]) {
    requireText(consoleConfig[field], `config.console.${field}`);
  }
}

function validateControl(value) {
  const control = requireObject(value, "config.control");
  rejectUnknownFields(control, CONTROL_FIELDS, "config.control");
  if (!new Set(["local", "base"]).has(control.mode)) {
    throw new TypeError("config.control.mode must be local or base");
  }
  if (control.mode === "local") {
    if (typeof control.enabled !== "boolean") {
      throw new TypeError("config.control.enabled must be a boolean in local mode");
    }
  } else if (Object.hasOwn(control, "enabled")) {
    throw new TypeError("config.control.enabled is not allowed in base mode");
  }
}

function validateDailyMemory(value) {
  const dailyMemory = requireObject(value, "config.daily_memory");
  rejectUnknownFields(dailyMemory, DAILY_MEMORY_FIELDS, "config.daily_memory");
  requireText(dailyMemory.folder_token, "config.daily_memory.folder_token");
  requireText(dailyMemory.folder_name, "config.daily_memory.folder_name");
  if (dailyMemory.excluded_chat_ids !== undefined) {
    validateStringArray(
      dailyMemory.excluded_chat_ids,
      "config.daily_memory.excluded_chat_ids",
      { unique: true }
    );
  }
  if (dailyMemory.excluded_topics !== undefined) {
    validateStringArray(
      dailyMemory.excluded_topics,
      "config.daily_memory.excluded_topics",
      { unique: true }
    );
  }
}

function validatePrivacy(value) {
  const privacy = requireObject(value, "config.privacy");
  rejectUnknownFields(privacy, PRIVACY_FIELDS, "config.privacy");
  validateOptionalInteger(
    privacy.state_retention_days,
    "config.privacy.state_retention_days",
    1,
    30
  );
  validateOptionalInteger(
    privacy.result_log_retention_days,
    "config.privacy.result_log_retention_days",
    1,
    7
  );
  validateOptionalInteger(
    privacy.result_log_max_bytes,
    "config.privacy.result_log_max_bytes",
    65536,
    10 * 1024 * 1024
  );
  validateOptionalInteger(
    privacy.signal_log_retention_days,
    "config.privacy.signal_log_retention_days",
    1,
    7
  );
  validateOptionalInteger(
    privacy.signal_log_max_bytes,
    "config.privacy.signal_log_max_bytes",
    65536,
    1024 * 1024
  );
}

function validateGroupRules(value) {
  if (!Array.isArray(value)) throw new TypeError("config.group_rules must be an array");
  value.forEach((item, index) => {
    const location = `config.group_rules[${index}]`;
    const rule = requireObject(item, location);
    rejectUnknownFields(rule, GROUP_RULE_FIELDS, location);
    requireText(rule.chat_id, `${location}.chat_id`);
    validateStringArray(rule.rules, `${location}.rules`);
  });
}

export function validateInstanceConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("instance config must be an object");
  }
  rejectSecretFields(value);
  rejectUnknownFields(value, ROOT_FIELDS, "config");
  if (!new Set([1, 2]).has(value.schema_version)) {
    throw new TypeError("config.schema_version must be 1 or 2");
  }
  if (value.instance_id !== undefined) {
    requireText(value.instance_id, "config.instance_id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.instance_id)) {
      throw new TypeError("config.instance_id must be a portable logical identifier");
    }
  }
  requireText(value.profile, "config.profile");
  if (value.lark_cli_bin !== undefined) requireText(value.lark_cli_bin, "config.lark_cli_bin");
  if (!new Set(["bot_only", "internal_visible", "all_visible"]).has(value.message_scope)) {
    throw new TypeError(
      "config.message_scope must be bot_only, internal_visible, or all_visible"
    );
  }
  if (value.codex_bin !== undefined) requireText(value.codex_bin, "config.codex_bin");
  if (value.codex_environment_root !== undefined) {
    requireText(value.codex_environment_root, "config.codex_environment_root");
  }
  validateOptionalInteger(value.codex_timeout_ms, "config.codex_timeout_ms", 1000, 600000);
  validateOptionalInteger(value.max_ai_action_rounds, "config.max_ai_action_rounds", 1, 3);
  validateOptionalInteger(
    value.supplement_lookback_minutes,
    "config.supplement_lookback_minutes",
    1,
    1440
  );
  if (typeof value.production_data_approved !== "boolean") {
    throw new TypeError("config.production_data_approved must be a boolean");
  }
  if (value.schema_version === 1) {
    if (value.control !== undefined) {
      throw new TypeError("config.control is not allowed in schema version 1");
    }
    if (
      value.production_enabled !== undefined &&
      typeof value.production_enabled !== "boolean"
    ) {
      throw new TypeError("config.production_enabled must be a boolean");
    }
  } else {
    if (value.production_enabled !== undefined) {
      throw new TypeError("config.production_enabled is not allowed in schema version 2");
    }
    validateControl(value.control);
  }
  validatePrincipal(value.principal);
  validateSchedule(value.schedule);
  validateStringArray(value.allowed_lark_domains, "config.allowed_lark_domains", {
    nonEmpty: true,
    unique: true
  });
  value.allowed_lark_domains.forEach((domain, index) => {
    if (!OFFICIAL_LARK_BUSINESS_DOMAINS.includes(domain)) {
      throw new TypeError(
        `config.allowed_lark_domains[${index}] must be an official Lark business domain`
      );
    }
  });
  if (value.schema_version === 2) {
    if (value.control.mode === "base") {
      if (value.console === undefined) {
        throw new TypeError("config.console is required when config.control.mode is base");
      }
      if (!value.allowed_lark_domains.includes("base")) {
        throw new TypeError("config.allowed_lark_domains must include base in Base control mode");
      }
      if (value.authority_rules !== undefined) {
        throw new TypeError("config.authority_rules is not allowed when Base is the rule source");
      }
      if (value.group_rules !== undefined) {
        throw new TypeError("config.group_rules is not allowed when Base is the rule source");
      }
    } else if (value.console !== undefined) {
      throw new TypeError("config.console is only allowed when config.control.mode is base");
    }
  }
  if (value.console !== undefined) validateConsole(value.console);
  if (value.daily_memory !== undefined) {
    validateDailyMemory(value.daily_memory);
  }
  if (value.privacy !== undefined) validatePrivacy(value.privacy);
  if (value.group_rules !== undefined) validateGroupRules(value.group_rules);
  if (value.authority_rules !== undefined) {
    validateStringArray(value.authority_rules, "config.authority_rules");
  }
  return structuredClone(value);
}

export async function loadInstanceConfig(configPath) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
    throw new TypeError("an absolute instance config path is required");
  }
  const metadata = await lstat(configPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError("instance config must be a regular file");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new TypeError("instance config must not be accessible by group or other users");
  }
  let value;
  try {
    value = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("instance config must contain valid JSON");
    throw error;
  }
  return validateInstanceConfig(value);
}

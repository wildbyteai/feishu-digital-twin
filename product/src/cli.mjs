import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  INSTALLATION_SCHEMA_VERSION,
  ProductError,
  activeVersionRoot,
  ensurePrivateDirectory,
  installVersion,
  readInstallation,
  removeInstalledRuntime,
  requireInstanceName,
  resolveInside,
  resolveProductRoot,
  serviceLabels,
  validateInstalledVersion,
  writeLauncher,
  writePrivateJson
} from "./installation.mjs";
import {
  installServices,
  restartServices,
  runServiceRole,
  serviceStatus,
  startServices,
  stopServices,
  uninstallServices
} from "./service-host.mjs";
import {
  loadInstanceConfig,
  validateInstanceConfig
} from "../../runtime/src/config-loader.mjs";
import {
  loadBaseConsole,
  loadBaseRuntimeSwitch
} from "../../runtime/src/base-console.mjs";
import { CodexInferenceAdapter } from "../../runtime/src/inference-adapter.mjs";
import { buildLarkEnvironment } from "../../shared/subprocess-environment.mjs";
import {
  LARK_CAPABILITY_CATALOG,
  OFFICIAL_LARK_BUSINESS_DOMAINS,
  larkDomainsForCapabilities
} from "../../shared/lark-capability-catalog.mjs";

const VALUE_OPTIONS = new Set([
  "--root",
  "--launch-agents-dir",
  "--launchctl-bin",
  "--source",
  "--instance",
  "--config",
  "--lark-cli",
  "--codex-bin",
  "--codex-environment-root",
  "--profile",
  "--principal-name",
  "--principal-aliases",
  "--timezone",
  "--message-scope",
  "--capabilities",
  "--domains",
  "--console-base-token",
  "--console-runtime-table",
  "--console-group-rules-table",
  "--knowledge-space-name",
  "--knowledge-space-id",
  "--knowledge-direction",
  "--daily-memory-folder-token",
  "--daily-memory-folder-name",
  "--candidate-version",
]);
const FLAG_OPTIONS = new Set([
  "--help",
  "-h",
  "--version",
  "--no-start",
  "--restart",
  "--purge",
  "--approve-production-data",
  "--approve-message-scope"
]);
const PACKAGE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MESSAGE_SCOPE_RANK = Object.freeze({
  bot_only: 0,
  internal_visible: 1,
  all_visible: 2
});

export const HELP = `feishu-digital-twin <command>

Commands:
  init                              initialize a private local instance
  profiles                          list lark-cli profiles without changing the active profile
  setup                             safely configure and start a local instance
  configure                         validate and activate a private instance configuration
  config update                     atomically update instance configuration while frozen
  doctor                            check the local runtime without printing secrets
  status                            show runtime and service status
  freeze                            stop automatic processing without removing services
  resume                            resume automatic processing
  control <enable|freeze|upgrade|rollback|uninstall>
  service <install|start|stop|restart|status|uninstall>
  upgrade [--source PACKAGE_ROOT] [--restart]
                                    install and activate a new verified version
  rollback [--restart]              switch back to the previous verified version
  uninstall [--purge]               remove services and runtime; keep private data by default

Global options:
  --root PATH                       private installation root
  --launch-agents-dir PATH          override the macOS LaunchAgents directory
  --launchctl-bin PATH              override launchctl for isolated tests
  --config PATH                     candidate private instance configuration
  --lark-cli PATH                   lark-cli executable for setup or configure
  --codex-bin PATH                  Codex executable for setup or configure
  --codex-environment-root PATH     absolute private Codex environment for setup or configure
  --profile NAME                    lark-cli profile for guided setup
  --principal-name NAME             override the discovered principal display name
  --principal-aliases LIST          comma-separated names used to address the principal
  --timezone IANA_NAME              principal timezone for guided setup
  --message-scope SCOPE             guided setup scope; defaults to bot_only
  --capabilities LIST               comma-separated product capabilities mapped to Lark domains
  --domains LIST                    comma-separated Lark domains; defaults to im
  --console-base-token TOKEN        existing control Base token
  --console-runtime-table NAME      existing runtime configuration table name or ID
  --console-group-rules-table NAME  existing group rules table name or ID
  --knowledge-space-name NAME       existing enterprise knowledge space name
  --knowledge-space-id SPACE_ID     existing enterprise knowledge space ID
  --knowledge-direction TEXT        business direction for the knowledge space
  --daily-memory-folder-token TOKEN existing daily-memory Drive folder token
  --daily-memory-folder-name NAME   existing daily-memory Drive folder name
  --approve-production-data         approve the configured Codex environment for business data
  --approve-message-scope           approve a new or broader non-bot-only message scope
`;

const GUIDED_RESOURCE_OPTION_GROUPS = Object.freeze({
  console: Object.freeze([
    "console_base_token",
    "console_runtime_table",
    "console_group_rules_table"
  ]),
  enterprise_knowledge: Object.freeze([
    "knowledge_space_name",
    "knowledge_space_id",
    "knowledge_direction"
  ]),
  daily_memory: Object.freeze([
    "daily_memory_folder_token",
    "daily_memory_folder_name"
  ])
});
const GUIDED_RESOURCE_OPTIONS = Object.freeze([
  "principal_aliases",
  ...Object.values(GUIDED_RESOURCE_OPTION_GROUPS).flat()
]);

function parseArguments(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (VALUE_OPTIONS.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new ProductError("MISSING_OPTION_VALUE", `${argument} requires a value`);
      }
      options[argument.slice(2).replaceAll("-", "_")] = value;
      index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(argument)) {
      const name = argument === "-h"
        ? "help"
        : argument.replace(/^-+/u, "").replaceAll("-", "_");
      options[name] = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new ProductError("UNKNOWN_OPTION", "unknown command option");
    }
    positionals.push(argument);
  }
  return { options, positionals };
}

function printJson(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function commandResult(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new ProductError("LOCAL_COMMAND_FAILED", "a local runtime command failed");
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new ProductError("INVALID_LOCAL_OUTPUT", "a local runtime command returned invalid output");
  }
}

function runtimeCommand(root, installation, command) {
  const entry = path.join(
    activeVersionRoot(root, installation),
    "runtime/bin/feishu-digital-twin-runtime.mjs"
  );
  const state = resolveInside(root, installation.state_database, "state_database");
  return commandResult(process.execPath, [entry, command, state]);
}

async function regularPrivateFile(filename) {
  try {
    const metadata = await lstat(filename);
    return {
      present: metadata.isFile() && !metadata.isSymbolicLink(),
      private: metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, private: false };
    throw error;
  }
}

async function pathExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function check(status, code, extra = {}) {
  return { status, code, ...extra };
}

function optionPath(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new ProductError(
      "CONFIGURE_OPTIONS_REQUIRED",
      `--${name.replaceAll("_", "-")} must be an absolute path`
    );
  }
  return value;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function candidateConfigPath(options, packageRoot) {
  if (typeof options.config !== "string") {
    throw new ProductError("CONFIGURE_OPTIONS_REQUIRED", "a candidate --config is required");
  }
  const candidate = path.resolve(options.config);
  let packageLocation = path.resolve(packageRoot);
  let candidateLocation = candidate;
  try {
    [packageLocation, candidateLocation] = await Promise.all([
      realpath(packageLocation),
      realpath(candidateLocation)
    ]);
  } catch {
    // ConfigLoader will return the stable invalid-config error for unreadable candidates.
  }
  if (
    isInside(path.resolve(packageRoot), candidate) ||
    isInside(packageLocation, candidateLocation)
  ) {
    throw new ProductError(
      "UNSAFE_CONFIG_LOCATION",
      "candidate instance configuration must be stored outside the product source tree"
    );
  }
  return candidate;
}

async function loadSetupCandidateFile(options, packageRoot) {
  const candidatePath = await candidateConfigPath(options, packageRoot);
  let candidate;
  try {
    candidate = await loadInstanceConfig(candidatePath);
  } catch {
    throw new ProductError("INVALID_INSTANCE_CONFIG", "candidate instance configuration is invalid");
  }
  if (!Object.hasOwn(candidate, "message_scope")) {
    throw new ProductError(
      "MESSAGE_SCOPE_CONFIRMATION_REQUIRED",
      "setup requires an explicit bot_only, internal_visible, or all_visible message_scope"
    );
  }
  return { candidatePath, candidate };
}

function requiredOptionText(value, option) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProductError(
      "CONFIGURE_OPTIONS_REQUIRED",
      `${option} requires a non-empty value`
    );
  }
  return value.trim();
}

function optionLabel(name) {
  return `--${name.replaceAll("_", "-")}`;
}

function presentOptionNames(options, names) {
  return names.filter((name) => options[name] !== undefined);
}

function validateGuidedResourceOptions(options) {
  const guidedOptions = presentOptionNames(options, GUIDED_RESOURCE_OPTIONS);
  if (options.config !== undefined && guidedOptions.length > 0) {
    throw new ProductError(
      "SETUP_CONFIG_OPTION_CONFLICT",
      "--config cannot be combined with guided resource options",
      { conflicting_options: guidedOptions.map(optionLabel) }
    );
  }
  for (const [group, names] of Object.entries(GUIDED_RESOURCE_OPTION_GROUPS)) {
    const present = presentOptionNames(options, names);
    if (present.length > 0 && present.length !== names.length) {
      throw new ProductError(
        "INCOMPLETE_GUIDED_RESOURCE_GROUP",
        "guided resource options must be supplied as a complete group",
        {
          resource_group: group,
          missing_options: names.filter((name) => !present.includes(name)).map(optionLabel)
        }
      );
    }
  }
  const consoleSelected = presentOptionNames(
    options,
    GUIDED_RESOURCE_OPTION_GROUPS.console
  ).length > 0;
  const knowledgeSelected = presentOptionNames(
    options,
    GUIDED_RESOURCE_OPTION_GROUPS.enterprise_knowledge
  ).length > 0;
  if (consoleSelected && knowledgeSelected) {
    throw new ProductError(
      "BASE_RULE_SOURCE_CONFLICT",
      "when the control Base is selected, maintain enterprise knowledge routing in its personalized rules"
    );
  }
}

function guidedPrincipalAliases(value) {
  if (value === undefined) return null;
  const source = requiredOptionText(value, "--principal-aliases");
  const aliases = source.split(",").map((item) => item.trim());
  if (aliases.some((item) => item.length === 0) || new Set(aliases).size !== aliases.length) {
    throw new ProductError(
      "INVALID_INSTANCE_CONFIG",
      "--principal-aliases must contain a unique comma-separated name list"
    );
  }
  return aliases;
}

function enterpriseKnowledgeRule(options) {
  return [
    `企业知识库：${requiredOptionText(options.knowledge_space_name, "--knowledge-space-name")}`,
    `space_id=${requiredOptionText(options.knowledge_space_id, "--knowledge-space-id")}`,
    `适用于${requiredOptionText(options.knowledge_direction, "--knowledge-direction")}`
  ].join("；");
}

function addGuidedCapabilityDomains(candidate, capability) {
  candidate.allowed_lark_domains = [...new Set([
    ...(candidate.allowed_lark_domains ?? []),
    ...larkDomainsForCapabilities([capability])
  ])];
}

function configuredResourceCapabilities(candidate) {
  const capabilities = [];
  if (candidate.console) capabilities.push("console");
  if (knowledgeReferences(candidate).length > 0) capabilities.push("enterprise_knowledge");
  if (candidate.daily_memory) capabilities.push("daily_memory");
  return capabilities;
}

function addConfiguredResourceDomains(candidate) {
  for (const capability of configuredResourceCapabilities(candidate)) {
    addGuidedCapabilityDomains(candidate, capability);
  }
  return candidate;
}

function applyGuidedResourceOptions(candidate, options) {
  const aliases = guidedPrincipalAliases(options.principal_aliases);
  if (aliases !== null) {
    candidate.principal.address_names = [...new Set([
      candidate.principal.name,
      ...aliases
    ])];
  }

  if (options.console_base_token !== undefined) {
    if (
      (candidate.authority_rules?.length ?? 0) > 0 ||
      (candidate.group_rules?.length ?? 0) > 0
    ) {
      throw new ProductError(
        "BASE_RULE_SOURCE_CONFLICT",
        "selecting the control Base requires personalized and group rules to be maintained in Base"
      );
    }
    candidate.console = {
      base_token: requiredOptionText(options.console_base_token, "--console-base-token"),
      runtime_table: requiredOptionText(
        options.console_runtime_table,
        "--console-runtime-table"
      ),
      group_rules_table: requiredOptionText(
        options.console_group_rules_table,
        "--console-group-rules-table"
      )
    };
    candidate.control = { mode: "base" };
    addGuidedCapabilityDomains(candidate, "console");
  }

  if (options.knowledge_space_name !== undefined) {
    if (candidate.control?.mode === "base") {
      throw new ProductError(
        "BASE_RULE_SOURCE_CONFLICT",
        "when the control Base is selected, maintain enterprise knowledge routing in its personalized rules"
      );
    }
    const rule = enterpriseKnowledgeRule(options);
    candidate.authority_rules = [...new Set([
      ...(candidate.authority_rules ?? []),
      rule
    ])];
    addGuidedCapabilityDomains(candidate, "enterprise_knowledge");
  }

  if (options.daily_memory_folder_token !== undefined) {
    candidate.daily_memory = {
      folder_token: requiredOptionText(
        options.daily_memory_folder_token,
        "--daily-memory-folder-token"
      ),
      folder_name: requiredOptionText(
        options.daily_memory_folder_name,
        "--daily-memory-folder-name"
      ),
      excluded_chat_ids: candidate.daily_memory?.excluded_chat_ids ?? [],
      excluded_topics: candidate.daily_memory?.excluded_topics ?? []
    };
    addGuidedCapabilityDomains(candidate, "daily_memory");
  }
  return addConfiguredResourceDomains(candidate);
}

function guidedDomains(value) {
  if (value === undefined) return ["im"];
  const domains = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (domains.length === 0 || new Set(domains).size !== domains.length) {
    throw new ProductError(
      "INVALID_INSTANCE_CONFIG",
      "--domains must contain a unique comma-separated domain list"
    );
  }
  const unknownDomains = domains.filter(
    (domain) => !OFFICIAL_LARK_BUSINESS_DOMAINS.includes(domain)
  );
  if (unknownDomains.length > 0) {
    throw new ProductError(
      "UNKNOWN_LARK_DOMAIN",
      "--domains contains an unknown or reserved Lark domain",
      { unknown_domains: unknownDomains }
    );
  }
  return domains;
}

function guidedCapabilities(value) {
  const capabilities = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
    throw new ProductError(
      "INVALID_INSTANCE_CONFIG",
      "--capabilities must contain a unique comma-separated capability list"
    );
  }
  const unknownCapabilities = capabilities.filter(
    (capability) => !Object.hasOwn(LARK_CAPABILITY_CATALOG.capabilities, capability)
  );
  if (unknownCapabilities.length > 0) {
    throw new ProductError(
      "UNKNOWN_CAPABILITY",
      "--capabilities contains an unknown product capability",
      { unknown_capabilities: unknownCapabilities }
    );
  }
  return larkDomainsForCapabilities(capabilities);
}

function guidedAllowedDomains(options) {
  return options.capabilities === undefined
    ? guidedDomains(options.domains)
    : guidedCapabilities(options.capabilities);
}

function requireMessageScopeApproval(candidate, current, options) {
  if (!Object.hasOwn(candidate, "message_scope")) {
    throw new ProductError(
      "MESSAGE_SCOPE_CONFIRMATION_REQUIRED",
      "configuration requires an explicit bot_only, internal_visible, or all_visible message_scope"
    );
  }
  const candidateRank = MESSAGE_SCOPE_RANK[candidate.message_scope];
  const currentRank = current ? MESSAGE_SCOPE_RANK[current.message_scope] : undefined;
  const expandsVisibility = currentRank === undefined
    ? candidateRank > MESSAGE_SCOPE_RANK.bot_only
    : candidateRank > currentRank;
  if (expandsVisibility && options.approve_message_scope !== true) {
    throw new ProductError(
      "MESSAGE_SCOPE_APPROVAL_REQUIRED",
      "use --approve-message-scope to approve an initial or broader non-bot-only message scope"
    );
  }
}

async function requireEmptyUninitializedRoot(root) {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new ProductError("PRIVATE_ROOT_SYMLINK", "private installation directories cannot be symlinks");
  }
  if (!metadata.isDirectory()) {
    throw new ProductError("PRIVATE_ROOT_NOT_DIRECTORY", "private installation path must be a directory");
  }
  if ((await readdir(root)).length > 0) {
    throw new ProductError(
      "NONEMPTY_PRODUCT_ROOT",
      "an uninitialized product root must be empty"
    );
  }
  return true;
}

async function resolveExecutableFile(command, environment, {
  code = "LARK_CLI_INVALID",
  label = "lark-cli"
} = {}) {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ProductError(code, `${label} must resolve to an executable regular file`);
  }
  const candidates = path.isAbsolute(command) || command.includes(path.sep)
    ? [path.resolve(command)]
    : String(environment.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      const metadata = await lstat(resolved);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      await access(resolved, fsConstants.X_OK);
      return resolved;
    } catch {
      // Continue searching without exposing local filesystem details.
    }
  }
  throw new ProductError(code, `${label} must resolve to an executable regular file`);
}

function profileName(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const field of ["name", "profile", "profileName", "profile_name"]) {
    if (typeof value[field] === "string" && value[field].trim().length > 0) {
      return value[field].trim();
    }
  }
  return "";
}

function parseProfileList(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    throw new ProductError(
      "LARK_PROFILE_LIST_INVALID_OUTPUT",
      "lark-cli profile list returned invalid structured output"
    );
  }
  const raw = Array.isArray(envelope)
    ? envelope
    : envelope?.profiles ?? envelope?.data?.profiles ?? envelope?.data?.items ?? envelope?.items;
  if (!Array.isArray(raw)) {
    throw new ProductError(
      "LARK_PROFILE_LIST_INVALID_OUTPUT",
      "lark-cli profile list returned an unsupported result"
    );
  }
  const profiles = raw.map(profileName).filter(Boolean);
  if (new Set(profiles).size !== profiles.length) {
    throw new ProductError(
      "LARK_PROFILE_LIST_INVALID_OUTPUT",
      "lark-cli profile list returned duplicate profiles"
    );
  }
  return profiles;
}

async function availableProfiles(options, environment) {
  const binary = await resolveExecutableFile(options.lark_cli ?? "lark-cli", environment);
  const result = spawnSync(binary, ["profile", "list"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: buildLarkEnvironment(environment)
  });
  if (result.error || result.status !== 0) {
    throw new ProductError(
      "LARK_PROFILE_LIST_FAILED",
      "lark-cli profiles could not be listed"
    );
  }
  const profiles = parseProfileList(result.stdout);
  return { count: profiles.length, profiles };
}

async function selectOnlyAvailableProfile(options, environment) {
  const { profiles } = await availableProfiles(options, environment);
  if (profiles.length === 0) {
    throw new ProductError(
      "LARK_PROFILE_NOT_FOUND",
      "no lark-cli profile is available; complete the official CLI setup first"
    );
  }
  if (profiles.length > 1) {
    throw new ProductError(
      "LARK_PROFILE_SELECTION_REQUIRED",
      "multiple lark-cli profiles are available; choose one and pass --profile",
      { available_profiles: profiles }
    );
  }
  return profiles[0];
}

async function resolveCodexEnvironment(directory) {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid directory");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("directory is not private");
    }
    return await realpath(directory);
  } catch {
    throw new ProductError(
      "CODEX_ENVIRONMENT_INVALID",
      "the Codex environment must be a private regular directory"
    );
  }
}

async function resolveCodexConfiguration({ codexBin, codexEnvironmentRoot }, environment) {
  const resolvedCodex = await resolveExecutableFile(codexBin, environment, {
    code: "CODEX_EXECUTABLE_INVALID",
    label: "Codex executable"
  });
  const resolvedEnvironment = await resolveCodexEnvironment(codexEnvironmentRoot);
  return {
    codex_bin: resolvedCodex,
    codex_environment_root: resolvedEnvironment
  };
}

async function materializeConfiguredCandidate(candidate, options, environment, {
  current = null
} = {}) {
  const codexBin = options.codex_bin ?? current?.codex_bin ?? candidate.codex_bin;
  if (typeof codexBin !== "string" || codexBin.trim().length === 0) {
    throw new ProductError(
      "CONFIGURE_OPTIONS_REQUIRED",
      "--codex-bin or config.codex_bin is required"
    );
  }
  const codexEnvironmentRoot = options.codex_environment_root ??
    current?.codex_environment_root ?? candidate.codex_environment_root;
  if (typeof codexEnvironmentRoot !== "string" || !path.isAbsolute(codexEnvironmentRoot)) {
    throw new ProductError(
      "CONFIGURE_OPTIONS_REQUIRED",
      "--codex-environment-root or config.codex_environment_root must be an absolute path"
    );
  }
  const codexConfiguration = await resolveCodexConfiguration({
    codexBin,
    codexEnvironmentRoot
  }, environment);
  if (current && (
    codexConfiguration.codex_bin !== current.codex_bin ||
    codexConfiguration.codex_environment_root !== current.codex_environment_root
  )) {
    throw new ProductError(
      "CODEX_ENVIRONMENT_CHANGE_REQUIRES_NEW_INSTANCE",
      "Codex executable or environment root changes require a new instance"
    );
  }
  const configured = {
    ...candidate,
    ...codexConfiguration,
    production_data_approved: current
      ? current.production_data_approved === true || options.approve_production_data === true
      : options.approve_production_data === true
  };
  configured.lark_cli_bin = await resolveExecutableFile(
    options.lark_cli ?? configured.lark_cli_bin ?? current?.lark_cli_bin ?? "lark-cli",
    environment
  );
  const codexDoctor = await new CodexInferenceAdapter({
    codexBin: configured.codex_bin,
    codexEnvironmentRoot: configured.codex_environment_root,
    timeoutMs: configured.codex_timeout_ms ?? 120000
  }).doctor();
  if (codexDoctor.ok !== true) {
    throw new ProductError("CODEX_DOCTOR_FAILED", "the configured Codex environment is not ready");
  }
  const lark = larkAuthDoctor(
    configured.lark_cli_bin,
    configured.profile,
    environment
  );
  if (
    lark.auth.status !== "pass" ||
    lark.user.status !== "pass" ||
    lark.bot.status !== "pass"
  ) {
    throw new ProductError("LARK_AUTH_NOT_READY", "the configured Feishu identities are not ready");
  }
  return configured;
}

function positiveIdentityStatus(value) {
  if (value === true) return true;
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return !/(?:unavailable|missing|invalid|expired|error|not[ _-]?configured|logged[ _-]?out|none)/iu
    .test(value);
}

function identityReady(identity, { requireToken = false } = {}) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  if (identity.available === false || !positiveIdentityStatus(identity.status)) return false;
  if (!requireToken) return true;
  return positiveIdentityStatus(identity.tokenStatus ?? identity.token_status);
}

function inspectLarkAuth(binary, profile, environment) {
  const result = spawnSync(binary, [
    "--profile",
    profile,
    "auth",
    "status",
    "--json",
    "--verify"
  ], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: buildLarkEnvironment(environment)
  });
  if (result.error || result.status !== 0) {
    return { ok: false, code: "LARK_AUTH_COMMAND_FAILED" };
  }
  let envelope;
  try {
    envelope = JSON.parse(result.stdout.trim());
  } catch {
    return { ok: false, code: "LARK_AUTH_INVALID_OUTPUT" };
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    envelope.ok === false
  ) {
    return { ok: false, code: "LARK_AUTH_NOT_READY" };
  }
  const verified = envelope.verified ?? envelope.data?.verified;
  if (verified !== true) return { ok: false, code: "LARK_AUTH_UNVERIFIED" };
  const identities = envelope.identities ?? envelope.data?.identities;
  return { ok: true, identities };
}

function larkAuthDoctor(binary, profile, environment) {
  const inspection = inspectLarkAuth(binary, profile, environment);
  if (!inspection.ok) {
    return {
      auth: check("fail", inspection.code),
      user: check("fail", "NOT_CHECKED"),
      bot: check("fail", "NOT_CHECKED")
    };
  }
  const { identities } = inspection;
  return {
    auth: check("pass", "READY"),
    user: identityReady(identities?.user, { requireToken: true })
      ? check("pass", "READY")
      : check("fail", "LARK_USER_UNAVAILABLE"),
    bot: identityReady(identities?.bot)
      ? check("pass", "READY")
      : check("fail", "LARK_BOT_UNAVAILABLE")
  };
}

function runLarkReadCommand(argv, environment) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: buildLarkEnvironment(environment)
  });
  return {
    exit_code: result.error ? 1 : result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function larkJson(binary, profile, args, environment) {
  const result = runLarkReadCommand([binary, "--profile", profile, ...args], environment);
  if (result.exit_code !== 0) return null;
  try {
    const envelope = JSON.parse(result.stdout.trim());
    return envelope && typeof envelope === "object" && !Array.isArray(envelope) &&
      envelope.ok !== false
      ? envelope
      : null;
  } catch {
    return null;
  }
}

function nestedObjects(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) nestedObjects(item, result);
    return result;
  }
  result.push(value);
  for (const child of Object.values(value)) nestedObjects(child, result);
  return result;
}

function objectText(value, fields) {
  for (const field of fields) {
    if (typeof value?.[field] === "string" && value[field].trim().length > 0) {
      return value[field].trim();
    }
  }
  return null;
}

function labeledRuleValue(rule, labelPattern, { identifier = false } = {}) {
  const label = new RegExp(`(?:${labelPattern})\\s*[:：=]\\s*`, "iu").exec(rule);
  if (!label) return null;
  const source = rule.slice(label.index + label[0].length).trimStart();
  if (!source) return null;
  const quotePairs = new Map([
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["‘", "’"]
  ]);
  const closingQuote = quotePairs.get(source[0]);
  if (closingQuote) {
    const end = source.indexOf(closingQuote, 1);
    return end > 1 ? source.slice(1, end).trim() || null : null;
  }

  const separator = identifier
    ? /[\s,，;；|。\r\n]/u
    : /[,，;；|。\r\n]/u;
  let end = source.search(separator);
  if (!identifier) {
    const nextSpaceId = /\s+space_id\s*[:：=]/iu.exec(source);
    if (nextSpaceId && (end < 0 || nextSpaceId.index < end)) end = nextSpaceId.index;
  }
  const value = source.slice(0, end < 0 ? undefined : end).trim();
  return value || null;
}

function knowledgeReferences(config) {
  const references = [];
  for (const rule of config.authority_rules ?? []) {
    if (typeof rule !== "string") continue;
    const name = labeledRuleValue(rule, "企业知识库|知识空间|空间名称");
    const spaceId = labeledRuleValue(rule, "\\bspace_id\\b", { identifier: true });
    if (!name || !spaceId) continue;
    references.push({ name, spaceId });
  }
  return references.filter((reference, index) => references.findIndex((candidate) =>
    candidate.name === reference.name && candidate.spaceId === reference.spaceId
  ) === index);
}

function configuredResourceDomainsReady(config) {
  const allowedDomains = new Set(config.allowed_lark_domains ?? []);
  return configuredResourceCapabilities(config).every((capability) =>
    larkDomainsForCapabilities([capability]).every((domain) => allowedDomains.has(domain))
  );
}

async function larkResourcesDoctor(config, environment) {
  const configuredReferences = knowledgeReferences(config);
  if (!config.console && configuredReferences.length === 0 && !config.daily_memory) {
    return check("pass", "NOT_CONFIGURED");
  }
  try {
    if (!configuredResourceDomainsReady(config)) {
      throw new Error("configured Lark resources exceed the allowed domain ceiling");
    }
    let effectiveConfig = config;
    if (config.console) {
      effectiveConfig = await loadBaseConsole(config, {
        runner: (argv) => runLarkReadCommand(argv, environment)
      });
      if (
        typeof effectiveConfig.production_enabled !== "boolean" ||
        !Array.isArray(effectiveConfig.allowed_lark_domains)
      ) {
        throw new Error("invalid Base control resource");
      }
    }
    if (!configuredResourceDomainsReady(effectiveConfig)) {
      throw new Error("effective Lark resources exceed the allowed domain ceiling");
    }

    const references = knowledgeReferences(effectiveConfig);
    if (references.length > 0) {
      const envelope = larkJson(config.lark_cli_bin ?? "lark-cli", config.profile, [
        "wiki", "+space-list",
        "--as", "user",
        "--page-all",
        "--page-limit", "0",
        "--format", "json"
      ], environment);
      const spaces = nestedObjects(envelope);
      const valid = envelope !== null && references.every((reference) => spaces.some((space) =>
        objectText(space, ["space_id", "spaceId", "id"]) === reference.spaceId &&
        objectText(space, ["name", "space_name", "spaceName", "title"]) === reference.name
      ));
      if (!valid) throw new Error("invalid Wiki resource");
    }

    if (config.daily_memory) {
      const envelope = larkJson(config.lark_cli_bin ?? "lark-cli", config.profile, [
        "drive", "files", "list",
        "--params", JSON.stringify({
          folder_token: config.daily_memory.folder_token,
          page_size: 1
        }),
        "--as", "user",
        "--format", "json"
      ], environment);
      if (envelope?.ok !== true) throw new Error("invalid Drive folder resource");
    }
    return check("pass", "READY");
  } catch {
    return check("fail", "LARK_RESOURCES_UNAVAILABLE");
  }
}

function validateGuidedCandidate(candidate) {
  try {
    return validateInstanceConfig(candidate);
  } catch {
    throw new ProductError(
      "INVALID_INSTANCE_CONFIG",
      "guided setup options produced an invalid private instance configuration"
    );
  }
}

async function discoverGuidedPrincipal({
  options,
  environment,
  profile,
  fallbackLarkBinary
}) {
  const larkBinary = await resolveExecutableFile(
    options.lark_cli ?? fallbackLarkBinary ?? "lark-cli",
    environment
  );
  const inspection = inspectLarkAuth(larkBinary, profile, environment);
  const user = inspection.identities?.user;
  const bot = inspection.identities?.bot;
  if (
    !inspection.ok ||
    !identityReady(user, { requireToken: true }) ||
    !identityReady(bot)
  ) {
    throw new ProductError(
      "LARK_AUTH_NOT_READY",
      "the selected lark-cli profile must have verified user and bot identities"
    );
  }
  const principalName = user.userName ?? user.user_name ??
    user.displayName ?? user.display_name ?? user.name;
  const principalOpenId = user.openId ?? user.open_id;
  if (
    typeof principalName !== "string" || principalName.trim().length === 0 ||
    typeof principalOpenId !== "string" || principalOpenId.trim().length === 0
  ) {
    throw new ProductError(
      "LARK_PRINCIPAL_DISCOVERY_FAILED",
      "the selected lark-cli profile did not expose a principal name and open_id"
    );
  }
  return {
    larkBinary,
    name: principalName.trim(),
    openId: principalOpenId.trim()
  };
}

async function guidedSetupCandidate(options, environment, { current = null } = {}) {
  if (current) {
    const candidate = structuredClone(current);
    const profile = options.profile === undefined
      ? current.profile
      : requiredOptionText(options.profile, "--profile");
    if (options.profile !== undefined || options.lark_cli !== undefined) {
      const discovered = await discoverGuidedPrincipal({
        options,
        environment,
        profile,
        fallbackLarkBinary: current.lark_cli_bin
      });
      if (discovered.openId !== current.principal.open_id) {
        throw new ProductError(
          "PRINCIPAL_CHANGE_REQUIRES_NEW_INSTANCE",
          "changing the principal user identity requires a new instance"
        );
      }
      candidate.profile = profile;
      candidate.lark_cli_bin = discovered.larkBinary;
      if (options.principal_name === undefined) candidate.principal.name = discovered.name;
    }
    if (options.principal_name !== undefined) {
      candidate.principal.name = requiredOptionText(
        options.principal_name,
        "--principal-name"
      );
    }
    if (options.timezone !== undefined) {
      candidate.principal.timezone = requiredOptionText(options.timezone, "--timezone");
    }
    candidate.principal.address_names = [...new Set([
      candidate.principal.name,
      ...(candidate.principal.address_names ?? [])
    ])];
    if (options.message_scope !== undefined) {
      candidate.message_scope = options.message_scope;
    }
    if (options.domains !== undefined || options.capabilities !== undefined) {
      candidate.allowed_lark_domains = guidedAllowedDomains(options);
    }
    return validateGuidedCandidate(applyGuidedResourceOptions(candidate, options));
  }

  const profile = options.profile === undefined
    ? await selectOnlyAvailableProfile(options, environment)
    : requiredOptionText(options.profile, "--profile");
  const timezone = options.timezone === undefined
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : requiredOptionText(options.timezone, "--timezone");
  const discovered = await discoverGuidedPrincipal({
    options,
    environment,
    profile
  });
  const principalName = options.principal_name === undefined
    ? discovered.name
    : requiredOptionText(options.principal_name, "--principal-name");
  const candidate = {
    schema_version: 2,
    profile,
    lark_cli_bin: discovered.larkBinary,
    message_scope: options.message_scope ?? "bot_only",
    codex_bin: options.codex_bin ?? "codex",
    codex_environment_root: optionPath(options, "codex_environment_root"),
    production_data_approved: false,
    control: {
      mode: "local",
      enabled: true
    },
    principal: {
      name: principalName,
      open_id: discovered.openId,
      timezone,
      address_names: [principalName]
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
    privacy: {
      state_retention_days: 7,
      result_log_retention_days: 3,
      result_log_max_bytes: 1048576,
      signal_log_retention_days: 3,
      signal_log_max_bytes: 262144
    },
    allowed_lark_domains: guidedAllowedDomains(options)
  };
  return validateGuidedCandidate(applyGuidedResourceOptions(candidate, options));
}

function nodeVersionSupported() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

async function init(root, packageRoot, options) {
  const existing = await readInstallation(root, { required: false });
  if (existing) {
    const state = runtimeCommand(root, existing, "state");
    return {
      status: "already-initialized",
      active_version: existing.active_version,
      frozen: state.frozen === true
    };
  }
  await requireEmptyUninitializedRoot(root);
  const instance = requireInstanceName(options.instance ?? "default");
  const sourceRoot = path.resolve(options.source ?? packageRoot);
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(path.join(root, "private"));
  await ensurePrivateDirectory(path.join(root, "private/logs"));
  const installed = await installVersion({ sourceRoot, installationRoot: root });
  const installation = {
    schema_version: INSTALLATION_SCHEMA_VERSION,
    instance,
    active_version: installed.version,
    previous_version: null,
    state_format: installed.state_format,
    config_path: "private/config.json",
    state_database: "private/state.sqlite",
    services: serviceLabels(instance),
  };
  const versionRoot = activeVersionRoot(root, installation);
  const statePath = resolveInside(root, installation.state_database, "state_database");
  commandResult(process.execPath, [
    path.join(versionRoot, "runtime/bin/feishu-digital-twin-runtime.mjs"),
    "freeze",
    statePath
  ]);
  await chmod(statePath, 0o600);
  await writeLauncher(root);
  await writePrivateJson(path.join(root, "installation.json"), installation);
  return { status: "initialized", active_version: installed.version, frozen: true };
}

async function configure(root, packageRoot, options, environment) {
  const installation = await readInstallation(root);
  const candidatePath = await candidateConfigPath(options, packageRoot);
  let candidate;
  try {
    candidate = await loadInstanceConfig(candidatePath);
  } catch {
    throw new ProductError("INVALID_INSTANCE_CONFIG", "candidate instance configuration is invalid");
  }
  const configPath = resolveInside(root, installation.config_path, "config_path");
  if (await pathExists(configPath)) {
    throw new ProductError(
      "ALREADY_CONFIGURED",
      "the instance is already configured"
    );
  }
  requireMessageScopeApproval(candidate, null, options);
  const configured = await materializeConfiguredCandidate(candidate, options, environment);
  try {
    await writePrivateJson(configPath, configured);
  } catch {
    await rm(configPath, { force: true }).catch(() => {});
    throw new ProductError(
      "CODEX_CONFIGURATION_FAILED",
      "the private Codex configuration could not be activated"
    );
  }
  return {
    status: "configured",
    production_data_approved: configured.production_data_approved
  };
}

async function setup(root, packageRoot, serviceOptions, options, environment) {
  validateGuidedResourceOptions(options);
  if (options.capabilities !== undefined && options.domains !== undefined) {
    throw new ProductError(
      "CAPABILITY_DOMAIN_CONFLICT",
      "setup accepts either --capabilities or --domains, not both"
    );
  }
  const rootWasPresent = await pathExists(root);
  const originalInstallation = await readInstallation(root, { required: false });
  if (!originalInstallation) await requireEmptyUninitializedRoot(root);
  let original = null;
  if (originalInstallation) {
    const configPath = resolveInside(root, originalInstallation.config_path, "config_path");
    const configPresent = await pathExists(configPath);
    let config;
    if (configPresent) {
      try {
        config = await loadInstanceConfig(configPath);
      } catch {
        config = undefined;
      }
    } else {
      config = null;
    }
    original = {
      config,
      configPath,
      configPresent,
      frozen: runtimeCommand(root, originalInstallation, "state").frozen === true,
      services: await serviceStatus(root, serviceOptions)
    };
  }
  if (original?.configPresent && original.config === undefined) {
    throw new ProductError("INVALID_INSTANCE_CONFIG", "active instance configuration is invalid");
  }
  const candidate = options.config !== undefined
    ? (await loadSetupCandidateFile(options, packageRoot)).candidate
    : await guidedSetupCandidate(options, environment, {
      current: original?.config ?? null
    });
  requireMessageScopeApproval(candidate, original?.config ?? null, options);
  let installation = originalInstallation;
  try {
    if (!installation) {
      await init(root, packageRoot, options);
      installation = await readInstallation(root);
    }
    await changeFreeze(root, true);
    const existingServices = await serviceStatus(root, serviceOptions);
    if (Object.values(existingServices.services).some((service) => service.loaded === true)) {
      await stopServices(root, serviceOptions);
    }
    const configPath = resolveInside(root, installation.config_path, "config_path");
    let current = original?.config ?? null;
    if (!original) {
      try {
        current = await loadInstanceConfig(configPath);
      } catch (error) {
        if (await pathExists(configPath)) {
          throw new ProductError("INVALID_INSTANCE_CONFIG", "active instance configuration is invalid");
        }
      }
    }
    const configured = await materializeConfiguredCandidate(candidate, options, environment, {
      current
    });
    await writePrivateJson(configPath, configured);
    await requireDoctorReady(root, serviceOptions, options, environment);
    await installServices(root, { ...serviceOptions, start: true });
    await requireServicesReady(root, serviceOptions);
    await changeFreeze(root, false);
    const final = await status(root, serviceOptions, options, environment);
    if (final.readiness === "degraded") {
      throw new ProductError(
        "SETUP_FINAL_STATUS_DEGRADED",
        "setup final verification did not reach an operationally healthy state"
      );
    }
    return { status: "setup-complete", ...final };
  } catch (error) {
    if (!originalInstallation && installation) {
      let recovered = true;
      try {
        await uninstallServices(root, serviceOptions);
      } catch {
        recovered = false;
      }
      try {
        await removeInstalledRuntime(root, { purge: false });
        await Promise.all([
          rm(path.join(root, "private/config.json"), { force: true }),
          rm(path.join(root, "private/state.sqlite"), { force: true }),
          rm(path.join(root, "private/supplement-schedule.json"), { force: true }),
          rm(path.join(root, "private/daily-memory-schedule.json"), { force: true })
        ]);
        await rm(root, { recursive: true, force: true });
        if (rootWasPresent) await ensurePrivateDirectory(root);
      } catch {
        recovered = false;
      }
      if (!recovered) {
        throw new ProductError(
          "SETUP_RECOVERY_FAILED",
          "setup failed and the original local state could not be restored"
        );
      }
    } else if (originalInstallation && original) {
      let recovered = true;
      try {
        await changeFreeze(root, true);
        await uninstallServices(root, serviceOptions);
        if (original.configPresent && original.config !== undefined) {
          await writePrivateJson(original.configPath, original.config);
        } else if (!original.configPresent) {
          await rm(original.configPath, { force: true });
        }
        const installedRoles = Object.entries(original.services.services)
          .filter(([, service]) => service.installed === true)
          .map(([role]) => role);
        if (installedRoles.length > 0) {
          await installServices(root, {
            ...serviceOptions,
            roles: installedRoles,
            start: false
          });
        }
        const loadedRoles = Object.entries(original.services.services)
          .filter(([, service]) => service.loaded === true)
          .map(([role]) => role);
        if (loadedRoles.some((role) => !installedRoles.includes(role))) {
          throw new Error("cannot restore a loaded service without its service definition");
        }
        if (loadedRoles.length > 0) {
          await startServices(root, {
            ...serviceOptions,
            roles: loadedRoles,
            verifyHealth: true
          });
        }
        await changeFreeze(root, original.frozen);
      } catch {
        recovered = false;
      }
      if (!recovered) {
        throw new ProductError(
          "SETUP_RECOVERY_FAILED",
          "setup failed and the original local state could not be restored"
        );
      }
    }
    throw error;
  }
}

async function updateConfig(root, packageRoot, options, environment, serviceOptions) {
  const installation = await readInstallation(root);
  const runtime = runtimeCommand(root, installation, "state");
  if (runtime.frozen !== true) {
    throw new ProductError(
      "CONFIG_UPDATE_REQUIRES_FREEZE",
      "freeze automatic processing before updating instance configuration"
    );
  }
  const services = await serviceStatus(root, serviceOptions);
  if (Object.values(services.services).some((service) => (
    service.loaded === true || service.running === true
  ))) {
    throw new ProductError(
      "CONFIG_UPDATE_REQUIRES_SERVICES_STOPPED",
      "use freeze -> service stop -> config update -> service start before resuming"
    );
  }
  if (typeof options.config !== "string") {
    throw new ProductError("CONFIGURE_OPTIONS_REQUIRED", "config update requires --config");
  }
  if (
    options.codex_bin !== undefined ||
    options.codex_environment_root !== undefined ||
    options.approve_production_data === true
  ) {
    throw new ProductError(
      "CODEX_OPTIONS_NOT_ALLOWED",
      "config update cannot change or approve the Codex environment"
    );
  }
  const configPath = resolveInside(root, installation.config_path, "config_path");
  const candidatePath = await candidateConfigPath(options, packageRoot);
  let current;
  let candidate;
  try {
    [current, candidate] = await Promise.all([
      loadInstanceConfig(configPath),
      loadInstanceConfig(candidatePath)
    ]);
  } catch {
    throw new ProductError("INVALID_INSTANCE_CONFIG", "candidate instance configuration is invalid");
  }
  requireMessageScopeApproval(candidate, current, options);
  if (
    candidate.codex_bin !== current.codex_bin ||
    candidate.codex_environment_root !== current.codex_environment_root
  ) {
    throw new ProductError(
      "CODEX_ENVIRONMENT_CHANGE_REQUIRES_NEW_INSTANCE",
      "Codex executable or environment root changes require a new instance; internal model or endpoint changes remain managed by Codex"
    );
  }
  if (candidate.production_data_approved !== current.production_data_approved) {
    throw new ProductError(
      "PRODUCTION_DATA_CHANGE_REQUIRES_CONFIGURE",
      "ordinary configuration updates cannot change production data approval"
    );
  }
  candidate.lark_cli_bin = await resolveExecutableFile(
    options.lark_cli ?? candidate.lark_cli_bin ?? current.lark_cli_bin ?? "lark-cli",
    environment
  );
  await writePrivateJson(configPath, candidate);
  return {
    status: "updated",
    frozen: true
  };
}

function summarizeDoctor(health) {
  const entries = Object.entries(health.checks ?? {});
  return {
    healthy: health.healthy === true,
    ready_for_service: health.ready_for_service === true,
    failed_checks: entries
      .filter(([, value]) => value.status === "fail")
      .map(([name, value]) => ({ name, code: value.code })),
    warning_checks: entries
      .filter(([name, value]) => name !== "services" && value.status === "warning")
      .map(([name, value]) => ({ name, code: value.code }))
  };
}

function summarizeServices(services) {
  return {
    installed: services.installed === true,
    loaded: services.loaded === true,
    healthy: services.healthy === true
  };
}

function configuredControlMode(config) {
  if (!config) return null;
  if (config.control?.mode === "local" || config.control?.mode === "base") {
    return config.control.mode;
  }
  return config.console ? "base" : "local";
}

async function status(root, serviceOptions, options, environment) {
  const installation = await readInstallation(root, { required: false });
  if (!installation) {
    return {
      initialized: false,
      configured: false,
      production_enabled: false,
      control_mode: null,
      control_healthy: false,
      message_scope: null,
      readiness: "degraded",
      active_version: null,
      previous_version: null,
      frozen: null,
      doctor: {
        healthy: false,
        ready_for_service: false,
        failed_checks: [{ name: "installation", code: "NOT_INITIALIZED" }],
        warning_checks: []
      },
      service: { installed: false, loaded: false, healthy: false },
      services: {
        realtime: { installed: false, loaded: false, running: false, healthy: false },
        supplement: { installed: false, loaded: false, running: false, healthy: false },
        daily_memory: { installed: false, loaded: false, running: false, healthy: false }
      }
    };
  }
  const configPath = resolveInside(root, installation.config_path, "config_path");
  let config;
  try {
    config = await loadInstanceConfig(configPath);
  } catch {
    config = null;
  }
  const [runtime, services, health] = await Promise.all([
    Promise.resolve()
      .then(() => runtimeCommand(root, installation, "state"))
      .catch(() => ({ frozen: true, state_available: false })),
    serviceStatus(root, serviceOptions),
    doctor(root, serviceOptions, options, environment, { checkServices: false })
  ]);
  const configured = config !== null;
  let productionEnabled = false;
  let controlHealthy = configured;
  if (config) {
    try {
      productionEnabled = await loadBaseRuntimeSwitch(config);
    } catch {
      controlHealthy = false;
    }
  }
  const messageScope = config ? config.message_scope : null;
  const runtimeHealthy = runtime.state_available !== false;
  const operationallyHealthy = health.ready_for_service === true &&
    services.healthy === true && controlHealthy && runtimeHealthy;
  const readiness = !operationallyHealthy
    ? "degraded"
    : runtime.frozen === true || !productionEnabled
      ? "safe-but-disabled"
      : "ready";
  const doctorSummary = summarizeDoctor(health);
  if (!runtimeHealthy) {
    doctorSummary.healthy = false;
    doctorSummary.ready_for_service = false;
    doctorSummary.failed_checks.push({
      name: "runtime_state",
      code: "STATE_UNAVAILABLE"
    });
  }
  return {
    initialized: true,
    configured,
    production_enabled: productionEnabled,
    control_mode: configuredControlMode(config),
    control_healthy: controlHealthy,
    message_scope: messageScope,
    readiness,
    active_version: installation.active_version,
    previous_version: installation.previous_version ?? null,
    frozen: runtime.frozen === true,
    doctor: doctorSummary,
    service: summarizeServices(services),
    services: services.services
  };
}

async function doctor(
  root,
  serviceOptions,
  options,
  environment,
  { checkServices = true } = {}
) {
  const installation = await readInstallation(root);
  let inspectedInstallation = installation;
  if (options.candidate_version !== undefined) {
    if (!PACKAGE_VERSION.test(options.candidate_version)) {
      throw new ProductError("INVALID_PACKAGE", "candidate version must be valid semver");
    }
    inspectedInstallation = {
      ...installation,
      active_version: options.candidate_version
    };
  }
  const versionRoot = activeVersionRoot(root, inspectedInstallation);
  await validateInstalledVersion(versionRoot);
  const configPath = resolveInside(root, installation.config_path, "config_path");
  const state = await regularPrivateFile(resolveInside(root, installation.state_database, "state_database"));
  const services = checkServices ? await serviceStatus(root, serviceOptions) : null;
  const checks = {
    node: nodeVersionSupported() ? check("pass", "READY") : check("fail", "NODE_UNSUPPORTED"),
    platform: process.platform === "darwin"
      ? check("pass", "READY")
      : check("warning", "PLATFORM_UNSUPPORTED"),
    installation: check("pass", "READY"),
    config: check("fail", "CONFIG_INVALID"),
    state: state.present && state.private
      ? check("pass", "READY")
      : check("fail", "STATE_NOT_PRIVATE"),
    lark_auth: check("fail", "CONFIG_REQUIRED"),
    lark_user: check("fail", "NOT_CHECKED"),
    lark_bot: check("fail", "NOT_CHECKED"),
    lark_resources: check("fail", "CONFIG_REQUIRED"),
    codex_runtime: check("fail", "CONFIG_REQUIRED"),
    production_data: check("fail", "CONFIG_REQUIRED"),
    inference: check("fail", "NOT_CHECKED"),
    services: services === null
      ? check("warning", "NOT_CHECKED")
      : services.installed && services.loaded
        ? check("pass", "READY")
        : check("warning", "SERVICES_NOT_RUNNING")
  };
  let config;
  try {
    config = await loadInstanceConfig(configPath);
    checks.config = check("pass", "READY");
  } catch {
    config = null;
  }
  let codexConfiguration;
  if (config) {
    const lark = larkAuthDoctor(
      config.lark_cli_bin ?? "lark-cli",
      config.profile,
      environment
    );
    checks.lark_auth = lark.auth;
    checks.lark_user = lark.user;
    checks.lark_bot = lark.bot;
    checks.lark_resources = [lark.auth, lark.user, lark.bot].every(
      (identity) => identity.status === "pass"
    )
      ? await larkResourcesDoctor(config, environment)
      : check("fail", "NOT_CHECKED");
    checks.production_data = config.production_data_approved === true
      ? check("pass", "READY")
      : check("fail", "PRODUCTION_DATA_NOT_APPROVED");
    try {
      codexConfiguration = await resolveCodexConfiguration({
        codexBin: config.codex_bin,
        codexEnvironmentRoot: config.codex_environment_root
      }, environment);
      checks.codex_runtime = check("pass", "READY");
    } catch (error) {
      checks.codex_runtime = check(
        "fail",
        error instanceof ProductError ? error.code : "CODEX_RUNTIME_INVALID"
      );
      codexConfiguration = null;
    }
  }
  if (config && codexConfiguration) {
    const inference = await new CodexInferenceAdapter({
      codexBin: codexConfiguration.codex_bin,
      codexEnvironmentRoot: codexConfiguration.codex_environment_root,
      timeoutMs: config.codex_timeout_ms ?? 120000
    }).doctor();
    checks.inference = inference.ok
      ? check("pass", inference.code, { latency_ms: inference.latency_ms })
      : check("fail", inference.code, { latency_ms: inference.latency_ms });
  }
  const required = [
    "node",
    "installation",
    "config",
    "state",
    "lark_auth",
    "lark_user",
    "lark_bot",
    "lark_resources",
    "codex_runtime",
    "production_data",
    "inference"
  ];
  const healthy = required.every((name) => checks[name].status === "pass");
  return {
    healthy,
    ready_for_service: healthy && process.platform === "darwin",
    checks
  };
}

async function requireDoctorReady(root, serviceOptions, options, environment) {
  const health = await doctor(root, serviceOptions, options, environment, {
    checkServices: false
  });
  if (health.ready_for_service !== true) {
    throw new ProductError(
      "DOCTOR_FAILED",
      "the local instance must pass Doctor before automatic processing can change"
    );
  }
  return health;
}

async function requireServicesReady(root, serviceOptions) {
  const services = await serviceStatus(root, serviceOptions);
  if (services.installed !== true || services.healthy !== true) {
    throw new ProductError(
      "SERVICE_NOT_READY",
      "install and start healthy background services before resuming automatic processing"
    );
  }
  return services;
}

function installedVersionDoctorReady(root, installation, serviceOptions, options, environment) {
  const entry = path.join(
    activeVersionRoot(root, installation),
    "bin/feishu-digital-twin.mjs"
  );
  const args = [entry, "--root", root];
  if (serviceOptions.launchAgentsDirectory) {
    args.push("--launch-agents-dir", serviceOptions.launchAgentsDirectory);
  }
  if (serviceOptions.launchctlBin) args.push("--launchctl-bin", serviceOptions.launchctlBin);
  args.push("--candidate-version", installation.active_version);
  args.push("doctor");
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
    env: environment
  });
  if (result.error || result.status !== 0) return false;
  try {
    return JSON.parse(result.stdout.trim()).ready_for_service === true;
  } catch {
    return false;
  }
}

async function changeFreeze(root, frozen) {
  const installation = await readInstallation(root);
  const result = runtimeCommand(root, installation, frozen ? "freeze" : "resume");
  return { status: frozen ? "frozen" : "resumed", frozen: result.frozen === true };
}

function loadedServiceRoles(status) {
  return Object.entries(status.services)
    .filter(([, service]) => service.loaded === true)
    .map(([role]) => role);
}

async function activateVersion({
  root,
  current,
  updated,
  serviceOptions,
  options,
  environment,
  failureCode,
  failureMessage
}) {
  const services = await serviceStatus(root, serviceOptions);
  const loadedRoles = loadedServiceRoles(services);
  if (loadedRoles.length > 0 && options.restart !== true) {
    throw new ProductError(
      "RESTART_REQUIRED",
      "running background services require --restart for an atomic version switch"
    );
  }
  const configPath = resolveInside(root, current.config_path, "config_path");
  const validateCandidate = options.restart === true || await pathExists(configPath);
  if (validateCandidate && !installedVersionDoctorReady(
    root,
    updated,
    serviceOptions,
    options,
    environment
  )) {
    throw new ProductError(failureCode, failureMessage);
  }
  if (loadedRoles.length === 0) {
    await writePrivateJson(path.join(root, "installation.json"), updated);
    return false;
  }

  let pointerSwitched = false;
  const touchedRoles = [];
  try {
    await writePrivateJson(path.join(root, "installation.json"), updated);
    pointerSwitched = true;
    for (const role of loadedRoles) {
      touchedRoles.push(role);
      await stopServices(root, { ...serviceOptions, roles: [role] });
      await startServices(root, {
        ...serviceOptions,
        roles: [role],
        verifyHealth: true
      });
    }
    const finalServices = await serviceStatus(root, serviceOptions);
    if (loadedRoles.some((role) => finalServices.services[role].healthy !== true)) {
      throw new Error("a restarted service did not remain healthy");
    }
    return true;
  } catch {
    let recovered = true;
    if (pointerSwitched) {
      try {
        await writePrivateJson(path.join(root, "installation.json"), current);
      } catch {
        recovered = false;
      }
    }
    if (recovered) {
      for (const role of touchedRoles) {
        try {
          await stopServices(root, { ...serviceOptions, roles: [role] });
          await startServices(root, {
            ...serviceOptions,
            roles: [role],
            verifyHealth: true
          });
        } catch {
          recovered = false;
        }
      }
    }
    if (recovered) {
      try {
        const recoveredServices = await serviceStatus(root, serviceOptions);
        if (loadedRoles.some((role) => recoveredServices.services[role].healthy !== true)) {
          recovered = false;
        }
      } catch {
        recovered = false;
      }
    }
    if (!recovered) {
      throw new ProductError(
        "VERSION_RECOVERY_FAILED",
        "version switch failed and automatic service recovery did not complete"
      );
    }
    throw new ProductError(failureCode, failureMessage);
  }
}

async function upgrade(root, packageRoot, serviceOptions, options, environment) {
  const installation = await readInstallation(root);
  const sourceRoot = path.resolve(options.source ?? packageRoot);
  const installed = await installVersion({ sourceRoot, installationRoot: root });
  if (installed.state_format !== installation.state_format) {
    throw new ProductError(
      "INCOMPATIBLE_STATE_FORMAT",
      "upgrade requires a state-compatible version; export and migrate in a separate operation"
    );
  }
  if (installed.version === installation.active_version) {
    return {
      status: "unchanged",
      active_version: installation.active_version,
      previous_version: installation.previous_version ?? null
    };
  }
  const updated = {
    ...installation,
    active_version: installed.version,
    previous_version: installation.active_version
  };
  const servicesRestarted = await activateVersion({
    root,
    current: installation,
    updated,
    serviceOptions,
    options,
    environment,
    failureCode: "UPGRADE_ROLLED_BACK",
    failureMessage: "upgrade failed and the previous version was restored"
  });
  return {
    status: "upgraded",
    active_version: updated.active_version,
    previous_version: updated.previous_version,
    services_restarted: servicesRestarted
  };
}

async function rollback(root, serviceOptions, options, environment) {
  const installation = await readInstallation(root);
  if (!installation.previous_version) {
    throw new ProductError("NO_ROLLBACK_VERSION", "no previous verified version is available");
  }
  const rollbackManifest = await validateInstalledVersion(
    path.join(root, "versions", installation.previous_version)
  );
  if (rollbackManifest.feishuDigitalTwin.stateFormat !== installation.state_format) {
    throw new ProductError(
      "INCOMPATIBLE_STATE_FORMAT",
      "rollback requires a state-compatible version"
    );
  }
  const updated = {
    ...installation,
    active_version: installation.previous_version,
    previous_version: installation.active_version
  };
  const servicesRestarted = await activateVersion({
    root,
    current: installation,
    updated,
    serviceOptions,
    options,
    environment,
    failureCode: "ROLLBACK_ABORTED",
    failureMessage: "rollback failed and the active version was left unchanged"
  });
  return {
    status: "rolled-back",
    active_version: updated.active_version,
    previous_version: updated.previous_version,
    services_restarted: servicesRestarted
  };
}

async function uninstall(root, serviceOptions, options) {
  const installation = await readInstallation(root, { required: false });
  if (!installation) return { status: "uninstalled", private_data_preserved: !options.purge };
  await uninstallServices(root, serviceOptions);
  await removeInstalledRuntime(root, { purge: options.purge === true });
  if (!options.purge) {
    await ensurePrivateDirectory(path.join(root, "private"));
  }
  return {
    status: "uninstalled",
    private_data_preserved: options.purge !== true
  };
}

async function serviceCommand(root, action, serviceOptions, options, environment) {
  if (new Set(["install", "start", "restart"]).has(action)) {
    await requireDoctorReady(root, serviceOptions, options, environment);
  }
  if (action === "install") {
    return installServices(root, { ...serviceOptions, start: options.no_start !== true });
  }
  if (action === "start") return startServices(root, serviceOptions);
  if (action === "stop") return stopServices(root, serviceOptions);
  if (action === "restart") return restartServices(root, serviceOptions);
  if (action === "status") return serviceStatus(root, serviceOptions);
  if (action === "uninstall") return uninstallServices(root, serviceOptions);
  if (action === "run") {
    const code = await runServiceRole(root, options.role);
    return { internal_exit_code: code };
  }
  throw new ProductError("INVALID_SERVICE_COMMAND", "service requires a supported action");
}

async function controlCommand({
  root,
  action,
  packageRoot,
  serviceOptions,
  options,
  environment
}) {
  if (action === "enable") {
    await requireDoctorReady(root, serviceOptions, options, environment);
    await requireServicesReady(root, serviceOptions);
    return changeFreeze(root, false);
  }
  if (action === "freeze") return changeFreeze(root, true);
  if (action === "upgrade") {
    return upgrade(root, packageRoot, serviceOptions, options, environment);
  }
  if (action === "rollback") {
    return rollback(root, serviceOptions, options, environment);
  }
  if (action === "uninstall") return uninstall(root, serviceOptions, options);
  throw new ProductError(
    "INVALID_CONTROL_COMMAND",
    "control requires enable, freeze, upgrade, rollback, or uninstall"
  );
}

export async function runProductCli({
  argv,
  packageRoot,
  stdout = process.stdout,
  stderr = process.stderr,
  environment = process.env
}) {
  try {
    const { options, positionals } = parseArguments(argv);
    if (options.version) {
      const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      stdout.write(`${manifest.version}\n`);
      return 0;
    }
    if (options.help || positionals.length === 0) {
      stdout.write(HELP);
      return positionals.length === 0 && !options.help ? 64 : 0;
    }
    const root = resolveProductRoot(options.root, environment);
    const [command, subcommand, role] = positionals;
    const serviceOptions = {
      launchAgentsDirectory: options.launch_agents_dir,
      launchctlBin: options.launchctl_bin ?? "/bin/launchctl"
    };
    let result;
    if (command === "init") result = await init(root, packageRoot, options);
    else if (command === "profiles") result = await availableProfiles(options, environment);
    else if (command === "setup") {
      result = await setup(root, packageRoot, serviceOptions, options, environment);
    }
    else if (command === "configure") {
      result = await configure(root, packageRoot, options, environment);
    }
    else if (command === "config") {
      if (subcommand !== "update") {
        throw new ProductError("INVALID_CONFIG_COMMAND", "config requires the update action");
      }
      result = await updateConfig(root, packageRoot, options, environment, serviceOptions);
    }
    else if (command === "doctor") {
      result = await doctor(root, serviceOptions, options, environment);
    }
    else if (command === "status") {
      result = await status(root, serviceOptions, options, environment);
    }
    else if (command === "freeze") result = await changeFreeze(root, true);
    else if (command === "resume") {
      await requireDoctorReady(root, serviceOptions, options, environment);
      await requireServicesReady(root, serviceOptions);
      result = await changeFreeze(root, false);
    }
    else if (command === "control") {
      result = await controlCommand({
        root,
        action: subcommand,
        packageRoot,
        serviceOptions,
        options,
        environment
      });
    }
    else if (command === "service") {
      if (subcommand === "run") options.role = role;
      result = await serviceCommand(root, subcommand, serviceOptions, options, environment);
      if (subcommand === "run") return result.internal_exit_code;
    } else if (command === "upgrade") {
      result = await upgrade(root, packageRoot, serviceOptions, options, environment);
    } else if (command === "rollback") {
      result = await rollback(root, serviceOptions, options, environment);
    } else if (command === "uninstall") {
      result = await uninstall(root, serviceOptions, options);
    } else {
      throw new ProductError("UNKNOWN_COMMAND", "unknown product command");
    }
    printJson(stdout, result);
    return command === "doctor" && result?.healthy === false ? 1 : 0;
  } catch (error) {
    const code = error instanceof ProductError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof ProductError
      ? error.message
      : "the product command failed unexpectedly";
    const details = error instanceof ProductError && error.details &&
      typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details
      : {};
    stderr.write(`${JSON.stringify({
      type: "error",
      component: "product-cli",
      code,
      message,
      ...details
    })}\n`);
    return code === "UNKNOWN_COMMAND" || code === "UNKNOWN_OPTION" || code === "MISSING_OPTION_VALUE"
      ? 64
      : 1;
  }
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import {
  authorityLabel,
  hasAuthorityLabel
} from "../../shared/authority-labels.mjs";
import { buildLarkEnvironment } from "../../shared/subprocess-environment.mjs";

const RUNTIME_FLAGS = ["--yes", "--dry-run", "--as", "--profile", "--format"];
const RESERVED_DOMAINS = new Set([
  "api",
  "auth",
  "config",
  "doctor",
  "event",
  "help",
  "profile",
  "schema",
  "skills",
  "update",
  "whoami"
]);
function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireIdentity(value) {
  if (!new Set(["user", "bot"]).has(value)) {
    throw new TypeError("identity must be user or bot");
  }
  return value;
}

function parseEnvelope(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function feedbackError(envelope) {
  const error = envelope?.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return Object.fromEntries(Object.entries({
    type: error.type,
    subtype: error.subtype,
    code: error.code,
    message: error.message,
    hint: error.hint,
    missing_scopes: error.missing_scopes
  }).filter(([, value]) => value !== undefined && value !== null));
}

function parseOfficialDryRun(stdout, stderr) {
  const marker = "=== Dry Run ===";
  const streams = [stderr, stdout];
  for (let index = 0; index < streams.length; index += 1) {
    const trimmed = typeof streams[index] === "string" ? streams[index].trim() : "";
    if (!trimmed.startsWith(marker)) continue;
    const preview = parseEnvelope(trimmed.slice(marker.length).trim()) ??
      parseEnvelope(streams[1 - index]);
    return preview && typeof preview === "object" && !Array.isArray(preview)
      ? preview
      : null;
  }
  return null;
}

function normalizedEffects(preview) {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return [];
  return [preview.effects, preview.effect, preview.local_effects]
    .filter((value) => value !== undefined && value !== null);
}

function explicitOwnershipTransferText(value) {
  if (typeof value !== "string") return false;
  if (/转让(?:文档|文件)?所有权|所有权转让|变更所有者|新所有者/u.test(value)) return true;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_");
  return /(?:^|_)(?:ownership_transfer|transfer_ownership|owner_transfer|transfer_owner|change_owner|assign_owner|set_owner|new_owner)(?:_|$)/u
    .test(normalized);
}

function containsOwnershipField(value, { includeCurrentOwner = false } = {}) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsOwnershipField(item, { includeCurrentOwner }));
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]+/gu, "_");
    if (new Set(["new_owner", "new_owner_id", "new_owner_open_id"]).has(normalized)) {
      return true;
    }
    if (
      includeCurrentOwner &&
      new Set(["owner", "owner_id", "owner_open_id"]).has(normalized)
    ) {
      return true;
    }
    if (containsOwnershipField(child, { includeCurrentOwner })) return true;
  }
  return false;
}

function dryRunIndicatesOwnershipChange(preview) {
  if (normalizedEffects(preview).some((effects) => {
    const values = Array.isArray(effects) ? effects : [effects];
    return values.some((effect) => (
      explicitOwnershipTransferText(typeof effect === "string" ? effect : effect?.type) ||
      explicitOwnershipTransferText(effect?.action) ||
      explicitOwnershipTransferText(effect?.operation) ||
      containsOwnershipField(effect)
    ));
  })) return true;
  const requests = Array.isArray(preview?.api) ? preview.api : [];
  return requests.some((request) => {
    const method = typeof request?.method === "string" ? request.method.toUpperCase() : "";
    if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(method)) return false;
    if (explicitOwnershipTransferText(request.url)) return true;
    if (containsOwnershipField(request.params) || containsOwnershipField(request.body)) return true;
    return new Set(["PUT", "PATCH"]).has(method) && (
      containsOwnershipField(request.params, { includeCurrentOwner: true }) ||
      containsOwnershipField(request.body, { includeCurrentOwner: true })
    );
  });
}

function commandHash(argv) {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

function hasRuntimeFlag(argv, flag) {
  return argv.some((value) => value === flag || value.startsWith(`${flag}=`));
}

function isOwnershipTransfer(argv) {
  const value = argv.join(" ").toLowerCase();
  if (/transfer[ _-]*(?:file[ _-]*)?owner|owner[ _-]*transfer|transfer[ _-]*ownership|new[ _-]*owner/u.test(value)) {
    return true;
  }
  return /owner[_-]?id/u.test(value) && /(?:^|[ +._-])(?:update|set|change|assign)(?:$|[ +._-])/u.test(value);
}

function isPublicMessage(argv) {
  if (argv[0] !== "im") return false;
  const operation = argv.slice(1, 3).join(" ").toLowerCase();
  return argv.some((value) => /messages[-_](?:send|reply)/u.test(value.toLowerCase())) ||
    /^messages (?:create|reply)$/u.test(operation);
}

function isMessageReply(argv) {
  if (argv[0] !== "im") return false;
  return /messages[-_]reply/u.test(argv[1]?.toLowerCase() ?? "") ||
    argv.slice(1, 3).join(" ").toLowerCase() === "messages reply";
}

function messageText(argv) {
  for (const flag of ["--text", "--markdown", "--content"]) {
    const index = argv.indexOf(flag);
    if (index >= 0) return messagePayloadText(flag, argv[index + 1]);
    const inline = argv.find((value) => value.startsWith(`${flag}=`));
    if (inline) return messagePayloadText(flag, inline.slice(flag.length + 1));
  }
  return undefined;
}

const AUTHORITY_PREFIX = /^(?:🤖\s*)*【(数字分身|代表发言|建议|待[^】]+确认)】\s*/u;

function normalizeMessageText(text, principalName) {
  let body = text.trim();
  const first = AUTHORITY_PREFIX.exec(body);
  const mode = first?.[1] === "建议"
    ? "suggestion"
    : first?.[1]?.startsWith("待")
      ? "confirmation"
      : "representative";
  while (AUTHORITY_PREFIX.test(body)) {
    body = body.replace(AUTHORITY_PREFIX, "").trimStart();
  }
  body = body.replace(/^(?:🤖\s*)+/u, "").trimStart();
  return `${authorityLabel(mode, principalName)}${body}`;
}

function messagePayloadText(flag, value) {
  if (flag !== "--content") return value;
  try {
    const content = JSON.parse(value);
    return content && !Array.isArray(content) ? content.text : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMessagePayload(flag, value, principalName) {
  if (flag !== "--content") return normalizeMessageText(value, principalName);
  let content;
  try {
    content = JSON.parse(value);
  } catch {
    throw new Error("automated public message --content must be valid text JSON");
  }
  if (!content || Array.isArray(content) || typeof content.text !== "string") {
    throw new Error("automated public message --content must contain text");
  }
  return JSON.stringify({
    ...content,
    text: normalizeMessageText(content.text, principalName)
  });
}

function withTrustedMessageLabel(action, principalName) {
  if (!isPublicMessage(action.argv)) return action;
  const argv = [...action.argv];
  for (const flag of ["--text", "--markdown", "--content"]) {
    const index = argv.indexOf(flag);
    if (index >= 0) {
      const text = argv[index + 1];
      if (typeof text === "string") {
        argv[index + 1] = normalizeMessagePayload(flag, text, principalName);
      }
      return { ...action, argv };
    }
    const inlineIndex = argv.findIndex((value) => value.startsWith(`${flag}=`));
    if (inlineIndex >= 0) {
      const text = argv[inlineIndex].slice(flag.length + 1);
      argv[inlineIndex] = `${flag}=${normalizeMessagePayload(flag, text, principalName)}`;
      return { ...action, argv };
    }
  }
  return action;
}

function containsProtectedValue(value, protectedValues) {
  if (typeof value === "string") {
    if (protectedValues.has(value)) return true;
    const equals = value.indexOf("=");
    const candidate = equals >= 0 ? value.slice(equals + 1) : value;
    if (candidate.split(",").some((item) => protectedValues.has(item.trim()))) return true;
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return containsProtectedValue(JSON.parse(trimmed), protectedValues);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsProtectedValue(item, protectedValues));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsProtectedValue(item, protectedValues));
  }
  return false;
}

function containsProtectedActionValue(argv, protectedValues) {
  const safeReferenceFlags = new Map([
    ["drive +search", new Set(["--folder-tokens"])],
    ["docs +create", new Set(["--parent-token"])]
  ]).get(argv.slice(0, 2).join(" ")) ?? new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (safeReferenceFlags.has(value)) {
      index += 1;
      continue;
    }
    if ([...safeReferenceFlags].some((flag) => value.startsWith(`${flag}=`))) continue;
    if (containsProtectedValue(value, protectedValues)) return true;
  }
  return false;
}

function validateAction(action, allowedDomains, protectedValues, principalName) {
  if (!action || typeof action !== "object" || !Array.isArray(action.argv)) {
    throw new TypeError("action.argv must be an array");
  }
  if (action.argv.length < 2 || action.argv.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("action.argv must contain non-empty strings");
  }
  if (RESERVED_DOMAINS.has(action.argv[0]) || !allowedDomains.has(action.argv[0])) {
    throw new Error(`lark domain is not allowed: ${action.argv[0]}`);
  }
  for (const flag of RUNTIME_FLAGS) {
    if (hasRuntimeFlag(action.argv, flag)) {
      throw new Error(`${flag} is controlled by LarkGuard`);
    }
  }
  if (isOwnershipTransfer(action.argv)) {
    throw new Error("ownership transfer must be performed by the principal manually");
  }
  if (containsProtectedActionValue(action.argv, protectedValues)) {
    throw new Error("digital twin control resources cannot be modified through AI commands");
  }
  if (isPublicMessage(action.argv)) {
    const text = messageText(action.argv);
    if (!hasAuthorityLabel(text, principalName)) {
      throw new Error("automated public messages must include a trusted authority label");
    }
  }
}

export function runLarkCommand(argv, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: buildLarkEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({
      exit_code: code ?? 1,
      stdout,
      stderr
    }));
  });
}

export class LarkGuard {
  constructor({
    larkBin = "lark-cli",
    profile,
    principalName,
    allowedDomains,
    protectedValues = [],
    runner = runLarkCommand
  } = {}) {
    this.larkBin = requireText(larkBin, "larkBin");
    this.profile = requireText(profile, "profile");
    this.principalName = requireText(principalName, "principalName");
    if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
      throw new TypeError("allowedDomains must be a non-empty array");
    }
    this.allowedDomains = new Set(allowedDomains.map((value) => requireText(value, "allowed domain")));
    if (!Array.isArray(protectedValues)) throw new TypeError("protectedValues must be an array");
    this.protectedValues = new Set(protectedValues.filter((value) => typeof value === "string" && value.length > 0));
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    this.runner = runner;
  }

  plan(action, { productionEnabled, frozen, identity = "user" } = {}) {
    const trustedAction = withTrustedMessageLabel(action, this.principalName);
    validateAction(trustedAction, this.allowedDomains, this.protectedValues, this.principalName);
    if (typeof productionEnabled !== "boolean" || typeof frozen !== "boolean") {
      throw new TypeError("productionEnabled and frozen must be booleans");
    }
    const trustedIdentity = requireIdentity(identity);
    if (trustedIdentity === "bot" && !isMessageReply(action.argv)) {
      throw new Error("Bot identity is limited to message replies");
    }

    const executeArgv = [
      this.larkBin,
      "--profile",
      this.profile,
      ...trustedAction.argv,
      "--as",
      trustedIdentity,
      "--format",
      "json"
    ];
    return {
      command_hash: commandHash(executeArgv),
      preview_argv: [...executeArgv, "--dry-run"],
      execute_argv: executeArgv,
      production_enabled: productionEnabled,
      frozen
    };
  }

  async execute(action, { productionEnabled, frozen, confirmed = false, identity = "user" } = {}) {
    if (typeof confirmed !== "boolean") throw new TypeError("confirmed must be a boolean");
    const plan = this.plan(action, { productionEnabled, frozen, identity });
    const preview = await this.runner(plan.preview_argv);
    const previewEnvelope = parseEnvelope(preview.stderr) ?? parseEnvelope(preview.stdout);
    const officialDryRun = parseOfficialDryRun(preview.stdout, preview.stderr);
    if (preview.exit_code !== 0 || (previewEnvelope?.ok !== true && officialDryRun === null)) {
      return {
        status: "failed",
        phase: "preview",
        command_hash: plan.command_hash,
        exit_code: preview.exit_code,
        error_type: previewEnvelope?.error?.type ?? (preview.exit_code === 0 ? "invalid_envelope" : "unknown"),
        error: feedbackError(previewEnvelope)
      };
    }
    const normalizedPreview = previewEnvelope?.data ?? officialDryRun;
    if (dryRunIndicatesOwnershipChange(normalizedPreview)) {
      return {
        status: "failed",
        phase: "preview",
        command_hash: plan.command_hash,
        exit_code: preview.exit_code,
        error_type: "ownership_transfer_forbidden"
      };
    }
    if (!productionEnabled) {
      return { status: "preview-only", command_hash: plan.command_hash };
    }
    if (frozen) {
      return { status: "frozen", command_hash: plan.command_hash };
    }

    const executeArgv = confirmed ? [...plan.execute_argv, "--yes"] : plan.execute_argv;
    const result = await this.runner(executeArgv);
    const envelope = parseEnvelope(result.stderr) ?? parseEnvelope(result.stdout);
    if (
      result.exit_code === 10 &&
      envelope?.error?.type === "confirmation_required"
    ) {
      return {
        status: "confirmation-required",
        command_hash: plan.command_hash,
        risk: envelope.error.risk ?? null,
        preview: previewEnvelope?.data ?? officialDryRun
      };
    }
    if (result.exit_code === 0 && envelope?.ok === true) {
      return {
        status: "complete",
        command_hash: plan.command_hash,
        data: envelope?.data ?? null
      };
    }
    return {
      status: "failed",
      phase: "execute",
      command_hash: plan.command_hash,
      exit_code: result.exit_code,
      error_type: envelope?.error?.type ?? "unknown",
      error: feedbackError(envelope)
    };
  }
}

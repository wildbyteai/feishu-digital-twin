import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const SCANNER_VERSION = 1;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const CHINESE_ID_PATTERN = /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/gu;
const PRIVATE_IPV4_PATTERN = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/gu;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'`=(:;>])(\/(?!\/|\s)[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?)/gmu;
const MARKDOWN_ANGLE_ABSOLUTE_PATH_PATTERN = /\]\(<\/(?!\/|\s)[^>\r\n]+>/gmu;
const FILE_URL_PATH_PATTERN = /\bfile:\/\/\/?[^\s"'`<>]+/giu;
const WINDOWS_USER_PATH_PATTERN = /\b[A-Za-z]:\\(?:Users\\[^\\\s"'<>]+|Documents and Settings\\[^\\\s"'<>]+)(?:\\[^\s"'<>]*)?/giu;
const WINDOWS_FORWARD_USER_PATH_PATTERN = /\b[A-Za-z]:\/(?:Users\/[^/\s"'<>]+|Documents and Settings\/[^/\s"'<>]+)(?:\/[^\s"'<>]*)?/giu;
const WINDOWS_UNC_PATH_PATTERN = /(?:^|[\s"'`=(])\\\\[^\\\s"'`<>]+\\[^\\\s"'`<>]+(?:\\[^\\\s"'`<>]+)*/gu;
const FEISHU_ID_PATTERN = /\b(?:ou|oc|om|on|cli|od|odc)_[A-Za-z0-9]{16,}\b/gu;
const FEISHU_TOKEN_PATTERN = /\b(?:fld|doxcn|doccn|wikcn|shtcn|bas|tbl|rec|vew)[A-Za-z0-9]{16,}\b/gu;
const FEISHU_RESOURCE_URL_PATTERN = /\bhttps?:\/\/(?:[A-Za-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com)\/(?:wiki|docx|docs|drive|base|sheets|mindnotes|minutes)\/[A-Za-z0-9_-]{16,}(?=[/?#\s"'<>]|$)/giu;
const PRIVATE_DOMAIN_PATTERN = /\b(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+(?:internal|local|lan|corp)(?=[:/\s"'<>]|$)(?::\d+)?(?:\/[^\s"'<>]*)?/giu;
const CODE_SOURCE_PATH_PATTERN = /\.(?:[cm]?js|jsx|ts|tsx)$/iu;
const SENSITIVE_PRIVATE_PATH_SUFFIXES = [".privacy-key"];
const CANDIDATE_METADATA_PATHS = new Set([
  "SHA256SUMS",
  "provenance.intoto.jsonl",
  "sbom.spdx.json",
  "snapshot-manifest.json"
]);
const KNOWN_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\bnpm_[A-Za-z0-9]{30,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu
];
const AUTHORIZATION_SECRET_PATTERN = /\bauthorization(?:\\?["'])?\s*:\s*(?:\\?["'])?\s*(?:bearer\s+[A-Za-z0-9._~+/=-]{20,}|basic\s+[A-Za-z0-9+/=]{16,})/giu;
const CLI_SECRET_OPTION_PATTERN = /(?:^|\s)--(?:app-secret|client-secret|access-token|refresh-token|tenant-access-token|user-access-token|base-token|password|token)\s+(?:["'])?([^\s"']{16,})/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = /(?:api[_-]?key|app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password|credential|secret|token)\s*["']?\s*[:=]\s*(?:"([^"\r\n]{16,})"|'([^'\r\n]{16,})'|([^\s,;}\]]{16,}))/giu;
const QUOTED_OR_BARE_OPAQUE_VALUE = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’|`([^`\r\n]+)`|([^\s,，;；)\]}]+))/.source;
const QUOTED_OR_BARE_LABELED_VALUE = /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’|`([^`\r\n]+)`|([^,，;；\r\n]+))/.source;
const EXPLICIT_PRIVATE_REFERENCE_PATTERN = new RegExp(
  String.raw`(?:base_token|chat_id|doc(?:ument)?_token|folder_token|open_id|resource_id|space_id|table_id|tenant_key|wiki_token)\s*[:：=]\s*${QUOTED_OR_BARE_OPAQUE_VALUE}`,
  "giu"
);
const LABELED_PRIVATE_VALUE_PATTERN = new RegExp(
  String.raw`(?:主体|联系人|公司|组织|部门|项目|品牌|租户(?:名称)?|企业知识库|知识空间|空间名称)\s*[:：=]\s*${QUOTED_OR_BARE_LABELED_VALUE}`,
  "giu"
);
const URL_PATTERN = /https?:\/\/[^\s"'<>，；]+/giu;
const GENERIC_INSTANCE_VALUES = new Set([
  "admin",
  "all_visible",
  "bot",
  "bot_only",
  "default",
  "digital-twin",
  "im",
  "internal_visible",
  "local",
  "main",
  "owner",
  "primary",
  "prod",
  "production",
  "user",
  "数字分身每日工作记忆"
]);
const PUBLIC_FEISHU_HOSTS = new Set([
  "accounts.feishu.cn",
  "accounts.larksuite.com",
  "applink.feishu.cn",
  "feishu.cn",
  "larksuite.com",
  "open.feishu.cn",
  "open.larksuite.com",
  "support.feishu.cn",
  "www.feishu.cn",
  "www.larksuite.com"
]);

function isSortedUnique(values) {
  return values.every((value, index) => (
    index === 0 || values[index - 1].localeCompare(value, "en") < 0
  ));
}

function requireSortedStrings(values, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    throw new TypeError(`${field} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  if (values.some((value) => typeof value !== "string" || value.trim() !== value || !value)) {
    throw new TypeError(`${field} must contain non-empty trimmed strings`);
  }
  if (!isSortedUnique(values)) {
    throw new TypeError(`${field} must be sorted and unique`);
  }
}

export function validatePrivateScanPolicy(policy) {
  if (policy?.schema_version !== 1) {
    throw new TypeError("a version 1 private scan policy is required");
  }
  requireSortedStrings(policy.forbidden_literals, "forbidden_literals", { allowEmpty: false });
  requireSortedStrings(policy.private_domains, "private_domains");
  if (policy.forbidden_literals.some(templatePlaceholder) ||
      policy.private_domains.some((value) => templatePlaceholder(value) ||
        value.toLowerCase().endsWith(".example.invalid"))) {
    throw new TypeError("private scan policy placeholders must be replaced");
  }
  return policy;
}

export async function loadPrivateScanPolicy(filename) {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError("private scan policy must be a regular file");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new TypeError("private scan policy must use mode 0600");
  }
  let policy;
  try {
    policy = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new TypeError("private scan policy must be valid JSON", { cause: error });
  }
  return validatePrivateScanPolicy(policy);
}

function normalizedPrivateValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, "")
    .trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  const lowered = normalized.toLowerCase();
  if (GENERIC_INSTANCE_VALUES.has(lowered) || obviousPlaceholder(normalized) ||
      templatePlaceholder(normalized)) {
    return null;
  }
  return normalized;
}

function codePointLength(value) {
  return [...value].length;
}

function distinctivePrivateValue(value, { identity = false, opaque = false } = {}) {
  const normalized = normalizedPrivateValue(value);
  if (!normalized) return null;
  if (opaque) return codePointLength(normalized) >= 6 ? normalized : null;
  if (identity) return codePointLength(normalized) >= 2 ? normalized : null;
  if (/\p{Script=Han}/u.test(normalized)) {
    return codePointLength(normalized) >= 6 ? normalized : null;
  }
  return codePointLength(normalized) >= 8 ? normalized : null;
}

function addPrivateLiteral(target, value, options) {
  const normalized = distinctivePrivateValue(value, options);
  if (normalized) target.add(normalized);
}

function addPrivateDomain(target, value) {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(URL_PATTERN)) {
    try {
      const hostname = new URL(match[0]).hostname.toLowerCase();
      const tenantFeishuHost = (hostname.endsWith(".feishu.cn") ||
        hostname.endsWith(".larksuite.com")) && !PUBLIC_FEISHU_HOSTS.has(hostname);
      const explicitlyPrivateHost = /\.(?:corp|internal|lan|local)$/u.test(hostname);
      if ((tenantFeishuHost || explicitlyPrivateHost) &&
          !hostname.endsWith(".example.invalid")) {
        target.add(hostname);
      }
    } catch {
      // Invalid URLs are not promoted into a private domain rule.
    }
  }
}

function capturedPrivateValue(match) {
  return match.slice(1).find((value) => typeof value === "string");
}

function addExplicitRuleValues(literals, domains, rule) {
  if (typeof rule !== "string") return;
  for (const match of rule.matchAll(EXPLICIT_PRIVATE_REFERENCE_PATTERN)) {
    addPrivateLiteral(literals, capturedPrivateValue(match), { opaque: true });
  }
  for (const match of rule.matchAll(LABELED_PRIVATE_VALUE_PATTERN)) {
    addPrivateLiteral(literals, capturedPrivateValue(match), { identity: true });
  }
  addPrivateDomain(domains, rule);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

export function mergePrivateScanPolicyWithInstanceConfig(policy, config) {
  validatePrivateScanPolicy(policy);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("a validated instance config is required");
  }
  const literals = new Set(policy.forbidden_literals);
  const domains = new Set(policy.private_domains);
  addPrivateLiteral(literals, config.instance_id, { opaque: true });
  addPrivateLiteral(literals, config.profile, { opaque: true });
  addPrivateLiteral(literals, config.principal?.name, { identity: true });
  addPrivateLiteral(literals, config.principal?.open_id, { opaque: true });
  for (const name of config.principal?.address_names ?? []) {
    addPrivateLiteral(literals, name, { identity: true });
  }
  addPrivateLiteral(literals, config.console?.base_token, { opaque: true });
  addPrivateLiteral(literals, config.console?.runtime_table);
  addPrivateLiteral(literals, config.console?.group_rules_table);
  addPrivateLiteral(literals, config.daily_memory?.folder_token, { opaque: true });
  addPrivateLiteral(literals, config.daily_memory?.folder_name);
  for (const chatId of config.daily_memory?.excluded_chat_ids ?? []) {
    addPrivateLiteral(literals, chatId, { opaque: true });
  }
  for (const topic of config.daily_memory?.excluded_topics ?? []) {
    addPrivateLiteral(literals, topic);
  }
  for (const groupRule of config.group_rules ?? []) {
    addPrivateLiteral(literals, groupRule?.chat_id, { opaque: true });
    for (const rule of groupRule?.rules ?? []) addExplicitRuleValues(literals, domains, rule);
  }
  for (const rule of config.authority_rules ?? []) {
    addExplicitRuleValues(literals, domains, rule);
  }
  return validatePrivateScanPolicy({
    schema_version: 1,
    forbidden_literals: sortedUnique(literals),
    private_domains: sortedUnique(domains)
  });
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function obviousPlaceholder(value) {
  const lowered = value.toLowerCase();
  return /^(?:fixture|example|synthetic|placeholder|fake|test|replace[_-]?(?:me|with)|your)(?:[_-][a-z0-9]+)*$/u.test(lowered) ||
    /^x+$/u.test(lowered) ||
    /^0+$/u.test(lowered);
}

function templatePlaceholder(value) {
  return typeof value === "string" &&
    /(?:\breplace(?:[_ -]?(?:me|with))?\b|\byour[_ -]|\bexample\b)/iu.test(value);
}

function javascriptRegexRanges(content) {
  const ranges = [];
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== "/" || content[start + 1] === "/" || content[start + 1] === "*") {
      continue;
    }
    let previous = start - 1;
    while (previous >= 0 && /\s/u.test(content[previous])) previous -= 1;
    const prefix = content.slice(Math.max(0, start - 16), start);
    if (previous >= 0 && !"=(:,[!&|?{;,>".includes(content[previous]) &&
        !/\b(?:case|return|throw|yield)\s*$/u.test(prefix)) {
      continue;
    }
    let escaped = false;
    let inClass = false;
    for (let cursor = start + 1; cursor < content.length; cursor += 1) {
      const character = content[cursor];
      if (character === "\n" || character === "\r") break;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "[" && !inClass) {
        inClass = true;
        continue;
      }
      if (character === "]" && inClass) {
        inClass = false;
        continue;
      }
      if (character !== "/" || inClass) continue;
      let end = cursor + 1;
      while (end < content.length && /[dgimsuvy]/u.test(content[end])) end += 1;
      if (/[A-Za-z0-9_$]/u.test(content[end] ?? "")) break;
      const body = content.slice(start + 1, cursor);
      const linePrefix = content.slice(Math.max(0, content.lastIndexOf("\n", start - 1) + 1), start);
      const knownRegexMember = /^\.(?:compile|dotAll|exec|flags|global|hasIndices|ignoreCase|multiline|source|sticky|test|toString|unicode|unicodeSets)\b/u
        .test(content.slice(end));
      const strongJavaScriptContext = /(?:\b(?:case|const|let|return|throw|var|yield)\b[^=;]*=|=>|\b(?:case|return|throw|yield))\s*$/u
        .test(linePrefix);
      if (!/[\\^$.*+?()[\]{}|]/u.test(body) && !knownRegexMember && !strongJavaScriptContext) {
        break;
      }
      ranges.push([start, end]);
      start = end - 1;
      break;
    }
  }
  return ranges;
}

function sensitivePosixPath(value) {
  if (/^\/root(?:\/|$)/iu.test(value)) return true;
  if (/^\/(?:Users|home)\/[^/]+(?:\/|$)/iu.test(value)) return true;
  if (/^\/Volumes\/[^/]+(?:\/|$)/iu.test(value)) return true;
  return /^\/(?:private\/)?var\/folders\/[^/]+(?:\/|$)/iu.test(value);
}

function containsSensitivePosixAbsolutePath(content) {
  const regexRanges = javascriptRegexRanges(content);
  let masked = "";
  let cursor = 0;
  for (const [start, end] of regexRanges) {
    masked += content.slice(cursor, start);
    masked += " ".repeat(end - start);
    cursor = end;
  }
  masked += content.slice(cursor);
  for (const match of masked.matchAll(POSIX_ABSOLUTE_PATH_PATTERN)) {
    if (sensitivePosixPath(match[1] ?? "")) return true;
  }
  for (const match of masked.matchAll(MARKDOWN_ANGLE_ABSOLUTE_PATH_PATTERN)) {
    const value = match[0].slice(3, -1);
    if (sensitivePosixPath(value)) return true;
  }
  return false;
}

function containsSensitiveFileUrl(content) {
  for (const match of content.matchAll(FILE_URL_PATH_PATTERN)) {
    if (/^file:\/\/(?!\/|localhost(?:\/|$))/iu.test(match[0]) ||
        /^file:\/{4,}/iu.test(match[0])) {
      return true;
    }
    const value = match[0].replace(/^file:\/\/(?:localhost)?/iu, "");
    if (sensitivePosixPath(value)) return true;
  }
  return false;
}

function containsSensitiveWindowsPath(content) {
  const found = WINDOWS_USER_PATH_PATTERN.test(content) ||
    WINDOWS_FORWARD_USER_PATH_PATTERN.test(content);
  WINDOWS_USER_PATH_PATTERN.lastIndex = 0;
  WINDOWS_FORWARD_USER_PATH_PATTERN.lastIndex = 0;
  return found;
}

function containsUncPath(content) {
  const found = WINDOWS_UNC_PATH_PATTERN.test(content);
  WINDOWS_UNC_PATH_PATTERN.lastIndex = 0;
  return found;
}

function containsFeishuResourceIdentifier(content) {
  const found = FEISHU_ID_PATTERN.test(content) ||
    FEISHU_TOKEN_PATTERN.test(content) ||
    FEISHU_RESOURCE_URL_PATTERN.test(content);
  FEISHU_ID_PATTERN.lastIndex = 0;
  FEISHU_TOKEN_PATTERN.lastIndex = 0;
  FEISHU_RESOURCE_URL_PATTERN.lastIndex = 0;
  return found;
}

function containsPrivateDomain(content) {
  for (const match of content.matchAll(PRIVATE_DOMAIN_PATTERN)) {
    const isLocalEnvironmentFilename = content[match.index - 1] === "." &&
      match[0].toLowerCase() === ["env", "local"].join(".");
    if (!isLocalEnvironmentFilename) return true;
  }
  return false;
}

function obviousCodeExpression(value) {
  return /^(?:this|config|process\.env)(?:(?:\?\.|\.)[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(value) ||
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) ||
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\(/u.test(value);
}

function addFinding(findings, code) {
  if (!findings.some((finding) => finding.code === code)) findings.push({ code });
}

function withoutSha256Digests(content) {
  return content.replace(/\b[A-Fa-f0-9]{64}\b/gu, "");
}

function scanText(content, policy, relativePath, { ignoreSha256DigestIdentifiers = false } = {}) {
  const findings = [];
  const lowered = content.toLowerCase();
  for (const literal of policy.forbidden_literals) {
    if (lowered.includes(literal.toLowerCase())) addFinding(findings, "forbidden-literal");
  }
  for (const domain of policy.private_domains) {
    if (lowered.includes(domain.toLowerCase())) addFinding(findings, "private-domain");
  }
  for (const match of content.matchAll(EMAIL_PATTERN)) {
    if (match[1]?.toLowerCase() !== "example.invalid") addFinding(findings, "email-address");
  }
  const personalIdentifierContent = ignoreSha256DigestIdentifiers
    ? withoutSha256Digests(content)
    : content;
  if (PHONE_PATTERN.test(personalIdentifierContent)) addFinding(findings, "phone-number");
  PHONE_PATTERN.lastIndex = 0;
  if (CHINESE_ID_PATTERN.test(personalIdentifierContent)) addFinding(findings, "chinese-id-number");
  CHINESE_ID_PATTERN.lastIndex = 0;
  if (PRIVATE_IPV4_PATTERN.test(content)) addFinding(findings, "private-ip-address");
  PRIVATE_IPV4_PATTERN.lastIndex = 0;
  const normalizedWindowsContent = content.replace(/\\\\/gu, "\\");
  if (
    containsSensitivePosixAbsolutePath(content) ||
    containsSensitiveFileUrl(content) ||
    containsSensitiveWindowsPath(normalizedWindowsContent) ||
    containsUncPath(content) ||
    containsUncPath(normalizedWindowsContent)
  ) {
    addFinding(findings, "absolute-local-path");
  }
  if (containsPrivateDomain(content)) addFinding(findings, "private-domain");
  if (containsFeishuResourceIdentifier(content)) {
    addFinding(findings, "feishu-resource-identifier");
  }
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    if (pattern.test(content)) addFinding(findings, "known-secret-shape");
    pattern.lastIndex = 0;
  }
  if (AUTHORIZATION_SECRET_PATTERN.test(content)) addFinding(findings, "known-secret-shape");
  AUTHORIZATION_SECRET_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(CLI_SECRET_OPTION_PATTERN)) {
    if (!obviousPlaceholder(match[1] ?? "")) addFinding(findings, "known-secret-shape");
  }
  for (const match of content.matchAll(SENSITIVE_ASSIGNMENT_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    const unquotedCodeExpression = CODE_SOURCE_PATH_PATTERN.test(relativePath) &&
      match[3] !== undefined && obviousCodeExpression(value);
    if (!obviousPlaceholder(value) && !unquotedCodeExpression && entropy(value) >= 3.5) {
      addFinding(findings, "high-entropy-credential");
    }
  }
  return findings;
}

function normalizedRelativePath(value) {
  return typeof value === "string" && value.length > 0 &&
    !path.posix.isAbsolute(value) && !value.includes("\\") &&
    value !== "." && value !== ".." && !value.startsWith("../") &&
    path.posix.normalize(value) === value;
}

function sensitivePrivatePath(value) {
  const lowered = value.toLowerCase();
  return SENSITIVE_PRIVATE_PATH_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

function scanBuffer(relativePath, buffer, policy, findings, stage) {
  if (sensitivePrivatePath(relativePath)) {
    findings.push({ code: "sensitive-private-path", path: relativePath });
  }
  let content;
  try {
    content = UTF8_DECODER.decode(buffer);
  } catch {
    findings.push({ code: "non-utf8-content", path: relativePath });
    return;
  }
  for (const finding of scanText(content, policy, relativePath, {
    ignoreSha256DigestIdentifiers: stage === "candidate-metadata" &&
      CANDIDATE_METADATA_PATHS.has(relativePath)
  })) {
    findings.push({ ...finding, path: relativePath });
  }
}

export async function scanPublicBuffers({ files, policy, stage }) {
  validatePrivateScanPolicy(policy);
  if (typeof stage !== "string" || !stage) throw new TypeError("scan stage is required");
  if (!Array.isArray(files)) throw new TypeError("scan files must be an array");
  const findings = [];
  let bytesScanned = 0;
  for (const entry of files) {
    const relativePath = entry?.path;
    if (!normalizedRelativePath(relativePath)) {
      findings.push({ code: "unsafe-scan-path", path: "<invalid>" });
      continue;
    }
    if (!Buffer.isBuffer(entry?.content)) {
      findings.push({ code: "file-read-failed", path: relativePath });
      continue;
    }
    bytesScanned += entry.content.length;
    scanBuffer(relativePath, entry.content, policy, findings, stage);
  }
  return {
    scanner_version: SCANNER_VERSION,
    stage,
    file_count: files.length,
    bytes_scanned: bytesScanned,
    finding_count: findings.length,
    findings
  };
}

export async function scanPublicFiles({ root, files, policy, stage }) {
  validatePrivateScanPolicy(policy);
  if (typeof stage !== "string" || !stage) throw new TypeError("scan stage is required");
  if (!Array.isArray(files)) throw new TypeError("scan files must be an array");
  const findings = [];
  let bytesScanned = 0;
  for (const entry of files) {
    const relativePath = typeof entry === "string" ? entry : entry?.path;
    if (!normalizedRelativePath(relativePath)) {
      findings.push({ code: "unsafe-scan-path", path: "<invalid>" });
      continue;
    }
    const target = path.join(root, ...relativePath.split("/"));
    let metadata;
    let buffer;
    try {
      metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        findings.push({ code: "non-regular-file", path: relativePath });
        continue;
      }
      buffer = await readFile(target);
    } catch {
      findings.push({ code: "file-read-failed", path: relativePath });
      continue;
    }
    bytesScanned += buffer.length;
    scanBuffer(relativePath, buffer, policy, findings, stage);
  }
  return {
    scanner_version: SCANNER_VERSION,
    stage,
    file_count: files.length,
    bytes_scanned: bytesScanned,
    finding_count: findings.length,
    findings
  };
}

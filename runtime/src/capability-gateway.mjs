const RESULT_STATUSES = new Set([
  "complete",
  "unavailable",
  "denied",
  "unauthenticated",
  "unauthorized",
  "timeout",
  "invalid-input",
  "failed",
  "empty-result"
]);
const LOOKUP_MAX_BYTES = 8 * 1024;
const LOOKUP_MAX_DATA_BYTES = 5 * 1024;
const LOOKUP_MAX_SOURCE_BYTES = 2 * 1024;
const LOOKUP_MAX_DEPTH = 5;
const LOOKUP_MAX_ARRAY_ITEMS = 20;
const LOOKUP_MAX_OBJECT_FIELDS = 40;
const LOOKUP_MAX_STRING_BYTES = 4 * 1024;
const LOOKUP_MAX_SOURCE_REFS = 10;
const LOOKUP_MAX_SOURCE_REF_BYTES = 2 * 1024;
const LOOKUP_MAX_CAPABILITY_BYTES = 128;
const LOOKUP_MAX_OPERATION_BYTES = 128;
const LOOKUP_MAX_REASON_BYTES = 512;
const LOOKUP_TIMEOUT = Symbol("capability lookup timeout");
const TRUST_ZONES = new Set(["public", "internal"]);
const ALLOWED_SOURCE_PROTOCOLS = new Set(["fixture:", "http:", "https:"]);
const SENSITIVE_RESULT_PATTERNS = Object.freeze([
  /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|private[-_ ]?key|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/u
]);
const PRIVATE_RESULT_FIELDS = new Set([
  "access_token",
  "adapter",
  "adapter_name",
  "api_key",
  "authorization",
  "client_secret",
  "cookie",
  "credential",
  "credential_ref",
  "credentials",
  "endpoint",
  "local_path",
  "mcp",
  "mcp_name",
  "mcp_server",
  "password",
  "private_config",
  "raw_error",
  "secret",
  "server",
  "server_name",
  "stderr",
  "token",
  "tool",
  "tool_name",
  "transport",
  "transport_config"
]);
const PRIVATE_RESULT_FIELD_SEGMENTS = new Set([
  "adapter",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "endpoint",
  "key",
  "mcp",
  "password",
  "private",
  "secret",
  "server",
  "stderr",
  "token",
  "tool",
  "transport"
]);

function nonEmptyText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function boundedNonEmptyText(value, name, maxBytes) {
  const text = nonEmptyText(value, name);
  if (Buffer.byteLength(text) > maxBytes) {
    throw new TypeError(`${name} must not exceed ${maxBytes} bytes`);
  }
  return text;
}

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isStructuredValue(value, { depth = 0, seen = new Set() } = {}) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return Buffer.byteLength(value) <= LOOKUP_MAX_STRING_BYTES;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= LOOKUP_MAX_DEPTH || !value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.length <= LOOKUP_MAX_ARRAY_ITEMS && value.every((item) => isStructuredValue(item, {
      depth: depth + 1,
      seen
    }));
  }
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  const entries = Object.entries(value);
  return (prototype === Object.prototype || prototype === null) &&
    entries.length <= LOOKUP_MAX_OBJECT_FIELDS &&
    entries.every(([key, item]) => Buffer.byteLength(key) <= 128 && isStructuredValue(item, {
      depth: depth + 1,
      seen
    }));
}

function isBoundedStructuredValue(value) {
  if (!isStructuredValue(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= LOOKUP_MAX_BYTES;
  } catch {
    return false;
  }
}

function privateResultField(key) {
  const normalized = key
    .trim()
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/[-_\s]+/gu, "_")
    .toLowerCase();
  return PRIVATE_RESULT_FIELDS.has(normalized) ||
    normalized.split("_").some((segment) => PRIVATE_RESULT_FIELD_SEGMENTS.has(segment));
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) return "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function containsSensitiveResultValue(value) {
  return SENSITIVE_RESULT_PATTERNS.some((pattern) => pattern.test(value));
}

function projectAdapterData(value, {
  depth = 0,
  maxBytes = LOOKUP_MAX_DATA_BYTES,
  privacyViolation,
  truncation,
  ancestors = new Set()
} = {}) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    truncation.value = true;
    return null;
  }
  if (typeof value === "string") {
    if (containsSensitiveResultValue(value)) {
      privacyViolation.value = true;
      return null;
    }
    const projected = truncateUtf8(
      value,
      Math.min(maxBytes, LOOKUP_MAX_STRING_BYTES)
    );
    if (projected !== value) truncation.value = true;
    return projected;
  }
  if (depth >= LOOKUP_MAX_DEPTH || !value || typeof value !== "object") {
    truncation.value = true;
    return null;
  }
  if (ancestors.has(value)) {
    truncation.value = true;
    return null;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const projected = [];
      const limit = Math.min(value.length, LOOKUP_MAX_ARRAY_ITEMS);
      for (let index = 0; index < limit; index += 1) {
        const remainingItems = limit - index;
        const remainingBytes = Math.max(16, maxBytes - jsonBytes(projected));
        const item = projectAdapterData(value[index], {
          depth: depth + 1,
          maxBytes: Math.max(16, Math.floor(remainingBytes / remainingItems)),
          privacyViolation,
          truncation,
          ancestors
        });
        const candidate = [...projected, item];
        if (jsonBytes(candidate) > maxBytes) {
          truncation.value = true;
          break;
        }
        projected.push(item);
      }
      if (projected.length < value.length) truncation.value = true;
      return projected;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      truncation.value = true;
      return null;
    }
    const projected = {};
    const entries = Object.entries(value).filter(([key]) => !privateResultField(key));
    const limit = Math.min(entries.length, LOOKUP_MAX_OBJECT_FIELDS);
    for (let index = 0; index < limit; index += 1) {
      const [rawKey, child] = entries[index];
      const key = truncateUtf8(rawKey, 128);
      if (key !== rawKey) truncation.value = true;
      const remainingFields = limit - index;
      const remainingBytes = Math.max(16, maxBytes - jsonBytes(projected));
      const childValue = projectAdapterData(child, {
        depth: depth + 1,
        maxBytes: Math.max(16, Math.floor(remainingBytes / remainingFields)),
        privacyViolation,
        truncation,
        ancestors
      });
      const candidate = { ...projected, [key]: childValue };
      if (jsonBytes(candidate) > maxBytes) {
        truncation.value = true;
        break;
      }
      projected[key] = childValue;
    }
    if (Object.keys(projected).length < entries.length) truncation.value = true;
    return projected;
  } finally {
    ancestors.delete(value);
  }
}

function projectSourceRef(sourceRef) {
  if (/^(?:file:|[\\/]|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:)/iu.test(sourceRef)) return null;
  let url;
  try {
    url = new URL(sourceRef);
  } catch {
    return null;
  }
  if (!ALLOWED_SOURCE_PROTOCOLS.has(url.protocol)) return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function projectSourceRefs(sourceRefs, truncation) {
  if (sourceRefs === undefined) return [];
  if (
    !Array.isArray(sourceRefs) ||
    sourceRefs.some((sourceRef) => typeof sourceRef !== "string" || sourceRef.length === 0)
  ) {
    return null;
  }
  const projected = [];
  for (let index = 0; index < sourceRefs.length; index += 1) {
    if (projected.length >= LOOKUP_MAX_SOURCE_REFS) {
      truncation.value = true;
      break;
    }
    const sanitized = projectSourceRef(sourceRefs[index]);
    if (sanitized === null) {
      truncation.value = true;
      continue;
    }
    const bounded = truncateUtf8(sanitized, LOOKUP_MAX_SOURCE_REF_BYTES);
    if (bounded !== sanitized) truncation.value = true;
    const candidate = [...projected, bounded];
    if (jsonBytes(candidate) > LOOKUP_MAX_SOURCE_BYTES) {
      truncation.value = true;
      break;
    }
    projected.push(bounded);
  }
  return projected;
}

function projectTrustedContext(trustZone, trustedContext) {
  if (trustZone !== "public") return undefined;
  return typeof trustedContext?.current_message_text === "string"
    ? { current_message_text: trustedContext.current_message_text }
    : undefined;
}

function trustedRequestSourceRefs(request, trustedContext) {
  const currentMessageText = trustedContext?.current_message_text;
  if (typeof currentMessageText !== "string" || currentMessageText.length === 0) return [];
  const sourceRefs = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      let url;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        currentMessageText.includes(value)
      ) {
        sourceRefs.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(request.input);
  return [...sourceRefs];
}

function supplementTrustedSourceRefs(request, result, trustedContext) {
  if (
    !result ||
    result.status !== "complete" ||
    (result.source_refs !== undefined && (
      !Array.isArray(result.source_refs) ||
      result.source_refs.length > 0
    ))
  ) {
    return result;
  }
  const sourceRefs = trustedRequestSourceRefs(request, trustedContext);
  return sourceRefs.length > 0 ? { ...result, source_refs: sourceRefs } : result;
}

function lookupTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 120000");
  }
  return value;
}

export function validateCapabilityLookupRequest(request) {
  if (!exactFields(request, ["capability", "operation", "input", "reason"])) {
    throw new TypeError("capability lookup request has invalid fields");
  }
  boundedNonEmptyText(
    request.capability,
    "request.capability",
    LOOKUP_MAX_CAPABILITY_BYTES
  );
  boundedNonEmptyText(
    request.operation,
    "request.operation",
    LOOKUP_MAX_OPERATION_BYTES
  );
  boundedNonEmptyText(request.reason, "request.reason", LOOKUP_MAX_REASON_BYTES);
  if (
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input) ||
    !isBoundedStructuredValue(request.input)
  ) {
    throw new TypeError("request.input must be a structured object");
  }
  return structuredClone(request);
}

function validateCapability(capability) {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw new TypeError("capability must be an object");
  }
  const snapshot = {
    capability: nonEmptyText(capability.capability, "capability.capability"),
    purpose: nonEmptyText(capability.purpose, "capability.purpose"),
    operations: structuredClone(capability.operations),
    risk: capability.risk,
    trust_zone: nonEmptyText(capability.trust_zone, "capability.trust_zone"),
    readiness: capability.readiness,
    input_description: nonEmptyText(
      capability.input_description,
      "capability.input_description"
    )
  };
  if (
    !Array.isArray(snapshot.operations) ||
    snapshot.operations.length === 0 ||
    snapshot.operations.some((operation) => typeof operation !== "string" || operation.length === 0)
  ) {
    throw new TypeError("capability.operations must contain non-empty strings");
  }
  if (snapshot.risk !== "read") throw new TypeError("capability.risk must be read");
  if (!TRUST_ZONES.has(snapshot.trust_zone)) {
    throw new TypeError("capability.trust_zone must be public or internal");
  }
  if (!new Set(["ready", "unavailable"]).has(snapshot.readiness)) {
    throw new TypeError("capability.readiness is invalid");
  }
  return snapshot;
}

function stableResult(request, status, values = {}) {
  const result = {
    capability: request.capability,
    operation: request.operation,
    status
  };
  if (status === "complete") {
    result.data = structuredClone(values.data);
    result.source_refs = structuredClone(values.source_refs ?? []);
    if (values.truncated === true) result.truncated = true;
  }
  return result;
}

export function normalizeCapabilityAdapterResult(request, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return stableResult(request, "failed");
  }
  if (!RESULT_STATUSES.has(result.status)) return stableResult(request, "failed");
  if (result.status !== "complete") return stableResult(request, result.status);
  if (result.data === undefined) return stableResult(request, "failed");
  const privacyViolation = { value: false };
  const truncation = { value: false };
  const data = projectAdapterData(result.data, { privacyViolation, truncation });
  if (privacyViolation.value) return stableResult(request, "failed");
  const sourceRefs = projectSourceRefs(result.source_refs, truncation);
  if (sourceRefs === null) return stableResult(request, "failed");
  const projected = stableResult(request, "complete", {
    data,
    source_refs: sourceRefs,
    truncated: truncation.value
  });
  return jsonBytes(projected) <= LOOKUP_MAX_BYTES
    ? projected
    : stableResult(request, "failed");
}

export class CapabilityGateway {
  constructor({ capabilities = [], adapters = new Map(), timeoutMs = 5000 } = {}) {
    if (!Array.isArray(capabilities)) throw new TypeError("capabilities must be an array");
    if (!(adapters instanceof Map)) throw new TypeError("adapters must be a Map");
    this.timeoutMs = lookupTimeout(timeoutMs);
    this.capabilities = new Map();
    for (const capability of capabilities) {
      const snapshot = validateCapability(capability);
      if (this.capabilities.has(snapshot.capability)) {
        throw new TypeError("capability identifiers must be unique");
      }
      const adapter = adapters.get(snapshot.capability);
      if (adapter !== undefined && typeof adapter?.lookup !== "function") {
        throw new TypeError("capability adapter.lookup is required");
      }
      this.capabilities.set(snapshot.capability, { snapshot, adapter });
    }
  }

  snapshot() {
    return [...this.capabilities.values()].map(({ snapshot }) => structuredClone(snapshot));
  }

  async lookup(rawRequest, trustedContext) {
    let request;
    try {
      request = validateCapabilityLookupRequest(rawRequest);
    } catch {
      return stableResult({
        capability: typeof rawRequest?.capability === "string" && rawRequest.capability.length > 0
          ? rawRequest.capability
          : "unknown",
        operation: typeof rawRequest?.operation === "string" && rawRequest.operation.length > 0
          ? rawRequest.operation
          : "unknown"
      }, "invalid-input");
    }
    const registered = this.capabilities.get(request.capability);
    if (!registered || registered.snapshot.readiness !== "ready" || !registered.adapter) {
      return stableResult(request, "unavailable");
    }
    if (!registered.snapshot.operations.includes(request.operation)) {
      return stableResult(request, "invalid-input");
    }
    let timer;
    try {
      const result = await Promise.race([
        registered.adapter.lookup(
          request,
          projectTrustedContext(registered.snapshot.trust_zone, trustedContext)
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(LOOKUP_TIMEOUT), this.timeoutMs);
        })
      ]);
      if (result === LOOKUP_TIMEOUT) return stableResult(request, "timeout");
      return normalizeCapabilityAdapterResult(
        request,
        supplementTrustedSourceRefs(request, result, trustedContext)
      );
    } catch {
      return stableResult(request, "failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FakeCapabilityAdapter {
  constructor(handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.handler = handler;
  }

  async lookup(request) {
    return structuredClone(await this.handler(structuredClone(request)));
  }
}

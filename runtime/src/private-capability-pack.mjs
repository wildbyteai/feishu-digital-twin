const PACK_FIELDS = Object.freeze([
  "actions",
  "capabilities",
  "pack_id",
  "pack_version",
  "readiness_check",
  "schema_version",
  "server_ref",
  "tools"
]);
const TOOL_FIELDS = Object.freeze(["name", "risk"]);
const CAPABILITY_FIELDS = Object.freeze([
  "capability",
  "failure_policy",
  "input_description",
  "operations",
  "purpose",
  "risk",
  "trust_zone"
]);
const OPERATION_FIELDS = Object.freeze([
  "input_constraints",
  "operation",
  "tool"
]);
const INPUT_CONSTRAINT_FIELDS = Object.freeze([
  "allowed_fields",
  "max_bytes",
  "required_fields"
]);
const ACTION_FIELDS = Object.freeze([
  "capability",
  "confirmation",
  "confirm_tool",
  "failure_policy",
  "input_constraints",
  "input_description",
  "operation",
  "prepare_tool",
  "purpose",
  "trust_zone"
]);
const CONFIRMATION_FIELDS = Object.freeze([
  "passthrough_fields",
  "phrase_argument",
  "phrase_field",
  "token_argument",
  "token_field"
]);
const READINESS_CHECK_FIELDS = Object.freeze(["tool"]);
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PACK_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_INPUT_DESCRIPTION_BYTES = 1024;
const TRUSTED_READINESS_CHECKS = Symbol("trusted private capability readiness checks");
const READ_OPERATIONS = new Set([
  "fetch",
  "get",
  "inspect",
  "list",
  "lookup",
  "read",
  "search"
]);
const TRUSTED_READ_ONLY_TOOLS = Symbol("trusted read-only MCP tools");
const TRUSTED_TOOL_RISKS = Symbol("trusted MCP tool risks");

function requireExactObject(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has invalid fields`);
  }
  return value;
}

function requirePack(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pack must be an object");
  }
  const allowed = new Set(PACK_FIELDS);
  const required = PACK_FIELDS.filter((field) => (
    field !== "actions" && field !== "readiness_check"
  ));
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    required.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new TypeError("pack has invalid fields");
  }
  return value;
}

function requireText(value, name, { pattern } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) throw new TypeError(`${name} has an invalid format`);
  return value;
}

function requireBoundedText(value, name, maxBytes) {
  const text = requireText(value, name);
  if (Buffer.byteLength(text) > maxBytes) {
    throw new TypeError(`${name} must not exceed ${maxBytes} bytes`);
  }
  return text;
}

function requireUniqueTextArray(value, name, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${nonEmpty ? "a non-empty " : "an "}array`);
  }
  value.forEach((item, index) => requireText(item, `${name}[${index}]`, {
    pattern: PORTABLE_ID
  }));
  if (new Set(value).size !== value.length) throw new TypeError(`${name} must be unique`);
  return structuredClone(value);
}

function validateInputConstraints(value, name) {
  const constraints = requireExactObject(value, INPUT_CONSTRAINT_FIELDS, name);
  const allowedFields = requireUniqueTextArray(
    constraints.allowed_fields,
    `${name}.allowed_fields`
  );
  const requiredFields = requireUniqueTextArray(
    constraints.required_fields,
    `${name}.required_fields`,
    { nonEmpty: false }
  );
  if (requiredFields.some((field) => !allowedFields.includes(field))) {
    throw new TypeError(`${name}.required_fields must be allowed`);
  }
  if (
    !Number.isInteger(constraints.max_bytes) ||
    constraints.max_bytes < 1 ||
    constraints.max_bytes > MAX_INPUT_BYTES
  ) {
    throw new TypeError(`${name}.max_bytes must be between 1 and ${MAX_INPUT_BYTES}`);
  }
  return {
    allowed_fields: allowedFields,
    required_fields: requiredFields,
    max_bytes: constraints.max_bytes
  };
}

function validateTool(value, index) {
  const name = `pack.tools[${index}]`;
  const tool = requireExactObject(value, TOOL_FIELDS, name);
  requireText(tool.name, `${name}.name`, { pattern: PORTABLE_ID });
  if (!new Set(["read", "prepare", "write"]).has(tool.risk)) {
    throw new TypeError(`${name}.risk must be read, prepare, or write`);
  }
  return structuredClone(tool);
}

function validateReadinessCheck(value) {
  const readiness = requireExactObject(
    value,
    READINESS_CHECK_FIELDS,
    "pack.readiness_check"
  );
  return {
    tool: requireText(readiness.tool, "pack.readiness_check.tool", {
      pattern: PORTABLE_ID
    })
  };
}

function validateAction(value, index) {
  const name = `pack.actions[${index}]`;
  const action = requireExactObject(value, ACTION_FIELDS, name);
  const confirmation = requireExactObject(
    action.confirmation,
    CONFIRMATION_FIELDS,
    `${name}.confirmation`
  );
  const validated = {
    capability: requireText(action.capability, `${name}.capability`, { pattern: PORTABLE_ID }),
    operation: requireText(action.operation, `${name}.operation`, { pattern: PORTABLE_ID }),
    purpose: requireText(action.purpose, `${name}.purpose`),
    prepare_tool: requireText(action.prepare_tool, `${name}.prepare_tool`, { pattern: PORTABLE_ID }),
    confirm_tool: requireText(action.confirm_tool, `${name}.confirm_tool`, { pattern: PORTABLE_ID }),
    input_constraints: validateInputConstraints(
      action.input_constraints,
      `${name}.input_constraints`
    ),
    confirmation: {
      token_field: requireText(confirmation.token_field, `${name}.confirmation.token_field`, {
        pattern: PORTABLE_ID
      }),
      phrase_field: requireText(confirmation.phrase_field, `${name}.confirmation.phrase_field`, {
        pattern: PORTABLE_ID
      }),
      token_argument: requireText(
        confirmation.token_argument,
        `${name}.confirmation.token_argument`,
        { pattern: PORTABLE_ID }
      ),
      phrase_argument: requireText(
        confirmation.phrase_argument,
        `${name}.confirmation.phrase_argument`,
        { pattern: PORTABLE_ID }
      ),
      passthrough_fields: requireUniqueTextArray(
        confirmation.passthrough_fields,
        `${name}.confirmation.passthrough_fields`,
        { nonEmpty: false }
      )
    },
    trust_zone: action.trust_zone,
    input_description: requireBoundedText(
      action.input_description,
      `${name}.input_description`,
      MAX_INPUT_DESCRIPTION_BYTES
    ),
    failure_policy: action.failure_policy
  };
  if (validated.prepare_tool === validated.confirm_tool) {
    throw new TypeError(`${name} prepare and confirm tools must differ`);
  }
  if (validated.confirmation.passthrough_fields.some((field) => (
    !validated.input_constraints.allowed_fields.includes(field)
  ))) {
    throw new TypeError(`${name}.confirmation passthrough fields must be allowed inputs`);
  }
  if (validated.trust_zone !== "internal") {
    throw new TypeError(`${name}.trust_zone must be internal`);
  }
  if (validated.failure_policy !== "human-fallback") {
    throw new TypeError(`${name}.failure_policy must be human-fallback`);
  }
  return validated;
}

function validateCapability(value, index) {
  const name = `pack.capabilities[${index}]`;
  const capability = requireExactObject(value, CAPABILITY_FIELDS, name);
  requireText(capability.capability, `${name}.capability`, { pattern: PORTABLE_ID });
  requireText(capability.purpose, `${name}.purpose`);
  requireBoundedText(
    capability.input_description,
    `${name}.input_description`,
    MAX_INPUT_DESCRIPTION_BYTES
  );
  if (capability.risk !== "read") throw new TypeError(`${name}.risk must be read`);
  if (capability.trust_zone !== "internal") {
    throw new TypeError(`${name}.trust_zone must be internal`);
  }
  if (capability.failure_policy !== "human-fallback") {
    throw new TypeError(`${name}.failure_policy must be human-fallback`);
  }
  if (!Array.isArray(capability.operations) || capability.operations.length === 0) {
    throw new TypeError(`${name}.operations must be a non-empty array`);
  }
  const operations = capability.operations.map((value, operationIndex) => {
    const operationName = `${name}.operations[${operationIndex}]`;
    const operation = requireExactObject(value, OPERATION_FIELDS, operationName);
    const semanticOperation = requireText(operation.operation, `${operationName}.operation`, {
        pattern: PORTABLE_ID
      });
    if (!READ_OPERATIONS.has(semanticOperation)) {
      throw new TypeError(`${operationName}.operation must be read-only`);
    }
    return {
      operation: semanticOperation,
      tool: requireText(operation.tool, `${operationName}.tool`, { pattern: PORTABLE_ID }),
      input_constraints: validateInputConstraints(
        operation.input_constraints,
        `${operationName}.input_constraints`
      )
    };
  });
  if (new Set(operations.map(({ operation }) => operation)).size !== operations.length) {
    throw new TypeError(`${name}.operations must have unique operation names`);
  }
  return {
    capability: capability.capability,
    purpose: capability.purpose,
    operations,
    risk: capability.risk,
    trust_zone: capability.trust_zone,
    input_description: capability.input_description,
    failure_policy: capability.failure_policy
  };
}

export function validatePrivateCapabilityPack(value) {
  const pack = requirePack(value);
  if (pack.schema_version !== 1) throw new TypeError("pack.schema_version must be 1");
  requireText(pack.pack_id, "pack.pack_id", { pattern: PORTABLE_ID });
  requireText(pack.pack_version, "pack.pack_version", { pattern: PACK_VERSION });
  requireText(pack.server_ref, "pack.server_ref", { pattern: PORTABLE_ID });
  if (!Array.isArray(pack.tools) || pack.tools.length === 0) {
    throw new TypeError("pack.tools must be a non-empty array");
  }
  if (!Array.isArray(pack.capabilities)) {
    throw new TypeError("pack.capabilities must be an array");
  }
  if (pack.actions !== undefined && !Array.isArray(pack.actions)) {
    throw new TypeError("pack.actions must be an array");
  }
  if (pack.capabilities.length === 0 && (pack.actions?.length ?? 0) === 0) {
    throw new TypeError("pack must declare at least one capability or action");
  }
  const tools = pack.tools.map(validateTool);
  if (new Set(tools.map(({ name }) => name)).size !== tools.length) {
    throw new TypeError("pack.tools must have unique names");
  }
  const capabilities = pack.capabilities.map(validateCapability);
  if (new Set(capabilities.map(({ capability }) => capability)).size !== capabilities.length) {
    throw new TypeError("pack.capabilities must have unique identifiers");
  }
  const actions = (pack.actions ?? []).map(validateAction);
  if (new Set(actions.map(({ capability }) => capability)).size !== actions.length) {
    throw new TypeError("pack.actions must have unique capability identifiers");
  }
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const readinessCheck = pack.readiness_check === undefined
    ? undefined
    : validateReadinessCheck(pack.readiness_check);
  const allowedTools = new Set(toolsByName.keys());
  const referencedTools = new Set(capabilities.flatMap(({ operations }) =>
    operations.map(({ tool }) => tool)
  ));
  const actionTools = actions.flatMap(({ prepare_tool: prepareTool, confirm_tool: confirmTool }) => (
    [prepareTool, confirmTool]
  ));
  const toolMappings = [
    ...capabilities.flatMap(({ operations }) => operations.map(({ tool }) => tool)),
    ...actionTools,
    ...(readinessCheck ? [readinessCheck.tool] : [])
  ];
  actionTools.forEach((tool) => referencedTools.add(tool));
  if (readinessCheck) referencedTools.add(readinessCheck.tool);
  if (referencedTools.size !== toolMappings.length) {
    throw new TypeError("pack tools must map to exactly one capability operation");
  }
  if ([...referencedTools].some((tool) => !allowedTools.has(tool))) {
    throw new TypeError("pack capability operation uses a tool outside the allowlist");
  }
  if ([...allowedTools].some((tool) => !referencedTools.has(tool))) {
    throw new TypeError("pack tool allowlist must contain only mapped tools");
  }
  for (const capability of capabilities) {
    for (const operation of capability.operations) {
      if (toolsByName.get(operation.tool)?.risk !== "read") {
        throw new TypeError("read capability tool must declare read risk");
      }
    }
  }
  for (const action of actions) {
    if (toolsByName.get(action.prepare_tool)?.risk !== "prepare") {
      throw new TypeError("action prepare tool must declare prepare risk");
    }
    if (toolsByName.get(action.confirm_tool)?.risk !== "write") {
      throw new TypeError("action confirm tool must declare write risk");
    }
  }
  if (readinessCheck && toolsByName.get(readinessCheck.tool)?.risk !== "read") {
    throw new TypeError("readiness check tool must declare read risk");
  }
  return {
    schema_version: 1,
    pack_id: pack.pack_id,
    pack_version: pack.pack_version,
    server_ref: pack.server_ref,
    tools,
    capabilities,
    ...(pack.actions === undefined ? {} : { actions }),
    ...(readinessCheck === undefined ? {} : { readiness_check: readinessCheck })
  };
}

function validateAdapterInput(input, constraints) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  if (keys.some((key) => !constraints.allowed_fields.includes(key))) return false;
  if (constraints.required_fields.some((key) => !Object.hasOwn(input, key))) return false;
  try {
    return Buffer.byteLength(JSON.stringify(input)) <= constraints.max_bytes;
  } catch {
    return false;
  }
}

function normalizeMcpToolResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { status: "failed" };
  }
  if (typeof result.status === "string") return structuredClone(result);
  if (result.isError === true) return { status: "failed" };
  if (result.content !== undefined && !Array.isArray(result.content)) {
    return { status: "failed" };
  }
  const texts = [];
  const sourceRefs = [];
  for (const item of result.content ?? []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      texts.push(item.text);
    }
    if (
      item.type === "resource_link" &&
      typeof item.uri === "string" &&
      item.uri.length > 0
    ) {
      sourceRefs.push(item.uri);
    }
    if (item.type === "resource" && item.resource && typeof item.resource === "object") {
      if (typeof item.resource.text === "string" && item.resource.text.length > 0) {
        texts.push(item.resource.text);
      }
      if (typeof item.resource.uri === "string" && item.resource.uri.length > 0) {
        sourceRefs.push(item.resource.uri);
      }
    }
  }
  let data;
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    data = structuredClone(result.structuredContent);
  } else if (texts.length === 1) {
    data = { content: texts[0] };
  } else if (texts.length > 1) {
    data = { content: texts };
  }
  if (data === undefined) return { status: "empty-result" };
  return {
    status: "complete",
    data,
    source_refs: [...new Set(sourceRefs)]
  };
}

export function privateCapabilityReadinessPassed(result) {
  const normalized = normalizeMcpToolResult(result);
  if (normalized.status !== "complete") return false;
  const data = normalized.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const code = typeof data.code === "string" ? data.code.toUpperCase() : "";
  return (data.ok === true || data.ready === true) &&
    data.authRequired !== true &&
    data.reauthRequired !== true &&
    code !== "AUTH_REQUIRED" &&
    code !== "UNAUTHENTICATED";
}

export function advertisedMcpToolRisks(result) {
  const tools = Array.isArray(result)
    ? result
    : Array.isArray(result?.tools)
      ? result.tools
      : null;
  if (tools === null) return null;
  const risks = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
    if (typeof tool.name !== "string" || tool.name.length === 0) return null;
    if (risks.has(tool.name)) return null;
    const readOnly = tool.annotations?.readOnlyHint;
    const destructive = tool.annotations?.destructiveHint;
    if (readOnly === true && destructive !== true) risks.set(tool.name, "read");
    else if (readOnly === false && destructive === false) risks.set(tool.name, "prepare");
    else if (readOnly === false && destructive === true) risks.set(tool.name, "write");
  }
  return risks;
}

function trustedServer(server, toolRisks, readinessChecks = new Map()) {
  const readOnlyTools = new Set([...toolRisks.entries()]
    .filter(([, risk]) => risk === "read")
    .map(([name]) => name));
  return Object.freeze({
    callTool: server.callTool.bind(server),
    [TRUSTED_READ_ONLY_TOOLS]: readOnlyTools,
    [TRUSTED_READINESS_CHECKS]: new Map(readinessChecks),
    [TRUSTED_TOOL_RISKS]: new Map(toolRisks)
  });
}

export async function checkPrivateCapabilityReadiness(server, readinessCheck, readOnlyTools) {
  if (readinessCheck === undefined) return true;
  if (!readOnlyTools.has(readinessCheck.tool)) return false;
  try {
    return privateCapabilityReadinessPassed(await server.callTool({
      name: readinessCheck.tool,
      arguments: {}
    }));
  } catch {
    return false;
  }
}

export async function resolvePrivateCapabilityServers({
  packs = [],
  resolveServer
} = {}) {
  if (!Array.isArray(packs)) throw new TypeError("packs must be an array");
  if (typeof resolveServer !== "function") {
    throw new TypeError("resolveServer must be a function");
  }
  const validatedPacks = packs.map(validatePrivateCapabilityPack);
  const serverRefs = [...new Set(validatedPacks.map(({ server_ref: serverRef }) => serverRef))];
  const servers = new Map();
  for (const serverRef of serverRefs) {
    const server = await resolveServer(serverRef);
    if (server === undefined) continue;
    if (typeof server?.callTool !== "function") {
      throw new TypeError("resolved MCP server callTool is required");
    }
    if (typeof server.listTools !== "function") continue;
    let toolRisks;
    try {
      toolRisks = advertisedMcpToolRisks(await server.listTools());
    } catch {
      continue;
    }
    if (toolRisks === null) continue;
    const readOnlyTools = new Set([...toolRisks.entries()]
      .filter(([, risk]) => risk === "read")
      .map(([name]) => name));
    const readinessChecks = new Map(validatedPacks
      .filter((pack) => pack.server_ref === serverRef && pack.readiness_check !== undefined)
      .map((pack) => [pack.readiness_check.tool, pack.readiness_check]));
    const readinessResults = new Map();
    for (const readinessCheck of readinessChecks.values()) {
      readinessResults.set(
        readinessCheck.tool,
        await checkPrivateCapabilityReadiness(server, readinessCheck, readOnlyTools)
      );
    }
    servers.set(serverRef, trustedServer(server, toolRisks, readinessResults));
  }
  return servers;
}

export class McpCapabilityAdapter {
  constructor({ server, capability, readOnlyTools, readinessCheck }) {
    if (typeof server?.callTool !== "function") {
      throw new TypeError("MCP server callTool is required");
    }
    if (!(readOnlyTools instanceof Set)) {
      throw new TypeError("trusted read-only MCP tools are required");
    }
    this.server = server;
    this.readOnlyTools = new Set(readOnlyTools);
    this.readinessCheck = readinessCheck === undefined
      ? undefined
      : structuredClone(readinessCheck);
    this.operations = new Map(capability.operations.map((operation) => [
      operation.operation,
      structuredClone(operation)
    ]));
  }

  async lookup(request) {
    const operation = this.operations.get(request.operation);
    if (
      !operation ||
      !this.readOnlyTools.has(operation.tool) ||
      !validateAdapterInput(request.input, operation.input_constraints)
    ) {
      return { status: "invalid-input" };
    }
    if (!await checkPrivateCapabilityReadiness(
      this.server,
      this.readinessCheck,
      this.readOnlyTools
    )) {
      return { status: "unavailable" };
    }
    return normalizeMcpToolResult(await this.server.callTool({
      name: operation.tool,
      arguments: structuredClone(request.input)
    }));
  }
}

class McpCapabilityActionAdapter {
  constructor({ server, action, toolRisks, readOnlyTools, readinessCheck }) {
    this.server = server;
    this.action = structuredClone(action);
    this.toolRisks = new Map(toolRisks);
    this.readOnlyTools = new Set(readOnlyTools);
    this.readinessCheck = readinessCheck === undefined
      ? undefined
      : structuredClone(readinessCheck);
  }

  async prepare(request) {
    if (
      request.operation !== this.action.operation ||
      this.toolRisks.get(this.action.prepare_tool) !== "prepare" ||
      !validateAdapterInput(request.input, this.action.input_constraints)
    ) {
      return { status: "invalid-input" };
    }
    if (!await checkPrivateCapabilityReadiness(
      this.server,
      this.readinessCheck,
      this.readOnlyTools
    )) {
      return { status: "unavailable" };
    }
    const normalized = normalizeMcpToolResult(await this.server.callTool({
      name: this.action.prepare_tool,
      arguments: structuredClone(request.input)
    }));
    if (normalized.status !== "complete") return normalized;
    const data = normalized.data;
    const proof = data?.[this.action.confirmation.token_field];
    const phrase = data?.[this.action.confirmation.phrase_field];
    if (
      data?.requiresUserConfirmation !== true ||
      typeof proof !== "string" ||
      proof.length === 0 ||
      typeof phrase !== "string" ||
      phrase.length === 0
    ) {
      return { status: "failed" };
    }
    const preview = structuredClone(data);
    delete preview[this.action.confirmation.token_field];
    delete preview[this.action.confirmation.phrase_field];
    delete preview.nextStep;
    const passthrough = Object.fromEntries(this.action.confirmation.passthrough_fields
      .filter((field) => Object.hasOwn(request.input, field))
      .map((field) => [field, structuredClone(request.input[field])]));
    return {
      status: "confirmation-required",
      preview,
      pending_action: { token: proof, phrase, passthrough }
    };
  }

  async confirm(payload, operation) {
    if (
      operation !== this.action.operation ||
      this.toolRisks.get(this.action.confirm_tool) !== "write" ||
      !requirePendingPayload(payload, this.action.confirmation.passthrough_fields)
    ) {
      return { status: "invalid-input" };
    }
    if (!await checkPrivateCapabilityReadiness(
      this.server,
      this.readinessCheck,
      this.readOnlyTools
    )) {
      return { status: "unavailable" };
    }
    return normalizeMcpToolResult(await this.server.callTool({
      name: this.action.confirm_tool,
      arguments: {
        [this.action.confirmation.token_argument]: payload.token,
        [this.action.confirmation.phrase_argument]: payload.phrase,
        ...structuredClone(payload.passthrough)
      }
    }));
  }
}

function requirePendingPayload(payload, passthroughFields) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (keys.join("\0") !== ["passthrough", "phrase", "token"].sort().join("\0")) return false;
  if (typeof payload.token !== "string" || payload.token.length === 0) return false;
  if (typeof payload.phrase !== "string" || payload.phrase.length === 0) return false;
  if (!payload.passthrough || typeof payload.passthrough !== "object" || Array.isArray(payload.passthrough)) {
    return false;
  }
  return Object.keys(payload.passthrough).every((field) => passthroughFields.includes(field));
}

export function compilePrivateCapabilityPacks({ packs = [], servers = new Map() } = {}) {
  if (!Array.isArray(packs)) throw new TypeError("packs must be an array");
  if (!(servers instanceof Map)) throw new TypeError("servers must be a Map");
  const validated = packs.map(validatePrivateCapabilityPack);
  if (new Set(validated.map(({ pack_id: packId }) => packId)).size !== validated.length) {
    throw new TypeError("private capability pack identifiers must be unique");
  }
  const mappedServerTools = new Set();
  for (const pack of validated) {
    for (const { operations } of pack.capabilities) {
      for (const { tool } of operations) {
        const mapping = `${pack.server_ref}\0${tool}`;
        if (mappedServerTools.has(mapping)) {
          throw new TypeError(
            "each server tool must map to exactly one semantic capability operation"
          );
        }
        mappedServerTools.add(mapping);
      }
    }
    for (const action of pack.actions ?? []) {
      for (const tool of [action.prepare_tool, action.confirm_tool]) {
        const mapping = `${pack.server_ref}\0${tool}`;
        if (mappedServerTools.has(mapping)) {
          throw new TypeError(
            "each server tool must map to exactly one semantic capability operation"
          );
        }
        mappedServerTools.add(mapping);
      }
    }
  }
  for (const pack of validated) {
    if (pack.readiness_check) {
      const mapping = `${pack.server_ref}\0${pack.readiness_check.tool}`;
      if (mappedServerTools.has(mapping)) {
        throw new TypeError(
          "readiness check tool must not map to a semantic capability operation"
        );
      }
    }
  }
  const capabilities = [];
  const adapters = new Map();
  const actionCapabilities = [];
  const actionAdapters = new Map();
  for (const pack of validated) {
    const server = servers.get(pack.server_ref);
    if (server !== undefined && typeof server?.callTool !== "function") {
      throw new TypeError("MCP server callTool is required");
    }
    const readOnlyTools = server?.[TRUSTED_READ_ONLY_TOOLS];
    const readinessChecks = server?.[TRUSTED_READINESS_CHECKS];
    const toolRisks = server?.[TRUSTED_TOOL_RISKS];
    const packReady = pack.readiness_check === undefined || (
      readinessChecks instanceof Map &&
      readinessChecks.get(pack.readiness_check.tool) === true
    );
    for (const capability of pack.capabilities) {
      if (capabilities.some((item) => item.capability === capability.capability)) {
        throw new TypeError("semantic capability identifiers must be unique");
      }
      const ready = packReady && readOnlyTools instanceof Set &&
        capability.operations.every(({ tool }) => readOnlyTools.has(tool));
      capabilities.push({
        capability: capability.capability,
        purpose: capability.purpose,
        operations: capability.operations.map(({ operation }) => operation),
        risk: capability.risk,
        trust_zone: capability.trust_zone,
        readiness: ready ? "ready" : "unavailable",
        input_description: capability.input_description
      });
      if (ready) {
        adapters.set(capability.capability, new McpCapabilityAdapter({
          server,
          capability,
          readOnlyTools,
          readinessCheck: pack.readiness_check
        }));
      }
    }
    for (const action of pack.actions ?? []) {
      if (
        capabilities.some((item) => item.capability === action.capability) ||
        actionCapabilities.some((item) => item.capability === action.capability)
      ) {
        throw new TypeError("semantic action capability identifiers must be unique");
      }
      const ready = packReady && toolRisks instanceof Map &&
        toolRisks.get(action.prepare_tool) === "prepare" &&
        toolRisks.get(action.confirm_tool) === "write";
      actionCapabilities.push({
        capability: action.capability,
        purpose: action.purpose,
        operations: [action.operation],
        risk: "approval",
        trust_zone: action.trust_zone,
        readiness: ready ? "ready" : "unavailable",
        input_description: action.input_description
      });
      if (ready) {
        actionAdapters.set(action.capability, new McpCapabilityActionAdapter({
          server,
          action,
          toolRisks,
          readOnlyTools,
          readinessCheck: pack.readiness_check
        }));
      }
    }
  }
  return { capabilities, adapters, actionCapabilities, actionAdapters };
}

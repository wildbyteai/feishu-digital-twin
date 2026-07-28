const PACK_FIELDS = Object.freeze([
  "capabilities",
  "pack_id",
  "pack_version",
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
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PACK_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_INPUT_DESCRIPTION_BYTES = 1024;
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
  if (tool.risk !== "read") throw new TypeError(`${name}.risk must be read`);
  return structuredClone(tool);
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
  const pack = requireExactObject(value, PACK_FIELDS, "pack");
  if (pack.schema_version !== 1) throw new TypeError("pack.schema_version must be 1");
  requireText(pack.pack_id, "pack.pack_id", { pattern: PORTABLE_ID });
  requireText(pack.pack_version, "pack.pack_version", { pattern: PACK_VERSION });
  requireText(pack.server_ref, "pack.server_ref", { pattern: PORTABLE_ID });
  if (!Array.isArray(pack.tools) || pack.tools.length === 0) {
    throw new TypeError("pack.tools must be a non-empty array");
  }
  if (!Array.isArray(pack.capabilities) || pack.capabilities.length === 0) {
    throw new TypeError("pack.capabilities must be a non-empty array");
  }
  const tools = pack.tools.map(validateTool);
  if (new Set(tools.map(({ name }) => name)).size !== tools.length) {
    throw new TypeError("pack.tools must have unique names");
  }
  const capabilities = pack.capabilities.map(validateCapability);
  if (new Set(capabilities.map(({ capability }) => capability)).size !== capabilities.length) {
    throw new TypeError("pack.capabilities must have unique identifiers");
  }
  const allowedTools = new Set(tools.map(({ name }) => name));
  const referencedTools = new Set(capabilities.flatMap(({ operations }) =>
    operations.map(({ tool }) => tool)
  ));
  const toolMappings = capabilities.flatMap(({ operations }) =>
    operations.map(({ tool }) => tool)
  );
  if (referencedTools.size !== toolMappings.length) {
    throw new TypeError("pack tools must map to exactly one capability operation");
  }
  if ([...referencedTools].some((tool) => !allowedTools.has(tool))) {
    throw new TypeError("pack capability operation uses a tool outside the allowlist");
  }
  if ([...allowedTools].some((tool) => !referencedTools.has(tool))) {
    throw new TypeError("pack tool allowlist must contain only mapped tools");
  }
  return {
    schema_version: 1,
    pack_id: pack.pack_id,
    pack_version: pack.pack_version,
    server_ref: pack.server_ref,
    tools,
    capabilities
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

function advertisedReadOnlyTools(result) {
  const tools = Array.isArray(result)
    ? result
    : Array.isArray(result?.tools)
      ? result.tools
      : null;
  if (tools === null) return null;
  const readOnlyTools = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
    if (typeof tool.name !== "string" || tool.name.length === 0) return null;
    if (
      tool.annotations?.readOnlyHint === true &&
      tool.annotations?.destructiveHint !== true
    ) {
      readOnlyTools.add(tool.name);
    }
  }
  return readOnlyTools;
}

function trustedServer(server, readOnlyTools) {
  return Object.freeze({
    callTool: server.callTool.bind(server),
    [TRUSTED_READ_ONLY_TOOLS]: readOnlyTools
  });
}

export async function resolvePrivateCapabilityServers({
  packs = [],
  resolveServer
} = {}) {
  if (!Array.isArray(packs)) throw new TypeError("packs must be an array");
  if (typeof resolveServer !== "function") {
    throw new TypeError("resolveServer must be a function");
  }
  const serverRefs = [...new Set(
    packs.map((pack) => validatePrivateCapabilityPack(pack).server_ref)
  )];
  const servers = new Map();
  for (const serverRef of serverRefs) {
    const server = await resolveServer(serverRef);
    if (server === undefined) continue;
    if (typeof server?.callTool !== "function") {
      throw new TypeError("resolved MCP server callTool is required");
    }
    if (typeof server.listTools !== "function") continue;
    let readOnlyTools;
    try {
      readOnlyTools = advertisedReadOnlyTools(await server.listTools());
    } catch {
      continue;
    }
    if (readOnlyTools === null) continue;
    servers.set(serverRef, trustedServer(server, readOnlyTools));
  }
  return servers;
}

export class McpCapabilityAdapter {
  constructor({ server, capability, readOnlyTools }) {
    if (typeof server?.callTool !== "function") {
      throw new TypeError("MCP server callTool is required");
    }
    if (!(readOnlyTools instanceof Set)) {
      throw new TypeError("trusted read-only MCP tools are required");
    }
    this.server = server;
    this.readOnlyTools = new Set(readOnlyTools);
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
    return normalizeMcpToolResult(await this.server.callTool({
      name: operation.tool,
      arguments: structuredClone(request.input)
    }));
  }
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
  }
  const capabilities = [];
  const adapters = new Map();
  for (const pack of validated) {
    const server = servers.get(pack.server_ref);
    if (server !== undefined && typeof server?.callTool !== "function") {
      throw new TypeError("MCP server callTool is required");
    }
    const readOnlyTools = server?.[TRUSTED_READ_ONLY_TOOLS];
    for (const capability of pack.capabilities) {
      if (capabilities.some((item) => item.capability === capability.capability)) {
        throw new TypeError("semantic capability identifiers must be unique");
      }
      const ready = readOnlyTools instanceof Set && capability.operations.every(({ tool }) => (
        readOnlyTools.has(tool)
      ));
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
          readOnlyTools
        }));
      }
    }
  }
  return { capabilities, adapters };
}

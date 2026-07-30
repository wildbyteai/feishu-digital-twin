import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateCapabilityLookupRequest } from "./capability-gateway.mjs";

export const DECISION_SCHEMA_PATH = fileURLToPath(new URL(
  "../schemas/codex-decision.schema.json",
  import.meta.url
));

const decisionSchema = JSON.parse(readFileSync(DECISION_SCHEMA_PATH, "utf8"));
const DECISION_FIELDS = [...decisionSchema.required];
const OUTCOMES = new Set(decisionSchema.properties.outcome.enum);
const SOURCE_REFS_MIN_ITEMS = decisionSchema.properties.source_refs.minItems;
const RESPONSE_SCHEMA = decisionSchema.properties.response.anyOf.find((item) => (
  item.type === "object"
));
const RESPONSE_FIELDS = [...RESPONSE_SCHEMA.required];
const RESPONSE_MODES = new Set(RESPONSE_SCHEMA.properties.mode.enum);
const COMMANDS_SCHEMA = decisionSchema.properties.commands;
const COMMAND_SCHEMA = COMMANDS_SCHEMA.items;
const COMMAND_FIELDS = [...COMMAND_SCHEMA.required];
const COMMAND_CONFIRMATIONS = new Set(COMMAND_SCHEMA.properties.confirmation.enum);
const LOOKUP_REQUESTS_SCHEMA = decisionSchema.properties.lookup_requests;
const ACTION_REQUESTS_SCHEMA = decisionSchema.properties.action_requests;
const LOOKUP_INPUT_SCHEMA = LOOKUP_REQUESTS_SCHEMA.items.properties.input;
const ACTION_INPUT_SCHEMA = ACTION_REQUESTS_SCHEMA.items.properties.input;

function exactFields(value, fields) {
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeCapabilityRequest(request, inputSchema) {
  let normalized = request;
  if (typeof request?.input === "string") {
    const inputBytes = Buffer.byteLength(request.input);
    if (
      inputBytes < inputSchema.minLength ||
      inputBytes > inputSchema.maxLength
    ) {
      throw new TypeError("capability request input JSON is outside the trusted size limit");
    }
    try {
      normalized = { ...request, input: JSON.parse(request.input) };
    } catch {
      throw new TypeError("capability request input must be valid JSON");
    }
  }
  return validateCapabilityLookupRequest(normalized);
}

function validateResponse(response) {
  if (response === null) return;
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    !exactFields(response, RESPONSE_FIELDS) ||
    !RESPONSE_MODES.has(response.mode)
  ) {
    throw new TypeError("decision.response.mode is invalid");
  }
  if (!nonEmptyText(response.text)) {
    throw new TypeError("decision.response.text must be a non-empty string");
  }
}

function validateCommand(command) {
  if (
    !command ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    !exactFields(command, COMMAND_FIELDS) ||
    !Array.isArray(command.argv) ||
    command.argv.length < COMMAND_SCHEMA.properties.argv.minItems ||
    command.argv.some((argument) => !nonEmptyText(argument))
  ) {
    throw new TypeError("decision command argv is invalid");
  }
  if (!nonEmptyText(command.reason)) {
    throw new TypeError("decision command reason must be a non-empty string");
  }
  if (!COMMAND_CONFIRMATIONS.has(command.confirmation)) {
    throw new TypeError("decision command confirmation is invalid");
  }
}

export function normalizeDecision(decision, { eventId } = {}) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new TypeError("Codex decision must be an object");
  }
  if (eventId !== undefined && decision.event_id !== eventId) {
    throw new TypeError("decision.event_id does not match event.event_id");
  }
  const normalized = { ...decision };
  for (const field of ["lookup_requests", "action_requests"]) {
    if (!Object.hasOwn(normalized, field)) normalized[field] = [];
  }
  if (!exactFields(normalized, DECISION_FIELDS)) {
    throw new TypeError("decision has invalid fields");
  }
  if (!nonEmptyText(normalized.event_id)) {
    throw new TypeError("decision.event_id must be a non-empty string");
  }
  if (!OUTCOMES.has(normalized.outcome)) {
    throw new TypeError("decision.outcome is invalid");
  }
  if (!nonEmptyText(normalized.reason)) {
    throw new TypeError("decision.reason must be a non-empty string");
  }
  validateResponse(normalized.response);
  if (!Array.isArray(normalized.commands)) {
    throw new TypeError("decision.commands must be an array");
  }
  if (normalized.commands.length > COMMANDS_SCHEMA.maxItems) {
    throw new TypeError(`decision.commands cannot contain more than ${COMMANDS_SCHEMA.maxItems} actions per round`);
  }
  for (const command of normalized.commands) validateCommand(command);
  if (!Array.isArray(normalized.source_refs)) {
    throw new TypeError("decision.source_refs must be an array");
  }
  if (normalized.source_refs.length < SOURCE_REFS_MIN_ITEMS) {
    throw new TypeError("decision.source_refs must contain at least one source");
  }
  if (normalized.source_refs.some((sourceRef) => (
    typeof sourceRef !== "string" || sourceRef.length === 0
  ))) {
    throw new TypeError("decision.source_refs must contain non-empty strings");
  }
  if (!Array.isArray(normalized.lookup_requests) || !Array.isArray(normalized.action_requests)) {
    throw new TypeError("decision capability requests must be arrays");
  }
  if (normalized.lookup_requests.length > LOOKUP_REQUESTS_SCHEMA.maxItems) {
    throw new TypeError("decision.lookup_requests cannot contain more than one query per round");
  }
  if (normalized.action_requests.length > ACTION_REQUESTS_SCHEMA.maxItems) {
    throw new TypeError("decision.action_requests cannot contain more than one action per round");
  }
  if (normalized.lookup_requests.length + normalized.action_requests.length > 1) {
    throw new TypeError("decision can contain only one semantic capability request per round");
  }
  if (normalized.action_requests.length > 0 && normalized.commands.length > 0) {
    throw new TypeError("decision cannot mix a semantic business action with Feishu commands");
  }
  normalized.lookup_requests = normalized.lookup_requests.map((request) => (
    normalizeCapabilityRequest(request, LOOKUP_INPUT_SCHEMA)
  ));
  normalized.action_requests = normalized.action_requests.map((request) => (
    normalizeCapabilityRequest(request, ACTION_INPUT_SCHEMA)
  ));
  return normalized;
}

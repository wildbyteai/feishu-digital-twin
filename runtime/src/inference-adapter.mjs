import { runCodexDecision } from "./codex-runner.mjs";
import { validateCapabilityLookupRequest } from "./capability-gateway.mjs";

const SAFE_MESSAGES = Object.freeze({
  INFERENCE_FAILED: "Codex inference failed",
  INFERENCE_INVALID_OUTPUT: "Codex returned an invalid structured decision",
  INFERENCE_NOT_READY: "Codex runtime is not ready",
  INFERENCE_PROCESS_FAILED: "Codex process failed",
  INFERENCE_TIMEOUT: "Codex inference timed out",
  INFERENCE_UNAVAILABLE: "Codex executable is unavailable"
});
const LOOKUP_INPUT_JSON_MAX_BYTES = 8 * 1024;

function timeout(value) {
  if (!Number.isInteger(value) || value < 1000 || value > 600000) {
    throw new TypeError("timeoutMs must be an integer between 1000 and 600000");
  }
  return value;
}

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeLookupRequest(request) {
  let normalized = request;
  if (typeof request?.input === "string") {
    if (
      Buffer.byteLength(request.input) < 2 ||
      Buffer.byteLength(request.input) > LOOKUP_INPUT_JSON_MAX_BYTES
    ) {
      throw new TypeError("lookup input JSON is outside the trusted size limit");
    }
    normalized = { ...request, input: JSON.parse(request.input) };
  }
  validateCapabilityLookupRequest(normalized);
  return normalized;
}

function assertDecisionEnvelope(decision, event) {
  const fields = [
    "commands",
    "event_id",
    "outcome",
    "reason",
    "response",
    "source_refs"
  ];
  if (Object.hasOwn(decision ?? {}, "lookup_requests")) fields.push("lookup_requests");
  if (!exactFields(decision, fields)) {
    throw new InferenceError("INFERENCE_INVALID_OUTPUT");
  }
  if (decision.event_id !== event.event_id || !nonEmptyText(decision.event_id)) {
    throw new InferenceError("INFERENCE_INVALID_OUTPUT");
  }
  if (!new Set(["ignore", "reply", "confirm"]).has(decision.outcome)) {
    throw new InferenceError("INFERENCE_INVALID_OUTPUT");
  }
  if (
    !nonEmptyText(decision.reason) ||
    !Array.isArray(decision.commands) ||
    decision.commands.length > 5 ||
    !Array.isArray(decision.source_refs) ||
    decision.source_refs.length === 0 ||
    decision.source_refs.some((sourceRef) => !nonEmptyText(sourceRef))
  ) {
    throw new InferenceError("INFERENCE_INVALID_OUTPUT");
  }
  if (decision.response !== null && (
    !exactFields(decision.response, ["mode", "text"]) ||
    !new Set(["representative", "suggestion", "confirmation"]).has(decision.response.mode) ||
    !nonEmptyText(decision.response.text)
  )) {
    throw new InferenceError("INFERENCE_INVALID_OUTPUT");
  }
  for (const command of decision.commands) {
    if (
      !exactFields(command, ["argv", "confirmation", "reason"]) ||
      !Array.isArray(command.argv) ||
      command.argv.length < 2 ||
      command.argv.some((argument) => !nonEmptyText(argument)) ||
      !nonEmptyText(command.reason) ||
      !new Set(["auto", "human"]).has(command.confirmation)
    ) {
      throw new InferenceError("INFERENCE_INVALID_OUTPUT");
    }
  }
  const lookupRequests = decision.lookup_requests ?? [];
  if (!Array.isArray(lookupRequests) || lookupRequests.length > 1) {
    throw new InferenceError("INFERENCE_INVALID_OUTPUT");
  }
  const normalizedLookupRequests = [];
  for (const request of lookupRequests) {
    try {
      normalizedLookupRequests.push(normalizeLookupRequest(request));
    } catch {
      throw new InferenceError("INFERENCE_INVALID_OUTPUT");
    }
  }
  return Object.hasOwn(decision, "lookup_requests")
    ? { ...decision, lookup_requests: normalizedLookupRequests }
    : decision;
}

function classifyError(error) {
  if (error instanceof InferenceError) return error;
  if (error?.code === "ENOENT") return new InferenceError("INFERENCE_UNAVAILABLE");
  if (error instanceof SyntaxError) return new InferenceError("INFERENCE_INVALID_OUTPUT");
  const message = error instanceof Error ? error.message : "";
  if (/timed out|timeout/iu.test(message)) return new InferenceError("INFERENCE_TIMEOUT");
  if (/no final agent message|JSON|structured|schema|decision/iu.test(message)) {
    return new InferenceError("INFERENCE_INVALID_OUTPUT");
  }
  if (/exited with code|process/iu.test(message)) {
    return new InferenceError("INFERENCE_PROCESS_FAILED");
  }
  if (error instanceof TypeError) return new InferenceError("INFERENCE_NOT_READY");
  return new InferenceError("INFERENCE_FAILED");
}

export class InferenceError extends Error {
  constructor(code) {
    if (!Object.hasOwn(SAFE_MESSAGES, code)) throw new TypeError("unknown inference error code");
    super(SAFE_MESSAGES[code]);
    this.name = "InferenceError";
    this.code = code;
  }
}

export class CodexInferenceAdapter {
  constructor({
    codexBin,
    codexEnvironmentRoot,
    timeoutMs = 120000,
    runner = runCodexDecision,
    clock = () => Date.now()
  } = {}) {
    if (typeof codexBin !== "string" || codexBin.length === 0) {
      throw new TypeError("codexBin is required");
    }
    if (typeof codexEnvironmentRoot !== "string" || codexEnvironmentRoot.length === 0) {
      throw new TypeError("codexEnvironmentRoot is required");
    }
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.codexBin = codexBin;
    this.codexEnvironmentRoot = codexEnvironmentRoot;
    this.timeoutMs = timeout(timeoutMs);
    this.runner = runner;
    this.clock = clock;
  }

  async decide({ event, promptContext = {} } = {}) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("inference request.event must be an object");
    }
    if (!promptContext || typeof promptContext !== "object" || Array.isArray(promptContext)) {
      throw new TypeError("inference request.promptContext must be an object");
    }
    try {
      const decision = await this.runner(event, {
        codexBin: this.codexBin,
        isolationRoot: this.codexEnvironmentRoot,
        timeoutMs: this.timeoutMs,
        promptContext
      });
      return assertDecisionEnvelope(decision, event);
    } catch (error) {
      throw classifyError(error);
    }
  }

  async doctor() {
    const startedAt = this.clock();
    try {
      await this.decide({
        event: {
          event_id: "evt_codex_runtime_doctor",
          source: "system",
          message_id: "om_codex_runtime_doctor",
          text: "Codex runtime capability check"
        },
        promptContext: { doctor: true }
      });
      return {
        ok: true,
        code: "READY",
        latency_ms: Math.max(0, Math.round(this.clock() - startedAt))
      };
    } catch (error) {
      const classified = classifyError(error);
      return {
        ok: false,
        code: classified.code,
        latency_ms: Math.max(0, Math.round(this.clock() - startedAt))
      };
    }
  }
}

export class FakeInferenceAdapter {
  constructor(decider) {
    if (typeof decider !== "function") throw new TypeError("decider must be a function");
    this.decider = decider;
  }

  async decide(request) {
    return this.decider(structuredClone(request));
  }

  async doctor() {
    return { ok: true, code: "READY", latency_ms: 0 };
  }
}

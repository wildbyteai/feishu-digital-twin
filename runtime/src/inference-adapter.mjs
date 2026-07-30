import { runCodexDecision } from "./codex-runner.mjs";
import { normalizeDecision } from "./decision-contract.mjs";

const SAFE_MESSAGES = Object.freeze({
  INFERENCE_FAILED: "Codex inference failed",
  INFERENCE_INVALID_OUTPUT: "Codex returned an invalid structured decision",
  INFERENCE_NOT_READY: "Codex runtime is not ready",
  INFERENCE_PROCESS_FAILED: "Codex process failed",
  INFERENCE_TIMEOUT: "Codex inference timed out",
  INFERENCE_UNAVAILABLE: "Codex executable is unavailable"
});
function timeout(value) {
  if (!Number.isInteger(value) || value < 1000 || value > 600000) {
    throw new TypeError("timeoutMs must be an integer between 1000 and 600000");
  }
  return value;
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
      try {
        return normalizeDecision(decision, { eventId: event.event_id });
      } catch {
        throw new InferenceError("INFERENCE_INVALID_OUTPUT");
      }
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

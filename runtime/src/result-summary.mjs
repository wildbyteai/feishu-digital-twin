import { randomBytes } from "node:crypto";

import { safeDecisionReasonCode } from "./decision-diagnostics.mjs";

const EXECUTION_HASH = /^execution_[a-f0-9]{64}$/u;

function executionSummary(execution) {
  return Object.fromEntries(Object.entries({
    status: execution?.status,
    error_type: execution?.error_type,
    execution_hash: EXECUTION_HASH.test(execution?.execution_hash ?? "")
      ? execution.execution_hash
      : undefined
  }).filter(([, value]) => value !== undefined && value !== null));
}

const CONTEXT_SCOPES = new Set(["none", "chat", "reply", "thread"]);
const SILENT_OUTCOMES = new Set(["ignore", "checkpoint", "checkpoint-deferred"]);

function diagnosticsSummary(result) {
  if (!result?.diagnostics || typeof result.diagnostics !== "object") return null;
  const raw = result.diagnostics;
  const diagnostics = {
    context_fetched: raw.context_fetched === true,
    context_count: Number.isInteger(raw.context_count) && raw.context_count >= 0
      ? raw.context_count
      : 0,
    context_scope: CONTEXT_SCOPES.has(raw.context_scope)
      ? raw.context_scope
      : "none",
    processing_latency_ms: Number.isFinite(raw.processing_latency_ms)
      ? Math.max(0, Math.round(raw.processing_latency_ms))
      : 0
  };
  return {
    ...diagnostics,
    decision_reason_code: safeDecisionReasonCode(raw.decision_reason_code, {
      outcome: result.outcome,
      contextFetched: diagnostics.context_fetched
    })
  };
}

function randomTraceId() {
  return `trace_${randomBytes(16).toString("hex")}`;
}

export function summarizeServiceResult(result, {
  traceId = randomTraceId,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof traceId !== "function") throw new TypeError("traceId must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const projectedTraceId = traceId();
  if (typeof projectedTraceId !== "string" || projectedTraceId.length === 0) {
    throw new TypeError("traceId must return a non-empty string");
  }
  const projectedNow = now();
  if (typeof projectedNow !== "string" || Number.isNaN(Date.parse(projectedNow))) {
    throw new TypeError("now must return an ISO timestamp");
  }
  const diagnostics = diagnosticsSummary(result);
  return {
    trace_id: projectedTraceId,
    logged_at: new Date(Date.parse(projectedNow)).toISOString(),
    outcome: result.outcome,
    executions: (result.executions ?? []).map(executionSummary),
    confirmations: (result.confirmations ?? []).map((confirmation) => ({
      status: confirmation.delivery?.status ?? confirmation.status ?? "pending"
    })),
    ...(diagnostics ? { diagnostics } : {})
  };
}

export function shouldEmitServiceResult(result) {
  return !SILENT_OUTCOMES.has(result?.outcome);
}

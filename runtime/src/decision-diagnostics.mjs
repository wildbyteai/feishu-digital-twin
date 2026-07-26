export const DECISION_REASON_CODES = Object.freeze({
  duplicateEvent: "DUPLICATE_EVENT",
  digitalTwinDisabled: "DIGITAL_TWIN_DISABLED",
  principalMessage: "PRINCIPAL_MESSAGE",
  noCandidateContent: "NO_CANDIDATE_CONTENT",
  unknownConfirmation: "UNKNOWN_CONFIRMATION",
  checkpoint: "CHECKPOINT",
  checkpointDeferred: "CHECKPOINT_DEFERRED",
  controlMessage: "CONTROL_MESSAGE",
  confirmationResult: "CONFIRMATION_RESULT",
  aiIgnoreAfterContext: "AI_IGNORE_AFTER_CONTEXT",
  aiIgnoreWithoutContext: "AI_IGNORE_WITHOUT_CONTEXT",
  aiReplyAfterContext: "AI_REPLY_AFTER_CONTEXT",
  aiReplyWithoutContext: "AI_REPLY_WITHOUT_CONTEXT",
  aiConfirmAfterContext: "AI_CONFIRM_AFTER_CONTEXT",
  aiConfirmWithoutContext: "AI_CONFIRM_WITHOUT_CONTEXT",
  aiDraftAfterContext: "AI_DRAFT_AFTER_CONTEXT",
  aiDraftWithoutContext: "AI_DRAFT_WITHOUT_CONTEXT",
  runtimeResult: "RUNTIME_RESULT"
});

const VALID_REASON_CODES = new Set(Object.values(DECISION_REASON_CODES));

export function aiDecisionReasonCode(outcome, { contextFetched = false } = {}) {
  const suffix = contextFetched ? "AfterContext" : "WithoutContext";
  const key = {
    ignore: `aiIgnore${suffix}`,
    reply: `aiReply${suffix}`,
    confirm: `aiConfirm${suffix}`,
    draft: `aiDraft${suffix}`
  }[outcome];
  return key ? DECISION_REASON_CODES[key] : DECISION_REASON_CODES.runtimeResult;
}

export function safeDecisionReasonCode(value, { outcome, contextFetched = false } = {}) {
  const expectedAiCode = aiDecisionReasonCode(outcome, { contextFetched });
  if (!VALID_REASON_CODES.has(value)) return expectedAiCode;
  if (value.startsWith("AI_") && expectedAiCode !== DECISION_REASON_CODES.runtimeResult) {
    return expectedAiCode;
  }
  return value;
}

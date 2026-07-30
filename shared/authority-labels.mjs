export const RESPONSE_MODES = new Set(["representative", "suggestion", "confirmation"]);

const AI_ASSISTANT_LABEL = "🤖 AI助理：";
const AI_ASSISTANT_LABEL_PATTERN = /^(?:🤖\s*)?(?:(?:\*\*|__)\s*)?(?:🤖\s*)?AI助理\s*[:：]\s*(?:(?:\*\*|__)\s*)?/u;
const LEGACY_AUTHORITY_LABEL = /^🤖【(?:数字分身|代表发言|建议|待[^】]+确认)】/u;

export function authorityLabel(mode, principalName) {
  if (!RESPONSE_MODES.has(mode)) throw new TypeError("authority label mode is invalid");
  return AI_ASSISTANT_LABEL;
}

export function stripAuthorityLabel(text) {
  let result = text.trim();
  while (
    AI_ASSISTANT_LABEL_PATTERN.test(result) ||
    LEGACY_AUTHORITY_LABEL.test(result)
  ) {
    result = AI_ASSISTANT_LABEL_PATTERN.test(result)
      ? result.replace(AI_ASSISTANT_LABEL_PATTERN, "").trimStart()
      : result.replace(LEGACY_AUTHORITY_LABEL, "").trimStart();
  }
  return result;
}

export function hasAuthorityLabel(text, principalName) {
  return typeof text === "string" && AI_ASSISTANT_LABEL_PATTERN.test(text);
}

export function hasCurrentOrLegacyAuthorityLabel(text, principalName) {
  return hasAuthorityLabel(text, principalName) || (
    typeof text === "string" && LEGACY_AUTHORITY_LABEL.test(text)
  );
}

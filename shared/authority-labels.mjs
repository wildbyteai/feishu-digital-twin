export const RESPONSE_MODES = new Set(["representative", "suggestion", "confirmation"]);

const AI_ASSISTANT_LABEL = "🤖 AI助理：";
const BARE_AI_ASSISTANT_LABEL = "AI助理：";
const LEGACY_AUTHORITY_LABEL = /^🤖【(?:数字分身|代表发言|建议|待[^】]+确认)】/u;

export function authorityLabel(mode, principalName) {
  if (!RESPONSE_MODES.has(mode)) throw new TypeError("authority label mode is invalid");
  return AI_ASSISTANT_LABEL;
}

export function stripAuthorityLabel(text) {
  let result = text.trim();
  while (
    result.startsWith(AI_ASSISTANT_LABEL) ||
    result.startsWith(BARE_AI_ASSISTANT_LABEL) ||
    LEGACY_AUTHORITY_LABEL.test(result)
  ) {
    result = result.startsWith(AI_ASSISTANT_LABEL)
      ? result.slice(AI_ASSISTANT_LABEL.length).trimStart()
      : result.startsWith(BARE_AI_ASSISTANT_LABEL)
        ? result.slice(BARE_AI_ASSISTANT_LABEL.length).trimStart()
      : result.replace(LEGACY_AUTHORITY_LABEL, "").trimStart();
  }
  return result;
}

export function hasAuthorityLabel(text, principalName) {
  return typeof text === "string" && [
    authorityLabel("representative", principalName),
    authorityLabel("suggestion", principalName),
    authorityLabel("confirmation", principalName)
  ].some((label) => text.startsWith(label));
}

export function hasCurrentOrLegacyAuthorityLabel(text, principalName) {
  return hasAuthorityLabel(text, principalName) || (
    typeof text === "string" && LEGACY_AUTHORITY_LABEL.test(text)
  );
}

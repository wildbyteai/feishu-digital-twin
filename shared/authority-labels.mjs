export const RESPONSE_MODES = new Set(["representative", "suggestion", "confirmation"]);

const LEGACY_REPRESENTATIVE_LABEL = "🤖【代表发言】";

export function authorityLabel(mode, principalName) {
  if (mode === "representative") return "🤖【数字分身】";
  if (mode === "suggestion") return "🤖【建议】";
  if (mode === "confirmation" && typeof principalName === "string" && principalName.length > 0) {
    return `🤖【待${principalName}确认】`;
  }
  throw new TypeError("authority label mode or principal name is invalid");
}

export function stripAuthorityLabel(text) {
  let result = text.trim();
  while (/^🤖【(?:数字分身|代表发言|建议|待[^】]+确认)】/u.test(result)) {
    result = result.replace(/^🤖【(?:数字分身|代表发言|建议|待[^】]+确认)】/u, "").trimStart();
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
    typeof text === "string" && text.startsWith(LEGACY_REPRESENTATIVE_LABEL)
  );
}

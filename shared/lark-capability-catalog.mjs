export const LARK_CAPABILITY_CATALOG = Object.freeze({
  official_business_domains: Object.freeze([
    "approval",
    "apps",
    "attendance",
    "base",
    "calendar",
    "contact",
    "docs",
    "drive",
    "im",
    "mail",
    "markdown",
    "mindnotes",
    "minutes",
    "note",
    "okr",
    "sheets",
    "slides",
    "task",
    "vc",
    "whiteboard",
    "wiki"
  ]),
  capabilities: Object.freeze({
    message: Object.freeze(["im"]),
    task: Object.freeze(["task"]),
    calendar: Object.freeze(["calendar"]),
    docs: Object.freeze(["docs", "drive"]),
    base: Object.freeze(["base"]),
    enterprise_knowledge: Object.freeze([
      "drive",
      "wiki",
      "docs",
      "base",
      "sheets",
      "markdown"
    ]),
    daily_memory: Object.freeze(["im", "task", "calendar", "drive", "docs"]),
    console: Object.freeze(["base"])
  })
});

export const OFFICIAL_LARK_BUSINESS_DOMAINS =
  LARK_CAPABILITY_CATALOG.official_business_domains;

export function larkDomainsForCapabilities(capabilities) {
  return [...new Set(capabilities.flatMap(
    (capability) => LARK_CAPABILITY_CATALOG.capabilities[capability] ?? []
  ))];
}

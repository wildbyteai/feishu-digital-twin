import { runCodexDecision } from "./codex-runner.mjs";

const PUBLIC_SEARCH_EVENT = Object.freeze({
  event_id: "evt_public_web_search",
  source: "system",
  message_id: "om_public_web_search",
  text: "approved public Web Search query"
});
const QUERY_MAX_LENGTH = 160;
const SUMMARY_MAX_BYTES = 4 * 1024;
const SOURCE_MAX_ITEMS = 10;
const SOURCE_MAX_BYTES = 2 * 1024;
const SENSITIVE_PATTERNS = Object.freeze([
  /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|bearer|cookie|password|passwd|secret|private[-_ ]?key|密码|口令|密钥|令牌|凭据)/iu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/u,
  /(?:https?:\/\/|file:\/\/|\/Users\/|\/home\/|~\/|[A-Za-z]:\\|localhost\b|127\.0\.0\.1\b)/iu,
  /\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?86[- ]?)?1[3-9]\d{9}\b/u,
  /\b\d{15}(?:\d{2}[0-9X])?\b/iu,
  /\b(?:ou|om|oc|cli|app|tenant|user|chat)_[A-Za-z0-9_-]{6,}\b/iu,
  /\b[A-Za-z0-9_-]{32,}\b/u
]);
const NON_PUBLIC_CONTEXT_PATTERNS = Object.freeze([
  /(?:公司内部|内部(?:数据|资料|文档|路线图|代号)|候选人|员工(?:信息|资料|名单)?|客户(?:信息|资料|名单)|供应商(?:信息|资料|名单)|简历|履历|人事|绩效|考勤|薪资|工资|采购价|底价|报价单|销售数据|成本数据)/u,
  /\b(?:confidential|proprietary|internal\s+(?:data|document|roadmap|codename)|candidate|employee\s+(?:data|record|list)|customer\s+(?:data|record|list)|supplier\s+(?:data|record|list)|payroll|resume)\b/iu
]);

export const PUBLIC_WEB_SEARCH_CAPABILITY = Object.freeze({
  capability: "public.web.search",
  purpose: "查询当前业务问题所需的最新公开信息",
  operations: Object.freeze(["search"]),
  risk: "read",
  trust_zone: "public",
  readiness: "ready",
  input_description: "query 必须是当前消息中连续出现的最小非敏感公开查询词"
});

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function normalizedText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim()
    : "";
}

function containsSensitiveInput(value) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value)) ||
    NON_PUBLIC_CONTEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function projectQuery(request, trustedContext) {
  if (!exactFields(request.input, ["query"])) return { status: "invalid-input" };
  const query = normalizedText(request.input.query);
  const currentMessage = normalizedText(trustedContext?.current_message_text);
  if (
    query.length === 0 ||
    query.length > QUERY_MAX_LENGTH ||
    /[\r\n\u0000]/u.test(query)
  ) {
    return { status: "invalid-input" };
  }
  if (
    currentMessage.length === 0 ||
    containsSensitiveInput(query) ||
    containsSensitiveInput(currentMessage) ||
    !currentMessage.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US"))
  ) {
    return { status: "denied" };
  }
  return { status: "approved", query };
}

function truncateUtf8(value, maxBytes) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character);
    if (bytes + nextBytes > maxBytes) break;
    result += character;
    bytes += nextBytes;
  }
  return result;
}

function publicSearchResult(query, decision) {
  const fields = ["commands", "event_id", "outcome", "reason", "response", "source_refs"];
  if (Object.hasOwn(decision ?? {}, "lookup_requests")) fields.push("lookup_requests");
  if (Object.hasOwn(decision ?? {}, "action_requests")) fields.push("action_requests");
  if (
    !exactFields(decision, fields) ||
    decision.event_id !== PUBLIC_SEARCH_EVENT.event_id ||
    decision.outcome !== "reply" ||
    typeof decision.reason !== "string" ||
    decision.reason.length === 0 ||
    !exactFields(decision.response, ["mode", "text"]) ||
    decision.response.mode !== "suggestion" ||
    typeof decision.response.text !== "string" ||
    decision.response.text.length === 0 ||
    !Array.isArray(decision.commands) ||
    decision.commands.length !== 0 ||
    !Array.isArray(decision.lookup_requests ?? []) ||
    (decision.lookup_requests ?? []).length !== 0 ||
    !Array.isArray(decision.action_requests ?? []) ||
    (decision.action_requests ?? []).length !== 0 ||
    !Array.isArray(decision.source_refs)
  ) {
    throw new TypeError("public Web Search returned an invalid decision");
  }
  const sourceRefs = decision.source_refs
    .filter((sourceRef) => (
      typeof sourceRef === "string" &&
      sourceRef.length > 0 &&
      sourceRef !== PUBLIC_SEARCH_EVENT.message_id
    ))
    .slice(0, SOURCE_MAX_ITEMS)
    .map((sourceRef) => truncateUtf8(sourceRef, SOURCE_MAX_BYTES));
  if (sourceRefs.length === 0) return { status: "empty-result" };
  return {
    status: "complete",
    data: {
      query,
      summary: truncateUtf8(decision.response.text, SUMMARY_MAX_BYTES)
    },
    source_refs: sourceRefs
  };
}

export class PublicWebSearchAdapter {
  constructor({
    codexBin,
    codexEnvironmentRoot,
    timeoutMs = 120000,
    runner = runCodexDecision
  } = {}) {
    if (typeof codexBin !== "string" || codexBin.length === 0) {
      throw new TypeError("codexBin is required");
    }
    if (typeof codexEnvironmentRoot !== "string" || codexEnvironmentRoot.length === 0) {
      throw new TypeError("codexEnvironmentRoot is required");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      throw new TypeError("timeoutMs must be an integer between 1000 and 120000");
    }
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    this.codexBin = codexBin;
    this.codexEnvironmentRoot = codexEnvironmentRoot;
    this.timeoutMs = timeoutMs;
    this.runner = runner;
  }

  async lookup(request, trustedContext) {
    const projection = projectQuery(request, trustedContext);
    if (projection.status !== "approved") return { status: projection.status };
    const decision = await this.runner(PUBLIC_SEARCH_EVENT, {
      codexBin: this.codexBin,
      isolationRoot: this.codexEnvironmentRoot,
      timeoutMs: this.timeoutMs,
      publicSearchQuery: projection.query
    });
    return publicSearchResult(projection.query, decision);
  }
}

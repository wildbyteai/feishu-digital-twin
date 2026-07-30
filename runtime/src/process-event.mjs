import {
  authorityLabel,
  hasCurrentOrLegacyAuthorityLabel,
  RESPONSE_MODES,
  stripAuthorityLabel
} from "../../shared/authority-labels.mjs";
import { trustedDailyMemoryIntent } from "../../shared/daily-memory-trigger.mjs";
import {
  aiDecisionReasonCode,
  DECISION_REASON_CODES
} from "./decision-diagnostics.mjs";
import { validateCapabilityLookupRequest } from "./capability-gateway.mjs";
const CONTROL_MESSAGES = new Map([
  ["立即冻结数字分身", { frozen: true, reason: "PRINCIPAL_REQUEST" }]
]);
const RESUME_CONTROL_MESSAGE = "恢复数字分身";
const HUMAN_CONTEXT_FALLBACK = "当前消息或引用内容无法读取，无法据此形成可靠结论，请人工检查原消息或链接后继续处理。";
const AI_CONTEXT_LIMIT = 20;
const AI_SIGNALS = new Set([
  "context_lookup_required",
  "direct_mention",
  "recent_chat_context",
  "reply_context",
  "reply_to_principal",
  "reply_to_twin",
  "semantic_address",
  "thread_context"
]);
const CONTEXT_SCOPES = new Set(["none", "reply", "thread", "chat"]);
const EXACT_REFERENCE_RELATIONS = new Set(["reply", "parent", "root"]);
const SOURCE_ONLY_FIELDS = new Set([
  "href",
  "link",
  "links",
  "source_link",
  "source_links",
  "source_ref",
  "source_refs",
  "source_url",
  "source_urls",
  "uri",
  "url",
  "urls"
]);
const TRANSPORT_ONLY_FIELDS = new Set(["ok", "success"]);
const TRANSPORT_RESULT_FIELDS = new Set(["result", "status"]);
const TRANSPORT_ONLY_RESULT_VALUES = new Set([
  "complete",
  "completed",
  "ok",
  "success",
  "succeeded"
]);

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateEvent(event) {
  if (!event || typeof event !== "object") throw new TypeError("event must be an object");
  for (const field of ["event_id", "chat_id", "chat_type", "message_id", "sender_open_id"]) {
    requireText(event[field], `event.${field}`);
  }
  if (!new Set(["event", "supplement", "simulation", "system"]).has(event.source)) {
    throw new TypeError("event.source is invalid");
  }
  if (!new Set(["group", "p2p"]).has(event.chat_type)) {
    throw new TypeError("event.chat_type is invalid");
  }
  if (event.text !== undefined && typeof event.text !== "string") {
    throw new TypeError("event.text must be a string when present");
  }
  if (event.context !== undefined && !Array.isArray(event.context)) {
    throw new TypeError("event.context must be an array when present");
  }
  if (event.links !== undefined && !Array.isArray(event.links)) {
    throw new TypeError("event.links must be an array when present");
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("config must be an object");
  requireText(config.principal?.name, "config.principal.name");
  requireText(config.principal?.open_id, "config.principal.open_id");
  if (!Array.isArray(config.allowed_lark_domains) || config.allowed_lark_domains.length === 0) {
    throw new TypeError("config.allowed_lark_domains must be a non-empty array");
  }
  if (config.daily_memory !== undefined && config.daily_memory !== null) {
    requireText(config.daily_memory.folder_token, "config.daily_memory.folder_token");
  }
}

function availableSourceRefs(event) {
  return new Set([
    event.message_id,
    ...(event.context ?? []).map((item) => item?.message_id).filter(Boolean),
    ...(event.capability_feedback ?? []).flatMap((item) => (
      item?.result?.status === "complete" && Array.isArray(item.result.source_refs)
        ? item.result.source_refs
        : []
    ))
  ]);
}

function validateDecision(decision, event, { silent = false } = {}) {
  if (!decision || typeof decision !== "object") {
    throw new TypeError("Codex decision must be an object");
  }
  if (decision.event_id !== event.event_id) {
    throw new TypeError("decision.event_id does not match event.event_id");
  }
  if (!new Set(["ignore", "reply", "confirm"]).has(decision.outcome)) {
    throw new TypeError("decision.outcome is invalid");
  }
  requireText(decision.reason, "decision.reason");
  if (!Array.isArray(decision.source_refs)) {
    throw new TypeError("decision.source_refs must be an array");
  }
  const available = availableSourceRefs(event);
  if (decision.source_refs.some((sourceRef) => !available.has(sourceRef))) {
    throw new TypeError("decision.source_refs contains an unavailable source");
  }
  if (!Array.isArray(decision.commands)) {
    throw new TypeError("decision.commands must be an array");
  }
  if (decision.commands.length > 5) {
    throw new TypeError("decision.commands cannot contain more than 5 actions per round");
  }
  for (const command of decision.commands) {
    if (!command || !Array.isArray(command.argv) || command.argv.length < 2) {
      throw new TypeError("decision command argv is invalid");
    }
    if (command.argv.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new TypeError("decision command argv must contain strings");
    }
    requireText(command.reason, "decision command reason");
    if (!new Set(["auto", "human"]).has(command.confirmation)) {
      throw new TypeError("decision command confirmation is invalid");
    }
  }
  const lookupRequests = decision.lookup_requests ?? [];
  const actionRequests = decision.action_requests ?? [];
  if (!Array.isArray(lookupRequests) || !Array.isArray(actionRequests)) {
    throw new TypeError("decision capability requests must be arrays");
  }
  if (lookupRequests.length > 1) {
    throw new TypeError("decision.lookup_requests cannot contain more than one query per round");
  }
  if (actionRequests.length > 1) {
    throw new TypeError("decision.action_requests cannot contain more than one action per round");
  }
  if (lookupRequests.length + actionRequests.length > 1) {
    throw new TypeError("decision can contain only one semantic capability request per round");
  }
  if (actionRequests.length > 0 && decision.commands.length > 0) {
    throw new TypeError("decision cannot mix a semantic business action with Feishu commands");
  }
  for (const request of lookupRequests) validateCapabilityLookupRequest(request);
  for (const request of actionRequests) validateCapabilityLookupRequest(request);
  if (decision.outcome !== "ignore") {
    if (
      decision.response === null &&
      (silent || lookupRequests.length > 0)
    ) {
      // Trusted system events and intermediate capability rounds do not publish this response.
    } else {
      if (!decision.response || !RESPONSE_MODES.has(decision.response.mode)) {
        throw new TypeError("decision.response.mode is invalid");
      }
      requireText(decision.response.text, "decision.response.text");
    }
  }
  return decision;
}

function definedEntries(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function projectSignalsForAI(signals) {
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) return {};
  return Object.fromEntries(Object.entries(signals).filter(([key, value]) =>
    AI_SIGNALS.has(key) && typeof value === "boolean"
  ));
}

function senderRole(item, principal, { trustAssistantLabel = false } = {}) {
  if (
    trustAssistantLabel &&
    hasCurrentOrLegacyAuthorityLabel(item?.content ?? item?.text, principal?.name)
  ) {
    return "digital_twin";
  }
  if (item?.sender_open_id === principal?.open_id) return "principal";
  return "participant";
}

function projectContextForAI(context, principal) {
  if (!Array.isArray(context)) return [];
  return context.slice(0, AI_CONTEXT_LIMIT).map((item) => definedEntries({
    message_id: item?.message_id,
    sender_role: senderRole(item, principal, {
      trustAssistantLabel: item?.assistant_authored === true
    }),
    content: item?.content,
    links: Array.isArray(item?.links) ? structuredClone(item.links) : undefined,
    link_only: item?.link_only === true ? true : undefined,
    relation: item?.relation,
    topic_key: item?.topic_key,
    sent_at: item?.sent_at
  }));
}

function projectContextMetaForAI(contextMeta, contextCount) {
  if (!contextMeta || typeof contextMeta !== "object" || Array.isArray(contextMeta)) {
    return undefined;
  }
  const scope = CONTEXT_SCOPES.has(contextMeta.scope) ? contextMeta.scope : "none";
  const limit = Number.isInteger(contextMeta.limit) && contextMeta.limit >= 0
    ? Math.min(contextMeta.limit, AI_CONTEXT_LIMIT)
    : AI_CONTEXT_LIMIT;
  return {
    fetched: contextMeta.fetched === true,
    scope,
    count: contextCount,
    limit
  };
}

function aiProjectionIntent(intent, principal) {
  return {
    ...(intent ?? {}),
    principal: {
      name: principal.name,
      open_id: principal.open_id
    }
  };
}

function isDailyMemoryIntent(intent) {
  return intent?.intent === "daily_work_memory";
}

export function projectEventForAI(event, intent) {
  const dailyMemoryIntent = isDailyMemoryIntent(intent);
  const context = projectContextForAI(event.context, intent?.principal);
  return definedEntries({
    event_id: event.event_id,
    // The current Skill can request more same-chat history with official lark-cli.
    ...(dailyMemoryIntent ? {} : {
      chat_id: event.chat_id,
      sender_role: senderRole(event, intent?.principal, { trustAssistantLabel: false })
    }),
    chat_type: event.chat_type,
    message_id: event.message_id,
    sent_at: event.sent_at,
    update_time: event.update_time,
    message_type: event.message_type,
    text: event.text,
    links: Array.isArray(event.links) ? structuredClone(event.links) : undefined,
    link_only: event.link_only === true ? true : undefined,
    thread_id: event.thread_id,
    root_message_id: event.root_message_id,
    parent_message_id: event.parent_message_id,
    reply_to_message_id: event.reply_to_message_id,
    is_external: event.is_external,
    signals: projectSignalsForAI(event.signals),
    context,
    context_meta: projectContextMetaForAI(event.context_meta, context.length),
    reply_retry: event.reply_retry === true ? true : undefined,
    execution_feedback: Array.isArray(event.execution_feedback)
      ? structuredClone(event.execution_feedback)
      : undefined,
    capability_feedback: Array.isArray(event.capability_feedback)
      ? structuredClone(event.capability_feedback)
      : undefined,
    action_budget_remaining: Number.isInteger(event.action_budget_remaining)
      ? event.action_budget_remaining
      : undefined,
    daily_memory_progress: dailyMemoryIntent && event.daily_memory_progress !== undefined
      ? structuredClone(event.daily_memory_progress)
      : undefined,
    daily_memory_retry_count: dailyMemoryIntent && Number.isInteger(event.daily_memory_retry_count)
      ? event.daily_memory_retry_count
      : undefined,
    intent: dailyMemoryIntent ? intent.intent : undefined,
    target_date: dailyMemoryIntent ? intent.target_date : undefined
  });
}

export function projectConfigForAI(config, event, intent) {
  const groupRules = (config.group_rules ?? []).find((item) => item?.chat_id === event.chat_id)?.rules ?? [];
  return definedEntries({
    principal: definedEntries({
      name: config.principal.name,
      timezone: config.principal.timezone,
      address_names: Array.isArray(config.principal.address_names)
        ? structuredClone(config.principal.address_names)
        : undefined
    }),
    allowed_lark_domains: structuredClone(config.allowed_lark_domains),
    authority_rules: structuredClone(config.authority_rules ?? []),
    group_rules: structuredClone(groupRules),
    daily_memory: isDailyMemoryIntent(intent) ? definedEntries({
      folder_token: config.daily_memory?.folder_token,
      folder_name: config.daily_memory?.folder_name
    }) : undefined
  });
}

function visibleResponse(response, principalName, { forceMode } = {}) {
  const mode = forceMode ?? response.mode;
  const body = stripAuthorityLabel(response.text);
  return { mode, text: `${authorityLabel(mode, principalName)}${body}` };
}

function humanContextFallback(event, state, principal) {
  const notifyPrincipal = state.frozen !== true &&
    event.sender_open_id !== principal.open_id;
  return {
    event_id: event.event_id,
    outcome: state.frozen === true ? "draft" : "reply",
    reason: "referenced context is unreadable",
    reason_code: DECISION_REASON_CODES.contextUnreadable,
    response: visibleResponse({
      mode: "suggestion",
      text: notifyPrincipal
        ? `收到，我会提醒${principal.name}检查原消息或链接后继续处理。`
        : HUMAN_CONTEXT_FALLBACK
    }, principal.name),
    commands: [],
    source_refs: [event.message_id],
    executable_commands: [],
    confirmation_commands: [],
    ...(notifyPrincipal ? {
      requires_principal_attention: true,
      principal_attention_code: "context_unreadable"
    } : {})
  };
}

function providedLinks(event, decision) {
  const citedSources = new Set(decision.source_refs ?? []);
  return new Set([
    ...(Array.isArray(event.links) ? event.links : []),
    ...(event.context ?? []).flatMap((item) => (
      Array.isArray(item?.links) && (
        EXACT_REFERENCE_RELATIONS.has(item.relation) ||
        citedSources.has(item.message_id)
      )
        ? item.links
        : []
    ))
  ].map(linkEvidenceKey).filter(Boolean));
}

function isReadableHttpLink(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return new Set(["http:", "https:"]).has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function linkEvidenceKey(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function hasReadableFeedbackValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasReadableFeedbackValue);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasReadableFeedbackValue);
  }
  return false;
}

function normalizedFieldName(value) {
  return value
    .trim()
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/[-\s]+/gu, "_")
    .toLowerCase();
}

function hasSubstantiveCapabilityValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasSubstantiveCapabilityValue);
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  const transportEnvelope = entries.some(([key]) => (
    TRANSPORT_ONLY_FIELDS.has(normalizedFieldName(key))
  ));
  return entries.some(([key, item]) => {
    const field = normalizedFieldName(key);
    if (SOURCE_ONLY_FIELDS.has(field) || TRANSPORT_ONLY_FIELDS.has(field)) return false;
    if (
      transportEnvelope &&
      TRANSPORT_RESULT_FIELDS.has(field) &&
      typeof item === "string" &&
      TRANSPORT_ONLY_RESULT_VALUES.has(item.trim().toLowerCase())
    ) return false;
    return hasSubstantiveCapabilityValue(item);
  });
}

function feedbackSourceLinks(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  return [
    data.source_url,
    data.source_link,
    ...(Array.isArray(data.source_urls) ? data.source_urls : []),
    ...(Array.isArray(data.source_links) ? data.source_links : []),
    data.url,
    data.document?.source_url,
    data.document?.source_link,
    data.document?.url
  ].filter((value) => typeof value === "string" && /^https?:\/\//u.test(value));
}

function hasReadableLinkedContent(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return [
    data.content,
    data.text,
    data.body,
    data.records,
    data.rows,
    data.values,
    data.document?.content,
    data.document?.text,
    data.document?.body
  ].some(hasReadableFeedbackValue);
}

function hasReadableExecutionEvidence(event, links) {
  return (event.execution_feedback ?? []).some((item) => {
    if (item?.result?.status !== "complete") return false;
    const operation = item.command?.operation ?? item.command?.argv?.[1] ?? "";
    if (!/(?:fetch|get|inspect|list|read|search)/u.test(operation)) return false;
    const data = item.result.data;
    return hasReadableLinkedContent(data) &&
      feedbackSourceLinks(data).some((link) => links.has(linkEvidenceKey(link)));
  });
}

function hasReadableCapabilityEvidence(event, links) {
  return (event.capability_feedback ?? []).some((item) => {
    const result = item?.result;
    return result?.status === "complete" &&
      hasSubstantiveCapabilityValue(result.data) &&
      (result.source_refs ?? []).some((sourceRef) => links.has(linkEvidenceKey(sourceRef)));
  });
}

function isLinkIndependentAcknowledgement(decision) {
  if (typeof decision.response?.text !== "string") return false;
  const text = stripAuthorityLabel(decision.response.text)
    .normalize("NFKC")
    .replaceAll(/\s+/gu, "")
    .replace(/[。！!，,.]+$/u, "");
  return /^(?:好(?:的)?|收到|已收到|了解|知悉|明白|谢谢|感谢|ok|okay|gotit|received|acknowledged)$/iu.test(text);
}

function requiresLinkFallback(event, decision) {
  const links = providedLinks(event, decision);
  return links.size > 0 &&
    !isLinkIndependentAcknowledgement(decision) &&
    !hasReadableExecutionEvidence(event, links) &&
    !hasReadableCapabilityEvidence(event, links) &&
    decision.outcome !== "ignore" &&
    decision.commands.length === 0 &&
    (decision.lookup_requests ?? []).length === 0 &&
    (decision.action_requests ?? []).length === 0;
}

function finish(runtimeState, eventId, result) {
  if (typeof runtimeState?.completeEvent === "function") {
    if (!runtimeState.completeEvent(eventId)) {
      throw new Error("event processing lease was lost before completion");
    }
  }
  return result;
}

export function classifyCandidate(event) {
  if (typeof event?.text === "string") return { candidate: true, reasonCode: "AI_SCREENING" };
  if (event?.chat_type === "p2p") return { candidate: true, reasonCode: "P2P_MESSAGE" };
  if (event?.signals && Object.values(event.signals).some((value) => value === true)) {
    return { candidate: true, reasonCode: "SIGNALLED_MESSAGE" };
  }
  return { candidate: false, reasonCode: "NO_TEXT_OR_SIGNAL" };
}

export async function processEvent(event, {
  config,
  runtimeState,
  runCodex,
  capabilitySnapshot
} = {}) {
  validateEvent(event);
  validateConfig(config);
  if (typeof runCodex !== "function") throw new TypeError("runCodex must be a function");

  if (typeof runtimeState?.claimEvent === "function" && !runtimeState.claimEvent(event.event_id)) {
    return {
      event_id: event.event_id,
      outcome: "ignore",
      reason: "duplicate event",
      reason_code: DECISION_REASON_CODES.duplicateEvent
    };
  }

  try {
    const principalControlText = event.sender_open_id === config.principal.open_id
      ? event.text?.trim()
      : undefined;
    const control = principalControlText
      ? CONTROL_MESSAGES.get(principalControlText)
      : undefined;
    if (control) {
      runtimeState?.setFrozen?.(control.frozen, control.reason);
      return finish(runtimeState, event.event_id, {
        event_id: event.event_id,
        outcome: "control",
        reason_code: DECISION_REASON_CODES.controlMessage,
        frozen: control.frozen,
        response: null,
        executable_commands: [],
        confirmation_commands: []
      });
    }

    if (principalControlText === RESUME_CONTROL_MESSAGE) {
      const state = runtimeState?.getRuntimeState?.() ?? { frozen: true };
      return finish(runtimeState, event.event_id, {
        event_id: event.event_id,
        outcome: "control",
        control: "resume-request",
        reason: "resume requires the trusted lifecycle readiness check",
        reason_code: DECISION_REASON_CODES.controlMessage,
        requested_frozen: false,
        frozen: state.frozen !== false,
        requires_trusted_lifecycle: true,
        response: null,
        executable_commands: [],
        confirmation_commands: []
      });
    }

    if (
      event.sender_open_id === config.principal.open_id &&
      (event.source !== "event" || event.chat_type !== "p2p")
    ) {
      return finish(runtimeState, event.event_id, {
        event_id: event.event_id,
        outcome: "ignore",
        reason: "principal message has final authority",
        reason_code: DECISION_REASON_CODES.principalMessage,
        response: null,
        executable_commands: [],
        confirmation_commands: []
      });
    }

    const dailyMemoryIntent = trustedDailyMemoryIntent(event, config);
    const candidateEvent = dailyMemoryIntent ? { ...event, ...dailyMemoryIntent } : event;

    if (!classifyCandidate(candidateEvent).candidate) {
      return finish(runtimeState, event.event_id, {
        event_id: event.event_id,
        outcome: "ignore",
        reason: "no candidate content",
        reason_code: DECISION_REASON_CODES.noCandidateContent,
        response: null,
        executable_commands: [],
        confirmation_commands: []
      });
    }

    const state = runtimeState?.getRuntimeState?.() ?? { frozen: false };
    const hasReadableCurrentLink = Array.isArray(candidateEvent.links) &&
      candidateEvent.links.some(isReadableHttpLink);
    if (
      candidateEvent.signals?.content_unreadable === true ||
      (
        candidateEvent.signals?.context_unreadable === true &&
        !hasReadableCurrentLink
      )
    ) {
      return finish(runtimeState, event.event_id, humanContextFallback(
        event,
        state,
        config.principal
      ));
    }
    const projectionIntent = aiProjectionIntent(dailyMemoryIntent, config.principal);
    const decision = validateDecision(await runCodex(
      projectEventForAI(candidateEvent, projectionIntent),
      definedEntries({
        config: projectConfigForAI(config, candidateEvent, projectionIntent),
        capabilities: capabilitySnapshot === undefined
          ? undefined
          : structuredClone(capabilitySnapshot),
        runtime: { frozen: state.frozen === true }
      })
    ), candidateEvent, { silent: dailyMemoryIntent !== null });
    if (requiresLinkFallback(candidateEvent, decision)) {
      return finish(runtimeState, event.event_id, humanContextFallback(
        event,
        state,
        config.principal
      ));
    }
    if (decision.outcome === "ignore") {
      return finish(runtimeState, event.event_id, {
        ...decision,
        reason_code: aiDecisionReasonCode("ignore", {
          contextFetched: candidateEvent.context_meta?.fetched === true
        }),
        response: null,
        action_requests: [],
        executable_commands: [],
        confirmation_commands: []
      });
    }

    if (
      state.frozen !== true &&
      event.sender_open_id !== config.principal.open_id &&
      (decision.action_requests ?? []).length > 0
    ) {
      return finish(runtimeState, event.event_id, {
        ...decision,
        outcome: "reply",
        reason: "participant request requires principal authority",
        reason_code: aiDecisionReasonCode("reply", {
          contextFetched: candidateEvent.context_meta?.fetched === true
        }),
        response: visibleResponse({
          mode: "representative",
          text: `收到，我会提醒${config.principal.name}查看并处理。`
        }, config.principal.name),
        action_requests: [],
        executable_commands: [],
        confirmation_commands: [],
        requires_principal_attention: true,
        principal_attention_code: "participant_authority_required"
      });
    }

    const draftOnly = state.frozen === true;
    const participantConfirmation = !draftOnly &&
      event.sender_open_id !== config.principal.open_id && (
        decision.outcome === "confirm" ||
        decision.commands.some((command) => command.confirmation === "human")
      );
    const actionRequests = draftOnly ? [] : decision.action_requests ?? [];
    const confirmationCommands = draftOnly ? [] : decision.commands.filter((command) =>
      command.confirmation === "human" || decision.outcome === "confirm"
    );
    const executableCommands = draftOnly ? [] : decision.commands.filter((command) =>
      command.confirmation === "auto" && decision.outcome !== "confirm"
    );
    const forceMode = participantConfirmation
      ? "representative"
      : draftOnly
      ? "suggestion"
      : decision.outcome === "confirm" || confirmationCommands.length > 0 || actionRequests.length > 0
      ? "confirmation"
      : undefined;

    return finish(runtimeState, event.event_id, {
      ...decision,
      outcome: draftOnly ? "draft" : participantConfirmation ? "reply" : decision.outcome,
      reason_code: aiDecisionReasonCode(
        draftOnly ? "draft" : participantConfirmation ? "reply" : decision.outcome,
        { contextFetched: candidateEvent.context_meta?.fetched === true }
      ),
      response: participantConfirmation
        ? visibleResponse({
            mode: "representative",
            text: `收到，我会提醒${config.principal.name}查看并处理。`
          }, config.principal.name)
        : decision.response === null
        ? null
        : visibleResponse(decision.response, config.principal.name, { forceMode }),
      action_requests: actionRequests,
      executable_commands: executableCommands,
      confirmation_commands: confirmationCommands,
      ...(participantConfirmation && confirmationCommands.length === 0 ? {
        requires_principal_attention: true,
        principal_attention_code: "participant_authority_required"
      } : {})
    });
  } catch (error) {
    runtimeState?.releaseEvent?.(event.event_id);
    throw error;
  }
}

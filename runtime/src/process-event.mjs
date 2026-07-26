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
const CONTROL_MESSAGES = new Map([
  ["立即冻结数字分身", { frozen: true, reason: "PRINCIPAL_REQUEST" }]
]);
const RESUME_CONTROL_MESSAGE = "恢复数字分身";
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
    ...(event.context ?? []).map((item) => item?.message_id).filter(Boolean)
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
  if (decision.outcome !== "ignore") {
    if (decision.response === null && silent) {
      // Trusted local system events never publish the model response.
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

function contextSenderRole(item, principal) {
  if (hasCurrentOrLegacyAuthorityLabel(item?.content, principal?.name)) {
    return "digital_twin";
  }
  if (item?.sender_open_id === principal?.open_id) return "principal";
  return "participant";
}

function projectContextForAI(context, principal) {
  if (!Array.isArray(context)) return [];
  return context.slice(0, AI_CONTEXT_LIMIT).map((item) => definedEntries({
    message_id: item?.message_id,
    sender_role: contextSenderRole(item, principal),
    content: item?.content,
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
    ...(dailyMemoryIntent ? {} : { chat_id: event.chat_id }),
    chat_type: event.chat_type,
    message_id: event.message_id,
    sent_at: event.sent_at,
    update_time: event.update_time,
    message_type: event.message_type,
    text: event.text,
    thread_id: event.thread_id,
    root_message_id: event.root_message_id,
    reply_to_message_id: event.reply_to_message_id,
    is_external: event.is_external,
    signals: projectSignalsForAI(event.signals),
    context,
    context_meta: projectContextMetaForAI(event.context_meta, context.length),
    reply_retry: event.reply_retry === true ? true : undefined,
    execution_feedback: Array.isArray(event.execution_feedback)
      ? structuredClone(event.execution_feedback)
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
  const confirmationSuffix = `该事项尚未生效，需要${principalName}本人确认后方可执行。`;
  const suffix = mode === "confirmation" && !body.endsWith(confirmationSuffix)
    ? confirmationSuffix
    : "";
  return { mode, text: `${authorityLabel(mode, principalName)}${body}${suffix}` };
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

export async function processEvent(event, { config, runtimeState, runCodex } = {}) {
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
    const projectionIntent = aiProjectionIntent(dailyMemoryIntent, config.principal);
    const decision = validateDecision(await runCodex(
      projectEventForAI(candidateEvent, projectionIntent),
      {
        config: projectConfigForAI(config, candidateEvent, projectionIntent),
        runtime: { frozen: state.frozen === true }
      }
    ), candidateEvent, { silent: dailyMemoryIntent !== null });
    if (decision.outcome === "ignore") {
      return finish(runtimeState, event.event_id, {
        ...decision,
        reason_code: aiDecisionReasonCode("ignore", {
          contextFetched: candidateEvent.context_meta?.fetched === true
        }),
        response: null,
        executable_commands: [],
        confirmation_commands: []
      });
    }

    const draftOnly = state.frozen === true;
    const confirmationCommands = draftOnly ? [] : decision.commands.filter((command) =>
      command.confirmation === "human" || decision.outcome === "confirm"
    );
    const executableCommands = draftOnly ? [] : decision.commands.filter((command) =>
      command.confirmation === "auto" && decision.outcome !== "confirm"
    );
    const forceMode = draftOnly
      ? "suggestion"
      : decision.outcome === "confirm" || confirmationCommands.length > 0
      ? "confirmation"
      : undefined;

    return finish(runtimeState, event.event_id, {
      ...decision,
      outcome: draftOnly ? "draft" : decision.outcome,
      reason_code: aiDecisionReasonCode(draftOnly ? "draft" : decision.outcome, {
        contextFetched: candidateEvent.context_meta?.fetched === true
      }),
      response: decision.response === null
        ? null
        : visibleResponse(decision.response, config.principal.name, { forceMode }),
      executable_commands: executableCommands,
      confirmation_commands: confirmationCommands
    });
  } catch (error) {
    runtimeState?.releaseEvent?.(event.event_id);
    throw error;
  }
}

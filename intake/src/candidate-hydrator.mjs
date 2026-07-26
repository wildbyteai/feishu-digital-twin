import { hasCurrentOrLegacyAuthorityLabel } from "../../shared/authority-labels.mjs";
import { needsRecentChatContext } from "./context-policy.mjs";

const RECENT_CHAT_CONTEXT_LIMIT = 20;

function senderOpenId(message) {
  return message?.sender_id ?? message?.sender?.open_id ?? message?.sender?.id;
}

function topicKey(message) {
  return message?.topic_key ?? message?.thread_id ?? message?.root_message_id ?? message?.root_id ?? null;
}

function eventTopicKey(event) {
  return event.thread_id ?? event.root_message_id ?? null;
}

function timestamp(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function messageTimestamp(message) {
  return timestamp(message?.create_time ?? message?.update_time);
}

function contextItem(message, event, { requireTimestamp = false } = {}) {
  if (
    !message ||
    message.deleted === true ||
    typeof message.message_id !== "string" ||
    typeof message.content !== "string" ||
    message.chat_id !== event.chat_id
  ) return null;
  const currentTimestamp = timestamp(event.sent_at);
  const candidateTimestamp = messageTimestamp(message);
  if (requireTimestamp && !candidateTimestamp) return null;
  if (currentTimestamp && candidateTimestamp && candidateTimestamp > currentTimestamp) return null;
  const expectedTopic = eventTopicKey(event);
  const actualTopic = topicKey(message);
  if (expectedTopic && actualTopic && expectedTopic !== actualTopic) return null;
  return Object.fromEntries(Object.entries({
    message_id: message.message_id,
    sender_open_id: senderOpenId(message) ?? "unknown",
    content: message.content,
    chat_id: message.chat_id,
    topic_key: actualTopic,
    sent_at: candidateTimestamp?.toISOString()
  }).filter(([, value]) => value !== undefined));
}

function appendContext(context, message, event, options) {
  if (message?.message_id === event.message_id) return;
  const item = contextItem(message, event, options);
  if (item && !context.some(({ message_id }) => message_id === item.message_id)) {
    context.push(item);
  }
}

function contextScope(event) {
  if (typeof event.thread_id === "string") return "thread";
  if (typeof event.reply_to_message_id === "string") return "reply";
  return "chat";
}

export async function hydrateCandidate(event, { reader, principal } = {}) {
  if (!reader || !principal?.open_id) throw new TypeError("reader and principal are required");
  const context = [];
  const signals = { ...(event.signals ?? {}) };
  let fetched = false;
  let limit = 0;

  if (typeof event.reply_to_message_id === "string") {
    fetched = true;
    limit = 1;
    const page = await reader.getMessages([event.reply_to_message_id]);
    const parent = page.messages?.find((item) => item.message_id === event.reply_to_message_id);
    const item = contextItem(parent, event);
    if (item) {
      context.push(item);
      if (item.sender_open_id === principal.open_id) {
        signals.reply_to_twin = hasCurrentOrLegacyAuthorityLabel(
          item.content,
          principal.name ?? principal.address_names?.[0] ?? "主体用户"
        );
        signals.reply_to_principal = !signals.reply_to_twin;
      }
    }
  }

  if (typeof event.thread_id === "string") {
    fetched = true;
    limit = RECENT_CHAT_CONTEXT_LIMIT;
    const page = await reader.listThread({
      threadId: event.thread_id,
      order: "desc",
      pageSize: RECENT_CHAT_CONTEXT_LIMIT
    });
    for (const message of page.messages ?? []) {
      if (message.message_id === event.message_id || message.message_id === event.reply_to_message_id) {
        continue;
      }
      appendContext(context, message, event);
    }
  } else if (
    typeof event.reply_to_message_id !== "string" &&
    needsRecentChatContext(event, { principalOpenId: principal.open_id })
  ) {
    fetched = true;
    limit = RECENT_CHAT_CONTEXT_LIMIT;
    const currentTimestamp = timestamp(event.sent_at);
    if (!currentTimestamp) {
      throw new TypeError("standalone group context requires a valid event.sent_at");
    }
    const page = await reader.listMessages({
      chatId: event.chat_id,
      end: currentTimestamp.toISOString(),
      order: "desc",
      pageSize: RECENT_CHAT_CONTEXT_LIMIT
    });
    const recent = [];
    for (const message of page.messages ?? []) {
      appendContext(recent, message, event, { requireTimestamp: true });
    }
    recent.reverse();
    recent.sort((left, right) => Date.parse(left.sent_at) - Date.parse(right.sent_at));
    context.push(...recent);
  }

  const scope = fetched ? contextScope(event) : "none";
  const contextMeta = {
    fetched,
    scope,
    count: context.length,
    limit
  };

  if (scope === "chat") {
    signals.recent_chat_context = context.length > 0;
  } else if (scope === "thread") {
    signals.thread_context = context.length > 0;
  } else if (scope === "reply") {
    signals.reply_context = context.length > 0;
  }

  return {
    ...event,
    signals: { ...signals, context_lookup_required: false },
    context,
    context_meta: contextMeta
  };
}

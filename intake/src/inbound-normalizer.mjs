import { needsRecentChatContext } from "./context-policy.mjs";

function toIsoTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("message timestamp must be a non-empty string");
  }
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError("message timestamp must be valid");
  return timestamp.toISOString();
}

function senderOpenId(raw) {
  return raw.sender_id ?? raw.sender?.open_id ?? raw.sender?.id;
}

function replyToMessageId(raw) {
  return raw.reply_to_message_id ?? raw.parent_id ?? raw.parent_message_id ?? null;
}

function mentionIds(raw) {
  return (raw.mentions ?? [])
    .map((mention) => mention?.id ?? mention?.open_id ?? mention?.openId)
    .filter((value) => typeof value === "string");
}

export function normalizeInboundMessage(raw, { source, principal } = {}) {
  if (!raw || typeof raw !== "object") throw new TypeError("raw message must be an object");
  if (!new Set(["event", "supplement", "simulation"]).has(source)) {
    throw new TypeError("source is invalid");
  }
  if (!principal || typeof principal.open_id !== "string") {
    throw new TypeError("principal.open_id must be configured");
  }
  if (raw.content !== undefined && typeof raw.content !== "string") {
    throw new TypeError("raw message content must be a string when present");
  }

  const messageId = raw.message_id;
  const updateTime = toIsoTimestamp(raw.update_time ?? raw.create_time);
  const senderId = senderOpenId(raw);
  const messageType = raw.message_type ?? raw.msg_type;
  const directMention = mentionIds(raw).includes(principal.open_id) ||
    (principal.address_names ?? []).some((name) => raw.content?.includes(`@${name}`));
  const replyId = replyToMessageId(raw);
  const threadId = raw.thread_id ?? null;
  const standaloneGroupContext = needsRecentChatContext({
    chat_type: raw.chat_type,
    sender_open_id: senderId,
    message_type: messageType,
    text: raw.content,
    reply_to_message_id: replyId,
    thread_id: threadId,
    signals: { direct_mention: directMention }
  }, { principalOpenId: principal.open_id });

  return {
    event: {
      event_id: `message:${messageId}:${updateTime}`,
      delivery_event_id: raw.event_id ?? null,
      source,
      chat_id: raw.chat_id,
      chat_type: raw.chat_type,
      message_id: messageId,
      sender_open_id: senderId,
      sent_at: toIsoTimestamp(raw.create_time),
      update_time: updateTime,
      message_type: messageType,
      text: raw.content,
      thread_id: threadId,
      root_message_id: raw.root_message_id ?? raw.root_id ?? null,
      reply_to_message_id: replyId,
      is_external: typeof raw.is_external === "boolean" ? raw.is_external : null,
      tenant_key: typeof raw.tenant_key === "string" ? raw.tenant_key : null,
      signals: {
        direct_mention: directMention,
        context_lookup_required: typeof replyId === "string" ||
          typeof threadId === "string" ||
          standaloneGroupContext
      },
      context: []
    }
  };
}

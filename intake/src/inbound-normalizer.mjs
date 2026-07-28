import { needsRecentChatContext } from "./context-policy.mjs";

const MAX_VISIBLE_TEXT_BYTES = 8 * 1024;
const MAX_LINKS = 10;
const MAX_LINK_BYTES = 2 * 1024;
const MAX_CONTENT_DEPTH = 6;

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function visibleString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function httpLink(value) {
  const candidate = visibleString(value);
  if (!candidate || Buffer.byteLength(candidate) > MAX_LINK_BYTES) return null;
  try {
    const parsed = new URL(candidate);
    return new Set(["http:", "https:"]).has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function linksInText(value) {
  return visibleString(value).match(/https?:\/\/[^\s<>{}"']+/gu) ?? [];
}

export function projectMessageContent(content, { messageType } = {}) {
  if (typeof content !== "string") {
    throw new TypeError("message content must be a string");
  }
  const textParts = [];
  const links = [];
  const addLink = (value) => {
    const link = httpLink(value);
    if (!link || links.includes(link) || links.length >= MAX_LINKS) return;
    links.push(link);
  };
  const addText = (value) => {
    const text = visibleString(value);
    if (!text || textParts.includes(text)) return;
    textParts.push(text);
    for (const candidate of linksInText(text)) addLink(candidate);
  };
  const visit = (value, depth = 0) => {
    if (depth > MAX_CONTENT_DEPTH || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    addText(value.title);
    addText(value.text);
    addLink(value.url);
    addLink(value.href);
    for (const key of ["zh_cn", "en_us", "content", "elements", "body", "items", "fields", "link"]) {
      if (Object.hasOwn(value, key)) visit(value[key], depth + 1);
    }
  };

  const trimmed = content.trim();
  if (trimmed.length > 0) {
    try {
      visit(JSON.parse(trimmed));
    } catch {
      addText(trimmed);
    }
  }
  const text = truncateUtf8(textParts.join("\n"), MAX_VISIBLE_TEXT_BYTES);
  return {
    text,
    links,
    readable: text.length > 0 || links.length > 0,
    link_only: messageType === "share_link" && links.length > 0
  };
}

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

function parentMessageId(raw) {
  return raw.parent_id ?? raw.parent_message_id ?? raw.reply_to_message_id ?? null;
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
  const projectedContent = projectMessageContent(raw.content ?? "", { messageType });
  const directMention = mentionIds(raw).includes(principal.open_id) ||
    (principal.address_names ?? []).some((name) => projectedContent.text.includes(`@${name}`));
  const replyId = replyToMessageId(raw);
  const parentId = parentMessageId(raw);
  const threadId = raw.thread_id ?? null;
  const chatContextLookupRequired = needsRecentChatContext({
    chat_type: raw.chat_type,
    sender_open_id: senderId,
    message_type: messageType,
    text: projectedContent.text,
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
      text: projectedContent.text,
      ...(projectedContent.links.length > 0 ? { links: projectedContent.links } : {}),
      ...(projectedContent.link_only ? { link_only: true } : {}),
      thread_id: threadId,
      root_message_id: raw.root_message_id ?? raw.root_id ?? null,
      parent_message_id: parentId,
      reply_to_message_id: replyId,
      is_external: typeof raw.is_external === "boolean" ? raw.is_external : null,
      tenant_key: typeof raw.tenant_key === "string" ? raw.tenant_key : null,
      signals: {
        direct_mention: directMention,
        context_lookup_required: typeof replyId === "string" ||
          typeof threadId === "string" ||
          chatContextLookupRequired,
        ...(raw.content?.trim().length > 0 && !projectedContent.readable
          ? { content_unreadable: true }
          : {})
      },
      context: []
    }
  };
}

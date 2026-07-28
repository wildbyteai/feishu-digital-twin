export function needsRecentChatContext(event, { principalOpenId } = {}) {
  if (!event || typeof principalOpenId !== "string" || principalOpenId.length === 0) return false;
  return new Set(["group", "p2p"]).has(event.chat_type) &&
    event.sender_open_id !== principalOpenId &&
    new Set(["text", "post", "rich_text", "share_link"]).has(event.message_type) &&
    typeof event.text === "string" &&
    event.text.length > 0 &&
    (event.chat_type === "p2p" || event.signals?.direct_mention !== true) &&
    typeof event.reply_to_message_id !== "string" &&
    typeof event.parent_message_id !== "string" &&
    typeof event.root_message_id !== "string" &&
    typeof event.thread_id !== "string";
}

export function needsContextHydration(event, { principalOpenId } = {}) {
  if (
    !event ||
    event.type === "supplement_checkpoint" ||
    event.source === "system" ||
    event.sender_open_id === principalOpenId
  ) return false;
  return typeof event.reply_to_message_id === "string" ||
    typeof event.parent_message_id === "string" ||
    typeof event.root_message_id === "string" ||
    typeof event.thread_id === "string" ||
    needsRecentChatContext(event, { principalOpenId });
}

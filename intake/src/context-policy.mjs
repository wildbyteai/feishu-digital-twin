export function needsRecentChatContext(event, { principalOpenId } = {}) {
  if (!event || typeof principalOpenId !== "string" || principalOpenId.length === 0) return false;
  return event.chat_type === "group" &&
    event.sender_open_id !== principalOpenId &&
    event.message_type === "text" &&
    typeof event.text === "string" &&
    event.signals?.direct_mention !== true &&
    typeof event.reply_to_message_id !== "string" &&
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
    typeof event.thread_id === "string" ||
    needsRecentChatContext(event, { principalOpenId });
}

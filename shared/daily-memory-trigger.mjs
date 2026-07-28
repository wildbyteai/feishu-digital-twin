const SYSTEM_SENDER_OPEN_ID = "system:daily-memory";

export function validIsoDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? "");
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function padded(value) {
  return String(value).padStart(2, "0");
}

export function previousDateInTimeZone(value = new Date(), timeZone = "Asia/Shanghai") {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new TypeError("value must be a valid date");
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new TypeError("timeZone must be configured");
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  const previous = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) - 1
  ));
  return `${previous.getUTCFullYear()}-${padded(previous.getUTCMonth() + 1)}-${padded(previous.getUTCDate())}`;
}

export function dailyMemorySystemEvent(targetDate, { now = new Date() } = {}) {
  if (!validIsoDate(targetDate)) throw new TypeError("targetDate must be a valid YYYY-MM-DD date");
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new TypeError("now must be a valid date");
  const timestamp = instant.toISOString();
  const unique = `${targetDate}:${instant.getTime()}`;
  return {
    type: "daily_work_memory",
    event_id: `system:daily-memory:${unique}`,
    source: "system",
    chat_id: "system:daily-memory",
    chat_type: "p2p",
    message_id: `system:daily-memory:${unique}`,
    sender_open_id: SYSTEM_SENDER_OPEN_ID,
    sent_at: timestamp,
    update_time: timestamp,
    message_type: "text",
    text: `生成 ${targetDate} 每日工作记忆`,
    target_date: targetDate,
    thread_id: null,
    root_message_id: null,
    reply_to_message_id: null,
    signals: {},
    context: []
  };
}

export function trustedDailyMemoryIntent(event, config) {
  if (
    typeof config?.daily_memory?.folder_token !== "string" ||
    config.daily_memory.folder_token.length === 0 ||
    event?.type !== "daily_work_memory" ||
    event?.source !== "system" ||
    event?.sender_open_id !== SYSTEM_SENDER_OPEN_ID ||
    !validIsoDate(event?.target_date)
  ) return null;
  return { intent: "daily_work_memory", target_date: event.target_date };
}

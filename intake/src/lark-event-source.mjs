const MESSAGE_EVENT = "im.message.receive_v1";

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function buildEventCommand({ larkBin = "lark-cli", profile, eventKey }) {
  return [
    requireText(larkBin, "larkBin"),
    "--profile",
    requireText(profile, "profile"),
    "event",
    "consume",
    eventKey,
    "--as",
    "bot"
  ];
}

export function buildOfficialEventCommand(options) {
  return buildEventCommand({ ...options, eventKey: MESSAGE_EVENT });
}

export function officialEventToRawMessage(event, chatMetadata) {
  if (!event || typeof event !== "object" || event.type !== MESSAGE_EVENT) {
    throw new TypeError(`event must be ${MESSAGE_EVENT}`);
  }

  const required = [
    "event_id",
    "chat_id",
    "chat_type",
    "message_id",
    "sender_id",
    "create_time",
    "message_type",
    "content"
  ];
  for (const field of required) requireText(event[field], `event.${field}`);
  const metadata = chatMetadata && typeof chatMetadata === "object" ? chatMetadata : {};
  const external = [metadata.external, metadata.is_external]
    .find((value) => typeof value === "boolean") ?? null;
  const optional = Object.fromEntries([
    "reply_to_message_id",
    "parent_id",
    "parent_message_id",
    "root_id",
    "root_message_id",
    "thread_id",
    "mentions"
  ].filter((field) => event[field] !== undefined).map((field) => [field, event[field]]));

  return {
    event_id: event.event_id,
    chat_id: event.chat_id,
    chat_type: event.chat_type,
    message_id: event.message_id,
    sender_id: event.sender_id,
    create_time: event.create_time,
    update_time: event.update_time ?? event.create_time,
    message_type: event.message_type,
    content: event.content,
    ...optional,
    is_external: external,
    tenant_key: typeof metadata.tenant_key === "string" ? metadata.tenant_key : null
  };
}

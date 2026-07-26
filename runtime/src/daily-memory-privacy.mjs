const OMIT = Symbol("omit-private-value");
const THREAD_ID = /^(?:om|omt)_[A-Za-z0-9_-]+$/u;

function configuredValues(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

function normalizedTopic(value) {
  return value.normalize("NFKC").toLowerCase();
}

function topicMetadata(message) {
  return {
    threadId: typeof message.thread_id === "string" && message.thread_id.length > 0
      ? normalizedTopic(message.thread_id)
      : null,
    labels: [message.topic, message.topic_name, message.thread_title, message.title]
      .filter((value) => typeof value === "string" && value.length > 0)
      .map(normalizedTopic)
  };
}

function topicDecision(metadata, excludedTopics) {
  for (const topic of excludedTopics) {
    if (topic.kind === "thread") {
      if (metadata.threadId === null) return "unavailable";
      if (metadata.threadId === topic.value) return "excluded";
      continue;
    }
    if (metadata.labels.length === 0) return "unavailable";
    if (metadata.labels.some((label) => label.includes(topic.value))) return "excluded";
  }
  return "allowed";
}

function isMessageRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) && (
    Object.hasOwn(value, "message_id") ||
    Object.hasOwn(value, "chat_id") ||
    Object.hasOwn(value, "msg_type")
  );
}

function projectNestedValue(value, policy, stats) {
  if (Array.isArray(value)) {
    const projected = [];
    for (const item of value) {
      const child = isMessageRecord(item)
        ? projectMessageRecord(item, policy, stats)
        : projectNestedValue(item, policy, stats);
      if (child !== OMIT) projected.push(child);
    }
    return projected;
  }
  if (!value || typeof value !== "object") return value;

  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    const childValue = isMessageRecord(child)
      ? projectMessageRecord(child, policy, stats)
      : projectNestedValue(child, policy, stats);
    if (childValue !== OMIT) projected[key] = childValue;
  }
  return projected;
}

function projectMessageRecord(item, policy, stats) {
  const chatId = item.chat_id;
  if (policy.excludedChatIds.size > 0 && (
    typeof chatId !== "string" || chatId.length === 0
  )) {
    stats.unavailable += 1;
    return OMIT;
  }
  if (policy.excludedChatIds.has(chatId)) return OMIT;

  if (policy.excludedTopics.length > 0) {
    const metadata = topicMetadata(item);
    const decision = topicDecision(metadata, policy.excludedTopics);
    if (decision === "unavailable") {
      stats.unavailable += 1;
      return OMIT;
    }
    if (decision === "excluded") return OMIT;
  }

  return projectNestedValue(item, policy, stats);
}

function projectMessageCollection(value, policy, stats) {
  if (!Array.isArray(value)) {
    stats.unavailable += 1;
    return [];
  }

  const messages = [];
  for (const item of value) {
    if (Array.isArray(item)) {
      messages.push(...projectMessageCollection(item, policy, stats));
      continue;
    }
    if (!item || typeof item !== "object") {
      stats.unavailable += 1;
      continue;
    }
    const projected = projectMessageRecord(item, policy, stats);
    if (projected !== OMIT) messages.push(projected);
  }
  return messages;
}

function projectSearchData(data, policy) {
  const stats = { messages: [], unavailable: 0 };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    stats.unavailable = 1;
  } else if (Object.hasOwn(data, "messages")) {
    stats.messages = projectMessageCollection(data.messages, policy, stats);
  } else if (Object.hasOwn(data, "message_ids")) {
    stats.unavailable = Array.isArray(data.message_ids)
      ? Math.max(1, data.message_ids.length)
      : 1;
  } else {
    stats.unavailable = 1;
  }

  const projected = {
    messages: stats.messages,
    total: stats.messages.length
  };
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (typeof data.has_more === "boolean") projected.has_more = data.has_more;
    if (typeof data.page_token === "string") projected.page_token = data.page_token;
  }
  if (stats.unavailable > 0) {
    projected.privacy_gaps = [{
      code: "privacy_metadata_unavailable",
      count: stats.unavailable
    }];
  }
  return projected;
}

export function projectDailyMemorySearchResult(command, result, {
  excludedChatIds,
  excludedTopics
} = {}) {
  if (
    command?.argv?.[0] !== "im" ||
    command.argv[1] !== "+messages-search" ||
    result?.status !== "complete"
  ) {
    return result;
  }

  const chatIds = configuredValues(excludedChatIds, "excludedChatIds");
  const topics = configuredValues(excludedTopics, "excludedTopics");
  if (chatIds.length === 0 && topics.length === 0) return result;

  const policy = {
    excludedChatIds: new Set(chatIds),
    excludedTopics: topics.map((topic) => ({
      kind: THREAD_ID.test(topic) ? "thread" : "label",
      value: normalizedTopic(topic)
    }))
  };
  return {
    ...result,
    data: projectSearchData(result.data, policy)
  };
}

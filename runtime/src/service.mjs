import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { hydrateCandidate } from "../../intake/src/candidate-hydrator.mjs";
import { needsContextHydration } from "../../intake/src/context-policy.mjs";
import { authorityLabel, stripAuthorityLabel } from "../../shared/authority-labels.mjs";
import {
  dailyMemorySystemEvent,
  trustedDailyMemoryIntent
} from "../../shared/daily-memory-trigger.mjs";
import { processEvent } from "./process-event.mjs";
import { runCodexDecision } from "./codex-runner.mjs";
import { sendPrivateConfirmation } from "./confirmation-channel.mjs";
import {
  assertDailyMemoryCommand,
  assertDailyMemoryCompletion,
  dailyMemoryProgress,
  dailyMemoryVerificationStatus,
  requiredDailyMemoryVerificationCommand
} from "./daily-memory-postcondition.mjs";
import {
  DECISION_REASON_CODES,
  safeDecisionReasonCode
} from "./decision-diagnostics.mjs";
import { projectDailyMemorySearchResult } from "./daily-memory-privacy.mjs";

const CONFIRMATION_REPLY = /^(确认|拒绝)\s+([a-f0-9]{16})$/u;
const CONTEXT_SCOPES = new Set(["none", "chat", "reply", "thread"]);
const EXECUTION_FEEDBACK_MAX_BYTES = 64 * 1024;
const EXECUTION_FEEDBACK_MAX_ITEMS = 15;
const EXECUTION_FEEDBACK_MAX_DATA_BYTES = 8 * 1024;
const EXECUTION_FEEDBACK_MAX_DEPTH = 5;
const EXECUTION_FEEDBACK_MAX_ARRAY_ITEMS = 20;
const EXECUTION_FEEDBACK_MAX_OBJECT_FIELDS = 40;
const EXECUTION_FEEDBACK_MAX_STRING_BYTES = 4 * 1024;
const EXECUTION_FEEDBACK_MAX_REASON_BYTES = 512;
const STABLE_FEEDBACK_TOKEN = /^[+A-Za-z0-9][+A-Za-z0-9_.-]{0,127}$/u;
const DAILY_MEMORY_VERIFICATION_RETRY_DELAYS_MS = Object.freeze([500, 1500]);

function confirmationId(eventId, commandHash, requiresYes) {
  const kind = requiresYes ? "official-high-risk" : "business";
  return createHash("sha256").update(`${eventId}:${commandHash}:${kind}`).digest("hex").slice(0, 16);
}

function executionHash(scope, commandHash) {
  return createHash("sha256").update(`${scope}:${commandHash}`).digest("hex");
}

function shortIdempotencyKey(prefix, value) {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function replyIdentity(event) {
  return event.source === "event" ? "bot" : "user";
}

function isSilentSystemEvent(event, config) {
  return event.source === "system" && trustedDailyMemoryIntent(event, config) !== null;
}

function isForbiddenDailyImCommand(command) {
  return command?.argv?.[0] === "im" && command.argv[1] !== "+messages-search";
}

function isDailyMemoryWriteCommand(command) {
  return command?.argv?.[0] === "docs" &&
    new Set(["+create", "+update"]).has(command.argv[1]);
}

function isDailyMemoryFetchCommand(command) {
  return command?.argv?.[0] === "docs" && command.argv[1] === "+fetch";
}

function replyRetryKey(eventId) {
  return executionHash(eventId, "reply-retry");
}

function isMessageReply(command) {
  const argv = command?.argv ?? [];
  const operation = argv.slice(1, 3).join(" ").toLowerCase();
  return argv[0] === "im" && (
    /messages[-_]reply/u.test(argv[1]?.toLowerCase() ?? "") || operation === "messages reply"
  );
}

function replyActionIdentity(command, sourceReplyIdentity = "user") {
  return sourceReplyIdentity === "bot" && isMessageReply(command) ? "bot" : "user";
}

function isRetryableMessageReply(command) {
  const argv = command?.argv ?? [];
  const inlineKeyPrefix = "--idempotency-key=";
  const keyIndex = argv.indexOf("--idempotency-key");
  const hasIdempotencyKey = keyIndex >= 0
    ? typeof argv[keyIndex + 1] === "string" && argv[keyIndex + 1].length > 0
    : argv.some((value) => value.startsWith(inlineKeyPrefix) && value.length > inlineKeyPrefix.length);
  return isMessageReply(command) && hasIdempotencyKey;
}

function statusCode(result) {
  return result.error_type ?? result.status.toUpperCase().replaceAll("-", "_");
}

function highRiskDecision(decision, principalName) {
  const body = stripAuthorityLabel(decision.response?.text ?? "建议执行该动作。");
  return {
    ...decision,
    outcome: "confirm",
    response: {
      mode: "confirmation",
      text: `${authorityLabel("confirmation", principalName)}${body}飞书已将相关动作标记为高风险，确认前不会执行。`
    },
    executable_commands: [],
    confirmation_commands: []
  };
}

function actionLimitDecision(decision) {
  const body = stripAuthorityLabel(decision.response?.text ?? "该事项仍需继续处理。");
  return {
    ...decision,
    outcome: "reply",
    response: {
      mode: "suggestion",
      text: `${authorityLabel("suggestion", "主体用户")}${body}自动处理已达到本次步骤上限，请人工检查后继续。`
    },
    executable_commands: [],
    confirmation_commands: []
  };
}

function executionFeedback(command, result, round) {
  return {
    round,
    command: { argv: command.argv, reason: command.reason },
    result: Object.fromEntries(Object.entries({
      status: result.status,
      command_hash: result.command_hash,
      error_type: result.error_type,
      error: result.error,
      risk: result.risk,
      data: result.data
    }).filter(([, value]) => value !== undefined && value !== null))
  };
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) return "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function stableFeedbackToken(value, fallback = "unknown") {
  return typeof value === "string" && STABLE_FEEDBACK_TOKEN.test(value)
    ? value
    : fallback;
}

function boundedFeedbackValue(value, {
  depth = 0,
  maxBytes,
  truncation
}) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const projected = truncateUtf8(
      value,
      Math.min(maxBytes, EXECUTION_FEEDBACK_MAX_STRING_BYTES)
    );
    if (projected !== value) truncation.value = true;
    return projected;
  }
  if (depth >= EXECUTION_FEEDBACK_MAX_DEPTH) {
    truncation.value = true;
    return null;
  }
  if (Array.isArray(value)) {
    const projected = [];
    const limit = Math.min(value.length, EXECUTION_FEEDBACK_MAX_ARRAY_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      const remainingItems = limit - index;
      const remainingBytes = Math.max(16, maxBytes - jsonBytes(projected));
      const item = boundedFeedbackValue(value[index], {
        depth: depth + 1,
        maxBytes: Math.max(16, Math.floor(remainingBytes / remainingItems)),
        truncation
      });
      const candidate = [...projected, item];
      if (jsonBytes(candidate) > maxBytes) {
        truncation.value = true;
        break;
      }
      projected.push(item);
    }
    if (projected.length < value.length) truncation.value = true;
    return projected;
  }
  if (value && typeof value === "object") {
    const projected = {};
    const entries = Object.entries(value);
    const limit = Math.min(entries.length, EXECUTION_FEEDBACK_MAX_OBJECT_FIELDS);
    for (let index = 0; index < limit; index += 1) {
      const [rawKey, child] = entries[index];
      const key = truncateUtf8(rawKey, 128);
      if (key !== rawKey) truncation.value = true;
      const remainingFields = limit - index;
      const remainingBytes = Math.max(16, maxBytes - jsonBytes(projected));
      const childValue = boundedFeedbackValue(child, {
        depth: depth + 1,
        maxBytes: Math.max(16, Math.floor(remainingBytes / remainingFields)),
        truncation
      });
      const candidate = { ...projected, [key]: childValue };
      if (jsonBytes(candidate) > maxBytes) {
        truncation.value = true;
        break;
      }
      projected[key] = childValue;
    }
    if (Object.keys(projected).length < entries.length) truncation.value = true;
    return projected;
  }
  truncation.value = true;
  return null;
}

function projectedFeedbackSkeleton(item) {
  const argv = Array.isArray(item?.command?.argv) ? item.command.argv : [];
  const result = item?.result ?? {};
  return {
    round: Number.isInteger(item?.round) && item.round > 0 ? item.round : 0,
    command: {
      domain: stableFeedbackToken(argv[0]),
      operation: stableFeedbackToken(argv[1]),
      reason: truncateUtf8(
        typeof item?.command?.reason === "string" ? item.command.reason : "",
        EXECUTION_FEEDBACK_MAX_REASON_BYTES
      )
    },
    result: Object.fromEntries(Object.entries({
      status: stableFeedbackToken(result.status),
      error_type: result.error_type === undefined
        ? undefined
        : stableFeedbackToken(result.error_type)
    }).filter(([, value]) => value !== undefined))
  };
}

export function projectExecutionFeedback(feedback) {
  if (!Array.isArray(feedback)) throw new TypeError("execution feedback must be an array");
  const source = feedback.slice(-EXECUTION_FEEDBACK_MAX_ITEMS);
  const projected = source.map(projectedFeedbackSkeleton);
  const dataItems = source
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.result?.status === "complete" && item.result.data !== undefined);

  for (let position = 0; position < dataItems.length; position += 1) {
    const { item, index } = dataItems[position];
    const remainingItems = dataItems.length - position;
    const remainingBytes = EXECUTION_FEEDBACK_MAX_BYTES - jsonBytes(projected);
    const dataBudget = Math.min(
      EXECUTION_FEEDBACK_MAX_DATA_BYTES,
      Math.max(128, Math.floor(remainingBytes / Math.max(1, remainingItems)) - 64)
    );
    const truncation = { value: false };
    const data = boundedFeedbackValue(item.result.data, {
      maxBytes: dataBudget,
      truncation
    });
    const candidate = structuredClone(projected);
    candidate[index].result.data = data;
    if (truncation.value) candidate[index].result.data_truncated = true;
    if (jsonBytes(candidate) <= EXECUTION_FEEDBACK_MAX_BYTES) {
      projected[index].result.data = data;
      if (truncation.value) projected[index].result.data_truncated = true;
    } else {
      projected[index].result.data_truncated = true;
    }
  }

  return projected;
}

function stateView(state) {
  return {
    getRuntimeState: () => state.getRuntimeState(),
    setFrozen: (frozen, reason) => state.setFrozen(frozen, reason)
  };
}

function contextDiagnostics(event, result) {
  const meta = event?.context_meta;
  const count = Number.isInteger(meta?.count) && meta.count >= 0 ? meta.count : 0;
  const scope = CONTEXT_SCOPES.has(meta?.scope)
    ? meta.scope
    : "none";
  const contextFetched = meta?.fetched === true;
  return {
    context_fetched: contextFetched,
    context_count: count,
    context_scope: scope,
    decision_reason_code: safeDecisionReasonCode(result?.reason_code, {
      outcome: result?.outcome,
      contextFetched
    })
  };
}

function withProcessingLatency(result, startedAt) {
  const diagnostics = result?.diagnostics ?? {};
  return {
    ...result,
    diagnostics: {
      context_fetched: diagnostics.context_fetched === true,
      context_count: Number.isInteger(diagnostics.context_count) && diagnostics.context_count >= 0
        ? diagnostics.context_count
        : 0,
      context_scope: CONTEXT_SCOPES.has(diagnostics.context_scope)
        ? diagnostics.context_scope
        : "none",
      decision_reason_code: safeDecisionReasonCode(
        diagnostics.decision_reason_code ?? result?.reason_code,
        {
          outcome: result?.outcome,
          contextFetched: diagnostics.context_fetched === true
        }
      ),
      processing_latency_ms: Math.max(0, Math.round(performance.now() - startedAt))
    }
  };
}

export class TwinService {
  constructor({
    config,
    state,
    guard,
    reader,
    runCodex = runCodexDecision,
    sendConfirmation = sendPrivateConfirmation,
    refreshProductionEnabled = async () => config.production_enabled === true,
    clock = () => new Date().toISOString(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  }) {
    if (!config || !state || !guard) throw new TypeError("config, state and guard are required");
    if (typeof refreshProductionEnabled !== "function") {
      throw new TypeError("refreshProductionEnabled must be a function");
    }
    if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
    this.config = config;
    this.state = state;
    this.guard = guard;
    this.reader = reader;
    this.runCodex = runCodex;
    this.sendConfirmation = sendConfirmation;
    this.refreshProductionEnabled = refreshProductionEnabled;
    this.clock = clock;
    this.sleep = sleep;
  }

  async executeCommand(command, { confirmed = false, executionScope, identity = "user" } = {}) {
    if (typeof executionScope !== "string" || executionScope.length === 0) {
      throw new TypeError("executionScope is required");
    }
    const runtime = this.state.getRuntimeState();
    const plan = this.guard.plan(command, {
      productionEnabled: this.config.production_enabled === true,
      frozen: runtime.frozen,
      identity
    });
    const legacyExecutionKey = executionHash(executionScope, plan.command_hash);
    const executionKey = this.state.executionKey(legacyExecutionKey);
    const existing = this.state.getExecution(executionKey) ??
      this.state.getExecution(legacyExecutionKey);
    const retryRunning = isRetryableMessageReply(command);
    if (existing && (
      new Set(["complete", "preview-only"]).has(existing.status) ||
      (existing.status === "running" && !retryRunning)
    )) {
      return {
        status: "duplicate",
        command_hash: plan.command_hash,
        execution_hash: executionKey
      };
    }

    this.state.recordExecution({
      command_hash: executionKey,
      status: "running",
      result_code: null
    });
    const result = await this.guard.execute(command, {
      productionEnabled: this.config.production_enabled === true,
      frozen: runtime.frozen,
      confirmed,
      identity
    });
    this.state.recordExecution({
      command_hash: executionKey,
      status: result.status,
      result_code: statusCode(result)
    });
    return { ...result, execution_hash: executionKey };
  }

  async requestConfirmation(event, command, {
    requiresYes = false,
    risk = null,
    preview = null,
    sourceReplyIdentity = replyIdentity(event)
  } = {}) {
    const identity = replyActionIdentity(command, sourceReplyIdentity);
    const plan = this.guard.plan(command, {
      productionEnabled: this.config.production_enabled === true,
      frozen: this.state.getRuntimeState().frozen,
      identity
    });
    const id = confirmationId(event.event_id, plan.command_hash, requiresYes);
    const expiresAt = new Date(Date.parse(this.clock()) + 10 * 60 * 1000).toISOString();
    const existing = this.state.getConfirmation(id);
    if (!existing) {
      this.state.createConfirmation({
        confirmation_id: id,
        action_hash: plan.command_hash,
        operator_open_id: this.config.principal.open_id,
        expires_at: expiresAt,
        action: command,
        reason: command.reason,
        requires_yes: requiresYes,
        source_event_id: event.event_id,
        source_chat_id: event.chat_id,
        source_message_id: event.message_id,
        source_reply_identity: sourceReplyIdentity
      });
    }
    const delivery = await this.sendConfirmation({
      larkBin: this.config.lark_cli_bin ?? "lark-cli",
      profile: this.config.profile,
      principalOpenId: this.config.principal.open_id,
      principalName: this.config.principal.name,
      confirmationId: id,
      reason: command.reason,
      requiresYes,
      risk,
      preview,
      productionEnabled: this.config.production_enabled === true
    });
    if (delivery.status === "failed") throw new Error("private confirmation delivery failed");
    return { confirmation_id: id, delivery };
  }

  async handleConfirmationReply(event, match) {
    const id = match[2];
    const confirmation = this.state.getConfirmation(id);
    if (!confirmation) {
      return {
        event_id: event.event_id,
        outcome: "ignore",
        reason: "unknown confirmation",
        reason_code: DECISION_REASON_CODES.unknownConfirmation
      };
    }
    const decision = match[1] === "确认" ? "approve" : "reject";
    const actionIdentity = replyActionIdentity(
      confirmation.action,
      confirmation.source_reply_identity
    );
    const actionHash = decision === "approve" && confirmation.action
      ? this.guard.plan(confirmation.action, {
          productionEnabled: this.config.production_enabled === true,
          frozen: this.state.getRuntimeState().frozen,
          identity: actionIdentity
        }).command_hash
      : confirmation.action_hash;
    const resolution = this.state.resolveConfirmation({
      confirmation_id: id,
      action_hash: actionHash,
      operator_open_id: event.sender_open_id,
      event_id: event.event_id,
      decision
    });
    if (!resolution.accepted) {
      return {
        event_id: event.event_id,
        outcome: "confirmation",
        reason_code: DECISION_REASON_CODES.confirmationResult,
        resolution
      };
    }
    if (resolution.status === "rejected") {
      const notification = confirmation.source_message_id
        ? await this.executeCommand({
            argv: [
              "im",
              "+messages-reply",
              "--message-id",
              confirmation.source_message_id,
              "--text",
              `${authorityLabel("suggestion", this.config.principal.name)}${this.config.principal.name}未确认“${confirmation.reason}”，该事项不执行。`,
              "--idempotency-key",
              `twin-reject-${id}`
            ],
            reason: "公开确认拒绝结果"
          }, {
            executionScope: `${confirmation.source_event_id ?? id}:rejection`,
            identity: confirmation.source_reply_identity
          })
        : null;
      this.state.clearConfirmationPayload(id);
      return {
        event_id: event.event_id,
        outcome: "confirmation",
        reason_code: DECISION_REASON_CODES.confirmationResult,
        resolution,
        notification
      };
    }
    const execution = confirmation.action
      ? await this.executeCommand(confirmation.action, {
          confirmed: confirmation.requires_yes,
          executionScope: confirmation.source_event_id ?? id,
          identity: actionIdentity
        })
      : { status: "failed", error_type: "MISSING_ACTION" };
    const followupConfirmation = execution.status === "confirmation-required" && !confirmation.requires_yes
      ? await this.requestConfirmation({
          event_id: confirmation.source_event_id ?? event.event_id,
          chat_id: confirmation.source_chat_id ?? event.chat_id,
          message_id: confirmation.source_message_id ?? event.message_id
        }, confirmation.action, {
          requiresYes: true,
          risk: execution.risk,
          preview: execution.preview,
          sourceReplyIdentity: confirmation.source_reply_identity
        })
      : null;
    const notification = confirmation.source_message_id
      ? await this.executeCommand({
          argv: [
            "im",
            "+messages-reply",
            "--message-id",
            confirmation.source_message_id,
            "--text",
            followupConfirmation
              ? `${authorityLabel("confirmation", this.config.principal.name)}业务确认已收到，但飞书将该动作标记为高风险，已再次发送本人确认。`
              : execution.status === "complete"
              ? `${authorityLabel("representative", this.config.principal.name)}${this.config.principal.name}已确认“${confirmation.reason}”，相关动作已执行。`
              : `${authorityLabel("suggestion", this.config.principal.name)}${this.config.principal.name}已确认“${confirmation.reason}”，但动作未完成，请人工检查。`,
            "--idempotency-key",
            `twin-confirm-result-${id}`
          ],
          reason: "公开确认执行结果"
        }, {
          executionScope: `${confirmation.source_event_id ?? id}:result`,
          identity: confirmation.source_reply_identity
        })
      : null;
    this.state.clearConfirmationPayload(id);
    return {
      event_id: event.event_id,
      outcome: "confirmation",
      reason_code: DECISION_REASON_CODES.confirmationResult,
      resolution,
      execution,
      notification,
      confirmations: followupConfirmation ? [followupConfirmation] : []
    };
  }

  async handle(event) {
    if (event?.source === "system") {
      throw new Error("system events require the trusted runtime entry");
    }
    const startedAt = performance.now();
    return withProcessingLatency(await this.#handle(event), startedAt);
  }

  async runDailyMemory(targetDate, { now = new Date() } = {}) {
    const event = dailyMemorySystemEvent(targetDate, { now });
    if (!isSilentSystemEvent(event, this.config)) {
      throw new Error("daily memory system event is not configured");
    }
    const lockOwner = randomUUID();
    if (!this.state.claimDailyMemoryRun(targetDate, lockOwner)) {
      throw new Error(`daily memory for ${targetDate} is already running`);
    }
    try {
      return await this.#handle(event, {
        dailyMemoryLock: { targetDate, ownerId: lockOwner }
      });
    } finally {
      this.state.releaseDailyMemoryRun(targetDate, lockOwner);
    }
  }

  async #handle(event, { dailyMemoryLock = null } = {}) {
    if (event.type !== "supplement_checkpoint") {
      const enabled = await this.refreshProductionEnabled();
      if (typeof enabled !== "boolean") {
        throw new TypeError("refreshProductionEnabled must return a boolean");
      }
      this.config.production_enabled = enabled;
    }
    if (!this.state.claimEvent(event.event_id)) {
      return {
        event_id: event.event_id,
        outcome: "ignore",
        reason: "duplicate event",
        reason_code: DECISION_REASON_CODES.duplicateEvent
      };
    }
    try {
      if (event.type === "supplement_checkpoint") {
        if (!this.state.areEventsComplete(event.event_ids)) {
          this.state.completeEvent(event.event_id);
          return {
            event_id: event.event_id,
            outcome: "checkpoint-deferred",
            reason_code: DECISION_REASON_CODES.checkpointDeferred
          };
        }
        this.state.setSupplementCheckpoint(event.chat_id, event.last_read_at);
        this.state.completeEvent(event.event_id);
        return {
          event_id: event.event_id,
          outcome: "checkpoint",
          reason_code: DECISION_REASON_CODES.checkpoint
        };
      }

      if (this.config.production_enabled !== true) {
        this.state.completeEvent(event.event_id);
        return {
          event_id: event.event_id,
          outcome: "ignore",
          reason: "digital twin disabled",
          reason_code: DECISION_REASON_CODES.digitalTwinDisabled
        };
      }

      const legacyRetryKey = replyRetryKey(event.event_id);
      const retryKey = this.state.executionKey(legacyRetryKey);
      const retryingReply = (
        this.state.getExecution(retryKey) ?? this.state.getExecution(legacyRetryKey)
      )?.status === "pending";

      const confirmationMatch = event.chat_type === "p2p" &&
        event.sender_open_id === this.config.principal.open_id
        ? CONFIRMATION_REPLY.exec(event.text?.trim() ?? "")
        : null;
      if (confirmationMatch) {
        const result = await this.handleConfirmationReply(event, confirmationMatch);
        this.state.completeEvent(event.event_id);
        return result;
      }

      const hydrated = this.reader && needsContextHydration(event, {
        principalOpenId: this.config.principal.open_id
      })
        ? await hydrateCandidate(event, { reader: this.reader, principal: this.config.principal })
        : event;
      const executions = [];
      const confirmations = [];
      const feedback = [];
      const silentSystemEvent = isSilentSystemEvent(event, this.config);
      const maxActionRounds = this.config.max_ai_action_rounds ?? 3;
      if (!Number.isInteger(maxActionRounds) || maxActionRounds < 1 || maxActionRounds > 3) {
        throw new TypeError("config.max_ai_action_rounds must be an integer between 1 and 3");
      }
      let actionRounds = 0;
      let emptyDailyDecisionRetries = 0;
      let automaticDailyVerificationAttempted = false;
      let decision;
      while (true) {
        if (
          silentSystemEvent &&
          (!dailyMemoryLock || !this.state.renewDailyMemoryRun(
            dailyMemoryLock.targetDate,
            dailyMemoryLock.ownerId
          ))
        ) {
          throw new Error("daily memory lock was lost during execution");
        }
        const progress = silentSystemEvent
          ? dailyMemoryProgress({
              feedback,
              targetDate: event.target_date,
              folderToken: this.config.daily_memory.folder_token,
              principalName: this.config.principal.name
            })
          : null;
        const input = {
          ...hydrated,
          reply_retry: retryingReply,
          execution_feedback: projectExecutionFeedback(feedback),
          action_budget_remaining: maxActionRounds - actionRounds,
          ...(progress ? {
            daily_memory_progress: progress,
            daily_memory_retry_count: emptyDailyDecisionRetries
          } : {})
        };
        decision = await processEvent(input, {
          config: this.config,
          runtimeState: stateView(this.state),
          runCodex: (candidate, context) => this.runCodex(candidate, {
            promptContext: context
          })
        });

        if (silentSystemEvent && (
          decision.outcome === "confirm" ||
          (decision.confirmation_commands ?? []).length > 0
        )) {
          throw new Error("silent system event cannot request confirmation");
        }

        if (retryingReply) {
          decision = {
            ...decision,
            executable_commands: [],
            confirmation_commands: []
          };
          break;
        }

        for (const command of decision.confirmation_commands ?? []) {
          confirmations.push(await this.requestConfirmation(event, command, { requiresYes: false }));
        }

        let commands = decision.executable_commands ?? [];
        if (
          silentSystemEvent &&
          commands.length === 0 &&
          decision.outcome !== "draft" &&
          progress?.write_complete === true &&
          progress.verification_complete !== true &&
          automaticDailyVerificationAttempted === false
        ) {
          const verificationCommand = requiredDailyMemoryVerificationCommand({
            feedback,
            targetDate: event.target_date,
            folderToken: this.config.daily_memory.folder_token,
            principalName: this.config.principal.name
          });
          if (verificationCommand) {
            automaticDailyVerificationAttempted = true;
            commands = [verificationCommand];
          }
        }
        if (silentSystemEvent && commands.some(isForbiddenDailyImCommand)) {
          throw new Error("silent system event cannot send messages");
        }
        if (commands.length === 0 || decision.outcome === "draft") {
          if (
            silentSystemEvent &&
            decision.outcome !== "draft" &&
            progress?.complete !== true &&
            emptyDailyDecisionRetries < 2
          ) {
            emptyDailyDecisionRetries += 1;
            continue;
          }
          break;
        }
        if (actionRounds >= maxActionRounds) {
          decision = actionLimitDecision(decision);
          break;
        }

        actionRounds += 1;
        const roundFeedback = [];
        let platformConfirmation = false;
        for (const command of commands) {
          if (silentSystemEvent) {
            if (
              isDailyMemoryWriteCommand(command) &&
              !this.state.renewDailyMemoryRun(
                dailyMemoryLock.targetDate,
                dailyMemoryLock.ownerId
              )
            ) {
              throw new Error("daily memory lock was lost before document write");
            }
            assertDailyMemoryCommand(command, {
              feedback,
              targetDate: event.target_date,
              folderToken: this.config.daily_memory.folder_token,
              principalName: this.config.principal.name
            });
          }
          const result = await this.executeCommand(command, { executionScope: event.event_id });
          executions.push(result);
          const feedbackResult = silentSystemEvent
            ? projectDailyMemorySearchResult(command, result, {
                excludedChatIds: this.config.daily_memory.excluded_chat_ids,
                excludedTopics: this.config.daily_memory.excluded_topics
              })
            : result;
          roundFeedback.push(executionFeedback(command, feedbackResult, actionRounds));
          if (
            silentSystemEvent &&
            isDailyMemoryFetchCommand(command) &&
            result.status === "complete"
          ) {
            for (
              let retryIndex = 0;
              retryIndex < DAILY_MEMORY_VERIFICATION_RETRY_DELAYS_MS.length;
              retryIndex += 1
            ) {
              const verificationStatus = dailyMemoryVerificationStatus({
                feedback: [...feedback, ...roundFeedback],
                targetDate: event.target_date,
                folderToken: this.config.daily_memory.folder_token,
                principalName: this.config.principal.name
              });
              if (verificationStatus !== "empty-body") break;
              if (!this.state.renewDailyMemoryRun(
                dailyMemoryLock.targetDate,
                dailyMemoryLock.ownerId
              )) {
                throw new Error("daily memory lock was lost before read-after-write retry");
              }
              await this.sleep(DAILY_MEMORY_VERIFICATION_RETRY_DELAYS_MS[retryIndex]);
              const retryResult = await this.executeCommand(command, {
                executionScope: `${event.event_id}:daily-verification-${retryIndex + 1}`
              });
              executions.push(retryResult);
              roundFeedback.push(executionFeedback(command, retryResult, actionRounds));
            }
          }
          if (result.status === "confirmation-required") {
            if (silentSystemEvent) {
              throw new Error("silent system event cannot request confirmation");
            }
            confirmations.push(await this.requestConfirmation(event, command, {
              requiresYes: true,
              risk: result.risk,
              preview: result.preview
            }));
            platformConfirmation = true;
            break;
          }
        }
        feedback.push(...roundFeedback);
        if (platformConfirmation) {
          decision = highRiskDecision(decision, this.config.principal.name);
          break;
        }
        if ((decision.confirmation_commands ?? []).length > 0) break;
        if (roundFeedback.length > 0 && roundFeedback.every((item) => item.result.status === "duplicate")) {
          decision = actionLimitDecision(decision);
          break;
        }
      }

      if (retryingReply && (!decision.response || decision.outcome === "draft")) {
        throw new Error("reply retry produced no response");
      }

      if (silentSystemEvent) {
        assertDailyMemoryCompletion({
          feedback,
          targetDate: event.target_date,
          folderToken: this.config.daily_memory.folder_token,
          principalName: this.config.principal.name
        });
      }

      if (
        decision.response &&
        decision.outcome !== "draft" &&
        !silentSystemEvent
      ) {
        this.state.recordExecution({
          command_hash: retryKey,
          status: "pending",
          result_code: null
        });
        const responseExecution = await this.executeCommand({
          argv: [
            "im",
            "+messages-reply",
            "--message-id",
            event.message_id,
            "--text",
            decision.response.text,
            "--idempotency-key",
            shortIdempotencyKey("twin-reply", event.event_id)
          ],
          reason: "发送数字分身回复"
        }, {
          executionScope: event.event_id,
          identity: replyIdentity(event)
        });
        executions.push(responseExecution);
        if (!new Set(["complete", "duplicate"]).has(responseExecution.status)) {
          throw new Error("reply delivery failed");
        }
        this.state.recordExecution({
          command_hash: retryKey,
          status: "complete",
          result_code: responseExecution.status.toUpperCase()
        });
      }

      this.state.completeEvent(event.event_id);
      return {
        ...decision,
        executions,
        confirmations,
        reply_retry: retryingReply,
        diagnostics: contextDiagnostics(hydrated, decision)
      };
    } catch (error) {
      this.state.releaseEvent(event.event_id);
      throw error;
    }
  }
}

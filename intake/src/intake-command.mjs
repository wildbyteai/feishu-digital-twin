import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";

import { hasCurrentOrLegacyAuthorityLabel } from "../../shared/authority-labels.mjs";
import { buildLarkEnvironment } from "../../shared/subprocess-environment.mjs";
import { RuntimeState } from "../../runtime/src/runtime-state.mjs";
import {
  buildOfficialEventCommand,
  officialEventToRawMessage
} from "./lark-event-source.mjs";
import { normalizeInboundMessage } from "./inbound-normalizer.mjs";
import { LarkImReader } from "./lark-im-reader.mjs";
import { writeJsonLine } from "./ndjson-output.mjs";

const OFFICIAL_EVENT_READY = "[event] ready event_key=im.message.receive_v1";

async function readConfig(configPath, configLoader) {
  if (!configPath) throw new Error("a config JSON file is required");
  if (typeof configLoader !== "function") throw new TypeError("configLoader must be a function");
  const config = await configLoader(configPath);
  if (config.production_data_approved !== true) {
    throw new Error("real Feishu intake requires production_data_approved=true");
  }
  return config;
}

function observeOfficialEventStderr(stream) {
  let buffered = "";
  let announced = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    let newlineIndex;
    while ((newlineIndex = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/u, "");
      buffered = buffered.slice(newlineIndex + 1);
      if (!announced && line === OFFICIAL_EVENT_READY) {
        announced = true;
        process.stderr.write("[intake] ready\n");
      }
    }
    if (buffered.length > 4_096) buffered = buffered.slice(-4_096);
  });
}

function hasUsableSupplementIdentity(message) {
  if (!message || typeof message !== "object") return false;
  const senderId = message.sender_id ?? message.sender?.open_id ?? message.sender?.id;
  if (typeof message.message_id !== "string" || message.message_id.length === 0) return false;
  if (typeof senderId !== "string" || senderId.length === 0) return false;
  if (typeof message.create_time !== "string" || message.create_time.length === 0) return false;
  const numeric = Number(message.create_time);
  const timestamp = Number.isFinite(numeric)
    ? new Date(numeric)
    : new Date(message.create_time);
  return !Number.isNaN(timestamp.getTime());
}

function isLabeledTwinApplicationMessage(message, principalName, botAppId) {
  const sender = message?.sender;
  const senderId = message?.sender_id ?? sender?.open_id ?? sender?.id;
  return senderId === botAppId &&
    hasCurrentOrLegacyAuthorityLabel(message?.content, principalName);
}

function explicitlyInternalChat(chat) {
  return externalChatStatus(chat) === false;
}

function externalChatStatus(chat) {
  const signals = [chat?.is_external, chat?.external]
    .filter((value) => typeof value === "boolean");
  if (signals.includes(true)) return true;
  if (signals.length > 0 && signals.every((value) => value === false)) return false;
  return null;
}

async function runOfficialEvents(configPath, configLoader) {
  const config = await readConfig(configPath, configLoader);
  const reader = new LarkImReader({
    larkBin: config.lark_cli_bin ?? "lark-cli",
    profile: config.profile,
    productionDataApproved: true
  });
  const chats = new Map();
  const argv = buildOfficialEventCommand({
    larkBin: config.lark_cli_bin ?? "lark-cli",
    profile: config.profile
  });
  const child = spawn(argv[0], argv.slice(1), {
    env: buildLarkEnvironment(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  observeOfficialEventStderr(child.stderr);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let shutdownRequested = false;
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      shutdownRequested = true;
      child.kill("SIGTERM");
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const received = JSON.parse(line);
      let chat = chats.get(received.chat_id);
      if (chat === undefined) {
        try {
          chat = await reader.getChat({ chatId: received.chat_id, identity: "bot" });
          chats.set(received.chat_id, chat);
        } catch {
          chat = null;
        }
      }
      const raw = officialEventToRawMessage(received, chat);
      await writeJsonLine(process.stdout, normalizeInboundMessage(raw, {
        source: "event",
        principal: config.principal
      }).event);
    }

    const result = await exit;
    if (!shutdownRequested && result.code !== 0) {
      throw new Error(`official event consumer exited with code ${result.code} signal ${result.signal ?? "none"}`);
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exit.catch(() => {});
  }
}

async function allChats(reader) {
  const chats = [];
  let pageToken;
  do {
    const page = await reader.listChats({ pageToken });
    chats.push(...(page.chats ?? []));
    pageToken = page.has_more ? page.page_token : undefined;
  } while (pageToken);
  return chats;
}

async function runSupplement(configPath, databasePath, configLoader) {
  if (!databasePath) throw new Error("supplement-once requires a SQLite state path");
  const config = await readConfig(configPath, configLoader);
  const messageScope = config.message_scope;
  if (messageScope === "bot_only") return;
  const reader = new LarkImReader({
    larkBin: config.lark_cli_bin ?? "lark-cli",
    profile: config.profile,
    productionDataApproved: true
  });
  const botAppId = await reader.currentBotAppId();
  const end = new Date();
  const lookbackMinutes = Number(config.supplement_lookback_minutes ?? 5);
  if (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0) {
    throw new Error("supplement_lookback_minutes must be positive");
  }
  const state = new RuntimeState(databasePath, {
    stateRetentionMs: (config.privacy?.state_retention_days ?? 30) * 24 * 60 * 60 * 1000
  });
  try {
    for (const chat of await allChats(reader)) {
      if (messageScope === "internal_visible" && !explicitlyInternalChat(chat)) continue;
      const checkpoint = state.getSupplementCheckpoint(chat.chat_id);
      const start = checkpoint
        ? new Date(Date.parse(checkpoint) - 2 * 60 * 1000)
        : new Date(end.getTime() - lookbackMinutes * 60 * 1000);
      const eventIds = [];
      let pageToken;
      do {
        const page = await reader.listMessages({
          chatId: chat.chat_id,
          start: start.toISOString(),
          end: end.toISOString(),
          pageToken
        });
        for (const message of page.messages ?? []) {
          if (!hasUsableSupplementIdentity(message)) continue;
          if (isLabeledTwinApplicationMessage(
            message,
            config.principal.name,
            botAppId
          )) continue;
          const raw = {
            ...message,
            chat_id: message.chat_id ?? chat.chat_id,
            chat_type: message.chat_type ?? (chat.chat_mode === "p2p" ? "p2p" : "group"),
            is_external: externalChatStatus(chat),
            tenant_key: typeof chat.tenant_key === "string" ? chat.tenant_key : null
          };
          const event = normalizeInboundMessage(raw, {
            source: "supplement",
            principal: config.principal
          }).event;
          await writeJsonLine(process.stdout, event);
          eventIds.push(event.event_id);
        }
        pageToken = page.has_more ? page.page_token : undefined;
      } while (pageToken);
      const lastReadAt = end.toISOString();
      await writeJsonLine(process.stdout, {
        type: "supplement_checkpoint",
        event_id: `checkpoint:${chat.chat_id}:${lastReadAt}`,
        chat_id: chat.chat_id,
        last_read_at: lastReadAt,
        event_ids: eventIds
      });
    }
  } finally {
    state.close();
  }
}

export async function runIntakeCommand(argv, {
  configLoader,
  usageName = "feishu-digital-twin-intake"
} = {}) {
  const [command, configPath, databasePath] = argv;
  if (command === "event-run") return runOfficialEvents(configPath, configLoader);
  if (command === "supplement-once") {
    return runSupplement(configPath, databasePath, configLoader);
  }
  process.stderr.write(
    `usage: ${usageName} <event-run CONFIG_JSON|supplement-once CONFIG_JSON STATE_DB>\n`
  );
  return 64;
}

export function reportIntakeFailure() {
  process.stderr.write(`${JSON.stringify({
    type: "error",
    component: "intake",
    message: "intake failed"
  })}\n`);
  return 1;
}

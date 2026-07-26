import { runLarkCommand } from "../../executor/src/lark-guard.mjs";

async function runCommandJson(command, args) {
  const result = await runLarkCommand([command, ...args]);
  if (result.exit_code !== 0) {
    let safeCode = "unknown";
    try {
      const envelope = JSON.parse(result.stderr);
      safeCode = String(envelope?.error?.code ?? envelope?.error?.type ?? "unknown");
    } catch {
      // Raw stderr can contain credentials, private URLs or business data.
    }
    throw new Error(`lark-cli ${args[0]} ${args[1]} failed with exit ${result.exit_code} error ${safeCode}`);
  }
  return JSON.parse(result.stdout);
}

async function runJson(command, args) {
  const envelope = await runCommandJson(command, args);
  if (envelope.ok !== true || !envelope.data) {
    throw new Error("lark-cli returned an invalid success envelope");
  }
  return envelope.data;
}

export class LarkImReader {
  constructor({
    larkBin = "lark-cli",
    profile,
    productionDataApproved = process.env.TWIN_PRODUCTION_DATA_APPROVED === "1"
  } = {}) {
    if (!productionDataApproved) {
      throw new Error("lark-cli reads are blocked until the production data gate is approved");
    }
    if (typeof profile !== "string" || profile.length === 0) {
      throw new TypeError("profile must be configured");
    }
    this.larkBin = larkBin;
    this.prefix = ["--profile", profile];
  }

  async currentBotAppId() {
    const identity = await runCommandJson(this.larkBin, [
      ...this.prefix, "whoami", "--as", "bot"
    ]);
    const appId = identity?.appId ?? identity?.app_id;
    if (identity?.identity !== "bot" || typeof appId !== "string" || appId.length === 0) {
      throw new Error("lark-cli whoami did not return the current bot app_id");
    }
    return appId;
  }

  listChats({ pageToken } = {}) {
    const args = [...this.prefix,
      "im", "+chat-list", "--as", "user", "--types", "p2p,group",
      "--sort", "active_time", "--page-size", "100", "--format", "json"
    ];
    if (pageToken) args.push("--page-token", pageToken);
    return runJson(this.larkBin, args);
  }

  getChat({ chatId, identity = "user" } = {}) {
    if (typeof chatId !== "string" || chatId.length === 0) {
      throw new TypeError("chatId must be configured");
    }
    if (!new Set(["bot", "user"]).has(identity)) {
      throw new TypeError("identity must be bot or user");
    }
    return runJson(this.larkBin, [...this.prefix,
      "im", "chats", "get", "--chat-id", chatId, "--as", identity, "--format", "json"
    ]);
  }

  listMessages({
    chatId,
    start,
    end,
    pageToken,
    order = "asc",
    pageSize = 50
  } = {}) {
    if (!new Set(["asc", "desc"]).has(order)) {
      throw new TypeError("order must be asc or desc");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new TypeError("pageSize must be an integer between 1 and 50");
    }
    const args = [...this.prefix,
      "im", "+chat-messages-list", "--as", "user", "--chat-id", chatId,
      "--order", order, "--page-size", String(pageSize), "--no-reactions", "--format", "json"
    ];
    if (start) args.push("--start", start);
    if (end) args.push("--end", end);
    if (pageToken) args.push("--page-token", pageToken);
    return runJson(this.larkBin, args);
  }

  listThread({ threadId, pageToken, order = "desc", pageSize = 10 } = {}) {
    const args = [...this.prefix,
      "im", "+threads-messages-list", "--as", "user", "--thread", threadId,
      "--order", order, "--page-size", String(pageSize), "--no-reactions", "--format", "json"
    ];
    if (pageToken) args.push("--page-token", pageToken);
    return runJson(this.larkBin, args);
  }

  getMessages(messageIds) {
    if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > 50) {
      throw new TypeError("messageIds must contain between 1 and 50 IDs");
    }
    return runJson(this.larkBin, [...this.prefix,
      "im", "+messages-mget", "--as", "user", "--message-ids", messageIds.join(","),
      "--no-reactions", "--format", "json"
    ]);
  }
}

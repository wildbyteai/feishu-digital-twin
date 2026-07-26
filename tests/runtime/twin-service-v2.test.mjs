import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LarkGuard } from "../../executor/src/lark-guard.mjs";
import { RuntimeState } from "../../runtime/src/runtime-state.mjs";
import { projectExecutionFeedback, TwinService } from "../../runtime/src/service.mjs";

function event(overrides = {}) {
  return {
    event_id: "evt-service-1",
    source: "event",
    chat_id: "oc_internal",
    chat_type: "group",
    message_id: "om_service_1",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    update_time: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "请把交付时间调整到周五",
    thread_id: null,
    root_message_id: null,
    reply_to_message_id: null,
    signals: {},
    context: [],
    ...overrides
  };
}

function config(overrides = {}) {
  return {
    profile: "example_profile",
    principal: { name: "示例负责人", open_id: "ou_principal", timezone: "Asia/Shanghai" },
    production_enabled: true,
    allowed_lark_domains: ["im", "task", "calendar", "docs", "base", "drive", "wiki"],
    ...overrides
  };
}

function state() {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "twin-service-")), "state.sqlite");
  return new RuntimeState(database, { clock: () => "2026-07-16T10:00:00.000Z" });
}

test("交给 AI 的官方执行反馈有总量、深度和数组上限，错误不含原始正文", () => {
  let deepValue = { secret: "deep-private-body" };
  for (let depth = 0; depth < 10; depth += 1) {
    deepValue = { child: deepValue };
  }
  const feedback = projectExecutionFeedback([
    {
      round: 1,
      command: {
        argv: ["contact", "+search", "--query", "示例联系人", "--content", "x".repeat(100_000)],
        reason: "解析联系人"
      },
      result: {
        status: "complete",
        command_hash: "a".repeat(64),
        data: {
          users: Array.from({ length: 100 }, (_, index) => ({
            open_id: `ou_fixture_${index}`,
            name: `示例联系人${index}`
          })),
          document: { content: "业务正文".repeat(30_000) },
          nested: deepValue
        }
      }
    },
    {
      round: 1,
      command: {
        argv: ["im", "+messages-search", "--start", "invalid-time"],
        reason: "读取消息"
      },
      result: {
        status: "failed",
        command_hash: "b".repeat(64),
        error_type: "validation",
        error: {
          type: "validation",
          subtype: "invalid_parameter",
          message: "private-message-body",
          hint: "private-remediation-body"
        }
      }
    }
  ]);

  const encoded = JSON.stringify(feedback);
  assert.equal(Buffer.byteLength(encoded) <= 64 * 1024, true);
  assert.deepEqual(feedback[0].command, {
    domain: "contact",
    operation: "+search",
    reason: "解析联系人"
  });
  assert.equal(feedback[0].result.data.users.length, 20);
  assert.equal(feedback[0].result.data.users[0].open_id, "ou_fixture_0");
  assert.equal(feedback[0].result.data_truncated, true);
  assert.equal(Object.hasOwn(feedback[0].result, "command_hash"), false);
  assert.equal(feedback[1].result.status, "failed");
  assert.equal(feedback[1].result.error_type, "validation");
  assert.equal(Object.hasOwn(feedback[1].result, "error"), false);
  assert.doesNotMatch(encoded, /private-message-body|private-remediation-body|deep-private-body/u);
});

test("多条官方执行结果合计仍不会超过 AI 反馈总量上限", () => {
  const feedback = projectExecutionFeedback(Array.from({ length: 15 }, (_, index) => ({
    round: Math.floor(index / 5) + 1,
    command: {
      argv: ["docs", "+fetch", "--doc", `fixture_doc_${index}`],
      reason: "读取结构化文档结果"
    },
    result: {
      status: "complete",
      command_hash: index.toString(16).padStart(64, "0"),
      data: { document: { content: `第${index}份正文`.repeat(30_000) } }
    }
  })));

  assert.equal(feedback.length, 15);
  assert.equal(Buffer.byteLength(JSON.stringify(feedback)) <= 64 * 1024, true);
  assert.equal(feedback.every((item) => item.result.data_truncated === true), true);
});

test("数字分身总开关在处理新消息前刷新，关闭时不调用 AI", async () => {
  const runtimeState = state();
  let enabled = false;
  let decisions = 0;
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => ({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, data: {} }),
      stderr: ""
    })
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => enabled,
      runCodex: async (input) => {
        decisions += 1;
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "无需回应",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    const disabled = await service.handle(event({
      event_id: "evt-switch-off",
      message_id: "om-switch-off"
    }));
    assert.equal(disabled.outcome, "ignore");
    assert.equal(disabled.reason, "digital twin disabled");
    assert.equal(decisions, 0);

    enabled = true;
    const active = await service.handle(event({
      event_id: "evt-switch-on",
      message_id: "om-switch-on"
    }));
    assert.equal(active.outcome, "ignore");
    assert.equal(decisions, 1);
  } finally {
    runtimeState.close();
  }
});

test("未知确认编号输出稳定诊断码且不调用 AI", async () => {
  const runtimeState = state();
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => {
      throw new Error("unknown confirmation must not call lark-cli");
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async () => {
        throw new Error("unknown confirmation must not call AI");
      }
    });

    const result = await service.handle(event({
      event_id: "evt-unknown-confirmation",
      chat_id: "oc_private_confirmation",
      chat_type: "p2p",
      message_id: "om-unknown-confirmation",
      sender_open_id: "ou_principal",
      text: "确认 deadbeefdeadbeef"
    }));

    assert.equal(result.outcome, "ignore");
    assert.equal(result.diagnostics.decision_reason_code, "UNKNOWN_CONFIRMATION");
  } finally {
    runtimeState.close();
  }
});

test("普通群消息补读同群上下文后再由 AI 决定是否回复", async () => {
  const runtimeState = state();
  const reads = [];
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      reader: {
        async listMessages(options) {
          reads.push(options);
          return {
            messages: [
              {
                message_id: "om-current-context",
                chat_id: "oc_internal",
                create_time: "2026-07-16T10:00:00.000Z",
                content: "帮我查一下今天武汉的天气",
                sender: { id: "ou_member" }
              },
              {
                message_id: "om-principal-context",
                chat_id: "oc_internal",
                create_time: "2026-07-16T09:59:00.000Z",
                content: "我看看我的数字分身会不会自动回复",
                sender: { id: "ou_principal" }
              }
            ]
          };
        }
      },
      runCodex: async (input) => {
        assert.deepEqual(
          input.context.map(({ message_id }) => message_id),
          ["om-principal-context"]
        );
        assert.equal(input.context_meta.scope, "chat");
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "上下文表明正在测试数字分身",
          response: { mode: "representative", text: "我来查询。" },
          commands: [],
          source_refs: [input.message_id, "om-principal-context"]
        };
      }
    });

    const result = await service.handle(event({
      event_id: "evt-standalone-group-context",
      message_id: "om-current-context",
      text: "帮我查一下今天武汉的天气",
      signals: { direct_mention: false, context_lookup_required: true }
    }));

    assert.equal(result.outcome, "reply");
    assert.deepEqual(reads, [{
      chatId: "oc_internal",
      end: "2026-07-16T10:00:00.000Z",
      order: "desc",
      pageSize: 20
    }]);
    assert.equal(result.diagnostics.context_fetched, true);
    assert.equal(result.diagnostics.context_count, 1);
    assert.equal(result.diagnostics.context_scope, "chat");
    assert.equal(result.diagnostics.decision_reason_code, "AI_REPLY_AFTER_CONTEXT");
    assert.equal(Number.isInteger(result.diagnostics.processing_latency_ms), true);
    assert.equal(calls.some((argv) => argv.includes("+messages-reply")), true);
  } finally {
    runtimeState.close();
  }
});

test("明确 @ 的群消息不额外补读最近群聊", async () => {
  const runtimeState = state();
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => ({
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, data: {} }),
      stderr: ""
    })
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      reader: {
        async listMessages() {
          throw new Error("direct mention must not fetch recent chat context");
        }
      },
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "ignore",
        reason: "测试忽略",
        response: null,
        commands: [],
        source_refs: [input.message_id]
      })
    });

    const result = await service.handle(event({
      event_id: "evt-direct-mention-no-prefetch",
      message_id: "om-direct-mention-no-prefetch",
      signals: { direct_mention: true, context_lookup_required: false }
    }));

    assert.equal(result.outcome, "ignore");
    assert.equal(result.diagnostics.context_fetched, false);
    assert.equal(result.diagnostics.context_count, 0);
    assert.equal(result.diagnostics.context_scope, "none");
    assert.equal(result.diagnostics.decision_reason_code, "AI_IGNORE_WITHOUT_CONTEXT");
  } finally {
    runtimeState.close();
  }
});

test("普通群闲聊即使补读上下文也可以继续忽略且不发送回复", async () => {
  const runtimeState = state();
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      reader: {
        async listMessages() {
          return {
            messages: [
              {
                message_id: "om-casual-current",
                chat_id: "oc_internal",
                create_time: "2026-07-16T10:00:00.000Z",
                content: "午饭吃什么",
                sender: { id: "ou_member" }
              },
              {
                message_id: "om-casual-context",
                chat_id: "oc_internal",
                create_time: "2026-07-16T09:59:00.000Z",
                content: "今天天气挺热",
                sender: { id: "ou_other_member" }
              }
            ]
          };
        }
      },
      runCodex: async (input) => {
        assert.deepEqual(
          input.context.map(({ message_id }) => message_id),
          ["om-casual-context"]
        );
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "普通闲聊且没有需要主体用户处理的事项",
          response: null,
          commands: [],
          source_refs: [input.message_id, "om-casual-context"]
        };
      }
    });

    const result = await service.handle(event({
      event_id: "evt-casual-after-context",
      message_id: "om-casual-current",
      text: "午饭吃什么",
      signals: { direct_mention: false, context_lookup_required: true }
    }));

    assert.equal(result.outcome, "ignore");
    assert.equal(result.diagnostics.context_fetched, true);
    assert.equal(result.diagnostics.decision_reason_code, "AI_IGNORE_AFTER_CONTEXT");
    assert.equal(calls.some((argv) => argv.includes("+messages-reply")), false);
  } finally {
    runtimeState.close();
  }
});

test("lark-cli exit 10 触发私有确认，确认后才追加 --yes", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      if (argv.includes("drive") && !argv.includes("--dry-run") && !argv.includes("--yes")) {
        return {
          exit_code: 10,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: {
              type: "confirmation_required",
              risk: { level: "high-risk-write", action: "drive +delete" }
            }
          })
        };
      }
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  try {
    const deliveries = [];
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "reply",
        reason: "执行已授权清理",
        response: { mode: "representative", text: "我来处理这个文件。" },
        commands: [{
          argv: ["drive", "+delete", "--token", "file_x", "--type", "file"],
          reason: "删除指定文件",
          confirmation: "auto"
        }],
        source_refs: [input.message_id]
      }),
      sendConfirmation: async (request) => {
        deliveries.push(request);
        return { status: "complete" };
      },
      clock: () => "2026-07-16T10:00:00.000Z"
    });

    const pending = await service.handle(event());
    assert.equal(pending.confirmations.length, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].requiresYes, true);
    assert.equal(deliveries[0].risk.action, "drive +delete");
    assert.equal(calls.some((argv) => argv.includes("drive") && argv.includes("--yes")), false);

    const id = pending.confirmations[0].confirmation_id;
    const approved = await service.handle(event({
      event_id: "evt-confirm-reply",
      chat_id: "oc_bot_p2p",
      chat_type: "p2p",
      message_id: "om_confirm_reply",
      sender_open_id: "ou_principal",
      text: `确认 ${id}`
    }));
    assert.equal(approved.execution.status, "complete");
    assert.equal(approved.diagnostics.decision_reason_code, "CONFIRMATION_RESULT");
    assert.equal(calls.some((argv) => argv.includes("drive") && argv.at(-1) === "--yes"), true);
    assert.equal(approved.notification.status, "complete");
    assert.equal(runtimeState.getConfirmation(id).action, null);
  } finally {
    runtimeState.close();
  }
});

test("AI 主动请求本人确认时不提前追加官方 --yes", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "confirm",
        reason: "调整已承诺的交付日期",
        response: { mode: "confirmation", text: "建议把交付时间调整到周五。" },
        commands: [{
          argv: ["task", "+update", "--task-id", "task_x", "--due", "2026-07-17T18:00:00+08:00"],
          reason: "调整交付日期",
          confirmation: "human"
        }],
        source_refs: [input.message_id]
      }),
      sendConfirmation: async () => ({ status: "complete" }),
      clock: () => "2026-07-16T10:00:00.000Z"
    });

    const pending = await service.handle(event({ event_id: "evt-human", message_id: "om-human" }));
    const id = pending.confirmations[0].confirmation_id;
    assert.equal(runtimeState.getConfirmation(id).requires_yes, false);
    await service.handle(event({
      event_id: "evt-human-approve",
      chat_id: "oc_bot_p2p",
      chat_type: "p2p",
      message_id: "om-human-approve",
      sender_open_id: "ou_principal",
      text: `确认 ${id}`
    }));
    const taskExecute = calls.find((argv) => argv.includes("task") && !argv.includes("--dry-run"));
    assert.equal(taskExecute.includes("--yes"), false);
    assert.deepEqual(taskExecute.slice(-4), ["--as", "user", "--format", "json"]);
  } finally {
    runtimeState.close();
  }
});

test("Bot 来源的待确认消息回复在批准后仍使用 Bot 身份", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "confirm",
        reason: "先确认公开回复内容",
        response: { mode: "confirmation", text: "建议确认后回复对方。" },
        commands: [{
          argv: [
            "im",
            "+messages-reply",
            "--message-id",
            "om-approved-target",
            "--text",
            "已确认，按该方案推进。"
          ],
          reason: "回复原 Bot 会话",
          confirmation: "human"
        }],
        source_refs: [input.message_id]
      }),
      sendConfirmation: async () => ({ status: "complete" }),
      clock: () => "2026-07-16T10:00:00.000Z"
    });

    const pending = await service.handle(event({
      event_id: "evt-bot-confirmation",
      message_id: "om-bot-confirmation"
    }));
    const id = pending.confirmations[0].confirmation_id;
    assert.equal(runtimeState.getConfirmation(id).source_reply_identity, "bot");

    const approved = await service.handle(event({
      event_id: "evt-bot-confirmation-approved",
      chat_id: "oc_bot_p2p",
      chat_type: "p2p",
      message_id: "om-bot-confirmation-approved",
      sender_open_id: "ou_principal",
      text: `确认 ${id}`
    }));
    assert.equal(approved.execution.status, "complete");
    const approvedReplyCalls = calls.filter((argv) => argv.includes("om-approved-target"));
    assert.equal(approvedReplyCalls.length, 2);
    assert.equal(approvedReplyCalls.every((argv) => (
      argv.slice(-4).join(" ") === "--as bot --format json" ||
      argv.slice(-5).join(" ") === "--as bot --format json --dry-run"
    )), true);
    assert.equal(approvedReplyCalls.some((argv) => argv.includes("user")), false);
  } finally {
    runtimeState.close();
  }
});

test("不同事件产生相同命令时分别执行，只对同一事件去重", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "reply",
        reason: "接受同类请求",
        response: { mode: "representative", text: "我来跟进。" },
        commands: [{
          argv: ["task", "+create", "--summary", "跟进项目"],
          reason: "创建跟进任务",
          confirmation: "auto"
        }],
        source_refs: [input.message_id]
      })
    });

    await service.handle(event({ event_id: "evt-same-1", message_id: "om_same_1" }));
    await service.handle(event({ event_id: "evt-same-2", message_id: "om_same_2" }));
    const taskExecutions = calls.filter((argv) => argv.includes("task") && !argv.includes("--dry-run"));
    assert.equal(taskExecutions.length, 2);
  } finally {
    runtimeState.close();
  }
});

test("执行去重键和日志指纹使用实例本机 HMAC 且兼容旧 SHA 记录", async () => {
  const command = {
    argv: ["task", "+create", "--summary", "跟进项目"],
    reason: "创建跟进任务",
    confirmation: "auto"
  };
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => {
      throw new Error("legacy duplicate must not execute");
    }
  });
  const database = path.join(
    mkdtempSync(path.join(tmpdir(), "twin-service-execution-hmac-")),
    "state.sqlite"
  );
  const runtimeState = new RuntimeState(database, {
    clock: () => "2026-07-16T10:00:00.000Z",
    privacyKey: Buffer.alloc(32, 7)
  });
  try {
    const executionScope = "evt-legacy-execution";
    const plan = guard.plan(command, {
      productionEnabled: true,
      frozen: false,
      identity: "user"
    });
    const legacyKey = createHash("sha256")
      .update(`${executionScope}:${plan.command_hash}`)
      .digest("hex");
    runtimeState.recordExecution({
      command_hash: legacyKey,
      status: "complete",
      result_code: "complete"
    });

    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard
    });
    const result = await service.executeCommand(command, { executionScope });
    const expected = createHmac("sha256", Buffer.alloc(32, 7))
      .update("execution")
      .update("\0")
      .update(legacyKey)
      .digest("hex");

    assert.equal(result.status, "duplicate");
    assert.equal(result.execution_hash, `execution_${expected}`);
    assert.notEqual(result.execution_hash, legacyKey);
  } finally {
    runtimeState.close();
  }
});

test("自动回复使用固定长度幂等键，不把长事件 ID 直接传给飞书", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "reply",
        reason: "回复验收消息",
        response: { mode: "representative", text: "验收通过" },
        commands: [],
        source_refs: [input.message_id]
      })
    });

    const syntheticMessageId = ["om_", "fixturemessage000000"].join("");
    await service.handle(event({
      event_id: `message:${syntheticMessageId}:2026-07-17T04:34:00.000Z`,
      message_id: syntheticMessageId
    }));
    const execution = calls.find((argv) => argv.includes("im") && !argv.includes("--dry-run"));
    const key = execution[execution.indexOf("--idempotency-key") + 1];
    assert.match(key, /^twin-reply-[a-f0-9]{32}$/u);
    assert.ok(key.length <= 50);
  } finally {
    runtimeState.close();
  }
});

test("发给数字分身的消息由 Bot 回复，发给示例负责人账号的消息由用户身份回复", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "reply",
        reason: "回复来信",
        response: { mode: "representative", text: "我来处理。" },
        commands: [],
        source_refs: [input.message_id]
      })
    });

    await service.handle(event({
      event_id: "evt-addressed-to-bot",
      message_id: "om-addressed-to-bot",
      source: "event"
    }));
    await service.handle(event({
      event_id: "evt-addressed-to-user",
      message_id: "om-addressed-to-user",
      source: "supplement"
    }));

    const replies = calls.filter((argv) => argv.includes("im") && !argv.includes("--dry-run"));
    assert.equal(replies.length, 2);
    assert.equal(replies[0][replies[0].indexOf("--as") + 1], "bot");
    assert.equal(replies[1][replies[1].indexOf("--as") + 1], "user");
  } finally {
    runtimeState.close();
  }
});

test("主体用户发给数字分身 Bot 的私聊仍由 Bot 回复", async () => {
  const calls = [];
  let codexCalls = 0;
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  try {
    const service = new TwinService({
      config: config({ message_scope: "bot_only" }),
      state: runtimeState,
      guard,
      runCodex: async (input) => {
        codexCalls += 1;
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "回复发给数字分身的私聊",
          response: { mode: "representative", text: "bot_only 闭环正常。" },
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.handle(event({
      event_id: "evt-principal-addressed-to-bot",
      chat_id: "oc_bot_principal_p2p",
      chat_type: "p2p",
      message_id: "om-principal-addressed-to-bot",
      sender_open_id: "ou_principal",
      source: "event",
      text: "请回复：bot_only 闭环正常。"
    }));

    const replies = calls.filter((argv) => argv.includes("im") && !argv.includes("--dry-run"));
    assert.equal(result.outcome, "reply");
    assert.equal(codexCalls, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0][replies[0].indexOf("--as") + 1], "bot");
  } finally {
    runtimeState.close();
  }
});

test("自动回复发送失败时释放事件，下一次补读可以重试", async () => {
  let replyAttempts = 0;
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      if (argv.includes("--dry-run")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
      }
      replyAttempts += 1;
      if (replyAttempts === 1) {
        return {
          exit_code: 1,
          stdout: "",
          stderr: JSON.stringify({ ok: false, error: { type: "api" } })
        };
      }
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  const retryEvent = event({
    event_id: "evt-retry-reply",
    message_id: "om-retry-reply",
    source: "supplement"
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "reply",
        reason: "回复来信",
        response: { mode: "representative", text: "我来处理。" },
        commands: [],
        source_refs: [input.message_id]
      })
    });

    await assert.rejects(() => service.handle(retryEvent), /reply delivery failed/u);
    const legacyRetryKey = createHash("sha256")
      .update(`${retryEvent.event_id}:reply-retry`)
      .digest("hex");
    const projectedRetryKey = runtimeState.executionKey(legacyRetryKey);
    assert.equal(runtimeState.getExecution(projectedRetryKey)?.status, "pending");
    assert.equal(runtimeState.getExecution(legacyRetryKey), null);
    const completed = await service.handle(retryEvent);
    assert.equal(completed.executions.at(-1).status, "complete");
    assert.equal(runtimeState.getExecution(projectedRetryKey)?.status, "complete");
    assert.equal(replyAttempts, 2);
  } finally {
    runtimeState.close();
  }
});

test("回复重试不会重新执行上一轮已经处理过的业务动作", async () => {
  const calls = [];
  let replyAttempts = 0;
  let initialDecisions = 0;
  let sawReplyRetry = false;
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      if (argv.includes("--dry-run")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
      }
      if (argv.includes("im")) {
        replyAttempts += 1;
        if (replyAttempts === 1) throw new Error("lark-cli process crashed");
      }
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  const retryEvent = event({
    event_id: "evt-retry-after-action",
    message_id: "om-retry-after-action",
    source: "supplement"
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => {
        if (input.reply_retry === true) {
          sawReplyRetry = true;
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "只补发最终回复",
            response: { mode: "representative", text: "已经收到。" },
            commands: [{
              argv: ["task", "+create", "--summary", "不应重复创建"],
              reason: "模型在重试时仍建议动作",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          };
        }
        if ((input.execution_feedback ?? []).length === 0) {
          initialDecisions += 1;
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: initialDecisions === 1 ? "先创建任务" : "错误地重新规划任务",
            response: { mode: "representative", text: "我来处理。" },
            commands: [{
              argv: [
                "task",
                "+create",
                "--summary",
                initialDecisions === 1 ? "首次创建" : "不应重复创建"
              ],
              reason: initialDecisions === 1 ? "创建一次业务任务" : "重复规划业务任务",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          };
        }
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "任务已处理",
          response: { mode: "representative", text: "已经处理。" },
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    await assert.rejects(() => service.handle(retryEvent), /lark-cli process crashed/u);
    const completed = await service.handle(retryEvent);
    assert.equal(completed.executions.at(-1).status, "complete");
    assert.equal(calls.filter((argv) => argv.includes("task") && !argv.includes("--dry-run")).length, 1);
    assert.equal(replyAttempts, 2);
    assert.equal(sawReplyRetry, true);
    assert.equal(completed.reply_retry, true);
  } finally {
    runtimeState.close();
  }
});

test("结果未知的业务动作不会像带幂等键的消息回复一样自动重放", async () => {
  const calls = [];
  let taskAttempts = 0;
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      if (argv.includes("--dry-run")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
      }
      if (argv.includes("task")) {
        taskAttempts += 1;
        if (taskAttempts === 1) throw new Error("task result was lost");
      }
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  const ambiguousEvent = event({
    event_id: "evt-ambiguous-business-action",
    message_id: "om-ambiguous-business-action",
    source: "supplement"
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "reply",
        reason: "创建任务",
        response: { mode: "representative", text: "我来创建任务。" },
        commands: [{
          argv: ["task", "+create", "--summary", "只允许尝试一次"],
          reason: "创建一次任务",
          confirmation: "auto"
        }],
        source_refs: [input.message_id]
      })
    });

    await assert.rejects(() => service.handle(ambiguousEvent), /task result was lost/u);
    const completed = await service.handle(ambiguousEvent);
    assert.equal(completed.executions.at(-1).status, "complete");
    assert.equal(taskAttempts, 1);
    assert.equal(calls.filter((argv) => argv.includes("task") && !argv.includes("--dry-run")).length, 1);
  } finally {
    runtimeState.close();
  }
});

test("官方 CLI 结果会交回 AI，完成多步动作后再发送最终回复", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: [...config().allowed_lark_domains, "contact"],
    runner: async (argv) => {
      calls.push(argv);
      if (argv.includes("--dry-run")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: { request: "preview" } }), stderr: "" };
      }
      if (argv.includes("contact")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: { users: [{ open_id: "ou_zhang" }] } }), stderr: "" };
      }
      if (argv.includes("calendar")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: { event_id: "event_1" } }), stderr: "" };
      }
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  let decisions = 0;
  try {
    const service = new TwinService({
      config: config({
        allowed_lark_domains: [...config().allowed_lark_domains, "contact"],
        max_ai_action_rounds: 3
      }),
      state: runtimeState,
      guard,
      runCodex: async (input) => {
        decisions += 1;
        const feedback = input.execution_feedback ?? [];
        if (feedback.length === 0) {
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "先解析联系人",
            response: { mode: "representative", text: "我来安排。" },
            commands: [{
              argv: ["contact", "+search", "--query", "张总"],
              reason: "解析张总的飞书身份",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          };
        }
        if (feedback.length === 1) {
          assert.equal(feedback[0].result.data.users[0].open_id, "ou_zhang");
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "联系人已解析，创建日程",
            response: { mode: "representative", text: "正在创建日程。" },
            commands: [{
              argv: ["calendar", "+event-create", "--attendee-id", "ou_zhang", "--summary", "项目沟通"],
              reason: "创建双方日程",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          };
        }
        assert.equal(feedback[1].result.data.event_id, "event_1");
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "日程已创建",
          response: { mode: "representative", text: "日程已经创建好了。" },
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.handle(event({
      event_id: "evt-multi-step",
      message_id: "om-multi-step",
      text: "帮我约张总开会"
    }));
    assert.equal(decisions, 3);
    assert.equal(result.response.text, "🤖【数字分身】日程已经创建好了。");
    assert.equal(calls.filter((argv) => argv.includes("contact") && !argv.includes("--dry-run")).length, 1);
    assert.equal(calls.filter((argv) => argv.includes("calendar") && !argv.includes("--dry-run")).length, 1);
  } finally {
    runtimeState.close();
  }
});

test("AI 动作反馈循环达到上限后停止继续执行", async () => {
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
  });
  const runtimeState = state();
  let decisions = 0;
  try {
    const service = new TwinService({
      config: config({ max_ai_action_rounds: 2 }),
      state: runtimeState,
      guard,
      runCodex: async (input) => {
        decisions += 1;
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "继续创建动作",
          response: { mode: "representative", text: "继续处理中。" },
          commands: [{
            argv: ["task", "+create", "--summary", `步骤 ${decisions}`],
            reason: `执行步骤 ${decisions}`,
            confirmation: "auto"
          }],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.handle(event({ event_id: "evt-bounded", message_id: "om-bounded" }));
    assert.equal(decisions, 3);
    assert.equal(calls.filter((argv) => argv.includes("task") && !argv.includes("--dry-run")).length, 2);
    assert.equal(result.response.text.startsWith("🤖【建议】"), true);
  } finally {
    runtimeState.close();
  }
});

test("补读游标只在该批消息全部完成后推进", async () => {
  const runtimeState = state();
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => {
      throw new Error("checkpoint marker must not call lark-cli");
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      runCodex: async () => {
        throw new Error("checkpoint marker must not call Codex");
      }
    });
    assert.equal(runtimeState.getSupplementCheckpoint("oc_checkpoint"), null);
    assert.equal(runtimeState.claimEvent("message:pending"), true);
    const deferred = await service.handle({
      type: "supplement_checkpoint",
      event_id: "checkpoint:oc_checkpoint:2026-07-16T10:00:00.000Z",
      chat_id: "oc_checkpoint",
      last_read_at: "2026-07-16T10:00:00.000Z",
      event_ids: ["message:pending"]
    });
    assert.equal(deferred.outcome, "checkpoint-deferred");
    assert.equal(runtimeState.getSupplementCheckpoint("oc_checkpoint"), null);

    assert.equal(runtimeState.completeEvent("message:pending"), true);
    const completed = await service.handle({
      type: "supplement_checkpoint",
      event_id: "checkpoint:oc_checkpoint:2026-07-16T10:00:00.000Z:retry",
      chat_id: "oc_checkpoint",
      last_read_at: "2026-07-16T10:00:00.000Z",
      event_ids: ["message:pending"]
    });
    assert.equal(completed.outcome, "checkpoint");
    assert.equal(
      runtimeState.getSupplementCheckpoint("oc_checkpoint"),
      "2026-07-16T10:00:00.000Z"
    );
  } finally {
    runtimeState.close();
  }
});

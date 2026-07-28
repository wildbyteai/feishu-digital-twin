import assert from "node:assert/strict";
import test from "node:test";

import { processEvent } from "../../runtime/src/process-event.mjs";

function event(overrides = {}) {
  return {
    event_id: "evt-1",
    source: "event",
    chat_id: "oc_internal",
    chat_type: "group",
    message_id: "om_1",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    update_time: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "负责人，请确认这个方案",
    thread_id: null,
    root_message_id: null,
    reply_to_message_id: null,
    signals: { semantic_address: true },
    context: [],
    ...overrides
  };
}

function config(overrides = {}) {
  return {
    principal: {
      name: "示例负责人",
      open_id: "ou_principal",
      timezone: "Asia/Shanghai"
    },
    production_enabled: false,
    group_rules: [],
    allowed_lark_domains: ["im", "task", "calendar", "docs", "base", "drive", "wiki"],
    ...overrides
  };
}

function decision(overrides = {}) {
  return {
    event_id: "evt-1",
    outcome: "reply",
    reason: "需要回应",
    response: {
      mode: "representative",
      text: "这个方案可以继续推进。"
    },
    commands: [],
    source_refs: ["om_1"],
    ...overrides
  };
}

test("AI 决定业务语义，可信运行时只添加数字分身标识", async () => {
  const result = await processEvent(event(), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => decision()
  });

  assert.equal(result.outcome, "reply");
  assert.equal(result.response.text, "🤖【数字分身】这个方案可以继续推进。");
  assert.deepEqual(result.executable_commands, []);
});

test("待本人确认保留具体建议并明确尚未生效", async () => {
  const result = await processEvent(event(), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => decision({
      outcome: "confirm",
      response: {
        mode: "confirmation",
        text: "建议把交付时间调整到周五。"
      },
      commands: [{
        argv: ["task", "+update", "--task-id", "task_x", "--due", "2026-07-17T18:00:00+08:00"],
        reason: "调整交付时间",
        confirmation: "human"
      }]
    })
  });

  assert.equal(
    result.response.text,
    "🤖【待示例负责人确认】建议把交付时间调整到周五。该事项尚未生效，需要示例负责人本人确认后方可执行。"
  );
  assert.equal(result.confirmation_commands.length, 1);
  assert.equal(result.executable_commands.length, 0);
});

test("只要存在本人确认动作，运行时强制使用待确认标识", async () => {
  const result = await processEvent(event(), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => decision({
      outcome: "reply",
      response: { mode: "representative", text: "建议调整交付日期。" },
      commands: [{
        argv: ["task", "+update", "--task-id", "task_x", "--due", "2026-07-17T18:00:00+08:00"],
        reason: "调整交付日期",
        confirmation: "human"
      }]
    })
  });
  assert.equal(result.response.text.startsWith("🤖【待示例负责人确认】"), true);
});

test("外部群正常交给 AI 处理，群级规则作为上下文传入", async () => {
  let promptContext;
  const external = await processEvent(event({ chat_id: "oc_external", is_external: true }), {
    config: config({
      group_rules: [{ chat_id: "oc_external", rules: ["承诺交期前先核实库存"] }]
    }),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async (_event, context) => {
      promptContext = context;
      return decision();
    }
  });
  assert.equal(external.outcome, "reply");
  assert.equal(external.response.text.startsWith("🤖【数字分身】"), true);
  assert.deepEqual(promptContext.config.group_rules, ["承诺交期前先核实库存"]);
});

test("普通消息不会把日报目标或隐私排除项暴露给 AI", async () => {
  let promptContext;
  await processEvent(event(), {
    config: config({
      daily_memory: {
        folder_token: "fld_daily_memory",
        folder_name: "数字分身每日工作记忆",
        excluded_chat_ids: ["oc_private"],
        excluded_topics: ["薪酬", "候选人隐私"]
      }
    }),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async (_event, context) => {
      promptContext = context;
      return decision();
    }
  });

  assert.equal(Object.hasOwn(promptContext.config, "daily_memory"), false);
  assert.equal(JSON.stringify(promptContext).includes("oc_private"), false);
  assert.equal(JSON.stringify(promptContext).includes("候选人隐私"), false);
});

test("AI 不使用草稿模式，内外部群都直接决定忽略、回复或确认", async () => {
  await assert.rejects(() => processEvent(event(), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => decision({ outcome: "draft" })
  }), /decision\.outcome is invalid/u);
});

test("每轮最多接受一条结构化能力查询", async () => {
  const lookup = {
    capability: "fixture.workflow.read",
    operation: "get",
    input: { workflow_id: "fixture-42" },
    reason: "核实流程状态"
  };
  await assert.rejects(() => processEvent(event(), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => decision({
      lookup_requests: [lookup, lookup]
    })
  }), /cannot contain more than one query per round/u);
});

test("代表权冻结时不公开发言或执行动作", async () => {
  const frozen = await processEvent(event(), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: true }) },
    runCodex: async () => decision({
      commands: [{
        argv: ["task", "+create", "--summary", "测试"],
        reason: "创建任务",
        confirmation: "auto"
      }]
    })
  });
  assert.equal(frozen.outcome, "draft");
  assert.equal(frozen.executable_commands.length, 0);
  assert.equal(frozen.confirmation_commands.length, 0);
});

test("主体用户可以立即冻结，控制动作不交给 AI", async () => {
  const transitions = [];
  const runtimeState = {
    getRuntimeState: () => ({ frozen: false }),
    setFrozen: (frozen, reason) => transitions.push({ frozen, reason })
  };
  const frozen = await processEvent(event({
    sender_open_id: "ou_principal",
    text: "立即冻结数字分身"
  }), {
    config: config(),
    runtimeState,
    runCodex: async () => {
      throw new Error("must not run");
    }
  });
  assert.equal(frozen.outcome, "control");
  assert.deepEqual(transitions, [{ frozen: true, reason: "PRINCIPAL_REQUEST" }]);
});

test("主体用户从飞书请求恢复时保持冻结并交给可信生命周期", async () => {
  const transitions = [];
  const runtimeState = {
    getRuntimeState: () => ({ frozen: true }),
    setFrozen: (frozen, reason) => transitions.push({ frozen, reason })
  };

  const result = await processEvent(event({
    sender_open_id: "ou_principal",
    text: "恢复数字分身"
  }), {
    config: config(),
    runtimeState,
    runCodex: async () => {
      throw new Error("must not run");
    }
  });

  assert.equal(result.outcome, "control");
  assert.equal(result.control, "resume-request");
  assert.equal(result.requested_frozen, false);
  assert.equal(result.frozen, true);
  assert.equal(result.requires_trusted_lifecycle, true);
  assert.deepEqual(transitions, []);
});

test("主体账号补读到的自身发言保持忽略", async () => {
  let codexCalls = 0;
  const result = await processEvent(event({
    event_id: "evt-principal-supplement",
    chat_id: "oc_principal_p2p",
    chat_type: "p2p",
    message_id: "om-principal-supplement",
    sender_open_id: "ou_principal",
    source: "supplement",
    text: "这是主体账号自己发出的消息。"
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => {
      codexCalls += 1;
      return decision({ event_id: "evt-principal-supplement" });
    }
  });

  assert.equal(result.outcome, "ignore");
  assert.equal(result.reason_code, "PRINCIPAL_MESSAGE");
  assert.equal(codexCalls, 0);
});

test("主体用户在群里的普通实时发言保持忽略", async () => {
  let codexCalls = 0;
  const result = await processEvent(event({
    event_id: "evt-principal-group-event",
    chat_id: "oc_internal_group",
    chat_type: "group",
    message_id: "om-principal-group-event",
    sender_open_id: "ou_principal",
    source: "event",
    text: "这是主体用户在群里的普通发言。",
    signals: {}
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => {
      codexCalls += 1;
      return decision({
        event_id: "evt-principal-group-event",
        source_refs: ["om-principal-group-event"]
      });
    }
  });

  assert.equal(result.outcome, "ignore");
  assert.equal(result.reason_code, "PRINCIPAL_MESSAGE");
  assert.equal(codexCalls, 0);
});

test("结构化引用没有可读内容时不调用 AI，直接建议原会话人工处理", async () => {
  let codexCalls = 0;
  const result = await processEvent(event({
    event_id: "evt-unreadable-context",
    chat_id: "oc_unreadable_context",
    chat_type: "p2p",
    message_id: "om-unreadable-context",
    text: "请处理我回复的内容",
    parent_message_id: "om-unreadable-parent",
    reply_to_message_id: "om-unreadable-parent",
    signals: {
      context_lookup_required: false,
      context_unreadable: true
    },
    context: [],
    context_meta: {
      fetched: true,
      scope: "reply",
      count: 0,
      limit: 20
    }
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => {
      codexCalls += 1;
      return decision();
    }
  });

  assert.equal(codexCalls, 0);
  assert.equal(result.outcome, "reply");
  assert.equal(result.response.mode, "suggestion");
  assert.equal(
    result.response.text,
    "🤖【建议】当前消息或引用内容无法读取，无法据此形成可靠结论，请人工检查原消息或链接后继续处理。"
  );
  assert.deepEqual(result.executable_commands, []);
  assert.deepEqual(result.confirmation_commands, []);
});

test("当前消息载荷不可读时不调用 AI，直接建议人工处理", async () => {
  let codexCalls = 0;
  const result = await processEvent(event({
    event_id: "evt-unreadable-current",
    chat_type: "p2p",
    message_id: "om-unreadable-current",
    text: "",
    signals: { content_unreadable: true },
    context: []
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async () => {
      codexCalls += 1;
      return decision();
    }
  });

  assert.equal(codexCalls, 0);
  assert.equal(result.outcome, "reply");
  assert.equal(result.reason_code, "CONTEXT_UNREADABLE");
});

test("已有链接时 AI 再次索要链接会被替换为确定性人工兜底", async () => {
  const result = await processEvent(event({
    event_id: "evt-repeat-link-request",
    message_id: "om-repeat-link-request",
    text: "请查看流程：https://example.invalid/workflow",
    links: ["https://example.invalid/workflow"]
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async (input) => decision({
      event_id: input.event_id,
      response: { mode: "suggestion", text: "请重新发送流程链接。" },
      source_refs: [input.message_id]
    })
  });

  assert.equal(
    result.response.text,
    "🤖【建议】当前消息或引用内容无法读取，无法据此形成可靠结论，请人工检查原消息或链接后继续处理。"
  );
});

test("普通消息附带参考链接但无需读取正文时保留正常回复", async () => {
  const result = await processEvent(event({
    event_id: "evt-link-reference-acknowledgement",
    message_id: "om-link-reference-acknowledgement",
    text: "请回复收到，参考 https://example.invalid/workflow",
    links: ["https://example.invalid/workflow"],
    link_only: true
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async (input) => decision({
      event_id: input.event_id,
      response: { mode: "representative", text: "收到。" },
      source_refs: [input.message_id]
    })
  });

  assert.equal(result.reason, "需要回应");
  assert.equal(result.response.text, "🤖【数字分身】收到。");
});

test("链接目标正文未读取时 AI 生成的流程摘要会被替换", async () => {
  const result = await processEvent(event({
    event_id: "evt-fabricated-link-summary",
    message_id: "om-fabricated-link-summary",
    links: ["https://example.invalid/workflow"],
    link_only: true,
    execution_feedback: [{
      command: { domain: "task", operation: "+get", reason: "读取无关任务" },
      result: { status: "complete", data: { task: "已完成" } }
    }]
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async (input) => decision({
      event_id: input.event_id,
      response: { mode: "representative", text: "该流程已经审批通过，可以直接执行。" },
      source_refs: [input.message_id]
    })
  });

  assert.equal(result.response.mode, "suggestion");
  assert.doesNotMatch(result.response.text, /已经审批通过/u);
  assert.equal(result.reason_code, "CONTEXT_UNREADABLE");
});

test("与目标链接明确关联的可读正文允许形成回复", async () => {
  const sourceUrl = "https://example.invalid/workflow";
  const result = await processEvent(event({
    event_id: "evt-verified-link-content",
    message_id: "om-verified-link-content",
    links: [sourceUrl],
    execution_feedback: [{
      command: { domain: "docs", operation: "+fetch", reason: "读取流程正文" },
      result: {
        status: "complete",
        data: {
          document: {
            url: sourceUrl,
            content: "流程要求由人工审批。"
          }
        }
      }
    }]
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async (input) => decision({
      event_id: input.event_id,
      response: { mode: "representative", text: "该流程需要人工审批。" },
      source_refs: [input.message_id]
    })
  });

  assert.equal(result.response.mode, "representative");
  assert.equal(result.response.text, "🤖【数字分身】该流程需要人工审批。");
});

test("查询来源链接移除 query 和 fragment 后仍可关联原始链接", async () => {
  const result = await processEvent(event({
    event_id: "evt-sanitized-link-source",
    message_id: "om-sanitized-link-source",
    links: ["https://example.invalid/workflow?id=42#approval"],
    link_only: true,
    capability_feedback: [{
      round: 1,
      request: {
        capability: "fixture.workflow.read",
        operation: "get",
        input: { workflow_id: "fixture-42" },
        reason: "读取流程正文"
      },
      result: {
        capability: "fixture.workflow.read",
        operation: "get",
        status: "complete",
        data: { content: "流程要求由人工审批。" },
        source_refs: ["https://example.invalid/workflow"]
      }
    }]
  }), {
    config: config(),
    runtimeState: { getRuntimeState: () => ({ frozen: false }) },
    runCodex: async (input) => decision({
      event_id: input.event_id,
      response: { mode: "representative", text: "该流程需要人工审批。" },
      source_refs: [input.message_id]
    })
  });

  assert.equal(result.reason, "需要回应");
  assert.equal(result.response.text, "🤖【数字分身】该流程需要人工审批。");
});

import assert from "node:assert/strict";
import test from "node:test";

import { processEvent } from "../../runtime/src/process-event.mjs";
import { buildDecisionPrompt } from "../../runtime/src/prompt.mjs";
import { dailyMemorySystemEvent } from "../../shared/daily-memory-trigger.mjs";

const PRIVATE_CANARY = "fixture_prompt_private_canary_7f1c9d";
const PRIVATE_FOLDER_REF = `fixture_folder_${PRIVATE_CANARY}`;

function configuration(overrides = {}) {
  return {
    principal: {
      name: "示例负责人",
      open_id: `ou_principal_${PRIVATE_CANARY}`,
      timezone: "Asia/Shanghai",
      address_names: ["负责人", "示例老师"],
      private_note: PRIVATE_CANARY
    },
    allowed_lark_domains: ["im", "task", "docs", "drive"],
    authority_rules: ["库存未经核实不得承诺交期"],
    group_rules: [
      { chat_id: "oc_command_context", rules: ["当前群先给结论再说明依据"] },
      { chat_id: `oc_other_${PRIVATE_CANARY}`, rules: [PRIVATE_CANARY] }
    ],
    daily_memory: {
      folder_token: PRIVATE_FOLDER_REF,
      folder_name: PRIVATE_CANARY,
      excluded_chat_ids: [PRIVATE_CANARY],
      excluded_topics: [PRIVATE_CANARY]
    },
    profile: PRIVATE_CANARY,
    ...overrides
  };
}

function decisionFor(candidate) {
  return {
    event_id: candidate.event_id,
    outcome: "ignore",
    reason: "只验证模型输入投影",
    response: null,
    commands: [],
    source_refs: [candidate.message_id]
  };
}

test("普通消息只把决策所需的最小事件、角色上下文和当前规则交给 AI", async () => {
  const config = configuration();
  let candidate;
  let promptContext;
  await processEvent({
    event_id: "evt_projection",
    delivery_event_id: PRIVATE_CANARY,
    source: "event",
    chat_id: "oc_command_context",
    chat_type: "group",
    message_id: "om_projection",
    sender_open_id: `ou_participant_${PRIVATE_CANARY}`,
    sent_at: "2026-07-24T09:00:00.000Z",
    update_time: "2026-07-24T09:01:00.000Z",
    message_type: "text",
    text: "请确认库存后给客户答复。",
    links: ["https://example.invalid/current"],
    thread_id: "omt_projection",
    root_message_id: "om_root_projection",
    parent_message_id: "om_parent_projection",
    reply_to_message_id: "om_parent_projection",
    is_external: true,
    tenant_key: PRIVATE_CANARY,
    signals: {
      direct_mention: true,
      semantic_address: true,
      private_signal: PRIVATE_CANARY
    },
    context: [
      {
        message_id: "om_context_principal",
        sender_open_id: config.principal.open_id,
        content: "我先核对库存。",
        links: ["https://example.invalid/workflow"],
        relation: "reply",
        chat_id: `oc_context_${PRIVATE_CANARY}`,
        topic_key: "omt_projection",
        sent_at: "2026-07-24T08:57:00.000Z"
      },
      {
        message_id: "om_context_twin",
        sender_open_id: `ou_twin_${PRIVATE_CANARY}`,
        assistant_authored: true,
        content: "🤖【数字分身】库存核对中。",
        chat_id: `oc_context_${PRIVATE_CANARY}`,
        topic_key: "omt_projection",
        sent_at: "2026-07-24T08:58:00.000Z"
      },
      {
        message_id: "om_context_participant",
        sender_open_id: `ou_other_${PRIVATE_CANARY}`,
        content: "客户在等回复。",
        chat_id: `oc_context_${PRIVATE_CANARY}`,
        topic_key: "omt_projection",
        sent_at: "2026-07-24T08:59:00.000Z"
      }
    ],
    context_meta: {
      fetched: true,
      scope: "thread",
      count: 3,
      limit: 20,
      private_meta: PRIVATE_CANARY
    },
    reply_retry: true,
    execution_feedback: [{
      command: { argv: ["task", "+get"], reason: "读取任务" },
      result: { status: "complete", data: { task: "已完成" } }
    }],
    action_budget_remaining: 2,
    private_event_note: PRIVATE_CANARY
  }, {
    config,
    runtimeState: {
      getRuntimeState: () => ({
        frozen: true,
        reason: PRIVATE_CANARY,
        updated_at: PRIVATE_CANARY
      })
    },
    runCodex: async (projectedCandidate, projectedContext) => {
      candidate = projectedCandidate;
      promptContext = projectedContext;
      return decisionFor(projectedCandidate);
    }
  });

  assert.deepEqual(candidate, {
    event_id: "evt_projection",
    chat_id: "oc_command_context",
    chat_type: "group",
    message_id: "om_projection",
    sender_role: "participant",
    sent_at: "2026-07-24T09:00:00.000Z",
    update_time: "2026-07-24T09:01:00.000Z",
    message_type: "text",
    text: "请确认库存后给客户答复。",
    links: ["https://example.invalid/current"],
    thread_id: "omt_projection",
    root_message_id: "om_root_projection",
    parent_message_id: "om_parent_projection",
    reply_to_message_id: "om_parent_projection",
    is_external: true,
    signals: {
      direct_mention: true,
      semantic_address: true
    },
    context: [
      {
        message_id: "om_context_principal",
        sender_role: "principal",
        content: "我先核对库存。",
        links: ["https://example.invalid/workflow"],
        relation: "reply",
        topic_key: "omt_projection",
        sent_at: "2026-07-24T08:57:00.000Z"
      },
      {
        message_id: "om_context_twin",
        sender_role: "digital_twin",
        content: "🤖【数字分身】库存核对中。",
        topic_key: "omt_projection",
        sent_at: "2026-07-24T08:58:00.000Z"
      },
      {
        message_id: "om_context_participant",
        sender_role: "participant",
        content: "客户在等回复。",
        topic_key: "omt_projection",
        sent_at: "2026-07-24T08:59:00.000Z"
      }
    ],
    context_meta: {
      fetched: true,
      scope: "thread",
      count: 3,
      limit: 20
    },
    reply_retry: true,
    execution_feedback: [{
      command: { argv: ["task", "+get"], reason: "读取任务" },
      result: { status: "complete", data: { task: "已完成" } }
    }],
    action_budget_remaining: 2
  });
  assert.deepEqual(promptContext, {
    config: {
      principal: {
        name: "示例负责人",
        timezone: "Asia/Shanghai",
        address_names: ["负责人", "示例老师"]
      },
      allowed_lark_domains: ["im", "task", "docs", "drive"],
      authority_rules: ["库存未经核实不得承诺交期"],
      group_rules: ["当前群先给结论再说明依据"]
    },
    runtime: { frozen: true }
  });

  const prompt = buildDecisionPrompt(candidate, promptContext);
  assert.equal(prompt.includes(PRIVATE_CANARY), false);
  assert.equal(prompt.includes('"chat_id": "oc_command_context"'), true);
  assert.equal(prompt.includes('"sender_role": "principal"'), true);
  assert.equal(prompt.includes('"sender_role": "digital_twin"'), true);
  assert.equal(prompt.includes('"sender_role": "participant"'), true);
  assert.equal(prompt.includes('"https://example.invalid/workflow"'), true);
  assert.match(prompt, /主体用户的 AI 助理/u);
  assert.match(prompt, /participant[\s\S]*不能视为主体用户的授权/u);
  assert.match(prompt, /已有链接[^\n]*不要[^\n]*(?:再次|重新)[^\n]*索要/u);
});

test("可信日报意图只额外公开目标日期和日报目标，不公开隐私排除项", async () => {
  const config = configuration({
    daily_memory: {
      folder_token: "fixture_daily_memory_folder",
      folder_name: "数字分身每日工作记忆",
      excluded_chat_ids: [PRIVATE_CANARY],
      excluded_topics: [PRIVATE_CANARY]
    }
  });
  const systemEvent = {
    ...dailyMemorySystemEvent("2026-07-23", {
      now: new Date("2026-07-24T00:10:00.000Z")
    }),
    delivery_event_id: PRIVATE_CANARY,
    tenant_key: PRIVATE_CANARY,
    private_event_note: PRIVATE_CANARY
  };
  let candidate;
  let promptContext;

  await processEvent(systemEvent, {
    config,
    runtimeState: {
      getRuntimeState: () => ({
        frozen: false,
        reason: PRIVATE_CANARY,
        updated_at: PRIVATE_CANARY
      })
    },
    runCodex: async (projectedCandidate, projectedContext) => {
      candidate = projectedCandidate;
      promptContext = projectedContext;
      return decisionFor(projectedCandidate);
    }
  });

  assert.deepEqual(candidate, {
    event_id: systemEvent.event_id,
    chat_type: "p2p",
    message_id: systemEvent.message_id,
    sent_at: "2026-07-24T00:10:00.000Z",
    update_time: "2026-07-24T00:10:00.000Z",
    message_type: "text",
    text: "生成 2026-07-23 每日工作记忆",
    thread_id: null,
    root_message_id: null,
    reply_to_message_id: null,
    signals: {},
    context: [],
    intent: "daily_work_memory",
    target_date: "2026-07-23"
  });
  assert.deepEqual(promptContext, {
    config: {
      principal: {
        name: "示例负责人",
        timezone: "Asia/Shanghai",
        address_names: ["负责人", "示例老师"]
      },
      allowed_lark_domains: ["im", "task", "docs", "drive"],
      authority_rules: ["库存未经核实不得承诺交期"],
      group_rules: [],
      daily_memory: {
        folder_token: "fixture_daily_memory_folder",
        folder_name: "数字分身每日工作记忆"
      }
    },
    runtime: { frozen: false }
  });

  const prompt = buildDecisionPrompt(candidate, promptContext);
  assert.equal(prompt.includes(PRIVATE_CANARY), false);
  assert.equal(prompt.includes('"intent": "daily_work_memory"'), true);
  assert.equal(prompt.includes('"target_date": "2026-07-23"'), true);
  assert.equal(prompt.includes('"folder_token": "fixture_daily_memory_folder"'), true);
});

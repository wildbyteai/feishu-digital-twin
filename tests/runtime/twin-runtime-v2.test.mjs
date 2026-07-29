import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LarkGuard } from "../../executor/src/lark-guard.mjs";
import { CapabilityActionGateway } from "../../runtime/src/capability-action-gateway.mjs";
import {
  CapabilityGateway,
  FakeCapabilityAdapter
} from "../../runtime/src/capability-gateway.mjs";
import { FakeInferenceAdapter } from "../../runtime/src/inference-adapter.mjs";
import { RuntimeState } from "../../runtime/src/runtime-state.mjs";
import { TwinRuntime } from "../../runtime/src/twin-runtime.mjs";

function config(overrides = {}) {
  return {
    schema_version: 1,
    profile: "fixture-user",
    production_data_approved: false,
    production_enabled: true,
    principal: {
      name: "示例用户",
      open_id: "ou_fixture_principal",
      timezone: "Asia/Shanghai"
    },
    allowed_lark_domains: ["im", "task"],
    ...overrides
  };
}

function event(overrides = {}) {
  return {
    event_id: "evt_fixture_runtime",
    source: "event",
    chat_id: "oc_fixture_team",
    chat_type: "group",
    message_id: "om_fixture_runtime",
    sender_open_id: "ou_fixture_member",
    sent_at: "2026-07-24T09:00:00.000Z",
    update_time: "2026-07-24T09:00:00.000Z",
    message_type: "text",
    text: "合成测试消息",
    thread_id: null,
    root_message_id: null,
    reply_to_message_id: null,
    signals: { direct_mention: true },
    context: [],
    ...overrides
  };
}

function state() {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "twin-runtime-seam-")), "state.sqlite");
  return new RuntimeState(database, { clock: () => "2026-07-24T09:00:00.000Z" });
}

function guard(configuration) {
  return new LarkGuard({
    larkBin: "/fixture/lark-cli",
    profile: configuration.profile,
    principalName: configuration.principal.name,
    allowedDomains: configuration.allowed_lark_domains,
    runner: async () => ({ exit_code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" })
  });
}

test("TwinRuntime.handle 是通过 InferenceAdapter 决策的最高运行 seam", async () => {
  const configuration = config();
  const runtimeState = state();
  const requests = [];
  try {
    const inferenceAdapter = new FakeInferenceAdapter(async (request) => {
      requests.push(request);
      return {
        event_id: request.event.event_id,
        outcome: "ignore",
        reason: "合成测试无需回复",
        response: null,
        commands: [],
        source_refs: [request.event.message_id]
      };
    });
    const runtime = new TwinRuntime({
      config: configuration,
      state: runtimeState,
      guard: guard(configuration),
      inferenceAdapter
    });

    const result = await runtime.handle(event());

    assert.equal(result.outcome, "ignore");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].event.event_id, "evt_fixture_runtime");
    assert.equal(requests[0].promptContext.config.principal.name, "示例用户");
    assert.equal(Object.hasOwn(requests[0].promptContext, "codexBin"), false);
    assert.equal(Object.hasOwn(requests[0].promptContext, "isolationRoot"), false);
  } finally {
    runtimeState.close();
  }
});

test("TwinRuntime 每条消息使用同一份最新配置快照，并同步收紧 AI 可见规则和执行域", async () => {
  const original = config({
    authority_rules: ["旧规则"],
    group_rules: [{ chat_id: "oc_fixture_team", rules: ["旧群规则"] }]
  });
  const runtimeState = state();
  const snapshots = [
    original,
    {
      ...original,
      allowed_lark_domains: ["im"],
      authority_rules: ["新规则", "企业知识库：产品；space_id=space_product"],
      group_rules: [{ chat_id: "oc_fixture_team", rules: ["新群规则"] }]
    }
  ];
  const promptConfigs = [];
  const executed = [];
  try {
    const runtime = new TwinRuntime({
      config: original,
      state: runtimeState,
      guard: guard(original),
      refreshConfig: async () => snapshots.shift(),
      createGuard: (configuration) => new LarkGuard({
        larkBin: "/fixture/lark-cli",
        profile: configuration.profile,
        principalName: configuration.principal.name,
        allowedDomains: configuration.allowed_lark_domains,
        runner: async (argv) => {
          executed.push(argv);
          return { exit_code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
      }),
      inferenceAdapter: new FakeInferenceAdapter(async (request) => {
        promptConfigs.push(request.promptContext.config);
        if (request.event.event_id === "evt_snapshot_old") {
          return {
            event_id: request.event.event_id,
            outcome: "ignore",
            reason: "只验证旧配置快照",
            response: null,
            commands: [],
            source_refs: [request.event.message_id]
          };
        }
        if ((request.event.execution_feedback ?? []).length > 0) {
          return {
            event_id: request.event.event_id,
            outcome: "ignore",
            reason: "动作已完成",
            response: null,
            commands: [],
            source_refs: [request.event.message_id]
          };
        }
        return {
          event_id: request.event.event_id,
          outcome: "reply",
          reason: "尝试执行已被新配置关闭的任务域",
          response: { mode: "representative", text: "准备创建任务。" },
          commands: [{
            argv: ["task", "+create", "--summary", "测试任务"],
            confirmation: "auto",
            reason: "验证动态允许域"
          }],
          source_refs: [request.event.message_id]
        };
      })
    });

    await runtime.handle(event({
      event_id: "evt_snapshot_old",
      message_id: "om_snapshot_old"
    }));
    await assert.rejects(() => runtime.handle(event({
      event_id: "evt_snapshot_new",
      message_id: "om_snapshot_new"
    })), /lark domain is not allowed: task/u);

    assert.deepEqual(promptConfigs[0].authority_rules, ["旧规则"]);
    assert.deepEqual(promptConfigs[0].group_rules, ["旧群规则"]);
    assert.deepEqual(promptConfigs[1].authority_rules, [
      "新规则",
      "企业知识库：产品；space_id=space_product"
    ]);
    assert.deepEqual(promptConfigs[1].group_rules, ["新群规则"]);
    assert.equal(executed.length, 0);
  } finally {
    runtimeState.close();
  }
});

test("TwinRuntime 每条消息同步收紧 AI 可见能力和可信 lookup", async () => {
  const internalCapability = {
    capability: "example.records.read",
    purpose: "读取合成记录",
    operations: ["get"],
    risk: "read",
    trust_zone: "internal",
    readiness: "ready",
    input_description: "合成记录标识"
  };
  const publicCapability = {
    capability: "public.web.search",
    purpose: "查询合成公开信息",
    operations: ["search"],
    risk: "read",
    trust_zone: "public",
    readiness: "ready",
    input_description: "合成公开查询"
  };
  let publicCalls = 0;
  const capabilityGateway = new CapabilityGateway({
    capabilities: [internalCapability, publicCapability],
    adapters: new Map([
      ["example.records.read", new FakeCapabilityAdapter(async () => ({
        status: "complete",
        data: { title: "合成记录" },
        source_refs: []
      }))],
      ["public.web.search", new FakeCapabilityAdapter(async () => {
        publicCalls += 1;
        return { status: "complete", data: { title: "不应读取" }, source_refs: [] };
      })]
    ])
  });
  const original = config({
    allowed_capabilities: ["example.records.read", "public.web.search"]
  });
  const runtimeState = state();
  const snapshots = [
    original,
    { ...original, allowed_capabilities: ["example.records.read"] }
  ];
  const visibleSnapshots = [];
  try {
    const runtime = new TwinRuntime({
      config: original,
      state: runtimeState,
      guard: guard(original),
      capabilityGateway,
      refreshConfig: async () => snapshots.shift(),
      createGuard: guard,
      inferenceAdapter: new FakeInferenceAdapter(async (request) => {
        visibleSnapshots.push(request.promptContext.capabilities ?? []);
        if (request.event.event_id === "evt_capability_old") {
          return {
            event_id: request.event.event_id,
            outcome: "ignore",
            reason: "只验证旧能力快照",
            response: null,
            commands: [],
            lookup_requests: [],
            source_refs: [request.event.message_id]
          };
        }
        if ((request.event.capability_feedback ?? []).length === 0) {
          return {
            event_id: request.event.event_id,
            outcome: "reply",
            reason: "尝试已被收紧的公开查询",
            response: { mode: "representative", text: "准备查询。" },
            commands: [],
            lookup_requests: [{
              capability: "public.web.search",
              operation: "search",
              input: { query: "合成公开信息" },
              reason: "验证动态能力上限"
            }],
            source_refs: [request.event.message_id]
          };
        }
        return {
          event_id: request.event.event_id,
          outcome: "reply",
          reason: "能力不可用",
          response: { mode: "suggestion", text: "需要人工处理。" },
          commands: [],
          lookup_requests: [],
          source_refs: [request.event.message_id]
        };
      })
    });

    await runtime.handle(event({
      event_id: "evt_capability_old",
      message_id: "om_capability_old"
    }));
    const narrowed = await runtime.handle(event({
      event_id: "evt_capability_new",
      message_id: "om_capability_new"
    }));

    assert.deepEqual(visibleSnapshots[0].map(({ capability }) => capability), [
      "example.records.read",
      "public.web.search"
    ]);
    assert.deepEqual(visibleSnapshots[1].map(({ capability }) => capability), [
      "example.records.read"
    ]);
    assert.equal(narrowed.lookups[0].result.status, "unavailable");
    assert.equal(publicCalls, 0);
  } finally {
    runtimeState.close();
  }
});

test("待确认业务动作在确认前被动态收紧时不再提交", async () => {
  const actionCapability = {
    capability: "example.approval.execute",
    purpose: "准备并确认合成审批",
    operations: ["prepare"],
    risk: "approval",
    trust_zone: "internal",
    readiness: "ready",
    input_description: "合成审批记录"
  };
  let confirmCalls = 0;
  const actionGateway = new CapabilityActionGateway({
    actionCapabilities: [actionCapability],
    actionAdapters: new Map([[actionCapability.capability, {
      async prepare() {
        return {
          status: "confirmation-required",
          preview: { subject: "合成审批" },
          pending_action: { proof: "fixture", phrase: "确认审批" }
        };
      },
      async confirm() {
        confirmCalls += 1;
        return { status: "complete", data: { ok: true }, source_refs: [] };
      }
    }]])
  });
  const original = config({ allowed_capabilities: [actionCapability.capability] });
  const narrowed = { ...original, allowed_capabilities: [] };
  const runtimeState = state();
  const snapshots = [original, narrowed];
  try {
    const runtime = new TwinRuntime({
      config: original,
      state: runtimeState,
      guard: guard(original),
      createGuard: guard,
      refreshConfig: async () => snapshots.shift(),
      capabilityActionGateway: actionGateway,
      sendConfirmation: async () => ({ status: "complete" }),
      inferenceAdapter: new FakeInferenceAdapter(async (request) => ({
        event_id: request.event.event_id,
        outcome: "confirm",
        reason: "准备审批",
        response: { mode: "confirmation", text: "建议执行合成审批。" },
        commands: [],
        lookup_requests: [],
        action_requests: [{
          capability: actionCapability.capability,
          operation: "prepare",
          input: { record_id: "fixture-42" },
          reason: "准备审批"
        }],
        source_refs: [request.event.message_id]
      }))
    });

    const requested = await runtime.handle(event({
      event_id: "evt_action_prepare",
      message_id: "om_action_prepare"
    }));
    const confirmationId = requested.confirmations[0].confirmation_id;
    const result = await runtime.handle(event({
      event_id: "evt_action_confirm",
      message_id: "om_action_confirm",
      chat_id: "oc_principal_p2p",
      chat_type: "p2p",
      sender_open_id: original.principal.open_id,
      text: `确认 ${confirmationId}`
    }));

    assert.equal(result.resolution.status, "approved");
    assert.equal(result.execution.status, "unavailable");
    assert.equal(confirmCalls, 0);
  } finally {
    runtimeState.close();
  }
});

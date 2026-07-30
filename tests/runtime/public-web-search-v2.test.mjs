import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LarkGuard } from "../../executor/src/lark-guard.mjs";
import {
  CapabilityGateway,
  FakeCapabilityAdapter
} from "../../runtime/src/capability-gateway.mjs";
import {
  PUBLIC_WEB_SEARCH_CAPABILITY,
  PublicWebSearchAdapter
} from "../../runtime/src/public-web-search-adapter.mjs";
import { RuntimeState } from "../../runtime/src/runtime-state.mjs";
import { TwinService } from "../../runtime/src/service.mjs";

function config(overrides = {}) {
  return {
    profile: "fixture-profile",
    principal: { name: "示例负责人", open_id: "ou_principal", timezone: "Asia/Shanghai" },
    production_enabled: true,
    allowed_lark_domains: ["im"],
    ...overrides
  };
}

function event(overrides = {}) {
  return {
    event_id: "evt-public-business-search",
    source: "event",
    chat_id: "oc_fixture",
    chat_type: "group",
    message_id: "om_public_business_search",
    sender_open_id: "ou_member",
    sent_at: "2026-07-28T09:00:00.000Z",
    update_time: "2026-07-28T09:00:00.000Z",
    message_type: "text",
    text: "请根据公开信息核实 OpenAI Codex CLI 最新稳定版本，并给出升级建议。",
    signals: { direct_mention: true },
    context: [],
    ...overrides
  };
}

function state() {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "public-web-search-")), "state.sqlite");
  return new RuntimeState(database, { clock: () => "2026-07-28T09:00:00.000Z" });
}

function guard(calls = []) {
  return new LarkGuard({
    larkBin: "/fixture/lark-cli",
    profile: "fixture-profile",
    principalName: "示例负责人",
    allowedDomains: ["im"],
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
  });
}

async function sendNotification() {
  return { status: "complete" };
}

function publicGateway(adapter, extraCapabilities = [], extraAdapters = []) {
  return new CapabilityGateway({
    capabilities: [PUBLIC_WEB_SEARCH_CAPABILITY, ...extraCapabilities],
    adapters: new Map([
      [PUBLIC_WEB_SEARCH_CAPABILITY.capability, adapter],
      ...extraAdapters
    ])
  });
}

function publicDecision(candidate, {
  text = "Codex CLI 的最新稳定版本为合成版本 1.2.3。",
  sourceRefs = ["https://developers.example.invalid/codex?private=1#fragment"]
} = {}) {
  return {
    event_id: candidate.event_id,
    outcome: "reply",
    reason: "public search complete",
    response: { mode: "suggestion", text },
    commands: [],
    lookup_requests: [],
    source_refs: sourceRefs
  };
}

test("公共 Web Search Adapter 只把当前消息中的最小公开词交给隔离查询", async () => {
  const calls = [];
  const adapter = new PublicWebSearchAdapter({
    codexBin: "/fixture/codex",
    codexEnvironmentRoot: "/fixture/codex-environment",
    runner: async (candidate, options) => {
      calls.push(structuredClone({ candidate, options }));
      return publicDecision(candidate);
    }
  });
  const capabilityGateway = publicGateway(adapter);
  const currentMessage = "请根据公开信息核实 OpenAI Codex CLI 最新稳定版本，并给出升级建议。";
  const result = await capabilityGateway.lookup({
    capability: "public.web.search",
    operation: "search",
    input: { query: "OpenAI Codex CLI 最新稳定版本" },
    reason: "fixture-hidden-reason-marker"
  }, {
    current_message_text: currentMessage
  });

  assert.deepEqual(capabilityGateway.snapshot(), [PUBLIC_WEB_SEARCH_CAPABILITY]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.publicSearchQuery, "OpenAI Codex CLI 最新稳定版本");
  assert.equal(Object.hasOwn(calls[0].options, "promptContext"), false);
  assert.doesNotMatch(
    JSON.stringify(calls[0].candidate),
    /evt-public-business-search|om_public_business_search|升级建议|fixture-hidden-reason-marker/u
  );
  assert.deepEqual(result, {
    capability: "public.web.search",
    operation: "search",
    status: "complete",
    data: {
      query: "OpenAI Codex CLI 最新稳定版本",
      summary: "Codex CLI 的最新稳定版本为合成版本 1.2.3。"
    },
    source_refs: ["https://developers.example.invalid/codex"]
  });
});

test("公共 Web Search 没有公开来源时返回空结果而不伪造内容", async () => {
  const capabilityGateway = publicGateway(new PublicWebSearchAdapter({
    codexBin: "/fixture/codex",
    codexEnvironmentRoot: "/fixture/codex-environment",
    runner: async (candidate) => publicDecision(candidate, {
      text: "没有找到可核实的公开来源。",
      sourceRefs: ["om_public_web_search"]
    })
  }));

  const result = await capabilityGateway.lookup({
    capability: "public.web.search",
    operation: "search",
    input: { query: "OpenAI Codex CLI 最新稳定版本" },
    reason: "验证空结果"
  }, {
    current_message_text: "请查询 OpenAI Codex CLI 最新稳定版本"
  });

  assert.deepEqual(result, {
    capability: "public.web.search",
    operation: "search",
    status: "empty-result"
  });
  assert.doesNotMatch(JSON.stringify(result), /没有找到可核实的公开来源/u);
});

test("公共 Web Search 在联网前拒绝敏感词和并非来自当前消息的隐藏词", async () => {
  const calls = [];
  const capabilityGateway = publicGateway(new PublicWebSearchAdapter({
    codexBin: "/fixture/codex",
    codexEnvironmentRoot: "/fixture/codex-environment",
    runner: async () => {
      calls.push("network");
      throw new Error("must not run");
    }
  }));

  for (const [query, currentMessage] of [
    ["OpenAI Codex CLI 最新稳定版本", "请查询 OpenAI Codex CLI 最新稳定版本，token=sk-fixture-secret"],
    ["内部路线图代号", "请查询 OpenAI Codex CLI 最新稳定版本"],
    ["候选人张三履历", "请联网查询候选人张三履历"],
    ["公司内部路线图代号", "请联网查询公司内部路线图代号"]
  ]) {
    const result = await capabilityGateway.lookup({
      capability: "public.web.search",
      operation: "search",
      input: { query },
      reason: "验证联网前拒绝"
    }, {
      current_message_text: currentMessage
    });
    assert.equal(result.status, "denied");
  }

  assert.deepEqual(calls, []);
});

test("普通业务问题通过公共 Web Search 查询后回到同一决策循环形成回复", async () => {
  const runtimeState = state();
  const networkCalls = [];
  const hiddenContext = "fixture-hidden-conversation-marker";
  const hiddenConfig = "fixture-hidden-config-marker";
  try {
    const capabilityGateway = publicGateway(new PublicWebSearchAdapter({
      codexBin: "/fixture/codex",
      codexEnvironmentRoot: "/fixture/private-codex-root",
      runner: async (candidate, options) => {
        networkCalls.push(structuredClone({ candidate, options }));
        return publicDecision(candidate);
      }
    }));
    const service = new TwinService({
      config: config({ authority_rules: [hiddenConfig] }),
      state: runtimeState,
      guard: guard(),
      capabilityGateway,
      runCodex: async (input, options) => {
        if ((input.capability_feedback ?? []).length === 0) {
          assert.deepEqual(options.promptContext.capabilities, [PUBLIC_WEB_SEARCH_CAPABILITY]);
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "需要核实最新公开版本",
            response: { mode: "representative", text: "我先核实公开版本。" },
            commands: [],
            lookup_requests: [{
              capability: "public.web.search",
              operation: "search",
              input: { query: "OpenAI Codex CLI 最新稳定版本" },
              reason: "核实最新公开版本"
            }],
            source_refs: [input.message_id]
          };
        }
        assert.equal(input.capability_feedback[0].result.status, "complete");
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "已取得最新公开版本证据",
          response: { mode: "representative", text: "建议按合成版本 1.2.3 评估升级。" },
          commands: [],
          lookup_requests: [],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.handle(event({
      context: [{
        message_id: "om_hidden_context",
        text: hiddenContext,
        links: []
      }]
    }));

    assert.equal(networkCalls.length, 1);
    const outboundPromptInputs = JSON.stringify({
      candidate: networkCalls[0].candidate,
      publicSearchQuery: networkCalls[0].options.publicSearchQuery
    });
    assert.doesNotMatch(outboundPromptInputs, new RegExp(hiddenContext, "u"));
    assert.doesNotMatch(outboundPromptInputs, new RegExp(hiddenConfig, "u"));
    assert.doesNotMatch(outboundPromptInputs, /evt-public-business-search|om_public_business_search/u);
    assert.equal(result.response.text, "🤖 AI助理：建议按合成版本 1.2.3 评估升级。");
    assert.equal(result.lookups[0].result.status, "complete");
  } finally {
    runtimeState.close();
  }
});

test("公开查询失败后直接转人工且不静默改用其他信任域", async () => {
  const runtimeState = state();
  const larkCalls = [];
  const privateNotifications = [];
  let internalCalls = 0;
  let decisions = 0;
  const internalCapability = {
    capability: "fixture.internal.read",
    purpose: "读取合成内部资料",
    operations: ["get"],
    risk: "read",
    trust_zone: "internal",
    readiness: "ready",
    input_description: "合成内部标识"
  };
  try {
    const capabilityGateway = publicGateway(
      new PublicWebSearchAdapter({
        codexBin: "/fixture/codex",
        codexEnvironmentRoot: "/fixture/codex-environment",
        runner: async () => { throw new Error("fixture public search failed"); }
      }),
      [internalCapability],
      [["fixture.internal.read", new FakeCapabilityAdapter(async () => {
        internalCalls += 1;
        return { status: "complete", data: { private: "must-not-use" }, source_refs: [] };
      })]]
    );
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard: guard(larkCalls),
      capabilityGateway,
      sendNotification: async (request) => {
        privateNotifications.push(structuredClone(request));
        return { status: "complete" };
      },
      runCodex: async (input) => {
        decisions += 1;
        if ((input.capability_feedback ?? []).length === 0) {
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "需要公开查询",
            response: { mode: "representative", text: "我先查询。" },
            commands: [{
              argv: [
                "im",
                "+messages-reply",
                "--message-id",
                input.message_id,
                "--text",
                "不应在公开查询失败后发送"
              ],
              reason: "错误地与失败查询同轮执行",
              confirmation: "auto"
            }],
            lookup_requests: [{
              capability: "public.web.search",
              operation: "search",
              input: { query: "OpenAI Codex CLI 最新稳定版本" },
              reason: "核实最新公开版本"
            }],
            source_refs: [input.message_id]
          };
        }
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "错误地尝试内部兜底",
          response: { mode: "representative", text: "改用内部资料。" },
          commands: [],
          lookup_requests: [{
            capability: "fixture.internal.read",
            operation: "get",
            input: { id: "fixture-42" },
            reason: "尝试其他信任域"
          }],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.handle(event({
      event_id: "evt-public-search-failed",
      message_id: "om_public_search_failed"
    }));

    assert.equal(decisions, 2);
    assert.equal(internalCalls, 0);
    assert.equal(larkCalls.some((argv) => argv.includes("不应在公开查询失败后发送")), false);
    assert.equal(result.response.mode, "suggestion");
    assert.match(result.response.text, /公开信息暂时无法查询/u);
    assert.equal(privateNotifications.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /must-not-use|改用内部资料/u);
  } finally {
    runtimeState.close();
  }
});

test("公开查询失败时清除模型残留的主体提醒标记", async () => {
  const runtimeState = state();
  const privateNotifications = [];
  let decisions = 0;
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard: guard(),
      capabilityGateway: publicGateway(new PublicWebSearchAdapter({
        codexBin: "/fixture/codex",
        codexEnvironmentRoot: "/fixture/codex-environment",
        runner: async () => { throw new Error("fixture public search failed"); }
      })),
      sendNotification: async (request) => {
        privateNotifications.push(structuredClone(request));
        return { status: "complete" };
      },
      runCodex: async (input) => {
        decisions += 1;
        if ((input.capability_feedback ?? []).length === 0) {
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "需要公开查询",
            response: { mode: "representative", text: "我先查询。" },
            commands: [],
            lookup_requests: [{
              capability: "public.web.search",
              operation: "search",
              input: { query: "合成公开信息" },
              reason: "核实公开信息"
            }],
            source_refs: [input.message_id]
          };
        }
        return {
          event_id: input.event_id,
          outcome: "confirm",
          reason: "错误地要求主体决定",
          response: { mode: "confirmation", text: "你希望通过还是驳回？" },
          commands: [],
          lookup_requests: [],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.handle(event({
      event_id: "evt-public-search-stale-attention",
      message_id: "om_public_search_stale_attention"
    }));

    assert.equal(decisions, 2);
    assert.match(result.response.text, /公开信息暂时无法查询/u);
    assert.equal(result.requires_principal_attention, undefined);
    assert.equal(result.principal_attention_code, undefined);
    assert.equal(privateNotifications.length, 0);
  } finally {
    runtimeState.close();
  }
});

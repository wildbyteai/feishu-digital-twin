import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LarkGuard } from "../../executor/src/lark-guard.mjs";
import { buildDecisionPrompt } from "../../runtime/src/prompt.mjs";
import {
  assertDailyMemoryCommand,
  assertDailyMemoryCompletion
} from "../../runtime/src/daily-memory-postcondition.mjs";
import { RuntimeState } from "../../runtime/src/runtime-state.mjs";
import { TwinService } from "../../runtime/src/service.mjs";
import {
  dailyMemorySystemEvent,
  previousDateInTimeZone,
  trustedDailyMemoryIntent
} from "../../shared/daily-memory-trigger.mjs";

function config(overrides = {}) {
  return {
    profile: "example_profile",
    lark_cli_bin: "/opt/homebrew/bin/lark-cli",
    production_data_approved: true,
    production_enabled: true,
    principal: {
      name: "示例负责人",
      open_id: "ou_principal",
      timezone: "Asia/Shanghai"
    },
    daily_memory: {
      folder_token: "fld_daily_memory",
      folder_name: "示例负责人数字分身-每日工作记忆"
    },
    allowed_lark_domains: ["im", "task", "calendar", "docs", "drive"],
    ...overrides
  };
}

function triggerEvent(overrides = {}) {
  return {
    ...dailyMemorySystemEvent("2026-07-16", {
      now: new Date("2026-07-17T00:10:00.000Z")
    }),
    ...overrides
  };
}

test("每日触发按主体用户时区选择上一自然日", () => {
  assert.equal(
    previousDateInTimeZone(new Date("2026-07-16T16:10:00.000Z"), "Asia/Shanghai"),
    "2026-07-16"
  );
  assert.equal(
    previousDateInTimeZone(new Date("2026-01-01T00:05:00.000Z"), "Asia/Shanghai"),
    "2025-12-31"
  );
});

test("只有本机可信系统事件才触发每日工作记忆", () => {
  assert.deepEqual(trustedDailyMemoryIntent(triggerEvent(), config()), {
    intent: "daily_work_memory",
    target_date: "2026-07-16"
  });
  assert.equal(trustedDailyMemoryIntent(triggerEvent({ source: "event" }), config()), null);
  assert.equal(trustedDailyMemoryIntent(triggerEvent({ source: "supplement" }), config()), null);
  assert.equal(trustedDailyMemoryIntent(triggerEvent({ sender_open_id: "ou_someone" }), config()), null);
  assert.equal(trustedDailyMemoryIntent(triggerEvent({ target_date: "2026-02-30" }), config()), null);
});

test("通用 runtime 入口拒绝外部伪造的 system 事件", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-untrusted-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => assert.fail("untrusted system event must not reach LarkGuard")
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async () => assert.fail("untrusted system event must not reach Codex")
    });
    await assert.rejects(() => service.handle(triggerEvent()), /trusted runtime entry/u);
  } finally {
    runtimeState.close();
  }
});

test("同日补跑生成新的本地事件，不会被运行时去重", () => {
  const first = dailyMemorySystemEvent("2026-07-16", {
    now: new Date("2026-07-17T00:10:00.000Z")
  });
  const second = dailyMemorySystemEvent("2026-07-16", {
    now: new Date("2026-07-17T01:10:00.000Z")
  });
  assert.notEqual(first.event_id, second.event_id);
  assert.notEqual(first.message_id, second.message_id);
});

test("同一日期的两个日报进程不能并发创建", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-lock-")), "state.sqlite");
  let stateNow = "2026-07-17T00:10:00.000Z";
  const runtimeState = new RuntimeState(database, {
    clock: () => stateNow,
    claimTtlMs: 5 * 60 * 1000,
    dailyMemoryLockTtlMs: 30 * 60 * 1000
  });
  let releaseDecision;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const decisionGate = new Promise((resolve) => { releaseDecision = resolve; });
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => assert.fail("empty decisions must not reach LarkGuard")
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        markStarted();
        await decisionGate;
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "模拟尚未完成的日报进程",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    const first = service.runDailyMemory("2026-07-16", {
      now: new Date("2026-07-17T00:10:00.000Z")
    });
    await started;
    stateNow = "2026-07-17T00:16:00.000Z";
    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:16:00.000Z")
      }),
      /daily memory for 2026-07-16 is already running/u
    );

    releaseDecision();
    await assert.rejects(first, /daily memory write requires a completed exact-title search/u);
  } finally {
    releaseDecision?.();
    runtimeState.close();
  }
});

test("日报锁被新进程接管后旧进程不得继续写文档", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-fencing-")), "state.sqlite");
  let stateNow = "2026-07-17T00:10:00.000Z";
  const stateOptions = {
    clock: () => stateNow,
    dailyMemoryLockTtlMs: 5 * 60 * 1000
  };
  const runtimeState = new RuntimeState(database, stateOptions);
  const competingState = new RuntimeState(database, stateOptions);
  const title = "2026-07-16 示例负责人每日工作记忆";
  const content = `<title>${title}</title><p>当日无可确认工作内容。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程均已检查。</p>`;
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ ok: true, data: { has_more: false, results: [] } }),
          stderr: ""
        };
      }
      return assert.fail("lost daily-memory owner must not reach document creation");
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        const feedback = input.execution_feedback ?? [];
        if (feedback.length === 0) {
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "搜索同日日报",
            response: null,
            commands: [{
              argv: [
                "drive", "+search", "--query", title,
                "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
              ],
              reason: "搜索同日日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          };
        }

        stateNow = "2026-07-17T00:16:00.000Z";
        assert.equal(competingState.claimDailyMemoryRun("2026-07-16", "owner-2"), true);
        return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "创建非空日报",
          response: null,
          commands: [{
            argv: ["docs", "+create", "--parent-token", "fld_daily_memory", "--content", content],
            reason: "创建日报",
            confirmation: "auto"
          }],
          source_refs: [input.message_id]
        };
      }
    });

    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /daily memory lock was lost before document write/u
    );
    assert.equal(calls.some((argv) => argv.includes("+create")), false);
    assert.equal(competingState.renewDailyMemoryRun("2026-07-16", "owner-2"), true);
  } finally {
    competingState.releaseDailyMemoryRun("2026-07-16", "owner-2");
    runtimeState.close();
    competingState.close();
  }
});

test("可信每日触发把日报意图交给 Codex，完成后不产生 Bot 或用户聊天消息", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const calls = [];
  let codexInput;
  let promptContext;
  const title = "2026-07-16 示例负责人每日工作记忆";
  const existingToken = "fixture_daily_memory_existing_doc";
  const content = `<title>${title}</title><p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>`;
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
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              has_more: false,
              results: [{
                result_meta: { token: existingToken, update_time: 1784200000 },
                title_highlighted: `<h>${title}</h>`
              }]
            }
          }),
          stderr: ""
        };
      }
      if (argv.includes("+fetch")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { document: { document_id: existingToken, content } }
          }),
          stderr: ""
        };
      }
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: { result: "success" } }), stderr: "" };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input, options) => {
        codexInput = input;
        promptContext = options.promptContext;
        const feedback = input.execution_feedback ?? [];
        const common = {
          event_id: input.event_id,
          outcome: "reply",
          response: null,
          source_refs: [input.message_id]
        };
        if (feedback.length === 0) {
          return {
            ...common,
            reason: "搜索同日日报",
            commands: [{
              argv: [
                "drive", "+search", "--query", title,
                "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
              ],
              reason: "搜索同日日报",
              confirmation: "auto"
            }]
          };
        }
        if (feedback.length === 1) {
          return {
            ...common,
            reason: "覆盖原日报",
            commands: [{
              argv: [
                "docs", "+update", "--doc", existingToken, "--command", "overwrite", "--content", content
              ],
              reason: "覆盖原日报",
              confirmation: "auto"
            }]
          };
        }
        if (feedback.length === 2) {
          return {
            ...common,
            reason: "写后读取原日报",
            commands: [{
              argv: ["docs", "+fetch", "--doc", existingToken],
              reason: "验证原日报正文",
              confirmation: "auto"
            }]
          };
        }
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "日报已写入并验证",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    await service.runDailyMemory("2026-07-16", {
      now: new Date("2026-07-17T00:10:00.000Z")
    });

    assert.equal(codexInput.intent, "daily_work_memory");
    assert.equal(codexInput.target_date, "2026-07-16");
    assert.deepEqual(promptContext.config.daily_memory, {
      folder_token: "fld_daily_memory",
      folder_name: "示例负责人数字分身-每日工作记忆"
    });
    assert.equal(calls.some((argv) => argv.includes("+messages-reply")), false);
    assert.equal(calls.some((argv) => argv.includes("+messages-send")), false);
  } finally {
    runtimeState.close();
  }
});

test("每日系统事件拒绝 AI 生成的聊天发送命令", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-im-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const calls = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      return { exit_code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "reply",
        reason: "错误地产生了聊天命令",
        response: { mode: "representative", text: "已生成。" },
        commands: [{
          argv: ["im", "+messages-send", "--user-id", "ou_principal", "--text", "不应发送"],
          reason: "不应发送",
          confirmation: "auto"
        }],
        source_refs: [input.message_id]
      })
    });
    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /cannot send messages/u
    );
    assert.equal(calls.length, 0);
  } finally {
    runtimeState.close();
  }
});

test("每日系统事件拒绝业务确认，不通过确认通道发送 Bot 私聊", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-confirm-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  let confirmationCalls = 0;
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async () => ({ exit_code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" })
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      sendConfirmation: async () => {
        confirmationCalls += 1;
        return { status: "sent" };
      },
      runCodex: async (input) => ({
        event_id: input.event_id,
        outcome: "confirm",
        reason: "错误地要求确认",
        response: { mode: "confirmation", text: "请确认。" },
        commands: [{
          argv: ["docs", "+create", "--title", "日报"],
          reason: "创建日报",
          confirmation: "human"
        }],
        source_refs: [input.message_id]
      })
    });
    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /cannot request confirmation/u
    );
    assert.equal(confirmationCalls, 0);
  } finally {
    runtimeState.close();
  }
});

test("可信日报动作轮允许省略不会公开发送的 response", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-silent-response-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const calls = [];
  const title = "2026-07-16 示例负责人每日工作记忆";
  const createdToken = "doc_created_daily_memory";
  const content = `<title>${title}</title><p>在已成功读取的数据源中，未发现可确认的当日工作内容。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程均返回 0 条。</p>`;
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
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ ok: true, data: { has_more: false, results: [] } }),
          stderr: ""
        };
      }
      if (argv.includes("+create")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ ok: true, data: { document: { document_id: createdToken } } }),
          stderr: ""
        };
      }
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { document: { document_id: createdToken, content } }
        }),
        stderr: ""
      };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        const feedback = input.execution_feedback ?? [];
        if (feedback.length === 0) return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "先查找同日日报",
          response: null,
          commands: [{
            argv: [
              "drive", "+search", "--query", title,
              "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
            ],
            reason: "查找现有日报",
            confirmation: "auto"
          }],
          source_refs: [input.message_id]
        };
        if (feedback.length === 1) return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "创建包含说明的日报",
          response: null,
          commands: [{
            argv: ["docs", "+create", "--parent-token", "fld_daily_memory", "--content", content],
            reason: "创建日报",
            confirmation: "auto"
          }],
          source_refs: [input.message_id]
        };
        if (feedback.length === 2) return {
          event_id: input.event_id,
          outcome: "reply",
          reason: "写后读取日报",
          response: null,
          commands: [{
            argv: ["docs", "+fetch", "--doc", createdToken],
            reason: "验证日报正文",
            confirmation: "auto"
          }],
          source_refs: [input.message_id]
        };
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "创建并验证完成",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.runDailyMemory("2026-07-16", {
      now: new Date("2026-07-17T00:10:00.000Z")
    });
    assert.deepEqual(result.executions.map((execution) => execution.status), ["complete", "complete", "complete"]);
    assert.equal(calls.some((argv) => argv.includes("+messages-reply")), false);
    assert.equal(calls.some((argv) => argv.includes("+messages-send")), false);
  } finally {
    runtimeState.close();
  }
});

test("同日日报已经存在时拒绝新建第二份", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-no-duplicate-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const calls = [];
  const title = "2026-07-16 示例负责人每日工作记忆";
  const existingToken = "fixture_daily_memory_existing_doc";
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
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              has_more: false,
              results: [{
                result_meta: { token: existingToken, update_time: 1784200000 },
                title_highlighted: `<h>${title}</h>`
              }]
            }
          }),
          stderr: ""
        };
      }
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { document: { document_id: "doc_duplicate" }, result: "success" }
        }),
        stderr: ""
      };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => (input.execution_feedback ?? []).length === 0
        ? {
            event_id: input.event_id,
            outcome: "reply",
            reason: "先搜索同日日报",
            response: null,
            commands: [{
              argv: [
                "drive", "+search", "--query", title,
                "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
              ],
              reason: "搜索同日日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          }
        : (input.execution_feedback ?? []).length === 1
        ? {
            event_id: input.event_id,
            outcome: "reply",
            reason: "错误地创建第二份日报",
            response: null,
            commands: [{
              argv: [
                "docs", "+create", "--parent-token", "fld_daily_memory", "--content",
                `<title>${title}</title><p>重复文档正文。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>`
              ],
              reason: "创建日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          }
        : {
            event_id: input.event_id,
            outcome: "ignore",
            reason: "结束",
            response: null,
            commands: [],
            source_refs: [input.message_id]
          }
    });

    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /same-date daily memory already exists/u
    );
    assert.equal(calls.some((argv) => argv.includes("+create") && !argv.includes("--dry-run")), false);
  } finally {
    runtimeState.close();
  }
});

test("同日日报精确搜索尚未完整时拒绝新建", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-incomplete-search-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const calls = [];
  const title = "2026-07-16 示例负责人每日工作记忆";
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
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { has_more: true, page_token: "next_page", results: [] }
          }),
          stderr: ""
        };
      }
      return {
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, data: { document: { document_id: "doc_should_not_exist" } } }),
        stderr: ""
      };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => (input.execution_feedback ?? []).length === 0
        ? {
            event_id: input.event_id,
            outcome: "reply",
            reason: "搜索同日日报",
            response: null,
            commands: [{
              argv: [
                "drive", "+search", "--query", title,
                "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
              ],
              reason: "搜索同日日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          }
        : {
            event_id: input.event_id,
            outcome: "reply",
            reason: "错误地把首屏空结果当作不存在",
            response: null,
            commands: [{
              argv: [
                "docs", "+create", "--parent-token", "fld_daily_memory", "--content",
                `<title>${title}</title><p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>`
              ],
              reason: "创建日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          }
    });

    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /daily memory exact-title search is incomplete/u
    );
    assert.equal(calls.some((argv) => argv.includes("+create") && !argv.includes("--dry-run")), false);
  } finally {
    runtimeState.close();
  }
});

test("同日日报覆盖正文缺少精确标题时失败关闭", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-update-title-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const calls = [];
  const title = "2026-07-16 示例负责人每日工作记忆";
  const existingToken = "fixture_daily_memory_existing_doc";
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
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              has_more: false,
              results: [{
                result_meta: { token: existingToken, update_time: 1784200000 },
                title_highlighted: `<h>${title}</h>`
              }]
            }
          }),
          stderr: ""
        };
      }
      return assert.fail("title-less overwrite must not reach the real update call");
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => (input.execution_feedback ?? []).length === 0
        ? {
            event_id: input.event_id,
            outcome: "reply",
            reason: "搜索同日日报",
            response: null,
            commands: [{
              argv: [
                "drive", "+search", "--query", title,
                "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
              ],
              reason: "搜索同日日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          }
        : {
            event_id: input.event_id,
            outcome: "reply",
            reason: "错误地省略覆盖标题",
            response: null,
            commands: [{
              argv: [
                "docs", "+update", "--doc", existingToken, "--command", "overwrite", "--content",
                "<p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>"
              ],
              reason: "覆盖原日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          }
    });

    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /daily memory content must keep the exact date title/u
    );
    assert.equal(calls.some((argv) => argv.includes("+update") && !argv.includes("--dry-run")), false);
  } finally {
    runtimeState.close();
  }
});

test("日报标题必须是覆盖正文的首个且唯一 XML 块", () => {
  const principalName = "示例负责人";
  const title = `2026-07-16 ${principalName}每日工作记忆`;
  const existingToken = "fixture_daily_memory_existing_doc";
  const feedback = [{
    command: {
      argv: [
        "drive", "+search", "--query", title,
        "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
      ]
    },
    result: {
      status: "complete",
      data: {
        has_more: false,
        results: [{
          result_meta: { token: existingToken, update_time: 1784200000 },
          title_highlighted: `<h>${title}</h>`
        }]
      }
    }
  }];
  const command = (content) => ({
    argv: [
      "docs", "+update", "--doc", existingToken,
      "--command", "overwrite", "--content", content
    ]
  });
  const body = "<p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>";

  assert.doesNotThrow(() => assertDailyMemoryCommand(
    command(`\n  <title>${title}</title>${body}`),
    { feedback, targetDate: "2026-07-16", folderToken: "fld_daily_memory", principalName }
  ));
  for (const content of [
    `${body}<title>${title}</title>`,
    `<!-- <title>${title}</title> -->${body}`,
    `<title>${title}</title><title>${title}</title>${body}`,
    `<title><b>${title}</b></title>${body}`,
    `<title> ${title} </title>${body}`,
    `<title>错误标题</title>${body}`
  ]) {
    assert.throws(
      () => assertDailyMemoryCommand(
        command(content),
        { feedback, targetDate: "2026-07-16", folderToken: "fld_daily_memory", principalName }
      ),
      /daily memory content must keep the exact date title/u
    );
  }
});

test("日报写后回读沿用首个且唯一精确标题硬门", () => {
  const principalName = "示例负责人";
  const title = `2026-07-16 ${principalName}每日工作记忆`;
  const existingToken = "fixture_daily_memory_existing_doc";
  const body = "<p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>";
  const feedbackFor = (content) => [{
    command: {
      argv: [
        "drive", "+search", "--query", title,
        "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
      ]
    },
    result: {
      status: "complete",
      data: {
        has_more: false,
        results: [{
          result_meta: { token: existingToken, update_time: 1784200000 },
          title_highlighted: `<h>${title}</h>`
        }]
      }
    }
  }, {
    command: {
      argv: [
        "docs", "+update", "--doc", existingToken,
        "--command", "overwrite", "--content", `<title>${title}</title>${body}`
      ]
    },
    result: { status: "complete", data: { result: "success" } }
  }, {
    command: { argv: ["docs", "+fetch", "--doc", existingToken] },
    result: {
      status: "complete",
      data: { document: { document_id: existingToken, content } }
    }
  }];
  const options = {
    targetDate: "2026-07-16",
    folderToken: "fld_daily_memory",
    principalName
  };

  assert.doesNotThrow(() => assertDailyMemoryCompletion({
    feedback: feedbackFor(`<title>${title}</title>${body}`),
    ...options
  }));
  for (const content of [
    `${body}<title>${title}</title>`,
    `<!-- <title>${title}</title> -->${body}`,
    `<title>${title}</title><title>${title}</title>${body}`,
    `<title><b>${title}</b></title>${body}`,
    `<title> ${title} </title>${body}`,
    `<title>错误标题</title>${body}`
  ]) {
    assert.throws(
      () => assertDailyMemoryCompletion({ feedback: feedbackFor(content), ...options }),
      /daily memory verification found an unexpected title/u
    );
  }
});

test("日报写后首次读到空正文、随后完整读回时以最新结果完成闭环", () => {
  const principalName = "示例负责人";
  const title = `2026-07-16 ${principalName}每日工作记忆`;
  const existingToken = "fixture_daily_memory_existing_doc";
  const body = "<p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>";
  const feedback = [{
    command: {
      argv: [
        "drive", "+search", "--query", title,
        "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
      ]
    },
    result: {
      status: "complete",
      data: {
        has_more: false,
        results: [{
          result_meta: { token: existingToken, update_time: 1784200000 },
          title_highlighted: `<h>${title}</h>`
        }]
      }
    }
  }, {
    command: {
      argv: [
        "docs", "+update", "--doc", existingToken,
        "--command", "overwrite", "--content", `<title>${title}</title>${body}`
      ]
    },
    result: { status: "complete", data: { result: "success" } }
  }, {
    command: { argv: ["docs", "+fetch", "--doc", existingToken] },
    result: {
      status: "complete",
      data: { document: { document_id: existingToken, content: `<title>${title}</title>` } }
    }
  }, {
    command: { argv: ["docs", "+fetch", "--doc", existingToken] },
    result: {
      status: "complete",
      data: { document: { document_id: existingToken, content: `<title>${title}</title>${body}` } }
    }
  }];

  assert.doesNotThrow(() => assertDailyMemoryCompletion({
    feedback,
    targetDate: "2026-07-16",
    folderToken: "fld_daily_memory",
    principalName
  }));
});

test("日报写入后必须重新读取并确认原文档正文非空", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-verify-body-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const title = "2026-07-16 示例负责人每日工作记忆";
  const existingToken = "fixture_daily_memory_existing_doc";
  let fetches = 0;
  const delays = [];
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      if (argv.includes("--dry-run")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
      }
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              has_more: false,
              results: [{
                result_meta: { token: existingToken, update_time: 1784200000 },
                title_highlighted: `<h>${title}</h>`
              }]
            }
          }),
          stderr: ""
        };
      }
      if (argv.includes("+update")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ ok: true, data: { result: "success" } }),
          stderr: ""
        };
      }
      fetches += 1;
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { document: { document_id: existingToken, content: `<title>${title}</title>` } }
        }),
        stderr: ""
      };
    }
  });
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        const feedback = input.execution_feedback ?? [];
        const common = {
          event_id: input.event_id,
          outcome: "reply",
          response: null,
          source_refs: [input.message_id]
        };
        if (feedback.length === 0) {
          return {
            ...common,
            reason: "搜索同日日报",
            commands: [{
              argv: [
                "drive", "+search", "--query", title,
                "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
              ],
              reason: "搜索同日日报",
              confirmation: "auto"
            }]
          };
        }
        if (feedback.length === 1) {
          return {
            ...common,
            reason: "覆盖原日报",
            commands: [{
              argv: [
                "docs", "+update", "--doc", existingToken, "--command", "overwrite", "--content",
                `<title>${title}</title><p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>`
              ],
              reason: "覆盖原日报",
              confirmation: "auto"
            }]
          };
        }
        if (feedback.length === 2) {
          return {
            ...common,
            reason: "写后读取原日报",
            commands: [{
              argv: ["docs", "+fetch", "--doc", existingToken],
              reason: "验证原日报正文",
              confirmation: "auto"
            }]
          };
        }
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "结束",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /daily memory verification found an empty body/u
    );
    assert.equal(fetches, 3);
    assert.deepEqual(delays, [500, 1500]);
  } finally {
    runtimeState.close();
  }
});

test("日报尚未闭环时会有限重试空决策", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-empty-decision-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const title = "2026-07-16 示例负责人每日工作记忆";
  const existingToken = "fixture_daily_memory_existing_doc";
  const content = `<title>${title}</title><p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>`;
  const updateContent = `<title>${title}</title><p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>`;
  const calls = [];
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
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              has_more: false,
              results: [{
                result_meta: { token: existingToken, update_time: 1784200000 },
                title_highlighted: `<h>${title}</h>`
              }]
            }
          }),
          stderr: ""
        };
      }
      if (argv.includes("+fetch")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { document: { document_id: existingToken, content } }
          }),
          stderr: ""
        };
      }
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: { result: "success" } }), stderr: "" };
    }
  });
  let decisions = 0;
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        decisions += 1;
        const feedback = input.execution_feedback ?? [];
        if (decisions === 1) {
          assert.equal(input.daily_memory_progress.required_next_step.includes("精确标题搜索"), true);
          return {
            event_id: input.event_id,
            outcome: "ignore",
            reason: "错误地提前结束",
            response: null,
            commands: [],
            source_refs: [input.message_id]
          };
        }
        const common = {
          event_id: input.event_id,
          outcome: "reply",
          response: null,
          source_refs: [input.message_id]
        };
        if (feedback.length === 0) return {
          ...common,
          reason: "重试搜索",
          commands: [{
            argv: [
              "drive", "+search", "--query", title,
              "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
            ],
            reason: "搜索同日日报",
            confirmation: "auto"
          }]
        };
        if (feedback.length === 1) return {
          ...common,
          reason: "覆盖原日报",
          commands: [{
            argv: ["docs", "+update", "--doc", existingToken, "--command", "overwrite", "--content", updateContent],
            reason: "覆盖原日报",
            confirmation: "auto"
          }]
        };
        if (feedback.length === 2) {
          assert.equal(input.daily_memory_progress.required_next_step.includes("docs +fetch"), true);
          return {
            event_id: input.event_id,
            outcome: "ignore",
            reason: "错误地遗漏写后回读",
            response: null,
            commands: [],
            source_refs: [input.message_id]
          };
        }
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "闭环完成",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.runDailyMemory("2026-07-16", {
      now: new Date("2026-07-17T00:10:00.000Z")
    });
    assert.equal(decisions, 5);
    assert.deepEqual(result.executions.map((execution) => execution.status), ["complete", "complete", "complete"]);
    const fetchCalls = calls.filter(
      (argv) => argv.includes("+fetch") && !argv.includes("--dry-run")
    );
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][fetchCalls[0].indexOf("--doc") + 1], existingToken);
    assert.equal(fetchCalls[0][fetchCalls[0].indexOf("--as") + 1], "user");
  } finally {
    runtimeState.close();
  }
});

test("模型发起的日报回读失败后运行时不得自动重试", async () => {
  const database = path.join(
    mkdtempSync(path.join(tmpdir(), "daily-memory-verification-once-")),
    "state.sqlite"
  );
  const runtimeState = new RuntimeState(database);
  const title = "2026-07-16 示例负责人每日工作记忆";
  const existingToken = "fixture_daily_memory_existing_doc";
  const updateContent = `<title>${title}</title><p>当日汇总。</p><h1>来源引用与数据缺口</h1><p>聊天、任务和日程已检查。</p>`;
  const calls = [];
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
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              has_more: false,
              results: [{
                result_meta: { token: existingToken, update_time: 1784200000 },
                title_highlighted: `<h>${title}</h>`
              }]
            }
          }),
          stderr: ""
        };
      }
      if (argv.includes("+fetch")) {
        return {
          exit_code: 2,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: { type: "transport", message: "temporary read failure" }
          })
        };
      }
      return {
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, data: { result: "success" } }),
        stderr: ""
      };
    }
  });
  try {
    const service = new TwinService({
      config: config({ max_ai_action_rounds: 3 }),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        const feedback = input.execution_feedback ?? [];
        const common = {
          event_id: input.event_id,
          outcome: "reply",
          response: null,
          source_refs: [input.message_id]
        };
        if (feedback.length === 0) return {
          ...common,
          reason: "搜索原日报",
          commands: [{
            argv: [
              "drive", "+search", "--query", title,
              "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
            ],
            reason: "搜索原日报",
            confirmation: "auto"
          }]
        };
        if (feedback.length === 1) return {
          ...common,
          reason: "覆盖原日报",
          commands: [{
            argv: [
              "docs", "+update", "--doc", existingToken,
              "--command", "overwrite", "--content", updateContent
            ],
            reason: "覆盖原日报",
            confirmation: "auto"
          }]
        };
        if (feedback.length === 2) return {
          ...common,
          reason: "读取原日报验证正文",
          commands: [{
            argv: ["docs", "+fetch", "--doc", existingToken],
            reason: "读取原日报验证正文",
            confirmation: "auto"
          }]
        };
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "遗漏或放弃回读",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    await assert.rejects(
      () => service.runDailyMemory("2026-07-16", {
        now: new Date("2026-07-17T00:10:00.000Z")
      }),
      /daily memory write must be followed by docs \+fetch verification/u
    );
    assert.equal(
      calls.filter((argv) => argv.includes("+fetch") && !argv.includes("--dry-run")).length,
      1
    );
    assert.equal(
      calls.filter((argv) => argv.includes("+update") && !argv.includes("--dry-run")).length,
      1
    );
  } finally {
    runtimeState.close();
  }
});

test("日报非标题数据源读取失败时直接记录缺口并按三轮闭环", async () => {
  const database = path.join(mkdtempSync(path.join(tmpdir(), "daily-memory-feedback-")), "state.sqlite");
  const runtimeState = new RuntimeState(database);
  const calls = [];
  const title = "2026-07-16 示例负责人每日工作记忆";
  const createdToken = "fixture_daily_memory_feedback_doc";
  const content = `<title>${title}</title><p>在已成功读取的数据源中，未发现可确认的当日工作内容。</p><h1>来源引用与数据缺口</h1><p>聊天读取失败（validation / invalid_parameter），可能遗漏当日沟通；任务和日程无可确认内容。</p>`;
  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: config().allowed_lark_domains,
    runner: async (argv) => {
      calls.push(argv);
      if (argv.includes("--dry-run") && argv.includes("invalid-time")) {
        return {
          exit_code: 2,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: {
              type: "validation",
              subtype: "invalid_parameter",
              message: "--start must include a timezone offset",
              hint: "use RFC3339 such as 2026-07-16T00:00:00+08:00"
            }
          })
        };
      }
      if (argv.includes("--dry-run")) {
        return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
      }
      if (argv.includes("+search")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ ok: true, data: { has_more: false, results: [] } }),
          stderr: ""
        };
      }
      if (argv.includes("+create")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ ok: true, data: { document: { document_id: createdToken } } }),
          stderr: ""
        };
      }
      if (argv.includes("+fetch")) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            ok: true,
            data: { document: { document_id: createdToken, content } }
          }),
          stderr: ""
        };
      }
      return {
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, data: { messages: [] } }),
        stderr: ""
      };
    }
  });
  let decisions = 0;
  try {
    const service = new TwinService({
      config: config(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        decisions += 1;
        const feedback = input.execution_feedback ?? [];
        if (feedback.length === 0) {
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "先搜索日报并读取消息",
            response: { mode: "representative", text: "正在汇总。" },
            commands: [
              {
                argv: [
                  "drive", "+search", "--query", title,
                  "--folder-tokens", "fld_daily_memory", "--doc-types", "docx", "--only-title"
                ],
                reason: "搜索同日日报",
                confirmation: "auto"
              },
              {
                argv: ["im", "+messages-search", "--start", "invalid-time"],
                reason: "读取目标日消息",
                confirmation: "auto"
              }
            ],
            source_refs: [input.message_id]
          };
        }
        if (feedback.length === 2) {
          assert.equal(feedback[0].result.status, "complete");
          assert.equal(feedback[1].result.status, "failed");
          assert.equal(feedback[1].result.error_type, "validation");
          assert.equal(Object.hasOwn(feedback[1].result, "error"), false);
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "记录聊天数据缺口并创建日报",
            response: { mode: "representative", text: "继续汇总。" },
            commands: [{
              argv: ["docs", "+create", "--parent-token", "fld_daily_memory", "--content", content],
              reason: "使用成功数据并记录失败数据源后创建日报",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          };
        }
        if (feedback.length === 3) {
          assert.equal(feedback[2].result.status, "complete");
          return {
            event_id: input.event_id,
            outcome: "reply",
            reason: "写后读取日报",
            response: null,
            commands: [{
              argv: ["docs", "+fetch", "--doc", createdToken],
              reason: "验证日报正文",
              confirmation: "auto"
            }],
            source_refs: [input.message_id]
          };
        }
        assert.equal(feedback[3].result.status, "complete");
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "读取纠正且日报写入验证完成",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    const result = await service.runDailyMemory("2026-07-16", {
      now: new Date("2026-07-17T00:10:00.000Z")
    });
    assert.equal(decisions, 4);
    assert.deepEqual(
      result.executions.map((execution) => execution.status),
      ["complete", "failed", "complete", "complete"]
    );
    assert.equal(
      calls.some((argv) => argv.includes("+messages-search") && argv.includes("2026-07-16T00:00:00+08:00")),
      false
    );
    assert.equal(calls.filter((argv) => !argv.includes("--dry-run")).length, 3);
  } finally {
    runtimeState.close();
  }
});

test("日报 Skill 只在可信日报意图中加入 Codex 提示", () => {
  const ordinary = buildDecisionPrompt(triggerEvent(), {});
  const daily = buildDecisionPrompt({
    ...triggerEvent(),
    intent: "daily_work_memory",
    target_date: "2026-07-16"
  }, {});

  assert.equal(ordinary.includes("name: feishu-daily-work-memory"), false);
  assert.equal(daily.includes("name: feishu-daily-work-memory"), true);
  assert.equal(daily.includes("--exclude-sender-type bot"), false);
  assert.equal(daily.includes("--page-limit 10"), true);
  assert.equal(daily.includes("im +messages-search --start <开始>"), true);
  assert.equal(daily.includes("--query \"\""), false);
  assert.equal(
    daily.includes("task +get-related-tasks --page-token <目标日开始微秒> --page-limit 5"),
    true
  );
  assert.equal(daily.includes("新建时必须在同一条 `docs +create` 命令中写入完整正文"), true);
  assert.equal(daily.includes("禁止先创建只有标题的空文档"), true);
  assert.equal(daily.includes("第一轮必须一次性发出五条事实读取命令"), true);
  assert.equal(daily.includes("任何单个读取失败都不能阻止生成日报"), true);
  assert.equal(daily.includes("第二轮必须执行文档写入"), true);
  assert.equal(daily.includes("第三轮必须对刚写入的同一 token 执行 `docs +fetch`"), true);
  assert.equal(daily.includes("只要精确标题搜索返回一份或多份结果，就禁止调用 `docs +create`"), true);
  assert.equal(daily.includes("未发现可确认的当日工作内容"), true);
  assert.equal(daily.includes("禁止留下空白正文"), true);
  assert.equal(daily.includes("返回 `has_more: true` 时，本次运行失败关闭"), true);
  assert.equal(daily.includes("其他数据源失败不在本次运行重试"), true);
  assert.equal(daily.includes("直接把失败类型和可能遗漏范围写入数据缺口"), true);
  assert.equal(daily.includes("来源说明必须分别覆盖聊天、任务和日程"), true);
  assert.equal(
    daily.includes("`docs +update --command overwrite` 也不得省略、后置或重复标题"),
    true
  );
  assert.equal(daily.includes("写后读回失败或正文为空时必须报告失败"), true);
  assert.equal(daily.includes("不得只返回文字说明而不写文档"), true);
});

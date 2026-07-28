import assert from "node:assert/strict";
import test from "node:test";

import { summarizeServiceResult } from "../../runtime/src/result-summary.mjs";

test("运行输出保留不可逆执行指纹用于去重审计，但不输出正文、命令指纹或飞书数据", () => {
  const summary = summarizeServiceResult({
    event_id: "evt_1",
    outcome: "reply",
    reason: "包含业务原因",
    response: { text: "完整回复正文" },
    commands: [{ argv: ["task", "+create", "--summary", "敏感项目"] }],
    executions: [{
      status: "complete",
      command_hash: "a".repeat(64),
      execution_hash: `execution_${"b".repeat(64)}`,
      data: { title: "敏感项目" }
    }],
    confirmations: [{ confirmation_id: "abcd1234abcd1234", delivery: { status: "complete" } }],
    diagnostics: {
      context_fetched: true,
      context_count: 3,
      context_scope: "chat",
      decision_reason_code: "AI_REPLY_AFTER_CONTEXT",
      processing_latency_ms: 127,
      unsafe_detail: "完整群聊正文"
    }
  }, {
    traceId: () => "trace_test_1",
    now: () => "2026-07-24T08:00:00.000Z"
  });

  assert.deepEqual(summary, {
    trace_id: "trace_test_1",
    logged_at: "2026-07-24T08:00:00.000Z",
    outcome: "reply",
    executions: [{ status: "complete", execution_hash: `execution_${"b".repeat(64)}` }],
    confirmations: [{ status: "complete" }],
    diagnostics: {
      context_fetched: true,
      context_count: 3,
      context_scope: "chat",
      decision_reason_code: "AI_REPLY_AFTER_CONTEXT",
      processing_latency_ms: 127
    }
  });
  assert.equal(JSON.stringify(summary).includes("敏感项目"), false);
  assert.equal(JSON.stringify(summary).includes("完整回复正文"), false);
  assert.equal(JSON.stringify(summary).includes("完整群聊正文"), false);
  assert.equal(JSON.stringify(summary).includes("evt_1"), false);
  assert.equal(JSON.stringify(summary).includes("a".repeat(64)), false);
  assert.equal(JSON.stringify(summary).includes(`execution_${"b".repeat(64)}`), true);
  assert.equal(JSON.stringify(summary).includes("abcd1234abcd1234"), false);
});

test("运行输出拒绝格式无效的执行指纹", () => {
  const summary = summarizeServiceResult({
    outcome: "reply",
    executions: [{ status: "complete", execution_hash: "not-a-valid-audit-hash" }]
  }, {
    traceId: () => "trace_test_invalid_hash",
    now: () => "2026-07-24T08:00:00.000Z"
  });

  assert.deepEqual(summary.executions, [{ status: "complete" }]);
});

test("查询结果日志不保留查询正文、结果正文、来源或私有实现信息", () => {
  const summary = summarizeServiceResult({
    outcome: "reply",
    lookups: [{
      round: 1,
      request: {
        capability: "private.workflow.read",
        operation: "get",
        input: { query: "不得记录的查询正文" },
        reason: "不得记录的查询原因"
      },
      result: {
        status: "complete",
        data: {
          content: "不得记录的结果正文",
          local_path: "/private/fixture/path",
          mcp_name: "private-mcp-name",
          credential: "private-credential",
          raw_error: "private-raw-error"
        },
        source_refs: ["https://private.example.invalid/items/42"]
      }
    }],
    executions: [],
    confirmations: [],
    diagnostics: {
      context_fetched: false,
      context_count: 0,
      context_scope: "none",
      decision_reason_code: "AI_REPLY_WITHOUT_CONTEXT",
      processing_latency_ms: 23
    }
  }, {
    traceId: () => "trace_query_privacy",
    now: () => "2026-07-28T09:00:00.000Z"
  });

  assert.deepEqual(summary, {
    trace_id: "trace_query_privacy",
    logged_at: "2026-07-28T09:00:00.000Z",
    outcome: "reply",
    executions: [],
    confirmations: [],
    diagnostics: {
      context_fetched: false,
      context_count: 0,
      context_scope: "none",
      decision_reason_code: "AI_REPLY_WITHOUT_CONTEXT",
      processing_latency_ms: 23
    }
  });
  assert.doesNotMatch(
    JSON.stringify(summary),
    /不得记录|private\.workflow|private-mcp-name|private-credential|private-raw-error|private\.example|\/private\/fixture/u
  );
});

test("最终结果改变 AI outcome 时诊断码跟随最终阶段而不是沿用旧码", () => {
  const summary = summarizeServiceResult({
    event_id: "evt_high_risk",
    outcome: "confirm",
    executions: [],
    confirmations: [],
    diagnostics: {
      context_fetched: true,
      context_count: 2,
      context_scope: "chat",
      decision_reason_code: "AI_REPLY_AFTER_CONTEXT",
      processing_latency_ms: 10
    }
  }, {
    traceId: () => "trace_test_2",
    now: () => "2026-07-24T08:00:00.000Z"
  });

  assert.equal(summary.diagnostics.decision_reason_code, "AI_CONFIRM_AFTER_CONTEXT");
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CodexInferenceAdapter,
  InferenceError
} from "../../runtime/src/inference-adapter.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakeCodex = path.join(projectRoot, "tests/fixtures/bin/codex");

function installLarkSkill(isolationRoot) {
  let skillDirectory = path.join(isolationRoot, "home");
  mkdirSync(skillDirectory, { mode: 0o700 });
  for (const segment of [".agents", "skills", "lark-shared"]) {
    skillDirectory = path.join(skillDirectory, segment);
    mkdirSync(skillDirectory, { mode: 0o700 });
  }
  writeFileSync(path.join(skillDirectory, "SKILL.md"), [
    "---",
    "name: lark-shared",
    "description: synthetic fixture",
    "---",
    ""
  ].join("\n"));
}

function event() {
  return {
    event_id: "evt_codex",
    message_id: "om_codex",
    text: "合成测试消息"
  };
}

test("一个已可用 Codex CLI 执行统一的 ephemeral 决策契约", async () => {
  const codexEnvironmentRoot = mkdtempSync(path.join(tmpdir(), "twin-inference-runtime-"));
  try {
    installLarkSkill(codexEnvironmentRoot);
    const adapter = new CodexInferenceAdapter({
      codexBin: fakeCodex,
      codexEnvironmentRoot,
      timeoutMs: 5000
    });

    const decision = await adapter.decide({
      event: event(),
      promptContext: { config: { principal: { name: "示例用户" } } }
    });

    assert.equal(decision.event_id, "evt_codex");
    assert.equal(decision.outcome, "reply");
    const health = await adapter.doctor();
    assert.deepEqual(Object.keys(health).sort(), ["code", "latency_ms", "ok"]);
    assert.equal(health.ok, true);
    assert.equal(health.code, "READY");
    assert.equal(health.latency_ms >= 0, true);
  } finally {
    rmSync(codexEnvironmentRoot, { recursive: true, force: true });
  }
});

test("Codex Doctor 只发送合成能力检查并返回脱敏状态", async () => {
  const calls = [];
  const ticks = [1000, 1017];
  const adapter = new CodexInferenceAdapter({
    codexBin: fakeCodex,
    codexEnvironmentRoot: "/fixture/not-used",
    timeoutMs: 5000,
    clock: () => ticks.shift(),
    runner: async (doctorEvent, options) => {
      calls.push({ doctorEvent, options });
      return {
        event_id: doctorEvent.event_id,
        outcome: "ignore",
        reason: "capability check complete",
        response: null,
        commands: [],
        source_refs: [doctorEvent.message_id]
      };
    }
  });

  const result = await adapter.doctor();

  assert.deepEqual(result, {
    ok: true,
    code: "READY",
    latency_ms: 17
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].doctorEvent.source, "system");
  assert.equal(calls[0].doctorEvent.text, "Codex runtime capability check");
  assert.deepEqual(calls[0].options.promptContext, { doctor: true });
});

test("Codex 决策契约接受独立的语义能力查询且拒绝传输细节", async () => {
  const adapter = new CodexInferenceAdapter({
    codexBin: fakeCodex,
    codexEnvironmentRoot: "/fixture/not-used",
    runner: async (candidate) => ({
      event_id: candidate.event_id,
      outcome: "reply",
      reason: "先读取流程再答复",
      response: { mode: "representative", text: "我先核实流程。" },
      commands: [],
      lookup_requests: [{
        capability: "fixture.workflow.read",
        operation: "get",
        input: { workflow_id: "fixture-42" },
        reason: "核实流程状态"
      }],
      source_refs: [candidate.message_id]
    })
  });

  const decision = await adapter.decide({ event: event() });
  assert.deepEqual(decision.lookup_requests, [{
    capability: "fixture.workflow.read",
    operation: "get",
    input: { workflow_id: "fixture-42" },
    reason: "核实流程状态"
  }]);

  const transportAware = new CodexInferenceAdapter({
    codexBin: fakeCodex,
    codexEnvironmentRoot: "/fixture/not-used",
    runner: async (candidate) => ({
      event_id: candidate.event_id,
      outcome: "reply",
      reason: "错误地指定传输",
      response: { mode: "suggestion", text: "无法处理。" },
      commands: [],
      lookup_requests: [{
        capability: "fixture.workflow.read",
        operation: "get",
        input: { workflow_id: "fixture-42" },
        reason: "核实流程状态",
        server: "private-server"
      }],
      source_refs: [candidate.message_id]
    })
  });
  await assert.rejects(
    () => transportAware.decide({ event: event() }),
    (error) => error instanceof InferenceError && error.code === "INFERENCE_INVALID_OUTPUT"
  );
});

test("Codex 错误转换为稳定分类且不会泄漏底层错误正文或尝试备用运行环境", async () => {
  let calls = 0;
  const adapter = new CodexInferenceAdapter({
    codexBin: fakeCodex,
    codexEnvironmentRoot: "/fixture/not-used",
    runner: async () => {
      calls += 1;
      throw new Error("Codex timed out after 5000ms; secret=fixture-secret");
    }
  });

  await assert.rejects(
    () => adapter.decide({ event: event() }),
    (error) => {
      assert.equal(error instanceof InferenceError, true);
      assert.equal(error.code, "INFERENCE_TIMEOUT");
      assert.equal(error.message.includes("fixture-secret"), false);
      return true;
    }
  );
  assert.equal(calls, 1);

  const status = await adapter.doctor();
  assert.deepEqual(Object.keys(status).sort(), ["code", "latency_ms", "ok"]);
  assert.equal(status.ok, false);
  assert.equal(status.code, "INFERENCE_TIMEOUT");
  assert.equal(JSON.stringify(status).includes("fixture-secret"), false);
});

test("Codex 可执行文件不存在时稳定分类为不可用且不尝试备用环境", async () => {
  let calls = 0;
  const adapter = new CodexInferenceAdapter({
    codexBin: fakeCodex,
    codexEnvironmentRoot: "/fixture/not-used",
    runner: async () => {
      calls += 1;
      const error = new Error("spawn private-path ENOENT");
      error.code = "ENOENT";
      throw error;
    }
  });

  await assert.rejects(
    () => adapter.decide({ event: event() }),
    (error) => {
      assert.equal(error instanceof InferenceError, true);
      assert.equal(error.code, "INFERENCE_UNAVAILABLE");
      assert.equal(error.message.includes("private-path"), false);
      return true;
    }
  );
  assert.equal(calls, 1);

  const status = await adapter.doctor();
  assert.equal(status.ok, false);
  assert.equal(status.code, "INFERENCE_UNAVAILABLE");
  assert.equal(JSON.stringify(status).includes("private-path"), false);
  assert.equal(calls, 2);
});

test("不兼容输出 Schema 的 Codex 在适配器边界失败关闭", async () => {
  for (const invalidDecision of [
    {
      event_id: "evt_codex",
      outcome: "reply",
      reason: "invalid response",
      response: { mode: "representative" },
      commands: [],
      source_refs: ["om_codex"]
    },
    {
      event_id: "evt_codex",
      outcome: "ignore",
      reason: "unexpected field",
      response: null,
      commands: [],
      source_refs: ["om_codex"],
      unexpected: "must-not-leak"
    },
    {
      event_id: "evt_codex",
      outcome: "ignore",
      reason: "invalid command",
      response: null,
      commands: [{ argv: ["task"], reason: "invalid", confirmation: "auto" }],
      source_refs: ["om_codex"]
    }
  ]) {
    const adapter = new CodexInferenceAdapter({
      codexBin: fakeCodex,
      codexEnvironmentRoot: "/fixture/not-used",
      runner: async () => invalidDecision
    });
    await assert.rejects(
      () => adapter.decide({ event: event() }),
      (error) => error instanceof InferenceError && error.code === "INFERENCE_INVALID_OUTPUT"
    );
  }
});

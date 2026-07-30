import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  DECISION_SCHEMA_PATH,
  normalizeDecision
} from "../../runtime/src/decision-contract.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function decision(overrides = {}) {
  return {
    event_id: "evt_contract",
    outcome: "reply",
    reason: "需要回应",
    response: {
      mode: "representative",
      text: "可以继续推进。"
    },
    commands: [],
    source_refs: ["om_contract"],
    ...overrides
  };
}

test("Decision Contract 只为旧输出补齐缺失的能力请求数组", () => {
  const normalized = normalizeDecision(decision(), { eventId: "evt_contract" });

  assert.deepEqual(normalized.lookup_requests, []);
  assert.deepEqual(normalized.action_requests, []);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "action_requests",
    "commands",
    "event_id",
    "lookup_requests",
    "outcome",
    "reason",
    "response",
    "source_refs"
  ]);
});

test("Decision Contract 拒绝输出 Schema 未声明的字段", () => {
  assert.throws(
    () => normalizeDecision(decision({ unexpected: "must-not-leak" }), {
      eventId: "evt_contract"
    }),
    /decision has invalid fields/u
  );
});

test("Decision Contract 拒绝没有证据引用的决策", () => {
  assert.throws(
    () => normalizeDecision(decision({ source_refs: [] }), { eventId: "evt_contract" }),
    /decision\.source_refs must contain at least one source/u
  );
});

test("Decision Contract 在可信 seam 还原并校验能力请求输入", () => {
  const normalized = normalizeDecision(decision({
    lookup_requests: [{
      capability: "fixture.workflow.read",
      operation: "get",
      input: JSON.stringify({ workflow_id: "fixture-42" }),
      reason: "核实流程状态"
    }]
  }), { eventId: "evt_contract" });

  assert.deepEqual(normalized.lookup_requests, [{
    capability: "fixture.workflow.read",
    operation: "get",
    input: { workflow_id: "fixture-42" },
    reason: "核实流程状态"
  }]);
});

test("Decision Contract 统一拒绝不符合结构约束的决策", () => {
  const lookup = {
    capability: "fixture.workflow.read",
    operation: "get",
    input: { workflow_id: "fixture-42" },
    reason: "核实流程状态"
  };
  const command = {
    argv: ["task", "+create"],
    reason: "创建任务",
    confirmation: "auto"
  };
  const invalidDecisions = [
    decision({ outcome: "draft" }),
    decision({ reason: "" }),
    decision({ response: { mode: "unknown", text: "无法处理。" } }),
    decision({ commands: [command, command, command, command, command, command] }),
    decision({ commands: [{ ...command, argv: ["task"] }] }),
    decision({ lookup_requests: [lookup, lookup] }),
    decision({ lookup_requests: [lookup], action_requests: [lookup] }),
    decision({ commands: [command], action_requests: [lookup] })
  ];

  for (const invalidDecision of invalidDecisions) {
    assert.throws(
      () => normalizeDecision(invalidDecision, { eventId: "evt_contract" }),
      TypeError
    );
  }
});

test("数字分身 Skill 示例与唯一输出 Schema 保持一致", () => {
  const schema = JSON.parse(readFileSync(DECISION_SCHEMA_PATH, "utf8"));
  const skill = readFileSync(path.join(
    projectRoot,
    "skills/feishu-digital-twin/SKILL.md"
  ), "utf8");
  const outputSection = skill.match(/## 输出契约([\s\S]+)$/u)?.[1] ?? "";
  const exampleText = outputSection.match(/```json\n([\s\S]+?)\n```/u)?.[1];

  assert.match(outputSection, /输出 Schema 是结构事实源/u);
  assert.equal(typeof exampleText, "string");
  const example = JSON.parse(exampleText);
  assert.deepEqual(Object.keys(example), schema.required);
  assert.deepEqual(example.outcome.split("|"), schema.properties.outcome.enum);
  assert.deepEqual(
    example.response.mode.split("|"),
    schema.properties.response.anyOf.find((item) => item.type === "object").properties.mode.enum
  );
  assert.deepEqual(
    example.commands[0].confirmation.split("|"),
    schema.properties.commands.items.properties.confirmation.enum
  );
  assert.equal(example.source_refs.length > 0, true);
});

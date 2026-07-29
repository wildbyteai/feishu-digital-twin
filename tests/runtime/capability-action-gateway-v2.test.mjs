import assert from "node:assert/strict";
import test from "node:test";

import { CapabilityActionGateway } from "../../runtime/src/capability-action-gateway.mjs";
import {
  compilePrivateCapabilityPacks,
  resolvePrivateCapabilityServers,
  validatePrivateCapabilityPack
} from "../../runtime/src/private-capability-pack.mjs";

const PRIVATE_PROOF = ["fixture", "confirmation", "proof"].join("-");

function approvalPack(overrides = {}) {
  return {
    schema_version: 1,
    pack_id: "example.approval",
    pack_version: "1.0.0",
    server_ref: "example-managed-approval",
    tools: [
      { name: "approval.prepare", risk: "prepare" },
      { name: "approval.confirm", risk: "write" }
    ],
    capabilities: [],
    actions: [{
      capability: "example.approval.execute",
      operation: "prepare",
      purpose: "准备并确认合成审批",
      prepare_tool: "approval.prepare",
      confirm_tool: "approval.confirm",
      input_constraints: {
        allowed_fields: ["record_id", "decision", "note", "session"],
        required_fields: ["record_id", "decision", "note"],
        max_bytes: 2048
      },
      confirmation: {
        token_field: "confirmationToken",
        phrase_field: "confirmationPhrase",
        token_argument: "confirmationToken",
        phrase_argument: "confirmationText",
        passthrough_fields: ["session"]
      },
      trust_zone: "internal",
      input_description: "record_id、decision 和 note 描述待确认审批",
      failure_policy: "human-fallback"
    }],
    ...overrides
  };
}

async function compiledApproval(handler, { pendingActionTtlMs } = {}) {
  const calls = [];
  const pack = approvalPack();
  const servers = await resolvePrivateCapabilityServers({
    packs: [pack],
    resolveServer: async () => ({
      async listTools() {
        return {
          tools: [
            {
              name: "approval.prepare",
              annotations: { readOnlyHint: false, destructiveHint: false }
            },
            {
              name: "approval.confirm",
              annotations: { readOnlyHint: false, destructiveHint: true }
            }
          ]
        };
      },
      async callTool(request) {
        calls.push(structuredClone(request));
        return handler(request);
      }
    })
  });
  return {
    calls,
    gateway: new CapabilityActionGateway({
      ...compilePrivateCapabilityPacks({
        packs: [pack],
        servers
      }),
      ...(pendingActionTtlMs === undefined ? {} : { pendingActionTtlMs })
    })
  };
}

test("私有 MCP 审批能力准备后只暴露摘要并由可信状态持有确认材料", async () => {
  const { calls, gateway } = await compiledApproval((request) => {
    if (request.name === "approval.prepare") {
      return {
        content: [{ type: "text", text: "prepared" }],
        structuredContent: {
          ok: true,
          requiresUserConfirmation: true,
          confirmationToken: PRIVATE_PROOF,
          confirmationPhrase: "确认审批",
          summary: {
            subject: "合成审批",
            actionLabel: "同意",
            note: "同意"
          },
          nextStep: "call approval.confirm"
        }
      };
    }
    return {
      content: [{ type: "text", text: "completed" }],
      structuredContent: { ok: true, status: "approved" }
    };
  });

  assert.deepEqual(gateway.snapshot(), [{
    capability: "example.approval.execute",
    purpose: "准备并确认合成审批",
    operations: ["prepare"],
    risk: "approval",
    trust_zone: "internal",
    readiness: "ready",
    input_description: "record_id、decision 和 note 描述待确认审批"
  }]);

  const prepared = await gateway.prepare({
    capability: "example.approval.execute",
    operation: "prepare",
    input: {
      record_id: "fixture-42",
      decision: "approve",
      note: "同意",
      session: "default"
    },
    reason: "准备合成审批"
  });

  assert.deepEqual(calls, [{
    name: "approval.prepare",
    arguments: {
      record_id: "fixture-42",
      decision: "approve",
      note: "同意",
      session: "default"
    }
  }]);
  assert.deepEqual(prepared.preview, {
    ok: true,
    requiresUserConfirmation: true,
    summary: {
      subject: "合成审批",
      actionLabel: "同意",
      note: "同意"
    }
  });
  assert.doesNotMatch(
    JSON.stringify(prepared.preview),
    /token|confirmationPhrase|确认审批|approval\.confirm/iu
  );
  assert.equal(prepared.status, "confirmation-required");
  assert.deepEqual(Object.keys(prepared.pending_action).sort(), [
    "action_id",
    "capability",
    "operation"
  ]);
  assert.doesNotMatch(JSON.stringify(prepared.pending_action), /token|approval\.confirm/iu);

  const completed = await gateway.confirm({ action_id: prepared.pending_action.action_id });
  assert.deepEqual(calls[1], {
    name: "approval.confirm",
    arguments: {
      confirmationToken: PRIVATE_PROOF,
      confirmationText: "确认审批",
      session: "default"
    }
  });
  assert.deepEqual(completed, {
    capability: "example.approval.execute",
    operation: "prepare",
    status: "complete",
    data: { ok: true, status: "approved" },
    source_refs: []
  });
});

test("审批能力拒绝错误工具风险、未知输入和伪造待确认动作", async () => {
  const invalid = approvalPack();
  invalid.tools[1].risk = "read";
  assert.throws(() => validatePrivateCapabilityPack(invalid), /confirm tool must declare write risk/u);

  let calls = 0;
  const { gateway } = await compiledApproval(() => {
    calls += 1;
    return { structuredContent: { ok: true } };
  });
  assert.equal((await gateway.prepare({
    capability: "example.approval.execute",
    operation: "prepare",
    input: { record_id: "fixture-42", decision: "approve", note: "同意", tool: "evil" },
    reason: "尝试注入工具"
  })).status, "invalid-input");
  assert.equal((await gateway.confirm({
    capability: "example.approval.execute",
    operation: "prepare",
    action_id: "forged"
  })).status, "invalid-input");
  assert.equal(calls, 0);
});

test("拒绝审批会立即丢弃仅驻留内存的确认材料", async () => {
  const { gateway } = await compiledApproval((request) => request.name === "approval.prepare"
    ? {
        structuredContent: {
          requiresUserConfirmation: true,
          confirmationToken: PRIVATE_PROOF,
          confirmationPhrase: "确认审批",
          summary: { subject: "合成审批" }
        }
      }
    : { structuredContent: { ok: true } });
  const prepared = await gateway.prepare({
    capability: "example.approval.execute",
    operation: "prepare",
    input: { record_id: "fixture-42", decision: "approve", note: "同意" },
    reason: "准备审批"
  });

  assert.equal(gateway.cancel({ action_id: prepared.pending_action.action_id }), true);
  assert.equal((await gateway.confirm({
    action_id: prepared.pending_action.action_id
  })).status, "invalid-input");
});

test("待确认动作到期后自动丢弃且不能提交", async () => {
  let confirmCalls = 0;
  const { gateway } = await compiledApproval((request) => {
    if (request.name === "approval.prepare") {
      return {
        structuredContent: {
          requiresUserConfirmation: true,
          confirmationToken: PRIVATE_PROOF,
          confirmationPhrase: "确认审批",
          summary: { subject: "合成审批" }
        }
      };
    }
    confirmCalls += 1;
    return { structuredContent: { ok: true } };
  }, { pendingActionTtlMs: 10 });
  const prepared = await gateway.prepare({
    capability: "example.approval.execute",
    operation: "prepare",
    input: { record_id: "fixture-42", decision: "approve", note: "同意" },
    reason: "准备审批"
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await gateway.confirm({
    action_id: prepared.pending_action.action_id
  })).status, "invalid-input");
  assert.equal(confirmCalls, 0);
});

test("审批工具和语义标识不能跨能力包重复映射", () => {
  const first = approvalPack();
  const duplicateTool = approvalPack({
    pack_id: "example.approval.second",
    actions: [{
      ...approvalPack().actions[0],
      capability: "example.approval.second.execute",
      confirm_tool: "approval.second.confirm"
    }],
    tools: [
      { name: "approval.prepare", risk: "prepare" },
      { name: "approval.second.confirm", risk: "write" }
    ]
  });
  assert.throws(
    () => compilePrivateCapabilityPacks({ packs: [first, duplicateTool] }),
    /each server tool must map to exactly one semantic capability operation/u
  );

  const duplicateSemantic = approvalPack({
    capabilities: [{
      capability: "example.approval.execute",
      purpose: "读取合成审批",
      operations: [{
        operation: "get",
        tool: "approval.read",
        input_constraints: {
          allowed_fields: ["record_id"],
          required_fields: ["record_id"],
          max_bytes: 1024
        }
      }],
      risk: "read",
      trust_zone: "internal",
      input_description: "record_id",
      failure_policy: "human-fallback"
    }],
    tools: [
      { name: "approval.read", risk: "read" },
      { name: "approval.prepare", risk: "prepare" },
      { name: "approval.confirm", risk: "write" }
    ]
  });
  assert.throws(
    () => compilePrivateCapabilityPacks({ packs: [duplicateSemantic] }),
    /semantic action capability identifiers must be unique/u
  );
});

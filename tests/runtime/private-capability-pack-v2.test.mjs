import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CapabilityGateway } from "../../runtime/src/capability-gateway.mjs";
import {
  compilePrivateCapabilityPacks,
  resolvePrivateCapabilityServers,
  validatePrivateCapabilityPack
} from "../../runtime/src/private-capability-pack.mjs";

function privatePack(overrides = {}) {
  return {
    schema_version: 1,
    pack_id: "example.records",
    pack_version: "1.0.0",
    server_ref: "example-managed-records",
    tools: [{ name: "records.get", risk: "read" }],
    capabilities: [{
      capability: "example.records.read",
      purpose: "读取合成业务记录",
      operations: [{
        operation: "get",
        tool: "records.get",
        input_constraints: {
          allowed_fields: ["record_id"],
          required_fields: ["record_id"],
          max_bytes: 1024
        }
      }],
      risk: "read",
      trust_zone: "internal",
      input_description: "record_id 是合成记录标识",
      failure_policy: "human-fallback"
    }],
    ...overrides
  };
}

function readOnlyServer(server, toolNames = ["records.get"]) {
  return {
    ...server,
    async listTools() {
      return {
        tools: toolNames.map((name) => ({
          name,
          annotations: { readOnlyHint: true }
        }))
      };
    }
  };
}

async function compileWithResolvedServers({ packs, servers }) {
  return compilePrivateCapabilityPacks({
    packs,
    servers: await resolvePrivateCapabilityServers({
      packs,
      resolveServer: async (serverRef) => servers.get(serverRef)
    })
  });
}

test("声明式私有能力包只暴露语义能力并调用显式服务器的白名单工具", async () => {
  const calls = [];
  const compiled = await compileWithResolvedServers({
    packs: [privatePack()],
    servers: new Map([["example-managed-records", readOnlyServer({
      async callTool(request) {
        calls.push(structuredClone(request));
        return {
          status: "complete",
          data: { title: "合成记录", state: "pending" },
          source_refs: ["https://records.example.invalid/items/42"]
        };
      }
    })]])
  });
  const gateway = new CapabilityGateway(compiled);

  assert.deepEqual(gateway.snapshot(), [{
    capability: "example.records.read",
    purpose: "读取合成业务记录",
    operations: ["get"],
    risk: "read",
    trust_zone: "internal",
    readiness: "ready",
    input_description: "record_id 是合成记录标识"
  }]);

  const result = await gateway.lookup({
    capability: "example.records.read",
    operation: "get",
    input: { record_id: "fixture-42" },
    reason: "核实合成记录"
  });

  assert.deepEqual(calls, [{
    name: "records.get",
    arguments: { record_id: "fixture-42" }
  }]);
  assert.deepEqual(result, {
    capability: "example.records.read",
    operation: "get",
    status: "complete",
    data: { title: "合成记录", state: "pending" },
    source_refs: ["https://records.example.invalid/items/42"]
  });
  assert.doesNotMatch(
    JSON.stringify(gateway.snapshot()),
    /example-managed-records|records\.get|pack_id|server_ref/u
  );
});

test("私有能力包拒绝写风险、白名单外工具、可执行内容和凭据", () => {
  const invalidPacks = [
    {
      name: "write tool",
      mutate(pack) { pack.tools[0].risk = "write"; }
    },
    {
      name: "write capability",
      mutate(pack) { pack.capabilities[0].risk = "write"; }
    },
    {
      name: "write-like semantic operation",
      mutate(pack) { pack.capabilities[0].operations[0].operation = "delete"; }
    },
    {
      name: "tool outside allowlist",
      mutate(pack) { pack.capabilities[0].operations[0].tool = "records.delete"; }
    },
    {
      name: "duplicate tool mapping",
      mutate(pack) {
        pack.capabilities[0].operations.push({
          operation: "read",
          tool: "records.get",
          input_constraints: {
            allowed_fields: ["record_id"],
            required_fields: ["record_id"],
            max_bytes: 1024
          }
        });
      }
    },
    {
      name: "unbounded input description",
      mutate(pack) { pack.capabilities[0].input_description = "x".repeat(1025); }
    },
    {
      name: "executable content",
      mutate(pack) { pack.script = "run-private-code"; }
    },
    {
      name: "credentials",
      mutate(pack) { pack.credentials = { token: "fixture-private-token" }; }
    }
  ];

  for (const scenario of invalidPacks) {
    const pack = structuredClone(privatePack());
    scenario.mutate(pack);
    assert.throws(
      () => validatePrivateCapabilityPack(pack),
      TypeError,
      scenario.name
    );
  }
});

test("私有 MCP 工具缺少可信只读声明时在调用前失败关闭", async () => {
  for (const annotations of [undefined, {}, { readOnlyHint: false }, {
    readOnlyHint: true,
    destructiveHint: true
  }]) {
    let calls = 0;
    const pack = privatePack({
      tools: [{ name: "records.delete", risk: "read" }],
      capabilities: [{
        ...structuredClone(privatePack().capabilities[0]),
        operations: [{
          ...structuredClone(privatePack().capabilities[0].operations[0]),
          tool: "records.delete"
        }]
      }]
    });
    const servers = await resolvePrivateCapabilityServers({
      packs: [pack],
      resolveServer: async () => ({
        async listTools() {
          return { tools: [{ name: "records.delete", ...(annotations ? { annotations } : {}) }] };
        },
        async callTool() {
          calls += 1;
          return { status: "complete", data: { deleted: true }, source_refs: [] };
        }
      })
    });
    const gateway = new CapabilityGateway(compilePrivateCapabilityPacks({
      packs: [pack],
      servers
    }));

    assert.equal(gateway.snapshot()[0].readiness, "unavailable");
    assert.equal((await gateway.lookup({
      capability: "example.records.read",
      operation: "get",
      input: { record_id: "fixture-42" },
      reason: "验证只读硬门"
    })).status, "unavailable");
    assert.equal(calls, 0);
  }
});

test("通用 MCP Adapter 直接归一化标准 CallToolResult", async () => {
  const compiled = await compileWithResolvedServers({
    packs: [privatePack()],
    servers: new Map([["example-managed-records", readOnlyServer({
      async callTool() {
        return {
          content: [
            { type: "text", text: "等待负责人处理" },
            {
              type: "resource_link",
              name: "合成记录",
              uri: "https://records.example.invalid/items/42"
            }
          ],
          isError: false
        };
      }
    })]])
  });
  const gateway = new CapabilityGateway(compiled);

  assert.deepEqual(await gateway.lookup({
    capability: "example.records.read",
    operation: "get",
    input: { record_id: "fixture-42" },
    reason: "读取合成记录"
  }), {
    capability: "example.records.read",
    operation: "get",
    status: "complete",
    data: { content: "等待负责人处理" },
    source_refs: ["https://records.example.invalid/items/42"]
  });

  const failed = new CapabilityGateway(await compileWithResolvedServers({
    packs: [privatePack()],
    servers: new Map([["example-managed-records", readOnlyServer({
      async callTool() {
        return {
          content: [{ type: "text", text: "private failure body" }],
          isError: true
        };
      }
    })]])
  }));
  assert.equal((await failed.lookup({
    capability: "example.records.read",
    operation: "get",
    input: { record_id: "fixture-42" },
    reason: "验证错误投影"
  })).status, "failed");
});

test("公共中性能力包示例符合版本化声明契约", () => {
  const example = JSON.parse(readFileSync(
    path.resolve("examples/capability-pack.example.json"),
    "utf8"
  ));
  const schema = JSON.parse(readFileSync(
    path.resolve("runtime/schemas/capability-pack.schema.json"),
    "utf8"
  ));

  assert.deepEqual(validatePrivateCapabilityPack(example), example);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.properties.schema_version.const, 1);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.tools.items.properties.risk.const, "read");
  assert.equal(schema.properties.capabilities.items.properties.trust_zone.const, "internal");
  assert.equal(
    schema.properties.capabilities.items.properties.input_description.maxLength,
    1024
  );
  assert.equal(
    schema.properties.capabilities.items.properties.failure_policy.const,
    "human-fallback"
  );
  const keys = [];
  const pending = [example];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key.toLowerCase());
      pending.push(child);
    }
  }
  for (const forbidden of [
    "command",
    "credentials",
    "endpoint",
    "javascript",
    "keychain",
    "password",
    "script",
    "secret",
    "token"
  ]) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
});

test("未知工具和未允许输入在 MCP 调用前不可见且不可执行", async () => {
  const calls = [];
  const compiled = await compileWithResolvedServers({
    packs: [privatePack()],
    servers: new Map([["example-managed-records", {
      advertised_tools: ["records.get", "records.delete", "records.export"],
      async listTools() {
        return {
          tools: [
            { name: "records.get", annotations: { readOnlyHint: true } },
            { name: "records.delete", annotations: { readOnlyHint: false } },
            { name: "records.export" }
          ]
        };
      },
      async callTool(request) {
        calls.push(structuredClone(request));
        return { status: "complete", data: { ok: true }, source_refs: [] };
      }
    }]])
  });
  const gateway = new CapabilityGateway(compiled);

  const unknownOperation = await gateway.lookup({
    capability: "example.records.read",
    operation: "delete",
    input: { record_id: "fixture-42" },
    reason: "尝试写操作"
  });
  const injectedTool = await gateway.lookup({
    capability: "example.records.read",
    operation: "get",
    input: { record_id: "fixture-42", tool: "records.delete" },
    reason: "尝试选择未知工具"
  });
  const unknownCapability = await gateway.lookup({
    capability: "example.records.export",
    operation: "get",
    input: { record_id: "fixture-42" },
    reason: "尝试未知能力"
  });

  assert.equal(unknownOperation.status, "invalid-input");
  assert.equal(injectedTool.status, "invalid-input");
  assert.equal(unknownCapability.status, "unavailable");
  assert.deepEqual(calls, []);
  assert.deepEqual(gateway.snapshot()[0].operations, ["get"]);
  assert.doesNotMatch(JSON.stringify(gateway.snapshot()), /delete|export|advertised_tools/u);
});

test("MCP 缺失和失败使用稳定状态且不泄漏私有配置", async () => {
  const request = {
    capability: "example.records.read",
    operation: "get",
    input: { record_id: "fixture-42" },
    reason: "核实合成记录"
  };
  const unavailable = new CapabilityGateway(compilePrivateCapabilityPacks({
    packs: [privatePack()],
    servers: new Map()
  }));
  assert.equal(unavailable.snapshot()[0].readiness, "unavailable");
  assert.deepEqual(await unavailable.lookup(request), {
    capability: "example.records.read",
    operation: "get",
    status: "unavailable"
  });

  for (const status of [
    "denied",
    "unauthenticated",
    "unauthorized",
    "failed",
    "empty-result"
  ]) {
    const gateway = new CapabilityGateway(await compileWithResolvedServers({
      packs: [privatePack()],
      servers: new Map([["example-managed-records", readOnlyServer({
        async callTool() {
          return {
            status,
            data: { private_body: "must-not-pass" },
            source_refs: ["https://private.example.invalid/records/42"]
          };
        }
      })]])
    }));
    const result = await gateway.lookup(request);
    assert.deepEqual(result, {
      capability: "example.records.read",
      operation: "get",
      status
    });
    assert.doesNotMatch(JSON.stringify(result), /must-not-pass|private\.example/u);
  }

  const timedOut = new CapabilityGateway({
    ...await compileWithResolvedServers({
      packs: [privatePack()],
      servers: new Map([["example-managed-records", readOnlyServer({
        async callTool() { return new Promise(() => {}); }
      })]])
    }),
    timeoutMs: 5
  });
  assert.deepEqual(await timedOut.lookup(request), {
    capability: "example.records.read",
    operation: "get",
    status: "timeout"
  });

  const projected = new CapabilityGateway(await compileWithResolvedServers({
    packs: [privatePack()],
    servers: new Map([["example-managed-records", readOnlyServer({
      async callTool() {
        return {
          status: "complete",
          data: {
            title: "合成记录",
            server: "private-server",
            nested: {
              content: "可读内容",
              credential: "private-credential"
            }
          },
          source_refs: [
            "https://fixture-user:fixture-password@example.invalid/records/42?token=x#fragment"
          ]
          };
      }
    })]])
  }));
  assert.deepEqual(await projected.lookup(request), {
    capability: "example.records.read",
    operation: "get",
    status: "complete",
    data: {
      title: "合成记录",
      nested: { content: "可读内容" }
    },
    source_refs: ["https://example.invalid/records/42"]
  });
});

test("生产 resolver 只接收能力包显式声明的服务器引用", async () => {
  const secondPack = privatePack({
    pack_id: "example.archive",
    server_ref: "example-managed-archive",
    tools: [{ name: "archive.read", risk: "read" }],
    capabilities: [{
      capability: "example.archive.read",
      purpose: "读取合成归档",
      operations: [{
        operation: "read",
        tool: "archive.read",
        input_constraints: {
          allowed_fields: ["archive_id"],
          required_fields: ["archive_id"],
          max_bytes: 1024
        }
      }],
      risk: "read",
      trust_zone: "internal",
      input_description: "archive_id 是合成归档标识",
      failure_policy: "human-fallback"
    }]
  });
  const resolved = [];
  const servers = await resolvePrivateCapabilityServers({
    packs: [privatePack(), secondPack],
    resolveServer: async (serverRef) => {
      resolved.push(serverRef);
      if (serverRef === "example-managed-archive") return undefined;
      return readOnlyServer({
        async callTool() {
          return { status: "empty-result" };
        }
      });
    }
  });

  assert.deepEqual(resolved, [
    "example-managed-records",
    "example-managed-archive"
  ]);
  assert.deepEqual([...servers.keys()], ["example-managed-records"]);
  assert.equal(servers.has("unrelated-user-mcp"), false);
  const compiled = compilePrivateCapabilityPacks({
    packs: [privatePack(), secondPack],
    servers
  });
  assert.deepEqual(
    compiled.capabilities.map(({ capability, readiness }) => ({ capability, readiness })),
    [
      { capability: "example.records.read", readiness: "ready" },
      { capability: "example.archive.read", readiness: "unavailable" }
    ]
  );
});

test("同一服务器工具不能跨能力包映射到多个语义能力", () => {
  const duplicateMappingPack = privatePack({
    pack_id: "example.records-copy",
    capabilities: [{
      ...structuredClone(privatePack().capabilities[0]),
      capability: "example.records.copy"
    }]
  });

  assert.throws(() => compilePrivateCapabilityPacks({
    packs: [privatePack(), duplicateMappingPack],
    servers: new Map([["example-managed-records", {
      async callTool() { return { status: "empty-result" }; }
    }]])
  }), /exactly one semantic capability operation/u);
});

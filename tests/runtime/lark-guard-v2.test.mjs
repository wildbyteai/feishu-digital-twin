import assert from "node:assert/strict";
import test from "node:test";

import { LarkGuard, runLarkCommand } from "../../executor/src/lark-guard.mjs";

const larkBin = "/opt/homebrew/bin/lark-cli";

function guardWithRunner(runner) {
  return new LarkGuard({
    larkBin,
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: ["im", "task", "calendar", "docs", "base", "drive", "wiki"],
    runner
  });
}

test("lark-cli 子进程不会继承模型与宿主密钥", async () => {
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    LARK_APP_SECRET: process.env.LARK_APP_SECRET,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN
  };
  process.env.OPENAI_API_KEY = "model-secret";
  process.env.LARK_APP_SECRET = "lark-secret";
  process.env.GITHUB_TOKEN = "host-secret";
  try {
    const result = await runLarkCommand(["/usr/bin/env"]);
    assert.equal(result.exit_code, 0);
    assert.doesNotMatch(result.stdout, /OPENAI_API_KEY|LARK_APP_SECRET|GITHUB_TOKEN/u);
    assert.match(result.stdout, /^HOME=/mu);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("通用 Guard 只接受可信运行时选择的身份，并补充固定 profile、JSON 和 dry-run", () => {
  const guard = guardWithRunner(async () => {
    throw new Error("not called");
  });
  const userPlan = guard.plan({
    argv: ["task", "+create", "--summary", "跟进项目"]
  }, {
    productionEnabled: true,
    frozen: false
  });

  assert.deepEqual(userPlan.preview_argv, [
    larkBin,
    "--profile",
    "example_profile",
    "task",
    "+create",
    "--summary",
    "跟进项目",
    "--as",
    "user",
    "--format",
    "json",
    "--dry-run"
  ]);
  assert.deepEqual(userPlan.execute_argv, userPlan.preview_argv.slice(0, -1));
  assert.match(userPlan.command_hash, /^[a-f0-9]{64}$/u);

  const botPlan = guard.plan({
    argv: ["im", "+messages-reply", "--message-id", "om_x", "--text", "🤖【数字分身】我来处理"]
  }, {
    productionEnabled: true,
    frozen: false,
    identity: "bot"
  });
  assert.equal(botPlan.execute_argv[botPlan.execute_argv.indexOf("--as") + 1], "bot");
  assert.throws(() => guard.plan({
    argv: ["task", "+create", "--summary", "跟进项目"]
  }, {
    productionEnabled: true,
    frozen: false,
    identity: "unknown"
  }));
  assert.throws(() => guard.plan({
    argv: ["task", "+create", "--summary", "跟进项目"]
  }, {
    productionEnabled: true,
    frozen: false,
    identity: "bot"
  }), /Bot identity is limited to message replies/u);
});

test("Guard 拒绝认证、raw API、事件管理、预置确认参数和所有权转让", () => {
  const guard = guardWithRunner(async () => ({ exit_code: 0, stdout: "{}", stderr: "" }));
  const blocked = [
    ["auth", "status"],
    ["api", "GET", "/open-apis/im/v1/messages"],
    ["event", "consume", "im.message.receive_v1"],
    ["task", "+create", "--yes"],
    ["task", "+create", "--dry-run"],
    ["task", "+create", "--as", "bot"],
    ["drive", "permission.members", "transfer_owner"],
    ["im", "chats", "update", "--data", "{\"owner_id\":\"ou_x\"}"]
  ];

  for (const argv of blocked) {
    assert.throws(() => guard.plan({ argv }, {
      productionEnabled: true,
      frozen: false
    }));
  }
});

test("AI 公开 send/reply 由 Guard 自动注入统一助理标识", () => {
  const guard = guardWithRunner(async () => ({ exit_code: 0, stdout: "{}", stderr: "" }));
  const reply = guard.plan({
    argv: ["im", "+messages-reply", "--message-id", "om_x", "--text", "我来处理"]
  }, { productionEnabled: true, frozen: false });
  assert.equal(
    reply.execute_argv[reply.execute_argv.indexOf("--text") + 1],
    "🤖 AI助理：我来处理"
  );

  const send = guard.plan({
    argv: ["im", "+messages-send", "--chat-id", "oc_x", "--markdown", "进度已更新"]
  }, { productionEnabled: true, frozen: false });
  assert.equal(
    send.execute_argv[send.execute_argv.indexOf("--markdown") + 1],
    "🤖 AI助理：进度已更新"
  );
});

test("Guard 收到当前助理标识时不会在真实执行链路再次添加", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    return {
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, data: {} }),
      stderr: ""
    };
  });
  const result = await guard.execute({
    argv: [
      "im",
      "+messages-reply",
      "--message-id",
      "om_x",
      "--text",
      "🤖 AI助理：我来处理"
    ]
  }, { productionEnabled: true, frozen: false });

  assert.equal(result.status, "complete");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1][calls[1].indexOf("--text") + 1],
    "🤖 AI助理：我来处理"
  );
});

test("Guard 把错误主体和重复权威标签归一化为一个可信标签", () => {
  const guard = guardWithRunner(async () => ({ exit_code: 0, stdout: "{}", stderr: "" }));
  const plan = guard.plan({
    argv: [
      "im",
      "+messages-reply",
      "--message-id",
      "om_x",
      "--text",
      "🤖【待错误主体确认】🤖 【数字分身】请确认调整日期。"
    ]
  }, { productionEnabled: true, frozen: false });

  assert.equal(
    plan.execute_argv[plan.execute_argv.indexOf("--text") + 1],
    "🤖 AI助理：请确认调整日期。"
  );
});

test("Guard 在 text content JSON 内注入标签而不破坏消息载荷", () => {
  const guard = guardWithRunner(async () => ({ exit_code: 0, stdout: "{}", stderr: "" }));
  const plan = guard.plan({
    argv: [
      "im",
      "+messages-send",
      "--user-id",
      "ou_member",
      "--content",
      JSON.stringify({ text: "🤖【建议】🤖【建议】先核对库存。" })
    ]
  }, { productionEnabled: true, frozen: false });

  assert.deepEqual(
    JSON.parse(plan.execute_argv[plan.execute_argv.indexOf("--content") + 1]),
    { text: "🤖 AI助理：先核对库存。" }
  );
});

test("AI 不能修改自己的飞书控制台", () => {
  const guard = new LarkGuard({
    larkBin,
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: ["base"],
    protectedValues: ["base_control", "运行配置"],
    runner: async () => ({ exit_code: 0, stdout: "{}", stderr: "" })
  });
  const attempts = [
    ["base", "+record-upsert", "--base-token", "base_control", "--table-id", "运行配置", "--json", "{}"],
    ["base", "+record-upsert", "--base-token=base_control", "--table-id=运行配置", "--json", "{}"],
    ["base", "+record-upsert", "--json", JSON.stringify({ base_token: "base_control", table_id: "运行配置" })]
  ];
  for (const argv of attempts) {
    assert.throws(() => guard.plan({ argv }, { productionEnabled: true, frozen: false }));
  }
});

test("日报可以把受保护文件夹作为只读范围或新文档父级，但不能修改文件夹本身", () => {
  const guard = new LarkGuard({
    larkBin,
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: ["drive", "docs"],
    protectedValues: ["fld_daily_memory"],
    runner: async () => ({ exit_code: 0, stdout: "{}", stderr: "" })
  });

  assert.doesNotThrow(() => guard.plan({
    argv: [
      "drive",
      "+search",
      "--query",
      "2026-07-23 示例负责人每日工作记忆",
      "--folder-tokens",
      "fld_daily_memory"
    ]
  }, { productionEnabled: true, frozen: false }));
  assert.doesNotThrow(() => guard.plan({
    argv: [
      "docs",
      "+create",
      "--parent-token",
      "fld_daily_memory",
      "--content",
      "<title>2026-07-23 示例负责人每日工作记忆</title><p>内容</p>"
    ]
  }, { productionEnabled: true, frozen: false }));
  assert.throws(() => guard.plan({
    argv: ["drive", "+delete", "--token", "fld_daily_memory", "--type", "folder"]
  }, { productionEnabled: true, frozen: false }), /control resources/u);
});

test("Guard 使用官方 dry-run 和 exit 10 协议，不维护自建风险表", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    if (argv.includes("--dry-run")) {
      return {
        exit_code: 0,
        stdout: JSON.stringify({ ok: true, data: { request: "preview" } }),
        stderr: ""
      };
    }
    return {
      exit_code: 10,
      stdout: "",
      stderr: JSON.stringify({
        ok: false,
        error: {
          type: "confirmation_required",
          risk: { level: "high-risk-write", action: "drive +delete" }
        }
      })
    };
  });

  const result = await guard.execute({
    argv: ["drive", "+delete", "--token", "file_x", "--type", "file"]
  }, {
    productionEnabled: true,
    frozen: false,
    confirmed: false
  });

  assert.equal(result.status, "confirmation-required");
  assert.equal(result.risk.action, "drive +delete");
  assert.deepEqual(result.preview, { request: "preview" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].includes("--yes"), false);
});

test("官方 dry-run effect 表明所有权变化时 Guard 失败关闭", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    return {
      exit_code: 0,
      stdout: JSON.stringify({
        ok: true,
        dry_run: true,
        data: {
          effects: [{ type: "ownership_transfer", target: "docx" }]
        }
      }),
      stderr: ""
    };
  });

  const result = await guard.execute({
    argv: ["drive", "+opaque-permission-change", "--token", "doc_x"]
  }, {
    productionEnabled: true,
    frozen: false
  });

  assert.equal(result.status, "failed");
  assert.equal(result.phase, "preview");
  assert.equal(result.error_type, "ownership_transfer_forbidden");
  assert.equal(calls.length, 1);
});

test("官方 dry-run 暴露未归类的 owner 写入时 Guard 仍失败关闭", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    return {
      exit_code: 0,
      stdout: JSON.stringify({
        ok: true,
        dry_run: true,
        data: {
          api: [{
            method: "PATCH",
            url: "/open-apis/im/v1/chats/oc_x",
            body: { owner_id: "ou_new_owner" }
          }]
        }
      }),
      stderr: ""
    };
  });

  const result = await guard.execute({
    argv: ["im", "+opaque-chat-change", "--chat-id", "oc_x"]
  }, {
    productionEnabled: true,
    frozen: false
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error_type, "ownership_transfer_forbidden");
  assert.equal(calls.length, 1);
});

test("普通 owner 元数据和文本不会被误判为所有权转让", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    if (argv.includes("--dry-run")) {
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          dry_run: true,
          data: {
            effects: [{ type: "permission_update", owner: { name: "示例负责人" } }],
            api: [{
              method: "PATCH",
              url: "/open-apis/docx/v1/documents/doc_x",
              body: { title: "Owner handbook" }
            }]
          }
        }),
        stderr: ""
      };
    }
    return {
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, data: { document_id: "doc_x" } }),
      stderr: ""
    };
  });

  const result = await guard.execute({
    argv: ["docs", "+update", "--document-id", "doc_x", "--title", "Owner handbook"]
  }, {
    productionEnabled: true,
    frozen: false
  });

  assert.equal(result.status, "complete");
  assert.equal(calls.length, 2);
});

test("Guard 接受官方 shortcut 的 Dry Run 预览格式", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    if (argv.includes("--dry-run")) {
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          api: [{ method: "POST", url: "/open-apis/im/v1/messages/om_x/reply" }],
          message_id: "om_x"
        }, null, 2),
        stderr: "=== Dry Run ===\n"
      };
    }
    return {
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, data: { message_id: "om_reply" } }),
      stderr: ""
    };
  });

  const result = await guard.execute({
    argv: [
      "im",
      "+messages-reply",
      "--message-id",
      "om_x",
      "--text",
      "🤖【数字分身】验收通过。"
    ]
  }, {
    productionEnabled: true,
    frozen: false,
    confirmed: false
  });

  assert.equal(result.status, "complete");
  assert.equal(calls.length, 2);
});

test("只有已确认请求才由 Guard 追加 --yes", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    return {
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, data: { done: true } }),
      stderr: ""
    };
  });

  const result = await guard.execute({
    argv: ["drive", "+delete", "--token", "file_x", "--type", "file"]
  }, {
    productionEnabled: true,
    frozen: false,
    confirmed: true
  });

  assert.equal(result.status, "complete");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at(-1), "--yes");
});

test("生产门关闭时只执行官方 dry-run", async () => {
  const calls = [];
  const guard = guardWithRunner(async (argv) => {
    calls.push(argv);
    return {
      exit_code: 0,
      stdout: JSON.stringify({ ok: true, data: { request: "preview" } }),
      stderr: ""
    };
  });

  const result = await guard.execute({
    argv: ["task", "+create", "--summary", "跟进"]
  }, {
    productionEnabled: false,
    frozen: false,
    confirmed: false
  });

  assert.equal(result.status, "preview-only");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("--dry-run"), true);
});

test("退出码为零但缺少官方 ok:true 信封时不得视为成功", async () => {
  const guard = guardWithRunner(async () => ({ exit_code: 0, stdout: "{}", stderr: "" }));
  const result = await guard.execute({
    argv: ["task", "+create", "--summary", "跟进"]
  }, {
    productionEnabled: true,
    frozen: false,
    confirmed: false
  });
  assert.equal(result.status, "failed");
  assert.equal(result.phase, "preview");
  assert.equal(result.error_type, "invalid_envelope");
});

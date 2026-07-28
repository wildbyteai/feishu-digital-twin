import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCodexDecision } from "../../runtime/src/codex-runner.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakeCodex = path.join(projectRoot, "tests/fixtures/bin/codex");

function installLarkSkill(isolationRoot) {
  let skillDirectory = path.join(isolationRoot, "home");
  mkdirSync(skillDirectory, { mode: 0o700 });
  for (const segment of [".agents", "skills", "lark-shared"]) {
    skillDirectory = path.join(skillDirectory, segment);
    mkdirSync(skillDirectory, { mode: 0o700 });
  }
  writeFileSync(path.join(skillDirectory, "SKILL.md"), "---\nname: lark-shared\ndescription: test\n---\n");
}

function writeResidueCodex(filename, { exitCode = 0 } = {}) {
  writeFileSync(filename, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
for (const directory of [process.env.HOME, process.env.TMPDIR, process.cwd()]) {
  writeFileSync(path.join(directory, "prompt-canary.txt"), prompt);
}
if (${exitCode} !== 0) process.exit(${exitCode});
const eventId = [...prompt.matchAll(/"event_id"\\s*:\\s*"([^"]+)"/gu)].at(-1)?.[1];
const messageId = [...prompt.matchAll(/"message_id"\\s*:\\s*"([^"]+)"/gu)].at(-1)?.[1];
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    type: "agent_message",
    text: JSON.stringify({
      event_id: eventId,
      outcome: "ignore",
      reason: "synthetic",
      response: null,
      commands: [],
      source_refs: [messageId]
    })
  }
}) + "\\n");
`, { mode: 0o700 });
  chmodSync(filename, 0o700);
}

function transientEntries(isolationRoot) {
  return readdirSync(isolationRoot).filter((entry) =>
    entry === "tmp" || entry === "workspace" || entry.startsWith(".run-")
  );
}

test("Codex 使用官方 ephemeral、read-only 和 output-schema 运行项目 Skill", async () => {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-v2-"));
  const previous = process.env.GENERIC_API_TOKEN;
  process.env.GENERIC_API_TOKEN = "must-not-leak";
  try {
    installLarkSkill(isolationRoot);
    const decision = await runCodexDecision({
      event_id: "evt_codex",
      message_id: "om_codex",
      text: "请确认是否继续"
    }, {
      codexBin: fakeCodex,
      isolationRoot,
      timeoutMs: 5000,
      promptContext: { config: { principal: { name: "示例负责人" } } }
    });
    assert.equal(decision.outcome, "reply");
    assert.equal(decision.response.text, "可以继续推进。");
  } finally {
    if (previous === undefined) delete process.env.GENERIC_API_TOKEN;
    else process.env.GENERIC_API_TOKEN = previous;
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

test("公共 Web Search 使用不含 Skill 的隔离会话且必须实际调用搜索", async () => {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), "twin-public-search-runtime-"));
  try {
    installLarkSkill(isolationRoot);
    const decision = await runCodexDecision({
      event_id: "evt_public_web_search",
      source: "system",
      message_id: "om_public_web_search",
      text: "approved public Web Search query"
    }, {
      codexBin: fakeCodex,
      isolationRoot,
      timeoutMs: 5000,
      publicSearchQuery: "OpenAI Codex CLI 最新稳定版本"
    });

    assert.equal(decision.outcome, "reply");
    assert.equal(decision.response.mode, "suggestion");
    assert.deepEqual(decision.source_refs, ["https://developers.example.invalid/codex"]);
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

test("隔离运行环境未安装官方 lark Skills 时拒绝启动", async () => {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-no-lark-skills-"));
  try {
    await assert.rejects(async () => runCodexDecision({
        event_id: "evt_codex",
        message_id: "om_codex",
        text: "请确认是否继续"
      }, {
        codexBin: fakeCodex,
        isolationRoot,
        timeoutMs: 5000
      }), /official lark Skills are not installed/u);
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

test("运行器不解析 Codex 自己管理的官方登录或自定义 Provider 配置", async () => {
  for (const configBody of [
    'model_provider = "openai"\n',
    'forced_login_method = "chatgpt"\n',
    'model_provider = "company-gateway"\n'
  ]) {
    const isolationRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-provider-neutral-"));
    try {
      installLarkSkill(isolationRoot);
      const codexHome = path.join(isolationRoot, "codex-home");
      mkdirSync(codexHome, { mode: 0o700 });
      writeFileSync(path.join(codexHome, "config.toml"), configBody, { mode: 0o600 });

      const decision = await runCodexDecision({
        event_id: "evt_codex",
        message_id: "om_codex",
        text: "合成测试消息"
      }, {
        codexBin: fakeCodex,
        isolationRoot,
        timeoutMs: 5000
      });
      assert.equal(decision.event_id, "evt_codex");
    } finally {
      rmSync(isolationRoot, { recursive: true, force: true });
    }
  }
});

test("每次 Codex 推理使用一次性 HOME、临时目录和工作目录并在成功后清理", async () => {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-private-run-"));
  const codexBin = path.join(isolationRoot, "codex-residue.mjs");
  try {
    installLarkSkill(isolationRoot);
    writeResidueCodex(codexBin);

    const decision = await runCodexDecision({
      event_id: "evt_private_run",
      message_id: "om_private_run",
      text: "PRIVATE-PROMPT-CANARY"
    }, {
      codexBin,
      isolationRoot,
      timeoutMs: 5000
    });

    assert.equal(decision.event_id, "evt_private_run");
    assert.deepEqual(transientEntries(isolationRoot), []);
    assert.deepEqual(readdirSync(path.join(isolationRoot, "home")), [".agents"]);
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

test("Codex 进程失败时仍清理包含提示正文的一次性目录", async () => {
  const isolationRoot = mkdtempSync(path.join(tmpdir(), "twin-codex-failed-run-"));
  const codexBin = path.join(isolationRoot, "codex-residue-failure.mjs");
  try {
    installLarkSkill(isolationRoot);
    writeResidueCodex(codexBin, { exitCode: 7 });

    await assert.rejects(() => runCodexDecision({
      event_id: "evt_failed_private_run",
      message_id: "om_failed_private_run",
      text: "PRIVATE-FAILURE-CANARY"
    }, {
      codexBin,
      isolationRoot,
      timeoutMs: 5000
    }), /Codex exited with code 7/u);

    assert.deepEqual(transientEntries(isolationRoot), []);
    assert.deepEqual(readdirSync(path.join(isolationRoot, "home")), [".agents"]);
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

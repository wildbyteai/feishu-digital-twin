import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LarkGuard } from "../../executor/src/lark-guard.mjs";
import { projectDailyMemorySearchResult } from "../../runtime/src/daily-memory-privacy.mjs";
import { RuntimeState } from "../../runtime/src/runtime-state.mjs";
import { TwinService } from "../../runtime/src/service.mjs";

const EXCLUDED_CHAT_ID = "oc_privacy_canary_excluded_chat";
const EXCLUDED_CHAT_BODY = "privacy-canary-excluded-chat-body";
const EXCLUDED_TOPIC = "omt_privacy_canary_excluded_topic";
const EXCLUDED_TOPIC_BODY = "privacy-canary-excluded-topic-body";
const MISSING_METADATA_BODY = "privacy-canary-missing-metadata-body";

function configuration() {
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
      folder_token: "fixture_daily_memory_folder",
      folder_name: "示例负责人数字分身-每日工作记忆",
      excluded_chat_ids: [EXCLUDED_CHAT_ID],
      excluded_topics: [EXCLUDED_TOPIC]
    },
    allowed_lark_domains: ["im", "task", "calendar", "docs", "drive"]
  };
}

test("可信日报的消息搜索结果在第二轮 Codex 前硬过滤排除群、排除主题和元数据缺口", async () => {
  const database = path.join(
    mkdtempSync(path.join(tmpdir(), "daily-memory-privacy-")),
    "state.sqlite"
  );
  const runtimeState = new RuntimeState(database);
  const title = "2026-07-23 示例负责人每日工作记忆";
  const documentToken = "fixture_daily_memory_document";
  const content = `<title>${title}</title><p>允许进入日报的工作更新。</p><h1>来源引用与数据缺口</h1><p>聊天存在 privacy_metadata_unavailable；任务和日程无可确认内容。</p>`;
  const runner = async (argv) => {
    if (argv.includes("--dry-run")) {
      return { exit_code: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    }
    if (argv.includes("+messages-search")) {
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            messages: [
              {
                message_id: "om_allowed",
                chat_id: "oc_allowed",
                chat_type: "group",
                chat_name: "项目群",
                thread_id: "omt_allowed_topic",
                msg_type: "text",
                content: "allowed daily work update"
              },
              {
                message_id: "om_excluded_chat",
                chat_id: EXCLUDED_CHAT_ID,
                chat_type: "group",
                chat_name: "敏感群",
                thread_id: "omt_other_topic",
                msg_type: "text",
                content: EXCLUDED_CHAT_BODY
              },
              {
                message_id: "om_excluded_topic",
                chat_id: "oc_topic",
                chat_type: "group",
                chat_name: "项目群",
                thread_id: EXCLUDED_TOPIC,
                msg_type: "text",
                content: EXCLUDED_TOPIC_BODY
              },
              {
                message_id: "om_missing_chat",
                chat_type: "group",
                chat_name: "未知群",
                msg_type: "text",
                content: MISSING_METADATA_BODY
              }
            ],
            total: 4,
            has_more: true,
            page_token: "next_page"
          }
        }),
        stderr: ""
      };
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
        stdout: JSON.stringify({
          ok: true,
          data: { document: { document_id: documentToken } }
        }),
        stderr: ""
      };
    }
    if (argv.includes("+fetch")) {
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { document: { document_id: documentToken, content } }
        }),
        stderr: ""
      };
    }
    return assert.fail(`unexpected lark command: ${JSON.stringify(argv)}`);
  };

  const guard = new LarkGuard({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile",
    principalName: "示例负责人",
    allowedDomains: configuration().allowed_lark_domains,
    runner
  });
  let codexRuns = 0;
  try {
    const service = new TwinService({
      config: configuration(),
      state: runtimeState,
      guard,
      refreshProductionEnabled: async () => true,
      runCodex: async (input) => {
        codexRuns += 1;
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
            reason: "读取日报事实",
            commands: [
              {
                argv: [
                  "drive", "+search", "--query", title,
                  "--folder-tokens", "fixture_daily_memory_folder", "--doc-types", "docx", "--only-title"
                ],
                reason: "搜索同日日报",
                confirmation: "auto"
              },
              {
                argv: [
                  "im", "+messages-search",
                  "--start", "2026-07-23T00:00:00+08:00",
                  "--end", "2026-07-24T00:00:00+08:00",
                  "--page-size", "50", "--page-all", "--page-limit", "10", "--no-reactions"
                ],
                reason: "读取目标日消息",
                confirmation: "auto"
              }
            ]
          };
        }
        if (feedback.length === 2) {
          const encoded = JSON.stringify(feedback);
          assert.doesNotMatch(encoded, new RegExp([
            EXCLUDED_CHAT_ID,
            EXCLUDED_CHAT_BODY,
            EXCLUDED_TOPIC,
            EXCLUDED_TOPIC_BODY,
            MISSING_METADATA_BODY
          ].join("|"), "u"));
          const searchFeedback = feedback.find(
            (item) => item.command.operation === "+messages-search"
          );
          assert.deepEqual(searchFeedback.result.data.messages, [{
            message_id: "om_allowed",
            chat_id: "oc_allowed",
            chat_type: "group",
            chat_name: "项目群",
            thread_id: "omt_allowed_topic",
            msg_type: "text",
            content: "allowed daily work update"
          }]);
          assert.equal(searchFeedback.result.data.total, 1);
          assert.deepEqual(searchFeedback.result.data.privacy_gaps, [{
            code: "privacy_metadata_unavailable",
            count: 1
          }]);
          return {
            ...common,
            reason: "使用过滤后的事实创建日报",
            commands: [{
              argv: ["docs", "+create", "--parent-token", "fixture_daily_memory_folder", "--content", content],
              reason: "创建日报",
              confirmation: "auto"
            }]
          };
        }
        if (feedback.length === 3) {
          return {
            ...common,
            reason: "写后读取日报",
            commands: [{
              argv: ["docs", "+fetch", "--doc", documentToken],
              reason: "验证日报正文",
              confirmation: "auto"
            }]
          };
        }
        return {
          event_id: input.event_id,
          outcome: "ignore",
          reason: "日报已完成",
          response: null,
          commands: [],
          source_refs: [input.message_id]
        };
      }
    });

    await service.runDailyMemory("2026-07-23", {
      now: new Date("2026-07-24T00:10:00.000Z")
    });
    assert.equal(codexRuns, 4);
  } finally {
    runtimeState.close();
  }
});

test("消息记录内部的嵌套数组不能夹带排除群正文", () => {
  const result = projectDailyMemorySearchResult(
    { argv: ["im", "+messages-search"] },
    {
      status: "complete",
      data: {
        messages: [{
          message_id: "om_outer_allowed",
          chat_id: "oc_allowed",
          thread_id: "omt_allowed_topic",
          content: "outer allowed body",
          nested_messages: [[{
            message_id: "om_inner_excluded",
            chat_id: EXCLUDED_CHAT_ID,
            thread_id: "omt_other_topic",
            content: "privacy-canary-nested-excluded-body"
          }]]
        }],
        total: 1,
        has_more: false,
        page_token: ""
      }
    },
    {
      excludedChatIds: [EXCLUDED_CHAT_ID],
      excludedTopics: [EXCLUDED_TOPIC]
    }
  );

  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /oc_privacy_canary_excluded_chat|privacy-canary-nested-excluded-body/u);
  assert.equal(result.data.messages[0].content, "outer allowed body");
});

test("详情补取失败的 message_ids 降级结果不会把原始 ID 交给 Codex", () => {
  const result = projectDailyMemorySearchResult(
    { argv: ["im", "+messages-search"] },
    {
      status: "complete",
      data: {
        message_ids: ["om_private_one", "om_private_two"],
        total: 2,
        has_more: false,
        page_token: "",
        note: "failed to fetch message details, returning ID list only"
      }
    },
    {
      excludedChatIds: [EXCLUDED_CHAT_ID],
      excludedTopics: [EXCLUDED_TOPIC]
    }
  );

  assert.deepEqual(result.data, {
    messages: [],
    total: 0,
    has_more: false,
    page_token: "",
    privacy_gaps: [{ code: "privacy_metadata_unavailable", count: 2 }]
  });
  assert.doesNotMatch(JSON.stringify(result), /om_private_one|om_private_two/u);
});

test("自然语言排除主题在官方结果只有 thread_id 时失败关闭", () => {
  const result = projectDailyMemorySearchResult(
    { argv: ["im", "+messages-search"] },
    {
      status: "complete",
      data: {
        messages: [{
          message_id: "om_topic_metadata_unavailable",
          chat_id: "oc_allowed",
          thread_id: "omt_unrelated_thread",
          content: "privacy-canary-natural-topic-without-title"
        }],
        total: 1,
        has_more: false,
        page_token: ""
      }
    },
    { excludedChatIds: [], excludedTopics: ["薪酬"] }
  );

  assert.deepEqual(result.data, {
    messages: [],
    total: 0,
    has_more: false,
    page_token: "",
    privacy_gaps: [{ code: "privacy_metadata_unavailable", count: 1 }]
  });
  assert.doesNotMatch(JSON.stringify(result), /privacy-canary-natural-topic-without-title/u);
});

test("投影器不改变失败搜索、其他命令或没有排除配置的成功结果", () => {
  const failed = { status: "failed", error_type: "transport" };
  const other = { status: "complete", data: { document: { content: "unchanged" } } };
  const unconfigured = {
    status: "complete",
    data: { messages: [{ chat_id: EXCLUDED_CHAT_ID, content: EXCLUDED_CHAT_BODY }] }
  };

  assert.equal(projectDailyMemorySearchResult(
    { argv: ["im", "+messages-search"] },
    failed,
    { excludedChatIds: [EXCLUDED_CHAT_ID] }
  ), failed);
  assert.equal(projectDailyMemorySearchResult(
    { argv: ["docs", "+fetch"] },
    other,
    { excludedChatIds: [EXCLUDED_CHAT_ID] }
  ), other);
  assert.equal(projectDailyMemorySearchResult(
    { argv: ["im", "+messages-search"] },
    unconfigured,
    { excludedChatIds: [], excludedTopics: [] }
  ), unconfigured);
});

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { hydrateCandidate } from "../../intake/src/candidate-hydrator.mjs";
import { normalizeInboundMessage } from "../../intake/src/inbound-normalizer.mjs";
import { LarkImReader } from "../../intake/src/lark-im-reader.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakeLarkCli = path.join(projectRoot, "tests/fixtures/bin/lark-cli-read");
const principal = {
  open_id: "ou_simulated_principal",
  address_names: ["模拟负责人"]
};

test("文本消息正文直接交给 AI，代码只保留确定性寻址和来源元数据", () => {
  const normalized = normalizeInboundMessage({
    event_id: "evt_1",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    message_id: "om_1",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "text",
    content: "@模拟负责人 请看一下"
  }, { source: "event", principal });

  assert.equal(normalized.event.text, "@模拟负责人 请看一下");
  assert.equal(normalized.event.signals.direct_mention, true);
  assert.equal(normalized.event.signals.context_lookup_required, false);
  assert.deepEqual(normalized.event.context, []);
});

test("富文本和官方链接卡片投影有界可见文本与显式链接", () => {
  const richText = normalizeInboundMessage({
    event_id: "evt_rich",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    message_id: "om_rich",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title: "采购审批流程",
        content: [[
          { tag: "text", text: "请按新版流程处理" },
          { tag: "a", text: "查看流程", href: "https://example.invalid/workflow" }
        ]]
      }
    }),
    parent_id: "om_parent",
    root_id: "om_root",
    thread_id: "omt_workflow"
  }, { source: "event", principal });
  const linkCard = normalizeInboundMessage({
    chat_id: "oc_simulated_p2p",
    chat_type: "p2p",
    message_id: "om_link_card",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "share_link",
    content: JSON.stringify({
      title: "内部流程入口",
      url: "https://example.invalid/internal-flow"
    })
  }, { source: "supplement", principal });

  assert.equal(richText.event.text, "采购审批流程\n请按新版流程处理\n查看流程");
  assert.deepEqual(richText.event.links, ["https://example.invalid/workflow"]);
  assert.equal(richText.event.parent_message_id, "om_parent");
  assert.equal(richText.event.root_message_id, "om_root");
  assert.equal(richText.event.thread_id, "omt_workflow");
  assert.equal(linkCard.event.text, "内部流程入口");
  assert.deepEqual(linkCard.event.links, ["https://example.invalid/internal-flow"]);
  assert.equal(linkCard.event.link_only, true);
});

test("消息投影限制可见文本字节数和显式链接数量", () => {
  const normalized = normalizeInboundMessage({
    chat_id: "oc_bounded",
    chat_type: "p2p",
    message_id: "om_bounded",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title: "长正文",
        content: [[
          { tag: "text", text: "内容".repeat(10_000) },
          ...Array.from({ length: 20 }, (_, index) => ({
            tag: "a",
            text: `链接${index}`,
            href: `https://example.invalid/resource/${index}`
          }))
        ]]
      }
    })
  }, { source: "supplement", principal });

  assert.equal(Buffer.byteLength(normalized.event.text) <= 8 * 1024, true);
  assert.equal(normalized.event.links.length, 10);
});

test("当前官方载荷没有可读文本或链接时标记人工兜底", () => {
  const normalized = normalizeInboundMessage({
    chat_id: "oc_unreadable",
    chat_type: "p2p",
    message_id: "om_unreadable",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "interactive",
    content: "{\"unsupported\":true}"
  }, { source: "supplement", principal });

  assert.equal(normalized.event.text, "");
  assert.equal(normalized.event.signals.content_unreadable, true);
});

test("未明确寻址的普通群消息和单聊要求补读同会话上下文", () => {
  const group = normalizeInboundMessage({
    chat_id: "oc_simulated_group",
    chat_type: "group",
    message_id: "om_group_question",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "text",
    content: "帮我查一下今天的天气"
  }, { source: "supplement", principal });
  const p2p = normalizeInboundMessage({
    chat_id: "oc_simulated_p2p",
    chat_type: "p2p",
    message_id: "om_p2p_question",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "text",
    content: "帮我查一下今天的天气"
  }, { source: "supplement", principal });
  const image = normalizeInboundMessage({
    chat_id: "oc_simulated_group",
    chat_type: "group",
    message_id: "om_group_image",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    message_type: "image",
    content: "![Image](img_simulated)"
  }, { source: "supplement", principal });

  assert.equal(group.event.signals.context_lookup_required, true);
  assert.equal(p2p.event.signals.context_lookup_required, true);
  assert.equal(image.event.signals.context_lookup_required, false);
});

test("官方事件与用户补读使用同一消息幂等键", () => {
  const raw = {
    event_id: "evt_delivery",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    message_id: "om_same_message",
    sender_id: "ou_sender",
    create_time: "1784078400000",
    update_time: "1784078400000",
    message_type: "text",
    content: "同一条消息"
  };
  const realtime = normalizeInboundMessage(raw, { source: "event", principal });
  const { event_id: _deliveryId, ...supplementRaw } = raw;
  const supplement = normalizeInboundMessage(supplementRaw, {
    source: "supplement",
    principal
  });
  assert.equal(realtime.event.event_id, supplement.event.event_id);
  assert.equal(realtime.event.delivery_event_id, "evt_delivery");
});

test("回复改名前的历史消息仍识别为继续数字分身话题", async () => {
  const reader = new LarkImReader({
    larkBin: fakeLarkCli,
    profile: "example_profile",
    productionDataApproved: true
  });
  const hydrated = await hydrateCandidate({
    message_id: "om_current",
    chat_id: "oc_simulated_group",
    thread_id: "omt_simulated_thread",
    reply_to_message_id: "om_parent",
    signals: {},
    context: []
  }, { reader, principal });

  assert.equal(hydrated.signals.reply_to_twin, true);
  assert.equal(hydrated.context.length, 2);
});

test("回复和话题上下文保持原有的父消息加官方倒序排列", async () => {
  const reader = {
    async getMessages() {
      return {
        messages: [{
          message_id: "om_parent_order",
          chat_id: "oc_simulated_group",
          thread_id: "omt_order",
          create_time: "2026-07-16T09:00:00.000Z",
          content: "父消息",
          sender: { id: "ou_simulated_principal" }
        }]
      };
    },
    async listThread() {
      return {
        messages: [
          {
            message_id: "om_current_order",
            chat_id: "oc_simulated_group",
            thread_id: "omt_order",
            create_time: "2026-07-16T10:00:00.000Z",
            content: "当前消息",
            sender: { id: "ou_member" }
          },
          {
            message_id: "om_latest_order",
            chat_id: "oc_simulated_group",
            thread_id: "omt_order",
            create_time: "2026-07-16T09:59:00.000Z",
            content: "较新的话题消息",
            sender: { id: "ou_latest" }
          },
          {
            message_id: "om_older_order",
            chat_id: "oc_simulated_group",
            thread_id: "omt_order",
            create_time: "2026-07-16T09:58:00.000Z",
            content: "较早的话题消息",
            sender: { id: "ou_older" }
          }
        ]
      };
    }
  };

  const hydrated = await hydrateCandidate({
    message_id: "om_current_order",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "当前消息",
    thread_id: "omt_order",
    reply_to_message_id: "om_parent_order",
    signals: { context_lookup_required: true },
    context: []
  }, { reader, principal });

  assert.deepEqual(
    hydrated.context.map(({ message_id }) => message_id),
    ["om_parent_order", "om_latest_order", "om_older_order"]
  );
});

test("精确回复、父消息和根消息优先于话题上下文并保留引用关系", async () => {
  const reader = {
    async getMessages(ids) {
      assert.deepEqual(ids, ["om_replied", "om_parent", "om_root"]);
      return {
        messages: [
          {
            message_id: "om_root",
            chat_id: "oc_simulated_group",
            thread_id: "omt_context",
            create_time: "2026-07-16T08:58:00.000Z",
            content: "根消息",
            sender: { id: "ou_root" }
          },
          {
            message_id: "om_parent",
            chat_id: "oc_simulated_group",
            thread_id: "omt_context",
            create_time: "2026-07-16T08:59:00.000Z",
            content: "父消息",
            sender: { id: "ou_parent" }
          },
          {
            message_id: "om_replied",
            chat_id: "oc_simulated_group",
            thread_id: "omt_context",
            create_time: "2026-07-16T09:00:00.000Z",
            content: JSON.stringify({
              title: "内部流程",
              url: "https://example.invalid/workflow"
            }),
            message_type: "share_link",
            sender: { id: "ou_replied" }
          }
        ]
      };
    },
    async listThread() {
      return {
        messages: [{
          message_id: "om_thread_latest",
          chat_id: "oc_simulated_group",
          thread_id: "omt_context",
          create_time: "2026-07-16T09:59:00.000Z",
          content: "话题最新消息",
          sender: { id: "ou_latest" }
        }]
      };
    }
  };

  const hydrated = await hydrateCandidate({
    message_id: "om_current",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "请看一下这个流程",
    thread_id: "omt_context",
    root_message_id: "om_root",
    parent_message_id: "om_parent",
    reply_to_message_id: "om_replied",
    signals: { context_lookup_required: true },
    context: []
  }, { reader, principal });

  assert.deepEqual(
    hydrated.context.map(({ message_id, relation }) => ({ message_id, relation })),
    [
      { message_id: "om_replied", relation: "reply" },
      { message_id: "om_parent", relation: "parent" },
      { message_id: "om_root", relation: "root" },
      { message_id: "om_thread_latest", relation: "thread" }
    ]
  );
  assert.deepEqual(hydrated.context[0].links, ["https://example.invalid/workflow"]);
  assert.equal(hydrated.context[0].link_only, true);
  assert.equal(hydrated.context_meta.limit, 20);
});

test("单聊最近上下文按时间排序且只在本次处理使用", async () => {
  const calls = [];
  const hydrated = await hydrateCandidate({
    message_id: "om_p2p_current",
    chat_id: "oc_simulated_p2p",
    chat_type: "p2p",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "刚才那个流程怎么办？",
    thread_id: null,
    root_message_id: null,
    parent_message_id: null,
    reply_to_message_id: null,
    signals: { context_lookup_required: true },
    context: []
  }, {
    principal,
    reader: {
      async listMessages(options) {
        calls.push(options);
        return {
          messages: [
            {
              message_id: "om_p2p_newer",
              chat_id: "oc_simulated_p2p",
              create_time: "2026-07-16T09:59:00.000Z",
              content: "较新的单聊上下文",
              sender: { id: "ou_member" }
            },
            {
              message_id: "om_p2p_older",
              chat_id: "oc_simulated_p2p",
              create_time: "2026-07-16T09:58:00.000Z",
              content: "较早的单聊上下文",
              sender: { id: "ou_principal" }
            }
          ]
        };
      }
    }
  });

  assert.deepEqual(calls, [{
    chatId: "oc_simulated_p2p",
    end: "2026-07-16T10:00:00.000Z",
    order: "desc",
    pageSize: 20
  }]);
  assert.deepEqual(
    hydrated.context.map(({ message_id, relation }) => ({ message_id, relation })),
    [
      { message_id: "om_p2p_older", relation: "recent" },
      { message_id: "om_p2p_newer", relation: "recent" }
    ]
  );
  assert.equal(hydrated.context_meta.scope, "chat");
});

test("精确引用不可读时即使话题另有消息也标记确定性人工兜底", async () => {
  const hydrated = await hydrateCandidate({
    message_id: "om_unreadable_current",
    chat_id: "oc_simulated_p2p",
    chat_type: "p2p",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "请处理我回复的内容",
    thread_id: "omt_unreadable",
    root_message_id: null,
    parent_message_id: "om_unreadable_parent",
    reply_to_message_id: "om_unreadable_parent",
    signals: { context_lookup_required: true },
    context: []
  }, {
    principal,
    reader: {
      async getMessages() {
        return {
          messages: [{
            message_id: "om_unreadable_parent",
            chat_id: "oc_simulated_p2p",
            create_time: "2026-07-16T09:59:00.000Z",
            message_type: "interactive",
            content: "{\"unsupported\":true}",
            sender: { id: "ou_member" }
          }]
        };
      },
      async listThread() {
        return {
          messages: [{
            message_id: "om_other_thread_message",
            chat_id: "oc_simulated_p2p",
            thread_id: "omt_unreadable",
            create_time: "2026-07-16T09:58:00.000Z",
            content: "话题中的其他可读消息",
            sender: { id: "ou_other" }
          }]
        };
      }
    }
  });

  assert.deepEqual(
    hydrated.context.map(({ message_id, relation }) => ({ message_id, relation })),
    [{ message_id: "om_other_thread_message", relation: "thread" }]
  );
  assert.equal(hydrated.signals.context_unreadable, true);
  assert.deepEqual(hydrated.context_meta, {
    fetched: true,
    scope: "thread",
    count: 1,
    limit: 20
  });
});

test("当前消息可读但空话题不会误判为内容不可读", async () => {
  const hydrated = await hydrateCandidate({
    message_id: "om_empty_thread_current",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "这是完整问题",
    thread_id: "omt_empty",
    root_message_id: null,
    parent_message_id: null,
    reply_to_message_id: null,
    signals: { context_lookup_required: true },
    context: []
  }, {
    principal,
    reader: {
      async listThread() {
        return { messages: [] };
      }
    }
  });

  assert.equal(hydrated.signals.context_unreadable, undefined);
  assert.equal(hydrated.context_meta.count, 0);
});

test("普通群消息只补读当前消息之前的同群上下文并按时间排序", async () => {
  const calls = [];
  const reader = {
    async listMessages(options) {
      calls.push(options);
      return {
        messages: [
          {
            message_id: "om_future",
            chat_id: "oc_simulated_group",
            create_time: "2026-07-16T10:01:00.000Z",
            content: "未来消息",
            sender: { id: "ou_future" }
          },
          {
            message_id: "om_current",
            chat_id: "oc_simulated_group",
            create_time: "2026-07-16T10:00:00.000Z",
            content: "帮我查一下今天的天气",
            sender: { id: "ou_member" }
          },
          {
            message_id: "om_principal_context",
            chat_id: "oc_simulated_group",
            create_time: "2026-07-16T09:59:00.000Z",
            content: "我看看数字分身会不会自动回复",
            sender: { id: "ou_simulated_principal" }
          },
          {
            message_id: "om_other_chat",
            chat_id: "oc_other_group",
            create_time: "2026-07-16T09:58:30.000Z",
            content: "其他群正文",
            sender: { id: "ou_other" }
          },
          {
            message_id: "om_unknown_time",
            chat_id: "oc_simulated_group",
            content: "无法确认时间的消息",
            sender: { id: "ou_unknown" }
          },
          {
            message_id: "om_member_context",
            chat_id: "oc_simulated_group",
            create_time: "2026-07-16T09:58:00.000Z",
            content: "在这里聊一聊",
            sender: { id: "ou_member" }
          }
        ]
      };
    },
    async getMessages() {
      throw new Error("standalone group context must not batch-get a parent");
    },
    async listThread() {
      throw new Error("standalone group context must not read a thread");
    }
  };

  const hydrated = await hydrateCandidate({
    message_id: "om_current",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    sender_open_id: "ou_member",
    sent_at: "2026-07-16T10:00:00.000Z",
    message_type: "text",
    text: "帮我查一下今天的天气",
    thread_id: null,
    reply_to_message_id: null,
    signals: { direct_mention: false, context_lookup_required: true },
    context: []
  }, { reader, principal });

  assert.deepEqual(calls, [{
    chatId: "oc_simulated_group",
    end: "2026-07-16T10:00:00.000Z",
    order: "desc",
    pageSize: 20
  }]);
  assert.deepEqual(
    hydrated.context.map(({ message_id }) => message_id),
    ["om_member_context", "om_principal_context"]
  );
  assert.deepEqual(hydrated.context_meta, {
    fetched: true,
    scope: "chat",
    count: 2,
    limit: 20
  });
  assert.equal(JSON.stringify(hydrated).includes("其他群正文"), false);
  assert.equal(JSON.stringify(hydrated).includes("未来消息"), false);
  assert.equal(JSON.stringify(hydrated).includes("无法确认时间的消息"), false);
});

test("普通群消息缺少有效当前时间时拒绝读取无法界定先后的上下文", async () => {
  await assert.rejects(() => hydrateCandidate({
    message_id: "om_invalid_current_time",
    chat_id: "oc_simulated_group",
    chat_type: "group",
    sender_open_id: "ou_member",
    sent_at: "invalid-time",
    message_type: "text",
    text: "帮我看一下",
    thread_id: null,
    reply_to_message_id: null,
    signals: { direct_mention: false, context_lookup_required: true },
    context: []
  }, {
    principal,
    reader: {
      async listMessages() {
        throw new Error("must reject before reading messages");
      }
    }
  }), /requires a valid event\.sent_at/u);
});

test("用户身份补充读取只调用官方 IM shortcuts", async () => {
  const reader = new LarkImReader({
    larkBin: fakeLarkCli,
    profile: "example_profile",
    productionDataApproved: true
  });
  const chats = await reader.listChats();
  const chat = await reader.getChat({ chatId: "oc_simulated_group" });
  const messages = await reader.listMessages({
    chatId: "oc_simulated_group",
    start: "2026-07-16T09:55:00.000Z",
    end: "2026-07-16T10:00:00.000Z"
  });
  assert.equal(chats.chats.length, 2);
  assert.equal(chat.external, false);
  assert.equal(messages.messages[0].message_id, "om_simulated_incremental");
});

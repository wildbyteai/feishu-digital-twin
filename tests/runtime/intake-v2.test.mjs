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

test("消息正文直接交给 AI，代码只保留确定性寻址和来源元数据", () => {
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

test("未明确寻址的普通群消息要求补读同群上下文，私聊不额外补读", () => {
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
  assert.equal(p2p.event.signals.context_lookup_required, false);
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

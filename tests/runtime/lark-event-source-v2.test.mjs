import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOfficialEventCommand,
  officialEventToRawMessage
} from "../../intake/src/lark-event-source.mjs";

test("实时消息直接使用官方 lark-cli event，不再依赖 community bridge", () => {
  assert.deepEqual(buildOfficialEventCommand({
    larkBin: "/opt/homebrew/bin/lark-cli",
    profile: "example_profile"
  }), [
    "/opt/homebrew/bin/lark-cli",
    "--profile",
    "example_profile",
    "event",
    "consume",
    "im.message.receive_v1",
    "--as",
    "bot"
  ]);
});

test("官方扁平事件使用官方群资料补充内外部属性", () => {
  assert.deepEqual(officialEventToRawMessage({
    type: "im.message.receive_v1",
    event_id: "evt-1",
    chat_id: "oc_1",
    chat_type: "group",
    message_id: "om_1",
    sender_id: "ou_1",
    create_time: "1784167200000",
    timestamp: "1784167201000",
    message_type: "text",
    content: "负责人，请看一下"
  }, {
    external: true,
    tenant_key: "tenant_partner"
  }), {
    event_id: "evt-1",
    chat_id: "oc_1",
    chat_type: "group",
    message_id: "om_1",
    sender_id: "ou_1",
    create_time: "1784167200000",
    update_time: "1784167200000",
    message_type: "text",
    content: "负责人，请看一下",
    is_external: true,
    tenant_key: "tenant_partner"
  });
});

test("群事件官方群资料未标明内外部时保留未知状态而不默认当作内部群", () => {
  assert.deepEqual(officialEventToRawMessage({
    type: "im.message.receive_v1",
    event_id: "evt-unknown",
    chat_id: "oc_unknown",
    chat_type: "group",
    message_id: "om_unknown",
    sender_id: "ou_1",
    create_time: "1784167200000",
    message_type: "text",
    content: "请处理"
  }, {
    chat_id: "oc_unknown",
    chat_mode: "group"
  }), {
    event_id: "evt-unknown",
    chat_id: "oc_unknown",
    chat_type: "group",
    message_id: "om_unknown",
    sender_id: "ou_1",
    create_time: "1784167200000",
    update_time: "1784167200000",
    message_type: "text",
    content: "请处理",
    is_external: null,
    tenant_key: null
  });
});

test("官方群资料读取失败时允许用未知属性继续规范化 Bot 事件", () => {
  assert.deepEqual(officialEventToRawMessage({
    type: "im.message.receive_v1",
    event_id: "evt-metadata-failure",
    chat_id: "oc_unknown",
    chat_type: "group",
    message_id: "om_unknown",
    sender_id: "ou_1",
    create_time: "1784167200000",
    message_type: "text",
    content: "请处理"
  }), {
    event_id: "evt-metadata-failure",
    chat_id: "oc_unknown",
    chat_type: "group",
    message_id: "om_unknown",
    sender_id: "ou_1",
    create_time: "1784167200000",
    update_time: "1784167200000",
    message_type: "text",
    content: "请处理",
    is_external: null,
    tenant_key: null
  });
});

test("官方事件保留可用的回复、父消息、根消息、话题、更新时间和提及元数据", () => {
  assert.deepEqual(officialEventToRawMessage({
    type: "im.message.receive_v1",
    event_id: "evt-context",
    chat_id: "oc_context",
    chat_type: "group",
    message_id: "om_current",
    sender_id: "ou_member",
    create_time: "1784167200000",
    update_time: "1784167260000",
    message_type: "post",
    content: "{\"zh_cn\":{\"title\":\"审批流程\",\"content\":[[{\"tag\":\"a\",\"text\":\"查看流程\",\"href\":\"https://example.invalid/workflow\"}]]}}",
    reply_to_message_id: "om_replied",
    parent_id: "om_parent",
    root_id: "om_root",
    thread_id: "omt_context",
    mentions: [{ id: "ou_principal", name: "示例负责人" }]
  }), {
    event_id: "evt-context",
    chat_id: "oc_context",
    chat_type: "group",
    message_id: "om_current",
    sender_id: "ou_member",
    create_time: "1784167200000",
    update_time: "1784167260000",
    message_type: "post",
    content: "{\"zh_cn\":{\"title\":\"审批流程\",\"content\":[[{\"tag\":\"a\",\"text\":\"查看流程\",\"href\":\"https://example.invalid/workflow\"}]]}}",
    reply_to_message_id: "om_replied",
    parent_id: "om_parent",
    root_id: "om_root",
    thread_id: "omt_context",
    mentions: [{ id: "ou_principal", name: "示例负责人" }],
    is_external: null,
    tenant_key: null
  });
});

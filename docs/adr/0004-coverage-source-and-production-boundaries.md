---
status: accepted
---

# 覆盖、来源和生产边界

`lark-cli event consume im.message.receive_v1 --as bot` 提供实时事件，用户身份 `im +chat-list` 与 `+chat-messages-list` 定期补齐全部群和私聊。官方群资料提供内外部属性；所有工作群均按配置自动处理，群属性只作为语气、承诺和信息边界的上下文。聊天内容默认只在原群原话题使用。真实正文和自动写入分别受显式生产配置控制，未开启时不得静默执行。

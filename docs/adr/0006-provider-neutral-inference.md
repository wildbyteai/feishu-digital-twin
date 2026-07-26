---
status: accepted
date: 2026-07-24
---

# Codex CLI 是唯一推理 seam

公开产品不直接连接任何模型 HTTP API，也不识别 Codex CLI 内部使用官方登录、API Key、自定义模型服务还是企业网关。运行时只依赖一个小接口：`InferenceAdapter.decide(request) -> decision`。

生产只提供 `CodexInferenceAdapter`，统一调用 `codex exec --ephemeral`，传入结构化输出 Schema、超时和临时工作目录。测试提供 `FakeInferenceAdapter`。业务运行时、Skills、飞书动作和状态逻辑只认识统一决策结果，不读取模型品牌、端点、认证方式或 Codex 配置正文。

产品配置只保存运行 Codex 所需的本机引用、超时、最大反馈轮次和生产数据许可。凭据、登录状态、模型端点和自定义 Provider 配置继续由 Codex、Keychain 或部署者批准的秘密环境管理；项目不复制、不指纹化、不迁移这些内容。

安装与 Doctor 使用无业务正文的合成输入验证：Codex 可执行、`exec --ephemeral` 可运行、结构化输出可解析、超时有效。检查结果只输出稳定状态码和耗时，不输出模型响应、配置、路径或凭据。

项目不提供 Provider 选择、切换、自动回退、供应商专属 Adapter 或第二套模型 SDK。Codex 不可用、认证失效或输出不兼容时，数字分身失败关闭；修复 Codex 自身环境并重新通过 Doctor 后恢复。

部署者必须确认实际 Codex 环境允许处理相应飞书正文。这个确认是实例级数据边界，不代表项目了解或批准 Codex 内部采用的模型服务。

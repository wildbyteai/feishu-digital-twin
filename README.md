# 飞书数字分身

基于 Codex、飞书官方 `lark-cli` 和 lark-* Skills 的完整开源、自托管飞书数字分身。

它不是一个只有被 `@` 才响应的普通 Bot。新实例默认使用 `message_scope=bot_only`，只处理 Bot 官方可见的实时消息；部署者明确扩大消息发现范围后，系统才使用主体用户身份补充读取。AI 根据自然语言规则决定忽略、回复、请求确认或调用飞书能力；发给哪个身份的消息，始终由对应身份回复，所有自动发言都会带有 `🤖` 标识。

> 本项目不是飞书、Lark 或 OpenAI 官方产品。相关商标归各自权利人所有。

> 发布状态：完整运行时、`setup`、`status`、`control`、三档消息范围确认，以及已有控制 Base/知识空间/每日记忆目标的脚本化选择和官方 CLI 只读验真均已实现。新资源创建继续使用官方 CLI dry-run 与部署者明确批准，不建设第二套创建工作流。2026 年 7 月 26 日生成的 `0.1.3` 正式候选包含 136 个公开文件，源码、Codex 插件、npm、manifest、SPDX 2.3 SBOM、unsigned-local provenance 与摘要均已通过验证；隔离实例完成 `0.1.2 → 0.1.3 → 0.1.2 → 0.1.3` 升级回退闭环，同版本升级返回 `unchanged`。专用非生产实例的控制 Base 授权、两张正式表和 Base 控制模式接入已经完成，Doctor、三个后台角色和本地连续性门保持健康。当前源码进入 `0.1.4` 隐私补丁候选验证，补充 OAuth 临时授权图的识别、授权后安全清理和 Git 隔离。项目仍未对外发布；剩余发布门是全新非生产飞书租户的独立完整闭环复现，以及创建公共仓、写入真实 Marketplace/CODEOWNERS/安全地址、启用分支保护与签名 attestation，并实际发布 Release、Marketplace、npm 和公共目录。

## 核心能力

- 默认覆盖 Bot 可见的工作消息，不强制要求 `@`；
- 可在一次性明确确认后扩展到主体用户可见的内部聊天或全部聊天；
- 按需读取有界的同群历史，不建设长期聊天库；
- 按消息来源固定回复身份，模型不能自行切换身份；
- 由 Codex 与 Skills 完成智能触发、回复、追问、确认和动作编排；
- 通过官方飞书 CLI 使用消息、任务、日历、文档、Base、Drive 和 Wiki；
- 使用飞书 Base 管理总开关、自然语言规则、群级规则和知识空间映射；
- 企业知识库辅助回复与每日工作记忆；
- 事件去重、补读游标、冻结、短期待确认、有限执行反馈和崩溃恢复；
- macOS 后台服务、状态检查、升级、回退和卸载。

## 架构原则

1. **AI 驱动**：业务判断和动作编排尽量放在 Codex、Skills 与自然语言配置中。
2. **官方组件优先**：飞书能力优先使用官方 `lark-cli` 和 lark-* Skills。
3. **完整开源**：稳定功能全部进入公开源码，不采用 Open Core。
4. **最少自研代码**：只补事件接线、身份路由、去重、冻结、游标和短期状态等官方组件无法覆盖的缝隙。
5. **本机隐私优先**：默认没有远程遥测，不上传调试包，不保存长期聊天正文。

公共默认配置同时采用 `control={mode:local,enabled:false}`、`message_scope=bot_only` 和仅消息域 `im`。默认状态保留 7 天，结果日志和信号日志保留 3 天，并采用 1 MiB/256 KiB 大小上限；Schema 的不可突破上限仍分别为 30 天、7 天和 10 MiB/1 MiB。

```text
飞书 Bot 实时事件 +（范围确认后）主体用户身份补充读取
                         ↓
              伴随运行时 + 项目 Skills
                         ↓
             codex exec --ephemeral
                         ↓
              LarkGuard + 官方 lark-cli
```

项目不重建飞书 SDK、模型 SDK、动作目录、审批系统、工作流引擎或本地聊天数据库。

## Codex 与模型服务

运行时统一调用 `codex exec --ephemeral`，不直接集成任何模型服务的 HTTP API。Codex CLI 内部使用官方登录、API Key、自定义模型服务或企业网关，完全由部署者自己的 Codex 配置决定。

本项目不识别 Provider 品牌，不保存模型端点，不实现 Provider 选择、切换、指纹或回退。它只验证配置给后台服务的 Codex CLI 能否完成一次无业务正文的结构化推理，并要求部署者确认该 Codex 环境允许处理相应飞书数据。

## 配置边界

公开仓只提供 Schema、中性示例和安装工具。真实实例配置与运行状态必须保存在 Git 工作区之外的本机私有目录。

可配置内容包括：

- 主体用户显示名、称呼和时区；
- `lark-cli` profile 引用和 Codex CLI 运行环境；
- 启用的飞书能力域；
- 工作日、补读频率与每日任务时间；`schedule.workdays` 可选使用 ISO 1–7（周一至周日），省略时默认周一至周五；
- Base 控制台、知识空间和每日记忆目标引用；
- 自然语言授权规则与群级特殊规则。

`message_scope` 明确控制消息发现范围：

- `bot_only`：公共默认值，只消费 Bot 官方实时事件，不启动主体用户补读；
- `internal_visible`：补读主体用户可见的企业内部群聊和私聊，跳过外部群；
- `all_visible`：补读主体用户可见的全部群聊和私聊，包括外部群。

`setup` 要求候选配置明确写出三档之一。首次选择 `internal_visible`、`all_visible`，或把已有实例扩大到更高范围时，必须额外传入 `--approve-message-scope`；缺少确认时会在写入配置或启动服务前失败。`bot_only` 不需要该参数。该确认不是日常审批，Base、AI、普通消息和后台任务都不能扩大范围。

公共示例默认只启用消息域 `im`。任务、日历、文档、Base、Drive、Wiki、群与权限等能力必须由部署者按需逐项开启；“源码包含完整能力”不等于“新实例默认获得全部权限”。

本机 `allowed_lark_domains` 是不可突破的权限上限；飞书 Base 控制台只能在这个范围内继续减权限，不能新增本机未授权域。总开关、允许域、自然语言规则、群级规则和知识空间路由使用同一个短缓存快照刷新，同一条消息处理期间不会切换配置。

以下内容不得进入公共仓或发行包：

- OAuth、API Key、Token、Cookie、二维码和其他凭据；
- 真实用户、群、消息、Base、Wiki、Drive 等资源标识；
- 企业规则、知识映射、聊天和文档正文；
- Codex 内部端点、真实模型配置和认证状态；
- SQLite、日志、缓存、备份、每日工作记忆和 `*.privacy-key`。

跨重启保持稳定且由部署者明确选择的资源标识，例如主体用户 `open_id`、控制 Base/表、群级规则 chat ID、知识空间和每日记忆目标，可以保存在 Git 外 `0600` 的本机私有实例配置中。运行中临时发现的 message/thread/chat ID、正文、搜索结果和执行反馈只能进入有保留期的本机私有运行态。凭据和认证状态继续由 `lark-cli`、Codex、Keychain 或部署者批准的秘密环境管理，不能写入普通 `config.json`。

私有目录使用 `0700`，敏感文件使用 `0600`。运行日志只记录随机追踪号、阶段码、结果码、数量、耗时、脱敏错误分类，以及由本机隐私密钥生成、受保留期限制的类型化 HMAC `execution_hash`（仅用于重复执行审计）；不记录消息正文、模型输出、命令参数、`command_hash`、原始飞书 ID、凭据、Codex 配置或本机路径。

## 不可关闭的可信规则

- 回复身份由消息来源固定；
- `🤖` 与数字分身、建议、待本人确认等模式标签由可信运行时统一生成且不可关闭；主体名称和称呼来自实例配置；
- 所有权转让永久禁止自动执行；
- 去重、冻结、补读游标和短期待确认保持有效；
- 不绕过官方 `lark-cli` 的确认协议；
- 日志不保存消息正文、模型输出或长期会话。

其他授权范围内的事项由 AI 根据自然语言规则处理。确实缺少会改变承诺的关键事实时，数字分身会在飞书发言中给出具体建议并请求主体用户确认，不建设第二套审批系统。

## 环境要求

- macOS（首个稳定版的正式支持平台）；
- Node.js 22.5 或更高版本；
- 已安装并授权的官方 `lark-cli`；
- 可执行 `codex exec --ephemeral` 的隔离 Codex 环境；
- 已确认允许处理相应飞书数据的模型服务环境。

## 三步开始

1. **[接入飞书官方 CLI](./docs/getting-started/feishu-cli.md)**：安装官方 `lark-cli`，选择明确 profile，完成 Bot 应用、`im.message.receive_v1` 事件和主体用户授权。
2. **[启用 Codex](./docs/getting-started/codex.md)**：准备能在后台非交互执行 `codex exec --ephemeral`、并获准处理目标飞书数据的私有 Codex 环境。
3. **[完成全局配置](./docs/getting-started/global-configuration.md)**：运行同版本插件或 npm 包提供的 setup；普通部署者不需要先编写 JSON。

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --approve-production-data
```

该路径通过官方 `auth status --verify` 发现主体用户和 Bot 身份，自动固定实际使用的 `lark-cli` 与 Codex 可执行文件，并生成 `0600` 私有配置。默认值是 `message_scope=bot_only`、仅 `im` 域、周一至周五 09:00–18:00 每 30 秒补读、其他时间每 5 分钟补读、状态保留 7 天、结果与信号日志保留 3 天。只有显式提供 `--approve-production-data` 且 Doctor 与后台服务全部通过后，实例才会启用生产处理。

需要更大消息范围时使用 `--message-scope internal_visible` 或 `--message-scope all_visible`，并额外传入 `--approve-message-scope`。需要更多飞书能力时，普通路径使用例如 `--capabilities message,task,calendar,docs`，由产品目录生成去重的最小官方业务域；高级部署者才使用 `--domains im,task,contact` 直接覆盖。两者不能同时使用，`event` 是事件接线基础设施，不能进入 `allowed_lark_domains`。这些参数只设置本机权限上限，仍需完成对应的官方飞书授权。高级部署者也可以使用 `--config <private-config>` 提供完整配置；候选文件必须位于源码树之外且只允许当前用户读取。

`status` 会用脱敏摘要返回 `degraded`、`safe-but-disabled` 或 `ready`。`control` 已提供 `enable`、`freeze`、`upgrade`、`rollback` 和 `uninstall` 五个面向日常运维的入口。以下拆分命令保留给排障和高级管理，不是普通部署者的必经流程：

运行中升级必须同时提供新发行树的 `--source` 和 `--restart`，运行中回退也必须使用 `--restart`；同版本号不会覆盖已安装文件。完整命令见[后台运行与维护](./docs/operations/runtime.md)。

```bash
node bin/feishu-digital-twin.mjs init
node bin/feishu-digital-twin.mjs configure \
  --config <absolute-config-path> \
  --lark-cli <absolute-lark-cli-path> \
  --codex-bin <absolute-codex-path> \
  --codex-environment-root <absolute-codex-environment-root> \
  --approve-production-data
node bin/feishu-digital-twin.mjs doctor
node bin/feishu-digital-twin.mjs service install
node bin/feishu-digital-twin.mjs resume
node bin/feishu-digital-twin.mjs status
```

只有飞书连通性、Codex 结构化推理、数据边界、本机权限、配置和状态读回全部通过，实例才应解除冻结并开始自动处理。后台服务包括：

- `realtime`：消费 Bot 官方实时事件；
- `supplement`：补充读取主体用户可见的新消息；
- `daily-memory`：按配置时间生成每日工作记忆。

后台角色、开机自启、升级回退和卸载见[后台运行与维护](./docs/operations/runtime.md)。卸载默认保留本机私有数据。

## 文档

- [接入飞书官方 CLI](./docs/getting-started/feishu-cli.md)
- [启用 Codex](./docs/getting-started/codex.md)
- [完成全局配置](./docs/getting-started/global-configuration.md)
- [实例配置参考](./docs/reference/configuration.md)
- [飞书最小权限参考](./docs/reference/feishu-permissions.md)
- [后台运行与维护](./docs/operations/runtime.md)
- [隐私与数据处理](./docs/security/privacy.md)
- [兼容性](./docs/compatibility.md)
- [每日工作记忆](./docs/features/daily-memory.md)
- [企业知识库辅助回复](./docs/features/enterprise-knowledge.md)
- [完整公开产品规格](./docs/public/product-spec.md)
- [完整开源方案](./docs/public/open-source-plan.md)
- [飞书 Base 控制台](./docs/feishu-console.md)
- [本地服务连续性](./docs/operations/local-service-continuity.md)
- [公共快照与隐私门](./docs/operations/public-snapshot.md)
- [安全政策](./SECURITY.md)
- [贡献指南](./CONTRIBUTING.md)

## 开源许可

本项目采用 [Apache License 2.0](./LICENSE)。

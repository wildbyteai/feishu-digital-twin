# 飞书数字分身

基于 Codex、飞书官方 `lark-cli` 和 lark-* Skills 的完整开源、自托管飞书数字分身。

它不是一个只有被 `@` 才响应的普通 Bot。AI 根据自然语言规则判断是否忽略、回复、追问、请求本人确认或调用飞书能力；消息发给哪个身份，就由对应身份回复。所有自动发言统一带 `🤖` 标识。

> 本项目不是飞书、Lark 或 OpenAI 官方产品。相关商标归各自权利人所有。

> 当前公开版本为 `v0.1.9`。正式支持 macOS；目前从 GitHub 源码或版本标签安装，尚未发布 npm 和 Codex Marketplace 一键安装包。

## 五分钟了解

| 能力 | 说明 |
| --- | --- |
| 智能消息处理 | 实时处理 Bot 可见消息；部署者明确扩大范围后，可补充读取主体用户可见的内部或全部聊天 |
| 双身份回复 | 发给 Bot 的消息由 Bot 回复，发给主体用户的消息由主体用户身份回复；模型不能自行切换身份 |
| AI 决策与执行 | 由 Codex、Skills 和自然语言规则完成触发判断、回复、追问、确认与动作编排 |
| 飞书工作执行 | 通过官方 `lark-cli` 处理消息、任务、日历、文档、Base、Drive、Wiki 等能力 |
| Base 控制台 | 可选使用两张已有 Base 表管理总开关、自然语言规则、群级规则和知识空间路由 |
| 企业知识辅助 | 判断聊天方向后，从配置的企业知识空间检索相关内容辅助回复 |
| 每日工作记忆 | 按计划汇总当天聊天、任务、日程和执行结果，写入指定的飞书 Drive 文件夹 |
| 本机长期运行 | macOS 登录后自动启动实时消息、补读和每日记忆三个后台角色，支持状态检查、冻结、升级、回退和卸载 |

系统只保留事件去重、补读游标、冻结状态、短期待确认和有限执行反馈等必要短期状态，不建设长期聊天数据库。所有权转让永久禁止自动执行。

## 安装前需要准备

- macOS；
- Node.js 22.13 或更高版本；
- 已安装并授权的飞书官方 `lark-cli`；
- 一个能接收消息事件的飞书应用和 Bot；
- 可在后台非交互执行 `codex exec --ephemeral` 的 Codex CLI 环境；
- 已确认允许处理目标飞书业务数据的模型服务环境；
- 如果启用 Base 控制台、企业知识或每日记忆，提前准备对应的飞书资源。

先从 GitHub 固定版本安装命令行：

```bash
git clone --branch v0.1.9 --depth 1 https://github.com/wildbyteai/feishu-digital-twin.git
cd feishu-digital-twin
npm install --global .
feishu-digital-twin --help
```

不希望全局安装时，可以在仓库目录把下文的 `feishu-digital-twin` 替换为 `node bin/feishu-digital-twin.mjs`。

## setup 会自动做什么

| `setup` 自动完成 | 需要部署者提前完成 |
| --- | --- |
| 发现并验证指定 `lark-cli` profile 的主体用户和 Bot 身份 | 创建飞书应用、启用 Bot、发布应用版本 |
| 验证 Codex CLI 能完成一次无业务正文的结构化推理 | 在开发者后台配置应用权限和 `im.message.receive_v1` 事件 |
| 根据 `--capabilities` 生成本机允许使用的最小飞书业务域 | 完成所需的 Bot scope 与主体用户 OAuth 授权 |
| 只读验证传入的 Base、表、Wiki 空间和 Drive 文件夹 | 按需按[控制台表结构](./docs/feishu-console.md)创建 Base 和两张控制表，并创建 Wiki 知识空间和日报文件夹 |
| 在 Git 工作区之外生成仅当前用户可读的私有配置 | 提供这些已有资源的名称、ID 或 token |
| 安装并启动三个 macOS LaunchAgent 后台角色 | 确认模型服务环境获准处理相应飞书业务数据 |
| 运行 Doctor、读回状态；失败时回滚到调用前状态 | 选择消息范围和实际启用的能力 |

> **Base、表、知识空间和日报文件夹需要提前创建；`setup` 只引用并只读校验，不会自动写入或创建这些资源。**

创建这些资源属于独立的飞书写操作。可使用官方 `lark-cli` 先 `--dry-run` 预览，再由部署者执行；不要把真实 token、ID 或企业规则提交到 GitHub。

## 功能与所需权限

飞书权限分三层：开发者后台给应用开放的 **Bot scope**、主体用户通过 OAuth 授予的 **User scope**，以及数字分身本机配置的 `allowed_lark_domains` 上限。每项能力实际使用身份的飞书 scope 与本机 domain 均允许时，该能力才会生效；Bot-only 能力不要求无关的 User scope，User-only 能力也不要求无关的 Bot scope。本机配置不能替代飞书授权，也不能扩大飞书已经授予的权限。

| 产品能力 | `--capabilities` 值 | 本机 domain | 主要身份 | 飞书侧需要准备 |
| --- | --- | --- | --- | --- |
| 消息接收与回复 | `message` | `im` | Bot；可选 User | Bot 消息接收/回复权限；订阅 `im.message.receive_v1`；扩大范围时增加 User 聊天与消息读取授权 |
| 任务 | `task` | `task` | User | 任务读取权限；需要创建或更新时再增加任务写权限 |
| 日历 | `calendar` | `calendar` | User | 日程读取权限；需要提醒、建会或更新时再增加日历写权限 |
| 文档 | `docs` | `docs,drive` | User | 文档和云空间读取权限；需要创建或更新时增加相应写权限 |
| Base | `base` | `base` | User | Base 读取权限；需要写记录时增加 Base 写权限 |
| 企业知识 | `enterprise_knowledge` | `drive,wiki,docs,base,sheets,markdown` | User | Wiki、Drive 及实际内容类型的读取权限 |
| 每日工作记忆 | `daily_memory` | `im,task,calendar,drive,docs` | User | 当日信息读取权限，以及目标 Drive 文件夹和文档写入权限 |
| Base 控制台 | `console` | `base` | User | 指定 Base 和两张表的读取权限 |

新实例默认使用 `message_scope=bot_only` 且只启用 `im`。不要默认申请 `all`，也不要申请与所选能力无关的组织管理或成员管理权限。

官方 scope 名称可能随 `lark-cli` 和飞书开放平台演进。安装时用当前 CLI 获取准确清单：

```bash
lark-cli --profile <profile> auth scopes --json
lark-cli --profile <profile> auth check --scope "<space-separated-scopes>" --json
lark-cli schema <service.resource.method> --format json
```

Bot 缺少 scope 时在飞书开发者后台处理；User 缺少 scope 时只对目标 profile 增量完成 OAuth 授权。详细说明见[飞书最小权限参考](./docs/reference/feishu-permissions.md)。

## 三步开始

1. **[接入飞书官方 CLI](./docs/getting-started/feishu-cli.md)**：安装官方 `lark-cli`，创建并发布飞书应用，启用 Bot，配置 `im.message.receive_v1`，完成所需 Bot scope 和主体用户 OAuth。
2. **[启用 Codex](./docs/getting-started/codex.md)**：准备能在后台非交互执行 `codex exec --ephemeral`、并获准处理目标飞书数据的 Codex 环境。Codex 内部使用官方登录、API Key、自定义模型服务或企业网关均可，本项目不直接集成 Provider API。
3. **[完成全局配置](./docs/getting-started/global-configuration.md)**：选择下面的安装场景运行 `setup`；普通部署者不需要手写 JSON。

### 场景 A：最小消息模式

只处理 Bot 官方可见的实时消息，不需要 Base、Wiki 或日报文件夹：

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --capabilities message \
  --approve-production-data
```

### 场景 B：扩大到主体用户可见消息

读取企业内部群聊和私聊时使用 `internal_visible`；确实需要包括外部群时才使用 `all_visible`：

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message \
  --approve-message-scope \
  --approve-production-data
```

首次选择非 `bot_only` 或扩大已有范围时，`--approve-message-scope` 必不可少。Base、AI、普通飞书消息和后台任务都不能自行扩大这个范围。

### 场景 C：Base 控制台、企业知识和每日记忆

先按[飞书 Base 控制台](./docs/feishu-console.md)创建 Base 和两张控制表，再创建日报 Drive 文件夹并把已有资源传给 `setup`。运行配置表必须包含且只包含一条有效运行记录；群级规则表可以没有记录，但两张表都必须具备文档列出的全部字段。“允许域”只能使用严格的“继承”或本机上限内的非空域列表。知识空间路由可以在 Base 规则中维护：

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message,task,calendar,docs,enterprise_knowledge,daily_memory,console \
  --console-base-token <existing-base-token> \
  --console-runtime-table <existing-runtime-table-name-or-id> \
  --console-group-rules-table <existing-group-rules-table-name-or-id> \
  --daily-memory-folder-token <existing-folder-token> \
  --daily-memory-folder-name <existing-folder-name> \
  --approve-message-scope \
  --approve-production-data
```

不使用 Base 控制台时，可以直接通过 `--knowledge-space-name`、`--knowledge-space-id` 和 `--knowledge-direction` 成组引用一个已有知识空间。全部参数见[全局配置说明](./docs/getting-started/global-configuration.md)。

## 安装后验收

```bash
feishu-digital-twin doctor
feishu-digital-twin status
```

正常启用时应同时满足：

- `setup` 命令返回 `status=setup-complete`；
- 随后执行 `status` 能正常读回实例和服务状态；
- `readiness=ready`；如果本机或 Base 总开关明确关闭，则允许 `safe-but-disabled`；
- `realtime`、`supplement`、`daily-memory` 三个后台角色均健康；
- 同一个飞书应用只有一个官方实时消息消费者；
- 私有配置位于 Git 工作区之外，文件权限仅当前用户可读；
- 实际消息、任务、日历、知识检索和日报能力与所选权限一致。

`readiness=degraded` 表示安装未完成，不应开始自动处理。运行中升级必须同时提供 `--source` 和 `--restart`，运行中回退必须提供 `--restart`；同版本号不会覆盖已经安装的文件。常用运维命令：

```bash
feishu-digital-twin status
feishu-digital-twin control freeze
feishu-digital-twin control enable
feishu-digital-twin control upgrade --source <absolute-new-release-tree> --restart
feishu-digital-twin control rollback --restart
feishu-digital-twin control uninstall
```

完整说明见[后台运行与维护](./docs/operations/runtime.md)。卸载默认保留本机私有数据。

## 配置与隐私边界

- 真实实例配置和运行状态保存在 Git 工作区之外；私有目录使用 `0700`，敏感文件使用 `0600`；
- 不要复制其他人的 `lark-cli` profile、Keychain、Codex 登录态、资源 ID 或实例配置；
- 项目默认无远程遥测，不上传调试包；运行日志不记录消息正文、完整模型输出或凭据，也不建设长期聊天历史；短期待确认最多暂存必要动作寻址 10 分钟，确认、拒绝或过期后清空；
- `allowed_lark_domains` 是本机不可突破的能力上限；Base 控制台只能继续收紧，不能新增未授权能力；
- 回复身份、`🤖` 标识、冻结、去重、补读游标和所有权转让禁令由可信运行时保证；
- 当前安装器只读验证已有飞书资源，不会自动创建或修改 Base、Wiki 和 Drive 目录。

Codex CLI 内部使用哪种模型服务，由部署者自己的 Codex 配置决定。本项目只调用 `codex exec --ephemeral`，不保存模型端点，也不实现 Provider 选择和切换。部署者必须自行确认该环境获准处理相应飞书数据。

更多信息见[隐私与数据处理](./docs/security/privacy.md)和[实例配置参考](./docs/reference/configuration.md)。

## 架构原则

1. **AI 驱动**：业务判断和动作编排尽量放在 Codex、Skills 与自然语言配置中。
2. **官方组件优先**：飞书能力优先使用官方 `lark-cli` 和 lark-* Skills。
3. **完整开源**：稳定功能全部进入公开源码，不采用 Open Core。
4. **最少自研代码**：只补事件接线、身份路由、去重、冻结、游标和短期状态等官方组件无法覆盖的缝隙。
5. **本机隐私优先**：默认没有远程遥测，不保存长期聊天正文。

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
- [飞书 Base 控制台](./docs/feishu-console.md)
- [本地服务连续性](./docs/operations/local-service-continuity.md)
- [公共快照与隐私门](./docs/operations/public-snapshot.md)
- [完整公开产品规格](./docs/public/product-spec.md)
- [完整开源方案](./docs/public/open-source-plan.md)
- [安全政策](./SECURITY.md)
- [贡献指南](./CONTRIBUTING.md)

## 开源许可

本项目采用 [Apache License 2.0](./LICENSE)。

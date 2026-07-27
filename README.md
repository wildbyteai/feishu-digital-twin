[中文](./README.md) | [English](./README.en.md)

# 飞书数字分身

让 Codex 在明确的身份、权限和确认边界内，成为可以处理飞书消息并执行实际工作的自托管 AI 数字分身。

[三步开始](#三步开始) · [功能与权限](#功能与所需权限) · [运行与回退](#安装后验收) · [隐私边界](#配置与隐私边界) · [架构原则](#架构原则)

> 本项目不是飞书、Lark 或 OpenAI 官方产品。相关商标归各自权利人所有。

## 一分钟理解

飞书数字分身是一个运行在你自己 macOS 设备上的 AI 工作代理：

- **接收信息**：实时处理 Bot 可见消息；只有部署者明确批准后，才会扩大到主体用户可见的聊天范围。
- **自主判断**：Codex 根据自然语言规则决定忽略、回复、追问、请求本人确认或执行动作。
- **执行工作**：通过飞书官方 `lark-cli` 和 lark-* Skills 操作消息、任务、日历、文档、Base、Drive、Wiki 等能力。
- **固定身份**：消息发给 Bot 就由 Bot 回复，发给主体用户就由主体用户身份回复；模型不能自行切换身份。
- **保留控制权**：本机权限上限、飞书授权、Base 总开关和确认机制共同限制可见范围与可执行动作。

```text
飞书消息 / 补充读取 → 安全接入与身份路由 → Codex 决策 → 官方 lark-cli 执行 → 回复或工作结果
```

它不是一个只有被 `@` 才响应的普通 Bot，也不是托管式 SaaS。所有自动发言统一带 `🤖` 标识；系统不建设长期本地聊天数据库，并永久禁止自动转让资源所有权。

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 智能消息处理 | 按规则实时处理 Bot 可见消息，并在明确批准后补充读取主体用户可见的内部或全部聊天 |
| 双身份回复 | 发给 Bot 的消息由 Bot 回复，发给主体用户的消息由主体用户身份回复；模型不能自行切换身份 |
| AI 决策与执行 | 由 Codex、Skills 和自然语言规则完成触发判断、回复、追问、确认与动作编排 |
| 飞书工作执行 | 通过官方 `lark-cli` 处理消息、任务、日历、文档、Base、Drive、Wiki 等能力 |
| Base 控制台 | 完整安装的强制配置；可复用已有 Base，或由 `setup` 创建两张表来管理总开关、自然语言规则、群级规则和知识空间路由 |
| 企业知识辅助 | 判断聊天方向后，从配置的企业知识空间检索相关内容辅助回复 |
| 每日工作记忆 | 按计划汇总当天聊天、任务、日程和执行结果，写入指定的飞书 Drive 文件夹 |
| 本机长期运行 | macOS 登录后自动启动实时消息、补读和每日记忆三个后台角色，支持状态检查、冻结、升级、回退和卸载 |

## 适用范围

适合希望自行托管、能够管理飞书应用权限，并愿意让 AI 在可审计边界内协助处理日常工作的个人或团队。当前不适合需要 Windows/Linux 正式运行、一键 SaaS 开通，或无法提供飞书应用、`lark-cli` 授权和 Codex 环境的场景。

## 安装前需要准备

- macOS；
- Node.js 22.13 或更高版本；
- 已安装并授权的飞书官方 `lark-cli`；
- 一个能接收消息事件的飞书应用和 Bot；
- 可在后台非交互执行 `codex exec --ephemeral` 的 Codex CLI 环境；
- 已确认允许处理目标飞书业务数据的模型服务环境；
- Base 控制台是普通完整安装的强制配置，但无需提前手工建表；Base、企业知识空间和每日记忆目录都可以传入已有资源，也可以由 `setup` 调用官方 CLI 创建。

### 安装命令行

稳定版本以不可变 Git 标签为准，不依赖 GitHub Release 页面。最简单的方式是把下面这句话发给 Agent：

> 请从 `wildbyteai/feishu-digital-twin` 的最新稳定 Git 标签安装，阅读仓库 README 后完成 `setup`、`doctor` 和 `status`；遇到飞书授权、生产数据确认或创建资源时先向我确认。

也可以不做全局安装，直接用 `npx` 运行固定的稳定版本：

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 --help
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup --help
```

完整配置和后台服务由 `setup` 安装到本机私有版本目录。后续管理仍可交给 Agent，或继续用同一稳定标签运行相应命令。

## setup 会自动做什么

| `setup` 自动完成 | 需要部署者提前完成 |
| --- | --- |
| 发现并验证指定 `lark-cli` profile 的主体用户和 Bot 身份 | 创建飞书应用、启用 Bot、发布应用版本 |
| 验证 Codex CLI 能完成一次无业务正文的结构化推理 | 在开发者后台配置应用权限和 `im.message.receive_v1` 事件 |
| 根据 `--capabilities` 生成本机允许使用的最小飞书业务域 | 完成所需的 Bot scope 与主体用户 OAuth 授权 |
| 只读验证传入的 Base、表、Wiki 空间和 Drive 文件夹 | 若选择复用，提供已有资源的名称、ID 或 token |
| 经 `--create-missing-resources` 明确批准后，使用主体 user 身份调用官方 CLI 创建并读回 Base、两张控制表、知识空间和日报目录 | 确认自动生成的默认资源名称是否适合当前主体用户 |
| 在 Git 工作区之外生成仅当前用户可读的私有配置 | 确认首装后保持 `数字分身启用` 关闭，完成验收后再开启 |
| 安装并启动三个 macOS LaunchAgent 后台角色 | 确认模型服务环境获准处理相应飞书业务数据 |
| 运行 Doctor、读回状态；失败时回滚到调用前状态 | 选择消息范围和实际启用的能力 |

> **Base 控制台是强制配置，但不要求提前手工创建。缺少 Base、知识空间或日报目录时，`setup` 会明确列出所需资源；追加 `--create-missing-resources` 后，它会依次执行官方 `--dry-run`、创建和只读验证。Base 使用 `base +base-create`、`base +table-create` 和 `base +record-upsert`，知识空间与日报目录分别使用 `wiki +space-create` 和 `drive +create-folder`。**

自动创建使用主体 user 身份，默认名称为 `<主体用户显示名>的数字分身控制台`、`<主体用户显示名>的数字分身知识库` 和 `<主体用户显示名>的每日工作记忆`。控制 Base 自动包含“运行配置”和“群级规则”两张表；初始总开关关闭，运行配置恰好一条，群级规则为空。重试会按精确名称复用并补齐未完成的表或初始记录；发现多个同名资源或同名 Base 结构冲突时停止。setup 后续本机步骤失败时，已创建的飞书资源不会被删除，下一次运行会复用。真实 token、ID 和企业规则只写入 Git 外 `0600` 私有配置，不回显到普通命令输出。

### setup 中的开关与确认项

先运行下面的命令即可直接看到 Base 首装模板、初始值和验收步骤：

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup --help
```

需要区分一个日常开关和三个部署确认：

| 项目 | 作用 | 什么时候使用 |
| --- | --- | --- |
| Base 字段 `数字分身启用` | 唯一日常总开关 | 首装时先关闭；setup 和 status 验证完成后再勾选 |
| `--approve-production-data` | 确认当前 Codex 环境获准处理目标业务数据 | 部署时确认，不是日常开关 |
| `--approve-message-scope` | 确认首次使用或扩大 `internal_visible` / `all_visible` | 只有扩大消息可见范围时使用 |
| `--create-missing-resources` | 明确批准创建缺失的 Base、控制表、Wiki 空间或 Drive 日报目录 | 没有现成控制 Base 时，普通完整安装必须使用 |

使用 Base 控制台时，运行配置表只保留一条记录。推荐初始值为：可选的 `名称=默认配置`、`数字分身启用=未勾选`、`允许域=继承`、`个性化规则=空或自然语言规则`；群级规则中的 `群名称` 也只是可选展示字段。旧字段 `生产执行` 仅用于兼容已有部署，新安装统一使用 `数字分身启用`。setup 成功但总开关仍关闭时，`readiness=safe-but-disabled` 是正常状态；确认身份、权限和后台服务均正常后，勾选 `数字分身启用`，最长等待约 10 秒，再通过同一稳定标签运行 `status`，应看到 `readiness=ready`。

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
| Base 控制台 | `console`（普通安装自动包含） | `base` | User | 复用已有 Base 时需要读取权限；自动初始化时还需要创建 Base、建表和写入初始记录的权限 |

新实例默认使用 `message_scope=bot_only`，本机业务域至少包含 `im,base`，其中 `base` 只服务于强制控制台。不要默认申请 `all`，也不要申请与所选能力无关的组织管理或成员管理权限。

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

只处理 Bot 官方可见的实时消息，不需要 Wiki 或日报文件夹；Base 控制台仍是强制配置。没有现成 Base 时让 setup 自动创建：

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --capabilities message \
  --create-missing-resources \
  --approve-production-data
```

### 场景 B：扩大到主体用户可见消息

读取企业内部群聊和私聊时使用 `internal_visible`；确实需要包括外部群时才使用 `all_visible`：

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message \
  --create-missing-resources \
  --approve-message-scope \
  --approve-production-data
```

首次选择非 `bot_only` 或扩大已有范围时，`--approve-message-scope` 必不可少。Base、AI、普通飞书消息和后台任务都不能自行扩大这个范围。

### 场景 C：没有现成 Base、知识空间和日报目录

最简单的完整能力路径是直接让 setup 用官方 CLI 创建全部缺失资源。自动发现的知识空间路由会写入新 Base 的“个性化规则”，最终不保留第二套本机规则源：

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message,task,calendar,docs,enterprise_knowledge,daily_memory \
  --create-missing-resources \
  --approve-message-scope \
  --approve-production-data
```

如果不加 `--create-missing-resources`，setup 不会静默创建，而是返回 `missing_resources`、已有资源参数和自动创建开关。

### 场景 D：复用已有 Base 控制台和其他资源

如果已经有符合[飞书 Base 控制台](./docs/feishu-console.md)结构的 Base，可以直接传入稳定引用。运行配置表必须包含且只包含一条有效运行记录；群级规则表可以没有记录，但两张表都必须具备文档列出的全部字段。“允许域”只能使用严格的“继承”或本机上限内的非空域列表。已有 Base 只读验真，不会被 setup 擅自改造；知识空间路由继续在 Base 规则中维护，日报目录可以传入已有资源：

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
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

没有现成 Base、但希望引用已有知识空间时，可以把 `--knowledge-space-name`、`--knowledge-space-id` 和 `--knowledge-direction` 与 `--create-missing-resources` 一起使用；setup 会创建控制 Base，并把知识路由写入初始“个性化规则”。全部参数见[全局配置说明](./docs/getting-started/global-configuration.md)。

## 安装后验收

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 doctor
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 status
```

正常启用时应同时满足：

- `setup` 命令返回 `status=setup-complete`；
- 随后执行 `status` 能正常读回实例和服务状态；
- `readiness=ready`；如果本机或 Base 总开关明确关闭，则允许 `safe-but-disabled`；
- `realtime`、`supplement`、`daily-memory` 三个后台角色均健康；
- 同一个飞书应用只有一个官方实时消息消费者；
- 私有配置位于 Git 工作区之外，文件权限仅当前用户可读；
- 实际消息、任务、日历、知识检索和日报能力与所选权限一致。

`readiness=degraded` 表示安装未完成，不应开始自动处理。升级时直接运行目标稳定标签并添加 `--restart`；回退也必须添加 `--restart`。同版本号不会覆盖已经安装的文件。常用运维命令：

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 status
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control freeze
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control enable
npx --yes "github:wildbyteai/feishu-digital-twin#<target-tag>" control upgrade --restart
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control rollback --restart
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control uninstall
```

完整说明见[后台运行与维护](./docs/operations/runtime.md)。卸载默认保留本机私有数据。

## 配置与隐私边界

- 真实实例配置和运行状态保存在 Git 工作区之外；私有目录使用 `0700`，敏感文件使用 `0600`；
- 不要复制其他人的 `lark-cli` profile、Keychain、Codex 登录态、资源 ID 或实例配置；
- 项目默认无远程遥测，不上传调试包；运行日志不记录消息正文、完整模型输出或凭据，也不建设长期聊天历史；短期待确认最多暂存必要动作寻址 10 分钟，确认、拒绝或过期后清空；
- `allowed_lark_domains` 是本机不可突破的能力上限；Base 控制台只能继续收紧，不能新增未授权能力；
- 回复身份、`🤖` 标识、冻结、去重、补读游标和所有权转让禁令由可信运行时保证；
- 已有 Base 始终只读验真；只有部署者显式添加 `--create-missing-resources` 时，setup 才通过官方 CLI 创建或补齐缺失的 Base、控制表、初始记录、Wiki 空间和 Drive 日报目录。

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

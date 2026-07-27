# 飞书最小权限参考

飞书权限由两层共同决定：开发者后台给应用开放的 Bot scope，以及主体用户通过 OAuth 授予的 user scope。数字分身的 `allowed_lark_domains` 只是本机执行上限，不能替代平台授权。

## 能力映射

| 产品能力 | lark-cli domain | 主要身份 | 最小授权策略 | 典型风险 |
| --- | --- | --- | --- | --- |
| Bot 实时消息 | `im` | bot | 订阅 `im.message.receive_v1`，只开放消息接收与回复所需 scope | 自动发言 |
| 主体用户消息补读 | `im` | user | 只在 `internal_visible` 或 `all_visible` 时启用聊天列表与消息读取 | 扩大可见正文范围 |
| 任务 | `task` | user | 启用任务读取；需要创建或更新时再增加写 scope | 创建、更新任务 |
| 日历 | `calendar` | user | 启用日程读取；需要提醒或建会时再增加写 scope | 邀请参会人、占用时间 |
| 文档正文 | `docs` | user | 只读取允许访问的文档；需要创建每日记忆时增加文档写入 | 创建或修改文档 |
| 控制台 Base | `base`、`drive` | user | 普通完整安装强制启用；复用已有 Base 时只读，自动初始化时增加创建 Base、建表和写入初始记录的能力 | 创建或修改控制资源 |
| 云空间与每日记忆目录 | `drive` | user | 读取指定文件夹；使用自动创建时增加 `space:folder:create` 或当前 schema 给出的等价写 scope | 创建目录；运行时写每日文档 |
| 企业知识库 | `wiki`、`drive`、内容对应 domain | user | 列出明确选择的空间；使用自动创建时增加 `wiki:space:write_only` 或当前 schema 给出的等价写 scope | 创建空间；跨空间引用信息 |

新实例默认采用 `bot_only + im,base`，其中 `base` 只用于强制控制台。只有部署者通过 `--capabilities` 选择其他能力，或高级模式用 `--domains` 选择声明式目录内的其他官方业务域后，才增量完成官方授权。`event` 是 `lark-cli event consume` 使用的保留基础设施域，不进入 `allowed_lark_domains`。不要默认使用 `--domain all`，不要申请组织管理、群成员管理或其他无关权限。

## 用当前 CLI 生成准确 scope

scope 名称可能随官方 CLI 和开放平台演进。不要把旧文档中的静态 scope 清单视为唯一来源，安装时使用当前版本核对：

```bash
lark-cli --profile <profile> auth scopes --json
lark-cli --profile <profile> auth check --scope "<space-separated-scopes>" --json
lark-cli schema <service.resource.method> --format json
```

对 user 身份缺少 scope 时，按明确 domain 或错误返回的 `missing_scopes` 增量授权。Bot 缺 scope 时在开发者后台处理，不能用 `auth login` 修复 Bot。

## setup 自动创建资源

只有部署者显式添加 `--create-missing-resources` 时，setup 才会创建缺失资源。它始终使用主体 user 身份，不扩大消息范围，也不修改成员、分享范围或权限：

| 资源 | 官方命令 | 2026-07-26 本机官方 schema 列出的 scope | 身份 |
| --- | --- | --- | --- |
| 控制 Base | `base +base-create` | Base 创建权限；当前 shortcut 未进入通用 `schema` 服务目录，以 `--dry-run` 或错误返回的 `missing_scopes` 为准 | 仅 user |
| 控制表 | `base +table-create` | 指定 Base 的建表权限；以当前 shortcut dry-run/错误为准 | 仅 user |
| 初始运行记录 | `base +record-upsert` | 指定表的记录写入权限；以当前 shortcut dry-run/错误为准 | 仅 user |
| 企业知识空间 | `wiki +space-create` | `wiki:space:write_only` 或 `wiki:wiki` | 仅 user |
| 每日记忆目录 | `drive +create-folder` | `space:folder:create` 或 `drive:drive` | user |

安装时仍应以当前 CLI 为准：

```bash
lark-cli schema wiki.spaces.create --format json
lark-cli schema drive.files.create_folder --format json
lark-cli base +base-create --help
lark-cli base +table-create --help
lark-cli base +record-upsert --help
```

setup 先执行 shortcut 的 `--dry-run`，再创建并只读验证。上述 Base、Wiki 和 Drive shortcut 当前均标记为 `Risk: write`；如果 CLI 返回 exit 10 或 `confirmation_required`，setup 会停止并提示，不会自行追加 `--yes`。缺少 user scope 时，错误返回 `missing_scopes`，只为当前 profile 增量授权后重试，不申请 `all`。自动创建只建立数字分身自己的 Base、两张表和初始记录，不调用角色、成员、高级权限或分享范围接口。

## 消息范围与事件

- `bot_only`：只需要 Bot 能收到和回复授权范围内的 `im.message.receive_v1`。
- `internal_visible`：额外需要主体用户读取企业内部群聊和私聊的能力。
- `all_visible`：补读范围还包括外部群，数据边界最大。

普通群消息不强制 `@` 只有在飞书平台确实把该消息事件交给应用时才成立。用以下命令核对事件定义和事件总线状态：

```bash
lark-cli --profile <profile> event schema im.message.receive_v1 --json
lark-cli --profile <profile> event status --current --json
```

## 写操作和固定禁令

官方 CLI 标记为 `high-risk-write` 的操作必须保留官方确认协议：先检查命令 `--help` 或使用 `--dry-run`，把目标和影响交给部署者确认，确认后才追加 `--yes`。不能看到确认错误就自动重试。

无论应用是否拥有对应 scope，数字分身都永久禁止自动执行所有权转让。其他已启用能力仍受收件身份、控制资源、冻结、去重和本机 domain 上限约束。

## 验证、错误与回退

成功后置条件：所选能力的 Bot/user 身份均能通过只读验证，事件订阅有效，缺失 scope 为空，本机 domain 不超过部署者选择。

遇到缺 scope、事件不可见或身份错误时，保持实例冻结或关闭对应能力；不要自动扩大 scope、切换身份、申请 `all` 或改动其他 profile。修复后重新执行 Doctor 和 `status`。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

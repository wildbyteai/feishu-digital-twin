# 实例配置参考

实例配置只保存稳定的非秘密引用和本机策略，位于 Git 工作区之外，由安装器以 `0600` 写入。普通配置不得包含 Token、API Key、Cookie、App Secret、二维码、Codex 端点、模型配置或认证材料。

中性结构示例见 [`config.example.json`](../../config.example.json) 和 [`config.full.example.json`](../../config.full.example.json)。生产配置不能直接复制示例中的占位值。

## 字段说明标准

下表逐项给出：用途、取得位置、敏感级别、保存方式、最小权限、默认值或范围、验证方法、成功后置条件、常见错误和安全回退。未列出的字段会被拒绝；任何层级出现秘密字段也会被拒绝。

## 顶层字段

| 字段 | 用途 | 取得位置 | 敏感级别 | 保存方式 | 最小权限 | 默认值或范围 | 验证方法 | 成功后置条件 | 常见错误 | 安全回退 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `schema_version` | 选择配置协议 | 产品 Schema | 公开 | 私有配置 | 无 | 新配置固定 `2`；只读兼容 `1` | setup/config 校验 | 能被当前版本读取 | 版本不支持 | 保持冻结并使用兼容配置 |
| `instance_id` | 便于区分实例 | 部署者命名 | 内部 | 私有配置 | 无 | 可选，1–64 位可移植标识 | Schema 校验 | 状态中能稳定关联实例 | 非法字符 | 改用中性逻辑名称 |
| `profile` | 指定官方 lark-cli 应用与授权 | `lark-cli profile list` | 内部 | 私有配置 | 读取本机 profile | 非空 | `auth status --verify` | user 与 bot 同时可用 | profile 不存在或选错租户 | 冻结并重新选择，不改全局默认 |
| `lark_cli_bin` | 固定后台使用的官方 CLI | PATH 或部署者指定 | 本机路径 | 私有配置 | 执行文件 | 可选，默认查找 `lark-cli` | setup 解析并检查可执行 | 后台使用同一真实文件 | 路径失效、符号链接 | 修复后重新 setup |
| `message_scope` | 设置消息发现上限 | 部署者选择 | 高敏数据边界 | 私有配置 | 对应消息读取权限 | `bot_only`、`internal_visible`、`all_visible` | setup 扩围确认 | Base/AI 无法扩权 | 未显式选择、扩围未确认 | 保持原范围或退回 `bot_only` |
| `codex_bin` | 指定后台 Codex | 部署者环境 | 本机路径 | 私有配置 | 执行文件 | 非空 | Codex Doctor | 后台可非交互执行 | PATH 不同、不可执行 | 冻结并使用新实例重新验证 |
| `codex_environment_root` | 指定隔离 Codex 环境 | 部署者创建 | 高敏环境引用 | 私有目录引用 | 当前用户读写 | 私有普通目录 | 权限检查与 Doctor | 不依赖 Codex 桌面会话 | 权限过宽、认证缺失 | 冻结；修复或新建实例 |
| `codex_timeout_ms` | 限制单次推理时间 | 部署者策略 | 普通 | 私有配置 | 无 | 1000–600000，默认 120000 | 合成 Doctor | 超时能失败关闭 | 过短频繁超时 | 调整后重新 Doctor |
| `max_ai_action_rounds` | 限制执行反馈循环 | 产品安全上限 | 普通 | 私有配置 | 无 | 1–3，默认 3 | Schema 与合成测试 | 不出现无界循环 | 超出上限 | 恢复到 1–3 |
| `production_data_approved` | 记录 Codex 数据处理许可 | 部署者明确确认 | 企业安全 | 私有配置 | 无 | 布尔值，默认 false | `--approve-production-data` | 未确认时生产失败关闭 | 错把登录等同于许可 | 冻结并重新确认真实环境 |
| `production_enabled` | 旧版本机运行开关 | 旧 v1 配置 | 内部 | 私有配置 | 无 | 仅 v1 兼容读取；v2 禁止 | config/status 兼容测试 | 旧实例可在升级后继续读取 | 与 v2 `control` 混用 | 保持冻结并显式迁移到 v2 |
| `control` | 选择唯一运行开关与规则来源 | 部署者选择 | 内部 | 私有配置 | 无 | v2 必填：`local` 或 `base`；v1 禁止 | setup/config 校验与 status 读回 | 不出现本机/Base 双开关 | 模式与子字段或规则来源冲突 | 冻结并保留一个权威来源 |
| `supplement_lookback_minutes` | 首次或断点恢复防漏窗口 | 调度策略 | 普通 | 私有配置 | user 消息读取 | 1–1440，默认 5 | 补读合成测试 | 只影响恢复回看，不改变轮询频率 | 误当调度间隔 | 恢复默认并检查 schedule |
| `console` | 引用飞书 Base 控制台 | 部署者选择已有 Base | 企业资源标识 | 私有配置 | 指定 Base 只读 | 仅 `control.mode=base` 时必填 | 读取两张表及唯一运行行 | 总开关、规则和域可读 | token/表名错误、字段缺失 | 冻结；修复引用或切回 local 模式 |
| `principal` | 定义主体用户和称呼 | lark-cli user 身份 | 企业身份 | 私有配置 | user 身份读取 | 必填对象 | setup 身份发现 | open_id 与授权用户一致 | 主体变化 | 新建实例，不能就地换主体 |
| `schedule` | 定义工作/安静时间与每日任务 | 部署者时区和工作制 | 内部 | 私有配置 | 无 | 必填对象 | Schema、服务计划读回 | 三个后台角色使用同一时区 | 起止时间反转 | 恢复默认计划后重装服务 |
| `daily_memory` | 指定每日工作记忆目录 | 部署者选择的 Drive 文件夹 | 企业资源标识 | 私有配置 | 目录读写、文档读写 | 可选 | 文件夹访问与写后读回 | 同日唯一文档可验证 | 文件夹失效、只读 | 冻结每日任务并重新选择目录 |
| `privacy` | 只能缩短保留时间和日志大小 | 部署者隐私策略 | 安全策略 | 私有配置 | 本机文件 | 可选，受硬上限约束 | config 校验与清理测试 | 运行态按期清理 | 配成无限期或过大 | 恢复公共安全默认值 |
| `allowed_lark_domains` | 设置飞书动作本机上限 | `--capabilities` 或高级 `--domains` | 高敏权限边界 | 私有配置 | 对应官方业务 domain | 目录白名单内的非空唯一列表，默认 `im`；不含 `event` | Schema、Guard 与官方 auth 检查 | Base 只能收紧 | 未知域、保留域、权限缺失 | 删除未授权域并保持冻结 |
| `group_rules` | 保存少量本机群级规则 | 部署者声明 | 企业规则与群标识 | 私有配置 | 无额外平台权限 | 仅 local 模式可选 | config 校验 | 仅匹配明确 chat_id | Base 模式与本机规则同时存在 | 统一迁入 Base 或保留 local 模式 |
| `authority_rules` | 保存 AI 自然语言职责和知识路由 | 部署者规则 | 企业规则 | 私有配置 | 规则涉及的能力权限 | 仅 local 模式可选 | prompt 合成测试 | 不突破可信硬门 | Base 模式与本机规则同时存在 | 统一迁入 Base“个性化规则”或保留 local 模式 |

新 setup 和公开示例都生成 v2。v1 仅用于读取旧实例，不会被后台静默改写：没有 `console` 时按 local 解释，有 `console` 时按 base 解释，并保留旧 `production_enabled` 与旧规则语义。迁移时应先冻结、停止服务，生成明确的 v2 候选，再使用 `config update` 和 Doctor 验证。

## `control` 子字段

| 模式 | 必需内容 | 禁止内容 | 含义 |
| --- | --- | --- | --- |
| `local` | `enabled` 布尔值 | `console` | 本机配置是唯一日常开关，可使用本机 `authority_rules` 和 `group_rules` |
| `base` | `console` | `enabled`、`authority_rules`、`group_rules` | Base 中的总开关和规则是唯一权威来源 |

## `principal` 子字段

| 字段 | 用途与取得位置 | 敏感级别与保存 | 最小权限与范围 | 验证、成功条件、错误与回退 |
| --- | --- | --- | --- | --- |
| `name` | 来自 user 身份显示名，可人工覆盖称呼 | 企业身份，私有配置 | user 身份读取；非空 | 自动发言使用预期称呼；错误时冻结并修正 |
| `open_id` | 固定主体用户身份 | 高敏企业标识，私有配置且不写日志 | user 身份读取；非空 | 必须与授权用户一致；变化时新建实例 |
| `timezone` | 解释工作时间和每日记忆日期 | 内部配置 | 有效 IANA 时区 | 格式化验证；错误时恢复部署地时区 |
| `address_names` | AI 可识别的主体称呼 | 企业规则，私有配置 | 字符串数组 | 至少包含当前 name；清理失效别名 |

## `schedule` 子字段

| 字段 | 默认值或范围 | 验证方法与后置条件 | 常见错误与安全回退 |
| --- | --- | --- | --- |
| `workdays` | 可选 ISO 1–7；默认周一至周五 | 唯一非空数组 | 重复或越界时恢复默认 |
| `workday_start_hour` | 0–23，默认 9 | 必须早于结束小时 | 反转时停止更新 |
| `workday_end_hour` | 1–24，默认 18 | 不包含结束时刻 | 设为开始时间会被拒绝 |
| `work_interval_seconds` | 30–86400，默认 30 | 工作时段补读计划读回 | 过小被拒绝，恢复 30 |
| `quiet_interval_seconds` | 30–86400，默认 300 | 非工作时段计划读回 | 误设成 30 秒会增加负载，可恢复 300 |
| `daily_memory_hour` | 0–23，默认 0 | 与主体时区一起验证 | 日期偏移时修正时区和小时 |
| `daily_memory_minute` | 0–59，默认 10 | 服务计划与结果日期一致 | 越界时恢复 10 |

## `console` 子字段

| 字段 | 用途和取得位置 | 权限、验证和后置条件 | 错误与回退 |
| --- | --- | --- | --- |
| `base_token` | 从明确选择的 Base URL 通过官方 `base +url-resolve` 获得 | user 读取指定 Base；`+base-get` 成功 | 不把 wiki token 或完整 URL当 token；失败时冻结 |
| `runtime_table` | 运行配置表的真实名称或 ID | 能列出字段且恰好一条运行记录 | 重名时用真实 table_id 消歧 |
| `group_rules_table` | 群级规则表的真实名称或 ID | 能列出字段和读取记录 | 表不存在时先修复，不自动新建生产资源 |

## `daily_memory` 子字段

| 字段 | 用途和取得位置 | 权限、范围与验证 | 错误与回退 |
| --- | --- | --- | --- |
| `folder_token` | 从部署者选择的 Drive 文件夹获得 | user 对该文件夹可读写；非空 | token 失效时暂停每日任务并重新选择 |
| `folder_name` | 用于人类核对目标目录 | 非空，不作为授权依据 | 名称不一致时以 token 读回结果为准 |
| `excluded_chat_ids` | 排除不进入每日记忆的聊天 | 唯一字符串数组 | 不公开或写日志；失效项可删除 |
| `excluded_topics` | 排除敏感话题或线程 | 可填写稳定 `thread_id`，或明确的 topic/title 文本；唯一字符串数组 | 在消息正文进入 Codex 前确定性过滤；缺少可比较元数据时删除该条并记录 `privacy_metadata_unavailable` |

## 普通 setup 的已有资源选项

| 配置结构 | setup 选项组 | 行为 |
| --- | --- | --- |
| `principal.address_names` | `--principal-aliases <称呼1,称呼2>` | 与当前主体名称去重后保存 |
| `control.mode=base` + `console` | `--console-base-token`、`--console-runtime-table`、`--console-group-rules-table` | 三项必须齐全；保存引用并只读校验两张表，不执行飞书写入 |
| local `authority_rules` | `--knowledge-space-name`、`--knowledge-space-id`、`--knowledge-direction` | 三项必须齐全；生成“企业知识库…”自然语言规则，不建设代码化路由表 |
| `daily_memory` | `--daily-memory-folder-token`、`--daily-memory-folder-name` | 两项必须齐全；排除列表默认为空 |

任一资源组缺项都在初始化或改动实例前失败关闭。setup 自动合并这些资源所需的官方业务域，并在 Doctor 中只读验真：Base 读取两张表，知识空间使用 `wiki +space-list` 匹配名称和 `space_id`，每日记忆目录使用 `drive files list` 对指定 `folder_token` 发起一页大小为 1 的真实可访问性查询。它不读取正文，也不创建、修改或写入这些资源。上述选项不能与 `--config` 混用。选择控制 Base 后，知识路由必须在 Base“个性化规则”中维护，不能同时传入 `--knowledge-space-*`。返回的 setup/status 摘要不回显 token、space ID、表名、目录名或主体别名。

## `privacy` 子字段

| 字段 | 公共默认与硬上限 | 验证和后置条件 | 错误与回退 |
| --- | --- | --- | --- |
| `state_retention_days` | 默认 7，最大 30 | 清理任务能删除过期最小状态 | 超限被拒绝，恢复 7 |
| `result_log_retention_days` | 默认 3，最大 7 | 只保留脱敏结果摘要 | 超限被拒绝，恢复 3 |
| `result_log_max_bytes` | 默认 1 MiB，最大 10 MiB | 超限轮转且不含正文 | 恢复 1 MiB |
| `signal_log_retention_days` | 默认 3，最大 7 | 只保留故障信号 | 恢复 3 |
| `signal_log_max_bytes` | 默认 256 KiB，最大 1 MiB | 超限轮转 | 恢复 256 KiB |

## 更新规则

- 普通规则、调度、保留期和已存在资源引用：先冻结、停止服务、执行 `config update`、Doctor、启动服务并读回，再恢复。
- 扩大 `message_scope`：必须额外执行本机范围确认。
- `codex_bin`、`codex_environment_root` 或主体 `open_id`：当前要求新建实例，不能就地替换。
- 创建 Base、文件夹或其他飞书资源：属于外部写入，先 `--dry-run` 预览并取得明确批准；本地 setup 失败不能假装远端资源已经回滚。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

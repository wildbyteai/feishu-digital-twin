# 完成全局配置

全局配置是普通部署者的最后一步。它发现主体用户和 Bot 身份、生成 Git 外私有配置、运行 Codex Doctor、安装后台服务、读回健康状态，最后才解除冻结。

## 主入口

```bash
feishu-digital-twin setup \
  --profile <profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --approve-production-data
```

`--profile` 可以显式指定。省略时，setup 只读调用官方 `lark-cli profile list`：只有一个 profile 时自动选择；有多个时返回可选清单并要求明确指定；没有可用 profile 时失败关闭，不修改其他 profile。

当前安全默认值：

- `message_scope=bot_only`；
- 仅启用 `im` domain；
- 周一至周五 09:00–18:00 每 30 秒补读；
- 其他时间每 5 分钟补读；
- 状态保留 7 天；
- 结果日志和信号日志保留 3 天；
- AI 执行反馈最多 3 轮。

## 消息范围

| 取值 | 读取范围 | 是否需要额外确认 |
| --- | --- | --- |
| `bot_only` | 只消费 Bot 官方实时事件 | 否 |
| `internal_visible` | 增加主体用户可见的企业内部群聊和私聊 | 是 |
| `all_visible` | 增加主体用户可见的全部群聊和私聊，包括外部群 | 是 |

首次使用非 `bot_only`，或扩大已有实例范围时，必须增加 `--approve-message-scope`。Base、AI 和普通飞书消息都不能修改这个本机权限上限。

## 飞书能力范围

普通路径使用 `--capabilities` 选择产品能力，由声明式目录生成去重的最小官方 lark-cli 业务域：

```bash
feishu-digital-twin setup \
  --profile <profile> \
  --codex-environment-root <private-codex-environment> \
  --capabilities message,task,calendar,docs \
  --approve-production-data
```

| 能力 | 生成的业务域 |
| --- | --- |
| `message` | `im` |
| `task` | `task` |
| `calendar` | `calendar` |
| `docs` | `docs,drive` |
| `base` | `base` |
| `enterprise_knowledge` | `drive,wiki,docs,base,sheets,markdown` |
| `daily_memory` | `im,task,calendar,drive,docs` |
| `console` | `base` |

高级部署者可用 `--domains` 直接提供声明式目录中的官方业务域，例如 `--domains im,task,contact,approval`。`--capabilities` 与 `--domains` 不能同时使用；未知值会结构化失败。`event` 只用于官方实时事件接线，不是业务权限域，不能写入 `allowed_lark_domains`。

能力和域参数只是本机执行上限，不代表应用和用户已经获得对应 scope。按能力授权和验证见[飞书最小权限参考](../reference/feishu-permissions.md)。控制 Base 只能继续收紧这个列表。

## 控制 Base、知识空间和每日记忆

普通 `setup` 可以用非交互、可脚本化的选项引用已有资源。它把稳定引用写入 Git 外 `0600` 私有配置，自动合并对应的最小官方业务域，并用官方 CLI 只读验真，不在输出中回显真实值。Base 和控制表只支持已有资源；知识空间与每日记忆目录既可以引用已有资源，也可以经明确开关自动创建。

使用飞书 Base 作为唯一控制和规则来源时：

```bash
feishu-digital-twin setup \
  --profile <profile> \
  --codex-environment-root <private-codex-environment> \
  --capabilities message,console,daily_memory \
  --console-base-token <base-token> \
  --console-runtime-table <运行配置表名或ID> \
  --console-group-rules-table <群级规则表名或ID> \
  --daily-memory-folder-token <folder-token> \
  --daily-memory-folder-name <文件夹名称> \
  --principal-aliases <称呼1,称呼2> \
  --approve-production-data
```

此时配置使用 `control.mode=base`，个性化规则、群级规则和知识空间路由统一在 Base 中维护。不能同时传入 `--knowledge-space-*`；setup 不会替你写 Base。

不使用 Base 控制台时，可把一个已有知识空间写成本机 AI 自然语言规则：

```bash
feishu-digital-twin setup \
  --profile <profile> \
  --codex-environment-root <private-codex-environment> \
  --capabilities message,enterprise_knowledge \
  --knowledge-space-name <知识空间名称> \
  --knowledge-space-id <space-id> \
  --knowledge-direction <适用业务方向> \
  --approve-production-data
```

控制 Base 的三个选项、知识空间的三个选项、每日记忆的两个选项都必须各自成组提供；任何缺项或官方只读验真失败都在修改实例前失败关闭。Base 会读取两张表，知识空间会核对名称和 `space_id`，每日记忆目标会核对为同一 folder token。这些引导选项不能与 `--config` 混用。高级部署者仍可单独使用 `setup --config <private-config>`；候选文件必须位于源码树之外并符合[配置参考](../reference/configuration.md)。

如果 `--capabilities` 选择了 `enterprise_knowledge` 或 `daily_memory`，但当前配置没有对应资源，setup 会在本机和飞书写入前返回：

- `missing_resources`：缺少 `enterprise_knowledge`、`daily_memory` 中的哪些资源；
- `existing_resource_options`：选择已有资源时需要提供的参数组；
- `automatic_creation_option=--create-missing-resources`：允许自动创建的显式开关。

没有现成资源时可直接运行：

```bash
feishu-digital-twin setup \
  --profile <profile> \
  --codex-environment-root <private-codex-environment> \
  --capabilities message,enterprise_knowledge,daily_memory \
  --create-missing-resources \
  --approve-production-data
```

自动创建只编排官方组件：

1. 用主体 user 身份按精确默认名称只读查找；
2. 未找到时执行官方 `--dry-run`；
3. 调用 `wiki +space-create` 或 `drive +create-folder`；
4. 再次只读查找并核对稳定 ID/token；
5. 写入 Git 外 `0600` 私有配置，继续原有 Doctor、服务安装和健康读回。

默认名称是 `<主体用户显示名>的数字分身知识库` 和 `<主体用户显示名>的每日工作记忆`，知识路由默认适用于全部业务方向。重复 setup 会复用唯一精确同名资源；多个同名资源时失败关闭，要求使用已有资源参数提供明确 ID/token。官方 CLI 若返回 exit 10，setup 不会静默追加 `--yes`。创建成功后若 Codex Doctor、后台服务或其他本机步骤失败，本机状态照常恢复，但已创建的飞书资源保留，错误会返回 `created_resources_retained` 和 `retry_safe=true`；修复后重跑即可复用。

`--create-missing-resources` 不能与 `--config` 混用，也不会创建 Base、控制表、修改 Base 规则或管理权限。使用 Base 控制模式时，知识空间路由仍由部署者在 Base 个性化规则中维护。详见[飞书 Base 控制台](../feishu-console.md)、[企业知识库](../features/enterprise-knowledge.md)、[每日工作记忆](../features/daily-memory.md)和[飞书最小权限参考](../reference/feishu-permissions.md)。

公开示例只能用于了解结构，不能原样作为生产配置。

## 成功与失败

成功后置条件同时满足：返回 `status=setup-complete`，三个后台角色均健康，实例已经解除冻结，私有配置和状态文件权限正确。运行开关已开启时 `readiness=ready`；Base 或本机开关明确关闭时允许 `readiness=safe-but-disabled`。`readiness=degraded` 必须失败并恢复调用前状态。

重复执行相同命令应收敛到同一状态。任何一步失败都会恢复调用前的配置、冻结状态和服务集合；新安装失败时，不留下半初始化的生产实例。自动创建的飞书知识空间和日报目录属于外部资源，不随本机回滚自动删除，以免误删；它们会在重试时精确复用。

常用运行入口：

```bash
feishu-digital-twin status
feishu-digital-twin control freeze
feishu-digital-twin control enable
feishu-digital-twin control upgrade --source <absolute-new-release-tree> --restart
feishu-digital-twin control rollback --restart
feishu-digital-twin control uninstall
```

完整运行说明见[后台运行与维护](../operations/runtime.md)，隐私边界见[隐私与数据处理](../security/privacy.md)。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

# 本地服务连续性硬门

这套硬门用于证明开源改造没有降低当前本地数字分身能力。它把“命令执行成功”和“服务实际健康”分开判断，默认只读取脱敏状态，不读取或输出消息正文、飞书标识符、服务标签、绝对路径、配置值或凭据。

## 配置边界

公开仓只提供 [`continuity.example.json`](../../continuity.example.json)。部署者把本机服务标签、日志位置和运行根写入 `.runtime/continuity.json`，文件权限必须为 `0600`，且该目录不会进入 Git。

因此，部署者姓名、服务命名和当前实例差异只存在于本机私有配置；公开示例始终使用中性占位符。安全规则、权限要求和健康判定仍固定在可信代码中，不能通过配置关闭。

私有清单的核心字段：

| 字段 | 用途 | 是否公开 |
| --- | --- | --- |
| `services[].label` | 当前用户的本机 LaunchAgent 标签 | 否 |
| `services[].signal_log` | 检查最新 `ready/error` 信号 | 否 |
| `state_database` | 只读检查冻结、去重和补读进度 | 否 |
| `private_roots` | 配置运行态与 Codex 私有根；其他私有数据根按需追加 | 仅结构公开，真实路径留本机 |
| `policy` | 补读和每日记忆的新鲜度上限 | 可以公开 |
| `git_isolation_required` | 源码/发布检查设为 `true`；无 Git 的正式安装实例可设为 `false` | 可以公开 |

## 命令与副作用

| 命令 | 行为 | 是否触碰真实飞书 |
| --- | --- | --- |
| `npm run continuity:check` | 只读检查 launchd、脱敏日志信号、只读 SQLite 聚合、权限和 Git 隔离 | 否 |
| `npm run continuity:capture` | 先只读检查，再新增一个 `0600` 基线文件；已存在时拒绝覆盖 | 否 |
| `npm run continuity:compare` | 只读复查并与基线比较 | 否 |
| `npm run continuity:exercise` | 在临时目录中使用临时配置、临时 SQLite 和 Fake Lark/Inference 演练成功与失败回退 | 否 |
| `npm run continuity:harden` | 把私有目录收紧为 `0700`，只把凭据、SQLite、日志和记忆等敏感文件收紧为 `0600` | 否 |
| `node bin/twin-continuity.mjs cleanup-auth .runtime/continuity.json` | 仅在 `authorization_complete=true` 时删除指定私有根内的临时授权图片 | 否 |

飞书 OAuth 继续由官方 `lark-cli` 完成，项目不重建授权回调。部署 Agent 在确认授权成功后应立即调用 `cleanup-auth`；该命令负责删除临时授权图，连续性门负责阻止遗漏的授权图或被 Git 跟踪的授权材料继续进入运行和发布流程。

`check`、`compare` 和 `exercise` 不重载任何服务。读取服务日志或 SQLite 前，会先用 `lstat`/`realpath` 审计全部私有根，符号链接根、损坏链接、逃逸链接或敏感名称链接会在任何服务探针前失败关闭。唯一例外是 Codex 自己在 `codex-home/tmp/arg0/codex-arg0*` 中生成的完整助手缓存：目录必须只含空 `.lock` 与 `applypatch`、`apply_patch`、`codex-execve-wrapper` 三个链接，三个链接必须指向同一个名为 `codex` 的普通可执行文件；该固定结构不可通过清单扩展，同名伪造、不完整缓存和其他外链仍失败关闭。`harden` 只改变权限，不修改文件内容；`harden` 和 `cleanup-auth` 同样拒绝通过符号链接根触碰项目外内容。`cleanup-auth` 只删除授权图或对应链接本身，不跟随链接目标，不删除普通配置或业务数据；配置的必需运行根缺失时直接失败。

`runtime` 与 `codex` 是正式产品必需的私有根；其他本机记忆、缓存或兼容数据根按部署情况追加，不再绑定 WorkBuddy。敏感文件类型、权限值和授权图清理规则由代码固定。SQLite 同目录中的 `*.privacy-key` 保存本机 HMAC 密钥，属于必须保持 `0600` 的敏感运行态；不得进入 Git、公共快照、日志或跨实例共享。源码仓和公共候选必须启用 Git 隔离；只有不包含 Git 工作树的正式安装实例才可关闭该项。清单不能用空数组、零时效或删除必需角色等方式弱化其他硬门。

## “实际健康”的判定

- 实时事件：LaunchAgent 已加载、进程处于 `running`、存在 PID，且脱敏日志的最新相关信号为 `ready`；基线同时保存累计运行次数、错误信号、结果解析错误、失败执行和 outbound 唯一性计数。
- 用户身份补读：LaunchAgent 已加载，最近退出成功或当前正在运行，最新运行时信号为 `ready`，并且 SQLite 中的最新补读游标未超过配置的新鲜度上限；累计运行次数不能超过“每 30 秒一次 + 2 次容差”，失败和重复成功执行不得增加。
- 每日工作记忆：LaunchAgent 已加载，最近退出成功或当前正在运行；最新摘要可解析、带目标日期，且结果时间未超过配置上限；累计运行次数不能超过“每天一次 + 1 次容差”，错误、失败和重复成功执行不得增加。
- 最小状态：记录冻结布尔值、已完成事件计数、补读聊天数/最新时间和过期日报锁数量，不读取或输出 ID、正文、动作参数和配置内容。
- 私有状态：所有受保护目录为 `0700`；凭据、授权材料、SQLite、`*.privacy-key`、日志和配置为 `0600`；授权完成后不得残留临时二维码。
- Git 隔离：`.runtime`、`.codex-runtime`、`.workbuddy`、本地配置、环境文件、认证材料、SQLite、`*.privacy-key`、日志和调试包必须被忽略；每个配置的私有根会用根级和嵌套级两个哨兵验证，任何已经跟踪且位于私有根下的路径都会失败，不依赖固定目录名。

定时任务退出码为 `0` 但补读游标陈旧时，硬门仍然失败。实时服务正在运行时，历史的平滑退出码不会覆盖当前 `running + ready` 事实。结果日志只累计 outcome 和执行状态，不保留或输出 `event_id`、正文、命令和确认内容。

`status:"duplicate"` 表示运行时成功阻止了重复执行，只作为观察计数，不视为重复写入。只有同一个非空 `execution_hash` 以 `status:"complete"` 重复出现，才记为重复成功执行并使硬门失败；成功执行缺少 hash 时同样失败关闭。

## 每项改造的固定流程

1. 运行完整测试和 `continuity:check`，确认当前真实服务健康。
2. 使用新的文件名执行 `continuity:capture`，保存本任务的前置基线；命令不会覆盖已有证据。
3. 优先在临时配置、临时 SQLite 和 Fake 适配器中验证改动；不得用真实飞书写操作测试开源重构。
4. 小步修改并保留用户已有工作。确需切换运行态时，一次只处理一个服务角色，并事先准备仅覆盖本任务的回退动作。
5. 执行相关测试、完整测试、`git diff --check`、`continuity:check` 和 `continuity:compare`。
6. 若服务状态、冻结状态、去重进度、补读游标或每日记忆结果偏离基线，立即回退本任务；回退后必须再次通过同一只读检查。

`runControlledChange` 固定了“前置检查 → 隔离测试 → 应用变更 → 单服务切换 → 后置检查 → 失败回退 → 同服务恢复 → 回退复验”的顺序。仓库中的 `continuity:exercise` 只使用 Fake 服务证明这条链路，不作为用户侧 Demo。

未计划重载时，`compare` 不允许实时服务累计运行次数增加。已明确授权且确需平滑重载实时服务时，只能允许一次：

```bash
node bin/twin-continuity.mjs compare \
  .runtime/continuity.json \
  .runtime/continuity-baseline.json \
  1
```

允许值只能是 `0` 或 `1`；错误、失败和重复成功执行计数仍不得增加。补读与日报的正常计划运行按基线间隔自动计算，不需要额外放宽。

## 当前本地实例初始化

首次启用硬门时：

1. 从公开示例生成 `.runtime/continuity.json`，填入当前实例的三个本机服务标签与两个必需私有根；有额外私有数据根时再追加。
2. 确认飞书授权已经成功后，才把 `authorization_complete` 设为 `true`。
3. 运行 `continuity:harden` 和 `cleanup-auth`。
4. 运行 `continuity:check`；只有 `healthy:true` 才能捕获正式基线。

任何检查报告都只能作为本机证据保存，不应粘贴到公开 Issue；需要分享时只报告角色级结果、测试数量和是否发生回退。

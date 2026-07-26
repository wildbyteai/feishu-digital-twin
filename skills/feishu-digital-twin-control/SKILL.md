---
name: feishu-digital-twin-control
description: 安装、配置、诊断和控制本机飞书数字分身。用于初始化、首次配置、Doctor、状态查看、冻结、恢复、后台服务安装启停、升级、回退和卸载；不负责飞书业务消息本身的判断与回复。
---

# 飞书数字分身控制

使用公开伴随运行时的统一命令 `feishu-digital-twin`，不要直接修改 launchd、SQLite、版本指针或插件缓存。

## 操作映射

- 首次安装或安全更新：`feishu-digital-twin setup --config <绝对配置路径> --lark-cli <绝对飞书 CLI 路径> --codex-bin <绝对 Codex 路径> --codex-environment-root <绝对 Codex 环境目录> --approve-production-data`
- 首次选择 `internal_visible` / `all_visible`，或扩大已有消息范围：在上述命令追加 `--approve-message-scope`
- 仅初始化冻结实例（高级排障）：`feishu-digital-twin init`
- 仅配置未配置实例（高级排障）：`feishu-digital-twin configure --config <绝对配置路径> --lark-cli <绝对飞书 CLI 路径> --codex-bin <绝对 Codex 路径> --codex-environment-root <绝对 Codex 环境目录> --approve-production-data`
- 环境检查：`feishu-digital-twin doctor`
- 当前状态：`feishu-digital-twin status`
- 启用自动处理：`feishu-digital-twin control enable`
- 暂停自动处理：`feishu-digital-twin control freeze`
- 安装并启动后台服务：`feishu-digital-twin service install`
- 只安装服务定义：`feishu-digital-twin service install --no-start`
- 启动、停止或重启：`feishu-digital-twin service start|stop|restart`
- 后台服务状态：`feishu-digital-twin service status`
- 升级当前运行时：`feishu-digital-twin control upgrade`
- 回退上一验证版本：`feishu-digital-twin control rollback`
- 卸载服务和公开运行时、保留私有数据：`feishu-digital-twin control uninstall`
- 连私有数据一并删除：`feishu-digital-twin uninstall --purge`

## 执行规则

1. 状态和 Doctor 是只读操作，可以直接执行。
2. 用户明确要求安装、配置、冻结、恢复、启停、升级、回退或卸载时，可以执行对应命令；没有明确要求时只说明影响，不自行改变后台服务。
3. 普通用户路径优先使用幂等 `setup`。它会先冻结，验证飞书双身份、Codex 结构化输出、配置和服务健康，再在全部读回成功后启用；失败时恢复调用前状态。
4. `message_scope` 必须明确写入配置。`bot_only` 无需额外范围确认；首次使用非 `bot_only` 或扩大已有范围时必须要求用户明确同意，并传入 `--approve-message-scope`。Base、AI 和普通消息都不能扩大该范围。
5. 项目把 Codex CLI 当作黑盒，不读取、不复制也不切换其内部模型、Provider、端点或认证配置。候选实例配置不得包含凭据、模型端点或 Codex 认证内容；更换 `codex_bin` 或 `codex_environment_root` 时创建新实例。
6. 普通卸载默认保留本机私有配置、状态和业务数据。只有用户明确要求彻底删除时才使用 `--purge`。
7. 不运行内部命令 `service run`，它只供系统后台 launcher 使用。
8. 不打印或转述凭据、Token、二维码、真实飞书标识、消息正文、配置全文或本机绝对路径。
9. Doctor 失败时只说明失败的检查名称和建议动作，不通过绕过授权、降低文件权限或复制认证文件来修复。

所有飞书业务动作继续交给官方 `lark-cli` 与对应 lark-* Skills；本 Skill 只管理产品生命周期。

# 兼容性

## 当前支持矩阵

| 组件 | 首个稳定版要求 |
| --- | --- |
| 操作系统 | macOS；使用用户级 LaunchAgent 托管后台角色 |
| Node.js | `>=22.13.0` |
| 飞书 CLI | 官方 `lark-cli`，安装时使用当前版本帮助、schema 和 Doctor 验证 |
| Codex CLI | 支持非交互 `codex exec --ephemeral` 与结构化输出 |
| 飞书身份 | 同一 profile 中可用的 Bot 与主体用户身份 |
| 分发版本 | 源码、Codex 插件和 npm 伴随运行时版本必须一致 |
| 能力包契约 | capability pack `schema_version` 当前只支持 `1`；支持查询能力及确认型动作；`pack_version` 必须为三段语义版本 |

项目绑定的是 Codex CLI 行为契约，不绑定官方模型、自定义模型、API 服务或 Provider 品牌。项目不直接解析 Codex 的认证、模型、端点或 Provider 配置文件；仅在实例显式开启 MCP 复用时，通过 Codex CLI 查询能力包声明的精确 server reference，并只接受校验后的 stdio transport。部署者负责确认实际环境允许处理目标飞书数据。

## 已知边界

- Codex 桌面关闭不影响 LaunchAgent，但电脑关机、用户未登录或系统深度睡眠期间不能实时处理；恢复后由事件与补读游标防漏。
- Bot 入口使用官方实时事件；主体用户入口仍通过有节奏的消息补读完成。
- 不保存长期聊天库，复杂讨论按需向前补取有限上下文。
- 确认型动作的令牌、确认文本和提交参数不持久化；数据库只保存不透明 `action_id`。拒绝、取消、过期或服务重启后必须重新准备。
- 首个稳定版不声明 Linux、Windows 或共享多租户 SaaS 支持。
- `lark-channel-bridge` 不进入依赖树；只有经隔离验证的第一方 Channel SDK 能减少代码且不改变行为时，才替换 Bot 事件接线。

## 能力配置兼容

旧配置未声明 `private_capability_packs`、`allowed_capabilities`、`required_capabilities` 或 `reuse_codex_mcp_servers` 时仍可读取：没有私有包的旧配置得到空能力集合，缺少精确复用开关时不会读取 Codex MCP 配置，原有飞书消息和命令行为不变；缺少 `public_web_search_approved` 的配置继续保持公开联网关闭。公开示例显式使用三个空数组并将两个外部边界开关设为 false，避免把兼容省略误认为自动联网或发现本机 MCP。

能力包以 `schema_version: 1` 作为结构兼容边界。旧的纯查询能力包无需增加 `actions` 或 `readiness_check`；需要登录态的包可选声明一个只读授权健康工具。动作型包可以只声明 `actions`，但查询和动作不能同时为空。未知 schema 失败关闭；`pack_version` 只作为部署者审计和升级标识，任何版本仍要重新通过完整 Schema、工具风险、`internal` 信任域、精确工具白名单、输入限制和确认映射校验。相同 `pack_id` 的 MCP server reference、工具、授权健康检查、操作、信任域、确认映射或输入边界发生变化时，必须通过 setup 重新提供 manifest，并重新确认对应信任域。

`reuse_codex_mcp_servers: true` 只允许运行时对已安装能力包中的精确 server reference 执行 `codex mcp get`，不列举或复用其他本机 MCP。MCP `tools/list` 必须明确证明查询和授权健康工具为只读、准备工具为非破坏性、提交工具为破坏性，否则相应能力显示 `unavailable`。授权健康工具返回未就绪时，Doctor 使用稳定代码 `CAPABILITY_NOT_READY`，且不会调用业务查询或审批工具。

普通 `config update --config` 只能从 `allowed_capabilities`、`required_capabilities` 和 `private_capability_packs` 中删除项目或缩小集合；新增包、开启 Codex MCP 复用或扩大能力上限必须重新 setup。Base“允许能力”和群级规则只能继续收紧本机上限，不能用于升级 schema、改变绑定或恢复已撤销能力。

## 验证与升级

安装前运行飞书 CLI 身份与事件检查、Codex Doctor，并通过同一无标签命令运行 `status`。升级先安装到隔离版本目录，验证后原子切换；失败自动切回上一已验证版本。服务重启会使所有仅驻留内存的待确认业务动作失效，用户必须重新发起准备。飞书 CLI、Codex 或私有 MCP 发生重大升级后，应重新运行 setup/Doctor，再恢复生产处理。

Linux 或 Windows 只有在相应 ServiceHost、睡眠恢复、路径权限、升级回退和完整能力矩阵通过独立验收后，才可以加入支持矩阵。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

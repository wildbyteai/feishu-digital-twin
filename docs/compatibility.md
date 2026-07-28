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
| 能力包契约 | capability pack `schema_version` 当前只支持 `1`；`pack_version` 必须为三段语义版本 |

项目绑定的是 Codex CLI 行为契约，不绑定官方模型、自定义模型、API 服务或 Provider 品牌。项目不读取 Codex 内部配置；部署者负责确认实际环境允许处理目标飞书数据。

## 已知边界

- Codex 桌面关闭不影响 LaunchAgent，但电脑关机、用户未登录或系统深度睡眠期间不能实时处理；恢复后由事件与补读游标防漏。
- Bot 入口使用官方实时事件；主体用户入口仍通过有节奏的消息补读完成。
- 不保存长期聊天库，复杂讨论按需向前补取有限上下文。
- 首个稳定版不声明 Linux、Windows 或共享多租户 SaaS 支持。
- `lark-channel-bridge` 不进入依赖树；只有经隔离验证的第一方 Channel SDK 能减少代码且不改变行为时，才替换 Bot 事件接线。

## 能力配置兼容

旧配置未声明 `private_capability_packs`、`allowed_capabilities` 或 `required_capabilities` 时仍可读取：没有私有包的旧配置得到空能力集合，原有飞书消息和动作行为不变；缺少 `public_web_search_approved` 的配置继续保持公开联网关闭。公开示例显式使用三个空数组，避免把兼容省略误认为自动发现本机 MCP。

能力包以 `schema_version: 1` 作为结构兼容边界。未知 schema 失败关闭；`pack_version` 只作为部署者审计和升级标识，任何版本仍要重新通过完整 Schema、只读风险、`internal` 信任域、精确工具白名单和输入限制校验。相同 `pack_id` 的 MCP server reference、工具、操作、信任域或输入边界发生变化时，必须通过 setup 重新提供 manifest，并重新确认对应信任域。

普通 `config update --config` 只能从 `allowed_capabilities`、`required_capabilities` 和 `private_capability_packs` 中删除项目或缩小集合；新增包或扩大能力上限必须重新 setup。Base“允许能力”和群级规则只能继续收紧本机上限，不能用于升级 schema、改变绑定或恢复已撤销能力。

## 验证与升级

安装前运行飞书 CLI 身份与事件检查、Codex Doctor，并通过同一无标签命令运行 `status`。升级先安装到隔离版本目录，验证后原子切换；失败自动切回上一已验证版本。飞书 CLI 或 Codex 发生重大升级后，应重新运行 setup/Doctor，再恢复生产处理。

Linux 或 Windows 只有在相应 ServiceHost、睡眠恢复、路径权限、升级回退和完整能力矩阵通过独立验收后，才可以加入支持矩阵。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

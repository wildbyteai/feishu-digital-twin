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

项目绑定的是 Codex CLI 行为契约，不绑定官方模型、自定义模型、API 服务或 Provider 品牌。项目不读取 Codex 内部配置；部署者负责确认实际环境允许处理目标飞书数据。

## 已知边界

- Codex 桌面关闭不影响 LaunchAgent，但电脑关机、用户未登录或系统深度睡眠期间不能实时处理；恢复后由事件与补读游标防漏。
- Bot 入口使用官方实时事件；主体用户入口仍通过有节奏的消息补读完成。
- 不保存长期聊天库，复杂讨论按需向前补取有限上下文。
- 首个稳定版不声明 Linux、Windows 或共享多租户 SaaS 支持。
- `lark-channel-bridge` 不进入依赖树；只有经隔离验证的第一方 Channel SDK 能减少代码且不改变行为时，才替换 Bot 事件接线。

## 验证与升级

安装前运行飞书 CLI 身份与事件检查、Codex Doctor 和 `feishu-digital-twin status`。升级先安装到隔离版本目录，验证后原子切换；失败自动切回上一已验证版本。飞书 CLI 或 Codex 发生重大升级后，应重新运行 setup/Doctor，再恢复生产处理。

Linux 或 Windows 只有在相应 ServiceHost、睡眠恢复、路径权限、升级回退和完整能力矩阵通过独立验收后，才可以加入支持矩阵。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

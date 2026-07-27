# 接入飞书官方 CLI

这一步只负责准备飞书应用、Bot 实时事件和主体用户授权。应用凭据、OAuth Token、二维码和登录态始终由官方 `lark-cli`、系统 Keychain 或飞书授权页管理，不能写入数字分身配置。

## 1. 安装与版本检查

使用飞书官方安装入口：

```bash
npx @larksuite/cli@latest install
lark-cli --version
```

安装器完成后，列出本机已有 profile：

```bash
lark-cli profile list
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 profiles
```

产品命令只读转发官方 profile 枚举，不切换当前 profile。不要为了安装数字分身切换、重命名或删除已有 profile。多个 profile 时，后续命令始终显式带 `--profile <profile>`，避免误用其他应用或租户；只有一个可用 profile 时 setup 可以自动选择。

## 2. 验证 Bot 与主体用户身份

```bash
lark-cli --profile <profile> auth status --json --verify
lark-cli --profile <profile> whoami --as user
lark-cli --profile <profile> whoami --as bot
```

成功后置条件：同一 profile 中的 user 身份已验证、用户 Token 有效并能返回主体用户；bot 身份可用且属于预期应用。数字分身的 `setup` 会再次执行无正文验证，但不会输出用户 ID、Token 或应用 Secret。

Bot scope 与 User OAuth 是两层权限：开发者后台给应用开通 scope 不代表用户已经授权；用户完成 OAuth 也不能补上 Bot 缺失的应用 scope。Bot 缺 scope 时在开发者后台处理，不要对 Bot 执行 `auth login`。

## 3. 配置实时消息事件

在飞书开发者后台为应用配置 `im.message.receive_v1`，并按实际群聊使用方式设置 Bot 可见范围。普通群消息不强制 `@` 的前提，是应用本身能够收到对应消息事件；数字分身不能绕过飞书平台的可见范围。

用官方 CLI 核对事件定义和本机事件总线：

```bash
lark-cli --profile <profile> event schema im.message.receive_v1 --json
lark-cli --profile <profile> event status --current --json
```

`event consume` 会由后台服务启动，普通安装不要同时手工启动第二个无限消费进程。

## 4. 按能力核对最小权限

先查看应用当前开放的 scope，再检查当前用户 Token 是否具备需要的 scope：

```bash
lark-cli --profile <profile> auth scopes --json
lark-cli --profile <profile> auth check --scope "<space-separated-scopes>" --json
```

具体能力与 domain 的选择见[飞书最小权限参考](../reference/feishu-permissions.md)。优先按 domain 或明确缺失的 scope 增量授权，不要默认申请 `all`，也不要申请组织管理、成员管理或与数字分身能力无关的权限。

## 敏感级别与保存方式

| 内容 | 敏感级别 | 保存方式 |
| --- | --- | --- |
| profile 名称 | 内部配置 | Git 外实例配置可保存引用 |
| App Secret、Token、二维码、device code | 高敏凭据 | 仅官方 CLI、Keychain 或授权流程管理 |
| 主体用户与应用身份 | 企业标识 | 安装器只保存运行所需稳定引用，不写日志 |
| scope 与事件清单 | 内部安全配置 | 可在本机核对，不复制到公开 Issue |

## 常见错误与安全回退

- profile 不存在：重新执行 `profile list`，显式选择正确 profile，不切换全局默认值。
- user Token 过期：仅对目标 profile 重新完成 user 授权。
- bot 不可用：检查应用配置和 Bot 能力，不执行 user OAuth 代替 Bot 配置。
- 缺少 scope：根据错误中的 `missing_scopes` 或官方 schema 增量授权。
- 事件未到达：检查开发者后台事件订阅、应用版本和可见范围，然后再看 `event status`。

已运行实例出现上述问题时，先通过当前稳定标签运行 `freeze`。修复目标 profile 后重新运行 Doctor 或 `setup`；不要删除其他 profile，也不要用另一身份静默重试生产动作。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

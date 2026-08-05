# 安全切换飞书 CLI 组织与登录 Profile

本文用于把一台电脑上的飞书官方 CLI 从旧组织切换到目标组织。操作范围仅限本机的 CLI profile、OAuth 登录态和默认 profile，不迁移或删除任何飞书云端数据，也不删除开发者后台应用。

示例目标：

- 组织：`上海传美实业（saselomo）`
- 目标 profile：`saselomo`

实际执行时应先替换为本人的目标组织和 profile。不要根据 profile 名称猜测组织归属。

## 可直接交给 Codex 的指令

复制以下内容，在需要切换的电脑上交给 Codex 执行：

```text
请协助将本机飞书 CLI 从旧组织切换到新的 <目标组织名称> 组织，目标 profile 为 <目标 profile>。

本任务只处理本机的 CLI profile 和登录凭据，不迁移或删除任何飞书云端数据，也不要删除开发者后台应用。请严格按以下要求执行：

1. 先只读列出现有飞书 CLI profiles，并逐个核验实际登录用户、组织/租户身份、用户与 Bot 状态、Token 有效性和授权范围。旧 profile 名称可能不同，禁止仅凭名称猜测。
2. 全程禁止输出或保存 App Secret、Access Token、Refresh Token、Cookie、device code 等敏感信息；对 App ID、Open ID、租户标识和授权链接也只在确有必要时最小化展示。
3. 只读检查项目脚本、有效配置、环境变量、shell 启动文件、cron、LaunchAgent 和 Codex 自动化是否引用现有 profile。测试夹具、示例文档与真实运行配置应区分报告。
4. 将识别出的旧组织 profile 候选、登录用户、Token 状态、授权范围摘要及删除影响展示给我。得到我对具体 profile 名称的明确确认后，才允许注销并删除其本地登录状态和 profile。
5. 删除只限本机：
   - `auth logout` 只清除目标 profile 的本机用户登录 Token；
   - `profile remove` 只删除目标本机 profile 和关联本地凭据；
   - 不撤销飞书服务端授权，不删除云端文件、消息、日程、Base、Wiki 或其他业务数据；
   - 不删除或修改开发者后台应用。
6. 检查是否已存在 <目标 profile>：
   - 如存在，先核验并复用，禁止覆盖；
   - 如不存在，创建独立 profile；
   - 如果无法确认该 profile 对应 <目标组织名称>，立即停止并询问。
7. 新组织用户授权遵循最小权限原则：
   - 初始只申请 `auth:user.id:read`；
   - 允许 OAuth 必需的 `offline_access`；
   - 不默认申请任何业务 domain；
   - 禁止使用 `--domain all`；
   - 后续业务权限必须根据实际缺失 scope 逐项增加。
8. 认证必须使用飞书官方设备授权流程：
   - 使用 `auth login --scope "auth:user.id:read" --no-wait --json` 发起；
   - 根据官方 verification URL 生成并展示二维码；
   - 等我完成授权并回复后，由你继续运行 `auth login --device-code ...`；
   - 不要求我在终端手工输入或复制 device code；
   - 授权完成后清理临时二维码。
9. 授权完成后，先显式指定 <目标 profile> 验证：
   - `whoami` 显示正确 profile 和登录用户；
   - `auth status --json --verify` 返回服务端验证成功；
   - 用户 Token 有效；
   - 用户和应用属于预期组织/租户；
   - 实际授权仅包含本次需要的最小范围。
10. 验证通过后，才将 <目标 profile> 切换为默认 profile。再用不带 `--profile` 的 `whoami` 和 `auth status --verify` 读回确认。
11. 最后汇报：
   - 删除了哪些旧本地 profiles；
   - 保留了哪些 profiles；
   - 当前默认 profile；
   - 新组织登录用户；
   - 已授权 scope；
   - Token 与身份验证结果；
   - 仍需人工处理的脚本、配置或自动化引用；
   - 明确声明未操作任何飞书云端数据和开发者后台应用。

任何时候如果无法准确确认旧组织、目标组织、登录用户、影响范围或配置用途，立即停止并询问。禁止猜测、覆盖、批量修改或删除。
```

用于上海传美实业时，将两个占位符替换为：

```text
<目标组织名称> = 上海传美实业（saselomo）
<目标 profile> = saselomo
```

## 人工执行参考

下面的命令用于理解和复核流程。除明确标注的步骤外，不应跳过确认门。

### 1. 枚举并核验现有 profiles

```bash
lark-cli profile list
lark-cli --profile <候选 profile> whoami
lark-cli --profile <候选 profile> auth status --json --verify
lark-cli --profile <候选 profile> auth list --json
```

不要在聊天、工单、截图或日志中公开完整命令输出。汇报时只保留 profile 名、用户名、身份状态、Token 是否有效和 scope 名称摘要。

若需要确认用户所属租户，可使用用户身份只读接口，并对输出做脱敏：

```bash
lark-cli --profile <候选 profile> api GET /open-apis/authen/v1/user_info --as user
```

该接口可能只返回租户标识而不返回可读组织名称。不能准确映射组织时必须让用户确认，不能自行推断。

### 2. 检查引用影响

至少检查以下位置：

- 当前项目中的 `--profile`、profile 配置字段和相关环境变量；
- shell 启动文件；
- 当前进程与 LaunchAgent 环境变量；
- cron；
- macOS `~/Library/LaunchAgents`；
- Codex 自动化；
- 产品实例的私有配置。

只报告匹配位置和 profile 引用，不要打印同一文件中的 Token、Secret、Cookie 或业务数据。

### 3. 删除旧本地 profile

以下命令具有本机写入和凭据删除效果。必须在用户明确确认具体 profile 后执行：

```bash
lark-cli --profile <已确认旧 profile> auth logout --json
lark-cli profile remove <已确认旧 profile>
```

成功后重新运行 `lark-cli profile list`。不得把删除本地 profile 扩展为撤销服务端授权或删除开发者后台应用。

### 4. 复用或创建目标 profile

如果目标 profile 已存在，应先核验并复用，不要覆盖。只有目标 profile 不存在时，才根据飞书官方 CLI 当前版本的 `profile add` 或 `config init` 流程创建独立配置。

创建应用配置需要 App Secret 时，应通过 CLI 的安全输入或系统 Keychain 完成，禁止把 Secret 写入命令行参数、脚本、Markdown、终端日志或 Git。

### 5. 发起最小用户授权

```bash
lark-cli --profile <目标 profile> auth login \
  --scope "auth:user.id:read" \
  --no-wait \
  --json
```

将返回的官方 verification URL 原样交给用户，并使用 CLI 生成二维码：

```bash
lark-cli auth qrcode '<verification URL>' --output <临时二维码文件>
```

用户完成授权后，由执行助手使用本次设备流程的 device code 完成登录。不得公开、长期保存或要求用户手工处理 device code。

### 6. 验证并设置默认 profile

```bash
lark-cli --profile <目标 profile> whoami
lark-cli --profile <目标 profile> auth status --json --verify
lark-cli --profile <目标 profile> api GET /open-apis/authen/v1/user_info --as user
```

验证通过后：

```bash
lark-cli profile use <目标 profile>
lark-cli whoami
lark-cli auth status --json --verify
lark-cli profile list
```

最终应满足：

- 目标 profile 是默认 profile；
- 实际生效身份为正确用户；
- 用户与 Bot 状态符合预期；
- `verified` 为真且用户 Token 有效；
- 初始用户授权只有 `auth:user.id:read` 与 OAuth 必需的 `offline_access`；
- 旧 profile 已按确认清除；
- 其他 profile 和云端数据未受影响。

## Keychain 与沙箱说明

macOS 上的 CLI 凭据可能由系统 Keychain 管理。在沙箱或自动化环境中出现 `keychain not initialized`，不代表 Token 已失效。应优先在获准的本机交互环境中重新执行只读核验。

不要为了绕过沙箱默认执行 `config keychain-downgrade`。该操作会改变凭据保护方式，只有用户理解风险并明确同意后才能执行。

## 安全边界

- 不在 GitHub、Issue、PR 或聊天中粘贴真实凭据、二维码、授权链接或完整身份标识。
- 不通过 profile 切换迁移、复制或删除任何飞书云端数据。
- 不自动撤销服务端授权。
- 不删除或覆盖开发者后台应用。
- 不因名称相似而认定 profile 属于某个组织。
- 不修改未获确认的生产脚本、服务、LaunchAgent 或自动化。
- 权限不足时按缺失 scope 增量申请，不使用 `--domain all`。

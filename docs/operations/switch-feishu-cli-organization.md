# 在 Codex 中切换飞书 CLI 组织与 Profile

本文只用于在 Codex 中切换本机官方 `lark-cli` 的组织、登录用户和默认 profile。

- 不要求安装或使用 WorkBuddy；
- 不清理 WorkBuddy 缓存；
- 不迁移或删除任何飞书云端数据；
- 不删除开发者后台应用；
- 不撤销飞书服务端授权。

如果不确定应该使用哪份手册，请先阅读[飞书组织切换前置路由](switch-feishu-organization.md)。

## 适用前提

这是“切换已绑定 CLI 环境”的操作手册，不是安装或首次接入教程。开始前默认满足：

- 本机已经安装并使用过官方 `lark-cli`；
- `lark-cli` 命令在 Codex 的终端环境中可直接运行；
- 本机存在旧 profile，或保留着可核验的旧登录/配置痕迹；
- 用户有权管理本机 CLI profile。

如果 `lark-cli` 突然不可执行，应先报告 PATH、终端、权限或执行环境变化。不要在本流程中擅自重装 CLI、初始化全新环境或覆盖已有绑定。

本文支持 macOS 和 Windows。profile、OAuth 和身份验证命令相同；平台差异主要在本机引用扫描和凭据存储。

## 可直接交给 Codex 的指令

复制以下内容，在 Codex 中执行：

```text
请协助将本机飞书 CLI 从旧组织切换到 <目标组织名称>，目标 profile 为 <目标 profile>。

本机此前已经安装并绑定过飞书 CLI。本任务只处理本机官方 lark-cli 的 profile、默认 profile 和登录凭据；不处理 WorkBuddy，不迁移或删除任何飞书云端数据，不删除开发者后台应用，不撤销服务端授权，也不重新安装 CLI。请严格按以下流程执行：

1. 识别当前操作系统，并确认现有 lark-cli 命令可执行。如果不可执行，立即报告 Codex 终端的 PATH、权限或运行环境问题，不要重装 CLI、运行全新初始化或覆盖旧配置。
2. 只读列出现有 lark-cli profiles，并逐个核验实际登录用户、组织/租户、用户与 Bot 状态、Token 有效性和授权范围。旧 profile 名称可能不同，禁止仅凭名称猜测。
3. 全程禁止输出或保存 App Secret、Access Token、Refresh Token、Cookie、device code 等敏感信息；App ID、Open ID、租户标识和授权链接也只在确有必要时最小化展示。
4. 只读检查项目脚本、有效配置、环境变量和自动化是否引用现有 profile：
   - macOS：shell 启动文件、cron、LaunchAgent、launchctl 环境；
   - Windows：PowerShell Profile、用户/系统环境变量、任务计划程序、Windows 服务、启动目录和注册表 Run 项；
   - 两个平台：Codex 自动化和产品实例私有配置。
5. 区分测试夹具、示例文档和真实运行配置。只报告匹配位置、profile 名和影响，不打印同一文件中的 Token、Secret、Cookie 或业务数据。
6. 将识别出的旧组织 profile 候选、登录用户、Token 状态、授权范围摘要、引用影响、拟保留 profiles 和拟删除 profiles 展示给我。
7. 得到我对具体旧 profile 名称的明确确认后，才允许执行 auth logout 和 profile remove。删除仅限本机：
   - auth logout 只清除目标 profile 的本机用户 Token；
   - profile remove 只删除该本机 profile 和关联本地凭据；
   - 不撤销服务端授权，不删除云端文件、消息、日程、Base、Wiki 或开发者后台应用。
8. 检查 <目标 profile>：
   - 已存在：先核验并复用，禁止覆盖；
   - 不存在：在现有 CLI 环境中创建独立 profile；
   - 无法确认该 profile 属于 <目标组织名称>：立即停止并询问。
9. 新组织用户授权遵循最小权限原则：
   - 初始只申请 auth:user.id:read；
   - 允许 OAuth 必需的 offline_access；
   - 不默认申请任何业务 domain；
   - 禁止使用 --domain all；
   - 后续业务权限根据真实 missing_scopes 逐项增加。
10. 使用飞书官方设备授权 split-flow：
    - auth login --scope "auth:user.id:read" --no-wait --json；
    - 将官方 verification URL 原样展示；
    - 使用 lark-cli auth qrcode 生成并展示二维码；
    - 等我完成授权并回复后，由你继续 device-code 流程；
    - 不要求我手工输入 device code，不公开或长期保存 device code；
    - 完成后清理临时二维码。
11. 授权完成后，先显式指定 <目标 profile> 验证：
    - whoami 显示正确 profile 和用户；
    - auth status --json --verify 返回 verified；
    - 用户 Token 有效；
    - 用户和应用属于预期组织/租户；
    - 实际授权符合最小范围。
12. 验证通过后，才执行 profile use <目标 profile>。随后用不带 --profile 的 whoami、auth status --json --verify 和 profile list 读回确认。
13. 最后汇报：
    - 删除和保留的本地 profiles；
    - 当前默认 profile；
    - 新组织登录用户；
    - 已授权 scopes；
    - Token 与身份验证结果；
    - 仍需人工处理的脚本、配置或自动化引用；
    - 明确声明未操作 WorkBuddy、飞书云端数据、服务端授权和开发者后台应用。

任何时候如果无法准确确认旧组织、目标组织、登录用户、配置用途或删除范围，立即停止并询问。禁止猜测、覆盖或扩大删除范围。
```

用于上海传美实业时：

```text
<目标组织名称> = 上海传美实业（saselomo）
<目标 profile> = saselomo
```

## 人工执行参考

以下命令用于理解和复核流程，默认 `lark-cli` 已经安装并可执行。

### 1. 枚举和验证 profiles

```console
lark-cli profile list
lark-cli --profile <候选 profile> whoami
lark-cli --profile <候选 profile> auth status --json --verify
lark-cli --profile <候选 profile> auth list --json
```

若需要核对用户所属租户，可使用用户身份只读接口：

```console
lark-cli --profile <候选 profile> api GET /open-apis/authen/v1/user_info --as user
```

该接口可能只返回租户标识而不返回可读组织名称。无法准确映射时必须让用户确认，不能自行推断。

不要把完整命令输出复制到公开聊天或工单。汇报时只保留 profile 名、用户名、身份状态、Token 是否有效和 scope 摘要。

### 2. 检查 profile 引用

至少检查：

- 当前项目中的 `--profile`、profile 配置字段和相关环境变量；
- Codex 自动化和产品实例私有配置；
- macOS：shell 启动文件、cron、LaunchAgent、`launchctl` 环境；
- Windows：PowerShell Profile、用户/系统环境变量、任务计划程序、Windows 服务、启动目录和注册表 Run 项。

Windows 只列出可能相关的环境变量名称，不直接打印值：

```powershell
Get-ChildItem Env: |
  Where-Object { $_.Name -match '^(LARK|LARKSUITE|FEISHU).*PROFILE' } |
  Select-Object -ExpandProperty Name
```

Windows 只列出可能固定调用 `lark-cli` 的任务名称：

```powershell
Get-ScheduledTask |
  Where-Object {
    ($_.Actions.Execute -join ' ') -match 'lark-cli' -or
    ($_.Actions.Arguments -join ' ') -match '--profile'
  } |
  Select-Object TaskPath, TaskName, State
```

项目扫描优先使用已经识别出的 profile 名称，并只输出路径和行号：

```powershell
$ProfileNames = @('<旧 profile 候选>', '<目标 profile>')
Get-ChildItem -Recurse -File |
  Select-String -SimpleMatch $ProfileNames |
  Select-Object Path, LineNumber
```

### 3. 删除已确认的旧本地 profile

以下命令具有本机凭据删除效果，必须在用户明确确认具体 profile 后执行：

```console
lark-cli --profile <已确认旧 profile> auth logout --json
lark-cli profile remove <已确认旧 profile>
```

成功后重新运行 `lark-cli profile list`。不得把删除本地 profile 扩展为撤销服务端授权或删除开发者后台应用。

### 4. 复用或创建目标 profile

目标 profile 已存在时先核验并复用，不要覆盖。只有目标 profile 不存在时，才根据当前 CLI 的 `profile add` 或 `config init` 流程创建独立配置。

创建 profile 不等于重新安装 CLI。需要 App Secret 时，应通过 CLI 安全输入和操作系统原生凭据存储完成，禁止写入命令行参数、脚本、Markdown、日志或 Git。

### 5. 最小用户授权

```console
lark-cli --profile <目标 profile> auth login --scope "auth:user.id:read" --no-wait --json
```

将官方 verification URL 原样展示给用户，并用相对路径生成二维码：

```console
lark-cli auth qrcode "<verification URL>" --output ".lark-auth/feishu-auth.png"
```

用户完成授权后，由 Codex 继续本次 device-code 流程。二维码完成后按平台清理：

```bash
# macOS
rm .lark-auth/feishu-auth.png
```

```powershell
# Windows PowerShell
Remove-Item ".lark-auth/feishu-auth.png"
```

### 6. 验证和设置默认 profile

```console
lark-cli --profile <目标 profile> whoami
lark-cli --profile <目标 profile> auth status --json --verify
lark-cli --profile <目标 profile> api GET /open-apis/authen/v1/user_info --as user
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
- 其他 profiles、自动化和云端数据未受影响。

## 凭据存储与受限环境

- macOS：CLI 凭据可能由系统 Keychain 管理。沙箱中出现 `keychain not initialized` 不代表 Token 已失效，应在获准的本机环境中重新只读核验。
- Windows：CLI 凭据应继续使用 Windows Credential Manager。网页授权成功但 `auth status --json --verify` 仍显示未登录或无 Token 时，应停止并报告凭据写入问题。

不要因为受限终端无法读取旧凭据，就重装 CLI、覆盖 profile 或改用明文文件、环境变量保存 Token。macOS 上也不要未经确认执行 `config keychain-downgrade`。

## 安全边界

- 不操作 WorkBuddy 的缓存、进程、浏览器 session 或连接器；
- 不在 GitHub、Issue、PR、聊天或网盘上传凭据、二维码、授权链接或完整身份信息；
- 不通过 profile 切换迁移、复制或删除飞书云端数据；
- 不自动撤销服务端授权；
- 不删除或覆盖开发者后台应用；
- 不因 profile 名称相似而认定组织；
- 不修改未确认的生产脚本、LaunchAgent、Windows 服务、计划任务或其他自动化；
- 权限不足时根据 `missing_scopes` 增量申请，不使用 `--domain all`。

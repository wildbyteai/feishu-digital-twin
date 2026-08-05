# WorkBuddy 与 Codex 切换飞书组织：CLI Profile 和连接器缓存处理

本文用于解决同一台电脑上的 WorkBuddy 与 Codex 切换飞书组织后，仍命中旧组织、旧应用或旧 OAuth 登录态的问题。

本文整合两类本机状态：

| 层级 | 典型组件 | 处理对象 |
| --- | --- | --- |
| Codex / 用户 CLI | 当前终端 PATH 中的官方 `lark-cli` | profiles、默认 profile、用户 OAuth 登录态 |
| WorkBuddy 连接器 | WorkBuddy 自带的 `lark-cli`、连接器进程和浏览器会话 | `~/.lark-cli` 缓存、卡死重试进程、必要时的飞书网页 session |
| 飞书云端 | 开放平台应用、文档、消息、日历、Base、Wiki 等 | 本流程不删除、不迁移 |

WorkBuddy 缓存部分参考 [workbuddy-feishu-cache-cleanup](https://github.com/wildbyteai/workbuddy-feishu-cache-cleanup)，并增加了与 Codex CLI profile 共存时的隔离检查和确认门。

## 适用前提

这是“切换已绑定环境”的手册，不是安装或首次接入教程。开始前默认满足：

- 本机已经安装并使用过官方 `lark-cli`；
- Codex 和 WorkBuddy 至少有一方曾成功连接飞书；
- `lark-cli` 命令在原有终端或自动化环境中曾经可以执行；
- 执行者有权管理本机 profile 和 WorkBuddy 本机缓存。

如果 `lark-cli` 突然不可执行，应先报告 PATH、终端、权限或执行环境变化。不要在本流程中擅自重装 CLI、初始化一套全新环境或覆盖已有绑定。

本文同时适用于 macOS 和 Windows。CLI profile、OAuth 和验证命令相同；差异主要在本机进程、自动化、凭据存储和文件清理命令。

## 核心安全原则

1. WorkBuddy 自带 CLI 与 Codex 使用的用户 CLI 可能是两个二进制，也可能读取部分相同的本机目录。
2. 删除 `~/.lark-cli` 前必须确认它是否影响需要保留的 Codex profiles；无法证明隔离时禁止整目录删除。
3. WorkBuddy 清缓存应在重新连接 WorkBuddy 之前完成。若缓存与 Codex CLI 共享，应先清理 WorkBuddy，再建立或验证 Codex 的目标 profile。
4. 只终结命令路径明确属于 `workbuddy/binaries` 的 `lark-cli` 进程。
5. 路径含 `homebrew`、系统 CLI 路径，或命令带 `--profile` 且不属于 WorkBuddy 的进程，默认视为 Codex、个人机器人或其他实例，禁止终结。
6. 删除缓存前必须备份并向用户展示准确目标和影响。
7. 不操作系统凭据库，不删除 WorkBuddy 连接器市场插件，不删除任何飞书云端数据或开发者后台应用。

## 可直接交给 Codex 的完整指令

复制以下内容，在需要切换的电脑上交给 Codex 执行：

```text
请协助将本机 WorkBuddy 和 Codex 使用的飞书身份从旧组织切换到 <目标组织名称>，Codex 目标 CLI profile 为 <目标 profile>。

本机此前已经安装并绑定过飞书 CLI。本任务只处理本机 CLI profile、登录凭据、WorkBuddy 连接器缓存和明确属于 WorkBuddy 的卡死进程；不迁移或删除任何飞书云端数据，不删除开发者后台应用，也不重新安装 CLI。请严格按以下流程执行：

1. 识别当前操作系统。先确认原有 lark-cli 命令是否可执行；如果不可执行，立即报告终端、PATH、权限或执行环境问题，不要重装 CLI、运行全新初始化或覆盖已有配置。
2. 只读列出现有飞书 CLI profiles，并逐个核验实际登录用户、组织/租户、用户与 Bot 状态、Token 有效性和授权范围。旧 profile 名称可能不同，禁止仅凭名称猜测。
3. 只读识别两类 CLI：
   - Codex/用户 CLI：当前 PATH 中的 lark-cli 可执行文件、显式 --profile 进程及其 profiles；
   - WorkBuddy CLI：命令路径明确包含 workbuddy/binaries 的 lark-cli 进程和缓存。
   不得把两类 CLI 当作同一个进程批量处理。
4. 只读检查 WorkBuddy 认证日志是否存在持续的 400、app registration 或 oauth token 重试；只报告错误类型和时间，不输出 Token、App Secret、Cookie、device code 或完整敏感日志。
5. 检查项目脚本、有效配置、环境变量和自动化中的 profile 引用：
   - macOS：shell 启动文件、cron、LaunchAgent、launchctl 环境；
   - Windows：PowerShell Profile、用户/系统环境变量、任务计划程序、Windows 服务、启动目录和注册表 Run 项；
   - 两个平台：Codex 自动化和产品实例私有配置。
6. 在任何写操作前汇报并等待明确确认：
   - 旧组织 profile 候选；
   - 需要保留的 profiles；
   - WorkBuddy 缓存绝对路径；
   - 缓存是否与 Codex/用户 CLI 共享；
   - 待终结的 WorkBuddy 进程 PID 与可执行路径；
   - 备份位置；
   - 删除和回滚影响。
7. 要求用户先在 WorkBuddy 连接器管理面板断开飞书。若后台仍持续拉起旧认证进程，再要求用户彻底退出 WorkBuddy。未断开时禁止清缓存。
8. 对确认后的 WorkBuddy 缓存创建本机备份。备份可能包含本机认证缓存，只能留在本机受限目录，不上传 GitHub、网盘、工单或聊天。
9. 仅终结路径明确属于 workbuddy/binaries 的 lark-cli 卡死重试进程。执行前再次展示 PID 和路径；禁止终结 homebrew、系统 lark-cli、带 --profile 的非 WorkBuddy 进程或无法识别来源的进程。
10. 根据隔离结果清理：
    - 已证明 ~/.lark-cli 是 WorkBuddy 独占，且用户明确确认：可以完整删除；
    - 与 Codex CLI 共享，但所有受影响 profiles 都已列明且用户明确同意：只能先备份并清理，再重新建立目标 profile；
    - 仍有需保留 profiles 或无法确认共享关系：禁止整目录删除，停止并询问；
    - 只清 token、locks 或 config.json 也属于删除操作，必须先证明不会影响需保留的 profiles。
11. 清理后等待数秒，确认 WorkBuddy 重试进程没有重建旧 config.json 或 token 缓存。若持续重建，保持 WorkBuddy 断开/退出，重新检查残留 WorkBuddy 进程；不要反复无条件删除。
12. 不删除 ~/.workbuddy/connectors-marketplace/connectors/feishu/，不操作 macOS Keychain、Windows Credential Manager/DPAPI 或其他系统凭据库。
13. 只有在 WorkBuddy 已重新连接但仍自动进入旧飞书网页会话时，才将浏览器 session 目录作为第二级清理候选。执行前单独报告路径、影响并再次取得确认。
14. WorkBuddy 缓存稳定清理后，再处理 Codex/用户 CLI profile。将旧组织 profile 候选、登录用户、Token 状态、授权摘要和引用影响展示给我；得到我对具体 profile 名称的明确确认后，才允许 auth logout 和 profile remove。
15. 删除 Codex 旧 profile 仅限本机：
    - auth logout 只清除目标 profile 的本机用户 Token；
    - profile remove 只删除该本机 profile 和关联本地凭据；
    - 不撤销服务端授权，不删除云端文件、消息、日程、Base、Wiki 或开发者后台应用。
16. 检查 <目标 profile>：
    - 已存在：核验并复用，禁止覆盖；
    - 不存在：在现有 CLI 环境中创建独立 profile；
    - 无法确认其属于 <目标组织名称>：立即停止并询问。
17. 新组织用户授权遵循最小权限原则。初始只申请 auth:user.id:read，允许 OAuth 必需的 offline_access；不默认申请业务 domain，禁止 --domain all。
18. 使用飞书官方设备授权 split-flow：auth login --scope "auth:user.id:read" --no-wait --json，展示原始官方 URL 和 CLI 生成的二维码；我完成授权后，由你继续 device-code 流程。不得公开或长期保存 device code。
19. 授权完成后，显式指定目标 profile 验证 whoami、auth status --json --verify、正确用户、正确租户和有效 Token。通过后才执行 profile use，并用不带 --profile 的命令读回确认默认 profile。
20. 让用户在 WorkBuddy 连接器管理面板重新连接飞书，并在官方授权页选择 <目标组织名称>。此 UI 授权必须由用户完成。
21. 联合验证：
    - Codex 默认 profile 为 <目标 profile>；
    - Codex whoami 用户和租户正确，Token verified；
    - WorkBuddy 显示已连接目标组织；
    - WorkBuddy 不再循环产生 400/app registration/oauth token 日志；
    - WorkBuddy-path 卡死进程为 0；
    - 个人机器人、其他 profiles 和连接器市场插件未受影响。
22. 最后汇报：备份位置、清理的缓存目录、终结的 WorkBuddy PID、删除与保留的 profiles、当前默认 profile、新组织登录用户、授权 scopes、两端验证结果、未处理引用和回滚注意事项。

任何时候如果无法准确确认组织、用户、进程归属、缓存归属、删除范围或回滚影响，立即停止并询问。禁止猜测、覆盖、批量 kill 或扩大删除范围。
```

用于上海传美实业时：

```text
<目标组织名称> = 上海传美实业（saselomo）
<目标 profile> = saselomo
```

## 人工执行参考

以下命令用于理解和复核流程，默认 `lark-cli` 已经安装并可执行。涉及终结进程或删除文件的步骤必须先完成只读检查、备份和用户确认。

### 1. 判定平台

```bash
# macOS
uname -s
```

```powershell
# Windows PowerShell
$PSVersionTable.OS
```

### 2. 只读识别 Codex CLI 与 WorkBuddy CLI

macOS：

```bash
command -v lark-cli
lark-cli profile list
pgrep -fl lark-cli
```

Windows PowerShell：

```powershell
(Get-Command lark-cli).Source
lark-cli profile list
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'lark-cli' } |
  Select-Object ProcessId, ExecutablePath, CommandLine
```

判定规则：

- 可执行路径含 `workbuddy/binaries` 或 Windows 等价路径：WorkBuddy 连接器候选；
- 路径含 `homebrew`、系统安装位置，或命令带 `--profile` 且不属于 WorkBuddy：Codex、个人机器人或其他实例；
- 来源不明确：不终结、不删除，先询问。

进程命令行可能包含敏感参数，只能在本机核验，不复制完整输出到聊天或日志。

### 3. 只读确认 WorkBuddy 症状

macOS：

```bash
tail -30 ~/.lark-cli/logs/auth-*.log 2>/dev/null |
  grep -E "status=400|app/registration|oauth/token"
```

Windows PowerShell：

```powershell
$WorkBuddyAuthLog = Get-ChildItem "$HOME\.lark-cli\logs\auth-*.log" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime |
  Select-Object -Last 1
if ($WorkBuddyAuthLog) {
  Get-Content $WorkBuddyAuthLog.FullName -Tail 30 |
    Select-String 'status=400|app/registration|oauth/token'
}
```

持续出现 400、应用注册或 OAuth token 重试，才说明命中缓存/重试进程问题。没有相关症状时不要为了“保险”清缓存。

### 4. 检查配置和自动化引用

两端都要检查当前项目、有效配置、Codex 自动化和产品实例私有配置。

- macOS：shell 启动文件、当前进程环境、`launchctl` 环境、cron、`~/Library/LaunchAgents`；
- Windows：PowerShell Profile、用户/系统环境变量、任务计划程序、Windows 服务、启动目录和注册表 Run 项。

Windows 只列出可能相关的环境变量名称，不直接打印值：

```powershell
Get-ChildItem Env: |
  Where-Object { $_.Name -match '^(LARK|LARKSUITE|FEISHU).*PROFILE' } |
  Select-Object -ExpandProperty Name
```

Windows 只列出可能调用 `lark-cli` 的计划任务名称：

```powershell
Get-ScheduledTask |
  Where-Object {
    ($_.Actions.Execute -join ' ') -match 'lark-cli' -or
    ($_.Actions.Arguments -join ' ') -match '--profile'
  } |
  Select-Object TaskPath, TaskName, State
```

项目扫描优先使用已经识别出的 profile 名称，只输出路径和行号：

```powershell
$ProfileNames = @('<旧 profile 候选>', '<目标 profile>')
Get-ChildItem -Recurse -File |
  Select-String -SimpleMatch $ProfileNames |
  Select-Object Path, LineNumber
```

### 5. WorkBuddy 断开、备份和确认门

先由用户在 WorkBuddy 连接器管理面板断开飞书。如果仍有 WorkBuddy-path `lark-cli` 被持续拉起，应彻底退出 WorkBuddy。

备份可能包含认证缓存，必须保留在本机临时目录并限制传播。

macOS：

```bash
WORKBUDDY_CACHE_PATH="$HOME/.lark-cli"
WORKBUDDY_BACKUP_PATH="$(mktemp -d /tmp/workbuddy-lark-cli-backup.XXXXXX)"
if [ -d "$WORKBUDDY_CACHE_PATH" ]; then
  cp -R "$WORKBUDDY_CACHE_PATH/." "$WORKBUDDY_BACKUP_PATH/"
fi
printf '缓存路径: %s\n备份路径: %s\n' "$WORKBUDDY_CACHE_PATH" "$WORKBUDDY_BACKUP_PATH"
```

Windows PowerShell：

```powershell
$WorkBuddyCachePath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.lark-cli'
$WorkBuddyBackupPath = Join-Path ([IO.Path]::GetTempPath()) (
  'workbuddy-lark-cli-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
)
New-Item -ItemType Directory -Path $WorkBuddyBackupPath -Force | Out-Null
if (Test-Path $WorkBuddyCachePath) {
  Copy-Item -LiteralPath $WorkBuddyCachePath -Destination $WorkBuddyBackupPath -Recurse
}
Write-Host "缓存路径: $WorkBuddyCachePath"
Write-Host "备份路径: $WorkBuddyBackupPath"
```

备份完成后，必须让用户确认准确缓存路径、是否共享、要保留的 profiles 和删除影响。

### 6. 仅终结 WorkBuddy 卡死进程

先只读列出：

```bash
# macOS
pgrep -fl "workbuddy/binaries" 2>/dev/null | grep lark-cli
```

```powershell
# Windows PowerShell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'workbuddy.{1,2}binaries' -and
    $_.CommandLine -match 'lark-cli'
  } |
  Select-Object ProcessId, ExecutablePath, CommandLine
```

用户确认具体 PID 后，逐个终结，不使用宽泛名称匹配：

```bash
# macOS：把占位符替换为已经核验的单个 PID
kill <已确认的 WorkBuddy PID>
```

```powershell
# Windows PowerShell：把占位符替换为已经核验的单个 PID
Stop-Process -Id <已确认的 WorkBuddy PID> -Force
```

等待两至三秒重新列进程。任何非 WorkBuddy 路径进程都不能终结。

### 7. WorkBuddy 缓存清理决策

| 状态 | 处理 |
| --- | --- |
| 无 400/组织错乱症状 | 跳过缓存清理 |
| 已证明缓存目录由 WorkBuddy 独占 | 备份和确认后可完整清理 |
| 缓存与 Codex CLI 共享，且所有受影响 profiles 均允许重建 | 明确确认后先清缓存，再建立目标 profile |
| 共享关系不明，或仍有需保留 profiles | 禁止整目录和部分目录删除，停止询问 |

完整清理命令仅在上述安全门通过后执行。

macOS：

```bash
WORKBUDDY_CACHE_PATH="$HOME/.lark-cli"
if [ "$WORKBUDDY_CACHE_PATH" != "$HOME/.lark-cli" ]; then
  echo "缓存路径校验失败"
  exit 1
fi
rm -rf -- "$WORKBUDDY_CACHE_PATH"
```

Windows PowerShell：

```powershell
$ExpectedWorkBuddyCachePath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.lark-cli'
if ($WorkBuddyCachePath -ne $ExpectedWorkBuddyCachePath) {
  throw '缓存路径校验失败'
}
Remove-Item -LiteralPath $WorkBuddyCachePath -Recurse -Force
```

所谓“部分清理”也会改变认证状态，不能绕过确认门：

- `~/.lark-cli/cache/auth_login_scopes/`：用户 Token 缓存；
- `~/.lark-cli/locks/`：组织或认证锁；
- `~/.lark-cli/config.json`：应用配置引用。

只要这些位置可能被 Codex CLI 使用，就不得单独删除。

### 8. 验证缓存没有被旧进程重建

macOS：

```bash
sleep 3
find ~/.lark-cli -type f 2>/dev/null
test -f ~/.lark-cli/config.json && echo "旧配置可能已被重建"
test -d ~/.lark-cli/cache/auth_login_scopes && echo "Token 缓存可能已被重建"
```

Windows PowerShell：

```powershell
Start-Sleep -Seconds 3
Get-ChildItem -Recurse -File "$HOME\.lark-cli" -ErrorAction SilentlyContinue |
  Select-Object FullName
if (Test-Path "$HOME\.lark-cli\config.json") {
  Write-Host '旧配置可能已被重建'
}
if (Test-Path "$HOME\.lark-cli\cache\auth_login_scopes") {
  Write-Host 'Token 缓存可能已被重建'
}
```

若旧配置再次出现，保持 WorkBuddy 断开或退出，重新检查 WorkBuddy-path 残留进程。禁止循环执行无条件删除。

### 9. 切换 Codex / 用户 CLI profile

先只读枚举和验证：

```console
lark-cli profile list
lark-cli --profile <候选 profile> whoami
lark-cli --profile <候选 profile> auth status --json --verify
lark-cli --profile <候选 profile> auth list --json
```

用户明确确认具体旧 profile 后，才执行：

```console
lark-cli --profile <已确认旧 profile> auth logout --json
lark-cli profile remove <已确认旧 profile>
```

`auth logout` 和 `profile remove` 只处理本机状态，不等于撤销服务端授权。

目标 profile 已存在时先核验并复用，不得覆盖；不存在时只在现有 CLI 环境中创建独立 profile，不重新安装 CLI。

发起最小用户授权：

```console
lark-cli --profile <目标 profile> auth login --scope "auth:user.id:read" --no-wait --json
```

必须把官方 verification URL 原样展示给用户，并使用 CLI 生成二维码。用户完成授权后，由执行助手继续 device-code 流程。初始不申请业务 domain，不使用 `--domain all`。

验证并设为默认：

```console
lark-cli --profile <目标 profile> whoami
lark-cli --profile <目标 profile> auth status --json --verify
lark-cli --profile <目标 profile> api GET /open-apis/authen/v1/user_info --as user
lark-cli profile use <目标 profile>
lark-cli whoami
lark-cli auth status --json --verify
lark-cli profile list
```

### 10. 重新连接 WorkBuddy

缓存稳定且 Codex CLI 已验证后，由用户在 WorkBuddy 连接器管理面板重新连接飞书，并在官方授权页面选择正确组织。

如果重新连接后仍自动进入旧账号或旧组织，先确认 WorkBuddy CLI 不再有 400 重试，再把以下浏览器 session 目录作为第二级候选。该清理会使 WorkBuddy 内飞书网页重新登录，必须单独确认：

- macOS：`~/.workbuddy/app/session/Partitions/agent-browser-preview-webview/IndexedDB/https_accounts.feishu.cn_0.indexeddb.leveldb`
- Windows：`%USERPROFILE%\.workbuddy\app\session\Partitions\agent-browser-preview-webview\IndexedDB\https_accounts.feishu.cn_0.indexeddb.leveldb`

默认不删除该目录。

### 11. 联合验证清单

- [ ] Codex 默认 profile 是目标 profile；
- [ ] `lark-cli whoami` 返回正确用户；
- [ ] `auth status --json --verify` 返回 `verified: true` 且 Token 有效；
- [ ] 初始用户授权仅包含 `auth:user.id:read` 与 OAuth 必需的 `offline_access`；
- [ ] WorkBuddy 显示连接到目标组织；
- [ ] WorkBuddy 日志不再循环出现 400、应用注册或 OAuth token 错误；
- [ ] WorkBuddy-path 卡死 `lark-cli` 进程为 0；
- [ ] 其他 profiles、个人机器人和自动化未被误删或误杀；
- [ ] `~/.workbuddy/connectors-marketplace/connectors/feishu/` 仍存在；
- [ ] 备份路径已经记录并告知用户；
- [ ] 没有操作飞书云端数据、服务端授权或开发者后台应用。

## 回滚原则

缓存恢复前必须先退出 WorkBuddy，避免恢复过程中又被后台进程改写。

- 备份被证明是 WorkBuddy 独占：可在确认后恢复原目录；
- 备份与 Codex CLI 共享：恢复可能重新引入旧组织、旧 Token 或覆盖刚建立的目标 profile，禁止直接覆盖恢复；
- 无法判断备份归属：保留备份并停止，由用户决定；
- 新组织两端验证正常后，备份由用户自行决定保留或删除。

## 绝对禁止

- 不终结路径不明、非 WorkBuddy 路径、含 `homebrew` 或带非 WorkBuddy `--profile` 的 `lark-cli` 进程；
- 不删除 `~/.workbuddy/connectors-marketplace/connectors/feishu/`；
- 不操作 macOS Keychain、Windows Credential Manager/DPAPI 或 Linux keyring；
- 不在 GitHub、Issue、PR、聊天或网盘上传缓存备份、配置、Token、Secret、Cookie、二维码、授权链接或完整日志；
- 不因 profile 名称相似而推断组织；
- 不修改未确认的生产脚本、LaunchAgent、Windows 服务、计划任务或其他自动化；
- 不默认申请业务权限，不使用 `--domain all`；
- 不把 WorkBuddy UI 断开误认为已经清除了底层 CLI 缓存；
- 不在共享关系不明时删除整个 `~/.lark-cli`。

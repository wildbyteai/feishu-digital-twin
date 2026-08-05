# 在 WorkBuddy 中重置飞书连接器并切换组织

本文只用于在 WorkBuddy 中清理飞书连接器的旧本机认证缓存，并重新连接到目标组织。

- 应由 WorkBuddy Agent 执行；
- 不要求用户安装或打开 Codex；
- 不要求系统 PATH 中存在独立的 `lark-cli`；
- 不修改 Codex 或其他工具的 CLI profiles；
- 不迁移或删除任何飞书云端数据；
- 不删除开发者后台应用。

如果不确定应该使用哪份手册，请先阅读[飞书组织切换前置路由](switch-feishu-organization.md)。

本文参考 [workbuddy-feishu-cache-cleanup](https://github.com/wildbyteai/workbuddy-feishu-cache-cleanup)，并增加了共享缓存目录的保护规则。

## 适用前提

这是“切换已绑定 WorkBuddy 连接器”的手册，不是 WorkBuddy 或飞书连接器安装教程。开始前默认满足：

- 当前 Agent 明确运行在 WorkBuddy 中；
- WorkBuddy 飞书连接器此前曾经连接或授权；
- 当前问题表现为组织错乱、解绑无效、重新连接仍使用旧认证，或后台持续出现认证重试；
- 用户有权管理本机 WorkBuddy 连接器和缓存。

如果当前 Agent 不是 WorkBuddy，停止并返回前置路由。不要让 Codex 或其他 Agent 代替 WorkBuddy 执行本手册。

本文支持 macOS 和 Windows。

## 可直接交给 WorkBuddy 的指令

复制以下内容，在 WorkBuddy 中执行：

```text
请协助把当前 WorkBuddy 飞书连接器从旧组织切换到 <目标组织名称>。

你当前必须是 WorkBuddy Agent。本任务只处理 WorkBuddy 飞书连接器、自带 lark-cli 的卡死进程、本机连接器缓存和必要时的 WorkBuddy 飞书网页 session；不处理 Codex，不修改其他工具的 lark-cli profiles，不迁移或删除飞书云端数据，不删除开发者后台应用，也不安装任何新工具。请严格按以下流程执行：

1. 先明确声明当前 Agent 是 WorkBuddy。如果无法从当前产品运行上下文确认，立即停止并询问，不要通过扫描已安装软件猜测。
2. 识别当前操作系统。只读检查 WorkBuddy 飞书连接器状态、相关认证日志和明确属于 WorkBuddy 自带二进制的 lark-cli 进程。
3. 检查是否存在以下症状：
   - WorkBuddy UI 已解绑，但重新连接仍进入旧组织；
   - 认证日志持续出现 400、app registration 或 oauth token 重试；
   - 路径明确属于 workbuddy/binaries 的 lark-cli config init 或 auth login 进程反复出现；
   - 删除缓存后旧 config.json 或 token 缓存被立刻重建。
   没有这些症状时，不要为了“保险”删除缓存。
4. 全程禁止输出 App Secret、Access Token、Refresh Token、Cookie、device code 或完整敏感日志。进程命令行只在本机核验，报告时只保留 PID、可执行路径和脱敏后的动作摘要。
5. 区分 WorkBuddy 与其他 lark-cli：
   - 可执行路径明确包含 WorkBuddy 和 binaries 的进程，才是 WorkBuddy 候选；
   - 非 WorkBuddy 路径、homebrew、系统安装位置、带非 WorkBuddy --profile 的进程，一律视为其他工具或机器人，禁止终结；
   - 来源不明确的进程不终结。
6. 将 ~/.lark-cli 视为“可能共享”的目录，而不是默认认为属于 WorkBuddy。只读检查：
   - 是否存在 profiles 子目录；
   - 是否存在非 WorkBuddy lark-cli 进程；
   - 是否有其他脚本、服务或自动化引用该目录；
   - 是否存在必须保留的本机配置。
   无法证明清理不会影响其他工具时，禁止删除并询问用户。
7. 要求用户先在 WorkBuddy 连接器管理面板断开飞书。未断开时禁止清缓存。
8. 如果 WorkBuddy 仍持续拉起旧认证进程，先列出进程并等待用户确认具体 PID。只终结已确认的 WorkBuddy-path lark-cli 进程，不使用宽泛 killall、pkill 名称或 Stop-Process -Name。
9. 如果必须彻底退出 WorkBuddy 才能停止监控器，当前 Agent 应先保存检查结果和后续步骤，然后请用户退出并重新打开 WorkBuddy 后继续；不要假装在应用退出后仍然完成了操作。
10. 删除缓存前创建本机备份。备份可能包含认证缓存，只能保存在本机受限临时目录，不上传 GitHub、网盘、工单或聊天。
11. 在任何删除前展示并等待明确确认：
    - 缓存绝对路径；
    - 备份绝对路径；
    - 是否发现其他工具共享；
    - 待删除文件或目录；
    - 待终结 PID；
    - 预期影响和回滚方法。
12. 仅在已经备份、未发现需保留的共享状态且用户明确确认后，才允许完整删除 ~/.lark-cli。
13. 只删除 cache/auth_login_scopes、locks 或 config.json 也属于凭据/配置删除，不能绕过相同的共享检查和确认门。
14. 清理后等待数秒，确认 WorkBuddy 卡死进程没有重建旧 config.json 或 token 缓存。若持续重建，停止删除，重新检查连接器是否断开和是否还有 WorkBuddy-path 残留进程。
15. 禁止删除 ~/.workbuddy/connectors-marketplace/connectors/feishu/，该目录是连接器市场插件。
16. 禁止操作 macOS Keychain、Windows Credential Manager/DPAPI 或其他系统凭据库。
17. 缓存稳定后，请用户在 WorkBuddy 连接器管理面板重新连接飞书，并在官方授权页面选择 <目标组织名称>。此 UI 操作必须由用户完成。
18. 只有重新连接后仍自动进入旧飞书网页会话，才把 WorkBuddy 浏览器 session 作为第二级清理候选。执行前单独报告路径和登录影响，并再次取得确认；默认不删除。
19. 最后验证：
    - WorkBuddy 显示已连接 <目标组织名称>；
    - 日志不再循环出现 400、应用注册或 OAuth token 错误；
    - WorkBuddy-path 卡死重试进程为 0；
    - 其他 lark-cli 进程和配置未受影响；
    - 飞书连接器市场插件仍存在；
    - 备份路径已记录；
    - 未操作 Codex、其他工具 profiles、飞书云端数据和开发者后台应用。
20. 最后汇报备份位置、终结的 PID、删除的缓存路径、重新连接结果、仍需人工处理的事项和回滚注意事项。

任何时候如果无法确认当前 Agent、进程归属、缓存归属、删除范围或回滚影响，立即停止并询问。禁止猜测、批量 kill 或扩大删除范围。
```

用于上海传美实业时：

```text
<目标组织名称> = 上海传美实业（saselomo）
```

## 人工执行参考

以下命令用于理解和复核流程。写操作必须在 WorkBuddy UI 断开、完成备份并得到用户确认后执行。

### 1. 判定平台

```bash
# macOS
uname -s
```

```powershell
# Windows PowerShell
$PSVersionTable.OS
```

### 2. 只读确认认证症状

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

日志可能包含敏感标识，只能报告错误类型和时间，不复制完整行。

### 3. 只读识别 WorkBuddy 自带 CLI 进程

macOS：

```bash
pgrep -fl "workbuddy/binaries" 2>/dev/null | grep lark-cli
```

Windows PowerShell：

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'workbuddy.{1,2}binaries' -and
    $_.CommandLine -match 'lark-cli'
  } |
  Select-Object ProcessId, ExecutablePath, CommandLine
```

只匹配 WorkBuddy 路径仍不等于已经获准终结。必须先向用户展示具体 PID 和路径。

同时检查非 WorkBuddy `lark-cli` 进程。如果存在，说明 `~/.lark-cli` 可能被其他工具使用，不能直接删除。

### 4. 检查缓存是否可能共享

macOS：

```bash
find ~/.lark-cli -maxdepth 3 -mindepth 1 -print 2>/dev/null
```

Windows PowerShell：

```powershell
Get-ChildItem "$HOME\.lark-cli" -Depth 2 -Force -ErrorAction SilentlyContinue |
  Select-Object FullName
```

以下任一情况出现时，不得把目录视为 WorkBuddy 独占：

- 存在 `profiles/` 或其他明确的多 profile 配置；
- 存在非 WorkBuddy 路径的 `lark-cli` 活动进程；
- 脚本、服务、任务计划或其他自动化引用该目录；
- 用户说明还有其他工具或机器人使用飞书 CLI；
- 无法解释目录内文件用途。

### 5. 在 WorkBuddy UI 中断开飞书

用户必须先在 WorkBuddy 的连接器管理面板断开飞书。Agent 不应假定 UI 断开已经自动清除了底层缓存。

若断开后 WorkBuddy 仍持续重新拉起认证进程，可以只终结已确认的 helper PID。若必须退出整个 WorkBuddy，先保存检查结论，用户重新打开 WorkBuddy 后再继续。

### 6. 创建本机备份

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

备份可能包含认证状态，不能上传或分享。

### 7. 终结已确认的 WorkBuddy helper

用户明确确认单个 PID 后：

```bash
# macOS
kill <已确认的 WorkBuddy PID>
```

```powershell
# Windows PowerShell
Stop-Process -Id <已确认的 WorkBuddy PID> -Force
```

等待两至三秒重新列进程。任何非 WorkBuddy 路径、来源不明或未确认的 PID 都不能终结。

### 8. 清理缓存

只有同时满足以下条件，才允许执行：

- WorkBuddy UI 已断开；
- 缓存已备份；
- 没有发现其他工具共享，或用户已明确确认所有影响；
- 目标路径已经显示并核验；
- 用户明确同意删除。

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

部分清理也受同一确认门约束：

- `~/.lark-cli/cache/auth_login_scopes/`：认证 Token 缓存；
- `~/.lark-cli/locks/`：认证或组织锁；
- `~/.lark-cli/config.json`：应用配置引用。

### 9. 验证旧状态没有被重建

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

若旧配置再次出现，停止删除并重新检查 WorkBuddy 是否仍连接、是否还有残留 helper 或监控器。

### 10. 在 WorkBuddy 中重新连接

由用户打开 WorkBuddy 连接器管理面板，重新连接飞书并在官方授权页面选择目标组织。

成功标准：

- WorkBuddy UI 显示目标组织；
- 不再循环出现 400、应用注册或 OAuth token 错误；
- 不再存在卡死的 WorkBuddy-path helper；
- 其他本机工具未受影响。

### 11. 浏览器 session 的第二级清理

只有 WorkBuddy 缓存已清、重新连接后仍自动进入旧网页账号时，才考虑以下目录：

- macOS：`~/.workbuddy/app/session/Partitions/agent-browser-preview-webview/IndexedDB/https_accounts.feishu.cn_0.indexeddb.leveldb`
- Windows：`%USERPROFILE%\.workbuddy\app\session\Partitions\agent-browser-preview-webview\IndexedDB\https_accounts.feishu.cn_0.indexeddb.leveldb`

删除该目录会让 WorkBuddy 内的飞书网页重新登录，必须单独确认。默认不删除。

## 回滚原则

- 恢复前先断开飞书连接器，避免后台进程同时改写；
- 已证明备份只属于 WorkBuddy：用户确认后可恢复；
- 备份可能被其他工具共享：禁止直接覆盖恢复；
- 无法判断归属：保留备份并停止；
- 新组织验证正常后，由用户决定何时删除备份。

## 绝对禁止

- 不要求用户安装 Codex；
- 不修改 Codex 或其他工具的 CLI profiles；
- 不使用宽泛 `killall`、`pkill lark-cli` 或 `Stop-Process -Name`；
- 不终结非 WorkBuddy 路径、来源不明或未确认的进程；
- 不在共享关系不明时删除整个 `~/.lark-cli`；
- 不删除 `~/.workbuddy/connectors-marketplace/connectors/feishu/`；
- 不操作 macOS Keychain、Windows Credential Manager/DPAPI 或其他系统凭据库；
- 不上传缓存备份、配置、Token、Secret、Cookie、二维码、授权链接或完整日志；
- 不删除或迁移任何飞书云端数据；
- 不删除开发者后台应用。

# 每日工作记忆

每日工作记忆把当天聊天、任务、日程和执行结果整理成主体用户自己的飞书文档，用于后续工作，不进入项目仓库或公共服务。

## 启用条件

- 本机 domain 上限包含 `im`、`task`、`calendar`、`drive` 和 `docs` 中实际使用的能力；
- 主体 user 身份可读取目标信息并对目标 Drive 文件夹写入文档；
- 配置包含 `daily_memory.folder_token`、`folder_name` 和正确时区；
- `daily-memory` 后台角色已安装并健康。

目标文件夹必须来自部署者选择的已有资源，或由部署者通过 setup 的显式开关批准创建。要单独预览官方请求，可运行：

```bash
lark-cli --profile <profile> drive +create-folder \
  --as user \
  --name "数字分身每日工作记忆" \
  --dry-run
```

也可以让 setup 自动完成同样的官方流程：

```bash
npx --yes github:wildbyteai/feishu-digital-twin setup \
  --capabilities message,daily_memory \
  --create-missing-resources \
  <其他必需的 setup 选项>
```

setup 先按 `<主体用户显示名>的每日工作记忆` 在主体用户 Drive 根目录精确查找。没有匹配时，它依次调用 `drive +create-folder --as user --dry-run`、真实创建和 `drive files list` 读回；唯一同名目录会复用，多个同名目录会失败并要求传入明确 token。创建文件夹需要当前官方 CLI schema 列出的 user scope 之一，例如 `space:folder:create` 或 `drive:drive`。

批准创建后，setup 把官方返回并读回验证的稳定 folder token 与名称写入 Git 外 `0600` 私有配置。不要把 token 放进公开文档或日志。

对已有文件夹，普通 setup 可直接保存引用：

```bash
npx --yes github:wildbyteai/feishu-digital-twin setup \
  --capabilities message,daily_memory \
  --daily-memory-folder-token <folder-token> \
  --daily-memory-folder-name <文件夹名称> \
  <其他必需的 setup 选项>
```

两个 `--daily-memory-folder-*` 选项必须同时提供。setup 自动补齐每日记忆所需业务域，并通过官方 `drive files list` 对该 `folder_token` 发起一页大小为 1 的真实只读查询，确认目录存在且当前用户可访问；已有资源路径不读取正文，也不修改该文件夹。随后把 token 和名称写入 `0600` 私有配置，并继续使用默认的每日 00:10 调度和短保留期。

## 运行规则

- 文档标题使用主体时区的明确日期；
- 同一天只允许一份成功结果；
- 已存在同名文档时更新或拒绝重复创建；
- 当天确实没有可总结内容时，文档必须明确说明“当日无可记录事项”，不能生成空文件；
- 写入后必须重新读取标题和正文，确认非空且日期正确；
- `excluded_chat_ids` 使用 `chat_id` 精确排除整条消息；
- `excluded_topics` 对稳定 `thread_id` 精确匹配，或对官方结果中明确的 topic/title 字段做规范化后的字面匹配，不从正文猜测主题；
- 排除判断发生在官方消息搜索结果进入下一轮 Codex 之前。缺少必要 chat/topic 元数据时，该条正文失败关闭，只向 AI 提供脱敏的 `privacy_metadata_unavailable` 数量。

手动补跑使用产品的每日记忆触发入口，并继续遵守同日幂等、锁和写后读回，不直接绕过运行时调用文档创建命令。

## 故障与关闭

目标文件夹失效、权限不足、同名搜索不完整、锁过期或写后读回失败时，本次任务失败关闭，不创建第二份文档。自动创建目录后若 setup 的本机步骤失败，目录保留且错误标记可安全重试；相同命令会按精确名称复用，不自动删除外部资源。多来源日报通常需要至少两轮 Codex 决策；如果稳定停在单次推理超时，应在配置允许范围内把 `codex_timeout_ms` 调整到 240000–300000，再从同日补跑入口更新原文档，不要增加无界重试。若日报持续出现 `privacy_metadata_unavailable`，应检查当前官方 CLI 是否返回可用于排除判断的 chat/topic 元数据；不要通过关闭隐私过滤绕过。先冻结或停用 daily-memory，修复目录和授权后重跑。

关闭每日记忆时可以移除该能力配置并重新安装服务；不要删除历史飞书文档。删除文件夹或文档属于独立外部写操作，需要明确确认。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

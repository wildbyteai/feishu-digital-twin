# 企业知识库辅助回复

知识库能力由 AI 根据聊天方向选择资料，但所有检索和正文读取继续使用官方 lark-cli 与对应 lark-* Skill。项目不建立本地向量库、知识副本或长期搜索索引。

## 配置方式

有现成知识空间时，先通过主体 user 身份列出可访问空间：

```bash
lark-cli --profile <profile> wiki +space-list --as user --page-all --format json
```

部署者明确选择空间后，只保存稳定的空间名称、`space_id` 和适用方向。可写入 Base 控制台的“个性化规则”，例如使用不含真实标识的结构：

```text
企业知识库：<知识空间名称>；space_id=<知识空间ID>；适用于<业务方向>
```

setup 始终生成上述统一格式。对于已有 Base 或高级配置中的自然语言规则，Doctor 也接受“企业知识库”“知识空间”“空间名称”标签、常见中英文分隔符和引号，`space_id` 可位于规则任意位置；只有名称与 `space_id` 都能明确解析时才会进行官方只读验真，避免把普通文本或 `workspace_id` 误当成资源引用。

普通引导式 setup 的 Base 控制台是强制配置。没有现成控制 Base、但希望复用已有知识空间时，可以让 setup 创建 Base，并把这条知识路由写入新 Base 的初始“个性化规则”：

```bash
feishu-digital-twin setup \
  --capabilities message,enterprise_knowledge \
  --knowledge-space-name <知识空间名称> \
  --knowledge-space-id <space-id> \
  --knowledge-direction <业务方向> \
  --create-missing-resources \
  <其他必需的 setup 选项>
```

三个知识空间选项必须同时提供。setup 自动补齐控制 Base 和企业知识能力所需业务域，通过官方 `wiki +space-list` 只读核对名称与 `space_id`，再用官方 Base 命令创建控制台并写入初始路由；这个路径不读取正文，也不修改知识空间。

没有现成空间时，可明确批准 setup 调用官方组件创建：

```bash
feishu-digital-twin setup \
  --capabilities message,enterprise_knowledge \
  --create-missing-resources \
  <其他必需的 setup 选项>
```

setup 先按 `<主体用户显示名>的数字分身知识库` 精确查找。没有匹配时，它以主体 user 身份依次调用 `wiki +space-create --dry-run`、真实创建和 `wiki +space-list` 读回验证；唯一同名空间会直接复用，多个同名空间会失败并要求传入明确的名称与 `space_id`。创建后的本机规则默认使用“适用于全部业务方向”，后续可以通过已有资源参数更新为更精确的方向。

创建知识空间需要当前官方 CLI schema 列出的 user scope 之一，例如 `wiki:space:write_only`；Bot 身份不能创建。setup 不会在官方 CLI 要求额外确认时自动追加 `--yes`，也不会删除已创建空间。若部署者显式提供已有控制 Base，setup 只读验真该 Base，不能同时传入 `--knowledge-space-*`；知识路由和其他自然语言规则应直接在已有 Base 的“个性化规则”中维护。只有 setup 自己创建的新 Base 才会写入安全初始记录和本次选择的知识路由。

## 回复流程

1. AI 判断聊天大致属于哪个业务方向。
2. 最多选择两个最相关且当前实例允许使用的空间。
3. 使用 `drive +search --space-ids ...` 搜索候选。
4. 搜索摘要只用于筛选，不能直接当事实。
5. 对最多三个候选使用 `drive +inspect` 判断真实类型，再由 docs、Base、Sheets、Markdown 等对应能力读取正文或结构化数据。
6. 只使用实际读取到、且当前接收者有权访问的内容形成回复。

跨群信息只能引用对接收者可见的已发布 Doc、Wiki 或 Base 内容。无法确认权限、正文读取失败或来源互相冲突时，应说明依据不足并请求确认，而不是猜测。

## 失效与关闭

空间删除、重建、ID 变化或权限撤销时，停止使用该路由并更新规则；不要自动搜索相似名称后替换目标。关闭知识辅助只需删除相应路由或从本机上限移除相关 domain，不删除知识空间和文档。自动创建后若 setup 的本机步骤失败，空间会保留；修复问题后用相同命令重试，setup 会按精确名称复用。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

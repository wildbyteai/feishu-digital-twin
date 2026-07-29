# 可插拔业务能力

[English](./business-capabilities.en.md)

可插拔业务能力让数字分身在普通业务对话中按需读取最新公开信息、部署者批准的内部资料，或准备必须由主体用户本人确认的业务动作。它不是独立搜索模式，也不会把本机全部 MCP、浏览器或文件开放给 Codex。

## 公共产品包含什么

公共源码和发行清单完整包含：

- `CapabilityGateway` 公共查询契约；
- `CapabilityActionGateway` 准备、确认和单次消费契约；
- 公共 `Web Search Adapter`；
- 通用只读及确认型 `MCP Adapter`；
- 显式 `resolveCapabilityServer` MCP server resolver seam；
- `runtime/schemas/capability-pack.schema.json` 声明式能力包 Schema；
- `FakeCapabilityAdapter`、中性 fixture 和公共契约测试。

因此，私有层只保存部署者自己的能力包声明、MCP 实现与认证、真实资源标识和业务规则，不保存仅供某个部署者使用的产品功能实现。

业务决策 Codex 始终离线。它只看到语义能力、用途、允许操作、风险、信任域、就绪状态和有界输入说明；看不到私有包路径、MCP server reference、工具名、地址、确认令牌或凭据。实际查询由 `CapabilityGateway` 执行；确认型动作由 `CapabilityActionGateway` 先准备预览、再私聊本人确认、最后单次提交。

## 中性能力包示例

仓库中的 [`examples/capability-pack.example.json`](../../examples/capability-pack.example.json) 使用合成的 `example.records` / `example.records.read` 示例。能力包必须：

- 位于产品源码树之外，目录仅当前用户可访问，文件权限为 `0600`；
- 使用 `schema_version: 1` 和语义化 `pack_version`；
- 查询声明 `read` 工具；确认型动作必须成对声明非破坏性的 `prepare` 工具和破坏性的 `write` 工具，并统一使用 `internal` 信任域和 `human-fallback`；
- 精确列出允许工具、语义操作、允许输入字段、必需字段、最大输入字节和确认字段映射；
- 不包含 JavaScript、shell hook、凭据、Cookie、浏览器资料或模型配置。

候选实例配置显式列出安装包和本机能力上限：

```json
{
  "reuse_codex_mcp_servers": true,
  "private_capability_packs": ["example.records"],
  "allowed_capabilities": ["example.records.read"],
  "required_capabilities": []
}
```

`required_capabilities` 只用于决定整体 Doctor 是否降级；它必须是 `allowed_capabilities` 的子集。可选能力不可用时只让对应查询失败关闭，不会冻结无关飞书处理。

## 安装与授权

先冻结现有实例，并使用源码树外的候选配置和能力包运行 setup：

```bash
feishu-digital-twin control freeze
feishu-digital-twin setup \
  --config <private-candidate-config> \
  --capability-pack <private-capability-manifest> \
  --approve-capability-trust-zone internal
```

`--approve-capability-trust-zone internal` 只批准这次新增或改变的内部数据边界，不是日常开关。能力包改变 MCP server reference、工具绑定、信任域、操作、确认映射或输入限制时，必须重新 setup 和确认。

默认不会扫描或复用用户主 Codex/桌面应用中的 MCP 配置。只有实例显式设置 `reuse_codex_mcp_servers: true` 时，运行时才对能力包写明的精确 server reference 执行 `codex mcp get`；不会调用 MCP list，也不会发现其他本机 MCP。查询工具必须标记 `readOnlyHint: true` 且非 destructive；准备工具必须标记非只读且非 destructive；提交工具必须标记非只读且 destructive。任一声明缺失或含糊都失败关闭为 `unavailable`。真实内部 MCP、认证和私有能力包继续由部署者管理，不进入公共源码、文档示例或发行物。

确认型动作始终执行“准备 → 本人确认 → 提交”。准备结果中的确认令牌和确认文本只驻留在后台进程内存；Codex、飞书公开会话和长期 SQLite 状态都不会获得这些材料。SQLite 只保存随机 `action_id`；拒绝、过期、重复确认、能力被收紧或服务重启都会让待提交动作失败关闭。

公共 Web Search 不使用私有能力包。它只有在候选配置显式设置 `public_web_search_approved: true` 时才可安装；生产数据许可不等于公开联网许可。`allowed_capabilities` 若显式存在，还必须包含 `public.web.search` 才会允许该能力。

## 收紧能力

本机 `allowed_capabilities` 是不可突破的语义能力上限。Base 运行配置中的“允许能力”严格为“继承”时使用本机上限；显式非空列表只能与本机上限取交集。未知能力、重复项、空值、混合“继承”或试图扩权都会失败关闭。群级自然语言规则只能限制某能力何时使用，不能改变信任域、工具绑定或输入硬门。

## Doctor 与人工兜底

安装或改动后运行：

```bash
feishu-digital-twin doctor
feishu-digital-twin status
```

Doctor 只使用非业务合成检查，输出语义能力标识、稳定就绪代码、耗时和 required 标记；不读取真实流程，不调用业务工具，也不显示私有路径、MCP server reference、工具名、地址、凭据或返回正文。查询成功结果若含凭据形状会失败关闭，不透明来源引用会被丢弃。

查询或动作准备/提交出现不可用、未登录、无权限、超时、输入无效、失败或空结果时，不会改用其他信任域、浏览器或本机文件。可信运行时在原授权会话中以建议身份执行 `human-fallback`，明确说明需要人工读取或处理，不猜测业务内容，也不自动联系其他人员。

## 撤销

撤销能力时先生成候选配置，从 `allowed_capabilities` 和 `required_capabilities` 删除语义能力，并从 `private_capability_packs` 删除不再安装的包。普通配置更新只能收紧或撤销，不能新增能力：

```bash
feishu-digital-twin control freeze
feishu-digital-twin service stop
feishu-digital-twin config update --config <revoked-private-config>
feishu-digital-twin doctor
feishu-digital-twin service start
feishu-digital-twin control enable
```

更新成功后，已删除的包不会再加载或出现在能力快照中。确认不需要回退后，再由部署者删除 Git 外私有能力包文件；不要把该文件移入源码树作为备份。

## 发行隔离

公共能力包示例只能使用中性合成标识。真实发布前，私有扫描策略必须列出组织标识、私有能力包 ID、私有域名、MCP server reference 和精确工具名；公共快照会在源选择、暂存树、归档解包、插件解包、npm 解包和候选元数据阶段同时扫描这些值，以及本机路径和凭据形状。任一发现都会阻止候选生成，扫描报告只显示路径和稳定发现代码。

架构理由见 [ADR 0007](../adr/0007-capability-gateway-and-declarative-packs.md)，配置字段和兼容规则见[实例配置参考](../reference/configuration.md)与[兼容性](../compatibility.md)。

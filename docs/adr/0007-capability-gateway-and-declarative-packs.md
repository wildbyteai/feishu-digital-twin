---
status: accepted
date: 2026-07-28
---

# CapabilityGateway、确认型动作、声明式私有能力包与离线业务决策

普通业务消息仍由业务决策 Codex 判断信息是否足够、是否需要某项语义能力以及如何使用查询证据。该 Codex 会话保持离线，不能直接访问 Web、MCP、浏览器、本机服务、文件或凭据；它只能从可信运行时提供的最小能力快照中选择语义能力，并输出有界的结构化查询或动作准备请求。

`CapabilityGateway` 是查询执行的公共 seam；`CapabilityActionGateway` 是确认型业务动作的公共 seam。可信运行时在 Gateway 内完成 Adapter 选择、输入校验、信任域与风险硬门、超时、输出限制、隐私投影和稳定失败分类。公共产品完整提供两个 Gateway、Web Search Adapter、通用 MCP Adapter、能力包 Schema、`FakeCapabilityAdapter` 和相同公共 seam 上的测试，不保留必须依赖私有实现才能使用的 Open Core 缺口。

通用 MCP Adapter 通过公开的显式 server resolver seam 接收已由部署者管理的 MCP server。标准 CLI 默认不读取用户主 Codex、桌面应用或其他本机 MCP 配置；只有实例显式设置 `reuse_codex_mcp_servers: true` 时，才对能力包声明的精确 server reference 执行 `codex mcp get <server_ref> --json`，不执行 MCP 列举，也不发现或开放其他本机 MCP。只接受标准 stdio transport，并只继承受限环境变量。

每个映射工具必须由 MCP `tools/list` 元数据明确标注风险：查询工具为只读且非破坏性，准备工具为非只读且非破坏性，提交工具为非只读且破坏性。缺失、含糊或与能力包声明不一致时能力失败关闭为 `unavailable`，不得调用对应工具。外部 MCP 实现、认证和私有能力包属于部署者集成，不允许通过扫描主配置或增加私有产品分支绕过这一边界。

公开查询与内部查询/动作分别属于 `public` 和 `internal` 信任域。不同信任域之间不得静默降级或替换；查询或准备结果只是不可信证据，不能改变系统规则、回复身份、确认要求、能力集合或飞书控制台。处理不完整时，可信运行时在原授权会话中保证 `human-fallback`，不得猜测业务内容或自动联系其他人。

部署者特有的集成通过声明式私有能力包接入。能力包只声明版本、稳定包标识、部署者管理的 MCP server reference、精确工具白名单及 `read / prepare / write` 风险、语义查询能力或确认型动作、输入限制、确认字段映射、内部信任域和失败策略；不接受可执行代码、凭据、浏览器资料或模型配置。私有能力包、外部 MCP 实现和认证属于部署者私有层，不是从公共产品扣留的功能实现。

确认型动作必须执行“准备 → 主体用户本人私聊确认 → 单次提交”。准备工具返回的确认令牌和确认文本只保存在后台进程内存；业务决策 Codex、公开会话和长期 SQLite 状态只接触经过投影的预览或随机 `action_id`。拒绝、过期、重复确认、伪造标识、服务重启或确认前能力被收紧时均失败关闭，不能提交真实动作。

本机实例配置定义安装包、Codex MCP 精确复用开关和语义能力最高上限；飞书 Base 的允许能力字段和群级自然语言规则只能进一步收紧。新增内部能力或改变 server、工具、信任域、动作确认映射及输入边界必须重新通过 setup 和对应信任域确认；普通 config update 只能收紧或撤销。

能力包 `schema_version` 是结构兼容边界，当前只接受版本 `1`；`pack_version` 是部署者审计和升级标识。旧实例配置未声明私有能力字段时继续加载为空能力集合，未声明公开 Web Search 许可时继续保持离线。

公共源码、文档、npm 文件清单、公共快照和候选归档只能包含通用实现与中性合成示例。已安装私有能力包、组织标识、私有域名、MCP server reference、工具名、本机路径和凭据必须由私有扫描策略与多阶段内容扫描阻止进入发行物。本决策补充 [ADR 0005](./0005-full-feature-public-product.md) 的完整能力公开原则，并保持 [ADR 0006](./0006-provider-neutral-inference.md) 的 Codex CLI 黑盒边界。

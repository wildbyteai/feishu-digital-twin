# 外部依赖与供应链台账

本项目的稳定边界是“Codex 负责 AI 决策，飞书官方组件负责平台能力，伴随运行时只补不可替代的安全接线”。当前 npm 包没有 `dependencies`、`optionalDependencies` 或 `peerDependencies`，运行时代码只使用 Node.js 内置模块。

## 运行依赖

| 组件 | 用途与可访问数据 | 版本策略 | 许可/条款 | 是否随发行物再分发 | 升级与停用 |
| --- | --- | --- | --- | --- | --- |
| Node.js | 执行本机伴随运行时；可读取部署者明确配置的私有状态 | 支持 `package.json` 中的最低版本；升级前运行完整隔离测试 | Node.js 自身许可及其第三方声明 | 不随源码、插件或 npm 发行物再分发 | 维护者验证新 LTS；不满足最低版本时失败关闭 |
| Codex CLI | 通过 `codex exec --ephemeral` 完成业务判断与 Skill 编排；可接触当前处理所需的有界上下文 | 部署者独立安装；项目只验证命令与结构化输出契约，不锁定模型 Provider | Apache-2.0；模型服务和账号另受部署者选择的条款约束 | 不再分发，不复制登录态、配置或模型端点 | 先做无业务正文 Doctor，再升级；不可用时冻结 AI 处理，不静默切换 Provider |
| 飞书官方 `lark-cli` | 消息、任务、日历、文档、Base、Drive、Wiki 等官方 OpenAPI 能力；仅访问实例授权范围 | 部署者独立安装并选择兼容版本；重大升级先在非生产租户验收 | MIT；调用飞书/Lark API 仍受平台服务与隐私条款约束 | 不再分发，不复制 OAuth、Keychain 或 token | 官方命令契约变化时更新 Skill/测试；停用后相关域失败关闭 |
| 官方 lark-* Skills | 向 Codex提供飞书能力说明和调用规范；数据范围继承对应 `lark-cli` 命令 | 跟随已授权的官方 Skills 分发渠道；实例启动时验证必需 Skill 可用性 | 以每个 Skill 随附的许可和平台条款为准 | 不再分发官方 Skill 副本；项目只分发自己的数字分身 Skills | 优先升级自然语言契约；缺失时停用对应能力域，不以自建 SDK 顶替 |

## 开发与 CI 依赖

| 组件 | 固定方式 | 许可 | 数据边界与责任 |
| --- | --- | --- | --- |
| `actions/checkout` | 完整 commit SHA，注释可读版本号 | MIT | 只读检出；关闭凭据持久化 |
| `actions/setup-node` | 完整 commit SHA，注释可读版本号 | MIT | 只安装指定 Node.js 版本，不接触生产配置 |
| `github/codeql-action` | 完整 commit SHA | MIT | 仅公开仓启用；分析公开候选源码并上传 SARIF |
| `actions/dependency-review-action` | 完整 commit SHA | MIT | 仅检查 PR 依赖变化；不加载运行态或飞书数据 |
| `ossf/scorecard-action` | 完整 commit SHA | Apache-2.0 | 仅公开仓启用；`publish_results=false`，只上传本仓 SARIF |
| `fsfe/reuse-action` | 完整 commit SHA | GPL-3.0-or-later | 作为 CI 工具远程执行，不并入或再分发项目源码 |
| GitHub Dependabot | GitHub 托管配置 | GitHub 服务条款 | 仅跟踪 GitHub Actions；不开启生产秘密或运行态访问 |

GitHub Actions 的更新由 Dependabot 提议，维护者核对上游发行说明、commit 所属 tag、许可和权限变化后才合并。任何 Action 都必须使用完整 40 位 commit SHA，工作流默认 `contents: read`，不使用 `pull_request_target`，不向外部 PR 暴露发布凭据。

## Schema、模板与生成内容

- JSON Schema、launchd 模板、公开配置示例、项目 Skills、文档和合成测试均属于本项目源码，统一采用 Apache-2.0。
- 公共候选的归档、插件包、npm tarball、SBOM 与来源证明属于构建产物，不引入新的运行依赖；它们必须从同一审核后允许清单生成。
- 合成 fixture 只模拟命令协议，不复制官方 CLI、官方 Skill、真实消息、真实资源 ID 或企业文档。
- 引入任何新的 npm 或系统依赖前，必须记录版本、许可、再分发方式、可访问数据、升级责任人和安全停用路径；没有台账不得进入公共候选。

## 维护规则

1. 首选升级官方 `lark-cli` 与 lark-* Skills，不为旧接口长期维护自建平台封装。
2. 外部依赖升级先通过合成测试，再在全新非生产飞书租户验证；不得直接用生产聊天做兼容性测试。
3. 发现许可、完整性或供应链风险时，先冻结相关发布或能力域；本机消息处理不得因 CI/文档变更自动重载。
4. 停用组件时删除其权限、后台入口和配置引用，并保留可验证的回退版本；不得保留无人维护的隐式回退通道。

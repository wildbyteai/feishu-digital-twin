# 公共快照流水线

这条流水线从私有工作树中按精确文件允许清单生成一个待内部审核的干净候选。它不修改当前 Git 历史，不自动脱敏，也不会创建或推送公开仓库。发现路径越界、来源缺失、脏文件、Secret、PII、私有域名、本机路径或真实飞书标识符时，整次生成失败关闭。

仓库提供的示例允许清单已经覆盖现有完整产品面，不再是少量示例文件。它仍只是待审核的发布清单：只有清单中的每个文件都完成中性化、来源核清并相对原始 `HEAD` 保持干净时，才能生成真实候选。

## 配置

复制并审核两个模板：

- `release/public-snapshot.example.json`：公共文件允许清单。每个文件必须是已跟踪、相对原始 `HEAD`、index 和 worktree 无修改的普通 UTF-8 文件，并关联一个已声明的 provenance。单次快照总字节上限为 64 MiB；示例策略使用 50 MiB。
- `release/public-snapshot-private-policy.example.json`：私有扫描策略模板。实际文件应放在 `.runtime/public-snapshot-private-policy.json`，填入实例配置无法可靠推断的组织名称、业务词和私有域名，特别是未使用“公司/组织/品牌/项目/知识空间”等标签表达的短表名、文件夹名和主题，并设置权限 `0600`；未替换的示例占位值会失败关闭。该文件不能进入允许清单或候选。
- 正式构建额外显式传入活动实例配置的绝对路径。该配置必须位于源码树外、是非符号链接的普通文件并严格使用 `0600`。流水线在内存中从合法配置派生 instance ID、profile、主体名称与别名、主体标识、控制 Base/表、每日记忆目录、群 ID，以及自然语言规则中明确标注的资源引用和租户域名，再与上述私有策略合并。布尔值、数字、能力名、时区和常见通用词不会成为禁词；无法明确识别的企业业务词仍应写入私有策略。

允许清单使用精确文件路径，不支持递归 glob、排除规则或导出时重命名。`.git`、`.scratch`、`.runtime`、`.codex-runtime`、`.workbuddy`、私有 Overlay 和任何 `*.privacy-key` 路径永久禁止进入候选。
每个 provenance 的 `origin` 必须是已核清的中性小写标识；`unknown`、`pending`、`tbd` 等未决来源会在策略阶段失败。

现有部署兼容入口 `bin/twin-supervisor.mjs` 与 `runtime/bin/twin-runtime.mjs` 只用于本机旧实例连续运行。它们不进入公共源码快照、Codex 插件包或 npm tarball；公开安装统一使用 `bin/feishu-digital-twin-supervisor.mjs` 与 `runtime/bin/feishu-digital-twin-runtime.mjs`。插件包和 npm tarball 只用于本地一致性与安装闭环验证，不作为公共下载渠道。

修改允许清单后，可以先做不读取业务数据、不运行连续性检查的结构校验：

```bash
node bin/twin-public-snapshot.mjs \
  policy-check \
  release/public-snapshot.example.json
```

成功结果只返回 archive prefix、文件数和来源类别数，不输出文件路径或私有策略值。该检查只证明清单结构有效；它不能替代完整 build 的 Git 一致性、隐私扫描、归档回读和连续性门。

公共 CI 还会用不包含任何部署者私有词表的通用规则扫描允许清单中的每个文件：

```bash
node bin/twin-public-content-scan.mjs \
  release/public-snapshot.example.json
```

该入口检查 Secret 形状、个人信息、私有域名、本机路径和飞书资源标识；输出只包含扫描计数、finding code 和相对路径，不回显命中正文。它适合公开仓每次 PR 使用，但不能替代完整 build 使用的维护者私有姓名、组织和域名词表。

## 执行

先确认本地连续性检查健康。正式构建应使用源码树外、仅当前用户可访问的独立输出目录；候选树包含正常的公开文件模式，不应混入本机私有运行态根目录：

```bash
RELEASE_OUTPUT="${HOME}/.feishu-digital-twin-release"
mkdir -p "$RELEASE_OUTPUT"
chmod 700 "$RELEASE_OUTPUT"

npm run continuity:check
npm run public-snapshot:build -- \
  release/public-snapshot.example.json \
  .runtime/public-snapshot-private-policy.json \
  "$RELEASE_OUTPUT" \
  .runtime/continuity.json \
  --instance-config /absolute/path/to/instance-config.json
```

公开策略、私有策略和连续性清单只接受项目内规范化相对路径；输出目录接受 Git 忽略的项目内 `.runtime/...` 路径，或已经存在、权限为 `0700` 的规范化绝对路径。真实连续性清单通常把 `.runtime` 作为私有状态根，因此正式候选应使用后一种源码树外目录。`--instance-config` 只接受源码树外的规范化绝对路径。实例配置缺失、越界、权限不是 `0600`、不是普通文件或内容不符合活动配置 Schema 时，会在连续性检查前以 `instance-config-invalid` 失败关闭。参数错误退出 `64`；门禁失败退出 `1`；成功退出 `0`。标准输出只包含成功状态 `candidate`、候选 ID、版本、文件数以及 tree、source、Codex plugin、npm、SBOM 和本地来源记录的 SHA-256，不输出绝对路径、命中正文、私有词表或配置值。

## 验证阶段

1. `continuity-before`：只读捕获实时服务、补读、每日记忆、冻结和私有状态健康基线。
2. `source-selection`：验证允许清单、Git 原始提交、index、worktree、特殊 index 标志、仓库锁、普通文件和父目录链、来源声明及大小限制。Git replacement refs、继承的 `GIT_*` 覆盖和 pathspec 魔法不会改变选择结果；内容只从已验证的捕获字节进入后续流水线，并执行第一次扫描。
3. `staging-tree`：复制到私有临时目录，第二次扫描并校验文件集合、mode、字节数和 SHA-256 未漂移。
4. `archive-unpacked`：生成确定性 source USTAR，在第二个临时目录流式安全解包，逐项限制文件数和总字节；只接受本流水线生成的 canonical USTAR header，拒绝路径穿越、链接、设备节点、隐藏 header 元数据、额外文件和摘要漂移，再执行扫描。
5. `release-metadata`：从已扫描 tree 读取 `package.json` 与 `.codex-plugin/plugin.json`，要求名称和版本一致，并把 npm 文件白名单限制为公共允许清单的子集。
6. `plugin-unpacked`：从同一 tree 生成带项目根前缀的 Codex 插件 USTAR，解包后重新扫描并逐文件验证摘要。
7. `npm-unpacked`：从同一 tree 的 npm 白名单生成 `package/` 根 tarball，解压、解包、重新扫描并逐文件验证摘要。
8. `sbom-create`：从同一已扫描 tree 生成确定性的 SPDX 2.3 JSON，逐文件绑定 SHA-256、Apache-2.0 声明和 package verification code；固定生成时间只用于保证同一 source tree 可重复生成，不代表真实构建时间。
9. `provenance-create`：生成一条不含仓库地址、账号、主机名、本机路径或 Provider 信息的 in-toto Statement / SLSA Provenance v1 本地来源记录，绑定 source、Codex plugin、npm 和 SBOM 摘要。它明确标记为 `unsigned-local-record`，不能冒充 GitHub/Sigstore 签名证明。
10. `candidate-metadata`：扫描公开 manifest、SBOM、来源记录与 `SHA256SUMS`，并精确校验候选根只能包含 `tree/`、`source.tar`、`codex-plugin.tar`、`npm-package.tgz`、`sbom.spdx.json`、`provenance.intoto.jsonl`、`snapshot-manifest.json` 和 `SHA256SUMS`。
11. `continuity-after`：在隐藏 attempt 完整生成后先与变更前基线比较并重新核验源 Git 状态和全部内容；随后自底向上同步候选目录，再执行一次紧邻提交边界的终态比较与回读。通过后写入 `status: attested` 的 `0600` 本机收据并持久化其目录项，最后才把隐藏 attempt 原子 rename 为 `candidates/sha256-*`。最终 rename 之后只同步父目录并返回，不再重新读取或改写候选内容。

## 成功产物

```text
candidates/sha256-<tree-digest>/
  tree/
  source.tar
  codex-plugin.tar
  npm-package.tgz
  sbom.spdx.json
  provenance.intoto.jsonl
  snapshot-manifest.json
  SHA256SUMS
```

`snapshot-manifest.json` 记录每个文件的路径、规范化 mode、字节数、SHA-256、provenance 和 synthetic 标记，以及 tree、policy、source/plugin/npm/SBOM/来源记录摘要和各阶段零告警扫描摘要。三个发行物、SBOM 和来源记录都绑定同一版本与 `source_tree_sha256`；`tree_sha256` 是跨环境重复生成的权威内容标识。source 和 Codex plugin 当前包含完整公共允许集合，npm 是其中由 `package.json.files` 声明且再次验证的运行时子集。

候选生成后可以在不读取私有策略、凭据或业务数据的环境中执行只读一致性校验：

```bash
node bin/twin-public-snapshot.mjs \
  verify \
  "$RELEASE_OUTPUT/candidates/sha256-<tree-digest>"
```

该命令验证候选布局、tree、manifest、全部 SHA-256、SPDX 文件映射以及 in-toto/SLSA subject 绑定，只输出摘要。当前稳定分发只使用受保护主干和不可变 Git 标签，因此本地 attestation 只作为内容与来源校验证据，不宣称是 GitHub OIDC/Sigstore 签名。若以后通过新 ADR 增加独立制品发布渠道，再为该渠道定义签名要求。

最初建立公共仓时不得复制私有 Git 历史；这一历史隔离约束继续有效。后续稳定版本只能通过受保护主干合并，并在必需检查通过后创建不可变 Git 标签。完整边界见[完整开源方案](../public/open-source-plan.md)。

成功 attestation 和失败 receipt 均使用 `0600`，绑定公开策略、合并后的私有扫描策略、manifest 和连续性证据摘要，只记录阶段码、规则码、清理状态和摘要，不保存实例配置路径、派生禁词、命中正文、原始健康报告或私有词表。实例配置只读一次并在内存中派生规则，不复制到 attempt、候选或 receipt。`status: attested` 只表示内容与证据已核验，不单独表示生成成功；只有候选目录存在，且 candidate ID、tree、manifest 与策略摘要全部和 attestation 配对时，才是可审核候选。attestation 先持久化，候选目录的最终原子 rename 是唯一公开候选可见边界，因此进程在两步之间被强制终止时最多留下无候选的私有 attestation，不会留下看似可发布的候选目录。

失败 receipt 的 `cleanup_status` 为 `removed`、`quarantined`、`failed` 或 `not-required`。`failed` 会同时记录 `cleanup-failed`，表示所有权证据异常导致流水线拒绝自动删除；该目录仍是私有失败产物，不是候选。任何正常失败都不会新增或遗留本次运行创建的 `candidates/` 项，既有成功候选不受影响；清理异常只进入私有 quarantine 或保留私有 attempt，永不被误标为成功 receipt。

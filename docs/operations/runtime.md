# 后台运行与维护

安装完成后，数字分身由 macOS 用户级 LaunchAgent 托管，不依赖 Codex 桌面窗口持续打开。

## 三个后台角色

| 角色 | 职责 |
| --- | --- |
| `realtime` | 消费 Bot 的官方 `im.message.receive_v1` 实时事件 |
| `supplement` | 在消息范围允许时补充读取主体用户可见的新消息 |
| `daily-memory` | 按主体时区生成每日工作记忆并写后读回 |

工作日 09:00（含）至 18:00（不含）默认每 30 秒补读一次，其他时间默认每 5 分钟一次。电脑睡眠、断网或重启后，补读游标和回看窗口用于防漏；关机、用户未登录或深度睡眠期间无法实时处理。

## 状态与日常控制

```bash
feishu-digital-twin status
feishu-digital-twin control enable
feishu-digital-twin control freeze
feishu-digital-twin control upgrade --source <absolute-new-release-tree> --restart
feishu-digital-twin control rollback --restart
feishu-digital-twin control uninstall
```

`status` 的用户级结论：

- `ready`：配置、Doctor、冻结状态和需要的后台角色均满足生产条件。
- `safe-but-disabled`：系统安全但当前冻结或生产开关关闭。
- `degraded`：配置、身份、Doctor、服务或结果状态存在故障，不应自动处理。

`status` 对本机 SQLite 运行态只查询冻结状态。它把经过前后稳定性校验的主库和当前 WAL 复制到 `0700`/`0600` 的本机临时快照，在快照上打开 SQLite，并在查询后立即清理；源实例的主库、WAL 和 SHM 都不会被 SQLite 打开或改写，也不会执行 `chmod`、Schema 迁移、确认过期清理或其他维护写入。查询期间源状态发生变化时最多重试三次，不能取得稳定快照就失败关闭。因此它可用于只读沙箱和故障诊断，不会因为调用者没有实例目录写权限而把健康服务误报为 `LOCAL_COMMAND_FAILED`。状态表或唯一状态行缺失、数据库损坏或只读查询失败时，`status` 失败关闭为 `degraded` 与冻结摘要，不会按“未冻结”继续运行。

高级排障可使用 `service install|start|stop|restart|status|uninstall`，但普通运维优先使用 `control`，避免绕过产品后置检查。

## 本机数据与权限

安装根、版本目录和 `private` 目录只属于当前用户；私有目录权限为 `0700`，配置、SQLite、计划文件和 `*.privacy-key` 为 `0600`。日志只保存脱敏阶段码、数量、耗时和错误分类，并按配置保留期和大小上限轮转。

## 升级、回退和卸载

新发行树从同一版本的正式 Release 候选取得，不从当前运行实例或 Marketplace 缓存拼装。下载该版本的完整候选目录（`source.tar`、`codex-plugin.tar`、`npm-package.tgz`、SBOM、来源记录、`snapshot-manifest.json` 和 `SHA256SUMS`），验证发布页上的签名 attestation 后，再在一个新的空目录中解包和执行候选自验：

```bash
CANDIDATE=<absolute-downloaded-candidate-directory>
mkdir "$CANDIDATE/tree"
tar -xf "$CANDIDATE/source.tar" -C "$CANDIDATE/tree"
(cd "$CANDIDATE" && shasum -a 256 -c SHA256SUMS)
node "$CANDIDATE/tree/bin/twin-public-snapshot.mjs" verify "$CANDIDATE"
```

只有上述两类验证都通过时，`$CANDIDATE/tree` 才是可交给 `--source` 的新发行树；完整候选布局和自验边界见[公共快照与隐私门](./public-snapshot.md)。

升级会先把新版本复制到独立目录，验证包结构、配置兼容、Doctor 和服务后再切换当前版本。失败时恢复上一已验证版本和原服务状态。后台服务已加载时，升级和回退必须使用 `--restart` 完成受控切换；通过当前已安装实例执行升级时，`--source` 必须指向绝对路径下、版本号不同的已验证新发行树。同一版本号视为不可变，命令返回 `status=unchanged`，不会覆盖已安装文件。

卸载默认移除服务和版本化运行时，但保留私有配置、状态和审计所需的脱敏结果。`--purge` 会删除私有数据，执行前必须确认已经完成必要备份且不再需要恢复。

## 常见故障

- realtime 不健康：核对 Bot 身份、事件订阅和事件总线状态。
- supplement 过期：核对 user Token、消息范围和调度结果。
- daily-memory 失败或过期：核对目标文件夹、日期、同名文档和写后读回结果。
- Codex Doctor 失败：在后台实际环境修复 Codex，不要把桌面登录成功当作后台可用。
- 重复回复：保持冻结，检查去重状态和是否存在第二个事件消费者。

本页描述产品运行方式；发布过程中的“不影响现有本机实例”门禁见[本地服务连续性](local-service-continuity.md)。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、完整日志或业务正文。排障时只分享稳定错误码和已脱敏状态摘要。

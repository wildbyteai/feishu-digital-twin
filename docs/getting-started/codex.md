# 启用 Codex

数字分身把 Codex CLI 当作唯一的大模型入口，只依赖 `codex exec --ephemeral` 的非交互结构化输出。Codex 内部使用官方登录、API Key、自建模型服务还是企业网关，由部署者自己的 Codex 环境决定。

本项目不读取 Codex 的认证、模型、端点或 Provider 配置，不保存 API Key，也不实现 Provider 选择、切换或备用端点。

## 需要提供的配置

| 配置 | 用途 | 敏感级别 | 保存方式 |
| --- | --- | --- | --- |
| `codex_bin` | 后台实际调用的 Codex 可执行文件 | 本机路径 | Git 外私有配置 |
| `codex_environment_root` | 后台隔离环境根目录 | 高敏环境引用 | 权限受控的私有目录 |
| `codex_timeout_ms` | 单次推理超时 | 普通配置 | Git 外私有配置 |
| `production_data_approved` | 确认该环境获准处理目标飞书正文 | 企业数据边界 | Git 外私有配置 |

环境根必须是普通私有目录；在类 Unix 系统上不能允许组用户或其他用户访问。认证材料继续留在 Codex 自身管理的位置，数字分身只保存目录引用。

## 验证方式

安装器会从后台服务实际使用的环境运行一个没有业务正文的结构化 Doctor。它只验证：

- Codex 可执行文件存在且可执行；
- `codex exec --ephemeral` 能非交互运行；
- 输出满足数字分身决策 Schema；
- 超时和失败能够被稳定识别；
- 后台环境中安装了运行所需的 lark-* Skills。

准备好环境后，在全局配置命令中显式传入：

```bash
feishu-digital-twin setup \
  --profile <profile> \
  --codex-environment-root <private-codex-environment> \
  --approve-production-data
```

`--approve-production-data` 表示部署者确认这个 Codex 环境及其内部模型服务获准处理该实例允许读取的飞书正文。它不代表项目识别或认证了模型供应商。

## 成功后置条件

Doctor 返回通过，后台非交互调用不依赖 Codex 桌面窗口，结构化结果可解析且没有超时；只有同时通过飞书身份、私有目录和服务健康检查后，`setup` 才解除冻结。

## 常见错误与安全回退

- 终端可运行、后台找不到 Codex：显式传 `--codex-bin`，不要依赖交互终端特有的 PATH。
- 环境根权限过宽：收紧目录权限后重新执行 Doctor。
- 后台未登录或认证失效：在同一个隔离环境中修复 Codex 自身认证。
- 结构化输出不兼容：升级或回退 Codex，再重新执行 Doctor。
- 推理超时：在配置允许范围内调整 `codex_timeout_ms`，不要把无限等待作为恢复手段。

Codex 可执行文件或环境根发生变化时，先冻结当前实例；当前产品要求使用新实例重新完成 Doctor 和生产数据确认。模型或端点在同一 Codex 环境内部变化时，也必须重新核对数据处理边界。

不要在公开 Issue/PR 粘贴配置、凭据、二维码、日志或业务正文。

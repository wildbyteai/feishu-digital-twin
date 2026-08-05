# 飞书组织切换前置路由

这是一份 Agent 路由说明。每次执行本说明时，第一步都必须判断：**当前正在执行指令的 Agent 是 WorkBuddy 还是 Codex。**

路由依据只看当前对话和执行环境的 Agent 身份，不看用户使用几种产品，也不看电脑上安装了哪些软件。

## 路由规则

| 当前执行指令的 Agent | 应进入的手册 | 允许处理的范围 |
| --- | --- | --- |
| WorkBuddy | [在 WorkBuddy 中重置飞书连接器并切换组织](switch-workbuddy-feishu-organization.md) | WorkBuddy 连接器、WorkBuddy 自带 CLI 进程、WorkBuddy 本机缓存和重新连接 |
| Codex | [在 Codex 中切换飞书 CLI 组织与 Profile](switch-feishu-cli-organization.md) | Codex 终端中官方 `lark-cli` 的 profiles、登录态和默认 profile |
| 无法确认 | 停止并询问用户 | 不执行任何删除、注销、kill 或覆盖操作 |

## 必须遵守

1. 当前 Agent 必须先明确声明自己是 WorkBuddy 还是 Codex。
2. WorkBuddy Agent 只能执行 WorkBuddy 手册，不得因为电脑上可能装有 Codex，就代替 Codex 修改其 profiles。
3. Codex Agent 只能执行 Codex 手册，不得因为电脑上可能装有 WorkBuddy，就代替 WorkBuddy 清连接器缓存或结束其进程。
4. 不通过扫描已安装应用来猜测当前 Agent 身份；应根据当前产品运行上下文判断。
5. 如果当前运行上下文没有明确产品标识，直接问用户：“当前这段对话是在 WorkBuddy 还是 Codex 中执行？”
6. 即使用户同时使用 WorkBuddy 和 Codex，也要分别在两个产品中各执行一次本路由：
   - 在 WorkBuddy 中打开本路由，只进入 WorkBuddy 手册；
   - 在 Codex 中打开本路由，只进入 Codex 手册。
7. 两份手册各自完成、各自验证，不把一个产品的成功状态当作另一个产品已经切换成功。

## 可直接交给任一 Agent 的路由指令

```text
请先判断当前执行环境中的你是 WorkBuddy Agent 还是 Codex Agent。判断依据是当前产品和运行上下文，不是这台电脑安装了哪些软件。

- 如果你是 WorkBuddy：只执行《在 WorkBuddy 中重置飞书连接器并切换组织》，不得修改 Codex 的 lark-cli profiles。
- 如果你是 Codex：只执行《在 Codex 中切换飞书 CLI 组织与 Profile》，不得清理 WorkBuddy 缓存或终结 WorkBuddy 进程。
- 如果无法确认你当前属于哪个产品：立即停止并询问我，不要猜测。

即使这台电脑同时使用 WorkBuddy 和 Codex，你也只能处理当前 Agent 自己负责的那一份。另一份应由我在对应产品中另行执行。
```

## 需要分别切换两端时

如果用户希望 WorkBuddy 和 Codex 都切换，应发起两次彼此独立的操作；每次仍从当前 Agent 身份开始路由：

1. 在 WorkBuddy 中执行 WorkBuddy 手册，最终以 WorkBuddy 连接器显示目标组织为成功标准；
2. 在 Codex 中执行 Codex 手册，最终以 `lark-cli whoami`、`auth status --verify` 和默认 profile 正确为成功标准。

两次操作可以在不同时间完成。任何一端尚未执行或验证，都只能报告该端“待切换”，不能推断另一端状态。

## 示例目标

- 目标组织：`上海传美实业（saselomo）`
- Codex 目标 profile：`saselomo`

WorkBuddy 手册只需要目标组织名称，不要求用户提供 Codex profile。Codex 手册需要目标组织名称和目标 profile。

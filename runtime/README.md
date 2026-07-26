# Runtime

The runtime has four responsibilities: call ephemeral Codex with the project
Skill, add trusted authority labels, hold minimal local SQLite state, and pass
approved argv to `LarkGuard` for execution through official `lark-cli`
components.

It is intentionally not a workflow engine, authorization compiler, chat
database, Feishu SDK, or model-backend client. The runtime treats Codex CLI as
a black box. Instance configuration contains only `codex_bin`,
`codex_environment_root`, `codex_timeout_ms`, and production-data permission;
Codex itself owns authentication, model, and endpoint configuration.

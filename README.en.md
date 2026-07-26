[中文](./README.md) | [English](./README.en.md)

# Feishu Digital Twin

A complete open-source, self-hosted Feishu digital twin powered by Codex, the official Feishu `lark-cli`, and lark-* Skills.

This is not a conventional Bot that responds only when explicitly mentioned. AI uses natural-language rules to decide whether to ignore, reply, ask a follow-up question, request confirmation from the principal user, or invoke Feishu capabilities. A message is answered through the identity that received it. Every automatically generated message carries a `🤖` disclosure mark.

> This project is not an official product of Feishu, Lark, or OpenAI. All trademarks belong to their respective owners.

> The current public version is `v0.1.10`. macOS is the supported production platform. Installation is currently available from GitHub source or a version tag; npm and Codex Marketplace one-click packages have not been published.

## Five-minute overview

| Capability | Description |
| --- | --- |
| Intelligent messaging | Handles Bot-visible events in real time. After the deployer explicitly approves a broader scope, it can supplement those events with internal or all chats visible to the principal user. |
| Dual-identity replies | Messages sent to the Bot are answered by the Bot; messages sent to the principal user are answered with the principal user's identity. The model cannot switch identities by itself. |
| AI decisions and execution | Codex, Skills, and natural-language rules decide when to engage, what to say, when to request confirmation, and which actions to run. |
| Feishu work execution | Uses the official `lark-cli` for messages, tasks, calendars, documents, Base, Drive, Wiki, and related capabilities. |
| Base control console | Optionally uses two existing Base tables for the master switch, natural-language rules, group-specific rules, and knowledge routing. |
| Enterprise knowledge | Classifies the direction of a conversation and retrieves relevant content from configured enterprise knowledge spaces before replying. |
| Daily work memory | Summarizes the day's chats, tasks, calendar events, and execution results into a designated Feishu Drive folder. |
| Long-running local service | Starts real-time intake, supplemental reads, and daily memory after macOS login, with status, freeze, upgrade, rollback, and uninstall commands. |

The runtime keeps only the short-lived state required for deduplication, supplemental-read cursors, freezing, pending confirmation, and bounded execution feedback. It does not build a long-term local chat database. Ownership transfer is permanently prohibited from automatic execution.

## Prerequisites

- macOS;
- Node.js 22.13 or later;
- the official Feishu `lark-cli`, installed and authorized;
- a Feishu application with a Bot and message events enabled;
- a Codex CLI environment that can run `codex exec --ephemeral` non-interactively in the background;
- a model-service environment approved to process the selected Feishu business data;
- when using the Base control console, an existing Base and two control tables. An existing enterprise knowledge space and daily-memory folder can be supplied, or `setup` can create them through the official CLI.

Install a fixed version from GitHub:

```bash
git clone --branch v0.1.10 --depth 1 https://github.com/wildbyteai/feishu-digital-twin.git
cd feishu-digital-twin
npm install --global .
feishu-digital-twin --help
```

If you do not want a global installation, replace `feishu-digital-twin` in the examples below with `node bin/feishu-digital-twin.mjs` while inside the repository.

## What `setup` automates

| `setup` performs automatically | The deployer must prepare |
| --- | --- |
| Discovers and verifies the principal user and Bot identities in the selected `lark-cli` profile | Create the Feishu application, enable the Bot, and publish an application version |
| Verifies that Codex can perform one structured inference without business content | Configure required application permissions and subscribe to `im.message.receive_v1` |
| Derives the minimum local Feishu business domains from `--capabilities` | Complete the required Bot scopes and principal-user OAuth authorization |
| Read-only verifies supplied Base, table, Wiki, and Drive references | Create the Base and its two tables when the [Base control console](./docs/feishu-console.md) is enabled |
| After explicit `--create-missing-resources` approval, creates and reads back the missing knowledge space and daily-memory folder as the user | Otherwise provide the name and stable ID or token of existing resources |
| Writes a private, current-user-only configuration outside the Git worktree | Confirm that the deterministic default resource names are suitable |
| Installs and starts three macOS LaunchAgent roles | Confirm that the model environment is approved for the relevant Feishu data |
| Runs Doctor, reads back status, and restores the prior local state on failure | Select the message scope and enabled capabilities |

> **Base and its two control tables must still be created in advance. A knowledge space and daily-memory folder are optional prerequisites: when they are missing, `setup` lists exactly what is needed. With `--create-missing-resources`, it performs the official dry run, creation, and read-back verification through `wiki +space-create` and `drive +create-folder`.**

Automatic creation uses the principal user's identity and the exact deterministic names `<principal display name>的数字分身知识库` and `<principal display name>的每日工作记忆`. Re-running setup reuses one exact-name match. If multiple resources have the same name, setup stops and requires an explicit ID or token. If a later local step fails, successfully created Feishu resources are retained and reused on the next run. Real IDs, tokens, and enterprise rules are written only to a Git-external `0600` private configuration and are not echoed in normal command output.

## Features and required permissions

Feishu permissions have three layers: the application's **Bot scopes**, the principal user's OAuth **User scopes**, and the local `allowed_lark_domains` ceiling. A capability works only when the Feishu scope for the executing identity and the local domain are both allowed. Bot-only capabilities do not require unrelated User scopes, and User-only capabilities do not require unrelated Bot scopes. Local configuration can never replace or expand Feishu authorization.

| Product capability | `--capabilities` value | Local domain | Primary identity | Feishu-side preparation |
| --- | --- | --- | --- | --- |
| Message intake and replies | `message` | `im` | Bot; optional User | Bot message receive/reply scopes and `im.message.receive_v1`; add User chat/message read scopes only for a broader message scope |
| Tasks | `task` | `task` | User | Task read scope; add write scope only when creating or updating tasks |
| Calendar | `calendar` | `calendar` | User | Calendar read scope; add write scope only for reminders, meetings, or updates |
| Documents | `docs` | `docs,drive` | User | Document and Drive read scopes; add the relevant write scopes for creation or updates |
| Base | `base` | `base` | User | Base read scope; add record write scope only when needed |
| Enterprise knowledge | `enterprise_knowledge` | `drive,wiki,docs,base,sheets,markdown` | User | Read scopes for Wiki, Drive, and the actual content types in use |
| Daily work memory | `daily_memory` | `im,task,calendar,drive,docs` | User | Read access to the day's facts plus write access to the target Drive folder and document |
| Base control console | `console` | `base` | User | Read access to the selected Base and its two control tables |

New instances default to `message_scope=bot_only` and the `im` domain. Do not request `all` by default, and do not request organization-management or member-management permissions unrelated to the selected capabilities.

Exact scope names can evolve with the Feishu Open Platform and `lark-cli`. Use the current CLI to obtain the authoritative list:

```bash
lark-cli --profile <profile> auth scopes --json
lark-cli --profile <profile> auth check --scope "<space-separated-scopes>" --json
lark-cli schema <service.resource.method> --format json
```

Handle missing Bot scopes in the Feishu developer console. Grant missing User scopes incrementally to the target profile through OAuth. See the [minimum Feishu permission reference](./docs/reference/feishu-permissions.md) for details.

## Get started in three steps

1. **[Connect the official Feishu CLI](./docs/getting-started/feishu-cli.md)**: install `lark-cli`, create and publish the Feishu application, enable the Bot, configure `im.message.receive_v1`, and complete the required Bot scopes and principal-user OAuth.
2. **[Enable Codex](./docs/getting-started/codex.md)**: prepare a Codex environment that can execute `codex exec --ephemeral` non-interactively and is approved to process the target Feishu data. Codex may internally use official login, an API key, a private model service, or an enterprise gateway; this project does not integrate a Provider API directly.
3. **[Complete global configuration](./docs/getting-started/global-configuration.md)**: choose one of the setup scenarios below. A normal deployment does not require hand-written JSON.

### Scenario A: minimum message mode

Handle only messages officially visible to the Bot. Base, Wiki, and a daily-memory folder are not required:

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --capabilities message \
  --approve-production-data
```

### Scenario B: include messages visible to the principal user

Use `internal_visible` for internal chats and direct messages. Use `all_visible` only when external groups must also be included:

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message \
  --approve-message-scope \
  --approve-production-data
```

`--approve-message-scope` is mandatory when first selecting a non-`bot_only` scope or broadening an existing scope. Base, AI, ordinary messages, and background jobs cannot broaden it by themselves.

### Scenario C: no existing knowledge space or daily-memory folder

For a simple full-capability installation without the Base console, let setup create the missing resources through the official CLI:

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message,task,calendar,docs,enterprise_knowledge,daily_memory \
  --create-missing-resources \
  --approve-message-scope \
  --approve-production-data
```

Without `--create-missing-resources`, setup performs no silent write. It returns `missing_resources`, the options for selecting existing resources, and the explicit automatic-creation option.

### Scenario D: Base control console with existing resources

First create the Base and two control tables according to the [Base control console schema](./docs/feishu-console.md). The runtime table must contain exactly one valid runtime record. The group-rules table may contain no records, but both tables must contain all documented fields. The allowed-domain field must be exactly “inherit” or a non-empty subset of the local ceiling. Knowledge routing is maintained in the Base rules; an existing daily-memory folder can be supplied directly:

```bash
feishu-digital-twin setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message,task,calendar,docs,enterprise_knowledge,daily_memory,console \
  --console-base-token <existing-base-token> \
  --console-runtime-table <existing-runtime-table-name-or-id> \
  --console-group-rules-table <existing-group-rules-table-name-or-id> \
  --daily-memory-folder-token <existing-folder-token> \
  --daily-memory-folder-name <existing-folder-name> \
  --approve-message-scope \
  --approve-production-data
```

Without the Base console, an existing knowledge space can be referenced with `--knowledge-space-name`, `--knowledge-space-id`, and `--knowledge-direction` as one group. See [global configuration](./docs/getting-started/global-configuration.md) for every option.

## Post-installation verification

```bash
feishu-digital-twin doctor
feishu-digital-twin status
```

A normally enabled installation should satisfy all of the following:

- `setup` returns `status=setup-complete`;
- a subsequent `status` command reads the instance and service state successfully;
- `readiness=ready`, or `safe-but-disabled` when the local or Base master switch is explicitly off;
- the `realtime`, `supplement`, and `daily-memory` roles are healthy;
- one Feishu application has exactly one official real-time message consumer;
- private configuration is outside the Git worktree and readable only by the current user;
- actual message, task, calendar, knowledge, and daily-memory behavior matches the selected permissions.

`readiness=degraded` means setup is incomplete and automatic handling should not begin. A running upgrade requires both `--source` and `--restart`; a running rollback requires `--restart`. An installed version is never overwritten by another source with the same version number.

```bash
feishu-digital-twin status
feishu-digital-twin control freeze
feishu-digital-twin control enable
feishu-digital-twin control upgrade --source <absolute-new-release-tree> --restart
feishu-digital-twin control rollback --restart
feishu-digital-twin control uninstall
```

See [runtime operations](./docs/operations/runtime.md) for details. Uninstall keeps local private data by default.

## Configuration and privacy boundaries

- Real instance configuration and runtime state stay outside the Git worktree. Private directories use `0700`; sensitive files use `0600`.
- Do not copy another person's `lark-cli` profile, Keychain, Codex login state, resource IDs, or instance configuration.
- The project has no remote telemetry by default and does not upload diagnostic bundles. Runtime logs do not retain message bodies, full model output, or credentials, and the project does not build long-term chat history. Pending confirmation keeps only the minimum action addressing for up to ten minutes and clears it after approval, rejection, or expiry.
- `allowed_lark_domains` is a local ceiling that cannot be exceeded. The Base console can only narrow it.
- Trusted runtime code enforces reply identity, the `🤖` disclosure mark, freezing, deduplication, supplemental-read cursors, and the ownership-transfer prohibition.
- The installer never creates or modifies Base or its control tables. Only an explicit `--create-missing-resources` allows the official CLI to create a missing Wiki space and Drive daily-memory folder.

The model service used inside Codex is controlled by the deployer's own Codex configuration. This project invokes only `codex exec --ephemeral`; it does not store model endpoints or implement Provider selection and switching. The deployer is responsible for ensuring that the Codex environment is approved for the relevant Feishu data.

See [privacy and data processing](./docs/security/privacy.md) and the [instance configuration reference](./docs/reference/configuration.md).

## Architecture principles

1. **AI-driven**: keep business judgment and action orchestration in Codex, Skills, and natural-language configuration.
2. **Official components first**: use the official Feishu `lark-cli` and lark-* Skills wherever possible.
3. **Complete open source**: publish every stable feature; do not use an Open Core split.
4. **Minimum custom code**: custom code fills only the event wiring, identity routing, deduplication, freeze, cursor, and short-lived state gaps that official components cannot cover.
5. **Local privacy first**: no remote telemetry by default and no long-term storage of chat bodies.

```text
Feishu Bot events + principal-user supplemental reads after scope approval
                              ↓
                    companion runtime + Skills
                              ↓
                    codex exec --ephemeral
                              ↓
                    LarkGuard + official lark-cli
```

The project does not rebuild a Feishu SDK, model SDK, action catalog, approval system, workflow engine, or local chat database.

## Documentation

- [Connect the official Feishu CLI](./docs/getting-started/feishu-cli.md)
- [Enable Codex](./docs/getting-started/codex.md)
- [Complete global configuration](./docs/getting-started/global-configuration.md)
- [Instance configuration reference](./docs/reference/configuration.md)
- [Minimum Feishu permission reference](./docs/reference/feishu-permissions.md)
- [Runtime operations](./docs/operations/runtime.md)
- [Privacy and data processing](./docs/security/privacy.md)
- [Compatibility](./docs/compatibility.md)
- [Daily work memory](./docs/features/daily-memory.md)
- [Enterprise knowledge-assisted replies](./docs/features/enterprise-knowledge.md)
- [Base control console](./docs/feishu-console.md)
- [Local service continuity](./docs/operations/local-service-continuity.md)
- [Public snapshot and privacy gate](./docs/operations/public-snapshot.md)
- [Complete public product specification](./docs/public/product-spec.md)
- [Complete open-source plan](./docs/public/open-source-plan.md)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

## License

This project is licensed under the [Apache License 2.0](./LICENSE).

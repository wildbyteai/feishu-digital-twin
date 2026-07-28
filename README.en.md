[中文](./README.md) | [English](./README.en.md)

# Feishu Digital Twin

Turn Codex into a self-hosted Feishu work agent that can handle messages and perform real work within explicit identity, permission, and confirmation boundaries.

[Get started](#get-started-in-three-steps) · [Features and permissions](#features-and-required-permissions) · [Operations and rollback](#post-installation-verification) · [Privacy boundaries](#configuration-and-privacy-boundaries) · [Architecture](#architecture-principles)

> This project is not an official product of Feishu, Lark, or OpenAI. All trademarks belong to their respective owners.

## Understand it in one minute

Feishu Digital Twin is an AI work agent that runs on your own macOS device:

- **Receive context**: handle Bot-visible messages in real time, expanding to chats visible to the principal user only after explicit deployment approval.
- **Make decisions**: use Codex and natural-language rules to ignore, reply, ask a follow-up question, request confirmation, or execute an action.
- **Perform work**: use the official Feishu `lark-cli` and lark-* Skills for messages, tasks, calendars, documents, Base, Drive, Wiki, and related capabilities.
- **Preserve identity**: reply as the Bot when the Bot receives the message, and as the principal user when that identity receives it; the model cannot switch identities by itself.
- **Keep human control**: combine local permission ceilings, Feishu authorization, the Base master switch, and confirmation rules to constrain visibility and execution.

```text
Feishu events / supplemental reads → safe intake and identity routing → Codex decision → official lark-cli → reply or work result
```

This is neither a conventional mention-only Bot nor a hosted SaaS. Every automatically generated message carries a `🤖` disclosure mark. The system does not build a long-term local chat database, and resource ownership transfer is permanently prohibited from automatic execution.

## What it can do

| Capability | Description |
| --- | --- |
| Intelligent messaging | Handles Bot-visible messages in real time and, after explicit approval, supplements them with internal or all chats visible to the principal user. |
| Dual-identity replies | Messages sent to the Bot are answered by the Bot; messages sent to the principal user are answered with the principal user's identity. The model cannot switch identities by itself. |
| AI decisions and execution | Codex, Skills, and natural-language rules decide when to engage, what to say, when to request confirmation, and which actions to run. |
| Feishu work execution | Uses the official `lark-cli` for messages, tasks, calendars, documents, Base, Drive, Wiki, and related capabilities. |
| On-demand business lookup | Retrieves bounded evidence through public Web Search or an explicitly installed declarative private capability pack while the business-decision Codex session remains offline. |
| Base control console | Required for a complete installation. Reuse an existing Base or let `setup` create two tables for the master switch, natural-language rules, group-specific rules, and knowledge routing. |
| Enterprise knowledge | Classifies the direction of a conversation and retrieves relevant content from configured enterprise knowledge spaces before replying. |
| Daily work memory | Summarizes the day's chats, tasks, calendar events, and execution results into a designated Feishu Drive folder. |
| Long-running local service | Starts real-time intake, supplemental reads, and daily memory after macOS login, with status, freeze, upgrade, rollback, and uninstall commands. |

## Intended use

This project is for individuals or teams that can self-host the runtime, administer Feishu application permissions, and want AI assistance within auditable boundaries. It is not currently intended for production use on Windows or Linux, one-click SaaS onboarding, or environments that cannot provide a Feishu application, authorized `lark-cli`, and Codex runtime.

## Prerequisites

- macOS;
- Node.js 22.13 or later;
- the official Feishu `lark-cli`, installed and authorized;
- a Feishu application with a Bot and message events enabled;
- a Codex CLI environment that can run `codex exec --ephemeral` non-interactively in the background;
- a model-service environment approved to process the selected Feishu business data;
- the Base console is mandatory for a normal complete installation, but it does not have to be created manually in advance. Existing Base, knowledge-space, and daily-memory resources can be supplied, or `setup` can create them through the official CLI.

### Install the CLI

Stable versions are identified by immutable Git tags; installation does not require a GitHub Release page. Send the following sentence to an Agent:

> Install the latest stable Git tag from `wildbyteai/feishu-digital-twin`, follow the repository README through `setup`, `doctor`, and `status`, and ask me before Feishu authorization, production-data approval, or resource creation.

Alternatively, run the fixed stable version directly with `npx` without a global installation:

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 --help
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup --help
```

`setup` installs complete configuration and background services into a private local version directory. Continue managing the instance through an Agent or by running commands from the same stable tag.

## What `setup` automates

| `setup` performs automatically | The deployer must prepare |
| --- | --- |
| Discovers and verifies the principal user and Bot identities in the selected `lark-cli` profile | Create the Feishu application, enable the Bot, and publish an application version |
| Verifies that Codex can perform one structured inference without business content | Configure required application permissions and subscribe to `im.message.receive_v1` |
| Derives the minimum local Feishu business domains from `--capabilities` | Complete the required Bot scopes and principal-user OAuth authorization |
| Read-only verifies supplied Base, table, Wiki, and Drive references | When reusing resources, provide their names and stable IDs or tokens |
| After explicit `--create-missing-resources` approval, creates and reads back the missing Base, control tables, knowledge space, and daily-memory folder as the user | Confirm that deterministic resource names are suitable for the principal user |
| Writes a private, current-user-only configuration outside the Git worktree | Keep `数字分身启用` off during verification, then enable it after acceptance |
| Installs and starts three macOS LaunchAgent roles | Confirm that the model environment is approved for the relevant Feishu data |
| Runs Doctor, reads back status, and restores the prior local state on failure | Select the message scope and enabled capabilities |

> **The Base console is mandatory, but it does not need to be created manually in advance. When Base, knowledge, or daily-memory resources are missing, `setup` lists exactly what is required. With `--create-missing-resources`, it performs official dry runs, creation, and read-back verification through `base +base-create`, `base +table-create`, `base +record-upsert`, `wiki +space-create`, and `drive +create-folder`.**

Automatic creation uses the principal user's identity and the deterministic names `<principal display name>的数字分身控制台`, `<principal display name>的数字分身知识库`, and `<principal display name>的每日工作记忆`. The control Base contains `运行配置` and `群级规则`; its initial master switch is off, the runtime table contains exactly one record, and the group-rules table is empty. Re-running setup reuses one exact-name match and completes a partially created table or initial record. Multiple exact matches or a conflicting same-name Base schema fail closed. Successfully created Feishu resources are retained after a later local failure and reused on the next run. Real IDs, tokens, and enterprise rules are written only to a Git-external `0600` private configuration and are not echoed in normal command output.

### Switches and confirmations shown by `setup`

Run the following command to see the Base first-install template, initial values, and verification sequence directly in the CLI:

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup --help
```

There is one day-to-day switch and three deployment-time confirmations:

| Item | Purpose | When to use it |
| --- | --- | --- |
| Base field `数字分身启用` | The only day-to-day master switch | Keep it unchecked during first setup; check it after setup and status verification |
| `--approve-production-data` | Confirms that the selected Codex environment is approved for the target business data | Deployment approval, not a daily switch |
| `--approve-message-scope` | Approves an initial or broader `internal_visible` / `all_visible` scope | Only when expanding message visibility |
| `--create-missing-resources` | Explicitly approves creation of a missing Base, control table, Wiki space, or Drive daily-memory folder | Required for a normal installation when no existing control Base is supplied |

When the Base console is enabled, keep exactly one row in the runtime table. Recommended initial values are the optional display label `名称=默认配置`, `数字分身启用=unchecked`, `允许域=继承`, and an empty or natural-language `个性化规则`; `群名称` is also an optional display field. The old `生产执行` field remains only for compatibility with existing deployments; new installations should use `数字分身启用`. If setup succeeds while the master switch is off, `readiness=safe-but-disabled` is expected. After identities, permissions, and background services have been verified, check `数字分身启用`, wait up to about ten seconds, and run `status` from the same stable tag again; it should report `readiness=ready`.

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
| Base control console | `console` (automatically included for normal setup) | `base` | User | Read access when reusing a Base; Base creation, table creation, and initial-record write access when provisioning automatically |

New instances default to `message_scope=bot_only` and at least the `im,base` local domains; `base` is reserved for the mandatory control console. Do not request `all` by default, and do not request organization-management or member-management permissions unrelated to the selected capabilities.

Web Search and private MCP reads do not use `--capabilities` to request a Feishu domain. They are governed by `public_web_search_approved` and `private_capability_packs` / `allowed_capabilities`, with separate trust-zone approval. See [pluggable business capabilities](./docs/features/business-capabilities.en.md) for installation, Doctor, narrowing, revocation, and human fallback.

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

Handle only messages officially visible to the Bot. Wiki and a daily-memory folder are not required, but the Base console remains mandatory. If no existing Base is available, let setup create it:

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --capabilities message \
  --create-missing-resources \
  --approve-production-data
```

### Scenario B: include messages visible to the principal user

Use `internal_visible` for internal chats and direct messages. Use `all_visible` only when external groups must also be included:

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
  --profile <lark-cli-profile> \
  --timezone Asia/Shanghai \
  --codex-environment-root <private-codex-environment> \
  --message-scope internal_visible \
  --capabilities message \
  --create-missing-resources \
  --approve-message-scope \
  --approve-production-data
```

`--approve-message-scope` is mandatory when first selecting a non-`bot_only` scope or broadening an existing scope. Base, AI, ordinary messages, and background jobs cannot broaden it by themselves.

### Scenario C: no existing Base, knowledge space, or daily-memory folder

For a simple full-capability installation, let setup create all missing resources through the official CLI. The discovered knowledge route is written into the new Base `个性化规则` field, so the final configuration has no second local rule source:

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
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

### Scenario D: reuse an existing Base console and other resources

If a Base already follows the [Base control console schema](./docs/feishu-console.md), pass its stable references directly. The runtime table must contain exactly one valid runtime record. The group-rules table may contain no records, but both tables must contain all documented fields. The allowed-domain field must be exactly “inherit” or a non-empty subset of the local ceiling. Existing Base resources are verified read-only and are never silently reshaped. Knowledge routing remains in the Base rules; an existing daily-memory folder can be supplied directly:

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 setup \
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

When there is no existing Base but an existing knowledge space should be reused, pass `--knowledge-space-name`, `--knowledge-space-id`, and `--knowledge-direction` together with `--create-missing-resources`. Setup creates the control Base and writes the knowledge route into its initial personalized rules. See [global configuration](./docs/getting-started/global-configuration.md) for every option.

## Post-installation verification

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 doctor
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 status
```

A normally enabled installation should satisfy all of the following:

- `setup` returns `status=setup-complete`;
- a subsequent `status` command reads the instance and service state successfully;
- `readiness=ready`, or `safe-but-disabled` when the local or Base master switch is explicitly off;
- the `realtime`, `supplement`, and `daily-memory` roles are healthy;
- one Feishu application has exactly one official real-time message consumer;
- private configuration is outside the Git worktree and readable only by the current user;
- actual message, task, calendar, knowledge, and daily-memory behavior matches the selected permissions.

`readiness=degraded` means setup is incomplete and automatic handling should not begin. To upgrade, run the target stable tag with `--restart`; rollback also requires `--restart`. An installed version is never overwritten by another source with the same version number.

```bash
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 status
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control freeze
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control enable
npx --yes "github:wildbyteai/feishu-digital-twin#<target-tag>" control upgrade --restart
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control rollback --restart
npx --yes github:wildbyteai/feishu-digital-twin#v0.1.12 control uninstall
```

See [runtime operations](./docs/operations/runtime.md) for details. Uninstall keeps local private data by default.

## Configuration and privacy boundaries

- Real instance configuration and runtime state stay outside the Git worktree. Private directories use `0700`; sensitive files use `0600`.
- Do not copy another person's `lark-cli` profile, Keychain, Codex login state, resource IDs, or instance configuration.
- The project has no remote telemetry by default and does not upload diagnostic bundles. Runtime logs do not retain message bodies, full model output, or credentials, and the project does not build long-term chat history. Pending confirmation keeps only the minimum action addressing for up to ten minutes and clears it after approval, rejection, or expiry.
- `allowed_lark_domains` is a local ceiling that cannot be exceeded. The Base console can only narrow it.
- `allowed_capabilities` is the local ceiling for Web/MCP semantic capabilities. Base may only intersect it, and the business-decision Codex session cannot access Web, MCP, local files, or credentials directly.
- Trusted runtime code enforces reply identity, the `🤖` disclosure mark, freezing, deduplication, supplemental-read cursors, and the ownership-transfer prohibition.
- Existing Base resources are always verified read-only. Only an explicit `--create-missing-resources` allows the official CLI to create or complete a missing Base, control table, initial record, Wiki space, or Drive daily-memory folder.

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
- [Pluggable business capabilities](./docs/features/business-capabilities.en.md)
- [Base control console](./docs/feishu-console.md)
- [Local service continuity](./docs/operations/local-service-continuity.md)
- [Public snapshot and privacy gate](./docs/operations/public-snapshot.md)
- [Complete public product specification](./docs/public/product-spec.md)
- [Complete open-source plan](./docs/public/open-source-plan.md)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

## License

This project is licensed under the [Apache License 2.0](./LICENSE).

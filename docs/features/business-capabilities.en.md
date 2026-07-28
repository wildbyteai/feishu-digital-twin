# Pluggable business capabilities

[中文](./business-capabilities.md)

Pluggable business capabilities let the digital twin retrieve current public information or approved internal material during an ordinary business conversation. They are not a separate search mode, and they do not expose every local MCP server, browser, or file to Codex.

## What the public product includes

The public source and distribution allowlists include the complete generic mechanism:

- the public `CapabilityGateway` contract;
- the public `Web Search Adapter`;
- the generic read-only `MCP Adapter`;
- an explicit MCP server resolver seam;
- the declarative `runtime/schemas/capability-pack.schema.json` contract;
- `FakeCapabilityAdapter`, neutral fixtures, and tests at the same public seams.

The private layer therefore contains only a deployer's declarations, external MCP implementation and authentication, real resource identifiers, and business rules. It does not contain a product feature withheld from the public release.

The business-decision Codex session remains offline. It sees only semantic capability identifiers, purposes, operations, risk, trust zone, readiness, and bounded input descriptions. It never sees private pack paths, MCP server references, tool names, endpoints, or credentials. The trusted runtime performs approved lookups through `CapabilityGateway`.

## Neutral pack example

[`examples/capability-pack.example.json`](../../examples/capability-pack.example.json) uses the synthetic `example.records` / `example.records.read` contract. A pack must:

- live outside the product source tree, in a current-user-only directory with a `0600` manifest;
- use `schema_version: 1` and a semantic `pack_version`;
- declare only `read` risk, the `internal` trust zone, and `human-fallback`;
- name the exact tool allowlist, read operation, allowed and required input fields, and byte limit;
- contain no JavaScript, shell hook, credential, cookie, browser material, or model configuration.

The candidate instance configuration explicitly lists installed packs and the local capability ceiling:

```json
{
  "private_capability_packs": ["example.records"],
  "allowed_capabilities": ["example.records.read"],
  "required_capabilities": []
}
```

`required_capabilities` only determines whether Doctor reports overall degradation, and it must be a subset of `allowed_capabilities`. An unavailable optional capability fails only that lookup; unrelated Feishu processing continues.

## Install and authorize

Freeze an existing instance, then run setup with a candidate configuration and manifest that both live outside the source tree:

```bash
feishu-digital-twin control freeze
feishu-digital-twin setup \
  --config <private-candidate-config> \
  --capability-pack <private-capability-manifest> \
  --approve-capability-trust-zone internal
```

`--approve-capability-trust-zone internal` approves only the newly introduced or changed internal data boundary; it is not a daily switch. Changing a pack's MCP server reference, tool binding, trust zone, operation, or input constraints requires setup and confirmation again.

This step installs and validates declarations; it does not make the standard CLI scan or reuse MCP configuration from the user's main Codex or desktop applications. The public generic Adapter receives a deployer-managed server through the explicit `resolveCapabilityServer` seam. A mapped tool is usable only when `listTools` metadata explicitly sets `annotations.readOnlyHint: true` without a destructive annotation; missing or ambiguous evidence fails closed. The standard CLI injects no resolver or transport by default. Without an approved resolver in the deployment runtime composition, Doctor and lookups deterministically report `unavailable` and use human fallback instead of discovering another MCP server. The real internal MCP implementation, authentication, and deployment wiring remain deployer-managed and never enter public examples or release artifacts.

Public Web Search does not use a private pack. It is installed only when the candidate configuration explicitly sets `public_web_search_approved: true`; production-data approval does not imply public-network approval. When `allowed_capabilities` is present, it must also include `public.web.search` to permit that capability.

## Narrow capabilities

Local `allowed_capabilities` is the semantic capability ceiling. The Base runtime field “允许能力” inherits that ceiling only when its value is exactly “继承”; an explicit non-empty list may only intersect it. Unknown values, duplicates, empty values, mixed inherit, or attempted expansion fail closed. Group natural-language rules may restrict when a capability is used, but cannot change its trust zone, tool binding, or input hard gates.

## Doctor and human fallback

After installation or policy changes, run:

```bash
feishu-digital-twin doctor
feishu-digital-twin status
```

Doctor uses non-business synthetic checks and reports only the semantic capability identifier, stable readiness code, latency, and required flag. It does not read a real workflow, invoke a business tool, or print private paths, MCP server references, tool names, endpoints, credentials, or result bodies. A successful lookup that contains credential-shaped text fails closed, and opaque source references are dropped.

If a lookup is unavailable, unauthenticated, unauthorized, timed out, invalid, failed, or empty, the runtime does not switch trust zones or try a browser or local file. It guarantees `human-fallback` in the original authorized conversation, clearly asking for human handling without inventing business content or contacting another person.

## Revoke

Prepare a candidate configuration that removes the semantic capability from `allowed_capabilities` and `required_capabilities`, and removes an unused pack from `private_capability_packs`. Ordinary configuration updates may narrow or revoke; they cannot install or expand capabilities:

```bash
feishu-digital-twin control freeze
feishu-digital-twin service stop
feishu-digital-twin config update --config <revoked-private-config>
feishu-digital-twin doctor
feishu-digital-twin service start
feishu-digital-twin control enable
```

After the update, the removed pack is no longer loaded or visible in the capability snapshot. Once rollback is no longer required, the deployer may delete the private manifest outside Git; do not move it into the source tree as a backup.

## Distribution isolation

Public examples use neutral synthetic identifiers only. Before a real release, the private scan policy must list organization identifiers, private capability-pack IDs, private domains, MCP server references, and exact tool names. The public snapshot scans those values, local paths, and credential shapes during source selection, staging, archive unpacking, plugin unpacking, npm unpacking, and candidate metadata generation. Any finding blocks the candidate, while reports contain only file paths and stable finding codes.

See [ADR 0007](../adr/0007-capability-gateway-and-declarative-packs.md) for the architecture, and the [configuration reference](../reference/configuration.md) plus [compatibility guide](../compatibility.md) for field and version rules.

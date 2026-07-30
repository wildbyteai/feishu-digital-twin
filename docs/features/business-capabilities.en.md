# Pluggable business capabilities

[中文](./business-capabilities.md)

Pluggable business capabilities let the digital twin retrieve current public information or approved internal material, and prepare business actions that require the principal's confirmation. They are not a separate search mode, and they do not expose every local MCP server, browser, or file to Codex.

## What the public product includes

The public source and distribution allowlists include the complete generic mechanism:

- the public `CapabilityGateway` contract;
- the `CapabilityActionGateway` prepare, confirm, and single-consumption contract;
- the public `Web Search Adapter`;
- the generic read and confirmation-gated `MCP Adapter`;
- the explicit `resolveCapabilityServer` MCP server resolver seam;
- the declarative `runtime/schemas/capability-pack.schema.json` contract;
- `FakeCapabilityAdapter`, neutral fixtures, and tests at the same public seams.

The private layer therefore contains only a deployer's declarations, external MCP implementation and authentication, real resource identifiers, and business rules. It does not contain a product feature withheld from the public release.

The business-decision Codex session remains offline. It sees only semantic capability identifiers, purposes, operations, risk, trust zone, readiness, and bounded input descriptions. It never sees private pack paths, MCP server references, tool names, endpoints, confirmation proofs, or credentials. The trusted runtime performs lookups through `CapabilityGateway`; `CapabilityActionGateway` prepares a preview, requests the principal's private confirmation, and submits once.

## Neutral pack example

[`examples/capability-pack.example.json`](../../examples/capability-pack.example.json) uses the synthetic `example.records` / `example.records.read` contract. A pack must:

- live outside the product source tree, in a current-user-only directory with a `0600` manifest;
- use `schema_version: 1` and a semantic `pack_version`;
- declare `read` tools for lookups; a confirmation-gated action must pair a non-destructive `prepare` tool with a destructive `write` tool, using the `internal` trust zone and `human-fallback`;
- an MCP integration that requires a login may optionally declare one read-only `readiness_check` tool; the runtime calls it with empty arguments and accepts only `{ "ok": true }` or `{ "ready": true }`, without exposing the health result to Codex;
- name the exact tool allowlist, semantic operation, allowed and required input fields, byte limit, and confirmation-field mapping;
- contain no JavaScript, shell hook, credential, cookie, browser material, or model configuration.

The candidate instance configuration explicitly lists installed packs and the local capability ceiling:

```json
{
  "reuse_codex_mcp_servers": true,
  "private_capability_packs": ["example.records"],
  "allowed_capabilities": ["example.records.read"],
  "required_capabilities": []
}
```

`required_capabilities` must be a subset of `allowed_capabilities`. An ordinarily unavailable optional capability fails only that lookup. If an explicitly declared authorization readiness check fails, Doctor reports `CAPABILITY_NOT_READY` and marks the overall instance not ready, so an expired login cannot still appear healthy.

## Install and authorize

Freeze an existing instance, then run setup with a candidate configuration and manifest that both live outside the source tree:

```bash
feishu-digital-twin control freeze
feishu-digital-twin setup \
  --config <private-candidate-config> \
  --capability-pack <private-capability-manifest> \
  --approve-capability-trust-zone internal
```

`--approve-capability-trust-zone internal` approves only the newly introduced or changed internal data boundary; it is not a daily switch. Changing a pack's MCP server reference, tool binding, readiness tool, trust zone, operation, confirmation mapping, or input constraints requires setup and confirmation again.

By default, the product does not scan or reuse MCP configuration from the user's main Codex or desktop applications. Only when the instance explicitly sets `reuse_codex_mcp_servers: true` does the runtime execute `codex mcp get` for the exact server references declared by installed packs; it never calls MCP list or discovers another local MCP. Lookup tools must be read-only and non-destructive, prepare tools must be non-read-only and non-destructive, and submit tools must be non-read-only and destructive. Missing or ambiguous annotations fail closed as `unavailable`. The real internal MCP implementation, authentication, and private pack remain deployer-managed and never enter public examples or release artifacts.

Confirmation-gated actions always use prepare → principal confirmation → submit. Confirmation proofs remain only in the background process memory; Codex, the public Feishu conversation, and long-term SQLite state never receive them. SQLite stores only a random `action_id`. Rejection, expiration, replay, policy narrowing, or service restart makes the pending submit fail closed.

Public Web Search does not use a private pack. It is installed only when the candidate configuration explicitly sets `public_web_search_approved: true`; production-data approval does not imply public-network approval. When `allowed_capabilities` is present, it must also include `public.web.search` to permit that capability.

## Narrow capabilities

Local `allowed_capabilities` is the semantic capability ceiling. The Base runtime field “允许能力” inherits that ceiling only when its value is exactly “继承”; an explicit non-empty list may only intersect it. Unknown values, duplicates, empty values, mixed inherit, or attempted expansion fail closed. Group natural-language rules may restrict when a capability is used, but cannot change its trust zone, tool binding, or input hard gates.

## Doctor and human fallback

After installation or policy changes, run:

```bash
feishu-digital-twin doctor
feishu-digital-twin status
```

Doctor uses non-business checks and reports only the semantic capability identifier, stable readiness code, latency, and required flag. It never reads a real workflow or invokes lookup or approval tools. When a pack explicitly declares `readiness_check`, Doctor invokes only that read-only health tool, discards its body, and evaluates readiness without printing private paths, MCP server references, tool names, endpoints, identities, or credentials. A successful lookup that contains credential-shaped text fails closed, and opaque source references are dropped.

If a lookup or action prepare/submit is unavailable, unauthenticated, unauthorized, timed out, invalid, failed, or empty, the runtime does not switch trust zones or try a browser or local file. A failed public lookup is reported only in the original conversation. For a failed internal-data request, the principal receives a direct instruction to check authorization or the source link. When another participant makes that internal request, the original conversation receives a natural assistant acknowledgement while the principal receives a separate notice. The runtime does not invent business content or ask the requester to confirm on the principal's behalf.

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

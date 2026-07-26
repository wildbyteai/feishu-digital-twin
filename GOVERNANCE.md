# Governance

## Roles

- **Maintainer:** accepts changes and manages the roadmap.
- **Reviewer:** reviews behavior, privacy and maintainability.
- **Release manager:** verifies artifacts, provenance and rollback readiness.
- **Security and privacy owner:** handles private reports and privacy gates.

One person may hold more than one role while the project is small. Role holders
are listed in the public repository configuration rather than hard-coded in
the source distribution.

## Decisions

Routine decisions use documented consensus between available maintainers.
Changes to licensing, data boundaries, trusted invariants, supported platforms
or release credentials require explicit approval from the project owner.

No maintainer may waive the following by configuration: receiving-identity
routing, visible AI disclosure, the ownership-transfer prohibition, deduplication
and freeze safety, bounded private state, or the prohibition on silent provider
fallback.

## Releases

A release is produced from a reviewed clean snapshot. Source, Codex plugin and
npm runtime must share one version and source revision. Publishing credentials
are not available to pull-request jobs and are not stored as long-lived project
files.

## Removing access

Maintainer or release access may be removed for inactivity, unresolved conflicts
of interest, repeated privacy violations, or conduct violations. Security access
is reviewed separately from ordinary repository write access.

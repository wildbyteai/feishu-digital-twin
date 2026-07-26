# Contributing

Thank you for helping improve Feishu Digital Twin.

## Before contributing

- Use synthetic identities, tenants, groups, messages, documents and tokens.
- Do not submit employer, customer, supplier, employee, candidate or tenant
  data, even when it appears anonymized.
- Do not include credentials, QR codes, cookies, private endpoints, local
  absolute paths, runtime databases, logs or screenshots.
- Keep business judgement in Skills and natural-language configuration.
- Prefer the official Lark CLI and lark-* Skills over new platform wrappers.
- Do not add private feature overlays or provider-specific model clients.

## Development workflow

1. Add or update a behavior test at an agreed public seam.
2. Make the smallest implementation that satisfies the behavior.
3. Run the focused tests and then the full isolated suite.
4. Run the public-content and package checks before proposing a release change.

Pull requests must explain the user-visible behavior, privacy impact, tests and
rollback considerations. Changes to identity routing, the AI disclosure mark,
ownership-transfer prohibition, state retention, provider selection or release
contents require explicit maintainer review.

## Developer Certificate of Origin

The project uses the Developer Certificate of Origin 1.1. Add a
`Signed-off-by` line to every commit to certify that you have the right to
submit the contribution under the project's license. A CLA is not required
unless the governance policy is changed explicitly.

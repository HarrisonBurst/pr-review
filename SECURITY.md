# Security

This prerelease is a single-user loopback application, not a multi-user server or an OS sandbox in every mode. No supported release/security backport policy exists yet.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/HarrisonBurst/pr-review/security/advisories/new) for confidential security reports. This repository has private reporting enabled. Use [public issues](https://github.com/HarrisonBurst/pr-review/issues) only for fully synthetic issues safe to disclose publicly. No private email or response-time guarantee is advertised. If private reporting is unavailable, post only a non-sensitive request to arrange a private channel and withhold exploit details and sensitive evidence.

Include the affected revision, execution mode, impact category and a minimal synthetic reproduction only when safe. Do not attach credentials, authorization URLs/codes, native config/auth files, databases, captured skills, private PR content, raw model/provider output or unredacted screenshots. If you accidentally expose a credential, contact its owner through an existing trusted channel; do not paste it into an issue to demonstrate the problem.

## Boundaries to understand

- Fresh Settings shows Dangerous intent. Explicit Save with fresh consent enables full host-native tools/config/auth; those tools can write files or publish outside the app's preview. App connection grants do not restrict them.
- Isolated Harnesses restrict native capabilities but are not OS/process containment. Docker has a real container boundary, explicit source/code/token exposure approvals and separate setup consent, with documented limitations and no host fallback.
- PR contents are untrusted. Do not run their scripts or inherit their agent configuration. Never expose the app beyond loopback or pass it untrusted native configuration as trusted setup.
- OAuth authentication is not a tool grant. Connections require explicit reads; provider access controls and schema support still apply. Notion Test is not a live content read.
- SQLite, checkouts, captured trusted source and diagnostics can contain private material. Keep data and backups private. App-owned OAuth credentials live separately in macOS Keychain.
- Exact preview and explicit confirmation are required for app GitHub writes. Ambiguous writes must be reconciled, not automatically retried.

See [execution boundaries](EXECUTION_BOUNDARY.md), [supported Isolated limits](docs/isolated-capabilities.md) and [Docker boundaries](docs/docker-boundaries.md) before enabling execution. Historical successful fixtures or provider probes do not establish readiness for your account or installation.

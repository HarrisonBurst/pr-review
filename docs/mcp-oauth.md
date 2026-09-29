# Host-owned MCP OAuth

Connections uses reviewed provider profiles, SDK Streamable HTTP and app-owned macOS Keychain entries. It does not copy native harness/plugin logins or grant arbitrary MCP execution. Linux/headless credential storage is not implemented and has no plaintext fallback.

## Authentication and grants

Add provider stores disabled metadata only. Connect explicitly discovers metadata, configures an eligible existing client or performs consented public registration, then starts provider sign-in. Native declared client metadata is provenance, not proof that this independent app may reuse a registration. Provider client eligibility and current schema compatibility remain deployment-specific and unverified by local fixtures.

PKCE, one-use state, original-browser binding, bounded public HTTPS destinations and fixed reviewed resource/issuer rules apply. Callbacks support the app port or an explicitly configured fixed loopback listener. Fixed-loopback hand-back does not shorten the original capability-review deadline. Reloading a consumed return does not repeat admission; inspect refreshed connection status.

Exact or omitted requested scopes follow the supported admission policy. Additional credential capabilities require explicit unchecked approval of the complete local list; missing required capabilities cannot be overridden. Private additional names and credentials stay outside model, snapshot and ordinary event contexts. Authentication is separate from default-denied enablement and per-tool grants. Inventory is not a content-read proof.

Credentials have serialized refresh, no-widening checks, generation fencing and durable ambiguous-rotation handling. Do not blindly retry an ambiguous refresh. Disconnect fences subsequent use. Model authentication has separate execution-mode rules; this OAuth lifecycle does not change them.

## Authenticated Slack read adapter

Explicit grants support bounded search/channel/thread reads through the reviewed official MCP endpoint. Provider access controls govern accessible content. Independent subject/workspace verification, per-channel isolation, complete coverage and citation guarantees are not promised. Writes and unknown tools are denied before credential/provider access. Captured schema, source, generation and destination fences remain mandatory.

Slack uses the reviewed public-client PKCE policy; confidential-only advertised metadata is retained separately from that policy. This is not arbitrary authentication-method relaxation for other providers. Ordinary admitted reads may use no-widening refresh. Test wording distinguishes local configuration from live-read evidence.

## Other providers and local tools

- [Notion](notion-reads.md): broader `default` credential capability, explicitly granted id-only fetch, local-only Test.
- [Linear](linear-reads.md): bounded issue reads through the official MCP route.
- [Axiom](axiom-reads.md): explicitly granted dataset/field/sample reads, not a provider read-only OAuth scope.
- [Known profiles](known-mcp-profiles.md): supported native discovery and exact schema matching.

Host stdio execution, legacy SSE, arbitrary plugins/helpers and unreviewed tools are not enabled by OAuth. Supported Docker local stdio remains container-only and separately approved. Dangerous retains independent native authority outside these broker grants.

## Diagnostics and evidence

Opt-in exchange diagnostics report bounded phases and fixed categories, not credential values or raw provider bodies. Lost historical responses cannot be reconstructed from these flags. No-refresh definition capture and diagnostic methods are not reviewer grants or public HTTP APIs.

Local tests use synthetic metadata, credentials and responses. Successful fixtures do not verify live registration, sign-in, provider schemas, access or content completeness. See [API contracts](../API_CONTRACT.md#host-owned-mcp-oauth-backend-handoff) and [publication validation](publication-readiness.md). Never attach credentials, profile dumps, database contents or raw diagnostics to an issue.

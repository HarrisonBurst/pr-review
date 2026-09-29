# Contributing known MCP profiles

Profiles are repository-owned **data**, not plugins, enablement, credentials, server trust or live-availability evidence. Contributions arrive through ordinary future reviewed PRs. This task publishes nothing and installs nothing.

- `server/mcp-profiles/profile.schema.json` defines the bounded data shape.
- `server/mcp-profiles/documents.json` is the representative reference profile; it is not a deployed service.
- `server/mcp-profiles.ts` explicitly registers reviewed data. No directory of executable modules is dynamically loaded.
- `shared/contracts.ts` owns `KnownMcpProfile`, native source/reference, inventory and permission contracts, plus additive `McpOAuthProfile` authentication metadata.
- `server/mcp-profiles/slack.json` is the first OAuth metadata profile, explicitly registered separately from document read adapters. Its authentication-policy bytes stay stable to preserve admitted credentials. The catalog derives `readSupport:"supported"` from the separate [reviewed Slack adapter](mcp-oauth.md#authenticated-slack-read-adapter), not from that historical display field. No tool is automatically granted.
- `server/mcp-profiles/linear.json` registers the exact native Linear HTTP endpoint with app-owned SDK OAuth, advertised public-client/DCR support and only requested `read`. The [Linear adapter](linear-reads.md) exposes explicitly granted bounded issue lookup/search through the same host broker, without native credential reuse or legacy manifest authoring. Metadata and authentication alone are not successful review access.
- `server/mcp-profiles/axiom.json` registers the official Axiom `/mcp` route with host-owned browser OAuth, explicit public-client registration and authentication-only `openid offline_access` scopes. The [Axiom adapter](axiom-reads.md) supports explicit dataset/field/event-sample reads, not arbitrary APL or writes. Its omitted resource-scope rule is Axiom-specific and requires explicit issuer advertisement; no native credential or independent identity gate is added.
- `server/mcp-profiles/notion.json` registers the official Notion `/mcp` route with origin resource/issuer, advertised public-client registration and broader `default` capability disclosure. The [Notion adapter](notion-reads.md) permits only explicitly granted id-only `notion-fetch`; search, writes, agent tools and unknowns are denied. First-party invocation evidence is not a complete live schema. Notion Test is local-only without a document ID, never live read evidence.
- `ReadProviders`, `ReadOnlyMcpGateway`, existing schema validation and HTTPS transport own enforcement, not a profile's prose or tool annotations.

The original document profile identifies a server name/version, protocol `2025-03-26`, stateless JSON HTTPS `/mcp`, `documents_get({id})`, its exact bounded schema, and an explicit read-context preset. This implementation accepts no server prompts/resources/sampling, pagination, sessionful/SSE transports, arbitrary methods, hosted scripts or server-initiated execution. Resource scope is an explicit list of 1-100 ids. A preset is just the tool-id list offered to the user; selecting/importing a profile does not apply it.

To contribute another server implementing this same audited protocol, add a data file, explicitly register it and add deterministic identity/schema/resource/changed-tool fixtures. Preserve the fixed document tool/schema and limits. New operation families, auth formats, transports or resource semantics require a reviewed extension of the existing host implementation and threat model, not merely a JSON claim that arbitrary code is read-only. Do not embed downloads, installers, authentication code, executable marketplace hooks or a universal permission engine in profiles. Supported OAuth profiles reuse the shared host lifecycle, approved origins and storage interface; adding a profile still requires an independently audited read/resource adapter before tools are grantable.

## Native configuration examples

These are deliberately synthetic operator-owned configuration examples, not credentials or network targets for live testing. Normally the user discovers an existing configuration rather than writing these in the app.

Claude JSON:

```json
{
  "mcpServers": {
    "documents": {
      "type": "http",
      "url": "https://documents.example.invalid/mcp",
      "headers": { "Authorization": "Bearer SYNTHETIC_ONLY" }
    }
  }
}
```

Codex TOML:

```toml
[mcp_servers.documents]
url = "https://documents.example.invalid/mcp"

[mcp_servers.documents.http_headers]
Authorization = "Bearer SYNTHETIC_ONLY"
```

The backend reads literal credentials only for execution-side authenticated actions; discovery parses their shape but never exports their values. Native source disabled/enabled-tool restrictions cannot be widened by app policy. Scope and app enablement remain separate explicit choices. Unsupported stdio is reported as host-code execution requiring a different supported path; it is never started to discover its inventory.

## Discover Connections and unchanged rediscovery

**Add a provider** is the separate supported path for app-owned OAuth profiles, including Notion, when no native MCP file exists. It saves only reviewed provider metadata with default-denied reads, then uses the same explicit Connect/Load/grant flow. It never scans or inherits Claude built-in connectors. See [Notion user flow](notion-reads.md#user-flow-and-boundaries).

Discover Connections reads one selected native configuration file: Claude's global `$HOME/.claude.json` or Codex's `$CODEX_HOME/config.toml` by default, or an explicit absolute JSON/TOML path. It does not enumerate installed plugins, native login stores or the app's own configured profiles. A plugin's MCP file must be selected explicitly. Pi extension formats and executable helpers remain unsupported. Detected metadata, admitted authentication and explicitly granted read readiness are different states.

Discovery now replaces only new or changed native definitions. Unchanged entries keep their identity, complete configuration, credentials, OAuth generation, profile, enablement, grants, inventory, Test evidence and captured authority. Missing entries do not delete saved connections. Changed definitions without a credential reset to disabled/default-denied; changed configured OAuth definitions refuse the entire operation until explicit Disconnect, retaining cleanup controls. Existing source/profile/schema drift checks still fence execution. No profile or credential migration is performed. Static bearer rotation retains the existing secret-free identity semantics.

The built UI reports new additions and changed replacements separately from retained saved cards, without treating an empty source as discovery of configured accounts. Missing/unreadable files, parse failures and missing top-level maps have bounded actionable diagnostics; source content and parser exceptions never reach the response. Discovery never tests authentication or read access, enables a tool or contacts a provider. Dangerous-mode hiding and Isolated/Docker boundaries are unchanged.

## Required fixtures

Use `node --import tsx --test server/test/isolated-policy.test.ts server/test/read-providers.test.ts server/test/mcp-oauth.test.ts server/test/mcp-oauth-http.test.ts server/test/mcp-remote.test.ts server/test/guarded-fetch.test.ts server/test/credential-store.test.ts`. The HTTP fixture is visibly synthetic and uses only loopback. It maps the approved public identity into injected deterministic transport; that injection is code-only, requires `synthetic:true` and is not available through an HTTP setting.

Cover import without command/credential-resolution/network effects, default denial, explicit Load/Test without grants, exact schema/server/protocol, unknown tools, argument fields, resource/destination limits, readOnlyHint non-authority, changed source/schema, captured queued/restarted policy, credential canaries and truthful non-connected evidence. Keep current Docker/Dangerous safeguards and archived-data preservation/rejection coverage. Default tests never use real user auth or a live service. The separately authorized `PR_REVIEW_TEST_KEYCHAIN=1` roundtrip uses a uniquely named disposable entry and synthetic canaries only, then deletes that entry. Live provider validation requires separate concrete client/account/resource/consent prerequisites and minimal redacted evidence, never inferred from test permission.

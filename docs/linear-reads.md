# Host-owned Linear review reads

## Route and authority

The detected `linear-server` HTTP definition is now supported by `linear-mcp/1`, `server/linear-reads.ts` and the existing SDK OAuth / `ReadProviders` / `ReadOnlyMcpGateway` / `WorkflowBroker` path. The existing `linear_get_issue` GraphQL adapter remains available for previously imported audited manifests, but is not a native MCP login: it requires a separate manifest and credential reference. Native Linear uses neither that legacy setup nor another client's token. No new OAuth framework, identity/workspace admission gate, Docker mount, network destination or host fallback is added.

Public source assessment on 2026-09-29:

- [Linear's MCP guide](https://linear.app/docs/mcp) documents Streamable HTTP at `https://mcp.linear.app/mcp`, OAuth with dynamic client registration, and **read-only access by requesting only `read`** on that existing endpoint. Its separate `/mcp/readonly` endpoint is not silently substituted for the captured definition.
- [Path-specific protected-resource metadata](https://mcp.linear.app/.well-known/oauth-protected-resource/mcp) binds resource `https://mcp.linear.app/mcp` to issuer `https://mcp.linear.app`, with `read` and `write` advertised. Root resource metadata has a different audience; this profile deliberately uses the path-specific resource, also advertised by the unauthenticated401 challenge.
- [Authorization-server metadata](https://mcp.linear.app/.well-known/oauth-authorization-server) advertises public `none`, confidential basic/post, S256, code and refresh grants, registration and token endpoints on that same origin. No Slack public-client exception is applied. Discovery must still validate all metadata on each explicit setup. Research sent no credentials, registration, authorization or content call.
- [Linear's published tool overview](https://linear.app/integrations/slack#commonly-used-tools) documents `get_issue` and `list_issues` as issue reads. Its official guide does not publish complete JSON schemas. The bounded argument subset is corroborated by a [public captured client definition](https://github.com/manojbajaj95/mcp-skill/blob/main/skills/linear/app.py): `get_issue(id)` and `list_issues(query,limit,cursor)`. That third-party capture is supporting evidence, not provider authority or current authenticated inventory. The unauthenticated metadata-only `tools/list` attempt returned401 with no definitions. Actual Load and every call pin and validate the current provider schema; unsupported schema changes fail, never adapt permissively. A live authenticated read remains unverified.

## Supported reads

- `get_issue`: one issue by identifier or UUID; `id` is1-100 ASCII alphanumeric, underscore or hyphen characters. No arbitrary URL, attachment fetch, customer-needs expansion or relation traversal.
- `list_issues`: required nonempty title/description `query`, maximum1000 characters; optional cursor maximum1024 characters; limit1-20, default20. Exactly one page, never automatic pagination.

These are explicit reviewed operations, not a name-prefix or `readOnlyHint` policy. All other tools, including writes, other read-like tools and arbitrary resource access, are denied. Static app-authored descriptions and schemas, not provider instructions, reach reviewers. Unknown names and invalid arguments fail before credential/provider access at both gateway and direct credential entry. Captures bind native source, profile digest, OAuth generation/client/issuer/resource, explicit tool grants and provider input-schema fingerprints. Load always disables and clears grants; source/admission drift rejects before provider access, schema drift before tools/call. Existing immutable capture behavior is unchanged.

Results are bounded text/structured untrusted provider data. No linked resources or binary content are fetched. Supplied URLs/cursors/coverage are preserved without inventing citations, identity or completeness. Tests exercise results without output schemas. The existing200KB/15-second SDK transport limits apply. The common host closure blocks credential and private capability-name echoes. Linear's four publicly documented scope literals (`read`, `write`, `openid`, `email`) are not substring canaries: ordinary issue prose and `readOnlyHint` may contain them independently of any credential. No accepted-capability list is projected; other returned capability identifiers remain protected. Slack behavior is unchanged.

Isolated native harnesses and Docker use the same host credential closure. The container sees run-bound capabilities and bounded tool results, never business credentials. The broker policy digest includes the Linear schemas; older Docker artifacts need their usual explicit recapture/setup, not a silent runtime upgrade. This change performs no installation or setup on the installed app.

## Connect and test

With Isolated or Docker selected, click **Connect** on the detected Linear card. The guided dialog ([Connections UI](execution-modes.md)) does the mechanical steps itself and stops only for decisions:

1. It imports the single matching `linear-mcp/1` profile and discovers public metadata. Neither authenticates nor grants reads.
2. Linear documents DCR, so the dialog offers registration of a public (`none`) client for `read` at the app callback behind the typed **Register a new MCP OAuth client** confirmation. **Use an existing client instead** remains available. No copied credential, legacy manifest or manual provider app is required.
3. It opens Linear sign-in. Complete sign-in/consent in the same browser. An exact or omitted requested set authenticates at callback; any additional capabilities open the local disclosure with unchecked consent. Refuse any unwanted broader credential. Missing `read` cannot be overridden. No independent workspace/subject verification is required.
4. It loads the tool list once when none exists, then asks which reads reviews may use, all unchecked. Grant `list_issues` for **Test connection** (under Advanced); `get_issue` supplies ticket details during review. The card reads **Connected** once sign-in is admitted and shows review access separately.
5. Test sends exactly `list_issues({query:'"pr-review connection test"',limit:1})`. It uses normal guarded refresh if needed, grants nothing, retries no content call and only reports a successful live read for live transport. A ticket-only grant does not authorize search Test.

Linear scope decoding uses case-sensitive, space-delimited RFC6749 tokens with existing complete-disclosure bounds, not Slack comma normalization. A comma remains part of an identifier; `read,write` cannot stand in for required `read`. Initial extras reuse the existing browser-bound ephemeral review and exact-list acceptance. Refresh may preserve/narrow accepted capabilities but cannot widen or omit required permissions. Pending/ambiguous rotation, restart, expiry, source drift, issuer/resource/state/PKCE and original-browser checks remain fail-closed.

## Verification limits

Deterministic fixtures exercise the supported contract, not live provider or installed runtime readiness. See [public validation](publication-readiness.md).

# Host-owned Notion document reads

`notion-mcp/1` adds the official hosted Notion MCP connection to the existing guided Connections flow, app-owned OAuth/SDK transport and Isolated/Docker read broker. It is separate from legacy Notion REST manifest reads. Authentication grants no reviewer tool; only an explicitly enabled `notion-fetch` grant can read content.

## Public contract evidence

Official references:

- [Build an MCP client for Notion](https://developers.notion.com/guides/mcp/build-mcp-client)
- [Connect to Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)
- [Supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [First-party cookbook, project decision example, Step 2](https://github.com/makenotion/notion-cookbook/blob/main/skills/claude/meeting-intelligence/examples/project-decision.md)
- [Protected resource metadata](https://mcp.notion.com/.well-known/oauth-protected-resource)
- [Authorization server metadata](https://mcp.notion.com/.well-known/oauth-authorization-server)

The hosted Streamable HTTP endpoint is `https://mcp.notion.com/mcp`. Public resource metadata identifies the resource as `https://mcp.notion.com`, without `/mcp`, and the issuer as that same origin. It advertises the `default` scope and header bearer authentication. Authorization metadata advertises `/authorize`, `/token`, `/register`, S256 PKCE, authorization-code and refresh grants, and `none`, `client_secret_basic` and `client_secret_post` token authentication. The official client guide explicitly demonstrates dynamic public-client registration with `none`. The profile uses those advertised methods without an authentication-method exception, native credential inheritance or a parallel framework.

The `default` scope is not a provider-enforced read-only grant. Official setup documentation says authorization allows reading and updating accessible workspace content. The guided modal discloses that broader credential capability before registration/sign-in and while choosing reads; Advanced labels it as workspace capability, not read-only permission. Broader returned scope identifiers use the existing complete local disclosure and explicit exact-list admission. The public name `default` is not a complete enumeration of underlying Notion capabilities. It is excluded from substring secret-echo canaries because ordinary content can contain that word; actual credentials and private additional scope identifiers remain protected.

The guide documents rotating refresh tokens and terminal `invalid_grant`; existing serialized refresh, no-widening and ambiguous-rotation handling remain. No independent identity or workspace verification call is added.

The first-party cookbook's Step 2 invokes `Notion:notion-fetch` four times, each with only `id`, including `id: "database-migration-proposal-page-id"`. Together with the official hosted tools documentation, this establishes the minimal id-only invocation, not a complete current hosted JSON Schema. No optional parameters, alternate tool aliases, output schema or live compatibility are inferred from it. Cookbook writes are outside the adapter.

## User flow and boundaries

1. In Isolated or Docker Settings, choose **Add a provider > Notion > Add provider**, then **Connect** on its card. No native MCP configuration is needed. Add only saves this app's reviewed provider metadata, disabled with no grants; it does not discover, sign in, read credentials or contact Notion. Claude's built-in connector is separate and is not scanned or inherited. Alternatively, explicit native-definition discovery can still import a supported HTTP entry pointing to `https://mcp.notion.com/mcp`; discovery itself only detects configuration.
2. Choose **Connect**. The existing guided flow imports the reviewed profile when needed and discovers public OAuth metadata. Confirm an eligible existing client or explicitly type the existing registration consent to register a new app client. No Notion access token or native credential copying is requested.
3. Complete Notion sign-in in the provider window and return to the original browser. Exact or omitted requested scopes follow the current admission policy; extra capabilities require unchecked exact local consent, and missing requirements cannot be overridden. Refusal/cancellation never grants reads.
4. **Load read tools**, then choose the separately unchecked `notion-fetch` grant. The adapter exposes only that reviewed name even if the provider lists writes, search or agent tools. **Not now** leaves review access off. Reloading inventory resets enablement and grants as before.
5. Reviews may fetch a specified document URL or ID. **Test connection** only checks local admission, captured source, inventory and grant configuration: no document ID is supplied, so it performs no provider request, credential read or refresh and never invents a page to fetch. Evidence remains `local_configuration`, `connected:false`, including on success. A successful content read is separate from detection, authenticated **Connected**, inventory and this local check.

The app-authored reviewer schema is exactly `notion-fetch({id})`, a nonempty, whitespace-free string of at most2048 characters and no other arguments. Official Notion supports a page, database, data source or view by URL/ID. The host forwards only this object to the fixed reviewed MCP endpoint; it does not fetch returned URLs, download assets, follow content instructions, execute skills or automatically traverse subtrees. Provider access controls determine accessible content; no per-document isolation or complete coverage is promised.

The current full provider schema is freshly discovered by the existing SDK before each invocation, compared with the captured fingerprint, and used to validate the id-only arguments before `tools/call`. Missing/renamed tools, schema drift or a current schema requiring another shape fail closed. Load exposes reviewed tool names, not a live compatibility guarantee. Results retain the existing15-second/200KB limits, text-only content check, structured-content preservation and secret/private-capability echo denial. Provider truncation and unknown subtree indicators stay visible; no automatic continuation or fabricated citations are added.

All writes, search (including connected-source AI search), agent/session operations and unknown tools are denied regardless of `readOnlyHint`. Invalid/extra arguments and forged grants fail before credential/provider access. Source/profile/OAuth generation, destination, schema and captured grant fences are unchanged. Business credentials remain host-side for both Isolated and Docker. Dangerous hides the Connections UI and retains its independent native authority. The broker policy digest includes the new read schema, so old Docker artifacts may need the ordinary explicit setup/recapture; nothing is recaptured or installed automatically.

## Verification limits

Deterministic fixtures exercise the supported contract, not live provider or installed runtime readiness. See [public validation](publication-readiness.md).

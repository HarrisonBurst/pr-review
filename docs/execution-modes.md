# Execution and Settings guide

Fresh Settings selects **Dangerous intent**, not permission to run. Explicit Save requires confirmation that the harness can write host files and publish directly without the app preview. Previously saved choices remain unchanged. Unknown or archived captures fail closed. The selector order is Dangerous, Isolated Harnesses, Docker; neither restricted mode falls back to Dangerous.

## Choose a boundary

- **Isolated Harnesses** uses one Main and zero to eight Additional entries, restricted native tools and disposable authentication homes. Additional reviewers run before Main synthesizes one draft. Ask AI uses Main only. This is not OS/process containment.
- **Docker** retains selected-skill orchestration inside a pinned container. Save, source choices, Inspect, exact capability/exposure approval and separate host-effects setup consent are distinct steps. All approved container code can read temporary model access credentials. Business credentials remain host-side.
- **Dangerous** uses native host configuration, tools and authentication without app containment. Its tools can publish outside the app's preview workflow.

See [execution boundaries](../EXECUTION_BOUNDARY.md), [Docker setup](docker-boundaries.md), [Isolated limits](isolated-capabilities.md) and the [shared API contract](../API_CONTRACT.md).

## Connections

Connections appear only with Isolated or Docker selected. **Add a provider** stores disabled metadata, not authentication or grants. Native **Discover Connections** reads the selected supported configuration file; it does not inherit Claude built-in connectors or plugin logins.

Connect guides profile import, public metadata discovery, eligible client configuration or explicitly consented registration, provider sign-in, capability admission and Load tools. Authentication alone grants no review access. Extra credential capabilities need unchecked exact local approval; missing required capabilities cannot be overridden. Tool grants are separate and default-denied. Continue resumes an authenticated connection with missing inventory/grants without automatically repeating sign-in.

A failed or expired browser return does not establish whether earlier authentication or capability acceptance succeeded. Refresh the connection status. Diagnostics exposes source, metadata, client, inventory and Test evidence without treating configuration as live readiness.

Notion exposes only explicitly granted id-only `notion-fetch`; Test is local configuration evidence, not a document read. Provider schemas and client eligibility can still prevent use. See [Notion](notion-reads.md), [known profiles](known-mcp-profiles.md) and [OAuth](mcp-oauth.md).

## Draft safety

Review runs are immutable. Draft edits and AI revision proposals are separate; re-review does not silently overwrite manual edits. Preview displays the exact submission payload, and submission needs explicit confirmation. Use the [credential-free labeled demo/mock tour](../README.md#try-the-ui-without-credentials) for development. Never test by submitting a real GitHub review.

## Verification limits

[Publication validation](publication-readiness.md) records the public candidate's local checks. Deterministic tests and inert browser flows do not prove live provider support, model access, installed runtime readiness or universal native compatibility. Historical fixture timeouts were not diagnosed as part of publication.

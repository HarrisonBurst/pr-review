# Execution and Settings guide

Fresh unsaved Settings targets Dangerous, Claude Code, the configured model and the configured skill path. The model normally starts as Native default. The selector's visible and keyboard order is Dangerous, Isolated Harnesses, Docker.

This initial choice is intent, not permission to run. Explicit Save must capture supported configuration and, for Dangerous, include fresh exact host-risk confirmation. Startup and GET requests never capture files, grant tools or execute anything.

Explicit saved choices remain unchanged. Unknown or archived state stays unavailable instead of becoming Dangerous intent. Isolated and Docker failures never fall back to Dangerous.

Settings groups controls under Repository and cadence, Automation, Execution and Connections. GitHub health appears beside repository settings; execution details include captured capabilities. Technical details stay collapsed, while execution essentials and Dangerous risk confirmation remain visible.

## Isolated Harnesses

Isolated Harnesses uses `version:3,workflow:"separated"`, with one Main harness and model plus zero to eight ordered Additional entries. Claude Code, Codex and Pi can fill any role, including multiple models on one harness. The app runs Additional reviewers first, then Main performs a full review, verifies findings and synthesizes one editable draft without hidden reviewers.

Save freezes the review entry and resources, a bounded trusted native library, supported native preferences, instructions and effort, and each entry's `restricted-native-1` policy. Inherited executable plugins, hooks and extensions are disabled. Reviewers receive disposable model-auth homes and only the environment and authentication their own harness needs.

Business credentials stay with host-side connections. Approved gateway tools enforce captured source, profile, schema, tool and destination permissions. Slack relies on provider access controls rather than app-enforced channel isolation; other documented resource scopes still apply.

Isolated Harnesses restricts native tools but does not provide OS or process containment. It does not promise universal native compatibility. See [Isolated limits](isolated-capabilities.md) and [trusted source capture](trusted-sources.md) for supported resources and symlinks.

## Docker

Docker uses `version:2` and lets the selected skill and native harness orchestrate the review inside a container. Native read, search, edit, write and shell tools operate on a disposable writable PR copy while the pinned source stays immutable. Docker never falls back to host execution.

Selecting Docker shows a readiness card with Set up Docker or Fix setup when action is needed. The guided flow separates these steps:

1. Save the selected harness, model and skill if needed.
2. Review bounded source metadata and make independent read choices for each source alias before Inspect.
3. Inspect capabilities and review the exact disclosure. The app reuses prior approvals only when it can verify that the approved items are unchanged.
4. Approve each disclosed capability and exposure. This includes portable resources, arbitrary container code in hooks, extensions, skills or shell prefixes, temporary model access tokens readable by all container code, and selected local stdio tools.
5. Separately consent to the host effects of Set up Docker.

Setup revalidates the disclosure, installs pinned app-owned runtime and cache artifacts, checks runtime policy without credentials and freezes the approved artifact. It does not select Docker, install Docker Desktop or enable automation. It never reads model credentials, logs in, refreshes authentication, contacts models or providers, or rewrites native configuration.

Remote business reads still require Connections grants, with credentials kept on the host. Supported local stdio tools must be discovered Node `.mjs` entries with frozen portable files. They run only inside the container, never through host Load tools or Test connection.

Missing or unsupported setup fails without a host fallback. Older Docker captures without the approval marker remain readable but cannot run. See the [Docker support matrix](docker-boundaries.md) and [execution boundary](../EXECUTION_BOUNDARY.md) for setup exposure, runtime pins and enforcement limits.

## Dangerous

Dangerous uses `version:2` and runs the selected host harness with full native tools, configuration and authentication. Every Save requires fresh exact confirmation that the backend validates. Native tools can write host files and publish outside app preview, and app read permissions do not restrict them.

App validation, drafts, revision proposals, progress and cancellation still apply. They do not provide process containment.

## Models and discovery

Selected models override the real native invocation. A null model resolves supported native defaults only on Save. Isolated Harnesses owns reviewer orchestration and model selection; Docker and Dangerous retain the skill's native nested orchestration.

Explicit [model discovery](model-discovery.md) reads installed Claude and Codex first-party catalogs through credential-free native metadata processes in disposable homes. It starts no prompts, threads or turns and changes no user authentication or configuration. Pi uses its existing static declarations and offline catalogs.

Catalog entries are distinct from configured or saved IDs, and discovery never proves account access or readiness. Unsupported providers and mechanisms remain visible without cross-provider fallback. Configured or cached setup readiness does not mean Connected.

Main, Additional and Docker or Dangerous model fields have searchable selectors with explicit Discover or Refresh actions. Native default is always available, and Custom id is available when the value is not already listed. The selectors distinguish loading, unsupported sources, source errors, transport failures and previous discovery results.

Opening a selector shows all choices for its harness without clearing the current value. Typing filters by ID or label. Adjacent Settings inputs and buttons are 32px high, and missing setup, authentication or requirements appear inline.

## Connections

Connections appears when Isolated or Docker is selected. Add a provider offers reviewed providers, including Notion, without requiring a native MCP file. Add provider stores disabled metadata only; Connect handles this app's separate authorization, and read grants require explicit choices afterward.

Connect guides profile import, public metadata discovery, eligible client configuration or explicitly consented registration, provider sign-in, capability admission and Load tools. Extra credential capabilities need unchecked exact local approval; missing required capabilities cannot be overridden. Continue resumes an authenticated connection with missing inventory or grants without automatically repeating sign-in.

A failed or expired browser return does not establish whether earlier authentication or capability acceptance succeeded. Refresh the connection status. Diagnostics exposes source, metadata, client, inventory and Test evidence without treating configuration as live readiness.

Native connections use explicit discovery of Claude JSON or Codex TOML, a reviewed profile and resource scope, Load tools, separate enable and per-tool choices, and Test connection. Grants start denied. Claude built-in connectors and their logins are not discovered or inherited.

[Discover Connections](known-mcp-profiles.md#discover-connections-and-unchanged-rediscovery) reads only the selected native file, not app-owned profiles or an installed-plugin inventory. Unchanged rediscovery preserves credentials and grants. Replacing a changed OAuth definition with configured credentials requires explicit Disconnect first.

[Host-owned MCP OAuth](mcp-oauth.md) supports reviewed metadata, authentication and inventory through app-owned macOS Keychain storage. The UI supports app callbacks and explicitly selected fixed-loopback callbacks. This does not enable arbitrary plugins or inherit native logins, and source authentication and configuration stores remain unchanged.

Authentication alone grants no reviewer tools. An OAuth card's Connected label means the app admitted its authentication, not that a read succeeded. Only `scope:"live_read"` with `connected:true` proves a successful read at the recorded time; synthetic, local and inventory checks do not.

Supported provider reads have distinct limits:

- [Slack](mcp-oauth.md#authenticated-slack-read-adapter) offers separately granted, bounded search, channel and thread reads under Slack's access controls. Writes and unclassified tools are denied at invocation. The app neither promises nor requires independent identity verification or channel isolation.
- [Axiom](axiom-reads.md) uses official browser OAuth and the guided registration and consent flow. Grants cover dataset listing, observed fields and bounded event samples. Its sign-in scopes are not provider read-only permissions, and its broader host credential stays outside Isolated and Docker.
- [Linear](linear-reads.md) supports bounded issue lookup and search through its official MCP route with explicit grants.
- [Notion](notion-reads.md) offers only explicitly granted, ID-only `notion-fetch` through the OAuth broker. Consent discloses its broader `default` capability, while the app denies writes, search and agent tools. Notion Test checks local configuration, not content or live connectivity.

GET requests and server-sent events initiate no connection actions. Stdio never runs on the Isolated host, even when a checkbox is selected. Legacy SSE, executable helpers and arbitrary native plugins remain unsupported.

Known profiles describe reviewed protocols, not server trust or permission. Audited GitHub, Linear, Notion and document-provider manifest imports remain supported, without a claim of native MCP parity. See [known profiles](known-mcp-profiles.md) and the [API contract](../API_CONTRACT.md) for exact contracts and Test behavior.

Historical compatibility options, workflow-source authoring, Legacy metadata import and standalone raw Diagnostics or Tool health panels are retired. Relevant source, provenance, permission, error and Test information appears with its controls.

## Saved history and upgrade consequences

Upgrades do not reset or convert historical execution captures. Saved choices, reviews, results, progress, edited drafts, proposals, submissions, questions and evidence remain readable. Settings offers re-save instead of an executable historical option.

Unsupported captures include fixed Claude/Codex execution, versionless execution, v2 single-primary Isolated, and v3 Isolated without required capability policies. Version 1 or imported execution-only Docker and host-only Dangerous captures also cannot run. See the [archive contract](../API_CONTRACT.md#archive-and-upgrade-consequences) for exact shapes.

Re-saving affects new reviews, revisions and independent questions, never old captures. Unsupported question retries and follow-ups fail before changing the answer or status; save current Settings and start an independent question instead. Supported queued jobs and threads retain their captured roles, models and permissions, with the existing restart interruption and deduplication rules.

## Further reading

See [reviewing pull requests](reviewing.md) for drafts, progress and publishing, and [configuration and troubleshooting](configuration.md) for environment variables and setup failures. [Publication validation](publication-readiness.md) records deterministic checks and their limits, not live provider or installed runtime readiness.

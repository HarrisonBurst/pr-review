# Supported execution boundaries

One official prerelease design: **Isolated Main/Additional** (`version:3,separated`), independent selected-skill/native **Docker** (`version:2`), and full-native-inheritance **Dangerous** (`version:2`) with exact backend confirmation. New Docker captures additionally require `docker.profile:"container-native-1"` and explicit exact capability/exposure approval collected through the Settings inspect/approve/setup flow. [Docker API, support matrix, enforcement and verification](docs/docker-boundaries.md) is authoritative; the integrated UI is described in [API_CONTRACT.md](API_CONTRACT.md#web-implementation-on-these-contracts). Fresh intent is Dangerous, followed by Isolated Harnesses and Docker in the selector, but requires explicit Save with fresh exact host-risk confirmation before execution. Explicit saved choices and unknown-state refusal are preserved. No startup/GET file capture, automatic permission grants, Docker setup or Dangerous activation; selecting/defaulting a mode is not authorization. Isolated/Docker failure never falls back to Dangerous. [Exact Settings contract](API_CONTRACT.md) and [current evidence](docs/execution-modes.md).

The fixed Claude/Codex runtime, versionless/single-primary Isolated, public `legacy`/`configured` selection and workflow-source authoring/import are removed. Metadata-only integration import/catalog and its environment variable are removed. Archived data remains readable, not executable. Unsupported queued inputs fail before dispatch with a re-save/new-session action; old question retry/follow-up cannot acquire today's settings. No destructive conversion, history rewriting or new DB migration was added. Docker v1 controls are removed. Old Docker captures without the new approval marker remain readable but fail before execution; no new permission is inferred. Approved runtime, source, controls and broker identities remain immutable and pinned.

## Isolated Main/Additional

[Restricted capability profile](docs/isolated-capabilities.md) is authoritative: every entry captures `restricted-native-1`, its own native model/auth/config/library provenance, deliberate executable-customization overrides, and minimum environment with disposable auth homes. Only bounded trusted skills/resources, restricted native read/checker tools and captured audited host-gateway reads are available. Native binary/admin/helper behavior remains trusted. This is **not OS/process containment** or universal native compatibility.

Main and ordered repeatable Additional entries may use any supported harness, including multiple models on one harness. The app invokes Additional sequentially, then Main independently reviews, verifies evidence and synthesizes one result/draft. No hidden reviewer or extra synthesis model. Main alone still performs a full review. App roles override only skill reviewer orchestration/model selection; required unsupported shell/scripts/hooks/plugins/MCP dependencies are diagnosed. Static dependency inventory is best effort. Isolated auth/config/library limits are not silently weakened to run an old capture.

Immutable per-entry results/errors and actual lifecycle evidence are retained separately from the one editable draft. Complete native streams and canonical validation are mandatory, with a 200,000-byte per-entry result limit. Additional failures are disclosed; Main failure produces no successful draft. Revisions create proposals, preserving manual edits. Focused questions invoke only captured Main, not Additional or the full review skill. Supported retries/follow-ups retain their policy; absent archived policy grants nothing. Native credentials are resolved only at execution, not Save or GET.

## Current Docker and Dangerous support

| Capability         | Docker                                                                                     | Dangerous                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Harness/model      | Selected Claude, Codex or Pi; actual adapter/broker pin                                    | Selected native host harness/model                                           |
| Skill/resources    | Frozen portable entry/resources plus supported native projection                           | Frozen entry/resources; external native host configuration remains mutable   |
| Orchestration      | Selected skill/native nested orchestration within the container                            | Full native host behavior                                                    |
| Customizations     | Exact app-approved portable hooks/extensions/local Pi packages, preserving native trust    | Native plugins/hooks/extensions/auth/tools inherited without app restriction |
| Business access    | Captured default-denied audited brokers, connection credentials host-side                  | Native connections independent of app gateway permissions                    |
| Boundary           | Real pinned Docker process/resource/mount/egress enforcement                               | No app native tool/filesystem/publishing boundary                            |
| Setup/confirmation | Exact capability/exposure approval plus separate host-effects consent; never host fallback | Fresh exact backend confirmation on each Save                                |

[Known MCP registry](docs/known-mcp-profiles.md) is data, not executable enablement. Current native discovery/profile/Load/Test/permission flow and narrow audited manifests are separate from Docker's internal configuration artifacts. Source ids are not public Settings requirements. The current Docker backend adds a secret-free explicit inspection/approval payload, shared native library projection, frozen portable artifacts, disposable writable workcopy and narrowly supported container-local stdio. [Exact handoff and bounded evidence](docs/docker-boundaries.md) distinguishes these implemented paths from unsupported native combinations.

Current native review output uses the [canonical contract/checker](docs/review-output.md), not a new workflow schema. Model/effort conflicts are actionable rather than rewriting skill-pinned nested commands. No auth/login/provider smoke is triggered by Save. Useful provenance, errors and connection-test evidence remain inline; configured is not connected.

## App-managed setup

The supported pinned host profile remains macOS arm64, `/usr/local/bin/docker`, socket `unix:///var/run/docker.sock`, Engine 29.8.0 commit `3ce5872`, Linux arm64 kernel `7.0.12-linuxkit`, and image `sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` (Node 22.23.2, Alpine 3.24.1). Other profiles fail explicitly; historical synthetic native checks are not current live-provider readiness.

The action discloses and requires consent for its host effects. It reads the configured installed skill and the selected harness's known user settings/resource roots listed below, plus supported nested harnesses found in explicit skill commands (best effort, not a universal dependency parser). A nested inventory authorizes no additional provider or plugin and prescribes no sequence. It validates configuration before installing anything. It does not infer or prescribe the skill's review sequence. The entire skill text and portable sibling resources are retained. Unsupported native integrations, symlinks, binary dependencies, untrusted hooks, Codex rules, custom providers/stores and nonportable references fail with diagnostics, not silent removal. Shared `.agents/skills` is now retained for Codex/Pi. Native MCP entries are not inherited; their business credentials and approved remote calls use the shared host connection contracts. Separately approved portable local stdio uses the container-only adapter. User files, login stores and installed skills are never edited. Existing captured artifacts are never rewritten.

Managed recipes reuse `projectFiles`, `loadWorkflow`, `DockerExecutor`, provider brokers and runtime preflight. Claude/Codex models come from existing supported settings; Pi must agree with nested Codex's model because the current broker has one Codex/Pi pin. Existing explicit effort values must agree and be low/medium/high because the current runtime has one effort pin. Incompatible values fail rather than being overwritten. Absent settings use the verified recipe's Claude `claude-fable-5`, Codex/Pi `gpt-6-astra`, medium effort defaults. Primary model selection is supported. Effort controls are not exposed; compatible saved native effort is retained. No installed configuration is rewritten. Pi's supported auth remains its own `~/.pi/agent/auth.json`; it is not read during setup. Native auth errors at execution identify the failing selected store without returning credential content.

Setup uses only `dataDir/managed-docker` for installation/cache and the existing app-owned configured-source execution directories for preflight. It requires Docker Desktop to be installed/running separately at the exact supported profile. It checks the engine, uses the pinned cached image or explicitly pulls `node:22.23.2-alpine3.24`, then requires the exact image ID below before running anything. The installer container receives only an empty staging output directory and the app's trusted install script, no host home/auth/repository or Docker socket. It has network access for official npm and signed Alpine repositories; capabilities are dropped and no-new-privileges is set. It verifies the documented npm SHA-512 integrity pins, disables npm lifecycle scripts and uses signed `apk --no-scripts` packages. No PR-provided code/configuration is involved.

Before installation, setup requires an explicit Docker inspection and the exact customization ids, selected source-bound Docker-only exclusion ids, temporary model credential exposures and disclosure digest, plus the separate host-effects confirmation. Only narrowly recognized Herdr SessionStart/status-line items are eligible for explicit exclusion; native settings remain unchanged. Finder/presentation/host-trust handling and original input digests are disclosed separately ([source compatibility](docs/trusted-sources.md)). Missing/changed approval fails before installer effects. The approved complete resource/skill projection is frozen in the managed artifact; source edits do not rewrite captured queued sessions. The completed bundle is hashed and atomically moved into `managed-docker/runtime-v1`; subsequent explicit setup verifies its digest before reuse. A changed cache fails with an explicit recovery diagnostic, never a replacement or fallback. Repeated setup with unchanged inputs reuses the same source identity. Failed installation leaves no managed-ready selection; staged files/owned installer containers are removed on ordinary failure, timeout or app shutdown. A hard-killed installer can leave an `install-*` staging directory and its bounded installation container; it contains no credentials and is never adopted as a ready runtime. No unrelated resources are removed. Failed runtime/preflight setup remains visible and can be retried explicitly. Setup never changes the selection, polling or auto-review. GET, refresh and Save never initiate installation.

Setup success establishes only runtime/policy readiness, not native login or provider availability. Native credential reads happen at execution and never refresh or log in. In demo, managed recipes use fixture-native auth and require explicitly injected synthetic inference; absent injection fails, with no live fallback.

## Dangerous host execution

`PATCH /api/settings/harness` requires the exact shared `dangerousConfirmation` for each Dangerous selection, including harness changes. The app stores a versioned harness-specific consent timestamp. Every new review/revision/question captures that `hostExecution` snapshot; queued jobs and question follow-ups/retries keep it even if Settings later selects another mode. Archived rows missing current captures are not executable; save current Settings and start a new session. Native user setup remains native and can change outside the app; this is not a frozen or projected configuration claim.

Claude runs with `--dangerously-skip-permissions`; Codex with `--dangerously-bypass-approvals-and-sandbox`; Pi uses its normal unrestricted print/JSON mode. No app tool allowlist, exclusive MCP replacement, sanitized model-auth projection, HOME replacement or offline mode is imposed on these harnesses. Version 2 uses the explicitly selected primary `--model` override and an additive app checker tool, not restrictions on native tools. Selected skill bytes/resources are materialized without renaming them; native configuration/auth remain native. They start in an app-owned working directory with access to the separately prepared pinned checkout, not inside the PR directory, so app checkout/startup does not execute PR hooks or agent config. Native tools remain able to execute arbitrary code, write host files, access native credentials and publish directly. Read-provider permissions and app preview do not constrain these actions.

Structured result parsing, private overview, draft/proposal preservation, question focus, progress and ordinary timeout/process-group cancellation remain app features. They do not establish containment or guarantee termination of deliberately detached native descendants. There is no fallback on missing executable, incompatible output, auth failure or cancellation. Tests run only inert fake host executables in isolated homes; ordinary demo dispatch refuses live host harnesses. No live unrestricted harness was invoked.

## Explicit configuration projection

Version 2 retains the selected entry filename and containing-directory name under scratch `resources/`, with exact source bytes and relative companion resources. It is not universally renamed to `pr-review`; native harness file/skill resolution is used where compatible. V1 controls and execution are retired; stored evidence is display-only. Declared UTF-8 resources are copied to disposable scratch, with original executable bits; full source bytes, paths and content are hashed. Docker skill `assets/` companions additionally accept recognized non-executable WOFF2/PNG data with explicit base64 encoding and `font/woff2` or `image/png` identity. Fixed-header/envelope recognition is not complete format validation. Exact decoded bytes are hashed/disclosed/materialized, never interpreted as instructions, host-rendered or decompressed. Other binary formats and executable assets remain refused; Isolated/Dangerous/local-MCP and explicitly authorized external leaves stay text-only. Limits are 100 explicit source entries, 2,000 files/directories, 2 MB per file and 8 MB aggregate decoded Docker bytes, with separate 16 MB serialized resources, 32 MB workflow and 20 MB initialization bounds. General capture and each external leaf retain the independent 2 MB bound. No blanket symlink following, special files, credential-store filenames, ambient directory crawling or package installation. Explicit selected files and bounded Docker native/Nix libraries use the [trusted-source resolver and logical identity checks](docs/trusted-sources.md); external repository leaves require separate explicit metadata disclosure and source-bound read selection before content capture, never blanket link following. Native dependencies belong in the immutable bundle. The user must supply trusted, portable, secret-free resources, not credential-bearing scripts or a PR checkout.

Supported target roots:

- `.claude/settings.json`, `.claude/CLAUDE.md`, `.claude/agents/`, `.claude/skills/`.
- `.codex/config.toml`, `.codex/AGENTS.md`, `.codex/agents/`, `.codex/skills/`.
- `.agents/skills/` for Codex/Pi's trusted shared native library.
- `.pi/agent/settings.json`, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/`, `skills/`, `prompts/` beneath `.pi/agent/`.
- `resources/` for explicitly referenced portable scripts and supporting text.

Claude projection supports model/effort, permissions, hooks, agent selection, language/output style and thinking settings. Codex supports model/effort, developer instructions, role definitions, hooks, personality and the supported multi-agent/hook feature flags. Its primary sandbox requires `workspace-write` and `never` approvals; conflicting explicit choices are rejected. Pi supports the enumerated local settings in `projection.ts`, portable tool extensions and local skills/prompts/resources with the `openai-codex` provider. Referenced Pi resources and Codex role/instruction files must resolve to declared scratch resources. Host absolute paths are not silently remapped. Unknown settings are rejected with the field name, not stripped.

Codex command hooks require the source's **existing exact saved hook trust**. Import validates the pinned 0.155.0 normalized hook hash and relocates only the state key from the approved source path to scratch. It never grants new trust, changes the command or uses `--dangerously-bypass-hook-trust`. Changed/untrusted hooks, unsupported hook handlers and per-agent model overrides fail explicitly. Supported role resources remain installed; no blanket `multi_agent=false`, hook suppression or ignored user rules is added. Native tests use a previously trusted synthetic SessionStart hook. Pi tests use an explicit user tool extension.

Raw MCP entries, credential helpers, native marketplace plugins, Pi npm/git package-install specs, custom model providers and Codex connected apps are not equivalent to this projection. Already-installed absolute local Pi packages with plain relative resource manifests can be explicitly approved: portable resources are frozen and native `packages` is emptied to prevent reconciliation. This is not marketplace or arbitrary dependency support. Native Codex MCP configuration is removed before resource capture and replaced only by separately captured app grants, as disclosed before consent. Managed projection inputs containing unsupported top-level fields fail with an actionable diagnostic. Use the separate explicit host read-provider manifest for supported business reads; do not copy MCP headers, tokens or executable helpers into scratch. Codex `features.apps=true` fails explicitly; an explicitly supplied `apps=false` is preserved. Absent app settings are not silently disabled, but built-in app discovery cannot reach external networks and is not usable integration access. Arbitrary installed extensions may depend on unsupported networking, binaries or host state; importing files is not evidence that those features work.

Harness-specific references: [Claude settings](https://code.claude.com/docs/en/settings), [Codex configuration](https://developers.openai.com/codex/config-reference), [Codex noninteractive execution](https://developers.openai.com/codex/noninteractive), [Codex hooks](https://developers.openai.com/codex/hooks). Hook normalization is pinned to `openai/codex` tag `rust-v0.155.0`, `codex-rs/hooks/src/engine/discovery.rs` and `codex-rs/config/src/fingerprint.rs`. Pi 0.85.1 implementation follows the installed complete README and settings/providers/models/extensions/TUI/custom-provider/packages/skills/JSON/environment documentation and structured-output example; the runtime uses its official `dist/bundle/cli.js` entry point, not the Darwin installation.

## Runtime bundle and recorded provenance

The runtime package pins below are enforced by managed setup. Each capture requires its own immutable runtime digest.

The explicit managed setup action installs this layout using `server/execution/install-runtime.mjs`; review execution itself never installs or pulls anything. Public manual workflow/bundle authoring is retired; the layout below is internal managed setup machinery. Required layout:

- `artifacts/claude/package/claude`: `@anthropic-ai/claude-code-linux-arm64-musl@2.1.280`.
- `artifacts/codex/package/vendor/aarch64-unknown-linux-musl/`: complete `@openai/codex@0.155.0-linux-arm64`, including sandbox/code-mode resources.
- `artifacts/pi/node_modules/@earendil-works/pi-coding-agent/`: `@earendil-works/pi-coding-agent@0.85.1` and its Linux-compatible installed dependencies, using the package's shrinkwrap and `npm install --ignore-scripts` in an owned Linux fixture container.
- `runtime/bin/bash`, `runtime/usr/bin/git`, `runtime/usr/bin/rg`, `runtime/usr/libexec/git-core`, `runtime/usr/lib/*.so*`: signed Alpine v3.24 aarch64 packages. Codex's bundled ripgrep is not the working musl implementation.

The original configured executor's ignored test bundle and the managed installer use these official publisher integrity pins:

- Claude registry tarball `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64-musl/-/claude-code-linux-arm64-musl-2.1.280.tgz`, SHA-256 `c97dd11f2cfdaa0d5ee17cfd3fac28310bf137541de2c577c40094131697f534`, npm integrity `sha512-SCpowU8dQo7tlh0m0Pp6KByEtfLtQYNu9QTGSWT3CZ8XlxStT45z8q7DWdm5/WVpR5iFmQJbqT7y9BSPsT0G/Q==`.
- Codex registry tarball `https://registry.npmjs.org/@openai/codex/-/codex-0.155.0-linux-arm64.tgz`, SHA-256 `ef1dac449531753ccfb02ec7df20164f3cf48fff666bf1b7348c3f872a13b6e9`, npm integrity `sha512-iMyMjIYHlBUUDeTEGeEftQozQz0h7nYYCaLDJlZnqDF2Y0+bfdD/ppDS3vsw6mIz/z49haC6TCer11iEWO6fsA==`.
- Pi registry tarball `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz`, npm integrity `sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==`.

Runtime artifacts and caches are not distributed in this repository. Every workflow binds its actual complete bundle, skill, configuration, controls and broker contract. Changed pins invalidate saved sessions rather than selecting replacements.

`auth:"fixture"` requires explicit demo mode. By default it runs `bundle/fixture.mjs` and synthetic model responses. `fixtureNative:true` instead runs the pinned native CLIs and requires a directly injected, explicitly synthetic inference callback; no callback means failure, never a live-provider fallback. This injection is not exposed over HTTP. Fixture snapshots always carry `fixture:true`.

## Enforced boundary

Every run has its own read-only container, network `none`, UID/GID 1000, all capabilities dropped, no-new-privileges, private IPC/cgroup/PID/mount/network namespaces, 256 PIDs, 3 CPUs, 3 GiB memory and bounded scratch/tmp tmpfs. Only verified runtime files, app-owned controls and pinned source are mounted. No host HOME, Docker socket, app database/config, SSH, keychain or unrelated credential directory is mounted. There is no generic host shell or network proxy.

The Docker VM/kernel/daemon, app/supervisor, runtime bundle, explicit trusted configuration and narrow provider implementations are trusted. The boundary does not defend against a malicious host administrator, a kernel/Docker vulnerability or replacement of trusted files during checking. Provider/PR/model/tool text is untrusted data. Checkouts reuse `SourceCheckout` with exact base/head verification, disabled host Git templates/global configuration/hooks/fsmonitor and a pinned base-branch ref. Primary harnesses start in scratch, not in the PR checkout. PR hooks/configuration are never imported or executed by the app.

The model can write scratch scripts and start nested processes, all under the same outer boundary. Native read/search/edit/write/shell use `/scratch/workcopy`, a bounded container-owned copy of `/source/checkout`. Known PR agent configuration is excluded from the writable tree at every level, while immutable evidence retains it. Git hooks/remotes/config are not copied and safe local Git configuration is rebuilt. An app-authored alternate reuses the already mounted read-only source object store, preserving full acquired Git history without duplicating it into scratch. Inherited alternate chains and object-store symlinks/special files are refused; the existing entry-traversal and copied-byte limits remain. Worktree/index/refs and new objects stay disposable. Native execution re-verifies base/head and HEAD before and after preparation. No writeback or source export exists. Codex's inner workspace-write sandbox permits `/scratch` and container loopback, not host networking. Its shim copies the already projected Codex configuration into a unique scratch home per nested invocation because the primary sandbox protects its own config directory. Saved hook state keys are relocated without changing trusted hashes. Only the explicitly captured supported native configuration is projected; no ambient host configuration or business credential is copied.

### Exact seccomp delta

`seccomp-default.json` remains unmodified Moby `profiles/seccomp v0.2.3`, SHA-256 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`, with retained Apache-2.0 license. `policy.ts` appends only:

- `clone` argument 0 equal to `0x78020011` (NEWNS, NEWIPC, NEWUSER, NEWPID, NEWNET, SIGCHLD) or `0x38020011` (the same operation without NEWNET, retaining the outer container's isolated loopback).
- `unshare` argument 0 equal to `0x10000000` (NEWUSER).
- `pivot_root`, and `umount2` argument 1 equal to `2` (MNT_DETACH).
- `mount` argument 3 equal to one of `0x6`, `0xa`, `0x8c000`, `0xc0edd000`, `0xd000`, `0x209027`, `0x20902f`, `0x9027`, `0x4c000`.

The current policy digest is `936eb986103faafea97a87f4b3278641269d461a34aac9f736a677b61249b1f3`. No writable-remount combination, clone3, setns, chroot, deprecated Landlock bypass or unconfined seccomp is added.

### Selective model authentication

Only execution reads required model credentials: default macOS Claude Max keychain entry, default Codex ChatGPT auth file, and/or Pi's explicitly referenced `auth.json` `openai-codex` OAuth entry. Each harness uses its own unexpired access credential and account identity; no cross-harness login substitution. Required nested harnesses are included. Custom Claude/Codex store locations, API-key modes and other Pi providers are unsupported. Pi's explicit file is not read during setup or GET.

Only explicitly approved required primary/nested model access credentials enter disposable tmpfs, with refresh fields empty; unrelated harness credential files are absent. The exact preview identifies each source, presence-only evidence, untested validity and the fact that all container code can read these access credentials. Native enablement alone grants no exposure. Host model brokerage remains mandatory; a replacement host-only native login mechanism is not claimed. Changed captured HOME fails rather than substituting another login. Source stores remain unchanged. The app never logs in, refreshes, rotates or logs out. Expiry fails the session. This model-only projection is intentionally visible to isolated code. Business-provider credentials stay solely in the host provider closure and are never passed to harnesses, saved snapshots, API results or logs.

A private stdio relay reaches a per-run host broker with random capability/run identity, request/concurrency/byte/time budgets and cancellation. Model destinations are fixed POST Anthropic `v1/messages?beta=true` and ChatGPT `backend-api/codex/responses`, with distinct selected Pi/Codex credentials. The broker validates model-shaped bodies, selected model pins and local client tools, rejecting hosted web/MCP/computer tools, storage, generic destinations and redirects. SSE is bounded and buffered, not full streaming parity.

## Bounded business read providers

Import only an explicit absolute read-provider manifest with `POST /api/settings/integrations/import-read`. Import validates local metadata, stores a secret-free `{path,digest,entryId}` reference, leaves imported entries disabled with no allowed tools, and does not read auth or contact providers. Enable the entry and its vetted tool separately. Effective access requires an explicitly saved current Isolated capability profile or selected compatible Docker execution. No catalog GET, import or toggle proves a connection.

Example manifest (replace paths and scopes with explicitly approved sources):

```json
{
  "version": 1,
  "readProviders": [
    {
      "id": "github",
      "provider": "github",
      "endpoint": "https://api.github.com",
      "scope": ["example/repository"],
      "auth": { "kind": "gh-login" }
    },
    {
      "id": "linear",
      "provider": "linear",
      "endpoint": "https://api.linear.app/graphql",
      "scope": ["TEAM-42"],
      "auth": {
        "kind": "json-value",
        "path": "/absolute/approved/mcp.json",
        "keys": ["mcpServers", "linear", "env", "LINEAR_API_KEY"],
        "format": "raw"
      }
    },
    {
      "id": "notion",
      "provider": "notion",
      "endpoint": "https://api.notion.com/v1",
      "scope": ["11111111-1111-1111-1111-111111111111"],
      "auth": {
        "kind": "json-value",
        "path": "/absolute/approved/auth.json",
        "keys": ["notionToken"],
        "format": "bearer"
      }
    }
  ]
}
```

An explicit JSON-value reference can reuse a literal credential in an existing supported MCP JSON header/env field or another approved JSON store. It reads only that value, not executable helpers, shell substitutions, environment discovery, OAuth browser/keychain sessions or refresh tokens. `raw` supplies the selected value as Authorization exactly (for example an existing `Bearer ...` header or Linear API key); `bearer` prefixes a bare token. Only GitHub supports `gh-login`, using the fixed `gh auth token --hostname github.com` read. No configuration/logins are rewritten.

Audited host operations, independent of model names or annotations:

- GitHub tool id `pull-request`, name `github_pull_request_read`: `{repository,number,method}` with `method` exactly `get`, `get_files` or `get_reviews`. Exact declared repositories only; positive bounded PR number. Fixed GET PR/files/reviews routes, at most 50 list entries. No arbitrary REST path or GraphQL.
- Linear tool id `issue`, name `linear_get_issue`: `{id}` from the exact declared issue ids/identifiers. One fixed GraphQL **query**, bounded validated variable, selected issue/title/description/state fields. No caller-supplied query or mutation.
- Notion tool id `page`, name `notion_read`: `{id,method}` with explicit UUID scope and `page` or `blocks`. Fixed GET page or first 50 child blocks, version `2022-06-28`; no recursive crawling or writes.
- Custom tool id `document`, name `documents_get`: the single explicitly vetted `pr-review-documents/1` protocol below, not arbitrary MCP support.

Custom configuration uses `id:"custom:documents"`, `provider:"documents"`, `vettedDefinition:"pr-review-documents/1"`, an explicitly approved public HTTPS `/mcp` endpoint, exact document ids in `scope`, and an explicit JSON-value auth reference. This definition must be selected only for a provider whose actual implementation has been vetted for document reads; a matching tool name or `readOnlyHint` is not sufficient authority. The host fixes protocol `2025-03-26`, server identity `pr-review-documents` version `1`, a single exact-schema `documents_get({id})` tool and a single text result. It emits only initialize, the initialized notification, tool inventory and that bounded read call. No arbitrary RPC method, tool, arguments, URL, resource URI, prompt, sampling or server-initiated operation is forwarded. Extra tools/schema drift, different server identity, streaming/sessionful transports and unvetted definitions fail closed. The endpoint's actual trusted implementation remains a trust assumption, as with other providers; the app cannot remotely attest arbitrary server code. The deterministic reference fixture is evidence of protocol compatibility, **not a deployed/vetted external service or live connection**.

Host HTTPS transport pins the resolved public IPv4 address to the approved hostname for the request, requires normal TLS validation, port 443 and JSON HTTP 200, rejects redirects/private addresses/IP literals, and bounds each read to 15 seconds and 200 KB. Argument schemas reject additional fields and out-of-scope resources. Results are bounded and validated; selected credential literals in responses are rejected. The immutable run policy pins manifest bytes and allowed tool ids; drift fails before use. Revocation/cancellation aborts outstanding calls. Only this run's approved read tools and immutable PR snapshot reach container MCP; the `gh` shim remains a snapshot-only `pr view`/`pr diff`, not live GitHub CLI access.

`POST /api/settings/integrations/:id/test` is an explicit read action. For an imported provider it performs one bounded read (GitHub's fixed `/user` identity read, otherwise the first scoped resource), returning point-in-time evidence. `scope:"live_read", connected:true` requires actual successful production transport; local metadata and injected synthetic HTTP return `connected:false`. All tests return `mutating:false` and `containmentVerified:false`. Evidence is cached in memory, never refreshed by GET and not carried across production restart. Re-import invalidates prior evidence. Source files, tokens, response bodies and raw errors are not persisted as connection evidence.

## App-owned remote MCP OAuth

The [shared host OAuth lifecycle](docs/mcp-oauth.md) extends Connections through reviewed metadata profiles, SDK Streamable HTTP and app-owned macOS Keychain entries. It does not alter the model-token no-refresh policy above, native harness credentials, Dangerous inheritance, the legacy document protocol or container privileges. Only this app's explicitly configured client can initiate consent/refresh; native Claude or slack-axi logins are not imported. DNS pinning, HTTPS/public-origin/redirect limits, cancellation and bounded responses apply to discovery and every authenticated operation.

OAuth consent is separate from default-denied read permissions. Reviewed Slack, Linear, Notion and Axiom adapters expose only explicitly granted bounded reads, with source/schema/generation fences. Authentication alone is not content-read evidence. See [OAuth](docs/mcp-oauth.md) for provider and identity limits. Linux credential adapters are not implemented and have no plaintext fallback.

## Container-local known MCP

Docker's new explicit inspection accepts previously discovered local connection ids, the shared known profile, exact resource scope and default-denied enable/tool choices. Only an operator-owned portable Node `.mjs` entry with no additional arguments/env/auth/helper/package runner is supported. The exact code/resources and profile are part of the approval digest. Disabled/ungranted local code is not materialized. Execution is exclusively inside the container, never a host child, and receives no new mount/network privilege or business credential. All container code can read the separately disclosed model credentials.

Each invocation validates the known document server/protocol and complete exact tool schema, then exact resource arguments. New tools, schema/server drift, server-initiated requests and out-of-scope arguments fail closed. Limits are 15 seconds, 200 KB, 100 operations and four concurrent children under the outer process/resource boundary. No GET or discovery starts a server. Inspection is local compatibility, not inventory/Test/Connected. Container execution records bounded counts; host Load/Test remains unsupported for stdio. Remote business tools continue through the same captured host registry/broker contracts as Isolated. Full contract and limitations: [Docker handoff](docs/docker-boundaries.md).

## Lifecycle and immutable storage

Preflight checks exact engine/image/runtime, capabilities/seccomp/no-new-privileges, effective cgroup PID/memory/CPU limits, read-only mounts, scratch writes, network denial and native versions/current Codex sandbox behavior, without model credentials or provider calls. Missing/incompatible runtime fails before checkout or inference. Retrying preflight after restoring the exact source can clear a prior failure; it does not change the snapshot.

The trusted host supervisor owns create/attach/remove. Cancellation, timeout, app IPC disconnect or normal completion closes brokers and removes all owned container descendants, including daemonized children or stopped container PID 1. Private ownership journals prevent concurrent app owners. Startup recovers only matching owner labels after confirming the previous app PID is dead, removes owned stale scratch and interrupts saved jobs rather than replaying them. Captured managed artifacts have separate owned directories. Uncertain/live ownership or unverifiable cleanup fails closed without killing unrelated resources.

`ReviewRun.reviewer.execution` and `Question.reviewerSnapshot.execution` use existing immutable JSON storage, now including `harness` and optional `sourceId`. Only v2 managed Docker captures with explicit `container-native-1` disclosure/approval can execute with exact frozen artifacts. Old v2 without approval, v1/imported execution-only and absent captures fail before dispatch; archived data remains readable. Integration snapshots pin secret-free source references and effective tool ids. New revisions use the selected workflow with the draft's immutable PR input; existing queued/running jobs and question threads retain their captured policy. Draft edits, proposals, private overview, stale-preview rejection, exact-confirmed submission and queue/automation semantics remain unchanged.

Claude requires one successful structured result; Codex requires a completed turn with authoritative final JSON; Pi requires the final assistant `message_end` with `stopReason:"stop"` and `agent_end`. Malformed/oversized streams and invalid payloads fail. The canonical [review output contract 1.0](docs/review-output.md) accepts optional/defaulted finding anchors and arbitrary overview Markdown. Historical unknown payload properties are discarded, not newly rejected. No particular overview headings are required. Historical skill-owned progress uses `workflow`, not fabricated sequential secondary-review stages. Version-3 Isolated also uses `workflow`, with truthful per-entry lifecycle/evidence for actual app-invoked Additional and Main work. Logs contain bounded counts/cleanup evidence, not auth, prompts, raw stderr or stream content. Dangerous host Claude structured-result failures also report the result-frame count and only closed-category final subtype, error flag and structured-output presence; older generic errors cannot be classified retrospectively. Native fixture diagnostics are explicitly injected in demo tests only, bounded and not persisted. Literal secret filtering is not an information-flow proof against encoding model-only tokens that isolated code is intentionally allowed to possess.

## Verification and remaining limits

See [publication validation](docs/publication-readiness.md) for local test and inert browser results. Native/provider availability must be verified separately for your own supported setup.

Unsupported combinations remain actionable: other platform/engine/image/runtime pins; nonportable resources/binary extensions, package reconciliation, arbitrary raw MCP/stdio/legacy-SSE/OAuth read tools without vetted implementation; enterprise/noncanonical GitHub or generic REST/GraphQL; unsupported auth stores/providers, mismatched model/effort pins, untrusted hooks, connected apps, refresh and long-session reconnect/streaming parity. Isolated's separate current support is documented in [isolated-capabilities.md](docs/isolated-capabilities.md). The bounded Docker backend expansion is documented in [docker-boundaries.md](docs/docker-boundaries.md); its Settings integration and coherent checks are recorded in the same document and in [execution-modes.md](docs/execution-modes.md).

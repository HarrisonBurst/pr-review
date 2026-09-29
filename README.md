# Local PR Review

Local PR Review is a single-user macOS app for reviewing GitHub pull requests with Claude Code, Codex or Pi and your own trusted review skill. It keeps review runs separate from editable drafts and requires an exact-payload preview before you publish through the app. A Node.js and TypeScript backend serves the React UI on `127.0.0.1:4317` and stores data in SQLite.

## Start here

Fresh Settings selects Dangerous intent, which gives the selected harness full host-native tools, configuration and authentication. It cannot run until you explicitly Save and confirm the host risks. Dangerous tools can write files and publish outside the app's preview controls.

Choose Isolated Harnesses or Docker when their documented limits fit your review skill. Neither mode falls back to Dangerous. This is a local application, not a hosted service.

- [Install and run](#install-build-and-run), or [try the UI without credentials](#try-the-ui-without-credentials).
- [Choose an execution mode](#supported-execution-and-settings) and [configure connections](#connections-and-read-permissions).
- Learn about [automation](#automation-controls), [the inbox](#inbox-groups-and-ordering) and [drafts](#review-drafts).
- See the [execution guide](docs/execution-modes.md), [API contract](API_CONTRACT.md) and [validation results and limits](docs/publication-readiness.md) for details.

Project code uses the [MIT license](LICENSE). The bundled seccomp component retains its [Apache-2.0 license](server/execution/LICENSE.seccomp). Dependencies and separately installed runtimes retain their own licenses.

### Prerequisites

Use macOS, Node.js 24 or newer, npm and Git. CI uses Node 24. The app uses Node's built-in SQLite, so you do not need a database service.

For real repository use, install the official [GitHub CLI](https://cli.github.com/) and authenticate it with access to your repository. Check access with `gh auth status`. The app invokes `gh`, not an agent-specific wrapper.

For AI work, install and authenticate your selected [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://github.com/openai/codex) or [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) CLI through its supported native setup. If your skill invokes another harness, configure that harness too. Model catalog discovery does not prove account or model access.

Install a trusted review skill yourself. The default entry, `~/.claude/skills/pr-review/SKILL.md`, is not bundled; choose an absolute Markdown entry in Settings if yours differs. Its resources and output must satisfy the [review output contract](docs/review-output.md).

Docker is optional and needed only for Docker execution. Before consenting to app-managed setup, check the pinned runtime, architecture and authentication support in [Docker boundaries](docs/docker-boundaries.md). A working Docker installation alone is not enough.

OAuth credential storage requires macOS Keychain. Some tests work on other platforms, but that does not make Linux or headless operation supported.

### Install, build and run

Clone the public repository, install its locked dependencies and build the app:

```sh
git clone https://github.com/HarrisonBurst/pr-review.git
cd pr-review
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. Keep the app loopback-only and do not expose it through a reverse proxy or tunnel. Stop the foreground server with Ctrl-C; these commands install no login service.

On first launch:

1. Enter `owner/repository` or import a PR URL.
2. In Settings, leave automation off and choose an execution mode, harness, model and trusted skill. Follow that mode's Save and consent requirements.
3. Sync or import to read GitHub data. Review, Re-review and Ask AI invoke the configured harness.
4. Edit and Save a draft locally. AI revisions are proposals and never silently replace manual edits.
5. Inspect the exact Preview payload. Confirm a submission only when you intend to publish it to GitHub.

### Try the UI without credentials

After building, use disposable data and a separate port:

```sh
DEMO_HOME="$(mktemp -d)"
HOME="$DEMO_HOME" PR_REVIEW_DATA_DIR="$DEMO_HOME/data" PR_REVIEW_PORT=4318 npm start -- --demo
```

Open <http://127.0.0.1:4318>. The Demo mode label identifies deterministic GitHub fixtures, which Sync now populates. They do not prove live GitHub or model access.

Do not select native sources, connect providers or set up Docker during this tour. Ordinary demo mode refuses native review dispatch. For a fully synthetic editable draft and review flow, use the labeled web mock:

```sh
npm run dev:mock --workspace web -- --host 127.0.0.1 --port 5174 --strictPort
```

Open <http://127.0.0.1:5174> for seeded drafts or <http://127.0.0.1:5174/?setup> for empty setup. This mock never uses the backend or real providers, and its state resets on reload. Do not use `VITE_MOCK_API=1` for a real build.

See [contributing](CONTRIBUTING.md) for checks and fixture boundaries, [security reporting](SECURITY.md) for reporting concerns and [publication validation](docs/publication-readiness.md) for recorded limits.

## Requirements and commands

Setup and Save never rewrite installed skills, configuration or authentication stores. Dangerous native tools retain their own side effects, including native authentication behavior.

Explicitly selected file symlinks, including Nix-managed entries, retain their logical layout and frozen source identity. Docker also supports bounded native and Nix library links and recognized non-executable WOFF2 and PNG skill assets with exact-byte encoding. Arbitrary external resource targets and other binary formats remain refused; see [supported source scope](docs/trusted-sources.md).

Run these commands from the repository root:

```sh
npm ci
npm run dev
npm run build
npm start
npm test
npm run typecheck
npm run format
npm run format:check
```

Root checks include the `web` workspace. Vite normally uses `127.0.0.1:5173` and proxies `/api` to the backend. For backend-only fixtures, run `node --import tsx --test server/test/*.test.ts`.

You can check shared contracts and canonical docs explicitly with the installed Prettier. There is no separate lint script. Follow the check order in [Contributing](CONTRIBUTING.md#local-workflow).

## Configuration and storage

Export environment variables in your shell; the app does not load a `.env` file. Settings defaults initialize new settings and do not overwrite saved choices. General Settings saves never choose an execution mode or grant tools.

| Variable                            | Purpose or default                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `PR_REVIEW_HOST`                    | Loopback only, default `127.0.0.1`.                                              |
| `PR_REVIEW_PORT`                    | Default `4317`.                                                                  |
| `PR_REVIEW_REPOSITORY`              | Optional `owner/name`.                                                           |
| `PR_REVIEW_POLL_INTERVAL`           | Default 300 seconds.                                                             |
| `PR_REVIEW_SKILL_PATH`              | Initial unsaved review entry.                                                    |
| `PR_REVIEW_MODEL`                   | Initial unsaved Main model, normally null for native-default resolution on Save. |
| `PR_REVIEW_ADDITIONAL_INSTRUCTIONS` | Additional trusted reviewer instructions.                                        |
| `PR_REVIEW_DATA_DIR`                | Overrides the data directory.                                                    |
| `PR_REVIEW_DB_PATH`                 | Overrides only the database location.                                            |
| `PR_REVIEW_DEMO=1`                  | Selects deterministic fixtures, never a fallback after a live error.             |

`PR_REVIEW_HARNESS_CONFIG` and `PR_REVIEW_WORKFLOW_CONFIG` are retired and select or import nothing. `XDG_DATA_HOME`, when set, changes the default data root.

The normal database is `~/Library/Application Support/pr-review/pr-review.sqlite`. Demo mode defaults to the separate `pr-review-demo` directory. Captured trusted skill and resource bytes are stored with app data; app-owned OAuth credentials use macOS Keychain rather than SQLite.

Treat the data directory as private. It contains repository content, drafts, execution captures and diagnostic evidence, and selected sources may contain sensitive text. Back up the whole directory only while the app is stopped; restoring SQLite does not restore Keychain authorization.

## Supported execution and Settings

Fresh unsaved Settings targets Dangerous, Claude Code, the configured model and the configured skill path. The model normally starts as Native default. The selector's visible and keyboard order is Dangerous, Isolated Harnesses, Docker.

This initial choice is intent, not permission to run. Explicit Save must capture supported configuration and, for Dangerous, include fresh exact host-risk confirmation. Startup and GET requests never capture files, grant tools or execute anything.

Explicit saved choices remain unchanged. Unknown or archived state stays unavailable instead of becoming Dangerous intent. Isolated and Docker failures never fall back to Dangerous.

Settings groups controls under Repository and cadence, Automation, Execution and Connections. GitHub health appears beside repository settings; execution details include captured capabilities. Technical details stay collapsed, while execution essentials and Dangerous risk confirmation remain visible.

### Isolated Harnesses

Isolated Harnesses uses `version:3,workflow:"separated"`, with one Main harness and model plus zero to eight ordered Additional entries. Claude Code, Codex and Pi can fill any role, including multiple models on one harness. The app runs Additional reviewers first, then Main performs a full review, verifies findings and synthesizes one editable draft without hidden reviewers.

Save freezes the review entry and resources, a bounded trusted native library, supported native preferences, instructions and effort, and each entry's `restricted-native-1` policy. Inherited executable plugins, hooks and extensions are disabled. Reviewers receive disposable model-auth homes and only the environment and authentication their own harness needs.

Business credentials stay with host-side connections. Approved gateway tools enforce captured source, profile, schema, tool and destination permissions. Slack relies on provider access controls rather than app-enforced channel isolation; other documented resource scopes still apply.

Isolated Harnesses restricts native tools but does not provide OS or process containment. It does not promise universal native compatibility. See [Isolated limits](docs/isolated-capabilities.md).

### Docker

Docker uses `version:2` and lets the selected skill and native harness orchestrate the review inside a container. Native read, search, edit, write and shell tools operate on a disposable writable PR copy while the pinned source stays immutable. Docker never falls back to host execution.

Selecting Docker shows a readiness card with Set up Docker or Fix setup when action is needed. The guided flow separates these steps:

1. Save the selected harness, model and skill if needed.
2. Review bounded source metadata and make independent read choices for each source alias before Inspect.
3. Inspect capabilities and review the exact disclosure. The app reuses prior approvals only when it can verify that the approved items are unchanged.
4. Approve each disclosed capability and exposure. This includes portable resources, arbitrary container code in hooks, extensions, skills or shell prefixes, temporary model access tokens readable by all container code, and selected local stdio tools.
5. Separately consent to the host effects of Set up Docker.

Setup revalidates the disclosure, installs pinned app-owned runtime and cache artifacts, checks runtime policy without credentials and freezes the approved artifact. It does not select Docker, install Docker Desktop or enable automation. It never reads model credentials, logs in, refreshes authentication, contacts models or providers, or rewrites native configuration.

Remote business reads still require Connections grants, with credentials kept on the host. Supported local stdio tools must be discovered Node `.mjs` entries with frozen portable files. They run only inside the container, never through host Load tools or Test connection.

Missing or unsupported setup fails without a host fallback. Older Docker captures without the approval marker remain readable but cannot run. See the [Docker support matrix](docs/docker-boundaries.md) and [execution boundary](EXECUTION_BOUNDARY.md) for setup exposure, runtime pins and enforcement limits.

### Dangerous

Dangerous uses `version:2` and runs the selected host harness with full native tools, configuration and authentication. Every Save requires fresh exact confirmation that the backend validates. Native tools can write host files and publish outside app preview, and app read permissions do not restrict them.

App validation, drafts, revision proposals, progress and cancellation still apply. They do not provide process containment.

### Models and discovery

Selected models override the real native invocation. A null model resolves supported native defaults only on Save. Isolated Harnesses owns reviewer orchestration and model selection; Docker and Dangerous retain the skill's native nested orchestration.

Explicit [model discovery](docs/model-discovery.md) reads installed Claude and Codex first-party catalogs through credential-free native metadata processes in disposable homes. It starts no prompts, threads or turns and changes no user authentication or configuration. Pi uses its existing static declarations and offline catalogs.

Catalog entries are distinct from configured or saved IDs, and discovery never proves account access or readiness. Unsupported providers and mechanisms remain visible without cross-provider fallback. Configured or cached setup readiness does not mean Connected.

Main, Additional and Docker or Dangerous model fields have searchable selectors with explicit Discover or Refresh actions. Native default is always available, and Custom id is available when the value is not already listed. The selectors distinguish loading, unsupported sources, source errors, transport failures and previous discovery results.

Opening a selector shows all choices for its harness without clearing the current value. Typing filters by ID or label. Adjacent Settings inputs and buttons are 32px high, and missing setup, authentication or requirements appear inline.

### Connections and read permissions

Connections appears when Isolated or Docker is selected. Add a provider offers reviewed providers, including Notion, without requiring a native MCP file. Add provider stores disabled metadata only; Connect handles this app's separate authorization, and read grants require explicit choices afterward.

Native connections use explicit discovery of Claude JSON or Codex TOML, a reviewed profile and resource scope, Load tools, separate enable and per-tool choices, and Test connection. Grants start denied. Claude built-in connectors and their logins are not discovered or inherited.

[Discover Connections](docs/known-mcp-profiles.md#discover-connections-and-unchanged-rediscovery) reads only the selected native file, not app-owned profiles or an installed-plugin inventory. Unchanged rediscovery preserves credentials and grants. Replacing a changed OAuth definition with configured credentials requires explicit Disconnect first.

[Host-owned MCP OAuth](docs/mcp-oauth.md) supports reviewed metadata, authentication and inventory through app-owned macOS Keychain storage. The UI supports app callbacks and explicitly selected fixed-loopback callbacks. This does not enable arbitrary plugins or inherit native logins, and source authentication and configuration stores remain unchanged.

Authentication alone grants no reviewer tools. An OAuth card's Connected label means the app admitted its authentication, not that a read succeeded. Only `scope:"live_read"` with `connected:true` proves a successful read at the recorded time; synthetic, local and inventory checks do not.

Supported provider reads have distinct limits:

- [Slack](docs/mcp-oauth.md#authenticated-slack-read-adapter) offers separately granted, bounded search, channel and thread reads under Slack's access controls. Writes and unclassified tools are denied at invocation. The app neither promises nor requires independent identity verification or channel isolation.
- [Axiom](docs/axiom-reads.md) uses official browser OAuth and the guided registration and consent flow. Grants cover dataset listing, observed fields and bounded event samples. Its sign-in scopes are not provider read-only permissions, and its broader host credential stays outside Isolated and Docker.
- [Notion](docs/notion-reads.md) offers only explicitly granted, ID-only `notion-fetch` through the OAuth broker. Consent discloses its broader `default` capability, while the app denies writes, search and agent tools. Notion Test checks local configuration, not content or live connectivity.

GET requests and server-sent events initiate no connection actions. Stdio never runs on the Isolated host, even when a checkbox is selected. Legacy SSE, executable helpers and arbitrary native plugins remain unsupported.

Known profiles describe reviewed protocols, not server trust or permission. Audited GitHub, Linear, Notion and document-provider manifest imports remain supported, without a claim of native MCP parity. See [known profiles](docs/known-mcp-profiles.md) and the [API contract](API_CONTRACT.md) for exact contracts and Test behavior.

Historical compatibility options, workflow-source authoring, Legacy metadata import and standalone raw Diagnostics or Tool health panels are retired. Relevant source, provenance, permission, error and Test information appears with its controls.

## Troubleshooting

### Node, SQLite or dependency errors

Use Node 24 or newer, run `npm ci` from the root and then run `npm run build`. `npm start` requires that build. Use `npm run dev` for backend and Vite development together.

### Port already in use

Stop your own prior instance or choose another `PR_REVIEW_PORT` for the built app. Vite's development proxy targets port 4317, so changing only the backend port does not update the proxy. Never bind to a public interface.

### GitHub unavailable or inbox empty

Run `gh auth status` in the same environment that launches the app and verify repository access. The app does not import every open PR; import other PRs explicitly by URL. Sync does not run reviews while automation is disabled.

### Execution unavailable

Install and authenticate the selected harness, verify the absolute skill path and explicitly Save. Archived captures require a new save, not a database reset. Dangerous requires fresh confirmation every time.

Isolated Harnesses disables inherited executable hooks, plugins and extensions. Unsupported native behavior does not permit automatic host fallback.

### Docker not ready

Read the readiness card and support matrix, inspect and approve exact sources and capabilities, then separately consent to setup host effects. Source or runtime drift requires revalidation. Do not delete captures or weaken guards to bypass a refusal.

### Connections not usable

Discovery reads the selected supported native configuration, not Claude built-in connectors or existing logins. Add provider starts disabled; Connect, Load tools and explicit per-tool grants are separate steps. Provider schemas, client eligibility and supported authentication may still prevent use.

Notion supports ID-only `notion-fetch`, not search, write or agent tools. Its Test is a local check, not live-read proof. See [Notion](docs/notion-reads.md) and [OAuth](docs/mcp-oauth.md).

### Tests fail or work is interrupted

Keep the failure, command and revision, and report a minimal synthetic reproduction. Never attach your database, credentials, native profiles or raw diagnostics. See [recorded preparation results](docs/publication-readiness.md); live integrations and opt-in container or Keychain tests are separate from unit-test evidence.

## Saved history and upgrade consequences

Upgrades do not reset or convert historical execution captures. Saved choices, reviews, results, progress, edited drafts, proposals, submissions, questions and evidence remain readable. Settings offers re-save instead of an executable historical option.

Unsupported captures include fixed Claude/Codex execution, versionless execution, v2 single-primary Isolated, and v3 Isolated without required capability policies. Version 1 or imported execution-only Docker and host-only Dangerous captures also cannot run. See the [archive contract](API_CONTRACT.md#archive-and-upgrade-consequences) for exact shapes.

Re-saving affects new reviews, revisions and independent questions, never old captures. Unsupported question retries and follow-ups fail before changing the answer or status; save current Settings and start an independent question instead. Supported queued jobs and threads retain their captured roles, models and permissions, with the existing restart interruption and deduplication rules.

## Review output and progress

[Output contract 1.0](docs/review-output.md) and `npm run check:review-output < candidate.json` use the same validator as final ingestion. Current native adapters expose the read-only `check_review_output` tool. Passing the format check proves neither correctness nor permission to publish.

Custom overview Markdown and optional anchor defaults remain supported. Each result requires a complete authoritative native stream and valid canonical output. Malformed, truncated or oversized results never count as success.

Execution records checkout, `workflow` and finalize phases, plus the captured per-entry Isolated evidence. Main receives Additional failures, which also appear in private rationale; Main failure creates no draft. Historical `claude` and `codex` phases remain display-only.

Progress labels exclude prompts, reasoning, raw command arguments, credentials and tool output. Bounded activity and actual timestamps persist across reloads and restarts. The app does not invent completion estimates.

## Safe fixtures and operational limits

Use a labeled demo or mock server on its own loopback port, with disposable HOME and data. Ordinary demo mode refuses native Isolated and Dangerous dispatch unless code-injected inert fixtures replace it. It does not substitute a single-review fixture for configured roles.

The labeled web mock uses `VITE_MOCK_API=1` and covers Settings states through [documented URL parameters](API_CONTRACT.md#web-implementation-on-these-contracts). Never submit a real GitHub review for a test.

PR content is untrusted. App checkout preparation pins the exact base and head and disables Git hooks, templates and global configuration. Native harnesses start outside the PR checkout and do not inherit PR agent configuration.

Isolated Harnesses permits only bounded source and library reads, the canonical checker and captured audited gateway tools. Docker adds OS and container enforcement for explicitly approved code and excludes PR agent configuration from its writable copy. Dangerous removes the app's native-tool restrictions.

App publishing always requires a fresh exact preview and explicit confirmation. The app reconciles uncertain writes instead of retrying automatically. Cancellation tracks process ownership but cannot contain malicious detached host descendants.

Optional launchd installation is never automatic, and any installed service must remain loopback-only. The newcomer setup installs no login service, configures no credentials, enables no polling and publishes no reviews.

## Automation controls

Settings has four independent global defaults, grouped into polling and auto-review pairs:

- Poll for new commits refreshes every tracked open PR on the poll interval. It keeps stale indicators and new-commit lists current without an open detail page.
- Auto-review new commits queues a `new_commits` review when a polled head changes. Title and description edits do not count, and this policy acts only while commit polling is on.
- Poll for review requests lists the repository's open PRs and records requests addressed to you or your current teams, including same-commit re-requests. It refreshes tracked PRs so closed PRs and removed requests leave the inbox. Only matching or already tracked PRs are fetched in full; unrelated open PRs are never imported or diffed.
- Auto-review requests queues a review for each newly observed request event. It acts only while request polling is on.

### Per-PR overrides

Polling is global only. Each PR page shows polling switches read-only with a link to Settings and offers Inherit, On and Off overrides for the two auto-review policies. A PR cannot opt into polling while its global switch is off, and enabling auto-review never enables polling.

The effective result appears beside each override. `Inherit (global Off)` means Inherit resolves to off, while `Off (this PR)` is an explicit override that wins over global On. Auto-review that is on while its polling switch is off appears inactive.

Older databases discard per-PR `pollCommits` and `pollRequests` overrides at startup but retain auto-review overrides. Those overrides act only after the matching global polling switch is on. The migration never enables a global switch.

### Baselines and duplicate work

The first poll after enabling a policy records the current head and outstanding requests without queueing reviews. Only later changes and request events trigger automatic work. Use Re-review for explicit catch-up.

Baselines, request IDs and jobs persist, so restart does not review the same head or event twice. A new-head trigger and a request trigger for the same commit share one pending run. A later same-SHA re-request after a completed run queues a new review.

Turning off a policy stops future automatic jobs without cancelling active work or touching drafts. Closed PRs, refresh failures and rate limits queue nothing.

Older databases retain the scope of their `pollingEnabled` setting. An enabled legacy setting becomes request polling plus request auto-review, while commit automation stays off.

## Review concurrency

Maximum concurrent reviews is a global integer from 1 to 8, defaulting to 1. Older databases also start at 1. It caps full reviews and AI revisions, not Ask AI questions, which have their own single-slot queue.

Each running job has a pinned checkout, immutable snapshot, result, log, progress tracker and cancellation control. It opens its captured harness context, so higher concurrency uses more CPU, memory and simultaneous model sessions. Jobs for the same PR always run sequentially to avoid conflicting status, draft and proposal updates.

The oldest eligible jobs for other PRs use free slots instead of waiting behind a busy PR. Same-head pending-review deduplication and first-in, first-out ordering among eligible jobs remain unchanged.

Saving a higher limit starts eligible queued jobs immediately. Lowering it never cancels active jobs and starts no new work until the running count falls below the new limit. Changing the limit queues no reviews, changes no automation policy and approves or posts nothing.

Backend shutdown interrupts every active job and marks it interrupted. Restart reruns none of them automatically.

## Inbox groups and ordering

The inbox contains open PRs that request your review, request a review from one of your teams or were imported by URL. Each appears once in one of three collapsible groups:

- Requested of you includes direct requests, including requests addressed to both you and a team.
- Requested of your teams includes team-only requests for teams you currently belong to in the repository's organization.
- Other tracked PRs includes imported PRs without a current request and legacy requested rows whose request type is not yet known.

Closed and merged PRs leave the inbox and stop being polled. PRs with removed requests do too unless imported by URL. Their runs, drafts, questions and submissions remain readable at their PR URLs and are never deleted.

The first two groups start expanded and the third collapsed. Your choices persist for the browser session through navigation and live updates. Group headers support keyboard controls and show counts, or `shown of total` while filters apply.

Search and status filters apply to every group, including collapsed ones.

### Row actions

Each row offers Review, or Re-review after a completed review, unless the current commit already has a completed full review. The action syncs the latest commit and queues one manual review under the normal concurrency and per-PR deduplication rules. It never approves or posts anything.

Each button independently shows Syncing during refresh, then Queued or Reviewing from the row's status. Refresh, closed-PR and queue failures appear in a toast even if the row leaves the inbox.

The idle button disappears when `hasReviewedHead` records a completed full review of the exact current commit. A same-head re-review remains available on the PR page, where you can add instructions. Only exact-head full-review history decides this, not status, `lastReviewedAt`, drafts or AI revisions, so a new commit restores the button.

The row title links to the PR page, and clicking elsewhere on the row opens it too. Modifier clicks open it in a new tab. The review button only starts local review work.

### Ordering and settled submissions

Within each group, Ready drafts come first, then other active statuses, then settled submissions. Each band runs from oldest to newest. A settled PR has Submitted status only while a confirmed successful submission remains the newest evidence for its latest draft.

To remain settled, the submission must meet all of these conditions:

- Its preview names the latest draft ID and save version, and its payload targets the current head.
- No later submission attempt is in flight, uncertain or failed.
- No review request event has a timestamp later than the submission.

A fresh request or same-commit re-request restores status from the latest draft at the next sync. Startup also applies this rule to older databases. An older request discovered after submission does not count as newer.

You may submit an intentionally selected older draft for the same commit, but that never settles the newer draft, which stays Ready. A new commit makes the PR Outdated. A saved edit, accepted revision or new review draft makes it Ready.

A successful submission or reconciled uncertain write that no longer matches the latest draft, version or head keeps the current status. If it lands while a review is queued or running, that review state remains instead of Submitted. Failed and uncertain submissions never set Submitted.

A stored submission without preview or draft identity stays in history but does not prove that the latest draft was submitted. The Submitted badge has a violet tone and check mark, distinct from Ready and Outdated in both themes. Its label carries the meaning without relying on color.

Age means latest request time in the requested groups and PR creation time in Other tracked PRs or when request time is unknown. Rows identify the source with labels such as `requested 2h ago` or `opened 3d ago`. Unknown dates sort last; equal dates use the PR number.

### Request and import history

Request provenance is `direct`, `team` or `both`, read from GitHub's requested reviewers and your team membership on each request sync. It clears when the request disappears or the PR closes. Commit-only polls, freshness checks and other refreshes that do not read requests leave it unchanged.

Older databases gain empty `request_source` and `created_at` columns. Previously requested rows appear under Other tracked PRs with `requested, type unknown` until a request sync records their provenance. The next PR refresh fills creation time; nothing is inferred from the author or title.

Importing an open PR by URL marks it `imported`, even if already tracked or requested. That mark survives refreshes, polls and request removal. Closed or merged imports fail with a clear error while preserving existing history.

Running a review, opening a page or having a draft never counts as an import. Older databases add `imported` with every row unmarked because previous versions recorded no import provenance and could import unrelated PRs through broad polling.

On upgrade, those unrequested rows leave the inbox and polling but retain their full history at their PR URLs. Import the same URL to track an open PR again without creating a duplicate. The migration queues no review and changes no draft.

## Merge readiness

Each inbox row has a `Merge:` hint, and the Status card has a Merge row. These show GitHub's report for the exact displayed head, not permission to merge. They do not change local draft status, grouping, ordering or filters, and never merge, approve or review anything.

The reported states are:

- Ready to merge, only when GitHub reports the exact commit clean.
- Mergeable, checks not passing, when GitHub allows a merge while non-required checks fail or wait.
- Blocked, with the reasons GitHub exposes. These may include draft state, conflicts, an outdated branch, changes requested, missing review or required checks, and non-required checks marked `(not required)`. A generic branch-protection reason appears when GitHub supplies no cause.
- In merge queue.
- Unknown, while GitHub computes mergeability or after a lookup failure.

Reasons link to the check or PR. Readiness uses one read-only GraphQL query during existing PR refreshes, including Sync now, polling, import, page-open freshness checks and refreshes before review or preview. It has no separate timer, and an ordinary page load without a freshness check does not fetch it.

The app stores the result with its head commit and check time. A snapshot for an older head appears as `Stale, was ...` until the next check. A failed same-head lookup becomes Unknown with its failure and time; any previous result appears only as a timestamped `Last known: ...` line.

The next successful check replaces that failure. Lookup failures never block the rest of a sync. Older databases start with an empty `merge_readiness` table and show Not checked yet until each PR refreshes, without a retroactive fetch.

Ready requires complete, coherent evidence for the exact head. The app records Unknown with a reason for mismatched heads or latest commits, closed or merged PRs, partial GraphQL errors, or truncated check lists under `CLEAN`. It also refuses `CLEAN` or `UNSTABLE` reports that conflict with draft state, merge conflicts or failed or pending required checks.

## Review drafts

Every successful full review creates an editable draft once from that run's immutable result. You can also create a local draft by hand without a review. Every draft has its own optimistic save version, and previews and submissions identify the exact draft.

Opening a PR shows the newest successful full review's draft, ordered by run creation. Failed or in-progress reviews do not hide the latest completed draft, and editing an older draft does not make it current. Older drafts remain selectable in the draft selector and Runs card, labeled by review number, commit and save version.

A review that finishes while you edit adds and offers its new draft without switching or resetting your editor. Revision proposals stay bound to their source draft and version. A stale draft cannot be submitted just because a newer draft exists.

### Draft status

Inbox status and counts follow the latest draft. Outdated means that draft targets a different commit from the current head. A PR with no draft stays Unreviewed through new commits and closure; closing, merging or editing PR metadata on the reviewed commit keeps its draft Ready.

Startup derives Unreviewed, Ready and Outdated from the latest draft. This corrects older databases that marked closed PRs without drafts Outdated.

### Overview, body and evidence

A draft separates the private overview, the GitHub review body and private finding evidence. Findings anchor to the new or old side and to one line or a range within a single hunk. Older databases receive new-side, single-line defaults, and drafts predating local drafts retain their review run.

The overview is a private engineering summary grounded in the code. It is read-only, never posted and unchanged by ordinary draft saves. Only a review result or accepted AI revision replaces it.

The app stores and renders the skill's complete overview Markdown without adding sections or rewriting older overviews. A skill can include ticket intent, changes, fulfilled or partial coverage, missing or unverified items, and a note that no ticket context was available. All headings and bullets remain intact.

The GitHub review body is editable and posted verbatim, followed by any body-only findings. Finding evidence is private verification support from the review result, rendered read-only like the overview and body. Ordinary edits preserve it, and no submission payload includes it.

Reviews completed before overview support have an empty overview. The page states that it is absent rather than offering an editor. A new full review produces one.

### Older draft migrations

On startup, the previous single draft retains its ID, version, findings and text. Its summary becomes the review body, with an empty overview. Every other completed review run receives a draft from its stored result.

The newest full-review draft determines inbox status, finding counts and last-reviewed time, while queued and failed states remain. Submitted survives only when a successful submission names that latest draft at its current save version and head.

A previously revised draft may point to its AI revision run. The migration reattaches it to a full review only when exactly one completed review on the same commit finished before the revision and has no draft. The accepted proposal retains revision lineage.

If that lineage is ambiguous, the draft stays attached to the revision run and appears after full-review drafts as a legacy revised draft. It does not count as another full review. The migration is idempotent and never regenerates or reruns reviews.

## Selecting code, Ask AI, and manual comments

The Diff card shows the current diff at the PR's current head, not the snapshot behind your open draft. Select text directly or use the line-number gutter. Click a line number, then Shift-click or drag to extend; with the keyboard, focus a number, press Enter and use Shift with the arrow keys.

An in-flow panel appears beneath the highlighted selection with its file, side, range and exact `base..head` commits. A selection must stay within one file. It may span hunks for reading, but an inline comment must stay within one hunk.

### Ask AI

The panel offers Explain, Investigate, Draft comment and Add comment. New Ask AI threads capture the explicitly saved execution settings and selected base, head and range. Isolated questions invoke Main only, without the full skill or Additional reviewers; Docker and Dangerous use their selected native harness.

Supported retries and follow-ups retain the original thread's capture and permissions. Archived unsupported captures fail with instructions to save current Settings and start an independent question. Answers remain private, with code-grounded bullets and citations.

Questions have their own single-slot queue, cancellation and persistent interruption state. Dangerous native tools remain unrestricted regardless of app publishing controls.

### Add a comment

Draft comment returns an author-facing comment, severity and private evidence. Edit it in the composer, choose Add to draft and then use Save draft. The finding appears with read-only evidence and a Suggested by Ask AI marker.

Add comment opens the same composer empty. Both actions add to the open draft's unsaved edits without discarding other text. Nothing reaches GitHub until you submit the review.

The composer identifies whether the comment attaches to the new side, old side or review body. Inline comments cover one line or a range within one hunk. Mixed removed and added lines require a side choice; selections spanning hunks or lacking line numbers can only go in the body.

Findings carry a side and optional start line. Exact preview shows `path:start-line`, the side and multi-line for inline ranges. A comment outside the current diff on that side goes into the body, labeled `path:line (old)` for an old-side anchor.

### Local drafts and changed heads

Comments do not require an AI review. If no draft is open, Add to draft creates one local draft for the current head, with no review run or overview and no change to last-reviewed time. It is labeled Local draft in the selector and Status card and counts as the latest draft for inbox status and Outdated checks.

Only one local draft exists per head. If the open draft targets an older commit than your selection, the composer offers a compatible draft or a new local draft instead of attaching silently. Save or discard unsaved edits before either action.

If the PR head changes while a selection is open, the app clears the selection with a note. Its thread remains readable in the Questions card.

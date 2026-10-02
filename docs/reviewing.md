# Reviewing pull requests

Start with the [installation guide](../README.md#install-build-and-run) and [execution settings](execution-modes.md). This guide covers review work, automation and retained history. Run any shell commands below from the repository root.

- [Inbox](#inbox-groups-and-ordering) and [merge readiness](#merge-readiness).
- [Drafts](#review-drafts), [Ask AI and comments](#selecting-code-ask-ai-and-manual-comments), and [output and progress](#review-output-and-progress).
- [Draft-review automation](#automation-controls), [automatic submission](automatic-submission.md) and [concurrency](#review-concurrency).
- [Safe fixtures and operational limits](#safe-fixtures-and-operational-limits).

## Automation controls

Settings has four independent global defaults, grouped into polling and auto-review pairs. These control private drafts, not permission to publish. The separate [default-off author/action publication policy](automatic-submission.md) enables neither pair:

- Poll for new commits refreshes every tracked open PR on the poll interval. It keeps stale indicators and new-commit lists current without an open detail page.
- Auto-review new commits queues a `new_commits` review when a polled head changes. Title and description edits do not count, and this policy acts only while commit polling is on.
- Poll for review requests lists the repository's open PRs and records requests addressed to you or your current teams, including same-commit re-requests. It refreshes tracked PRs so closed PRs and removed requests without an import or successful review/submission history leave the inbox. Only matching or already tracked PRs are fetched in full; unrelated open PRs are never imported or diffed.
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

Inbox rows and the PR action area show **Unqueue** for each observed queued full review or AI revision. It removes only that job from dispatch, retaining history. If it started meanwhile, the app reports the running-state conflict; Unqueue never becomes cancellation.

**Cancel review** opens an explicit confirmation for the observed running job and head. Cancellation pending means a request was accepted, not that execution stopped. Cancellation confirmed requires owned shutdown. Shutdown unconfirmed retains the slot and same-PR exclusion, with the error visible; restart does not manufacture confirmation. These actions preserve drafts, proposals, questions and submission history, pause automatic app publication through the existing PR hold and suppress automatic requeue of that exact head across restart. Explicit Review/Re-review and intended new-head automation remain available. Nothing undoes Dangerous native effects or already-dispatched publication. See [precise controls and limits](review-controls.md).

## Inbox groups and ordering

The inbox contains open PRs that request your review, request a review from one of your teams, were imported by URL or have a successful full review or confirmed submission saved locally. Each appears once in one of three collapsible groups:

- Requested of you includes PRs with a known direct request now or in their locally recorded history, including requests addressed to both you and a team.
- Requested of your teams includes PRs with a known request to one of your teams now or in their locally recorded history, but no known direct request. Team membership is checked when the request is observed.
- Other tracked PRs includes imported or previously reviewed/submitted PRs without known personal/team request provenance and legacy requested rows whose request type is not yet known.

Completing a review or removing the current GitHub request does not move a retained PR out of its historical requested group. A known personal request takes precedence over a team request, even if they were observed separately, so each PR still appears only once. This changes grouping, not inbox eligibility.

Closed and merged PRs leave the inbox and stop being polled. PRs with removed requests do too unless imported by URL or retained by successful review/submission history. Open reviewed/submitted PRs remain tracked across new commits and restarts; manual sync and enabled polling continue refreshing them until closed or merged. Retention is derived from completed full-review runs with a result or confirmed successful local submissions on any head. Page visits, local drafts alone, AI revisions, failed/incomplete runs and unrelated legacy fetched rows do not qualify. No automation settings change. Their runs, drafts, questions and submissions remain readable at their PR URLs and are never deleted.

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

Current request provenance is `direct`, `team` or `both`, read from GitHub's requested reviewers and your team membership on each request sync. The current flag and provenance clear when the request disappears or the PR closes. Separately recorded historical provenance accumulates genuine known direct/team requests and survives request removal, sync, new commits, closure and restart. If a retained PR reopens, it returns to its historical group. Commit-only polls, freshness checks and other refreshes that do not read requests cannot erase that history.

On upgrade, historical provenance is backfilled only from typed current requests and immutable local run snapshots that actually recorded a request with known `direct`, `team` or `both` provenance. A successful review or submission alone, an import, an untyped request event or an author's team membership is not evidence of who was requested. Already-erased request types with no such snapshot cannot be recovered locally; these PRs stay in Other tracked PRs until genuine request provenance is observed on an ordinary request sync. The migration makes no GitHub or historical timeline requests, queues no reviews and changes no drafts or automation.

Databases predating current provenance still gain empty `request_source` and `created_at` columns. Requested rows with no known provenance appear under Other tracked PRs with `requested, type unknown` until a request sync records their provenance. The next PR refresh fills creation time; nothing is inferred from the author or title.

Importing an open PR by URL marks it `imported`, even if already tracked or requested. That mark survives refreshes, polls and request removal. Closed or merged imports fail with a clear error while preserving existing history.

Running a review, opening a page or having a draft never counts as an import. Older databases add `imported` with every row unmarked because previous versions recorded no import provenance and could import unrelated PRs through broad polling.

On upgrade, those unrequested rows without successful full-review or confirmed submission history leave the inbox and polling but retain their full history at their PR URLs. Import the same URL to track an open PR again without creating a duplicate. The migration queues no review and changes no draft. See the [import and sync lifecycle](sync-lifecycle.md) for operation status and request coalescing.

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

Begin editing waits for server-recorded edit intent before any typing, finding or verdict change. Pending or failed intent leaves controls read-only. That draft stays manual-only after discard, reload or restart, including when typing was never saved. A confirmed previously submitted draft can be edited and saved normally; its earlier immutable payload remains in submission history. Intent cannot cancel an already-dispatched write, and the same automatic version stays locked while its write is in flight or uncertain.

Opening a PR shows the newest successful full review's draft, ordered by run creation. Failed or in-progress reviews do not hide the latest completed draft, and editing an older draft does not make it current. Older drafts remain selectable in the draft selector and Runs card, labeled by review number, commit and save version.

A review that finishes while you edit adds and offers its new draft without switching or resetting your editor. Revision proposals stay bound to their source draft and version. A stale draft cannot be submitted just because a newer draft exists.

### Draft status

Inbox status and counts follow the latest draft. Outdated means that draft targets a different commit from the current head. A PR with no draft stays Unreviewed through new commits and closure; closing, merging or editing PR metadata on the reviewed commit keeps its draft Ready.

Startup derives Unreviewed, Ready and Outdated from the latest draft. This corrects older databases that marked closed PRs without drafts Outdated.

### Overview, body and evidence

A draft separates the private overview, the GitHub review body and private finding evidence. Findings anchor to the new or old side and to one line or a range within a single hunk. Older databases receive new-side, single-line defaults, and drafts predating local drafts retain their review run.

The overview is a private engineering summary grounded in the code. It is read-only, never posted and unchanged by ordinary draft saves. Only a review result or accepted AI revision replaces it.

New review and revision inputs include the immutable run's captured PR title, description and branch names as delimited, explicitly untrusted data. Ticket references and acceptance text come from that capture, not later PR edits or Settings changes. Missing or empty metadata remains missing or empty; the app invents no ticket criteria. Pinned base/head commits and the prohibition on resolving the live PR remain unchanged. This does not add a ticket lookup or verify live provider access, and it does not regenerate historical overviews or drafts.

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

## Review output and progress

[Output contract 1.0](review-output.md) and `npm run check:review-output < candidate.json` use the same validator as final ingestion. Current native adapters expose the read-only `check_review_output` tool. Passing the format check proves neither correctness nor permission to publish.

Custom overview Markdown and optional anchor defaults remain supported. Each result requires a complete authoritative native stream and valid canonical output. Malformed, truncated or oversized results never count as success.

Execution records checkout, `workflow` and finalize phases, plus the captured per-entry Isolated evidence. Main receives Additional failures, which also appear in private rationale; Main failure creates no draft. Historical `claude` and `codex` phases remain display-only.

Progress labels exclude prompts, reasoning, raw command arguments, credentials and tool output. Bounded activity and actual timestamps persist across reloads and restarts. The app does not invent completion estimates.

## Safe fixtures and operational limits

Use a labeled demo or mock server on its own loopback port, with disposable HOME and data. Ordinary demo mode refuses native Isolated and Dangerous dispatch unless code-injected inert fixtures replace it. It does not substitute a single-review fixture for configured roles.

The labeled web mock uses `VITE_MOCK_API=1` and covers Settings states through [documented URL parameters](../API_CONTRACT.md#web-implementation-on-these-contracts). Never submit a real GitHub review for a test.

PR content is untrusted. App checkout preparation pins the exact base and head and disables Git hooks, templates and global configuration. Native harnesses start outside the PR checkout and do not inherit PR agent configuration.

Isolated Harnesses permits only bounded source and library reads, the canonical checker and captured audited gateway tools. Docker adds OS and container enforcement for explicitly approved code and excludes PR agent configuration from its writable copy. Dangerous removes the app's native-tool restrictions.

Manual app publishing requires a fresh exact preview and explicit confirmation. Separately saved [future automatic-publication consent](automatic-submission.md) is the narrow exception, with fresh discussion/head and authority gates. The app reconciles uncertain writes instead of retrying automatically. Cancellation tracks process ownership but cannot contain malicious detached host descendants.

Optional launchd installation is never automatic, and any installed service must remain loopback-only. The newcomer setup installs no login service, configures no credentials, enables no polling and publishes no reviews.

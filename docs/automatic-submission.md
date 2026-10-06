# Automatic submission

Automatic submission is repository-specific, optional and Off with an empty author table on a new installation. It is separate from polling and automatic draft reviews. Saving consent starts no reviews or polling and publishes no backlog. Manual exact preview/submit remains available for every author, including while automatic publication is held.

## Author and action consent

In Settings > Automation, add exact PR-author GitHub usernames, select Comment / Approve / Request changes separately, turn Automatic submission On, inspect the complete future policy and explicitly confirm before Save. New rows grant nothing. Matching is trimmed, case-insensitive and exact within the configured repository, not a prefix/team/organization match. Usernames are 1-39 ASCII letters/digits or single internal hyphens; no `@`, URL, whitespace or duplicate normalized names. At most 100 rows; invalid tables reject as a whole without a live lookup.

- Comment permits the actual `COMMENT` verdict only when the immutable result has no blocking findings, even excluded ones.
- Approve permits a real GitHub `APPROVE`.
- Request changes permits the distinct `REQUEST_CHANGES` action.

The app never relabels a generated verdict to fit consent. Every enabled Save requires fresh confirmation and invalidates prior publication provenance, including an unchanged Save. Off or removing an action revokes future authority after Save. Repository changes reset this policy to Off/empty and fence old PR generations; switching back cannot recover old consent.

## Which drafts qualify

Only successful full reviews automatically queued **after** saved consent qualify. The immutable enqueue capture names repository, policy version/time, author/actions, PR generation and output contract 1.1. Publication requires the latest untouched version-1 draft on the latest open head, identical to its immutable result. Manual reviews, local drafts, AI revisions, historical or pre-rollout reviews, queued/in-flight pre-rollout jobs and saved or unsaved edits stay manual. No detection availability or clear certificate is required.

Only the draft identified by the server's `eligible` status requires Begin editing and a server acknowledgment before typing, finding/verdict mutation or code-comment composition. Other statuses (`off`, `not_authorized`, `manual_only`, `human_review_requested`, `failed`, `uncertain`, `held`, `submitted`) need no new pre-edit hold, including evidence pauses and previously submitted or historical drafts. Direct edit-intent requests for ineligible drafts are idempotent no-ops, not new authority.

An existing manual-only hold remains permanent even if publication is later disabled, and the editor still says Editing is recorded. It survives discard, Save, reload and restart. Saved edits advance the version and record a save-time hold; accepted revisions also hold their source draft. Eligibility still excludes every edited version. A later full review creates a separate draft without overwriting edits. Confirmed submitted drafts remain editable without changing the saved remote payload. Version conflicts and exact automatic versions still submitting or uncertain refuse editing before any hold or no-op, regardless of eligibility or an existing hold. If intent wins before dispatch, no write occurs. Intent cannot cancel a dispatched write.

## Same-pass human requests

Every full review receives a frozen `DiscussionSnapshot` of conversation comments, review bodies and inline discussions as explicitly untrusted data. Output [contract 1.1](review-output.md) carries `humanReviewRequest` in that same configured generation pass. There is no independent classifier, detection-only review, extra model call, mode restriction or Check prerequisite. Existing Main/Additional or skill-native orchestration and tools stay unchanged.

A valid nonempty observation binds exact source kind/id/version, User/participant author, verbatim quote and captured URL to that supplied context. Consider relevant participants including the author; exclude bots, unknown attribution and verified app publications. App provenance requires confirmed writer/review/inline identity and exact payload, never username or matching prose alone. The deterministic checks establish source identity, not semantic intent. Quotations, negation, multilingual context and relevance remain the reviewer's judgment, evaluated with labeled fixtures rather than a model-quality guarantee.

Found evidence displays the amber hand **Human review requested** badge in Inbox and detail and blocks automatic publication. Evidence, source-version deduplication and acknowledgments survive new commits, restart, source edits/deletion and resolved/outdated threads. Empty or unavailable observations never erase a known request. Resolve/dismiss every exact evidence version, then explicitly **Resume for later reviews**. No fresh clear check is required. Resume advances the PR generation, grants no action, clears no edit or uncertain-write hold and queues/publishes nothing. Unchanged acknowledged versions do not retrigger; new or changed source/context versions pause again.

Null, missing, malformed or unknown-version extensions on otherwise core-valid reviews are **Human-request detection unavailable**, nonblocking, not absence or a fabricated hold. Incomplete/unread discussion is honestly unavailable; source-backed requests from available sources still hold. Ordinary refreshes that observe changed discussion mark detection unavailable for unseen content without another model pass. Stored classifier checks remain readable history, never publishing gates.

**Protection given up:** publication no longer waits for an independent, tool-disabled, complete and clear human-request scan. The same review pass can miss a contextual/multilingual request or unavailable comment, allowing an authorized publication. This does not make Dangerous native tools tool-free or prevent their direct side effects.

## Freshness and exact writing

After awaited reads, the server rechecks saved consent, author/action, generation, known requests, persistent edit holds, successful immutable result, latest draft/id/version, open head and competing jobs/submissions. Detection unavailability does not weaken these mechanical checks. Fresh writer/review inventory and the head/diff feed the existing canonical preview builder; body, anchors and actual verdict are unchanged. Private overview, rationale, human observations and finding evidence never enter GitHub payloads.

Before the network write, persist the exact preview, writer identity, complete remote identity baseline, durable attempt and PR/head claim synchronously. Any confirmed local submission, manual or automatic, suppresses another automatic write on that head across restart and same-SHA requests. A new head needs a new eligible full review. Failures identify publication, provenance or reconciliation in detail and Inbox, not a generic check-needed chore. No failed/uncertain attempt is blindly retried.

An uncertain or restart-stranded write suppresses competing publication for the PR. **Reconcile submission without reposting** only reads complete paginated review/inline evidence; it invokes no model and makes no write. Exact recovery requires the original writer, durable pre-write identity baseline, one provably new review after attempt time, exact event/head/body and every inline anchor/body. Wrong writer/event, existing identical reviews, incomplete lists, changed anchors, multiple candidates and equal/coarse timestamps remain uncertain. Historical attempts without a durable baseline cannot be upgraded by a body/commit-only match. Manual resubmission of an original preview uses the same conservative recovery without another write.

Confirmed automatic inline provenance failures remain mechanical holds until exact identity recovery succeeds. Resuming genuine evidence does not clear them or uncertain writes. A final read cannot prevent a push, comment or edit arriving afterward before GitHub accepts the payload. These are app controls, not containment of Dangerous tools.

## Upgrade preservation

The one-time local schema migration fences existing PR generations without changing saved switch/author/action choices, polling, edited drafts, captures, results, evidence, acknowledgments or submission history. Classifier-only pauses stop blocking; genuine unresolved requests and acknowledged-but-not-resumed requests remain held. Mechanical provenance and uncertain-write failures remain blockers. Pre-change queued/completed/held drafts cannot gain automatic authority and no backlog is published. Installation and production activation are separate operations, not implied by implementation or fixtures.

## Inert acceptance fixtures

Run focused `server/test/auto-submission*.test.ts`, `human-review*.test.ts`, `discussion.test.ts` and `web/src/AutoSubmission.test.tsx`, then the [repository checks](../CONTRIBUTING.md#local-workflow) once on the final tree. Mode/harness fixtures inject inert reviewer output; existing native/role fixtures independently check configured orchestration and transport. No fixture submits a real GitHub review or contacts a model/provider.

After a production build, exercise the shipped UI through real HTTP/service/SQLite with disposable HOME/data and synthetic adapters:

```sh
node --import tsx server/test/fixtures/auto-submission-browser.ts
```

The launcher prints its owned loopback URL. Commands: `manual`, `automatic`, `human`, `clear`, `unavailable`, `coverage-fail`, `intent hold|release|fail|normal`, `status`, `quit`. Start `--empty` for setup. Human/clear/unavailable generate labeled inert same-pass results, not a separate classifier. Automatic temporarily enables draft automation only within this disposable fixture and turns it off afterward. Use Settings consent, evidence resolution/resume, revision/save/reload and exact preview/Cancel; never a live submission.

The separate labeled web mock accepts `autoSubmission=human|unavailable|off-hold` and `editIntent=locked|fail|slow|stale`. Mock state does not substitute for built-backend browser proof or live compatibility.

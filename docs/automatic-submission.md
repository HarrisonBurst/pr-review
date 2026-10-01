# Automatic submission

Automatic submission is optional, repository-specific and Off with an empty author table on a new installation. It is separate from the four [polling and automatic draft-review settings](reviewing.md#automation-controls). Saving a publication policy does not enable them, start inference or publish existing drafts. Manual exact preview/submit remains available for every author, including while a human-review or detector hold is active.

## Author and action consent

In Settings > Automatic submission:

1. Enter a PR-author GitHub username and press Add.
2. Select the actions permitted for that author in the new table row, or leave every action unchecked.
3. Switch automatic submission On, inspect the future policy preview and confirm the complete author/action policy before Save.

Rows start with no permissions. Matching is trimmed, case-insensitive and exact, not a prefix or organization/team match. Usernames must contain 1-39 ASCII letters, digits or single internal hyphens, without `@`, URLs, spaces or consecutive hyphens. Duplicate normalized names and invalid rows reject the whole save; there is no live username lookup. Remove a row or turn Off and Save to revoke it. Unsaved Settings changes grant or revoke nothing.

Each action authorizes its actual verdict:

- Comment permits `COMMENT` only when the immutable full-review result has no blocking finding, even an excluded one.
- Approve permits `APPROVE`, a real GitHub approval.
- Request changes permits `REQUEST_CHANGES`, a real change-requesting review.

No action is selected implicitly, and the app never rewrites an AI verdict to an allowed action. Every enabled Save requires new explicit confirmation, including an unchanged Save. Every Save invalidates earlier publication provenance. Changing repository resets this policy to Off/empty and fences the departing repository's PR generations, so switching back cannot restore old authority.

## Which drafts qualify

Consent must exist before an automatically triggered `request` or `new_commits` full review is queued. That run immutably captures repository, policy version/time, author/actions and PR generation. Only its latest successful, untouched version-1 draft can qualify, on the current open head. Manual reviews, local drafts, revisions and historical/pre-consent drafts remain manual. A later policy Save or explicit PR re-enable applies only to subsequently queued automatic full reviews, never held backlog.

Begin editing must receive a server acknowledgment before the editor accepts typing, included/severity/verdict changes or comment composition. This creates a persistent manual-only hold on that draft, including unsaved typing. Save and accepted revisions also record a hold. Discard, reload and restart cannot clear it, but another full review can produce a separate draft without overwriting old edits.

Previously submitted drafts remain editable once their write is confirmed. Editing does not modify or undo the earlier GitHub review or its saved payload. An exact automatic draft version whose attempt is still submitting or uncertain cannot obtain an editing acknowledgment; reload or conservatively reconcile it first. If intent wins the pre-dispatch race, publication is blocked. If dispatch wins, intent cannot cancel a remote write. Draft versions and competing-write guards still apply to manual preview/submit.

## Human requests override permissions

For tracked PRs with effective automatic draft reviewing, the existing refresh path acquires actual conversation comments, review bodies and inline-thread replies regardless of author publication permissions. An explicit automatic-submission Check and the final publication gate also acquire them. Requested-reviewer flags and branch protection are not human intent.

Relevant human participants include the author by default. Known bots and verified app-generated messages are excluded, not everyone sharing the app user's login. Confirmed automatic inline messages require exact remote comment identities and payload provenance; a human copy of the same body does not qualify for exclusion. Missing attribution or unavailable provenance cannot prove a clear scan.

A bounded contextual classifier considers explicit/contextual requests, replies, quotations, code/evidence text, negation, unrelated topics, languages and injection. PR text is data, not instructions or tool authority. Positive results require an exact quote and source identity/version/permalink. Ambiguity, unsupported language/profile, missing decisions, malformed output, fetch failure or incomplete coverage pauses publication with **Auto-submit paused: check needed**, not invented human evidence.

A real request displays an amber hand and **Human review requested** beside ordinary PR status. Its author, quote, source link and revision remain in the detail card, even when author permissions are Off. Evidence survives new commits, restart, deletion, edits and resolved/outdated threads. A clear scan cannot erase it.

Resolve or dismiss each exact evidence version, then separately confirm **Re-enable for later reviews** after a fresh complete clear check. Acknowledgment alone never resumes publication or grants an action. Re-enable advances the PR generation and queues/publishes nothing. Unchanged acknowledged versions do not retrigger; new requests or changed source/context versions pause again. Private drafting and manual publication remain available, subject to ordinary head/version and competing-write checks.

## Classifier execution support

**Check automatic submission now** freshly reads the head and complete discussion and may invoke the saved Main model where the no-tools profile is supported. Re-enable also makes a fresh scan. The final automatic gate uses the immutable review run's captured Main/model/provider policy, not later Settings. These actions are not merely cached/local validation, and a successful check is not publication consent.

| Captured execution                                                                                                        | Contextual classifier                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Isolated Claude Main, `restricted-native-1`, resolved exact model and supported native Anthropic authentication reference | Admitted through the existing bounded authentication projection and a disposable no-tools invocation                           |
| Isolated Codex or Pi                                                                                                      | Check-needed before model dispatch; no verified zero-native-tool mechanism admitted                                            |
| Docker, any harness                                                                                                       | Check-needed before container execution; pinned-container-only review execution is preserved, never replaced by host execution |
| Dangerous, any harness                                                                                                    | Check-needed before model dispatch; a Dangerous capture cannot be safely reinterpreted as an Isolated/provider profile         |
| Archived, missing, contradictory or unsupported captures/authentication                                                   | Check-needed, with no fallback or guessed model/profile compatibility                                                          |

The admitted Claude invocation sets `--tools ""`, `--allowedTools ""`, strict empty MCP configuration, empty setting sources, disabled hooks/slash commands/session persistence, `dontAsk`, restricted mode and one turn before dispatch. It loads no review skill, Additional reviewer, checkout, native library, checker or provider-read tool. It deliberately omits Claude's structured-output tool option and validates the final JSON itself. The protocol additionally requires an initialization frame advertising zero tools/servers and rejects tool attempts, incomplete streams and credentials in output. The classifier has a one-minute execution limit and a 200000-byte output limit.

This is a trusted-native-CLI restriction, not host OS/process containment or a promise that arbitrary native binaries honor flags. Deterministic native/protocol fixtures prove invocation, admission and hard-denial paths, not live binary/provider compatibility, account access or model semantic accuracy. Unsupported selections never silently switch harness, provider, model or mode.

## Freshness, completeness and recovery

Discussion reads paginate conversation/review collections and every outer/nested inline page. Bounds are 20 pages per collection, including nested thread pages, 1000 sources, 20000 UTF-8 bytes per source and 200000 aggregate classifier input bytes including PR context. Cursor cycles, duplicate identities, partial GraphQL responses, changed thread/head state and overflow are incomplete. Nothing is truncated into a clear decision. Checks disclose collection pages/completeness/errors and the actual detector when available. Classification caching binds exact source/context revisions and captured reviewer settings; final publication still freshly acquires discussion and head.

After awaited work, the server rechecks saved consent, author/action, holds, latest draft/version/result, PR generation/head/state and competing jobs/submissions. It synchronously records the exact canonical preview, durable attempt and PR/head claim before the network write. Body, inline placement and verdict are unchanged; private overview, rationale and finding evidence stay private.

Any confirmed local submission, manual or automatic, suppresses further automatic publication on that head across restart and same-SHA re-requests. A new head needs a new qualifying full review. An uncertain or restart-stranded attempt pauses further writes for the PR. No exception is treated as proof of no write, and there is no blind retry.

Automatic Check can reconcile an uncertain automatic attempt from complete paginated review/inline evidence. Manual resubmission of its original preview can reconcile a manual attempt using the same exact evidence without a second write. Recovery requires the original writer, pre-write remote identity baseline, a uniquely new review after the attempt time, exact event/head/body and every canonical inline anchor/body. Wrong account/event, existing identical reviews, incomplete lists, changed anchors and multiple candidates remain uncertain. GitHub's coarse timestamps may be insufficient to prove ordering; an equal timestamp remains uncertain. Historical attempts without a durable baseline cannot be upgraded by a body/commit-only match and remain uncertain. An unresolved attempt may require external investigation; enabling consent or re-enable cannot authorize a retry.

The final fetch cannot prevent a comment, edit or push arriving afterward, before GitHub accepts the review. These controls govern app publication, not unrestricted Dangerous native tools, which can publish directly outside the app. Nothing in this feature certifies live readiness or activates a production policy.

## Inert acceptance fixtures

Run the repository's [documented checks](../CONTRIBUTING.md#local-workflow) once after relevant focused tests. Focused backend cases are `server/test/auto-submission*.test.ts`, `discussion.test.ts` and `human-review.test.ts`; the web cases are `web/src/AutoSubmission.test.tsx`.

After a normal production build, the shipped UI can be exercised against the real HTTP/service/database paths with explicitly synthetic adapters and disposable HOME/data:

```sh
node --import tsx server/test/fixtures/auto-submission-browser.ts
```

The launcher prints its owned loopback URL and reads commands from stdin: `manual`, `automatic`, `human`, `clear`, `coverage-fail`, `intent hold|release|fail|normal`, `status` and `quit`. Start with `--empty` for fresh setup. `automatic` deliberately enables draft automation only inside this fixture to produce a future review, then turns it off. Adapter write records are synthetic; no GitHub, native model/provider, authentication, setup or installed-service operation occurs. `status` reports counts rather than source/configuration bodies. Use normal UI Settings consent, edit/Save/reload and exact-preview/Cancel flows, never a real submission for testing.

The separate labeled web mock accepts `autoSubmission=human|check-needed|off-hold` and `editIntent=locked|fail|slow|stale`. Mock evidence and in-memory persistence do not substitute for the combined built-backend browser flow or live certification.

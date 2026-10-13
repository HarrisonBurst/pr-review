# Local PR Review

Local PR Review is a single-user macOS app for reviewing GitHub pull requests locally. It produces editable review drafts using a trusted skill and Claude Code, Codex or Pi. In Isolated Harnesses mode, you can configure a Main reviewer and up to eight Additional reviewers; the app runs Additional reviewers first and Main synthesizes one draft. Docker and Dangerous modes run the selected native harness with the skill's own orchestration. Immutable review runs remain separate from editable drafts, and re-reviews and AI revisions never silently replace your edits.

Select code in a PR diff to ask AI for an explanation or investigation, or request a draft comment. You can also write inline or review-body comments without running an AI review. Comments and drafts remain local until published.

Manual publishing requires a fresh preview of the exact GitHub review payload and your explicit confirmation. Separately, you can opt into a repository-specific, default-off policy for automatic submission of **untouched future automatic full-review drafts** by exact PR author and GitHub action (Comment, Approve or Request changes). Known human-review requests, editing, stale heads, changed consent and uncertain writes hold publication; a saved policy never publishes a backlog or enables reviews. See [automatic submission](docs/automatic-submission.md) for its safeguards and limits, including unavailable human-request detection.

Polling and auto-review are separate, default-off controls. You can poll for review requests addressed to you or your teams, including same-commit re-requests, and for new commits on tracked open PRs. Each matching auto-review control can then queue local review work; enabling it can catch up eligible current heads. Manual sync refreshes data without starting reviews while automation is off, and individual Review, Re-review and Ask AI actions remain available. See [reviewing](docs/reviewing.md) for inbox tracking, polling, catch-up and deduplication.

## Prerequisites

- macOS, Git, npm and Node.js 24 or newer (`package.json` requires `>=24`). Node's built-in SQLite needs no separate database service.
- The official [GitHub CLI](https://cli.github.com/) authenticated for your repository. Check with `gh auth status` and `gh repo view owner/repository`, replacing `owner/repository` with your target. The app invokes `gh` directly.
- For AI reviews and questions, install and authenticate **one** supported CLI: [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://github.com/openai/codex) or [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Install another only if your chosen skill or workflow needs it. Manual comments need no AI harness.
- Supply a trusted review skill. The default entry is `~/.claude/skills/pr-review/SKILL.md` and is not bundled. If yours differs, select an absolute Markdown entry in Settings. Its resources and output must meet the [review output contract](docs/review-output.md). Manual comments need no skill.
- Docker only if you choose Docker mode. An installed Docker alone is not enough: check the [support matrix and setup requirements](docs/docker-boundaries.md) before approving capabilities and setup.

## Install, build and run

```sh
git clone https://github.com/HarrisonBurst/pr-review.git
cd pr-review
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. The server binds to loopback by default. Keep it loopback-only; do not expose it through a tunnel or reverse proxy. Stop it with Ctrl-C. These commands do not install a login service, enable polling or submit a review.

For development, run `npm run dev` from the repository root instead: the backend listens at <http://127.0.0.1:4317> and Vite serves the UI at <http://127.0.0.1:5173>, proxying `/api` to port 4317. Changing `PR_REVIEW_PORT` alone does not change Vite's proxy. See [Contributing](CONTRIBUTING.md) for checks and labeled, credential-free UI fixtures.

On first launch:

1. Set `owner/repository` or import an open PR URL.
2. In Settings, leave automation off; choose your harness, model, trusted skill and execution mode. Explicitly Save and complete that mode's [consent requirements](docs/execution-modes.md).
3. Sync or import to read GitHub data, then start an individual Review or Re-review, ask a question, or add a manual comment. Edit and Save the local draft. For a draft marked eligible for automatic publication, wait for **Begin editing** to record its permanent manual-only hold before changing it.
4. Inspect the exact Preview payload and confirm only if you intend to publish to GitHub. A stale preview or uncertain submission must be resolved rather than blindly reposted.

By default, app data lives in `~/Library/Application Support/pr-review` and the SQLite database at `~/Library/Application Support/pr-review/pr-review.sqlite`. `PR_REVIEW_DATA_DIR` changes the data directory; `PR_REVIEW_DB_PATH` overrides **only** the database location. `XDG_DATA_HOME` changes the default data root when set. The app does not load a `.env` file: export environment variables before launching. See [configuration and storage](docs/configuration.md) for other settings, privacy, backups and troubleshooting.

## Optional automatic submission

Leave Automatic submission Off unless you intend future reviews to publish without an individual confirmation. In Settings > Automation, add exact PR-author GitHub usernames, select Comment, Approve and/or Request changes separately in each row, turn Automatic submission On, inspect the full future policy and explicitly confirm before Save. New rows grant nothing. Comment cannot publish a result with blocking findings, even excluded ones; the app never changes the generated verdict to fit consent.

Saving the policy never enables polling, starts reviews or publishes existing drafts. Human-review requests override author permissions. Once Begin editing is acknowledged for an eligible draft, it stays manual-only, even if the edits are discarded; saved edits also make drafts manual-only. Manual exact preview/submit remains available while automatic publication is held.

Human-request detection uses the same configured full-review pass in every supported mode, without a separate classifier call. Source-backed requests persist until resolved or dismissed and explicitly resumed for later reviews. Missing, malformed or unavailable observations cannot clear known requests but do not by themselves block publication. Pre-rollout drafts stay manual; freshness, consent, writer identity, exact payload and uncertain-write safeguards remain strict. Read the [automatic submission safeguards and limits](docs/automatic-submission.md) before opting in.

## Review skill basics

Select a trusted absolute `.md` entry in Settings, with its required companion resources available. The app supplies the final JSON schema and output instructions, so your skill does not need to repeat them. It should allow that output rather than insist on a prose-only final answer.

New full reviews and AI revisions use output contract 1.1: one JSON object with `overview`, `body`, `findings`, `verdict`, `rationale` and nullable `humanReviewRequest`. Markdown inside the text fields is fine; no particular headings are required. `overview`, finding `evidence` and `rationale` stay private, while `body` and included finding bodies can enter the confirmed GitHub payload.

A minimal synthetic final result, not a required skill template:

```json
{
  "overview": "The cancellation path can leave a request pending.",
  "body": "Please resolve pending requests when cancelling.",
  "findings": [
    {
      "id": "cancellation",
      "severity": "blocking",
      "path": "src/request.ts",
      "line": 14,
      "body": "Reject the pending promise before returning, or callers waiting for it never finish.",
      "evidence": "In this fictional change, the new cancellation branch returns without settling the promise.",
      "origin": "introduced",
      "included": true
    }
  ],
  "verdict": "REQUEST_CHANGES",
  "rationale": "One introduced blocking defect in cancellation.",
  "humanReviewRequest": null
}
```

The checker validates format, not this fictional diff anchor, and grants no permission to publish. Core-invalid final output fails the run instead of creating a draft or revision proposal. Missing or malformed human-request extensions are advisory unavailable detection, not failed reviews. See the [review skill guide](docs/review-output.md) for finding examples, customization and `npm run check:review-output < candidate.json`, which needs no model or running app.

## Execution and safety

Fresh unsaved Settings selects **Dangerous intent**, not permission to execute. Dangerous runs the selected host harness with full native tools, authentication and configuration; every Save requires fresh host-risk confirmation. Those tools can write files or publish directly outside the app's preview controls. Use [Isolated Harnesses or Docker](docs/execution-modes.md) when their limits suit your trusted skill: Isolated restricts native tools but is not OS/process containment; Docker requires separately approved capabilities and setup. Neither falls back to Dangerous.

Connections for Isolated and Docker use separate app-owned authorization and explicit read grants. Authentication alone grants no reviewer tools, and Connected does not prove a successful content read. See [Connections](docs/execution-modes.md#connections) before granting provider access.

PR content is untrusted. The app pins review checkouts and excludes PR-provided agent configuration, hooks and scripts from its review path. Keep the data directory private: it contains repository content, drafts and execution captures. The app's publication gates do not contain Dangerous native tools or guarantee that GitHub data cannot change after a final read. See [execution boundaries](EXECUTION_BOUNDARY.md), [trusted sources](docs/trusted-sources.md) and [automatic submission](docs/automatic-submission.md) for details.

## Documentation

- [Reviewing pull requests](docs/reviewing.md): inbox, drafts, questions, comments, polling and review controls.
- [Automatic submission](docs/automatic-submission.md): saved author/action consent, human-review holds, exact writing and uncertain-write recovery.
- [Execution and Settings](docs/execution-modes.md): modes, models, connections and archived captures.
- [Configuration and troubleshooting](docs/configuration.md): environment variables, storage and setup failures.
- [Review skill output](docs/review-output.md): JSON contract, examples and `npm run check:review-output < candidate.json`.
- [Contributing](CONTRIBUTING.md): development checks and safe fixtures. [API contracts](API_CONTRACT.md) and [execution boundaries](EXECUTION_BOUNDARY.md) describe implementation details.
- [Security reporting](SECURITY.md) and [public validation](docs/publication-readiness.md): reporting guidance and verification limits.

## License

Project code uses the [MIT license](LICENSE). The bundled seccomp component retains its [Apache-2.0 license](server/execution/LICENSE.seccomp). Dependencies and separately installed runtimes retain their own licenses.

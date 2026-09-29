# Review skill output contract 1.0

Canonical definitions: `ReviewResult` and `Finding` in `shared/contracts.ts`, `reviewSchema` and `validateReviewResult` in `server/review-output.ts` (also exported by `server/reviewer.ts`). This document versions the existing payload, not a new envelope. **Do not add a version field to old skills.** `reviewOutputVersion` and checker responses identify this contract as `1.0`. Compatible additions/defaults can extend 1.x; incompatible requirements need a separately negotiated major version, not reinterpretation of stored runs.

## Payload

Return one JSON object, without Markdown fences. Required top-level fields:

| Field       | Type   | Meaning                                                                                                  |
| ----------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `overview`  | string | Private reviewer-facing Markdown. Any headings or presentation, including an empty string. Never posted. |
| `body`      | string | Editable author-facing review body. Posted verbatim, followed by included body-only findings.            |
| `findings`  | array  | Zero or more findings below.                                                                             |
| `verdict`   | enum   | `COMMENT`, `APPROVE`, or `REQUEST_CHANGES`. A draft suggestion, never submission authority.              |
| `rationale` | string | Private reasoning/limitations. Not part of the GitHub payload.                                           |

Required finding fields:

| Field      | Type                     | Meaning                                                                                           |
| ---------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `id`       | nonempty string          | Unique within the result. Stable ids are recommended for revisions.                               |
| `severity` | enum                     | `blocking` or `non_blocking`.                                                                     |
| `path`     | string or null           | Repository-relative path for an anchor. Null means body-only.                                     |
| `line`     | positive integer or null | End line, on `side`. Null means no inline anchor.                                                 |
| `body`     | string                   | Author-facing comment. App preview prefixes severity and pre-existing status as applicable.       |
| `evidence` | string                   | Private Markdown verification support. Never posted.                                              |
| `origin`   | enum                     | `introduced` or `pre_existing`.                                                                   |
| `included` | boolean                  | Whether to include the finding in the draft's eventual payload. Excluded findings remain private. |

Optional finding fields accepted by both schema and ingestion:

- `side`: `LEFT` (old/base) or `RIGHT` (new/head). Omission defaults to `RIGHT`; null is invalid.
- `startLine`: positive integer or null. Omission defaults to null. Must not exceed a non-null `line`. Equal start/end normalizes to null (single line).
- `questionId`: string or null. Omission defaults to null. Normally omit for review skills. A string is not proof of Ask AI provenance or authorization.

`path` and `line` are required nullable fields, not omission-defaulted fields. Either null prevents an inline anchor. The format checker does not inspect the diff: preview verifies exact head, side, lines and same-hunk ranges. Unanchorable findings become body-only rather than publishing to a guessed location. Schema does not enforce cross-field range ordering or id uniqueness; the canonical validator does. Unknown legacy properties are accepted and discarded by normalization for backward compatibility; authors should use only documented fields. No coercion of numbers, enums or booleans occurs.

## Valid examples

No findings, with custom overview Markdown:

```json
{
  "overview": "# Data flow\n\nThe cache now expires after a successful refresh.",
  "body": "I found no actionable defects in the reviewed change.",
  "findings": [],
  "verdict": "COMMENT",
  "rationale": "Ticket context was unavailable."
}
```

An old-side range and a legacy single-line finding:

```json
{
  "overview": "## Behavior\nThe cancellation path changed.",
  "body": "The cancellation path can leave a pending request unresolved.",
  "findings": [
    {
      "id": "cancellation",
      "severity": "blocking",
      "path": "src/request.ts",
      "line": 14,
      "startLine": 12,
      "side": "LEFT",
      "body": "Removing this cleanup leaves the pending request unresolved.",
      "evidence": "Checked the caller and cancellation branch at request.ts:12-14.",
      "origin": "introduced",
      "included": true
    },
    {
      "id": "logging",
      "severity": "non_blocking",
      "path": null,
      "line": null,
      "body": "The existing log message omits the request identifier.",
      "evidence": "Observed in the base revision as well.",
      "origin": "pre_existing",
      "included": false
    }
  ],
  "verdict": "REQUEST_CHANGES",
  "rationale": "One introduced blocking finding."
}
```

## Checker and actionable failures

Local stdin CLI, no app server or model required:

```sh
npm run check:review-output < candidate.json
node dist/server/check-output.js < candidate.json
```

Returns `{"version":"1.0","status":"valid","diagnostics":[]}` with exit 0, or `status:"invalid"`, the first actionable diagnostic and exit 1. Examples: `verdict:"ACCEPT"` yields `result.verdict is invalid`; a string line yields `result.findings[0].line must be a positive integer or null`; an inverted range yields `result.findings[0].startLine must not exceed line`; duplicate ids yield `result.findings ids must be unique`; malformed JSON/fences yield a complete-JSON diagnostic. Fix that field and explicitly check the next candidate if desired. There is no automatic retry or repair loop.

New skill-first host runs expose **`check_review_output({candidate: string})`** through an app-owned authenticated loopback MCP tool for Claude/Codex and a pinned local Pi extension. Docker v2 exposes the same tool through the existing run-scoped MCP broker, including the existing Pi bridge. The argument is the candidate payload serialized as JSON, not a path to read or execute. Model guidance names the tool, so restricted models need no shell. Tool responses contain the same `ReviewOutputCheck`; invalid output also sets MCP `isError:true`. The tool only parses supplied bytes and calls the exact final-ingestion validator. It neither reads app state nor executes skills, publishes, approves, edits drafts or creates jobs. The CLI works on host or in a container containing the built app; managed Docker uses the broker tool, not a host executable path.

App-owned version-3 Isolated roles use this same schema/validator/checker for every Additional result and Main's final result. Additional outputs are private evidence for Main source verification and consolidation, not separate drafts. A failed Additional attempt is retained and disclosed in the private final `rationale`; invalid Main output creates no successful draft. Per-entry transport and 200,000-byte evidence limits are independent of schema validity. See the [role/capture/evidence contract](../API_CONTRACT.md#isolated-harnesses-v3-exact-fable-handoff). Focused questions use only captured Main and their existing question schema, not this full-review flow.

Archived v1 Docker and legacy sessions are display-only and cannot execute. Explicitly save current execution Settings and separately set up Docker when needed for a new session. Current adapters expose the checker; native protocol support alone does not authorize any other MCP server. See [support boundaries](../EXECUTION_BOUNDARY.md).

**Passing means format only.** It proves neither factual correctness, valid diff anchors, freshness, permission to post, nor a successful harness turn. App review input, immutable run, editable draft, revision proposal, exact preview and confirmed submit remain separate boundaries.

## Payload versus transport

The payload above is not a Claude `result` frame, Codex JSONL event, Pi assistant message, MCP result, or app HTTP response. Native harnesses wrap it in their own transport. Claude must produce one complete successful result with structured output; Codex must complete its turn with an authoritative final JSON message; Pi must finish a successful assistant message and `agent_end`. Malformed, overflowed, failed or incomplete transports still fail even when some earlier candidate passed. Questions use their own focused answer schema and do not run the full review skill or use this review-only checker to validate a question answer.

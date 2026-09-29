import { useState } from "react";
import type { Freshness, PullRequest, ReviewDraft } from "../../../shared/contracts";
import { isManual } from "../lib/draft";
import { relativeTime, shortSha } from "../lib/format";
import { Notice } from "./ui";

export const reviewBaseline = (draft: ReviewDraft | null) => draft?.headSha ?? null;

export function applicable(freshness: Freshness | null, baseline: string | null, head: string) {
  return !!freshness && freshness.baseline === baseline && freshness.head === head;
}

const firstLine = (message: string) => message.split("\n")[0] ?? "";

function CommitList({
  commits,
  truncated,
  label,
}: {
  commits: Freshness["commits"];
  truncated: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const count = commits.length;
  return (
    <details
      className="commits-disclosure"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        {open ? "Hide" : "Show"} {truncated ? `the first ${count}` : count} {label}
        {truncated && <span className="faint"> (truncated; see GitHub for the rest)</span>}
      </summary>
      <ul className="commits" aria-label="New commits" tabIndex={0}>
        {commits.map((c) => (
          <li key={c.sha}>
            <a className="mono" href={c.url} target="_blank" rel="noreferrer" title={c.sha}>
              {shortSha(c.sha)}
            </a>
            <span className="msg" title={c.message}>
              {firstLine(c.message)}
            </span>
            <span className="faint small">
              {c.author ?? "unknown"}
              {c.committedAt ? ` · ${relativeTime(c.committedAt)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function FreshnessNotice({
  pr,
  draft,
  freshness,
  checking,
  checkError,
  onCheck,
}: {
  pr: PullRequest;
  draft: ReviewDraft | null;
  freshness: Freshness | null;
  checking: boolean;
  checkError: string | null;
  onCheck: () => void;
}) {
  const baseline = reviewBaseline(draft);
  if (!baseline) return null;
  const stale = baseline !== pr.headSha;
  const known = applicable(freshness, baseline, pr.headSha) ? freshness : null;
  const error = checkError ?? known?.error ?? null;
  const retry = (
    <button type="button" className="button small" disabled={checking} onClick={onCheck}>
      {checking ? "Checking" : error ? "Retry check" : "Check now"}
    </button>
  );
  if (!stale) {
    if (!error) return null;
    return (
      <Notice tone="warn" title="Could not confirm this review is current." actions={retry}>
        {error}
      </Notice>
    );
  }
  const count = known?.commits.length ?? 0;
  const manual = !!draft && isManual(draft);
  return (
    <Notice
      tone="warn"
      title={manual ? "The latest draft targets an older commit." : "The latest review is stale."}
      actions={retry}
    >
      <div className="stack" style={{ gap: 6 }}>
        <div>
          {manual ? "Drafted on" : "Reviewed"}{" "}
          <span className="mono" title={baseline}>
            {shortSha(baseline)}
          </span>
          , the head is now{" "}
          <span className="mono" title={pr.headSha}>
            {shortSha(pr.headSha)}
          </span>
          . Re-review syncs to the latest commit first and adds a new draft; existing drafts stay
          untouched.
        </div>
        {!known && checking && <div className="muted">Checking GitHub for new commits…</div>}
        {!known && !checking && !error && (
          <div className="muted">New commits have not been checked against GitHub yet.</div>
        )}
        {known?.status === "stale" && count > 0 && (
          <CommitList
            key={`${baseline}:${pr.headSha}`}
            commits={known.commits}
            truncated={known.truncated}
            label={`new commit${count === 1 ? "" : "s"} since ${shortSha(baseline)}`}
          />
        )}
        {known?.status === "stale" && count === 0 && !error && (
          <div className="muted">GitHub listed no commits between these revisions.</div>
        )}
        {known?.status === "rewritten" && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="small muted">
              History was rewritten, so this is not a simple append onto {shortSha(baseline)}.
              {count === 0 && " GitHub returned no commits for the new head."}
            </div>
            {count > 0 && (
              <CommitList
                key={`${baseline}:${pr.headSha}`}
                commits={known.commits}
                truncated={known.truncated}
                label={`commit${count === 1 ? "" : "s"} on the new head`}
              />
            )}
          </div>
        )}
        {known?.status === "unavailable" && (
          <div className="muted">
            GitHub could not compare {shortSha(baseline)} with the current head, so the commits
            since it cannot be listed. Treat the whole head as unreviewed.
          </div>
        )}
        {error && (
          <div role="alert" className="small">
            GitHub check failed: {error}
          </div>
        )}
        {known && <div className="small faint">Checked {relativeTime(known.checkedAt)}</div>}
      </div>
    </Notice>
  );
}

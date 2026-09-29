import type { MergeBlocker, PullRequest } from "../../../shared/contracts";
import { relativeTime, shortSha } from "../lib/format";
import { mergeView, reasonText, stateLabel } from "../lib/merge";

function Reasons({ reasons, label }: { reasons: MergeBlocker[]; label: string }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="merge-reasons" aria-label={label}>
      {reasons.map((reason, index) => (
        <li key={`${reason.kind}-${index}`} data-required={reason.required}>
          {reason.url ? (
            <a
              href={reason.url}
              target="_blank"
              rel="noreferrer"
              title={reason.detail ?? undefined}
            >
              {reasonText(reason)}
            </a>
          ) : (
            <span title={reason.detail ?? undefined}>{reasonText(reason)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MergeRow({ pr, checking }: { pr: PullRequest; checking: boolean }) {
  const view = mergeView(pr);
  const pending = checking && (view.stale || !pr.mergeReadiness) && pr.state === "OPEN";
  return (
    <div className="merge-row">
      <span className="status-dot" data-tone={view.tone}>
        <span className="dot" aria-hidden="true" />
        {pending ? "Checking GitHub" : view.label}
      </span>
      <Reasons reasons={view.reasons} label="Merge blockers" />
      {pr.mergeReadiness?.checksTruncated && !view.stale && (
        <div className="small faint">
          GitHub returned a partial check list; see the PR for the rest.
        </div>
      )}
      {view.error && (
        <div
          className="small"
          role={view.stale || (view.tone === "neutral" && !view.lastKnown) ? undefined : "alert"}
        >
          {view.stale ? "Last check failed: " : ""}
          {view.error}
        </div>
      )}
      {view.lastKnown && (
        <div className="merge-last-known small">
          Last known: {stateLabel[view.lastKnown.state]}, checked{" "}
          {relativeTime(view.lastKnown.checkedAt)}
          <Reasons reasons={view.lastKnown.blockers} label="Last known merge blockers" />
        </div>
      )}
      {view.stale && (
        <div className="small faint">
          The head moved to <span className="mono">{shortSha(pr.headSha)}</span>; the next check
          refreshes it.
        </div>
      )}
      {view.checkedAt && (
        <div className="small faint">
          {view.error ? "Last check" : "Checked"} {relativeTime(view.checkedAt)} ·{" "}
          <a href={pr.url} target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        </div>
      )}
    </div>
  );
}

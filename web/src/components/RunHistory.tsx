import type { HarnessEntryEvidence, ReviewDraft, ReviewRun } from "../../../shared/contracts";
import { capturedExecution, roleText, runOutcome } from "../lib/execution";
import { formatDate, relativeTime, shortSha, verdictLabel } from "../lib/format";
import { Markdown } from "./Markdown";
import { RunStage, RunTimeline, useNow } from "./Progress";
import { Pill, RunPill, type Tone } from "./ui";

const entryTone: Record<HarnessEntryEvidence["status"], Tone> = {
  pending: "neutral",
  running: "accent",
  completed: "ok",
  failed: "danger",
  interrupted: "warn",
  skipped: "neutral",
};

export function EntryEvidence({ entries }: { entries: HarnessEntryEvidence[] }) {
  return (
    <ol className="entries" aria-label="Reviewer entries">
      {entries.map((entry) => (
        <li key={entry.id} className="entry" data-testid={`entry-${entry.id}`}>
          <div className="row between">
            <span>
              <strong>{entry.id === "main" ? "Main" : entry.id}</strong>{" "}
              <span className="small faint">
                {entry.role} · {roleText(entry)}
              </span>
            </span>
            <Pill tone={entryTone[entry.status]} live={entry.status === "running"}>
              {entry.status}
            </Pill>
          </div>
          <div className="small faint">
            {entry.startedAt ? `started ${formatDate(entry.startedAt)}` : "not started"}
            {entry.finishedAt ? ` · finished ${formatDate(entry.finishedAt)}` : ""}
            {entry.result
              ? ` · ${entry.result.findings.length} findings · ${verdictLabel[entry.result.verdict]}`
              : ""}
          </div>
          {entry.error && (
            <div className="small" style={{ color: "var(--danger)" }}>
              {entry.error}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export const triggerLabel: Record<ReviewRun["trigger"], string> = {
  request: "Review request",
  new_commits: "New commits",
  manual: "Manual review",
  revision: "AI revision",
};

export function RunHistory({
  runs,
  drafts,
  selectedId,
  headSha,
  onOpen,
  busy,
}: {
  runs: ReviewRun[];
  drafts: ReviewDraft[];
  selectedId: string | null;
  headSha: string;
  onOpen: (draftId: string) => void;
  busy: boolean;
}) {
  const ordered = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const now = useNow(ordered.some((r) => r.status === "running" || r.status === "queued"));
  if (!ordered.length) return <p className="muted small">No review runs yet.</p>;
  const latest = drafts[0] ?? null;
  return (
    <div className="runs">
      {ordered.map((run) => {
        const draft = drafts.find((d) => d.runId === run.id) ?? null;
        const editing = !!draft && draft.id === selectedId;
        const older = run.headSha !== headSha;
        const execution = capturedExecution(run.reviewer);
        return (
          <details className="run" key={run.id} data-testid={`run-${run.id}`}>
            <summary aria-label={`${triggerLabel[run.trigger]} ${run.status}`}>
              <div className="row between">
                <span className="run-title">{triggerLabel[run.trigger]}</span>
                <RunPill status={run.status} />
              </div>
              <div className="run-meta small muted">
                <span className="mono">{shortSha(run.headSha)}</span>
                <span>{relativeTime(run.finishedAt ?? run.createdAt)}</span>
                {run.result && (
                  <span>
                    {run.result.findings.length} findings · {verdictLabel[run.result.verdict]}
                  </span>
                )}
              </div>
              <RunStage run={run} now={now} />
              {(older || draft) && (
                <div className="run-badges">
                  {older && <Pill tone="warn">older commit</Pill>}
                  {draft && latest?.id === draft.id && <Pill tone="accent">latest draft</Pill>}
                  {draft && <Pill plain>draft v{draft.version}</Pill>}
                  {editing && <Pill tone="ok">editing</Pill>}
                </div>
              )}
            </summary>
            <div className="run-detail">
              <dl className="kv">
                <dt>Created</dt>
                <dd>{formatDate(run.createdAt)}</dd>
                {run.startedAt && (
                  <>
                    <dt>Started</dt>
                    <dd>{formatDate(run.startedAt)}</dd>
                  </>
                )}
                {run.finishedAt && (
                  <>
                    <dt>Finished</dt>
                    <dd>{formatDate(run.finishedAt)}</dd>
                  </>
                )}
                <dt>Execution</dt>
                <dd>
                  {execution.label} {execution.archived && <Pill tone="warn">not rerunnable</Pill>}{" "}
                  <span className="faint">{execution.note}</span>
                </dd>
                <dt>Outcome</dt>
                <dd data-testid="run-outcome">{runOutcome(run)}</dd>
                <dt>Model</dt>
                <dd>{execution.model}</dd>
                {execution.additional.length > 0 && (
                  <>
                    <dt>Additional</dt>
                    <dd>
                      {execution.additional.map((entry) => (
                        <div key={entry.id}>
                          <span className="mono">{entry.id}</span> · {roleText(entry)}
                        </div>
                      ))}
                    </dd>
                  </>
                )}
                <dt>Skill</dt>
                <dd className="mono">{execution.skill}</dd>
              </dl>
              {run.progress?.entries && run.progress.entries.length > 0 && (
                <EntryEvidence entries={run.progress.entries} />
              )}
              <RunTimeline run={run} now={now} />
              {run.error && (
                <div className="notice" data-tone="danger" role="alert">
                  <span className="grow">{run.error}</span>
                </div>
              )}
              {run.result && (
                <div className="stack" style={{ gap: 6 }}>
                  {run.result.overview ? (
                    <div className="small">
                      <Markdown source={run.result.overview} />
                    </div>
                  ) : (
                    <p className="small faint">No overview was recorded for this run.</p>
                  )}
                  <p className="summary-text small">{run.result.body}</p>
                  {run.result.rationale && <p className="small faint">{run.result.rationale}</p>}
                </div>
              )}
              {run.log && <pre className="log">{run.log}</pre>}
              {draft && !editing && (
                <div>
                  <button
                    type="button"
                    className="button small"
                    disabled={busy}
                    onClick={() => onOpen(draft.id)}
                  >
                    Open draft v{draft.version}
                  </button>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

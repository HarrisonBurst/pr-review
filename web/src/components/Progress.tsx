import { useEffect, useState } from "react";
import type {
  ReviewRun,
  RunActivity,
  RunPhase,
  RunPhaseId,
  RunPhaseStatus,
} from "../../../shared/contracts";
import { formatDuration, relativeTime } from "../lib/format";

export const phaseLabel: Record<RunPhaseId, string> = {
  sync: "Syncing latest PR",
  checkout: "Preparing pinned checkout",
  codex: "Codex cross-check",
  claude: "Claude review",
  workflow: "Selected execution",
  finalize: "Validating and saving result",
};

const phaseStatusLabel: Record<RunPhaseStatus, string> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  interrupted: "interrupted",
};

const SILENCE_MS = 60_000;
const TAIL = 3;

export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);
const isActive = (run: ReviewRun) => run.status === "running" || run.status === "queued";

const span = (start: string | null, end: string | null, now: number) => {
  const from = ms(start);
  if (from === null) return null;
  return Math.max(0, (ms(end) ?? now) - from);
};

export function livePhase(run: ReviewRun): RunPhase | null {
  if (run.status !== "running" || !run.progress) return null;
  return run.progress.phases.find((p) => p.status === "running") ?? null;
}

export function stageText(run: ReviewRun): string {
  if (run.status === "queued") return "Waiting in queue";
  if (run.status !== "running") return "";
  const live = livePhase(run);
  if (live) return phaseLabel[live.id];
  const last = run.progress?.phases.at(-1);
  if (!last) return "Starting";
  return `${phaseLabel[last.id]} ${phaseStatusLabel[last.status]}, next stage starting`;
}

export function lastActivity(run: ReviewRun): RunActivity | null {
  return run.progress?.activity.at(-1) ?? null;
}

export function RunStage({ run, now }: { run: ReviewRun; now: number }) {
  if (!isActive(run)) return null;
  const live = livePhase(run);
  const last = lastActivity(run);
  const stageMs = live ? span(live.startedAt, null, now) : null;
  const totalMs = span(run.startedAt ?? run.createdAt, null, now);
  const lastAt = run.progress?.lastActivityAt ?? null;
  const quiet = lastAt !== null && now - ms(lastAt)! > SILENCE_MS;
  return (
    <div className="run-stage" data-status={run.status}>
      <span className="run-stage-live" aria-live="polite">
        <span className="run-stage-name">{stageText(run)}</span>
        {run.status === "running" && last && (
          <span className="run-stage-activity">
            {" · "}
            {last.label}
          </span>
        )}
      </span>
      <span className="run-stage-time mono" aria-label="Elapsed time">
        {stageMs !== null && <span>{formatDuration(stageMs)} in stage</span>}
        {totalMs !== null && (
          <span>
            {formatDuration(totalMs)} {run.status === "queued" ? "waiting" : "total"}
          </span>
        )}
      </span>
      {run.status === "running" && (quiet || !lastAt) && (
        <span className="run-stage-quiet faint">
          {lastAt
            ? `No activity reported for ${formatDuration(now - ms(lastAt)!)}.`
            : "No activity reported yet."}{" "}
          Silence only means nothing was observed, not that the review is stuck.
        </span>
      )}
    </div>
  );
}

function ActivityList({ items, id }: { items: RunActivity[]; id: string }) {
  return (
    <ol className="activity" aria-labelledby={id} tabIndex={0}>
      {items.map((item, index) => (
        <li key={`${item.at}-${index}`} data-source={item.source}>
          <span className="activity-source">{item.source}</span>
          <span className="activity-label">{item.label}</span>
          <span className="activity-at faint">{relativeTime(item.at)}</span>
        </li>
      ))}
    </ol>
  );
}

export function RunTimeline({ run, now }: { run: ReviewRun; now: number }) {
  const progress = run.progress;
  const running = run.status === "running";
  const queuedMs = span(run.createdAt, run.startedAt, now);
  const totalMs =
    run.startedAt && (run.finishedAt || running) ? span(run.startedAt, run.finishedAt, now) : null;
  const activityId = `activity-${run.id}`;
  const [open, setOpen] = useState(false);
  if (!progress) {
    return (
      <div className="timeline-empty small">
        <p className="faint">
          {run.status === "queued"
            ? `Waiting in queue for ${formatDuration(queuedMs ?? 0)}.`
            : "No stage timing or harness activity was recorded for this run, so none is shown."}
        </p>
        {totalMs !== null && (
          <p className="faint">
            Total elapsed {formatDuration(totalMs)}
            {running ? " so far" : ""}.
          </p>
        )}
      </div>
    );
  }
  const tail = running ? progress.activity.slice(-TAIL) : [];
  const shown = progress.activity.length;
  return (
    <div className="timeline-wrap">
      <ol className="timeline" aria-label="Review stages">
        {run.startedAt || run.status === "queued" ? (
          <li className="phase" data-status={run.status === "queued" ? "running" : "completed"}>
            <span className="phase-mark" aria-hidden="true" />
            <span className="phase-label">Waiting in queue</span>
            <span className="phase-time mono">{formatDuration(queuedMs ?? 0)}</span>
          </li>
        ) : null}
        {progress.phases.map((phase) => {
          const live = phase.status === "running";
          const duration = live && !running ? null : span(phase.startedAt, phase.finishedAt, now);
          return (
            <li className="phase" key={`${phase.id}-${phase.startedAt}`} data-status={phase.status}>
              <span className="phase-mark" aria-hidden="true" />
              <span className="phase-label">
                {phaseLabel[phase.id]}
                {phase.status !== "completed" && phase.status !== "running" && (
                  <span className="phase-status"> {phaseStatusLabel[phase.status]}</span>
                )}
                {live && !running && <span className="phase-status"> not running</span>}
                {phase.detail && <span className="phase-detail faint"> · {phase.detail}</span>}
              </span>
              {duration !== null && (
                <span className="phase-time mono">{formatDuration(duration)}</span>
              )}
            </li>
          );
        })}
      </ol>
      {totalMs !== null && (
        <p className="small faint timeline-total">
          Total elapsed {formatDuration(totalMs)}
          {running ? " so far" : ""}.
        </p>
      )}
      {tail.length > 0 && (
        <div className="activity-tail">
          <span className="small faint" id={`${activityId}-tail`}>
            Recent activity
          </span>
          <ActivityList items={tail} id={`${activityId}-tail`} />
        </div>
      )}
      {shown > 0 ? (
        <details
          className="activity-disclosure"
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary id={activityId}>
            {open ? "Hide" : "Show"} activity
            <span className="faint">
              {" "}
              (
              {progress.activityCount > shown
                ? `last ${shown} of ${progress.activityCount}`
                : `${shown} ${shown === 1 ? "entry" : "entries"}`}
              )
            </span>
          </summary>
          <ActivityList items={progress.activity} id={activityId} />
        </details>
      ) : (
        <p className="small faint">No harness activity was observed.</p>
      )}
    </div>
  );
}

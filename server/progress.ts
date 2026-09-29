import type {
  ActivityKind,
  ActivitySource,
  RunActivity,
  RunPhase,
  RunPhaseId,
  RunPhaseStatus,
  RunProgress,
  CapturedHarnessEntry,
  HarnessEntryEvidence,
} from "../shared/contracts.js";
import { now } from "./util.js";

export const activityLimit = 40;
export const labelLimit = 120;
export const detailLimit = 200;

export interface ProgressReporter {
  phase(id: RunPhaseId, status: RunPhaseStatus, detail?: string | null): void;
  activity(source: ActivitySource, kind: ActivityKind, label: string): void;
  entry?(evidence: HarnessEntryEvidence): void;
}

export function boundedLabel(value: string, limit = labelLimit): string {
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export const emptyProgress = (): RunProgress => ({
  phases: [],
  activity: [],
  activityCount: 0,
  lastActivityAt: null,
  updatedAt: now(),
});

export function pendingEntry(
  entry: CapturedHarnessEntry,
): HarnessEntryEvidence {
  return {
    id: entry.id,
    role: entry.role,
    harness: entry.harness,
    model: entry.model,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
}

export function interruptProgress(
  progress: RunProgress,
  finishedAt: string,
): RunProgress {
  return {
    ...progress,
    phases: progress.phases.map((phase) =>
      phase.status === "running"
        ? { ...phase, status: "interrupted", finishedAt }
        : phase,
    ),
    ...(progress.entries
      ? {
          entries: progress.entries.map((entry) =>
            entry.status === "running" || entry.status === "pending"
              ? {
                  ...entry,
                  status:
                    entry.status === "running"
                      ? ("interrupted" as const)
                      : ("skipped" as const),
                  finishedAt,
                  error: "Backend stopped before this entry completed",
                }
              : entry,
          ),
        }
      : {}),
    updatedAt: finishedAt,
  };
}

export class RunProgressTracker implements ProgressReporter {
  readonly progress: RunProgress;
  private timer: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  private closed = false;

  constructor(
    private readonly flush: (progress: RunProgress) => void,
    private readonly throttleMs = 750,
    initial: RunProgress = emptyProgress(),
  ) {
    this.progress = initial;
  }

  phase(id: RunPhaseId, status: RunPhaseStatus, detail?: string | null): void {
    if (this.closed) return;
    const at = now();
    const bounded =
      detail === undefined || detail === null
        ? null
        : boundedLabel(detail, detailLimit);
    const current = this.progress.phases.find((phase) => phase.id === id);
    if (status === "running") {
      if (current && current.status === "running") return;
      this.progress.phases.push({
        id,
        status,
        startedAt: at,
        finishedAt: null,
        detail: bounded,
      });
    } else if (current) {
      current.status = status;
      current.finishedAt = at;
      if (bounded !== null) current.detail = bounded;
    } else {
      this.progress.phases.push({
        id,
        status,
        startedAt: at,
        finishedAt: at,
        detail: bounded,
      });
    }
    this.record("app", "phase", `${phaseLabel[id]} ${phaseVerb[status]}`, at);
    this.commit(true);
  }

  activity(source: ActivitySource, kind: ActivityKind, label: string): void {
    if (this.closed) return;
    const active = this.progress.entries?.find(
      (entry) => entry.status === "running",
    );
    this.record(
      source,
      kind,
      active ? `${active.role} ${active.id}: ${label}` : label,
      now(),
    );
    this.commit(false);
  }

  entry(evidence: HarnessEntryEvidence): void {
    if (this.closed) return;
    const entries = (this.progress.entries ??= []);
    const index = entries.findIndex((entry) => entry.id === evidence.id);
    if (index < 0) entries.push(structuredClone(evidence));
    else entries[index] = structuredClone(evidence);
    const label = `${evidence.role === "main" ? "Main" : "Additional"} ${evidence.id}: ${evidence.harness}/${evidence.model} ${evidence.status}`;
    const phase = this.progress.phases.find(
      (phase) => phase.id === "workflow" && phase.status === "running",
    );
    if (phase) phase.detail = boundedLabel(label, detailLimit);
    this.record("app", "phase", label, now());
    this.commit(true);
  }

  stopEntries(status: "failed" | "interrupted", error: string): void {
    for (const entry of this.progress.entries ?? [])
      if (entry.status === "pending" || entry.status === "running")
        this.entry({
          ...entry,
          status: entry.status === "pending" ? "skipped" : status,
          finishedAt: now(),
          error: error.slice(0, 4000),
        });
  }

  failRunning(detail: string): void {
    const running = this.progress.phases.find(
      (phase) => phase.status === "running",
    );
    if (!running) return;
    this.phase(running.id, "failed", detail);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  private record(
    source: ActivitySource,
    kind: ActivityKind,
    label: string,
    at: string,
  ): void {
    const entry: RunActivity = {
      at,
      source,
      kind,
      label: boundedLabel(label),
    };
    if (!entry.label) return;
    this.progress.activity.push(entry);
    if (this.progress.activity.length > activityLimit)
      this.progress.activity.splice(
        0,
        this.progress.activity.length - activityLimit,
      );
    this.progress.activityCount += 1;
    this.progress.lastActivityAt = at;
  }

  private commit(immediate: boolean): void {
    const elapsed = Date.now() - this.lastFlush;
    if (immediate || elapsed >= this.throttleMs) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.write();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.write();
    }, this.throttleMs - elapsed);
    this.timer.unref();
  }

  private write(): void {
    this.lastFlush = Date.now();
    this.progress.updatedAt = now();
    this.flush(structuredClone(this.progress));
  }
}

export const phaseLabel: Record<RunPhaseId, string> = {
  sync: "Syncing latest PR",
  checkout: "Preparing pinned checkout",
  codex: "Codex cross-check",
  claude: "Claude review",
  workflow: "Configured workflow",
  finalize: "Validating and saving result",
};

const phaseVerb: Record<RunPhaseStatus, string> = {
  running: "started",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  interrupted: "interrupted",
};

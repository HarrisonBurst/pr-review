import type { PrStatus, ReviewVerdict, RunStatus, Submission } from "../../../shared/contracts";

export const verdictLabel: Record<ReviewVerdict, string> = {
  COMMENT: "Comment",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
};

export const statusLabel: Record<PrStatus, string> = {
  unreviewed: "Unreviewed",
  queued: "Queued",
  reviewing: "Reviewing",
  ready: "Ready",
  failed: "Failed",
  outdated: "Outdated",
  submitted: "Submitted",
};

export const runStatusLabel: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  unqueued: "Unqueued",
  cancelled: "Cancelled",
};

export const submissionLabel: Record<Submission["status"], string> = {
  submitting: "Submitting",
  submitted: "Submitted",
  uncertain: "Uncertain",
  failed: "Failed",
};

export const shortSha = (sha: string) => sha.slice(0, 7);

const steps: [number, number, string][] = [
  [60_000, 1_000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [604_800_000, 86_400_000, "d"],
];

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const diff = now - new Date(iso).getTime();
  const abs = Math.abs(diff);
  if (abs < 10_000) return "just now";
  const suffix = diff < 0 ? " ahead" : " ago";
  for (const [limit, divisor, unit] of steps) {
    if (abs < limit) return `${Math.round(abs / divisor)}${unit}${suffix}`;
  }
  return `${Math.round(abs / 604_800_000)}w${suffix}`;
}

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

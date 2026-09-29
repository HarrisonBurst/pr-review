import type {
  MergeBlocker,
  MergeObservation,
  MergeReadinessState,
  PullRequest,
} from "../../../shared/contracts";
import type { Tone } from "../components/ui";
import { shortSha } from "./format";

export interface MergeView {
  tone: Tone;
  label: string;
  reasons: MergeBlocker[];
  stale: boolean;
  checkedAt: string | null;
  error: string | null;
  lastKnown: MergeObservation | null;
}

export const stateLabel: Record<MergeReadinessState, string> = {
  ready: "Ready to merge",
  unstable: "Mergeable, checks not passing",
  blocked: "Blocked",
  queued: "In merge queue",
  unknown: "Unknown",
};

const stateTone: Record<MergeReadinessState, Tone> = {
  ready: "ok",
  unstable: "warn",
  blocked: "danger",
  queued: "info",
  unknown: "neutral",
};

export function mergeView(pr: PullRequest): MergeView {
  const readiness = pr.mergeReadiness;
  if (pr.state === "MERGED")
    return {
      tone: "neutral",
      label: "Merged",
      reasons: [],
      stale: false,
      checkedAt: null,
      error: null,
      lastKnown: null,
    };
  if (pr.state === "CLOSED")
    return {
      tone: "neutral",
      label: "Closed without merging",
      reasons: [],
      stale: false,
      checkedAt: null,
      error: null,
      lastKnown: null,
    };
  if (!readiness)
    return {
      tone: "neutral",
      label: "Not checked yet",
      reasons: [],
      stale: false,
      checkedAt: null,
      error: null,
      lastKnown: null,
    };
  if (readiness.headSha !== pr.headSha)
    return {
      tone: "warn",
      label: `Stale, was ${stateLabel[readiness.state].toLowerCase()} on ${shortSha(readiness.headSha)}`,
      reasons: readiness.blockers,
      stale: true,
      checkedAt: readiness.checkedAt,
      error: readiness.error,
      lastKnown: readiness.lastKnown,
    };
  return {
    tone: stateTone[readiness.state],
    label: stateLabel[readiness.state],
    reasons: readiness.blockers,
    stale: false,
    checkedAt: readiness.checkedAt,
    error: readiness.error,
    lastKnown: readiness.lastKnown,
  };
}

export const lastKnownText = (observation: MergeObservation) =>
  `last known ${stateLabel[observation.state].toLowerCase()}`;

export const reasonText = (reason: MergeBlocker) =>
  reason.required ? reason.summary : `${reason.summary} (not required)`;

export function mergeSummary(pr: PullRequest, limit = 3): string {
  const view = mergeView(pr);
  const shown = view.reasons.slice(0, limit).map(reasonText);
  const more = view.reasons.length - shown.length;
  const suffix = view.error && !view.reasons.length ? ", last check failed" : "";
  const known = view.lastKnown ? [lastKnownText(view.lastKnown)] : [];
  return [view.label + suffix, ...shown, ...(more > 0 ? [`+${more} more`] : []), ...known].join(
    " · ",
  );
}

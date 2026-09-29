import type {
  DraftUpdate,
  Finding,
  ReviewDraft,
  ReviewResult,
  ReviewRun,
} from "../../../shared/contracts";

export const toUpdate = (draft: ReviewDraft): DraftUpdate => ({
  draftId: draft.id,
  version: draft.version,
  body: draft.body,
  findings: draft.findings.map((f) => ({ ...f })),
  verdict: draft.verdict,
});

const findingKeys: (keyof Finding)[] = [
  "severity",
  "path",
  "line",
  "startLine",
  "side",
  "questionId",
  "body",
  "evidence",
  "origin",
  "included",
];

export const sameFinding = (a: Finding, b: Finding) => findingKeys.every((k) => a[k] === b[k]);

export function sameDraft(a: DraftUpdate, b: DraftUpdate) {
  return (
    a.draftId === b.draftId &&
    a.body === b.body &&
    a.verdict === b.verdict &&
    a.findings.length === b.findings.length &&
    a.findings.every((f, i) => f.id === b.findings[i]!.id && sameFinding(f, b.findings[i]!))
  );
}

export const newFinding = (over: Partial<Finding> = {}): Finding => ({
  id: `new-${crypto.randomUUID()}`,
  severity: "non_blocking",
  path: null,
  line: null,
  startLine: null,
  side: "RIGHT",
  body: "",
  evidence: "",
  origin: "introduced",
  included: true,
  questionId: null,
  ...over,
});

export const isManual = (draft: ReviewDraft) => draft.runId === null;

export const compatibleDraft = (drafts: ReviewDraft[], headSha: string) =>
  drafts.find((d) => d.headSha === headSha) ?? null;

export type FindingChange = {
  kind: "added" | "removed" | "changed" | "same";
  finding: Finding;
  before?: Finding;
};

export const latestDraft = (drafts: ReviewDraft[]) => drafts[0] ?? null;

export const legacyRevised = (draft: ReviewDraft, runs: ReviewRun[]) =>
  runs.some((r) => r.id === draft.runId && r.kind === "revision");

export function draftLabel(
  draft: ReviewDraft,
  drafts: ReviewDraft[],
  headSha: string,
  runs: ReviewRun[],
) {
  const ordered = drafts.filter((d) => !legacyRevised(d, runs));
  const reviews = ordered.filter((d) => !isManual(d));
  const position = ordered.findIndex((d) => d.id === draft.id);
  const reviewIndex = reviews.findIndex((d) => d.id === draft.id);
  const name = isManual(draft)
    ? "Local draft"
    : reviewIndex < 0
      ? "Legacy revised draft"
      : `Review ${reviews.length - reviewIndex}`;
  const commit = draft.headSha.slice(0, 7);
  const tag =
    position === 0
      ? "latest"
      : position < 0
        ? "unresolved review"
        : isManual(draft)
          ? "older draft"
          : "older review";
  const current = draft.headSha === headSha ? "" : " · outdated commit";
  return `${name} · ${commit} · v${draft.version} · ${tag}${current}`;
}

export function compareResult(
  current: ReviewDraft | null,
  proposed: ReviewResult,
): FindingChange[] {
  const before = new Map((current?.findings ?? []).map((f) => [f.id, f]));
  const changes: FindingChange[] = proposed.findings.map((finding) => {
    const prev = before.get(finding.id);
    if (!prev) return { kind: "added", finding };
    before.delete(finding.id);
    return sameFinding(prev, finding)
      ? { kind: "same", finding }
      : { kind: "changed", finding, before: prev };
  });
  for (const removed of before.values()) changes.push({ kind: "removed", finding: removed });
  return changes;
}

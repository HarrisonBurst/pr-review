import { describe, expect, it } from "vitest";
import type { ReviewDraft } from "../../../shared/contracts";
import { drafts, runs } from "../mock/fixtures";
import { compareResult, draftLabel, sameDraft, toUpdate } from "./draft";

const draft = drafts["pr-482"]![0] as ReviewDraft;

describe("draft helpers", () => {
  it("detects edits field by field", () => {
    const base = toUpdate(draft);
    expect(sameDraft(base, toUpdate(draft))).toBe(true);
    expect("overview" in base).toBe(false);
    expect(sameDraft({ ...base, body: "x" }, toUpdate(draft))).toBe(false);
    expect(sameDraft({ ...base, draftId: "other" }, toUpdate(draft))).toBe(false);
    const toggled = {
      ...base,
      findings: base.findings.map((f, i) => (i === 0 ? { ...f, included: false } : f)),
    };
    expect(sameDraft(toggled, toUpdate(draft))).toBe(false);
  });

  it("classifies proposal changes against the draft", () => {
    const [a, b, c] = draft.findings;
    const changes = compareResult(draft, {
      overview: draft.overview,
      body: draft.body,
      verdict: draft.verdict,
      rationale: "",
      findings: [{ ...a!, body: "changed" }, b!, { ...c!, id: "brand-new" }],
    });
    expect(changes.map((x) => [x.kind, x.finding.id])).toEqual([
      ["changed", "f-1"],
      ["same", "f-2"],
      ["added", "brand-new"],
      ["removed", "f-3"],
    ]);
  });

  it("labels a draft still attached to a legacy revision run without a review number", () => {
    const list = drafts["pr-482"]!;
    const legacy: ReviewDraft = { ...list[1]!, id: "draft-legacy", runId: "rev-legacy" };
    const all = [...list, legacy];
    const history = [
      ...runs["pr-482"]!,
      { ...runs["pr-482"]![0]!, id: "rev-legacy", kind: "revision" as const },
    ];
    const head = list[0]!.headSha;
    expect(all.map((d) => draftLabel(d, all, head, history))).toEqual([
      "Review 2 · 9b8d7e2 · v3 · latest",
      "Review 1 · 1111111 · v2 · older review · outdated commit",
      "Legacy revised draft · 1111111 · v2 · unresolved review · outdated commit",
    ]);
  });
});

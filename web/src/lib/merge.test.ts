import { describe, expect, it } from "vitest";
import type { PullRequest } from "../../../shared/contracts";
import { prs, readiness } from "../mock/fixtures";
import { mergeSummary, mergeView } from "./merge";

const base = prs[0]!;
const pr = (over: Partial<PullRequest>): PullRequest => ({ ...base, ...over });
const reason = (kind: "checks_failed" | "draft", summary: string, required = true) => ({
  kind,
  summary,
  detail: null,
  url: null,
  required,
});

describe("merge readiness view", () => {
  it("labels each GitHub state with text and a tone", () => {
    expect(mergeView(pr({ mergeReadiness: readiness("ready") }))).toMatchObject({
      tone: "ok",
      label: "Ready to merge",
    });
    expect(mergeView(pr({ mergeReadiness: readiness("unstable") })).tone).toBe("warn");
    expect(mergeView(pr({ mergeReadiness: readiness("blocked") })).label).toBe("Blocked");
    expect(mergeView(pr({ mergeReadiness: readiness("queued") })).label).toBe("In merge queue");
    expect(mergeView(pr({ mergeReadiness: readiness("unknown") })).tone).toBe("neutral");
  });

  it("never shows green for another head, a missing snapshot, or a closed PR", () => {
    const stale = mergeView(
      pr({ mergeReadiness: readiness("ready", [], { headSha: "0000000abcdef" }) }),
    );
    expect(stale).toMatchObject({ tone: "warn", stale: true });
    expect(stale.label).toBe("Stale, was ready to merge on 0000000");
    expect(mergeView(pr({ mergeReadiness: null }))).toMatchObject({
      tone: "neutral",
      label: "Not checked yet",
    });
    expect(mergeView(pr({ state: "MERGED" })).label).toBe("Merged");
    expect(mergeView(pr({ state: "CLOSED" })).label).toBe("Closed without merging");
  });

  it("shows a failed lookup as unknown with the last known result labeled, never green", () => {
    const failed = readiness("unknown", [], {
      mergeStateStatus: null,
      error: "gh api graphql failed: API rate limit exceeded (HTTP 403)",
      lastKnown: {
        checkedAt: "2026-01-01T00:00:00.000Z",
        state: "ready",
        mergeStateStatus: "CLEAN",
        blockers: [],
        checksTruncated: false,
      },
    });
    const view = mergeView(pr({ mergeReadiness: failed }));
    expect(view).toMatchObject({ tone: "neutral", label: "Unknown", reasons: [] });
    expect(view.lastKnown?.checkedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(mergeSummary(pr({ mergeReadiness: failed }))).toBe(
      "Unknown, last check failed · last known ready to merge",
    );
  });

  it("summarizes multiple reasons compactly and marks optional ones", () => {
    const blocked = readiness("blocked", [
      reason("draft", "draft pull request"),
      reason("checks_failed", "2 required checks failed"),
      reason("checks_failed", "1 check failed", false),
      reason("checks_failed", "1 check pending", false),
    ]);
    expect(mergeSummary(pr({ mergeReadiness: blocked }))).toBe(
      "Blocked · draft pull request · 2 required checks failed · 1 check failed (not required) · +1 more",
    );
    expect(
      mergeSummary(pr({ mergeReadiness: readiness("unknown", [], { error: "rate limited" }) })),
    ).toBe("Unknown, last check failed");
  });
});

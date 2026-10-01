import { describe, expect, it } from "vitest";
import type { PullRequest } from "../../../shared/contracts";
import { prs } from "../mock/fixtures";
import { ageOf, compareInbox, groupOf, settled } from "./inbox";

const base = prs[0]!;
const pr = (over: Partial<PullRequest>): PullRequest => ({
  ...base,
  historicalRequestSource: null,
  ...over,
});

describe("inbox grouping", () => {
  it("assigns direct and both to you, team to teams, and everything else to other", () => {
    expect(groupOf(pr({ requested: true, requestSource: "direct" }))).toBe("direct");
    expect(groupOf(pr({ requested: true, requestSource: "both" }))).toBe("direct");
    expect(groupOf(pr({ requested: true, requestSource: "team" }))).toBe("team");
    expect(groupOf(pr({ requested: true, requestSource: "unknown" }))).toBe("other");
    expect(groupOf(pr({ requested: false, requestSource: null }))).toBe("other");
  });

  it("keeps known historical groups without a current request, with personal precedence", () => {
    for (const [source, group] of [
      ["direct", "direct"],
      ["team", "team"],
      ["both", "direct"],
    ] as const)
      expect(
        groupOf(pr({ requested: false, requestSource: null, historicalRequestSource: source })),
      ).toBe(group);
    expect(
      groupOf(pr({ requested: true, requestSource: "team", historicalRequestSource: "direct" })),
    ).toBe("direct");
    expect(
      groupOf(pr({ requested: true, requestSource: "direct", historicalRequestSource: "team" })),
    ).toBe("direct");
    expect(
      groupOf(pr({ requested: true, requestSource: "unknown", historicalRequestSource: "team" })),
    ).toBe("team");
    expect(
      groupOf(
        pr({ requested: false, requestSource: "direct", hasReviewHistory: true, imported: true }),
      ),
    ).toBe("other");
  });

  it("ages requested groups by request time and other by creation time", () => {
    expect(ageOf(pr({ requestedAt: "2026-01-02", createdAt: "2026-01-01" }))).toEqual({
      kind: "requested",
      at: "2026-01-02",
    });
    expect(ageOf(pr({ requestedAt: null, createdAt: "2026-01-01" }))).toEqual({
      kind: "opened",
      at: "2026-01-01",
    });
    expect(
      ageOf(
        pr({ requested: false, requestSource: null, requestedAt: "2026-01-02", createdAt: null }),
      ),
    ).toEqual({ kind: "opened", at: null });
  });

  it("orders ready first, then oldest age, unknown dates last, then number", () => {
    const rows = [
      pr({ id: "e", number: 5, status: "unreviewed", requestedAt: null, createdAt: null }),
      pr({ id: "d", number: 4, status: "outdated", requestedAt: "2026-01-03" }),
      pr({ id: "c", number: 3, status: "ready", requestedAt: "2026-01-04" }),
      pr({ id: "b", number: 2, status: "unreviewed", requestedAt: "2026-01-03" }),
      pr({ id: "a", number: 1, status: "ready", requestedAt: "2026-01-02" }),
    ];
    expect([...rows].sort(compareInbox).map((row) => row.id)).toEqual(["a", "c", "b", "d", "e"]);
  });

  it("treats only the Submitted status as settled", () => {
    expect(settled(pr({ status: "submitted" }))).toBe(true);
    for (const status of [
      "unreviewed",
      "queued",
      "reviewing",
      "ready",
      "failed",
      "outdated",
    ] as const)
      expect(settled(pr({ status }))).toBe(false);
  });

  it("orders settled submissions after every active status, oldest first among themselves", () => {
    const rows = [
      pr({ id: "s-old", number: 1, status: "submitted", requestedAt: "2026-01-01" }),
      pr({ id: "unreviewed", number: 2, status: "unreviewed", requestedAt: "2026-01-05" }),
      pr({ id: "s-unknown", number: 3, status: "submitted", requestedAt: null, createdAt: null }),
      pr({ id: "ready", number: 4, status: "ready", requestedAt: "2026-01-06" }),
      pr({ id: "s-new", number: 5, status: "submitted", requestedAt: "2026-01-03" }),
      pr({ id: "failed", number: 6, status: "failed", requestedAt: "2026-01-04" }),
      pr({ id: "outdated", number: 7, status: "outdated", requestedAt: "2026-01-02" }),
      pr({ id: "queued", number: 8, status: "queued", requestedAt: "2026-01-02" }),
    ];
    expect([...rows].sort(compareInbox).map((row) => row.id)).toEqual([
      "ready",
      "outdated",
      "queued",
      "failed",
      "unreviewed",
      "s-old",
      "s-new",
      "s-unknown",
    ]);
  });

  it("returns a submitted PR to active order once its status projects new action", () => {
    const active = pr({ id: "active", number: 9, status: "unreviewed", requestedAt: "2026-01-09" });
    const submitted = pr({ id: "was", number: 1, status: "submitted", requestedAt: "2026-01-01" });
    expect([active, submitted].sort(compareInbox).map((row) => row.id)).toEqual(["active", "was"]);
    for (const status of ["outdated", "ready", "queued"] as const)
      expect([active, { ...submitted, status }].sort(compareInbox).map((row) => row.id)).toEqual([
        "was",
        "active",
      ]);
  });
});

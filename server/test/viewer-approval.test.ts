import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubReviewResponse } from "../adapters.js";
import { deriveViewerApproval } from "../discussion.js";
import { fixturePrId, publicationFixture } from "./fixtures/auto-submission.js";

const head = "a".repeat(40);
const earlier = "b".repeat(40);
const review = (
  values: Partial<GithubReviewResponse> = {},
): GithubReviewResponse => ({
  id: 1,
  user: { login: "demo-user" },
  state: "APPROVED",
  submitted_at: "2026-01-01T00:00:00Z",
  commit_id: head,
  ...values,
});
const approval = { viewerLogin: "DEMO-USER", headSha: head, commitSha: head };

test("viewer approval uses the latest completed own review, not list order or pending drafts", () => {
  assert.deepEqual(
    deriveViewerApproval("DEMO-USER", [review()], head),
    approval,
  );
  assert.deepEqual(
    deriveViewerApproval(
      "DEMO-USER",
      [
        review({ id: 4, state: "PENDING", submitted_at: null }),
        review({
          id: 3,
          user: { login: "someone-else" },
          state: "CHANGES_REQUESTED",
        }),
        review({ id: 2, submitted_at: "2026-01-02T00:00:00Z" }),
        review({ state: "CHANGES_REQUESTED" }),
      ],
      head,
    ),
    approval,
  );
  for (const state of ["COMMENTED", "CHANGES_REQUESTED", "DISMISSED"])
    for (const reviews of [
      [review(), review({ id: 2, state })],
      [review({ id: 2, state }), review()],
      [
        review({ id: 2, state, submitted_at: "2026-01-02T00:00:00Z" }),
        review(),
      ],
    ])
      assert.equal(deriveViewerApproval("DEMO-USER", reviews, head), null);
});

test("earlier approvals retain the known commit while unknown applicability and attribution stay absent", () => {
  assert.deepEqual(
    deriveViewerApproval("DEMO-USER", [review({ commit_id: earlier })], head),
    { ...approval, commitSha: earlier },
  );
  assert.equal(deriveViewerApproval(null, [review()], head), null);
  assert.equal(deriveViewerApproval("demo-user", [], head), null);
  assert.equal(
    deriveViewerApproval(
      "demo-user",
      [review({ user: { login: "someone-else" } })],
      head,
    ),
    null,
  );
  for (const values of [
    { commit_id: undefined },
    { commit_id: "" },
    { commit_id: "a".repeat(7) },
    { user: null },
    { user: {} },
    { state: undefined },
    { state: "UNSUPPORTED" },
    { submitted_at: null },
    { submitted_at: "invalid" },
    { id: "invalid" },
  ])
    assert.equal(
      deriveViewerApproval(
        "demo-user",
        [review(), review({ id: 2, ...values })],
        head,
      ),
      null,
    );
  assert.equal(deriveViewerApproval("demo-user", [review()], "unknown"), null);
});

test("viewer approval persists without local submissions and clears on unknown refresh or head drift", async () => {
  const f = await publicationFixture();
  try {
    const pr = f.github.current.pr;
    pr.viewerApproval = {
      viewerLogin: "demo-user",
      headSha: pr.headSha,
      commitSha: pr.headSha,
    };
    await f.service.sync();
    assert.deepEqual(
      f.service.getDetail(fixturePrId).pr.viewerApproval,
      pr.viewerApproval,
    );
    assert.deepEqual(
      f.service.getState().prs[0]!.viewerApproval,
      pr.viewerApproval,
    );
    assert.equal(f.service.getDetail(fixturePrId).submissions.length, 0);
    assert.equal(f.service.getDetail(fixturePrId).drafts.length, 0);
    await f.restart();
    assert.deepEqual(
      f.service.getDetail(fixturePrId).pr.viewerApproval,
      pr.viewerApproval,
    );
    const cached = f.service.db.getPr(fixturePrId)!;
    f.service.db.upsertPr(
      { ...cached, headSha: "changed-head" },
      f.github.current.diff,
      false,
    );
    assert.equal(f.service.getDetail(fixturePrId).pr.viewerApproval, null);
    pr.viewerApproval = null;
    await f.service.sync();
    assert.equal(f.service.getState().prs[0]!.viewerApproval, null);
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

test("failed PR refresh and failed polling invalidate cached positives; changed or unavailable viewer cannot inherit them", async () => {
  const f = await publicationFixture();
  try {
    const pr = f.github.current.pr;
    pr.viewerApproval = {
      viewerLogin: "demo-user",
      headSha: pr.headSha,
      commitSha: pr.headSha,
    };
    await f.service.sync();
    f.github.beforeHead = async () => {
      throw new Error("SYNTHETIC refresh failure");
    };
    await f.service.checkFreshness(fixturePrId);
    assert.equal(f.service.getDetail(fixturePrId).pr.viewerApproval, null);
    f.github.beforeHead = undefined;
    await f.service.sync();
    f.github.poll = async () => {
      throw new Error("SYNTHETIC poll failure");
    };
    await assert.rejects(f.service.sync(), /SYNTHETIC poll failure/);
    assert.equal(f.service.getState().prs[0]!.viewerApproval, null);
    await f.restart();
    assert.equal(f.service.getDetail(fixturePrId).pr.viewerApproval, null);
    f.service.db.upsertPr(pr, f.github.current.diff, false);
    f.github.health = async () => ({
      user: "someone-else",
      message: "SYNTHETIC changed viewer",
    });
    await f.restart();
    assert.equal(f.service.getDetail(fixturePrId).pr.viewerApproval, null);
    f.github.health = async () => ({
      user: null,
      message: "SYNTHETIC unavailable viewer",
    });
    await f.restart();
    assert.equal(f.service.getState().prs[0]!.viewerApproval, null);
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { automationOff } from "../../shared/contracts.js";
import { backlogFixture } from "./fixtures/backlog.js";
import { deferredWork } from "./fixtures/sync-lifecycle.js";

const allOn = {
  pollCommits: true,
  reviewNewCommits: true,
  pollRequests: true,
  reviewRequests: true,
};
const prId = (number: number) => `demo/repository#${number}`;

async function disabledFixture(count = 3) {
  const f = await backlogFixture(count);
  f.service.updateSettings({ automation: automationOff });
  await f.service.sync();
  return f;
}

test("enable catches up the refreshed visible inbox with exact-head history exclusions and no batch cap", async () => {
  const f = await disabledFixture(12);
  try {
    for (const number of [43, 48, 50]) {
      await f.service.manualReview(prId(number));
      await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    }
    const draft = f.service.getDetail(prId(43)).draft!;
    f.service.updateDraft(prId(43), {
      draftId: draft.id,
      version: draft.version,
      body: "SYNTHETIC preserved edit",
      findings: draft.findings,
      verdict: draft.verdict,
    });
    const edited = f.service.getDetail(prId(43)).draft!;
    f.service.db.setPrStatus(prId(43), "failed");
    f.rows.get(44)!.pr.state = "CLOSED";
    f.rows.get(45)!.pr.state = "MERGED";
    f.rows.get(46)!.pr.requested = false;
    f.rows.get(46)!.pr.requestSource = null;
    f.service.db.clearPrRequest(prId(46));
    f.service.updateAutomation(prId(47), {
      reviewNewCommits: "off",
      reviewRequests: "off",
    });
    f.rows.get(48)!.pr.headSha = "synthetic-refreshed-head";
    await f.service.manualReview(prId(49));
    const failed = f.service.db.listJobs("queued")[0]!;
    f.service.db.updateJob(failed.id, { status: "failed" });
    f.service.db.updateRun(failed.run_id, { status: "failed" });
    f.service.db.sqlite
      .prepare("UPDATE runs SET kind = 'revision' WHERE pr_id = ?")
      .run(prId(50));
    f.service.createManualDraft(prId(51));
    f.service.updateSettings({ automation: allOn });
    await f.service.sync("scheduled");
    assert.deepEqual(
      f.service.db
        .listJobs("queued")
        .map((job) => job.pr_id)
        .sort(),
      [42, 48, 49, 50, 51, 52, 53].map(prId).sort(),
    );
    const run = f.service.db.listRuns(prId(48))[0];
    assert.equal(run.headSha, "synthetic-refreshed-head");
    assert.equal(run.trigger, "new_commits");
    assert.deepEqual(
      run.reviewer,
      JSON.parse(
        JSON.stringify(
          f.service.executor!.capture(f.service.db.getSettings().reviewer),
        ),
      ),
    );
    assert.equal(f.service.db.getRunSnapshot(run.id)!.pr.headSha, run.headSha);
    assert.equal(f.service.getDetail(prId(51)).pr.hasReviewedHead, false);
    assert.deepEqual(f.service.getDetail(prId(43)).draft, edited);
    assert.equal(
      f.service.getState().prs.filter((pr) => pr.status === "queued").length,
      7,
    );
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

test("unchanged saves, inactive polling and effective Off do not catch up; per-PR and polling enable transitions do", async () => {
  const f = await disabledFixture();
  try {
    f.service.updateSettings({ automation: { reviewNewCommits: true } });
    f.service.updateAutomation(prId(42), { reviewNewCommits: "on" });
    await f.service.sync();
    assert.equal(f.service.db.listJobs().length, 0);
    f.service.updateAutomation(prId(43), { reviewNewCommits: "off" });
    f.service.updateSettings({ automation: { pollCommits: true } });
    await f.service.sync("scheduled");
    assert.deepEqual(
      f.service.db
        .listJobs("queued")
        .map((job) => job.pr_id)
        .sort(),
      [42, 44].map(prId),
    );
    f.service.updateSettings({
      automation: { pollCommits: true, reviewNewCommits: true },
      maxConcurrentReviews: 1,
    });
    f.service.getState();
    await f.service.sync("scheduled");
    assert.equal(f.service.db.listJobs().length, 2);
    f.service.updateAutomation(prId(43), { reviewNewCommits: "inherit" });
    await f.service.sync("scheduled");
    assert.equal(f.service.db.listJobs().length, 3);
    for (const job of f.service.db.listJobs("queued"))
      await f.service.processJob(job);
    f.service.updateSettings({ automation: automationOff });
    await f.service.sync();
    f.service.updateSettings({ automation: allOn });
    await f.service.sync("scheduled");
    assert.equal(f.service.db.listJobs().length, 3);
  } finally {
    await f.close();
  }
});

test("request-only catch-up requires a current request and records only real observed request evidence", async () => {
  const f = await disabledFixture();
  try {
    f.rows.get(43)!.pr.requested = false;
    f.rows.get(43)!.pr.requestSource = null;
    f.service.db.markImported(prId(43));
    f.service.updateAutomation(prId(44), { reviewRequests: "off" });
    f.service.updateSettings({
      automation: { pollRequests: true, reviewRequests: true },
    });
    await f.service.sync("scheduled");
    assert.equal(f.service.db.listJobs().length, 1);
    const run = f.service.db.listRuns(prId(42))[0];
    assert.equal(run.trigger, "request");
    assert.equal(run.requestEventId, "synthetic-request-42");
    assert.equal(f.service.db.hasRequestEvent(run.requestEventId!), true);
    f.service.updateAutomation(prId(44), { reviewRequests: "on" });
    await f.service.sync("scheduled");
    assert.equal(f.service.db.listJobs().length, 2);
  } finally {
    await f.close();
  }
});

test("overlapping enable controls, polling and manual review share pending same-head work", async () => {
  const f = await disabledFixture();
  const gate = deferredWork();
  try {
    await f.service.manualReview(prId(42));
    f.github.beforeHead = async () => {
      gate.enter();
      await gate.promise;
    };
    f.service.updateSettings({
      automation: { pollCommits: true, reviewNewCommits: true },
    });
    await gate.entered;
    f.service.updateSettings({ automation: allOn });
    f.service.updateAutomation(prId(43), { reviewRequests: "on" });
    const sync = f.service.sync("scheduled");
    gate.resolve();
    await sync;
    await f.service.manualReview(prId(43));
    await f.service.sync("scheduled");
    assert.equal(f.service.db.listJobs().length, 3);
    for (const number of [42, 43, 44])
      assert.equal(f.service.db.listRuns(prId(number)).length, 1);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("refresh failure and disabling during refresh queue no catch-up and later observations do not retry it", async () => {
  for (const failure of [true, false]) {
    const f = await disabledFixture();
    const gate = deferredWork();
    try {
      f.github.beforeHead = async () => {
        gate.enter();
        await gate.promise;
        if (failure) throw new Error("SYNTHETIC refresh refusal");
      };
      f.service.updateSettings({ automation: allOn });
      await gate.entered;
      if (!failure) f.service.updateSettings({ automation: automationOff });
      const sync = f.service.sync("scheduled");
      gate.resolve();
      if (failure) await assert.rejects(sync, /SYNTHETIC refresh refusal/);
      else await sync;
      assert.equal(f.service.db.listJobs().length, 0);
      f.github.beforeHead = undefined;
      await f.service.sync("scheduled");
      assert.equal(f.service.db.listJobs().length, 0);
    } finally {
      gate.resolve();
      await f.close();
    }
  }
});

test("catch-up preserves normal automatic provenance, consent, author permissions and publication holds; manual backlog stays local", async () => {
  const f = await disabledFixture();
  try {
    f.save(["COMMENT"]);
    f.rows.get(43)!.pr.author = "synthetic-other-author";
    const held = f.service.db.getPublicationState(prId(44));
    held.reenableRequired = true;
    held.generation++;
    f.service.db.savePublicationState(prId(44), held);
    const consent = f.service.getState().settings.autoSubmission;
    f.service.updateSettings({ automation: allOn });
    await f.service.sync("scheduled");
    const jobs = f.service.db.listJobs("queued");
    assert.deepEqual(f.service.getState().settings.autoSubmission, consent);
    assert.deepEqual(f.service.db.getPublicationState(prId(44)), held);
    assert.deepEqual(f.service.db.listRuns(prId(42))[0].autoSubmission, {
      outputContract: "1.1",
      repository: "demo/repository",
      policyVersion: consent!.version,
      consentedAt: consent!.consentedAt,
      author: "demo-author",
      actions: ["COMMENT"],
      trigger: "new_commits",
      prGeneration: 0,
    });
    assert.equal(f.service.db.listRuns(prId(43))[0].autoSubmission, null);
    for (const job of jobs) await f.service.processJob(job);
    assert.equal(f.github.writes.length, 1);
    assert.equal(
      f.service.getDetail(prId(44)).pr.autoSubmission!.status,
      "held",
    );
    f.rows.get(42)!.pr.headSha = "synthetic-next-head";
    const remote = f.rows.get(42)!;
    f.service.db.upsertPr(remote.pr, remote.diff, remote.diffTruncated);
    const outcome = await f.service.reviewBacklog({
      selections: [{ prId: prId(42), headSha: remote.pr.headSha }],
    });
    assert.equal(outcome[0].status, "queued");
    const manual = f.service.db.listJobs("queued")[0]!;
    assert.equal(f.service.db.getRun(manual.run_id)!.autoSubmission, null);
    await f.service.processJob(manual);
    assert.equal(f.github.writes.length, 1);
    assert.deepEqual(f.service.getState().settings.autoSubmission, consent);
  } finally {
    await f.close();
  }
});

test("automatic catch-up stays in the configured queue cap and persists captures and edits across restart", async () => {
  const f = await disabledFixture(6);
  const gate = deferredWork();
  let active = 0;
  let peak = 0;
  f.reviewer.beforeResult = async () => {
    active++;
    peak = Math.max(peak, active);
    if (active === 2) gate.enter();
    await gate.promise;
    active--;
  };
  try {
    f.service.createManualDraft(prId(42));
    const draft = f.service.getDetail(prId(42)).draft!;
    f.service.updateDraft(prId(42), {
      draftId: draft.id,
      version: draft.version,
      body: "SYNTHETIC edited local draft",
      findings: draft.findings,
      verdict: draft.verdict,
    });
    const edited = f.service.getDetail(prId(42)).draft!;
    f.service.updateSettings({ automation: allOn, maxConcurrentReviews: 2 });
    await f.service.sync("scheduled");
    const captured = f.service.db.listRuns(prId(43))[0];
    await f.restart();
    assert.deepEqual(f.service.db.getRun(captured.id), captured);
    assert.equal(f.service.db.listJobs("queued").length, 6);
    f.service.queue.schedule = Object.getPrototypeOf(
      f.service.queue,
    ).schedule.bind(f.service.queue);
    f.service.queue.schedule();
    await gate.entered;
    assert.equal(f.service.db.listJobs("running").length, 2);
    assert.equal(f.service.db.listJobs("queued").length, 4);
    const completed = new Promise<void>((resolve) => {
      const stop = f.service.onChange(() => {
        if (f.service.db.listJobs("completed").length === 6) {
          stop();
          resolve();
        }
      });
    });
    gate.resolve();
    await completed;
    assert.equal(peak, 2);
    assert.deepEqual(
      f.service
        .getDetail(prId(42))
        .drafts.find((item) => item.id === edited.id),
      edited,
    );
    assert.equal(f.github.writes.length, 0);
  } finally {
    gate.resolve();
    await f.close();
  }
});

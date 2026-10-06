import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BacklogReviewPreview,
  BacklogReviewSelection,
} from "../../shared/contracts.js";
import { automationOff } from "../../shared/contracts.js";
import { createHttpServer } from "../http.js";
import { backlogFixture } from "./fixtures/backlog.js";
import { deferredWork } from "./fixtures/sync-lifecycle.js";

const selections = (preview: BacklogReviewPreview): BacklogReviewSelection[] =>
  preview.entries
    .filter((item) => item.reason === null)
    .map(({ prId, headSha }) => ({ prId, headSha }));

async function httpFixture(count = 3) {
  const f = await backlogFixture(count);
  const server = createHttpServer(f.service, f.config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    ...f,
    get service() {
      return f.service;
    },
    url: `http://127.0.0.1:${address.port}/api/backlog`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    },
  };
}

test("baseline arming stays dormant; backlog preview is read-only", async () => {
  const f = await httpFixture();
  try {
    await f.service.sync();
    assert.equal(f.service.db.listJobs().length, 0);
    const response = await fetch(f.url);
    assert.equal(response.status, 200);
    const preview = (await response.json()) as BacklogReviewPreview;
    assert.equal(preview.limit, 5);
    assert.equal(selections(preview).length, 3);
    for (const entry of preview.entries) {
      assert.deepEqual(f.service.db.getAutomationState(entry.prId), {
        commitHead: entry.headSha,
        requestsArmed: true,
      });
    }
    f.service.getState();
    await f.restart();
    assert.equal(f.service.db.listJobs().length, 0);
    assert.equal(f.reviewer.calls, 0);
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

test("HTTP accepts only explicit distinct selections bounded to five", async () => {
  const f = await httpFixture(6);
  const post = (body: unknown) =>
    fetch(f.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const items = selections(f.service.getBacklog());
    for (const body of [
      {},
      { selections: [] },
      { selections: items },
      { selections: [items[0], items[0]] },
      { selections: [null] },
      { selections: [{ ...items[0], automatic: true }] },
      { selections: [items[0]], automatic: true },
    ])
      assert.equal((await post(body)).status, 400);
    assert.equal(f.service.db.listJobs().length, 0);
    const response = await post({ selections: items.slice(0, 5) });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).map((item: { status: string }) => item.status),
      Array(5).fill("queued"),
    );
    assert.equal(f.service.db.listJobs("queued").length, 5);
    assert.equal(f.github.writes.length, 0);
    assert.equal(f.reviewer.calls, 0);
  } finally {
    await f.close();
  }
});

test("eligibility uses inbox, exact successful review history and effective overrides, not display status or drafts", async () => {
  const f = await backlogFixture(6);
  try {
    const items = selections(f.service.getBacklog());
    f.service.db.setPrStatus(items[0].prId, "failed");
    f.service.updateAutomation(items[1].prId, {
      reviewNewCommits: "off",
      reviewRequests: "off",
    });
    f.rows.get(44)!.pr.requested = false;
    f.rows.get(44)!.pr.requestSource = null;
    f.service.db.clearPrRequest(items[2].prId);
    await f.service.manualReview(items[3].prId);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    f.service.db.setPrStatus(items[3].prId, "failed");
    await f.service.manualReview(items[4].prId);
    const previous = f.service.db.listJobs("queued")[0]!;
    f.service.db.updateJob(previous.id, { status: "failed" });
    f.service.db.updateRun(previous.run_id, {
      status: "failed",
      error: "SYNTHETIC failure",
    });
    const reasons = new Map(
      f.service.getBacklog().entries.map((item) => [item.prId, item.reason]),
    );
    assert.equal(reasons.get(items[0].prId), null);
    assert.equal(reasons.get(items[1].prId), "automation_off");
    assert.equal(reasons.has(items[2].prId), false);
    assert.equal(reasons.get(items[3].prId), "reviewed_head");
    assert.equal(reasons.get(items[4].prId), null);
    f.service.updateSettings({ automation: automationOff });
    assert.equal(selections(f.service.getBacklog()).length, 0);
    assert.equal(
      (await f.service.reviewBacklog({ selections: [items[2]] }))[0].message,
      "not_tracked",
    );
  } finally {
    await f.close();
  }
});

test("local drafts and revision history do not establish a successful full review", async () => {
  const f = await backlogFixture();
  try {
    const item = selections(f.service.getBacklog())[0];
    f.service.createManualDraft(item.prId);
    assert.equal(f.service.getDetail(item.prId).pr.status, "ready");
    assert.equal(f.service.getBacklog().entries[0].reason, null);
    await f.service.manualReview(item.prId);
    const job = f.service.db.listJobs("queued")[0]!;
    await f.service.processJob(job);
    f.service.db.sqlite
      .prepare("UPDATE runs SET kind = 'revision' WHERE id = ?")
      .run(job.run_id);
    assert.equal(f.service.getBacklog().entries[0].reason, null);
  } finally {
    await f.close();
  }
});

test("head drift, closure, request removal and policy changes during refresh skip without arming or queueing", async () => {
  for (const change of [
    "head",
    "closed",
    "removed",
    "override",
    "repository",
  ] as const) {
    const f = await backlogFixture();
    try {
      const item = selections(f.service.getBacklog())[1];
      const gate = deferredWork();
      f.github.beforeHead = async () => {
        gate.enter();
        await gate.promise;
      };
      const work = f.service.reviewBacklog({ selections: [item] });
      await gate.entered;
      const remote = f.rows.get(43)!;
      if (change === "head") remote.pr.headSha = "synthetic-new-head";
      if (change === "closed") remote.pr.state = "CLOSED";
      if (change === "removed") {
        remote.pr.requested = false;
        remote.pr.requestSource = null;
      }
      if (change === "override")
        f.service.updateAutomation(item.prId, {
          reviewNewCommits: "off",
          reviewRequests: "off",
        });
      if (change === "repository")
        f.service.updateSettings({ repository: "demo/other" });
      const baseline = f.service.db.getAutomationState(item.prId);
      gate.resolve();
      const outcome = (await work)[0];
      assert.equal(outcome.status, "skipped", change);
      assert.equal(
        outcome.message,
        change === "head"
          ? "head_changed"
          : change === "override"
            ? "automation_off"
            : "not_tracked",
        change,
      );
      assert.equal(f.service.db.listJobs().length, 0);
      assert.deepEqual(f.service.db.getAutomationState(item.prId), baseline);
    } finally {
      await f.close();
    }
  }
});

test("concurrent repeated actions and polling overlap deduplicate per PR including old-head pending work", async () => {
  const f = await backlogFixture();
  try {
    const item = selections(f.service.getBacklog())[0];
    const gate = deferredWork();
    f.github.beforeHead = async () => {
      gate.enter();
      await gate.promise;
    };
    const first = f.service.reviewBacklog({ selections: [item] });
    await gate.entered;
    assert.equal(
      (await f.service.reviewBacklog({ selections: [item] }))[0].status,
      "busy",
    );
    f.github.beforeHead = undefined;
    f.service.db.setCommitHead(item.prId, "synthetic-previous-head");
    await f.service.sync();
    gate.resolve();
    assert.equal((await first)[0].status, "busy");
    assert.equal(f.service.db.listRuns(item.prId).length, 1);
    assert.equal(f.service.db.listRuns(item.prId)[0].trigger, "new_commits");
    f.rows.get(42)!.pr.headSha = "synthetic-another-head";
    await f.service.checkFreshness(item.prId);
    assert.equal(f.service.getBacklog().entries[0].reason, "busy");
  } finally {
    await f.close();
  }
});

test("backlog manual intent never publishes even with all author/action consent and switches enabled; repeats and restart preserve history", async () => {
  const f = await backlogFixture();
  try {
    f.save(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
    const item = selections(f.service.getBacklog())[0];
    const baseline = f.service.db.getAutomationState(item.prId);
    const consent = f.service.getState().settings.autoSubmission;
    const outcome = (await f.service.reviewBacklog({ selections: [item] }))[0];
    assert.equal(outcome.status, "queued");
    assert.equal(
      (await f.service.reviewBacklog({ selections: [item] }))[0].status,
      "busy",
    );
    const job = f.service.db.listJobs("queued")[0]!;
    assert.equal(f.service.db.getRun(job.run_id)!.trigger, "manual");
    assert.equal(f.service.db.getRun(job.run_id)!.autoSubmission, null);
    await f.service.processJob(job);
    assert.equal(
      (await f.service.reviewBacklog({ selections: [item] }))[0].message,
      "reviewed_head",
    );
    const draft = f.service.getDetail(item.prId).draft!;
    f.service.updateDraft(item.prId, {
      draftId: draft.id,
      version: draft.version,
      body: "SYNTHETIC manual edit",
      findings: draft.findings,
      verdict: draft.verdict,
    });
    const edited = f.service.getDetail(item.prId).draft!;
    f.rows.get(42)!.pr.headSha = "synthetic-new-head";
    const remote = f.rows.get(42)!;
    f.service.db.upsertPr(remote.pr, remote.diff, remote.diffTruncated);
    const next = selections(f.service.getBacklog()).find(
      (entry) => entry.prId === item.prId,
    )!;
    assert.ok(next);
    await f.service.reviewBacklog({ selections: [next] });
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    assert.deepEqual(
      f.service.getDetail(item.prId).drafts.find((d) => d.id === edited.id),
      edited,
    );
    assert.deepEqual(f.service.db.getAutomationState(item.prId), baseline);
    assert.deepEqual(f.service.getState().settings.autoSubmission, consent);
    assert.equal(f.github.writes.length, 0);
    assert.equal(f.service.db.listSubmissions(item.prId).length, 0);
    await f.restart();
    assert.equal(f.service.getBacklog().entries[0].reason, "reviewed_head");
    assert.equal(f.service.db.listRuns(item.prId).length, 2);
    assert.equal(f.github.writes.length, 0);
    assert.equal(
      f.service.getDetail(item.prId).drafts.find((d) => d.id === edited.id)!
        .body,
      edited.body,
    );
  } finally {
    await f.close();
  }
});

test("restart retains queued manual capture and repeats never add another run", async () => {
  const f = await backlogFixture();
  try {
    f.save();
    const item = selections(f.service.getBacklog())[0];
    await f.service.reviewBacklog({ selections: [item] });
    const run = f.service.db.listRuns(item.prId)[0];
    await f.restart();
    assert.equal(f.service.db.listRuns(item.prId).length, 1);
    assert.deepEqual(f.service.db.getRun(run.id), run);
    assert.equal(
      (await f.service.reviewBacklog({ selections: [item] }))[0].status,
      "busy",
    );
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

test("refresh and unsupported execution failures are per-selection errors and produce no work", async () => {
  const f = await backlogFixture();
  try {
    const items = selections(f.service.getBacklog());
    f.github.beforeHead = async () => {
      throw new Error("SYNTHETIC refresh refusal");
    };
    assert.equal(
      (await f.service.reviewBacklog({ selections: [items[0]] }))[0].status,
      "error",
    );
    f.github.beforeHead = undefined;
    const capture = f.service.executor!.capture.bind(f.service.executor);
    f.service.executor!.capture = (() => ({
      skillPath: "/absent/fixture.md",
      model: null,
      additionalInstructions: "",
    })) as typeof capture;
    const results = await f.service.reviewBacklog({ selections: items });
    assert.ok(
      results.every(
        (item) =>
          item.status === "error" && /supported|Settings/.test(item.message),
      ),
    );
    assert.equal(f.service.db.listJobs().length, 0);
    assert.equal(f.reviewer.calls, 0);
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

test("backlog uses the existing concurrency cap and FIFO, with no parallel scheduler", async () => {
  const f = await backlogFixture();
  const gate = deferredWork();
  let active = 0;
  let peak = 0;
  f.reviewer.beforeResult = async () => {
    active++;
    peak = Math.max(peak, active);
    gate.enter();
    await gate.promise;
    active--;
  };
  f.service.queue.schedule = Object.getPrototypeOf(
    f.service.queue,
  ).schedule.bind(f.service.queue);
  try {
    await f.service.reviewBacklog({
      selections: selections(f.service.getBacklog()),
    });
    await gate.entered;
    assert.equal(active, 1);
    assert.equal(f.service.db.listJobs("running").length, 1);
    assert.equal(f.service.db.listJobs("queued").length, 2);
    const complete = new Promise<void>((resolve) => {
      const stop = f.service.onChange(() => {
        if (f.service.db.listJobs("completed").length === 3) {
          stop();
          resolve();
        }
      });
    });
    gate.resolve();
    await complete;
    assert.equal(peak, 1);
    assert.deepEqual(
      f.service.db.listJobs().map((job) => job.pr_id),
      [42, 43, 44].map((number) => `demo/repository#${number}`),
    );
    assert.equal(f.github.writes.length, 0);
  } finally {
    gate.resolve();
    await f.close();
  }
});

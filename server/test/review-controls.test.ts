import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelReviewConfirmation,
  type PullRequestDetail,
  type ReviewJobAction,
} from "../../shared/contracts.js";
import { createHttpServer } from "../http.js";
import {
  fixturePrId as PR,
  publicationFixture,
} from "./fixtures/auto-submission.js";
import { deferredWork } from "./fixtures/sync-lifecycle.js";

const observed = (f: Awaited<ReturnType<typeof publicationFixture>>) => {
  const job = f.service.db.listJobs("queued")[0]!;
  const run = f.service.db.getRun(job.run_id)!;
  return {
    job,
    request: { runId: run.id, headSha: run.headSha } satisfies ReviewJobAction,
  };
};

for (const kind of ["review", "revision"] as const) {
  test(`unqueue is precise, durable and never dispatches a captured ${kind}`, async () => {
    const f = await publicationFixture();
    try {
      if (kind === "revision") {
        await f.service.manualReview(PR);
        await f.service.processJob(f.service.db.listJobs("queued")[0]!);
        const draft = f.service.getDetail(PR).draft!;
        f.service.revise(PR, {
          draftId: draft.id,
          draftVersion: draft.version,
          instructions: "SYNTHETIC revision",
        });
      } else await f.service.manualReview(PR);
      const { job, request } = observed(f);
      const before = f.service.getDetail(PR);
      const result = f.service.reviewJobAction(PR, job.id, "unqueue", request);
      assert.equal(
        result.runs.find((run) => run.id === request.runId)?.status,
        "unqueued",
      );
      assert.equal(
        result.pr.status,
        kind === "revision" ? "ready" : "unreviewed",
      );
      assert.deepEqual(result.drafts, before.drafts);
      assert.deepEqual(result.proposals, before.proposals);
      await f.service.processJob(job);
      assert.equal(f.service.db.getJob(job.id)?.status, "unqueued");
      assert.throws(
        () => f.service.reviewJobAction(PR, job.id, "unqueue", request),
        /unqueued/,
      );
      await f.restart();
      assert.equal(f.service.db.getRun(request.runId)?.status, "unqueued");
      assert.equal(
        f.service.getDetail(PR).pr.autoSubmission?.reenableRequired,
        true,
      );
      assert.equal(f.github.writes.length, 0);
    } finally {
      await f.close();
    }
  });

  test(`running ${kind} cancellation remains pending until the adapter settles; late output never becomes a draft or proposal`, async () => {
    const f = await publicationFixture();
    const gate = deferredWork();
    let work: Promise<void> | undefined;
    try {
      await f.service.manualReview(PR);
      if (kind === "revision") {
        await f.service.processJob(f.service.db.listJobs("queued")[0]!);
        const draft = f.service.getDetail(PR).draft!;
        f.service.updateDraft(PR, {
          draftId: draft.id,
          version: draft.version,
          body: "SYNTHETIC manual edit",
          findings: draft.findings,
          verdict: draft.verdict,
        });
        const edited = f.service.getDetail(PR).draft!;
        f.service.revise(PR, {
          draftId: edited.id,
          draftVersion: edited.version,
          instructions: "SYNTHETIC revision",
        });
      }
      const { job, request } = observed(f);
      const before = f.service.getDetail(PR);
      f.reviewer.beforeResult = async () => {
        gate.enter();
        await gate.promise;
      };
      work = f.service.processJob(job);
      await gate.entered;
      assert.throws(
        () => f.service.reviewJobAction(PR, job.id, "unqueue", request),
        /running/,
      );
      assert.throws(
        () => f.service.reviewJobAction(PR, job.id, "cancel", request),
        /confirmation/,
      );
      assert.throws(
        () =>
          f.service.reviewJobAction(PR, job.id, "cancel", {
            ...request,
            runId: "stale",
            confirmation: cancelReviewConfirmation,
          }),
        /identity/,
      );
      assert.throws(
        () =>
          f.service.reviewJobAction(PR, job.id, "cancel", {
            ...request,
            headSha: "stale",
            confirmation: cancelReviewConfirmation,
          }),
        /identity/,
      );
      const pending = f.service.reviewJobAction(PR, job.id, "cancel", {
        ...request,
        confirmation: cancelReviewConfirmation,
      });
      assert.equal(pending.runs[0]?.cancellation?.status, "pending");
      assert.equal(f.service.db.getJob(job.id)?.status, "running");
      assert.throws(
        () =>
          f.service.reviewJobAction(PR, job.id, "cancel", {
            ...request,
            confirmation: cancelReviewConfirmation,
          }),
        /pending/,
      );
      gate.resolve();
      await work;
      const result = f.service.getDetail(PR);
      assert.equal(f.service.db.getRun(request.runId)?.status, "cancelled");
      assert.equal(
        f.service.db.getRun(request.runId)?.cancellation?.status,
        "confirmed",
      );
      assert.deepEqual(result.drafts, before.drafts);
      assert.deepEqual(result.proposals, before.proposals);
      assert.deepEqual(result.submissions, before.submissions);
      await f.restart();
      assert.equal(
        f.service.db.getRun(request.runId)?.cancellation?.status,
        "confirmed",
      );
    } finally {
      gate.resolve();
      await work;
      await f.close();
    }
  });
}

test("unqueue and cancellation suppress only the stopped exact head automatically across restart; manual retry and new heads remain eligible", async () => {
  for (const action of ["unqueue", "cancel"] as const) {
    const f = await publicationFixture();
    const gate = deferredWork();
    let work: Promise<void> | undefined;
    try {
      await f.service.manualReview(PR);
      const { job, request } = observed(f);
      if (action === "cancel") {
        f.reviewer.beforeResult = async () => {
          gate.enter();
          await gate.promise;
        };
        work = f.service.processJob(job);
        await gate.entered;
      }
      f.service.reviewJobAction(PR, job.id, action, {
        ...request,
        ...(action === "cancel"
          ? { confirmation: cancelReviewConfirmation }
          : {}),
      });
      gate.resolve();
      await work;
      await f.restart();
      f.service.updateSettings({
        automation: {
          pollRequests: true,
          reviewRequests: true,
          pollCommits: true,
          reviewNewCommits: true,
        },
      });
      await f.service.sync();
      f.github.eventId = "synthetic-same-head-rerequest";
      f.service.db.setCommitHead(PR, "previous-synthetic-head");
      await f.service.sync();
      assert.equal(f.service.db.listJobs("queued").length, 0);
      await f.service.manualReview(PR);
      assert.equal(f.service.db.listJobs("queued").length, 1);
      await f.service.manualReview(PR);
      assert.equal(f.service.db.listJobs("queued").length, 1);
      const retry = observed(f);
      f.service.reviewJobAction(PR, retry.job.id, "unqueue", retry.request);
      f.github.current.pr.headSha = "synthetic-new-head";
      f.github.eventId = "synthetic-new-head-request";
      await f.service.sync();
      assert.equal(f.service.db.listJobs("queued").length, 1);
      assert.equal(
        f.service.db.getRun(f.service.db.listJobs("queued")[0]!.run_id)
          ?.headSha,
        "synthetic-new-head",
      );
    } finally {
      gate.resolve();
      await work;
      await f.close();
    }
  }
});

test("unconfirmed termination is retained, blocks its lane and survives restart without a false completion", async () => {
  const f = await publicationFixture();
  const gate = deferredWork();
  let work: Promise<void> | undefined;
  try {
    await f.service.manualReview(PR);
    const { job, request } = observed(f);
    f.reviewer.beforeResult = async () => {
      gate.enter();
      await gate.promise;
      throw new Error("SYNTHETIC signal refusal; cleanup unconfirmed");
    };
    work = f.service.processJob(job);
    await gate.entered;
    f.service.reviewJobAction(PR, job.id, "cancel", {
      ...request,
      confirmation: cancelReviewConfirmation,
    });
    gate.resolve();
    await work;
    assert.equal(f.service.db.getJob(job.id)?.status, "running");
    assert.equal(
      f.service.db.getRun(request.runId)?.cancellation?.status,
      "unconfirmed",
    );
    assert.equal(f.service.nextQueuedJob(new Set()), null);
    await f.restart();
    const run = f.service.db.getRun(request.runId)!;
    assert.equal(run.status, "interrupted");
    assert.equal(run.cancellation?.status, "unconfirmed");
    assert.equal(run.result, null);
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission?.reenableRequired,
      true,
    );
  } finally {
    gate.resolve();
    await work;
    await f.close();
  }
});

test("a finished run remains completed even during later freshness work, and cancellation cannot undo it or its confirmed write", async () => {
  const f = await publicationFixture();
  const gate = deferredWork();
  let work: Promise<void> | undefined;
  try {
    f.save();
    await f.automaticReview();
    const submission = structuredClone(f.service.getDetail(PR).submissions[0]);
    await f.service.manualReview(PR);
    const { job, request } = observed(f);
    const current = f.service.db.getPr(PR)!;
    const diff = f.service.db.getDiff(PR)!;
    f.service.db.upsertPr(
      { ...current, headSha: "synthetic-newer-head" },
      diff.diff,
      diff.truncated,
    );
    f.github.compareCommits = async () => {
      gate.enter();
      await gate.promise;
      throw new Error("SYNTHETIC freshness refusal after completion");
    };
    work = f.service.processJob(job);
    await gate.entered;
    const completed = structuredClone(f.service.db.getRun(request.runId));
    assert.equal(completed?.status, "completed");
    assert.throws(
      () =>
        f.service.reviewJobAction(PR, job.id, "cancel", {
          ...request,
          confirmation: cancelReviewConfirmation,
        }),
      /completed/,
    );
    gate.resolve();
    await work;
    assert.deepEqual(f.service.db.getRun(request.runId), completed);
    assert.deepEqual(f.service.getDetail(PR).submissions[0], submission);
    assert.equal(f.github.writes.length, 1);
  } finally {
    gate.resolve();
    await work;
    await f.close();
  }
});

test("accepted cancellation revokes future publication authority without changing settings or prior history, including uncertain and dispatched writes", async () => {
  const f = await publicationFixture();
  const gate = deferredWork();
  let work: Promise<void> | undefined;
  try {
    f.save();
    await f.automaticReview();
    const original = f.service.getDetail(PR).draft!;
    f.service.updateDraft(PR, {
      draftId: original.id,
      version: original.version,
      body: "SYNTHETIC edited published draft",
      findings: original.findings,
      verdict: original.verdict,
    });
    const draft = f.service.getDetail(PR).draft!;
    f.service.revise(PR, {
      draftId: draft.id,
      draftVersion: draft.version,
      instructions: "SYNTHETIC retained proposal",
    });
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const submitted = f.service.getDetail(PR).submissions[0]!;
    f.service.db.createSubmission(
      { ...submitted, id: "synthetic-uncertain", status: "uncertain" },
      PR,
    );
    f.service.db.createSubmission(
      { ...submitted, id: "synthetic-dispatched", status: "submitting" },
      PR,
    );
    const pr = f.service.getDetail(PR).pr;
    f.service.db.createQuestion(
      {
        id: "synthetic-retained-question",
        prId: PR,
        draftId: draft.id,
        parentId: null,
        mode: "explain",
        status: "completed",
        baseSha: pr.baseSha,
        headSha: pr.headSha,
        selection: {
          path: "synthetic.ts",
          from: { side: "RIGHT", line: 1 },
          to: { side: "RIGHT", line: 1 },
          baseSha: pr.baseSha,
          headSha: pr.headSha,
          oldPath: null,
          snippet: "SYNTHETIC",
          kinds: { add: true, del: false, ctx: false },
          spansHunks: false,
          anchors: { RIGHT: { startLine: 1, line: 1 } },
        },
        question: "SYNTHETIC saved question",
        answer: {
          kind: "answer",
          answer: "SYNTHETIC prior answer",
          followUps: [],
        },
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: new Date().toISOString(),
      },
      "SYNTHETIC",
      false,
    );
    await f.service.manualReview(PR);
    const { job, request } = observed(f);
    const before = f.service.getDetail(PR);
    const settings = structuredClone(f.service.db.getSettings());
    const generation = before.pr.autoSubmission!.generation;
    f.reviewer.beforeResult = async () => {
      gate.enter();
      await gate.promise;
    };
    work = f.service.processJob(job);
    await gate.entered;
    f.service.reviewJobAction(PR, job.id, "cancel", {
      ...request,
      confirmation: cancelReviewConfirmation,
    });
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission!.generation,
      generation + 1,
    );
    assert.deepEqual(f.service.db.getSettings(), settings);
    gate.resolve();
    await work;
    const after = f.service.getDetail(PR);
    assert.deepEqual(after.drafts, before.drafts);
    assert.deepEqual(after.proposals, before.proposals);
    assert.deepEqual(after.questions, before.questions);
    assert.deepEqual(after.submissions, before.submissions);
    assert.deepEqual(
      after.runs.filter((run) => run.id !== request.runId),
      before.runs.filter((run) => run.id !== request.runId),
    );
    assert.equal(f.github.writes.length, 1);
    assert.equal(after.pr.autoSubmission!.reenableRequired, true);
  } finally {
    gate.resolve();
    await work;
    await f.close();
  }
});

test("exact HTTP actions, SSE/reload pending and confirmed state retain edited drafts and manual preview", async () => {
  const f = await publicationFixture();
  const server = createHttpServer(f.service, f.config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const prefix = `/prs/${encodeURIComponent(PR)}`;
  const post = (suffix: string, body: unknown) =>
    fetch(`${base}${prefix}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const gate = deferredWork();
  let work: Promise<void> | undefined;
  const streamAbort = new AbortController();
  try {
    await f.service.manualReview(PR);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const original = f.service.getDetail(PR).draft!;
    f.service.updateDraft(PR, {
      draftId: original.id,
      version: original.version,
      body: "SYNTHETIC retained edit",
      findings: original.findings,
      verdict: original.verdict,
    });
    await f.service.manualReview(PR);
    const { job, request } = observed(f);
    const stream = await fetch(`${base}/events`, {
      signal: streamAbort.signal,
    });
    const reader = stream.body!.getReader();
    await reader.read();
    assert.equal(
      (await post(`/jobs/${job.id}/unqueue`, { ...request, unexpected: true }))
        .status,
      400,
    );
    f.reviewer.beforeResult = async () => {
      gate.enter();
      await gate.promise;
    };
    work = f.service.processJob(job);
    await gate.entered;
    assert.equal((await post(`/jobs/${job.id}/unqueue`, request)).status, 409);
    const response = await post(`/jobs/${job.id}/cancel`, {
      ...request,
      confirmation: cancelReviewConfirmation,
    });
    assert.equal(response.status, 202);
    const reload = async () =>
      (await (await fetch(`${base}${prefix}`)).json()) as PullRequestDetail;
    assert.equal((await reload()).runs[0]?.cancellation?.status, "pending");
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /prId/);
    gate.resolve();
    await work;
    const detail = await reload();
    assert.equal(detail.runs[0]?.cancellation?.status, "confirmed");
    assert.equal(detail.draft?.body, "SYNTHETIC retained edit");
    const preview = await post("/preview", {
      draftId: detail.draft!.id,
      draftVersion: detail.draft!.version,
    });
    assert.equal(preview.status, 200);
    assert.equal(
      (await preview.json()).payload.body,
      "SYNTHETIC retained edit",
    );
    assert.equal(f.github.writes.length, 0);
    assert.equal(
      (
        await post(`/jobs/${job.id}/cancel`, {
          ...request,
          confirmation: cancelReviewConfirmation,
        })
      ).status,
      409,
    );
  } finally {
    streamAbort.abort();
    gate.resolve();
    await work;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

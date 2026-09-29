import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  automationOff,
  inheritAutomation,
  type MergeReadiness,
  type PullRequest,
  type QuestionAnswer,
  type ReviewResult,
  type ReviewerSettings,
} from "../../shared/contracts.js";
import type {
  CommitComparison,
  GithubAdapter,
  PollResult,
  RemotePullRequest,
  ReviewerAdapter,
  ReviewerInput,
} from "../adapters.js";
import { loadConfig } from "../config.js";
import { createHttpServer } from "../http.js";
import type { ProgressReporter } from "../progress.js";
import type { QuestionAdapter, QuestionInput } from "../questions.js";
import { ReviewService } from "../service.js";
import { prId } from "../util.js";

const reviewerSettings: ReviewerSettings = {
  skillPath: "/tmp/skill/SKILL.md",
  model: null,
  additionalInstructions: "",
};

function remote(number: number, headSha = `sha-${number}`): RemotePullRequest {
  const pr: PullRequest = {
    id: prId("owner/repo", number),
    number,
    repository: "owner/repo",
    url: `https://github.com/owner/repo/pull/${number}`,
    title: `Fixture PR ${number}`,
    body: "Fixture",
    author: "author",
    authorAvatarUrl: null,
    headSha,
    baseSha: "base-1",
    headRef: `feature-${number}`,
    baseRef: "main",
    state: "OPEN",
    requested: false,
    requestedAt: null,
    requestSource: null,
    imported: false,
    createdAt: "2025-12-31T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "unreviewed",
    blockingCount: 0,
    nonBlockingCount: 0,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    lastReviewedAt: null,
    hasReviewedHead: false,
    mergeReadiness: null,
    automation: inheritAutomation,
    effectiveAutomation: automationOff,
  };
  return {
    pr,
    diff: `diff --git a/src/${number}.ts b/src/${number}.ts\n--- a/src/${number}.ts\n+++ b/src/${number}.ts\n@@ -1,2 +1,2 @@\n context\n-old ${number}\n+new ${headSha}\n`,
    diffTruncated: false,
  };
}

class FakeGithub implements GithubAdapter {
  readonly demo = false;
  prs = new Map<number, RemotePullRequest>();
  async health() {
    return { user: "tester", message: "fake" };
  }
  async getPullRequest(_repository: string, number: number) {
    return this.prs.get(number)!;
  }
  async poll(): Promise<PollResult> {
    return {
      user: "tester",
      pullRequests: [...this.prs.values()],
      requests: [],
    };
  }
  async submitReview(): Promise<never> {
    throw new Error("never submits");
  }
  async compareCommits(): Promise<CommitComparison> {
    return { status: "identical", commits: [], truncated: false };
  }
  async findReview() {
    return null;
  }
  async mergeReadiness(pr: PullRequest): Promise<MergeReadiness> {
    return {
      headSha: pr.headSha,
      checkedAt: "2026-01-01T00:00:00.000Z",
      state: "unknown",
      mergeStateStatus: "UNKNOWN",
      blockers: [],
      checksTruncated: false,
      error: null,
      lastKnown: null,
    };
  }
}

interface Gate {
  input: ReviewerInput;
  runId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

class GatedReviewer implements ReviewerAdapter {
  readonly gates: Gate[] = [];
  readonly started: string[] = [];
  active = 0;
  peak = 0;
  async health() {
    return { status: "ready" as const, message: "fake" };
  }
  gate(number: number, kind: "review" | "revision" = "review"): Gate {
    const gate = this.gates.find(
      (item) =>
        item.input.pr.number === number &&
        (kind === "revision") === Boolean(item.input.instructions),
    );
    assert.ok(gate, `no active ${kind} for PR ${number}`);
    return gate;
  }
  release(number: number, kind: "review" | "revision" = "review"): void {
    this.gate(number, kind).resolve();
  }
  fail(number: number): void {
    this.gate(number).reject(new Error(`reviewer exploded for ${number}`));
  }
  releaseAll(): void {
    for (const gate of [...this.gates]) gate.resolve();
  }
  async run(
    input: ReviewerInput,
    _settings: ReviewerSettings,
    runId: string,
    signal?: AbortSignal,
    progress?: ProgressReporter,
  ) {
    this.started.push(input.pr.id);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    progress?.phase("checkout", "running");
    progress?.phase("checkout", "completed", `${input.pr.headSha}`);
    progress?.phase("codex", "skipped", "fake reviewer");
    progress?.phase("claude", "running");
    progress?.activity("claude", "read", `Reading src/${input.pr.number}.ts`);
    try {
      await new Promise<void>((resolve, reject) => {
        const gate: Gate = { input, runId, resolve, reject };
        this.gates.push(gate);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    } finally {
      this.active -= 1;
      const index = this.gates.findIndex((gate) => gate.runId === runId);
      if (index >= 0) this.gates.splice(index, 1);
    }
    progress?.phase("claude", "completed");
    const result: ReviewResult = {
      overview: `Overview ${input.pr.number} ${input.pr.headSha}`,
      body: input.instructions
        ? `Revision ${input.pr.number}: ${input.instructions}`
        : `Review ${input.pr.number} ${input.pr.headSha}`,
      findings: [],
      verdict: "COMMENT",
      rationale: "fixture",
    };
    return { result, log: `fake reviewer ${input.pr.number}` };
  }
}

class FakeQuestioner implements QuestionAdapter {
  async ask(
    input: QuestionInput,
  ): Promise<{ answer: QuestionAnswer; log: string }> {
    return {
      answer: {
        kind: "answer",
        answer: `about ${input.selection.path}`,
        followUps: [],
      },
      log: "fake questioner",
    };
  }
}

async function makeService(numbers = [1, 2, 3, 4]) {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-concurrency-"));
  const github = new FakeGithub();
  for (const number of numbers) github.prs.set(number, remote(number));
  const reviewer = new GatedReviewer();
  const questioner = new FakeQuestioner();
  const config = loadConfig({
    host: "127.0.0.1",
    port: 4317,
    dataDir,
    databasePath: join(dataDir, "app.sqlite"),
    demo: false,
    reviewer: reviewerSettings,
  });
  const create = () =>
    ReviewService.create(config, github, reviewer, questioner);
  const service = await create();
  await saveFixtureExecution(service);
  service.updateSettings({ repository: "owner/repo" });
  for (const number of numbers)
    await service.importPullRequest(
      `https://github.com/owner/repo/pull/${number}`,
    );
  const cleanup = async (current: ReviewService = service) => {
    reviewer.releaseAll();
    await current.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { service, github, reviewer, config, create, cleanup };
}

async function waitFor(
  check: () => boolean,
  label = "condition",
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
const id = (number: number) => prId("owner/repo", number);
const statuses = (service: ReviewService, numbers: number[]) =>
  numbers.map((number) => service.getDetail(id(number)).pr.status);
const jobStatuses = (service: ReviewService) =>
  service.db.listJobs().map((job) => `${job.pr_id}:${job.kind}:${job.status}`);

test("maxConcurrentReviews defaults to 1, persists, and migrates legacy databases to 1", async () => {
  const { service, config, create, cleanup } = await makeService([1]);
  try {
    assert.equal(service.getState().settings.maxConcurrentReviews, 1);
    service.updateSettings({ maxConcurrentReviews: 3 });
    assert.equal(service.getState().settings.maxConcurrentReviews, 3);
    assert.equal(service.db.listJobs().length, 0);
    await service.close();
    const restarted = await create();
    assert.equal(restarted.getState().settings.maxConcurrentReviews, 3);
    await restarted.close();
    const sqlite = new DatabaseSync(config.databasePath);
    sqlite.exec(
      "ALTER TABLE settings DROP COLUMN max_concurrent_reviews; UPDATE settings SET polling_enabled = 1",
    );
    sqlite.close();
    const legacy = await create();
    try {
      assert.equal(legacy.getState().settings.maxConcurrentReviews, 1);
    } finally {
      await cleanup(legacy);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
});

test("HTTP settings rejects invalid concurrency values and accepts the range", async () => {
  const { service, config, cleanup } = await makeService([1]);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const patch = (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const value of [0, 9, 2.5, "3", true, null, -1]) {
      const response = await patch({ maxConcurrentReviews: value });
      assert.equal(response.status, 400, `value ${String(value)}`);
      assert.equal((await response.json()).code, "invalid_settings");
    }
    assert.equal(service.getState().settings.maxConcurrentReviews, 1);
    for (const value of [1, 8, 4]) {
      const response = await patch({ maxConcurrentReviews: value });
      assert.equal(response.status, 200);
      assert.equal(
        (await response.json()).settings.maxConcurrentReviews,
        value,
      );
    }
    const untouched = await patch({ pollIntervalSeconds: 60 });
    assert.equal((await untouched.json()).settings.maxConcurrentReviews, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});

test("distinct pull requests run concurrently up to the cap, in FIFO order", async () => {
  const { service, reviewer, cleanup } = await makeService();
  try {
    service.updateSettings({ maxConcurrentReviews: 2 });
    for (const number of [1, 2, 3]) await service.manualReview(id(number));
    await waitFor(() => reviewer.active === 2, "two running");
    await settle();
    assert.deepEqual(statuses(service, [1, 2, 3]), [
      "reviewing",
      "reviewing",
      "queued",
    ]);
    assert.deepEqual(reviewer.started, [id(1), id(2)]);
    reviewer.release(1);
    await waitFor(() => reviewer.started.length === 3, "third start");
    assert.equal(service.getDetail(id(1)).pr.status, "ready");
    assert.equal(service.getDetail(id(1)).draft?.body, "Review 1 sha-1");
    assert.deepEqual(statuses(service, [2, 3]), ["reviewing", "reviewing"]);
    reviewer.releaseAll();
    await waitFor(
      () => service.db.listJobs("completed").length === 3,
      "all complete",
    );
    assert.equal(reviewer.peak, 2);
    for (const number of [1, 2, 3]) {
      const detail = service.getDetail(id(number));
      assert.equal(detail.pr.status, "ready");
      assert.equal(detail.runs.length, 1);
      assert.equal(detail.draft?.body, `Review ${number} sha-${number}`);
      assert.equal(
        detail.runs[0]!.result?.overview,
        `Overview ${number} sha-${number}`,
      );
      assert.deepEqual(
        detail.runs[0]!.progress!.activity.filter(
          (item) => item.kind === "read",
        ).map((item) => item.label),
        [`Reading src/${number}.ts`],
      );
    }
  } finally {
    await cleanup();
  }
});

test("jobs for one pull request serialize while other pull requests use free slots", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    service.updateSettings({ maxConcurrentReviews: 3 });
    await service.manualReview(id(1));
    await waitFor(() => reviewer.active === 1, "first running");
    github.prs.set(1, remote(1, "sha-1-b"));
    await service.manualReview(id(1));
    await service.manualReview(id(2));
    await waitFor(() => reviewer.active === 2, "second PR running");
    await settle();
    assert.deepEqual(reviewer.started, [id(1), id(2)]);
    assert.deepEqual(jobStatuses(service), [
      `${id(1)}:review:running`,
      `${id(1)}:review:queued`,
      `${id(2)}:review:running`,
    ]);
    await service.manualReview(id(1));
    assert.equal(
      service.db.listJobs().length,
      3,
      "a pending job for the same head is not duplicated",
    );
    reviewer.release(1);
    await waitFor(() => reviewer.started.length === 3, "same PR follow-up");
    assert.equal(reviewer.gate(1).input.pr.headSha, "sha-1-b");
    assert.equal(reviewer.active, 2);
    reviewer.releaseAll();
    await waitFor(
      () => service.db.listJobs("completed").length === 3,
      "all complete",
    );
    const detail = service.getDetail(id(1));
    assert.deepEqual(
      detail.drafts.map((draft) => draft.body),
      ["Review 1 sha-1-b", "Review 1 sha-1"],
    );
    assert.equal(detail.pr.status, "ready");
  } finally {
    await cleanup();
  }
});

test("revisions share the cap and serialize behind the same pull request's review", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    service.updateSettings({ maxConcurrentReviews: 2 });
    await service.manualReview(id(1));
    await waitFor(() => reviewer.active === 1, "first running");
    reviewer.release(1);
    await waitFor(
      () => service.getDetail(id(1)).pr.status === "ready",
      "ready",
    );
    const draft = service.getDetail(id(1)).draft!;
    github.prs.set(1, remote(1, "sha-1-b"));
    await service.manualReview(id(1));
    await waitFor(() => reviewer.active === 1, "re-review running");
    service.revise(id(1), {
      draftId: draft.id,
      draftVersion: draft.version,
      instructions: "tighten wording",
    });
    await service.manualReview(id(2));
    await waitFor(() => reviewer.active === 2, "PR 2 running");
    await settle();
    assert.deepEqual(jobStatuses(service), [
      `${id(1)}:review:completed`,
      `${id(1)}:review:running`,
      `${id(1)}:revision:queued`,
      `${id(2)}:review:running`,
    ]);
    reviewer.release(1);
    await waitFor(
      () => reviewer.gates.some((g) => g.input.instructions),
      "revision",
    );
    reviewer.release(1, "revision");
    reviewer.release(2);
    await waitFor(
      () => service.db.listJobs("completed").length === 4,
      "all complete",
    );
    const detail = service.getDetail(id(1));
    assert.equal(detail.proposals.length, 1);
    assert.equal(detail.proposals[0]!.draftId, draft.id);
    assert.equal(detail.proposals[0]!.status, "pending");
    assert.equal(detail.draft?.body, "Review 1 sha-1-b");
    assert.equal(service.getDetail(id(2)).pr.status, "ready");
  } finally {
    await cleanup();
  }
});

test("a failure releases only its slot and never disturbs the other running job", async () => {
  const { service, reviewer, cleanup } = await makeService();
  try {
    service.updateSettings({ maxConcurrentReviews: 2 });
    for (const number of [1, 2, 3]) await service.manualReview(id(number));
    await waitFor(() => reviewer.active === 2, "two running");
    reviewer.fail(1);
    await waitFor(() => reviewer.started.length === 3, "third start");
    const failed = service.getDetail(id(1));
    assert.equal(failed.pr.status, "failed");
    assert.equal(failed.runs[0]!.status, "failed");
    assert.match(failed.runs[0]!.error!, /exploded for 1/);
    assert.equal(failed.runs[0]!.progress!.phases.at(-1)!.status, "failed");
    assert.deepEqual(statuses(service, [2, 3]), ["reviewing", "reviewing"]);
    assert.equal(reviewer.active, 2);
    reviewer.releaseAll();
    await waitFor(
      () => service.db.listJobs("completed").length === 2,
      "others complete",
    );
    assert.deepEqual(statuses(service, [2, 3]), ["ready", "ready"]);
    assert.equal(
      service.db.listJobs("queued").length +
        service.db.listJobs("running").length,
      0,
    );
  } finally {
    await cleanup();
  }
});

test("raising the cap starts queued jobs promptly and lowering it cancels nothing", async () => {
  const { service, reviewer, cleanup } = await makeService();
  try {
    for (const number of [1, 2, 3]) await service.manualReview(id(number));
    await waitFor(() => reviewer.active === 1, "one running");
    await settle();
    assert.deepEqual(statuses(service, [1, 2, 3]), [
      "reviewing",
      "queued",
      "queued",
    ]);
    service.updateSettings({ maxConcurrentReviews: 3 });
    await waitFor(() => reviewer.active === 3, "three running");
    assert.equal(service.db.listJobs().length, 3);
    service.updateSettings({ maxConcurrentReviews: 1 });
    await settle();
    assert.equal(reviewer.active, 3, "running jobs are never cancelled");
    assert.deepEqual(statuses(service, [1, 2, 3]), [
      "reviewing",
      "reviewing",
      "reviewing",
    ]);
    await service.manualReview(id(4));
    reviewer.release(1);
    reviewer.release(2);
    await waitFor(() => reviewer.active === 1, "two finished");
    await settle();
    assert.equal(service.getDetail(id(4)).pr.status, "queued");
    assert.deepEqual(reviewer.started.length, 3);
    reviewer.release(3);
    await waitFor(
      () => reviewer.started.length === 4,
      "fourth starts under cap",
    );
    assert.equal(reviewer.active, 1);
    reviewer.releaseAll();
    await waitFor(
      () => service.db.listJobs("completed").length === 4,
      "all complete",
    );
    assert.equal(reviewer.peak, 3);
  } finally {
    await cleanup();
  }
});

test("shutdown interrupts every active job and restart reruns nothing", async () => {
  const { service, reviewer, create, cleanup } = await makeService();
  service.updateSettings({ maxConcurrentReviews: 2 });
  for (const number of [1, 2, 3]) await service.manualReview(id(number));
  await waitFor(() => reviewer.active === 2, "two running");
  await service.close();
  assert.equal(reviewer.active, 0);
  const restarted = await create();
  try {
    await settle();
    assert.equal(reviewer.started.length, 3);
    for (const number of [1, 2]) {
      const run = restarted.getDetail(id(number)).runs[0]!;
      assert.equal(run.status, "interrupted");
      assert.equal(run.progress!.phases.at(-1)!.id, "claude");
      assert.equal(run.progress!.phases.at(-1)!.status, "interrupted");
    }
    assert.deepEqual(jobStatuses(restarted), [
      `${id(1)}:review:interrupted`,
      `${id(2)}:review:interrupted`,
      `${id(3)}:review:running`,
    ]);
    assert.equal(reviewer.active, 1, "only the still-queued job resumed");
    assert.equal(reviewer.gate(3).input.pr.number, 3);
    assert.equal(restarted.getState().settings.maxConcurrentReviews, 2);
  } finally {
    await cleanup(restarted);
  }
});

test("questions keep their own lane and settings changes queue no reviews", async () => {
  const { service, reviewer, cleanup } = await makeService();
  try {
    service.updateSettings({ maxConcurrentReviews: 2 });
    for (const number of [1, 2, 3]) await service.manualReview(id(number));
    await waitFor(() => reviewer.active === 2, "two running");
    service.ask(id(3), {
      mode: "explain",
      range: {
        path: "src/3.ts",
        from: { side: "RIGHT", line: 1 },
        to: { side: "RIGHT", line: 2 },
        baseSha: "base-1",
        headSha: "sha-3",
      },
      question: "why?",
    });
    await waitFor(
      () => service.getDetail(id(3)).questions[0]?.status === "completed",
      "question answered while reviews are held",
    );
    assert.equal(service.getDetail(id(3)).pr.status, "queued");
    const before = service.db.listJobs().length;
    service.updateSettings({ maxConcurrentReviews: 8 });
    service.updateSettings({ automation: { pollCommits: true } });
    await settle();
    assert.equal(service.db.listJobs().length, before);
    assert.equal(reviewer.active, 3);
  } finally {
    await cleanup();
  }
});

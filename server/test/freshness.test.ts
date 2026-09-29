import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  automationOff,
  inheritAutomation,
  type CommitSummary,
  type Finding,
  type MergeReadiness,
  type PullRequest,
  type ReviewResult,
  type ReviewerSettings,
} from "../../shared/contracts.js";
import {
  GithubRequestError,
  type CommitComparison,
  type GithubAdapter,
  type PollResult,
  type RemotePullRequest,
  type ReviewerAdapter,
  type ReviewerInput,
} from "../adapters.js";
import { loadConfig } from "../config.js";
import { ReviewService, ServiceError } from "../service.js";
import { prId } from "../util.js";

const unknownReadiness = (pr: PullRequest): MergeReadiness => ({
  headSha: pr.headSha,
  checkedAt: "2026-01-01T00:00:00.000Z",
  state: "unknown",
  mergeStateStatus: "UNKNOWN",
  blockers: [],
  checksTruncated: false,
  error: null,
  lastKnown: null,
});

const reviewerSettings: ReviewerSettings = {
  skillPath: "/tmp/skill/SKILL.md",
  model: null,
  additionalInstructions: "",
};

function remote(headSha = "sha-1"): RemotePullRequest {
  const pr: PullRequest = {
    id: prId("owner/repo", 7),
    number: 7,
    repository: "owner/repo",
    url: "https://github.com/owner/repo/pull/7",
    title: "Fixture PR",
    body: "Fixture",
    author: "author",
    authorAvatarUrl: null,
    headSha,
    baseSha: "base-1",
    headRef: "feature",
    baseRef: "main",
    state: "OPEN",
    requested: true,
    requestedAt: "2026-01-01T00:00:00.000Z",
    requestSource: "direct",
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
    diff: `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+line from ${headSha}\n`,
    diffTruncated: false,
  };
}

const commit = (sha: string): CommitSummary => ({
  sha,
  message: `Commit ${sha}`,
  author: "author",
  committedAt: "2026-01-02T00:00:00.000Z",
  url: `https://github.com/owner/repo/commit/${sha}`,
});

class FakeGithub implements GithubAdapter {
  readonly demo = false;
  current = remote();
  fetchError: Error | null = null;
  comparison: CommitComparison | Error = {
    status: "ahead",
    commits: [commit("sha-2")],
    truncated: false,
  };
  compareCalls: Array<[string, string]> = [];
  async health() {
    return { user: "tester", message: "fake" };
  }
  async getPullRequest() {
    if (this.fetchError) throw this.fetchError;
    return this.current;
  }
  async poll(): Promise<PollResult> {
    return { user: "tester", pullRequests: [this.current], requests: [] };
  }
  async compareCommits(_repository: string, base: string, head: string) {
    this.compareCalls.push([base, head]);
    if (this.comparison instanceof Error) throw this.comparison;
    return this.comparison;
  }
  async submitReview() {
    return { githubReviewId: "review-1", url: null };
  }
  async findReview() {
    return null;
  }
  async mergeReadiness(pr: PullRequest): Promise<MergeReadiness> {
    return unknownReadiness(pr);
  }
}

class FakeReviewer implements ReviewerAdapter {
  count = 0;
  hold = false;
  inputs: ReviewerInput[] = [];
  private releaseHeldRun: (() => void) | null = null;
  async health() {
    return { status: "ready" as const, message: "fake" };
  }
  release(): void {
    this.releaseHeldRun?.();
    this.releaseHeldRun = null;
  }
  async run(input: ReviewerInput) {
    this.inputs.push(input);
    this.count += 1;
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.releaseHeldRun = resolve;
      });
    const finding: Finding = {
      id: `finding-${this.count}`,
      severity: "non_blocking",
      path: "src/a.ts",
      line: 1,
      body: `Finding ${this.count}`,
      evidence: "Evidence",
      origin: "introduced",
      included: true,
      startLine: null,
      side: "RIGHT",
      questionId: null,
    };
    const result: ReviewResult = {
      overview: `Overview ${this.count}`,
      body: `Review ${this.count} of ${input.pr.headSha}`,
      findings: [finding],
      verdict: "COMMENT",
      rationale: "fixture",
    };
    return { result, log: "fake reviewer" };
  }
}

async function makeService() {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-fresh-"));
  const github = new FakeGithub();
  const reviewer = new FakeReviewer();
  const config = loadConfig({
    host: "127.0.0.1",
    port: 4317,
    dataDir,
    databasePath: join(dataDir, "app.sqlite"),
    demo: false,
    reviewer: reviewerSettings,
  });
  const service = await ReviewService.create(config, github, reviewer);
  await saveFixtureExecution(service);
  service.db.updateSettings({ repository: "owner/repo" });
  const cleanup = async () => {
    reviewer.release();
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { service, github, reviewer, config, cleanup };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting");
}

async function reviewedAt(
  service: ReviewService,
  github: FakeGithub,
  reviewer: FakeReviewer,
) {
  await service.sync();
  const id = github.current.pr.id;
  await service.manualReview(id);
  await waitFor(
    () => reviewer.count === 1 && service.getDetail(id).draft !== null,
  );
  return id;
}

test("re-review refreshes to the current head before queueing its snapshot", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    github.current = remote("sha-2");
    await service.manualReview(id);
    await waitFor(() => reviewer.count === 2);
    const detail = service.getDetail(id);
    const run = detail.runs[0];
    assert.equal(run.headSha, "sha-2");
    assert.equal(reviewer.inputs[1].pr.headSha, "sha-2");
    assert.equal(reviewer.inputs[1].diff, remote("sha-2").diff);
    assert.equal(detail.pr.headSha, "sha-2");
    assert.equal(detail.draft?.headSha, "sha-2");
    assert.equal(detail.draft?.body, "Review 2 of sha-2");
    assert.equal(detail.drafts[1]?.body, "Review 1 of sha-1");
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.runs.length, 2);
  } finally {
    await cleanup();
  }
});

test("refresh failure and closed pull requests never review cached code", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    github.fetchError = new Error("gh api failed: HTTP 503");
    await assert.rejects(
      () => service.manualReview(id),
      (error: unknown) =>
        error instanceof ServiceError &&
        error.code === "refresh_failed" &&
        error.status === 502,
    );
    github.fetchError = null;
    github.current = {
      ...remote("sha-2"),
      pr: { ...remote("sha-2").pr, state: "CLOSED" },
    };
    await assert.rejects(
      () => service.manualReview(id),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "pr_closed",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const detail = service.getDetail(id);
    assert.equal(detail.runs.length, 1);
    assert.equal(service.db.listJobs().length, 1);
    assert.equal(reviewer.count, 1);
    assert.equal(detail.pr.state, "CLOSED");
    assert.equal(detail.pr.headSha, "sha-2");
    assert.equal(detail.pr.status, "outdated");
  } finally {
    await cleanup();
  }
});

test("a later head change does not relabel a queued snapshot and a fresh click queues the new head", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    reviewer.hold = true;
    github.current = remote("sha-2");
    await service.manualReview(id);
    await service.manualReview(id);
    assert.equal(service.getDetail(id).runs.length, 2);
    await waitFor(() => reviewer.inputs.length === 2);
    github.current = remote("sha-3");
    await service.checkFreshness(id);
    assert.equal(service.getDetail(id).runs[0].headSha, "sha-2");
    await service.manualReview(id);
    const queued = service.getDetail(id).runs;
    assert.deepEqual(
      queued.map((run) => [run.headSha, run.status]),
      [
        ["sha-3", "queued"],
        ["sha-2", "running"],
        ["sha-1", "completed"],
      ],
    );
    reviewer.hold = false;
    reviewer.release();
    await waitFor(() =>
      service.getDetail(id).runs.every((run) => run.status === "completed"),
    );
    assert.equal(reviewer.inputs[1].pr.headSha, "sha-2");
    assert.equal(reviewer.inputs[1].diff, remote("sha-2").diff);
    assert.equal(reviewer.inputs[2].pr.headSha, "sha-3");
  } finally {
    await cleanup();
  }
});

test("freshness check refreshes metadata and lists new commits without reviewing", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    let detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.status, "fresh");
    assert.deepEqual(github.compareCalls, []);
    github.current = remote("sha-2");
    github.comparison = {
      status: "ahead",
      commits: [commit("sha-1a"), commit("sha-2")],
      truncated: true,
    };
    detail = await service.checkFreshness(id);
    assert.equal(detail.pr.headSha, "sha-2");
    assert.equal(detail.pr.status, "outdated");
    assert.equal(detail.diff, remote("sha-2").diff);
    assert.deepEqual(github.compareCalls, [["sha-1", "sha-2"]]);
    assert.equal(detail.freshness?.status, "stale");
    assert.equal(detail.freshness?.baseline, "sha-1");
    assert.equal(detail.freshness?.head, "sha-2");
    assert.deepEqual(
      detail.freshness?.commits.map((item) => item.sha),
      ["sha-1a", "sha-2"],
    );
    assert.equal(detail.freshness?.truncated, true);
    assert.equal(detail.freshness?.error, null);
    assert.equal(reviewer.count, 1);
    assert.equal(service.db.listJobs().length, 1);
    assert.deepEqual(service.getState().settings.automation, automationOff);
    assert.equal(detail.draft?.body, "Review 1 of sha-1");
  } finally {
    await cleanup();
  }
});

test("freshness baseline follows the latest review draft, not an edited older one", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    const draft = service.getDetail(id).draft!;
    service.updateDraft(id, {
      draftId: draft.id,
      version: draft.version,
      body: "Edited by hand",
      findings: draft.findings,
      verdict: "APPROVE",
    });
    github.current = remote("sha-2");
    let detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.baseline, "sha-1");
    assert.equal(detail.freshness?.status, "stale");
    await service.manualReview(id);
    await waitFor(() => reviewer.count === 2);
    detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.baseline, "sha-2");
    assert.equal(detail.freshness?.status, "fresh");
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.draft?.headSha, "sha-2");
    assert.equal(detail.drafts[1]?.body, "Edited by hand");
    assert.equal(detail.drafts[1]?.version, draft.version + 1);
  } finally {
    await cleanup();
  }
});

test("rewritten history and missing baselines are reported truthfully", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    github.current = remote("sha-2");
    github.comparison = {
      status: "diverged",
      commits: [commit("sha-2")],
      truncated: false,
    };
    let detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.status, "rewritten");
    assert.deepEqual(
      detail.freshness?.commits.map((item) => item.sha),
      ["sha-2"],
    );
    github.comparison = new GithubRequestError("gh: Not Found (HTTP 404)", 404);
    detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.status, "unavailable");
    assert.deepEqual(detail.freshness?.commits, []);
    assert.equal(detail.freshness?.error, null);
  } finally {
    await cleanup();
  }
});

test("network failures keep the known stale state and surface the error", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    github.current = remote("sha-2");
    let detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.status, "stale");
    github.fetchError = new Error("rate limited");
    detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.status, "stale");
    assert.deepEqual(
      detail.freshness?.commits.map((item) => item.sha),
      ["sha-2"],
    );
    assert.match(detail.freshness?.error ?? "", /rate limited/);
    assert.equal(detail.pr.headSha, "sha-2");
    github.fetchError = null;
    github.comparison = new GithubRequestError(
      "gh: server error (HTTP 502)",
      502,
    );
    github.current = remote("sha-3");
    detail = await service.checkFreshness(id);
    assert.equal(detail.freshness?.status, "stale");
    assert.equal(detail.freshness?.head, "sha-3");
    assert.deepEqual(detail.freshness?.commits, []);
    assert.match(detail.freshness?.error ?? "", /HTTP 502/);
  } finally {
    await cleanup();
  }
});

test("a pull request without any review has nothing to compare", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    await service.sync();
    const detail = await service.checkFreshness(github.current.pr.id);
    assert.equal(detail.freshness, null);
    assert.equal(detail.runs.length, 0);
  } finally {
    await cleanup();
  }
});

function closedAt(headSha: string, state: "CLOSED" | "MERGED" = "CLOSED") {
  const next = remote(headSha);
  return { ...next, pr: { ...next.pr, state } };
}

test("new commits and closure alone never mark an unreviewed pull request outdated", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    await service.sync();
    const id = github.current.pr.id;
    github.current = remote("sha-2");
    await service.sync();
    assert.equal(service.getDetail(id).pr.status, "unreviewed");
    await service.checkFreshness(id);
    assert.equal(service.getDetail(id).pr.status, "unreviewed");
    assert.equal(service.getDetail(id).freshness, null);
    github.current = closedAt("sha-3");
    await assert.rejects(
      () => service.manualReview(id),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "pr_closed",
    );
    const detail = service.getDetail(id);
    assert.equal(detail.pr.state, "CLOSED");
    assert.equal(detail.pr.status, "unreviewed");
    assert.deepEqual(service.getState().prs, []);
    github.current = closedAt("sha-3", "MERGED");
    await service.checkFreshness(id);
    assert.equal(service.getDetail(id).pr.status, "unreviewed");
  } finally {
    await cleanup();
  }
});

test("a failed first review stays failed through new commits and closure", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.sync();
    const id = github.current.pr.id;
    reviewer.run = async () => {
      throw new Error("reviewer crashed");
    };
    await service.manualReview(id);
    await waitFor(() => service.getDetail(id).pr.status === "failed");
    github.current = remote("sha-2");
    await service.sync();
    assert.equal(service.getDetail(id).pr.status, "failed");
    github.current = closedAt("sha-2");
    await service.checkFreshness(id);
    const detail = service.getDetail(id);
    assert.equal(detail.pr.status, "failed");
    assert.equal(detail.draft, null);
    assert.equal(detail.runs[0].status, "failed");
  } finally {
    await cleanup();
  }
});

test("metadata edits and closure on the reviewed commit keep the draft ready", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    github.current = {
      ...remote(),
      pr: { ...remote().pr, title: "Retitled", body: "Edited" },
    };
    await service.sync();
    assert.equal(service.getDetail(id).pr.title, "Retitled");
    assert.equal(service.getDetail(id).pr.status, "ready");
    github.current = closedAt("sha-1", "MERGED");
    await assert.rejects(() => service.manualReview(id));
    const detail = service.getDetail(id);
    assert.equal(detail.pr.state, "MERGED");
    assert.equal(detail.pr.status, "ready");
    assert.deepEqual(service.getState().prs, []);
    assert.equal(detail.freshness?.status, "fresh");
  } finally {
    await cleanup();
  }
});

test("a draft behind the current head is outdated until a new review lands on it", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    const id = await reviewedAt(service, github, reviewer);
    github.current = remote("sha-2");
    await service.sync();
    assert.equal(service.getDetail(id).pr.status, "outdated");
    assert.equal(service.getState().prs[0].status, "outdated");
    github.current = closedAt("sha-2");
    await service.checkFreshness(id);
    assert.equal(service.getDetail(id).pr.status, "outdated");
    github.current = remote("sha-2");
    await service.manualReview(id);
    await waitFor(() => reviewer.count === 2);
    const detail = service.getDetail(id);
    assert.equal(detail.draft?.headSha, "sha-2");
    assert.equal(detail.pr.status, "ready");
    assert.equal(service.getState().prs[0].status, "ready");
    assert.equal(detail.drafts[1]?.headSha, "sha-1");
    await assert.rejects(
      () =>
        service.preview(id, detail.drafts[1]!.id, detail.drafts[1]!.version),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "stale_draft",
    );
  } finally {
    await cleanup();
  }
});

test("restart corrects stored outdated states that no draft or the current draft justifies", async () => {
  const { service, github, reviewer, config, cleanup } = await makeService();
  try {
    const reviewed = await reviewedAt(service, github, reviewer);
    const unreviewedRemote = remote("sha-9");
    const unreviewed = prId("owner/repo", 9);
    github.current = {
      ...unreviewedRemote,
      pr: {
        ...unreviewedRemote.pr,
        id: unreviewed,
        number: 9,
        state: "CLOSED",
      },
    };
    await service.sync();
    service.db.setPrStatus(reviewed, "outdated");
    service.db.setPrStatus(unreviewed, "outdated");
    await service.close();
    const restarted = await ReviewService.create(config, github, reviewer);
    try {
      assert.equal(restarted.getDetail(reviewed).pr.status, "ready");
      assert.equal(restarted.getDetail(unreviewed).pr.status, "unreviewed");
      assert.deepEqual(
        restarted.db
          .listPrs()
          .map((pr) => [pr.id, pr.status])
          .sort(),
        [
          [reviewed, "ready"],
          [unreviewed, "unreviewed"],
        ].sort(),
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await cleanup().catch(() => undefined);
  }
});

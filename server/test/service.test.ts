import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  automationOff,
  inheritAutomation,
  type Finding,
  type MergeReadiness,
  type PullRequest,
  type ReviewPayload,
  type ReviewResult,
  type ReviewerSettings,
} from "../../shared/contracts.js";
import type {
  CommitComparison,
  GithubAdapter,
  PollResult,
  RemotePullRequest,
  ReviewSubmissionResult,
  ReviewerAdapter,
  ReviewerInput,
} from "../adapters.js";
import { loadConfig, type AppConfig } from "../config.js";
import type { ProgressReporter } from "../progress.js";
import { ReviewService, ServiceError } from "../service.js";
import { prId } from "../util.js";

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
    diff: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+new line\n",
    diffTruncated: false,
  };
}

const finding = (id: string): Finding => ({
  id,
  severity: "non_blocking",
  path: "src/a.ts",
  line: 1,
  body: `Finding ${id}`,
  evidence: "Evidence",
  origin: "introduced",
  included: true,
  startLine: null,
  side: "RIGHT",
  questionId: null,
});

class FakeGithub implements GithubAdapter {
  readonly demo = false;
  current = remote();
  eventId = "event-1";
  submitCalls = 0;
  failSubmit = false;
  holdSubmit = false;
  reconciliation: ReviewSubmissionResult | null = null;
  private releaseHeldSubmit: (() => void) | null = null;
  async health() {
    return { user: "tester", message: "fake" };
  }
  async getPullRequest() {
    return this.current;
  }
  async poll(): Promise<PollResult> {
    return {
      user: "tester",
      pullRequests: [this.current],
      requests: this.current.pr.requested
        ? [
            {
              eventId: this.eventId,
              prId: this.current.pr.id,
              headSha: this.current.pr.headSha,
              requestedAt: this.current.pr.requestedAt!,
            },
          ]
        : [],
    };
  }
  releaseSubmit(): void {
    this.releaseHeldSubmit?.();
    this.releaseHeldSubmit = null;
  }
  async submitReview(_pr: PullRequest, _payload: ReviewPayload) {
    this.submitCalls += 1;
    if (this.holdSubmit)
      await new Promise<void>((resolve) => {
        this.releaseHeldSubmit = resolve;
      });
    if (this.failSubmit) throw new Error("connection dropped after request");
    return {
      githubReviewId: "review-1",
      url: "https://github.com/owner/repo/pull/7#review-1",
    };
  }
  async compareCommits(): Promise<CommitComparison> {
    return { status: "identical", commits: [], truncated: false };
  }
  async findReview() {
    return this.reconciliation;
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

class FakeReviewer implements ReviewerAdapter {
  count = 0;
  malformed = false;
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
  async run(
    input: ReviewerInput,
    _settings: ReviewerSettings,
    _runId: string,
    signal?: AbortSignal,
    progress?: ProgressReporter,
  ) {
    this.inputs.push(input);
    this.count += 1;
    progress?.phase("checkout", "running");
    progress?.phase("checkout", "completed", "base-1..sha-1");
    progress?.phase("codex", "skipped", "fake reviewer");
    progress?.phase("claude", "running");
    progress?.activity("claude", "read", "Reading src/a.ts");
    if (this.hold)
      await new Promise<void>((resolve, reject) => {
        this.releaseHeldRun = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    progress?.phase("claude", "completed");
    if (this.malformed)
      return {
        result: { summary: "bad" } as unknown as ReviewResult,
        log: "malformed",
      };
    const result: ReviewResult = {
      overview: `Overview ${this.count}`,
      body: `Review ${this.count}`,
      findings: [finding(`finding-${this.count}`)],
      verdict: "COMMENT",
      rationale: "fixture",
    };
    return { result, log: "fake reviewer" };
  }
}

const reviewer = () => new FakeReviewer();

async function makeService(reviewRequests = true) {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-test-"));
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
  service.updateSettings({ repository: "owner/repo" });
  if (reviewRequests) {
    github.eventId = "event-0";
    service.updateSettings({
      automation: { pollRequests: true, reviewRequests: true },
    });
    await service.sync();
    github.eventId = "event-1";
  }
  return { service, github, reviewer, dataDir, config };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for queued job");
}

async function cleanup(service: ReviewService, dataDir: string): Promise<void> {
  await service.close();
  await rm(dataDir, { recursive: true, force: true });
}

test("disabled automatic review only refreshes data until explicitly enabled", async () => {
  const { service, github, reviewer, dataDir } = await makeService(false);
  try {
    await service.sync();
    await service.sync();
    assert.equal(service.getDetail(github.current.pr.id).runs.length, 0);
    assert.equal(service.db.listJobs().length, 0);
    assert.equal(reviewer.count, 0);
    await service.manualReview(github.current.pr.id);
    await waitFor(() => reviewer.count === 1);
    assert.deepEqual(service.getState().settings.automation, automationOff);
    await service.sync();
    assert.equal(service.getDetail(github.current.pr.id).runs.length, 1);
    service.updateSettings({
      automation: { pollRequests: true, reviewRequests: true },
    });
    await service.sync();
    await service.sync();
    assert.equal(
      service.getDetail(github.current.pr.id).runs.length,
      1,
      "the outstanding request observed at enable time is the baseline, not a backlog review",
    );
    github.eventId = "event-2";
    await service.sync();
    await waitFor(() => reviewer.count === 2);
    assert.ok(
      service
        .getDetail(github.current.pr.id)
        .runs.some((run) => run.requestEventId === "event-2"),
    );
  } finally {
    await cleanup(service, dataDir);
  }
});

test("sync deduplicates an event but queues a same-SHA re-request", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    await service.sync();
    assert.equal(service.getDetail(github.current.pr.id).runs.length, 1);
    github.eventId = "event-2";
    await service.sync();
    await waitFor(() => reviewer.count === 2);
    assert.equal(service.getDetail(github.current.pr.id).runs.length, 2);
    assert.equal(
      service.getDetail(github.current.pr.id).runs[0].headSha,
      "sha-1",
    );
  } finally {
    await cleanup(service, dataDir);
  }
});

test("manual re-review preserves an edited draft and restart persists it", async () => {
  const { service, github, reviewer, dataDir, config } = await makeService();
  await service.sync();
  await waitFor(() => reviewer.count === 1);
  const initial = service.getDetail(github.current.pr.id);
  const edited = service.updateDraft(github.current.pr.id, {
    draftId: initial.draft!.id,
    version: initial.draft!.version,
    body: "Manual edit",
    findings: initial.draft!.findings,
    verdict: "APPROVE",
  });
  await service.manualReview(github.current.pr.id);
  await waitFor(() => reviewer.count === 2);
  const reviewed = service.getDetail(github.current.pr.id);
  assert.equal(reviewed.draft?.body, "Review 2");
  assert.equal(reviewed.drafts[1]?.body, "Manual edit");
  await service.close();
  const restarted = await ReviewService.create(config, github, reviewer);
  try {
    const detail = restarted.getDetail(github.current.pr.id);
    assert.equal(detail.drafts.length, 2);
    assert.equal(detail.draft?.body, "Review 2");
    assert.equal(detail.drafts[1]?.body, "Manual edit");
    assert.equal(detail.drafts[1]?.version, edited.draft!.version);
  } finally {
    await cleanup(restarted, dataDir);
  }
});

test("removed requests and new commits do not trigger automatic review", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    github.current = remote("sha-2");
    github.current.pr = {
      ...github.current.pr,
      requested: false,
      requestedAt: null,
      requestSource: null,
      imported: false,
      state: "CLOSED",
    };
    await service.sync();
    const detail = service.getDetail(github.current.pr.id);
    assert.equal(detail.pr.requested, false);
    assert.equal(detail.pr.status, "outdated");
    assert.equal(reviewer.count, 1);
  } finally {
    await cleanup(service, dataDir);
  }
});

test("revision proposals remain separate until explicitly applied", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    const draft = service.getDetail(prIdValue).draft!;
    service.revise(prIdValue, {
      draftId: draft.id,
      draftVersion: draft.version,
      instructions: "Make the summary clearer",
    });
    await waitFor(() => reviewer.count === 2);
    const withProposal = service.getDetail(prIdValue);
    assert.equal(withProposal.proposals[0].status, "pending");
    assert.equal(withProposal.proposals[0].draftId, draft.id);
    assert.equal(reviewer.inputs[1].draft?.body, "Review 1");
    assert.equal(reviewer.inputs[1].draft?.overview, "Overview 1");
    assert.equal(reviewer.inputs[1].instructions, "Make the summary clearer");
    assert.deepEqual(reviewer.inputs[1].findingIds, []);
    assert.equal(withProposal.draft?.version, draft.version);
    service.applyProposal(
      prIdValue,
      withProposal.proposals[0].id,
      draft.version,
    );
    const applied = service.getDetail(prIdValue);
    assert.equal(applied.proposals[0].status, "accepted");
    assert.equal(applied.draft?.version, draft.version + 1);
  } finally {
    await cleanup(service, dataDir);
  }
});

test("queued review uses its immutable revision snapshot when the PR updates", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  reviewer.hold = true;
  try {
    await service.sync();
    await waitFor(() => reviewer.inputs.length === 1);
    github.current = remote("sha-2");
    github.current.pr = {
      ...github.current.pr,
      requested: false,
      requestedAt: null,
    };
    await service.sync();
    reviewer.release();
    await waitFor(
      () =>
        reviewer.count === 1 &&
        service.getDetail(github.current.pr.id).runs[0].status === "completed",
    );
    const detail = service.getDetail(github.current.pr.id);
    assert.equal(reviewer.inputs[0].pr.headSha, "sha-1");
    assert.equal(reviewer.inputs[0].pr.baseSha, "base-1");
    assert.equal(reviewer.inputs[0].diff, remote("sha-1").diff);
    assert.equal(detail.runs[0].headSha, "sha-1");
    assert.equal(detail.pr.headSha, "sha-2");
    assert.equal(detail.pr.status, "outdated");
  } finally {
    reviewer.release();
    await cleanup(service, dataDir);
  }
});

test("preview rejects a stale draft after a new commit", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const draft = service.getDetail(github.current.pr.id).draft!;
    github.current = remote("sha-2");
    await assert.rejects(
      () => service.preview(github.current.pr.id, draft.id, draft.version),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "stale_draft",
    );
    assert.equal(service.getState().prs[0].status, "outdated");
  } finally {
    await cleanup(service, dataDir);
  }
});

test("preview anchors context lines inline and labels body findings once", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    github.current = {
      ...remote(),
      diff: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,4 +10,4 @@",
        " context line",
        "-removed line",
        "+added line",
        " trailing context",
        "",
      ].join("\n"),
    };
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    const draft = service.getDetail(prIdValue).draft!;
    const edited = service.updateDraft(prIdValue, {
      draftId: draft.id,
      version: draft.version,
      body: "Overall this holds together.",
      verdict: "COMMENT",
      findings: [
        { ...finding("added"), line: 11, body: "Claim on the added line." },
        {
          ...finding("context"),
          severity: "blocking",
          line: 12,
          body: "Claim on a context line.\n- consequence",
        },
        {
          ...finding("outside"),
          line: 40,
          origin: "pre_existing",
          body: "Claim outside the diff.",
        },
        {
          ...finding("labelled"),
          severity: "blocking",
          path: null,
          line: null,
          body: "Blocking. Already labelled.",
        },
        { ...finding("excluded"), included: false, body: "Excluded text." },
      ],
    }).draft!;
    const preview = await service.preview(prIdValue, edited.id, edited.version);
    assert.deepEqual(
      preview.payload.comments.map((comment) => [
        comment.path,
        comment.line,
        comment.body,
      ]),
      [
        ["src/a.ts", 11, "**Non-blocking.** Claim on the added line."],
        [
          "src/a.ts",
          12,
          "**Blocking.** Claim on a context line.\n- consequence",
        ],
      ],
    );
    assert.equal(
      preview.payload.body,
      [
        "Overall this holds together.",
        "**Non-blocking.** `src/a.ts:40` Pre-existing. Claim outside the diff.",
        "**Blocking.** Already labelled.",
      ].join("\n\n"),
    );
    assert.doesNotMatch(
      preview.payload.body,
      /Excluded text|Evidence|Overview/,
    );
    assert.equal(edited.overview, "Overview 1");
    assert.doesNotMatch(JSON.stringify(preview.payload), /Overview 1/);
    assert.equal(
      preview.payload.comments.every(
        (comment) => !comment.body.includes("Evidence"),
      ),
      true,
    );
  } finally {
    await cleanup(service, dataDir);
  }
});

test("ambiguous submission is reconciled without a second write", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    const preview = await service.preview(
      prIdValue,
      service.getDetail(prIdValue).draft!.id,
      service.getDetail(prIdValue).draft!.version,
    );
    github.failSubmit = true;
    await assert.rejects(
      () => service.submit(prIdValue, preview.id),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "submission_ambiguous",
    );
    assert.equal(github.submitCalls, 1);
    github.reconciliation = {
      githubReviewId: "review-reconciled",
      url: "https://example.invalid/reconciled",
    };
    await service.submit(prIdValue, preview.id);
    assert.equal(github.submitCalls, 1);
    assert.equal(
      service.getDetail(prIdValue).submissions[0].status,
      "submitted",
    );
  } finally {
    await cleanup(service, dataDir);
  }
});

async function submitLatest(service: ReviewService, prIdValue: string) {
  const detail = service.getDetail(prIdValue);
  const preview = await service.preview(
    prIdValue,
    detail.draft!.id,
    detail.draft!.version,
  );
  return service.submit(prIdValue, preview.id);
}

async function submittedService() {
  const made = await makeService(false);
  made.service.updateSettings({
    automation: { pollRequests: true, reviewRequests: false },
  });
  made.github.eventId = "event-0";
  await made.service.sync();
  await made.service.manualReview(made.github.current.pr.id);
  await waitFor(() => made.reviewer.count === 1);
  const detail = await submitLatest(made.service, made.github.current.pr.id);
  assert.equal(detail.pr.status, "submitted");
  assert.equal(detail.submissions[0]?.status, "submitted");
  return made;
}

function reRequest(github: FakeGithub, eventId: string, requestedAt: string) {
  github.eventId = eventId;
  github.current.pr = { ...github.current.pr, requestedAt };
}

test("a request event newer than the successful submission makes the PR active again", async () => {
  const { service, github, dataDir } = await submittedService();
  try {
    const prIdValue = github.current.pr.id;
    await service.sync();
    assert.equal(service.getDetail(prIdValue).pr.status, "submitted");
    reRequest(github, "event-old", "2025-12-01T00:00:00.000Z");
    await service.sync();
    assert.equal(service.getDetail(prIdValue).pr.status, "submitted");
    reRequest(github, "event-new", new Date(Date.now() + 60_000).toISOString());
    await service.sync();
    const detail = service.getDetail(prIdValue);
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.submissions[0]?.status, "submitted");
    assert.equal(detail.drafts.length, 1);
    await service.sync();
    assert.equal(service.getDetail(prIdValue).pr.status, "ready");
  } finally {
    await cleanup(service, dataDir);
  }
});

test("startup re-derives a stored Submitted status that a newer request event outranks", async () => {
  const { service, github, dataDir, config } = await submittedService();
  const prIdValue = github.current.pr.id;
  reRequest(github, "event-new", new Date(Date.now() + 60_000).toISOString());
  await service.sync();
  assert.equal(service.getDetail(prIdValue).pr.status, "ready");
  service["db"].setPrStatus(prIdValue, "submitted");
  assert.equal(service.getDetail(prIdValue).pr.status, "submitted");
  await service.close();
  const restarted = await ReviewService.create(config, github, reviewer());
  try {
    assert.equal(restarted.getDetail(prIdValue).pr.status, "ready");
  } finally {
    await cleanup(restarted, dataDir);
  }
});

test("startup keeps Submitted when no request event is newer than the submission", async () => {
  const { service, github, dataDir, config } = await submittedService();
  const prIdValue = github.current.pr.id;
  await service.close();
  const restarted = await ReviewService.create(config, github, reviewer());
  try {
    assert.equal(restarted.getDetail(prIdValue).pr.status, "submitted");
  } finally {
    await cleanup(restarted, dataDir);
  }
});

test("new commits, saved edits, and a new review leave Submitted behind", async () => {
  const { service, github, dataDir } = await submittedService();
  try {
    const prIdValue = github.current.pr.id;
    const detail = service.getDetail(prIdValue);
    service.updateDraft(prIdValue, {
      draftId: detail.draft!.id,
      version: detail.draft!.version,
      body: "Edited after submitting",
      findings: detail.draft!.findings,
      verdict: "COMMENT",
    });
    assert.equal(service.getDetail(prIdValue).pr.status, "ready");
    await submitLatest(service, prIdValue);
    assert.equal(service.getDetail(prIdValue).pr.status, "submitted");
    github.current = remote("sha-2");
    await service.sync();
    assert.equal(service.getDetail(prIdValue).pr.status, "outdated");
    await service.manualReview(prIdValue);
    await waitFor(() => service.getDetail(prIdValue).pr.status === "ready");
    assert.equal(service.getDetail(prIdValue).submissions.length, 2);
  } finally {
    await cleanup(service, dataDir);
  }
});

test("an uncertain submission never counts as settled", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    github.failSubmit = true;
    await assert.rejects(() => submitLatest(service, prIdValue));
    const detail = service.getDetail(prIdValue);
    assert.equal(detail.submissions[0]?.status, "uncertain");
    assert.equal(detail.pr.status, "ready");
  } finally {
    await cleanup(service, dataDir);
  }
});

async function reviewedTwice() {
  const made = await makeService(false);
  const prIdValue = made.github.current.pr.id;
  await made.service.sync();
  await made.service.manualReview(prIdValue);
  await waitFor(() => made.reviewer.count === 1);
  const older = made.service.getDetail(prIdValue).draft!;
  await made.service.manualReview(prIdValue);
  await waitFor(() => made.service.getDetail(prIdValue).drafts.length === 2);
  const latest = made.service.getDetail(prIdValue).draft!;
  assert.notEqual(latest.id, older.id);
  return { ...made, prIdValue, older, latest };
}

async function restarted(
  service: ReviewService,
  config: AppConfig,
  github: FakeGithub,
) {
  await service.close();
  return ReviewService.create(config, github, reviewer());
}

test("submitting an older same-head draft keeps the newer ready draft active", async () => {
  let { service, github, dataDir, config, prIdValue, older, latest } =
    await reviewedTwice();
  try {
    const preview = await service.preview(prIdValue, older.id, older.version);
    const detail = await service.submit(prIdValue, preview.id);
    assert.equal(detail.submissions[0]?.status, "submitted");
    assert.equal(detail.draft!.id, latest.id);
    assert.equal(detail.pr.status, "ready");
    service = await restarted(service, config, github);
    assert.equal(service.getDetail(prIdValue).pr.status, "ready");
    const settled = await submitLatest(service, prIdValue);
    assert.equal(settled.pr.status, "submitted");
    assert.equal(settled.submissions.length, 2);
    service = await restarted(service, config, github);
    assert.equal(service.getDetail(prIdValue).pr.status, "submitted");
  } finally {
    await cleanup(service, dataDir);
  }
});

test("reconciling an old uncertain write after a saved edit or a new head keeps the PR active", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    const draft = service.getDetail(prIdValue).draft!;
    const preview = await service.preview(prIdValue, draft.id, draft.version);
    github.failSubmit = true;
    await assert.rejects(() => service.submit(prIdValue, preview.id));
    service.updateDraft(prIdValue, {
      draftId: draft.id,
      version: draft.version,
      body: "Edited while the write was uncertain",
      findings: draft.findings,
      verdict: "COMMENT",
    });
    github.reconciliation = {
      githubReviewId: "review-reconciled",
      url: "https://example.invalid/reconciled",
    };
    const edited = await service.submit(prIdValue, preview.id);
    assert.equal(edited.submissions[0]?.status, "submitted");
    assert.equal(edited.pr.status, "ready");
    github.failSubmit = false;
    github.reconciliation = null;
    const again = await service.preview(prIdValue, draft.id, draft.version + 1);
    github.failSubmit = true;
    await assert.rejects(() => service.submit(prIdValue, again.id));
    github.current = remote("sha-2");
    await service.sync();
    assert.equal(service.getDetail(prIdValue).pr.status, "outdated");
    github.reconciliation = {
      githubReviewId: "review-reconciled-2",
      url: "https://example.invalid/reconciled-2",
    };
    const moved = await service.submit(prIdValue, again.id);
    assert.equal(moved.submissions[0]?.status, "submitted");
    assert.equal(moved.pr.status, "outdated");
  } finally {
    await cleanup(service, dataDir);
  }
});

test("a newer uncertain attempt outranks an older successful submission", async () => {
  let { service, github, dataDir, config } = await submittedService();
  try {
    const prIdValue = github.current.pr.id;
    const draft = service.getDetail(prIdValue).draft!;
    const preview = await service.preview(prIdValue, draft.id, draft.version);
    github.failSubmit = true;
    await assert.rejects(() => service.submit(prIdValue, preview.id));
    const detail = service.getDetail(prIdValue);
    assert.equal(detail.submissions[0]?.status, "uncertain");
    assert.equal(detail.submissions[1]?.status, "submitted");
    assert.equal(detail.pr.status, "ready");
    service["db"].setPrStatus(prIdValue, "submitted");
    service = await restarted(service, config, github);
    assert.equal(service.getDetail(prIdValue).pr.status, "ready");
    github.failSubmit = false;
    github.reconciliation = {
      githubReviewId: "review-reconciled",
      url: "https://example.invalid/reconciled",
    };
    const settled = await service.submit(prIdValue, preview.id);
    assert.equal(settled.submissions[0]?.status, "submitted");
    assert.equal(settled.pr.status, "submitted");
  } finally {
    await cleanup(service, dataDir);
  }
});

test("a request recorded during an in-flight write keeps the PR active", async () => {
  const { service, github, reviewer, dataDir } = await makeService(false);
  try {
    service.updateSettings({
      automation: { pollRequests: true, reviewRequests: false },
    });
    github.eventId = "event-0";
    await service.sync();
    const prIdValue = github.current.pr.id;
    await service.manualReview(prIdValue);
    await waitFor(() => reviewer.count === 1);
    github.holdSubmit = true;
    const pending = submitLatest(service, prIdValue);
    await waitFor(() => github.submitCalls === 1);
    assert.equal(
      service.getDetail(prIdValue).submissions[0]?.status,
      "submitting",
    );
    reRequest(github, "event-new", new Date(Date.now() + 60_000).toISOString());
    await service.sync();
    github.releaseSubmit();
    const detail = await pending;
    assert.equal(detail.submissions[0]?.status, "submitted");
    assert.equal(detail.pr.status, "ready");
  } finally {
    await cleanup(service, dataDir);
  }
});

test("a successful submission never clobbers a queued or running review", async () => {
  const { service, github, reviewer, dataDir } = await makeService(false);
  try {
    await service.sync();
    const prIdValue = github.current.pr.id;
    await service.manualReview(prIdValue);
    await waitFor(() => reviewer.count === 1);
    reviewer.hold = true;
    await service.manualReview(prIdValue);
    await waitFor(() => reviewer.inputs.length === 2);
    assert.equal(service.getDetail(prIdValue).pr.status, "reviewing");
    const detail = await submitLatest(service, prIdValue);
    assert.equal(detail.submissions[0]?.status, "submitted");
    assert.equal(detail.pr.status, "reviewing");
    reviewer.release();
    await waitFor(() => service.getDetail(prIdValue).drafts.length === 2);
    assert.equal(service.getDetail(prIdValue).pr.status, "ready");
  } finally {
    reviewer.release();
    await cleanup(service, dataDir);
  }
});

test("malformed reviewer output fails the immutable run", async () => {
  const { service, reviewer, github, dataDir } = await makeService();
  reviewer.malformed = true;
  try {
    await service.sync();
    await waitFor(
      () =>
        service.getDetail(github.current.pr.id).runs[0]?.status === "failed",
    );
    const detail = service.getDetail(github.current.pr.id);
    assert.equal(detail.runs[0].status, "failed");
    assert.equal(detail.draft, null);
  } finally {
    await cleanup(service, dataDir);
  }
});

test("preview anchors only new-side rows inside real hunk boundaries", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    github.current = {
      ...remote(),
      diff: [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " keep",
        "-old",
        "+++counter",
        " tail",
        "@@ -20,2 +20 @@",
        " ctx",
        "-gone",
        "\\ No newline at end of file",
        "diff --git a/src/gone.ts b/src/gone.ts",
        "deleted file mode 100644",
        "index 3333333..0000000",
        "--- a/src/gone.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-first",
        "-second",
        "diff --git a/src/b.ts b/src/b.ts",
        "index 4444444..5555555 100644",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -5,2 +5,3 @@",
        " before",
        "+inserted",
        " after",
        "",
      ].join("\n"),
    };
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    const draft = service.getDetail(prIdValue).draft!;
    const at = (id: string, path: string | null, line: number | null) => ({
      ...finding(id),
      path,
      line,
      body: `Claim ${id}.`,
    });
    const edited = service.updateDraft(prIdValue, {
      draftId: draft.id,
      version: draft.version,
      body: "Summary.",
      verdict: "COMMENT",
      findings: [
        at("a-keep", "src/a.ts", 1),
        at("a-plusplus", "src/a.ts", 2),
        at("a-tail", "src/a.ts", 3),
        at("a-after-hunk", "src/a.ts", 4),
        at("a-ctx", "src/a.ts", 20),
        at("a-deleted-row", "src/a.ts", 21),
        at("a-metadata-drift", "src/a.ts", 22),
        at("a-far", "src/a.ts", 23),
        at("gone", "src/gone.ts", 1),
        at("b-before", "src/b.ts", 5),
        at("b-inserted", "src/b.ts", 6),
        at("b-after", "src/b.ts", 7),
        at("b-trailing-blank", "src/b.ts", 8),
      ],
    }).draft!;
    const preview = await service.preview(prIdValue, edited.id, edited.version);
    assert.deepEqual(
      preview.payload.comments.map(
        (comment) => `${comment.path}:${comment.line}`,
      ),
      [
        "src/a.ts:1",
        "src/a.ts:2",
        "src/a.ts:3",
        "src/a.ts:20",
        "src/b.ts:5",
        "src/b.ts:6",
        "src/b.ts:7",
      ],
    );
    assert.deepEqual(
      [...preview.payload.body.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
      [
        "src/a.ts:4",
        "src/a.ts:21",
        "src/a.ts:22",
        "src/a.ts:23",
        "src/gone.ts:1",
        "src/b.ts:8",
      ],
    );
  } finally {
    await cleanup(service, dataDir);
  }
});

test("preview relabels prelabelled findings from the selected severity", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    github.current = {
      ...remote(),
      diff: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "+added",
        "",
      ].join("\n"),
    };
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    const draft = service.getDetail(prIdValue).draft!;
    const findings: Finding[] = [
      {
        ...finding("bold-to-non"),
        severity: "non_blocking",
        line: 2,
        body: "**Blocking.** Switched down after review.",
      },
      {
        ...finding("plain-to-blocking"),
        severity: "blocking",
        line: 1,
        body: "Non-blocking: switched up.\n- consequence\n- second point",
      },
      {
        ...finding("body-bold"),
        severity: "blocking",
        line: 9,
        origin: "pre_existing",
        body: "**Non-blocking:** Pre-existing. Label lost its origin.",
      },
      {
        ...finding("body-plain"),
        severity: "non_blocking",
        path: null,
        line: null,
        body: "blocking. lowercase plain label\nwith a second line",
      },
      {
        ...finding("prose"),
        severity: "non_blocking",
        line: 9,
        body: "Blocking the event loop here is fine for a CLI.",
      },
      {
        ...finding("kept"),
        severity: "blocking",
        line: 2,
        body: "**Blocking.** Unchanged label stays once.",
      },
    ];
    const edited = service.updateDraft(prIdValue, {
      draftId: draft.id,
      version: draft.version,
      body: "Summary.",
      verdict: "REQUEST_CHANGES",
      findings,
    }).draft!;
    assert.deepEqual(
      edited.findings.map((item) => item.body),
      findings.map((item) => item.body),
    );
    const preview = await service.preview(prIdValue, edited.id, edited.version);
    assert.deepEqual(
      preview.payload.comments.map((comment) => comment.body),
      [
        "**Non-blocking.** Switched down after review.",
        "**Blocking.** switched up.\n- consequence\n- second point",
        "**Blocking.** Unchanged label stays once.",
      ],
    );
    assert.equal(
      preview.payload.body,
      [
        "Summary.",
        "**Blocking.** `src/a.ts:9` Pre-existing. Label lost its origin.",
        "**Non-blocking.** lowercase plain label\nwith a second line",
        "**Non-blocking.** `src/a.ts:9` Blocking the event loop here is fine for a CLI.",
      ].join("\n\n"),
    );
    assert.deepEqual(
      service.getDetail(prIdValue).draft!.findings.map((item) => item.body),
      findings.map((item) => item.body),
    );
  } finally {
    await cleanup(service, dataDir);
  }
});

test("runs persist ordered phases, bounded activity, and the manual sync preflight", async () => {
  const { service, github, reviewer, dataDir, config } =
    await makeService(false);
  try {
    await service.sync();
    await service.manualReview(github.current.pr.id);
    await waitFor(
      () =>
        service.getDetail(github.current.pr.id).runs[0]?.status === "completed",
    );
    const run = service.getDetail(github.current.pr.id).runs[0]!;
    assert.deepEqual(
      run.progress!.phases.map((phase) => [phase.id, phase.status]),
      [
        ["sync", "completed"],
        ["checkout", "completed"],
        ["codex", "skipped"],
        ["claude", "completed"],
        ["finalize", "completed"],
      ],
    );
    assert.equal(run.progress!.phases[0]!.detail, "head sha-1");
    assert.ok(run.progress!.phases[0]!.finishedAt! <= run.createdAt);
    assert.equal(run.progress!.phases[4]!.detail, "draft created");
    assert.ok(
      run.progress!.activity.some((a) => a.label === "Reading src/a.ts"),
    );
    assert.equal(run.progress!.activityCount, run.progress!.activity.length);
    assert.equal(reviewer.count, 1);
    await service.close();
    const restarted = await ReviewService.create(config, github, reviewer);
    try {
      const persisted = restarted.getDetail(github.current.pr.id).runs[0]!;
      assert.deepEqual(persisted.progress, run.progress);
    } finally {
      await cleanup(restarted, dataDir);
    }
  } catch (error) {
    await cleanup(service, dataDir);
    throw error;
  }
});

test("request-triggered reviews and revisions carry only the phases actually performed", async () => {
  const { service, github, reviewer, dataDir } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    const prIdValue = github.current.pr.id;
    const review = service.getDetail(prIdValue).runs[0]!;
    assert.equal(review.progress!.phases[0]!.id, "checkout");
    const draft = service.getDetail(prIdValue).draft!;
    service.revise(prIdValue, {
      draftId: draft.id,
      draftVersion: draft.version,
      instructions: "Tighten the wording",
    });
    await waitFor(
      () => service.getDetail(prIdValue).runs[0]?.status === "completed",
    );
    const revision = service.getDetail(prIdValue).runs[0]!;
    assert.equal(revision.kind, "revision");
    assert.deepEqual(
      revision.progress!.phases.map((phase) => phase.id),
      ["checkout", "codex", "claude", "finalize"],
    );
    assert.equal(revision.progress!.phases.at(-1)!.detail, "proposal created");
  } finally {
    await cleanup(service, dataDir);
  }
});

test("a failed run marks its running phase failed and a stopped backend marks it interrupted", async () => {
  const { service, github, reviewer, dataDir, config } = await makeService();
  reviewer.malformed = true;
  try {
    await service.sync();
    await waitFor(
      () =>
        service.getDetail(github.current.pr.id).runs[0]?.status === "failed",
    );
    const failed = service.getDetail(github.current.pr.id).runs[0]!;
    const finalize = failed.progress!.phases.at(-1)!;
    assert.equal(finalize.id, "finalize");
    assert.equal(finalize.status, "failed");
    assert.match(finalize.detail!, /Isolated harness execution failed/);
    reviewer.malformed = false;
    reviewer.hold = true;
    github.eventId = "event-2";
    await service.sync();
    await waitFor(
      () =>
        service.getDetail(github.current.pr.id).runs[0]?.status === "running",
    );
    const live = service.getDetail(github.current.pr.id).runs[0]!;
    assert.equal(live.progress!.phases.at(-1)!.id, "claude");
    assert.equal(live.progress!.phases.at(-1)!.status, "running");
    await service.close();
    const restarted = await ReviewService.create(config, github, reviewer);
    reviewer.hold = false;
    try {
      const stopped = restarted.getDetail(github.current.pr.id).runs[0]!;
      assert.equal(stopped.status, "interrupted");
      assert.equal(stopped.progress!.phases.at(-1)!.id, "claude");
      assert.equal(stopped.progress!.phases.at(-1)!.status, "interrupted");
      assert.ok(stopped.progress!.phases.at(-1)!.finishedAt);
      assert.ok(
        stopped.progress!.phases.every((phase) => phase.status !== "running"),
      );
    } finally {
      await cleanup(restarted, dataDir);
    }
  } catch (error) {
    reviewer.release();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
});

test("runs stored before progress existed stay readable with no progress", async () => {
  const { service, github, reviewer, dataDir, config } = await makeService();
  try {
    await service.sync();
    await waitFor(() => reviewer.count === 1);
    service.db.sqlite.prepare("UPDATE runs SET progress_json = NULL").run();
    service.db.sqlite
      .prepare(
        "UPDATE runs SET status = 'running', finished_at = NULL, progress_json = NULL",
      )
      .run();
    await service.close();
    const restarted = await ReviewService.create(config, github, reviewer);
    try {
      const run = restarted.getDetail(github.current.pr.id).runs[0]!;
      assert.equal(run.progress, null);
      assert.equal(run.status, "interrupted");
    } finally {
      await cleanup(restarted, dataDir);
    }
  } catch (error) {
    await cleanup(service, dataDir);
    throw error;
  }
});

test("progress updates are persisted and emitted at a bounded rate", async () => {
  const { service, github, reviewer, dataDir } = await makeService(false);
  let emitted = 0;
  const stop = service.onChange(() => {
    emitted += 1;
  });
  reviewer.run = async (
    input: ReviewerInput,
    _settings: ReviewerSettings,
    _runId: string,
    _signal?: AbortSignal,
    progress?: ProgressReporter,
  ) => {
    reviewer.inputs.push(input);
    progress?.phase("claude", "running");
    for (let i = 0; i < 2_000; i += 1)
      progress?.activity("claude", "read", `Reading file-${i}.ts`);
    progress?.phase("claude", "completed");
    return {
      result: {
        overview: "o",
        body: "b",
        findings: [],
        verdict: "COMMENT" as const,
        rationale: "r",
      },
      log: "fake",
    };
  };
  try {
    await service.sync();
    await service.manualReview(github.current.pr.id);
    await waitFor(
      () =>
        service.getDetail(github.current.pr.id).runs[0]?.status === "completed",
    );
    const run = service.getDetail(github.current.pr.id).runs[0]!;
    assert.equal(run.progress!.activityCount, 2_000 + 5);
    assert.equal(run.progress!.activity.length, 40);
    assert.ok(emitted < 30, `emitted ${emitted} change events`);
  } finally {
    stop();
    await cleanup(service, dataDir);
  }
});

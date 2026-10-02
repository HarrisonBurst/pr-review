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
  type Finding,
  type MergeReadiness,
  type PullRequest,
  type PullRequestDetail,
  type ReviewResult,
  type ReviewRun,
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
import { AppDatabase } from "../db.js";
import { createHttpServer } from "../http.js";
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

const HEAD1 = "3f9507c800fad6490fb374d33e0816dc34988c58";
const HEAD2 = "6a148d78b6739f41f47a9b624538e767768be05b";
const PR = prId("owner/repo", 20452);

function remote(headSha = "sha-1"): RemotePullRequest {
  const pr: PullRequest = {
    id: PR,
    number: 20452,
    repository: "owner/repo",
    url: "https://github.com/owner/repo/pull/20452",
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
    historicalRequestSource: null,
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
    hasReviewHistory: false,
    mergeReadiness: null,
    automation: inheritAutomation,
    effectiveAutomation: automationOff,
  };
  return {
    pr,
    diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+line from ${headSha}\n`,
    diffTruncated: false,
  };
}

const finding = (id: string, evidence = "Evidence"): Finding => ({
  id,
  severity: "non_blocking",
  path: "src/a.ts",
  line: 1,
  body: `Finding ${id}`,
  evidence,
  origin: "introduced",
  included: true,
  startLine: null,
  side: "RIGHT",
  questionId: null,
});

class FakeGithub implements GithubAdapter {
  readonly demo = false;
  current = remote();
  submitCalls = 0;
  tracked: PullRequest[] = [];
  async health() {
    return { user: "tester", message: "fake" };
  }
  async getPullRequest() {
    return this.current;
  }
  async poll(_repository: string, known: PullRequest[]): Promise<PollResult> {
    this.tracked = known;
    return { user: "tester", pullRequests: [this.current], requests: [] };
  }
  async submitReview() {
    this.submitCalls += 1;
    return { githubReviewId: "review-1", url: null };
  }
  async compareCommits(): Promise<CommitComparison> {
    return { status: "ahead", commits: [], truncated: false };
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
  fail = false;
  hold = false;
  overview: string | null = null;
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
    if (this.fail) throw new Error("reviewer exploded");
    const n = this.count;
    const result: ReviewResult = input.instructions
      ? {
          overview: input.draft!.overview,
          body: `Revised ${n}: ${input.instructions}`,
          findings: input.draft!.findings.map((item) => ({
            ...item,
            body: `${item.body} (revised ${n})`,
            evidence: `- revision ${n} rechecked ${item.path}`,
          })),
          verdict: input.draft!.verdict,
          rationale: "revision",
        }
      : {
          overview: this.overview ?? `- Overview ${n} of ${input.pr.headSha}`,
          body: `Review ${n} of ${input.pr.headSha}`,
          findings: [finding(`finding-${n}`, `- evidence ${n}`)],
          verdict: "COMMENT",
          rationale: "fixture",
        };
    return { result, log: "fake reviewer" };
  }
}

async function makeService(dataDir?: string) {
  dataDir ??= await mkdtemp(join(tmpdir(), "pr-review-drafts-"));
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
  return { service, github, reviewer, config, dataDir, cleanup };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting");
}

async function reviewed(
  service: ReviewService,
  github: FakeGithub,
  reviewer: FakeReviewer,
  headSha: string,
  requestSource: PullRequest["requestSource"] = "direct",
) {
  github.current = remote(headSha);
  github.current.pr.requestSource = requestSource;
  const before = reviewer.count;
  await service.manualReview(PR);
  await waitFor(
    () =>
      reviewer.count === before + 1 &&
      service.getDetail(PR).runs[0]?.status !== "running" &&
      service.getDetail(PR).runs[0]?.status !== "queued",
  );
  return service.getDetail(PR);
}

function completedRun(
  over: Partial<ReviewRun> & Pick<ReviewRun, "id">,
): ReviewRun {
  return {
    prId: PR,
    kind: "review",
    trigger: "manual",
    requestEventId: null,
    status: "completed",
    headSha: HEAD1,
    baseSha: "base-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    error: null,
    log: "deterministic projection fixture",
    autoSubmission: null,
    reviewer: reviewerSettings,
    result: {
      overview: "Fixture overview",
      body: "Fixture review",
      findings: [],
      verdict: "COMMENT",
      rationale: "Fixture",
    },
    integrationSnapshot: { boundary: "read-only-gateway", connections: [] },
    progress: null,
    ...over,
  };
}

function assertReviewedHead(service: ReviewService, expected: boolean): void {
  assert.equal(service.getDetail(PR).pr.hasReviewedHead, expected);
  assert.equal(
    service.getState().prs.find((pr) => pr.id === PR)?.hasReviewedHead,
    expected,
  );
  assert.equal(
    service.db.listPrs().find((pr) => pr.id === PR)?.hasReviewedHead,
    expected,
  );
}

test("reviewed-head projection requires a completed full review of this PR's exact head", async () => {
  const { service, cleanup } = await makeService();
  try {
    const item = remote(HEAD1);
    item.pr.hasReviewedHead = true;
    item.pr.lastReviewedAt = "2026-01-01T00:00:02.000Z";
    service.db.upsertPr(item.pr, item.diff, false);
    assertReviewedHead(service, false);
    service.db.upsertPr({ ...item.pr, id: "other-pr" }, item.diff, false);
    const excluded: Partial<ReviewRun>[] = [
      { headSha: HEAD2 },
      { headSha: HEAD1.slice(0, 7) },
      { prId: "other-pr" },
      { kind: "revision", trigger: "revision" },
      { result: null },
      { status: "queued", result: null, finishedAt: null },
      { status: "running", result: null, finishedAt: null },
      { status: "failed", error: "Fixture failure" },
      { status: "interrupted", error: "Fixture interruption" },
    ];
    for (const [index, over] of excluded.entries()) {
      service.db.createRun(completedRun({ id: `excluded-${index}`, ...over }));
      assertReviewedHead(service, false);
    }
    service.db.createRun(completedRun({ id: "success" }));
    assertReviewedHead(service, true);
  } finally {
    await cleanup();
  }
});

test("reviewed-head success survives later retries, revisions, draft edits and restart", async () => {
  const { service, config, dataDir } = await makeService();
  let current = service;
  try {
    const item = remote(HEAD1);
    current.db.upsertPr(item.pr, item.diff, false);
    const success = completedRun({ id: "success" });
    current.db.createRun(success);
    const local = current.createManualDraft(PR).draft!;
    current.updateDraft(PR, {
      draftId: local.id,
      version: local.version,
      body: "Manual edits stay intact",
      findings: [],
      verdict: "COMMENT",
    });
    const later: Partial<ReviewRun>[] = [
      { status: "failed", error: "Retry failed", result: null },
      { kind: "revision", trigger: "revision" },
      { kind: "revision", trigger: "revision", status: "failed", result: null },
      { status: "queued", result: null, finishedAt: null },
      { status: "running", result: null, finishedAt: null },
      { status: "interrupted", result: null },
    ];
    for (const [index, over] of later.entries()) {
      current.db.createRun(
        completedRun({
          id: `later-${index}`,
          createdAt: "2026-01-02T00:00:00.000Z",
          ...over,
        }),
      );
      assertReviewedHead(current, true);
    }
    const statuses: PullRequest["status"][] = [
      "unreviewed",
      "ready",
      "outdated",
      "submitted",
      "failed",
      "queued",
      "reviewing",
    ];
    for (const status of statuses) {
      current.db.setPrStatus(PR, status);
      assertReviewedHead(current, true);
    }
    await current.close();
    current = await ReviewService.create(
      config,
      new FakeGithub(),
      new FakeReviewer(),
    );
    assertReviewedHead(current, true);
    assert.deepEqual(current.db.getRun(success.id), success);
    assert.equal(
      current.db.getDraft(PR, local.id)?.body,
      "Manual edits stay intact",
    );
  } finally {
    await current.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a newer-head local draft is not a reviewed head, including after restart", async () => {
  const { service, config, dataDir } = await makeService();
  let current = service;
  try {
    const original = remote(HEAD1);
    current.db.upsertPr(original.pr, original.diff, false);
    current.db.createRun(completedRun({ id: "old-head-success" }));
    current.db.setPrReviewTimestamp(PR, "2026-01-01T00:00:02.000Z");
    assertReviewedHead(current, true);
    const newer = remote(HEAD2);
    current.db.upsertPr(newer.pr, newer.diff, false);
    assertReviewedHead(current, false);
    current.db.createRun(
      completedRun({
        id: "new-head-revision",
        kind: "revision",
        trigger: "revision",
        headSha: HEAD2,
      }),
    );
    const detail = current.createManualDraft(PR);
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.draft?.headSha, HEAD2);
    assert.ok(detail.pr.lastReviewedAt);
    assertReviewedHead(current, false);
    await current.close();
    current = await ReviewService.create(
      config,
      new FakeGithub(),
      new FakeReviewer(),
    );
    assertReviewedHead(current, false);
    current.db.upsertPr(original.pr, original.diff, false);
    assertReviewedHead(current, true);
  } finally {
    await current.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

const legacyDdl = `
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), repository TEXT NOT NULL, polling_enabled INTEGER NOT NULL, poll_commits INTEGER NOT NULL DEFAULT 0, review_new_commits INTEGER NOT NULL DEFAULT 0, poll_requests INTEGER NOT NULL DEFAULT 0, review_requests INTEGER NOT NULL DEFAULT 0, poll_interval_seconds INTEGER NOT NULL, skill_path TEXT NOT NULL, reviewer_model TEXT, additional_instructions TEXT NOT NULL);
CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), initialized INTEGER NOT NULL, last_poll_at TEXT, poll_error TEXT);
CREATE TABLE prs (id TEXT PRIMARY KEY, number INTEGER NOT NULL, repository TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, author_avatar_url TEXT, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, head_ref TEXT NOT NULL, base_ref TEXT NOT NULL, state TEXT NOT NULL, requested INTEGER NOT NULL, requested_at TEXT, updated_at TEXT NOT NULL, status TEXT NOT NULL, blocking_count INTEGER NOT NULL, non_blocking_count INTEGER NOT NULL, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, changed_files INTEGER NOT NULL, last_reviewed_at TEXT, diff TEXT NOT NULL, diff_truncated INTEGER NOT NULL, automation_json TEXT NOT NULL DEFAULT '{}', auto_commit_head TEXT, auto_requests_armed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE runs (id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE, kind TEXT NOT NULL, trigger TEXT NOT NULL, request_event_id TEXT, status TEXT NOT NULL, head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT, log TEXT NOT NULL, reviewer_json TEXT NOT NULL, result_json TEXT);
CREATE TABLE run_snapshots (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, pr_json TEXT NOT NULL, diff TEXT NOT NULL, diff_truncated INTEGER NOT NULL);
CREATE TABLE drafts (pr_id TEXT PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs(id), head_sha TEXT NOT NULL, version INTEGER NOT NULL, summary TEXT NOT NULL, findings_json TEXT NOT NULL, verdict TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES runs(id), source_draft_version INTEGER NOT NULL, instructions TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE previews (id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE, draft_version INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE submissions (id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE, preview_id TEXT NOT NULL REFERENCES previews(id), status TEXT NOT NULL, payload_json TEXT NOT NULL, github_review_id TEXT, url TEXT, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT);
CREATE TABLE head_checks (pr_id TEXT PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE, baseline TEXT NOT NULL, head TEXT NOT NULL, status TEXT NOT NULL, commits_json TEXT NOT NULL, truncated INTEGER NOT NULL, checked_at TEXT NOT NULL, error TEXT);
CREATE TABLE request_events (event_id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE, head_sha TEXT NOT NULL, requested_at TEXT NOT NULL, seen_at TEXT NOT NULL);
`;

interface LegacySeed {
  headSha?: string;
  status?: PullRequest["status"];
  state?: PullRequest["state"];
  revision?: "none" | "before_review" | "after_review" | "ambiguous";
  submitted?: "latest" | "superseded";
}

function seedLegacy(databasePath: string, seed: LegacySeed = {}): void {
  const revision = seed.revision ?? "none";
  const latestSubmitted = seed.submitted === "latest";
  const db = new DatabaseSync(databasePath);
  db.exec(legacyDdl);
  db.prepare(
    "INSERT INTO settings VALUES (1, 'owner/repo', 0, 0, 0, 0, 0, 300, '/tmp/skill/SKILL.md', NULL, '')",
  ).run();
  db.prepare("INSERT INTO meta VALUES (1, 1, NULL, NULL)").run();
  const reviewer = JSON.stringify(reviewerSettings);
  const legacyResult = (label: string) =>
    JSON.stringify({
      summary: `${label} legacy summary`,
      findings: [finding(`f-${label}`)],
      verdict: "COMMENT",
      rationale: "legacy",
    });
  db.prepare(
    `INSERT INTO prs (id, number, repository, url, title, body, author, author_avatar_url, head_sha, base_sha, head_ref, base_ref, state, requested, requested_at, updated_at, status, blocking_count, non_blocking_count, additions, deletions, changed_files, last_reviewed_at, diff, diff_truncated)
     VALUES (?, 20452, 'owner/repo', 'https://github.com/owner/repo/pull/20452', 'Fixture PR', 'Fixture', 'author', NULL, ?, 'base-1', 'feature', 'main', ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, 1, 0, 1, 0, 1, '2026-09-23T06:32:24.861Z', '', 0)`,
  ).run(
    PR,
    seed.headSha ?? (latestSubmitted ? HEAD1 : HEAD2),
    seed.state ?? "OPEN",
    seed.status ?? "outdated",
  );
  const insertRun = db.prepare(
    "INSERT INTO runs VALUES (?, ?, ?, ?, NULL, ?, ?, 'base-1', ?, ?, ?, NULL, 'log', ?, ?)",
  );
  const review = (
    id: string,
    status: string,
    head: string,
    created: string,
    finished: string,
    result: string | null,
  ) =>
    insertRun.run(
      id,
      PR,
      "review",
      "manual",
      status,
      head,
      created,
      created.replace(/:\d\d\.\d+Z$/, ":30.000Z"),
      finished,
      reviewer,
      result,
    );
  const revise = (
    id: string,
    head: string,
    created: string,
    finished: string,
  ) =>
    insertRun.run(
      id,
      PR,
      "revision",
      "revision",
      "completed",
      head,
      created,
      created,
      finished,
      reviewer,
      legacyResult(id),
    );
  review(
    "run-1",
    "completed",
    HEAD1,
    "2026-09-23T06:23:58.809Z",
    "2026-09-23T06:32:24.861Z",
    legacyResult("run1"),
  );
  if (revision === "ambiguous")
    review(
      "run-1b",
      "completed",
      HEAD1,
      "2026-09-23T06:40:00.000Z",
      "2026-09-23T06:48:00.000Z",
      legacyResult("run1b"),
    );
  const revisedAfter = revision === "after_review";
  if (revision !== "none")
    revise(
      "rev-1",
      revisedAfter ? HEAD2 : HEAD1,
      revisedAfter ? "2026-09-23T17:30:00.000Z" : "2026-09-23T07:10:00.000Z",
      revisedAfter ? "2026-09-23T17:35:00.000Z" : "2026-09-23T07:20:00.000Z",
    );
  revise(
    "rev-2",
    HEAD1,
    "2026-09-23T07:40:00.000Z",
    "2026-09-23T07:45:00.000Z",
  );
  if (!latestSubmitted)
    review(
      "run-2",
      "completed",
      HEAD2,
      "2026-09-23T16:56:58.821Z",
      "2026-09-23T17:04:12.009Z",
      legacyResult("run2"),
    );
  review(
    "run-3",
    "failed",
    HEAD2,
    "2026-09-23T18:00:00.000Z",
    "2026-09-23T18:00:02.000Z",
    null,
  );
  const runs = db.prepare("SELECT id, head_sha FROM runs").all() as Array<{
    id: string;
    head_sha: string;
  }>;
  for (const run of runs)
    db.prepare("INSERT INTO run_snapshots VALUES (?, ?, '', 0)").run(
      run.id,
      JSON.stringify(remote(run.head_sha).pr),
    );
  const draftVersion = revision === "none" ? 2 : 3;
  db.prepare(
    "INSERT INTO drafts VALUES (?, 'draft-legacy', ?, ?, ?, 'Hand edited legacy summary', ?, 'APPROVE', '2026-09-23T07:50:00.000Z')",
  ).run(
    PR,
    revision === "none" ? "run-1" : "rev-1",
    HEAD1,
    draftVersion,
    JSON.stringify([
      { ...finding("f-run1"), severity: "blocking", body: "Edited by hand" },
    ]),
  );
  if (revision !== "none")
    db.prepare(
      "INSERT INTO proposals VALUES ('proposal-accepted', ?, 'rev-1', 1, 'reword', 'accepted', ?, '2026-09-23T07:20:00.000Z')",
    ).run(PR, legacyResult("rev-1"));
  db.prepare(
    "INSERT INTO previews VALUES ('preview-legacy', ?, 1, ?, '2026-09-23T06:46:52.786Z')",
  ).run(
    PR,
    JSON.stringify({
      event: "COMMENT",
      body: "legacy body",
      commit_id: HEAD1,
      comments: [],
    }),
  );
  db.prepare(
    "INSERT INTO proposals VALUES ('proposal-legacy', ?, 'rev-2', ?, 'tighten', 'pending', ?, '2026-09-23T07:45:00.000Z')",
  ).run(PR, draftVersion, legacyResult("proposal"));
  if (latestSubmitted)
    db.prepare(
      "INSERT INTO previews VALUES ('preview-latest', ?, ?, ?, '2026-09-23T07:55:00.000Z')",
    ).run(
      PR,
      draftVersion,
      JSON.stringify({
        event: "APPROVE",
        body: "Hand edited legacy summary",
        commit_id: HEAD1,
        comments: [],
      }),
    );
  if (seed.submitted)
    db.prepare(
      "INSERT INTO submissions VALUES ('submission-legacy', ?, ?, 'submitted', ?, 'review-legacy', 'https://example.invalid/review', NULL, ?)",
    ).run(
      PR,
      latestSubmitted ? "preview-latest" : "preview-legacy",
      JSON.stringify({
        event: latestSubmitted ? "APPROVE" : "COMMENT",
        body: "legacy body",
        commit_id: HEAD1,
        comments: [],
      }),
      latestSubmitted ? "2026-09-23T07:56:00.000Z" : "2026-09-23T06:47:00.000Z",
    );
  db.close();
}

async function migrated(seed: LegacySeed = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-legacy-"));
  seedLegacy(join(dataDir, "app.sqlite"), seed);
  return makeService(dataDir);
}

test("legacy single-draft databases migrate to per-run drafts idempotently", async () => {
  const { service, cleanup, config, github, reviewer } = await migrated();
  try {
    const detail = service.getDetail(PR);
    assert.equal(detail.drafts.length, 2);
    assert.equal(detail.draft?.runId, "run-2");
    assert.equal(detail.draft?.headSha, HEAD2);
    assert.equal(detail.draft?.version, 1);
    assert.equal(detail.draft?.overview, "");
    assert.equal(detail.draft?.body, "run2 legacy summary");
    assert.equal(detail.draft?.createdAt, "2026-09-23T17:04:12.009Z");
    const legacy = detail.drafts[1]!;
    assert.equal(legacy.id, "draft-legacy");
    assert.equal(legacy.runId, "run-1");
    assert.equal(legacy.version, 2);
    assert.equal(legacy.overview, "");
    assert.equal(legacy.body, "Hand edited legacy summary");
    assert.equal(legacy.findings[0]?.body, "Edited by hand");
    assert.equal(legacy.verdict, "APPROVE");
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.pr.blockingCount, 0);
    assert.equal(detail.pr.nonBlockingCount, 1);
    assert.equal(detail.pr.lastReviewedAt, "2026-09-23T17:04:12.009Z");
    const inbox = service.getState().prs[0]!;
    assert.deepEqual(
      [inbox.status, inbox.blockingCount, inbox.nonBlockingCount],
      ["ready", 0, 1],
    );
    assert.equal(
      detail.runs.find((run) => run.id === "run-1")?.result?.body,
      "run1 legacy summary",
    );
    assert.equal(
      detail.runs.find((run) => run.id === "run-1")?.result?.overview,
      "",
    );
    assert.equal(
      detail.runs.find((run) => run.id === "run-3")?.status,
      "failed",
    );
    assert.equal(detail.proposals[0]?.draftId, "draft-legacy");
    assert.equal(detail.proposals[0]?.result.body, "proposal legacy summary");
    assert.equal(
      service.db.getPreview("preview-legacy")?.draftId,
      "draft-legacy",
    );

    await service.close();
    const restarted = await ReviewService.create(config, github, reviewer);
    const again = restarted.getDetail(PR);
    assert.equal(again.drafts.length, 2);
    assert.deepEqual(
      again.drafts.map((draft) => [draft.id, draft.runId, draft.version]),
      detail.drafts.map((draft) => [draft.id, draft.runId, draft.version]),
    );
    assert.equal(again.drafts[1]?.body, "Hand edited legacy summary");
    assert.deepEqual(
      [again.pr.status, again.pr.blockingCount, again.pr.lastReviewedAt],
      ["ready", 0, "2026-09-23T17:04:12.009Z"],
    );
    await restarted.close();
  } finally {
    await cleanup().catch(() => undefined);
  }
});

test("migration projects a stale latest head as outdated with the latest draft's counts", async () => {
  const { service, cleanup } = await migrated({
    headSha: "head-3",
    status: "ready",
  });
  try {
    const detail = service.getDetail(PR);
    assert.equal(detail.draft?.runId, "run-2");
    assert.equal(detail.pr.status, "outdated");
    assert.equal(detail.pr.blockingCount, 0);
    assert.equal(detail.pr.nonBlockingCount, 1);
    assert.equal(detail.pr.lastReviewedAt, "2026-09-23T17:04:12.009Z");
  } finally {
    await cleanup();
  }
});

test("migration keeps lifecycle statuses that are not derived from drafts", async () => {
  for (const seed of [
    { status: "failed" as const, expected: "failed", blocking: 0 },
    {
      status: "submitted" as const,
      submitted: "latest" as const,
      expected: "submitted",
      blocking: 1,
    },
    {
      status: "submitted" as const,
      submitted: "superseded" as const,
      expected: "ready",
      blocking: 0,
    },
    { status: "submitted" as const, expected: "ready", blocking: 0 },
    { status: "queued" as const, expected: "queued", blocking: 0 },
  ]) {
    const { service, cleanup } = await migrated(seed);
    try {
      const detail = service.getDetail(PR);
      assert.equal(detail.pr.status, seed.expected);
      assert.equal(detail.pr.blockingCount, seed.blocking);
      assert.equal(detail.pr.nonBlockingCount, 1 - seed.blocking);
      if (seed.submitted)
        assert.equal(detail.submissions[0]?.status, "submitted");
    } finally {
      await cleanup();
    }
  }
});

test("migration keeps a merged pull request on its reviewed commit ready, not outdated", async () => {
  const { service, cleanup } = await migrated({
    status: "outdated",
    state: "MERGED",
  });
  try {
    assert.equal(service.getDetail(PR).pr.status, "ready");
  } finally {
    await cleanup();
  }
});

test("a legacy draft revised before a newer review keeps its edits under its originating review", async () => {
  const { service, cleanup, config, github, reviewer } = await migrated({
    revision: "before_review",
  });
  try {
    const detail = service.getDetail(PR);
    assert.deepEqual(
      detail.drafts.map((draft) => [draft.id, draft.runId, draft.version]),
      [
        [detail.drafts[0]!.id, "run-2", 1],
        ["draft-legacy", "run-1", 3],
      ],
    );
    assert.equal(detail.drafts[1]?.body, "Hand edited legacy summary");
    assert.equal(detail.drafts[1]?.findings[0]?.body, "Edited by hand");
    assert.equal(detail.drafts[1]?.headSha, HEAD1);
    assert.ok(!detail.drafts.some((draft) => draft.runId === "rev-1"));
    const accepted = detail.proposals.find(
      (item) => item.id === "proposal-accepted",
    );
    assert.deepEqual(
      [accepted?.status, accepted?.runId, accepted?.draftId],
      ["accepted", "rev-1", "draft-legacy"],
    );
    assert.deepEqual(
      [detail.pr.status, detail.pr.blockingCount, detail.pr.nonBlockingCount],
      ["ready", 0, 1],
    );

    const latest = detail.draft!;
    const pending = detail.proposals.find((item) => item.status === "pending")!;
    assert.equal(pending.draftId, "draft-legacy");
    assert.throws(
      () => service.applyProposal(PR, pending.id, latest.version),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "draft_conflict",
    );
    const applied = service.applyProposal(PR, pending.id, 3);
    assert.equal(applied.draft?.id, latest.id);
    assert.equal(applied.draft?.body, "run2 legacy summary");
    assert.equal(applied.drafts[1]?.body, "proposal legacy summary");
    assert.equal(applied.drafts[1]?.version, 4);
    assert.equal(applied.drafts[1]?.runId, "run-1");
    await assert.rejects(
      () => service.submit(PR, "preview-legacy"),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "draft_conflict",
    );
    assert.equal(github.submitCalls, 0);

    await service.close();
    const restarted = await ReviewService.create(config, github, reviewer);
    const again = restarted.getDetail(PR);
    assert.deepEqual(
      again.drafts.map((draft) => [draft.id, draft.runId, draft.version]),
      [
        [latest.id, "run-2", 1],
        ["draft-legacy", "run-1", 4],
      ],
    );
    await restarted.close();
  } finally {
    await cleanup().catch(() => undefined);
  }
});

test("revision activity after a newer review never outranks that review", async () => {
  const { service, cleanup } = await migrated({ revision: "after_review" });
  try {
    const detail = service.getDetail(PR);
    assert.deepEqual(
      detail.drafts.map((draft) => draft.runId),
      ["run-2", "run-1"],
    );
    assert.equal(detail.drafts[1]?.id, "draft-legacy");
    assert.equal(detail.drafts[1]?.body, "Hand edited legacy summary");
    assert.deepEqual(
      [detail.pr.status, detail.pr.nonBlockingCount, detail.pr.lastReviewedAt],
      ["ready", 1, "2026-09-23T17:04:12.009Z"],
    );
  } finally {
    await cleanup();
  }
});

test("ambiguous legacy lineage stays a labeled revised draft instead of a guessed review", async () => {
  const { service, cleanup, config, github, reviewer } = await migrated({
    revision: "ambiguous",
  });
  try {
    const detail = service.getDetail(PR);
    assert.deepEqual(
      detail.drafts.map((draft) => draft.runId),
      ["run-2", "run-1b", "run-1", "rev-1"],
    );
    const legacy = detail.drafts[3]!;
    assert.equal(legacy.id, "draft-legacy");
    assert.equal(legacy.version, 3);
    assert.equal(legacy.body, "Hand edited legacy summary");
    assert.equal(detail.draft?.runId, "run-2");
    assert.deepEqual(
      [detail.pr.status, detail.pr.blockingCount, detail.pr.nonBlockingCount],
      ["ready", 0, 1],
    );
    assert.equal(
      detail.proposals.find((item) => item.status === "pending")?.draftId,
      "draft-legacy",
    );
    await service.close();
    const restarted = await ReviewService.create(config, github, reviewer);
    assert.deepEqual(
      restarted.getDetail(PR).drafts.map((draft) => [draft.id, draft.runId]),
      detail.drafts.map((draft) => [draft.id, draft.runId]),
    );
    await restarted.close();
  } finally {
    await cleanup().catch(() => undefined);
  }
});

test("every completed review owns a draft and the newest run is the default", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.sync();
    let detail = await reviewed(service, github, reviewer, "sha-1");
    const first = detail.draft!;
    service.updateDraft(PR, {
      draftId: first.id,
      version: first.version,
      body: "Edited first",
      findings: first.findings,
      verdict: "APPROVE",
    });
    detail = await reviewed(service, github, reviewer, "sha-2");
    assert.equal(detail.drafts.length, 2);
    assert.equal(detail.draft?.runId, detail.runs[0]?.id);
    assert.equal(detail.draft?.body, "Review 2 of sha-2");
    assert.equal(detail.draft?.version, 1);
    assert.equal(detail.drafts[1]?.body, "Edited first");
    assert.equal(detail.drafts[1]?.version, 2);
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.pr.lastReviewedAt, detail.draft?.createdAt);

    const older = detail.drafts[1]!;
    const editedOlder = service.updateDraft(PR, {
      draftId: older.id,
      version: older.version,
      body: "Edited again later",
      findings: [
        { ...older.findings[0]!, severity: "blocking" },
        {
          ...finding("added-by-hand", "client evidence"),
          path: null,
          line: null,
        },
      ],
      verdict: "REQUEST_CHANGES",
    });
    assert.equal(editedOlder.draft?.id, detail.draft?.id);
    assert.equal(editedOlder.pr.blockingCount, 0);
    assert.equal(editedOlder.pr.nonBlockingCount, 1);
    assert.equal(editedOlder.pr.status, "ready");
    assert.equal(editedOlder.drafts[1]?.version, 3);
    assert.equal(service.getState().prs[0]?.nonBlockingCount, 1);

    reviewer.fail = true;
    github.current = remote("sha-3");
    await service.manualReview(PR);
    await waitFor(() => service.getDetail(PR).runs[0]?.status === "failed");
    detail = service.getDetail(PR);
    assert.equal(detail.drafts.length, 2);
    assert.equal(detail.draft?.headSha, "sha-2");
    assert.equal(detail.pr.status, "failed");
  } finally {
    await cleanup();
  }
});

test("latest selection follows run creation order, not completion order or edits", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-order-"));
  const databasePath = join(dataDir, "app.sqlite");
  seedLegacy(databasePath);
  const db = new DatabaseSync(databasePath);
  db.prepare(
    "UPDATE runs SET finished_at = '2026-09-24T00:00:00.000Z' WHERE id = 'run-1'",
  ).run();
  db.prepare(
    "UPDATE drafts SET updated_at = '2026-09-25T00:00:00.000Z' WHERE id = 'draft-legacy'",
  ).run();
  db.close();
  const app = new AppDatabase(databasePath);
  try {
    assert.deepEqual(
      app.listDrafts(PR).map((draft) => draft.runId),
      ["run-2", "run-1"],
    );
    assert.equal(app.latestDraft(PR)?.runId, "run-2");
  } finally {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("manual and review drafts interleave by creation time over the service and HTTP", async () => {
  const { service, github, reviewer, config, cleanup } = await makeService();
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api`;
  const prPath = `${base}/prs/${encodeURIComponent(PR)}`;
  const get = async <T>(url: string) => (await (await fetch(url)).json()) as T;
  const manualDraft = async () =>
    (
      (await (
        await fetch(`${prPath}/drafts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json()) as PullRequestDetail
    ).draft!;
  const inboxStatus = async () =>
    (await get<{ prs: PullRequest[] }>(`${base}/state`)).prs[0]?.status;
  try {
    await service.sync();
    const manual = await manualDraft();
    assert.equal(manual.runId, null);
    await reviewed(service, github, reviewer, "sha-2");
    let detail = await get<PullRequestDetail>(prPath);
    const reviewDraft = detail.draft!;
    assert.deepEqual(
      detail.drafts.map((draft) => [draft.runId, draft.headSha]),
      [
        [detail.runs[0]!.id, "sha-2"],
        [null, "sha-1"],
      ],
    );
    assert.equal(reviewDraft.body, "Review 1 of sha-2");
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.pr.nonBlockingCount, 1);
    assert.equal(detail.pr.lastReviewedAt, reviewDraft.createdAt);
    assert.equal(await inboxStatus(), "ready");

    github.current = remote("sha-3");
    await service.sync();
    assert.equal(await inboxStatus(), "outdated");
    const newerManual = await manualDraft();
    detail = await get<PullRequestDetail>(prPath);
    assert.deepEqual(
      detail.drafts.map((draft) => draft.id),
      [newerManual.id, reviewDraft.id, manual.id],
    );
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.pr.nonBlockingCount, 0);
    assert.equal(detail.pr.lastReviewedAt, reviewDraft.createdAt);

    const edited = service.updateDraft(PR, {
      draftId: reviewDraft.id,
      version: reviewDraft.version,
      body: "Edited older review",
      findings: [{ ...reviewDraft.findings[0]!, severity: "blocking" }],
      verdict: "REQUEST_CHANGES",
    });
    assert.equal(edited.draft?.id, newerManual.id);
    assert.equal(edited.drafts[1]?.body, "Edited older review");
    assert.equal(edited.drafts[1]?.version, reviewDraft.version + 1);
    assert.equal(edited.pr.blockingCount, 0);

    detail = await reviewed(service, github, reviewer, "sha-4");
    assert.deepEqual(
      detail.drafts.map((draft) => draft.runId),
      [detail.runs[0]!.id, null, reviewDraft.runId, null],
    );
    assert.equal(detail.draft?.body, "Review 2 of sha-4");
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.pr.nonBlockingCount, 1);
    assert.equal(await inboxStatus(), "ready");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});

test("a manual draft newer than an ambiguous legacy revision still sorts above it", async () => {
  const { service, cleanup, github } = await migrated({
    revision: "ambiguous",
  });
  try {
    github.current = remote("sha-new");
    await service.sync();
    const detail = service.createManualDraft(PR);
    assert.deepEqual(
      detail.drafts.map((draft) => draft.runId),
      [null, "run-2", "run-1b", "run-1", "rev-1"],
    );
    assert.equal(detail.pr.status, "ready");
  } finally {
    await cleanup();
  }
});

test("a review completing while another draft is open does not touch that draft", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.sync();
    const detail = await reviewed(service, github, reviewer, "sha-1");
    const open = detail.draft!;
    reviewer.hold = true;
    github.current = remote("sha-2");
    await service.manualReview(PR);
    await waitFor(() => reviewer.inputs.length === 2);
    const saved = service.updateDraft(PR, {
      draftId: open.id,
      version: open.version,
      body: "Saved mid-review",
      findings: open.findings,
      verdict: open.verdict,
    });
    assert.equal(saved.draft?.id, open.id);
    reviewer.release();
    await waitFor(() => service.getDetail(PR).drafts.length === 2);
    const after = service.getDetail(PR);
    assert.equal(after.draft?.headSha, "sha-2");
    assert.equal(after.drafts[1]?.id, open.id);
    assert.equal(after.drafts[1]?.body, "Saved mid-review");
    assert.equal(after.drafts[1]?.version, open.version + 1);
  } finally {
    await cleanup();
  }
});

test("draft edits keep stored evidence and never post it", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.sync();
    const detail = await reviewed(service, github, reviewer, "sha-1");
    const draft = detail.draft!;
    const edited = service.updateDraft(PR, {
      draftId: draft.id,
      version: draft.version,
      body: "Posted body text.",
      findings: [
        { ...draft.findings[0]!, evidence: "tampered", body: "Rewritten" },
        finding("new-1", "typed by the client"),
      ],
      verdict: "COMMENT",
    });
    assert.deepEqual(
      edited.draft?.findings.map((item) => [item.body, item.evidence]),
      [
        ["Rewritten", "- evidence 1"],
        ["Finding new-1", ""],
      ],
    );
    assert.equal(edited.draft?.overview, draft.overview);
    assert.notEqual(draft.overview, "");
    const preview = await service.preview(PR, draft.id, edited.draft!.version);
    assert.equal(preview.draftId, draft.id);
    assert.equal(preview.payload.body, "Posted body text.");
    assert.deepEqual(
      preview.payload.comments.map((comment) => comment.body),
      ["**Non-blocking.** Rewritten", "**Non-blocking.** Finding new-1"],
    );
    assert.doesNotMatch(JSON.stringify(preview.payload), /evidence 1|Overview/);
  } finally {
    await cleanup();
  }
});

const threePartOverview = [
  "## Ticket intent",
  "- Ticket context unavailable: no linked ticket or issue was found for this pull request.",
  "- Acceptance criteria: unknown.",
  "",
  "## What the PR does",
  "- `example()` now returns the new value; the changed line has one caller in `src/example.ts`.",
  "",
  "## Ticket coverage",
  "- Fulfilled: none confirmed.",
  "- Partial or missing: none identified.",
  "- Unverified: whether the new value is the intended one, because no ticket was available.",
].join("\n");

test("a three-section overview survives validation, persistence, restart, and edits, and is never previewed", async () => {
  const first = await makeService();
  const { dataDir } = first;
  let service = first.service;
  try {
    first.reviewer.overview = threePartOverview;
    await service.sync();
    const detail = await reviewed(
      service,
      first.github,
      first.reviewer,
      "sha-1",
    );
    assert.equal(detail.runs[0]?.result?.overview, threePartOverview);
    assert.equal(detail.draft?.overview, threePartOverview);
    await service.close();
    service = (await makeService(dataDir)).service;
    const reopened = service.getDetail(PR);
    assert.equal(reopened.draft?.overview, threePartOverview);
    assert.equal(reopened.runs[0]?.result?.overview, threePartOverview);
    const draft = reopened.draft!;
    const edited = service.updateDraft(PR, {
      draftId: draft.id,
      version: draft.version,
      body: "Posted body only.",
      findings: draft.findings,
      verdict: "COMMENT",
    });
    assert.equal(edited.draft?.overview, threePartOverview);
    const preview = await service.preview(PR, draft.id, edited.draft!.version);
    assert.equal(preview.payload.body, "Posted body only.");
    assert.doesNotMatch(
      JSON.stringify(preview.payload),
      /Ticket intent|What the PR does|Ticket coverage|Unverified|unavailable/,
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("revisions and proposals stay bound to their draft and version", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.sync();
    await reviewed(service, github, reviewer, "sha-1");
    const detail = await reviewed(service, github, reviewer, "sha-2");
    const latest = detail.draft!;
    const older = detail.drafts[1]!;
    service.revise(PR, {
      draftId: older.id,
      draftVersion: older.version,
      instructions: "Tighten the older draft",
    });
    await waitFor(() => service.getDetail(PR).proposals.length === 1);
    const proposal = service.getDetail(PR).proposals[0]!;
    assert.equal(proposal.draftId, older.id);
    assert.equal(proposal.sourceDraftVersion, older.version);
    assert.equal(reviewer.inputs[2]?.pr.headSha, "sha-1");
    assert.equal(reviewer.inputs[2]?.draft?.body, "Review 1 of sha-1");
    assert.equal(
      service.getDetail(PR).runs[0]?.headSha,
      "sha-1",
      "the revision run targets the draft's own commit",
    );
    assert.throws(
      () => service.applyProposal(PR, proposal.id, latest.version + 5),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "draft_conflict",
    );
    const applied = service.applyProposal(PR, proposal.id, older.version);
    assert.equal(applied.draft?.id, latest.id);
    assert.equal(applied.draft?.body, "Review 2 of sha-2");
    assert.equal(applied.drafts[1]?.body, "Revised 3: Tighten the older draft");
    assert.equal(applied.drafts[1]?.version, older.version + 1);
    assert.equal(applied.drafts[1]?.runId, older.runId);
    assert.equal(
      applied.drafts[1]?.findings[0]?.evidence,
      "- revision 3 rechecked src/a.ts",
    );
    assert.equal(applied.pr.nonBlockingCount, 1);

    service.revise(PR, {
      draftId: latest.id,
      draftVersion: latest.version,
      instructions: "Now the latest",
    });
    await waitFor(() => service.getDetail(PR).proposals.length === 2);
    const pending = service
      .getDetail(PR)
      .proposals.find((item) => item.status === "pending")!;
    service.updateDraft(PR, {
      draftId: latest.id,
      version: latest.version,
      body: "Moved on",
      findings: latest.findings,
      verdict: latest.verdict,
    });
    assert.throws(
      () => service.applyProposal(PR, pending.id, latest.version + 1),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "draft_conflict",
    );
    assert.throws(
      () =>
        service.revise(PR, {
          draftId: "missing",
          draftVersion: 1,
          instructions: "x",
        }),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "draft_required",
    );
  } finally {
    await cleanup();
  }
});

test("observed request provenance accumulates without trusting incoming historical fields", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    github.current.pr.requested = false;
    github.current.pr.requestSource = null;
    github.current.pr.historicalRequestSource = "both";
    await service.importPullRequest(github.current.pr.url);
    assert.equal(service.getDetail(PR).pr.historicalRequestSource, null);
    for (const [source, expected] of [
      ["team", "team"],
      ["direct", "both"],
      ["unknown", "both"],
      [null, "both"],
      ["team", "both"],
    ] as const) {
      github.current.pr.requested = source !== null;
      github.current.pr.requestSource = source;
      await service.sync();
      assert.equal(service.getDetail(PR).pr.requestSource, source);
      assert.equal(service.getDetail(PR).pr.historicalRequestSource, expected);
      assert.equal(service.getState().prs.length, 1);
    }
    service.db.clearPrRequest(PR);
    assert.equal(service.getDetail(PR).pr.requestSource, null);
    assert.equal(service.getDetail(PR).pr.historicalRequestSource, "both");
  } finally {
    await cleanup();
  }
});

test("historical provenance migration uses only typed request evidence, including old-head snapshots", async () => {
  const fixture = await makeService();
  const { service, config, dataDir } = fixture;
  const cases: Array<{
    pr?: Partial<PullRequest>;
    captures?: Partial<PullRequest>[];
    completed?: boolean;
    event?: boolean;
    expected: PullRequest["historicalRequestSource"];
  }> = [
    { pr: { requested: true, requestSource: "direct" }, expected: "direct" },
    { pr: { requested: true, requestSource: "team" }, expected: "team" },
    { pr: { requested: true, requestSource: "both" }, expected: "both" },
    { pr: { requested: true, requestSource: "unknown" }, expected: null },
    { pr: { requestSource: "direct" }, expected: null },
    {
      captures: [{ requested: true, requestSource: "team" }],
      expected: "team",
    },
    {
      captures: [{ requested: true, requestSource: "direct" }],
      expected: "direct",
    },
    {
      captures: [
        { requested: true, requestSource: "team" },
        { requested: true, requestSource: "direct" },
      ],
      expected: "both",
    },
    {
      pr: { requested: true, requestSource: "team" },
      captures: [{ requested: true, requestSource: "direct" }],
      expected: "both",
    },
    {
      pr: { state: "MERGED" },
      captures: [{ requested: true, requestSource: "both" }],
      expected: "both",
    },
    {
      captures: [
        {
          requested: false,
          requestSource: "direct",
          historicalRequestSource: "both",
        },
      ],
      expected: null,
    },
    {
      captures: [{ requested: true, requestSource: "unknown" }],
      expected: null,
    },
    {
      captures: [{ requested: true, requestSource: undefined }],
      expected: null,
    },
    { completed: true, expected: null },
    { pr: { imported: true }, expected: null },
    { event: true, expected: null },
  ];
  let db: AppDatabase | null = null;
  try {
    for (const [index, scenario] of cases.entries()) {
      const item = remote("current-head");
      Object.assign(
        item.pr,
        {
          id: `owner/repo#${index + 1}`,
          number: index + 1,
          requested: false,
          requestSource: null,
        },
        scenario.pr,
      );
      service.db.upsertPr(item.pr, item.diff, false);
      if (scenario.pr?.imported) service.db.markImported(item.pr.id);
      if (scenario.event)
        service.db.insertRequestEvent(
          `event-${index}`,
          item.pr.id,
          "old-head",
          "2026-01-01T00:00:00.000Z",
        );
      if (scenario.completed)
        service.db.createRun(
          completedRun({ id: `completed-${index}`, prId: item.pr.id }),
        );
      for (const [captureIndex, capture] of (
        scenario.captures ?? []
      ).entries()) {
        const run = completedRun({
          id: `capture-${index}-${captureIndex}`,
          prId: item.pr.id,
          status: "failed",
          result: null,
          headSha: "old-head",
        });
        service.db.createRun(run);
        service.db.createRunSnapshot(run.id, {
          pr: { ...item.pr, headSha: "old-head", ...capture },
          diff: item.diff,
          diffTruncated: false,
        });
      }
    }
    const snapshots = service.db.sqlite
      .prepare("SELECT * FROM run_snapshots ORDER BY run_id")
      .all();
    await service.close();
    const legacy = new DatabaseSync(config.databasePath);
    legacy.exec("ALTER TABLE prs DROP COLUMN historical_request_source");
    legacy.close();
    for (let restart = 0; restart < 2; restart++) {
      db = await AppDatabase.open(config.databasePath);
      for (const [index, scenario] of cases.entries()) {
        const pr: PullRequest = db.getPr(`owner/repo#${index + 1}`)!;
        assert.equal(
          pr.historicalRequestSource,
          scenario.expected,
          `case ${index}, restart ${restart}`,
        );
        assert.equal(pr.headSha, "current-head");
      }
      assert.deepEqual(
        db.sqlite.prepare("SELECT * FROM run_snapshots ORDER BY run_id").all(),
        snapshots,
      );
      assert.deepEqual(db.getSettings().automation, automationOff);
      assert.equal(db.listJobs().length, 0);
      db.close();
      db = null;
    }
  } finally {
    db?.close();
    if (service.db.sqlite.isOpen) await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

for (const requestSource of ["direct", "team", "both"] as const) {
  for (const submitted of [false, true]) {
    test(`open reviewed PR keeps ${requestSource} history after request removal, submitted=${submitted}`, async () => {
      const fixture = await makeService();
      const { github, reviewer, config, dataDir } = fixture;
      let service = fixture.service;
      try {
        github.current.pr.requestSource = requestSource;
        await service.sync();
        const draft = (
          await reviewed(service, github, reviewer, "sha-1", requestSource)
        ).draft!;
        const edited = service.updateDraft(PR, {
          draftId: draft.id,
          version: draft.version,
          body: "Manually preserved fixture text",
          findings: draft.findings,
          verdict: draft.verdict,
        }).draft!;
        if (submitted) {
          const preview = await service.preview(PR, edited.id, edited.version);
          await service.submit(PR, preview.id);
        }
        github.current.pr.requested = false;
        github.current.pr.requestedAt = null;
        github.current.pr.requestSource = null;
        await service.sync();
        assert.equal(service.getState().prs[0]?.hasReviewHistory, true);
        assert.equal(service.getState().prs[0]?.imported, false);
        assert.equal(service.getState().prs[0]?.requestSource, null);
        assert.equal(
          service.getState().prs[0]?.historicalRequestSource,
          requestSource,
        );
        const history = service.getDetail(PR);
        await service.close();
        service = await ReviewService.create(config, github, reviewer);
        assert.equal(service.getState().prs[0]?.id, PR);
        assert.equal(
          service.getState().prs[0]?.historicalRequestSource,
          requestSource,
        );
        for (const polling of ["pollCommits", "pollRequests"] as const) {
          service.db.updateSettings({
            automation: { ...automationOff, [polling]: true },
          });
          await service.sync("scheduled");
          assert.deepEqual(
            github.tracked.map((pr) => pr.id),
            [PR],
          );
        }
        service.db.updateSettings({ automation: automationOff });
        github.current.pr.headSha = "new-head";
        await service.sync();
        assert.deepEqual(
          github.tracked.map((pr) => pr.id),
          [PR],
        );
        assert.equal(service.getState().prs[0]?.hasReviewedHead, false);
        assert.equal(service.getState().prs[0]?.hasReviewHistory, true);
        assert.equal(service.getState().prs[0]?.status, "outdated");
        assert.equal(
          service.getState().prs[0]?.historicalRequestSource,
          requestSource,
        );
        for (const state of ["CLOSED", "MERGED"] as const) {
          service.db.upsertPr(
            { ...github.current.pr, state: "OPEN" },
            github.current.diff,
            false,
          );
          github.current.pr.state = state;
          await service.sync();
          assert.equal(service.getState().prs.length, 0);
          const detail = service.getDetail(PR);
          assert.equal(detail.pr.historicalRequestSource, requestSource);
          assert.deepEqual(detail.drafts, history.drafts);
          assert.deepEqual(detail.runs, history.runs);
          assert.deepEqual(detail.submissions, history.submissions);
        }
        assert.equal(reviewer.count, 1);
        github.current.pr.state = "OPEN";
        await service.checkFreshness(PR);
        assert.equal(
          service.getState().prs[0]?.historicalRequestSource,
          requestSource,
        );
        await service.manualReview(PR);
        await waitFor(
          () => service.getDetail(PR).runs[0]?.status === "completed",
        );
        assert.equal(service.getState().prs[0]?.hasReviewedHead, true);
        assert.equal(
          service.getState().prs[0]?.historicalRequestSource,
          requestSource,
        );
        assert.deepEqual(
          service.getDetail(PR).drafts.find((draft) => draft.id === edited.id),
          edited,
        );
        assert.equal(reviewer.count, 2);
        assert.deepEqual(service.db.getSettings().automation, automationOff);
      } finally {
        await service.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
}

test("a confirmed local-draft submission retains an open PR without inventing request provenance", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    github.current.pr.requested = false;
    github.current.pr.requestSource = null;
    github.current.pr.requestedAt = null;
    await service.sync();
    const draft = service.createManualDraft(PR).draft!;
    const edited = service.updateDraft(PR, {
      draftId: draft.id,
      version: draft.version,
      body: "Synthetic manual review",
      findings: [],
      verdict: "COMMENT",
    }).draft!;
    const preview = await service.preview(PR, edited.id, edited.version);
    await service.submit(PR, preview.id);
    github.current.pr.requested = false;
    await service.sync();
    assert.equal(service.getState().prs[0]?.hasReviewHistory, true);
    assert.equal(service.getState().prs[0]?.hasReviewedHead, false);
    assert.equal(service.getState().prs[0]?.historicalRequestSource, null);
    assert.equal(service.getDetail(PR).runs.length, 0);
  } finally {
    await cleanup();
  }
});

test("history eligibility excludes fetched rows, local drafts and unsuccessful or revision runs", async () => {
  const { service, cleanup } = await makeService();
  try {
    const item = remote(HEAD1);
    item.pr.requested = false;
    service.db.upsertPr(item.pr, item.diff, false);
    service.createManualDraft(PR);
    for (const [index, over] of [
      { kind: "revision", trigger: "revision" },
      { status: "failed" },
      { status: "interrupted" },
      { status: "queued" },
      { status: "running" },
      { result: null },
    ].entries()) {
      service.db.createRun(
        completedRun({
          id: `excluded-${index}`,
          ...over,
        } as Partial<ReviewRun> & Pick<ReviewRun, "id">),
      );
      assert.equal(service.getDetail(PR).pr.hasReviewHistory, false);
      assert.equal(service.getState().prs.length, 0);
    }
    service.db.markImported(PR);
    assert.equal(service.getState().prs[0]?.id, PR);
  } finally {
    await cleanup();
  }
});

test("preview and submit bind to the exact draft and reject stale ones", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.sync();
    await reviewed(service, github, reviewer, "sha-1");
    const detail = await reviewed(service, github, reviewer, "sha-2");
    const latest = detail.draft!;
    const older = detail.drafts[1]!;
    await assert.rejects(
      () => service.preview(PR, older.id, older.version),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "stale_draft",
    );
    await assert.rejects(
      () => service.preview(PR, "missing", 1),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "draft_required",
    );
    const preview = await service.preview(PR, latest.id, latest.version);
    assert.equal(preview.draftId, latest.id);
    service.updateDraft(PR, {
      draftId: latest.id,
      version: latest.version,
      body: "Changed after preview",
      findings: latest.findings,
      verdict: latest.verdict,
    });
    await assert.rejects(
      () => service.submit(PR, preview.id),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "draft_conflict",
    );
    assert.equal(github.submitCalls, 0);
    const fresh = await service.preview(PR, latest.id, latest.version + 1);
    const submitted = await service.submit(PR, fresh.id);
    assert.equal(submitted.submissions[0]?.status, "submitted");
    assert.equal(submitted.pr.status, "submitted");
    assert.equal(github.submitCalls, 1);
    assert.equal(fresh.payload.body, "Changed after preview");
  } finally {
    await cleanup();
  }
});

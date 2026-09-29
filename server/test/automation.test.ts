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
  type AutomationPolicy,
  type Finding,
  type MergeReadiness,
  type PullRequest,
  type ReviewResult,
  type ReviewerSettings,
} from "../../shared/contracts.js";
import type {
  CommitComparison,
  GithubAdapter,
  PollResult,
  PollScope,
  RemotePullRequest,
  ReviewerAdapter,
  ReviewerInput,
} from "../adapters.js";
import { loadConfig } from "../config.js";
import { AppDatabase } from "../db.js";
import { createHttpServer } from "../http.js";
import { ReviewService } from "../service.js";
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

const requestsOn: AutomationPolicy = {
  ...automationOff,
  pollRequests: true,
  reviewRequests: true,
};
const commitsOn: AutomationPolicy = {
  ...automationOff,
  pollCommits: true,
  reviewNewCommits: true,
};
const allOn: AutomationPolicy = {
  ...commitsOn,
  ...requestsOn,
  pollCommits: true,
  reviewNewCommits: true,
};

function remote(
  number: number,
  headSha = `sha-${number}-1`,
): RemotePullRequest {
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
    headRef: "feature",
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
    diff: `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+line from ${headSha}\n`,
    diffTruncated: false,
  };
}

class FakeGithub implements GithubAdapter {
  readonly demo = false;
  prs = new Map<number, RemotePullRequest>();
  requests = new Map<number, string>();
  pollCalls: Array<PollScope | undefined> = [];
  fetched: number[] = [];
  hold = false;
  private release: (() => void) | null = null;

  set(item: RemotePullRequest) {
    this.prs.set(item.pr.number, item);
  }

  push(number: number, headSha: string) {
    const current = this.prs.get(number)!;
    this.set({ ...remote(number, headSha), pr: { ...current.pr, headSha } });
  }

  request(number: number, eventId: string) {
    this.requests.set(number, eventId);
    const current = this.prs.get(number)!;
    current.pr = {
      ...current.pr,
      requested: true,
      requestedAt: "2026-01-02T00:00:00.000Z",
      requestSource: "direct",
      imported: false,
      createdAt: "2025-12-31T00:00:00.000Z",
    };
  }

  releasePoll() {
    this.release?.();
    this.release = null;
  }

  async health() {
    return { user: "tester", message: "fake" };
  }

  async getPullRequest(_repository: string, number: number) {
    this.fetched.push(number);
    const item = this.prs.get(number);
    if (!item) throw new Error(`unknown pull request ${number}`);
    return { ...item, pr: { ...item.pr, requested: false, requestedAt: null } };
  }

  async poll(
    _repository: string,
    _known: PullRequest[],
    scope?: PollScope,
  ): Promise<PollResult> {
    this.pollCalls.push(scope);
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    const items = [...this.prs.values()].filter(
      (item) => !scope || scope.numbers.includes(item.pr.number),
    );
    for (const item of items) this.fetched.push(item.pr.number);
    return {
      user: "tester",
      pullRequests: items.map((item) => ({ ...item, pr: { ...item.pr } })),
      requests: items
        .filter(
          (item) =>
            this.requests.has(item.pr.number) &&
            (!scope || scope.requestNumbers.includes(item.pr.number)),
        )
        .map((item) => ({
          eventId: this.requests.get(item.pr.number)!,
          prId: item.pr.id,
          headSha: item.pr.headSha,
          requestedAt: "2026-01-02T00:00:00.000Z",
        })),
    };
  }

  async compareCommits(
    _repository: string,
    base: string,
    head: string,
  ): Promise<CommitComparison> {
    return {
      status: "ahead",
      commits: [
        {
          sha: head,
          message: `Commit after ${base}`,
          author: "author",
          committedAt: "2026-01-03T00:00:00.000Z",
          url: `https://github.com/owner/repo/commit/${head}`,
        },
      ],
      truncated: false,
    };
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
  inputs: ReviewerInput[] = [];
  hold = false;
  private release: (() => void) | null = null;
  async health() {
    return { status: "ready" as const, message: "fake" };
  }
  releaseRun() {
    this.release?.();
    this.release = null;
  }
  async run(input: ReviewerInput) {
    this.inputs.push(input);
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    const finding: Finding = {
      id: `finding-${this.inputs.length}`,
      severity: "non_blocking",
      path: "src/a.ts",
      line: 1,
      body: `Finding ${this.inputs.length}`,
      evidence: "Evidence",
      origin: "introduced",
      included: true,
      startLine: null,
      side: "RIGHT",
      questionId: null,
    };
    const result: ReviewResult = {
      overview: `Overview ${this.inputs.length}`,
      body: `Review ${this.inputs.length} of ${input.pr.headSha}`,
      findings: [finding],
      verdict: "COMMENT",
      rationale: "fixture",
    };
    return { result, log: "fake reviewer" };
  }
}

async function makeService() {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-automation-"));
  const github = new FakeGithub();
  github.set(remote(1));
  github.set(remote(2));
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
  for (const number of [1, 2])
    await service.importPullRequest(
      `https://github.com/owner/repo/pull/${number}`,
    );
  await service.sync();
  const cleanup = async (current: ReviewService = service) => {
    reviewer.releaseRun();
    github.releasePoll();
    await current.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { service, github, reviewer, config, cleanup };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const one = prId("owner/repo", 1);
const two = prId("owner/repo", 2);
const runs = (service: ReviewService, id: string) =>
  service
    .getDetail(id)
    .runs.map((run) => [run.trigger, run.headSha, run.status]);

test("legacy settings migrate without enabling commit automation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-legacy-"));
  const path = join(dataDir, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      repository TEXT NOT NULL,
      polling_enabled INTEGER NOT NULL,
      poll_interval_seconds INTEGER NOT NULL,
      skill_path TEXT NOT NULL,
      reviewer_model TEXT,
      additional_instructions TEXT NOT NULL
    );
    INSERT INTO settings VALUES (1, 'owner/repo', 1, 120, '/tmp/skill', NULL, '');
    CREATE TABLE prs (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, repository TEXT NOT NULL, url TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, author_avatar_url TEXT,
      head_sha TEXT NOT NULL, base_sha TEXT NOT NULL, head_ref TEXT NOT NULL, base_ref TEXT NOT NULL,
      state TEXT NOT NULL, requested INTEGER NOT NULL, requested_at TEXT, updated_at TEXT NOT NULL,
      status TEXT NOT NULL, blocking_count INTEGER NOT NULL, non_blocking_count INTEGER NOT NULL,
      additions INTEGER NOT NULL, deletions INTEGER NOT NULL, changed_files INTEGER NOT NULL,
      last_reviewed_at TEXT, diff TEXT NOT NULL, diff_truncated INTEGER NOT NULL
    );
    INSERT INTO prs VALUES ('owner/repo#7', 7, 'owner/repo', 'u', 't', '', 'a', NULL, 'h', 'b', 'f', 'm',
      'OPEN', 1, NULL, '2026-01-01T00:00:00.000Z', 'ready', 2, 1, 1, 0, 1, NULL, '', 0);
  `);
  legacy.close();
  try {
    let db = await AppDatabase.open(path);
    assert.deepEqual(db.getSettings().automation, requestsOn);
    assert.equal(db.getSettings().pollIntervalSeconds, 120);
    const pr = db.getPr("owner/repo#7")!;
    assert.deepEqual(pr.automation, inheritAutomation);
    assert.deepEqual(pr.effectiveAutomation, requestsOn);
    assert.equal(pr.blockingCount, 2);
    assert.equal(pr.requested, true);
    assert.equal(pr.requestSource, "unknown");
    assert.equal(pr.createdAt, null);
    db.clearPrRequest(pr.id);
    assert.equal(db.getPr(pr.id)!.requestSource, null);
    db.upsertPr(
      { ...pr, requestSource: "direct", createdAt: "2025-12-31T00:00:00.000Z" },
      "",
      false,
    );
    assert.equal(db.getPr(pr.id)!.requestSource, "direct");
    db.upsertPr({ ...pr, requestSource: "direct", createdAt: null }, "", false);
    assert.equal(db.getPr(pr.id)!.createdAt, "2025-12-31T00:00:00.000Z");
    assert.deepEqual(db.getAutomationState(pr.id), {
      commitHead: null,
      requestsArmed: false,
    });
    db.sqlite.prepare("UPDATE settings SET polling_enabled = 0").run();
    db.updateSettings({ automation: automationOff });
    db.close();
    db = await AppDatabase.open(path);
    assert.deepEqual(db.getSettings().automation, automationOff);
    db.close();

    const disabled = new DatabaseSync(join(dataDir, "disabled.sqlite"));
    disabled.exec(`
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), repository TEXT NOT NULL, polling_enabled INTEGER NOT NULL,
        poll_interval_seconds INTEGER NOT NULL, skill_path TEXT NOT NULL, reviewer_model TEXT,
        additional_instructions TEXT NOT NULL
      );
      INSERT INTO settings VALUES (1, 'owner/repo', 0, 300, '/tmp/skill', NULL, '');
    `);
    disabled.close();
    db = await AppDatabase.open(join(dataDir, "disabled.sqlite"));
    assert.deepEqual(db.getSettings().automation, automationOff);
    db.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("per-PR overrides cover auto-review only and are gated by global polling", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    assert.deepEqual(
      service.getDetail(one).pr.effectiveAutomation,
      automationOff,
    );
    assert.equal(service.pollingActive(), false);

    service.updateAutomation(one, { reviewNewCommits: "on" });
    assert.deepEqual(service.getDetail(one).pr.automation, {
      ...inheritAutomation,
      reviewNewCommits: "on",
    });
    assert.deepEqual(
      service.getDetail(one).pr.effectiveAutomation,
      automationOff,
      "a PR cannot opt into polling while the global switch is off",
    );
    assert.equal(service.pollingActive(), false);
    github.pollCalls = [];
    github.push(1, "sha-1-2");
    await service.sync("scheduled");
    assert.deepEqual(github.pollCalls, []);
    assert.equal(service.getDetail(one).pr.headSha, "sha-1-1");

    service.updateSettings({ automation: { pollCommits: true } });
    assert.deepEqual(service.getDetail(one).pr.effectiveAutomation, commitsOn);
    assert.deepEqual(service.getDetail(two).pr.effectiveAutomation, {
      ...automationOff,
      pollCommits: true,
    });
    assert.equal(service.pollingActive(), true);
    await service.sync("scheduled");
    assert.deepEqual(github.pollCalls, [
      { numbers: [1, 2], requestNumbers: [] },
    ]);
    github.push(1, "sha-1-3");
    github.push(2, "sha-2-3");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(one).runs[0]?.status === "completed");
    assert.deepEqual(runs(service, one), [
      ["new_commits", "sha-1-3", "completed"],
    ]);
    assert.deepEqual(runs(service, two), []);
    assert.equal(service.getDetail(two).pr.headSha, "sha-2-3");

    service.updateSettings({ automation: allOn });
    service.updateAutomation(two, { reviewRequests: "off" });
    assert.deepEqual(service.getDetail(two).pr.effectiveAutomation, {
      ...allOn,
      reviewRequests: false,
    });
    assert.deepEqual(service.getDetail(one).pr.effectiveAutomation, allOn);
    await service.sync("scheduled");
    github.request(1, "event-1");
    github.request(2, "event-2");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(one).runs.length === 2);
    await settle();
    assert.equal(service.getDetail(one).runs[0].requestEventId, "event-1");
    assert.equal(service.db.hasRequestEvent("event-2"), true);
    assert.deepEqual(runs(service, two), []);
    assert.equal(reviewer.inputs.length, 2);

    service.updateAutomation(two, { reviewRequests: "inherit" });
    assert.deepEqual(service.getDetail(two).pr.effectiveAutomation, allOn);

    service.updateSettings({ repository: "" });
    assert.deepEqual(service.getState().settings.automation, automationOff);
    assert.equal(service.pollingActive(), false);
  } finally {
    await cleanup();
  }
});

test("legacy per-PR polling overrides are dropped and never authorize scheduled work", async () => {
  const { service, github, reviewer, config, cleanup } = await makeService();
  let current = service;
  try {
    service.db.sqlite
      .prepare("UPDATE prs SET automation_json = ? WHERE id = ?")
      .run(JSON.stringify({ pollCommits: "on", reviewNewCommits: "on" }), one);
    await service.close();
    current = await ReviewService.create(config, github, reviewer);
    assert.deepEqual(current.getDetail(one).pr.automation, {
      ...inheritAutomation,
      reviewNewCommits: "on",
    });
    assert.deepEqual(JSON.parse(current.db.getPrRow(one)!.automation_json), {
      reviewNewCommits: "on",
      reviewRequests: "inherit",
    });
    assert.deepEqual(current.getState().settings.automation, automationOff);
    assert.deepEqual(
      current.getDetail(one).pr.effectiveAutomation,
      automationOff,
    );
    assert.equal(current.pollingActive(), false);

    github.pollCalls = [];
    github.push(1, "sha-1-2");
    await current.sync("scheduled");
    await settle();
    assert.deepEqual(github.pollCalls, []);
    assert.equal(current.getDetail(one).pr.headSha, "sha-1-1");
    assert.deepEqual(runs(current, one), []);

    current.updateSettings({ automation: { pollCommits: true } });
    await current.sync("scheduled");
    github.push(1, "sha-1-3");
    await current.sync("scheduled");
    await waitFor(() => current.getDetail(one).runs[0]?.status === "completed");
    assert.deepEqual(runs(current, one), [
      ["new_commits", "sha-1-3", "completed"],
    ]);
    assert.deepEqual(runs(current, two), []);
  } finally {
    await cleanup(current);
  }
});

test("commit polling without auto-review keeps stale indicators current in the background", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.manualReview(one);
    await waitFor(() => service.getDetail(one).draft !== null);
    service.updateSettings({ automation: { pollCommits: true } });
    assert.deepEqual(service.getDetail(two).pr.effectiveAutomation, {
      ...automationOff,
      pollCommits: true,
    });
    await service.sync();
    assert.equal(service.getDetail(one).freshness?.status, "fresh");

    github.push(1, "sha-1-2");
    github.push(2, "sha-2-2");
    github.pollCalls = [];
    await service.sync("scheduled");
    assert.deepEqual(github.pollCalls, [
      { numbers: [1, 2], requestNumbers: [] },
    ]);
    const detail = service.getDetail(one);
    assert.equal(detail.pr.headSha, "sha-1-2");
    assert.equal(detail.pr.status, "outdated");
    assert.equal(detail.freshness?.status, "stale");
    assert.deepEqual(
      detail.freshness?.commits.map((commit) => commit.sha),
      ["sha-1-2"],
    );
    assert.equal(service.getDetail(two).pr.headSha, "sha-2-2");
    await settle();
    assert.equal(reviewer.inputs.length, 1);
    assert.equal(detail.runs.length, 1);

    service.updateSettings({ automation: { pollCommits: false } });
    assert.equal(service.pollingActive(), false);
    github.pollCalls = [];
    github.push(1, "sha-1-3");
    await service.sync("scheduled");
    assert.deepEqual(github.pollCalls, []);
    assert.equal(service.getDetail(one).freshness?.head, "sha-1-2");
    await service.checkFreshness(one);
    assert.equal(service.getDetail(one).freshness?.head, "sha-1-3");
  } finally {
    await cleanup();
  }
});

test("new-commit automation reviews head changes only, never edits, and preserves edited drafts", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.manualReview(one);
    await waitFor(() => service.getDetail(one).draft !== null);
    const draft = service.getDetail(one).draft!;
    service.updateDraft(one, {
      draftId: draft.id,
      version: draft.version,
      body: "Edited by hand",
      findings: draft.findings,
      verdict: "APPROVE",
    });
    github.push(1, "sha-1-2");
    service.updateSettings({ automation: commitsOn });
    await service.sync();
    await settle();
    assert.equal(
      service.getDetail(one).runs.length,
      1,
      "commits pushed before opting in are the baseline, not a backlog",
    );
    assert.equal(service.getDetail(one).pr.status, "outdated");

    const current = github.prs.get(1)!;
    current.pr = { ...current.pr, title: "Retitled", body: "Edited body" };
    await service.sync("scheduled");
    await settle();
    assert.equal(service.getDetail(one).runs.length, 1);
    assert.equal(service.getDetail(one).pr.title, "Retitled");

    github.push(1, "sha-1-3");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(one).runs[0]?.status === "completed");
    assert.deepEqual(runs(service, one), [
      ["new_commits", "sha-1-3", "completed"],
      ["manual", "sha-1-1", "completed"],
    ]);
    assert.equal(reviewer.inputs[1].pr.headSha, "sha-1-3");
    assert.equal(reviewer.inputs[1].diff, remote(1, "sha-1-3").diff);
    const after = service.getDetail(one);
    assert.equal(after.draft?.headSha, "sha-1-3");
    assert.equal(after.draft?.body, "Review 2 of sha-1-3");
    assert.equal(after.drafts[1]?.body, "Edited by hand");
    assert.equal(after.drafts[1]?.headSha, "sha-1-1");
    assert.equal(after.pr.status, "ready");
    assert.equal(after.freshness?.status, "fresh");

    const closed = github.prs.get(1)!;
    closed.pr = { ...closed.pr, state: "CLOSED", headSha: "sha-1-4" };
    await service.sync("scheduled");
    await settle();
    assert.equal(service.getDetail(one).runs.length, 2);
  } finally {
    await cleanup();
  }
});

test("request automation observes a baseline, then reviews later events including same-SHA re-requests", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    github.request(1, "event-1");
    service.updateSettings({ automation: requestsOn });
    await service.sync();
    await settle();
    assert.equal(service.getDetail(one).runs.length, 0);
    assert.equal(service.db.getAutomationState(one).requestsArmed, true);
    assert.equal(service.db.hasRequestEvent("event-1"), true);

    github.request(1, "event-2");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(one).runs[0]?.status === "completed");
    assert.deepEqual(runs(service, one), [["request", "sha-1-1", "completed"]]);
    assert.equal(service.getDetail(one).runs[0].requestEventId, "event-2");

    await service.sync("scheduled");
    await settle();
    assert.equal(service.getDetail(one).runs.length, 1);

    github.request(1, "event-3");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(one).runs.length === 2);
    await waitFor(() => service.getDetail(one).runs[0].status === "completed");
    assert.equal(service.getDetail(one).runs[0].headSha, "sha-1-1");
    assert.equal(reviewer.inputs.length, 2);
    assert.deepEqual(runs(service, two), []);
  } finally {
    await cleanup();
  }
});

test("overlapping new-head and request triggers share one pending run", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  reviewer.hold = true;
  try {
    service.updateSettings({ automation: allOn });
    await service.sync();
    github.push(1, "sha-1-2");
    github.request(1, "event-1");
    await service.sync("scheduled");
    await waitFor(() => reviewer.inputs.length === 1);
    assert.equal(service.getDetail(one).runs.length, 1);
    assert.equal(service.getDetail(one).runs[0].status, "running");
    await service.manualReview(one);
    assert.equal(service.getDetail(one).runs.length, 1);
    github.request(1, "event-2");
    await service.sync("scheduled");
    assert.equal(service.getDetail(one).runs.length, 1);
    reviewer.hold = false;
    reviewer.releaseRun();
    await waitFor(() => service.getDetail(one).runs[0].status === "completed");
    github.request(1, "event-3");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(one).runs.length === 2);
    assert.equal(service.getDetail(one).runs[0].trigger, "request");
    assert.equal(service.getDetail(one).runs[0].headSha, "sha-1-2");
  } finally {
    await cleanup();
  }
});

test("disabling a policy during an awaited poll queues nothing and does not cancel active work", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    service.updateSettings({ automation: allOn });
    await service.sync();
    reviewer.hold = true;
    github.push(1, "sha-1-2");
    await service.sync("scheduled");
    await waitFor(() => reviewer.inputs.length === 1);

    github.hold = true;
    github.push(2, "sha-2-2");
    github.request(2, "event-2");
    const polls = github.pollCalls.length;
    const polling = service.sync("scheduled");
    await waitFor(() => github.pollCalls.length === polls + 1);
    service.updateSettings({ automation: automationOff });
    github.releasePoll();
    await polling;
    await settle();
    assert.deepEqual(runs(service, two), []);
    assert.equal(service.getDetail(two).pr.headSha, "sha-2-2");
    assert.equal(service.db.hasRequestEvent("event-2"), true);
    assert.equal(service.getDetail(one).runs[0].status, "running");
    reviewer.hold = false;
    reviewer.releaseRun();
    await waitFor(() => service.getDetail(one).runs[0].status === "completed");
    assert.equal(service.getDetail(one).runs[0].trigger, "new_commits");
    assert.equal(service.pollingActive(), false);

    github.hold = false;
    service.updateSettings({ automation: requestsOn });
    await service.sync();
    github.request(2, "event-3");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(two).runs.length === 1);
    assert.equal(service.getDetail(two).runs[0].requestEventId, "event-3");
  } finally {
    await cleanup();
  }
});

test("baselines survive restart so nothing is reviewed twice", async () => {
  const { service, github, reviewer, config, cleanup } = await makeService();
  let current = service;
  try {
    service.updateSettings({ automation: allOn });
    await service.sync();
    github.push(1, "sha-1-2");
    github.request(1, "event-1");
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(one).runs[0]?.status === "completed");
    await service.close();

    current = await ReviewService.create(config, github, reviewer);
    assert.equal(current.db.getAutomationState(one).commitHead, "sha-1-2");
    assert.equal(current.db.getAutomationState(one).requestsArmed, true);
    await current.sync("scheduled");
    await settle();
    assert.equal(current.getDetail(one).runs.length, 1);
    assert.equal(reviewer.inputs.length, 1);

    github.push(1, "sha-1-3");
    await current.sync("scheduled");
    await waitFor(() => current.getDetail(one).runs.length === 2);
    assert.equal(current.getDetail(one).runs[0].headSha, "sha-1-3");
  } finally {
    await cleanup(current);
  }
});

test("manual re-review stays available and pinned while automation is off", async () => {
  const { service, github, reviewer, cleanup } = await makeService();
  try {
    await service.manualReview(one);
    await waitFor(() => service.getDetail(one).draft !== null);
    github.push(1, "sha-1-2");
    await service.manualReview(one);
    await waitFor(() => service.getDetail(one).runs.length === 2);
    await waitFor(() => service.getDetail(one).runs[0].status === "completed");
    assert.deepEqual(runs(service, one), [
      ["manual", "sha-1-2", "completed"],
      ["manual", "sha-1-1", "completed"],
    ]);
    assert.equal(reviewer.inputs[1].diff, remote(1, "sha-1-2").diff);
    assert.equal(service.db.getAutomationState(one).commitHead, null);
    assert.equal(service.pollingActive(), false);
  } finally {
    await cleanup();
  }
});

test("HTTP settings and per-PR automation routes validate their payloads", async () => {
  const { service, config, cleanup } = await makeService();
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const call = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const bad = await call("/api/settings", {
      automation: { pollCommits: "yes" },
    });
    assert.equal(bad.status, 400);
    const ok = await call("/api/settings", {
      automation: { pollCommits: true },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).settings.automation, {
      ...automationOff,
      pollCommits: true,
    });
    const badMode = await call(
      `/api/prs/${encodeURIComponent(one)}/automation`,
      {
        reviewNewCommits: "maybe",
      },
    );
    assert.equal(badMode.status, 400);
    const override = await call(
      `/api/prs/${encodeURIComponent(one)}/automation`,
      {
        reviewNewCommits: "on",
      },
    );
    assert.equal(override.status, 200);
    const detail = await override.json();
    assert.equal(detail.pr.automation.reviewNewCommits, "on");
    assert.deepEqual(detail.pr.effectiveAutomation, commitsOn);
    const legacy = await call(
      `/api/prs/${encodeURIComponent(one)}/automation`,
      { pollCommits: "on", reviewNewCommits: "inherit" },
    );
    assert.equal(legacy.status, 200);
    assert.deepEqual((await legacy.json()).pr.automation, inheritAutomation);
    const missing = await call("/api/prs/nope/automation", {
      reviewNewCommits: "on",
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});

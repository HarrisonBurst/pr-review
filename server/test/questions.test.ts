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
  type QuestionAnswer,
  type ReviewResult,
  type ReviewerSettings,
  type SelectionRange,
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
import type { QuestionAdapter, QuestionInput } from "../questions.js";
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
const PR = prId("owner/repo", 7);
const HEAD1 = "1111111111111111111111111111111111111111";
const HEAD2 = "2222222222222222222222222222222222222222";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " keep",
  "-old line",
  "+new line",
  "+another",
  " tail",
  "@@ -10,2 +11,2 @@",
  " later",
  "-gone",
  "+arrived",
  "diff --git a/docs/old.md b/docs/new.md",
  "similarity index 90%",
  "rename from docs/old.md",
  "rename to docs/new.md",
  "--- a/docs/old.md",
  "+++ b/docs/new.md",
  "@@ -1 +1 @@",
  "-# Old",
  "+# New",
  "",
].join("\n");

function remote(headSha = HEAD1): RemotePullRequest {
  const pr: PullRequest = {
    id: PR,
    number: 7,
    repository: "owner/repo",
    url: "https://github.com/owner/repo/pull/7",
    title: "Fixture PR",
    body: "Fixture",
    author: "author",
    authorAvatarUrl: null,
    headSha,
    baseSha: BASE,
    headRef: "feature",
    baseRef: "main",
    state: "OPEN",
    requested: false,
    requestedAt: null,
    requestSource: null,
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
  return { pr, diff, diffTruncated: false };
}

const finding = (over: Partial<Finding>): Finding => ({
  id: "f",
  severity: "non_blocking",
  path: "src/a.ts",
  line: 2,
  startLine: null,
  side: "RIGHT",
  body: "Finding",
  evidence: "",
  origin: "introduced",
  included: true,
  questionId: null,
  ...over,
});

class FakeGithub implements GithubAdapter {
  readonly demo = false;
  current = remote();
  async health() {
    return { user: "tester", message: "fake" };
  }
  async getPullRequest() {
    return this.current;
  }
  async poll(): Promise<PollResult> {
    return { user: "tester", pullRequests: [this.current], requests: [] };
  }
  async submitReview() {
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
  hold = false;
  private release: (() => void) | null = null;
  inputs: ReviewerInput[] = [];
  async health() {
    return { status: "ready" as const, message: "fake" };
  }
  finish(): void {
    this.release?.();
    this.release = null;
  }
  async run(
    input: ReviewerInput,
  ): Promise<{ result: ReviewResult; log: string }> {
    this.inputs.push(input);
    if (this.hold)
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    return {
      result: {
        overview: "- overview",
        body: `Review of ${input.pr.headSha}`,
        findings: [
          finding({ id: "review-finding", evidence: "- review evidence" }),
        ],
        verdict: "COMMENT",
        rationale: "fixture",
      },
      log: "fake reviewer",
    };
  }
}

class FakeQuestioner implements QuestionAdapter {
  hold = false;
  fail = false;
  inputs: QuestionInput[] = [];
  private release: (() => void) | null = null;
  finish(): void {
    this.release?.();
    this.release = null;
  }
  async ask(
    input: QuestionInput,
    _settings: ReviewerSettings,
    signal?: AbortSignal,
  ): Promise<{ answer: QuestionAnswer; log: string }> {
    this.inputs.push(input);
    if (this.hold)
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    signal?.throwIfAborted();
    if (this.fail) throw new Error("question exploded");
    return {
      answer:
        input.mode === "draft_comment"
          ? {
              kind: "comment",
              body: `Comment about ${input.selection.path}`,
              severity: "blocking",
              origin: "introduced",
              evidence: `- checked ${input.selection.snippet.split("\n")[0]}`,
            }
          : {
              kind: "answer",
              answer: `${input.mode}: ${input.question || "no question"} (${input.history.length} prior)`,
              followUps: ["next?"],
            },
      log: "fake questioner",
    };
  }
}

async function makeService(dataDir?: string) {
  dataDir ??= await mkdtemp(join(tmpdir(), "pr-review-questions-"));
  const github = new FakeGithub();
  const reviewer = new FakeReviewer();
  const questioner = new FakeQuestioner();
  const config = loadConfig({
    host: "127.0.0.1",
    port: 4317,
    dataDir,
    databasePath: join(dataDir, "app.sqlite"),
    demo: false,
    reviewer: reviewerSettings,
  });
  const service = await ReviewService.create(
    config,
    github,
    reviewer,
    questioner,
  );
  await saveFixtureExecution(service);
  service.db.updateSettings({ repository: "owner/repo" });
  const cleanup = async () => {
    reviewer.finish();
    questioner.finish();
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { service, github, reviewer, questioner, config, dataDir, cleanup };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting");
}

const range = (over: Partial<SelectionRange> = {}): SelectionRange => ({
  path: "src/a.ts",
  from: { side: "RIGHT", line: 2 },
  to: { side: "RIGHT", line: 3 },
  baseSha: BASE,
  headSha: HEAD1,
  ...over,
});

async function reviewed(
  service: ReviewService,
  github: FakeGithub,
  headSha: string,
) {
  github.current = remote(headSha);
  await service.manualReview(PR);
  await waitFor(() => service.getDetail(PR).runs[0]?.status === "completed");
  return service.getDetail(PR);
}

test("manual drafts are created without a run, keep provenance truthful, and drive status", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.importPullRequest("https://github.com/owner/repo/pull/7");
    let detail = service.createManualDraft(PR);
    const draft = detail.draft!;
    assert.equal(draft.runId, null);
    assert.equal(draft.headSha, HEAD1);
    assert.deepEqual(
      [draft.version, draft.overview, draft.body, draft.findings],
      [1, "", "", []],
    );
    assert.equal(detail.pr.status, "ready");
    assert.equal(detail.pr.lastReviewedAt, null);
    assert.equal(detail.runs.length, 0);
    assert.equal(service.createManualDraft(PR).drafts.length, 1);

    detail = service.updateDraft(PR, {
      draftId: draft.id,
      version: 1,
      body: "",
      findings: [
        finding({ id: "manual-1", startLine: 2, line: 3, evidence: "forged" }),
        finding({ id: "manual-2", side: "LEFT", line: 2 }),
      ],
      verdict: "COMMENT",
    });
    assert.deepEqual(
      detail.draft!.findings.map((item) => [
        item.side,
        item.startLine,
        item.line,
        item.evidence,
      ]),
      [
        ["RIGHT", 2, 3, ""],
        ["LEFT", null, 2, ""],
      ],
    );
    assert.equal(detail.pr.nonBlockingCount, 2);
    assert.throws(
      () =>
        service.revise(PR, {
          draftId: draft.id,
          draftVersion: 2,
          instructions: "x",
        }),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "snapshot_missing",
    );
    const preview = await service.preview(PR, draft.id, 2);
    assert.deepEqual(preview.payload.comments, [
      {
        path: "src/a.ts",
        line: 3,
        side: "RIGHT",
        start_line: 2,
        start_side: "RIGHT",
        body: "**Non-blocking.** Finding",
      },
      {
        path: "src/a.ts",
        line: 2,
        side: "LEFT",
        body: "**Non-blocking.** Finding",
      },
    ]);
    assert.equal(preview.payload.body, "");
  } finally {
    await cleanup();
  }
});

test("preview anchors ranges within one hunk per side and sends the rest to the body once", async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.importPullRequest("https://github.com/owner/repo/pull/7");
    const draft = service.createManualDraft(PR).draft!;
    service.updateDraft(PR, {
      draftId: draft.id,
      version: 1,
      body: "Body",
      findings: [
        finding({
          id: "cross-hunk",
          startLine: 4,
          line: 12,
          body: "Crosses hunks",
        }),
        finding({
          id: "context-old",
          side: "LEFT",
          startLine: 1,
          line: 2,
          body: "Old range",
        }),
        finding({
          id: "missing-old",
          side: "LEFT",
          line: 5,
          body: "Old line outside hunks",
        }),
        finding({
          id: "renamed",
          path: "docs/new.md",
          line: 1,
          body: "Renamed file",
        }),
        finding({
          id: "rename-old",
          path: "docs/old.md",
          side: "LEFT",
          line: 1,
          body: "Old path",
        }),
      ],
      verdict: "COMMENT",
    });
    for (const bad of [
      finding({ id: "bad", side: "UP" as never }),
      finding({ id: "reversed", startLine: 3, line: 2 }),
      finding({ id: "no-line", startLine: 3, line: null }),
    ])
      assert.throws(
        () =>
          service.updateDraft(PR, {
            draftId: draft.id,
            version: 2,
            body: "Body",
            findings: [bad],
            verdict: "COMMENT",
          }),
        (error: unknown) =>
          error instanceof ServiceError && error.code === "invalid_finding",
        bad.id,
      );
    const preview = await service.preview(PR, draft.id, 2);
    assert.deepEqual(
      preview.payload.comments.map((comment) => [
        comment.path,
        comment.side,
        comment.start_line ?? null,
        comment.line,
      ]),
      [
        ["src/a.ts", "LEFT", 1, 2],
        ["docs/new.md", "RIGHT", null, 1],
      ],
    );
    assert.match(preview.payload.body, /`src\/a\.ts:4-12` Crosses hunks/);
    assert.match(
      preview.payload.body,
      /`src\/a\.ts:5` \(old\) Old line outside hunks/,
    );
    assert.match(preview.payload.body, /`docs\/old\.md:1` \(old\) Old path/);
    assert.equal(preview.payload.body.match(/Non-blocking/g)?.length, 3);
  } finally {
    await cleanup();
  }
});

test("questions resolve the selection against the pinned diff and reject mismatches", async () => {
  const { service, questioner, cleanup } = await makeService();
  try {
    await service.importPullRequest("https://github.com/owner/repo/pull/7");
    for (const [label, bad, code] of [
      ["wrong head", range({ headSha: HEAD2 }), "head_mismatch"],
      ["wrong base", range({ baseSha: "other" }), "head_mismatch"],
      ["unknown file", range({ path: "src/missing.ts" }), "invalid_selection"],
      [
        "unknown line",
        range({ to: { side: "RIGHT", line: 99 } }),
        "invalid_selection",
      ],
      [
        "not a removed line",
        range({ from: { side: "LEFT", line: 3 } }),
        "invalid_selection",
      ],
    ] as const)
      assert.throws(
        () => service.ask(PR, { mode: "explain", range: bad }),
        (error: unknown) =>
          error instanceof ServiceError && error.code === code,
        label,
      );
    assert.throws(
      () => service.ask(PR, { mode: "nope" as never, range: range() }),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "invalid_question",
    );
    const detail = service.ask(PR, {
      mode: "explain",
      range: range({
        from: { side: "LEFT", line: 2 },
        to: { side: "RIGHT", line: 4 },
      }),
      question: "why?",
    });
    const question = detail.questions[0]!;
    assert.equal(question.status, "queued");
    assert.deepEqual([question.baseSha, question.headSha], [BASE, HEAD1]);
    assert.equal(
      question.selection.snippet,
      "-old line\n+new line\n+another\n tail",
    );
    assert.deepEqual(question.selection.anchors, {
      RIGHT: { startLine: 2, line: 4 },
      LEFT: { startLine: 2, line: 3 },
    });
    assert.deepEqual(question.selection.kinds, {
      add: true,
      del: true,
      ctx: true,
    });
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "completed",
    );
    const done = service.getDetail(PR).questions[0]!;
    assert.deepEqual(done.answer, {
      kind: "answer",
      answer: "explain: why? (0 prior)",
      followUps: ["next?"],
    });
    const input = questioner.inputs[0]!;
    assert.match(input.fileDiff, /^diff --git a\/src\/a\.ts/);
    assert.doesNotMatch(input.fileDiff, /docs\/new\.md/);
    assert.equal(input.draft, null);

    const renamed = service.ask(PR, {
      mode: "investigate",
      range: range({
        path: "docs/new.md",
        from: { side: "LEFT", line: 1 },
        to: { side: "RIGHT", line: 1 },
      }),
    }).questions[1]!;
    assert.equal(renamed.selection.oldPath, "docs/old.md");
    await waitFor(
      () => service.getDetail(PR).questions[1]?.status === "completed",
    );

    const spanning = service.ask(PR, {
      mode: "explain",
      range: range({
        from: { side: "RIGHT", line: 4 },
        to: { side: "RIGHT", line: 12 },
      }),
    }).questions[2]!;
    assert.equal(spanning.selection.spansHunks, true);
    assert.deepEqual(spanning.selection.anchors, {});
  } finally {
    await cleanup();
  }
});

test("follow-ups carry prior turns, the open draft is read-only context, and evidence is bound to the question", async () => {
  const { service, github, questioner, cleanup } = await makeService();
  try {
    await service.importPullRequest("https://github.com/owner/repo/pull/7");
    const detail = await reviewed(service, github, HEAD1);
    const draft = detail.draft!;
    const first = service.ask(PR, {
      mode: "explain",
      range: range(),
      question: "first",
      draftId: draft.id,
    }).questions[0]!;
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "completed",
    );
    assert.equal(questioner.inputs[0]!.draft?.body, `Review of ${HEAD1}`);
    assert.throws(
      () =>
        service.ask(PR, {
          mode: "explain",
          range: range(),
          parentId: "missing",
        }),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "not_found",
    );
    const second = service.ask(PR, {
      mode: "draft_comment",
      range: range(),
      parentId: first.id,
      draftId: draft.id,
    }).questions[1]!;
    assert.equal(second.parentId, first.id);
    await waitFor(
      () => service.getDetail(PR).questions[1]?.status === "completed",
    );
    assert.deepEqual(
      questioner.inputs[1]!.history.map((turn) => [turn.mode, turn.question]),
      [["explain", "first"]],
    );
    const answered = service.getDetail(PR).questions[1]!.answer;
    assert.equal(answered?.kind, "comment");

    const saved = service.updateDraft(PR, {
      draftId: draft.id,
      version: 1,
      body: draft.body,
      findings: [
        ...draft.findings,
        finding({
          id: "from-ai",
          questionId: second.id,
          evidence: "forged by client",
        }),
        finding({
          id: "from-explain",
          questionId: first.id,
          evidence: "forged",
        }),
        finding({ id: "unknown-q", questionId: "nope", evidence: "forged" }),
      ],
      verdict: "COMMENT",
    }).draft!;
    assert.deepEqual(
      saved.findings.map((item) => [item.id, item.evidence]),
      [
        ["review-finding", "- review evidence"],
        ["from-ai", "- checked +new line"],
        ["from-explain", ""],
        ["unknown-q", ""],
      ],
    );
    const again = service.updateDraft(PR, {
      draftId: draft.id,
      version: 2,
      body: draft.body,
      findings: saved.findings.map((item) => ({
        ...item,
        evidence: "overwrite attempt",
      })),
      verdict: "COMMENT",
    }).draft!;
    assert.equal(again.findings[1]!.evidence, "- checked +new line");

    const newer = await reviewed(service, github, HEAD2);
    const stale = service.updateDraft(PR, {
      draftId: newer.draft!.id,
      version: 1,
      body: "x",
      findings: [finding({ id: "cross-head", questionId: second.id })],
      verdict: "COMMENT",
    }).draft!;
    assert.equal(stale.findings[0]!.evidence, "");
    assert.throws(
      () =>
        service.ask(PR, {
          mode: "explain",
          range: range(),
          parentId: first.id,
        }),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "head_mismatch",
    );
  } finally {
    await cleanup();
  }
});

test("questions run beside reviews, cancel only their own work, and retry explicitly", async () => {
  const { service, github, reviewer, questioner, cleanup } =
    await makeService();
  try {
    await service.importPullRequest("https://github.com/owner/repo/pull/7");
    reviewer.hold = true;
    github.current = remote(HEAD1);
    await service.manualReview(PR);
    await waitFor(() => reviewer.inputs.length === 1);
    questioner.hold = true;
    const asked = service.ask(PR, { mode: "investigate", range: range() })
      .questions[0]!;
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "running",
    );
    assert.equal(service.getDetail(PR).runs[0]?.status, "running");
    const queued = service.ask(PR, { mode: "explain", range: range() })
      .questions[1]!;
    assert.equal(service.getDetail(PR).questions[1]?.status, "queued");
    service.cancelQuestion(PR, queued.id);
    assert.equal(service.getDetail(PR).questions[1]?.status, "cancelled");
    service.cancelQuestion(PR, asked.id);
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "cancelled",
    );
    assert.equal(
      service.getDetail(PR).questions[0]?.error,
      "Cancelled by the reviewer",
    );
    assert.equal(service.getDetail(PR).runs[0]?.status, "running");
    assert.throws(
      () => service.cancelQuestion(PR, asked.id),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "question_finished",
    );
    reviewer.finish();
    await waitFor(() => service.getDetail(PR).runs[0]?.status === "completed");

    questioner.hold = false;
    questioner.fail = true;
    service.retryQuestion(PR, asked.id);
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "failed",
    );
    assert.match(
      service.getDetail(PR).questions[0]!.error!,
      /question exploded/,
    );
    questioner.fail = false;
    service.retryQuestion(PR, asked.id);
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "completed",
    );
    assert.equal(service.getDetail(PR).questions[0]?.answer?.kind, "answer");
    assert.equal(questioner.inputs.length, 3);
    assert.throws(
      () => service.retryQuestion(PR, "missing"),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "not_found",
    );
  } finally {
    await cleanup();
  }
});

test("interrupted questions stay truthful after restart and never rerun automatically", async () => {
  const { service, questioner, dataDir, config } = await makeService();
  await service.importPullRequest("https://github.com/owner/repo/pull/7");
  questioner.hold = true;
  const running = service.ask(PR, { mode: "explain", range: range() })
    .questions[0]!;
  await waitFor(() => service.getDetail(PR).questions[0]?.status === "running");
  service.ask(PR, { mode: "explain", range: range() });
  await service.close();
  const restarted = await ReviewService.create(
    config,
    new FakeGithub(),
    new FakeReviewer(),
    new FakeQuestioner(),
  );
  try {
    const questions = restarted.getDetail(PR).questions;
    assert.deepEqual(
      questions.map((question) => question.status),
      ["interrupted", "interrupted"],
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      restarted.getDetail(PR).questions.map((question) => question.status),
      ["interrupted", "interrupted"],
    );
    assert.equal(questions[0]!.selection.snippet, running.selection.snippet);
    restarted.retryQuestion(PR, running.id);
    await waitFor(
      () => restarted.getDetail(PR).questions[0]?.status === "completed",
    );
  } finally {
    await restarted.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("existing databases gain anchor fields and manual draft support without losing drafts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-questions-migrate-"));
  const databasePath = join(dataDir, "app.sqlite");
  try {
    const first = await makeService(dataDir);
    await first.service.importPullRequest(
      "https://github.com/owner/repo/pull/7",
    );
    const detail = await reviewed(first.service, first.github, HEAD1);
    await first.service.close();

    const legacyFinding = {
      id: "legacy",
      severity: "blocking",
      path: "src/a.ts",
      line: 2,
      body: "Legacy",
      evidence: "kept",
      origin: "introduced",
      included: true,
    };
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TABLE questions");
    raw.exec(`
      ALTER TABLE drafts RENAME TO drafts_new;
      CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        head_sha TEXT NOT NULL,
        version INTEGER NOT NULL,
        overview TEXT NOT NULL,
        body TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO drafts SELECT * FROM drafts_new;
      DROP TABLE drafts_new;
    `);
    raw
      .prepare("UPDATE drafts SET findings_json = ?, version = 4 WHERE id = ?")
      .run(JSON.stringify([legacyFinding]), detail.draft!.id);
    raw.prepare("UPDATE runs SET result_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...detail.runs[0]!.result,
        findings: [legacyFinding],
      }),
      detail.runs[0]!.id,
    );
    raw.close();

    const db = await AppDatabase.open(databasePath);
    const migrated = db.getDraft(PR, detail.draft!.id)!;
    assert.deepEqual(migrated.findings, [
      { ...legacyFinding, side: "RIGHT", startLine: null, questionId: null },
    ]);
    assert.equal(migrated.version, 4);
    assert.deepEqual(
      db.getRun(detail.runs[0]!.id)!.result!.findings[0],
      migrated.findings[0],
    );
    db.createDraft(
      {
        id: "manual",
        runId: null,
        headSha: HEAD1,
        version: 1,
        overview: "",
        body: "",
        findings: [],
        verdict: "COMMENT",
        createdAt: "2027-01-01T00:00:00.000Z",
        updatedAt: "2027-01-01T00:00:00.000Z",
      },
      PR,
    );
    assert.deepEqual(
      db.listDrafts(PR).map((draft) => [draft.id, draft.runId]),
      [
        ["manual", null],
        [migrated.id, detail.runs[0]!.id],
      ],
    );
    db.close();
    const reopened = await AppDatabase.open(databasePath);
    assert.equal(reopened.listDrafts(PR).length, 2);
    reopened.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("HTTP routes expose manual drafts and the question lifecycle", async () => {
  const { service, config, questioner, cleanup } = await makeService();
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as never };
  };
  try {
    await service.importPullRequest("https://github.com/owner/repo/pull/7");
    const prPath = `/api/prs/${encodeURIComponent(PR)}`;
    const created = await call("POST", `${prPath}/drafts`, {});
    assert.equal(created.status, 201);
    assert.equal(
      (created.json as { draft: { runId: string | null } }).draft.runId,
      null,
    );
    const invalid = await call("POST", `${prPath}/questions`, {
      mode: "explain",
      range: {
        path: "src/a.ts",
        from: { side: "UP", line: 1 },
        to: {},
        baseSha: BASE,
        headSha: HEAD1,
      },
    });
    assert.equal(invalid.status, 400);
    questioner.hold = true;
    const asked = await call("POST", `${prPath}/questions`, {
      mode: "explain",
      range: range(),
      question: "q",
    });
    assert.equal(asked.status, 202);
    const questionId = (asked.json as { questions: Array<{ id: string }> })
      .questions[0]!.id;
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "running",
    );
    const cancelled = await call(
      "POST",
      `${prPath}/questions/${questionId}/cancel`,
      {},
    );
    assert.equal(cancelled.status, 200);
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "cancelled",
    );
    questioner.hold = false;
    const retried = await call(
      "POST",
      `${prPath}/questions/${questionId}/retry`,
      {},
    );
    assert.equal(retried.status, 202);
    await waitFor(
      () => service.getDetail(PR).questions[0]?.status === "completed",
    );
    const detail = await call("GET", prPath);
    assert.equal(
      (detail.json as { questions: Array<{ answer: QuestionAnswer }> })
        .questions[0]!.answer.kind,
      "answer",
    );
    const missing = await call("POST", `${prPath}/questions/nope/cancel`, {});
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    await cleanup();
  }
});

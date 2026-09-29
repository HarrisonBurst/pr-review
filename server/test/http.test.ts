import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";

import {
  automationOff,
  inheritAutomation,
  type AppState,
  type MergeReadiness,
  type PullRequest,
  type PullRequestDetail,
  type ReviewPayload,
  type ReviewResult,
  type Submission,
  type SubmissionPreview,
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

const fixture = (): RemotePullRequest => ({
  pr: {
    id: prId("owner/repo", 3),
    number: 3,
    repository: "owner/repo",
    url: "https://github.com/owner/repo/pull/3",
    title: "HTTP fixture",
    body: "",
    author: "author",
    authorAvatarUrl: null,
    headSha: "head",
    baseSha: "base",
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
  },
  diff: "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n",
  diffTruncated: false,
});

class HttpGithub implements GithubAdapter {
  readonly demo = false;
  readonly item = fixture();
  async health() {
    return { user: "tester", message: "test" };
  }
  async getPullRequest() {
    return this.item;
  }
  async poll(): Promise<PollResult> {
    return {
      user: "tester",
      pullRequests: [this.item],
      requests: [
        {
          eventId: "http-event",
          prId: this.item.pr.id,
          headSha: this.item.pr.headSha,
          requestedAt: this.item.pr.requestedAt!,
        },
      ],
    };
  }
  async submitReview(_pr: PullRequest, _payload: ReviewPayload) {
    return { githubReviewId: "review", url: null };
  }
  async compareCommits(): Promise<CommitComparison> {
    return { status: "identical", commits: [], truncated: false };
  }
  async findReview() {
    return null;
  }
  async mergeReadiness(pr: PullRequest): Promise<MergeReadiness> {
    return unknownReadiness(pr);
  }
}

class HttpReviewer implements ReviewerAdapter {
  async health() {
    return { status: "ready" as const, message: "test" };
  }
  async run(): Promise<{ result: ReviewResult; log: string }> {
    return {
      result: {
        overview: "overview",
        body: "summary",
        findings: [],
        verdict: "COMMENT",
        rationale: "rationale",
      },
      log: "test",
    };
  }
}

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-http-"));
  const config = loadConfig({
    host: "127.0.0.1",
    port: 4317,
    dataDir,
    databasePath: join(dataDir, "app.sqlite"),
    demo: false,
    reviewer: {
      skillPath: "/tmp/skill",
      model: null,
      additionalInstructions: "",
    },
  });
  const github = new HttpGithub();
  const service = await ReviewService.create(
    config,
    github,
    new HttpReviewer(),
  );
  await saveFixtureExecution(service);
  service.db.updateSettings({ repository: "owner/repo" });
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const prUrl = `http://127.0.0.1:${port}/api/prs/${encodeURIComponent(github.item.pr.id)}`;
  const post = (url: string, body: unknown, headers: HeadersInit = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  return { service, github, port, prUrl, post, close };
}

async function detailAfterReviews(prUrl: string, count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = (await (await fetch(prUrl)).json()) as PullRequestDetail;
    if (detail.drafts.length === count) return detail;
    await setImmediate();
  }
  assert.fail(`timed out waiting for ${count} drafts`);
}

test("HTTP state and API origin protections work on loopback", async () => {
  const { service, github, port, prUrl, post, close } = await startServer();
  try {
    const state = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(state.status, 200);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: "POST",
      headers: { Origin: "http://evil.example" },
      body: "{}",
    });
    assert.equal(blocked.status, 403);
    const sync = await fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(sync.status, 200);
    await setImmediate();
    const synced = (await sync.json()) as AppState;
    assert.deepEqual(synced.settings.automation, automationOff);
    assert.equal(synced.prs[0]?.hasReviewedHead, false);
    assert.equal(service.getDetail(github.item.pr.id).runs.length, 0);
    const integrations = await fetch(
      `http://127.0.0.1:${port}/api/settings/integrations`,
    );
    assert.equal(integrations.status, 200);
    assert.deepEqual((await integrations.json()).connections, []);
    const missing = await fetch(
      `http://127.0.0.1:${port}/api/settings/integrations/linear`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, allowedTools: ["issue"] }),
      },
    );
    assert.equal(missing.status, 404);
    assert.equal(
      (
        await post(
          `http://127.0.0.1:${port}/api/settings/integrations/linear/test`,
          {},
        )
      ).status,
      404,
    );
    const execution = await (
      await fetch(`http://127.0.0.1:${port}/api/settings/execution`)
    ).json();
    assert.equal(execution.status, "disabled");
    assert.equal(
      (await post(`http://127.0.0.1:${port}/api/settings/execution/check`, {}))
        .status,
      409,
    );
    const review = await post(`${prUrl}/review`, {});
    assert.equal(review.status, 202);
    const data = await detailAfterReviews(prUrl, 1);
    assert.ok(data.draft);
    assert.equal(data.pr.hasReviewedHead, true);
    const reviewedState = (await (
      await fetch(`http://127.0.0.1:${port}/api/state`)
    ).json()) as AppState;
    assert.equal(reviewedState.prs[0]?.hasReviewedHead, true);
    const previewResponse = await post(`${prUrl}/preview`, {
      draftId: data.draft.id,
      draftVersion: data.draft.version,
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as SubmissionPreview;
    let submissionId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post(`${prUrl}/submit`, { previewId: preview.id });
      assert.equal(response.status, 200);
      const submission = (await response.json()) as Submission;
      assert.equal(submission.status, "submitted");
      assert.equal(submission.previewId, preview.id);
      assert.deepEqual(submission.payload, preview.payload);
      assert.equal(submission.githubReviewId, "review");
      if (submissionId) assert.equal(submission.id, submissionId);
      submissionId = submission.id;
    }
  } finally {
    await close();
  }
});

test("submitting an older draft over HTTP leaves the newer draft ready until it is submitted itself", async () => {
  const { port, prUrl, post, close } = await startServer();
  try {
    assert.equal(
      (await post(`http://127.0.0.1:${port}/api/sync`, {})).status,
      200,
    );
    assert.equal((await post(`${prUrl}/review`, {})).status, 202);
    const first = await detailAfterReviews(prUrl, 1);
    await post(`${prUrl}/review`, {});
    const second = await detailAfterReviews(prUrl, 2);
    const older = first.draft!;
    const latest = second.draft!;
    assert.notEqual(older.id, latest.id);
    const olderPreview = (await (
      await post(`${prUrl}/preview`, {
        draftId: older.id,
        draftVersion: older.version,
      })
    ).json()) as SubmissionPreview;
    const olderSubmit = await post(`${prUrl}/submit`, {
      previewId: olderPreview.id,
    });
    assert.equal(olderSubmit.status, 200);
    assert.equal(
      ((await olderSubmit.json()) as Submission).status,
      "submitted",
    );
    const active = (await (await fetch(prUrl)).json()) as PullRequestDetail;
    assert.equal(active.pr.status, "ready");
    assert.equal(active.draft?.id, latest.id);
    const latestPreview = (await (
      await post(`${prUrl}/preview`, {
        draftId: latest.id,
        draftVersion: latest.version,
      })
    ).json()) as SubmissionPreview;
    assert.equal(
      (await post(`${prUrl}/submit`, { previewId: latestPreview.id })).status,
      200,
    );
    const settled = (await (await fetch(prUrl)).json()) as PullRequestDetail;
    assert.equal(settled.pr.status, "submitted");
    assert.equal(settled.submissions.length, 2);
  } finally {
    await close();
  }
});

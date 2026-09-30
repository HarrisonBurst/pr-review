import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  automationOff,
  inheritAutomation,
  type MergeReadiness,
  type PullRequest,
  type ReviewerSettings,
} from "../../shared/contracts.js";
import {
  GithubCliAdapter,
  GithubRequestError,
  deriveMergeReadiness,
  type CommitComparison,
  type GithubAdapter,
  type PollResult,
  type RemotePullRequest,
  type ReviewSubmissionResult,
  type ReviewerAdapter,
} from "../adapters.js";
import { loadConfig } from "../config.js";
import { ReviewService } from "../service.js";
import { prId } from "../util.js";

const head = "a".repeat(40);
const newer = "c".repeat(40);
const checkedAt = "2026-02-01T00:00:00.000Z";

function pullRequest(headSha = head): PullRequest {
  return {
    id: prId("owner/repo", 7),
    number: 7,
    repository: "owner/repo",
    url: "https://github.com/owner/repo/pull/7",
    title: "Fixture PR",
    body: "Fixture",
    author: "author",
    authorAvatarUrl: null,
    headSha,
    baseSha: "b".repeat(40),
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
    hasReviewHistory: false,
    mergeReadiness: null,
    automation: inheritAutomation,
    effectiveAutomation: automationOff,
  };
}

type Context =
  | {
      __typename: "CheckRun";
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      isRequired: boolean;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string;
      targetUrl: string | null;
      isRequired: boolean;
    };

const checkRun = (
  name: string,
  conclusion: string | null,
  isRequired: boolean,
  status = "COMPLETED",
): Context => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/owner/repo/actions/runs/1/job/${name}`,
  isRequired,
});

function response(over: {
  isDraft?: boolean;
  state?: "OPEN" | "CLOSED" | "MERGED";
  headRefOid?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus?: string;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  isInMergeQueue?: boolean;
  contexts?: Context[];
  totalCount?: number;
  rollup?: null;
  commitOid?: string;
  noCommits?: boolean;
  errors?: string[];
}) {
  const contexts = over.contexts ?? [];
  return {
    errors: over.errors?.map((message) => ({ message })),
    data: {
      repository: {
        pullRequest: {
          isDraft: over.isDraft ?? false,
          state: over.state ?? "OPEN",
          headRefOid: over.headRefOid ?? head,
          mergeable: over.mergeable ?? "MERGEABLE",
          mergeStateStatus: over.mergeStateStatus ?? "CLEAN",
          reviewDecision:
            over.reviewDecision === undefined ? null : over.reviewDecision,
          isInMergeQueue: over.isInMergeQueue ?? false,
          commits: {
            nodes: over.noCommits
              ? []
              : [
                  {
                    commit: {
                      oid: over.commitOid ?? over.headRefOid ?? head,
                      statusCheckRollup:
                        over.rollup === null
                          ? null
                          : {
                              state: "PENDING",
                              contexts: {
                                totalCount: over.totalCount ?? contexts.length,
                                nodes: contexts,
                              },
                            },
                    },
                  },
                ],
          },
        },
      },
    },
  };
}

const derive = (over: Parameters<typeof response>[0]) =>
  deriveMergeReadiness(pullRequest(), response(over), checkedAt);

const kinds = (readiness: MergeReadiness) =>
  readiness.blockers.map((blocker) => `${blocker.kind}:${blocker.required}`);

test("CLEAN with no review requirement is ready and bound to the exact head", () => {
  const readiness = derive({
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    contexts: [checkRun("build", "SUCCESS", true)],
  });
  assert.equal(readiness.state, "ready");
  assert.equal(readiness.headSha, head);
  assert.equal(readiness.checkedAt, checkedAt);
  assert.equal(readiness.mergeStateStatus, "CLEAN");
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.error, null);
});

test("a null review decision never counts as a missing review", () => {
  const readiness = derive({
    mergeStateStatus: "BLOCKED",
    reviewDecision: null,
    contexts: [checkRun("build", "FAILURE", true)],
  });
  assert.deepEqual(kinds(readiness), ["checks_failed:true"]);
});

test("REVIEW_REQUIRED and CHANGES_REQUESTED are current decisions, not history", () => {
  const waiting = derive({
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
  });
  assert.equal(waiting.state, "blocked");
  assert.deepEqual(kinds(waiting), ["review_required:true"]);
  assert.equal(
    waiting.blockers[0]!.url,
    "https://github.com/owner/repo/pull/7",
  );
  const changes = derive({
    mergeStateStatus: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
  });
  assert.deepEqual(kinds(changes), ["changes_requested:true"]);
  const superseded = derive({
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
  });
  assert.equal(superseded.state, "ready");
  assert.deepEqual(superseded.blockers, []);
});

test("changes requested on a CLEAN pull request is an advisory, not a blocker", () => {
  const readiness = derive({
    mergeStateStatus: "CLEAN",
    reviewDecision: "CHANGES_REQUESTED",
  });
  assert.equal(readiness.state, "ready");
  assert.deepEqual(kinds(readiness), ["changes_requested:false"]);
});

test("required and optional checks are reported separately with counts and links", () => {
  const readiness = derive({
    mergeStateStatus: "BLOCKED",
    reviewDecision: "APPROVED",
    contexts: [
      checkRun("build", "FAILURE", true),
      checkRun("lint", "TIMED_OUT", true),
      checkRun("deploy-preview", null, true, "IN_PROGRESS"),
      checkRun("coverage", "FAILURE", false),
      checkRun("docs", "SKIPPED", false),
      checkRun("format", "SUCCESS", true),
      {
        __typename: "StatusContext",
        context: "ci/external",
        state: "PENDING",
        targetUrl: "https://ci.example/1",
        isRequired: false,
      },
    ],
  });
  assert.equal(readiness.state, "blocked");
  assert.deepEqual(kinds(readiness), [
    "checks_failed:true",
    "checks_pending:true",
    "checks_failed:false",
    "checks_pending:false",
  ]);
  const [failed, pending, optionalFailed, optionalPending] = readiness.blockers;
  assert.equal(failed!.summary, "2 required checks failed");
  assert.equal(failed!.detail, "build, lint");
  assert.equal(failed!.url, "https://github.com/owner/repo/pull/7/checks");
  assert.equal(pending!.summary, "1 required check pending");
  assert.equal(
    pending!.url,
    "https://github.com/owner/repo/actions/runs/1/job/deploy-preview",
  );
  assert.equal(optionalFailed!.summary, "1 check failed");
  assert.equal(optionalPending!.summary, "1 check pending");
  assert.equal(optionalPending!.url, "https://ci.example/1");
});

test("UNSTABLE is mergeable with non-required checks failing, never ready", () => {
  const readiness = derive({
    mergeStateStatus: "UNSTABLE",
    reviewDecision: "APPROVED",
    contexts: [
      checkRun("coverage", "FAILURE", false),
      checkRun("build", "SUCCESS", true),
    ],
  });
  assert.equal(readiness.state, "unstable");
  assert.deepEqual(kinds(readiness), ["checks_failed:false"]);
  assert.equal(readiness.blockers[0]!.summary, "1 check failed");
});

test("draft, conflicts, and behind are distinct blockers and can stack", () => {
  assert.deepEqual(
    kinds(derive({ isDraft: true, mergeStateStatus: "DRAFT" })),
    ["draft:true"],
  );
  const conflicts = derive({
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
  });
  assert.equal(conflicts.state, "blocked");
  assert.deepEqual(kinds(conflicts), ["conflicts:true"]);
  assert.deepEqual(kinds(derive({ mergeStateStatus: "BEHIND" })), [
    "behind:true",
  ]);
  const stacked = derive({
    isDraft: true,
    mergeStateStatus: "DRAFT",
    mergeable: "CONFLICTING",
    reviewDecision: "CHANGES_REQUESTED",
    contexts: [checkRun("build", "FAILURE", true)],
  });
  assert.equal(stacked.state, "blocked");
  assert.deepEqual(kinds(stacked), [
    "draft:true",
    "conflicts:true",
    "changes_requested:true",
    "checks_failed:true",
  ]);
});

test("BLOCKED without an exposed cause is a truthful generic blocker with a link", () => {
  const readiness = derive({
    mergeStateStatus: "BLOCKED",
    reviewDecision: "APPROVED",
    contexts: [checkRun("build", "SUCCESS", true)],
  });
  assert.equal(readiness.state, "blocked");
  assert.deepEqual(kinds(readiness), ["blocked:true"]);
  assert.equal(
    readiness.blockers[0]!.url,
    "https://github.com/owner/repo/pull/7",
  );
});

test("a merge queue entry is queued, and UNKNOWN is still computing", () => {
  assert.equal(derive({ isInMergeQueue: true }).state, "queued");
  const unknown = derive({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.error ?? "", /still computing/);
  assert.equal(
    derive({ rollup: null, mergeStateStatus: "CLEAN" }).state,
    "ready",
  );
});

test("a truncated check list is flagged and counted as a lower bound", () => {
  const readiness = derive({
    mergeStateStatus: "BLOCKED",
    contexts: [checkRun("build", "FAILURE", true)],
    totalCount: 140,
  });
  assert.equal(readiness.checksTruncated, true);
  assert.equal(
    readiness.blockers[0]!.summary,
    "at least 1 required checks failed",
  );
});

test("a response for a newer head is never green for the recorded head", () => {
  const readiness = derive({ headRefOid: newer, mergeStateStatus: "CLEAN" });
  assert.equal(readiness.state, "unknown");
  assert.equal(readiness.headSha, head);
  assert.match(readiness.error ?? "", /moved to ccccccc/);
});

test("CLEAN is never ready alongside contradictory evidence, and required checks keep their label", () => {
  const draft = derive({ isDraft: true, mergeStateStatus: "CLEAN" });
  assert.equal(draft.state, "unknown");
  assert.deepEqual(kinds(draft), ["draft:true"]);
  assert.match(draft.error ?? "", /CLEAN alongside draft pull request/);
  const conflicting = derive({
    mergeable: "CONFLICTING",
    mergeStateStatus: "HAS_HOOKS",
  });
  assert.equal(conflicting.state, "unknown");
  assert.deepEqual(kinds(conflicting), ["conflicts:true"]);
  const failing = derive({
    mergeStateStatus: "CLEAN",
    contexts: [
      checkRun("build", "FAILURE", true),
      checkRun("coverage", "FAILURE", false),
    ],
  });
  assert.equal(failing.state, "unknown");
  assert.deepEqual(kinds(failing), [
    "checks_failed:true",
    "checks_failed:false",
  ]);
  assert.equal(failing.blockers[0]!.summary, "1 required check failed");
  assert.match(failing.error ?? "", /1 required check failed/);
  const unstable = derive({
    mergeStateStatus: "UNSTABLE",
    contexts: [checkRun("build", null, true, "IN_PROGRESS")],
  });
  assert.equal(unstable.state, "unknown");
  assert.deepEqual(kinds(unstable), ["checks_pending:true"]);
  const optional = derive({
    mergeStateStatus: "CLEAN",
    contexts: [checkRun("coverage", "FAILURE", false)],
  });
  assert.equal(optional.state, "ready");
  assert.deepEqual(kinds(optional), ["checks_failed:false"]);
});

test("still-computing mergeability is unknown even when the status says CLEAN", () => {
  const readiness = derive({ mergeable: "UNKNOWN", mergeStateStatus: "CLEAN" });
  assert.equal(readiness.state, "unknown");
  assert.match(readiness.error ?? "", /still computing/);
});

test("GraphQL errors beside partial data never claim ready", () => {
  const readiness = derive({
    mergeStateStatus: "CLEAN",
    errors: ["Resource not accessible by integration"],
  });
  assert.equal(readiness.state, "unknown");
  assert.deepEqual(readiness.blockers, []);
  assert.match(readiness.error ?? "", /partial data: Resource not accessible/);
});

test("a closed or merged answer for a stored open pull request is unknown, not ready", () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const readiness = derive({ state, mergeStateStatus: "CLEAN" });
    assert.equal(readiness.state, "unknown");
    assert.deepEqual(readiness.blockers, []);
    assert.match(readiness.error ?? "", new RegExp(state.toLowerCase()));
  }
});

test("a latest commit that is not the head, or no commit at all, is unknown", () => {
  const mismatch = derive({ commitOid: newer, mergeStateStatus: "CLEAN" });
  assert.equal(mismatch.state, "unknown");
  assert.match(mismatch.error ?? "", /ccccccc is not the current head/);
  const missing = derive({ noCommits: true, mergeStateStatus: "CLEAN" });
  assert.equal(missing.state, "unknown");
  assert.match(missing.error ?? "", /no commit/);
});

test("a truncated check list cannot confirm CLEAN but still bounds a blocked count", () => {
  const clean = derive({
    mergeStateStatus: "CLEAN",
    contexts: [checkRun("build", "SUCCESS", true)],
    totalCount: 140,
  });
  assert.equal(clean.state, "unknown");
  assert.equal(clean.checksTruncated, true);
  assert.match(clean.error ?? "", /only 1 of 140 checks/);
  const unstable = derive({
    mergeStateStatus: "UNSTABLE",
    contexts: [checkRun("coverage", "FAILURE", false)],
    totalCount: 140,
  });
  assert.equal(unstable.state, "unstable");
  assert.equal(unstable.checksTruncated, true);
});

test("a missing pull request in the GraphQL response is a request error", () => {
  assert.throws(
    () =>
      deriveMergeReadiness(
        pullRequest(),
        { errors: [{ message: "Could not resolve to a PullRequest" }] },
        checkedAt,
      ),
    (error: unknown) =>
      error instanceof GithubRequestError &&
      /Could not resolve/.test(error.message),
  );
});

async function makeFakeGh() {
  const directory = await mkdtemp(join(tmpdir(), "pr-review-merge-gh-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const responsesPath = join(directory, "responses.json");
  const logPath = join(directory, "calls.jsonl");
  const script = join(bin, "gh");
  await writeFile(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const responses = JSON.parse(fs.readFileSync(process.env.FAKE_GH_RESPONSES, "utf8"));
const match = responses[args[1]] ?? { stderr: "gh: Not Found (HTTP 404)", code: 1 };
Promise.all([
  new Promise((resolve) => process.stdout.write(match.stdout ?? "", resolve)),
  new Promise((resolve) => process.stderr.write(match.stderr ?? "", resolve)),
]).then(() => process.exit(match.code ?? 0));
`,
  );
  await chmod(script, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.FAKE_GH_LOG = logPath;
  process.env.FAKE_GH_RESPONSES = responsesPath;
  return {
    respond: (
      responses: Record<
        string,
        { stdout?: string; stderr?: string; code?: number }
      >,
    ) => writeFile(responsesPath, JSON.stringify(responses)),
    calls: async () =>
      (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    cleanup: async () => {
      process.env.PATH = originalPath;
      delete process.env.FAKE_GH_LOG;
      delete process.env.FAKE_GH_RESPONSES;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("the CLI adapter asks GraphQL for the exact pull request and maps the answer", async () => {
  const gh = await makeFakeGh();
  try {
    await gh.respond({
      graphql: {
        stdout: JSON.stringify(
          response({
            mergeStateStatus: "BLOCKED",
            reviewDecision: "REVIEW_REQUIRED",
            contexts: [checkRun("build", null, true, "QUEUED")],
          }),
        ),
      },
    });
    const readiness = await new GithubCliAdapter().mergeReadiness(
      pullRequest(),
    );
    assert.equal(readiness.state, "blocked");
    assert.deepEqual(kinds(readiness), [
      "review_required:true",
      "checks_pending:true",
    ]);
    const [call] = await gh.calls();
    assert.equal(call![0], "api");
    assert.equal(call![1], "graphql");
    assert.ok(call!.includes("owner=owner"));
    assert.ok(call!.includes("name=repo"));
    assert.ok(call!.includes("number=7"));
    assert.match(call!.join(" "), /mergeStateStatus reviewDecision/);
    assert.match(call!.join(" "), /isRequired\(pullRequestNumber: \$number\)/);
  } finally {
    await gh.cleanup();
  }
});

test("the CLI adapter reports GitHub failures instead of inventing a state", async () => {
  const gh = await makeFakeGh();
  try {
    await gh.respond({
      graphql: { stderr: "gh: API rate limit exceeded (HTTP 403)", code: 1 },
    });
    await assert.rejects(
      new GithubCliAdapter().mergeReadiness(pullRequest()),
      (error: unknown) =>
        error instanceof GithubRequestError && error.httpStatus === 403,
    );
  } finally {
    await gh.cleanup();
  }
});

const reviewerSettings: ReviewerSettings = {
  skillPath: "/tmp/skill/SKILL.md",
  model: null,
  additionalInstructions: "",
};

function remote(headSha = head): RemotePullRequest {
  return {
    pr: pullRequest(headSha),
    diff: `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+line from ${headSha}\n`,
    diffTruncated: false,
  };
}

const ready = (headSha: string): MergeReadiness => ({
  headSha,
  checkedAt,
  state: "ready",
  mergeStateStatus: "CLEAN",
  blockers: [],
  checksTruncated: false,
  error: null,
  lastKnown: null,
});

class FakeGithub implements GithubAdapter {
  readonly demo = false;
  current = remote();
  readiness: MergeReadiness | Error = ready(head);
  readinessCalls = 0;
  async health() {
    return { user: "tester", message: "fake" };
  }
  async getPullRequest() {
    return this.current;
  }
  async poll(): Promise<PollResult> {
    return { user: "tester", pullRequests: [this.current], requests: [] };
  }
  async compareCommits(): Promise<CommitComparison> {
    return { status: "identical", commits: [], truncated: false };
  }
  async submitReview(): Promise<ReviewSubmissionResult> {
    throw new Error("not used");
  }
  async findReview() {
    return null;
  }
  async mergeReadiness(): Promise<MergeReadiness> {
    this.readinessCalls += 1;
    if (this.readiness instanceof Error) throw this.readiness;
    return this.readiness;
  }
}

class IdleReviewer implements ReviewerAdapter {
  async health() {
    return { status: "ready" as const, message: "fake" };
  }
  async run(): Promise<never> {
    throw new Error("not used");
  }
}

async function makeService(github = new FakeGithub()) {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-merge-"));
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
    new IdleReviewer(),
  );
  service.db.updateSettings({ repository: "owner/repo" });
  return {
    service,
    github,
    config,
    cleanup: async () => {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const id = prId("owner/repo", 7);

test("sync and manual check record readiness for the exact head; state reads never call GitHub", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    await service.sync();
    assert.equal(github.readinessCalls, 1);
    assert.deepEqual(service.getState().prs[0]!.mergeReadiness, ready(head));
    service.getState();
    service.getDetail(id);
    assert.equal(github.readinessCalls, 1);
    github.readiness = {
      ...ready(head),
      state: "blocked",
      mergeStateStatus: "BLOCKED",
      blockers: [
        {
          kind: "review_required",
          summary: "review required",
          detail: null,
          url: "https://github.com/owner/repo/pull/7",
          required: true,
        },
      ],
    };
    const detail = await service.checkFreshness(id);
    assert.equal(github.readinessCalls, 2);
    assert.equal(detail.pr.mergeReadiness?.state, "blocked");
    assert.equal(
      detail.pr.mergeReadiness?.blockers[0]?.kind,
      "review_required",
    );
  } finally {
    await cleanup();
  }
});

test("a failed same-head lookup is unknown with the last known result labeled, then a retry restores it", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    await service.sync();
    github.readiness = new GithubRequestError(
      "gh api graphql failed: rate limited (HTTP 403)",
      403,
    );
    await service.sync();
    const failed = service.getState().prs[0]!.mergeReadiness!;
    assert.equal(failed.state, "unknown");
    assert.equal(failed.headSha, head);
    assert.deepEqual(failed.blockers, []);
    assert.notEqual(failed.checkedAt, checkedAt);
    assert.match(failed.error ?? "", /rate limited/);
    assert.deepEqual(failed.lastKnown, {
      checkedAt,
      state: "ready",
      mergeStateStatus: "CLEAN",
      blockers: [],
      checksTruncated: false,
    });
    assert.equal(service.getState().health.pollError, null);
    await service.sync();
    const again = service.getState().prs[0]!.mergeReadiness!;
    assert.equal(again.state, "unknown");
    assert.equal(again.lastKnown?.checkedAt, checkedAt);
    const later = "2026-02-02T00:00:00.000Z";
    github.readiness = { ...ready(head), checkedAt: later };
    await service.sync();
    const restored = service.getState().prs[0]!.mergeReadiness!;
    assert.equal(restored.state, "ready");
    assert.equal(restored.checkedAt, later);
    assert.equal(restored.error, null);
    assert.equal(restored.lastKnown, null);
  } finally {
    await cleanup();
  }
});

test("a fresh unknown answer keeps the last known result; a failure after unknown keeps nothing", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    await service.sync();
    github.readiness = {
      ...ready(head),
      state: "unknown",
      mergeStateStatus: "UNKNOWN",
      error: "GitHub is still computing mergeability",
    };
    await service.sync();
    const computing = service.getState().prs[0]!.mergeReadiness!;
    assert.equal(computing.state, "unknown");
    assert.equal(computing.lastKnown?.state, "ready");
    github.readiness = new Error("network down");
    await service.sync();
    assert.equal(
      service.getState().prs[0]!.mergeReadiness!.lastKnown?.state,
      "ready",
    );
    const {
      service: fresh,
      github: freshGithub,
      cleanup: freshCleanup,
    } = await makeService();
    try {
      freshGithub.readiness = new Error("network down");
      await fresh.sync();
      const readiness = fresh.getState().prs[0]!.mergeReadiness!;
      assert.equal(readiness.state, "unknown");
      assert.equal(readiness.lastKnown, null);
    } finally {
      await freshCleanup();
    }
  } finally {
    await cleanup();
  }
});

test("a head change with a failing lookup leaves the old head's evidence stale, not green", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    await service.sync();
    github.current = remote(newer);
    github.readiness = new Error("network down");
    await service.checkFreshness(id);
    const pr = service.getDetail(id).pr;
    assert.equal(pr.headSha, newer);
    assert.equal(pr.mergeReadiness?.headSha, newer);
    assert.equal(pr.mergeReadiness?.state, "unknown");
    assert.deepEqual(pr.mergeReadiness?.blockers, []);
    assert.equal(pr.mergeReadiness?.lastKnown, null);
    assert.match(pr.mergeReadiness?.error ?? "", /network down/);
  } finally {
    await cleanup();
  }
});

test("an answer for a different head than the stored one is recorded as unknown", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    github.readiness = ready(newer);
    await service.sync();
    const readiness = service.getState().prs[0]!.mergeReadiness!;
    assert.equal(readiness.headSha, head);
    assert.equal(readiness.state, "unknown");
    assert.equal(readiness.lastKnown, null);
    assert.match(readiness.error ?? "", /ccccccc instead of the current head/);
  } finally {
    await cleanup();
  }
});

test("readiness is skipped for closed or merged pull requests and preserved on the detail page", async () => {
  const { service, github, cleanup } = await makeService();
  try {
    await service.sync();
    github.current = {
      ...remote(),
      pr: { ...pullRequest(), state: "MERGED", requested: false },
    };
    await service.sync();
    assert.equal(github.readinessCalls, 1);
    const detail = service.getDetail(id);
    assert.equal(detail.pr.state, "MERGED");
    assert.deepEqual(detail.pr.mergeReadiness, ready(head));
    assert.deepEqual(service.getState().prs, []);
  } finally {
    await cleanup();
  }
});

test("a legacy database projects no readiness until the next refresh", async () => {
  const { service, github, config, cleanup } = await makeService();
  try {
    await service.sync();
    service.db.sqlite.exec(
      "ALTER TABLE merge_readiness DROP COLUMN last_known_json",
    );
    await service.close();
    const migrated = await ReviewService.create(
      config,
      github,
      new IdleReviewer(),
    );
    try {
      assert.deepEqual(migrated.getState().prs[0]!.mergeReadiness, ready(head));
      migrated.db.sqlite.exec("DROP TABLE merge_readiness");
    } finally {
      await migrated.close();
    }
    const reopened = await ReviewService.create(
      config,
      github,
      new IdleReviewer(),
    );
    try {
      assert.equal(reopened.getState().prs[0]!.mergeReadiness, null);
      assert.equal(reopened.getDetail(id).pr.mergeReadiness, null);
      await reopened.checkFreshness(id);
      assert.deepEqual(reopened.getDetail(id).pr.mergeReadiness, ready(head));
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(config.dataDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await cleanup().catch(() => undefined);
  }
});

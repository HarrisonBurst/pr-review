import { saveFixtureExecution } from "./fixtures/current-settings.js";
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
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  automationOff,
  type AppState,
  type PullRequest,
  type ReviewerSettings,
} from "../../shared/contracts.js";
import {
  GithubCliAdapter,
  GithubRequestError,
  type ReviewerAdapter,
  type ReviewerInput,
} from "../adapters.js";
import { loadConfig } from "../config.js";
import { createHttpServer } from "../http.js";
import { ReviewService, ServiceError } from "../service.js";
import { prId } from "../util.js";

const base = "b".repeat(40);
const headA = "a".repeat(40);
const headB = "c".repeat(40);

const diffFor = (head: string) =>
  `diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+line from ${head}\n`;

const pullFor = (number: number, head: string, body = "Fixture"): string =>
  JSON.stringify({
    number,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    title: "Fixture PR",
    body,
    user: { login: "author" },
    head: { sha: head, ref: "feature" },
    base: { sha: base, ref: "main" },
    state: "open",
    merged_at: null,
    created_at: "2025-12-31T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    additions: 1,
    deletions: 0,
    changed_files: 1,
  });

const pull = (head: string) => pullFor(7, head);

type Responses = Record<
  string,
  { stdout?: string; stderr?: string; code?: number }
>;

async function makeFakeGh() {
  const directory = await mkdtemp(join(tmpdir(), "pr-review-gh-"));
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
let stdout = match.stdout ?? "";
const jq = args.indexOf("--jq");
if (jq >= 0 && args[jq + 1].startsWith("[.[] | {number, users:"))
  stdout = JSON.stringify(
    JSON.parse(stdout).map((row) => {
      const current = responses[\`\${args[1].split("?")[0]}/\${row.number}/requested_reviewers\`];
      const fallback = current ? JSON.parse(current.stdout ?? "{}") : {};
      return {
        number: row.number,
        users: (row.requested_reviewers ?? fallback.users ?? []).map((user) => user.login),
        teams: (row.requested_teams ?? fallback.teams ?? []).map((team) => team.id),
      };
    }),
  );
Promise.all([
  new Promise((resolve) => process.stdout.write(stdout, resolve)),
  new Promise((resolve) => process.stderr.write(match.stderr ?? "", resolve)),
]).then(() => process.exit(match.code ?? 0));
`,
  );
  await chmod(script, 0o755);
  const originalEnv = { ...process.env };
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.FAKE_GH_LOG = logPath;
  process.env.FAKE_GH_RESPONSES = responsesPath;
  return {
    directory,
    respond: (responses: Responses) =>
      writeFile(responsesPath, JSON.stringify(responses)),
    calls: async () =>
      (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    cleanup: async () => {
      process.env.PATH = originalEnv.PATH;
      delete process.env.FAKE_GH_LOG;
      delete process.env.FAKE_GH_RESPONSES;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const pushedBetweenCalls: Responses = {
  "repos/owner/repo/pulls/7": { stdout: pull(headA) },
  "repos/owner/repo/pulls/7.diff": { stdout: diffFor(headB) },
  [`repos/owner/repo/compare/${base}...${headA}`]: { stdout: diffFor(headA) },
  [`repos/owner/repo/compare/${base}...${headB}`]: { stdout: diffFor(headB) },
};

test("getPullRequest ties the diff to the recorded head when a push lands between calls", async () => {
  const gh = await makeFakeGh();
  try {
    await gh.respond(pushedBetweenCalls);
    const remote = await new GithubCliAdapter().getPullRequest("owner/repo", 7);
    assert.equal(remote.pr.headSha, headA);
    assert.equal(remote.pr.baseSha, base);
    assert.equal(remote.diff, diffFor(headA));
    assert.equal(remote.diffTruncated, false);
    assert.ok(
      (await gh.calls()).every((args) => !args[1].endsWith(".diff")),
      "the mutable pull request diff endpoint must not be used",
    );
  } finally {
    await gh.cleanup();
  }
});

test("getPullRequest fails closed when the recorded revisions cannot be fetched", async () => {
  const gh = await makeFakeGh();
  try {
    await gh.respond({
      "repos/owner/repo/pulls/7": { stdout: pull(headA) },
      "repos/owner/repo/pulls/7.diff": { stdout: diffFor(headB) },
    });
    await assert.rejects(
      () => new GithubCliAdapter().getPullRequest("owner/repo", 7),
      (error: unknown) =>
        error instanceof GithubRequestError &&
        error.httpStatus === 404 &&
        /compare\/.*HTTP 404/.test(error.message),
    );
  } finally {
    await gh.cleanup();
  }
});

test("failed imported PR detail refresh preserves cached data and provenance", async () => {
  const gh = await makeFakeGh();
  const { service, cleanup } = await makeService();
  const id = prId("owner/repo", 9);
  const detailPath = "repos/owner/repo/pulls/9";
  try {
    await gh.respond({
      user: { stdout: userJson },
      [requestPaths.teams]: teams([team(coreTeam.id, coreTeam.slug, "owner")]),
      "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
        stdout: "[]",
      },
      [detailPath]: { stdout: pullFor(9, headA) },
      [`repos/owner/repo/compare/${base}...${headA}`]: {
        stdout: diffFor(headA),
      },
      "repos/owner/repo/pulls/9/requested_reviewers": requestedReviewers([]),
    });
    await service.importPullRequest("https://github.com/owner/repo/pull/9");
    await service.manualReview(id);
    await waitFor(() => service.getDetail(id).runs[0]?.status === "completed");
    const before = service.getDetail(id);
    assert.equal(before.pr.imported, true);
    assert.equal(before.diff, diffFor(headA));
    assert.equal(before.runs.length, 1);
    assert.equal(before.drafts.length, 1);
    const snapshot = service.db.getRunSnapshot(before.runs[0].id);

    await gh.respond({
      user: { stdout: userJson },
      [requestPaths.teams]: teams([team(coreTeam.id, coreTeam.slug, "owner")]),
      "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
        stdout: "[]",
      },
      [detailPath]: {
        stderr: "gh: unavailable (HTTP 503)",
        code: 1,
      },
      "repos/owner/repo/pulls/9/requested_reviewers": requestedReviewers([]),
    });
    await assert.rejects(
      () => service.sync(),
      (error: unknown) =>
        error instanceof GithubRequestError && error.httpStatus === 503,
    );
    const after = service.getDetail(id);
    assert.equal(after.pr.imported, true);
    assert.equal(after.pr.requested, false);
    assert.equal(after.diff, diffFor(headA));
    assert.equal(after.runs.length, 1);
    assert.equal(after.drafts.length, 1);
    assert.equal(service.db.listJobs().length, 1);
    assert.deepEqual(service.db.getRunSnapshot(after.runs[0].id), snapshot);
    assert.match(service.getState().health.pollError ?? "", /HTTP 503/);
  } finally {
    await cleanup();
    await gh.cleanup();
  }
});

test("oversized machine-readable gh output fails before JSON parsing", async () => {
  const gh = await makeFakeGh();
  try {
    const oversized = pullFor(7, headA, "x".repeat(2_100_000));
    await gh.respond({ "repos/owner/repo/pulls/7": { stdout: oversized } });
    await assert.rejects(
      () => new GithubCliAdapter().getPullRequest("owner/repo", 7),
      (error: unknown) =>
        error instanceof GithubRequestError &&
        /output overflow: exceeded/.test(error.message) &&
        !/invalid JSON/.test(error.message),
    );
  } finally {
    await gh.cleanup();
  }
});

class FakeReviewer implements ReviewerAdapter {
  inputs: ReviewerInput[] = [];
  async health() {
    return { status: "ready" as const, message: "fake" };
  }
  async run(input: ReviewerInput) {
    this.inputs.push(input);
    return {
      result: {
        overview: "",
        body: `Review of ${input.pr.headSha}`,
        findings: [],
        verdict: "COMMENT" as const,
        rationale: "fixture",
      },
      log: "fake reviewer",
    };
  }
}

const reviewerSettings: ReviewerSettings = {
  skillPath: "/tmp/skill/SKILL.md",
  model: null,
  additionalInstructions: "",
};

async function makeService() {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-gh-service-"));
  const reviewer = new FakeReviewer();
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
    new GithubCliAdapter(),
    reviewer,
  );
  await saveFixtureExecution(service);
  service.db.updateSettings({ repository: "owner/repo" });
  return {
    service,
    reviewer,
    config,
    cleanup: async (current = service) => {
      await current.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting");
}

test("manual review snapshots only a matched head, base and diff, and queues nothing on failure", async () => {
  const gh = await makeFakeGh();
  const { service, reviewer, cleanup } = await makeService();
  try {
    await gh.respond(pushedBetweenCalls);
    const id = prId("owner/repo", 7);
    await service.importPullRequest("https://github.com/owner/repo/pull/7");
    await service.manualReview(id);
    await waitFor(() => reviewer.inputs.length === 1);
    const detail = service.getDetail(id);
    assert.equal(detail.runs[0].headSha, headA);
    assert.equal(detail.runs[0].baseSha, base);
    assert.equal(reviewer.inputs[0].pr.headSha, headA);
    assert.equal(reviewer.inputs[0].diff, diffFor(headA));
    assert.equal(detail.diff, diffFor(headA));

    await gh.respond({
      "repos/owner/repo/pulls/7": { stdout: pull(headB) },
      "repos/owner/repo/pulls/7.diff": { stdout: diffFor(headB) },
    });
    await assert.rejects(
      () => service.manualReview(id),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "refresh_failed",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(service.getDetail(id).runs.length, 1);
    assert.equal(service.db.listJobs().length, 1);
    assert.equal(service.getDetail(id).pr.headSha, headA);
    assert.equal(service.getDetail(id).diff, diffFor(headA));
  } finally {
    await cleanup();
    await gh.cleanup();
  }
});

const userJson = JSON.stringify({ login: "Reviewer", id: 1 });
const team = (id: number, slug: string, org: string) => ({
  id,
  slug,
  name: slug,
  organization: { login: org },
});
const teams = (rows: unknown[]) => ({ stdout: JSON.stringify(rows) });
const requestedReviewers = (
  users: string[],
  teamRows: Array<{ id: number; slug: string }> = [],
) => ({
  stdout: JSON.stringify({
    users: users.map((login) => ({ login })),
    teams: teamRows,
  }),
});
const event = (
  id: number,
  createdAt: string,
  target: { login?: string; team?: { id: number; slug: string } },
  event = "review_requested",
) => ({
  id,
  event,
  created_at: createdAt,
  ...(target.login ? { requested_reviewer: { login: target.login } } : {}),
  ...(target.team ? { requested_team: target.team } : {}),
});
const events = (rows: unknown[]) => ({ stdout: JSON.stringify(rows) });

const coreTeam = { id: 14880277, slug: "core-service-team" };
const otherOrgTeam = { id: 99, slug: "core-service-team" };
const pollFixture: Responses = {
  user: { stdout: userJson },
  "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
    stdout: `[${pull(headA)}]`,
  },
  "repos/owner/repo/pulls/7": { stdout: pull(headA) },
  [`repos/owner/repo/compare/${base}...${headA}`]: { stdout: diffFor(headA) },
  "user/teams?per_page=100&page=1": teams([
    team(coreTeam.id, coreTeam.slug, "owner"),
    team(otherOrgTeam.id, otherOrgTeam.slug, "elsewhere"),
  ]),
};

async function pollOnce(
  gh: Awaited<ReturnType<typeof makeFakeGh>>,
  responses: Responses,
  known: PullRequest[] = [],
) {
  await gh.respond({ ...pollFixture, ...responses });
  const result = await new GithubCliAdapter().poll("owner/repo", known);
  return {
    pr: result.pullRequests[0]?.pr,
    pullRequests: result.pullRequests,
    requests: result.requests,
    calls: await gh.calls(),
  };
}

test("poll recognizes a request addressed to a team the user belongs to", async () => {
  const gh = await makeFakeGh();
  try {
    const { pr, requests } = await pollOnce(gh, {
      "repos/owner/repo/pulls/7/requested_reviewers": requestedReviewers(
        [],
        [coreTeam],
      ),
      "repos/owner/repo/issues/7/events?per_page=100&page=1": events([
        event(31699307385, "2026-09-23T18:21:48Z", { team: coreTeam }),
      ]),
    });
    assert.equal(pr.requested, true);
    assert.equal(pr.requestedAt, "2026-09-23T18:21:48Z");
    assert.equal(pr.requestSource, "team");
    assert.equal(pr.createdAt, "2025-12-31T00:00:00.000Z");
    assert.deepEqual(requests, [
      {
        eventId: "31699307385",
        prId: prId("owner/repo", 7),
        headSha: headA,
        requestedAt: "2026-09-23T18:21:48Z",
      },
    ]);
  } finally {
    await gh.cleanup();
  }
});

const requestPaths = {
  reviewers: "repos/owner/repo/pulls/7/requested_reviewers",
  events: "repos/owner/repo/issues/7/events?per_page=100&page=1",
  events2: "repos/owner/repo/issues/7/events?per_page=100&page=2",
  teams: "user/teams?per_page=100&page=1",
  teams2: "user/teams?per_page=100&page=2",
};

test("failed requested PR diff refresh preserves cached data and reports the poll error", async () => {
  const gh = await makeFakeGh();
  const { service, cleanup } = await makeService();
  const id = prId("owner/repo", 7);
  try {
    await gh.respond({
      ...pollFixture,
      [requestPaths.reviewers]: requestedReviewers(["reviewer"]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { login: "reviewer" }),
      ]),
    });
    await service.sync();
    await service.manualReview(id);
    await waitFor(() => service.getDetail(id).runs[0]?.status === "completed");
    const before = service.getDetail(id);
    assert.equal(before.diff, diffFor(headA));
    assert.equal(before.runs.length, 1);
    assert.equal(before.drafts.length, 1);
    const snapshot = service.db.getRunSnapshot(before.runs[0].id);

    await gh.respond({
      ...pollFixture,
      [requestPaths.reviewers]: requestedReviewers(["reviewer"]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { login: "reviewer" }),
      ]),
      [`repos/owner/repo/compare/${base}...${headA}`]: {
        stderr: "gh: unavailable (HTTP 503)",
        code: 1,
      },
    });
    await assert.rejects(
      () => service.sync(),
      (error: unknown) =>
        error instanceof GithubRequestError && error.httpStatus === 503,
    );
    const after = service.getDetail(id);
    assert.equal(after.diff, diffFor(headA));
    assert.equal(after.pr.requested, true);
    assert.equal(after.runs.length, 1);
    assert.equal(after.drafts.length, 1);
    assert.equal(service.db.listJobs().length, 1);
    assert.deepEqual(service.db.getRunSnapshot(after.runs[0].id), snapshot);
    assert.match(service.getState().health.pollError ?? "", /HTTP 503/);
  } finally {
    await cleanup();
    await gh.cleanup();
  }
});

const oversizedPagedResponses = (): Responses => {
  const responses: Responses = {
    user: { stdout: userJson },
    "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
      stdout: JSON.stringify(
        Array.from({ length: 100 }, (_, index) =>
          JSON.parse(
            pullFor(
              index + 1,
              headA,
              index === 0 ? "x".repeat(2_100_000) : "Fixture",
            ),
          ),
        ),
      ),
    },
    "repos/owner/repo/pulls?state=open&per_page=100&page=2": {
      stdout: JSON.stringify([JSON.parse(pullFor(101, headA))]),
    },
    [`repos/owner/repo/compare/${base}...${headA}`]: {
      stdout: diffFor(headA),
    },
    "user/teams?per_page=100&page=1": teams([
      team(coreTeam.id, coreTeam.slug, "owner"),
    ]),
  };
  for (let number = 1; number <= 101; number += 1) {
    responses[`repos/owner/repo/pulls/${number}`] = {
      stdout: pullFor(number, headA),
    };
    responses[`repos/owner/repo/pulls/${number}/requested_reviewers`] =
      requestedReviewers(
        number === 7 ? ["Reviewer"] : [],
        number === 8 ? [coreTeam] : [],
      );
  }
  responses["repos/owner/repo/issues/7/events?per_page=100&page=1"] = events([
    event(7, "2026-01-01T00:00:00Z", { login: "Reviewer" }),
  ]);
  responses["repos/owner/repo/issues/8/events?per_page=100&page=1"] = events([
    event(8, "2026-01-02T00:00:00Z", { team: coreTeam }),
  ]);
  return responses;
};

test("compact oversized pull lists preserve pages and track only direct and team requests through HTTP sync", async () => {
  const gh = await makeFakeGh();
  const { service, config, cleanup } = await makeService();
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await gh.respond(oversizedPagedResponses());
    const response = await fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    const state = (await response.json()) as AppState;
    assert.equal(state.health.pollError, null);
    assert.deepEqual(
      state.prs
        .map((pr) => [pr.number, pr.requested, pr.requestedAt])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [7, true, "2026-01-01T00:00:00Z"],
        [8, true, "2026-01-02T00:00:00Z"],
      ],
    );
    assert.equal(service.db.listPrs().length, 2);
    const calls = await gh.calls();
    const listCalls = calls.filter((args) =>
      args[1].startsWith("repos/owner/repo/pulls?state=open"),
    );
    assert.deepEqual(
      listCalls.map((args) => args[1]),
      [
        "repos/owner/repo/pulls?state=open&per_page=100&page=1",
        "repos/owner/repo/pulls?state=open&per_page=100&page=2",
      ],
    );
    assert.ok(
      listCalls.every((args) =>
        args[args.indexOf("--jq") + 1].startsWith("[.[] | {number, users:"),
      ),
    );
    assert.deepEqual(
      calls
        .filter((args) => /^repos\/owner\/repo\/pulls\/\d+$/.test(args[1]))
        .map((args) => args[1]),
      ["repos/owner/repo/pulls/7", "repos/owner/repo/pulls/8"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await gh.cleanup();
  }
});

test("poll keeps direct requests and picks the latest of overlapping direct and team events", async () => {
  const gh = await makeFakeGh();
  try {
    const direct = await pollOnce(gh, {
      [requestPaths.reviewers]: requestedReviewers(["reviewer"]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { login: "Reviewer" }),
      ]),
    });
    assert.equal(direct.pr!.requested, true);
    assert.equal(direct.pr!.requestSource, "direct");
    assert.equal(direct.requests[0].eventId, "1");

    const overlap = await pollOnce(gh, {
      [requestPaths.reviewers]: requestedReviewers(["reviewer"], [coreTeam]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { login: "reviewer" }),
        event(2, "2026-01-02T00:00:00Z", { team: coreTeam }),
      ]),
    });
    assert.equal(overlap.pr!.requested, true);
    assert.equal(overlap.pr!.requestSource, "both");
    assert.equal(overlap.pr!.requestedAt, "2026-01-02T00:00:00Z");
    assert.equal(overlap.requests.length, 1);
    assert.equal(overlap.requests[0].eventId, "2");
  } finally {
    await gh.cleanup();
  }
});

test("poll ignores teams the user is not in, same-slug teams elsewhere, and removed requests", async () => {
  const gh = await makeFakeGh();
  try {
    const nonMember = await pollOnce(gh, {
      [requestPaths.reviewers]: requestedReviewers(
        [],
        [{ id: 555, slug: "dao-team" }, otherOrgTeam],
      ),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", {
          team: { id: 555, slug: "dao-team" },
        }),
        event(2, "2026-01-02T00:00:00Z", { team: otherOrgTeam }),
      ]),
    });
    assert.deepEqual(nonMember.pullRequests, []);
    assert.deepEqual(nonMember.requests, []);
    assert.ok(
      !nonMember.calls.some(
        (args) =>
          args[1].startsWith("repos/owner/repo/issues") ||
          args[1].startsWith("repos/owner/repo/pulls/"),
      ),
      "a pull request requested only of other teams is never fetched",
    );

    const previouslyRequested = await pollOnce(gh, {
      [requestPaths.reviewers]: requestedReviewers([], [coreTeam]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { team: coreTeam }),
      ]),
    });
    const fulfilled = await pollOnce(
      gh,
      {
        [requestPaths.reviewers]: requestedReviewers([]),
        [requestPaths.events]: events([
          event(1, "2026-01-01T00:00:00Z", { team: coreTeam }),
          event(
            2,
            "2026-01-02T00:00:00Z",
            { team: coreTeam },
            "review_request_removed",
          ),
        ]),
      },
      [previouslyRequested.pr!],
    );
    assert.equal(fulfilled.pr!.requested, false);
    assert.equal(fulfilled.pr!.requestSource, null);
    assert.deepEqual(fulfilled.requests, []);
  } finally {
    await gh.cleanup();
  }
});

test("poll surfaces a same-SHA team re-request as a new event id", async () => {
  const gh = await makeFakeGh();
  try {
    const first = await pollOnce(gh, {
      [requestPaths.reviewers]: requestedReviewers([], [coreTeam]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { team: coreTeam }),
      ]),
    });
    const second = await pollOnce(gh, {
      [requestPaths.reviewers]: requestedReviewers([], [coreTeam]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { team: coreTeam }),
        event(
          2,
          "2026-01-02T00:00:00Z",
          { team: coreTeam },
          "review_request_removed",
        ),
        event(3, "2026-01-03T00:00:00Z", { team: coreTeam }),
      ]),
    });
    assert.equal(first.requests[0].eventId, "1");
    assert.equal(second.requests[0].eventId, "3");
    assert.equal(second.pr!.headSha, first.pr!.headSha);
    assert.equal(second.pr!.requestedAt, "2026-01-03T00:00:00Z");
  } finally {
    await gh.cleanup();
  }
});

test("poll paginates team membership and timeline events and reads membership once per poll", async () => {
  const gh = await makeFakeGh();
  try {
    const fillerTeams = Array.from({ length: 100 }, (_, i) =>
      team(1000 + i, `filler-${i}`, "owner"),
    );
    const fillerEvents = Array.from({ length: 100 }, (_, i) =>
      event(100 + i, "2025-01-01T00:00:00Z", { login: "someone-else" }),
    );
    const { pr, requests, calls } = await pollOnce(gh, {
      "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
        stdout: `[${pull(headA)}, ${pull(headA).replace('"number":7', '"number":8')}]`,
      },
      "repos/owner/repo/pulls/8": {
        stdout: pull(headA).replace('"number":7', '"number":8'),
      },
      [requestPaths.teams]: teams(fillerTeams),
      [requestPaths.teams2]: teams([team(coreTeam.id, coreTeam.slug, "owner")]),
      [requestPaths.reviewers]: requestedReviewers([], [coreTeam]),
      "repos/owner/repo/pulls/8/requested_reviewers": requestedReviewers(
        [],
        [coreTeam],
      ),
      [requestPaths.events]: events(fillerEvents),
      [requestPaths.events2]: events([
        event(7, "2026-01-01T00:00:00Z", { team: coreTeam }),
      ]),
      "repos/owner/repo/issues/8/events?per_page=100&page=1": events([
        event(8, "2026-01-01T00:00:00Z", { team: coreTeam }),
      ]),
    });
    assert.equal(pr.requested, true);
    assert.deepEqual(
      requests.map((request) => request.eventId),
      ["7", "8"],
    );
    assert.equal(
      calls.filter((args) => args[1].startsWith("user/teams")).length,
      2,
    );
  } finally {
    await gh.cleanup();
  }
});

test("poll fails instead of dropping team requests when membership cannot be read", async () => {
  const gh = await makeFakeGh();
  try {
    await gh.respond({
      ...pollFixture,
      [requestPaths.teams]: {
        stderr: "gh: Resource not accessible by integration (HTTP 403)",
        code: 1,
      },
      [requestPaths.reviewers]: requestedReviewers([], [coreTeam]),
    });
    await assert.rejects(
      () => new GithubCliAdapter().poll("owner/repo", []),
      (error: unknown) =>
        error instanceof GithubRequestError &&
        error.httpStatus === 403 &&
        /read:org/.test(error.message),
    );
  } finally {
    await gh.cleanup();
  }
});

const teamRequested = (eventId: number, at: string): Responses => ({
  ...pollFixture,
  [requestPaths.reviewers]: requestedReviewers([], [coreTeam]),
  [requestPaths.events]: events([event(eventId, at, { team: coreTeam })]),
});

test("manual sync while automation is off discovers a team request in the inbox without reviewing", async () => {
  const gh = await makeFakeGh();
  const { service, reviewer, config, cleanup } = await makeService();
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await gh.respond(teamRequested(1, "2026-09-23T18:21:48Z"));
    const sync = await fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(sync.status, 200);
    const state = (await sync.json()) as AppState;
    assert.deepEqual(state.settings.automation, automationOff);
    assert.equal(state.prs.length, 1);
    assert.equal(state.prs[0].requested, true);
    assert.equal(state.prs[0].requestedAt, "2026-09-23T18:21:48Z");
    assert.equal(state.prs[0].status, "unreviewed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reviewer.inputs.length, 0);
    assert.equal(service.db.listJobs().length, 0);
    assert.equal(service.db.hasRequestEvent("1"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await gh.cleanup();
  }
});

test("team request automation baselines, reviews a same-SHA re-request once, and survives restart", async () => {
  const gh = await makeFakeGh();
  const { service, reviewer, config, cleanup } = await makeService();
  let current = service;
  const id = prId("owner/repo", 7);
  try {
    await gh.respond(teamRequested(1, "2026-01-01T00:00:00Z"));
    service.updateSettings({
      automation: {
        ...automationOff,
        pollRequests: true,
        reviewRequests: true,
      },
    });
    await service.sync();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(service.getDetail(id).runs.length, 0);
    assert.equal(service.getDetail(id).pr.requested, true);

    await gh.respond({
      ...teamRequested(1, "2026-01-01T00:00:00Z"),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { team: coreTeam }),
        event(
          2,
          "2026-01-02T00:00:00Z",
          { team: coreTeam },
          "review_request_removed",
        ),
        event(3, "2026-01-03T00:00:00Z", { team: coreTeam }),
      ]),
    });
    await service.sync("scheduled");
    await waitFor(() => service.getDetail(id).runs[0]?.status === "completed");
    assert.equal(service.getDetail(id).pr.requestedAt, "2026-01-03T00:00:00Z");
    assert.equal(service.getDetail(id).pr.requestSource, "team");
    assert.equal(service.db.listJobs().length, 1);
    assert.equal(service.getDetail(id).runs.length, 1);
    assert.equal(service.getDetail(id).runs[0].trigger, "request");
    assert.equal(service.getDetail(id).runs[0].requestEventId, "3");
    assert.equal(service.getDetail(id).runs[0].headSha, headA);
    await service.close();

    current = await ReviewService.create(
      config,
      new GithubCliAdapter(),
      reviewer,
    );
    await current.sync("scheduled");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(current.getDetail(id).runs.length, 1);
    assert.equal(reviewer.inputs.length, 1);

    await gh.respond({
      ...teamRequested(1, "2026-01-01T00:00:00Z"),
      [requestPaths.reviewers]: requestedReviewers([]),
    });
    await current.sync("scheduled");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(current.getDetail(id).pr.requested, false);
    assert.equal(current.getDetail(id).pr.requestSource, null);
    assert.equal(current.getDetail(id).runs.length, 1);
  } finally {
    await cleanup(current);
    await gh.cleanup();
  }
});

test("request provenance survives commit-only polls and manual refreshes, and clears when the PR closes", async () => {
  const gh = await makeFakeGh();
  const { service, cleanup } = await makeService();
  const id = prId("owner/repo", 7);
  try {
    await gh.respond({
      ...pollFixture,
      [requestPaths.reviewers]: requestedReviewers(["reviewer"], [coreTeam]),
      [requestPaths.events]: events([
        event(1, "2026-01-01T00:00:00Z", { login: "reviewer" }),
      ]),
    });
    await service.sync();
    assert.equal(service.getDetail(id).pr.requestSource, "both");
    assert.equal(
      service.getDetail(id).pr.createdAt,
      "2025-12-31T00:00:00.000Z",
    );

    await gh.respond({
      ...pollFixture,
      "repos/owner/repo/pulls/7": { stdout: pull(headB) },
      [`repos/owner/repo/compare/${base}...${headB}`]: {
        stdout: diffFor(headB),
      },
      [requestPaths.reviewers]: requestedReviewers([]),
    });
    service.updateSettings({
      automation: { ...automationOff, pollCommits: true },
    });
    await service.sync("scheduled");
    const polled = service.getDetail(id).pr;
    assert.equal(polled.headSha, headB);
    assert.equal(polled.requested, true);
    assert.equal(polled.requestSource, "both");
    assert.equal(polled.requestedAt, "2026-01-01T00:00:00Z");
    assert.ok(
      !(await gh.calls()).some(
        (args) =>
          args[1].endsWith("/requested_reviewers") && args[1].includes(headB),
      ),
    );

    await service.checkFreshness(id);
    assert.equal(service.getDetail(id).pr.requestSource, "both");

    await gh.respond({
      ...pollFixture,
      "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
        stdout: "[]",
      },
      "repos/owner/repo/pulls/7": {
        stdout: pull(headB).replace('"state":"open"', '"state":"closed"'),
      },
      [`repos/owner/repo/compare/${base}...${headB}`]: {
        stdout: diffFor(headB),
      },
    });
    await service.sync();
    const closed = service.getDetail(id).pr;
    assert.equal(closed.state, "CLOSED");
    assert.equal(closed.requested, false);
    assert.equal(closed.requestSource, null);
    assert.equal(closed.requestedAt, null);
    assert.equal(closed.createdAt, "2025-12-31T00:00:00.000Z");
  } finally {
    await cleanup();
    await gh.cleanup();
  }
});

const pullRow = (
  number: number,
  head: string,
  over: Record<string, unknown> = {},
) => ({ ...JSON.parse(pullFor(number, head)), ...over });

const scopedRepositoryResponses = (): Responses => ({
  user: { stdout: userJson },
  "user/teams?per_page=100&page=1": teams([
    team(coreTeam.id, coreTeam.slug, "owner"),
  ]),
  "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
    stdout: JSON.stringify([
      pullRow(7, headA, { requested_reviewers: [{ login: "Reviewer" }] }),
      pullRow(8, headA, { requested_teams: [coreTeam] }),
      pullRow(9, headA, { body: "x".repeat(2_100_000) }),
      pullRow(10, headA, {
        requested_teams: [{ id: 555, slug: "dao-team" }, otherOrgTeam],
      }),
    ]),
  },
  "repos/owner/repo/pulls/7": { stdout: pullFor(7, headA) },
  "repos/owner/repo/pulls/8": { stdout: pullFor(8, headA) },
  "repos/owner/repo/pulls/9": { stdout: pullFor(9, headA) },
  "repos/owner/repo/pulls/10": { stdout: pullFor(10, headA) },
  "repos/owner/repo/pulls/11": {
    stdout: pullFor(11, headA).replace('"state":"open"', '"state":"closed"'),
  },
  [`repos/owner/repo/compare/${base}...${headA}`]: { stdout: diffFor(headA) },
  "repos/owner/repo/pulls/7/requested_reviewers": requestedReviewers([
    "Reviewer",
  ]),
  "repos/owner/repo/pulls/8/requested_reviewers": requestedReviewers(
    [],
    [coreTeam],
  ),
  "repos/owner/repo/pulls/9/requested_reviewers": requestedReviewers([]),
  "repos/owner/repo/pulls/10/requested_reviewers": requestedReviewers(
    [],
    [{ id: 555, slug: "dao-team" }, otherOrgTeam],
  ),
  "repos/owner/repo/issues/7/events?per_page=100&page=1": events([
    event(7, "2026-01-01T00:00:00Z", { login: "Reviewer" }),
  ]),
  "repos/owner/repo/issues/8/events?per_page=100&page=1": events([
    event(8, "2026-01-02T00:00:00Z", { team: coreTeam }),
  ]),
});

async function httpSync(port: number): Promise<AppState> {
  const response = await fetch(`http://127.0.0.1:${port}/api/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  return (await response.json()) as AppState;
}

test("sync tracks only open direct and own-team requests and never fetches unrelated pull requests", async () => {
  const gh = await makeFakeGh();
  const { service, reviewer, config, cleanup } = await makeService();
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await gh.respond(scopedRepositoryResponses());
    const state = await httpSync(port);
    assert.equal(state.health.pollError, null);
    assert.deepEqual(
      state.prs
        .map((pr) => [pr.number, pr.requestSource, pr.imported])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [7, "direct", false],
        [8, "team", false],
      ],
    );
    assert.equal(service.db.getPr(prId("owner/repo", 9)), null);
    assert.equal(service.db.getPr(prId("owner/repo", 10)), null);
    const calls = await gh.calls();
    assert.ok(
      !calls.some(
        (args) =>
          args[1].startsWith("repos/owner/repo/pulls/9") ||
          args[1].startsWith("repos/owner/repo/pulls/10") ||
          args[1].startsWith("repos/owner/repo/issues/9") ||
          args[1].startsWith("repos/owner/repo/issues/10"),
      ),
      "unrelated pull requests are neither fetched nor diffed",
    );
    assert.equal(
      calls.filter((args) => args[1].startsWith("user/teams")).length,
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reviewer.inputs.length, 0);
    assert.equal(service.db.listJobs().length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await gh.cleanup();
  }
});

const withoutRequests = (responses: Responses): Responses => ({
  ...responses,
  "repos/owner/repo/pulls?state=open&per_page=100&page=1": {
    stdout: JSON.stringify([
      pullRow(7, headA),
      pullRow(8, headA),
      pullRow(9, headA),
      pullRow(10, headA),
    ]),
  },
  "repos/owner/repo/pulls/7/requested_reviewers": requestedReviewers([]),
  "repos/owner/repo/pulls/8/requested_reviewers": requestedReviewers([]),
});

const inboxNumbers = (service: ReviewService) =>
  service
    .getState()
    .prs.map((pr) => pr.number)
    .sort((a, b) => a - b);

test("manual import records durable provenance that survives refreshes, request removal and restart, while closed pull requests are refused", async () => {
  const gh = await makeFakeGh();
  const { service, reviewer, config, cleanup } = await makeService();
  let current = service;
  const seven = prId("owner/repo", 7);
  const eight = prId("owner/repo", 8);
  const nine = prId("owner/repo", 9);
  const eleven = prId("owner/repo", 11);
  try {
    await gh.respond(scopedRepositoryResponses());
    await service.sync();
    assert.deepEqual(inboxNumbers(service), [7, 8]);

    const imported = await service.importPullRequest(
      "https://github.com/owner/repo/pull/9",
    );
    assert.equal(imported.pr.imported, true);
    assert.equal(imported.pr.requested, false);
    assert.deepEqual(inboxNumbers(service), [7, 8, 9]);

    const reimported = await service.importPullRequest(
      "https://github.com/owner/repo/pull/7",
    );
    assert.equal(reimported.pr.imported, true);
    assert.equal(reimported.pr.requested, true);
    assert.equal(reimported.pr.requestSource, "direct");

    await assert.rejects(
      () => service.importPullRequest("https://github.com/owner/repo/pull/11"),
      (error: unknown) =>
        error instanceof ServiceError &&
        error.status === 409 &&
        error.code === "pr_closed",
    );
    assert.equal(service.db.getPr(eleven), null);

    await service.sync();
    assert.deepEqual(inboxNumbers(service), [7, 8, 9]);
    assert.equal(service.getDetail(seven).pr.imported, true);
    assert.equal(service.getDetail(nine).pr.imported, true);

    await gh.respond(withoutRequests(scopedRepositoryResponses()));
    await service.sync();
    assert.deepEqual(inboxNumbers(service), [7, 9]);
    const removed = service.getDetail(eight).pr;
    assert.equal(removed.requested, false);
    assert.equal(removed.imported, false);
    assert.equal(removed.state, "OPEN");
    const kept = service.getDetail(seven).pr;
    assert.equal(kept.requested, false);
    assert.equal(kept.imported, true);

    await gh.respond({
      ...withoutRequests(scopedRepositoryResponses()),
      "repos/owner/repo/pulls/9": {
        stdout: pullFor(9, headA).replace('"state":"open"', '"state":"closed"'),
      },
    });
    await service.sync();
    assert.deepEqual(inboxNumbers(service), [7]);
    const closed = service.getDetail(nine).pr;
    assert.equal(closed.state, "CLOSED");
    assert.equal(closed.imported, true);
    await assert.rejects(
      () => service.importPullRequest("https://github.com/owner/repo/pull/9"),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "pr_closed",
    );
    assert.equal(service.getDetail(nine).pr.imported, true);
    await service.close();

    current = await ReviewService.create(
      config,
      new GithubCliAdapter(),
      reviewer,
    );
    assert.deepEqual(inboxNumbers(current), [7]);
    assert.equal(current.getDetail(seven).pr.imported, true);
    assert.equal(current.getDetail(nine).pr.imported, true);
    await current.sync();
    assert.deepEqual(inboxNumbers(current), [7]);
    assert.equal(
      (await gh.calls()).some(
        (args) => args[1] === "repos/owner/repo/pulls/10",
      ),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reviewer.inputs.length, 0);
    assert.equal(current.db.listJobs().length, 0);
  } finally {
    await cleanup(current);
    await gh.cleanup();
  }
});

test("legacy rows without import provenance keep their history, hide from the inbox, and are never auto-reviewed by migration", async () => {
  const gh = await makeFakeGh();
  const { service, reviewer, config, cleanup } = await makeService();
  let current = service;
  const seven = prId("owner/repo", 7);
  const eight = prId("owner/repo", 8);
  const nine = prId("owner/repo", 9);
  try {
    await gh.respond(scopedRepositoryResponses());
    await service.sync();
    await service.importPullRequest("https://github.com/owner/repo/pull/9");
    service.createManualDraft(nine);
    service.createManualDraft(eight);
    service.updateSettings({
      automation: {
        ...automationOff,
        pollRequests: true,
        reviewRequests: true,
      },
    });
    await service.close();

    const sqlite = new DatabaseSync(config.databasePath);
    sqlite.exec(`
      ALTER TABLE prs DROP COLUMN imported;
      UPDATE prs SET request_source = NULL WHERE number = 7;
      UPDATE prs SET requested = 0, requested_at = NULL, request_source = NULL WHERE number = 8;
    `);
    sqlite.close();

    current = await ReviewService.create(
      config,
      new GithubCliAdapter(),
      reviewer,
    );
    assert.deepEqual(inboxNumbers(current), [7]);
    assert.equal(current.getState().prs[0].requestSource, "unknown");
    assert.equal(current.getState().prs[0].imported, false);
    assert.equal(current.getDetail(nine).pr.imported, false);
    assert.equal(current.getDetail(nine).drafts.length, 1);
    assert.equal(current.getDetail(eight).drafts.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(current.db.listJobs().length, 0);

    await current.sync("scheduled");
    assert.equal(current.getDetail(seven).pr.requestSource, "direct");
    assert.deepEqual(inboxNumbers(current), [7, 8]);
    assert.equal(current.getDetail(eight).pr.requestSource, "team");

    const retracked = await current.importPullRequest(
      "https://github.com/owner/repo/pull/9",
    );
    assert.equal(retracked.pr.imported, true);
    assert.equal(retracked.drafts.length, 1);
    assert.deepEqual(inboxNumbers(current), [7, 8, 9]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reviewer.inputs.length, 0);
    assert.equal(current.db.listJobs().length, 0);
  } finally {
    await cleanup(current);
    await gh.cleanup();
  }
});

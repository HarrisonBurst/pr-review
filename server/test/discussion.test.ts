import assert from "node:assert/strict";
import { test } from "node:test";
import { DemoGithubAdapter } from "../adapters.js";
import {
  acquireDiscussion,
  acquireReviewInventory,
  githubPages,
} from "../discussion.js";
import {
  exactReview,
  type ReviewInventory,
  type SubmissionRecovery,
} from "../publication.js";
import type { ReviewPayload } from "../../shared/contracts.js";
import {
  inlineInventoryFixture,
  inlineInventoryRead,
} from "./fixtures/inline-inventory.js";
import { fixturePrId } from "./fixtures/auto-submission.js";

const comment = (id: number) => ({
  id,
  body: `SYNTHETIC comment ${id}`,
  html_url: `https://github.com/demo/repository/pull/42#issuecomment-${id}`,
  updated_at: "2026-01-01T00:00:00Z",
  user: { login: "participant", type: "User" },
});
const inline = (id: number) => ({
  id: `node-${id}`,
  databaseId: id,
  body: `SYNTHETIC inline ${id}`,
  url: `https://github.com/demo/repository/pull/42#discussion_r${id}`,
  updatedAt: "2026-01-01T00:00:00Z",
  author: { login: "participant", __typename: "User" },
  replyTo: id === 101 ? { databaseId: 100 } : null,
  pullRequestReview: { databaseId: 77 },
});
const pageInfo = (next = false) => ({
  hasNextPage: next,
  endCursor: next ? "synthetic-next" : null,
});
const pull = async () =>
  (await new DemoGithubAdapter().getPullRequest("demo/repository", 42)).pr;

test("actual acquisition consumes all conversation/review/nested-inline pages with source attribution", async () => {
  const pr = await pull();
  const calls: string[][] = [];
  const snapshot = await acquireDiscussion(async (args) => {
    calls.push(args);
    if (args[1]!.includes("issues"))
      return JSON.stringify(
        args[1]!.endsWith("page=1")
          ? Array.from({ length: 100 }, (_, i) => comment(i + 1))
          : [comment(101)],
      );
    if (args[1]!.includes("reviews"))
      return JSON.stringify([
        { ...comment(77), body: "SYNTHETIC review body" },
      ]);
    if (args.some((arg) => arg.startsWith("id=")))
      return JSON.stringify({
        data: {
          node: {
            id: "synthetic-thread",
            isResolved: true,
            isOutdated: false,
            comments: { nodes: [inline(101)], pageInfo: pageInfo() },
          },
        },
      });
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid: pr.headSha,
            reviewThreads: {
              nodes: [
                {
                  id: "synthetic-thread",
                  isResolved: true,
                  isOutdated: false,
                  comments: {
                    nodes: Array.from({ length: 100 }, (_, i) => inline(i + 1)),
                    pageInfo: pageInfo(true),
                  },
                },
              ],
              pageInfo: pageInfo(),
            },
          },
        },
      },
    });
  }, pr);
  assert.equal(snapshot.coverage.complete, true);
  assert.equal(snapshot.coverage.comments.pages, 2);
  assert.equal(snapshot.coverage.reviews.pages, 1);
  assert.equal(snapshot.coverage.threads.pages, 2);
  assert.equal(snapshot.sources.length, 203);
  const last = snapshot.sources.at(-1)!;
  assert.equal(last.kind, "inline_comment");
  assert.equal(last.replyToId, "100");
  assert.equal(last.reviewId, "77");
  assert.equal(last.resolved, true);
  assert.equal(last.outdated, false);
  assert.equal(last.provenance, "participant");
  assert.equal(calls.length, 5);
});

test("discussion completeness includes later review bodies and outer thread pages", async () => {
  const pr = await pull();
  let threadPages = 0;
  const snapshot = await acquireDiscussion(async (args) => {
    if (args[1]!.includes("issues")) return "[]";
    if (args[1]!.includes("reviews"))
      return JSON.stringify(
        args[1]!.endsWith("page=1")
          ? Array.from({ length: 100 }, (_, i) => comment(i + 1))
          : [{ ...comment(101), body: "SYNTHETIC later human request" }],
      );
    threadPages++;
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid: pr.headSha,
            reviewThreads: {
              nodes: [
                {
                  id: `synthetic-thread-${threadPages}`,
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: [inline(threadPages)],
                    pageInfo: pageInfo(),
                  },
                },
              ],
              pageInfo: pageInfo(threadPages === 1),
            },
          },
        },
      },
    });
  }, pr);
  assert.equal(snapshot.coverage.complete, true);
  assert.equal(snapshot.coverage.reviews.pages, 2);
  assert.equal(snapshot.coverage.threads.pages, 2);
  assert.equal(snapshot.sources.length, 103);
  assert.equal(snapshot.sources[100]!.body, "SYNTHETIC later human request");
  assert.equal(snapshot.sources.at(-1)!.threadId, "synthetic-thread-2");
});

for (const failure of ["graphql", "head", "cursor", "missingBody", "byteLimit"])
  test(`acquisition retains honest incomplete coverage on ${failure}`, async () => {
    const pr = await pull();
    const snapshot = await acquireDiscussion(async (args) => {
      if (args[1] !== "graphql") {
        if (args[1]!.includes("reviews")) return "[]";
        return JSON.stringify([
          {
            ...comment(1),
            body:
              failure === "missingBody"
                ? null
                : failure === "byteLimit"
                  ? "x".repeat(20001)
                  : "SYNTHETIC",
          },
        ]);
      }
      return JSON.stringify({
        ...(failure === "graphql"
          ? { errors: [{ message: "SYNTHETIC incomplete" }] }
          : {}),
        data: {
          repository: {
            pullRequest: {
              headRefOid: failure === "head" ? "changed" : pr.headSha,
              reviewThreads: {
                nodes: [],
                pageInfo:
                  failure === "cursor"
                    ? { hasNextPage: true, endCursor: null }
                    : pageInfo(),
              },
            },
          },
        },
      });
    }, pr);
    assert.equal(snapshot.coverage.complete, false);
    assert.ok(
      snapshot.coverage.comments.error || snapshot.coverage.threads.error,
    );
  });

test("pagination rejects duplicate identities, non-array pages and bounded overflow", async () => {
  await assert.rejects(
    githubPages(
      async () =>
        JSON.stringify(Array.from({ length: 100 }, (_, i) => comment(i))),
      "fixture",
    ),
    /duplicate/,
  );
  await assert.rejects(
    githubPages(async () => "{}", "fixture"),
    /invalid/,
  );
  let count = 0;
  await assert.rejects(
    githubPages(
      async () =>
        JSON.stringify(Array.from({ length: 100 }, () => comment(++count))),
      "fixture",
    ),
    /limit/,
  );
  assert.equal(count, 1100);
});

test("exact recovery inventory paginates inline comments and preserves event/anchors/body/writer", async () => {
  const pr = await pull();
  let inlinePages = 0;
  const inventory = await acquireReviewInventory(async (args) => {
    if (args[1] === "user") return JSON.stringify({ login: "demo-user" });
    if (args[1]!.includes("/comments?")) {
      inlinePages++;
      const rows =
        inlinePages === 1
          ? Array.from({ length: 100 }, (_, i) => i + 1)
          : [101];
      return JSON.stringify(
        rows.map((id) => ({
          id,
          pull_request_review_id: 77,
          path: "src/demo.ts",
          line: 2,
          side: "LEFT",
          start_line: 1,
          start_side: "LEFT",
          body: `SYNTHETIC exact inline ${id}\n`,
        })),
      );
    }
    return JSON.stringify([
      {
        id: 77,
        user: { login: "demo-user" },
        submitted_at: "2026-01-01T00:00:01Z",
        state: "CHANGES_REQUESTED",
        commit_id: pr.headSha,
        body: "SYNTHETIC exact body\n",
        html_url: pr.url,
      },
    ]);
  }, pr);
  assert.equal(inlinePages, 2);
  assert.equal(inventory.reviews[0]?.payload.event, "REQUEST_CHANGES");
  assert.equal(inventory.reviews[0]?.payload.comments.length, 101);
  assert.equal(inventory.reviews[0]?.payload.comments[0]?.start_side, "LEFT");
  assert.equal(inventory.reviews[0]?.payload.body, "SYNTHETIC exact body\n");
  assert.deepEqual(inventory.reviewIds, ["77"]);
});

test("manual approval with an existing same-head inline review uses exact modern anchors before writing", async () => {
  const f = await inlineInventoryFixture();
  try {
    const draft = f.service.getDetail(fixturePrId).draft!;
    const preview = await f.service.preview(
      fixturePrId,
      draft.id,
      draft.version,
    );
    assert.equal(preview.payload.event, "APPROVE");
    assert.equal(preview.payload.comments.length, 1);
    assert.equal(f.github.writes.length, 0);
    assert.equal(f.service.getDetail(fixturePrId).pr.status, "ready");
    await f.service.submit(fixturePrId, preview.id);
    const inventory = await f.github.reviewInventory();
    assert.deepEqual(inventory.reviewIds, ["77"]);
    assert.equal(inventory.reviews[0]!.payload.comments[0]!.line, 2);
    assert.equal(inventory.reviews[0]!.payload.comments[0]!.side, "RIGHT");
    assert.deepEqual(f.github.writes, [preview.payload]);
    assert.equal(f.service.getDetail(fixturePrId).pr.status, "submitted");
    assert.deepEqual(f.service.getDetail(fixturePrId).draft, draft);
    await f.service.submit(fixturePrId, preview.id);
    assert.equal(f.github.writes.length, 1);
  } finally {
    await f.close();
  }
});

test("outdated existing inline comments retain their original anchor without blocking publication", async () => {
  const f = await inlineInventoryFixture();
  try {
    const read = inlineInventoryRead(f.github.current.pr);
    f.github.reviewInventory = () =>
      acquireReviewInventory(async (args) => {
        const rows = JSON.parse(await read(args));
        if (args[1]!.includes("/comments?")) {
          rows[0].line = null;
          rows[0].original_line = 192;
          assert.equal(Object.hasOwn(rows[0], "original_side"), false);
        }
        return JSON.stringify(rows);
      }, f.github.current.pr);
    const draft = f.service.getDetail(fixturePrId).draft!;
    const preview = await f.service.preview(
      fixturePrId,
      draft.id,
      draft.version,
    );
    assert.equal(f.github.writes.length, 0);
    await f.service.submit(fixturePrId, preview.id);
    const inventory = await f.github.reviewInventory();
    assert.deepEqual(inventory.reviews[0]!.payload.comments[0], {
      path: "src/demo.ts",
      line: 192,
      side: "RIGHT",
      body: "SYNTHETIC earlier inline comment",
      outdated: true,
    });
    assert.equal(preview.payload.comments[0]!.line, 2);
    assert.equal(preview.payload.comments[0]!.side, "RIGHT");
    assert.deepEqual(f.github.writes, [preview.payload]);
    assert.equal(f.service.getDetail(fixturePrId).pr.status, "submitted");
    assert.deepEqual(f.service.getDetail(fixturePrId).draft, draft);
    await f.service.submit(fixturePrId, preview.id);
    assert.equal(f.github.writes.length, 1);
    const originalSide = await acquireReviewInventory(async (args) => {
      const rows = JSON.parse(await read(args));
      if (args[1]!.includes("/comments?"))
        Object.assign(rows[0], {
          line: null,
          original_line: 192,
          original_side: "LEFT",
        });
      return JSON.stringify(rows);
    }, f.github.current.pr);
    assert.equal(originalSide.reviews[0]!.payload.comments[0]!.side, "LEFT");
    for (const malformed of [
      { line: undefined },
      { line: "192" },
      { path: undefined },
      { body: undefined },
      { side: undefined },
      { original_line: undefined },
      { original_line: 0 },
      { original_line: "192" },
      { original_side: null },
      { original_side: "UNKNOWN" },
    ]) {
      await assert.rejects(
        acquireReviewInventory(async (args) => {
          const rows = JSON.parse(await read(args));
          if (args[1]!.includes("/comments?"))
            Object.assign(
              rows[0],
              { line: null, original_line: 192 },
              malformed,
            );
          return JSON.stringify(rows);
        }, f.github.current.pr),
        /Exact inline review placement unavailable/,
      );
    }
  } finally {
    await f.close();
  }
});

test("inventory groups modern comments by review without guessing missing anchors from legacy positions", async () => {
  const pr = await pull();
  const read = inlineInventoryRead(pr);
  const calls: string[] = [];
  const inventory = await acquireReviewInventory(async (args) => {
    calls.push(args[1]!);
    const rows = JSON.parse(await read(args));
    if (args[1] === "user") return JSON.stringify(rows);
    if (args[1]!.includes("/comments?"))
      return JSON.stringify([
        ...rows,
        {
          ...rows[0],
          id: 102,
          pull_request_review_id: 78,
          line: 1,
          side: "LEFT",
        },
      ]);
    return JSON.stringify([
      ...rows,
      { ...rows[0], id: 78, state: "COMMENTED" },
    ]);
  }, pr);
  assert.deepEqual(
    inventory.reviews.map((item) => item.commentIds),
    [["101"], ["102"]],
  );
  assert.equal(inventory.reviews[1]!.payload.comments[0]!.side, "LEFT");
  assert.equal(calls.filter((path) => path.includes("/comments?")).length, 1);
  assert.equal(
    calls.some((path) => path.includes("/reviews/")),
    false,
  );
  for (const field of [
    "line",
    "side",
    "start_side",
    "pull_request_review_id",
  ]) {
    await assert.rejects(
      acquireReviewInventory(async (args) => {
        const rows = JSON.parse(await read(args));
        if (args[1]!.includes("/comments?")) {
          rows[0].original_line = 2;
          if (field === "start_side") rows[0].start_line = 1;
          rows[0][field] = field === "line" ? undefined : null;
        }
        return JSON.stringify(rows);
      }, pr),
      /placement unavailable|attribution unavailable/,
    );
  }
});

test("reconciliation needs one new complete exact author/event/head/body/inline match", () => {
  const payload: ReviewPayload = {
    event: "COMMENT",
    body: "SYNTHETIC exact body",
    commit_id: "synthetic-head",
    comments: [
      {
        path: "src/demo.ts",
        line: 3,
        side: "RIGHT",
        start_line: 2,
        start_side: "RIGHT",
        body: "SYNTHETIC exact inline",
      },
    ],
  };
  const recovery: SubmissionRecovery = {
    writer: "demo-user",
    capturedAt: "2026-01-01T00:00:00Z",
    reviewIds: ["old", "pending"],
  };
  const inventory: ReviewInventory = {
    writer: "demo-user",
    reviewIds: ["new"],
    reviews: [
      {
        id: "new",
        author: "demo-user",
        submittedAt: "2026-01-01T00:00:01Z",
        url: null,
        payload,
        commentIds: ["inline"],
      },
    ],
  };
  assert.equal(exactReview(inventory, recovery, payload)?.id, "new");
  const mutations = [
    (value: ReviewInventory) => {
      value.writer = "different-account";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.author = "other-person";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.id = "old";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.id = "pending";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.submittedAt = "2025-12-31T00:00:00Z";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.payload.event = "APPROVE";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.payload.commit_id = "other-head";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.payload.body += " changed";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.payload.comments[0]!.side = "LEFT";
    },
    (value: ReviewInventory) => {
      value.reviews[0]!.payload.comments[0]!.body += " changed";
    },
    (value: ReviewInventory) => {
      value.reviews.push({ ...value.reviews[0]!, id: "second-match" });
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(inventory);
    mutate(value);
    assert.equal(exactReview(value, recovery, payload), null);
  }
});

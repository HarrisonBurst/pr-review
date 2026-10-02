import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscussionSnapshot } from "../../shared/contracts.js";
import {
  bindHumanReviewRequest,
  humanReviewExtension,
  reviewSchema,
  validateReviewResult,
} from "../review-output.js";
import { checkReviewOutput } from "../output-checker.js";
import { revision } from "../discussion.js";
import {
  fixtureSource,
  fixturePrId,
  publicationFixture,
} from "./fixtures/auto-submission.js";

test("same-pass found evidence and pinned context persist independently from the editable draft", async () => {
  const f = await publicationFixture();
  try {
    f.github.sources = [fixtureSource()];
    f.reviewer.run = async (input) => ({
      result: {
        ...f.reviewer.result,
        humanReviewRequest: {
          version: 1,
          contextVersion: input.discussion!.revision,
          evidence: input.discussion!.sources.map((source) => ({
            source: {
              kind: source.kind,
              id: source.id,
              version: source.version,
            },
            author: source.author,
            quote: source.body,
            url: source.url,
          })),
        },
      },
      log: "SYNTHETIC same-pass fixture",
    });
    await f.service.manualReview(fixturePrId);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const detail = f.service.getDetail(fixturePrId);
    const run = detail.runs[0]!;
    assert.equal(detail.pr.autoSubmission?.detection?.status, "found");
    assert.equal(detail.pr.autoSubmission?.evidence.length, 1);
    assert.equal(detail.pr.autoSubmission?.status, "human_review_requested");
    assert.equal(
      f.service.db.getRunDiscussion(run.id)?.revision,
      run.result?.humanReviewRequest?.contextVersion,
    );
    assert.equal("humanReviewRequest" in detail.draft!, false);
    const pinned = structuredClone(f.service.db.getRunDiscussion(run.id));
    const snapshot = f.service.db.getRunSnapshot(run.id);
    f.service.db.captureRunDiscussion(run.id, null);
    assert.deepEqual(f.service.db.getRunDiscussion(run.id), pinned);
    f.github.sources = [fixtureSource("SYNTHETIC changed conversation")];
    f.service.revise(fixturePrId, {
      draftId: detail.draft!.id,
      draftVersion: detail.draft!.version,
      instructions: "SYNTHETIC revise with the original capture",
    });
    const revisionJob = f.service.db.listJobs("queued")[0]!;
    assert.deepEqual(f.service.db.getRunDiscussion(revisionJob.run_id), pinned);
    await f.service.processJob(revisionJob);
    assert.deepEqual(f.service.db.getRunSnapshot(run.id), snapshot);
    assert.deepEqual(f.service.db.getRunDiscussion(revisionJob.run_id), pinned);
    await f.restart();
    assert.deepEqual(
      f.service.getDetail(fixturePrId).pr.autoSubmission?.evidence,
      detail.pr.autoSubmission?.evidence,
    );
    assert.deepEqual(f.service.db.getRunDiscussion(run.id), pinned);
    assert.deepEqual(f.service.db.getRunDiscussion(revisionJob.run_id), pinned);
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

const core = {
  overview: "SYNTHETIC",
  body: "SYNTHETIC",
  findings: [],
  verdict: "COMMENT",
  rationale: "SYNTHETIC",
};
const source = fixtureSource();
const discussion: DiscussionSnapshot = {
  prId: fixturePrId,
  headSha: "synthetic-head",
  fetchedAt: "2026-01-01T00:00:00Z",
  revision: revision("synthetic-context"),
  coverage: {
    complete: true,
    comments: { pages: 1, complete: true, error: null },
    reviews: { pages: 1, complete: true, error: null },
    threads: { pages: 1, complete: true, error: null },
  },
  sources: [source],
};
const found = () => ({
  version: 1,
  contextVersion: discussion.revision,
  evidence: [
    {
      source: { kind: source.kind, id: source.id, version: source.version },
      author: source.author,
      quote: source.body,
      url: source.url,
    },
  ],
});

test("1.1 requires nullable generation emission but ingests core-valid 1.0 and advisory-invalid extensions", () => {
  assert.ok(reviewSchema.required.includes("humanReviewRequest"));
  for (const observation of [found(), { ...found(), evidence: [] }, null]) {
    assert.deepEqual(
      validateReviewResult({ ...core, humanReviewRequest: observation })
        .humanReviewRequest,
      observation,
    );
    assert.equal(
      checkReviewOutput(
        JSON.stringify({ ...core, humanReviewRequest: observation }),
      ).status,
      "valid",
    );
  }
  for (const observation of [
    undefined,
    null,
    {},
    { ...found(), version: 2 },
    { ...found(), contextVersion: "wrong" },
    { ...found(), extra: true },
    { ...found(), evidence: [{ ...found().evidence[0], extra: true }] },
  ]) {
    assert.equal(
      validateReviewResult({ ...core, humanReviewRequest: observation })
        .humanReviewRequest,
      null,
    );
    const checked = checkReviewOutput(
      JSON.stringify({ ...core, humanReviewRequest: observation }),
    );
    assert.equal(checked.version, "1.1");
    assert.equal(checked.status, "valid");
    assert.deepEqual(checked.diagnostics, []);
    assert.equal(checked.extensionDiagnostics.length, 1);
  }
  assert.throws(
    () =>
      validateReviewResult({
        ...core,
        verdict: "forged",
        humanReviewRequest: null,
      }),
    /verdict/,
  );
  assert.equal(
    checkReviewOutput(JSON.stringify({ ...core, findings: null })).status,
    "invalid",
  );
});

test("field-only UTF-8, entry, exact-key and aggregate extension bounds stay advisory", () => {
  const entry = found().evidence[0]!;
  for (const observation of [
    { ...found(), evidence: Array(1001).fill(entry) },
    { ...found(), evidence: [entry, entry] },
    {
      ...found(),
      evidence: [
        { ...entry, source: { ...entry.source, id: "x".repeat(101) } },
      ],
    },
    {
      ...found(),
      evidence: [
        { ...entry, source: { ...entry.source, version: "A".repeat(64) } },
      ],
    },
    {
      ...found(),
      evidence: [{ ...entry, source: { ...entry.source, extra: true } }],
    },
    { ...found(), evidence: [{ ...entry, author: "x".repeat(101) }] },
    { ...found(), evidence: [{ ...entry, author: " " }] },
    { ...found(), evidence: [{ ...entry, quote: "é".repeat(10001) }] },
    { ...found(), evidence: [{ ...entry, quote: "" }] },
    { ...found(), evidence: [{ ...entry, url: "x".repeat(2049) }] },
    {
      ...found(),
      evidence: Array.from({ length: 11 }, (_, index) => ({
        ...entry,
        source: { ...entry.source, id: String(index) },
        quote: "x".repeat(19000),
      })),
    },
  ]) {
    assert.equal(humanReviewExtension(observation).observation, null);
    assert.equal(
      validateReviewResult({ ...core, humanReviewRequest: observation }).body,
      core.body,
    );
  }
  assert.ok(
    humanReviewExtension({
      ...found(),
      evidence: [{ ...entry, quote: "é".repeat(10000) }],
    }).observation,
  );
  assert.ok(
    humanReviewExtension({
      ...found(),
      evidence: Array.from({ length: 1000 }, (_, index) => ({
        ...entry,
        source: { ...entry.source, id: String(index) },
        quote: "x",
        url: "x",
      })),
    }).observation,
  );
});

test("deterministic binding refuses context/source/quote/author/kind/id/version/link/bot/app/unknown spoofs", () => {
  assert.deepEqual(
    bindHumanReviewRequest(found(), discussion).observation,
    found(),
  );
  const entry = found().evidence[0]!;
  for (const observation of [
    { ...found(), contextVersion: revision("other context") },
    ...["id", "kind", "version"].map((key) => ({
      ...found(),
      evidence: [
        {
          ...entry,
          source: {
            ...entry.source,
            [key]:
              key === "version"
                ? revision("other version")
                : key === "kind"
                  ? "review"
                  : "other-id",
          },
        },
      ],
    })),
    ...["author", "quote", "url"].map((key) => ({
      ...found(),
      evidence: [{ ...entry, [key]: "SYNTHETIC forged" }],
    })),
  ])
    assert.equal(
      bindHumanReviewRequest(observation, discussion).observation,
      null,
    );
  for (const changed of [
    { ...source, authorType: "Bot" as const },
    { ...source, authorType: "unknown" as const },
    { ...source, provenance: "bot" as const },
    { ...source, provenance: "app_automatic" as const },
    { ...source, provenance: "unknown" as const },
  ])
    assert.equal(
      bindHumanReviewRequest(found(), { ...discussion, sources: [changed] })
        .observation,
      null,
    );
  assert.equal(bindHumanReviewRequest(found(), null).observation, null);
  assert.ok(
    bindHumanReviewRequest(found(), {
      ...discussion,
      coverage: { ...discussion.coverage, complete: false },
    }).observation,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoSubmissionConfirmation,
  autoSubmissionReenableConfirmation,
  normalizeAutoSubmissionAuthors,
  normalizeGithubUsername,
  reviewVerdicts,
  type AutoSubmissionUpdate,
  type DraftEditIntent,
  type HumanReviewAcknowledgment,
  type HumanReviewClassifierOutput,
  type SubmissionAuthority,
} from "../../shared/contracts.js";

test("GitHub author logins are trimmed, case-insensitive and exact", () => {
  assert.equal(normalizeGithubUsername("  Fixture-Author  "), "fixture-author");
  assert.equal(normalizeGithubUsername("A"), "a");
  assert.equal(normalizeGithubUsername("a".repeat(39)), "a".repeat(39));
  assert.notEqual(
    normalizeGithubUsername("author"),
    normalizeGithubUsername("other-author"),
  );
  for (const value of [
    "",
    " ",
    "@author",
    "https://github.com/author",
    "-author",
    "author-",
    "a--b",
    "a_b",
    "a b",
    "åuthor",
    "a".repeat(40),
    null,
    42,
  ])
    assert.equal(normalizeGithubUsername(value), null);
});

test("an empty author table and newly added actionless rows grant nothing", () => {
  assert.deepEqual(normalizeAutoSubmissionAuthors([]), []);
  assert.deepEqual(
    normalizeAutoSubmissionAuthors([{ username: " New-Author ", actions: [] }]),
    [{ username: "new-author", actions: [] }],
  );
});

test("actual verdict permissions stay distinct and canonical without relabeling", () => {
  for (const action of reviewVerdicts)
    assert.deepEqual(
      normalizeAutoSubmissionAuthors([
        { username: "author", actions: [action] },
      ]),
      [{ username: "author", actions: [action] }],
    );
  assert.deepEqual(
    normalizeAutoSubmissionAuthors([
      {
        username: "second",
        actions: ["REQUEST_CHANGES", "COMMENT", "APPROVE"],
      },
      { username: "first", actions: [] },
    ]),
    [
      { username: "second", actions: [...reviewVerdicts] },
      { username: "first", actions: [] },
    ],
  );
});

test("duplicate normalized authors and malformed author policies reject as a whole", () => {
  for (const value of [
    [
      { username: "author", actions: [] },
      { username: " AUTHOR ", actions: ["APPROVE"] },
    ],
    [{ username: "author", actions: ["COMMENT", "COMMENT"] }],
    [{ username: "author", actions: ["comment"] }],
    [{ username: "author", actions: ["MERGE"] }],
    [{ username: "author", actions: null }],
    [{ username: "author" }],
    [{ username: "@author", actions: [] }],
    [{ username: "author", actions: [], enabled: true }],
    [null],
    [[]],
    {},
    null,
    Array.from({ length: 101 }, (_, index) => ({
      username: `author-${index}`,
      actions: [],
    })),
  ])
    assert.equal(normalizeAutoSubmissionAuthors(value), null);
});

test("policy normalization keeps the caller's saved and unsaved rows unchanged", () => {
  const actions = Object.freeze(["APPROVE", "COMMENT"]);
  const rows = Object.freeze([
    Object.freeze({ username: " AUTHOR ", actions }),
  ]);
  assert.deepEqual(normalizeAutoSubmissionAuthors(rows), [
    { username: "author", actions: ["COMMENT", "APPROVE"] },
  ]);
  assert.deepEqual(rows, [
    { username: " AUTHOR ", actions: ["APPROVE", "COMMENT"] },
  ]);
});

test("contract examples pin independent future consent, edit intent and source versions", () => {
  const policy = {
    repository: "fixture/repository",
    expectedVersion: 0,
    enabled: true,
    authors: [{ username: "author", actions: ["COMMENT"] }],
    confirmation: autoSubmissionConfirmation,
  } satisfies AutoSubmissionUpdate;
  const intent = {
    draftId: "fixture-draft",
    version: 1,
  } satisfies DraftEditIntent;
  const source = {
    kind: "comment",
    id: "fixture-comment",
    version: "fixture-revision",
  } as const;
  const acknowledgment = {
    expectedVersion: 2,
    evidenceId: "fixture-evidence",
    source,
    action: "dismiss",
  } satisfies HumanReviewAcknowledgment;
  const classification = {
    version: 1,
    revision: "fixture-context",
    results: [
      {
        source,
        decision: "requested",
        quote: "Please ask a person to review",
        reason: "Direct participant request",
      },
    ],
  } satisfies HumanReviewClassifierOutput;
  const authority = {
    kind: "automatic",
    repository: policy.repository,
    policyVersion: 1,
    prGeneration: 0,
    runId: "fixture-run",
    draftId: intent.draftId,
    draftVersion: intent.version,
    headSha: "fixture-head",
    discussionRevision: classification.revision,
  } satisfies SubmissionAuthority;
  assert.equal(Object.hasOwn(policy, "automation"), false);
  assert.equal(authority.draftVersion, intent.version);
  assert.deepEqual(acknowledgment.source, classification.results[0].source);
  assert.notEqual(
    autoSubmissionConfirmation,
    autoSubmissionReenableConfirmation,
  );
});

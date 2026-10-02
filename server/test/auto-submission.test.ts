import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoSubmissionConfirmation,
  autoSubmissionReenableConfirmation,
  automationOff,
} from "../../shared/contracts.js";
import {
  fixturePrId as PR,
  fixtureSource,
  publicationFixture,
} from "./fixtures/auto-submission.js";

async function fixture(
  body: (
    value: Awaited<ReturnType<typeof publicationFixture>>,
  ) => Promise<void>,
) {
  const value = await publicationFixture();
  try {
    await body(value);
  } finally {
    await value.close();
  }
}

test("inert end-to-end automatic draft baseline never publishes without separate consent", () =>
  fixture(async (f) => {
    await f.automaticReview();
    assert.equal(f.service.getDetail(PR).draft?.version, 1);
    assert.equal(f.github.writes.length, 0);
    assert.equal(f.service.getState().settings.autoSubmission?.enabled, false);
  }));

test("a check-needed publication hold preserves automatic drafts and exact confirmed-submission settlement", () =>
  fixture(async (f) => {
    f.reviewer.result.verdict = "APPROVE";
    await f.service.manualReview(PR);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const initial = f.service.getDetail(PR).draft!;
    f.service.updateDraft(PR, {
      draftId: initial.id,
      version: initial.version,
      body: "SYNTHETIC retained manual edit",
      findings: initial.findings,
      verdict: "APPROVE",
    });
    const edited = f.service.getDetail(PR).draft!;
    await f.service.submit(
      PR,
      (await f.service.preview(PR, edited.id, edited.version)).id,
    );
    assert.equal(f.service.getDetail(PR).pr.status, "submitted");
    f.save(["APPROVE"]);
    f.classifier.fail = true;
    await f.service.checkAutoSubmission(PR);
    f.github.current.pr.headSha = "synthetic-new-head-after-approval";
    await f.automaticReview();
    const automatic = f.service.getDetail(PR);
    assert.equal(automatic.runs[0]?.trigger, "new_commits");
    assert.equal(automatic.runs[0]?.status, "completed");
    assert.equal(automatic.pr.autoSubmission?.check?.status, "check_needed");
    assert.equal(automatic.pr.status, "ready");
    assert.equal(
      automatic.drafts.find((draft) => draft.id === edited.id)?.body,
      edited.body,
    );
    assert.equal(f.github.writes.length, 1);
    const draft = automatic.draft!;
    const preview = await f.service.preview(PR, draft.id, draft.version);
    assert.equal(f.service.getDetail(PR).submissions.length, 1);
    await f.service.manualReview(PR);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const latest = f.service.getDetail(PR).draft!;
    assert.notEqual(latest.id, draft.id);
    await f.service.submit(PR, preview.id);
    assert.equal(f.service.getDetail(PR).pr.status, "ready");
    const currentPreview = await f.service.preview(
      PR,
      latest.id,
      latest.version,
    );
    await f.service.submit(PR, currentPreview.id);
    assert.equal(f.service.getDetail(PR).pr.status, "submitted");
    f.service.updateDraft(PR, {
      draftId: latest.id,
      version: latest.version,
      body: "SYNTHETIC edited after confirmed submission",
      findings: latest.findings,
      verdict: "APPROVE",
    });
    assert.equal(f.service.getDetail(PR).pr.status, "ready");
    const changed = f.service.getDetail(PR).draft!;
    const stale = await f.service.preview(PR, changed.id, changed.version);
    f.service.updateDraft(PR, {
      draftId: changed.id,
      version: changed.version,
      body: "SYNTHETIC later saved version",
      findings: changed.findings,
      verdict: "APPROVE",
    });
    await assert.rejects(
      f.service.submit(PR, stale.id),
      /preview does not match/,
    );
    await f.restart();
    assert.equal(f.service.getDetail(PR).pr.status, "ready");
    assert.equal(f.service.getDetail(PR).draft?.version, changed.version + 1);
    assert.equal(f.service.getDetail(PR).submissions.length, 3);
    assert.equal(f.github.writes.length, 3);
  }));

test("saved publication policy is independent, empty by default and explicit future-only consent", () =>
  fixture(async (f) => {
    assert.deepEqual(f.service.getState().settings.autoSubmission, {
      repository: "demo/repository",
      enabled: false,
      authors: [],
      version: 0,
      consentedAt: null,
    });
    assert.throws(
      () =>
        f.service.saveAutoSubmission({
          repository: "demo/repository",
          expectedVersion: 0,
          enabled: true,
          authors: [],
        }),
      /consent/,
    );
    f.save([]);
    assert.deepEqual(f.service.getState().settings.automation, automationOff);
    assert.equal(f.service.db.listJobs().length, 0);
    assert.equal(f.github.writes.length, 0);
    assert.deepEqual(f.service.getState().settings.autoSubmission?.authors, [
      { username: "demo-author", actions: [] },
    ]);
    assert.throws(
      () =>
        f.service.saveAutoSubmission({
          repository: "demo/repository",
          expectedVersion: 0,
          enabled: true,
          authors: [],
          confirmation: autoSubmissionConfirmation,
        }),
      /changed/,
    );
    assert.throws(
      () =>
        f.service.saveAutoSubmission({
          repository: "other/repository",
          expectedVersion: 1,
          enabled: false,
          authors: [],
        }),
      /Repository/,
    );
  }));

test("an untouched future automatic full review publishes its exact verdict/payload once", () =>
  fixture(async (f) => {
    f.save();
    await f.automaticReview();
    const detail = f.service.getDetail(PR);
    assert.equal(f.github.writes.length, 1);
    assert.deepEqual(f.github.writes[0], {
      event: "COMMENT",
      body: "SYNTHETIC review",
      comments: [],
      commit_id: f.github.current.pr.headSha,
    });
    assert.ok(detail.runs[0]?.autoSubmission);
    assert.equal(detail.submissions[0]?.authority?.kind, "automatic");
    assert.equal(detail.submissions[0]?.status, "submitted");
    assert.equal(
      JSON.stringify(f.github.writes).includes("private overview"),
      false,
    );
    await f.automaticReview();
    assert.equal(f.github.writes.length, 1);
    await f.restart();
    await f.automaticReview();
    assert.equal(f.github.writes.length, 1);
    f.github.current.pr.headSha = "synthetic-new-head";
    await f.automaticReview();
    assert.equal(f.github.writes.length, 2);
  }));

for (const verdict of ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const)
  test(`per-author ${verdict} permission preserves the actual verdict without relabeling`, () =>
    fixture(async (f) => {
      f.reviewer.result.verdict = verdict;
      f.save([verdict]);
      await f.automaticReview();
      assert.equal(f.github.writes[0]?.event, verdict);
    }));

test("different author/action and blocking COMMENT remain unauthorized", () =>
  fixture(async (f) => {
    f.save(["APPROVE"]);
    await f.automaticReview();
    assert.equal(f.github.writes.length, 0);
    f.save();
    f.github.current.pr.author = "other-demo-author";
    await f.automaticReview();
    assert.equal(f.github.writes.length, 0);
    f.github.current.pr.author = "demo-author";
    f.reviewer.result.findings = [
      {
        id: "blocking",
        severity: "blocking",
        path: "src/demo.ts",
        line: 2,
        startLine: null,
        side: "RIGHT",
        body: "SYNTHETIC blocking finding",
        evidence: "SYNTHETIC private evidence",
        origin: "introduced",
        included: false,
        questionId: null,
      },
    ];
    await f.automaticReview();
    assert.equal(f.github.writes.length, 0);
    assert.match(
      f.service.getDetail(PR).pr.autoSubmission!.message,
      /blocking/,
    );
  }));

test("manual/local/old drafts never gain authority when consent is saved", () =>
  fixture(async (f) => {
    await f.service.manualReview(PR);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const manual = f.service.getDetail(PR).draft!;
    f.save();
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.github.writes.length, 0);
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission?.status,
      "manual_only",
    );
    assert.equal(manual.autoSubmission?.provenance, null);
    f.service.createManualDraft(PR);
    f.save();
    await f.service.sync();
    assert.equal(f.github.writes.length, 0);
  }));

test("pre-consent automatic drafts and accepted AI revisions stay manual without changing immutable results", () =>
  fixture(async (f) => {
    await f.automaticReview();
    const initial = f.service.getDetail(PR);
    const draft = initial.draft!;
    const result = structuredClone(initial.runs[0]!.result);
    f.save();
    await f.service.checkAutoSubmission(PR);
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission?.status,
      "manual_only",
    );
    assert.equal(f.github.writes.length, 0);
    f.service.revise(PR, {
      draftId: draft.id,
      draftVersion: draft.version,
      instructions: "SYNTHETIC clarify this private draft",
    });
    f.reviewer.result.body = "SYNTHETIC revised review";
    const job = f.service.db.listJobs("queued")[0]!;
    await f.service.processJob(job);
    const proposal = f.service.getDetail(PR).proposals[0]!;
    f.service.applyProposal(PR, proposal.id, draft.version);
    const detail = f.service.getDetail(PR);
    assert.equal(detail.draft?.version, 2);
    assert.equal(detail.draft?.autoSubmission?.manualHold?.reason, "revision");
    assert.equal(
      detail.runs.find((run) => run.kind === "revision")?.autoSubmission,
      null,
    );
    assert.deepEqual(
      detail.runs.find((run) => run.id === draft.runId)?.result,
      result,
    );
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.github.writes.length, 0);
  }));

test("unsaved server edit intent during awaited publication blocks the write and persists", () =>
  fixture(async (f) => {
    f.save();
    f.github.beforeInventory = async () => {
      const draft = f.service.getDetail(PR).draft!;
      f.service.editIntent(PR, { draftId: draft.id, version: draft.version });
    };
    await f.automaticReview();
    const draft = f.service.getDetail(PR).draft!;
    assert.equal(f.github.writes.length, 0);
    assert.equal(draft.version, 1);
    assert.equal(draft.autoSubmission?.manualHold?.reason, "edit_intent");
    f.github.beforeInventory = undefined;
    await f.restart();
    assert.equal(
      f.service.getDetail(PR).draft?.autoSubmission?.manualHold?.reason,
      "edit_intent",
    );
    const preview = await f.service.preview(PR, draft.id, draft.version);
    await f.service.submit(PR, preview.id);
    assert.equal(f.github.writes.length, 1);
    assert.equal(
      f.service.getDetail(PR).submissions[0]?.authority?.kind,
      "manual",
    );
  }));

test("edit intent after automatic dispatch starts fails stale instead of enabling an editor", () =>
  fixture(async (f) => {
    f.save();
    f.github.beforeWrite = async () => {
      const draft = f.service.getDetail(PR).draft!;
      assert.throws(
        () =>
          f.service.editIntent(PR, {
            draftId: draft.id,
            version: draft.version,
          }),
        /publication is in flight or uncertain/,
      );
    };
    await f.automaticReview();
    assert.equal(f.github.writes.length, 1);
    assert.equal(
      f.service.getDetail(PR).draft?.autoSubmission?.manualHold,
      null,
    );
  }));

test("uncertain automatic dispatch cannot acknowledge editable authority until exact reconciliation confirms the write", () =>
  fixture(async (f) => {
    f.save();
    f.github.failWrite = true;
    await f.automaticReview();
    const draft = f.service.getDetail(PR).draft!;
    assert.throws(
      () =>
        f.service.editIntent(PR, { draftId: draft.id, version: draft.version }),
      /in flight or uncertain/,
    );
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).submissions[0]?.status, "submitted");
    f.service.editIntent(PR, { draftId: draft.id, version: draft.version });
    assert.equal(
      f.service.getDetail(PR).draft?.autoSubmission?.manualHold?.reason,
      "edit_intent",
    );
    assert.equal(f.github.writes.length, 1);
  }));

test("revocation or unchanged Save during awaited work invalidates captured future consent", () =>
  fixture(async (f) => {
    f.save();
    f.github.beforeInventory = async () => {
      f.save();
    };
    await f.automaticReview();
    assert.equal(f.github.writes.length, 0);
    f.github.beforeInventory = async () => {
      f.save([], false);
    };
    await f.automaticReview();
    assert.equal(f.github.writes.length, 0);
    assert.equal(f.service.getState().settings.autoSubmission?.enabled, false);
  }));

test("human requests arriving mid-review override consent but preserve private drafting", () =>
  fixture(async (f) => {
    f.save();
    f.reviewer.beforeResult = async () => {
      f.github.sources = [fixtureSource()];
      f.classifier.decisions.set("synthetic-comment", "requested");
    };
    await f.automaticReview();
    const detail = f.service.getDetail(PR);
    assert.equal(f.github.writes.length, 0);
    assert.ok(detail.draft);
    assert.equal(detail.runs[0]?.status, "completed");
    assert.equal(detail.pr.autoSubmission?.status, "human_review_requested");
    assert.equal(detail.pr.autoSubmission?.evidence[0]?.author, "demo-author");
    f.save([], false);
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission?.status,
      "human_review_requested",
    );
  }));

test("source holds survive deletion, new head and restart; acknowledgment and future re-enable are distinct", () =>
  fixture(async (f) => {
    f.save();
    f.github.sources = [fixtureSource()];
    f.classifier.decisions.set("synthetic-comment", "requested");
    await f.service.checkAutoSubmission(PR);
    await f.automaticReview();
    f.github.sources = [];
    f.github.current.pr.headSha = "synthetic-next-head";
    await f.service.checkAutoSubmission(PR);
    await f.restart();
    let state = f.service.getDetail(PR).pr.autoSubmission!;
    assert.equal(state.evidence.length, 1);
    assert.equal(state.reenableRequired, true);
    await assert.rejects(
      f.service.reenableAutoSubmission(PR, {
        expectedVersion: state.version,
        confirmation: autoSubmissionReenableConfirmation,
      }),
      /acknowledgment/,
    );
    const evidence = state.evidence[0]!;
    f.service.acknowledgeHumanReview(PR, {
      expectedVersion: state.version,
      evidenceId: evidence.id,
      source: evidence.source,
      action: "dismiss",
    });
    state = f.service.getDetail(PR).pr.autoSubmission!;
    assert.equal(state.reenableRequired, true);
    await f.service.reenableAutoSubmission(PR, {
      expectedVersion: state.version,
      confirmation: autoSubmissionReenableConfirmation,
    });
    assert.equal(f.github.writes.length, 0);
    await f.automaticReview();
    assert.equal(f.github.writes.length, 1);
  }));

test("identical acknowledged source versions do not retrigger across heads; changed contextual versions do", () =>
  fixture(async (f) => {
    f.github.sources = [fixtureSource()];
    f.classifier.decisions.set("synthetic-comment", "requested");
    await f.service.checkAutoSubmission(PR);
    let state = f.service.getDetail(PR).pr.autoSubmission!;
    const evidence = state.evidence[0]!;
    assert.throws(
      () =>
        f.service.acknowledgeHumanReview(PR, {
          expectedVersion: state.version,
          evidenceId: evidence.id,
          source: { ...evidence.source, version: "wrong" },
          action: "dismiss",
        }),
      /changed/,
    );
    f.service.acknowledgeHumanReview(PR, {
      expectedVersion: state.version,
      evidenceId: evidence.id,
      source: evidence.source,
      action: "resolve",
    });
    state = f.service.getDetail(PR).pr.autoSubmission!;
    await f.service.reenableAutoSubmission(PR, {
      expectedVersion: state.version,
      confirmation: autoSubmissionReenableConfirmation,
    });
    f.github.current.pr.headSha = "synthetic-new-head";
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).pr.autoSubmission?.evidence.length, 1);
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission?.reenableRequired,
      false,
    );
    f.github.current.pr.body = "SYNTHETIC changed contextual request";
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).pr.autoSubmission?.evidence.length, 2);
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission?.reenableRequired,
      true,
    );
  }));

for (const failure of ["incomplete", "unknown", "uncertain", "error"])
  test(`${failure} classification/coverage pauses honestly without fabricating human evidence`, () =>
    fixture(async (f) => {
      f.github.sources = [fixtureSource()];
      if (failure === "incomplete") f.github.complete = false;
      if (failure === "unknown") f.github.sources[0]!.authorType = "unknown";
      if (failure === "uncertain")
        f.classifier.decisions.set("synthetic-comment", "uncertain");
      if (failure === "error") f.classifier.fail = true;
      await f.service.checkAutoSubmission(PR);
      assert.equal(
        f.service.getDetail(PR).pr.autoSubmission?.status,
        "check_needed",
      );
      assert.equal(
        f.service.getDetail(PR).pr.autoSubmission?.evidence.length,
        0,
      );
      assert.equal(
        f.service.getDetail(PR).pr.autoSubmission?.reenableRequired,
        true,
      );
    }));

test("confirmed manual publication suppresses later automatic publication on that head", () =>
  fixture(async (f) => {
    await f.service.manualReview(PR);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const draft = f.service.getDetail(PR).draft!;
    await f.service.submit(
      PR,
      (await f.service.preview(PR, draft.id, draft.version)).id,
    );
    f.save();
    await f.automaticReview();
    assert.equal(f.github.writes.length, 1);
  }));

test("uncertain automatic writes persist, prohibit competing writes and reconcile only exact new evidence", () =>
  fixture(async (f) => {
    f.save();
    f.github.failWrite = true;
    await f.automaticReview();
    const original = f.service.getDetail(PR).submissions[0]!;
    assert.equal(original.status, "uncertain");
    const draft = f.service.getDetail(PR).draft!;
    const manualPreview = await f.service.preview(PR, draft.id, draft.version);
    await assert.rejects(f.service.submit(PR, manualPreview.id), /uncertain/);
    await f.restart();
    f.github.failWrite = false;
    f.github.inventory.reviews[0]!.payload.event = "APPROVE";
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).submissions[0]?.status, "uncertain");
    f.github.inventory.reviews[0]!.payload.event = "COMMENT";
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).submissions[0]?.status, "submitted");
    await f.automaticReview();
    assert.equal(f.github.writes.length, 1);
  }));

test("unbaselined historical uncertainty cannot become clear from a body/commit-only manual recovery", () =>
  fixture(async (f) => {
    f.service.createManualDraft(PR);
    const draft = f.service.getDetail(PR).draft!;
    const preview = await f.service.preview(PR, draft.id, draft.version);
    f.github.failWrite = true;
    await assert.rejects(f.service.submit(PR, preview.id), /uncertain/);
    f.service.db.sqlite
      .prepare("UPDATE previews SET recovery_json = NULL WHERE id = ?")
      .run(preview.id);
    let weakReads = 0;
    f.github.findReview = async () => {
      weakReads++;
      return {
        githubReviewId: "synthetic-existing-body-commit-match",
        url: null,
      };
    };
    await assert.rejects(f.service.submit(PR, preview.id), /uncertain/);
    assert.equal(weakReads, 0);
    assert.equal(f.service.getDetail(PR).submissions[0]?.status, "uncertain");
    f.save();
    f.github.current.pr.headSha = "synthetic-future-head";
    await f.automaticReview();
    assert.equal(f.github.writes.length, 1);
  }));

test("same-timestamp recovery evidence cannot prove publication followed the durable attempt", () =>
  fixture(async (f) => {
    f.save();
    f.github.failWrite = true;
    await f.automaticReview();
    const attempt = f.service.getDetail(PR).submissions[0]!;
    f.github.inventory.reviews[0]!.submittedAt = attempt.createdAt;
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).submissions[0]?.status, "uncertain");
    assert.equal(f.github.writes.length, 1);
  }));

test("repository changes revoke rather than carrying saved author policy or stale version authority", () =>
  fixture(async (f) => {
    f.save();
    const generation = f.service.getDetail(PR).pr.autoSubmission!.generation;
    f.service.updateSettings({ repository: "different/repository" });
    const reset = f.service.getState().settings.autoSubmission!;
    assert.equal(reset.enabled, false);
    assert.deepEqual(reset.authors, []);
    assert.equal(reset.version, 0);
    assert.equal(reset.consentedAt, null);
    assert.ok(
      f.service.getDetail(PR).pr.autoSubmission!.generation > generation,
    );
  }));

test("leaving and resaving a repository while publication awaits permanently invalidates old generation authority", () =>
  fixture(async (f) => {
    f.save();
    const saved = f.service.getState().settings.autoSubmission!;
    const generation = f.service.getDetail(PR).pr.autoSubmission!.generation;
    f.github.beforeInventory = async () => {
      f.service.updateSettings({
        repository: "different/repository",
        automation: automationOff,
      });
      f.service.updateSettings({ repository: "demo/repository" });
      f.save();
      f.service.db.savePublicationPolicy(saved);
    };
    await f.automaticReview();
    assert.equal(f.github.writes.length, 0);
    assert.equal(
      f.service.getDetail(PR).draft?.autoSubmission?.provenance?.prGeneration,
      generation,
    );
    assert.ok(
      f.service.getDetail(PR).pr.autoSubmission!.generation > generation,
    );
    assert.equal(
      f.service.getDetail(PR).pr.autoSubmission!.status,
      "manual_only",
    );
  }));

test("final awaited head work rechecks unsaved edit intent before creating an attempt", () =>
  fixture(async (f) => {
    f.save();
    let reads = 0;
    f.github.beforeInventory = async () => {
      f.github.beforeHead = async () => {
        if (++reads === 2) {
          const draft = f.service.getDetail(PR).draft!;
          f.service.editIntent(PR, {
            draftId: draft.id,
            version: draft.version,
          });
        }
      };
    };
    await f.automaticReview();
    assert.equal(f.github.writes.length, 0);
    assert.equal(f.service.getDetail(PR).submissions.length, 0);
    assert.equal(
      f.service.getDetail(PR).draft?.autoSubmission?.manualHold?.reason,
      "edit_intent",
    );
  }));

test("automatic inline placement and private evidence exclusion reuse the exact manual preview builder", () =>
  fixture(async (f) => {
    f.save(["REQUEST_CHANGES"]);
    f.reviewer.result.verdict = "REQUEST_CHANGES";
    f.reviewer.result.findings = [
      {
        id: "synthetic-blocking",
        path: "src/demo.ts",
        line: 2,
        startLine: null,
        side: "RIGHT",
        severity: "blocking",
        body: "SYNTHETIC finding",
        evidence: "SYNTHETIC secret private evidence",
        origin: "introduced",
        included: true,
        questionId: null,
      },
    ];
    await f.automaticReview();
    const detail = f.service.getDetail(PR);
    const draft = detail.draft!;
    const manual = await f.service.preview(PR, draft.id, draft.version);
    assert.deepEqual(f.github.writes[0], manual.payload);
    assert.deepEqual(f.github.writes[0]?.comments, [
      {
        path: "src/demo.ts",
        line: 2,
        side: "RIGHT",
        body: "**Blocking.** SYNTHETIC finding",
      },
    ]);
    assert.equal(
      JSON.stringify(f.github.writes).includes("secret private evidence"),
      false,
    );
    assert.equal(
      detail.runs[0]?.result?.findings[0]?.evidence,
      "SYNTHETIC secret private evidence",
    );
  }));

test("known bots and exact confirmed app automation do not manufacture requests; username alone never excludes", () =>
  fixture(async (f) => {
    f.save();
    await f.automaticReview();
    const submission = f.service.getDetail(PR).submissions[0]!;
    const own = {
      ...fixtureSource(submission.payload.body, submission.githubReviewId!),
      kind: "review" as const,
      author: "demo-user",
    };
    const bot = {
      ...fixtureSource("SYNTHETIC bot quotation", "bot"),
      author: "known[bot]",
      authorType: "Bot" as const,
      provenance: "bot" as const,
    };
    f.github.sources = [own, bot];
    f.classifier.decisions.set(own.id, "requested");
    f.classifier.decisions.set(bot.id, "requested");
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).pr.autoSubmission?.evidence.length, 0);
    f.github.sources = [{ ...own, id: "unverified-same-login" }];
    f.classifier.decisions.set("unverified-same-login", "requested");
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).pr.autoSubmission?.evidence.length, 1);
  }));

test("only complete exact confirmed inline identities count as app automation, not same-author/body copies", () =>
  fixture(async (f) => {
    f.save();
    f.reviewer.result.findings = [
      {
        id: "synthetic-inline",
        path: "src/demo.ts",
        line: 2,
        startLine: null,
        side: "RIGHT",
        severity: "non_blocking",
        body: "SYNTHETIC ask a person to check the quoted behavior",
        evidence: "SYNTHETIC private evidence",
        origin: "introduced",
        included: true,
        questionId: null,
      },
    ];
    await f.automaticReview();
    const submission = f.service.getDetail(PR).submissions[0]!;
    const own = {
      ...fixtureSource(
        submission.payload.comments[0]!.body,
        f.github.inventory.reviews[0]!.commentIds[0]!,
      ),
      kind: "inline_comment" as const,
      author: "demo-user",
      reviewId: submission.githubReviewId!,
      threadId: "synthetic-thread",
    };
    f.github.sources = [own];
    f.classifier.decisions.set(own.id, "requested");
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).pr.autoSubmission?.evidence.length, 0);
    await f.restart();
    f.github.current.pr.headSha = "synthetic-next-inline-head";
    f.github.sources = [{ ...own, outdated: true }];
    await f.automaticReview();
    assert.equal(f.github.writes.length, 2);
    assert.equal(f.service.getDetail(PR).pr.autoSubmission?.evidence.length, 0);
    f.github.sources = [{ ...own, id: "synthetic-human-copy" }];
    f.classifier.decisions.set("synthetic-human-copy", "requested");
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).pr.autoSubmission?.evidence.length, 1);
  }));

test("source edits, resolved/outdated flags never clear prior source-backed holds", () =>
  fixture(async (f) => {
    f.github.sources = [fixtureSource()];
    f.classifier.decisions.set("synthetic-comment", "requested");
    await f.service.checkAutoSubmission(PR);
    const original = f.service.getDetail(PR).pr.autoSubmission!.evidence[0]!;
    f.github.sources = [
      {
        ...fixtureSource("SYNTHETIC edited negation"),
        resolved: true,
        outdated: true,
      },
    ];
    f.classifier.decisions.set("synthetic-comment", "not_requested");
    await f.service.checkAutoSubmission(PR);
    const state = f.service.getDetail(PR).pr.autoSubmission!;
    assert.equal(state.status, "human_review_requested");
    assert.deepEqual(state.evidence[0], original);
  }));

test("exact classifier input revisions cache, but changed text or context must classify again", () =>
  fixture(async (f) => {
    f.github.sources = [fixtureSource("SYNTHETIC unrelated discussion")];
    await f.service.checkAutoSubmission(PR);
    const initial = f.classifier.calls;
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.classifier.calls, initial);
    f.github.current.pr.title = "SYNTHETIC changed contextual title";
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.classifier.calls, initial + 1);
    f.github.sources = [fixtureSource("SYNTHETIC changed text")];
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.classifier.calls, initial + 2);
  }));

test("discussion-only checks neither queue reviews nor consume the historical new-head baseline", () =>
  fixture(async (f) => {
    f.service.updateSettings({
      automation: { pollCommits: true, reviewNewCommits: true },
    });
    await f.service.sync();
    const oldHead = f.service.db.getAutomationState(PR).commitHead;
    f.github.current.pr.headSha = "synthetic-arrived-during-check";
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.db.listJobs().length, 0);
    assert.equal(f.service.db.getAutomationState(PR).commitHead, oldHead);
    await f.service.sync();
    assert.equal(f.service.db.listJobs("queued").length, 1);
    assert.equal(
      f.service.db.getAutomationState(PR).commitHead,
      "synthetic-arrived-during-check",
    );
  }));

test("restart-stranded automatic attempts become uncertain and never receive a blind retry", () =>
  fixture(async (f) => {
    f.save();
    await f.automaticReview();
    const submission = f.service.getDetail(PR).submissions[0]!;
    f.service.db.updateSubmission({
      ...submission,
      status: "submitting",
      githubReviewId: null,
      url: null,
    });
    await f.restart();
    assert.equal(f.service.getDetail(PR).submissions[0]?.status, "uncertain");
    await f.service.checkAutoSubmission(PR);
    assert.equal(f.service.getDetail(PR).submissions[0]?.status, "submitted");
    assert.equal(f.github.writes.length, 1);
  }));

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  autoSubmissionConfirmation,
  autoSubmissionReenableConfirmation,
  type PullRequestDetail,
} from "../../shared/contracts.js";
import { createHttpServer } from "../http.js";
import {
  fixturePrId as PR,
  fixtureSource,
  publicationFixture,
} from "./fixtures/auto-submission.js";

test("a confirmed automatically submitted draft can be edited, saved, reloaded and previewed without rewriting its submission", async () => {
  const f = await publicationFixture();
  const server = createHttpServer(f.service, f.config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/prs/${encodeURIComponent(PR)}`;
  const request = (suffix: string, body: unknown, method = "POST") =>
    fetch(`${base}${suffix}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    f.save();
    await f.automaticReview();
    const initial = f.service.getDetail(PR);
    const draft = initial.draft!;
    const submission = structuredClone(initial.submissions[0]!);
    const intent = await request("/draft/edit-intent", {
      draftId: draft.id,
      version: draft.version,
    });
    assert.equal(intent.status, 200);
    const observed = (await intent.json()) as PullRequestDetail;
    assert.equal(
      observed.draft?.autoSubmission?.manualHold?.reason,
      "edit_intent",
    );
    assert.equal(observed.pr.status, "submitted");
    assert.deepEqual(observed.submissions[0], submission);
    const saved = await request(
      "/draft",
      {
        draftId: draft.id,
        version: draft.version,
        body: "SYNTHETIC edit after confirmed publication",
        findings: draft.findings,
        verdict: draft.verdict,
      },
      "PUT",
    );
    assert.equal(saved.status, 200);
    const reloaded = (await (await fetch(base)).json()) as PullRequestDetail;
    assert.equal(reloaded.draft?.version, 2);
    assert.equal(
      reloaded.draft?.body,
      "SYNTHETIC edit after confirmed publication",
    );
    assert.equal(reloaded.pr.status, "ready");
    assert.deepEqual(reloaded.runs[0]?.result, initial.runs[0]?.result);
    assert.deepEqual(reloaded.submissions[0], submission);
    const preview = await request("/preview", {
      draftId: draft.id,
      draftVersion: 2,
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).payload.body, reloaded.draft?.body);
    assert.equal(f.github.writes.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.close();
  }
});

test("inert HTTP policy/edit-intent/hold APIs preserve exact manual preview and cached GET behavior", async () => {
  const f = await publicationFixture();
  const server = createHttpServer(f.service, f.config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const prefix = `/prs/${encodeURIComponent(PR)}`;
  const request = (url: string, body: unknown = {}, method = "POST") =>
    fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const current = f.service.getState().settings.autoSubmission!;
    const policy = {
      repository: current.repository,
      expectedVersion: current.version,
      enabled: true,
      authors: [{ username: " DEMO-AUTHOR ", actions: ["COMMENT"] }],
      confirmation: autoSubmissionConfirmation,
    };
    assert.equal(
      (
        await request(
          "/settings/auto-submission",
          { ...policy, consentedAt: "forged" },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (await request("/settings/auto-submission", policy, "PATCH")).status,
      200,
    );
    assert.equal(
      (await request("/settings/auto-submission", policy, "PATCH")).status,
      409,
    );
    assert.equal((await fetch(`${base}/settings/auto-submission`)).status, 404);
    f.service.createManualDraft(PR);
    const draft = f.service.getDetail(PR).draft!;
    assert.equal(
      (
        await request(`${prefix}/draft/edit-intent`, {
          draftId: draft.id,
          version: 99,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(`${prefix}/draft/edit-intent`, {
          draftId: draft.id,
          version: draft.version,
          authority: "automatic",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`${prefix}/draft/edit-intent`, {
          draftId: draft.id,
          version: draft.version,
        })
      ).status,
      200,
    );
    f.github.sources = [fixtureSource()];
    f.classifier.decisions.set("synthetic-comment", "requested");
    const checked = await request(`${prefix}/auto-submission/check`);
    const detail = (await checked.json()) as PullRequestDetail;
    assert.equal(detail.pr.autoSubmission?.status, "human_review_requested");
    const evidence = detail.pr.autoSubmission!.evidence[0]!;
    const state = detail.pr.autoSubmission!;
    const before = f.classifier.calls;
    await fetch(`${base}/state`);
    await fetch(`${base}${prefix}`);
    assert.equal(f.classifier.calls, before);
    assert.equal(
      (
        await request(`${prefix}/auto-submission/acknowledge`, {
          expectedVersion: state.version,
          evidenceId: evidence.id,
          source: evidence.source,
          action: "enable",
        })
      ).status,
      400,
    );
    const acknowledged = await request(
      `${prefix}/auto-submission/acknowledge`,
      {
        expectedVersion: state.version,
        evidenceId: evidence.id,
        source: evidence.source,
        action: "dismiss",
      },
    );
    assert.equal(acknowledged.status, 200);
    const acknowledgedDetail = (await acknowledged.json()) as PullRequestDetail;
    assert.equal(acknowledgedDetail.pr.autoSubmission?.reenableRequired, true);
    assert.equal(
      (
        await request(`${prefix}/auto-submission/re-enable`, {
          expectedVersion: acknowledgedDetail.pr.autoSubmission!.version,
          confirmation: autoSubmissionReenableConfirmation,
        })
      ).status,
      200,
    );
    assert.equal(f.github.writes.length, 0);
    const preview = await (
      await request(`${prefix}/preview`, {
        draftId: draft.id,
        draftVersion: draft.version,
      })
    ).json();
    assert.equal(
      (await request(`${prefix}/submit`, { previewId: preview.id })).status,
      200,
    );
    assert.equal(f.github.writes.length, 1);
    const foreign = await fetch(`${base}/settings/auto-submission`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://untrusted.example",
      },
      body: JSON.stringify(policy),
    });
    assert.equal(foreign.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.close();
  }
});

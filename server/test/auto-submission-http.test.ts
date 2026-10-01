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

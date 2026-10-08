import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  MergeReadiness,
  PullRequest,
  ReviewPayload,
  SubmissionPreview,
  SubmissionProgress,
  Submission,
} from "../../shared/contracts.js";
import { DemoGithubAdapter } from "../adapters.js";
import { loadConfig } from "../config.js";
import { createHttpServer } from "../http.js";
import { ReviewService } from "../service.js";

class DelayedGithub extends DemoGithubAdapter {
  calls: string[] = [];
  writes: ReviewPayload[] = [];
  headGate: Promise<void> | null = null;
  baselineGate: Promise<void> | null = null;
  failWrite = false;
  remoteHead: string | null = null;
  override async getPullRequest(repository: string, number: number) {
    this.calls.push("broad-pr-diff");
    return super.getPullRequest(repository, number);
  }
  async getSubmissionHead(pr: PullRequest) {
    this.calls.push("lightweight-head");
    if (this.headGate) await this.headGate;
    return { headSha: this.remoteHead ?? pr.headSha, state: pr.state };
  }
  override async mergeReadiness(pr: PullRequest): Promise<MergeReadiness> {
    this.calls.push("merge-readiness");
    return super.mergeReadiness(pr);
  }
  async reviewInventory() {
    this.calls.push("review-baseline");
    if (this.baselineGate) await this.baselineGate;
    return { writer: "demo-user", reviewIds: [], reviews: [] };
  }
  override async submitReview(_pr: PullRequest, payload: ReviewPayload) {
    this.calls.push("inert-write");
    this.writes.push(structuredClone(payload));
    if (this.failWrite) throw new Error("SYNTHETIC lost response");
    return { githubReviewId: "inert-review", url: null };
  }
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-preview-progress-"));
  const config = loadConfig({
    demo: true,
    dataDir,
    databasePath: join(dataDir, "db.sqlite"),
  });
  const github = new DelayedGithub();
  const service = await ReviewService.create(config, github);
  service.db.updateSettings({ repository: "demo/repository" });
  await service.importPullRequest("https://github.com/demo/repository/pull/42");
  const prId = "demo/repository#42";
  const detail = service.createManualDraft(prId);
  const draft = detail.draft!;
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  config.port = address.port;
  const url = `http://127.0.0.1:${address.port}/api/prs/${encodeURIComponent(prId)}`;
  const post = (action: string, body: unknown, stream = false) =>
    fetch(`${url}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: stream ? "application/x-ndjson" : "application/json",
      },
      body: JSON.stringify(body),
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  };
  github.calls = [];
  return { service, github, draft, prId, post, close };
}

async function* events<T>(
  response: Response,
): AsyncGenerator<SubmissionProgress<T>> {
  assert.equal(
    response.headers.get("content-type"),
    "application/x-ndjson; charset=utf-8",
  );
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      yield JSON.parse(pending.slice(0, end)) as SubmissionProgress<T>;
      pending = pending.slice(end + 1);
    }
  }
  assert.equal(pending, "");
}

test("streamed preview and confirmation expose actual stages and omit a second broad fetch", async () => {
  const f = await fixture();
  try {
    const previewResponse = await f.post(
      "preview",
      { draftId: f.draft.id, draftVersion: f.draft.version },
      true,
    );
    const previewEvents = [];
    for await (const event of events<SubmissionPreview>(previewResponse))
      previewEvents.push(event);
    assert.deepEqual(
      previewEvents.map((event) =>
        event.type === "step" ? event.step : event.type,
      ),
      ["refreshing_pr", "checking_readiness", "building_payload", "result"],
    );
    const preview = previewEvents.at(-1)!;
    assert.equal(preview.type, "result");
    if (preview.type !== "result") return;
    assert.deepEqual(f.github.calls, ["broad-pr-diff", "merge-readiness"]);
    assert.deepEqual(preview.value.payload, {
      event: "COMMENT",
      body: "",
      commit_id: f.draft.headSha,
      comments: [],
    });
    let releaseHead = () => {};
    f.github.headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let releaseBaseline = () => {};
    f.github.baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const started = performance.now();
    const response = await f.post(
      "submit",
      { previewId: preview.value.id },
      true,
    );
    const iterator = events<Submission>(response);
    assert.deepEqual((await iterator.next()).value, {
      type: "step",
      step: "checking_head",
    });
    await delay(35);
    assert.deepEqual(f.github.calls, [
      "broad-pr-diff",
      "merge-readiness",
      "lightweight-head",
    ]);
    assert.equal(f.github.writes.length, 0);
    releaseHead();
    assert.deepEqual((await iterator.next()).value, {
      type: "step",
      step: "reading_baseline",
    });
    await delay(35);
    assert.equal(f.github.writes.length, 0);
    releaseBaseline();
    assert.deepEqual((await iterator.next()).value, {
      type: "step",
      step: "sending_review",
    });
    const result = (await iterator.next()).value;
    assert.equal(result?.type, "result");
    if (result?.type === "result")
      assert.deepEqual(result.value.payload, preview.value.payload);
    assert.equal((await iterator.next()).done, true);
    assert.ok(performance.now() - started >= 70);
    assert.deepEqual(f.github.calls, [
      "broad-pr-diff",
      "merge-readiness",
      "lightweight-head",
      "review-baseline",
      "inert-write",
    ]);
    assert.deepEqual(f.github.writes, [preview.value.payload]);
    assert.equal(
      (await f.post("submit", { previewId: preview.value.id })).status,
      200,
    );
    assert.equal(f.github.writes.length, 1);
  } finally {
    await f.close();
  }
});

test("confirmation rejects a changed head or draft after preview without reading baseline or writing", async () => {
  const f = await fixture();
  try {
    const preview = (await (
      await f.post("preview", {
        draftId: f.draft.id,
        draftVersion: f.draft.version,
      })
    ).json()) as SubmissionPreview;
    f.github.calls = [];
    let releaseHead = () => {};
    f.github.headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const stale = await f.post("submit", { previewId: preview.id }, true);
    const seen = [];
    const iterator = events<Submission>(stale);
    seen.push((await iterator.next()).value!);
    f.github.remoteHead = "b".repeat(40);
    releaseHead();
    for await (const event of iterator) seen.push(event);
    assert.deepEqual(
      seen.map((event) => (event.type === "step" ? event.step : event.type)),
      ["checking_head", "error"],
    );
    const staleError = seen.at(-1);
    assert.equal(
      staleError?.type === "error" && staleError.code,
      "stale_draft",
    );
    assert.deepEqual(f.github.calls, ["lightweight-head"]);
    f.github.remoteHead = null;
    f.github.headGate = null;
    f.service.updateDraft(f.prId, {
      draftId: f.draft.id,
      version: f.draft.version,
      body: "Edited after preview",
      verdict: f.draft.verdict,
      findings: f.draft.findings,
    });
    const edited = await f.post("submit", { previewId: preview.id });
    assert.equal(edited.status, 409);
    assert.equal((await edited.json()).code, "draft_conflict");
    const updated = f.service.getDetail(f.prId).draft!;
    const fresh = (await (
      await f.post("preview", {
        draftId: updated.id,
        draftVersion: updated.version,
      })
    ).json()) as SubmissionPreview;
    let releaseBaseline = () => {};
    f.github.baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const pending = await f.post("submit", { previewId: fresh.id }, true);
    const iterator2 = events<Submission>(pending);
    assert.deepEqual((await iterator2.next()).value, {
      type: "step",
      step: "checking_head",
    });
    assert.deepEqual((await iterator2.next()).value, {
      type: "step",
      step: "reading_baseline",
    });
    f.service.updateDraft(f.prId, {
      draftId: updated.id,
      version: updated.version,
      body: "Edited during baseline",
      verdict: updated.verdict,
      findings: updated.findings,
    });
    releaseBaseline();
    const conflict = (await iterator2.next()).value;
    assert.equal(conflict?.type === "error" && conflict.code, "draft_conflict");
    assert.equal(f.github.writes.length, 0);
  } finally {
    await f.close();
  }
});

test("lost inert write persists uncertain status and retry reconciles rather than issuing another write", async () => {
  const f = await fixture();
  try {
    const preview = (await (
      await f.post("preview", {
        draftId: f.draft.id,
        draftVersion: f.draft.version,
      })
    ).json()) as SubmissionPreview;
    f.github.calls = [];
    f.github.failWrite = true;
    const response = await f.post("submit", { previewId: preview.id }, true);
    const seen = [];
    for await (const event of events<Submission>(response)) seen.push(event);
    assert.deepEqual(
      seen.map((event) => (event.type === "step" ? event.step : event.type)),
      ["checking_head", "reading_baseline", "sending_review", "error"],
    );
    const uncertain = seen.at(-1);
    assert.equal(
      uncertain?.type === "error" && uncertain.code,
      "submission_ambiguous",
    );
    assert.deepEqual(f.github.calls, [
      "lightweight-head",
      "review-baseline",
      "inert-write",
    ]);
    assert.equal(
      f.service.getDetail(f.prId).submissions[0]?.status,
      "uncertain",
    );
    const retry = await f.post("submit", { previewId: preview.id });
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).code, "submission_ambiguous");
    assert.deepEqual(f.github.calls, [
      "lightweight-head",
      "review-baseline",
      "inert-write",
      "review-baseline",
    ]);
    assert.equal(f.github.writes.length, 1);
  } finally {
    await f.close();
  }
});

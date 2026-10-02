import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  DiscussionSnapshot,
  DiscussionSource,
  HumanReviewClassification,
  HumanReviewClassifierInput,
  PullRequest,
  ReviewPayload,
  ReviewResult,
  ReviewerSettings,
} from "../../../shared/contracts.js";
import { autoSubmissionConfirmation } from "../../../shared/contracts.js";
import {
  DemoGithubAdapter,
  type ReviewerAdapter,
  type ReviewerInput,
  type RemotePullRequest,
} from "../../adapters.js";
import { loadConfig } from "../../config.js";
import { ReviewService } from "../../service.js";
import { revision } from "../../discussion.js";
import type { HumanReviewClassifier } from "../../human-review.js";
import type { ReviewInventory } from "../../publication.js";
import { saveFixtureExecution } from "./current-settings.js";

export const fixturePrId = "demo/repository#42";
export const fixtureSource = (
  body = "SYNTHETIC Please ask a person to review",
  id = "synthetic-comment",
): DiscussionSource => ({
  kind: "comment",
  id,
  version: revision(body),
  author: "demo-author",
  authorType: "User",
  body,
  url: `https://github.com/demo/repository/pull/42#issuecomment-${id}`,
  updatedAt: "2026-01-01T00:00:00Z",
  threadId: null,
  replyToId: null,
  reviewId: null,
  resolved: null,
  outdated: null,
  provenance: "participant",
});

export class InertPublicationGithub extends DemoGithubAdapter {
  current!: RemotePullRequest;
  eventId = "synthetic-request-1";
  writes: ReviewPayload[] = [];
  sources: DiscussionSource[] = [];
  complete = true;
  failWrite = false;
  inventory: ReviewInventory = {
    writer: "demo-user",
    reviewIds: [],
    reviews: [],
  };
  beforeInventory?: () => Promise<void>;
  beforeDiscussion?: () => Promise<void>;
  beforeHead?: () => Promise<void>;
  beforeWrite?: () => Promise<void>;
  override async getPullRequest(repository: string, number: number) {
    await this.beforeHead?.();
    return structuredClone(
      this.current ?? (await super.getPullRequest(repository, number)),
    );
  }
  override async poll() {
    return {
      user: "demo-user",
      pullRequests: [structuredClone(this.current)],
      requests: [
        {
          eventId: this.eventId,
          prId: fixturePrId,
          headSha: this.current.pr.headSha,
          requestedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
  }
  async discussion(pr: PullRequest): Promise<DiscussionSnapshot> {
    await this.beforeDiscussion?.();
    const coverage = {
      complete: this.complete,
      comments: {
        pages: 1,
        complete: this.complete,
        error: this.complete ? null : "SYNTHETIC incomplete pagination",
      },
      reviews: { pages: 1, complete: true, error: null },
      threads: { pages: 1, complete: true, error: null },
    };
    return {
      prId: pr.id,
      headSha: pr.headSha,
      fetchedAt: new Date().toISOString(),
      revision: revision(this.sources),
      coverage,
      sources: structuredClone(this.sources),
    };
  }
  async reviewInventory() {
    await this.beforeInventory?.();
    return structuredClone(this.inventory);
  }
  override async submitReview(_pr?: PullRequest, payload?: ReviewPayload) {
    this.writes.push(structuredClone(payload!));
    await this.beforeWrite?.();
    const id = `synthetic-review-${this.writes.length}`;
    this.inventory.reviewIds.push(id);
    this.inventory.reviews.push({
      id,
      author: "demo-user",
      submittedAt: new Date(Date.now() + 1).toISOString(),
      payload: structuredClone(payload!),
      url: "https://example.invalid/synthetic-review",
      commentIds: payload!.comments.map((_, index) => `${id}-comment-${index}`),
    });
    if (this.failWrite)
      throw new Error("SYNTHETIC connection lost after write");
    return {
      githubReviewId: id,
      url: "https://example.invalid/synthetic-review",
    };
  }
}

export class InertPublicationReviewer implements ReviewerAdapter {
  result: ReviewResult = {
    overview: "SYNTHETIC private overview",
    body: "SYNTHETIC review",
    findings: [],
    verdict: "COMMENT",
    rationale: "SYNTHETIC inert reviewer",
  };
  beforeResult?: () => Promise<void>;
  async health() {
    return { status: "ready" as const, message: "SYNTHETIC inert reviewer" };
  }
  async run(_input: ReviewerInput) {
    await this.beforeResult?.();
    return {
      result: structuredClone(this.result),
      log: "SYNTHETIC inert reviewer",
    };
  }
}

export class InertPublicationClassifier implements HumanReviewClassifier {
  calls = 0;
  beforeResult?: () => Promise<void>;
  decisions = new Map<string, HumanReviewClassification["decision"]>();
  fail = false;
  async classify(
    input: HumanReviewClassifierInput,
    settings: ReviewerSettings,
  ) {
    this.calls++;
    await this.beforeResult?.();
    if (this.fail) throw new Error("SYNTHETIC unsupported classifier");
    return {
      output: {
        version: 1 as const,
        revision: input.discussion.revision,
        results: input.discussion.sources
          .filter((item) => item.provenance === "participant")
          .map((item) => ({
            source: { kind: item.kind, id: item.id, version: item.version },
            decision: this.decisions.get(item.id) ?? "not_requested",
            quote:
              this.decisions.get(item.id) === "requested" ? item.body : null,
            reason: "SYNTHETIC predetermined contextual decision",
          })),
      },
      detector: {
        profile: "no-tools-1" as const,
        mode: "separated" as const,
        harness: "claude" as const,
        model: settings.model!,
      },
    };
  }
}

export async function publicationFixture(empty = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "pr-review-publication-"));
  const config = loadConfig({
    demo: true,
    dataDir,
    databasePath: path.join(dataDir, "app.sqlite"),
  });
  const github = new InertPublicationGithub();
  github.current = await github.getPullRequest("demo/repository", 42);
  const reviewer = new InertPublicationReviewer();
  const classifier = new InertPublicationClassifier();
  let service = await ReviewService.create(
    config,
    github,
    reviewer,
    undefined,
    undefined,
    undefined,
    undefined,
    classifier,
  );
  service.queue.schedule = () => {};
  if (empty) service.db.updateSettings({ repository: "" });
  else {
    await saveFixtureExecution(service);
    await service.importPullRequest(
      "https://github.com/demo/repository/pull/42",
    );
  }
  return {
    get service() {
      return service;
    },
    github,
    reviewer,
    classifier,
    dataDir,
    config,
    async restart() {
      await service.close();
      service = await ReviewService.create(
        config,
        github,
        reviewer,
        undefined,
        undefined,
        undefined,
        undefined,
        classifier,
      );
      service.queue.schedule = () => {};
    },
    save(actions: ReviewPayload["event"][] = ["COMMENT"], enabled = true) {
      return service.saveAutoSubmission({
        repository: "demo/repository",
        expectedVersion: service.getState().settings.autoSubmission!.version,
        enabled,
        authors: [{ username: " DEMO-AUTHOR ", actions }],
        ...(enabled ? { confirmation: autoSubmissionConfirmation } : {}),
      });
    },
    async automaticReview() {
      service.updateSettings({
        automation: { pollCommits: true, reviewNewCommits: true },
      });
      await service.sync();
      service.db.setCommitHead(fixturePrId, "previous-synthetic-head");
      await service.sync();
      const job = service.db
        .listJobs()
        .find((item) => item.status === "queued");
      if (!job) throw new Error("SYNTHETIC automatic review was not queued");
      await service.processJob(job);
    },
    async close() {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

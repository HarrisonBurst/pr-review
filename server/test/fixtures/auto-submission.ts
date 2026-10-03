import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  DiscussionSnapshot,
  DiscussionSource,
  PullRequest,
  ReviewPayload,
  ReviewResult,
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
  calls = 0;
  decisions = new Map<string, "requested" | "not_requested" | "uncertain">();
  fail = false;
  extensionMode: "normal" | "missing" | "malformed" | "null" = "normal";
  beforeResult?: () => Promise<void>;
  async health() {
    return { status: "ready" as const, message: "SYNTHETIC inert reviewer" };
  }
  async run(input: ReviewerInput) {
    this.calls++;
    await this.beforeResult?.();
    const result = structuredClone(this.result);
    if (this.extensionMode !== "missing") {
      result.humanReviewRequest =
        this.fail ||
        this.extensionMode === "null" ||
        !input.discussion ||
        [...this.decisions.values()].includes("uncertain")
          ? null
          : {
              version: 1,
              contextVersion: input.discussion.revision,
              evidence: input.discussion.sources
                .filter(
                  (item) =>
                    this.decisions.get(item.id) === "requested" &&
                    item.authorType === "User" &&
                    item.provenance === "participant",
                )
                .map((item) => ({
                  source: {
                    kind: item.kind,
                    id: item.id,
                    version: item.version,
                  },
                  author: item.author,
                  quote: item.body,
                  url: item.url,
                })),
            };
      if (this.extensionMode === "malformed")
        result.humanReviewRequest = {
          version: 7,
        } as unknown as ReviewResult["humanReviewRequest"];
    }
    return { result, log: "SYNTHETIC inert reviewer" };
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
  let service = await ReviewService.create(config, github, reviewer);
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
    dataDir,
    config,
    async restart() {
      await service.close();
      service = await ReviewService.create(config, github, reviewer);
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
    async manualReview() {
      await service.manualReview(fixturePrId);
      await service.processJob(service.db.listJobs("queued")[0]!);
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

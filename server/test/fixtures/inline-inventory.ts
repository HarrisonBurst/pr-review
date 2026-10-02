import type { PullRequest } from "../../../shared/contracts.js";
import type { GithubRead } from "../../discussion.js";
import { acquireReviewInventory } from "../../discussion.js";
import { fixturePrId, publicationFixture } from "./auto-submission.js";

export function inlineInventoryRead(pr: PullRequest): GithubRead {
  return async (args) => {
    if (args[1] === "user") return JSON.stringify({ login: "demo-user" });
    if (args[1]!.includes("/comments?")) {
      const comment = {
        id: 101,
        pull_request_review_id: 77,
        path: "src/demo.ts",
        body: "SYNTHETIC earlier inline comment",
        position: 3,
        original_position: 3,
        line: 2,
        side: "RIGHT",
        start_line: null,
        start_side: null,
      };
      if (args[1]!.includes("/reviews/")) {
        const { line, side, start_line, start_side, ...legacy } = comment;
        return JSON.stringify([legacy]);
      }
      return JSON.stringify([comment]);
    }
    return JSON.stringify([
      {
        id: 77,
        user: { login: "demo-participant" },
        submitted_at: "2026-01-01T00:00:01Z",
        state: "APPROVED",
        commit_id: pr.headSha,
        body: "",
        html_url: pr.url,
      },
    ]);
  };
}

export async function inlineInventoryFixture(empty = false) {
  const f = await publicationFixture(empty);
  f.github.reviewInventory = () =>
    acquireReviewInventory(
      inlineInventoryRead(f.github.current.pr),
      f.github.current.pr,
    );
  if (!empty) {
    f.reviewer.result.verdict = "APPROVE";
    f.reviewer.result.findings = [
      {
        id: "synthetic-finding",
        severity: "non_blocking",
        path: "src/demo.ts",
        line: 2,
        startLine: null,
        side: "RIGHT",
        body: "SYNTHETIC proposed inline comment",
        evidence: "SYNTHETIC private evidence",
        origin: "introduced",
        included: true,
        questionId: null,
      },
    ];
    await f.service.manualReview(fixturePrId);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    const draft = f.service.getDetail(fixturePrId).draft!;
    f.service.updateDraft(fixturePrId, {
      draftId: draft.id,
      version: draft.version,
      body: "SYNTHETIC manually edited approval body",
      findings: draft.findings,
      verdict: "APPROVE",
    });
  }
  return f;
}

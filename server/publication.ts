import {
  inboxEligible,
  type AutoSubmissionPolicy,
  type AutoSubmissionState,
  type PullRequest,
  type ReviewPayload,
} from "../shared/contracts.js";
import { canonicalJson } from "./schema.js";

export const publicationOff = (repository: string): AutoSubmissionPolicy => ({
  repository,
  enabled: false,
  authors: [],
  version: 0,
  consentedAt: null,
});
export const publicationState = (): AutoSubmissionState => ({
  version: 0,
  generation: 0,
  status: "off",
  message: "Automatic submission is off",
  draftId: null,
  evidence: [],
  check: null,
  reenableRequired: false,
});

export interface RemoteReviewEvidence {
  id: string;
  url: string | null;
  author: string;
  submittedAt: string;
  payload: ReviewPayload;
  commentIds: string[];
}

export interface ReviewInventory {
  writer: string;
  reviewIds: string[];
  reviews: RemoteReviewEvidence[];
}

export interface SubmissionRecovery {
  writer: string;
  reviewIds: string[];
  capturedAt: string;
  commentIds?: string[];
}

export function sameReviewPayload(
  left: ReviewPayload,
  right: ReviewPayload,
): boolean {
  const canonicalPayload = (value: ReviewPayload) =>
    canonicalJson({
      ...value,
      comments: value.comments.map((comment) => canonicalJson(comment)).sort(),
    });
  return canonicalPayload(left) === canonicalPayload(right);
}

export function exactReview(
  inventory: ReviewInventory,
  recovery: SubmissionRecovery,
  payload: ReviewPayload,
): RemoteReviewEvidence | null {
  const matches = inventory.reviews.filter(
    (review) =>
      review.author.toLowerCase() === recovery.writer.toLowerCase() &&
      !recovery.reviewIds.includes(review.id) &&
      Date.parse(review.submittedAt) > Date.parse(recovery.capturedAt) &&
      sameReviewPayload(review.payload, payload),
  );
  return inventory.writer.toLowerCase() === recovery.writer.toLowerCase() &&
    matches.length === 1
    ? matches[0]
    : null;
}

export const automaticallyReviewed = (pr: PullRequest) =>
  inboxEligible(pr) &&
  (pr.effectiveAutomation.reviewNewCommits ||
    pr.effectiveAutomation.reviewRequests);

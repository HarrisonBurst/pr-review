import type { PullRequest } from "../../../shared/contracts";

export function staleReviewJobs(previous: PullRequest, next: PullRequest): boolean {
  const before = previous.autoSubmission?.version ?? 0;
  const after = next.autoSubmission?.version ?? 0;
  if (after !== before) return after < before;
  return (previous.reviewJobs ?? []).some((job) => {
    const incoming = next.reviewJobs?.find((item) => item.jobId === job.jobId);
    if (job.cancellation)
      return (
        !incoming?.cancellation ||
        (!!job.cancellation.finishedAt && !incoming.cancellation.finishedAt)
      );
    return job.status === "unqueued" && incoming?.status !== "unqueued";
  });
}

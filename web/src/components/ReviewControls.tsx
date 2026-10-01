import { useCallback, useRef, useState } from "react";
import {
  cancelReviewConfirmation,
  type PullRequest,
  type PullRequestDetail,
  type ReviewJob,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { Modal, useToast } from "./ui";
import { shortSha } from "../lib/format";

export function ReviewControls({
  pr,
  onChange,
}: {
  pr: PullRequest;
  onChange: (detail?: PullRequestDetail) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<ReviewJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const toast = useToast();
  const closeConfirm = useCallback(() => {
    if (!inFlight.current) setConfirm(null);
  }, []);
  const act = async (job: ReviewJob, action: "unqueue" | "cancel") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(job.jobId);
    setError(null);
    try {
      const detail = await api.reviewJobAction(pr.id, job.jobId, action, {
        runId: job.runId,
        headSha: job.headSha,
        ...(action === "cancel" ? { confirmation: cancelReviewConfirmation } : {}),
      });
      setConfirm(null);
      toast(
        action === "unqueue"
          ? `#${pr.number}: observed job unqueued; history retained`
          : `#${pr.number}: cancellation requested, not yet confirmed`,
      );
      await onChange(detail);
    } catch (e) {
      const message =
        e instanceof RequestError
          ? e.message
          : "Lost contact with the backend. Shutdown is not confirmed; reload the actual job state before taking another action";
      setError(message);
      setConfirm(null);
      await onChange();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  if (!pr.reviewJobs?.length && !confirm && !error) return null;
  return (
    <div className="review-controls stack">
      {(pr.reviewJobs ?? []).map((job) => {
        const label = job.kind === "revision" ? "AI revision" : "review";
        return (
          <div key={job.jobId} className="stack">
            {job.cancellation ? (
              <span
                className="small"
                role={job.cancellation.status === "unconfirmed" ? "alert" : "status"}
              >
                {label} at {shortSha(job.headSha)} (run {shortSha(job.runId)}):{" "}
                {job.cancellation.status === "pending"
                  ? "Cancellation pending"
                  : job.cancellation.status === "confirmed"
                    ? "Cancellation confirmed"
                    : "Shutdown unconfirmed"}
                . {job.cancellation.message}
              </span>
            ) : job.status === "unqueued" ? (
              <span className="small" role="status">
                {label} unqueued at {shortSha(job.headSha)} (run {shortSha(job.runId)}); history
                retained.
              </span>
            ) : job.status === "queued" || job.status === "running" ? (
              <button
                type="button"
                className="button small row-action"
                disabled={busy !== null}
                aria-busy={busy === job.jobId || undefined}
                aria-label={`${job.status === "queued" ? "Unqueue" : "Cancel"} ${label} #${pr.number} at ${shortSha(job.headSha)}, run ${shortSha(job.runId)}`}
                onClick={() =>
                  job.status === "queued" ? void act(job, "unqueue") : setConfirm(job)
                }
              >
                {busy === job.jobId
                  ? "Requesting..."
                  : job.status === "queued"
                    ? "Unqueue"
                    : "Cancel review"}
                {job.kind === "revision" ? " (AI revision)" : ""}
              </button>
            ) : null}
          </div>
        );
      })}
      {error && (
        <span role="alert" className="small">
          {error}
        </span>
      )}
      {confirm && (
        <Modal
          title={`Cancel ${confirm.kind === "revision" ? "AI revision" : "review"} #${pr.number}?`}
          onClose={closeConfirm}
          footer={
            <>
              <button
                type="button"
                className="button"
                disabled={busy !== null}
                onClick={() => setConfirm(null)}
              >
                Keep running
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy !== null}
                onClick={() => void act(confirm, "cancel")}
              >
                Confirm cancellation
              </button>
            </>
          }
        >
          <p>
            Stop only the observed job at <code>{shortSha(confirm.headSha)}</code>, run{" "}
            <code>{shortSha(confirm.runId)}</code>. A request is not shutdown completion. Automatic
            app publication will pause until explicitly re-enabled for future reviews.
          </p>
          <p>
            Drafts and history remain. Prior native effects, including Dangerous writes, and
            already-dispatched or uncertain publications cannot be undone. Detached malicious
            descendants are not contained by process ownership.
          </p>
        </Modal>
      )}
    </div>
  );
}

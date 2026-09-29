import { useEffect, useState } from "react";
import type { Finding, Submission, SubmissionPreview } from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { shortSha, verdictLabel } from "../lib/format";
import { Markdown } from "./Markdown";
import { Modal, Notice, SeverityPill, Spinner, SubmissionPill } from "./ui";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string; conflict: boolean }
  | { kind: "ready"; preview: SubmissionPreview }
  | { kind: "submitting"; preview: SubmissionPreview }
  | { kind: "done"; submission: Submission };

export function SubmitModal({
  prId,
  draftId,
  draftVersion,
  findings,
  onClose,
  onSubmitted,
}: {
  prId: string;
  draftId: string;
  draftVersion: number;
  findings: Finding[];
  onClose: () => void;
  onSubmitted: (submission: Submission) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .preview(prId, draftId, draftVersion)
      .then((preview) => !cancelled && setPhase({ kind: "ready", preview }))
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e instanceof RequestError ? e : null;
        setPhase({
          kind: "error",
          message: err?.message ?? String(e),
          conflict: err?.conflict ?? false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [prId, draftId, draftVersion]);

  const submit = async () => {
    if (phase.kind !== "ready") return;
    setPhase({ kind: "submitting", preview: phase.preview });
    try {
      const submission = await api.submit(prId, phase.preview.id);
      setPhase({ kind: "done", submission });
      onSubmitted(submission);
    } catch (e) {
      const err = e instanceof RequestError ? e : null;
      setPhase({
        kind: "error",
        message: err?.message ?? String(e),
        conflict: err?.conflict ?? false,
      });
    }
  };

  const preview = phase.kind === "ready" || phase.kind === "submitting" ? phase.preview : null;

  return (
    <Modal
      title={phase.kind === "done" ? "Submission result" : "Review exactly what will be sent"}
      onClose={onClose}
      footer={
        phase.kind === "done" ? (
          <button type="button" className="button primary" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            {preview && (
              <label className="checkbox grow">
                <input
                  type="checkbox"
                  checked={armed}
                  disabled={phase.kind === "submitting"}
                  onChange={(e) => setArmed(e.target.checked)}
                />
                I have read the exact payload above
              </label>
            )}
            <button
              type="button"
              className="button ghost"
              onClick={onClose}
              disabled={phase.kind === "submitting"}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!preview || !armed || phase.kind === "submitting"}
              onClick={() => void submit()}
            >
              {phase.kind === "submitting"
                ? "Submitting"
                : `Submit ${preview ? verdictLabel[preview.payload.event].toLowerCase() : "review"} to GitHub`}
            </button>
          </>
        )
      }
    >
      {phase.kind === "loading" && <Spinner label="Refreshing PR head and building the payload" />}
      {phase.kind === "error" && (
        <Notice
          tone="danger"
          title={phase.conflict ? "Cannot submit this draft." : "Preview failed."}
        >
          {phase.message}
          {phase.conflict && " Close this dialog, reload the draft, and try again."}
        </Notice>
      )}
      {preview && <PayloadView preview={preview} findings={findings} />}
      {phase.kind === "done" && <SubmissionResult submission={phase.submission} />}
    </Modal>
  );
}

function PayloadView({ preview, findings }: { preview: SubmissionPreview; findings: Finding[] }) {
  const { payload } = preview;
  const included = findings.filter((f) => f.included);
  const inline = included.filter((f) =>
    payload.comments.some(
      (c) =>
        c.path === f.path &&
        c.line === f.line &&
        c.side === f.side &&
        (c.start_line ?? null) === f.startLine,
    ),
  );
  const inBody = included.filter((f) => !inline.includes(f));
  const blocking = included.filter((f) => f.severity === "blocking").length;
  return (
    <>
      <Notice tone="info">
        Nothing is sent until you press the submit button below. Every included finding appears
        exactly once: inline when its line is in this commit's diff, otherwise in the review body.
        The overview and evidence stay private.
      </Notice>
      <div className="preview-summary" data-testid="preview-summary">
        <span>
          <strong>{verdictLabel[payload.event]}</strong> on{" "}
          <span className="mono" title={payload.commit_id}>
            {shortSha(payload.commit_id)}
          </span>
        </span>
        <span>
          <strong>{included.length}</strong> {included.length === 1 ? "finding" : "findings"}
          {included.length > 0 &&
            ` (${blocking} blocking, ${included.length - blocking} non-blocking)`}
        </span>
        <span>
          <strong>{payload.comments.length}</strong> inline
        </span>
        <span>
          <strong>{inBody.length}</strong> in body
        </span>
        <span>draft v{preview.draftVersion}</span>
      </div>
      <div className="field">
        <span className="field-label">Review body</span>
        <div className="preview-item">
          {payload.body ? (
            <Markdown source={payload.body} />
          ) : (
            <p className="muted small" style={{ padding: "8px 10px" }}>
              (empty)
            </p>
          )}
        </div>
        {inBody.length > 0 && (
          <p className="small faint">
            In the body:{" "}
            {inBody
              .map((f) =>
                f.path
                  ? `${f.path}${f.line ? `:${f.startLine ? `${f.startLine}-` : ""}${f.line}` : ""}${f.line ? " (not in this diff)" : ""}`
                  : "general comment",
              )
              .join(", ")}
          </p>
        )}
      </div>
      {payload.comments.length > 0 && (
        <div className="field">
          <span className="field-label">Inline comments</span>
          <div className="stack" style={{ gap: 8 }}>
            {payload.comments.map((c, i) => (
              <div className="preview-item" key={i}>
                <div className="loc">
                  <SeverityPill severity={severityOf(c.body)} />
                  <span className="path">
                    {c.path}:{c.start_line !== undefined ? `${c.start_line}-` : ""}
                    {c.line}
                  </span>
                  <span className="faint">
                    {c.side === "LEFT" ? "old side" : "new side"}
                    {c.start_line !== undefined ? ", multi-line" : ""}
                  </span>
                </div>
                <Markdown source={c.body} />
              </div>
            ))}
          </div>
        </div>
      )}
      <details className="preview-raw">
        <summary>Exact payload sent to GitHub</summary>
        <pre className="payload" data-testid="payload-body">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </details>
    </>
  );
}

const severityOf = (body: string) => (/^\**blocking[.:]/i.test(body) ? "blocking" : "non_blocking");

export function SubmissionResult({ submission }: { submission: Submission }) {
  return (
    <div className="sub" data-status={submission.status}>
      <div className="row between">
        <span className="row">
          <SubmissionPill status={submission.status} />
          <span className="mono faint">{shortSha(submission.payload.commit_id)}</span>
        </span>
        {submission.url && (
          <a href={submission.url} target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        )}
      </div>
      {submission.status === "uncertain" && (
        <strong>
          GitHub's answer was lost. Check the PR on GitHub before submitting again; nothing is
          retried automatically.
        </strong>
      )}
      {submission.status === "failed" && <strong>The review was not created.</strong>}
      {submission.status === "submitting" && (
        <span>Write in progress. If this persists after a restart, reconcile it on GitHub.</span>
      )}
      {submission.error && <span className="small">{submission.error}</span>}
      {submission.githubReviewId && (
        <span className="small faint">Review id {submission.githubReviewId}</span>
      )}
    </div>
  );
}

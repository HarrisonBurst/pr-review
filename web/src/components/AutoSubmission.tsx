import { useEffect, useRef, useState } from "react";
import {
  autoSubmissionReenableConfirmation,
  type AutoSubmissionState,
  type HumanReviewEvidence,
  type PullRequest,
  type PullRequestDetail,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { relativeTime, shortSha } from "../lib/format";
import { Notice, Pill } from "./ui";

export function AutoSubmissionBadges({
  state,
  includeUnavailable = true,
}: {
  state?: AutoSubmissionState;
  includeUnavailable?: boolean;
}) {
  const active = state?.evidence.filter((item) => !item.acknowledgment) ?? [];
  return (
    <>
      {active.length > 0 && (
        <span title={active.map((item) => `${item.author}: ${item.quote}`).join("\n")}>
          <Pill tone="warn">
            <span aria-hidden="true">✋</span> Human requested
          </Pill>
        </span>
      )}
      {state?.status === "uncertain" && <Pill tone="warn">Automatic write uncertain</Pill>}
      {state?.status === "failed" && (
        <span title={state.message}>
          <Pill tone="warn">Auto-submit failed: {state.failure?.step ?? "publication"}</Pill>
        </span>
      )}
      {includeUnavailable && state?.detection?.status === "unavailable" && (
        <Pill>Human-request detection unavailable</Pill>
      )}
    </>
  );
}

export function AutoSubmissionCard({
  pr,
  onDetail,
  onRefresh,
}: {
  pr: PullRequest;
  onDetail: (detail: PullRequestDetail) => void;
  onRefresh: () => Promise<void>;
}) {
  const state = pr.autoSubmission;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedVersion, setConfirmedVersion] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const confirmationKey = `${pr.id}:${state?.version}`;
  const canReenable =
    state?.reenableRequired && state.evidence.every((item) => item.acknowledgment !== null);
  const action = async (work: () => Promise<PullRequestDetail>) => {
    setBusy(true);
    setError(null);
    setConfirmedVersion(null);
    try {
      const detail = await work();
      if (mounted.current) onDetail(detail);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof RequestError ? e.message : String(e));
      if (e instanceof RequestError && e.conflict) await onRefresh();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const acknowledge = (evidence: HumanReviewEvidence, choice: "dismiss" | "resolve") =>
    action(() =>
      api.acknowledgeHumanReview(pr.id, {
        expectedVersion: state!.version,
        evidenceId: evidence.id,
        source: evidence.source,
        action: choice,
      }),
    );
  const detection = state?.detection;
  return (
    <section className="card" aria-labelledby="auto-submit-status-h">
      <div className="card-head">
        <h2 id="auto-submit-status-h">Automatic submission</h2>
      </div>
      <div className="card-body stack small">
        <div className="row wrap">
          <AutoSubmissionBadges state={state} />
        </div>
        <p>
          {state?.message || "Off or manual-only. No automatic publication authority was recorded."}
        </p>
        {state && (
          <p className="faint">
            State: {state.status.replaceAll("_", " ")} · version {state.version} · generation{" "}
            {state.generation}
          </p>
        )}
        {state?.reenableRequired && (
          <Notice tone="warn">
            Automatic submission remains held across new commits. Acknowledging evidence alone never
            resumes it. Resume affects only later automatic full reviews, grants no author action
            and never clears draft edit holds.
          </Notice>
        )}
        {state?.evidence.map((item) => (
          <div className="context human-evidence" key={item.id}>
            <strong>{item.author}</strong>
            <blockquote>{item.quote}</blockquote>
            <a href={item.url} target="_blank" rel="noreferrer">
              Source on GitHub ↗
            </a>
            <p className="faint">
              {item.source.kind.replaceAll("_", " ")} {item.source.id} · source version{" "}
              <span className="mono">{item.source.version}</span> · detected{" "}
              {relativeTime(item.detectedAt)}
            </p>
            {item.acknowledgment ? (
              <p>
                {item.acknowledgment.action === "dismiss" ? "Dismissed" : "Resolved"}{" "}
                {relativeTime(item.acknowledgment.at)}. Retained as acknowledgment history.
              </p>
            ) : (
              <div className="row wrap">
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() => void acknowledge(item, "resolve")}
                >
                  Resolve this evidence
                </button>
                <button
                  type="button"
                  className="button ghost small"
                  disabled={busy}
                  onClick={() => void acknowledge(item, "dismiss")}
                >
                  Dismiss this evidence
                </button>
              </div>
            )}
          </div>
        ))}
        <p>
          {detection?.message ??
            "Human-request detection unavailable; no same-pass observation recorded."}
        </p>
        {detection && (
          <details>
            <summary>Same-pass observation: {detection.status.replaceAll("_", " ")}</summary>
            <p>
              Head {shortSha(detection.headSha)}
              {detection.headSha !== pr.headSha ? " (older head)" : ""} ·{" "}
              {relativeTime(detection.observedAt)} · context{" "}
              <span className="mono">{detection.contextVersion ?? "not available"}</span>
            </p>
            <p>Discussion coverage: {detection.coverage.complete ? "complete" : "incomplete"}</p>
          </details>
        )}
        <p className="faint">
          Detection uses the same review pass and configured tools, without an extra model call.
          Unavailable or empty detection is nonblocking and never clears known requests. Private
          drafting and manual exact preview remain available.
        </p>
        {state?.check && (
          <details>
            <summary>
              Historical classifier check: {state.check.status.replaceAll("_", " ")}
            </summary>
            <p>{state.check.message}</p>
            <p>
              {relativeTime(state.check.checkedAt)} · {shortSha(state.check.headSha)}
            </p>
            <p>
              Detector:{" "}
              {state.check.detector
                ? `${state.check.detector.mode} / ${state.check.detector.harness} / ${state.check.detector.model} / ${state.check.detector.profile}`
                : "not recorded"}
            </p>
          </details>
        )}
        {(state?.status === "uncertain" ||
          state?.failure?.step === "provenance" ||
          state?.failure?.step === "reconciliation") && (
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => void action(() => api.reconcileAutoSubmission(pr.id))}
          >
            Reconcile submission without reposting
          </button>
        )}
        {state?.reenableRequired && (
          <>
            {!canReenable && (
              <p>
                Resolve or dismiss every stored evidence version before resuming future reviews. No
                clear check is required.
              </p>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmedVersion === confirmationKey}
                disabled={busy || !canReenable}
                onChange={(e) => setConfirmedVersion(e.target.checked ? confirmationKey : null)}
              />
              {autoSubmissionReenableConfirmation}
            </label>
            <button
              type="button"
              className="button small"
              disabled={busy || !canReenable || confirmedVersion !== confirmationKey}
              onClick={() =>
                void action(() =>
                  api.reenableAutoSubmission(pr.id, {
                    expectedVersion: state.version,
                    confirmation: autoSubmissionReenableConfirmation,
                  }),
                )
              }
            >
              Resume for later reviews
            </button>
          </>
        )}
        {error && (
          <Notice
            tone="danger"
            actions={
              <button
                type="button"
                className="button small"
                disabled={busy}
                onClick={() => void onRefresh()}
              >
                Reload automatic-submission state
              </button>
            }
          >
            {error}
          </Notice>
        )}
      </div>
    </section>
  );
}

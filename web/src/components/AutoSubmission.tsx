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

export function AutoSubmissionBadges({ state }: { state?: AutoSubmissionState }) {
  const active = state?.evidence.filter((item) => !item.acknowledgment) ?? [];
  return (
    <>
      {active.length > 0 && (
        <span title={active.map((item) => `${item.author}: ${item.quote}`).join("\n")}>
          <Pill tone="warn">
            <span aria-hidden="true">✋</span> Human review requested
          </Pill>
        </span>
      )}
      {(state?.status === "check_needed" || state?.check?.status === "check_needed") && (
        <Pill tone="warn">Auto-submit paused: check needed</Pill>
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
  const confirmationKey = `${pr.id}:${pr.headSha}:${state?.version}`;
  const check = state?.check;
  const clear =
    check?.status === "clear" && check.coverage.complete && check.headSha === pr.headSha;
  const acknowledged = state?.evidence.every((item) => item.acknowledgment !== null);
  const canReenable = state?.reenableRequired && clear && acknowledged;

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
            resumes it. Re-enable affects only later automatic full reviews, grants no author action
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
        {check ? (
          <details>
            <summary>Last automatic-submission check: {check.status.replaceAll("_", " ")}</summary>
            <p>{check.message}</p>
            <p>
              Head {shortSha(check.headSha)}
              {check.headSha !== pr.headSha ? " (older head)" : ""} ·{" "}
              {relativeTime(check.checkedAt)} · revision{" "}
              <span className="mono">{check.revision ?? "not available"}</span>
            </p>
            <p>Discussion coverage: {check.coverage.complete ? "complete" : "incomplete"}</p>
            <ul>
              {(["comments", "reviews", "threads"] as const).map((kind) => (
                <li key={kind}>
                  {kind}: {check.coverage[kind].pages} pages,{" "}
                  {check.coverage[kind].complete ? "complete" : "incomplete"}
                  {check.coverage[kind].error && `, ${check.coverage[kind].error}`}
                </li>
              ))}
            </ul>
            <p>
              Detector:{" "}
              {check.detector
                ? `${check.detector.mode} / ${check.detector.harness} / ${check.detector.model} / ${check.detector.profile}`
                : "not recorded"}
            </p>
          </details>
        ) : (
          <p className="faint">No automatic-submission check recorded.</p>
        )}
        <div>
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => void action(() => api.checkAutoSubmission(pr.id))}
          >
            {busy ? "Updating automatic-submission state" : "Check automatic submission now"}
          </button>
        </div>
        <p className="faint">
          This explicit check freshly reads the PR head and discussion and may invoke the captured
          Main model as a contextual classifier where zero-tool execution is supported. Unsupported
          modes pause before model dispatch without fallback. It never publishes or queues a full
          review. Opening this panel does not run this check. Private drafting and manual exact
          preview remain available.
        </p>
        {state?.reenableRequired && (
          <>
            {!canReenable && (
              <p>
                Check again after acknowledging every evidence version. A complete clear check on
                the current head is required; the server makes the final decision.
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
              Re-enable for later reviews
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

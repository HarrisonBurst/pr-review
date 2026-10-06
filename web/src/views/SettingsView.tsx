import { useEffect, useState, type FormEvent } from "react";
import {
  effectiveAutomation,
  inheritAutomation,
  maxConcurrentReviewsRange,
  validConcurrentReviews,
  type AppHealth,
  type ExecutionMode,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { AutomationSettings, BASELINE_NOTE, summarize } from "../components/Automation";
import { AutoSubmissionSettings } from "../components/AutoSubmissionSettings";
import { ConnectionSettings } from "../components/Connections";
import { WorkflowSettings } from "../components/Workflow";
import { healthTone, Notice, Pill, useToast } from "../components/ui";
import { relativeTime } from "../lib/format";
import { hrefFor } from "../lib/router";

export function GitHubHealth({ health }: { health: AppHealth }) {
  return (
    <dl className="kv" aria-label="GitHub health">
      <dt>GitHub</dt>
      <dd>
        <Pill tone={healthTone[health.github.status]}>{health.github.status}</Pill>{" "}
        <span className="small faint">{health.github.message || "No details yet"}</span>
      </dd>
      <dt>GitHub user</dt>
      <dd>{health.githubUser ?? <span className="faint">unknown</span>}</dd>
      <dt>Last poll</dt>
      <dd>{relativeTime(health.lastPollAt)}</dd>
      {health.pollError && (
        <>
          <dt>Poll error</dt>
          <dd style={{ color: "var(--danger)" }}>{health.pollError}</dd>
        </>
      )}
    </dl>
  );
}

export function SettingsView() {
  const { state, setState } = useApp();
  const toast = useToast();
  const { settings, health } = state;
  const activeReviews = state.prs.filter((pr) =>
    pr.reviewJobs?.some((job) => job.status === "queued" || job.status === "running"),
  );
  const reviewing = activeReviews.filter((pr) =>
    pr.reviewJobs?.some((job) => job.status === "running"),
  ).length;
  const [repository, setRepository] = useState(settings.repository);
  const [interval, setInterval] = useState(String(settings.pollIntervalSeconds));
  const [concurrency, setConcurrency] = useState(String(settings.maxConcurrentReviews));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ExecutionMode | null | undefined>(undefined);

  useEffect(() => {
    setRepository(settings.repository);
    setInterval(String(settings.pollIntervalSeconds));
    setConcurrency(String(settings.maxConcurrentReviews));
  }, [settings.repository, settings.pollIntervalSeconds, settings.maxConcurrentReviews]);

  const concurrencyValue = concurrency.trim() === "" ? NaN : Number(concurrency);
  const concurrencyValid = validConcurrentReviews(concurrencyValue);

  const save = async (update: Parameters<typeof api.updateSettings>[0], message: string) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.updateSettings(update));
      toast(message);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const seconds = Number(interval);
    void save(
      {
        repository: repository.trim(),
        pollIntervalSeconds:
          Number.isFinite(seconds) && seconds > 0
            ? Math.round(seconds)
            : settings.pollIntervalSeconds,
        maxConcurrentReviews: concurrencyValue,
      },
      "Settings saved",
    );
  };

  const dirty =
    repository.trim() !== settings.repository ||
    Number(interval) !== settings.pollIntervalSeconds ||
    concurrencyValue !== settings.maxConcurrentReviews;

  return (
    <div className="stack settings-view" style={{ maxWidth: 720, gap: 16 }}>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <form className="card" onSubmit={submit}>
        <div className="card-head">
          <div className="row" style={{ gap: 8 }}>
            <h2>Repository and cadence</h2>
            {health.demo && <Pill tone="warn">Demo mode</Pill>}
          </div>
          <button
            type="submit"
            className="button primary small"
            disabled={busy || !dirty || !concurrencyValid}
          >
            Save
          </button>
        </div>
        <div className="card-body stack">
          <div className="field">
            <label htmlFor="repo">Repository</label>
            <input
              id="repo"
              className="input mono"
              value={repository}
              placeholder="owner/name"
              pattern="[\w.\-]+/[\w.\-]+"
              onChange={(e) => setRepository(e.target.value)}
            />
            <span className="small faint">
              Changing the repository clears nothing; existing PRs stay until synced.
            </span>
          </div>
          <div className="field">
            <label htmlFor="interval">Poll interval (seconds)</label>
            <input
              id="interval"
              className="input"
              type="number"
              min={15}
              step={5}
              value={interval}
              style={{ width: 160 }}
              onChange={(e) => setInterval(e.target.value)}
            />
            <span className="small faint">Shared by every polling option below.</span>
          </div>
          <div className="field">
            <label htmlFor="concurrency">Maximum concurrent reviews</label>
            <input
              id="concurrency"
              className="input"
              type="number"
              inputMode="numeric"
              min={maxConcurrentReviewsRange.min}
              max={maxConcurrentReviewsRange.max}
              step={1}
              value={concurrency}
              style={{ width: 160 }}
              aria-invalid={!concurrencyValid}
              aria-describedby={`concurrency-help${concurrencyValid ? "" : " concurrency-error"}`}
              onChange={(e) => setConcurrency(e.target.value)}
            />
            {!concurrencyValid && (
              <span id="concurrency-error" className="small" style={{ color: "var(--danger)" }}>
                Enter a whole number from {maxConcurrentReviewsRange.min} to{" "}
                {maxConcurrentReviewsRange.max}.
              </span>
            )}
            <span id="concurrency-help" className="small faint">
              How many full reviews and AI revisions may run at the same time, from{" "}
              {maxConcurrentReviewsRange.min} to {maxConcurrentReviewsRange.max}. Jobs for the same
              pull request still run one after another. Each running job opens its captured Main and
              Additional harness sessions, so higher values use more local CPU, memory, and
              simultaneous model sessions. Raising it starts queued jobs right away; lowering it
              never stops a running job. This does not change polling, auto-review, or what gets
              approved or posted, and Ask AI questions keep their own single slot.
            </span>
          </div>
          <GitHubHealth health={health} />
        </div>
      </form>
      <section className="card" aria-labelledby="automation-h">
        <div className="card-head">
          <h2 id="automation-h">Automation</h2>
          <span className="small muted" data-testid="global-summary">
            {summarize(effectiveAutomation(settings.automation, inheritAutomation))}
          </span>
        </div>
        <div className="card-body stack" style={{ gap: 12 }}>
          {!settings.repository && (
            <Notice tone="neutral">Configure a repository before turning on automation.</Notice>
          )}
          <AutomationSettings
            policy={settings.automation}
            disabled={busy || !settings.repository}
            onChange={(automation) =>
              void save(
                { automation },
                Object.values(automation)[0] ? "Automation updated" : "Automation switched off",
              )
            }
          />
          {activeReviews.length > 0 && (
            <Notice tone="neutral">
              <p style={{ margin: 0 }}>
                {activeReviews.length} PRs with review work: {activeReviews.length - reviewing}{" "}
                queued, {reviewing} reviewing. Maximum concurrent reviews:{" "}
                {settings.maxConcurrentReviews}.
              </p>
              <ul>
                {activeReviews.map((pr) => (
                  <li key={pr.id}>
                    <a href={hrefFor({ name: "pr", id: pr.id })}>
                      #{pr.number} {pr.title}
                    </a>{" "}
                    -{" "}
                    {pr.reviewJobs?.some((job) => job.status === "running")
                      ? "Reviewing"
                      : "Queued"}
                  </li>
                ))}
              </ul>
              <a href="#/">View Inbox</a>
            </Notice>
          )}
          <p className="small faint" style={{ margin: 0 }}>
            These are global defaults. Each pull request can inherit or override them from its own
            page. {BASELINE_NOTE}
          </p>
          <AutoSubmissionSettings />
        </div>
      </section>
      <WorkflowSettings onModeChange={setMode} />
      {mode !== undefined && mode !== "dangerous" && (
        <ConnectionSettings catalog={state.integrations} />
      )}
    </div>
  );
}

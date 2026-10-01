import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  autoSubmissionConfirmation,
  normalizeAutoSubmissionAuthors,
  normalizeGithubUsername,
  reviewVerdicts,
  type AutoSubmissionPolicy,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { verdictLabel } from "../lib/format";
import { Notice, Pill, Switch, useToast } from "./ui";

const policyFor = (repository: string, policy?: AutoSubmissionPolicy): AutoSubmissionPolicy =>
  policy?.repository === repository
    ? policy
    : { repository, enabled: false, authors: [], version: 0, consentedAt: null };

export function AutoSubmissionSettings() {
  const { state, setState } = useApp();
  const toast = useToast();
  const current = policyFor(state.settings.repository, state.settings.autoSubmission);
  const observed = useRef(current);
  observed.current = current;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [baseline, setBaseline] = useState(current);
  const [enabled, setEnabled] = useState(baseline.enabled);
  const [authors, setAuthors] = useState(baseline.authors);
  const [username, setUsername] = useState("");
  const [confirmationFor, setConfirmationFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const changed =
    baseline.repository !== current.repository || baseline.version !== current.version;
  const preview = JSON.stringify({
    repository: baseline.repository,
    version: baseline.version,
    enabled,
    authors,
  });
  const confirmed = confirmationFor === preview && !changed && !conflict;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeGithubUsername(username);
    if (!normalized) {
      setError(
        "Enter a GitHub username, not a URL or @handle. Use 1-39 letters, numbers or single internal hyphens.",
      );
      return;
    }
    const next = normalizeAutoSubmissionAuthors([
      ...authors,
      { username: normalized, actions: [] },
    ]);
    if (!next) {
      setError(
        authors.some((row) => row.username === normalized)
          ? `${normalized} is already in the table.`
          : "At most 100 authors can be added.",
      );
      return;
    }
    setAuthors(next);
    setUsername("");
    setConfirmationFor(null);
    setError(null);
  };

  const reload = async () => {
    setBusy(true);
    try {
      const next = await api.state();
      if (!mounted.current) return;
      const policy = policyFor(next.settings.repository, next.settings.autoSubmission);
      setState(next);
      setBaseline(policy);
      setEnabled(policy.enabled);
      setAuthors(policy.authors);
      setConfirmationFor(null);
      setConflict(false);
      setError(null);
    } catch (e) {
      setError(e instanceof RequestError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateAutoSubmission({
        repository: baseline.repository,
        expectedVersion: baseline.version,
        enabled,
        authors: normalizeAutoSubmissionAuthors(authors)!,
        ...(enabled && confirmed ? { confirmation: autoSubmissionConfirmation } : {}),
      });
      if (!mounted.current) return;
      const policy = policyFor(next.settings.repository, next.settings.autoSubmission);
      if (
        observed.current.repository !== baseline.repository ||
        observed.current.version > policy.version
      ) {
        setConflict(true);
        setError(
          "The saved policy changed while Save was pending. Your choices are retained; reload and review.",
        );
        setConfirmationFor(null);
        return;
      }
      setState(next);
      setBaseline(policy);
      setEnabled(policy.enabled);
      setAuthors(policy.authors);
      setConfirmationFor(null);
      setConflict(false);
      toast("Automatic submission policy saved; no work was queued");
    } catch (e) {
      setError(e instanceof RequestError ? e.message : String(e));
      if (e instanceof RequestError && e.conflict) setConflict(true);
      setConfirmationFor(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack auto-submission-settings" aria-labelledby="auto-submission-h">
      <div className="row wrap between">
        <h3 id="auto-submission-h">Automatic submission</h3>
        <Pill plain>{current.enabled ? "Saved On" : "Saved Off"}</Pill>
      </div>
      <Switch
        label="Enable automatic submission"
        checked={enabled}
        disabled={busy || !baseline.repository}
        onChange={(value) => {
          setEnabled(value);
          setConfirmationFor(null);
        }}
      />
      <p className="small muted">
        Independent of the four switches above. Saving never turns on polling or reviews, queues
        work, or authorizes old, manual, local or revision drafts. Only untouched future automatic
        full reviews can qualify. Human requests, uncertain checks and editing pause automatic
        publication; manual exact preview and submission stay available.
      </p>
      <form className="row wrap" onSubmit={add} aria-label="Add automatic submission author">
        <div className="field grow">
          <label htmlFor="auto-submission-username">PR-author GitHub username</label>
          <input
            id="auto-submission-username"
            className="input"
            value={username}
            disabled={busy}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            autoCapitalize="none"
            autoComplete="off"
          />
        </div>
        <button type="submit" className="button small" disabled={busy || !username.trim()}>
          Add
        </button>
      </form>
      <div
        className="auto-author-table"
        tabIndex={0}
        role="region"
        aria-label="Author permissions table"
      >
        <table>
          <caption className="sr-only">
            Exact PR-author permissions for {baseline.repository || "no saved repository"}
          </caption>
          <thead>
            <tr>
              <th scope="col">PR author</th>
              {reviewVerdicts.map((action) => (
                <th key={action} scope="col">
                  {verdictLabel[action]}
                </th>
              ))}
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            {authors.map((row) => (
              <tr key={row.username}>
                <th scope="row" className="mono">
                  {row.username}
                </th>
                {reviewVerdicts.map((action) => (
                  <td key={action}>
                    <input
                      type="checkbox"
                      aria-label={`${verdictLabel[action]} for ${row.username}`}
                      disabled={busy}
                      checked={row.actions.includes(action)}
                      onChange={(e) => {
                        setAuthors(
                          authors.map((author) =>
                            author.username === row.username
                              ? {
                                  ...author,
                                  actions: reviewVerdicts.filter((v) =>
                                    v === action ? e.target.checked : author.actions.includes(v),
                                  ),
                                }
                              : author,
                          ),
                        );
                        setConfirmationFor(null);
                      }}
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="button ghost small"
                    aria-label={`Remove ${row.username}`}
                    disabled={busy}
                    onClick={() => {
                      setAuthors(authors.filter((author) => author.username !== row.username));
                      setConfirmationFor(null);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!authors.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No authors authorized. New rows start with no actions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Comment excludes any immutable blocking finding, even if unchecked in the draft. Approve
        really approves the PR. Request changes really requests changes. No permission relabels an
        AI verdict or drops findings. Usernames match exactly, case-insensitively; no live lookup is
        made.
      </p>
      <div className="context small" aria-label="Future publication policy preview">
        <strong>Save preview: {baseline.repository || "no saved repository"}</strong>
        <p>
          {enabled
            ? "On, for future qualifying automatic full reviews only:"
            : "Off, no automatic publication."}
        </p>
        <ul>
          {authors.map((row) => (
            <li key={row.username}>
              <span className="mono">{row.username}</span>:{" "}
              {row.actions.length
                ? row.actions.map((v) => verdictLabel[v]).join(", ")
                : "no actions"}
            </li>
          ))}
        </ul>
        {!authors.length && <p>No authors or actions authorized.</p>}
      </div>
      {(changed || conflict) && (
        <Notice tone="warn" title="Saved policy or repository changed.">
          Your unsaved choices are retained. Reload the saved policy to discard these choices, then
          review and confirm the new repository and table before saving.
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => void reload()}
          >
            Reload saved policy and review
          </button>
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {enabled && (
        <label className="checkbox small">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || changed || conflict}
            onChange={(e) => setConfirmationFor(e.target.checked ? preview : null)}
          />
          {autoSubmissionConfirmation}
        </label>
      )}
      <div>
        <button
          type="button"
          className="button primary small"
          disabled={busy || !baseline.repository || changed || conflict || (enabled && !confirmed)}
          onClick={() => void save()}
        >
          {busy ? "Saving policy" : "Save automatic submission"}
        </button>
      </div>
    </section>
  );
}

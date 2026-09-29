import { useState, type FormEvent } from "react";
import type { ReviewDraft, RevisionProposal } from "../../../shared/contracts";
import { compareResult } from "../lib/draft";
import { relativeTime, verdictLabel } from "../lib/format";
import { Pill, SeverityPill } from "./ui";

export function RevisionForm({
  draft,
  dirty,
  busy,
  onRevise,
}: {
  draft: ReviewDraft;
  dirty: boolean;
  busy: boolean;
  onRevise: (instructions: string, findingIds: string[]) => Promise<void>;
}) {
  const [instructions, setInstructions] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await onRevise(instructions.trim(), targets);
    setInstructions("");
    setTargets([]);
  };
  const toggle = (id: string) =>
    setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  return (
    <form className="stack" onSubmit={submit} aria-label="Revision request">
      <div className="field">
        <label htmlFor="revise-instructions">Ask AI to revise</label>
        <textarea
          id="revise-instructions"
          className="textarea"
          rows={2}
          placeholder="e.g. Soften the tone and merge the two rounding findings"
          value={instructions}
          disabled={busy || dirty}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      {draft.findings.length > 0 && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ marginBottom: 4 }}>
            Limit to findings <span className="faint">(none selected means the whole draft)</span>
          </legend>
          <div className="row wrap" style={{ gap: 6 }}>
            {draft.findings.map((f, i) => (
              <label
                key={f.id}
                className="chip"
                aria-pressed={targets.includes(f.id)}
                style={{ border: "1px solid var(--line-2)" }}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={targets.includes(f.id)}
                  disabled={busy || dirty}
                  onChange={() => toggle(f.id)}
                />
                {i + 1}. {f.path ?? "General"}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="row between">
        <span className="small faint">
          {dirty
            ? "Save your edits first; revisions run against the saved draft."
            : `Runs against draft v${draft.version}.`}
        </span>
        <button type="submit" className="button" disabled={busy || dirty || !instructions.trim()}>
          Request revision
        </button>
      </div>
    </form>
  );
}

export function ProposalCard({
  proposal,
  draft,
  busy,
  dirty,
  onApply,
  onReject,
  onRegenerate,
}: {
  proposal: RevisionProposal;
  draft: ReviewDraft | null;
  busy: boolean;
  dirty: boolean;
  onApply: () => void;
  onReject: () => void;
  onRegenerate: () => void;
}) {
  const stale = !draft || proposal.sourceDraftVersion !== draft.version;
  const changes = compareResult(draft, proposal.result);
  const overviewChanged = draft?.overview !== proposal.result.overview;
  const bodyChanged = draft?.body !== proposal.result.body;
  const verdictChanged = draft?.verdict !== proposal.result.verdict;
  const changed = changes.filter((c) => c.kind !== "same");
  const nothing = !overviewChanged && !bodyChanged && !verdictChanged && changed.length === 0;
  return (
    <section
      className="card"
      aria-labelledby={`prop-${proposal.id}`}
      style={{
        borderColor: stale ? "var(--line)" : "color-mix(in srgb, var(--accent) 45%, var(--line))",
      }}
    >
      <div className="card-head">
        <div className="row">
          <h2 id={`prop-${proposal.id}`}>AI proposal</h2>
          {stale ? (
            <Pill tone="warn">Stale · based on v{proposal.sourceDraftVersion}</Pill>
          ) : (
            <Pill tone="accent">Pending · based on v{proposal.sourceDraftVersion}</Pill>
          )}
          <span className="small faint">{relativeTime(proposal.createdAt)}</span>
        </div>
      </div>
      <div className="card-body stack">
        <p className="small muted">
          <strong>Instructions:</strong> {proposal.instructions}
        </p>
        {stale && (
          <p className="small" style={{ color: "var(--warn)" }}>
            The draft moved to v{draft?.version ?? "none"} since this was generated. Regenerate it
            to apply, or reject it.
          </p>
        )}
        <div className="proposal-diff">
          {overviewChanged && (
            <div className="item" data-change="changed">
              <span className="field-label">Overview</span>
              {draft && <span className="old">{draft.overview}</span>}
              <span className="summary-text">{proposal.result.overview}</span>
            </div>
          )}
          {bodyChanged && (
            <div className="item" data-change="changed">
              <span className="field-label">Review body</span>
              {draft && <span className="old">{draft.body}</span>}
              <span className="summary-text">{proposal.result.body}</span>
            </div>
          )}
          {verdictChanged && (
            <div className="item" data-change="changed">
              <span className="field-label">Verdict</span>{" "}
              {draft && <span className="old">{verdictLabel[draft.verdict]}</span>}
              {verdictLabel[proposal.result.verdict]}
            </div>
          )}
          {changed.map((c) => (
            <div className="item" key={`${c.kind}-${c.finding.id}`} data-change={c.kind}>
              <div className="row" style={{ marginBottom: 4 }}>
                <Pill
                  tone={c.kind === "added" ? "ok" : c.kind === "removed" ? "danger" : "accent"}
                  plain
                >
                  {c.kind}
                </Pill>
                <SeverityPill severity={c.finding.severity} />
                {c.finding.path && (
                  <span className="mono faint">
                    {c.finding.path}
                    {c.finding.line !== null ? `:${c.finding.line}` : ""}
                  </span>
                )}
              </div>
              {c.before && c.before.body !== c.finding.body && (
                <span className="old">{c.before.body}</span>
              )}
              <span>{c.finding.body}</span>
            </div>
          ))}
          {nothing && <p className="small muted">No differences from the current draft.</p>}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="button ghost" disabled={busy} onClick={onReject}>
            Reject
          </button>
          {stale ? (
            <button
              type="button"
              className="button"
              disabled={busy || dirty}
              onClick={onRegenerate}
            >
              Regenerate against v{draft?.version ?? "?"}
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={busy || dirty}
              title={dirty ? "Save or discard your edits first" : undefined}
              onClick={onApply}
            >
              Accept into draft
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState } from "react";
import type { DraftUpdate, ReviewDraft, ReviewRun, ReviewVerdict } from "../../../shared/contracts";
import { draftLabel, isManual, newFinding } from "../lib/draft";
import { relativeTime, shortSha, verdictLabel } from "../lib/format";
import { DraftEditGate, type DraftEditing } from "./DraftEditGate";
import { FindingEditor } from "./FindingEditor";
import { Markdown } from "./Markdown";
import { AutoTextarea, Notice, Pill } from "./ui";

export interface DraftEditorProps {
  saved: ReviewDraft;
  drafts: ReviewDraft[];
  runs: ReviewRun[];
  headSha: string;
  edit: DraftUpdate;
  dirty: boolean;
  remoteChanged: boolean;
  conflict: string | null;
  saving: boolean;
  editing: DraftEditing;
  onEdit: (next: DraftUpdate) => void;
  onSave: () => void;
  onDiscard: () => void;
  onSelect: (draftId: string) => void;
}

const verdicts: ReviewVerdict[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];

export function DraftEditor({
  saved,
  drafts,
  runs,
  headSha,
  edit,
  dirty,
  remoteChanged,
  conflict,
  saving,
  editing,
  onEdit,
  onSave,
  onDiscard,
  onSelect,
}: DraftEditorProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => {
    if (!dirty) setConfirmDiscard(false);
  }, [dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !saving && editing.allowed) onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, saving, editing.allowed, onSave]);

  const latest = drafts[0]!;
  const isLatest = latest.id === saved.id;
  const outdated = saved.headSha !== headSha;
  const included = edit.findings.filter((f) => f.included);
  const blocking = included.filter((f) => f.severity === "blocking").length;

  return (
    <section className="card" aria-labelledby="draft-h">
      <div className="card-head">
        <div className="row wrap">
          <h2 id="draft-h">Draft review</h2>
          <select
            className="select draft-select"
            aria-label="Review draft"
            value={saved.id}
            disabled={saving}
            onChange={(e) => onSelect(e.target.value)}
          >
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                {draftLabel(d, drafts, headSha, runs)}
              </option>
            ))}
          </select>
          {isLatest ? <Pill tone="accent">Latest</Pill> : <Pill tone="warn">Older draft</Pill>}
          {isManual(saved) && (
            <Pill tone="info" plain>
              Local draft, no AI review
            </Pill>
          )}
          <span className="small faint">
            v{saved.version} · saved {relativeTime(saved.updatedAt)}
          </span>
        </div>
        <span className="counts">
          {blocking > 0 && <span className="b">{blocking} blocking</span>}
          {included.length - blocking > 0 && (
            <span className="nb">{included.length - blocking} non-blocking</span>
          )}
          {included.length === 0 && <span className="faint">no findings included</span>}
        </span>
      </div>
      {!isLatest && (
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <Notice
            tone="info"
            title="A newer review draft is available."
            actions={
              <button
                type="button"
                className="button small"
                disabled={saving}
                onClick={() => onSelect(latest.id)}
              >
                Open latest draft
              </button>
            }
          >
            You are editing the {isManual(saved) ? "local draft for" : "draft from the review of"}{" "}
            {shortSha(saved.headSha)}
            {outdated ? ", which is not the current commit" : ""}. Edits here stay on this draft and
            never change the latest one.
          </Notice>
        </div>
      )}
      {(remoteChanged || conflict) && (
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <Notice
            tone="warn"
            title={conflict ? "Save rejected." : "Draft changed elsewhere."}
            actions={
              <button type="button" className="button small" onClick={onDiscard}>
                Load latest, discard my edits
              </button>
            }
          >
            {conflict ??
              `The saved draft is now v${saved.version}. Your unsaved edits are based on v${edit.version}.`}
          </Notice>
        </div>
      )}
      <div className="card-body stack" style={{ gap: 16 }}>
        <DraftEditGate editing={editing} />
        <div className="field">
          <span className="field-label" id="draft-overview-label">
            Overview <span className="field-hint">private, from the review, read-only</span>
          </span>
          <div
            className="context"
            role="note"
            aria-labelledby="draft-overview-label"
            data-testid="draft-overview"
          >
            {saved.overview.trim() ? (
              <Markdown source={saved.overview} />
            ) : isManual(saved) ? (
              <p className="context-empty">
                This is a local draft with no AI review behind it, so there is no overview. Running
                a review adds a separate draft with one.
              </p>
            ) : (
              <p className="context-empty">
                This review was generated before overviews existed, so none was recorded. A new full
                review produces one.
              </p>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="draft-body">
            GitHub review body <span className="field-hint">posted verbatim</span>
          </label>
          <AutoTextarea
            id="draft-body"
            minRows={3}
            value={edit.body}
            disabled={saving}
            readOnly={!editing.allowed}
            onChange={(e) => editing.allowed && onEdit({ ...edit, body: e.target.value })}
          />
        </div>
        <div className="field inline">
          <span className="field-label" id="verdict-label">
            Verdict
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="verdict-label">
            {verdicts.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={edit.verdict === v}
                disabled={saving || !editing.allowed}
                onClick={() => onEdit({ ...edit, verdict: v })}
              >
                {verdictLabel[v]}
              </button>
            ))}
          </div>
        </div>
        <div className="stack">
          <div className="row between">
            <h3>Findings</h3>
            <button
              type="button"
              className="button small"
              disabled={saving || !editing.allowed}
              onClick={() => onEdit({ ...edit, findings: [...edit.findings, newFinding()] })}
            >
              Add finding
            </button>
          </div>
          {edit.findings.length === 0 && (
            <p className="muted small">
              No findings. Add one or leave the review as a body-only comment.
            </p>
          )}
          <div className="findings">
            {edit.findings.map((finding, index) => (
              <FindingEditor
                key={finding.id}
                finding={finding}
                index={index}
                disabled={saving || !editing.allowed}
                onChange={(next) =>
                  onEdit({
                    ...edit,
                    findings: edit.findings.map((f) => (f.id === finding.id ? next : f)),
                  })
                }
                onRemove={() =>
                  onEdit({ ...edit, findings: edit.findings.filter((f) => f.id !== finding.id) })
                }
              />
            ))}
          </div>
        </div>
      </div>
      <div className="savebar">
        <span className="status grow" data-dirty={dirty} aria-live="polite">
          {saving ? "Saving" : dirty ? "Unsaved edits" : "All changes saved"}
        </span>
        {dirty && !confirmDiscard && (
          <button
            type="button"
            className="button ghost small"
            disabled={saving}
            onClick={() => setConfirmDiscard(true)}
          >
            Discard
          </button>
        )}
        {confirmDiscard && (
          <>
            <span className="small" style={{ color: "var(--warn)" }}>
              Discard unsaved edits?
            </span>
            <button
              type="button"
              className="button ghost small"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep
            </button>
            <button type="button" className="button danger small" onClick={onDiscard}>
              Discard
            </button>
          </>
        )}
        <button
          type="button"
          className="button primary"
          disabled={!dirty || saving || !editing.allowed || (!edit.body.trim() && !included.length)}
          onClick={onSave}
          title="⌘S"
        >
          Save draft
        </button>
      </div>
    </section>
  );
}

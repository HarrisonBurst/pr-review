import { useState } from "react";
import type { CommentSide, Finding, Severity } from "../../../shared/contracts";
import { fileAnchor } from "../lib/diff";
import { jumpToDiff } from "../lib/jump";
import { Markdown } from "./Markdown";
import { AutoTextarea, Pill, Segmented } from "./ui";

export function FindingEditor({
  finding,
  index,
  onChange,
  onRemove,
  disabled,
}: {
  finding: Finding;
  index: number;
  onChange: (next: Finding) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const id = `finding-${finding.id}`;
  const [jumpError, setJumpError] = useState<string | null>(null);
  const set = <K extends keyof Finding>(key: K, value: Finding[K]) =>
    onChange({ ...finding, [key]: value });
  return (
    <div
      className="finding"
      role="group"
      data-included={finding.included}
      data-severity={finding.severity}
      aria-label={`Finding ${index + 1}`}
    >
      <div className="finding-head">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={finding.included}
            disabled={disabled}
            onChange={(e) => set("included", e.target.checked)}
          />
          Include
        </label>
        <Segmented<Severity>
          label={`Severity for finding ${index + 1}`}
          value={finding.severity}
          disabled={disabled}
          onChange={(severity) => set("severity", severity)}
          options={[
            { value: "blocking", label: "Blocking" },
            { value: "non_blocking", label: "Non-blocking" },
          ]}
        />
        <select
          className="select finding-origin"
          aria-label={`Origin for finding ${index + 1}`}
          value={finding.origin}
          disabled={disabled}
          onChange={(e) => set("origin", e.target.value as Finding["origin"])}
        >
          <option value="introduced">Introduced here</option>
          <option value="pre_existing">Pre-existing</option>
        </select>
        {finding.questionId && (
          <Pill tone="accent" plain>
            Suggested by Ask AI
          </Pill>
        )}
        <span className="grow" />
        <button
          type="button"
          className="button small ghost"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove finding ${index + 1}`}
        >
          Remove
        </button>
      </div>
      <div className="finding-body">
        <div className="finding-loc">
          <div className="field">
            <label htmlFor={`${id}-path`}>Path</label>
            <input
              id={`${id}-path`}
              className="input mono"
              placeholder="General comment (no path)"
              value={finding.path ?? ""}
              disabled={disabled}
              onChange={(e) => {
                setJumpError(null);
                set("path", e.target.value.trim() ? e.target.value : null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-start`}>From</label>
            <input
              id={`${id}-start`}
              className="input mono"
              type="number"
              min={1}
              placeholder="same"
              value={finding.startLine ?? ""}
              disabled={disabled || finding.line === null}
              onChange={(e) => {
                setJumpError(null);
                set(
                  "startLine",
                  e.target.value === "" ? null : Math.max(1, Number(e.target.value)),
                );
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-line`}>Line</label>
            <input
              id={`${id}-line`}
              className="input mono"
              type="number"
              min={1}
              value={finding.line ?? ""}
              disabled={disabled}
              onChange={(e) => {
                setJumpError(null);
                const line = e.target.value === "" ? null : Math.max(1, Number(e.target.value));
                onChange({
                  ...finding,
                  line,
                  startLine:
                    line === null || (finding.startLine !== null && finding.startLine >= line)
                      ? null
                      : finding.startLine,
                });
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-side`}>Side</label>
            <select
              id={`${id}-side`}
              className="select"
              value={finding.side}
              disabled={disabled || finding.line === null}
              onChange={(e) => {
                setJumpError(null);
                set("side", e.target.value as CommentSide);
              }}
            >
              <option value="RIGHT">New</option>
              <option value="LEFT">Old</option>
            </select>
          </div>
          <div className="field">
            <span className="field-label">Diff</span>
            {finding.path ? (
              <a
                className="button"
                href={`#${fileAnchor(finding.path)}`}
                onClick={(e) => {
                  e.preventDefault();
                  setJumpError(jumpToDiff(finding.path!, finding.line, finding.side));
                }}
              >
                Show in diff
              </a>
            ) : (
              <span className="field-note">Goes in the review body</span>
            )}
          </div>
        </div>
        {jumpError && (
          <p className="finding-jump-error" role="status">
            {jumpError}
          </p>
        )}
        <div className="field">
          <label htmlFor={`${id}-body`}>Comment</label>
          <AutoTextarea
            id={`${id}-body`}
            minRows={4}
            value={finding.body}
            disabled={disabled}
            onChange={(e) => set("body", e.target.value)}
          />
        </div>
        <div className="field">
          <span className="field-label" id={`${id}-evidence-label`}>
            Evidence <span className="field-hint">private, from the review, read-only</span>
          </span>
          <div
            className="context"
            role="note"
            aria-labelledby={`${id}-evidence-label`}
            data-testid="finding-evidence"
          >
            {finding.evidence.trim() ? (
              <Markdown source={finding.evidence} />
            ) : (
              <p className="context-empty">No evidence was recorded for this finding.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

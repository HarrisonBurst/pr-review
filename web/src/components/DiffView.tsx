import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Finding } from "../../../shared/contracts";
import { fileAnchor, parseDiff, type DiffFile, type DiffLine } from "../lib/diff";
import { rangeFromNativeSelection, rowRangeOf, type RowRange } from "../lib/selection";
import { Notice } from "./ui";

export interface DiffViewProps {
  diff: string;
  truncated: boolean;
  findings: Finding[];
  selection: RowRange | null;
  onSelect: (range: RowRange | null) => void;
  onReject?: (message: string) => void;
  panel?: ReactNode;
}

const numbered = (line: DiffLine) => line.newNo !== null || line.oldNo !== null;

export function DiffView({
  diff,
  truncated,
  findings,
  selection,
  onSelect,
  onReject,
  panel,
}: DiffViewProps) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const flagged = useMemo(() => {
    const keys = new Set<string>();
    for (const f of findings) {
      if (!f.included || !f.path || f.line === null) continue;
      for (let line = f.startLine ?? f.line; line <= f.line; line++)
        keys.add(`${f.path}:${f.side}:${line}`);
    }
    return keys;
  }, [findings]);
  const drag = useRef<{ path: string; from: number } | null>(null);
  const [focused, setFocused] = useState<{ path: string; row: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const end = () => {
      drag.current = null;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  const select = (path: string, row: number, extend: boolean) => {
    if (extend && selection && selection.path === path) onSelect({ ...selection, to: row });
    else onSelect({ path, from: row, to: row });
  };

  const fromNative = (target: EventTarget | null) => {
    if (target instanceof Element && target.closest(".ask-row")) return;
    const range = rangeFromNativeSelection(document.getSelection());
    if (range === "cross-file") {
      onReject?.("Select code within a single file to ask about it or comment on it.");
      return;
    }
    if (range) onSelect(range);
    else if (target instanceof Element && target.closest("td.c") && selection) onSelect(null);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && selection) {
      onSelect(null);
      return;
    }
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.type === "keyup") {
      const target = e.target as Element;
      if (target.closest("td.c") || !target.closest("button")) fromNative(e.target);
    }
  };

  if (!files.length) {
    return <p className="muted card-body">No diff available for this revision.</p>;
  }
  const { first, last } = selection ? rowRangeOf(selection) : { first: -1, last: -1 };
  return (
    <div className="diff" ref={root} onMouseUp={(e) => fromNative(e.target)} onKeyUp={onKey}>
      {truncated && (
        <div style={{ padding: 12 }}>
          <Notice tone="warn" title="Diff truncated.">
            The backend cut this diff short; open the PR on GitHub for the full change. Selections
            and comments are limited to the rows shown here.
          </Notice>
        </div>
      )}
      {files.map((file) => (
        <FileBlock
          key={file.path}
          file={file}
          open={files.length <= 6}
          flagged={flagged}
          selected={selection?.path === file.path ? { first, last } : null}
          panel={selection?.path === file.path ? panel : null}
          focusRow={focused?.path === file.path ? focused.row : null}
          onFocusRow={(row) => setFocused({ path: file.path, row })}
          onGutterDown={(row, extend) => {
            drag.current =
              extend && selection?.path === file.path ? null : { path: file.path, from: row };
            select(file.path, row, extend);
          }}
          onGutterEnter={(row) => {
            if (drag.current?.path === file.path)
              onSelect({ path: file.path, from: drag.current.from, to: row });
          }}
          onGutterKey={(row, extend) => select(file.path, row, extend)}
        />
      ))}
    </div>
  );
}

function FileBlock({
  file,
  open,
  flagged,
  selected,
  panel,
  focusRow,
  onFocusRow,
  onGutterDown,
  onGutterEnter,
  onGutterKey,
}: {
  file: DiffFile;
  open: boolean;
  flagged: Set<string>;
  selected: { first: number; last: number } | null;
  panel: ReactNode;
  focusRow: number | null;
  onFocusRow: (row: number) => void;
  onGutterDown: (row: number, extend: boolean) => void;
  onGutterEnter: (row: number) => void;
  onGutterKey: (row: number, extend: boolean) => void;
}) {
  const firstNumbered = file.lines.findIndex(numbered);
  const tabRow = focusRow ?? firstNumbered;
  const moveFocus = (row: number, direction: 1 | -1, extend: boolean) => {
    let next = row + direction;
    while (next >= 0 && next < file.lines.length && !numbered(file.lines[next]!)) next += direction;
    if (next < 0 || next >= file.lines.length) return;
    onFocusRow(next);
    if (extend) onGutterKey(next, true);
    document
      .getElementById(fileAnchor(file.path))
      ?.querySelector<HTMLButtonElement>(`tr[data-row="${next}"] button.ln`)
      ?.focus();
  };
  return (
    <details className="diff-file" id={fileAnchor(file.path)} data-path={file.path} open={open}>
      <summary>
        <span className="grow truncate">
          {file.path}
          {file.oldPath && <span className="faint"> (renamed from {file.oldPath})</span>}
        </span>
        <span className="diffstat">
          <span className="add">+{file.additions}</span>{" "}
          <span className="del">-{file.deletions}</span>
        </span>
      </summary>
      <table>
        <tbody>
          {file.lines.map((line, i) => {
            const isSelected = !!selected && i >= selected.first && i <= selected.last;
            const flag =
              (line.newNo !== null && flagged.has(`${file.path}:RIGHT:${line.newNo}`)) ||
              (line.oldNo !== null && flagged.has(`${file.path}:LEFT:${line.oldNo}`));
            const label =
              line.newNo !== null
                ? `line ${line.newNo}`
                : line.oldNo !== null
                  ? `old line ${line.oldNo}`
                  : null;
            const gutter = (value: number | null, primary: boolean) => (
              <td
                className="n"
                onMouseDown={
                  label
                    ? (e) => {
                        e.preventDefault();
                        onGutterDown(i, e.shiftKey);
                      }
                    : undefined
                }
                onMouseEnter={label ? () => onGutterEnter(i) : undefined}
              >
                {primary && label ? (
                  <button
                    type="button"
                    className="ln"
                    tabIndex={i === tabRow ? 0 : -1}
                    aria-label={`Select ${label} of ${file.path}`}
                    onFocus={() => onFocusRow(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onGutterKey(i, e.shiftKey);
                      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        moveFocus(i, e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
                      }
                    }}
                  >
                    {value ?? ""}
                  </button>
                ) : (
                  (value ?? "")
                )}
              </td>
            );
            return [
              <tr
                key={i}
                data-row={i}
                data-kind={line.kind}
                data-new={line.newNo ?? undefined}
                data-old={line.oldNo ?? undefined}
                data-flag={flag}
                data-selected={isSelected || undefined}
              >
                {gutter(line.oldNo, line.newNo === null && line.oldNo !== null)}
                {gutter(line.newNo, line.newNo !== null)}
                <td className="c">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  {line.text}
                </td>
              </tr>,
              selected && i === selected.last && panel ? (
                <tr key={`${i}-panel`} className="ask-row">
                  <td colSpan={3}>{panel}</td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </details>
  );
}

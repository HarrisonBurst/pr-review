import type { CommentSide, DiffSelection, LineRef, SelectionRange } from "./contracts.js";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  hunk: number;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let hunk = -1;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = {
        path: match?.[2] ?? raw.slice(11),
        oldPath: null,
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(file);
      oldLeft = newLeft = 0;
      hunk = -1;
      continue;
    }
    if (!file) continue;
    if (oldLeft === 0 && newLeft === 0) {
      if (raw.startsWith("rename from ")) file.oldPath = raw.slice(12);
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      oldNo = Number(m?.[1] ?? 1);
      oldLeft = Number(m?.[2] ?? 1);
      newNo = Number(m?.[3] ?? 1);
      newLeft = Number(m?.[4] ?? 1);
      hunk += 1;
      file.lines.push({ kind: "hunk", oldNo: null, newNo: null, text: raw, hunk });
      continue;
    }
    if (oldLeft === 0 && newLeft === 0) continue;
    if (raw.startsWith("+") && newLeft > 0) {
      file.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1), hunk });
      file.additions++;
      newLeft--;
    } else if (raw.startsWith("-") && oldLeft > 0) {
      file.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1), hunk });
      file.deletions++;
      oldLeft--;
    } else if (raw.startsWith("\\")) {
      file.lines.push({ kind: "ctx", oldNo: null, newNo: null, text: raw, hunk });
    } else if (raw.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
      file.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1), hunk });
      oldLeft--;
      newLeft--;
    } else {
      oldLeft = newLeft = 0;
    }
  }
  return files;
}

export const lineRef = (line: DiffLine): LineRef | null =>
  line.newNo !== null
    ? { side: "RIGHT", line: line.newNo }
    : line.oldNo !== null
      ? { side: "LEFT", line: line.oldNo }
      : null;

const sameRef = (a: LineRef, b: LineRef) => a.side === b.side && a.line === b.line;

export function findRow(file: DiffFile, ref: LineRef): number {
  return file.lines.findIndex((line) => {
    const current = lineRef(line);
    return !!current && sameRef(current, ref);
  });
}

const prefix = { add: "+", del: "-", ctx: " ", hunk: "" } as const;

export function selectionFromRows(
  file: DiffFile,
  from: number,
  to: number,
  shas: { baseSha: string; headSha: string },
): DiffSelection | null {
  const [first, last] = from <= to ? [from, to] : [to, from];
  const rows = file.lines.slice(first, last + 1).filter((line) => line.kind !== "hunk");
  if (!rows.length) return null;
  const numbered = (side: CommentSide) =>
    rows
      .map((line) => (side === "RIGHT" ? line.newNo : line.oldNo))
      .filter((value): value is number => value !== null);
  const hunks = new Set(rows.map((line) => line.hunk));
  const anchors: DiffSelection["anchors"] = {};
  const hasAdd = rows.some((line) => line.kind === "add");
  const hasDel = rows.some((line) => line.kind === "del");
  if (hunks.size === 1) {
    const right = numbered("RIGHT");
    const left = numbered("LEFT");
    if (right.length) anchors.RIGHT = { startLine: right[0]!, line: right[right.length - 1]! };
    if (left.length) anchors.LEFT = { startLine: left[0]!, line: left[left.length - 1]! };
  }
  const refs = rows.map(lineRef).filter((ref): ref is LineRef => ref !== null);
  const start = refs[0];
  const end = refs[refs.length - 1];
  if (!start || !end) return null;
  return {
    path: file.path,
    oldPath: file.oldPath,
    baseSha: shas.baseSha,
    headSha: shas.headSha,
    from: start,
    to: end,
    snippet: rows.map((line) => `${prefix[line.kind]}${line.text}`).join("\n"),
    kinds: { add: hasAdd, del: hasDel, ctx: rows.some((line) => line.kind === "ctx") },
    spansHunks: hunks.size > 1,
    anchors,
  };
}

export function resolveSelection(
  files: DiffFile[],
  range: SelectionRange,
): { selection: DiffSelection; file: DiffFile; from: number; to: number } | null {
  const file = files.find((item) => item.path === range.path);
  if (!file) return null;
  const from = findRow(file, range.from);
  const to = findRow(file, range.to);
  if (from < 0 || to < 0) return null;
  const selection = selectionFromRows(file, from, to, range);
  return selection ? { selection, file, from: Math.min(from, to), to: Math.max(from, to) } : null;
}

export function describeSelection(selection: DiffSelection): string {
  const side = (ref: LineRef) => (ref.side === "RIGHT" ? "new" : "old");
  const from = selection.from;
  const to = selection.to;
  if (sameRef(from, to)) return `${side(from)} line ${from.line}`;
  if (from.side === to.side) return `${side(from)} lines ${from.line}-${to.line}`;
  return `${side(from)} line ${from.line} to ${side(to)} line ${to.line}`;
}

export interface Anchor {
  side: CommentSide;
  startLine: number | null;
  line: number;
}

export function anchorFor(selection: DiffSelection, side: CommentSide): Anchor | null {
  const range = selection.anchors[side];
  if (!range) return null;
  return {
    side,
    startLine: range.startLine === range.line ? null : range.startLine,
    line: range.line,
  };
}

export function defaultAnchorSide(selection: DiffSelection): CommentSide | null {
  if (selection.anchors.RIGHT && (selection.kinds.add || selection.kinds.ctx || !selection.anchors.LEFT))
    return "RIGHT";
  return selection.anchors.LEFT ? "LEFT" : null;
}

export function anchorLabel(anchor: Anchor): string {
  const side = anchor.side === "RIGHT" ? "new side" : "old side";
  return anchor.startLine === null
    ? `${side} line ${anchor.line}`
    : `${side} lines ${anchor.startLine}-${anchor.line}`;
}

export function diffAnchors(files: DiffFile[]): Map<string, Map<string, number>> {
  const anchors = new Map<string, Map<string, number>>();
  for (const file of files) {
    const lines = new Map<string, number>();
    for (const line of file.lines) {
      if (line.newNo !== null) lines.set(`RIGHT:${line.newNo}`, line.hunk);
      if (line.oldNo !== null) lines.set(`LEFT:${line.oldNo}`, line.hunk);
    }
    anchors.set(file.path, lines);
  }
  return anchors;
}

export function anchorsInline(
  anchors: Map<string, Map<string, number>>,
  finding: { path: string | null; line: number | null; startLine: number | null; side: CommentSide },
): boolean {
  if (!finding.path || finding.line === null) return false;
  const lines = anchors.get(finding.path);
  if (!lines) return false;
  const hunk = lines.get(`${finding.side}:${finding.line}`);
  if (hunk === undefined) return false;
  if (finding.startLine === null) return true;
  if (finding.startLine >= finding.line) return false;
  return lines.get(`${finding.side}:${finding.startLine}`) === hunk;
}

export const fileAnchor = (path: string) => `diff-${path.replace(/[^\w.-]/g, "_")}`;

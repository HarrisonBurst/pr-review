import type { DiffSelection } from "../../../shared/contracts";
import { selectionFromRows, type DiffFile } from "./diff";

export interface RowRange {
  path: string;
  from: number;
  to: number;
}

export const rowRangeOf = (range: RowRange) => ({
  first: Math.min(range.from, range.to),
  last: Math.max(range.from, range.to),
});

export function rowFromNode(node: Node | null): { path: string; row: number } | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const tr = element?.closest<HTMLTableRowElement>("tr[data-row]");
  const file = tr?.closest<HTMLElement>(".diff-file");
  if (!tr || !file?.dataset.path) return null;
  return { path: file.dataset.path, row: Number(tr.dataset.row) };
}

export function rangeFromNativeSelection(
  selection: Selection | null,
): RowRange | "cross-file" | null {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const anchor = rowFromNode(selection.anchorNode);
  const focus = rowFromNode(selection.focusNode);
  if (!anchor || !focus) return null;
  if (anchor.path !== focus.path) return "cross-file";
  return { path: anchor.path, from: anchor.row, to: focus.row };
}

export function resolveRowRange(
  files: DiffFile[],
  range: RowRange,
  shas: { baseSha: string; headSha: string },
): DiffSelection | null {
  const file = files.find((f) => f.path === range.path);
  if (!file) return null;
  const { first, last } = rowRangeOf(range);
  return selectionFromRows(file, first, last, shas);
}

import type { CommentSide } from "../../../shared/contracts";
import { fileAnchor } from "./diff";

export function jumpToDiff(
  path: string,
  line: number | null,
  side: CommentSide = "RIGHT",
): string | null {
  const file = document.getElementById(fileAnchor(path)) as HTMLDetailsElement | null;
  if (!file) return `${path} is not in this diff.`;
  const attr = side === "LEFT" ? "data-old" : "data-new";
  const target = line === null ? null : file.querySelector<HTMLElement>(`tr[${attr}="${line}"]`);
  if (line !== null && !target)
    return `${side === "LEFT" ? "Old line" : "Line"} ${line} of ${path} is not in this diff.`;
  file.open = true;
  const el = target ?? file;
  el.scrollIntoView({ behavior: "smooth", block: target ? "center" : "start" });
  if (target) {
    target.classList.remove("target");
    void target.offsetWidth;
    target.classList.add("target");
  } else file.querySelector("summary")?.focus();
  return null;
}

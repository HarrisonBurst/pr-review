import { describe, expect, it } from "vitest";
import { diff } from "../mock/fixtures";
import {
  anchorFor,
  anchorLabel,
  anchorsInline,
  defaultAnchorSide,
  describeSelection,
  diffAnchors,
  parseDiff,
  resolveSelection,
  selectionFromRows,
} from "./diff";

const shas = { baseSha: "base", headSha: "head" };

describe("parseDiff", () => {
  it("splits files and numbers lines", () => {
    const files = parseDiff(diff);
    expect(files.map((f) => f.path)).toEqual([
      "src/billing/invoice.ts",
      "src/billing/invoice.test.ts",
    ]);
    const first = files[0]!;
    expect(first.additions).toBe(10);
    expect(first.deletions).toBe(1);
    const applyLine = first.lines.find((l) =>
      l.text.includes("applyDiscount(lineItems, discount)"),
    );
    expect(applyLine).toMatchObject({ kind: "add", oldNo: null, newNo: 38, hunk: 0 });
    const ctx = first.lines.find((l) => l.text.includes("const subtotal"));
    expect(ctx).toMatchObject({ kind: "ctx", oldNo: 36, newNo: 36 });
  });

  it("ends each hunk at its declared counts", () => {
    const files = parseDiff(diff);
    const last = files[1]!.lines.at(-1)!;
    expect(last).toMatchObject({ kind: "ctx", text: "});", newNo: 7 });
    const [before, inserted, after] = parseDiff(
      "diff --git a/x b/x\n+++ b/x\n@@ -3,2 +3,3 @@\n ctx\n+++plus\n tail\ndiff --git a/y b/y\n",
    )[0]!.lines.slice(1);
    expect([before, inserted, after]).toMatchObject([
      { kind: "ctx", newNo: 3 },
      { kind: "add", newNo: 4, text: "++plus" },
      { kind: "ctx", newNo: 5 },
    ]);
  });

  it("records renames and keeps a pure rename without rows", () => {
    const files = parseDiff(
      "diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\ndiff --git a/a b/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n",
    );
    expect(files[0]).toMatchObject({ path: "new.md", oldPath: "old.md", lines: [] });
    expect(files[1]!.oldPath).toBeNull();
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("selections", () => {
  const file = parseDiff(diff)[0]!;
  const row = (predicate: (text: string, kind: string) => boolean) =>
    file.lines.findIndex((l) => predicate(l.text, l.kind));

  it("derives side, range, snippet, and both anchor projections from rows", () => {
    const from = row((t) => t.includes("return { subtotal, total: subtotal * rate }"));
    const to = row((t) => t.includes("applyDiscount(lineItems, discount)"));
    const selection = selectionFromRows(file, to, from, shas)!;
    expect(selection).toMatchObject({
      path: "src/billing/invoice.ts",
      oldPath: null,
      baseSha: "base",
      headSha: "head",
      from: { side: "LEFT", line: 37 },
      to: { side: "RIGHT", line: 38 },
      kinds: { add: true, del: true, ctx: false },
      spansHunks: false,
      anchors: { RIGHT: { startLine: 37, line: 38 }, LEFT: { startLine: 37, line: 37 } },
    });
    expect(selection.snippet).toBe(
      "-  return { subtotal, total: subtotal * rate };\n+  const discount = discountFor(subtotal);\n+  applyDiscount(lineItems, discount);",
    );
    expect(describeSelection(selection)).toBe("old line 37 to new line 38");
    expect(defaultAnchorSide(selection)).toBe("RIGHT");
    expect(anchorFor(selection, "RIGHT")).toEqual({ side: "RIGHT", startLine: 37, line: 38 });
    expect(anchorFor(selection, "LEFT")).toEqual({ side: "LEFT", startLine: null, line: 37 });
    expect(anchorLabel(anchorFor(selection, "RIGHT")!)).toBe("new side lines 37-38");
  });

  it("prefers the old side for removed-only rows and offers no anchor across hunks", () => {
    const del = row((_t, kind) => kind === "del");
    const only = selectionFromRows(file, del, del, shas)!;
    expect(only.anchors).toEqual({ LEFT: { startLine: 37, line: 37 } });
    expect(defaultAnchorSide(only)).toBe("LEFT");
    expect(describeSelection(only)).toBe("old line 37");
    const twoHunks = parseDiff(
      "diff --git a/a b/a\n+++ b/a\n@@ -1 +1 @@\n+x\n@@ -5 +5 @@\n+y\n",
    )[0]!;
    const spanning = selectionFromRows(twoHunks, 1, 3, shas)!;
    expect(spanning).toMatchObject({ spansHunks: true, anchors: {} });
    expect(spanning.snippet).toBe("+x\n+y");
    expect(defaultAnchorSide(spanning)).toBeNull();
    expect(selectionFromRows(twoHunks, 0, 0, shas)).toBeNull();
  });

  it("resolves line refs against the same diff and rejects unknown ones", () => {
    const resolved = resolveSelection(parseDiff(diff), {
      path: "src/billing/invoice.ts",
      from: { side: "RIGHT", line: 43 },
      to: { side: "RIGHT", line: 45 },
      ...shas,
    })!;
    expect(resolved.selection.snippet.split("\n")).toHaveLength(3);
    expect(resolved.to - resolved.from).toBe(2);
    expect(
      resolveSelection(parseDiff(diff), {
        path: "src/billing/invoice.ts",
        from: { side: "LEFT", line: 38 },
        to: { side: "RIGHT", line: 45 },
        ...shas,
      }),
    ).toBeNull();
    expect(
      resolveSelection(parseDiff(diff), {
        path: "nope.ts",
        from: { side: "RIGHT", line: 1 },
        to: { side: "RIGHT", line: 1 },
        ...shas,
      }),
    ).toBeNull();
  });

  it("anchors inline only within one hunk on the named side", () => {
    const anchors = diffAnchors(parseDiff(diff));
    const base = { path: "src/billing/invoice.ts", side: "RIGHT" as const };
    expect(anchorsInline(anchors, { ...base, startLine: 38, line: 40 })).toBe(true);
    expect(anchorsInline(anchors, { ...base, startLine: null, line: 36 })).toBe(true);
    expect(anchorsInline(anchors, { ...base, side: "LEFT", startLine: null, line: 37 })).toBe(true);
    expect(anchorsInline(anchors, { ...base, side: "LEFT", startLine: null, line: 60 })).toBe(
      false,
    );
    expect(anchorsInline(anchors, { ...base, startLine: null, line: 58 })).toBe(false);
    expect(anchorsInline(anchors, { ...base, startLine: 40, line: 40 })).toBe(false);
    expect(anchorsInline(anchors, { path: null, side: "RIGHT", startLine: null, line: 1 })).toBe(
      false,
    );
  });
});

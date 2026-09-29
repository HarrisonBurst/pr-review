import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { installMockApi, MockBackend } from "./mock/mockApi";

let backend: MockBackend;
let uninstall: () => void;

function mount(options?: ConstructorParameters<typeof MockBackend>[0]) {
  backend = new MockBackend({ reviewDelayMs: 0, ...options });
  uninstall = installMockApi(backend);
  render(<App mock />);
  return userEvent.setup();
}

const gutter = (label: string, file = "src/billing/invoice.ts") =>
  screen.getByRole("button", { name: `Select ${label} of ${file}` });
const panel = () => screen.getByRole("region", { name: "Selected code actions" });
const provenance = () => panel().querySelector(".ask-prov")!.textContent;
const selectedRows = () =>
  Array.from(document.querySelectorAll("tr[data-selected]")).map(
    (row) => (row as HTMLElement).dataset.new ?? `old ${(row as HTMLElement).dataset.old}`,
  );

async function shiftClick(user: ReturnType<typeof userEvent.setup>, element: HTMLElement) {
  await user.keyboard("{Shift>}");
  await user.click(element);
  await user.keyboard("{/Shift}");
}

function nativeSelect(fromLine: string, toLine: string, toFile = "src/billing/invoice.ts") {
  const from = document.querySelector(`tr[data-new="${fromLine}"] td.c`)!.lastChild!;
  const to = document
    .getElementById(`diff-${toFile.replace(/[^\w.-]/g, "_")}`)!
    .querySelector(`tr[data-new="${toLine}"] td.c`)!.lastChild!;
  document.getSelection()!.setBaseAndExtent(from, 1, to, 2);
  fireEvent.mouseUp(document.querySelector(".diff")!);
}

beforeEach(() => {
  window.location.hash = "#/pr/pr-482";
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  uninstall();
});

describe("diff selection", () => {
  it("selects by gutter click, extends with shift-click, and shows exact provenance", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.click(gutter("line 38"));
    expect(selectedRows()).toEqual(["38"]);
    expect(provenance()).toBe("src/billing/invoice.ts · new line 38 · 3f1c2a1..9b8d7e2");
    await shiftClick(user, gutter("line 40"));
    expect(selectedRows()).toEqual(["38", "39", "40"]);
    expect(provenance()).toContain("new lines 38-40");
    expect(within(panel()).getByRole("button", { name: "Explain" })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: "Add comment" })).toBeInTheDocument();
    const row = document.querySelector('tr[data-new="40"]')!;
    expect(row.nextElementSibling).toHaveClass("ask-row");
    await user.click(within(panel()).getByRole("button", { name: "Clear selection" }));
    expect(selectedRows()).toEqual([]);
    expect(screen.queryByRole("region", { name: "Selected code actions" })).toBeNull();
  });

  it("resolves a native text selection to rows and rejects cross-file selections", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await screen.findByRole("heading", { name: "Diff" });
    expect(document.querySelectorAll("tr[data-new]").length).toBeGreaterThan(10);
    nativeSelect("43", "45");
    await waitFor(() => expect(selectedRows()).toEqual(["43", "44", "45"]));
    expect(provenance()).toContain("new lines 43-45");
    nativeSelect("43", "5", "src/billing/invoice.test.ts");
    expect(
      await screen.findByText("Select code within a single file to ask about it or comment on it."),
    ).toBeInTheDocument();
    expect(selectedRows()).toEqual(["43", "44", "45"]);
    within(panel()).getByRole("button", { name: "Clear selection" }).focus();
    await user.keyboard("{Escape}");
    expect(selectedRows()).toEqual([]);
  });

  it("supports keyboard selection with the gutter and reaches the panel by Tab", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    gutter("line 36").focus();
    await user.keyboard("{Enter}");
    expect(selectedRows()).toEqual(["36"]);
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(selectedRows()).toEqual(["36", "old 37", "37"]);
    expect(provenance()).toContain("new lines 36-37");
    await user.tab();
    expect(document.activeElement).toBe(
      within(panel()).getByRole("button", { name: "Clear selection" }),
    );
  });
});

describe("manual comments", () => {
  it("adds a multi-line new-side comment to the open draft without saving and previews it once", async () => {
    const user = mount();
    const body = (await screen.findByLabelText(/GitHub review body/)) as HTMLTextAreaElement;
    await user.type(body, " Keep this edit.");
    await user.click(gutter("line 38"));
    await shiftClick(user, gutter("line 40"));
    await user.click(within(panel()).getByRole("button", { name: "Add comment" }));
    const composer = screen.getByRole("form", { name: "Comment composer" });
    expect(within(composer).getByLabelText("Attach to")).toHaveValue("RIGHT");
    expect(within(composer).getByRole("option", { name: "new side lines 38-40" })).toBeDefined();
    expect(within(composer).queryByRole("option", { name: /old side/ })).toBeNull();
    await user.type(within(composer).getByLabelText(/^Comment/), "Round after the rate.");
    await user.click(within(composer).getByRole("button", { name: "Add to draft" }));
    const finding = await screen.findByRole("group", { name: "Finding 4" });
    expect(within(finding).getByLabelText("Path")).toHaveValue("src/billing/invoice.ts");
    expect(within(finding).getByLabelText("From")).toHaveValue(38);
    expect(within(finding).getByLabelText("Line")).toHaveValue(40);
    expect(within(finding).getByLabelText("Side")).toHaveValue("RIGHT");
    expect(within(finding).getByLabelText("Comment")).toHaveValue("Round after the rate.");
    expect(within(finding).queryByText("Suggested by Ask AI")).toBeNull();
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    expect(body.value).toContain("Keep this edit.");
    expect(backend.detail("pr-482").draft!.findings).toHaveLength(3);
    expect(selectedRows()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    const saved = backend.detail("pr-482").draft!.findings.at(-1)!;
    expect(saved).toMatchObject({ startLine: 38, line: 40, side: "RIGHT", evidence: "" });
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    const summary = await within(dialog).findByTestId("preview-summary");
    expect(summary).toHaveTextContent("2 inline");
    expect(summary).toHaveTextContent("1 in body");
    expect(within(dialog).getByText("src/billing/invoice.ts:38-40")).toBeInTheDocument();
    expect(within(dialog).getByText(/new side, multi-line/)).toBeInTheDocument();
    const payload = JSON.parse(within(dialog).getByTestId("payload-body").textContent!) as {
      comments: unknown[];
      body: string;
    };
    expect(payload.comments).toContainEqual({
      path: "src/billing/invoice.ts",
      line: 40,
      side: "RIGHT",
      start_line: 38,
      start_side: "RIGHT",
      body: "**Non-blocking.** Round after the rate.",
    });
    expect(payload.body).not.toContain("Round after the rate.");
  });

  it("anchors removed lines to the old side and lets mixed ranges pick a side", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.click(gutter("old line 37"));
    expect(provenance()).toContain("old line 37");
    await user.click(within(panel()).getByRole("button", { name: "Add comment" }));
    let composer = screen.getByRole("form", { name: "Comment composer" });
    expect(within(composer).getByLabelText("Attach to")).toHaveValue("LEFT");
    expect(within(composer).getByRole("option", { name: "old side line 37" })).toBeDefined();
    await user.type(within(composer).getByLabelText(/^Comment/), "Why drop the plain total?");
    await user.click(within(composer).getByRole("button", { name: "Add to draft" }));
    const finding = await screen.findByRole("group", { name: "Finding 4" });
    expect(within(finding).getByLabelText("Side")).toHaveValue("LEFT");
    expect(within(finding).getByLabelText("Line")).toHaveValue(37);
    expect(document.querySelector('tr[data-old="37"]')).toHaveAttribute("data-flag", "true");

    await user.click(gutter("old line 37"));
    await shiftClick(user, gutter("line 38"));
    await user.click(within(panel()).getByRole("button", { name: "Add comment" }));
    composer = screen.getByRole("form", { name: "Comment composer" });
    expect(within(composer).getByText(/mixes removed and added lines/)).toBeInTheDocument();
    expect(within(composer).getByLabelText("Attach to")).toHaveValue("RIGHT");
    expect(within(composer).getByRole("option", { name: "new side lines 37-38" })).toBeDefined();
    expect(within(composer).getByRole("option", { name: "old side line 37" })).toBeDefined();
    await user.selectOptions(within(composer).getByLabelText("Attach to"), "body");
    await user.type(within(composer).getByLabelText(/^Comment/), "General note.");
    await user.click(within(composer).getByRole("button", { name: "Add to draft" }));
    const general = await screen.findByRole("group", { name: "Finding 5" });
    expect(within(general).getByLabelText("Path")).toHaveValue("src/billing/invoice.ts");
    expect(within(general).getByLabelText("Line")).toHaveValue(null);
  });

  it("creates a local draft for a PR without any review and keeps provenance truthful", async () => {
    window.location.hash = "#/pr/pr-490";
    const user = mount();
    await screen.findByRole("heading", { name: "No draft yet" });
    await user.click(gutter("line 44"));
    expect(within(panel()).getByText(/No draft is open yet/)).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Add comment" }));
    const composer = screen.getByRole("form", { name: "Comment composer" });
    await user.type(within(composer).getByLabelText(/^Comment/), "Name the share.");
    await user.click(within(composer).getByRole("button", { name: "Create local draft and add" }));
    const finding = await screen.findByRole("group", { name: "Finding 1" });
    expect(within(finding).getByLabelText("Line")).toHaveValue(44);
    expect(screen.getByLabelText("Review draft")).toHaveValue(backend.detail("pr-490").draft!.id);
    expect(screen.getByText("Local draft, no AI review")).toBeInTheDocument();
    expect(screen.getByText(/local draft with no AI review behind it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review now" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI revision" })).toBeNull();
    expect(backend.detail("pr-490").draft).toMatchObject({ runId: null, findings: [] });
    expect(backend.detail("pr-490").pr.lastReviewedAt).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    expect(backend.detail("pr-490").draft!.findings).toHaveLength(1);
    expect(screen.getByLabelText("Review draft")).toHaveDisplayValue(/Local draft · 9b8d7e2 · v2/);
  });

  it("defaults to a newer review over an older local draft and keeps that draft open while editing", async () => {
    window.location.hash = "#/pr/pr-490";
    const newHead = "feedface00000000000000000000000000000002";
    const user = mount();
    await user.click(await screen.findByRole("button", { name: "Start a local draft" }));
    const body = await screen.findByLabelText(/GitHub review body/);
    const local = backend.detail("pr-490").draft!;
    expect(local.runId).toBeNull();
    await user.type(body, "Local notes.");
    backend.options.remoteHead = { "pr-490": newHead };
    await user.click(screen.getByRole("button", { name: "Review now" }));
    await waitFor(() => expect(backend.detail("pr-490").drafts).toHaveLength(2));
    const after = backend.detail("pr-490");
    expect(after.drafts.map((d) => [d.runId === null, d.headSha])).toEqual([
      [false, newHead],
      [true, "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d"],
    ]);
    expect(after.pr.status).toBe("ready");
    expect(screen.getByLabelText("Review draft")).toHaveValue(local.id);
    expect(screen.getByLabelText(/GitHub review body/)).toHaveValue("Local notes.");
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    expect(await screen.findByText("A newer review draft is available.")).toBeInTheDocument();
    expect(screen.getByLabelText("Review draft")).toHaveDisplayValue(
      /Local draft · 9b8d7e2 · v1 · older draft · outdated commit/,
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Open latest draft" }));
    confirm.mockRestore();
    expect(screen.getByLabelText("Review draft")).toHaveValue(after.draft!.id);
    expect(screen.getByLabelText("Review draft")).toHaveDisplayValue(
      /Review 1 · feedfac · v1 · latest/,
    );
    expect(screen.queryByText("Local draft, no AI review")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    expect(
      within(screen.getByRole("region", { name: "Status" })).getByText("Ready"),
    ).toBeInTheDocument();
    expect(backend.detail("pr-490").drafts[1]).toMatchObject({
      id: local.id,
      version: 1,
      body: "",
    });

    window.location.hash = "#/";
    const list = await screen.findByRole("list", { name: "Requested of your teams" });
    await waitFor(() =>
      expect(
        within(list).getByText("Add rate limit headers to public API").closest("[role=listitem]"),
      ).toHaveTextContent(/Ready/),
    );
  });

  it("offers an explicit local draft from the empty state", async () => {
    window.location.hash = "#/pr/pr-490";
    const user = mount();
    await user.click(await screen.findByRole("button", { name: "Start a local draft" }));
    expect(await screen.findByText("Local draft, no AI review")).toBeInTheDocument();
    expect(backend.detail("pr-490").drafts).toHaveLength(1);
  });

  it("never attaches a current-head comment to an outdated draft and explains the mismatch", async () => {
    window.location.hash = "#/pr/pr-475";
    const user = mount();
    const body = await screen.findByLabelText(/GitHub review body/);
    await user.type(body, " edited");
    await user.click(gutter("line 38"));
    await user.click(within(panel()).getByRole("button", { name: "Add comment" }));
    const composer = screen.getByRole("form", { name: "Comment composer" });
    await user.type(within(composer).getByLabelText(/^Comment/), "Note.");
    expect(within(composer).getByText(/Save or discard your unsaved edits/)).toBeInTheDocument();
    expect(
      within(composer).getByRole("button", { name: "Create local draft and add" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(screen.getAllByRole("button", { name: "Discard" }).at(-1)!);
    const button = await screen.findByRole("button", { name: "Create local draft and add" });
    expect(button).toBeEnabled();
    await user.click(button);
    await screen.findByText("Local draft, no AI review");
    const drafts = backend.detail("pr-475").drafts;
    expect(drafts.map((d) => [d.runId, d.headSha.slice(0, 7)])).toEqual([
      [null, "c0ffee1"],
      ["run-4", "deadbee"],
    ]);
    expect(drafts[1]!.body).toBe("Migration is sound; one suggestion on index naming.");
    expect(
      within(screen.getByRole("group", { name: "Finding 1" })).getByLabelText("Comment"),
    ).toHaveValue("Note.");
  });
});

describe("ask AI", () => {
  it("explains, follows up with prior turns, cites lines, and drafts a comment with private evidence", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.click(gutter("line 38"));
    await user.type(within(panel()).getByLabelText("Optional question for Ask AI"), "why?");
    await user.click(within(panel()).getByRole("button", { name: "Explain" }));
    const thread = await screen.findByTestId("ask-thread");
    expect(within(thread).getByText("why?")).toBeInTheDocument();
    const answer = await within(thread).findByTestId("ask-answer");
    expect(answer).toHaveTextContent(/Explains src\/billing\/invoice.ts:38 for "why\?"/);
    expect(backend.questions["pr-482"]![0]).toMatchObject({
      mode: "explain",
      draftId: "draft-482",
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      selection: { from: { side: "RIGHT", line: 38 }, to: { side: "RIGHT", line: 38 } },
    });
    const scrolls: string[] = [];
    Element.prototype.scrollIntoView = function () {
      scrolls.push((this as HTMLElement).getAttribute("data-new") ?? "");
    };
    await user.click(within(answer).getByRole("button", { name: "src/billing/invoice.test.ts:5" }));
    expect(scrolls).toEqual(["5"]);
    await user.click(
      within(thread).getByRole("button", {
        name: "What happens when the discount exceeds the subtotal?",
      }),
    );
    await user.click(within(thread).getByRole("button", { name: "Investigate follow-up" }));
    await waitFor(() => expect(within(thread).getAllByTestId("ask-answer")).toHaveLength(2));
    expect(backend.questions["pr-482"]![1]).toMatchObject({
      mode: "investigate",
      parentId: backend.questions["pr-482"]![0]!.id,
      question: "What happens when the discount exceeds the subtotal?",
    });
    await user.click(within(thread).getByRole("button", { name: "Draft comment" }));
    const suggestion = await screen.findByTestId("ask-suggestion");
    expect(suggestion).toHaveTextContent("mutates the caller's line items");
    expect(suggestion).toHaveTextContent("Private evidence (never posted)");
    await user.click(within(suggestion).getByRole("button", { name: "Edit and add to draft" }));
    const composer = screen.getByRole("form", { name: "Comment composer" });
    const comment = within(composer).getByLabelText(/^Comment/);
    expect((comment as HTMLTextAreaElement).value).toContain("mutates the caller's line items");
    expect(within(composer).getByRole("note")).toHaveTextContent(/Checked/);
    await user.type(comment, " Edited by me.");
    await user.click(within(composer).getByRole("button", { name: "Add to draft" }));
    const finding = await screen.findByRole("group", { name: "Finding 4" });
    expect(within(finding).getByText("Suggested by Ask AI")).toBeInTheDocument();
    const edited = (within(finding).getByLabelText("Comment") as HTMLTextAreaElement).value;
    expect(edited).toContain("Edited by me.");
    expect(within(finding).getByTestId("finding-evidence")).toHaveTextContent(/Checked/);
    expect(edited).not.toContain("Checked");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    const saved = backend.detail("pr-482").draft!.findings.at(-1)!;
    expect(saved.questionId).toBe(backend.questions["pr-482"]![2]!.id);
    expect(saved.evidence).toMatch(/Checked/);
    expect(saved.body).not.toMatch(/Checked/);
    expect(screen.getByRole("heading", { name: "Questions" })).toBeInTheDocument();
  });

  it("shows pending, cancels only the question, and retries after a failure", async () => {
    const user = mount({ question: "hang" });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(gutter("line 38"));
    await user.click(within(panel()).getByRole("button", { name: "Investigate" }));
    const thread = await screen.findByTestId("ask-thread");
    expect(await within(thread).findByText("Thinking")).toBeInTheDocument();
    expect(within(thread).getByRole("button", { name: "Investigate" })).toBeDisabled();
    expect(within(thread).getByRole("button", { name: "Add comment" })).toBeEnabled();
    await user.click(within(thread).getByRole("button", { name: "Cancel" }));
    expect(await within(thread).findByText("Cancelled")).toBeInTheDocument();
    expect(within(thread).getByText("Cancelled by the reviewer")).toBeInTheDocument();
    expect(backend.detail("pr-482").runs.every((r) => r.status === "completed")).toBe(true);
    backend.options.question = "fail";
    await user.click(within(thread).getByRole("button", { name: "Retry" }));
    expect(await within(thread).findByRole("alert")).toHaveTextContent(/mock failure/);
    backend.options.question = undefined;
    await user.click(within(thread).getByRole("button", { name: "Retry" }));
    expect(await within(thread).findByTestId("ask-answer")).toHaveTextContent(/Investigated/);
  });

  it("keeps the open editor and its edits when a review completes mid-answer", async () => {
    const user = mount({ question: "hang" });
    const body = (await screen.findByLabelText(/GitHub review body/)) as HTMLTextAreaElement;
    await user.type(body, " pending edit");
    await user.click(gutter("line 38"));
    await user.click(within(panel()).getByRole("button", { name: "Explain" }));
    await within(screen.getByTestId("ask-thread")).findByText("Thinking");
    backend.review("pr-482");
    expect(await screen.findByText("A newer review draft is available.")).toBeInTheDocument();
    expect(body.value).toContain("pending edit");
    expect(screen.getByLabelText("Review draft")).toHaveValue("draft-482");
    expect(screen.getByTestId("ask-thread")).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "Add comment" }));
    const composer = screen.getByRole("form", { name: "Comment composer" });
    expect(within(composer).getByRole("button", { name: "Add to draft" })).toBeInTheDocument();
    await user.type(within(composer).getByLabelText(/^Comment/), "Still mine.");
    await user.click(within(composer).getByRole("button", { name: "Add to draft" }));
    await screen.findByRole("group", { name: "Finding 4" });
    expect(screen.getByLabelText("Review draft")).toHaveValue("draft-482");
    expect(backend.detail("pr-482").drafts[0]!.findings).toHaveLength(1);
  });

  it("clears a selection when the head moves and keeps the thread in the Questions card", async () => {
    const user = mount({
      remoteHead: { "pr-482": "abc1234abc1234abc1234abc1234abc1234abc12" },
      freshness: "stale",
    });
    await screen.findByLabelText(/GitHub review body/);
    await waitFor(() => expect(backend.checkCalls).toBeGreaterThan(0));
    await screen.findByText("The latest review is stale.");
    await user.click(gutter("line 38"));
    expect(provenance()).toContain("abc1234");
    await user.click(within(panel()).getByRole("button", { name: "Explain" }));
    await screen.findByTestId("ask-answer");
    await user.click(within(panel()).getByRole("button", { name: "Add comment" }));
    const composer = screen.getByRole("form", { name: "Comment composer" });
    expect(within(composer).getByText(/Create local draft and add/)).toBeInTheDocument();
    backend.options.remoteHead = { "pr-482": "def5678def5678def5678def5678def5678def56" };
    await user.click(screen.getByRole("button", { name: /Check now|Retry check/ }));
    expect(await screen.findByText(/selection made on abc1234 was cleared/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Selected code actions" })).toBeNull();
    const card = screen.getByRole("heading", { name: "Questions" }).closest("section")!;
    expect(within(card).getByText("older commit")).toBeInTheDocument();
    await user.click(card.querySelector("summary")!);
    expect(within(card).getByRole("button", { name: "Show in diff" })).toBeDisabled();
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PullRequest } from "../../shared/contracts";
import { App } from "./App";
import { installMockApi, MockBackend } from "./mock/mockApi";

let uninstall: () => void;
beforeEach(() => {
  window.location.hash = "#/";
});
afterEach(() => uninstall());

for (const [kind, approvalTitle] of [
  ["current", "Approved by you"],
  ["earlier", "Approved by you at an earlier revision"],
] as const)
  it(`shows ${kind} viewer approval alongside status in inbox and detail without changing navigation or drafts`, async () => {
    const backend = new MockBackend({ reviewDelayMs: 0 });
    const pr = backend.prs.find((item) => item.id === "pr-482")!;
    pr.viewerApproval = {
      viewerLogin: "demo-user",
      headSha: pr.headSha,
      commitSha: kind === "current" ? pr.headSha : "earlier-head",
    };
    const originalDraft = structuredClone(backend.drafts[pr.id]);
    uninstall = installMockApi(backend);
    const user = userEvent.setup();
    render(<App mock />);
    const title = await screen.findByText(pr.title);
    const row = within(title.closest(".pr-row") as HTMLElement);
    const approval = row.getByText("Approved by you");
    expect(approval).toHaveAttribute("data-tone", "ok");
    expect(approval).toHaveTextContent(/^Approved by you$/);
    expect(approval.parentElement).toHaveAttribute("title", approvalTitle);
    expect(approval.parentElement).toHaveAccessibleDescription(approvalTitle);
    const marker = row.queryByText("Earlier approval");
    if (kind === "earlier") {
      expect(marker).toHaveTextContent(/^Earlier approval$/);
      expect(marker).toHaveAttribute("data-tone", "warn");
      expect(marker).toBe(approval.nextElementSibling);
    } else expect(marker).not.toBeInTheDocument();
    expect([...approval.closest(".right")!.querySelectorAll(".pill")].at(-1)).toBe(
      marker ?? approval,
    );
    expect(row.getByText("Ready")).toBeInTheDocument();
    expect(row.queryByText("Outdated")).not.toBeInTheDocument();
    expect(row.getByText(/Merge:|Mergeable/)).toBeInTheDocument();
    expect(row.queryByRole("button", { name: /^Re-review/ })).not.toBeInTheDocument();
    expect(title.closest("a")).toHaveAttribute("href", "#/pr/pr-482");
    await user.click(title);
    await screen.findByRole("region", { name: "Draft review" });
    const detailApproval = screen.getByText("Approved by you");
    expect(detailApproval).toHaveAttribute("data-tone", "ok");
    expect(detailApproval).toHaveTextContent(/^Approved by you$/);
    expect(detailApproval.parentElement).toHaveAttribute("title", approvalTitle);
    expect(detailApproval.parentElement).toHaveAccessibleDescription(approvalTitle);
    const detailMarker = screen.queryByText("Earlier approval");
    if (kind === "earlier") {
      expect(detailMarker).toHaveTextContent(/^Earlier approval$/);
      expect(detailMarker).toHaveAttribute("data-tone", "warn");
      expect(detailMarker).toBe(detailApproval.nextElementSibling);
    } else expect(detailMarker).not.toBeInTheDocument();
    expect([...detailApproval.closest(".pr-title")!.querySelectorAll(".pill")].at(-1)).toBe(
      detailMarker ?? detailApproval,
    );
    expect(screen.queryByText("Outdated")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    expect(backend.drafts[pr.id]).toEqual(originalDraft);
    expect(backend.submissions[pr.id] ?? []).toHaveLength(0);
  });

for (const [status, copy] of [
  ["submitted", "Submitted"],
  ["outdated", "Outdated"],
] as const)
  for (const [autoStatus, autoCopy] of [
    ["uncertain", "Automatic write uncertain"],
    ["failed", "Auto-submit failed: publication"],
  ] as const)
    it(`keeps approval last after ${status}, human and ${autoStatus}, with unavailable only in detail`, async () => {
      const backend = new MockBackend({ reviewDelayMs: 0, autoSubmission: "human" });
      const pr = backend.prs.find((item) => item.id === "pr-482")!;
      pr.status = status;
      pr.viewerApproval = {
        viewerLogin: "demo-user",
        headSha: pr.headSha,
        commitSha: "earlier-head",
      };
      pr.autoSubmission!.status = autoStatus;
      pr.autoSubmission!.detection!.status = "unavailable";
      const original = structuredClone(pr.autoSubmission);
      uninstall = installMockApi(backend);
      const user = userEvent.setup();
      render(<App mock />);
      const title = await screen.findByText(pr.title);
      const row = title.closest(".pr-row")!;
      const badges = [copy, "✋ Human requested", autoCopy];
      expect([...row.querySelectorAll(".right .pill")].map((pill) => pill.textContent)).toEqual([
        ...badges,
        "Approved by you",
        "Earlier approval",
      ]);
      await user.click(title);
      await screen.findByRole("region", { name: "Draft review" });
      const header = screen
        .getByRole("heading", { name: new RegExp(pr.title) })
        .closest(".pr-title")!;
      const pills = [...header.querySelectorAll(".pill")];
      expect(pills.slice(0, 4).map((pill) => pill.textContent)).toEqual([
        ...badges,
        "Human-request detection unavailable",
      ]);
      expect(pills[4]).toHaveTextContent(/^Review requested /);
      expect(pills[5]).toHaveTextContent(/^Approved by you$/);
      expect(pills[5]).toHaveAttribute("data-tone", "ok");
      expect(pills[6]).toHaveTextContent(/^Earlier approval$/);
      expect(pills[6]).toHaveAttribute("data-tone", "warn");
      expect(pills).toHaveLength(7);
      expect(pr.autoSubmission).toEqual(original);
      expect(backend.submissions[pr.id] ?? []).toHaveLength(0);
    });

it("keeps approval after the closed-state and request pills in the detail header", async () => {
  window.location.hash = "#/pr/pr-482";
  const backend = new MockBackend({ reviewDelayMs: 0, autoSubmission: "human" });
  const pr = backend.prs.find((item) => item.id === "pr-482")!;
  pr.state = "CLOSED";
  pr.viewerApproval = { viewerLogin: "demo-user", headSha: pr.headSha, commitSha: pr.headSha };
  uninstall = installMockApi(backend);
  render(<App mock />);
  const heading = await screen.findByRole("heading", { name: new RegExp(pr.title) });
  const pills = [...heading.closest(".pr-title")!.querySelectorAll(".pill")];
  expect(pills.slice(0, 3).map((pill) => pill.textContent)).toEqual([
    "Ready",
    "✋ Human requested",
    "closed",
  ]);
  expect(pills[3]).toHaveTextContent(/^Review requested /);
  expect(pills[4]).toHaveTextContent(/^Approved by you$/);
  expect(pills).toHaveLength(5);
});

it("keeps the row review action local and independent of the viewer approval indicator", async () => {
  const backend = new MockBackend({ reviewDelayMs: 0 });
  const pr = backend.prs.find((item) => item.id === "pr-490")!;
  pr.viewerApproval = { viewerLogin: "demo-user", headSha: pr.headSha, commitSha: pr.headSha };
  uninstall = installMockApi(backend);
  const user = userEvent.setup();
  render(<App mock />);
  const title = await screen.findByText(pr.title);
  const row = within(title.closest(".pr-row") as HTMLElement);
  expect(row.getByText("Approved by you")).toBeInTheDocument();
  await user.click(row.getByRole("button", { name: `Review #${pr.number} ${pr.title}` }));
  await waitFor(() => expect(backend.runs[pr.id]?.at(-1)?.trigger).toBe("manual"));
  expect(window.location.hash).toBe("#/");
  expect(backend.submissions[pr.id] ?? []).toHaveLength(0);
});

for (const kind of ["missing", "unknown", "head-drift", "missing-commit"] as const)
  it(`does not infer approval from Ready or Submitted when viewer evidence is ${kind}`, async () => {
    const backend = new MockBackend({ reviewDelayMs: 0 });
    const pr = backend.prs.find((item) => item.id === "pr-482")!;
    if (kind === "unknown") pr.viewerApproval = null;
    if (kind === "head-drift" || kind === "missing-commit")
      pr.viewerApproval = {
        viewerLogin: "demo-user",
        headSha: kind === "head-drift" ? "outdated-head" : pr.headSha,
        commitSha: kind === "missing-commit" ? "" : pr.headSha,
      } satisfies NonNullable<PullRequest["viewerApproval"]>;
    uninstall = installMockApi(backend);
    const user = userEvent.setup();
    render(<App mock />);
    await screen.findByText(pr.title);
    expect(
      screen.getByText("Demo: submitted review with nothing newer to act on"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Approved by you/)).not.toBeInTheDocument();
    expect(screen.queryByText("Earlier approval")).not.toBeInTheDocument();
    await user.click(screen.getByText(pr.title));
    await screen.findByRole("region", { name: "Draft review" });
    await waitFor(() => expect(screen.queryByText(/^Approved by you/)).not.toBeInTheDocument());
    expect(screen.queryByText("Earlier approval")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
  });

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

for (const [kind, copy, tone] of [
  ["current", "Approved by you", "ok"],
  ["earlier", "Approved by you at an earlier revision", "warn"],
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
    expect(row.getByText(copy)).toHaveAttribute("data-tone", tone);
    expect(row.getByText("Ready")).toBeInTheDocument();
    expect(row.getByText(/Merge:|Mergeable/)).toBeInTheDocument();
    expect(row.queryByRole("button", { name: /^Re-review/ })).not.toBeInTheDocument();
    expect(title.closest("a")).toHaveAttribute("href", "#/pr/pr-482");
    await user.click(title);
    await screen.findByRole("region", { name: "Draft review" });
    expect(screen.getByText(copy)).toHaveAttribute("data-tone", tone);
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    expect(backend.drafts[pr.id]).toEqual(originalDraft);
    expect(backend.submissions[pr.id] ?? []).toHaveLength(0);
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
    await user.click(screen.getByText(pr.title));
    await screen.findByRole("region", { name: "Draft review" });
    await waitFor(() => expect(screen.queryByText(/^Approved by you/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
  });

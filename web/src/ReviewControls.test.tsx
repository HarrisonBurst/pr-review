import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ReviewRun } from "../../shared/contracts";
import { ReviewControls } from "./components/ReviewControls";
import { staleReviewJobs } from "./lib/review-job";
import { installMockApi, MockBackend } from "./mock/mockApi";

let uninstall: (() => void) | undefined;
beforeEach(() => {
  window.location.hash = "#/";
});
afterEach(() => {
  cleanup();
  uninstall?.();
  sessionStorage.clear();
});

function mount(status: "queued" | "running", kind: "review" | "revision" = "review") {
  const backend = new MockBackend({ reviewControls: true, reviewDelayMs: 0 });
  const pr = backend.prs.find((pr) => pr.id === "pr-482")!;
  const run: ReviewRun = {
    ...structuredClone(backend.runs[pr.id]![0]!),
    id: "synthetic-control-run",
    status,
    kind,
    result: null,
    cancellation: null,
    headSha: pr.headSha,
    createdAt: new Date().toISOString(),
    startedAt: status === "running" ? new Date().toISOString() : null,
    finishedAt: null,
  };
  backend.runs[pr.id]!.push(run);
  delete backend.drafts[pr.id]![0]!.autoSubmission;
  pr.status = status === "queued" ? "queued" : "reviewing";
  uninstall = installMockApi(backend);
  render(<App mock />);
  return { backend, run, pr, user: userEvent.setup() };
}

it("delayed pending snapshots cannot replace confirmed or unconfirmed shutdown evidence", async () => {
  const { backend, run, pr } = mount("running");
  await screen.findByRole("button", { name: /Cancel review #482/ });
  run.cancellation = {
    status: "pending",
    requestedAt: "2026-01-01T00:00:00Z",
    finishedAt: null,
    message: "SYNTHETIC pending",
  };
  const pending = backend.detail(pr.id).pr;
  run.cancellation = {
    ...run.cancellation,
    status: "confirmed",
    finishedAt: "2026-01-01T00:00:01Z",
  };
  run.status = "cancelled";
  const confirmed = backend.detail(pr.id).pr;
  expect(staleReviewJobs(confirmed, pending)).toBe(true);
  expect(staleReviewJobs(pending, confirmed)).toBe(false);
  run.status = "running";
  run.cancellation = { ...run.cancellation, status: "unconfirmed" };
  expect(staleReviewJobs(backend.detail(pr.id).pr, pending)).toBe(true);
});

it("confirmation focus stays on the keyboard choice across live parent updates", async () => {
  const backend = new MockBackend();
  const pr = structuredClone(backend.prs.find((pr) => pr.id === "pr-482")!);
  pr.reviewJobs = [
    {
      jobId: "synthetic-focus-job",
      runId: "synthetic-focus-run",
      headSha: pr.headSha,
      kind: "review",
      status: "running",
      cancellation: null,
    },
  ];
  const view = render(<ReviewControls pr={pr} onChange={async () => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Cancel review #482/ }));
  const keep = within(screen.getByRole("dialog")).getByRole("button", { name: "Keep running" });
  keep.focus();
  view.rerender(<ReviewControls pr={{ ...pr }} onChange={async () => {}} />);
  expect(keep).toHaveFocus();
  await user.tab();
  expect(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm cancellation" }),
  ).toHaveFocus();
});

it("Inbox unqueues only the observed job without row navigation or draft changes", async () => {
  const { backend, run, pr, user } = mount("queued");
  const before = structuredClone(backend.drafts[pr.id]);
  const action = vi.spyOn(backend, "reviewJobAction");
  await user.dblClick(await screen.findByRole("button", { name: /Unqueue review #482/ }));
  await waitFor(() => expect(run.status).toBe("unqueued"));
  expect(action).toHaveBeenCalledTimes(1);
  expect(action.mock.calls[0]?.slice(0, 3)).toEqual([
    pr.id,
    "job-synthetic-control-run",
    "unqueue",
  ]);
  expect(backend.drafts[pr.id]).toEqual(before);
  expect(window.location.hash).toBe("#/");
  expect(await screen.findByText(/review unqueued at/)).toBeInTheDocument();
});

for (const kind of ["review", "revision"] as const)
  it(`PR ${kind} cancellation requires keyboard confirmation and shows durable pending then confirmed state`, async () => {
    const { backend, run, pr, user } = mount("running", kind);
    const before = structuredClone(backend.drafts[pr.id]);
    const gate = backend.hold("review-cancel");
    await user.click(
      await screen.findByRole("link", { name: /Apply volume discounts on invoices/ }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(`Cancel ${kind === "revision" ? "AI revision" : "review"} #482`),
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Keep running" }));
    expect(run.cancellation).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: new RegExp(`Cancel ${kind === "revision" ? "AI revision" : "review"} #482`),
      }),
    );
    within(screen.getByRole("dialog"))
      .getByRole("button", { name: "Confirm cancellation" })
      .focus();
    await user.keyboard("{Enter}");
    await gate.entered;
    expect(await screen.findByText(/Cancellation pending/)).toBeInTheDocument();
    expect(run.status).toBe("running");
    gate.release();
    expect(await screen.findByText(/Cancellation confirmed/)).toBeInTheDocument();
    expect(run.status).toBe("cancelled");
    expect(backend.drafts[pr.id]).toEqual(before);
  });

it("an observed queued job that has started reports conflict instead of silently cancelling", async () => {
  const { run, user } = mount("queued");
  const button = await screen.findByRole("button", { name: /Unqueue review #482/ });
  run.status = "running";
  await user.click(button);
  expect(await screen.findByText(/observed job is running/)).toBeInTheDocument();
  expect(run.cancellation).toBeNull();
  expect(await screen.findByRole("button", { name: /Cancel review #482/ })).toBeInTheDocument();
});

it("shutdown refusal is visible after reload, never shown as confirmed or offered as a second cancellation", async () => {
  const { backend, run, user } = mount("running");
  const gate = backend.hold("review-cancel");
  await user.click(await screen.findByRole("button", { name: /Cancel review #482/ }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm cancellation" }),
  );
  await gate.entered;
  gate.fail("owned signal refusal");
  expect(await screen.findByText(/Shutdown unconfirmed/)).toBeInTheDocument();
  expect(run.status).toBe("running");
  expect(screen.queryByRole("button", { name: /Cancel review #482/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Cancellation confirmed/)).not.toBeInTheDocument();
});

it("cancellation updates preserve unsaved draft edits and manual preview stays exact after Save", async () => {
  const { backend, user } = mount("running");
  const gate = backend.hold("review-cancel");
  await user.click(await screen.findByRole("link", { name: /Apply volume discounts on invoices/ }));
  const body = await screen.findByLabelText(/GitHub review body/);
  expect(screen.queryByRole("button", { name: "Begin editing" })).toBeNull();
  expect(body).not.toHaveAttribute("readonly");
  expect(backend.editIntentBodies).toEqual([]);
  await user.clear(body);
  await user.type(body, "SYNTHETIC unsaved cancellation edit");
  await user.click(screen.getByRole("button", { name: /Cancel review #482/ }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm cancellation" }),
  );
  await gate.entered;
  expect(body).toHaveValue("SYNTHETIC unsaved cancellation edit");
  gate.release();
  await screen.findByText(/Cancellation confirmed/);
  expect(body).toHaveValue("SYNTHETIC unsaved cancellation edit");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() =>
    expect(backend.drafts["pr-482"]![0]!.body).toBe("SYNTHETIC unsaved cancellation edit"),
  );
  await user.click(screen.getByRole("button", { name: "Preview and submit" }));
  const preview = await screen.findByRole("dialog");
  expect(JSON.parse(within(preview).getByTestId("payload-body").textContent!)).toEqual(
    Object.values(backend.previews).at(-1)!.payload,
  );
  await user.click(within(preview).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

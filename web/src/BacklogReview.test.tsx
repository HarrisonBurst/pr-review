import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { BacklogReviewOutcome, BacklogReviewPreview } from "../../shared/contracts";
import { api } from "./api/client";
import { BacklogReview } from "./components/BacklogReview";

const preview: BacklogReviewPreview = {
  limit: 5,
  entries: Array.from({ length: 6 }, (_, index) => ({
    prId: `synthetic-${index}`,
    number: index + 1,
    title: `SYNTHETIC backlog ${index}`,
    headSha: `synthetic-head-${index}`,
    reason: null,
  })),
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens a read-only explicit preview, bounds selection and sends exact heads only once", async () => {
  const read = vi.spyOn(api, "backlog").mockResolvedValue(preview);
  let finish!: (value: BacklogReviewOutcome[]) => void;
  const write = vi.spyOn(api, "reviewBacklog").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<BacklogReview refresh={refresh} />);
  const user = userEvent.setup();
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Review backlog" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("local drafts only, never automatic publication");
  const boxes = await within(dialog).findAllByRole("checkbox");
  boxes[0]!.focus();
  await user.keyboard(" {Tab} ");
  expect(boxes[0]).toBeChecked();
  expect(boxes[1]).toBeChecked();
  expect(boxes[1]).toHaveFocus();
  for (const box of boxes.slice(2, 5)) await user.click(box);
  expect(boxes[5]).toBeDisabled();
  const queue = within(dialog).getByRole("button", { name: "Queue 5 local draft reviews" });
  await user.click(queue);
  expect(queue).toBeDisabled();
  await user.click(queue);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith({
    selections: preview.entries.slice(0, 5).map(({ prId, headSha }) => ({ prId, headSha })),
  });
  finish([
    {
      prId: "synthetic-0",
      status: "queued",
      message: "Local draft review queued",
      runId: "synthetic-run",
    },
    { prId: "synthetic-1", status: "busy", message: "busy", runId: null },
    { prId: "synthetic-2", status: "skipped", message: "head_changed", runId: null },
    {
      prId: "synthetic-3",
      status: "error",
      message: "SYNTHETIC unsupported execution",
      runId: null,
    },
  ]);
  expect(await within(dialog).findByRole("list", { name: "Backlog outcomes" })).toHaveTextContent(
    "#1: queued",
  );
  expect(dialog).toHaveTextContent("#2: busy - Review work already pending");
  expect(dialog).toHaveTextContent("Head changed; refresh the backlog");
  expect(dialog).toHaveTextContent("SYNTHETIC unsupported execution");
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(
    within(dialog).getByRole("button", { name: "Queue 0 local draft reviews" }),
  ).toBeDisabled();
});

it("empty and ineligible previews explain why and never queue on open, refresh or keyboard cancel", async () => {
  vi.spyOn(api, "backlog").mockResolvedValue({
    limit: 5,
    entries: preview.entries.slice(0, 3).map((item, index) => ({
      ...item,
      reason: (["automation_off", "reviewed_head", "busy"] as const)[index]!,
    })),
  });
  const write = vi.spyOn(api, "reviewBacklog");
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<BacklogReview refresh={refresh} />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Review backlog" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText("No eligible unreviewed backlog.")).toBeInTheDocument();
  expect(screen.getByText(/No active auto-review policy/)).toBeInTheDocument();
  expect(screen.getByText(/Current commit already reviewed/)).toBeInTheDocument();
  for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Refresh backlog" }));
  await screen.findByText("No eligible unreviewed backlog.");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(write).not.toHaveBeenCalled();
});

it("a lost response requires fresh preview, with no automatic retry", async () => {
  vi.spyOn(api, "backlog").mockResolvedValue(preview);
  const write = vi
    .spyOn(api, "reviewBacklog")
    .mockRejectedValue(new Error("SYNTHETIC lost response"));
  render(<BacklogReview refresh={vi.fn().mockResolvedValue(undefined)} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review backlog" }));
  await user.click((await screen.findAllByRole("checkbox"))[0]!);
  await user.click(screen.getByRole("button", { name: "Queue 1 local draft reviews" }));
  await screen.findByText(/Lost or failed queue response/);
  expect(write).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Queue 0 local draft reviews" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Refresh backlog" }));
  await waitFor(() =>
    expect(screen.queryByText(/Lost or failed queue response/)).not.toBeInTheDocument(),
  );
  expect(write).toHaveBeenCalledTimes(1);
});

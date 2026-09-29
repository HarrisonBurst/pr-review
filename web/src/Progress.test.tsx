import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { installMockApi, MockBackend } from "./mock/mockApi";
import { formatDuration } from "./lib/format";

let backend: MockBackend;
let uninstall: (() => void) | null = null;

function mount(
  options?: ConstructorParameters<typeof MockBackend>[0],
  prepare?: (backend: MockBackend) => void,
) {
  backend = new MockBackend({ reviewDelayMs: 0, ...options });
  prepare?.(backend);
  uninstall = installMockApi(backend);
  const view = render(<App mock />);
  return Object.assign(userEvent.setup(), { unmount: view.unmount });
}

const runsCard = async () => screen.findByRole("region", { name: "Runs" });
const runItem = async (card: HTMLElement, title: RegExp) =>
  (await within(card).findByText(title)).closest("details") as HTMLElement;

beforeEach(() => {
  window.location.hash = "#/";
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.useRealTimers();
});

describe("formatDuration", () => {
  it("renders seconds, minutes, and hours without estimates", () => {
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("review progress", () => {
  it("shows the live stage, elapsed time, and last observed activity near the review action", async () => {
    window.location.hash = "#/pr/pr-479";
    mount();
    const review = await screen.findByRole("button", { name: "Review in progress" });
    const notice = review.closest(".stack")!.querySelector(".review-live")!;
    const stage = within(notice as HTMLElement).getByText("Claude review");
    expect(stage.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
    expect(stage.closest(".run-stage")).toHaveTextContent(
      /Claude review · Listing files in src\/webhooks/,
    );
    const time = within(notice as HTMLElement).getByLabelText("Elapsed time");
    expect(time).toHaveTextContent(/^3m \d\ds in stage5m \d\ds total$/);
    expect(time.closest("[aria-live]")).toBeNull();
    expect(notice).not.toHaveTextContent(/%|remaining|ETA|estimated/i);
  });

  it("lists actual stages with durations and bounds the activity list behind a disclosure", async () => {
    window.location.hash = "#/pr/pr-479";
    const user = mount();
    const card = await runsCard();
    const running = await runItem(card, /Review request/);
    expect(running.querySelector(".run-stage")).toHaveTextContent(/^Claude review · Listing/);
    await user.click(within(running).getByText("Review request"));
    const stages = within(running).getByRole("list", { name: "Review stages" });
    const rows = within(stages).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Waiting in queue1m 00s$/),
      expect.stringMatching(/^Preparing pinned checkout · 3f1c2a1\.\.9b8d7e212s$/),
      expect.stringMatching(/^Codex cross-check1m 36s$/),
      expect.stringMatching(/^Claude review3m \d\ds$/),
    ]);
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual([
      "completed",
      "completed",
      "completed",
      "running",
    ]);
    expect(within(running).queryByText(/Syncing latest PR/)).not.toBeInTheDocument();
    expect(within(running).getByText(/Total elapsed 5m \d\ds so far/)).toBeInTheDocument();
    const tail = within(running).getByRole("list", { name: "Recent activity" });
    expect(within(tail).getAllByRole("listitem")).toHaveLength(3);
    expect(tail).toHaveTextContent("Reading src/webhooks/retry.ts");
    const toggle = within(running).getByText(/Show activity/);
    expect(toggle).toHaveTextContent("Show activity (last 6 of 14)");
    expect(toggle.closest("details")).not.toHaveAttribute("open");
    await user.click(toggle);
    const all = within(running).getByRole("list", { name: /Hide activity/ });
    expect(within(all).getAllByRole("listitem")).toHaveLength(6);
    expect(all).toHaveAttribute("tabindex", "0");
    expect(within(all).getAllByRole("listitem")[0]).toHaveTextContent(
      /^appClaude review started\d+m ago$/,
    );
    expect(within(all).getAllByRole("listitem")[1]).toHaveTextContent(
      "claudeClaude session started with claude-opus-5",
    );
  });

  it("keeps completed, failed, interrupted, and legacy runs honest", async () => {
    window.location.hash = "#/pr/pr-482";
    const user = mount();
    let card = await runsCard();
    const done = await runItem(card, /Manual review/);
    expect(done.querySelector(".run-stage")).toBeNull();
    await user.click(within(done).getByText("Manual review"));
    const stages = within(done).getByRole("list", { name: "Review stages" });
    expect(
      within(stages)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      "Waiting in queue1m 00s",
      "Syncing latest PR · head 9b8d7e26s",
      "Preparing pinned checkout · 3f1c2a1..9b8d7e212s",
      "Selected execution · 3 entries3m 42s",
      "Validating and saving result · draft created6s",
    ]);
    const entries = within(done).getByRole("list", { name: "Reviewer entries" });
    expect(within(entries).getAllByRole("listitem")).toHaveLength(3);
    expect(within(done).getByText("Total elapsed 4m 00s.")).toBeInTheDocument();
    expect(within(done).queryByText("Recent activity")).not.toBeInTheDocument();
    expect(within(done).getByText(/Show activity/)).toHaveTextContent("(last 17 of 57)");
    const legacy = await runItem(card, /Review request/);
    await user.click(within(legacy).getByText("Review request"));
    expect(legacy).toHaveTextContent(
      "No stage timing or harness activity was recorded for this run, so none is shown.",
    );
    expect(legacy).toHaveTextContent("Total elapsed 9m 00s.");
    expect(within(legacy).queryByRole("list", { name: "Review stages" })).not.toBeInTheDocument();

    window.location.hash = "#/pr/pr-468";
    await screen.findByRole("heading", { name: /#468/ });
    card = await runsCard();
    const failed = await runItem(card, /Review request/);
    await user.click(within(failed).getByText("Review request"));
    const failedRows = within(failed)
      .getByRole("list", { name: "Review stages" })
      .querySelectorAll("li");
    expect(failedRows[2]).toHaveAttribute("data-status", "failed");
    expect(failedRows[2]).toHaveTextContent(
      "Codex cross-check failed · codex exec exited with code 1: not logged in",
    );
    expect(failedRows[3]).toHaveTextContent(/^Claude review failed · Claude returned malformed/);
    expect(failed.querySelector(".run-stage")).toBeNull();

    window.location.hash = "#/pr/pr-490";
    await screen.findByRole("heading", { name: /#490/ });
    card = await runsCard();
    const interrupted = await runItem(card, /Review request/);
    await user.click(within(interrupted).getByText("Review request"));
    const last = within(interrupted)
      .getByRole("list", { name: "Review stages" })
      .querySelectorAll("li")[3]!;
    expect(last).toHaveAttribute("data-status", "interrupted");
    expect(last).toHaveTextContent(/^Claude review interrupted8m 00s$/);
    expect(interrupted.querySelector(".run-stage")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review in progress" })).not.toBeInTheDocument();
  });

  it(
    "shows the sync preflight while the request is in flight, then real stages as they happen",
    { timeout: 20000 },
    async () => {
      window.location.hash = "#/pr/pr-490";
      const user = mount({ reviewDelayMs: 500 });
      await screen.findByRole("button", { name: "Review now" });
      const original = backend.review.bind(backend);
      let release: () => void = () => {};
      backend.review = (id: string) => {
        backend.review = original;
        return new Promise((resolve) => {
          release = () => resolve(original(id));
        }) as never;
      };
      await user.click(screen.getByRole("button", { name: "Review now" }));
      expect(await screen.findByRole("button", { name: "Syncing latest commit" })).toBeDisabled();
      expect(
        screen.getByText(/Syncing latest PR from GitHub before queuing the review/),
      ).toBeInTheDocument();
      release();
      await screen.findByRole("button", { name: "Review in progress" });
      const seen = new Set<string>();
      await waitFor(
        () => {
          const stage = document.querySelector(".review-live .run-stage-name");
          if (stage?.textContent) seen.add(stage.textContent);
          expect(backend.detail("pr-490").runs.at(-1)?.status).toBe("completed");
        },
        { timeout: 12000, interval: 10 },
      );
      expect([...seen]).toEqual(
        expect.arrayContaining([
          "Waiting in queue",
          "Preparing pinned checkout",
          "Selected execution",
          "Validating and saving result",
        ]),
      );
      const run = backend.detail("pr-490").runs.at(-1)!;
      expect(run.progress!.phases.map((p) => [p.id, p.status])).toEqual([
        ["sync", "completed"],
        ["checkout", "completed"],
        ["workflow", "completed"],
        ["finalize", "completed"],
      ]);
      expect(run.progress!.entries!.map((e) => [e.id, e.status])).toEqual([
        ["reviewer-1", "completed"],
        ["reviewer-2", "completed"],
        ["main", "completed"],
      ]);
      expect(await screen.findByRole("button", { name: "Re-review" })).toBeEnabled();
      const card = await runsCard();
      const finished = await runItem(card, /Manual review/);
      await user.click(within(finished).getByText("Manual review"));
      expect(within(finished).getByRole("list", { name: "Review stages" })).toHaveTextContent(
        /Syncing latest PR · head 9b8d7e2/,
      );
    },
  );

  it("notes silence without calling the run stuck and survives a reconnect with persisted progress", async () => {
    window.location.hash = "#/pr/pr-479";
    mount({}, (b) => {
      const run = b.runs["pr-479"]![0]!;
      run.progress!.lastActivityAt = new Date(Date.now() - 3 * 60_000).toISOString();
    });
    await screen.findByRole("button", { name: "Review in progress" });
    const [quiet] = await screen.findAllByText(/No activity reported for 3m 0\ds\./);
    expect(quiet!).toHaveTextContent(
      "Silence only means nothing was observed, not that the review is stuck.",
    );
    expect(quiet!.closest("[aria-live]")).toBeNull();
    await act(async () => {
      backend.runs["pr-479"]![0]!.progress!.activity.push({
        at: new Date().toISOString(),
        source: "claude",
        kind: "read",
        label: "Reading src/webhooks/queue.ts",
      });
      backend.runs["pr-479"]![0]!.progress!.lastActivityAt = new Date().toISOString();
      backend.runs["pr-479"]![0]!.progress!.activityCount += 1;
      (
        globalThis.EventSource as unknown as {
          instances: { onerror: ((e: Event) => void) | null }[];
        }
      ).instances
        .at(-1)!
        .onerror?.(new Event("error"));
    });
    const [fresh] = await screen.findAllByText(
      /Reading src\/webhooks\/queue\.ts/,
      {},
      { timeout: 4000 },
    );
    expect(fresh!.closest(".run-stage")).toHaveTextContent(
      /^Claude review · Reading src\/webhooks\/queue\.ts/,
    );
    expect(screen.queryByText(/No activity reported/)).not.toBeInTheDocument();
  });

  it("does not add a live stage to a running run that recorded no progress", async () => {
    window.location.hash = "#/pr/pr-479";
    const user = mount({}, (b) => {
      b.runs["pr-479"]![0]!.progress = null;
    });
    const review = await screen.findByRole("button", { name: "Review in progress" });
    const live = review.closest(".stack")!.querySelector(".review-live .run-stage")!;
    expect(live).toHaveTextContent(/^Starting5m \d\ds totalNo activity reported yet\./);
    const card = await runsCard();
    const running = await runItem(card, /Review request/);
    await user.click(within(running).getByText("Review request"));
    expect(running).toHaveTextContent("No stage timing or harness activity was recorded");
    expect(running).toHaveTextContent(/Total elapsed 5m \d\ds so far\./);
  });
});

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { toUpdate } from "./lib/draft";
import {
  automationOff,
  dockerApprovalConfirmation,
  dockerSetupConfirmation,
} from "../../shared/contracts";
import {
  DECLARED_PLUGIN_CLIENT_ID,
  DOCKER_LEAF_STALE_MESSAGE,
  dockerExclusionCandidates,
  SYNCED_MANIFEST_PATH,
  drafts,
  fixturesForExecutionTests as fx,
  HOME,
  slackOAuthProfile,
  linearOAuthProfile,
  syntheticOAuthProfile,
} from "./mock/fixtures";
import {
  installMockApi,
  MockBackend,
  MockError,
  OAUTH_FIXED_REDIRECT_URI,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPE_CONSENT,
  SLACK_TEST_FAILED_MESSAGE,
  LINEAR_TEST_FAILED_MESSAGE,
  LINEAR_TEST_SYNTHETIC_MESSAGE,
  SLACK_TEST_SYNTHETIC_MESSAGE,
} from "./mock/mockApi";
import { readFileSync } from "node:fs";

let backend: MockBackend;
let uninstall: () => void;

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

beforeEach(() => {
  window.location.hash = "#/";
});

afterEach(() => {
  uninstall();
});

describe("inbox", () => {
  it("lists pull requests and filters by search and status", async () => {
    const user = mount();
    expect(await screen.findByText("Apply volume discounts on invoices")).toBeInTheDocument();
    expect(screen.getByText(/Mock API \(test only\)/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Needs attention/ }));
    expect(screen.queryByText("Retry webhook deliveries with jitter")).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "sessions");
    const list = screen.getByRole("list", { name: "Requested of you" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Migrate sessions table to UUID keys")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Requested of your teams" })).not.toBeInTheDocument();
    expect(
      screen.getAllByText(
        "No pull requests in this group match the current search or status filter.",
      ),
    ).toHaveLength(2);
  });

  const rowTitles = (name: string) =>
    within(screen.getByRole("list", { name }))
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".title")!.textContent);

  it("groups by request provenance and orders ready drafts first, then oldest age", async () => {
    mount();
    await screen.findByText("Apply volume discounts on invoices");
    expect(rowTitles("Requested of you")).toEqual([
      "#482Apply volume discounts on invoices",
      "#468Upgrade OpenAPI generator to 7.x",
      "#475Migrate sessions table to UUID keys",
      "#455Demo: submitted review with nothing newer to act on",
    ]);
    expect(rowTitles("Requested of your teams")).toEqual([
      "#479Retry webhook deliveries with jitter",
      "#490Add rate limit headers to public API",
    ]);
    const other = screen.getByText("Other tracked PRs").closest("details")!;
    expect(other).not.toHaveAttribute("open");
    expect(other.querySelector("summary")).toHaveTextContent("Other tracked PRs2");
    expect(screen.getByText("Requested of you").closest("details")).toHaveAttribute("open");
    const you = within(screen.getByRole("list", { name: "Requested of you" }));
    expect(
      you.getByText("Apply volume discounts on invoices").closest(".pr-row"),
    ).toHaveTextContent(/requested 1h ago/);
    expect(
      you.getByText("Migrate sessions table to UUID keys").closest(".pr-row"),
    ).toHaveTextContent(/requested 15h ago/);
    expect(
      you.getByText("Apply volume discounts on invoices").closest("a")!.getAttribute("href"),
    ).toBe("#/pr/pr-482");
  });

  it("badges Submitted in its own tone and sorts settled submissions last within each group", async () => {
    mount();
    await screen.findByText("Demo: submitted review with nothing newer to act on");
    const submitted = rowTitles("Requested of you").at(-1)!;
    expect(submitted).toContain("#455");
    const pill = within(screen.getByRole("list", { name: "Requested of you" }))
      .getByText("Demo: submitted review with nothing newer to act on")
      .closest(".pr-row")!
      .querySelector(".pill")!;
    expect(pill).toHaveTextContent("Submitted");
    expect(pill).toHaveAttribute("data-tone", "settled");
    for (const status of ["Ready", "Outdated", "Failed", "Unreviewed", "Reviewing"])
      expect(screen.getAllByText(status)[0]).not.toHaveAttribute("data-tone", "settled");
    const other = screen.getByText("Other tracked PRs").closest("details")!;
    other.open = true;
    expect(rowTitles("Other tracked PRs")).toEqual([
      "#460Legacy row: requested before request types were recorded",
      "#471Fix flaky clock test on CI",
    ]);
  });

  it("returns a submitted PR to active order when its status shows newer work", async () => {
    mount();
    await screen.findByText("Demo: submitted review with nothing newer to act on");
    const pr = backend.prs.find((p) => p.id === "pr-455")!;
    pr.status = "outdated";
    backend.sync();
    await waitFor(() =>
      expect(rowTitles("Requested of you")).toEqual([
        "#482Apply volume discounts on invoices",
        "#468Upgrade OpenAPI generator to 7.x",
        "#455Demo: submitted review with nothing newer to act on",
        "#475Migrate sessions table to UUID keys",
      ]),
    );
    pr.status = "ready";
    backend.sync();
    await waitFor(() =>
      expect(rowTitles("Requested of you")[0]).toBe(
        "#455Demo: submitted review with nothing newer to act on",
      ),
    );
    pr.status = "submitted";
    backend.sync();
    await waitFor(() =>
      expect(rowTitles("Requested of you").at(-1)).toBe(
        "#455Demo: submitted review with nothing newer to act on",
      ),
    );
  });

  it("keeps known personal/team history after requests clear, with precedence and closure safety", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    const retained = backend.prs.filter((pr) =>
      ["pr-482", "pr-479", "pr-475", "pr-471"].includes(pr.id),
    );
    backend.runs["pr-479"]!.push({
      ...backend.runs["pr-482"]![0]!,
      id: "retained-team-review",
      prId: "pr-479",
    });
    for (const pr of retained) {
      pr.requested = false;
      pr.requestSource = null;
      pr.requestedAt = null;
      pr.imported = false;
    }
    backend.sync();
    await user.click(screen.getByText("Other tracked PRs"));
    await waitFor(() =>
      expect(rowTitles("Requested of you")).toContain("#482Apply volume discounts on invoices"),
    );
    expect(rowTitles("Requested of you")).toContain("#475Migrate sessions table to UUID keys");
    expect(rowTitles("Requested of your teams")).toContain(
      "#479Retry webhook deliveries with jitter",
    );
    expect(rowTitles("Other tracked PRs")).toContain("#471Fix flaky clock test on CI");
    const personal = retained.find((pr) => pr.id === "pr-482")!;
    personal.requested = true;
    personal.requestSource = "team";
    personal.headSha = "new-inert-head";
    backend.sync();
    await waitFor(() =>
      expect(
        rowTitles("Requested of you").filter((title) => title.startsWith("#482")),
      ).toHaveLength(1),
    );
    expect(rowTitles("Requested of your teams").some((title) => title.startsWith("#482"))).toBe(
      false,
    );
    personal.state = "CLOSED";
    retained.find((pr) => pr.id === "pr-479")!.state = "MERGED";
    backend.sync();
    await waitFor(() =>
      expect(screen.queryByText("Apply volume discounts on invoices")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Retry webhook deliveries with jitter")).not.toBeInTheDocument();
    expect(backend.detail("pr-482").draft).not.toBeNull();
    personal.state = "OPEN";
    backend.sync();
    await waitFor(() =>
      expect(rowTitles("Requested of you")).toContain("#482Apply volume discounts on invoices"),
    );
  });

  it("keeps unrequested and unknown-provenance PRs reachable in Other with an honest hint", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    await user.click(screen.getByText("Other tracked PRs"));
    expect(rowTitles("Other tracked PRs")).toEqual([
      "#460Legacy row: requested before request types were recorded",
      "#471Fix flaky clock test on CI",
    ]);
    const legacy = screen.getByText(/Legacy row/).closest(".pr-row")!;
    expect(legacy).toHaveTextContent("requested, type unknown");
    expect(legacy).toHaveTextContent("opened at an unknown time");
    expect(screen.getByText("Fix flaky clock test on CI").closest(".pr-row")).toHaveTextContent(
      /opened 2d ago/,
    );
    expect(
      screen.queryByText(/requested, type unknown/, { selector: ".pr-row .request-hint" }),
    ).toBeInTheDocument();
  });

  it("shows GitHub merge readiness per row, labeled apart from the draft status", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    const row = (title: string) => screen.getByText(title).closest(".pr-row") as HTMLElement;
    const hint = (title: string) => row(title).querySelector(".merge-hint")!;
    expect(hint("Apply volume discounts on invoices")).toHaveTextContent("Merge: Ready to merge");
    expect(hint("Apply volume discounts on invoices")).toHaveAttribute("data-tone", "ok");
    expect(within(row("Apply volume discounts on invoices")).getByText("Ready")).toHaveClass(
      "pill",
    );
    expect(hint("Retry webhook deliveries with jitter")).toHaveTextContent(
      "Merge: Blocked · review required · 2 required checks pending",
    );
    expect(hint("Upgrade OpenAPI generator to 7.x")).toHaveTextContent(
      "Merge: Blocked · merge conflicts with the base branch · 3 required checks failed · 1 check failed (not required) · +1 more",
    );
    expect(hint("Migrate sessions table to UUID keys")).toHaveTextContent(
      "Merge: Stale, was blocked on deadbee · changes requested",
    );
    expect(hint("Add rate limit headers to public API")).toHaveTextContent(
      "Merge: Unknown, last check failed",
    );
    await user.click(screen.getByText("Other tracked PRs"));
    expect(hint("Fix flaky clock test on CI")).toHaveTextContent(
      "Merge: Mergeable, checks not passing · 1 check failed (not required)",
    );
    expect(hint("Legacy row: requested before request types were recorded")).toHaveTextContent(
      "Merge: Not checked yet",
    );
    expect(rowTitles("Requested of you")[0]).toBe("#482Apply volume discounts on invoices");
  });

  it("applies filters and search across every group and explains empty results", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    await user.click(screen.getByRole("button", { name: /^Submitted/ }));
    expect(screen.getByText("Requested of you").closest("summary")).toHaveTextContent("1 of 4");
    expect(screen.getByText("Other tracked PRs").closest("summary")).toHaveTextContent("1 of 2");
    await user.click(screen.getByText("Other tracked PRs"));
    expect(rowTitles("Other tracked PRs")).toEqual(["#471Fix flaky clock test on CI"]);
    await user.type(screen.getByRole("searchbox"), "nothing-here");
    expect(
      screen.getByText("Nothing matches the current search or status filter in any group."),
    ).toHaveAttribute("role", "status");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("toggles focusable group headers and keeps disclosure across refreshes and navigation", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    const you = screen.getByText("Requested of you").closest("summary")!;
    expect(you.tagName).toBe("SUMMARY");
    await user.click(you);
    await waitFor(() => expect(you.closest("details")).not.toHaveAttribute("open"));
    const other = screen.getByText("Other tracked PRs").closest("summary")!;
    await user.click(other);
    await waitFor(() => expect(other.closest("details")).toHaveAttribute("open"));
    expect(screen.getByRole("list", { name: "Other tracked PRs" })).toBeInTheDocument();

    backend.updateSettings({ pollIntervalSeconds: 60 });
    await screen.findByText(/Polling every 60s/);
    expect(screen.getByText("Requested of you").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Other tracked PRs").closest("details")).toHaveAttribute("open");

    window.location.hash = "#/settings";
    await screen.findByRole("heading", { name: "Settings" });
    window.location.hash = "#/";
    await screen.findByText("Apply volume discounts on invoices");
    expect(screen.getByText("Requested of you").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Requested of your teams").closest("details")).toHaveAttribute("open");
    expect(screen.getByText("Other tracked PRs").closest("details")).toHaveAttribute("open");
    expect(JSON.parse(sessionStorage.getItem("inbox.groups")!)).toEqual({
      direct: false,
      team: true,
      other: true,
    });
  });

  const rowFor = (title: string) => screen.getByText(title).closest(".pr-row")!;
  const actionIn = (row: Element) => within(row as HTMLElement).getByRole("button");
  const noActionIn = (row: Element) => within(row as HTMLElement).queryByRole("button");
  const pillIn = (row: Element) => row.querySelector(".pill")!;

  it("labels each row's review action from existing evidence and keeps row links valid", async () => {
    mount();
    await screen.findByText("Apply volume discounts on invoices");
    screen.getByText("Other tracked PRs").closest("details")!.open = true;
    const expectations: [string, string | null, boolean][] = [
      ["Apply volume discounts on invoices", null, false],
      ["Migrate sessions table to UUID keys", "Re-review", true],
      ["Demo: submitted review with nothing newer to act on", "Re-review", true],
      ["Upgrade OpenAPI generator to 7.x", "Review", true],
      ["Add rate limit headers to public API", "Review", true],
      ["Retry webhook deliveries with jitter", "Reviewing", false],
      ["Fix flaky clock test on CI", null, false],
      ["Legacy row: requested before request types were recorded", "Review", true],
    ];
    for (const [title, label, enabled] of expectations) {
      const row = rowFor(title);
      expect(row.tagName).toBe("DIV");
      expect(row).toHaveAttribute("role", "listitem");
      expect(row.querySelector("a button")).toBeNull();
      const link = row.querySelector("a.title")!;
      expect(link.getAttribute("href")).toMatch(/^#\/pr\//);
      expect(row.lastElementChild).toHaveClass("meta");
      if (label === null) {
        expect(noActionIn(row)).toBeNull();
        expect(row.querySelector(".right")!.lastElementChild).toHaveClass("pill");
        continue;
      }
      const button = actionIn(row);
      expect(button).toHaveTextContent(label);
      expect(button).toHaveAccessibleName(
        `${label} #${row.querySelector(".num")!.textContent!.slice(1)} ${title}`,
      );
      if (enabled) expect(button).toBeEnabled();
      else expect(button).toBeDisabled();
      expect(row.querySelector(".right")!.lastElementChild).toBe(button);
    }
  });

  it("hides the row action only for exact-head full-review history, not status, drafts, or revisions", async () => {
    mount({}, (b) => {
      const reviewed = b.runs["pr-482"]![1]!;
      b.runs["pr-482"]!.push(
        { ...reviewed, id: "run-482-failed", status: "failed", result: null, error: "boom" },
        { ...reviewed, id: "run-482-revision", kind: "revision" },
      );
      b.runs["pr-468"]!.push({
        ...reviewed,
        id: "run-468-revision",
        kind: "revision",
        prId: "pr-468",
      });
      b.runs["pr-490"]!.push({
        ...reviewed,
        id: "run-490-old",
        prId: "pr-490",
        headSha: "1111111c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      });
      b.drafts["pr-490"] = [{ ...b.drafts["pr-482"]![0]!, id: "draft-490-local", runId: null }];
      b.prs.find((p) => p.id === "pr-490")!.status = "ready";
      b.prs.find((p) => p.id === "pr-455")!.status = "ready";
    });
    await screen.findByText("Apply volume discounts on invoices");
    expect(noActionIn(rowFor("Apply volume discounts on invoices"))).toBeNull();
    expect(actionIn(rowFor("Upgrade OpenAPI generator to 7.x"))).toHaveTextContent("Review");
    expect(actionIn(rowFor("Add rate limit headers to public API"))).toHaveTextContent("Review");
    expect(pillIn(rowFor("Add rate limit headers to public API"))).toHaveTextContent("Ready");
    expect(
      actionIn(rowFor("Demo: submitted review with nothing newer to act on")),
    ).toHaveTextContent("Re-review");
  });

  it("offers the row action again once the head changes after a reviewed head", async () => {
    const user = mount({ remoteHead: { "pr-482": NEW_HEAD } });
    await screen.findByText("Apply volume discounts on invoices");
    expect(noActionIn(rowFor("Apply volume discounts on invoices"))).toBeNull();
    await user.click(rowFor("Apply volume discounts on invoices").querySelector("a.title")!);
    await screen.findByText("The latest review is stale.");
    expect(backend.detail("pr-482").pr).toMatchObject({
      headSha: NEW_HEAD,
      hasReviewedHead: false,
      hasReviewHistory: true,
    });
    window.location.hash = "#/";
    await screen.findByRole("heading", { name: "Inbox" });
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Requested of you" })).getByRole("button", {
          name: "Re-review #482 Apply volume discounts on invoices",
        }),
      ).toBeEnabled(),
    );
    expect(pillIn(rowFor("Apply volume discounts on invoices"))).toHaveTextContent("Outdated");
  });

  it("queues a review from a row without navigating and follows queued, reviewing, and ready", async () => {
    const user = mount({ reviewDelayMs: 400 });
    await screen.findByText("Add rate limit headers to public API");
    const runsBefore = backend.runs["pr-490"]!.length;
    let release!: () => void;
    const original = backend.review.bind(backend);
    const spy = vi.spyOn(backend, "review").mockImplementation((async (id: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(id);
    }) as unknown as typeof backend.review);
    const title = "Add rate limit headers to public API";
    const button = actionIn(rowFor(title));
    await user.click(button);
    await waitFor(() => expect(button).toHaveTextContent("Syncing"));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAccessibleName(`Syncing #490 ${title}`);
    await user.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(actionIn(rowFor("Migrate sessions table to UUID keys"))).toBeEnabled();
    expect(pillIn(rowFor(title))).toHaveTextContent("Unreviewed");
    release();
    await waitFor(() => expect(pillIn(rowFor(title))).toHaveTextContent("Queued"));
    expect(actionIn(rowFor(title))).toHaveTextContent("Queued");
    expect(actionIn(rowFor(title))).toBeDisabled();
    await screen.findByText(/#490: synced to the latest commit and queued a review/);
    await waitFor(() => expect(pillIn(rowFor(title))).toHaveTextContent("Reviewing"));
    expect(actionIn(rowFor(title))).toHaveTextContent("Reviewing");
    expect(actionIn(rowFor(title))).toBeDisabled();
    await waitFor(() => expect(pillIn(rowFor(title))).toHaveTextContent("Ready"), {
      timeout: 5000,
    });
    expect(noActionIn(rowFor(title))).toBeNull();
    expect(backend.detail("pr-490").pr.hasReviewedHead).toBe(true);
    expect(window.location.hash).toBe("#/");
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend.runs["pr-490"]).toHaveLength(runsBefore + 1);
    expect(backend.runs["pr-490"]!.at(-1)!.trigger).toBe("manual");
    expect(rowTitles("Requested of your teams")[0]).toBe(
      "#490Add rate limit headers to public API",
    );
  });

  it("starts the row action from the keyboard and navigates only through the title link", async () => {
    const user = mount();
    await screen.findByText("Add rate limit headers to public API");
    const spy = vi.spyOn(backend, "review");
    const row = rowFor("Add rate limit headers to public API");
    actionIn(row).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(window.location.hash).toBe("#/");
    await user.click(rowFor("Upgrade OpenAPI generator to 7.x").querySelector("a.title")!);
    await screen.findByRole("heading", { name: /Upgrade OpenAPI generator to 7.x/ });
    expect(window.location.hash).toBe("#/pr/pr-468");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps filters and disclosure while a row review changes status and sorting", async () => {
    const user = mount({ reviewDelayMs: 20 });
    await screen.findByText("Apply volume discounts on invoices");
    await user.click(screen.getByRole("button", { name: /^Unreviewed/ }));
    await user.click(screen.getByText("Other tracked PRs"));
    await waitFor(() =>
      expect(screen.getByText("Other tracked PRs").closest("details")).toHaveAttribute("open"),
    );
    await user.type(screen.getByRole("searchbox"), "kai");
    expect(rowTitles("Requested of your teams")).toEqual([
      "#490Add rate limit headers to public API",
    ]);
    await user.click(actionIn(rowFor("Add rate limit headers to public API")));
    await waitFor(() =>
      expect(screen.queryByText("Add rate limit headers to public API")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^Unreviewed/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("searchbox")).toHaveValue("kai");
    expect(screen.getByText("Other tracked PRs").closest("details")).toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: /^All/ }));
    await waitFor(
      () =>
        expect(rowTitles("Requested of your teams")).toEqual([
          "#490Add rate limit headers to public API",
        ]),
      { timeout: 3000 },
    );
    await user.clear(screen.getByRole("searchbox"));
    await waitFor(() =>
      expect(rowTitles("Requested of your teams")).toEqual([
        "#490Add rate limit headers to public API",
        "#479Retry webhook deliveries with jitter",
      ]),
    );
  });

  it("reports a failed row review in a toast and re-enables the row", async () => {
    const user = mount({ reviewRefresh: "fail" });
    await screen.findByText("Add rate limit headers to public API");
    const runsBefore = backend.runs["pr-490"]!.length;
    const button = actionIn(rowFor("Add rate limit headers to public API"));
    await user.click(button);
    expect(
      (
        await screen.findByText(/#490: could not refresh the pull request before reviewing/)
      ).closest(".toast"),
    ).toHaveAttribute("role", "alert");
    expect(button).toHaveTextContent("Review");
    expect(button).toBeEnabled();
    expect(backend.runs["pr-490"]).toHaveLength(runsBefore);
    expect(window.location.hash).toBe("#/");
  });

  it("reports a closed pull request from a row review even after the row leaves the inbox", async () => {
    const user = mount({ reviewRefresh: "closed" });
    await screen.findByText("Add rate limit headers to public API");
    const runsBefore = backend.runs["pr-490"]!.length;
    await user.click(actionIn(rowFor("Add rate limit headers to public API")));
    expect(
      await screen.findByText(/#490: pull request is no longer open, so no review was started/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Add rate limit headers to public API")).not.toBeInTheDocument(),
    );
    expect(backend.runs["pr-490"]).toHaveLength(runsBefore);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });

  it("shows the setup state and configures a repository", async () => {
    const user = mount({ emptySetup: true });
    expect(
      await screen.findByRole("heading", { name: "Set up your review inbox" }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Repository"), "acme/rocket");
    await user.click(screen.getByRole("button", { name: "Start watching" }));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText("No pull requests yet")).toBeInTheDocument();
  });

  it("imports a PR by URL, navigates to it, and lists it under Other tracked PRs", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    await user.type(
      screen.getByLabelText("Pull request URL"),
      "https://github.com/acme/rocket/pull/501",
    );
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(
      await screen.findByRole("heading", { name: /Imported pull request #501/ }),
    ).toBeInTheDocument();
    expect(window.location.hash).toMatch(/#\/pr\//);
    window.location.hash = "#/";
    await screen.findByText("Apply volume discounts on invoices");
    await user.click(screen.getByText("Other tracked PRs"));
    const row = (
      await within(screen.getByRole("list", { name: "Other tracked PRs" })).findByText(
        "Imported pull request #501",
      )
    ).closest(".pr-row")!;
    expect(row).toHaveTextContent("imported");
  });

  it("refuses to import a closed pull request and keeps its history reachable", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    backend.prs.find((p) => p.id === "pr-471")!.state = "MERGED";
    await user.type(
      screen.getByLabelText("Pull request URL"),
      "https://github.com/acme/rocket/pull/471",
    );
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/only open pull requests can be imported/)).toBeInTheDocument();
    expect(backend.detail("pr-471").runs.length).toBeGreaterThan(0);
  });

  it("surfaces backend errors instead of fake data", async () => {
    const user = mount();
    await screen.findByText("Apply volume discounts on invoices");
    await user.type(
      screen.getByLabelText("Pull request URL"),
      "https://github.com/other/repo/pull/1",
    );
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/PR belongs to other\/repo/);
  });
});

describe("sync and import activity", () => {
  const syncButton = () => screen.getByRole("button", { name: /^(Sync now|Syncing\.\.\.)$/ });
  const importButton = () => screen.getByRole("button", { name: /^(Import|Importing\.\.\.)$/ });
  const activity = () => screen.getByRole("status", { name: "Sync and import activity" });
  const url = (n: number, suffix = "") => `https://github.com/acme/rocket/pull/${n}${suffix}`;

  function remount(view: { unmount: () => void }) {
    view.unmount();
    const next = render(<App mock />);
    return Object.assign(userEvent.setup(), { unmount: next.unmount });
  }

  async function ready() {
    await screen.findByText("Apply volume discounts on invoices");
  }

  it("keeps a held sync active across reload and re-enables Sync now when it completes", async () => {
    const user = mount();
    await ready();
    const hold = backend.hold("sync");
    await user.click(syncButton());
    await hold.entered;
    expect(syncButton()).toHaveTextContent("Syncing...");
    expect(syncButton()).toBeDisabled();
    expect(syncButton()).toHaveAttribute("aria-busy", "true");
    const reloaded = remount(user);
    await ready();
    await waitFor(() => expect(syncButton()).toBeDisabled());
    expect(syncButton()).toHaveTextContent("Syncing...");
    expect(activity()).toHaveTextContent(/Syncing with GitHub, started/);
    hold.release();
    await waitFor(() => expect(syncButton()).toBeEnabled());
    expect(syncButton()).toHaveTextContent("Sync now");
    expect(activity()).toHaveTextContent(/Last sync completed/);
    expect(backend.syncCalls).toBe(1);
    reloaded.unmount();
  });

  it("shows a sync failure that settles after reload and retries on request", async () => {
    const user = mount();
    await ready();
    const hold = backend.hold("sync");
    await user.click(syncButton());
    await hold.entered;
    const reloaded = remount(user);
    await ready();
    await waitFor(() => expect(syncButton()).toBeDisabled());
    hold.fail("GitHub returned HTTP 503");
    const alert = (await screen.findByText(/Sync failed/)).closest(".notice");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(/Sync failed .*GitHub returned HTTP 503/);
    expect(syncButton()).toBeEnabled();
    expect(screen.queryByText("Last poll failed.")).not.toBeInTheDocument();
    expect(screen.queryByText("Synced with GitHub")).not.toBeInTheDocument();
    await reloaded.click(syncButton());
    await screen.findByText("Synced with GitHub");
    await waitFor(() => expect(screen.queryByText(/Sync failed/)).not.toBeInTheDocument());
    expect(backend.syncCalls).toBe(2);
    reloaded.unmount();
  });

  it("keeps a held import visible after its input resets and blocks only the same identity", async () => {
    const user = mount();
    await ready();
    const hold = backend.hold(901);
    await user.type(screen.getByLabelText("Pull request URL"), url(901));
    await user.click(importButton());
    await hold.entered;
    expect(importButton()).toHaveTextContent("Importing...");
    expect(importButton()).toBeDisabled();
    const reloaded = remount(user);
    await ready();
    await waitFor(() => expect(activity()).toHaveTextContent(/Importing #901, started/));
    expect(screen.getByLabelText("Pull request URL")).toHaveValue("");
    expect(syncButton()).toBeEnabled();
    await reloaded.type(screen.getByLabelText("Pull request URL"), url(901, "/?tab=files#top"));
    expect(importButton()).toHaveTextContent("Importing...");
    expect(importButton()).toBeDisabled();
    await reloaded.clear(screen.getByLabelText("Pull request URL"));
    await reloaded.type(screen.getByLabelText("Pull request URL"), url(902));
    expect(importButton()).toHaveTextContent("Import");
    expect(importButton()).toBeEnabled();
    hold.release();
    const link = await within(activity()).findByRole("link", { name: "Imported #901" });
    expect(link.getAttribute("href")).toBe(`#/pr/${backend.prs.find((p) => p.number === 901)!.id}`);
    expect(backend.importCalls).toEqual([url(901)]);
    await reloaded.click(screen.getByRole("button", { name: "Dismiss import of #901" }));
    expect(within(activity()).queryByText(/#901/)).not.toBeInTheDocument();
    reloaded.unmount();
  });

  it("runs sync alongside independent imports and settles each on its own", async () => {
    const user = mount();
    await ready();
    const sync = backend.hold("sync");
    const first = backend.hold(903);
    const second = backend.hold(904);
    await user.click(syncButton());
    await sync.entered;
    await user.type(screen.getByLabelText("Pull request URL"), url(903));
    await user.click(importButton());
    await first.entered;
    await user.clear(screen.getByLabelText("Pull request URL"));
    await user.type(screen.getByLabelText("Pull request URL"), url(904));
    expect(importButton()).toBeEnabled();
    await user.click(importButton());
    await second.entered;
    const reloaded = remount(user);
    await ready();
    await waitFor(() => expect(activity()).toHaveTextContent(/Importing #904/));
    expect(activity()).toHaveTextContent(/Importing #903/);
    expect(syncButton()).toBeDisabled();
    first.fail("Inert import failure");
    await screen.findByText(/Import of #903 failed/);
    expect(activity()).toHaveTextContent(/Importing #904/);
    expect(syncButton()).toBeDisabled();
    sync.release();
    await waitFor(() => expect(syncButton()).toBeEnabled());
    expect(activity()).toHaveTextContent(/Importing #904/);
    second.release();
    await within(activity()).findByRole("link", { name: "Imported #904" });
    const failure = screen.getByText(/Import of #903 failed/).closest(".notice")!;
    expect(failure).toHaveTextContent("Inert import failure");
    await reloaded.click(within(failure as HTMLElement).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(window.location.hash).toBe(
        `#/pr/${encodeURIComponent(backend.prs.find((p) => p.number === 903)!.id)}`,
      ),
    );
    expect(backend.syncCalls).toBe(1);
    expect(backend.importCalls).toEqual([url(903), url(904), url(903)]);
    reloaded.unmount();
  });

  it("reconciles a lost sync request from state without replaying it", async () => {
    const user = mount();
    await ready();
    const hold = backend.hold("sync");
    const mocked = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      if (String(input) === "/api/sync") {
        void mocked(input, init);
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return mocked(input, init);
    };
    await user.click(syncButton());
    await hold.entered;
    await screen.findByText(/Lost contact with the backend while syncing/);
    await waitFor(() => expect(syncButton()).toBeDisabled());
    expect(activity()).toHaveTextContent(/Syncing with GitHub/);
    globalThis.fetch = mocked;
    hold.release();
    await waitFor(() => expect(syncButton()).toBeEnabled());
    expect(activity()).toHaveTextContent(/Last sync completed/);
    expect(backend.syncCalls).toBe(1);
  });

  it("returns to idle after a service restart without claiming success", async () => {
    const user = mount();
    await ready();
    const sync = backend.hold("sync");
    const imported = backend.hold(905);
    await user.click(syncButton());
    await sync.entered;
    await user.type(screen.getByLabelText("Pull request URL"), url(905));
    await user.click(importButton());
    await imported.entered;
    sync.drop();
    imported.drop();
    await screen.findByText(/Lost contact with the backend/);
    await waitFor(() => expect(syncButton()).toBeEnabled());
    expect(importButton()).toBeEnabled();
    expect(activity()).toHaveTextContent("");
    expect(screen.queryByText(/Synced with GitHub|Last sync completed|Imported #905/)).toBeNull();
    expect(backend.syncCalls).toBe(1);
    expect(backend.importCalls).toEqual([url(905)]);
  });

  it("does not relabel another repository's operations as current work", async () => {
    mount({}, (b) => {
      b.syncOperation = {
        id: "sync-old",
        repository: "acme/legacy",
        mode: "scheduled",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
      };
      b.importOperations.set("acme/legacy#7", {
        id: "import-old",
        repository: "acme/legacy",
        prId: "acme/legacy#7",
        number: 7,
        status: "failed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: "Old repository failure",
      });
    });
    await ready();
    expect(activity()).toHaveTextContent(/Finishing a sync of acme\/legacy started/);
    expect(syncButton()).toBeDisabled();
    expect(screen.queryByText(/Old repository failure|#7/)).not.toBeInTheDocument();
  });
});

describe("pull request detail", () => {
  beforeEach(() => {
    window.location.hash = "#/pr/pr-482";
  });

  it("edits, saves, and protects unsaved edits", async () => {
    const user = mount();
    const body = await screen.findByLabelText(/GitHub review body/);
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    await user.clear(body);
    await user.type(body, "Rewritten summary");
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    window.location.hash = "#/";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(window.location.hash).toBe("#/pr/pr-482"));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(backend.detail("pr-482").draft).toMatchObject({
      version: 4,
      body: "Rewritten summary",
    });
  });

  it("shows the overview read-only, keeps it on save, and never posts it or evidence", async () => {
    const user = mount();
    const overview = await screen.findByRole("note", { name: /^Overview/ });
    expect(overview.querySelector("textarea, input")).toBeNull();
    expect(overview).toHaveTextContent("buildInvoice now computes");
    expect(overview.querySelector("code")).toHaveTextContent("buildInvoice");
    const body = screen.getByLabelText(/^GitHub review body/);
    await user.clear(body);
    await user.type(body, "Rewritten body");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    const saved = backend.detail("pr-482").draft!;
    expect(saved.body).toBe("Rewritten body");
    expect(saved.overview).toBe(backend.runs["pr-482"]![1]!.result!.overview);
    expect(saved.findings[0]!.evidence).toBe(
      "lineItems.forEach((item) => { item.amount -= discount })",
    );
    const first = screen.getByRole("group", { name: "Finding 1" });
    const evidence = within(first).getByRole("note", { name: /Evidence/ });
    expect(evidence.querySelector("textarea, input")).toBeNull();
    expect(evidence).toHaveTextContent("lineItems.forEach");
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    const raw = await within(dialog).findByTestId("payload-body");
    expect(raw).toHaveTextContent("Rewritten body");
    expect(raw).not.toHaveTextContent("lineItems.forEach");
    expect(raw).not.toHaveTextContent("buildInvoice now computes");
  });

  it("renders every section of a three-part overview read-only and keeps it out of the payload", async () => {
    const user = mount();
    const overview = await screen.findByRole("note", { name: /^Overview/ });
    expect(
      within(overview)
        .getAllByRole("heading")
        .map((h) => [h.tagName, h.textContent]),
    ).toEqual([
      ["H2", "Ticket intent"],
      ["H2", "What the PR does"],
      ["H2", "Ticket coverage"],
    ]);
    expect(within(overview).getAllByRole("list")).toHaveLength(3);
    expect(within(overview).getAllByRole("listitem")).toHaveLength(8);
    expect(overview).toHaveTextContent("Unverified: whether 5% matches the ticket");
    expect(overview.querySelector("textarea, input, [contenteditable]")).toBeNull();
    expect(screen.getByLabelText(/^GitHub review body/)).not.toHaveValue(
      expect.stringContaining("Ticket"),
    );
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    const raw = await within(dialog).findByTestId("payload-body");
    for (const text of ["Ticket intent", "What the PR does", "Ticket coverage", "Unverified"])
      expect(raw).not.toHaveTextContent(text);
    expect(backend.detail("pr-482").draft!.overview).toBe(
      backend.runs["pr-482"]![1]!.result!.overview,
    );
  });

  it("shows an overview whose ticket context is explicitly unavailable", async () => {
    mount(undefined, (b) => {
      b.drafts["pr-482"]![0]!.overview = [
        "## Ticket intent",
        "- Ticket context unavailable: no linked ticket or issue was found.",
        "## What the PR does",
        "- `buildInvoice` subtracts a discount.",
        "## Ticket coverage",
        "- Unverified: everything, because no ticket was available.",
      ].join("\n");
    });
    const overview = await screen.findByRole("note", { name: /^Overview/ });
    expect(within(overview).getAllByRole("heading")).toHaveLength(3);
    expect(overview).toHaveTextContent("Ticket context unavailable");
    expect(overview).toHaveTextContent("Unverified: everything");
  });

  it("explains a legacy draft without an overview instead of offering an editor", async () => {
    const user = mount();
    await screen.findByRole("note", { name: /^Overview/ });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Review draft" }),
      drafts["pr-482"]![1]!.id,
    );
    const overview = await screen.findByRole("note", { name: /^Overview/ });
    expect(overview).toHaveTextContent(
      "This review was generated before overviews existed, so none was recorded. A new full review produces one.",
    );
    expect(overview.querySelector("textarea, input")).toBeNull();
  });

  it("renders overview and evidence as readable as the comment body", async () => {
    mount();
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(`${__dirname}/styles.css`, "utf8");
    document.head.append(sheet);
    const finding = await screen.findByRole("group", { name: "Finding 1" });
    const comment = getComputedStyle(within(finding).getByLabelText("Comment"));
    const evidence = within(finding).getByRole("note", { name: /Evidence/ });
    const overview = screen.getByRole("note", { name: /^Overview/ });
    for (const note of [evidence, overview]) {
      expect(note).toHaveClass("context");
      const markdown = getComputedStyle(note.querySelector(".markdown")!);
      expect(markdown.fontSize).toBe(comment.fontSize);
      expect(markdown.lineHeight).toBe(comment.lineHeight);
      expect(getComputedStyle(note).color).toBe(comment.color);
    }
    sheet.remove();
  });

  it("adds, toggles, and removes findings", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Add finding" }));
    const fourth = screen.getByLabelText("Finding 4");
    await user.type(within(fourth).getByLabelText("Comment"), "New concern");
    await user.click(within(fourth).getByRole("radio", { name: "Blocking" }));
    await user.click(
      within(screen.getByLabelText("Finding 1")).getByRole("checkbox", { name: "Include" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove finding 2" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    const saved = backend.detail("pr-482").draft!;
    expect(saved.findings.map((f) => [f.body, f.severity, f.included])).toEqual([
      [expect.stringContaining("applyDiscount"), "blocking", false],
      [expect.stringContaining("migration"), "non_blocking", false],
      ["New concern", "blocking", true],
    ]);
  });

  it("rejects a stale save and offers the latest draft", async () => {
    const user = mount();
    const body = await screen.findByLabelText(/GitHub review body/);
    await user.type(body, " plus local edit");
    const remote = backend.detail("pr-482").draft!;
    backend.saveDraft("pr-482", { ...toUpdate(remote), body: "Changed remotely" });
    expect(await screen.findByText(/Draft changed elsewhere/)).toBeInTheDocument();
    expect(screen.getByLabelText(/GitHub review body/)).toHaveValue(
      `${remote.body} plus local edit`,
    );
    await user.click(screen.getByRole("button", { name: "Load latest, discard my edits" }));
    expect(screen.getByLabelText(/GitHub review body/)).toHaveValue("Changed remotely");
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
  });

  it("opens the latest draft by default and keeps older drafts selectable", async () => {
    const user = mount();
    const select = await screen.findByRole("combobox", { name: "Review draft" });
    expect(select).toHaveValue("draft-482");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Review 2 · 9b8d7e2 · v3 · latest",
      "Review 1 · 1111111 · v2 · older review · outdated commit",
    ]);
    expect(screen.getByRole("region", { name: "Status" })).toHaveTextContent(
      "Review 2 · 9b8d7e2 · v3 · latest",
    );
    await user.selectOptions(select, "draft-482-old");
    expect(screen.getByLabelText(/GitHub review body/)).toHaveValue(
      "Older hand-edited body from the first review.",
    );
    expect(screen.getByText("A newer review draft is available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Status" })).toHaveTextContent(
      "older review · outdated commit",
    );
    await user.type(screen.getByLabelText(/GitHub review body/), " edited");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    const after = backend.detail("pr-482");
    expect(after.draft?.id).toBe("draft-482");
    expect(after.drafts[1]).toMatchObject({ id: "draft-482-old", version: 3 });
    expect(after.pr.blockingCount).toBe(1);
    await user.click(screen.getByRole("button", { name: "Open latest draft" }));
    expect(screen.getByRole("combobox", { name: "Review draft" })).toHaveValue("draft-482");
    expect(screen.queryByText("A newer review draft is available.")).not.toBeInTheDocument();
    const runs = screen.getByRole("region", { name: "Runs" });
    expect(within(runs).getByText("editing").closest("summary")).toHaveTextContent("9b8d7e2");
    expect(within(runs).queryByRole("button", { name: /Adopt/ })).not.toBeInTheDocument();
  });

  it("keeps the open editor when a re-review completes and offers the new draft", async () => {
    const user = mount();
    const body = await screen.findByLabelText(/GitHub review body/);
    await user.type(body, " mid-review edit");
    await user.click(screen.getByRole("button", { name: "Re-review" }));
    expect(await screen.findByText(/queued a review/)).toBeInTheDocument();
    await waitFor(() => expect(backend.detail("pr-482").drafts).toHaveLength(3));
    expect(screen.getByRole("combobox", { name: "Review draft" })).toHaveValue("draft-482");
    expect(screen.getByLabelText(/GitHub review body/)).toHaveValue(
      `${backend.detail("pr-482").drafts[1]!.body} mid-review edit`,
    );
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    expect(await screen.findByText("A newer review draft is available.")).toBeInTheDocument();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "Open latest draft" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Review draft" })).toHaveValue("draft-482");
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Open latest draft" }));
    confirm.mockRestore();
    expect((screen.getByLabelText(/GitHub review body/) as HTMLTextAreaElement).value).toContain(
      "Re-review of",
    );
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(backend.detail("pr-482").drafts[1]?.version).toBe(3);
  });

  it("keeps AI revisions as proposals until accepted", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.type(screen.getByLabelText("Ask AI to revise"), "Tighten wording");
    await user.click(screen.getByRole("checkbox", { name: "2. src/billing/invoice.ts" }));
    await user.click(screen.getByRole("button", { name: "Request revision" }));
    const proposal = await screen.findByRole("region", { name: "AI proposal" });
    expect(within(proposal).getByText(/Pending · based on v3/)).toBeInTheDocument();
    expect(within(proposal).getAllByText(/revised: Tighten wording/)).toHaveLength(1);
    expect(
      (screen.getByLabelText(/GitHub review body/) as HTMLTextAreaElement).value,
    ).not.toContain("Tighten");
    await user.click(within(proposal).getByRole("button", { name: "Accept into draft" }));
    await waitFor(() => expect(backend.detail("pr-482").draft?.version).toBe(4));
    expect(screen.queryByRole("region", { name: "AI proposal" })).not.toBeInTheDocument();
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(
      (within(screen.getByLabelText("Finding 2")).getByLabelText("Comment") as HTMLTextAreaElement)
        .value,
    ).toContain("revised: Tighten wording");
  });

  it("marks proposals stale after the draft moves and offers regeneration", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.type(screen.getByLabelText("Ask AI to revise"), "Shorten");
    await user.click(screen.getByRole("button", { name: "Request revision" }));
    await screen.findByRole("region", { name: "AI proposal" });
    const remote = backend.detail("pr-482").draft!;
    backend.saveDraft("pr-482", { ...toUpdate(remote), body: "Moved on" });
    expect(await screen.findByText(/Stale · based on v3/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept into draft" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Regenerate against v4/ }));
    expect(await screen.findByText(/Pending · based on v4/)).toBeInTheDocument();
  });

  it("previews the exact payload and submits only from the confirmation control", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    const raw = await within(dialog).findByTestId("payload-body");
    expect(raw).toHaveTextContent('"event": "REQUEST_CHANGES"');
    expect(raw).toHaveTextContent('"commit_id": "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d"');
    expect(raw).toHaveTextContent("**Blocking.** `applyDiscount` mutates");
    expect(raw).toHaveTextContent("**Non-blocking.** `src/billing/invoice.ts:58` Rounding happens");
    const summary = within(dialog).getByTestId("preview-summary");
    expect(summary).toHaveTextContent("2 findings (1 blocking, 1 non-blocking)");
    expect(summary).toHaveTextContent("1 inline");
    expect(summary).toHaveTextContent("1 in body");
    expect(within(dialog).getByText("src/billing/invoice.ts:42")).toBeInTheDocument();
    expect(within(dialog).getByText(/invoice\.ts:58 \(not in this diff\)/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Evidence/)).not.toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: /Submit request changes to GitHub/ });
    expect(submit).toBeEnabled();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(backend.submissions["pr-482"]).toBeUndefined();
    const payload = JSON.parse(raw.textContent!);
    await user.click(submit);
    expect(await within(dialog).findByText("View on GitHub")).toBeInTheDocument();
    expect(backend.submissions["pr-482"]).toHaveLength(1);
    expect(backend.submissions["pr-482"]![0]!.payload).toEqual(payload);
    const close = within(dialog).getByRole("button", { name: "Close" });
    const back = within(dialog).getByRole("button", { name: "Back to Inbox" });
    expect(close).not.toHaveClass("primary");
    expect(back).toHaveClass("primary");
    expect(close.nextElementSibling).toBe(back);
    await user.click(close);
    expect(window.location.hash).toBe("#/pr/pr-482");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Preview and submit" })).toHaveAttribute(
      "title",
      "This draft has already been submitted",
    );
    expect(screen.queryByText("Nothing has been sent to GitHub.")).not.toBeInTheDocument();
  });

  it("labels a pre-write submission-check failure separately from preview failure", async () => {
    const user = mount(undefined, (b) => {
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) => {
        if (path.endsWith("/submit"))
          throw new MockError(500, "Exact inline review placement unavailable", "internal_error");
        return handle(method, path, body);
      };
    });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    await user.click(within(dialog).getByRole("button", { name: /Submit request changes/ }));
    expect(await within(dialog).findByText("Submission failed.")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Exact inline review placement unavailable"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Preview failed.")).not.toBeInTheDocument();
    expect(backend.submissions["pr-482"]).toBeUndefined();
    expect(within(dialog).getByRole("button", { name: "Submit review to GitHub" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the successful result and returns to the inbox with its primary action", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    await user.click(within(dialog).getByRole("button", { name: /Submit request changes/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Back to Inbox" }));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /#482/ }));
    await screen.findByLabelText(/GitHub review body/);
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
  });

  it("keeps cancel publication-free and disables confirmation while submitting", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    const user = mount(undefined, (b) => {
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) => {
        if (path.endsWith("/submit")) {
          writes++;
          return gate.then(() => handle(method, path, body));
        }
        return handle(method, path, body);
      };
    });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    let dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(writes).toBe(0);
    expect(backend.submissions["pr-482"]).toBeUndefined();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    await user.click(within(dialog).getByRole("button", { name: /Submit request changes/ }));
    expect(within(dialog).getByRole("button", { name: "Submitting" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(writes).toBe(1);
    release();
    expect(await within(dialog).findByRole("button", { name: "Back to Inbox" })).toBeEnabled();
    expect(writes).toBe(1);
  });

  it("allows saved edits and new re-review drafts after a settled submission", async () => {
    const user = mount(undefined, (b) => {
      const draft = b.detail("pr-482").draft!;
      b.submit("pr-482", b.preview("pr-482", draft.id, draft.version).id);
    });
    const body = await screen.findByLabelText(/GitHub review body/);
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    await user.type(body, " Saved edit after submission");
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    const saved = backend.detail("pr-482").draft!;
    backend.submit("pr-482", backend.preview("pr-482", saved.id, saved.version).id);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled(),
    );
    await user.click(screen.getByRole("button", { name: "Re-review" }));
    await user.click(await screen.findByRole("button", { name: "Open latest draft" }));
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    expect(backend.detail("pr-482").drafts[1]!.body).toBe(saved.body);
    expect(backend.detail("pr-482").draft!.id).not.toBe(saved.id);
  });

  it("does not block another same-head draft just because the latest one is submitted", async () => {
    const user = mount(undefined, (b) => {
      const latest = b.detail("pr-482").draft!;
      b.drafts["pr-482"]![1]!.headSha = latest.headSha;
      b.submit("pr-482", b.preview("pr-482", latest.id, latest.version).id);
    });
    await screen.findByLabelText(/GitHub review body/);
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Review draft" }),
      "draft-482-old",
    );
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    expect(Object.values(backend.previews).at(-1)!.draftId).toBe("draft-482-old");
  });

  it("shows failed results without success navigation and permits a fresh preview", async () => {
    const user = mount({ submitOutcome: "failed" });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    await user.click(within(dialog).getByRole("button", { name: /Submit request changes/ }));
    expect(await within(dialog).findByText("The review was not created.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Back to Inbox" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
  });

  it("does not retry a rejected submit request and keeps the draft editable", async () => {
    let writes = 0;
    const user = mount(undefined, (b) => {
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) => {
        if (path.endsWith("/submit")) {
          writes++;
          throw new MockError(409, "Draft changed after preview", "stale_preview");
        }
        return handle(method, path, body);
      };
    });
    const body = await screen.findByLabelText(/GitHub review body/);
    const original = (body as HTMLTextAreaElement).value;
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    await user.click(within(dialog).getByRole("button", { name: /Submit request changes/ }));
    expect(await within(dialog).findByText(/Cannot submit this draft/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Submit review/ })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Back to Inbox" })).not.toBeInTheDocument();
    expect(writes).toBe(1);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(body).toHaveValue(original);
    await user.type(body, " manual edit");
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
  });

  it("shows an uncertain submission as unresolved, not successful", async () => {
    const user = mount({ submitOutcome: "uncertain" });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("payload-body");
    await user.click(within(dialog).getByRole("button", { name: /Submit request changes/ }));
    expect(await within(dialog).findByText(/GitHub's answer was lost/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Back to Inbox" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(await screen.findByText("Last submission is unresolved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    expect(backend.detail("pr-482").pr.status).not.toBe("submitted");
  });

  it("blocks preview for a stale draft with a clear conflict", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    const remote = backend.detail("pr-482").draft!;
    backend.drafts["pr-482"]![0] = { ...remote, version: remote.version + 5 };
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Cannot submit this draft/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Submit/ })).toBeDisabled();
  });

  it("jumps to the exact diff line and reports lines outside the diff", async () => {
    const user = mount();
    await screen.findByLabelText(/GitHub review body/);
    const scrolls: string[] = [];
    Element.prototype.scrollIntoView = function () {
      scrolls.push((this as HTMLElement).getAttribute("data-new") ?? this.id);
    };
    const finding = screen.getByRole("group", { name: "Finding 1" });
    await user.click(within(finding).getByRole("link", { name: "Show in diff" }));
    expect(scrolls).toEqual(["42"]);
    const row = document.querySelector('tr[data-new="42"]')!;
    expect(row).toHaveClass("target");
    expect(row.closest("details")).toHaveProperty("open", true);
    await user.click(within(finding).getByRole("link", { name: "Show in diff" }));
    expect(scrolls).toEqual(["42", "42"]);
    const second = screen.getByRole("group", { name: "Finding 2" });
    await user.click(within(second).getByRole("link", { name: "Show in diff" }));
    expect(scrolls).toHaveLength(2);
    expect(
      within(second).getByText("Line 58 of src/billing/invoice.ts is not in this diff."),
    ).toBeInTheDocument();
    await user.clear(within(second).getByLabelText("Line"));
    await user.type(within(second).getByLabelText("Line"), "37");
    await user.click(within(second).getByRole("link", { name: "Show in diff" }));
    expect(scrolls).toEqual(["42", "42", "37"]);
  });

  it("keeps the verdict control inline and lets editors grow with content", async () => {
    mount();
    const verdict = await screen.findByRole("radiogroup", { name: "Verdict" });
    expect(verdict.parentElement).toHaveClass("inline");
    const comment = within(screen.getByRole("group", { name: "Finding 1" })).getByLabelText(
      "Comment",
    );
    expect(comment).toHaveClass("auto");
    expect(
      within(screen.getByRole("group", { name: "Finding 1" })).getByRole("note", {
        name: /Evidence/,
      }),
    ).toHaveClass("context");
  });

  it("sizes the origin select to the full segmented control height", async () => {
    mount();
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(`${__dirname}/styles.css`, "utf8");
    document.head.append(sheet);
    const finding = await screen.findByRole("group", { name: "Finding 1" });
    const origin = within(finding).getByRole("combobox", { name: "Origin for finding 1" });
    expect(origin).toHaveClass("select", "finding-origin");
    expect(origin).not.toHaveAttribute("style");
    expect(getComputedStyle(origin).height).toBe("32px");
    expect(getComputedStyle(origin).fontSize).toBe("12px");
    expect(origin).toHaveValue("introduced");
    sheet.remove();
  });

  it("labels the status state with a colored dot and text", async () => {
    mount();
    const status = await screen.findByRole("region", { name: "Status" });
    const state = within(status).getByText("Ready");
    expect(state).toHaveClass("status-dot");
    expect(state).toHaveAttribute("data-tone", "ok");
    expect(state.querySelector(".dot")).toHaveAttribute("aria-hidden", "true");
  });

  it("lists merge blockers with links in the Status card without touching the draft state", async () => {
    mount();
    window.location.hash = "#/pr/pr-468";
    const status = await screen.findByRole("region", { name: "Status" });
    await within(status).findByText("Blocked");
    expect(within(status).getByText("Failed")).toHaveClass("status-dot");
    expect(within(status).getByText("Blocked")).toHaveAttribute("data-tone", "danger");
    const reasons = within(status).getByRole("list", { name: "Merge blockers" });
    const items = within(reasons).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "merge conflicts with the base branch",
      "3 required checks failed",
      "1 check failed (not required)",
      "1 check pending (not required)",
    ]);
    expect(within(items[1]!).getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/acme/rocket/pull/468/checks",
    );
    expect(within(items[1]!).getByRole("link")).toHaveAttribute("title", "build, lint, typecheck");
    expect(items[2]).toHaveAttribute("data-required", "false");
    expect(within(status).getByRole("link", { name: "View on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/rocket/pull/468",
    );
  });

  it("marks readiness stale for an older head and refreshes it on the next check", async () => {
    const newHead = "f00d1234567890abcdef1234567890abcdef1234";
    mount({ remoteHead: { "pr-482": newHead }, readiness: "blocked" });
    window.location.hash = "#/pr/pr-482";
    const status = await screen.findByRole("region", { name: "Status" });
    await within(status).findByText("Blocked");
    expect(within(status).getByText("1 required check pending")).toBeInTheDocument();
    expect(backend.prs.find((p) => p.id === "pr-482")!.mergeReadiness!.headSha).toBe(newHead);
    expect(within(status).queryByText(/Stale/)).not.toBeInTheDocument();
  });

  it("shows stale evidence for an older head instead of a green state", async () => {
    mount();
    window.location.hash = "#/pr/pr-475";
    const status = await screen.findByRole("region", { name: "Status" });
    await within(status).findByText(/Stale, was blocked on deadbee/);
    expect(within(status).getByText(/Stale, was blocked/)).toHaveAttribute("data-tone", "warn");
    expect(within(status).getByText("changes requested")).toBeInTheDocument();
    expect(within(status).getByText(/the next check refreshes it/)).toBeInTheDocument();
  });

  it("turns a failed same-head lookup into Unknown with the last known result, then restores Ready", async () => {
    const user = mount({ readiness: ["ready", "error", "error", "ready"] });
    window.location.hash = "#/pr/pr-482";
    const status = await screen.findByRole("region", { name: "Status" });
    await waitFor(() => expect(backend.checkCalls).toBe(1));
    const current = () => backend.prs.find((p) => p.id === "pr-482")!.mergeReadiness!;
    expect(within(status).getByText("Ready to merge")).toHaveAttribute("data-tone", "ok");
    expect(within(status).queryByRole("alert")).not.toBeInTheDocument();
    const okCheckedAt = current().checkedAt;
    window.location.hash = "#/";
    await screen.findByText("Apply volume discounts on invoices");
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    const hint = () =>
      screen
        .getByText("Apply volume discounts on invoices")
        .closest(".pr-row")!
        .querySelector(".merge-hint")!;
    await waitFor(() =>
      expect(hint()).toHaveTextContent(
        "Merge: Unknown, last check failed · last known ready to merge",
      ),
    );
    expect(hint()).toHaveAttribute("data-tone", "neutral");
    expect(current()).toMatchObject({ state: "unknown", blockers: [] });
    expect(current().lastKnown?.checkedAt).toBe(okCheckedAt);
    expect(current().checkedAt).not.toBe(okCheckedAt);
    window.location.hash = "#/pr/pr-482";
    const failed = await screen.findByRole("region", { name: "Status" });
    await within(failed).findByRole("alert");
    expect(within(failed).queryByText("Ready to merge")).not.toBeInTheDocument();
    expect(within(failed).getByText("Unknown")).toHaveAttribute("data-tone", "neutral");
    expect(within(failed).getByRole("alert")).toHaveTextContent(/rate limit exceeded/);
    expect(within(failed).getByText(/Last known: Ready to merge, checked/)).toBeInTheDocument();
    expect(within(failed).getByText(/^Last check /)).toBeInTheDocument();
    expect(within(failed).getByRole("link", { name: "View on GitHub" })).toBeInTheDocument();
    window.location.hash = "#/";
    await screen.findByText("Apply volume discounts on invoices");
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(hint()).toHaveTextContent("Merge: Ready to merge"));
    expect(hint()).toHaveAttribute("data-tone", "ok");
    expect(current()).toMatchObject({ state: "ready", error: null, lastKnown: null });
    window.location.hash = "#/pr/pr-482";
    const restored = await screen.findByRole("region", { name: "Status" });
    await within(restored).findByText("Ready to merge");
    expect(within(restored).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(restored).queryByText(/Last known/)).not.toBeInTheDocument();
  });

  it("explains merged and closed pull requests instead of readiness", async () => {
    mount({}, (b) => {
      const pr = b.prs.find((p) => p.id === "pr-471")!;
      pr.state = "MERGED";
    });
    window.location.hash = "#/pr/pr-471";
    const status = await screen.findByRole("region", { name: "Status" });
    await within(status).findByText("Merged");
    expect(within(status).queryByRole("list", { name: "Merge blockers" })).not.toBeInTheDocument();
  });

  it("keeps the status list flush with the card body padding", async () => {
    mount();
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(`${__dirname}/styles.css`, "utf8");
    document.head.append(sheet);
    const status = await screen.findByRole("region", { name: "Status" });
    const list = status.querySelector("dl.kv.status") as HTMLElement;
    const margins = getComputedStyle(list);
    expect(margins.marginTop).toBe("0px");
    expect(margins.marginBottom).toBe("0px");
    sheet.remove();
  });

  it("renders a short description without an expand control", async () => {
    mount();
    const description = await screen.findByRole("region", { name: "Description" });
    expect(within(description).getByText(/Adds a 5% discount/)).toBeInTheDocument();
    expect(
      within(description).queryByRole("button", { name: "Read full description" }),
    ).not.toBeInTheDocument();
  });

  it("renders long Markdown safely and opens the full description", async () => {
    window.location.hash = "#/pr/pr-479";
    const heights = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("description-preview") ? 900 : 0;
      });
    const user = mount();
    const description = await screen.findByRole("region", { name: "Description" });
    expect(within(description).getByRole("heading", { name: "What this changes" })).toBeVisible();
    const link = within(description).getByRole("link", { name: "the runbook" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer nofollow");
    expect(within(description).getByRole("link", { name: /retry graph/ })).toHaveAttribute(
      "href",
      "https://example.com/retry.png",
    );
    expect(within(description).queryByRole("img")).not.toBeInTheDocument();
    expect(description.querySelector("script")).toBeNull();
    expect(description.textContent).not.toMatch(/alert|hidden comment/);
    expect(within(description).getByRole("table")).toBeInTheDocument();
    expect(within(description).getByText("0-500ms")).toBeInTheDocument();
    expect(description.querySelector("pre code")?.textContent).toContain("Math.random()");
    await user.click(within(description).getByRole("button", { name: "Read full description" }));
    const dialog = await screen.findByRole("dialog", { name: "Description" });
    expect(within(dialog).getByRole("heading", { name: "Rollout" })).toBeInTheDocument();
    expect(description).not.toContainElement(dialog);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    heights.mockRestore();
  });

  it("keeps header actions from shrinking while a review is in progress", async () => {
    window.location.hash = "#/pr/pr-479";
    mount();
    const sheet = document.createElement("style");
    sheet.textContent = readFileSync(`${__dirname}/styles.css`, "utf8");
    document.head.append(sheet);
    const review = await screen.findByRole("button", { name: "Review in progress" });
    expect(review).toBeDisabled();
    const actions = review.parentElement as HTMLElement;
    expect(actions).toHaveClass("actions");
    expect(within(actions).getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    expect(getComputedStyle(actions).flexShrink).toBe("0");
    const title = actions.previousElementSibling as HTMLElement;
    expect(title).toHaveClass("pr-title");
    expect(getComputedStyle(title).flexGrow).toBe("1");
    expect(getComputedStyle(title).minWidth).toMatch(/^0(px)?$/);
    sheet.remove();
  });

  it("explains outdated and failed states", async () => {
    window.location.hash = "#/pr/pr-475";
    mount();
    expect(await screen.findByText("The latest review is stale.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    window.location.hash = "#/pr/pr-468";
    expect(
      await screen.findByText("The last review failed.", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("alert")
        .map((el) => el.textContent)
        .join(" "),
    ).toMatch(/malformed structured output/);
  });
});

const NEW_HEAD = "feedface00000000000000000000000000000001";

describe("freshness", () => {
  beforeEach(() => {
    window.location.hash = "#/pr/pr-475";
  });

  it("lists the new commits behind a collapsed disclosure that survives a refresh", async () => {
    const user = mount();
    const toggle = await screen.findByText(/Show 2 new commits since deadbee/);
    const notice = toggle.closest(".notice")!;
    expect(notice).toHaveTextContent("The latest review is stale.");
    expect(notice).toHaveTextContent(/Reviewed deadbee, the head is now c0ffee1/);
    expect(within(notice as HTMLElement).getByRole("group")).not.toHaveAttribute("open");
    await user.click(toggle);
    expect(screen.getByText(/Hide 2 new commits since deadbee/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "New commits" });
    expect(list).toHaveAttribute("tabindex", "0");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Backfill session ids in batches");
    expect(items[0]).not.toHaveTextContent("Avoids locking");
    expect(within(items[0]!).getByRole("link", { name: "a1b2c3d" })).toHaveAttribute(
      "href",
      "https://github.com/acme/rocket/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    );
    expect(items[1]).toHaveTextContent("Rename index to sessions_uuid_idx");
    expect(within(items[1]!).getByRole("link", { name: "c0ffee1" })).toBeInTheDocument();
    expect(notice).toHaveTextContent(/Checked just now/);
    expect(screen.getByRole("region", { name: "Status" })).toHaveTextContent(/Head check\s*stale/);
    expect(backend.checkCalls).toBe(1);

    await user.click(within(notice as HTMLElement).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(backend.checkCalls).toBe(2));
    expect(screen.getByText(/Hide 2 new commits since deadbee/)).toBeInTheDocument();
    expect(within(notice as HTMLElement).getByRole("group")).toHaveAttribute("open");
    await user.click(screen.getByText(/Hide 2 new commits/));
    await user.click(within(notice as HTMLElement).getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(backend.checkCalls).toBe(3));
    expect(screen.getByText(/Show 2 new commits since deadbee/)).toBeInTheDocument();
    expect(within(notice as HTMLElement).getByRole("group")).not.toHaveAttribute("open");
  });

  it("collapses a long truncated rewritten-history list and labels it truthfully", async () => {
    const user = mount({ freshness: "rewritten", commits: { count: 300, truncated: true } });
    const notice = (await screen.findByText(/History was rewritten/)).closest(".notice")!;
    expect(notice).toHaveTextContent("The latest review is stale.");
    expect(notice).not.toHaveTextContent(/new commits since/);
    const toggle = within(notice as HTMLElement).getByText(
      /Show the first 300 commits on the new head/,
    );
    expect(toggle).toHaveTextContent(/truncated; see GitHub for the rest/);
    expect(within(notice as HTMLElement).getByRole("group")).not.toHaveAttribute("open");
    await user.click(toggle);
    const list = within(notice as HTMLElement).getByRole("list", { name: "New commits" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(300);
    expect(list).toHaveClass("commits");
    expect(
      within(notice as HTMLElement).getByText(/Hide the first 300 commits/),
    ).toBeInTheDocument();
  });

  it("keeps the stale warning when the GitHub check fails and offers a retry", async () => {
    const user = mount({ freshness: "error" });
    const notice = (
      await screen.findByText(/GitHub check failed: gh api failed: API rate limit/)
    ).closest(".notice")!;
    expect(notice).toHaveTextContent("The latest review is stale.");
    expect(notice).toHaveTextContent(/Reviewed deadbee, the head is now c0ffee1/);
    expect(within(notice as HTMLElement).queryByRole("list")).not.toBeInTheDocument();
    const calls = backend.checkCalls;
    await user.click(within(notice as HTMLElement).getByRole("button", { name: "Retry check" }));
    await waitFor(() => expect(backend.checkCalls).toBe(calls + 1));
    expect(screen.getByText("The latest review is stale.")).toBeInTheDocument();
  });

  it("explains rewritten history instead of calling it a simple append", async () => {
    mount({ freshness: "rewritten" });
    const notice = (await screen.findByText(/History was rewritten/)).closest(".notice")!;
    expect(notice).toHaveTextContent("The latest review is stale.");
    expect(
      within(notice as HTMLElement).getByText(/Show 2 commits on the new head/),
    ).toBeInTheDocument();
    expect(notice).not.toHaveTextContent(/new commits since/);
    expect(notice).not.toHaveTextContent(/truncated/);
  });

  it("reports a baseline GitHub cannot compare as an unavailable comparison", async () => {
    mount({ freshness: "unavailable" });
    const notice = (await screen.findByText(/could not compare deadbee with/)).closest(".notice")!;
    expect(notice).toHaveTextContent("The latest review is stale.");
    expect(within(notice as HTMLElement).queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows nothing stale for a draft at the current head", async () => {
    window.location.hash = "#/pr/pr-482";
    mount();
    await screen.findByLabelText(/GitHub review body/);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Status" })).toHaveTextContent(
        /Head check\s*up to date/,
      ),
    );
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });

  it("opens the newest review's draft on entry and never calls an edited older one current", async () => {
    window.location.hash = "#/pr/pr-482";
    const user = mount(undefined, (b) => {
      const pr = b.prs.find((p) => p.id === "pr-482")!;
      pr.headSha = NEW_HEAD;
      b.drafts["pr-482"]![0]!.body = "Hand edited body";
      b.drafts["pr-482"]![0]!.updatedAt = new Date().toISOString();
      const now = new Date().toISOString();
      b.runs["pr-482"]!.push({
        ...b.runs["pr-482"]![1]!,
        id: "run-new",
        trigger: "manual",
        headSha: NEW_HEAD,
        createdAt: now,
        finishedAt: now,
        result: { ...b.runs["pr-482"]![1]!.result!, body: "Fresh review of the new head" },
      });
      b.drafts["pr-482"]!.unshift({
        ...b.drafts["pr-482"]![0]!,
        id: "draft-new",
        runId: "run-new",
        headSha: NEW_HEAD,
        version: 1,
        body: "Fresh review of the new head",
        createdAt: now,
        updatedAt: now,
      });
    });
    expect(await screen.findByLabelText(/GitHub review body/)).toHaveValue(
      "Fresh review of the new head",
    );
    expect(screen.queryByText(/is stale/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "Review draft" }), "draft-482");
    expect(screen.getByLabelText(/GitHub review body/)).toHaveValue("Hand edited body");
    expect(screen.getByText("A newer review draft is available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeDisabled();
    expect(screen.queryByText(/is stale/)).not.toBeInTheDocument();
  });

  it("groups run metadata and secondary badges into separate rows", async () => {
    window.location.hash = "#/pr/pr-482";
    let releaseCheck = () => {};
    const heldCheck = new Promise<void>((resolve) => (releaseCheck = resolve));
    mount({ remoteHead: { "pr-482": NEW_HEAD } }, (b) => {
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) =>
        path.endsWith("/check")
          ? heldCheck.then(() => handle(method, path, body))
          : handle(method, path, body);
      b.runs["pr-482"]!.push({
        ...b.runs["pr-482"]![1]!,
        id: "run-live",
        status: "running",
        headSha: NEW_HEAD,
        finishedAt: null,
        result: null,
      });
    });
    const runs = await screen.findByRole("region", { name: "Runs" });
    const running = (await within(runs).findByText("Running")).closest("summary")!;
    expect(running.querySelector(".run-meta")).toHaveTextContent(/^feedfac.*ago$/);
    expect(running.querySelector(".run-badges")).toHaveTextContent(/^older commit$/);
    releaseCheck();
    await screen.findByText("The latest review is stale.");
    expect(running.querySelector(".run-badges")).toBeNull();
    const source = within(runs).getByText("latest draft").closest("summary")!;
    expect(source.querySelector(".run-meta")).toHaveTextContent(
      /^9b8d7e2.*ago3 findings · Request changes$/,
    );
    expect(source.querySelector(".run-badges")).toHaveTextContent(
      "older commitlatest draftdraft v3editing",
    );
    expect(source.querySelector(".run-meta .pill")).toBeNull();
    const oldest = within(runs).getByText("1111111").closest("summary")!;
    expect(oldest.querySelector(".run-badges")).toHaveTextContent(/^older commitdraft v2$/);
  });

  it("re-review syncs to the latest commit and adds a new default draft", async () => {
    window.location.hash = "#/pr/pr-482";
    const user = mount({ remoteHead: { "pr-482": NEW_HEAD }, reviewDelayMs: 50 });
    await screen.findByText("The latest review is stale.");
    expect(backend.detail("pr-482").pr.headSha).toBe(NEW_HEAD);
    await user.click(screen.getByRole("button", { name: "Re-review" }));
    expect(
      await screen.findByText(/Synced to the latest commit and queued a review/),
    ).toBeInTheDocument();
    await waitFor(() => expect(backend.detail("pr-482").runs).toHaveLength(3));
    const run = backend.detail("pr-482").runs[2]!;
    expect(run.headSha).toBe(NEW_HEAD);
    expect(backend.detail("pr-482").draft).toMatchObject({
      version: 3,
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
    });
    await waitFor(() => expect(backend.detail("pr-482").runs[2]!.status).toBe("completed"));
    expect(await screen.findByText("A newer review draft is available.")).toBeInTheDocument();
    expect(screen.getByLabelText(/GitHub review body/)).toHaveValue(
      backend.detail("pr-482").drafts[1]!.body,
    );
    await waitFor(() =>
      expect(screen.queryByText("The latest review is stale.")).not.toBeInTheDocument(),
    );
    expect(backend.detail("pr-482").draft).toMatchObject({ version: 1, headSha: NEW_HEAD });
    expect(backend.detail("pr-482").drafts[1]).toMatchObject({ id: "draft-482", version: 3 });
  });

  it("does not queue a review when the refresh fails or the PR is closed", async () => {
    window.location.hash = "#/pr/pr-482";
    const user = mount({ reviewRefresh: "fail" });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Re-review" }));
    expect(
      await screen.findByText(/could not refresh the pull request before reviewing/),
    ).toBeInTheDocument();
    expect(backend.detail("pr-482").runs).toHaveLength(2);
    user.unmount();
    uninstall();
    const closed = mount({ reviewRefresh: "closed" });
    await screen.findByLabelText(/GitHub review body/);
    await closed.click(screen.getByRole("button", { name: "Re-review" }));
    expect(await screen.findByText(/no longer open, so no review was started/)).toBeInTheDocument();
    expect(backend.detail("pr-482").runs).toHaveLength(2);
    expect(await screen.findByText("closed")).toBeInTheDocument();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.queryByText("Outdated")).not.toBeInTheDocument();
  });

  it("keeps an unreviewed PR unreviewed when it closes before its first review and drops it from the inbox once the change stream refreshes", async () => {
    window.location.hash = "#/pr/pr-490";
    let releaseCheck = () => {};
    const checkAfterReview = new Promise<void>((resolve) => (releaseCheck = resolve));
    const user = mount({ reviewRefresh: "closed" }, (b) => {
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) => {
        if (path.endsWith("/check")) return checkAfterReview.then(() => handle(method, path, body));
        try {
          return handle(method, path, body);
        } finally {
          if (path.endsWith("/review")) releaseCheck();
        }
      };
    });
    const runs = backend.detail("pr-490").runs.length;
    await user.click(await screen.findByRole("button", { name: "Review now" }));
    expect(await screen.findByText(/no longer open, so no review was started/)).toBeInTheDocument();
    expect(await screen.findByText("closed")).toBeInTheDocument();
    expect(screen.getAllByText("Unreviewed").length).toBeGreaterThan(0);
    expect(screen.queryByText("Outdated")).not.toBeInTheDocument();
    expect(backend.detail("pr-490").pr.status).toBe("unreviewed");
    expect(backend.detail("pr-490").runs).toHaveLength(runs);
    window.location.hash = "#/";
    await user.click(await screen.findByRole("button", { name: /^All/ }));
    await user.click(screen.getByText("Other tracked PRs"));
    await waitFor(() =>
      expect(screen.queryByText("Add rate limit headers to public API")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Requested of your teams").closest("summary")).toHaveTextContent(
      "Requested of your teams1",
    );
    window.location.hash = "#/pr/pr-490";
    expect(await screen.findByText("closed")).toBeInTheDocument();
    expect(screen.getAllByText("Unreviewed").length).toBeGreaterThan(0);
  });

  it("checks on open only and leaves periodic checks to the backend poll", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const view = mount();
      await screen.findByText("The latest review is stale.");
      await waitFor(() => expect(backend.checkCalls).toBe(1));
      vi.advanceTimersByTime(600_000);
      await new Promise((r) => setTimeout(r, 20));
      expect(backend.checkCalls).toBe(1);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("automation", () => {
  it("shows actual queued and running PR counts and links in Settings independent of inbox collapse", async () => {
    window.location.hash = "#/settings";
    mount({ reviewControls: true }, (b) => {
      const captured = b.runs["pr-482"]![0]!;
      for (const [index, id] of ["pr-482", "pr-479"].entries()) {
        const pr = b.prs.find((pr) => pr.id === id)!;
        b.runs[id] = [
          {
            ...structuredClone(captured),
            id: `synthetic-enable-${index}`,
            prId: id,
            headSha: pr.headSha,
            kind: "review",
            status: index === 0 ? "running" : "queued",
            result: null,
          },
        ];
      }
    });
    const card = await screen.findByRole("region", { name: "Automation" });
    expect(within(card).getByRole("status")).toHaveTextContent(
      "2 PRs with review work: 1 queued, 1 reviewing. Maximum concurrent reviews: 1.",
    );
    expect(within(card).getByRole("link", { name: /^#482 / })).toHaveAttribute(
      "href",
      "#/pr/pr-482",
    );
    expect(within(card).getByRole("link", { name: /^#479 / })).toHaveAttribute(
      "href",
      "#/pr/pr-479",
    );
    expect(within(card).getByRole("link", { name: "View Inbox" })).toHaveAttribute("href", "#/");
  });

  it("edits the four global switches, gates auto-review on polling, and never flips another switch", async () => {
    window.location.hash = "#/settings";
    const user = mount();
    const card = (await screen.findByRole("region", { name: "Automation" })) as HTMLElement;
    const summary = within(card).getByTestId("global-summary");
    expect(summary).toHaveTextContent("Polling review requests; auto-reviewing requests.");
    const switches = {
      pollCommits: within(card).getByRole("switch", { name: "Poll for new commits" }),
      reviewNewCommits: within(card).getByRole("switch", { name: "Auto-review new commits" }),
      pollRequests: within(card).getByRole("switch", { name: "Poll for review requests" }),
      reviewRequests: within(card).getByRole("switch", { name: "Auto-review requests" }),
    };
    expect(switches.pollCommits).not.toBeChecked();
    expect(switches.reviewNewCommits).not.toBeChecked();
    expect(switches.pollRequests).toBeChecked();
    expect(switches.reviewRequests).toBeChecked();

    await user.click(switches.reviewNewCommits);
    await waitFor(() => expect(switches.reviewNewCommits).toBeChecked());
    expect(switches.pollCommits).not.toBeChecked();
    expect(backend.settings.automation).toEqual({
      pollCommits: false,
      reviewNewCommits: true,
      pollRequests: true,
      reviewRequests: true,
    });
    expect(within(card).getByRole("status")).toHaveTextContent(
      'Inactive until "Poll for new commits" is on',
    );
    expect(summary).toHaveTextContent("Polling review requests; auto-reviewing requests.");

    await user.click(switches.pollCommits);
    await waitFor(() => expect(switches.pollCommits).toBeChecked());
    expect(within(card).queryByRole("status")).not.toBeInTheDocument();
    expect(summary).toHaveTextContent(
      "Polling commits and review requests; auto-reviewing new commits and requests.",
    );

    await user.click(switches.pollRequests);
    await waitFor(() => expect(switches.pollRequests).not.toBeChecked());
    expect(switches.reviewRequests).toBeChecked();
    expect(within(card).getByRole("status")).toHaveTextContent(
      'Inactive until "Poll for review requests" is on',
    );
    expect(summary).toHaveTextContent("Polling commits; auto-reviewing new commits.");
    expect(card).toHaveTextContent(
      /Turning effective auto-review on refreshes and queues eligible open inbox PRs/,
    );
    expect(card).toHaveTextContent(
      /Review backlog remains an explicit local-only option for up to five PRs/,
    );
  });

  it("disables the switches until a repository is configured", async () => {
    window.location.hash = "#/settings";
    mount({ emptySetup: true });
    const card = (await screen.findByRole("region", { name: "Automation" })) as HTMLElement;
    for (const control of within(card).getAllByRole("switch")) {
      expect(control).toBeDisabled();
      expect(control).not.toBeChecked();
    }
    expect(card).toHaveTextContent("Configure a repository before turning on automation.");
  });

  it("overrides auto-review per pull request while polling stays global", async () => {
    window.location.hash = "#/pr/pr-482";
    const user = mount();
    const card = (await screen.findByRole("region", { name: "Automation" })) as HTMLElement;
    expect(within(card).getByText("Inherits")).toBeInTheDocument();
    expect(within(card).getByTestId("automation-summary")).toHaveTextContent(
      "Polling review requests; auto-reviewing requests. Inherits the global defaults.",
    );
    expect(within(card).queryByRole("radiogroup", { name: /Poll for/ })).toBeNull();
    expect(within(card).getAllByRole("link", { name: "change in Settings" })).toHaveLength(3);
    expect(
      within(within(card).getByRole("radiogroup", { name: "Automatic submission" })).getByRole(
        "radio",
        { name: "Inherit" },
      ),
    ).toBeChecked();
    const group = (name: string) => within(card).getByRole("radiogroup", { name });
    const effective = (name: string) =>
      within(card).getByLabelText(new RegExp(`^${name}: `)).textContent;
    expect(
      within(group("Auto-review new commits")).getByRole("radio", { name: "Inherit" }),
    ).toBeChecked();
    expect(effective("Auto-review new commits")).toBe("Inherit (global Off)");
    expect(effective("Auto-review requests")).toBe("Inherit (global On)");

    await user.click(within(group("Auto-review new commits")).getByRole("radio", { name: "On" }));
    await waitFor(() =>
      expect(effective("Auto-review new commits")).toBe(
        'On (this PR) · inactive because "Poll for new commits" is off globally',
      ),
    );
    expect(backend.prs.find((p) => p.id === "pr-482")!.automation).toEqual({
      reviewNewCommits: "on",
      reviewRequests: "inherit",
    });
    expect(backend.settings.automation.pollCommits).toBe(false);
    expect(backend.prs.find((p) => p.id === "pr-482")!.effectiveAutomation.reviewNewCommits).toBe(
      false,
    );
    expect(within(card).getByText("Overridden")).toBeInTheDocument();

    await user.click(within(group("Auto-review requests")).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(effective("Auto-review requests")).toBe("Off (this PR)"));
    expect(backend.prs.find((p) => p.id === "pr-482")!.effectiveAutomation).toEqual({
      pollCommits: false,
      reviewNewCommits: false,
      pollRequests: true,
      reviewRequests: false,
    });
    expect(backend.prs.find((p) => p.id === "pr-479")!.effectiveAutomation.reviewRequests).toBe(
      true,
    );

    await user.click(within(group("Auto-review requests")).getByRole("radio", { name: "Inherit" }));
    await waitFor(() => expect(effective("Auto-review requests")).toBe("Inherit (global On)"));
    expect(card).toHaveTextContent(
      /Turning effective auto-review on refreshes and queues eligible open inbox PRs/,
    );
  });

  it("summarizes background polling on the inbox from the global settings only", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      mount(undefined, (b) => {
        clock.mockReturnValue(new Date(b.health.lastPollAt!).getTime() + 180_000);
      });
      expect(await screen.findByText(/Polling every 120s, last 3m ago\./)).toBeInTheDocument();
      clock.mockReturnValue(Date.now() + 60_000);
      backend.updateAutomation("pr-475", { reviewNewCommits: "on" });
      expect(await screen.findByText(/Polling every 120s, last 4m ago\./)).toBeInTheDocument();
      backend.updateSettings({ automation: { pollRequests: false, reviewRequests: false } });
      expect(
        await screen.findByText(
          "Background polling is off. Sync manually or turn it on in Settings.",
        ),
      ).toBeInTheDocument();
    } finally {
      clock.mockRestore();
    }
  });
});

const alertWith = async (pattern: RegExp) =>
  waitFor(() => {
    const match = screen.getAllByRole("alert").find((a) => pattern.test(a.textContent ?? ""));
    expect(match).toBeDefined();
    return match!;
  });

describe("execution settings", () => {
  const calls: string[] = [];
  const record = (b: MockBackend) => {
    const handle = b.handle.bind(b);
    b.handle = (method, path, body) => {
      calls.push(`${method} ${new URL(path, "http://localhost").pathname}`);
      return handle(method, path, body);
    };
  };
  const execution = () => within(screen.getByRole("region", { name: "Execution" }));
  const mode = (name: string) => execution().getByRole("radio", { name });
  const saveButton = () => screen.getByRole("button", { name: /Save execution|Save Dangerous/ });
  const status = () => within(screen.getByLabelText("Execution status"));

  it("loads fresh Dangerous without authority, navigates canonical mode order, and explicitly saves Isolated roles", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "fresh" }, record);
    expect(await screen.findByRole("radio", { name: "Dangerous" })).toBeChecked();
    expect(
      within(screen.getByRole("radiogroup", { name: "Execution type" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Dangerous", "Isolated Harnesses", "Docker"]);
    expect(screen.queryByRole("region", { name: "Connections" })).toBeNull();
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    mode("Dangerous").focus();
    await user.tab();
    expect(mode("Isolated Harnesses")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(mode("Isolated Harnesses")).toBeChecked();
    await user.tab();
    expect(mode("Docker")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(mode("Docker")).toBeChecked();
    await user.click(mode("Isolated Harnesses"));
    expect(mode("Claude Code")).toBeChecked();
    expect(screen.getByLabelText("Main model")).toHaveValue("");
    expect(screen.getByLabelText("Review entry path")).toHaveValue(fx.SKILL_PATH);
    expect(screen.getByText("Not saved yet.")).toBeInTheDocument();
    expect(status().getByText("unavailable")).toBeVisible();
    expect(screen.getByText(/None\. Main alone performs the full review/)).toBeInTheDocument();
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(saveButton()).toBeEnabled();
    expect(screen.queryByText(/Historical compatibility/)).toBeNull();
    expect(screen.queryByText(/Legacy metadata import/)).toBeNull();
    expect(screen.queryByText(/^Diagnostics$/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Tool health" })).toBeNull();
    expect(screen.queryByTestId("docker-setup")).toBeNull();
    expect(screen.getByLabelText("GitHub health")).toHaveTextContent("Authenticated as demo-user");

    await user.click(mode("Pi"));
    await user.click(screen.getByRole("button", { name: "Add additional reviewer" }));
    await user.click(screen.getByRole("button", { name: "Add additional reviewer" }));
    await user.type(screen.getByLabelText("Additional reviewer 1 model"), "model-one");
    await user.type(screen.getByLabelText("Additional reviewer 2 model"), "model-two");
    expect(screen.getByLabelText("Additional reviewer 1 harness")).toHaveValue("codex");
    expect(screen.getByLabelText("Additional reviewer 2 harness")).toHaveValue("codex");
    const path = screen.getByLabelText("Review entry path");
    await user.clear(path);
    await user.type(path, "relative/SKILL.md");
    expect(path).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();
    await user.clear(path);
    await user.type(path, fx.CUSTOM_SKILL_PATH);
    await user.click(saveButton());
    await waitFor(() =>
      expect(backend.harness.selection).toEqual({
        version: 3,
        workflow: "separated",
        harness: "pi",
        reviewer: { skillPath: fx.CUSTOM_SKILL_PATH, model: "openai-codex/gpt-6-astra" },
        additional: [
          { id: "reviewer-1", harness: "codex", model: "model-one" },
          { id: "reviewer-2", harness: "codex", model: "model-two" },
        ],
      }),
    );
    expect(await screen.findByText("Isolated Harnesses saved for new sessions")).toBeVisible();
    expect(screen.getByLabelText("Main model")).toHaveValue("openai-codex/gpt-6-astra");
    expect(
      screen.getByText("Isolated Harnesses · Main Pi (openai-codex/gpt-6-astra) + 2 Additional"),
    ).toBeInTheDocument();
    expect(status().getByText("Isolated Harnesses")).toBeVisible();
    expect(screen.queryByText("Not saved yet.")).toBeNull();
    expect(calls.filter((c) => c.startsWith("PATCH "))).toEqual(["PATCH /api/settings/harness"]);
    expect(calls.filter((c) => c.includes("/execution/setup"))).toEqual([]);
    expect(backend.settings.automation.pollRequests).toBe(true);
    expect(saveButton()).toBeDisabled();
    expect(screen.getByTestId("capability-main")).toHaveTextContent(
      "Main · Pi · restricted-native-1",
    );
    expect(screen.getByTestId("capability-reviewer-2")).toHaveTextContent("reviewer-2 · Codex");
    expect(screen.getByText(/Selected review entry/)).toHaveTextContent(fx.CUSTOM_SKILL_PATH);
  });

  it("shows secret-free capability provenance, auth references and library scope per captured role", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved" });
    await screen.findByTestId("capabilities");
    expect(screen.getByTestId("capabilities")).toHaveTextContent(
      /disabled for these runs; leave them installed/,
    );
    expect(screen.getByTestId("capabilities")).toHaveTextContent(/not OS or process containment/);
    await user.click(within(screen.getByTestId("capability-main")).getByText(/Main/));
    const main = within(screen.getByTestId("capability-main"));
    expect(main.getByText("claude-keychain")).toBeInTheDocument();
    expect(main.getByText("Claude Code-credentials")).toBeInTheDocument();
    expect(main.getByText(/presence is not successful authentication/)).toBeInTheDocument();
    expect(main.getByText(/Static read catalog/)).toBeInTheDocument();
    expect(main.getByText("release-notes")).toBeInTheDocument();
    const provenance = main.getByLabelText("main configuration provenance");
    expect(within(provenance).getAllByText("inherited").length).toBeGreaterThan(0);
    expect(within(provenance).getAllByText("overridden").length).toBeGreaterThan(1);
    expect(within(provenance).getByText("unsupported")).toBeInTheDocument();
    expect(provenance).toHaveTextContent(/local configuration/);
    await user.click(within(screen.getByTestId("capability-reviewer-1")).getByText(/reviewer-1/));
    const additional = within(screen.getByTestId("capability-reviewer-1"));
    expect(additional.getByText("codex-file")).toBeInTheDocument();
    expect(
      within(additional.getByLabelText("reviewer-1 configuration provenance")).getByText("missing"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SYNTHETIC_ONLY|Bearer /)).toBeNull();
  });

  it("keeps an archived choice display-only with a short re-save notice and preserves typed input on a failed save", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "archived" }, record);
    expect(await screen.findByText("Archived choice cannot run.")).toBeInTheDocument();
    expect(screen.getByText("Archived choice: legacy · Claude Code")).toBeInTheDocument();
    expect(mode("Isolated Harnesses")).toBeChecked();
    expect(screen.queryByRole("radio", { name: /legacy|configured/i })).toBeNull();
    expect(saveButton()).toBeEnabled();
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);

    const path = screen.getByLabelText("Review entry path");
    await user.clear(path);
    await user.type(path, fx.MISSING_SKILL_PATH);
    await user.click(saveButton());
    await alertWith(/Selected skill is missing.*skill_incompatible/);
    expect(backend.harness.selection).toMatchObject({ workflow: "legacy" });
    expect(screen.getByLabelText("Review entry path")).toHaveValue(fx.MISSING_SKILL_PATH);
    expect(screen.getByText("Archived choice cannot run.")).toBeInTheDocument();

    await user.clear(path);
    await user.type(path, fx.SKILL_PATH);
    await user.click(saveButton());
    await waitFor(() => expect(backend.harness.selection?.version).toBe(3));
    expect(screen.queryByText("Archived choice cannot run.")).toBeNull();
    expect(backend.harness.selection).toMatchObject({ harness: "claude", additional: [] });
  });

  it("keeps unsaved Main, Additional, path and type through a background refresh and unrelated saves", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved" }, record);
    await screen.findByRole("radio", { name: "Isolated Harnesses" });
    await user.click(screen.getByRole("button", { name: "Remove additional reviewer 1" }));
    await user.clear(screen.getByLabelText("Additional reviewer 1 model"));
    await user.type(screen.getByLabelText("Additional reviewer 1 model"), "openai-codex/custom");
    await user.click(mode("Pi"));
    await user.clear(screen.getByLabelText("Review entry path"));
    await user.type(screen.getByLabelText("Review entry path"), fx.CUSTOM_SKILL_PATH);
    backend.updateSettings({ pollIntervalSeconds: 130 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(130));
    expect(mode("Pi")).toBeChecked();
    expect(screen.getAllByLabelText(/Additional reviewer \d harness/)).toHaveLength(1);
    expect(screen.getByLabelText("Additional reviewer 1 model")).toHaveValue("openai-codex/custom");
    expect(screen.getByTestId("additional-reviewer-2")).toBeInTheDocument();
    expect(screen.getByLabelText("Review entry path")).toHaveValue(fx.CUSTOM_SKILL_PATH);
    expect(backend.harness.selection).toMatchObject({ harness: "claude" });
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(mode("Claude Code")).toBeChecked();
    expect(screen.getAllByLabelText(/Additional reviewer \d harness/)).toHaveLength(2);
    expect(screen.getByLabelText("Additional reviewer 1 model")).toHaveValue("model-one");
  });

  it("shows an Isolated dependency incompatibility as a diagnostic without substituting a mode", async () => {
    window.location.hash = "#/settings";
    mount({ harness: "incompatible" });
    expect((await screen.findAllByText(/cannot execute them/)).length).toBeGreaterThan(0);
    expect(status().getByText("unavailable")).toBeVisible();
    expect(screen.getByRole("radio", { name: "Isolated Harnesses" })).toBeChecked();
    expect(backend.harness.selection?.workflow).toBe("separated");
  });

  const dockerCard = () => within(screen.getByTestId("docker-setup"));
  const dockerStatus = () => screen.getByTestId("docker-status");
  const dockerAction = () => screen.queryByTestId("docker-action");
  const dialog = () => within(screen.getByRole("dialog"));
  const checkAll = async (user: ReturnType<typeof userEvent.setup>) => {
    for (const box of dialog().getAllByRole("checkbox"))
      if (!(box as HTMLInputElement).checked) await user.click(box);
  };
  const approveButton = () => dialog().getByRole("button", { name: "Approve and continue" });
  const effectful = () => calls.filter((c) => !c.startsWith("GET "));

  it("guides an unsaved Docker choice through save, exact approval and separate host-effects consent with one action", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved" }, record);
    await screen.findByRole("radio", { name: "Isolated Harnesses" });
    expect(screen.queryByTestId("docker-setup")).toBeNull();
    await user.click(mode("Docker"));
    await user.click(mode("Codex"));
    expect(dockerStatus()).toHaveTextContent("Not saved");
    expect(
      dockerCard()
        .getAllByRole("button")
        .filter((button) => !screen.getByTestId("docker-advanced").contains(button)),
    ).toEqual([dockerAction()]);
    expect(dockerAction()).toHaveTextContent("Set up Docker");
    expect(dockerCard().queryByRole("button", { name: /Inspect/ })).toBeNull();
    expect(effectful()).toEqual([]);

    await user.click(dockerAction()!);
    expect(screen.getByRole("dialog", { name: "Set up Docker for Codex" })).toBeInTheDocument();
    expect(dialog().getByRole("list", { name: "Docker setup progress" })).toHaveTextContent(
      /Save choice.*Check.*Approve.*Set up/,
    );
    expect(dialog().getByText(/First, save Docker as your execution choice/)).toBeVisible();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(effectful()).toEqual([]);
    expect(backend.harness.selection?.workflow).toBe("separated");

    await user.click(dockerAction()!);
    await user.click(dialog().getByRole("button", { name: "Save and continue" }));
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    expect(
      await screen.findByRole("group", { name: "Approve credential exposures" }),
    ).toBeVisible();
    expect(effectful()).toEqual([
      "PATCH /api/settings/harness",
      "POST /api/settings/execution/inspect",
    ]);
    expect(backend.harness.selection?.workflow).toBe("docker");
    const pending = backend.inspected!.disclosure;
    expect(screen.getByTestId("docker-disclosure")).toHaveTextContent(pending.digest);
    expect(
      dialog().getByRole("group", { name: "Approve executable customizations" }),
    ).toHaveTextContent("/Users/demo/.codex/config.toml");
    expect(dialog().getByRole("group", { name: "Approve credential exposures" })).toHaveTextContent(
      /Codex access token from \/Users\/demo\/\.codex\/auth\.json \(present, not tested\), readable by all container code/,
    );
    expect(dialog().getByText(/Nothing is pre-approved/)).toBeVisible();
    expect(dialog().queryByText(/approved before/)).toBeNull();
    const boxes = dialog().getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(approveButton()).toBeDisabled();
    await user.click(boxes[0]!);
    expect(approveButton()).toBeDisabled();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(backend.setupCalls).toBe(0);
    expect(dockerStatus()).toHaveTextContent("Not set up");

    await user.click(dockerAction()!);
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    await screen.findByRole("group", { name: "Approve credential exposures" });
    for (const box of dialog().getAllByRole("checkbox")) expect(box).not.toBeChecked();
    await checkAll(user);
    await user.click(approveButton());
    expect(dialog().getByText(/Last step: set up the Docker runtime for Codex/)).toHaveTextContent(
      backend.inspected!.disclosure.digest.slice(0, 12),
    );
    expect(dialog().getByText(/credential-free installer container/)).toBeInTheDocument();
    expect(dialog().getByText(/does not install Docker Desktop, sign in/)).toBeInTheDocument();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(backend.setupCalls).toBe(0);

    await user.click(dockerAction()!);
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    await screen.findByRole("group", { name: "Approve credential exposures" });
    await checkAll(user);
    await user.click(approveButton());
    await user.click(dialog().getByRole("button", { name: "Set up Docker" }));
    expect(await dialog().findByText(/Docker runs new reviews with Codex/)).toBeVisible();
    expect(dialog().getByText(/doesn't test sign-in, models or\s+connections/)).toBeVisible();
    const approved = backend.inspected!.disclosure;
    expect(backend.setupCalls).toBe(1);
    expect(backend.setupBodies[0]).toEqual({
      harness: "codex",
      confirmation: dockerSetupConfirmation,
      approval: {
        digest: approved.digest,
        customizations: approved.customizations.map((item) => item.id),
        credentialExposures: ["codex"],
        confirmation: dockerApprovalConfirmation,
      },
    });
    await user.click(dialog().getByRole("button", { name: "Done" }));
    expect(dockerStatus()).toHaveTextContent(
      /Ready.*Codex · runtime check passed, sign-in not tested/,
    );
    expect(dockerAction()).toBeNull();
    expect(status().getByText("Docker")).toBeVisible();
    expect(backend.settings.automation.pollRequests).toBe(true);
    expect(effectful().filter((c) => c.includes("/execution/setup"))).toHaveLength(1);
  });

  it("shows an already-ready selection without setup, inspection or other requests and keeps marker-less artifacts not runnable", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const first = mount({ harness: "docker-ready" }, record);
    await screen.findByRole("radio", { name: "Docker" });
    expect(dockerStatus()).toHaveTextContent("Ready");
    expect(dockerAction()).toBeNull();
    expect(status().getByText("Docker")).toBeVisible();
    expect(effectful()).toEqual([]);
    expect(calls.filter((c) => c.includes("/execution"))).toEqual([]);
    expect(
      dockerCard().getByRole("button", { name: "Run credential-free boundary check" }),
    ).toBeInTheDocument();
    backend.review("pr-490");
    const run = backend.detail("pr-490").runs.at(-1)!;
    expect(run.reviewer.execution?.docker?.profile).toBe("container-native-1");
    expect(run.reviewer.execution?.docker?.approval.digest).toBe(
      backend.dockerApprovals.codex!.approval.digest,
    );

    first.unmount();
    mount({ harness: "docker-legacy" });
    await screen.findByRole("radio", { name: "Docker" });
    expect(dockerStatus()).toHaveTextContent("Needs attention");
    expect(screen.getByTestId("docker-problem")).toHaveTextContent(
      /predates explicit container capability approval/,
    );
    expect(dockerAction()).toHaveTextContent("Fix setup");
    expect(() => backend.review("pr-490")).toThrow(
      /predates explicit container capability approval/,
    );
  });

  it("reuses unchanged approvals, flags only new or changed items and never prechecks them", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker-ready", native: "discovered" });
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(screen.getByRole("button", { name: "Set up again" }));
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    await screen.findByRole("group", { name: "Approve credential exposures" });
    expect(
      dialog().getByText(/approved before and that haven't changed are already checked/),
    ).toBeVisible();
    for (const box of dialog().getAllByRole("checkbox")) expect(box).toBeChecked();
    expect(dialog().getAllByText("approved before, unchanged")).toHaveLength(2);
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(backend.setupCalls).toBe(0);

    const localId = "native:claude-local-tools-mock-identity";
    const local = () => within(screen.getByTestId(`docker-local-${localId}`));
    await user.click(local().getByRole("checkbox", { name: /Include local-tools/ }));
    await user.click(screen.getByRole("button", { name: "Set up again" }));
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    expect(
      await dialog().findByText(/needs a known profile and 1-100 exact document ids/),
    ).toBeVisible();
    expect(backend.inspectCalls).toBe(1);
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    await user.type(local().getByLabelText("Document ids (1-100)"), "doc-1 doc-2");
    await user.click(local().getByRole("checkbox", { name: /Enabled for container sessions/ }));
    await user.click(local().getByRole("checkbox", { name: /Allow tool documents_get/ }));
    await user.click(screen.getByRole("button", { name: "Set up again" }));
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    const locals = await screen.findByRole("group", { name: "Approve local stdio tools" });
    expect(backend.inspected!.request).toEqual({
      harness: "codex",
      localConnections: [
        {
          id: localId,
          profileId: "pr-review-documents/1",
          scope: ["doc-1", "doc-2"],
          enabled: true,
          allowedTools: ["document"],
        },
      ],
    });
    expect(locals).toHaveTextContent(/doc-1, doc-2.*enabled.*document.*new or changed/);
    expect(within(locals).getByRole("checkbox")).not.toBeChecked();
    expect(approveButton()).toBeDisabled();
    await user.click(within(locals).getByRole("checkbox"));
    await user.click(approveButton());
    await user.click(dialog().getByRole("button", { name: "Set up Docker" }));
    await dialog().findByText(/Docker runs new reviews with Codex/);
    expect(backend.dockerApprovals.codex?.disclosure.localConnections[0]?.request.scope).toEqual([
      "doc-1",
      "doc-2",
    ]);
    const connection = backend.integrationConfigs.find((config) => config.id === localId)!;
    expect(connection.enabled).toBe(false);
    expect(connection.allowedTools).toEqual([]);
  });

  it("reuses recorded approvals after a changed saved selection and reload, but not changed code or another harness", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker-ready" });
    await screen.findByRole("radio", { name: "Docker" });
    const model = screen.getByRole("combobox", { name: "Model" });
    await user.clear(model);
    await user.type(model, "custom-new-model");
    await user.click(screen.getByRole("button", { name: "Save execution" }));
    await waitFor(() => expect(backend.executionStatus().snapshot).toBeNull());
    expect(backend.executionStatus().lastApprovedDocker).toEqual(backend.dockerApprovals.codex);
    const inspect = backend.inspectDocker.bind(backend);
    backend.inspectDocker = (body) => {
      const disclosure = inspect(body);
      disclosure.customizations[0]!.id = "changed-source-code";
      return disclosure;
    };
    cleanup();
    render(<App mock />);
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(screen.getByRole("button", { name: "Fix setup" }));
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    const exposures = await screen.findByRole("group", { name: "Approve credential exposures" });
    expect(within(exposures).getByRole("checkbox")).toBeChecked();
    const code = screen.getByRole("group", { name: "Approve executable customizations" });
    expect(within(code).getByRole("checkbox")).not.toBeChecked();
    expect(approveButton()).toBeDisabled();
    expect(backend.setupCalls).toBe(0);
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    await user.click(mode("Pi"));
    await user.click(screen.getByRole("button", { name: "Save execution" }));
    await waitFor(() => expect(backend.harnessStatus().selection?.harness).toBe("pi"));
    cleanup();
    render(<App mock />);
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(dockerAction()!);
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    await screen.findByRole("group", { name: "Approve credential exposures" });
    for (const box of dialog().getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(backend.executionStatus().lastApprovedDocker).toBeUndefined();
  });

  it("keeps refusals inline, retries with the same approval, and reconciles setup progress after reload without resending", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker", setup: "fail" }, (b) => {
      b.discoverIntegrations({ harness: "codex" });
    });
    await screen.findByRole("radio", { name: "Docker" });
    const localId = "native:codex-local-tools-mock-identity";
    const local = () => within(screen.getByTestId(`docker-local-${localId}`));
    await user.click(local().getByRole("checkbox", { name: /Include local-tools/ }));
    await user.type(local().getByLabelText("Document ids (1-100)"), "doc-1");
    await user.click(dockerAction()!);
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    await alertWith(/only an explicitly approved local Node \.mjs entry.*docker_inspection_failed/);
    expect(dialog().getByText("That step didn't work.")).toBeVisible();
    expect(backend.inspected).toBeUndefined();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(local().getByRole("checkbox", { name: /Include local-tools/ })).toBeChecked();
    await user.click(local().getByRole("checkbox", { name: /Include local-tools/ }));

    await user.click(dockerAction()!);
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    await screen.findByRole("group", { name: "Approve credential exposures" });
    await checkAll(user);
    await user.click(approveButton());
    await user.click(dialog().getByRole("button", { name: "Set up Docker" }));
    await alertWith(/nothing was installed, selected or stripped.*docker_setup_failed/);
    expect(dockerStatus()).toHaveTextContent("Setup failed");
    expect(backend.harness.managed).toBeUndefined();

    backend.options.setup = "slow";
    await user.click(dialog().getByRole("button", { name: "Try again" }));
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    await screen.findByRole("group", { name: "Approve credential exposures" });
    for (const box of dialog().getAllByRole("checkbox")) expect(box).toBeChecked();
    await user.click(approveButton());
    expect(dialog().getByText("Last attempt failed.")).toBeVisible();
    await user.click(dialog().getByRole("button", { name: "Set up Docker" }));
    expect(await dialog().findByText(/Setting up Docker for Codex/)).toBeVisible();
    await waitFor(() => expect(dockerStatus()).toHaveTextContent("Setting up"));
    expect(backend.setupCalls).toBe(2);

    cleanup();
    render(<App mock />);
    await screen.findByRole("radio", { name: "Docker" });
    await waitFor(() => expect(dockerStatus()).toHaveTextContent("Setting up"));
    await user.click(screen.getByRole("button", { name: "View progress" }));
    expect(dialog().getByText(/Setting up Docker for Codex/)).toBeVisible();
    expect(dialog().getByText(/Closing this window doesn't stop setup/)).toBeVisible();
    expect(
      await dialog().findByText(/Docker runs new reviews with Codex/, {}, { timeout: 3000 }),
    ).toBeVisible();
    expect(dockerStatus()).toHaveTextContent("Ready");
    expect(backend.setupCalls).toBe(2);
  });

  it("drops a delayed check result after the flow closes", async () => {
    window.location.hash = "#/settings";
    let release = () => {};
    const user = mount({ harness: "docker" }, (b) => {
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) =>
        path.includes("/execution/inspect")
          ? new Promise((resolve) => {
              release = () => resolve(handle(method, path, body));
            })
          : handle(method, path, body);
    });
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(dockerAction()!);
    await user.click(await screen.findByRole("button", { name: "Inspect with these choices" }));
    expect(dialog().getByText(/Checking what Docker would run for Codex/)).toBeVisible();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    release();
    await waitFor(() => expect(backend.inspectCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.setupCalls).toBe(0);
    expect(dockerAction()).toBeEnabled();
  });

  it("requires a fresh Dangerous confirmation naming the harness, sends nothing on cancel, and reconfirms harness changes", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved" }, record);
    await screen.findByRole("radio", { name: "Isolated Harnesses" });
    await user.click(mode("Dangerous"));
    await user.click(mode("Codex"));
    expect(screen.getByText(/bypassing the app preview/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /understand/ })).toBeNull();
    expect(screen.queryByTestId("additional-reviewers")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save Dangerous..." }));
    const dialog = screen.getByRole("dialog", {
      name: "Confirm Dangerous host execution with Codex",
    });
    expect(within(dialog).getByText(/write files anywhere on this Mac/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/full\s+native tools, plugins, configuration and logins/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/publish reviews, comments or commits directly/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Connection checkboxes below do not constrain it/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(backend.harness.selection?.workflow).toBe("separated");
    expect(mode("Dangerous")).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save Dangerous..." }));
    await user.click(screen.getByRole("button", { name: "I understand, save Dangerous" }));
    await waitFor(() => expect(backend.harness.selection?.workflow).toBe("dangerous"));
    expect(backend.harness.selection).toMatchObject({ version: 2, harness: "codex" });
    expect(backend.harness.dangerousConsent).toMatchObject({ harness: "codex" });
    expect(await screen.findByText("Dangerous saved for new sessions")).toBeVisible();
    expect(screen.getByText(/^Dangerous · Codex \(/)).toBeInTheDocument();
    expect(status().getByText("Dangerous")).toBeVisible();
    expect(backend.runs["pr-482"]!.length).toBe(2);

    await user.click(mode("Pi"));
    await user.click(screen.getByRole("button", { name: "Save Dangerous..." }));
    expect(
      screen.getByRole("dialog", { name: "Confirm Dangerous host execution with Pi" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I understand, save Dangerous" }));
    await waitFor(() => expect(backend.harness.dangerousConsent?.harness).toBe("pi"));
    expect(calls.filter((c) => c.startsWith("PATCH "))).toHaveLength(2);
  });

  it("re-saves an unchanged selection explicitly to recapture changed bytes at the same paths, never on refresh", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved" }, record);
    await screen.findByTestId("capabilities");
    const digest = () =>
      screen.getByTestId("capability-main").textContent!.match(/digest (\S{12})/)![1];
    const recapture = () => screen.getByRole("button", { name: "Re-save unchanged to recapture" });
    const before = digest();
    const skillBefore = backend.harness.skill!.digest;
    const savedBefore = structuredClone(backend.harness.selection);
    expect(saveButton()).toBeDisabled();
    expect(recapture()).toBeEnabled();
    expect(screen.getByText(/nothing is re-read on load or refresh/)).toBeInTheDocument();

    backend.nativeConfigBytes.claude = '{"language":"german"}';
    backend.skillBytes[fx.SKILL_PATH] = "# changed bytes at the same path";
    backend.updateSettings({ pollIntervalSeconds: 130 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(130));
    expect(digest()).toBe(before);
    expect(backend.harness.skill!.digest).toBe(skillBefore);
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(saveButton()).toBeDisabled();

    await user.click(recapture());
    expect(
      await screen.findByText("Isolated Harnesses re-saved with recaptured files for new sessions"),
    ).toBeVisible();
    expect(calls.filter((c) => c.startsWith("PATCH "))).toEqual(["PATCH /api/settings/harness"]);
    expect(backend.harness.selection).toEqual(savedBefore);
    expect(backend.harness.skill!.digest).not.toBe(skillBefore);
    await waitFor(() => expect(digest()).not.toBe(before));
    expect(saveButton()).toBeDisabled();
    expect(recapture()).toBeEnabled();

    await user.click(mode("Pi"));
    expect(screen.queryByRole("button", { name: "Re-save unchanged to recapture" })).toBeNull();
    expect(saveButton()).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(recapture()).toBeEnabled();
    user.unmount();
    uninstall();

    mount({ harness: "fresh" });
    await screen.findByText("Not saved yet.");
    expect(screen.queryByRole("button", { name: /Re-save/ })).toBeNull();
  });

  it("requires a fresh confirmation for an unchanged Dangerous re-save and sends nothing on cancel", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "dangerous" }, record);
    await screen.findByRole("radio", { name: "Dangerous" });
    const consentBefore = backend.harness.dangerousConsent!.confirmedAt;
    expect(saveButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Re-save Dangerous unchanged..." }));
    const dialog = screen.getByRole("dialog", { name: "Confirm Dangerous host execution with Pi" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(backend.harness.dangerousConsent!.confirmedAt).toBe(consentBefore);

    await user.click(screen.getByRole("button", { name: "Re-save Dangerous unchanged..." }));
    await user.click(screen.getByRole("button", { name: "I understand, save Dangerous" }));
    await waitFor(() =>
      expect(backend.harness.dangerousConsent!.confirmedAt).not.toBe(consentBefore),
    );
    expect(calls.filter((c) => c.startsWith("PATCH "))).toEqual(["PATCH /api/settings/harness"]);
    expect(backend.harness.selection).toMatchObject({
      version: 2,
      workflow: "dangerous",
      harness: "pi",
    });
    expect(
      await screen.findByText("Dangerous re-saved with recaptured files for new sessions"),
    ).toBeVisible();
  });

  it("reports unavailable execution management with a retry and keeps other settings usable", async () => {
    window.location.hash = "#/settings";
    mount({ harness: "unavailable" });
    expect(await screen.findByText("Execution settings are unavailable.")).toBeInTheDocument();
    expect(screen.getByText(/execution_unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Main harness")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Maximum concurrent reviews")).toBeEnabled();
  });

  it("labels runs and questions from captured roles and per-entry evidence, not current settings", async () => {
    window.location.hash = "#/pr/pr-482";
    const user = mount({ harness: "dangerous" });
    await screen.findByRole("heading", { name: "Runs" });
    await user.click(await screen.findByText("Manual review"));
    expect(screen.getByText("Isolated Harnesses · Main Claude Code")).toBeInTheDocument();
    expect(screen.getByText("fixture-main")).toBeInTheDocument();
    expect(screen.getByText(fx.CUSTOM_SKILL_PATH)).toBeInTheDocument();
    const entries = within(screen.getByRole("list", { name: "Reviewer entries" }));
    expect(
      entries.getAllByRole("listitem").map((item) => item.getAttribute("data-testid")),
    ).toEqual(["entry-reviewer-1", "entry-reviewer-2", "entry-main"]);
    expect(screen.getByTestId("entry-reviewer-2")).toHaveTextContent("failed");
    expect(screen.getByTestId("entry-reviewer-2")).toHaveTextContent(/no successful result/);
    expect(screen.getByTestId("entry-main")).toHaveTextContent(/3 findings/);
    await user.click(screen.getByText("Review request"));
    expect(screen.getAllByText(/Archived execution \(not rerunnable\)/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Dangerous · Pi/)).toBeNull();
  });
});

describe("docker source consent", () => {
  const calls: string[] = [];
  const record = (b: MockBackend) => {
    const handle = b.handle.bind(b);
    b.handle = (method, path, body) => {
      calls.push(`${method} ${new URL(path, "http://localhost").pathname}`);
      return handle(method, path, body);
    };
  };
  const dialog = () => within(screen.getByRole("dialog"));
  const checkAll = async (user: ReturnType<typeof userEvent.setup>) => {
    for (const box of dialog().getAllByRole("checkbox"))
      if (!(box as HTMLInputElement).checked) await user.click(box);
  };
  const exclusions = () => within(screen.getByTestId("docker-exclusions"));
  const openFlow = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByTestId("docker-action"));
    await user.click(screen.getByRole("button", { name: "Inspect with these choices" }));
    return screen.findByTestId("docker-disclosure");
  };
  const leaves = () => within(screen.getByTestId("docker-leaves"));
  const herdr = dockerExclusionCandidates.find((item) => item.kind === "herdr-session-start")!;
  const statusLine = dockerExclusionCandidates.find((item) => item.kind === "status-line")!;
  const slack = dockerExclusionCandidates.find((item) => item.kind === "slack-plugin")!;
  const google = dockerExclusionCandidates.find((item) => item.kind === "google-workspace-skill")!;
  const observe = async (user: ReturnType<typeof userEvent.setup>, source: string) => {
    const input = screen.getByLabelText("Installed skill leaf (absolute path)");
    await user.clear(input);
    await user.type(input, source);
    await user.click(screen.getByRole("button", { name: "Observe installed leaf metadata" }));
    await screen.findByRole("button", { name: "Observe installed leaf metadata" });
  };

  it("keeps omit-all independent from optional alias reads and later approvals", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker" });
    await user.click(await screen.findByTestId("docker-action"));
    await user.click(dialog().getByRole("button", { name: "Discover exclusion candidates" }));
    await screen.findByTestId(`docker-exclusion-${google.id}`);
    for (const box of exclusions().getAllByRole("checkbox")) await user.click(box);
    for (const root of [".agents", ".codex"])
      await observe(user, `${HOME}/${root}/skills/fixture-leaf`);
    for (const box of leaves().getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(dialog().getByText(/Optional external skill leaves are omitted/)).toBeVisible();
    await user.click(dialog().getByRole("button", { name: "Inspect with these choices" }));
    await screen.findByTestId("docker-disclosure");
    expect(backend.inspected!.request).toEqual({
      harness: "codex",
      exclusions: dockerExclusionCandidates.map((item) => item.id),
    });
    for (const box of dialog().getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(dialog().getByRole("button", { name: "Approve and continue" })).toBeDisabled();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(backend.setupCalls).toBe(0);
  });

  it("offers independent alias reads before Fix setup and makes refusal retry refresh choices without repeating Inspect", async () => {
    window.location.hash = "#/settings";
    const required = [`${HOME}/.agents/skills/fixture-leaf`, `${HOME}/.codex/skills/fixture-leaf`];
    let attempts = 0;
    const user = mount({ harness: "docker-legacy" }, (b) => {
      const inspect = b.inspectDocker.bind(b);
      b.inspectDocker = (body) => {
        attempts++;
        const disclosure = inspect(body);
        if (attempts === 1)
          throw new MockError(
            409,
            "Synthetic inspection interruption; retry with fresh choices",
            "docker_inspection_failed",
          );
        return disclosure;
      };
    });
    await user.click(await screen.findByRole("button", { name: "Fix setup" }));
    expect(attempts).toBe(0);
    expect(dialog().getByTestId("docker-leaves")).toBeVisible();
    for (const source of required) await observe(user, source);
    const candidates = [...backend.leafCandidates.values()];
    expect(candidates[0]!.resolvedSourcePath).toBe(candidates[1]!.resolvedSourcePath);
    const box = (id: string) =>
      within(screen.getByTestId(`docker-leaf-${id}`)).getByRole("checkbox");
    expect(box(candidates[0]!.id)).not.toBeChecked();
    expect(box(candidates[1]!.id)).not.toBeChecked();
    await user.click(box(candidates[0]!.id));
    await user.click(dialog().getByRole("button", { name: "Inspect with these choices" }));
    await alertWith(/Synthetic inspection interruption/);
    expect(attempts).toBe(1);
    await user.click(dialog().getByRole("button", { name: "Try again" }));
    expect(attempts).toBe(1);
    expect(dialog().getByText("Last check refused.")).toBeVisible();
    expect(leaves().queryAllByRole("checkbox")).toHaveLength(0);
    for (const source of required) await observe(user, source);
    for (const candidate of candidates) {
      expect(box(candidate.id)).not.toBeChecked();
      await user.click(box(candidate.id));
    }
    await user.click(dialog().getByRole("button", { name: "Inspect with these choices" }));
    await screen.findByTestId("docker-disclosure");
    expect(backend.inspected!.request.libraryLeaves).toEqual(candidates.map((leaf) => leaf.id));
    for (const checkbox of dialog().getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(backend.setupCalls).toBe(0);
    expect(attempts).toBe(2);
  });

  it("asks for fresh choices after guided Save and fences metadata returning after cancellation", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker" });
    await screen.findByRole("radio", { name: "Docker" });
    await observe(user, `${HOME}/.codex/skills/helper`);
    const leaf = backend.leafCandidates.values().next().value!;
    await user.click(within(screen.getByTestId(`docker-leaf-${leaf.id}`)).getByRole("checkbox"));
    await observe(user, `${HOME}/.codex/skills/helper`);
    expect(leaves().getAllByRole("checkbox")).toHaveLength(1);
    expect(leaves().getByRole("checkbox")).not.toBeChecked();
    await user.click(leaves().getByRole("checkbox"));
    await user.type(screen.getByRole("combobox", { name: "Model" }), "-changed");
    await user.click(screen.getByTestId("docker-action"));
    await user.click(dialog().getByRole("button", { name: "Save and continue" }));
    await screen.findByRole("button", { name: "Inspect with these choices" });
    expect(backend.inspectCalls).toBe(0);
    expect(leaves().queryAllByRole("checkbox")).toHaveLength(0);
    expect(backend.leafCandidates.size).toBe(0);
    await observe(user, `${HOME}/.codex/skills/helper`);
    expect(
      within(screen.getByTestId(`docker-leaf-${leaf.id}`)).getByRole("checkbox"),
    ).not.toBeChecked();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Re-save unchanged to recapture" }));
    await waitFor(() => expect(leaves().queryAllByRole("checkbox")).toHaveLength(0));
    let release = () => {};
    const handle = backend.handle.bind(backend);
    backend.handle = (method, path, body) =>
      path.includes("/execution/library-leaf")
        ? new Promise((resolve) => {
            release = () => resolve(handle(method, path, body));
          })
        : handle(method, path, body);
    await user.click(screen.getByTestId("docker-action"));
    await user.type(
      screen.getByLabelText("Installed skill leaf (absolute path)"),
      `${HOME}/.codex/skills/helper`,
    );
    await user.click(screen.getByRole("button", { name: "Observe installed leaf metadata" }));
    expect(dialog().getByRole("button", { name: "Inspect with these choices" })).toBeDisabled();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    release();
    await waitFor(() => expect(backend.leafCandidates.size).toBe(1));
    await user.click(screen.getByTestId("docker-action"));
    expect(leaves().queryAllByRole("checkbox")).toHaveLength(0);
    expect(backend.inspectCalls).toBe(0);
    expect(backend.setupCalls).toBe(0);
  });

  it("discovers exclusion candidates and installed leaves explicitly, passes only selected ids to Inspect and requires exact separate approval", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "docker" }, record);
    await screen.findByRole("radio", { name: "Docker" });
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(exclusions().queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Observe installed leaf metadata" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Discover exclusion candidates" }));
    await screen.findByTestId(`docker-exclusion-${herdr.id}`);
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([
      "POST /api/settings/execution/exclusions",
    ]);
    expect(exclusions().getByText(/Discover source-bound Herdr, status-line/)).toHaveTextContent(
      "Discover source-bound Herdr, status-line, Slack activation and Google Workspace skill exclusions for the saved Docker choice. Reads bounded native settings and synced-library metadata, plus the recognized Google skill and sibling manifest to bind exact contents. No code runs; selection changes Docker only.",
    );
    const boxes = exclusions().getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    for (const box of boxes) expect(box).not.toBeChecked();
    const herdrRow = screen.getByTestId(`docker-exclusion-${herdr.id}`);
    expect(herdrRow).toHaveTextContent("Herdr SessionStart hook");
    expect(herdrRow).toHaveTextContent("/hooks/SessionStart/0/hooks/0");
    expect(herdrRow).toHaveTextContent(`${HOME}/.claude/settings.json`);
    expect(herdrRow).toHaveTextContent(herdr.definition);
    expect(herdrRow).toHaveTextContent(herdr.rationale);
    expect(herdrRow).toHaveTextContent(/Native settings unchanged: true/);
    expect(screen.getByTestId(`docker-exclusion-${statusLine.id}`)).toHaveTextContent(
      "echo mock-status-line",
    );
    await user.click(
      within(screen.getByTestId(herdrRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    );

    await observe(user, `${HOME}/.claude/skills/fixture-leaf`);
    await alertWith(/not an arbitrary source or parent directory.*docker_library_leaf_failed/);
    expect(leaves().queryAllByRole("checkbox")).toHaveLength(0);
    await observe(user, `${HOME}/.agents/skills/fixture-leaf`);
    const alias = backend.leafCandidates.values().next().value!;
    const aliasRow = await screen.findByTestId(`docker-leaf-${alias.id}`);
    expect(aliasRow).toHaveTextContent(`${HOME}/.agents/skills/fixture-leaf`);
    expect(aliasRow).toHaveTextContent(`→ terminal ${HOME}/.claude/skills/fixture-leaf`);
    expect(aliasRow).toHaveTextContent(alias.sourceDigest.slice(0, 12));
    expect(aliasRow).toHaveTextContent(/2000 entries, 2,000,000 decoded bytes, utf8 only/);
    expect(aliasRow).toHaveTextContent(/Read and freeze this installed leaf/);
    expect(
      within(screen.getByTestId(aliasRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    ).not.toBeChecked();
    await observe(user, `${HOME}/.codex/skills/fixture-leaf`);
    const [, codexAlias] = [...backend.leafCandidates.values()];
    expect(codexAlias!.resolvedSourcePath).toBe(alias.resolvedSourcePath);
    expect(codexAlias!.id).not.toBe(alias.id);
    expect(leaves().getAllByRole("checkbox")).toHaveLength(2);
    expect(backend.leafCalls).toEqual([
      `${HOME}/.claude/skills/fixture-leaf`,
      `${HOME}/.agents/skills/fixture-leaf`,
      `${HOME}/.codex/skills/fixture-leaf`,
    ]);
    await user.click(
      within(screen.getByTestId(aliasRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    );
    expect(backend.inspectCalls).toBe(0);

    const disclosure = await openFlow(user);
    expect(backend.inspected!.request).toEqual({
      harness: "codex",
      exclusions: [herdr.id],
      libraryLeaves: [alias.id],
    });
    expect(within(disclosure).getByLabelText("Docker source-bound exclusions")).toHaveTextContent(
      herdr.pointer,
    );
    expect(
      within(disclosure).getByLabelText("Docker source-bound exclusions"),
    ).not.toHaveTextContent(statusLine.pointer);
    expect(within(disclosure).getByLabelText("Docker installed leaves")).toHaveTextContent(
      `${HOME}/.agents/skills/fixture-leaf`,
    );
    expect(within(disclosure).getByLabelText("Docker source handling")).toHaveTextContent(
      "Finder metadata",
    );
    const resources = within(disclosure).getByLabelText("Docker resources");
    expect(resources).toHaveTextContent("opaque image/png data");
    expect(resources).toHaveTextContent(/1,836 decoded bytes, exact-byte encoding, mode regular/);
    expect(resources).toHaveTextContent(/not instructions, not rendered or decoded here/);
    expect(disclosure.querySelector("img")).toBeNull();
    expect(disclosure.textContent).not.toMatch(/data:image/);

    const approval = dialog();
    expect(approval.getAllByRole("checkbox")).toHaveLength(4);
    for (const box of approval.getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(
      approval.getByRole("group", { name: "Approve source-bound exclusions" }),
    ).toHaveTextContent(herdr.pointer);
    expect(approval.getByRole("group", { name: "Approve installed leaf reads" })).toHaveTextContent(
      `${HOME}/.agents/skills/fixture-leaf`,
    );
    const next = () => approval.getByRole("button", { name: "Approve and continue" });
    for (const box of approval.getAllByRole("checkbox").slice(0, 3)) await user.click(box);
    expect(next()).toBeDisabled();
    await user.click(approval.getAllByRole("checkbox")[3]!);
    expect(next()).toBeEnabled();
    await user.click(next());
    expect(dialog().getByText(/Last step: set up the Docker runtime for Codex/)).toBeVisible();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(backend.setupCalls).toBe(0);
    await openFlow(user);
    await checkAll(user);
    await user.click(dialog().getByRole("button", { name: "Approve and continue" }));
    await user.click(dialog().getByRole("button", { name: "Set up Docker" }));
    await dialog().findByText(/Docker runs new reviews with Codex/);
    expect(backend.setupBodies[0]).toEqual({
      harness: "codex",
      confirmation: dockerSetupConfirmation,
      approval: {
        digest: backend.dockerApprovals.codex!.disclosure.digest,
        exclusions: [herdr.id],
        libraryLeaves: [alias.id],
        customizations: backend.dockerApprovals.codex!.disclosure.customizations.map((c) => c.id),
        credentialExposures: ["codex"],
        confirmation: dockerApprovalConfirmation,
      },
    });
    expect(calls.filter((c) => /load-tools|\/test$/.test(c))).toEqual([]);
  });

  it("sends only the current source choices on each guided check, refuses stale leaf ids after restart, and clears candidates on Save", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker" });
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(screen.getByRole("button", { name: "Discover exclusion candidates" }));
    const herdrRow = await screen.findByTestId(`docker-exclusion-${herdr.id}`);
    await user.click(
      within(screen.getByTestId(herdrRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    );
    await observe(user, `${HOME}/.codex/skills/helper`);
    const leaf = backend.leafCandidates.values().next().value!;
    const leafRow = await screen.findByTestId(`docker-leaf-${leaf.id}`);
    expect(leafRow).toHaveTextContent(`${HOME}/.nix-profile/share/skills/helper`);
    await user.click(
      within(screen.getByTestId(leafRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    );
    await openFlow(user);
    expect(backend.inspected!.request).toEqual({
      harness: "codex",
      exclusions: [herdr.id],
      libraryLeaves: [leaf.id],
    });
    await user.click(dialog().getByRole("button", { name: "Cancel" }));

    await user.click(
      within(screen.getByTestId(herdrRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    );
    await openFlow(user);
    expect(backend.inspected!.request).toEqual({ harness: "codex", libraryLeaves: [leaf.id] });
    await user.click(dialog().getByRole("button", { name: "Cancel" }));

    backend.updateSettings({ pollIntervalSeconds: 150 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(150));
    expect(
      within(screen.getByTestId(herdrRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    ).not.toBeChecked();
    expect(
      within(screen.getByTestId(leafRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    ).toBeChecked();

    backend.clearInspection();
    await user.click(screen.getByTestId("docker-action"));
    await user.click(screen.getByRole("button", { name: "Inspect with these choices" }));
    await alertWith(new RegExp(`${DOCKER_LEAF_STALE_MESSAGE}.*docker_inspection_failed`));
    expect(backend.inspected).toBeUndefined();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId(`docker-leaf-${leaf.id}`)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Re-save unchanged to recapture" }));
    await screen.findByText(/Saved, but this choice cannot run yet/);
    expect(screen.queryByTestId(`docker-leaf-${leaf.id}`)).toBeNull();
    expect(screen.queryByTestId(`docker-exclusion-${herdr.id}`)).toBeNull();
    expect(backend.leafCandidates.size).toBe(0);
    expect(screen.getByRole("button", { name: "Discover exclusion candidates" })).toBeEnabled();
    expect(backend.setupCalls).toBe(0);
  });

  it("labels the synthetic Slack plugin activation candidate, keeps it unchecked, echoes only the explicit selection and sends no Setup on cancel", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker" });
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(screen.getByRole("button", { name: "Discover exclusion candidates" }));
    const slackRow = await screen.findByTestId(`docker-exclusion-${slack.id}`);
    expect(slackRow).toHaveTextContent("Slack plugin activation");
    expect(slackRow).toHaveTextContent("/enabledPlugins/mock-slack@mock-official-plugins");
    expect(slackRow).toHaveTextContent(`${HOME}/.claude/settings.json`);
    expect(slackRow).toHaveTextContent(slack.sourceDigest.slice(0, 12));
    expect(slackRow).toHaveTextContent(slack.itemDigest.slice(0, 12));
    expect(slackRow).toHaveTextContent(slack.definition);
    expect(slackRow).toHaveTextContent(slack.rationale);
    expect(slackRow).toHaveTextContent(/six plugin skills and five commands/);
    expect(slackRow).toHaveTextContent(/Native settings unchanged: true/);
    for (const box of exclusions().getAllByRole("checkbox")) expect(box).not.toBeChecked();

    await openFlow(user);
    expect(backend.inspected!.request).toEqual({ harness: "codex" });
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    await user.click(
      within(screen.getByTestId(slackRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    );
    const disclosure = await openFlow(user);
    expect(backend.inspected!.request).toEqual({ harness: "codex", exclusions: [slack.id] });
    const listed = within(disclosure).getByLabelText("Docker source-bound exclusions");
    expect(listed).toHaveTextContent("Slack plugin activation");
    expect(listed).toHaveTextContent(slack.pointer);
    expect(listed).not.toHaveTextContent(herdr.pointer);

    for (const box of dialog().getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(
      dialog().getByRole("group", { name: "Approve source-bound exclusions" }),
    ).toHaveTextContent(`Slack plugin activation ${slack.pointer}`);
    expect(dialog().getByRole("button", { name: "Approve and continue" })).toBeDisabled();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.setupCalls).toBe(0);
    expect(backend.dockerApprovals.codex).toBeUndefined();
  });

  it("labels the synthetic Google Workspace skill candidate, keeps it unchecked, echoes only its exact id and sends no Setup on cancel", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "docker" }, record);
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(screen.getByRole("button", { name: "Discover exclusion candidates" }));
    const googleRow = await screen.findByTestId(`docker-exclusion-${google.id}`);
    expect(googleRow).toHaveTextContent(`Google Workspace skill ${google.pointer}`);
    expect(googleRow).toHaveTextContent("/skills/3");
    expect(googleRow).toHaveTextContent(SYNCED_MANIFEST_PATH);
    expect(googleRow).toHaveTextContent(google.sourceDigest.slice(0, 12));
    expect(googleRow).toHaveTextContent(google.itemDigest.slice(0, 12));
    expect(googleRow).toHaveTextContent(google.definition);
    expect(googleRow).toHaveTextContent(google.rationale);
    expect(googleRow).toHaveTextContent(
      /its four scripts, five Markdown resources and exact skill\/pending-claim manifest entries/,
    );
    expect(googleRow).toHaveTextContent(/Native installation\/settings\/auth stay unchanged/);
    expect(googleRow).toHaveTextContent(/Native settings unchanged: true/);
    expect(exclusions().getAllByRole("checkbox")).toHaveLength(4);
    for (const box of exclusions().getAllByRole("checkbox")) expect(box).not.toBeChecked();

    await user.click(
      within(screen.getByTestId(googleRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    );
    const disclosure = await openFlow(user);
    expect(backend.inspected!.request).toEqual({ harness: "codex", exclusions: [google.id] });
    const listed = within(disclosure).getByLabelText("Docker source-bound exclusions");
    expect(listed).toHaveTextContent("Google Workspace skill");
    expect(listed).toHaveTextContent(google.pointer);
    expect(listed).not.toHaveTextContent(slack.pointer);
    expect(listed).not.toHaveTextContent(herdr.pointer);

    expect(dialog().getAllByRole("checkbox")).toHaveLength(3);
    for (const box of dialog().getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(
      dialog().getByRole("group", { name: "Approve source-bound exclusions" }),
    ).toHaveTextContent(`Google Workspace skill ${google.pointer}`);
    expect(dialog().getByRole("button", { name: "Approve and continue" })).toBeDisabled();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.setupCalls).toBe(0);
    expect(backend.dockerApprovals.codex).toBeUndefined();
    expect(
      within(screen.getByTestId(googleRow.getAttribute("data-testid")!)).getByRole("checkbox"),
    ).toBeChecked();
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([
      "POST /api/settings/execution/exclusions",
      "POST /api/settings/execution/inspect",
    ]);
  });

  it("shows an empty candidate list honestly and never excludes Slack or plugins", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "docker", exclusions: "none" });
    await screen.findByRole("radio", { name: "Docker" });
    await user.click(screen.getByRole("button", { name: "Discover exclusion candidates" }));
    expect(await screen.findByText(/No recognized exclusion candidates\./)).toHaveTextContent(
      "No recognized exclusion candidates. Optional external skill leaves still require separate read consent below; other skills, hooks and plugins are not excluded here. Native files remain unchanged.",
    );
    const disclosure = await openFlow(user);
    expect(backend.inspected!.request).toEqual({ harness: "codex" });
    expect(
      within(disclosure).getByText(/No Slack or plugin\s+exclusion exists/),
    ).toBeInTheDocument();
  });
});

describe("question captures", () => {
  it("shows Main-only captured labels for new questions and refuses archived retries without clearing the answer", async () => {
    window.location.hash = "#/pr/pr-482";
    Element.prototype.scrollIntoView = () => {};
    const user = mount({ harness: "saved" }, (b) => {
      b.questions["pr-482"] = [
        {
          id: "q-archived",
          prId: "pr-482",
          draftId: null,
          parentId: null,
          mode: "explain",
          status: "failed",
          baseSha: b.prs[0]!.baseSha,
          headSha: b.prs[0]!.headSha,
          selection: {
            path: "src/billing/invoice.ts",
            from: { side: "RIGHT", line: 42 },
            to: { side: "RIGHT", line: 42 },
            baseSha: b.prs[0]!.baseSha,
            headSha: b.prs[0]!.headSha,
            oldPath: null,
            snippet: "+  applyDiscount(lineItems, discount);",
            kinds: { add: true, del: false, ctx: false },
            spansHunks: false,
            anchors: { RIGHT: { startLine: 42, line: 42 } },
          },
          question: "",
          answer: null,
          error: "archived fixture failure",
          reviewerSnapshot: { ...b.settings.reviewer, skillExecution: undefined },
          createdAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
        },
      ];
    });
    await screen.findByRole("heading", { name: "Questions" });
    await user.click(screen.getByText("Explain"));
    expect(screen.getByTestId("question-execution")).toHaveTextContent(
      /Archived execution \(not rerunnable\).*start an independent question/,
    );
    await user.click(screen.getByRole("button", { name: "Show in diff" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText(/execution_incompatible|archived and cannot run again/),
    ).toBeVisible();
    expect(backend.questions["pr-482"]![0]).toMatchObject({
      status: "failed",
      error: "archived fixture failure",
    });
    expect(backend.questions["pr-482"]).toHaveLength(1);
  });
});

describe("captured history", () => {
  const run = (id: string) => within(screen.getByTestId(`run-${id}`));
  const outcome = (id: string) => run(id).getByTestId("run-outcome").textContent;
  const execution = (id: string) => run(id).getByText("Execution").nextElementSibling!.textContent!;

  it("labels archived shapes as not rerunnable, keeps paired captures current, and derives outcomes from evidence only", async () => {
    window.location.hash = "#/pr/pr-482";
    mount({ harness: "saved", history: "archived" });
    await screen.findByTestId("run-run-h-queued");

    expect(execution("run-h-queued")).toMatch(/^Isolated Harnesses · Main Claude Code/);
    expect(execution("run-h-queued")).toMatch(/Captured orchestration: 2 Additional reviewers/);
    expect(execution("run-h-queued")).not.toMatch(/ran first|synthesized|performed|not rerunnable/);
    expect(outcome("run-h-queued")).toBe("pending: reviewer-1, reviewer-2, main.");
    expect(outcome("run-h-failed")).toBe(
      "completed: reviewer-1 · failed: reviewer-2 · skipped: main. No draft was produced.",
    );
    expect(outcome("run-h-interrupted")).toBe(
      "completed: reviewer-1 · interrupted: reviewer-2 · skipped: main. No draft was produced.",
    );
    expect(outcome("run-2")).toBe(
      "completed: reviewer-1, main · failed: reviewer-2. One draft with 3 findings.",
    );
    expect(outcome("run-1")).toBe("Completed with 2 findings.");

    expect(execution("run-h-policyless")).toMatch(
      /^Archived execution \(not rerunnable\) · Isolated Harnesses · Main Claude Code/,
    );
    expect(run("run-h-policyless").getByText("not rerunnable")).toBeInTheDocument();
    expect(run("run-h-policyless").getByText("Additional").nextElementSibling).toHaveTextContent(
      /reviewer-1 · Codex · model-one.*reviewer-2 · Codex · model-two/,
    );
    expect(execution("run-h-host-only")).toMatch(
      /^Archived execution \(not rerunnable\) · Dangerous · Pi/,
    );
    expect(execution("run-h-dangerous")).toMatch(/^Dangerous · Pi/);
    expect(run("run-h-dangerous").queryByText("not rerunnable")).toBeNull();
    expect(execution("run-h-unpaired-docker")).toMatch(
      /^Archived execution \(not rerunnable\) · Docker · Codex/,
    );
    expect(execution("run-h-docker-markerless")).toMatch(
      /^Archived execution \(not rerunnable\) · Docker · Codex.*before explicit container capability approval/,
    );
    expect(execution("run-h-docker")).toMatch(
      /^Docker · Codex.*approved container-native-1 boundary/,
    );
    expect(run("run-h-docker").queryByText("not rerunnable")).toBeNull();
  });

  it("shows archived question captures as not rerunnable, keeps Main-only wording for current ones, and refuses retry without clearing the record", async () => {
    window.location.hash = "#/pr/pr-482";
    Element.prototype.scrollIntoView = () => {};
    const user = mount({ harness: "saved", history: "archived" });
    await screen.findByRole("heading", { name: "Questions" });
    const question = (id: string) =>
      within(screen.getByText(`History fixture ${id}`).closest("details")!);
    expect(question("q-h-current").getByTestId("question-execution")).toHaveTextContent(
      /^Isolated Harnesses · Main Claude Code.*Questions invoke captured Main only/,
    );
    expect(question("q-h-current").getByTestId("question-execution")).not.toHaveTextContent(
      /Not rerunnable/,
    );
    expect(question("q-h-host-only").getByTestId("question-execution")).toHaveTextContent(
      /^Archived execution \(not rerunnable\) · Dangerous · Pi.*Not rerunnable: retry and follow-up are refused/,
    );
    expect(
      question("q-h-host-only").getByText("Recorded answer for q-h-host-only"),
    ).toBeInTheDocument();
    expect(question("q-h-policyless").getByTestId("question-execution")).toHaveTextContent(
      /^Archived execution \(not rerunnable\) · Isolated Harnesses · Main Claude Code.*Not rerunnable/,
    );
    expect(question("q-h-policyless").getByTestId("question-execution")).not.toHaveTextContent(
      /Questions invoke captured Main only/,
    );
    expect(question("q-h-dangerous").getByTestId("question-execution")).toHaveTextContent(
      /^Dangerous · Pi · gpt-6-astra · captured when asked/,
    );
    expect(question("q-h-docker-markerless").getByTestId("question-execution")).toHaveTextContent(
      /^Archived execution \(not rerunnable\) · Docker · Codex.*Not rerunnable/,
    );
    expect(question("q-h-docker").getByTestId("question-execution")).toHaveTextContent(
      /^Docker · Codex · gpt-6-astra · captured when asked/,
    );
    expect(question("q-h-docker").getByTestId("question-execution")).not.toHaveTextContent(
      /Not rerunnable|Main only/,
    );

    await user.click(question("q-h-policyless").getByRole("button", { name: "Show in diff" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/archived and cannot run again/)).toBeVisible();
    expect(backend.questions["pr-482"]!.find((q) => q.id === "q-h-policyless")).toMatchObject({
      status: "failed",
      error: "History fixture failure q-h-policyless",
    });
    expect(backend.questions["pr-482"]).toHaveLength(6);
  });
});

describe("connections", () => {
  const card = (id: string) => within(screen.getByTestId(`connection-${id}`));
  const source = (name: string) =>
    within(screen.getByRole("radiogroup", { name: "Native source" })).getByRole("radio", { name });
  const documentsId = "native:claude-documents-mock-identity";
  const calls: string[] = [];
  const record = (b: MockBackend) => {
    const handle = b.handle.bind(b);
    b.handle = (method, path, body) => {
      calls.push(`${method} ${new URL(path, "http://localhost").pathname}`);
      return handle(method, path, body);
    };
  };

  it("starts empty, refuses Pi discovery, and discovers native connections disabled with stdio unsupported", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved" }, record);
    expect(await screen.findByTestId("no-connections")).toBeInTheDocument();
    expect(screen.queryByText(/Legacy metadata import/)).toBeNull();
    expect(screen.queryByText(/legacy metadata, unsupported/)).toBeNull();
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    await user.click(source("Pi"));
    expect(screen.getByText("Pi has no supported native MCP format.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Discover connections/ })).toBeNull();
    await user.click(source("Claude Code"));
    const path = screen.getByLabelText("Absolute source path");
    await user.type(path, "relative.json");
    expect(screen.getByRole("button", { name: "Discover connections" })).toBeDisabled();
    await user.clear(path);
    await user.click(screen.getByRole("button", { name: "Discover connections" }));
    expect(await screen.findByText(/Native configuration checked/)).toBeVisible();
    expect(screen.getByText(/new connections added; 0 changed definitions replaced/)).toBeVisible();
    expect(calls.filter((c) => c.startsWith("POST "))).toEqual([
      "POST /api/settings/integrations/discover",
    ]);
    const documents = card(documentsId);
    expect(documents.getByText("Claude JSON · Claude Code")).toBeInTheDocument();
    expect(documents.getByText("supported format")).toBeInTheDocument();
    expect(documents.getByText("configured")).toBeInTheDocument();
    expect(documents.getByRole("checkbox", { name: /Enabled for review context/ })).toBeDisabled();
    expect(documents.getByText(/Header values are never stored or shown/)).toBeInTheDocument();
    expect(documents.getByLabelText("Known profile")).toBeInTheDocument();
    const stdio = card("native:claude-local-tools-mock-identity");
    expect(stdio.getByText("unsupported")).toBeInTheDocument();
    expect(stdio.getByText(/local stdio would execute host code/)).toBeInTheDocument();
    expect(stdio.getByTestId("problem-native:claude-local-tools-mock-identity")).toHaveTextContent(
      /never start local stdio servers.*only inside its container.*Local stdio tools/,
    );
    expect(stdio.queryByLabelText("Known profile")).toBeNull();
    expect(stdio.getByRole("checkbox", { name: /Enabled for review context/ })).toBeDisabled();
    expect(backend.integrationConfigs.every((c) => !c.enabled && !c.allowedTools.length)).toBe(
      true,
    );
  });

  it("binds an explicit profile and scope, requires disclosed Load that resets grants, applies presets explicitly and separates Test evidence", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved", native: "discovered" }, record);
    const documents = () => card(documentsId);
    await screen.findByTestId(`connection-${documentsId}`);
    expect(documents().getByRole("button", { name: "Bind profile and scope" })).toBeDisabled();
    await user.type(documents().getByLabelText("Document ids (1-100)"), "doc one!");
    expect(documents().getByRole("button", { name: "Bind profile and scope" })).toBeDisabled();
    await user.clear(documents().getByLabelText("Document ids (1-100)"));
    await user.type(documents().getByLabelText("Document ids (1-100)"), "doc-1, doc-2");
    await user.click(documents().getByRole("button", { name: "Bind profile and scope" }));
    expect(await screen.findByText(/Profile and scope bound/)).toBeVisible();
    const diagnostics = documents().getByTestId(`diagnostics-${documentsId}`);
    expect(diagnostics).toHaveTextContent("pr-review-documents/1");
    expect(diagnostics).toHaveTextContent("2 document ids");
    expect(documents().getByTestId("inventory")).toHaveTextContent(/No tool inventory loaded/);
    expect(documents().getByText("needs compatibility")).toBeInTheDocument();
    const tool = () => documents().getByRole("checkbox", { name: /Bounded read context/ });
    expect(tool()).toBeEnabled();
    expect(tool()).not.toBeChecked();
    await user.click(tool());
    await waitFor(() =>
      expect(backend.integrationConfigs.find((c) => c.id === documentsId)?.allowedTools).toEqual([
        "document",
      ]),
    );
    expect(documents().getByText(/unsupported: Explicitly Load tools/)).toBeInTheDocument();

    await user.click(documents().getByRole("button", { name: "Load tools..." }));
    const dialog = screen.getByRole("dialog", { name: "Load tools for documents" });
    expect(within(dialog).getByText(/authenticated\s+inventory access/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Always resets this connection to disabled/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.includes("load-tools"))).toEqual([]);
    await user.click(documents().getByRole("button", { name: "Load tools..." }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Load tools" }),
    );
    expect(
      await screen.findByText(/Tool inventory loaded; enablement and grants were reset/),
    ).toBeVisible();
    expect(documents().getByTestId("inventory")).toHaveTextContent("inventory loaded");
    expect(documents().getByTestId("inventory")).toHaveTextContent("synthetic transport");
    expect(documents().getByTestId("inventory-tools")).toHaveTextContent("documents_get");
    expect(tool()).not.toBeChecked();
    expect(backend.integrationConfigs.find((c) => c.id === documentsId)?.allowedTools).toEqual([]);
    expect(documents().getByText("configured")).toBeInTheDocument();

    await user.click(
      documents().getByRole("button", { name: /Use preset: Read explicitly scoped documents/ }),
    );
    await waitFor(() => expect(tool()).toBeChecked());
    expect(backend.integrationConfigs.find((c) => c.id === documentsId)?.enabled).toBe(false);
    expect(documents().getByText(/Effective for new sessions/)).toHaveTextContent("disabled");
    await user.click(documents().getByRole("checkbox", { name: /Enabled for review context/ }));
    await waitFor(() =>
      expect(documents().getByText(/Effective for new sessions/)).toHaveTextContent("restricted"),
    );
    expect(
      documents().getByText(/allowed: Configured captured read permissions/),
    ).toBeInTheDocument();

    expect(documents().queryByTestId("read-evidence")).toBeNull();
    await user.click(documents().getByRole("button", { name: "Test connection..." }));
    const test = screen.getByRole("dialog", { name: "Test documents" });
    expect(within(test).getByText(/Independent of enablement and tool grants/)).toBeInTheDocument();
    await user.click(within(test).getByRole("button", { name: "Run test" }));
    const evidence = within(await documents().findByTestId("read-evidence"));
    expect(evidence.getByText("Synthetic transport, not a live read")).toBeInTheDocument();
    expect(evidence.getByText(/tested just now/)).toBeInTheDocument();
    expect(backend.integrationConfigs.find((c) => c.id === documentsId)?.enabled).toBe(true);

    backend.options.inventory = "changed";
    await user.click(documents().getByRole("button", { name: "Reload tools..." }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Load tools" }),
    );
    await waitFor(() =>
      expect(documents().getByTestId("inventory")).toHaveTextContent("inventory changed"),
    );
    expect(documents().queryByTestId("read-evidence")).toBeNull();
    expect(
      documents().getByRole("checkbox", { name: /Enabled for review context/ }),
    ).not.toBeChecked();
    expect(tool()).not.toBeChecked();
    expect(documents().getByText("needs compatibility")).toBeInTheDocument();
  });

  it("labels Connected only for a successful live read and keeps failures and synthetic results disconnected", async () => {
    window.location.hash = "#/settings";
    const live = mount({ harness: "saved", native: "enabled", readTest: "live" });
    await screen.findByTestId(`connection-${documentsId}`);
    await live.click(card(documentsId).getByRole("button", { name: "Test connection..." }));
    await live.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Run test" }));
    expect(
      within(await card(documentsId).findByTestId("read-evidence")).getByText(
        "Live read succeeded",
      ),
    ).toBeInTheDocument();
    live.unmount();
    uninstall();

    const failed = mount({ harness: "saved", readProviders: "enabled", readTest: "error" });
    await screen.findByTestId("connection-notion");
    await failed.click(card("notion").getByRole("button", { name: "Test connection..." }));
    await failed.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Run test" }),
    );
    const evidence = within(await card("notion").findByTestId("read-evidence"));
    expect(evidence.getByText("Live read failed")).toBeInTheDocument();
    expect(evidence.getByText(/Provider read failed/)).toBeInTheDocument();
    expect(card("notion").getByText("audited manifest")).toBeInTheDocument();
  });

  it("replaces displayed Test evidence from the authoritative catalog after backend invalidation or restart", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", native: "enabled", readTest: "live" });
    const documents = () => card(documentsId);
    await screen.findByTestId(`connection-${documentsId}`);
    await user.click(documents().getByRole("button", { name: "Test connection..." }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Run test" }));
    expect(
      within(await documents().findByTestId("read-evidence")).getByText("Live read succeeded"),
    ).toBeInTheDocument();
    expect(documents().getByRole("checkbox", { name: /Enabled for review context/ })).toBeChecked();

    backend.discoverIntegrations({ harness: "claude" });
    expect(documents().getByTestId("read-evidence")).toBeInTheDocument();
    backend.importNativeIntegration({
      id: documentsId,
      profileId: "pr-review-documents/1",
      scope: ["doc-1"],
    });
    await waitFor(() => expect(documents().queryByTestId("read-evidence")).toBeNull());
    expect(
      documents().getByRole("checkbox", { name: /Enabled for review context/ }),
    ).not.toBeChecked();
    await user.click(documents().getByRole("button", { name: "Test connection..." }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Run test" }));
    expect(
      within(await documents().findByTestId("read-evidence")).getByText("Live read succeeded"),
    ).toBeInTheDocument();

    backend.evidence = {};
    backend.updateSettings({ pollIntervalSeconds: 130 });
    await waitFor(() => expect(documents().queryByTestId("read-evidence")).toBeNull());
  });

  it("keeps permission controls usable without a gateway boundary and imports the advanced manifest disabled", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "fresh", readProviders: "enabled" });
    await user.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    await screen.findByTestId("connection-github");
    expect(card("github").getByText("needs compatibility")).toBeInTheDocument();
    expect(card("github").getAllByText(/Save supported Isolated settings/).length).toBeGreaterThan(
      0,
    );
    expect(card("github").getByRole("checkbox", { name: /Bounded read context/ })).toBeEnabled();
    expect(card("github").getByRole("checkbox", { name: /Bounded read context/ })).toBeChecked();
    await user.click(screen.getByText(/Advanced: import an audited read-provider manifest/));
    const input = screen.getByLabelText("Manifest path (absolute)");
    await user.type(input, "/Users/demo/other.json");
    await user.click(screen.getByRole("button", { name: "Import manifest" }));
    await alertWith(/provider_incompatible/);
    await user.clear(input);
    await user.type(input, "/Users/demo/pr-review/read-providers.json");
    await user.click(screen.getByRole("button", { name: "Import manifest" }));
    expect(
      await screen.findByText(/entries stay disabled until you enable them/),
    ).toBeInTheDocument();
    expect(backend.integrationConfigs.every((c) => !c.enabled && !c.allowedTools.length)).toBe(
      true,
    );
    expect(card("custom:documents").getByText("Vetted document MCP")).toBeInTheDocument();
  });
});

describe("oauth connections", () => {
  const slackId = "native:claude-slack-mock-identity";
  const syntheticId = "native:claude-synthetic-oauth-mock-identity";
  const card = (id: string) => within(screen.getByTestId(`connection-${id}`));
  const panel = (id: string) => within(screen.getByTestId(`oauth-${id}`));
  const diagnostics = (id: string) => screen.getByTestId(`oauth-diagnostics-${id}`);
  const calls: string[] = [];
  const record = (b: MockBackend) => {
    const handle = b.handle.bind(b);
    b.handle = (method, path, body) => {
      calls.push(`${method} ${new URL(path, "http://localhost").pathname}`);
      return handle(method, path, body);
    };
  };
  const posts = () => calls.filter((c) => c.startsWith("POST "));
  const dialog = () => within(screen.getByRole("dialog"));
  const secretCanary = "TYPED_SECRET_CANARY";
  const noSecretRendered = () => expect(document.body.textContent).not.toContain(secretCanary);
  const field = (list: HTMLElement, term: string) =>
    within(list).getByText(term, { selector: "dt" }).nextElementSibling?.textContent;

  it("imports app-owned OAuth metadata explicitly instead of a document binding and keeps unsupported plugin entries honest", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved", oauth: "metadata" }, record);
    await screen.findByTestId(`connection-${slackId}`);
    expect(posts()).toEqual([]);
    const slack = card(slackId);
    expect(slack.getByText("app-owned OAuth metadata")).toBeInTheDocument();
    expect(slack.queryByLabelText("Known profile")).toBeNull();
    expect(slack.getByLabelText("Supported OAuth profile")).toHaveValue(slackOAuthProfile.id);
    expect(slack.getByRole("checkbox", { name: /Enabled for review context/ })).toBeDisabled();
    const bearer = card("native:claude-plugin-bearer-mock-identity");
    expect(bearer.getByText("unsupported format")).toBeInTheDocument();
    expect(bearer.queryByText("app-owned OAuth metadata")).toBeNull();
    expect(bearer.queryByRole("button", { name: "Import OAuth metadata" })).toBeNull();
    await user.click(slack.getByRole("button", { name: "Import OAuth metadata" }));
    expect(await screen.findByText(/OAuth metadata imported/)).toBeVisible();
    expect(posts()).toEqual(["POST /api/settings/integrations/import-oauth"]);
    const status = panel(slackId).getByLabelText("OAuth status");
    expect(status).toHaveTextContent("needs discovery");
    expect(diagnostics(slackId)).toHaveTextContent("no client configured");
    expect(status).toHaveTextContent("not authenticated");
    expect(diagnostics(slackId)).toHaveTextContent("SYNTHETIC storage");
    expect(diagnostics(slackId)).toHaveTextContent("identity unknown, not verified");
    expect(panel(slackId).queryByText("Read support unavailable for this profile.")).toBeNull();
    expect(slack.getByRole("checkbox", { name: /Enabled for review context/ })).toBeEnabled();
    expect(slack.getByRole("checkbox", { name: /Enabled for review context/ })).not.toBeChecked();
    expect(slack.getByText(/No reviewed tools yet\. Load tools fetches/)).toBeInTheDocument();
    expect(slack.queryByText(/Bind a known profile first/)).toBeNull();
    expect(slack.queryByRole("button", { name: /Use preset/ })).toBeNull();
    expect(slack.getByRole("button", { name: "Load tools..." })).toBeEnabled();
    expect(panel(slackId).queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(backend.integrationConfigs.find((c) => c.id === slackId)?.oauthProfileId).toBe(
      slackOAuthProfile.id,
    );
  });

  it("discovers requirements, configures a write-only static client, connects through the approved URL, cancels, completes the callback, loads inventory without grants and disconnects", async () => {
    window.location.hash = "#/settings";
    calls.length = 0;
    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return {} as Window;
    });
    const user = mount({ harness: "saved", oauth: "imported" }, record);
    await screen.findByTestId(`oauth-${slackId}`);
    expect(posts()).toEqual([]);
    expect(panel(slackId).queryByTestId(`oauth-form-${slackId}`)).toBeNull();
    await user.click(panel(slackId).getByRole("button", { name: "Discover OAuth requirements" }));
    const discovery = await screen.findByTestId(`oauth-discovery-${slackId}`);
    expect(posts()).toEqual([
      `POST /api/settings/integrations/${encodeURIComponent(slackId)}/oauth/discover`,
    ]);
    const digest = backend.oauthStates[slackId]!.discovery!.digest;
    expect(discovery).toHaveTextContent("https://mcp.slack.com");
    expect(discovery).toHaveTextContent("http://127.0.0.1:4317/api/mcp/oauth/callback");
    expect(discovery).toHaveTextContent("client_secret_post (confidential)");
    expect(discovery).toHaveTextContent("search:read.public search:read.private");
    expect(discovery).toHaveTextContent(/not advertised by server; disabled by profile/);
    expect(discovery).toHaveTextContent(digest);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("needs client");
    expect(panel(slackId).queryByRole("button", { name: /Register a new client/ })).toBeNull();
    expect(
      panel(slackId).getByText(/confirm an existing eligible app with the provider/),
    ).toBeInTheDocument();

    const save = () => panel(slackId).getByRole("button", { name: "Save client configuration" });
    expect(save()).toBeDisabled();
    await user.type(panel(slackId).getByLabelText("Client id"), "my-eligible-app");
    expect(panel(slackId).getByLabelText("Client method")).toHaveValue("client_secret_post");
    const secret = panel(slackId).getByLabelText("Client secret (write-only)");
    expect(secret).toHaveAttribute("type", "password");
    await user.type(secret, secretCanary);
    expect(save()).toBeDisabled();
    await user.click(panel(slackId).getByRole("checkbox", { name: "search:read.public" }));
    expect(save()).toBeEnabled();
    await user.click(save());
    expect(await screen.findByText(/Client configured in app-owned storage/)).toBeVisible();
    expect(backend.oauthConfigureBodies).toEqual([
      {
        clientId: "my-eligible-app",
        clientAuthMethod: "client_secret_post",
        clientSecret: secretCanary,
        scopes: ["search:read.public"],
        discoveryDigest: digest,
        redirectUri: "http://127.0.0.1:4317/api/mcp/oauth/callback",
      },
    ]);
    noSecretRendered();
    expect(panel(slackId).queryByLabelText("Client secret (write-only)")).toBeNull();
    expect(card(slackId).getByTestId(`oauth-client-${slackId}`)).toHaveTextContent(
      "my-eligible-app",
    );
    expect(diagnostics(slackId)).toHaveTextContent("client configured");
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("not authenticated");
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected");
    expect(JSON.stringify(backend.integrations)).not.toContain(secretCanary);

    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    expect(dialog().getByText(/one-use authorization for client/)).toHaveTextContent(
      "my-eligible-app",
    );
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(opened).toEqual([]);
    expect(posts().filter((c) => c.endsWith("/connect"))).toEqual([]);
    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    await user.click(dialog().getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatch(/^https:\/\/mcp\.slack\.com\/oauth\/authorize\?/);
    expect(opened[0]).toContain("client_id=my-eligible-app");
    expect(opened[0]).toContain(backend.pendingAuthorizations[slackId]!.nonce);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("authorizing");
    expect(
      panel(slackId).getByText(/Authorization in progress, expires \dm ahead/),
    ).toBeInTheDocument();
    expect(panel(slackId).queryByRole("button", { name: /Connect|Reconnect/ })).toBeNull();
    await user.click(panel(slackId).getByRole("button", { name: "Cancel authorization" }));
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected"),
    );
    expect(backend.pendingAuthorizations[slackId]).toBeUndefined();
    expect(opened).toHaveLength(1);

    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    await user.click(dialog().getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(opened).toHaveLength(2));
    backend.completeOAuthCallback(slackId);
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
        /^authenticatedauthenticated/,
      ),
    );
    expect(
      panel(slackId).getByText(/OAuth authenticated\. Identity and scoped read are not verified/),
    ).toBeInTheDocument();
    expect(panel(slackId).getByRole("button", { name: "Reconnect..." })).toBeEnabled();
    expect(
      panel(slackId).getByRole("button", { name: "Discover OAuth requirements" }),
    ).toBeDisabled();
    expect(
      card(slackId).getByRole("checkbox", { name: /Enabled for review context/ }),
    ).toBeEnabled();
    expect(
      card(slackId).getByRole("checkbox", { name: /Enabled for review context/ }),
    ).not.toBeChecked();
    expect(card(slackId).getByText("needs compatibility")).toBeInTheDocument();
    expect(
      card(slackId).getByText(
        /No reviewed tools yet\. Load tools fetches the reviewed Slack read tools/,
      ),
    ).toBeInTheDocument();
    expect(card(slackId).queryByRole("checkbox", { name: /slack_search_public/ })).toBeNull();
    expect(
      card(slackId).getByText(/Needs the connection enabled with an explicit search tool granted/),
    ).toBeInTheDocument();
    expect(opened).toHaveLength(2);

    await user.click(card(slackId).getByRole("button", { name: "Load tools..." }));
    expect(dialog().getByText(/authenticated\s+inventory access/)).toBeInTheDocument();
    await user.click(dialog().getByRole("button", { name: "Load tools" }));
    await waitFor(() =>
      expect(card(slackId).getByTestId("inventory")).toHaveTextContent("inventory loaded"),
    );
    expect(card(slackId).getByTestId("inventory")).toHaveTextContent("synthetic transport");
    expect(card(slackId).getByTestId("inventory-tools")).toHaveTextContent("slack_search_public");
    expect(card(slackId).queryByText(/No reviewed tools yet/)).toBeNull();
    const search = () =>
      card(slackId).getByRole("checkbox", { name: /^Search accessible public Slack/ });
    expect(search()).not.toBeChecked();
    expect(card(slackId).getAllByRole("checkbox", { name: /one bounded page/ })).toHaveLength(4);
    expect(card(slackId).getAllByText(/^\(disabled: Configured, not connected/)).toHaveLength(4);
    expect(backend.integrationConfigs.find((c) => c.id === slackId)?.allowedTools).toEqual([]);
    expect(diagnostics(slackId)).toHaveTextContent("identity unknown, not verified");

    await user.click(card(slackId).getByRole("button", { name: "Test connection..." }));
    expect(dialog().getByText(/"pr-review connection test"/)).toBeInTheDocument();
    expect(dialog().getByText(/with limit 1/)).toBeInTheDocument();
    expect(
      dialog().getByText(/Requires this connection enabled with an explicit search tool granted/),
    ).toBeInTheDocument();
    expect(
      dialog().getByText(/May use the connection's normal app-owned token refresh/),
    ).toBeInTheDocument();
    expect(
      dialog().getByText(
        /does not independently verify workspace or account identity or channel isolation/,
      ),
    ).toBeInTheDocument();
    expect(dialog().queryByText(/list_issues/)).toBeNull();
    expect(dialog().queryByText(/Independent of enablement and tool grants/)).toBeNull();
    expect(dialog().queryByText(/Does not log in, refresh or approve inventory/)).toBeNull();
    await user.click(dialog().getByRole("button", { name: "Run test" }));
    const evidence = () => within(card(slackId).getByTestId("read-evidence"));
    await card(slackId).findByTestId("read-evidence");
    expect(evidence().getByText("Local configuration only, not tested")).toBeInTheDocument();
    expect(evidence().getByText(SLACK_TEST_FAILED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/Connected \(live read succeeded\)/)).toBeNull();

    await user.click(search());
    await user.click(card(slackId).getByRole("checkbox", { name: /Enabled for review context/ }));
    await waitFor(() =>
      expect(backend.integrationConfigs.find((c) => c.id === slackId)).toMatchObject({
        enabled: true,
        allowedTools: ["slack_search_public"],
      }),
    );
    expect(
      card(slackId).getByText(/^\(allowed: Configured captured read permissions/),
    ).toBeInTheDocument();
    expect(
      card(slackId).getAllByText(/^\(disabled: Configured captured read permissions/),
    ).toHaveLength(3);
    await user.click(card(slackId).getByRole("button", { name: "Test connection..." }));
    await user.click(dialog().getByRole("button", { name: "Run test" }));
    await waitFor(() =>
      expect(evidence().getByText("Synthetic transport, not a live read")).toBeInTheDocument(),
    );
    expect(evidence().getByText(SLACK_TEST_SYNTHETIC_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/Connected \(live read succeeded\)/)).toBeNull();
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
      /^authenticatedauthenticated/,
    );
    expect(backend.integrationConfigs.find((c) => c.id === slackId)).toMatchObject({
      enabled: true,
      allowedTools: ["slack_search_public"],
    });

    await user.click(panel(slackId).getByRole("button", { name: "Disconnect and clean up..." }));
    expect(dialog().getByText(/Deletes only this app-owned credential entry/)).toBeInTheDocument();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(posts().filter((c) => c.endsWith("/disconnect"))).toEqual([]);
    await user.click(panel(slackId).getByRole("button", { name: "Disconnect and clean up..." }));
    await user.click(dialog().getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("needs client"),
    );
    expect(
      panel(slackId).getByText("remote revocation unsupported by the server"),
    ).toBeInTheDocument();
    expect(
      panel(slackId).getByText(/Local authority revoked and the app-owned entry deleted/),
    ).toBeInTheDocument();
    expect(diagnostics(slackId)).toHaveTextContent("no client configured");
    expect(card(slackId).getByTestId("inventory")).toHaveTextContent(/No tool inventory loaded/);
    expect(card(slackId).queryByTestId("read-evidence")).toBeNull();
    expect(panel(slackId).getByTestId(`oauth-form-${slackId}`)).toBeInTheDocument();
    noSecretRendered();
    expect(posts().filter((c) => /register/.test(c))).toEqual([]);
    vi.restoreAllMocks();
  });

  it("uses Linear issue wording from import through Load and requires list_issues for the synthetic Test", async () => {
    const linearId = "native:claude-linear-server-mock-identity";
    window.location.hash = "#/settings";
    calls.length = 0;
    const user = mount({ harness: "saved", oauth: "metadata" });
    await screen.findByTestId(`connection-${linearId}`);
    expect(card(linearId).getByLabelText("Supported OAuth profile")).toHaveValue(
      linearOAuthProfile.id,
    );
    expect(card(linearId).queryByText(/Slack/)).toBeNull();
    cleanup();

    mount({ harness: "saved", oauth: "authenticated", oauthProvider: "linear" }, record);
    await screen.findByTestId(`connection-${linearId}`);
    expect(panel(linearId).getByLabelText("OAuth status")).toHaveTextContent(
      /^authenticatedauthenticated/,
    );
    expect(
      card(linearId).getByText(
        "No reviewed tools yet. Load tools fetches the reviewed Linear issue read tools (get_issue, list_issues) from the authenticated connection; each stays denied until you grant it. No document profile binding is involved.",
      ),
    ).toBeInTheDocument();
    expect(
      card(linearId).getByText(/Needs the connection enabled with list_issues granted/),
    ).toBeInTheDocument();
    expect(card(linearId).queryByText(/Slack|explicit search tool|channel isolation/)).toBeNull();

    await user.click(card(linearId).getByRole("button", { name: "Load tools..." }));
    await user.click(dialog().getByRole("button", { name: "Load tools" }));
    await waitFor(() =>
      expect(card(linearId).getByTestId("inventory")).toHaveTextContent("inventory loaded"),
    );
    const ticket = () => card(linearId).getByRole("checkbox", { name: /get_issue/ });
    const search = () => card(linearId).getByRole("checkbox", { name: /list_issues/ });
    expect(ticket()).not.toBeChecked();
    expect(search()).not.toBeChecked();
    expect(backend.integrationConfigs.find((c) => c.id === linearId)).toMatchObject({
      enabled: false,
      allowedTools: [],
    });

    await user.click(ticket());
    await user.click(card(linearId).getByRole("checkbox", { name: /Enabled for review context/ }));
    await waitFor(() =>
      expect(backend.integrationConfigs.find((c) => c.id === linearId)).toMatchObject({
        enabled: true,
        allowedTools: ["get_issue"],
      }),
    );
    await user.click(card(linearId).getByRole("button", { name: "Test connection..." }));
    expect(
      dialog().getByText(/Sends one bounded list_issues issue search for the fixed quoted query/),
    ).toBeInTheDocument();
    expect(dialog().getByText(/"pr-review connection test"/)).toBeInTheDocument();
    expect(dialog().getByText(/with limit 1/)).toBeInTheDocument();
    expect(dialog().getByText(/a get_issue grant alone does not qualify/)).toBeInTheDocument();
    expect(
      dialog().getByText(
        /does not independently verify workspace or account identity or complete issue coverage/,
      ),
    ).toBeInTheDocument();
    expect(dialog().queryByText(/Slack|channel isolation|concise/)).toBeNull();
    await user.click(dialog().getByRole("button", { name: "Run test" }));
    const evidence = () => within(card(linearId).getByTestId("read-evidence"));
    await card(linearId).findByTestId("read-evidence");
    expect(evidence().getByText("Local configuration only, not tested")).toBeInTheDocument();
    expect(evidence().getByText(LINEAR_TEST_FAILED_MESSAGE)).toBeInTheDocument();

    await user.click(search());
    await waitFor(() =>
      expect(backend.integrationConfigs.find((c) => c.id === linearId)?.allowedTools).toEqual([
        "get_issue",
        "list_issues",
      ]),
    );
    await user.click(card(linearId).getByRole("button", { name: "Test connection..." }));
    await user.click(dialog().getByRole("button", { name: "Run test" }));
    await waitFor(() =>
      expect(evidence().getByText("Synthetic transport, not a live read")).toBeInTheDocument(),
    );
    expect(evidence().getByText(LINEAR_TEST_SYNTHETIC_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/Connected \(live read succeeded\)/)).toBeNull();
    expect(panel(linearId).getByLabelText("OAuth status")).toHaveTextContent(
      /^authenticatedauthenticated/,
    );
    expect(posts().filter((c) => /register|connect|accept-scopes/.test(c))).toEqual([]);
  });

  it("keeps Linear reconnect-required inventory failures denied with Linear wording", async () => {
    const linearId = "native:claude-linear-server-mock-identity";
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "reconnect", oauthProvider: "linear" });
    await screen.findByTestId(`connection-${linearId}`);
    expect(panel(linearId).getByRole("button", { name: "Reconnect..." })).toBeEnabled();
    await user.click(card(linearId).getByRole("button", { name: "Load tools..." }));
    await user.click(dialog().getByRole("button", { name: "Load tools" }));
    await waitFor(() =>
      expect(card(linearId).getByTestId("inventory")).toHaveTextContent(/no longer authorized/),
    );
    expect(
      card(linearId).getByText(
        "The loaded inventory contains none of the reviewed Linear issue read tools (get_issue, list_issues); unknown tools and readOnlyHint never grant access.",
      ),
    ).toBeInTheDocument();
    expect(card(linearId).queryByRole("checkbox", { name: /get_issue|list_issues/ })).toBeNull();
    expect(backend.integrationConfigs.find((c) => c.id === linearId)).toMatchObject({
      enabled: false,
      allowedTools: [],
    });
  });

  it("keeps typed non-secret fields across refresh, clears the secret on authority changes, preserves unchanged rediscovery while configured and reports blocked popups", async () => {
    window.location.hash = "#/settings";
    vi.spyOn(window, "open").mockImplementation(() => null);
    const user = mount({ harness: "saved", oauth: "discovered" });
    await screen.findByTestId(`oauth-form-${slackId}`);
    await user.type(panel(slackId).getByLabelText("Client id"), "kept-client");
    await user.type(panel(slackId).getByLabelText("Client secret (write-only)"), secretCanary);
    backend.updateSettings({ pollIntervalSeconds: 160 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(160));
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue("kept-client");
    await user.click(panel(slackId).getByRole("button", { name: "Clear secret" }));
    expect(panel(slackId).getByLabelText("Client secret (write-only)")).toHaveValue("");
    await user.type(panel(slackId).getByLabelText("Client secret (write-only)"), secretCanary);
    backend.oauthAction(slackId, "discover", {});
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("Client secret (write-only)")).toHaveValue(""),
    );
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue("kept-client");
    noSecretRendered();

    await user.type(panel(slackId).getByLabelText("Client secret (write-only)"), "another");
    await user.click(panel(slackId).getByRole("checkbox", { name: "search:read.public" }));
    await user.click(panel(slackId).getByRole("button", { name: "Save client configuration" }));
    await screen.findByTestId(`oauth-client-${slackId}`);
    await user.type(
      screen.getByLabelText("Absolute source path"),
      `${HOME}/.claude/plugins/slack/.mcp.json`,
    );
    await user.click(screen.getByRole("button", { name: "Discover connections" }));
    expect(
      await screen.findByText(/0 new connections added; 0 changed definitions replaced/),
    ).toBeVisible();
    expect(backend.oauthStates[slackId]?.clientId).toBe("kept-client");
    expect(
      panel(slackId).getByRole("button", { name: "Disconnect and clean up..." }),
    ).toBeEnabled();

    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    await user.click(dialog().getByRole("button", { name: "Connect" }));
    const blocked = await screen.findByText("The authorization window was blocked.");
    const link = within(blocked.closest(".notice")!).getByRole("link", {
      name: "Open authorization page",
    });
    expect(link).toHaveAttribute("href", expect.stringContaining("client_id=kept-client"));
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(backend.oauthActions.filter((a) => a === "connect")).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("reports locked or unsupported storage actionably and keeps cleanup after a failed deletion", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "discovered", oauthStorage: "unavailable" });
    await screen.findByTestId(`oauth-form-${slackId}`);
    expect(screen.getByTestId(`oauth-${slackId}`)).toHaveTextContent("storage unavailable");
    await user.type(panel(slackId).getByLabelText("Client id"), "locked-client");
    await user.type(panel(slackId).getByLabelText("Client secret (write-only)"), secretCanary);
    await user.click(panel(slackId).getByRole("checkbox", { name: "search:read.public" }));
    await user.click(panel(slackId).getByRole("button", { name: "Save client configuration" }));
    await alertWith(/credential_store_unavailable.*unlock it and retry/);
    expect(panel(slackId).getByLabelText("Client secret (write-only)")).toHaveValue("");
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue("locked-client");
    expect(backend.oauthStates[slackId]?.clientId).toBeUndefined();
    await user.click(panel(slackId).getByRole("button", { name: "Disconnect and clean up..." }));
    await user.click(dialog().getByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByText(/credential entry could not be confirmed deleted.*retry Disconnect/),
    ).toBeInTheDocument();
    expect(
      panel(slackId).getByRole("button", { name: "Disconnect and clean up..." }),
    ).toBeEnabled();
    user.unmount();
    uninstall();

    mount({ harness: "saved", oauth: "configured", oauthStorage: "unsupported" });
    await screen.findByTestId(`oauth-${slackId}`);
    expect(screen.getByTestId(`oauth-${slackId}`)).toHaveTextContent("storage unsupported");
    expect(
      panel(slackId).getByText(/Linux is not supported; there is no plaintext/),
    ).toBeInTheDocument();
    expect(panel(slackId).getByRole("button", { name: "Connect..." })).toBeDisabled();
    expect(
      panel(slackId).getByRole("button", { name: "Discover OAuth requirements" }),
    ).toBeDisabled();
  });

  it("renders reconnect required, authorizing after reload and keychain storage without inferring readiness", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "reconnect", oauthStorage: "keychain" });
    await screen.findByTestId(`oauth-${slackId}`);
    const status = panel(slackId).getByLabelText("OAuth status");
    expect(status).toHaveTextContent("reconnect required");
    expect(diagnostics(slackId)).toHaveTextContent("macOS Keychain");
    expect(diagnostics(slackId)).toHaveTextContent(
      "local configuration, no authentication evidence",
    );
    expect(card(slackId).getByText(/not proof the Keychain is unlocked/)).toBeInTheDocument();
    expect(panel(slackId).getByRole("button", { name: "Reconnect..." })).toBeEnabled();
    await user.click(card(slackId).getByRole("button", { name: "Load tools..." }));
    await user.click(dialog().getByRole("button", { name: "Load tools" }));
    await waitFor(() =>
      expect(card(slackId).getByTestId("inventory")).toHaveTextContent("inventory error"),
    );
    user.unmount();
    uninstall();

    const reload = mount({ harness: "saved", oauth: "authorizing" });
    await screen.findByTestId(`oauth-${slackId}`);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("authorizing");
    expect(panel(slackId).getByRole("button", { name: "Cancel authorization" })).toBeEnabled();
    expect(panel(slackId).getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(panel(slackId).queryByText(/expires \dm ahead/)).toBeNull();
    backend.completeOAuthCallback(slackId, "failure");
    await reload.click(panel(slackId).getByRole("button", { name: "Refresh status" }));
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("reconnect required"),
    );
    expect(
      panel(slackId).getByText(/Reconnect required\. Expired, interrupted or ambiguous/),
    ).toBeInTheDocument();
  });

  it("offers dynamic registration only when advertised and profile-permitted, behind the exact typed consent", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "metadata" }, record);
    await screen.findByTestId(`connection-${syntheticId}`);
    expect(card(syntheticId).getByLabelText("Supported OAuth profile")).toHaveValue(
      syntheticOAuthProfile.id,
    );
    await user.click(card(syntheticId).getByRole("button", { name: "Import OAuth metadata" }));
    await screen.findByTestId(`oauth-${syntheticId}`);
    await user.click(
      panel(syntheticId).getByRole("button", { name: "Discover OAuth requirements" }),
    );
    await screen.findByTestId(`oauth-discovery-${syntheticId}`);
    expect(card(syntheticId).getByTestId(`oauth-discovery-${syntheticId}`)).toHaveTextContent(
      /advertised by server; permitted by profile/,
    );
    expect(panel(syntheticId).getByLabelText("Client method")).toHaveValue("none");
    expect(panel(syntheticId).queryByLabelText("Client secret (write-only)")).toBeNull();
    const register = () =>
      panel(syntheticId).getByRole("button", { name: "Register a new client..." });
    expect(register()).toBeDisabled();
    await user.click(panel(syntheticId).getByRole("checkbox", { name: "read:synthetic" }));
    await user.click(register());
    const confirmButton = () => dialog().getByRole("button", { name: "Register client" });
    expect(confirmButton()).toBeDisabled();
    await user.type(dialog().getByLabelText(/Type exactly/), "Register a new MCP OAuth client");
    expect(confirmButton()).toBeEnabled();
    await user.click(dialog().getByRole("button", { name: "Cancel" }));
    expect(posts().filter((c) => c.endsWith("/register"))).toEqual([]);
    await user.click(register());
    expect(confirmButton()).toBeDisabled();
    await user.type(dialog().getByLabelText(/Type exactly/), "Register a new MCP OAuth client");
    await user.click(confirmButton());
    expect(
      await screen.findByText(/Client registered with the authorization server/),
    ).toBeVisible();
    expect(backend.oauthStates[syntheticId]?.clientId).toMatch(/^registered-/);
    expect(diagnostics(syntheticId)).toHaveTextContent("client configured");
    expect(panel(syntheticId).getByLabelText("OAuth status")).toHaveTextContent(
      "not authenticated",
    );
    expect(
      panel(syntheticId).queryByRole("button", { name: "Register a new client..." }),
    ).toBeNull();
  });

  it("surfaces declared native OAuth metadata with provenance, never as eligibility, and adopts the declared client id only on explicit request", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "discovered" }, record);
    calls.length = 0;
    await screen.findByTestId(`oauth-form-${slackId}`);
    const declared = card(slackId).getByTestId(`oauth-declared-${slackId}`);
    expect(field(declared, "Declared source")).toBe(
      `entry slack in ${HOME}/.claude/plugins/slack/.mcp.json`,
    );
    expect(field(declared, "Declared endpoint")).toBe("https://mcp.slack.com/mcp");
    expect(field(declared, "Declared client id")).toBe(DECLARED_PLUGIN_CLIENT_ID);
    expect(field(declared, "Declared callback port")).toBe(
      "3118 (the source's own callback, not this app's)",
    );
    expect(field(declared, "This app's callback")).toBe(
      "http://127.0.0.1:4317/api/mcp/oauth/callback",
    );
    expect(declared).toHaveTextContent(
      /does not show that the registration accepts this app's callback/,
    );
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue("");
    expect(panel(slackId).queryByText(/never reuses a plugin's published client id/)).toBeNull();
    expect(
      panel(slackId).getByText(/Create a new app only if no existing registration/),
    ).toBeInTheDocument();
    expect(posts()).toEqual([]);

    await user.click(panel(slackId).getByRole("button", { name: "Use declared client id" }));
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue(DECLARED_PLUGIN_CLIENT_ID);
    expect(panel(slackId).queryByRole("button", { name: "Use declared client id" })).toBeNull();
    expect(panel(slackId).getByLabelText("Client method")).toHaveValue("client_secret_post");
    expect(panel(slackId).getByLabelText("Client secret (write-only)")).toHaveValue("");
    expect(panel(slackId).getByRole("checkbox", { name: "search:read.public" })).not.toBeChecked();
    expect(
      panel(slackId).getByRole("button", { name: "Save client configuration" }),
    ).toBeDisabled();
    expect(posts()).toEqual([]);
    expect(backend.oauthStates[slackId]?.clientId).toBeUndefined();

    backend.updateSettings({ pollIntervalSeconds: 160 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(160));
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue(DECLARED_PLUGIN_CLIENT_ID);
    await user.clear(panel(slackId).getByLabelText("Client id"));
    await user.type(panel(slackId).getByLabelText("Client id"), "manual-owner-confirmed-app");
    expect(panel(slackId).getByRole("button", { name: "Use declared client id" })).toBeEnabled();
    backend.updateSettings({ pollIntervalSeconds: 170 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(170));
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue("manual-owner-confirmed-app");
    expect(panel(slackId).getByLabelText("Client method")).toHaveValue("client_secret_post");
    expect(posts()).toEqual([]);
    expect(backend.oauthActions).toEqual([]);
    const status = panel(slackId).getByLabelText("OAuth status");
    expect(diagnostics(slackId)).toHaveTextContent("no client configured");
    expect(status).toHaveTextContent("not authenticated");
    const config = backend.integrationConfigs.find((c) => c.id === slackId)!;
    expect(config.enabled).toBe(false);
    expect(config.allowedTools).toEqual([]);
  });

  it("offers the public client method only when the server advertises it and sends no secret with it", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "discovered", oauthMethods: "public" });
    await screen.findByTestId(`oauth-form-${slackId}`);
    expect(card(slackId).getByTestId(`oauth-discovery-${slackId}`)).toHaveTextContent(
      "client_secret_post (confidential), none (public client)",
    );
    const method = panel(slackId).getByLabelText("Client method");
    expect(method).toHaveValue("client_secret_post");
    expect(panel(slackId).getByLabelText("Client secret (write-only)")).toBeInTheDocument();
    await user.click(panel(slackId).getByRole("button", { name: "Use declared client id" }));
    await user.selectOptions(method, "none");
    expect(panel(slackId).queryByLabelText("Client secret (write-only)")).toBeNull();
    expect(panel(slackId).queryByRole("button", { name: "Clear secret" })).toBeNull();
    await user.click(panel(slackId).getByRole("checkbox", { name: "search:read.public" }));
    await user.click(panel(slackId).getByRole("button", { name: "Save client configuration" }));
    await screen.findByTestId(`oauth-client-${slackId}`);
    expect(backend.oauthConfigureBodies).toEqual([
      {
        clientId: DECLARED_PLUGIN_CLIENT_ID,
        clientAuthMethod: "none",
        scopes: ["search:read.public"],
        discoveryDigest: backend.oauthStates[slackId]!.discovery!.digest,
        redirectUri: "http://127.0.0.1:4317/api/mcp/oauth/callback",
      },
    ]);
    expect(backend.oauthActions).toEqual(["configure"]);
    expect(card(slackId).getByTestId(`oauth-client-${slackId}`)).toHaveTextContent(
      `Static client ${DECLARED_PLUGIN_CLIENT_ID}, method none`,
    );
    const status = panel(slackId).getByLabelText("OAuth status");
    expect(diagnostics(slackId)).toHaveTextContent("client configured");
    expect(status).toHaveTextContent("not authenticated");
    expect(status).toHaveTextContent("disconnected");
    expect(
      field(card(slackId).getByTestId(`oauth-declared-${slackId}`), "This app's callback"),
    ).toBe("http://127.0.0.1:4317/api/mcp/oauth/callback");
    const config = backend.integrationConfigs.find((c) => c.id === slackId)!;
    expect(config.enabled).toBe(false);
    expect(config.allowedTools).toEqual([]);
    expect(
      card(slackId).getByRole("checkbox", { name: /Enabled for review context/ }),
    ).not.toBeChecked();
  });

  it("withholds the unadvertised public method and keeps manual client ids without declared metadata", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "discovered" });
    await screen.findByTestId(`oauth-form-${slackId}`);
    expect(slackOAuthProfile.clientAuthMethods).toContain("none");
    expect(
      within(panel(slackId).getByLabelText("Client method")).queryByRole("option", {
        name: "none (public client)",
      }),
    ).toBeNull();
    expect(
      field(card(slackId).getByTestId(`oauth-discovery-${slackId}`), "Allowed client methods"),
    ).toBe("client_secret_post (confidential)");

    await user.click(card(syntheticId).getByRole("button", { name: "Import OAuth metadata" }));
    await screen.findByTestId(`oauth-${syntheticId}`);
    expect(
      panel(syntheticId).getByText("Read support unavailable for this profile."),
    ).toBeInTheDocument();
    expect(card(syntheticId).getByText(/No vetted tools for this connection/)).toBeInTheDocument();
    expect(card(syntheticId).getByText(/no vetted read adapter yet/)).toBeInTheDocument();
    expect(
      card(syntheticId).getByRole("checkbox", { name: /Enabled for review context/ }),
    ).toBeDisabled();
    const declared = card(syntheticId).getByTestId(`oauth-declared-${syntheticId}`);
    expect(field(declared, "Declared client id")).toBe("none declared");
    expect(field(declared, "Declared callback port")).toBe("none declared");
    expect(field(declared, "This app's callback")).toBe(
      "http://127.0.0.1:4317/api/mcp/oauth/callback",
    );
    await user.click(
      panel(syntheticId).getByRole("button", { name: "Discover OAuth requirements" }),
    );
    await screen.findByTestId(`oauth-form-${syntheticId}`);
    expect(panel(syntheticId).queryByRole("button", { name: "Use declared client id" })).toBeNull();
    expect(panel(syntheticId).getByLabelText("Client id")).toHaveValue("");
    await user.type(panel(syntheticId).getByLabelText("Client id"), "manual-synthetic-client");
    backend.updateSettings({ pollIntervalSeconds: 160 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(160));
    expect(panel(syntheticId).getByLabelText("Client id")).toHaveValue("manual-synthetic-client");
    expect(panel(syntheticId).getByLabelText("Client method")).toHaveValue("none");
    expect(panel(syntheticId).queryByLabelText("Client secret (write-only)")).toBeNull();
    expect(backend.oauthStates[syntheticId]?.clientId).toBeUndefined();
    expect(backend.oauthActions).toEqual(["discover"]);
  });

  it("chooses the app callback explicitly by default and sends an exact typed fixed loopback redirect without adopting the declared port", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "discovered", oauthMethods: "public" }, record);
    calls.length = 0;
    await screen.findByTestId(`oauth-form-${slackId}`);
    const chooser = () => within(panel(slackId).getByTestId(`oauth-callback-${slackId}`));
    const appRadio = () => chooser().getByRole("radio", { name: /App callback/ });
    const fixedRadio = () => chooser().getByRole("radio", { name: /Fixed loopback callback/ });
    expect(appRadio()).toBeChecked();
    expect(appRadio()).toHaveAccessibleName(`App callback ${OAUTH_REDIRECT_URI}`);
    expect(chooser().queryByLabelText("Fixed loopback redirect URL")).toBeNull();
    const declared = card(slackId).getByTestId(`oauth-declared-${slackId}`);
    expect(field(declared, "This app's callback")).toBe(OAUTH_REDIRECT_URI);
    expect(field(declared, "Selected callback")).toBe(`${OAUTH_REDIRECT_URI} (app callback)`);
    expect(declared).toHaveTextContent(/declared port is never turned into a redirect/);

    await user.click(fixedRadio());
    const fixedInput = () => chooser().getByLabelText("Fixed loopback redirect URL");
    expect(fixedInput()).toHaveValue("");
    expect(chooser().getByText(/declared callback port 3118 is not adopted/)).toBeInTheDocument();
    expect(panel(slackId).getByTestId(`oauth-callback-${slackId}`)).toHaveTextContent(
      "other than the app port 4317",
    );
    expect(chooser().getByText(/opens only when you click Connect/)).toBeInTheDocument();
    expect(chooser().getByText(/occupied port fails Connect with no takeover/)).toBeInTheDocument();
    expect(chooser().getByText(/handed back to this original browser/)).toBeInTheDocument();
    await user.click(panel(slackId).getByRole("button", { name: "Use declared client id" }));
    await user.selectOptions(panel(slackId).getByLabelText("Client method"), "none");
    await user.click(panel(slackId).getByRole("checkbox", { name: "search:read.public" }));
    const save = () => panel(slackId).getByRole("button", { name: "Save client configuration" });
    expect(save()).toBeDisabled();
    await user.type(fixedInput(), OAUTH_FIXED_REDIRECT_URI);
    expect(panel(slackId).getByText(/confirms the exact redirect/)).toHaveTextContent(
      OAUTH_FIXED_REDIRECT_URI,
    );
    backend.updateSettings({ pollIntervalSeconds: 160 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(160));
    expect(fixedRadio()).toBeChecked();
    expect(fixedInput()).toHaveValue(OAUTH_FIXED_REDIRECT_URI);
    expect(posts()).toEqual([]);
    await user.click(save());
    await screen.findByTestId(`oauth-client-${slackId}`);
    expect(backend.oauthConfigureBodies).toEqual([
      {
        clientId: DECLARED_PLUGIN_CLIENT_ID,
        clientAuthMethod: "none",
        scopes: ["search:read.public"],
        discoveryDigest: backend.oauthStates[slackId]!.discovery!.digest,
        redirectUri: OAUTH_FIXED_REDIRECT_URI,
      },
    ]);
    expect(card(slackId).getByTestId(`oauth-client-${slackId}`)).toHaveTextContent(
      `callback ${OAUTH_FIXED_REDIRECT_URI} (fixed loopback listener, opened only during Connect)`,
    );
    expect(field(declared, "This app's callback")).toBe(OAUTH_REDIRECT_URI);
    expect(field(declared, "Selected callback")).toBe(
      `${OAUTH_FIXED_REDIRECT_URI} (fixed loopback listener, opened only during Connect)`,
    );
    expect(field(declared, "Declared callback port")).toBe(
      "3118 (the source's own callback, not this app's)",
    );
    expect(
      field(card(slackId).getByTestId(`oauth-discovery-${slackId}`), "Selected callback"),
    ).toBe(`${OAUTH_FIXED_REDIRECT_URI} (fixed loopback listener, opened only during Connect)`);
    const status = panel(slackId).getByLabelText("OAuth status");
    expect(diagnostics(slackId)).toHaveTextContent("client configured");
    expect(status).toHaveTextContent("not authenticated");
    expect(status).toHaveTextContent("disconnected");
    expect(
      panel(slackId).getByText(/Connect opens a temporary listener on exactly/),
    ).toHaveTextContent(OAUTH_FIXED_REDIRECT_URI);

    user.unmount();
    const reload = mount({ harness: "saved", oauth: "configured", oauthCallback: "fixed" });
    await screen.findByTestId(`oauth-client-${slackId}`);
    expect(card(slackId).getByTestId(`oauth-client-${slackId}`)).toHaveTextContent(
      `callback ${OAUTH_FIXED_REDIRECT_URI} (fixed loopback listener`,
    );
    await reload.click(
      panel(slackId).getByRole("button", { name: "Replace client configuration" }),
    );
    expect(fixedRadio()).toBeChecked();
    expect(fixedInput()).toHaveValue(OAUTH_FIXED_REDIRECT_URI);
    await reload.click(appRadio());
    expect(chooser().queryByLabelText("Fixed loopback redirect URL")).toBeNull();
    await reload.type(panel(slackId).getByLabelText("Client secret (write-only)"), secretCanary);
    await reload.click(panel(slackId).getByRole("button", { name: "Save client configuration" }));
    await waitFor(() => expect(backend.oauthConfigureBodies).toHaveLength(1));
    expect(backend.oauthConfigureBodies[0]).toMatchObject({
      clientId: "mock-app-owned-client",
      redirectUri: OAUTH_REDIRECT_URI,
    });
    await waitFor(() =>
      expect(card(slackId).getByTestId(`oauth-client-${slackId}`)).toHaveTextContent(
        `callback ${OAUTH_REDIRECT_URI} (app callback)`,
      ),
    );
    noSecretRendered();
  });

  it("keeps the typed fixed redirect when the backend rejects it and never substitutes a value", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "discovered", oauthMethods: "public" });
    await screen.findByTestId(`oauth-form-${slackId}`);
    const chooser = () => within(panel(slackId).getByTestId(`oauth-callback-${slackId}`));
    await user.click(chooser().getByRole("radio", { name: /Fixed loopback callback/ }));
    await user.click(panel(slackId).getByRole("button", { name: "Use declared client id" }));
    await user.selectOptions(panel(slackId).getByLabelText("Client method"), "none");
    await user.click(panel(slackId).getByRole("checkbox", { name: "search:read.public" }));
    const badRedirect = "http://localhost:4317/callback?x=1";
    await user.type(chooser().getByLabelText("Fixed loopback redirect URL"), badRedirect);
    await user.click(panel(slackId).getByRole("button", { name: "Save client configuration" }));
    expect(await screen.findByText(/oauth_callback_invalid/)).toHaveTextContent(
      /Nothing was saved\. Keep the app callback, or enter an exact http:\/\/localhost/,
    );
    expect(backend.oauthStates[slackId]?.clientId).toBeUndefined();
    expect(backend.oauthConfigureBodies).toEqual([]);
    expect(chooser().getByRole("radio", { name: /Fixed loopback callback/ })).toBeChecked();
    expect(chooser().getByLabelText("Fixed loopback redirect URL")).toHaveValue(badRedirect);
    expect(panel(slackId).getByLabelText("Client id")).toHaveValue(DECLARED_PLUGIN_CLIENT_ID);
    expect(diagnostics(slackId)).toHaveTextContent("no client configured");
  });

  it("refuses an occupied fixed port without takeover or fallback, then completes a fixed callback hand-back as authenticated", async () => {
    window.location.hash = "#/settings";
    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return {} as Window;
    });
    const user = mount({ harness: "saved", oauth: "configured", oauthCallback: "occupied" });
    await screen.findByTestId(`oauth-client-${slackId}`);
    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    expect(dialog().getByText(/Opens a temporary listener on exactly that address/)).toBeVisible();
    expect(dialog().getByText(/handed back to this original browser/)).toBeVisible();
    expect(dialog().getByText(/Binds a browser cookie/)).toHaveTextContent(
      `${OAUTH_FIXED_REDIRECT_URI} (fixed loopback listener, opened only during Connect)`,
    );
    await user.click(dialog().getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/oauth_callback_unavailable/)).toHaveTextContent(
      /No listener was opened, no port was taken over and no other callback was substituted/,
    );
    expect(opened).toEqual([]);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected");
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("not authenticated");
    expect(panel(slackId).getByRole("button", { name: "Connect..." })).toBeEnabled();
    expect(backend.pendingAuthorizations[slackId]).toBeUndefined();
    expect(backend.oauthStates[slackId]?.redirectUri).toBe(OAUTH_FIXED_REDIRECT_URI);

    backend.options.oauthCallback = "fixed";
    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    await user.click(dialog().getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(new URL(opened[0]!).searchParams.get("redirect_uri")).toBe(OAUTH_FIXED_REDIRECT_URI);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("authorizing");
    expect(panel(slackId).getByText(/temporary listener at/)).toHaveTextContent(
      `${OAUTH_FIXED_REDIRECT_URI} hands the response back to this browser`,
    );
    await user.click(panel(slackId).getByRole("button", { name: "Cancel authorization" }));
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected"),
    );
    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    await user.click(dialog().getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(opened).toHaveLength(2));
    backend.completeOAuthCallback(slackId);
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
        /^authenticatedauthenticated/,
      ),
    );
    expect(diagnostics(slackId)).toHaveTextContent("identity unknown, not verified");
    expect(
      card(slackId).getByRole("checkbox", { name: /Enabled for review context/ }),
    ).not.toBeChecked();
    expect(backend.integrationConfigs.find((c) => c.id === slackId)?.allowedTools).toEqual([]);
    expect(card(slackId).getByTestId(`oauth-client-${slackId}`)).toHaveTextContent(
      `callback ${OAUTH_FIXED_REDIRECT_URI} (fixed loopback listener`,
    );
    vi.restoreAllMocks();
  });

  it("registers a dynamic client for an explicitly chosen fixed loopback redirect", async () => {
    window.location.hash = "#/settings";
    const user = mount({ harness: "saved", oauth: "metadata" }, record);
    await screen.findByTestId(`connection-${syntheticId}`);
    await user.click(card(syntheticId).getByRole("button", { name: "Import OAuth metadata" }));
    await screen.findByTestId(`oauth-${syntheticId}`);
    await user.click(
      panel(syntheticId).getByRole("button", { name: "Discover OAuth requirements" }),
    );
    await screen.findByTestId(`oauth-discovery-${syntheticId}`);
    const declared = card(syntheticId).getByTestId(`oauth-declared-${syntheticId}`);
    expect(field(declared, "Declared callback port")).toBe("none declared");
    const chooser = () => within(panel(syntheticId).getByTestId(`oauth-callback-${syntheticId}`));
    await user.click(within(screen.getByTestId(`advanced-${syntheticId}`)).getByText("Advanced"));
    await user.click(chooser().getByRole("radio", { name: /Fixed loopback callback/ }));
    expect(
      chooser().getByText(/Type the redirect the registration actually accepts/),
    ).toBeVisible();
    await user.click(panel(syntheticId).getByRole("checkbox", { name: "read:synthetic" }));
    const register = () =>
      panel(syntheticId).getByRole("button", { name: "Register a new client..." });
    expect(register()).toBeDisabled();
    await user.type(
      chooser().getByLabelText("Fixed loopback redirect URL"),
      "http://127.0.0.1:4550/cb",
    );
    await user.click(register());
    expect(
      dialog().getByText(/creates a new client at the authorization server/),
    ).toHaveTextContent(
      "http://127.0.0.1:4550/cb (fixed loopback listener, opened only during Connect)",
    );
    await user.type(dialog().getByLabelText(/Type exactly/), "Register a new MCP OAuth client");
    await user.click(dialog().getByRole("button", { name: "Register client" }));
    await screen.findByTestId(`oauth-client-${syntheticId}`);
    expect(backend.oauthRegisterBodies).toEqual([
      {
        consent: "Register a new MCP OAuth client",
        clientAuthMethod: "none",
        scopes: ["read:synthetic"],
        discoveryDigest: backend.oauthStates[syntheticId]!.discovery!.digest,
        redirectUri: "http://127.0.0.1:4550/cb",
      },
    ]);
    expect(card(syntheticId).getByTestId(`oauth-client-${syntheticId}`)).toHaveTextContent(
      "callback http://127.0.0.1:4550/cb (fixed loopback listener",
    );
    expect(panel(syntheticId).getByLabelText("OAuth status")).toHaveTextContent(
      "not authenticated",
    );
  });
});

describe("review concurrency", () => {
  it("saves a validated maximum concurrent reviews value with scoped help", async () => {
    window.location.hash = "#/settings";
    const user = mount();
    const input = (await screen.findByLabelText("Maximum concurrent reviews")) as HTMLInputElement;
    expect(input).toHaveValue(1);
    expect(input).toHaveAccessibleDescription(
      /Jobs for the same pull request still run one after another/,
    );
    expect(input).toHaveAccessibleDescription(/Ask AI questions keep their own single slot/);
    expect(input).toHaveAccessibleDescription(/does not change polling, auto-review/);
    const form = input.closest("form")!;
    const save = within(form).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    await user.clear(input);
    await user.type(input, "9");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/Enter a whole number from 1 to 8/);
    expect(save).toBeDisabled();
    await user.clear(input);
    await user.type(input, "0");
    expect(save).toBeDisabled();

    await user.clear(input);
    await user.type(input, "3");
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(backend.settings.maxConcurrentReviews).toBe(3));
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    expect(backend.settings.automation.pollRequests).toBe(true);
    await waitFor(() => expect(save).toBeDisabled());
  });
});

describe("model discovery", () => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const record = (b: MockBackend) => {
    const handle = b.handle.bind(b);
    b.handle = (method, path, body) => {
      requests.push({ method, path: new URL(path, "http://localhost").pathname, body });
      return handle(method, path, body);
    };
  };
  const discoveries = () => requests.filter((r) => r.path === "/api/settings/models/discover");
  const mutations = () =>
    requests.filter((r) => r.method !== "GET" && r.path !== "/api/settings/models/discover");
  const mode = (name: string) =>
    within(screen.getByRole("region", { name: "Execution" })).getByRole("radio", { name });
  const field = (name: string) => screen.getByRole("combobox", { name });
  const discoverButton = (name: string) =>
    screen.getByRole("button", { name: new RegExp(`(Discover|Refresh) ${name} choices`) });
  const listbox = (name: string) =>
    within(screen.getByRole("listbox", { name: `${name} choices` }));
  const options = (name: string) =>
    listbox(name)
      .getAllByRole("option")
      .map((option) =>
        [...option.querySelectorAll("span:not([aria-hidden])")]
          .map((span) => span.textContent)
          .join(""),
      );
  const saveButton = () => screen.getByRole("button", { name: /Save execution|Save Dangerous/ });
  const summaryMatching = (pattern: RegExp) => (_: string, element: Element | null) =>
    element?.tagName === "SUMMARY" && pattern.test(element.textContent ?? "");
  const findSummary = (pattern: RegExp) => screen.findAllByText(summaryMatching(pattern));
  const summaries = (pattern: RegExp) => screen.queryAllByText(summaryMatching(pattern));

  beforeEach(() => {
    window.location.hash = "#/settings";
    requests.length = 0;
  });

  it("discovers only on the explicit action with the exact request, keeps null default and custom fallback", async () => {
    const user = mount({ harness: "fresh" }, record);
    await user.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    const main = await screen.findByRole("combobox", { name: "Main model" });
    expect(main).toHaveValue("");
    expect(main).toHaveAccessibleDescription(/Nothing is discovered automatically/);
    await user.click(mode("Codex"));
    await user.click(mode("Pi"));
    await user.click(main);
    expect(options("Main model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: type an exact model id",
    ]);
    await user.type(main, "typed-before-discovery");
    expect(discoveries()).toEqual([]);

    await user.click(discoverButton("Main model"));
    await waitFor(() => expect(discoveries()).toHaveLength(1));
    expect(discoveries()[0]).toEqual({
      method: "POST",
      path: "/api/settings/models/discover",
      body: { harness: "pi" },
    });
    expect(await findSummary(/Discovery at .*ready.*3 choices for Pi/)).toHaveLength(1);
    expect(main).toHaveValue("typed-before-discovery");
    expect(screen.getByText(/cached catalog may be stale/)).toBeInTheDocument();
    expect(screen.getByText(/Account availability not checked/)).toBeInTheDocument();
    expect(discoverButton("Main model")).toHaveTextContent("Refresh models");
    const sources = within(screen.getByLabelText("Pi discovery sources"));
    expect(sources.getByText("pi-models-store")).toBeInTheDocument();
    expect(sources.getByText("/Users/demo/.pi/agent/models-store.json")).toBeInTheDocument();
    expect(sources.getByText(/Freshness unknown/)).toBeInTheDocument();
    expect(sources.getByText("native-catalog").parentElement).toHaveTextContent(/unsupported/);

    await user.clear(main);
    expect(main).toHaveValue("");
    expect(options("Main model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: type an exact model id",
      "Mock Custom Modelmock-provider/custom-v1",
      "Mock Pi Cachedopenai-codex/mock-pi-cached",
      "Mock Pi Nativeopenai-codex/mock-pi-native",
    ]);
    await user.type(main, "pi cach");
    expect(options("Main model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: pi cach",
      "Mock Pi Cachedopenai-codex/mock-pi-cached",
    ]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(main).toHaveValue("openai-codex/mock-pi-cached");
    expect(screen.queryByRole("listbox", { name: "Main model choices" })).toBeNull();
    expect(main).toHaveAccessibleDescription(/Selected Mock Pi Cached/);
    await user.clear(main);
    await user.type(main, "custom-v");
    expect(options("Main model")).toContain("Mock Custom Modelmock-provider/custom-v1");
    await user.clear(main);
    await user.type(main, "nothing-like-this");
    expect(listbox("Main model").getByText(/No discovered Pi choice matches/)).toBeInTheDocument();
    await user.click(listbox("Main model").getByRole("option", { name: /Custom id/ }));
    expect(main).toHaveValue("nothing-like-this");
    await user.click(main);
    await user.click(
      listbox("Main model").getByRole("option", { name: "Native default (resolved on Save)" }),
    );
    expect(main).toHaveValue("");
    await user.type(main, "bad id");
    expect(main).toHaveAttribute("aria-invalid", "true");
    expect(saveButton()).toBeDisabled();
    expect(discoveries()).toHaveLength(1);
    expect(mutations()).toEqual([]);
    expect(backend.settings.automation).toEqual({
      ...automationOff,
      pollRequests: true,
      reviewRequests: true,
    });
  });

  it("distinguishes catalog-only models from configured selections without changing a custom value", async () => {
    const user = mount({ harness: "fresh" }, (b) => {
      record(b);
      const discover = b.discoverModels.bind(b);
      b.discoverModels = async (body) => {
        const result = await discover(body);
        const source = result.sources.find((s) => s.id === "native-catalog")!;
        source.status = "ready";
        result.status = "ready";
        source.message = "Deterministic native metadata fixture, not live account availability.";
        result.models.push({
          model: "fixture-catalog-only",
          label: "Fixture Catalog Only",
          sources: [source.id],
        });
        return result;
      };
    });
    await user.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    const main = await screen.findByRole("combobox", { name: "Main model" });
    await user.type(main, "unsaved-custom");
    await user.click(discoverButton("Main model"));
    await findSummary(/1 catalog; 1 configured\/saved only/);
    expect(main).toHaveValue("unsaved-custom");
    expect(listbox("Main model").getByText("Catalog")).toBeInTheDocument();
    expect(listbox("Main model").getByText("Configured/saved")).toBeInTheDocument();
    await user.click(listbox("Main model").getByRole("option", { name: /Fixture Catalog Only/ }));
    expect(main).toHaveValue("fixture-catalog-only");
    expect(mutations()).toEqual([]);
  });

  it("opens discovered choices beside an existing custom value, including after a harness switch", async () => {
    const user = mount({ harness: "fresh" }, record);
    await user.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    const main = await screen.findByRole("combobox", { name: "Main model" });
    await user.type(main, "my-custom-model");
    await user.click(mode("Pi"));
    expect(main).toHaveValue("my-custom-model");
    await user.click(discoverButton("Main model"));
    await findSummary(/ready.*3 choices for Pi/);
    expect(main).toHaveFocus();
    expect(options("Main model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: my-custom-model",
      "Mock Custom Modelmock-provider/custom-v1",
      "Mock Pi Cachedopenai-codex/mock-pi-cached",
      "Mock Pi Nativeopenai-codex/mock-pi-native",
    ]);
    await user.keyboard("{Escape}");
    expect(main).toHaveValue("my-custom-model");
    await user.click(main);
    await user.type(main, "{Control>}a{/Control}cached");
    expect(options("Main model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: cached",
      "Mock Pi Cachedopenai-codex/mock-pi-cached",
    ]);
    await user.click(listbox("Main model").getByRole("option", { name: /Mock Pi Cached/ }));
    expect(main).toHaveValue("openai-codex/mock-pi-cached");
    await user.click(main);
    expect(options("Main model")).toEqual([
      "Native default (resolved on Save)",
      "Mock Custom Modelmock-provider/custom-v1",
      "Mock Pi Cachedopenai-codex/mock-pi-cached",
      "Mock Pi Nativeopenai-codex/mock-pi-native",
    ]);
    expect(discoveries()).toHaveLength(1);
    expect(mutations()).toEqual([]);
  });

  it("shares discovery per harness across independent Additional rows and preserves custom and saved ids", async () => {
    const user = mount({ harness: "fresh" }, record);
    await user.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    await screen.findByRole("combobox", { name: "Main model" });
    await user.click(screen.getByRole("button", { name: "Add additional reviewer" }));
    await user.click(screen.getByRole("button", { name: "Add additional reviewer" }));
    await user.type(field("Additional reviewer 1 model"), "custom-one");
    await user.type(field("Additional reviewer 2 model"), "custom-two");
    await user.click(discoverButton("Additional reviewer 1 model"));
    await waitFor(() => expect(discoveries()).toHaveLength(1));
    expect(discoveries()[0]!.body).toEqual({ harness: "codex" });
    expect(await findSummary(/partial.*1 choice for Codex/)).toHaveLength(2);
    expect(discoverButton("Additional reviewer 2 model")).toHaveTextContent("Refresh models");
    expect(discoverButton("Main model")).toHaveTextContent("Discover models");
    expect(field("Additional reviewer 1 model")).toHaveValue("custom-one");
    expect(field("Additional reviewer 2 model")).toHaveValue("custom-two");
    expect(field("Additional reviewer 1 model")).toHaveFocus();
    expect(options("Additional reviewer 1 model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: custom-one",
      "mock-codex-configured",
    ]);
    await user.click(field("Additional reviewer 2 model"));
    expect(options("Additional reviewer 2 model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: custom-two",
      "mock-codex-configured",
    ]);
    expect(
      listbox("Additional reviewer 2 model").getByRole("option", { name: "Custom id: custom-two" }),
    ).toHaveClass("active");
    await user.clear(field("Additional reviewer 2 model"));
    expect(options("Additional reviewer 2 model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: type an exact model id",
      "mock-codex-configured",
    ]);
    await user.click(
      listbox("Additional reviewer 2 model").getByRole("option", { name: "mock-codex-configured" }),
    );
    expect(field("Additional reviewer 2 model")).toHaveValue("mock-codex-configured");
    expect(field("Additional reviewer 1 model")).toHaveValue("custom-one");
    expect(screen.getByTestId("additional-reviewer-1")).toBeInTheDocument();
    expect(screen.getByTestId("additional-reviewer-2")).toBeInTheDocument();

    await user.click(saveButton());
    await waitFor(() =>
      expect(backend.harness.selection).toMatchObject({
        harness: "claude",
        reviewer: { model: "claude-fable-5" },
        additional: [
          { id: "reviewer-1", harness: "codex", model: "custom-one" },
          { id: "reviewer-2", harness: "codex", model: "mock-codex-configured" },
        ],
      }),
    );
    expect(backend.modelDiscoveryCalls).toEqual(["codex"]);
    expect(mutations().map((r) => r.path)).toEqual(["/api/settings/harness"]);
    const savedHarness = structuredClone(backend.harness);
    user.unmount();
    requests.length = 0;

    const again = mount({ harness: "fresh" }, (b) => {
      b.harness = savedHarness;
      b.requiresSave = false;
      record(b);
    });
    expect(
      await screen.findByRole("combobox", { name: "Additional reviewer 1 model" }),
    ).toHaveValue("custom-one");
    expect(field("Additional reviewer 2 model")).toHaveValue("mock-codex-configured");
    expect(field("Main model")).toHaveValue("claude-fable-5");
    expect(discoveries()).toEqual([]);
    await again.click(discoverButton("Additional reviewer 2 model"));
    await waitFor(() => expect(discoveries()).toHaveLength(1));
    await findSummary(/partial.*2 choices for Codex/);
    await again.click(field("Additional reviewer 1 model"));
    expect(options("Additional reviewer 1 model")).toEqual([
      "Native default (resolved on Save)",
      "custom-one",
      "mock-codex-configured",
    ]);
    expect(
      listbox("Additional reviewer 1 model").getByRole("option", { name: "custom-one" }),
    ).toHaveAttribute("aria-selected", "true");
    await again.keyboard("{ArrowDown}{Enter}");
    expect(field("Additional reviewer 1 model")).toHaveValue("mock-codex-configured");
    expect(field("Additional reviewer 2 model")).toHaveValue("mock-codex-configured");
    expect(mutations()).toEqual([]);
  });

  it("reports unsupported, source error and transport failures truthfully while keeping custom ids", async () => {
    const user = mount({ harness: "fresh", models: "unsupported" }, record);
    await user.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    const main = await screen.findByRole("combobox", { name: "Main model" });
    await user.type(main, "keep-me");
    await user.click(discoverButton("Main model"));
    expect(await findSummary(/unsupported.*0 choices for Claude Code/)).toHaveLength(1);
    expect(
      within(screen.getByLabelText("Claude Code discovery sources")).getByText("missing"),
    ).toBeInTheDocument();
    expect(main).toHaveValue("keep-me");
    await user.click(main);
    expect(options("Main model")).toEqual([
      "Native default (resolved on Save)",
      "Custom id: keep-me",
    ]);
    user.unmount();

    const errored = mount({ harness: "saved", models: "error" }, record);
    await screen.findByRole("combobox", { name: "Main model" });
    await errored.click(discoverButton("Additional reviewer 1 model"));
    expect(await findSummary(/partial.*2 choices for Codex/)).toHaveLength(2);
    expect(
      within(screen.getAllByLabelText("Codex discovery sources")[0]!).getByText("error")
        .parentElement,
    ).toHaveTextContent(/could not be parsed/);
    await errored.click(field("Additional reviewer 1 model"));
    expect(options("Additional reviewer 1 model")).toEqual([
      "Native default (resolved on Save)",
      "model-one",
      "model-two",
    ]);
    errored.unmount();

    const transport = mount({ harness: "fresh", models: "transport" }, record);
    await transport.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    const again = await screen.findByRole("combobox", { name: "Main model" });
    await transport.type(again, "still-here");
    await transport.click(discoverButton("Main model"));
    expect(
      await screen.findByText(/Discovery failed at .*Mock discovery transport failure/),
    ).toBeInTheDocument();
    expect(summaries(/Previous discovery/)).toEqual([]);
    expect(again).toHaveValue("still-here");
    expect(discoverButton("Main model")).toHaveTextContent("Discover models");
    expect(mutations()).toEqual([]);
  });

  it("labels retained results as previous discovery after a failed refresh and ignores harness switches mid-flight", async () => {
    let release: (() => void) | null = null;
    const user = mount({ harness: "fresh" }, (b) => {
      record(b);
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) => {
        const result = handle(method, path, body);
        if (path.includes("/models/discover") && release === null)
          return new Promise((resolve) => {
            release = () => resolve(result);
          });
        return result;
      };
    });
    await user.click(await screen.findByRole("radio", { name: "Isolated Harnesses" }));
    const main = await screen.findByRole("combobox", { name: "Main model" });
    await user.click(discoverButton("Main model"));
    expect(await screen.findByText(/Discovering Claude Code model choices/)).toBeInTheDocument();
    expect(discoverButton("Main model")).toBeDisabled();
    await user.type(main, "edited-while-loading");
    await user.click(mode("Codex"));
    expect(discoverButton("Main model")).toHaveTextContent("Discover models");
    expect(discoverButton("Main model")).toBeEnabled();
    expect(screen.queryByText(/Discovering/)).toBeNull();
    release!();
    await waitFor(() => expect(backend.modelDiscoveryCalls).toEqual(["claude"]));
    expect(main).toHaveValue("edited-while-loading");
    expect(screen.queryByRole("listbox", { name: "Main model choices" })).toBeNull();
    expect(summaries(/choices? for Claude Code/)).toEqual([]);
    await user.click(mode("Claude Code"));
    expect(summaries(/Discovery at .*partial.*1 choice for Claude Code/)).toHaveLength(1);
    expect(main).toHaveValue("edited-while-loading");

    backend.options.models = "transport";
    await user.click(discoverButton("Main model"));
    expect(
      await screen.findByText(/Refresh failed at .*Mock discovery transport failure/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Previous discovery at .*1 choice for Claude Code/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Showing the previous discovery below/)).toBeInTheDocument();
    await user.clear(main);
    await user.click(main);
    expect(options("Main model")).toContain("mock-claude-configured");
    expect(mutations()).toEqual([]);
  });

  it("offers the same selector for the Docker and Dangerous model field without inspecting or setting up", async () => {
    const user = mount({ harness: "docker" }, record);
    const model = await screen.findByRole("combobox", { name: "Model" });
    expect(mode("Docker")).toBeChecked();
    await user.click(discoverButton("Model"));
    expect(await findSummary(/partial.*2 choices for Codex/)).toHaveLength(1);
    expect(model).toHaveValue("gpt-6-astra");
    await user.clear(model);
    await user.click(listbox("Model").getByRole("option", { name: "mock-codex-configured" }));
    expect(model).toHaveValue("mock-codex-configured");
    await user.click(mode("Dangerous"));
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("mock-codex-configured");
    expect(discoverButton("Model")).toHaveTextContent("Refresh models");
    expect(requests.filter((r) => /inspect|setup|check/.test(r.path))).toEqual([]);
    expect(mutations()).toEqual([]);
    expect(backend.harness.selection).toMatchObject({ workflow: "docker" });
  });
});

describe("oauth capability disclosure", () => {
  const slackId = "native:claude-slack-mock-identity";
  const canary = "mock:additional.capability.canary";
  const second = "mock:second.additional.canary";
  const card = (id: string) => within(screen.getByTestId(`connection-${id}`));
  const panel = (id: string) => within(screen.getByTestId(`oauth-${id}`));
  const calls: string[] = [];
  const record = (b: MockBackend) => {
    const handle = b.handle.bind(b);
    b.handle = (method, path, body) => {
      calls.push(`${method} ${new URL(path, "http://localhost").pathname}`);
      return handle(method, path, body);
    };
  };
  const posts = (suffix: string) =>
    calls.filter((c) => c.startsWith("POST ") && c.endsWith(`/oauth/${suffix}`));
  const list = (label: string) =>
    within(within(screen.getByTestId(`oauth-scopes-${slackId}`)).getByLabelText(label))
      .queryAllByRole("listitem")
      .map((item) => item.textContent);
  const noNamesOutsideDisclosure = () => {
    expect(JSON.stringify([backend.integrations, backend.oauthStatus(slackId)])).not.toContain(
      "mock:",
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain("mock:");
  };
  const review = async (user: ReturnType<typeof mount>) => {
    await user.click(within(screen.getByTestId(`advanced-${slackId}`)).getByText("Advanced"));
    await user.click(
      panel(slackId).getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    return panel(slackId).findByTestId(`oauth-scopes-${slackId}`);
  };

  beforeEach(() => {
    calls.length = 0;
    window.location.hash = "#/settings";
  });

  it("discloses pending additional capabilities only on the explicit local action and accepts exactly the complete ordered list after unchecked consent", async () => {
    const user = mount({ harness: "saved", oauthScopes: "pending" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("authorizing");
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("not authenticated");
    expect(
      panel(slackId).getByText("additional capabilities need exact approval"),
    ).toBeInTheDocument();
    expect(
      panel(slackId).getByText(/Additional credential capabilities need exact local approval/),
    ).toBeInTheDocument();
    expect(panel(slackId).getByText(/provider response was already received/)).toBeInTheDocument();
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(document.body.textContent).not.toContain("mock:");
    await user.click(panel(slackId).getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(calls.filter((c) => c.startsWith("GET "))).not.toHaveLength(0));
    expect(posts("scope-preview")).toEqual([]);
    expect(document.body.textContent).not.toContain("mock:");
    noNamesOutsideDisclosure();

    const disclosure = await review(user);
    expect(posts("scope-preview")).toHaveLength(1);
    expect(calls.filter((c) => /scope-preview/.test(c) && !c.startsWith("POST "))).toEqual([]);
    expect(within(disclosure).getByText(/host credential itself carries broader/)).toBeVisible();
    expect(within(disclosure).getByText(/read-only and default-denied/)).toBeInTheDocument();
    expect(list("Requested")).toEqual(["search:read.public"]);
    expect(list("Granted")).toEqual(["search:read.public", canary, second]);
    expect(list("Missing")).toEqual([]);
    expect(panel(slackId).getByLabelText("Missing")).toHaveTextContent("none");
    expect(list("Additional")).toEqual([canary, second]);
    expect(within(disclosure).getByText("provider")).toBeInTheDocument();
    expect(within(disclosure).getByText(/supplied by the provider/)).toBeInTheDocument();
    expect(disclosure).toHaveTextContent(backend.oauthStates[slackId]!.review!.preview.id);
    expect(disclosure).toHaveTextContent(backend.oauthStates[slackId]!.generation);
    expect(disclosure).toHaveTextContent("mock-app-owned-client");
    expect(disclosure).toHaveTextContent("https://mcp.slack.com");
    expect(disclosure).toHaveTextContent(OAUTH_REDIRECT_URI);
    expect(disclosure.querySelectorAll("a")).toHaveLength(0);
    const consent = within(disclosure).getByRole("checkbox", {
      name: /I accept exactly the 2 additional capabilities/,
    });
    expect(consent).not.toBeChecked();
    const accept = within(disclosure).getByRole("button", { name: OAUTH_SCOPE_CONSENT });
    expect(accept).toBeDisabled();
    await user.click(accept);
    expect(posts("accept-scopes")).toEqual([]);
    noNamesOutsideDisclosure();

    await user.click(consent);
    expect(accept).toBeEnabled();
    await user.click(accept);
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
        /^authenticatedauthenticated/,
      ),
    );
    expect(posts("accept-scopes")).toHaveLength(1);
    expect(backend.oauthApprovalBodies).toEqual([
      {
        previewId: backend.oauthStates[slackId]!.review!.preview.id,
        generation: backend.oauthStates[slackId]!.generation,
        additionalScopes: [canary, second],
        consent: OAUTH_SCOPE_CONSENT,
      },
    ]);
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(panel(slackId).getByText("returned capabilities accepted")).toBeInTheDocument();
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(card(slackId).getByText(/identity unknown, not verified/)).toBeInTheDocument();
    expect(
      card(slackId).getByRole("checkbox", { name: /Enabled for review context/ }),
    ).not.toBeChecked();
    expect(backend.integrationConfigs.find((c) => c.id === slackId)?.allowedTools).toEqual([]);
    expect(document.body.textContent).not.toContain("mock:");
    noNamesOutsideDisclosure();

    await review(user);
    expect(list("Additional")).toEqual([canary, second]);
    expect(list("Granted")).toEqual(["search:read.public", canary, second]);
    expect(
      panel(slackId).getByText(
        "The returned capabilities exceed the requested set; the additional capabilities were explicitly accepted.",
      ),
    ).toBeInTheDocument();
    expect(panel(slackId).queryByText(/match the requested set/)).toBeNull();
    expect(
      panel(slackId).getByText(/explicitly accepted the additional capabilities/),
    ).toHaveTextContent(/not Load or Test evidence and not a reviewer grant/);
    expect(panel(slackId).queryByRole("checkbox", { name: /I accept exactly/ })).toBeNull();
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(panel(slackId).getByText(/OAuth authentication only/)).toBeInTheDocument();
    expect(posts("accept-scopes")).toHaveLength(1);
    expect(backend.oauthApprovalBodies).toHaveLength(1);
  });

  it("refuses locally through cancel without remote revocation, persistence or a second disclosure", async () => {
    const user = mount({ harness: "saved", oauthScopes: "pending" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    const disclosure = await review(user);
    await user.click(within(disclosure).getByRole("checkbox", { name: /I accept exactly/ }));
    await user.click(
      within(disclosure).getByRole("button", { name: "Refuse and cancel authorization" }),
    );
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected"),
    );
    expect(posts("cancel")).toHaveLength(1);
    expect(posts("disconnect")).toEqual([]);
    expect(posts("accept-scopes")).toEqual([]);
    expect(panel(slackId).queryByTestId(`oauth-scope-review-${slackId}`)).toBeNull();
    expect(card(slackId).getByText("remote revocation not attempted")).toBeInTheDocument();
    expect(backend.oauthStates[slackId]!.review).toBeUndefined();
    expect(backend.oauthStatus(slackId).authenticated).toBe(false);
    expect(document.body.textContent).not.toContain("mock:");
    noNamesOutsideDisclosure();
  });

  it("shows missing required permissions with no acceptance control and cancel as the only exit", async () => {
    const user = mount({ harness: "saved", oauthScopes: "missing" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    expect(panel(slackId).getByText("required permissions missing")).toBeInTheDocument();
    expect(panel(slackId).getByText(/Required permissions are missing\. View/)).toBeInTheDocument();
    const disclosure = await review(user);
    expect(within(disclosure).getByText(/cannot invent the missing requirements/)).toBeVisible();
    expect(list("Requested")).toEqual(["search:read.public"]);
    expect(list("Granted")).toEqual([canary]);
    expect(list("Missing")).toEqual(["search:read.public"]);
    expect(list("Additional")).toEqual([canary]);
    expect(panel(slackId).queryByRole("checkbox", { name: /I accept exactly/ })).toBeNull();
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("not authenticated");
    await user.click(within(disclosure).getByRole("button", { name: "Cancel authorization" }));
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected"),
    );
    expect(posts("accept-scopes")).toEqual([]);
    expect(posts("disconnect")).toEqual([]);
    noNamesOutsideDisclosure();
  });

  it("keeps accepted comma-padded and omitted-fallback truth without an acceptance control", async () => {
    const user = mount({ harness: "saved", oauthScopes: "accepted" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
      /^authenticatedauthenticated/,
    );
    expect(panel(slackId).getByText("returned capabilities accepted")).toBeInTheDocument();
    await review(user);
    expect(list("Requested")).toEqual(["search:read.public"]);
    expect(list("Granted")).toEqual(["search:read.public"]);
    expect(list("Additional")).toEqual([]);
    expect(panel(slackId).getByText("provider")).toBeInTheDocument();
    expect(
      panel(slackId).getByText("The returned capabilities match the requested set."),
    ).toBeInTheDocument();
    expect(panel(slackId).getByText(/No acceptance is needed/)).toBeInTheDocument();
    expect(panel(slackId).queryByRole("checkbox", { name: /I accept exactly/ })).toBeNull();
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(panel(slackId).getByText(/not a verified account or workspace/)).toBeInTheDocument();
    user.unmount();
    uninstall();

    const fallback = mount({ harness: "saved", oauthScopes: "fallback" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    await review(fallback);
    expect(panel(slackId).getByText("requested_fallback")).toBeInTheDocument();
    expect(panel(slackId).getByText(/not a provider-supplied grant/)).toBeInTheDocument();
    expect(
      panel(slackId).getByText(
        "The provider returned no scope string; the requested set is assumed, not confirmed.",
      ),
    ).toBeInTheDocument();
    expect(panel(slackId).queryByText(/match the requested set/)).toBeNull();
    expect(list("Granted")).toEqual(["search:read.public"]);
    expect(list("Additional")).toEqual([]);
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(posts("accept-scopes")).toHaveLength(0);
  });

  it("refuses a malformed HTML scope set whole with no partial disclosure and requires reconnect", async () => {
    mount({ harness: "saved", oauthScopes: "invalid" }, record);
    await screen.findByTestId(`oauth-${slackId}`);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("reconnect required");
    expect(panel(slackId).queryByTestId(`oauth-scope-review-${slackId}`)).toBeNull();
    expect(panel(slackId).getByRole("button", { name: "Reconnect..." })).toBeEnabled();
    expect(document.body.innerHTML).not.toContain("onerror");
    expect(document.body.textContent).not.toContain("<img");
    expect(backend.oauthStates[slackId]!.review).toBeUndefined();
    expect(posts("scope-preview")).toEqual([]);
  });

  it("shows fixed actionable errors for a wrong-browser preview and a storage failure on acceptance without retrying", async () => {
    const user = mount({ harness: "saved", oauthScopes: "browser" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    await user.click(
      panel(slackId).getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    await screen.findByText(/oauth_scope_consent_invalid/);
    expect(
      screen.getByText(/belongs to another browser or generation, or no longer matches/),
    ).toBeInTheDocument();
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(document.body.textContent).not.toContain("mock:");
    expect(posts("scope-preview")).toHaveLength(1);
    user.unmount();
    uninstall();
    calls.length = 0;

    const failing = mount(
      { harness: "saved", oauthScopes: "pending", oauthStorage: "unavailable" },
      record,
    );
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    const disclosure = await review(failing);
    await failing.click(within(disclosure).getByRole("checkbox", { name: /I accept exactly/ }));
    await failing.click(within(disclosure).getByRole("button", { name: OAUTH_SCOPE_CONSENT }));
    await screen.findByText(/credential_store_unavailable/);
    expect(screen.getByText(/explicitly Reconnect rather than repeating/)).toBeInTheDocument();
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("reconnect required"),
    );
    expect(posts("accept-scopes")).toHaveLength(1);
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(panel(slackId).queryByTestId(`oauth-scope-review-${slackId}`)).toBeNull();
    expect(backend.oauthApprovalBodies).toEqual([]);
    expect(backend.oauthStatus(slackId).authenticated).toBe(false);
    noNamesOutsideDisclosure();
  });

  it("discards an open disclosure when another client cancels the generation and never accepts against it", async () => {
    const user = mount({ harness: "saved", oauthScopes: "pending" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    const disclosure = await review(user);
    await user.click(within(disclosure).getByRole("checkbox", { name: /I accept exactly/ }));
    backend.oauthAction(slackId, "cancel", {});
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected"),
    );
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(posts("accept-scopes")).toEqual([]);
    expect(document.body.textContent).not.toContain("mock:");
  });

  const continuationOf = (b: MockBackend) => b.oauthStates[slackId]!.review!.preview.id;
  const arriving = (b: MockBackend, continuation = continuationOf(b)) => {
    record(b);
    window.location.hash = `#/settings?oauthReview=${continuation}`;
  };
  const returnNotice = () => screen.queryByText("The OAuth review return could not be continued.");
  const unavailableBody = () =>
    screen.getByText(
      /This return itself accepted, persisted, replayed, refreshed or revoked nothing/,
    );

  it("returns the browser handback directly into the local disclosure once, removes the fragment and keeps the continuation out of storage", async () => {
    const user = mount({ harness: "saved", oauthScopes: "pending" }, arriving);
    const disclosure = await screen.findByTestId(`oauth-scopes-${slackId}`);
    expect(window.location.hash).toBe("#/settings");
    expect(window.location.href).not.toContain("oauthReview");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toHaveLength(1);
    expect(calls.indexOf("POST /api/mcp/oauth/review-return")).toBeLessThan(
      calls.findIndex((c) => c.endsWith("/oauth/scope-preview")),
    );
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole("dialog")).toContainElement(disclosure);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("not authenticated");
    expect(screen.getByText(/Disclosure available until/)).toBeInTheDocument();
    expect(backend.oauthStates[slackId]!.review!.preview.expiresAt).toBe(
      backend.oauthStatus(slackId).scopeReview!.expiresAt,
    );
    expect(list("Requested")).toEqual(["search:read.public"]);
    expect(list("Granted")).toEqual(["search:read.public", canary, second]);
    expect(list("Additional")).toEqual([canary, second]);
    const consent = within(disclosure).getByRole("checkbox", { name: /I accept exactly the 2/ });
    expect(consent).not.toBeChecked();
    const accept = within(disclosure).getByRole("button", { name: OAUTH_SCOPE_CONSENT });
    expect(accept).toBeDisabled();
    expect(
      within(disclosure).getByRole("button", { name: "Refuse and cancel authorization" }),
    ).toBeEnabled();
    expect(backend.oauthStatus(slackId).authenticated).toBe(false);
    expect(backend.oauthApprovalBodies).toEqual([]);
    noNamesOutsideDisclosure();

    await user.click(panel(slackId).getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(calls.filter((c) => c.startsWith("GET "))).not.toHaveLength(0));
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toHaveLength(1);
    expect(screen.getByTestId(`oauth-scopes-${slackId}`)).toBeInTheDocument();

    await user.click(consent);
    await user.click(accept);
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
        /^authenticatedauthenticated/,
      ),
    );
    expect(backend.oauthApprovalBodies).toEqual([
      {
        previewId: backend.oauthStates[slackId]!.review!.preview.id,
        generation: backend.oauthStates[slackId]!.generation,
        additionalScopes: [canary, second],
        consent: OAUTH_SCOPE_CONSENT,
      },
    ]);
    expect(posts("review-return")).toHaveLength(1);
    const reads = await within(screen.getByRole("dialog")).findByRole("group", {
      name: "Allowed reads",
    });
    for (const box of within(reads).getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(calls.filter((call) => call.endsWith("/load-tools"))).toHaveLength(1);
    expect(posts("connect")).toEqual([]);
    expect(backend.integrationConfigs.find((c) => c.id === slackId)?.allowedTools).toEqual([]);
    expect(card(slackId).getByText(/identity unknown, not verified/)).toBeInTheDocument();
    noNamesOutsideDisclosure();
  });

  it("refuses locally after a direct return and returns missing or accepted outcomes to their truthful disclosures", async () => {
    const user = mount({ harness: "saved", oauthScopes: "pending" }, arriving);
    const disclosure = await screen.findByTestId(`oauth-scopes-${slackId}`);
    await user.click(
      within(disclosure).getByRole("button", { name: "Refuse and cancel authorization" }),
    );
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected"),
    );
    expect(posts("cancel")).toHaveLength(1);
    expect(posts("disconnect")).toEqual([]);
    expect(posts("accept-scopes")).toEqual([]);
    expect(backend.oauthStates[slackId]!.review).toBeUndefined();
    user.unmount();
    uninstall();
    calls.length = 0;

    const missing = mount({ harness: "saved", oauthScopes: "missing" }, arriving);
    const cancelOnly = await screen.findByTestId(`oauth-scopes-${slackId}`);
    expect(within(cancelOnly).getByText(/cannot invent the missing requirements/)).toBeVisible();
    expect(list("Missing")).toEqual(["search:read.public"]);
    expect(panel(slackId).queryByRole("checkbox", { name: /I accept exactly/ })).toBeNull();
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(within(cancelOnly).getByRole("button", { name: "Cancel authorization" })).toBeEnabled();
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toHaveLength(1);
    missing.unmount();
    uninstall();
    calls.length = 0;

    mount({ harness: "saved", oauthScopes: "accepted" }, arriving);
    await screen.findByTestId(`oauth-scopes-${slackId}`);
    expect(
      screen.getByText("The returned capabilities match the requested set."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
      /^authenticatedauthenticated/,
    );
    expect(posts("accept-scopes")).toEqual([]);
    noNamesOutsideDisclosure();
  });

  it("never discloses on an ordinary settings mount, catalog refresh or change event without a redeemed return", async () => {
    mount({ harness: "saved", oauthScopes: "pending" }, record);
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    backend.updateSettings({ pollIntervalSeconds: 150 });
    await waitFor(() => expect(screen.getByLabelText("Poll interval (seconds)")).toHaveValue(150));
    expect(posts("review-return")).toEqual([]);
    expect(posts("scope-preview")).toEqual([]);
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(returnNotice()).toBeNull();
    expect(document.body.textContent).not.toContain("mock:");
  });

  it("shows one fixed unavailable notice for stale, replayed or wrong-browser returns without names, automatic Connect or retry", async () => {
    const stale = mount({ harness: "saved", oauthScopes: "pending" }, (b) =>
      arriving(b, "mock-stale-continuation"),
    );
    expect(
      await screen.findByText("The OAuth review return could not be continued."),
    ).toBeVisible();
    expect(unavailableBody()).toBeVisible();
    expect(window.location.hash).toBe("#/settings");
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toEqual([]);
    expect(posts("connect")).toEqual([]);
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(
      panel(slackId).getByRole("button", { name: "Review returned OAuth capabilities" }),
    ).toBeEnabled();
    expect(panel(slackId).getByRole("button", { name: "Cancel authorization" })).toBeEnabled();
    expect(document.body.textContent).not.toContain("mock:");
    await stale.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(returnNotice()).toBeNull();
    expect(posts("review-return")).toHaveLength(1);
    stale.unmount();
    uninstall();
    calls.length = 0;

    const replayed = mount({ harness: "saved", oauthScopes: "pending" }, (b) => {
      arriving(b);
      b.reviewReturn({ continuation: continuationOf(b) });
    });
    expect(
      await screen.findByText("The OAuth review return could not be continued."),
    ).toBeVisible();
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toEqual([]);
    expect(backend.oauthStatus(slackId).scopeReview?.status).toBe("approval_required");
    replayed.unmount();
    uninstall();
    calls.length = 0;

    mount({ harness: "saved", oauthScopes: "browser" }, arriving);
    expect(
      await screen.findByText("The OAuth review return could not be continued."),
    ).toBeVisible();
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toEqual([]);
    expect(document.body.textContent).not.toContain("mock:");
  });

  it("requires the current connection generation and drops a delayed catalog after leaving Settings", async () => {
    const drifted = mount({ harness: "saved", oauthScopes: "pending" }, (b) => {
      arriving(b);
      const handle = b.handle.bind(b);
      b.handle = (method, path, body) => {
        const result = handle(method, path, body);
        if (path.endsWith("/review-return")) b.oauthAction(slackId, "cancel", {});
        return result;
      };
    });
    expect(
      await screen.findByText("The OAuth review return could not be continued."),
    ).toBeVisible();
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toEqual([]);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("disconnected");
    expect(panel(slackId).queryByTestId(`oauth-scope-review-${slackId}`)).toBeNull();
    drifted.unmount();
    uninstall();
    calls.length = 0;

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const user = mount({ harness: "saved", oauthScopes: "pending" }, (b) => {
      arriving(b);
      const handle = b.handle.bind(b);
      let gate = false;
      b.handle = async (method, path, body) => {
        if (path.endsWith("/review-return")) gate = true;
        else if (gate && method === "GET" && path === "/api/state") await held;
        return handle(method, path, body);
      };
    });
    await waitFor(() => expect(posts("review-return")).toHaveLength(1));
    await user.click(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", {
        name: "Inbox",
      }),
    );
    await screen.findByText("Apply volume discounts on invoices");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await user.click(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", {
        name: "Settings",
      }),
    );
    await screen.findByTestId(`oauth-scope-review-${slackId}`);
    expect(posts("scope-preview")).toEqual([]);
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(returnNotice()).toBeNull();
    expect(posts("review-return")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("mock:");
  });

  it("tells the truth about callback admission before Connect and after an unavailable return", async () => {
    const user = mount({ harness: "saved", oauth: "configured" }, record);
    await screen.findByTestId(`oauth-client-${slackId}`);
    await user.click(panel(slackId).getByRole("button", { name: "Connect..." }));
    const dialog = within(screen.getByRole("dialog"));
    const handoff = dialog.getByText(/returns here automatically/);
    expect(handoff).toHaveTextContent(
      /exact requested set, or a provider response that omits a scope string so the requested set is assumed, is persisted and authenticated at the callback with no further accept step/,
    );
    expect(handoff).toHaveTextContent(
      /Additional returned capabilities stay unpersisted and unusable until you accept exactly the listed additional capabilities or refuse/,
    );
    expect(handoff).toHaveTextContent(/Missing requirements cannot be accepted, only cancelled/);
    expect(handoff).toHaveTextContent(
      /A return that cannot be continued, such as a reused or expired one, changes none of these outcomes; the refreshed status here is authoritative/,
    );
    expect(dialog.queryByText(/Nothing is persisted or usable until you accept/)).toBeNull();
    expect(dialog.getByText(/Authentication grants no tools/)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(posts("connect")).toEqual([]);
    user.unmount();
    uninstall();
    calls.length = 0;

    for (const oauthScopes of ["accepted", "fallback"] as const) {
      const replayed = mount({ harness: "saved", oauthScopes }, (b) => {
        arriving(b);
        b.reviewReturn({ continuation: continuationOf(b) });
      });
      expect(
        await screen.findByText("The OAuth review return could not be continued."),
      ).toBeVisible();
      expect(unavailableBody()).toHaveTextContent(
        /neither proves nor rules out an earlier admission: an exact or assumed requested set may already be authenticated, or additional capabilities may already have been explicitly accepted. This failed return changes neither/,
      );
      expect(screen.queryByText(/Nothing was accepted/)).toBeNull();
      expect(screen.queryByText(/stay unaccepted/)).toBeNull();
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
        /^authenticatedauthenticated/,
      );
      expect(backend.oauthStatus(slackId).authenticated).toBe(true);
      expect(backend.oauthStatus(slackId).scopeReview?.status).toBe("accepted");
      expect(panel(slackId).getByText("returned capabilities accepted")).toBeInTheDocument();
      expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
      expect(posts("review-return")).toHaveLength(1);
      expect(posts("scope-preview")).toEqual([]);
      expect(posts("accept-scopes")).toEqual([]);
      expect(posts("connect")).toEqual([]);
      expect(backend.oauthApprovalBodies).toEqual([]);
      expect(document.body.textContent).not.toContain("mock:");
      replayed.unmount();
      uninstall();
      calls.length = 0;
    }

    const accepting = mount({ harness: "saved", oauthScopes: "pending" }, arriving);
    const disclosure = await screen.findByTestId(`oauth-scopes-${slackId}`);
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent("not authenticated");
    await accepting.click(
      within(disclosure).getByRole("checkbox", { name: /I accept exactly the 2/ }),
    );
    await accepting.click(within(disclosure).getByRole("button", { name: OAUTH_SCOPE_CONSENT }));
    await waitFor(() =>
      expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
        /^authenticatedauthenticated/,
      ),
    );
    expect(backend.oauthApprovalBodies).toHaveLength(1);
    const continuation = continuationOf(backend);
    const deadline = backend.oauthStatus(slackId).scopeReview!.expiresAt;
    accepting.unmount();
    uninstall();
    calls.length = 0;

    window.location.hash = `#/settings?oauthReview=${continuation}`;
    uninstall = installMockApi(backend);
    const replayedAfterAcceptance = render(<App mock />);
    expect(
      await screen.findByText("The OAuth review return could not be continued."),
    ).toBeVisible();
    expect(unavailableBody()).toHaveTextContent(
      /additional capabilities may already have been explicitly accepted. This failed return changes neither/,
    );
    expect(screen.queryByText(/stay unaccepted/)).toBeNull();
    expect(screen.queryByText(/Nothing was accepted/)).toBeNull();
    expect(window.location.hash).toBe("#/settings");
    expect(panel(slackId).getByLabelText("OAuth status")).toHaveTextContent(
      /^authenticatedauthenticated/,
    );
    expect(panel(slackId).getByText("returned capabilities accepted")).toBeInTheDocument();
    expect(card(slackId).getByText(/identity unknown, not verified/)).toBeInTheDocument();
    expect(panel(slackId).queryByTestId(`oauth-scopes-${slackId}`)).toBeNull();
    expect(panel(slackId).queryByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeNull();
    expect(backend.oauthStatus(slackId).authenticated).toBe(true);
    expect(backend.oauthStatus(slackId).scopeReview).toEqual({
      status: "accepted",
      expiresAt: deadline,
    });
    expect(backend.oauthApprovalBodies).toHaveLength(1);
    expect(backend.integrationConfigs.find((c) => c.id === slackId)).toMatchObject({
      enabled: false,
      allowedTools: [],
    });
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toEqual([]);
    expect(posts("accept-scopes")).toEqual([]);
    expect(posts("connect")).toEqual([]);
    expect(calls.filter((c) => c.startsWith("POST ") && c.includes("/oauth/"))).toEqual([
      "POST /api/mcp/oauth/review-return",
    ]);
    noNamesOutsideDisclosure();
    expect(document.body.textContent).not.toContain("mock:");
    replayedAfterAcceptance.unmount();
  });

  it("redeems and previews exactly once under duplicated strict-mode effects", async () => {
    backend = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauthScopes: "pending" });
    arriving(backend);
    uninstall = installMockApi(backend);
    render(
      <StrictMode>
        <App mock />
      </StrictMode>,
    );
    await screen.findByTestId(`oauth-scopes-${slackId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts("review-return")).toHaveLength(1);
    expect(posts("scope-preview")).toHaveLength(1);
    expect(window.location.hash).toBe("#/settings");
    expect(list("Additional")).toEqual([canary, second]);
    noNamesOutsideDisclosure();
  });
});

describe("guided connections", () => {
  const slackId = "native:claude-slack-mock-identity";
  const linearId = "native:claude-linear-server-mock-identity";
  const calls: Array<{ call: string; body: unknown }> = [];
  const gates: Record<string, Promise<void>> = {};
  const record = (b: MockBackend) => {
    const handle = b.handle.bind(b);
    b.handle = async (method, path, body) => {
      const call = `${method} ${new URL(path, "http://localhost").pathname}`;
      calls.push({ call, body });
      const gate = Object.keys(gates).find((suffix) => call.endsWith(suffix));
      if (gate) await gates[gate];
      return handle(method, path, body);
    };
  };
  const posts = () =>
    calls
      .filter(({ call }) => call.startsWith("POST ") || call.startsWith("PATCH "))
      .map(({ call }) => call.split("/integrations/").pop()!)
      .map((rest) => rest.slice(rest.indexOf("/") + 1));
  const card = (id: string) => within(screen.getByTestId(`connection-${id}`));
  const status = (id: string) => screen.getByTestId(`status-${id}`);
  const flow = () => within(screen.getByRole("dialog"));
  const mode = (name: string) =>
    within(screen.getByRole("radiogroup", { name: "Execution type" })).getByRole("radio", { name });
  const config = (id: string) => backend.integrationConfigs.find((c) => c.id === id)!;
  let opened: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(gates)) delete gates[key];
    opened = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    window.location.hash = "#/settings";
  });

  it("shows Connections only for Isolated or Docker, following unsaved choices without saving or changing connections", async () => {
    const user = mount({ harness: "saved", oauth: "authenticated" }, record);
    await screen.findByTestId(`connection-${slackId}`);
    const before = structuredClone(backend.integrationConfigs);
    await user.click(mode("Dangerous"));
    expect(screen.queryByRole("heading", { name: "Connections" })).toBeNull();
    await user.click(mode("Docker"));
    expect(await screen.findByTestId(`connection-${slackId}`)).toBeInTheDocument();
    expect(status(slackId)).toHaveTextContent("Connected (synthetic)");
    await user.click(mode("Dangerous"));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByTestId(`connection-${slackId}`)).toBeInTheDocument();
    expect(posts()).toEqual([]);
    expect(backend.integrationConfigs).toEqual(before);
    expect(backend.oauthStatus(slackId).authenticated).toBe(true);
    user.unmount();
    uninstall();

    mount({ harness: "dangerous", oauth: "authenticated" }, record);
    await waitFor(() => expect(mode("Dangerous")).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByRole("heading", { name: "Connections" })).toBeNull();
    expect(backend.oauthStatus(slackId).authenticated).toBe(true);
  });

  it("adds a reviewed provider without native discovery or implicit sign-in, and hides add in Dangerous", async () => {
    const user = mount({ harness: "saved" }, record);
    const select = await screen.findByRole("combobox", { name: "Add a provider" });
    expect(screen.getByText(/Claude built-in connectors are not discovered/)).toBeVisible();
    const add = screen.getByRole("button", { name: "Add provider" });
    expect(add).toBeDisabled();
    await user.selectOptions(select, "linear-mcp/1");
    await user.click(add);
    const id = "oauth:linear-mcp/1";
    await screen.findByTestId(`connection-${id}`);
    expect(config(id)).toMatchObject({ enabled: false, allowedTools: [], source: "custom" });
    expect(config(id).native).toBeUndefined();
    expect(config(id).inventory).toBeUndefined();
    expect(status(id)).not.toHaveTextContent("Connected");
    expect(add).toBeDisabled();
    expect(posts()).toEqual(["add-oauth"]);
    expect(opened).toEqual([]);
    await user.click(card(id).getByRole("button", { name: "Connect" }));
    await flow().findByText("Register a new MCP OAuth client");
    expect(posts()).toEqual(["add-oauth", "oauth/discover"]);
    expect(opened).toEqual([]);
    await user.click(flow().getByRole("button", { name: "Close" }));
    await user.click(mode("Dangerous"));
    expect(screen.queryByRole("combobox", { name: "Add a provider" })).toBeNull();
    await user.click(mode("Docker"));
    expect(await screen.findByTestId(`connection-${id}`)).toBeVisible();
    expect(config(id).allowedTools).toEqual([]);
  });

  it("keeps Advanced optional and resumes authenticated unloaded setup from Continue without signing in", async () => {
    const user = mount({ harness: "saved", oauth: "authenticated" }, record);
    await screen.findByTestId(`connection-${slackId}`);
    expect(status(slackId)).toHaveTextContent("Connected (synthetic)");
    expect(status(slackId)).toHaveTextContent("review access not set up");
    const advanced = screen.getByTestId(`advanced-${slackId}`) as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(card(slackId).getByText("Disconnect and clean up...")).not.toBeVisible();
    expect(card(slackId).getByText("Test connection...")).not.toBeVisible();
    await user.click(within(advanced).getByText("Advanced"));
    expect(advanced.open).toBe(true);
    expect(card(slackId).getByText("Disconnect and clean up...")).toBeVisible();

    const bearer = "native:claude-plugin-bearer-mock-identity";
    expect(status(bearer)).toHaveTextContent("Unsupported");
    expect(card(bearer).getByTestId(`connect-${bearer}`)).toBeDisabled();
    expect(card(bearer).getByTestId(`problem-${bearer}`)).toBeVisible();
    expect(status("native:claude-linear-server-mock-identity")).toHaveTextContent("Not connected");

    await user.click(within(advanced).getByText("Advanced"));
    await user.click(card(slackId).getByRole("button", { name: "Continue" }));
    const grants = await flow().findByRole("group", { name: "Allowed reads" });
    expect(advanced.open).toBe(false);
    for (const box of within(grants).getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(posts()).toEqual(["load-tools"]);
    expect(config(slackId)).toMatchObject({ enabled: false, allowedTools: [] });
    expect(opened).toEqual([]);
    await user.click(flow().getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retries failed inventory in the primary flow and closing during Load never grants tools", async () => {
    let fail = true;
    let release!: () => void;
    const user = mount({ harness: "saved", oauth: "authenticated" }, (b) => {
      record(b);
      const handle = b.handle.bind(b);
      b.handle = async (method, path, body) => {
        if (path.endsWith("/load-tools") && fail) {
          fail = false;
          throw new Error("Synthetic inventory unavailable; retry loading");
        }
        return handle(method, path, body);
      };
    });
    await screen.findByTestId(`connection-${slackId}`);
    await user.click(card(slackId).getByRole("button", { name: "Continue" }));
    expect(await flow().findByText(/Synthetic inventory unavailable/)).toBeVisible();
    gates["/load-tools"] = new Promise((resolve) => (release = resolve));
    await user.click(flow().getByRole("button", { name: "Retry loading read tools" }));
    expect(await flow().findByText("Loading Slack MCP read tools...")).toBeVisible();
    await user.click(flow().getByRole("button", { name: "Close" }));
    release();
    await waitFor(() => expect(config(slackId).inventory?.status).toBe("loaded"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(config(slackId)).toMatchObject({ enabled: false, allowedTools: [] });
    await user.click(card(slackId).getByRole("button", { name: "Continue" }));
    const grants = await flow().findByRole("group", { name: "Allowed reads" });
    await user.click(within(grants).getAllByRole("checkbox")[0]!);
    await user.click(flow().getByRole("button", { name: "Allow for reviews" }));
    await flow().findByRole("button", { name: "Change review access" });
    await user.click(flow().getByRole("button", { name: "Done" }));
    const saved = structuredClone(config(slackId));
    calls.length = 0;
    await user.click(card(slackId).getByRole("button", { name: "Connected" }));
    await user.click(flow().getByRole("button", { name: "Change review access" }));
    expect(
      within(flow().getByRole("group", { name: "Allowed reads" })).getAllByRole("checkbox")[0],
    ).toBeChecked();
    await user.click(flow().getByRole("button", { name: "Not now" }));
    expect(config(slackId)).toEqual(saved);
    expect(posts()).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("retains saved disabled read choices without enabling them until explicit confirmation", async () => {
    const user = mount({ harness: "saved", oauth: "authenticated" }, (b) => {
      b.loadIntegrationTools(slackId);
      const saved = b.integrationConfigs.find((c) => c.id === slackId)!;
      saved.enabled = false;
      saved.allowedTools = ["slack_search_public"];
      record(b);
    });
    await screen.findByTestId(`connection-${slackId}`);
    await user.click(card(slackId).getByRole("button", { name: "Continue" }));
    const boxes = within(await flow().findByRole("group", { name: "Allowed reads" })).getAllByRole(
      "checkbox",
    );
    expect(boxes[0]).toBeChecked();
    for (const box of boxes.slice(1)) expect(box).not.toBeChecked();
    await user.click(flow().getByRole("button", { name: "Not now" }));
    expect(config(slackId)).toMatchObject({
      enabled: false,
      allowedTools: ["slack_search_public"],
    });
    expect(posts()).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("connects Slack end to end, asking only for the missing secret and the explicit read grants", async () => {
    const user = mount({ harness: "saved", oauth: "metadata" }, record);
    await screen.findByTestId(`connection-${slackId}`);
    expect(status(slackId)).toHaveTextContent("Not connected");
    await user.click(card(slackId).getByRole("button", { name: "Connect" }));
    expect(await flow().findByLabelText("Client id")).toHaveValue(DECLARED_PLUGIN_CLIENT_ID);
    expect(posts()).toEqual(["import-oauth", "oauth/discover"]);
    expect(flow().getByText(/doesn't prove the app accepts this callback/)).toBeInTheDocument();
    const next = flow().getByRole("button", { name: "Save and continue" });
    expect(next).toBeDisabled();
    const plan = flow().getByTestId("sign-in-plan");
    expect(plan).toHaveTextContent(/Slack MCP sign-in opens in a new window/);
    expect(plan).toHaveTextContent(/exactly what was asked, or doesn't say/);
    expect(plan).toHaveTextContent(
      /unsaved and unusable until you accept or refuse that exact list/,
    );
    expect(plan).toHaveTextContent(/at most five minutes/);
    expect(plan).toHaveTextContent(/can only be cancelled/);
    expect(plan).toHaveTextContent(/You choose each read afterward, all off/);
    await user.type(flow().getByLabelText("Client secret"), "TYPED_SECRET_CANARY");
    await user.click(next);
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toContain(`client_id=${DECLARED_PLUGIN_CLIENT_ID}`);
    expect(posts()).toEqual(["import-oauth", "oauth/discover", "oauth/configure", "oauth/connect"]);
    expect(backend.oauthConfigureBodies).toEqual([
      {
        clientId: DECLARED_PLUGIN_CLIENT_ID,
        clientAuthMethod: "client_secret_post",
        clientSecret: "TYPED_SECRET_CANARY",
        scopes: ["search:read.public", "search:read.private"],
        discoveryDigest: backend.oauthStates[slackId]!.discovery!.digest,
        redirectUri: OAUTH_REDIRECT_URI,
      },
    ]);
    expect(await flow().findByText(/Finish signing in to Slack MCP/)).toBeInTheDocument();
    expect(status(slackId)).toHaveTextContent("Signing in");

    backend.completeOAuthCallback(slackId);
    const grants = await flow().findByRole("group", { name: "Allowed reads" });
    expect(posts().at(-1)).toBe("load-tools");
    expect(config(slackId)).toMatchObject({ enabled: false, allowedTools: [] });
    for (const box of within(grants).getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(flow().getByRole("button", { name: "Allow for reviews" })).toBeDisabled();
    await user.click(within(grants).getAllByRole("checkbox")[0]!);
    await user.click(flow().getByRole("button", { name: "Allow for reviews" }));
    await waitFor(() => expect(config(slackId).enabled).toBe(true));
    expect(config(slackId).allowedTools).toEqual(["slack_search_public"]);
    expect(await flow().findByRole("button", { name: "Change review access" })).toBeVisible();
    expect(status(slackId)).toHaveTextContent("Connected (synthetic)");
    expect(status(slackId)).toHaveTextContent("review access on (1 read)");
    expect(posts().filter((p) => p === "oauth/connect")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("TYPED_SECRET_CANARY");
    await user.click(flow().getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Linear registration consent and extra-capability approval explicit, and closing never approves", async () => {
    const user = mount({ harness: "saved", oauth: "metadata", oauthProvider: "linear" }, record);
    await screen.findByTestId(`connection-${linearId}`);
    await user.click(card(linearId).getByRole("button", { name: "Connect" }));
    const register = await flow().findByRole("button", { name: "Register and continue" });
    expect(register).toBeDisabled();
    expect(flow().getByTestId("sign-in-plan")).toHaveTextContent(/Linear MCP sign-in opens/);
    expect(posts()).toEqual(["import-oauth", "oauth/discover"]);
    await user.type(flow().getByLabelText(/To approve, type/), "Register a new MCP OAuth client");
    await user.click(register);
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(backend.oauthRegisterBodies).toEqual([
      {
        consent: "Register a new MCP OAuth client",
        clientAuthMethod: "none",
        scopes: ["read"],
        discoveryDigest: backend.oauthStates[linearId]!.discovery!.digest,
        redirectUri: OAUTH_REDIRECT_URI,
      },
    ]);

    backend.completeOAuthCallback(linearId, "success", "read write");
    const disclosure = await screen.findByTestId(`oauth-scopes-${linearId}`);
    expect(flow().getByRole("checkbox", { name: /I accept exactly the 1/ })).not.toBeChecked();
    expect(flow().getByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeDisabled();
    expect(disclosure).toHaveTextContent("write");
    await user.click(flow().getByRole("button", { name: "Close" }));
    expect(status(linearId)).toHaveTextContent("Needs your approval");
    expect(card(linearId).getByTestId(`problem-${linearId}`)).toHaveTextContent(
      /extra permissions/,
    );
    expect(backend.oauthApprovalBodies).toEqual([]);
    expect(backend.oauthStatus(linearId).authenticated).toBe(false);

    await user.click(card(linearId).getByRole("button", { name: "Review" }));
    await user.click(await flow().findByRole("checkbox", { name: /I accept exactly the 1/ }));
    await user.click(flow().getByRole("button", { name: OAUTH_SCOPE_CONSENT }));
    await flow().findByRole("group", { name: "Allowed reads" });
    expect(backend.oauthApprovalBodies).toHaveLength(1);
    expect(posts().filter((p) => p === "oauth/connect")).toHaveLength(1);
    expect(config(linearId)).toMatchObject({ enabled: false, allowedTools: [] });
  });

  it("discards a disclosure that returns after Close and runs no later step after a mode switch", async () => {
    let release!: () => void;
    gates["/oauth/scope-preview"] = new Promise((resolve) => (release = resolve));
    const user = mount({ harness: "saved", oauth: "metadata", oauthProvider: "linear" }, record);
    await screen.findByTestId(`connection-${linearId}`);
    await user.click(card(linearId).getByRole("button", { name: "Connect" }));
    await user.type(
      await flow().findByLabelText(/To approve, type/),
      "Register a new MCP OAuth client",
    );
    await user.click(flow().getByRole("button", { name: "Register and continue" }));
    await waitFor(() => expect(opened).toHaveLength(1));
    backend.completeOAuthCallback(linearId, "success", "read write");
    await waitFor(() => expect(posts().at(-1)).toBe("oauth/scope-preview"));
    await user.click(flow().getByRole("button", { name: "Close" }));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId(`oauth-scopes-${linearId}`)).toBeNull();
    expect(status(linearId)).toHaveTextContent("Needs your approval");
    expect(backend.oauthApprovalBodies).toEqual([]);
    user.unmount();
    uninstall();
    calls.length = 0;
    opened = [];

    let imported!: () => void;
    gates["/import-oauth"] = new Promise((resolve) => (imported = resolve));
    const again = mount({ harness: "saved", oauth: "metadata" }, record);
    await screen.findByTestId(`connection-${slackId}`);
    await again.click(card(slackId).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(posts()).toEqual(["import-oauth"]));
    await again.click(mode("Dangerous"));
    expect(screen.queryByRole("dialog")).toBeNull();
    imported();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await again.click(mode("Isolated Harnesses"));
    await screen.findByTestId(`connection-${slackId}`);
    expect(posts()).toEqual(["import-oauth"]);
    expect(opened).toEqual([]);
  });

  it("stops after Close or cancel, never restarts sign-in by itself, and offers retry after an error", async () => {
    let release!: () => void;
    gates["/oauth/connect"] = new Promise((resolve) => (release = resolve));
    const user = mount({ harness: "saved", oauth: "configured" }, record);
    await screen.findByTestId(`connection-${slackId}`);
    await user.click(card(slackId).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(posts()).toEqual(["oauth/connect"]));
    await user.click(flow().getByRole("button", { name: "Close" }));
    release();
    await waitFor(() => expect(status(slackId)).toHaveTextContent("Signing in"));
    expect(opened).toEqual([]);

    await user.click(card(slackId).getByRole("button", { name: "Continue" }));
    await user.click(flow().getByRole("button", { name: "Cancel sign-in" }));
    expect(await flow().findByRole("button", { name: "Sign in to Slack MCP" })).toBeEnabled();
    expect(posts()).toEqual(["oauth/connect", "oauth/cancel"]);
    expect(opened).toEqual([]);
    user.unmount();
    uninstall();
    calls.length = 0;

    const failing = mount(
      { harness: "saved", oauth: "configured", oauthStorage: "unavailable" },
      record,
    );
    await screen.findByTestId(`connection-${slackId}`);
    expect(card(slackId).getByTestId(`problem-${slackId}`)).toHaveTextContent(/locked or failing/);
    await failing.click(card(slackId).getByRole("button", { name: "Connect" }));
    expect(await flow().findByText(/credential_store_unavailable/)).toBeInTheDocument();
    expect(flow().getByRole("button", { name: "Sign in to Slack MCP" })).toBeEnabled();
    expect(posts()).toEqual(["oauth/connect"]);
    expect(opened).toEqual([]);
  });
});

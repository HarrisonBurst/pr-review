import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoSubmissionConfirmation,
  autoSubmissionReenableConfirmation,
  automationOff,
  reviewVerdicts,
  type AutoSubmissionState,
  type PullRequestDetail,
  type Submission,
} from "../../shared/contracts";
import { App } from "./App";
import { api } from "./api/client";
import { verdictLabel } from "./lib/format";
import { installMockApi, MockBackend } from "./mock/mockApi";

let backend: MockBackend;
let uninstall: () => void;

function mount(
  options?: ConstructorParameters<typeof MockBackend>[0],
  prepare?: (backend: MockBackend) => void,
) {
  backend = new MockBackend({ reviewDelayMs: 0, ...options });
  prepare?.(backend);
  uninstall = installMockApi(backend);
  render(<App mock />);
  return userEvent.setup();
}

const policy = () => within(screen.getByRole("region", { name: "Automatic submission" }));
const draft = () => within(screen.getByRole("region", { name: "Draft review" }));
const body = () => screen.getByLabelText(/GitHub review body/);
const sourceState = () => backend.prs.find((pr) => pr.id === "pr-482")!.autoSubmission!;
const add = async (user: ReturnType<typeof userEvent.setup>, username = " Mira ") => {
  await user.type(policy().getByLabelText("PR-author GitHub username"), username);
  await user.click(policy().getByRole("button", { name: "Add" }));
};
const begin = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(draft().getByRole("button", { name: "Begin editing" }));
  await waitFor(() => expect(body()).not.toHaveAttribute("readonly"));
};
const gutter = () =>
  screen.getByRole("button", { name: "Select line 38 of src/billing/invoice.ts" });
const composer = () => within(screen.getByRole("form", { name: "Comment composer" }));

beforeEach(() => {
  window.location.hash = "#/settings";
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => uninstall());

describe("automatic submission policy", () => {
  it("defaults off and empty, independent of four automation switches and missing historical fields", async () => {
    const user = mount(undefined, (b) => {
      delete b.settings.autoSubmission;
      b.settings.automation = { ...automationOff };
    });
    await screen.findByRole("heading", { name: "Automatic submission" });
    expect(policy().getByRole("switch")).not.toBeChecked();
    expect(policy().getByText(/No authors authorized/)).toBeInTheDocument();
    expect(backend.autoSubmissionBodies).toEqual([]);
    await user.click(policy().getByRole("switch"));
    for (const flag of Object.values(backend.settings.automation)) expect(flag).toBe(false);
    expect(backend.runs["pr-482"]).toHaveLength(2);
    expect(policy().getByRole("checkbox", { name: autoSubmissionConfirmation })).not.toBeChecked();
    expect(policy().getByRole("button", { name: "Save automatic submission" })).toBeDisabled();
  });

  it("adds actionless normalized rows and rejects duplicates and invalid logins without a lookup", async () => {
    const user = mount();
    await screen.findByRole("heading", { name: "Automatic submission" });
    const lookup = vi.spyOn(globalThis, "fetch");
    await add(user);
    for (const action of reviewVerdicts)
      expect(
        policy().getByRole("checkbox", { name: `${verdictLabel[action]} for mira` }),
      ).not.toBeChecked();
    await add(user, "MIRA");
    expect(policy().getByText("mira is already in the table.")).toBeInTheDocument();
    const input = policy().getByLabelText("PR-author GitHub username");
    for (const invalid of ["@mira", "https://github.com/mira", "bad--name", "bad-", "café"]) {
      await user.clear(input);
      await add(user, invalid);
      expect(policy().getByText(/Enter a GitHub username/)).toBeInTheDocument();
    }
    expect(lookup.mock.calls).toEqual([]);
    expect(backend.settings.autoSubmission!.authors).toEqual([]);
    await user.click(policy().getByRole("button", { name: "Remove mira" }));
    expect(policy().getByText(/No authors authorized/)).toBeInTheDocument();
  });

  it.each(reviewVerdicts)(
    "previews and explicitly saves actual %s authority only",
    async (action) => {
      const user = mount();
      await screen.findByRole("heading", { name: "Automatic submission" });
      const flags = { ...backend.settings.automation };
      await add(user);
      await user.click(
        policy().getByRole("checkbox", { name: `${verdictLabel[action]} for mira` }),
      );
      await user.click(policy().getByRole("switch"));
      const preview = policy().getByLabelText("Future publication policy preview");
      expect(preview).toHaveTextContent("acme/rocket");
      expect(preview).toHaveTextContent(`mira: ${verdictLabel[action]}`);
      expect(
        policy().getByText(/Comment excludes any immutable blocking finding/),
      ).toHaveTextContent(/Approve really approves.*Request changes really requests changes/s);
      const save = policy().getByRole("button", { name: "Save automatic submission" });
      expect(save).toBeDisabled();
      await user.click(policy().getByRole("checkbox", { name: autoSubmissionConfirmation }));
      await user.click(save);
      await screen.findByText("Automatic submission policy saved; no work was queued");
      expect(backend.autoSubmissionBodies).toEqual([
        {
          repository: "acme/rocket",
          expectedVersion: 0,
          enabled: true,
          authors: [{ username: "mira", actions: [action] }],
          confirmation: autoSubmissionConfirmation,
        },
      ]);
      expect(backend.settings.automation).toEqual(flags);
      expect(backend.runs["pr-482"]).toHaveLength(2);
      expect(backend.autoCheckCalls).toBe(0);
      expect(
        policy().getByRole("checkbox", { name: autoSubmissionConfirmation }),
      ).not.toBeChecked();
      expect(save).toBeDisabled();
    },
  );

  it("requires fresh confirmation after every table change and saves Off without consent", async () => {
    const user = mount();
    await screen.findByRole("heading", { name: "Automatic submission" });
    await add(user);
    await user.click(policy().getByRole("switch"));
    const consent = policy().getByRole("checkbox", { name: autoSubmissionConfirmation });
    await user.click(consent);
    await user.click(policy().getByRole("checkbox", { name: "Approve for mira" }));
    expect(consent).not.toBeChecked();
    await user.click(policy().getByRole("switch"));
    expect(policy().queryByRole("checkbox", { name: autoSubmissionConfirmation })).toBeNull();
    await user.click(policy().getByRole("button", { name: "Save automatic submission" }));
    await screen.findByText("Automatic submission policy saved; no work was queued");
    expect(backend.autoSubmissionBodies[0]).toEqual({
      repository: "acme/rocket",
      expectedVersion: 0,
      enabled: false,
      authors: [{ username: "mira", actions: ["APPROVE"] }],
    });
  });

  it.each(["version", "repository"])(
    "retains unsaved permissions on %s conflict until deliberate reload/review",
    async (kind) => {
      const user = mount();
      await screen.findByRole("heading", { name: "Automatic submission" });
      await add(user);
      await user.click(policy().getByRole("checkbox", { name: "Request changes for mira" }));
      if (kind === "version") backend.settings.autoSubmission!.version += 1;
      else backend.updateSettings({ repository: "demo/other" });
      await user.click(policy().getByRole("button", { name: "Save automatic submission" }));
      await policy().findByText("Saved policy or repository changed.");
      expect(policy().getByRole("checkbox", { name: "Request changes for mira" })).toBeChecked();
      expect(policy().getByLabelText("Future publication policy preview")).toHaveTextContent(
        "acme/rocket",
      );
      expect(policy().getByRole("button", { name: "Save automatic submission" })).toBeDisabled();
      await user.click(policy().getByRole("button", { name: "Reload saved policy and review" }));
      await waitFor(() =>
        expect(policy().queryByRole("checkbox", { name: "Request changes for mira" })).toBeNull(),
      );
      expect(policy().getByLabelText("Future publication policy preview")).toHaveTextContent(
        kind === "repository" ? "demo/other" : "acme/rocket",
      );
      expect(policy().getByRole("switch")).not.toBeChecked();
    },
  );

  it("does not adopt a delayed Save response over a newer repository policy", async () => {
    const user = mount();
    await screen.findByRole("heading", { name: "Automatic submission" });
    await add(user);
    const response = backend.state();
    response.settings.autoSubmission = {
      repository: "acme/rocket",
      enabled: false,
      authors: [{ username: "mira", actions: [] }],
      version: 1,
      consentedAt: null,
    };
    let resolve!: (state: typeof response) => void;
    vi.spyOn(api, "updateAutoSubmission").mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await user.click(policy().getByRole("button", { name: "Save automatic submission" }));
    backend.updateSettings({ repository: "demo/new-repository" });
    await waitFor(() =>
      expect(screen.getByLabelText("Repository")).toHaveValue("demo/new-repository"),
    );
    resolve(response);
    await screen.findByText(/saved policy changed while Save was pending/);
    expect(screen.getByLabelText("Repository")).toHaveValue("demo/new-repository");
    expect(policy().getByRole("checkbox", { name: "Comment for mira" })).not.toBeChecked();
  });

  it("keeps empty setup inert with no repository permission", async () => {
    window.location.hash = "#/";
    mount({ emptySetup: true });
    await screen.findByRole("heading", { name: "Set up your review inbox" });
    expect(backend.autoSubmissionBodies).toEqual([]);
    expect(backend.autoCheckCalls).toBe(0);
  });
});

describe("source-versioned human override UI", () => {
  beforeEach(() => {
    window.location.hash = "#/pr/pr-482";
  });

  it("retains source-backed amber human evidence beside Ready while policy is off, without a mount scan", async () => {
    const user = mount({ autoSubmission: "off-hold" });
    await screen.findByLabelText(/GitHub review body/);
    const badges = screen.getAllByText("Human requested");
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge).toHaveTextContent(/^✋ Human requested$/);
      expect(badge).toHaveAttribute("data-tone", "warn");
      expect(within(badge).getByText("✋")).toHaveAttribute("aria-hidden", "true");
      expect(badge.parentElement).toHaveAttribute(
        "title",
        "demo-human: SYNTHETIC: please have a person review this before publishing.",
      );
    }
    expect(screen.queryByText("Human review requested")).toBeNull();
    expect(
      screen.getByText("SYNTHETIC: please have a person review this before publishing."),
    ).toBeInTheDocument();
    expect(screen.getByText("demo-human")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Source on GitHub ↗" })).toHaveAttribute(
      "href",
      "https://github.com/acme/rocket/pull/482#issuecomment-100",
    );
    expect(screen.getAllByText("Ready")).toHaveLength(2);
    expect(backend.autoCheckCalls).toBe(0);
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    await user.click(screen.getByRole("link", { name: "Inbox" }));
    const row = (await screen.findByText("Apply volume discounts on invoices")).closest(".pr-row")!;
    expect(row).toHaveTextContent(/Ready.*Human requested/s);
    expect(row.querySelector('[data-tone="warn"]')).toHaveTextContent(/^✋ Human requested$/);
    expect(within(row as HTMLElement).getByText("✋")).toHaveAttribute("aria-hidden", "true");
    expect(row.querySelector('[title*="demo-human"]')).toHaveAttribute(
      "title",
      "demo-human: SYNTHETIC: please have a person review this before publishing.",
    );
  });

  it("shows nonblocking unavailable detection and incomplete coverage without fabricated evidence or check controls", async () => {
    const user = mount({ autoSubmission: "unavailable", editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    expect(screen.getAllByText("Human-request detection unavailable")).toHaveLength(2);
    expect(screen.queryByText("Human requested")).toBeNull();
    expect(screen.queryByRole("link", { name: "Source on GitHub ↗" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check automatic submission now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume for later reviews" })).toBeNull();
    await user.click(screen.getByText("Same-pass observation: unavailable"));
    expect(screen.getByText("Discussion coverage: incomplete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview and submit" })).toBeEnabled();
    expect(body()).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Begin editing" })).toBeNull();
    expect(backend.editIntentBodies).toEqual([]);
    await user.type(body(), " Private edit.");
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    expect(backend.autoCheckCalls).toBe(0);
  });

  it("acknowledges one exact source version, then explicitly resumes later runs without a clear check", async () => {
    const user = mount({ autoSubmission: "human" });
    await screen.findByLabelText(/GitHub review body/);
    const original = structuredClone(sourceState());
    const runs = backend.runs["pr-482"]!.length;
    const hold = structuredClone(backend.detail("pr-482").draft!.autoSubmission!.manualHold);
    await user.click(screen.getByRole("button", { name: "Resolve this evidence" }));
    await screen.findByText(/Retained as acknowledgment history/);
    expect(backend.humanAcknowledgments).toEqual([
      {
        expectedVersion: original.version,
        evidenceId: original.evidence[0]!.id,
        source: original.evidence[0]!.source,
        action: "resolve",
      },
    ]);
    expect(sourceState().reenableRequired).toBe(true);
    expect(screen.getByRole("button", { name: "Resume for later reviews" })).toBeDisabled();
    expect(backend.autoReenableBodies).toEqual([]);
    expect(screen.queryByRole("button", { name: "Check automatic submission now" })).toBeNull();
    const consent = screen.getByRole("checkbox", { name: autoSubmissionReenableConfirmation });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    const version = sourceState().version;
    await user.click(screen.getByRole("button", { name: "Resume for later reviews" }));
    await screen.findByText(/SYNTHETIC: re-enabled only for later reviews/);
    expect(backend.autoReenableBodies).toEqual([
      { expectedVersion: version, confirmation: autoSubmissionReenableConfirmation },
    ]);
    expect(sourceState().generation).toBe(original.generation + 1);
    expect(backend.runs["pr-482"]).toHaveLength(runs);
    expect(backend.detail("pr-482").draft!.autoSubmission!.manualHold).toEqual(hold);
    expect(backend.settings.autoSubmission!.enabled).toBe(false);
  });

  it("refreshes acknowledgment conflicts, preserving history and exposing changed evidence", async () => {
    const user = mount({ autoSubmission: "human" });
    await screen.findByLabelText(/GitHub review body/);
    const next = sourceState();
    next.version += 1;
    next.evidence.push({
      ...next.evidence[0]!,
      id: "synthetic-evidence-2",
      source: { ...next.evidence[0]!.source, version: "synthetic-source-v2" },
      quote: "SYNTHETIC: a second exact human request.",
    });
    await user.click(screen.getByRole("button", { name: "Dismiss this evidence" }));
    await screen.findByText("SYNTHETIC: evidence version changed");
    expect(await screen.findByText("SYNTHETIC: a second exact human request.")).toBeInTheDocument();
    expect(sourceState().evidence.every((item) => !item.acknowledgment)).toBe(true);
    expect(backend.autoReenableBodies).toEqual([]);
  });

  it("never optimistically re-enables after a 409 and clears confirmation for the refreshed state", async () => {
    const user = mount({ autoSubmission: "human" });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(screen.getByRole("button", { name: "Dismiss this evidence" }));
    await screen.findByText(/Retained as acknowledgment history/);
    await user.click(screen.getByRole("checkbox", { name: autoSubmissionReenableConfirmation }));
    const state = sourceState();
    state.version += 1;
    state.evidence.push({
      ...state.evidence[0]!,
      id: "synthetic-new-source",
      acknowledgment: null,
      source: { ...state.evidence[0]!.source, version: "synthetic-source-v2" },
    });
    await user.click(screen.getByRole("button", { name: "Resume for later reviews" }));
    await screen.findByText("SYNTHETIC: automatic submission state changed");
    expect(sourceState().reenableRequired).toBe(true);
    expect(sourceState().generation).toBe(1);
    expect(
      screen.getByRole("checkbox", { name: autoSubmissionReenableConfirmation }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Resume for later reviews" })).toBeDisabled();
  });

  it("keeps retained evidence across a new head and shows the last observation as older-head evidence", async () => {
    mount({ autoSubmission: "human" });
    await screen.findByLabelText(/GitHub review body/);
    backend.prs.find((pr) => pr.id === "pr-482")!.headSha = "synthetic-new-head";
    backend.sync();
    await screen.findByText(/older head/);
    expect(
      screen.getByText("SYNTHETIC: please have a person review this before publishing."),
    ).toBeInTheDocument();
    expect(sourceState().reenableRequired).toBe(true);
    expect(backend.autoCheckCalls).toBe(0);
  });
});

describe("server-observed editing", () => {
  beforeEach(() => {
    window.location.hash = "#/pr/pr-482";
  });

  it.each<AutoSubmissionState["status"]>([
    "off",
    "not_authorized",
    "manual_only",
    "human_review_requested",
    "failed",
    "uncertain",
    "held",
    "submitted",
  ])("allows direct editing with no notice or edit intent for %s", async (status) => {
    const user = mount({ editIntent: "locked" }, (b) => {
      b.prs.find((pr) => pr.id === "pr-482")!.autoSubmission!.status = status;
    });
    await screen.findByLabelText(/GitHub review body/);
    const stored = structuredClone(backend.detail("pr-482").draft!);
    expect(body()).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Begin editing" })).toBeNull();
    expect(screen.queryByText(/permanent.*manual-only/)).toBeNull();
    for (const control of draft().getAllByRole("radio")) expect(control).toBeEnabled();
    expect(draft().getByRole("button", { name: "Add finding" })).toBeEnabled();
    await user.type(body(), " SYNTHETIC direct edit.");
    expect(backend.editIntentBodies).toEqual([]);
    expect(backend.detail("pr-482").draft).toEqual(stored);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    expect(backend.detail("pr-482").draft!.version).toBe(stored.version + 1);
    expect(backend.detail("pr-482").draft!.autoSubmission!.manualHold?.reason).toBe("saved_edit");
    expect(backend.editIntentBodies).toEqual([]);
    expect(screen.getByText(/Editing is recorded/)).toBeInTheDocument();
  });

  it.each(["off", "not_authorized"] as const)(
    "allows direct code-comment composition while %s without edit intent",
    async (status) => {
      const user = mount({ editIntent: "locked" }, (b) => {
        b.prs.find((pr) => pr.id === "pr-482")!.autoSubmission!.status = status;
      });
      await screen.findByLabelText(/GitHub review body/);
      await user.click(gutter());
      await user.click(
        within(screen.getByRole("region", { name: "Selected code actions" })).getByRole("button", {
          name: "Add comment",
        }),
      );
      expect(composer().getByLabelText(/^Comment/)).not.toHaveAttribute("readonly");
      expect(composer().queryByRole("button", { name: "Begin editing" })).toBeNull();
      await user.type(composer().getByLabelText(/^Comment/), "SYNTHETIC direct comment");
      await user.click(composer().getByRole("button", { name: "Add to draft" }));
      expect(await screen.findByRole("group", { name: "Finding 4" })).toHaveTextContent(
        "SYNTHETIC direct comment",
      );
      expect(backend.editIntentBodies).toEqual([]);
      expect(backend.detail("pr-482").draft!.findings).toHaveLength(3);
    },
  );

  it("does not gate an older draft just because the latest draft is eligible", async () => {
    const user = mount({ editIntent: "locked" }, (b) => {
      delete b.drafts["pr-482"]![1]!.autoSubmission;
    });
    await screen.findByLabelText(/GitHub review body/);
    await user.selectOptions(screen.getByLabelText("Review draft"), "draft-482-old");
    expect(body()).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Begin editing" })).toBeNull();
    await user.type(body(), " SYNTHETIC historical edit.");
    expect(backend.editIntentBodies).toEqual([]);
    expect(backend.drafts["pr-482"]![0]!.autoSubmission).toBeUndefined();
  });

  it("accepts an exact-version no-op when publication becomes ineligible during edit intent", async () => {
    const user = mount({ editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    const gate = backend.hold("edit-intent");
    await user.click(draft().getByRole("button", { name: "Begin editing" }));
    await gate.entered;
    sourceState().status = "off";
    gate.release();
    await waitFor(() => expect(body()).not.toHaveAttribute("readonly"));
    expect(backend.detail("pr-482").draft!.autoSubmission).toBeUndefined();
    expect(screen.queryByText(/Editing is recorded/)).toBeNull();
    expect(backend.editIntentBodies).toHaveLength(1);
  });

  it("preserves unsaved ineligible edits and version refusal across a newer saved version", async () => {
    const user = mount({ editIntent: "locked" }, (b) => {
      b.prs.find((pr) => pr.id === "pr-482")!.autoSubmission!.status = "off";
    });
    await screen.findByLabelText(/GitHub review body/);
    await user.type(body(), " SYNTHETIC preserve unsaved.");
    backend.drafts["pr-482"]![0]!.version += 1;
    backend.sync();
    await screen.findByText("Draft changed elsewhere.");
    expect(body()).toHaveAttribute("readonly");
    expect(screen.queryByText(/Begin editing to record a permanent manual-only hold/)).toBeNull();
    expect(screen.getByText(/The saved version changed. Use Load latest/)).toBeInTheDocument();
    expect((body() as HTMLTextAreaElement).value).toContain("SYNTHETIC preserve unsaved.");
    expect(backend.editIntentBodies).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Load latest, discard my edits" }));
    expect(body()).not.toHaveAttribute("readonly");
    expect(backend.editIntentBodies).toEqual([]);
  });

  it("locks every eligible draft control until successful intent, before any unsaved typing or mutation", async () => {
    const user = mount({ editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    const stored = backend.detail("pr-482").draft!;
    const gate = backend.hold("edit-intent");
    expect(body()).toHaveAttribute("readonly");
    for (const control of draft().getAllByRole("radio")) expect(control).toBeDisabled();
    expect(draft().getByRole("button", { name: "Add finding" })).toBeDisabled();
    for (const control of draft().getAllByRole("checkbox", { name: "Include" }))
      expect(control).toBeDisabled();
    for (const control of draft()
      .getAllByRole("textbox")
      .filter((control) => control !== body()))
      expect(control).toBeDisabled();
    await user.type(body(), "NO MUTATION");
    expect(body()).toHaveValue(stored.body);
    await user.click(draft().getByRole("button", { name: "Begin editing" }));
    await gate.entered;
    expect(draft().getByRole("button", { name: "Recording edit intent" })).toBeDisabled();
    await user.type(body(), "STILL LOCKED");
    expect(body()).toHaveValue(stored.body);
    expect(backend.detail("pr-482").draft!.autoSubmission).toBeUndefined();
    gate.release();
    await waitFor(() => expect(body()).not.toHaveAttribute("readonly"));
    await user.type(body(), " Unsaved typing.");
    expect(backend.editIntentBodies).toEqual([{ draftId: stored.id, version: stored.version }]);
    expect(backend.detail("pr-482").draft!.body).toBe(stored.body);
    expect(backend.detail("pr-482").draft!.autoSubmission!.manualHold?.reason).toBe("edit_intent");
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
    expect(backend.autoSubmissionBodies).toEqual([]);
  });

  it("keeps failed intent locked with an actionable retry and does not rely on focus or Save", async () => {
    const user = mount({ editIntent: "fail" });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(body());
    expect(backend.editIntentBodies).toEqual([]);
    await user.click(draft().getByRole("button", { name: "Begin editing" }));
    await screen.findByText(/Editing remains locked: SYNTHETIC: edit intent unavailable/);
    expect(body()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    backend.options.editIntent = "locked";
    await begin(user);
    expect(backend.editIntentBodies).toHaveLength(2);
  });

  it("fences successful but delayed intent against a changed draft version", async () => {
    const user = mount({ editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    let resolve!: (detail: PullRequestDetail) => void;
    const response = new Promise<PullRequestDetail>((r) => {
      resolve = r;
    });
    vi.spyOn(api, "draftEditIntent").mockReturnValueOnce(response);
    const delayed = backend.detail("pr-482");
    delayed.draft!.autoSubmission = {
      provenance: null,
      manualHold: { reason: "edit_intent", at: new Date().toISOString() },
    };
    delayed.drafts[0]!.autoSubmission = delayed.draft!.autoSubmission;
    await user.click(draft().getByRole("button", { name: "Begin editing" }));
    backend.drafts["pr-482"]![0]!.version += 1;
    backend.sync();
    await waitFor(() => expect(screen.getByLabelText("Review draft")).toHaveDisplayValue(/v4/));
    resolve(delayed);
    await screen.findByText(/Draft changed or edit intent was not confirmed/);
    expect(body()).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Review draft")).toHaveDisplayValue(/v4/);
  });

  it.each(["draft", "navigation"])("fences delayed intent across %s changes", async (change) => {
    const user = mount({ editIntent: "locked" }, (b) => {
      delete b.drafts["pr-482"]![1]!.autoSubmission;
    });
    await screen.findByLabelText(/GitHub review body/);
    const gate = backend.hold("edit-intent");
    await user.click(draft().getByRole("button", { name: "Begin editing" }));
    await gate.entered;
    if (change === "draft")
      await user.selectOptions(screen.getByLabelText("Review draft"), "draft-482-old");
    else {
      window.location.hash = "#/pr/pr-475";
      await screen.findByRole("heading", { name: /Migrate sessions/ });
    }
    gate.release();
    await waitFor(() =>
      expect(backend.detail("pr-482").draft!.autoSubmission?.manualHold).not.toBeNull(),
    );
    expect(body()).not.toHaveAttribute("readonly");
    expect(screen.queryByText(/Editing is recorded/)).toBeNull();
    expect(backend.editIntentBodies).toHaveLength(1);
    expect(screen.getByLabelText("Review draft")).toHaveValue(
      change === "draft" ? "draft-482-old" : "draft-475",
    );
  });

  it("keeps pending intent on the exact selected draft when a new run arrives", async () => {
    const user = mount({ editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    const current = backend.drafts["pr-482"]![0]!;
    const gate = backend.hold("edit-intent");
    await user.click(draft().getByRole("button", { name: "Begin editing" }));
    await gate.entered;
    backend.drafts["pr-482"]!.unshift({
      ...structuredClone(current),
      id: "synthetic-later-draft",
      version: 1,
      body: "SYNTHETIC: later draft",
    });
    backend.sync();
    await screen.findByText("A newer review draft is available.");
    expect(screen.getByLabelText("Review draft")).toHaveValue(current.id);
    expect(body()).toHaveAttribute("readonly");
    gate.release();
    await waitFor(() => expect(body()).not.toHaveAttribute("readonly"));
    await user.type(body(), " Edit original only.");
    expect(screen.getByLabelText("Review draft")).toHaveValue(current.id);
    expect(backend.editIntentBodies).toEqual([{ draftId: current.id, version: current.version }]);
    expect(backend.drafts["pr-482"]![0]!.autoSubmission?.manualHold).toBeUndefined();
  });

  it("covers body, actual verdict and every included/severity/finding editor consumer behind one recorded intent", async () => {
    const user = mount({ editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    await begin(user);
    await user.type(body(), " Manual body.");
    await user.click(draft().getByRole("radio", { name: "Approve" }));
    const finding = within(screen.getByRole("group", { name: "Finding 1" }));
    await user.click(finding.getByRole("checkbox", { name: "Include" }));
    await user.click(finding.getByRole("radio", { name: "Non-blocking" }));
    await user.selectOptions(
      finding.getByRole("combobox", { name: "Origin for finding 1" }),
      "pre_existing",
    );
    await user.clear(finding.getByLabelText("Path"));
    await user.type(finding.getByLabelText("Path"), "src/manual.ts");
    await user.clear(finding.getByLabelText("Line"));
    await user.type(finding.getByLabelText("Line"), "50");
    await user.type(finding.getByLabelText("From"), "49");
    await user.selectOptions(finding.getByLabelText("Side"), "LEFT");
    await user.type(finding.getByLabelText("Comment"), " Manually revised.");
    await user.click(draft().getByRole("button", { name: "Add finding" }));
    await user.click(draft().getByRole("button", { name: "Remove finding 4" }));
    expect(backend.editIntentBodies).toHaveLength(1);
    expect(backend.detail("pr-482").draft!.verdict).toBe("REQUEST_CHANGES");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("All changes saved");
    const saved = backend.detail("pr-482").draft!;
    expect(saved.verdict).toBe("APPROVE");
    expect(saved.findings[0]).toMatchObject({
      included: false,
      severity: "non_blocking",
      origin: "pre_existing",
      path: "src/manual.ts",
      line: 50,
      startLine: 49,
      side: "LEFT",
    });
    expect(body()).not.toHaveAttribute("readonly");
    await user.type(body(), " Second edit.");
    expect(screen.getByText("Unsaved edits")).toBeInTheDocument();
  });

  it.each(["manual", "Ask AI"])(
    "locks the %s code-comment composer before typing or adding to an existing draft",
    async (kind) => {
      const user = mount({ editIntent: "locked" });
      await screen.findByLabelText(/GitHub review body/);
      await user.click(gutter());
      const panel = within(screen.getByRole("region", { name: "Selected code actions" }));
      if (kind === "Ask AI") {
        await user.click(panel.getByRole("button", { name: "Draft comment" }));
        await user.click(await panel.findByRole("button", { name: "Edit and add to draft" }));
      } else await user.click(panel.getByRole("button", { name: "Add comment" }));
      const input = composer().getByLabelText(/^Comment/);
      const initial = (input as HTMLTextAreaElement).value;
      expect(input).toHaveAttribute("readonly");
      expect(composer().getByLabelText("Attach to")).toBeDisabled();
      expect(composer().getByRole("radio", { name: "Blocking" })).toBeDisabled();
      expect(composer().getByRole("button", { name: "Add to draft" })).toBeDisabled();
      await user.type(input, "LOCKED");
      expect(input).toHaveValue(initial);
      const gate = backend.hold("edit-intent");
      await user.click(composer().getByRole("button", { name: "Begin editing" }));
      await gate.entered;
      expect(input).toHaveAttribute("readonly");
      gate.release();
      await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
      await user.type(input, " Manual addition.");
      await user.click(composer().getByRole("button", { name: "Add to draft" }));
      expect(await screen.findByRole("group", { name: "Finding 4" })).toHaveTextContent(
        kind === "Ask AI" ? "Suggested by Ask AI" : "Comment",
      );
      expect(backend.editIntentBodies).toHaveLength(1);
      expect(backend.detail("pr-482").draft!.findings).toHaveLength(3);
    },
  );

  it("preserves unsaved typing and the selected draft when SSE delivers a new run or a newer saved version", async () => {
    const user = mount({ editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    await begin(user);
    await user.type(body(), " Keep unsaved.");
    const current = backend.drafts["pr-482"]![0]!;
    backend.drafts["pr-482"]!.unshift({
      ...structuredClone(current),
      id: "synthetic-new-draft",
      version: 1,
      body: "SYNTHETIC: new review body",
      autoSubmission: { provenance: null, manualHold: null },
    });
    backend.sync();
    await screen.findByText("A newer review draft is available.");
    expect(screen.getByLabelText("Review draft")).toHaveValue(current.id);
    expect((body() as HTMLTextAreaElement).value).toContain("Keep unsaved.");
    current.version += 1;
    current.body = "SYNTHETIC: remote saved body";
    backend.sync();
    await screen.findByText("Draft changed elsewhere.");
    expect((body() as HTMLTextAreaElement).value).toContain("Keep unsaved.");
    expect(body()).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Load latest, discard my edits" }));
    expect(body()).toHaveValue("SYNTHETIC: remote saved body");
    expect(screen.getByLabelText("Review draft")).toHaveValue(current.id);
  });

  const automaticAttempt = (b: MockBackend, status: Submission["status"]) => {
    const current = b.detail("pr-482").draft!;
    const preview = b.preview("pr-482", current.id, current.version);
    const submission: Submission = {
      id: "synthetic-automatic-submission",
      previewId: preview.id,
      status,
      payload: structuredClone(preview.payload),
      githubReviewId: status === "submitted" ? "synthetic-review-id" : null,
      url: null,
      error: null,
      createdAt: new Date().toISOString(),
      authority: {
        kind: "automatic",
        repository: "acme/rocket",
        policyVersion: 0,
        prGeneration: 0,
        runId: current.runId!,
        draftId: current.id,
        draftVersion: current.version,
        headSha: current.headSha,
        discussionRevision: "synthetic-discussion",
      },
    };
    b.submissions["pr-482"] = [submission];
    b.prs.find((pr) => pr.id === "pr-482")!.autoSubmission!.status =
      status === "submitting" ? "held" : status;
    if (status === "submitted") b.prs.find((pr) => pr.id === "pr-482")!.status = "submitted";
  };

  it("keeps confirmed submitted drafts editable, preserves their exact old submission and previews only the saved new version", async () => {
    const user = mount({ editIntent: "locked" }, (b) => automaticAttempt(b, "submitted"));
    await screen.findByLabelText(/GitHub review body/);
    const previous = structuredClone(backend.submissions["pr-482"]![0]!);
    expect(body()).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Begin editing" })).toBeNull();
    expect(backend.editIntentBodies).toEqual([]);
    await user.type(body(), " SYNTHETIC edit after submission.");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved");
    expect(backend.detail("pr-482").draft!.version).toBe(4);
    expect(backend.submissions["pr-482"]![0]).toEqual(previous);
    cleanup();
    backend.restart();
    render(<App mock />);
    await screen.findByLabelText(/GitHub review body/);
    expect(body()).not.toHaveAttribute("readonly");
    expect((body() as HTMLTextAreaElement).value).toContain("SYNTHETIC edit after submission.");
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = within(await screen.findByRole("dialog"));
    const payload = await dialog.findByTestId("payload-body");
    expect(JSON.parse(payload.textContent!).body).toContain("SYNTHETIC edit after submission.");
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(backend.submissions["pr-482"]).toEqual([previous]);
    expect(screen.getByText(/Detection uses the same review pass/)).toBeInTheDocument();
  });

  it.each(["submitting", "uncertain"] as const)(
    "cannot acknowledge editable authority for an automatic %s version",
    async (status) => {
      const user = mount({ editIntent: "locked" }, (b) => automaticAttempt(b, status));
      await screen.findByLabelText(/GitHub review body/);
      await user.click(draft().getByRole("button", { name: "Begin editing" }));
      await screen.findByText(
        /Editing remains locked: SYNTHETIC: publication is in flight or uncertain/,
      );
      expect(body()).toHaveAttribute("readonly");
      expect(backend.submissions["pr-482"]![0]!.status).toBe(status);
      expect(backend.detail("pr-482").draft?.autoSubmission?.manualHold).toBeUndefined();
    },
  );

  it.each(["submitting", "uncertain"] as const)(
    "does not bypass an exact %s write even with an existing hold and off status",
    async (status) => {
      const user = mount({ editIntent: "locked" }, (b) => {
        automaticAttempt(b, status);
        b.prs.find((pr) => pr.id === "pr-482")!.autoSubmission!.status = "off";
        b.drafts["pr-482"]![0]!.autoSubmission = {
          provenance: null,
          manualHold: { reason: "edit_intent", at: "2026-01-01T00:00:00Z" },
        };
      });
      await screen.findByLabelText(/GitHub review body/);
      const hold = structuredClone(backend.detail("pr-482").draft!.autoSubmission!.manualHold);
      expect(body()).toHaveAttribute("readonly");
      await user.click(draft().getByRole("button", { name: "Begin editing" }));
      await screen.findByText(
        /Editing remains locked: SYNTHETIC: publication is in flight or uncertain/,
      );
      expect(body()).toHaveAttribute("readonly");
      expect(backend.detail("pr-482").draft!.autoSubmission!.manualHold).toEqual(hold);
      expect(backend.editIntentBodies).toHaveLength(1);
    },
  );

  it("keeps a successful intent permanent after discard and remount, while exact manual preview stays unchanged", async () => {
    const user = mount({ editIntent: "locked" });
    await screen.findByLabelText(/GitHub review body/);
    const expected = backend.preview("pr-482", "draft-482", 3).payload;
    await begin(user);
    sourceState().status = "off";
    backend.sync();
    await screen.findByText(/Editing is recorded/);
    await user.type(body(), " Discard me.");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(screen.getAllByRole("button", { name: "Discard" }).at(-1)!);
    cleanup();
    backend.restart();
    render(<App mock />);
    await screen.findByLabelText(/GitHub review body/);
    expect(body()).not.toHaveAttribute("readonly");
    expect(backend.editIntentBodies).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Preview and submit" }));
    const dialog = within(await screen.findByRole("dialog"));
    const payload = await dialog.findByTestId("payload-body");
    expect(JSON.parse(payload.textContent!)).toEqual(expected);
    expect(backend.submissions["pr-482"] ?? []).toEqual([]);
  });

  it.each(["eligible", "off"] as const)(
    "accepts a revision with additive holds while %s",
    async (status) => {
      const user = mount({ editIntent: "locked" }, (b) => {
        b.prs.find((pr) => pr.id === "pr-482")!.autoSubmission!.status = status;
      });
      await screen.findByLabelText(/GitHub review body/);
      await user.type(screen.getByLabelText("Ask AI to revise"), "SYNTHETIC: soften wording");
      await user.click(screen.getByRole("button", { name: "Request revision" }));
      await screen.findByRole("button", { name: "Accept into draft" });
      expect(backend.editIntentBodies).toEqual([]);
      const apply = vi.spyOn(backend, "applyProposal");
      const gate = status === "eligible" ? backend.hold("edit-intent") : null;
      await user.click(screen.getByRole("button", { name: "Accept into draft" }));
      if (gate) {
        await gate.entered;
        expect(apply).not.toHaveBeenCalled();
        expect(body()).toHaveAttribute("readonly");
        gate.release();
      }
      await screen.findByText("Proposal accepted into draft");
      expect(apply).toHaveBeenCalledOnce();
      expect(backend.editIntentBodies).toEqual(
        status === "eligible" ? [{ draftId: "draft-482", version: 3 }] : [],
      );
      expect(backend.detail("pr-482").draft!.autoSubmission!.manualHold?.reason).toBe(
        status === "eligible" ? "edit_intent" : "revision",
      );
    },
  );

  it("handles a version conflict without granting editing or overwriting unsaved state", async () => {
    const user = mount({ editIntent: "stale" });
    await screen.findByLabelText(/GitHub review body/);
    await user.click(draft().getByRole("button", { name: "Begin editing" }));
    await screen.findByText(/Editing remains locked: SYNTHETIC: draft version changed/);
    expect(body()).toHaveAttribute("readonly");
    expect(draft().getByRole("button", { name: "Begin editing" })).toBeEnabled();
  });
});

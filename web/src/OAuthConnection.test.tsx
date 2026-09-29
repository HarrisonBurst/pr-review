import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpOAuthScopePreview, McpOAuthStatus } from "../../shared/contracts";
import { api } from "./api/client";
import { OAuthDiagnostics, OAuthPanel, type OAuthRun } from "./components/OAuthConnection";
import { OAuthScopeReview, scopeConsent } from "./components/OAuthScopes";
import { MockBackend } from "./mock/mockApi";
import { slackOAuthProfile } from "./mock/fixtures";

describe("OAuthPanel with a status that omits the optional callback fields", () => {
  it("treats the selected callback as the app callback and still offers the explicit choice", () => {
    const backend = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "discovered" });
    const connection = backend.integrations.connections.find((c) => c.oauth)!;
    delete connection.oauth!.appRedirectUri;
    delete connection.oauth!.callbackMode;
    render(
      <>
        <OAuthPanel
          connection={connection}
          profile={slackOAuthProfile}
          busy={null}
          run={async (_key, action) => action()}
          refresh={async () => {}}
        />
        <OAuthDiagnostics connection={connection} profile={slackOAuthProfile} />
      </>,
    );
    const id = connection.definition.id;
    const declared = screen.getByTestId(`oauth-declared-${id}`);
    const field = (term: string) =>
      within(declared).getByText(term, { selector: "dt" }).nextElementSibling?.textContent;
    expect(field("This app's callback")).toBe("http://127.0.0.1:4317/api/mcp/oauth/callback");
    expect(field("Selected callback")).toBe(
      "http://127.0.0.1:4317/api/mcp/oauth/callback (app callback)",
    );
    const chooser = within(screen.getByTestId(`oauth-callback-${id}`));
    expect(chooser.getByRole("radio", { name: /App callback/ })).toBeChecked();
    expect(chooser.getByRole("radio", { name: /Fixed loopback callback/ })).not.toBeChecked();
    expect(chooser.queryByLabelText("Fixed loopback redirect URL")).toBeNull();
    expect(backend.oauthActions).toEqual([]);
  });
});

describe("OAuthScopeReview transient disclosure guards", () => {
  const preview = (overrides: Partial<McpOAuthScopePreview> = {}): McpOAuthScopePreview => ({
    id: "mock-preview-1",
    connectionId: "conn-1",
    generation: "gen-1",
    clientId: "mock-client",
    issuer: "https://mcp.slack.com",
    resource: "https://mcp.slack.com",
    redirectUri: "http://127.0.0.1:4317/api/mcp/oauth/callback",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    source: "provider",
    status: "approval_required",
    requestedScopes: ["search:read.public"],
    grantedScopes: ["search:read.public", "mock:extra.canary"],
    missingScopes: [],
    additionalScopes: ["mock:extra.canary"],
    ...overrides,
  });
  const status = (generation = "gen-1"): McpOAuthStatus => ({
    profileId: "slack-mcp/1",
    configured: true,
    authenticated: false,
    evidence: "synthetic_transport",
    storage: "synthetic",
    state: "authorizing",
    message: "",
    redirectUri: "http://127.0.0.1:4317/api/mcp/oauth/callback",
    scopes: ["search:read.public"],
    generation,
    identity: null,
    remoteRevocation: "not_attempted",
    scopeReview: {
      status: "approval_required",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const calls: string[] = [];
  const run: OAuthRun = async (key, action) => {
    calls.push(key);
    return action();
  };
  const mountReview = (oauth: McpOAuthStatus) =>
    render(
      <OAuthScopeReview
        id="conn-1"
        oauth={oauth}
        busy={null}
        run={run}
        refresh={async () => {}}
        cancel={async () => {}}
      />,
    );

  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches nothing on mount or status change and renders identifiers as escaped plain text", async () => {
    const spy = vi
      .spyOn(api, "previewOAuthScopes")
      .mockResolvedValue(
        preview({ additionalScopes: ["<b>mock:html</b>", "[link](https://x)"], grantedScopes: [] }),
      );
    const view = mountReview(status());
    view.rerender(
      <OAuthScopeReview
        id="conn-1"
        oauth={{ ...status(), message: "changed" }}
        busy={null}
        run={run}
        refresh={async () => {}}
        cancel={async () => {}}
      />,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    await userEvent.click(
      screen.getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    const additional = await screen.findByLabelText("Additional");
    expect(
      within(additional)
        .getAllByRole("listitem")
        .map((i) => i.textContent),
    ).toEqual(["<b>mock:html</b>", "[link](https://x)"]);
    expect(additional.querySelector("b")).toBeNull();
    expect(additional.querySelector("a")).toBeNull();
    expect(calls).toEqual(["conn-1:oauth:scope-preview"]);
  });

  it("ignores a delayed response after the generation changed and discards a stale generation response", async () => {
    let resolve!: (value: McpOAuthScopePreview) => void;
    vi.spyOn(api, "previewOAuthScopes").mockImplementation(
      () => new Promise<McpOAuthScopePreview>((r) => (resolve = r)),
    );
    const view = mountReview(status());
    await userEvent.click(
      screen.getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    view.rerender(
      <OAuthScopeReview
        id="conn-1"
        oauth={status("gen-2")}
        busy={null}
        run={run}
        refresh={async () => {}}
        cancel={async () => {}}
      />,
    );
    resolve(preview());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("oauth-scopes-conn-1")).toBeNull();
    expect(document.body.textContent).not.toContain("mock:extra");

    vi.spyOn(api, "previewOAuthScopes").mockResolvedValue(preview({ generation: "gen-1" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    expect(
      await screen.findByText(/no longer matches this connection's current generation/),
    ).toBeVisible();
    expect(screen.queryByTestId("oauth-scopes-conn-1")).toBeNull();
    expect(document.body.textContent).not.toContain("mock:extra");
  });

  it("clears an open disclosure and unchecked consent when it expires, without accepting", async () => {
    const accept = vi.spyOn(api, "acceptOAuthScopes");
    vi.spyOn(api, "previewOAuthScopes").mockResolvedValue(
      preview({ expiresAt: new Date(Date.now() + 300).toISOString() }),
    );
    mountReview(status());
    await userEvent.click(
      screen.getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    await screen.findByTestId("oauth-scopes-conn-1");
    await userEvent.click(screen.getByRole("checkbox", { name: /I accept exactly/ }));
    expect(screen.getByRole("button", { name: scopeConsent })).toBeEnabled();
    expect(await screen.findByText(/disclosure expired and was discarded locally/)).toBeVisible();
    expect(screen.getByText(/disclosure expired/)).toHaveTextContent(
      /This expiry itself accepted, revoked or refreshed nothing: a still-pending additional capability can no longer be accepted, while an exact, assumed or already explicitly accepted set keeps whatever status Refresh status shows/,
    );
    expect(screen.queryByText(/Nothing was accepted/)).toBeNull();
    expect(screen.queryByTestId("oauth-scopes-conn-1")).toBeNull();
    expect(accept).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("mock:extra");
    vi.spyOn(api, "previewOAuthScopes").mockResolvedValue(
      preview({ expiresAt: new Date(Date.now() - 1).toISOString() }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    await screen.findByText(/disclosure expired and was discarded locally/);
    expect(screen.queryByTestId("oauth-scopes-conn-1")).toBeNull();
  });

  it("keeps an already accepted status truthful when a redeemed return no longer matches the disclosure", async () => {
    const previewSpy = vi.spyOn(api, "previewOAuthScopes");
    const accept = vi.spyOn(api, "acceptOAuthScopes");
    const accepted: McpOAuthStatus = {
      ...status(),
      authenticated: true,
      state: "authenticated",
      scopeReview: { status: "accepted", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
    const consumed = vi.fn();
    render(
      <OAuthScopeReview
        id="conn-1"
        oauth={accepted}
        busy={null}
        run={run}
        refresh={async () => {}}
        cancel={async () => {}}
        reviewReturn={{
          kind: "ready",
          connectionId: "conn-1",
          generation: "gen-0",
          status: "accepted",
          expiresAt: accepted.scopeReview!.expiresAt,
        }}
        onReviewReturnConsumed={consumed}
      />,
    );
    const notice = await screen.findByText(
      /browser return no longer matches an available disclosure/,
    );
    expect(notice).toHaveTextContent(
      /does not establish whether the earlier callback already authenticated an exact or assumed requested set or whether additional capabilities were already explicitly accepted/,
    );
    expect(screen.queryByText(/Nothing was accepted/)).toBeNull();
    expect(screen.queryByText(/stay unaccepted/)).toBeNull();
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(previewSpy).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(screen.queryByTestId("oauth-scopes-conn-1")).toBeNull();
    expect(document.body.textContent).not.toContain("mock:extra");
  });

  it("sends exactly one acceptance for a double click and never retries a failed one", async () => {
    vi.spyOn(api, "previewOAuthScopes").mockResolvedValue(preview());
    const accept = vi
      .spyOn(api, "acceptOAuthScopes")
      .mockImplementation(() => new Promise((r) => setTimeout(() => r(status()), 30)));
    mountReview(status());
    await userEvent.click(
      screen.getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    await screen.findByTestId("oauth-scopes-conn-1");
    await userEvent.click(screen.getByRole("checkbox", { name: /I accept exactly/ }));
    const button = screen.getByRole("button", { name: scopeConsent });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId("oauth-scopes-conn-1")).toBeNull());
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]![1]).toEqual({
      previewId: "mock-preview-1",
      generation: "gen-1",
      additionalScopes: ["mock:extra.canary"],
      consent: scopeConsent,
    });
    expect(calls.filter((c) => c.endsWith("accept-scopes"))).toHaveLength(1);
  });

  it("never fetches names and offers no acceptance when no review indicator exists, and drops the preview on unmount", async () => {
    const spy = vi.spyOn(api, "previewOAuthScopes").mockResolvedValue(preview());
    const bare = { ...status() };
    delete bare.scopeReview;
    const view = mountReview(bare);
    expect(screen.queryByRole("button", { name: "Review returned OAuth capabilities" })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    view.unmount();
    mountReview(status());
    await userEvent.click(
      screen.getByRole("button", { name: "Review returned OAuth capabilities" }),
    );
    await screen.findByTestId("oauth-scopes-conn-1");
    cleanup();
    mountReview(status());
    expect(screen.queryByTestId("oauth-scopes-conn-1")).toBeNull();
    expect(document.body.textContent).not.toContain("mock:extra");
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { installMockApi, MockBackend, OAUTH_SCOPE_CONSENT } from "./mock/mockApi";

const id = "native:claude-axiom-mock-identity";
let backend: MockBackend;
let uninstall: () => void;
const card = () => within(screen.getByTestId(`connection-${id}`));
const flow = () => within(screen.getByRole("dialog"));
const config = () => backend.integrationConfigs.find((c) => c.id === id)!;
function mount(oauth: "metadata" | "configured" | "authenticated" = "metadata") {
  backend = new MockBackend({ harness: "saved", oauth, oauthProvider: "axiom" });
  uninstall = installMockApi(backend);
  render(<App mock />);
  return userEvent.setup();
}
beforeEach(() => {
  window.location.hash = "#/settings";
  vi.spyOn(window, "open").mockImplementation(() => null);
});
afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
});

it("guides Axiom public registration and separate unchecked reads without asking for an Axiom token", async () => {
  const user = mount();
  await screen.findByTestId(`connection-${id}`);
  await user.click(card().getByRole("button", { name: "Connect" }));
  const register = await flow().findByRole("button", { name: "Register and continue" });
  expect(register).toBeDisabled();
  expect(flow().getByText(/OAuth can carry your account's write permissions/)).toBeVisible();
  expect(flow().getByText(/results route through US infrastructure/)).toBeVisible();
  expect(flow().queryByLabelText("Client secret")).toBeNull();
  expect(backend.oauthRegisterBodies).toEqual([]);
  await user.type(flow().getByLabelText(/To approve, type/), "Register a new MCP OAuth client");
  await user.click(register);
  await waitFor(() => expect(window.open).toHaveBeenCalledTimes(1));
  expect(backend.oauthRegisterBodies[0]).toMatchObject({
    clientAuthMethod: "none",
    scopes: ["openid", "offline_access"],
  });
  backend.completeOAuthCallback(id);
  const grants = await flow().findByRole("group", { name: "Allowed reads" });
  expect(within(grants).getAllByRole("checkbox")).toHaveLength(3);
  for (const box of within(grants).getAllByRole("checkbox")) expect(box).not.toBeChecked();
  expect(config()).toMatchObject({ enabled: false, allowedTools: [] });
  expect(flow().getByRole("button", { name: "Allow for reviews" })).toBeDisabled();
  await user.click(within(grants).getAllByRole("checkbox")[0]!);
  await user.click(flow().getByRole("button", { name: "Allow for reviews" }));
  await waitFor(() =>
    expect(config()).toMatchObject({ enabled: true, allowedTools: ["listDatasets"] }),
  );
  await user.click(flow().getByRole("button", { name: "Done" }));
  expect(screen.getByTestId(`status-${id}`)).toHaveTextContent("Connected (synthetic)");
  expect(screen.getByTestId(`status-${id}`)).toHaveTextContent("review access on (1 read)");
  await user.click(card().getByText("Advanced"));
  expect(card().getByText("Sign-in and renewal scopes (not read-only permissions)")).toBeVisible();
  await user.click(card().getByRole("button", { name: "Test connection..." }));
  expect(flow().getByText(/one listDatasets request with no arguments/)).toBeVisible();
  expect(flow().queryByText(/pr-review connection test/)).toBeNull();
  await user.click(flow().getByRole("button", { name: "Run test" }));
  expect(await card().findByText("Synthetic transport, not a live read")).toBeVisible();
});

it("Axiom extras require exact local acceptance and cancelling never authorizes reads", async () => {
  const user = mount("configured");
  await screen.findByTestId(`connection-${id}`);
  await user.click(card().getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(window.open).toHaveBeenCalledTimes(1));
  backend.completeOAuthCallback(id, "success", "openid offline_access profile");
  const consent = await flow().findByRole("checkbox", { name: /I accept exactly the 1/ });
  expect(consent).not.toBeChecked();
  expect(flow().getByRole("button", { name: OAUTH_SCOPE_CONSENT })).toBeDisabled();
  await user.click(flow().getByRole("button", { name: "Close" }));
  expect(backend.oauthApprovalBodies).toEqual([]);
  expect(backend.oauthStatus(id).authenticated).toBe(false);
  await user.click(card().getByRole("button", { name: "Review" }));
  await user.click(await flow().findByRole("checkbox", { name: /I accept exactly the 1/ }));
  await user.click(flow().getByRole("button", { name: OAUTH_SCOPE_CONSENT }));
  await flow().findByRole("group", { name: "Allowed reads" });
  expect(config()).toMatchObject({ enabled: false, allowedTools: [] });
  await user.click(flow().getByRole("button", { name: "Not now" }));
  expect(config()).toMatchObject({ enabled: false, allowedTools: [] });
  expect(window.open).toHaveBeenCalledTimes(1);
});

it("Axiom cancellation stops sign-in and Test without listDatasets grants no evidence", async () => {
  const user = mount("configured");
  await screen.findByTestId(`connection-${id}`);
  await user.click(card().getByRole("button", { name: "Connect" }));
  await user.click(await flow().findByRole("button", { name: "Cancel sign-in" }));
  expect(await flow().findByRole("button", { name: "Sign in to Axiom MCP" })).toBeEnabled();
  expect(backend.oauthStatus(id).authenticated).toBe(false);
  expect(config().allowedTools).toEqual([]);
  const opens = vi.mocked(window.open).mock.calls.length;
  await user.click(flow().getByRole("button", { name: "Close" }));
  expect(window.open).toHaveBeenCalledTimes(opens);
  expect(backend.testIntegration(id)).toMatchObject({
    scope: "local_configuration",
    connected: false,
  });
});

it("Axiom existing public client requires its id, never requests a token and closing saves nothing", async () => {
  const user = mount();
  await screen.findByTestId(`connection-${id}`);
  await user.click(card().getByRole("button", { name: "Connect" }));
  await user.click(await flow().findByRole("button", { name: "Use an existing client instead" }));
  expect(flow().getByRole("button", { name: "Save and continue" })).toBeDisabled();
  await user.type(flow().getByLabelText("Client id"), "synthetic-existing-client");
  expect(flow().queryByLabelText("Client secret")).toBeNull();
  await user.click(flow().getByRole("button", { name: "Close" }));
  expect(backend.oauthConfigureBodies).toEqual([]);
  expect(window.open).not.toHaveBeenCalled();
});

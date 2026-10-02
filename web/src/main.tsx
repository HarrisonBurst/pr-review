import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const mock = import.meta.env.VITE_MOCK_API === "1";
if (mock) {
  const { installMockApi, MockBackend } = await import("./mock/mockApi");
  const params = new URLSearchParams(window.location.search);
  const backend = new MockBackend({
    emptySetup: params.has("setup"),
    submitOutcome: params.get("submit") as never,
    freshness: params.get("freshness") as never,
    commits: params.has("commits")
      ? { count: Number(params.get("commits")), truncated: params.has("truncated") }
      : undefined,
    remoteHead: params.has("head") ? { "pr-482": params.get("head")! } : undefined,
    reviewRefresh: params.get("refresh") as never,
    readiness: params.get("readiness")?.split(",") as never,
    harness: params.get("harness") as never,
    setup: params.get("setup") as never,
    native: params.get("native") as never,
    inventory: params.get("inventory") as never,
    readProviders: params.get("read") as never,
    readTest: params.get("readTest") as never,
    history: params.get("history") as never,
    models: params.get("models") as never,
    oauth: params.get("oauth") as never,
    oauthProvider: params.get("oauthProvider") as never,
    oauthStorage: params.get("oauthStorage") as never,
    oauthRevocation: params.get("oauthRevocation") as never,
    oauthMethods: params.get("oauthMethods") as never,
    oauthCallback: params.get("oauthCallback") as never,
    oauthScopes: params.get("oauthScopes") as never,
    oauthReturn: params.get("oauthReturn") as never,
    exclusions: params.get("exclusions") as never,
    autoSubmission: params.get("autoSubmission") as never,
    editIntent: params.get("editIntent") as never,
  });
  installMockApi(backend);
  if (params.has("oauthReturn"))
    window.location.hash = `#/settings?oauthReview=${backend.reviewContinuation()}`;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App mock={mock} />
  </StrictMode>,
);

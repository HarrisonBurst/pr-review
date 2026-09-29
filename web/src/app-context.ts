import { createContext, useContext } from "react";
import type { AppState, McpOAuthReviewReturn } from "../../shared/contracts";
import type { StreamStatus } from "./api/events";
import type { Route } from "./lib/router";

export type OAuthReturn = { kind: "unavailable" } | ({ kind: "ready" } & McpOAuthReviewReturn);

export interface AppContextValue {
  state: AppState;
  stream: StreamStatus;
  refresh: () => Promise<void>;
  setState: (state: AppState) => void;
  navigate: (route: Route) => void;
  detailVersion: Record<string, number>;
  oauthReturn: OAuthReturn | null;
  consumeOAuthReturn: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppContext missing");
  return value;
}

import { useCallback, useEffect, useState } from "react";

export type Route = { name: "inbox" } | { name: "settings" } | { name: "pr"; id: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "/settings") return { name: "settings" };
  const pr = /^\/pr\/(.+)$/.exec(path);
  if (pr?.[1]) return { name: "pr", id: decodeURIComponent(pr[1]) };
  return { name: "inbox" };
}

export function takeOAuthReviewReturn(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const query = hash.indexOf("?");
  if (query < 0) return null;
  const params = new URLSearchParams(hash.slice(query + 1));
  const continuation = params.get("oauthReview");
  if (continuation === null) return null;
  params.delete("oauthReview");
  const rest = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `#${hash.slice(0, query)}${rest ? `?${rest}` : ""}`,
  );
  return continuation;
}

export const hrefFor = (route: Route) =>
  route.name === "pr"
    ? `#/pr/${encodeURIComponent(route.id)}`
    : route.name === "settings"
      ? "#/settings"
      : "#/";

type Guard = () => boolean;
let guard: Guard | null = null;
export const setNavigationGuard = (next: Guard | null) => {
  guard = next;
};

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    let current = window.location.hash;
    const onChange = () => {
      const next = window.location.hash;
      if (next === current) return;
      if (guard && !guard()) {
        window.location.hash = current;
        return;
      }
      current = next;
      setRoute(parseRoute(next));
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    window.location.hash = hrefFor(next);
  }, []);
  return { route, navigate };
}

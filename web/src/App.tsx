import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../../shared/contracts";
import { api, RequestError } from "./api/client";
import { useChangeStream, type ChangeEvent } from "./api/events";
import { AppContext, type OAuthReturn } from "./app-context";
import { Notice, Pill, ToastProvider, useToast } from "./components/ui";
import { staleReviewJobs } from "./lib/review-job";
import { hrefFor, takeOAuthReviewReturn, useRoute } from "./lib/router";

import { InboxView } from "./views/InboxView";
import { PrView } from "./views/PrView";
import { SettingsView } from "./views/SettingsView";
import { SetupView } from "./views/SetupView";

export function App({ mock = false }: { mock?: boolean }) {
  return (
    <ToastProvider>
      <Shell mock={mock} />
    </ToastProvider>
  );
}

function Shell({ mock }: { mock: boolean }) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState<Record<string, number>>({});
  const [continuation] = useState(takeOAuthReviewReturn);
  const [oauthReturn, setOAuthReturn] = useState<OAuthReturn | null>(null);
  const redeemed = useRef(false);
  const mounted = useRef(false);
  const { route, navigate } = useRoute();
  const onSettings = useRef(route.name === "settings");
  onSettings.current = route.name === "settings";
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setState((current) =>
        current?.prs.some((pr) => {
          const incoming = next.prs.find((item) => item.id === pr.id);
          return incoming && staleReviewJobs(pr, incoming);
        })
          ? current
          : next,
      );
      setError(null);
    } catch (e) {
      setError(
        e instanceof RequestError ? e.message : "Cannot reach the local backend on port 4317",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!continuation || redeemed.current) return;
    redeemed.current = true;
    void (async () => {
      const returned = await api.oauthReviewReturn({ continuation }).catch(() => null);
      const next = returned ? await api.state().catch(() => null) : null;
      if (!mounted.current || !onSettings.current) return;
      if (!next) {
        setOAuthReturn({ kind: "unavailable" });
        return;
      }
      setState(next);
      setError(null);
      const oauth = next.integrations.connections.find(
        (connection) => connection.definition.id === returned!.connectionId,
      )?.oauth;
      setOAuthReturn(
        oauth?.scopeReview &&
          oauth.generation === returned!.generation &&
          Date.parse(returned!.expiresAt) > Date.now()
          ? { kind: "ready", ...returned! }
          : { kind: "unavailable" },
      );
    })();
  }, [continuation]);

  useEffect(() => {
    if (route.name !== "settings") setOAuthReturn(null);
  }, [route.name]);

  const consumeOAuthReturn = useCallback(() => setOAuthReturn(null), []);

  const onChange = useCallback(
    (events: ChangeEvent[]) => {
      void refresh();
      setDetailVersion((v) => {
        const next = { ...v };
        const all = events.some((e) => !e.prId);
        if (all) next["*"] = (next["*"] ?? 0) + 1;
        for (const e of events) if (e.prId) next[e.prId] = (next[e.prId] ?? 0) + 1;
        return next;
      });
    },
    [refresh],
  );
  const stream = useChangeStream(onChange);

  useEffect(() => {
    if (stream === "reconnecting")
      toast("Lost the live connection to the backend, retrying", "warn");
  }, [stream, toast]);

  const value = useMemo(
    () =>
      state
        ? {
            state,
            stream,
            refresh,
            setState,
            navigate,
            detailVersion,
            oauthReturn,
            consumeOAuthReturn,
          }
        : null,
    [state, stream, refresh, navigate, detailVersion, oauthReturn, consumeOAuthReturn],
  );

  const currentPr = route.name === "pr" ? state?.prs.find((p) => p.id === route.id) : undefined;

  return (
    <div className="app">
      {mock && (
        <div className="mock-banner">
          Mock API (test only): deterministic fixtures, nothing reaches GitHub
        </div>
      )}
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true">
            PR
          </span>
          Review
        </a>
        {state?.settings.repository && (
          <span className="topbar-repo mono">{state.settings.repository}</span>
        )}
        <span className="spacer" />
        {state?.health.demo && !mock && (
          <Pill tone="warn" plain>
            Demo mode
          </Pill>
        )}
        <span className="stream" data-status={stream} title={`Event stream ${stream}`}>
          <span className="dot" aria-hidden="true" />
          {stream === "live" ? "Live" : stream === "reconnecting" ? "Reconnecting" : "Connecting"}
        </span>
        <nav className="row" aria-label="Primary">
          <a
            className="nav-link"
            href="#/"
            aria-current={route.name === "inbox" ? "page" : undefined}
          >
            Inbox
          </a>
          <a
            className="nav-link"
            href={hrefFor({ name: "settings" })}
            aria-current={route.name === "settings" ? "page" : undefined}
          >
            Settings
          </a>
        </nav>
      </header>
      <main>
        {!state && !error && (
          <div className="stack" aria-busy="true" aria-label="Loading">
            <div className="skeleton" style={{ width: "30%" }} />
            <div className="skeleton" style={{ width: "60%" }} />
            <div className="skeleton" style={{ width: "45%" }} />
          </div>
        )}
        {!state && error && (
          <Notice
            tone="danger"
            title="Backend unavailable."
            actions={
              <button type="button" className="button small" onClick={() => void refresh()}>
                Retry
              </button>
            }
          >
            {error}
          </Notice>
        )}
        {value && (
          <AppContext.Provider value={value}>
            {error && (
              <div style={{ marginBottom: 16 }}>
                <Notice tone="warn" title="Showing the last known state.">
                  {error}
                </Notice>
              </div>
            )}
            {route.name === "settings" ? (
              <SettingsView />
            ) : route.name === "pr" ? (
              <PrView key={route.id} id={route.id} listed={currentPr} />
            ) : !value.state.settings.repository ? (
              <SetupView />
            ) : (
              <InboxView />
            )}
          </AppContext.Provider>
        )}
      </main>
    </div>
  );
}

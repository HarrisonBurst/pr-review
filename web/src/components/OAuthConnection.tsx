import { useCallback, useEffect, useState } from "react";
import type {
  IntegrationConnection,
  McpClientAuthMethod,
  McpOAuthConnectResult,
  McpOAuthProfile,
  McpOAuthStatus,
} from "../../../shared/contracts";
import { api } from "../api/client";
import type { OAuthReturn } from "../app-context";
import { formatDate, relativeTime } from "../lib/format";
import { OAuthScopeReview } from "./OAuthScopes";
import { Modal, Notice, Pill, type Tone } from "./ui";

export const registrationConsent = "Register a new MCP OAuth client";

export type OAuthRun = <T>(
  key: string,
  action: () => Promise<T>,
  message?: string,
) => Promise<T | null>;

const stateTone: Record<McpOAuthStatus["state"], Tone> = {
  needs_discovery: "neutral",
  needs_client: "neutral",
  disconnected: "info",
  authorizing: "accent",
  authenticated: "ok",
  reconnect_required: "warn",
};

const stateLabel: Record<McpOAuthStatus["state"], string> = {
  needs_discovery: "needs discovery",
  needs_client: "needs client",
  disconnected: "disconnected",
  authorizing: "authorizing",
  authenticated: "authenticated",
  reconnect_required: "reconnect required",
};

const evidenceLabel: Record<McpOAuthStatus["evidence"], { tone: Tone; label: string }> = {
  local_configuration: {
    tone: "neutral",
    label: "local configuration, no authentication evidence",
  },
  synthetic_transport: { tone: "warn", label: "SYNTHETIC transport, not a live provider" },
  live_authentication: { tone: "info", label: "live authentication, not read readiness" },
};

export const storageLabel: Record<
  McpOAuthStatus["storage"],
  { tone: Tone; label: string; note: string }
> = {
  "macos-keychain": {
    tone: "info",
    label: "macOS Keychain",
    note: "Configured app-owned backend; not proof the Keychain is unlocked. Locked or failing storage fails each action with a retryable error.",
  },
  synthetic: {
    tone: "warn",
    label: "SYNTHETIC storage",
    note: "Fixture memory store; nothing is persisted in a real credential store.",
  },
  unsupported: {
    tone: "danger",
    label: "storage unsupported",
    note: "This host has no supported app-owned credential store (Linux is not supported; there is no plaintext or kernel-keyring fallback). Configure, Connect and refresh cannot run here.",
  },
  unavailable: {
    tone: "danger",
    label: "storage unavailable",
    note: "The credential store is locked or failing. Unlock it and retry; nothing was written elsewhere.",
  },
};

export const methodLabel: Record<McpClientAuthMethod, string> = {
  none: "none (public client)",
  client_secret_basic: "client_secret_basic (confidential)",
  client_secret_post: "client_secret_post (confidential)",
};

const revocationLabel: Record<McpOAuthStatus["remoteRevocation"], { tone: Tone; label: string }> = {
  not_attempted: { tone: "neutral", label: "remote revocation not attempted" },
  unsupported: { tone: "warn", label: "remote revocation unsupported by the server" },
  succeeded: { tone: "ok", label: "remote revocation succeeded" },
  failed: { tone: "danger", label: "remote revocation failed" },
};

export const clientIdPattern = /^[A-Za-z0-9._:-]{1,200}$/;

export const callbackLabel: Record<NonNullable<McpOAuthStatus["callbackMode"]>, string> = {
  app: "app callback",
  "fixed-loopback": "fixed loopback listener, opened only during Connect",
};

export function OAuthPanel({
  connection,
  profile,
  busy,
  run,
  refresh,
  reviewReturn = null,
  onReviewReturnConsumed,
  scopeReview = true,
}: {
  connection: IntegrationConnection;
  profile: McpOAuthProfile;
  busy: string | null;
  run: OAuthRun;
  refresh: () => Promise<void>;
  reviewReturn?: OAuthReturn | null;
  onReviewReturnConsumed?: () => void;
  scopeReview?: boolean;
}) {
  const id = connection.definition.id;
  const oauth = connection.oauth!;
  const native = connection.config.native;
  const declared = native?.oauth;
  const discovery = oauth.discovery;
  const disabled = busy !== null;
  const locked = oauth.state === "authenticated" || oauth.state === "authorizing";
  const methods = discovery
    ? discovery.clientAuthMethods.filter((method) => profile.clientAuthMethods.includes(method))
    : [];
  const scopes = discovery
    ? discovery.scopes.filter((scope) => profile.readScopes.includes(scope))
    : [];
  const appRedirect = oauth.appRedirectUri ?? oauth.redirectUri;
  const callbackMode = oauth.callbackMode ?? "app";
  const appPort = new URL(appRedirect).port;
  const [clientId, setClientId] = useState(oauth.clientId ?? "");
  const [method, setMethod] = useState<McpClientAuthMethod | "">(oauth.clientAuthMethod ?? "");
  const [callback, setCallback] = useState<"app" | "fixed">(
    callbackMode === "fixed-loopback" ? "fixed" : "app",
  );
  const [fixedUri, setFixedUri] = useState(
    callbackMode === "fixed-loopback" ? oauth.redirectUri : "",
  );
  const [secret, setSecret] = useState("");
  const [chosenScopes, setChosenScopes] = useState<string[]>(oauth.scopes);
  const [editing, setEditing] = useState(false);
  const [consent, setConsent] = useState("");
  const [confirm, setConfirm] = useState<"connect" | "register" | "disconnect" | null>(null);
  const [pending, setPending] = useState<McpOAuthConnectResult | null>(null);
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<{ tone: Tone; text: string } | null>(null);

  useEffect(() => {
    setSecret("");
    setConsent("");
  }, [oauth.generation, oauth.state, discovery?.digest, discovery?.checkedAt]);

  const closeConfirm = useCallback(() => {
    setConsent("");
    setConfirm(null);
  }, []);

  useEffect(() => {
    if (oauth.state !== "authorizing") {
      setPending(null);
      setBlockedUrl(null);
    }
  }, [oauth.state, oauth.generation]);

  const effectiveMethod = method && methods.includes(method) ? method : methods[0];
  const confidential = effectiveMethod !== undefined && effectiveMethod !== "none";
  const validScopes = chosenScopes.filter((scope) => scopes.includes(scope));
  const selectedRedirect = callback === "app" ? appRedirect : fixedUri;
  const configurable =
    Boolean(discovery) &&
    !locked &&
    effectiveMethod !== undefined &&
    clientIdPattern.test(clientId.trim()) &&
    validScopes.length > 0 &&
    selectedRedirect.length > 0 &&
    (!confidential || secret.length > 0);
  const registrable = Boolean(discovery?.dynamicRegistration && profile.dynamicRegistration);
  const showForm = Boolean(discovery) && !locked && (!oauth.configured || editing);

  const finish = (message?: string) => run(`${id}:oauth:refresh`, async () => refresh(), message);

  const discover = () =>
    run(
      `${id}:oauth:discover`,
      async () => {
        await api.discoverOAuth(id);
        await refresh();
      },
      "OAuth requirements discovered; nothing was authenticated or granted",
    );

  const configure = async () => {
    if (!discovery || effectiveMethod === undefined) return;
    const body = {
      clientId: clientId.trim(),
      clientAuthMethod: effectiveMethod,
      ...(confidential ? { clientSecret: secret } : {}),
      scopes: validScopes,
      discoveryDigest: discovery.digest,
      redirectUri: selectedRedirect,
    };
    setSecret("");
    const result = await run(
      `${id}:oauth:configure`,
      async () => {
        const status = await api.configureOAuth(id, body);
        await refresh();
        return status;
      },
      "Client configured in app-owned storage; configured is not authenticated",
    );
    if (result) setEditing(false);
  };

  const register = async () => {
    setConfirm(null);
    if (!discovery || effectiveMethod === undefined) return;
    setConsent("");
    await run(
      `${id}:oauth:register`,
      async () => {
        await api.registerOAuth(id, {
          consent: registrationConsent,
          clientAuthMethod: effectiveMethod,
          scopes: validScopes,
          discoveryDigest: discovery.digest,
          redirectUri: selectedRedirect,
        });
        await refresh();
      },
      "Client registered with the authorization server; configured is not authenticated",
    );
  };

  const connect = async () => {
    setConfirm(null);
    setBlockedUrl(null);
    const result = await run(
      `${id}:oauth:connect`,
      async () => {
        const started = await api.connectOAuth(id);
        await refresh();
        return started;
      },
      "Authorization started; complete it in the provider window, then refresh status",
    );
    if (!result) return;
    setPending(result);
    const opened = window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    if (!opened) setBlockedUrl(result.authorizationUrl);
  };

  const cancel = () =>
    run(
      `${id}:oauth:cancel`,
      async () => {
        await api.cancelOAuth(id);
        await refresh();
      },
      "Authorization cancelled locally; no remote effect",
    );

  const disconnect = async () => {
    setConfirm(null);
    setCleanup(null);
    const result = await run(`${id}:oauth:disconnect`, async () => {
      try {
        return await api.disconnectOAuth(id);
      } finally {
        await refresh();
      }
    });
    setCleanup(
      result
        ? { tone: "neutral", text: "Local authority revoked and the app-owned entry deleted." }
        : {
            tone: "warn",
            text: "Local authority was revoked, but the app-owned credential entry could not be confirmed deleted. Its reference is retained; retry Disconnect to clean up.",
          },
    );
  };

  const toggleScope = (scope: string, on: boolean) =>
    setChosenScopes(
      on ? [...new Set([...chosenScopes, scope])] : chosenScopes.filter((v) => v !== scope),
    );

  const storage = storageLabel[oauth.storage];
  const revocation = revocationLabel[oauth.remoteRevocation];
  const busyIs = (action: string) => busy === `${id}:oauth:${action}`;

  return (
    <div className="stack" style={{ gap: 8, marginBottom: 8 }} data-testid={`oauth-${id}`}>
      <div className="row wrap" aria-label="OAuth status">
        <Pill tone={stateTone[oauth.state]} live={oauth.state === "authorizing"}>
          {stateLabel[oauth.state]}
        </Pill>
        <Pill plain tone={oauth.authenticated ? "ok" : "neutral"}>
          {oauth.authenticated ? "authenticated" : "not authenticated"}
        </Pill>
        {oauth.identity && (
          <Pill plain tone="info">
            identity {oauth.identity.account} @ {oauth.identity.workspace}
          </Pill>
        )}
      </div>
      <div className="small">{oauth.message}</div>
      {storage.tone === "danger" && (
        <Notice tone="danger" title={`${storage.label}.`}>
          {storage.note}
        </Notice>
      )}
      {profile.readSupport === "unavailable" && (
        <Notice tone="warn" title="Read support unavailable for this profile.">
          {profile.message} Signing in works, but Load tools inventory and configured storage do not
          enable review reads; no tools or presets can be granted and Test reports unsupported. No
          account or workspace verification is available yet.
        </Notice>
      )}
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <button
          type="button"
          className="button small"
          disabled={disabled || locked || oauth.storage === "unsupported"}
          onClick={() => void discover()}
          data-testid={`oauth-discover-${id}`}
        >
          {busyIs("discover") ? "Discovering..." : "Discover OAuth requirements"}
        </button>
        <span className="small faint">
          {locked
            ? "Disconnect before changing discovery bindings."
            : "Bounded public protected-resource and authorization-server metadata read for the profile issuer; no authentication, registration or grant."}
        </span>
      </div>
      {showForm && discovery && (
        <div className="stack" style={{ gap: 6 }} data-testid={`oauth-form-${id}`}>
          <Notice tone="neutral" title="An eligible existing app or client.">
            Prefer an existing app you are allowed to use with issuer{" "}
            <span className="mono">{discovery.issuer}</span> whose owner confirms the exact redirect{" "}
            <span className="mono">{selectedRedirect || "chosen below"}</span> is registered for it
            (adding it if necessary), with one of the allowed client methods and only approved read
            scopes. A declared client id can be used deliberately below; the source's login, token
            or session is never read or reused, and using its id does not verify eligibility.
          </Notice>
          {!registrable && (
            <span className="small faint">
              Dynamic client registration is{" "}
              {profile.dynamicRegistration
                ? "not advertised by the server"
                : "disabled for this profile"}
              ; confirm an existing eligible app with the provider and enter its client id below.
              Create a new app only if no existing registration can support this callback.
            </span>
          )}
          {declared && clientId.trim() !== declared.clientId && (
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                className="button small ghost"
                disabled={disabled}
                onClick={() => setClientId(declared.clientId)}
                data-testid={`oauth-use-declared-${id}`}
              >
                Use declared client id
              </button>
              <span className="small faint">
                Fills only the client id field with{" "}
                <span className="mono">{declared.clientId}</span>; nothing is saved, connected or
                verified, and the method, secret and scopes stay as they are.
              </span>
            </div>
          )}
          <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field grow">
              <label htmlFor={`oauth-client-id-${id}`}>Client id</label>
              <input
                id={`oauth-client-id-${id}`}
                className="input mono"
                value={clientId}
                disabled={disabled}
                autoComplete="off"
                aria-invalid={clientId.trim() !== "" && !clientIdPattern.test(clientId.trim())}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`oauth-method-${id}`}>Client method</label>
              <select
                id={`oauth-method-${id}`}
                className="select"
                value={effectiveMethod ?? ""}
                disabled={disabled || !methods.length}
                onChange={(e) => {
                  setMethod(e.target.value as McpClientAuthMethod);
                  setSecret("");
                }}
              >
                {methods.map((m) => (
                  <option key={m} value={m}>
                    {methodLabel[m]}
                  </option>
                ))}
              </select>
            </div>
            {confidential && (
              <div className="field grow">
                <label htmlFor={`oauth-secret-${id}`}>Client secret (write-only)</label>
                <input
                  id={`oauth-secret-${id}`}
                  className="input mono"
                  type="password"
                  value={secret}
                  disabled={disabled}
                  autoComplete="new-password"
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
            )}
          </div>
          <fieldset className="stack" style={{ gap: 4 }} data-testid={`oauth-callback-${id}`}>
            <legend className="small">Callback the provider must redirect to</legend>
            <label className="check-row">
              <input
                type="radio"
                name={`oauth-callback-${id}`}
                checked={callback === "app"}
                disabled={disabled}
                onChange={() => setCallback("app")}
              />
              <span>
                App callback <span className="mono">{appRedirect}</span>
              </span>
            </label>
            <span className="small faint" style={{ paddingLeft: 22 }}>
              The provider returns straight to this app's own route on port{" "}
              <span className="mono">{appPort}</span>; this browser's cookie completes the exchange.
            </span>
            <label className="check-row">
              <input
                type="radio"
                name={`oauth-callback-${id}`}
                checked={callback === "fixed"}
                disabled={disabled}
                onChange={() => setCallback("fixed")}
              />
              <span>Fixed loopback callback registered for the client</span>
            </label>
            {callback === "fixed" && (
              <div className="stack" style={{ gap: 4, paddingLeft: 22 }}>
                <div className="field grow">
                  <label htmlFor={`oauth-fixed-callback-${id}`}>Fixed loopback redirect URL</label>
                  <input
                    id={`oauth-fixed-callback-${id}`}
                    className="input mono"
                    value={fixedUri}
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="http://localhost:PORT/path"
                    onChange={(e) => setFixedUri(e.target.value)}
                  />
                </div>
                <span className="small faint">
                  Sent exactly as typed and enforced by the backend: an http URL whose host is
                  exactly <span className="mono">localhost</span>,{" "}
                  <span className="mono">127.0.0.1</span> or <span className="mono">[::1]</span>, an
                  explicit port 1024-65535 other than the app port{" "}
                  <span className="mono">{appPort}</span>, and a plain path of at most 128
                  characters; no query, fragment, credentials, encoded or dot segments, and no host,
                  path or port substitution.{" "}
                  {declared
                    ? `The declared callback port ${declared.callbackPort} is not adopted; type the redirect the registration actually accepts.`
                    : "Type the redirect the registration actually accepts."}
                </span>
                <span className="small faint">
                  The listener opens only when you click Connect, is temporary and closes after one
                  valid response, Cancel, expiry, Disconnect or shutdown (
                  <span className="mono">localhost</span> reserves both{" "}
                  <span className="mono">127.0.0.1</span> and <span className="mono">::1</span>). An
                  occupied port fails Connect with no takeover or fallback. The provider response is
                  handed back to this original browser, whose cookie must finish the exchange;
                  nothing else is stored or persisted.
                </span>
              </div>
            )}
          </fieldset>
          <div
            className="stack"
            style={{ gap: 2 }}
            aria-label={
              profile?.id === "notion-mcp/1"
                ? "Workspace capability scopes (not read-only permissions)"
                : profile?.id === "axiom-mcp/1"
                  ? "Sign-in and renewal scopes"
                  : "Approved read scopes"
            }
          >
            {scopes.map((scope) => (
              <label className="check-row" key={scope}>
                <input
                  type="checkbox"
                  checked={validScopes.includes(scope)}
                  disabled={disabled}
                  onChange={(e) => toggleScope(scope, e.target.checked)}
                />
                <span className="mono">{scope}</span>
              </label>
            ))}
            {!scopes.length && (
              <span className="small faint">
                {profile?.id === "notion-mcp/1"
                  ? "No supported workspace capability scope is offered by this server."
                  : profile?.id === "axiom-mcp/1"
                    ? "No supported sign-in scope is offered by this server."
                    : "No approved read scope is offered by this server."}
              </span>
            )}
          </div>
          <div className="row" style={{ gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <button
              type="button"
              className="button small"
              disabled={disabled || !configurable || oauth.storage === "unsupported"}
              onClick={() => void configure()}
              data-testid={`oauth-configure-${id}`}
            >
              {busyIs("configure") ? "Saving client..." : "Save client configuration"}
            </button>
            {registrable && !oauth.configured && (
              <button
                type="button"
                className="button small ghost"
                disabled={
                  disabled ||
                  effectiveMethod === undefined ||
                  !validScopes.length ||
                  !selectedRedirect.length
                }
                onClick={() => setConfirm("register")}
              >
                Register a new client...
              </button>
            )}
            {secret && (
              <button
                type="button"
                className="button small ghost"
                disabled={disabled}
                onClick={() => setSecret("")}
              >
                Clear secret
              </button>
            )}
            <span className="small faint">
              The client id, method, scopes and the callback choice are sent with the exact
              discovery digest. A secret is sent once to app-owned storage and cleared here; it is
              never stored in this browser, echoed in status or logged. Configuring authenticates
              nothing and opens no listener.
            </span>
          </div>
        </div>
      )}
      {oauth.configured && (
        <div className="row wrap" style={{ alignItems: "flex-start" }}>
          {oauth.state !== "authorizing" && (
            <button
              type="button"
              className="button small"
              disabled={disabled || oauth.storage === "unsupported"}
              onClick={() => setConfirm("connect")}
              data-testid={`oauth-connect-${id}`}
            >
              {busyIs("connect")
                ? "Starting..."
                : oauth.state === "authenticated" || oauth.state === "reconnect_required"
                  ? "Reconnect..."
                  : "Connect..."}
            </button>
          )}
          {oauth.state === "authorizing" && (
            <button
              type="button"
              className="button small"
              disabled={disabled}
              onClick={() => void cancel()}
              data-testid={`oauth-cancel-${id}`}
            >
              {busyIs("cancel") ? "Cancelling..." : "Cancel authorization"}
            </button>
          )}
          <button
            type="button"
            className="button small ghost"
            disabled={disabled}
            onClick={() => void finish("Status refreshed from the backend catalog")}
            data-testid={`oauth-refresh-${id}`}
          >
            {busyIs("refresh") ? "Refreshing..." : "Refresh status"}
          </button>
          {!locked && discovery && (
            <button
              type="button"
              className="button small ghost"
              disabled={disabled}
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? "Keep current client" : "Replace client configuration"}
            </button>
          )}
          <span className="small faint">
            {oauth.state === "authorizing" && oauth.scopeReview
              ? "The provider response was already received for this generation. Review the returned capabilities below, or Cancel authorization to refuse locally with no remote effect; no callback is replayed and no token is refreshed."
              : oauth.state === "authorizing"
                ? `Authorization in progress${pending ? `, expires ${relativeTime(pending.expiresAt)} (${formatDate(pending.expiresAt)})` : ""}. ${
                    callbackMode === "fixed-loopback"
                      ? `Finish in the provider window; the temporary listener at ${oauth.redirectUri} hands the response back to this browser, which must complete it, then refresh here. Cancel closes the listener locally.`
                      : "Finish in the provider window; the callback returns generic text, then refresh here. Cancel fences it locally."
                  }`
                : callbackMode === "fixed-loopback"
                  ? `Connect opens a temporary listener on exactly ${oauth.redirectUri} (an occupied port fails with no takeover), then the approved authorization URL once, after your click.`
                  : "Connect opens the backend-approved authorization URL once, after your click."}
          </span>
        </div>
      )}
      {scopeReview && (
        <OAuthScopeReview
          id={id}
          oauth={oauth}
          busy={busy}
          run={run}
          refresh={refresh}
          cancel={cancel}
          reviewReturn={reviewReturn}
          onReviewReturnConsumed={onReviewReturnConsumed}
        />
      )}
      {blockedUrl && (
        <Notice tone="warn" title="The authorization window was blocked.">
          Open it yourself:{" "}
          <a href={blockedUrl} target="_blank" rel="noopener noreferrer">
            Open authorization page
          </a>
          . No registration or token work is replayed.
        </Notice>
      )}
      <div className="row wrap" style={{ alignItems: "flex-start" }}>
        <button
          type="button"
          className="button small ghost"
          disabled={disabled}
          onClick={() => setConfirm("disconnect")}
          data-testid={`oauth-disconnect-${id}`}
        >
          {busyIs("disconnect") ? "Disconnecting..." : "Disconnect and clean up..."}
        </button>
        {revocation.tone !== "neutral" && (
          <Pill plain tone={revocation.tone}>
            {revocation.label}
          </Pill>
        )}
      </div>
      {cleanup && <Notice tone={cleanup.tone}>{cleanup.text}</Notice>}
      {confirm === "connect" && (
        <Modal
          title={`${oauth.state === "disconnected" ? "Connect" : "Reconnect"} ${connection.definition.label}`}
          onClose={closeConfirm}
          footer={
            <>
              <button type="button" className="button" onClick={closeConfirm}>
                Cancel
              </button>
              <button type="button" className="button primary" onClick={() => void connect()}>
                {oauth.state === "disconnected" ? "Connect" : "Reconnect"}
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              Starts one five-minute, one-use authorization for client{" "}
              <span className="mono">{oauth.clientId}</span> at{" "}
              <span className="mono">{discovery?.issuer}</span> with scopes{" "}
              <span className="mono">{oauth.scopes.join(" ")}</span>, then opens the returned
              approved URL in a new window.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                Binds a browser cookie and PKCE verifier to the exact callback{" "}
                <span className="mono">{oauth.redirectUri}</span> ({callbackLabel[callbackMode]}).
              </li>
              {callbackMode === "fixed-loopback" && (
                <>
                  <li>
                    Opens a temporary listener on exactly that address for this transaction only (
                    <span className="mono">localhost</span> reserves both IPv4 and IPv6 loopback).
                    If the port is occupied, Connect fails and nothing is taken over or substituted.
                  </li>
                  <li>
                    The provider response is staged only in host memory and handed back to this
                    original browser through a one-use receipt; this browser's cookie must finish it
                    within 60 seconds. The listener closes after one valid response, Cancel, expiry
                    or Disconnect and is never restored after restart.
                  </li>
                </>
              )}
              <li>
                After provider consent the same browser returns here automatically, and the returned
                capabilities open for local review at once. A supported exact requested set, or a
                provider response that omits a scope string so the requested set is assumed, is
                persisted and authenticated at the callback with no further accept step. Additional
                returned capabilities stay unpersisted and unusable until you accept exactly the
                listed additional capabilities or refuse before the visible original deadline,
                without waiting on anything else; that deadline is the original five-minute (or
                shorter token) bound, not the 60-second hand-back receipt. Missing requirements
                cannot be accepted, only cancelled. A return that cannot be continued, such as a
                reused or expired one, changes none of these outcomes; the refreshed status here is
                authoritative.
              </li>
              <li>A new generation fences any previous authority, inventory and grants.</li>
              <li>
                Authentication grants no tools, verifies no identity or workspace and is not Load or
                Test evidence.
              </li>
            </ul>
            <p className="small faint" style={{ margin: 0 }}>
              Cancel sends nothing.
            </p>
          </div>
        </Modal>
      )}
      {confirm === "register" && (
        <Modal
          title={`Register a new client with ${discovery?.issuer}`}
          onClose={closeConfirm}
          footer={
            <>
              <button type="button" className="button" onClick={closeConfirm}>
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                disabled={consent !== registrationConsent}
                onClick={() => void register()}
              >
                Register client
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              Dynamic registration creates a new client at the authorization server for redirect{" "}
              <span className="mono">{selectedRedirect}</span> (
              {callback === "fixed" ? callbackLabel["fixed-loopback"] : callbackLabel.app}), method{" "}
              <span className="mono">{effectiveMethod}</span> and scopes{" "}
              <span className="mono">{validScopes.join(" ")}</span>. Registration is never automatic
              and is not retried if the outcome is ambiguous.
            </p>
            <div className="field">
              <label htmlFor={`oauth-consent-${id}`}>
                Type exactly: <span className="mono">{registrationConsent}</span>
              </label>
              <input
                id={`oauth-consent-${id}`}
                className="input mono"
                value={consent}
                autoComplete="off"
                onChange={(e) => setConsent(e.target.value)}
              />
            </div>
            <p className="small faint" style={{ margin: 0 }}>
              Cancel sends nothing.
            </p>
          </div>
        </Modal>
      )}
      {confirm === "disconnect" && (
        <Modal
          title={`Disconnect ${connection.definition.label}`}
          onClose={closeConfirm}
          footer={
            <>
              <button type="button" className="button" onClick={closeConfirm}>
                Cancel
              </button>
              <button type="button" className="button primary" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Immediately revokes local authority and cancels in-flight OAuth work.</li>
              <li>
                Attempts remote token revocation when the server supports it, reported separately.
              </li>
              <li>
                Deletes only this app-owned credential entry; native configuration is untouched.
              </li>
              <li>Resets enablement, grants and inventory for this connection.</li>
            </ul>
            <p className="small faint" style={{ margin: 0 }}>
              Cancel sends nothing.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function OAuthDiagnostics({
  connection,
  profile,
}: {
  connection: IntegrationConnection;
  profile: McpOAuthProfile;
}) {
  const id = connection.definition.id;
  const oauth = connection.oauth!;
  const native = connection.config.native;
  const declared = native?.oauth;
  const discovery = oauth.discovery;
  const callbackMode = oauth.callbackMode ?? "app";
  const appRedirect = oauth.appRedirectUri ?? oauth.redirectUri;
  const methods = discovery
    ? discovery.clientAuthMethods.filter((method) => profile.clientAuthMethods.includes(method))
    : [];
  const scopes = discovery
    ? discovery.scopes.filter((scope) => profile.readScopes.includes(scope))
    : [];
  const evidence = evidenceLabel[oauth.evidence];
  const storage = storageLabel[oauth.storage];
  const revocation = revocationLabel[oauth.remoteRevocation];
  return (
    <div className="stack" style={{ gap: 8 }} data-testid={`oauth-diagnostics-${id}`}>
      <dl className="kv small">
        <dt>OAuth profile</dt>
        <dd>
          <span className="mono">{profile.id}</span> ({profile.label})
        </dd>
        <dt>Generation</dt>
        <dd className="mono">{oauth.generation.slice(0, 12)}</dd>
        <dt>Client</dt>
        <dd>{oauth.configured ? "client configured" : "no client configured"}</dd>
        <dt>Evidence</dt>
        <dd>{evidence.label}</dd>
        <dt>Storage</dt>
        <dd>
          {storage.label}. {storage.note}
        </dd>
        <dt>Identity</dt>
        <dd>
          {oauth.identity
            ? `${oauth.identity.account} @ ${oauth.identity.workspace} (verified ${relativeTime(oauth.identity.verifiedAt)})`
            : "identity unknown, not verified"}
        </dd>
        <dt>Remote revocation</dt>
        <dd>{revocation.label}</dd>
        <dd className="faint" style={{ gridColumn: "1 / -1" }}>
          Authentication is app-owned metadata and tokens on this host only; it never reads or
          reuses a native login, token or session and never grants review tools. Connected means
          this app-owned authentication; review reads also need explicitly allowed tools.{" "}
          {profile?.id === "notion-mcp/1"
            ? "Notion Test checks local configuration only, not document access or live reads."
            : "Test is a separate point-in-time live read."}{" "}
          Local disconnection is immediate and separate from remote revocation; cleanup stays
          available after source drift.
        </dd>
      </dl>
      {native && (
        <dl className="kv small" data-testid={`oauth-declared-${id}`}>
          <dt>Declared source</dt>
          <dd>
            entry <span className="mono">{native.name}</span> in{" "}
            <span className="mono">{native.path}</span>
          </dd>
          <dt>Declared endpoint</dt>
          <dd className="mono">{connection.config.endpoint ?? "none declared"}</dd>
          <dt>Declared client id</dt>
          <dd className="mono">{declared?.clientId ?? "none declared"}</dd>
          <dt>Declared callback port</dt>
          <dd>
            {declared ? (
              <>
                <span className="mono">{declared.callbackPort}</span> (the source's own callback,
                not this app's)
              </>
            ) : (
              "none declared"
            )}
          </dd>
          <dt>This app's callback</dt>
          <dd className="mono">{appRedirect}</dd>
          <dt>Selected callback</dt>
          <dd>
            <span className="mono">{oauth.redirectUri}</span> ({callbackLabel[callbackMode]})
          </dd>
          <dd className="faint" style={{ gridColumn: "1 / -1" }}>
            Read-only metadata from the discovered definition, shown so known values need not be
            retyped. It is not an app-owned registration, an account, a session or a grant, and it
            does not show that the registration accepts this app's callback, a fixed loopback
            redirect or a public client. The declared port is never turned into a redirect or
            selected for you. Nothing here is configured, connected or verified automatically.
          </dd>
        </dl>
      )}
      {discovery && (
        <dl className="kv small" data-testid={`oauth-discovery-${id}`}>
          <dt>Issuer</dt>
          <dd className="mono">{discovery.issuer}</dd>
          <dt>Resource</dt>
          <dd className="mono">{discovery.resource}</dd>
          <dt>Authorization endpoint</dt>
          <dd className="mono">{discovery.authorizationEndpoint}</dd>
          <dt>Selected callback</dt>
          <dd>
            <span className="mono">{oauth.redirectUri}</span> ({callbackLabel[callbackMode]})
          </dd>
          <dt>Allowed client methods</dt>
          <dd>
            {methods.length ? methods.map((m) => methodLabel[m]).join(", ") : "none in common"}
          </dd>
          <dt>
            {profile?.id === "notion-mcp/1"
              ? "Workspace capability scopes (not read-only permissions)"
              : profile?.id === "axiom-mcp/1"
                ? "Sign-in and renewal scopes (not read-only permissions)"
                : "Approved read scopes"}
          </dt>
          <dd className="mono">{scopes.length ? scopes.join(" ") : "none in common"}</dd>
          <dt>Dynamic registration</dt>
          <dd>
            {discovery.dynamicRegistration ? "advertised by server" : "not advertised by server"};{" "}
            {profile.dynamicRegistration ? "permitted by profile" : "disabled by profile"}
          </dd>
          <dt>Discovery digest</dt>
          <dd className="mono">{discovery.digest}</dd>
          <dt>Checked</dt>
          <dd>
            {relativeTime(discovery.checkedAt)} ({formatDate(discovery.checkedAt)})
          </dd>
        </dl>
      )}
      {oauth.configured && (
        <div className="small" data-testid={`oauth-client-${id}`}>
          Static client <span className="mono">{oauth.clientId}</span>, method{" "}
          <span className="mono">{oauth.clientAuthMethod}</span>, scopes{" "}
          <span className="mono">{oauth.scopes.join(" ") || "none"}</span>, callback{" "}
          <span className="mono">{oauth.redirectUri}</span> ({callbackLabel[callbackMode]}). Secrets
          are never shown. Configured is not authenticated.
        </div>
      )}
    </div>
  );
}

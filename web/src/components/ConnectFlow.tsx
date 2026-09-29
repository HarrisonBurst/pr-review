import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  IntegrationCatalog,
  IntegrationConnection,
  McpClientAuthMethod,
  McpOAuthConnectResult,
  McpOAuthProfile,
} from "../../../shared/contracts";
import { api } from "../api/client";
import type { OAuthReturn } from "../app-context";
import { relativeTime } from "../lib/format";
import {
  clientIdPattern,
  methodLabel,
  registrationConsent,
  storageLabel,
  type OAuthRun,
} from "./OAuthConnection";
import { OAuthScopeReview } from "./OAuthScopes";
import { Modal, Notice, Pill, type Tone } from "./ui";

export type FlowStep =
  | "unsupported"
  | "choose-profile"
  | "import"
  | "bind"
  | "discover"
  | "client"
  | "authorize"
  | "waiting"
  | "review"
  | "load"
  | "reload"
  | "grants"
  | "done";

export type Apply = (
  key: string,
  action: () => Promise<IntegrationCatalog>,
  message: string,
) => Promise<boolean>;

const order: FlowStep[] = [
  "unsupported",
  "choose-profile",
  "import",
  "bind",
  "discover",
  "client",
  "authorize",
  "waiting",
  "review",
  "load",
  "reload",
  "grants",
  "done",
];

const automatic: FlowStep[] = ["import", "discover", "authorize", "load"];

export const oauthProfileOf = (catalog: IntegrationCatalog, connection: IntegrationConnection) =>
  (catalog.oauthProfiles ?? []).find((profile) => profile.id === connection.config.oauthProfileId);

const matchingProfiles = (catalog: IntegrationCatalog, connection: IntegrationConnection) =>
  (catalog.oauthProfiles ?? []).filter(
    (profile) => profile.endpoint === connection.config.endpoint,
  );

const needsOAuthImport = (connection: IntegrationConnection) =>
  connection.config.native?.authentication === "app-owned-oauth" &&
  !connection.config.oauthProfileId;

const bindable = (catalog: IntegrationCatalog, connection: IntegrationConnection) =>
  connection.config.native?.support === "supported" && (catalog.profiles ?? []).length > 0;

function readStep(catalog: IntegrationCatalog, connection: IntegrationConnection): FlowStep {
  const { config, definition } = connection;
  if (connection.oauth && oauthProfileOf(catalog, connection)?.readSupport !== "supported")
    return "done";
  if ((config.native || config.oauthProfileId) && config.inventory?.status !== "loaded")
    return config.inventory ? "reload" : "load";
  if (definition.tools.length && !(config.enabled && config.allowedTools.length)) return "grants";
  return "done";
}

export function flowStep(catalog: IntegrationCatalog, connection: IntegrationConnection): FlowStep {
  const { config, oauth } = connection;
  if (needsOAuthImport(connection)) {
    const count = matchingProfiles(catalog, connection).length;
    return count === 0 ? "unsupported" : count === 1 ? "import" : "choose-profile";
  }
  if (oauth && oauthProfileOf(catalog, connection)) {
    if (oauth.storage === "unsupported") return "unsupported";
    if (oauth.state === "authorizing") return oauth.scopeReview ? "review" : "waiting";
    if (!oauth.discovery) return "discover";
    if (!oauth.configured) return "client";
    if (oauth.state !== "authenticated") return "authorize";
    return readStep(catalog, connection);
  }
  if (config.native && !config.readProvider)
    return bindable(catalog, connection) ? "bind" : "unsupported";
  if (!connection.definition.supported) return "unsupported";
  return readStep(catalog, connection);
}

function unsupportedReason(catalog: IntegrationCatalog, connection: IntegrationConnection) {
  const { config, oauth, definition } = connection;
  if (needsOAuthImport(connection))
    return `No reviewed sign-in profile matches ${config.endpoint}.`;
  if (oauth?.storage === "unsupported") return storageLabel.unsupported.note;
  if (config.native?.transport === "stdio")
    return "Connect and Load never start local stdio servers, since that would run code on this host. Docker can run an eligible one only inside its container if you include it under Local stdio tools in the Execution Docker setup.";
  if (config.native && !config.readProvider && !bindable(catalog, connection))
    return config.native.message;
  return definition.compatibilityMessage ?? "This connection is not supported.";
}

function reviewAccess(
  catalog: IntegrationCatalog,
  connection: IntegrationConnection,
): { detail: string; problem?: string } {
  const { config, definition } = connection;
  if (connection.oauth && oauthProfileOf(catalog, connection)?.readSupport !== "supported")
    return { detail: "review reads not supported yet" };
  if (
    (config.native || config.oauthProfileId) &&
    config.inventory &&
    config.inventory.status !== "loaded"
  )
    return { detail: "review access off", problem: config.inventory.message };
  if ((config.native || config.oauthProfileId) && !config.inventory)
    return { detail: "review access not set up" };
  if (!definition.tools.length)
    return {
      detail: "review access off",
      problem: "The provider offers none of the reviewed read tools.",
    };
  if (!config.enabled || !config.allowedTools.length)
    return { detail: "review access not enabled" };
  const reads = `${config.allowedTools.length} read${config.allowedTools.length === 1 ? "" : "s"}`;
  return catalog.boundary.status === "available"
    ? { detail: `review access on (${reads})` }
    : { detail: `review access on (${reads}), waiting for saved Isolated or Docker settings` };
}

export interface ConnectionSummary {
  tone: Tone;
  label: string;
  detail?: string;
  problem?: string;
  action: "Connect" | "Connected" | "Continue" | "Reconnect" | "Review";
  disabled?: boolean;
}

export function connectionSummary(
  catalog: IntegrationCatalog,
  connection: IntegrationConnection,
): ConnectionSummary {
  const { oauth, evidence } = connection;
  const step = flowStep(catalog, connection);
  const failedTest =
    evidence?.scope === "live_read" && !evidence.connected
      ? `Last live test failed: ${evidence.message}`
      : undefined;
  if (step === "unsupported")
    return {
      tone: "warn",
      label: "Unsupported",
      problem: unsupportedReason(catalog, connection),
      action: "Connect",
      disabled: true,
    };
  if (oauth && oauthProfileOf(catalog, connection)) {
    const storageProblem =
      oauth.storage === "unavailable" ? storageLabel.unavailable.note : undefined;
    if (oauth.state === "authorizing") {
      if (oauth.scopeReview?.status === "approval_required")
        return {
          tone: "warn",
          label: "Needs your approval",
          problem: "The provider returned extra permissions. Review them to finish connecting.",
          action: "Review",
        };
      if (oauth.scopeReview?.status === "missing_required")
        return {
          tone: "danger",
          label: "Missing permissions",
          problem: "The provider did not grant the required read permission.",
          action: "Review",
        };
      return { tone: "accent", label: "Signing in", problem: storageProblem, action: "Continue" };
    }
    if (oauth.state === "authenticated") {
      const access = reviewAccess(catalog, connection);
      const synthetic = oauth.evidence === "synthetic_transport";
      return {
        tone: synthetic ? "warn" : "ok",
        label: synthetic ? "Connected (synthetic)" : "Connected",
        detail: access.detail,
        problem: storageProblem ?? access.problem ?? failedTest,
        action: step === "done" ? "Connected" : "Continue",
      };
    }
    if (oauth.state === "reconnect_required")
      return {
        tone: "warn",
        label: "Reconnect required",
        problem: storageProblem ?? oauth.message,
        action: "Reconnect",
      };
    return {
      tone: storageProblem ? "danger" : "neutral",
      label: "Not connected",
      problem: storageProblem,
      action: "Connect",
    };
  }
  if (evidence?.scope === "live_read" && evidence.connected)
    return {
      tone: "ok",
      label: "Connected",
      detail: `live test passed ${relativeTime(evidence.testedAt)}`,
      action: "Connected",
    };
  if (step === "done" || step === "grants") {
    const access = reviewAccess(catalog, connection);
    return {
      tone: failedTest ? "danger" : "info",
      label: "Not verified",
      detail: access.detail,
      problem: access.problem ?? failedTest,
      action: "Connect",
    };
  }
  return { tone: "neutral", label: "Not connected", problem: failedTest, action: "Connect" };
}

const stageOf: Record<FlowStep, number> = {
  unsupported: 0,
  "choose-profile": 0,
  import: 0,
  bind: 0,
  discover: 0,
  client: 1,
  authorize: 2,
  waiting: 2,
  review: 2,
  load: 3,
  reload: 3,
  grants: 3,
  done: 4,
};

function Stages({ oauth, step }: { oauth: boolean; step: FlowStep }) {
  const labels = oauth
    ? ["Provider settings", "App client", "Sign in", "Review access"]
    : ["Provider settings", "Review access"];
  const current = oauth ? stageOf[step] : stageOf[step] === 4 ? 2 : stageOf[step] === 3 ? 1 : 0;
  return (
    <ol className="connect-stages" aria-label="Connection progress">
      {labels.map((label, index) => (
        <li
          key={label}
          data-state={index < current ? "done" : index === current ? "current" : "todo"}
          aria-current={index === current ? "step" : undefined}
        >
          {label}
        </li>
      ))}
    </ol>
  );
}

function SignInPlan({ provider }: { provider: string }) {
  return (
    <div className="small" data-testid="sign-in-plan">
      <strong>When {provider} sign-in opens in a new window:</strong>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        <li>Finish its consent there, then come straight back to this window.</li>
        <li>
          If it grants exactly what was asked, or doesn't say, sign-in completes with nothing more
          to accept.
        </li>
        <li>
          Extra permissions stay unsaved and unusable until you accept or refuse that exact list
          here before its deadline, at most five minutes after sign-in starts. A missing required
          permission can only be cancelled.
        </li>
        <li>Signing in lets reviews read nothing. You choose each read afterward, all off.</li>
      </ul>
    </div>
  );
}

function ClientStep({
  connection,
  profile,
  disabled,
  onConfigure,
  onRegister,
}: {
  connection: IntegrationConnection;
  profile: McpOAuthProfile;
  disabled: boolean;
  onConfigure: (body: Parameters<typeof api.configureOAuth>[1]) => void;
  onRegister: (body: Parameters<typeof api.registerOAuth>[1]) => void;
}) {
  const oauth = connection.oauth!;
  const discovery = oauth.discovery!;
  const declared = connection.config.native?.oauth;
  const methods = discovery.clientAuthMethods.filter((method) =>
    profile.clientAuthMethods.includes(method),
  );
  const scopes = discovery.scopes.filter((scope) => profile.readScopes.includes(scope));
  const registrable = discovery.dynamicRegistration && profile.dynamicRegistration;
  const appRedirect = oauth.appRedirectUri ?? oauth.redirectUri;
  const provider = profile.label.replace(/ \(.*\)$/, "");
  const [existing, setExisting] = useState(!registrable);
  const [clientId, setClientId] = useState(oauth.clientId ?? declared?.clientId ?? "");
  const [method, setMethod] = useState<McpClientAuthMethod | undefined>(
    methods.includes("none") ? "none" : methods[0],
  );
  const [secret, setSecret] = useState("");
  const [fixed, setFixed] = useState(false);
  const [fixedUri, setFixedUri] = useState("");
  const [consent, setConsent] = useState("");
  const confidential = method !== undefined && method !== "none";
  const redirectUri = fixed ? fixedUri.trim() : appRedirect;
  const base = { scopes, discoveryDigest: discovery.digest, redirectUri };
  if (!methods.length || !scopes.length)
    return (
      <Notice tone="danger" title="This provider can't be set up automatically.">
        {!methods.length
          ? "It offers no client method this app supports."
          : "It offers none of the reviewed read permissions."}
      </Notice>
    );
  if (!existing)
    return (
      <form
        className="stack"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (consent === registrationConsent && method)
            onRegister({ ...base, consent: registrationConsent, clientAuthMethod: method });
        }}
      >
        <p style={{ margin: 0 }}>
          {discovery.issuer} lets apps register themselves. Registering creates a new OAuth client
          for this app there, asking only for <span className="mono">{scopes.join(" ")}</span>. It
          signs nothing in and is never retried automatically.
        </p>
        <div className="field">
          <label htmlFor="connect-consent">
            To approve, type <span className="mono">{registrationConsent}</span>
          </label>
          <input
            id="connect-consent"
            className="input mono"
            value={consent}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => setConsent(e.target.value)}
          />
        </div>
        <SignInPlan provider={provider} />
        <div className="row wrap">
          <button
            type="submit"
            className="button small primary"
            disabled={disabled || consent !== registrationConsent}
          >
            Register and continue
          </button>
          <button
            type="button"
            className="button small ghost"
            disabled={disabled}
            onClick={() => setExisting(true)}
          >
            Use an existing client instead
          </button>
        </div>
      </form>
    );
  const valid =
    method !== undefined &&
    clientIdPattern.test(clientId.trim()) &&
    (!confidential || secret.length > 0) &&
    redirectUri.length > 0;
  return (
    <form
      className="stack"
      style={{ gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const body = {
          ...base,
          clientId: clientId.trim(),
          clientAuthMethod: method,
          ...(confidential ? { clientSecret: secret } : {}),
        };
        setSecret("");
        onConfigure(body);
      }}
    >
      <p style={{ margin: 0 }}>
        {provider} needs an OAuth app you are allowed to use that accepts this app's callback. This
        app never reuses another tool's login.
      </p>
      <div className="field">
        <label htmlFor="connect-client-id">Client id</label>
        <input
          id="connect-client-id"
          className="input mono"
          value={clientId}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={clientId.trim() !== "" && !clientIdPattern.test(clientId.trim())}
          aria-describedby="connect-client-help"
          onChange={(e) => setClientId(e.target.value)}
        />
        <span id="connect-client-help" className="small faint">
          {declared && clientId.trim() === declared.clientId
            ? "Filled in from your native configuration. That doesn't prove the app accepts this callback."
            : `Its redirect must include ${redirectUri || "the callback below"}.`}
        </span>
      </div>
      {methods.length > 1 && (
        <div className="field">
          <label htmlFor="connect-method">Client type</label>
          <select
            id="connect-method"
            className="select"
            value={method}
            disabled={disabled}
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
      )}
      {confidential && (
        <div className="field">
          <label htmlFor="connect-secret">Client secret</label>
          <input
            id="connect-secret"
            className="input mono"
            type="password"
            value={secret}
            autoComplete="new-password"
            disabled={disabled}
            onChange={(e) => setSecret(e.target.value)}
          />
          <span className="small faint">Sent once to app-owned storage, never shown again.</span>
        </div>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={fixed}
          disabled={disabled}
          onChange={(e) => setFixed(e.target.checked)}
        />
        <span>The app only accepts a fixed loopback redirect</span>
      </label>
      {fixed && (
        <div className="field">
          <label htmlFor="connect-fixed">Registered loopback redirect</label>
          <input
            id="connect-fixed"
            className="input mono"
            value={fixedUri}
            placeholder="http://localhost:PORT/path"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => setFixedUri(e.target.value)}
          />
          <span className="small faint">
            Typed exactly as registered. A temporary listener opens there only while you sign in.
          </span>
        </div>
      )}
      <div className="small faint">
        Requests only <span className="mono">{scopes.join(" ")}</span>.
      </div>
      <SignInPlan provider={provider} />
      <div className="row wrap">
        <button type="submit" className="button small primary" disabled={disabled || !valid}>
          Save and continue
        </button>
        {registrable && (
          <button
            type="button"
            className="button small ghost"
            disabled={disabled}
            onClick={() => setExisting(false)}
          >
            Register a new client instead
          </button>
        )}
      </div>
    </form>
  );
}

function GrantsStep({
  connection,
  disabled,
  onSave,
  onSkip,
}: {
  connection: IntegrationConnection;
  disabled: boolean;
  onSave: (allowedTools: string[]) => void;
  onSkip: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>(
    connection.config.allowedTools.filter((id) =>
      connection.definition.tools.some((tool) => tool.id === id),
    ),
  );
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p style={{ margin: 0 }}>
        Choose what reviews may read from {connection.definition.label}. Everything else stays
        denied, and reviews can never write.
      </p>
      <fieldset className="stack" style={{ gap: 4 }}>
        <legend className="small">Allowed reads</legend>
        {connection.definition.tools.map((tool) => (
          <label className="check-row" key={tool.id}>
            <input
              type="checkbox"
              checked={chosen.includes(tool.id)}
              disabled={disabled}
              onChange={(e) =>
                setChosen(
                  e.target.checked
                    ? [...chosen, tool.id]
                    : chosen.filter((value) => value !== tool.id),
                )
              }
            />
            <span>
              {tool.label} <span className="mono small faint">{tool.toolNames.join(", ")}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="row wrap">
        <button
          type="button"
          className="button small primary"
          disabled={disabled || !chosen.length}
          onClick={() => onSave(chosen)}
        >
          Allow for reviews
        </button>
        <button type="button" className="button small ghost" disabled={disabled} onClick={onSkip}>
          Not now
        </button>
      </div>
    </div>
  );
}

export function ConnectFlow({
  connection,
  catalog,
  auto: startAuto,
  busy,
  error,
  run,
  apply,
  refresh,
  bindForm,
  profileForm,
  reviewReturn,
  onReviewReturnConsumed,
  onClose,
}: {
  connection: IntegrationConnection;
  catalog: IntegrationCatalog;
  auto: boolean;
  busy: string | null;
  error: string | null;
  run: OAuthRun;
  apply: Apply;
  refresh: () => Promise<void>;
  bindForm: ReactNode;
  profileForm: ReactNode;
  reviewReturn: OAuthReturn | null;
  onReviewReturnConsumed: () => void;
  onClose: () => void;
}) {
  const id = connection.definition.id;
  const label = connection.definition.label;
  const oauth = connection.oauth;
  const profile = oauthProfileOf(catalog, connection);
  const step = flowStep(catalog, connection);
  const summary = connectionSummary(catalog, connection);
  const [auto, setAuto] = useState(startAuto);
  const [editGrants, setEditGrants] = useState(false);
  const [pending, setPending] = useState<McpOAuthConnectResult | null>(null);
  const attempted = useRef(
    new Set(automatic.filter((item) => order.indexOf(item) < order.indexOf(step))),
  );
  const [returned] = useState(reviewReturn?.kind === "ready" && reviewReturn.connectionId === id);
  const alive = useRef(true);
  const disabled = busy !== null;
  const provider = profile?.label.replace(/ \(.*\)$/, "") ?? label;

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  useEffect(() => {
    if (oauth?.state !== "authorizing") setPending(null);
  }, [oauth?.state, oauth?.generation]);

  const close = useCallback(() => {
    alive.current = false;
    onClose();
  }, [onClose]);

  const perform = async (current: FlowStep) => {
    if (current === "import") {
      const [match] = matchingProfiles(catalog, connection);
      if (!match) return;
      await apply(
        `${id}:import-oauth`,
        () => api.importOAuthIntegration({ id, profileId: match.id }),
        "Provider settings found; nothing was signed in or granted",
      );
    } else if (current === "discover") {
      await run(`${id}:oauth:discover`, async () => {
        await api.discoverOAuth(id);
        await refresh();
      });
    } else if (current === "authorize") {
      const started = await run(`${id}:oauth:connect`, async () => {
        const result = await api.connectOAuth(id);
        if (alive.current) window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
        await refresh();
        return result;
      });
      if (started && alive.current) setPending(started);
    } else if (current === "load" || current === "reload") {
      await apply(
        `${id}:load`,
        () => api.loadIntegrationTools(id),
        "Review tools loaded; each stays denied until you allow it",
      );
    }
  };

  useEffect(() => {
    if (!auto || busy !== null || !automatic.includes(step) || attempted.current.has(step)) return;
    attempted.current.add(step);
    void perform(step);
  }, [auto, busy, step]);

  const retry = (current: FlowStep) => {
    attempted.current.add(current);
    setAuto(true);
    void perform(current);
  };

  const configure = async (body: Parameters<typeof api.configureOAuth>[1]) => {
    setAuto(true);
    await run(`${id}:oauth:configure`, async () => {
      await api.configureOAuth(id, body);
      await refresh();
    });
  };

  const register = async (body: Parameters<typeof api.registerOAuth>[1]) => {
    setAuto(true);
    await run(`${id}:oauth:register`, async () => {
      await api.registerOAuth(id, body);
      await refresh();
    });
  };

  const cancelSignIn = () =>
    run(
      `${id}:oauth:cancel`,
      async () => {
        await api.cancelOAuth(id);
        await refresh();
      },
      "Sign-in cancelled locally",
    );

  const allow = async (allowedTools: string[]) => {
    const saved = await apply(
      `${id}:grants`,
      () => api.updateIntegration(id, { enabled: true, allowedTools }),
      `${label}: review access updated for new sessions`,
    );
    if (saved && alive.current) setEditGrants(false);
  };

  const working = (text: string, current: FlowStep, action: string) =>
    busy !== null ? (
      <p style={{ margin: 0 }} aria-live="polite">
        {text}
      </p>
    ) : (
      <div className="row wrap">
        <button type="button" className="button small primary" onClick={() => retry(current)}>
          {action}
        </button>
      </div>
    );

  const scopeReview = oauth && (
    <OAuthScopeReview
      id={id}
      oauth={oauth!}
      busy={busy}
      run={run}
      refresh={refresh}
      cancel={cancelSignIn}
      reviewReturn={reviewReturn}
      onReviewReturnConsumed={onReviewReturnConsumed}
      autoOpen
    />
  );

  const body = (): ReactNode => {
    if (editGrants)
      return (
        <GrantsStep
          connection={connection}
          disabled={disabled}
          onSave={(tools) => void allow(tools)}
          onSkip={() => setEditGrants(false)}
        />
      );
    switch (step) {
      case "unsupported":
        return <Notice tone="warn">{summary.problem}</Notice>;
      case "choose-profile":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>More than one reviewed provider matches. Choose one.</p>
            {profileForm}
          </div>
        );
      case "bind":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>Choose the profile and the documents reviews may read.</p>
            {bindForm}
          </div>
        );
      case "import":
        return working("Finding provider settings...", step, "Find provider settings");
      case "discover":
        return working(`Checking ${provider} sign-in requirements...`, step, "Check requirements");
      case "client":
        return (
          <ClientStep
            connection={connection}
            profile={profile!}
            disabled={disabled}
            onConfigure={(value) => void configure(value)}
            onRegister={(value) => void register(value)}
          />
        );
      case "authorize":
        return busy !== null ? (
          <p style={{ margin: 0 }} aria-live="polite">
            Opening {provider} sign-in...
          </p>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              Sign in to {provider} in a new window. It asks only for{" "}
              <span className="mono">{oauth!.scopes.join(" ")}</span>.
            </p>
            <SignInPlan provider={provider} />
            <div className="row wrap">
              <button
                type="button"
                className="button small primary"
                onClick={() => retry("authorize")}
              >
                Sign in to {provider}
              </button>
            </div>
          </div>
        );
      case "waiting":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }} aria-live="polite">
              Finish signing in to {provider} in the other window, then come back here.
              {pending && ` The sign-in expires ${relativeTime(pending.expiresAt)}.`}
            </p>
            {pending && (
              <span className="small">
                Window didn't open?{" "}
                <a href={pending.authorizationUrl} target="_blank" rel="noopener noreferrer">
                  Open the {provider} sign-in page
                </a>
              </span>
            )}
            <div className="row wrap">
              <button
                type="button"
                className="button small"
                disabled={disabled}
                onClick={() => void run(`${id}:oauth:refresh`, refresh)}
              >
                {busy === `${id}:oauth:refresh` ? "Checking..." : "Check again"}
              </button>
              <button
                type="button"
                className="button small ghost"
                disabled={disabled}
                onClick={() => void cancelSignIn()}
              >
                Cancel sign-in
              </button>
            </div>
          </div>
        );
      case "review":
        return null;
      case "load":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              {oauth?.state === "authenticated" && "Signed in. "}
              Load the available read tools, then choose which reviews may use. Loading grants
              nothing and does not repeat sign-in.
            </p>
            {working(
              `Loading ${provider} read tools...`,
              step,
              error ? "Retry loading read tools" : "Load read tools",
            )}
          </div>
        );
      case "reload":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <Notice tone="warn">{connection.config.inventory?.message}</Notice>
            <p style={{ margin: 0 }}>
              Reloading the tool list turns review access off until you allow reads again.
            </p>
            <div className="row wrap">
              <button
                type="button"
                className="button small primary"
                disabled={disabled}
                onClick={() => retry("reload")}
              >
                {busy === `${id}:load` ? "Reloading..." : "Reload read tools"}
              </button>
            </div>
          </div>
        );
      case "grants":
        return (
          <GrantsStep
            connection={connection}
            disabled={disabled}
            onSave={(tools) => void allow(tools)}
            onSkip={close}
          />
        );
      case "done":
        return (
          <div className="stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              <Pill tone={summary.tone}>{summary.label}</Pill>{" "}
              {summary.detail && <span className="small">{summary.detail}</span>}
            </p>
            {summary.problem && <Notice tone="warn">{summary.problem}</Notice>}
            {oauth && profile?.readSupport !== "supported" && (
              <p className="small faint" style={{ margin: 0 }}>
                Signed in, but {provider} review reads aren't supported yet, so reviews can't use
                it.
              </p>
            )}
            {!oauth && (
              <p className="small faint" style={{ margin: 0 }}>
                This connection uses its own credential. Test it under Advanced to confirm it works.
              </p>
            )}
            {connection.definition.tools.length > 0 && (
              <div className="row wrap">
                <button
                  type="button"
                  className="button small"
                  disabled={disabled}
                  onClick={() => setEditGrants(true)}
                >
                  Change review access
                </button>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <Modal
      title={`${summary.action === "Connected" ? "" : "Connect "}${label}`}
      onClose={close}
      footer={
        <button type="button" className="button" onClick={close}>
          {step === "done" ? "Done" : "Close"}
        </button>
      }
    >
      <div className="stack" style={{ gap: 12 }} data-testid={`connect-flow-${id}`}>
        {step !== "unsupported" && (
          <Stages oauth={Boolean(oauth) || needsOAuthImport(connection)} step={step} />
        )}
        {profile?.id === "notion-mcp/1" && (
          <Notice tone="info" title="Notion workspace access">
            Choose your workspace in Notion's sign-in window. The default OAuth capability allows
            reading and updating content you can access, not just reads. The broader credential
            stays on the host; this app permits only explicitly granted notion-fetch reads. Search,
            writes and agent tools are denied. No Notion token is needed here. Test checks local
            configuration only because no document ID is supplied.
          </Notice>
        )}
        {profile?.id === "axiom-mcp/1" && (
          <Notice tone="info" title="Axiom account access">
            Choose your account and organization in Axiom's sign-in window. OAuth can carry your
            account's write permissions; this app keeps the credential on the host and allows only
            the reads you select below. No Axiom token is needed here. Queries can incur cost and
            results route through US infrastructure.
          </Notice>
        )}
        {error && (
          <Notice tone="danger" title="That step didn't work.">
            {error}
          </Notice>
        )}
        {(step === "review" || (returned && oauth?.scopeReview)) && scopeReview}
        {body()}
        {step !== "done" && step !== "unsupported" && (
          <p className="small faint" style={{ margin: 0 }}>
            Closing stops here; finished steps stay done and nothing is undone.
          </p>
        )}
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  HarnessId,
  IntegrationCatalog,
  IntegrationConnection,
  IntegrationConnectionStatus,
  IntegrationInventory,
  IntegrationTestResult,
  McpOAuthProfile,
  NativeMcpSource,
} from "../../../shared/contracts";
import { api, RequestError } from "../api/client";
import { useApp } from "../app-context";
import { ConnectFlow, connectionSummary, type Apply } from "./ConnectFlow";
import { harnessLabel } from "../lib/execution";
import { formatDate, relativeTime } from "../lib/format";
import { OAuthDiagnostics, OAuthPanel, type OAuthRun } from "./OAuthConnection";
import { Modal, Notice, Pill, Segmented, useToast, type Tone } from "./ui";

const statusTone: Record<IntegrationConnectionStatus, Tone> = {
  ready: "ok",
  configured: "info",
  disabled: "neutral",
  needs_authentication: "warn",
  needs_compatibility: "warn",
  unsupported: "warn",
  error: "danger",
};

const inventoryTone: Record<IntegrationInventory["status"], Tone> = {
  loaded: "ok",
  changed: "warn",
  error: "danger",
};

const formatLabel: Record<NativeMcpSource["format"], string> = {
  "claude-json": "Claude JSON",
  "codex-toml": "Codex TOML",
};

const authLabel: Record<IntegrationConnection["definition"]["authReuse"], string> = {
  "gh-login": "existing gh login token, read only during an explicit Test or captured session",
  "host-session":
    "the connection-side bearer or referenced credential, read only during an explicit Load, Test or captured session",
  "oauth-not-portable": "OAuth session is not portable; no transport reuses it",
  none: "no credential reference",
};

const scopeId = /^[A-Za-z0-9_-]{1,100}$/;

const actionableCodes: Record<string, string> = {
  oauth_origin:
    "Open the app from its backend-served address http://127.0.0.1:<port> (not the Vite dev origin) and retry.",
  credential_store_unsupported:
    "This host has no supported app-owned credential store; Linux and plaintext fallbacks are not supported.",
  credential_store_unavailable:
    "The credential store is locked or unavailable; unlock it and retry. Cleanup controls remain available.",
  oauth_disconnect_required:
    "Disconnect the existing app-owned OAuth connection first; its cleanup controls stay in place.",
  oauth_callback_invalid:
    "Nothing was saved. Keep the app callback, or enter an exact http://localhost, http://127.0.0.1 or http://[::1] redirect with an explicit port 1024-65535 other than the app port and a plain path.",
  oauth_callback_unavailable:
    "No listener was opened, no port was taken over and no other callback was substituted. Free the port or explicitly choose another registered redirect, then Connect again.",
  oauth_callback_changed:
    "The app callback address changed since this client was saved. Open Replace client configuration and explicitly save the callback choice again; no fixed listener was inferred.",
  oauth_scopes_missing:
    "Nothing was accepted or persisted. Review returned OAuth capabilities to see which requested permissions are missing, then Cancel authorization and reconnect only after the registration grants them; no approval can add them.",
  oauth_scopes_invalid:
    "No disclosure or credential was accepted. Cancel authorization; reconnect only after the provider's scope format is resolved. Nothing was partially shown.",
  oauth_scope_consent_invalid:
    "No additional capability was accepted. The disclosure expired, belongs to another browser or generation, or no longer matches. Refresh status; a new explicit Connect is required to review again.",
  oauth_scopes_changed:
    "The accepted capabilities changed on refresh. Nothing was widened; explicitly Reconnect and review the returned capabilities again.",
};

const errorText = (e: unknown) =>
  e instanceof RequestError
    ? `${e.message}${e.code ? ` (${e.code})` : ""}${e.code && actionableCodes[e.code] ? ` ${actionableCodes[e.code]}` : ""}`
    : String(e);

const oauthReadSupported = (catalog: IntegrationCatalog, connection: IntegrationConnection) =>
  (catalog.oauthProfiles ?? []).find((profile) => profile.id === connection.config.oauthProfileId)
    ?.readSupport === "supported";

const oauthReadCopy = (connection: IntegrationConnection) =>
  connection.config.oauthProfileId === "notion-mcp/1"
    ? {
        tools: "reviewed Notion document read tool (notion-fetch)",
        testHint:
          "Local admission, source and fetch grant check only. Test has no document ID and performs no provider request or credential refresh.",
        testRequest: "no provider request",
        testRequirement:
          "Requires admitted authentication, loaded inventory and an enabled notion-fetch grant.",
        unverified: "workspace identity, document access or complete coverage",
        diagnostic:
          " Test checks local configuration only; actual granted reads validate the current provider schema before dispatch.",
      }
    : connection.config.oauthProfileId === "axiom-mcp/1"
      ? {
          tools: "reviewed Axiom dataset, field and bounded event read tools",
          testHint:
            "Needs the connection enabled with listDatasets granted; lists dataset metadata once and grants nothing. No event query is run.",
          testRequest: "one listDatasets request with no arguments",
          testRequirement:
            "Requires this connection enabled with listDatasets granted; otherwise it reports local configuration only and contacts nothing.",
          unverified: "account identity, dataset isolation or complete coverage",
          diagnostic:
            " Test may use normal credential refresh; it verifies neither account identity nor dataset isolation.",
        }
      : connection.config.oauthProfileId === "linear-mcp/1"
        ? {
            tools: "reviewed Linear issue read tools (get_issue, list_issues)",
            testHint:
              "Needs the connection enabled with list_issues granted; one fixed bounded issue search that grants nothing. A get_issue grant alone cannot run Test.",
            testRequest: "one bounded list_issues issue search",
            testRequirement:
              "Requires this connection enabled with list_issues granted; a get_issue grant alone does not qualify, and otherwise it reports local configuration only and contacts nothing.",
            unverified: "workspace or account identity or complete issue coverage",
            diagnostic:
              " Test may use the credential's normal refresh and does not verify workspace or account identity or complete issue coverage.",
          }
        : {
            tools: "reviewed Slack read tools",
            testHint:
              "Needs the connection enabled with an explicit search tool granted; one fixed bounded search that grants nothing.",
            testRequest: "one bounded search",
            testRequirement:
              "Requires this connection enabled with an explicit search tool granted; otherwise it reports local configuration only and contacts nothing.",
            unverified: "workspace or account identity or channel isolation",
            diagnostic:
              " Test may use the credential's normal refresh and does not verify workspace, account or channel isolation.",
          };

export function evidenceLabel(evidence: IntegrationTestResult): { tone: Tone; label: string } {
  if (evidence.scope === "live_read")
    return evidence.connected
      ? { tone: "ok", label: "Live read succeeded" }
      : { tone: "danger", label: "Live read failed" };
  if (evidence.scope === "synthetic_transport")
    return { tone: "warn", label: "Synthetic transport, not a live read" };
  return { tone: "neutral", label: "Local configuration only, not tested" };
}

function Evidence({ evidence }: { evidence: IntegrationTestResult }) {
  const { tone, label } = evidenceLabel(evidence);
  return (
    <div className="evidence" data-testid="read-evidence">
      <div className="row wrap">
        <Pill tone={tone}>{label}</Pill>
        <span className="small faint">
          tested {relativeTime(evidence.testedAt)} ({formatDate(evidence.testedAt)})
        </span>
      </div>
      <div className="small">{evidence.message}</div>
    </div>
  );
}

function Inventory({ inventory }: { inventory: IntegrationInventory | undefined }) {
  if (!inventory)
    return (
      <div className="small faint" data-testid="inventory">
        No tool inventory loaded. Load tools fetches the exact tool list; every tool stays denied
        until you choose it.
      </div>
    );
  return (
    <div className="stack" style={{ gap: 4 }} data-testid="inventory">
      <div className="row wrap">
        <Pill tone={inventoryTone[inventory.status]}>inventory {inventory.status}</Pill>
        <Pill plain>{inventory.scope.replaceAll("_", " ")}</Pill>
        <span className="small faint">
          {inventory.tools.length} {inventory.tools.length === 1 ? "tool" : "tools"}, loaded{" "}
          {relativeTime(inventory.checkedAt)}
        </span>
      </div>
      {inventory.status !== "loaded" && <div className="small">{inventory.message}</div>}
    </div>
  );
}

function InventoryTools({ inventory }: { inventory: IntegrationInventory }) {
  return (
    <>
      <dt>Inventory</dt>
      <dd data-testid="inventory-tools">
        <div>
          {inventory.message} Loaded {formatDate(inventory.checkedAt)}.
        </div>
        {inventory.tools.length > 0 ? (
          <ul className="plain-list" style={{ margin: 0, paddingLeft: 18 }}>
            {inventory.tools.map((tool) => (
              <li key={tool.name}>
                <span className="mono">{tool.name}</span>{" "}
                <span className="faint">schema {tool.schemaFingerprint.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="faint">No exact known tools were available.</span>
        )}
      </dd>
    </>
  );
}

function OAuthImport({
  connection,
  profiles,
  disabled,
  onImport,
}: {
  connection: IntegrationConnection;
  profiles: McpOAuthProfile[];
  disabled: boolean;
  onImport: (profileId: string) => void;
}) {
  const id = connection.definition.id;
  const matching = profiles.filter((profile) => profile.endpoint === connection.config.endpoint);
  const [profileId, setProfileId] = useState(matching[0]?.id ?? "");
  return (
    <div className="stack" style={{ gap: 6 }} data-testid={`oauth-import-${id}`}>
      {matching.length ? (
        <>
          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <div className="field grow">
              <label htmlFor={`oauth-profile-${id}`}>Supported OAuth profile</label>
              <select
                id={`oauth-profile-${id}`}
                className="select"
                value={profileId}
                disabled={disabled}
                onChange={(e) => setProfileId(e.target.value)}
              >
                {matching.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label} ({profile.id})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="button small"
              disabled={disabled || !profileId}
              onClick={() => onImport(profileId)}
            >
              Import OAuth metadata
            </button>
          </div>
          <span className="small faint">
            Imports only the discovered endpoint metadata for a reviewed profile; the source's
            login, token or session is never read or reused. The connection stays disabled with no
            grants until you discover, configure a client and connect explicitly.
          </span>
        </>
      ) : (
        <span className="small" style={{ color: "var(--warn)" }}>
          No reviewed OAuth profile matches endpoint{" "}
          <span className="mono">{connection.config.endpoint}</span>. This metadata cannot be
          imported; nothing runs from it.
        </span>
      )}
    </div>
  );
}

function BindForm({
  connection,
  catalog,
  disabled,
  onBind,
}: {
  connection: IntegrationConnection;
  catalog: IntegrationCatalog;
  disabled: boolean;
  onBind: (profileId: string, scope: string[]) => void;
}) {
  const id = connection.definition.id;
  const native = connection.config.native!;
  const profiles = catalog.profiles ?? [];
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [scopeText, setScopeText] = useState("");
  const scope = scopeText
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const scopeValid =
    scope.length >= 1 && scope.length <= 100 && scope.every((value) => scopeId.test(value));
  const bindable = native.support === "supported" && profiles.length > 0;
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="bind-form">
      {bindable ? (
        <>
          <div className="row wrap" style={{ alignItems: "flex-end" }}>
            <div className="field">
              <label htmlFor={`profile-${id}`}>Known profile</label>
              <select
                id={`profile-${id}`}
                className="select"
                value={profileId}
                disabled={disabled}
                onChange={(e) => setProfileId(e.target.value)}
              >
                {profiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} ({item.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="field grow">
              <label htmlFor={`scope-${id}`}>Document ids (1-100)</label>
              <input
                id={`scope-${id}`}
                className="input mono"
                placeholder="doc-1 doc-2"
                value={scopeText}
                disabled={disabled}
                aria-invalid={scopeText.trim() !== "" && !scopeValid}
                onChange={(e) => setScopeText(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="button small"
              disabled={disabled || !scopeValid || !profileId}
              onClick={() => onBind(profileId, scope)}
            >
              Bind profile and scope
            </button>
          </div>
          <span className="small faint">
            A known profile is reviewed protocol data, not server trust. Binding stores the exact
            document ids the connection may read, leaves it disabled with no tool grants, and
            contacts nothing.
          </span>
        </>
      ) : (
        <span className="small" style={{ color: "var(--warn)" }}>
          This entry cannot be bound to a known profile:{" "}
          {native.transport === "stdio"
            ? "local stdio would execute host code, which Isolated never starts. Use a separately supported Docker projection or explicit Dangerous native access instead."
            : native.message}
        </span>
      )}
    </div>
  );
}

function Connection({
  connection,
  catalog,
  busy,
  flowOpen,
  onOpen,
  onUpdate,
  onBind,
  onImportOAuth,
  onLoad,
  onTest,
  run,
  refresh,
}: {
  connection: IntegrationConnection;
  catalog: IntegrationCatalog;
  busy: string | null;
  flowOpen: boolean;
  onOpen: () => void;
  onUpdate: (patch: { enabled?: boolean; allowedTools?: string[] }, message: string) => void;
  onBind: (profileId: string, scope: string[]) => void;
  onImportOAuth: (profileId: string) => void;
  onLoad: () => void;
  onTest: () => void;
  run: OAuthRun;
  refresh: () => Promise<void>;
}) {
  const { config, definition } = connection;
  const id = definition.id;
  const native = config.native;
  const bound = config.readProvider;
  const oauthMetadata = native?.authentication === "app-owned-oauth";
  const oauthProfile = (catalog.oauthProfiles ?? []).find(
    (profile) => profile.id === config.oauthProfileId,
  );
  const oauth = connection.oauth && oauthProfile ? connection.oauth : undefined;
  const readSupported = oauth !== undefined && oauthReadSupported(catalog, connection);
  const readCopy = oauthReadCopy(connection);
  const supported = definition.supported;
  const supportLabel = native
    ? `${native.support} format`
    : supported
      ? "supported"
      : "unsupported";
  const formatUnsupported = native ? native.support !== "supported" : !supported;
  const allowed = new Set(config.allowedTools);
  const disabled = busy !== null;
  const profiles = catalog.profiles ?? [];
  const profile = profiles.find((item) => item.id === bound?.profileId);
  const summary = connectionSummary(catalog, connection);
  const toolState = (toolId: string) => connection.tools.find((tool) => tool.id === toolId);
  return (
    <div className="integration-card stack" style={{ gap: 8 }} data-testid={`connection-${id}`}>
      <div className="integration-head">
        <div className="integration-identity">
          <strong>{definition.label}</strong>
          <div className="integration-status" data-testid={`status-${id}`}>
            <Pill tone={summary.tone} live={summary.action === "Continue"}>
              {summary.label}
            </Pill>
            {summary.detail && <span className="small muted">{summary.detail}</span>}
          </div>
        </div>
        <button
          type="button"
          className={`button small${summary.action === "Connected" ? "" : " primary"}`}
          disabled={summary.disabled}
          onClick={onOpen}
          data-testid={`connect-${id}`}
        >
          {summary.action === "Connected" && <span aria-hidden="true">✓ </span>}
          {summary.action}
        </button>
      </div>
      {summary.problem && (
        <p className="small connection-problem" data-testid={`problem-${id}`}>
          {summary.problem}
        </p>
      )}
      <details className="integration-diagnostics" data-testid={`advanced-${id}`}>
        <summary>Advanced</summary>
        <div className="stack" style={{ gap: 8 }}>
          <div className="integration-pills">
            <Pill plain tone="neutral">
              {native
                ? `${formatLabel[native.format]} · ${harnessLabel[native.harness]}`
                : bound
                  ? "audited manifest"
                  : oauth
                    ? "app-owned provider"
                    : "custom"}
            </Pill>
            {formatUnsupported && (
              <Pill plain tone="warn">
                {supportLabel}
              </Pill>
            )}
            <Pill plain tone={statusTone[connection.status]}>
              {connection.status.replaceAll("_", " ")}
            </Pill>
          </div>
          <div className="small faint mono">{definition.identity}</div>
          <p className="small" style={{ margin: 0 }}>
            {connection.message}
          </p>
          {!flowOpen && native && !bound && oauthMetadata && !config.oauthProfileId && (
            <OAuthImport
              connection={connection}
              profiles={catalog.oauthProfiles ?? []}
              disabled={disabled}
              onImport={onImportOAuth}
            />
          )}
          {oauth && oauthProfile && (
            <OAuthPanel
              connection={connection}
              profile={oauthProfile}
              busy={busy}
              run={run}
              refresh={refresh}
              scopeReview={!flowOpen}
            />
          )}
          {!flowOpen && native && !bound && !oauthMetadata && (
            <BindForm
              connection={connection}
              catalog={catalog}
              disabled={disabled}
              onBind={onBind}
            />
          )}
          {(bound || oauth) && (
            <div className="stack" style={{ gap: 6 }}>
              <Inventory inventory={config.inventory} />
              <div className="row wrap" style={{ alignItems: "flex-start" }}>
                <button
                  type="button"
                  className="button small"
                  disabled={disabled}
                  onClick={onLoad}
                  data-testid={`load-${id}`}
                >
                  {busy === `${id}:load`
                    ? "Loading..."
                    : config.inventory
                      ? "Reload tools..."
                      : "Load tools..."}
                </button>
                <span className="small faint">
                  Authenticated connection-side inventory action; always resets enablement and
                  grants to denied.
                </span>
              </div>
            </div>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={disabled || !supported}
              onChange={(event) =>
                onUpdate(
                  { enabled: event.target.checked },
                  `${definition.label} ${event.target.checked ? "enabled" : "disabled"} for new sessions`,
                )
              }
            />
            <span>
              Enabled for review context{" "}
              {!supported && (
                <span className="small faint">
                  (unavailable: {definition.compatibilityMessage ?? "unsupported definition"})
                </span>
              )}
            </span>
          </label>
          <div className="integration-tools" aria-label={`${definition.label} allowed read tools`}>
            {definition.tools.map((tool) => {
              const state = toolState(tool.id);
              return (
                <label className="check-row" key={tool.id}>
                  <input
                    type="checkbox"
                    checked={allowed.has(tool.id)}
                    disabled={disabled || !supported}
                    onChange={(event) => {
                      const next = new Set(allowed);
                      if (event.target.checked) next.add(tool.id);
                      else next.delete(tool.id);
                      onUpdate(
                        { allowedTools: [...next] },
                        `${definition.label} ${tool.label} ${event.target.checked ? "allowed" : "removed"} for new sessions`,
                      );
                    }}
                  />
                  <span>
                    {tool.label}{" "}
                    <span className="mono small faint">{tool.toolNames.join(", ")}</span>{" "}
                    {state && (
                      <span className="small faint">
                        ({state.state}: {state.reason})
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            {!definition.tools.length && (
              <span className="small faint">
                {readSupported
                  ? config.inventory
                    ? `The loaded inventory contains none of the ${readCopy.tools}; unknown tools and readOnlyHint never grant access.`
                    : `No reviewed tools yet. Load tools fetches the ${readCopy.tools} from the authenticated connection; each stays denied until you grant it. No document profile binding is involved.`
                  : "No vetted tools for this connection. Bind a known profile first; unknown tools and readOnlyHint never grant access."}
              </span>
            )}
            {bound?.profileId && profile && supported && (
              <div className="row wrap" style={{ alignItems: "flex-start" }}>
                <button
                  type="button"
                  className="button small ghost"
                  disabled={disabled}
                  onClick={() =>
                    onUpdate(
                      { allowedTools: profile.preset.allowedTools },
                      `${definition.label}: preset ${profile.preset.label} applied for new sessions`,
                    )
                  }
                >
                  Use preset: {profile.preset.label}
                </button>
                <span className="small faint">
                  Optional explicit tool list; it does not enable the connection.
                </span>
              </div>
            )}
          </div>
          <div className="small faint">
            Effective for new sessions: <strong>{connection.effective.replaceAll("_", " ")}</strong>
            .
          </div>
          <div className="row wrap" style={{ alignItems: "flex-start" }}>
            <button
              type="button"
              className="button small"
              disabled={disabled}
              onClick={onTest}
              data-testid={`test-${id}`}
            >
              {busy === `${id}:test` ? "Testing..." : "Test connection..."}
            </button>
            <span className="small faint">
              {oauth
                ? readSupported
                  ? readCopy.testHint
                  : "This OAuth profile has no vetted read adapter yet, so Test reports unsupported local configuration without any content request."
                : bound
                  ? "Separate explicit bounded read, independent of enablement and grants."
                  : "Nothing is bound, so the test reports local configuration only and contacts nothing."}
            </span>
          </div>
          {connection.evidence && <Evidence evidence={connection.evidence} />}
          <div className="stack" style={{ gap: 8 }} data-testid={`diagnostics-${id}`}>
            <dl className="kv small">
              {!formatUnsupported && (
                <>
                  <dt>Support</dt>
                  <dd>{supportLabel}</dd>
                </>
              )}
              {native && (
                <>
                  <dt>Native entry</dt>
                  <dd>
                    <span className="mono">{native.name}</span> in{" "}
                    <span className="mono">{native.path}</span>
                  </dd>
                  <dt>Transport</dt>
                  <dd className="mono">{native.transport}</dd>
                  <dt>Source digest</dt>
                  <dd className="mono">{native.digest.slice(0, 12)}</dd>
                  {oauthMetadata && (
                    <>
                      <dt>Authentication</dt>
                      <dd>app-owned OAuth metadata</dd>
                    </>
                  )}
                  <dd className="faint" style={{ gridColumn: "1 / -1" }}>
                    {native.message} Header values are never stored or shown.
                  </dd>
                </>
              )}
              {bound && (
                <>
                  {bound.profileId ? (
                    <>
                      <dt>Profile</dt>
                      <dd>
                        <span className="mono">{bound.profileId}</span>, scope{" "}
                        {bound.scope?.length ?? 0} document id{bound.scope?.length === 1 ? "" : "s"}{" "}
                        (<span className="mono">{bound.scope?.join(", ")}</span>)
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>Manifest</dt>
                      <dd>
                        <span className="mono">{bound.path}</span> entry{" "}
                        <span className="mono">{bound.entryId}</span>
                      </dd>
                    </>
                  )}
                  <dt>Binding digest</dt>
                  <dd className="mono">{bound.digest.slice(0, 12)}</dd>
                  <dt>Auth</dt>
                  <dd>{authLabel[definition.authReuse]}</dd>
                </>
              )}
              {bound?.profileId && profile && (
                <>
                  <dt>Preset</dt>
                  <dd>
                    {profile.preset.label}:{" "}
                    <span className="mono">{profile.preset.allowedTools.join(", ")}</span>
                  </dd>
                </>
              )}
              {config.inventory && <InventoryTools inventory={config.inventory} />}
              <dt>Policy</dt>
              <dd>
                New or changed tools default denied; captured sessions keep their own policy.
                Gateway boundary {catalog.boundary.status}: capability only, not OS containment.
                {oauth &&
                  " Load tools uses the app-owned OAuth token over Streamable HTTP; a loaded inventory grants nothing."}
              </dd>
              <dt>Test evidence</dt>
              <dd>
                Point-in-time result at its timestamp, non-mutating, containment not verified. It is
                not a login, a permission grant or ongoing availability, and it is forgotten on
                restart or after changed-definition discovery, binding or Load tools.
                {oauth && readSupported && readCopy.diagnostic}
              </dd>
            </dl>
            {oauth && oauthProfile && (
              <OAuthDiagnostics connection={connection} profile={oauthProfile} />
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

export function ConnectionSettings({ catalog }: { catalog: IntegrationCatalog }) {
  const { state, setState, refresh, oauthReturn, consumeOAuthReturn } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [harness, setHarness] = useState<HarnessId>("claude");
  const [sourcePath, setSourcePath] = useState("");
  const [discoveryResult, setDiscoveryResult] = useState<string | null>(null);
  const [manifestPath, setManifestPath] = useState("");
  const [providerId, setProviderId] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "load" | "test"; id: string } | null>(null);
  const [flow, setFlow] = useState<{ id: string; auto: boolean } | null>(null);
  const connections = catalog.connections;
  const flowConnection = flow
    ? connections.find((item) => item.definition.id === flow.id)
    : undefined;

  const openFlow = (id: string, auto: boolean) => {
    setError(null);
    setFlow({ id, auto });
  };
  const closeFlow = useCallback(() => setFlow(null), []);

  useEffect(() => {
    if (
      oauthReturn?.kind === "ready" &&
      connections.some((item) => item.definition.id === oauthReturn.connectionId)
    )
      setFlow({ id: oauthReturn.connectionId, auto: true });
  }, [oauthReturn]);

  const apply: Apply = async (key, run, message) => {
    setBusy(key);
    setError(null);
    try {
      const next = await run();
      setState({ ...state, integrations: next });
      toast(message);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const run: OAuthRun = async (key, action, message) => {
    setBusy(key);
    setError(null);
    try {
      const result = await action();
      if (message) toast(message);
      return result;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const discover = (event: FormEvent) => {
    event.preventDefault();
    const path = sourcePath.trim();
    setDiscoveryResult(null);
    void apply(
      "discover",
      async () => {
        const next = await api.discoverIntegrations({ harness, ...(path ? { path } : {}) });
        const added = next.connections.filter(
          (item) => !connections.some((previous) => previous.config.id === item.config.id),
        ).length;
        const changed = next.connections.filter((item) => {
          const previous = connections.find((entry) => entry.config.id === item.config.id);
          return (
            previous &&
            JSON.stringify(previous.config.native) !== JSON.stringify(item.config.native)
          );
        }).length;
        setDiscoveryResult(
          `${added} new connection${added === 1 ? "" : "s"} added; ${changed} changed definition${changed === 1 ? "" : "s"} replaced. Unchanged saved connections were preserved, not newly discovered. New or replaced definitions have no grants. No authentication or read readiness was tested.`,
        );
        return next;
      },
      "Native configuration checked",
    );
  };

  const test = async (id: string) => {
    setConfirm(null);
    const connection = connections.find((item) => item.definition.id === id);
    if (!connection) return;
    setBusy(`${id}:test`);
    setError(null);
    try {
      const result = await api.testIntegration(id);
      setState({
        ...state,
        integrations: {
          ...catalog,
          connections: catalog.connections.map((item) =>
            item.definition.id === id ? { ...item, evidence: result } : item,
          ),
        },
      });
      const { tone, label } = evidenceLabel(result);
      toast(`${connection.definition.label}: ${label}`, tone === "ok" ? "ok" : "warn");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const load = (id: string) => {
    setConfirm(null);
    void apply(
      `${id}:load`,
      () => api.loadIntegrationTools(id),
      "Tool inventory loaded; enablement and grants were reset to denied",
    );
  };

  const importManifest = (event: FormEvent) => {
    event.preventDefault();
    void apply(
      "import-read",
      async () => {
        const next = await api.importReadProviders(manifestPath.trim());
        setManifestPath("");
        return next;
      },
      "Read-provider manifest imported; entries stay disabled until you enable them",
    );
  };

  const confirming = confirm
    ? connections.find((item) => item.definition.id === confirm.id)
    : undefined;
  const pathPlaceholder =
    harness === "claude"
      ? "optional: defaults to $HOME/.claude.json"
      : harness === "codex"
        ? "optional: defaults to CODEX_HOME/config.toml"
        : "unsupported";

  return (
    <section className="card" aria-labelledby="integration-controls-h">
      <div className="card-head">
        <div>
          <h2 id="integration-controls-h">Connections</h2>
          <div className="small faint">
            Read-only business context for Isolated and Docker reviews. Connected means signed in;
            reviews read only what you allow.
          </div>
        </div>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {error && !flow && <Notice tone="danger">{error}</Notice>}
        {oauthReturn?.kind === "unavailable" && (
          <Notice
            tone="warn"
            title="The OAuth review return could not be continued."
            actions={
              <button type="button" className="button small" onClick={consumeOAuthReturn}>
                Dismiss
              </button>
            }
          >
            The one-use return was already used, expired, cancelled, belongs to another browser or
            generation, or no longer matches this app. This return itself accepted, persisted,
            replayed, refreshed or revoked nothing, and it neither proves nor rules out an earlier
            admission: an exact or assumed requested set may already be authenticated, or additional
            capabilities may already have been explicitly accepted. This failed return changes
            neither, and it does not expire a still-pending disclosure. The OAuth status below is
            authoritative after Refresh status. Use the controls below: Refresh status, Review
            returned OAuth capabilities while the disclosure is still available, Cancel
            authorization, or an explicit new Connect.
          </Notice>
        )}
        {catalog.boundary.status !== "available" && (
          <Notice tone="warn" title="Gateway boundary.">
            {catalog.boundary.message}
          </Notice>
        )}
        <form
          className="stack"
          style={{ gap: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            void apply(
              "add-provider",
              () => api.addOAuthIntegration(providerId),
              "Provider added; choose Connect to sign in. No reads were granted.",
            );
          }}
        >
          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <div className="field grow">
              <label htmlFor="connection-provider">Add a provider</label>
              <select
                id="connection-provider"
                className="input"
                value={providerId}
                disabled={busy !== null}
                onChange={(event) => setProviderId(event.target.value)}
              >
                <option value="">Choose a provider</option>
                {(catalog.oauthProfiles ?? []).map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="button small"
              disabled={
                busy !== null ||
                !providerId ||
                connections.some((item) => item.config.id === `oauth:${providerId}`)
              }
            >
              {busy === "add-provider" ? "Adding..." : "Add provider"}
            </button>
          </div>
          <span className="small faint">
            No native MCP configuration needed. Claude built-in connectors are not discovered or
            shared with this app. Add only saves the provider here; Connect requires separate app
            authorization, then you explicitly choose read access. Nothing is signed in or granted
            by adding it.
          </span>
        </form>
        <form className="stack" style={{ gap: 8 }} onSubmit={discover} data-testid="discover">
          <div className="field">
            <span className="field-label">Discover existing native MCP configuration</span>
            <Segmented
              label="Native source"
              value={harness}
              disabled={busy !== null}
              options={(["claude", "codex", "pi"] as HarnessId[]).map((value) => ({
                value,
                label: harnessLabel[value],
              }))}
              onChange={setHarness}
            />
          </div>
          {harness === "pi" ? (
            <Notice tone="warn" title="Pi has no supported native MCP format.">
              Executable Pi MCP extensions are never imported. Discover from a Claude JSON or Codex
              TOML source instead; Pi reviewers can still use connections bound here.
            </Notice>
          ) : (
            <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
              <div className="field grow">
                <label htmlFor="native-source">Absolute source path</label>
                <input
                  id="native-source"
                  className="input mono"
                  value={sourcePath}
                  placeholder={pathPlaceholder}
                  disabled={busy !== null}
                  onChange={(e) => setSourcePath(e.target.value)}
                />
              </div>
              <button
                type="submit"
                className="button small"
                disabled={
                  busy !== null || (sourcePath.trim() !== "" && !sourcePath.trim().startsWith("/"))
                }
              >
                {busy === "discover" ? "Discovering..." : "Discover connections"}
              </button>
            </div>
          )}
          <span className="small faint">
            Reads only that file's {harness === "codex" ? "mcp_servers TOML" : "mcpServers JSON"}{" "}
            entries. It never starts stdio, contacts servers or resolves auth stores; inline header
            values are parsed and discarded. Unchanged connections keep their credentials, grants
            and Test evidence. Changed definitions require new setup; configured OAuth must be
            explicitly disconnected before replacement. This does not scan installed plugins,
            app-owned profiles or native logins. A plugin MCP file must be selected explicitly.
          </span>
        </form>
        {discoveryResult && <Notice title="Discovery result">{discoveryResult}</Notice>}
        {connections.length === 0 && (
          <p className="small faint" style={{ margin: 0 }} data-testid="no-connections">
            No connections yet. Add a provider above, discover an existing native configuration, or
            import an audited manifest under Advanced.
          </p>
        )}
        {connections.map((connection) => (
          <Connection
            key={connection.definition.id}
            connection={connection}
            catalog={catalog}
            busy={busy}
            flowOpen={flow?.id === connection.definition.id}
            onOpen={() =>
              openFlow(
                connection.definition.id,
                connectionSummary(catalog, connection).action !== "Connected",
              )
            }
            onUpdate={(patch, message) =>
              void apply(
                connection.definition.id,
                () => api.updateIntegration(connection.definition.id, patch),
                message,
              )
            }
            onBind={(profileId, scope) =>
              void apply(
                `${connection.definition.id}:bind`,
                () =>
                  api.importNativeIntegration({ id: connection.definition.id, profileId, scope }),
                "Profile and scope bound; the connection stays disabled with no tool grants",
              )
            }
            onImportOAuth={(profileId) =>
              void apply(
                `${connection.definition.id}:import-oauth`,
                () => api.importOAuthIntegration({ id: connection.definition.id, profileId }),
                "OAuth metadata imported; the connection stays disabled with no grants and nothing was authenticated",
              )
            }
            onLoad={() => setConfirm({ kind: "load", id: connection.definition.id })}
            onTest={() => setConfirm({ kind: "test", id: connection.definition.id })}
            run={run}
            refresh={refresh}
          />
        ))}
        <details>
          <summary className="small">Advanced: import an audited read-provider manifest</summary>
          <form
            className="row"
            style={{ gap: 8, alignItems: "flex-end", marginTop: 6 }}
            onSubmit={importManifest}
          >
            <div className="field grow">
              <label htmlFor="read-manifest">Manifest path (absolute)</label>
              <input
                id="read-manifest"
                className="input mono"
                value={manifestPath}
                placeholder="/absolute/path/to/read-providers.json"
                onChange={(e) => setManifestPath(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="button small"
              disabled={busy !== null || !manifestPath.trim().startsWith("/")}
            >
              {busy === "import-read" ? "Importing..." : "Import manifest"}
            </button>
          </form>
          <p className="small faint" style={{ margin: "6px 0 0" }}>
            Optional supported path for the audited GitHub, Linear, Notion and vetted document host
            providers with bounded auth references (EXECUTION_BOUNDARY.md). No secret is typed here
            and no store is rewritten. It is not native MCP or OAuth parity with those services and
            is not needed for the native discovery flow above.
          </p>
        </details>
      </div>
      {flow && flowConnection && (
        <ConnectFlow
          key={flow.id}
          connection={flowConnection}
          catalog={catalog}
          auto={flow.auto}
          busy={busy}
          error={error}
          run={run}
          apply={apply}
          refresh={refresh}
          profileForm={
            <OAuthImport
              connection={flowConnection}
              profiles={catalog.oauthProfiles ?? []}
              disabled={busy !== null}
              onImport={(profileId) =>
                void apply(
                  `${flow.id}:import-oauth`,
                  () => api.importOAuthIntegration({ id: flow.id, profileId }),
                  "Provider settings imported; nothing was signed in or granted",
                )
              }
            />
          }
          bindForm={
            <BindForm
              connection={flowConnection}
              catalog={catalog}
              disabled={busy !== null}
              onBind={(profileId, scope) =>
                void apply(
                  `${flow.id}:bind`,
                  () => api.importNativeIntegration({ id: flow.id, profileId, scope }),
                  "Profile and documents saved; review access is still off",
                )
              }
            />
          }
          reviewReturn={oauthReturn}
          onReviewReturnConsumed={consumeOAuthReturn}
          onClose={closeFlow}
        />
      )}
      {confirm && confirming && (
        <Modal
          title={
            confirm.kind === "load"
              ? `Load tools for ${confirming.definition.label}`
              : `Test ${confirming.definition.label}`
          }
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => (confirm.kind === "load" ? load(confirm.id) : void test(confirm.id))}
              >
                {confirm.kind === "load" ? "Load tools" : "Run test"}
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 8 }}>
            {confirm.kind === "load" ? (
              <>
                <p style={{ margin: 0 }}>
                  Contacts <span className="mono">{confirming.definition.identity}</span> with the
                  connection-side credential to list its exact tools. This is authenticated
                  inventory access on the connection's side.
                </p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Reads no resources and grants no permission.</li>
                  <li>
                    Always resets this connection to disabled with every tool denied, including an
                    unchanged reload.
                  </li>
                  <li>Loaded, changed or error inventory is never connection evidence.</li>
                </ul>
              </>
            ) : confirming.config.oauthProfileId === "notion-mcp/1" ? (
              <>
                <p style={{ margin: 0 }}>{oauthReadCopy(confirming).testHint}</p>
                <p style={{ margin: 0 }}>{oauthReadCopy(confirming).testRequirement}</p>
                <p style={{ margin: 0 }}>
                  This grants nothing and is not live document-read evidence. Read readiness is
                  established only by a successful explicitly granted fetch of a specified document.
                </p>
              </>
            ) : oauthReadSupported(catalog, confirming) ? (
              <>
                <p style={{ margin: 0 }}>
                  Sends {oauthReadCopy(confirming).testRequest}
                  {confirming.config.oauthProfileId !== "axiom-mcp/1" && (
                    <>
                      {" "}
                      for the fixed quoted query{" "}
                      <span className="mono">"pr-review connection test"</span> with limit 1
                    </>
                  )}{" "}
                  to <span className="mono">{confirming.definition.identity}</span> using the
                  app-owned OAuth credential.
                </p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>{oauthReadCopy(confirming).testRequirement}</li>
                  <li>
                    May use the connection's normal app-owned token refresh. It never logs in,
                    widens permissions, changes inventory or grants anything.
                  </li>
                  <li>
                    Relies on provider access controls; it does not independently verify{" "}
                    {oauthReadCopy(confirming).unverified}.
                  </li>
                  <li>
                    Only a live read that succeeds passes; synthetic or local results are not live
                    reads.
                  </li>
                </ul>
              </>
            ) : (
              <>
                <p style={{ margin: 0 }}>
                  Performs one bounded read of the first scoped resource (GitHub: the identity
                  endpoint) using the connection-side credential.
                </p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Independent of enablement and tool grants; it grants nothing.</li>
                  <li>Does not log in, refresh or approve inventory.</li>
                  <li>
                    Only a live read that succeeds counts as Connected at that time; synthetic or
                    local results stay disconnected.
                  </li>
                </ul>
              </>
            )}
            <p className="small faint" style={{ margin: 0 }}>
              Cancel sends nothing.
            </p>
          </div>
        </Modal>
      )}
    </section>
  );
}

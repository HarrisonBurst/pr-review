import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  OAuthError,
  OAuthErrorCode,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import * as oauth from "oauth4webapi";
import type {
  McpClientAuthMethod,
  McpOAuthConfigureRequest,
  McpOAuthConnectResult,
  McpOAuthDiscovery,
  McpOAuthProfile,
  McpOAuthRegistrationRequest,
  McpOAuthScopePreview,
  McpOAuthScopeApproval,
  McpOAuthReviewReturnRequest,
  McpOAuthReviewReturn,
  McpOAuthStatus,
  IntegrationInventory,
  McpOAuthBinding,
} from "../shared/contracts.js";
import {
  CredentialStoreError,
  MacKeychainStore,
  type CredentialStore,
} from "./credential-store.js";
import {
  guardedFetch,
  publicHttps,
  type GuardedFetch,
  type GuardedFetchDiagnostic,
} from "./guarded-fetch.js";
import { digest } from "./execution/policy.js";
import {
  decodeOAuthScopes,
  localScopeAdmission,
  OAuthScopeError,
} from "./mcp-oauth-scopes.js";
import { oauthMcpProfiles } from "./mcp-profiles.js";
import { remoteMcp, inventoryIdentity } from "./mcp-remote.js";
import { canonicalJson, validateSchema } from "./schema.js";
import { fingerprintToolSchema } from "./integrations.js";
import { oauthReadAdapter } from "./oauth-reads.js";
import {
  listenOAuthCallback,
  oauthRedirect,
  OAuthCallbackError,
} from "./mcp-loopback.js";

interface RecordState {
  id: string;
  profileId: string;
  profileDigest: string;
  reference: string;
  generation: string;
  state: McpOAuthStatus["state"];
  discovery?: McpOAuthDiscovery;
  metadata?: AuthorizationServerMetadata & { revocation_endpoint?: string };
  clientId?: string;
  method?: McpClientAuthMethod;
  redirectUri?: string;
  callbackMode?: McpOAuthStatus["callbackMode"];
  scopes: string[];
  pending: boolean;
  remoteRevocation: McpOAuthStatus["remoteRevocation"];
}
interface Credentials {
  client: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
}
interface Transaction {
  id: string;
  generation: string;
  state: string;
  browser: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  stop?: () => void;
  receipt?: string;
  receiptExpiresAt?: number;
  receiptTimer?: ReturnType<typeof setTimeout>;
  response?: URLSearchParams;
  consumed?: boolean;
  review?: {
    preview: McpOAuthScopePreview;
    credentials?: Credentials;
    returned?: boolean;
  };
}

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

class TokenValidationError extends Error {
  constructor(
    readonly category:
      | "token_type"
      | "access_token"
      | "refresh_token"
      | "token_expiry"
      | "token_scope",
  ) {
    super(
      category === "token_scope"
        ? "OAuth scope changed; new consent and grants required"
        : "Unsupported OAuth token type or expiry",
    );
  }
}

type OAuthDiagnosticPhase =
  | "callback_validated"
  | "client_read"
  | "source_validation"
  | "guarded_transport"
  | "sdk_exchange"
  | "token_validation"
  | "credential_persistence"
  | "identity_probe";

export type McpOAuthDiagnostic =
  | GuardedFetchDiagnostic
  | {
      phase: OAuthDiagnosticPhase;
      outcome: "started" | "succeeded" | "failed";
      category?:
        | OAuthErrorCode
        | TokenValidationError["category"]
        | OAuthScopeError["code"]
        | "invalid_json"
        | "credential_store_unavailable"
        | "unclassified";
    }
  | { phase: "synthetic_response"; status: number };

export class McpOAuth {
  validateSource?: (id: string) => Promise<void>;
  onDiagnostic?: (event: McpOAuthDiagnostic) => void;
  private closed = false;
  private readonly transactions = new Map<string, Transaction>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly aborts = new Map<string, Set<AbortController>>();

  constructor(
    private readonly db: DatabaseSync,
    readonly redirectUri: string,
    private readonly store: CredentialStore = new MacKeychainStore(),
    private readonly profiles: McpOAuthProfile[] = oauthMcpProfiles,
    private readonly fixtureFetch?: GuardedFetch,
    readonly synthetic = false,
  ) {
    if (fixtureFetch && !synthetic)
      throw new Error("Injected OAuth transport must be labeled synthetic");
    const redirect = new URL(redirectUri);
    if (
      redirect.protocol !== "http:" ||
      redirect.hostname !== "127.0.0.1" ||
      redirect.pathname !== "/api/mcp/oauth/callback" ||
      redirect.search ||
      redirect.hash ||
      redirect.username ||
      redirect.password
    )
      throw new Error(
        "MCP OAuth requires the exact app-owned IPv4 loopback callback",
      );
    db.exec(
      "CREATE TABLE IF NOT EXISTS mcp_oauth (id TEXT PRIMARY KEY, state_json TEXT NOT NULL)",
    );
    for (const row of db.prepare("SELECT state_json FROM mcp_oauth").all()) {
      const state = JSON.parse(String(row.state_json)) as RecordState;
      if (
        state.pending ||
        state.state === "authorizing" ||
        (state.callbackMode === "app" && state.redirectUri !== redirectUri)
      ) {
        state.state = "reconnect_required";
        this.save(state);
      }
    }
  }

  get appOrigin() {
    return new URL(this.redirectUri).origin;
  }

  private forget(transaction: Transaction) {
    clearTimeout(transaction.timer);
    clearTimeout(transaction.receiptTimer);
    transaction.stop?.();
    this.transactions.delete(transaction.state);
  }

  private expire(transaction: Transaction) {
    this.forget(transaction);
    const state = this.read(transaction.id);
    if (
      state.generation === transaction.generation &&
      state.state === "authorizing"
    ) {
      this.cancel(state.id);
      state.generation = this.read(state.id).generation;
      state.state = "reconnect_required";
      this.save(state);
    }
  }

  private arm(transaction: Transaction, milliseconds: number) {
    clearTimeout(transaction.timer);
    transaction.expiresAt = Math.min(
      transaction.expiresAt,
      Date.now() + milliseconds,
    );
    transaction.timer = setTimeout(
      () => this.expire(transaction),
      transaction.expiresAt - Date.now(),
    );
    transaction.timer.unref();
  }

  private profile(id: string) {
    const profile = this.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("Unsupported MCP OAuth profile");
    return profile;
  }

  private read(id: string): RecordState {
    const row = this.db
      .prepare("SELECT state_json FROM mcp_oauth WHERE id = ?")
      .get(id);
    if (!row) throw new Error("Import a supported OAuth connection first");
    const state = JSON.parse(String(row.state_json)) as RecordState;
    return state;
  }

  private save(state: RecordState) {
    this.db
      .prepare(
        "INSERT INTO mcp_oauth (id, state_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json",
      )
      .run(state.id, JSON.stringify(state));
  }

  private current(state: RecordState) {
    if (this.closed) throw new Error("MCP authentication manager is closing");
    if (
      state.profileDigest !==
      digest(JSON.stringify(this.profile(state.profileId)))
    )
      throw new Error(
        "MCP profile changed; disconnect and explicitly re-import before granting tools",
      );
    if (this.read(state.id).generation !== state.generation)
      throw new Error("MCP connection authority changed; operation cancelled");
  }

  private exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const promise = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    this.locks.set(id, promise);
    void promise
      .finally(() => {
        if (this.locks.get(id) === promise) this.locks.delete(id);
      })
      .catch(() => {});
    return promise;
  }

  private report(event: McpOAuthDiagnostic) {
    try {
      this.onDiagnostic?.(event);
    } catch {}
  }

  private async observed<T>(
    phase: OAuthDiagnosticPhase,
    action: () => T | Promise<T>,
    enabled = true,
  ): Promise<T> {
    if (!enabled) return action();
    this.report({ phase, outcome: "started" });
    try {
      const result = await action();
      this.report({ phase, outcome: "succeeded" });
      return result;
    } catch (error) {
      const category =
        error instanceof TokenValidationError
          ? error.category
          : error instanceof OAuthScopeError
            ? error.code
            : error instanceof OAuthError &&
                Object.values(OAuthErrorCode).includes(
                  error.code as OAuthErrorCode,
                )
              ? (error.code as OAuthErrorCode)
              : error instanceof SyntaxError
                ? "invalid_json"
                : error instanceof CredentialStoreError
                  ? "credential_store_unavailable"
                  : "unclassified";
      this.report({ phase, outcome: "failed", category });
      throw error;
    }
  }

  private async bounded<T>(
    state: RecordState,
    action: (fetch: GuardedFetch) => Promise<T>,
    diagnose = false,
  ): Promise<T> {
    this.current(state);
    if (this.validateSource)
      await this.observed(
        "source_validation",
        () => this.validateSource!(state.id),
        diagnose,
      );
    this.current(state);
    const controller = new AbortController();
    const owned = this.aborts.get(state.id) ?? new Set();
    this.aborts.set(state.id, owned);
    owned.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    const profile = this.profile(state.profileId);
    const base =
      this.fixtureFetch ??
      guardedFetch(
        profile.origins,
        signal,
        diagnose ? (event) => this.report(event) : undefined,
      );
    const fetch: GuardedFetch = async (url, init = {}) => {
      const target = publicHttps(url);
      if (!profile.origins.includes(target.origin))
        throw new Error("OAuth destination is outside the approved profile");
      this.current(state);
      if (this.validateSource)
        await this.observed(
          "source_validation",
          () => this.validateSource!(state.id),
          diagnose,
        );
      this.current(state);
      signal.throwIfAborted();
      const response = await this.observed(
        "guarded_transport",
        () =>
          base(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any([
              signal,
              ...(init.signal ? [init.signal] : []),
            ]),
          }),
        diagnose,
      );
      if (diagnose && this.fixtureFetch)
        this.report({ phase: "synthetic_response", status: response.status });
      this.current(state);
      if (response.status >= 300 && response.status < 400)
        throw new Error("OAuth redirects are denied");
      return response;
    };
    try {
      const result = await action(fetch);
      this.current(state);
      return result;
    } finally {
      owned.delete(controller);
    }
  }

  assertReplaceable(id: string): void {
    if (!this.db.prepare("SELECT id FROM mcp_oauth WHERE id = ?").get(id))
      return;
    const existing = this.read(id);
    if (
      existing.clientId ||
      existing.pending ||
      ["authenticated", "authorizing"].includes(existing.state)
    )
      throw new Error(
        "Disconnect before explicitly replacing an OAuth connection",
      );
  }

  import(id: string, profileId: string): McpOAuthStatus {
    this.assertReplaceable(id);
    const profile = this.profile(profileId);
    this.save({
      id,
      profileId,
      profileDigest: digest(JSON.stringify(profile)),
      reference: `mcp:${randomUUID()}`,
      generation: randomUUID(),
      state: "needs_discovery",
      scopes: [],
      pending: false,
      remoteRevocation: "not_attempted",
    });
    return this.status(id);
  }

  status(id: string): McpOAuthStatus {
    const state = this.read(id);
    const changed = !this.profiles.some(
      (profile) =>
        profile.id === state.profileId &&
        digest(JSON.stringify(profile)) === state.profileDigest,
    );
    const review = [...this.transactions.values()].find(
      (item) =>
        item.id === id &&
        item.generation === state.generation &&
        item.expiresAt > Date.now(),
    )?.review?.preview;
    return {
      profileId: state.profileId,
      configured: Boolean(state.clientId),
      authenticated: !changed && state.state === "authenticated",
      evidence: this.synthetic
        ? "synthetic_transport"
        : state.state === "authenticated"
          ? "live_authentication"
          : "local_configuration",
      storage: this.synthetic
        ? "synthetic"
        : process.platform === "darwin"
          ? "macos-keychain"
          : "unsupported",
      state: changed ? "reconnect_required" : state.state,
      message: changed
        ? "Profile changed. Disconnect and explicitly re-import; historical grants remain unchanged and cannot authorize new calls."
        : state.state === "authenticated"
          ? "OAuth authenticated. Provider access controls apply; no tools are enabled by authentication. Independent identity and channel isolation are not claimed."
          : review?.status === "approval_required"
            ? "Additional credential capabilities need exact local approval. Authentication and read permissions remain disabled."
            : review?.status === "missing_required"
              ? "Required permissions are missing. View the local scope disclosure; additional capabilities cannot replace them."
              : state.state === "reconnect_required"
                ? "Reconnect required. Expired, interrupted or ambiguous authentication cannot be retried during a review."
                : "Explicit discovery, client configuration and Connect are separate from read permissions and Test.",
      ...(state.discovery ? { discovery: state.discovery } : {}),
      ...(state.clientId
        ? { clientId: state.clientId, clientAuthMethod: state.method }
        : {}),
      redirectUri: state.redirectUri ?? this.redirectUri,
      appRedirectUri: this.redirectUri,
      callbackMode: state.callbackMode ?? "app",
      scopes: state.scopes,
      generation: state.generation,
      identity: null,
      remoteRevocation: state.remoteRevocation,
      ...(!changed && review
        ? {
            scopeReview: { status: review.status, expiresAt: review.expiresAt },
          }
        : {}),
    };
  }

  async discover(id: string): Promise<McpOAuthStatus> {
    return this.exclusive(id, async () => {
      const state = this.read(id);
      if (state.state === "authenticated" || state.state === "authorizing")
        throw new Error("Disconnect before changing OAuth discovery bindings");
      const profile = this.profile(state.profileId);
      try {
        await this.bounded(state, async (fetchFn) => {
          const resource = await discoverOAuthProtectedResourceMetadata(
            profile.endpoint,
            {
              protocolVersion: "2025-11-25",
              resourceMetadataUrl: profile.resourceMetadataUrl
                ? new URL(profile.resourceMetadataUrl)
                : undefined,
            },
            fetchFn,
          );
          if (
            resource.resource !== profile.resource ||
            resource.authorization_servers?.length !== 1 ||
            !profile.issuers.includes(resource.authorization_servers[0])
          )
            throw new Error("OAuth resource or issuer mismatch");
          const metadata = await discoverAuthorizationServerMetadata(
            resource.authorization_servers[0],
            { fetchFn, protocolVersion: "2025-11-25" },
          );
          if (
            !metadata ||
            !metadata.authorization_endpoint ||
            !metadata.token_endpoint ||
            !metadata.code_challenge_methods_supported?.includes("S256") ||
            !metadata.response_types_supported?.includes("code") ||
            (metadata.grant_types_supported &&
              !metadata.grant_types_supported.includes("authorization_code"))
          )
            throw new Error(
              "Unsupported OAuth authorization-code/PKCE metadata",
            );
          const revocation =
            "revocation_endpoint" in metadata &&
            typeof metadata.revocation_endpoint === "string"
              ? metadata.revocation_endpoint
              : undefined;
          for (const endpoint of [
            metadata.authorization_endpoint,
            metadata.token_endpoint,
            metadata.registration_endpoint,
            revocation,
          ])
            if (
              endpoint &&
              (!profile.origins.includes(
                publicHttps(String(endpoint)).origin,
              ) ||
                new URL(String(endpoint)).search)
            )
              throw new Error(
                "OAuth metadata endpoint is outside the approved destination policy",
              );
          const methods = profile.clientAuthMethods.filter((method) =>
            metadata.token_endpoint_auth_methods_supported?.includes(method),
          );
          if (!methods.length)
            throw new Error(
              "No explicitly advertised supported client authentication method",
            );
          const publicClientPolicy =
            profile.id === "slack-mcp/1" &&
            profile.publicClientPolicy === "slack-pkce" &&
            profile.clientAuthMethods.includes("none") &&
            !methods.includes("none")
              ? profile.publicClientPolicy
              : undefined;
          const clean: NonNullable<RecordState["metadata"]> = {
            issuer: metadata.issuer,
            authorization_endpoint: metadata.authorization_endpoint,
            token_endpoint: metadata.token_endpoint,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: metadata.grant_types_supported?.filter(
              (grant) =>
                ["authorization_code", "refresh_token"].includes(grant),
            ),
            token_endpoint_auth_methods_supported: methods,
            ...(metadata.authorization_response_iss_parameter_supported === true
              ? { authorization_response_iss_parameter_supported: true }
              : {}),
            ...(profile.dynamicRegistration && metadata.registration_endpoint
              ? { registration_endpoint: metadata.registration_endpoint }
              : {}),
            ...(revocation ? { revocation_endpoint: revocation } : {}),
          };
          state.metadata = clean;
          const discovery = {
            checkedAt: new Date().toISOString(),
            issuer: clean.issuer,
            resource: profile.resource,
            authorizationEndpoint: clean.authorization_endpoint!,
            clientAuthMethods: publicClientPolicy
              ? [...methods, "none" as const]
              : methods,
            advertisedClientAuthMethods: methods,
            ...(publicClientPolicy ? { publicClientPolicy } : {}),
            dynamicRegistration: Boolean(clean.registration_endpoint),
            scopes: profile.readScopes.filter(
              (scope) =>
                (resource.scopes_supported?.includes(scope) ||
                  (profile.id === "axiom-mcp/1" &&
                    resource.scopes_supported === undefined &&
                    metadata.scopes_supported?.includes(scope))) &&
                (!metadata.scopes_supported ||
                  metadata.scopes_supported.includes(scope)),
            ),
          };
          state.discovery = {
            ...discovery,
            digest: digest(
              JSON.stringify({
                profile,
                metadata: clean,
                scopes: discovery.scopes,
              }),
            ),
          };
        });
        this.current(state);
        state.state = state.clientId ? "disconnected" : "needs_client";
        this.save(state);
        return this.status(id);
      } catch {
        throw new Error(
          "OAuth discovery failed or is unsupported. Check profile issuer/resource, public HTTPS destinations, S256 and advertised client methods; no authentication was attempted.",
        );
      }
    });
  }

  private setup(
    state: RecordState,
    request: Pick<
      McpOAuthConfigureRequest,
      "clientAuthMethod" | "scopes" | "discoveryDigest"
    >,
  ) {
    if (
      !state.discovery ||
      !state.metadata ||
      request.discoveryDigest !== state.discovery.digest ||
      !state.discovery.clientAuthMethods.includes(request.clientAuthMethod) ||
      !Array.isArray(request.scopes) ||
      request.scopes.length < 1 ||
      request.scopes.length > 32 ||
      new Set(request.scopes).size !== request.scopes.length ||
      request.scopes.some((scope) => !state.discovery!.scopes.includes(scope))
    )
      throw new Error(
        "Use an explicitly offered client method and explicit supported read scopes from current discovery",
      );
    if (["authenticated", "authorizing"].includes(state.state))
      throw new Error("Disconnect before changing client configuration");
  }

  private selectedRedirect(state: RecordState, requested?: unknown) {
    if (
      requested === undefined &&
      state.callbackMode === "app" &&
      state.redirectUri !== this.redirectUri
    )
      throw new OAuthCallbackError("oauth_callback_changed");
    return oauthRedirect(
      requested === undefined ? state.redirectUri : requested,
      this.redirectUri,
    );
  }

  private async credentials(state: RecordState): Promise<Credentials> {
    this.current(state);
    const value = await this.store.read(state.reference);
    this.current(state);
    if (!value)
      throw new Error(
        "App-owned credentials are missing; explicitly configure and reconnect",
      );
    try {
      const parsed = JSON.parse(
        Buffer.from(value).toString("utf8"),
      ) as Credentials;
      if (
        !parsed.client ||
        parsed.client.client_id !== state.clientId ||
        ("redirect_uris" in parsed.client &&
          parsed.client.redirect_uris &&
          (parsed.client.redirect_uris.length !== 1 ||
            parsed.client.redirect_uris[0] !==
              (state.redirectUri ?? this.redirectUri)))
      )
        throw new Error();
      return parsed;
    } catch {
      throw new Error(
        "App-owned credential binding is invalid; reconnect required",
      );
    }
  }

  private async persist(state: RecordState, credentials: Credentials) {
    this.current(state);
    await this.store.replace(
      state.reference,
      Buffer.from(JSON.stringify(credentials)),
    );
    this.current(state);
  }

  async configure(
    id: string,
    request: McpOAuthConfigureRequest,
  ): Promise<McpOAuthStatus> {
    return this.exclusive(id, async () => {
      const state = this.read(id);
      this.setup(state, request);
      if (
        typeof request.clientId !== "string" ||
        !/^[A-Za-z0-9._:-]{1,200}$/.test(request.clientId) ||
        (request.clientAuthMethod !== "none" &&
          (typeof request.clientSecret !== "string" ||
            !request.clientSecret ||
            request.clientSecret.length > 8192 ||
            /[\r\n\0]/.test(request.clientSecret))) ||
        (request.clientAuthMethod === "none" &&
          request.clientSecret !== undefined)
      )
        throw new Error(
          "Provide supported static client configuration; secrets are write-only",
        );
      const redirectUri = this.selectedRedirect(state, request.redirectUri);
      const client = {
        client_id: request.clientId,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: request.clientAuthMethod,
        ...(request.clientSecret
          ? { client_secret: request.clientSecret }
          : {}),
      };
      await this.persist(state, { client });
      this.current(state);
      state.clientId = client.client_id;
      state.redirectUri = redirectUri;
      state.callbackMode =
        redirectUri === this.redirectUri ? "app" : "fixed-loopback";
      state.method = request.clientAuthMethod;
      state.scopes = [...request.scopes];
      state.state = "disconnected";
      state.generation = randomUUID();
      state.pending = false;
      this.save(state);
      return this.status(id);
    });
  }

  async register(
    id: string,
    request: McpOAuthRegistrationRequest,
  ): Promise<McpOAuthStatus> {
    return this.exclusive(id, async () => {
      const state = this.read(id);
      this.setup(state, request);
      if (
        request.consent !== "Register a new MCP OAuth client" ||
        !state.discovery!.dynamicRegistration ||
        state.clientId ||
        state.pending
      )
        throw new Error(
          "Dynamic registration requires advertised support, separate explicit consent and no existing client",
        );
      const redirectUri = this.selectedRedirect(state, request.redirectUri);
      state.pending = true;
      this.save(state);
      try {
        const client = await this.bounded(state, (fetchFn) =>
          registerClient(state.discovery!.issuer, {
            metadata: state.metadata,
            clientMetadata: {
              client_name: "Local PR Review",
              redirect_uris: [redirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: request.clientAuthMethod,
            },
            scope: request.scopes.join(" "),
            fetchFn,
          }),
        );
        if (
          client.token_endpoint_auth_method !== request.clientAuthMethod ||
          client.redirect_uris.length !== 1 ||
          client.redirect_uris[0] !== redirectUri ||
          !/^[A-Za-z0-9._:-]{1,200}$/.test(client.client_id) ||
          client.grant_types?.some(
            (grant) => !["authorization_code", "refresh_token"].includes(grant),
          ) ||
          client.response_types?.some((response) => response !== "code") ||
          (client.scope &&
            client.scope
              .split(/\s+/)
              .some((scope) => !request.scopes.includes(scope)))
        )
          throw new Error("Registration binding mismatch");
        await this.persist(state, {
          client: {
            client_id: client.client_id,
            redirect_uris: [redirectUri],
            client_secret: client.client_secret,
            token_endpoint_auth_method: request.clientAuthMethod,
          },
        });
        this.current(state);
        state.clientId = client.client_id;
        state.redirectUri = redirectUri;
        state.callbackMode =
          redirectUri === this.redirectUri ? "app" : "fixed-loopback";
        state.method = request.clientAuthMethod;
        state.scopes = [...request.scopes];
        state.state = "disconnected";
        state.pending = false;
        this.save(state);
        return this.status(id);
      } catch {
        this.current(state);
        state.state = "reconnect_required";
        this.save(state);
        throw new Error(
          "Registration failed or outcome is ambiguous. Check the authorization server before registering again; no automatic retry.",
        );
      }
    });
  }

  async connect(id: string, browser: string): Promise<McpOAuthConnectResult> {
    return this.exclusive(id, async () => {
      const state = this.read(id);
      if (!state.metadata || !state.clientId)
        throw new Error("Complete discovery and client setup first");
      const redirectUri = this.selectedRedirect(state);
      const credentials = await this.credentials(state);
      this.current(state);
      for (const transaction of this.transactions.values()) {
        if (transaction.id === id) this.forget(transaction);
        else if (transaction.expiresAt <= Date.now()) this.expire(transaction);
      }
      state.generation = randomUUID();
      state.state = "authorizing";
      state.pending = false;
      this.save(state);
      let transaction: Transaction | undefined;
      try {
        const nonce = randomBytes(32).toString("base64url");
        const started = await startAuthorization(state.discovery!.issuer, {
          metadata: state.metadata,
          clientInformation: credentials.client,
          redirectUrl: redirectUri,
          scope: state.scopes.join(" "),
          state: nonce,
          resource: this.profile(state.profileId).resource,
        });
        this.current(state);
        const expiresAt = Date.now() + 300000;
        transaction = {
          id,
          generation: state.generation,
          state: nonce,
          browser: digest(browser),
          verifier: started.codeVerifier,
          redirectUri,
          expiresAt,
        };
        this.transactions.set(nonce, transaction);
        this.arm(transaction, 300000);
        if (redirectUri !== this.redirectUri)
          transaction.stop = await listenOAuthCallback(redirectUri, (params) =>
            this.stage(params, redirectUri),
          );
        this.current(state);
        return {
          authorizationUrl: started.authorizationUrl.toString(),
          expiresAt: new Date(expiresAt).toISOString(),
          status: this.status(id),
        };
      } catch (error) {
        if (transaction) this.forget(transaction);
        this.current(state);
        state.state = "disconnected";
        this.save(state);
        throw error;
      }
    });
  }

  private validateTokens(
    state: RecordState,
    tokens: OAuthTokens,
    previous?: OAuthTokens,
    privateValues: (string | undefined)[] = [],
  ) {
    if (tokens.token_type.toLowerCase() !== "bearer")
      throw new TokenValidationError("token_type");
    if (
      !tokens.access_token ||
      tokens.access_token.length > 16000 ||
      /[\r\n]/.test(tokens.access_token)
    )
      throw new TokenValidationError("access_token");
    if (
      tokens.refresh_token &&
      (tokens.refresh_token.length > 16000 ||
        /[\r\n]/.test(tokens.refresh_token))
    )
      throw new TokenValidationError("refresh_token");
    if (
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in! <= 0 ||
      tokens.expires_in! > 31536000
    )
      throw new TokenValidationError("token_expiry");
    const value = tokens.scope ?? previous?.scope ?? state.scopes.join(" ");
    const scopes = decodeOAuthScopes(state.profileId, value);
    const missing = state.scopes.some((scope) => !scopes.includes(scope));
    if (localScopeAdmission(state.profileId)) {
      if (
        [tokens.access_token, tokens.refresh_token, ...privateValues].some(
          (value) => value && scopes.some((scope) => scope.includes(value)),
        )
      )
        throw new OAuthScopeError("oauth_scopes_invalid");
      if (previous) {
        const accepted = decodeOAuthScopes(
          state.profileId,
          previous.scope ?? state.scopes.join(" "),
        );
        if (missing || scopes.some((scope) => !accepted.includes(scope)))
          throw new OAuthScopeError("oauth_scopes_changed");
      }
    } else if (missing || scopes.some((scope) => !state.scopes.includes(scope)))
      throw new TokenValidationError("token_scope");
    return { ...tokens, scope: scopes.join(" ") };
  }

  private responseTransaction(
    params: URLSearchParams,
    redirectUri: string,
  ): Transaction {
    const transaction = this.transactions.get(params.get("state") ?? "");
    if (transaction && transaction.expiresAt <= Date.now())
      this.expire(transaction);
    if (
      !transaction ||
      transaction.expiresAt <= Date.now() ||
      transaction.receipt ||
      transaction.consumed ||
      transaction.redirectUri !== redirectUri ||
      [...params.keys()].some(
        (key) =>
          !["state", "code", "iss", "error", "error_description"].includes(key),
      ) ||
      [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
      Boolean(params.get("code")) === Boolean(params.get("error")) ||
      [...params.values()].some((value) => value.length > 8192)
    )
      throw new Error("Invalid, expired or mismatched OAuth callback");
    const state = this.read(transaction.id);
    if (
      state.generation !== transaction.generation ||
      state.state !== "authorizing" ||
      ((params.has("iss") ||
        state.metadata?.authorization_response_iss_parameter_supported) &&
        params.get("iss") !== state.discovery!.issuer)
    )
      throw new Error("OAuth callback issuer or authority mismatch");
    return transaction;
  }

  private stage(params: URLSearchParams, redirectUri: string): string {
    const transaction = this.responseTransaction(params, redirectUri);
    transaction.receipt = randomBytes(32).toString("base64url");
    transaction.response = new URLSearchParams(params);
    transaction.response.delete("error_description");
    transaction.receiptExpiresAt = Math.min(
      transaction.expiresAt,
      Date.now() + 60000,
    );
    transaction.receiptTimer = setTimeout(
      () => this.expire(transaction),
      transaction.receiptExpiresAt - Date.now(),
    );
    transaction.receiptTimer.unref();
    const target = new URL("/api/mcp/oauth/complete", this.appOrigin);
    target.searchParams.set("receipt", transaction.receipt);
    return target.href;
  }

  async callback(
    params: URLSearchParams,
    browser: string,
    callbackOrigin: string,
  ): Promise<string> {
    return this.finish(
      this.responseTransaction(params, this.redirectUri),
      params,
      browser,
      callbackOrigin,
    );
  }

  async complete(
    params: URLSearchParams,
    browser: string,
    callbackOrigin: string,
  ): Promise<string> {
    const receipt = params.get("receipt") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(receipt) || [...params.keys()].length !== 1)
      throw new Error("Invalid OAuth completion receipt");
    const transaction = [...this.transactions.values()].find(
      (item) => item.receipt && same(item.receipt, receipt),
    );
    if (
      transaction?.receiptExpiresAt &&
      transaction.receiptExpiresAt <= Date.now()
    )
      this.expire(transaction);
    if (
      !transaction?.response ||
      transaction.consumed ||
      !transaction.receiptExpiresAt ||
      transaction.receiptExpiresAt <= Date.now()
    )
      throw new Error("Invalid, expired or consumed OAuth completion receipt");
    return this.finish(
      transaction,
      transaction.response,
      browser,
      callbackOrigin,
    );
  }

  private async finish(
    transaction: Transaction,
    params: URLSearchParams,
    browser: string,
    callbackOrigin: string,
  ): Promise<string> {
    if (transaction.expiresAt <= Date.now()) this.expire(transaction);
    if (
      transaction.expiresAt <= Date.now() ||
      !same(transaction.browser, digest(browser)) ||
      callbackOrigin !== this.appOrigin
    )
      throw new Error("Invalid, expired or mismatched OAuth callback");
    if (transaction.consumed)
      throw new Error("OAuth callback already consumed");
    transaction.consumed = true;
    transaction.stop?.();
    clearTimeout(transaction.receiptTimer);
    transaction.receiptTimer = undefined;
    transaction.receiptExpiresAt = undefined;
    transaction.receipt = undefined;
    transaction.response = undefined;
    await this.exclusive(transaction.id, async () => {
      const state = this.read(transaction.id);
      if (
        state.generation !== transaction.generation ||
        state.state !== "authorizing"
      )
        throw new Error("OAuth transaction no longer active");
      try {
        if (
          params.has("error") ||
          !params.get("code") ||
          params.get("code")!.length > 8192
        )
          throw new Error("Authorization not completed");
        this.report({ phase: "callback_validated", outcome: "succeeded" });
        const credentials = await this.observed("client_read", () =>
          this.credentials(state),
        );
        state.pending = true;
        this.save(state);
        const exchanged = await this.observed("sdk_exchange", () =>
          this.bounded(
            state,
            (fetchFn) =>
              exchangeAuthorization(state.discovery!.issuer, {
                metadata: state.metadata,
                clientInformation: credentials.client,
                authorizationCode: params.get("code")!,
                iss: params.get("iss") ?? undefined,
                codeVerifier: transaction.verifier,
                redirectUri: transaction.redirectUri,
                resource: this.profile(state.profileId).resource,
                fetchFn,
              }),
            true,
          ),
        );
        const tokens = await this.observed("token_validation", () =>
          this.validateTokens(state, exchanged, undefined, [
            credentials.client.client_secret,
            params.get("code")!,
            transaction.verifier,
            transaction.state,
            browser,
          ]),
        );
        this.current(state);
        transaction.verifier = "";
        const pending = {
          client: credentials.client,
          tokens,
          expiresAt: Date.now() + tokens.expires_in! * 1000,
        };
        this.arm(transaction, tokens.expires_in! * 1000);
        if (transaction.expiresAt <= Date.now()) {
          this.expire(transaction);
          throw new OAuthScopeError("oauth_scope_consent_invalid");
        }
        if (localScopeAdmission(state.profileId)) {
          const grantedScopes = decodeOAuthScopes(
            state.profileId,
            tokens.scope!,
          );
          const missingScopes = state.scopes.filter(
            (scope) => !grantedScopes.includes(scope),
          );
          const additionalScopes = grantedScopes.filter(
            (scope) => !state.scopes.includes(scope),
          );
          const status = missingScopes.length
            ? "missing_required"
            : additionalScopes.length
              ? "approval_required"
              : "accepted";
          transaction.review = {
            preview: {
              id: randomUUID(),
              connectionId: state.id,
              generation: state.generation,
              clientId: state.clientId!,
              issuer: state.discovery!.issuer,
              resource: state.discovery!.resource,
              redirectUri: transaction.redirectUri,
              expiresAt: new Date(transaction.expiresAt).toISOString(),
              source:
                exchanged.scope === undefined
                  ? "requested_fallback"
                  : "provider",
              status,
              requestedScopes: [...state.scopes],
              grantedScopes,
              missingScopes,
              additionalScopes,
            },
            ...(status === "approval_required" ? { credentials: pending } : {}),
          };
          if (status !== "accepted") return;
        }
        await this.observed("credential_persistence", () =>
          this.persist(state, pending),
        );
        if (transaction.expiresAt <= Date.now()) this.expire(transaction);
        this.current(state);
        state.pending = false;
        state.state = "authenticated";
        this.save(state);
        if (!transaction.review) this.forget(transaction);
      } catch (error) {
        this.forget(transaction);
        this.current(state);
        state.state = "reconnect_required";
        this.save(state);
        if (
          error instanceof CredentialStoreError ||
          error instanceof OAuthScopeError
        )
          throw error;
        throw new Error(
          "OAuth callback failed. No authorization code or provider error is exposed; explicitly reconnect.",
        );
      }
    });
    return transaction.id;
  }

  private async scopeTransaction(id: string, browser: string) {
    const state = this.read(id);
    await this.validateSource?.(id);
    this.current(state);
    const transaction = [...this.transactions.values()].find(
      (item) =>
        item.id === id && item.generation === state.generation && item.review,
    );
    if (transaction && transaction.expiresAt <= Date.now())
      this.expire(transaction);
    if (
      !transaction?.review ||
      transaction.expiresAt <= Date.now() ||
      !same(transaction.browser, digest(browser))
    )
      throw new OAuthScopeError("oauth_scope_consent_invalid");
    return { state, transaction, review: transaction.review };
  }

  async reviewReturnUrl(id: string, browser: string): Promise<string> {
    const { review } = await this.scopeTransaction(id, browser);
    return `${this.appOrigin}/#/settings?oauthReview=${review.preview.id}`;
  }

  async continueReview(
    request: McpOAuthReviewReturnRequest,
    browser: string,
  ): Promise<McpOAuthReviewReturn> {
    const transaction = [...this.transactions.values()].find(
      (item) => item.review?.preview.id === request.continuation,
    );
    if (!transaction) throw new OAuthScopeError("oauth_scope_consent_invalid");
    return this.exclusive(transaction.id, async () => {
      const { review } = await this.scopeTransaction(transaction.id, browser);
      if (review.returned || review.preview.id !== request.continuation)
        throw new OAuthScopeError("oauth_scope_consent_invalid");
      review.returned = true;
      return {
        connectionId: transaction.id,
        generation: transaction.generation,
        status: review.preview.status,
        expiresAt: review.preview.expiresAt,
      };
    });
  }

  async scopePreview(
    id: string,
    browser: string,
  ): Promise<McpOAuthScopePreview> {
    const { review } = await this.scopeTransaction(id, browser);
    return structuredClone(review.preview);
  }

  async approveScopes(
    id: string,
    browser: string,
    request: McpOAuthScopeApproval,
  ): Promise<McpOAuthStatus> {
    return this.exclusive(id, async () => {
      const { state, transaction, review } = await this.scopeTransaction(
        id,
        browser,
      );
      if (
        review.preview.status !== "approval_required" ||
        !review.credentials ||
        state.state !== "authorizing" ||
        request.previewId !== review.preview.id ||
        request.generation !== state.generation ||
        request.consent !== "Accept these additional OAuth capabilities" ||
        !Array.isArray(request.additionalScopes) ||
        request.additionalScopes.length !==
          review.preview.additionalScopes.length ||
        request.additionalScopes.some(
          (scope, i) => scope !== review.preview.additionalScopes[i],
        )
      )
        throw new OAuthScopeError("oauth_scope_consent_invalid");
      const credentials = review.credentials;
      review.credentials = undefined;
      try {
        await this.observed("credential_persistence", () =>
          this.persist(state, credentials),
        );
        if (transaction.expiresAt <= Date.now()) this.expire(transaction);
        this.current(state);
        state.pending = false;
        state.state = "authenticated";
        this.save(state);
        review.preview.status = "accepted";
        return this.status(id);
      } catch (error) {
        this.forget(transaction);
        this.current(state);
        state.state = "reconnect_required";
        this.save(state);
        throw error;
      }
    });
  }

  private async admittedCredentials(id: string, generation: string) {
    const state = this.read(id);
    if (
      state.generation !== generation ||
      state.state !== "authenticated" ||
      state.pending
    )
      throw new Error(
        "Captured MCP authentication is no longer authorized; reconnect and capture new grants",
      );
    await this.validateSource?.(id);
    this.current(state);
    const credentials = await this.credentials(state);
    if (!credentials.tokens)
      throw new Error("MCP credentials are missing; reconnect required");
    return { state, credentials };
  }

  async token(id: string, generation: string): Promise<string> {
    return this.exclusive(id, async () => {
      const { state, credentials } = await this.admittedCredentials(
        id,
        generation,
      );
      if (credentials.expiresAt! > Date.now() + 30000)
        return credentials.tokens!.access_token;
      state.pending = true;
      this.save(state);
      try {
        if (!credentials.tokens!.refresh_token)
          throw new Error("Refresh unavailable");
        const tokens = this.validateTokens(
          state,
          await this.bounded(state, (fetchFn) =>
            refreshAuthorization(state.discovery!.issuer, {
              metadata: state.metadata,
              clientInformation: credentials.client,
              refreshToken: credentials.tokens!.refresh_token!,
              resource: this.profile(state.profileId).resource,
              fetchFn,
            }),
          ),
          credentials.tokens,
        );
        await this.persist(state, {
          client: credentials.client,
          tokens,
          expiresAt: Date.now() + tokens.expires_in! * 1000,
        });
        this.current(state);
        state.pending = false;
        this.save(state);
        return tokens.access_token;
      } catch (error) {
        this.current(state);
        state.state = "reconnect_required";
        this.save(state);
        if (error instanceof CredentialStoreError) throw error;
        throw new Error(
          "Refresh failed or outcome is ambiguous; reconnect required, no automatic replay",
        );
      }
    });
  }

  private async noRefresh<T>(
    id: string,
    generation: string,
    action: (
      state: RecordState,
      fetch: GuardedFetch,
      token: () => Promise<string>,
    ) => Promise<T>,
  ) {
    return this.exclusive(id, async () => {
      const { state, credentials } = await this.admittedCredentials(
        id,
        generation,
      );
      const fresh = () => {
        this.current(state);
        if (
          !Number.isFinite(credentials.expiresAt) ||
          credentials.expiresAt! <= Date.now() + 30000
        )
          throw new Error(
            "MCP no-refresh operation requires an admitted credential with more than 30 seconds remaining; no refresh attempted",
          );
      };
      fresh();
      const tokens = credentials.tokens!;
      const protectedValues = [
        tokens.access_token,
        tokens.refresh_token,
        credentials.client.client_secret,
        ...decodeOAuthScopes(state.profileId, tokens.scope ?? "").filter(
          (scope) =>
            !(
              state.profileId === "linear-mcp/1" &&
              ["read", "write", "openid", "email"].includes(scope)
            ) &&
            !(
              state.profileId === "axiom-mcp/1" &&
              ["openid", "offline_access", "profile", "email"].includes(scope)
            ) &&
            !(state.profileId === "notion-mcp/1" && scope === "default"),
        ),
      ].filter((value): value is string => Boolean(value));
      try {
        const result = await this.bounded(state, (fetch) =>
          action(
            state,
            (url, init) => {
              fresh();
              return fetch(url, init);
            },
            async () => {
              fresh();
              return tokens.access_token;
            },
          ),
        );
        await this.validateSource?.(id);
        fresh();
        const serialized = JSON.stringify(result);
        if (
          Buffer.byteLength(serialized) > 200000 ||
          protectedValues.some((value) =>
            serialized.includes(JSON.stringify(value).slice(1, -1)),
          )
        )
          throw new Error(
            "MCP result exceeds bounds or echoes protected values",
          );
        return result;
      } catch {
        throw new Error(
          "MCP session failed or changed; no tool call was automatically retried. Explicitly reload inventory or reconnect.",
        );
      }
    });
  }

  async catalog(id: string, generation: string) {
    return this.noRefresh(id, generation, (state, fetch, token) => {
      const profile = this.profile(state.profileId);
      return remoteMcp(
        profile.endpoint,
        fetch,
        token,
        async ({ tools, initialization, pages }) => ({
          endpoint: profile.endpoint,
          resource: profile.resource,
          initialization,
          tools,
          coverage: { complete: true as const, pages, toolCount: tools.length },
        }),
      );
    });
  }

  async selfProfile(
    id: string,
    generation: string,
    catalog: Awaited<ReturnType<McpOAuth["catalog"]>>,
    responseFormat: "concise" | "detailed" = "concise",
  ) {
    const state = this.read(id);
    const profile = this.profile(state.profileId);
    const tools = catalog.tools.filter(
      (tool) => tool.name === "slack_read_user_profile",
    );
    if (
      state.profileId !== "slack-mcp/1" ||
      catalog.endpoint !== profile.endpoint ||
      catalog.resource !== profile.resource ||
      !catalog.coverage.complete ||
      tools.length !== 1
    )
      throw new Error("Retained self-profile catalog binding is unavailable");
    const tool = structuredClone(tools[0]);
    const initialization = structuredClone(catalog.initialization);
    const args = { response_format: responseFormat };
    validateSchema(tool.inputSchema, args);
    return this.noRefresh(id, generation, (_state, fetch, token) =>
      remoteMcp(
        profile.endpoint,
        fetch,
        token,
        ({ call }) =>
          this.observed("identity_probe", () => call(tool.name, args)),
        undefined,
        { initialization, tool },
      ),
    );
  }

  binding(id: string): McpOAuthBinding {
    const state = this.read(id);
    this.current(state);
    if (
      state.state !== "authenticated" ||
      state.pending ||
      !state.discovery ||
      !state.clientId
    )
      throw new Error("MCP connection is not admitted for reads");
    return {
      profileId: state.profileId,
      profileDigest: state.profileDigest,
      generation: state.generation,
      issuer: state.discovery.issuer,
      resource: state.discovery.resource,
      clientId: state.clientId,
    };
  }

  async readTool(
    id: string,
    binding: McpOAuthBinding,
    schemaFingerprint: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const adapter = oauthReadAdapter(binding.profileId);
    if (!adapter) throw new Error("OAuth read profile denied");
    const boundedArgs = adapter.arguments(name, args);
    if (
      canonicalJson(binding) !== canonicalJson(this.binding(id)) ||
      !/^[a-f0-9]{64}$/.test(schemaFingerprint)
    )
      throw new Error("Captured OAuth read connection binding changed");
    signal.throwIfAborted();
    await this.token(id, binding.generation);
    return this.noRefresh(id, binding.generation, (state, fetch, token) =>
      remoteMcp(
        this.profile(state.profileId).endpoint,
        fetch,
        token,
        async ({ tools, call }) => {
          const tool = tools.find((tool) => tool.name === name);
          if (
            !tool ||
            fingerprintToolSchema(tool.inputSchema) !== schemaFingerprint
          )
            throw new Error(
              "Captured OAuth read input schema changed; reload tools and choose new grants",
            );
          validateSchema(tool.inputSchema, boundedArgs);
          const result = await call(name, boundedArgs);
          if (result.content?.some((item) => item.type !== "text"))
            throw new Error("OAuth read returned unsupported non-text content");
          return result;
        },
        signal,
      ),
    );
  }

  async inventory(id: string): Promise<IntegrationInventory> {
    const state = this.read(id);
    const secrets: string[] = [];
    const tools = await this.bounded(state, (fetch) =>
      remoteMcp(
        this.profile(state.profileId).endpoint,
        fetch,
        async () => {
          const value = await this.token(id, state.generation);
          secrets.push(value);
          return value;
        },
        async ({ tools }) => {
          const inventory = inventoryIdentity(tools);
          if (
            secrets.some((secret) => JSON.stringify(inventory).includes(secret))
          )
            throw new Error("Credential echo denied");
          return inventory;
        },
      ),
    );
    return {
      status: "loaded",
      oauthBinding: this.binding(id),
      checkedAt: new Date().toISOString(),
      scope: this.synthetic ? "synthetic_transport" : "live_inventory",
      connected: false,
      tools,
      message:
        "Inventory loaded, not a read result or tool grant. Only explicitly reviewed read tools may be granted; provider access controls determine accessible data.",
    };
  }

  cancel(id: string): McpOAuthStatus {
    const state = this.read(id);
    state.generation = randomUUID();
    state.state = "disconnected";
    this.save(state);
    for (const transaction of this.transactions.values())
      if (transaction.id === id) this.forget(transaction);
    for (const controller of this.aborts.get(id) ?? []) controller.abort();
    return this.status(id);
  }

  async disconnect(id: string): Promise<McpOAuthStatus> {
    this.cancel(id);
    return this.exclusive(id, async () => {
      const state = this.read(id);
      state.remoteRevocation = "not_attempted";
      this.save(state);
      let failure: unknown;
      let deletionFailed = false;
      try {
        const value = await this.store.read(state.reference);
        const credentials = value
          ? (JSON.parse(Buffer.from(value).toString("utf8")) as Credentials)
          : undefined;
        if (!state.metadata?.revocation_endpoint)
          state.remoteRevocation = "unsupported";
        else if (credentials?.tokens) {
          try {
            await this.bounded(state, async (fetch) => {
              const method =
                state.method === "none"
                  ? oauth.None()
                  : state.method === "client_secret_basic"
                    ? oauth.ClientSecretBasic(credentials.client.client_secret!)
                    : oauth.ClientSecretPost(credentials.client.client_secret!);
              for (const token of [
                credentials.tokens!.refresh_token,
                credentials.tokens!.access_token,
              ].filter(Boolean)) {
                const response = await oauth.revocationRequest(
                  state.metadata! as oauth.AuthorizationServer,
                  { client_id: credentials.client.client_id },
                  method,
                  token!,
                  { [oauth.customFetch]: fetch },
                );
                await oauth.processRevocationResponse(response);
              }
            });
            state.remoteRevocation = "succeeded";
          } catch {
            state.remoteRevocation = "failed";
          }
        }
      } catch (error) {
        failure = error;
      }
      try {
        await this.store.delete(state.reference);
      } catch (error) {
        failure = error;
        deletionFailed = true;
      }
      state.pending = deletionFailed;
      state.clientId = undefined;
      state.method = undefined;
      state.redirectUri = undefined;
      state.callbackMode = undefined;
      state.scopes = [];
      state.state = state.discovery ? "needs_client" : "needs_discovery";
      this.save(state);
      if (failure) throw new CredentialStoreError("unavailable");
      return this.status(id);
    });
  }

  async close() {
    this.closed = true;
    for (const transaction of this.transactions.values())
      this.forget(transaction);
    for (const owned of this.aborts.values())
      for (const controller of owned) controller.abort();
    await Promise.allSettled([...this.locks.values()]);
  }
}

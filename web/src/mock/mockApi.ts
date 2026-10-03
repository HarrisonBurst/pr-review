import {
  automationOff,
  autoSubmissionConfirmation,
  cancelReviewConfirmation,
  type ReviewJobAction,
  autoSubmissionReenableConfirmation,
  normalizeAutoSubmissionAuthors,
  type AutoSubmissionUpdate,
  type DraftEditIntent,
  type HumanReviewAcknowledgment,
  type AutoSubmissionReenable,
  dangerousConfirmation,
  dockerApprovalConfirmation,
  dockerSetupConfirmation,
  maxConcurrentReviewsRange,
  validConcurrentReviews,
  effectiveAutomation,
  inboxEligible,
  type ApiError,
  type AppState,
  type ArchivedHarnessSelection,
  type AutomationOverrides,
  type CapturedHarnessEntry,
  type DockerBoundarySnapshot,
  type DockerCapabilityApproval,
  type DockerCapabilityDisclosure,
  type DockerInspectRequest,
  type DockerLibraryLeaf,
  type DockerLocalMcpRequest,
  type DockerSetupStatus,
  type DraftUpdate,
  type ExecutionStatus,
  type Finding,
  type Freshness,
  type FreshnessStatus,
  type HarnessEntryEvidence,
  type HarnessId,
  type HarnessSelection,
  type HarnessSelectionUpdate,
  type HarnessSettings,
  type HarnessModelDiscovery,
  type HarnessModelSource,
  type HarnessStatus,
  type ImportOperation,
  type IntegrationCatalog,
  type IntegrationConfig,
  type IntegrationConnection,
  type IntegrationDefinition,
  type IntegrationInventory,
  type IntegrationTestResult,
  type McpClientAuthMethod,
  type McpOAuthConnectResult,
  type McpOAuthDiscovery,
  type McpOAuthReviewReturn,
  type McpOAuthScopePreview,
  type McpOAuthStatus,
  type IsolatedHarnessSelection,
  type MergeReadinessState,
  type NativeHarnessSelection,
  type PullRequestDetail,
  type Question,
  type QuestionRequest,
  type ReviewDraft,
  type ReviewPayload,
  type ReviewResult,
  type ReviewRun,
  type ReviewerSettings,
  type RevisionProposal,
  type RevisionRequest,
  type RunActivity,
  type RunPhase,
  type SettingsUpdate,
  type Submission,
  type SyncOperation,
  type SubmissionPreview,
} from "../../../shared/contracts";
import { anchorsInline, diffAnchors, parseDiff, resolveSelection } from "../lib/diff";
import { supportedCapture } from "../lib/execution";
import * as fixtures from "./fixtures";

type Listener = (prId?: string) => void;

interface MockOptions {
  reviewDelayMs?: number;
  reviewControls?: boolean;
  emptySetup?: boolean;
  submitOutcome?: Submission["status"];
  freshness?: FreshnessStatus | "error";
  commits?: { count: number; truncated?: boolean };
  remoteHead?: Record<string, string>;
  reviewRefresh?: "fail" | "closed";
  question?: "fail" | "hang";
  readiness?: ReadinessMode | ReadinessMode[];
  harness?: HarnessMode;
  setup?: "fail" | "slow";
  native?: "discovered" | "bound" | "loaded" | "enabled";
  inventory?: "changed" | "error";
  readProviders?: "imported" | "enabled";
  readTest?: "synthetic" | "live" | "error";
  history?: "archived";
  models?: "unsupported" | "error" | "transport" | "slow";
  oauth?: OAuthMode;
  oauthProvider?: "linear" | "axiom";
  oauthStorage?: "keychain" | "unsupported" | "unavailable";
  oauthRevocation?: "unsupported" | "succeeded" | "failed";
  oauthMethods?: "public";
  oauthCallback?: "fixed" | "occupied";
  oauthScopes?: OAuthScopeCase;
  oauthReturn?: "valid" | "stale";
  exclusions?: "none";
  autoSubmission?: "human" | "unavailable" | "off-hold";
  editIntent?: "locked" | "fail" | "slow" | "stale";
}

export type OAuthScopeCase =
  "accepted" | "fallback" | "pending" | "missing" | "invalid" | "browser";

export const OAUTH_SCOPE_CASES: Record<OAuthScopeCase, string | null> = {
  accepted: " ,search:read.public,,search:read.public ,",
  fallback: null,
  pending: "search:read.public,mock:additional.capability.canary,mock:second.additional.canary",
  missing: "mock:additional.capability.canary",
  invalid: "search:read.public,<img src=x onerror=alert(1)>",
  browser: "search:read.public,mock:additional.capability.canary",
};

export const OAUTH_SCOPE_MESSAGES = {
  oauth_scopes_invalid:
    "The provider scope list is malformed or exceeds the complete local disclosure limit. No credential was accepted; reconnect only after resolving the scope format.",
  oauth_scopes_missing:
    "Required permissions are missing. Return to Connections to view the local scope disclosure; additional permissions cannot replace missing requirements.",
  oauth_scope_consent_invalid:
    "Scope approval is unavailable, expired or does not match this browser and exact disclosure. No additional capabilities were accepted.",
};

export const OAUTH_SCOPE_CONSENT = "Accept these additional OAuth capabilities";

export function decodeMockOAuthScopes(value: string, spaceOnly = false): string[] {
  if (value.length > 8192 || /[^\x20-\x7e\t\r\n]/.test(value))
    throw new MockError(409, OAUTH_SCOPE_MESSAGES.oauth_scopes_invalid, "oauth_scopes_invalid");
  const items = value.split(spaceOnly ? / +/ : /[, \t\r\n]+/).filter(Boolean);
  if (
    items.length > 128 ||
    items.some(
      (item) =>
        !(
          spaceOnly ? /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/ : /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/
        ).test(item),
    )
  )
    throw new MockError(409, OAUTH_SCOPE_MESSAGES.oauth_scopes_invalid, "oauth_scopes_invalid");
  return [...new Set(items)];
}

export type OAuthMode =
  | "metadata"
  | "imported"
  | "discovered"
  | "configured"
  | "authorizing"
  | "authenticated"
  | "reconnect";

interface MockOAuthState {
  profileId: string;
  state: McpOAuthStatus["state"];
  discovery?: McpOAuthDiscovery;
  clientId?: string;
  clientAuthMethod?: McpClientAuthMethod;
  redirectUri?: string;
  scopes: string[];
  generation: string;
  pending: boolean;
  remoteRevocation: McpOAuthStatus["remoteRevocation"];
  review?: { preview: McpOAuthScopePreview; held: boolean; returned?: boolean };
}

export const OAUTH_REDIRECT_URI = "http://127.0.0.1:4317/api/mcp/oauth/callback";
export const OAUTH_FIXED_REDIRECT_URI = "http://localhost:4548/callback";
const OAUTH_CALLBACK_INVALID_MESSAGE =
  "Choose the app callback or an exact HTTP loopback redirect with an explicit unprivileged port and plain path. No query, fragment, credentials or app-port alias is allowed.";
const OAUTH_CALLBACK_UNAVAILABLE_MESSAGE =
  "The selected callback listener is unavailable. Close your own conflicting session or explicitly choose another registered redirect; no port was replaced or taken over.";
const fixedRedirectPattern =
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{4,5})(\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?)$/;

const oauthRedirect = (value: unknown, saved?: string): string => {
  if (value === undefined) return saved ?? OAUTH_REDIRECT_URI;
  if (value === OAUTH_REDIRECT_URI) return value;
  const match =
    typeof value === "string" && value.length <= 256 && fixedRedirectPattern.exec(value);
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1024 || port > 65535 || port === 4317 || match[3]!.length > 128)
    throw new MockError(409, OAUTH_CALLBACK_INVALID_MESSAGE, "oauth_callback_invalid");
  return value;
};
export const OAUTH_TEST_MESSAGE =
  "OAuth authentication and inventory are not read readiness. This profile needs a vetted identity and scoped read adapter before a bounded Test or review can run. No tool or content request was made.";
export const SLACK_TEST_FAILED_MESSAGE =
  "Slack read Test did not succeed. Check admission, explicit search grants, source and inventory; no operation was retried.";
export const SLACK_TEST_SYNTHETIC_MESSAGE =
  "Synthetic Slack read passed; not live connection evidence.";
export const LINEAR_TEST_FAILED_MESSAGE =
  "OAuth read Test did not succeed. Check admission, explicit search grants, source and inventory; no operation was retried.";
export const LINEAR_TEST_SYNTHETIC_MESSAGE =
  "Synthetic Linear read passed; not live connection evidence.";
export const LINEAR_TEST_LIVE_MESSAGE =
  "One bounded Linear search succeeded using provider access controls. No independent identity, resource isolation or completeness guarantee is claimed.";
export const SLACK_TEST_LIVE_MESSAGE =
  "One bounded Slack search succeeded using provider access controls. No independent identity, channel isolation or completeness guarantee is claimed.";
const OAUTH_UNAVAILABLE_MESSAGE =
  "OAuth action failed or is unsupported. Check discovery, client configuration, storage and current source bindings. No secrets or provider errors are returned.";
const clientIdPattern = /^[A-Za-z0-9._:-]{1,200}$/;

export type HarnessMode =
  | "fresh"
  | "saved"
  | "archived"
  | "docker"
  | "docker-ready"
  | "docker-legacy"
  | "dangerous"
  | "incompatible"
  | "unavailable";

const isolated = (
  harness: HarnessId,
  model: string | null,
  additional: IsolatedHarnessSelection["additional"] = [],
  skillPath = fixtures.SKILL_PATH,
): IsolatedHarnessSelection => ({
  version: 3,
  workflow: "separated",
  harness,
  reviewer: { skillPath, model },
  additional,
});

const native = (
  workflow: NativeHarnessSelection["workflow"],
  harness: HarnessId,
  skillPath = fixtures.SKILL_PATH,
  model: string | null = fixtures.nativeDefaultModel[harness],
): NativeHarnessSelection => ({ version: 2, harness, workflow, reviewer: { skillPath, model } });

const managedSource = (harness: HarnessId, skillPath: string, importedAt: string) => ({
  id: fixtures.managedSourceId(harness),
  path: `/Users/demo/Library/Application Support/pr-review/managed-docker/${harness}.json`,
  harness,
  skillPath,
  digest: `managed-${harness}-digest`,
  importedAt,
});

const capturedEntry = (
  entry: { id: string; harness: HarnessId; model: string | null },
  role: CapturedHarnessEntry["role"],
  configBytes = fixtures.nativeConfigBytes,
): CapturedHarnessEntry => ({
  id: entry.id,
  role,
  harness: entry.harness,
  model: entry.model ?? fixtures.nativeDefaultModel[entry.harness],
  additionalInstructions: "",
  policy: fixtures.policyFixture(entry.harness, configBytes[entry.harness]),
});

const rolesOf = (
  selection: IsolatedHarnessSelection,
  configBytes = fixtures.nativeConfigBytes,
) => ({
  main: capturedEntry(
    { id: "main", harness: selection.harness, model: selection.reviewer.model },
    "main",
    configBytes,
  ),
  additional: selection.additional.map((entry) => capturedEntry(entry, "additional", configBytes)),
});

const savedAdditional: IsolatedHarnessSelection["additional"] = [
  { id: "reviewer-1", harness: "codex", model: "model-one" },
  { id: "reviewer-2", harness: "codex", model: "model-two" },
];

const currentSelection = (value: HarnessSettings["selection"]): HarnessSelection | null => {
  if (!value) return null;
  if (value.version === 3 && value.workflow === "separated" && Array.isArray(value.additional))
    return value as IsolatedHarnessSelection;
  if (value.version === 2 && (value.workflow === "docker" || value.workflow === "dangerous"))
    return value as NativeHarnessSelection;
  return null;
};

const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const validModel = (model: unknown) =>
  model === null ||
  (typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/.test(model));
const harnessIds = ["claude", "codex", "pi"];

type Seed = { settings: HarnessSettings; requiresSave: boolean; approved?: boolean };

const harnessSeed: Record<Exclude<HarnessMode, "unavailable">, Seed> = {
  fresh: {
    settings: { selection: native("dangerous", "claude", fixtures.SKILL_PATH, null), sources: [] },
    requiresSave: true,
  },
  saved: {
    settings: {
      selection: isolated("claude", fixtures.nativeDefaultModel.claude, savedAdditional),
      skill: fixtures.skillSnapshot(fixtures.SKILL_PATH),
      isolated: rolesOf(isolated("claude", fixtures.nativeDefaultModel.claude, savedAdditional)),
      sources: [],
    },
    requiresSave: false,
  },
  archived: {
    settings: {
      selection: {
        harness: "claude",
        workflow: "legacy",
        sourceId: null,
      } as ArchivedHarnessSelection,
      sources: [],
    },
    requiresSave: true,
  },
  docker: {
    settings: {
      selection: native("docker", "codex"),
      skill: fixtures.skillSnapshot(fixtures.SKILL_PATH),
      sources: [],
    },
    requiresSave: false,
  },
  "docker-ready": {
    settings: {
      selection: native("docker", "codex"),
      skill: fixtures.skillSnapshot(fixtures.SKILL_PATH),
      sources: [managedSource("codex", fixtures.SKILL_PATH, new Date().toISOString())],
      managed: { codex: managedSource("codex", fixtures.SKILL_PATH, "").id },
    },
    requiresSave: false,
    approved: true,
  },
  "docker-legacy": {
    settings: {
      selection: native("docker", "codex"),
      skill: fixtures.skillSnapshot(fixtures.SKILL_PATH),
      sources: [managedSource("codex", fixtures.SKILL_PATH, new Date().toISOString())],
      managed: { codex: managedSource("codex", fixtures.SKILL_PATH, "").id },
    },
    requiresSave: false,
  },
  dangerous: {
    settings: {
      selection: native("dangerous", "pi"),
      skill: fixtures.skillSnapshot(fixtures.SKILL_PATH),
      sources: [],
      dangerousConsent: { version: 1, harness: "pi", confirmedAt: new Date().toISOString() },
    },
    requiresSave: false,
  },
  incompatible: {
    settings: {
      selection: isolated(
        "claude",
        fixtures.nativeDefaultModel.claude,
        [],
        fixtures.SCRIPTED_SKILL_PATH,
      ),
      skill: fixtures.skillSnapshot(fixtures.SCRIPTED_SKILL_PATH),
      isolated: rolesOf(
        isolated("claude", fixtures.nativeDefaultModel.claude, [], fixtures.SCRIPTED_SKILL_PATH),
      ),
      sources: [],
    },
    requiresSave: false,
  },
};

const setupSignature = (selection: HarnessSelection) =>
  `${selection.harness}:${selection.reviewer.skillPath}:${selection.reviewer.model}`;

type ReadinessMode = MergeReadinessState | "error";

export interface MockHold {
  entered: Promise<void>;
  release: () => void;
  fail: (message: string) => void;
  drop: () => void;
}

export class MockBackend {
  settings = structuredClone(fixtures.settings);
  harness: HarnessSettings = { selection: null, sources: [] };
  requiresSave = true;
  harnessPreflight = false;
  setupState: DockerSetupStatus = {
    status: "not_started",
    harness: null,
    message: fixtures.SETUP_DISCLOSURE,
  };
  setupSignatures: Partial<Record<HarnessId, string>> = {};
  setupCalls = 0;
  setupBodies: unknown[] = [];
  inspectCalls = 0;
  inspected?: { request: DockerInspectRequest; disclosure: DockerCapabilityDisclosure };
  dockerApprovals: Partial<Record<HarnessId, DockerBoundarySnapshot>> = {};
  integrationConfigs: IntegrationConfig[] = [];
  evidence: Record<string, IntegrationTestResult> = {};
  nativeConfigBytes = { ...fixtures.nativeConfigBytes };
  skillBytes: Record<string, string> = {};
  health = structuredClone(fixtures.health);
  prs = structuredClone(fixtures.prs);
  runs = structuredClone(fixtures.runs);
  drafts = structuredClone(fixtures.drafts);
  proposals: Record<string, RevisionProposal[]> = {};
  submissions = structuredClone(fixtures.submissions);
  previews: Record<string, SubmissionPreview> = {};
  freshness: Record<string, Freshness | null> = {};
  questions: Record<string, Question[]> = {};
  checkCalls = 0;
  editIntentBodies: DraftEditIntent[] = [];
  autoSubmissionBodies: AutoSubmissionUpdate[] = [];
  humanAcknowledgments: HumanReviewAcknowledgment[] = [];
  autoReenableBodies: AutoSubmissionReenable[] = [];
  autoCheckCalls = 0;
  modelDiscoveryCalls: HarnessId[] = [];
  oauthStates: Record<string, MockOAuthState> = {};
  oauthActions: string[] = [];
  oauthConfigureBodies: unknown[] = [];
  oauthRegisterBodies: unknown[] = [];
  oauthApprovalBodies: unknown[] = [];
  pendingAuthorizations: Record<string, { nonce: string; expiresAt: string }> = {};
  leafCandidates = new Map<string, DockerLibraryLeaf>();
  exclusionCalls = 0;
  leafCalls: string[] = [];
  syncOperation: SyncOperation | null = null;
  importOperations = new Map<string, ImportOperation>();
  syncCalls = 0;
  importCalls: string[] = [];
  private syncInFlight: Promise<AppState> | null = null;
  private importInFlight = new Map<string, Promise<PullRequestDetail>>();
  private holds = new Map<string, { enter: () => void; work: Promise<void> }>();
  private listeners = new Set<Listener>();
  private counter = 100;
  private clock = Date.now();

  constructor(public options: MockOptions = {}) {
    if (options.emptySetup) {
      this.settings.repository = "";
      this.settings.automation = { ...automationOff };
      this.prs = [];
      this.health.lastPollAt = null;
    }
    if (options.emptySetup) this.settings.autoSubmission!.repository = "";
    if (options.autoSubmission) {
      const pr = this.prs.find((item) => item.id === "pr-482")!;
      pr.autoSubmission = fixtures.autoSubmissionState(
        options.autoSubmission === "unavailable"
          ? "unavailable"
          : options.autoSubmission === "off-hold"
            ? "off"
            : "human_review_requested",
        pr.headSha,
      );
    }
    if (options.editIntent) delete this.drafts["pr-482"]![0]!.autoSubmission;
    const seed =
      harnessSeed[options.harness === "unavailable" ? "saved" : (options.harness ?? "saved")];
    this.harness = structuredClone(seed.settings);
    this.requiresSave = seed.requiresSave;
    const selection = currentSelection(this.harness.selection);
    if (selection) {
      this.settings.reviewer = { ...this.settings.reviewer, ...selection.reviewer };
      if (this.harness.managed?.[selection.harness])
        this.setupSignatures[selection.harness] = setupSignature(selection);
      if (seed.approved && selection.version === 2)
        this.dockerApprovals[selection.harness] = fixtures.dockerBoundary(
          selection.harness,
          this.harness.skill!,
          selection.reviewer.model!,
        );
    }
    if (options.readProviders) {
      this.integrationConfigs = structuredClone(fixtures.importedReadConfigs);
      this.settings.integrations.importedHarnessAt = new Date(this.clock).toISOString();
      if (options.readProviders === "enabled")
        for (const config of this.integrationConfigs) {
          config.enabled = true;
          config.allowedTools = this.definition(config).tools.map((tool) => tool.id);
        }
    }
    if (options.history) {
      this.runs["pr-482"] = [
        ...(this.runs["pr-482"] ?? []),
        ...structuredClone(fixtures.historyRuns),
      ];
      this.questions["pr-482"] = structuredClone(fixtures.historyQuestions);
    }
    if (options.native) {
      this.discoverIntegrations({ harness: "claude" });
      const documents = this.integrationConfigs.find(
        (config) => config.native?.name === "documents",
      )!;
      if (options.native !== "discovered")
        this.importNativeIntegration({
          id: documents.id,
          profileId: fixtures.knownProfile.id,
          scope: ["fixture-document"],
        });
      if (options.native === "loaded" || options.native === "enabled")
        this.loadIntegrationTools(documents.id);
      if (options.native === "enabled")
        this.updateIntegration(documents.id, { enabled: true, allowedTools: ["document"] });
    }
    const oauthMode = options.oauth ?? (options.oauthScopes ? "authorizing" : undefined);
    if (oauthMode) {
      const storage = this.options.oauthStorage;
      this.options = { ...this.options, oauthStorage: undefined };
      this.discoverIntegrations({ harness: "claude", path: fixtures.PLUGIN_MCP_PATH });
      const linear = options.oauthProvider === "linear";
      const axiom = options.oauthProvider === "axiom";
      const slack = this.integrationConfigs.find(
        (config) => config.native?.name === (axiom ? "axiom" : linear ? "linear-server" : "slack"),
      )!;
      const steps: OAuthMode[] = [
        "metadata",
        "imported",
        "discovered",
        "configured",
        "authorizing",
        "authenticated",
        "reconnect",
      ];
      const reach = steps.indexOf(oauthMode);
      if (reach >= 1)
        this.importOAuthIntegration({
          id: slack.id,
          profileId: (axiom
            ? fixtures.axiomOAuthProfile
            : linear
              ? fixtures.linearOAuthProfile
              : fixtures.slackOAuthProfile
          ).id,
        });
      if (reach >= 2) this.oauthAction(slack.id, "discover", {});
      if (reach >= 3)
        this.oauthAction(slack.id, "configure", {
          clientId: "mock-app-owned-client",
          ...(linear || axiom
            ? { clientAuthMethod: "none" }
            : { clientAuthMethod: "client_secret_post", clientSecret: "MOCK_SECRET_NEVER_SHOWN" }),
          scopes: axiom
            ? this.oauthStates[slack.id]!.discovery!.scopes
            : [this.oauthStates[slack.id]!.discovery!.scopes[0]!],
          discoveryDigest: this.oauthStates[slack.id]!.discovery!.digest,
          ...(options.oauthCallback ? { redirectUri: OAUTH_FIXED_REDIRECT_URI } : {}),
        });
      if (reach >= 4) this.oauthAction(slack.id, "connect", {});
      if (reach >= 5) this.completeOAuthCallback(slack.id);
      if (reach >= 6) this.oauthStates[slack.id]!.state = "reconnect_required";
      if (options.oauthScopes && reach === 4)
        try {
          this.completeOAuthCallback(slack.id, "success", OAUTH_SCOPE_CASES[options.oauthScopes]);
        } catch (error) {
          if (!(error instanceof MockError)) throw error;
        }
      this.options = { ...this.options, oauthStorage: storage };
      this.oauthActions.length = 0;
      this.oauthConfigureBodies.length = 0;
      this.oauthRegisterBodies.length = 0;
      this.oauthApprovalBodies.length = 0;
    }
  }

  private selection(): HarnessSelection | null {
    return currentSelection(this.harness.selection);
  }

  private boundaryAvailable() {
    return (
      this.executionStatus().status === "configured" ||
      (this.selection()?.version === 3 && !this.requiresSave)
    );
  }

  get integrations(): IntegrationCatalog {
    const boundary = this.boundaryAvailable();
    const connections = this.integrationConfigs
      .filter((config) => config.native || config.readProvider || config.oauthProfileId)
      .map((config) => this.connection(this.definition(config), structuredClone(config), boundary));
    return {
      profiles: [structuredClone(fixtures.knownProfile)],
      oauthProfiles: structuredClone(fixtures.oauthProfiles),
      connections,
      discoveredAt: this.settings.integrations.importedHarnessAt ?? "",
      boundary: {
        status: boundary ? "available" : "unavailable",
        message:
          this.selection()?.workflow === "dangerous"
            ? "Dangerous host tools and credentials are unrestricted by these read-integration permissions and can publish without the app preview."
            : boundary
              ? "Selected execution supports captured audited reads, not live connection or containment evidence."
              : "Save supported Isolated settings or set up Docker for gateway reads. Dangerous native tools are independent.",
      },
    };
  }

  private oauthProfile(config: IntegrationConfig) {
    return fixtures.oauthProfiles.find((profile) => profile.id === config.oauthProfileId);
  }

  private oauthReadTools(config: IntegrationConfig) {
    return config.oauthProfileId === fixtures.axiomOAuthProfile.id
      ? fixtures.mockAxiomReadTools
      : config.oauthProfileId === fixtures.linearOAuthProfile.id
        ? fixtures.mockLinearReadTools
        : fixtures.mockSlackReadTools;
  }

  private definition(config: IntegrationConfig): IntegrationDefinition {
    const oauthProfile = this.oauthProfile(config);
    if (oauthProfile)
      return {
        id: config.id,
        provider: "custom",
        label: config.serverName ?? config.id,
        transport: "mcp-http",
        authReuse: oauthProfile.readSupport === "supported" ? "host-session" : "none",
        identity: config.endpoint ?? config.id,
        tools:
          oauthProfile.readSupport === "supported"
            ? this.oauthReadTools(config)
                .filter(
                  (tool) =>
                    config.inventory?.status === "loaded" &&
                    config.inventory.tools.some((item) => item.name === tool.id),
                )
                .map((tool) => ({
                  ...tool,
                  operation: "read" as const,
                  toolNames: [tool.id],
                  schemaFingerprint: `mock-${tool.id}`,
                  allowedMethods: [],
                  argumentPolicy: "bounded" as const,
                }))
            : [],
        supported: oauthProfile.readSupport === "supported",
        compatibilityMessage: oauthProfile.message,
      };
    const known = config.readProvider
      ? fixtures.readProviderDefinitions.find(
          (item) => item.id === (config.readProvider?.native ? "custom:documents" : config.id),
        )
      : undefined;
    if (known)
      return {
        ...known,
        id: config.id,
        ...(config.native
          ? { label: config.serverName ?? config.id, identity: config.endpoint ?? config.id }
          : {}),
      };
    return {
      id: config.id,
      provider: "custom",
      label: config.serverName ?? config.id,
      transport: config.native?.transport === "stdio" ? "mcp-stdio" : "mcp-http",
      authReuse: "none",
      identity: config.endpoint ?? config.id,
      tools: [],
      supported: false,
      compatibilityMessage:
        config.native?.message ?? "Bind a supported profile before granting tools.",
    };
  }

  private connection(
    definition: IntegrationDefinition,
    config: IntegrationConfig,
    boundary: boolean,
  ): IntegrationConnection {
    const supported = definition.supported;
    const loaded =
      !(config.native || config.oauthProfileId) || config.inventory?.status === "loaded";
    const effective = config.enabled && supported && loaded && boundary;
    const message = !supported
      ? definition.compatibilityMessage!
      : !loaded
        ? "Explicitly Load tools. New or changed tools default denied."
        : !config.enabled
          ? "Configured, not connected. Disabled for review context."
          : !boundary
            ? "Save supported Isolated settings or set up Docker before using gateway reads."
            : "Configured captured read permissions, not verified connected. Test connection separately.";
    return {
      definition,
      config,
      status: !supported
        ? config.native?.support === "supported"
          ? "configured"
          : "unsupported"
        : !loaded || (config.enabled && !boundary)
          ? "needs_compatibility"
          : "configured",
      effective: effective ? "restricted" : "disabled",
      message,
      tools: definition.tools.map((tool) => ({
        id: tool.id,
        label: tool.label,
        state: !config.allowedTools.includes(tool.id)
          ? "disabled"
          : effective
            ? "allowed"
            : "unsupported",
        reason: message,
      })),
      ...(this.evidence[config.id] ? { evidence: structuredClone(this.evidence[config.id]) } : {}),
      ...(this.oauthProfile(config) && this.oauthStates[config.id]
        ? { oauth: this.oauthStatus(config.id) }
        : {}),
    };
  }

  private scopeReview(id: string) {
    const state = this.oauthStates[id]!;
    const review = state.review?.preview;
    return review &&
      review.generation === state.generation &&
      Date.parse(review.expiresAt) > Date.parse(this.now())
      ? review
      : undefined;
  }

  oauthStatus(id: string): McpOAuthStatus {
    const state = this.oauthStates[id]!;
    const storage = this.options.oauthStorage ?? undefined;
    const review = this.scopeReview(id);
    return {
      profileId: state.profileId,
      configured: Boolean(state.clientId),
      authenticated: state.state === "authenticated",
      evidence:
        storage === undefined
          ? "synthetic_transport"
          : state.state === "authenticated"
            ? "live_authentication"
            : "local_configuration",
      storage:
        storage === undefined ? "synthetic" : storage === "keychain" ? "macos-keychain" : storage,
      state: state.state,
      message:
        state.state === "authenticated"
          ? "OAuth authenticated. Identity and scoped read are not verified; no tools are enabled by authentication."
          : review?.status === "approval_required"
            ? "Additional credential capabilities need exact local approval. Authentication and read permissions remain disabled."
            : review?.status === "missing_required"
              ? "Required permissions are missing. View the local scope disclosure; additional capabilities cannot replace them."
              : state.state === "reconnect_required"
                ? "Reconnect required. Expired, interrupted or ambiguous authentication cannot be retried during a review."
                : "Explicit discovery, client configuration and Connect are separate from read permissions and Test.",
      ...(state.discovery ? { discovery: structuredClone(state.discovery) } : {}),
      ...(state.clientId
        ? { clientId: state.clientId, clientAuthMethod: state.clientAuthMethod }
        : {}),
      redirectUri: state.redirectUri ?? OAUTH_REDIRECT_URI,
      appRedirectUri: OAUTH_REDIRECT_URI,
      callbackMode:
        state.redirectUri && state.redirectUri !== OAUTH_REDIRECT_URI ? "fixed-loopback" : "app",
      scopes: [...state.scopes],
      generation: state.generation,
      identity: null,
      remoteRevocation: state.remoteRevocation,
      ...(review ? { scopeReview: { status: review.status, expiresAt: review.expiresAt } } : {}),
    };
  }

  private oauthReplaceable(id: string) {
    const state = this.oauthStates[id];
    return (
      !state ||
      (!state.clientId && !state.pending && !["authenticated", "authorizing"].includes(state.state))
    );
  }

  private invalidateOAuthGrants(id: string) {
    const config = this.integrationConfigs.find((item) => item.id === id);
    if (config) Object.assign(config, { enabled: false, allowedTools: [], inventory: undefined });
    delete this.evidence[id];
  }

  addOAuthIntegration(body: unknown): IntegrationCatalog {
    const value = (body ?? {}) as { profileId?: unknown };
    const profile = fixtures.oauthProfiles.find((item) => item.id === value.profileId);
    if (!profile || Object.keys(value).some((key) => key !== "profileId"))
      throw new MockError(409, "Choose a reviewed OAuth provider", "oauth_unsupported");
    const id = `oauth:${profile.id}`;
    if (this.integrationConfigs.some((item) => item.id === id)) return this.integrations;
    this.integrationConfigs.push({
      id,
      oauthProfileId: profile.id,
      enabled: false,
      allowedTools: [],
      source: "custom",
      endpoint: profile.endpoint,
      serverName: profile.label,
      authRef: null,
      configPath: null,
    });
    this.oauthStates[id] = {
      profileId: profile.id,
      state: "needs_discovery",
      scopes: [],
      generation: this.id("generation"),
      pending: false,
      remoteRevocation: "not_attempted",
    };
    this.emit();
    return this.integrations;
  }

  importOAuthIntegration(body: unknown): IntegrationCatalog {
    const value = (body ?? {}) as { id?: unknown; profileId?: unknown };
    if (
      Object.keys(value).some((key) => !["id", "profileId"].includes(key)) ||
      typeof value.id !== "string" ||
      typeof value.profileId !== "string"
    )
      throw new MockError(409, OAUTH_UNAVAILABLE_MESSAGE, "oauth_unavailable");
    const config = this.integrationConfigs.find((item) => item.id === value.id);
    const profile = fixtures.oauthProfiles.find((item) => item.id === value.profileId);
    if (
      !config?.native ||
      !profile ||
      config.endpoint !== profile.endpoint ||
      config.readProvider ||
      config.native.authentication !== "app-owned-oauth" ||
      !this.oauthReplaceable(config.id)
    )
      throw new MockError(
        409,
        "Discover exact trusted HTTP MCP metadata and choose a matching OAuth profile; existing bearer providers are not converted",
        "oauth_unsupported",
      );
    this.oauthStates[config.id] = {
      profileId: profile.id,
      state: "needs_discovery",
      scopes: [],
      generation: this.id("generation"),
      pending: false,
      remoteRevocation: "not_attempted",
    };
    Object.assign(config, { oauthProfileId: profile.id });
    this.invalidateOAuthGrants(config.id);
    this.emit();
    return this.integrations;
  }

  oauthAction(
    id: string,
    action: string,
    body: unknown,
  ): McpOAuthStatus | McpOAuthConnectResult | McpOAuthScopePreview {
    const value = (body ?? {}) as Record<string, unknown>;
    const fields =
      action === "accept-scopes"
        ? ["previewId", "generation", "additionalScopes", "consent"]
        : action === "configure"
          ? [
              "clientId",
              "clientAuthMethod",
              "clientSecret",
              "scopes",
              "discoveryDigest",
              "redirectUri",
            ]
          : action === "register"
            ? ["consent", "clientAuthMethod", "scopes", "discoveryDigest", "redirectUri"]
            : [];
    const unavailable = () => new MockError(409, OAUTH_UNAVAILABLE_MESSAGE, "oauth_unavailable");
    if (
      ![
        "discover",
        "configure",
        "register",
        "connect",
        "cancel",
        "disconnect",
        "scope-preview",
        "accept-scopes",
      ].includes(action) ||
      Object.keys(value).some((key) => !fields.includes(key))
    )
      throw unavailable();
    const config = this.integrationConfigs.find((item) => item.id === id);
    const state = this.oauthStates[id];
    if (!["cancel", "disconnect"].includes(action) && (!config?.oauthProfileId || !state))
      throw new MockError(409, "Import supported OAuth metadata first", "oauth_unsupported");
    if (!state) throw unavailable();
    this.oauthActions.push(action);
    const consentInvalid = () =>
      new MockError(
        409,
        OAUTH_SCOPE_MESSAGES.oauth_scope_consent_invalid,
        "oauth_scope_consent_invalid",
      );
    const reviewable = () => {
      const review = this.scopeReview(id);
      if (!review || this.options.oauthScopes === "browser") {
        if (state.review && !review) delete state.review;
        throw consentInvalid();
      }
      return review;
    };
    if (action === "scope-preview") return structuredClone(reviewable());
    this.invalidateOAuthGrants(id);
    const profile = fixtures.oauthProfiles.find((item) => item.id === state.profileId)!;
    const storage = () => {
      if (this.options.oauthStorage === "unsupported")
        throw new MockError(
          409,
          "Credential storage is unsupported on this host",
          "credential_store_unsupported",
        );
      if (this.options.oauthStorage === "unavailable")
        throw new MockError(
          409,
          "Credential storage is locked or unavailable",
          "credential_store_unavailable",
        );
    };
    const setup = () => {
      const scopes = value.scopes as unknown;
      if (
        !state.discovery ||
        value.discoveryDigest !== state.discovery.digest ||
        !state.discovery.clientAuthMethods.includes(
          value.clientAuthMethod as McpClientAuthMethod,
        ) ||
        !Array.isArray(scopes) ||
        scopes.length < 1 ||
        scopes.length > 32 ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => !state.discovery!.scopes.includes(scope as string)) ||
        ["authenticated", "authorizing"].includes(state.state)
      )
        throw unavailable();
      return scopes as string[];
    };
    const finish = () => {
      this.emit();
      return this.oauthStatus(id);
    };
    if (action === "accept-scopes") {
      const review = reviewable();
      const additional = value.additionalScopes;
      if (
        review.status !== "approval_required" ||
        !state.review?.held ||
        state.state !== "authorizing" ||
        value.previewId !== review.id ||
        value.generation !== state.generation ||
        value.consent !== OAUTH_SCOPE_CONSENT ||
        !Array.isArray(additional) ||
        additional.length !== review.additionalScopes.length ||
        additional.some((scope, i) => scope !== review.additionalScopes[i])
      )
        throw consentInvalid();
      state.review.held = false;
      try {
        storage();
      } catch (error) {
        delete state.review;
        state.state = "reconnect_required";
        this.emit();
        throw error;
      }
      this.oauthApprovalBodies.push(structuredClone(body));
      state.state = "authenticated";
      review.status = "accepted";
      return finish();
    }
    if (action === "discover") {
      if (["authenticated", "authorizing"].includes(state.state)) throw unavailable();
      state.discovery = fixtures.oauthDiscovery(
        profile,
        this.now(),
        this.options.oauthMethods === "public",
      );
      state.state = state.clientId ? "disconnected" : "needs_client";
      return finish();
    }
    if (action === "configure") {
      const scopes = setup();
      const secret = value.clientSecret;
      const method = value.clientAuthMethod as McpClientAuthMethod;
      if (
        typeof value.clientId !== "string" ||
        !clientIdPattern.test(value.clientId) ||
        (method !== "none" && (typeof secret !== "string" || !secret || /[\r\n\0]/.test(secret))) ||
        (method === "none" && secret !== undefined)
      )
        throw unavailable();
      const redirectUri = oauthRedirect(value.redirectUri, state.redirectUri);
      storage();
      this.oauthConfigureBodies.push(structuredClone(body));
      Object.assign(state, {
        clientId: value.clientId,
        clientAuthMethod: method,
        redirectUri,
        scopes,
        state: "disconnected",
        generation: this.id("generation"),
        pending: false,
      });
      return finish();
    }
    if (action === "register") {
      const scopes = setup();
      if (
        value.consent !== "Register a new MCP OAuth client" ||
        !state.discovery!.dynamicRegistration ||
        !profile.dynamicRegistration ||
        state.clientId ||
        state.pending
      )
        throw unavailable();
      const redirectUri = oauthRedirect(value.redirectUri, state.redirectUri);
      storage();
      this.oauthRegisterBodies.push(structuredClone(body));
      Object.assign(state, {
        clientId: `registered-${state.generation}`,
        clientAuthMethod: value.clientAuthMethod,
        redirectUri,
        scopes,
        state: "disconnected",
        pending: false,
      });
      return finish();
    }
    if (action === "connect") {
      if (!state.discovery || !state.clientId) throw unavailable();
      storage();
      if (
        this.options.oauthCallback === "occupied" &&
        state.redirectUri &&
        state.redirectUri !== OAUTH_REDIRECT_URI
      )
        throw new MockError(409, OAUTH_CALLBACK_UNAVAILABLE_MESSAGE, "oauth_callback_unavailable");
      state.generation = this.id("generation");
      state.state = "authorizing";
      state.pending = false;
      delete state.review;
      const nonce = this.id("nonce");
      const expiresAt = new Date(Date.parse(this.now()) + 300_000).toISOString();
      this.pendingAuthorizations[id] = { nonce, expiresAt };
      const url = new URL(state.discovery.authorizationEndpoint);
      url.searchParams.set("client_id", state.clientId);
      url.searchParams.set("redirect_uri", state.redirectUri ?? OAUTH_REDIRECT_URI);
      url.searchParams.set("state", nonce);
      url.searchParams.set("code_challenge_method", "S256");
      this.emit();
      return { authorizationUrl: url.toString(), expiresAt, status: this.oauthStatus(id) };
    }
    if (action === "cancel") {
      state.generation = this.id("generation");
      state.state = "disconnected";
      delete state.review;
      delete this.pendingAuthorizations[id];
      return finish();
    }
    state.generation = this.id("generation");
    delete state.review;
    delete this.pendingAuthorizations[id];
    state.remoteRevocation = state.clientId
      ? (this.options.oauthRevocation ?? "unsupported")
      : "not_attempted";
    if (this.options.oauthStorage === "unavailable") {
      state.pending = true;
      state.state = state.discovery ? "needs_client" : "needs_discovery";
      this.emit();
      throw new MockError(
        409,
        "Credential storage is locked or unavailable",
        "credential_store_unavailable",
      );
    }
    Object.assign(state, {
      clientId: undefined,
      clientAuthMethod: undefined,
      redirectUri: undefined,
      scopes: [],
      pending: false,
      state: state.discovery ? "needs_client" : "needs_discovery",
    });
    return finish();
  }

  reviewContinuation(): string {
    const pending = Object.values(this.oauthStates).find((state) => state.review)?.review;
    return this.options.oauthReturn === "stale" || !pending
      ? "mock-stale-continuation"
      : pending.preview.id;
  }

  reviewReturn(body: unknown): McpOAuthReviewReturn {
    const value = (body ?? {}) as Record<string, unknown>;
    const invalid = () =>
      new MockError(
        409,
        OAUTH_SCOPE_MESSAGES.oauth_scope_consent_invalid,
        "oauth_scope_consent_invalid",
      );
    if (Object.keys(value).length !== 1 || typeof value.continuation !== "string") throw invalid();
    const id = Object.keys(this.oauthStates).find(
      (item) => this.oauthStates[item]!.review?.preview.id === value.continuation,
    );
    const state = id ? this.oauthStates[id] : undefined;
    const review = id ? this.scopeReview(id) : undefined;
    if (!state || !review || state.review!.returned || this.options.oauthScopes === "browser")
      throw invalid();
    state.review!.returned = true;
    return {
      connectionId: review.connectionId,
      generation: review.generation,
      status: review.status,
      expiresAt: review.expiresAt,
    };
  }

  completeOAuthCallback(
    id: string,
    outcome: "success" | "failure" = "success",
    scope?: string | null,
  ): McpOAuthScopePreview["status"] | undefined {
    const state = this.oauthStates[id];
    const transaction = this.pendingAuthorizations[id];
    if (!state || state.state !== "authorizing" || !transaction)
      throw new MockError(409, "OAuth transaction no longer active", "oauth_callback_failed");
    delete this.pendingAuthorizations[id];
    this.invalidateOAuthGrants(id);
    if (outcome !== "success" || scope === undefined) {
      state.state = outcome === "success" ? "authenticated" : "reconnect_required";
      this.emit();
      return undefined;
    }
    let grantedScopes: string[];
    try {
      grantedScopes =
        scope === null
          ? [...state.scopes]
          : decodeMockOAuthScopes(scope, state.profileId === fixtures.axiomOAuthProfile.id);
    } catch (error) {
      state.state = "reconnect_required";
      this.emit();
      throw error;
    }
    const missingScopes = state.scopes.filter((item) => !grantedScopes.includes(item));
    const additionalScopes = grantedScopes.filter((item) => !state.scopes.includes(item));
    const status = missingScopes.length
      ? "missing_required"
      : additionalScopes.length
        ? "approval_required"
        : "accepted";
    state.review = {
      preview: {
        id: this.id("scope-preview"),
        connectionId: id,
        generation: state.generation,
        clientId: state.clientId!,
        issuer: state.discovery!.issuer,
        resource: state.discovery!.resource,
        redirectUri: state.redirectUri ?? OAUTH_REDIRECT_URI,
        expiresAt: transaction.expiresAt,
        source: scope === null ? "requested_fallback" : "provider",
        status,
        requestedScopes: [...state.scopes],
        grantedScopes,
        missingScopes,
        additionalScopes,
      },
      held: status === "approval_required",
    };
    if (status === "accepted") state.state = "authenticated";
    this.emit();
    return status;
  }

  private captureReviewer(): ReviewerSettings {
    const selection = this.selection();
    if (!selection || this.requiresSave)
      throw new MockError(
        409,
        "The saved execution choice is archived or unsaved and cannot run. Save current Settings, then start a new review or an independent question.",
        "execution_incompatible",
      );
    if (selection.version === 3 && this.harness.isolated)
      return {
        ...this.settings.reviewer,
        model: this.harness.isolated.main.model,
        skillExecution: {
          version: 3,
          mode: "separated",
          harness: selection.harness,
          skill: this.harness.skill!,
          policy: this.harness.isolated.main.policy,
          roles: structuredClone(this.harness.isolated),
        },
      };
    const source = this.harness.sources.find(
      (item) => item.id === this.harness.managed?.[selection.harness],
    );
    if (selection.workflow === "docker" && source && !this.dockerApprovals[selection.harness])
      throw new MockError(409, fixtures.DOCKER_LEGACY_ARTIFACT_MESSAGE, "execution_incompatible");
    return {
      ...this.settings.reviewer,
      skillExecution: {
        version: 2,
        mode: selection.workflow,
        harness: selection.harness,
        skill: this.harness.skill!,
      },
      ...(selection.workflow === "docker" && source
        ? {
            execution: {
              ...fixtures.executionSnapshot(source),
              version: 2 as const,
              ...(this.dockerApprovals[selection.harness]
                ? { docker: structuredClone(this.dockerApprovals[selection.harness]) }
                : {}),
            },
          }
        : {}),
      ...(selection.workflow === "dangerous" && this.harness.dangerousConsent
        ? { hostExecution: this.harness.dangerousConsent }
        : {}),
    };
  }

  executionStatus(): ExecutionStatus {
    const selection = this.selection();
    if (!selection)
      return { status: "unavailable", message: fixtures.ARCHIVED_MESSAGE, snapshot: null };
    if (this.requiresSave)
      return { status: "unavailable", message: fixtures.REQUIRES_SAVE_MESSAGE, snapshot: null };
    if (selection.workflow === "separated") {
      const incompatible = selection.reviewer.skillPath === fixtures.SCRIPTED_SKILL_PATH;
      return {
        status: incompatible ? "unavailable" : "disabled",
        message: incompatible ? fixtures.SCRIPTED_SKILL_MESSAGE : fixtures.ISOLATED_MESSAGE,
        snapshot: null,
      };
    }
    if (selection.workflow === "dangerous")
      return {
        status:
          this.harness.dangerousConsent?.harness === selection.harness ? "disabled" : "unavailable",
        message: fixtures.DANGEROUS_MESSAGE,
        snapshot: null,
      };
    const managedId = this.harness.managed?.[selection.harness];
    const source = this.harness.sources.find((item) => item.id === managedId);
    if (!source)
      return {
        status: "unavailable",
        message: fixtures.DOCKER_SETUP_REQUIRED_MESSAGE,
        snapshot: null,
      };
    const docker = this.dockerApprovals[selection.harness];
    if (this.setupSignatures[selection.harness] !== setupSignature(selection))
      return {
        status: "unavailable",
        message: fixtures.DOCKER_SETUP_STALE_MESSAGE,
        snapshot: null,
        ...(docker ? { lastApprovedDocker: structuredClone(docker) } : {}),
      };
    if (!docker)
      return {
        status: "unavailable",
        message: fixtures.DOCKER_LEGACY_ARTIFACT_MESSAGE,
        snapshot: { ...fixtures.executionSnapshot(source), version: 2 },
      };
    return {
      status: "configured",
      lastApprovedDocker: structuredClone(docker),
      message:
        "Managed Docker source validated locally for the saved selection; not verified connected to any provider.",
      snapshot: {
        ...fixtures.executionSnapshot(source),
        version: 2,
        docker: structuredClone(docker),
      },
    };
  }

  harnessStatus(): HarnessStatus {
    if (this.options.harness === "unavailable")
      throw new MockError(
        409,
        "Configured workflow management is unavailable",
        "execution_unavailable",
      );
    const selection = this.selection();
    const archived = !selection ? this.harness.selection : null;
    const execution = this.executionStatus();
    const managed = selection && this.harness.managed?.[selection.harness];
    return structuredClone({
      selection,
      archivedSelection: archived
        ? {
            version: archived.version,
            harness: archived.harness,
            workflow: archived.workflow,
            reviewer: archived.reviewer,
          }
        : null,
      requiresSave: this.requiresSave,
      reviewer: selection?.reviewer ??
        archived?.reviewer ?? {
          skillPath: this.settings.reviewer.skillPath,
          model: this.settings.reviewer.model,
        },
      mode: selection?.workflow ?? null,
      setup:
        this.setupState.status === "not_started" && managed
          ? { status: "ready", harness: selection.harness, message: fixtures.SETUP_READY_MESSAGE }
          : this.setupState,
      effective: execution.status === "unavailable" ? null : selection,
      options: fixtures.harnessOptions,
      capabilities:
        selection?.version === 3 && this.harness.isolated
          ? [this.harness.isolated.main, ...this.harness.isolated.additional].flatMap((entry) =>
              entry.policy ? [{ id: entry.id, policy: entry.policy }] : [],
            )
          : [],
      diagnostics: [execution.message],
      evidence: this.harnessPreflight ? "synthetic_preflight" : "unverified",
    });
  }

  selectHarness(body: unknown): HarnessStatus {
    const value = (body ?? {}) as Partial<HarnessSelectionUpdate> & Record<string, unknown>;
    const reviewer = value.reviewer as Partial<ReviewerSettings> | undefined;
    const additional = value.additional as unknown;
    const shapeValid =
      Object.keys(value).every((key) =>
        ["version", "harness", "workflow", "reviewer", "additional", "confirmation"].includes(key),
      ) &&
      harnessIds.includes(value.harness as string) &&
      reviewer !== undefined &&
      Object.keys(reviewer).every((key) => ["skillPath", "model"].includes(key)) &&
      typeof reviewer.skillPath === "string" &&
      validModel(reviewer.model) &&
      (value.confirmation === undefined ||
        (value.workflow === "dangerous" && typeof value.confirmation === "string")) &&
      ((value.version === 2 &&
        ["docker", "dangerous"].includes(value.workflow as string) &&
        additional === undefined) ||
        (value.version === 3 &&
          value.workflow === "separated" &&
          Array.isArray(additional) &&
          additional.length <= 8 &&
          additional.every(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              Object.keys(entry).every((key) => ["id", "harness", "model"].includes(key)) &&
              typeof entry.id === "string" &&
              entry.id !== "main" &&
              validId.test(entry.id) &&
              harnessIds.includes(entry.harness) &&
              validModel(entry.model),
          ) &&
          new Set(additional.map((entry) => entry.id)).size === additional.length));
    if (!shapeValid)
      throw new MockError(
        400,
        "Select a supported harness/workflow. Version 3 requires separated, a Main reviewer and 0-8 Additional entries with unique ids (not main), supported harnesses and model ids or null. Version 2 accepts only Docker/Dangerous. Historical shapes and source ids are unsupported.",
        "invalid_harness",
      );
    if (value.workflow === "dangerous" && value.confirmation !== dangerousConfirmation)
      throw new MockError(400, dangerousConfirmation, "dangerous_confirmation_required");
    const skillPath = reviewer!.skillPath!;
    if (!skillPath.startsWith("/") || !skillPath.toLowerCase().endsWith(".md"))
      throw new MockError(409, fixtures.INVALID_SKILL_MESSAGE, "skill_incompatible");
    if (skillPath === fixtures.MISSING_SKILL_PATH)
      throw new MockError(409, `Selected skill is missing: ${skillPath}`, "skill_incompatible");
    const harness = value.harness as HarnessId;
    const model = reviewer!.model ?? fixtures.nativeDefaultModel[harness];
    const selection: HarnessSelection =
      value.version === 3
        ? isolated(
            harness,
            model,
            (additional as IsolatedHarnessSelection["additional"]).map((entry) => ({
              id: entry.id,
              harness: entry.harness,
              model: entry.model ?? fixtures.nativeDefaultModel[entry.harness],
            })),
            skillPath,
          )
        : native(value.workflow as NativeHarnessSelection["workflow"], harness, skillPath, model);
    this.harness = {
      ...this.harness,
      selection,
      skill: fixtures.skillSnapshot(skillPath, this.skillBytes[skillPath]),
      isolated: selection.version === 3 ? rolesOf(selection, this.nativeConfigBytes) : undefined,
      ...(selection.workflow === "dangerous"
        ? { dangerousConsent: { version: 1 as const, harness, confirmedAt: this.now() } }
        : {}),
    };
    this.requiresSave = false;
    this.settings.reviewer = { ...this.settings.reviewer, ...selection.reviewer };
    this.harnessPreflight = false;
    this.inspected = undefined;
    this.leafCandidates.clear();
    this.emit();
    return this.harnessStatus();
  }

  discoverModels(body: unknown): HarnessModelDiscovery | Promise<HarnessModelDiscovery> {
    const value = (body ?? {}) as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => key !== "harness") ||
      !harnessIds.includes(value.harness as string)
    )
      throw new MockError(400, "Provide only a supported harness", "invalid_model_discovery");
    if (this.options.models === "transport")
      throw new MockError(500, "Mock discovery transport failure", "internal_error");
    const harness = value.harness as HarnessId;
    this.modelDiscoveryCalls.push(harness);
    const selection = this.selection();
    const saved = [
      ...(selection && selection.harness === harness ? [selection.reviewer.model] : []),
      ...(selection?.version === 3
        ? selection.additional
            .filter((entry) => entry.harness === harness)
            .map((entry) => entry.model)
        : []),
    ].filter((model): model is string => typeof model === "string");
    const mode = this.options.models;
    const catalog = fixtures.modelDiscoveryCatalog[harness];
    const nativeStatus: HarnessModelSource["status"] =
      mode === "unsupported" ? "missing" : mode === "error" ? "error" : "ready";
    const models = new Map<string, HarnessModelDiscovery["models"][number]>();
    if (nativeStatus === "ready")
      for (const choice of catalog.models) models.set(choice.model, structuredClone(choice));
    for (const model of saved) {
      const existing = models.get(model);
      if (existing) existing.sources = [...existing.sources, "saved-selection"];
      else models.set(model, { model, label: model, sources: ["saved-selection"] });
    }
    const result: HarnessModelDiscovery = {
      harness,
      checkedAt: this.now(),
      status:
        nativeStatus === "ready"
          ? harness === "pi"
            ? "ready"
            : "partial"
          : models.size === 0
            ? nativeStatus === "missing"
              ? "unsupported"
              : "error"
            : "partial",
      availability: "not_checked",
      models: [...models.values()].sort((a, b) => (a.model < b.model ? -1 : 1)),
      sources: [
        ...catalog.sources.map((source) =>
          nativeStatus === "ready"
            ? structuredClone(source)
            : {
                ...source,
                status: nativeStatus,
                modifiedAt: null,
                message:
                  nativeStatus === "missing"
                    ? "Source file is missing."
                    : "Source could not be parsed; its choices are omitted.",
              },
        ),
        {
          id: "saved-selection",
          kind: "saved_selection",
          path: null,
          status: "ready",
          modifiedAt: null,
          freshness: "not_applicable",
          message: "Retained app selections, including custom IDs.",
        },
        fixtures.nativeCatalogSource(harness),
      ],
    };
    if (mode === "slow") return new Promise((resolve) => setTimeout(() => resolve(result), 1500));
    return result;
  }

  clearInspection() {
    this.inspected = undefined;
    this.leafCandidates.clear();
  }

  private savedDocker() {
    const selection = this.selection();
    return selection?.workflow === "docker" && !this.requiresSave ? selection : null;
  }

  discoverDockerExclusions(body: unknown) {
    if (Object.keys((body ?? {}) as object).length)
      throw new MockError(
        400,
        "Exclusion discovery accepts an empty object",
        "invalid_exclusion_discovery",
      );
    if (!this.savedDocker())
      throw new MockError(
        409,
        "Save Docker before discovering source-bound exclusions",
        "docker_selection_required",
      );
    this.exclusionCalls += 1;
    return {
      exclusions:
        this.options.exclusions === "none"
          ? []
          : structuredClone(fixtures.dockerExclusionCandidates),
      nativeSettingsUnchanged: true as const,
    };
  }

  discoverDockerLibraryLeaf(body: unknown): DockerLibraryLeaf {
    const value = (body ?? {}) as { source?: unknown };
    if (
      typeof value.source !== "string" ||
      value.source.length > 4096 ||
      Object.keys(value).some((key) => key !== "source")
    )
      throw new MockError(
        400,
        "Provide one declared installed skill leaf for metadata-only discovery",
        "invalid_library_leaf",
      );
    const selection = this.savedDocker();
    if (!selection)
      throw new MockError(409, "Save Docker before source discovery", "docker_selection_required");
    this.leafCalls.push(value.source);
    const failed = (message: string) => new MockError(409, message, "docker_library_leaf_failed");
    const root = value.source.slice(0, value.source.lastIndexOf("/"));
    const roots =
      selection.harness === "claude"
        ? [`${fixtures.HOME}/.claude/skills`]
        : [`${fixtures.HOME}/.agents/skills`, `${fixtures.HOME}/.${selection.harness}/skills`];
    if (!roots.includes(root) || !fixtures.libraryLeafTerminals[value.source])
      throw failed(fixtures.DOCKER_LEAF_UNSUPPORTED_MESSAGE);
    const leaf = fixtures.dockerLibraryLeaf(value.source);
    if (this.leafCandidates.size >= 8 && !this.leafCandidates.has(leaf.id))
      throw failed("At most eight leaf candidates may be held; save again to clear discovery");
    this.leafCandidates.set(leaf.id, leaf);
    return structuredClone(leaf);
  }

  inspectDocker(body: unknown): DockerCapabilityDisclosure {
    const value = (body ?? {}) as Record<string, unknown>;
    const ids = (key: "exclusions" | "libraryLeaves") => value[key] as unknown;
    if (
      Object.keys(value).some(
        (key) => !["harness", "localConnections", "exclusions", "libraryLeaves"].includes(key),
      ) ||
      !harnessIds.includes(value.harness as string) ||
      (value.localConnections !== undefined && !Array.isArray(value.localConnections)) ||
      (ids("exclusions") !== undefined &&
        (!Array.isArray(ids("exclusions")) ||
          (ids("exclusions") as unknown[]).some((id) => typeof id !== "string"))) ||
      (ids("libraryLeaves") !== undefined &&
        (!Array.isArray(ids("libraryLeaves")) ||
          (ids("libraryLeaves") as unknown[]).some((id) => typeof id !== "string")))
    )
      throw new MockError(
        400,
        "Provide a saved Docker harness and optional explicit local connection choices",
        "invalid_docker_inspection",
      );
    const request = value as unknown as DockerInspectRequest;
    const failed = (message: string) => new MockError(409, message, "docker_inspection_failed");
    const selection = this.selection();
    if (
      !selection ||
      selection.workflow !== "docker" ||
      selection.harness !== request.harness ||
      this.requiresSave
    )
      throw failed(fixtures.DOCKER_INSPECT_UNSAVED_MESSAGE);
    this.inspectCalls += 1;
    const skill = fixtures.skillSnapshot(
      selection.reviewer.skillPath,
      this.skillBytes[selection.reviewer.skillPath],
    );
    if (skill.digest !== this.harness.skill?.digest)
      throw failed(fixtures.DOCKER_SKILL_CHANGED_MESSAGE);
    const leafIds = request.libraryLeaves ?? [];
    if (leafIds.length > 8 || new Set(leafIds).size !== leafIds.length)
      throw failed("Select at most eight distinct server-observed installed leaf identities");
    const libraryLeaves = leafIds.map((id) => {
      const leaf = this.leafCandidates.get(id);
      if (!leaf) throw failed(fixtures.DOCKER_LEAF_STALE_MESSAGE);
      return leaf;
    });
    const exclusionIds = request.exclusions ?? [];
    if (exclusionIds.length > 32 || new Set(exclusionIds).size !== exclusionIds.length)
      throw failed("Choose exact distinct source-bound Docker exclusion ids");
    const exclusions = exclusionIds.map((id) => {
      const candidate =
        this.options.exclusions === "none"
          ? undefined
          : fixtures.dockerExclusionCandidates.find((item) => item.id === id);
      if (!candidate) throw failed(fixtures.DOCKER_EXCLUSION_STALE_MESSAGE);
      return candidate;
    });
    const locals = (request.localConnections ?? []) as DockerLocalMcpRequest[];
    if (locals.length > 8 || new Set(locals.map((item) => item.id)).size !== locals.length)
      throw failed("Declare at most eight distinct discovered Docker local connections");
    for (const local of locals) {
      const connection = this.integrationConfigs.find((config) => config.id === local.id);
      if (
        !connection?.native ||
        connection.native.transport !== "stdio" ||
        local.profileId !== fixtures.knownProfile.id ||
        !Array.isArray(local.scope) ||
        !local.scope.length ||
        local.scope.length > 100 ||
        local.scope.some((id) => !/^[A-Za-z0-9_-]{1,100}$/.test(id)) ||
        typeof local.enabled !== "boolean" ||
        !Array.isArray(local.allowedTools) ||
        local.allowedTools.some((id) => id !== fixtures.knownProfile.tool.id) ||
        Object.keys(local).some(
          (key) => !["id", "profileId", "scope", "enabled", "allowedTools"].includes(key),
        )
      )
        throw failed(fixtures.DOCKER_LOCAL_MCP_MESSAGE);
      if (!fixtures.dockerStdioEntries[local.id])
        throw failed(fixtures.DOCKER_STDIO_ADAPTER_MESSAGE);
    }
    const disclosure = fixtures.dockerDisclosure(
      selection.harness,
      skill,
      selection.reviewer.model!,
      locals,
      { exclusions, libraryLeaves },
    );
    this.inspected = { request: structuredClone(request), disclosure };
    return structuredClone(disclosure);
  }

  setupDocker(body: unknown): HarnessStatus | Promise<HarnessStatus> {
    const value = (body ?? {}) as { harness?: unknown; confirmation?: unknown; approval?: unknown };
    if (Object.keys(value).some((key) => !["harness", "confirmation", "approval"].includes(key)))
      throw new MockError(400, "Unexpected setup fields", "invalid_docker_setup");
    if (value.confirmation !== dockerSetupConfirmation)
      throw new MockError(400, dockerSetupConfirmation, "setup_confirmation_required");
    if (!harnessIds.includes(value.harness as string))
      throw new MockError(400, "Select claude, codex or pi", "invalid_harness");
    if (this.setupState.status === "running")
      throw new MockError(409, "Docker setup is already running", "docker_setup_failed");
    const harness = value.harness as HarnessId;
    this.setupCalls += 1;
    this.setupBodies.push(structuredClone(body));
    const fail = (message: string) => {
      this.setupState = { status: "failed", harness, message };
      this.emit();
      return new MockError(409, message, "docker_setup_failed");
    };
    const inspected = this.inspected;
    if (!inspected || inspected.request.harness !== harness)
      throw fail(fixtures.DOCKER_INSPECTION_REQUIRED_MESSAGE);
    const approval = value.approval as DockerCapabilityApproval | undefined;
    const same = (a: unknown, b: string[]) =>
      Array.isArray(a) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (
      !approval ||
      Object.keys(approval).some(
        (key) =>
          ![
            "digest",
            "customizations",
            "credentialExposures",
            "exclusions",
            "libraryLeaves",
            "confirmation",
          ].includes(key),
      ) ||
      approval.confirmation !== dockerApprovalConfirmation ||
      approval.digest !== inspected.disclosure.digest ||
      !same(
        approval.exclusions ?? [],
        (inspected.disclosure.exclusions ?? []).map((item) => item.id),
      ) ||
      !same(
        approval.libraryLeaves ?? [],
        (inspected.disclosure.libraryLeaves ?? []).map((item) => item.id),
      ) ||
      !same(
        approval.customizations,
        inspected.disclosure.customizations.map((item) => item.id),
      ) ||
      !same(
        approval.credentialExposures,
        inspected.disclosure.authentication.map((item) => item.harness),
      )
    )
      throw fail(fixtures.DOCKER_APPROVAL_MESSAGE);
    const approved: DockerBoundarySnapshot = {
      profile: "container-native-1",
      disclosure: structuredClone(inspected.disclosure),
      approval: structuredClone(approval),
    };
    const finish = (): HarnessStatus => {
      if (this.options.setup === "fail") {
        this.setupState = { status: "failed", harness, message: fixtures.SETUP_FAILED_MESSAGE };
        this.emit();
        throw new MockError(409, fixtures.SETUP_FAILED_MESSAGE, "docker_setup_failed");
      }
      const selection = this.selection();
      const skillPath =
        selection?.harness === harness
          ? selection.reviewer.skillPath
          : this.settings.reviewer.skillPath;
      const source = managedSource(harness, skillPath, this.now());
      this.harness.sources = [
        ...this.harness.sources.filter((item) => item.id !== source.id),
        source,
      ];
      this.harness.managed = { ...this.harness.managed, [harness]: source.id };
      this.dockerApprovals[harness] = approved;
      if (selection?.harness === harness && selection.version === 2)
        this.setupSignatures[harness] = setupSignature(selection);
      this.setupState = {
        status: "not_started",
        harness: null,
        message: fixtures.SETUP_DISCLOSURE,
      };
      this.emit();
      return this.harnessStatus();
    };
    if (this.options.setup !== "slow") return finish();
    this.setupState = {
      status: "running",
      harness,
      message: "Mock fixture: verifying cached runtime and running the Docker preflight",
    };
    this.emit();
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(finish());
        } catch (error) {
          reject(error);
        }
      }, 1500),
    );
  }

  checkExecution(): ExecutionStatus {
    const status = this.executionStatus();
    if (status.status !== "configured")
      throw new MockError(409, status.message, "execution_unavailable");
    this.harnessPreflight = true;
    this.emit();
    return {
      ...status,
      message:
        "Synthetic policy/runtime preflight passed. No credentials, model inference or external integrations were checked. Not verified connected.",
    };
  }

  discoverIntegrations(body: unknown): IntegrationCatalog {
    const value = (body ?? {}) as { harness?: unknown; path?: unknown };
    const unsupported = (detail: string) =>
      new MockError(
        409,
        `Native discovery failed: ${detail} Pi extension formats, project discovery and executable helpers are unsupported.`,
        "native_mcp_unsupported",
      );
    if (value.harness === "pi")
      throw unsupported(
        "Pi has no native MCP configuration format; use an absolute trusted Claude mcpServers JSON or Codex mcp_servers TOML source.",
      );
    if (value.harness !== "claude" && value.harness !== "codex")
      throw new MockError(
        400,
        "Expected harness and optional absolute native source path",
        "invalid_integration",
      );
    const defaultPath =
      value.harness === "claude" ? fixtures.CLAUDE_MCP_PATH : fixtures.CODEX_MCP_PATH;
    const path = value.path === undefined ? defaultPath : value.path;
    if (typeof path !== "string" || !path.startsWith("/"))
      throw unsupported(
        "use an absolute trusted Claude mcpServers JSON or Codex mcp_servers TOML source.",
      );
    if (
      path !== defaultPath &&
      path !== fixtures.EMPTY_MCP_PATH &&
      !(value.harness === "claude" && path === fixtures.PLUGIN_MCP_PATH)
    )
      throw unsupported(`mock fixture cannot read ${path}.`);
    const discovered =
      path === fixtures.EMPTY_MCP_PATH
        ? []
        : path === fixtures.PLUGIN_MCP_PATH
          ? structuredClone(fixtures.pluginDiscoveries)
          : structuredClone(fixtures.nativeDiscoveries[value.harness]);
    const replacements = discovered.filter((config) => {
      const previous = this.integrationConfigs.find((item) => item.id === config.id);
      return (
        !previous ||
        previous.endpoint !== config.endpoint ||
        JSON.stringify(previous.native) !== JSON.stringify(config.native)
      );
    });
    if (replacements.some((config) => !this.oauthReplaceable(config.id)))
      throw new MockError(
        409,
        "A discovered native definition changed. Disconnect that app-owned OAuth connection before replacing it; existing connections, credentials and grants remain unchanged.",
        "oauth_disconnect_required",
      );
    for (const config of replacements) {
      delete this.evidence[config.id];
      delete this.oauthStates[config.id];
    }
    this.integrationConfigs = [
      ...this.integrationConfigs.map(
        (item) => replacements.find((config) => config.id === item.id) ?? item,
      ),
      ...replacements.filter(
        (config) => !this.integrationConfigs.some((item) => item.id === config.id),
      ),
    ];
    this.settings.integrations.importedHarnessAt = this.now();
    this.emit();
    return this.integrations;
  }

  importNativeIntegration(body: unknown): IntegrationCatalog {
    const value = (body ?? {}) as { id?: unknown; profileId?: unknown; scope?: unknown };
    if (
      typeof value.id !== "string" ||
      typeof value.profileId !== "string" ||
      !Array.isArray(value.scope) ||
      value.scope.some((item) => typeof item !== "string")
    )
      throw new MockError(
        400,
        "Expected discovered id, known profileId and explicit resource scope",
        "invalid_integration",
      );
    const config = this.integrationConfigs.find((item) => item.id === value.id);
    if (!config) throw new MockError(404, "Discover the native connection first", "not_found");
    const scope = value.scope as string[];
    if (
      !config.native ||
      config.native.support !== "supported" ||
      config.native.authentication === "app-owned-oauth" ||
      value.profileId !== fixtures.knownProfile.id ||
      !config.endpoint ||
      new URL(config.endpoint).pathname !== fixtures.knownProfile.endpointPath
    )
      throw new MockError(
        409,
        "Connection does not match this supported known profile/transport; no permission was granted",
        "native_mcp_unsupported",
      );
    if (
      scope.length < 1 ||
      scope.length > 100 ||
      scope.some((item) => !/^[A-Za-z0-9_-]{1,100}$/.test(item))
    )
      throw new MockError(
        409,
        "Explicit scope must contain 1-100 bounded document ids",
        "native_mcp_unsupported",
      );
    delete this.evidence[config.id];
    Object.assign(config, {
      readProvider: {
        path: config.native.path,
        digest: config.native.digest,
        entryId: config.id,
        native: config.native,
        profileId: fixtures.knownProfile.id,
        profileDigest: "profile-mock-digest",
        scope: [...new Set(scope)],
      },
      enabled: false,
      allowedTools: [],
    });
    delete config.inventory;
    this.emit();
    return this.integrations;
  }

  loadIntegrationTools(id: string): IntegrationCatalog {
    const config = this.integrationConfigs.find((item) => item.id === id);
    if (!config) throw new MockError(404, "Discover/import a connection first", "not_found");
    const definition = this.definition(config);
    const checkedAt = this.now();
    if (config.oauthProfileId) {
      const authenticated = this.oauthStates[id]?.state === "authenticated";
      const supported = this.oauthProfile(config)?.readSupport === "supported";
      const inventory: IntegrationInventory = authenticated
        ? {
            status: "loaded",
            checkedAt,
            scope: "synthetic_transport",
            connected: false,
            message: supported
              ? "Inventory loaded, not a read result or tool grant. Only explicitly reviewed read tools may be granted; provider access controls determine accessible data."
              : "Inventory loaded, not a verified read or tool grant. Only independently vetted read schemas and resource adapters may be granted.",
            tools: supported
              ? this.oauthReadTools(config).map((tool) => ({
                  name: tool.id,
                  schemaFingerprint: `mock-${tool.id}`,
                }))
              : [{ name: "synthetic_unvetted_read", schemaFingerprint: "mock-unvetted-0000" }],
          }
        : {
            status: "error",
            checkedAt,
            scope: "synthetic_transport",
            connected: false,
            message:
              "Captured MCP authentication is no longer authorized; reconnect and capture new grants",
            tools: [],
          };
      Object.assign(config, { inventory, enabled: false, allowedTools: [] });
      delete this.evidence[id];
      this.emit();
      return this.integrations;
    }
    const mode = config.readProvider ? this.options.inventory : "error";
    const inventory: IntegrationInventory = mode
      ? {
          status: mode,
          checkedAt,
          scope: config.readProvider ? "synthetic_transport" : "local_configuration",
          connected: false,
          message:
            "Inventory unavailable or changed. No permissions granted; check source, auth and exact known server/schema compatibility.",
          tools: [],
        }
      : {
          status: "loaded",
          checkedAt,
          scope: "synthetic_transport",
          connected: false,
          message:
            "Exact known tool inventory loaded; no read was tested and no permissions were granted.",
          tools: definition.tools.map((tool) => ({
            name: tool.toolNames[0]!,
            schemaFingerprint: "mock-schema-fingerprint-0000",
          })),
        };
    Object.assign(config, { inventory, enabled: false, allowedTools: [] });
    delete this.evidence[id];
    this.emit();
    return this.integrations;
  }

  importReadProviders(file: unknown): IntegrationCatalog {
    if (typeof file !== "string" || !file.startsWith("/"))
      throw new MockError(
        409,
        "Read-provider import requires an explicit absolute manifest path",
        "provider_incompatible",
      );
    if (file !== fixtures.READ_PROVIDER_MANIFEST)
      throw new MockError(
        409,
        `Manifest ${file} is not a version-1 read-provider manifest (mock fixture accepts only ${fixtures.READ_PROVIDER_MANIFEST})`,
        "provider_incompatible",
      );
    const imported = structuredClone(fixtures.importedReadConfigs);
    for (const config of imported) delete this.evidence[config.id];
    this.integrationConfigs = [
      ...this.integrationConfigs.filter(
        (item) => !imported.some((config) => config.id === item.id),
      ),
      ...imported,
    ];
    this.settings.integrations.importedHarnessAt = this.now();
    this.emit();
    return this.integrations;
  }

  updateIntegration(id: string, body: unknown): IntegrationCatalog {
    const b = (body ?? {}) as Record<string, unknown>;
    if (Object.keys(b).some((key) => !["enabled", "allowedTools"].includes(key)))
      throw new MockError(
        400,
        "Only enabled and allowedTools can be updated; source identities require explicit import",
        "invalid_integration",
      );
    const existing = this.integrationConfigs.find(
      (item) => item.id === id && (item.native || item.readProvider || item.oauthProfileId),
    );
    if (!existing)
      throw new MockError(404, "Discover or import a supported connection first", "not_found");
    const definition = this.definition(existing);
    Object.assign(existing, {
      ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      ...(Array.isArray(b.allowedTools)
        ? {
            allowedTools: [
              ...new Set(
                (b.allowedTools as string[]).filter((tool) =>
                  definition.tools.some((item) => item.id === tool),
                ),
              ),
            ],
          }
        : {}),
    });
    this.emit();
    return this.integrations;
  }

  testIntegration(id: string): IntegrationTestResult {
    const connection = this.integrations.connections.find((item) => item.definition.id === id);
    if (!connection) throw new MockError(404, "integration not found", "not_found");
    const mode = this.options.readTest ?? "synthetic";
    const bound = Boolean(connection.config.readProvider);
    if (connection.config.oauthProfileId) {
      const supported = this.oauthProfile(connection.config)?.readSupport === "supported";
      const linear = connection.config.oauthProfileId === fixtures.linearOAuthProfile.id;
      const axiom = connection.config.oauthProfileId === fixtures.axiomOAuthProfile.id;
      const searchGranted =
        connection.config.enabled &&
        connection.config.inventory?.status === "loaded" &&
        connection.config.allowedTools.some((tool) =>
          axiom
            ? tool === "listDatasets"
            : linear
              ? tool === "list_issues"
              : tool.startsWith("slack_search"),
        );
      const result: IntegrationTestResult = {
        testedAt: this.now(),
        mutating: false,
        scope: "local_configuration",
        connected: false,
        containmentVerified: false,
        status: supported ? "needs_compatibility" : "unsupported",
        message: supported
          ? axiom
            ? "Axiom read Test did not succeed. Explicit listDatasets permission is required; no operation was retried."
            : linear
              ? LINEAR_TEST_FAILED_MESSAGE
              : SLACK_TEST_FAILED_MESSAGE
          : OAUTH_TEST_MESSAGE,
      };
      if (supported && searchGranted && mode !== "error")
        Object.assign(result, {
          scope: mode === "live" ? "live_read" : "synthetic_transport",
          connected: mode === "live",
          status: "ready",
          message: axiom
            ? mode === "live"
              ? "One bounded Axiom dataset listing succeeded. No independent identity or completeness guarantee is claimed."
              : "Synthetic Axiom read passed; not live connection evidence."
            : linear
              ? mode === "live"
                ? LINEAR_TEST_LIVE_MESSAGE
                : LINEAR_TEST_SYNTHETIC_MESSAGE
              : mode === "live"
                ? SLACK_TEST_LIVE_MESSAGE
                : SLACK_TEST_SYNTHETIC_MESSAGE,
        });
      this.evidence[id] = result;
      this.emit();
      return structuredClone(result);
    }
    const result: IntegrationTestResult = {
      testedAt: this.now(),
      mutating: false,
      scope: !bound
        ? "local_configuration"
        : mode === "synthetic"
          ? "synthetic_transport"
          : "live_read",
      connected: bound && mode === "live",
      containmentVerified: false,
      status: !bound ? "configured" : mode === "error" ? "error" : "ready",
      message: !bound
        ? "No explicit audited read-provider configuration was imported"
        : mode === "synthetic"
          ? "Synthetic read transport passed; no live connection was tested"
          : mode === "live"
            ? "An explicit bounded provider read succeeded. This is point-in-time evidence, not ongoing availability or a containment test"
            : "Provider read failed or source/auth/schema changed; no login, refresh or permission grant was attempted",
    };
    this.evidence[id] = result;
    this.emit();
    return structuredClone(result);
  }

  private entriesFor(reviewer: ReviewerSettings): HarnessEntryEvidence[] {
    const roles = reviewer.skillExecution?.version === 3 ? reviewer.skillExecution.roles : null;
    if (!roles) return [];
    return [...roles.additional, roles.main].map((entry) => ({
      id: entry.id,
      role: entry.role,
      harness: entry.harness,
      model: entry.model,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    }));
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hold(scope: "sync" | "edit-intent" | "review-cancel" | number): MockHold {
    let enter!: () => void;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const entered = new Promise<void>((r) => (enter = r));
    const work = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
    this.holds.set(String(scope), { enter, work });
    return {
      entered,
      release: resolve,
      fail: (message) => reject(new Error(message)),
      drop: () => {
        this.restart();
        reject(new TypeError("Failed to fetch"));
      },
    };
  }

  restart() {
    this.syncOperation = null;
    this.importOperations.clear();
    this.syncInFlight = null;
    this.importInFlight.clear();
    this.emit();
  }

  private async held(scope: string) {
    const hold = this.holds.get(scope);
    if (!hold) return;
    this.holds.delete(scope);
    hold.enter();
    await hold.work;
  }

  private emit(prId?: string) {
    this.listeners.forEach((l) => l(prId));
  }

  private now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private id(prefix: string) {
    return `${prefix}-${++this.counter}`;
  }

  private progressOf(run: ReviewRun) {
    return (run.progress ??= fixtures.progress([], []));
  }

  private phase(run: ReviewRun, id: RunPhase["id"], status: RunPhase["status"], detail?: string) {
    const progress = this.progressOf(run);
    const at = this.now();
    const current = progress.phases.find((p) => p.id === id);
    if (status === "running")
      progress.phases.push({ id, status, startedAt: at, finishedAt: null, detail: detail ?? null });
    else if (current)
      Object.assign(current, { status, finishedAt: at, detail: detail ?? current.detail });
    const label = {
      sync: "Syncing latest PR",
      checkout: "Preparing pinned checkout",
      codex: "Codex cross-check",
      claude: "Claude review",
      workflow: "Selected execution",
      finalize: "Validating and saving result",
    }[id];
    this.activity(run, "app", "phase", `${label} ${status === "running" ? "started" : status}`);
  }

  private activity(
    run: ReviewRun,
    source: RunActivity["source"],
    kind: RunActivity["kind"],
    label: string,
  ) {
    const progress = this.progressOf(run);
    const at = this.now();
    progress.activity.push({ at, source, kind, label });
    if (progress.activity.length > 40) progress.activity.splice(0, progress.activity.length - 40);
    progress.activityCount += 1;
    progress.lastActivityAt = at;
    progress.updatedAt = at;
  }

  state(): AppState {
    return structuredClone({
      operations: { sync: this.syncOperation, imports: [...this.importOperations.values()] },
      settings: this.settings,
      health: this.health,
      integrations: this.integrations,
      prs: this.prs.map((pr) => this.pr(pr.id)).filter(inboxEligible),
    });
  }

  private pr(id: string) {
    const pr = this.prs.find((p) => p.id === id);
    if (!pr) throw new MockError(404, `Unknown PR ${id}`, "not_found");
    pr.hasReviewHistory =
      (this.runs[id] ?? []).some(
        (run) => run.kind === "review" && run.status === "completed" && run.result !== null,
      ) || (this.submissions[id] ?? []).some((submission) => submission.status === "submitted");
    pr.hasReviewedHead = (this.runs[id] ?? []).some(
      (run) =>
        run.kind === "review" &&
        run.status === "completed" &&
        run.result !== null &&
        run.headSha === pr.headSha,
    );
    if (this.options.reviewControls) {
      const runs = this.runs[id] ?? [];
      const stopped = runs.findLast((run) => run.status === "unqueued" || !!run.cancellation);
      pr.reviewJobs = runs
        .filter((run) => run.status === "queued" || run.status === "running" || run === stopped)
        .map((run) => ({
          jobId: `job-${run.id}`,
          runId: run.id,
          headSha: run.headSha,
          kind: run.kind,
          status: run.status,
          cancellation: run.cancellation ?? null,
        }));
    }
    return pr;
  }

  detail(id: string): PullRequestDetail {
    const pr = this.pr(id);
    return structuredClone({
      pr,
      diff: fixtures.diff,
      diffTruncated: pr.id === "pr-468",
      runs: this.runs[id] ?? [],
      drafts: this.drafts[id] ?? [],
      draft: this.latest(id),
      proposals: this.proposals[id] ?? [],
      submissions: this.submissions[id] ?? [],
      freshness: this.freshness[id] ?? null,
      questions: this.questions[id] ?? [],
    });
  }

  updateAutoSubmission(body: AutoSubmissionUpdate) {
    this.autoSubmissionBodies.push(structuredClone(body));
    const current = this.settings.autoSubmission!;
    if (
      !body.repository ||
      body.repository !== this.settings.repository ||
      body.expectedVersion !== current.version
    )
      throw new MockError(
        409,
        "SYNTHETIC: saved repository or policy version changed",
        "auto_submission_conflict",
      );
    const authors = normalizeAutoSubmissionAuthors(body.authors);
    if (!authors || (body.enabled && body.confirmation !== autoSubmissionConfirmation))
      throw new MockError(
        400,
        "SYNTHETIC: invalid author table or missing exact consent",
        "invalid_auto_submission",
      );
    this.settings.autoSubmission = {
      repository: body.repository,
      enabled: body.enabled,
      authors,
      version: current.version + 1,
      consentedAt: body.enabled ? this.now() : null,
    };
    this.emit();
    return this.state();
  }

  async draftEditIntent(id: string, intent: DraftEditIntent) {
    this.editIntentBodies.push(structuredClone(intent));
    await this.held("edit-intent");
    if (this.options.editIntent === "slow")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.options.editIntent === "fail")
      throw new MockError(503, "SYNTHETIC: edit intent unavailable", "fixture_unavailable");
    const draft = this.draft(id, intent.draftId);
    if (intent.version !== draft.version || this.options.editIntent === "stale")
      throw new MockError(409, "SYNTHETIC: draft version changed", "draft_conflict");
    if (
      (this.submissions[id] ?? []).some(
        (submission) =>
          submission.authority?.kind === "automatic" &&
          submission.authority.draftId === draft.id &&
          submission.authority.draftVersion === intent.version &&
          (submission.status === "submitting" || submission.status === "uncertain"),
      )
    )
      throw new MockError(
        409,
        "SYNTHETIC: publication is in flight or uncertain; intent cannot cancel it",
        "draft_conflict",
      );
    draft.autoSubmission ??= { provenance: null, manualHold: null };
    draft.autoSubmission.manualHold ??= { reason: "edit_intent", at: this.now() };
    this.emit(id);
    return this.detail(id);
  }

  reconcileAutoSubmission(id: string) {
    this.emit(id);
    return this.detail(id);
  }

  acknowledgeHumanReview(id: string, body: HumanReviewAcknowledgment) {
    this.humanAcknowledgments.push(structuredClone(body));
    const state = this.pr(id).autoSubmission;
    const evidence = state?.evidence.find((item) => item.id === body.evidenceId);
    if (
      !state ||
      state.version !== body.expectedVersion ||
      !evidence ||
      JSON.stringify(evidence.source) !== JSON.stringify(body.source)
    )
      throw new MockError(409, "SYNTHETIC: evidence version changed", "auto_submission_conflict");
    evidence.acknowledgment = { action: body.action, at: this.now() };
    state.version += 1;
    state.status = "held";
    this.emit(id);
    return this.detail(id);
  }

  reenableAutoSubmission(id: string, body: AutoSubmissionReenable) {
    this.autoReenableBodies.push(structuredClone(body));
    const pr = this.pr(id);
    const state = pr.autoSubmission;
    if (!state || state.version !== body.expectedVersion)
      throw new MockError(
        409,
        "SYNTHETIC: automatic submission state changed",
        "auto_submission_conflict",
      );
    if (
      body.confirmation !== autoSubmissionReenableConfirmation ||
      state.evidence.some((item) => !item.acknowledgment)
    )
      throw new MockError(
        409,
        "SYNTHETIC: all exact evidence acknowledgments are required",
        "auto_submission_held",
      );
    state.reenableRequired = false;
    state.version += 1;
    state.generation += 1;
    state.status = "off";
    state.message =
      "SYNTHETIC: re-enabled only for later reviews; saved policy is still off. Draft edit holds are unchanged.";
    this.emit(id);
    return this.detail(id);
  }

  createDraft(id: string) {
    const pr = this.pr(id);
    const list = (this.drafts[id] ??= []);
    if (!list.some((d) => d.runId === null && d.headSha === pr.headSha)) {
      const at = this.now();
      list.unshift({
        id: this.id("draft"),
        runId: null,
        headSha: pr.headSha,
        version: 1,
        overview: "",
        body: "",
        findings: [],
        verdict: "COMMENT",
        createdAt: at,
        updatedAt: at,
      });
      this.recount(id);
      if (pr.status === "unreviewed" || pr.status === "outdated" || pr.status === "failed")
        pr.status = "ready";
    }
    this.emit(id);
    return this.detail(id);
  }

  ask(id: string, request: QuestionRequest) {
    const pr = this.pr(id);
    if (request.range.headSha !== pr.headSha)
      throw new MockError(
        409,
        `the selection was made on ${request.range.headSha.slice(0, 7)} but the pull request is now at ${pr.headSha.slice(0, 7)}; reselect the code on the current diff`,
        "head_mismatch",
      );
    const resolved = resolveSelection(parseDiff(fixtures.diff), request.range);
    if (!resolved)
      throw new MockError(
        400,
        "the selected lines are not in the saved diff for this commit",
        "invalid_selection",
      );
    const parent = request.parentId
      ? (this.questions[id] ?? []).find((q) => q.id === request.parentId)
      : undefined;
    if (parent) this.requireSupportedQuestion(parent);
    const question: Question = {
      id: this.id("q"),
      prId: id,
      draftId: request.draftId ?? null,
      parentId: request.parentId ?? null,
      mode: request.mode,
      status: "queued",
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      selection: resolved.selection,
      question: request.question ?? "",
      answer: null,
      error: null,
      reviewerSnapshot: parent ? structuredClone(parent.reviewerSnapshot) : this.captureReviewer(),
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
    };
    (this.questions[id] ??= []).push(question);
    this.emit(id);
    this.runQuestion(id, question);
    return this.detail(id);
  }

  private runQuestion(id: string, question: Question) {
    this.later(() => {
      if (question.status !== "queued") return;
      question.status = "running";
      question.startedAt = this.now();
      this.emit(id);
      if (this.options.question === "hang") return;
      this.later(() => {
        if (question.status !== "running") return;
        question.finishedAt = this.now();
        if (this.options.question === "fail") {
          question.status = "failed";
          question.error = "Claude question failed (exit 1): mock failure";
        } else {
          question.status = "completed";
          const where = `\`${question.selection.path}:${question.selection.to.line}\``;
          question.answer =
            question.mode === "draft_comment"
              ? {
                  kind: "comment",
                  body: `\`applyDiscount\` mutates the caller's line items in place.\n- Callers that reuse \`lineItems\` see reduced amounts on the next render.`,
                  severity: "non_blocking",
                  origin: "introduced",
                  evidence: `- Checked ${where}: the forEach writes \`item.amount\` on the shared array.`,
                }
              : {
                  kind: "answer",
                  answer: `- ${question.mode === "explain" ? "Explains" : "Investigated"} ${where}${question.question ? ` for "${question.question}"` : ""}: the discount is subtracted before rounding.\n- Only \`buildInvoice\` calls it; see \`src/billing/invoice.test.ts:5\`.`,
                  followUps: ["What happens when the discount exceeds the subtotal?"],
                };
        }
        this.emit(id);
      });
    });
  }

  cancelQuestion(id: string, questionId: string) {
    const question = (this.questions[id] ?? []).find((q) => q.id === questionId);
    if (!question) throw new MockError(404, "question not found", "not_found");
    if (question.status !== "queued" && question.status !== "running")
      throw new MockError(409, "the question is no longer running", "question_finished");
    question.status = "cancelled";
    question.error = "Cancelled by the reviewer";
    question.finishedAt = this.now();
    this.emit(id);
    return this.detail(id);
  }

  private requireSupportedQuestion(question: Question) {
    if (!supportedCapture(question.reviewerSnapshot))
      throw new MockError(
        409,
        "This question's captured execution is archived and cannot run again; its recorded answer and status are unchanged. Save current Settings and start an independent question.",
        "execution_incompatible",
      );
  }

  retryQuestion(id: string, questionId: string) {
    const question = (this.questions[id] ?? []).find((q) => q.id === questionId);
    if (!question) throw new MockError(404, "question not found", "not_found");
    if (question.status === "queued" || question.status === "running")
      throw new MockError(409, "the question is still in progress", "question_active");
    this.requireSupportedQuestion(question);
    Object.assign(question, {
      status: "queued",
      answer: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    this.emit(id);
    this.runQuestion(id, question);
    return this.detail(id);
  }

  private latest(id: string): ReviewDraft | null {
    return this.drafts[id]?.[0] ?? null;
  }

  private draft(id: string, draftId: string) {
    const draft = this.drafts[id]?.find((d) => d.id === draftId);
    if (!draft) throw new MockError(409, "That draft does not exist for this PR", "draft_required");
    return draft;
  }

  private refreshFromRemote(id: string) {
    const pr = this.pr(id);
    const remote = this.options.remoteHead?.[id];
    if (remote && remote !== pr.headSha) {
      pr.headSha = remote;
      pr.updatedAt = this.now();
      if (this.latest(id)) pr.status = "outdated";
    }
    this.refreshReadiness(pr);
    return pr;
  }

  private nextReadinessMode(): ReadinessMode | undefined {
    const mode = this.options.readiness;
    if (!Array.isArray(mode)) return mode;
    return mode.length > 1 ? mode.shift() : mode[0];
  }

  private refreshReadiness(
    pr: (typeof this.prs)[number],
    mode: ReadinessMode | undefined = this.nextReadinessMode(),
  ) {
    const previous = pr.mergeReadiness;
    if (!mode) return;
    const kept =
      previous?.headSha === pr.headSha
        ? previous.state === "unknown"
          ? previous.lastKnown
          : {
              checkedAt: previous.checkedAt,
              state: previous.state,
              mergeStateStatus: previous.mergeStateStatus,
              blockers: previous.blockers,
              checksTruncated: previous.checksTruncated,
            }
        : null;
    if (mode === "error") {
      pr.mergeReadiness = {
        ...fixtures.readiness("unknown"),
        headSha: pr.headSha,
        checkedAt: this.now(),
        error: "gh api graphql failed: API rate limit exceeded (HTTP 403)",
        lastKnown: kept,
      };
      return;
    }
    const state = mode;
    pr.mergeReadiness = {
      ...fixtures.readiness(
        state,
        state === "blocked"
          ? [
              {
                kind: "checks_pending",
                summary: "1 required check pending",
                detail: "unit",
                url: `${pr.url}/checks`,
                required: true,
              },
            ]
          : [],
        state === "unknown"
          ? { error: "GitHub is still computing mergeability", lastKnown: kept }
          : {},
      ),
      headSha: pr.headSha,
      checkedAt: this.now(),
    };
  }

  private baseline(id: string) {
    return this.latest(id)?.headSha ?? null;
  }

  private commits() {
    const count = this.options.commits?.count;
    if (count === undefined) return fixtures.newCommits;
    return Array.from({ length: count }, (_, i) => {
      const sha = `${(i + 1).toString(16).padStart(7, "0")}${"f".repeat(33)}`;
      return {
        sha,
        message: `Rewritten commit ${i + 1} of ${count} (mock fixture)`,
        author: "kai",
        committedAt: fixtures.newCommits[0]!.committedAt,
        url: `https://github.com/acme/rocket/commit/${sha}`,
      };
    });
  }

  check(id: string) {
    this.checkCalls += 1;
    const baseline = this.baseline(id);
    const mode = this.options.freshness ?? "stale";
    const previous = this.freshness[id] ?? null;
    if (mode === "error") {
      const pr = this.pr(id);
      this.refreshReadiness(pr);
      if (baseline)
        this.freshness[id] = {
          baseline,
          head: pr.headSha,
          status:
            previous?.baseline === baseline && previous.head === pr.headSha
              ? previous.status
              : baseline === pr.headSha
                ? "unknown"
                : "stale",
          commits: previous?.baseline === baseline ? previous.commits : [],
          truncated: false,
          checkedAt: this.now(),
          error: "gh api failed: API rate limit exceeded (HTTP 403)",
        };
      this.emit(id);
      return this.detail(id);
    }
    const pr = this.refreshFromRemote(id);
    if (!baseline) {
      this.freshness[id] = null;
      this.emit(id);
      return this.detail(id);
    }
    const stale = baseline !== pr.headSha;
    const status: FreshnessStatus = !stale ? "fresh" : mode;
    this.freshness[id] = {
      baseline,
      head: pr.headSha,
      status,
      commits:
        status === "stale" || status === "rewritten"
          ? this.commits().map((c, i, all) =>
              i === all.length - 1 ? { ...c, sha: pr.headSha } : c,
            )
          : [],
      truncated: this.options.commits?.truncated ?? false,
      checkedAt: this.now(),
      error: null,
    };
    this.emit(id);
    return this.detail(id);
  }

  updateSettings(update: SettingsUpdate) {
    if (
      update.repository !== undefined &&
      update.repository !== "" &&
      !/^[\w.-]+\/[\w.-]+$/.test(update.repository)
    ) {
      throw new MockError(400, "Repository must look like owner/name", "invalid_repository");
    }
    if (
      update.maxConcurrentReviews !== undefined &&
      !validConcurrentReviews(update.maxConcurrentReviews)
    )
      throw new MockError(
        400,
        `maxConcurrentReviews must be an integer between ${maxConcurrentReviewsRange.min} and ${maxConcurrentReviewsRange.max}`,
        "invalid_settings",
      );
    const { automation, ...rest } = update;
    if (update.repository !== undefined && update.repository !== this.settings.repository)
      this.settings.autoSubmission = {
        repository: update.repository,
        enabled: false,
        authors: [],
        version: 0,
        consentedAt: null,
      };
    Object.assign(this.settings, rest);
    if (automation) Object.assign(this.settings.automation, automation);
    if (!this.settings.repository) this.settings.automation = { ...automationOff };
    this.recomputeAutomation();
    this.emit();
    return this.state();
  }

  updateAutomation(id: string, overrides: Partial<AutomationOverrides>) {
    const pr = this.pr(id);
    pr.automation = { ...pr.automation, ...overrides };
    this.recomputeAutomation();
    this.emit();
    return this.detail(id);
  }

  private recomputeAutomation() {
    for (const pr of this.prs)
      pr.effectiveAutomation = effectiveAutomation(this.settings.automation, pr.automation);
  }

  sync() {
    if (!this.settings.repository)
      throw new MockError(409, "Configure a repository before syncing", "no_repository");
    this.syncInFlight ??= this.performSync().finally(() => (this.syncInFlight = null));
    return this.syncInFlight;
  }

  private async performSync() {
    this.syncCalls += 1;
    const operation: SyncOperation = {
      id: this.id("sync"),
      repository: this.settings.repository,
      mode: "manual",
      status: "running",
      startedAt: this.now(),
      finishedAt: null,
      error: null,
    };
    this.syncOperation = operation;
    this.emit();
    let error: string | null = null;
    try {
      await this.held("sync");
      this.health.lastPollAt = this.now();
      const mode = this.nextReadinessMode();
      for (const pr of this.prs) if (pr.state === "OPEN") this.refreshReadiness(pr, mode);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      error = (e as Error).message;
      this.health.pollError = error;
    }
    Object.assign(operation, {
      status: error === null ? "completed" : "failed",
      error,
      finishedAt: this.now(),
    });
    this.emit();
    return this.state();
  }

  importPr(url: string) {
    const match = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
    if (!match) throw new MockError(400, "Enter a GitHub pull request URL", "invalid_url");
    const [, repository, number] = match as unknown as [string, string, string];
    if (this.settings.repository && repository !== this.settings.repository) {
      throw new MockError(
        409,
        `PR belongs to ${repository}, not ${this.settings.repository}`,
        "repository_mismatch",
      );
    }
    this.importCalls.push(url);
    const key = `${repository}#${number}`;
    const inFlight = this.importInFlight.get(key);
    if (inFlight) return inFlight;
    if (!this.settings.repository) this.settings.repository = repository;
    const operation: ImportOperation = {
      id: this.id("import"),
      repository,
      prId: this.prs.find((p) => p.number === Number(number))?.id ?? this.id("pr"),
      number: Number(number),
      status: "running",
      startedAt: this.now(),
      finishedAt: null,
      error: null,
    };
    this.importOperations.set(key, operation);
    this.emit(operation.prId);
    const settle = (error: string | null) => {
      Object.assign(operation, {
        status: error === null ? "completed" : "failed",
        error,
        finishedAt: this.now(),
      });
      this.emit(operation.prId);
    };
    const pending = this.held(number)
      .then(() => this.completeImport(url, repository, Number(number), operation.prId))
      .then(
        (detail) => {
          settle(null);
          return detail;
        },
        (e: unknown) => {
          if (!(e instanceof TypeError)) settle((e as Error).message);
          throw e;
        },
      )
      .finally(() => {
        if (this.importInFlight.get(key) === pending) this.importInFlight.delete(key);
      });
    this.importInFlight.set(key, pending);
    return pending;
  }

  private completeImport(url: string, repository: string, number: number, id: string) {
    const existing = this.prs.find((p) => p.number === number);
    if (existing) {
      if (existing.state !== "OPEN")
        throw new MockError(
          409,
          "only open pull requests can be imported; this one is closed or merged",
          "pr_closed",
        );
      existing.imported = true;
      this.emit(existing.id);
      return this.detail(existing.id);
    }
    this.prs.unshift({
      ...fixtures.prs[5]!,
      id,
      number: Number(number),
      repository,
      url,
      title: `Imported pull request #${number}`,
      status: "unreviewed",
      requested: false,
      requestedAt: null,
      requestSource: null,
      historicalRequestSource: null,
      imported: true,
      createdAt: this.now(),
      updatedAt: this.now(),
      blockingCount: 0,
      nonBlockingCount: 0,
    });
    this.runs[id] = [];
    this.emit();
    return this.detail(id);
  }

  reviewJobAction(id: string, jobId: string, action: "unqueue" | "cancel", body: ReviewJobAction) {
    const pr = this.pr(id);
    const run = (this.runs[id] ?? []).find(
      (run) => `job-${run.id}` === jobId && run.id === body.runId && run.headSha === body.headSha,
    );
    if (!run || run.status !== (action === "unqueue" ? "queued" : "running") || run.cancellation)
      throw new MockError(
        409,
        `SYNTHETIC: observed job is ${run?.status ?? "missing"}; reload its actual state`,
        "review_job_conflict",
      );
    if (action === "cancel" && body.confirmation !== cancelReviewConfirmation)
      throw new MockError(
        400,
        "SYNTHETIC: explicit cancellation confirmation required",
        "review_confirmation_required",
      );
    if (pr.autoSubmission) {
      pr.autoSubmission.reenableRequired = true;
      pr.autoSubmission.generation++;
      pr.autoSubmission.version++;
    }
    if (action === "unqueue") {
      run.status = "unqueued";
      run.finishedAt = this.now();
      pr.status = this.latest(id) ? "ready" : "unreviewed";
    } else {
      run.cancellation = {
        status: "pending",
        requestedAt: this.now(),
        finishedAt: null,
        message: "SYNTHETIC waiting for owned shutdown; prior effects are not undone",
      };
      void this.held("review-cancel")
        .then(() => {
          run.status = "cancelled";
          run.finishedAt = this.now();
          run.cancellation = {
            ...run.cancellation!,
            status: "confirmed",
            finishedAt: this.now(),
            message: "SYNTHETIC owned shutdown confirmed; prior effects are not undone",
          };
          pr.status = this.latest(id) ? "ready" : "unreviewed";
          this.emit(id);
        })
        .catch((error: Error) => {
          run.cancellation = {
            ...run.cancellation!,
            status: "unconfirmed",
            finishedAt: this.now(),
            message: `SYNTHETIC shutdown unconfirmed: ${error.message}`,
          };
          this.emit(id);
        });
    }
    this.emit(id);
    return this.detail(id);
  }

  review(id: string) {
    if (this.options.reviewRefresh === "fail")
      throw new MockError(
        502,
        "could not refresh the pull request before reviewing: gh api failed (HTTP 503)",
        "refresh_failed",
      );
    if (this.options.reviewRefresh === "closed") {
      const closed = this.pr(id);
      closed.state = "CLOSED";
      closed.requested = false;
      closed.requestedAt = null;
      closed.requestSource = null;
      this.emit(id);
      throw new MockError(
        409,
        "pull request is no longer open, so no review was started",
        "pr_closed",
      );
    }
    const syncStarted = this.now();
    const pr = this.refreshFromRemote(id);
    const runs = (this.runs[id] ??= []);
    if (
      runs.some(
        (r) =>
          r.kind === "review" &&
          r.trigger === "manual" &&
          r.headSha === pr.headSha &&
          (r.status === "queued" || r.status === "running"),
      )
    ) {
      return this.detail(id);
    }
    const syncFinished = this.now();
    const run: ReviewRun = {
      id: this.id("run"),
      prId: id,
      kind: "review",
      trigger: "manual",
      requestEventId: null,
      status: "queued",
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      log: "",
      reviewer: this.captureReviewer(),
      result: null,
      progress: fixtures.progress(
        [
          {
            id: "sync",
            status: "completed",
            startedAt: syncStarted,
            finishedAt: syncFinished,
            detail: `head ${pr.headSha.slice(0, 7)}`,
          },
        ],
        [{ at: syncFinished, source: "app", kind: "phase", label: "Syncing latest PR completed" }],
      ),
    };
    runs.push(run);
    pr.status = "queued";
    this.emit(id);
    const entries = this.entriesFor(run.reviewer);
    if (entries.length) this.progressOf(run).entries = entries;
    const source = (entry: HarnessEntryEvidence): RunActivity["source"] =>
      entry.harness === "pi" ? "app" : entry.harness;
    const entryResult = (entry: HarnessEntryEvidence): ReviewResult => ({
      overview: `# Synthetic ${entry.id} (${entry.model})`,
      body: `Review ${entry.model}`,
      findings: [],
      verdict: "COMMENT",
      rationale: `Private ${entry.model}`,
    });
    const steps: (() => void)[] = [
      () => {
        run.status = "running";
        run.startedAt = this.now();
        run.log = "app: dispatching captured roles";
        pr.status = "reviewing";
        this.phase(run, "checkout", "running");
      },
      () => {
        this.phase(
          run,
          "checkout",
          "completed",
          `${pr.baseSha.slice(0, 7)}..${pr.headSha.slice(0, 7)}`,
        );
        this.phase(run, "workflow", "running");
      },
      ...entries.flatMap((entry) => [
        () => {
          entry.status = "running";
          entry.startedAt = this.now();
          this.activity(run, source(entry), "message", `Session started with ${entry.model}`);
          this.activity(run, source(entry), "read", "Reading src/billing/invoice.ts");
        },
        () => {
          entry.status = "completed";
          entry.finishedAt = this.now();
          entry.result = entryResult(entry);
          this.activity(run, source(entry), "message", "Writing the structured result");
        },
      ]),
      () => {
        this.phase(run, "workflow", "completed", `${entries.length} entries`);
        this.phase(run, "finalize", "running");
      },
    ];
    const advance = (index: number) =>
      this.later(() => {
        if (run.status === "unqueued" || run.cancellation) return;
        steps[index]!();
        this.emit(id);
        if (index + 1 < steps.length) advance(index + 1);
        else finish();
      });
    const finish = () =>
      this.later(() => {
        if (run.status === "unqueued" || run.cancellation) return;
        this.phase(run, "finalize", "completed", "draft created");
        run.status = "completed";
        run.finishedAt = this.now();
        run.log += "\napp: Main result validated, 1 finding";
        run.result = {
          overview: `- Re-review of ${pr.headRef}: \`buildInvoice\` still subtracts the discount before rounding.\n- No new call sites since the previous review.`,
          body: `Re-review of ${pr.headRef}: the change is small and the earlier concerns still stand.`,
          findings: [
            {
              id: this.id("f"),
              severity: "non_blocking",
              path: "src/billing/invoice.ts",
              line: 44,
              startLine: null,
              side: "RIGHT",
              body: "Consider naming the discount amount explicitly in the returned object.",
              evidence: "return { subtotal, total, discount };",
              origin: "introduced",
              included: true,
              questionId: null,
            },
          ],
          verdict: "COMMENT",
          rationale: "Nothing blocking in this pass.",
        };
        const result = run.result;
        (this.drafts[id] ??= []).unshift({
          id: this.id("draft"),
          runId: run.id,
          headSha: pr.headSha,
          version: 1,
          overview: result.overview,
          body: result.body,
          findings: structuredClone(result.findings),
          verdict: result.verdict,
          createdAt: run.finishedAt,
          updatedAt: run.finishedAt,
        });
        this.recount(id);
        pr.status = "ready";
        pr.lastReviewedAt = run.finishedAt;
        this.emit(id);
      });
    advance(0);
    return this.detail(id);
  }

  saveDraft(id: string, update: DraftUpdate) {
    const draft = this.draft(id, update.draftId);
    if (update.version !== draft.version) {
      throw new MockError(
        409,
        `Draft is at version ${draft.version}, you edited version ${update.version}`,
        "stale_draft",
      );
    }
    draft.autoSubmission ??= { provenance: null, manualHold: null };
    draft.autoSubmission.manualHold ??= { reason: "saved_edit", at: this.now() };
    const stored = new Map(draft.findings.map((f) => [f.id, f.evidence]));
    const questionEvidence = (f: Finding) => {
      const q = (this.questions[id] ?? []).find((item) => item.id === f.questionId);
      return q?.answer?.kind === "comment" && q.headSha === draft.headSha ? q.answer.evidence : "";
    };
    draft.body = update.body;
    draft.findings = update.findings.map((f) => ({
      ...f,
      evidence: stored.get(f.id) ?? questionEvidence(f),
    }));
    draft.verdict = update.verdict;
    draft.version += 1;
    draft.updatedAt = this.now();
    if (this.latest(id)?.id === draft.id) this.recount(id);
    this.emit(id);
    return this.detail(id);
  }

  revise(id: string, body: RevisionRequest) {
    const draft = this.draft(id, body.draftId);
    if (body.draftVersion !== draft.version)
      throw new MockError(409, "Draft changed; reload before revising", "stale_draft");
    if (!body.instructions.trim())
      throw new MockError(400, "Instructions are required", "invalid_request");
    const pr = this.pr(id);
    const run: ReviewRun = {
      id: this.id("run"),
      prId: id,
      kind: "revision",
      trigger: "revision",
      requestEventId: null,
      status: "running",
      headSha: draft.headSha,
      baseSha: pr.baseSha,
      createdAt: this.now(),
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      log: `revision: ${body.instructions}`,
      reviewer: this.captureReviewer(),
      result: null,
      progress: null,
    };
    (this.runs[id] ??= []).push(run);
    this.phase(run, "checkout", "running");
    this.emit(id);
    this.later(() => {
      this.phase(run, "checkout", "completed");
      this.phase(run, "workflow", "running");
      this.activity(run, "claude", "read", "Reading src/billing/invoice.ts");
      this.phase(run, "workflow", "completed");
      this.phase(run, "finalize", "running");
      this.phase(run, "finalize", "completed", "proposal created");
      const targets = new Set(body.findingIds ?? []);
      const findings: Finding[] = draft.findings.map((f) =>
        !targets.size || targets.has(f.id)
          ? { ...f, body: `${f.body} (revised: ${body.instructions.trim()})` }
          : f,
      );
      run.status = "completed";
      run.finishedAt = this.now();
      run.result = {
        overview: draft.overview,
        body: targets.size
          ? draft.body
          : `${draft.body} Revised per instructions: ${body.instructions.trim()}.`,
        findings,
        verdict: draft.verdict,
        rationale: "Revision applied to requested scope.",
      };
      (this.proposals[id] ??= []).push({
        id: this.id("prop"),
        runId: run.id,
        draftId: draft.id,
        sourceDraftVersion: body.draftVersion,
        instructions: body.instructions,
        status: "pending",
        result: run.result,
        createdAt: this.now(),
      });
      this.emit(id);
    });
    return this.detail(id);
  }

  applyProposal(id: string, proposalId: string, expectedVersion: number) {
    const proposal = this.proposal(id, proposalId);
    const draft = this.draft(id, proposal.draftId);
    if (draft.version !== expectedVersion || proposal.sourceDraftVersion !== draft.version) {
      throw new MockError(
        409,
        "Proposal was generated against an older draft version",
        "stale_proposal",
      );
    }
    draft.autoSubmission ??= { provenance: null, manualHold: null };
    draft.autoSubmission.manualHold ??= { reason: "revision", at: this.now() };
    this.applyResult(draft, proposal.result);
    proposal.status = "accepted";
    if (this.latest(id)?.id === draft.id) this.recount(id);
    this.emit(id);
    return this.detail(id);
  }

  rejectProposal(id: string, proposalId: string) {
    this.proposal(id, proposalId).status = "rejected";
    this.emit(id);
    return this.detail(id);
  }

  private applyResult(draft: ReviewDraft, result: ReviewResult) {
    draft.overview = result.overview;
    draft.body = result.body;
    draft.findings = structuredClone(result.findings);
    draft.verdict = result.verdict;
    draft.version += 1;
    draft.updatedAt = this.now();
  }

  preview(id: string, draftId: string, draftVersion: number): SubmissionPreview {
    const draft = this.draft(id, draftId);
    const pr = this.pr(id);
    if (draft.version !== draftVersion)
      throw new MockError(409, "Draft changed since this page loaded", "stale_draft");
    if (draft.headSha !== pr.headSha) {
      throw new MockError(
        409,
        `Draft targets ${draft.headSha.slice(0, 7)} but PR head is ${pr.headSha.slice(0, 7)}`,
        "outdated_draft",
      );
    }
    if (pr.state !== "OPEN")
      throw new MockError(409, "Pull request is no longer open", "pr_closed");
    const anchors = diffAnchors(parseDiff(fixtures.diff));
    const included = draft.findings.filter((f) => f.included);
    const inline = included.filter((f) => anchorsInline(anchors, f));
    const general = included.filter((f) => !inline.includes(f));
    const label = (f: Finding, location = "") =>
      `**${f.severity === "blocking" ? "Blocking" : "Non-blocking"}.** ${location}${f.body.replace(/^\*{0,2}(?:non-?)?blocking\*{0,2}[.:]\*{0,2}\s*/i, "")}`;
    const location = (f: Finding) =>
      f.path
        ? `\`${f.path}${f.line ? `:${f.startLine ? `${f.startLine}-` : ""}${f.line}` : ""}\`${f.line && f.side === "LEFT" ? " (old)" : ""} `
        : "";
    const payload: ReviewPayload = {
      event: draft.verdict,
      body: [draft.body, ...general.map((f) => label(f, location(f)))].filter(Boolean).join("\n\n"),
      commit_id: pr.headSha,
      comments: inline.map((f) => ({
        path: f.path!,
        line: f.line!,
        side: f.side,
        ...(f.startLine === null ? {} : { start_line: f.startLine, start_side: f.side }),
        body: label(f),
      })),
    };
    const preview: SubmissionPreview = {
      id: this.id("prev"),
      prId: id,
      draftId: draft.id,
      draftVersion,
      payload,
      createdAt: this.now(),
    };
    this.previews[preview.id] = preview;
    return structuredClone(preview);
  }

  submit(id: string, previewId: string): Submission {
    const preview = this.previews[previewId];
    if (!preview || preview.prId !== id) throw new MockError(404, "Unknown preview", "no_preview");
    const draft = this.drafts[id]?.find((d) => d.id === preview.draftId);
    if (!draft || draft.version !== preview.draftVersion) {
      throw new MockError(409, "Draft changed after the preview was generated", "stale_preview");
    }
    const status = this.options.submitOutcome ?? "submitted";
    const submission: Submission = {
      id: this.id("sub"),
      previewId,
      status,
      payload: preview.payload,
      githubReviewId: status === "submitted" ? "3300112233" : null,
      url: status === "submitted" ? `${this.pr(id).url}#pullrequestreview-3300112233` : null,
      error:
        status === "uncertain"
          ? "GitHub did not respond before the timeout; the review may or may not have been created"
          : status === "failed"
            ? "GitHub rejected the review: 422 Unprocessable"
            : null,
      createdAt: this.now(),
    };
    (this.submissions[id] ??= []).push(submission);
    if (status === "submitted") this.pr(id).status = "submitted";
    this.emit(id);
    return structuredClone(submission);
  }

  private proposal(id: string, proposalId: string) {
    const proposal = (this.proposals[id] ?? []).find((p) => p.id === proposalId);
    if (!proposal) throw new MockError(404, "Unknown proposal", "not_found");
    if (proposal.status !== "pending")
      throw new MockError(409, "Proposal already resolved", "resolved");
    return proposal;
  }

  private recount(id: string) {
    const pr = this.pr(id);
    const findings = this.latest(id)?.findings.filter((f) => f.included) ?? [];
    pr.blockingCount = findings.filter((f) => f.severity === "blocking").length;
    pr.nonBlockingCount = findings.length - pr.blockingCount;
    if (pr.status === "submitted") pr.status = "ready";
  }

  private later(fn: () => void) {
    const delay = this.options.reviewDelayMs ?? 1200;
    if (delay === 0) fn();
    else setTimeout(fn, delay);
  }

  handle(method: string, path: string, body: unknown): unknown {
    const url = new URL(path, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const b = (body ?? {}) as any;
    const [root, id, action, sub, subAction] = segments;
    if (root === "state" && method === "GET") return this.state();
    if (root === "settings" && id === "harness" && !action) {
      if (method === "GET") return this.harnessStatus();
      if (method === "PATCH") return this.selectHarness(body);
    }
    if (
      root === "settings" &&
      id === "models" &&
      action === "discover" &&
      !sub &&
      method === "POST"
    )
      return this.discoverModels(body);
    if (root === "settings" && id === "execution") {
      if (!action && method === "GET") return this.executionStatus();
      if (action === "check" && method === "POST") return this.checkExecution();
      if (action === "inspect" && method === "POST") return this.inspectDocker(body);
      if (action === "setup" && method === "POST") return this.setupDocker(body);
      if (action === "exclusions" && method === "POST") return this.discoverDockerExclusions(body);
      if (action === "library-leaf" && method === "POST")
        return this.discoverDockerLibraryLeaf(body);
    }
    if (root === "mcp" && id === "oauth" && action === "review-return" && !sub && method === "POST")
      return this.reviewReturn(body);
    if (root === "settings" && id === "integrations") {
      if (!action && method === "GET") return this.integrations;
      if (action === "import-read" && method === "POST") return this.importReadProviders(b.path);
      if (action === "discover" && !sub && method === "POST")
        return this.discoverIntegrations(body);
      if (action === "import-native" && !sub && method === "POST")
        return this.importNativeIntegration(body);
      if (action === "add-oauth" && !sub && method === "POST")
        return this.addOAuthIntegration(body);
      if (action === "import-oauth" && !sub && method === "POST")
        return this.importOAuthIntegration(body);
      if (action && sub === "oauth" && subAction && method === "POST")
        return this.oauthAction(action, subAction, body);
      if (action && sub === "load-tools" && method === "POST") {
        if (Object.keys(b).length)
          throw new MockError(400, "Load tools accepts an empty object", "invalid_integration");
        return this.loadIntegrationTools(action);
      }
      if (action && !sub && method === "PATCH") return this.updateIntegration(action, body);
      if (action && sub === "test" && method === "POST") return this.testIntegration(action);
    }
    if (root === "settings" && id === "auto-submission" && method === "PATCH")
      return this.updateAutoSubmission(b);
    if (root === "settings" && method === "PATCH") return this.updateSettings(b);
    if (root === "sync" && method === "POST") return this.sync();
    if (root === "prs" && id === "import" && method === "POST") return this.importPr(b.url);
    if (root === "prs" && id) {
      if (!action && method === "GET") return this.detail(id);
      if (
        action === "jobs" &&
        sub &&
        (subAction === "unqueue" || subAction === "cancel") &&
        method === "POST"
      )
        return this.reviewJobAction(id, sub, subAction, b);
      if (action === "review" && method === "POST") return this.review(id);
      if (action === "check" && method === "POST") return this.check(id);
      if (action === "automation" && method === "PATCH") return this.updateAutomation(id, b);
      if (action === "draft" && sub === "edit-intent" && method === "POST")
        return this.draftEditIntent(id, b);
      if (action === "auto-submission" && method === "POST") {
        if (sub === "check")
          throw new MockError(404, "Independent classifier checks are retired", "not_found");
        if (sub === "reconcile") return this.reconcileAutoSubmission(id);
        if (sub === "acknowledge") return this.acknowledgeHumanReview(id, b);
        if (sub === "re-enable") return this.reenableAutoSubmission(id, b);
      }
      if (action === "draft" && !sub && method === "PUT") return this.saveDraft(id, b);
      if (action === "drafts" && !sub && method === "POST") return this.createDraft(id);
      if (action === "questions" && !sub && method === "POST") return this.ask(id, b);
      if (action === "questions" && sub && subAction === "cancel")
        return this.cancelQuestion(id, sub);
      if (action === "questions" && sub && subAction === "retry")
        return this.retryQuestion(id, sub);
      if (action === "revise" && method === "POST") return this.revise(id, b);
      if (action === "proposals" && sub && subAction === "apply")
        return this.applyProposal(id, sub, b.expectedVersion);
      if (action === "proposals" && sub && subAction === "reject")
        return this.rejectProposal(id, sub);
      if (action === "preview" && method === "POST")
        return this.preview(id, b.draftId, b.draftVersion);
      if (action === "submit" && method === "POST") return this.submit(id, b.previewId);
    }
    throw new MockError(404, `No mock route for ${method} ${url.pathname}`, "not_found");
  }
}

export class MockError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

class MockEventSource extends EventTarget {
  static backend: MockBackend | null = null;
  static instances: MockEventSource[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(public url: string) {
    super();
    MockEventSource.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.unsubscribe =
        MockEventSource.backend?.subscribe((prId) => {
          this.dispatchEvent(
            new MessageEvent("change", { data: JSON.stringify(prId ? { prId } : {}) }),
          );
        }) ?? null;
    });
  }

  close() {
    this.readyState = 2;
    this.unsubscribe?.();
  }
}

export function installMockApi(backend: MockBackend) {
  const nativeFetch = globalThis.fetch;
  MockEventSource.backend = backend;
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/api/")) return nativeFetch(input, init);
    await new Promise((r) => setTimeout(r, 0));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    try {
      const data = await backend.handle(method, url, body);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      if (error instanceof MockError) {
        const payload: ApiError = { error: error.message, code: error.code };
        return new Response(JSON.stringify(payload), {
          status: error.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw error;
    }
  };
  return () => {
    globalThis.fetch = nativeFetch;
    MockEventSource.backend = null;
  };
}

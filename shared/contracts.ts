export type ReviewVerdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type Severity = "blocking" | "non_blocking";
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "interrupted";
export type PrStatus =
  | "unreviewed"
  | "queued"
  | "reviewing"
  | "ready"
  | "failed"
  | "outdated"
  | "submitted";

export type HarnessId = "claude" | "codex" | "pi";

export const executionModes = ["dangerous", "separated", "docker"] as const;
export type ExecutionMode = (typeof executionModes)[number];

export const dangerousConfirmation =
  "I understand this harness can write host files and publish directly without the app preview";
export const dockerSetupConfirmation =
  "Set up the app-owned Docker runtime and read my installed skill and supported harness configuration";

export type HarnessSelection =
  IsolatedHarnessSelection | NativeHarnessSelection;

export interface NativeHarnessSelection {
  version: 2;
  harness: HarnessId;
  workflow: "docker" | "dangerous";
  reviewer: Pick<ReviewerSettings, "skillPath" | "model">;
}

export interface ArchivedHarnessSelection {
  version?: number;
  harness: HarnessId;
  workflow: string;
  reviewer?: Pick<ReviewerSettings, "skillPath" | "model">;
  additional?: HarnessModelEntry[];
  sourceId?: string | null;
}

export type HarnessSelectionUpdate = HarnessSelection & {
  confirmation?: string;
};

export interface HarnessModelEntry {
  id: string;
  harness: HarnessId;
  model: string | null;
}

export const validModel = (model: unknown): model is string | null =>
  model === null ||
  (typeof model === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/.test(model));

export interface HarnessModelDiscoveryRequest {
  harness: HarnessId;
}

export interface HarnessModelChoice {
  model: string;
  label: string;
  sources: string[];
}

export interface HarnessModelSource {
  id: string;
  kind: "configuration" | "cached_catalog" | "saved_selection" | "catalog";
  path: string | null;
  status: "ready" | "partial" | "missing" | "unsupported" | "error";
  modifiedAt: string | null;
  freshness: "unknown" | "not_applicable";
  message: string;
}

export interface HarnessModelDiscovery {
  harness: HarnessId;
  checkedAt: string;
  status: "ready" | "partial" | "unsupported" | "error";
  availability: "not_checked";
  models: HarnessModelChoice[];
  sources: HarnessModelSource[];
}

export interface IsolatedHarnessSelection {
  harness: HarnessId;
  version: 3;
  workflow: "separated";
  reviewer: Pick<ReviewerSettings, "skillPath" | "model">;
  additional: HarnessModelEntry[];
}

export interface ConfigurationProvenance {
  source: string;
  capability: string;
  state: "inherited" | "overridden" | "missing" | "unsupported";
  evidence: "local_configuration";
  message: string;
}

export interface IsolatedCapabilityPolicy {
  version: 1;
  profile: "restricted-native-1";
  harness: HarnessId;
  configSource: string;
  configDigest: string;
  provenance: ConfigurationProvenance[];
  auth: {
    kind: "environment" | "claude-keychain" | "codex-file" | "pi-file";
    source: string;
  };
  preferences: Record<string, string | boolean | number>;
  library: {
    digest: string;
    roots: string[];
    skills: SkillSnapshot[];
    diagnostics: string[];
    loading: "native-pi" | "static-read-catalog";
  };
}

export interface CapturedHarnessEntry extends HarnessModelEntry {
  policy?: IsolatedCapabilityPolicy;
  role: "main" | "additional";
  model: string;
  additionalInstructions: string;
  effort?: ReviewerSettings["effort"];
}

export interface IsolatedRolesSnapshot {
  main: CapturedHarnessEntry;
  additional: CapturedHarnessEntry[];
}

export const dockerApprovalConfirmation =
  "I approve these exact container capabilities and temporary model credential exposures";

export interface DockerLocalMcpRequest extends NativeMcpImportRequest {
  enabled: boolean;
  allowedTools: string[];
}

export interface DockerSourceHandling {
  source: string;
  digest: string;
  kind:
    | "finder-metadata"
    | "presentation"
    | "host-project-trust"
    | "library-layout";
  effect: string;
  nativeSettingsUnchanged: true;
}

export interface DockerExclusion {
  id: string;
  source: string;
  sourceDigest: string;
  itemDigest: string;
  kind:
    | "herdr-session-start"
    | "status-line"
    | "slack-plugin"
    | "google-workspace-skill";
  pointer: string;
  definition: string;
  rationale: string;
  effect: string;
  nativeSettingsUnchanged: true;
}

export interface TrustedLibraryLeaf {
  source: string;
  resolvedSourcePath: string;
  sourceDigest: string;
}

export interface DockerLibraryLeaf extends TrustedLibraryLeaf {
  id: string;
  limits: { entries: number; decodedBytes: number; encoding: "utf8" };
  effect: string;
  nativeSettingsUnchanged: true;
}

export interface DockerLibraryLeafRequest {
  source: string;
}

export interface DockerInspectRequest {
  harness: HarnessId;
  libraryLeaves?: string[];
  localConnections?: DockerLocalMcpRequest[];
  exclusions?: string[];
}

export interface DockerCapabilityDisclosure {
  version: 1;
  profile: "container-native-1";
  digest: string;
  harness: HarnessId;
  model: string;
  skillPath: string;
  skillDigest: string;
  resources: Array<{
    encoding?: CapturedResource["encoding"];
    mediaType?: CapturedResource["mediaType"];
    bytes?: number;
    inputDigest?: string;
    source: string;
    target: string;
    digest: string;
    executable: boolean;
    resolvedSourcePath?: string;
    sourceDigest?: string;
  }>;
  sourceHandling?: DockerSourceHandling[];
  exclusions?: DockerExclusion[];
  libraryLeaves?: DockerLibraryLeaf[];
  customizations: Array<{
    id: string;
    harness: HarnessId;
    kind: "hooks" | "extensions" | "skill-code" | "shell-prefix";
    source: string;
    digest: string;
    capabilities: string[];
  }>;
  authentication: Array<{
    harness: HarnessId;
    source: string;
    presence: "present" | "missing" | "not_checked";
    compatibility: "supported_reference";
    tested: false;
    exposure: "temporary-container-access-token";
    readers: "all-container-code";
    refresh: false;
  }>;
  localConnections: Array<{
    request: DockerLocalMcpRequest;
    native: NativeMcpSource;
    profile: KnownMcpProfile;
    profileDigest: string;
    sourceDigest: string;
    target: string;
    transport: "container-stdio";
    inventory: "not_tested";
    connected: false;
  }>;
  boundary: {
    source: "immutable-input-disposable-workcopy";
    network: "none-with-captured-brokers";
    sourceWriteback: false;
    hostExecution: false;
  };
  requirements: string[];
  evidence: "local_configuration";
}

export interface DockerCapabilityApproval {
  exclusions?: string[];
  libraryLeaves?: string[];
  digest: string;
  customizations: string[];
  credentialExposures: HarnessId[];
  confirmation: string;
}

export interface DockerSetupRequest {
  harness: HarnessId;
  confirmation: string;
  approval?: DockerCapabilityApproval;
}

export interface DockerBoundarySnapshot {
  profile: "container-native-1";
  disclosure: DockerCapabilityDisclosure;
  approval: DockerCapabilityApproval;
}

export interface HostExecutionSnapshot {
  version: 1;
  harness: HarnessId;
  confirmedAt: string;
}

export interface DockerSetupStatus {
  status: "not_started" | "running" | "ready" | "failed";
  harness: HarnessId | null;
  message: string;
}

export interface HarnessSource {
  id: string;
  path: string;
  harness: HarnessId;
  skillPath: string;
  digest: string;
  importedAt: string | null;
}

export interface CapturedResource {
  encoding?: "utf8" | "base64";
  mediaType?: "font/woff2" | "image/png";
  inputDigest?: string;
  target: string;
  content: string;
  executable: boolean;
  sourcePath: string;
  resolvedSourcePath?: string;
  sourceDigest?: string;
}

export interface SkillSnapshot {
  version: 1;
  path: string;
  directory: string;
  digest: string;
  files: CapturedResource[];
}

export type SkillExecutionSnapshot = {
  harness: HarnessId;
  skill: SkillSnapshot;
  policy?: IsolatedCapabilityPolicy;
} & (
  | { version: 2; mode: ExecutionMode; roles?: never }
  | { version: 3; mode: "separated"; roles: IsolatedRolesSnapshot }
);

export interface HarnessSettings {
  isolated?: IsolatedRolesSnapshot;
  native?: Pick<ReviewerSettings, "additionalInstructions" | "effort">;
  skill?: SkillSnapshot;
  selection: ArchivedHarnessSelection | null;
  sources: HarnessSource[];
  managed?: Partial<Record<HarnessId, string>>;
  dangerousConsent?: HostExecutionSnapshot;
}

export interface HarnessStatus {
  capabilities: Array<{ id: string; policy: IsolatedCapabilityPolicy }>;
  reviewer: Pick<ReviewerSettings, "skillPath" | "model">;
  selection: HarnessSelection | null;
  archivedSelection: Pick<
    ArchivedHarnessSelection,
    "version" | "harness" | "workflow" | "reviewer"
  > | null;
  requiresSave: boolean;
  options: Array<{ id: HarnessId; label: string }>;
  effective: HarnessSelection | null;
  diagnostics: string[];
  evidence: "unverified" | "synthetic_preflight";
  mode: ExecutionMode | null;
  setup: DockerSetupStatus;
}

export interface ExecutionSnapshot {
  docker?: DockerBoundarySnapshot;
  version: 1 | 2;
  digest: string;
  image: string;
  policy: string;
  broker: string;
  models: { claude: string; codex: string };
  harness: HarnessId;
  sourceId?: string;
  skillDigest: string;
  fixture: boolean;
}

export interface ExecutionStatus {
  status: "disabled" | "configured" | "unavailable";
  message: string;
  snapshot: ExecutionSnapshot | null;
  lastApprovedDocker?: DockerBoundarySnapshot;
}

export interface ReviewerSettings {
  effort?: "low" | "medium" | "high";
  skillExecution?: SkillExecutionSnapshot;
  execution?: ExecutionSnapshot;
  hostExecution?: HostExecutionSnapshot;
  skillPath: string;
  model: string | null;
  additionalInstructions: string;
}

export type IntegrationId = "github" | "linear" | "notion" | string;
export type IntegrationProvider = "github" | "linear" | "notion" | "custom";
export type IntegrationTransport = "host-broker" | "mcp-http" | "mcp-stdio";
export type IntegrationAuthReuse =
  "gh-login" | "host-session" | "oauth-not-portable" | "none";
export type IntegrationConnectionStatus =
  | "ready"
  | "configured"
  | "disabled"
  | "needs_authentication"
  | "needs_compatibility"
  | "unsupported"
  | "error";
export type IntegrationEffectiveState =
  | "inherited"
  | "restricted"
  | "disabled"
  | "needs_authentication"
  | "needs_compatibility"
  | "unsupported";

export interface IntegrationToolDefinition {
  id: string;
  label: string;
  operation: "read";
  toolNames: string[];
  schemaFingerprint: string | null;
  allowedMethods: string[];
  argumentPolicy: "bounded";
}

export interface IntegrationDefinition {
  id: IntegrationId;
  provider: IntegrationProvider;
  label: string;
  transport: IntegrationTransport;
  authReuse: IntegrationAuthReuse;
  identity: string;
  tools: IntegrationToolDefinition[];
  supported: boolean;
  compatibilityMessage: string | null;
}

export interface NativeMcpSource {
  authentication?: "literal-bearer" | "app-owned-oauth";
  oauth?: { clientId: string; callbackPort: number };
  harness: HarnessId;
  format: "claude-json" | "codex-toml";
  path: string;
  name: string;
  digest: string;
  transport: "http" | "stdio" | "unsupported";
  support: "supported" | "unsupported";
  message: string;
}

export interface NativeMcpDiscoveryRequest {
  harness: HarnessId;
  path?: string;
}
export interface NativeMcpImportRequest {
  id: string;
  profileId: string;
  scope: string[];
}
export interface IntegrationInventory {
  oauthBinding?: McpOAuthBinding;
  status: "loaded" | "changed" | "error";
  checkedAt: string;
  scope: "local_configuration" | "synthetic_transport" | "live_inventory";
  connected: false;
  message: string;
  tools: Array<{ name: string; schemaFingerprint: string }>;
}

export interface KnownMcpProfile {
  id: string;
  label: string;
  provider: "documents";
  transport: "stateless-http";
  server: { name: string; version: string; protocol: string };
  endpointPath: string;
  tool: { name: string; id: string; inputSchema: unknown };
  preset: { id: "read-context"; label: string; allowedTools: string[] };
}

export type McpClientAuthMethod =
  "none" | "client_secret_basic" | "client_secret_post";

export interface McpOAuthProfile {
  id: string;
  label: string;
  endpoint: string;
  resourceMetadataUrl?: string;
  resource: string;
  issuers: string[];
  origins: string[];
  clientAuthMethods: McpClientAuthMethod[];
  publicClientPolicy?: "slack-pkce";
  dynamicRegistration: boolean;
  readScopes: string[];
  readSupport: "unavailable" | "supported";
  message: string;
}

export interface McpOAuthDiscovery {
  checkedAt: string;
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  clientAuthMethods: McpClientAuthMethod[];
  advertisedClientAuthMethods?: McpClientAuthMethod[];
  publicClientPolicy?: "slack-pkce";
  dynamicRegistration: boolean;
  scopes: string[];
  digest: string;
}

export interface McpOAuthStatus {
  profileId: string;
  configured: boolean;
  authenticated: boolean;
  evidence:
    "local_configuration" | "synthetic_transport" | "live_authentication";
  storage: "macos-keychain" | "synthetic" | "unsupported" | "unavailable";
  state:
    | "needs_discovery"
    | "needs_client"
    | "disconnected"
    | "authorizing"
    | "authenticated"
    | "reconnect_required";
  message: string;
  discovery?: McpOAuthDiscovery;
  clientId?: string;
  clientAuthMethod?: McpClientAuthMethod;
  redirectUri: string;
  appRedirectUri?: string;
  callbackMode?: "app" | "fixed-loopback";
  scopes: string[];
  generation: string;
  identity: { account: string; workspace: string; verifiedAt: string } | null;
  remoteRevocation: "not_attempted" | "unsupported" | "succeeded" | "failed";
  scopeReview?: {
    status: McpOAuthScopePreview["status"];
    expiresAt: string;
  };
}

export interface McpOAuthScopePreview {
  id: string;
  connectionId: string;
  generation: string;
  clientId: string;
  issuer: string;
  resource: string;
  redirectUri: string;
  expiresAt: string;
  source: "provider" | "requested_fallback";
  status: "accepted" | "approval_required" | "missing_required";
  requestedScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
  additionalScopes: string[];
}

export interface McpOAuthReviewReturnRequest {
  continuation: string;
}

export interface McpOAuthReviewReturn {
  connectionId: string;
  generation: string;
  status: McpOAuthScopePreview["status"];
  expiresAt: string;
}

export interface McpOAuthScopeApproval {
  previewId: string;
  generation: string;
  additionalScopes: string[];
  consent: "Accept these additional OAuth capabilities";
}

export interface McpOAuthConfigureRequest {
  redirectUri?: string;
  clientId: string;
  clientAuthMethod: McpClientAuthMethod;
  clientSecret?: string;
  scopes: string[];
  discoveryDigest: string;
}

export interface McpOAuthRegistrationRequest {
  redirectUri?: string;
  consent: "Register a new MCP OAuth client";
  clientAuthMethod: McpClientAuthMethod;
  scopes: string[];
  discoveryDigest: string;
}

export interface McpOAuthConnectResult {
  authorizationUrl: string;
  expiresAt: string;
  status: McpOAuthStatus;
}

export interface McpOAuthBinding {
  profileId: string;
  profileDigest: string;
  generation: string;
  issuer: string;
  resource: string;
  clientId: string;
  identity?: { account: string; workspace: string };
}

export interface ReadProviderReference {
  native?: NativeMcpSource;
  profileId?: string;
  profileDigest?: string;
  scope?: string[];
  path: string;
  digest: string;
  entryId: string;
}

export interface IntegrationTestResult {
  testedAt: string;
  mutating: false;
  scope: "local_configuration" | "synthetic_transport" | "live_read";
  connected: boolean;
  containmentVerified: false;
  status: IntegrationConnectionStatus;
  message: string;
}

export interface IntegrationConfig {
  oauthProfileId?: string;
  native?: NativeMcpSource;
  inventory?: IntegrationInventory;
  readProvider?: ReadProviderReference;
  id: IntegrationId;
  enabled: boolean;
  allowedTools: string[];
  source: "inherited" | "imported" | "custom";
  endpoint: string | null;
  serverName: string | null;
  authRef: string | null;
  configPath: string | null;
}

export interface IntegrationToolState {
  id: string;
  label: string;
  state: "allowed" | "disabled" | "unsupported";
  reason: string;
}

export interface IntegrationConnection {
  definition: IntegrationDefinition;
  config: IntegrationConfig;
  status: IntegrationConnectionStatus;
  effective: IntegrationEffectiveState;
  message: string;
  tools: IntegrationToolState[];
  evidence?: IntegrationTestResult;
  oauth?: McpOAuthStatus;
}

export interface IntegrationCatalog {
  profiles?: KnownMcpProfile[];
  oauthProfiles?: McpOAuthProfile[];
  connections: IntegrationConnection[];
  discoveredAt: string;
  boundary: {
    status: "available" | "unavailable";
    message: string;
  };
}

export interface IntegrationSettings {
  configs: IntegrationConfig[];
  importedHarnessAt: string | null;
}

export interface IntegrationSessionSnapshot {
  boundary: "read-only-gateway" | "none";
  connections: Array<{
    id: IntegrationId;
    effective: IntegrationEffectiveState;
    allowedTools: string[];
    readProvider?: ReadProviderReference;
    inventory?: IntegrationInventory;
    oauthBinding?: McpOAuthBinding;
    native?: NativeMcpSource;
  }>;
}

export interface AutomationPolicy {
  pollCommits: boolean;
  reviewNewCommits: boolean;
  pollRequests: boolean;
  reviewRequests: boolean;
}

export type AutomationKey = keyof AutomationPolicy;
export type AutomationMode = "inherit" | "on" | "off";
export type AutomationOverrideKey = "reviewNewCommits" | "reviewRequests";
export type AutomationOverrides = Record<AutomationOverrideKey, AutomationMode>;

export const automationKeys: AutomationKey[] = [
  "pollCommits",
  "reviewNewCommits",
  "pollRequests",
  "reviewRequests",
];

export const automationOverrideKeys: AutomationOverrideKey[] = [
  "reviewNewCommits",
  "reviewRequests",
];

export const pollingKeyFor: Record<AutomationOverrideKey, AutomationKey> = {
  reviewNewCommits: "pollCommits",
  reviewRequests: "pollRequests",
};

export const automationOff: AutomationPolicy = {
  pollCommits: false,
  reviewNewCommits: false,
  pollRequests: false,
  reviewRequests: false,
};

export const inheritAutomation: AutomationOverrides = {
  reviewNewCommits: "inherit",
  reviewRequests: "inherit",
};

export function resolveAutomation(
  global: AutomationPolicy,
  overrides: AutomationOverrides,
): AutomationPolicy {
  const pick = (key: AutomationOverrideKey) =>
    overrides[key] === "inherit" ? global[key] : overrides[key] === "on";
  return {
    pollCommits: global.pollCommits,
    reviewNewCommits: pick("reviewNewCommits"),
    pollRequests: global.pollRequests,
    reviewRequests: pick("reviewRequests"),
  };
}

export function effectiveAutomation(
  global: AutomationPolicy,
  overrides: AutomationOverrides,
): AutomationPolicy {
  const resolved = resolveAutomation(global, overrides);
  return {
    ...resolved,
    reviewNewCommits: global.pollCommits && resolved.reviewNewCommits,
    reviewRequests: global.pollRequests && resolved.reviewRequests,
  };
}

export const maxConcurrentReviewsRange = { min: 1, max: 8 } as const;

export function validConcurrentReviews(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= maxConcurrentReviewsRange.min &&
    (value as number) <= maxConcurrentReviewsRange.max
  );
}

export interface AppSettings {
  repository: string;
  automation: AutomationPolicy;
  pollIntervalSeconds: number;
  maxConcurrentReviews: number;
  reviewer: ReviewerSettings;
  harness?: HarnessSettings;
  integrations: IntegrationSettings;
}

export interface SettingsUpdate {
  repository?: string;
  automation?: Partial<AutomationPolicy>;
  pollIntervalSeconds?: number;
  maxConcurrentReviews?: number;
}

export interface IntegrationHealth {
  status: "ready" | "unavailable" | "unknown" | "error";
  message: string;
}

export interface AppHealth {
  github: IntegrationHealth;
  githubUser: string | null;
  lastPollAt: string | null;
  pollError: string | null;
  demo: boolean;
}

export type CommentSide = "LEFT" | "RIGHT";
export type RequestSource = "direct" | "team" | "both" | "unknown";

export interface Finding {
  id: string;
  severity: Severity;
  path: string | null;
  line: number | null;
  startLine: number | null;
  side: CommentSide;
  body: string;
  evidence: string;
  origin: "introduced" | "pre_existing";
  included: boolean;
  questionId: string | null;
}

export type MergeReadinessState =
  "ready" | "unstable" | "blocked" | "queued" | "unknown";

export type MergeBlockerKind =
  | "draft"
  | "conflicts"
  | "behind"
  | "changes_requested"
  | "review_required"
  | "checks_failed"
  | "checks_pending"
  | "blocked";

export interface MergeBlocker {
  kind: MergeBlockerKind;
  summary: string;
  detail: string | null;
  url: string | null;
  required: boolean;
}

export interface MergeObservation {
  checkedAt: string;
  state: MergeReadinessState;
  mergeStateStatus: string | null;
  blockers: MergeBlocker[];
  checksTruncated: boolean;
}

export interface MergeReadiness extends MergeObservation {
  headSha: string;
  error: string | null;
  lastKnown: MergeObservation | null;
}

export interface PullRequest {
  id: string;
  number: number;
  repository: string;
  url: string;
  title: string;
  body: string;
  author: string;
  authorAvatarUrl: string | null;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  requested: boolean;
  requestedAt: string | null;
  requestSource: RequestSource | null;
  imported: boolean;
  createdAt: string | null;
  updatedAt: string;
  status: PrStatus;
  blockingCount: number;
  nonBlockingCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  lastReviewedAt: string | null;
  hasReviewedHead: boolean;
  mergeReadiness: MergeReadiness | null;
  automation: AutomationOverrides;
  effectiveAutomation: AutomationPolicy;
}

export function inboxEligible(pr: PullRequest): boolean {
  return pr.state === "OPEN" && (pr.requested || pr.imported);
}

export const reviewOutputVersion = "1.0";

export interface ReviewOutputCheck {
  version: typeof reviewOutputVersion;
  status: "valid" | "invalid";
  diagnostics: string[];
}

export interface ReviewResult {
  overview: string;
  body: string;
  findings: Finding[];
  verdict: ReviewVerdict;
  rationale: string;
}

export type RunPhaseId =
  "sync" | "checkout" | "codex" | "claude" | "workflow" | "finalize";
export type RunPhaseStatus =
  "running" | "completed" | "failed" | "skipped" | "interrupted";
export type ActivitySource = "app" | "codex" | "claude";
export type ActivityKind =
  "phase" | "read" | "search" | "list" | "command" | "tool" | "message";

export interface RunPhase {
  id: RunPhaseId;
  status: RunPhaseStatus;
  startedAt: string;
  finishedAt: string | null;
  detail: string | null;
}

export interface RunActivity {
  at: string;
  source: ActivitySource;
  kind: ActivityKind;
  label: string;
}

export interface HarnessEntryEvidence {
  id: string;
  role: CapturedHarnessEntry["role"];
  harness: HarnessId;
  model: string;
  status:
    "pending" | "running" | "completed" | "failed" | "interrupted" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  result: ReviewResult | null;
  error: string | null;
}

export interface RunProgress {
  entries?: HarnessEntryEvidence[];
  phases: RunPhase[];
  activity: RunActivity[];
  activityCount: number;
  lastActivityAt: string | null;
  updatedAt: string;
}

export interface ReviewRun {
  id: string;
  prId: string;
  kind: "review" | "revision";
  trigger: "request" | "new_commits" | "manual" | "revision";
  requestEventId: string | null;
  status: RunStatus;
  headSha: string;
  baseSha: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  log: string;
  reviewer: ReviewerSettings;
  integrationSnapshot?: IntegrationSessionSnapshot;
  result: ReviewResult | null;
  progress: RunProgress | null;
}

export interface ReviewDraft {
  id: string;
  runId: string | null;
  headSha: string;
  version: number;
  overview: string;
  body: string;
  findings: Finding[];
  verdict: ReviewVerdict;
  createdAt: string;
  updatedAt: string;
}

export interface DraftUpdate {
  draftId: string;
  version: number;
  body: string;
  findings: Finding[];
  verdict: ReviewVerdict;
}

export interface RevisionRequest {
  draftId: string;
  draftVersion: number;
  instructions: string;
  findingIds?: string[];
}

export interface RevisionProposal {
  id: string;
  runId: string;
  draftId: string;
  sourceDraftVersion: number;
  instructions: string;
  status: "pending" | "accepted" | "rejected";
  result: ReviewResult;
  createdAt: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: CommentSide;
  start_line?: number;
  start_side?: CommentSide;
  body: string;
}

export interface ReviewPayload {
  event: ReviewVerdict;
  body: string;
  commit_id: string;
  comments: ReviewComment[];
}

export interface SubmissionPreview {
  id: string;
  prId: string;
  draftId: string;
  draftVersion: number;
  payload: ReviewPayload;
  createdAt: string;
}

export interface Submission {
  id: string;
  previewId: string;
  status: "submitting" | "submitted" | "uncertain" | "failed";
  payload: ReviewPayload;
  githubReviewId: string | null;
  url: string | null;
  error: string | null;
  createdAt: string;
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string | null;
  committedAt: string | null;
  url: string;
}

export type FreshnessStatus =
  "fresh" | "stale" | "rewritten" | "unavailable" | "unknown";

export interface Freshness {
  baseline: string;
  head: string;
  status: FreshnessStatus;
  commits: CommitSummary[];
  truncated: boolean;
  checkedAt: string;
  error: string | null;
}

export interface LineRef {
  side: CommentSide;
  line: number;
}

export interface SelectionRange {
  path: string;
  from: LineRef;
  to: LineRef;
  baseSha: string;
  headSha: string;
}

export interface DiffSelection extends SelectionRange {
  oldPath: string | null;
  snippet: string;
  kinds: { add: boolean; del: boolean; ctx: boolean };
  spansHunks: boolean;
  anchors: Partial<Record<CommentSide, { startLine: number; line: number }>>;
}

export type QuestionMode = "explain" | "investigate" | "draft_comment";
export type QuestionStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface QuestionRequest {
  mode: QuestionMode;
  range: SelectionRange;
  question?: string;
  parentId?: string | null;
  draftId?: string | null;
}

export type QuestionAnswer =
  | { kind: "answer"; answer: string; followUps: string[] }
  | {
      kind: "comment";
      body: string;
      severity: Severity;
      origin: Finding["origin"];
      evidence: string;
    };

export interface Question {
  id: string;
  prId: string;
  draftId: string | null;
  parentId: string | null;
  mode: QuestionMode;
  status: QuestionStatus;
  baseSha: string;
  headSha: string;
  selection: DiffSelection;
  question: string;
  answer: QuestionAnswer | null;
  error: string | null;
  integrationSnapshot?: IntegrationSessionSnapshot;
  reviewerSnapshot?: ReviewerSettings;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PullRequestDetail {
  pr: PullRequest;
  diff: string;
  diffTruncated: boolean;
  runs: ReviewRun[];
  drafts: ReviewDraft[];
  draft: ReviewDraft | null;
  proposals: RevisionProposal[];
  submissions: Submission[];
  freshness: Freshness | null;
  questions: Question[];
}

export interface RefreshOperation {
  id: string;
  repository: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface SyncOperation extends RefreshOperation {
  mode: "manual" | "scheduled";
}

export interface ImportOperation extends RefreshOperation {
  prId: string;
  number: number;
}

export interface AppState {
  operations: {
    sync: SyncOperation | null;
    imports: ImportOperation[];
  };
  settings: Omit<AppSettings, "harness">;
  health: AppHealth;
  integrations: IntegrationCatalog;
  prs: PullRequest[];
}

export interface ApiError {
  error: string;
  code?: string;
}

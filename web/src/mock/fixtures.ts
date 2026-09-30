import {
  automationOff,
  dockerApprovalConfirmation,
  effectiveAutomation,
  inheritAutomation,
  type AppSettings,
  type AppHealth,
  type CapturedHarnessEntry,
  type CommitSummary,
  type DockerBoundarySnapshot,
  type DockerCapabilityApproval,
  type DockerCapabilityDisclosure,
  type DockerExclusion,
  type DockerLibraryLeaf,
  type DockerLocalMcpRequest,
  type DockerSourceHandling,
  type ExecutionSnapshot,
  type HarnessEntryEvidence,
  type HarnessId,
  type HarnessSource,
  type HarnessModelDiscovery,
  type HarnessModelSource,
  type HarnessStatus,
  type IntegrationConfig,
  type IntegrationDefinition,
  type IntegrationToolDefinition,
  type IsolatedCapabilityPolicy,
  type KnownMcpProfile,
  type McpOAuthDiscovery,
  type McpOAuthProfile,
  type NativeMcpSource,
  type Finding,
  type MergeBlocker,
  type MergeReadiness,
  type PullRequest,
  type Question,
  type ReviewDraft,
  type ReviewResult,
  type ReviewRun,
  type ReviewerSettings,
  type RunActivity,
  type RunPhase,
  type RunProgress,
  type SkillSnapshot,
  type Submission,
} from "../../../shared/contracts";

export const MOCK_LABEL = "Mock API (test only)";

const base = Date.now();
const t = (minutesAgo: number) => new Date(base - minutesAgo * 60_000).toISOString();

export const reviewer: ReviewerSettings = {
  skillPath: "/Users/demo/.claude/skills/pr-review/SKILL.md",
  model: null,
  additionalInstructions: "",
};

const readTool = (
  id: string,
  toolNames: string[],
  allowedMethods: string[] = [],
): IntegrationToolDefinition => ({
  id,
  label: "Bounded read context",
  operation: "read",
  toolNames,
  schemaFingerprint: "mock-schema-fingerprint",
  allowedMethods,
  argumentPolicy: "bounded",
});

export const readProviderDefinitions: IntegrationDefinition[] = [
  {
    id: "github",
    provider: "github",
    label: "GitHub",
    transport: "host-broker",
    authReuse: "gh-login",
    identity: "https://api.github.com",
    supported: true,
    compatibilityMessage: null,
    tools: [
      readTool("pull-request", ["github_pull_request_read"], ["get", "get_files", "get_reviews"]),
    ],
  },
  {
    id: "linear",
    provider: "linear",
    label: "Linear",
    transport: "host-broker",
    authReuse: "host-session",
    identity: "https://api.linear.app/graphql",
    supported: true,
    compatibilityMessage: null,
    tools: [readTool("issue", ["linear_get_issue"])],
  },
  {
    id: "notion",
    provider: "notion",
    label: "Notion",
    transport: "host-broker",
    authReuse: "host-session",
    identity: "https://api.notion.com/v1",
    supported: true,
    compatibilityMessage: null,
    tools: [readTool("page", ["notion_read"])],
  },
  {
    id: "custom:documents",
    provider: "custom",
    label: "Vetted document MCP",
    transport: "mcp-http",
    authReuse: "host-session",
    identity: "pr-review-documents/1 (explicitly vetted endpoint required)",
    supported: true,
    compatibilityMessage: null,
    tools: [readTool("document", ["documents_get"])],
  },
];

export const READ_PROVIDER_MANIFEST = "/Users/demo/pr-review/read-providers.json";
export const READ_PROVIDER_DIGEST =
  "5f2c0d4b9a1e3c7d8b6a4f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c";

export const importedReadConfigs: IntegrationConfig[] = readProviderDefinitions.map(
  (definition) => ({
    readProvider: {
      path: READ_PROVIDER_MANIFEST,
      digest: READ_PROVIDER_DIGEST,
      entryId: definition.id,
    },
    id: definition.id,
    enabled: false,
    allowedTools: [],
    source: "imported",
    endpoint:
      definition.provider === "custom" ? "https://docs.example.com/mcp" : definition.identity,
    serverName: null,
    authRef: definition.id === "github" ? "gh-login" : "json-value",
    configPath: null,
  }),
);

export const SKILL_PATH = "/Users/demo/.claude/skills/pr-review/SKILL.md";
export const CUSTOM_SKILL_PATH = "/Users/demo/review-skills/security-audit/ENTRY.md";
export const SCRIPTED_SKILL_PATH = "/Users/demo/review-skills/scripted/SKILL.md";
export const MISSING_SKILL_PATH = "/Users/demo/review-skills/missing/SKILL.md";

export const nativeDefaultModel: Record<HarnessId, string> = {
  claude: "claude-fable-5",
  codex: "gpt-6-astra",
  pi: "openai-codex/gpt-6-astra",
};

const discoverySource = (
  source: Partial<HarnessModelSource> & Pick<HarnessModelSource, "id" | "kind" | "status">,
): HarnessModelSource => ({
  path: null,
  modifiedAt: null,
  freshness: "not_applicable",
  message: "",
  ...source,
});

export const modelDiscoveryCatalog: Record<
  HarnessId,
  Pick<HarnessModelDiscovery, "models" | "sources">
> = {
  claude: {
    models: [
      {
        model: "mock-claude-configured",
        label: "mock-claude-configured",
        sources: ["native-settings"],
      },
    ],
    sources: [
      discoverySource({
        id: "native-settings",
        kind: "configuration",
        path: "/Users/demo/.claude/settings.json",
        status: "ready",
        modifiedAt: "2026-09-20T10:00:00.000Z",
        message: "Configured model only, not an available-model list.",
      }),
    ],
  },
  codex: {
    models: [
      {
        model: "mock-codex-configured",
        label: "mock-codex-configured",
        sources: ["native-settings"],
      },
    ],
    sources: [
      discoverySource({
        id: "native-settings",
        kind: "configuration",
        path: "/Users/demo/.codex/config.toml",
        status: "ready",
        modifiedAt: "2026-09-20T10:00:00.000Z",
        message: "Configured model only, not an available-model list.",
      }),
    ],
  },
  pi: {
    models: [
      { model: "mock-provider/custom-v1", label: "Mock Custom Model", sources: ["pi-models"] },
      {
        model: "openai-codex/mock-pi-cached",
        label: "Mock Pi Cached",
        sources: ["pi-models-store"],
      },
      {
        model: "openai-codex/mock-pi-native",
        label: "Mock Pi Native",
        sources: ["native-settings", "pi-models-store"],
      },
    ],
    sources: [
      discoverySource({
        id: "native-settings",
        kind: "configuration",
        path: "/Users/demo/.pi/agent/settings.json",
        status: "ready",
        modifiedAt: "2026-09-20T10:00:00.000Z",
        message: "Configured defaultProvider/defaultModel only.",
      }),
      discoverySource({
        id: "pi-models",
        kind: "configuration",
        path: "/Users/demo/.pi/agent/models.json",
        status: "ready",
        modifiedAt: "2026-09-20T10:00:00.000Z",
        message: "Literal custom model declarations only; patterns and auth are not resolved.",
      }),
      discoverySource({
        id: "pi-models-store",
        kind: "cached_catalog",
        path: "/Users/demo/.pi/agent/models-store.json",
        status: "ready",
        modifiedAt: "2026-09-18T08:30:00.000Z",
        freshness: "unknown",
        message: "Offline cached provider catalog, possibly stale; not refreshed or verified.",
      }),
    ],
  },
};

export const nativeCatalogSource = (harness: HarnessId) =>
  discoverySource({
    id: "native-catalog",
    kind: "catalog",
    status: "unsupported",
    freshness: "unknown",
    message: `${harnessOptions.find((o) => o.id === harness)!.label} live/full model catalog is not launched under this read-only profile.`,
  });

export const harnessOptions: HarnessStatus["options"] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "Pi" },
];

export const DOCKER_UNAVAILABLE_MESSAGE =
  "Docker socket unix:///var/run/docker.sock is unavailable on this host; the pinned macOS arm64 engine profile was not found.";
export const ISOLATED_MESSAGE =
  "Isolated Main/Additional harnesses use captured restricted-native-1 capabilities and synthesize one draft. Restricted native tools, not OS/process containment.";
export const REQUIRES_SAVE_MESSAGE =
  "Save the selected execution explicitly before new reviews; nothing was captured or authorized on load.";
export const ARCHIVED_MESSAGE =
  "The saved choice predates the supported Isolated Main/Additional, Docker and Dangerous contracts and cannot run. Save current Settings for new sessions; history is not rewritten.";
export const HOME = "/Users/demo";
export const CLAUDE_MCP_PATH = `${HOME}/.claude.json`;
export const CODEX_MCP_PATH = `${HOME}/.codex/config.toml`;
export const EMPTY_MCP_PATH = `${HOME}/empty-mcp.json`;
export const DANGEROUS_MESSAGE =
  "Dangerous host execution has no app-imposed tool, credential, filesystem or publishing boundary. Read-integration checkboxes and app preview do not constrain native tools. Native availability is checked only when a run starts; no fallback is permitted.";
export const DOCKER_SETUP_REQUIRED_MESSAGE =
  "Docker setup is required for this harness. Explicitly run app-managed setup; nothing is installed or selected automatically.";
export const DOCKER_SETUP_STALE_MESSAGE =
  "Docker setup does not match the selected model, skill bytes or resources. Explicitly run Set up Docker for this saved selection; historical sources are not rewritten.";
export const SETUP_DISCLOSURE =
  "First explicitly inspect the saved Docker selection and review its exact portable source identities, executable customizations, contained local MCP grants and temporary model credential exposures. All container code can read approved model access tokens; no business credentials or refresh material enter the container. Setup requires that exact fresh approval plus separate host-effects confirmation. It reads the disclosed resources, downloads pinned publisher-verified Linux runtimes and a Docker image when missing, runs a credential-free networked installer, writes app-owned cache/artifacts and performs credential-free runtime/policy preflight. It never installs Docker Desktop, selects a mode, enables automation, reads model credentials, logs in, refreshes auth or calls a model/provider. No review-time download or host fallback. Configured is not Connected.";
export const DOCKER_INSPECTION_REQUIRED_MESSAGE =
  "Explicit Docker capability inspection and exact approval are required before setup; old setup requests grant no new capabilities.";
export const DOCKER_APPROVAL_MESSAGE =
  "Docker capability approval is missing or changed. Inspect the saved Docker selection, review every source/capability and temporary model credential exposure, then explicitly approve that exact disclosure before setup. Old setup confirmation grants none of these capabilities.";
export const DOCKER_INSPECT_UNSAVED_MESSAGE =
  "Save the matching Docker selection before explicit capability inspection";
export const DOCKER_SKILL_CHANGED_MESSAGE =
  "Selected skill changed since Save. Explicitly save it again before inspecting Docker capabilities.";
export const DOCKER_LOCAL_MCP_MESSAGE =
  "Docker local MCP requires a discovered stdio identity, known profile, exact resource scope and explicit default-denied tool choices";
export const DOCKER_STDIO_ADAPTER_MESSAGE =
  "Docker stdio supports only an explicitly approved local Node .mjs entry with prepared portable resources, no environment, auth helpers, package runner or download. Rediscover changed configuration.";
export const DOCKER_LEGACY_ARTIFACT_MESSAGE =
  "This Docker artifact predates explicit container capability approval. History is unchanged; inspect and approve setup for new sessions.";
export const SETUP_READY_MESSAGE =
  "Managed source cached. Runtime is checked again before execution; authentication/provider readiness is not verified.";
export const SETUP_FAILED_MESSAGE =
  "Mock fixture: Docker setup failed. Docker socket unix:///var/run/docker.sock is unavailable on this host; nothing was installed, selected or stripped. Retry after starting Docker Desktop at the supported profile.";
export const SCRIPTED_SKILL_MESSAGE =
  "Isolated harness sessions can read companion scripts but cannot execute them. If they are required, choose compatible Docker or explicitly consent to Dangerous. Dependency inventory is best effort, not exhaustive.";
export const INVALID_SKILL_MESSAGE =
  "skillPath must be an explicit absolute Markdown file path; select the installed entry file, not a workflow JSON";

export const mockDigest = (label: string, bytes: string) => {
  let hash = 0;
  for (const char of bytes) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${hash.toString(16).padStart(8, "0")}-${label}`.padEnd(64, "0").slice(0, 64);
};

export const DEFAULT_SKILL_BYTES = "# Mock skill fixture";

export const skillSnapshot = (path: string, content = DEFAULT_SKILL_BYTES): SkillSnapshot => {
  const parts = path.split("/");
  const directory = parts[parts.length - 2]!;
  return {
    version: 1,
    path,
    directory,
    digest: mockDigest(`skill-${directory}`, content),
    files: [
      {
        target: `resources/${directory}/${parts[parts.length - 1]}`,
        content,
        executable: false,
        sourcePath: path,
      },
    ],
  };
};

export const executionSnapshot = (source: HarnessSource): ExecutionSnapshot => ({
  version: 1,
  digest: source.digest,
  image: "sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
  policy: "policy-mock-digest",
  broker: "broker-mock-digest",
  models: { claude: "claude-fable-5", codex: "gpt-6-astra" },
  harness: source.harness,
  sourceId: source.id,
  skillDigest: "skill-mock-digest",
  fixture: true,
});

export const knownProfile: KnownMcpProfile = {
  id: "pr-review-documents/1",
  label: "Stateless document reader (reference protocol, not a live service)",
  provider: "documents",
  transport: "stateless-http",
  server: { name: "pr-review-documents", version: "1", protocol: "2025-03-26" },
  endpointPath: "/mcp",
  tool: {
    name: "documents_get",
    id: "document",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  preset: {
    id: "read-context",
    label: "Read explicitly scoped documents",
    allowedTools: ["document"],
  },
};

const nativeEntry = (
  harness: "claude" | "codex",
  name: string,
  transport: NativeMcpSource["transport"],
  support: "supported" | "unsupported",
  message: string,
  endpoint: string | null,
  source?: {
    path: string;
    authentication: NativeMcpSource["authentication"];
    oauth?: NativeMcpSource["oauth"];
  },
): IntegrationConfig => {
  const path = source?.path ?? (harness === "claude" ? CLAUDE_MCP_PATH : CODEX_MCP_PATH);
  return {
    native: {
      ...(source ? { authentication: source.authentication } : {}),
      ...(source?.oauth ? { oauth: source.oauth } : {}),
      harness,
      format: harness === "claude" ? "claude-json" : "codex-toml",
      path,
      name,
      digest: `${harness}-${name}-mock-digest-0000000000000000000000000000000000000000`.slice(
        0,
        64,
      ),
      transport,
      support,
      message,
    },
    id: `native:${harness}-${name}-mock-identity`,
    enabled: false,
    allowedTools: [],
    source: "imported",
    endpoint,
    serverName: name,
    authRef: null,
    configPath: path,
  };
};

export const STDIO_MESSAGE =
  "Local stdio executes host code. This profile never spawns it, including on discovery, enable, Load or Test. Use an independently supported Docker projection or explicit Dangerous native access.";
export const SUPPORTED_NATIVE_MESSAGE =
  "Static HTTPS bearer configuration is reusable with an explicit known profile and resource scope. No auth or server availability was tested.";
export const UNSUPPORTED_NATIVE_MESSAGE =
  "Unsupported transport, auth or native fields. Only stateless HTTPS with a literal Authorization bearer header is supported; OAuth stores, helpers, env interpolation, SSE and sessionful HTTP require a separate supported profile.";

export const nativeDiscoveries: Record<"claude" | "codex", IntegrationConfig[]> = {
  claude: [
    nativeEntry(
      "claude",
      "documents",
      "http",
      "supported",
      SUPPORTED_NATIVE_MESSAGE,
      "https://documents.example.invalid/mcp",
    ),
    nativeEntry("claude", "local-tools", "stdio", "unsupported", STDIO_MESSAGE, null),
    nativeEntry(
      "claude",
      "oauth-sse",
      "unsupported",
      "unsupported",
      UNSUPPORTED_NATIVE_MESSAGE,
      "https://oauth.example.invalid/mcp",
    ),
  ],
  codex: [
    nativeEntry(
      "codex",
      "documents",
      "http",
      "supported",
      SUPPORTED_NATIVE_MESSAGE,
      "https://documents.example.invalid/mcp",
    ),
    nativeEntry("codex", "local-tools", "stdio", "unsupported", STDIO_MESSAGE, null),
  ],
};

export const PLUGIN_MCP_PATH = `${HOME}/.claude/plugins/slack/.mcp.json`;
export const OAUTH_METADATA_MESSAGE =
  "Trusted HTTP MCP definition only. Declared OAuth client/callback metadata is not an app-owned registration or authenticated session. Import a matching profile and confirm a supported client/redirect before explicit Connect; no native login is read or reused.";
export const DECLARED_PLUGIN_CLIENT_ID = "mock-declared-plugin-client.0000";
export const DECLARED_PLUGIN_CALLBACK_PORT = 3118;

export const slackOAuthProfile: McpOAuthProfile = {
  id: "slack-mcp/1",
  label: "Slack MCP (app-owned OAuth)",
  endpoint: "https://mcp.slack.com/mcp",
  resource: "https://mcp.slack.com/mcp",
  issuers: ["https://mcp.slack.com"],
  origins: ["https://mcp.slack.com", "https://slack.com"],
  clientAuthMethods: ["none", "client_secret_basic", "client_secret_post"],
  dynamicRegistration: false,
  readScopes: ["search:read.public", "search:read.private", "channels:history", "groups:history"],
  readSupport: "supported",
  message:
    "Authenticated Slack reads use provider access controls, not independently verified account/workspace identity or app-enforced channel isolation. Explicit tool grants are required. Writes and unclassified tools are denied. Responses are bounded, untrusted provider content; citations and completeness are only available when supplied.",
};

export const mockSlackReadTools = [
  {
    id: "slack_search_public",
    label: "Search accessible public Slack messages, one bounded page.",
  },
  {
    id: "slack_search_public_and_private",
    label: "Search accessible public and private Slack messages, one bounded page.",
  },
  { id: "slack_read_channel", label: "Read accessible Slack channel history, one bounded page." },
  { id: "slack_read_thread", label: "Read an accessible Slack thread, one bounded page." },
];

export const linearOAuthProfile: McpOAuthProfile = {
  id: "linear-mcp/1",
  label: "Linear MCP (app-owned OAuth)",
  endpoint: "https://mcp.linear.app/mcp",
  resource: "https://mcp.linear.app/mcp",
  issuers: ["https://mcp.linear.app"],
  origins: ["https://mcp.linear.app"],
  clientAuthMethods: ["none", "client_secret_basic", "client_secret_post"],
  dynamicRegistration: true,
  readScopes: ["read"],
  readSupport: "supported",
  message:
    "Use an eligible existing client or explicitly register this app with Linear using the advertised public-client method and read scope. Complete Linear sign-in and any local additional-capability decision, then Load tools and choose read grants. No native login is reused. Authentication and inventory alone are not successful review access.",
};

export const mockLinearReadTools = [
  {
    id: "get_issue",
    label:
      "Read a Linear issue by identifier (e.g. ENG-123) or UUID. Provider content is untrusted.",
  },
  {
    id: "list_issues",
    label:
      "Search Linear issue titles and descriptions, one bounded page. Provider content is untrusted; no complete coverage is implied.",
  },
];

export const axiomOAuthProfile: McpOAuthProfile = {
  id: "axiom-mcp/1",
  label: "Axiom MCP (app-owned OAuth)",
  endpoint: "https://mcp.axiom.co/mcp",
  resource: "https://mcp.axiom.co/mcp",
  issuers: ["https://authorization.axiom.co"],
  origins: ["https://mcp.axiom.co", "https://authorization.axiom.co"],
  clientAuthMethods: ["none", "client_secret_basic", "client_secret_post"],
  dynamicRegistration: true,
  readScopes: ["openid", "offline_access"],
  readSupport: "supported",
  message:
    "Synthetic Axiom fixture. Host-owned OAuth can carry account write permissions; the broker only permits separately approved reads. Queries can incur cost and results route through US infrastructure.",
};

export const mockAxiomReadTools = [
  { id: "listDatasets", label: "List accessible Axiom datasets." },
  { id: "getDatasetFields", label: "Read observed Axiom dataset fields." },
  {
    id: "queryDataset",
    label: "Read bounded Axiom event samples, at most 20 events over one hour.",
  },
];

export const syntheticOAuthProfile: McpOAuthProfile = {
  id: "synthetic-oauth-mcp/1",
  label: "Synthetic OAuth MCP (mock fixture, registration advertised)",
  endpoint: "https://synthetic-oauth.example.invalid/mcp",
  resource: "https://synthetic-oauth.example.invalid/mcp",
  issuers: ["https://synthetic-oauth.example.invalid"],
  origins: ["https://synthetic-oauth.example.invalid"],
  clientAuthMethods: ["none", "client_secret_post"],
  dynamicRegistration: true,
  readScopes: ["read:synthetic"],
  readSupport: "unavailable",
  message:
    "Mock fixture profile. Dynamic registration is advertised only to exercise the separate consent step; no service exists and no read adapter is vetted.",
};

export const oauthProfiles: McpOAuthProfile[] = [
  slackOAuthProfile,
  linearOAuthProfile,
  axiomOAuthProfile,
  syntheticOAuthProfile,
];

export const oauthDiscovery = (
  profile: McpOAuthProfile,
  checkedAt: string,
  publicClient = false,
): McpOAuthDiscovery => ({
  checkedAt,
  issuer: profile.issuers[0]!,
  resource: profile.resource,
  authorizationEndpoint: `${profile.issuers[0]}/oauth/authorize`,
  clientAuthMethods:
    profile.id === slackOAuthProfile.id
      ? publicClient
        ? ["client_secret_post", "none"]
        : ["client_secret_post"]
      : ["none"],
  dynamicRegistration: profile.dynamicRegistration,
  scopes: profile.readScopes.slice(0, 2),
  digest: mockDigest("oauth-discovery", profile.id),
});

export const pluginDiscoveries: IntegrationConfig[] = [
  nativeEntry(
    "claude",
    "slack",
    "http",
    "supported",
    OAUTH_METADATA_MESSAGE,
    slackOAuthProfile.endpoint,
    {
      path: PLUGIN_MCP_PATH,
      authentication: "app-owned-oauth",
      oauth: { clientId: DECLARED_PLUGIN_CLIENT_ID, callbackPort: DECLARED_PLUGIN_CALLBACK_PORT },
    },
  ),
  nativeEntry(
    "claude",
    "linear-server",
    "http",
    "supported",
    OAUTH_METADATA_MESSAGE,
    linearOAuthProfile.endpoint,
    { path: PLUGIN_MCP_PATH, authentication: "app-owned-oauth" },
  ),
  nativeEntry(
    "claude",
    "axiom",
    "http",
    "supported",
    OAUTH_METADATA_MESSAGE,
    axiomOAuthProfile.endpoint,
    { path: PLUGIN_MCP_PATH, authentication: "app-owned-oauth" },
  ),
  nativeEntry(
    "claude",
    "synthetic-oauth",
    "http",
    "supported",
    OAUTH_METADATA_MESSAGE,
    syntheticOAuthProfile.endpoint,
    { path: PLUGIN_MCP_PATH, authentication: "app-owned-oauth" },
  ),
  nativeEntry(
    "claude",
    "plugin-bearer",
    "http",
    "unsupported",
    UNSUPPORTED_NATIVE_MESSAGE,
    "https://plugin-bearer.example.invalid/mcp",
    { path: PLUGIN_MCP_PATH, authentication: undefined },
  ),
];

export const nativeConfigBytes: Record<HarnessId, string> = {
  claude: '{"language":"english"}',
  codex: 'personality = "pragmatic"',
  pi: "transport: sse",
};

export const policyFixture = (
  harness: HarnessId,
  configBytes = nativeConfigBytes[harness],
): IsolatedCapabilityPolicy => {
  const root =
    harness === "claude"
      ? `${HOME}/.claude`
      : harness === "codex"
        ? `${HOME}/.codex`
        : `${HOME}/.pi/agent`;
  const source = (
    capability: string,
    state: IsolatedCapabilityPolicy["provenance"][number]["state"],
    message: string,
  ) => ({ source: root, capability, state, evidence: "local_configuration" as const, message });
  const missingAuth = harness === "codex";
  return {
    version: 1,
    profile: "restricted-native-1",
    harness,
    configSource: root,
    configDigest: mockDigest(`${harness}-config`, configBytes),
    provenance: [
      source(
        harness === "claude" ? "language" : harness === "codex" ? "personality" : "transport",
        "inherited",
        "Supported ordinary preference captured; explicit selected model takes precedence.",
      ),
      source(
        harness === "claude" ? "hooks" : harness === "codex" ? "mcp_servers" : "extensions",
        "overridden",
        "Deliberately disabled or replaced by the approved restricted profile.",
      ),
      source(
        harness === "pi" ? "themes" : "statusLine",
        "unsupported",
        "Not projected by this bounded profile. It cannot grant capabilities.",
      ),
      source("model", "overridden", "The app-selected resolved model is passed explicitly."),
      source(
        "tools/configuration",
        "overridden",
        "Only app read/checker and captured gateway tools; no shell, project config, inherited executable customizations or publishing. Not OS containment.",
      ),
      source(
        "model authentication",
        missingAuth ? "missing" : "inherited",
        `Execution-time ${harness === "claude" ? "claude-keychain" : `${harness}-file`} reference only; ${missingAuth ? "source file is missing" : "credentials have not been read or tested"}. No login/refresh or cross-harness substitution.`,
      ),
    ],
    auth:
      harness === "claude"
        ? { kind: "claude-keychain", source: "Claude Code-credentials" }
        : { kind: harness === "codex" ? "codex-file" : "pi-file", source: `${root}/auth.json` },
    preferences:
      harness === "claude"
        ? { language: "english" }
        : harness === "codex"
          ? { personality: "pragmatic" }
          : { transport: "sse" },
    library: {
      digest: `${harness}-library-mock-digest`,
      roots: [`${root}/skills`, ...(harness === "claude" ? [] : [`${HOME}/.agents/skills`])],
      skills: harness === "pi" ? [] : [skillSnapshot(`${root}/skills/release-notes/SKILL.md`)],
      diagnostics:
        harness === "pi"
          ? [
              "Pi skill patterns/exclusions are unsupported; use an ordinary trusted native skill root.",
            ]
          : [],
      loading: harness === "pi" ? "native-pi" : "static-read-catalog",
    },
  };
};

export const settings: AppSettings = {
  repository: "acme/rocket",
  automation: { ...automationOff, pollRequests: true, reviewRequests: true },
  pollIntervalSeconds: 120,
  maxConcurrentReviews: 1,
  reviewer,
  integrations: { configs: [], importedHarnessAt: null },
};

export const health: AppHealth = {
  github: { status: "ready", message: "Authenticated as demo-user via gh" },
  githubUser: "demo-user",
  lastPollAt: t(3),
  pollError: null,
  demo: true,
};

const findings: Finding[] = [
  {
    id: "f-1",
    severity: "blocking",
    path: "src/billing/invoice.ts",
    line: 42,
    body: "`applyDiscount` mutates the shared `lineItems` array, so a second render of the invoice double-applies the discount.",
    evidence: "lineItems.forEach((item) => { item.amount -= discount })",
    origin: "introduced",
    included: true,
    startLine: null,
    side: "RIGHT",
    questionId: null,
  },
  {
    id: "f-2",
    severity: "non_blocking",
    path: "src/billing/invoice.ts",
    line: 58,
    body: "Rounding happens before currency conversion; consider converting first to avoid drift on sub-cent amounts.",
    evidence: "Math.round(total) * rate",
    origin: "introduced",
    included: true,
    startLine: null,
    side: "RIGHT",
    questionId: null,
  },
  {
    id: "f-3",
    severity: "non_blocking",
    path: null,
    line: null,
    body: "The migration in this PR is not covered by a test that exercises a populated table.",
    evidence: "",
    origin: "pre_existing",
    included: false,
    startLine: null,
    side: "RIGHT",
    questionId: null,
  },
];

export const diff = `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
index 3f1c2a1..9b8d7e2 100644
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -36,12 +36,20 @@ export function buildInvoice(lineItems: LineItem[], rate: number) {
   const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
-  return { subtotal, total: subtotal * rate };
+  const discount = discountFor(subtotal);
+  applyDiscount(lineItems, discount);
+  const total = Math.round(subtotal - discount) * rate;
+  return { subtotal, total, discount };
 }
 
+function applyDiscount(lineItems: LineItem[], discount: number) {
+  lineItems.forEach((item) => {
+    item.amount -= discount / lineItems.length;
+  });
+}
+
 export function discountFor(subtotal: number) {
   return subtotal > 1000 ? subtotal * 0.05 : 0;
 }
diff --git a/src/billing/invoice.test.ts b/src/billing/invoice.test.ts
index 11aa22b..33cc44d 100644
--- a/src/billing/invoice.test.ts
+++ b/src/billing/invoice.test.ts
@@ -1,6 +1,10 @@
 import { buildInvoice } from "./invoice";
 
 test("builds totals", () => {
-  expect(buildInvoice([{ amount: 10 }], 1).total).toBe(10);
+  const invoice = buildInvoice([{ amount: 10 }], 1);
+  expect(invoice.total).toBe(10);
+  expect(invoice.discount).toBe(0);
 });
`;

const longBody = `## What this changes

Retries failed webhook deliveries with **exponential backoff** and jitter. See [the runbook](https://example.com/runbook) and \`deliverWebhook\`.

<script>alert("mock")</script>
<!-- hidden comment -->

## Rollout

1. Deploy the worker.
2. Enable \`WEBHOOK_RETRY\` per tenant.

| Attempt | Delay | Jitter | Max retries | Backoff cap | Owner |
| --- | --- | --- | --- | --- | --- |
| 1 | 1s | 0-500ms | 5 | 60s | billing |
| 2 | 4s | 0-2s | 5 | 60s | billing |
| 3 | 16s | 0-8s | 5 | 60s | platform |

\`\`\`ts
const delay = base * 2 ** attempt + Math.random() * jitter;
\`\`\`

![retry graph](https://example.com/retry.png)

> [!NOTE]
> Deliveries older than a day are dropped.
`;

const HEAD = "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d";

const blocker = (
  kind: MergeBlocker["kind"],
  summary: string,
  over: Partial<MergeBlocker> = {},
): MergeBlocker => ({
  kind,
  summary,
  detail: null,
  url: "https://github.com/acme/rocket/pull/482",
  required: true,
  ...over,
});

export const readiness = (
  state: MergeReadiness["state"],
  blockers: MergeBlocker[] = [],
  over: Partial<MergeReadiness> = {},
): MergeReadiness => ({
  headSha: HEAD,
  checkedAt: t(3),
  state,
  mergeStateStatus: {
    ready: "CLEAN",
    unstable: "UNSTABLE",
    blocked: "BLOCKED",
    queued: "CLEAN",
    unknown: "UNKNOWN",
  }[state],
  blockers,
  checksTruncated: false,
  error: null,
  lastKnown: null,
  ...over,
});

const basePr = (
  over: Partial<PullRequest> & Pick<PullRequest, "id" | "number" | "title" | "status">,
): PullRequest => ({
  automation: inheritAutomation,
  effectiveAutomation: effectiveAutomation(settings.automation, inheritAutomation),
  repository: "acme/rocket",
  url: `https://github.com/acme/rocket/pull/${over.number}`,
  body: "",
  author: "mira",
  authorAvatarUrl: null,
  headSha: HEAD,
  baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
  headRef: "feature/branch",
  baseRef: "main",
  state: "OPEN",
  requested: true,
  requestedAt: t(60),
  requestSource: "direct",
  imported: false,
  createdAt: t(3000),
  updatedAt: t(30),
  blockingCount: 0,
  nonBlockingCount: 0,
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  lastReviewedAt: null,
  hasReviewedHead: false,
  hasReviewHistory: false,
  mergeReadiness: null,
  ...over,
});

export const prs: PullRequest[] = [
  basePr({
    id: "pr-482",
    number: 482,
    title: "Apply volume discounts on invoices",
    status: "ready",
    body: "Adds a 5% discount above 1000 and records it on the invoice.\n\nFixes #470.",
    headRef: "mira/volume-discount",
    blockingCount: 1,
    nonBlockingCount: 2,
    lastReviewedAt: t(25),
    hasReviewedHead: true,
    hasReviewHistory: true,
    updatedAt: t(25),
    mergeReadiness: readiness("ready"),
  }),
  basePr({
    id: "pr-479",
    number: 479,
    title: "Retry webhook deliveries with jitter",
    status: "reviewing",
    body: longBody,
    author: "devon",
    headRef: "devon/webhook-retry",
    additions: 88,
    deletions: 14,
    changedFiles: 4,
    requestedAt: t(300),
    requestSource: "team",
    createdAt: t(2000),
    updatedAt: t(5),
    mergeReadiness: readiness("blocked", [
      blocker("review_required", "review required", {
        url: "https://github.com/acme/rocket/pull/479",
      }),
      blocker("checks_pending", "2 required checks pending", {
        detail: "unit, e2e",
        url: "https://github.com/acme/rocket/pull/479/checks",
      }),
    ]),
  }),
  basePr({
    id: "pr-475",
    number: 475,
    title: "Migrate sessions table to UUID keys",
    status: "outdated",
    author: "kai",
    headRef: "kai/session-uuid",
    headSha: "c0ffee1234567890abcdef1234567890abcdef12",
    additions: 240,
    deletions: 190,
    changedFiles: 9,
    blockingCount: 0,
    nonBlockingCount: 1,
    lastReviewedAt: t(600),
    requestedAt: t(900),
    requestSource: "both",
    createdAt: t(4000),
    updatedAt: t(40),
    automation: { ...inheritAutomation, reviewRequests: "off" },
    effectiveAutomation: effectiveAutomation(settings.automation, {
      ...inheritAutomation,
      reviewRequests: "off",
    }),
    mergeReadiness: readiness(
      "blocked",
      [
        blocker("changes_requested", "changes requested", {
          url: "https://github.com/acme/rocket/pull/475",
        }),
      ],
      { headSha: "deadbeef34567890abcdef1234567890abcdef12", checkedAt: t(600) },
    ),
  }),
  basePr({
    id: "pr-471",
    number: 471,
    title: "Fix flaky clock test on CI",
    status: "submitted",
    author: "devon",
    headRef: "devon/clock-test",
    additions: 6,
    deletions: 2,
    changedFiles: 1,
    lastReviewedAt: t(1500),
    hasReviewedHead: true,
    hasReviewHistory: true,
    updatedAt: t(1400),
    requested: false,
    requestedAt: null,
    requestSource: null,
    imported: true,
    mergeReadiness: readiness("unstable", [
      blocker("checks_failed", "1 check failed", {
        detail: "coverage",
        url: "https://github.com/acme/rocket/actions/runs/1/job/coverage",
        required: false,
      }),
    ]),
  }),
  basePr({
    id: "pr-455",
    number: 455,
    title: "Demo: submitted review with nothing newer to act on",
    status: "submitted",
    author: "mira",
    headRef: "mira/settled-submission",
    additions: 9,
    deletions: 4,
    changedFiles: 2,
    lastReviewedAt: t(1100),
    requestedAt: t(1200),
    createdAt: t(2600),
    updatedAt: t(1100),
    mergeReadiness: readiness("ready"),
  }),
  basePr({
    id: "pr-468",
    number: 468,
    title: "Upgrade OpenAPI generator to 7.x",
    status: "failed",
    author: "sam",
    headRef: "sam/openapi-7",
    additions: 1200,
    deletions: 1100,
    changedFiles: 42,
    requestedAt: t(2000),
    createdAt: t(5000),
    updatedAt: t(200),
    mergeReadiness: readiness(
      "blocked",
      [
        blocker("conflicts", "merge conflicts with the base branch", {
          url: "https://github.com/acme/rocket/pull/468",
        }),
        blocker("checks_failed", "3 required checks failed", {
          detail: "build, lint, typecheck",
          url: "https://github.com/acme/rocket/pull/468/checks",
        }),
        blocker("checks_failed", "1 check failed", {
          detail: "coverage",
          url: "https://github.com/acme/rocket/pull/468/checks",
          required: false,
        }),
        blocker("checks_pending", "1 check pending", {
          detail: "preview",
          url: "https://github.com/acme/rocket/pull/468/checks",
          required: false,
        }),
      ],
      { mergeStateStatus: "DIRTY" },
    ),
  }),
  basePr({
    id: "pr-490",
    number: 490,
    title: "Add rate limit headers to public API",
    status: "unreviewed",
    author: "kai",
    headRef: "kai/rate-limit-headers",
    additions: 30,
    deletions: 4,
    changedFiles: 3,
    requestedAt: t(2),
    requestSource: "team",
    createdAt: t(50),
    updatedAt: t(2),
    mergeReadiness: readiness("unknown", [], {
      error: "GitHub is still computing mergeability",
    }),
  }),
  basePr({
    id: "pr-460",
    number: 460,
    title: "Legacy row: requested before request types were recorded",
    status: "unreviewed",
    author: "sam",
    headRef: "sam/legacy-row",
    additions: 3,
    deletions: 1,
    changedFiles: 1,
    requestedAt: null,
    requestSource: "unknown",
    createdAt: null,
    updatedAt: t(9000),
  }),
];

const phase = (
  id: RunPhase["id"],
  status: RunPhase["status"],
  startedMinutesAgo: number,
  finishedMinutesAgo: number | null,
  detail: string | null = null,
): RunPhase => ({
  id,
  status,
  startedAt: t(startedMinutesAgo),
  finishedAt: finishedMinutesAgo === null ? null : t(finishedMinutesAgo),
  detail,
});

const act = (
  minutesAgo: number,
  source: RunActivity["source"],
  kind: RunActivity["kind"],
  label: string,
): RunActivity => ({ at: t(minutesAgo), source, kind, label });

export const progress = (
  phases: RunPhase[],
  activity: RunActivity[],
  activityCount = activity.length,
): RunProgress => ({
  phases,
  activity,
  activityCount,
  lastActivityAt: activity.at(-1)?.at ?? null,
  updatedAt: activity.at(-1)?.at ?? phases.at(-1)?.startedAt ?? t(0),
});

const runningProgress = progress(
  [
    phase("checkout", "completed", 5, 4.8, "3f1c2a1..9b8d7e2"),
    phase("codex", "completed", 4.8, 3.2),
    phase("claude", "running", 3.2, null),
  ],
  [
    act(3.2, "app", "phase", "Claude review started"),
    act(3.1, "claude", "message", "Claude session started with claude-opus-5"),
    act(2.5, "claude", "read", "Reading src/webhooks/deliver.ts"),
    act(1.8, "claude", "search", "Searching code in src/webhooks"),
    act(1.2, "claude", "read", "Reading src/webhooks/retry.ts"),
    act(0.3, "claude", "list", "Listing files in src/webhooks"),
  ],
  14,
);

const failedProgress = progress(
  [
    phase("checkout", "completed", 209, 208.5, "3f1c2a1..9b8d7e2"),
    phase("codex", "failed", 208.5, 208, "codex exec exited with code 1: not logged in"),
    phase(
      "claude",
      "failed",
      208,
      200,
      "Claude returned malformed structured output: expected findings array",
    ),
  ],
  [
    act(208.5, "app", "phase", "Codex cross-check started"),
    act(208, "app", "phase", "Codex cross-check failed"),
    act(208, "app", "phase", "Claude review started"),
    act(207.5, "claude", "read", "Reading openapi/generator.config.yaml"),
    act(200, "app", "phase", "Claude review failed"),
  ],
);

const interruptedProgress = progress(
  [
    phase("checkout", "completed", 1450, 1449.5),
    phase("codex", "completed", 1449.5, 1448),
    phase("claude", "interrupted", 1448, 1440),
  ],
  [
    act(1448, "app", "phase", "Claude review started"),
    act(1447, "claude", "read", "Reading src/api/rateLimit.ts"),
  ],
);

const overview482 = [
  "## Ticket intent",
  "- Fixes #470: invoices above 1000 should get a 5% volume discount recorded on the invoice.",
  "- Acceptance criteria: the discount appears on the invoice total and on each line item.",
  "",
  "## What the PR does",
  "- `buildInvoice` now computes `discountFor(subtotal)` and subtracts it before rounding, so `total` changes for any subtotal above 1000.",
  "- `applyDiscount` mutates the caller's `lineItems` in place; every later reader of those items sees reduced amounts.",
  "- The updated test only covers a zero-discount invoice, so the discounted path is unverified.",
  "",
  "## Ticket coverage",
  "- Fulfilled: the total is discounted above 1000.",
  "- Partial or missing: the discount is applied to line items by mutation but never recorded as its own invoice field.",
  "- Unverified: whether 5% matches the ticket, because the ticket body could not be read.",
].join("\n");

export const capturedSkillReviewer: ReviewerSettings = {
  ...reviewer,
  skillPath: CUSTOM_SKILL_PATH,
  model: "fixture-main",
  skillExecution: {
    version: 3,
    mode: "separated",
    harness: "claude",
    skill: skillSnapshot(CUSTOM_SKILL_PATH),
    policy: policyFixture("claude"),
    roles: {
      main: {
        id: "main",
        role: "main",
        harness: "claude",
        model: "fixture-main",
        additionalInstructions: "",
        policy: policyFixture("claude"),
      },
      additional: [
        {
          id: "reviewer-1",
          role: "additional",
          harness: "codex",
          model: "model-one",
          additionalInstructions: "",
          policy: policyFixture("codex"),
        },
        {
          id: "reviewer-2",
          role: "additional",
          harness: "codex",
          model: "model-two",
          additionalInstructions: "",
          policy: policyFixture("codex"),
        },
      ],
    },
  },
};

export const archivedIsolatedReviewer: ReviewerSettings = {
  ...reviewer,
  skillPath: CUSTOM_SKILL_PATH,
  model: "fixture-primary",
  skillExecution: {
    version: 2,
    mode: "separated",
    harness: "codex",
    skill: skillSnapshot(CUSTOM_SKILL_PATH),
  },
};

export const capturedHostReviewer: ReviewerSettings = {
  ...reviewer,
  model: "gpt-6-astra",
  hostExecution: { version: 1, harness: "pi", confirmedAt: t(200) },
};

export const capturedDangerousReviewer: ReviewerSettings = {
  ...capturedHostReviewer,
  skillExecution: {
    version: 2,
    mode: "dangerous",
    harness: "pi",
    skill: skillSnapshot(SKILL_PATH),
  },
};

const withoutPolicy = ({ policy: _policy, ...entry }: CapturedHarnessEntry) => entry;

const capturedRoles = capturedSkillReviewer.skillExecution!.roles!;

export const policylessSkillReviewer: ReviewerSettings = {
  ...capturedSkillReviewer,
  skillExecution: {
    version: 3,
    mode: "separated",
    harness: "claude",
    skill: skillSnapshot(CUSTOM_SKILL_PATH),
    roles: {
      main: withoutPolicy(capturedRoles.main),
      additional: capturedRoles.additional.map(withoutPolicy),
    },
  },
};

export const managedSourceId = (harness: HarnessId) =>
  [...harness]
    .map((char) => char.charCodeAt(0).toString(16))
    .join("")
    .padEnd(32, "0");

export const unpairedDockerReviewer: ReviewerSettings = {
  ...reviewer,
  model: "gpt-6-astra",
  skillExecution: {
    version: 2,
    mode: "docker",
    harness: "codex",
    skill: skillSnapshot(SKILL_PATH),
  },
};

export const markerlessDockerReviewer: ReviewerSettings = {
  ...unpairedDockerReviewer,
  execution: {
    version: 2,
    digest: "managed-codex-digest",
    image: "sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
    policy: "policy-mock-digest",
    broker: "broker-mock-digest",
    models: { claude: "claude-fable-5", codex: "gpt-6-astra" },
    harness: "codex",
    sourceId: managedSourceId("codex"),
    skillDigest: skillSnapshot(SKILL_PATH).digest,
    fixture: true,
  },
};

export const dockerStdioEntries: Record<string, string | null> = {
  "native:claude-local-tools-mock-identity": "/Users/demo/local-tools/server.mjs",
  "native:codex-local-tools-mock-identity": null,
};

const containerCapabilities = [
  "arbitrary code inside the container",
  "read/write disposable workcopy and scratch",
  "read all temporarily exposed model access credentials",
  "use captured model/read brokers, never additional mounts or external network",
];

const customization = (
  harness: HarnessId,
  kind: DockerCapabilityDisclosure["customizations"][number]["kind"],
  source: string,
  bytes: string,
): DockerCapabilityDisclosure["customizations"][number] => {
  const digest = mockDigest(`${kind}-${harness}`, bytes);
  return {
    id: mockDigest(`id-${kind}-${harness}`, `${harness}:${kind}:${source}:${digest}`),
    harness,
    kind,
    source,
    digest,
    capabilities: containerCapabilities,
  };
};

const authenticationSource: Record<HarnessId, [string, "present" | "missing" | "not_checked"]> = {
  claude: ["Claude Code-credentials (default macOS keychain)", "not_checked"],
  codex: [`${HOME}/.codex/auth.json`, "present"],
  pi: [`${HOME}/.pi/agent/auth.json`, "present"],
};

export const CLAUDE_SETTINGS_PATH = `${HOME}/.claude/settings.json`;
export const DOCKER_EXCLUSION_STALE_MESSAGE =
  "Docker exclusion changed or is unsupported. Discover the current exact source items and select again; Slack is not implicitly excluded.";
export const DOCKER_LEAF_UNSUPPORTED_MESSAGE =
  "Choose one declared installed skill leaf for the saved Docker harnesses, not an arbitrary source or parent directory";
export const DOCKER_LEAF_STALE_MESSAGE =
  "Discover the exact installed leaf again; saved settings, GET and restart grant no source reads";
export const DOCKER_LEAF_EFFECT =
  "Read and freeze only this installed skill leaf and contained UTF-8 companions. No parent/sibling/external descendant reads, credential stores, host execution or native changes. Executable resources and Docker setup still require separate exact approval.";

export const SYNCED_MANIFEST_PATH = `${HOME}/.claude/skills/synced/mock-library/manifest.json`;

const exclusion = (
  kind: DockerExclusion["kind"],
  pointer: string,
  item: unknown,
  rationale: string,
  effect: string,
  source = CLAUDE_SETTINGS_PATH,
): DockerExclusion => {
  const definition = JSON.stringify(item);
  const sourceDigest = mockDigest("settings", `mock-source-bytes:${source}`);
  const itemDigest = mockDigest("item", definition);
  return {
    id: mockDigest("exclusion", `${kind}:${pointer}:${itemDigest}`),
    source,
    sourceDigest,
    itemDigest,
    kind,
    pointer,
    definition,
    rationale,
    effect,
    nativeSettingsUnchanged: true,
  };
};

export const dockerExclusionCandidates: DockerExclusion[] = [
  exclusion(
    "status-line",
    "/statusLine",
    { type: "command", command: "echo mock-status-line" },
    "Headless Docker has no interactive host status line.",
    "This exact status-line command is not materialized or executed in Docker. Native status-line configuration remains unchanged.",
  ),
  exclusion(
    "herdr-session-start",
    "/hooks/SessionStart/0/hooks/0",
    { type: "command", command: `bash '${HOME}/herdr-agent-state.sh' session`, timeout: 10 },
    "Host Herdr pane/session reporting has no supported container transport.",
    "Only this exact SessionStart handler is omitted from Docker. No host socket, executable bridge or native configuration change is introduced.",
  ),
  exclusion(
    "slack-plugin",
    "/enabledPlugins/mock-slack@mock-official-plugins",
    true,
    "Use the separately authenticated, explicitly granted read-only Slack broker rather than native plugin activation in Docker.",
    "Docker omits this exact official Slack activation flag, its native MCP connection, six plugin skills and five commands. Native plugin/settings/auth and separately captured slack-axi instruction skills remain unchanged. No CLI or whole-plugin parity, new read grant, executable approval or credential exposure is implied.",
  ),
  exclusion(
    "google-workspace-skill",
    "/skills/3",
    {
      skill: {
        item: {
          skillId: "google-workspace",
          name: "google-workspace",
          description: "Synthetic mock synced skill fixture, not an installed skill",
          source: "mock-library",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        index: 3,
      },
      pendingClaims: ["mock-library/google-workspace"],
      files: [
        "SKILL.md",
        "references/charts.md",
        "references/docs.md",
        "references/sheets.md",
        "references/slides.md",
        "scripts/docs_index.py",
        "scripts/render_export.py",
        "scripts/sheets_helper.py",
        "scripts/slides_helper.py",
      ],
    },
    "Google Workspace is not needed for this Docker PR-review capture.",
    "Omit only this source-bound Google Workspace skill, its four scripts, five Markdown resources and exact skill/pending-claim manifest entries from Docker inputs and discovery. Other manifest content and skills remain. Native installation/settings/auth stay unchanged; no Google code execution, credential exposure or provider grant is approved.",
    SYNCED_MANIFEST_PATH,
  ),
];

export const libraryLeafTerminals: Record<string, string> = {
  [`${HOME}/.claude/skills/fixture-leaf`]: `${HOME}/.claude/skills/fixture-leaf`,
  [`${HOME}/.agents/skills/fixture-leaf`]: `${HOME}/.claude/skills/fixture-leaf`,
  [`${HOME}/.codex/skills/fixture-leaf`]: `${HOME}/.claude/skills/fixture-leaf`,
  [`${HOME}/.codex/skills/helper`]: `${HOME}/.nix-profile/share/skills/helper`,
};

export const dockerLibraryLeaf = (source: string): DockerLibraryLeaf => {
  const resolvedSourcePath = libraryLeafTerminals[source]!;
  const value = {
    source,
    resolvedSourcePath,
    sourceDigest: mockDigest("leaf-identity", resolvedSourcePath),
    limits: { entries: 2000, decodedBytes: 2_000_000, encoding: "utf8" as const },
    effect: DOCKER_LEAF_EFFECT,
    nativeSettingsUnchanged: true as const,
  };
  return { id: mockDigest("leaf", JSON.stringify(value)), ...value };
};

export const dockerSourceHandling: DockerSourceHandling[] = [
  {
    source: `${HOME}/.claude/skills/.DS_Store`,
    digest: mockDigest("finder", ".DS_Store"),
    kind: "finder-metadata",
    effect:
      "Finder metadata is disclosed as a non-runtime input and never materialized in the container.",
    nativeSettingsUnchanged: true,
  },
  {
    source: CLAUDE_SETTINGS_PATH,
    digest: mockDigest("presentation", "theme"),
    kind: "presentation",
    effect:
      "Inert theme fields are projected without runtime effect; native settings are unchanged.",
    nativeSettingsUnchanged: true,
  },
];

export const dockerDisclosure = (
  harness: HarnessId,
  skill: SkillSnapshot,
  model: string,
  localConnections: DockerLocalMcpRequest[] = [],
  sources: { exclusions?: DockerExclusion[]; libraryLeaves?: DockerLibraryLeaf[] } = {},
): DockerCapabilityDisclosure => {
  const resources: DockerCapabilityDisclosure["resources"] = skill.files.map((file) => ({
    source: file.sourcePath,
    target: file.target,
    digest: mockDigest("resource", file.content),
    executable: file.executable,
  }));
  for (const leaf of sources.libraryLeaves ?? []) {
    const name = leaf.source.split("/").at(-1)!;
    resources.push(
      {
        source: `${leaf.source}/SKILL.md`,
        target: `.claude/skills/${name}/SKILL.md`,
        digest: mockDigest("resource", `${name} skill`),
        executable: false,
        resolvedSourcePath: `${leaf.resolvedSourcePath}/SKILL.md`,
        sourceDigest: leaf.sourceDigest,
      },
      {
        encoding: "base64",
        mediaType: "image/png",
        bytes: 1836,
        inputDigest: mockDigest("png-input", name),
        source: `${leaf.source}/assets/icon.png`,
        target: `.claude/skills/${name}/assets/icon.png`,
        digest: mockDigest("png-bytes", name),
        executable: false,
      },
    );
  }
  if (harness !== "claude")
    resources.push({
      source: `${HOME}/.agents/skills/helper/SKILL.md`,
      target: ".agents/skills/helper/SKILL.md",
      digest: mockDigest("resource", "frozen native library"),
      executable: false,
    });
  const customizations = [
    ...(harness === "claude"
      ? [customization("claude", "hooks", `${HOME}/.claude/settings.json`, "PreToolUse echo")]
      : []),
    ...(harness === "codex"
      ? [customization("codex", "hooks", `${HOME}/.codex/config.toml`, "[hooks] notify")]
      : []),
    ...(harness === "pi"
      ? [
          customization(
            "pi",
            "extensions",
            `${HOME}/.pi/agent/extensions/approved.mjs`,
            "export default",
          ),
          customization("pi", "shell-prefix", `${HOME}/.pi/agent/settings.json`, "nice -n 5"),
        ]
      : []),
    ...(skill.path === SCRIPTED_SKILL_PATH
      ? [
          customization(
            harness,
            "skill-code",
            `${HOME}/review-skills/scripted/scripts/check.sh`,
            "#!/bin/sh",
          ),
        ]
      : []),
  ];
  const [source, presence] = authenticationSource[harness];
  const value: DockerCapabilityDisclosure = {
    version: 1,
    profile: "container-native-1",
    digest: "",
    harness,
    model,
    skillPath: skill.path,
    skillDigest: skill.digest,
    resources,
    sourceHandling: structuredClone(dockerSourceHandling),
    ...(sources.exclusions?.length ? { exclusions: structuredClone(sources.exclusions) } : {}),
    ...(sources.libraryLeaves?.length
      ? { libraryLeaves: structuredClone(sources.libraryLeaves) }
      : {}),
    customizations,
    authentication: [
      {
        harness,
        source,
        presence,
        compatibility: "supported_reference",
        tested: false,
        exposure: "temporary-container-access-token",
        readers: "all-container-code",
        refresh: false,
      },
    ],
    localConnections: localConnections.map((request) => {
      const native = [...nativeDiscoveries.claude, ...nativeDiscoveries.codex].find(
        (config) => config.id === request.id,
      )!.native!;
      const entry = dockerStdioEntries[request.id]!;
      return {
        request,
        native,
        profile: knownProfile,
        profileDigest: mockDigest("profile", JSON.stringify(knownProfile)),
        sourceDigest: mockDigest("local-source", entry),
        target: `resources/.local-mcp/${mockDigest("local", request.id).slice(0, 16)}/server.mjs`,
        transport: "container-stdio",
        inventory: "not_tested",
        connected: false,
      };
    }),
    boundary: {
      source: "immutable-input-disposable-workcopy",
      network: "none-with-captured-brokers",
      sourceWriteback: false,
      hostExecution: false,
    },
    requirements: [
      "Native MCP configuration is not inherited. Remote tools require separately captured connection grants; local tools require the exact choices below.",
      "Only prepared pinned runtime dependencies are available. No marketplace, package reconciliation, PR setup scripts or review-time downloads.",
      "All approved executable code can read temporary model credentials. No refresh material or business credentials are exposed. Authentication compatibility and expiry are checked only at execution, never by this inspection.",
    ],
    evidence: "local_configuration",
  };
  value.digest = mockDigest("docker-disclosure", JSON.stringify(value));
  return value;
};

export const approveDisclosure = (
  disclosure: DockerCapabilityDisclosure,
): DockerCapabilityApproval => ({
  digest: disclosure.digest,
  ...(disclosure.exclusions?.length
    ? { exclusions: disclosure.exclusions.map((item) => item.id) }
    : {}),
  ...(disclosure.libraryLeaves?.length
    ? { libraryLeaves: disclosure.libraryLeaves.map((item) => item.id) }
    : {}),
  customizations: disclosure.customizations.map((item) => item.id),
  credentialExposures: disclosure.authentication.map((item) => item.harness),
  confirmation: dockerApprovalConfirmation,
});

export const dockerBoundary = (
  harness: HarnessId,
  skill: SkillSnapshot,
  model: string,
): DockerBoundarySnapshot => {
  const disclosure = dockerDisclosure(harness, skill, model);
  return { profile: "container-native-1", disclosure, approval: approveDisclosure(disclosure) };
};

export const capturedDockerReviewer: ReviewerSettings = {
  ...markerlessDockerReviewer,
  execution: {
    ...markerlessDockerReviewer.execution!,
    docker: dockerBoundary("codex", skillSnapshot(SKILL_PATH), "gpt-6-astra"),
  },
};

const entryResult = (model: string, count: number): ReviewResult => ({
  overview: `# Synthetic fixture ${model}`,
  body: `Review ${model}`,
  findings: findings.slice(0, count).map((f) => ({ ...f, id: `${f.id}-${model}` })),
  verdict: "COMMENT",
  rationale: `Private ${model}`,
});

export const entryEvidence: HarnessEntryEvidence[] = [
  {
    id: "reviewer-1",
    role: "additional",
    harness: "codex",
    model: "model-one",
    status: "completed",
    startedAt: t(28.8),
    finishedAt: t(28.2),
    result: entryResult("model-one", 1),
    error: null,
  },
  {
    id: "reviewer-2",
    role: "additional",
    harness: "codex",
    model: "model-two",
    status: "failed",
    startedAt: t(28.2),
    finishedAt: t(27.6),
    result: null,
    error: "codex exited with code 1 (mock fixture): no successful result for this entry",
  },
  {
    id: "main",
    role: "main",
    harness: "claude",
    model: "fixture-main",
    status: "completed",
    startedAt: t(27.5),
    finishedAt: t(25.1),
    result: entryResult("fixture-main", 3),
    error: null,
  },
];

const completedProgress: RunProgress = {
  ...progress(
    [
      phase("sync", "completed", 30.2, 30.1, "head 9b8d7e2"),
      phase("checkout", "completed", 29, 28.8, "3f1c2a1..9b8d7e2"),
      phase("workflow", "completed", 28.8, 25.1, "3 entries"),
      phase("finalize", "completed", 25.1, 25, "draft created"),
    ],
    [
      act(30.1, "app", "phase", "Syncing latest PR completed"),
      act(29, "app", "phase", "Preparing pinned checkout started"),
      act(28.8, "app", "phase", "Preparing pinned checkout completed"),
      act(28.8, "app", "phase", "Selected execution started"),
      act(28.7, "codex", "message", "Codex session started"),
      act(28.6, "codex", "tool", "Codex called a tool"),
      act(27.6, "codex", "message", "Codex wrote a message"),
      act(27.5, "app", "phase", "Additional reviewers finished"),
      act(27.4, "claude", "message", "Claude session started with fixture-main"),
      act(27.2, "claude", "read", "Reading src/billing/invoice.ts"),
      act(27, "claude", "search", "Searching code in src/billing"),
      act(26.5, "claude", "read", "Reading src/billing/invoice.test.ts"),
      act(25.3, "claude", "message", "Claude is writing"),
      act(25.2, "claude", "message", "Writing the structured result"),
      act(25.1, "app", "phase", "Selected execution completed"),
      act(25.1, "app", "phase", "Validating and saving result started"),
      act(25, "app", "phase", "Validating and saving result completed"),
    ],
    57,
  ),
  entries: entryEvidence,
};

export const runs: Record<string, ReviewRun[]> = {
  "pr-482": [
    {
      id: "run-1",
      prId: "pr-482",
      kind: "review",
      trigger: "request",
      requestEventId: "evt-1",
      status: "completed",
      headSha: "1111111c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
      createdAt: t(120),
      startedAt: t(119),
      finishedAt: t(110),
      error: null,
      log: "claude: loading skill pr-review\ncodex: unavailable, skipped\nclaude: 2 findings",
      reviewer,
      progress: null,
      result: {
        overview: "",
        body: "Discount logic looks right but the mutation of line items is risky.",
        findings: findings.slice(0, 2).map((f) => ({ ...f, id: `${f.id}-old` })),
        verdict: "REQUEST_CHANGES",
        rationale: "One blocking finding.",
      },
    },
    {
      id: "run-2",
      prId: "pr-482",
      kind: "review",
      trigger: "manual",
      requestEventId: null,
      status: "completed",
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
      createdAt: t(30),
      startedAt: t(29),
      finishedAt: t(25),
      error: null,
      log: "codex: loading skill security-audit\ncodex: 3 findings\nverifier: confirmed 2 of 3",
      reviewer: capturedSkillReviewer,
      progress: completedProgress,
      result: {
        overview: overview482,
        body: "The discount feature works for the happy path, but `applyDiscount` mutates caller-owned line items and the rounding order can drift totals.",
        findings,
        verdict: "REQUEST_CHANGES",
        rationale: "One confirmed blocking finding on shared state mutation.",
      },
    },
  ],
  "pr-479": [
    {
      id: "run-3",
      prId: "pr-479",
      kind: "review",
      trigger: "request",
      requestEventId: "evt-3",
      status: "running",
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
      createdAt: t(6),
      startedAt: t(5),
      finishedAt: null,
      error: null,
      log: "claude: loading skill pr-review\nclaude: reading diff (4 files)",
      reviewer,
      progress: runningProgress,
      result: null,
    },
  ],
  "pr-475": [
    {
      id: "run-4",
      prId: "pr-475",
      kind: "review",
      trigger: "request",
      requestEventId: "evt-4",
      status: "completed",
      headSha: "deadbeef34567890abcdef1234567890abcdef12",
      baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
      createdAt: t(610),
      startedAt: t(609),
      finishedAt: t(600),
      error: null,
      log: "claude: 1 finding",
      reviewer,
      progress: null,
      result: {
        overview:
          "- `sessions.id` becomes a UUID; `SessionStore.find` now looks rows up by the new key.\n- Not covered: rows written by the old migration path.",
        body: "Migration is sound; one suggestion on index naming.",
        findings: [{ ...findings[2]!, id: "f-9", included: true }],
        verdict: "APPROVE",
        rationale: "No blocking findings.",
      },
    },
  ],
  "pr-471": [
    {
      id: "run-5",
      prId: "pr-471",
      kind: "review",
      trigger: "request",
      requestEventId: "evt-5",
      status: "completed",
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
      createdAt: t(1510),
      startedAt: t(1509),
      finishedAt: t(1500),
      error: null,
      log: "claude: 0 findings",
      reviewer,
      progress: null,
      result: {
        overview:
          "- Replaces the wall clock in `clockTest` with a fixed instant so CI stops flaking.",
        body: "Test fix is correct.",
        findings: [],
        verdict: "APPROVE",
        rationale: "Trivial.",
      },
    },
  ],
  "pr-468": [
    {
      id: "run-6",
      prId: "pr-468",
      kind: "review",
      trigger: "request",
      requestEventId: "evt-6",
      status: "failed",
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
      createdAt: t(210),
      startedAt: t(209),
      finishedAt: t(200),
      error: "Claude returned malformed structured output: expected findings array",
      log: "claude: loading skill pr-review\nclaude: diff exceeds 40k lines, sampling\nparse error at offset 1182",
      reviewer,
      progress: failedProgress,
      result: null,
    },
  ],
  "pr-490": [
    {
      id: "run-7",
      prId: "pr-490",
      kind: "review",
      trigger: "request",
      requestEventId: "evt-7",
      status: "interrupted",
      headSha: HEAD,
      baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
      createdAt: t(1451),
      startedAt: t(1450),
      finishedAt: t(1440),
      error: "Backend stopped while review was running",
      log: "Backend stopped while review was running",
      reviewer,
      progress: interruptedProgress,
      result: null,
    },
  ],
};

export const drafts: Record<string, ReviewDraft[]> = {
  "pr-482": [
    {
      id: "draft-482",
      runId: "run-2",
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      version: 3,
      overview: overview482,
      body: runs["pr-482"]![1]!.result!.body,
      findings,
      verdict: "REQUEST_CHANGES",
      createdAt: t(25),
      updatedAt: t(20),
    },
    {
      id: "draft-482-old",
      runId: "run-1",
      headSha: "1111111c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      version: 2,
      overview: "",
      body: "Older hand-edited body from the first review.",
      findings: runs["pr-482"]![0]!.result!.findings,
      verdict: "REQUEST_CHANGES",
      createdAt: t(110),
      updatedAt: t(100),
    },
  ],
  "pr-475": [
    {
      id: "draft-475",
      runId: "run-4",
      headSha: "deadbeef34567890abcdef1234567890abcdef12",
      version: 1,
      overview: runs["pr-475"]![0]!.result!.overview,
      body: "Migration is sound; one suggestion on index naming.",
      findings: [{ ...findings[2]!, id: "f-9", included: true }],
      verdict: "APPROVE",
      createdAt: t(600),
      updatedAt: t(600),
    },
  ],
  "pr-471": [
    {
      id: "draft-471",
      runId: "run-5",
      headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
      version: 1,
      overview: runs["pr-471"]![0]!.result!.overview,
      body: "Test fix is correct.",
      findings: [],
      verdict: "APPROVE",
      createdAt: t(1500),
      updatedAt: t(1500),
    },
  ],
};

export const submissions: Record<string, Submission[]> = {
  "pr-471": [
    {
      id: "sub-1",
      previewId: "prev-1",
      status: "submitted",
      payload: {
        event: "APPROVE",
        body: "Test fix is correct.",
        commit_id: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
        comments: [],
      },
      githubReviewId: "2211334455",
      url: "https://github.com/acme/rocket/pull/471#pullrequestreview-2211334455",
      error: null,
      createdAt: t(1400),
    },
  ],
};

export const newCommits: CommitSummary[] = [
  {
    sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    message: "Backfill session ids in batches\n\nAvoids locking the table for the full migration.",
    author: "kai",
    committedAt: t(45),
    url: "https://github.com/acme/rocket/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  },
  {
    sha: "c0ffee1234567890abcdef1234567890abcdef12",
    message: "Rename index to sessions_uuid_idx",
    author: "kai",
    committedAt: t(40),
    url: "https://github.com/acme/rocket/commit/c0ffee1234567890abcdef1234567890abcdef12",
  },
];

const historyRun = (
  id: string,
  minutesAgo: number,
  reviewer: ReviewerSettings,
  status: ReviewRun["status"],
  extra: Partial<ReviewRun> = {},
): ReviewRun => ({
  id,
  prId: "pr-482",
  kind: "review",
  trigger: "manual",
  requestEventId: null,
  status,
  headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
  baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
  createdAt: t(minutesAgo),
  startedAt: status === "queued" ? null : t(minutesAgo - 0.5),
  finishedAt: status === "queued" || status === "running" ? null : t(minutesAgo - 2),
  error: null,
  log: `history fixture ${id}`,
  reviewer,
  progress: null,
  result:
    status === "completed"
      ? { ...entryResult(reviewer.model ?? "native default", 1), rationale: "History fixture." }
      : null,
  ...extra,
});

const evidence = (
  entry: HarnessEntryEvidence,
  status: HarnessEntryEvidence["status"],
  error: string | null = null,
): HarnessEntryEvidence => ({
  ...entry,
  status,
  startedAt: status === "pending" || status === "skipped" ? null : entry.startedAt,
  finishedAt: status === "pending" || status === "skipped" || status === "running" ? null : t(40),
  result: status === "completed" ? (entry.result ?? entryResult(entry.model, 1)) : null,
  error,
});

export const historyRuns: ReviewRun[] = [
  historyRun("run-h-queued", 1, capturedSkillReviewer, "queued", {
    progress: { ...progress([], []), entries: entryEvidence.map((e) => evidence(e, "pending")) },
  }),
  historyRun("run-h-failed", 40, capturedSkillReviewer, "failed", {
    error: "Isolated harness execution failed; see entry evidence and run error (mock fixture)",
    progress: {
      ...progress([phase("workflow", "failed", 40.5, 40, "main skipped")], []),
      entries: [
        evidence(entryEvidence[0]!, "completed"),
        evidence(
          entryEvidence[1]!,
          "failed",
          "codex exited with code 1 (mock fixture): no successful result for this entry",
        ),
        evidence(entryEvidence[2]!, "skipped"),
      ],
    },
  }),
  historyRun("run-h-interrupted", 60, capturedSkillReviewer, "interrupted", {
    error: "Interrupted by restart (mock fixture)",
    progress: {
      ...progress([phase("workflow", "interrupted", 60.5, 60)], []),
      entries: [
        evidence(entryEvidence[0]!, "completed"),
        evidence(entryEvidence[1]!, "interrupted", "Interrupted by restart (mock fixture)"),
        evidence(entryEvidence[2]!, "skipped"),
      ],
    },
  }),
  historyRun("run-h-policyless", 300, policylessSkillReviewer, "completed", {
    progress: { ...progress([], []), entries: entryEvidence },
  }),
  historyRun("run-h-host-only", 400, capturedHostReviewer, "completed"),
  historyRun("run-h-dangerous", 450, capturedDangerousReviewer, "completed"),
  historyRun("run-h-unpaired-docker", 500, unpairedDockerReviewer, "failed", {
    error: "Archived capture rejected before dispatch (mock fixture)",
  }),
  historyRun("run-h-docker-markerless", 550, markerlessDockerReviewer, "completed"),
  historyRun("run-h-docker", 600, capturedDockerReviewer, "completed"),
];

export const historyQuestion = (
  id: string,
  reviewerSnapshot: ReviewerSettings | undefined,
  status: Question["status"],
  minutesAgo: number,
): Question => ({
  id,
  prId: "pr-482",
  draftId: null,
  parentId: null,
  mode: "explain",
  status,
  baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
  headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
  selection: {
    path: "src/billing/invoice.ts",
    from: { side: "RIGHT", line: 42 },
    to: { side: "RIGHT", line: 42 },
    baseSha: "3f1c2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b",
    headSha: "9b8d7e2c4f1a0b3d5e6f7a8b9c0d1e2f3a4b5c6d",
    oldPath: null,
    snippet: "+  applyDiscount(lineItems, discount);",
    kinds: { add: true, del: false, ctx: false },
    spansHunks: false,
    anchors: { RIGHT: { startLine: 42, line: 42 } },
  },
  question: `History fixture ${id}`,
  answer:
    status === "completed"
      ? { kind: "answer", answer: `Recorded answer for ${id}`, followUps: [] }
      : null,
  error: status === "failed" ? `History fixture failure ${id}` : null,
  reviewerSnapshot,
  createdAt: t(minutesAgo),
  startedAt: t(minutesAgo),
  finishedAt: t(minutesAgo - 0.2),
});

export const historyQuestions: Question[] = [
  historyQuestion("q-h-current", capturedSkillReviewer, "completed", 5),
  historyQuestion("q-h-policyless", policylessSkillReviewer, "failed", 300),
  historyQuestion("q-h-host-only", capturedHostReviewer, "completed", 400),
  historyQuestion("q-h-dangerous", capturedDangerousReviewer, "failed", 450),
  historyQuestion("q-h-docker-markerless", markerlessDockerReviewer, "completed", 550),
  historyQuestion("q-h-docker", capturedDockerReviewer, "completed", 600),
];

export const fixturesForExecutionTests = {
  SKILL_PATH,
  CUSTOM_SKILL_PATH,
  MISSING_SKILL_PATH,
};

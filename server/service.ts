import {
  autoSubmissionConfirmation,
  cancelReviewConfirmation,
  type ReviewJobAction,
  type ReviewJob,
  autoSubmissionReenableConfirmation,
  normalizeAutoSubmissionAuthors,
  normalizeGithubUsername,
  type AutoSubmissionUpdate,
  type AutoSubmissionState,
  type AutoSubmissionReenable,
  type HumanReviewAcknowledgment,
  type AutomaticReviewProvenance,
  type DiscussionSnapshot,
  type DraftEditIntent,
  automationOff,
  inboxEligible,
  dangerousConfirmation,
  dockerSetupConfirmation,
  type HarnessId,
  type AppHealth,
  type AppSettings,
  type AppState,
  type AutomationOverrides,
  type AutomationPolicy,
  type DraftUpdate,
  type Finding,
  type Freshness,
  type IntegrationHealth,
  type ImportOperation,
  type SyncOperation,
  type MergeReadiness,
  type PullRequest,
  type PullRequestDetail,
  type Question,
  type QuestionRequest,
  type ReviewDraft,
  type ReviewPayload,
  type ReviewResult,
  type ReviewRun,
  type RevisionProposal,
  type RevisionRequest,
  type ReviewerSettings,
  type RunPhase,
  type IntegrationCatalog,
  type IntegrationConfig,
  type IntegrationSettings,
  type SettingsUpdate,
  type Submission,
  type SubmissionPreview,
} from "../shared/contracts.js";
import {
  DemoGithubAdapter,
  GithubAdapter,
  GithubCliAdapter,
  GithubRequestError,
  PollRequest,
  PollScope,
  RemotePullRequest,
  ReviewerAdapter,
  ReviewerInput,
} from "./adapters.js";
import { AppConfig } from "./config.js";
import {
  NativeHumanReviewClassifier,
  validateClassification,
  type HumanReviewClassifier,
} from "./human-review.js";
import {
  automaticallyReviewed,
  exactReview,
  sameReviewPayload,
  type ReviewInventory,
} from "./publication.js";
import { emptyCoverage, revision } from "./discussion.js";
import { bindHumanReviewRequest } from "./review-output.js";
import { ConfiguredWorkflows } from "./execution/workflows.js";
import { ReadProviders, importReadProviders } from "./read-providers.js";
import {
  discoverNativeMcp,
  NativeMcpDiscoveryError,
  nativeReference,
  validateOAuthSource,
  validateNativeOAuthSource,
} from "./native-mcp.js";
import { McpOAuth } from "./mcp-oauth.js";
import { dockerExclusions } from "./execution/docker-exclusions.js";
import { oauthMcpProfiles } from "./mcp-profiles.js";
import { discoverHarnessModels } from "./model-discovery.js";
import type {
  NativeMcpDiscoveryRequest,
  NativeMcpImportRequest,
} from "../shared/contracts.js";
import type { HarnessSelection, HarnessStatus } from "../shared/contracts.js";
import { workflowAdapters } from "./execution/adapters.js";
import {
  currentSelection,
  requireSupportedExecution,
  executionUpgradeAction,
} from "./execution/supported.js";
import type { ExecutionStatus } from "../shared/contracts.js";
import { AppDatabase, JobRow } from "./db.js";
import { RunProgressTracker, emptyProgress } from "./progress.js";
import { QuestionAdapter, QuestionInput, QuestionTurn } from "./questions.js";
import { validateResultFinding, validateReviewResult } from "./reviewer.js";
import {
  buildIntegrationCatalog,
  defaultIntegrationSettings,
  integrationSnapshot,
  normalizeIntegrationSettings,
} from "./integrations.js";
import {
  anchorsInline,
  diffAnchors,
  parseDiff,
  resolveSelection,
} from "../shared/diff.js";
import {
  clampText,
  id,
  now,
  parsePullRequestUrl,
  prId,
  terminateRunningCommands,
} from "./util.js";

export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const health = (
  status: IntegrationHealth["status"],
  message: string,
): IntegrationHealth => ({ status, message });
const emptyHealth = (): AppHealth => ({
  github: health("unknown", "Checking GitHub authentication"),
  githubUser: null,
  lastPollAt: null,
  pollError: null,
  demo: false,
});

function validateFinding(value: unknown, index: number): Finding {
  try {
    return validateResultFinding(value, `findings[${index}]`);
  } catch (error) {
    throw new ServiceError(
      400,
      "invalid_finding",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function counts(findings: Finding[]): {
  blocking: number;
  nonBlocking: number;
} {
  return {
    blocking: findings.filter(
      (finding) => finding.included && finding.severity === "blocking",
    ).length,
    nonBlocking: findings.filter(
      (finding) => finding.included && finding.severity === "non_blocking",
    ).length,
  };
}

const severityLabel = /^\*{0,2}(?:non-?)?blocking\*{0,2}[.:]\*{0,2}\s*/i;

export function findingText(finding: Finding, location = ""): string {
  const body = finding.body.trim().replace(severityLabel, "");
  const label = finding.severity === "blocking" ? "Blocking" : "Non-blocking";
  const preExisting =
    finding.origin === "pre_existing" && !/^pre-existing\b/i.test(body)
      ? "Pre-existing. "
      : "";
  return `**${label}.** ${location}${preExisting}${body}`;
}

export function findingLocation(finding: Finding): string {
  if (!finding.path) return "";
  const lines =
    finding.line === null
      ? ""
      : `:${finding.startLine === null ? "" : `${finding.startLine}-`}${finding.line}`;
  const side = finding.line !== null && finding.side === "LEFT" ? " (old)" : "";
  return `\`${finding.path}${lines}\`${side} `;
}

export function reviewBody(body: string, findings: Finding[]): string {
  return [
    body.trim(),
    ...findings.map((finding) =>
      findingText(finding, findingLocation(finding)),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const questionModes = new Set<Question["mode"]>([
  "explain",
  "investigate",
  "draft_comment",
]);
const maxQueuedQuestions = 5;

export type SyncMode = SyncOperation["mode"];

const draftDerivedStatuses = new Set<PullRequest["status"]>([
  "unreviewed",
  "ready",
  "outdated",
]);

interface ObserveOptions {
  preserveBaseline?: boolean;
  requestsKnown: boolean;
  automatic: boolean;
}

function failedFreshness(
  previous: Freshness | null,
  baseline: string | null,
  head: string,
  error: unknown,
): Freshness {
  const kept =
    previous && previous.baseline === baseline && previous.head === head
      ? previous
      : null;
  return {
    baseline: baseline ?? "",
    head,
    status: kept?.status ?? (head !== baseline ? "stale" : "unknown"),
    commits: kept?.commits ?? [],
    truncated: kept?.truncated ?? false,
    checkedAt: now(),
    error: error instanceof Error ? error.message : String(error),
  };
}

function lastKnownReadiness(
  previous: MergeReadiness | null,
  head: string,
): MergeReadiness["lastKnown"] {
  if (previous?.headSha !== head) return null;
  if (previous.state === "unknown") return previous.lastKnown;
  const { checkedAt, state, mergeStateStatus, blockers, checksTruncated } =
    previous;
  return { checkedAt, state, mergeStateStatus, blockers, checksTruncated };
}

function withLastKnown(
  next: MergeReadiness,
  previous: MergeReadiness | null,
): MergeReadiness {
  return {
    ...next,
    lastKnown:
      next.state === "unknown"
        ? lastKnownReadiness(previous, next.headSha)
        : null,
  };
}

function failedReadiness(head: string, error: unknown): MergeReadiness {
  return {
    headSha: head,
    checkedAt: now(),
    state: "unknown",
    mergeStateStatus: null,
    blockers: [],
    checksTruncated: false,
    error: error instanceof Error ? error.message : String(error),
    lastKnown: null,
  };
}

class ReviewQueue {
  private readonly running = new Map<string, string>();
  private scheduled = false;

  constructor(private readonly service: ReviewService) {}

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.running.size < this.service.maxConcurrentReviews()) {
      const job = this.service.nextQueuedJob(new Set(this.running.values()));
      if (!job) return;
      this.running.set(job.id, job.pr_id);
      void this.service.processJob(job).finally(() => {
        this.running.delete(job.id);
        this.schedule();
      });
    }
  }
}

class QuestionLane {
  private draining = false;

  constructor(private readonly service: ReviewService) {}

  schedule(): void {
    setImmediate(() => void this.drain());
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const question = this.service.nextQueuedQuestion();
        if (!question) break;
        await this.service.processQuestion(question);
      }
    } finally {
      this.draining = false;
      if (this.service.nextQueuedQuestion()) this.schedule();
    }
  }
}

export class ReviewService {
  readonly db: AppDatabase;
  readonly github: GithubAdapter;
  readonly reviewer: ReviewerAdapter;
  readonly questioner: QuestionAdapter;
  readonly queue: ReviewQueue;
  readonly questionLane: QuestionLane;
  private readonly questionAborts = new Map<string, AbortController>();
  private readonly reviewAborts = new Map<string, AbortController>();
  private readonly listeners = new Set<(prId?: string) => void>();
  private healthState: AppHealth;
  private pollTimer: NodeJS.Timeout | null = null;
  private syncInFlight: Promise<void> | null = null;
  private syncOperation: SyncOperation | null = null;
  private readonly importInFlight = new Map<
    string,
    Promise<PullRequestDetail>
  >();
  private readonly importOperations = new Map<string, ImportOperation>();
  private readonly activeJobs = new Set<Promise<void>>();
  private closed = false;
  private readonly classifier: HumanReviewClassifier;
  private readonly classificationCache = new Map<
    string,
    Awaited<ReturnType<HumanReviewClassifier["classify"]>>
  >();
  private readonly scans = new Map<string, Promise<void>>();

  constructor(
    readonly config: AppConfig,
    db: AppDatabase,
    github?: GithubAdapter,
    reviewer?: ReviewerAdapter,
    questioner?: QuestionAdapter,
    readonly executor: ConfiguredWorkflows | null = null,
    private readonly commandEnv: NodeJS.ProcessEnv = process.env,
    readonly readProviders = new ReadProviders(),
    readonly mcpOAuth = new McpOAuth(
      db.sqlite,
      `http://127.0.0.1:${config.port}/api/mcp/oauth/callback`,
    ),
    classifier?: HumanReviewClassifier,
  ) {
    if (classifier && !config.demo)
      throw new Error(
        "Synthetic classifier injection requires explicit demo mode",
      );
    this.db = db;
    this.readProviders.oauth = mcpOAuth;
    this.mcpOAuth.validateSource = (id) => this.requireOAuthConnection(id);
    this.github =
      github ??
      (config.demo ? new DemoGithubAdapter() : new GithubCliAdapter());
    const adapters = workflowAdapters(
      executor,
      { reviewer, questioner },
      config.dataDir,
      commandEnv,
      this.readProviders,
      !config.demo || commandEnv !== process.env,
    );
    this.classifier =
      classifier ??
      new NativeHumanReviewClassifier(
        config.dataDir,
        commandEnv,
        github === undefined &&
          !config.demo &&
          this.github instanceof GithubCliAdapter,
      );
    this.reviewer = adapters.reviewer;
    this.questioner = adapters.questioner;
    this.queue = new ReviewQueue(this);
    this.questionLane = new QuestionLane(this);
    this.healthState = emptyHealth();
    this.healthState.demo = config.demo;
  }

  static async create(
    config: AppConfig,
    github?: GithubAdapter,
    reviewer?: ReviewerAdapter,
    questioner?: QuestionAdapter,
    commandEnv: NodeJS.ProcessEnv = process.env,
    readProviders = new ReadProviders(),
    oauthFactory?: (db: AppDatabase) => McpOAuth,
    classifier?: HumanReviewClassifier,
  ): Promise<ReviewService> {
    const db = await AppDatabase.open(config.databasePath);
    let executor: ConfiguredWorkflows | null = null;
    try {
      const defaults: AppSettings = {
        repository: config.demo
          ? "demo/repository"
          : (process.env.PR_REVIEW_REPOSITORY ?? ""),
        automation: automationOff,
        pollIntervalSeconds: Number(process.env.PR_REVIEW_POLL_INTERVAL ?? 300),
        maxConcurrentReviews: 1,
        reviewer: config.reviewer,
        harness: {
          selection: {
            version: 2,
            harness: "claude",
            workflow: "dangerous",
            reviewer: {
              skillPath: config.reviewer.skillPath,
              model: config.reviewer.model,
            },
          },
          sources: [],
        },
        integrations: defaultIntegrationSettings(),
      };
      db.initializeSettings(defaults);
      executor = await ConfiguredWorkflows.open(
        config,
        db.getSettings().harness!,
      );
      db.markInterruptedJobs();
      db.markInterruptedQuestions();
      const service = new ReviewService(
        config,
        db,
        github,
        reviewer,
        questioner,
        executor,
        commandEnv,
        readProviders,
        oauthFactory?.(db),
        classifier,
      );
      service.reconcileDraftStates();
      await service.refreshHealth();
      service.startPolling();
      service.queue.schedule();
      return service;
    } catch (error) {
      db.close();
      await executor?.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.mcpOAuth.close();
    this.closed = true;
    for (const controller of [
      ...this.reviewAborts.values(),
      ...this.questionAborts.values(),
    ])
      controller.abort(new Error("Review server is shutting down"));
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.executor?.close();
    await terminateRunningCommands();
    await Promise.all([...this.activeJobs, ...this.scans.values()]);
    this.db.markInterruptedJobs();
    this.db.markInterruptedQuestions();
    this.db.close();
  }

  onChange(listener: (prId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AppState {
    const { harness: _harness, ...settings } = this.db.getSettings();
    const meta = this.db.getSyncMeta();
    return {
      operations: {
        sync: this.syncOperation ? { ...this.syncOperation } : null,
        imports: [...this.importOperations.values()].map((operation) => ({
          ...operation,
        })),
      },
      settings: {
        ...settings,
        integrations: {
          ...settings.integrations,
          configs: settings.integrations.configs.filter(
            (item) => item.native || item.readProvider || item.oauthProfileId,
          ),
        },
      },
      health: {
        ...this.healthState,
        lastPollAt: meta.lastPollAt,
        pollError: meta.pollError,
      },
      integrations: this.getIntegrations(),
      prs: this.db.listInboxPrs().map((pr) => ({
        ...pr,
        reviewJobs: this.reviewJobs(pr.id),
        autoSubmission: this.autoSubmissionState(pr),
      })),
    };
  }

  getDetail(prId: string): PullRequestDetail {
    const pr = this.db.getPr(prId);
    if (!pr) throw new ServiceError(404, "not_found", "pull request not found");
    const diff = this.db.getDiff(prId)!;
    const drafts = this.db.listDrafts(prId);
    return {
      pr: {
        ...pr,
        reviewJobs: this.reviewJobs(pr.id),
        autoSubmission: this.autoSubmissionState(pr),
      },
      diff: diff.diff,
      diffTruncated: diff.truncated,
      runs: this.db.listRuns(prId),
      drafts,
      draft: drafts[0] ?? null,
      proposals: this.db.listProposals(prId),
      submissions: this.db.listSubmissions(prId),
      freshness: this.db.getFreshness(prId),
      questions: this.db.listQuestions(prId),
    };
  }

  getHarness(): HarnessStatus {
    if (!this.executor)
      throw new ServiceError(
        409,
        "execution_unavailable",
        "Configured workflow management is unavailable",
      );
    return this.executor.describe();
  }

  async discoverModels(harness: HarnessId) {
    const selection = this.db.getSettings().harness?.selection;
    return discoverHarnessModels(
      harness,
      selection
        ? [
            {
              id: "main",
              harness: selection.harness,
              model: selection.reviewer?.model ?? null,
            },
            ...(selection.additional ?? []),
          ]
        : [],
      this.commandEnv,
    );
  }

  async selectSkillHarness(
    selection: HarnessSelection,
    confirmation?: string,
  ): Promise<HarnessStatus> {
    if (!currentSelection(selection))
      throw new ServiceError(
        400,
        "invalid_harness",
        "Save version 3 Isolated Main/Additional or version 2 Docker/Dangerous with a reviewer. Historical selection shapes are unsupported.",
      );
    if (
      selection.workflow === "dangerous" &&
      confirmation !== dangerousConfirmation
    )
      throw new ServiceError(
        400,
        "dangerous_confirmation_required",
        dangerousConfirmation,
      );
    if (!this.executor)
      throw new ServiceError(
        409,
        "execution_unavailable",
        "Workflow management unavailable",
      );
    try {
      const prepared = await this.executor.prepareSelection(
        selection,
        this.commandEnv,
      );
      return this.selectHarness(
        prepared.selection! as HarnessSelection,
        confirmation,
        prepared.skill,
        prepared.native,
        prepared.isolated,
      );
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        409,
        "skill_incompatible",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private selectHarness(
    selection: HarnessSelection,
    confirmation?: string,
    skill?: import("../shared/contracts.js").SkillSnapshot,
    native?: import("../shared/contracts.js").HarnessSettings["native"],
    isolated?: import("../shared/contracts.js").IsolatedRolesSnapshot,
  ): HarnessStatus {
    if (
      !["claude", "codex", "pi"].includes(selection.harness) ||
      !currentSelection(selection) ||
      !skill ||
      (selection.version === 3 && !isolated)
    )
      throw new ServiceError(
        400,
        "invalid_harness",
        "Save the supported mode's skill and native configuration explicitly.",
      );
    if (
      selection.workflow === "dangerous" &&
      confirmation !== dangerousConfirmation
    )
      throw new ServiceError(
        400,
        "dangerous_confirmation_required",
        dangerousConfirmation,
      );
    if (!this.executor)
      throw new ServiceError(
        409,
        "execution_unavailable",
        "Configured workflow management is unavailable",
      );
    const settings = {
      ...this.db.getSettings().harness!,
      selection,
      ...(skill ? { skill, native, isolated } : {}),
      ...(selection.workflow === "dangerous"
        ? {
            dangerousConsent: {
              version: 1 as const,
              harness: selection.harness,
              confirmedAt: now(),
            },
          }
        : {}),
    };
    this.db.updateHarness(settings);
    this.executor.update(settings);
    this.emit();
    return this.getHarness();
  }

  async inspectDocker(
    request: import("../shared/contracts.js").DockerInspectRequest,
  ) {
    if (!this.executor)
      throw new ServiceError(
        409,
        "execution_unavailable",
        "Workflow management unavailable",
      );
    try {
      return await this.executor.inspectDocker(
        request,
        this.db.getSettings().integrations.configs,
        this.commandEnv,
      );
    } catch (error) {
      throw new ServiceError(
        409,
        "docker_inspection_failed",
        error instanceof Error ? error.message : "Docker inspection failed",
      );
    }
  }

  async setupDocker(
    harness: HarnessId,
    confirmation?: string,
    approval?: import("../shared/contracts.js").DockerCapabilityApproval,
  ): Promise<HarnessStatus> {
    if (confirmation !== dockerSetupConfirmation)
      throw new ServiceError(
        400,
        "setup_confirmation_required",
        dockerSetupConfirmation,
      );
    if (!["claude", "codex", "pi"].includes(harness))
      throw new ServiceError(
        400,
        "invalid_harness",
        "Select claude, codex or pi",
      );
    if (!this.executor)
      throw new ServiceError(
        409,
        "execution_unavailable",
        "Workflow management unavailable",
      );
    try {
      const pending = this.executor.setup(
        harness,
        this.commandEnv,
        undefined,
        approval,
      );
      this.emit();
      const source = await pending;
      const current = this.db.getSettings().harness!;
      const settings = {
        ...current,
        sources: [
          ...current.sources.filter((item) => item.id !== source.id),
          source,
        ],
        managed: { ...current.managed, [harness]: source.id },
      };
      this.db.updateHarness(settings);
      this.executor.update(settings);
      return this.getHarness();
    } catch (error) {
      throw new ServiceError(
        409,
        "docker_setup_failed",
        error instanceof Error ? error.message : "Docker setup failed",
      );
    } finally {
      this.emit();
    }
  }

  getExecution(): ExecutionStatus {
    return (
      this.executor?.status() ?? {
        status: "disabled",
        message:
          "Execution settings are unavailable. Save a supported selection before starting.",
        snapshot: null,
      }
    );
  }

  async checkExecution(): Promise<ExecutionStatus> {
    if (!this.executor)
      throw new ServiceError(
        409,
        "execution_unavailable",
        "No Docker workflow selected",
      );
    try {
      await this.executor.check();
    } catch (error) {
      throw new ServiceError(
        409,
        "execution_unavailable",
        error instanceof Error ? error.message : "Execution check failed",
      );
    }
    return {
      ...this.executor.status(),
      message:
        "Synthetic policy/runtime preflight passed. No credentials, model inference or external integrations were checked. Not verified connected.",
    };
  }

  private captureReviewer() {
    const settings = this.db.getSettings().reviewer;
    try {
      const captured = this.executor?.capture(settings);
      requireSupportedExecution(captured);
      return captured;
    } catch (error) {
      throw new ServiceError(
        409,
        "execution_incompatible",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  getIntegrations(): IntegrationCatalog {
    const catalog = buildIntegrationCatalog(
      this.db.getSettings().integrations,
      this.healthState.github.status === "ready",
      this.getExecution().status === "configured" ||
        Boolean(
          this.executor?.selection()?.version === 3 &&
          !this.executor.describe().requiresSave,
        ),
    );
    if (this.executor?.mode() === "dangerous")
      catalog.boundary.message =
        "Dangerous host tools and credentials are unrestricted by these read-integration permissions and can publish without the app preview.";
    for (const connection of catalog.connections) {
      connection.evidence = this.readProviders.lastTest(
        connection.definition.id,
      );
      if (connection.config.oauthProfileId) {
        connection.oauth = this.mcpOAuth.status(connection.config.id);
        connection.message = catalog.oauthProfiles!.find(
          (profile) => profile.id === connection.config.oauthProfileId,
        )!.message;
        connection.definition.compatibilityMessage = connection.message;
        if (
          !connection.oauth.authenticated ||
          connection.config.inventory?.oauthBinding?.generation !==
            connection.oauth.generation
        ) {
          connection.effective = "disabled";
          for (const tool of connection.tools)
            if (tool.state === "allowed") tool.state = "unsupported";
        }
      }
    }
    return catalog;
  }

  async discoverIntegrations(
    request: NativeMcpDiscoveryRequest,
  ): Promise<IntegrationCatalog> {
    try {
      const configs = await discoverNativeMcp(request, this.commandEnv);
      const current = this.db.getSettings().integrations;
      const replacements = configs.filter((config) => {
        const existing = current.configs.find((item) => item.id === config.id);
        return (
          !existing ||
          existing.endpoint !== config.endpoint ||
          JSON.stringify(existing.native) !== JSON.stringify(config.native)
        );
      });
      try {
        for (const config of replacements)
          this.mcpOAuth.assertReplaceable(config.id);
      } catch {
        throw new ServiceError(
          409,
          "oauth_disconnect_required",
          "A discovered native definition changed. Disconnect that app-owned OAuth connection before replacing it; existing connections, credentials and grants remain unchanged.",
        );
      }
      for (const config of replacements)
        this.readProviders.invalidate(config.id);
      return this.updateIntegrations({
        configs: [
          ...current.configs.map(
            (item) =>
              replacements.find((config) => config.id === item.id) ?? item,
          ),
          ...replacements.filter(
            (config) => !current.configs.some((item) => item.id === config.id),
          ),
        ],
        importedHarnessAt: now(),
      });
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        409,
        "native_mcp_unsupported",
        error instanceof NativeMcpDiscoveryError
          ? error.message
          : "Native discovery failed: use an absolute trusted Claude mcpServers JSON or Codex mcp_servers TOML source. Pi extension formats, project discovery and executable helpers are unsupported.",
      );
    }
  }

  importNativeIntegration(request: NativeMcpImportRequest): IntegrationCatalog {
    const current = this.db.getSettings().integrations;
    const config = current.configs.find((item) => item.id === request.id);
    if (!config)
      throw new ServiceError(
        404,
        "not_found",
        "Discover the native connection first",
      );
    try {
      const reference = nativeReference(
        config,
        request.profileId,
        request.scope,
      );
      this.readProviders.invalidate(config.id);
      return this.updateIntegrations({
        ...current,
        configs: current.configs.map((item) =>
          item.id === config.id
            ? {
                ...config,
                readProvider: reference,
                enabled: false,
                allowedTools: [],
                inventory: undefined,
              }
            : item,
        ),
      });
    } catch (error) {
      throw new ServiceError(
        409,
        "native_mcp_unsupported",
        error instanceof Error ? error.message : "Unsupported profile",
      );
    }
  }

  async discoverDockerLibraryLeaf(source: string) {
    if (!this.executor)
      throw new ServiceError(
        409,
        "docker_selection_required",
        "Save Docker before source discovery",
      );
    try {
      return await this.executor.discoverLibraryLeaf(source, this.commandEnv);
    } catch (error) {
      throw new ServiceError(
        409,
        "docker_library_leaf_failed",
        error instanceof Error
          ? error.message
          : "Installed leaf metadata discovery failed",
      );
    }
  }

  async discoverDockerExclusions() {
    const selection = this.executor?.selection();
    if (selection?.workflow !== "docker")
      throw new ServiceError(
        409,
        "docker_selection_required",
        "Save Docker before discovering source-bound exclusions",
      );
    return dockerExclusions(this.commandEnv.HOME!);
  }

  addOAuthIntegration(profileId: string): IntegrationCatalog {
    const profile = oauthMcpProfiles.find((item) => item.id === profileId);
    if (!profile)
      throw new ServiceError(
        409,
        "oauth_unsupported",
        "Choose a reviewed OAuth provider",
      );
    const settings = this.db.getSettings().integrations;
    const id = `oauth:${profile.id}`;
    if (settings.configs.some((item) => item.id === id))
      return this.getIntegrations();
    this.mcpOAuth.import(id, profileId);
    return this.updateIntegrations({
      ...settings,
      configs: [
        ...settings.configs,
        {
          id,
          oauthProfileId: profile.id,
          enabled: false,
          allowedTools: [],
          source: "custom",
          endpoint: profile.endpoint,
          serverName: profile.label,
          authRef: null,
          configPath: null,
        },
      ],
    });
  }

  async importOAuthIntegration(
    id: string,
    profileId: string,
  ): Promise<IntegrationCatalog> {
    const settings = this.db.getSettings().integrations;
    const config = settings.configs.find((item) => item.id === id);
    const profile = oauthMcpProfiles.find((item) => item.id === profileId);
    if (
      !config?.native ||
      !profile ||
      config.endpoint !== profile.endpoint ||
      config.readProvider
    )
      throw new ServiceError(
        409,
        "oauth_unsupported",
        "Discover exact trusted HTTP MCP metadata and choose a matching OAuth profile; existing bearer providers are not converted",
      );
    await validateNativeOAuthSource(config.native, profile.endpoint);
    this.mcpOAuth.import(id, profileId);
    this.readProviders.invalidate(id);
    return this.updateIntegrations({
      ...settings,
      configs: settings.configs.map((item) =>
        item.id === id
          ? {
              ...item,
              oauthProfileId: profileId,
              enabled: false,
              allowedTools: [],
              inventory: undefined,
            }
          : item,
      ),
    });
  }

  async requireOAuthConnection(id: string): Promise<void> {
    const config = this.db
      .getSettings()
      .integrations.configs.find((item) => item.id === id);
    if (!config?.oauthProfileId || !config.endpoint)
      throw new ServiceError(
        409,
        "oauth_unsupported",
        "Import supported OAuth metadata first",
      );
    await validateOAuthSource(config);
  }

  async completeOAuthCallback(
    params: URLSearchParams,
    browser: string,
    origin: string,
    handback = false,
  ) {
    const id = await (handback
      ? this.mcpOAuth.complete(params, browser, origin)
      : this.mcpOAuth.callback(params, browser, origin));
    this.invalidateOAuthGrants(id);
    return { id, status: this.mcpOAuth.status(id) };
  }

  invalidateOAuthGrants(id: string): void {
    this.readProviders.invalidate(id);
    const settings = this.db.getSettings().integrations;
    this.updateIntegrations({
      ...settings,
      configs: settings.configs.map((item) =>
        item.id === id
          ? { ...item, enabled: false, allowedTools: [], inventory: undefined }
          : item,
      ),
    });
  }

  async loadIntegrationTools(id: string): Promise<IntegrationCatalog> {
    const current = this.db.getSettings().integrations;
    const config = current.configs.find((item) => item.id === id);
    if (!config)
      throw new ServiceError(
        404,
        "not_found",
        "Discover/import a connection first",
      );
    const inventory = await this.readProviders.loadTools(config);
    this.readProviders.invalidate(id);
    return this.updateIntegrations({
      ...current,
      configs: current.configs.map((item) =>
        item.id === id
          ? { ...item, inventory, enabled: false, allowedTools: [] }
          : item,
      ),
    });
  }

  async importReadProviders(file: string): Promise<IntegrationCatalog> {
    try {
      const configs = await importReadProviders(file);
      const current = this.db.getSettings().integrations;
      for (const config of configs) this.readProviders.invalidate(config.id);
      return this.updateIntegrations({
        configs: [
          ...current.configs.filter(
            (item) => !configs.some((config) => config.id === item.id),
          ),
          ...configs,
        ],
        importedHarnessAt: now(),
      });
    } catch (error) {
      throw new ServiceError(
        409,
        "provider_incompatible",
        error instanceof Error ? error.message : "Read-provider import failed",
      );
    }
  }

  async testIntegration(id: string) {
    const config = this.getIntegrations().connections.find(
      (item) => item.definition.id === id,
    )?.config;
    if (!config)
      throw new ServiceError(404, "not_found", "integration not found");
    const result = await this.readProviders.test(config);
    this.emit();
    return result;
  }

  updateIntegrations(settings: IntegrationSettings): IntegrationCatalog {
    this.db.updateIntegrations(normalizeIntegrationSettings(settings));
    this.emit();
    return this.getIntegrations();
  }

  updateIntegration(
    id: string,
    update: Partial<IntegrationConfig>,
  ): IntegrationCatalog {
    const current = this.db.getSettings().integrations;
    const existing = this.getIntegrations().connections.find(
      (item) => item.config.id === id,
    )?.config;
    if (!existing)
      throw new ServiceError(
        404,
        "not_found",
        "Discover or import a supported connection first",
      );
    const next = normalizeIntegrationSettings({
      ...current,
      configs: current.configs
        .filter((item) => item.id !== id)
        .concat({ ...existing, ...update, id }),
    });
    return this.updateIntegrations(next);
  }

  async refreshHealth(): Promise<void> {
    const githubHealth = await this.github.health();
    this.healthState = {
      github: githubHealth.user
        ? health("ready", githubHealth.message)
        : health("unavailable", githubHealth.message),
      githubUser: githubHealth.user,
      lastPollAt: this.db.getSyncMeta().lastPollAt,
      pollError: this.db.getSyncMeta().pollError,
      demo: this.config.demo,
    };
  }

  async importPullRequest(url: string): Promise<PullRequestDetail> {
    let parsed: { repository: string; number: number };
    try {
      parsed = parsePullRequestUrl(url);
    } catch (error) {
      if (this.config.demo && url.includes("/pull/42"))
        parsed = {
          repository: this.db.getSettings().repository || "demo/repository",
          number: 42,
        };
      else
        throw new ServiceError(
          400,
          "invalid_url",
          error instanceof Error ? error.message : String(error),
        );
    }
    const settings = this.db.getSettings();
    if (settings.repository && settings.repository !== parsed.repository)
      throw new ServiceError(
        409,
        "repository_mismatch",
        "pull request repository does not match configured repository",
      );
    const key = prId(parsed.repository, parsed.number);
    const existing = this.importInFlight.get(key);
    if (existing) return existing;
    if (!settings.repository)
      this.db.updateSettings({ repository: parsed.repository });
    const operation: ImportOperation = {
      id: id(),
      repository: parsed.repository,
      prId: key,
      number: parsed.number,
      status: "running",
      startedAt: now(),
      finishedAt: null,
      error: null,
    };
    this.importOperations.set(key, operation);
    let failure: string | null = null;
    const pending = this.performImport(parsed.repository, parsed.number)
      .catch((error) => {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        operation.status = failure === null ? "completed" : "failed";
        operation.error = failure;
        operation.finishedAt = now();
        this.importInFlight.delete(key);
        this.emit(key);
      });
    this.importInFlight.set(key, pending);
    this.emit(key);
    return pending;
  }

  private async performImport(
    repository: string,
    number: number,
  ): Promise<PullRequestDetail> {
    const remote = await this.github.getPullRequest(repository, number);
    if (remote.pr.state !== "OPEN") {
      if (this.db.getPr(remote.pr.id)) {
        this.observe(remote, { requestsKnown: false, automatic: true });
        this.emit(remote.pr.id);
      }
      throw new ServiceError(
        409,
        "pr_closed",
        "only open pull requests can be imported; this one is closed or merged",
      );
    }
    this.observe(remote, { requestsKnown: false, automatic: true });
    this.db.markImported(remote.pr.id);
    await this.recordMergeReadiness(remote.pr.id);
    if (automaticallyReviewed(this.requirePr(remote.pr.id)))
      await this.scanHumanReview(remote.pr.id);
    this.emit(remote.pr.id);
    return this.getDetail(remote.pr.id);
  }

  saveAutoSubmission(update: AutoSubmissionUpdate): AppState {
    const current = this.db.getSettings();
    const policy = current.autoSubmission!;
    const authors = normalizeAutoSubmissionAuthors(update.authors);
    if (
      !authors ||
      typeof update.repository !== "string" ||
      typeof update.enabled !== "boolean" ||
      !Number.isInteger(update.expectedVersion) ||
      update.expectedVersion < 0 ||
      Object.keys(update).some(
        (key) =>
          ![
            "repository",
            "expectedVersion",
            "enabled",
            "authors",
            "confirmation",
          ].includes(key),
      ) ||
      (update.confirmation !== undefined &&
        update.confirmation !== autoSubmissionConfirmation) ||
      (update.enabled && update.confirmation !== autoSubmissionConfirmation)
    )
      throw new ServiceError(
        400,
        "invalid_auto_submission",
        "Invalid author/action table or missing explicit future-publication consent",
      );
    if (
      !current.repository ||
      current.repository.toLowerCase() !== update.repository.toLowerCase() ||
      policy.version !== update.expectedVersion
    )
      throw new ServiceError(
        409,
        "auto_submission_conflict",
        "Repository or publication policy changed; reload before saving",
      );
    this.db.savePublicationPolicy({
      repository: current.repository,
      enabled: update.enabled,
      authors,
      version: policy.version + 1,
      consentedAt: update.enabled ? now() : null,
    });
    this.emit();
    return this.getState();
  }

  editIntent(prId: string, intent: DraftEditIntent): PullRequestDetail {
    this.requirePr(prId);
    const draft = this.requireDraft(prId, intent.draftId);
    if (
      draft.version !== intent.version ||
      this.db
        .listSubmissions(prId)
        .some(
          (item) =>
            item.authority?.kind === "automatic" &&
            item.authority.draftId === draft.id &&
            item.authority.draftVersion === intent.version &&
            (item.status === "submitting" || item.status === "uncertain"),
        )
    )
      throw new ServiceError(
        409,
        "draft_conflict",
        "Draft version changed or automatic publication is in flight or uncertain; reload or reconcile before editing. Edit intent cannot cancel a dispatched write",
      );
    if (!draft.autoSubmission?.manualHold) {
      this.db.updateDraft({
        ...draft,
        autoSubmission: {
          provenance: draft.autoSubmission?.provenance ?? null,
          manualHold: { reason: "edit_intent", at: now() },
        },
      });
      this.emit(prId);
    }
    return this.getDetail(prId);
  }

  acknowledgeHumanReview(
    prId: string,
    acknowledgment: HumanReviewAcknowledgment,
  ): PullRequestDetail {
    this.requirePr(prId);
    const state = this.db.getPublicationState(prId);
    const evidence = state.evidence.find(
      (item) =>
        item.id === acknowledgment.evidenceId &&
        revision(item.source) === revision(acknowledgment.source),
    );
    if (state.version !== acknowledgment.expectedVersion || !evidence)
      throw new ServiceError(
        409,
        "auto_submission_conflict",
        "Human-review evidence or hold version changed",
      );
    if (!evidence.acknowledgment) {
      evidence.acknowledgment = { action: acknowledgment.action, at: now() };
      state.version++;
      this.db.savePublicationState(prId, state);
      this.emit(prId);
    }
    return this.getDetail(prId);
  }

  async reenableAutoSubmission(
    prId: string,
    request: AutoSubmissionReenable,
  ): Promise<PullRequestDetail> {
    this.requirePr(prId);
    const before = this.db.getPublicationState(prId);
    if (before.version !== request.expectedVersion)
      throw new ServiceError(
        409,
        "auto_submission_conflict",
        "Hold state changed; reload before re-enabling",
      );
    if (request.confirmation !== autoSubmissionReenableConfirmation)
      throw new ServiceError(
        400,
        "invalid_auto_submission",
        "Explicit future-review re-enable confirmation is required",
      );
    await this.scanHumanReview(prId);
    const state = this.db.getPublicationState(prId);
    if (state.version !== request.expectedVersion)
      throw new ServiceError(
        409,
        "auto_submission_conflict",
        "New evidence arrived during the fresh check",
      );
    if (
      state.evidence.some((item) => !item.acknowledgment) ||
      state.check?.status !== "clear"
    )
      throw new ServiceError(
        409,
        "auto_submission_held",
        "A complete clear check and acknowledgment of every request are required",
      );
    state.reenableRequired = false;
    state.generation++;
    state.version++;
    this.db.savePublicationState(prId, state);
    this.emit(prId);
    return this.getDetail(prId);
  }

  async checkAutoSubmission(prId: string): Promise<PullRequestDetail> {
    this.requirePr(prId);
    await this.reconcileAutomatic(prId);
    await this.scanHumanReview(prId);
    return this.getDetail(prId);
  }

  private automaticProvenance(
    pr: PullRequest,
    trigger: ReviewRun["trigger"],
  ): AutomaticReviewProvenance | null {
    const policy = this.db.getSettings().autoSubmission!;
    const author = normalizeGithubUsername(pr.author);
    const row = policy.authors.find((item) => item.username === author);
    if (
      !policy.enabled ||
      !policy.consentedAt ||
      policy.repository.toLowerCase() !== pr.repository.toLowerCase() ||
      !row?.actions.length ||
      (trigger !== "request" && trigger !== "new_commits")
    )
      return null;
    return {
      repository: policy.repository,
      policyVersion: policy.version,
      consentedAt: policy.consentedAt,
      author: row.username,
      actions: [...row.actions],
      trigger,
      prGeneration: this.db.getPublicationState(pr.id).generation,
    };
  }

  private automaticEligibility(pr: PullRequest): {
    status: AutoSubmissionState["status"];
    message: string;
  } {
    const state = this.db.getPublicationState(pr.id);
    const draft = this.db.latestDraft(pr.id);
    const policy = this.db.getSettings().autoSubmission!;
    const submissions = this.db.listSubmissions(pr.id);
    if (state.evidence.some((item) => !item.acknowledgment))
      return {
        status: "human_review_requested",
        message: "A participant requested human review",
      };
    if (state.check?.status === "check_needed")
      return { status: "check_needed", message: state.check.message };
    if (submissions.some((item) => item.status === "uncertain"))
      return {
        status: "check_needed",
        message:
          "An earlier write is uncertain; exact reconciliation is required",
      };
    if (submissions.some((item) => item.status === "submitting"))
      return { status: "held", message: "A submission is already in flight" };
    if (state.reenableRequired)
      return {
        status: "held",
        message:
          "Automatic publication is paused; resolve any evidence and explicitly re-enable for future reviews",
      };
    if (
      !policy.enabled ||
      policy.repository.toLowerCase() !== pr.repository.toLowerCase() ||
      policy.repository.toLowerCase() !==
        this.db.getSettings().repository.toLowerCase()
    )
      return {
        status: "off",
        message: "Automatic submission is off for this repository",
      };
    const row = policy.authors.find(
      (item) => item.username === normalizeGithubUsername(pr.author),
    );
    if (!row?.actions.length)
      return {
        status: "not_authorized",
        message: "No automatic verdict permissions for this PR author",
      };
    const provenance = draft?.autoSubmission?.provenance;
    const run = draft?.runId ? this.db.getRun(draft.runId) : null;
    if (
      !draft ||
      !provenance ||
      draft.autoSubmission?.manualHold ||
      draft.version !== 1 ||
      !run ||
      run.kind !== "review" ||
      run.status !== "completed" ||
      !run.result ||
      !run.autoSubmission ||
      revision(provenance) !== revision(run.autoSubmission) ||
      provenance.repository.toLowerCase() !== policy.repository.toLowerCase() ||
      provenance.policyVersion !== policy.version ||
      provenance.consentedAt !== policy.consentedAt ||
      provenance.prGeneration !== state.generation ||
      provenance.author !== normalizeGithubUsername(pr.author) ||
      !provenance.actions.includes(draft.verdict) ||
      !row.actions.includes(draft.verdict)
    )
      return {
        status: "manual_only",
        message:
          "Only untouched future automatic full-review drafts with current consent qualify",
      };
    if (
      revision({
        overview: draft.overview,
        body: draft.body,
        findings: draft.findings,
        verdict: draft.verdict,
      }) !==
      revision({
        overview: run.result.overview,
        body: run.result.body,
        findings: run.result.findings,
        verdict: run.result.verdict,
      })
    )
      return {
        status: "manual_only",
        message: "Generated review payload changed",
      };
    if (
      pr.state !== "OPEN" ||
      draft.headSha !== pr.headSha ||
      run.headSha !== pr.headSha
    )
      return {
        status: "manual_only",
        message:
          "A successful automatic review of the current open head is required",
      };
    if (
      draft.verdict === "COMMENT" &&
      run.result.findings.some((item) => item.severity === "blocking")
    )
      return {
        status: "not_authorized",
        message:
          "COMMENT permission cannot publish a review containing blocking findings",
      };
    if (
      submissions.some(
        (item) =>
          item.status === "submitted" && item.payload.commit_id === pr.headSha,
      ) ||
      this.db.automaticHeadClaimed(pr.id, pr.headSha)
    )
      return {
        status: "submitted",
        message:
          "This head already has a local submission or durable automatic attempt",
      };
    if (
      this.db
        .listJobs()
        .some(
          (item) =>
            item.pr_id === pr.id &&
            (item.status === "queued" || item.status === "running"),
        )
    )
      return {
        status: "held",
        message: "Another review or revision is pending",
      };
    return {
      status: "eligible",
      message:
        "Current consent matches this untouched automatic draft; fresh publication gates still apply",
    };
  }

  private autoSubmissionState(pr: PullRequest): AutoSubmissionState {
    return {
      ...this.db.getPublicationState(pr.id),
      ...this.automaticEligibility(pr),
      draftId: this.db.latestDraft(pr.id)?.id ?? null,
    };
  }

  private pauseAutomatic(prId: string, message: string): void {
    const state = this.db.getPublicationState(prId);
    if (!state.reenableRequired) {
      state.generation++;
      state.version++;
    }
    state.reenableRequired = true;
    state.check = {
      status: "check_needed",
      headSha: this.requirePr(prId).headSha,
      revision: null,
      checkedAt: now(),
      coverage: emptyCoverage(),
      message,
      detector: null,
    };
    this.db.savePublicationState(prId, state);
    this.emit(prId);
  }

  private async scanHumanReview(
    prId: string,
    capturedSettings?: ReviewerSettings,
  ): Promise<void> {
    const previous = this.scans.get(prId) ?? Promise.resolve();
    const pending = previous
      .then(() =>
        this.closed ? undefined : this.performHumanScan(prId, capturedSettings),
      )
      .finally(() => {
        if (this.scans.get(prId) === pending) this.scans.delete(prId);
      });
    this.scans.set(prId, pending);
    return pending;
  }

  private async performHumanScan(
    prId: string,
    capturedSettings?: ReviewerSettings,
  ): Promise<void> {
    const controller = new AbortController();
    this.reviewAborts.set(`scan:${prId}`, controller);
    let discussion: Awaited<
      ReturnType<NonNullable<GithubAdapter["discussion"]>>
    > | null = null;
    try {
      const pr = this.requirePr(prId);
      const remote = await this.github.getPullRequest(pr.repository, pr.number);
      controller.signal.throwIfAborted();
      this.observe(
        remote,
        { requestsKnown: false, automatic: false, preserveBaseline: true },
        prId,
      );
      if (!this.github.discussion)
        throw new Error(
          "Discussion acquisition is unavailable for this adapter; no clear scan inferred",
        );
      discussion = await this.captureDiscussion(remote.pr);
      controller.signal.throwIfAborted();
      if (!discussion) throw new Error("Discussion acquisition unavailable");
      if (
        discussion.prId !== prId ||
        discussion.headSha !== remote.pr.headSha ||
        !discussion.coverage.complete
      )
        throw new Error(
          "Discussion acquisition is incomplete or targets another head",
        );
      if (
        discussion.sources.some(
          (source) =>
            source.provenance === "unknown" || source.authorType === "unknown",
        )
      )
        throw new Error(
          "Discussion attribution is unknown; no clear scan inferred",
        );
      const input = {
        pr: {
          title: remote.pr.title,
          body: remote.pr.body,
          author: remote.pr.author,
        },
        discussion,
      };
      if (Buffer.byteLength(JSON.stringify(input)) > 200000)
        throw new Error(
          "Complete classifier input exceeds its byte limit; no truncated clear scan accepted",
        );
      const settings = capturedSettings ?? this.captureReviewer();
      const cacheKey = revision({
        input: discussion.revision,
        reviewer: settings,
      });
      const cached = this.classificationCache.get(cacheKey);
      const result =
        cached ??
        (await this.classifier.classify(input, settings, controller.signal));
      controller.signal.throwIfAborted();
      const output = validateClassification(input, result.output);
      if (this.requirePr(prId).headSha !== remote.pr.headSha)
        throw new Error("PR head changed while discussion was classified");
      if (this.classificationCache.size >= 100)
        this.classificationCache.clear();
      this.classificationCache.set(cacheKey, { ...result, output });
      const state = this.db.getPublicationState(prId);
      let changed = false;
      for (const item of output.results.filter(
        (item) => item.decision === "requested",
      )) {
        if (
          state.evidence.some(
            (evidence) => revision(evidence.source) === revision(item.source),
          )
        )
          continue;
        const source = discussion.sources.find(
          (source) =>
            source.kind === item.source.kind && source.id === item.source.id,
        )!;
        state.evidence.push({
          id: id(),
          source: item.source,
          author: source.author,
          quote: item.quote!,
          url: source.url,
          detectedAt: now(),
          acknowledgment: null,
        });
        changed = true;
      }
      const uncertain = output.results.some(
        (item) => item.decision === "uncertain",
      );
      const held = state.evidence.some((item) => !item.acknowledgment);
      if ((held || uncertain) && !state.reenableRequired) changed = true;
      if (changed) {
        state.version++;
        state.generation++;
      }
      if (held || uncertain) state.reenableRequired = true;
      state.check = {
        status: held
          ? "human_review_requested"
          : uncertain
            ? "check_needed"
            : "clear",
        headSha: remote.pr.headSha,
        revision: discussion.revision,
        checkedAt: now(),
        coverage: discussion.coverage,
        message: held
          ? "A participant requested human review"
          : uncertain
            ? "Human-review intent is uncertain; check needed"
            : "Complete discussion check found no unacknowledged human-review request",
        detector: result.detector,
      };
      this.db.savePublicationState(prId, state);
      this.emit(prId);
    } catch (error) {
      if (!this.closed) {
        this.pauseAutomatic(
          prId,
          error instanceof Error ? error.message : "Human-review check failed",
        );
        if (discussion) {
          const state = this.db.getPublicationState(prId);
          state.check!.coverage = discussion.coverage;
          state.check!.revision = discussion.revision;
          this.db.savePublicationState(prId, state);
        }
      }
    } finally {
      this.reviewAborts.delete(`scan:${prId}`);
    }
  }

  private async captureDiscussion(
    pr: PullRequest,
  ): Promise<DiscussionSnapshot | null> {
    try {
      if (!this.github.discussion) return null;
      const discussion = await this.github.discussion(pr);
      if (discussion.prId !== pr.id || discussion.headSha !== pr.headSha)
        return null;
      const submissions = this.db
        .listSubmissions(pr.id)
        .filter(
          (item) =>
            item.status === "submitted" && item.authority?.kind === "automatic",
        );
      for (const submission of submissions) {
        if (
          discussion.sources.some(
            (source) =>
              source.kind === "inline_comment" &&
              source.reviewId === submission.githubReviewId,
          ) &&
          !this.db.getRecovery(submission.previewId)?.commentIds
        )
          await this.captureAutomaticCommentIds(pr.id, submission);
      }
      const nativeVersions = discussion.sources.map((item) => ({
        kind: item.kind,
        id: item.id,
        version: item.version,
        threadId: item.threadId,
      }));
      for (const source of discussion.sources) {
        const automated = submissions.find(
          (item) =>
            item.githubReviewId ===
            (source.kind === "review" ? source.id : source.reviewId),
        );
        const recovery = automated
          ? this.db.getRecovery(automated.previewId)
          : null;
        if (
          automated &&
          recovery?.writer.toLowerCase() === source.author.toLowerCase() &&
          (source.kind === "review"
            ? automated.payload.body === source.body
            : recovery.commentIds?.includes(source.id) &&
              automated.payload.comments.some(
                (item) => item.body === source.body,
              ))
        )
          source.provenance = "app_automatic";
        source.version = revision({
          source: source.version,
          title: pr.title,
          body: pr.body,
          context: nativeVersions.filter((item) =>
            source.threadId
              ? item.threadId === source.threadId
              : item.threadId === null,
          ),
        });
      }
      discussion.revision = revision({
        head: discussion.headSha,
        title: pr.title,
        body: pr.body,
        sources: discussion.sources,
        coverage: discussion.coverage,
      });
      return Buffer.byteLength(
        JSON.stringify({
          pr: { title: pr.title, body: pr.body, author: pr.author },
          discussion,
        }),
      ) <= 200000
        ? discussion
        : null;
    } catch {
      return null;
    }
  }

  private recordHumanReview(
    run: ReviewRun,
    result: ReviewResult,
    discussion: DiscussionSnapshot | null | undefined,
    diagnostics: string[],
  ): void {
    const state = this.db.getPublicationState(run.prId);
    const observation = result.humanReviewRequest;
    let changed = false;
    for (const item of observation?.evidence ?? []) {
      if (
        state.evidence.some(
          (evidence) => revision(evidence.source) === revision(item.source),
        )
      )
        continue;
      state.evidence.push({
        ...item,
        id: id(),
        detectedAt: now(),
        acknowledgment: null,
      });
      changed = true;
    }
    if (changed) {
      state.version++;
      state.generation++;
      state.reenableRequired = true;
    }
    const complete =
      discussion?.coverage.complete &&
      discussion.sources.every(
        (source) =>
          source.authorType !== "unknown" && source.provenance !== "unknown",
      );
    const found = !!observation?.evidence.length;
    state.detection = {
      status: found
        ? "found"
        : observation && complete
          ? "not_found"
          : "unavailable",
      runId: run.id,
      headSha: run.headSha,
      contextVersion:
        observation?.contextVersion ?? discussion?.revision ?? null,
      observedAt: now(),
      coverage: discussion?.coverage ?? emptyCoverage(),
      message: found
        ? `Human review requested in supplied context${complete ? "" : "; unread discussion detection unavailable"}`
        : observation && complete
          ? "No human-review request noticed in supplied context; not a clear certificate"
          : `Human-request detection unavailable${diagnostics.length ? `: ${diagnostics.join("; ")}` : ": supplied discussion is incomplete or unavailable"}`,
    };
    this.db.savePublicationState(run.prId, state);
  }

  private async captureAutomaticCommentIds(
    prId: string,
    submission: Submission,
  ): Promise<void> {
    const recovery = this.db.getRecovery(submission.previewId);
    if (!recovery || !this.github.reviewInventory)
      throw new Error("Exact automated inline provenance is unavailable");
    const inventory = await this.github.reviewInventory({
      ...this.requirePr(prId),
      headSha: submission.payload.commit_id,
    });
    const review = inventory.reviews.find(
      (item) =>
        item.id === submission.githubReviewId &&
        inventory.writer.toLowerCase() === recovery.writer.toLowerCase() &&
        item.author.toLowerCase() === recovery.writer.toLowerCase() &&
        sameReviewPayload(item.payload, submission.payload),
    );
    if (!review)
      throw new Error(
        "Exact automated inline provenance could not be confirmed",
      );
    if (!this.closed)
      this.db.saveRecovery(submission.previewId, {
        ...recovery,
        commentIds: review.commentIds,
      });
  }

  private async reconcileAutomatic(prId: string): Promise<void> {
    for (const submission of this.db
      .listSubmissions(prId)
      .filter(
        (item) =>
          item.authority?.kind === "automatic" && item.status === "uncertain",
      )) {
      const recovery = this.db.getRecovery(submission.previewId);
      if (!recovery || !this.github.reviewInventory) continue;
      try {
        const inventory = await this.github.reviewInventory({
          ...this.requirePr(prId),
          headSha: submission.payload.commit_id,
        });
        const match = exactReview(inventory, recovery, submission.payload);
        if (
          match &&
          this.db.getSubmission(submission.id)?.status === "uncertain"
        ) {
          this.db.saveRecovery(submission.previewId, {
            ...recovery,
            commentIds: match.commentIds,
          });
          this.db.updateSubmission({
            ...submission,
            status: "submitted",
            githubReviewId: match.id,
            url: match.url,
            error: null,
          });
          this.reconcileSubmitted(prId);
          this.emit(prId);
        }
      } catch {
        this.pauseAutomatic(
          prId,
          "Exact complete remote reconciliation is unavailable; no retry permitted",
        );
      }
    }
  }

  private async automaticSubmission(prId: string): Promise<void> {
    try {
      if (
        this.closed ||
        this.automaticEligibility(this.requirePr(prId)).status !== "eligible"
      )
        return;
      const draft = this.db.latestDraft(prId)!;
      const provenance = draft.autoSubmission!.provenance!;
      if (!this.github.reviewInventory)
        throw new Error(
          "Complete review/inline evidence is unavailable for automatic publication",
        );
      const inventory: ReviewInventory = await this.github.reviewInventory(
        this.requirePr(prId),
      );
      if (
        this.automaticEligibility(this.requirePr(prId)).status !== "eligible" ||
        this.db.latestDraft(prId)?.id !== draft.id
      )
        return;
      await this.scanHumanReview(prId, this.db.getRun(draft.runId!)!.reviewer);
      if (
        this.automaticEligibility(this.requirePr(prId)).status !== "eligible" ||
        this.db.latestDraft(prId)?.id !== draft.id
      )
        return;
      const scanned = this.requirePr(prId);
      const remote = await this.github.getPullRequest(
        provenance.repository,
        scanned.number,
      );
      if (
        remote.pr.title !== scanned.title ||
        remote.pr.body !== scanned.body ||
        remote.pr.author !== scanned.author
      )
        throw new Error(
          "PR context changed after classification; a fresh check is required",
        );
      this.observe(
        remote,
        { requestsKnown: false, automatic: false, preserveBaseline: true },
        prId,
      );
      const current = this.requirePr(prId);
      const state = this.db.getPublicationState(prId);
      if (
        this.closed ||
        this.automaticEligibility(current).status !== "eligible" ||
        this.db.latestDraft(prId)?.id !== draft.id ||
        state.check?.headSha !== current.headSha ||
        state.check.status !== "clear" ||
        !state.check.revision
      )
        return;
      const preview = this.createPreview(
        current,
        this.requireDraft(prId, draft.id),
        remote.diff,
        {
          kind: "automatic",
          repository: provenance.repository,
          policyVersion: provenance.policyVersion,
          prGeneration: provenance.prGeneration,
          runId: draft.runId!,
          draftId: draft.id,
          draftVersion: draft.version,
          headSha: draft.headSha,
          discussionRevision: state.check.revision,
        },
      );
      const submission: Submission = {
        id: id(),
        authority: preview.authority,
        previewId: preview.id,
        status: "submitting",
        payload: preview.payload,
        githubReviewId: null,
        url: null,
        error: null,
        createdAt: now(),
      };
      this.db.transaction(() => {
        if (
          this.automaticEligibility(this.requirePr(prId)).status !== "eligible"
        )
          throw new Error("Automatic authority was revoked before dispatch");
        this.db.saveRecovery(preview.id, {
          writer: inventory.writer,
          reviewIds: inventory.reviewIds,
          capturedAt: submission.createdAt,
        });
        this.db.claimAutomaticHead(prId, current.headSha, submission.id);
        this.db.createSubmission(submission, prId);
      });
      this.emit(prId);
      try {
        const result = await this.github.submitReview(current, preview.payload);
        this.db.updateSubmission({
          ...submission,
          status: "submitted",
          githubReviewId: result.githubReviewId,
          url: result.url,
        });
        this.reconcileSubmitted(prId);
      } catch {
        this.db.updateSubmission({
          ...submission,
          status: "uncertain",
          error:
            "Automatic write outcome is uncertain; exact complete reconciliation required, never retried",
        });
        this.pauseAutomatic(
          prId,
          "Automatic write outcome is uncertain; exact reconciliation required",
        );
      }
      if (
        preview.payload.comments.length &&
        this.db.getSubmission(submission.id)?.status === "submitted"
      ) {
        try {
          await this.captureAutomaticCommentIds(
            prId,
            this.db.getSubmission(submission.id)!,
          );
        } catch {
          if (!this.closed)
            this.pauseAutomatic(
              prId,
              "Confirmed write has unverified automated inline provenance; check needed",
            );
        }
      }
      this.emit(prId);
    } catch (error) {
      if (!this.closed)
        this.pauseAutomatic(
          prId,
          error instanceof Error
            ? error.message
            : "Automatic submission checks failed",
        );
    }
  }

  updateSettings(update: SettingsUpdate): AppState {
    const before = this.effectiveSnapshot();
    const repository = update.repository ?? this.db.getSettings().repository;
    this.db.updateSettings(
      repository ? update : { ...update, automation: automationOff },
    );
    this.afterPolicyChange(before);
    this.queue.schedule();
    return this.getState();
  }

  updateAutomation(
    prId: string,
    overrides: Partial<AutomationOverrides>,
  ): PullRequestDetail {
    const pr = this.requirePr(prId);
    const before = this.effectiveSnapshot();
    this.db.setPrAutomation(prId, { ...pr.automation, ...overrides });
    this.afterPolicyChange(before);
    return this.getDetail(prId);
  }

  private effectiveSnapshot(): Map<string, AutomationPolicy> {
    return new Map(
      this.db.listPrs().map((pr) => [pr.id, pr.effectiveAutomation]),
    );
  }

  private afterPolicyChange(before: Map<string, AutomationPolicy>): void {
    for (const pr of this.db.listPrs()) {
      const previous = before.get(pr.id) ?? automationOff;
      const next = pr.effectiveAutomation;
      if (previous.reviewNewCommits !== next.reviewNewCommits)
        this.db.setCommitHead(pr.id, null);
      if (previous.reviewRequests !== next.reviewRequests)
        this.db.setRequestsArmed(pr.id, false);
    }
    this.startPolling();
    if (this.pollingActive())
      void this.sync("scheduled").catch(() => undefined);
    this.emit();
  }

  private trackedPrs(repository: string): PullRequest[] {
    return this.db
      .listPrs()
      .filter((pr) => pr.repository === repository && inboxEligible(pr));
  }

  private pollScope(
    automation: AutomationPolicy,
    tracked: PullRequest[],
  ): PollScope | undefined {
    if (automation.pollRequests) return undefined;
    return {
      numbers: automation.pollCommits ? tracked.map((pr) => pr.number) : [],
      requestNumbers: [],
    };
  }

  pollingActive(): boolean {
    const settings = this.db.getSettings();
    return (
      !!settings.repository &&
      (settings.automation.pollCommits || settings.automation.pollRequests)
    );
  }

  async sync(mode: SyncMode = "manual"): Promise<void> {
    if (this.syncInFlight) return this.syncInFlight;
    const settings = this.db.getSettings();
    if (!settings.repository)
      throw new ServiceError(
        400,
        "repository_required",
        "configure a repository before syncing",
      );
    const tracked = this.trackedPrs(settings.repository);
    const scope =
      mode === "scheduled"
        ? this.pollScope(settings.automation, tracked)
        : undefined;
    if (scope && scope.numbers.length === 0) return;
    const operation: SyncOperation = {
      id: id(),
      repository: settings.repository,
      mode,
      status: "running",
      startedAt: now(),
      finishedAt: null,
      error: null,
    };
    this.syncOperation = operation;
    let failure: string | null = null;
    this.syncInFlight = this.performSync(settings, tracked, scope)
      .catch((error) => {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        operation.status = failure === null ? "completed" : "failed";
        operation.error = failure;
        operation.finishedAt = now();
        this.syncInFlight = null;
        this.emit();
      });
    this.emit();
    return this.syncInFlight;
  }

  private async performSync(
    settings: AppSettings,
    tracked: PullRequest[],
    scope: PollScope | undefined,
  ): Promise<void> {
    try {
      const result = await this.github.poll(
        settings.repository,
        tracked,
        scope,
      );
      this.healthState.github = health(
        "ready",
        this.config.demo
          ? "Deterministic demo adapter enabled"
          : `Authenticated as ${result.user}`,
      );
      this.healthState.githubUser = result.user;
      for (const remote of result.pullRequests) {
        const pr = this.observe(remote, {
          requestsKnown: true,
          automatic: true,
        });
        if (settings.automation.pollCommits)
          await this.recordFreshness(pr.id, false);
        await this.recordMergeReadiness(pr.id);
        if (automaticallyReviewed(this.requirePr(pr.id)))
          await this.scanHumanReview(pr.id);
      }
      for (const request of result.requests) this.observeRequest(request);
      for (const remote of result.pullRequests)
        this.armRequests(remote.pr.id, scope);
      if (!scope)
        for (const previous of tracked)
          if (!result.pullRequests.some((item) => item.pr.id === previous.id))
            this.db.clearPrRequest(previous.id);
      this.db.setSyncMeta({
        initialized: true,
        lastPollAt: now(),
        pollError: null,
      });
      this.emit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.healthState.github = health("error", message);
      this.db.setSyncMeta({ lastPollAt: now(), pollError: message });
      this.emit();
      throw error;
    }
  }

  async manualReview(prId: string): Promise<PullRequestDetail> {
    const pr = this.requirePr(prId);
    let remote: RemotePullRequest;
    const startedAt = now();
    try {
      remote = await this.refreshRemote(pr, false);
    } catch (error) {
      throw new ServiceError(
        502,
        "refresh_failed",
        `could not refresh the pull request before reviewing: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (remote.pr.state !== "OPEN") {
      this.emit(prId);
      throw new ServiceError(
        409,
        "pr_closed",
        "pull request is no longer open, so no review was started",
      );
    }
    this.enqueueReview(prId, "manual", null, {
      id: "sync",
      status: "completed",
      startedAt,
      finishedAt: now(),
      detail: `head ${remote.pr.headSha.slice(0, 7)}`,
    });
    return this.getDetail(prId);
  }

  reviewBaseline(prId: string): string | null {
    return this.db.latestDraft(prId)?.headSha ?? null;
  }

  private draftStatus(prId: string, headSha: string): PullRequest["status"] {
    const latest = this.db.latestDraft(prId);
    if (!latest) return "unreviewed";
    return latest.headSha === headSha ? "ready" : "outdated";
  }

  private syncDraftState(prId: string): void {
    const latest = this.db.latestDraft(prId);
    if (!latest) return;
    const tally = counts(latest.findings);
    this.db.updatePrCounts(prId, tally.blocking, tally.nonBlocking);
    this.db.setPrStatus(
      prId,
      this.draftStatus(prId, this.requirePr(prId).headSha),
    );
  }

  private submissionSettled(pr: PullRequest): boolean {
    const latest = this.db.latestDraft(pr.id);
    if (!latest || latest.headSha !== pr.headSha) return false;
    const submissions = this.db.listSubmissions(pr.id);
    const index = submissions.findIndex((submission) => {
      if (submission.status !== "submitted") return false;
      const preview = this.db.getPreview(submission.previewId);
      return (
        preview?.draftId === latest.id &&
        preview.draftVersion === latest.version &&
        submission.payload.commit_id === pr.headSha
      );
    });
    if (index === -1) return false;
    const settled = submissions[index];
    if (
      submissions
        .slice(0, index)
        .some((submission) => submission.status !== "submitted")
    )
      return false;
    const requestedAt = this.db.latestRequestEventAt(pr.id);
    return (
      requestedAt === null ||
      new Date(requestedAt).getTime() <= new Date(settled.createdAt).getTime()
    );
  }

  private reconcileSubmitted(prId: string): void {
    const pr = this.requirePr(prId);
    if (pr.status === "queued" || pr.status === "reviewing") return;
    if (this.submissionSettled(pr)) this.db.setPrStatus(prId, "submitted");
    else if (pr.status === "submitted")
      this.db.setPrStatus(prId, this.draftStatus(prId, pr.headSha));
  }

  private reconcileDraftStates(): void {
    for (const pr of this.db.listPrs()) {
      const latest = this.db.latestDraft(pr.id);
      if (
        pr.status === "reviewing" &&
        this.db
          .listRuns(pr.id)
          .some((run) => run.status === "interrupted" && run.cancellation) &&
        !this.db.listJobs("running", pr.id).length
      )
        this.restoreReviewState(pr.id);
      if (draftDerivedStatuses.has(pr.status)) {
        const status = this.draftStatus(pr.id, pr.headSha);
        if (status !== pr.status) this.db.setPrStatus(pr.id, status);
      }
      if (pr.status === "submitted") this.reconcileSubmitted(pr.id);
      if (!latest || !this.db.migratedPrIds.has(pr.id)) continue;
      const tally = counts(latest.findings);
      this.db.updatePrCounts(pr.id, tally.blocking, tally.nonBlocking);
      if (!pr.lastReviewedAt || pr.lastReviewedAt < latest.createdAt)
        this.db.setPrReviewTimestamp(pr.id, latest.createdAt);
    }
    this.db.migratedPrIds.clear();
  }

  async checkFreshness(prId: string): Promise<PullRequestDetail> {
    const pr = this.requirePr(prId);
    try {
      await this.refreshRemote(pr);
    } catch (error) {
      const baseline = this.reviewBaseline(prId);
      if (baseline)
        this.db.setFreshness(
          prId,
          failedFreshness(
            this.db.getFreshness(prId),
            baseline,
            pr.headSha,
            error,
          ),
        );
      this.emit(prId);
      return this.getDetail(prId);
    }
    await this.recordFreshness(prId, true);
    this.emit(prId);
    return this.getDetail(prId);
  }

  private async recordFreshness(prId: string, force: boolean): Promise<void> {
    const pr = this.requirePr(prId);
    const baseline = this.reviewBaseline(prId);
    const previous = this.db.getFreshness(prId);
    const head = pr.headSha;
    const checkedAt = now();
    if (!baseline) {
      this.db.setFreshness(prId, null);
      return;
    }
    if (
      !force &&
      previous &&
      previous.baseline === baseline &&
      previous.head === head &&
      !previous.error
    )
      return;
    let freshness: Freshness;
    if (head === baseline)
      freshness = {
        baseline,
        head,
        status: "fresh",
        commits: [],
        truncated: false,
        checkedAt,
        error: null,
      };
    else
      try {
        const comparison = await this.github.compareCommits(
          pr.repository,
          baseline,
          head,
        );
        freshness = {
          baseline,
          head,
          status:
            comparison.status === "ahead"
              ? "stale"
              : comparison.status === "identical"
                ? "fresh"
                : "rewritten",
          commits: comparison.commits,
          truncated: comparison.truncated,
          checkedAt,
          error: null,
        };
      } catch (error) {
        freshness =
          error instanceof GithubRequestError && error.httpStatus === 404
            ? {
                baseline,
                head,
                status: "unavailable",
                commits: [],
                truncated: false,
                checkedAt,
                error: null,
              }
            : failedFreshness(previous, baseline, head, error);
      }
    this.db.setFreshness(prId, freshness);
  }

  updateDraft(prId: string, update: DraftUpdate): PullRequestDetail {
    const current = this.requireDraft(prId, update.draftId);
    if (update.version !== current.version)
      throw new ServiceError(
        409,
        "draft_conflict",
        "draft changed since it was loaded",
      );
    const stored = new Map(
      current.findings.map((finding) => [finding.id, finding.evidence]),
    );
    const findings = update.findings.map((finding, index) => {
      const validated = validateFinding(finding, index);
      return {
        ...validated,
        evidence:
          stored.get(validated.id) ??
          this.questionEvidence(prId, current, validated.questionId),
      };
    });
    if (new Set(findings.map((finding) => finding.id)).size !== findings.length)
      throw new ServiceError(
        400,
        "invalid_finding",
        "finding ids must be unique",
      );
    this.editIntent(prId, { draftId: current.id, version: update.version });
    const draft: ReviewDraft = {
      ...current,
      autoSubmission: {
        provenance: current.autoSubmission?.provenance ?? null,
        manualHold: { reason: "saved_edit", at: now() },
      },
      version: current.version + 1,
      body: update.body,
      findings,
      verdict: update.verdict,
      updatedAt: now(),
    };
    this.db.updateDraft(draft);
    if (this.db.latestDraft(prId)?.id === draft.id) this.syncDraftState(prId);
    this.emit(prId);
    return this.getDetail(prId);
  }

  revise(prId: string, request: RevisionRequest): PullRequestDetail {
    this.requirePr(prId);
    const draft = this.requireDraft(prId, request.draftId);
    if (draft.version !== request.draftVersion)
      throw new ServiceError(
        409,
        "draft_conflict",
        "draft changed since it was loaded",
      );
    if (!request.instructions.trim() || request.instructions.length > 10_000)
      throw new ServiceError(
        400,
        "invalid_instructions",
        "revision instructions must be between 1 and 10000 characters",
      );
    const findingIds = request.findingIds ?? [];
    if (
      findingIds.some(
        (findingId) =>
          !draft.findings.some((finding) => finding.id === findingId),
      )
    )
      throw new ServiceError(
        400,
        "invalid_finding",
        "revision includes an unknown finding id",
      );
    const payload = JSON.stringify({
      draftId: draft.id,
      draftVersion: draft.version,
      instructions: request.instructions,
      findingIds,
    });
    const duplicate = this.db
      .listJobs("queued")
      .concat(this.db.listJobs("running"))
      .find(
        (job) =>
          job.kind === "revision" &&
          job.pr_id === prId &&
          job.payload_json === payload,
      );
    if (!duplicate) {
      const source = draft.runId ? this.db.getRun(draft.runId) : null;
      const snapshot = draft.runId ? this.db.getRunSnapshot(draft.runId) : null;
      if (!source || !snapshot)
        throw new ServiceError(
          409,
          "snapshot_missing",
          "the draft's immutable review snapshot is unavailable",
        );
      const run: ReviewRun = {
        cancellation: null,
        id: id(),
        prId,
        kind: "revision",
        trigger: "revision",
        requestEventId: null,
        status: "queued",
        headSha: source.headSha,
        baseSha: source.baseSha,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        error: null,
        log: "",
        reviewer: this.captureReviewer(),
        integrationSnapshot: integrationSnapshot(this.getIntegrations()),
        result: null,
        progress: null,
      };
      this.db.createRun(run);
      this.db.createRunSnapshot(run.id, snapshot);
      this.db.createJob({
        id: id(),
        kind: "revision",
        pr_id: prId,
        run_id: run.id,
        payload_json: payload,
        status: "queued",
        created_at: run.createdAt,
        started_at: null,
        finished_at: null,
        error: null,
      });
      this.db.setPrStatus(prId, "queued");
      this.queue.schedule();
      this.emit(prId);
    }
    return this.getDetail(prId);
  }

  applyProposal(
    prId: string,
    proposalId: string,
    expectedVersion: number,
  ): PullRequestDetail {
    this.requirePr(prId);
    const proposal = this.db.getProposal(proposalId);
    if (
      !proposal ||
      !this.db.listProposals(prId).some((item) => item.id === proposalId)
    )
      throw new ServiceError(404, "not_found", "revision proposal not found");
    if (proposal.status !== "pending")
      throw new ServiceError(
        409,
        "proposal_conflict",
        "revision proposal is no longer pending",
      );
    const draft = this.requireDraft(prId, proposal.draftId);
    if (
      expectedVersion !== draft.version ||
      proposal.sourceDraftVersion !== draft.version
    )
      throw new ServiceError(
        409,
        "draft_conflict",
        "draft changed since this proposal was created",
      );
    const run = this.db.getRun(proposal.runId);
    if (!run || run.headSha !== draft.headSha)
      throw new ServiceError(
        409,
        "stale_proposal",
        "revision proposal is for a different commit than its draft",
      );
    const result = validateReviewResult(proposal.result);
    const next: ReviewDraft = {
      ...draft,
      version: draft.version + 1,
      overview: result.overview,
      body: result.body,
      findings: result.findings,
      verdict: result.verdict,
      updatedAt: now(),
    };
    this.editIntent(prId, { draftId: draft.id, version: draft.version });
    next.autoSubmission = {
      provenance: draft.autoSubmission?.provenance ?? null,
      manualHold: { reason: "revision", at: now() },
    };
    this.db.updateDraft(next);
    this.db.setProposalStatus(proposalId, "accepted");
    if (this.db.latestDraft(prId)?.id === next.id) this.syncDraftState(prId);
    this.emit(prId);
    return this.getDetail(prId);
  }

  rejectProposal(prId: string, proposalId: string): PullRequestDetail {
    this.requirePr(prId);
    const proposal = this.db.getProposal(proposalId);
    if (
      !proposal ||
      !this.db.listProposals(prId).some((item) => item.id === proposalId)
    )
      throw new ServiceError(404, "not_found", "revision proposal not found");
    if (proposal.status !== "pending")
      throw new ServiceError(
        409,
        "proposal_conflict",
        "revision proposal is no longer pending",
      );
    this.db.setProposalStatus(proposalId, "rejected");
    this.emit(prId);
    return this.getDetail(prId);
  }

  async preview(
    prId: string,
    draftId: string,
    draftVersion: number,
  ): Promise<SubmissionPreview> {
    const pr = this.requirePr(prId);
    const draft = this.requireDraft(prId, draftId);
    if (draft.version !== draftVersion)
      throw new ServiceError(
        409,
        "draft_conflict",
        "draft changed since it was loaded",
      );
    const remote = await this.refreshRemote(pr);
    if (remote.pr.state !== "OPEN")
      throw new ServiceError(
        409,
        "stale_draft",
        "pull request is no longer open",
      );
    const current = this.requirePr(prId);
    if (draft.headSha !== current.headSha)
      throw new ServiceError(
        409,
        "stale_draft",
        "draft is for an outdated commit",
      );
    const latest = this.requireDraft(prId, draftId);
    if (latest.version !== draftVersion)
      throw new ServiceError(
        409,
        "draft_conflict",
        "draft changed during preview refresh",
      );
    return this.createPreview(current, latest, remote.diff);
  }

  private createPreview(
    current: PullRequest,
    draft: ReviewDraft,
    diff: string,
    authority: SubmissionPreview["authority"] = { kind: "manual" },
  ): SubmissionPreview {
    const anchors = diffAnchors(parseDiff(diff));
    const comments: ReviewPayload["comments"] = [];
    const bodyFindings: Finding[] = [];
    for (const finding of draft.findings.filter((item) => item.included)) {
      if (anchorsInline(anchors, finding))
        comments.push({
          path: finding.path!,
          line: finding.line!,
          side: finding.side,
          ...(finding.startLine === null
            ? {}
            : { start_line: finding.startLine, start_side: finding.side }),
          body: findingText(finding),
        });
      else bodyFindings.push(finding);
    }
    const payload: ReviewPayload = {
      event: draft.verdict,
      body: reviewBody(draft.body, bodyFindings),
      commit_id: current.headSha,
      comments,
    };
    const result: SubmissionPreview = {
      id: id(),
      prId: current.id,
      draftId: draft.id,
      draftVersion: draft.version,
      authority,
      payload,
      createdAt: now(),
    };
    this.db.createPreview(result);
    this.emit(current.id);
    return result;
  }

  async submit(prId: string, previewId: string): Promise<PullRequestDetail> {
    const pr = this.requirePr(prId);
    const preview = this.db.getPreview(previewId);
    if (!preview || preview.prId !== prId)
      throw new ServiceError(404, "not_found", "submission preview not found");
    if (preview.authority?.kind === "automatic")
      throw new ServiceError(
        409,
        "automatic_preview",
        "Automatic attempts are reconciled through Check, not manual submit",
      );
    const existing = this.db.getSubmissionForPreview(previewId);
    if (existing?.status === "submitted") return this.getDetail(prId);
    if (existing?.status === "submitting")
      throw new ServiceError(
        409,
        "submission_in_flight",
        "submission is already in flight",
      );
    if (existing?.status === "uncertain") {
      const recovery = this.db.getRecovery(previewId);
      const reconciled =
        recovery && this.github.reviewInventory
          ? exactReview(
              await this.github.reviewInventory({
                ...pr,
                headSha: preview.payload.commit_id,
              }),
              recovery,
              preview.payload,
            )
          : null;
      if (reconciled) {
        this.db.updateSubmission({
          ...existing,
          status: "submitted",
          githubReviewId: reconciled.id,
          url: reconciled.url,
          error: null,
        });
        this.reconcileSubmitted(prId);
        this.emit(prId);
        return this.getDetail(prId);
      }
      throw new ServiceError(
        409,
        "submission_ambiguous",
        "GitHub write outcome is uncertain; complete baseline-bound exact review evidence is unavailable or does not uniquely match, so it was not retried",
      );
    }
    const draft = this.requireDraft(prId, preview.draftId);
    if (draft.version !== preview.draftVersion)
      throw new ServiceError(
        409,
        "draft_conflict",
        "preview does not match the current draft",
      );
    const remote = await this.refreshRemote(pr);
    const current = this.requirePr(prId);
    if (
      remote.pr.state !== "OPEN" ||
      draft.headSha !== current.headSha ||
      preview.payload.commit_id !== current.headSha
    )
      throw new ServiceError(
        409,
        "stale_draft",
        "preview is outdated and must be regenerated",
      );
    const inventory = this.github.reviewInventory
      ? await this.github.reviewInventory(current)
      : null;
    const latest = this.requireDraft(prId, preview.draftId);
    if (latest.version !== preview.draftVersion)
      throw new ServiceError(
        409,
        "draft_conflict",
        "Draft changed during submission checks",
      );
    if (
      this.requirePr(prId).state !== "OPEN" ||
      this.requirePr(prId).headSha !== preview.payload.commit_id
    )
      throw new ServiceError(
        409,
        "stale_draft",
        "PR state or head changed during submission checks",
      );
    if (this.db.getSubmissionForPreview(previewId)?.status === "submitted")
      return this.getDetail(prId);
    if (
      this.db
        .listSubmissions(prId)
        .some(
          (item) => item.status === "submitting" || item.status === "uncertain",
        )
    )
      throw new ServiceError(
        409,
        "submission_in_flight",
        "Another submission is in flight or uncertain",
      );
    const submission: Submission = {
      authority: { kind: "manual" },
      id: id(),
      previewId,
      status: "submitting",
      payload: preview.payload,
      githubReviewId: null,
      url: null,
      error: null,
      createdAt: now(),
    };
    this.db.transaction(() => {
      if (inventory)
        this.db.saveRecovery(previewId, {
          writer: inventory.writer,
          reviewIds: inventory.reviewIds,
          capturedAt: now(),
        });
      this.db.createSubmission(submission, prId);
    });
    this.emit(prId);
    try {
      const result = await this.github.submitReview(current, preview.payload);
      this.db.updateSubmission({
        ...submission,
        status: "submitted",
        githubReviewId: result.githubReviewId,
        url: result.url,
        error: null,
      });
      this.reconcileSubmitted(prId);
      this.db.setPrReviewTimestamp(prId, now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateSubmission({
        ...submission,
        status: "uncertain",
        error: message,
      });
      this.reconcileSubmitted(prId);
      this.emit(prId);
      throw new ServiceError(
        503,
        "submission_ambiguous",
        `Review write outcome is uncertain: ${message}`,
      );
    }
    this.emit(prId);
    return this.getDetail(prId);
  }

  createManualDraft(prId: string): PullRequestDetail {
    const pr = this.requirePr(prId);
    const existing = this.db
      .listDrafts(prId)
      .find((draft) => draft.runId === null && draft.headSha === pr.headSha);
    if (!existing) {
      const createdAt = now();
      this.db.createDraft(
        {
          id: id(),
          runId: null,
          headSha: pr.headSha,
          version: 1,
          overview: "",
          body: "",
          findings: [],
          verdict: "COMMENT",
          createdAt,
          updatedAt: createdAt,
        },
        prId,
      );
      this.syncDraftState(prId);
      this.emit(prId);
    }
    return this.getDetail(prId);
  }

  private questionEvidence(
    prId: string,
    draft: ReviewDraft,
    questionId: string | null,
  ): string {
    if (!questionId) return "";
    const question = this.db.getQuestion(questionId);
    if (
      !question ||
      question.prId !== prId ||
      question.status !== "completed" ||
      question.answer?.kind !== "comment" ||
      question.headSha !== draft.headSha
    )
      return "";
    return question.answer.evidence;
  }

  ask(prId: string, request: QuestionRequest): PullRequestDetail {
    const pr = this.requirePr(prId);
    if (!questionModes.has(request.mode))
      throw new ServiceError(400, "invalid_question", "unknown question mode");
    const text = (request.question ?? "").trim();
    if (text.length > 4_000)
      throw new ServiceError(
        400,
        "invalid_question",
        "question must be at most 4000 characters",
      );
    if (
      request.range.headSha !== pr.headSha ||
      request.range.baseSha !== pr.baseSha
    )
      throw new ServiceError(
        409,
        "head_mismatch",
        `the selection was made on ${request.range.headSha.slice(0, 7)} but the pull request is now at ${pr.headSha.slice(0, 7)}; reselect the code on the current diff`,
      );
    const stored = this.db.getDiff(prId)!;
    const files = parseDiff(stored.diff);
    const resolved = resolveSelection(files, request.range);
    if (!resolved)
      throw new ServiceError(
        400,
        "invalid_selection",
        "the selected lines are not in the saved diff for this commit",
      );
    const parent = request.parentId
      ? this.db.getQuestion(request.parentId)
      : null;
    if (request.parentId && (!parent || parent.prId !== prId))
      throw new ServiceError(404, "not_found", "parent question not found");
    if (parent && parent.headSha !== pr.headSha)
      throw new ServiceError(
        409,
        "head_mismatch",
        "the earlier question was about a different commit; ask a new question instead",
      );
    if (request.draftId && !this.db.getDraft(prId, request.draftId))
      throw new ServiceError(
        409,
        "draft_required",
        "the named review draft does not exist for this pull request",
      );
    if (this.db.listQuestionsByStatus("queued").length >= maxQueuedQuestions)
      throw new ServiceError(
        429,
        "too_many_questions",
        "too many questions are waiting; cancel one or wait for an answer",
      );
    const fileDiff = stored.diff
      .split(/^(?=diff --git )/m)
      .find((chunk) =>
        parseDiff(chunk).some((file) => file.path === resolved.file.path),
      );
    if (parent) this.requireQuestionExecution(parent);
    const question: Question = {
      id: id(),
      prId,
      draftId: request.draftId ?? null,
      parentId: parent?.id ?? null,
      mode: request.mode,
      status: "queued",
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      selection: resolved.selection,
      question: text,
      answer: null,
      error: null,
      integrationSnapshot: parent
        ? (parent.integrationSnapshot ?? { boundary: "none", connections: [] })
        : integrationSnapshot(this.getIntegrations()),
      reviewerSnapshot: parent
        ? parent.reviewerSnapshot
        : this.captureReviewer(),
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
    };
    this.db.createQuestion(question, fileDiff ?? "", stored.truncated);
    this.questionLane.schedule();
    this.emit(prId);
    return this.getDetail(prId);
  }

  cancelQuestion(prId: string, questionId: string): PullRequestDetail {
    const question = this.requireQuestion(prId, questionId);
    if (question.status === "queued")
      this.db.updateQuestion(questionId, {
        status: "cancelled",
        finishedAt: now(),
        error: "Cancelled before it started",
      });
    else if (question.status === "running")
      this.questionAborts
        .get(questionId)
        ?.abort(new Error("Cancelled by the reviewer"));
    else
      throw new ServiceError(
        409,
        "question_finished",
        "the question is no longer running",
      );
    this.emit(prId);
    return this.getDetail(prId);
  }

  retryQuestion(prId: string, questionId: string): PullRequestDetail {
    const question = this.requireQuestion(prId, questionId);
    if (question.status === "queued" || question.status === "running")
      throw new ServiceError(
        409,
        "question_active",
        "the question is still in progress",
      );
    if (this.db.listQuestionsByStatus("queued").length >= maxQueuedQuestions)
      throw new ServiceError(
        429,
        "too_many_questions",
        "too many questions are waiting; cancel one or wait for an answer",
      );
    this.requireQuestionExecution(question);
    this.db.updateQuestion(questionId, {
      status: "queued",
      answer: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    this.questionLane.schedule();
    this.emit(prId);
    return this.getDetail(prId);
  }

  private requireQuestionExecution(question: Question): ReviewerSettings {
    try {
      requireSupportedExecution(question.reviewerSnapshot);
      return question.reviewerSnapshot;
    } catch {
      throw new ServiceError(
        409,
        "execution_incompatible",
        executionUpgradeAction,
      );
    }
  }

  nextQueuedQuestion(): Question | null {
    if (this.closed) return null;
    return this.db.listQuestionsByStatus("queued")[0] ?? null;
  }

  async processQuestion(question: Question): Promise<void> {
    const operation = this.processQuestionInternal(question);
    this.activeJobs.add(operation);
    try {
      await operation;
    } finally {
      this.activeJobs.delete(operation);
    }
  }

  private questionHistory(question: Question): QuestionTurn[] {
    const turns: QuestionTurn[] = [];
    let current = question.parentId
      ? this.db.getQuestion(question.parentId)
      : null;
    while (current && turns.length < 10) {
      turns.unshift({
        mode: current.mode,
        question: current.question,
        answer: current.answer,
      });
      current = current.parentId ? this.db.getQuestion(current.parentId) : null;
    }
    return turns;
  }

  private async processQuestionInternal(question: Question): Promise<void> {
    const pr = this.db.getPr(question.prId);
    const context = this.db.getQuestionContext(question.id);
    if (!pr || !context) {
      this.db.updateQuestion(question.id, {
        status: "failed",
        finishedAt: now(),
        error: "question references missing data",
      });
      return;
    }
    const controller = new AbortController();
    this.questionAborts.set(question.id, controller);
    this.db.updateQuestion(question.id, {
      status: "running",
      startedAt: now(),
      error: null,
    });
    this.emit(pr.id);
    try {
      const draft = question.draftId
        ? this.db.getDraft(pr.id, question.draftId)
        : null;
      const input: QuestionInput = {
        id: question.id,
        repository: pr.repository,
        number: pr.number,
        baseSha: question.baseSha,
        headSha: question.headSha,
        mode: question.mode,
        question: question.question,
        selection: question.selection,
        fileDiff: context.fileDiff,
        diffTruncated: context.diffTruncated,
        draft:
          draft && draft.headSha === question.headSha
            ? {
                overview: draft.overview,
                body: draft.body,
                findings: draft.findings,
              }
            : null,
        history: this.questionHistory(question),
        integrationSnapshot: question.integrationSnapshot,
      };
      const output = await this.questioner.ask(
        input,
        this.requireQuestionExecution(question),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      this.db.updateQuestion(question.id, {
        status: "completed",
        finishedAt: now(),
        error: null,
        answer: output.answer,
        log: clampText(output.log, 100_000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = this.closed
        ? "interrupted"
        : controller.signal.aborted
          ? "cancelled"
          : "failed";
      this.db.updateQuestion(question.id, {
        status,
        finishedAt: now(),
        error:
          status === "interrupted"
            ? "Backend stopped while the question was running"
            : status === "cancelled"
              ? "Cancelled by the reviewer"
              : message,
      });
    } finally {
      this.questionAborts.delete(question.id);
    }
    this.emit(pr.id);
  }

  private requireQuestion(prId: string, questionId: string): Question {
    this.requirePr(prId);
    const question = this.db.getQuestion(questionId);
    if (!question || question.prId !== prId)
      throw new ServiceError(404, "not_found", "question not found");
    return question;
  }

  private reviewJobs(prId: string): ReviewJob[] {
    const jobs = this.db.listJobs(undefined, prId);
    const stopped = jobs.findLast(
      (job) =>
        job.status === "unqueued" || !!this.db.getRun(job.run_id)?.cancellation,
    );
    return jobs.flatMap((job) => {
      if (
        job.status !== "queued" &&
        job.status !== "running" &&
        job !== stopped
      )
        return [];
      const run = this.db.getRun(job.run_id);
      return run
        ? [
            {
              jobId: job.id,
              runId: run.id,
              headSha: run.headSha,
              kind: run.kind,
              status: job.status,
              cancellation: run.cancellation ?? null,
            },
          ]
        : [];
    });
  }

  reviewJobAction(
    prId: string,
    jobId: string,
    action: "unqueue" | "cancel",
    request: ReviewJobAction,
  ): PullRequestDetail {
    this.requirePr(prId);
    const job = this.db.getJob(jobId);
    const run = job ? this.db.getRun(job.run_id) : null;
    if (
      !job ||
      job.pr_id !== prId ||
      !run ||
      run.id !== request.runId ||
      run.headSha !== request.headSha
    )
      throw new ServiceError(
        409,
        "review_job_conflict",
        "The observed review job identity changed; reload its actual state",
      );
    const expected = action === "unqueue" ? "queued" : "running";
    if (job.status !== expected || run.status !== expected || run.cancellation)
      throw new ServiceError(
        409,
        "review_job_conflict",
        `This job is ${job.status}${run.cancellation ? `; shutdown ${run.cancellation.status}` : ""}, not an actionable ${expected} job. Reload its actual state`,
      );
    const controller = this.reviewAborts.get(run.id);
    if (
      action === "cancel" &&
      request.confirmation !== cancelReviewConfirmation
    )
      throw new ServiceError(
        400,
        "review_confirmation_required",
        "Explicit owned-review cancellation confirmation is required",
      );
    if (action === "cancel" && !controller)
      throw new ServiceError(
        409,
        "review_job_conflict",
        "Running job ownership is unavailable; shutdown cannot be confirmed",
      );
    this.db.transaction(() => {
      const publication = this.db.getPublicationState(prId);
      this.db.savePublicationState(prId, {
        ...publication,
        reenableRequired: true,
        generation: publication.generation + 1,
        version: publication.version + 1,
      });
      if (action === "unqueue") {
        this.db.updateJob(job.id, {
          status: "unqueued",
          finished_at: now(),
          error: null,
        });
        this.db.updateRun(run.id, {
          status: "unqueued",
          finishedAt: now(),
          error: null,
        });
        this.restoreReviewState(prId);
      } else {
        this.db.updateRun(run.id, {
          cancellation: {
            status: "pending",
            requestedAt: now(),
            finishedAt: null,
            message:
              "Cancellation requested; waiting for owned execution shutdown. Prior effects are not undone",
          },
        });
      }
    });
    if (action === "cancel")
      controller!.abort(new Error("Cancelled by the reviewer"));
    this.queue.schedule();
    this.emit(prId);
    return this.getDetail(prId);
  }

  private restoreReviewState(prId: string): void {
    const jobs = this.reviewJobs(prId).filter(
      (job) => job.status === "running" || job.status === "queued",
    );
    this.db.setPrStatus(
      prId,
      jobs.some((job) => job.status === "running")
        ? "reviewing"
        : jobs.length
          ? "queued"
          : this.draftStatus(prId, this.requirePr(prId).headSha),
    );
    this.reconcileSubmitted(prId);
  }

  maxConcurrentReviews(): number {
    return this.db.getSettings().maxConcurrentReviews;
  }

  nextQueuedJob(busyPrIds: ReadonlySet<string>): JobRow | null {
    if (this.closed) return null;
    const running = this.db.listJobs("running");
    if (running.length >= this.maxConcurrentReviews()) return null;
    return (
      this.db
        .listJobs("queued")
        .find(
          (job) =>
            !busyPrIds.has(job.pr_id) &&
            !running.some((active) => active.pr_id === job.pr_id),
        ) ?? null
    );
  }

  async processJob(job: JobRow): Promise<void> {
    const operation = this.processJobInternal(job);
    this.activeJobs.add(operation);
    try {
      await operation;
    } finally {
      this.activeJobs.delete(operation);
    }
  }

  private async processJobInternal(job: JobRow): Promise<void> {
    if (this.closed || this.db.getJob(job.id)?.status !== "queued") return;
    const run = this.db.getRun(job.run_id);
    const pr = this.db.getPr(job.pr_id);
    if (!run || !pr) {
      this.db.updateJob(job.id, {
        status: "failed",
        finished_at: now(),
        error: "job references missing data",
      });
      return;
    }
    this.db.updateJob(job.id, {
      status: "running",
      started_at: now(),
      error: null,
    });
    this.db.updateRun(run.id, {
      status: "running",
      startedAt: now(),
      error: null,
    });
    this.db.setPrStatus(pr.id, "reviewing");
    this.emit(pr.id);
    const controller = new AbortController();
    this.reviewAborts.set(run.id, controller);
    const tracker = new RunProgressTracker(
      (progress) => {
        if (this.db.getRun(run.id)?.status !== "running") return;
        this.db.setRunProgress(run.id, progress);
        this.emit(pr.id);
      },
      750,
      run.progress ?? emptyProgress(),
    );
    try {
      const payload = JSON.parse(job.payload_json) as {
        draftId?: string;
        draftVersion?: number;
        instructions?: string;
        findingIds?: string[];
      };
      const snapshot = this.db.getRunSnapshot(run.id);
      if (
        !snapshot ||
        snapshot.pr.headSha !== run.headSha ||
        snapshot.pr.baseSha !== run.baseSha
      )
        throw new ServiceError(
          409,
          "snapshot_missing",
          "immutable review snapshot is unavailable",
        );
      const draft =
        job.kind === "revision"
          ? this.db.getDraft(pr.id, payload.draftId ?? "")
          : null;
      if (
        job.kind === "revision" &&
        (!draft || draft.version !== payload.draftVersion)
      )
        throw new ServiceError(
          409,
          "draft_conflict",
          "revision source draft changed before execution",
        );
      if (snapshot.discussion === undefined) {
        snapshot.discussion = await this.captureDiscussion(snapshot.pr);
        controller.signal.throwIfAborted();
        this.db.captureRunDiscussion(run.id, snapshot.discussion);
      }
      const input: ReviewerInput = {
        discussion: snapshot.discussion,
        pr: snapshot.pr,
        diff: snapshot.diff,
        draft: draft
          ? {
              overview: draft.overview,
              body: draft.body,
              findings: draft.findings,
              verdict: draft.verdict,
            }
          : null,
        instructions: payload.instructions,
        findingIds: payload.findingIds,
        integrationSnapshot: run.integrationSnapshot,
      };
      requireSupportedExecution(run.reviewer);
      const output = await this.reviewer.run(
        input,
        run.reviewer,
        run.id,
        controller.signal,
        tracker,
      );
      controller.signal.throwIfAborted();
      tracker.phase("finalize", "running");
      const result = validateReviewResult(output.result);
      const extension = bindHumanReviewRequest(
        output.result.humanReviewRequest,
        snapshot.discussion,
      );
      result.humanReviewRequest = extension.observation;
      this.recordHumanReview(
        run,
        result,
        snapshot.discussion,
        extension.diagnostics,
      );
      tracker.phase(
        "finalize",
        "completed",
        job.kind === "review" ? "draft created" : "proposal created",
      );
      tracker.close();
      this.db.updateRun(run.id, {
        status: "completed",
        finishedAt: now(),
        error: null,
        log: clampText(output.log, 200_000),
        result,
        progress: tracker.progress,
      });
      if (job.kind === "review") {
        const finishedAt = now();
        this.db.createDraft(
          {
            id: id(),
            runId: run.id,
            autoSubmission: {
              provenance: run.autoSubmission ?? null,
              manualHold: null,
            },
            headSha: run.headSha,
            version: 1,
            overview: result.overview,
            body: result.body,
            findings: result.findings,
            verdict: result.verdict,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          },
          pr.id,
        );
        this.db.setPrReviewTimestamp(pr.id, finishedAt);
      } else {
        const proposal: RevisionProposal = {
          id: id(),
          runId: run.id,
          draftId: draft!.id,
          sourceDraftVersion: draft!.version,
          instructions: payload.instructions ?? "",
          status: "pending",
          result,
          createdAt: now(),
        };
        this.db.createProposal(proposal, pr.id);
      }
      this.db.updateJob(job.id, {
        status: "completed",
        finished_at: now(),
        error: null,
      });
      this.syncDraftState(pr.id);
      await this.recordFreshness(pr.id, false);
      if (job.kind === "review" && run.autoSubmission)
        await this.automaticSubmission(pr.id);
    } catch (error) {
      if (this.db.getRun(run.id)?.status === "completed") return;
      const message = error instanceof Error ? error.message : String(error);
      const cancellation = this.db.getRun(run.id)?.cancellation;
      const confirmed = !!cancellation && error === controller.signal.reason;
      const interrupted = this.closed;
      const finalMessage = cancellation
        ? confirmed
          ? "Owned review shutdown confirmed. Prior native effects and dispatched publications are not undone"
          : `Shutdown unconfirmed: ${message}. This job retains its slot; prior effects are not undone`
        : interrupted
          ? "Backend stopped while review was running"
          : message;
      const status = cancellation
        ? confirmed
          ? "cancelled"
          : "running"
        : interrupted
          ? "interrupted"
          : "failed";
      tracker.stopEntries(
        interrupted || cancellation ? "interrupted" : "failed",
        finalMessage,
      );
      if (interrupted || cancellation)
        tracker.progress.phases.forEach((phase) => {
          if (phase.status === "running") {
            phase.status = "interrupted";
            phase.finishedAt = now();
          }
        });
      else
        tracker.failRunning(
          run.reviewer.skillExecution?.version === 3
            ? "Isolated harness execution failed; see entry evidence and run error"
            : finalMessage,
        );
      tracker.close();
      this.db.updateRun(run.id, {
        status,
        finishedAt: status === "running" ? null : now(),
        ...(cancellation
          ? {
              cancellation: {
                ...cancellation,
                status: confirmed
                  ? ("confirmed" as const)
                  : ("unconfirmed" as const),
                finishedAt: now(),
                message: finalMessage,
              },
            }
          : {}),
        error: finalMessage,
        log: clampText(finalMessage, 200_000),
        progress: tracker.progress,
      });
      this.db.updateJob(job.id, {
        status,
        finished_at: status === "running" ? null : now(),
        error: finalMessage,
      });
      if (cancellation) this.restoreReviewState(pr.id);
      else if (!interrupted) this.db.setPrStatus(pr.id, "failed");
    } finally {
      this.reviewAborts.delete(run.id);
    }
    this.emit(pr.id);
  }

  private enqueueReview(
    prId: string,
    trigger: ReviewRun["trigger"],
    requestEventId: string | null,
    preflight: RunPhase | null = null,
  ): void {
    const pr = this.requirePr(prId);
    if (
      trigger !== "manual" &&
      this.db
        .listRuns(prId)
        .some(
          (run) =>
            run.headSha === pr.headSha &&
            (run.status === "unqueued" || !!run.cancellation),
        )
    )
      return;
    const pending = this.db
      .listJobs()
      .find(
        (job) =>
          (job.status === "queued" || job.status === "running") &&
          job.kind === "review" &&
          job.pr_id === prId &&
          this.db.getRun(job.run_id)?.headSha === pr.headSha,
      );
    if (pending) return;
    const diff = this.db.getDiff(prId)!;
    const run: ReviewRun = {
      cancellation: null,
      id: id(),
      prId,
      kind: "review",
      trigger,
      autoSubmission: this.automaticProvenance(pr, trigger),
      requestEventId,
      status: "queued",
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      log: "",
      reviewer: this.captureReviewer(),
      integrationSnapshot: integrationSnapshot(this.getIntegrations()),
      result: null,
      progress: preflight
        ? {
            ...emptyProgress(),
            phases: [preflight],
            activity: [
              {
                at: preflight.finishedAt ?? preflight.startedAt,
                source: "app",
                kind: "phase",
                label: "Syncing latest PR completed",
              },
            ],
            activityCount: 1,
            lastActivityAt: preflight.finishedAt ?? preflight.startedAt,
          }
        : null,
    };
    this.db.transaction(() => {
      this.db.createRun(run);
      this.db.createRunSnapshot(run.id, {
        pr,
        diff: diff.diff,
        diffTruncated: diff.truncated,
      });
      this.db.createJob({
        id: id(),
        kind: "review",
        pr_id: prId,
        run_id: run.id,
        payload_json: JSON.stringify({ requestEventId }),
        status: "queued",
        created_at: run.createdAt,
        started_at: null,
        finished_at: null,
        error: null,
      });
      this.db.setPrStatus(prId, "queued");
    });
    this.queue.schedule();
    this.emit(prId);
  }

  private observe(
    remote: RemotePullRequest,
    options: ObserveOptions,
    id = remote.pr.id,
  ): PullRequest {
    const existing = this.db.getPr(id);
    let status = existing?.status ?? remote.pr.status;
    if (
      existing &&
      existing.headSha !== remote.pr.headSha &&
      this.db.latestDraft(id)
    )
      status = "outdated";
    if (draftDerivedStatuses.has(status))
      status = this.draftStatus(id, remote.pr.headSha);
    const kept = existing
      ? {
          blockingCount: existing.blockingCount,
          nonBlockingCount: existing.nonBlockingCount,
          ...(options.requestsKnown
            ? {}
            : {
                requested: existing.requested,
                requestedAt: existing.requestedAt,
                requestSource: existing.requestSource,
              }),
        }
      : {};
    const pr = this.db.upsertPr(
      { ...remote.pr, ...kept, id, status },
      remote.diff,
      remote.diffTruncated,
    );
    if (pr.effectiveAutomation.reviewNewCommits && !options.preserveBaseline) {
      const state = this.db.getAutomationState(id);
      if (state.commitHead !== pr.headSha) {
        this.db.setCommitHead(id, pr.headSha);
        if (
          state.commitHead !== null &&
          options.automatic &&
          pr.state === "OPEN"
        )
          this.enqueueReview(id, "new_commits", null);
      }
    }
    return pr;
  }

  private observeRequest(request: PollRequest): void {
    const pr = this.db.getPr(request.prId);
    if (!pr) return;
    const inserted = this.db.insertRequestEvent(
      request.eventId,
      request.prId,
      request.headSha,
      request.requestedAt,
    );
    if (inserted) this.reconcileSubmitted(pr.id);
    if (
      inserted &&
      pr.effectiveAutomation.reviewRequests &&
      pr.state === "OPEN" &&
      this.db.getAutomationState(pr.id).requestsArmed
    )
      this.enqueueReview(pr.id, "request", request.eventId);
  }

  private armRequests(prId: string, scope: PollScope | undefined): void {
    const pr = this.db.getPr(prId);
    if (
      !pr ||
      !pr.effectiveAutomation.reviewRequests ||
      (scope && !scope.requestNumbers.includes(pr.number))
    )
      return;
    if (!this.db.getAutomationState(prId).requestsArmed)
      this.db.setRequestsArmed(prId, true);
  }

  private async refreshRemote(
    pr: PullRequest,
    automatic = true,
  ): Promise<RemotePullRequest> {
    const remote = await this.github.getPullRequest(pr.repository, pr.number);
    this.observe(remote, { requestsKnown: false, automatic }, pr.id);
    await this.recordMergeReadiness(pr.id);
    if (automaticallyReviewed(this.requirePr(pr.id))) {
      await this.scanHumanReview(pr.id);
      const diff = this.db.getDiff(pr.id)!;
      return {
        pr: this.requirePr(pr.id),
        diff: diff.diff,
        diffTruncated: diff.truncated,
      };
    }
    return remote;
  }

  private async recordMergeReadiness(prId: string): Promise<void> {
    const pr = this.requirePr(prId);
    if (pr.state !== "OPEN") return;
    let next: MergeReadiness;
    try {
      const readiness = await this.github.mergeReadiness(pr);
      next =
        readiness.headSha === pr.headSha
          ? readiness
          : failedReadiness(
              pr.headSha,
              `GitHub answered for ${readiness.headSha.slice(0, 7)} instead of the current head`,
            );
    } catch (error) {
      next = failedReadiness(pr.headSha, error);
    }
    this.db.setMergeReadiness(prId, withLastKnown(next, pr.mergeReadiness));
  }

  private requirePr(prId: string): PullRequest {
    const pr = this.db.getPr(prId);
    if (!pr) throw new ServiceError(404, "not_found", "pull request not found");
    return pr;
  }

  private requireDraft(prId: string, draftId: string): ReviewDraft {
    const draft = this.db.getDraft(prId, draftId);
    if (!draft)
      throw new ServiceError(
        409,
        "draft_required",
        "the requested review draft does not exist for this pull request",
      );
    return draft;
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.closed || !this.pollingActive()) return;
    this.pollTimer = setInterval(
      () => void this.sync("scheduled").catch(() => undefined),
      this.db.getSettings().pollIntervalSeconds * 1_000,
    );
    this.pollTimer.unref();
  }

  private emit(prId?: string): void {
    for (const listener of this.listeners) listener(prId);
  }
}

import path from "node:path";
import type {
  ExecutionStatus,
  ExecutionMode,
  DockerSetupStatus,
  DockerCapabilityApproval,
  DockerInspectRequest,
  DockerLibraryLeaf,
  TrustedLibraryLeaf,
  IntegrationConfig,
  HarnessId,
  HarnessSelection,
  HarnessSettings,
  HarnessSource,
  HarnessStatus,
  ReviewerSettings,
} from "../../shared/contracts.js";
import type { AppConfig } from "../config.js";
import { DockerExecutor, type ExecutionRequest } from "./executor.js";
import { loadWorkflow } from "./config.js";
import { digest } from "./policy.js";
import { managedSetupDisclosure, prepareManagedWorkflow } from "./managed.js";
import { loadSkill, skillCompatibility, nestedHarnesses } from "./skill.js";
import { discoverLibraryLeaf } from "./docker-library.js";
import {
  inspectDockerCapabilities,
  requireDockerApproval,
} from "./docker-capabilities.js";
import { nativeConfiguration } from "./native-settings.js";
import {
  currentSelection,
  executionUpgradeAction,
  requireSupportedExecution,
} from "./supported.js";

export class ConfiguredWorkflows {
  private readonly executors = new Map<string, DockerExecutor>();
  private readonly failures = new Map<string, string>();
  private readonly libraryCandidates = new Map<string, DockerLibraryLeaf>();
  private inspected?: {
    request: DockerInspectRequest;
    connections: IntegrationConfig[];
    value: Awaited<ReturnType<typeof inspectDockerCapabilities>>;
  };
  private preflight = false;
  private closing = false;
  private setupAbort?: AbortController;
  private setupTask?: Promise<HarnessSource>;
  private setupState: DockerSetupStatus = {
    status: "not_started",
    harness: null,
    message: managedSetupDisclosure,
  };

  private constructor(
    private readonly app: AppConfig,
    private settings: HarnessSettings,
  ) {}

  static async open(
    app: AppConfig,
    settings: HarnessSettings,
  ): Promise<ConfiguredWorkflows> {
    const manager = new ConfiguredWorkflows(app, settings);
    try {
      for (const source of settings.sources) {
        const executor = await DockerExecutor.open(
          manager.sourceConfig(source),
        );
        if (!executor) throw new Error("Saved Docker artifact is unavailable");
        manager.executors.set(source.id, executor);
        if (executor.status().snapshot?.digest !== source.digest)
          manager.failures.set(
            source.id,
            "Saved Docker artifact is unavailable or changed. Restore the exact artifact for captured sessions, or explicitly set up Docker for new sessions. No fallback is permitted.",
          );
      }
      return manager;
    } catch (error) {
      await manager.close();
      throw error;
    }
  }

  private sourceConfig(
    source: Pick<HarnessSource, "id" | "path" | "skillPath">,
  ) {
    return {
      ...this.app,
      dataDir: path.join(this.app.dataDir, "configured-workflows", source.id),
      workflowConfigPath: source.path,
      reviewer: { ...this.app.reviewer, skillPath: source.skillPath },
    };
  }

  async prepareSelection(
    selection: HarnessSelection,
    env: NodeJS.ProcessEnv,
  ): Promise<HarnessSettings> {
    const reviewer = selection.reviewer;
    const skill = await loadSkill(reviewer.skillPath, selection.workflow);
    const native = await nativeConfiguration(
      selection.harness,
      selection.workflow,
      reviewer.model,
      env,
    );
    const { model, ...configuration } = native;
    const declaredModel = skill.files
      .find((file) => file.sourcePath === skill.path)
      ?.content.match(/^model:\s*["']?([a-zA-Z0-9._/-]+)/m)?.[1];
    if (
      selection.version !== 3 &&
      declaredModel &&
      model &&
      declaredModel !== model
    )
      throw new Error(
        `Selected skill pins model ${declaredModel}, but the primary model is ${model}. Choose the matching model or a skill without that pin; the app does not rewrite the skill.`,
      );
    const isolated =
      selection.version === 3
        ? {
            main: {
              id: "main",
              role: "main" as const,
              harness: selection.harness,
              ...native,
              model: model!,
            },
            additional: await Promise.all(
              selection.additional.map(async (entry) => ({
                ...entry,
                role: "additional" as const,
                ...(await nativeConfiguration(
                  entry.harness,
                  "separated",
                  entry.model,
                  env,
                )),
              })),
            ),
          }
        : undefined;
    return {
      ...this.settings,
      selection: {
        ...selection,
        reviewer: { skillPath: reviewer.skillPath, model },
        ...(isolated
          ? {
              additional: isolated.additional.map(({ id, harness, model }) => ({
                id,
                harness,
                model,
              })),
            }
          : {}),
      },
      skill,
      native: configuration,
      isolated,
    };
  }

  update(settings: HarnessSettings): void {
    this.settings = settings;
    this.inspected = undefined;
    this.libraryCandidates.clear();
    this.preflight = false;
  }

  selection(): HarnessSelection | null {
    const selection = this.settings.selection;
    if (!currentSelection(selection)) return null;
    const { harness, reviewer } = selection;
    return selection.version === 3
      ? {
          version: 3,
          workflow: "separated",
          harness,
          reviewer,
          additional: selection.additional,
        }
      : { version: 2, workflow: selection.workflow, harness, reviewer };
  }

  mode(): ExecutionMode | null {
    return this.selection()?.workflow ?? null;
  }

  private sourceId(): string | null {
    const selection = this.selection();
    return selection?.workflow === "docker"
      ? (this.settings.managed?.[selection.harness] ?? null)
      : null;
  }

  private selected(): DockerExecutor | null {
    return this.executors.get(this.sourceId() ?? "") ?? null;
  }

  private captureRequired(): string | null {
    const selection = this.selection();
    if (!selection) return executionUpgradeAction;
    if (!this.settings.skill)
      return "Save the selected skill, Main model and Additional entries in Settings before starting. Save captures the supported configuration; nothing is enabled automatically.";
    if (selection.version === 3) {
      const roles = this.settings.isolated;
      if (
        !roles ||
        [roles.main, ...roles.additional].some(
          (entry) =>
            entry.policy?.profile !== "restricted-native-1" ||
            entry.policy.version !== 1 ||
            entry.policy.harness !== entry.harness,
        )
      )
        return executionUpgradeAction;
    }
    return null;
  }

  status(): ExecutionStatus {
    const status = this.executionStatus();
    const sourceId = this.sourceId();
    const source = this.settings.sources.find((item) => item.id === sourceId);
    const snapshot = this.selected()?.status().snapshot;
    const lastApprovedDocker =
      source &&
      snapshot?.digest === source.digest &&
      snapshot.harness === this.selection()?.harness
        ? snapshot.docker
        : undefined;
    return { ...status, ...(lastApprovedDocker ? { lastApprovedDocker } : {}) };
  }

  private executionStatus(): ExecutionStatus {
    const missing = this.captureRequired();
    if (missing)
      return { status: "unavailable", snapshot: null, message: missing };
    const selection = this.selection()!;
    const incompatible = skillCompatibility(
      this.settings.skill!,
      selection.workflow,
      selection.harness,
    ).join("\n");
    if (selection.workflow === "separated")
      return {
        status: incompatible ? "unavailable" : "disabled",
        snapshot: null,
        message:
          incompatible ||
          "Isolated Main/Additional harnesses use captured restricted-native-1 capabilities and synthesize one draft. Restricted native tools, not OS/process containment.",
      };
    if (selection.workflow === "dangerous")
      return {
        status:
          this.settings.dangerousConsent?.harness === selection.harness
            ? "disabled"
            : "unavailable",
        snapshot: null,
        message:
          "Dangerous host execution requires explicit confirmation and has full native inheritance. App read permissions and preview do not constrain native writes or publishing. Availability is not verified connected.",
      };
    const status = this.selected()?.status();
    const captured = this.selected()?.capture(this.app.reviewer);
    const changed =
      captured &&
      (captured.execution?.version !== 2 ||
        captured.skillPath !== selection.reviewer.skillPath ||
        captured.model !==
          selection.reviewer.model?.replace(/^openai-codex\//, "") ||
        captured.execution.skillDigest !== this.settings.skill?.digest);
    const failure = changed
      ? "Docker setup does not match the saved model, skill bytes or resources. Explicitly run Set up Docker for this selection."
      : this.failures.get(this.sourceId() ?? "");
    if (failure || !status || status.snapshot?.harness !== selection.harness)
      return {
        status: "unavailable",
        snapshot: null,
        message:
          failure ??
          "Docker setup is required for this saved harness. Explicitly run Set up Docker; nothing is installed or selected automatically.",
      };
    return status;
  }

  describe(): HarnessStatus {
    const selection = this.selection();
    const archived = !selection ? this.settings.selection : null;
    return {
      selection,
      archivedSelection: archived
        ? {
            version: archived.version,
            harness: archived.harness,
            workflow: archived.workflow,
            reviewer: archived.reviewer,
          }
        : null,
      requiresSave: Boolean(this.captureRequired()),
      reviewer: selection?.reviewer ?? archived?.reviewer ?? this.app.reviewer,
      mode: this.mode(),
      setup:
        this.setupState.status === "not_started" &&
        selection &&
        this.settings.managed?.[selection.harness]
          ? {
              status: "ready",
              harness: selection.harness,
              message:
                "Managed artifact cached. Runtime is checked before execution; authentication/provider readiness is not verified.",
            }
          : this.setupState,
      effective: this.status().status === "unavailable" ? null : selection,
      options: [
        { id: "claude", label: "Claude Code" },
        { id: "codex", label: "Codex" },
        { id: "pi", label: "Pi" },
      ],
      capabilities:
        selection?.version === 3 && this.settings.isolated
          ? [
              this.settings.isolated.main,
              ...this.settings.isolated.additional,
            ].flatMap((entry) =>
              entry.policy ? [{ id: entry.id, policy: entry.policy }] : [],
            )
          : [],
      diagnostics: [this.status().message],
      evidence: this.preflight ? "synthetic_preflight" : "unverified",
    };
  }

  private async registerManagedArtifact(file: string): Promise<HarnessSource> {
    const loaded = await loadWorkflow(
      file,
      this.app.reviewer.skillPath,
      this.app.demo,
    );
    const source: HarnessSource = {
      id: digest(`${file}\n${loaded.snapshot.digest}`).slice(0, 32),
      path: file,
      harness: loaded.config.harness,
      skillPath: loaded.config.skillPath ?? this.app.reviewer.skillPath,
      digest: loaded.snapshot.digest,
      importedAt: new Date().toISOString(),
    };
    if (this.failures.has(source.id)) {
      await this.executors.get(source.id)?.close();
      this.executors.delete(source.id);
      this.failures.delete(source.id);
    }
    if (!this.executors.has(source.id)) {
      const executor = await DockerExecutor.open(this.sourceConfig(source));
      if (!executor || executor.status().snapshot?.digest !== source.digest) {
        await executor?.close();
        throw new Error(
          "Docker artifact changed during setup; nothing was selected",
        );
      }
      this.executors.set(source.id, executor);
    }
    return source;
  }

  async discoverLibraryLeaf(
    source: string,
    env: NodeJS.ProcessEnv,
  ): Promise<DockerLibraryLeaf> {
    const selection = this.selection();
    if (
      !selection ||
      selection.workflow !== "docker" ||
      this.captureRequired() ||
      !this.settings.skill
    )
      throw new Error(
        "Save Docker before explicitly discovering an installed skill leaf",
      );
    const required = [
      ...new Set([selection.harness, ...nestedHarnesses(this.settings.skill)]),
    ];
    const candidate = await discoverLibraryLeaf(source, env.HOME!, required);
    if (
      this.libraryCandidates.size >= 8 &&
      !this.libraryCandidates.has(candidate.id)
    )
      throw new Error(
        "At most eight leaf candidates may be held; save again to clear discovery",
      );
    this.libraryCandidates.set(candidate.id, candidate);
    return candidate;
  }

  private async selectedLibraryLeaves(
    ids: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<TrustedLibraryLeaf[]> {
    if (
      !Array.isArray(ids) ||
      ids.length > 8 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new Error(
        "Select at most eight distinct server-observed installed leaf identities",
      );
    const selection = this.selection()!;
    const required = [
      ...new Set([selection.harness, ...nestedHarnesses(this.settings.skill!)]),
    ];
    const leaves: TrustedLibraryLeaf[] = [];
    for (const id of ids) {
      const selected = this.libraryCandidates.get(id);
      if (!selected)
        throw new Error(
          "Discover the exact installed leaf again; saved settings, GET and restart grant no source reads",
        );
      const current = await discoverLibraryLeaf(
        selected.source,
        env.HOME!,
        required,
      );
      if (current.id !== id)
        throw new Error(
          "Installed leaf identity changed; discover and explicitly select its current read scope",
        );
      leaves.push({
        source: current.source,
        resolvedSourcePath: current.resolvedSourcePath,
        sourceDigest: current.sourceDigest,
      });
    }
    return leaves;
  }

  async inspectDocker(
    request: DockerInspectRequest,
    connections: IntegrationConfig[],
    env: NodeJS.ProcessEnv,
  ) {
    const selection = this.selection();
    if (
      !selection ||
      selection.workflow !== "docker" ||
      selection.harness !== request.harness ||
      this.captureRequired()
    )
      throw new Error(
        "Save the matching Docker selection before explicit capability inspection",
      );
    this.inspected = undefined;
    const leaves = await this.selectedLibraryLeaves(
      request.libraryLeaves ?? [],
      env,
    );
    const value = await inspectDockerCapabilities(
      {
        ...this.app,
        reviewer: { ...this.app.reviewer, ...selection.reviewer },
      },
      request.harness,
      env,
      request.localConnections,
      connections,
      request.exclusions,
      leaves,
    );
    if (value.disclosure.skillDigest !== this.settings.skill?.digest)
      throw new Error(
        "Selected skill changed since Save. Explicitly save it again before inspecting Docker capabilities.",
      );
    this.inspected = { request, connections, value };
    return value.disclosure;
  }

  async setup(
    harness: HarnessId,
    env: NodeJS.ProcessEnv,
    fixturePrepare?: typeof prepareManagedWorkflow,
    approval?: DockerCapabilityApproval,
  ): Promise<HarnessSource> {
    if (fixturePrepare && !this.app.demo)
      throw new Error("Synthetic setup injection requires explicit demo mode");
    if (this.closing) throw new Error("Workflow manager is closing");
    if (this.setupState.status === "running")
      throw new Error("Docker setup is already running");
    this.setupAbort = new AbortController();
    this.setupTask = this.prepareSetup(
      harness,
      env,
      fixturePrepare,
      this.setupAbort.signal,
      approval,
    );
    try {
      return await this.setupTask;
    } finally {
      this.setupTask = undefined;
      this.setupAbort = undefined;
    }
  }

  private async prepareSetup(
    harness: HarnessId,
    env: NodeJS.ProcessEnv,
    fixturePrepare: typeof prepareManagedWorkflow | undefined,
    signal: AbortSignal,
    approval: DockerCapabilityApproval | undefined,
  ): Promise<HarnessSource> {
    this.setupState = {
      status: "running",
      harness,
      message: managedSetupDisclosure,
    };
    try {
      const selection = this.selection();
      if (!selection || this.captureRequired() || selection.harness !== harness)
        throw new Error(
          "Save the intended harness, model and skill before Set up Docker. Setup uses only saved inputs and never selects a mode.",
        );
      if (
        (await loadSkill(selection.reviewer.skillPath, "docker")).digest !==
        this.settings.skill?.digest
      )
        throw new Error(
          "Selected skill resources changed since Save. Explicitly save again before Docker setup; queued jobs retain their original bytes.",
        );
      const inspected = this.inspected;
      if (!inspected || inspected.request.harness !== harness)
        throw new Error(
          "Explicit Docker capability inspection and exact approval are required before setup; old setup requests grant no new capabilities.",
        );
      requireDockerApproval(inspected.value.disclosure, approval);
      const refreshed = await inspectDockerCapabilities(
        {
          ...this.app,
          reviewer: { ...this.app.reviewer, ...selection.reviewer },
        },
        harness,
        env,
        inspected.request.localConnections,
        inspected.connections,
        inspected.request.exclusions,
        await this.selectedLibraryLeaves(
          inspected.request.libraryLeaves ?? [],
          env,
        ),
      );
      requireDockerApproval(refreshed.disclosure, approval);
      signal.throwIfAborted();
      const file = await (fixturePrepare ?? prepareManagedWorkflow)(
        {
          ...this.app,
          reviewer: { ...this.app.reviewer, ...selection.reviewer },
        },
        harness,
        env,
        undefined,
        signal,
        {
          ...refreshed.config,
          docker: {
            profile: "container-native-1",
            disclosure: refreshed.disclosure,
            approval,
          },
        },
      );
      signal.throwIfAborted();
      const source = await this.registerManagedArtifact(file);
      await this.executors.get(source.id)!.check(undefined, signal);
      signal.throwIfAborted();
      this.setupState = {
        status: "ready",
        harness,
        message:
          "Managed runtime and Docker policy preflight passed. No authentication, model or provider call was made. Selection is unchanged.",
      };
      return source;
    } catch (error) {
      this.setupState = {
        status: "failed",
        harness,
        message: error instanceof Error ? error.message : "Docker setup failed",
      };
      throw error;
    }
  }

  capture(settings: ReviewerSettings): ReviewerSettings {
    const missing = this.captureRequired();
    if (missing) throw new Error(missing);
    const selection = this.selection()!;
    const {
      execution: _execution,
      hostExecution: _host,
      skillExecution: _skill,
      ...original
    } = settings;
    const base = { ...original, ...selection.reviewer };
    if (selection.version === 3) {
      const roles = this.settings.isolated!;
      const captured = (entry: typeof roles.main) => ({
        ...entry,
        additionalInstructions: [
          original.additionalInstructions,
          entry.additionalInstructions,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      const main = captured(roles.main);
      return {
        ...base,
        model: main.model,
        effort: main.effort,
        additionalInstructions: main.additionalInstructions,
        skillExecution: {
          version: 3,
          mode: "separated",
          harness: main.harness,
          skill: this.settings.skill!,
          roles: { main, additional: roles.additional.map(captured) },
          policy: main.policy,
        },
      };
    }
    const native: ReviewerSettings = {
      ...base,
      ...this.settings.native,
      additionalInstructions: [
        original.additionalInstructions,
        this.settings.native?.additionalInstructions,
      ]
        .filter(Boolean)
        .join("\n\n"),
      skillExecution: {
        version: 2,
        mode: selection.workflow,
        harness: selection.harness,
        skill: this.settings.skill!,
      },
    };
    if (selection.workflow === "dangerous") {
      const consent = this.settings.dangerousConsent;
      if (
        !consent ||
        consent.harness !== selection.harness ||
        consent.version !== 1
      )
        throw new Error(
          "Dangerous selection has no matching explicit confirmation. Confirm and save Dangerous in Settings.",
        );
      return { ...native, hostExecution: { ...consent } };
    }
    if (this.status().status !== "configured")
      throw new Error(this.status().message);
    const captured = this.selected()!.capture(native);
    return {
      ...captured,
      execution: { ...captured.execution!, sourceId: this.sourceId()! },
    };
  }

  async check(): Promise<void> {
    if (!this.status().snapshot || this.failures.has(this.sourceId() ?? ""))
      throw new Error(this.status().message);
    await this.selected()!.check();
    this.preflight = true;
  }

  execute(request: ExecutionRequest): ReturnType<DockerExecutor["execute"]> {
    requireSupportedExecution(request.settings);
    const sourceId = request.settings.execution?.sourceId;
    const executor = this.executors.get(sourceId ?? "");
    if (!executor || this.failures.has(sourceId!))
      return Promise.reject(
        new Error(
          "Saved Docker artifact is unavailable or changed; restore the exact captured artifact or start a new session after explicit setup. No fallback is permitted.",
        ),
      );
    return executor.execute(request);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.setupAbort?.abort(new Error("App shutting down during Docker setup"));
    await this.setupTask?.catch(() => {});
    await Promise.all(
      [...this.executors.values()].map((executor) => executor.close()),
    );
  }
}

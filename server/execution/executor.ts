import { fork } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  copyFile,
  chmod,
  writeFile,
  readdir,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import type {
  ExecutionSnapshot,
  ExecutionStatus,
  ReviewerSettings,
  IntegrationSessionSnapshot,
} from "../../shared/contracts.js";
import type { ProgressReporter } from "../progress.js";
import {
  ClaudeStream,
  CodexStream,
  PiStream,
  JsonLineDecoder,
} from "../stream.js";
import type { ReadProviders } from "../read-providers.js";
import { runCommand } from "../util.js";
import { validateSchema } from "../schema.js";
import { validateReviewResult } from "../review-output.js";
import { loadWorkflow, runtimeMounts } from "./config.js";
import { policy, policyDigest, digest, supportedImage } from "./policy.js";
import {
  fixtureCredentials,
  nativeCredentials,
  selectedCredentials,
} from "./auth.js";
import { requireDockerApproval } from "./docker-capabilities.js";
import { dockerInputFrame } from "./harness.mjs";
import {
  WorkflowBroker,
  brokerDigestV2,
  type BrokerRequest,
  type FixtureInference,
} from "./broker.js";

export interface ExecutionRequest {
  kind?: "review" | "question" | "classification";
  runId: string;
  settings: ReviewerSettings;
  prepare: (signal?: AbortSignal) => Promise<string>;
  metadata: unknown;
  diff: string;
  prompt: string;
  schema: object;
  signal?: AbortSignal;
  progress?: ProgressReporter;
  providers?: ReadProviders;
  integrationSnapshot?: IntegrationSessionSnapshot;
}

export class DockerExecutor {
  private loaded: Awaited<ReturnType<typeof loadWorkflow>> | null = null;
  private failure: string | null = null;
  private checkFailure: string | null = null;
  private readonly active = new Map<AbortController, Promise<void>>();
  private closing = false;
  private readonly directory: string;
  private readonly owner: string;
  private readonly environment: NodeJS.ProcessEnv;
  private constructor(
    private readonly app: AppConfig,
    private readonly fixtureInference?: FixtureInference,
    private readonly fixtureDiagnostic?: (text: string) => void,
  ) {
    this.directory = path.join(path.resolve(app.dataDir), "execution");
    this.owner = digest(path.resolve(app.dataDir));
    this.environment = {
      PATH: "/usr/bin:/bin",
      HOME: path.join(this.directory, "home"),
      DOCKER_CONFIG: path.join(this.directory, "docker-config"),
    };
  }

  static async open(
    app: AppConfig,
    fixtureInference?: FixtureInference,
    fixtureDiagnostic?: (text: string) => void,
  ): Promise<DockerExecutor | null> {
    if ((fixtureInference || fixtureDiagnostic) && !app.demo)
      throw new Error(
        "Synthetic inference injection requires explicit demo mode",
      );
    const executor = new DockerExecutor(
      app,
      fixtureInference,
      fixtureDiagnostic,
    );
    const lockPath = path.join(executor.directory, "owner.json");
    if (!app.workflowConfigPath) {
      try {
        await readFile(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }
    await mkdir(executor.directory, { recursive: true, mode: 0o700 });
    const claim = path.join(executor.directory, "recovery");
    try {
      await mkdir(claim, { mode: 0o700 });
    } catch {
      throw new Error(
        "Execution ownership recovery is already in progress or was interrupted; inspect owned containers before removing the recovery directory",
      );
    }
    try {
      let previous: { version: number; pid: number; owner: string } | null =
        null;
      try {
        previous = JSON.parse(await readFile(lockPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error(
            "Execution ownership journal is unreadable; refusing recovery",
          );
      }
      if (!app.workflowConfigPath && !previous) return null;
      if (previous) {
        if (
          previous.version !== 1 ||
          previous.owner !== executor.owner ||
          !Number.isInteger(previous.pid) ||
          previous.pid < 1
        )
          throw new Error(
            "Execution ownership journal is invalid; refusing recovery",
          );
        let alive = true;
        try {
          process.kill(previous.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive)
          throw new Error(
            "Another process still owns this execution directory",
          );
      }
      await mkdir(executor.directory, { recursive: true, mode: 0o700 });
      await mkdir(executor.environment.HOME!, { recursive: true, mode: 0o700 });
      await mkdir(executor.environment.DOCKER_CONFIG!, {
        recursive: true,
        mode: 0o700,
      });
      if (previous) {
        const recovered = await executor.docker([
          "ps",
          "-aq",
          "--filter",
          `label=pr-review.executor.owner=${executor.owner}`,
        ]);
        const ids = recovered.stdout.trim().split(/\s+/).filter(Boolean);
        if (ids.length > 128 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
          throw new Error("Invalid owned-container recovery inventory");
        for (const id of ids) await executor.docker(["rm", "--force", id]);
        await rm(lockPath);
        for (const name of await readdir(executor.directory)) {
          if (/^[a-f0-9-]{36}$/.test(name))
            await rm(path.join(executor.directory, name), {
              recursive: true,
              force: true,
            });
        }
        await rm(path.join(app.dataDir, "workflow-sources"), {
          recursive: true,
          force: true,
        });
      }
      if (!app.workflowConfigPath) return null;
      const lock = await open(lockPath, "wx", 0o600);
      try {
        await lock.writeFile(
          JSON.stringify({
            version: 1,
            owner: executor.owner,
            pid: process.pid,
          }),
        );
        await lock.sync();
      } finally {
        await lock.close();
      }
      try {
        executor.loaded = await loadWorkflow(
          app.workflowConfigPath,
          app.reviewer.skillPath,
          app.demo,
        );
      } catch (error) {
        executor.failure =
          error instanceof Error
            ? error.message
            : "Invalid execution configuration";
      }
      return executor;
    } finally {
      await rm(claim, { recursive: true, force: true });
    }
  }

  status(): ExecutionStatus {
    if (this.loaded && !this.loaded.snapshot.docker)
      return {
        status: "unavailable",
        snapshot: this.loaded.snapshot,
        message:
          "This Docker artifact predates explicit container capability approval. History is unchanged; inspect and approve setup for new sessions.",
      };
    return {
      status: this.failure || this.checkFailure ? "unavailable" : "configured",
      message:
        this.failure ??
        this.checkFailure ??
        "Docker workflow configured, not verified connected. Explicit preflight checks the pinned platform/runtime; execution uses only the selected model credentials and immutable approved read-provider policy",
      snapshot: this.loaded?.snapshot ?? null,
    };
  }

  capture(settings: ReviewerSettings): ReviewerSettings {
    return {
      ...settings,
      skillPath: this.loaded?.config.skillPath ?? this.app.reviewer.skillPath,
      model: this.loaded
        ? this.loaded.config.models[
            this.loaded.config.harness === "claude" ? "claude" : "codex"
          ]
        : settings.model,
      execution: this.loaded?.snapshot ?? {
        version: 1,
        digest: "unavailable",
        image: supportedImage,
        policy: policyDigest,
        broker: brokerDigestV2,
        models: { claude: "unavailable", codex: "unavailable" },
        harness: "claude",
        skillDigest: "",
        fixture: false,
      },
    };
  }

  private async docker(args: string[], signal?: AbortSignal) {
    const result = await runCommand(
      "/usr/local/bin/docker",
      ["--host", "unix:///var/run/docker.sock", ...args],
      {
        env: this.environment,
        signal,
        timeoutMs: 20000,
        maxOutputBytes: 200000,
      },
    );
    if (result.code !== 0 || result.stdoutTruncated)
      throw new Error(
        `Docker ${args[0]} failed; execution remains unavailable`,
      );
    return result;
  }

  private async track<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new Error("Executor is closing");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    let finished!: () => void;
    this.active.set(
      controller,
      new Promise<void>((resolve) => {
        finished = resolve;
      }),
    );
    try {
      return await operation(controller.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.active.delete(controller);
      finished();
    }
  }

  check(snapshot?: ExecutionSnapshot, signal?: AbortSignal): Promise<void> {
    return this.track(signal, async (tracked) => {
      try {
        await this.verify(snapshot, tracked);
        this.checkFailure = null;
      } catch (error) {
        this.checkFailure =
          error instanceof Error ? error.message : "Execution preflight failed";
        throw error;
      }
    });
  }

  private async verify(
    snapshot?: ExecutionSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (this.closing || this.failure || !this.loaded)
      throw new Error(this.failure ?? "Docker workflow unavailable");
    if (!this.loaded.snapshot.docker)
      throw new Error(
        "Explicit container capability approval is missing; inspect and approve Docker setup before preflight or execution",
      );
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error(
        "Only the verified macOS arm64 / Docker Desktop Linux arm64 profile is supported",
      );
    const current = await loadWorkflow(
      this.app.workflowConfigPath!,
      this.app.reviewer.skillPath,
      this.app.demo,
    );
    if (
      current.snapshot.digest !== this.loaded.snapshot.digest ||
      (snapshot && snapshot.digest !== current.snapshot.digest)
    )
      throw new Error(
        "Immutable workflow snapshot no longer matches the configured runtime or skill; restart with the updated configuration and request a new run",
      );
    const version = JSON.parse(
      (await this.docker(["version", "--format", "{{json .Server}}"], signal))
        .stdout,
    );
    if (
      version.Version !== "29.8.0" ||
      version.GitCommit !== "3ce5872" ||
      version.Os !== "linux" ||
      version.Arch !== "arm64" ||
      version.KernelVersion !== "7.0.12-linuxkit"
    )
      throw new Error(
        "Unverified Docker engine/kernel/profile combination; required Engine 29.8.0 (3ce5872), Linux 7.0.12-linuxkit arm64",
      );
    const image = JSON.parse(
      (
        await this.docker(
          ["image", "inspect", this.loaded.config.image],
          signal,
        )
      ).stdout,
    )[0];
    if (
      image.Id !== supportedImage ||
      image.Os !== "linux" ||
      image.Architecture !== "arm64"
    )
      throw new Error(
        "Required pinned cached runtime image is unavailable; no image was downloaded",
      );
    await this.launch(
      {
        preflight: true,
        fixture: this.loaded.config.auth === "fixture",
        syntheticRuntime:
          this.loaded.config.auth === "fixture" &&
          !this.loaded.config.fixtureNative,
        harness: this.loaded.config.harness,
        nested: this.loaded.config.nested,
      },
      undefined,
      undefined,
      signal,
    );
  }

  execute(request: ExecutionRequest): Promise<{ value: unknown; log: string }> {
    if (request.kind === "classification")
      return Promise.reject(
        new Error(
          "This pinned Docker runtime has no enforced zero-tool classifier; no container, host fallback or model dispatch was started",
        ),
      );
    return this.track(request.signal, (signal) =>
      this.run({ ...request, signal }),
    );
  }

  private async run(
    request: ExecutionRequest,
  ): Promise<{ value: unknown; log: string }> {
    const snapshot = request.settings.execution;
    if (
      !snapshot ||
      snapshot.version !== 2 ||
      snapshot.digest !== this.loaded?.snapshot.digest ||
      snapshot.policy !== policyDigest
    )
      throw new Error(
        "Immutable Docker execution snapshot is unavailable or changed",
      );
    if (!snapshot.docker || snapshot.docker.profile !== "container-native-1")
      throw new Error(
        "This Docker capture predates explicit container capability approval. History is unchanged; inspect and approve Docker setup for new sessions.",
      );
    requireDockerApproval(snapshot.docker.disclosure, snapshot.docker.approval);
    await this.check(snapshot, request.signal);
    request.signal?.throwIfAborted();
    const sourceDir = await request.prepare(request.signal);
    request.signal?.throwIfAborted();
    const credentials = selectedCredentials(
      this.loaded!.config.auth === "fixture"
        ? fixtureCredentials()
        : await nativeCredentials(request.signal, this.loaded!.config),
      this.loaded!.config,
    );
    const run = randomUUID();
    const capability = randomBytes(32).toString("hex");
    const broker = new WorkflowBroker(
      run,
      capability,
      this.loaded!.config,
      credentials,
      request.metadata,
      request.diff,
      await request.providers?.session(
        request.integrationSnapshot,
        request.signal ?? new AbortController().signal,
      ),
      this.fixtureInference,
    );
    const stream =
      snapshot.harness === "claude"
        ? new ClaudeStream(
            request.progress,
            ["/source/checkout", "/source"],
            "/scratch",
          )
        : snapshot.harness === "codex"
          ? new CodexStream(request.progress)
          : new PiStream(request.progress);
    const secrets = [
      credentials.claude.claudeAiOauth.accessToken,
      credentials.codex.tokens.access_token,
      credentials.codex.tokens.id_token,
      credentials.pi?.access ?? "",
    ].filter(Boolean);
    const boundaryEvidence: Record<string, number> = {};
    let leaked = false;
    const output = new JsonLineDecoder((frame) => {
      const text = JSON.stringify(frame);
      if (secrets.some((secret) => text.includes(secret))) leaked = true;
      else stream.decoder.push(Buffer.from(text + "\n"));
    });
    try {
      await this.launch(
        {
          run,
          capability,
          appRun: request.runId,
          fixture: this.loaded!.config.auth === "fixture",
          syntheticRuntime:
            this.loaded!.config.auth === "fixture" &&
            !this.loaded!.config.fixtureNative,
          harness: snapshot.harness,
          nested: this.loaded!.config.nested,
          metadata: request.metadata,
          docker: snapshot.docker,
          files: this.loaded!.files,
          projectedSettings: this.loaded!.projectedSettings,
          credentials,
          models: this.loaded!.config.models,
          effort: this.loaded!.config.effort,
          skill: this.loaded!.skill,
          skillPath: `/scratch/resources/${path.basename(path.dirname(this.loaded!.config.skillPath ?? this.app.reviewer.skillPath))}/${path.basename(this.loaded!.config.skillPath ?? this.app.reviewer.skillPath)}`,
          schema: request.schema,
          prompt: request.prompt,
        },
        sourceDir,
        { broker, output, boundaryEvidence },
        request.signal,
      );
      output.end();
      stream.decoder.end();
      if (
        leaked ||
        output.stats.malformed ||
        output.stats.overflowed ||
        stream.decoder.stats.malformed ||
        stream.decoder.stats.overflowed ||
        (stream instanceof ClaudeStream
          ? stream.resultFrames !== 1 ||
            !stream.envelope ||
            stream.envelope.is_error !== false ||
            stream.envelope.subtype !== "success"
          : stream instanceof CodexStream
            ? stream.incomplete() || stream.failure
            : !stream.completed || !stream.successful || !stream.lastMessage)
      )
        throw new Error(
          "Workflow did not produce exactly one complete successful structured result",
        );
      let value: unknown;
      try {
        value =
          stream instanceof ClaudeStream
            ? stream.envelope!.structured_output
            : JSON.parse(stream.lastMessage!);
      } catch {
        throw new Error(
          "Workflow final message was not a complete structured JSON result",
        );
      }
      if (request.kind === "review") validateReviewResult(value);
      else validateSchema(request.schema, value);
      return {
        value,
        log: `Docker execution ${run}; immutable profile ${snapshot.policy}; ${stream.decoder.diagnostic()}. Broker evidence: ${JSON.stringify(broker.evidence)}. Container evidence: ${JSON.stringify(boundaryEvidence)}. All owned processes and broker capabilities closed. Provider reads are recorded separately from fixture or live connection evidence.`,
      };
    } finally {
      broker.close();
    }
  }

  private async launch(
    input: Record<string, unknown>,
    sourceDir?: string,
    context?: {
      broker: WorkflowBroker;
      output: JsonLineDecoder;
      boundaryEvidence: Record<string, number>;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    if (this.closing) throw new Error("Executor is closing");
    let finished!: () => void;
    this.active.set(
      controller,
      new Promise<void>((resolve) => {
        finished = resolve;
      }),
    );
    const run = randomUUID();
    const name = `pr-review-${run}`;
    const work = path.join(this.directory, run);
    let child: ReturnType<typeof fork> | undefined;
    let completed: Promise<void> | undefined;
    const stop = () => {
      context?.broker.close();
      if (child?.connected) child.send({ type: "stop" }, () => {});
    };
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", stop, { once: true });
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let closed: { code: number; cleaned: boolean } | undefined;
    let gate = false;
    let outputBytes = 0;
    let failure: string | null = null;
    let fixtureStderr = "";
    const fixtureDiagnostics = Boolean(
      this.fixtureDiagnostic &&
      this.app.demo &&
      this.loaded?.config.auth === "fixture",
    );
    try {
      const initialization = dockerInputFrame({ ...input, fixtureDiagnostics });
      await mkdir(work, { mode: 0o700 });
      const controls: string[] = [];
      for (const file of [
        "entry.mjs",
        "gh.mjs",
        "codex.mjs",
        "harness.mjs",
        "pi.mjs",
        "workcopy.mjs",
        "local-mcp.mjs",
      ]) {
        const target = path.join(work, file);
        await copyFile(new URL(file, import.meta.url), target);
        await chmod(target, 0o555);
        controls.push(
          "--mount",
          `type=bind,src=${target},dst=/control/${file},readonly`,
        );
      }
      const policyPath = path.join(work, "policy.json");
      await writeFile(policyPath, policy, { mode: 0o400 });
      const mountSource = sourceDir ? await realpath(sourceDir) : null;
      if (mountSource?.includes(","))
        throw new Error("Unsupported source directory path");
      const args = [
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges=true",
        `--security-opt=seccomp=${policyPath}`,
        "--user=1000:1000",
        "--pids-limit=256",
        "--memory=3g",
        "--memory-swap=3g",
        "--cpus=3",
        "--ipc=private",
        "--cgroupns=private",
        "--log-driver=none",
        `--label=pr-review.executor.owner=${this.owner}`,
        `--label=pr-review.executor.run=${run}`,
        `--label=pr-review.executor.app-run=${input.appRun ?? "preflight"}`,
        "--tmpfs=/scratch:rw,nosuid,nodev,size=512m,mode=1777",
        "--tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777",
        "--workdir=/scratch",
        "-i",
        ...controls,
        ...(await runtimeMounts(this.loaded!.config)),
        ...(mountSource
          ? ["--mount", `type=bind,src=${mountSource},dst=/source,readonly`]
          : []),
        this.loaded!.config.image,
        "node",
        "/control/entry.mjs",
      ];
      controller.signal.throwIfAborted();
      child = fork(
        fileURLToPath(new URL("supervisor.mjs", import.meta.url)),
        [],
        {
          env: this.environment,
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const send = (message: unknown) => {
        if (child?.connected) child.send(message as object, () => {});
      };
      const decoder = new JsonLineDecoder((frame) => {
        if (
          frame.type === "fixture_diagnostic" &&
          fixtureDiagnostics &&
          typeof frame.data === "string"
        )
          fixtureStderr = (
            fixtureStderr + Buffer.from(frame.data, "base64").toString("utf8")
          ).slice(-8000);
        else if (
          frame.type === "boundary_evidence" &&
          context &&
          Object.keys(frame).every((key) =>
            [
              "type",
              "workcopyFiles",
              "workcopyBytes",
              "localInventories",
              "localReads",
              "localDenials",
            ].includes(key),
          ) &&
          Object.entries(frame).every(
            ([key, value]) =>
              key === "type" ||
              (Number.isSafeInteger(value) &&
                Number(value) >= 0 &&
                Number(value) <= 268435456),
          )
        ) {
          for (const [key, value] of Object.entries(frame))
            if (key !== "type") context.boundaryEvidence[key] = Number(value);
        } else if (
          frame.type === "preflight" &&
          input.preflight &&
          frame.ok === true
        )
          gate = true;
        else if (
          frame.type === "harness" &&
          context &&
          typeof frame.data === "string"
        )
          context.output.push(Buffer.from(frame.data, "base64"));
        else if (
          frame.type === "broker" &&
          context &&
          Number.isSafeInteger(frame.id) &&
          (frame.id as number) > 0
        ) {
          void context.broker
            .request(frame as unknown as BrokerRequest)
            .then((reply) =>
              send({
                type: "input",
                data: JSON.stringify({ ...reply, id: frame.id }) + "\n",
              }),
            );
        } else if (frame.type !== "exit") {
          failure = "Unexpected execution protocol frame";
          controller.abort();
        }
      }, 4000000);
      child.on("message", (message: any) => {
        if (message.type === "closed") closed = message;
        else if (message.type === "stdout") {
          const data = Buffer.from(message.data, "base64");
          outputBytes += data.length;
          if (outputBytes > 50000000) {
            failure = "Workflow output limit exceeded";
            controller.abort();
          } else decoder.push(data);
        } else if (message.type === "backpressure") {
          failure = "Execution input limit exceeded";
          controller.abort();
        }
      });
      completed = new Promise<void>((resolve, reject) => {
        child!.once("error", () =>
          reject(new Error("Unable to start trusted Docker supervisor")),
        );
        child!.once("exit", () => resolve());
      });
      send({
        type: "start",
        command: "/usr/local/bin/docker",
        base: ["--host", "unix:///var/run/docker.sock"],
        env: this.environment,
        name,
        args,
      });
      send({
        type: "input",
        data: initialization,
      });
      heartbeat = setInterval(
        () => send({ type: "input", data: '{"type":"heartbeat"}\n' }),
        1000,
      );
      timer = setTimeout(
        () => {
          failure = "Docker workflow timed out";
          controller.abort();
        },
        input.preflight ? 60000 : 20 * 60000,
      );
      await completed;
      context?.broker.close();
      decoder.end();
      if (!closed?.cleaned) {
        this.failure =
          "Docker cleanup could not be confirmed; restore the engine and restart for owned-container recovery";
        throw new Error(this.failure);
      }
      signal?.throwIfAborted();
      if (
        failure ||
        closed.code !== 0 ||
        decoder.stats.malformed ||
        decoder.stats.overflowed ||
        (input.preflight && !gate)
      )
        throw new Error(
          failure ??
            "Docker policy/runtime or harness execution failed; no unsandboxed fallback was used",
        );
    } finally {
      stop();
      await completed?.catch(() => {});
      if (fixtureStderr) this.fixtureDiagnostic?.(fixtureStderr);
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", stop);
      this.active.delete(controller);
      try {
        await rm(work, { recursive: true, force: true });
      } finally {
        finished();
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active.keys())
      controller.abort(new Error("Executor closing"));
    await Promise.all(this.active.values());
    if (!this.failure?.startsWith("Docker cleanup"))
      await rm(path.join(this.directory, "owner.json"), { force: true });
  }
}

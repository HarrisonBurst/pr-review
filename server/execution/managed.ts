import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  HarnessId,
  DockerSourceHandling,
  TrustedLibraryLeaf,
} from "../../shared/contracts.js";
import { selectDockerExclusions } from "./docker-exclusions.js";
import type { AppConfig } from "../config.js";
import { runCommand } from "../util.js";
import { bundleDigest, loadWorkflow, type WorkflowConfig } from "./config.js";
import {
  projectFiles,
  projectedSettings,
  type ProjectionSource,
} from "./projection.js";
import { digest, supportedImage } from "./policy.js";
import { loadSkill, nestedHarnesses } from "./skill.js";
import { dockerResourceLimits, portableResourceLimits } from "./harness.mjs";
import { resolveTrustedFile, readBoundedFile } from "./trusted-source.js";

export const managedSetupDisclosure =
  "First explicitly inspect the saved Docker selection and review its exact portable source identities, executable customizations, contained local MCP grants and temporary model credential exposures. All container code can read approved model access tokens; no business credentials or refresh material enter the container. Setup requires that exact fresh approval plus separate host-effects confirmation. It reads the disclosed resources, downloads pinned publisher-verified Linux runtimes and a Docker image when missing, runs a credential-free networked installer, writes app-owned cache/artifacts and performs credential-free runtime/policy preflight. It never installs Docker Desktop, selects a mode, enables automation, reads model credentials, logs in, refreshes auth or calls a model/provider. No review-time download or host fallback. Configured is not Connected.";

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function managedConfiguration(
  app: AppConfig,
  harness: HarnessId,
  bundle: string,
  env: NodeJS.ProcessEnv = process.env,
  exclusionIds: string[] = [],
  libraryLeaves: TrustedLibraryLeaf[] = [],
): Promise<WorkflowConfig> {
  const home = env.HOME ?? os.homedir();
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY",
  ]) {
    if (env[name])
      throw new Error(
        `Managed Docker does not support ${name}; it will not silently replace this configuration/auth provider. Keep using your existing mode or use a supported native configuration.`,
      );
  }
  const skill = await loadSkill(app.reviewer.skillPath, "docker");
  const nested = nestedHarnesses(skill).filter((item) => item !== harness);
  const required = new Set<HarnessId>([harness, ...nested]);
  const roots: Record<HarnessId, string[]> = {
    claude: [
      ".claude/settings.json",
      ".claude/CLAUDE.md",
      ".claude/agents",
      ".claude/skills",
    ],
    codex: [
      ".codex/config.toml",
      ".codex/AGENTS.md",
      ".codex/agents",
      ".codex/skills",
    ],
    pi: [
      ".pi/agent/settings.json",
      ".pi/agent/AGENTS.md",
      ".pi/agent/SYSTEM.md",
      ".pi/agent/APPEND_SYSTEM.md",
      ".pi/agent/extensions",
      ".pi/agent/skills",
      ".pi/agent/prompts",
    ],
  };
  const files: ProjectionSource[] = [];
  const trustedFiles = [app.reviewer.skillPath];
  for (const selected of required)
    for (const target of roots[selected]) {
      const source = path.join(home, target);
      if (await exists(source)) {
        files.push({ path: source, target });
        if (/\.(?:json|toml|md)$/.test(target)) trustedFiles.push(source);
      }
    }
  if (
    required.has("pi") &&
    (await exists(path.join(home, ".pi/agent/models.json")))
  )
    throw new Error(
      "Pi models.json custom providers require an unsupported transport; managed Docker will not replace them with another provider",
    );
  if (
    (required.has("codex") || required.has("pi")) &&
    (await exists(path.join(home, ".agents/skills")))
  )
    files.push({
      path: path.join(home, ".agents/skills"),
      target: ".agents/skills",
    });
  if (required.has("codex") && (await exists(path.join(home, ".codex/rules"))))
    throw new Error(
      "Codex rules are not portable in this Docker profile; no rule was silently omitted.",
    );
  files.push({
    path: path.dirname(app.reviewer.skillPath),
    target: `resources/${skill.directory}`,
  });
  const exclusions = await selectDockerExclusions(home, exclusionIds);
  const sourceHandling: DockerSourceHandling[] = [];
  const projected = await projectFiles(files, {
    files: trustedFiles,
    skillPath: app.reviewer.skillPath,
    docker: { home, handling: sourceHandling, exclusions, libraryLeaves },
  });
  if (
    skill.files.some(
      (file) =>
        JSON.stringify(
          projected.find((item) => item.target === file.target),
        ) !== JSON.stringify(file),
    )
  )
    throw new Error(
      "Selected skill changed during Docker capture; save and inspect again",
    );
  const settings = projectedSettings(projected);
  if (
    harness === "claude" &&
    settings.claude?.model &&
    app.reviewer.model &&
    settings.claude.model !== app.reviewer.model
  )
    throw new Error(
      "Claude user model and the app model override differ; managed Docker will not silently choose between them",
    );
  const models = {
    claude: String(
      (harness === "claude" ? app.reviewer.model : null) ??
        settings.claude?.model ??
        "claude-fable-5",
    ),
    codex: String(
      (harness !== "claude"
        ? app.reviewer.model?.replace(/^openai-codex\//, "")
        : null) ??
        settings.codex?.model ??
        settings.pi?.defaultModel ??
        "gpt-6-astra",
    ),
  };
  if (settings.pi?.defaultModel && settings.pi.defaultModel !== models.codex)
    throw new Error(
      "Pi and nested Codex have different model defaults; this single-pin Docker provider profile cannot preserve both. Neither setting was changed.",
    );
  const efforts = [...required]
    .map(
      (selected) =>
        settings[selected]?.[
          selected === "claude"
            ? "effortLevel"
            : selected === "codex"
              ? "model_reasoning_effort"
              : "defaultThinkingLevel"
        ],
    )
    .filter((value) => value !== undefined);
  if (
    efforts.some(
      (value) => !["low", "medium", "high"].includes(String(value)),
    ) ||
    new Set(efforts).size > 1
  )
    throw new Error(
      "Existing harness effort settings cannot be preserved by this single-effort Docker profile. Only matching low/medium/high settings are supported; no value was overwritten.",
    );
  return {
    version: 2,
    harness,
    nested,
    skillPath: app.reviewer.skillPath,
    files,
    frozen: {
      skill,
      files: projected,
      sourceHandling,
      exclusions,
      libraryLeaves,
    },
    image: supportedImage,
    bundle,
    auth: app.demo ? "fixture" : "native",
    models,
    effort: (efforts[0] ?? "medium") as WorkflowConfig["effort"],
    ...(app.demo ? { fixtureNative: true } : {}),
    ...(required.has("pi")
      ? { piAuthFile: path.join(home, ".pi/agent/auth.json") }
      : {}),
  };
}

export async function installManagedRuntime(
  root: string,
  run = runCommand,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const bundle = path.join(root, "runtime-v1");
  const record = path.join(root, "runtime-v1.digest");
  if (await exists(bundle)) {
    if (
      (await readFile(record, "utf8")).trim() !== (await bundleDigest(bundle))
    )
      throw new Error(
        "App-owned runtime cache changed. Remove only the app-owned managed Docker runtime cache and explicitly retry setup; no replacement or fallback was selected.",
      );
    return bundle;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(
      "Managed Docker requires the verified macOS arm64 / Docker Desktop Linux arm64 profile",
    );
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: path.join(root, "home"),
    DOCKER_CONFIG: path.join(root, "docker-config"),
  };
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  await mkdir(env.DOCKER_CONFIG, { recursive: true, mode: 0o700 });
  const docker = async (args: string[], timeoutMs = 20000) => {
    const result = await run(
      "/usr/local/bin/docker",
      ["--host", "unix:///var/run/docker.sock", ...args],
      {
        env,
        timeoutMs,
        maxOutputBytes: 200000,
        signal: args[0] === "rm" ? undefined : signal,
      },
    );
    if (result.code !== 0)
      throw new Error(
        `Managed Docker ${args[0]} failed. Check Docker Desktop and access to Docker Hub, registry.npmjs.org and signed Alpine v3.24 repositories, then explicitly retry setup. No mode was selected. Installer diagnostic: ${result.stderr.slice(-1500)}`,
      );
    return result;
  };
  const version = JSON.parse(
    (await docker(["version", "--format", "{{json .Server}}"])).stdout,
  );
  if (
    version.Version !== "29.8.0" ||
    version.GitCommit !== "3ce5872" ||
    version.Os !== "linux" ||
    version.Arch !== "arm64" ||
    version.KernelVersion !== "7.0.12-linuxkit"
  )
    throw new Error(
      "Unverified Docker profile: setup requires Engine 29.8.0 (3ce5872), Linux 7.0.12-linuxkit arm64. Install/start a supported Docker Desktop separately; the app does not install or reconfigure Docker.",
    );
  const image = await run(
    "/usr/local/bin/docker",
    [
      "--host",
      "unix:///var/run/docker.sock",
      "image",
      "inspect",
      supportedImage,
    ],
    { env, timeoutMs: 20000, signal },
  );
  if (image.code !== 0)
    await docker(
      ["pull", "--platform=linux/arm64", "node:22.23.2-alpine3.24"],
      5 * 60000,
    );
  const inspected = JSON.parse(
    (await docker(["image", "inspect", supportedImage])).stdout,
  )[0];
  if (
    inspected.Id !== supportedImage ||
    inspected.Architecture !== "arm64" ||
    inspected.Os !== "linux"
  )
    throw new Error(
      "Downloaded image does not match the verified immutable image. Setup stopped before runtime installation.",
    );
  const staging = await mkdtemp(path.join(root, "install-"));
  const name = `pr-review-setup-${randomUUID()}`;
  try {
    if (staging.includes(","))
      throw new Error(
        "Docker setup does not support commas in the app data path",
      );
    await docker(
      [
        "run",
        "--rm",
        "--name",
        name,
        "--pull=never",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--mount",
        `type=bind,src=${staging},dst=/bundle`,
        "--mount",
        `type=bind,src=${fileURLToPath(new URL("install-runtime.mjs", import.meta.url))},dst=/install.mjs,readonly`,
        supportedImage,
        "/bin/busybox",
        "timeout",
        "-k",
        "5",
        "900",
        "node",
        "/install.mjs",
      ],
      15 * 60000,
    );
    signal?.throwIfAborted();
    await writeFile(record, await bundleDigest(staging), { mode: 0o600 });
    await rename(staging, bundle);
    return bundle;
  } finally {
    await docker(["rm", "--force", name]).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}

export async function prepareManagedWorkflow(
  app: AppConfig,
  harness: HarnessId,
  env: NodeJS.ProcessEnv = process.env,
  install = installManagedRuntime,
  signal?: AbortSignal,
  prepared?: WorkflowConfig,
): Promise<string> {
  signal?.throwIfAborted();
  const root = path.join(app.dataDir, "managed-docker");
  const config =
    prepared ??
    (await managedConfiguration(
      app,
      harness,
      path.join(root, "runtime-v1"),
      env,
    ));
  if (
    Buffer.byteLength(JSON.stringify(config)) >
    dockerResourceLimits.workflowBytes
  )
    throw new Error(
      "Docker workflow exceeds 32 MB serialized persistence limit",
    );
  await readBoundedFile(
    (await resolveTrustedFile(config.skillPath!)).path,
    portableResourceLimits.fileBytes,
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  config.bundle = await install(root, undefined, signal);
  signal?.throwIfAborted();
  const text = JSON.stringify(config);
  if (Buffer.byteLength(text) > dockerResourceLimits.workflowBytes)
    throw new Error(
      "Docker workflow exceeds 32 MB serialized persistence limit",
    );
  const file = path.join(root, `${digest(text)}.json`);
  await writeFile(file, text, { mode: 0o600 });
  await loadWorkflow(file, app.reviewer.skillPath, app.demo);
  return file;
}

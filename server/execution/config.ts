import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  DockerBoundarySnapshot,
  DockerExclusion,
  DockerSourceHandling,
  ExecutionSnapshot,
  HarnessId,
  SkillSnapshot,
  TrustedLibraryLeaf,
} from "../../shared/contracts.js";
import {
  projectFiles,
  projectedSettings,
  type ProjectedFile,
  type ProjectionSource,
} from "./projection.js";
import { digest, policyDigest, supportedImage } from "./policy.js";
import { brokerDigestV2 } from "./broker.js";
import { loadSkill } from "./skill.js";
import { requireDockerApproval } from "./docker-capabilities.js";
import {
  resourceBytes,
  dockerResourceLimits,
  portableResourceLimits,
} from "./harness.mjs";
import { readBoundedFile } from "./trusted-source.js";
import { describeLibraryLeaf } from "./docker-library.js";

export interface WorkflowConfig {
  version: 2;
  docker?: DockerBoundarySnapshot;
  frozen?: {
    skill: SkillSnapshot;
    files: ProjectedFile[];
    sourceHandling?: DockerSourceHandling[];
    exclusions?: DockerExclusion[];
    libraryLeaves?: TrustedLibraryLeaf[];
  };
  harness: HarnessId;
  skillPath?: string;
  files?: ProjectionSource[];
  piAuthFile?: string;
  authHome?: string;
  nested?: HarnessId[];
  fixtureNative?: boolean;
  image: string;
  bundle: string;
  auth: "native" | "fixture";
  models: ExecutionSnapshot["models"];
  effort: "low" | "medium" | "high";
}

export async function bundleDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  async function visit(relative: string): Promise<void> {
    if (++count > 20000) throw new Error("Runtime bundle has too many entries");
    const file = path.join(root, relative);
    const info = await lstat(file);
    hash.update(JSON.stringify([relative, info.mode]));
    if (info.isSymbolicLink()) hash.update(await readlink(file));
    else if (info.isDirectory()) {
      for (const entry of (await readdir(file)).sort())
        await visit(path.join(relative, entry));
    } else if (info.isFile()) {
      for await (const chunk of createReadStream(file)) hash.update(chunk);
    } else throw new Error("Runtime bundle contains a special file");
  }
  await visit("");
  return hash.digest("hex");
}

export async function loadWorkflow(
  file: string,
  skillPath: string,
  demo: boolean,
): Promise<{
  config: WorkflowConfig;
  snapshot: ExecutionSnapshot;
  skill: string;
  files: ProjectedFile[];
  projectedSettings: Record<string, Record<string, unknown>>;
}> {
  const text = (
    await readBoundedFile(file, dockerResourceLimits.workflowBytes)
  ).toString("utf8");
  let value: WorkflowConfig;
  try {
    value = JSON.parse(text) as WorkflowConfig;
  } catch {
    throw new Error("Workflow configuration must be valid JSON");
  }
  if (!value || typeof value !== "object")
    throw new Error("Workflow configuration must be an object");
  if (
    value.version !== 2 ||
    !["claude", "codex", "pi"].includes(value.harness) ||
    value.image !== supportedImage ||
    !path.isAbsolute(value.bundle ?? "") ||
    !["native", "fixture"].includes(value.auth) ||
    !["low", "medium", "high"].includes(value.effort) ||
    !/^[a-z0-9.-]{1,100}$/.test(value.models?.claude ?? "") ||
    !/^[a-z0-9.-]{1,100}$/.test(value.models?.codex ?? "") ||
    Object.keys(value.models).some(
      (key) => !["claude", "codex"].includes(key),
    ) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "harness",
          "image",
          "bundle",
          "auth",
          "models",
          "effort",
          "skillPath",
          "files",
          "piAuthFile",
          "authHome",
          "nested",
          "fixtureNative",
          "docker",
          "frozen",
        ].includes(key),
    )
  )
    throw new Error(
      "Unsupported workflow configuration; use the documented pinned Docker workflow format",
    );
  if (
    value.fixtureNative !== undefined &&
    (typeof value.fixtureNative !== "boolean" || value.auth !== "fixture")
  )
    throw new Error("Native fixtures require explicit fixture authentication");
  if (value.auth === "fixture" && !demo)
    throw new Error("Fixture execution requires explicit demo mode");
  if (
    !Array.isArray(value.nested) ||
    value.nested.length > 3 ||
    value.nested.some((harness) => !["claude", "codex", "pi"].includes(harness))
  )
    throw new Error(
      "Nested harnesses must explicitly name claude, codex or pi",
    );
  if (value.skillPath !== undefined && !path.isAbsolute(value.skillPath))
    throw new Error("Workflow skillPath must be absolute");
  if (value.piAuthFile !== undefined && !path.isAbsolute(value.piAuthFile))
    throw new Error(
      "Pi authentication requires an explicit absolute auth.json source",
    );
  if (
    (value.harness === "pi" || value.nested?.includes("pi")) &&
    value.auth === "native" &&
    !value.piAuthFile
  )
    throw new Error(
      "Pi requires its own explicit auth.json source; another harness login is never substituted",
    );
  const config = { ...value, bundle: await realpath(value.bundle) };
  const files = value.frozen?.files ?? (await projectFiles(value.files ?? []));
  const selectedSkill =
    value.frozen?.skill ??
    (await loadSkill(value.skillPath ?? skillPath, "docker"));
  for (const file of selectedSkill.files)
    if (!files.some((item) => item.target === file.target)) files.push(file);
  const limits = config.docker ? dockerResourceLimits : portableResourceLimits;
  if (
    files.length > limits.entries ||
    files.reduce(
      (sum, file) => sum + resourceBytes(file, Boolean(config.docker)).length,
      0,
    ) > limits.decodedBytes ||
    Buffer.byteLength(JSON.stringify(files)) >
      dockerResourceLimits.serializedBytes ||
    (!config.docker && Buffer.byteLength(text) > 5000000)
  )
    throw new Error(
      `Captured workflow resources exceed ${limits.decodedBytes / 1000000} MB decoded bytes or serialized limits`,
    );
  for (const file of selectedSkill.files)
    resourceBytes(file, Boolean(config.docker));
  if (config.docker) {
    const disclosure = config.docker.disclosure;
    requireDockerApproval(disclosure, config.docker.approval);
    if (
      config.docker.profile !== "container-native-1" ||
      disclosure.harness !== config.harness ||
      disclosure.skillDigest !== selectedSkill.digest ||
      JSON.stringify(disclosure.sourceHandling ?? []) !==
        JSON.stringify(config.frozen?.sourceHandling ?? []) ||
      JSON.stringify(disclosure.exclusions ?? []) !==
        JSON.stringify(config.frozen?.exclusions ?? []) ||
      JSON.stringify(disclosure.libraryLeaves ?? []) !==
        JSON.stringify(
          (config.frozen?.libraryLeaves ?? []).map(describeLibraryLeaf),
        ) ||
      disclosure.model.replace(/^openai-codex\//, "") !==
        config.models[config.harness === "claude" ? "claude" : "codex"] ||
      JSON.stringify(
        [...new Set([config.harness, ...(config.nested ?? [])])].sort(),
      ) !==
        JSON.stringify(
          disclosure.authentication.map((item) => item.harness).sort(),
        ) ||
      files.some(
        (file) =>
          !disclosure.resources.some(
            (resource) =>
              resource.target === file.target &&
              resource.source === file.sourcePath &&
              resource.resolvedSourcePath === file.resolvedSourcePath &&
              resource.sourceDigest === file.sourceDigest &&
              resource.inputDigest === file.inputDigest &&
              resource.encoding === file.encoding &&
              resource.mediaType === file.mediaType &&
              resource.bytes ===
                (file.mediaType
                  ? resourceBytes(file, true).length
                  : undefined) &&
              resource.digest === digest(resourceBytes(file, true)) &&
              resource.executable === file.executable,
          ),
      )
    )
      throw new Error(
        "Docker captured capabilities no longer match the exact approved configuration",
      );
  }
  const skill = resourceBytes(
    selectedSkill.files.find((file) => file.sourcePath === selectedSkill.path)!,
  ).toString("utf8");
  if (skill.length > 200000) throw new Error("Workflow skill is too large");
  for (const file of selectedSkill.files.filter(
    (file) => file.encoding !== "base64",
  ))
    for (const command of file.content.matchAll(
      /\b(claude|codex|pi)\s+([^\n]*?)(?:--model|-m)\s+["']?([a-zA-Z0-9._/:-]+)/g,
    )) {
      const expected =
        config.models[command[1] === "claude" ? "claude" : "codex"];
      if (command[3].replace(/^openai-codex\//, "") !== expected)
        throw new Error(
          `Docker model conflict in ${file.sourcePath}: skill-pinned ${command[1]} model ${command[3]} differs from broker pin ${expected}. Align the explicit selection/native defaults with the skill or choose Dangerous; nested commands are never silently rewritten.`,
        );
    }
  const runtime = await bundleDigest(config.bundle);
  const controls = await Promise.all(
    [
      "entry.mjs",
      "gh.mjs",
      "codex.mjs",
      "harness.mjs",
      "pi.mjs",
      "supervisor.mjs",
      "workcopy.mjs",
      "local-mcp.mjs",
    ].map(async (name) =>
      digest(await readFile(new URL(name, import.meta.url), "utf8")),
    ),
  );
  const activeBrokerDigest = brokerDigestV2;
  const snapshot: ExecutionSnapshot = {
    version: value.version,
    ...(config.docker ? { docker: config.docker } : {}),
    digest: digest(
      JSON.stringify({
        config,
        sourceText: text,
        runtime,
        skill,
        files,
        controls,
        policyDigest,
        brokerDigest: activeBrokerDigest,
      }),
    ),
    image: config.image,
    policy: policyDigest,
    broker: activeBrokerDigest,
    models: config.models,
    harness: config.harness,
    skillDigest: selectedSkill.digest,
    fixture: config.auth === "fixture",
  };
  const settings = projectedSettings(files);
  if (
    (settings.claude?.model &&
      settings.claude.model !== config.models.claude) ||
    (settings.codex?.model && settings.codex.model !== config.models.codex) ||
    (settings.pi?.defaultModel &&
      settings.pi.defaultModel !== config.models.codex)
  )
    throw new Error(
      "Projected model defaults differ from the explicit workflow pins; align the workflow config with the existing selected defaults before importing",
    );
  return { config, snapshot, skill, files, projectedSettings: settings };
}

export async function runtimeMounts(config: WorkflowConfig): Promise<string[]> {
  const entries: [string, string][] =
    config.auth === "fixture" && !config.fixtureNative
      ? [["fixture.mjs", "/runtime/fixture.mjs"]]
      : [
          ["artifacts", "/artifacts"],
          ["runtime", "/runtime"],
          ["runtime/bin/bash", "/bin/bash"],
          ["runtime/usr/bin/git", "/usr/bin/git"],
          ["runtime/usr/bin/rg", "/usr/bin/rg"],
          ["runtime/usr/libexec/git-core", "/usr/libexec/git-core"],
          ...(await readdir(path.join(config.bundle, "runtime/usr/lib")))
            .filter((name) => name.includes(".so"))
            .map(
              (name) =>
                [`runtime/usr/lib/${name}`, `/usr/lib/${name}`] as [
                  string,
                  string,
                ],
            ),
        ];
  const args: string[] = [];
  for (const [relative, target] of entries) {
    const source = await realpath(path.join(config.bundle, relative));
    if (!source.startsWith(`${config.bundle}/`) || source.includes(","))
      throw new Error("Runtime mount escapes its configured bundle");
    args.push("--mount", `type=bind,src=${source},dst=${target},readonly`);
  }
  return args;
}

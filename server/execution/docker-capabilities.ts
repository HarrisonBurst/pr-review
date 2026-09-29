import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  DockerCapabilityApproval,
  DockerCapabilityDisclosure,
  DockerLocalMcpRequest,
  HarnessId,
  IntegrationConfig,
  TrustedLibraryLeaf,
} from "../../shared/contracts.js";
import { dockerApprovalConfirmation } from "../../shared/contracts.js";
import type { AppConfig } from "../config.js";
import { knownMcpProfiles } from "../mcp-profiles.js";
import { resolveDockerStdio } from "../native-mcp.js";
import { managedConfiguration } from "./managed.js";
import type { WorkflowConfig } from "./config.js";
import { projectFiles, projectedSettings } from "./projection.js";
import { loadSkill } from "./skill.js";
import { digest } from "./policy.js";
import { resourceBytes, dockerResourceLimits } from "./harness.mjs";
import { describeLibraryLeaf } from "./docker-library.js";

export function requireDockerApproval(
  disclosure: DockerCapabilityDisclosure,
  approval: DockerCapabilityApproval | undefined,
): asserts approval is DockerCapabilityApproval {
  const same = (a: string[], b: string[]) =>
    Array.isArray(a) &&
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
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
    disclosure.digest !==
      digest(JSON.stringify({ ...disclosure, digest: "" })) ||
    approval.confirmation !== dockerApprovalConfirmation ||
    approval.digest !== disclosure.digest ||
    !same(
      approval.libraryLeaves ?? [],
      (disclosure.libraryLeaves ?? []).map((leaf) => leaf.id),
    ) ||
    !same(
      approval.exclusions ?? [],
      (disclosure.exclusions ?? []).map((item) => item.id),
    ) ||
    !same(
      approval.customizations,
      disclosure.customizations.map((item) => item.id),
    ) ||
    !same(
      approval.credentialExposures,
      disclosure.authentication.map((item) => item.harness),
    )
  )
    throw new Error(
      "Docker capability approval is missing or changed. Inspect the saved Docker selection, review every source/capability and temporary model credential exposure, then explicitly approve that exact disclosure before setup. Old setup confirmation grants none of these capabilities.",
    );
}

export async function inspectDockerCapabilities(
  app: AppConfig,
  harness: HarnessId,
  env: NodeJS.ProcessEnv,
  requests: DockerLocalMcpRequest[] = [],
  connections: IntegrationConfig[] = [],
  exclusions: string[] = [],
  libraryLeaves: TrustedLibraryLeaf[] = [],
) {
  const config = await managedConfiguration(
    app,
    harness,
    path.join(app.dataDir, "managed-docker/runtime-v1"),
    env,
    exclusions,
    libraryLeaves,
  );
  return captureDockerCapabilities(app, config, env, requests, connections);
}

export async function captureDockerCapabilities(
  app: AppConfig,
  config: WorkflowConfig,
  env: NodeJS.ProcessEnv,
  requests: DockerLocalMcpRequest[] = [],
  connections: IntegrationConfig[] = [],
) {
  const harness = config.harness;
  const files =
    config.frozen?.files ?? (await projectFiles(config.files ?? []));
  const skill =
    config.frozen?.skill ??
    (await loadSkill(config.skillPath ?? app.reviewer.skillPath, "docker"));
  for (const file of skill.files)
    if (!files.some((item) => item.target === file.target)) files.push(file);
  const settings = projectedSettings(files);
  const customizations: DockerCapabilityDisclosure["customizations"] = [];
  const capabilities = [
    "arbitrary code inside the container",
    "read/write disposable workcopy and scratch",
    "read all temporarily exposed model access credentials",
    "use captured model/read brokers, never additional mounts or external network",
  ];
  const add = (
    selected: HarnessId,
    kind: (typeof customizations)[number]["kind"],
    source: string,
    content: string,
  ) => {
    const hash = digest(content);
    const id = digest(`${selected}:${kind}:${source}:${hash}`);
    if (!customizations.some((item) => item.id === id))
      customizations.push({
        id,
        harness: selected,
        kind,
        source,
        digest: hash,
        capabilities,
      });
  };
  const required = [...new Set([harness, ...(config.nested ?? [])])];
  for (const selected of required) {
    if (settings[selected]?.hooks)
      add(
        selected,
        "hooks",
        selected === "codex"
          ? path.join(env.HOME!, ".codex/config.toml")
          : path.join(env.HOME!, ".claude/settings.json"),
        JSON.stringify(settings[selected].hooks),
      );
    if (settings[selected]?.shellCommandPrefix)
      add(
        selected,
        "shell-prefix",
        path.join(env.HOME!, ".pi/agent/settings.json"),
        String(settings[selected].shellCommandPrefix),
      );
  }
  for (const file of files) {
    resourceBytes(file, true);
    if (file.encoding === "base64") continue;
    if (
      file.target.startsWith(".pi/agent/extensions/") ||
      (settings.pi?.extensions as string[] | undefined)?.some((reference) => {
        const resolved = path.posix.resolve("/scratch/.pi/agent", reference);
        return (
          `/scratch/${file.target}` === resolved ||
          `/scratch/${file.target}`.startsWith(resolved + "/")
        );
      })
    )
      add("pi", "extensions", file.sourcePath, file.content);
    else if (file.executable || /\.(?:m?js|cjs|ts|sh|py)$/.test(file.target))
      add(harness, "skill-code", file.sourcePath, file.content);
  }
  if (
    !Array.isArray(requests) ||
    requests.length > 8 ||
    new Set(requests.map((item) => item.id)).size !== requests.length
  )
    throw new Error(
      "Declare at most eight distinct discovered Docker local connections",
    );
  const localConnections: DockerCapabilityDisclosure["localConnections"] = [];
  for (const request of requests) {
    const connection = connections.find((item) => item.id === request.id);
    const profile = knownMcpProfiles.find(
      (item) => item.id === request.profileId,
    );
    if (
      !connection?.native ||
      connection.native.transport !== "stdio" ||
      !profile ||
      !Array.isArray(request.scope) ||
      !request.scope.length ||
      request.scope.length > 100 ||
      request.scope.some(
        (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id),
      ) ||
      typeof request.enabled !== "boolean" ||
      !Array.isArray(request.allowedTools) ||
      request.allowedTools.some((id) => id !== profile.tool.id) ||
      Object.keys(request).some(
        (key) =>
          !["id", "profileId", "scope", "enabled", "allowedTools"].includes(
            key,
          ),
      )
    )
      throw new Error(
        "Docker local MCP requires a discovered stdio identity, known profile, exact resource scope and explicit default-denied tool choices",
      );
    const entry = await resolveDockerStdio(connection.native);
    const target = `resources/.local-mcp/${digest(request.id).slice(0, 16)}`;
    const resources = await projectFiles([
      { path: path.dirname(entry), target },
    ]);
    const sourceDigest = digest(JSON.stringify(resources));
    if (request.enabled && request.allowedTools.includes(profile.tool.id))
      files.push(...resources);
    localConnections.push({
      request,
      native: connection.native,
      profile,
      profileDigest: digest(JSON.stringify(profile)),
      sourceDigest,
      target: `${target}/${path.basename(entry)}`,
      transport: "container-stdio",
      inventory: "not_tested",
      connected: false,
    });
  }
  if (
    files.length > dockerResourceLimits.entries ||
    files.reduce((sum, file) => sum + resourceBytes(file, true).length, 0) >
      dockerResourceLimits.decodedBytes ||
    Buffer.byteLength(JSON.stringify(files)) >
      dockerResourceLimits.serializedBytes
  )
    throw new Error(
      "Docker portable capture exceeds 2000 files, 8 MB decoded resources or 16 MB serialized data",
    );
  const authentication: DockerCapabilityDisclosure["authentication"] =
    await Promise.all(
      required.map(async (selected) => {
        const source =
          selected === "claude"
            ? "Claude Code-credentials (default macOS keychain)"
            : path.join(
                env.HOME!,
                selected === "codex"
                  ? ".codex/auth.json"
                  : ".pi/agent/auth.json",
              );
        return {
          harness: selected,
          source,
          presence:
            selected === "claude"
              ? "not_checked"
              : (await lstat(source).catch(() => null))
                ? "present"
                : "missing",
          compatibility: "supported_reference",
          tested: false,
          exposure: "temporary-container-access-token",
          readers: "all-container-code",
          refresh: false,
        };
      }),
    );
  const value: DockerCapabilityDisclosure = {
    version: 1,
    profile: "container-native-1",
    digest: "",
    harness,
    model: config.models[harness === "claude" ? "claude" : "codex"],
    skillPath: skill.path,
    skillDigest: skill.digest,
    resources: files.map((file) => ({
      source: file.sourcePath,
      target: file.target,
      digest: digest(resourceBytes(file, true)),
      executable: file.executable,
      ...(file.encoding ? { encoding: file.encoding } : {}),
      ...(file.mediaType
        ? { mediaType: file.mediaType, bytes: resourceBytes(file, true).length }
        : {}),
      ...(file.inputDigest ? { inputDigest: file.inputDigest } : {}),
      ...(file.resolvedSourcePath
        ? {
            resolvedSourcePath: file.resolvedSourcePath,
            sourceDigest: file.sourceDigest,
          }
        : {}),
    })),
    ...(config.frozen?.sourceHandling
      ? { sourceHandling: config.frozen.sourceHandling }
      : {}),
    ...(config.frozen?.exclusions
      ? { exclusions: config.frozen.exclusions }
      : {}),
    ...(config.frozen?.libraryLeaves
      ? { libraryLeaves: config.frozen.libraryLeaves.map(describeLibraryLeaf) }
      : {}),
    customizations,
    authentication,
    localConnections,
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
  value.digest = digest(JSON.stringify(value));
  return {
    disclosure: value,
    config: {
      ...config,
      authHome: env.HOME!,
      files: undefined,
      frozen: { ...config.frozen, skill, files },
    },
  };
}

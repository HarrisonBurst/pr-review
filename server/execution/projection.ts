import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { digest } from "./policy.js";
import { canonicalJson } from "../schema.js";
import {
  companionMediaType,
  portableResourceLimits,
  dockerResourceLimits,
} from "./harness.mjs";
import type {
  CapturedResource,
  DockerExclusion,
  DockerSourceHandling,
  TrustedLibraryLeaf,
} from "../../shared/contracts.js";
import {
  rejectCredentialSource,
  readBoundedFile,
  resolveTrustedFile,
  resolveTrustedSource,
} from "./trusted-source.js";

export interface ProjectionSource {
  path: string;
  target: string;
}

export type ProjectedFile = CapturedResource;

export interface ProjectionMetadata {
  source: string;
  target: string;
  kind: "file" | "directory";
  bytes: number;
  executable: boolean;
  resolvedSourcePath?: string;
  sourceDigest?: string;
}

export const nativeLibraryRoots = [
  ".claude/skills",
  ".claude/agents",
  ".agents/skills",
  ".codex/skills",
  ".codex/agents",
  ".pi/agent/skills",
  ".pi/agent/prompts",
];

export function settingsObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {}
  throw new Error("Projected settings must be a JSON object");
}

export const slackPlugin = "slack@claude-plugins-official";

export function slackPluginOnly(
  value: unknown,
): value is Record<typeof slackPlugin, true> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, slackPlugin) &&
    (value as Record<string, unknown>)[slackPlugin] === true,
  );
}

export function googleWorkspaceProjection(
  manifest: ProjectedFile,
  files: ProjectedFile[],
  handling: DockerSourceHandling[],
) {
  if (
    !/^\.claude\/skills\/synced\/[^/]+\/manifest\.json$/.test(manifest.target)
  )
    return null;
  const value = settingsObject(manifest.content);
  if (
    !Array.isArray(value.skills) ||
    (value.pendingClaims !== undefined &&
      (!Array.isArray(value.pendingClaims) ||
        value.pendingClaims.some((item) => typeof item !== "string")))
  )
    return null;
  const entries = value.skills
    .map((item: any, index: number) => ({ item, index }))
    .filter(({ item }) => item?.skillId === "google-workspace");
  if (
    entries.length !== 1 ||
    entries[0].item.name !== "google-workspace" ||
    Object.entries(entries[0].item).some(
      ([key, item]) =>
        !["skillId", "name", "description", "source", "updatedAt"].includes(
          key,
        ) || typeof item !== "string",
    )
  )
    return null;
  const target = path.posix.join(
    path.posix.dirname(manifest.target),
    "google-workspace",
  );
  const source = path.join(
    path.dirname(manifest.sourcePath),
    "google-workspace",
  );
  const omitted = files.filter((file) => file.target.startsWith(target + "/"));
  const expected = [
    "SKILL.md",
    "references/charts.md",
    "references/docs.md",
    "references/sheets.md",
    "references/slides.md",
    "scripts/docs_index.py",
    "scripts/render_export.py",
    "scripts/sheets_helper.py",
    "scripts/slides_helper.py",
  ];
  if (
    JSON.stringify(
      omitted.map((file) => file.target.slice(target.length + 1)).sort(),
    ) !== JSON.stringify(expected)
  )
    return null;
  const layout = handling.filter(
    (item) =>
      item.source === source || item.source.startsWith(source + path.sep),
  );
  const claims = (value.pendingClaims as string[] | undefined) ?? [];
  const removedClaims = claims.filter((item) =>
    /^[^/\r\n\0]+\/google-workspace$/.test(item),
  );
  const definition = JSON.stringify({
    skill: entries[0],
    pendingClaims: removedClaims,
    files: omitted.map(({ content, ...identity }) => ({
      ...identity,
      digest: digest(content),
    })),
    layout,
  });
  return {
    sourceDigest: digest(JSON.stringify({ manifest, omitted, layout })),
    pointer: `/skills/${entries[0].index}`,
    itemDigest: digest(definition),
    definition,
    omitted,
    layout,
    content: JSON.stringify({
      ...value,
      skills: value.skills.filter(
        (_: unknown, index: number) => index !== entries[0].index,
      ),
      ...(value.pendingClaims !== undefined
        ? {
            pendingClaims: claims.filter(
              (item) => !removedClaims.includes(item),
            ),
          }
        : {}),
    }),
  };
}

export function codexSettings(text: string): Record<string, unknown> {
  try {
    return parse(text);
  } catch {
    throw new Error("Projected Codex configuration must be valid TOML");
  }
}

function codexHooks(settings: Record<string, any>, source: string): void {
  if (!settings.hooks) return;
  const hooks = settings.hooks;
  const events = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
  ];
  const states: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === "state") continue;
    if (!events.includes(event) || !Array.isArray(groups))
      throw new Error(`Unsupported Codex hook event ${event}`);
    const label = event.replace(
      /[A-Z]/g,
      (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`,
    );
    for (const [groupIndex, group] of groups.entries()) {
      if (
        !group ||
        !Array.isArray(group.hooks) ||
        Object.keys(group).some((key) => !["matcher", "hooks"].includes(key))
      )
        throw new Error("Unsupported Codex hook matcher group");
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        const suffix = `:${label}:${groupIndex}:${handlerIndex}`;
        const state =
          hooks.state?.[`${source}${suffix}`] ??
          hooks.state?.[`/scratch/.codex/config.toml${suffix}`];
        if (
          !state ||
          (state.enabled !== false && typeof state.trusted_hash !== "string")
        )
          throw new Error(
            `Codex ${event} hook ${groupIndex}:${handlerIndex} has no explicit saved trust. Review it in the source harness before importing; hook trust is never bypassed`,
          );
        if (
          !handler ||
          handler.type !== "command" ||
          typeof handler.command !== "string" ||
          !handler.command.trim() ||
          Object.keys(handler).some(
            (key) =>
              ![
                "type",
                "command",
                "timeout",
                "async",
                "statusMessage",
                "additionalContextLimit",
              ].includes(key),
          )
        )
          throw new Error(
            `Codex ${event} requires a supported portable command hook; unsupported handlers are not silently skipped`,
          );
        const normalized: Record<string, unknown> = {
          type: "command",
          command: handler.command,
          timeout: ["SessionEnd", "Interrupt"].includes(event)
            ? Math.min(3, Math.max(1, handler.timeout ?? 1))
            : Math.max(1, handler.timeout ?? 600),
          async: handler.async ?? false,
        };
        if (handler.statusMessage !== undefined)
          normalized.statusMessage = handler.statusMessage;
        if (
          handler.additionalContextLimit !== undefined &&
          handler.additionalContextLimit !== 2500
        )
          normalized.additionalContextLimit = handler.additionalContextLimit;
        const identity: Record<string, unknown> = {
          event_name: label,
          hooks: [normalized],
        };
        if (
          !["UserPromptSubmit", "SubagentStop", "Stop", "Interrupt"].includes(
            event,
          ) &&
          group.matcher &&
          group.matcher !== "*"
        )
          identity.matcher = group.matcher;
        if (
          state.enabled !== false &&
          state.trusted_hash !== `sha256:${digest(canonicalJson(identity))}`
        )
          throw new Error(
            `Codex ${event} hook trust does not match its exact supported definition; re-review the source hook, not a bypass flag`,
          );
        states[`/scratch/.codex/config.toml${suffix}`] = state;
      }
    }
  }
  settings.hooks = { ...hooks, state: states };
}

export function projectedSettings(
  files: ProjectedFile[],
): Record<string, Record<string, unknown>> {
  const settings: Record<string, Record<string, unknown>> = {};
  for (const [harness, target] of Object.entries({
    claude: ".claude/settings.json",
    codex: ".codex/config.toml",
    pi: ".pi/agent/settings.json",
  })) {
    const file = files.find((file) => file.target === target);
    if (file) {
      settings[harness] =
        harness === "codex"
          ? codexSettings(file.content)
          : settingsObject(file.content);
      if (harness === "codex") codexHooks(settings[harness], file.sourcePath);
    }
  }
  return settings;
}

export async function projectFiles(
  sources: ProjectionSource[],
  trusted: {
    files?: string[];
    skillPath?: string;
    rawSettings?: boolean;
    opaqueAssets?: boolean;
    metadata?: ProjectionMetadata[];
    docker?: {
      home: string;
      handling: DockerSourceHandling[];
      exclusions: DockerExclusion[];
      libraryLeaves?: TrustedLibraryLeaf[];
    };
  } = {},
): Promise<ProjectedFile[]> {
  const limits =
    trusted.docker || trusted.opaqueAssets
      ? dockerResourceLimits
      : portableResourceLimits;
  if (!Array.isArray(sources) || sources.length > limits.sources)
    throw new Error("At most 100 explicit projection sources are supported");
  if (trusted.metadata && !trusted.docker)
    throw new Error(
      "Metadata sizing is limited to explicit Docker projection sources",
    );
  const files: ProjectedFile[] = [];
  let bytes = 0;
  let serializedBytes = 2;
  const targets = new Set<string>();
  const canonicalHome = trusted.docker
    ? (await resolveTrustedSource(trusted.docker.home, "directory")).path
    : undefined;
  const libraryRoots = nativeLibraryRoots;
  const activeDirectories = new Set<string>();
  const instructionImports = new Set<string>();
  const activeInstructions = new Set<string>();
  const inside = (root: string, value: string) =>
    value === root || value.startsWith(root + path.sep);
  const libraryLeaves = trusted.docker?.libraryLeaves ?? [];
  if (
    libraryLeaves.length > 8 ||
    new Set(libraryLeaves.map((leaf) => leaf.source)).size !==
      libraryLeaves.length
  )
    throw new Error(
      "Explicit library read scope requires at most eight distinct installed skill leaves",
    );
  const leafStates = new Map<string, string>();
  const leafUsage = new Map<string, { entries: number; bytes: number }>();
  for (const leaf of libraryLeaves) {
    if (
      Object.keys(leaf).some(
        (key) =>
          !["source", "resolvedSourcePath", "sourceDigest"].includes(key),
      ) ||
      !libraryRoots
        .filter((root) => root.endsWith("/skills"))
        .some(
          (root) =>
            path.dirname(leaf.source) === path.join(trusted.docker!.home, root),
        ) ||
      !/^[A-Za-z0-9_-]+$/.test(path.basename(leaf.source))
    )
      throw new Error(
        "Explicit library read scope must name one installed skill leaf, never its parent library or repository",
      );
    const resolved = await resolveTrustedSource(leaf.source, "directory");
    if (
      resolved.path !== leaf.resolvedSourcePath ||
      resolved.identity !== leaf.sourceDigest
    )
      throw new Error(
        "Explicit library read scope changed; no leaf contents were read",
      );
    leafStates.set(leaf.source, resolved.state);
  }
  const allowedLibrary = (value: string) =>
    trusted.docker &&
    (libraryRoots.some((root) =>
      inside(path.join(canonicalHome!, root), value),
    ) ||
      /^\/nix\/store\/[^/]+(?:\/|$)/.test(value));
  async function visit(
    source: string,
    target: string,
    imported = false,
  ): Promise<void> {
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      !path.isAbsolute(source) ||
      !/^(?:resources(?:\/|$)|\.claude\/(?:settings\.json$|(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$|agents(?:\/|$)|skills(?:\/|$))|\.agents\/skills(?:\/|$)|\.codex\/(?:config\.toml$|AGENTS\.md$|agents(?:\/|$)|skills(?:\/|$))|\.pi\/agent\/(?:settings\.json$|AGENTS\.md$|SYSTEM\.md$|APPEND_SYSTEM\.md$|extensions(?:\/|$)|skills(?:\/|$)|prompts(?:\/|$)))/.test(
        target,
      ) ||
      target
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      target.includes("\\") ||
      targets.has(target)
    )
      throw new Error(
        "Projection requires unique explicit resource paths inside the documented scratch configuration roots",
      );
    targets.add(target);
    if (targets.size > limits.entries)
      throw new Error("Projection exceeds 2000 entries");
    rejectCredentialSource(source);
    const library = Boolean(
      trusted.docker &&
      libraryRoots.some(
        (root) => target === root || target.startsWith(root + "/"),
      ),
    );
    let resolution;
    let libraryDirectory = false;
    if (library) {
      try {
        resolution = await resolveTrustedSource(source, "directory");
        libraryDirectory = true;
      } catch {
        resolution = await resolveTrustedFile(source);
      }
      const leaf = libraryLeaves.find((item) => inside(item.source, source));
      if (leaf && !inside(leaf.resolvedSourcePath, resolution.path))
        throw new Error(
          "Explicit library leaf resource escapes its authorized resolved directory",
        );
      if (
        !leaf &&
        !allowedLibrary(resolution.path) &&
        !trusted.files?.includes(source)
      ) {
        if (
          libraryDirectory &&
          /^[A-Za-z0-9_-]+$/.test(path.basename(source)) &&
          ![
            path.parse(resolution.path).root,
            canonicalHome,
            "/nix/store",
          ].includes(resolution.path) &&
          libraryRoots.some(
            (root) =>
              root.endsWith("/skills") &&
              path.dirname(source) === path.join(trusted.docker!.home, root),
          ) &&
          !(trusted.skillPath && inside(source, trusted.skillPath))
        ) {
          trusted.docker!.handling.push({
            source,
            digest: resolution.identity,
            kind: "library-layout",
            effect:
              "Optional external installed skill leaf omitted: no read consent for this logical alias. No target contents enumerated or read; native files unchanged.",
            nativeSettingsUnchanged: true,
          });
          return;
        }
        throw new Error(
          `Native library link ${source} resolves outside declared native libraries or one bounded Nix store package (${resolution.path}); arbitrary HOME capture is denied`,
        );
      }
    } else if (imported || trusted.files?.includes(source))
      resolution = await resolveTrustedFile(source);
    const resolved = resolution?.path ?? source;
    const info = await lstat(resolved);
    const leaf = libraryLeaves.find((item) => inside(item.source, source));
    if (leaf) {
      const usage = leafUsage.get(leaf.source) ?? { entries: 0, bytes: 0 };
      usage.entries++;
      if (info.isFile()) usage.bytes += info.size;
      if (
        usage.entries > portableResourceLimits.entries ||
        usage.bytes > portableResourceLimits.decodedBytes
      )
        throw new Error(
          "Explicit installed leaf exceeds its independent 2000-entry/2 MB read scope",
        );
      leafUsage.set(leaf.source, usage);
    }
    if (trusted.metadata && (info.isFile() || info.isDirectory()))
      trusted.metadata.push({
        source,
        target,
        kind: info.isFile() ? "file" : "directory",
        bytes: info.isFile() ? info.size : 0,
        executable: Boolean(info.mode & 0o111),
        ...(resolution
          ? {
              resolvedSourcePath: resolution.path,
              sourceDigest: resolution.identity,
            }
          : {}),
      });
    if (info.isDirectory()) {
      if (activeDirectories.has(resolved))
        throw new Error("Native library contains a directory link cycle");
      activeDirectories.add(resolved);
      const names = (await readdir(resolved)).sort();
      if (library)
        trusted.docker!.handling.push({
          source,
          digest: digest(
            JSON.stringify({ identity: resolution!.identity, names }),
          ),
          kind: "library-layout",
          effect: `Bounded logical library layout retained at ${target}; no native files changed.`,
          nativeSettingsUnchanged: true,
        });
      for (const name of names) {
        const child = path.join(source, name);
        if (
          trusted.skillPath &&
          [".symlink-backup", ".nix-backup"].some(
            (suffix) => child === trusted.skillPath + suffix,
          )
        )
          continue;
        await visit(child, `${target}/${name}`);
      }
      if (
        JSON.stringify((await readdir(resolved)).sort()) !==
          JSON.stringify(names) ||
        (resolution &&
          (await resolveTrustedSource(source, "directory")).state !==
            resolution.state)
      )
        throw new Error("Native library changed during capture");
      activeDirectories.delete(resolved);
    } else if (info.isFile()) {
      bytes += info.size;
      if (trusted.metadata) {
        if (bytes > 64000000)
          throw new Error(
            "Docker metadata sizing exceeds its 64 MB ceiling; no resource contents were read",
          );
        if (
          resolution &&
          (await resolveTrustedFile(source)).state !== resolution.state
        )
          throw new Error("Trusted source changed during metadata sizing");
        return;
      }
      if (bytes > limits.decodedBytes || info.size > limits.fileBytes)
        throw new Error(
          `Projection exceeds ${limits.decodedBytes / 1000000} MB aggregate or 2 MB per-file bound (${bytes} decoded bytes at ${source}); this resource was not read`,
        );
      const data = await readBoundedFile(resolved, limits.fileBytes, info);
      let content = data.toString("utf8");
      const inputDigest = digest(data);
      if (
        resolution &&
        (await resolveTrustedFile(source)).state !== resolution.state
      )
        throw new Error("Trusted source changed during capture");
      if (trusted.docker && path.basename(source) === ".DS_Store") {
        trusted.docker.handling.push({
          source,
          digest: inputDigest,
          kind: "finder-metadata",
          effect:
            "Exact Finder metadata file omitted from Docker runtime; bytes remain approval-bound.",
          nativeSettingsUnchanged: true,
        });
        return;
      }
      const executable = Boolean(info.mode & 0o111);
      const asset = /\.(woff2|png)$/.test(target);
      const mediaType = asset
        ? companionMediaType({ target, executable }, data)
        : undefined;
      if (asset) {
        if (
          !(trusted.docker || trusted.opaqueAssets) ||
          libraryLeaves.some((leaf) => inside(leaf.source, source)) ||
          !mediaType
        )
          throw new Error(
            `WOFF2/PNG requires a recognized non-executable Docker skill companion outside UTF-8-only leaf exceptions (${source})`,
          );
        content = data.toString("base64");
      } else if (content.includes("\0") || content.includes("\ufffd"))
        throw new Error(
          `Projection supports UTF-8 resources only (${source}); native dependencies belong in the pinned runtime bundle`,
        );
      const file: ProjectedFile = {
        target,
        content,
        ...(mediaType ? { encoding: "base64" as const, mediaType } : {}),
        executable,
        sourcePath: source,
        ...(resolution
          ? {
              resolvedSourcePath: resolution.path,
              sourceDigest: resolution.identity,
            }
          : {}),
      };
      serializedBytes +=
        Buffer.byteLength(JSON.stringify(file)) + (files.length ? 1 : 0);
      if (
        (trusted.docker || trusted.opaqueAssets) &&
        serializedBytes > dockerResourceLimits.serializedBytes
      )
        throw new Error(
          "Docker projected resources exceed 16 MB serialized data",
        );
      files.push(file);
      if (trusted.docker && (target === ".claude/CLAUDE.md" || imported)) {
        activeInstructions.add(target);
        for (const match of content.matchAll(
          /(?:^|\s)@([^\s`]+\.md)(?=\s|$)/gm,
        )) {
          const reference = match[1];
          const logical = path.posix.normalize(
            path.posix.join(path.posix.dirname(target), reference),
          );
          const child = path.resolve(path.dirname(source), reference);
          if (
            path.isAbsolute(reference) ||
            !logical.startsWith(".claude/") ||
            !inside(path.join(trusted.docker.home, ".claude"), child)
          )
            throw new Error(
              "Claude instruction imports must stay in the explicit trusted .claude instruction root",
            );
          if (activeInstructions.has(logical))
            throw new Error("Claude instruction import cycle");
          if (!targets.has(logical)) {
            if (instructionImports.size >= 50)
              throw new Error("Claude instruction closure exceeds 50 imports");
            instructionImports.add(logical);
            await visit(child, logical, true);
          }
        }
        activeInstructions.delete(target);
      }
    } else
      throw new Error(
        "Projection cannot follow symlinks or copy special files; declare resolved trusted sources explicitly",
      );
  }
  for (const source of sources) {
    if (
      !source ||
      Object.keys(source).some((key) => !["path", "target"].includes(key))
    )
      throw new Error("Invalid projection source");
    await visit(source.path, source.target);
  }
  for (const leaf of libraryLeaves)
    if (
      (await resolveTrustedSource(leaf.source, "directory")).state !==
      leafStates.get(leaf.source)
    )
      throw new Error("Explicit library read scope changed during capture");
  if (trusted.metadata || trusted.rawSettings) return files;
  for (const exclusion of trusted.docker?.exclusions.filter(
    (item) => item.kind === "google-workspace-skill",
  ) ?? []) {
    const manifest = files.find((file) => file.sourcePath === exclusion.source);
    const projected =
      manifest &&
      googleWorkspaceProjection(manifest, files, trusted.docker!.handling);
    if (
      !projected ||
      projected.sourceDigest !== exclusion.sourceDigest ||
      projected.pointer !== exclusion.pointer ||
      projected.itemDigest !== exclusion.itemDigest ||
      projected.definition !== exclusion.definition
    )
      throw new Error(
        "Docker Google skill exclusion changed or is outside this capture",
      );
    const resolved = new Set(
      projected.omitted.map(
        (file) => file.resolvedSourcePath ?? file.sourcePath,
      ),
    );
    if (
      files.some(
        (file) =>
          !projected.omitted.includes(file) &&
          resolved.has(file.resolvedSourcePath ?? file.sourcePath),
      )
    )
      throw new Error(
        "Excluded Google skill is also captured through another source",
      );
    manifest!.inputDigest = digest(manifest!.content);
    manifest!.content = projected.content;
    for (const file of projected.omitted) files.splice(files.indexOf(file), 1);
    const handling = trusted.docker!.handling;
    for (const item of projected.layout)
      handling.splice(handling.indexOf(item), 1);
    handling.push({
      source: exclusion.source,
      digest: exclusion.sourceDigest,
      kind: "library-layout",
      effect:
        "Only the selected Google Workspace leaf and its exact skill/pending-claim manifest entries are omitted from Docker. Other manifest values and native files remain unchanged.",
      nativeSettingsUnchanged: true,
    });
  }
  for (const file of files) {
    const originalContent = file.content;
    const sourceDigest = digest(JSON.stringify(file));
    const value =
      file.target === ".codex/config.toml"
        ? codexSettings(file.content)
        : [".claude/settings.json", ".pi/agent/settings.json"].includes(
              file.target,
            )
          ? settingsObject(file.content)
          : null;
    if (!value) continue;
    if (trusted.docker) {
      const record = (kind: DockerSourceHandling["kind"], effect: string) =>
        trusted.docker!.handling.push({
          source: file.sourcePath,
          digest: digest(originalContent),
          kind,
          effect,
          nativeSettingsUnchanged: true,
        });
      if (file.target === ".claude/settings.json") {
        const excludedHook = Symbol("excluded-hook");
        for (const key of ["theme", "tui"]) {
          if (value[key] === undefined) continue;
          if (
            typeof value[key] !== "string" ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(value[key] as string)
          )
            throw new Error(
              `Claude ${key} must be an inert presentation identifier, not executable configuration`,
            );
          delete value[key];
          record(
            "presentation",
            `${key} is a host presentation preference, omitted from headless Docker only.`,
          );
        }
        for (const exclusion of trusted.docker.exclusions.filter(
          (item) => item.source === file.sourcePath,
        )) {
          if (exclusion.sourceDigest !== sourceDigest)
            throw new Error(
              "Docker exclusion source changed; inspect and select the exact item again",
            );
          if (exclusion.kind === "status-line") {
            if (
              digest(JSON.stringify(value.statusLine)) !== exclusion.itemDigest
            )
              throw new Error("Docker status-line exclusion changed");
            delete value.statusLine;
          } else if (exclusion.kind === "slack-plugin") {
            if (
              exclusion.pointer !== `/enabledPlugins/${slackPlugin}` ||
              !slackPluginOnly(value.enabledPlugins) ||
              digest(JSON.stringify(value.enabledPlugins[slackPlugin])) !==
                exclusion.itemDigest
            )
              throw new Error("Docker Slack plugin exclusion changed");
            delete value.enabledPlugins;
          } else if (exclusion.kind === "herdr-session-start") {
            const match = /^\/hooks\/SessionStart\/(\d+)\/hooks\/(\d+)$/.exec(
              exclusion.pointer,
            );
            const groups = (value.hooks as Record<string, any>)?.SessionStart;
            const handler =
              match && groups?.[Number(match[1])]?.hooks?.[Number(match[2])];
            if (
              !handler ||
              digest(JSON.stringify(handler)) !== exclusion.itemDigest
            )
              throw new Error("Docker SessionStart exclusion changed");
            groups[Number(match![1])].hooks[Number(match![2])] = excludedHook;
          } else throw new Error("Unsupported Docker exclusion kind");
        }
        const hooks = value.hooks as Record<string, any> | undefined;
        if (Array.isArray(hooks?.SessionStart)) {
          for (const group of hooks.SessionStart)
            if (Array.isArray(group?.hooks))
              group.hooks = group.hooks.filter(
                (handler: unknown) => handler !== excludedHook,
              );
          hooks.SessionStart = hooks.SessionStart.filter(
            (group: any) => group.hooks?.length !== 0,
          );
          if (!hooks.SessionStart.length) delete hooks.SessionStart;
          if (!Object.keys(hooks).length) delete value.hooks;
        }
      }
      if (
        file.target === ".codex/config.toml" &&
        value.projects !== undefined
      ) {
        if (
          !value.projects ||
          typeof value.projects !== "object" ||
          Array.isArray(value.projects) ||
          Object.entries(value.projects).some(
            ([root, entry]) =>
              !path.isAbsolute(root) ||
              !entry ||
              typeof entry !== "object" ||
              Array.isArray(entry) ||
              Object.keys(entry).length !== 1 ||
              !["trusted", "untrusted"].includes(
                (entry as Record<string, string>).trust_level,
              ),
          )
        )
          throw new Error(
            "Unsupported Codex project trust record; only host-path trust_level entries can be omitted",
          );
        delete value.projects;
        record(
          "host-project-trust",
          "Native absolute host-project trust records are omitted. No host trust is transferred to the PR workcopy.",
        );
      }
      file.inputDigest = digest(originalContent);
      file.content = file.target.endsWith(".toml")
        ? stringify(value)
        : JSON.stringify(value);
    }
    if (file.target === ".codex/config.toml" && value.mcp_servers) {
      delete value.mcp_servers;
      file.content = stringify(value);
    }
    const allowed =
      file.target === ".claude/settings.json"
        ? [
            "$schema",
            "model",
            "effortLevel",
            "permissions",
            "hooks",
            "alwaysThinkingEnabled",
            "language",
            "outputStyle",
            "agent",
            "disableAllHooks",
          ]
        : file.target === ".codex/config.toml"
          ? [
              "model",
              "model_reasoning_effort",
              "approval_policy",
              "sandbox_mode",
              "agents",
              "features",
              "hooks",
              "model_instructions_file",
              "developer_instructions",
              "project_doc_max_bytes",
              "review_model",
              "personality",
            ]
          : [
              "defaultProvider",
              "defaultModel",
              "defaultThinkingLevel",
              "defaultProjectTrust",
              "extensions",
              "skills",
              "prompts",
              "themes",
              "packages",
              "defaultTools",
              "compaction",
              "retry",
              "transport",
              "shellPath",
              "shellCommandPrefix",
              "enableSkillCommands",
              "thinkingBudgets",
            ];
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key))
        throw new Error(
          `Projected ${file.target} field ${key} is not supported by this profile; it was not silently dropped. Credential helpers, raw MCP servers and plugin marketplaces require an audited binding`,
        );
    }
    if (
      file.target === ".codex/config.toml" &&
      value.features &&
      Object.keys(value.features).some(
        (key) => !["multi_agent", "hooks", "codex_hooks", "apps"].includes(key),
      )
    )
      throw new Error(
        "This Codex projection supports multi_agent, hooks and explicit apps=false configuration; other feature flags are not silently suppressed",
      );
    if ((value.features as Record<string, unknown> | undefined)?.apps === true)
      throw new Error(
        "Codex apps require an unsupported business-credential transport; enabled apps cannot be silently removed from the selected workflow",
      );
    if (
      file.target === ".codex/config.toml" &&
      ((value.sandbox_mode && value.sandbox_mode !== "workspace-write") ||
        (value.approval_policy && value.approval_policy !== "never"))
    )
      throw new Error(
        "This Codex profile requires workspace-write with never approvals inside the outer boundary; conflicting existing settings cannot be silently replaced",
      );
    if (
      JSON.stringify(value).match(
        /bypassPermissions|danger-full-access|dangerously-/,
      )
    )
      throw new Error(
        "Dangerous permission bypass configuration cannot be projected",
      );
    if (value.packages && JSON.stringify(value.packages) !== "[]") {
      if (!Array.isArray(value.packages) || value.packages.length > 20)
        throw new Error(
          "Pi Docker packages require at most 20 installed local package paths",
        );
      for (const entry of value.packages) {
        if (typeof entry !== "string" || !path.isAbsolute(entry))
          throw new Error(
            "Pi package specs can install or reconcile sources at startup; only already-installed absolute local portable packages are supported",
          );
        const target = `resources/.pi-packages/${digest(entry).slice(0, 16)}`;
        await visit(entry, target);
        const manifest = files.find(
          (item) => item.target === `${target}/package.json`,
        );
        const definition = manifest
          ? (settingsObject(manifest.content).pi as
              Record<string, unknown> | undefined)
          : undefined;
        for (const kind of ["extensions", "skills", "prompts", "themes"]) {
          const references =
            definition?.[kind] ??
            (files.some((item) => item.target.startsWith(`${target}/${kind}/`))
              ? [kind]
              : []);
          if (
            !Array.isArray(references) ||
            references.some(
              (item) =>
                typeof item !== "string" ||
                !/^[a-zA-Z0-9_./-]+$/.test(item) ||
                path.isAbsolute(item) ||
                item.split("/").includes(".."),
            )
          )
            throw new Error(
              "Pi local package resources require plain relative paths without globs or exclusions",
            );
          value[kind] = [
            ...((value[kind] as string[] | undefined) ?? []),
            ...references.map(
              (item) => `/scratch/${target}/${item.replace(/^\.\//, "")}`,
            ),
          ];
        }
      }
      value.packages = [];
      file.content = JSON.stringify(value);
    }
    if (value.defaultProvider && value.defaultProvider !== "openai-codex")
      throw new Error(
        "The Pi profile currently supports only an explicitly selected openai-codex provider",
      );
  }
  const settings = projectedSettings(files);
  const resource = (reference: unknown, base: string): ProjectedFile[] => {
    if (
      typeof reference !== "string" ||
      /^(?:https?:|npm:|git:)/.test(reference)
    )
      throw new Error(
        "Projected resource references must be explicit local portable paths, not installable packages or URLs",
      );
    const resolved = path.posix.resolve(base, reference);
    const matches = files.filter(
      (file) =>
        `/scratch/${file.target}` === resolved ||
        `/scratch/${file.target}`.startsWith(`${resolved}/`),
    );
    if (!resolved.startsWith("/scratch/") || !matches.length)
      throw new Error(
        "A configured resource is not present at its projected scratch path; explicitly project it and use a portable reference. Host paths are not silently rewritten",
      );
    return matches;
  };
  for (const field of ["extensions", "skills", "prompts", "themes"]) {
    const references = settings.pi?.[field];
    if (references === undefined) continue;
    if (!Array.isArray(references))
      throw new Error(
        `Pi ${field} must be an explicit array of portable local paths`,
      );
    for (const reference of references)
      resource(reference, "/scratch/.pi/agent");
  }
  if (settings.codex?.model_instructions_file)
    resource(settings.codex.model_instructions_file, "/scratch/.codex");
  for (const role of Object.values(settings.codex?.agents ?? {})) {
    if (!role || typeof role !== "object" || !("config_file" in role)) continue;
    for (const file of resource(role.config_file, "/scratch/.codex")) {
      const agent = codexSettings(file.content);
      if (
        Object.keys(agent).some(
          (key) =>
            ![
              "model",
              "model_reasoning_effort",
              "developer_instructions",
              "model_instructions_file",
            ].includes(key),
        )
      )
        throw new Error(
          "A Codex role config uses unsupported fields; its provider, MCP, permissions and hooks cannot be silently changed",
        );
      if (agent.model || agent.model_reasoning_effort)
        throw new Error(
          "Per-agent model/effort overrides are not supported by the single pinned inference profile; they were not silently removed",
        );
      if (agent.model_instructions_file)
        resource(
          agent.model_instructions_file,
          path.posix.dirname(`/scratch/${file.target}`),
        );
    }
  }
  if (
    (trusted.docker || trusted.opaqueAssets) &&
    Buffer.byteLength(JSON.stringify(files)) >
      dockerResourceLimits.serializedBytes
  )
    throw new Error("Docker projected resources exceed 16 MB serialized data");
  return files;
}

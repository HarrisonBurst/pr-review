import path from "node:path";
import { lstat } from "node:fs/promises";
import type {
  DockerExclusion,
  DockerSourceHandling,
} from "../../shared/contracts.js";
import {
  projectFiles,
  googleWorkspaceProjection,
  type ProjectionMetadata,
  settingsObject,
  slackPlugin,
  slackPluginOnly,
} from "./projection.js";
import { digest } from "./policy.js";

export async function dockerExclusions(
  home: string,
): Promise<DockerExclusion[]> {
  const source = path.join(home, ".claude/settings.json");
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return googleWorkspaceExclusions(home);
    throw error;
  }
  const [file] = await projectFiles(
    [{ path: source, target: ".claude/settings.json" }],
    { files: [source], rawSettings: true },
  );
  const value = settingsObject(file.content);
  const sourceDigest = digest(JSON.stringify(file));
  const result: DockerExclusion[] = [];
  const add = (
    kind: DockerExclusion["kind"],
    pointer: string,
    item: unknown,
    rationale: string,
    effect: string,
  ) => {
    const definition = JSON.stringify(item);
    const itemDigest = digest(definition);
    result.push({
      id: digest(
        JSON.stringify({ source, sourceDigest, itemDigest, kind, pointer }),
      ),
      source,
      sourceDigest,
      itemDigest,
      kind,
      pointer,
      definition,
      rationale,
      effect,
      nativeSettingsUnchanged: true,
    });
  };
  const status = value.statusLine as Record<string, unknown> | undefined;
  if (
    status?.type === "command" &&
    typeof status.command === "string" &&
    status.command.length <= 8000 &&
    Object.keys(status).every((key) =>
      ["type", "command", "padding"].includes(key),
    ) &&
    (status.padding === undefined ||
      (Number.isInteger(status.padding) && Number(status.padding) >= 0))
  )
    add(
      "status-line",
      "/statusLine",
      status,
      "Headless Docker has no interactive host status line.",
      "This exact status-line command is not materialized or executed in Docker. Native status-line configuration remains unchanged.",
    );
  if (slackPluginOnly(value.enabledPlugins))
    add(
      "slack-plugin",
      `/enabledPlugins/${slackPlugin}`,
      value.enabledPlugins[slackPlugin],
      "Use the separately authenticated, explicitly granted read-only Slack broker rather than native plugin activation in Docker.",
      "Docker omits this exact official Slack activation flag, its native MCP connection, six plugin skills and five commands. Native plugin/settings/auth and separately captured slack-axi instruction skills remain unchanged. No CLI or whole-plugin parity, new read grant, executable approval or credential exposure is implied.",
    );
  const groups = (value.hooks as Record<string, unknown> | undefined)
    ?.SessionStart;
  if (Array.isArray(groups))
    for (const [groupIndex, group] of groups.entries()) {
      if (
        !group ||
        !Array.isArray(group.hooks) ||
        group.matcher !== "*" ||
        Object.keys(group).some((key) => !["matcher", "hooks"].includes(key))
      )
        continue;
      for (const [index, hook] of group.hooks.entries()) {
        if (
          hook?.type !== "command" ||
          typeof hook.command !== "string" ||
          !/^bash (['"])([^'"\r\n]+\/herdr-agent-state\.sh)\1 session$/.test(
            hook.command,
          ) ||
          Object.keys(hook).some(
            (key) => !["type", "command", "timeout"].includes(key),
          ) ||
          (hook.timeout !== undefined &&
            (!Number.isInteger(hook.timeout) ||
              hook.timeout < 1 ||
              hook.timeout > 60))
        )
          continue;
        add(
          "herdr-session-start",
          `/hooks/SessionStart/${groupIndex}/hooks/${index}`,
          hook,
          "Host Herdr pane/session reporting has no supported container transport.",
          "Only this exact SessionStart handler is omitted from Docker. No host socket, executable bridge or native configuration change is introduced.",
        );
      }
    }
  return [...result, ...(await googleWorkspaceExclusions(home))];
}

async function googleWorkspaceExclusions(
  home: string,
): Promise<DockerExclusion[]> {
  const target = ".claude/skills/synced";
  const source = path.join(home, target);
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const metadata: ProjectionMetadata[] = [];
  await projectFiles([{ path: source, target }], {
    metadata,
    docker: { home, handling: [], exclusions: [] },
  });
  const result: DockerExclusion[] = [];
  for (const leaf of metadata.filter(
    (item) =>
      item.kind === "directory" &&
      /^\.claude\/skills\/synced\/[^/]+\/google-workspace$/.test(item.target),
  )) {
    const manifestSource = path.join(
      path.dirname(leaf.source),
      "manifest.json",
    );
    if (
      !metadata.some(
        (item) => item.kind === "file" && item.source === manifestSource,
      )
    )
      continue;
    const handling: DockerSourceHandling[] = [];
    const files = await projectFiles(
      [
        {
          path: manifestSource,
          target: path.posix.join(
            path.posix.dirname(leaf.target),
            "manifest.json",
          ),
        },
        { path: leaf.source, target: leaf.target },
      ],
      { docker: { home, handling, exclusions: [] } },
    );
    const manifest = files.find((file) => file.sourcePath === manifestSource)!;
    const projected = googleWorkspaceProjection(manifest, files, handling);
    if (!projected) continue;
    const { sourceDigest, pointer, itemDigest, definition } = projected;
    const kind = "google-workspace-skill";
    const identity = {
      source: manifestSource,
      sourceDigest,
      itemDigest,
      kind,
      pointer,
    } as const;
    result.push({
      ...identity,
      id: digest(JSON.stringify(identity)),
      definition,
      rationale:
        "Google Workspace is not needed for this Docker PR-review capture.",
      effect:
        "Omit only this source-bound Google Workspace skill, its four scripts, five Markdown resources and exact skill/pending-claim manifest entries from Docker inputs and discovery. Other manifest content and skills remain. Native installation/settings/auth stay unchanged; no Google code execution, credential exposure or provider grant is approved.",
      nativeSettingsUnchanged: true,
    });
  }
  return result;
}

export async function selectDockerExclusions(
  home: string,
  ids: string[],
): Promise<DockerExclusion[]> {
  if (
    !Array.isArray(ids) ||
    ids.length > 32 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
  )
    throw new Error("Choose exact distinct source-bound Docker exclusion ids");
  if (!ids.length) return [];
  const candidates = await dockerExclusions(home);
  return ids.map((id) => {
    const candidate = candidates.find((item) => item.id === id);
    if (!candidate)
      throw new Error(
        "Docker exclusion changed or is unsupported. Discover the current exact source items and select again; Slack is not implicitly excluded.",
      );
    return candidate;
  });
}

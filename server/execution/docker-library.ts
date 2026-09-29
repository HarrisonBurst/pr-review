import path from "node:path";
import type {
  DockerLibraryLeaf,
  HarnessId,
  TrustedLibraryLeaf,
} from "../../shared/contracts.js";
import { nativeLibraryRoots } from "./projection.js";
import { resolveTrustedSource, resolveTrustedFile } from "./trusted-source.js";
import { portableResourceLimits } from "./harness.mjs";
import { digest } from "./policy.js";

export function describeLibraryLeaf(
  leaf: TrustedLibraryLeaf,
): DockerLibraryLeaf {
  const value = {
    ...leaf,
    limits: {
      entries: portableResourceLimits.entries,
      decodedBytes: portableResourceLimits.decodedBytes,
      encoding: "utf8" as const,
    },
    effect:
      "Read and freeze only this installed skill leaf and contained UTF-8 companions. No parent/sibling/external descendant reads, credential stores, host execution or native changes. Executable resources and Docker setup still require separate exact approval.",
    nativeSettingsUnchanged: true as const,
  };
  return { id: digest(JSON.stringify(value)), ...value };
}

export async function discoverLibraryLeaf(
  source: string,
  home: string,
  required: HarnessId[],
): Promise<DockerLibraryLeaf> {
  const roots = nativeLibraryRoots.filter(
    (root) =>
      root.endsWith("/skills") &&
      (root.startsWith(".agents/")
        ? required.some((harness) => harness === "codex" || harness === "pi")
        : required.some((harness) => root.startsWith(`.${harness}/`))),
  );
  if (
    !path.isAbsolute(source) ||
    !/^[A-Za-z0-9_-]+$/.test(path.basename(source)) ||
    !roots.some((root) => path.dirname(source) === path.join(home, root))
  )
    throw new Error(
      "Choose one declared installed skill leaf for the saved Docker harnesses, not an arbitrary source or parent directory",
    );
  const resolved = await resolveTrustedSource(source, "directory");
  const canonicalHome = (await resolveTrustedSource(home, "directory")).path;
  if (
    [
      path.parse(resolved.path).root,
      canonicalHome,
      "/nix/store",
      ...nativeLibraryRoots.map((root) => path.join(canonicalHome, root)),
    ].includes(resolved.path)
  )
    throw new Error(
      "A parent directory cannot be authorized as an installed skill leaf",
    );
  const entry = await resolveTrustedFile(path.join(source, "SKILL.md"));
  if (!entry.path.startsWith(resolved.path + path.sep))
    throw new Error(
      "Installed leaf SKILL.md escapes the declared resolved directory",
    );
  if (
    (await resolveTrustedSource(source, "directory")).state !== resolved.state
  )
    throw new Error("Installed leaf changed during metadata discovery");
  return describeLibraryLeaf({
    source,
    resolvedSourcePath: resolved.path,
    sourceDigest: resolved.identity,
  });
}

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  ExecutionMode,
  HarnessId,
  SkillSnapshot,
} from "../../shared/contracts.js";
import { projectFiles } from "./projection.js";
import { digest } from "./policy.js";
import { resourceBytes } from "./harness.mjs";

export async function loadSkill(
  file: string,
  mode?: ExecutionMode,
): Promise<SkillSnapshot> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".md")
    throw new Error(
      "skillPath must be an explicit absolute Markdown file path; select the installed entry file, not a workflow JSON",
    );
  const directory = path.basename(path.dirname(file));
  if (path.resolve(path.dirname(file)) === "/nix/store")
    throw new Error(
      "Select the installed logical skill entry, not a file directly in /nix/store",
    );
  const files = await projectFiles(
    [{ path: path.dirname(file), target: `resources/${directory}` }],
    { files: [file], skillPath: file, opaqueAssets: mode === "docker" },
  );
  const entry = files.find((item) => item.sourcePath === file);
  if (!entry) throw new Error(`Selected skill is missing: ${file}`);
  for (const item of files.filter((item) => item.target.endsWith(".md"))) {
    for (const match of item.content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const reference = match[1].split("#")[0];
      if (!reference || /^[a-z]+:/i.test(reference)) continue;
      const resolved = path.resolve(path.dirname(item.sourcePath), reference);
      if (!files.some((file) => file.sourcePath === resolved))
        throw new Error(
          `Skill resource ${reference} referenced by ${item.sourcePath} is missing or outside its selected directory. Select a self-contained portable skill or explicitly arrange its companion resources; dependencies are not silently omitted.`,
        );
    }
  }
  return {
    version: 1,
    path: file,
    directory,
    digest: digest(JSON.stringify(files)),
    files,
  };
}

export function skillCompatibility(
  skill: SkillSnapshot,
  mode: ExecutionMode,
  harness: HarnessId,
): string[] {
  if (mode !== "separated") return [];
  const text = skill.files
    .map((file) => resourceBytes(file).toString("utf8"))
    .join("\n");
  const requirements = text.replace(
    /\b(?:requires?|must use|execute)\s+(?:a\s+)?(?:shell|Bash)\s+(?:tool\s+)?to\s+(?:run|launch|invoke)\s+(?:codex\s+exec|claude\s+-[p-]|pi\s+--)/gi,
    "",
  );
  return /^allowed-tools:.*\b(?:Write|Edit|mcp__)/im.test(text) ||
    /\b(?:node|bash|python3?)\s+(?:scripts\/|[^\s]+\.(?:sh|m?js|py)\b)/i.test(
      text,
    ) ||
    /\b(?:requires?|must use|execute)\s+(?:a\s+)?(?:shell|Bash|plugin|hook|MCP)\b/i.test(
      requirements,
    )
    ? [
        `Isolated ${harness} cannot execute required non-orchestration shell, write, plugin, hook or arbitrary MCP dependencies. App-owned reviewer orchestration overrides nested reviewer instructions only. Choose compatible Docker or explicitly consent to Dangerous for those dependencies.`,
      ]
    : [];
}

export function nestedHarnesses(skill: SkillSnapshot): HarnessId[] {
  const text = skill.files
    .filter((file) => file.encoding !== "base64")
    .map((file) => resourceBytes(file).toString("utf8"))
    .join("\n");
  return (["claude", "codex", "pi"] as const).filter((harness) =>
    new RegExp(`\\b${harness}\\s+(?:exec\\b|--|-[p])`).test(text),
  );
}

export async function materializeSkill(
  skill: SkillSnapshot,
  root: string,
): Promise<string> {
  const contents = skill.files.map((file) => resourceBytes(file));
  for (const [index, file] of skill.files.entries()) {
    const target = path.join(root, file.target);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents[index], {
      mode: file.executable ? 0o700 : 0o600,
    });
  }
  return path.join(
    root,
    skill.files.find((file) => file.sourcePath === skill.path)!.target,
  );
}

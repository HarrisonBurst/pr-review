import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export async function prepareWorkcopy(
  source,
  target,
  metadata,
  environment,
  synthetic,
) {
  const git = (cwd, args) => {
    const result = spawnSync("/usr/bin/git", args, {
      cwd,
      env: environment,
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.status !== 0)
      throw new Error("Pinned workcopy Git verification failed");
    return result.stdout.trim();
  };
  if (!synthetic) {
    for (const key of ["baseRefOid", "headRefOid"])
      if (
        !/^[a-f0-9]{40,64}$/.test(metadata?.[key] ?? "") ||
        git(source, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${metadata[key]}^{commit}`,
        ]) !== metadata[key]
      )
        throw new Error("Pinned workcopy base/head mismatch");
    if (git(source, ["rev-parse", "HEAD"]) !== metadata.headRefOid)
      throw new Error("Pinned source HEAD mismatch");
  }
  let count = 0;
  let bytes = 0;
  const excluded = new Set([
    ".claude",
    ".codex",
    ".pi",
    ".agents",
    ".mcp.json",
    "CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
    "AGENTS.override.md",
  ]);
  async function copy(relative) {
    if (++count > 100000) throw new Error("Workcopy exceeds 100000 entries");
    const input = path.join(source, relative);
    const output = path.join(target, relative);
    const info = await lstat(input);
    const object =
      relative === ".git/objects" || relative.startsWith(".git/objects/");
    if (info.isDirectory()) {
      if (!object) await mkdir(output, { recursive: true, mode: 0o700 });
      for (const name of await readdir(input)) {
        if (!object && excluded.has(name)) continue;
        if (!object && name === ".git" && relative !== "") continue;
        if (
          relative === ".git" &&
          ![
            "objects",
            "refs",
            "HEAD",
            "packed-refs",
            "index",
            "shallow",
          ].includes(name)
        )
          continue;
        if (
          relative === ".git/objects/info" &&
          ["alternates", "http-alternates"].includes(name)
        )
          throw new Error("Pinned Git object store must be self-contained");
        await copy(path.join(relative, name));
      }
    } else if (info.isFile()) {
      if (object) return;
      bytes += info.size;
      if (bytes > 256 * 1024 * 1024)
        throw new Error("Workcopy exceeds 256 MiB");
      await copyFile(input, output);
      await chmod(output, info.mode & 0o111 ? 0o700 : 0o600);
    } else if (info.isSymbolicLink()) {
      const link = await readlink(input);
      const resolved = path.resolve(path.dirname(output), link);
      if (
        path.isAbsolute(link) ||
        !resolved.startsWith(target + "/") ||
        relative === ".git" ||
        relative.startsWith(".git/")
      )
        throw new Error("Workcopy symlink escapes its disposable tree");
      await symlink(link, output);
    } else throw new Error("Workcopy contains an unsupported special file");
  }
  await copy("");
  if (await lstat(path.join(target, ".git")).catch(() => null)) {
    const writeGitFile = async (name, content) => {
      if (++count > 100000) throw new Error("Workcopy exceeds 100000 entries");
      bytes += Buffer.byteLength(content);
      if (bytes > 256 * 1024 * 1024)
        throw new Error("Workcopy exceeds 256 MiB");
      await writeFile(path.join(target, ".git", name), content, {
        mode: 0o600,
      });
    };
    count += 2;
    if (count > 100000) throw new Error("Workcopy exceeds 100000 entries");
    await mkdir(path.join(target, ".git/objects/info"), {
      recursive: true,
      mode: 0o700,
    });
    await writeGitFile(
      "objects/info/alternates",
      `${path.resolve(source, ".git/objects")}\n`,
    );
    await writeGitFile(
      "config",
      "[core]\n repositoryformatversion = 0\n bare = false\n hooksPath = /dev/null\n fsmonitor = false\n[protocol]\n allow = never\n",
    );
    if (!synthetic) {
      for (const key of ["baseRefOid", "headRefOid"])
        if (
          git(target, [
            "rev-parse",
            "--verify",
            `${metadata[key]}^{commit}`,
          ]) !== metadata[key]
        )
          throw new Error("Disposable workcopy base/head mismatch");
      if (git(target, ["rev-parse", "HEAD"]) !== metadata.headRefOid)
        throw new Error("Disposable workcopy HEAD mismatch");
    }
  }
  return { files: count, bytes, excludedConfiguration: true };
}

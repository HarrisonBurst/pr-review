import { lstat, open, readlink } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { digest } from "./policy.js";

export async function readBoundedFile(
  source: string,
  limit: number,
  expected?: Stats,
): Promise<Buffer> {
  const info = expected ?? (await lstat(source));
  if (!info.isFile() || info.size > limit)
    throw new Error(
      `Bounded file exceeds ${limit} bytes or is not regular: ${source}`,
    );
  const handle = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      before.size !== info.size ||
      before.mode !== info.mode ||
      before.mtimeMs !== info.mtimeMs ||
      before.ctimeMs !== info.ctimeMs
    )
      throw new Error("Projection source changed during capture");
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== info.size ||
      before.mode !== after.mode ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Projection source changed during capture");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export function rejectCredentialSource(source: string): void {
  if (
    source
      .split(path.sep)
      .some((part) =>
        /^(?:auth\.json|\.credentials\.json|\.env(?:\..*)?|id_rsa|id_ed25519|\.npmrc)$/.test(
          part,
        ),
      )
  )
    throw new Error(
      "Credential stores cannot be projected as resources; use the explicit host-side authentication binding",
    );
}

export async function resolveTrustedSource(
  source: string,
  kind: "file" | "directory",
) {
  let remaining = path.resolve(source).split(path.sep).filter(Boolean);
  let resolved = path.parse(source).root;
  const links: Array<{ path: string; target: string }> = [];
  const seen = new Set<string>();
  const states = [];
  while (remaining.length) {
    const part = remaining.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    resolved = path.join(resolved, part);
    rejectCredentialSource(resolved);
    const info = await lstat(resolved);
    states.push([
      resolved,
      info.dev,
      info.ino,
      info.mode,
      ...(info.isDirectory() ? [] : [info.size, info.mtimeMs, info.ctimeMs]),
    ]);
    if (info.isSymbolicLink()) {
      const step = JSON.stringify([resolved, remaining]);
      if (links.length >= 40 || seen.has(step))
        throw new Error(
          "Trusted source contains a symlink cycle or exceeds 40 links",
        );
      seen.add(step);
      const target = await readlink(resolved);
      links.push({ path: resolved, target });
      rejectCredentialSource(target);
      remaining = [...target.split(path.sep).filter(Boolean), ...remaining];
      resolved = path.isAbsolute(target)
        ? path.parse(target).root
        : path.dirname(resolved);
    } else if (
      remaining.length
        ? !info.isDirectory()
        : kind === "file"
          ? !info.isFile()
          : !info.isDirectory()
    ) {
      throw new Error(
        `Trusted source must resolve to a regular ${kind}, not a special file`,
      );
    }
  }
  const terminal = await lstat(resolved);
  if (kind === "file" ? !terminal.isFile() : !terminal.isDirectory())
    throw new Error(
      `Trusted source must resolve to a regular ${kind}, not a special file`,
    );
  return {
    path: resolved,
    identity: digest(JSON.stringify({ path: resolved, links })),
    state: JSON.stringify(states),
  };
}

export const resolveTrustedFile = (source: string) =>
  resolveTrustedSource(source, "file");

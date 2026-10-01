import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SourceCheckout } from "../../checkout.js";
import { checkoutEnvironment } from "../../execution/adapters.js";
import { runCommand } from "../../util.js";

export async function gitWorkcopyFixture(large = false) {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-git-workcopy-"));
  const repository = path.join(root, "repository");
  const source = path.join(root, "source");
  const checkout = path.join(source, "checkout");
  const target = path.join(root, "workcopy");
  const bin = path.join(root, "bin");
  await Promise.all([repository, source, bin].map((dir) => mkdir(dir)));
  const env = checkoutEnvironment({
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    FIXTURE_REPOSITORY: repository,
    GIT_SSH_COMMAND: path.join(bin, "ssh"),
    GIT_SSH_VARIANT: "ssh",
    GIT_AUTHOR_NAME: "Synthetic fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommand("/usr/bin/git", args, {
      cwd,
      env,
      timeoutMs: 120000,
      maxOutputBytes: 2000000,
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const upstream = (...args: string[]) => git(repository, ...args);
  try {
    await writeFile(
      path.join(bin, "gh"),
      '#!/bin/sh\n[ "$1 $2 $3" = "repo clone fixture/offline" ] || exit 1\ndestination="$4"\nshift 5\n/usr/bin/git clone --no-local "$@" -- "$FIXTURE_REPOSITORY" "$destination" || exit $?\nexec /usr/bin/git -C "$destination" config remote.origin.url git@github.com:fixture/offline.git\n',
    );
    await writeFile(
      path.join(bin, "ssh"),
      '#!/bin/sh\nexec /usr/bin/git upload-pack "$FIXTURE_REPOSITORY"\n',
    );
    await Promise.all(
      ["gh", "ssh"].map((name) => chmod(path.join(bin, name), 0o700)),
    );
    await upstream("init", "--initial-branch=main");
    if (large) {
      const file = await open(path.join(repository, "history.bin"), "w");
      const cipher = createCipheriv(
        "aes-256-ctr",
        Buffer.alloc(32, 7),
        Buffer.alloc(16),
      );
      try {
        for (let i = 0; i < 257; i++)
          await file.write(cipher.update(Buffer.alloc(1024 * 1024)));
      } finally {
        await file.close();
      }
    } else
      await writeFile(
        path.join(repository, "history.bin"),
        "historical fixture\n",
      );
    await upstream("add", ".");
    await upstream(
      "-c",
      "core.compression=0",
      "commit",
      "-m",
      "historical data",
    );
    const historical = await upstream("rev-parse", "HEAD");
    await upstream("rm", "history.bin");
    await writeFile(path.join(repository, "code.txt"), "pinned common\n");
    await writeFile(
      path.join(repository, "AGENTS.md"),
      "UNTRUSTED SYNTHETIC INSTRUCTIONS\n",
    );
    await mkdir(path.join(repository, ".pi"));
    await writeFile(
      path.join(repository, ".pi/settings.json"),
      '{"extensions":["./never-run.mjs"]}',
    );
    await writeFile(
      path.join(repository, ".gitattributes"),
      "code.txt filter=untrusted diff=untrusted\n",
    );
    await writeFile(
      path.join(repository, ".gitmodules"),
      '[submodule "untrusted"]\n path = nested\n url = https://invalid.example/never\n',
    );
    await upstream("add", ".");
    await upstream("commit", "-m", "common");
    const common = await upstream("rev-parse", "HEAD");
    await writeFile(path.join(repository, "base-only.txt"), "base branch\n");
    await upstream("add", ".");
    await upstream("commit", "-m", "base");
    const baseSha = await upstream("rev-parse", "HEAD");
    await upstream("checkout", "-b", "topic", common);
    await writeFile(path.join(repository, "code.txt"), "pinned head\n");
    await upstream("commit", "-am", "head");
    const headSha = await upstream("rev-parse", "HEAD");
    await upstream("update-ref", "refs/pull/42/head", headSha);
    await upstream("repack", "-ad", "--window=0", "--threads=1");
    const identity = {
      repository: "fixture/offline",
      number: 42,
      baseSha,
      headSha,
    };
    const acquisition = new SourceCheckout(env);
    await acquisition.prepare(identity, source, checkout);
    await git(checkout, "update-ref", "refs/remotes/origin/main", baseSha);
    assert.equal(await acquisition.matches(identity, checkout), true);
    assert.equal(
      await readFile(path.join(checkout, "code.txt"), "utf8"),
      "pinned head\n",
    );
    return {
      root,
      source,
      checkout,
      target,
      env,
      git,
      identity,
      common,
      historical,
      metadata: { baseRefOid: baseSha, headRefOid: headSha },
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

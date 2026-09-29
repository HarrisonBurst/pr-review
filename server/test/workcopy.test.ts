import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { prepareWorkcopy } from "../execution/workcopy.mjs";
import { runCommand } from "../util.js";
import { gitWorkcopyFixture } from "./fixtures/git-workcopy.js";

async function fileBytes(root: string): Promise<number> {
  const info = await lstat(root);
  return info.isDirectory()
    ? (
        await Promise.all(
          (await readdir(root)).map((name) => fileBytes(path.join(root, name))),
        )
      ).reduce((a, b) => a + b, 0)
    : info.isFile()
      ? info.size
      : 0;
}

test(
  "offline broader acquisition retains native Git history without copying it into Docker workcopy",
  { timeout: 180000 },
  async (t) => {
    const f = await gitWorkcopyFixture(true);
    try {
      const sourceGitBytes = await fileBytes(path.join(f.checkout, ".git"));
      assert.ok(sourceGitBytes > 256 * 1024 * 1024);
      assert.equal(
        await f.git(f.checkout, "rev-parse", "--is-shallow-repository"),
        "false",
      );
      const result = await prepareWorkcopy(
        f.checkout,
        f.target,
        f.metadata,
        f.env,
        false,
      );
      assert.ok(result.bytes < 1024 * 1024);
      assert.ok((await fileBytes(path.join(f.target, ".git"))) < 1024 * 1024);
      assert.equal(
        await f.git(f.target, "rev-parse", "HEAD"),
        f.identity.headSha,
      );
      assert.equal(
        await f.git(f.target, "rev-parse", "refs/remotes/origin/main"),
        f.identity.baseSha,
      );
      assert.equal(
        await f.git(f.target, "merge-base", f.identity.baseSha, "HEAD"),
        f.common,
      );
      for (const args of [
        [
          "diff",
          "--no-ext-diff",
          `${f.identity.baseSha}...${f.identity.headSha}`,
        ],
        [
          "diff",
          "--no-ext-diff",
          `${f.identity.baseSha}..${f.identity.headSha}`,
        ],
        ["show", `${f.identity.baseSha}:base-only.txt`],
        ["show", `${f.identity.headSha}:code.txt`],
        ["log", "--format=%H", "HEAD"],
        ["cat-file", "-s", `${f.historical}:history.bin`],
      ])
        assert.equal(
          await f.git(f.target, ...args),
          await f.git(f.checkout, ...args),
        );
      assert.equal(
        await readFile(path.join(f.target, "code.txt"), "utf8"),
        "pinned head\n",
      );
      const originalObjects = await f.git(f.checkout, "count-objects", "-v");
      await writeFile(path.join(f.target, "code.txt"), "disposable edit\n");
      assert.match(
        await f.git(f.target, "diff", "--no-ext-diff"),
        /disposable edit/,
      );
      await f.git(f.target, "add", "code.txt");
      await f.git(f.target, "commit", "-m", "disposable local commit");
      assert.equal(
        await f.git(f.target, "show", "HEAD:code.txt"),
        "disposable edit",
      );
      assert.equal(
        await f.git(f.checkout, "count-objects", "-v"),
        originalObjects,
      );
      assert.equal(
        await f.git(f.checkout, "rev-parse", "HEAD"),
        f.identity.headSha,
      );
      assert.equal(
        await readFile(path.join(f.checkout, "code.txt"), "utf8"),
        "pinned head\n",
      );
      t.diagnostic(
        JSON.stringify({
          sourceGitBytes,
          workcopyBytes: result.bytes,
          base: f.identity.baseSha,
          head: f.identity.headSha,
          common: f.common,
        }),
      );
    } finally {
      await f.close();
      await assert.rejects(lstat(f.root), { code: "ENOENT" });
    }
  },
);

test("workcopy retains source, Git configuration, symlink and pinned-ref guards", async (t) => {
  const f = await gitWorkcopyFixture();
  const copy = () =>
    prepareWorkcopy(f.checkout, f.target, f.metadata, f.env, false);
  try {
    await t.test(
      "safe Git configuration and excluded agent instructions",
      async () => {
        const marker = path.join(f.root, "EXECUTED");
        await f.git(
          f.checkout,
          "config",
          "filter.untrusted.smudge",
          `touch ${marker}`,
        );
        await f.git(
          f.checkout,
          "config",
          "diff.untrusted.command",
          `touch ${marker}`,
        );
        await mkdir(path.join(f.checkout, ".git/hooks"));
        await writeFile(
          path.join(f.checkout, ".git/hooks/post-checkout"),
          `#!/bin/sh\ntouch ${marker}\n`,
          { mode: 0o700 },
        );
        await mkdir(path.join(f.checkout, "nested/.git"), { recursive: true });
        await writeFile(
          path.join(f.checkout, "nested/AGENTS.md"),
          "untrusted nested instructions",
        );
        await symlink("code.txt", path.join(f.checkout, "safe-link"));
        await copy();
        for (const name of [
          "AGENTS.md",
          ".pi",
          "nested/AGENTS.md",
          "nested/.git",
          ".git/hooks",
        ])
          await assert.rejects(lstat(path.join(f.target, name)), {
            code: "ENOENT",
          });
        const config = await readFile(
          path.join(f.target, ".git/config"),
          "utf8",
        );
        assert.doesNotMatch(config, /untrusted|remote|touch/);
        assert.match(config, /allow = never/);
        assert.equal(
          await readFile(path.join(f.target, "safe-link"), "utf8"),
          "pinned head\n",
        );
        assert.match(
          await f.git(
            f.target,
            "diff",
            "--no-ext-diff",
            `${f.identity.baseSha}...HEAD`,
          ),
          /pinned head/,
        );
        await assert.rejects(lstat(marker), { code: "ENOENT" });
        await rm(f.target, { recursive: true });
      },
    );
    for (const [name, destination, error] of [
      ["escape", "../outside", /symlink escapes/],
      ["absolute", path.join(f.checkout, "code.txt"), /symlink escapes/],
      [".git/refs/link", "../HEAD", /symlink escapes/],
      [".git/objects/link", "../HEAD", /symlink escapes/],
    ] as const)
      await t.test(`rejects ${name}`, async () => {
        const file = path.join(f.checkout, name);
        await symlink(destination, file);
        await assert.rejects(copy(), error);
        await rm(file);
        await rm(f.target, { recursive: true, force: true });
      });
    for (const name of ["alternates", "http-alternates"])
      await t.test(`rejects inherited ${name}`, async () => {
        const file = path.join(f.checkout, ".git/objects/info", name);
        await writeFile(file, `${path.join(f.root, "outside")}\n`);
        await assert.rejects(copy(), /self-contained/);
        await rm(file);
        await rm(f.target, { recursive: true, force: true });
      });
    await t.test(
      "rejects linked Git metadata and object directories",
      async () => {
        for (const directory of [".git/objects/info", ".git/objects", ".git"]) {
          const input = path.join(f.checkout, directory);
          const moved = path.join(f.root, "moved");
          await rename(input, moved);
          await symlink(moved, input);
          await assert.rejects(copy(), /symlink escapes/);
          await rm(input);
          await rename(moved, input);
          await rm(f.target, { recursive: true, force: true });
        }
      },
    );
    await t.test("rejects missing refs and mismatched HEAD", async () => {
      await assert.rejects(
        prepareWorkcopy(
          f.checkout,
          f.target,
          { ...f.metadata, baseRefOid: "0".repeat(40) },
          f.env,
          false,
        ),
        /Git verification failed/,
      );
      await assert.rejects(
        prepareWorkcopy(
          f.checkout,
          f.target,
          { ...f.metadata, headRefOid: f.identity.baseSha },
          f.env,
          false,
        ),
        /source HEAD mismatch/,
      );
      await assert.rejects(lstat(f.target), { code: "ENOENT" });
    });
    await t.test(
      "still refuses oversized worktree and non-object Git metadata",
      async () => {
        for (const name of ["oversized.bin", ".git/index"]) {
          const file = path.join(f.checkout, name);
          const original = name === ".git/index" ? await readFile(file) : null;
          const handle = await open(file, "w");
          await handle.truncate(257 * 1024 * 1024);
          await handle.close();
          await assert.rejects(copy(), /exceeds 256 MiB/);
          if (original) await writeFile(file, original);
          else await rm(file);
          await rm(f.target, { recursive: true, force: true });
        }
      },
    );
    await t.test(
      "rejects special files even in the borrowed object store",
      async () => {
        const file = path.join(f.checkout, ".git/objects/pipe");
        const result = await runCommand("/usr/bin/mkfifo", [file], {
          env: f.env,
        });
        assert.equal(result.code, 0, result.stderr);
        await assert.rejects(copy(), /unsupported special file/);
        await rm(file);
        await rm(f.target, { recursive: true, force: true });
      },
    );
    await t.test(
      "borrowed objects still count against the 100000-entry traversal guard",
      async () => {
        const directory = path.join(f.checkout, ".git/objects/entries");
        await mkdir(directory);
        const file = path.join(f.root, "empty");
        await writeFile(file, "");
        for (let start = 0; start < 100000; start += 100)
          await Promise.all(
            Array.from({ length: 100 }, (_, index) =>
              link(file, path.join(directory, String(start + index))),
            ),
          );
        await assert.rejects(copy(), /exceeds 100000 entries/);
      },
    );
  } finally {
    await f.close();
    await assert.rejects(lstat(f.root), { code: "ENOENT" });
  }
});

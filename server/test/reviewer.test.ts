import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceCheckout } from "../checkout.js";
import { checkoutEnvironment } from "../execution/adapters.js";
import { validateReviewResult } from "../reviewer.js";
import { runCommand } from "../util.js";

const identity = {
  repository: "fixture/repository",
  number: 7,
  headSha: "head-sha",
  baseSha: "base-sha",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pr-review-checkout-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const script = async (name: string, code: string) => {
    const file = join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${code}`);
    await chmod(file, 0o700);
  };
  await script(
    "gh",
    `const fs=require('node:fs'); fs.appendFileSync(process.env.FIXTURE_LOG, 'gh\\n'); if(process.env.FIXTURE_FAIL)process.exit(1); const args=process.argv.slice(2); if(process.env.FIXTURE_REPO){const result=require('node:child_process').spawnSync('git',['clone','--no-checkout',process.env.FIXTURE_REPO,args[3]],{stdio:'inherit'});process.exit(result.status??1)} fs.mkdirSync(args[3],{recursive:true});`,
  );
  await script(
    "git",
    `const args=process.argv.slice(2); if(args[0]==='rev-parse')process.stdout.write(args.at(-1)==='HEAD'?'head-sha':args.at(-1).replace('^{commit}',''));`,
  );
  const env = checkoutEnvironment({
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    FIXTURE_LOG: join(root, "calls"),
    FIXTURE_FAIL: "",
    FIXTURE_REPO: "",
  });
  return {
    root,
    bin,
    env,
    checkout: join(root, "checkout"),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("result validation preserves multi-section Markdown verbatim", () => {
  const overview =
    "## Ticket intent\n- Unavailable.\n\n## Change\n- A new value.\n\n## Coverage\n- Unverified.";
  const result = {
    overview,
    body: "Summary",
    verdict: "COMMENT",
    rationale: "Fixture",
    findings: [],
  };
  assert.equal(validateReviewResult(result).overview, overview);
  assert.throws(
    () => validateReviewResult({ ...result, overview: [] }),
    /result\.overview/,
  );
});

test("source preparation fails closed on clone failure and cancellation without launching reviewers", async () => {
  const f = await fixture();
  try {
    const checkout = new SourceCheckout({ ...f.env, FIXTURE_FAIL: "1" });
    await assert.rejects(
      checkout.prepare(identity, f.root, f.checkout),
      /clone failed/,
    );
    const before = await readFile(f.env.FIXTURE_LOG!, "utf8");
    await assert.rejects(
      checkout.prepare(
        identity,
        f.root,
        f.checkout,
        AbortSignal.abort(new Error("cancelled")),
      ),
      /cancelled/,
    );
    assert.equal(await readFile(f.env.FIXTURE_LOG!, "utf8"), before);
  } finally {
    await f.close();
  }
});

test("source preparation verifies recorded revisions with real Git", async () => {
  const f = await fixture();
  const repository = join(f.root, "repository");
  await mkdir(repository);
  await rm(join(f.bin, "git"));
  const git = async (...args: string[]) => {
    const result = await runCommand(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: repository,
        env: {
          ...f.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    await git("init", "--initial-branch=main");
    await writeFile(
      join(repository, "example.ts"),
      "export const value = 1;\n",
    );
    await git("add", ".");
    await git("commit", "-m", "base");
    const baseSha = await git("rev-parse", "HEAD");
    await writeFile(
      join(repository, "example.ts"),
      "export const value = 2;\n",
    );
    await git("commit", "-am", "head");
    const headSha = await git("rev-parse", "HEAD");
    await git("update-ref", "refs/pull/7/head", headSha);
    await new SourceCheckout({ ...f.env, FIXTURE_REPO: repository }).prepare(
      { ...identity, headSha, baseSha },
      f.root,
      f.checkout,
    );
    assert.equal(
      await readFile(join(f.checkout, "example.ts"), "utf8"),
      "export const value = 2;\n",
    );
  } finally {
    await f.close();
  }
});

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReviewerSettings } from "../../shared/contracts.js";
import { parseDiff, resolveSelection } from "../../shared/diff.js";
import {
  QuestionCheckout,
  questionPrompt,
  validateQuestionAnswer,
  type QuestionInput,
} from "../questions.js";

const settings: ReviewerSettings = {
  skillPath: "",
  model: "claude-fable-5-1",
  additionalInstructions: "Prefer short answers.",
};

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " tail",
  "",
].join("\n");

function input(
  mode: QuestionInput["mode"],
  fromSide: "LEFT" | "RIGHT",
): QuestionInput {
  const resolved = resolveSelection(parseDiff(diff), {
    path: "src/a.ts",
    from: { side: fromSide, line: 1 },
    to: { side: "RIGHT", line: 2 },
    baseSha: "base-sha",
    headSha: "head-sha",
  })!;
  return {
    id: "q-1",
    repository: "owner/repo",
    number: 7,
    baseSha: "base-sha",
    headSha: "head-sha",
    mode,
    question: "Why?",
    selection: resolved.selection,
    fileDiff: diff,
    diffTruncated: false,
    draft: { overview: "draft overview", body: "draft body", findings: [] },
    history: [
      {
        mode: "explain",
        question: "earlier",
        answer: { kind: "answer", answer: "before", followUps: [] },
      },
    ],
  };
}

async function makeFixture(output: unknown) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "pr-review-question-runner-")),
  );
  const bin = join(directory, "bin");
  await mkdir(bin);
  const logPath = join(directory, "commands.jsonl");
  const write = async (name: string, source: string) => {
    await writeFile(join(bin, name), `#!/usr/bin/env node\n${source}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await write(
    "gh",
    `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: "gh", args }) + "\\n");
fs.mkdirSync(require("node:path").join(args[3], ".git"), { recursive: true });`,
  );
  await write(
    "git",
    `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: "git", args, cwd: process.cwd() }) + "\\n");
if (args[0] === "config") process.stdout.write(args.at(-1) === "remote.origin.url" ? "git@github.com:owner/repo.git" : "core.bare");
if (args[0] === "rev-parse") {
  const target = args.at(-1);
  process.stdout.write(target === "HEAD" ? process.env.FAKE_HEAD : target.replace("^{commit}", ""));
}
if (args[0] === "show") process.stdout.write("old file contents\\n");`,
  );
  await write(
    "codex",
    `require("node:fs").appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: "codex" }) + "\\n");`,
  );
  await write(
    "claude",
    `const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command: "claude" }) + "\\n");
process.stdout.write(process.env.FAKE_OUTPUT);`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_LOG: logPath,
    FAKE_ARGS: join(directory, "claude-args.json"),
    FAKE_HEAD: "head-sha",
    FAKE_OUTPUT: JSON.stringify({
      type: "result",
      is_error: false,
      structured_output: output,
    }),
  };
  const commands = async () =>
    (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            command: string;
            args?: string[];
            cwd?: string;
          },
      );
  const claude = async () =>
    JSON.parse(await readFile(env.FAKE_ARGS, "utf8")) as {
      args: string[];
      cwd: string;
    };
  return { directory, env, commands, claude };
}

test("question checkout pins and materializes old source without dispatch", async () => {
  const fixture = await makeFixture({});
  try {
    const runner = new QuestionCheckout(fixture.directory, fixture.env);
    const prepared = await runner.prepare(input("explain", "LEFT"));
    assert.equal(
      await readFile(join(prepared.sourceDir, "base/src/a.ts"), "utf8"),
      "old file contents\n",
    );
    const before = (await fixture.commands()).length;
    await runner.prepare(input("investigate", "RIGHT"));
    assert.equal(
      (await fixture.commands())
        .slice(before)
        .some((command) => command.command === "gh"),
      false,
    );
    assert.equal(
      (await fixture.commands()).some(
        (command) => command.command === "claude",
      ),
      false,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("question runner refuses to reuse a checkout at another head and fails closed", async () => {
  const fixture = await makeFixture({
    body: "x",
    severity: "blocking",
    origin: "introduced",
    evidence: "",
  });
  try {
    const runner = new QuestionCheckout(fixture.directory, fixture.env);
    await runner.prepare(input("draft_comment", "RIGHT"));
    const moved = new QuestionCheckout(fixture.directory, {
      ...fixture.env,
      FAKE_HEAD: "other-sha",
    });
    await assert.rejects(
      moved.prepare(input("draft_comment", "RIGHT")),
      /not pinned to recorded head head-sha/,
    );
    const commands = await fixture.commands();
    assert.equal(
      commands.filter((command) => command.command === "gh").length,
      2,
    );
    assert.equal(
      commands.filter((command) => command.command === "claude").length,
      0,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("question runner stops before spawning when cancelled and validates answers", async () => {
  const fixture = await makeFixture({ answer: "", followUps: [] });
  try {
    const runner = new QuestionCheckout(fixture.directory, fixture.env);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      runner.prepare(input("explain", "RIGHT"), controller.signal),
      /cancelled/,
    );
    assert.throws(
      () => validateQuestionAnswer("explain", { answer: "", followUps: [] }),
      /answer must not be empty/,
    );
    assert.throws(() =>
      validateQuestionAnswer("draft_comment", {
        body: "",
        severity: "blocking",
        origin: "introduced",
        evidence: "",
      }),
    );
    assert.throws(() =>
      validateQuestionAnswer("explain", { answer: "x", followUps: [1] }),
    );
    assert.match(
      questionPrompt(input("investigate", "RIGHT"), "/tmp/checkout"),
      /callers and callees/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

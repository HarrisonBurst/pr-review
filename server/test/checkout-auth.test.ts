import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type {
  IsolatedCapabilityPolicy,
  ReviewerSettings,
} from "../../shared/contracts.js";
import { DemoGithubAdapter } from "../adapters.js";
import { CommandFailure, SourceCheckout } from "../checkout.js";
import {
  checkoutEnvironment,
  workflowAdapters,
} from "../execution/adapters.js";
import { HostExecutor } from "../execution/host.js";
import type { ExecutionRequest } from "../execution/executor.js";
import { QuestionCheckout, type QuestionInput } from "../questions.js";
import { runCommand } from "../util.js";
import { githubAcquisitionFixture } from "./fixtures/github-acquisition.js";

const review = {
  overview: "Synthetic acquisition fixture",
  body: "Synthetic",
  findings: [],
  verdict: "COMMENT",
  rationale: "No model executed",
};

function question(
  identity: Awaited<ReturnType<typeof githubAcquisitionFixture>>["identity"],
): QuestionInput {
  return {
    ...identity,
    id: "synthetic-question",
    mode: "explain",
    question: "Synthetic source question",
    selection: {
      path: "code.txt",
      oldPath: "code.txt",
      from: { side: "RIGHT", line: 1 },
      to: { side: "RIGHT", line: 1 },
      baseSha: identity.baseSha,
      headSha: identity.headSha,
      snippet: "+recorded head",
      kinds: { add: true, del: false, ctx: false },
      spansHunks: false,
      anchors: { RIGHT: { startLine: 1, line: 1 } },
    },
    fileDiff: "Synthetic fixture diff",
    diffTruncated: false,
    draft: null,
    history: [],
  };
}

test("ambient synthetic helper is suppressed after successful GH clone without an explicit replacement", async () => {
  const f = await githubAcquisitionFixture();
  try {
    const clone = await runCommand(
      "gh",
      [
        "repo",
        "clone",
        f.identity.repository,
        f.checkout,
        "--",
        "--no-tags",
        "--no-checkout",
      ],
      { cwd: f.source, env: f.env },
    );
    assert.equal(clone.code, 0);
    const checkout = new SourceCheckout(f.env);
    const missingBase = await checkout.git(
      ["cat-file", "-e", `${f.identity.baseSha}^{commit}`],
      f.checkout,
    );
    assert.notEqual(missingBase.code, 0);
    const before = (await f.calls()).length;
    const result = await checkout.git(
      ["fetch", "--no-tags", "origin", f.identity.baseSha],
      f.checkout,
    );
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /could not read Username.*terminal prompts disabled/,
    );
    assert.equal((await f.calls()).length, before);
    assert.equal(JSON.stringify(result).includes(f.canary), false);
  } finally {
    await f.close();
  }
});

test("explicit GH route acquires recorded base and pinned head without persisting or disclosing credentials", async () => {
  const f = await githubAcquisitionFixture();
  try {
    const checkout = new SourceCheckout(f.env);
    const log = await checkout.prepare(f.identity, f.source, f.checkout);
    assert.equal(await checkout.matches(f.identity, f.checkout), true);
    assert.equal(
      await readFile(path.join(f.checkout, "code.txt"), "utf8"),
      "recorded head\n",
    );
    const calls = await f.calls();
    const cloneIndex = calls.findIndex((call) => call.kind === "clone");
    const fetchGets = calls
      .slice(cloneIndex + 1)
      .filter((call) => call.operation === "get");
    assert.equal(fetchGets.length, 2);
    assert.ok(
      fetchGets.every(
        (call) =>
          call.fields?.protocol === "https" &&
          call.fields.host === "github.com" &&
          call.fields.path === "fixture/repository.git",
      ),
    );
    const config = await readFile(path.join(f.checkout, ".git/config"), "utf8");
    assert.equal(/credential|auth git-credential/.test(config), false);
    assert.equal(
      JSON.stringify({ log, calls, config }).includes(f.canary),
      false,
    );
    const before = calls.length;
    await checkout.git(["rev-parse", "HEAD"], f.checkout);
    assert.equal((await f.calls()).length, before);
  } finally {
    await f.close();
  }
});

test("recorded head SHA fallback retains the same scoped GH route", async () => {
  const f = await githubAcquisitionFixture();
  try {
    await f.git(
      path.join(f.root, "fixture/repository.git"),
      "update-ref",
      "-d",
      "refs/pull/7/head",
    );
    const checkout = new SourceCheckout(f.env);
    await checkout.prepare(f.identity, f.source, f.checkout);
    assert.equal(await checkout.matches(f.identity, f.checkout), true);
    const calls = await f.calls();
    const cloneIndex = calls.findIndex((call) => call.kind === "clone");
    assert.equal(
      calls.slice(cloneIndex + 1).filter((call) => call.operation === "get")
        .length,
      3,
    );
  } finally {
    await f.close();
  }
});

for (const state of ["unavailable", "denied"])
  test(`synthetic ${state} credentials fail at recorded base without prompts, retries or secret diagnostics`, async () => {
    const f = await githubAcquisitionFixture();
    try {
      f.env.FIXTURE_CREDENTIAL = state;
      let failure: unknown;
      try {
        await new SourceCheckout(f.env).prepare(
          f.identity,
          f.source,
          f.checkout,
        );
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof CommandFailure);
      assert.match(failure.summary, /Unable to prepare recorded base/);
      assert.equal(failure.message.includes(f.canary), false);
      const calls = await f.calls();
      const cloneIndex = calls.findIndex((call) => call.kind === "clone");
      assert.equal(
        calls.slice(cloneIndex + 1).filter((call) => call.operation === "get")
          .length,
        1,
      );
      assert.equal(JSON.stringify(calls).includes(f.canary), false);
      assert.equal(
        await new SourceCheckout(f.env).matches(f.identity, f.checkout),
        false,
      );
    } finally {
      await f.close();
    }
  });

for (const origin of [
  "https://github.com/fixture/other.git",
  "https://example.invalid/fixture/repository.git",
  "https://github.com@elsewhere.invalid/fixture/repository.git",
  "https://github.com/fixture/repository.git?destination=other",
  "git@github.com:fixture/other.git",
])
  test(`unexpected synthetic origin ${origin} is refused before credential routing`, async () => {
    const f = await githubAcquisitionFixture();
    try {
      f.env.FIXTURE_ORIGIN = origin;
      await assert.rejects(
        new SourceCheckout(f.env).prepare(f.identity, f.source, f.checkout),
        /origin or Git configuration is not trusted/,
      );
      const calls = await f.calls();
      assert.equal(calls.at(-1)?.kind, "clone");
    } finally {
      await f.close();
    }
  });

for (const config of [
  "[credential]\n helper = !gh auth git-credential\n",
  '[url "https://example.invalid/"]\n insteadOf = https://github.com/\n',
  "[include]\n path = /untrusted/fixture\n",
  "[http]\n extraHeader = Authorization: synthetic-untrusted\n",
  "[core]\n sshCommand = untrusted-fixture\n",
])
  test("untrusted clone-local transport configuration cannot invoke the trusted credential route", async () => {
    const f = await githubAcquisitionFixture();
    try {
      f.env.FIXTURE_CONFIG = config;
      await assert.rejects(
        new SourceCheckout(f.env).prepare(f.identity, f.source, f.checkout),
        /origin or Git configuration is not trusted/,
      );
      assert.equal((await f.calls()).at(-1)?.kind, "clone");
    } finally {
      await f.close();
    }
  });

test("HTTPS acquisition refuses redirects before another path can receive credentials", async (t) => {
  const f = await githubAcquisitionFixture();
  try {
    const checkout = new SourceCheckout(f.env);
    const git = checkout.git.bind(checkout);
    t.mock.method(
      checkout,
      "git",
      async (args: string[], cwd: string, signal?: AbortSignal) => {
        if (args.includes("fetch"))
          f.transport.redirect = "https://github.com/fixture/other.git";
        return git(args, cwd, signal);
      },
    );
    await assert.rejects(
      checkout.prepare(f.identity, f.source, f.checkout),
      /Unable to prepare recorded base/,
    );
    const calls = await f.calls();
    assert.equal(calls.at(-1)?.kind, "clone");
    assert.ok(
      f.requests.every((request) =>
        request.path.startsWith("/fixture/repository.git/"),
      ),
    );
  } finally {
    await f.close();
  }
});

for (const revision of ["base", "head", "checkout"] as const)
  test(`authenticated acquisition preserves the exact ${revision} mismatch guard`, async (t) => {
    const f = await githubAcquisitionFixture();
    try {
      const checkout = new SourceCheckout(f.env);
      const git = checkout.git.bind(checkout);
      t.mock.method(
        checkout,
        "git",
        async (args: string[], cwd: string, signal?: AbortSignal) => {
          const result = await git(args, cwd, signal);
          const target =
            revision === "checkout"
              ? "HEAD"
              : `${revision === "base" ? f.identity.baseSha : f.identity.headSha}^{commit}`;
          return args[0] === "rev-parse" && args.at(-1) === target
            ? { ...result, stdout: "0".repeat(40) }
            : result;
        },
      );
      await assert.rejects(
        checkout.prepare(f.identity, f.source, f.checkout),
        revision === "checkout"
          ? /not pinned to recorded head/
          : new RegExp(`Prepared ${revision} revision does not match recorded`),
      );
    } finally {
      await f.close();
    }
  });

test("question acquisition shares host routing and verified checkout reuse", async () => {
  const f = await githubAcquisitionFixture();
  try {
    const checkout = new QuestionCheckout(f.source, f.env);
    const prepared = await checkout.prepare(question(f.identity));
    assert.equal(
      await readFile(path.join(prepared.checkoutDir, "code.txt"), "utf8"),
      "recorded head\n",
    );
    const before = (await f.calls()).length;
    const reused = await checkout.prepare(question(f.identity));
    assert.match(reused.log[0], /reused verified checkout/);
    assert.equal((await f.calls()).length, before);
    assert.equal(JSON.stringify(reused).includes(f.canary), false);
  } finally {
    await f.close();
  }
});

test("checkout environment retains config isolation and disables credential-bearing tracing and askpass", () => {
  const env = checkoutEnvironment({
    GIT_CONFIG_PARAMETERS: "untrusted",
    GH_DEBUG: "api",
    GIT_TRACE_CURL: "1",
    GIT_CURL_VERBOSE: "1",
    GIT_ASKPASS: "untrusted",
    HOME: "/synthetic/home",
  });
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(env.GH_DEBUG, undefined);
  assert.equal(env.GIT_TRACE_CURL, undefined);
  assert.equal(env.GIT_CURL_VERBOSE, undefined);
  assert.equal(env.GIT_ASKPASS, "/usr/bin/false");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_TEMPLATE_DIR, "/dev/null");
  assert.equal(env.GIT_CONFIG_VALUE_0, "/dev/null");
  assert.equal(env.GIT_CONFIG_VALUE_1, "false");
  assert.equal(env.GIT_CONFIG_VALUE_2, "never");
});

function settings(
  mode: "dangerous" | "separated" | "docker",
): ReviewerSettings {
  const skill = {
    version: 1 as const,
    path: "/synthetic/REVIEW.md",
    directory: "/synthetic",
    digest: "synthetic",
    files: [],
  };
  const policy: IsolatedCapabilityPolicy = {
    version: 1,
    profile: "restricted-native-1",
    harness: "claude",
    configSource: "/synthetic/config",
    configDigest: "synthetic",
    provenance: [],
    auth: { kind: "environment", source: "SYNTHETIC_ONLY" },
    preferences: {},
    library: {
      digest: "synthetic",
      roots: [],
      skills: [],
      diagnostics: [],
      loading: "static-read-catalog",
    },
  };
  const base: ReviewerSettings = {
    skillPath: skill.path,
    model: "synthetic-model",
    additionalInstructions: "",
  };
  if (mode === "separated")
    return {
      ...base,
      skillExecution: {
        version: 3,
        mode,
        harness: "claude",
        skill,
        policy,
        roles: {
          main: {
            id: "synthetic-main",
            harness: "claude",
            role: "main",
            model: "synthetic-model",
            additionalInstructions: "",
            policy,
          },
          additional: [],
        },
      },
    };
  if (mode === "dangerous")
    return {
      ...base,
      skillExecution: { version: 2, mode, harness: "claude", skill },
      hostExecution: {
        version: 1,
        harness: "claude",
        confirmedAt: "2026-01-01T00:00:00Z",
      },
    };
  return {
    ...base,
    skillExecution: { version: 2, mode, harness: "claude", skill },
    execution: {
      version: 2,
      digest: "synthetic",
      image: "synthetic",
      policy: "synthetic",
      broker: "synthetic",
      models: { claude: "synthetic", codex: "synthetic" },
      harness: "claude",
      sourceId: "a".repeat(32),
      skillDigest: "synthetic",
      fixture: true,
      docker: {
        profile: "container-native-1",
        approval: {
          digest: "synthetic",
          customizations: [],
          credentialExposures: [],
          confirmation: "Synthetic fixture only",
        },
        disclosure: {
          version: 1,
          profile: "container-native-1",
          digest: "synthetic",
          harness: "claude",
          model: "synthetic",
          skillPath: skill.path,
          skillDigest: skill.digest,
          resources: [],
          customizations: [],
          authentication: [],
          localConnections: [],
          boundary: {
            source: "immutable-input-disposable-workcopy",
            network: "none-with-captured-brokers",
            sourceWriteback: false,
            hostExecution: false,
          },
          requirements: [],
          evidence: "local_configuration",
        },
      },
    },
  };
}

for (const mode of ["dangerous", "separated", "docker"] as const)
  test(`${mode} review and question adapters reuse authenticated host acquisition without starting a harness`, async (t) => {
    const f = await githubAcquisitionFixture();
    try {
      let dispatches = 0;
      const execute = async (request: ExecutionRequest) => {
        const source = await request.prepare(request.signal);
        const checkout = path.join(source, "checkout");
        assert.equal(
          await new SourceCheckout(f.env).matches(f.identity, checkout),
          true,
        );
        const config = await readFile(
          path.join(checkout, ".git/config"),
          "utf8",
        );
        assert.equal(/credential|auth git-credential/.test(config), false);
        assert.equal(
          JSON.stringify({
            prompt: request.prompt,
            settings: request.settings,
            config,
          }).includes(f.canary),
          false,
        );
        dispatches++;
        return {
          value:
            request.kind === "review"
              ? review
              : {
                  kind: "answer",
                  answer: "Synthetic source answer",
                  followUps: [],
                },
          log: "Inert executor fixture",
        };
      };
      t.mock.method(HostExecutor.prototype, "execute", execute);
      const adapters = workflowAdapters(
        {
          execute,
          status: () => ({
            status: "configured",
            message: "Inert fixture",
            snapshot: null,
          }),
        },
        {},
        f.source,
        f.env,
      );
      const configured = settings(mode);
      const item = await new DemoGithubAdapter().getPullRequest(
        "fixture/repository",
        42,
      );
      Object.assign(item.pr, f.identity, { baseRef: "main", headRef: "topic" });
      await adapters.reviewer.run(
        {
          pr: item.pr,
          diff: "Synthetic fixture diff",
          instructions: "",
          draft: null,
        },
        configured,
        "synthetic-review",
      );
      await adapters.questioner.ask(question(f.identity), configured);
      assert.equal(dispatches, 2);
      assert.equal(
        (await f.calls()).filter((call) => call.operation === "get").length,
        6,
      );
    } finally {
      await f.close();
    }
  });

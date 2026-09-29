import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dangerousConfirmation,
  dockerSetupConfirmation,
  dockerApprovalConfirmation,
  automationOff,
  type HarnessId,
  type PullRequestDetail,
} from "../../shared/contracts.js";
import { loadConfig } from "../config.js";
import { ReviewService } from "../service.js";
import { createHttpServer } from "../http.js";
import {
  managedConfiguration,
  prepareManagedWorkflow,
  installManagedRuntime,
} from "../execution/managed.js";
import { supportedImage } from "../execution/policy.js";
import { HostExecutor } from "../execution/host.js";
import { DockerExecutor } from "../execution/executor.js";
import { ConfiguredWorkflows } from "../execution/workflows.js";
import type { runCommand } from "../util.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-modes-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const skillPath = path.join(home, ".claude/skills/pr-review/SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(bin);
  await writeFile(
    skillPath,
    "FULL SYNTHETIC SKILL: preserve nested orchestration using codex exec",
  );
  const env = {
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    FIXTURE_LOG: path.join(root, "calls.jsonl"),
  };
  const script = async (name: string, code: string) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${code}`);
    await chmod(file, 0o755);
  };
  await script(
    "gh",
    'require("node:fs").mkdirSync(process.argv[5], {recursive:true})',
  );
  await script(
    "git",
    'const args=process.argv.slice(2); if(args[0]==="rev-parse") process.stdout.write(args.at(-1)==="HEAD" ? "demo-head-sha-1" : args.at(-1).replace("^{commit}",""));',
  );
  for (const harness of ["claude", "codex", "pi"])
    await script(
      harness,
      `const fs=require("node:fs"); const prompt=fs.readFileSync(0,"utf8");
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({harness:${JSON.stringify(harness)},args:process.argv.slice(2),prompt,cwd:process.cwd(),home:process.env.HOME})+"\\n");
if (prompt.includes("FIXTURE_FAIL")) process.exit(1);
if (prompt.includes("FIXTURE_MALFORMED")) console.log("not-json");
if (prompt.includes("FIXTURE_HANG")) setInterval(()=>{},1000);
else {
const schema = JSON.parse(prompt.split("\\n\\n").at(-1));
const value = prompt.includes("not a full PR review") ? (schema.properties.answer ? {answer:"- Synthetic focused answer",followUps:["What calls it?"]} : {body:"Synthetic comment",severity:"non_blocking",origin:"introduced",evidence:"Fixture evidence"}) : {overview:"### Ticket intent\\nNo ticket\\n### What the PR does\\nSynthetic change\\n### Ticket coverage\\nUnverified",body:"Synthetic review",verdict:"COMMENT",findings:[],rationale:"Synthetic fixture"};
const line=x=>console.log(JSON.stringify(x));
if (${JSON.stringify(harness)}==="claude") line({type:"result",subtype:"success",is_error:false,structured_output:value});
else if (${JSON.stringify(harness)}==="codex") {line({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(value)}});line({type:"turn.completed"});}
else {line({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:JSON.stringify(value)}]}});line({type:"agent_end"});}
}`,
    );
  const app = loadConfig({
    demo: true,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data/app.sqlite"),
    workflowConfigPath: "",
    reviewer: { skillPath, model: null, additionalInstructions: "" },
  });
  const service = await ReviewService.create(
    app,
    undefined,
    undefined,
    undefined,
    env,
  );
  await service.selectSkillHarness({
    version: 3,
    workflow: "separated",
    harness: "claude",
    additional: [],
    reviewer: { skillPath, model: null },
  });
  service.queue.schedule = () => {};
  service.questionLane.schedule = () => {};
  const server = createHttpServer(service, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = async (route: string, body?: unknown, method = "POST") =>
    fetch(`${base}${route}`, {
      method: body === undefined ? "GET" : method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const prId = "demo/repository#42";
  const pr = `/prs/${encodeURIComponent(prId)}`;
  const detail = () => service.getDetail(prId);
  const processJob = async () => {
    await service.processJob(service.db.listJobs("queued")[0]);
    assert.equal(
      detail().runs[0].status,
      "completed",
      detail().runs[0].error ?? "",
    );
  };
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await service.close();
    }
  };
  return {
    root,
    home,
    bin,
    env,
    app,
    service,
    send,
    pr,
    detail,
    processJob,
    stop,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("selection and setup confirmations fail closed without effects", async () => {
  const f = await fixture();
  try {
    const before = f.service.db.getSettings();
    for (const route of [
      "/state",
      "/settings/harness",
      "/settings/execution",
      "/settings/integrations",
    ])
      assert.equal((await f.send(route)).status, 200);
    assert.equal(
      (
        await f.send("/settings/execution/setup", {
          harness: "claude",
          confirmation: "yes",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.send(
          "/settings/harness",
          {
            version: 2,
            workflow: "dangerous",
            harness: "pi",
            reviewer: { skillPath: f.app.reviewer.skillPath, model: null },
          },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (await f.send("/settings/harness/import", { path: "/never/read" }))
        .status,
      404,
    );
    assert.deepEqual(f.service.db.getSettings(), before);
    assert.equal(f.service.getHarness().setup.status, "not_started");
    assert.equal(
      (
        await f.send(
          "/settings/harness",
          {
            version: 2,
            workflow: "docker",
            harness: "pi",
            reviewer: { skillPath: f.app.reviewer.skillPath, model: null },
          },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(f.service.getExecution().status, "unavailable");
    await f.send("/sync", {});
    assert.equal((await f.send(`${f.pr}/review`, {})).status, 409);
    assert.deepEqual(f.service.db.getSettings().automation, automationOff);
    await assert.rejects(readFile(f.env.FIXTURE_LOG));
  } finally {
    await f.close();
  }
});

for (const harness of ["claude", "codex", "pi"] as HarnessId[])
  test(`Dangerous ${harness} uses only inert host fixtures for immutable reviews, revisions, questions, retries and cancellation`, async () => {
    const f = await fixture();
    const select = () =>
      f.send(
        "/settings/harness",
        {
          version: 2,
          workflow: "dangerous",
          harness,
          reviewer: { skillPath: f.app.reviewer.skillPath, model: null },
          confirmation: dangerousConfirmation,
        },
        "PATCH",
      );
    const separate = () =>
      f.send(
        "/settings/harness",
        {
          version: 3,
          workflow: "separated",
          harness: "claude",
          additional: [],
          reviewer: { skillPath: f.app.reviewer.skillPath, model: null },
        },
        "PATCH",
      );
    try {
      await f.send("/sync", {});
      assert.equal((await select()).status, 200);
      await f.send(`${f.pr}/review`, {});
      const consent = f.detail().runs[0].reviewer.hostExecution;
      assert.equal(consent?.harness, harness);
      await separate();
      await f.processJob();
      const draft = f.detail().draft!;
      await f.send(
        `${f.pr}/draft`,
        {
          draftId: draft.id,
          version: draft.version,
          body: "Manual text survives",
          verdict: draft.verdict,
          findings: draft.findings,
        },
        "PUT",
      );
      await select();
      await f.send(`${f.pr}/revise`, {
        draftId: draft.id,
        draftVersion: f.detail().draft!.version,
        instructions: "Keep manual text",
      });
      await separate();
      await f.processJob();
      assert.equal(f.detail().draft!.body, "Manual text survives");
      assert.equal(f.detail().proposals.length, 1);
      assert.equal(f.detail().runs[0].reviewer.hostExecution?.harness, harness);
      const request = {
        mode: "explain",
        range: {
          path: "src/demo.ts",
          from: { side: "RIGHT", line: 2 },
          to: { side: "RIGHT", line: 2 },
          baseSha: "demo-base-sha-1",
          headSha: "demo-head-sha-1",
        },
        draftId: draft.id,
      };
      await select();
      await f.send(`${f.pr}/questions`, request);
      let question = f.detail().questions[0];
      await separate();
      await f.service.processQuestion(question);
      question = f.detail().questions.find((q) => q.id === question.id)!;
      assert.equal(question.status, "completed", question.error ?? "");
      assert.equal(question.reviewerSnapshot!.hostExecution?.harness, harness);
      await f.send(
        "/settings/integrations/github",
        { enabled: false },
        "PATCH",
      );
      await f.send(`${f.pr}/questions`, {
        ...request,
        parentId: question.id,
        question: "FIXTURE_FAIL",
      });
      const failed = f
        .detail()
        .questions.find((q) => q.question === "FIXTURE_FAIL")!;
      assert.deepEqual(
        failed.integrationSnapshot,
        question.integrationSnapshot,
      );
      await f.service.processQuestion(failed);
      assert.equal(
        f.detail().questions.find((q) => q.id === failed.id)!.status,
        "failed",
      );
      f.service.retryQuestion("demo/repository#42", failed.id);
      const retried = f.detail().questions.find((q) => q.id === failed.id)!;
      assert.deepEqual(retried.reviewerSnapshot, question.reviewerSnapshot);
      await f.service.processQuestion(retried);
      await f.send(`${f.pr}/questions`, {
        ...request,
        parentId: question.id,
        question: "FIXTURE_MALFORMED",
      });
      const malformed = f
        .detail()
        .questions.find((q) => q.question === "FIXTURE_MALFORMED")!;
      await f.service.processQuestion(malformed);
      assert.match(
        f.detail().questions.find((q) => q.id === malformed.id)!.error!,
        /complete successful structured result/,
      );
      await f.send(`${f.pr}/questions`, {
        ...request,
        parentId: question.id,
        question: "FIXTURE_HANG",
      });
      const hanging = f
        .detail()
        .questions.find((q) => q.question === "FIXTURE_HANG")!;
      const pending = f.service.processQuestion(hanging);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          (await readFile(f.env.FIXTURE_LOG, "utf8")).includes("FIXTURE_HANG")
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.match(await readFile(f.env.FIXTURE_LOG, "utf8"), /FIXTURE_HANG/);
      await f.send(`${f.pr}/questions/${hanging.id}/cancel`, {});
      await pending;
      assert.equal(
        f.detail().questions.find((q) => q.id === hanging.id)!.status,
        "cancelled",
      );
      const calls = (await readFile(f.env.FIXTURE_LOG, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(calls.length >= 4);
      assert.ok(
        calls.every(
          (call) =>
            call.harness === harness &&
            call.home === f.home &&
            !call.cwd.endsWith("/checkout"),
        ),
      );
      assert.match(calls[0].prompt, /FULL SYNTHETIC SKILL/);
      assert.doesNotMatch(calls[2].prompt, /FULL SYNTHETIC SKILL/);
      for (const mode of ["investigate", "draft_comment"]) {
        await f.send(`${f.pr}/questions`, {
          ...request,
          parentId: question.id,
          mode,
        });
        const focused = f.detail().questions.find((q) => q.mode === mode)!;
        await f.service.processQuestion(focused);
        assert.equal(
          f.detail().questions.find((q) => q.id === focused.id)!.status,
          "completed",
        );
      }
      assert.doesNotMatch(
        JSON.stringify(calls.map((call) => call.args)),
        /safe-mode|restricted|--tools|--sandbox|strict-mcp|--no-extensions|--no-approve/,
      );
      if (harness !== "pi")
        assert.match(JSON.stringify(calls[0].args), /dangerously-/);
      await rm(path.join(f.bin, harness));
      await select();
      await f.send(`${f.pr}/review`, {});
      await f.service.processJob(f.service.db.listJobs("queued")[0]);
      assert.equal(f.detail().runs[0].status, "failed");
      assert.equal(f.detail().draft!.body, "Manual text survives");
      assert.deepEqual(f.service.getState().settings.automation, automationOff);
    } finally {
      await f.close();
    }
  });

test("managed config derives existing settings without overwriting models/effort/resources; installation is explicit", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.home, ".codex"));
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'model="existing-codex"\nmodel_reasoning_effort="high"',
    );
    await writeFile(
      path.join(f.home, ".claude/settings.json"),
      JSON.stringify({ model: "existing-claude", effortLevel: "low" }),
    );
    await assert.rejects(
      managedConfiguration(f.app, "claude", path.join(f.root, "bundle"), f.env),
      /single-effort/,
    );
    await writeFile(
      path.join(f.home, ".claude/settings.json"),
      JSON.stringify({ model: "existing-claude", effortLevel: "high" }),
    );
    const config = await managedConfiguration(
      f.app,
      "claude",
      path.join(f.root, "bundle"),
      f.env,
    );
    assert.deepEqual(config.models, {
      claude: "existing-claude",
      codex: "existing-codex",
    });
    assert.equal(config.effort, "high");
    assert.equal(config.auth, "fixture");
    assert.equal(config.fixtureNative, true);
    assert.deepEqual(config.nested, ["codex"]);
    assert.ok(config.files?.some((file) => file.target === ".claude/skills"));
    let installs = 0;
    const install = async () => {
      installs++;
      const dir = path.join(f.root, "bundle");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "fixture.mjs"), "synthetic inert runtime");
      return dir;
    };
    const first = await prepareManagedWorkflow(f.app, "claude", f.env, install);
    assert.equal(
      await prepareManagedWorkflow(f.app, "claude", f.env, install),
      first,
    );
    assert.equal(installs, 2);
    assert.equal(f.service.getHarness().selection?.workflow, "separated");
    await writeFile(
      path.join(f.home, ".claude/settings.json"),
      JSON.stringify({
        model: "existing-claude",
        mcpServers: { unsupported: {} },
      }),
    );
    await assert.rejects(
      prepareManagedWorkflow(f.app, "claude", f.env, install),
      /mcpServers/,
    );
    assert.equal(installs, 2);
    assert.match(
      await readFile(path.join(f.home, ".claude/settings.json"), "utf8"),
      /mcpServers/,
    );
  } finally {
    await f.close();
  }
});

test(
  "managed installer validates profile and image, cleans failures and reuses only digest-matching owned runtime",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pr-review-installer-"));
    const commands: string[][] = [];
    let fail = true;
    const run: typeof runCommand = async (_command, args) => {
      commands.push(args);
      let stdout = "";
      if (args.includes("version"))
        stdout = JSON.stringify({
          Version: "29.8.0",
          GitCommit: "3ce5872",
          Os: "linux",
          Arch: "arm64",
          KernelVersion: "7.0.12-linuxkit",
        });
      if (args.includes("inspect"))
        stdout = JSON.stringify([
          { Id: supportedImage, Architecture: "arm64", Os: "linux" },
        ]);
      if (args.includes("run")) {
        const mount = args.find((arg) => arg.endsWith(",dst=/bundle"))!;
        await writeFile(
          path.join(mount.split("src=")[1].split(",dst=")[0], "fixture"),
          "INERT INSTALLER FIXTURE",
        );
      }
      return {
        stdout,
        stderr: "synthetic installer diagnostic",
        code: fail && args.includes("run") ? 1 : 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    };
    try {
      await assert.rejects(
        installManagedRuntime(root, run),
        /synthetic installer diagnostic/,
      );
      assert.ok(commands.some((args) => args.includes("rm")));
      assert.ok(
        !(await readdir(root)).some((name) => name.startsWith("install-")),
      );
      fail = false;
      const bundle = await installManagedRuntime(root, run);
      const count = commands.length;
      assert.equal(await installManagedRuntime(root, run), bundle);
      assert.equal(commands.length, count);
      await writeFile(path.join(bundle, "fixture"), "changed");
      await assert.rejects(installManagedRuntime(root, run), /cache changed/);
      assert.equal(commands.length, count);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("setup rejects overlapping actions and shuts down without selecting a partial source", async () => {
  const f = await fixture();
  try {
    await f.service.selectSkillHarness({
      version: 2,
      workflow: "docker",
      harness: "claude",
      reviewer: f.app.reviewer,
    });
    const disclosure = await f.service.inspectDocker({ harness: "claude" });
    const approval = {
      digest: disclosure.digest,
      customizations: disclosure.customizations.map((item) => item.id),
      credentialExposures: disclosure.authentication.map(
        (item) => item.harness,
      ),
      confirmation: dockerApprovalConfirmation,
    };
    const pending = f.service.executor!.setup(
      "claude",
      f.env,
      async (_app, _harness, _env, _install, signal) => {
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
        throw new Error("unreachable");
      },
      approval,
    );
    const rejected = assert.rejects(pending, /shutting down/);
    assert.equal(f.service.getHarness().setup?.status, "running");
    await assert.rejects(
      f.service.executor!.setup("codex", f.env),
      /already running/,
    );
    await f.service.executor!.close();
    await rejected;
    assert.equal(f.service.getHarness().setup?.status, "failed");
    assert.equal(f.service.getHarness().selection?.workflow, "docker");
    assert.deepEqual(f.service.db.getSettings().harness!.sources, []);
  } finally {
    await f.close();
  }
});

test("recorded Docker approval survives changed selection and restart without granting drifted artifacts", async (t) => {
  const f = await fixture();
  t.mock.method(DockerExecutor.prototype, "check", async () => {});
  try {
    const selection = {
      version: 2 as const,
      workflow: "docker" as const,
      harness: "claude" as const,
      reviewer: { ...f.app.reviewer, model: "sonnet" },
    };
    await f.service.selectSkillHarness(selection);
    const disclosure = await f.service.inspectDocker({ harness: "claude" });
    assert.equal(f.service.getExecution().lastApprovedDocker, undefined);
    const approval = {
      digest: disclosure.digest,
      customizations: disclosure.customizations.map((item) => item.id),
      credentialExposures: disclosure.authentication.map(
        (item) => item.harness,
      ),
      confirmation: dockerApprovalConfirmation,
    };
    const bundle = path.join(f.root, "bundle");
    await mkdir(bundle);
    await writeFile(path.join(bundle, "fixture.mjs"), "INERT RUNTIME");
    const setup = f.service.executor!.setup.bind(f.service.executor);
    t.mock.method(
      f.service.executor!,
      "setup",
      (...[harness, env, _prepare, consent]: Parameters<typeof setup>) =>
        setup(
          harness,
          env,
          async (_app, _h, _e, _i, _s, config) => {
            const file = path.join(f.root, "workflow.json");
            await writeFile(
              file,
              JSON.stringify({ ...config, auth: "fixture", bundle }),
            );
            return file;
          },
          consent,
        ),
    );
    await f.service.setupDocker("claude", dockerSetupConfirmation, approval);
    const recorded = f.service.getExecution().snapshot!.docker;
    assert.deepEqual(f.service.getExecution().lastApprovedDocker, recorded);
    await writeFile(f.app.reviewer.skillPath, "CHANGED SYNTHETIC SKILL");
    await f.service.selectSkillHarness({
      ...selection,
      reviewer: { ...selection.reviewer, model: "opus" },
    });
    assert.equal(f.service.getExecution().snapshot, null);
    assert.deepEqual(f.service.getExecution().lastApprovedDocker, recorded);
    await f.service.executor!.close();
    const settings = f.service.db.getSettings().harness!;
    const reopened = await ConfiguredWorkflows.open(f.app, settings);
    try {
      assert.equal(reopened.status().snapshot, null);
      assert.deepEqual(reopened.status().lastApprovedDocker, recorded);
      reopened.update({
        ...settings,
        selection: { ...selection, harness: "codex" },
      });
      assert.equal(reopened.status().lastApprovedDocker, undefined);
      reopened.update({
        ...settings,
        sources: settings.sources.map((source) => ({
          ...source,
          digest: "old-policy-or-changed-artifact",
        })),
      });
      assert.equal(reopened.status().lastApprovedDocker, undefined);
      assert.equal(reopened.status().status, "unavailable");
      assert.equal(reopened.status().snapshot, null);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("host execution rejects absent captured consent before preparing or dispatching", async () => {
  await assert.rejects(
    new HostExecutor({ PATH: "/nonexistent", HOME: "/nonexistent" }).execute({
      runId: "fixture",
      settings: {
        skillPath: "/unused",
        model: null,
        additionalInstructions: "",
      },
      prepare: async () => {
        throw new Error("must not prepare");
      },
      metadata: {},
      diff: "",
      prompt: "",
      schema: {},
    }),
    /no longer supported/,
  );
});

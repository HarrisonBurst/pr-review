import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../config.js";
import { ReviewService } from "../../service.js";
import { createHttpServer } from "../../http.js";
import { fixtureCredentials } from "../../execution/auth.js";
import type {
  HarnessSelectionUpdate,
  PullRequestDetail,
} from "../../../shared/contracts.js";
const prId = "demo/repository#42";
export async function fixture(
  readProviders?: import("../../read-providers.js").ReadProviders,
) {
  const root = await mkdtemp(path.join(tmpdir(), "isolated-roles-demo-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const skillPath = path.join(home, "skills/fixture-audit/REVIEW.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(bin);
  await writeFile(
    skillPath,
    "---\nname: fixture-audit\nmodel: skill-pin-not-selected\nallowed-tools: Read, Bash, Agent, Task\n---\n# Deterministic roles fixture\nUse [rubric](rubric.md). This requires Bash to run codex exec for secondary evidence, then verify it.\n",
  );
  await writeFile(
    path.join(path.dirname(skillPath), "rubric.md"),
    "FROZEN RUBRIC",
  );
  await mkdir(path.join(home, ".pi/agent"), { recursive: true });
  await writeFile(
    path.join(home, ".pi/agent/auth.json"),
    JSON.stringify({
      "openai-codex": { type: "oauth", ...fixtureCredentials().pi },
    }),
  );
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex/auth.json"),
    JSON.stringify(fixtureCredentials().codex),
  );
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "SYNTHETIC_CLAUDE_MODEL_ONLY",
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
    'const args=process.argv.slice(2); if(args[0]==="config") process.stdout.write(args.at(-1)==="remote.origin.url" ? "git@github.com:demo/repository.git" : "core.bare"); if(args[0]==="rev-parse") process.stdout.write(args.at(-1)==="HEAD" ? "demo-head-sha-1" : args.at(-1).replace("^{commit}",""));',
  );
  const harnessScript = await readFile(
    new URL("isolated-harness.cjs", import.meta.url),
    "utf8",
  );
  for (const harness of ["claude", "codex", "pi"])
    await script(
      harness,
      harnessScript.replaceAll(
        "process.env.FIXTURE_LOG",
        JSON.stringify(env.FIXTURE_LOG),
      ),
    );
  const app = loadConfig({
    demo: true,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data/app.sqlite"),
    workflowConfigPath: "",
    reviewer: { skillPath, model: null, additionalInstructions: "" },
  });
  let service = await ReviewService.create(
    app,
    undefined,
    undefined,
    undefined,
    env,
    readProviders,
  );
  let schedule = service.queue.schedule.bind(service.queue);
  let nextQueuedJob = service.nextQueuedJob.bind(service);
  service.nextQueuedJob = () => null;
  service.queue.schedule = () => {};
  service.questionLane.schedule = () => {};
  let server = createHttpServer(service, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = (route: string, body?: unknown, method = "POST") =>
    fetch(base + route, {
      method: body === undefined ? "GET" : method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const selection: HarnessSelectionUpdate = {
    version: 3,
    workflow: "separated",
    harness: "pi",
    reviewer: { skillPath, model: "main-fixture" },
    additional: [
      { id: "codex-one", harness: "codex", model: "model-one" },
      { id: "codex-two", harness: "codex", model: "model-two" },
    ],
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  };
  return {
    root,
    home,
    env,
    app,
    skillPath,
    get service() {
      return service;
    },
    send,
    selection,
    script,
    pr: `/prs/${encodeURIComponent(prId)}`,
    detail: async (): Promise<PullRequestDetail> =>
      (await send(`/prs/${encodeURIComponent(prId)}`)).json(),
    async restart() {
      await stop();
      service = await ReviewService.create(
        app,
        undefined,
        undefined,
        undefined,
        env,
        readProviders,
      );
      schedule = service.queue.schedule.bind(service.queue);
      nextQueuedJob = service.nextQueuedJob.bind(service);
      service.nextQueuedJob = () => null;
      service.queue.schedule = () => {};
      service.questionLane.schedule = () => {};
      server = createHttpServer(service, app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    },
    stop,
    async dispatch() {
      service.nextQueuedJob = nextQueuedJob;
      schedule();
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          !["queued", "running"].includes(
            service.getDetail(prId).runs[0].status,
          )
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("Fixture queue did not finish");
    },
    calls: async () =>
      (await readFile(env.FIXTURE_LOG, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    async close() {
      if (server.listening) await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

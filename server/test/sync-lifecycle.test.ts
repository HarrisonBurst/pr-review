import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { automationOff, type AppState } from "../../shared/contracts.js";
import { loadConfig } from "../config.js";
import { createHttpServer } from "../http.js";
import { ReviewService } from "../service.js";
import { runCommand } from "../util.js";
import { deferredWork, DeferredGithub } from "./fixtures/sync-lifecycle.js";

const url = (number = 42) =>
  `https://github.com/demo/repository/pull/${number}`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pr-review-lifecycle-test-"));
  const home = join(root, "home");
  await mkdir(home);
  const config = loadConfig({
    host: "127.0.0.1",
    port: 0,
    demo: true,
    dataDir: root,
    databasePath: join(root, "test.sqlite"),
    reviewer: {
      skillPath: join(home, "absent.md"),
      model: null,
      additionalInstructions: "",
    },
  });
  const github = new DeferredGithub();
  let service = await ReviewService.create(config, github);
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  config.port = address.port;
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    github.sync?.resolve();
    github.readiness?.resolve();
    for (const work of github.imports.values()) work.resolve();
    await setImmediate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    home,
    service,
    github,
    origin,
    state: async () =>
      (await (await fetch(`${origin}/api/state`)).json()) as AppState,
    post: (path: string, body = {}, signal?: AbortSignal) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    restart: async () => {
      await service.close();
      service = await ReviewService.create(config, github);
      return service;
    },
  };
}

test("command timeout termination refusal fails sync without taking down HTTP", async (t) => {
  const { home, github, state, post } = await fixture(t);
  let pid: number | undefined;
  const kill = process.kill.bind(process);
  const injected = t.mock.method(
    process,
    "kill",
    (...[target, signal]: Parameters<typeof process.kill>) => {
      assert.equal(target, -pid!);
      assert.equal(signal, "SIGTERM");
      throw Object.assign(new Error("kill EPERM (injected inert fixture)"), {
        code: "EPERM",
      });
    },
  );
  github.poll = async () => {
    await runCommand(
      process.execPath,
      [
        "-e",
        "console.log(process.pid); setTimeout(() => process.exit(0), 10000)",
      ],
      {
        timeoutMs: 1000,
        env: { HOME: home },
        onStdout: (chunk) => {
          pid = Number(chunk.toString());
        },
      },
    );
    throw new Error("Inert timeout must not succeed");
  };
  try {
    const response = await post("/api/sync");
    assert.equal(response.status, 200);
    const outcome = ((await response.json()) as AppState).operations.sync!;
    assert.equal(outcome.status, "failed");
    assert.match(
      outcome.error!,
      /timed out; SIGTERM failed:.*EPERM.*cleanup is unconfirmed/,
    );
    assert.ok(pid);
    assert.equal(kill(pid, 0), true);
    assert.deepEqual((await state()).operations.sync, outcome);
    assert.deepEqual((await state()).prs, []);
  } finally {
    injected.mock.restore();
  }
});

test("sync projects the shared manual/scheduled lifetime through readiness and retains its outcome", async (t) => {
  const { service, github, state } = await fixture(t);
  assert.deepEqual((await state()).operations, { sync: null, imports: [] });
  const transitions: AppState["operations"][] = [];
  service.onChange(() => transitions.push(service.getState().operations));
  github.sync = deferredWork();
  github.readiness = deferredWork();
  const pending = service.sync();
  await github.sync.entered;
  const running = (await state()).operations.sync!;
  assert.equal(running.status, "running");
  assert.equal(running.mode, "manual");
  assert.equal(running.repository, "demo/repository");
  assert.equal(running.finishedAt, null);
  assert.equal(running.error, null);
  const duplicate = service.sync("scheduled");
  assert.equal(github.pollCalls, 1);
  assert.equal((await state()).operations.sync!.id, running.id);
  github.sync.resolve();
  await github.readiness.entered;
  assert.equal((await state()).operations.sync!.status, "running");
  github.readiness.resolve();
  await Promise.all([pending, duplicate]);
  const finished = (await state()).operations.sync!;
  assert.equal(finished.id, running.id);
  assert.equal(finished.status, "completed");
  assert.ok(Date.parse(finished.finishedAt!) >= Date.parse(running.startedAt));
  assert.equal(transitions[0].sync!.status, "running");
  assert.equal(transitions.at(-1)!.sync!.status, "completed");
  assert.equal(running.status, "running");
  assert.deepEqual(service.getState().settings.automation, automationOff);
  assert.equal(service.getDetail("demo/repository#42").runs.length, 0);
  await service.sync();
  assert.equal(github.pollCalls, 2);
  assert.notEqual(service.getState().operations.sync!.id, running.id);
});

test("a manual request joins an active scheduled sync without widening its scope", async (t) => {
  const { service, github } = await fixture(t);
  await service.importPullRequest(url());
  service.db.updateSettings({
    automation: { ...automationOff, pollCommits: true },
  });
  github.sync = deferredWork();
  const scheduled = service.sync("scheduled");
  await github.sync.entered;
  const operation = service.getState().operations.sync!;
  const manual = service.sync();
  assert.equal(operation.mode, "scheduled");
  assert.equal(service.getState().operations.sync!.id, operation.id);
  assert.deepEqual(github.pollScopes, [{ numbers: [42], requestNumbers: [] }]);
  github.sync.resolve();
  await Promise.all([scheduled, manual]);
  assert.equal(github.pollCalls, 1);
  assert.equal(service.getDetail("demo/repository#42").runs.length, 0);
});

test("imports coalesce canonical identity only while active and overlap independently with sync and other imports", async (t) => {
  const { service, github, state } = await fixture(t);
  const work42 = deferredWork();
  const work43 = deferredWork();
  github.imports.set(42, work42);
  github.imports.set(43, work43);
  github.sync = deferredWork();
  const sync = service.sync();
  const first = service.importPullRequest(url());
  await work42.entered;
  const duplicate = service.importPullRequest(
    `${url().replace("/42", "/042")}/?tab=ignored#discussion`,
  );
  const second = service.importPullRequest(url(43));
  const failed = assert.rejects(second, /inert import refused/);
  await work43.entered;
  const active = (await state()).operations;
  assert.deepEqual(github.fetched, [42, 43]);
  assert.equal(active.imports.length, 2);
  assert.ok(
    active.imports.every((operation) => operation.status === "running"),
  );
  assert.notEqual(active.imports[0].id, active.imports[1].id);
  assert.deepEqual(
    active.imports.map((operation) => operation.prId),
    ["demo/repository#42", "demo/repository#43"],
  );
  work43.reject(new Error("inert import refused"));
  await failed;
  const overlapping = (await state()).operations;
  assert.equal(overlapping.sync!.status, "running");
  assert.equal(overlapping.imports[0].status, "running");
  assert.equal(overlapping.imports[1].status, "failed");
  assert.equal(overlapping.imports[1].error, "inert import refused");
  github.readiness = deferredWork();
  work42.resolve();
  await github.readiness.entered;
  assert.equal((await state()).operations.imports[0].status, "running");
  github.readiness.resolve();
  const [detail, same] = await Promise.all([first, duplicate]);
  assert.equal(detail.pr.id, same.pr.id);
  assert.equal(detail.pr.imported, true);
  assert.equal((await state()).operations.imports[0].status, "completed");
  assert.equal((await state()).operations.sync!.status, "running");
  github.sync.resolve();
  await sync;
  await service.importPullRequest(url());
  const settled = (await state()).operations;
  assert.deepEqual(github.fetched, [42, 43, 42]);
  assert.equal(settled.imports.length, 2);
  assert.notEqual(settled.imports[0].id, active.imports[0].id);
  assert.equal(settled.imports[1].id, active.imports[1].id);
  assert.equal(settled.imports[1].status, "failed");
  github.imports.delete(43);
  await service.importPullRequest(url(43));
  const retried = (await state()).operations.imports[1];
  assert.equal(retried.status, "completed");
  assert.equal(retried.error, null);
  assert.notEqual(retried.id, settled.imports[1].id);
});

test("validation refuses work without replacing status; closed imports settle failure and preserve edited history", async (t) => {
  const { service, github, post, state } = await fixture(t);
  service.db.updateSettings({ repository: "" });
  await assert.rejects(service.sync(), { code: "repository_required" });
  const missingRepository = await post("/api/sync");
  assert.equal(missingRepository.status, 400);
  assert.equal((await missingRepository.json()).code, "repository_required");
  await assert.rejects(service.importPullRequest("not a URL"), {
    code: "invalid_url",
  });
  assert.deepEqual((await state()).operations, { sync: null, imports: [] });
  const imported = await service.importPullRequest(url());
  assert.equal(service.getState().settings.repository, "demo/repository");
  const created = service.createManualDraft(imported.pr.id).draft!;
  const edited = service.updateDraft(imported.pr.id, {
    draftId: created.id,
    version: created.version,
    body: "Preserve manual edits",
    findings: [],
    verdict: "COMMENT",
  }).draft;
  const settings = service.getState().settings;
  const operations = service.getState().operations;
  const mismatch = await post("/api/prs/import", {
    url: "https://github.com/other/repo/pull/42",
  });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).code, "repository_mismatch");
  const malformed = await post("/api/prs/import", { url: 42 });
  assert.equal(malformed.status, 400);
  assert.deepEqual((await state()).operations, operations);
  await service.sync("scheduled");
  assert.equal(github.pollCalls, 0);
  assert.deepEqual((await state()).operations, operations);
  github.state = "CLOSED";
  const refused = await post("/api/prs/import", { url: url() });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "pr_closed");
  assert.equal((await state()).operations.imports[0].status, "failed");
  assert.match(
    (await state()).operations.imports[0].error!,
    /only open pull requests/,
  );
  assert.deepEqual(service.getDetail(imported.pr.id).draft, edited);
  assert.deepEqual(service.getState().settings, settings);
  assert.equal(service.getDetail(imported.pr.id).runs.length, 0);
  assert.equal(service.getDetail(imported.pr.id).submissions.length, 0);
  await assert.rejects(service.importPullRequest(url(43)), {
    code: "pr_closed",
  });
  assert.equal(service.db.getPr("demo/repository#43"), null);
});

test("failures clear in-flight guards; restart has no active or terminal operation bits and preserves data", async (t) => {
  const f = await fixture(t);
  f.github.sync = deferredWork();
  const pending = f.service.sync();
  const failed = assert.rejects(pending, /inert sync failure/);
  await f.github.sync.entered;
  f.github.sync.reject(new Error("inert sync failure"));
  await failed;
  const prior = f.service.getState().operations.sync!;
  assert.equal(prior.status, "failed");
  assert.equal(prior.error, "inert sync failure");
  assert.ok(prior.finishedAt);
  f.github.sync = null;
  await f.service.sync();
  assert.equal(f.service.getState().operations.sync!.status, "completed");
  assert.notEqual(f.service.getState().operations.sync!.id, prior.id);
  const detail = await f.service.importPullRequest(url());
  const draft = f.service.createManualDraft(detail.pr.id).draft;
  const settings = f.service.getState().settings;
  const restarted = await f.restart();
  assert.deepEqual(restarted.getState().operations, {
    sync: null,
    imports: [],
  });
  assert.deepEqual(restarted.getState().settings, settings);
  assert.deepEqual(restarted.getDetail(detail.pr.id).draft, draft);
  assert.equal(restarted.getDetail(detail.pr.id).pr.imported, true);
  assert.equal(f.github.pollCalls, 2);
  assert.deepEqual(f.github.fetched, [42]);
});

for (const kind of ["sync", "import"] as const) {
  for (const outcome of ["completed", "failed"] as const) {
    test(
      `HTTP ${kind} survives initiating-client disconnect, emits transitions and reconnect sees ${outcome}`,
      { timeout: 10_000 },
      async (t) => {
        const { service, github, origin, post, state } = await fixture(t);
        const gate = deferredWork();
        if (kind === "sync") github.sync = gate;
        else github.imports.set(42, gate);
        const streamAbort = new AbortController();
        const stream = await fetch(`${origin}/api/events`, {
          signal: streamAbort.signal,
        });
        const reader = stream.body!.getReader();
        assert.match(
          new TextDecoder().decode((await reader.read()).value),
          /event: change/,
        );
        const clientAbort = new AbortController();
        const path = kind === "sync" ? "/api/sync" : "/api/prs/import";
        const body = kind === "sync" ? {} : { url: url() };
        const initiating = post(path, body, clientAbort.signal);
        await gate.entered;
        const current = (value: AppState) =>
          kind === "sync"
            ? value.operations.sync!
            : value.operations.imports[0];
        const running = current(await state());
        assert.equal(running.status, "running");
        assert.match(
          new TextDecoder().decode((await reader.read()).value),
          /event: change/,
        );
        const aborted = assert.rejects(initiating, { name: "AbortError" });
        clientAbort.abort();
        await aborted;
        assert.equal(current(await state()).id, running.id);
        assert.equal(current(await state()).status, "running");
        const joined = Promise.withResolvers<void>();
        if (kind === "sync") {
          const sync = service.sync.bind(service);
          service.sync = (mode) => {
            const pending = sync(mode);
            joined.resolve();
            return pending;
          };
        } else {
          const importPr = service.importPullRequest.bind(service);
          service.importPullRequest = (url) => {
            const pending = importPr(url);
            joined.resolve();
            return pending;
          };
        }
        const duplicate = post(path, body);
        await joined.promise;
        const finished = new Promise<void>((resolve) => {
          const remove = service.onChange(() => {
            if (current(service.getState()).status === "running") return;
            remove();
            resolve();
          });
        });
        if (outcome === "failed")
          gate.reject(new Error(`inert ${kind} failure`));
        else gate.resolve();
        await finished;
        const response = await duplicate;
        assert.equal(
          response.status,
          kind === "import" && outcome === "failed" ? 500 : 200,
        );
        await response.json();
        const terminal = current(await state());
        assert.equal(terminal.id, running.id);
        assert.equal(terminal.status, outcome);
        assert.ok(terminal.finishedAt);
        assert.equal(
          terminal.error,
          outcome === "failed" ? `inert ${kind} failure` : null,
        );
        assert.match(
          new TextDecoder().decode((await reader.read()).value),
          /event: change/,
        );
        streamAbort.abort();
        const reconnectAbort = new AbortController();
        const reconnected = await fetch(`${origin}/api/events`, {
          signal: reconnectAbort.signal,
        });
        assert.match(
          new TextDecoder().decode(
            (await reconnected.body!.getReader().read()).value,
          ),
          /event: change\ndata: \{\}/,
        );
        assert.deepEqual(current(await state()), terminal);
        reconnectAbort.abort();
        assert.equal(github.pollCalls, kind === "sync" ? 1 : 0);
        assert.deepEqual(github.fetched, kind === "import" ? [42] : []);
      },
    );
  }
}

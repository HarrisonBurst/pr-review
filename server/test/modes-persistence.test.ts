import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./fixtures/isolated-context.js";
import {
  automationOff,
  dangerousConfirmation,
  executionModes,
} from "../../shared/contracts.js";
import { loadConfig } from "../config.js";
import { HostExecutor } from "../execution/host.js";
import { loadWorkflow } from "../execution/config.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const question = {
  mode: "explain",
  range: {
    path: "src/demo.ts",
    from: { side: "RIGHT", line: 2 },
    to: { side: "RIGHT", line: 2 },
    baseSha: "demo-base-sha-1",
    headSha: "demo-head-sha-1",
  },
};

test("fresh unsaved Settings targets Dangerous without consent; removed HTTP APIs fail without fallback or setup", async () => {
  const f = await fixture();
  try {
    const before = f.service.db.getSettings();
    const status = f.service.getHarness();
    assert.equal(status.selection?.version, 2);
    assert.equal(status.selection?.workflow, "dangerous");
    assert.equal(before.harness?.dangerousConsent, undefined);
    assert.equal(status.requiresSave, true);
    assert.equal(status.effective, null);
    assert.equal("sources" in status, false);
    assert.equal("supportedSources" in status, false);
    assert.equal("harness" in f.service.getState().settings, false);
    assert.deepEqual(f.service.getIntegrations().connections, []);
    for (const route of [
      "/settings/harness/import",
      "/settings/integrations/import",
    ])
      assert.equal((await f.send(route, { path: "/never/read" })).status, 404);
    for (const selection of [
      { harness: "claude", workflow: "legacy", sourceId: null },
      { harness: "codex", workflow: "configured", sourceId: "startup" },
      { harness: "claude", workflow: "separated" },
      { ...f.selection, version: 2, additional: undefined },
      { ...f.selection, sourceId: null },
      { ...f.selection, workflow: "docker" },
    ])
      assert.equal(
        (await f.send("/settings/harness", selection, "PATCH")).status,
        400,
      );
    await f.send("/sync", {});
    assert.equal((await f.send(`${f.pr}/review`, {})).status, 409);
    assert.deepEqual(f.service.db.getSettings(), before);
    assert.equal(f.service.db.listJobs().length, 0);
    await assert.rejects(f.calls(), { code: "ENOENT" });
    assert.equal(f.service.getHarness().setup.status, "not_started");
    assert.equal(
      loadConfig({ workflowConfigPath: "/retired" }).workflowConfigPath,
      undefined,
    );
    const file = path.join(f.root, "archived-v1.json");
    await writeFile(file, JSON.stringify({ version: 1 }));
    await assert.rejects(
      loadWorkflow(file, "/never/read", true),
      /Unsupported workflow/,
    );
  } finally {
    await f.close();
  }
});

test("explicit valid modes preserve saved settings and consent across restart", async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.selection.reviewer.skillPath,
      "# Inert saved-mode persistence fixture\n",
    );
    assert.deepEqual(executionModes, ["dangerous", "separated", "docker"]);
    for (const workflow of executionModes) {
      const selection =
        workflow === "separated"
          ? f.selection
          : {
              version: 2,
              workflow,
              harness: "codex",
              reviewer: f.selection.reviewer,
            };
      if (workflow === "dangerous") {
        for (const confirmation of [undefined, "yes"]) {
          const before = f.service.db.getSettings();
          assert.equal(
            (
              await f.send(
                "/settings/harness",
                { ...selection, confirmation },
                "PATCH",
              )
            ).status,
            400,
          );
          assert.deepEqual(f.service.db.getSettings(), before);
        }
      }
      assert.equal(
        (
          await f.send(
            "/settings/harness",
            {
              ...selection,
              ...(workflow === "dangerous"
                ? { confirmation: dangerousConfirmation }
                : {}),
            },
            "PATCH",
          )
        ).status,
        200,
      );
      const saved = f.service.db.getSettings();
      await f.restart();
      assert.deepEqual(f.service.db.getSettings(), saved);
      assert.equal(f.service.getHarness().selection?.workflow, workflow);
      assert.equal(f.service.db.listJobs().length, 0);
    }
    await assert.rejects(f.calls(), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("archived selections and immutable history survive GET/restart; old questions never acquire current settings", async () => {
  const f = await fixture();
  try {
    await f.send("/settings/harness", f.selection, "PATCH");
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    await f.dispatch();
    const draft = (await f.detail()).draft!;
    f.service.updateDraft("demo/repository#42", {
      draftId: draft.id,
      version: draft.version,
      body: "MANUAL ARCHIVE",
      findings: draft.findings,
      verdict: draft.verdict,
    });
    await f.send(`${f.pr}/revise`, {
      draftId: draft.id,
      draftVersion: draft.version + 1,
      instructions: "Propose only",
    });
    await f.dispatch();
    await f.send(`${f.pr}/questions`, question);
    await f.service.processQuestion(f.service.nextQueuedQuestion()!);
    const q = (await f.detail()).questions[0];
    f.service.db.sqlite
      .prepare("UPDATE questions SET reviewer_json = NULL WHERE id = ?")
      .run(q.id);
    const runs = (await f.detail()).runs;
    for (const run of runs)
      f.service.db.sqlite
        .prepare("UPDATE runs SET reviewer_json = ? WHERE id = ?")
        .run(JSON.stringify(f.app.reviewer), run.id);
    const archive = async () => {
      const { pr: _pr, ...history } = await f.detail();
      return history;
    };
    const history = await archive();
    const saved = {
      ...f.service.db.getSettings().harness!,
      selection: {
        harness: "codex" as const,
        workflow: "configured",
        sourceId: "startup",
      },
    };
    f.service.db.updateHarness(saved);
    f.service.executor!.update(saved);
    assert.equal(f.service.getHarness().selection, null);
    assert.equal(f.service.getHarness().effective, null);
    assert.match(
      f.service.getHarness().diagnostics.join(" "),
      /Explicitly save/,
    );
    assert.equal((await f.send(`${f.pr}/review`, {})).status, 409);
    await f.restart();
    assert.deepEqual(f.service.db.getSettings().harness, saved);
    assert.deepEqual(await archive(), history);
    await f.send("/settings/harness", f.selection, "PATCH");
    const calls = await f.calls();
    assert.equal(
      (await f.send(`${f.pr}/questions/${q.id}/retry`, {})).status,
      409,
    );
    assert.equal(
      (await f.send(`${f.pr}/questions`, { ...question, parentId: q.id }))
        .status,
      409,
    );
    assert.deepEqual(await archive(), history);
    assert.deepEqual(await f.calls(), calls);
    assert.deepEqual(f.service.db.getSettings().automation, automationOff);
  } finally {
    await f.close();
  }
});

test("unsupported captures fail before checkout, auth, tools or fixture dispatch; saved queued intent is not converted", async () => {
  const f = await fixture();
  try {
    await f.send("/settings/harness", f.selection, "PATCH");
    await f.send("/sync", {});
    const current = f.service.executor!.capture(f.app.reviewer);
    const oldRoles = structuredClone(current);
    delete oldRoles.skillExecution!.policy;
    if (oldRoles.skillExecution!.version === 3)
      delete oldRoles.skillExecution!.roles.additional[0].policy;
    const captures = [
      f.app.reviewer,
      oldRoles,
      {
        ...current,
        skillExecution: {
          version: 2 as const,
          mode: "separated" as const,
          harness: "claude" as const,
          skill: current.skillExecution!.skill,
        },
      },
      {
        ...f.app.reviewer,
        hostExecution: {
          version: 1 as const,
          harness: "pi" as const,
          confirmedAt: "old",
        },
      },
      {
        ...f.app.reviewer,
        execution: {
          version: 1 as const,
          harness: "claude" as const,
          digest: "old",
          sourceId: "startup",
          image: "old",
          policy: "old",
          broker: "old",
          models: { claude: "old", codex: "old" },
          skillDigest: "old",
          fixture: true,
        },
      },
    ];
    for (const capture of captures) {
      await f.send(`${f.pr}/review`, {});
      const run = (await f.detail()).runs[0];
      f.service.db.sqlite
        .prepare("UPDATE runs SET reviewer_json = ? WHERE id = ?")
        .run(JSON.stringify(capture), run.id);
      await f.service.processJob(f.service.db.listJobs("queued")[0]);
      const failed = (await f.detail()).runs.find(
        (item) => item.id === run.id,
      )!;
      assert.equal(failed.status, "failed");
      assert.match(failed.error!, /no longer supported.*Explicitly save/);
      assert.deepEqual(failed.reviewer, JSON.parse(JSON.stringify(capture)));
      assert.equal((await f.detail()).draft, null);
      await assert.rejects(
        new HostExecutor(f.env).execute({
          kind: "review",
          runId: "archive",
          settings: capture,
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
    }
    await assert.rejects(f.calls(), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("null, versionless and single-primary saved intent stay byte-identical and unavailable across restart", async () => {
  const f = await fixture();
  try {
    for (const selection of [
      null,
      { version: 99, harness: "claude" as const, workflow: "dangerous" },
      { version: 2, harness: "claude" as const, workflow: "unknown" },
      { harness: "claude" as const, workflow: "legacy", sourceId: null },
      { harness: "claude" as const, workflow: "separated", sourceId: null },
      {
        version: 2,
        harness: "codex" as const,
        workflow: "separated",
        reviewer: f.selection.reviewer,
      },
      f.selection,
    ]) {
      const saved = { selection, sources: [] };
      f.service.db.updateHarness(saved);
      f.service.executor!.update(saved);
      const raw = () =>
        f.service.db.sqlite.prepare("SELECT harness_json FROM settings").get()!
          .harness_json;
      const original = raw();
      assert.equal(f.service.getHarness().requiresSave, true);
      assert.equal(f.service.getHarness().effective, null);
      assert.throws(
        () => f.service.executor!.capture(f.app.reviewer),
        /Save|save/,
      );
      await f.restart();
      assert.equal(raw(), original);
      assert.equal(f.service.getHarness().requiresSave, true);
      assert.equal(f.service.getHarness().effective, null);
      assert.deepEqual(f.service.db.getSettings().harness, saved);
    }
    await assert.rejects(f.calls(), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

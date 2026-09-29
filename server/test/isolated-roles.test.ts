import { fixture } from "./fixtures/isolated-context.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { automationOff, type HarnessId } from "../../shared/contracts.js";
import { loadSkill, skillCompatibility } from "../execution/skill.js";
import { isolatedReview } from "../execution/isolated.js";
import { RunProgressTracker } from "../progress.js";
import { reviewSchema } from "../review-output.js";

const questionRequest = {
  mode: "explain",
  range: {
    path: "src/demo.ts",
    from: { side: "RIGHT", line: 2 },
    to: { side: "RIGHT", line: 2 },
    baseSha: "demo-base-sha-1",
    headSha: "demo-head-sha-1",
  },
};

test("HTTP saves, captures and dispatches one Pi Main plus two Codex models into one draft", async () => {
  const f = await fixture();
  try {
    const response = await f.send("/settings/harness", f.selection, "PATCH");
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.deepEqual(saved.selection.additional, f.selection.additional);
    assert.ok(saved.effective);
    assert.equal((await f.send("/sync", {})).status, 200);
    assert.equal((await f.send(`${f.pr}/review`, {})).status, 202);
    const queued = (await f.detail()).runs[0];
    assert.equal(queued.reviewer.skillExecution?.version, 3);
    assert.deepEqual(
      queued.progress?.entries?.map((entry) => [entry.id, entry.status]),
      [
        ["codex-one", "pending"],
        ["codex-two", "pending"],
        ["main", "pending"],
      ],
    );
    await f.dispatch();
    const detail = await f.detail();
    const run = detail.runs[0];
    assert.equal(run.status, "completed", run.error ?? "");
    assert.equal(detail.drafts.length, 1);
    assert.equal(detail.draft!.runId, run.id);
    assert.deepEqual(
      run.result!.findings.map((finding) => finding.id),
      ["model-one", "model-two", "main-fixture"],
    );
    assert.deepEqual(
      run.progress!.entries!.map((entry) => [
        entry.id,
        entry.harness,
        entry.model,
        entry.status,
      ]),
      [
        ["codex-one", "codex", "model-one", "completed"],
        ["codex-two", "codex", "model-two", "completed"],
        ["main", "pi", "main-fixture", "completed"],
      ],
    );
    const calls = await f.calls();
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((call) => call.model),
      ["model-one", "model-two", "main-fixture"],
    );
    assert.equal(new Set(calls.map((call) => call.cwd)).size, 1);
    for (const call of calls) {
      assert.notEqual(call.home, f.home);
      assert.match(call.prompt, /Deterministic roles fixture/);
      assert.match(call.prompt, /demo-base-sha-1/);
      assert.match(call.prompt, /demo-head-sha-1/);
      assert.match(call.prompt, /APP-OWNED ISOLATED ROLES/);
      assert.doesNotMatch(call.args.join(" "), /dangerously-/);
    }
    assert.match(calls[2].prompt, /Evidence model-one/);
    assert.match(calls[2].prompt, /Evidence model-two/);
    assert.doesNotMatch(calls[0].prompt, /ADDITIONAL EVIDENCE DATA/);
    assert.doesNotMatch(
      JSON.stringify(run.progress!.activity),
      /Evidence|FROZEN RUBRIC|Private|APP-OWNED/,
    );
    assert.deepEqual(f.service.db.getSettings().automation, automationOff);
    const evidence = run.progress!.entries;
    await f.restart();
    assert.deepEqual((await f.detail()).runs[0].progress!.entries, evidence);
  } finally {
    await f.close();
  }
});

for (const harness of ["claude", "codex", "pi"] as HarnessId[])
  test(`Isolated ${harness} Main alone runs one full review; no hidden skill-named Codex`, async () => {
    const f = await fixture();
    try {
      assert.equal(
        (
          await f.send(
            "/settings/harness",
            { ...f.selection, harness, additional: [] },
            "PATCH",
          )
        ).status,
        200,
      );
      await f.send("/sync", {});
      await f.send(`${f.pr}/review`, {});
      await f.service.processJob(f.service.db.listJobs("queued")[0]);
      const detail = await f.detail();
      assert.equal(
        detail.runs[0].status,
        "completed",
        detail.runs[0].error ?? "",
      );
      assert.equal(detail.drafts.length, 1);
      assert.equal((await f.calls()).length, 1);
      assert.equal((await f.calls())[0].harness, harness);
      assert.match(
        (await f.calls())[0].prompt,
        /Perform a full review even if there is no Additional evidence/,
      );
      assert.equal(detail.runs[0].progress!.entries!.length, 1);
    } finally {
      await f.close();
    }
  });

test("explicit saves freeze each role's native model, instructions, effort and skill resources across settings changes and restart", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.home, ".codex"), { recursive: true });
    await mkdir(path.join(f.home, ".claude"));
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'model="codex-default"\nmodel_reasoning_effort="high"\ndeveloper_instructions="CODEX FROZEN INSTRUCTIONS"',
    );
    await writeFile(
      path.join(f.home, ".claude/settings.json"),
      '{"model":"claude-default","effortLevel":"low"}',
    );
    await writeFile(
      path.join(f.home, ".claude/CLAUDE.md"),
      "CLAUDE FROZEN INSTRUCTIONS",
    );
    await writeFile(
      path.join(f.home, ".pi/agent/settings.json"),
      '{"defaultProvider":"openai-codex","defaultModel":"pi-default","defaultThinkingLevel":"medium"}',
    );
    await writeFile(
      path.join(f.home, ".pi/agent/AGENTS.md"),
      "PI FROZEN INSTRUCTIONS",
    );
    const selection = {
      ...f.selection,
      harness: "codex",
      reviewer: { skillPath: f.skillPath, model: null },
      additional: [
        { id: "claude", harness: "claude", model: null },
        { id: "pi-a", harness: "pi", model: null },
        { id: "pi-b", harness: "pi", model: "pi-two" },
      ],
    };
    assert.equal(
      (await f.send("/settings/harness", selection, "PATCH")).status,
      200,
    );
    const status = await (await f.send("/settings/harness")).json();
    assert.equal(status.reviewer.model, "codex-default");
    assert.equal(status.selection.additional[0].model, "claude-default");
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    const captured = (await f.detail()).runs[0].reviewer;
    await writeFile(f.skillPath, "CHANGED SOURCE SKILL");
    await writeFile(
      path.join(path.dirname(f.skillPath), "rubric.md"),
      "CHANGED RESOURCE",
    );
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'model="changed-model"',
    );
    assert.deepEqual(await (await f.send("/settings/harness")).json(), status);
    assert.equal(
      (
        await f.send(
          "/settings/harness",
          { ...f.selection, additional: [] },
          "PATCH",
        )
      ).status,
      200,
    );
    await f.restart();
    assert.deepEqual((await f.detail()).runs[0].reviewer, captured);
    await f.service.processJob(f.service.db.listJobs("queued")[0]);
    const run = (await f.detail()).runs[0];
    assert.equal(run.status, "completed", run.error ?? "");
    const calls = await f.calls();
    assert.deepEqual(
      calls.map((call) => call.model),
      ["claude-default", "openai-codex/pi-default", "pi-two", "codex-default"],
    );
    assert.match(calls[0].prompt, /CLAUDE FROZEN INSTRUCTIONS/);
    assert.doesNotMatch(calls[0].prompt, /CODEX FROZEN INSTRUCTIONS/);
    assert.match(calls[3].prompt, /CODEX FROZEN INSTRUCTIONS/);
    assert.match(calls[3].args.join(" "), /model_reasoning_effort="high"/);
    assert.match(calls[0].args.join(" "), /--effort low/);
    assert.match(calls[1].args.join(" "), /--thinking medium/);
    assert.match(calls[1].prompt, /PI FROZEN INSTRUCTIONS/);
    assert.notEqual(calls[1].piHome, calls[2].piHome);
    assert.ok(calls.every((call) => !call.prompt.includes("CHANGED SOURCE")));
  } finally {
    await f.close();
  }
});

for (const harness of ["claude", "codex", "pi"] as HarnessId[])
  for (const model of [
    "fail",
    "invalid",
    "truncated",
    "oversized",
    ...(harness !== "claude" ? ["incomplete-next-turn"] : []),
  ])
    test(`${harness} Additional ${model} remains visible and disclosed; Main still synthesizes`, async () => {
      const f = await fixture();
      try {
        await f.send(
          "/settings/harness",
          {
            ...f.selection,
            harness: "claude",
            additional: [
              { id: "attempt", harness, model },
              { id: "healthy", harness: "codex", model: "healthy-model" },
            ],
          },
          "PATCH",
        );
        await f.send("/sync", {});
        await f.send(`${f.pr}/review`, {});
        await f.service.processJob(f.service.db.listJobs("queued")[0]);
        const detail = await f.detail();
        const run = detail.runs[0];
        assert.equal(run.status, "completed", run.error ?? "");
        assert.equal(detail.drafts.length, 1);
        const entry = run.progress!.entries![0];
        assert.equal(entry.status, "failed");
        assert.equal(entry.result, null);
        assert.ok(entry.error);
        assert.match(run.result!.rationale, /Additional reviewers failed/);
        assert.ok(run.result!.rationale.includes(`${harness}/${model}`));
        const calls = await f.calls();
        assert.equal(calls.length, 3);
        assert.match(calls[2].prompt, /"status":"failed"/);
        assert.match(calls[2].prompt, /"result":null/);
        assert.match(calls[2].prompt, /Evidence healthy-model/);
        assert.equal(run.progress!.entries![1].status, "completed");
        assert.doesNotMatch(
          JSON.stringify(run.progress!.activity),
          /Host harness did not|result.verdict|process failed/,
        );
      } finally {
        await f.close();
      }
    });

for (const harness of ["claude", "codex", "pi"] as HarnessId[])
  for (const model of ["fail", "invalid", "truncated"])
    test(`${harness} Main ${model} creates no successful result or draft`, async () => {
      const f = await fixture();
      try {
        await f.send(
          "/settings/harness",
          {
            ...f.selection,
            harness,
            reviewer: { skillPath: f.skillPath, model },
            additional: [
              {
                id: "successful-extra",
                harness: "claude",
                model: "extra-model",
              },
            ],
          },
          "PATCH",
        );
        await f.send("/sync", {});
        await f.send(`${f.pr}/review`, {});
        await f.service.processJob(f.service.db.listJobs("queued")[0]);
        const detail = await f.detail();
        assert.equal(detail.runs[0].status, "failed");
        assert.equal(detail.runs[0].result, null);
        assert.equal(detail.drafts.length, 0);
        assert.deepEqual(
          detail.runs[0].progress!.entries!.map((entry) => entry.status),
          ["completed", "failed"],
        );
        assert.ok(detail.runs[0].progress!.entries![0].result);
        assert.equal((await f.calls()).length, 2);
      } finally {
        await f.close();
      }
    });

test("revisions capture current roles and propose without overwriting; questions/follow-ups/retries run captured Main only", async () => {
  const f = await fixture();
  try {
    await f.send("/settings/harness", f.selection, "PATCH");
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    await f.service.processJob(f.service.db.listJobs("queued")[0]);
    const draft = (await f.detail()).draft!;
    await f.send(
      `${f.pr}/draft`,
      {
        draftId: draft.id,
        version: draft.version,
        body: "MANUAL TEXT",
        findings: draft.findings,
        verdict: draft.verdict,
      },
      "PUT",
    );
    const revisionSelection = {
      ...f.selection,
      harness: "codex",
      reviewer: { skillPath: f.skillPath, model: "revision-main" },
      additional: [
        { id: "revision-extra", harness: "pi", model: "revision-extra-model" },
      ],
    };
    await f.send("/settings/harness", revisionSelection, "PATCH");
    assert.equal(
      (
        await f.send(`${f.pr}/revise`, {
          draftId: draft.id,
          draftVersion: 2,
          instructions: "Preserve MANUAL TEXT",
        })
      ).status,
      202,
    );
    await f.send(
      "/settings/harness",
      { ...f.selection, additional: [] },
      "PATCH",
    );
    await f.service.processJob(f.service.db.listJobs("queued")[0]);
    let detail = await f.detail();
    assert.equal(
      detail.runs[0].status,
      "completed",
      detail.runs[0].error ?? "",
    );
    assert.equal(detail.proposals.length, 1);
    assert.equal(detail.drafts.length, 1);
    assert.equal(detail.draft!.body, "MANUAL TEXT");
    assert.equal(detail.runs[0].reviewer.model, "revision-main");
    await f.send("/settings/harness", revisionSelection, "PATCH");
    assert.equal(
      (await f.send(`${f.pr}/questions`, questionRequest)).status,
      202,
    );
    const parent = (await f.detail()).questions[0];
    await f.send("/settings/harness", f.selection, "PATCH");
    await f.service.processQuestion(parent);
    await f.send(`${f.pr}/questions`, {
      ...questionRequest,
      parentId: parent.id,
      question: "Follow up",
    });
    const child = (await f.detail()).questions.find(
      (question) => question.parentId === parent.id,
    )!;
    assert.deepEqual(child.reviewerSnapshot, parent.reviewerSnapshot);
    await f.send(`${f.pr}/questions/${child.id}/cancel`, {});
    await f.restart();
    assert.equal(
      (await f.send(`${f.pr}/questions/${child.id}/retry`, {})).status,
      202,
    );
    const retried = (await f.detail()).questions.find(
      (question) => question.id === child.id,
    )!;
    assert.deepEqual(retried.reviewerSnapshot, parent.reviewerSnapshot);
    await f.service.processQuestion(retried);
    detail = await f.detail();
    assert.ok(
      detail.questions.every((question) => question.status === "completed"),
    );
    assert.equal(detail.draft!.body, "MANUAL TEXT");
    const calls = await f.calls();
    assert.deepEqual(
      calls.map((call) => call.model),
      [
        "model-one",
        "model-two",
        "main-fixture",
        "revision-extra-model",
        "revision-main",
        "revision-main",
        "revision-main",
      ],
    );
    for (const call of calls.slice(-2)) {
      assert.equal(call.harness, "codex");
      assert.match(call.prompt, /not a full PR review/);
      assert.doesNotMatch(
        call.prompt,
        /Deterministic roles fixture|ADDITIONAL EVIDENCE DATA|You are Main/,
      );
    }
    assert.match(calls[3].prompt, /MANUAL TEXT/);
    assert.match(calls[4].prompt, /MANUAL TEXT/);
  } finally {
    await f.close();
  }
});

test("shutdown cancellation stops an owned Additional process and prevents later Additional/Main, preserving evidence after restart", async () => {
  const f = await fixture();
  try {
    await f.send(
      "/settings/harness",
      {
        ...f.selection,
        additional: [
          { id: "hanging", harness: "codex", model: "hang" },
          ...f.selection.additional!,
        ],
      },
      "PATCH",
    );
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    const pending = f.service.processJob(f.service.db.listJobs("queued")[0]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await f.calls().catch(() => [])).length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await f.calls()).length, 1);
    const running = (await f.detail()).runs[0];
    assert.equal(running.progress!.entries![0].status, "running");
    await f.restart();
    await pending;
    const run = (await f.detail()).runs[0];
    assert.equal(run.status, "interrupted");
    assert.deepEqual(
      run.progress!.entries!.map((entry) => entry.status),
      ["interrupted", "skipped", "skipped", "skipped"],
    );
    assert.deepEqual(run.reviewer, running.reviewer);
    assert.equal((await f.calls()).length, 1);
    assert.equal((await f.detail()).drafts.length, 0);
  } finally {
    await f.close();
  }
});

test("invalid role selections never change settings; nested mentions alone are overridden, required non-orchestration tools are not", async () => {
  const f = await fixture();
  try {
    await f.send("/settings/harness", f.selection, "PATCH");
    const before = f.service.db.getSettings();
    const bad = [
      { ...f.selection, version: 2 },
      { ...f.selection, workflow: "docker" },
      { ...f.selection, workflow: "dangerous" },
      { ...f.selection, additional: undefined },
      { ...f.selection, reviewer: undefined },
      { ...f.selection, additional: null },
      ...["main", "bad id"].map((id) => ({
        ...f.selection,
        additional: [{ id, harness: "pi", model: null }],
      })),
      {
        ...f.selection,
        additional: [f.selection.additional![0], f.selection.additional![0]],
      },
      {
        ...f.selection,
        additional: Array.from({ length: 9 }, (_, i) => ({
          id: `id${i}`,
          harness: "codex",
          model: null,
        })),
      },
      ...["--inject", "", {}, 42].map((model) => ({
        ...f.selection,
        additional: [{ id: "a", harness: "codex", model }],
      })),
      {
        ...f.selection,
        additional: [{ id: "a", harness: "unknown", model: null }],
      },
    ];
    for (const selection of bad)
      assert.equal(
        (await f.send("/settings/harness", selection, "PATCH")).status,
        400,
        JSON.stringify(selection),
      );
    assert.deepEqual(f.service.db.getSettings(), before);
    assert.deepEqual(
      skillCompatibility(await loadSkill(f.skillPath), "separated", "pi"),
      [],
    );
    for (const dependency of [
      "Run node scripts/check.js",
      "This requires shell access",
      "This requires MCP access",
      "This requires Bash to run codex exec, and requires shell access for another operation",
      "allowed-tools: mcp__arbitrary",
    ]) {
      await writeFile(
        f.skillPath,
        dependency + "\nAsk codex exec for secondary review.",
      );
      assert.ok(
        skillCompatibility(await loadSkill(f.skillPath), "separated", "pi")
          .length,
        dependency,
      );
    }
    await mkdir(path.join(f.home, ".codex"), { recursive: true });
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'model="fixture"\nmodel_provider="unsupported-custom"',
    );
    assert.equal(
      (await f.send("/settings/harness", f.selection, "PATCH")).status,
      409,
    );
    assert.deepEqual(f.service.db.getSettings(), before);
  } finally {
    await f.close();
  }
});

test("entry timeout is disclosed while an aborted sequence never starts Main", async () => {
  const f = await fixture();
  try {
    await f.send("/settings/harness", f.selection, "PATCH");
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    const settings = (await f.detail()).runs[0].reviewer;
    const controller = new AbortController();
    const tracker = new RunProgressTracker(() => {});
    let calls = 0;
    await assert.rejects(
      isolatedReview(
        {
          runId: "timeout-fixture",
          kind: "review",
          settings,
          signal: controller.signal,
          progress: tracker,
          prepare: async () => f.root,
          metadata: {},
          diff: "",
          prompt: "Fixture",
          schema: reviewSchema,
        },
        {
          execute: async () => {
            calls++;
            if (calls === 1)
              throw new Error("Synthetic timeout after bounded execution");
            controller.abort(new Error("Synthetic cancellation"));
            throw controller.signal.reason;
          },
        },
      ),
      /Synthetic cancellation/,
    );
    assert.equal(calls, 2);
    assert.deepEqual(
      tracker.progress.entries!.map((entry) => entry.status),
      ["failed", "interrupted"],
    );
    assert.match(tracker.progress.entries![0].error!, /timeout/);
    tracker.close();
  } finally {
    await f.close();
  }
});

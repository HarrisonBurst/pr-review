import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";
import { DemoReviewerAdapter } from "../adapters.js";
import { ReviewService } from "../service.js";
import { HostExecutor } from "../execution/host.js";
import { loadSkill, skillCompatibility } from "../execution/skill.js";
import {
  nativeModel,
  nativeConfiguration,
} from "../execution/native-settings.js";
import { loadWorkflow } from "../execution/config.js";
import { managedConfiguration } from "../execution/managed.js";
import { createHttpServer } from "../http.js";
import { validateReviewResult, reviewSchema } from "../review-output.js";
import { checkReviewOutput, checkerTool } from "../output-checker.js";
import { WorkflowBroker } from "../execution/broker.js";
import { fixtureCredentials } from "../execution/auth.js";
import { supportedImage } from "../execution/policy.js";
import { automationOff, type HarnessId } from "../../shared/contracts.js";

const value = {
  overview: "# Custom audit\n\nAny Markdown presentation.",
  body: "Review body",
  verdict: "COMMENT",
  rationale: "Private reasoning",
  findings: [
    {
      id: "F1",
      severity: "non_blocking",
      path: "src/a.ts",
      line: 3,
      body: "Author comment",
      evidence: "Private evidence",
      origin: "introduced",
      included: true,
    },
  ],
};

test("checker uses final ingestion for legacy defaults, optional anchors, custom Markdown and field errors", () => {
  const candidates: unknown[] = [
    value,
    {
      ...value,
      findings: [
        { ...value.findings[0], side: "LEFT", startLine: 2, questionId: null },
      ],
    },
    { ...value, findings: [{ ...value.findings[0], path: null, line: null }] },
    { ...value, extraLegacyField: true },
    { ...value, verdict: "ACCEPT" },
    { ...value, findings: [...value.findings, ...value.findings] },
    ...["severity", "origin", "side"].map((key) => ({
      ...value,
      findings: [{ ...value.findings[0], [key]: "invalid" }],
    })),
    ...[0, -1, 1.5].map((line) => ({
      ...value,
      findings: [{ ...value.findings[0], line }],
    })),
    { ...value, findings: [{ ...value.findings[0], startLine: 4 }] },
    {
      ...value,
      findings: [{ ...value.findings[0], line: null, startLine: 1 }],
    },
    { ...value, findings: [{ ...value.findings[0], questionId: 42 }] },
    null,
    [],
    { result: value },
  ];
  for (const candidate of candidates) {
    let error: string | null = null;
    try {
      validateReviewResult(candidate);
    } catch (caught) {
      error = (caught as Error).message;
    }
    const checked = checkReviewOutput(JSON.stringify(candidate));
    assert.equal(checked.status, error ? "invalid" : "valid");
    assert.deepEqual(checked.diagnostics, error ? [error] : []);
  }
  assert.equal(validateReviewResult(value).findings[0].side, "RIGHT");
  assert.equal(validateReviewResult(value).findings[0].startLine, null);
  assert.equal(validateReviewResult(value).findings[0].questionId, null);
  assert.match(checkReviewOutput("{broken").diagnostics[0], /complete JSON/);
  assert.equal(checkReviewOutput("```json\n{}\n```").status, "invalid");
  assert.ok(reviewSchema.properties.findings.items.properties.startLine);
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "skill-first-fixture-"));
  const home = path.join(root, "home");
  const skillPath = path.join(home, "skills/security-audit/ENTRY.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(
    skillPath,
    "---\nname: independent-audit\ndescription: Deterministic review fixture\n---\nFollow [rubric](rubric.md). No extra reviewer is requested.\n",
  );
  await writeFile(
    path.join(path.dirname(skillPath), "rubric.md"),
    "FROZEN COMPANION",
  );
  const env = {
    HOME: home,
    PATH: `${path.join(root, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const app = loadConfig({
    demo: true,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data/app.sqlite"),
    workflowConfigPath: "",
    reviewer: { skillPath, model: null, additionalInstructions: "" },
  });
  return {
    root,
    home,
    skillPath,
    env,
    app,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("skill identity, resources and native incompatibilities are bounded and actionable", async () => {
  const f = await fixture();
  try {
    const skill = await loadSkill(f.skillPath);
    assert.equal(skill.directory, "security-audit");
    assert.match(skill.files[0].content, /independent-audit/);
    assert.deepEqual(skillCompatibility(skill, "separated", "pi"), []);
    await writeFile(f.skillPath, "Requires Bash for source mutation");
    assert.match(
      skillCompatibility(
        await loadSkill(f.skillPath),
        "separated",
        "claude",
      )[0],
      /Docker.*Dangerous/,
    );
    await writeFile(f.skillPath, "See [missing](missing.md)");
    await assert.rejects(loadSkill(f.skillPath), /missing or outside/);
    await writeFile(f.skillPath, "Fixture");
    await symlink("rubric.md", path.join(path.dirname(f.skillPath), "link.md"));
    await assert.rejects(loadSkill(f.skillPath), /symlinks/);
    await mkdir(path.join(f.home, ".pi/agent"), { recursive: true });
    await writeFile(
      path.join(f.home, ".pi/agent/settings.json"),
      '{"packages":["unapproved"]}',
    );
    assert.equal(
      await nativeModel("pi", "separated", "fixture", f.env),
      "fixture",
    );
    assert.equal(
      await nativeModel("pi", "dangerous", "fixture", f.env),
      "fixture",
    );
  } finally {
    await f.close();
  }
});

test("new selections, immutable queues, revisions and question threads persist without changing drafts or automation", async () => {
  const f = await fixture();
  let service = await ReviewService.create(
    f.app,
    undefined,
    undefined,
    undefined,
    f.env,
  );
  service.queue.schedule = () => {};
  service.questionLane.schedule = () => {};
  service.reviewer.run = new DemoReviewerAdapter().run;
  const prId = "demo/repository#42";
  const select = (harness: HarnessId, model: string) =>
    service.selectSkillHarness({
      version: 3,
      harness,
      workflow: "separated",
      additional: [],
      reviewer: { model, skillPath: f.skillPath },
    });
  try {
    assert.equal(service.getHarness().selection?.workflow, "dangerous");
    await select("codex", "fixture-one");
    await service.sync();
    await service.manualReview(prId);
    const queued = service.getDetail(prId).runs[0];
    const cached = service.getHarness();
    await writeFile(
      f.skillPath,
      "Changed skill bytes for explicitly saved future runs",
    );
    assert.deepEqual(service.getHarness(), cached);
    await select("pi", "fixture-two");
    assert.notEqual(
      service.db.getSettings().harness?.skill?.digest,
      queued.reviewer.skillExecution?.skill.digest,
    );
    assert.equal(queued.reviewer.model, "fixture-one");
    assert.equal(queued.reviewer.skillExecution?.harness, "codex");
    await service.processJob(service.db.listJobs("queued")[0]);
    const draft = service.getDetail(prId).draft!;
    service.updateDraft(prId, {
      draftId: draft.id,
      version: draft.version,
      body: "MANUAL TEXT",
      findings: draft.findings,
      verdict: draft.verdict,
    });
    service.revise(prId, {
      draftId: draft.id,
      draftVersion: draft.version + 1,
      instructions: "Preserve text",
    });
    assert.equal(service.getDetail(prId).runs[0].reviewer.model, "fixture-two");
    const request = {
      mode: "explain" as const,
      range: {
        path: "src/demo.ts",
        from: { side: "RIGHT" as const, line: 2 },
        to: { side: "RIGHT" as const, line: 2 },
        baseSha: "demo-base-sha-1",
        headSha: "demo-head-sha-1",
      },
    };
    const parent = service.ask(prId, request).questions[0];
    await select("claude", "fixture-three");
    const child = service
      .ask(prId, { ...request, parentId: parent.id, question: "Follow up" })
      .questions.find((q) => q.parentId === parent.id)!;
    assert.deepEqual(child.reviewerSnapshot, parent.reviewerSnapshot);
    service.cancelQuestion(prId, child.id);
    service.retryQuestion(prId, child.id);
    assert.deepEqual(
      service.getDetail(prId).questions.find((q) => q.id === child.id)!
        .reviewerSnapshot,
      parent.reviewerSnapshot,
    );
    const saved = service.db.getSettings().harness;
    await service.close();
    service = await ReviewService.create(
      f.app,
      undefined,
      undefined,
      undefined,
      f.env,
    );
    service.queue.schedule = () => {};
    service.questionLane.schedule = () => {};
    assert.deepEqual(service.db.getSettings().harness, saved);
    assert.equal(service.getDetail(prId).draft!.body, "MANUAL TEXT");
    assert.deepEqual(
      service.getDetail(prId).questions.find((q) => q.id === child.id)!
        .reviewerSnapshot,
      parent.reviewerSnapshot,
    );
    assert.deepEqual(service.db.getSettings().automation, automationOff);
  } finally {
    await service.close();
    await f.close();
  }
});

test("v2 Docker broker exposes exactly the same checker without inference or provider access", async () => {
  for (const version of [2] as const) {
    const broker = new WorkflowBroker(
      "run",
      "cap",
      {
        version,
        harness: "pi",
        nested: [],
        image: supportedImage,
        auth: "fixture",
        bundle: "/unused",
        models: { claude: "fixture", codex: "fixture" },
        effort: "low",
      },
      fixtureCredentials(),
      {},
      "",
    );
    const call = (method: string, params: unknown) =>
      broker.request({
        id: 1,
        run: "run",
        capability: "cap",
        route: "mcp",
        body: { jsonrpc: "2.0", id: 1, method, params },
      });
    try {
      const list = await call("tools/list", {});
      assert.equal(
        (list.body as any).result.tools.some(
          (tool: any) => tool.name === checkerTool.name,
        ),
        version === 2,
      );
      const checked = await call("tools/call", {
        name: checkerTool.name,
        arguments: { candidate: JSON.stringify(value) },
      });
      if (version === 2)
        assert.deepEqual(
          JSON.parse((checked.body as any).result.content[0].text),
          checkReviewOutput(JSON.stringify(value)),
        );
      else assert.equal(checked.status, 403);
      assert.equal(broker.evidence.piResponses, 0);
      assert.equal(broker.evidence.providerReads, 0);
    } finally {
      broker.close();
    }
  }
});

test("v2 Docker preserves selected names and resource bytes, diagnoses nested model pins and never invents a nested reviewer", async () => {
  const f = await fixture();
  try {
    const bundle = path.join(f.root, "bundle");
    await mkdir(bundle);
    await writeFile(path.join(bundle, "fixture.mjs"), "INERT FIXTURE");
    const managed = await managedConfiguration(f.app, "codex", bundle, f.env);
    assert.deepEqual(managed.nested, []);
    assert.ok(
      managed.files!.some((file) => file.target === "resources/security-audit"),
    );
    const file = path.join(f.root, "workflow.json");
    await writeFile(file, JSON.stringify({ ...managed, fixtureNative: false }));
    const original = await loadWorkflow(file, f.skillPath, true);
    assert.equal(original.snapshot.version, 2);
    assert.ok(
      original.files.some(
        (file) => file.target === "resources/security-audit/ENTRY.md",
      ),
    );
    assert.ok(
      original.files.some(
        (file) =>
          file.target === "resources/security-audit/rubric.md" &&
          file.content === "FROZEN COMPANION",
      ),
    );
    await writeFile(f.skillPath, "Run codex exec --model conflicting-model");
    assert.equal(
      (await loadWorkflow(file, f.skillPath, true)).skill,
      original.skill,
    );
    await writeFile(
      file,
      JSON.stringify({
        ...(await managedConfiguration(f.app, "codex", bundle, f.env)),
        fixtureNative: false,
      }),
    );
    await assert.rejects(
      loadWorkflow(file, f.skillPath, true),
      /Docker model conflict.*conflicting-model/,
    );
    await mkdir(path.join(f.home, ".codex"));
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'model="native-model"\nmodel_reasoning_effort="high"\ndeveloper_instructions="Native rubric"',
    );
    await writeFile(
      path.join(f.home, ".codex/AGENTS.md"),
      "Frozen global instructions",
    );
    const { policy, ...native } = await nativeConfiguration(
      "codex",
      "separated",
      null,
      f.env,
    );
    assert.equal(policy?.profile, "restricted-native-1");
    assert.deepEqual(native, {
      model: "native-model",
      effort: "high",
      additionalInstructions: "Frozen global instructions\n\nNative rubric",
    });
  } finally {
    await f.close();
  }
});

test("HTTP current path/model selection validates explicitly and repeated GETs never reread or execute configuration", async () => {
  const f = await fixture();
  const service = await ReviewService.create(
    f.app,
    undefined,
    undefined,
    undefined,
    f.env,
  );
  const server = createHttpServer(service, f.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const select = async (body: unknown) =>
    fetch(base + "/settings/harness", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const selection = {
      version: 3,
      additional: [],
      harness: "codex",
      workflow: "separated",
      reviewer: { skillPath: f.skillPath, model: "fixture-model" },
    };
    assert.equal((await select(selection)).status, 200);
    const settings = service.db.getSettings();
    await rm(f.skillPath);
    for (const route of [
      "/state",
      "/settings/harness",
      "/settings/execution",
      "/settings/integrations",
    ])
      assert.equal((await fetch(base + route)).status, 200);
    assert.deepEqual(service.db.getSettings(), settings);
    assert.equal((await select(selection)).status, 409);
    assert.equal((await select({ ...selection, version: 2 })).status, 400);
    assert.equal(
      (
        await select({
          ...selection,
          reviewer: { ...selection.reviewer, model: "--inject" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await select({ ...selection, workflow: "dangerous" })).status,
      400,
    );
    assert.deepEqual(service.db.getSettings(), settings);
    assert.deepEqual(settings.automation, automationOff);
    assert.equal(service.db.listJobs().length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await f.close();
  }
});

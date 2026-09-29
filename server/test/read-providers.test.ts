import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { providerFixture } from "./fixtures/read-provider-context.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { importReadProviders, ReadProviders } from "../read-providers.js";
import {
  buildIntegrationCatalog,
  integrationSnapshot,
} from "../integrations.js";
import { WorkflowBroker } from "../execution/broker.js";
import { fixtureCredentials } from "../execution/auth.js";
import { supportedImage } from "../execution/policy.js";
import type { WorkflowConfig } from "../execution/config.js";
import { ReviewService } from "../service.js";
import { createHttpServer } from "../http.js";
import { DockerExecutor } from "../execution/executor.js";
import { reviewSchema } from "../reviewer.js";
import { workflowFixture } from "./fixtures/provider-workflow.js";

test("unreviewed Slack captures cannot grant tools before any credential or provider I/O", async () => {
  let calls = 0;
  const provider = new ReadProviders(async () => {
    calls++;
    throw new Error("Unexpected synthetic provider request");
  }, true);
  for (const tool of [
    "synthetic_identity",
    "synthetic_search",
    "synthetic_channel",
    "synthetic_thread",
    "synthetic_write",
  ])
    await assert.rejects(
      provider.session(
        {
          boundary: "read-only-gateway",
          connections: [
            {
              id: "synthetic-slack",
              effective: "restricted",
              allowedTools: [tool],
              inventory: {
                status: "loaded",
                checkedAt: new Date().toISOString(),
                scope: "synthetic_transport",
                connected: false,
                message: "Unvetted synthetic inventory",
                tools: [{ name: tool, schemaFingerprint: "synthetic-schema" }],
              },
              oauthBinding: {
                profileId: "slack-mcp/1",
                profileDigest: "synthetic-profile",
                generation: "synthetic-generation",
                issuer: "https://mcp.slack.com",
                resource: "https://mcp.slack.com",
                clientId: "synthetic-client",
                identity: {
                  account: "synthetic-user",
                  workspace: "synthetic-workspace",
                },
              },
            },
          ],
        },
        AbortSignal.timeout(1000),
      ),
      /unapproved tool/,
    );
  assert.equal(calls, 0);
});

const pageId = "11111111-1111-1111-1111-111111111111";
const secret = "synthetic-business-credential-never-project";

test("explicit read providers use narrow real HTTP transports and never mistake fixtures for live evidence", async () => {
  const fixture = await providerFixture();
  try {
    const authBefore = await readFile(fixture.authPath, "utf8");
    const sourceBefore = await readFile(fixture.manifestPath, "utf8");
    const configs = await importReadProviders(fixture.manifestPath);
    assert.ok(
      configs.every((config) => !config.enabled && !config.allowedTools.length),
    );
    assert.equal(fixture.requests.length, 0);
    const catalog = buildIntegrationCatalog(
      { configs, importedHarnessAt: null },
      true,
      true,
    );
    assert.equal(fixture.requests.length, 0);
    assert.ok(
      catalog.connections.every((connection) => connection.status !== "ready"),
    );
    for (const config of configs) {
      const result = await fixture.providers.test(config);
      assert.equal(result.scope, "synthetic_transport");
      assert.equal(result.connected, false);
      assert.equal(result.containmentVerified, false);
      assert.equal(result.status, "ready", result.message);
    }
    const enabled = configs.map((config) => ({
      ...config,
      enabled: true,
      allowedTools: [
        config.id === "github"
          ? "pull-request"
          : config.id === "linear"
            ? "issue"
            : config.id === "notion"
              ? "page"
              : "document",
      ],
    }));
    const snapshot = integrationSnapshot(
      buildIntegrationCatalog(
        { configs: enabled, importedHarnessAt: null },
        true,
        true,
      ),
    );
    const controller = new AbortController();
    const gateways = await fixture.providers.session(
      snapshot,
      controller.signal,
    );
    const names = [
      "github_pull_request_read",
      "linear_get_issue",
      "notion_read",
      "documents_get",
    ];
    const args = [
      { repository: "fixture/repository", number: 42, method: "get" },
      { id: "FIX-42" },
      { id: pageId, method: "blocks" },
      { id: "fixture-document" },
    ];
    for (const [index, { gateway, identity }] of gateways.entries()) {
      await gateway.listTools();
      await gateway.call({
        serverIdentity: identity,
        name: names[index],
        arguments: args[index],
      });
      const count: number = fixture.requests.length;
      for (const argumentsValue of [
        { ...args[index], url: "http://127.0.0.1/api/submit" },
        { ...args[index], method: "delete" },
        { ...args[index], id: "other-resource" },
      ])
        await assert.rejects(
          gateway.call({
            serverIdentity: identity,
            name: names[index],
            arguments: argumentsValue,
          }),
        );
      await assert.rejects(
        gateway.call({
          serverIdentity: "https://impostor.invalid",
          name: names[index],
          arguments: args[index],
        }),
      );
      await assert.rejects(
        gateway.call({
          serverIdentity: identity,
          name: "publish",
          arguments: args[index],
        }),
      );
      assert.equal(fixture.requests.length, count);
    }
    assert.ok(
      fixture.requests
        .filter(
          (request) =>
            request.path.includes("api.github.com") ||
            request.path.includes("api.notion.com"),
        )
        .every((request) => request.method === "GET"),
    );
    assert.equal(await readFile(fixture.authPath, "utf8"), authBefore);
    assert.equal(await readFile(fixture.manifestPath, "utf8"), sourceBefore);
    assert.doesNotMatch(
      JSON.stringify({ configs, snapshot, catalog }),
      new RegExp(secret),
    );
    fixture.mode("schema");
    assert.equal((await fixture.providers.test(configs[3])).status, "error");
    fixture.mode("identity");
    assert.equal((await fixture.providers.test(configs[3])).status, "error");
    fixture.mode("capabilities");
    assert.equal((await fixture.providers.test(configs[3])).status, "error");
    fixture.mode("mutation");
    assert.equal((await fixture.providers.test(configs[3])).status, "error");
    fixture.mode("leak");
    assert.equal((await fixture.providers.test(configs[1])).status, "error");
    fixture.mode("large");
    assert.equal((await fixture.providers.test(configs[1])).status, "error");
    fixture.mode("hang");
    await assert.rejects(
      gateways[1].gateway.call(
        {
          serverIdentity: gateways[1].identity,
          name: names[1],
          arguments: args[1],
        },
        AbortSignal.timeout(50),
      ),
    );
    controller.abort();
    await assert.rejects(
      gateways[1].gateway.call({
        serverIdentity: gateways[1].identity,
        name: names[1],
        arguments: args[1],
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("manifest, schema and broker capability confusion cannot expand an approved read session", async () => {
  const fixture = await providerFixture();
  try {
    const configs = await importReadProviders(fixture.manifestPath);
    const selected = configs.map((config) => ({
      ...config,
      enabled: true,
      allowedTools: [config.id === "linear" ? "issue" : "none"],
    }));
    const snapshot = integrationSnapshot(
      buildIntegrationCatalog(
        { configs: selected, importedHarnessAt: null },
        true,
        true,
      ),
    );
    const controller = new AbortController();
    const gateways = await fixture.providers.session(
      snapshot,
      controller.signal,
    );
    const workflow: WorkflowConfig = {
      version: 2,
      nested: [],
      harness: "claude",
      image: supportedImage,
      bundle: "/fixture",
      auth: "fixture",
      models: { claude: "fixture-claude", codex: "fixture-codex" },
      effort: "low",
    };
    const broker = new WorkflowBroker(
      "run-a",
      "cap-a",
      workflow,
      fixtureCredentials(),
      {},
      "",
      gateways,
    );
    const request = {
      id: 1,
      run: "run-a",
      capability: "cap-a",
      route: "mcp",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "linear_get_issue", arguments: { id: "FIX-42" } },
      },
    };
    assert.equal((await broker.request(request)).status, 200);
    const count = fixture.requests.length;
    for (const patch of [
      { capability: "cap-b" },
      { run: "run-b" },
      { route: "https://api.linear.app/graphql" },
      { body: { ...request.body, method: "resources/read" } },
      {
        body: {
          ...request.body,
          params: {
            ...request.body.params,
            arguments: { query: "mutation { deleteIssue }" },
          },
        },
      },
    ])
      assert.equal(
        (await broker.request({ ...request, ...patch })).status,
        403,
      );
    assert.equal(fixture.requests.length, count);
    broker.close();
    controller.abort();
    assert.equal((await broker.request(request)).status, 403);
    const mutations = [
      (value: any) => {
        value.readProviders[0].endpoint = "http://127.0.0.1/api/submit";
      },
      (value: any) => {
        value.readProviders[1].auth = { kind: "oauth", refreshToken: secret };
      },
      (value: any) => {
        value.readProviders[3].vettedDefinition = "trust-readOnlyHint";
      },
      (value: any) => {
        value.readProviders[3].endpoint =
          "https://documents.example.invalid/api/submit";
      },
      (value: any) => {
        value.readProviders[0].scope = ["../.."];
      },
      (value: any) => {
        value.readProviders[1].provider = "__proto__";
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(fixture.manifest);
      mutate(value);
      await writeFile(fixture.manifestPath, JSON.stringify(value));
      await assert.rejects(importReadProviders(fixture.manifestPath));
    }
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        ...fixture.manifest,
        readProviders: fixture.manifest.readProviders.slice(1),
      }),
    );
    await assert.rejects(
      fixture.providers.session(snapshot, new AbortController().signal),
      /changed/,
    );
    assert.equal(fixture.requests.length, count);
  } finally {
    await fixture.close();
  }
});

test("HTTP import, capability diagnostics and explicit synthetic connection tests preserve source stores and stay inert on GET", async (t) => {
  const fixture = await providerFixture();
  t.after(() => fixture.close());
  const app = await workflowFixture(fixture.root);
  const service = await ReviewService.create(
    { ...app, workflowConfigPath: null },
    undefined,
    undefined,
    undefined,
    undefined,
    fixture.providers,
  );
  const server = createHttpServer(service, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = (route: string, body: unknown = {}, method = "POST") =>
    fetch(`${base}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const auth = await readFile(fixture.authPath, "utf8");
    const manifest = await readFile(fixture.manifestPath, "utf8");
    assert.equal(
      (
        await send("/settings/integrations/import-read", {
          path: fixture.manifestPath,
        })
      ).status,
      200,
    );
    await saveFixtureExecution(service);
    for (const [id, tool] of [
      ["github", "pull-request"],
      ["linear", "issue"],
      ["notion", "page"],
      ["custom:documents", "document"],
    ]) {
      assert.equal(
        (
          await send(
            `/settings/integrations/${id}`,
            { enabled: true, allowedTools: [tool] },
            "PATCH",
          )
        ).status,
        200,
      );
    }
    await rm(fixture.authPath);
    for (const route of [
      "/state",
      "/settings/harness",
      "/settings/execution",
      "/settings/integrations",
    ]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200);
      assert.doesNotMatch(
        await response.text(),
        /synthetic-business-credential|synthetic-unrelated/,
      );
    }
    assert.equal(fixture.requests.length, 0);
    const unavailable = await (
      await send("/settings/integrations/linear/test")
    ).json();
    assert.equal(unavailable.connected, false);
    assert.equal(unavailable.status, "error");
    await writeFile(fixture.authPath, auth);
    for (const id of ["github", "linear", "notion", "custom:documents"]) {
      const evidence = await (
        await send(`/settings/integrations/${id}/test`)
      ).json();
      assert.equal(evidence.scope, "synthetic_transport");
      assert.equal(evidence.connected, false);
      assert.equal(evidence.status, "ready");
    }
    const count = fixture.requests.length;
    const catalog = await (await fetch(`${base}/settings/integrations`)).json();
    assert.equal(fixture.requests.length, count);
    assert.ok(
      catalog.connections.every(
        (connection: any) =>
          connection.status === "configured" &&
          connection.evidence.connected === false,
      ),
    );
    assert.equal(
      (
        await send(
          "/settings/integrations/github",
          { endpoint: "http://127.0.0.1/api/submit" },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await send(
          "/settings/harness",
          { harness: "pi", workflow: "legacy", sourceId: null },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await send(
          "/settings/harness",
          { harness: "pi", workflow: "configured", sourceId: null },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(await readFile(fixture.authPath, "utf8"), auth);
    assert.equal(await readFile(fixture.manifestPath, "utf8"), manifest);
    assert.doesNotMatch(
      JSON.stringify(service.db.getSettings()),
      /synthetic-business-credential|synthetic-unrelated/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  }
  const restarted = await ReviewService.create(
    { ...app, workflowConfigPath: null },
    undefined,
    undefined,
    undefined,
    undefined,
    fixture.providers,
  );
  try {
    assert.equal(restarted.getHarness().selection?.workflow, "separated");
    assert.ok(
      restarted.db
        .getSettings()
        .integrations.configs.every((config) => config.enabled),
    );
    assert.equal(restarted.db.getSettings().automation.pollCommits, false);
  } finally {
    await restarted.close();
  }
});

test(
  "actual Docker reaches all four approved synthetic read transports without exposing host business credentials",
  { skip: process.env.PR_REVIEW_DOCKER_TESTS !== "1", timeout: 60000 },
  async () => {
    const fixture = await providerFixture();
    const app = await workflowFixture(fixture.root);
    const source = path.join(fixture.root, "source");
    await mkdir(path.join(source, "checkout"), { recursive: true });
    await writeFile(path.join(source, "checkout/code.txt"), "pinned head\n");
    const configs = (await importReadProviders(fixture.manifestPath)).map(
      (config) => ({
        ...config,
        enabled: true,
        allowedTools: [
          config.id === "github"
            ? "pull-request"
            : config.id === "linear"
              ? "issue"
              : config.id === "notion"
                ? "page"
                : "document",
        ],
      }),
    );
    const snapshot = integrationSnapshot(
      buildIntegrationCatalog({ configs, importedHarnessAt: null }, true, true),
    );
    const executor = (await DockerExecutor.open(app))!;
    try {
      const result = await executor.execute({
        runId: "provider-fixture",
        settings: executor.capture(app.reviewer),
        prepare: async () => source,
        metadata: {
          number: 42,
          secretPath: fixture.authPath,
          configPath: fixture.manifestPath,
          databasePath: app.databasePath,
        },
        diff: "Synthetic fixture",
        schema: reviewSchema,
        prompt: "Explicit synthetic provider fixture",
        integrationSnapshot: snapshot,
        providers: fixture.providers,
      });
      assert.equal((result.value as any).verdict, "COMMENT");
      assert.equal(
        ((result.value as any).rationale.match(/provider-read:/g) ?? []).length,
        4,
      );
      assert.ok(
        fixture.requests.some((request) =>
          request.path.includes("api.linear.app"),
        ),
      );
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    } finally {
      await executor.close();
      await fixture.close();
    }
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { axiomFixture, axiomSample } from "./fixtures/axiom-context.js";
import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { integrationSnapshot } from "../integrations.js";
import { WorkflowBroker } from "../execution/broker.js";
import { fixtureCredentials } from "../execution/auth.js";
import { supportedImage } from "../execution/policy.js";
import { axiomReadArguments } from "../axiom-reads.js";
import { decodeOAuthScopes } from "../mcp-oauth-scopes.js";
import { workflowFixture } from "./fixtures/provider-workflow.js";
import { DockerExecutor } from "../execution/executor.js";
import { reviewSchema } from "../reviewer.js";

async function fixture(options: Parameters<typeof axiomFixture>[0] = {}) {
  const f = await axiomFixture(options);
  await saveFixtureExecution(f.service);
  const catalog = await (
    await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: f.source,
    })
  ).json();
  const id: string = catalog.connections[0].config.id;
  assert.equal(
    catalog.connections[0].config.native.authentication,
    "app-owned-oauth",
  );
  assert.equal(
    (
      await f.send("/api/settings/integrations/import-oauth", {
        id,
        profileId: "axiom-mcp/1",
      })
    ).status,
    200,
  );
  const prefix = `/api/settings/integrations/${id}`;
  const discovery = await (await f.send(prefix + "/oauth/discover", {})).json();
  assert.deepEqual(discovery.discovery.scopes, ["openid", "offline_access"]);
  assert.equal(discovery.discovery.issuer, "https://authorization.axiom.co");
  assert.equal(discovery.discovery.resource, "https://mcp.axiom.co/mcp");
  const registration = {
    clientAuthMethod: "none",
    scopes: discovery.discovery.scopes,
    discoveryDigest: discovery.discovery.digest,
  };
  assert.equal(
    (await f.send(prefix + "/oauth/register", registration)).status,
    409,
  );
  assert.equal(f.operations.includes("synthetic:register"), false);
  assert.equal(
    (
      await f.send(prefix + "/oauth/register", {
        ...registration,
        consent: "Register a new MCP OAuth client",
      })
    ).status,
    200,
  );
  const start = await f.send(prefix + "/oauth/connect", {});
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const url = new URL((await start.json()).authorizationUrl);
  assert.equal(url.origin, "https://authorization.axiom.co");
  assert.equal(url.searchParams.get("scope"), "openid offline_access");
  const callback = await f.send(
    `/api/mcp/oauth/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, code: "SYNTHETIC_CODE", iss: "https://authorization.axiom.co" })}`,
    undefined,
    { cookie },
  );
  return {
    ...f,
    get service() {
      return f.service;
    },
    id,
    prefix,
    callback,
    cookie,
    load: () => f.send(prefix + "/load-tools", {}),
    grant: async (
      allowedTools = ["listDatasets", "getDatasetFields", "queryDataset"],
    ) => {
      const response = await f.send(
        prefix,
        { enabled: true, allowedTools },
        { method: "PATCH" },
      );
      assert.equal(response.status, 200);
      return integrationSnapshot(await response.json());
    },
  };
}
async function broker(
  f: Awaited<ReturnType<typeof fixture>>,
  snapshot = integrationSnapshot(f.service.getIntegrations()),
) {
  return new WorkflowBroker(
    "axiom-fixture",
    "synthetic-capability",
    {
      version: 2,
      harness: "claude",
      nested: [],
      image: supportedImage,
      bundle: "/fixture",
      auth: "fixture",
      models: { claude: "fixture", codex: "fixture" },
      effort: "low",
    },
    fixtureCredentials(),
    {},
    "",
    await f.service.readProviders.session(snapshot, AbortSignal.timeout(15000)),
  );
}
function call(b: WorkflowBroker, name: string, args: Record<string, unknown>) {
  return b.request({
    id: 1,
    run: "axiom-fixture",
    capability: "synthetic-capability",
    route: "mcp",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
}

test("Axiom guided OAuth, default denial, explicit reads, truthful Test and restart use the host broker", async () => {
  const f = await fixture();
  try {
    assert.equal(f.callback.status, 200);
    assert.equal(
      f.service.getIntegrations().connections[0].oauth?.identity,
      null,
    );
    assert.equal(f.tokenAuthentication[0].hasClientSecret, false);
    assert.equal(f.tokenAuthentication[0].hasVerifier, true);
    assert.equal(f.tokenBindings[0].resource, "https://mcp.axiom.co/mcp");
    assert.deepEqual(
      await f.service.readProviders.session(
        integrationSnapshot(f.service.getIntegrations()),
        AbortSignal.timeout(1000),
      ),
      [],
    );
    await f.load();
    const connection = f.service.getIntegrations().connections[0];
    assert.deepEqual(
      connection.definition.tools.map((x) => x.id),
      ["listDatasets", "getDatasetFields", "queryDataset"],
    );
    assert.deepEqual(connection.config.allowedTools, []);
    assert.equal(connection.config.enabled, false);
    assert.equal(
      (await (await f.send(f.prefix + "/test", {})).json()).scope,
      "local_configuration",
    );
    assert.equal(f.toolCalls.length, 0);
    await f.grant(["queryDataset"]);
    await f.send(f.prefix + "/test", {});
    assert.equal(f.toolCalls.length, 0);
    const capture = await f.grant();
    const b = await broker(f, capture);
    for (const [name, args] of [
      ["listDatasets", {}],
      ["getDatasetFields", { datasetName: "synthetic-events" }],
      ["queryDataset", axiomSample],
    ] as const) {
      const result = await call(b, name, args);
      assert.equal(result.status, 200);
      assert.match(JSON.stringify(result), /SYNTHETIC Axiom events/);
      assert.match(JSON.stringify(result), /partial/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /ACCESS_CANARY|REFRESH_CANARY/,
      );
    }
    assert.deepEqual(f.toolCalls.at(-1), {
      name: "queryDataset",
      arguments: axiomReadArguments("queryDataset", axiomSample),
    });
    const evidence = await (await f.send(f.prefix + "/test", {})).json();
    assert.equal(evidence.scope, "synthetic_transport");
    assert.equal(evidence.connected, false);
    assert.deepEqual(f.toolCalls.at(-1), {
      name: "listDatasets",
      arguments: {},
    });
    b.close();
    const count = f.requests.length;
    await f.restart();
    assert.equal(f.requests.length, count);
    const restarted = await broker(f, capture);
    assert.equal(
      (await call(restarted, "queryDataset", axiomSample)).status,
      200,
    );
    restarted.close();
    await f.load();
    assert.equal(
      f.service.getIntegrations().connections[0].config.enabled,
      false,
    );
    assert.deepEqual(
      f.service.getIntegrations().connections[0].config.allowedTools,
      [],
    );
    assert.doesNotMatch(
      JSON.stringify(f.service.getIntegrations()),
      /ACCESS_CANARY|REFRESH_CANARY/,
    );
  } finally {
    await f.close();
  }
});

test("Axiom generated APL bounds datasets, time, rows, filters and denies arbitrary queries", () => {
  assert.deepEqual(
    axiomReadArguments("queryDataset", {
      ...axiomSample,
      filterField: "http.status",
      filterValue: 'error\" | union other //',
    }),
    {
      apl: "['synthetic-events'] | where ['http.status'] == \"error\\\" | union other //\" | take 1",
      datasets: ["synthetic-events"],
      startTime: axiomSample.startTime,
      endTime: axiomSample.endTime,
    },
  );
  const { limit, ...sample } = axiomSample;
  assert.equal(limit, 1);
  assert.match(
    String(axiomReadArguments("queryDataset", sample).apl),
    /take 20$/,
  );
});

test("Axiom write, unknown, forged and invalid calls are denied before credential or provider access", async () => {
  const f = await fixture();
  try {
    await f.load();
    const capture = await f.grant();
    const b = await broker(f, capture);
    let credentialReads = 0;
    const read = f.store.read.bind(f.store);
    f.store.read = async (ref) => {
      credentialReads++;
      return read(ref);
    };
    const count = f.requests.length;
    for (const name of [
      "createDataset",
      "createDashboard",
      "deleteDashboard",
      "updateMonitor",
      "sendFeedback",
      "unknownRead",
      "listOrganizations",
      "queryMetrics",
    ]) {
      assert.equal((await call(b, name, {})).status, 403);
      await assert.rejects(
        f.service.mcpOAuth.readTool(
          f.id,
          capture.connections[0].oauthBinding!,
          "a".repeat(64),
          name,
          {},
          AbortSignal.timeout(1000),
        ),
        /denied/,
      );
      const forged = structuredClone(capture);
      forged.connections[0].allowedTools = [name];
      await assert.rejects(
        f.service.readProviders.session(forged, AbortSignal.timeout(1000)),
        /unapproved/,
      );
    }
    const invalid: [string, Record<string, unknown>][] = [
      ["listDatasets", { orgId: "another" }],
      ["listDatasets", { url: "https://private.invalid" }],
      ["getDatasetFields", { datasetName: "../secret" }],
      ["getDatasetFields", { datasetName: "x".repeat(81) }],
      ...[
        { apl: "arbitrary" },
        { datasets: ["other"] },
        { orgId: "other" },
        { limit: 21 },
        { limit: 0 },
        { datasetName: "a'] | union secret" },
        { startTime: "now-1h" },
        { endTime: "2026-01-01T02:00:00Z" },
        { endTime: axiomSample.startTime },
        { startTime: "2026-02-30T00:00:00Z" },
        { filterField: "x" },
        { filterValue: "x" },
        { filterField: "x']", filterValue: "x" },
        { filterField: "x", filterValue: "x".repeat(501) },
      ].map(
        (extra) =>
          ["queryDataset", { ...axiomSample, ...extra }] as [
            string,
            Record<string, unknown>,
          ],
      ),
    ];
    for (const [name, args] of invalid) {
      assert.equal((await call(b, name, args)).status, 403);
      await assert.rejects(
        f.service.mcpOAuth.readTool(
          f.id,
          capture.connections[0].oauthBinding!,
          "a".repeat(64),
          name,
          args,
          AbortSignal.timeout(1000),
        ),
      );
    }
    assert.equal(credentialReads, 0);
    assert.equal(f.requests.length, count);
    assert.equal(f.toolCalls.length, 0);
    b.close();
  } finally {
    await f.close();
  }
});

for (const drift of [
  "source",
  "generation",
  "profile",
  "schema",
  "credential",
] as const)
  test(`Axiom ${drift} drift refuses captured reads`, async () => {
    const f = await fixture();
    try {
      await f.load();
      const b = await broker(f, await f.grant());
      const count = f.requests.length;
      if (drift === "source")
        await writeFile(
          f.source,
          JSON.stringify({
            mcpServers: {
              axiom: { type: "http", url: "https://changed.invalid/mcp" },
            },
          }),
        );
      if (drift === "generation") f.service.mcpOAuth.cancel(f.id);
      if (drift === "schema")
        f.tools[0].inputSchema.required = ["new_required"];
      if (drift === "credential") f.store.values.clear();
      if (drift === "profile") {
        const row = f.service.db.sqlite
          .prepare("SELECT state_json FROM mcp_oauth WHERE id=?")
          .get(f.id)!;
        const state = JSON.parse(String(row.state_json));
        state.profileDigest = "changed";
        f.service.db.sqlite
          .prepare("UPDATE mcp_oauth SET state_json=? WHERE id=?")
          .run(JSON.stringify(state), f.id);
      }
      assert.equal((await call(b, "listDatasets", {})).status, 403);
      assert.equal(f.toolCalls.length, 0);
      if (drift !== "schema") assert.equal(f.requests.length, count);
      b.close();
    } finally {
      await f.close();
    }
  });

for (const outcome of [
  "accept",
  "cancel",
  "restart",
  "missing",
  "invalid",
] as const)
  test(`Axiom credential admission ${outcome} preserves unchecked separate grants`, async () => {
    const f = await fixture({
      tokenOverrides:
        outcome === "invalid"
          ? { token_type: "invalid" }
          : {
              scope:
                outcome === "missing"
                  ? "profile"
                  : "openid offline_access profile",
            },
    });
    try {
      assert.equal(
        f.callback.status,
        ["missing", "invalid"].includes(outcome) ? 409 : 202,
      );
      assert.equal(
        f.service.getIntegrations().connections[0].oauth?.authenticated,
        false,
      );
      assert.equal(
        [...f.store.values.values()].some((bytes) =>
          Buffer.from(bytes).toString().includes("ACCESS_CANARY"),
        ),
        false,
      );
      assert.equal(f.toolCalls.length, 0);
      if (outcome === "invalid") return;
      const preview = await (
        await f.send(
          f.prefix + "/oauth/scope-preview",
          {},
          { cookie: f.cookie },
        )
      ).json();
      assert.deepEqual(preview.additionalScopes, ["profile"]);
      if (outcome === "cancel") await f.send(f.prefix + "/oauth/cancel", {});
      if (outcome === "restart") await f.restart();
      const response = await f.send(
        f.prefix + "/oauth/accept-scopes",
        {
          previewId: preview.id,
          generation: preview.generation,
          additionalScopes: preview.additionalScopes,
          consent: "Accept these additional OAuth capabilities",
        },
        { cookie: f.cookie },
      );
      assert.equal(response.status, outcome === "accept" ? 200 : 409);
      assert.equal(
        f.service.getIntegrations().connections[0].oauth?.authenticated,
        outcome === "accept",
      );
      assert.deepEqual(
        f.service.getIntegrations().connections[0].config.allowedTools,
        [],
      );
    } finally {
      await f.close();
    }
  });

for (const widening of [false, true])
  test(`Axiom ordinary renewal cannot widen accepted capabilities (${widening})`, async () => {
    const overrides: Record<string, unknown> = {};
    const f = await fixture({ tokenOverrides: overrides });
    try {
      await f.load();
      const b = await broker(f, await f.grant());
      for (const [key, bytes] of f.store.values) {
        const value = JSON.parse(Buffer.from(bytes).toString());
        if (value.tokens) {
          value.expiresAt = 0;
          f.store.values.set(key, Buffer.from(JSON.stringify(value)));
        }
      }
      if (widening) overrides.scope = "openid offline_access profile";
      assert.equal(
        (await call(b, "listDatasets", {})).status,
        widening ? 403 : 200,
      );
      assert.equal(f.toolCalls.length, widening ? 0 : 1);
      assert.equal(
        f.tokenAuthentication.filter((x) => x.grantType === "refresh_token")
          .length,
        1,
      );
      if (widening) {
        assert.equal((await call(b, "listDatasets", {})).status, 403);
        assert.equal(
          f.tokenAuthentication.filter((x) => x.grantType === "refresh_token")
            .length,
          1,
        );
      }
      b.close();
    } finally {
      await f.close();
    }
  });

for (const text of [
  "SYNTHETIC_ACCESS_CANARY",
  "SYNTHETIC_REFRESH_CANARY",
  "PRIVATE_EXTRA_CAPABILITY",
])
  test(`Axiom result echo is rejected: ${text}`, async () => {
    const f = await fixture({
      tokenOverrides: {
        scope: "openid offline_access PRIVATE_EXTRA_CAPABILITY",
      },
      mcpCallResult: { content: [{ type: "text", text }] },
    });
    try {
      const preview = await (
        await f.send(
          f.prefix + "/oauth/scope-preview",
          {},
          { cookie: f.cookie },
        )
      ).json();
      await f.send(
        f.prefix + "/oauth/accept-scopes",
        {
          previewId: preview.id,
          generation: preview.generation,
          additionalScopes: preview.additionalScopes,
          consent: "Accept these additional OAuth capabilities",
        },
        { cookie: f.cookie },
      );
      await f.load();
      const b = await broker(f, await f.grant());
      const result = await call(b, "listDatasets", {});
      assert.equal(result.status, 403);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(text));
      b.close();
    } finally {
      await f.close();
    }
  });

for (const [resourceOverrides, metadataOverrides, expected] of [
  [{ scopes_supported: [] }, {}, []],
  [{}, { scopes_supported: ["openid"] }, ["openid"]],
  [{}, { scopes_supported: undefined }, []],
] as const)
  test("Axiom missing resource scopes use only explicitly advertised issuer scopes", async () => {
    const f = await axiomFixture({ resourceOverrides, metadataOverrides });
    try {
      const catalog = await (
        await f.send("/api/settings/integrations/discover", {
          harness: "claude",
          path: f.source,
        })
      ).json();
      const id = catalog.connections[0].config.id;
      await f.send("/api/settings/integrations/import-oauth", {
        id,
        profileId: "axiom-mcp/1",
      });
      const discovery = await (
        await f.send(`/api/settings/integrations/${id}/oauth/discover`, {})
      ).json();
      assert.deepEqual(discovery.discovery.scopes, expected);
      assert.equal(f.operations.includes("synthetic:token"), false);
    } finally {
      await f.close();
    }
  });

test("Axiom uses RFC scope tokens, without Slack comma normalization", () => {
  assert.deepEqual(
    decodeOAuthScopes("axiom-mcp/1", "openid offline_access openid"),
    ["openid", "offline_access"],
  );
  assert.deepEqual(decodeOAuthScopes("axiom-mcp/1", "openid,offline_access"), [
    "openid,offline_access",
  ]);
  assert.throws(() =>
    decodeOAuthScopes("axiom-mcp/1", "openid\toffline_access"),
  );
});

test(
  "actual Docker uses host-owned Axiom reads without business credentials or write authority",
  { skip: process.env.PR_REVIEW_DOCKER_TESTS !== "1", timeout: 60000 },
  async () => {
    const f = await fixture();
    let executor: DockerExecutor | undefined;
    try {
      await f.load();
      const snapshot = await f.grant();
      const app = await workflowFixture(f.root);
      const source = path.join(f.root, "source");
      await mkdir(path.join(source, "checkout"), { recursive: true });
      await writeFile(path.join(source, "checkout/code.txt"), "pinned head\n");
      executor = (await DockerExecutor.open(app))!;
      const result = await executor.execute({
        runId: "axiom-provider-fixture",
        settings: executor.capture(app.reviewer),
        prepare: async () => source,
        metadata: {
          number: 42,
          secretPath: path.join(f.home, ".codex/auth.json"),
          configPath: f.source,
          databasePath: f.app.databasePath,
        },
        diff: "Synthetic fixture",
        schema: reviewSchema,
        prompt: "Explicit synthetic Axiom boundary fixture",
        integrationSnapshot: snapshot,
        providers: f.service.readProviders,
      });
      assert.equal((result.value as any).verdict, "COMMENT");
      assert.deepEqual(
        f.toolCalls.map((x) => x.name),
        ["listDatasets", "getDatasetFields", "queryDataset"],
      );
      assert.doesNotMatch(
        JSON.stringify(result),
        /ACCESS_CANARY|REFRESH_CANARY/,
      );
    } finally {
      await executor?.close();
      await f.close();
    }
  },
);

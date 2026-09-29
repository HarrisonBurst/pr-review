import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { workflowFixture } from "./fixtures/provider-workflow.js";
import { DockerExecutor } from "../execution/executor.js";
import { reviewSchema } from "../reviewer.js";
import { oauthFixture } from "./fixtures/oauth-context.js";
import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { linearReadTools } from "../linear-reads.js";
import { integrationSnapshot } from "../integrations.js";
import { WorkflowBroker } from "../execution/broker.js";
import { fixtureCredentials } from "../execution/auth.js";
import { supportedImage } from "../execution/policy.js";
import { decodeOAuthScopes } from "../mcp-oauth-scopes.js";

async function fixture(options: Parameters<typeof oauthFixture>[0] = {}) {
  const tools = structuredClone(linearReadTools);
  const f = await oauthFixture({
    profile: "linear",
    clientAuthMethods: ["none"],
    mcpTools: tools,
    mcpReadCalls: true,
    mcpCallResult: {
      content: [
        {
          type: "text",
          text: "SYNTHETIC Linear ticket intent: read/write behavior",
        },
      ],
      structuredContent: {
        url: "https://linear.app/synthetic/issue/FIX-42",
        hasMore: true,
      },
    },
    ...options,
  });
  await saveFixtureExecution(f.service);
  const catalog = await (
    await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: f.source,
    })
  ).json();
  const id: string = catalog.connections[0].config.id;
  assert.equal(
    (
      await f.send("/api/settings/integrations/import-oauth", {
        id,
        profileId: "linear-mcp/1",
      })
    ).status,
    200,
  );
  const prefix = `/api/settings/integrations/${id}`;
  const discovery = await (await f.send(prefix + "/oauth/discover", {})).json();
  assert.deepEqual(discovery.discovery.scopes, ["read"]);
  assert.equal(discovery.discovery.resource, "https://mcp.linear.app/mcp");
  assert.equal(
    (
      await f.send(prefix + "/oauth/register", {
        clientAuthMethod: "none",
        scopes: ["read"],
        discoveryDigest: discovery.discovery.digest,
      })
    ).status,
    409,
  );
  assert.equal(f.operations.includes("synthetic:register"), false);
  assert.equal(
    (
      await f.send(prefix + "/oauth/register", {
        consent: "Register a new MCP OAuth client",
        clientAuthMethod: "none",
        scopes: ["read"],
        discoveryDigest: discovery.discovery.digest,
      })
    ).status,
    200,
  );
  const start = await f.send(prefix + "/oauth/connect", {});
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const url = new URL((await start.json()).authorizationUrl);
  assert.equal(url.searchParams.get("scope"), "read");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const callback = await f.send(
    `/api/mcp/oauth/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, code: "SYNTHETIC_CODE", iss: "https://mcp.linear.app" })}`,
    undefined,
    { cookie },
  );
  const load = () => f.send(prefix + "/load-tools", {});
  const grant = async (allowedTools = tools.map((tool) => tool.name)) => {
    const response = await f.send(
      prefix,
      { enabled: true, allowedTools },
      { method: "PATCH" },
    );
    assert.equal(response.status, 200);
    return integrationSnapshot(await response.json());
  };
  return {
    ...f,
    get service() {
      return f.service;
    },
    id,
    prefix,
    tools,
    callback,
    cookie,
    load,
    grant,
  };
}
async function broker(
  f: Awaited<ReturnType<typeof fixture>>,
  snapshot = integrationSnapshot(f.service.getIntegrations()),
) {
  return new WorkflowBroker(
    "synthetic-run",
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
    run: "synthetic-run",
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

test("Linear registered read-only OAuth, explicit grants, capture, bounded Test and restart share the host broker", async () => {
  const f = await fixture();
  try {
    assert.equal(f.callback.status, 200);
    assert.equal(
      f.service.getIntegrations().connections[0].oauth?.identity,
      null,
    );
    assert.equal(
      (
        await f.service.readProviders.session(
          integrationSnapshot(f.service.getIntegrations()),
          AbortSignal.timeout(1000),
        )
      ).length,
      0,
    );
    await f.load();
    assert.equal(
      (await (await f.send(f.prefix + "/test", {})).json()).connected,
      false,
    );
    assert.equal(f.toolCalls.length, 0);
    const capture = await f.grant();
    const b = await broker(f, capture);
    for (const [name, args] of [
      ["get_issue", { id: "FIX-42" }],
      ["list_issues", { query: "synthetic", limit: 1 }],
    ] as const) {
      const result = await call(b, name, args);
      assert.equal(result.status, 200);
      assert.match(JSON.stringify(result.body), /ticket intent/);
      assert.match(JSON.stringify(result.body), /hasMore/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /ACCESS_CANARY|REFRESH_CANARY/,
      );
    }
    assert.equal(
      (await (await f.send(f.prefix + "/test", {})).json()).scope,
      "synthetic_transport",
    );
    assert.deepEqual(f.toolCalls.at(-1), {
      name: "list_issues",
      arguments: { limit: 1, query: '"pr-review connection test"' },
    });
    assert.equal(f.tokenBindings[0].resource, "https://mcp.linear.app/mcp");
    assert.equal(f.tokenAuthentication[0].hasClientSecret, false);
    assert.equal(f.tokenAuthentication[0].hasVerifier, true);
    b.close();
    const count = f.requests.length;
    await f.restart();
    assert.equal(f.requests.length, count);
    const restarted = await broker(f);
    assert.equal(
      (await call(restarted, "get_issue", { id: "FIX-42" })).status,
      200,
    );
    restarted.close();
    await f.load();
    assert.deepEqual(
      f.service.getIntegrations().connections[0].config.allowedTools,
      [],
    );
    assert.equal(
      f.service.getIntegrations().connections[0].config.enabled,
      false,
    );
  } finally {
    await f.close();
  }
});

test("Linear direct and forged write/unknown/invalid calls touch no credential or provider", async () => {
  const f = await fixture();
  try {
    await f.load();
    const snapshot = await f.grant();
    const b = await broker(f, snapshot);
    const count = f.requests.length;
    let reads = 0;
    const read = f.store.read.bind(f.store);
    f.store.read = async (ref) => {
      reads++;
      return read(ref);
    };
    for (const name of [
      "save_issue",
      "create_issue",
      "update_issue",
      "delete_issue",
      "save_comment",
      "extract_images",
      "get_unknown",
      "get_document",
      "slack_search_public",
    ]) {
      assert.equal((await call(b, name, {})).status, 403);
      const forged = structuredClone(snapshot);
      forged.connections[0].allowedTools = [name];
      await assert.rejects(
        f.service.readProviders.session(forged, AbortSignal.timeout(1000)),
        /unapproved/,
      );
      await assert.rejects(
        f.service.mcpOAuth.readTool(
          f.id,
          snapshot.connections[0].oauthBinding!,
          "a".repeat(64),
          name,
          {},
          AbortSignal.timeout(1000),
        ),
        /denied/,
      );
    }
    for (const [name, args] of [
      ["get_issue", {}],
      ["get_issue", { id: "FIX-42", description: "MUTATION_CANARY" }],
      ["get_issue", { id: "https://private.invalid" }],
      ["get_issue", { id: "x".repeat(101) }],
      ["list_issues", {}],
      ["list_issues", { query: "x", limit: 21 }],
      ["list_issues", { query: "x", cursor: "x".repeat(1025) }],
      ["list_issues", { query: "x".repeat(1001) }],
      ["list_issues", { query: "x", response_format: "concise" }],
    ] as const) {
      assert.equal((await call(b, name, args)).status, 403);
      await assert.rejects(
        f.service.mcpOAuth.readTool(
          f.id,
          snapshot.connections[0].oauthBinding!,
          "a".repeat(64),
          name,
          args,
          AbortSignal.timeout(1000),
        ),
      );
    }
    assert.equal(reads, 0);
    assert.equal(f.requests.length, count);
    assert.equal(f.toolCalls.length, 0);
    b.close();
  } finally {
    await f.close();
  }
});

for (const drift of ["source", "generation", "profile", "schema"] as const)
  test(`Linear ${drift} drift fails before dispatch`, async () => {
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
              "linear-server": {
                type: "http",
                url: "https://changed.invalid/mcp",
              },
            },
          }),
        );
      if (drift === "generation") f.service.mcpOAuth.cancel(f.id);
      if (drift === "schema")
        f.tools[0].inputSchema.required = ["new_required"];
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
      assert.equal((await call(b, "get_issue", { id: "FIX-42" })).status, 403);
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
  "comma",
] as const)
  test(`Linear complete local capability disclosure ${outcome}`, async () => {
    const f = await fixture({
      tokenOverrides: {
        scope:
          outcome === "missing"
            ? "write"
            : outcome === "comma"
              ? "read,write"
              : "read write",
      },
    });
    try {
      assert.equal(
        f.callback.status,
        ["missing", "comma"].includes(outcome) ? 409 : 202,
      );
      const preview = await (
        await f.send(
          f.prefix + "/oauth/scope-preview",
          {},
          { cookie: f.cookie },
        )
      ).json();
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
      assert.doesNotMatch(
        JSON.stringify(f.service.getIntegrations()),
        /grantedScopes|additionalScopes/,
      );
      const approval = {
        previewId: preview.id,
        generation: preview.generation,
        additionalScopes: preview.additionalScopes,
        consent: "Accept these additional OAuth capabilities",
      };
      if (outcome === "accept") {
        assert.deepEqual(preview.additionalScopes, ["write"]);
        assert.equal(
          (
            await f.send(f.prefix + "/oauth/accept-scopes", approval, {
              cookie: f.cookie,
            })
          ).status,
          200,
        );
        assert.equal(
          f.service.getIntegrations().connections[0].oauth?.authenticated,
          true,
        );
        assert.deepEqual(
          f.service.getIntegrations().connections[0].config.allowedTools,
          [],
        );
      } else {
        if (outcome === "cancel") await f.send(f.prefix + "/oauth/cancel", {});
        if (outcome === "restart") await f.restart();
        assert.equal(
          (
            await f.send(f.prefix + "/oauth/accept-scopes", approval, {
              cookie: f.cookie,
            })
          ).status,
          409,
        );
      }
    } finally {
      await f.close();
    }
  });

test("Linear scope decoder uses space-delimited RFC tokens, not Slack comma normalization", () => {
  assert.deepEqual(decodeOAuthScopes("linear-mcp/1", "read write read"), [
    "read",
    "write",
  ]);
  assert.deepEqual(decodeOAuthScopes("linear-mcp/1", "read,write"), [
    "read,write",
  ]);
  for (const value of [
    "read\twrite",
    "x".repeat(129),
    Array(129).fill("read").join(" "),
    "read\u0000write",
  ])
    assert.throws(() => decodeOAuthScopes("linear-mcp/1", value));
});

test(
  "actual Docker reads Linear through the unchanged container-to-host broker",
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
        runId: "linear-provider-fixture",
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
        prompt: "Explicit synthetic Linear boundary fixture",
        integrationSnapshot: snapshot,
        providers: f.service.readProviders,
      });
      assert.equal((result.value as any).verdict, "COMMENT");
      assert.match((result.value as any).rationale, /provider-read:get_issue/);
      assert.match(
        (result.value as any).rationale,
        /provider-read:list_issues/,
      );
      assert.deepEqual(
        f.toolCalls.map((x) => x.name),
        ["get_issue", "list_issues"],
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

for (const widening of [false, true])
  test(`Linear normal refresh preserves no-widening (${widening}) and ambiguous refusal`, async () => {
    const overrides: Record<string, unknown> = {};
    const f = await fixture({ tokenOverrides: overrides });
    try {
      await f.load();
      const b = await broker(f, await f.grant());
      for (const [key, bytes] of f.store.values) {
        const value = JSON.parse(Buffer.from(bytes).toString());
        if (value.tokens) {
          value.expiresAt = Date.now() - 1000;
          f.store.values.set(key, Buffer.from(JSON.stringify(value)));
        }
      }
      if (widening) overrides.scope = "read write";
      assert.equal(
        (await call(b, "get_issue", { id: "FIX-42" })).status,
        widening ? 403 : 200,
      );
      assert.equal(f.toolCalls.length, widening ? 0 : 1);
      assert.equal(
        f.tokenAuthentication.filter((x) => x.grantType === "refresh_token")
          .length,
        1,
      );
      if (widening) {
        assert.equal(
          (await call(b, "get_issue", { id: "FIX-42" })).status,
          403,
        );
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

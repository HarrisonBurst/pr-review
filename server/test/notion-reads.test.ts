import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { notionFixture } from "./fixtures/notion-context.js";
import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { integrationSnapshot } from "../integrations.js";
import { WorkflowBroker } from "../execution/broker.js";
import { fixtureCredentials } from "../execution/auth.js";
import { supportedImage } from "../execution/policy.js";

async function fixture(
  options: Parameters<typeof notionFixture>[0] = {},
  appOwned = false,
) {
  const f = await notionFixture(options);
  const tools = f.tools;
  await saveFixtureExecution(f.service);
  const catalog = await (
    appOwned
      ? await f.send("/api/settings/integrations/add-oauth", {
          profileId: "notion-mcp/1",
        })
      : await f.send("/api/settings/integrations/discover", {
          harness: "claude",
          path: f.source,
        })
  ).json();
  const id: string = catalog.connections[0].config.id;
  if (!appOwned)
    assert.equal(
      (
        await f.send("/api/settings/integrations/import-oauth", {
          id,
          profileId: "notion-mcp/1",
        })
      ).status,
      200,
    );
  const prefix = `/api/settings/integrations/${encodeURIComponent(id)}`;
  const discovery = await (await f.send(prefix + "/oauth/discover", {})).json();
  assert.deepEqual(discovery.discovery.scopes, ["default"]);
  assert.equal(discovery.discovery.resource, "https://mcp.notion.com");
  assert.equal(
    (
      await f.send(prefix + "/oauth/register", {
        clientAuthMethod: "none",
        scopes: ["default"],
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
        scopes: ["default"],
        discoveryDigest: discovery.discovery.digest,
      })
    ).status,
    200,
  );
  const start = await f.send(prefix + "/oauth/connect", {});
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const url = new URL((await start.json()).authorizationUrl);
  assert.equal(url.searchParams.get("scope"), "default");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const callback = await f.send(
    `/api/mcp/oauth/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, code: "SYNTHETIC_CODE", iss: "https://mcp.notion.com" })}`,
    undefined,
    { cookie },
  );
  const load = () => f.send(prefix + "/load-tools", {});
  const grant = async (allowedTools = ["notion-fetch"]) => {
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

for (const appOwned of [false, true])
  test(`Notion ${appOwned ? "app-owned" : "native"} registered broad OAuth, explicit read grants, capture, local Test and restart share the host broker`, async () => {
    const f = await fixture({}, appOwned);
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
        (await (await f.send(f.prefix + "/test", {})).json()).status,
        "needs_compatibility",
      );
      assert.equal(f.toolCalls.length, 0);
      assert.deepEqual(
        f.service
          .getIntegrations()
          .connections[0].definition.tools.map((tool) => tool.id),
        ["notion-fetch"],
      );
      const granted = await f.grant();
      if (appOwned) {
        await writeFile(f.source, "not a native configuration");
        const before = f.service.getIntegrations();
        const operations = [...f.operations];
        assert.equal(
          (
            await f.send("/api/settings/integrations/add-oauth", {
              profileId: "notion-mcp/1",
            })
          ).status,
          200,
        );
        assert.deepEqual(f.service.getIntegrations(), before);
        assert.deepEqual(f.operations, operations);
        const forged = structuredClone(granted);
        forged.connections[0].id = "arbitrary-without-source";
        await assert.rejects(() => broker(f, forged));
      }
      const b = await broker(f, granted);
      const result = await call(b, "notion-fetch", { id: "synthetic-page-id" });
      assert.equal(result.status, 200);
      assert.match(JSON.stringify(result.body), /Notion document/);
      assert.match(JSON.stringify(result.body), /truncated/);
      assert.doesNotMatch(
        JSON.stringify(result),
        /ACCESS_CANARY|REFRESH_CANARY/,
      );
      assert.deepEqual(f.toolCalls.at(-1), {
        name: "notion-fetch",
        arguments: { id: "synthetic-page-id" },
      });
      const requests = f.requests.length;
      const calls = f.toolCalls.length;
      const localTest = await (await f.send(f.prefix + "/test", {})).json();
      assert.equal(localTest.scope, "local_configuration");
      assert.equal(localTest.connected, false);
      assert.equal(localTest.status, "ready");
      assert.equal(f.requests.length, requests);
      assert.equal(f.toolCalls.length, calls);
      assert.equal(f.tokenBindings[0].resource, "https://mcp.notion.com");
      assert.equal(f.tokenAuthentication[0].hasClientSecret, false);
      assert.equal(f.tokenAuthentication[0].hasVerifier, true);
      b.close();
      const count = f.requests.length;
      await f.restart();
      assert.equal(f.requests.length, count);
      const restarted = await broker(f);
      assert.equal(
        (await call(restarted, "notion-fetch", { id: "synthetic-page-id" }))
          .status,
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

test("Adding Notion without native config is local-only, default denied, idempotent and durable", async () => {
  const f = await notionFixture();
  try {
    await writeFile(f.source, "unreadable as config");
    const route = "/api/settings/integrations/add-oauth";
    const body = { profileId: "notion-mcp/1" };
    assert.equal(
      (await f.send(route, body, { origin: "http://localhost:1" })).status,
      403,
    );
    for (const invalid of [
      {},
      { profileId: "unknown" },
      { ...body, endpoint: "https://untrusted.invalid/mcp" },
      { ...body, enabled: true },
    ])
      assert.notEqual((await f.send(route, invalid)).status, 200);
    assert.equal(f.service.getIntegrations().connections.length, 0);
    const added = await f.send(route, body);
    assert.equal(added.status, 200);
    const connection = (await added.json()).connections[0];
    assert.equal(connection.config.id, "oauth:notion-mcp/1");
    assert.equal(connection.config.native, undefined);
    assert.equal(connection.config.enabled, false);
    assert.deepEqual(connection.config.allowedTools, []);
    assert.equal(connection.config.inventory, undefined);
    assert.equal(connection.oauth.state, "needs_discovery");
    assert.equal(connection.oauth.authenticated, false);
    assert.equal(connection.effective, "disabled");
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.values.size, 0);
    assert.equal((await f.send(route, body)).status, 200);
    await f.restart();
    assert.deepEqual(
      f.service.getIntegrations().connections[0].config,
      connection.config,
    );
    assert.equal(f.service.getState().settings.integrations.configs.length, 1);
    assert.equal(f.requests.length, 0);
    const bad = {
      ...connection.config,
      endpoint: "https://untrusted.invalid/mcp",
    };
    const inventory = await f.service.readProviders.loadTools(bad);
    assert.equal(inventory.status, "error");
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

for (const appOwned of [false, true])
  test(`Notion ${appOwned ? "app-owned" : "native"} direct and forged write/unknown/invalid calls touch no credential or provider`, async () => {
    const f = await fixture({}, appOwned);
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
        "notion-update-page",
        "notion-create-pages",
        "notion-create-comment",
        "notion-spawn-session",
        "notion-search",
        "notion-ai-search",
        "notion-get-tool-access",
        "unknownRead",
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
        ["notion-fetch", {}],
        [
          "notion-fetch",
          { id: "synthetic-page-id", content: "MUTATION_CANARY" },
        ],
        ["notion-fetch", { id: "" }],
        ["notion-fetch", { id: "x".repeat(2049) }],
        ["notion-fetch", { id: "with whitespace" }],
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

for (const drift of [
  "source",
  "generation",
  "profile",
  "schema",
  "credential",
] as const)
  test(`Notion ${drift} drift fails before dispatch`, async () => {
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
              notion: {
                type: "http",
                url: "https://changed.invalid/mcp",
              },
            },
          }),
        );
      if (drift === "generation") f.service.mcpOAuth.cancel(f.id);
      if (drift === "credential") f.store.values.clear();
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
      assert.equal(
        (await call(b, "notion-fetch", { id: "synthetic-page-id" })).status,
        403,
      );
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
  test(`Notion complete local capability disclosure ${outcome}`, async () => {
    const f = await fixture({
      tokenOverrides: {
        scope:
          outcome === "missing"
            ? "write"
            : outcome === "comma"
              ? "default,write"
              : "default write",
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

for (const widening of [false, true])
  test(`Notion ordinary renewal cannot widen accepted capabilities (${widening})`, async () => {
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
      if (widening) overrides.scope = "default profile";
      assert.equal(
        (await call(b, "notion-fetch", { id: "synthetic-page-id" })).status,
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
          (await call(b, "notion-fetch", { id: "synthetic-page-id" })).status,
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

for (const text of [
  "SYNTHETIC_ACCESS_CANARY",
  "SYNTHETIC_REFRESH_CANARY",
  "PRIVATE_EXTRA_CAPABILITY",
])
  test(`Notion result echo is rejected: ${text}`, async () => {
    const f = await fixture({
      tokenOverrides: {
        scope: "default PRIVATE_EXTRA_CAPABILITY",
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
      const result = await call(b, "notion-fetch", { id: "synthetic-page-id" });
      assert.equal(result.status, 403);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(text));
      b.close();
    } finally {
      await f.close();
    }
  });

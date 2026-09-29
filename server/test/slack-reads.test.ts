import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { oauthFixture } from "./fixtures/oauth-context.js";
import { saveFixtureExecution } from "./fixtures/current-settings.js";
import { slackReadTools } from "../slack-reads.js";
import { integrationSnapshot } from "../integrations.js";
import { WorkflowBroker, type BrokerRequest } from "../execution/broker.js";
import { JsonLineDecoder } from "../stream.js";
import { fixtureCredentials } from "../execution/auth.js";
import { supportedImage } from "../execution/policy.js";
import type { IntegrationSessionSnapshot } from "../../shared/contracts.js";

async function fixture(overrides: Parameters<typeof oauthFixture>[0] = {}) {
  const tools = structuredClone(slackReadTools);
  const f = await oauthFixture({
    mcpTools: tools,
    mcpReadCalls: true,
    mcpCallResult: {
      content: [
        {
          type: "text",
          text: "SYNTHETIC untrusted read with provider citation and incomplete coverage",
        },
      ],
      structuredContent: { citation: "synthetic://message", hasMore: true },
    },
    ...overrides,
  });
  await saveFixtureExecution(f.service);
  const discovered = await (
    await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: f.source,
    })
  ).json();
  const id: string = discovered.connections[0].config.id;
  await f.send("/api/settings/integrations/import-oauth", {
    id,
    profileId: "slack-mcp/1",
  });
  const prefix = `/api/settings/integrations/${id}`;
  const discovery = await (await f.send(prefix + "/oauth/discover", {})).json();
  assert.equal(
    (
      await f.send(prefix + "/oauth/configure", {
        clientId: "synthetic-read-client",
        clientAuthMethod: "client_secret_post",
        clientSecret: "SYNTHETIC_CLIENT_SECRET_CANARY",
        scopes: ["search:read.public"],
        discoveryDigest: discovery.discovery.digest,
      })
    ).status,
    200,
  );
  const start = await f.send(prefix + "/oauth/connect", {});
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const params = new URLSearchParams({
    state: new URL((await start.json()).authorizationUrl).searchParams.get(
      "state",
    )!,
    code: "SYNTHETIC_CODE",
    iss: "https://mcp.slack.com",
  });
  assert.equal(
    (await f.send(`/api/mcp/oauth/callback?${params}`, undefined, { cookie }))
      .status,
    200,
  );
  const load = () => f.send(prefix + "/load-tools", {});
  const grant = async (names = tools.map((tool) => tool.name)) => {
    const response = await f.send(
      prefix,
      { enabled: true, allowedTools: names },
      { method: "PATCH" },
    );
    assert.equal(response.status, 200);
    return integrationSnapshot(await response.json());
  };
  await load();
  return {
    ...f,
    get service() {
      return f.service;
    },
    id,
    prefix,
    tools,
    load,
    grant,
  };
}

async function broker(
  f: Awaited<ReturnType<typeof fixture>>,
  snapshot?: IntegrationSessionSnapshot,
) {
  snapshot ??= await f.grant();
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

test("unchanged rediscovery preserves authenticated grants, evidence and captured authority; drift refuses atomically", async () => {
  const f = await fixture();
  try {
    const capture = await f.grant(["slack_search_public"]);
    await f.service.testIntegration(f.id);
    const before = f.service.getIntegrations().connections;
    const credentials = [...f.store.values].map(([key, value]) => [
      key,
      Buffer.from(value),
    ]);
    const operations = [...f.operations];
    const discover = () =>
      f.send("/api/settings/integrations/discover", {
        harness: "claude",
        path: f.source,
      });
    assert.equal((await discover()).status, 200);
    assert.deepEqual(f.service.getIntegrations().connections, before);
    assert.deepEqual([...f.store.values], credentials);
    assert.deepEqual(f.operations, operations);
    const capturedBroker = await broker(f, capture);
    assert.equal(
      (
        await call(capturedBroker, "slack_search_public", {
          query: "synthetic",
          limit: 1,
        })
      ).status,
      200,
    );
    await writeFile(
      f.source,
      JSON.stringify({
        mcpServers: {
          ...f.native.mcpServers,
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          axiom: { type: "http", url: "https://mcp.axiom.co/mcp" },
        },
      }),
    );
    assert.equal((await discover()).status, 200);
    assert.deepEqual(
      f.service.getIntegrations().connections.find((c) => c.config.id === f.id),
      before[0],
    );
    assert.equal(f.service.getIntegrations().connections.length, 3);
    for (const c of f.service
      .getIntegrations()
      .connections.filter((c) => c.config.id !== f.id)) {
      assert.equal(c.config.enabled, false);
      assert.deepEqual(c.config.allowedTools, []);
    }
    const saved = f.service.db.getSettings().integrations;
    await writeFile(
      f.source,
      JSON.stringify({
        mcpServers: {
          slack: {
            ...f.native.mcpServers.slack,
            url: "https://changed.example.com/mcp",
          },
          extra: { type: "http", url: "https://mcp.linear.app/mcp" },
        },
      }),
    );
    const refused = await discover();
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "oauth_disconnect_required");
    assert.deepEqual(f.service.db.getSettings().integrations, saved);
    assert.deepEqual([...f.store.values], credentials);
    await writeFile(f.source, JSON.stringify({ mcpServers: {} }));
    assert.equal((await discover()).status, 200);
    assert.deepEqual(
      f.service.db.getSettings().integrations.configs,
      saved.configs,
    );
    await f.restart();
    assert.deepEqual(
      f.service.db.getSettings().integrations.configs,
      saved.configs,
    );
    assert.deepEqual([...f.store.values], credentials);
  } finally {
    await f.close();
  }
});

test("admitted Slack grants flow through HTTP, immutable capture and real broker without identity or output schema", async () => {
  const f = await fixture();
  try {
    const initial = f.service.getIntegrations().connections[0];
    assert.equal(initial.oauth?.identity, null);
    assert.equal(initial.config.enabled, false);
    assert.deepEqual(initial.config.allowedTools, []);
    assert.equal(initial.tools.length, 4);
    assert.equal(
      (
        await f.service.readProviders.session(
          integrationSnapshot(f.service.getIntegrations()),
          AbortSignal.timeout(1000),
        )
      ).length,
      0,
    );
    const b = await broker(f);
    for (const [name, args] of [
      ["slack_search_public", { query: "synthetic", limit: 1 }],
      ["slack_search_public_and_private", { query: "synthetic", limit: 1 }],
      ["slack_read_channel", { channel_id: "synthetic-channel", limit: 1 }],
      [
        "slack_read_thread",
        { channel_id: "synthetic-channel", message_ts: "123.456", limit: 1 },
      ],
    ] as const) {
      const response = await call(b, name, args);
      assert.equal(response.status, 200);
      assert.match(JSON.stringify(response.body), /synthetic:\/\/message/);
      assert.match(JSON.stringify(response.body), /hasMore/);
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /ACCESS_CANARY|REFRESH_CANARY|SECRET_CANARY/,
      );
    }
    assert.equal(f.toolCalls.length, 4);
    assert.equal(b.evidence.providerReads, 4);
    assert.equal(f.tokenAuthentication.length, 1);
    const tested = await (await f.send(f.prefix + "/test", {})).json();
    assert.equal(tested.status, "ready");
    assert.equal(tested.scope, "synthetic_transport");
    assert.equal(tested.connected, false);
    const count = f.operations.length;
    await f.restart();
    assert.equal(f.operations.length, count);
    assert.equal(
      f.service.getIntegrations().connections[0].config.allowedTools.length,
      4,
    );
    const newBroker = await broker(
      f,
      integrationSnapshot(f.service.getIntegrations()),
    );
    assert.equal(
      (await call(newBroker, "slack_search_public", { query: "synthetic" }))
        .status,
      200,
    );
    await f.load();
    assert.equal(
      f.service.getIntegrations().connections[0].config.enabled,
      false,
    );
    assert.deepEqual(
      f.service.getIntegrations().connections[0].config.allowedTools,
      [],
    );
    b.close();
    newBroker.close();
  } finally {
    await f.close();
  }
});

test("writes, unknown tools, forged captures and invalid arguments fail before credentials or provider access", async () => {
  const f = await fixture();
  try {
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
      "slack_send_message",
      "slack_schedule_message",
      "slack_add_reaction",
      "slack_create_conversation",
      "slack_create_canvas",
      "slack_update_canvas",
      "slack_send_message_draft",
      "slack_read_unknown",
      "slack_read_user_profile",
      "slack_read_file",
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
    for (const args of [
      { query: "x", limit: 21 },
      { query: "x", cursor: "x".repeat(1025) },
      { query: "x", extra: true },
      { query: "x", method: "write" },
      { query: "x", keywords: Array(21).fill("x") },
      { query: "x", max_context_length: 2001 },
      { query: "x", content_types: "files" },
      { query: "x", response_format: "unbounded" },
      {},
    ])
      assert.equal((await call(b, "slack_search_public", args)).status, 403);
    assert.equal(reads, 0);
    assert.equal(f.requests.length, count);
    assert.equal(f.toolCalls.length, 0);
    b.close();
  } finally {
    await f.close();
  }
});

for (const drift of ["source", "generation", "profile", "schema"] as const)
  test(`captured Slack ${drift} drift refuses tool dispatch`, async () => {
    const f = await fixture();
    try {
      const snapshot = await f.grant();
      const b = await broker(f, snapshot);
      const count = f.requests.length;
      if (drift === "source")
        await writeFile(
          f.source,
          JSON.stringify({
            mcpServers: {
              slack: {
                ...f.native.mcpServers.slack,
                url: "https://changed.example/mcp",
              },
            },
          }),
        );
      if (drift === "generation") f.service.mcpOAuth.cancel(f.id);
      if (drift === "schema")
        f.tools[0].inputSchema.required = ["new_required_field"];
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
        (await call(b, "slack_search_public", { query: "synthetic" })).status,
        403,
      );
      assert.equal(f.toolCalls.length, 0);
      if (drift !== "schema") assert.equal(f.requests.length, count);
      b.close();
    } finally {
      await f.close();
    }
  });

for (const result of [
  { content: [{ type: "text" as const, text: "SYNTHETIC_ACCESS_CANARY" }] },
  { content: [{ type: "text" as const, text: "SYNTHETIC_REFRESH_CANARY" }] },
  {
    content: [
      { type: "text" as const, text: "SYNTHETIC_CLIENT_SECRET_CANARY" },
    ],
  },
  { content: [{ type: "text" as const, text: "search:read.public" }] },
  { content: [{ type: "text" as const, text: "x".repeat(200001) }] },
  {
    content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
  },
  {
    isError: true,
    content: [{ type: "text" as const, text: "SYNTHETIC_ERROR_CANARY" }],
  },
])
  test("Slack echo, size, binary and provider errors never reach broker consumers", async () => {
    const f = await fixture({ mcpCallResult: result });
    try {
      const b = await broker(f);
      const response = await call(b, "slack_search_public", {
        query: "synthetic",
        limit: 1,
      });
      assert.equal(response.status, 403);
      assert.doesNotMatch(JSON.stringify(response), /CANARY|search:read/);
      assert.equal(f.toolCalls.length, 1);
      assert.equal(f.tokenAuthentication.length, 1);
      b.close();
    } finally {
      await f.close();
    }
  });

test("ordinary admitted read uses existing serialized refresh, never step-up or retry", async () => {
  const f = await fixture();
  try {
    const b = await broker(f);
    for (const [key, bytes] of f.store.values) {
      const value = JSON.parse(Buffer.from(bytes).toString());
      if (value.tokens) {
        value.expiresAt = Date.now() - 1000;
        f.store.values.set(key, Buffer.from(JSON.stringify(value)));
      }
    }
    assert.equal(
      (await call(b, "slack_search_public", { query: "synthetic" })).status,
      200,
    );
    assert.equal(
      f.tokenAuthentication.filter((item) => item.grantType === "refresh_token")
        .length,
      1,
    );
    assert.equal(f.toolCalls.length, 1);
    b.close();
  } finally {
    await f.close();
  }
});

test("container-facing JSON-line broker frames carry only capabilities, bounded reads and safe replies", async () => {
  const f = await fixture();
  try {
    const b = await broker(f);
    const replies: Array<ReturnType<WorkflowBroker["request"]>> = [];
    const decoder = new JsonLineDecoder((frame) => {
      assert.equal(frame.type, "broker");
      replies.push(b.request(frame as unknown as BrokerRequest));
    }, 4000000);
    for (const [name, args] of [
      ["slack_search_public", { query: "synthetic", limit: 1 }],
      ["slack_send_message", { text: "MUTATION_CANARY" }],
    ] as const) {
      const frame =
        JSON.stringify({
          type: "broker",
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
        }) + "\n";
      assert.doesNotMatch(frame, /ACCESS_CANARY|REFRESH_CANARY|SECRET_CANARY/);
      decoder.push(Buffer.from(frame.slice(0, 19)));
      decoder.push(Buffer.from(frame.slice(19)));
    }
    assert.deepEqual(
      (await Promise.all(replies)).map((reply) => reply.status),
      [200, 403],
    );
    assert.equal(f.toolCalls.length, 1);
    assert.equal(b.evidence.providerReads, 1);
    assert.doesNotMatch(
      JSON.stringify(await Promise.all(replies)),
      /ACCESS_CANARY|REFRESH_CANARY|SECRET_CANARY|MUTATION_CANARY/,
    );
    b.close();
  } finally {
    await f.close();
  }
});

test("provider refusal stops one read without refresh or retry", async () => {
  const f = await fixture({ mcpCallStatus: 403 });
  try {
    const b = await broker(f);
    assert.equal(
      (await call(b, "slack_search_public", { query: "synthetic" })).status,
      403,
    );
    assert.equal(f.toolCalls.length, 1);
    assert.equal(f.tokenAuthentication.length, 1);
    b.close();
  } finally {
    await f.close();
  }
});

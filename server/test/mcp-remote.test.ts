import test from "node:test";
import assert from "node:assert/strict";
import { remoteMcp } from "../mcp-remote.js";
import {
  publicAddress,
  publicHttps,
  guardedFetch,
  type GuardedFetch,
} from "../guarded-fetch.js";
import { ReadOnlyMcpGateway, fingerprintToolSchema } from "../integrations.js";
import type { IntegrationConnection } from "../../shared/contracts.js";

const endpoint = "https://mcp.example.com/mcp";
const schema = {
  type: "object" as const,
  properties: { id: { type: "string", maxLength: 40 } },
  required: ["id"],
  additionalProperties: false,
};

function transportFixture() {
  const calls: Array<{ method: string; params?: any }> = [];
  const behavior = {
    cycle: false,
    unending: false,
    protocol: "2025-11-25",
    drift: false,
    unauthenticated: false,
    session: "synthetic-session",
    events: false,
  };
  const fetch: GuardedFetch = async (url, init = {}) => {
    assert.equal(String(url), endpoint);
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer synthetic-access",
    );
    if (init.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    calls.push(request);
    if (!request.id && request.id !== 0)
      return new Response(null, { status: 202 });
    let result;
    if (request.method === "initialize")
      result = {
        protocolVersion: behavior.protocol,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    else if (request.method === "tools/list")
      result = {
        tools: [
          {
            name: behavior.unending
              ? `fixture_page_${request.params?.cursor ?? "0"}`
              : request.params?.cursor
                ? "fixture_unknown_write"
                : "fixture_read",
            description: "INERT tool metadata, not permission",
            inputSchema: behavior.drift ? { type: "object" } : schema,
            outputSchema: schema,
            annotations: { readOnlyHint: true },
          },
        ],
        ...(behavior.unending
          ? { nextCursor: String(Number(request.params?.cursor ?? 0) + 1) }
          : !request.params?.cursor || behavior.cycle
            ? { nextCursor: "second" }
            : {}),
      };
    else if (request.method === "tools/call") {
      if (behavior.unauthenticated)
        return Response.json({ error: "synthetic rejected" }, { status: 401 });
      result = {
        content: [
          {
            type: "text",
            text: "Synthetic bounded document citation: fixture:approved",
          },
        ],
      };
    } else throw new Error("Unexpected MCP fixture method");
    const message = { jsonrpc: "2.0", id: request.id, result };
    return behavior.events && request.method !== "initialize"
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": behavior.session,
          },
        })
      : Response.json(message, {
          headers: { "mcp-session-id": behavior.session },
        });
  };
  return { fetch, calls, behavior };
}

function connection(): IntegrationConnection {
  return {
    definition: {
      id: "fixture",
      label: "Synthetic OAuth read adapter",
      provider: "custom",
      transport: "mcp-http",
      authReuse: "host-session",
      identity: endpoint,
      supported: true,
      compatibilityMessage: null,
      tools: [
        {
          id: "read",
          label: "Read",
          operation: "read",
          toolNames: ["fixture_read"],
          schemaFingerprint: fingerprintToolSchema(schema),
          allowedMethods: [],
          argumentPolicy: "bounded",
        },
      ],
    },
    config: {
      id: "fixture",
      enabled: true,
      allowedTools: ["read"],
      source: "custom",
      endpoint,
      serverName: "fixture",
      authRef: null,
      configPath: null,
    },
    effective: "restricted",
    status: "ready",
    message: "Synthetic only",
    tools: [
      {
        id: "read",
        label: "Read",
        state: "allowed",
        reason: "Explicit fixture grant",
      },
    ],
  };
}

test("SDK Streamable HTTP JSON/events paginate within existing gateway schema/default-denial boundary", async () => {
  for (const events of [false, true]) {
    const fixture = transportFixture();
    fixture.behavior.events = events;
    await remoteMcp(
      endpoint,
      fixture.fetch,
      async () => "synthetic-access",
      async (session) => {
        const gateway = new ReadOnlyMcpGateway(connection(), {
          async listTools() {
            return session.tools;
          },
          async callTool(name, args) {
            if (args.id !== "approved")
              throw new Error("Resource scope denied");
            return session.call(name, args);
          },
        });
        assert.deepEqual(
          (await gateway.listTools()).map((tool) => tool.name),
          ["fixture_read"],
        );
        await assert.rejects(
          gateway.call({
            serverIdentity: endpoint,
            name: "fixture_unknown_write",
            arguments: { id: "approved" },
          }),
          /not an enabled/,
        );
        await assert.rejects(
          gateway.call({
            serverIdentity: endpoint,
            name: "fixture_read",
            arguments: { id: "outside" },
          }),
          /scope denied/,
        );
        await assert.rejects(
          gateway.call({
            serverIdentity: endpoint,
            name: "fixture_read",
            arguments: { id: "approved", url: "https://evil.test" },
          }),
          /unexpected|additional|Unknown/i,
        );
        assert.match(
          JSON.stringify(
            await gateway.call({
              serverIdentity: endpoint,
              name: "fixture_read",
              arguments: { id: "approved" },
            }),
          ),
          /fixture:approved/,
        );
      },
    );
    assert.equal(
      fixture.calls.filter((call) => call.method === "tools/call").length,
      1,
    );
    assert.equal(
      fixture.calls.filter((call) => call.method === "tools/list").length,
      2,
    );
    assert.equal(
      fixture.calls.some((call) => call.method === "server/discover"),
      false,
    );
  }
});

test("SDK metadata catalog preserves initialization and all paginated definitions without calls", async () => {
  const fixture = transportFixture();
  const result = await remoteMcp(
    endpoint,
    fixture.fetch,
    async () => "synthetic-access",
    async ({ tools, initialization, pages }) => ({
      tools,
      initialization,
      pages,
    }),
  );
  assert.equal(result.pages, 2);
  assert.deepEqual(result.initialization, {
    protocolVersion: "2025-11-25",
    serverInfo: { name: "fixture", version: "1" },
    capabilities: { tools: {} },
  });
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ["fixture_read", "fixture_unknown_write"],
  );
  for (const tool of result.tools) {
    assert.equal(tool.description, "INERT tool metadata, not permission");
    assert.deepEqual(tool.inputSchema, schema);
    assert.deepEqual(tool.outputSchema, schema);
  }
  assert.equal(
    fixture.calls.some((call) => call.method === "tools/call"),
    false,
  );
  const bounded = transportFixture();
  bounded.behavior.unending = true;
  await assert.rejects(
    remoteMcp(
      endpoint,
      bounded.fetch,
      async () => "synthetic-access",
      async () => assert.fail("Partial inventory must not escape"),
    ),
    /session failed/,
  );
  assert.equal(
    bounded.calls.filter((call) => call.method === "tools/list").length,
    10,
  );
});

test("retained definition runs one schema-checked call without another catalog request", async () => {
  const fixture = transportFixture();
  await remoteMcp(
    endpoint,
    fixture.fetch,
    async () => "synthetic-access",
    async ({ call }) => {
      await call("fixture_read", { id: "approved" });
      await assert.rejects(
        call("fixture_read", { id: "approved" }),
        /already attempted/,
      );
    },
    undefined,
    {
      initialization: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "fixture", version: "1" },
        capabilities: { tools: {} },
      },
      tool: { name: "fixture_read", inputSchema: schema },
    },
  );
  assert.deepEqual(
    fixture.calls.map((call) => call.method),
    ["initialize", "notifications/initialized", "tools/call"],
  );
});

test("retained call denies changed initialization, arguments, tool identity and refused calls without list or retry", async (t) => {
  for (const condition of [
    "server",
    "protocol",
    "capabilities",
    "arguments",
    "tool",
    "refusal",
  ])
    await t.test(condition, async () => {
      const fixture = transportFixture();
      fixture.behavior.unauthenticated = condition === "refusal";
      await assert.rejects(
        remoteMcp(
          endpoint,
          fixture.fetch,
          async () => "synthetic-access",
          ({ call }) =>
            call(
              condition === "tool" ? "unknown" : "fixture_read",
              condition === "arguments" ? {} : { id: "approved" },
            ),
          undefined,
          {
            initialization: {
              protocolVersion:
                condition === "protocol" ? "2025-06-18" : "2025-11-25",
              serverInfo: {
                name: condition === "server" ? "changed" : "fixture",
                version: "1",
              },
              capabilities: {
                tools:
                  condition === "capabilities" ? { listChanged: true } : {},
              },
            },
            tool: { name: "fixture_read", inputSchema: schema },
          },
        ),
        /MCP session failed/,
      );
      assert.equal(
        fixture.calls.some((call) => call.method === "tools/list"),
        false,
      );
      assert.equal(
        fixture.calls.filter((call) => call.method === "tools/call").length,
        condition === "refusal" ? 1 : 0,
      );
    });
});

test("session version, cursor cycle, schema drift and ambiguous calls fail closed", async () => {
  const cycle = transportFixture();
  cycle.behavior.cycle = true;
  await assert.rejects(
    remoteMcp(
      endpoint,
      cycle.fetch,
      async () => "synthetic-access",
      async () => {},
    ),
    /session failed/,
  );
  assert.ok(cycle.calls.length <= 12);
  const version = transportFixture();
  version.behavior.protocol = "2026-07-28";
  await assert.rejects(
    remoteMcp(
      endpoint,
      version.fetch,
      async () => "synthetic-access",
      async () => {},
    ),
    /session failed/,
  );
  const drift = transportFixture();
  drift.behavior.drift = true;
  await remoteMcp(
    endpoint,
    drift.fetch,
    async () => "synthetic-access",
    async (session) => {
      const gateway = new ReadOnlyMcpGateway(connection(), {
        async listTools() {
          return session.tools;
        },
        callTool: session.call,
      });
      assert.deepEqual(await gateway.listTools(), []);
    },
  );
  const denied = transportFixture();
  denied.behavior.unauthenticated = true;
  await assert.rejects(
    remoteMcp(
      endpoint,
      denied.fetch,
      async () => "synthetic-access",
      (session) => session.call("fixture_read", { id: "approved" }),
    ),
    /no tool call was automatically retried/,
  );
  assert.equal(
    denied.calls.filter((call) => call.method === "tools/call").length,
    1,
  );
});

test("public transport excludes private, link-local and reserved addresses and exact unapproved origins", async () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.1.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
  ])
    assert.equal(publicAddress(address), false);
  assert.equal(publicAddress("1.1.1.1"), true);
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://user:pass@example.com",
    "https://example.com:8443",
    "https://localhost",
    "https://example.com/#fragment",
  ])
    assert.throws(() => publicHttps(url), /public HTTPS/);
  await assert.rejects(
    guardedFetch(["https://approved.example.com"])(
      "https://elsewhere.example.com",
    ),
    /destination is not approved/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { oauthFixture } from "./fixtures/oauth-context.js";
import { integrationSnapshot } from "../integrations.js";
import type { Tool } from "@modelcontextprotocol/client";
import type { McpOAuth, McpOAuthDiagnostic } from "../mcp-oauth.js";

async function imported(f: Awaited<ReturnType<typeof oauthFixture>>) {
  const discovery = await f.send("/api/settings/integrations/discover", {
    harness: "claude",
    path: f.source,
  });
  assert.equal(discovery.status, 200);
  const catalog = await discovery.json();
  const id = catalog.connections[0].config.id as string;
  assert.equal(
    catalog.connections[0].config.native.authentication,
    "app-owned-oauth",
  );
  assert.deepEqual(
    catalog.connections[0].config.native.oauth,
    f.native.mcpServers.slack.oauth,
  );
  const result = await f.send("/api/settings/integrations/import-oauth", {
    id,
    profileId: "slack-mcp/1",
  });
  assert.equal(result.status, 200);
  return id;
}

async function configured(
  f: Awaited<ReturnType<typeof oauthFixture>>,
  id: string,
) {
  const discovery = await f.send(
    `/api/settings/integrations/${id}/oauth/discover`,
    {},
  );
  assert.equal(discovery.status, 200);
  const status = await discovery.json();
  const unadvertised = await f.send(
    `/api/settings/integrations/${id}/oauth/configure`,
    {
      clientId: "synthetic-unadvertised-confidential-client",
      clientAuthMethod: "client_secret_basic",
      clientSecret: "SYNTHETIC_CLIENT_SECRET_CANARY",
      scopes: ["search:read.public"],
      discoveryDigest: status.discovery.digest,
    },
  );
  assert.equal(unadvertised.status, 409);
  assert.equal(f.store.values.size, 0);
  const response = await f.send(
    `/api/settings/integrations/${id}/oauth/configure`,
    {
      clientId: "synthetic-app-owned-client",
      clientAuthMethod: "client_secret_post",
      clientSecret: "SYNTHETIC_CLIENT_SECRET_CANARY",
      scopes: ["search:read.public"],
      discoveryDigest: status.discovery.digest,
    },
  );
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /CLIENT_SECRET_CANARY/);
  return status;
}

async function admitted(
  f: Awaited<ReturnType<typeof oauthFixture>>,
  id: string,
  status = 200,
) {
  const start = await f.send(
    `/api/settings/integrations/${id}/oauth/connect`,
    {},
  );
  assert.equal(start.status, 200);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const authorization = new URL((await start.json()).authorizationUrl);
  const params = new URLSearchParams({
    state: authorization.searchParams.get("state")!,
    code: "SYNTHETIC_CATALOG_CODE",
    iss: "https://mcp.slack.com",
  });
  const result = await f.send(`/api/mcp/oauth/callback?${params}`, undefined, {
    cookie,
  });
  assert.equal(result.status, status);
  return cookie;
}

const catalogTool: Tool = {
  name: "synthetic_unvetted_read",
  description: "INERT catalog definition, never a tool grant",
  inputSchema: {
    type: "object",
    properties: { channel: { type: "string" } },
    required: ["channel"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { citation: { type: "string" } },
    required: ["citation"],
  },
  annotations: { readOnlyHint: true },
};

const retainedProfile = {
  endpoint: "https://mcp.slack.com/mcp",
  resource: "https://mcp.slack.com",
  initialization: {
    protocolVersion: "2025-11-25",
    serverInfo: { name: "synthetic-only-not-slack", version: "1" },
    capabilities: { tools: {} },
  },
  tools: [
    {
      name: "slack_read_user_profile",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string" },
          include_locale: { type: "boolean" },
          response_format: { type: "string", enum: ["detailed", "concise"] },
        },
        required: [],
      },
    },
  ],
  coverage: { complete: true, pages: 1, toolCount: 1 },
} satisfies Awaited<ReturnType<McpOAuth["catalog"]>>;

test("self-profile uses exactly the approved arguments and retained schema without inventory, refresh, grants or identity promotion", async () => {
  const result = {
    content: [
      { type: "text" as const, text: "SYNTHETIC_PERSONAL_PROFILE_CANARY" },
    ],
  };
  const f = await oauthFixture({ mcpCallResult: result });
  const events: McpOAuthDiagnostic[] = [];
  try {
    const id = await imported(f);
    await configured(f, id);
    await admitted(f, id);
    const generation = f.service.mcpOAuth.status(id).generation;
    await f.restart();
    f.service.mcpOAuth.onDiagnostic = (event) => events.push(event);
    const stored = [...f.store.values].map(([key, value]) => [
      key,
      Buffer.from(value),
    ]);
    const before = f.operations.length;
    assert.deepEqual(
      await f.service.mcpOAuth.selfProfile(id, generation, retainedProfile),
      result,
    );
    assert.deepEqual(f.operations.slice(before), [
      "synthetic:initialize",
      "synthetic:notifications/initialized",
      "synthetic:tools/call",
    ]);
    assert.deepEqual(f.toolCalls, [
      {
        name: "slack_read_user_profile",
        arguments: { response_format: "concise" },
      },
    ]);
    assert.equal(f.tokenAuthentication.length, 1);
    assert.deepEqual([...f.store.values], stored);
    assert.deepEqual(events, [
      { phase: "identity_probe", outcome: "started" },
      { phase: "identity_probe", outcome: "succeeded" },
    ]);
    const catalog = f.service.getIntegrations();
    assert.equal(catalog.connections[0].oauth!.identity, null);
    assert.equal(catalog.connections[0].config.enabled, false);
    assert.deepEqual(catalog.connections[0].config.allowedTools, []);
    assert.equal(catalog.connections[0].config.inventory, undefined);
    assert.doesNotMatch(
      JSON.stringify([catalog, events, integrationSnapshot(catalog)]),
      /PERSONAL_PROFILE_CANARY/,
    );
  } finally {
    await f.close();
  }
});

test("detailed self-profile sends only the separately selected format without re-listing or refreshing", async () => {
  const f = await oauthFixture({
    mcpResponseFormat: "detailed",
    mcpCallResult: {
      content: [{ type: "text", text: "SYNTHETIC_DETAILED_PROFILE_CANARY" }],
    },
  });
  try {
    const id = await imported(f);
    await configured(f, id);
    await admitted(f, id);
    const before = f.operations.length;
    await f.service.mcpOAuth.selfProfile(
      id,
      f.service.mcpOAuth.status(id).generation,
      retainedProfile,
      "detailed",
    );
    assert.deepEqual(f.toolCalls, [
      {
        name: "slack_read_user_profile",
        arguments: { response_format: "detailed" },
      },
    ]);
    assert.deepEqual(f.operations.slice(before), [
      "synthetic:initialize",
      "synthetic:notifications/initialized",
      "synthetic:tools/call",
    ]);
    assert.equal(f.tokenAuthentication.length, 1);
    const c = f.service.getIntegrations().connections[0];
    assert.equal(c.oauth!.identity, null);
    assert.equal(c.config.enabled, false);
    assert.deepEqual(c.config.allowedTools, []);
  } finally {
    await f.close();
  }
});

test("detailed self-profile refuses stale credentials, incompatible schema and provider errors without another call", async (t) => {
  for (const condition of ["expiry", "schema", "refusal"])
    await t.test(condition, async (t) => {
      const f = await oauthFixture({
        mcpResponseFormat: "detailed",
        tokenOverrides: { expires_in: 60 },
        ...(condition === "refusal" ? { mcpCallStatus: 403 } : {}),
      });
      try {
        const id = await imported(f);
        await configured(f, id);
        await admitted(f, id);
        const generation = f.service.mcpOAuth.status(id).generation;
        const capture = structuredClone(retainedProfile);
        if (condition === "schema")
          capture.tools[0].inputSchema.properties.response_format.enum = [
            "concise",
          ];
        if (condition === "expiry") {
          const now = Date.now() + 61000;
          t.mock.method(Date, "now", () => now);
        }
        const before = f.operations.length;
        await assert.rejects(
          f.service.mcpOAuth.selfProfile(id, generation, capture, "detailed"),
        );
        assert.equal(f.toolCalls.length, condition === "refusal" ? 1 : 0);
        if (condition !== "refusal") assert.equal(f.operations.length, before);
        assert.equal(f.operations.includes("synthetic:tools/list"), false);
        assert.equal(f.tokenAuthentication.length, 1);
        assert.equal(f.service.mcpOAuth.status(id).authenticated, true);
      } finally {
        t.mock.restoreAll();
        await f.close();
      }
    });
});

test("self-profile stops before protocol access for invalid retained inputs, binding or no-refresh admission", async (t) => {
  for (const condition of [
    "expired",
    "near-expiry",
    "missing",
    "locked",
    "generation",
    "source",
    "pending",
    "endpoint",
    "resource",
    "tool",
    "required",
    "enum",
  ])
    await t.test(condition, async (t) => {
      const f = await oauthFixture({
        tokenOverrides: {
          expires_in: 60,
          ...(condition === "pending"
            ? { scope: "search:read.public,PRIVATE_CAPABILITY_CANARY:read" }
            : {}),
        },
      });
      try {
        const id = await imported(f);
        await configured(f, id);
        await admitted(f, id, condition === "pending" ? 202 : 200);
        const generation = f.service.mcpOAuth.status(id).generation;
        const capture = structuredClone(retainedProfile) as Awaited<
          ReturnType<McpOAuth["catalog"]>
        >;
        if (condition === "expired" || condition === "near-expiry") {
          const now = Date.now() + (condition === "expired" ? 61000 : 31000);
          t.mock.method(Date, "now", () => now);
        }
        if (condition === "missing") f.store.values.clear();
        if (condition === "locked") f.store.unavailable = true;
        if (condition === "source") await writeFile(f.source, "{}");
        if (condition === "endpoint")
          capture.endpoint = "https://other.example/mcp";
        if (condition === "resource")
          capture.resource = "https://other.example";
        if (condition === "tool") capture.tools[0].name = "slack_search_users";
        if (condition === "required")
          capture.tools[0].inputSchema.required = ["user_id"];
        if (condition === "enum")
          capture.tools[0].inputSchema.properties!.response_format = {
            type: "string",
            enum: ["detailed"],
          };
        const before = [...f.operations];
        const durable = f.service.db.sqlite
          .prepare("SELECT state_json FROM mcp_oauth")
          .all();
        await assert.rejects(
          f.service.mcpOAuth.selfProfile(
            id,
            condition === "generation" ? "stale" : generation,
            capture,
          ),
        );
        assert.deepEqual(f.operations, before);
        assert.deepEqual(f.toolCalls, []);
        assert.equal(f.tokenAuthentication.length, 1);
        assert.deepEqual(
          f.service.db.sqlite.prepare("SELECT state_json FROM mcp_oauth").all(),
          durable,
        );
      } finally {
        t.mock.restoreAll();
        await f.close();
      }
    });
});

test("self-profile fences mid-session drift, refusals, oversized results and credential echoes without another call", async (t) => {
  for (const condition of [
    "expiry",
    "source",
    "generation",
    "server",
    "401",
    "403",
    "tool-error",
    "size",
    "echo",
    "client-echo",
    "post-call-source",
  ])
    await t.test(condition, async (t) => {
      let onRequest: (method: string) => void = () => {};
      const f = await oauthFixture({
        tokenOverrides: { expires_in: 60 },
        onMcpRequest: (method) => onRequest(method),
        mcpCallResult: {
          content: [
            {
              type: "text",
              text:
                condition === "size"
                  ? "x".repeat(200001)
                  : condition === "echo"
                    ? "SYNTHETIC_ACCESS_CANARY"
                    : condition === "client-echo"
                      ? "SYNTHETIC_CLIENT_SECRET_CANARY"
                      : "SYNTHETIC_PERSONAL_PROFILE_CANARY",
            },
          ],
          ...(condition === "tool-error" ? { isError: true } : {}),
        },
        ...(["401", "403"].includes(condition)
          ? { mcpCallStatus: Number(condition) }
          : {}),
        ...(condition === "server"
          ? { mcpServerInfo: { name: "changed", version: "1" } }
          : {}),
      });
      const events: McpOAuthDiagnostic[] = [];
      try {
        const id = await imported(f);
        await configured(f, id);
        await admitted(f, id);
        f.service.mcpOAuth.onDiagnostic = (event) => events.push(event);
        const generation = f.service.mcpOAuth.status(id).generation;
        const source = f.service.mcpOAuth.validateSource!;
        let changed = false;
        f.service.mcpOAuth.validateSource = async (id) => {
          if (changed) throw new Error("SYNTHETIC_PERSONAL_SOURCE_CANARY");
          await source(id);
        };
        onRequest = (method) => {
          if (condition === "post-call-source" && method === "tools/call")
            changed = true;
          if (method !== "initialize") return;
          if (condition === "expiry") {
            const now = Date.now() + 31000;
            t.mock.method(Date, "now", () => now);
          }
          if (condition === "source") changed = true;
          if (condition === "generation") f.service.mcpOAuth.cancel(id);
        };
        await assert.rejects(
          f.service.mcpOAuth.selfProfile(id, generation, retainedProfile),
          (error: Error) => {
            assert.match(error.message, /MCP session failed/);
            assert.doesNotMatch(error.message, /CANARY/);
            return true;
          },
        );
        assert.equal(
          f.toolCalls.length,
          ["expiry", "source", "generation", "server"].includes(condition)
            ? 0
            : 1,
        );
        assert.equal(f.operations.includes("synthetic:tools/list"), false);
        assert.equal(f.tokenAuthentication.length, 1);
        assert.doesNotMatch(JSON.stringify(events), /CANARY/);
        assert.equal(
          f.service.getIntegrations().connections[0].oauth!.identity,
          null,
        );
      } finally {
        t.mock.restoreAll();
        await f.close();
      }
    });
});

test("no-refresh catalog preserves complete SDK metadata after admitted restart without changing grants or credentials", async () => {
  const f = await oauthFixture({ mcpTools: [catalogTool] });
  try {
    const id = await imported(f);
    await configured(f, id);
    await admitted(f, id);
    const generation = f.service.mcpOAuth.status(id).generation;
    const stored = [...f.store.values].map(([key, value]) => [
      key,
      Buffer.from(value),
    ]);
    const previous = f.operations.length;
    await f.restart();
    assert.equal(f.operations.length, previous);
    const result = await f.service.mcpOAuth.catalog(id, generation);
    assert.deepEqual(result, {
      endpoint: "https://mcp.slack.com/mcp",
      resource: "https://mcp.slack.com",
      initialization: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "synthetic-only-not-slack", version: "1" },
        capabilities: { tools: {} },
      },
      tools: [catalogTool],
      coverage: { complete: true, pages: 1, toolCount: 1 },
    });
    assert.deepEqual(f.operations.slice(previous), [
      "synthetic:initialize",
      "synthetic:notifications/initialized",
      "synthetic:tools/list",
    ]);
    assert.equal(f.tokenAuthentication.length, 1);
    assert.deepEqual([...f.store.values], stored);
    const catalog = f.service.getIntegrations();
    const connection = catalog.connections[0];
    assert.equal(connection.oauth!.authenticated, true);
    assert.equal(connection.oauth!.identity, null);
    assert.equal(connection.config.enabled, false);
    assert.deepEqual(connection.config.allowedTools, []);
    assert.equal(connection.config.inventory, undefined);
    assert.deepEqual(
      await f.service.readProviders.session(
        integrationSnapshot(catalog),
        AbortSignal.timeout(1000),
      ),
      [],
    );
    const normal = await f.service.mcpOAuth.inventory(id);
    assert.deepEqual(Object.keys(normal.tools[0]).sort(), [
      "name",
      "schemaFingerprint",
    ]);
    assert.equal(f.operations.includes("synthetic:tools/call"), false);
    assert.doesNotMatch(
      JSON.stringify(result),
      /CANARY|SYNTHETIC_CATALOG_CODE/,
    );
  } finally {
    await f.close();
  }
});

test("no-refresh catalog refuses unavailable credentials or authority before transport without mutation", async (t) => {
  for (const condition of [
    "expired",
    "near-expiry",
    "missing",
    "locked",
    "generation",
    "source",
    "pending-consent",
  ])
    await t.test(condition, async (t) => {
      const f = await oauthFixture({
        tokenOverrides: {
          expires_in: 60,
          ...(condition === "pending-consent"
            ? { scope: "search:read.public,PRIVATE_CAPABILITY_CANARY:read" }
            : {}),
        },
      });
      try {
        const id = await imported(f);
        await configured(f, id);
        await admitted(f, id, condition === "pending-consent" ? 202 : 200);
        const generation = f.service.mcpOAuth.status(id).generation;
        if (condition === "expired" || condition === "near-expiry") {
          const now = Date.now() + (condition === "expired" ? 61000 : 31000);
          t.mock.method(Date, "now", () => now);
        }
        if (condition === "missing") f.store.values.clear();
        if (condition === "locked") f.store.unavailable = true;
        if (condition === "source") await writeFile(f.source, "{}");
        const stored = [...f.store.values].map(([key, value]) => [
          key,
          Buffer.from(value),
        ]);
        const durable = f.service.db.sqlite
          .prepare("SELECT state_json FROM mcp_oauth")
          .all();
        const operations = [...f.operations];
        await assert.rejects(
          f.service.mcpOAuth.catalog(
            id,
            condition === "generation" ? "stale-generation" : generation,
          ),
        );
        assert.deepEqual(f.operations, operations);
        assert.equal(f.tokenAuthentication.length, 1);
        assert.deepEqual([...f.store.values], stored);
        assert.deepEqual(
          f.service.db.sqlite.prepare("SELECT state_json FROM mcp_oauth").all(),
          durable,
        );
      } finally {
        t.mock.restoreAll();
        await f.close();
      }
    });
});

test("no-refresh catalog rechecks freshness and bindings during the SDK session without retry", async (t) => {
  for (const condition of ["expiry", "generation", "source", "401", "403"])
    await t.test(condition, async (t) => {
      let onRequest: (method: string) => void = () => {};
      const f = await oauthFixture({
        tokenOverrides: { expires_in: 60 },
        onMcpRequest: (method) => onRequest(method),
        ...(["401", "403"].includes(condition)
          ? { mcpStatus: Number(condition) }
          : {}),
      });
      try {
        const id = await imported(f);
        await configured(f, id);
        await admitted(f, id);
        const generation = f.service.mcpOAuth.status(id).generation;
        const originalSource = f.service.mcpOAuth.validateSource!;
        let drifted = false;
        f.service.mcpOAuth.validateSource = async (id) => {
          if (drifted) throw new Error("SYNTHETIC_SOURCE_CANARY");
          await originalSource(id);
        };
        onRequest = (method) => {
          if (method !== "initialize") return;
          if (condition === "expiry") {
            const now = Date.now() + 31000;
            t.mock.method(Date, "now", () => now);
          }
          if (condition === "generation") f.service.mcpOAuth.cancel(id);
          if (condition === "source") drifted = true;
        };
        await assert.rejects(
          f.service.mcpOAuth.catalog(id, generation),
          /MCP session failed/,
        );
        assert.equal(
          f.operations.filter((op) => op === "synthetic:initialize").length,
          1,
        );
        assert.equal(f.operations.includes("synthetic:tools/list"), false);
        assert.equal(f.tokenAuthentication.length, 1);
        assert.equal(f.operations.includes("synthetic:tools/call"), false);
      } finally {
        t.mock.restoreAll();
        await f.close();
      }
    });
});

test("no-refresh catalog rejects credential and accepted-capability echoes throughout definitions and initialization", async (t) => {
  for (const field of [
    "name",
    "description",
    "inputSchema",
    "outputSchema",
    "serverInfo",
  ])
    await t.test(field, async () => {
      const tools = [structuredClone(catalogTool)];
      if (field === "name") tools[0].name = "SYNTHETIC_ACCESS_CANARY";
      if (field === "description")
        tools[0].description = "SYNTHETIC_REFRESH_CANARY";
      if (field === "inputSchema")
        tools[0].inputSchema.description = "SYNTHETIC_CLIENT_SECRET_CANARY";
      if (field === "outputSchema")
        tools[0].outputSchema!.description = "PRIVATE_CAPABILITY_CANARY:read";
      const f = await oauthFixture({
        mcpTools: tools,
        ...(field === "serverInfo"
          ? {
              mcpServerInfo: {
                name: "PRIVATE_CAPABILITY_CANARY:read",
                version: "1",
              },
            }
          : {}),
        tokenOverrides: {
          scope: "search:read.public,PRIVATE_CAPABILITY_CANARY:read",
        },
      });
      try {
        const id = await imported(f);
        await configured(f, id);
        const cookie = await admitted(f, id, 202);
        const preview = await f.service.mcpOAuth.scopePreview(
          id,
          cookie.split("=")[1],
        );
        const accepted = await f.send(
          `/api/settings/integrations/${id}/oauth/accept-scopes`,
          {
            previewId: preview.id,
            generation: preview.generation,
            additionalScopes: preview.additionalScopes,
            consent: "Accept these additional OAuth capabilities",
          },
          { cookie },
        );
        assert.equal(accepted.status, 200);
        await assert.rejects(
          f.service.mcpOAuth.catalog(id, preview.generation),
          (error: Error) => {
            assert.match(error.message, /MCP session failed/);
            assert.doesNotMatch(error.message, /CANARY/);
            return true;
          },
        );
        assert.equal(f.service.mcpOAuth.status(id).authenticated, true);
        assert.equal(f.tokenAuthentication.length, 1);
        assert.equal(f.operations.includes("synthetic:tools/call"), false);
      } finally {
        await f.close();
      }
    });
});

test("no-refresh catalog fails whole on invalid or excessive definitions without granting partial inventory", async (t) => {
  for (const condition of [
    "count",
    "duplicate",
    "name",
    "schema",
    "size",
    "combined-size",
    "cycle",
  ])
    await t.test(condition, async () => {
      const tools = [structuredClone(catalogTool)];
      if (condition === "count")
        tools.push(
          ...Array.from({ length: 100 }, (_, i) => ({
            ...catalogTool,
            name: `synthetic_${i}`,
          })),
        );
      if (condition === "duplicate") tools.push(structuredClone(catalogTool));
      if (condition === "name") tools[0].name = "invalid name";
      if (condition === "schema")
        tools[0].inputSchema = {
          type: "invalid",
        } as unknown as Tool["inputSchema"];
      if (condition === "size") tools[0].description = "x".repeat(200001);
      if (condition === "combined-size")
        tools[0].description = "x".repeat(110000);
      const f = await oauthFixture({
        mcpTools: tools,
        ...(condition === "combined-size"
          ? { mcpServerInfo: { name: "x".repeat(100000), version: "1" } }
          : {}),
        ...(condition === "cycle" ? { mcpNextCursor: "same-cursor" } : {}),
      });
      try {
        const id = await imported(f);
        await configured(f, id);
        await admitted(f, id);
        await assert.rejects(
          f.service.mcpOAuth.catalog(
            id,
            f.service.mcpOAuth.status(id).generation,
          ),
          /MCP session failed/,
        );
        assert.equal(f.tokenAuthentication.length, 1);
        assert.equal(f.operations.includes("synthetic:tools/call"), false);
        assert.equal(
          f.service.getIntegrations().connections[0].config.inventory,
          undefined,
        );
        assert.ok(
          f.operations.filter((op) => op === "synthetic:tools/list").length <=
            2,
        );
      } finally {
        await f.close();
      }
    });
});

test("native OAuth discovery preserves declared non-secret client metadata without promoting it to auth", async () => {
  const f = await oauthFixture();
  try {
    await imported(f);
    let catalog = await (await f.send("/api/settings/integrations")).json();
    assert.equal(catalog.connections[0].oauth.configured, false);
    assert.equal(catalog.connections[0].oauth.authenticated, false);
    assert.equal(catalog.connections[0].oauth.clientId, undefined);
    assert.equal(catalog.connections[0].oauth.identity, null);
    assert.deepEqual(catalog.connections[0].config.allowedTools, []);
    assert.equal(f.store.values.size, 0);
    await f.restart();
    catalog = await (await f.send("/api/settings/integrations")).json();
    assert.deepEqual(
      catalog.connections[0].config.native.oauth,
      f.native.mcpServers.slack.oauth,
    );
    assert.equal(catalog.connections[0].oauth.configured, false);
    const originalDigest = catalog.connections[0].config.native.digest;
    await writeFile(
      f.source,
      JSON.stringify({
        mcpServers: {
          slack: {
            ...f.native.mcpServers.slack,
            oauth: { clientId: "changed-declared-client", callbackPort: 3119 },
          },
        },
      }),
    );
    const changed = await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: f.source,
    });
    assert.equal(changed.status, 200);
    catalog = await changed.json();
    assert.notEqual(
      catalog.connections[0].config.native.digest,
      originalDigest,
    );
    assert.deepEqual(catalog.connections[0].config.native.oauth, {
      clientId: "changed-declared-client",
      callbackPort: 3119,
    });
    await writeFile(
      f.source,
      JSON.stringify({
        mcpServers: {
          slack: {
            ...f.native.mcpServers.slack,
            oauth: {
              ...f.native.mcpServers.slack.oauth,
              clientSecret: "NATIVE_SECRET_MUST_NOT_BE_RETURNED",
            },
          },
        },
      }),
    );
    const refused = await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: f.source,
    });
    assert.equal(refused.status, 200);
    catalog = await refused.json();
    assert.equal(catalog.connections[0].config.native.support, "unsupported");
    assert.equal(catalog.connections[0].config.native.oauth, undefined);
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /NATIVE_SECRET_MUST_NOT_BE_RETURNED/,
    );
    assert.deepEqual(f.operations, []);
    assert.equal(f.store.values.size, 0);
  } finally {
    await f.close();
  }
});

test("Slack explicitly advertised public clients need no policy fallback, secrets or grants", async () => {
  const f = await oauthFixture({ clientAuthMethods: ["none"] });
  try {
    const original = await readFile(f.source, "utf8");
    const id = await imported(f);
    const discovery = await (
      await f.send(`/api/settings/integrations/${id}/oauth/discover`, {})
    ).json();
    assert.deepEqual(discovery.discovery.clientAuthMethods, ["none"]);
    assert.deepEqual(discovery.discovery.advertisedClientAuthMethods, ["none"]);
    assert.equal(discovery.discovery.publicClientPolicy, undefined);
    assert.equal(discovery.discovery.resource, "https://mcp.slack.com");
    assert.deepEqual(f.requests, [
      "https://mcp.slack.com/.well-known/oauth-protected-resource",
      "https://mcp.slack.com/.well-known/oauth-authorization-server",
    ]);
    assert.equal(discovery.discovery.dynamicRegistration, false);
    assert.equal(discovery.configured, false);
    const configured = await f.send(
      `/api/settings/integrations/${id}/oauth/configure`,
      {
        clientId: "synthetic-existing-public-client",
        clientAuthMethod: "none",
        scopes: ["search:read.public"],
        discoveryDigest: discovery.discovery.digest,
      },
    );
    assert.equal(configured.status, 200, await configured.clone().text());
    assert.equal((await configured.json()).authenticated, false);
    assert.equal(f.operations.includes("synthetic:token"), false);
    const response = await f.send(
      `/api/settings/integrations/${id}/oauth/connect`,
      {},
    );
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const connect = await response.json();
    const authorization = new URL(connect.authorizationUrl);
    assert.equal(
      authorization.searchParams.get("client_id"),
      "synthetic-existing-public-client",
    );
    assert.equal(
      authorization.searchParams.get("resource"),
      "https://mcp.slack.com",
    );
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      `${f.base}/api/mcp/oauth/callback`,
    );
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    const params = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "SYNTHETIC_PUBLIC_CODE",
      iss: "https://mcp.slack.com",
    });
    const finished = await f.send(
      `/api/mcp/oauth/callback?${params}`,
      undefined,
      { cookie },
    );
    assert.equal(finished.status, 200);
    assert.doesNotMatch(
      await finished.text(),
      /SYNTHETIC_PUBLIC_CODE|ACCESS_CANARY/,
    );
    const catalog = await (await f.send("/api/settings/integrations")).json();
    assert.equal(catalog.connections[0].oauth.authenticated, true);
    assert.equal(catalog.connections[0].oauth.evidence, "synthetic_transport");
    assert.equal(
      catalog.connections[0].config.endpoint,
      "https://mcp.slack.com/mcp",
    );
    assert.deepEqual(f.tokenBindings, [
      {
        redirectUri: `${f.base}/api/mcp/oauth/callback`,
        clientId: "synthetic-existing-public-client",
        resource: "https://mcp.slack.com",
        challenge: authorization.searchParams.get("code_challenge"),
      },
    ]);
    assert.equal(catalog.connections[0].oauth.identity, null);
    assert.deepEqual(catalog.connections[0].config.allowedTools, []);
    assert.equal(catalog.connections[0].config.enabled, false);
    assert.equal(await readFile(f.source, "utf8"), original);
    assert.equal(
      f.operations.some(
        (operation) =>
          operation.includes("register") || operation.includes("tools/"),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("explicit Slack public PKCE uses the standard SDK with truthful confidential-only metadata through restart and refresh", async () => {
  const tokenOverrides = { expires_in: 10 };
  const f = await oauthFixture({
    clientAuthMethods: ["client_secret_post"],
    tokenOverrides,
  });
  try {
    const original = await readFile(f.source, "utf8");
    const id = await imported(f);
    const prefix = `/api/settings/integrations/${id}/oauth/`;
    const status = await (await f.send(prefix + "discover", {})).json();
    assert.equal(status.discovery.resource, "https://mcp.slack.com");
    assert.deepEqual(status.discovery.clientAuthMethods, [
      "client_secret_post",
      "none",
    ]);
    assert.deepEqual(status.discovery.advertisedClientAuthMethods, [
      "client_secret_post",
    ]);
    assert.equal(status.discovery.publicClientPolicy, "slack-pkce");
    const saved = () =>
      JSON.parse(
        String(
          f.service.db.sqlite
            .prepare("SELECT state_json FROM mcp_oauth WHERE id = ?")
            .get(id)!.state_json,
        ),
      );
    assert.deepEqual(saved().metadata.token_endpoint_auth_methods_supported, [
      "client_secret_post",
    ]);
    const request = {
      clientId: "synthetic-independent-public-client",
      clientAuthMethod: "none",
      scopes: ["search:read.public"],
      discoveryDigest: status.discovery.digest,
      redirectUri: `${f.base}/api/mcp/oauth/callback`,
    };
    for (const body of [
      { ...request, clientSecret: "SYNTHETIC_SECRET_CANARY" },
      {
        ...request,
        clientAuthMethod: "client_secret_basic",
        clientSecret: "SYNTHETIC_SECRET_CANARY",
      },
      { ...request, clientAuthMethod: "private_key_jwt" },
      { ...request, discoveryDigest: "stale" },
      { ...request, resourceMetadataUrl: "https://unapproved.example.com" },
    ]) {
      const denied = await f.send(prefix + "configure", body);
      assert.equal(denied.status, 409);
      assert.doesNotMatch(await denied.text(), /SYNTHETIC_SECRET_CANARY/);
    }
    assert.equal(f.store.values.size, 0);
    assert.equal((await f.send(prefix + "configure", request)).status, 200);
    assert.equal(f.operations.includes("synthetic:token"), false);
    await f.restart();
    assert.deepEqual(f.service.mcpOAuth.status(id).discovery, status.discovery);
    const started = await f.send(prefix + "connect", {});
    const cookie = started.headers.get("set-cookie")!.split(";")[0];
    const authorization = new URL((await started.json()).authorizationUrl);
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.equal(authorization.searchParams.get("client_id"), request.clientId);
    assert.equal(
      authorization.searchParams.get("resource"),
      "https://mcp.slack.com",
    );
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      request.redirectUri,
    );
    const params = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "SYNTHETIC_PUBLIC_CODE",
      iss: "https://mcp.slack.com",
    });
    const callback = () =>
      f.send(`/api/mcp/oauth/callback?${params}`, undefined, { cookie });
    assert.equal((await callback()).status, 200);
    assert.equal((await callback()).status, 409);
    assert.deepEqual(f.tokenBindings[0], {
      redirectUri: request.redirectUri,
      clientId: request.clientId,
      resource: "https://mcp.slack.com",
      challenge: authorization.searchParams.get("code_challenge"),
    });
    await f.restart();
    tokenOverrides.expires_in = 3600;
    await f.service.mcpOAuth.token(
      id,
      f.service.mcpOAuth.status(id).generation,
    );
    assert.deepEqual(f.tokenAuthentication, [
      {
        hasClientSecret: false,
        hasAuthorizationHeader: false,
        hasVerifier: true,
        grantType: "authorization_code",
      },
      {
        hasClientSecret: false,
        hasAuthorizationHeader: false,
        hasVerifier: false,
        grantType: "refresh_token",
      },
    ]);
    assert.deepEqual(saved().metadata.token_endpoint_auth_methods_supported, [
      "client_secret_post",
    ]);
    const catalog = await (await f.send("/api/settings/integrations")).json();
    const connection = catalog.connections[0];
    assert.equal(connection.oauth.authenticated, true);
    assert.equal(connection.oauth.identity, null);
    assert.equal(connection.config.enabled, false);
    assert.deepEqual(connection.config.allowedTools, []);
    assert.doesNotMatch(
      JSON.stringify([catalog, saved()]),
      /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_PUBLIC_CODE/,
    );
    assert.equal(await readFile(f.source, "utf8"), original);
    assert.equal(
      f.operations.some((op) => /tools|initialize|register/.test(op)),
      false,
    );
  } finally {
    await f.close();
  }
});

test("Slack public PKCE does not bypass missing S256, issuer, destination or recognized method metadata", async (t) => {
  for (const metadataOverrides of [
    { code_challenge_methods_supported: ["plain"] },
    { issuer: "https://wrong.example.com" },
    { token_endpoint: "https://wrong.example.com/token" },
    { token_endpoint_auth_methods_supported: [] },
    { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
  ])
    await t.test(Object.keys(metadataOverrides)[0], async () => {
      const f = await oauthFixture({
        clientAuthMethods: ["client_secret_post"],
        metadataOverrides,
      });
      try {
        const id = await imported(f);
        assert.equal(
          (await f.send(`/api/settings/integrations/${id}/oauth/discover`, {}))
            .status,
          409,
        );
        assert.equal(f.service.mcpOAuth.status(id).configured, false);
        assert.equal(f.operations.includes("synthetic:token"), false);
        assert.equal(f.store.values.size, 0);
      } finally {
        await f.close();
      }
    });
});

test("real HTTP OAuth flow keeps native client credentials separate, defaults denied and synthetic evidence truthful", async () => {
  const f = await oauthFixture();
  try {
    const original = await readFile(f.source, "utf8");
    assert.equal((await f.send("/api/state")).status, 200);
    assert.equal(f.operations.length, 0);
    assert.equal(f.store.values.size, 0);
    const id = await imported(f);
    assert.equal(f.operations.length, 0);
    const status = await configured(f, id);
    assert.equal(status.discovery.dynamicRegistration, false);
    const rediscovered = await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: f.source,
    });
    assert.equal(rediscovered.status, 200);
    assert.equal(
      (await (await f.send("/api/settings/integrations")).json()).connections[0]
        .oauth.configured,
      true,
    );
    const deniedRegistration = await f.send(
      `/api/settings/integrations/${id}/oauth/register`,
      {
        consent: "Register a new MCP OAuth client",
        clientAuthMethod: "client_secret_post",
        scopes: ["search:read.public"],
        discoveryDigest: status.discovery.digest,
      },
    );
    assert.equal(deniedRegistration.status, 409);
    const connect = await f.send(
      `/api/settings/integrations/${id}/oauth/connect`,
      {},
    );
    assert.equal(connect.status, 200);
    const cookie = connect.headers.get("set-cookie")!.split(";")[0];
    assert.match(connect.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
    const body = await connect.json();
    const authorization = new URL(body.authorizationUrl);
    assert.equal(
      authorization.searchParams.get("client_id"),
      "synthetic-app-owned-client",
    );
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      `${f.base}/api/mcp/oauth/callback`,
    );
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    const params = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "SYNTHETIC_CODE_CANARY",
      iss: "https://mcp.slack.com",
    });
    const callback = `/api/mcp/oauth/callback?${params}`;
    assert.equal((await f.send(callback)).status, 409);
    const finished = await f.send(callback, undefined, { cookie });
    assert.equal(finished.status, 200);
    assert.equal(finished.headers.get("referrer-policy"), "no-referrer");
    assert.doesNotMatch(await finished.text(), /CANARY/);
    assert.equal((await f.send(callback, undefined, { cookie })).status, 409);
    const catalog = await (await f.send("/api/settings/integrations")).json();
    assert.equal(catalog.connections[0].oauth.authenticated, true);
    assert.equal(catalog.connections[0].oauth.evidence, "synthetic_transport");
    assert.equal(catalog.connections[0].oauth.storage, "synthetic");
    assert.equal(catalog.connections[0].oauth.identity, null);
    assert.equal(catalog.connections[0].effective, "disabled");
    assert.equal(catalog.connections[0].config.enabled, false);
    assert.deepEqual(catalog.connections[0].config.allowedTools, []);
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /SECRET_CANARY|ACCESS_CANARY|REFRESH_CANARY|CODE_CANARY/,
    );
    assert.doesNotMatch(
      JSON.stringify(
        f.service.db.sqlite.prepare("SELECT state_json FROM mcp_oauth").all(),
      ),
      /SECRET_CANARY|ACCESS_CANARY|REFRESH_CANARY|CODE_CANARY/,
    );
    const loaded = await (
      await f.send(`/api/settings/integrations/${id}/load-tools`, {})
    ).json();
    assert.equal(loaded.connections[0].config.inventory.status, "loaded");
    assert.ok(f.requests.includes("https://mcp.slack.com/mcp"));
    assert.equal(f.requests.includes("https://mcp.slack.com/"), false);
    assert.equal(
      loaded.connections[0].config.inventory.scope,
      "synthetic_transport",
    );
    assert.equal(loaded.connections[0].config.inventory.connected, false);
    const enabled = await (
      await f.send(
        `/api/settings/integrations/${id}`,
        { enabled: true, allowedTools: ["synthetic_unvetted_read"] },
        { method: "PATCH" },
      )
    ).json();
    assert.deepEqual(enabled.connections[0].config.allowedTools, []);
    const frozen = integrationSnapshot(enabled);
    assert.deepEqual(frozen.connections[0].allowedTools, []);
    assert.deepEqual(
      await f.service.readProviders.session(frozen, AbortSignal.timeout(1000)),
      [],
    );
    const tested = await (
      await f.send(`/api/settings/integrations/${id}/test`, {})
    ).json();
    assert.equal(tested.scope, "local_configuration");
    assert.equal(tested.status, "needs_compatibility");
    assert.equal(tested.connected, false);
    assert.equal(f.operations.includes("synthetic:tools/call"), false);
    const operations = f.operations.length;
    await f.restart();
    assert.equal(f.operations.length, operations);
    assert.equal(f.service.mcpOAuth.status(id).authenticated, true);
    const disconnected = await f.send(
      `/api/settings/integrations/${id}/oauth/disconnect`,
      {},
    );
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).authenticated, false);
    assert.equal(f.store.values.size, 0);
    assert.equal(
      (
        await f.send("/api/settings/integrations/discover", {
          harness: "claude",
          path: f.source,
        })
      ).status,
      200,
    );
    assert.equal(await readFile(f.source, "utf8"), original);
    assert.deepEqual(frozen.connections[0].allowedTools, []);
  } finally {
    await f.close();
  }
});

test("HTTP CSRF, malformed client setup, locked storage and source drift fail without secrets or token requests", async () => {
  const f = await oauthFixture();
  try {
    const id = await imported(f);
    const denied = await f.send(
      `/api/settings/integrations/${id}/oauth/discover`,
      {},
      { origin: "https://evil.example" },
    );
    assert.equal(denied.status, 403);
    assert.equal(f.operations.length, 0);
    assert.equal(
      (
        await f.send(`/api/settings/integrations/${id}/oauth/discover`, {
          url: "https://unapproved.example",
        })
      ).status,
      409,
    );
    const status = await configured(f, id);
    const malformed = await f.send(
      `/api/settings/integrations/${id}/oauth/configure`,
      {
        clientId: "synthetic-client",
        clientAuthMethod: "client_secret_post",
        clientSecret: 123,
        scopes: ["search:read.public"],
        discoveryDigest: status.discovery.digest,
      },
    );
    assert.equal(malformed.status, 409);
    f.store.unavailable = true;
    const unavailable = await f.send(
      `/api/settings/integrations/${id}/oauth/connect`,
      {},
    );
    assert.equal(unavailable.status, 409);
    assert.equal(
      (await unavailable.json()).code,
      "credential_store_unavailable",
    );
    assert.equal(f.operations.includes("synthetic:token"), false);
    f.store.unavailable = false;
    const connected = await f.send(
      `/api/settings/integrations/${id}/oauth/connect`,
      {},
    );
    const cookie = connected.headers.get("set-cookie")!.split(";")[0];
    const authorization = new URL((await connected.json()).authorizationUrl);
    const changed = structuredClone(f.native);
    changed.mcpServers.slack.oauth.clientId = "changed-native-metadata";
    await writeFile(f.source, JSON.stringify(changed));
    const params = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "SYNTHETIC_CODE_CANARY",
      iss: "https://mcp.slack.com",
    });
    assert.equal(
      (await f.send(`/api/mcp/oauth/callback?${params}`, undefined, { cookie }))
        .status,
      409,
    );
    assert.equal(f.operations.includes("synthetic:token"), false);
    assert.equal(
      (await f.send(`/api/settings/integrations/${id}/oauth/disconnect`, {}))
        .status,
      200,
    );
    assert.equal(f.store.values.size, 0);
  } finally {
    await f.close();
  }
});

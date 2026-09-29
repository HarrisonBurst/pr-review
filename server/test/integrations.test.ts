import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { automationOff } from "../../shared/contracts.js";
import {
  buildIntegrationCatalog,
  defaultIntegrationSettings,
  fingerprintToolSchema,
  ReadOnlyMcpGateway,
} from "../integrations.js";
import { AppDatabase } from "../db.js";

const settings = (integrations = defaultIntegrationSettings()) => ({
  repository: "owner/repo",
  automation: automationOff,
  pollIntervalSeconds: 300,
  maxConcurrentReviews: 1,
  reviewer: {
    skillPath: "/tmp/skill",
    model: null,
    additionalInstructions: "",
  },
  integrations,
});

test("catalog has no automatic or metadata-only legacy entries", () => {
  const catalog = buildIntegrationCatalog(defaultIntegrationSettings(), true);
  assert.deepEqual(catalog.connections, []);
  assert.equal(catalog.boundary.status, "unavailable");
});

const providerSettings = () => ({
  configs: [
    {
      id: "github",
      enabled: true,
      allowedTools: ["pull-request"],
      source: "imported" as const,
      endpoint: "https://api.github.com",
      serverName: null,
      authRef: "gh-login",
      configPath: null,
      readProvider: {
        path: "/fixture/manifest.json",
        digest: "a".repeat(64),
        entryId: "github",
      },
    },
  ],
  importedHarnessAt: null,
});

test("gateway fails closed for unknown tools and writes and passes cancellation", async () => {
  const catalog = buildIntegrationCatalog(providerSettings(), true, true);
  const connection = structuredClone(
    catalog.connections.find((item) => item.definition.id === "github")!,
  );
  connection.status = "ready";
  connection.tools[0]!.state = "allowed";
  connection.definition.tools[0]!.schemaFingerprint = fingerprintToolSchema({
    type: "object",
  });
  let calls = 0;
  const gateway = new ReadOnlyMcpGateway(connection, {
    async listTools() {
      return [
        { name: "github_pull_request_read", inputSchema: { type: "object" } },
        { name: "create_pull_request", inputSchema: { type: "object" } },
        { name: "unknown", inputSchema: { type: "object" } },
      ];
    },
    async callTool(name) {
      calls += 1;
      return { name };
    },
  });
  const listed = await gateway.listTools();
  assert.deepEqual(
    listed.map((item) => item.name),
    ["github_pull_request_read"],
  );
  assert.deepEqual(
    await gateway.call({
      serverIdentity: connection.definition.identity,
      name: "github_pull_request_read",
      arguments: { method: "get" },
    }),
    { name: "github_pull_request_read" },
  );
  await assert.rejects(
    gateway.call({
      serverIdentity: connection.definition.identity,
      name: "create_pull_request",
      arguments: {},
    }),
    /not an enabled vetted read operation/,
  );
  assert.equal(calls, 1);

  const cancelled = new AbortController();
  const cancelling = new ReadOnlyMcpGateway(connection, {
    async listTools() {
      return [
        { name: "github_pull_request_read", inputSchema: { type: "object" } },
      ];
    },
    async callTool(_name, _args, signal) {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        if (signal?.aborted) reject(signal.reason);
      });
      return null;
    },
  });
  await cancelling.listTools();
  const pending = cancelling.call(
    {
      serverIdentity: connection.definition.identity,
      name: "github_pull_request_read",
      arguments: { method: "get" },
    },
    cancelled.signal,
  );
  cancelled.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
});

test("schema fingerprints fail closed when the discovered contract changes", async () => {
  const catalog = buildIntegrationCatalog(providerSettings(), true, true);
  const connection = structuredClone(
    catalog.connections.find((item) => item.definition.id === "github")!,
  );
  connection.status = "ready";
  connection.tools[0]!.state = "allowed";
  const expected = fingerprintToolSchema({ type: "object", properties: {} });
  connection.definition.tools[0]!.schemaFingerprint = expected;
  const gateway = new ReadOnlyMcpGateway(connection, {
    async listTools() {
      return [
        { name: "github_pull_request_read", inputSchema: { type: "changed" } },
      ];
    },
    async callTool() {
      throw new Error("must not call");
    },
  });
  assert.deepEqual(await gateway.listTools(), []);
  await assert.rejects(
    gateway.call({
      serverIdentity: connection.definition.identity,
      name: "github_pull_request_read",
      arguments: { method: "get" },
    }),
    /not an enabled vetted read operation/,
  );
});

test("integration config migration preserves settings without credential material", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pr-review-integrations-"));
  const databasePath = join(dataDir, "app.sqlite");
  const db = await AppDatabase.open(databasePath);
  db.initializeSettings(settings());
  db.updateIntegrations({
    configs: [
      {
        id: "linear",
        enabled: true,
        allowedTools: [],
        source: "imported",
        endpoint: "https://mcp.example.test/linear",
        serverName: "linear",
        authRef: "linear-oauth",
        configPath: "/tmp/harness.json",
      },
    ],
    importedHarnessAt: "2026-01-01T00:00:00.000Z",
  });
  db.close();
  const reopened = await AppDatabase.open(databasePath);
  assert.equal(
    reopened.getSettings().integrations.configs[0]!.authRef,
    "linear-oauth",
  );
  assert.doesNotMatch(
    JSON.stringify(reopened.getSettings().integrations),
    /token|secret|eyJ/i,
  );
  reopened.close();

  await rm(dataDir, { recursive: true, force: true });
});

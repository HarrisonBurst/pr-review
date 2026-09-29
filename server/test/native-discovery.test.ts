import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { oauthFixture } from "./fixtures/oauth-context.js";

test("discovery source errors are actionable, value-free and preserve saved connections", async () => {
  const f = await oauthFixture();
  try {
    await f.service.discoverIntegrations({ harness: "claude", path: f.source });
    const saved = f.service.db.getSettings().integrations;
    for (const [text, message] of [
      ["{SECRET_CANARY", /could not be parsed/],
      ['{"plugins":{"SECRET_CANARY":true}}', /top-level mcpServers/],
      ['{"mcpServers":[]}', /top-level mcpServers/],
    ] as const) {
      await writeFile(f.source, text);
      const response = await f.send("/api/settings/integrations/discover", {
        harness: "claude",
        path: f.source,
      });
      assert.equal(response.status, 409);
      const body = await response.text();
      assert.match(body, message);
      assert.doesNotMatch(body, /SECRET_CANARY/);
      assert.deepEqual(f.service.db.getSettings().integrations, saved);
    }
    const missing = await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: `${f.home}/absent.json`,
    });
    assert.equal(missing.status, 409);
    assert.match(await missing.text(), /file was not found/);
    assert.deepEqual(f.operations, []);
  } finally {
    await f.close();
  }
});

test("unchanged Claude and Codex discovery retains configured records; changed uncredentialed definitions reset only themselves", async () => {
  const f = await oauthFixture();
  try {
    for (const harness of ["claude", "codex"] as const) {
      const source = `${f.home}/${harness}.fixture`;
      const content = (endpoint: string) =>
        harness === "claude"
          ? JSON.stringify({
              mcpServers: {
                documents: {
                  type: "http",
                  url: endpoint,
                  headers: { Authorization: "Bearer SYNTHETIC" },
                },
              },
            })
          : `[mcp_servers.documents]\nurl = "${endpoint}"\nhttp_headers = { Authorization = "Bearer SYNTHETIC" }\n`;
      await writeFile(source, content("https://docs.example.com/mcp"));
      const request = { harness, path: source };
      await f.service.discoverIntegrations(request);
      const config = f.service.db
        .getSettings()
        .integrations.configs.find((c) => c.native?.path === source)!;
      f.service.importNativeIntegration({
        id: config.id,
        profileId: "pr-review-documents/1",
        scope: ["fixture-doc"],
      });
      f.service.updateIntegration(config.id, {
        enabled: true,
        allowedTools: ["search_documents"],
      });
      const saved = f.service.db.getSettings().integrations.configs;
      await f.service.discoverIntegrations(request);
      assert.deepEqual(f.service.db.getSettings().integrations.configs, saved);
      await writeFile(source, content("https://changed.example.com/mcp"));
      await f.service.discoverIntegrations(request);
      const changed = f.service.db
        .getSettings()
        .integrations.configs.find((c) => c.id === config.id)!;
      assert.equal(changed.enabled, false);
      assert.deepEqual(changed.allowedTools, []);
      assert.equal(changed.readProvider, undefined);
      assert.deepEqual(
        f.service.db
          .getSettings()
          .integrations.configs.filter((c) => c.id !== config.id),
        saved.filter((c) => c.id !== config.id),
      );
    }
    assert.deepEqual(f.operations, []);
  } finally {
    await f.close();
  }
});

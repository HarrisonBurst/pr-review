import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  automationOff,
  type HarnessId,
  type HarnessModelDiscovery,
  type HarnessSelectionUpdate,
  type HarnessStatus,
} from "../../shared/contracts.js";
import { loadConfig } from "../config.js";
import { createHttpServer } from "../http.js";
import { discoverHarnessModels } from "../model-discovery.js";
import { ReviewService } from "../service.js";
import {
  modelDiscoveryFiles,
  writeModelDiscoveryFixture,
  writeModelCatalogFixture,
} from "./fixtures/model-discovery.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-model-discovery-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  const marker = path.join(root, "executed");
  for (const name of ["pi", "docker", "fixture-must-not-run"])
    await writeFile(
      path.join(bin, name),
      `#!/bin/sh\nprintf forbidden > '${marker}'\nexit 1\n`,
      { mode: 0o755 },
    );
  const env = { HOME: home, PATH: bin };
  return {
    root,
    home,
    bin,
    env,
    marker,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

for (const harness of ["claude", "codex", "pi"] as const) {
  test(`${harness} discovery separates genuine catalogs from configured and retained custom IDs`, async () => {
    const f = await fixture();
    try {
      await writeModelDiscoveryFixture(f.home);
      await writeModelCatalogFixture(f.bin);
      const result = await discoverHarnessModels(
        harness,
        [
          { id: "main", harness, model: null },
          { id: "reviewer-1", harness, model: "fixture-saved-custom" },
          { id: "reviewer-2", harness, model: "fixture-saved-custom" },
          {
            id: "other",
            harness: harness === "claude" ? "pi" : "claude",
            model: "different-harness",
          },
        ],
        f.env,
      );
      assert.equal(result.status, "ready");
      assert.equal(result.availability, "not_checked");
      assert.ok(Date.parse(result.checkedAt));
      assert.equal(
        result.models.filter((m) => m.model === "fixture-saved-custom").length,
        1,
      );
      assert.ok(!result.models.some((m) => m.model === "different-harness"));
      assert.equal(
        result.sources.find((s) => s.id === "native-catalog")?.status,
        harness === "pi" ? "unsupported" : "ready",
      );
      if (harness !== "pi") {
        assert.deepEqual(
          result.models.find(
            (m) => m.model === `fixture-${harness}-catalog-only`,
          )?.sources,
          ["native-catalog"],
        );
        assert.deepEqual(
          result.models.find((m) => m.model === "fixture-saved-custom")
            ?.sources,
          ["saved-selection"],
        );
        if (harness === "codex")
          assert.ok(
            result.models.some((m) => m.model === "fixture-codex-page-two"),
          );
      }
      assert.doesNotMatch(
        JSON.stringify(result),
        /fixture-secret|fixture-must|not-an-account-catalog/,
      );
      if (harness === "pi") {
        assert.deepEqual(
          result.models.find(
            (m) => m.model === "openai-codex/fixture-pi-native",
          ),
          {
            model: "openai-codex/fixture-pi-native",
            label: "Fixture Pi Native",
            sources: ["native-settings", "pi-models-store"],
          },
        );
        assert.equal(
          result.models.find((m) => m.model === "fixture-provider/custom-v1")
            ?.label,
          "Fixture Custom Model",
        );
        const source = result.sources.find((s) => s.id === "pi-models-store")!;
        assert.equal(source.kind, "cached_catalog");
        assert.equal(source.freshness, "unknown");
        assert.ok(source.modifiedAt);
      }
      for (const [name, content] of Object.entries(modelDiscoveryFiles))
        assert.equal(await readFile(path.join(f.home, name), "utf8"), content);
      await assert.rejects(stat(f.marker), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });

  test(`${harness} absent and malformed sources do not manufacture models or hide failure`, async () => {
    const f = await fixture();
    try {
      const absent = await discoverHarnessModels(harness, [], f.env);
      assert.equal(absent.status, "unsupported");
      assert.deepEqual(absent.models, []);
      assert.equal(absent.sources[0].status, "missing");
      const filename =
        harness === "claude"
          ? ".claude/settings.json"
          : harness === "codex"
            ? ".codex/config.toml"
            : ".pi/agent/settings.json";
      const file = path.join(f.home, filename);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "malformed fixture-secret-never-return");
      const failed = await discoverHarnessModels(harness, [], f.env);
      assert.equal(failed.status, "error");
      assert.deepEqual(failed.models, []);
      assert.doesNotMatch(
        JSON.stringify(failed),
        /fixture-secret-never-return/,
      );
      const retained = await discoverHarnessModels(
        harness,
        [{ id: "main", harness, model: "custom-still-valid" }],
        f.env,
      );
      assert.equal(retained.status, "partial");
      assert.equal(retained.models[0].model, "custom-still-valid");
    } finally {
      await f.close();
    }
  });
}

test("bounded malformed catalogs fail visibly; unsupported IDs and labels cannot expand validation", async (t) => {
  const f = await fixture();
  try {
    const directory = path.join(f.home, ".pi/agent");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "models-store.json");
    for (const [name, data] of [
      ["oversized", " ".repeat(5_000_001)],
      ["invalid UTF-8", Buffer.from([0xff])],
      ["array root", "[]"],
      [
        "wrong provider",
        JSON.stringify({ p: { models: [{ provider: "q", id: "m" }] } }),
      ],
      ["missing models", '{"p":{}}'],
      ["wrong model type", '{"p":{"models":[null]}}'],
      [
        "too many models",
        JSON.stringify({
          p: {
            models: Array.from({ length: 2001 }, () => ({
              provider: "p",
              id: "m",
            })),
          },
        }),
      ],
      [
        "too many providers",
        JSON.stringify(
          Object.fromEntries(
            Array.from({ length: 101 }, (_, i) => [`p${i}`, { models: [] }]),
          ),
        ),
      ],
    ] as const)
      await t.test(name, async () => {
        await writeFile(file, data);
        const result = await discoverHarnessModels("pi", [], f.env);
        assert.equal(result.status, "error");
        assert.deepEqual(result.models, []);
        assert.equal(
          result.sources.find((s) => s.id === "pi-models-store")?.status,
          "error",
        );
      });
    await writeFile(
      file,
      JSON.stringify({
        p: {
          models: [
            { provider: "p", id: "valid", name: "\u001b[31munsafe" },
            { provider: "p", id: "also-valid", name: "x".repeat(201) },
            { provider: "p", id: "invalid[1m]" },
            { provider: "p", id: "x".repeat(201) },
          ],
        },
      }),
    );
    const partial = await discoverHarnessModels("pi", [], f.env);
    assert.equal(partial.status, "partial");
    assert.deepEqual(
      partial.models.map((m) => m.label),
      ["p/also-valid", "p/valid"],
    );
    assert.match(
      partial.sources.find((s) => s.id === "pi-models-store")!.message,
      /2 identifiers omitted/,
    );
  } finally {
    await f.close();
  }
});

test("only fixed trusted global files are read; no project paths, modules or credential links", async () => {
  const f = await fixture();
  try {
    const root = path.join(f.home, "explicit-config");
    await mkdir(root);
    const target = path.join(f.home, "managed-settings.json");
    await writeFile(target, '{"model":"managed-model"}');
    const settings = path.join(root, "settings.json");
    await symlink(target, settings);
    const env = { ...f.env, CLAUDE_CONFIG_DIR: root };
    const before = await stat(target);
    assert.equal(
      (await discoverHarnessModels("claude", [], env)).models[0].model,
      "managed-model",
    );
    assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
    assert.equal((await stat(target)).mode, before.mode);
    await rm(settings);
    await writeFile(
      path.join(root, "auth.json"),
      '{"model":"credential-must-not-return"}',
    );
    await symlink(path.join(root, "auth.json"), settings);
    const denied = await discoverHarnessModels("claude", [], env);
    assert.equal(denied.status, "error");
    assert.doesNotMatch(JSON.stringify(denied), /credential-must-not-return/);
    await rm(settings);
    await mkdir(settings);
    assert.equal(
      (await discoverHarnessModels("claude", [], env)).status,
      "error",
    );
    assert.equal(
      (
        await discoverHarnessModels("claude", [], {
          ...env,
          CLAUDE_CONFIG_DIR: "relative-pr-config",
        })
      ).status,
      "error",
    );
    await assert.rejects(stat(f.marker), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("HTTP explicit discovery is read-only across GET/SSE, refresh, native defaults, repeated harness entries and custom saves", async () => {
  const f = await fixture();
  const skillPath = path.join(f.home, "fixture-review/ENTRY.md");
  await mkdir(path.dirname(skillPath));
  await writeFile(
    skillPath,
    "# Deterministic fixture review\nReview the supplied fixture only.",
  );
  const config = loadConfig({
    demo: true,
    dataDir: path.join(f.root, "data"),
    databasePath: path.join(f.root, "app.sqlite"),
    reviewer: { skillPath, model: null, additionalInstructions: "" },
  });
  const service = await ReviewService.create(
    config,
    undefined,
    undefined,
    undefined,
    f.env,
  );
  const server = createHttpServer(service, config);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api`;
  const request = (route: string, body: unknown, method = "POST") =>
    fetch(base + route, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const discover = async (harness: HarnessId) => {
    const response = await request("/settings/models/discover", { harness });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return (await response.json()) as HarnessModelDiscovery;
  };
  let events = 0;
  const unsubscribe = service.onChange(() => events++);
  try {
    const before = service.db.getSettings();
    for (const route of ["/state", "/settings/harness", "/settings/execution"])
      assert.equal((await fetch(base + route)).status, 200);
    const abort = new AbortController();
    const stream = await fetch(base + "/events", { signal: abort.signal });
    assert.equal(stream.status, 200);
    abort.abort();
    assert.equal((await fetch(base + "/settings/models/discover")).status, 404);
    assert.equal((await discover("pi")).status, "unsupported");
    await writeModelDiscoveryFixture(f.home);
    await writeModelCatalogFixture(f.bin);
    for (const harness of ["claude", "codex", "pi"] as const)
      assert.equal((await discover(harness)).status, "ready");
    for (const body of [
      {},
      { harness: "unknown" },
      { harness: ["codex"] },
      { harness: { toString: "codex" } },
      { harness: "codex", path: skillPath },
      { harness: "pi", model: "other" },
      { harness: "claude", workflow: "dangerous" },
      { harness: "codex", command: "fixture-must-not-run" },
    ]) {
      const response = await request("/settings/models/discover", body);
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { code: string }).code,
        "invalid_model_discovery",
      );
    }
    assert.equal((await request("/settings/models/discover", [])).status, 400);
    assert.equal(
      (
        await request("/settings/models/discover", {
          harness: "x".repeat(1_000_001),
        })
      ).status,
      413,
    );
    const origin = await fetch(base + "/settings/models/discover", {
      method: "POST",
      headers: { Origin: "https://untrusted.invalid" },
      body: '{"harness":"codex"}',
    });
    assert.equal(origin.status, 403);
    assert.deepEqual(service.db.getSettings(), before);
    assert.equal(events, 0);
    assert.deepEqual(service.getState().settings.automation, automationOff);
    const selection: HarnessSelectionUpdate = {
      version: 3,
      workflow: "separated",
      harness: "codex",
      reviewer: { skillPath, model: null },
      additional: [
        { id: "reviewer-1", harness: "codex", model: "fixture-custom-one" },
        { id: "reviewer-2", harness: "codex", model: "fixture-custom-two" },
      ],
    };
    const savedResponse = await request(
      "/settings/harness",
      selection,
      "PATCH",
    );
    assert.equal(savedResponse.status, 200);
    const saved = (await savedResponse.json()) as HarnessStatus;
    assert.equal(saved.selection?.reviewer.model, "fixture-codex-native");
    assert.deepEqual(
      saved.selection?.version === 3 && saved.selection.additional,
      selection.additional,
    );
    const savedState = service.db.getSettings();
    const afterSaveEvents = events;
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'model="fixture-new-native"',
    );
    const refreshed = await discover("codex");
    for (const model of [
      "fixture-new-native",
      "fixture-codex-native",
      "fixture-custom-one",
      "fixture-custom-two",
    ])
      assert.ok(refreshed.models.some((m) => m.model === model));
    assert.deepEqual(service.db.getSettings(), savedState);
    assert.equal(events, afterSaveEvents);
    assert.deepEqual(
      await (await fetch(base + "/settings/harness")).json(),
      saved,
    );
    await writeFile(path.join(f.home, ".codex/config.toml"), "malformed");
    const failedRefresh = await discover("codex");
    assert.equal(failedRefresh.status, "partial");
    assert.ok(
      !failedRefresh.models.some((m) => m.model === "fixture-new-native"),
    );
    assert.ok(
      failedRefresh.models.some((m) => m.model === "fixture-custom-one"),
    );
    assert.deepEqual(service.db.getSettings(), savedState);
    const incompatible = await request(
      "/settings/harness",
      {
        ...selection,
        harness: "pi",
        reviewer: { skillPath, model: "fixture-provider/custom-v1" },
      },
      "PATCH",
    );
    assert.equal(incompatible.status, 409);
    assert.deepEqual(service.db.getSettings(), savedState);
    for (const workflow of ["docker", "dangerous"] as const) {
      const extra = await request("/settings/models/discover", {
        harness: "codex",
        workflow,
      });
      assert.equal(extra.status, 400);
    }
    const unconfirmed = await request(
      "/settings/harness",
      {
        version: 2,
        workflow: "dangerous",
        harness: "codex",
        reviewer: { skillPath, model: "fixture-custom-one" },
      },
      "PATCH",
    );
    assert.equal(unconfirmed.status, 400);
    assert.deepEqual(service.db.getSettings(), savedState);
    const invalidSave = await request(
      "/settings/harness",
      { ...selection, reviewer: { skillPath, model: "invalid[1m]" } },
      "PATCH",
    );
    assert.equal(invalidSave.status, 400);
    await assert.rejects(stat(f.marker), { code: "ENOENT" });
  } finally {
    unsubscribe();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await f.close();
  }
});

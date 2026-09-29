import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverHarnessModels } from "../model-discovery.js";
import {
  writeModelCatalogFixture,
  writeModelDiscoveryFixture,
} from "./fixtures/model-discovery.js";

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "pr-review-catalog-test-"));
  const bin = path.join(home, "bin");
  await writeModelDiscoveryFixture(home);
  await writeModelCatalogFixture(bin);
  return {
    home,
    bin,
    env: {
      HOME: home,
      PATH: bin,
      ANTHROPIC_API_KEY: "fixture-secret",
      OPENAI_API_KEY: "fixture-secret",
      AWS_PROFILE: "fixture-secret",
    },
  };
}

for (const harness of ["claude", "codex"] as const) {
  test(`${harness} metadata failures retain selections without representing them as catalogs`, async () => {
    const f = await fixture();
    try {
      for (const mode of [
        "malformed",
        "exit",
        "oversized",
        ...(harness === "codex" ? ["cycle"] : []),
      ]) {
        await writeFile(path.join(f.bin, `${harness}.mode`), mode);
        const result = await discoverHarnessModels(
          harness,
          [{ id: "main", harness, model: "saved-custom" }],
          f.env,
        );
        assert.equal(result.status, "partial", mode);
        assert.equal(
          result.sources.find((s) => s.id === "native-catalog")?.status,
          "error",
          mode,
        );
        assert.ok(result.models.some((m) => m.model === "saved-custom"));
        assert.ok(
          result.models.every((m) => !m.sources.includes("native-catalog")),
        );
        assert.doesNotMatch(JSON.stringify(result), /fixture-secret|invalid\n/);
      }
    } finally {
      await rm(f.home, { recursive: true, force: true });
    }
  });

  test(`${harness} alternate providers never acquire a first-party fallback`, async () => {
    const f = await fixture();
    try {
      await writeFile(
        path.join(f.bin, harness),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(f.home, "executed"))}, 'bad'); process.exit(1);\n`,
      );
      const file = path.join(
        f.home,
        harness === "claude" ? ".claude/settings.json" : ".codex/config.toml",
      );
      for (const config of harness === "claude"
        ? [
            JSON.stringify({
              model: "custom",
              env: { ANTHROPIC_BASE_URL: "https://fixture.invalid" },
            }),
            JSON.stringify({
              model: "custom",
              env: { CLAUDE_CODE_USE_BEDROCK: "1" },
            }),
          ]
        : [
            'model="custom"\nmodel_provider="other"',
            'model="custom"\nprofile="other"',
            'model="custom"\nmodel_catalog_json="/ignored/catalog.json"',
          ]) {
        await writeFile(file, config);
        const result = await discoverHarnessModels(harness, [], f.env);
        assert.equal(result.status, "partial");
        assert.equal(
          result.sources.find((s) => s.id === "native-catalog")?.status,
          "unsupported",
        );
        assert.deepEqual(
          result.models.map((m) => m.model),
          ["custom"],
        );
        await assert.rejects(readFile(path.join(f.home, "executed")), {
          code: "ENOENT",
        });
        assert.equal(await readFile(file, "utf8"), config);
      }
    } finally {
      await rm(f.home, { recursive: true, force: true });
    }
  });
}

test("metadata timeout is bounded and retains the configured ID", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.bin, "claude.mode"), "hang");
    const result = await discoverHarnessModels("claude", [], f.env);
    assert.equal(result.status, "partial");
    assert.equal(
      result.sources.find((s) => s.id === "native-catalog")?.status,
      "error",
    );
    assert.deepEqual(
      result.models.map((m) => m.model),
      ["fixture-claude-custom"],
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

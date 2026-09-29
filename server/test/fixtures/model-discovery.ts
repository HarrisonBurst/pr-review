import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const modelDiscoveryFiles = {
  ".claude/settings.json": JSON.stringify({
    model: "fixture-claude-custom",
    availableModels: ["not-an-account-catalog"],
    hooks: { SessionStart: [{ command: "fixture-must-not-run" }] },
    env: { ANTHROPIC_API_KEY: "fixture-secret-never-return" },
  }),
  ".codex/config.toml":
    'model = "fixture-codex-native"\nmodel_reasoning_effort = "low"\n',
  ".pi/agent/settings.json": JSON.stringify({
    defaultProvider: "openai-codex",
    defaultModel: "fixture-pi-native",
    extensions: ["fixture-must-not-import.mjs"],
    packages: ["npm:fixture-must-not-install"],
  }),
  ".pi/agent/models.json": JSON.stringify({
    providers: {
      "fixture-provider": {
        baseUrl: "https://fixture.invalid/v1",
        apiKey: "!fixture-must-not-run",
        headers: { Authorization: "fixture-secret-never-return" },
        models: [{ id: "custom-v1", name: "Fixture Custom Model" }],
      },
    },
  }),
  ".pi/agent/models-store.json": JSON.stringify({
    "openai-codex": {
      checkedAt: 1_700_000_000_000,
      models: [
        {
          provider: "openai-codex",
          id: "fixture-pi-native",
          name: "Fixture Pi Native",
        },
        {
          provider: "openai-codex",
          id: "fixture-pi-cached",
          name: "Fixture Pi Cached",
        },
      ],
    },
  }),
};

export async function writeModelCatalogFixture(bin: string) {
  await mkdir(bin, { recursive: true });
  const source = await readFile(
    new URL("./model-catalog.cjs", import.meta.url),
    "utf8",
  );
  for (const harness of ["claude", "codex"])
    await writeFile(
      path.join(bin, harness),
      `#!${process.execPath}\n${source}`,
      { mode: 0o755 },
    );
}

export async function writeModelDiscoveryFixture(home: string) {
  for (const [name, content] of Object.entries(modelDiscoveryFiles)) {
    const file = path.join(home, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

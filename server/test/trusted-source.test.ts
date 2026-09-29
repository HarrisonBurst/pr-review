import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  automationOff,
  dockerApprovalConfirmation,
  dockerSetupConfirmation,
  type DockerCapabilityDisclosure,
} from "../../shared/contracts.js";
import { loadConfig } from "../config.js";
import { createHttpServer } from "../http.js";
import { ReviewService } from "../service.js";
import { loadSkill, materializeSkill } from "../execution/skill.js";
import { projectFiles } from "../execution/projection.js";
import { captureDockerCapabilities } from "../execution/docker-capabilities.js";
import { managedConfiguration } from "../execution/managed.js";
import { loadWorkflow } from "../execution/config.js";
import { nixSourceFixture } from "./fixtures/nix-source.js";

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "pr-review-nix-source-")),
  );
  const source = await nixSourceFixture(root);
  const env = { HOME: source.home, PATH: "/usr/bin:/bin" };
  const app = loadConfig({
    demo: true,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data/app.sqlite"),
    reviewer: {
      skillPath: source.skillPath,
      model: null,
      additionalInstructions: "",
    },
  });
  return {
    ...source,
    root,
    env,
    app,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function approval(disclosure: DockerCapabilityDisclosure) {
  return {
    digest: disclosure.digest,
    confirmation: dockerApprovalConfirmation,
    customizations: disclosure.customizations.map((item) => item.id),
    credentialExposures: disclosure.authentication.map((item) => item.harness),
  };
}

test("selected multi-hop entry captures logical companions and source identity, never store parents or backups", async () => {
  const f = await fixture();
  try {
    await chmod(f.terminal, 0o755);
    const skill = await loadSkill(f.skillPath);
    assert.equal(skill.path, f.skillPath);
    assert.equal(skill.directory, "pr-review");
    assert.deepEqual(
      skill.files.map((file) => file.target),
      ["resources/pr-review/SKILL.md", "resources/pr-review/rubric.md"],
    );
    const entry = skill.files[0];
    assert.equal(entry.sourcePath, f.skillPath);
    assert.equal(entry.resolvedSourcePath, f.terminal);
    assert.equal(entry.executable, true);
    assert.match(entry.sourceDigest!, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(skill),
      /UNRELATED_STORE_CREDENTIAL_CANARY|stale-generation/,
    );
    assert.equal((await loadSkill(f.skillPath)).digest, skill.digest);
    await rm(f.middle);
    await symlink(path.relative(path.dirname(f.middle), f.terminal), f.middle);
    const relative = await loadSkill(f.skillPath);
    assert.equal(
      relative.files[0].resolvedSourcePath,
      skill.files[0].resolvedSourcePath,
    );
    assert.notEqual(relative.digest, skill.digest);
    const other = path.join(f.store, "dddddddd-hm_SKILL.md");
    await writeFile(other, f.content, { mode: 0o755 });
    await rm(f.middle);
    await symlink(other, f.middle);
    assert.notEqual((await loadSkill(f.skillPath)).digest, skill.digest);
    await writeFile(other, "changed source bytes");
    const entryPath = await materializeSkill(
      skill,
      path.join(f.root, "materialized"),
    );
    assert.equal(
      entryPath,
      path.join(f.root, "materialized/resources/pr-review/SKILL.md"),
    );
    assert.equal(await readFile(entryPath, "utf8"), f.content);
    assert.equal(
      await readFile(path.join(path.dirname(entryPath), "rubric.md"), "utf8"),
      "FROZEN RUBRIC",
    );
    await assert.rejects(
      projectFiles([{ path: f.skillPath, target: "resources/entry.md" }]),
      /symlinks/,
    );
    await assert.rejects(
      loadSkill("/nix/store/fixture.md"),
      /logical skill entry/,
    );
  } finally {
    await f.close();
  }
});

test("trusted entry rejects credential targets and intermediates, cycles, dangling links, directories and special files", async () => {
  const f = await fixture();
  const socket = createServer();
  try {
    for (const name of [
      "auth.json",
      ".credentials.json",
      ".env",
      ".env.local",
      "id_rsa",
      "id_ed25519",
      ".npmrc",
    ]) {
      const secret = path.join(f.root, name);
      await writeFile(secret, "CREDENTIAL_CANARY");
      await rm(f.middle);
      await symlink(secret, f.middle);
      await assert.rejects(loadSkill(f.skillPath), /Credential stores/);
      await rm(secret);
      await symlink(f.terminal, secret);
      await assert.rejects(loadSkill(f.skillPath), /Credential stores/);
    }
    await rm(f.middle);
    await symlink(f.skillPath, f.middle);
    await assert.rejects(loadSkill(f.skillPath), /cycle/);
    await rm(f.middle);
    for (let i = 0; i < 41; i++)
      await symlink(
        i === 40 ? f.terminal : path.join(f.store, `hop-${i + 1}`),
        path.join(f.store, `hop-${i}`),
      );
    await symlink(path.join(f.store, "hop-0"), f.middle);
    await assert.rejects(loadSkill(f.skillPath), /40 links/);
    await rm(f.middle);
    await symlink(path.join(f.root, "missing"), f.middle);
    await assert.rejects(loadSkill(f.skillPath), /ENOENT/);
    for (const directory of [f.store, "/", ".", ".."]) {
      await rm(f.middle);
      await symlink(directory, f.middle);
      await assert.rejects(loadSkill(f.skillPath), /regular file/);
    }
    const special = path.join(f.root, "socket");
    await new Promise<void>((resolve) => socket.listen(special, resolve));
    await rm(f.middle);
    await symlink(special, f.middle);
    await assert.rejects(loadSkill(f.skillPath), /regular file/);
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    await f.close();
  }
});

test("trusted capture rejects a source changed between resolution and file open", async (t) => {
  const f = await fixture();
  const original = fs.open;
  try {
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[0] === f.terminal)
        await writeFile(f.terminal, "changed during capture");
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(loadSkill(f.skillPath), /changed during capture/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("portable companions stay fail-closed with source and target bounds", async () => {
  const f = await fixture();
  try {
    const parent = path.dirname(f.skillPath);
    const link = path.join(parent, "arbitrary.md");
    await symlink(f.terminal, link);
    await assert.rejects(loadSkill(f.skillPath), /symlinks/);
    await rm(link);
    await symlink(f.store, path.join(parent, "outside"));
    await assert.rejects(loadSkill(f.skillPath), /symlinks/);
    await rm(path.join(parent, "outside"));
    for (const reference of [
      "../outside.md",
      "SKILL.md.symlink-backup",
      "SKILL.md.nix-backup",
    ]) {
      await writeFile(f.terminal, `[missing](${reference})`);
      await assert.rejects(loadSkill(f.skillPath), /missing or outside/);
    }
    await writeFile(f.terminal, "x".repeat(2000001));
    await assert.rejects(loadSkill(f.skillPath), /2 MB/);
    await writeFile(f.terminal, "\u0000");
    await assert.rejects(loadSkill(f.skillPath), /UTF-8/);
    await writeFile(f.terminal, f.content);
    await Promise.all(
      Array.from({ length: 2000 }, (_, i) =>
        writeFile(path.join(parent, `file-${i}`), ""),
      ),
    );
    await assert.rejects(loadSkill(f.skillPath), /2000 entries/);
    await assert.rejects(
      projectFiles([{ path: f.terminal, target: "resources/../escape" }]),
      /unique explicit/,
    );
    await assert.rejects(
      projectFiles([
        { path: f.terminal, target: "resources/entry" },
        { path: f.terminal, target: "resources/entry" },
      ]),
      /unique explicit/,
    );
  } finally {
    await f.close();
  }
});

test("real HTTP Save and Inspect preserve selected native aliases, freeze bytes and invalidate consent on source drift", async () => {
  const f = await fixture();
  const service = await ReviewService.create(
    f.app,
    undefined,
    undefined,
    undefined,
    f.env,
  );
  const server = createHttpServer(service, f.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = (route: string, body: unknown, method = "POST") =>
    fetch(base + route, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const selection = {
    version: 2,
    harness: "claude",
    workflow: "docker",
    reviewer: { skillPath: f.skillPath, model: null },
  };
  try {
    assert.equal(
      (await send("/settings/harness", selection, "PATCH")).status,
      200,
    );
    const saved = service.db.getSettings();
    assert.equal(saved.harness!.selection!.reviewer?.model, "claude-fable-5");
    assert.deepEqual(saved.automation, automationOff);
    const unauthorizedScope = await send("/settings/execution/inspect", {
      harness: "claude",
      libraryLeaves: [
        {
          source: f.skillPath,
          resolvedSourcePath: f.terminal,
          sourceDigest: "0".repeat(64),
        },
      ],
    });
    assert.equal(unauthorizedScope.status, 400);
    assert.equal(
      (await unauthorizedScope.json()).code,
      "invalid_docker_inspection",
    );
    const response = await send("/settings/execution/inspect", {
      harness: "claude",
    });
    assert.equal(response.status, 200, await response.clone().text());
    const disclosure = (await response.json()) as DockerCapabilityDisclosure;
    for (const target of [
      "resources/pr-review/SKILL.md",
      ".claude/skills/pr-review/SKILL.md",
    ]) {
      const file = disclosure.resources.find((item) => item.target === target)!;
      assert.equal(file.source, f.skillPath);
      assert.equal(file.resolvedSourcePath, f.terminal);
      assert.match(file.sourceDigest!, /^[a-f0-9]{64}$/);
    }
    assert.equal(
      disclosure.resources.find(
        (item) => item.target === ".claude/settings.json",
      )!.resolvedSourcePath,
      f.settingsTerminal,
    );
    assert.doesNotMatch(
      JSON.stringify(disclosure),
      /CANARY|symlink-backup|nix-backup/,
    );
    assert.deepEqual(disclosure.localConnections, []);
    assert.equal(
      disclosure.authentication.every((item) => item.tested === false),
      true,
    );
    const config = await managedConfiguration(
      f.app,
      "claude",
      path.join(f.root, "bundle"),
      f.env,
    );
    await mkdir(config.bundle);
    await writeFile(
      path.join(config.bundle, "fixture"),
      "INERT RUNTIME IDENTITY ONLY",
    );
    const captured = await captureDockerCapabilities(f.app, config, f.env);
    const workflow = path.join(f.root, "workflow.json");
    await writeFile(
      workflow,
      JSON.stringify({
        ...captured.config,
        docker: {
          profile: "container-native-1",
          disclosure: captured.disclosure,
          approval: approval(captured.disclosure),
        },
      }),
    );
    const changed = path.join(f.store, "dddddddd-identical-entry.md");
    await writeFile(changed, f.content);
    await rm(f.middle);
    await symlink(changed, f.middle);
    const refused = await send("/settings/execution/inspect", {
      harness: "claude",
    });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /changed since Save/);
    assert.equal(
      (
        await send("/settings/execution/setup", {
          harness: "claude",
          confirmation: dockerSetupConfirmation,
          approval: approval(disclosure),
        })
      ).status,
      409,
    );
    const loaded = await loadWorkflow(workflow, f.skillPath, true);
    assert.equal(loaded.skill, f.content);
    assert.equal(
      loaded.files.find(
        (item) => item.target === "resources/pr-review/SKILL.md",
      )!.resolvedSourcePath,
      f.terminal,
    );
    assert.equal(
      (await send("/settings/harness", selection, "PATCH")).status,
      200,
    );
    const refreshed = await send("/settings/execution/inspect", {
      harness: "claude",
    });
    assert.equal(refreshed.status, 200);
    const next = (await refreshed.json()) as DockerCapabilityDisclosure;
    assert.notEqual(next.digest, disclosure.digest);
    await writeFile(
      f.settingsTerminal,
      JSON.stringify({ model: "claude-fable-5", effortLevel: "high" }),
    );
    const refusedSetup = await send("/settings/execution/setup", {
      harness: "claude",
      confirmation: dockerSetupConfirmation,
      approval: approval(next),
    });
    assert.equal(refusedSetup.status, 409);
    assert.match(await refusedSetup.text(), /approval is missing or changed/);
    await writeFile(
      f.settingsTerminal,
      JSON.stringify({
        model: "claude-fable-5",
        enabledPlugins: { "synthetic-plugin": true },
      }),
    );
    const plugin = await send("/settings/execution/inspect", {
      harness: "claude",
    });
    assert.equal(plugin.status, 409);
    assert.match(await plugin.text(), /enabledPlugins.*not supported/);
    assert.deepEqual(service.db.getSettings().automation, automationOff);
    assert.equal(service.db.getSettings().integrations.configs.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await f.close();
  }
});

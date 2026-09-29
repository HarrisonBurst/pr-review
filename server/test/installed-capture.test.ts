import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
  copyFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DockerSourceHandling } from "../../shared/contracts.js";
import { dockerApprovalConfirmation } from "../../shared/contracts.js";
import { projectFiles } from "../execution/projection.js";
import { resolveTrustedSource } from "../execution/trusted-source.js";
import {
  dockerExclusions,
  selectDockerExclusions,
} from "../execution/docker-exclusions.js";
import {
  inspectDockerCapabilities,
  requireDockerApproval,
} from "../execution/docker-capabilities.js";
import { loadConfig } from "../config.js";
import { DockerExecutor } from "../execution/executor.js";
import { reviewSchema } from "../review-output.js";
import { resourceBytes } from "../execution/harness.mjs";
import { loadWorkflow } from "../execution/config.js";
import { loadSkill, materializeSkill } from "../execution/skill.js";
import { digest } from "../execution/policy.js";
import { woff2Fixture } from "./fixtures/woff2.js";
import { pngFixture } from "./fixtures/png.js";
import { writeGoogleWorkspaceFixture } from "./fixtures/google-workspace.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-installed-"));
  const home = path.join(root, "home");
  for (const directory of [
    ".claude/skills/morning/assets/fonts",
    ".agents/skills/slack-axi",
    ".codex",
    "review",
  ])
    await mkdir(path.join(home, directory), { recursive: true });
  const font = path.join(
    home,
    ".claude/skills/morning/assets/fonts/fixture.woff2",
  );
  await writeFile(font, woff2Fixture());
  const image = path.join(home, ".claude/skills/morning/assets/fixture.png");
  await writeFile(image, pngFixture());
  await writeFile(
    path.join(home, ".claude/skills/morning/SKILL.md"),
    "Synthetic font companion fixture, not a renderable font test.\n",
  );
  const settings = path.join(home, ".claude/settings.json");
  const value = {
    model: "claude-fable-5-1",
    effortLevel: "medium",
    theme: "dark",
    tui: "fullscreen",
    hooks: {
      SessionStart: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `bash '${home}/.claude/hooks/herdr-agent-state.sh' session`,
              timeout: 10,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: "command",
      command: "node /host/presentation-only.mjs",
    },
  };
  await writeFile(settings, JSON.stringify(value));
  await writeFile(path.join(home, ".claude/CLAUDE.md"), "@AGENTS.md\n");
  await writeFile(
    path.join(home, ".claude/AGENTS.md"),
    "Trusted instruction closure.\n",
  );
  await writeFile(
    path.join(home, ".agents/skills/slack-axi/SKILL.md"),
    "Synthetic instruction only. No slack-axi binary is provided.\n",
  );
  await symlink(
    path.join(home, ".agents/skills/slack-axi"),
    path.join(home, ".claude/skills/slack-axi"),
  );
  await writeFile(
    path.join(home, ".claude/skills/.DS_Store"),
    Buffer.from([0, 1, 255, 2]),
  );
  await writeFile(
    path.join(home, "review/SKILL.md"),
    "---\nname: fixture-review\ndescription: Deterministic installed compatibility fixture\n---\nRead source only.\n",
  );
  const app = loadConfig({
    demo: true,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data/db"),
    reviewer: {
      skillPath: path.join(home, "review/SKILL.md"),
      model: "claude-fable-5-1",
      additionalInstructions: "",
    },
  });
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  return {
    root,
    home,
    settings,
    font,
    image,
    value,
    app,
    env,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("Docker preserves trusted imports/library and requires exact UI-only exclusions", async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.settings, "utf8");
    const candidates = await dockerExclusions(f.home);
    assert.deepEqual(
      candidates.map((item) => item.kind),
      ["status-line", "herdr-session-start"],
    );
    await assert.rejects(
      inspectDockerCapabilities(f.app, "claude", f.env),
      /statusLine/,
    );
    const inspected = await inspectDockerCapabilities(
      f.app,
      "claude",
      f.env,
      [],
      [],
      candidates.map((item) => item.id),
    );
    const files = inspected.config.frozen!.files;
    const projected = JSON.parse(
      files.find((file) => file.target === ".claude/settings.json")!.content,
    );
    assert.deepEqual(projected, {
      model: f.value.model,
      effortLevel: "medium",
    });
    assert.equal(
      files.some((file) => file.target.endsWith(".DS_Store")),
      false,
    );
    assert.match(
      files.find((file) => file.target === ".claude/AGENTS.md")!.content,
      /Trusted instruction closure/,
    );
    const slack = files.find(
      (file) => file.target === ".claude/skills/slack-axi/SKILL.md",
    )!;
    assert.equal(
      slack.resolvedSourcePath,
      await realpath(path.join(f.home, ".agents/skills/slack-axi/SKILL.md")),
    );
    assert.match(slack.content, /No slack-axi binary/);
    assert.deepEqual(inspected.disclosure.customizations, []);
    assert.equal(
      inspected.disclosure.sourceHandling?.filter(
        (item) => item.kind === "presentation",
      ).length,
      2,
    );
    assert.equal(
      inspected.disclosure.sourceHandling?.some(
        (item) => item.kind === "finder-metadata",
      ),
      true,
    );
    const approval = {
      digest: inspected.disclosure.digest,
      customizations: [],
      credentialExposures: ["claude" as const],
      confirmation: dockerApprovalConfirmation,
      exclusions: candidates.map((item) => item.id),
    };
    requireDockerApproval(inspected.disclosure, approval);
    assert.throws(
      () =>
        requireDockerApproval(inspected.disclosure, {
          ...approval,
          exclusions: [],
        }),
      /missing or changed/,
    );
    await writeFile(
      path.join(f.home, ".claude/skills/.DS_Store"),
      Buffer.from([0, 1, 255, 3]),
    );
    const drifted = await inspectDockerCapabilities(
      f.app,
      "claude",
      f.env,
      [],
      [],
      candidates.map((item) => item.id),
    );
    assert.throws(
      () => requireDockerApproval(drifted.disclosure, approval),
      /missing or changed/,
    );
    assert.equal(await readFile(f.settings, "utf8"), original);
  } finally {
    await f.close();
  }
});

test("Google skill omission requires exact selection and preserves unrelated manifest/native content", async () => {
  const f = await fixture();
  try {
    const google = await writeGoogleWorkspaceFixture(f.home);
    const candidates = await dockerExclusions(f.home);
    const omitted = candidates.find(
      (item) => item.kind === "google-workspace-skill",
    );
    assert.ok(
      omitted,
      "Named Google skill needs a separate source-bound candidate",
    );
    const inspect = (ids: string[]) =>
      inspectDockerCapabilities(f.app, "claude", f.env, [], [], ids);
    const included = await inspect(
      candidates
        .filter((item) => item.id !== omitted.id)
        .map((item) => item.id),
    );
    assert.equal(included.disclosure.customizations.length, 4);
    const result = await inspect(candidates.map((item) => item.id));
    const files = result.config.frozen!.files;
    assert.equal(
      files.some((file) => file.target.includes("/google-workspace/")),
      false,
    );
    assert.equal(result.disclosure.customizations.length, 0);
    assert.deepEqual(
      result.disclosure.authentication,
      included.disclosure.authentication,
    );
    assert.ok(files.some((file) => file.target.endsWith("/kept/SKILL.md")));
    const manifest = files.find((file) => file.sourcePath === google.manifest)!;
    assert.deepEqual(JSON.parse(manifest.content), {
      ...google.value,
      skills: [google.value.skills[0]],
      pendingClaims: ["fixture/kept"],
    });
    assert.equal(manifest.inputDigest, digest(google.original));
    for (const file of files.filter((file) => file !== manifest))
      assert.deepEqual(
        file,
        included.config.frozen!.files.find(
          (item) => item.target === file.target,
        ),
      );
    const portable = await projectFiles([
      { path: google.root, target: ".claude/skills/synced/fixture" },
    ]);
    assert.equal(
      portable.filter((file) => file.target.includes("/google-workspace/"))
        .length,
      9,
    );
    assert.equal(
      portable.find((file) => file.sourcePath === google.manifest)!.content,
      google.original,
    );
    assert.equal(await readFile(google.manifest, "utf8"), google.original);
    for (const file of google.files)
      assert.match(
        await readFile(
          path.join(google.root, "google-workspace", file),
          "utf8",
        ),
        /Synthetic Google/,
      );
    const approval = {
      digest: result.disclosure.digest,
      customizations: [],
      credentialExposures: ["claude" as const],
      exclusions: candidates.map((item) => item.id),
      confirmation: dockerApprovalConfirmation,
    };
    requireDockerApproval(result.disclosure, approval);
    assert.throws(
      () =>
        requireDockerApproval(result.disclosure, {
          ...approval,
          exclusions: approval.exclusions.filter((id) => id !== omitted.id),
        }),
      /missing or changed/,
    );
  } finally {
    await f.close();
  }
});

for (const change of [
  "bytes",
  "mode",
  "extra-file",
  "manifest",
  "claim",
  "identity",
  "layout",
  "retarget",
])
  test(`Google exclusion refuses retained selection after ${change} drift`, async () => {
    const f = await fixture();
    try {
      const google = await writeGoogleWorkspaceFixture(f.home);
      const candidate = (await dockerExclusions(f.home)).find(
        (item) => item.kind === "google-workspace-skill",
      )!;
      const entry = path.join(google.root, "google-workspace/SKILL.md");
      if (change === "bytes")
        await writeFile(entry, "Changed synthetic source");
      if (change === "mode") await chmod(entry, 0o755);
      if (change === "extra-file")
        await writeFile(
          path.join(google.root, "google-workspace/extra.py"),
          "never execute",
        );
      if (change === "manifest")
        await writeFile(
          google.manifest,
          JSON.stringify({ ...google.value, unrelated: "new" }),
        );
      if (change === "claim")
        await writeFile(
          google.manifest,
          JSON.stringify({
            ...google.value,
            pendingClaims: ["changed/kept", "fixture/google-workspace"],
          }),
        );
      if (change === "identity")
        await writeFile(
          google.manifest,
          JSON.stringify({
            ...google.value,
            skills: [...google.value.skills, google.value.skills[1]],
          }),
        );
      if (change === "layout")
        await mkdir(path.join(google.root, "google-workspace/empty"));
      if (change === "retarget") {
        const terminal = path.join(google.root, "same-entry.md");
        await copyFile(entry, terminal);
        await rm(entry);
        await symlink(terminal, entry);
      }
      await assert.rejects(
        selectDockerExclusions(f.home, [candidate.id]),
        /changed or is unsupported/,
      );
    } finally {
      await f.close();
    }
  });

test("Google exclusion rejects forged identities, duplicate capture aliases and unrelated harness captures", async () => {
  const f = await fixture();
  try {
    const google = await writeGoogleWorkspaceFixture(f.home);
    const candidate = (await dockerExclusions(f.home)).find(
      (item) => item.kind === "google-workspace-skill",
    )!;
    const sources = [
      { path: google.root, target: ".claude/skills/synced/fixture" },
    ];
    for (const patch of [
      { pointer: "/skills/0" },
      { itemDigest: digest("changed") },
      { sourceDigest: digest("changed") },
      { definition: "{}" },
    ])
      await assert.rejects(
        projectFiles(sources, {
          docker: {
            home: f.home,
            handling: [],
            exclusions: [{ ...candidate, ...patch }],
          },
        }),
        /Google skill exclusion changed/,
      );
    const alias = path.join(f.home, ".agents/skills/google-alias");
    await symlink(path.join(google.root, "google-workspace"), alias);
    await assert.rejects(
      projectFiles(
        [...sources, { path: alias, target: ".agents/skills/google-alias" }],
        {
          docker: { home: f.home, handling: [], exclusions: [candidate] },
        },
      ),
      /another source/,
    );
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'model = "fixture-codex"\n',
    );
    const codex = [
      {
        path: path.join(f.home, ".codex/config.toml"),
        target: ".codex/config.toml",
      },
    ];
    assert.match(
      (
        await projectFiles(codex, {
          docker: { home: f.home, handling: [], exclusions: [] },
        })
      )[0].content,
      /fixture-codex/,
    );
    await assert.rejects(
      projectFiles(codex, {
        docker: { home: f.home, handling: [], exclusions: [candidate] },
      }),
      /outside this capture/,
    );
  } finally {
    await f.close();
  }
});

test("Slack plugin omission is separately selected, exactly approved and Docker-only", async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify({
      ...f.value,
      enabledPlugins: { "slack@claude-plugins-official": true },
    });
    await writeFile(f.settings, original);
    const candidates = await dockerExclusions(f.home);
    const slack = candidates.find((item) => item.kind === "slack-plugin");
    assert.ok(slack, "Exact Slack activation must be a separate candidate");
    assert.equal(
      slack.pointer,
      "/enabledPlugins/slack@claude-plugins-official",
    );
    assert.equal(slack.definition, "true");
    assert.equal(slack.itemDigest, digest("true"));
    assert.equal(slack.nativeSettingsUnchanged, true);
    assert.match(slack.effect, /six.*five/);
    const inspect = (ids: string[]) =>
      inspectDockerCapabilities(f.app, "claude", f.env, [], [], ids);
    await assert.rejects(
      inspect(
        candidates
          .filter((item) => item.id !== slack.id)
          .map((item) => item.id),
      ),
      /enabledPlugins/,
    );
    const inspected = await inspect(candidates.map((item) => item.id));
    assert.deepEqual(inspected.disclosure.exclusions, candidates);
    const projected = JSON.parse(
      inspected.config.frozen!.files.find(
        (file) => file.target === ".claude/settings.json",
      )!.content,
    );
    assert.equal(projected.enabledPlugins, undefined);
    assert.equal(projected.model, f.value.model);
    assert.ok(
      inspected.config.frozen!.files.some((file) =>
        file.target.endsWith("slack-axi/SKILL.md"),
      ),
    );
    assert.deepEqual(inspected.disclosure.customizations, []);
    const approval = {
      digest: inspected.disclosure.digest,
      customizations: [],
      credentialExposures: ["claude" as const],
      exclusions: candidates.map((item) => item.id),
      confirmation: dockerApprovalConfirmation,
    };
    requireDockerApproval(inspected.disclosure, approval);
    assert.throws(
      () =>
        requireDockerApproval(inspected.disclosure, {
          ...approval,
          exclusions: approval.exclusions.filter((id) => id !== slack.id),
        }),
      /missing or changed/,
    );
    assert.equal(await readFile(f.settings, "utf8"), original);
    const portable = path.join(f.home, "portable.json");
    await writeFile(
      portable,
      JSON.stringify({
        enabledPlugins: { "slack@claude-plugins-official": true },
      }),
    );
    await assert.rejects(
      projectFiles([{ path: portable, target: ".claude/settings.json" }], {
        files: [portable],
      }),
      /enabledPlugins/,
    );
    for (const patch of [
      { model: "changed" },
      { enabledPlugins: { "slack@claude-plugins-official": false } },
      {
        enabledPlugins: {
          "slack@claude-plugins-official": true,
          "other@fixture": true,
        },
      },
    ]) {
      await writeFile(
        f.settings,
        JSON.stringify({ ...JSON.parse(original), ...patch }),
      );
      await assert.rejects(
        selectDockerExclusions(f.home, [slack.id]),
        /changed or is unsupported/,
      );
    }
  } finally {
    await f.close();
  }
});

for (const enabledPlugins of [
  { "other@fixture": true },
  { "slack@claude-plugins-official": false },
  { "slack@claude-plugins-official": "true" },
  { "slack@claude-plugins-official": { enabled: true } },
  { "slack@claude-plugins-official": true, "other@fixture": false },
  ["slack@claude-plugins-official"],
  {},
])
  test("different or additional plugin fields cannot obtain a Slack exclusion", async () => {
    const f = await fixture();
    try {
      const original = JSON.stringify({ ...f.value, enabledPlugins });
      await writeFile(f.settings, original);
      const candidates = await dockerExclusions(f.home);
      assert.equal(
        candidates.some((item) => item.kind === "slack-plugin"),
        false,
      );
      await assert.rejects(
        inspectDockerCapabilities(
          f.app,
          "claude",
          f.env,
          [],
          [],
          candidates.map((item) => item.id),
        ),
        /enabledPlugins/,
      );
      assert.equal(await readFile(f.settings, "utf8"), original);
    } finally {
      await f.close();
    }
  });

test("Slack exclusion rejects forged pointer, item, source and same-byte source retarget", async () => {
  const f = await fixture();
  try {
    const original = JSON.stringify({
      ...f.value,
      enabledPlugins: { "slack@claude-plugins-official": true },
    });
    await writeFile(f.settings, original);
    const candidates = await dockerExclusions(f.home);
    const slack = candidates.find((item) => item.kind === "slack-plugin")!;
    assert.ok(slack);
    for (const patch of [
      { pointer: "/enabledPlugins" },
      { itemDigest: digest("false") },
      { sourceDigest: digest("changed") },
    ]) {
      await assert.rejects(
        projectFiles([{ path: f.settings, target: ".claude/settings.json" }], {
          files: [f.settings],
          docker: {
            home: f.home,
            handling: [],
            exclusions: candidates.map((item) =>
              item.id === slack.id ? { ...item, ...patch } : item,
            ),
          },
        }),
        /exclusion.*changed/,
      );
    }
    const terminal = path.join(f.home, "same-settings.json");
    await writeFile(terminal, original);
    await rm(f.settings);
    await symlink(terminal, f.settings);
    await assert.rejects(
      selectDockerExclusions(f.home, [slack.id]),
      /changed or is unsupported/,
    );
    assert.equal(await readFile(f.settings, "utf8"), original);
  } finally {
    await f.close();
  }
});

test("Docker WOFF2 bytes survive immutable persistence and bind disclosure and approval", async () => {
  const f = await fixture();
  try {
    const exclusions = (await dockerExclusions(f.home)).map((item) => item.id);
    const inspect = () =>
      inspectDockerCapabilities(f.app, "claude", f.env, [], [], exclusions);
    const inspected = await inspect();
    const font = inspected.config.frozen!.files.find(
      (file) => file.sourcePath === f.font,
    )!;
    assert.equal(font.encoding, "base64");
    assert.equal(font.mediaType, "font/woff2");
    assert.deepEqual(resourceBytes(font, true), woff2Fixture());
    const disclosed = inspected.disclosure.resources.find(
      (file) => file.source === f.font,
    )!;
    assert.equal(disclosed.digest, digest(woff2Fixture()));
    assert.equal(disclosed.bytes, 64);
    assert.equal(disclosed.encoding, "base64");
    assert.equal(disclosed.executable, false);
    assert.equal(
      inspected.disclosure.customizations.some(
        (item) => item.source === f.font,
      ),
      false,
    );
    const approval = {
      digest: inspected.disclosure.digest,
      customizations: [],
      credentialExposures: ["claude" as const],
      exclusions,
      confirmation: dockerApprovalConfirmation,
    };
    const bundle = path.join(f.root, "frozen-bundle");
    await mkdir(bundle);
    await writeFile(path.join(bundle, "fixture.mjs"), "export {};\n");
    const workflow = path.join(f.root, "frozen-workflow.json");
    const value = {
      ...inspected.config,
      bundle,
      docker: {
        profile: "container-native-1",
        disclosure: inspected.disclosure,
        approval,
      },
    };
    await writeFile(workflow, JSON.stringify(value));
    const first = await loadWorkflow(workflow, f.app.reviewer.skillPath, true);
    const changedBytes = woff2Fixture();
    changedBytes[63] ^= 1;
    await writeFile(f.font, changedBytes);
    const changed = await inspect();
    assert.throws(
      () => requireDockerApproval(changed.disclosure, approval),
      /missing or changed/,
    );
    const restarted = await loadWorkflow(
      workflow,
      f.app.reviewer.skillPath,
      true,
    );
    assert.equal(restarted.snapshot.digest, first.snapshot.digest);
    assert.deepEqual(
      resourceBytes(
        restarted.files.find((file) => file.sourcePath === f.font)!,
        true,
      ),
      woff2Fixture(),
    );
    const persisted = JSON.parse(await readFile(workflow, "utf8"));
    const stored = persisted.frozen.files.find(
      (file: { sourcePath: string }) => file.sourcePath === f.font,
    );
    stored.content = changedBytes.toString("base64");
    await writeFile(workflow, JSON.stringify(persisted));
    await assert.rejects(
      loadWorkflow(workflow, f.app.reviewer.skillPath, true),
      /no longer match/,
    );
    stored.encoding = "gzip";
    await writeFile(workflow, JSON.stringify(persisted));
    await assert.rejects(
      loadWorkflow(workflow, f.app.reviewer.skillPath, true),
      /Unsupported captured resource encoding/,
    );
    stored.encoding = "base64";
    stored.content = woff2Fixture(1100000).toString("base64");
    for (let index = 0; index < 7; index++)
      persisted.frozen.files.push({
        ...stored,
        target: stored.target.replace("fixture.woff2", `extra-${index}.woff2`),
      });
    await writeFile(workflow, JSON.stringify(persisted));
    await assert.rejects(
      loadWorkflow(workflow, f.app.reviewer.skillPath, true),
      /8 MB decoded bytes/,
    );
    await chmod(f.font, 0o700);
    await assert.rejects(inspect(), /non-executable Docker skill companion/);
  } finally {
    await f.close();
  }
});

test("WOFF2 recognition, decoded budgets and shared consumers remain narrowly Docker scoped", async () => {
  const f = await fixture();
  try {
    const target = ".claude/skills/morning/assets/fonts/fixture.woff2";
    const capture = () =>
      projectFiles([{ path: f.font, target }], {
        docker: { home: f.home, handling: [], exclusions: [] },
      });
    const [font] = await capture();
    assert.throws(() => resourceBytes(font), /execution mode/);
    for (const replacement of [
      { encoding: "unknown" },
      { mediaType: "image/png" },
      { executable: true },
      { content: font.content + "\n" },
      { target: ".claude/CLAUDE.md" },
      { target: "resources/.local-mcp/assets/fixture.woff2" },
    ])
      assert.throws(
        () => resourceBytes({ ...font, ...replacement }, true),
        /encoding|identity/,
      );
    await assert.rejects(projectFiles([{ path: f.font, target }]), /WOFF2/);
    await assert.rejects(
      projectFiles([{ path: f.font, target: ".claude/CLAUDE.md" }], {
        docker: { home: f.home, handling: [], exclusions: [] },
      }),
      /UTF-8/,
    );
    for (const change of [
      (bytes: Buffer) => bytes.write("wOFF"),
      (bytes: Buffer) => bytes.writeUInt32BE(999, 8),
      (bytes: Buffer) => bytes.writeUInt16BE(0, 12),
      (bytes: Buffer) => bytes.writeUInt16BE(1, 14),
      (bytes: Buffer) => bytes.writeUInt32BE(0, 20),
    ]) {
      const bytes = woff2Fixture();
      change(bytes);
      await writeFile(f.font, bytes);
      await assert.rejects(capture(), /recognized/);
    }
    await writeFile(f.font, "not a font despite its extension");
    await assert.rejects(capture(), /recognized/);
    await writeFile(f.font, woff2Fixture(1600000));
    assert.equal(resourceBytes((await capture())[0], true).length, 1600000);
    assert.ok((await capture())[0].content.length > 2000000);
    await writeFile(f.font, woff2Fixture(2000001));
    await assert.rejects(capture(), /2 MB.*2000001.*not read/);
    await writeFile(f.font, woff2Fixture());
    const other = path.join(path.dirname(f.font), "unknown.bin");
    await copyFile(f.font, other);
    await assert.rejects(
      projectFiles(
        [
          {
            path: other,
            target: target.replace("fixture.woff2", "unknown.bin"),
          },
        ],
        { docker: { home: f.home, handling: [], exclusions: [] } },
      ),
      /UTF-8/,
    );
    await mkdir(path.join(f.home, "review/assets/fonts"), { recursive: true });
    await copyFile(
      f.font,
      path.join(f.home, "review/assets/fonts/fixture.woff2"),
    );
    for (const mode of ["separated", "dangerous"] as const)
      await assert.rejects(loadSkill(f.app.reviewer.skillPath, mode), /WOFF2/);
    const skill = await loadSkill(f.app.reviewer.skillPath, "docker");
    assert.deepEqual(
      resourceBytes(
        skill.files.find((file) => file.encoding === "base64")!,
        true,
      ),
      woff2Fixture(),
    );
    await assert.rejects(
      materializeSkill(skill, path.join(f.root, "host-materialization")),
      /execution mode/,
    );
    await assert.rejects(
      readFile(
        path.join(f.root, "host-materialization/resources/review/SKILL.md"),
      ),
      /ENOENT/,
    );
  } finally {
    await f.close();
  }
});

test("PNG companions retain exact frozen bytes, disclosure, drift and non-executable scope", async () => {
  const f = await fixture();
  try {
    const exclusions = (await dockerExclusions(f.home)).map((item) => item.id);
    const inspect = () =>
      inspectDockerCapabilities(f.app, "claude", f.env, [], [], exclusions);
    const captured = await inspect();
    const asset = captured.config.frozen!.files.find(
      (file) => file.sourcePath === f.image,
    )!;
    assert.equal(asset.mediaType, "image/png");
    assert.equal(asset.encoding, "base64");
    assert.deepEqual(resourceBytes(asset, true), pngFixture());
    const disclosed = captured.disclosure.resources.find(
      (file) => file.source === f.image,
    )!;
    assert.equal(disclosed.digest, digest(pngFixture()));
    assert.equal(disclosed.bytes, 68);
    assert.equal(disclosed.mediaType, "image/png");
    assert.equal(disclosed.executable, false);
    assert.equal(
      captured.disclosure.customizations.some(
        (item) => item.source === f.image,
      ),
      false,
    );
    const approval = {
      digest: captured.disclosure.digest,
      customizations: [],
      credentialExposures: ["claude" as const],
      exclusions,
      confirmation: dockerApprovalConfirmation,
    };
    const bundle = path.join(f.root, "png-bundle");
    await mkdir(bundle);
    await writeFile(path.join(bundle, "fixture.mjs"), "export {};\n");
    const workflow = path.join(f.root, "png-workflow.json");
    const stored = {
      ...captured.config,
      bundle,
      docker: {
        profile: "container-native-1",
        disclosure: captured.disclosure,
        approval,
      },
    };
    await writeFile(workflow, JSON.stringify(stored));
    const first = await loadWorkflow(workflow, f.app.reviewer.skillPath, true);
    const changed = pngFixture();
    changed[50] ^= 1;
    await writeFile(f.image, changed);
    const next = await inspect();
    assert.throws(
      () => requireDockerApproval(next.disclosure, approval),
      /missing or changed/,
    );
    const reopened = await loadWorkflow(
      workflow,
      f.app.reviewer.skillPath,
      true,
    );
    assert.equal(reopened.snapshot.digest, first.snapshot.digest);
    assert.deepEqual(
      resourceBytes(
        reopened.files.find((file) => file.sourcePath === f.image)!,
        true,
      ),
      pngFixture(),
    );
    asset.content = changed.toString("base64");
    await writeFile(workflow, JSON.stringify(stored));
    await assert.rejects(
      loadWorkflow(workflow, f.app.reviewer.skillPath, true),
      /no longer match/,
    );
    await chmod(f.image, 0o700);
    await assert.rejects(inspect(), /non-executable Docker skill companion/);
  } finally {
    await f.close();
  }
});

test("PNG recognition refuses unsupported headers, encodings, paths, modes and byte overflow", async () => {
  const f = await fixture();
  try {
    const target = ".claude/skills/morning/assets/fixture.png";
    const capture = () =>
      projectFiles([{ path: f.image, target }], {
        docker: { home: f.home, handling: [], exclusions: [] },
      });
    const [asset] = await capture();
    assert.throws(() => resourceBytes(asset), /execution mode/);
    for (const replacement of [
      { mediaType: "font/woff2" },
      { mediaType: "image/jpeg" },
      { encoding: "unknown" },
      { executable: true },
      { content: asset.content + "\n" },
      { target: "resources/.local-mcp/assets/fixture.png" },
      { target: ".claude/skills/morning/fixture.png" },
      { target: ".claude/CLAUDE.md" },
    ])
      assert.throws(
        () => resourceBytes({ ...asset, ...replacement }, true),
        /encoding|identity/,
      );
    for (const change of [
      (bytes: Buffer) => bytes.write("NOTPNG"),
      (bytes: Buffer) => bytes.writeUInt32BE(12, 8),
      (bytes: Buffer) => bytes.write("BAD!", 12),
      (bytes: Buffer) => bytes.writeUInt32BE(0, 16),
      (bytes: Buffer) => bytes.writeUInt32BE(0x80000000, 20),
      (bytes: Buffer) => bytes.writeUInt8(1, 24),
      (bytes: Buffer) => bytes.writeUInt8(5, 25),
      (bytes: Buffer) => bytes.writeUInt8(1, 26),
      (bytes: Buffer) => bytes.writeUInt8(1, 27),
      (bytes: Buffer) => bytes.writeUInt8(2, 28),
      (bytes: Buffer) => bytes.writeUInt32BE(1, bytes.length - 12),
      (bytes: Buffer) => bytes.write("BAD!", bytes.length - 8),
    ]) {
      const bytes = pngFixture();
      change(bytes);
      await writeFile(f.image, bytes);
      await assert.rejects(capture(), /recognized/);
    }
    for (const bytes of [
      pngFixture().subarray(0, 32),
      Buffer.concat([pngFixture(), Buffer.from("trailing")]),
      Buffer.from("not PNG despite the extension"),
    ]) {
      await writeFile(f.image, bytes);
      await assert.rejects(capture(), /recognized/);
    }
    await writeFile(f.image, pngFixture(1600000));
    assert.equal(resourceBytes((await capture())[0], true).length, 1600000);
    assert.ok((await capture())[0].content.length > 2000000);
    await writeFile(f.image, pngFixture(2000001));
    await assert.rejects(capture(), /2000001.*not read/);
    await writeFile(f.image, pngFixture());
    await assert.rejects(projectFiles([{ path: f.image, target }]), /PNG/);
    for (const target of [
      ".claude/CLAUDE.md",
      ".claude/skills/morning/assets/unknown.bin",
    ])
      await assert.rejects(
        projectFiles([{ path: f.image, target }], {
          docker: { home: f.home, handling: [], exclusions: [] },
        }),
        /UTF-8/,
      );
    await mkdir(path.join(f.home, "review/assets"), { recursive: true });
    await copyFile(f.image, path.join(f.home, "review/assets/fixture.png"));
    for (const mode of ["separated", "dangerous"] as const)
      await assert.rejects(loadSkill(f.app.reviewer.skillPath, mode), /PNG/);
    const skill = await loadSkill(f.app.reviewer.skillPath, "docker");
    assert.deepEqual(
      resourceBytes(
        skill.files.find((file) => file.mediaType === "image/png")!,
        true,
      ),
      pngFixture(),
    );
    await assert.rejects(
      materializeSkill(skill, path.join(f.root, "refused-host-png")),
      /execution mode/,
    );
  } finally {
    await f.close();
  }
});

test("changed config/items cannot reuse exclusions and Slack is never implicitly removed", async () => {
  const f = await fixture();
  try {
    const ids = (await dockerExclusions(f.home)).map((item) => item.id);
    await writeFile(
      f.settings,
      JSON.stringify({
        ...f.value,
        enabledPlugins: { "slack@claude-plugins-official": true },
      }),
    );
    await assert.rejects(
      selectDockerExclusions(f.home, ids),
      /changed or is unsupported/,
    );
    const fresh = await dockerExclusions(f.home);
    await assert.rejects(
      inspectDockerCapabilities(
        f.app,
        "claude",
        f.env,
        [],
        [],
        fresh
          .filter((item) => item.kind !== "slack-plugin")
          .map((item) => item.id),
      ),
      /enabledPlugins/,
    );
    assert.equal(fresh.length, 3);
    await writeFile(
      f.settings,
      JSON.stringify({
        ...f.value,
        hooks: {
          SessionStart: [
            {
              matcher: "*",
              hooks: [
                { type: "command", command: "node /host/other-hook.mjs" },
              ],
            },
          ],
        },
      }),
    );
    assert.deepEqual(
      (await dockerExclusions(f.home)).map((item) => item.kind),
      ["status-line"],
    );
  } finally {
    await f.close();
  }
});

test("library links remain bounded and arbitrary HOME/credentials/binary dotfiles are refused", async () => {
  const f = await fixture();
  try {
    const source = {
      path: path.join(f.home, ".claude/skills"),
      target: ".claude/skills",
    };
    const capture = () =>
      projectFiles([source], {
        docker: { home: f.home, handling: [], exclusions: [] },
      });
    await symlink(f.home, path.join(f.home, ".claude/skills/home"));
    await assert.rejects(capture(), /arbitrary HOME/);
    await rm(path.join(f.home, ".claude/skills/home"));
    await writeFile(
      path.join(f.home, ".agents/skills/slack-axi/auth.json"),
      "BUSINESS_CREDENTIAL_CANARY",
    );
    await assert.rejects(capture(), /Credential stores/);
    await rm(path.join(f.home, ".agents/skills/slack-axi/auth.json"));
    await writeFile(
      path.join(f.home, ".claude/skills/.other"),
      Buffer.from([0, 255]),
    );
    await assert.rejects(capture(), /UTF-8/);
    await rm(path.join(f.home, ".claude/skills/.other"));
    await symlink(
      path.join(f.home, ".claude/skills"),
      path.join(f.home, ".agents/skills/slack-axi/loop"),
    );
    await assert.rejects(capture(), /directory link cycle/);
  } finally {
    await f.close();
  }
});

test("explicit diagnostic skill-leaf read scope binds its link and never grants parent, sibling or escaping resource access", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, "external-project/skill");
    const logical = path.join(f.home, ".claude/skills/approved-leaf");
    await mkdir(path.join(directory, "references"), { recursive: true });
    await writeFile(
      path.join(directory, "SKILL.md"),
      "Approved synthetic leaf only.",
    );
    await writeFile(
      path.join(directory, "references/context.md"),
      "Bounded companion.",
    );
    await writeFile(
      path.join(f.root, "external-project/parent-canary.bin"),
      Buffer.from([0, 255]),
    );
    await symlink(directory, logical);
    const resolved = await resolveTrustedSource(logical, "directory");
    const leaf = {
      source: logical,
      resolvedSourcePath: resolved.path,
      sourceDigest: resolved.identity,
    };
    const exclusions = (await dockerExclusions(f.home)).map((item) => item.id);
    const inspect = () =>
      inspectDockerCapabilities(f.app, "claude", f.env, [], [], exclusions, [
        leaf,
      ]);
    const omitted = await inspectDockerCapabilities(
      f.app,
      "claude",
      f.env,
      [],
      [],
      exclusions,
    );
    assert.ok(
      !omitted.disclosure.resources.some((file) =>
        file.source.startsWith(logical + path.sep),
      ),
    );
    const inspected = await inspect();
    const captured = inspected.config.frozen!.files.filter((file) =>
      file.target.startsWith(".claude/skills/approved-leaf/"),
    );
    assert.equal(captured.length, 2);
    assert.equal(
      captured.every((file) =>
        file.resolvedSourcePath?.startsWith(resolved.path + path.sep),
      ),
      true,
    );
    assert.equal(
      inspected.config.frozen!.files.some((file) =>
        file.sourcePath.includes("parent-canary"),
      ),
      false,
    );
    const approval = {
      digest: inspected.disclosure.digest,
      customizations: [],
      credentialExposures: ["claude" as const],
      exclusions,
      libraryLeaves: inspected.disclosure.libraryLeaves!.map((leaf) => leaf.id),
      confirmation: dockerApprovalConfirmation,
    };
    requireDockerApproval(inspected.disclosure, approval);
    await writeFile(
      path.join(directory, "references/context.md"),
      "Changed companion.",
    );
    const changed = await inspect();
    assert.throws(
      () => requireDockerApproval(changed.disclosure, approval),
      /missing or changed/,
    );
    assert.equal(
      captured.find((file) => file.target.endsWith("context.md"))!.content,
      "Bounded companion.",
    );
    await mkdir(path.join(directory, "assets/fonts"), { recursive: true });
    for (const [name, bytes] of [
      ["refused.woff2", woff2Fixture()],
      ["refused.png", pngFixture()],
    ] as const) {
      const asset = path.join(directory, "assets/fonts", name);
      await writeFile(asset, bytes);
      await assert.rejects(inspect(), /UTF-8-only leaf exceptions/);
      await rm(asset);
    }
    await rm(path.join(directory, "assets"), { recursive: true });
    await symlink(
      path.join(f.root, "external-project/parent-canary.bin"),
      path.join(directory, "escape.bin"),
    );
    await assert.rejects(inspect(), /leaf resource escapes/);
    await rm(path.join(directory, "escape.bin"));
    await symlink(
      directory,
      path.join(f.home, ".claude/skills/unapproved-alias"),
    );
    const unselected = await inspect();
    assert.ok(
      !unselected.disclosure.resources.some((file) =>
        file.source.includes("/unapproved-alias/"),
      ),
    );
    await rm(path.join(f.home, ".claude/skills/unapproved-alias"));
    await assert.rejects(
      projectFiles([], {
        docker: {
          home: f.home,
          handling: [],
          exclusions: [],
          libraryLeaves: [{ ...leaf, source: path.dirname(logical) }],
        },
      }),
      /one installed skill leaf/,
    );
    await mkdir(path.join(f.root, "other-leaf"));
    await writeFile(
      path.join(f.root, "other-leaf/SKILL.md"),
      "Approved synthetic leaf only.",
    );
    await rm(logical);
    await symlink(path.join(f.root, "other-leaf"), logical);
    await assert.rejects(inspect(), /read scope changed; no leaf contents/);
  } finally {
    await f.close();
  }
});

test("trusted import closure rejects missing, escaping and cyclic imports", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.home, ".claude/CLAUDE.md");
    const capture = () =>
      projectFiles([{ path: file, target: ".claude/CLAUDE.md" }], {
        files: [file],
        docker: { home: f.home, handling: [], exclusions: [] },
      });
    await writeFile(file, "@missing.md\n");
    await assert.rejects(capture(), /ENOENT/);
    await writeFile(file, "@../outside.md\n");
    await assert.rejects(capture(), /trusted .claude/);
    await writeFile(file, "@AGENTS.md\n");
    await writeFile(path.join(f.home, ".claude/AGENTS.md"), "@CLAUDE.md\n");
    await assert.rejects(capture(), /import cycle/);
  } finally {
    await f.close();
  }
});

test(
  "actual pinned Docker materializes bounded synthetic capture without excluded effects or Slack grants",
  {
    skip: process.env.PR_REVIEW_DOCKER_TESTS !== "1",
    timeout: 60000,
  },
  async () => {
    const f = await fixture();
    let executor: DockerExecutor | null = null;
    try {
      await writeGoogleWorkspaceFixture(f.home);
      for (let index = 0; index < 3; index++)
        await writeFile(
          path.join(f.home, `.claude/skills/morning/large-${index}.md`),
          (index === 0 ? '"' : "a").repeat(2000000),
        );
      const exclusions = (await dockerExclusions(f.home)).map(
        (item) => item.id,
      );
      const inspected = await inspectDockerCapabilities(
        f.app,
        "claude",
        f.env,
        [],
        [],
        exclusions,
      );
      const bundle = path.join(f.root, "bundle");
      const source = path.join(f.root, "source");
      await mkdir(bundle);
      await mkdir(path.join(source, "checkout/.claude"), { recursive: true });
      await copyFile(
        new URL("fixtures/installed-capture.mjs", import.meta.url),
        path.join(bundle, "fixture.mjs"),
      );
      await writeFile(
        path.join(source, "checkout/code.txt"),
        "immutable fixture source",
      );
      await writeFile(
        path.join(source, "checkout/CLAUDE.md"),
        "UNTRUSTED PR INSTRUCTIONS",
      );
      await writeFile(
        path.join(source, "checkout/.claude/settings.json"),
        '{"hooks":{"SessionStart":[]}}',
      );
      const workflow = path.join(f.root, "workflow.json");
      await writeFile(
        workflow,
        JSON.stringify({
          ...inspected.config,
          bundle,
          fixtureNative: false,
          docker: {
            profile: "container-native-1",
            disclosure: inspected.disclosure,
            approval: {
              digest: inspected.disclosure.digest,
              customizations: [],
              credentialExposures: ["claude"],
              exclusions,
              confirmation: dockerApprovalConfirmation,
            },
          },
        }),
      );
      await writeFile(f.font, "Changed host asset after immutable capture.");
      await writeFile(f.image, "Changed host PNG after immutable capture.");
      let diagnostics = "";
      executor = await DockerExecutor.open(
        { ...f.app, workflowConfigPath: workflow },
        undefined,
        (text) => {
          diagnostics += text;
        },
      );
      assert.ok(executor);
      const result = await executor
        .execute({
          kind: "review",
          runId: "installed-capture-fixture",
          settings: executor.capture(f.app.reviewer),
          prepare: async () => source,
          metadata: {},
          prompt:
            "Labeled synthetic projection fixture; no native harness or live Slack",
          diff: "fixture",
          schema: reviewSchema,
        })
        .catch((error) => {
          throw new Error(`${error.message}: ${diagnostics}`);
        });
      assert.match(
        (result.value as { rationale: string }).rationale,
        /excluded configuration absent/,
      );
      assert.equal(
        await readFile(path.join(source, "checkout/code.txt"), "utf8"),
        "immutable fixture source",
      );
      assert.doesNotMatch(JSON.stringify(result), /synthetic-model-only/);
    } finally {
      await executor?.close();
      await f.close();
    }
  },
);

test("Codex host-path trust is classified without transferring trust or changing model pins", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.home, ".codex/config.toml");
    await writeFile(
      file,
      'model = "gpt-6-astra"\n[projects."/host/private-project"]\ntrust_level = "trusted"\n',
    );
    const handling: DockerSourceHandling[] = [];
    const files = await projectFiles(
      [{ path: file, target: ".codex/config.toml" }],
      { files: [file], docker: { home: f.home, handling, exclusions: [] } },
    );
    assert.match(files[0].content, /gpt-6-astra/);
    assert.doesNotMatch(files[0].content, /projects|trusted/);
    assert.equal(handling[0].kind, "host-project-trust");
    assert.match(files[0].inputDigest!, /^[a-f0-9]{64}$/);
    await writeFile(
      file,
      'model = "gpt-6-astra"\n[projects."/host/private-project"]\ncommand = "not-inert"\n',
    );
    await assert.rejects(
      projectFiles([{ path: file, target: ".codex/config.toml" }], {
        docker: { home: f.home, handling: [], exclusions: [] },
      }),
      /Unsupported Codex project trust/,
    );
  } finally {
    await f.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  rm,
  symlink,
  chmod,
  truncate,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { oauthFixture } from "./fixtures/oauth-context.js";
import { projectFiles } from "../execution/projection.js";
import {
  dockerInputFrame,
  dockerResourceLimits,
  portableResourceLimits,
} from "../execution/harness.mjs";
import { loadWorkflow } from "../execution/config.js";
import { DockerExecutor } from "../execution/executor.js";
import {
  dockerApprovalConfirmation,
  dockerSetupConfirmation,
  type DockerCapabilityDisclosure,
} from "../../shared/contracts.js";

const approval = (value: DockerCapabilityDisclosure) => ({
  digest: value.digest,
  customizations: value.customizations.map((item) => item.id),
  credentialExposures: value.authentication.map((item) => item.harness),
  exclusions: value.exclusions?.map((item) => item.id) ?? [],
  libraryLeaves: value.libraryLeaves?.map((item) => item.id) ?? [],
  confirmation: dockerApprovalConfirmation,
});

test("real HTTP installed-leaf consent is explicit, transient, source-bound and separate from setup", async () => {
  const f = await oauthFixture();
  const leaf = path.join(f.root, "external/approved");
  const alias = path.join(f.home, ".claude/skills/approved");
  await mkdir(leaf, { recursive: true });
  await writeFile(path.join(leaf, "SKILL.md"), "SYNTHETIC EXTERNAL LEAF\n");
  await writeFile(
    path.join(leaf, "companion.md"),
    "FROZEN SYNTHETIC COMPANION\n",
  );
  await symlink(leaf, alias);
  const selection = {
    version: 2,
    harness: "claude",
    workflow: "docker",
    reviewer: { skillPath: f.skillPath, model: "claude-fable-5" },
  };
  const discover = () =>
    f.send("/api/settings/execution/library-leaf", { source: alias });
  const inspect = (ids: string[] = []) =>
    f.send("/api/settings/execution/inspect", {
      harness: "claude",
      libraryLeaves: ids,
    });
  const setup = (disclosure: DockerCapabilityDisclosure) =>
    f.send("/api/settings/execution/setup", {
      harness: "claude",
      confirmation: dockerSetupConfirmation,
      approval: approval(disclosure),
    });
  try {
    assert.equal((await discover()).status, 409);
    assert.equal(
      (await f.send("/api/settings/harness", selection, { method: "PATCH" }))
        .status,
      200,
    );
    assert.equal(
      (await f.send("/api/settings/execution/library-leaf")).status,
      404,
    );
    assert.equal((await inspect()).status, 200);
    const candidateResponse = await discover();
    assert.equal(
      candidateResponse.status,
      200,
      await candidateResponse.clone().text(),
    );
    const candidate = await candidateResponse.json();
    assert.equal(candidate.source, alias);
    assert.equal(candidate.resolvedSourcePath, await realpath(leaf));
    assert.equal(candidate.limits.decodedBytes, 2000000);
    assert.equal(candidate.limits.encoding, "utf8");
    assert.doesNotMatch(
      JSON.stringify(candidate),
      /SYNTHETIC EXTERNAL|FROZEN SYNTHETIC/,
    );
    assert.equal((await inspect()).status, 200);
    assert.equal((await inspect(["0".repeat(64)])).status, 409);
    for (const source of [
      leaf,
      path.dirname(alias),
      path.join(alias, "SKILL.md"),
    ])
      assert.equal(
        (await f.send("/api/settings/execution/library-leaf", { source }))
          .status,
        409,
      );
    assert.equal(
      (
        await f.send("/api/settings/execution/library-leaf", {
          source: alias,
          approval: true,
        })
      ).status,
      400,
    );
    const response = await inspect([candidate.id]);
    assert.equal(response.status, 200, await response.clone().text());
    const disclosure = (await response.json()) as DockerCapabilityDisclosure;
    assert.deepEqual(disclosure.libraryLeaves, [candidate]);
    assert.equal(
      disclosure.resources.filter((item) => item.source.startsWith(alias + "/"))
        .length,
      2,
    );
    const missingConsent = await f.send("/api/settings/execution/setup", {
      harness: "claude",
      confirmation: dockerSetupConfirmation,
      approval: { ...approval(disclosure), libraryLeaves: [] },
    });
    assert.equal(missingConsent.status, 409);
    assert.match(await missingConsent.text(), /approval is missing or changed/);
    await writeFile(path.join(leaf, "companion.md"), "CHANGED COMPANION\n");
    assert.equal((await setup(disclosure)).status, 409);
    const changed = (await (
      await inspect([candidate.id])
    ).json()) as DockerCapabilityDisclosure;
    assert.notEqual(changed.digest, disclosure.digest);
    await chmod(path.join(leaf, "companion.md"), 0o700);
    assert.equal((await setup(changed)).status, 409);
    await chmod(path.join(leaf, "companion.md"), 0o600);
    await symlink(
      path.join(f.root, "outside.md"),
      path.join(leaf, "escape.md"),
    );
    await writeFile(path.join(f.root, "outside.md"), "MUST NOT CAPTURE\n");
    const escape = await inspect([candidate.id]);
    assert.equal(escape.status, 409);
    assert.match(await escape.text(), /escapes its authorized/);
    await rm(path.join(leaf, "escape.md"));
    await writeFile(path.join(leaf, "oversized.md"), "x".repeat(2000000));
    const leafBudget = await inspect([candidate.id]);
    assert.equal(leafBudget.status, 409);
    assert.match(
      await leafBudget.text(),
      /independent 2000-entry\/2 MB read scope/,
    );
    await rm(path.join(leaf, "oversized.md"));
    const replacement = path.join(f.root, "external/replacement");
    await mkdir(replacement);
    await writeFile(
      path.join(replacement, "SKILL.md"),
      "SYNTHETIC EXTERNAL LEAF\n",
    );
    await rm(alias);
    await symlink(replacement, alias);
    const retarget = await inspect([candidate.id]);
    assert.equal(retarget.status, 409);
    assert.match(await retarget.text(), /identity changed/);
    const next = await (await discover()).json();
    assert.notEqual(next.id, candidate.id);
    const ready = (await (
      await inspect([next.id])
    ).json()) as DockerCapabilityDisclosure;
    const bundle = path.join(f.root, "synthetic-bundle");
    const workflow = path.join(f.root, "synthetic-workflow.json");
    await mkdir(bundle);
    await writeFile(
      path.join(bundle, "fixture.mjs"),
      "throw new Error('Not executed by the mocked setup test');",
    );
    const original = f.service.executor!.setup.bind(f.service.executor);
    let preparations = 0;
    f.service.executor!.setup = (harness, env, _prepare, selected) =>
      original(
        harness,
        env,
        async (_app, _harness, _env, _install, _signal, config) => {
          preparations++;
          await writeFile(
            workflow,
            JSON.stringify({ ...config, bundle, fixtureNative: false }),
          );
          return workflow;
        },
        selected,
      );
    const check = DockerExecutor.prototype.check;
    DockerExecutor.prototype.check = async () => {};
    try {
      const prepared = await setup(ready);
      assert.equal(prepared.status, 200, await prepared.clone().text());
      assert.equal(preparations, 1);
    } finally {
      DockerExecutor.prototype.check = check;
    }
    const frozen = await loadWorkflow(workflow, f.skillPath, true);
    const capturedLeaf = frozen.files.find(
      (file) => file.sourcePath === path.join(alias, "SKILL.md"),
    )!;
    assert.equal(capturedLeaf.content, "SYNTHETIC EXTERNAL LEAF\n");
    await writeFile(
      path.join(replacement, "SKILL.md"),
      "POST-CAPTURE CHANGE\n",
    );
    assert.equal(
      (await loadWorkflow(workflow, f.skillPath, true)).files.find(
        (file) => file.sourcePath === capturedLeaf.sourcePath,
      )!.content,
      capturedLeaf.content,
    );
    assert.equal(
      (await f.send("/api/settings/harness", selection, { method: "PATCH" }))
        .status,
      200,
    );
    assert.equal((await inspect([next.id])).status, 409);
    assert.equal((await inspect()).status, 200);
    assert.equal((await discover()).status, 200);
    assert.equal((await inspect([next.id])).status, 200);
    await f.restart();
    assert.equal((await inspect([next.id])).status, 409);
    assert.equal((await inspect()).status, 200);
    assert.equal((await setup(disclosure)).status, 409);
    assert.equal(f.service.db.getSettings().integrations.configs.length, 0);
    assert.deepEqual(f.operations, []);
  } finally {
    await f.close();
  }
});

test("real HTTP retains separate consent and independent bounds for two aliases of one authorized leaf", async () => {
  const f = await oauthFixture();
  try {
    const leaf = path.join(f.root, "external/approved");
    const aliases = [
      path.join(f.home, ".claude/skills/approved"),
      path.join(f.home, ".agents/skills/approved"),
    ];
    await mkdir(leaf, { recursive: true });
    await mkdir(path.dirname(aliases[1]), { recursive: true });
    await writeFile(path.join(leaf, "SKILL.md"), "SYNTHETIC AUTHORIZED LEAF\n");
    await writeFile(path.join(leaf, "companion.md"), "x".repeat(1100000));
    for (const alias of aliases) await symlink(leaf, alias);
    await writeFile(
      f.skillPath,
      (await readFile(f.skillPath, "utf8")) +
        "\nSynthetic nested instruction: codex exec. Never executed in this test.\n",
    );
    const saved = await f.send(
      "/api/settings/harness",
      {
        version: 2,
        harness: "claude",
        workflow: "docker",
        reviewer: { skillPath: f.skillPath, model: "claude-fable-5" },
      },
      { method: "PATCH" },
    );
    assert.equal(saved.status, 200, await saved.clone().text());
    const candidates = [];
    for (const source of aliases) {
      const response = await f.send("/api/settings/execution/library-leaf", {
        source,
      });
      assert.equal(response.status, 200, await response.clone().text());
      candidates.push(await response.json());
    }
    assert.equal(candidates[0].resolvedSourcePath, await realpath(leaf));
    assert.equal(
      candidates[1].resolvedSourcePath,
      candidates[0].resolvedSourcePath,
    );
    assert.notEqual(candidates[0].sourceDigest, candidates[1].sourceDigest);
    assert.notEqual(candidates[0].id, candidates[1].id);
    assert.ok(
      candidates.every(
        (item) =>
          item.limits.decodedBytes === 2000000 &&
          item.limits.entries === 2000 &&
          item.limits.encoding === "utf8",
      ),
    );
    const inspect = (libraryLeaves: string[]) =>
      f.send("/api/settings/execution/inspect", {
        harness: "claude",
        libraryLeaves,
      });
    for (const selected of [[], [candidates[0].id], [candidates[1].id]]) {
      const response = await inspect(selected);
      assert.equal(response.status, 200, await response.clone().text());
      const disclosure = await response.json();
      for (const [index, alias] of aliases.entries()) {
        const included = selected.includes(candidates[index].id);
        assert.equal(
          disclosure.resources.filter((item: { source: string }) =>
            item.source.startsWith(alias + path.sep),
          ).length,
          included ? 2 : 0,
        );
        if (!included)
          assert.ok(
            disclosure.sourceHandling.some(
              (item: { source: string; effect: string }) =>
                item.source === alias &&
                /omitted.*no read consent/.test(item.effect),
            ),
          );
      }
    }
    const ids = candidates.map((item) => item.id);
    const response = await inspect(ids);
    assert.equal(response.status, 200, await response.clone().text());
    const disclosure = (await response.json()) as DockerCapabilityDisclosure;
    assert.deepEqual(disclosure.libraryLeaves, candidates);
    for (const source of aliases)
      assert.equal(
        disclosure.resources.filter((item) =>
          item.source.startsWith(source + path.sep),
        ).length,
        2,
      );
    const partial = await f.send("/api/settings/execution/setup", {
      harness: "claude",
      confirmation: dockerSetupConfirmation,
      approval: { ...approval(disclosure), libraryLeaves: [ids[0]] },
    });
    assert.equal(partial.status, 409);
    assert.match(await partial.text(), /approval is missing or changed/);
    assert.equal((await inspect([ids[0], ids[0]])).status, 409);
    await writeFile(path.join(leaf, "extra.md"), "y".repeat(1000000));
    const overflow = await inspect(ids);
    assert.equal(overflow.status, 409);
    assert.match(
      await overflow.text(),
      /independent 2000-entry\/2 MB read scope/,
    );
    await rm(path.join(leaf, "extra.md"));
    const unselected = path.join(f.home, ".claude/skills/third-alias");
    await symlink(leaf, unselected);
    const third = await inspect(ids);
    assert.equal(third.status, 200, await third.clone().text());
    assert.ok(
      !(await third.json()).resources.some((item: { source: string }) =>
        item.source.startsWith(unselected + path.sep),
      ),
    );
    await rm(unselected);
    const changed = path.join(f.root, "external/changed");
    await mkdir(changed);
    await writeFile(
      path.join(changed, "SKILL.md"),
      "SYNTHETIC AUTHORIZED LEAF\n",
    );
    await rm(aliases[1]);
    await symlink(changed, aliases[1]);
    const retargeted = await inspect(ids);
    assert.equal(retargeted.status, 409);
    assert.match(await retargeted.text(), /identity changed/);
    assert.deepEqual(f.operations, []);
  } finally {
    await f.close();
  }
});

test("unselected optional leaf contents are never traversed and selected review dependencies stay required", async () => {
  const f = await oauthFixture();
  try {
    const leaf = path.join(f.root, "unapproved");
    const source = path.join(f.home, ".claude/skills/optional");
    await mkdir(leaf);
    await symlink(leaf, source);
    await symlink(path.join(f.root, "missing"), path.join(leaf, "dangling"));
    await writeFile(path.join(leaf, "auth.json"), "SYNTHETIC DO NOT READ");
    await writeFile(path.join(leaf, "invalid.bin"), Buffer.from([0, 255]));
    const handling: NonNullable<DockerCapabilityDisclosure["sourceHandling"]> =
      [];
    const sources = [{ path: path.dirname(source), target: ".claude/skills" }];
    const docker = { home: f.home, handling, exclusions: [] };
    const files = await projectFiles(sources, { docker });
    assert.deepEqual(files, []);
    assert.ok(
      handling.some(
        (item) => item.source === source && /omitted/.test(item.effect),
      ),
    );
    await assert.rejects(
      projectFiles(sources, {
        docker,
        skillPath: path.join(source, "SKILL.md"),
      }),
      /arbitrary HOME/,
    );
    const nested = path.join(f.home, ".claude/skills/ordinary");
    await mkdir(nested);
    await symlink(leaf, path.join(nested, "escape"));
    await assert.rejects(projectFiles(sources, { docker }), /arbitrary HOME/);
    await assert.rejects(projectFiles(sources), /symlinks/);
    assert.equal(
      await readFile(path.join(leaf, "auth.json"), "utf8"),
      "SYNTHETIC DO NOT READ",
    );
  } finally {
    await f.close();
  }
});

test("Docker fixed raw/serialized budgets preserve unrelated projection and exact-leaf limits", async () => {
  const f = await oauthFixture();
  try {
    const directory = path.join(f.root, "resources");
    await mkdir(directory);
    const sources = Array.from({ length: 4 }, (_, index) => ({
      path: path.join(directory, `${index}.md`),
      target: `resources/fixture/${index}.md`,
    }));
    for (const source of sources)
      await writeFile(source.path, "a".repeat(2000000));
    const docker = { home: f.home, handling: [], exclusions: [] };
    const files = await projectFiles(sources, { docker });
    assert.equal(
      files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
      dockerResourceLimits.decodedBytes,
    );
    await assert.rejects(projectFiles(sources), /2 MB aggregate/);
    await writeFile(sources[3].path, "a".repeat(2000001));
    await assert.rejects(
      projectFiles(sources, { docker }),
      /8000001.*not read/,
    );
    await writeFile(sources[3].path, "a".repeat(2000000));
    const fifth = {
      path: path.join(directory, "extra.md"),
      target: "resources/fixture/extra.md",
    };
    await writeFile(fifth.path, "x");
    await assert.rejects(
      projectFiles([...sources, fifth], { docker }),
      /8000001.*not read/,
    );
    await writeFile(sources[0].path, "\u0001".repeat(2000000));
    await writeFile(sources[2].path, "");
    const first = await projectFiles(sources.slice(0, 3), {
      opaqueAssets: true,
      rawSettings: true,
    });
    const remaining =
      dockerResourceLimits.serializedBytes -
      Buffer.byteLength(JSON.stringify(first));
    assert.ok(remaining < portableResourceLimits.fileBytes);
    await writeFile(sources[2].path, "a".repeat(remaining));
    const exact = await projectFiles(sources.slice(0, 3), {
      opaqueAssets: true,
      rawSettings: true,
    });
    assert.equal(
      Buffer.byteLength(JSON.stringify(exact)),
      dockerResourceLimits.serializedBytes,
    );
    await writeFile(sources[2].path, "a".repeat(remaining + 1));
    await assert.rejects(
      projectFiles(sources.slice(0, 3), {
        opaqueAssets: true,
        rawSettings: true,
      }),
      /16 MB serialized/,
    );
    await assert.rejects(
      projectFiles(
        Array.from({ length: 101 }, () => sources[0]),
        { docker },
      ),
      /100 explicit/,
    );
    const large = path.join(f.root, "oversized-workflow.json");
    await writeFile(large, "");
    await truncate(large, dockerResourceLimits.workflowBytes + 1);
    await assert.rejects(
      loadWorkflow(large, f.skillPath, true),
      /[Bb]ound|limit/,
    );
    assert.equal((await readFile(sources[2].path)).length, remaining + 1);
  } finally {
    await f.close();
  }
});

test("Docker initialization has an exact UTF-8 frame budget without widening business requests", () => {
  const overhead = Buffer.byteLength(dockerInputFrame({ payload: "" }));
  const payload = "a".repeat(dockerResourceLimits.initializeBytes - overhead);
  assert.equal(
    Buffer.byteLength(dockerInputFrame({ payload })),
    dockerResourceLimits.initializeBytes,
  );
  assert.throws(() => dockerInputFrame({ payload: payload + "a" }), /20 MB/);
  assert.throws(
    () => dockerInputFrame({ payload: "é" + payload.slice(1) }),
    /20 MB/,
  );
  assert.equal(portableResourceLimits.decodedBytes, 2000000);
});

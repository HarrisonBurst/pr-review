import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { projectFiles, projectedSettings } from "../execution/projection.js";
import {
  fixtureCredentials,
  piCredentials,
  nativeCredentials,
} from "../execution/auth.js";
import { loadWorkflow, type WorkflowConfig } from "../execution/config.js";
import { supportedImage } from "../execution/policy.js";
import { PiStream } from "../stream.js";

test("explicit portable configuration preserves nested resources and existing hook trust without running host code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-projection-"));
  try {
    const config = path.join(root, "config.toml");
    const original = stringify({
      features: { multi_agent: true, hooks: true, apps: false },
      agents: { reviewer: { config_file: "/scratch/resources/reviewer.toml" } },
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "node /scratch/resources/hook.mjs" },
            ],
          },
        ],
        state: {
          [`${config}:session_start:0:0`]: {
            trusted_hash:
              "sha256:374df6669a7758bc78487398ddca70af97851a665ecf7be9b941e20cd4d1bc09",
          },
        },
      },
    });
    await writeFile(config, original);
    const resources = path.join(root, "resources");
    await mkdir(resources);
    await writeFile(
      path.join(resources, "reviewer.toml"),
      'developer_instructions = "Preserve the user workflow"\n',
    );
    await writeFile(
      path.join(resources, "hook.mjs"),
      `throw new Error("Must never execute on the host");`,
    );
    const files = await projectFiles([
      { path: config, target: ".codex/config.toml" },
      { path: resources, target: "resources" },
    ]);
    const settings = projectedSettings(files).codex as any;
    assert.equal(settings.features.multi_agent, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      "node /scratch/resources/hook.mjs",
    );
    assert.equal(
      settings.hooks.state["/scratch/.codex/config.toml:session_start:0:0"]
        .trusted_hash,
      "sha256:374df6669a7758bc78487398ddca70af97851a665ecf7be9b941e20cd4d1bc09",
    );
    assert.equal(await readFile(config, "utf8"), original);
    for (const contents of [
      original.replace("374df666", "00000000"),
      original.replace("hook.mjs", "changed.mjs"),
      original + '\n[mcp_servers.raw]\nurl="https://unvetted.invalid/mcp"\n',
      'sandbox_mode="danger-full-access"',
      'approval_policy="on-request"',
      "[features]\napps=true",
      '[hooks]\nSessionStart=[{hooks=[{type="command",command="echo untrusted"}]}]',
    ]) {
      await writeFile(config, contents);
      await assert.rejects(
        projectFiles([{ path: config, target: ".codex/config.toml" }]),
      );
      assert.equal(await readFile(config, "utf8"), contents);
    }
    await symlink(config, path.join(root, "link"));
    await assert.rejects(
      projectFiles([
        { path: path.join(root, "link"), target: "resources/config" },
      ]),
      /symlinks/,
    );
    await assert.rejects(
      projectFiles([{ path: config, target: "resources/../escape" }]),
    );
    const pi = path.join(root, "pi.json");
    for (const value of [
      { packages: ["npm:unapproved"] },
      { defaultProvider: "unapproved" },
      { apiKey: "synthetic-secret" },
    ]) {
      await writeFile(pi, JSON.stringify(value));
      await assert.rejects(
        projectFiles([{ path: pi, target: ".pi/agent/settings.json" }]),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi selective auth reads only the explicit supported source and never projects refresh or unrelated credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-auth-"));
  try {
    const fixture = fixtureCredentials().pi!;
    const auth = {
      "openai-codex": {
        type: "oauth",
        ...fixture,
        refresh: "synthetic-refresh-must-stay-host",
      },
      unrelated: { apiKey: "synthetic-unrelated-must-stay-host" },
    };
    const text = JSON.stringify(auth);
    const file = path.join(root, "auth.json");
    await writeFile(file, text);
    assert.deepEqual(piCredentials(text), fixture);
    for (const patch of [
      { type: "api_key" },
      { expires: 0 },
      { access: "malformed" },
    ])
      assert.throws(() =>
        piCredentials(
          JSON.stringify({
            "openai-codex": { ...auth["openai-codex"], ...patch },
          }),
        ),
      );
    if (process.platform === "darwin") {
      const config: WorkflowConfig = {
        version: 2,
        harness: "pi",
        nested: [],
        piAuthFile: file,
        auth: "native",
        image: supportedImage,
        bundle: root,
        models: { claude: "fixture", codex: "fixture" },
        effort: "low",
      };
      const selected = await nativeCredentials(undefined, config);
      assert.deepEqual(selected.pi, fixture);
      assert.equal(selected.claude.claudeAiOauth.accessToken, "");
      assert.equal(selected.codex.tokens.access_token, "");
      assert.doesNotMatch(
        JSON.stringify(selected),
        /synthetic-refresh|synthetic-unrelated/,
      );
      await assert.rejects(nativeCredentials(AbortSignal.abort(), config));
    }
    assert.equal(await readFile(file, "utf8"), text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow snapshots pin exact explicit bytes, full skill and resources without activating discovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-pins-"));
  try {
    const bundle = path.join(root, "bundle");
    await mkdir(bundle);
    await writeFile(path.join(bundle, "fixture.mjs"), "explicit fixture");
    const skill = path.join(root, "SKILL.md");
    await writeFile(
      skill,
      "Full fixture workflow including nested orchestration",
    );
    const file = path.join(root, "workflow.json");
    const config = {
      version: 2,
      nested: [],
      harness: "pi",
      auth: "fixture",
      image: supportedImage,
      bundle,
      models: { claude: "fixture", codex: "fixture" },
      effort: "low",
    };
    const text = JSON.stringify(config);
    await writeFile(file, text);
    const first = await loadWorkflow(file, skill, true);
    await writeFile(file, text + "\n");
    assert.notEqual(
      (await loadWorkflow(file, skill, true)).snapshot.digest,
      first.snapshot.digest,
    );
    await writeFile(file, text);
    assert.equal(
      (await loadWorkflow(file, skill, true)).snapshot.digest,
      first.snapshot.digest,
    );
    await writeFile(skill, "Changed skill");
    assert.notEqual(
      (await loadWorkflow(file, skill, true)).snapshot.skillDigest,
      first.snapshot.skillDigest,
    );
    await assert.rejects(loadWorkflow(file, skill, false), /demo/);
    await writeFile(file, JSON.stringify({ ...config, auth: "native" }));
    await assert.rejects(loadWorkflow(file, skill, false), /own explicit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi stream requires an authoritative completed assistant turn", () => {
  const stream = new PiStream();
  const push = (target: PiStream, frame: unknown) =>
    target.decoder.push(Buffer.from(JSON.stringify(frame) + "\n"));
  push(stream, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "not authoritative" },
  });
  assert.equal(stream.lastMessage, null);
  push(stream, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: '{"answer":"fixture"}' }],
    },
  });
  assert.equal(stream.completed, false);
  push(stream, { type: "agent_end", messages: [] });
  assert.equal(stream.lastMessage, '{"answer":"fixture"}');
  assert.equal(stream.successful, true);
  assert.equal(stream.completed, true);
  const failed = new PiStream();
  push(failed, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      content: [{ type: "text", text: '{"answer":"not success"}' }],
    },
  });
  push(failed, { type: "agent_end", messages: [] });
  assert.equal(failed.successful, false);
});

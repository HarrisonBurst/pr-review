import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dockerApprovalConfirmation,
  dockerSetupConfirmation,
  type DockerCapabilityDisclosure,
  type HarnessId,
  type DockerCapabilityApproval,
} from "../../shared/contracts.js";
import { loadConfig } from "../config.js";
import { ReviewService } from "../service.js";
import { createHttpServer } from "../http.js";
import { discoverNativeMcp } from "../native-mcp.js";
import {
  inspectDockerCapabilities,
  requireDockerApproval,
} from "../execution/docker-capabilities.js";
import { DockerExecutor } from "../execution/executor.js";
import { loadWorkflow } from "../execution/config.js";
import { fixtureCredentials, selectedCredentials } from "../execution/auth.js";
import { knownMcpProfiles } from "../mcp-profiles.js";
import { reviewSchema } from "../review-output.js";

const approve = (disclosure: DockerCapabilityDisclosure) => ({
  digest: disclosure.digest,
  customizations: disclosure.customizations.map((item) => item.id),
  credentialExposures: disclosure.authentication.map((item) => item.harness),
  confirmation: dockerApprovalConfirmation,
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-docker-consent-"));
  const home = path.join(root, "home");
  const skillPath = path.join(home, "skill/ENTRY.md");
  const extension = path.join(home, ".pi/agent/extensions/approved.mjs");
  const local = path.join(home, "local/server.mjs");
  const plugin = path.join(home, "operator-plugin");
  for (const dir of [
    plugin,
    path.dirname(skillPath),
    path.dirname(extension),
    path.dirname(local),
    path.join(home, ".agents/skills/helper"),
    path.join(root, "bundle"),
    path.join(root, "source/checkout/.pi"),
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(
    skillPath,
    "---\nname: independent-audit\ndescription: Synthetic trusted Docker fixture\n---\nUse companion rubric.md and the native tools.\n",
  );
  await writeFile(path.join(home, "skill/rubric.md"), "Original frozen rubric");
  await writeFile(
    path.join(home, ".agents/skills/helper/SKILL.md"),
    "---\nname: trusted-helper\ndescription: frozen native library\n---\nRead the source.",
  );
  await writeFile(
    extension,
    'import {writeFile} from "node:fs/promises"; await writeFile("/scratch/approved-ran", "container only"); export default function () {}\n',
  );
  await writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "synthetic-operator-plugin",
      pi: { extensions: ["extension.mjs"] },
    }),
  );
  await writeFile(
    path.join(plugin, "extension.mjs"),
    'import {writeFile} from "node:fs/promises"; await writeFile("/scratch/plugin-ran", "portable plugin"); export default function () {}',
  );
  await writeFile(
    path.join(home, ".pi/agent/settings.json"),
    JSON.stringify({ packages: [plugin] }),
  );
  await writeFile(
    path.join(home, ".pi/agent/auth.json"),
    JSON.stringify({
      "openai-codex": {
        access: "MODEL_SOURCE_CANARY",
        refresh: "REFRESH_SOURCE_CANARY",
      },
      business: "BUSINESS_SOURCE_CANARY",
    }),
  );
  const profile = knownMcpProfiles[0];
  await writeFile(
    local,
    `import readline from 'node:readline'; import {existsSync} from 'node:fs'; import {fileURLToPath} from 'node:url';
const profile=${JSON.stringify(profile)};
for await (const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line); if(!request.id || request.params?.arguments?.id === 'timeout-document') continue;
 const result=request.method==='initialize'?{protocolVersion:profile.server.protocol,serverInfo:{name:profile.server.name,version:profile.server.version},capabilities:{tools:{}}}:request.method==='tools/list'?{tools:[{name:profile.tool.name,inputSchema:existsSync(fileURLToPath(new URL('./drift',import.meta.url)))?{type:'object'}:profile.tool.inputSchema,annotations:{readOnlyHint:true}}]}:{content:[{type:'text',text:'container document'}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
}
`,
  );
  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { local: { type: "stdio", command: "node", args: [local] } },
    }),
  );
  await writeFile(path.join(root, "source/checkout/code.txt"), "pinned source");
  await writeFile(
    path.join(root, "source/checkout/AGENTS.md"),
    "UNTRUSTED STARTUP CONFIG",
  );
  await writeFile(
    path.join(root, "source/checkout/.pi/settings.json"),
    '{"defaultProjectTrust":"always","extensions":["./attack.mjs"]}',
  );
  await writeFile(
    path.join(root, "source/checkout/.pi/attack.mjs"),
    'throw Error("PR CONFIG MUST NOT LOAD")',
  );
  await copyFile(
    new URL("fixtures/docker-capabilities.mjs", import.meta.url),
    path.join(root, "bundle/fixture.mjs"),
  );
  const app = loadConfig({
    demo: true,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data/app.sqlite"),
    reviewer: {
      skillPath,
      model: "openai-codex/gpt-6-astra",
      additionalInstructions: "",
    },
  });
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    AMBIENT_BUSINESS_CANARY: "HOST_BUSINESS_CANARY",
  };
  const connections = await discoverNativeMcp({ harness: "claude" }, env);
  const request = {
    id: connections[0].id,
    profileId: profile.id,
    scope: ["fixture-document", "timeout-document"],
    enabled: true,
    allowedTools: [profile.tool.id],
  };
  const inspected = await inspectDockerCapabilities(
    app,
    "pi",
    env,
    [request],
    connections,
  );
  const config = {
    ...inspected.config,
    bundle: path.join(root, "bundle"),
    fixtureNative: false,
    docker: {
      profile: "container-native-1" as const,
      disclosure: inspected.disclosure,
      approval: approve(inspected.disclosure),
    },
  };
  const workflow = path.join(root, "workflow.json");
  await writeFile(workflow, JSON.stringify(config));
  return {
    root,
    home,
    skillPath,
    extension,
    local,
    app,
    env,
    connections,
    request,
    inspected,
    config,
    workflow,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("Docker HTTP inspection is secret-free and approval is exact, fresh and separate from Save/GET", async (t) => {
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
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const send = (route: string, body: unknown, method = "POST") =>
    fetch(url + route, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    let preparations = 0;
    const original = service.executor!.setup.bind(service.executor);
    t.mock.method(
      service.executor!,
      "setup",
      (
        harness: HarnessId,
        env: NodeJS.ProcessEnv,
        _prepare: unknown,
        approval: DockerCapabilityApproval,
      ) =>
        original(
          harness,
          env,
          async (_app, _harness, _env, _install, _signal, config) => {
            preparations++;
            assert.ok(config?.docker);
            await writeFile(
              f.workflow,
              JSON.stringify({
                ...config,
                bundle: path.join(f.root, "bundle"),
                fixtureNative: false,
              }),
            );
            return f.workflow;
          },
          approval,
        ),
    );
    t.mock.method(DockerExecutor.prototype, "check", async () => {});
    const selection = {
      version: 2,
      workflow: "docker",
      harness: "pi",
      reviewer: f.app.reviewer,
    };
    assert.equal(
      (
        await send(
          "/settings/harness",
          {
            ...selection,
            reviewer: { skillPath: f.skillPath, model: f.app.reviewer.model },
          },
          "PATCH",
        )
      ).status,
      200,
    );
    const before = service.db.getSettings();
    for (const route of [
      "/state",
      "/settings/harness",
      "/settings/execution",
      "/settings/integrations",
    ])
      assert.equal((await fetch(url + route)).status, 200);
    assert.equal(preparations, 0);
    assert.equal(
      (
        await send("/settings/execution/setup", {
          harness: "pi",
          confirmation: dockerSetupConfirmation,
        })
      ).status,
      409,
    );
    assert.equal(preparations, 0);
    assert.equal(
      (await send("/settings/integrations/discover", { harness: "claude" }))
        .status,
      200,
    );
    const response = await send("/settings/execution/inspect", {
      harness: "pi",
      localConnections: [f.request],
    });
    assert.equal(response.status, 200);
    const disclosure = (await response.json()) as DockerCapabilityDisclosure;
    const text = JSON.stringify(disclosure);
    assert.doesNotMatch(
      text,
      /MODEL_SOURCE_CANARY|REFRESH_SOURCE_CANARY|BUSINESS_SOURCE_CANARY|HOST_BUSINESS_CANARY/,
    );
    assert.ok(
      disclosure.resources.some((item) =>
        item.target.startsWith(".agents/skills/"),
      ),
    );
    assert.equal(disclosure.customizations[0].kind, "extensions");
    assert.equal(disclosure.authentication[0].presence, "present");
    assert.equal(disclosure.authentication[0].tested, false);
    assert.equal(disclosure.localConnections[0].connected, false);
    const approval = approve(disclosure);
    for (const rejected of [
      undefined,
      { ...approval, confirmation: "yes" },
      { ...approval, customizations: [] },
      { ...approval, credentialExposures: [] },
      { ...approval, digest: "old" },
    ]) {
      assert.equal(
        (
          await send("/settings/execution/setup", {
            harness: "pi",
            confirmation: dockerSetupConfirmation,
            approval: rejected,
          })
        ).status,
        409,
      );
      assert.equal(preparations, 0);
    }
    await writeFile(f.extension, 'throw Error("changed operator extension")');
    assert.equal(
      (
        await send("/settings/execution/setup", {
          harness: "pi",
          confirmation: dockerSetupConfirmation,
          approval,
        })
      ).status,
      409,
    );
    assert.equal(preparations, 0);
    await writeFile(
      f.extension,
      'import {writeFile} from "node:fs/promises"; await writeFile("/scratch/approved-ran", "container only"); export default function () {}\n',
    );
    assert.equal(
      (
        await send("/settings/execution/setup", {
          harness: "pi",
          confirmation: dockerSetupConfirmation,
          approval,
        })
      ).status,
      200,
    );
    assert.equal(preparations, 1);
    assert.deepEqual(service.db.getSettings().automation, before.automation);
    const captured = service.executor!.capture(f.app.reviewer);
    await writeFile(f.extension, "CHANGED AFTER CAPTURE");
    await writeFile(
      path.join(f.home, "skill/rubric.md"),
      "Changed after capture",
    );
    const loaded = await loadWorkflow(f.workflow, f.skillPath, true);
    assert.equal(loaded.snapshot.digest, captured.execution!.digest);
    assert.ok(
      loaded.files.some((item) => item.content === "Original frozen rubric"),
    );
    assert.equal(loaded.config.docker!.approval.digest, disclosure.digest);
    await assert.rejects(readFile(path.join(f.root, "approved-ran")));
    assert.match(
      await readFile(path.join(f.home, ".pi/agent/auth.json"), "utf8"),
      /REFRESH_SOURCE_CANARY/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await f.close();
  }
});

test("Docker frozen grants deny changed approval, stdio dependency/auth forms and old captures before preparation", async () => {
  const f = await fixture();
  try {
    const d = f.inspected.disclosure;
    requireDockerApproval(d, approve(d));
    assert.throws(
      () => requireDockerApproval({ ...d, customizations: [] }, approve(d)),
      /approval/,
    );
    for (const record of [
      { command: "npx", args: ["download-me"] },
      { command: "node", args: [f.local], env: { TOKEN: "DO_NOT_COPY" } },
      { command: "node", args: [f.local, "--extra"] },
    ]) {
      await writeFile(
        path.join(f.home, ".claude.json"),
        JSON.stringify({ mcpServers: { local: record } }),
      );
      const connections = await discoverNativeMcp({ harness: "claude" }, f.env);
      await assert.rejects(
        inspectDockerCapabilities(
          f.app,
          "pi",
          f.env,
          [{ ...f.request, id: connections[0].id }],
          connections,
        ),
        /stdio/,
      );
    }
    const old = { ...f.config, docker: undefined };
    await writeFile(f.workflow, JSON.stringify(old));
    const executor = (await DockerExecutor.open({
      ...f.app,
      workflowConfigPath: f.workflow,
    }))!;
    let prepared = false;
    try {
      assert.equal(executor.status().status, "unavailable");
      await assert.rejects(
        executor.execute({
          runId: "old",
          settings: executor.capture(f.app.reviewer),
          prepare: async () => {
            prepared = true;
            return "unused";
          },
          metadata: {},
          prompt: "",
          diff: "",
          schema: reviewSchema,
        }),
        /predates/,
      );
      assert.equal(prepared, false);
    } finally {
      await executor.close();
    }
  } finally {
    await f.close();
  }
});

test("Docker minimum own-model projection removes refresh and other harness credentials", () => {
  const credentials = fixtureCredentials();
  credentials.claude.claudeAiOauth.refreshToken = "CLAUDE_REFRESH_CANARY";
  credentials.codex.tokens.refresh_token = "CODEX_REFRESH_CANARY";
  const selected = selectedCredentials(credentials, {
    harness: "pi",
    nested: [],
  });
  assert.equal(selected.pi!.access, credentials.pi!.access);
  assert.equal(selected.claude.claudeAiOauth.accessToken, "");
  assert.equal(selected.codex.tokens.access_token, "");
  assert.equal(selected.codex.tokens.id_token, "");
  assert.doesNotMatch(JSON.stringify(selected), /REFRESH_CANARY/);
});

test(
  "actual Docker disposable writes, contained approved extension and stdio invocation with exact denials",
  { skip: process.env.PR_REVIEW_DOCKER_TESTS !== "1", timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      for (const enabled of [true, false]) {
        const inspected = await inspectDockerCapabilities(
          f.app,
          "pi",
          f.env,
          [{ ...f.request, enabled }],
          f.connections,
        );
        await writeFile(
          f.workflow,
          JSON.stringify({
            ...inspected.config,
            bundle: path.join(f.root, "bundle"),
            fixtureNative: false,
            docker: {
              profile: "container-native-1",
              disclosure: inspected.disclosure,
              approval: approve(inspected.disclosure),
            },
          }),
        );
        let diagnostic = "";
        const executor = (await DockerExecutor.open(
          { ...f.app, workflowConfigPath: f.workflow },
          undefined,
          (text) => {
            diagnostic += text;
          },
        ))!;
        try {
          const result = await executor
            .execute({
              kind: "review",
              runId: "capabilities",
              settings: executor.capture(f.app.reviewer),
              prepare: async () => path.join(f.root, "source"),
              metadata: {},
              prompt: enabled
                ? "Clearly labeled synthetic native harness fixture"
                : "LOCAL_DENIED",
              diff: "fixture",
              schema: reviewSchema,
            })
            .catch((error) => {
              throw new Error(`${error.message}: ${diagnostic}`);
            });
          assert.match(
            (result.value as { rationale: string }).rationale,
            /real stdio invocation/,
          );
          assert.equal(
            await readFile(
              path.join(f.root, "source/checkout/code.txt"),
              "utf8",
            ),
            "pinned source",
          );
          assert.doesNotMatch(
            JSON.stringify(result),
            /REFRESH_SOURCE_CANARY|BUSINESS_SOURCE_CANARY|synthetic-model-only/,
          );
        } finally {
          await executor.close();
        }
      }
    } finally {
      await f.close();
    }
  },
);

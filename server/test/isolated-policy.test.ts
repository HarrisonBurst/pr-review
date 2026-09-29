import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixtures/isolated-context.js";
import { providerFixture } from "./fixtures/read-provider-context.js";
import { localTools } from "../execution/local-tools.js";
import { integrationSnapshot } from "../integrations.js";
import { knownMcpProfiles } from "../mcp-profiles.js";
import { readSchemas } from "../read-providers.js";
import type { HarnessId } from "../../shared/contracts.js";
import profileSchema from "../mcp-profiles/profile.schema.json" with { type: "json" };
import { validateSchema } from "../schema.js";
import { isolatedEnvironment } from "../execution/isolated-auth.js";
import { nativeConfiguration } from "../execution/native-settings.js";

test("policy HTTP fixture reuses native MCP configuration without manifest authoring", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.home, "mcp.json");
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          documents: {
            type: "http",
            url: "https://documents.example/mcp",
            headers: { Authorization: "Bearer SYNTHETIC_CONNECTION_CANARY" },
          },
        },
      }),
    );
    const response = await f.send("/settings/integrations/discover", {
      harness: "claude",
      path: file,
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    await f.close();
  }
});

test("policy HTTP fixture disables installed executable customizations instead of rejecting them", async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.home, ".pi/agent/settings.json"),
      JSON.stringify({
        extensions: ["./disabled.ts"],
        packages: ["npm:disabled"],
        defaultProjectTrust: "always",
      }),
    );
    const response = await f.send("/settings/harness", f.selection, "PATCH");
    assert.equal(response.status, 200, await response.text());
  } finally {
    await f.close();
  }
});

test("policy HTTP fixture captures the trusted native library beyond the selected entry", async () => {
  const f = await fixture();
  try {
    const dir = path.join(f.home, ".agents/skills/library-fixture");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: library-fixture\ndescription: Synthetic trusted instructions\n---\nRead [resource](resource.md).\n",
    );
    await writeFile(path.join(dir, "resource.md"), "LIBRARY SNAPSHOT");
    assert.equal(
      (await f.send("/settings/harness", f.selection, "PATCH")).status,
      200,
    );
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    const run = (await f.detail()).runs[0];
    assert.ok(
      (run.reviewer.skillExecution as any).roles.main.policy?.library.skills
        .length,
    );
  } finally {
    await f.close();
  }
});

test("policy HTTP capture dispatch replaces native HOME and strips ambient credentials", async () => {
  const f = await fixture();
  try {
    Object.assign(f.env, {
      UNRELATED_BUSINESS_SECRET: "SYNTHETIC_AMBIENT_CANARY",
    });
    await f.script(
      "claude",
      `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(f.env.FIXTURE_LOG)}, JSON.stringify({home:process.env.HOME,ambient:process.env.UNRELATED_BUSINESS_SECRET})+'\\n'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{overview:'fixture',body:'fixture',verdict:'COMMENT',rationale:'fixture',findings:[]}}));`,
    );
    assert.equal(
      (
        await f.send(
          "/settings/harness",
          { ...f.selection, harness: "claude", additional: [] },
          "PATCH",
        )
      ).status,
      200,
    );
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    await f.dispatch();
    const call = (await f.calls())[0];
    assert.notEqual(call.home, f.home);
    assert.equal(call.ambient, undefined);
  } finally {
    await f.close();
  }
});

for (const harness of ["claude", "codex"] as const)
  test(`policy native ${harness} import, explicit Load/Test and captured gateway deny direct calls and drift`, async () => {
    const p = await providerFixture();
    const f = await fixture(p.providers);
    let tools: Awaited<ReturnType<typeof localTools>> | undefined;
    try {
      const source = path.join(
        f.home,
        harness === "claude" ? "native.json" : "native.toml",
      );
      const secret = "synthetic-business-credential-never-project";
      const content =
        harness === "claude"
          ? JSON.stringify({
              mcpServers: {
                documents: {
                  type: "http",
                  url: "https://documents.example.invalid/mcp",
                  headers: { Authorization: `Bearer ${secret}` },
                },
                local: { command: "node", args: ["must-not-execute.js"] },
                oauth: { type: "sse", url: "https://oauth.example/mcp" },
              },
            })
          : `[mcp_servers.documents]
url="https://documents.example.invalid/mcp"
[mcp_servers.documents.http_headers]
Authorization="Bearer ${secret}"
[mcp_servers.local]
command="node"
args=["must-not-execute.js"]
`;
      await writeFile(source, content);
      const discovered = await (
        await f.send("/settings/integrations/discover", {
          harness,
          path: source,
        })
      ).json();
      const native = discovered.connections.find(
        (item: any) => item.config.serverName === "documents",
      );
      assert.ok(native.config.native);
      assert.equal(native.config.enabled, false);
      assert.equal(
        discovered.connections.find(
          (item: any) => item.config.serverName === "local",
        ).status,
        "unsupported",
      );
      assert.doesNotMatch(JSON.stringify(discovered), new RegExp(secret));
      assert.equal(p.requests.length, 0);
      for (let i = 0; i < 2; i++) {
        await f.send("/settings/integrations");
        await f.send("/state");
      }
      assert.equal(p.requests.length, 0);
      const id = native.config.id;
      const route = `/settings/integrations/${id}`;
      assert.equal(
        (
          await f.send("/settings/integrations/import-native", {
            id,
            profileId: "pr-review-documents/1",
            scope: ["fixture-document"],
          })
        ).status,
        200,
      );
      await f.send(
        route,
        { enabled: true, allowedTools: ["document", "unknown"] },
        "PATCH",
      );
      assert.equal(
        f.service
          .getIntegrations()
          .connections.find((item) => item.config.id === id)!.tools[0].state,
        "unsupported",
      );
      const loaded = await (await f.send(`${route}/load-tools`, {})).json();
      const after = loaded.connections.find(
        (item: any) => item.config.id === id,
      );
      assert.equal(after.config.inventory.status, "loaded");
      assert.equal(after.config.enabled, false);
      assert.deepEqual(after.config.allowedTools, []);
      assert.equal(after.config.inventory.connected, false);
      assert.equal(after.config.inventory.scope, "synthetic_transport");
      const result = await (await f.send(`${route}/test`, {})).json();
      assert.equal(result.status, "ready");
      assert.equal(result.connected, false);
      assert.equal(result.scope, "synthetic_transport");
      assert.equal(result.containmentVerified, false);
      assert.equal(
        (await f.send("/settings/harness", f.selection, "PATCH")).status,
        200,
      );
      await f.send(
        route,
        { enabled: true, allowedTools: ["document"] },
        "PATCH",
      );
      const snapshot = integrationSnapshot(f.service.getIntegrations());
      assert.deepEqual(
        snapshot.connections.find((item) => item.id === id)!.allowedTools,
        ["document"],
      );
      await f.send("/sync", {});
      await f.send(`${f.pr}/review`, {});
      assert.deepEqual(
        (await f.detail()).runs[0].integrationSnapshot,
        snapshot,
      );
      await f.dispatch();
      const completed = (await f.detail()).runs[0];
      assert.equal(completed.status, "completed", completed.error ?? "");
      assert.deepEqual(
        completed.progress!.entries!.map((item) => item.status),
        ["completed", "completed", "completed"],
      );
      assert.equal((await f.detail()).drafts.length, 1);
      assert.equal((await f.calls()).length, 3);
      const questionRequest = {
        mode: "explain",
        range: {
          path: "src/demo.ts",
          from: { side: "RIGHT", line: 2 },
          to: { side: "RIGHT", line: 2 },
          baseSha: "demo-base-sha-1",
          headSha: "demo-head-sha-1",
        },
      };
      await f.send(`${f.pr}/questions`, questionRequest);
      const parent = (await f.detail()).questions[0];
      assert.deepEqual(parent.integrationSnapshot, snapshot);
      await f.service.processQuestion(parent);
      assert.equal((await f.calls()).length, 4);
      tools = await localTools(f.root, true, p.providers, snapshot);
      const call = async (name: string, args: unknown) =>
        await (
          await fetch(tools!.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${tools!.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          })
        ).json();
      const count = p.requests.length;
      for (const [name, args] of [
        ["documents_delete", { id: "fixture-document" }],
        ["documents_get", { id: "other" }],
        [
          "documents_get",
          { id: "fixture-document", url: "https://evil.invalid" },
        ],
        ["Bash", { command: "touch marker" }],
        ["read_source", { path: source }],
      ] as const)
        assert.ok((await call(name, args)).error);
      assert.equal(p.requests.length, count);
      assert.match(
        JSON.stringify(await call("documents_get", { id: "fixture-document" })),
        /Untrusted synthetic document/,
      );
      await f.send(route, { enabled: false, allowedTools: [] }, "PATCH");
      await f.restart();
      assert.deepEqual(
        (await f.detail()).runs[0].integrationSnapshot,
        snapshot,
      );
      assert.equal(
        f.service
          .getIntegrations()
          .connections.find((item) => item.config.id === id)!.config.enabled,
        false,
      );
      await f.send(`${f.pr}/questions`, {
        ...questionRequest,
        parentId: parent.id,
        question: "Captured read follow-up",
      });
      const child = (await f.detail()).questions.find(
        (item) => item.parentId === parent.id,
      )!;
      assert.deepEqual(child.integrationSnapshot, snapshot);
      assert.deepEqual(child.reviewerSnapshot, parent.reviewerSnapshot);
      await f.service.processQuestion(child);
      assert.equal(
        (await f.detail()).questions.find((item) => item.id === child.id)!
          .status,
        "completed",
      );
      assert.equal((await f.calls()).length, 5);
      assert.equal(await readFile(source, "utf8"), content);
      p.mode("schema");
      const readsBeforeDrift = p.requests.filter(
        (item) => item.body?.method === "tools/call",
      ).length;
      assert.ok(
        (await call("documents_get", { id: "fixture-document" })).error,
      );
      assert.equal(
        p.requests.filter((item) => item.body?.method === "tools/call").length,
        readsBeforeDrift,
      );
      await assert.rejects(async () => {
        const next = await localTools(f.root, true, p.providers, snapshot);
        await next.close();
      }, /schema/);
      const changed = await (await f.send(`${route}/load-tools`, {})).json();
      assert.equal(
        changed.connections.find((item: any) => item.config.id === id).config
          .inventory.status,
        "changed",
      );
      assert.deepEqual(
        changed.connections.find((item: any) => item.config.id === id).config
          .allowedTools,
        [],
      );
      p.mode("normal");
      await writeFile(
        source,
        content.replace("documents.example.invalid", "changed.example.invalid"),
      );
      await assert.rejects(
        () => p.providers.session(snapshot, new AbortController().signal),
        /changed/,
      );
      const callsBeforeSourceDrift = p.requests.length;
      assert.ok(
        (await call("documents_get", { id: "fixture-document" })).error,
      );
      assert.equal(p.requests.length, callsBeforeSourceDrift);
      assert.doesNotMatch(JSON.stringify(await f.detail()), new RegExp(secret));
    } finally {
      await tools?.close();
      await f.close();
      await p.close();
    }
  });

test("policy registry pins a bounded resource schema, no executable contribution", () => {
  for (const profile of knownMcpProfiles) {
    validateSchema(profileSchema, profile);
    assert.deepEqual(profile.tool.inputSchema, readSchemas.documents);
    assert.equal(profile.transport, "stateless-http");
    assert.equal(profile.server.protocol, "2025-03-26");
    assert.deepEqual(profile.preset.allowedTools, [profile.tool.id]);
    assert.doesNotMatch(
      JSON.stringify(profile),
      /command|readOnlyHint|credentials/,
    );
  }
});

for (const harness of ["claude", "codex", "pi"] as HarnessId[])
  test(`policy ${harness} dispatch preserves static library and disables startup customization with scoped auth`, async () => {
    const f = await fixture();
    try {
      const nativeRoot = path.join(
        f.home,
        harness === "claude"
          ? ".claude"
          : harness === "codex"
            ? ".codex"
            : ".pi/agent",
      );
      const library = path.join(nativeRoot, "skills/library-fixture");
      await mkdir(library, { recursive: true });
      await writeFile(
        path.join(library, "SKILL.md"),
        "---\nname: native-library-fixture\ndescription: Trusted static fixture\n---\nSee [reference](reference.md).\n",
      );
      await writeFile(
        path.join(library, "reference.md"),
        "FROZEN TRUSTED LIBRARY",
      );
      const marker = path.join(f.root, "startup-marker");
      const hook = `touch ${marker}`;
      await mkdir(path.join(nativeRoot, "extensions"), { recursive: true });
      await writeFile(
        path.join(nativeRoot, "extensions/startup.mjs"),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'EXECUTED')`,
      );
      await writeFile(
        path.join(
          nativeRoot,
          harness === "codex" ? "config.toml" : "settings.json",
        ),
        harness === "codex"
          ? `model="ignored-model"\napproval_policy="never"\n[features]\nhooks=true\napps=true\n`
          : JSON.stringify(
              harness === "claude"
                ? {
                    model: "ignored-model",
                    hooks: {
                      SessionStart: [
                        { hooks: [{ type: "command", command: hook }] },
                      ],
                    },
                    enabledPlugins: { "fixture@fixture": true },
                    permissions: { defaultMode: "bypassPermissions" },
                  }
                : {
                    defaultModel: "ignored-model",
                    packages: ["npm:must-not-install"],
                    extensions: ["./extensions/startup.mjs"],
                    defaultProjectTrust: "always",
                  },
            ),
      );
      Object.assign(f.env, {
        BUSINESS_SECRET: "AMBIENT_BUSINESS_CANARY",
        OPENAI_API_KEY: "UNSELECTED_API_KEY",
      });
      await f.script(
        harness,
        `const fs=require('node:fs');(async()=>{
      const args=process.argv.slice(2);const prompt=fs.readFileSync(0,'utf8');
      if(process.env.BUSINESS_SECRET || process.env.NODE_OPTIONS || process.env.OPENAI_API_KEY) throw Error('ambient env leaked');
      if(${JSON.stringify(harness)}!=='claude' && process.env.CLAUDE_CODE_OAUTH_TOKEN) throw Error('other harness credential leaked');
      if(process.env.HOME===${JSON.stringify(f.home)}) throw Error('native home retained');
      const call=async(name,arguments_)=>await (await fetch(process.env.PR_REVIEW_LOCAL_TOOLS,{method:'POST',headers:{authorization:'Bearer '+process.env.PR_REVIEW_LOCAL_TOKEN,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}})})).json();
      const file=prompt.split('\\n').find(line=>line.endsWith('/library-fixture/SKILL.md'));
      if(!file) throw Error('library unavailable');
      const loaded=await call('read_source',{path:file.replace('SKILL.md','reference.md')});
      if(loaded.result.content[0].text!=='FROZEN TRUSTED LIBRARY') throw Error('library drift');
      for(const name of ['bash','write','edit','spawn_agent','publish','documents_get']) if(!(await call(name,{})).error) throw Error('forbidden call accepted');
      if(!(await call('read_source',{path:process.env.HOME+'/auth.json'})).error) throw Error('auth root readable');
      fs.appendFileSync(${JSON.stringify(f.env.FIXTURE_LOG)},JSON.stringify({args,home:process.env.HOME,library:file,model:args[args.indexOf('--model')+1]})+'\\n');
      const value={overview:'Synthetic policy fixture',body:'one draft',rationale:'verified fixtures',verdict:'COMMENT',findings:[]};
      const line=x=>console.log(JSON.stringify(x));
      if(${JSON.stringify(harness)}==='claude')line({type:'result',subtype:'success',is_error:false,structured_output:value});
      else if(${JSON.stringify(harness)}==='codex'){line({type:'turn.started'});line({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}});line({type:'turn.completed'});}
      else {line({type:'agent_start'});line({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(value)}]}});line({type:'agent_end'});}
    })().catch(()=>process.exitCode=1);`,
      );
      const saved = await f.send(
        "/settings/harness",
        { ...f.selection, harness, additional: [] },
        "PATCH",
      );
      assert.equal(saved.status, 200, await saved.clone().text());
      const policy = (await saved.json()).capabilities[0].policy;
      assert.ok(policy.library.skills.length);
      assert.ok(
        policy.provenance.some((item: any) => item.state === "overridden"),
      );
      await f.send("/sync", {});
      await f.send(`${f.pr}/review`, {});
      await writeFile(path.join(library, "reference.md"), "CHANGED SOURCE");
      await f.restart();
      Object.assign(f.env, { NODE_OPTIONS: "--require=must-not-load" });
      await f.dispatch();
      const run = (await f.detail()).runs[0];
      assert.equal(run.status, "completed", run.error ?? "");
      assert.equal((await f.detail()).drafts.length, 1);
      assert.equal((await f.calls())[0].model, "main-fixture");
      await assert.rejects(() => access(marker));
      await assert.rejects(async () => access((await f.calls())[0].home));
      assert.doesNotMatch(
        JSON.stringify(run),
        /AMBIENT_BUSINESS_CANARY|UNSELECTED_API_KEY|SYNTHETIC_CLAUDE_MODEL_ONLY|synthetic-business-credential/,
      );
    } finally {
      await f.close();
    }
  });

test("policy missing/unsupported native auth is distinct from compatibility; no fallback or secret persistence", async () => {
  const f = await fixture();
  try {
    for (const harness of ["codex", "pi"] as const) {
      const root = path.join(f.home, `empty-${harness}`);
      await mkdir(root);
      const env = {
        ...f.env,
        ...(harness === "codex"
          ? { CODEX_HOME: root }
          : { PI_CODING_AGENT_DIR: root }),
      };
      const native = await nativeConfiguration(
        harness,
        "separated",
        harness === "pi" ? "openai-codex/fixture" : "fixture",
        env,
      );
      assert.ok(
        native.policy!.provenance.some(
          (item) =>
            item.capability === "model authentication" &&
            item.state === "missing",
        ),
      );
      await assert.rejects(
        () =>
          isolatedEnvironment(
            native.policy!,
            env,
            path.join(f.root, `projection-${harness}`),
          ),
        /missing, expired or unsupported/,
      );
    }
    await assert.rejects(
      () => nativeConfiguration("pi", "separated", "other/fixture", f.env),
      /openai-codex/,
    );
    await writeFile(
      path.join(f.home, ".codex/config.toml"),
      'cli_auth_credentials_store="keyring"',
    );
    await assert.rejects(
      () => nativeConfiguration("codex", "separated", "fixture", f.env),
      /keyring/,
    );
    await f.script(
      "claude",
      `const fs=require('node:fs');fs.readFileSync(0,'utf8');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{overview:'fixture',body:process.env.CLAUDE_CODE_OAUTH_TOKEN,rationale:'fixture',verdict:'COMMENT',findings:[]}}));`,
    );
    await f.send(
      "/settings/harness",
      { ...f.selection, harness: "claude", additional: [] },
      "PATCH",
    );
    await f.send("/sync", {});
    await f.send(`${f.pr}/review`, {});
    await f.dispatch();
    const detail = await f.detail();
    assert.equal(detail.runs[0].status, "failed");
    assert.match(detail.runs[0].error!, /authentication material/);
    assert.equal(detail.drafts.length, 0);
    assert.doesNotMatch(JSON.stringify(detail), /SYNTHETIC_CLAUDE_MODEL_ONLY/);
    await f.restart();
    const bytes = await readFile(f.app.databasePath);
    assert.equal(
      bytes.includes(Buffer.from("SYNTHETIC_CLAUDE_MODEL_ONLY")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("policy trusted native resources diagnose executable activation without loading it", async () => {
  const f = await fixture();
  try {
    const root = path.join(f.home, ".pi/agent");
    const dir = path.join(f.home, "static-disabled-plugin/skills/safe");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: safe\ndescription: Explicit static plugin resource\n---\nInstructions only.",
    );
    const unsafe = path.join(root, "skills/unsafe");
    await mkdir(unsafe, { recursive: true });
    await writeFile(
      path.join(unsafe, "SKILL.md"),
      "---\nname: unsafe\ndescription: Unsafe activation\ncontext: fork\nhooks: {}\n---\n!`touch marker`",
    );
    await writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({
        skills: [path.dirname(dir)],
        packages: ["npm:disabled"],
        extensions: ["./must-not-execute.ts"],
      }),
    );
    const saved = await (
      await f.send("/settings/harness", f.selection, "PATCH")
    ).json();
    const library = saved.capabilities[0].policy.library;
    assert.ok(
      library.skills.some(
        (skill: any) => skill.path === path.join(dir, "SKILL.md"),
      ),
    );
    assert.ok(
      !library.skills.some(
        (skill: any) => skill.path === path.join(unsafe, "SKILL.md"),
      ),
    );
    assert.match(library.diagnostics.join(" "), /executable skill activation/);
    assert.equal(library.loading, "native-pi");
    await writeFile(f.skillPath, "Requires hook to run this review.");
    const required = await (
      await f.send("/settings/harness", f.selection, "PATCH")
    ).json();
    assert.equal(required.effective, null);
    assert.match(required.diagnostics.join(" "), /required non-orchestration/);
  } finally {
    await f.close();
  }
});

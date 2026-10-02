import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
} from "node:fs/promises";
import http from "node:http";
import zlib from "node:zlib";
import { HostExecutor } from "../execution/host.js";
import { loadSkill } from "../execution/skill.js";
import { fixtureCredentials } from "../execution/auth.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { DockerExecutor } from "../execution/executor.js";
import type { FixtureInference } from "../execution/broker.js";
import { supportedImage } from "../execution/policy.js";
import { loadConfig, type AppConfig } from "../config.js";
import { captureDockerCapabilities } from "../execution/docker-capabilities.js";
import { dockerApprovalConfirmation } from "../../shared/contracts.js";
import { runCommand } from "../util.js";
import { checkoutEnvironment } from "../execution/adapters.js";
import { stringify } from "smol-toml";
import { reviewSchema, validateReviewResult } from "../review-output.js";
import { discoverNativeMcp } from "../native-mcp.js";
import { knownMcpProfiles } from "../mcp-profiles.js";

async function prepareNativeFixture(app: AppConfig, local = false) {
  const config = JSON.parse(await readFile(app.workflowConfigPath!, "utf8"));
  const env = { HOME: app.dataDir };
  const profile = knownMcpProfiles[0];
  if (local) {
    const entry = path.join(app.dataDir, "local/server.mjs");
    await mkdir(path.dirname(entry));
    await writeFile(
      entry,
      `import readline from 'node:readline';
const profile=${JSON.stringify(profile)};
for await (const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line); if(!request.id) continue;
 const result=request.method==='initialize'?{protocolVersion:profile.server.protocol,serverInfo:{name:profile.server.name,version:profile.server.version},capabilities:{tools:{}}}:request.method==='tools/list'?{tools:[{name:profile.tool.name,inputSchema:profile.tool.inputSchema}]}:{content:[{type:'text',text:'native local fixture'}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
}
`,
    );
    await writeFile(
      path.join(app.dataDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { local: { command: "node", args: [entry] } },
      }),
    );
  }
  const connections = local
    ? await discoverNativeMcp({ harness: "claude" }, env)
    : [];
  const captured = await captureDockerCapabilities(
    app,
    config,
    env,
    connections.map((connection) => ({
      id: connection.id,
      profileId: profile.id,
      scope: ["fixture-document"],
      enabled: true,
      allowedTools: [profile.tool.id],
    })),
    connections,
  );
  const disclosure = captured.disclosure;
  await writeFile(
    app.workflowConfigPath!,
    JSON.stringify({
      ...captured.config,
      docker: {
        profile: "container-native-1",
        disclosure,
        approval: {
          digest: disclosure.digest,
          customizations: disclosure.customizations.map((item) => item.id),
          credentialExposures: disclosure.authentication.map(
            (item) => item.harness,
          ),
          confirmation: dockerApprovalConfirmation,
        },
      },
    }),
  );
  const git = async (...args: string[]) => {
    const result = await runCommand("/usr/bin/git", args, {
      cwd: path.join(app.dataDir, "source/checkout"),
      env: checkoutEnvironment({ HOME: app.dataDir, PATH: "/usr/bin:/bin" }),
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-b", "main");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "synthetic pinned source",
  );
  const sha = await git("rev-parse", "HEAD");
  return { baseRefOid: sha, headRefOid: sha };
}

const bundle = process.env.PR_REVIEW_NATIVE_BUNDLE;
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const value = { answer: "Clearly labeled native fixture result" };
const sse = (events: Record<string, unknown>[]) => ({
  status: 200,
  contentType: "text/event-stream",
  body: events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join(""),
});

export function responsesFixture(text: string) {
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    output: [item],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  return sse([
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: text,
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      text,
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      part: item.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]);
}

function execFixture(input: string) {
  const item = {
    id: "ct_fixture",
    type: "custom_tool_call",
    call_id: "call_fixture",
    name: "exec",
    input,
    status: "completed",
  };
  return sse([
    {
      type: "response.created",
      response: { id: "resp_tool", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, input: "", status: "in_progress" },
    },
    {
      type: "response.custom_tool_call_input.delta",
      output_index: 0,
      item_id: item.id,
      delta: input,
    },
    {
      type: "response.custom_tool_call_input.done",
      output_index: 0,
      item_id: item.id,
      input,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ]);
}

function functionFixture(name: string, args: unknown) {
  const item = {
    id: "fc_fixture",
    type: "function_call",
    call_id: "call_fixture",
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  return sse([
    {
      type: "response.created",
      response: { id: "resp_tool", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_tool",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ]);
}

for (const harness of ["claude", "codex", "pi"] as const)
  test(
    `native ${harness} executes inside Docker against synthetic inference only`,
    { skip: !bundle, timeout: 180000 },
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), `pr-review-native-${harness}-`),
      );
      await mkdir(path.join(root, "source/checkout/.pi"), { recursive: true });
      await writeFile(
        path.join(root, "source/checkout/AGENTS.md"),
        "UNTRUSTED PR CONFIG",
      );
      await writeFile(
        path.join(root, "source/checkout/.pi/settings.json"),
        '{"extensions":["./attack.mjs"]}',
      );
      await writeFile(
        path.join(root, "source/checkout/code.txt"),
        "PINNED_SYNTHETIC_SOURCE",
      );
      const skillPath = path.join(root, "audit/SKILL.md");
      await mkdir(path.dirname(skillPath));
      await writeFile(
        skillPath,
        "---\nname: pr-review\ndescription: Deterministic synthetic native review fixture\n---\nPreserve the configured nested workflow and read pinned source.\n",
      );
      const hook = path.join(root, "hook.mjs");
      const probe = path.join(root, "probe.mjs");
      const extension = path.join(root, "extension.mjs");
      const plugin = path.join(root, "operator-plugin");
      if (harness === "pi") {
        await mkdir(plugin);
        await writeFile(
          path.join(plugin, "package.json"),
          JSON.stringify({
            name: "synthetic-native-plugin",
            pi: { extensions: ["extension.mjs"] },
          }),
        );
        await writeFile(
          path.join(plugin, "extension.mjs"),
          'import {writeFileSync} from "node:fs"; export default function () { writeFileSync("/scratch/TRUSTED_PLUGIN", "portable local plugin"); }',
        );
      }
      await writeFile(
        hook,
        'import {writeFileSync} from "node:fs"; writeFileSync("/scratch/TRUSTED_HOOK", "trusted");',
      );
      await writeFile(
        probe,
        (
          await readFile(
            new URL("fixtures/native-probe.mjs", import.meta.url),
            "utf8",
          )
        ).replace("__HOST_FILE__", hook),
      );
      await writeFile(
        extension,
        `import {writeFileSync} from 'node:fs'; import {execFile} from 'node:child_process'; export default function(pi){writeFileSync('/scratch/TRUSTED_HOOK','trusted'); pi.registerTool({name:'fixture_workflow',label:'Explicit user fixture',description:'Run the configured synthetic workflow',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){const text=await new Promise((resolve,reject)=>execFile('/usr/local/bin/node',['/scratch/resources/probe.mjs'],{timeout:60000},(error,stdout)=>error?reject(error):resolve(stdout)));return {content:[{type:'text',text}],details:{}};}});}`,
      );
      const settingsPath = path.join(
        root,
        harness === "codex" ? "settings.toml" : "settings.json",
      );
      const hooks = {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "node /scratch/resources/hook.mjs" },
            ],
          },
        ],
      };
      await writeFile(
        settingsPath,
        harness === "codex"
          ? stringify({
              features: { hooks: true, apps: false },
              hooks: {
                ...hooks,
                state: {
                  "/scratch/.codex/config.toml:session_start:0:0": {
                    trusted_hash:
                      "sha256:374df6669a7758bc78487398ddca70af97851a665ecf7be9b941e20cd4d1bc09",
                  },
                },
              },
            })
          : JSON.stringify(
              harness === "claude"
                ? { hooks }
                : {
                    extensions: ["./extensions/native-fixture.mjs"],
                    packages: [plugin],
                  },
            ),
      );
      const files = [
        { path: hook, target: "resources/hook.mjs" },
        { path: probe, target: "resources/probe.mjs" },
        {
          path: settingsPath,
          target:
            harness === "claude"
              ? ".claude/settings.json"
              : harness === "codex"
                ? ".codex/config.toml"
                : ".pi/agent/settings.json",
        },
        ...(harness === "pi"
          ? [
              {
                path: extension,
                target: ".pi/agent/extensions/native-fixture.mjs",
              },
            ]
          : []),
      ];
      const workflowConfigPath = path.join(root, "workflow.json");
      await writeFile(
        workflowConfigPath,
        JSON.stringify({
          version: 2,
          harness,
          nested: ["codex"],
          files,
          image: supportedImage,
          bundle,
          auth: "fixture",
          fixtureNative: true,
          models: { claude: "claude-fable-5", codex: "gpt-6-astra" },
          effort: "low",
        }),
      );
      const app = {
        ...loadConfig({
          demo: true,
          dataDir: root,
          databasePath: path.join(root, "app.sqlite"),
          workflowConfigPath,
          reviewer: { skillPath, model: null, additionalInstructions: "" },
        }),
        workflowConfigPath,
      };
      const pins = await prepareNativeFixture(app, true);
      const requests: string[] = [];
      let structured = false;
      let invoked = false;
      let observed = false;
      let nested = 0;
      const inference: FixtureInference = async (provider, body) => {
        requests.push(provider);
        if (
          provider === "codex" &&
          body.input.some(
            (part: any) =>
              part.role === "user" &&
              JSON.stringify(part.content).includes("SYNTHETIC_NESTED"),
          )
        ) {
          nested++;
          return responsesFixture("nested-fixture-result");
        }
        assert.equal(provider, harness);
        const outputs =
          provider === "claude"
            ? body.messages.flatMap((message: any) =>
                Array.isArray(message.content)
                  ? message.content.filter(
                      (part: any) => part.type === "tool_result",
                    )
                  : [],
              )
            : body.input.filter((part: any) =>
                ["function_call_output", "custom_tool_call_output"].includes(
                  part.type,
                ),
              );
        if (JSON.stringify(outputs).includes("NATIVE_WORKFLOW_OK"))
          observed = true;
        if (provider !== "claude") {
          if (!invoked) {
            invoked = true;
            if (provider === "pi")
              return functionFixture("fixture_workflow", {});
            const tools = (
              body.tools ??
              body.input.flatMap((part: any) =>
                part.type === "additional_tools" ? part.tools : [],
              )
            ).flatMap((tool: any) => tool.tools ?? [tool]);
            assert.ok(tools.some((tool: any) => tool.name === "exec"));
            return execFixture(
              'text(await tools.exec_command({cmd:"node /scratch/resources/probe.mjs",yield_time_ms:1000,max_output_tokens:1000,login:false}))',
            );
          }
          if (!observed && provider === "codex") {
            const text = JSON.stringify(outputs);
            const session = /session(?: ID |[_ ]id[\\"\\\\: ]+)([0-9]+)/i.exec(
              text,
            );
            if (session)
              return execFixture(
                `text(await tools.write_stdin({session_id:${Number(session[1])},chars:"",yield_time_ms:1000,max_output_tokens:1000}))`,
              );
            diagnostics.push(text);
          }
          return responsesFixture(JSON.stringify(value));
        }
        const tool = body.tools?.find(
          (tool: any) => tool.name === "StructuredOutput",
        );
        const probeCall = !invoked;
        invoked = true;
        const call = probeCall || Boolean(tool && !structured);
        if (!probeCall) structured ||= call;
        const argumentsValue = probeCall
          ? { command: "node /scratch/resources/probe.mjs", timeout: 90000 }
          : value;
        const block = call
          ? {
              type: "tool_use",
              id: "tool_fixture",
              name: probeCall ? "Bash" : "StructuredOutput",
              input: {},
            }
          : { type: "text", text: "" };
        return sse([
          {
            type: "message_start",
            message: {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: block },
          {
            type: "content_block_delta",
            index: 0,
            delta: call
              ? {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(argumentsValue),
                }
              : { type: "text_delta", text: JSON.stringify(value) },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason: call ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]);
      };
      const diagnostics: string[] = [];
      const executor = (await DockerExecutor.open(
        app,
        async (provider, body) => {
          try {
            return await inference(provider, body);
          } catch (error) {
            diagnostics.push(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        },
        (text) => diagnostics.push(text),
      ))!;
      try {
        assert.equal(executor.status().status, "configured");
        const result = await executor.execute({
          runId: `native-${harness}`,
          settings: executor.capture(app.reviewer),
          prepare: async () => path.join(root, "source"),
          metadata: { number: 42, ...pins },
          diff: "Synthetic fixture",
          schema,
          signal: AbortSignal.timeout(120000),
          prompt:
            "This is a focused synthetic question, not a full review. Return the requested JSON result.",
        });
        assert.deepEqual(result.value, value, diagnostics.join("\n"));
        assert.equal(
          await readFile(path.join(root, "source/checkout/code.txt"), "utf8"),
          "PINNED_SYNTHETIC_SOURCE",
        );
        assert.match(result.log, /"localReads":1/);
        assert.match(result.log, /"localDenials":2/);
        assert.ok(requests.length > 0);
        assert.ok(
          nested > 0,
          "The configured nested Codex process must actually request synthetic inference",
        );
        assert.equal(
          observed,
          true,
          "The actual native tool must report the trusted hook, pinned source, denied host access and nested result",
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : error}\n${diagnostics.join("\n")}`,
        );
      } finally {
        await executor.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

function claudeToolFixture(name: string | null, input: unknown) {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_checker",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: name
        ? { type: "tool_use", id: "tool_checker", name, input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: name
        ? { type: "input_json_delta", partial_json: JSON.stringify(input) }
        : { type: "text_delta", text: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: name ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

for (const harness of ["claude", "codex", "pi"] as const)
  test(
    `native v2 ${harness} calls the canonical checker inside Docker and retains independent skill resources`,
    { skip: !bundle, timeout: 180000 },
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), `review-checker-native-${harness}-`),
      );
      const skillPath = path.join(root, "audit/ENTRY.md");
      await mkdir(path.dirname(skillPath));
      await writeFile(
        skillPath,
        "---\nname: independent-audit\ndescription: Explicit synthetic checker fixture\n---\nRead [rubric](rubric.md). Return the supplied structured review.\n",
      );
      await writeFile(path.join(root, "audit/rubric.md"), "COMPANION FIXTURE");
      await mkdir(path.join(root, "source/checkout"), { recursive: true });
      const workflowConfigPath = path.join(root, "workflow.json");
      await writeFile(
        workflowConfigPath,
        JSON.stringify({
          version: 2,
          harness,
          nested: [],
          skillPath,
          image: supportedImage,
          bundle,
          auth: "fixture",
          fixtureNative: true,
          models: { claude: "claude-fable-5", codex: "gpt-6-astra" },
          effort: "low",
        }),
      );
      const app = {
        ...loadConfig({
          demo: true,
          dataDir: root,
          databasePath: path.join(root, "app.sqlite"),
          workflowConfigPath,
          reviewer: { skillPath, model: null, additionalInstructions: "" },
        }),
        workflowConfigPath,
      };
      const pins = await prepareNativeFixture(app);
      const review = {
        overview: "# Independent overview\nNo prescribed headings.",
        body: "Synthetic review body",
        findings: [],
        verdict: "COMMENT",
        rationale: "Explicit fixture",
        humanReviewRequest: null,
      };
      let calls = 0;
      let checked = false;
      let structured = false;
      const diagnostics: string[] = [];
      const executor = (await DockerExecutor.open(
        app,
        async (provider, body) => {
          assert.equal(provider, harness);
          const serialized = JSON.stringify(body);
          const outputs =
            provider === "claude"
              ? body.messages.flatMap((message: any) =>
                  Array.isArray(message.content)
                    ? message.content.filter(
                        (part: any) => part.type === "tool_result",
                      )
                    : [],
                )
              : body.input.filter((part: any) =>
                  ["function_call_output", "custom_tool_call_output"].includes(
                    part.type,
                  ),
                );
          if (outputs.length) diagnostics.push(JSON.stringify(outputs));
          if (serialized.replaceAll("\\", "").includes('"status":"valid"'))
            checked = true;
          const tools = (body.tools ?? []).flatMap(
            (tool: any) => tool.tools ?? [tool],
          );
          if (calls++ === 0) {
            const name = tools.find((tool: any) =>
              /check_review_output$/.test(tool.name),
            )?.name;
            if (provider === "claude") {
              if (!name) {
                diagnostics.push(JSON.stringify(tools));
                throw new Error("Native Claude checker tool missing");
              }
              return claudeToolFixture(name, {
                candidate: JSON.stringify(review),
              });
            }
            if (provider === "pi")
              return functionFixture("check_review_output", {
                candidate: JSON.stringify(review),
              });
            if (name)
              return functionFixture(name, {
                candidate: JSON.stringify(review),
              });
            return execFixture(
              `text(await tools.mcp__snapshot__check_review_output(${JSON.stringify({ candidate: JSON.stringify(review) })}))`,
            );
          }
          if (provider === "claude") {
            if (
              !structured &&
              tools.some((tool: any) => tool.name === "StructuredOutput")
            ) {
              structured = true;
              return claudeToolFixture("StructuredOutput", review);
            }
            return claudeToolFixture(null, review);
          }
          return responsesFixture(JSON.stringify(review));
        },
        (text) => diagnostics.push(text),
      ))!;
      try {
        const result = await executor.execute({
          kind: "review",
          runId: `checker-${harness}`,
          settings: executor.capture(app.reviewer),
          prepare: async () => path.join(root, "source"),
          metadata: pins,
          diff: "fixture",
          schema: reviewSchema,
          prompt:
            "Explicit synthetic review. Use check_review_output before returning the supplied payload.",
          signal: AbortSignal.timeout(120000),
        });
        assert.deepEqual(validateReviewResult(result.value), review);
        assert.ok(checked, diagnostics.join("\n"));
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : error}\n${diagnostics.join("\n")}`,
        );
      } finally {
        await executor.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

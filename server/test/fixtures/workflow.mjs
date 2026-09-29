import assert from "node:assert/strict";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import dgram from "node:dgram";

const client = JSON.parse(await readFile("/scratch/client.json", "utf8"));
const schema = JSON.parse(await readFile("/scratch/schema.json", "utf8"));
const prompt = await readFile("/scratch/prompt.txt", "utf8");
const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
}
async function blocked(host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(800, () => {
      socket.destroy();
      reject(new Error("Timeout is not denial evidence"));
    });
    socket.on("connect", () => {
      socket.destroy();
      reject(new Error("Unexpected network access"));
    });
    socket.on("error", resolve);
  });
}
const post = (route, body, capability = client.capability) =>
  fetch(`${client.base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${capability}`,
    },
    body: JSON.stringify(body),
  });
const mcp = (method, args = {}) =>
  post("/mcp", { jsonrpc: "2.0", id: 1, method, params: args });
const metadata = JSON.parse(
  (
    await (
      await mcp("tools/call", {
        name: "pull_request_read",
        arguments: { method: "get" },
      })
    ).json()
  ).result.content[0].text,
);
await check("exact-read", async () =>
  assert.equal(
    await readFile("/source/checkout/code.txt", "utf8"),
    "pinned head\n",
  ),
);
await check("workcopy-write-no-source-export", async () => {
  assert.equal(
    await readFile("/scratch/workcopy/code.txt", "utf8"),
    "pinned head\n",
  );
  await writeFile("/scratch/workcopy/code.txt", "disposable edit\n");
  assert.equal(
    await readFile("/source/checkout/code.txt", "utf8"),
    "pinned head\n",
  );
  await assert.rejects(readFile("/scratch/workcopy/.claude/settings.json"));
  await assert.rejects(readFile("/scratch/workcopy/CLAUDE.md"));
});
if (metadata.sharedGitObjects)
  await check("immutable-git-objects", async () => {
    assert.equal(
      await readFile("/scratch/workcopy/.git/objects/info/alternates", "utf8"),
      "/source/checkout/.git/objects\n",
    );
    assert.deepEqual(await readdir("/scratch/workcopy/.git/objects"), ["info"]);
    const packs = await readdir("/source/checkout/.git/objects/pack");
    const pack = `/source/checkout/.git/objects/pack/${packs.find((name) => name.endsWith(".pack"))}`;
    assert.ok((await stat(pack)).size > 256 * 1024 * 1024);
    await assert.rejects(open(pack, "r+"), { code: "EROFS" });
    await assert.rejects(readFile("/scratch/workcopy/AGENTS.md"));
    await assert.rejects(readFile("/scratch/workcopy/.pi/settings.json"));
  });
await check("scratch-write", () => writeFile("/scratch/allowed", "owned"));
await check("project-config-inert", async () =>
  assert.rejects(readFile("/scratch/PR_HOOK_RAN")),
);
await check("nested-process", async () =>
  assert.equal(
    spawnSync(process.execPath, [
      "-e",
      'require("node:assert/strict").equal(require("node:fs").readFileSync("/source/checkout/code.txt","utf8"),"pinned head\\n"); require("node:fs").writeFileSync("/scratch/nested","allowed")',
    ]).status,
    0,
  ),
);
for (const file of [
  metadata.secretPath,
  metadata.databasePath,
  metadata.configPath,
  "/root/.ssh/id_rsa",
  "/root/Library/Keychains/login.keychain-db",
  "/var/run/docker.sock",
  "/Users/other/.config/auth",
]) {
  await check(`read-denied:${file}`, () => assert.rejects(readFile(file)));
}
for (const file of [
  "/source/checkout/code.txt",
  "/control/entry.mjs",
  "/runtime/fixture.mjs",
  "/etc/passwd",
  "/outside",
]) {
  await check(`write-denied:${file}`, () =>
    assert.rejects(writeFile(file, "forbidden")),
  );
}
for (const [host, port] of [
  ["127.0.0.1", 4317],
  ["127.0.0.1", 4319],
  ["127.0.0.1", metadata.hostPort ?? 443],
  ["198.51.100.1", 443],
  ["198.51.100.1", 22],
  ["198.51.100.1", 80],
  ["::1", 4319],
  ["2001:db8::1", 443],
])
  await check(`socket-denied:${host}:${port}`, () => blocked(host, port));
await check("udp-denied", async () => {
  const socket = dgram.createSocket("udp4");
  try {
    await new Promise((resolve) =>
      socket.send("forbidden", 53, "198.51.100.1", (error) => {
        assert.ok(error);
        resolve();
      }),
    );
  } finally {
    socket.close();
  }
});
await check("inherited-hook-boundary", async () =>
  assert.equal(
    spawnSync(process.execPath, [
      "-e",
      'const fs=require("node:fs"); for(const file of ["/source/checkout/code.txt","/etc/passwd"]) {try{fs.writeFileSync(file,"forbidden");process.exit(1)}catch{}}',
    ]).status,
    0,
  ),
);
await check("read-mcp", async () =>
  assert.equal((await mcp("tools/list")).status, 200),
);
const available = (await (await mcp("tools/list")).json()).result.tools.map(
  (tool) => tool.name,
);
for (const [name, argumentsValue] of [
  [
    "github_pull_request_read",
    { repository: "fixture/repository", number: 42, method: "get" },
  ],
  ["linear_get_issue", { id: "FIX-42" }],
  ["get_issue", { id: "FIX-42" }],
  ["list_issues", { query: "synthetic", limit: 1 }],
  ["listDatasets", {}],
  ["getDatasetFields", { datasetName: "synthetic-events" }],
  [
    "queryDataset",
    {
      datasetName: "synthetic-events",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T00:05:00Z",
      limit: 1,
    },
  ],
  [
    "notion_read",
    { id: "11111111-1111-1111-1111-111111111111", method: "page" },
  ],
  ["documents_get", { id: "fixture-document" }],
]) {
  if (!available.includes(name)) continue;
  await check(`provider-read:${name}`, async () => {
    const response = await mcp("tools/call", {
      name,
      arguments: argumentsValue,
    });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).result.content[0].text);
    assert.equal(
      (
        await mcp("tools/call", {
          name,
          arguments: { ...argumentsValue, method: "publish" },
        })
      ).status,
      403,
    );
  });
}
for (const [method, params] of [
  ["tools/call", { name: "create_pull_request", arguments: {} }],
  [
    "tools/call",
    { name: "save_issue", arguments: { title: "MUTATION_CANARY" } },
  ],
  ["tools/call", { name: "get_unknown", arguments: {} }],
  ["tools/call", { name: "pull_request_read", arguments: { method: "merge" } }],
  [
    "tools/call",
    {
      name: "pull_request_read",
      arguments: { method: "get", url: "https://github.com" },
    },
  ],
  ["resources/read", {}],
  ["sampling/createMessage", {}],
])
  await check(`mcp-denied:${method}:${JSON.stringify(params)}`, async () =>
    assert.equal((await mcp(method, params)).status, 403),
  );
await check("wrong-capability", async () =>
  assert.equal(
    (
      await post(
        "/mcp",
        { jsonrpc: "2.0", method: "tools/list" },
        "another-run",
      )
    ).status,
    403,
  ),
);
for (const route of [
  "/api/prs/fixture/submit",
  "/graphql",
  "/repos/fixture/reviews",
  "/claude/v1/messages/../api",
  "/codex/responses?target=github",
])
  await check(`route-denied:${route}`, async () =>
    assert.equal((await post(route, {})).status, 403),
  );
const model = {
  model: "fixture-claude",
  max_tokens: 100,
  stream: true,
  messages: [{ role: "user", content: "Synthetic inference only" }],
};
await check("model-post", async () =>
  assert.equal((await post("/claude/v1/messages", model)).status, 200),
);
await check("hosted-tool-denied", async () =>
  assert.equal(
    (
      await post("/claude/v1/messages", {
        ...model,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      })
    ).status,
    403,
  ),
);
await check("codex-model-post", async () =>
  assert.equal(
    (
      await post("/codex/responses", {
        model: "fixture-codex",
        stream: true,
        store: false,
        input: [{ role: "user", content: "Fixture" }],
      })
    ).status,
    200,
  ),
);
if (prompt.includes("FIXTURE_HANG")) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');setInterval(()=>fs.appendFileSync('/scratch/heartbeat','x'),100)")}],{detached:true,stdio:'ignore'});c.unref()`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  await writeFile("/scratch/probes.json", JSON.stringify(results));
  setInterval(() => {}, 1000);
  if (prompt.includes("FIXTURE_STOP_PID1"))
    setTimeout(() => process.kill(1, "SIGSTOP"), 1000);
} else {
  const result = schema.properties.overview
    ? {
        overview:
          "### Ticket intent\n- Fixture context unavailable.\n### What the PR does\n- Reads pinned code.\n### Ticket coverage\n- Synthetic evidence only.",
        body: "Synthetic fixture review.",
        findings: [],
        verdict: "COMMENT",
        rationale: JSON.stringify(results),
      }
    : schema.properties.answer
      ? { answer: "Synthetic fixture answer.", followUps: [] }
      : {
          body: "Synthetic fixture comment.",
          severity: "non_blocking",
          origin: "introduced",
          evidence: "Synthetic code read.",
        };
  if (prompt.includes("FIXTURE_MALFORMED")) process.stdout.write("not-json\n");
  const frames =
    process.env.PR_REVIEW_HARNESS === "codex"
      ? [
          { type: "turn.started" },
          {
            type: "item.completed",
            item: { type: "agent_message", text: JSON.stringify(result) },
          },
          { type: "turn.completed" },
        ]
      : process.env.PR_REVIEW_HARNESS === "pi"
        ? [
            { type: "agent_start" },
            {
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [{ type: "text", text: JSON.stringify(result) }],
              },
            },
            { type: "agent_end", messages: [] },
          ]
        : [
            {
              type: "result",
              subtype: "success",
              is_error: false,
              structured_output: result,
            },
          ];
  for (const frame of frames)
    process.stdout.write(JSON.stringify(frame) + "\n");
}

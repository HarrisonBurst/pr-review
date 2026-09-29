import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const client = JSON.parse(await readFile("/scratch/client.json", "utf8"));
const post = (method, params) =>
  fetch(`${client.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${client.capability}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
assert.equal(
  await readFile("/scratch/workcopy/code.txt", "utf8"),
  "pinned source",
);
await writeFile("/scratch/workcopy/code.txt", "native write fixture");
assert.equal(
  await readFile("/source/checkout/code.txt", "utf8"),
  "pinned source",
);
await assert.rejects(readFile("/scratch/workcopy/AGENTS.md"));
await assert.rejects(readFile("/scratch/workcopy/.pi/settings.json"));
await assert.rejects(writeFile("/source/checkout/code.txt", "forbidden"));
await assert.rejects(readFile("/var/run/docker.sock"));
await assert.rejects(readFile("/scratch/.claude/.credentials.json"));
await assert.rejects(readFile("/scratch/.codex/auth.json"));
const auth = JSON.parse(await readFile("/scratch/.pi/agent/auth.json", "utf8"));
assert.deepEqual(Object.keys(auth), ["openai-codex"]);
assert.equal(auth["openai-codex"].refresh, "");
assert.equal(process.env.AMBIENT_BUSINESS_CANARY, undefined);
await import("/scratch/.pi/agent/extensions/approved.mjs");
assert.equal(await readFile("/scratch/approved-ran", "utf8"), "container only");
const settings = JSON.parse(
  await readFile("/scratch/.pi/agent/settings.json", "utf8"),
);
assert.deepEqual(settings.packages, []);
for (const extension of settings.extensions) await import(extension);
assert.equal(await readFile("/scratch/plugin-ran", "utf8"), "portable plugin");
assert.equal(
  spawnSync("/bin/sh", ["-c", "printf nested > /scratch/workcopy/nested"], {
    env: process.env,
  }).status,
  0,
);
assert.equal(await readFile("/scratch/workcopy/nested", "utf8"), "nested");
const listed = await (await post("tools/list", {})).json();
if ((await readFile("/scratch/prompt.txt", "utf8")).includes("LOCAL_DENIED")) {
  assert.ok(!listed.result.tools.some((item) => item.name === "documents_get"));
  assert.equal(
    (
      await post("tools/call", {
        name: "documents_get",
        arguments: { id: "fixture-document" },
      })
    ).status,
    403,
  );
  await assert.rejects(readdir("/scratch/resources/.local-mcp"));
} else {
  assert.ok(listed.result.tools.some((item) => item.name === "documents_get"));
  const allowed = await post("tools/call", {
    name: "documents_get",
    arguments: { id: "fixture-document" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(
    (await allowed.json()).result.content[0].text,
    "container document",
  );
  for (const params of [
    { name: "documents_get", arguments: { id: "unapproved" } },
    {
      name: "documents_get",
      arguments: { id: "fixture-document", url: "https://forbidden.invalid" },
    },
    { name: "publish", arguments: {} },
  ])
    assert.equal((await post("tools/call", params)).status, 403);
  assert.equal(
    (
      await post("tools/call", {
        name: "documents_get",
        arguments: { id: "timeout-document" },
      })
    ).status,
    403,
  );
  const targets = await readdir("/scratch/resources/.local-mcp");
  await writeFile(
    `/scratch/resources/.local-mcp/${targets[0]}/drift`,
    "changed",
  );
  assert.equal(
    (
      await post("tools/call", {
        name: "documents_get",
        arguments: { id: "fixture-document" },
      })
    ).status,
    403,
  );
}
assert.equal(
  (await fetch(`${client.base}/refresh`, { method: "POST" })).status,
  403,
);
const value = {
  overview: "Synthetic Docker fixture only",
  body: "Validated fixture review",
  findings: [],
  verdict: "COMMENT",
  rationale:
    "Writable copy, approved contained customization, selected temporary auth, real stdio invocation and drift/resource/tool denial verified. No source export.",
};
console.log(
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  }),
);
console.log(JSON.stringify({ type: "agent_end", messages: [] }));

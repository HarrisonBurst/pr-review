import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

assert.equal(readFileSync("/scratch/TRUSTED_HOOK", "utf8"), "trusted");
const child = spawn(
  "/scratch/tools/codex",
  [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "SYNTHETIC_NESTED",
  ],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const done = new Promise((resolve) => child.on("exit", resolve));
assert.equal(
  readFileSync("/scratch/workcopy/code.txt", "utf8"),
  "PINNED_SYNTHETIC_SOURCE",
);
writeFileSync("/scratch/workcopy/code.txt", "DISPOSABLE_NATIVE_EDIT");
assert.equal(
  readFileSync("/source/checkout/code.txt", "utf8"),
  "PINNED_SYNTHETIC_SOURCE",
);
assert.throws(() => writeFileSync("/source/checkout/code.txt", "forbidden"));
assert.throws(() => readFileSync("__HOST_FILE__"));
assert.equal(existsSync("/var/run/docker.sock"), false);
assert.equal(existsSync("/scratch/workcopy/AGENTS.md"), false);
assert.equal(existsSync("/scratch/workcopy/.pi/settings.json"), false);
assert.equal(process.env.AMBIENT_BUSINESS_CANARY, undefined);
if (process.env.PR_REVIEW_HARNESS === "pi") {
  assert.equal(
    readFileSync("/scratch/TRUSTED_PLUGIN", "utf8"),
    "portable local plugin",
  );
  const settings = JSON.parse(
    readFileSync("/scratch/.pi/agent/settings.json", "utf8"),
  );
  assert.deepEqual(settings.packages, []);
  const auth = JSON.parse(readFileSync("/scratch/.pi/agent/auth.json", "utf8"));
  assert.equal(auth["openai-codex"].refresh, "");
} else assert.equal(existsSync("/scratch/.pi/agent/auth.json"), false);
if (process.env.PR_REVIEW_HARNESS !== "claude")
  assert.equal(existsSync("/scratch/.claude/.credentials.json"), false);
const codex = JSON.parse(readFileSync("/scratch/.codex/auth.json", "utf8"));
assert.equal(codex.tokens.refresh_token, "");
const client = JSON.parse(readFileSync("/scratch/client.json", "utf8"));
const post = (params) =>
  fetch(`${client.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${client.capability}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params,
    }),
  });
const allowed = await post({
  name: "documents_get",
  arguments: { id: "fixture-document" },
});
assert.equal(allowed.status, 200);
assert.equal(
  (await allowed.json()).result.content[0].text,
  "native local fixture",
);
for (const params of [
  { name: "documents_get", arguments: { id: "unapproved" } },
  { name: "documents_get", arguments: { id: "fixture-document", extra: true } },
  { name: "publish", arguments: {} },
])
  assert.equal((await post(params)).status, 403);
assert.equal(
  (await fetch(`${client.base}/refresh`, { method: "POST" })).status,
  403,
);
assert.equal(await done, 0, output);
assert.match(output, /nested-fixture-result/);
process.stdout.write("NATIVE_WORKFLOW_OK");

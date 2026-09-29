import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

const settings = JSON.parse(
  await readFile("/scratch/.claude/settings.json", "utf8"),
);
for (const key of ["hooks", "statusLine", "theme", "tui"])
  assert.equal(settings[key], undefined);
assert.match(
  await readFile("/scratch/.claude/AGENTS.md", "utf8"),
  /Trusted instruction closure/,
);
assert.match(
  await readFile("/scratch/.claude/skills/slack-axi/SKILL.md", "utf8"),
  /No slack-axi binary/,
);
await assert.rejects(
  stat("/scratch/.claude/skills/synced/fixture/google-workspace"),
);
const manifest = JSON.parse(
  await readFile(
    "/scratch/.claude/skills/synced/fixture/manifest.json",
    "utf8",
  ),
);
assert.deepEqual(
  manifest.skills.map((item) => item.skillId),
  ["kept"],
);
assert.deepEqual(manifest.pendingClaims, ["fixture/kept"]);
assert.deepEqual(manifest.retainedMetadata, { nested: ["unchanged"] });
assert.equal(
  await readFile(
    "/scratch/.claude/skills/synced/fixture/kept/SKILL.md",
    "utf8",
  ),
  "Synthetic retained skill\n",
);
const font = await readFile(
  "/scratch/.claude/skills/morning/assets/fonts/fixture.woff2",
);
assert.equal(font.length, 64);
assert.equal(
  createHash("sha256").update(font).digest("hex"),
  "4ccf55b6f91a5224214082c9b2016fcbced1d2708790e8e5525322856f50bf00",
);
assert.equal(
  (await stat("/scratch/.claude/skills/morning/assets/fonts/fixture.woff2"))
    .mode & 0o111,
  0,
);
const imagePath = "/scratch/.claude/skills/morning/assets/fixture.png";
const image = await readFile(imagePath);
assert.equal(image.length, 68);
assert.equal(
  createHash("sha256").update(image).digest("hex"),
  "91a6aee4a02376d511e51befe918c6fef59a587328e1facaae57dda8aeb41d34",
);
assert.equal((await stat(imagePath)).mode & 0o111, 0);
for (let index = 0; index < 3; index++) {
  const content = await readFile(
    `/scratch/.claude/skills/morning/large-${index}.md`,
    "utf8",
  );
  assert.equal(content.length, 2000000);
  assert.equal(content, (index === 0 ? '"' : "a").repeat(2000000));
}
await assert.rejects(readFile("/scratch/.claude/skills/.DS_Store"));
await assert.rejects(readFile("/scratch/workcopy/CLAUDE.md"));
await assert.rejects(readFile("/scratch/workcopy/.claude/settings.json"));
await assert.rejects(readFile("/var/run/docker.sock"));
await writeFile("/scratch/workcopy/code.txt", "disposable synthetic edit");
assert.equal(
  await readFile("/source/checkout/code.txt", "utf8"),
  "immutable fixture source",
);
const auth = JSON.parse(
  await readFile("/scratch/.claude/.credentials.json", "utf8"),
);
assert.equal(auth.claudeAiOauth.refreshToken, "");
const client = JSON.parse(await readFile("/scratch/client.json", "utf8"));
const call = (method, params) =>
  fetch(`${client.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${client.capability}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const inventory = await (await call("tools/list", {})).json();
assert.equal(
  inventory.result.tools.some((tool) => tool.name.includes("slack")),
  false,
);
assert.equal(
  (
    await call("tools/call", {
      name: "slack_search",
      arguments: { query: "synthetic" },
    })
  ).status,
  403,
);
console.log(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: {
      overview: "Synthetic installed-source materialization fixture",
      body: "No live provider or native harness validation.",
      findings: [],
      verdict: "COMMENT",
      rationale:
        "Bounded imported instructions and logical library resources materialized; excluded configuration absent; Slack unavailable and denied.",
    },
  }),
);

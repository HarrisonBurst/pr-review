#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
assert.ok(args.includes("--restricted"));
assert.equal(value("--tools"), "");
assert.equal(value("--allowedTools"), "");
assert.equal(value("--setting-sources"), "");
assert.equal(value("--permission-mode"), "dontAsk");
assert.deepEqual(JSON.parse(value("--mcp-config")), { mcpServers: {} });
assert.equal(JSON.parse(value("--settings")).disableAllHooks, true);
assert.ok(args.includes("--disable-slash-commands"));
assert.ok(args.includes("--no-session-persistence"));
assert.equal(args.includes("--json-schema"), false);
assert.equal(
  args.some((arg) => arg.startsWith("--dangerously-")),
  false,
);
assert.equal(process.env.PR_REVIEW_LOCAL_TOKEN, undefined);
assert.equal(process.env.INHERITED_CUSTOMIZATION_CANARY, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, "SYNTHETIC-no-tools-key");
const root = path.dirname(__filename);
const response = JSON.parse(
  fs.readFileSync(path.join(root, "response.json"), "utf8"),
);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (part) => {
  input += part;
});
process.stdin.on("end", () => {
  fs.writeFileSync(
    path.join(root, "dispatch.json"),
    JSON.stringify({ args, input, home: process.env.HOME }),
  );
  console.log(
    JSON.stringify({
      type: "system",
      subtype: "init",
      tools: response.advertise ? ["Bash"] : [],
      mcp_servers: [],
    }),
  );
  if (response.tool)
    console.log(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "SYNTHETIC forbidden" },
            },
          ],
        },
      }),
    );
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(response.output),
    }),
  );
});

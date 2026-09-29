const { createInterface } = require("node:readline");
const { readFileSync, existsSync, realpathSync } = require("node:fs");
const { basename } = require("node:path");
const assert = require("node:assert/strict");
const harness = basename(process.argv[1]);
assert.equal(process.cwd(), realpathSync(process.env.HOME));
assert.equal(process.env.CODEX_HOME, process.env.HOME);
assert.equal(process.env.CLAUDE_CONFIG_DIR, process.env.HOME);
for (const key of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "AWS_PROFILE",
])
  assert.equal(process.env[key], undefined);
assert.equal(existsSync(`${process.env.HOME}/settings.json`), false);
assert.equal(existsSync(`${process.env.HOME}/config.toml`), false);
const mode = existsSync(`${__filename}.mode`)
  ? readFileSync(`${__filename}.mode`, "utf8")
  : "ready";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let initialized = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "malformed") return process.stdout.write("invalid\n");
  if (mode === "exit") return process.exit(1);
  if (mode === "oversized") return process.stdout.write("x".repeat(5_000_001));
  if (mode === "hang") return;
  if (mode === "empty") {
    emit(
      harness === "claude"
        ? {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: { models: [] },
            },
          }
        : { id: message.id, result: { data: [], nextCursor: null } },
    );
    return;
  }
  if (harness === "claude") {
    for (const arg of [
      "--bare",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--disable-slash-commands",
    ])
      assert.ok(process.argv.includes(arg));
    assert.equal(message.type, "control_request");
    assert.equal(message.request.subtype, "initialize");
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          models: [
            {
              value: "fixture-claude-catalog-only",
              displayName: "Fixture Claude Catalog Only",
            },
          ],
        },
      },
    });
  } else {
    assert.equal(process.argv[2], "app-server");
    if (message.method === "initialize")
      emit({ id: message.id, result: { userAgent: "inert fixture" } });
    else if (message.method === "initialized") initialized = true;
    else {
      assert.ok(initialized);
      assert.equal(message.method, "model/list");
      assert.equal(message.params.includeHidden, false);
      const cursor = message.params.cursor;
      emit({
        id: message.id,
        result: {
          data: [
            {
              model: cursor
                ? "fixture-codex-page-two"
                : "fixture-codex-catalog-only",
              displayName: cursor
                ? "Fixture Codex Page Two"
                : "Fixture Codex Catalog Only",
            },
          ],
          nextCursor: mode === "cycle" || !cursor ? "page-two" : null,
        },
      });
    }
  }
});

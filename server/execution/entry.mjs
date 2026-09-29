import http from "node:http";
import net from "node:net";
import readline from "node:readline";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { prepareWorkcopy } from "./workcopy.mjs";
import { ContainerMcp } from "./local-mcp.mjs";
import {
  configureHarnesses,
  harnessInvocation,
  executables,
  dockerResourceLimits,
} from "./harness.mjs";

const pending = new Map();
let initialize;
const initialized = new Promise((resolve) => {
  initialize = resolve;
});
let sequence = 0;
let lease = Date.now();
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const bytes = Buffer.byteLength(line);
  if (bytes + 1 > dockerResourceLimits.initializeBytes) process.exit(1);
  const value = JSON.parse(line);
  if (value.type !== "initialize" && bytes > 4000000) process.exit(1);
  if (value.type === "initialize") initialize(value);
  else if (value.type === "heartbeat") lease = Date.now();
  else {
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  }
});
lines.on("close", () => process.exit(1));
setInterval(() => {
  if (Date.now() - lease > 10000) process.exit(1);
}, 1000).unref();
const init = await initialized;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const call = (message) =>
  new Promise((resolve) => {
    const id = ++sequence;
    pending.set(id, resolve);
    emit({
      type: "broker",
      id,
      run: init.run,
      capability: init.capability,
      ...message,
    });
  });
const claude = "/artifacts/claude/package/claude";
const codex =
  "/artifacts/codex/package/vendor/aarch64-unknown-linux-musl/bin/codex";
const environment = {
  LANG: "C.UTF-8",
  HOME: "/scratch",
  SHELL: init.syntheticRuntime ? "/bin/sh" : "/bin/bash",
  PATH: "/scratch/tools:/usr/local/bin:/usr/bin:/bin",
  CODEX_HOME: "/scratch/.codex",
  CLAUDE_CONFIG_DIR: "/scratch/.claude",
  PR_REVIEW_HARNESS: init.harness,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/scratch/gitconfig",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_INSTALLATION_CHECKS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
for (const dir of [".codex", ".claude", "tools"])
  await mkdir(`/scratch/${dir}`, { recursive: true });
await writeFile(
  "/scratch/gitconfig",
  "[safe]\n directory = /source/checkout\n directory = /scratch/workcopy\n[core]\n hooksPath = /dev/null\n fsmonitor = false\n[protocol]\n allow = never\n",
);
if (init.preflight) {
  const status = await readFile("/proc/self/status", "utf8");
  if (
    !/CapEff:\s+0000000000000000/.test(status) ||
    !/NoNewPrivs:\s+1/.test(status) ||
    !/Seccomp:\s+2/.test(status)
  )
    process.exit(1);
  const pids = (await readFile("/sys/fs/cgroup/pids.max", "utf8")).trim();
  const memory = (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim();
  const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8"))
    .trim()
    .split(/\s+/)
    .map(Number);
  if (
    pids !== "256" ||
    memory !== String(3 * 1024 ** 3) ||
    quota / period !== 3
  )
    process.exit(1);
  let denied = false;
  try {
    await writeFile("/control/entry.mjs", "forbidden");
  } catch (error) {
    denied = error.code === "EROFS" || error.code === "EACCES";
  }
  if (!denied) process.exit(1);
  await writeFile("/scratch/allowed", "scoped write");
  const blocked = await new Promise((resolve) => {
    const socket = net.connect({ host: "198.51.100.1", port: 443 });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", (error) => resolve(error.code === "ENETUNREACH"));
  });
  if (!blocked) process.exit(1);
  if (!init.syntheticRuntime) {
    const required = new Set([
      init.harness,
      ...(init.nested ?? (init.harness === "claude" ? ["codex"] : [])),
    ]);
    for (const harness of required) {
      const version = { claude: "2.1.280", codex: "0.155.0", pi: "0.85.1" }[
        harness
      ];
      const command =
        harness === "pi" ? process.execPath : executables[harness];
      const checked = spawnSync(
        command,
        harness === "pi" ? [executables.pi, "--version"] : ["--version"],
        {
          env: environment,
          encoding: "utf8",
          timeout: 10000,
        },
      );
      if (checked.status !== 0 || !checked.stdout.includes(version))
        process.exit(1);
    }
    if (required.has("codex"))
      for (const [command, args] of [
        [
          codex,
          [
            "sandbox",
            "-P",
            ":read-only",
            "/bin/bash",
            "-lc",
            "git --version && rg --version && test -r /scratch/allowed && ! touch /scratch/forbidden",
          ],
        ],
      ]) {
        const result = spawnSync(command, args, {
          env: environment,
          encoding: "utf8",
          timeout: 20000,
        });
        if (result.status !== 0) process.exit(1);
      }
  }
  emit({ type: "preflight", ok: true });
  process.exit(0);
}
const workcopy = await prepareWorkcopy(
  "/source/checkout",
  "/scratch/workcopy",
  init.metadata,
  environment,
  init.syntheticRuntime,
);
const localMcp = new ContainerMcp(
  init.docker?.disclosure.localConnections ?? [],
  environment,
);
const secrets = [
  init.credentials.claude.claudeAiOauth.accessToken,
  init.credentials.codex.tokens.access_token,
  init.credentials.codex.tokens.id_token,
  init.credentials.pi?.access,
].filter(Boolean);
const server = http.createServer(async (req, res) => {
  try {
    let size = 0;
    const parts = [];
    for await (const part of req) {
      size += part.length;
      if (size > (req.url === "/mcp" ? 1100000 : 600000)) throw new Error();
      parts.push(part);
    }
    let raw = Buffer.concat(parts);
    if (req.headers["content-encoding"] === "zstd")
      raw = zlib.zstdDecompressSync(raw, { maxOutputLength: 600000 });
    if (req.method !== "POST") throw new Error();
    const routes = {
      "/claude/v1/messages": "claude",
      "/claude/v1/messages?beta=true": "claude",
      "/codex/responses": "codex",
      "/pi/codex/responses": "pi",
      "/mcp": "mcp",
    };
    const route = routes[req.url];
    if (
      !route ||
      (route === "mcp" &&
        req.headers.authorization !== `Bearer ${init.capability}`)
    )
      throw new Error();
    const headers = Object.fromEntries(
      [
        "anthropic-beta",
        "anthropic-version",
        "user-agent",
        "openai-beta",
        "originator",
        "version",
      ]
        .filter((key) => req.headers[key])
        .map((key) => [key, req.headers[key]]),
    );
    const body = JSON.parse(raw);
    let reply;
    if (
      route === "mcp" &&
      ["tools/list", "tools/call"].includes(body.method) &&
      localMcp.connections.length
    ) {
      const remote = await call({
        route,
        body: { jsonrpc: "2.0", id: body.id, method: "tools/list" },
        headers,
      });
      if (remote.status !== 200) throw new Error();
      const remoteTools = remote.body.result.tools;
      const localTools = await localMcp.tools();
      const names = [...remoteTools, ...localTools].map((tool) => tool.name);
      if (new Set(names).size !== names.length) throw new Error();
      if (body.method === "tools/list")
        reply = {
          status: 200,
          contentType: "application/json",
          body: {
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [...remoteTools, ...localTools] },
          },
        };
      else if (
        localMcp.connections.some(
          (item) => item.profile.tool.name === body.params?.name,
        )
      ) {
        if (
          Object.keys(body.params).some(
            (key) => !["name", "arguments", "_meta"].includes(key),
          )
        )
          throw new Error();
        const result = await localMcp.call(
          body.params.name,
          body.params.arguments,
        );
        if (secrets.some((secret) => JSON.stringify(result).includes(secret)))
          throw new Error();
        reply = {
          status: 200,
          contentType: "application/json",
          body: { jsonrpc: "2.0", id: body.id, result },
        };
      }
    }
    reply ??= await call({ route, body, headers });
    res.writeHead(reply.status, { "content-type": reply.contentType });
    res.end(
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
    );
  } catch {
    res.writeHead(403);
    res.end('{"error":"Unapproved route or request"}');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
await writeFile(
  "/scratch/client.json",
  JSON.stringify({ base, capability: init.capability, run: init.run }),
  { mode: 0o600 },
);
await writeFile("/scratch/schema.json", JSON.stringify(init.schema));
await writeFile("/scratch/prompt.txt", init.prompt);
await writeFile(
  "/scratch/.claude.json",
  JSON.stringify({ hasCompletedOnboarding: true }),
);
if ([init.harness, ...(init.nested ?? [])].includes("claude"))
  await writeFile(
    "/scratch/.claude/.credentials.json",
    JSON.stringify(init.credentials.claude),
    { mode: 0o400 },
  );
if ([init.harness, ...(init.nested ?? [])].includes("codex"))
  await writeFile(
    "/scratch/.codex/auth.json",
    JSON.stringify(init.credentials.codex),
    { mode: 0o400 },
  );
await configureHarnesses(init, base, environment);
await writeFile(
  "/scratch/mcp.json",
  JSON.stringify({
    mcpServers: {
      snapshot: {
        type: "http",
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${init.capability}` },
      },
    },
  }),
);
for (const name of ["gh", "codex"])
  await symlink(`/control/${name}.mjs`, `/scratch/tools/${name}`);
const args = [
  "--print",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--setting-sources",
  "user",
  "--strict-mcp-config",
  "--mcp-config",
  "/scratch/mcp.json",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--allowedTools",
  "Bash,Read,Write,Edit,Grep,Glob,Skill,Agent,Task,TaskOutput,TaskStop,TaskCreate,TaskUpdate,TaskList,TaskGet,ToolSearch,mcp__snapshot__*",
  "--json-schema",
  JSON.stringify(init.schema),
  "--max-turns",
  "40",
  "--model",
  init.models.claude,
  "-p",
  `${init.prompt}\nSelected skill entry: ${init.skillPath}. For reviews read it and resolve relative resources from its directory; for questions do not invoke the full skill.`,
];
const [command, selectedArgs] = init.syntheticRuntime
  ? [process.execPath, ["/runtime/fixture.mjs"]]
  : harnessInvocation(init, args);
const child = spawn(command, selectedArgs, {
  cwd: "/scratch",
  env: {
    ...environment,
    ANTHROPIC_BASE_URL: `${base}/claude`,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
    PR_REVIEW_READ_CAPABILITY: init.capability,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) =>
  emit({ type: "harness", data: chunk.toString("base64") }),
);
child.stderr.on("data", (chunk) => {
  if (init.fixture && init.fixtureDiagnostics)
    emit({ type: "fixture_diagnostic", data: chunk.toString("base64") });
});
child.on("error", () => process.exit(127));
child.on("close", (code) => {
  emit({
    type: "boundary_evidence",
    workcopyFiles: workcopy.files,
    workcopyBytes: workcopy.bytes,
    localInventories: localMcp.evidence.inventories,
    localReads: localMcp.evidence.reads,
    localDenials: localMcp.evidence.denied,
  });
  emit({ type: "exit", code });
  process.exit(code ?? 1);
});

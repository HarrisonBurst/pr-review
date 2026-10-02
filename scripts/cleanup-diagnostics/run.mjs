import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pins = [
  ["base", "2a6521231a2dfb28b04dd510c2fc5643c0b9c7e7"],
  ["candidate", "6e75ef849503a0bb683940a7c96195cdd31cac28"],
];
const root = process.cwd();
const scripts = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.env.CLEANUP_DIAGNOSTIC_OUTPUT);
mkdirSync(output, { recursive: true });
const os = execFileSync("sw_vers", ["-productVersion"], {
  encoding: "utf8",
}).trim();
const build = execFileSync("sw_vers", ["-buildVersion"], {
  encoding: "utf8",
}).trim();
const facts = {
  os,
  build,
  kernel: release(),
  image: process.env.ImageVersion,
  imageOS: process.env.ImageOS,
  architecture: process.arch,
  node: process.version,
  npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
  cpus: availableParallelism(),
  load: loadavg(),
  pins,
};
writeFileSync(join(output, "conditions.json"), JSON.stringify(facts, null, 2));
console.log(JSON.stringify({ stage: "conditions", ...facts }));
if (
  os !== "26.6.2" ||
  build !== "25G83" ||
  facts.image !== "20260907.0351.1" ||
  facts.architecture !== "arm64" ||
  facts.node !== "v24.20.0" ||
  facts.npm !== "11.19.0"
) {
  console.log("Recorded failing-runner conditions unavailable; no trial");
  process.exit(2);
}
const addon = join(output, "probe.node");
execFileSync("clang", [
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  `-I${join(dirname(dirname(realpathSync(process.execPath))), "include/node")}`,
  join(scripts, "probe.c"),
  "-o",
  addon,
]);
const observer = join(scripts, "observer.mjs");
const sources = [];
for (const [label, pin] of pins) {
  const source = join(output, label);
  mkdirSync(source);
  const archive = execFileSync("git", ["archive", pin], {
    maxBuffer: 20_000_000,
  });
  execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
  symlinkSync(join(root, "node_modules"), join(source, "node_modules"));
  const utilPath = join(source, "server/util.ts");
  let util = readFileSync(utilPath, "utf8");
  const replacements = [
    [
      "  const owned = runningCommands.get(child);\n  if (!owned) return true;",
      '  const owned = runningCommands.get(child);\n  diagnosticEvent("registry_release", { command: diagnosticChild(child), known: Boolean(owned), closed: owned?.closed });\n  if (!owned) return true;',
    ],
    [
      "      process.kill(-child.pid, 0);\n      return false;",
      '      process.kill(-child.pid, 0);\n      diagnosticEvent("registry_retained", { command: diagnosticChild(child) });\n      return false;',
    ],
    [
      '      if (\n        !(error instanceof Error) ||\n        !("code" in error) ||\n        error.code !== "ESRCH"\n      )\n        throw error;',
      '      diagnosticEvent("registry_probe_error", { command: diagnosticChild(child), code: error instanceof Error && "code" in error ? error.code : null });\n      if (\n        !(error instanceof Error) ||\n        !("code" in error) ||\n        error.code !== "ESRCH"\n      )\n        throw error;',
    ],
    [
      "  runningCommands.delete(child);",
      '  diagnosticEvent("registry_removed", { command: diagnosticChild(child) });\n  runningCommands.delete(child);',
    ],
    [
      "      close: closed.promise,\n    });",
      '      close: closed.promise,\n    });\n    diagnosticEvent("registry_added", { command: diagnosticChild(child) });',
    ],
    [
      "      runningCommands.get(child)!.closed = true;",
      '      runningCommands.get(child)!.closed = true;\n      diagnosticEvent("registry_closed", { command: diagnosticChild(child) });',
    ],
    [
      "  const commands = [...runningCommands];",
      '  const commands = [...runningCommands];\n  diagnosticEvent("registry_shutdown", { commands: commands.map(([child, owned]) => ({ command: diagnosticChild(child), closed: owned.closed })) });',
    ],
  ];
  for (const [before, after] of replacements) {
    if (util.split(before).length !== 2)
      throw new Error("Diagnostic source hook does not match exactly");
    util = util.replace(before, after);
  }
  util = `import { diagnosticEvent, diagnosticChild } from ${JSON.stringify(observer)};\n${util}`;
  writeFileSync(utilPath, util);
  const testPath = join(source, "server/test/util.test.ts");
  let test = readFileSync(testPath, "utf8");
  const testImport = 'import { test, type TestContext } from "node:test";';
  if (test.split(testImport).length !== 2)
    throw new Error("Diagnostic test hook does not match exactly");
  test = test.replace(
    testImport,
    'import { test, beforeEach, afterEach, type TestContext } from "node:test";',
  );
  test = `import { diagnosticEvent } from ${JSON.stringify(observer)};\n${test}\nbeforeEach(t => diagnosticEvent("test_start", { test: t.name }));\nafterEach(t => diagnosticEvent("test_end", { test: t.name }));\n`;
  writeFileSync(testPath, test);
  mkdirSync(join(source, "home"));
  mkdirSync(join(source, "tmp"));
  writeFileSync(join(output, `${label}-events.jsonl`), "");
  sources.push({ label, pin, source });
}
const deadline = Date.now() + 15 * 60_000;
writeFileSync(
  join(output, "deadline.json"),
  JSON.stringify({ deadline, sources }),
);
let failed = false;
for (const { label, pin, source } of sources) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Paired trial deadline exhausted");
  const start = {
    stage: "trial_start",
    label,
    pin,
    at: Date.now(),
    deadline,
    load: loadavg(),
  };
  console.log(JSON.stringify(start));
  appendFileSync(join(output, "results.jsonl"), `${JSON.stringify(start)}\n`);
  const log = join(output, `${label}-test.log`);
  const child = spawn("npm", ["test"], {
    cwd: source,
    env: {
      ...process.env,
      HOME: join(source, "home"),
      TMPDIR: `${join(source, "tmp")}/`,
      PR_REVIEW_DATA_DIR: join(source, "data"),
      PR_REVIEW_HOST: "127.0.0.1",
      NODE_OPTIONS: `--import=${observer}`,
      CLEANUP_DIAGNOSTIC_LEDGER: join(output, `${label}-events.jsonl`),
      CLEANUP_DIAGNOSTIC_ADDON: addon,
      CLEANUP_DIAGNOSTIC_OS: `${os}/${build}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 20_000_000)
        throw new Error("Paired trial output budget exhausted");
      appendFileSync(log, chunk);
      process.stdout.write(chunk);
    });
  const timer = setTimeout(() => {
    writeFileSync(
      join(output, "deadline-exhausted.json"),
      JSON.stringify({ label, deadline }),
    );
    process.exit(3);
  }, remaining);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const end = {
    stage: "trial_end",
    label,
    pin,
    at: Date.now(),
    load: loadavg(),
    ...result,
  };
  console.log(JSON.stringify(end));
  appendFileSync(join(output, "results.jsonl"), `${JSON.stringify(end)}\n`);
  failed ||= result.code !== 0;
}
process.exitCode = failed ? 1 : 0;

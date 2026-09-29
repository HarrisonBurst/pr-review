import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "../../config.js";
import { createHttpServer } from "../../http.js";
import { ReviewService } from "../../service.js";
import { runCommand } from "../../util.js";
import { deferredWork, DeferredGithub } from "./sync-lifecycle.js";

const root = await mkdtemp(join(tmpdir(), "pr-review-inert-sync-"));
const home = join(root, "home");
await mkdir(home);
process.env.HOME = home;
const config = loadConfig({
  host: "127.0.0.1",
  port: 0,
  demo: true,
  dataDir: root,
  databasePath: join(root, "fixture.sqlite"),
  reviewer: {
    skillPath: join(home, "absent-skill.md"),
    model: null,
    additionalInstructions: "",
  },
});
const github = new DeferredGithub();
if (process.argv.includes("--termination-refusal")) {
  const kill = process.kill.bind(process);
  let ownedPid: number | undefined;
  process.kill = ((pid, signal) => {
    if (ownedPid !== undefined && pid === -ownedPid && signal === "SIGTERM") {
      console.log(`INJECTED EPERM for owned inert group ${pid}`);
      throw Object.assign(new Error("kill EPERM (injected inert fixture)"), {
        code: "EPERM",
      });
    }
    return kill(pid, signal);
  }) as typeof process.kill;
  github.poll = async () => {
    const result = await runCommand(
      process.execPath,
      [
        "-e",
        "console.log(process.pid); setTimeout(() => process.exit(0), 6000)",
      ],
      {
        timeoutMs: 500,
        env: { HOME: home },
        onStdout: (chunk) => {
          ownedPid = Number(chunk.toString().trim());
          console.log(`OWNED inert child ${ownedPid}; self-exits after 6000ms`);
        },
      },
    );
    if (result.code !== 0 || result.timedOut || result.aborted)
      throw new Error(result.stderr);
    throw new Error("Inert timeout must not succeed");
  };
}
const service = await ReviewService.create(config, github);
if (process.argv.includes("--empty"))
  service.db.updateSettings({ repository: "" });
const server = createHttpServer(service, config);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No address");
config.port = address.port;
console.log(
  `INERT fixture: http://127.0.0.1:${address.port} DB: ${config.databasePath}`,
);
console.log(
  "Commands: hold|release|fail sync|import|readiness [number=42], status, quit",
);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const [command, kind, number = "42"] = line.trim().split(/\s+/);
  if (command === "quit") break;
  if (command === "status") {
    console.log(
      JSON.stringify({
        pollCalls: github.pollCalls,
        fetched: github.fetched,
        readinessCalls: github.readinessCalls,
        state: service.getState(),
      }),
    );
    continue;
  }
  if (!["sync", "import", "readiness"].includes(kind)) continue;
  const current =
    kind === "import"
      ? github.imports.get(Number(number))
      : kind === "sync"
        ? github.sync
        : github.readiness;
  if (command === "hold" && !current) {
    const work = deferredWork();
    if (kind === "import") github.imports.set(Number(number), work);
    else if (kind === "sync") github.sync = work;
    else github.readiness = work;
    void work.entered.then(() => console.log(`ACTIVE ${kind} ${number}`));
  } else if (current && ["release", "fail"].includes(command)) {
    if (command === "fail") current.reject(new Error(`Inert ${kind} failure`));
    else current.resolve();
    if (kind === "import") github.imports.delete(Number(number));
    else if (kind === "sync") github.sync = null;
    else github.readiness = null;
  }
}
input.close();
server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
await service.close();

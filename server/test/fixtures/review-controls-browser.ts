import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createHttpServer } from "../../http.js";
import { publicationFixture, fixturePrId } from "./auto-submission.js";
import { deferredWork } from "./sync-lifecycle.js";
import { saveFixtureExecution } from "./current-settings.js";

const home = await mkdtemp(
  path.join(tmpdir(), "pr-review-inert-controls-home-"),
);
process.env.HOME = home;
const f = await publicationFixture(process.argv.includes("--empty"));
let gate = deferredWork();
let failure = false;
f.reviewer.beforeResult = async () => {
  gate.enter();
  await gate.promise;
  if (failure) throw new Error("SYNTHETIC owned shutdown is unconfirmed");
};
const server = createHttpServer(f.service, f.config);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No inert address");
f.config.port = address.port;
console.log(
  `SYNTHETIC inert review controls: http://127.0.0.1:${address.port}`,
);
const input = createInterface({ input: process.stdin });
let work: Promise<void> | null = null;
try {
  for await (const line of input) {
    const command = line.trim();
    if (command === "quit") break;
    if (command === "queue") {
      if (!f.service.getHarness().effective)
        await saveFixtureExecution(f.service);
      await f.service.manualReview(fixturePrId);
    }
    if (command === "start") {
      const job = f.service.db.listJobs("queued")[0];
      if (!job) throw new Error("No synthetic queued job");
      gate = deferredWork();
      work = f.service.processJob(job);
      await gate.entered;
    }
    if (command === "finish" || command === "fail") {
      failure = command === "fail";
      gate.resolve();
      await work;
      failure = false;
    }
    if (command === "status")
      console.log(
        JSON.stringify({
          synthetic: true,
          nativeDispatches: 0,
          writes: f.github.writes.length,
          jobs: f.service.db
            .listJobs()
            .map(({ id, run_id, status }) => ({ id, runId: run_id, status })),
        }),
      );
    console.log(`SYNTHETIC completed: ${command}`);
  }
} finally {
  input.close();
  gate.resolve();
  await work;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f.close();
  await rm(home, { recursive: true, force: true });
}

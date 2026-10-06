import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHttpServer } from "../../http.js";
import { backlogFixture } from "./backlog.js";
import { deferredWork } from "./sync-lifecycle.js";

const home = await mkdtemp(join(tmpdir(), "pr-review-inert-backlog-home-"));
process.env.HOME = home;
const f = await backlogFixture(process.argv.includes("--empty") ? 0 : 3);
f.save(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
if (process.argv.includes("--setup"))
  f.service.db.updateSettings({ repository: "" });
let gate = deferredWork();
f.reviewer.beforeResult = async () => {
  gate.enter();
  await gate.promise;
};
f.service.queue.schedule = Object.getPrototypeOf(f.service.queue).schedule.bind(
  f.service.queue,
);
const server = createHttpServer(f.service, f.config);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No inert address");
f.config.port = address.port;
console.log(`SYNTHETIC inert backlog: http://127.0.0.1:${address.port}`);
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    if (line.trim() === "quit") break;
    if (line.trim() === "finish") gate.resolve();
    if (line.trim() === "hold") gate = deferredWork();
    if (line.trim() === "status")
      console.log(
        JSON.stringify({
          synthetic: true,
          nativeDispatches: 0,
          writes: f.github.writes.length,
          reviewerCalls: f.reviewer.calls,
          jobs: f.service.db
            .listJobs()
            .map(({ pr_id, status }) => ({ pr_id, status })),
          baselines: f.service.getState().prs.map((pr) => ({
            number: pr.number,
            status: pr.status,
            baseline: f.service.db.getAutomationState(pr.id),
          })),
        }),
      );
  }
} finally {
  input.close();
  gate.resolve();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f.close();
  await rm(home, { recursive: true, force: true });
}

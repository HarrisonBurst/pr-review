import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createHttpServer } from "../../http.js";
import type { GithubAdapter } from "../../adapters.js";
import { publicationFixture, fixturePrId } from "./auto-submission.js";

const home = await mkdtemp(
  path.join(tmpdir(), "pr-review-preview-inert-home-"),
);
process.env.HOME = home;
const f = await publicationFixture(process.argv.includes("--empty"));
if (!process.argv.includes("--empty")) await f.manualReview();
const calls: { step: string; at: number }[] = [];
const delay = async (step: string) => {
  calls.push({ step, at: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 700));
};
const fetchPr = f.github.getPullRequest.bind(f.github);
f.github.getPullRequest = async (...args) => {
  await delay("getPullRequest (broad PR/diff)");
  return fetchPr(...args);
};
const readiness = f.github.mergeReadiness.bind(f.github);
f.github.mergeReadiness = async (...args) => {
  await delay("mergeReadiness");
  return readiness(...args);
};
const inventory = f.github.reviewInventory.bind(f.github);
f.github.reviewInventory = async (...args) => {
  await delay("reviewInventory (baseline)");
  return inventory(...args);
};
const github: GithubAdapter = f.github;
github.getSubmissionHead = async () => {
  await delay("getSubmissionHead (lightweight)");
  return {
    headSha: f.github.current.pr.headSha,
    state: f.github.current.pr.state,
  };
};
const server = createHttpServer(f.service, f.config);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No inert address");
f.config.port = address.port;
console.log(
  `SYNTHETIC inert preview fixture: http://127.0.0.1:${address.port}/#/pr/${encodeURIComponent(fixturePrId)}`,
);
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    const command = line.trim();
    if (command === "quit") break;
    if (command === "status")
      console.log(
        JSON.stringify({
          synthetic: true,
          calls,
          writes: f.github.writes.length,
        }),
      );
    console.log(`SYNTHETIC completed: ${command}`);
  }
} finally {
  input.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f.close();
  await rm(home, { recursive: true, force: true });
}

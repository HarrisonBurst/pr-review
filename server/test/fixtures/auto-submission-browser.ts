import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { IncomingMessage, ServerResponse } from "node:http";
import { automationOff } from "../../../shared/contracts.js";
import { createHttpServer } from "../../http.js";
import {
  publicationFixture,
  fixturePrId,
  fixtureSource,
  inferenceOnlyQuotes,
} from "./auto-submission.js";
import { saveFixtureExecution } from "./current-settings.js";
import { deferredWork } from "./sync-lifecycle.js";

const home = await mkdtemp(
  path.join(tmpdir(), "pr-review-inert-publication-home-"),
);
process.env.HOME = home;
const f = await publicationFixture(process.argv.includes("--empty"));
const server = createHttpServer(f.service, f.config);
const dispatch = server.listeners("request")[0] as (
  request: IncomingMessage,
  response: ServerResponse,
) => void;
let intentGate: ReturnType<typeof deferredWork> | null = null;
let intentFailure = false;
server.removeListener("request", dispatch);
server.on("request", async (request, response) => {
  if (
    request.method === "POST" &&
    request.url?.endsWith("/draft/edit-intent")
  ) {
    if (intentGate) {
      console.log("SYNTHETIC edit intent pending");
      intentGate.enter();
      await intentGate.promise;
    }
    if (intentFailure) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "SYNTHETIC edit intent unavailable; no authority acknowledged",
          code: "fixture_unavailable",
        }),
      );
      return;
    }
  }
  dispatch(request, response);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No inert loopback address");
f.config.port = address.port;
console.log(`SYNTHETIC inert fixture: http://127.0.0.1:${address.port}`);
console.log(
  "Commands: manual, automatic, human, viewer, mixed, legacy-viewer, inferred, historical-inferred, clear, unavailable, coverage-fail, intent hold|release|fail|normal, status, quit",
);
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    const [command, action] = line.trim().split(/\s+/);
    if (command === "quit") break;
    if (command === "intent") {
      if (action === "hold") intentGate = deferredWork();
      else if (action === "fail") intentFailure = true;
      else if (action === "normal" || action === "release") {
        if (action === "normal") intentFailure = false;
        intentGate?.resolve();
        intentGate = null;
      }
    } else if (command === "manual") {
      if (!f.service.getHarness().effective)
        await saveFixtureExecution(f.service);
      await f.service.manualReview(fixturePrId);
      await f.service.processJob(f.service.db.listJobs("queued")[0]!);
    } else if (command === "automatic") {
      await f.automaticReview();
      f.service.updateSettings({ automation: automationOff });
    } else if (
      [
        "human",
        "viewer",
        "mixed",
        "legacy-viewer",
        "inferred",
        "historical-inferred",
        "clear",
        "unavailable",
        "coverage-fail",
      ].includes(command)
    ) {
      f.github.sources = command.includes("inferred")
        ? inferenceOnlyQuotes.map((quote, index) =>
            fixtureSource(quote, `synthetic-inference-${index}`),
          )
        : command === "human"
          ? [fixtureSource()]
          : ["viewer", "mixed", "legacy-viewer"].includes(command)
            ? [
                fixtureSource(
                  "SYNTHETIC Please request a human review of this change.",
                  "synthetic-viewer",
                  "demo-user",
                ),
                ...(command === "mixed" ? [fixtureSource()] : []),
              ]
            : [];
      f.github.complete = command !== "coverage-fail";
      f.reviewer.extensionMode = command === "unavailable" ? "null" : "normal";
      f.reviewer.decisions.clear();
      for (const source of f.github.sources)
        f.reviewer.decisions.set(
          source.id,
          command === "inferred" ? "not_requested" : "requested",
        );
      console.log("SYNTHETIC preselected observation, not model detection");
      const viewerLogin = f.github.current.viewerLogin;
      if (command === "legacy-viewer") delete f.github.current.viewerLogin;
      try {
        await f.manualReview();
      } finally {
        f.github.current.viewerLogin = viewerLogin;
      }
    } else if (command === "status") {
      const detail = f.service.db.getPr(fixturePrId)
        ? f.service.getDetail(fixturePrId)
        : null;
      console.log(
        JSON.stringify({
          synthetic: true,
          nativeDispatches: 0,
          reviewerCalls: f.reviewer.calls,
          detection: detail?.pr.autoSubmission?.detection?.status ?? null,
          writes: f.github.writes.length,
          runs: detail?.runs.length ?? 0,
          draftVersion: detail?.draft?.version ?? null,
          manualHold: detail?.draft?.autoSubmission?.manualHold?.reason ?? null,
          submissions:
            detail?.submissions.map((item) => ({
              status: item.status,
              authority: item.authority?.kind,
            })) ?? [],
          autoStatus: detail?.pr.autoSubmission?.status ?? null,
          evidence: detail?.pr.autoSubmission?.evidence.length ?? 0,
          previews: f.service.db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM previews")
            .get(),
        }),
      );
    }
    console.log(`SYNTHETIC command completed: ${line.trim()}`);
  }
} finally {
  input.close();
  intentGate?.resolve();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f.close();
  await rm(home, { recursive: true, force: true });
}

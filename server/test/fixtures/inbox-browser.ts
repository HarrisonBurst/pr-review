import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createHttpServer } from "../../http.js";
import { publicationFixture, fixturePrId } from "./auto-submission.js";
import { deriveViewerApproval } from "../../discussion.js";

const home = await mkdtemp(path.join(tmpdir(), "pr-review-inert-inbox-home-"));
process.env.HOME = home;
const f = await publicationFixture(process.argv.includes("--empty"));
const rows = new Map<number, typeof f.github.current>();
const base = structuredClone(f.github.current);
for (const [number, label, day, approval] of [
  [20998, "earlier viewer approval", "01", "earlier"],
  [21647, "current viewer approval", "02", "current"],
  [42, "submitted review", "03", null],
  [44, "ordinary requested review", "04", null],
  [45, "ordinary ready draft", "05", null],
] as const) {
  const item = structuredClone(base);
  item.pr = {
    ...item.pr,
    id: `demo/repository#${number}`,
    number,
    title: `SYNTHETIC inbox: ${label}`,
    url: `https://github.com/demo/repository/pull/${number}`,
    headSha: "a".repeat(40),
    requestedAt: `2026-01-${day}T00:00:00Z`,
    historicalRequestSource: "direct",
    viewerApproval: approval
      ? deriveViewerApproval(
          "demo-user",
          [
            {
              id: 1,
              user: { login: "demo-user" },
              state: "APPROVED",
              submitted_at: "2026-01-06T00:00:00Z",
              commit_id:
                approval === "current" ? "a".repeat(40) : "b".repeat(40),
            },
          ],
          "a".repeat(40),
        )
      : null,
  };
  rows.set(number, item);
}
f.github.getPullRequest = async (_repository, number) =>
  structuredClone(rows.get(number)!);
f.github.poll = async () => ({
  user: "demo-user",
  pullRequests: structuredClone([...rows.values()]),
  requests: [],
});
if (!process.argv.includes("--empty")) {
  await f.service.sync();
  for (const number of [42, 20998, 21647, 45]) {
    await f.service.manualReview(`demo/repository#${number}`);
    await f.service.processJob(f.service.db.listJobs("queued")[0]!);
  }
  const draft = f.service.getDetail(fixturePrId).draft!;
  const preview = await f.service.preview(fixturePrId, draft.id, draft.version);
  f.service.db.createSubmission(
    {
      id: "synthetic-inbox-submission",
      previewId: preview.id,
      status: "submitted",
      payload: preview.payload,
      githubReviewId: "synthetic-inbox-review",
      url: "https://example.invalid/synthetic-inbox-review",
      error: null,
      createdAt: "2026-01-07T00:00:00Z",
    },
    fixturePrId,
  );
  f.service.db.setPrStatus(fixturePrId, "submitted");
}
const server = createHttpServer(f.service, f.config);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No inert address");
f.config.port = address.port;
console.log(`SYNTHETIC inert inbox: http://127.0.0.1:${address.port}`);
const input = createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    if (line.trim() === "quit") break;
    if (line.trim() === "status")
      console.log(
        JSON.stringify({
          synthetic: true,
          nativeDispatches: 0,
          writes: f.github.writes.length,
          prs: f.service
            .getState()
            .prs.map(({ number, status, viewerApproval }) => ({
              number,
              status,
              viewerApproval,
            })),
        }),
      );
  }
} finally {
  input.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f.close();
  await rm(home, { recursive: true, force: true });
}

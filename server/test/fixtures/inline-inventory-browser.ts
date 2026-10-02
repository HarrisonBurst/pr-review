import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createHttpServer } from "../../http.js";
import { fixturePrId } from "./auto-submission.js";
import { inlineInventoryFixture } from "./inline-inventory.js";

const home = await mkdtemp(path.join(tmpdir(), "pr-review-inline-home-"));
process.env.HOME = home;
const f = await inlineInventoryFixture(process.argv.includes("--empty"));
const server = createHttpServer(f.service, f.config);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No inert loopback address");
f.config.port = address.port;
console.log(
  `SYNTHETIC inert inline inventory: http://127.0.0.1:${address.port}`,
);
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
          status: f.service.db.getPr(fixturePrId)?.status ?? null,
          draftVersion: f.service.db.latestDraft(fixturePrId)?.version ?? null,
          submissions: f.service.db.listSubmissions(fixturePrId).length,
          previews: f.service.db.sqlite
            .prepare("SELECT COUNT(*) AS count FROM previews")
            .get(),
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

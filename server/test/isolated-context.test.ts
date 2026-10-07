import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fixture } from "./fixtures/isolated-context.js";

async function tick(t: TestContext, attempts: number) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    t.mock.timers.tick(20);
    await Promise.resolve();
  }
}

for (const advances of [true, false])
  test(`isolated fixture queue ${advances ? "allows sustained phase and role progress" : "rejects stalled work despite activity"}`, async (t) => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let pending: Promise<unknown> | undefined;
    try {
      await f.send("/settings/harness", f.selection, "PATCH");
      await f.send("/sync", {});
      await f.send(`${f.pr}/review`, {});
      const run = (await f.detail()).runs[0];
      const progress = structuredClone(run.progress!);
      progress.phases.push({
        id: "checkout",
        status: "running",
        startedAt: run.createdAt,
        finishedAt: null,
        detail: null,
      });
      t.mock.method(f.service, "processJob", async () => {
        f.service.db.updateRun(run.id, { status: "running" });
        f.service.db.setRunProgress(run.id, progress);
        started.resolve();
        await finished.promise;
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let settled = false;
      pending = f.dispatch().then(
        () => {
          settled = true;
          return null;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await started.promise;
      await tick(t, 1);
      if (advances) {
        for (const entry of [progress.phases.at(-1)!, ...progress.entries!]) {
          await tick(t, 150);
          assert.equal(settled, false);
          entry.status = "completed";
          f.service.db.setRunProgress(run.id, progress);
          await tick(t, 1);
        }
        f.service.db.updateRun(run.id, { status: "completed" });
        finished.resolve();
        await tick(t, 1);
        assert.equal(await pending, null);
      } else {
        for (let attempt = 0; attempt < 200; attempt++) {
          progress.activityCount++;
          progress.updatedAt = new Date().toISOString();
          f.service.db.setRunProgress(run.id, progress);
          await tick(t, 1);
        }
        const error = await pending;
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.message, "Fixture queue did not finish");
        assert.equal(f.service.db.getRun(run.id)!.status, "running");
      }
    } finally {
      finished.resolve();
      t.mock.timers.reset();
      await pending;
      await f.close();
    }
  });

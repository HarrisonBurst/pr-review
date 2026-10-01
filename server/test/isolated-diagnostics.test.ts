import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import path from "node:path";
import { isolatedDiagnostics } from "./fixtures/isolated-diagnostics.js";
import { fixture } from "./fixtures/isolated-context.js";
import type { ReviewRun } from "../../shared/contracts.js";

const canary = "SYNTHETIC_CREDENTIAL_ENV_PR_DIAGNOSTIC_CANARY";
const capture = (t: TestContext, bin: string) => {
  const output: string[] = [];
  const diagnostics = isolatedDiagnostics(
    {
      mock: t.mock,
      after: t.after.bind(t),
      diagnostic: (text) => output.push(text),
    },
    bin,
  );
  return {
    output,
    diagnostics,
    async run(body: () => Promise<void>, cleanup: () => Promise<void>) {
      try {
        await body();
      } catch (error) {
        diagnostics.bodyFailed(error);
        throw error;
      } finally {
        await diagnostics.cleanup(cleanup);
      }
    },
  };
};

for (const [bodyFails, cleanupFails] of [
  [true, false],
  [false, true],
  [true, true],
  [false, false],
]) {
  test(`isolated diagnostics retain body=${bodyFails} and cleanup=${cleanupFails} without changing rejection`, async (t) => {
    const originalSpawn = childProcess.spawn;
    const originalKill = process.kill;
    const { run, output } = capture(t, "unused-inert-bin");
    const bodyError = new assert.AssertionError({
      message: canary,
      actual: canary,
      expected: canary + "-expected",
    });
    const cleanupError = Object.assign(new Error(canary), {
      name: canary,
      code: "EPERM",
    });
    let cleaned = false;
    const result = run(
      async () => {
        if (bodyFails) throw bodyError;
      },
      async () => {
        cleaned = true;
        if (cleanupFails) throw cleanupError;
      },
    );
    if (bodyFails || cleanupFails) {
      await assert.rejects(
        result,
        (error) => error === (cleanupFails ? cleanupError : bodyError),
      );
      const report = JSON.parse(output[0]);
      assert.deepEqual(
        report.stages.body,
        bodyFails
          ? { status: "failed", name: "AssertionError", code: "ERR_ASSERTION" }
          : { status: "completed" },
      );
      assert.deepEqual(
        report.stages.cleanup,
        cleanupFails
          ? { status: "failed", name: "Error", code: "EPERM" }
          : { status: "completed" },
      );
      assert.doesNotMatch(output[0], new RegExp(canary));
    } else {
      await result;
      assert.deepEqual(output, []);
    }
    assert.equal(cleaned, true);
    assert.equal(childProcess.spawn, originalSpawn);
    assert.equal(spawn, originalSpawn);
    assert.equal(process.kill, originalKill);
  });
}

test("isolated diagnostics project unfinished dispatch without values or assertion changes", async (t) => {
  const { diagnostics, run: diagnose, output } = capture(t, "unused-inert-bin");
  const failure = Object.assign(new Error(canary), { code: canary });
  const run = {
    id: canary,
    status: "running",
    error: canary,
    log: canary,
    progress: {
      phases: [
        {
          id: "workflow",
          status: "running",
          startedAt: canary,
          finishedAt: null,
          detail: canary,
        },
      ],
      entries: [
        {
          id: canary,
          role: "additional",
          harness: "codex",
          model: canary,
          status: "running",
          startedAt: canary,
          finishedAt: null,
          result: null,
          error: canary,
        },
      ],
      activity: [{ at: canary, source: "app", kind: "message", label: canary }],
      activityCount: 1,
      lastActivityAt: canary,
      updatedAt: canary,
    },
  } as ReviewRun;
  await assert.rejects(
    diagnose(
      async () => {
        diagnostics.dispatch(run, 199, performance.now());
        throw failure;
      },
      async () => {},
    ),
    (error) => error === failure,
  );
  const report = JSON.parse(output[0]);
  const { ms, ...dispatch } = report.dispatch;
  assert.ok(Number.isInteger(ms) && ms >= 0 && ms <= 3_600_000);
  assert.deepEqual(dispatch, {
    attempt: 199,
    status: "running",
    phases: [{ phase: "workflow", status: "running" }],
    entries: [{ index: 0, role: "additional", status: "running" }],
  });
  assert.equal(report.stages.body.code, "other");
  assert.doesNotMatch(output[0], new RegExp(canary));
});

test("isolated diagnostics correlate actual child PID reads, signals, exit and close and restore hooks", async (t) => {
  const f = await fixture();
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  await f.script(
    "pi",
    `console.log(${JSON.stringify(canary)}); setInterval(() => {}, 1000);`,
  );
  await f.script(
    "git",
    `console.log(${JSON.stringify(canary)}); process.exit(7);`,
  );
  Object.assign(f.env, { BUSINESS_SECRET: canary });
  const { diagnostics, run, output } = capture(t, path.join(f.root, "bin"));
  const failure = Object.assign(new Error(canary), { code: "EPERM" });
  const children: childProcess.ChildProcess[] = [];
  await assert.rejects(
    run(
      async () => {
        for (const command of ["pi", "git"]) {
          const child = childProcess.spawn(command, [canary], {
            env: f.env,
            detached: true,
          });
          children.push(child);
          const closed = once(child, "close");
          if (command === "pi") {
            await once(child.stdout!, "data");
            const pid = child.pid!;
            await Promise.resolve();
            const before = diagnostics.events.length;
            assert.equal(process.kill(-pid, 0), true);
            assert.equal(diagnostics.events.length, before);
            assert.equal(process.kill(-child.pid!, "SIGTERM"), true);
          }
          await closed;
        }
        assert.throws(() => process.kill(-children[1].pid!, 0), {
          code: "ESRCH",
        });
        throw failure;
      },
      async () => {
        await f.close();
      },
    ),
    (error) => error === failure,
  );
  const report = JSON.parse(output[0]);
  const spawns = report.events.filter((event: any) => event.event === "spawn");
  assert.deepEqual(
    spawns.map((event: any) => [
      event.child,
      event.pid,
      event.parent,
      event.detached,
    ]),
    children.map((child, index) => [index + 1, child.pid, process.pid, true]),
  );
  const signals = report.events.filter(
    (event: any) => event.event === "signal",
  );
  assert.equal(signals.length, 2);
  assert.deepEqual(
    [signals[1].child, signals[1].signal, signals[1].exited, signals[1].closed],
    [2, 0, true, true],
  );
  assert.deepEqual(
    report.events
      .filter((event: any) => event.event === "signal_error")
      .map((event: any) => [event.child, event.code]),
    [[2, "ESRCH"]],
  );
  assert.deepEqual(
    [
      signals[0].child,
      signals[0].pid,
      signals[0].signal,
      signals[0].attribution,
      signals[0].exited,
      signals[0].closed,
    ],
    [1, children[0].pid, "SIGTERM", "child_pid_read", false, false],
  );
  assert.deepEqual(
    report.events
      .filter((event: any) => ["exit", "close"].includes(event.event))
      .map((event: any) => [
        event.event,
        event.child,
        event.code,
        event.signal,
      ]),
    [
      ["exit", 1, null, "SIGTERM"],
      ["close", 1, null, "SIGTERM"],
      ["exit", 2, 7, null],
      ["close", 2, 7, null],
    ],
  );
  assert.ok(
    report.events.every(
      (event: any, index: number) => event.sequence === index + 1,
    ),
  );
  assert.doesNotMatch(
    output[0],
    new RegExp(
      [canary, f.root, f.home, f.env.CLAUDE_CODE_OAUTH_TOKEN].join("|"),
    ),
  );
  assert.equal(childProcess.spawn, originalSpawn);
  assert.equal(spawn, originalSpawn);
  assert.equal(process.kill, originalKill);
  for (const child of children)
    assert.equal(Object.getOwnPropertyDescriptor(child, "pid")?.get, undefined);
});

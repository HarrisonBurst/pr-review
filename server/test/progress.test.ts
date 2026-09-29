import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunProgress } from "../../shared/contracts.js";
import {
  RunProgressTracker,
  activityLimit,
  boundedLabel,
  emptyProgress,
  interruptProgress,
} from "../progress.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("phases are recorded in order with timestamps and bounded details", () => {
  const flushes: RunProgress[] = [];
  const tracker = new RunProgressTracker((progress) => flushes.push(progress));
  tracker.phase("checkout", "running");
  tracker.phase("checkout", "running");
  tracker.phase("checkout", "completed", "abc1234..def5678");
  tracker.phase("codex", "running");
  tracker.phase("codex", "failed", `boom\n${"x".repeat(400)}`);
  tracker.phase("claude", "running");
  tracker.failRunning("exit 1");
  tracker.phase("finalize", "skipped", "no result");
  tracker.close();
  const { phases } = tracker.progress;
  assert.deepEqual(
    phases.map((phase) => [phase.id, phase.status]),
    [
      ["checkout", "completed"],
      ["codex", "failed"],
      ["claude", "failed"],
      ["finalize", "skipped"],
    ],
  );
  assert.equal(phases[0]!.detail, "abc1234..def5678");
  assert.ok(phases[1]!.detail!.length <= 200);
  assert.equal(phases[1]!.detail!.includes("\n"), false);
  assert.equal(phases[2]!.detail, "exit 1");
  for (const phase of phases) assert.ok(phase.finishedAt! >= phase.startedAt);
  assert.deepEqual(
    tracker.progress.activity.map((entry) => entry.label),
    [
      "Preparing pinned checkout started",
      "Preparing pinned checkout completed",
      "Codex cross-check started",
      "Codex cross-check failed",
      "Claude review started",
      "Claude review failed",
      "Validating and saving result skipped",
    ],
  );
  assert.ok(flushes.length >= 7);
  assert.notEqual(flushes.at(-1), tracker.progress);
  tracker.phase("finalize", "running");
  assert.equal(tracker.progress.phases.length, 4);
});

test("activity keeps a bounded tail, a total count, and throttles persistence", async () => {
  const flushes: RunProgress[] = [];
  const tracker = new RunProgressTracker(
    (progress) => flushes.push(progress),
    100,
  );
  for (let i = 0; i < 500; i += 1)
    tracker.activity("claude", "read", `Reading file-${i}.ts`);
  assert.equal(tracker.progress.activity.length, activityLimit);
  assert.equal(tracker.progress.activityCount, 500);
  assert.equal(tracker.progress.activity[0]!.label, "Reading file-460.ts");
  assert.equal(tracker.progress.activity.at(-1)!.label, "Reading file-499.ts");
  assert.equal(flushes.length, 1);
  await wait(150);
  assert.equal(flushes.length, 2);
  assert.equal(flushes[1]!.activityCount, 500);
  tracker.activity("claude", "read", "   \u0000  ");
  assert.equal(tracker.progress.activityCount, 500);
  tracker.close();
  assert.equal(flushes.length, 3);
  tracker.activity("claude", "read", "after close");
  assert.equal(flushes.length, 3);
});

test("labels are flattened and clamped", () => {
  assert.equal(boundedLabel("a\r\n b\t\u001bc"), "a b c");
  const long = boundedLabel("x".repeat(500));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});

test("interruptProgress marks only running phases as interrupted", () => {
  const progress: RunProgress = {
    ...emptyProgress(),
    phases: [
      {
        id: "checkout",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z",
        detail: null,
      },
      {
        id: "claude",
        status: "running",
        startedAt: "2026-01-01T00:00:05.000Z",
        finishedAt: null,
        detail: null,
      },
    ],
  };
  const stopped = interruptProgress(progress, "2026-01-01T00:01:00.000Z");
  assert.equal(stopped.phases[0]!.status, "completed");
  assert.equal(stopped.phases[1]!.status, "interrupted");
  assert.equal(stopped.phases[1]!.finishedAt, "2026-01-01T00:01:00.000Z");
  assert.equal(progress.phases[1]!.status, "running");
});

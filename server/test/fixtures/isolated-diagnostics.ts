import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ReviewRun } from "../../../shared/contracts.js";

const label = (value: unknown, allowed: readonly unknown[]) =>
  allowed.includes(value) ? value : "other";
const status = (value: unknown) =>
  label(value, [
    "pending",
    "queued",
    "running",
    "completed",
    "failed",
    "interrupted",
    "skipped",
  ]);
const errorSummary = (error: unknown) => ({
  name:
    error instanceof assert.AssertionError
      ? "AssertionError"
      : error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : error instanceof Error
            ? "Error"
            : "other",
  code: label(
    error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")?.value
      : undefined,
    ["ERR_ASSERTION", "EPERM", "ESRCH", "ENOENT", "EACCES", "ABORT_ERR"],
  ),
});
const signalLabel = (signal: unknown) =>
  label(signal, [0, "SIGTERM", "SIGKILL", null]);
const exitCode = (code: unknown) =>
  code === null ||
  (Number.isInteger(code) && Number(code) >= 0 && Number(code) <= 255)
    ? code
    : "other";

export function isolatedDiagnostics(
  t: Pick<TestContext, "mock" | "after" | "diagnostic">,
  bin: string,
) {
  const started = performance.now();
  const events: Record<string, unknown>[] = [];
  let sequence = 0;
  let children = 0;
  let stage: "body" | "cleanup" = "body";
  const stages: Partial<Record<"body" | "cleanup", Record<string, unknown>>> =
    {};
  let dispatch: Record<string, unknown> | undefined;
  const elapsed = () =>
    Math.min(3_600_000, Math.round(performance.now() - started));
  const record = (event: string, data: Record<string, unknown>) => {
    events.push({ sequence: ++sequence, ms: elapsed(), stage, event, ...data });
    if (events.length > 256) events.shift();
  };
  const restorations: Array<() => void> = [];
  let pidRead:
    | {
        child: number;
        pid: number;
        detached: boolean;
        exited: boolean;
        closed: boolean;
      }
    | undefined;
  const spawn = childProcess.spawn;
  const spawnHook = t.mock.method(
    childProcess,
    "spawn",
    (...args: Parameters<typeof spawn>) => {
      const child = Reflect.apply(spawn, childProcess, args);
      const options = args[2];
      const name = path.basename(args[0]);
      if (
        !["gh", "git", "claude", "codex", "pi"].includes(name) ||
        (args[0] !== name && args[0] !== path.join(bin, name)) ||
        options?.env?.PATH?.split(path.delimiter)[0] !== bin
      )
        return child;
      const descriptor = Object.getOwnPropertyDescriptor(child, "pid");
      const identity = {
        child: ++children,
        pid: child.pid,
        detached: options.detached === true,
        exited: false,
        closed: false,
      };
      record("spawn", { ...identity, command: name, parent: process.pid });
      if (descriptor && typeof descriptor.value === "number") {
        let pid = descriptor.value as number;
        Object.defineProperty(child, "pid", {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get() {
            pidRead = { ...identity, pid };
            queueMicrotask(() => {
              pidRead = undefined;
            });
            return pid;
          },
          set(value: number) {
            pid = value;
          },
        });
        restorations.push(() =>
          Object.defineProperty(child, "pid", { ...descriptor, value: pid }),
        );
      }
      const spawned = () => record("spawned", { child: identity.child });
      const exited = (code: number | null, signal: NodeJS.Signals | null) => {
        identity.exited = true;
        record("exit", {
          child: identity.child,
          code: exitCode(code),
          signal: signalLabel(signal),
        });
      };
      const closed = (code: number | null, signal: NodeJS.Signals | null) => {
        identity.closed = true;
        record("close", {
          child: identity.child,
          code: exitCode(code),
          signal: signalLabel(signal),
        });
      };
      child.once("spawn", spawned);
      child.once("exit", exited);
      child.once("close", closed);
      restorations.push(() => {
        child.removeListener("spawn", spawned);
        child.removeListener("exit", exited);
        child.removeListener("close", closed);
      });
      return child;
    },
  );
  const kill = process.kill;
  const killHook = t.mock.method(
    process,
    "kill",
    (...args: Parameters<typeof kill>) => {
      const identity = pidRead;
      pidRead = undefined;
      const matches =
        identity && args[0] === -identity.pid && identity.detached;
      if (matches)
        record("signal", {
          ...identity,
          signal: signalLabel(args[1]),
          attribution: "child_pid_read",
        });
      try {
        const result = Reflect.apply(kill, process, args);
        if (matches) record("signal_result", { child: identity.child, result });
        return result;
      } catch (error) {
        if (matches)
          record("signal_error", {
            child: identity.child,
            ...errorSummary(error),
          });
        throw error;
      }
    },
  );
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    spawnHook.mock.restore();
    killHook.mock.restore();
    syncBuiltinESMExports();
    for (const restorePid of restorations.splice(0)) restorePid();
    pidRead = undefined;
  };
  t.after(restore);
  return {
    events,
    dispatch(run: ReviewRun, attempt: number, dispatchStarted: number) {
      dispatch = {
        attempt,
        ms: Math.min(
          3_600_000,
          Math.round(performance.now() - dispatchStarted),
        ),
        status: status(run.status),
        phases:
          run.progress?.phases.slice(0, 6).map((phase) => ({
            phase: label(phase.id, [
              "sync",
              "checkout",
              "codex",
              "claude",
              "workflow",
              "finalize",
            ]),
            status: status(phase.status),
          })) ?? [],
        entries:
          run.progress?.entries?.slice(0, 9).map((entry, index) => ({
            index,
            role: label(entry.role, ["main", "additional"]),
            status: status(entry.status),
          })) ?? [],
      };
    },
    bodyFailed(error: unknown) {
      stages.body = { status: "failed", ...errorSummary(error) };
    },
    async cleanup(action: () => Promise<void>) {
      stages.body ??= { status: "completed" };
      stage = "cleanup";
      try {
        await action();
        stages.cleanup = { status: "completed" };
      } catch (error) {
        stages.cleanup = { status: "failed", ...errorSummary(error) };
        throw error;
      } finally {
        restore();
        if (
          stages.body.status === "failed" ||
          stages.cleanup?.status === "failed"
        )
          t.diagnostic(
            JSON.stringify({
              fixture: "isolated",
              stages,
              dispatch,
              events,
              dropped: Math.max(0, sequence - events.length),
            }),
          );
      }
    },
  };
}

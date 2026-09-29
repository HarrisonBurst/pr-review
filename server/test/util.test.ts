import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  runCommand,
  terminateRunningCommands,
  type CommandOptions,
} from "../util.js";

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail("timed out waiting for child pid");
}

test("runCommand timeout terminates the owned process tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-review-process-"));
  const pidPath = join(directory, "child.pid");
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  try {
    const result = await runCommand(process.execPath, ["-e", script], {
      timeoutMs: 100,
    });
    await waitForFile(pidPath);
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    const childPid = Number(await readFile(pidPath, "utf8"));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(childPid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("owned descendant remained alive after timeout");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function inertCommand(
  t: TestContext,
  options: CommandOptions = {},
  ignoreTerm = false,
) {
  const ready = Promise.withResolvers<number>();
  const result = runCommand(
    process.execPath,
    [
      "-e",
      `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
       console.log(process.pid);
       setTimeout(() => process.exit(0), 10000);`,
    ],
    {
      ...options,
      onStdout: (chunk) => ready.resolve(Number(chunk.toString())),
    },
  );
  void result.catch(ready.reject);
  t.after(async () => {
    t.mock.restoreAll();
    await terminateRunningCommands();
    await result.catch(() => {});
  });
  return { pid: await ready.promise, result };
}

test("normal exits preserve output and actual exit status", async () => {
  for (const code of [0, 7]) {
    const result = await runCommand(process.execPath, [
      "-e",
      `console.log("out"); console.error("err"); process.exit(${code})`,
    ]);
    assert.deepEqual(result, {
      stdout: "out\n",
      stderr: "err\n",
      stdoutTruncated: false,
      stderrTruncated: false,
      code,
      signal: null,
      timedOut: false,
      aborted: false,
    });
  }
});

test("spawn failure and cancellation before spawn reject", async () => {
  await assert.rejects(runCommand("/nonexistent/pr-review-inert-command", []), {
    code: "ENOENT",
  });
  const reason = new Error("inert cancellation");
  await assert.rejects(
    runCommand(process.execPath, [], { signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
});

test("cancellation terminates the owned command and reports abort", async (t) => {
  const controller = new AbortController();
  const { result } = await inertCommand(t, { signal: controller.signal });
  controller.abort();
  const actual = await result;
  assert.equal(actual.aborted, true);
  assert.equal(actual.timedOut, false);
  assert.notEqual(actual.code, 0);
  assert.match(actual.stderr, /Aborted/);
});

test("normal timeout escalates when the owned command ignores SIGTERM", async (t) => {
  const { result } = await inertCommand(t, { timeoutMs: 1000 }, true);
  const actual = await result;
  assert.equal(actual.timedOut, true);
  assert.equal(actual.aborted, false);
  assert.equal(actual.signal, "SIGKILL");
  assert.notEqual(actual.code, 0);
  assert.match(actual.stderr, /Timed out/);
});

for (const reason of ["timeout", "abort"] as const) {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`${reason} ${signal} refusal rejects without losing ownership`, async (t) => {
      const controller = new AbortController();
      const { pid, result } = await inertCommand(
        t,
        {
          timeoutMs: reason === "timeout" ? 1000 : undefined,
          signal: controller.signal,
        },
        signal === "SIGKILL",
      );
      const kill = process.kill.bind(process);
      const refusal = Object.assign(new Error("kill EPERM (injected)"), {
        code: "EPERM",
      });
      const signals: Array<Parameters<typeof process.kill>[1]> = [];
      t.mock.method(
        process,
        "kill",
        (...[target, value]: Parameters<typeof process.kill>) => {
          assert.equal(target, -pid);
          if (value !== 0) signals.push(value);
          if (value === signal) throw refusal;
          return kill(target, value);
        },
      );
      const rejected = assert.rejects(result, (error: Error) => {
        assert.equal(error.cause, refusal);
        assert.match(
          error.message,
          new RegExp(
            `Command ${reason === "timeout" ? "timed out" : "aborted"}`,
          ),
        );
        assert.match(
          error.message,
          new RegExp(`${signal} failed:.*EPERM.*cleanup is unconfirmed`),
        );
        return true;
      });
      if (reason === "abort") controller.abort();
      await rejected;
      assert.equal(kill(pid, 0), true);
      assert.deepEqual(
        signals,
        signal === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
      );
      await assert.rejects(
        terminateRunningCommands(),
        (error) => error === refusal,
      );
    });
  }
}

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`${signal} ESRCH remains a nonfatal disappearance race`, async (t) => {
    const controller = new AbortController();
    const { pid, result } = await inertCommand(
      t,
      { signal: controller.signal },
      signal === "SIGKILL",
    );
    const kill = process.kill.bind(process);
    t.mock.method(
      process,
      "kill",
      (...[target, value]: Parameters<typeof process.kill>) => {
        assert.equal(target, -pid);
        const sent = kill(target, value);
        if (value === signal)
          throw Object.assign(new Error("kill ESRCH (injected race)"), {
            code: "ESRCH",
          });
        return sent;
      },
    );
    controller.abort();
    const actual = await result;
    assert.equal(actual.aborted, true);
    assert.notEqual(actual.code, 0);
    assert.match(actual.stderr, /Aborted/);
  });
}

test("shutdown does not signal a command again after observed close", async (t) => {
  const { pid, result } = await inertCommand(t);
  const kill = process.kill.bind(process);
  const signals: Array<Parameters<typeof process.kill>[1]> = [];
  t.mock.method(
    process,
    "kill",
    (...[target, value]: Parameters<typeof process.kill>) => {
      assert.equal(target, -pid);
      if (value !== 0) signals.push(value);
      return kill(target, value);
    },
  );
  await terminateRunningCommands();
  assert.notEqual((await result).code, 0);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("abort and concurrent shutdown share signals and await close", async (t) => {
  const controller = new AbortController();
  const { pid, result } = await inertCommand(t, { signal: controller.signal });
  const kill = process.kill.bind(process);
  const signals: Array<Parameters<typeof process.kill>[1]> = [];
  t.mock.method(
    process,
    "kill",
    (...[target, value]: Parameters<typeof process.kill>) => {
      assert.equal(target, -pid);
      if (value !== 0) {
        assert.ok(!signals.includes(value), "duplicate signal before close");
        signals.push(value);
      }
      return kill(target, value);
    },
  );
  let closed = false;
  void result.then(() => {
    closed = true;
  });
  controller.abort();
  await Promise.all([terminateRunningCommands(), terminateRunningCommands()]);
  assert.equal(closed, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal((await result).aborted, true);
});

for (const parentExitsFirst of [false, true]) {
  test(`shutdown retains ignored-stdio descendants when parent exits ${parentExitsFirst ? "before shutdown" : "on SIGTERM"}`, async (t) => {
    const ready = Promise.withResolvers<number>();
    const descendant =
      'process.on("SIGTERM", () => {}); console.log(process.pid); setTimeout(() => process.exit(0), 10000)';
    const result = runCommand(
      process.execPath,
      [
        "-e",
        `
      const {spawn} = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: ["ignore", "pipe", "ignore"]});
      child.stdout.once("data", chunk => {
        console.log(String(chunk).trim());
        child.stdout.destroy();
        child.unref();
        ${parentExitsFirst ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
      });
    `,
      ],
      { onStdout: (chunk) => ready.resolve(Number(chunk.toString())) },
    );
    t.after(async () => {
      await terminateRunningCommands();
      await result;
    });
    const pid = await ready.promise;
    if (parentExitsFirst) assert.equal((await result).code, 0);
    await terminateRunningCommands();
    await result;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("shutdown waits for forced close after the parent exits with inherited pipes", async (t) => {
  const ready = Promise.withResolvers<number>();
  const result = runCommand(
    process.execPath,
    [
      "-e",
      `
    const {spawn} = require("node:child_process");
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log(process.pid); setTimeout(() => process.exit(0), 10000)'], {stdio: ["ignore", "inherit", "inherit"]});
    child.unref();
  `,
    ],
    { onStdout: (chunk) => ready.resolve(Number(chunk.toString())) },
  );
  t.after(async () => {
    await terminateRunningCommands();
    await result;
  });
  const pid = await ready.promise;
  let closed = false;
  void result.then(() => {
    closed = true;
  });
  await terminateRunningCommands();
  assert.equal(closed, true);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("shutdown retains descendants after leader close and reports signal refusal", async (t) => {
  const ready = Promise.withResolvers<number>();
  const result = runCommand(
    process.execPath,
    [
      "-e",
      `
    const {spawn} = require("node:child_process");
    const child = spawn(process.execPath, ["-e", 'setTimeout(() => process.exit(0), 10000)'], {stdio: "ignore"});
    child.unref();
    console.log(process.pid);
  `,
    ],
    { onStdout: (chunk) => ready.resolve(Number(chunk.toString())) },
  );
  const pid = await ready.promise;
  t.after(async () => {
    t.mock.restoreAll();
    await terminateRunningCommands();
    await result;
  });
  await result;
  const kill = process.kill.bind(process);
  const refusal = Object.assign(new Error("kill EPERM (owned descendant)"), {
    code: "EPERM",
  });
  t.mock.method(
    process,
    "kill",
    (...[target, value]: Parameters<typeof process.kill>) => {
      assert.equal(target, -pid);
      if (value !== 0) throw refusal;
      return kill(target, value);
    },
  );
  await assert.rejects(
    terminateRunningCommands(),
    (error) => error === refusal,
  );
  assert.equal(kill(-pid, 0), true);
  t.mock.restoreAll();
  await terminateRunningCommands();
  assert.throws(() => kill(-pid, 0), { code: "ESRCH" });
});

test("shutdown terminates all owned commands without a broad process kill", async () => {
  const running = runCommand(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await terminateRunningCommands();
  const result = await running;
  assert.notEqual(result.code, 0);
});

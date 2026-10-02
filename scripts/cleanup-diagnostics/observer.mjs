import childProcess from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { availableParallelism, loadavg, release } from "node:os";

const active =
  process.env.CLEANUP_DIAGNOSTIC_CHILD === "1" ||
  process.argv.some((value) => value.endsWith("/server/test/util.test.ts"));
const probe = active
  ? createRequire(import.meta.url)(process.env.CLEANUP_DIAGNOSTIC_ADDON)
  : null;
const self = probe?.snapshot(process.pid);
const ledger = process.env.CLEANUP_DIAGNOSTIC_LEDGER;
const children = new WeakMap();
let sequence = 0;
const environment = () => ({
  kernel: release(),
  os: childProcess
    .execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 2000,
    })
    .trim(),
  build: childProcess
    .execFileSync("sw_vers", ["-buildVersion"], {
      encoding: "utf8",
      timeout: 2000,
    })
    .trim(),
  image: process.env.ImageVersion,
  imageOS: process.env.ImageOS,
  architecture: process.arch,
  node: process.version,
  npm: process.env.CLEANUP_DIAGNOSTIC_NPM,
  cpus: availableParallelism(),
  load: loadavg(),
});

export function diagnosticEvent(stage, fields = {}) {
  if (!active) return;
  if (++sequence > 10000) throw new Error("Diagnostic event budget exhausted");
  appendFileSync(
    ledger,
    `${JSON.stringify({ time: Date.now(), origin: self, sequence, stage, ...(stage.endsWith("_error") ? { environment: environment() } : {}), ...fields })}\n`,
  );
}

export function diagnosticChild(child) {
  return children.get(child) ?? null;
}

function identical(left, right) {
  return (
    left?.pid !== undefined &&
    left.pid === right?.pid &&
    left.uid === right.uid &&
    left.startSeconds === right.startSeconds &&
    left.startMicros === right.startMicros
  );
}

function groupSnapshot(pgid) {
  const events = readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const owned = events
    .filter(
      (event) =>
        event.stage === "child_created" &&
        event.child.pid !== undefined &&
        event.child.ppid === event.origin.pid &&
        event.child.uid === event.origin.uid,
    )
    .map((event) => event.child);
  const group = probe.group(pgid);
  const members = group.members.filter((pid) => pid > 0);
  const recorded = [];
  let unknown = 0;
  for (const pid of members) {
    const identities = owned.filter((child) => child.pid === pid);
    if (!identities.length) {
      unknown += 1;
      continue;
    }
    const current = probe.snapshot(pid);
    recorded.push({
      current,
      created: identities,
      sameIncarnation: identities.some((child) => identical(child, current)),
    });
  }
  return {
    pgid,
    bytes: group.bytes,
    errno: group.errno,
    complete: group.errno === 0 && group.bytes < 129 * 4,
    memberCount: members.length,
    unknownMembers: unknown,
    ownedGroup: owned.some((child) => child.pgid === pgid),
    recorded,
  };
}

if (active) {
  diagnosticEvent("observer_start", {
    environment: environment(),
    interventions: [
      "inherited preload and child environment marker",
      "synchronous targeted native snapshots and ledger reads/writes",
      "native signal refusal only for incomplete or unowned membership",
      "confirmed empty recorded groups retain the exact native call and error",
      "snapshots precede calls and cannot eliminate kernel TOCTOU",
    ],
  });
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const child = spawn.call(this, command, args, {
      ...options,
      env: {
        ...(options?.env ?? process.env),
        CLEANUP_DIAGNOSTIC_CHILD: "1",
      },
    });
    const created = child.pid === undefined ? null : probe.snapshot(child.pid);
    children.set(child, created);
    diagnosticEvent("child_created", { child: created ?? {} });
    child.once("spawn", () =>
      diagnosticEvent("child_spawn", {
        child: created,
        current: probe.snapshot(child.pid),
      }),
    );
    child.once("exit", (code, signal) =>
      diagnosticEvent("child_exit", {
        child: created,
        current: probe.snapshot(child.pid),
        code,
        signal,
      }),
    );
    child.once("close", (code, signal) =>
      diagnosticEvent("child_close", {
        child: created,
        current: child.pid === undefined ? null : probe.snapshot(child.pid),
        code,
        signal,
      }),
    );
    return child;
  };
  syncBuiltinESMExports();
  const kill = process.kill.bind(process);
  process.kill = (target, signal) => {
    const before = target < 0 ? groupSnapshot(-target) : null;
    diagnosticEvent("signal_before", { target, signal, group: before });
    if (
      target < 0 &&
      signal !== 0 &&
      (!before.complete ||
        !before.ownedGroup ||
        before.unknownMembers !== 0 ||
        before.recorded.some(
          (member) =>
            !member.sameIncarnation ||
            member.current.pgid !== -target ||
            member.current.uid !== self.uid,
        ))
    ) {
      diagnosticEvent("diagnostic_signal_refused", {
        target,
        signal,
        environment: environment(),
      });
      throw Object.assign(new Error("Diagnostic ownership is unconfirmed"), {
        code: "DIAGNOSTIC_OWNERSHIP_UNCONFIRMED",
      });
    }
    const started = process.hrtime.bigint();
    let result;
    try {
      result = kill(target, signal);
    } catch (error) {
      const nativeNanoseconds = String(process.hrtime.bigint() - started);
      try {
        diagnosticEvent("signal_error", {
          target,
          signal,
          code: error?.code ?? null,
          errno: error?.errno ?? null,
          syscall: error?.syscall ?? null,
          nativeNanoseconds,
          group: target < 0 ? groupSnapshot(-target) : null,
        });
      } finally {
        throw error;
      }
    }
    const nativeNanoseconds = String(process.hrtime.bigint() - started);
    try {
      diagnosticEvent("signal_result", {
        target,
        signal,
        result,
        nativeNanoseconds,
        group: target < 0 ? groupSnapshot(-target) : null,
      });
    } catch (error) {
      diagnosticEvent("observer_result_error", { code: error?.code ?? null });
    }
    return result;
  };
}

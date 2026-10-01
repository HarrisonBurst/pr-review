import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

const runningCommands = new Map<
  ChildProcessWithoutNullStreams,
  {
    signals: Set<NodeJS.Signals>;
    closed: boolean;
    close: Promise<void>;
  }
>();

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const clampText = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  code: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | ((stdin: Writable) => void);
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
}

function signalCommand(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  const owned = runningCommands.get(child);
  if (child.pid === undefined || !owned || owned.signals.has(signal)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
    owned.signals.add(signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      throw error;
  }
}

function releaseCommand(child: ChildProcessWithoutNullStreams): boolean {
  const owned = runningCommands.get(child);
  if (!owned) return true;
  if (!owned.closed) return false;
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      )
        throw error;
    }
  }
  runningCommands.delete(child);
  return true;
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    const closed = Promise.withResolvers<void>();
    runningCommands.set(child, {
      signals: new Set(),
      closed: false,
      close: closed.promise,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let terminatedAt: number | null = null;
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const current = target === "stdout" ? stdout : stderr;
      const next = current + chunk.toString("utf8");
      const truncated = next.length > maxOutputBytes;
      if (truncated) {
        if (target === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
      }
      const value = truncated
        ? `${next.slice(0, maxOutputBytes)}\n[truncated]`
        : next;
      if (target === "stdout") stdout = value;
      else stderr = value;
    };
    const clearTermination = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    const rejectCommand = (error: unknown) => {
      settled = true;
      clearTermination();
      reject(error);
    };
    const signal = (value: NodeJS.Signals) => {
      try {
        signalCommand(child, value);
        return true;
      } catch (error) {
        const reason = timedOut ? "timed out" : aborted ? "aborted" : "failed";
        const detail = error instanceof Error ? error.message : String(error);
        rejectCommand(
          new Error(
            `Command ${reason}; ${value} failed: ${detail}; process cleanup is unconfirmed`,
            { cause: error },
          ),
        );
        return false;
      }
    };
    const terminate = (reason: "timeout" | "abort" | "shutdown") => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      terminatedAt ??= Date.now();
      if (!signal("SIGTERM") || forceTimer) return;
      forceTimer = setTimeout(() => {
        if (!settled) signal("SIGKILL");
      }, 2_000);
      forceTimer.unref();
    };
    const timer = options.timeoutMs
      ? setTimeout(() => terminate("timeout"), options.timeoutMs)
      : undefined;
    const abort = () => terminate("abort");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) =>
      options.onStdout ? options.onStdout(chunk) : append("stdout", chunk),
    );
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", rejectCommand);
    child.once("close", async (code, signal) => {
      runningCommands.get(child)!.closed = true;
      closed.resolve();
      clearTermination();
      try {
        if (aborted && !settled) {
          while (!releaseCommand(child) && Date.now() - terminatedAt! < 2_000)
            await new Promise((resolve) => setTimeout(resolve, 25));
          if (!releaseCommand(child)) {
            signalCommand(child, "SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (!releaseCommand(child))
              throw new Error(
                "Owned command descendants remain; process cleanup is unconfirmed",
              );
          }
        } else releaseCommand(child);
      } catch (error) {
        rejectCommand(error);
      }
      if (settled) return;
      settled = true;
      const suffix = timedOut ? "\nTimed out" : aborted ? "\nAborted" : "";
      resolve({
        stdout,
        stderr: `${stderr}${suffix}`,
        stdoutTruncated,
        stderrTruncated,
        code: code ?? 1,
        signal,
        timedOut,
        aborted,
      });
    });
    if (typeof options.input === "function") options.input(child.stdin);
    else if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function terminateRunningCommands(): Promise<void> {
  const commands = [...runningCommands];
  for (const [child] of commands)
    if (!releaseCommand(child)) signalCommand(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const remaining = commands.filter(([child]) => !releaseCommand(child));
  for (const [child] of remaining) signalCommand(child, "SIGKILL");
  await Promise.all(commands.map(([, owned]) => owned.close));
  if (remaining.length)
    await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [child] of remaining)
    if (!releaseCommand(child))
      throw new Error("Command process cleanup is unconfirmed");
}

export function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function repositoryParts(repository: string): {
  owner: string;
  name: string;
} {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match) throw new Error("repository must be owner/name");
  return { owner: match[1], name: match[2] };
}

export function parsePullRequestUrl(value: string): {
  repository: string;
  number: number;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be a GitHub pull request URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com")
    throw new Error("url must be a github.com pull request URL");
  const parts = url.pathname.split("/").filter(Boolean);
  const number = Number(parts[3]);
  if (
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !Number.isInteger(number) ||
    number < 1
  ) {
    throw new Error("url must point to /owner/repository/pull/number");
  }
  return { repository: `${parts[0]}/${parts[1]}`, number };
}

export function prId(repository: string, number: number): string {
  return `${repository}#${number}`;
}

export function parsePrId(value: string): {
  repository: string;
  number: number;
} {
  const match = /^(.*)#([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error("invalid pull request id");
  return { repository: match[1], number: Number(match[2]) };
}

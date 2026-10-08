import path from "node:path";

import type { ActivityKind } from "../shared/contracts.js";
import type { ProgressReporter } from "./progress.js";
import { boundedLabel } from "./progress.js";

export interface DecoderStats {
  frames: number;
  malformed: number;
  overflowed: number;
}

export class JsonLineDecoder {
  readonly stats: DecoderStats = { frames: 0, malformed: 0, overflowed: 0 };
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private skipping = false;

  constructor(
    private readonly onFrame: (frame: Record<string, unknown>) => void,
    private readonly maxLineBytes = 4_000_000,
  ) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    let index: number;
    while ((index = rest.indexOf(0x0a)) !== -1) {
      this.line(rest.subarray(0, index));
      rest = rest.subarray(index + 1);
    }
    if (this.skipping || rest.length === 0) return;
    if (this.pendingBytes + rest.length > this.maxLineBytes) {
      this.drop(true);
      return;
    }
    this.pending.push(Buffer.from(rest));
    this.pendingBytes += rest.length;
  }

  end(): void {
    if (this.pendingBytes > 0) this.line(Buffer.alloc(0));
    this.skipping = false;
  }

  diagnostic(): string {
    return `${this.stats.frames} frames decoded, ${this.stats.malformed} malformed, ${this.stats.overflowed} over the ${this.maxLineBytes} byte line limit`;
  }

  private drop(skipRest: boolean): void {
    this.stats.overflowed += 1;
    this.skipping = skipRest;
    this.pending = [];
    this.pendingBytes = 0;
  }

  private line(tail: Buffer): void {
    if (this.skipping) {
      this.skipping = false;
      return;
    }
    if (this.pendingBytes + tail.length > this.maxLineBytes) {
      this.drop(false);
      return;
    }
    const bytes = this.pending.length
      ? Buffer.concat([...this.pending, tail])
      : tail;
    this.pending = [];
    this.pendingBytes = 0;
    const line = bytes.toString("utf8").replace(/\r$/, "");
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.stats.malformed += 1;
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.stats.malformed += 1;
      return;
    }
    this.stats.frames += 1;
    this.onFrame(value as Record<string, unknown>);
  }
}

export function displayPath(
  value: string,
  roots: string[],
  cwd = roots.at(-1) ?? "/",
): string {
  const resolved = path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(cwd, value);
  for (const root of roots) {
    const relative = path.relative(root, resolved);
    if (relative === "") return ".";
    if (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
      return boundedLabel(relative, 80);
  }
  return "a file outside the checkout";
}

function claudeToolLabel(
  name: string,
  input: Record<string, unknown>,
  roots: string[],
  cwd: string,
): { kind: ActivityKind; label: string } {
  const where = (key: string) =>
    typeof input[key] === "string" && input[key]
      ? displayPath(input[key] as string, roots, cwd)
      : null;
  const scoped = (verb: string) => {
    const scope = where("path");
    return `${verb}${scope ? ` in ${scope}` : ""}`;
  };
  if (name === "Read")
    return { kind: "read", label: `Reading ${where("file_path") ?? "a file"}` };
  if (name === "Grep")
    return { kind: "search", label: scoped("Searching code") };
  if (name === "Glob") return { kind: "list", label: scoped("Listing files") };
  if (name === "StructuredOutput")
    return { kind: "message", label: "Writing the structured result" };
  return { kind: "tool", label: `Using tool ${boundedLabel(name, 40)}` };
}

export class ClaudeStream {
  readonly decoder: JsonLineDecoder;
  envelope: Record<string, unknown> | null = null;
  resultFrames = 0;
  toolCalls = 0;

  finalEnvelopeDiagnostic(): string {
    const frame = this.envelope;
    const subtype =
      !frame || !Object.hasOwn(frame, "subtype")
        ? "absent"
        : frame.subtype === "success"
          ? "success"
          : frame.subtype === "error"
            ? "error"
            : "other";
    const isError =
      !frame || !Object.hasOwn(frame, "is_error")
        ? "absent"
        : frame.is_error === true
          ? "true"
          : frame.is_error === false
            ? "false"
            : "other";
    return `Claude result frames ${this.resultFrames}, final subtype ${subtype}, final is_error ${isError}, final structured_output ${frame && Object.hasOwn(frame, "structured_output") ? "present" : "absent"}`;
  }

  constructor(
    private readonly report: ProgressReporter | undefined,
    private readonly roots: string[],
    private readonly cwd = roots.at(-1) ?? "/",
  ) {
    this.decoder = new JsonLineDecoder((frame) => this.frame(frame));
  }

  private frame(frame: Record<string, unknown>): void {
    if (frame.type === "result") {
      this.resultFrames++;
      this.envelope = frame;
      return;
    }
    if (frame.type === "system" && frame.subtype === "init") {
      const model =
        typeof frame.model === "string" ? boundedLabel(frame.model, 40) : null;
      this.emit(
        "message",
        `Claude session started${model ? ` with ${model}` : ""}`,
      );
      return;
    }
    if (frame.type !== "assistant") return;
    const message = frame.message;
    if (!message || typeof message !== "object") return;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (record.type === "text") {
        this.emit("message", "Claude is writing");
        continue;
      }
      if (record.type !== "tool_use" || typeof record.name !== "string")
        continue;
      this.toolCalls += 1;
      const input =
        record.input && typeof record.input === "object"
          ? (record.input as Record<string, unknown>)
          : {};
      const { kind, label } = claudeToolLabel(
        record.name,
        input,
        this.roots,
        this.cwd,
      );
      this.emit(kind, label);
    }
  }

  private emit(kind: ActivityKind, label: string): void {
    this.report?.activity("claude", kind, label);
  }
}

export class PiStream {
  readonly decoder: JsonLineDecoder;
  lastMessage: string | null = null;
  completed = false;
  successful = false;

  constructor(report?: ProgressReporter) {
    this.decoder = new JsonLineDecoder((frame) => {
      if (frame.type === "agent_start") {
        this.completed = false;
        this.successful = false;
        this.lastMessage = null;
      }
      if (frame.type === "agent_end") this.completed = true;
      if (frame.type === "tool_execution_start")
        report?.activity("app", "tool", "Pi is using a configured tool");
      if (
        frame.type !== "message_end" ||
        !frame.message ||
        typeof frame.message !== "object"
      )
        return;
      const message = frame.message as Record<string, unknown>;
      if (message.role !== "assistant") return;
      this.successful = message.stopReason === "stop";
      this.lastMessage = Array.isArray(message.content)
        ? message.content
            .filter(
              (part) => part?.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("")
        : null;
    });
  }
}

export class CodexStream {
  readonly decoder: JsonLineDecoder;
  lastMessage: string | null = null;
  failure: string | null = null;
  completed = false;
  commands = 0;

  constructor(private readonly report: ProgressReporter | undefined) {
    this.decoder = new JsonLineDecoder((frame) => this.frame(frame), 1_000_000);
  }

  incomplete(): string | null {
    const { overflowed, malformed } = this.decoder.stats;
    if (overflowed || malformed)
      return `Codex stream had dropped or malformed output (${this.decoder.diagnostic()})`;
    if (!this.completed)
      return `Codex turn did not complete (${this.decoder.diagnostic()})`;
    if (!this.lastMessage?.trim())
      return `Codex produced no final message (${this.decoder.diagnostic()})`;
    return null;
  }

  private frame(frame: Record<string, unknown>): void {
    const type = frame.type;
    if (type === "turn.started") {
      this.completed = false;
      this.lastMessage = null;
      this.emit("message", "Codex session started");
      return;
    }
    if (type === "turn.completed") {
      this.completed = true;
      return;
    }
    if (type === "error" || type === "turn.failed") {
      const error =
        typeof frame.message === "string"
          ? frame.message
          : frame.error && typeof frame.error === "object"
            ? (frame.error as Record<string, unknown>).message
            : null;
      this.failure = boundedLabel(
        typeof error === "string" && error ? error : "Codex reported an error",
        500,
      );
      return;
    }
    if (type !== "item.started" && type !== "item.completed") return;
    const item = frame.item;
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const itemType = record.type;
    if (itemType === "agent_message") {
      if (type === "item.completed" && typeof record.text === "string")
        this.lastMessage = record.text;
      this.emit("message", "Codex wrote a message");
      return;
    }
    if (itemType === "command_execution") {
      if (type === "item.started") {
        this.commands += 1;
        this.emit("command", `Codex running command ${this.commands}`);
      } else if (record.status === "failed" || record.exit_code !== 0)
        this.emit("command", "Codex command finished with a non-zero exit");
      return;
    }
    if (itemType === "reasoning") {
      if (type === "item.started") this.emit("message", "Codex is reasoning");
      return;
    }
    if (typeof itemType === "string" && type === "item.started")
      this.emit(
        "tool",
        `Codex ${boundedLabel(itemType.replace(/_/g, " "), 40)}`,
      );
  }

  private emit(kind: ActivityKind, label: string): void {
    this.report?.activity("codex", kind, label);
  }
}

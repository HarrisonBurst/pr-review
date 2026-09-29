import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunActivity } from "../../shared/contracts.js";
import type { ProgressReporter } from "../progress.js";
import {
  ClaudeStream,
  CodexStream,
  JsonLineDecoder,
  displayPath,
} from "../stream.js";

function recorder(): ProgressReporter & {
  labels: string[];
  entries: RunActivity[];
} {
  const entries: RunActivity[] = [];
  return {
    entries,
    get labels() {
      return entries.map((entry) => entry.label);
    },
    phase() {},
    activity(source, kind, label) {
      entries.push({ at: "", source, kind, label });
    },
  };
}

const line = (frame: unknown) => `${JSON.stringify(frame)}\n`;

test("decoder reassembles fragmented and multibyte lines and ignores malformed ones", () => {
  const frames: Record<string, unknown>[] = [];
  const decoder = new JsonLineDecoder((frame) => frames.push(frame));
  const text = `${line({ type: "a", text: "héllo 🙂 日本" })}not json\r\n\n${line({ type: "b" })}[1,2]\n"str"\n${JSON.stringify({ type: "tail" })}`;
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length; offset += 3)
    decoder.push(bytes.subarray(offset, Math.min(offset + 3, bytes.length)));
  decoder.end();
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["a", "b", "tail"],
  );
  assert.equal(frames[0]!.text, "héllo 🙂 日本");
  assert.deepEqual(decoder.stats, { frames: 3, malformed: 3, overflowed: 0 });
});

test("decoder drops over-long lines explicitly instead of buffering them", () => {
  const frames: Record<string, unknown>[] = [];
  const decoder = new JsonLineDecoder((frame) => frames.push(frame), 64);
  decoder.push(Buffer.from(line({ type: "small" })));
  decoder.push(Buffer.from(`{"type":"huge","pad":"${"x".repeat(200)}`));
  decoder.push(Buffer.from(`${"y".repeat(50)}"}\n`));
  decoder.push(Buffer.from(line({ type: "after" })));
  decoder.end();
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["small", "after"],
  );
  assert.equal(decoder.stats.overflowed, 1);
  assert.match(decoder.diagnostic(), /1 over the 64 byte line limit/);
});

test("decoder keeps memory bounded across a high-volume stream", () => {
  let count = 0;
  const decoder = new JsonLineDecoder(() => {
    count += 1;
  });
  const chunk = Buffer.from(line({ type: "x", n: 1 }).repeat(1000));
  for (let i = 0; i < 50; i += 1) decoder.push(chunk);
  decoder.end();
  assert.equal(count, 50_000);
});

test("Claude frames become bounded tool activity without file contents or model text", () => {
  const report = recorder();
  const stream = new ClaudeStream(report, ["/runs/r1/checkout", "/runs/r1"]);
  const push = (frame: unknown) =>
    stream.decoder.push(Buffer.from(line(frame)));
  push({ type: "system", subtype: "init", model: "claude-opus-5" });
  push({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/runs/r1/checkout/src/app.ts" },
        },
      ],
    },
  });
  push({
    type: "user",
    message: {
      content: [{ type: "tool_result", content: "SECRET FILE CONTENTS" }],
    },
  });
  push({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Grep",
          input: { pattern: "todo\nline\u0007", path: "/runs/r1/checkout/src" },
        },
        { type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } },
        { type: "tool_use", name: "Read", input: { file_path: "/etc/passwd" } },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/runs/r1/skill.md" },
        },
        { type: "text", text: "PRIVATE REASONING" },
        {
          type: "tool_use",
          name: "StructuredOutput",
          input: { verdict: "APPROVE" },
        },
        { type: "tool_use", name: "WebFetch\nEvil", input: {} },
      ],
    },
  });
  push({ type: "rate_limit_event", rate_limit_info: {} });
  push({ type: "result", subtype: "success", structured_output: { ok: true } });
  stream.decoder.end();
  assert.deepEqual(report.labels, [
    "Claude session started with claude-opus-5",
    "Reading src/app.ts",
    "Searching code in src",
    "Listing files",
    "Reading a file outside the checkout",
    "Reading skill.md",
    "Claude is writing",
    "Writing the structured result",
    "Using tool WebFetch Evil",
  ]);
  const joined = JSON.stringify(report.entries);
  assert.equal(joined.includes("SECRET"), false);
  assert.equal(joined.includes("PRIVATE REASONING"), false);
  assert.equal(joined.includes("/runs/r1"), false);
  assert.deepEqual(
    report.entries.map((entry) => entry.kind),
    [
      "message",
      "read",
      "search",
      "list",
      "read",
      "read",
      "message",
      "message",
      "tool",
    ],
  );
  assert.equal(stream.toolCalls, 7);
  assert.deepEqual(stream.envelope?.structured_output, { ok: true });
});

test("Claude stream keeps only the last result frame and ignores unknown frames", () => {
  const stream = new ClaudeStream(undefined, []);
  stream.decoder.push(
    Buffer.from(
      line({ type: "mystery", instructions: "phase: done" }) +
        line({ type: "result", result: "first" }) +
        line({ type: "result", result: "second", is_error: true }),
    ),
  );
  stream.decoder.end();
  assert.equal(stream.envelope?.result, "second");
  assert.equal(stream.decoder.stats.frames, 3);
});

test("Codex frames report commands and take the final agent message as the result", () => {
  const report = recorder();
  const stream = new CodexStream(report);
  const push = (frame: unknown) =>
    stream.decoder.push(Buffer.from(line(frame)));
  push({ type: "thread.started", thread_id: "t" });
  push({ type: "turn.started" });
  push({
    type: "item.started",
    item: { id: "0", type: "reasoning", text: "HIDDEN" },
  });
  push({
    type: "item.started",
    item: {
      id: "1",
      type: "command_execution",
      command:
        '/bin/zsh -lc "git -C checkout diff\n  base...head | head -c 100000"',
      status: "in_progress",
    },
  });
  push({
    type: "item.completed",
    item: {
      id: "1",
      type: "command_execution",
      command: "git",
      aggregated_output: "SECRET OUTPUT",
      exit_code: 0,
      status: "completed",
    },
  });
  push({
    type: "item.started",
    item: {
      id: "2",
      type: "command_execution",
      command: "false",
      status: "in_progress",
    },
  });
  push({
    type: "item.completed",
    item: {
      id: "2",
      type: "command_execution",
      command: "false",
      exit_code: 1,
      status: "failed",
    },
  });
  push({
    type: "item.started",
    item: { id: "3", type: "web_search", query: "x" },
  });
  push({
    type: "item.completed",
    item: { id: "4", type: "agent_message", text: "Interim" },
  });
  push({
    type: "item.completed",
    item: { id: "5", type: "agent_message", text: "Final findings" },
  });
  push({ type: "turn.completed", usage: {} });
  stream.decoder.end();
  assert.deepEqual(report.labels, [
    "Codex session started",
    "Codex is reasoning",
    "Codex running command 1",
    "Codex running command 2",
    "Codex command finished with a non-zero exit",
    "Codex web search",
    "Codex wrote a message",
    "Codex wrote a message",
  ]);
  const joined = JSON.stringify(report.entries);
  for (const leak of ["SECRET", "HIDDEN", "git -C", "head -c", "false"])
    assert.equal(joined.includes(leak), false, `activity leaked ${leak}`);
  assert.equal(stream.lastMessage, "Final findings");
  assert.equal(stream.incomplete(), null);
  assert.equal(stream.commands, 2);
  assert.equal(stream.failure, null);
});

test("Codex error frames are surfaced as a bounded failure", () => {
  const stream = new CodexStream(undefined);
  stream.decoder.push(
    Buffer.from(
      line({ type: "turn.started" }) +
        line({ type: "error", message: `boom ${"x".repeat(1000)}` }),
    ),
  );
  assert.equal(stream.failure?.startsWith("boom "), true);
  assert.equal(stream.failure?.length, 500);
  stream.decoder.push(
    Buffer.from(line({ type: "turn.failed", error: { message: "later" } })),
  );
  stream.decoder.end();
  assert.equal(stream.failure, "later");
  assert.equal(stream.lastMessage, null);
});

test("displayPath keeps paths relative to the owned roots", () => {
  const roots = ["/data/review-runs/r/checkout", "/data/review-runs/r"];
  assert.equal(
    displayPath("/data/review-runs/r/checkout/a/b.ts", roots),
    "a/b.ts",
  );
  assert.equal(displayPath("/data/review-runs/r/checkout", roots), ".");
  assert.equal(displayPath("/data/review-runs/r/notes.md", roots), "notes.md");
  assert.equal(
    displayPath("/data/review-runs/rx/x.ts", roots),
    "a file outside the checkout",
  );
  assert.equal(displayPath("relative/x.ts", roots), "relative/x.ts");
  assert.equal(displayPath("checkout/src/x.ts", roots), "src/x.ts");
  assert.equal(
    displayPath("checkout/../../x.ts", roots),
    "a file outside the checkout",
  );
  assert.equal(displayPath("../r/checkout/y.ts", roots), "y.ts");
  assert.equal(displayPath("..", roots), "a file outside the checkout");
  assert.equal(
    displayPath("/data/review-runs/r/checkout/..foo/z.ts", roots),
    "..foo/z.ts",
  );
  assert.equal(
    displayPath("/data/review-runs/r-other/x.ts", roots),
    "a file outside the checkout",
  );
  assert.equal(displayPath(`checkout/${"n".repeat(200)}.ts`, roots).length, 80);
});

test("decoder applies its byte limit to complete lines, chunk fragments, and multibyte text", () => {
  const frames: Record<string, unknown>[] = [];
  const decoder = new JsonLineDecoder((frame) => frames.push(frame), 64);
  decoder.push(
    Buffer.from(
      `${JSON.stringify({ type: "result", text: "x".repeat(100) })}\n`,
    ),
  );
  assert.equal(frames.length, 0);
  assert.equal(decoder.stats.overflowed, 1);
  const multibyte = JSON.stringify({ type: "m", text: "日本語".repeat(6) });
  assert.ok(multibyte.length < 64 && Buffer.byteLength(multibyte) > 64);
  const bytes = Buffer.from(`${multibyte}\n`);
  for (let offset = 0; offset < bytes.length; offset += 5)
    decoder.push(bytes.subarray(offset, Math.min(offset + 5, bytes.length)));
  assert.equal(frames.length, 0);
  assert.equal(decoder.stats.overflowed, 2);
  decoder.push(Buffer.from(`${JSON.stringify({ type: "ok" })}\n`));
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["ok"],
  );
  const unterminated = `{"type":"tail","pad":"${"y".repeat(100)}"}`;
  for (const char of unterminated) decoder.push(Buffer.from(char));
  decoder.end();
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["ok"],
  );
  assert.deepEqual(decoder.stats, { frames: 1, malformed: 0, overflowed: 3 });
});

test("decoder skips exactly the dropped line and keeps the tail after it", () => {
  const frames: Record<string, unknown>[] = [];
  const decoder = new JsonLineDecoder((frame) => frames.push(frame), 32);
  decoder.push(Buffer.from(`{"type":"big","pad":"${"z".repeat(40)}`));
  decoder.push(Buffer.from(`${"z".repeat(40)}"}\n{"type":"a"}\n{"type":"b"`));
  decoder.push(Buffer.from(`}\n`));
  decoder.push(Buffer.from(`{"type":"c"}`));
  decoder.end();
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["a", "b", "c"],
  );
  assert.deepEqual(decoder.stats, { frames: 3, malformed: 0, overflowed: 1 });
});

test("Codex completion requires a completed turn, intact output, and a final message", () => {
  const push = (stream: CodexStream, frame: unknown) =>
    stream.decoder.push(Buffer.from(line(frame)));
  const message = (text: string) => ({
    type: "item.completed",
    item: { id: "m", type: "agent_message", text },
  });
  const noTurnEnd = new CodexStream(undefined);
  push(noTurnEnd, { type: "turn.started" });
  push(noTurnEnd, message("Interim"));
  noTurnEnd.decoder.end();
  assert.match(noTurnEnd.incomplete()!, /Codex turn did not complete/);

  const dropped = new CodexStream(undefined);
  push(dropped, { type: "turn.started" });
  push(dropped, message("Interim"));
  dropped.decoder.push(
    Buffer.from(`${JSON.stringify(message("x".repeat(1_000_001)))}\n`),
  );
  push(dropped, { type: "turn.completed" });
  dropped.decoder.end();
  assert.match(dropped.incomplete()!, /dropped or malformed output/);
  assert.match(dropped.incomplete()!, /1 over the 1000000 byte line limit/);

  const malformed = new CodexStream(undefined);
  push(malformed, { type: "turn.started" });
  push(malformed, message("Interim"));
  malformed.decoder.push(Buffer.from('{"type":"item.completed","item":{"ty\n'));
  push(malformed, { type: "turn.completed" });
  malformed.decoder.end();
  assert.match(malformed.incomplete()!, /dropped or malformed output/);

  const truncatedEnd = new CodexStream(undefined);
  push(truncatedEnd, { type: "turn.started" });
  push(truncatedEnd, message("Interim"));
  truncatedEnd.decoder.push(Buffer.from('{"type":"turn.completed"'));
  truncatedEnd.decoder.end();
  assert.match(truncatedEnd.incomplete()!, /dropped or malformed output/);

  const empty = new CodexStream(undefined);
  push(empty, { type: "turn.started" });
  push(empty, message("   "));
  push(empty, { type: "turn.completed" });
  empty.decoder.end();
  assert.match(empty.incomplete()!, /produced no final message/);

  const good = new CodexStream(undefined);
  push(good, { type: "thread.started" });
  push(good, { type: "turn.started" });
  push(good, { type: "item.started", item: { id: "r", type: "reasoning" } });
  push(good, message("Interim"));
  push(good, { type: "future.event", data: "ignored" });
  push(good, message("Final"));
  push(good, { type: "turn.completed", usage: {} });
  good.decoder.end();
  assert.equal(good.incomplete(), null);
  assert.equal(good.lastMessage, "Final");
});

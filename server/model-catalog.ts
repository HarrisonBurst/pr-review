import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { HarnessId } from "../shared/contracts.js";
import { runCommand } from "./util.js";

export async function nativeModelCatalog(
  harness: Exclude<HarnessId, "pi">,
  env: NodeJS.ProcessEnv,
): Promise<{ model: unknown; label: unknown }[]> {
  const home = await mkdtemp(path.join(tmpdir(), "pr-review-model-catalog-"));
  const controller = new AbortController();
  let stdin: Writable;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let bytes = 0;
  let failure = false;
  let complete = false;
  let requestId = 1;
  const cursors = new Set<string>();
  const models: { model: unknown; label: unknown }[] = [];
  const send = (message: unknown) =>
    stdin.write(`${JSON.stringify(message)}\n`);
  const fail = () => {
    failure = true;
    controller.abort();
  };
  function receive(message: any) {
    if (complete) return;
    let entries: unknown[];
    if (harness === "claude") {
      if (message.type !== "control_response") return;
      if (
        message.response?.request_id !== "catalog" ||
        message.response.subtype !== "success"
      )
        throw new Error();
      entries = message.response.response.models;
      complete = true;
    } else {
      if (message.id === undefined) return;
      if (message.id !== requestId || message.error || !message.result)
        throw new Error();
      if (requestId === 1) {
        send({ method: "initialized", params: {} });
        send({
          id: ++requestId,
          method: "model/list",
          params: { limit: 100, includeHidden: false },
        });
        return;
      }
      entries = message.result.data;
      const cursor = message.result.nextCursor;
      if (cursor === null) complete = true;
      else {
        if (
          typeof cursor !== "string" ||
          !cursor ||
          cursors.has(cursor) ||
          cursors.size >= 20
        )
          throw new Error();
        cursors.add(cursor);
        send({
          id: ++requestId,
          method: "model/list",
          params: { limit: 100, includeHidden: false, cursor },
        });
      }
    }
    if (!Array.isArray(entries) || entries.length + models.length > 2000)
      throw new Error();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new Error();
      const value = entry as Record<string, unknown>;
      const model = harness === "claude" ? value.value : value.model;
      if (typeof model !== "string") throw new Error();
      models.push({ model, label: value.displayName });
    }
    if (complete) stdin.end();
  }
  try {
    const result = await runCommand(
      harness,
      harness === "claude"
        ? [
            "--bare",
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--tools",
            "",
            "--disable-slash-commands",
            "--no-session-persistence",
          ]
        : [
            "app-server",
            "-c",
            "analytics.enabled=false",
            "-c",
            "feedback.enabled=false",
          ],
      {
        cwd: home,
        env: {
          PATH: env.PATH,
          HOME: home,
          TMPDIR: home,
          CODEX_HOME: home,
          CLAUDE_CONFIG_DIR: home,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
        timeoutMs: 15_000,
        maxOutputBytes: 100_000,
        signal: controller.signal,
        input: (stream) => {
          stdin = stream;
          stdin.on("error", fail);
          send(
            harness === "claude"
              ? {
                  type: "control_request",
                  request_id: "catalog",
                  request: { subtype: "initialize" },
                }
              : {
                  id: requestId,
                  method: "initialize",
                  params: {
                    clientInfo: {
                      name: "pr_review_model_metadata",
                      version: "1",
                    },
                  },
                },
          );
        },
        onStdout: (chunk) => {
          bytes += chunk.length;
          if (bytes > 5_000_000) return fail();
          buffer += decoder.write(chunk);
          try {
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (line.trim()) receive(JSON.parse(line));
            }
          } catch {
            fail();
          }
        },
      },
    );
    if (
      failure ||
      !complete ||
      buffer.trim() ||
      result.code !== 0 ||
      result.timedOut ||
      result.aborted
    )
      throw new Error("Native model metadata unavailable");
    return models;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

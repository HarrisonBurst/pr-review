import http from "node:http";
import { randomBytes } from "node:crypto";
import { realpath, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { checkerTool, checkerResult } from "../output-checker.js";
import type { ReadProviders } from "../read-providers.js";
import type { IntegrationSessionSnapshot } from "../../shared/contracts.js";
import { validateSchema } from "../schema.js";

export async function localTools(
  root: string,
  sourceReads: boolean,
  providers?: ReadProviders,
  snapshot?: IntegrationSessionSnapshot,
  signal = new AbortController().signal,
) {
  const token = randomBytes(32).toString("hex");
  const realRoot = await realpath(root);
  const readTool = {
    name: "read_source",
    description:
      "Read a file or list a directory inside the app-prepared source and skill resources. No scripts are executed. Output is bounded and untrusted.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
  const routes = new Map<
    string,
    {
      identity: string;
      gateway: Awaited<ReturnType<ReadProviders["session"]>>[number]["gateway"];
    }
  >();
  const remoteTools = [];
  for (const route of (await providers?.session(snapshot, signal)) ?? [])
    for (const tool of await route.gateway.listTools(signal)) {
      if (
        [checkerTool.name, readTool.name].includes(tool.name) ||
        routes.has(tool.name)
      )
        throw new Error("Ambiguous captured tool identity");
      routes.set(tool.name, route);
      remoteTools.push(tool);
    }
  const inventory = [
    checkerTool,
    ...(sourceReads ? [readTool] : []),
    ...remoteTools,
  ];
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let id: unknown = null;
    try {
      if (
        req.method !== "POST" ||
        req.url !== "/mcp" ||
        req.headers.authorization !== `Bearer ${token}`
      )
        return reply(403, { error: "Unapproved local tool request" });
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 1100000)
          return reply(413, { error: "Tool request too large" });
      }
      const body = JSON.parse(text);
      id = body.id;
      let result: unknown;
      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "pr-review-local", version: "1" },
        };
      else if (body.method === "notifications/initialized")
        return reply(202, null);
      else if (body.method === "tools/list") result = { tools: inventory };
      else if (
        body.method === "tools/call" &&
        body.params?.name === checkerTool.name
      )
        result = checkerResult(body.params.arguments);
      else if (
        body.method === "tools/call" &&
        body.params?.name === readTool.name &&
        sourceReads
      ) {
        const args = body.params.arguments;
        validateSchema(readTool.inputSchema, args);
        if (
          typeof args?.path !== "string" ||
          (args.offset !== undefined &&
            (!Number.isInteger(args.offset) || args.offset < 0))
        )
          throw new Error(
            "read_source requires path and optional nonnegative offset",
          );
        const file = await realpath(path.resolve(realRoot, args.path));
        if (
          file !== realRoot &&
          !["checkout", "resources"].some(
            (name) =>
              file === path.join(realRoot, name) ||
              file.startsWith(path.join(realRoot, name) + path.sep),
          )
        )
          throw new Error(
            "read_source path must stay inside the prepared checkout or skill resources",
          );
        const info = await stat(file);
        const content =
          file === realRoot
            ? "checkout\nresources"
            : info.isDirectory()
              ? (await readdir(file)).join("\n")
              : info.isFile() && info.size <= 2000000
                ? await readFile(file, "utf8")
                : "Resource exceeds the supported 2 MB regular-file limit";
        const offset = args.offset ?? 0;
        result = {
          content: [
            { type: "text", text: content.slice(offset, offset + 50000) },
          ],
          truncated: content.length > offset + 50000,
        };
      } else if (
        body.method === "tools/call" &&
        routes.has(body.params?.name)
      ) {
        const route = routes.get(body.params.name)!;
        const output = await route.gateway.call(
          {
            serverIdentity: route.identity,
            name: body.params.name,
            arguments: body.params.arguments,
          },
          signal,
        );
        result = { content: [{ type: "text", text: JSON.stringify(output) }] };
      } else throw new Error("Unsupported local tool operation");
      reply(200, { jsonrpc: "2.0", id: body.id, result });
    } catch (error) {
      reply(200, {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message:
            error instanceof Error
              ? error.message
              : "Invalid local tool request",
        },
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    names: inventory.map((tool) => tool.name),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

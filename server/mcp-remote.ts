import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type InitializeResult,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import type { GuardedFetch } from "./guarded-fetch.js";
import { fingerprintToolSchema } from "./integrations.js";
import { canonicalJson, validateSchema } from "./schema.js";

export type McpInitialization = Pick<
  InitializeResult,
  "protocolVersion" | "serverInfo" | "capabilities"
>;

export async function remoteMcp<T>(
  endpoint: string,
  fetch: GuardedFetch,
  token: () => Promise<string>,
  action: (session: {
    tools: Tool[];
    initialization: McpInitialization;
    pages: number;
    call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  }) => Promise<T>,
  signal?: AbortSignal,
  retained?: { initialization: McpInitialization; tool: Tool },
): Promise<T> {
  retained = retained ? structuredClone(retained) : undefined;
  const client = new Client(
    { name: "pr-review-read-broker", version: "1" },
    {
      capabilities: {},
      supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
      versionNegotiation: { mode: "legacy" },
      inputRequired: { autoFulfill: false },
      listMaxPages: 10,
      enforceStrictCapabilities: true,
    },
  );
  const controller = new AbortController();
  const bounded = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(15000),
    ...(signal ? [signal] : []),
  ]);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: { token },
    onInsufficientScope: "throw",
    maxStepUpRetries: 0,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (url, init = {}) => {
      if (String(url) !== endpoint) throw new Error("MCP destination changed");
      return fetch(url, {
        ...init,
        signal: AbortSignal.any([
          bounded,
          ...(init.signal ? [init.signal] : []),
        ]),
      });
    },
  });
  try {
    await client.connect(transport, { signal: bounded, timeout: 15000 });
    const receive = transport.onmessage!;
    transport.onmessage = (message) => {
      if ("method" in message) {
        controller.abort(
          new Error(
            "Unsolicited MCP request or inventory change; reload explicitly",
          ),
        );
        void client.close();
      } else receive(message);
    };
    if (!["2025-11-25", "2025-06-18"].includes(transport.protocolVersion ?? ""))
      throw new Error("Unsupported MCP protocol version");
    const serverInfo = client.getServerVersion();
    const capabilities = client.getServerCapabilities();
    if (!serverInfo || !capabilities)
      throw new Error("MCP initialization metadata unavailable");
    const initialization = {
      protocolVersion: transport.protocolVersion!,
      serverInfo,
      capabilities,
    };
    if (
      retained &&
      canonicalJson(initialization) !== canonicalJson(retained.initialization)
    )
      throw new Error("Retained MCP initialization binding changed");
    const tools: Tool[] = retained ? [retained.tool] : [];
    let called = false;
    let pages = 0;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; !retained; page++) {
      if (page >= 10) throw new Error("MCP inventory exceeds ten pages");
      const result = await client.request(
        {
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        },
        { signal: bounded, timeout: 15000 },
      );
      pages++;
      tools.push(...result.tools);
      if (
        tools.length > 100 ||
        Buffer.byteLength(JSON.stringify(tools)) > 200000
      )
        throw new Error("MCP inventory exceeds bounds");
      if (result.nextCursor === undefined) break;
      if (
        !result.nextCursor ||
        result.nextCursor.length > 1024 ||
        cursors.has(result.nextCursor)
      )
        throw new Error("MCP inventory cursor cycle or invalid cursor");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    if (
      tools.length > 100 ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length ||
      tools.some((tool) => !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) ||
      Buffer.byteLength(JSON.stringify(tools)) > 200000
    )
      throw new Error(
        "MCP inventory exceeds supported bounds or contains ambiguous identities",
      );
    bounded.throwIfAborted();
    return await action({
      tools,
      initialization,
      pages,
      async call(name, args) {
        if (!tools.some((tool) => tool.name === name))
          throw new Error("Unknown MCP tool");
        if (retained) {
          if (called) throw new Error("Retained MCP call already attempted");
          called = true;
          validateSchema(retained.tool.inputSchema, args);
        }
        bounded.throwIfAborted();
        const result = await client.request(
          { method: "tools/call", params: { name, arguments: args } },
          { signal: bounded, timeout: 15000 },
        );
        bounded.throwIfAborted();
        if (
          result.isError ||
          Buffer.byteLength(JSON.stringify(result)) > 200000
        )
          throw new Error("MCP read failed or exceeded supported bounds");
        return result;
      },
    });
  } catch {
    throw new Error(
      "MCP session failed or changed; no tool call was automatically retried. Explicitly reload inventory or reconnect.",
    );
  } finally {
    controller.abort();
    await client.close();
  }
}

export function inventoryIdentity(tools: Tool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    schemaFingerprint: fingerprintToolSchema(tool.inputSchema),
  }));
}

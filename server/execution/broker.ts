import { ReadOnlyMcpGateway, fingerprintToolSchema } from "../integrations.js";
import { checkerTool, checkerResult } from "../output-checker.js";
import { slackReadTools } from "../slack-reads.js";
import { linearReadTools } from "../linear-reads.js";
import { axiomReadTools } from "../axiom-reads.js";
import { notionReadTools } from "../notion-reads.js";
import type { ModelCredentials } from "./auth.js";
import type { WorkflowConfig } from "./config.js";
import type { IntegrationConnection } from "../../shared/contracts.js";
import {
  readProviderDefinitions,
  type ReadProviders,
} from "../read-providers.js";

export const snapshotSchema = {
  type: "object",
  additionalProperties: false,
  properties: { method: { enum: ["get", "get_files"] } },
  required: ["method"],
};

const modelEndpoints = {
  claude: "https://api.anthropic.com/v1/messages?beta=true",
  codex: "https://chatgpt.com/backend-api/codex/responses",
  pi: "https://chatgpt.com/backend-api/codex/responses",
};
const brokerDigest = fingerprintToolSchema({
  version: 2,
  modelEndpoints,
  snapshotSchema,
  readProviderDefinitions,
  slackReadTools,
  linearReadTools,
  axiomReadTools,
  notionReadTools,
});

export const brokerDigestV2 = fingerprintToolSchema({
  version: 3,
  brokerDigest,
  checkerTool,
});

export type FixtureInference = (
  provider: "claude" | "codex" | "pi",
  body: any,
) => Promise<{ status: number; body: unknown; contentType: string }>;

export interface BrokerRequest {
  id: number;
  run: string;
  capability: string;
  route: string;
  body: any;
  headers?: Record<string, string>;
}

export class WorkflowBroker {
  private readonly gateway: ReadOnlyMcpGateway;
  private readonly controller = new AbortController();
  private readonly budget = { claude: 40, codex: 40, pi: 40, mcp: 100 };
  private active = 0;
  private readonly secrets: string[];
  readonly evidence = {
    snapshotReads: 0,
    claudeResponses: 0,
    codexResponses: 0,
    piResponses: 0,
    providerReads: 0,
  };

  constructor(
    private readonly run: string,
    private readonly capability: string,
    private readonly config: WorkflowConfig,
    private readonly credentials: ModelCredentials,
    metadata: unknown,
    diff: string,
    private readonly providers: Awaited<
      ReturnType<ReadProviders["session"]>
    > = [],
    private readonly fixtureInference?: FixtureInference,
  ) {
    this.secrets = [
      credentials.claude.claudeAiOauth.accessToken,
      credentials.codex.tokens.access_token,
      credentials.codex.tokens.id_token,
      credentials.pi?.access ?? "",
    ].filter(Boolean);
    const connection: IntegrationConnection = {
      definition: {
        id: "snapshot",
        provider: "github",
        label: "Immutable PR snapshot",
        transport: "host-broker",
        authReuse: "none",
        identity: `snapshot:${run}`,
        supported: true,
        compatibilityMessage: null,
        tools: [
          {
            id: "snapshot",
            label: "Recorded PR data",
            operation: "read",
            toolNames: ["pull_request_read"],
            schemaFingerprint: fingerprintToolSchema(snapshotSchema),
            allowedMethods: ["get", "get_files"],
            argumentPolicy: "bounded",
          },
        ],
      },
      config: {
        id: "snapshot",
        enabled: true,
        allowedTools: ["snapshot"],
        source: "inherited",
        endpoint: null,
        serverName: null,
        authRef: null,
        configPath: null,
      },
      status: "ready",
      effective: "restricted",
      message: "Only this run's immutable PR data is available",
      tools: [
        {
          id: "snapshot",
          label: "Recorded PR data",
          state: "allowed",
          reason: "Run-scoped immutable input",
        },
      ],
    };
    this.gateway = new ReadOnlyMcpGateway(connection, {
      listTools: async () => [
        {
          name: "pull_request_read",
          description:
            "Read only this run's immutable recorded PR metadata or diff",
          inputSchema: snapshotSchema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
      callTool: async (_name, args) => {
        this.evidence.snapshotReads++;
        return args.method === "get"
          ? metadata
          : { diff: diff.slice(0, 150000), truncated: diff.length > 150000 };
      },
    });
  }

  close(): void {
    this.controller.abort(new Error("Execution capability revoked"));
  }

  async request(
    request: BrokerRequest,
  ): Promise<{ status: number; body: unknown; contentType: string }> {
    const json = (status: number, body: unknown) => ({
      status,
      body,
      contentType: "application/json",
    });
    if (
      this.controller.signal.aborted ||
      request.run !== this.run ||
      request.capability !== this.capability
    )
      return json(403, { error: "Execution capability rejected" });
    if (++this.active > 8) {
      this.active--;
      return json(429, { error: "Broker concurrency exceeded" });
    }
    try {
      if (request.route === "mcp") {
        if (
          this.budget.mcp-- <= 0 ||
          JSON.stringify(request.body).length > 1100000
        )
          throw new Error();
        const body = request.body;
        const gateways = [
          { identity: `snapshot:${this.run}`, gateway: this.gateway },
          ...this.providers,
        ];
        const tools = async () => {
          const listed = await Promise.all(
            gateways.map(async (entry) => ({
              ...entry,
              tools: await entry.gateway.listTools(this.controller.signal),
            })),
          );
          const names = listed.flatMap((entry) =>
            entry.tools.map((tool) => tool.name),
          );
          if (new Set(names).size !== names.length) throw new Error();
          return listed;
        };
        if (
          !body ||
          body.jsonrpc !== "2.0" ||
          Object.keys(body).some(
            (key) => !["jsonrpc", "id", "method", "params"].includes(key),
          )
        )
          throw new Error();
        let result: unknown;
        if (body.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "pr-review-snapshot", version: "1" },
          };
        else if (body.method === "notifications/initialized")
          return json(202, null);
        else if (body.method === "tools/list")
          result = {
            tools: [
              ...(await tools()).flatMap((entry) => entry.tools),
              checkerTool,
            ],
          };
        else if (body.method === "tools/call") {
          if (
            !body.params ||
            Object.keys(body.params).some(
              (key) =>
                ![
                  "name",
                  "arguments",
                  ...(body.params.name === checkerTool.name ? ["_meta"] : []),
                ].includes(key),
            )
          )
            throw new Error();
          if (body.params.name === checkerTool.name)
            return json(200, {
              jsonrpc: "2.0",
              id: body.id,
              result: checkerResult(body.params.arguments),
            });
          const selected = (await tools()).find((entry) =>
            entry.tools.some((tool) => tool.name === body.params.name),
          );
          if (!selected) throw new Error();
          const output = await selected.gateway.call(
            {
              serverIdentity: selected.identity,
              name: body.params?.name,
              arguments: body.params?.arguments,
            },
            this.controller.signal,
          );
          if (selected.gateway !== this.gateway) this.evidence.providerReads++;
          result = {
            content: [{ type: "text", text: JSON.stringify(output) }],
          };
        } else throw new Error();
        return json(200, { jsonrpc: "2.0", id: body.id, result });
      }
      if (!["claude", "codex", "pi"].includes(request.route)) throw new Error();
      const provider = request.route as keyof typeof modelEndpoints;
      if (
        ![this.config.harness, ...(this.config.nested ?? [])].includes(provider)
      )
        throw new Error();
      this.validateModel(provider, request.body);
      if (this.config.auth === "fixture") {
        if (this.fixtureInference)
          return await this.fixtureInference(provider, request.body);
        if (this.config.fixtureNative)
          return json(409, {
            error:
              "Native fixture execution requires an explicitly injected synthetic inference transport",
          });
        return json(200, { text: "SYNTHETIC_INFERENCE", fixture: true });
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
      };
      for (const key of [
        "anthropic-beta",
        "anthropic-version",
        "user-agent",
        "openai-beta",
        "originator",
        "version",
      ]) {
        const value = request.headers?.[key];
        if (
          typeof value === "string" &&
          value.length <= 2048 &&
          !/[\r\n]/.test(value)
        )
          headers[key] = value;
      }
      if (provider === "claude") {
        if (!this.credentials.claude.claudeAiOauth.accessToken)
          throw new Error();
        headers.authorization = `Bearer ${this.credentials.claude.claudeAiOauth.accessToken}`;
      } else if (provider === "pi") {
        if (!this.credentials.pi?.access) throw new Error();
        headers.authorization = `Bearer ${this.credentials.pi.access}`;
        headers["chatgpt-account-id"] = this.credentials.pi.accountId;
      } else {
        if (!this.credentials.codex.tokens.access_token) throw new Error();
        headers.authorization = `Bearer ${this.credentials.codex.tokens.access_token}`;
        headers["chatgpt-account-id"] =
          this.credentials.codex.tokens.account_id;
      }
      const response = await fetch(modelEndpoints[provider], {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(90000),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return json(502, {
          error: `Model service returned HTTP ${response.status}; no refresh or retry performed`,
        });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.length;
        if (size > 2000000) throw new Error();
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (this.secrets.some((secret) => body.includes(secret)))
        throw new Error();
      this.evidence[
        provider === "claude"
          ? "claudeResponses"
          : provider === "pi"
            ? "piResponses"
            : "codexResponses"
      ]++;
      return { status: 200, body, contentType: "text/event-stream" };
    } catch {
      return json(403, {
        error: "Broker rejected an unapproved, expired, or oversized operation",
      });
    } finally {
      this.active--;
    }
  }

  private validateModel(provider: "claude" | "codex" | "pi", body: any): void {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      this.budget[provider]-- <= 0
    )
      throw new Error();
    const encoded = JSON.stringify(body);
    if (
      encoded.length > 600000 ||
      this.secrets.some((secret) => encoded.includes(secret)) ||
      body.stream !== true ||
      body.model !== this.config.models[provider === "pi" ? "codex" : provider]
    )
      throw new Error();
    const fields =
      provider === "claude"
        ? [
            "model",
            "messages",
            "system",
            "tools",
            "metadata",
            "max_tokens",
            "stream",
            "temperature",
            "thinking",
            "output_config",
            "context_management",
            "tool_choice",
          ]
        : [
            "model",
            "input",
            "instructions",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "reasoning",
            "text",
            "store",
            "stream",
            "include",
            "prompt_cache_key",
            "service_tier",
            "metadata",
            "client_metadata",
          ];
    if (Object.keys(body).some((key) => !fields.includes(key)))
      throw new Error();
    if (provider === "claude") {
      const content = (value: any): boolean =>
        typeof value === "string" ||
        (Array.isArray(value) &&
          value.every(
            (part) =>
              [
                "text",
                "tool_use",
                "thinking",
                "redacted_thinking",
                "tool_reference",
              ].includes(part.type) ||
              (part.type === "tool_result" && content(part.content)),
          ));
      if (
        !Number.isInteger(body.max_tokens) ||
        body.max_tokens < 1 ||
        body.max_tokens > 8192 ||
        !Array.isArray(body.messages) ||
        body.messages.length > 150 ||
        !body.messages.every(
          (item: any) =>
            ["user", "assistant", "system"].includes(item.role) &&
            content(item.content),
        ) ||
        !(
          typeof body.system === "string" ||
          (body.system ?? []).every((part: any) => part.type === "text")
        ) ||
        !(body.tools ?? []).every(
          (tool: any) =>
            !tool.type ||
            tool.type === "custom" ||
            (tool.name === "ToolSearch" &&
              [
                "tool_search_tool_regex_20251119",
                "tool_search_tool_bm25_20251119",
              ].includes(tool.type)),
        )
      )
        throw new Error();
    } else {
      const clientTool = (tool: any): boolean =>
        tool.type === "namespace"
          ? Array.isArray(tool.tools) && tool.tools.every(clientTool)
          : ["function", "custom"].includes(tool.type);
      if (
        body.store !== false ||
        !(body.tools ?? []).every(clientTool) ||
        !Array.isArray(body.input) ||
        body.input.length > 200
      )
        throw new Error();
      for (const item of body.input) {
        if (item.type === "additional_tools") {
          if (!Array.isArray(item.tools) || !item.tools.every(clientTool))
            throw new Error();
        } else if (
          [
            "function_call",
            "function_call_output",
            "custom_tool_call",
            "custom_tool_call_output",
            "reasoning",
            "compaction",
          ].includes(item.type)
        )
          continue;
        else if (
          (item.type && item.type !== "message") ||
          !["user", "assistant", "developer", "system"].includes(item.role) ||
          !(
            typeof item.content === "string" ||
            (Array.isArray(item.content) &&
              item.content.every((part: any) =>
                ["input_text", "output_text"].includes(part.type),
              ))
          )
        )
          throw new Error();
      }
    }
  }
}

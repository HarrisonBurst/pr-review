import { readFile } from "node:fs/promises";
import path from "node:path";
import { guardedFetch } from "./guarded-fetch.js";
import { isIP } from "node:net";
import type {
  IntegrationConfig,
  IntegrationDefinition,
  IntegrationSessionSnapshot,
  IntegrationTestResult,
  ReadProviderReference,
  McpOAuthBinding,
} from "../shared/contracts.js";
import {
  fingerprintToolSchema,
  ReadOnlyMcpGateway,
  type GatewayTransport,
} from "./integrations.js";
import { canonicalJson, validateSchema } from "./schema.js";
import { oauthReadAdapter, oauthReadDefinition } from "./oauth-reads.js";
import { runCommand } from "./util.js";
import { resolveNativeMcp, validateOAuthSource } from "./native-mcp.js";
import type { McpOAuth } from "./mcp-oauth.js";
import { knownMcpProfiles } from "./mcp-profiles.js";
import type { IntegrationInventory } from "../shared/contracts.js";

const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9_-]+$",
};
const uuid = {
  type: "string",
  pattern:
    "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$",
  maxLength: 36,
};
export const readSchemas = {
  github: object({
    method: { enum: ["get", "get_files", "get_reviews"] },
    repository: {
      type: "string",
      pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
      maxLength: 200,
    },
    number: { type: "integer", minimum: 1, maximum: 10000000 },
  }),
  linear: object({ id: identifier }),
  notion: object({ id: uuid, method: { enum: ["page", "blocks"] } }),
  documents: object({ id: identifier }),
};
const specs = {
  github: {
    provider: "github",
    name: "github_pull_request_read",
    label: "GitHub",
    endpoint: "https://api.github.com",
    toolId: "pull-request",
  },
  linear: {
    provider: "linear",
    name: "linear_get_issue",
    label: "Linear",
    endpoint: "https://api.linear.app/graphql",
    toolId: "issue",
  },
  notion: {
    provider: "notion",
    name: "notion_read",
    label: "Notion",
    endpoint: "https://api.notion.com/v1",
    toolId: "page",
  },
  documents: {
    provider: "custom",
    name: "documents_get",
    label: "Vetted document MCP",
    endpoint: null,
    toolId: "document",
  },
} as const;
export type ReadProviderKind = keyof typeof specs;
export const readProviderDefinitions: IntegrationDefinition[] = Object.entries(
  specs,
).map(([id, spec]) => ({
  id: id === "documents" ? "custom:documents" : id,
  provider: spec.provider,
  label: spec.label,
  transport: spec.provider === "custom" ? "mcp-http" : "host-broker",
  authReuse: id === "github" ? "gh-login" : "host-session",
  identity:
    spec.endpoint ??
    "pr-review-documents/1 (explicitly vetted endpoint required)",
  supported: true,
  compatibilityMessage: null,
  tools: [
    {
      id: spec.toolId,
      label: "Bounded read context",
      operation: "read",
      toolNames: [spec.name],
      allowedMethods:
        id === "github" ? ["get", "get_files", "get_reviews"] : [],
      schemaFingerprint: fingerprintToolSchema(
        readSchemas[id as ReadProviderKind],
      ),
      argumentPolicy: "bounded",
    },
  ],
}));

type ReadAuth =
  | { kind: "native"; reference: ReadProviderReference }
  | { kind: "gh-login" }
  | {
      kind: "json-value";
      path: string;
      keys: string[];
      format: "raw" | "bearer";
    };
interface ReadProviderEntry {
  id: string;
  provider: ReadProviderKind;
  endpoint: string;
  scope: string[];
  auth: ReadAuth;
  vettedDefinition?: "pr-review-documents/1";
  profile?: (typeof knownMcpProfiles)[number];
}

export interface ProviderHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  notification?: boolean;
  signal: AbortSignal;
}
export type ProviderHttp = (request: ProviderHttpRequest) => Promise<unknown>;

export const providerHttp: ProviderHttp = async (input) => {
  const response = await guardedFetch(
    [new URL(input.url).origin],
    input.signal,
  )(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
  });
  if (input.notification && [202, 204].includes(response.status)) {
    await response.body?.cancel();
    return null;
  }
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    await response.body?.cancel();
    throw new Error(
      `Provider read failed (HTTP ${response.status}); redirects and non-JSON responses are denied`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Provider returned invalid or oversized JSON");
  }
};

async function manifest(
  file: string,
): Promise<{ entries: ReadProviderEntry[]; digest: string }> {
  if (!path.isAbsolute(file))
    throw new Error(
      "Read-provider import requires an explicit absolute manifest path",
    );
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 100000)
    throw new Error("Read-provider manifest exceeds 100 KB");
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Read-provider manifest must be JSON");
  }
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.readProviders) ||
    value.readProviders.length > 4 ||
    Object.keys(value).some(
      (key) => !["version", "readProviders"].includes(key),
    )
  )
    throw new Error("Expected version 1 and an explicit readProviders array");
  const ids = new Set<string>();
  for (const entry of value.readProviders) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !Object.hasOwn(specs, entry.provider) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "id",
            "provider",
            "endpoint",
            "scope",
            "auth",
            "vettedDefinition",
          ].includes(key),
      )
    )
      throw new Error("Unknown read-provider definition or field");
    const spec = specs[entry.provider as ReadProviderKind];
    if (
      entry.id !==
        (entry.provider === "documents"
          ? "custom:documents"
          : entry.provider) ||
      ids.has(entry.id)
    )
      throw new Error(
        "Read-provider identities must be unique and match the audited definition",
      );
    ids.add(entry.id);
    if (spec.endpoint && entry.endpoint !== spec.endpoint)
      throw new Error(
        "Provider endpoint does not match its exact audited identity",
      );
    if (!spec.endpoint) {
      const endpoint = new URL(entry.endpoint);
      if (
        entry.vettedDefinition !== "pr-review-documents/1" ||
        endpoint.protocol !== "https:" ||
        endpoint.port ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/mcp" ||
        endpoint.search ||
        endpoint.hash ||
        isIP(endpoint.hostname) ||
        !endpoint.hostname.includes(".") ||
        /(?:localhost|\.local|\.internal)$/.test(endpoint.hostname)
      )
        throw new Error(
          "Custom MCP requires the explicitly vetted pr-review-documents/1 definition at a public HTTPS /mcp endpoint",
        );
    }
    if (
      !Array.isArray(entry.scope) ||
      !entry.scope.length ||
      entry.scope.length > 100 ||
      !entry.scope.every(
        (id: unknown) => typeof id === "string" && id.length <= 200,
      )
    )
      throw new Error(
        "Declare 1-100 exact resource identities, not wildcard provider access",
      );
    for (const id of entry.scope) {
      validateSchema(
        entry.provider === "github"
          ? readSchemas.github.properties.repository
          : entry.provider === "notion"
            ? uuid
            : identifier,
        id,
      );
      if (id.split("/").some((part: string) => part === "." || part === ".."))
        throw new Error("Resource scope cannot contain path traversal");
    }
    if (!entry.auth || typeof entry.auth !== "object")
      throw new Error(
        "Explicit existing host authentication source is required",
      );
    if (entry.auth.kind === "gh-login") {
      if (entry.provider !== "github" || Object.keys(entry.auth).length !== 1)
        throw new Error("gh-login is supported only for github.com");
    } else if (
      entry.auth.kind !== "json-value" ||
      !path.isAbsolute(entry.auth.path ?? "") ||
      !["raw", "bearer"].includes(entry.auth.format) ||
      !Array.isArray(entry.auth.keys) ||
      !entry.auth.keys.length ||
      entry.auth.keys.length > 8 ||
      !entry.auth.keys.every(
        (key: unknown) =>
          typeof key === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(key),
      ) ||
      Object.keys(entry.auth).some(
        (key) => !["kind", "path", "keys", "format"].includes(key),
      )
    )
      throw new Error(
        "Only an explicit existing JSON credential value or GitHub gh-login is supported; OAuth discovery, helper commands and refresh are unavailable",
      );
  }
  return { entries: value.readProviders, digest: fingerprintToolSchema(text) };
}

export async function importReadProviders(
  file: string,
): Promise<IntegrationConfig[]> {
  const { entries, digest } = await manifest(file);
  return entries.map((entry) => ({
    id: entry.id,
    enabled: false,
    allowedTools: [],
    source: "imported",
    endpoint: entry.endpoint,
    serverName: null,
    authRef: entry.auth.kind,
    configPath: file,
    readProvider: { path: file, digest, entryId: entry.id },
  }));
}

async function credential(
  auth: ReadAuth,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  try {
    if (auth.kind === "native")
      return (await resolveNativeMcp(auth.reference, true)).credential!;
    if (auth.kind === "gh-login") {
      const result = await runCommand(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        { signal, timeoutMs: 10000, maxOutputBytes: 16000 },
      );
      if (
        result.code !== 0 ||
        result.stdoutTruncated ||
        !result.stdout.trim() ||
        /[\r\n]/.test(result.stdout.trim())
      )
        throw new Error();
      return `Bearer ${result.stdout.trim()}`;
    }
    const text = await readFile(auth.path, "utf8");
    if (Buffer.byteLength(text) > 500000) throw new Error();
    let value: unknown = JSON.parse(text);
    for (const key of auth.keys) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
        throw new Error();
      value = (value as Record<string, unknown>)[key];
    }
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 16000 ||
      /[\r\n]/.test(value)
    )
      throw new Error();
    return auth.format === "bearer" ? `Bearer ${value}` : value;
  } catch {
    signal.throwIfAborted();
    throw new Error(
      "Existing explicitly referenced provider credential is unavailable or incompatible; no login or refresh was attempted",
    );
  }
}

export class ReadProviders {
  oauth?: McpOAuth;
  private readonly evidence = new Map<string, IntegrationTestResult>();
  constructor(
    private readonly http: ProviderHttp = providerHttp,
    readonly synthetic = false,
  ) {
    if (http !== providerHttp && !synthetic)
      throw new Error(
        "Injected provider transports must be explicitly labeled synthetic",
      );
  }
  lastTest(id: string): IntegrationTestResult | undefined {
    return this.evidence.get(id);
  }
  invalidate(id: string): void {
    this.evidence.delete(id);
  }

  private async entry(
    reference: ReadProviderReference,
  ): Promise<ReadProviderEntry> {
    if (reference.native) {
      const resolved = await resolveNativeMcp(reference);
      if (!reference.scope?.length)
        throw new Error("Captured native resource scope is missing");
      return {
        id: reference.entryId,
        provider: "documents",
        endpoint: resolved.endpoint,
        scope: reference.scope,
        auth: { kind: "native", reference },
        profile: resolved.profile,
      };
    }
    const current = await manifest(reference.path);
    const entry = current.entries.find((item) => item.id === reference.entryId);
    if (!entry || current.digest !== reference.digest)
      throw new Error(
        "Pinned read-provider configuration changed; explicitly re-import and create a new session",
      );
    return entry;
  }

  async gateway(
    reference: ReadProviderReference,
    allowedTools: string[],
    signal: AbortSignal,
  ): Promise<ReadOnlyMcpGateway> {
    const entry = await this.entry(reference);
    const spec = entry.profile
      ? {
          ...specs.documents,
          name: entry.profile.tool.name,
          toolId: entry.profile.tool.id,
        }
      : specs[entry.provider];
    const definition = entry.profile
      ? {
          ...readProviderDefinitions.find(
            (item) => item.id === "custom:documents",
          )!,
          id: entry.id,
          tools: [
            {
              ...readProviderDefinitions.find(
                (item) => item.id === "custom:documents",
              )!.tools[0],
              id: spec.toolId,
              toolNames: [spec.name],
              schemaFingerprint: fingerprintToolSchema(
                entry.profile.tool.inputSchema,
              ),
            },
          ],
        }
      : readProviderDefinitions.find((item) => item.id === entry.id)!;
    const schema =
      entry.profile?.tool.inputSchema ?? readSchemas[entry.provider];
    const auth = await credential(entry.auth, signal);
    const read = async (
      url: string,
      body?: unknown,
      requestSignal = signal,
      notification = false,
    ) => {
      const result = await this.http({
        url,
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: auth,
          accept: "application/json",
          "content-type": "application/json",
          ...(entry.provider === "documents"
            ? { "mcp-protocol-version": "2025-03-26" }
            : {}),
          ...(entry.provider === "notion"
            ? { "notion-version": "2022-06-28" }
            : {}),
          ...(entry.provider === "github"
            ? {
                "user-agent": "local-pr-review-read-broker",
                "x-github-api-version": "2022-11-28",
              }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        notification,
        signal: AbortSignal.any([
          signal,
          requestSignal,
          AbortSignal.timeout(15000),
        ]),
      });
      const encoded = JSON.stringify(result);
      const secret = auth.replace(/^Bearer /, "");
      if (
        Buffer.byteLength(encoded) > 200000 ||
        (secret && encoded.includes(secret))
      )
        throw new Error(
          "Provider returned oversized or credential-bearing content",
        );
      return result as any;
    };
    let sequence = 0;
    const rpc = async (
      method: string,
      params: unknown,
      requestSignal = signal,
    ) => {
      const id = ++sequence;
      const result = await read(
        entry.endpoint,
        { jsonrpc: "2.0", id, method, params },
        requestSignal,
      );
      if (
        result?.jsonrpc !== "2.0" ||
        result.id !== id ||
        result.error ||
        !result.result
      )
        throw new Error("Vetted MCP response identity or schema mismatch");
      return result.result;
    };
    const transport: GatewayTransport = {
      listTools: async (listSignal) => {
        signal.throwIfAborted();
        if (entry.provider === "documents") {
          const init = await rpc(
            "initialize",
            {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "pr-review", version: "1" },
            },
            listSignal,
          );
          if (
            init.serverInfo?.name !==
              (entry.profile?.server.name ?? "pr-review-documents") ||
            init.serverInfo?.version !==
              (entry.profile?.server.version ?? "1") ||
            init.protocolVersion !== "2025-03-26" ||
            !init.capabilities?.tools ||
            Object.keys(init.capabilities).some((key) => key !== "tools") ||
            Object.keys(init.capabilities.tools).some(
              (key) => key !== "listChanged",
            ) ||
            init.capabilities.tools.listChanged === true
          )
            throw new Error(
              "Custom MCP server identity or capabilities do not match the vetted stateless pr-review-documents/1 definition",
            );
          await read(
            entry.endpoint,
            { jsonrpc: "2.0", method: "notifications/initialized" },
            listSignal,
            true,
          );
          const result = await rpc("tools/list", {}, listSignal);
          if (
            result.nextCursor ||
            !Array.isArray(result.tools) ||
            result.tools.length !== 1 ||
            result.tools[0].name !== spec.name ||
            result.tools[0].annotations?.destructiveHint === true ||
            result.tools[0].annotations?.readOnlyHint === false ||
            fingerprintToolSchema(result.tools[0].inputSchema) !==
              fingerprintToolSchema(schema)
          )
            throw new Error(
              "Custom MCP schema does not match the vetted document reader",
            );
        }
        return [
          {
            name: spec.name,
            inputSchema: schema,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
            },
          },
        ];
      },
      callTool: async (name, args, callSignal) => {
        signal.throwIfAborted();
        callSignal?.throwIfAborted();
        if (name !== spec.name) throw new Error("Read tool identity mismatch");
        validateSchema(schema, args);
        const resource = String(
          entry.provider === "github" ? args.repository : args.id,
        );
        if (!entry.scope.includes(resource))
          throw new Error(
            "Resource is outside the explicitly approved read scope",
          );
        if (entry.profile) {
          await this.entry(reference);
          await transport.listTools(callSignal);
        }
        if (entry.provider === "github") {
          const suffix =
            args.method === "get"
              ? ""
              : args.method === "get_files"
                ? "/files?per_page=50"
                : "/reviews?per_page=50";
          const result = await read(
            `${entry.endpoint}/repos/${resource}/pulls/${args.number}${suffix}`,
            undefined,
            callSignal,
          );
          if (args.method === "get") {
            if (
              result.number !== args.number ||
              typeof result.title !== "string" ||
              typeof result.head?.sha !== "string"
            )
              throw new Error("GitHub PR response schema mismatch");
            return {
              number: result.number,
              title: result.title,
              body: String(result.body ?? "").slice(0, 50000),
              headSha: result.head.sha,
              baseSha: result.base?.sha,
              state: result.state,
            };
          }
          if (!Array.isArray(result) || result.length > 50)
            throw new Error("GitHub list response schema mismatch");
          for (const item of result) {
            if (
              !item ||
              (args.method === "get_files"
                ? typeof item.filename !== "string" ||
                  typeof item.status !== "string" ||
                  (item.patch !== undefined && typeof item.patch !== "string")
                : !Number.isSafeInteger(item.id) ||
                  typeof item.body !== "string" ||
                  typeof item.state !== "string" ||
                  typeof item.commit_id !== "string")
            )
              throw new Error("GitHub list item schema mismatch");
          }
          return {
            items: result.map((item: any) =>
              args.method === "get_files"
                ? {
                    filename: item.filename,
                    status: item.status,
                    patch: item.patch,
                  }
                : {
                    id: item.id,
                    body: item.body,
                    state: item.state,
                    commitId: item.commit_id,
                  },
            ),
            truncated: result.length === 50,
          };
        }
        if (entry.provider === "linear") {
          const result = await read(
            entry.endpoint,
            {
              query:
                "query ReadIssue($id: String!) { issue(id: $id) { id identifier title description url state { name } } }",
              variables: { id: resource },
            },
            callSignal,
          );
          const issue = result.data?.issue;
          if (
            result.errors ||
            !issue ||
            typeof issue.id !== "string" ||
            ![issue.id, issue.identifier].includes(resource) ||
            typeof issue.title !== "string" ||
            typeof issue.identifier !== "string" ||
            (issue.description !== null &&
              typeof issue.description !== "string") ||
            typeof issue.url !== "string" ||
            typeof issue.state?.name !== "string"
          )
            throw new Error("Linear issue response schema mismatch");
          return {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            url: issue.url,
            state: { name: issue.state.name },
          };
        }
        if (entry.provider === "notion") {
          const result = await read(
            `${entry.endpoint}/${args.method === "page" ? "pages" : "blocks"}/${resource}${args.method === "blocks" ? "/children?page_size=50" : ""}`,
            undefined,
            callSignal,
          );
          if (
            args.method === "page"
              ? result.object !== "page" ||
                result.id?.toLowerCase() !== resource.toLowerCase() ||
                typeof result.url !== "string" ||
                !result.properties ||
                typeof result.properties !== "object" ||
                Array.isArray(result.properties) ||
                typeof result.archived !== "boolean"
              : result.object !== "list" ||
                !Array.isArray(result.results) ||
                result.results.length > 50 ||
                typeof result.has_more !== "boolean" ||
                result.results.some(
                  (block: any) =>
                    !block ||
                    block.object !== "block" ||
                    typeof block.id !== "string" ||
                    typeof block.type !== "string",
                )
          )
            throw new Error("Notion response schema mismatch");
          return args.method === "page"
            ? {
                id: result.id,
                url: result.url,
                properties: result.properties,
                archived: result.archived,
              }
            : { blocks: result.results, truncated: result.has_more === true };
        }
        const result = await rpc(
          "tools/call",
          { name: spec.name, arguments: args },
          callSignal,
        );
        if (
          result.isError ||
          !Array.isArray(result.content) ||
          result.content.length !== 1 ||
          result.content[0].type !== "text" ||
          typeof result.content[0].text !== "string"
        )
          throw new Error("Custom MCP read result schema mismatch");
        return { text: result.content[0].text };
      },
    };
    return new ReadOnlyMcpGateway(
      {
        definition: { ...definition, identity: entry.endpoint },
        config: {
          id: entry.id,
          enabled: true,
          allowedTools,
          source: "imported",
          endpoint: entry.endpoint,
          serverName: null,
          authRef: null,
          configPath: reference.path,
        },
        status: "ready",
        effective: "restricted",
        message: "Bounded audited read implementation",
        tools: definition.tools.map((tool) => ({
          id: tool.id,
          label: tool.label,
          state: allowedTools.includes(tool.id) ? "allowed" : "disabled",
          reason: "Pinned explicit session policy",
        })),
      },
      transport,
    );
  }

  private async oauthGateway(
    config: IntegrationConfig,
    binding: McpOAuthBinding,
    signal: AbortSignal,
  ) {
    const adapter = oauthReadAdapter(config.oauthProfileId);
    const definition = oauthReadDefinition(
      config.oauthProfileId,
      config.inventory,
    );
    if (
      !this.oauth ||
      !config.enabled ||
      config.inventory?.status !== "loaded" ||
      !definition ||
      !adapter ||
      !config.allowedTools.length ||
      config.allowedTools.some(
        (name) => !definition.tools.some((tool) => tool.id === name),
      )
    )
      throw new Error(
        "OAuth read capture is missing or contains an unapproved tool",
      );
    if (canonicalJson(binding) !== canonicalJson(this.oauth.binding(config.id)))
      throw new Error("Captured OAuth admission changed");
    await validateOAuthSource(config);
    signal.throwIfAborted();
    const captured = structuredClone(config);
    const capturedBinding = structuredClone(binding);
    return new ReadOnlyMcpGateway(
      {
        definition: { ...definition, id: config.id },
        config: captured,
        status: "ready",
        effective: "restricted",
        message: definition.compatibilityMessage!,
        tools: definition.tools.map((tool) => ({
          id: tool.id,
          label: tool.label,
          state: captured.allowedTools.includes(tool.id)
            ? "allowed"
            : "disabled",
          reason: "Captured explicit read permission",
        })),
      },
      {
        listTools: async () =>
          adapter.tools.filter((tool) =>
            captured.allowedTools.includes(tool.name),
          ),
        callTool: async (name, args, callSignal) => {
          adapter.arguments(name, args);
          if (!captured.allowedTools.includes(name))
            throw new Error("OAuth read tool not granted");
          await validateOAuthSource(captured);
          const fingerprint = captured.inventory!.tools.find(
            (tool) => tool.name === name,
          )?.schemaFingerprint;
          if (!fingerprint)
            throw new Error("Captured OAuth read schema missing");
          return this.oauth!.readTool(
            captured.id,
            capturedBinding,
            fingerprint,
            name,
            args,
            AbortSignal.any([signal, callSignal ?? signal]),
          );
        },
      },
    );
  }

  async session(
    snapshot: IntegrationSessionSnapshot | undefined,
    signal: AbortSignal,
  ): Promise<Array<{ identity: string; gateway: ReadOnlyMcpGateway }>> {
    const gateways = [];
    for (const connection of snapshot?.boundary === "read-only-gateway"
      ? snapshot.connections
      : []) {
      if (connection.oauthBinding && connection.allowedTools.length) {
        if (connection.effective !== "restricted")
          throw new Error("OAuth read capture is disabled");
        const definition = oauthReadDefinition(
          connection.oauthBinding.profileId,
          connection.inventory,
        );
        const gateway = await this.oauthGateway(
          {
            id: connection.id,
            enabled: true,
            allowedTools: connection.allowedTools,
            native: connection.native,
            inventory: connection.inventory,
            oauthProfileId: connection.oauthBinding.profileId,
            source: "imported",
            endpoint: definition?.identity ?? null,
            serverName: null,
            authRef: null,
            configPath: null,
          },
          connection.oauthBinding,
          signal,
        );
        gateways.push({ identity: definition!.identity, gateway });
        continue;
      }
      if (!connection.readProvider || !connection.allowedTools.length) continue;
      if (
        connection.readProvider.native &&
        (connection.effective !== "restricted" ||
          connection.inventory?.status !== "loaded")
      )
        throw new Error(
          "Captured native connection has no approved loaded inventory",
        );
      const entry = await this.entry(connection.readProvider);
      if (
        entry.profile &&
        (connection.inventory!.tools.length !== 1 ||
          connection.inventory!.tools[0].name !== entry.profile.tool.name ||
          connection.inventory!.tools[0].schemaFingerprint !==
            fingerprintToolSchema(entry.profile.tool.inputSchema))
      )
        throw new Error("Captured tool inventory changed; no implicit grants");
      gateways.push({
        identity: entry.endpoint,
        gateway: await this.gateway(
          connection.readProvider,
          connection.allowedTools,
          signal,
        ),
      });
    }
    return gateways;
  }

  async loadTools(config: IntegrationConfig): Promise<IntegrationInventory> {
    try {
      if (config.oauthProfileId) {
        if (!this.oauth || !config.endpoint)
          throw new Error("OAuth connection is not configured");
        await validateOAuthSource(config);
        return await this.oauth.inventory(config.id);
      }
      if (!config.readProvider)
        throw new Error(
          "Import a supported profile and explicit resource scope first",
        );
      const entry = await this.entry(config.readProvider);
      const gateway = await this.gateway(
        config.readProvider,
        [entry.profile?.tool.id ?? specs[entry.provider].toolId],
        AbortSignal.timeout(15000),
      );
      const tools = await gateway.listTools();
      if (!tools.length) throw new Error("No exact known tools available");
      return {
        status: "loaded",
        checkedAt: new Date().toISOString(),
        scope: this.synthetic ? "synthetic_transport" : "live_inventory",
        connected: false,
        message:
          "Exact known tool inventory loaded; no read was tested and no permissions were granted.",
        tools: tools.map((tool) => ({
          name: tool.name,
          schemaFingerprint: fingerprintToolSchema(tool.inputSchema),
        })),
      };
    } catch (error) {
      const changed =
        error instanceof Error &&
        /schema does not match|identity or capabilities|configuration\/profile changed/.test(
          error.message,
        );
      return {
        status: changed ? "changed" : "error",
        checkedAt: new Date().toISOString(),
        scope: config.readProvider
          ? this.synthetic
            ? "synthetic_transport"
            : "live_inventory"
          : "local_configuration",
        connected: false,
        message:
          "Inventory unavailable or changed. No permissions granted; check source, auth and exact known server/schema compatibility.",
        tools: [],
      };
    }
  }

  async test(config: IntegrationConfig): Promise<IntegrationTestResult> {
    let status: IntegrationTestResult["status"] = "configured";
    let message =
      "No explicit audited read-provider configuration was imported";
    let connected = false;
    if (config.readProvider) {
      try {
        const entry = await this.entry(config.readProvider);
        const gateway = await this.gateway(
          config.readProvider,
          [entry.profile?.tool.id ?? specs[entry.provider].toolId],
          AbortSignal.timeout(15000),
        );
        await gateway.listTools();
        const args =
          entry.provider === "github"
            ? null
            : entry.provider === "notion"
              ? { id: entry.scope[0], method: "page" }
              : { id: entry.scope[0] };
        if (args)
          await gateway.call({
            serverIdentity: entry.endpoint,
            name: entry.profile?.tool.name ?? specs[entry.provider].name,
            arguments: args,
          });
        else {
          const auth = await credential(entry.auth, AbortSignal.timeout(15000));
          const result = (await this.http({
            url: `${entry.endpoint}/user`,
            method: "GET",
            headers: {
              authorization: auth,
              accept: "application/json",
              "user-agent": "local-pr-review-read-broker",
            },
            signal: AbortSignal.timeout(15000),
          })) as any;
          if (
            !Number.isSafeInteger(result?.id) ||
            typeof result.login !== "string"
          )
            throw new Error("GitHub identity read failed");
        }
        connected = !this.synthetic;
        status = "ready";
        message = this.synthetic
          ? "Synthetic read transport passed; no live connection was tested"
          : "An explicit bounded provider read succeeded. This is point-in-time evidence, not ongoing availability or a containment test";
      } catch (error) {
        status = "error";
        message =
          "Provider read failed or source/auth/schema changed; no login, refresh or permission grant was attempted";
      }
    }
    if (config.oauthProfileId) {
      const result: IntegrationTestResult = {
        testedAt: new Date().toISOString(),
        mutating: false,
        scope: "local_configuration",
        connected: false,
        containmentVerified: false,
        status: "needs_compatibility",
        message:
          config.oauthProfileId === "axiom-mcp/1"
            ? "Authenticate, Load tools, enable the connection and explicitly grant listDatasets before Test. No identity verification is required."
            : "Authenticate, Load tools, enable the connection and explicitly grant a search tool before Test. No identity verification is required.",
      };
      if (config.oauthProfileId === "notion-mcp/1") {
        result.message =
          "Notion local check requires admitted authentication, loaded inventory and an enabled explicit notion-fetch grant. No content read, credential refresh or provider request is performed; Test has no document ID.";
        try {
          const signal = AbortSignal.timeout(15000);
          if (!config.inventory?.oauthBinding) throw new Error(result.message);
          const gateway = await this.oauthGateway(
            config,
            config.inventory.oauthBinding,
            signal,
          );
          await gateway.listTools(signal);
          result.status = "ready";
          result.message =
            "Notion local admission, source and fetch grant check passed. No document was read and no credential was accessed. This is not live read evidence; actual granted reads validate the current provider schema before dispatch.";
        } catch {
          result.status = "needs_compatibility";
        }
        this.evidence.set(config.id, result);
        return result;
      }
      try {
        const adapter = oauthReadAdapter(config.oauthProfileId);
        const name = adapter?.testTools.find((name) =>
          config.allowedTools.includes(name),
        );
        if (!adapter || !name || !config.inventory?.oauthBinding)
          throw new Error(result.message);
        const signal = AbortSignal.timeout(15000);
        const gateway = await this.oauthGateway(
          config,
          config.inventory.oauthBinding,
          signal,
        );
        await gateway.listTools(signal);
        await gateway.call(
          {
            serverIdentity: adapter.identity,
            name,
            arguments: adapter.testArguments,
          },
          signal,
        );
        result.scope = this.oauth!.synthetic
          ? "synthetic_transport"
          : "live_read";
        result.connected = !this.oauth!.synthetic;
        result.status = "ready";
        result.message = this.oauth!.synthetic
          ? `Synthetic ${adapter.label} read passed; not live connection evidence.`
          : `One bounded ${adapter.label} ${config.oauthProfileId === "axiom-mcp/1" ? "dataset listing" : "search"} succeeded using provider access controls. No independent identity, resource isolation or completeness guarantee is claimed.`;
      } catch {
        result.message =
          config.oauthProfileId === "axiom-mcp/1"
            ? "Axiom read Test did not succeed. Check admission, explicit listDatasets permission, source and inventory; no operation was retried."
            : "OAuth read Test did not succeed. Check admission, explicit search grants, source and inventory; no operation was retried.";
      }
      this.evidence.set(config.id, result);
      return result;
    }
    const result: IntegrationTestResult = {
      testedAt: new Date().toISOString(),
      mutating: false,
      scope: config.readProvider
        ? this.synthetic
          ? "synthetic_transport"
          : "live_read"
        : "local_configuration",
      connected,
      containmentVerified: false,
      status,
      message,
    };
    this.evidence.set(config.id, result);
    return result;
  }
}

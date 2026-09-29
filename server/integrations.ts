import { createHash } from "node:crypto";
import type {
  IntegrationCatalog,
  IntegrationConfig,
  IntegrationConnection,
  IntegrationDefinition,
  IntegrationEffectiveState,
  IntegrationId,
  IntegrationSessionSnapshot,
  IntegrationSettings,
  IntegrationToolDefinition,
} from "../shared/contracts.js";
import { canonicalJson, validateSchema } from "./schema.js";
import { readProviderDefinitions } from "./read-providers.js";
import { knownMcpProfiles, oauthMcpProfiles } from "./mcp-profiles.js";
import { oauthReadDefinition } from "./oauth-reads.js";
import { slackReadMessage } from "./slack-reads.js";

export function defaultIntegrationSettings(): IntegrationSettings {
  return { configs: [], importedHarnessAt: null };
}

function safeAuthRef(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    /token|secret|bearer|eyJ/i.test(value)
  )
    return null;
  return value;
}

function safeEndpoint(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) =>
        /token|secret|password|api[-_]?key|auth/i.test(key),
      )
    )
      return null;
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeIntegrationConfig(
  value: Partial<IntegrationConfig> & { id: IntegrationId },
): IntegrationConfig {
  const known = value.readProvider
    ? readProviderDefinitions.find(
        (item) =>
          item.id ===
          (value.readProvider?.native ? "custom:documents" : value.id),
      )
    : oauthReadDefinition(value.oauthProfileId, value.inventory);
  const source =
    value.source === "custom" || value.source === "imported"
      ? value.source
      : "inherited";
  const allowed = known
    ? [
        ...new Set(
          (value.allowedTools ?? []).filter((id) =>
            known.tools.some((item) => item.id === id),
          ),
        ),
      ]
    : [];
  return {
    ...(value.oauthProfileId &&
    oauthMcpProfiles.some((profile) => profile.id === value.oauthProfileId)
      ? { oauthProfileId: value.oauthProfileId }
      : {}),
    ...(value.native ? { native: value.native } : {}),
    ...(value.inventory ? { inventory: value.inventory } : {}),
    ...(value.readProvider &&
    typeof value.readProvider.path === "string" &&
    value.readProvider.path.startsWith("/") &&
    /^[a-f0-9]{64}$/.test(value.readProvider.digest) &&
    value.readProvider.entryId === value.id
      ? { readProvider: value.readProvider }
      : {}),
    id: value.id,
    enabled: value.enabled === true,
    allowedTools: allowed,
    source,
    endpoint: safeEndpoint(value.endpoint),
    serverName:
      typeof value.serverName === "string" && value.serverName.length <= 200
        ? value.serverName
        : null,
    authRef: safeAuthRef(value.authRef),
    configPath:
      typeof value.configPath === "string" && value.configPath.length <= 1_024
        ? value.configPath
        : null,
  };
}

export function normalizeIntegrationSettings(
  value: IntegrationSettings | undefined,
): IntegrationSettings {
  const configs = new Map<IntegrationId, IntegrationConfig>();
  for (const item of value?.configs ?? []) {
    if (!item || typeof item.id !== "string") continue;
    configs.set(item.id, normalizeIntegrationConfig(item));
  }
  return {
    configs: [...configs.values()],
    importedHarnessAt: value?.importedHarnessAt ?? null,
  };
}

export function buildIntegrationCatalog(
  settings: IntegrationSettings,
  _githubReady: boolean,
  boundaryAvailable = false,
): IntegrationCatalog {
  const connections = normalizeIntegrationSettings(settings)
    .configs.filter(
      (config) => config.native || config.readProvider || config.oauthProfileId,
    )
    .map((config): IntegrationConnection => {
      const supported =
        oauthReadDefinition(config.oauthProfileId, config.inventory) ??
        (config.readProvider &&
          readProviderDefinitions.find(
            (item) =>
              item.id ===
              (config.readProvider?.native ? "custom:documents" : config.id),
          ));
      const definition: IntegrationDefinition = supported
        ? {
            ...supported,
            id: config.id,
            ...(config.native || config.oauthProfileId
              ? {
                  label: config.serverName ?? config.id,
                  identity: config.endpoint!,
                }
              : {}),
          }
        : {
            id: config.id,
            provider: "custom",
            label: config.serverName ?? config.id,
            transport:
              config.native?.transport === "stdio" ? "mcp-stdio" : "mcp-http",
            authReuse: "none",
            identity: config.endpoint ?? config.id,
            tools: [],
            supported: false,
            compatibilityMessage:
              config.native?.message ??
              "Bind a supported profile before granting tools.",
          };
      const loaded =
        !(config.native || config.oauthProfileId) ||
        config.inventory?.status === "loaded";
      const effective =
        config.enabled && supported && loaded && boundaryAvailable;
      const message = !supported
        ? definition.compatibilityMessage!
        : !loaded
          ? "Explicitly Load tools. New or changed tools default denied."
          : !config.enabled
            ? "Configured, not connected. Disabled for review context."
            : !boundaryAvailable
              ? "Save supported Isolated settings or set up Docker before using gateway reads."
              : "Configured captured read permissions, not verified connected. Test connection separately.";
      return {
        definition,
        config,
        status: !supported
          ? config.native?.support === "supported"
            ? "configured"
            : "unsupported"
          : !loaded || (config.enabled && !boundaryAvailable)
            ? "needs_compatibility"
            : "configured",
        effective: effective ? "restricted" : "disabled",
        message,
        tools: definition.tools.map((tool) => ({
          id: tool.id,
          label: tool.label,
          state: !config.allowedTools.includes(tool.id)
            ? "disabled"
            : effective
              ? "allowed"
              : "unsupported",
          reason: message,
        })),
      };
    });
  return {
    profiles: knownMcpProfiles,
    oauthProfiles: oauthMcpProfiles.map((profile) =>
      profile.id === "slack-mcp/1"
        ? { ...profile, readSupport: "supported", message: slackReadMessage }
        : profile,
    ),
    connections,
    discoveredAt: settings.importedHarnessAt ?? "",
    boundary: {
      status: boundaryAvailable ? "available" : "unavailable",
      message: boundaryAvailable
        ? "Selected execution supports captured audited reads, not live connection or containment evidence."
        : "Save supported Isolated settings or set up Docker for gateway reads. Dangerous native tools are independent.",
    },
  };
}

export function integrationSnapshot(
  catalog: IntegrationCatalog,
): IntegrationSessionSnapshot {
  return {
    boundary:
      catalog.boundary.status === "available" ? "read-only-gateway" : "none",
    connections: catalog.connections
      .filter((item) => item.config.enabled)
      .map((item) => ({
        id: item.definition.id,
        ...(item.config.readProvider
          ? { readProvider: structuredClone(item.config.readProvider) }
          : {}),
        ...(item.config.inventory
          ? { inventory: structuredClone(item.config.inventory) }
          : {}),
        ...(item.config.oauthProfileId && item.config.inventory?.oauthBinding
          ? {
              oauthBinding: structuredClone(item.config.inventory.oauthBinding),
              native: structuredClone(item.config.native),
            }
          : {}),
        effective: item.effective,
        allowedTools: item.tools
          .filter((toolItem) => toolItem.state === "allowed")
          .map((toolItem) => toolItem.id),
      })),
  };
}

export interface GatewayTool {
  name: string;
  inputSchema: unknown;
}

export interface GatewayCall {
  serverIdentity: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface GatewayTransport {
  listTools(signal?: AbortSignal): Promise<GatewayTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const gatewayTimeoutMs = 15_000;

export class ReadOnlyMcpGateway {
  private readonly validatedTools = new Map<string, unknown>();

  constructor(
    private readonly connection: IntegrationConnection,
    private readonly transport: GatewayTransport,
  ) {}

  async listTools(signal?: AbortSignal): Promise<GatewayTool[]> {
    if (this.connection.status !== "ready")
      throw new Error(this.connection.message);
    this.validatedTools.clear();
    const tools = await this.runBounded(
      (childSignal) => this.transport.listTools(childSignal),
      signal,
    );
    if (
      !Array.isArray(tools) ||
      tools.length > 100 ||
      new Set(tools.map((tool) => tool.name)).size !== tools.length
    )
      throw new Error("MCP tool inventory is invalid or ambiguous");
    const allowed = tools.filter((item) => {
      const definition = this.definitionFor(item.name);
      if (!definition) return false;
      if (
        definition.schemaFingerprint === null ||
        definition.schemaFingerprint !== fingerprintToolSchema(item.inputSchema)
      )
        return false;
      this.validatedTools.set(item.name, item.inputSchema);
      return true;
    });
    return allowed;
  }

  async call(call: GatewayCall, signal?: AbortSignal): Promise<unknown> {
    if (call.serverIdentity !== this.connection.definition.identity)
      throw new Error("integration server identity mismatch");
    const method =
      typeof call.arguments.method === "string"
        ? call.arguments.method
        : undefined;
    if (
      this.connection.status !== "ready" ||
      !this.allowedTool(call.name, method) ||
      !this.validatedTools.has(call.name)
    )
      throw new Error("MCP tool is not an enabled vetted read operation");
    const definition = this.definitionFor(call.name, method);
    if (
      !definition ||
      (definition.allowedMethods.length > 0 &&
        (typeof call.arguments.method !== "string" ||
          !definition.allowedMethods.includes(call.arguments.method)))
    )
      throw new Error("MCP arguments do not match the vetted read operation");
    validateSchema(this.validatedTools.get(call.name), call.arguments);
    if (Object.keys(call.arguments).length > 32)
      throw new Error("MCP arguments exceed the bounded limit");
    for (const value of Object.values(call.arguments)) {
      if (typeof value === "string" && value.length > 4_000)
        throw new Error("MCP argument exceeds the bounded limit");
    }
    const output = await this.runBounded(
      (childSignal) =>
        this.transport.callTool(call.name, call.arguments, childSignal),
      signal,
    );
    const encoded = JSON.stringify(output) ?? "null";
    if (encoded.length > 200_000)
      throw new Error("MCP output exceeds the bounded limit");
    return output;
  }

  private async runBounded<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      signal.throwIfAborted();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      timer = setTimeout(
        () => controller.abort(new Error("MCP operation timed out")),
        gatewayTimeoutMs,
      );
      return await Promise.race([
        operation(controller.signal),
        new Promise<T>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          ),
        ),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private allowedTool(name: string, method?: string): boolean {
    return Boolean(this.definitionFor(name, method));
  }

  private definitionFor(
    name: string,
    method?: string,
  ): IntegrationToolDefinition | null {
    for (const selected of this.connection.tools.filter(
      (item) => item.state === "allowed",
    )) {
      const definition = this.connection.definition.tools.find(
        (item) =>
          item.id === selected.id &&
          item.toolNames.includes(name) &&
          (method === undefined ||
            item.allowedMethods.length === 0 ||
            item.allowedMethods.includes(method)),
      );
      if (definition) return definition;
    }
    return null;
  }
}

export function fingerprintToolSchema(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

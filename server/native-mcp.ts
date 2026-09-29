import { readFile } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import type {
  IntegrationConfig,
  NativeMcpDiscoveryRequest,
  NativeMcpSource,
  ReadProviderReference,
} from "../shared/contracts.js";
import { codexSettings, settingsObject } from "./execution/projection.js";
import { digest } from "./execution/policy.js";
import { knownMcpProfiles, oauthMcpProfiles } from "./mcp-profiles.js";

export class NativeMcpDiscoveryError extends Error {}

async function source(
  file: string,
  format: NativeMcpSource["format"],
): Promise<Record<string, any>> {
  if (!path.isAbsolute(file))
    throw new Error(
      "Native discovery requires an absolute operator configuration path",
    );
  const text = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      throw new NativeMcpDiscoveryError(
        error.code === "ENOENT"
          ? "Native configuration file was not found. Choose an existing absolute Claude JSON or Codex TOML file; installed plugin MCP files must be selected explicitly."
          : "Native configuration file could not be read. Check the selected file and its permissions.",
      );
    },
  );
  if (Buffer.byteLength(text) > 500000)
    throw new Error("Native MCP configuration exceeds 500 KB");
  let value: Record<string, any>;
  try {
    value =
      format === "claude-json" ? settingsObject(text) : codexSettings(text);
  } catch {
    throw new NativeMcpDiscoveryError(
      "Native configuration could not be parsed as the selected Claude JSON or Codex TOML format.",
    );
  }
  const entries =
    value[format === "claude-json" ? "mcpServers" : "mcp_servers"];
  if (
    !entries ||
    typeof entries !== "object" ||
    Array.isArray(entries) ||
    Object.keys(entries).length > 100
  )
    throw new NativeMcpDiscoveryError(
      "Selected file must contain a top-level mcpServers JSON or mcp_servers TOML map with at most 100 entries. App-owned connections and installed plugins are not scanned; select a plugin MCP file explicitly.",
    );
  return entries as Record<string, any>;
}

function identity(
  record: Record<string, any>,
  format: NativeMcpSource["format"],
) {
  const transport = record.command
    ? "stdio"
    : typeof record.url === "string" &&
        (format === "codex-toml" || record.type === "http")
      ? "http"
      : "unsupported";
  let endpoint: string | null = null;
  try {
    const url = new URL(record.url);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !isIP(url.hostname) &&
      url.hostname !== "localhost" &&
      !url.hostname.endsWith(".localhost") &&
      /^[a-zA-Z0-9.-]+$/.test(url.hostname)
    )
      endpoint = url.toString();
  } catch {}
  const headers =
    format === "claude-json" ? record.headers : record.http_headers;
  const authSupported =
    headers &&
    typeof headers.Authorization === "string" &&
    Object.keys(headers).length === 1 &&
    !/[\r\n$`]/.test(headers.Authorization) &&
    headers.Authorization.startsWith("Bearer ");
  const allowedKeys =
    format === "claude-json"
      ? ["type", "url", "headers"]
      : [
          "url",
          "http_headers",
          "enabled",
          "enabled_tools",
          "disabled_tools",
          "startup_timeout_sec",
          "tool_timeout_sec",
          "required",
        ];
  const oauthMetadata =
    transport === "http" &&
    endpoint &&
    !headers &&
    Object.keys(record).every((key) =>
      ["type", "url", "oauth"].includes(key),
    ) &&
    (record.oauth === undefined ||
      (record.oauth &&
        typeof record.oauth === "object" &&
        !Array.isArray(record.oauth) &&
        Object.keys(record.oauth).every((key) =>
          ["clientId", "callbackPort"].includes(key),
        ) &&
        typeof record.oauth.clientId === "string" &&
        /^[A-Za-z0-9._:-]{1,200}$/.test(record.oauth.clientId) &&
        Number.isInteger(record.oauth.callbackPort) &&
        record.oauth.callbackPort > 0 &&
        record.oauth.callbackPort <= 65535));
  const supported =
    oauthMetadata ||
    (transport === "http" &&
      endpoint &&
      authSupported &&
      Object.keys(record).every((key) => allowedKeys.includes(key)));
  const message =
    transport === "stdio"
      ? "Local stdio executes host code. This profile never spawns it, including on discovery, enable, Load or Test. Use an independently supported Docker projection or explicit Dangerous native access."
      : oauthMetadata
        ? "Trusted HTTP MCP definition only. Declared OAuth client/callback metadata is not an app-owned registration or authenticated session. Import a matching profile and confirm a supported client/redirect before explicit Connect; no native login is read or reused."
        : supported
          ? "Static HTTPS bearer configuration is reusable with an explicit known profile and resource scope. No auth or server availability was tested."
          : "Unsupported transport, auth or native fields. Only stateless HTTPS with a literal Authorization bearer header is supported; OAuth stores, helpers, env interpolation, SSE and sessionful HTTP require a separate supported profile.";
  return {
    ...(oauthMetadata && record.oauth
      ? {
          oauth: {
            clientId: record.oauth.clientId as string,
            callbackPort: record.oauth.callbackPort as number,
          },
        }
      : {}),
    authentication: authSupported
      ? ("literal-bearer" as const)
      : oauthMetadata
        ? ("app-owned-oauth" as const)
        : undefined,
    transport: transport as NativeMcpSource["transport"],
    endpoint,
    support: (supported
      ? "supported"
      : "unsupported") as NativeMcpSource["support"],
    message,
    digest: digest(
      JSON.stringify({
        format,
        endpoint,
        transport,
        keys: Object.keys(record).sort(),
        headerNames: headers ? Object.keys(headers).sort() : [],
        auth: authSupported
          ? "literal-bearer"
          : oauthMetadata
            ? "app-owned-oauth"
            : "unsupported",
        ...(oauthMetadata ? { oauth: record.oauth } : {}),
        enabled: record.enabled,
        enabled_tools: record.enabled_tools,
        disabled_tools: record.disabled_tools,
      }),
    ),
  };
}

export async function discoverNativeMcp(
  request: NativeMcpDiscoveryRequest,
  env: NodeJS.ProcessEnv,
): Promise<IntegrationConfig[]> {
  if (request.harness === "pi")
    throw new Error(
      "Pi has no native MCP configuration format. Executable MCP extensions are disabled; import a supported Claude JSON or Codex TOML static connection instead.",
    );
  const format = request.harness === "claude" ? "claude-json" : "codex-toml";
  const file =
    request.path ??
    (request.harness === "claude"
      ? path.join(env.HOME!, ".claude.json")
      : path.join(
          env.CODEX_HOME ?? path.join(env.HOME!, ".codex"),
          "config.toml",
        ));
  const entries = await source(file, format);
  return Object.entries(entries).map(([name, record]) => {
    if (
      !/^[A-Za-z0-9_.-]{1,100}$/.test(name) ||
      !record ||
      typeof record !== "object" ||
      Array.isArray(record)
    )
      throw new Error("Unsupported native connection identity");
    const value = identity(record, format);
    return {
      id: `native:${digest(`${file}:${name}`).slice(0, 32)}`,
      native: {
        authentication: value.authentication,
        ...(value.oauth ? { oauth: value.oauth } : {}),
        harness: request.harness,
        format,
        path: file,
        name,
        digest: value.digest,
        transport: value.transport,
        support: value.support,
        message: value.message,
      },
      enabled: false,
      allowedTools: [],
      source: "imported",
      endpoint: value.endpoint,
      serverName: name,
      authRef: null,
      configPath: file,
    };
  });
}

export function nativeReference(
  config: IntegrationConfig,
  profileId: string,
  scope: string[],
): ReadProviderReference {
  const profile = knownMcpProfiles.find((item) => item.id === profileId);
  if (
    !config.native ||
    config.native.support !== "supported" ||
    config.native.authentication === "app-owned-oauth" ||
    !profile ||
    !config.endpoint ||
    new URL(config.endpoint).pathname !== profile.endpointPath
  )
    throw new Error(
      "Connection does not match this supported known profile/transport; no permission was granted",
    );
  if (
    !Array.isArray(scope) ||
    scope.length < 1 ||
    scope.length > 100 ||
    scope.some(
      (value) =>
        typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value),
    )
  )
    throw new Error("Explicit scope must contain 1-100 bounded document ids");
  return {
    path: config.native.path,
    digest: config.native.digest,
    entryId: config.id,
    native: config.native,
    profileId: profile.id,
    profileDigest: digest(JSON.stringify(profile)),
    scope: [...new Set(scope)],
  };
}

export async function validateOAuthSource(config: IntegrationConfig) {
  const profile = oauthMcpProfiles.find(
    (item) => item.id === config.oauthProfileId,
  );
  if (!profile || config.endpoint !== profile.endpoint || config.readProvider)
    throw new Error("OAuth connection does not match a reviewed provider");
  if (config.native)
    return validateNativeOAuthSource(config.native, profile.endpoint);
  if (config.id !== `oauth:${profile.id}`)
    throw new Error("App-owned OAuth provider identity does not match");
}

export async function validateNativeOAuthSource(
  native: NativeMcpSource,
  endpoint: string,
) {
  const record = (await source(native.path, native.format))[native.name];
  if (!record)
    throw new Error("Native MCP definition is missing; rediscover explicitly");
  const current = identity(record, native.format);
  if (
    current.digest !== native.digest ||
    current.endpoint !== endpoint ||
    current.support !== "supported" ||
    record.headers ||
    record.http_headers ||
    record.command
  )
    throw new Error(
      "Native OAuth definition changed or is unsupported; reconnect and recapture explicitly",
    );
}

export async function resolveDockerStdio(native: NativeMcpSource) {
  const record = (await source(native.path, native.format))[native.name];
  if (
    !record ||
    identity(record, native.format).digest !== native.digest ||
    !["node", "/usr/local/bin/node"].includes(record.command) ||
    !Array.isArray(record.args) ||
    record.args.length !== 1 ||
    typeof record.args[0] !== "string" ||
    !path.isAbsolute(record.args[0]) ||
    !record.args[0].endsWith(".mjs") ||
    Object.keys(record).some(
      (key) => !["type", "command", "args"].includes(key),
    ) ||
    (record.type !== undefined && record.type !== "stdio")
  )
    throw new Error(
      "Docker stdio supports only an explicitly approved local Node .mjs entry with prepared portable resources, no environment, auth helpers, package runner or download. Rediscover changed configuration.",
    );
  return record.args[0] as string;
}

export async function resolveNativeMcp(
  reference: ReadProviderReference,
  auth = false,
) {
  const native = reference.native!;
  const record = (await source(native.path, native.format))[native.name];
  if (!record)
    throw new Error(
      "Captured native MCP connection is missing; explicitly rediscover and import for new sessions",
    );
  const current = identity(record, native.format);
  const profile = knownMcpProfiles.find(
    (item) => item.id === reference.profileId,
  );
  if (
    current.digest !== reference.digest ||
    current.support !== "supported" ||
    !profile ||
    digest(JSON.stringify(profile)) !== reference.profileDigest ||
    new URL(current.endpoint!).pathname !== profile.endpointPath
  )
    throw new Error(
      "Captured native MCP identity/configuration/profile changed; calls denied until explicit re-import for new sessions",
    );
  const headers =
    native.format === "claude-json" ? record.headers : record.http_headers;
  if (
    record.enabled === false ||
    (record.enabled_tools &&
      !record.enabled_tools.includes(profile.tool.name)) ||
    record.disabled_tools?.includes(profile.tool.name)
  )
    throw new Error("Native source explicitly disables this connection/tool");
  return {
    endpoint: current.endpoint!,
    profile,
    credential: auth ? (headers.Authorization as string) : undefined,
  };
}

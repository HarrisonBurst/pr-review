import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { loadConfig } from "../../config.js";
import { ReviewService } from "../../service.js";
import { createHttpServer } from "../../http.js";
import { McpOAuth } from "../../mcp-oauth.js";
import {
  CredentialStoreError,
  type CredentialStore,
} from "../../credential-store.js";
import type { GuardedFetch } from "../../guarded-fetch.js";
import { fixtureCredentials } from "../../execution/auth.js";
import type { McpClientAuthMethod } from "../../../shared/contracts.js";
import type {
  Tool,
  Implementation,
  CallToolResult,
} from "@modelcontextprotocol/client";

export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, Uint8Array>();
  unavailable = false;
  async read(reference: string) {
    if (this.unavailable) throw new CredentialStoreError("unavailable");
    return this.values.get(reference)?.slice();
  }
  async replace(reference: string, value: Uint8Array) {
    if (this.unavailable) throw new CredentialStoreError("unavailable");
    this.values.set(reference, value.slice());
  }
  async delete(reference: string) {
    if (this.unavailable) throw new CredentialStoreError("unavailable");
    this.values.delete(reference);
  }
}

export async function oauthFixture(
  options: {
    root?: string;
    port?: number;
    profile?: "linear" | "axiom" | "notion";
    clientAuthMethods?: McpClientAuthMethod[];
    scopes?: string[];
    tokenOverrides?: Record<string, unknown>;
    metadataOverrides?: Record<string, unknown>;
    resourceOverrides?: Record<string, unknown>;
    mcpTools?: Tool[];
    mcpServerInfo?: Implementation;
    mcpStatus?: number;
    mcpNextCursor?: string;
    onMcpRequest?: (method: string) => void;
    mcpCallResult?: CallToolResult;
    mcpCallStatus?: number;
    mcpResponseFormat?: "concise" | "detailed";
    mcpReadCalls?: boolean;
  } = {},
) {
  const linear = options.profile === "linear";
  const axiom = options.profile === "axiom";
  const notion = options.profile === "notion";
  const issuer = notion
    ? "https://mcp.notion.com"
    : axiom
      ? "https://authorization.axiom.co"
      : linear
        ? "https://mcp.linear.app"
        : "https://mcp.slack.com";
  const endpoint = axiom ? "https://mcp.axiom.co/mcp" : `${issuer}/mcp`;
  const resource = linear || axiom ? endpoint : issuer;
  const metadataUrl = `${new URL(endpoint).origin}/.well-known/oauth-protected-resource${linear || axiom ? "/mcp" : ""}`;
  const tokenUrl = axiom
    ? `${issuer}/oauth2/token`
    : linear || notion
      ? `${issuer}/token`
      : "https://slack.com/api/oauth.v2.user.access";
  const scopes =
    options.scopes ??
    (notion
      ? ["default"]
      : axiom
        ? ["openid", "offline_access"]
        : linear
          ? ["read"]
          : ["search:read.public"]);
  const registrationUrl = `${issuer}${axiom ? "/oauth2" : ""}/register`;
  const root =
    options.root ?? (await mkdtemp(path.join(tmpdir(), "pr-review-oauth-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const skillPath = path.join(home, "skills/fixture-audit/REVIEW.md");
  for (const directory of [
    bin,
    path.dirname(skillPath),
    path.join(home, ".codex"),
    path.join(home, ".claude/skills"),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(path.join(bin, "package.json"), '{"type":"commonjs"}');
  await writeFile(
    skillPath,
    "---\nname: fixture-audit\ndescription: Labeled deterministic backend fixture\n---\nUse [rubric](rubric.md) and read source.\n",
  );
  await writeFile(
    path.join(path.dirname(skillPath), "rubric.md"),
    "FROZEN RUBRIC",
  );
  await writeFile(
    path.join(home, ".codex/auth.json"),
    JSON.stringify(fixtureCredentials().codex),
  );
  const source = path.join(home, "synthetic-plugin.mcp.json");
  const native = {
    mcpServers: {
      slack: {
        type: "http",
        url: endpoint,
        oauth: {
          clientId: "synthetic-native-client-not-reused",
          callbackPort: 3118,
        },
      },
    },
  };
  await writeFile(
    source,
    JSON.stringify(
      notion
        ? { mcpServers: { notion: { type: "http", url: endpoint } } }
        : axiom
          ? { mcpServers: { axiom: { type: "http", url: endpoint } } }
          : linear
            ? { mcpServers: { "linear-server": native.mcpServers.slack } }
            : native,
    ),
  );
  const env = {
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    FIXTURE_LOG: path.join(root, "inert-calls.jsonl"),
  };
  const script = async (name: string, content: string) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${content}`);
    await chmod(file, 0o755);
  };
  await script(
    "gh",
    'require("node:fs").mkdirSync(process.argv[5], {recursive:true})',
  );
  await script(
    "git",
    'const args=process.argv.slice(2); if(args[0]==="rev-parse") process.stdout.write(args.at(-1)==="HEAD" ? "demo-head-sha-1" : args.at(-1).replace("^{commit}",""));',
  );
  const harness = await readFile(
    new URL("isolated-harness.cjs", import.meta.url),
    "utf8",
  );
  for (const name of ["claude", "codex", "pi"])
    await script(
      name,
      harness.replaceAll(
        "process.env.FIXTURE_LOG",
        JSON.stringify(env.FIXTURE_LOG),
      ),
    );
  for (const name of ["security", "docker"])
    await script(
      name,
      'process.stderr.write("INERT FIXTURE: host command denied"); process.exit(1)',
    );
  let port = options.port;
  if (!port) {
    const socket = createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, "127.0.0.1", resolve),
    );
    port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
  const app = loadConfig({
    demo: true,
    host: "127.0.0.1",
    port,
    dataDir: path.join(root, "data"),
    databasePath: path.join(root, "data/app.sqlite"),
    reviewer: { skillPath, model: null, additionalInstructions: "" },
  });
  const store = new MemoryCredentialStore();
  const operations: string[] = [];
  const requests: string[] = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> =
    [];
  const tokenAuthentication: Array<{
    hasClientSecret: boolean;
    hasAuthorizationHeader: boolean;
    hasVerifier: boolean;
    grantType: string | null;
  }> = [];
  const tokenBindings: Array<{
    redirectUri: string | null;
    clientId: string | null;
    resource: string | null;
    challenge: string;
  }> = [];
  const fetch: GuardedFetch = async (url, init = {}) => {
    const target = new URL(url);
    requests.push(target.href);
    if (target.href === metadataUrl) {
      operations.push("synthetic:resource-metadata");
      return Response.json({
        resource,
        authorization_servers: [issuer],
        ...(axiom ? {} : { scopes_supported: scopes }),
        ...options.resourceOverrides,
      });
    }
    if (target.pathname.includes("oauth-authorization-server")) {
      operations.push("synthetic:authorization-metadata");
      return Response.json({
        issuer,
        authorization_endpoint: axiom
          ? `${issuer}/oauth2/authorize`
          : linear || notion
            ? `${issuer}/authorize`
            : "https://slack.com/oauth/v2_user/authorize",
        token_endpoint: tokenUrl,
        ...(linear || axiom || notion
          ? { registration_endpoint: registrationUrl }
          : {}),
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: options.clientAuthMethods ?? [
          "client_secret_post",
        ],
        scopes_supported: scopes,
        authorization_response_iss_parameter_supported: true,
        ...options.metadataOverrides,
      });
    }
    if ((linear || axiom || notion) && target.href === registrationUrl) {
      operations.push("synthetic:register");
      const body = JSON.parse(String(init.body));
      return Response.json(
        { ...body, client_id: "synthetic-registered-client" },
        { status: 201 },
      );
    }
    if (target.href === tokenUrl) {
      operations.push("synthetic:token");
      const tokenBody = new URLSearchParams(String(init.body));
      tokenAuthentication.push({
        hasClientSecret: tokenBody.has("client_secret"),
        hasAuthorizationHeader: new Headers(init.headers).has("authorization"),
        hasVerifier: tokenBody.has("code_verifier"),
        grantType: tokenBody.get("grant_type"),
      });
      tokenBindings.push({
        redirectUri: tokenBody.get("redirect_uri"),
        clientId: tokenBody.get("client_id"),
        resource: tokenBody.get("resource"),
        challenge: createHash("sha256")
          .update(tokenBody.get("code_verifier") ?? "")
          .digest("base64url"),
      });
      if (
        options.clientAuthMethods?.length === 1 &&
        options.clientAuthMethods[0] === "none"
      ) {
        const params = new URLSearchParams(String(init.body));
        if (
          params.has("client_secret") ||
          new Headers(init.headers).has("authorization")
        )
          throw new Error("Synthetic public client must not send a secret");
      }
      return Response.json({
        access_token: "SYNTHETIC_ACCESS_CANARY",
        refresh_token: "SYNTHETIC_REFRESH_CANARY",
        expires_in: 3600,
        token_type: "Bearer",
        scope: scopes.join(" "),
        ...options.tokenOverrides,
      });
    }
    if (target.href === endpoint) {
      if (init.method === "GET") return new Response(null, { status: 405 });
      const request = JSON.parse(String(init.body));
      operations.push(`synthetic:${request.method}`);
      options.onMcpRequest?.(request.method);
      if (options.mcpStatus)
        return new Response("SYNTHETIC_PROVIDER_ERROR_CANARY", {
          status: options.mcpStatus,
          headers: {
            "www-authenticate":
              'Bearer error="insufficient_scope", scope="SYNTHETIC_UNAPPROVED_SCOPE"',
          },
        });
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (request.method === "tools/call") {
        toolCalls.push(request.params);
        if (options.mcpCallStatus)
          return new Response("SYNTHETIC_PROFILE_ERROR_CANARY", {
            status: options.mcpCallStatus,
          });
        if (
          !options.mcpCallResult ||
          !(options.mcpReadCalls
            ? [
                "slack_search_public",
                "slack_search_public_and_private",
                "slack_read_channel",
                "slack_read_thread",
                ...(linear ? ["get_issue", "list_issues"] : []),
                ...(notion ? ["notion-fetch"] : []),
                ...(axiom
                  ? ["listDatasets", "getDatasetFields", "queryDataset"]
                  : []),
              ].includes(request.params.name)
            : request.params.name === "slack_read_user_profile" &&
              JSON.stringify(request.params.arguments) ===
                JSON.stringify({
                  response_format: options.mcpResponseFormat ?? "concise",
                }))
        )
          throw new Error("Synthetic fixture forbids unapproved tool calls");
      }
      const result =
        request.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              serverInfo: options.mcpServerInfo ?? {
                name: notion
                  ? "synthetic-only-not-notion"
                  : axiom
                    ? "synthetic-only-not-axiom"
                    : linear
                      ? "synthetic-only-not-linear"
                      : "synthetic-only-not-slack",
                version: "1",
              },
              capabilities: { tools: {} },
            }
          : request.method === "tools/list"
            ? {
                ...(options.mcpNextCursor
                  ? { nextCursor: options.mcpNextCursor }
                  : {}),
                tools: options.mcpTools ?? [
                  {
                    name: "synthetic_unvetted_read",
                    inputSchema: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                    annotations: { readOnlyHint: true },
                  },
                ],
              }
            : request.method === "tools/call"
              ? options.mcpCallResult
              : null;
      if (!result) throw new Error("Synthetic fixture forbids tool calls");
      return Response.json(
        { jsonrpc: "2.0", id: request.id, result },
        { headers: { "mcp-session-id": "synthetic-session" } },
      );
    }
    throw new Error("Unexpected synthetic destination");
  };
  let service = await ReviewService.create(
    app,
    undefined,
    undefined,
    undefined,
    env,
    undefined,
    (db) =>
      new McpOAuth(
        db.sqlite,
        `http://127.0.0.1:${port}/api/mcp/oauth/callback`,
        store,
        undefined,
        fetch,
        true,
      ),
  );
  let server = createHttpServer(service, app);
  const listen = () =>
    new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  await listen();
  const base = `http://127.0.0.1:${port}`;
  const send = (
    route: string,
    body?: unknown,
    options: { origin?: string; cookie?: string; method?: string } = {},
  ) =>
    globalThis.fetch(base + route, {
      method: body === undefined ? "GET" : (options.method ?? "POST"),
      headers: {
        "content-type": "application/json",
        origin: options.origin ?? base,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  };
  return {
    root,
    home,
    app,
    env,
    base,
    source,
    native,
    store,
    operations,
    requests,
    toolCalls,
    tokenBindings,
    tokenAuthentication,
    skillPath,
    send,
    get service() {
      return service;
    },
    async restart() {
      await stop();
      service = await ReviewService.create(
        app,
        undefined,
        undefined,
        undefined,
        env,
        undefined,
        (db) =>
          new McpOAuth(
            db.sqlite,
            `${base}/api/mcp/oauth/callback`,
            store,
            undefined,
            fetch,
            true,
          ),
      );
      server = createHttpServer(service, app);
      await listen();
    },
    stop,
    async close() {
      await stop();
      if (!options.root) await rm(root, { recursive: true, force: true });
    },
  };
}

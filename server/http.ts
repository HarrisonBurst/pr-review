import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { CredentialStoreError } from "./credential-store.js";
import { OAuthCallbackError } from "./mcp-loopback.js";
import { OAuthScopeError } from "./mcp-oauth-scopes.js";

import {
  automationKeys,
  maxConcurrentReviewsRange,
  validConcurrentReviews,
  validModel,
  type HarnessModelDiscoveryRequest,
  automationOverrideKeys,
  type AutomationMode,
  type AutomationOverrides,
  type DraftUpdate,
  type LineRef,
  type QuestionRequest,
  type RevisionRequest,
  type SettingsUpdate,
} from "../shared/contracts.js";
import { AppConfig } from "./config.js";
import { ReviewService, ServiceError } from "./service.js";
import { repositoryParts } from "./util.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...jsonHeaders,
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof OAuthCallbackError || error instanceof OAuthScopeError) {
    sendJson(response, 409, { error: error.message, code: error.code });
    return;
  }
  if (error instanceof CredentialStoreError) {
    sendJson(response, 409, {
      error: error.message,
      code: `credential_store_${error.status}`,
    });
    return;
  }
  if (error instanceof ServiceError) {
    sendJson(response, error.status, {
      error: error.message,
      code: error.code,
    });
    return;
  }
  sendJson(response, 500, {
    error: error instanceof Error ? error.message : String(error),
    code: "internal_error",
  });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > 1_000_000)
    throw new ServiceError(413, "body_too_large", "request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000)
      throw new ServiceError(
        413,
        "body_too_large",
        "request body is too large",
      );
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError(
      400,
      "invalid_json",
      "request body must be valid JSON",
    );
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ServiceError(
      400,
      "invalid_body",
      "request body must be an object",
    );
  return value as Record<string, unknown>;
}

function stringBody(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string")
    throw new ServiceError(400, "invalid_body", `${key} must be a string`);
  return value[key] as string;
}

function positiveInteger(value: Record<string, unknown>, key: string): number {
  if (!Number.isInteger(value[key]) || Number(value[key]) < 1)
    throw new ServiceError(
      400,
      "invalid_body",
      `${key} must be a positive integer`,
    );
  return Number(value[key]);
}

function lineRefBody(value: unknown, key: string): LineRef {
  const ref = bodyObject(value);
  if (ref.side !== "LEFT" && ref.side !== "RIGHT")
    throw new ServiceError(
      400,
      "invalid_body",
      `${key}.side must be LEFT or RIGHT`,
    );
  return { side: ref.side, line: positiveInteger(ref, "line") };
}

function questionBody(value: Record<string, unknown>): QuestionRequest {
  const range = bodyObject(value.range);
  const optionalString = (key: string) => {
    if (value[key] === undefined || value[key] === null) return null;
    return stringBody(value, key);
  };
  return {
    mode: stringBody(value, "mode") as QuestionRequest["mode"],
    range: {
      path: stringBody(range, "path"),
      from: lineRefBody(range.from, "range.from"),
      to: lineRefBody(range.to, "range.to"),
      baseSha: stringBody(range, "baseSha"),
      headSha: stringBody(range, "headSha"),
    },
    question: optionalString("question") ?? "",
    parentId: optionalString("parentId"),
    draftId: optionalString("draftId"),
  };
}

function hostName(host: string): string {
  return host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
}

function allowedHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = hostName(value);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function protectRequest(request: IncomingMessage, config: AppConfig): void {
  if (!allowedHost(request.headers.host))
    throw new ServiceError(
      403,
      "host_not_allowed",
      "requests must use the loopback host",
    );
  if (!mutationMethods.has(request.method ?? "GET")) return;
  const origin = request.headers.origin;
  if (!origin) return;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ServiceError(403, "origin_not_allowed", "origin is not allowed");
  }
  if (
    url.protocol !== "http:" ||
    !allowedHost(url.host) ||
    ![String(config.port), "5173"].includes(url.port || "80")
  )
    throw new ServiceError(403, "origin_not_allowed", "origin is not allowed");
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const root = path.resolve(process.cwd(), "web", "dist");
  const requested = decodeURIComponent(
    new URL(request.url ?? "/", "http://localhost").pathname,
  );
  const candidate = path.resolve(
    root,
    `.${requested === "/" ? "/index.html" : requested}`,
  );
  if (!candidate.startsWith(`${root}${path.sep}`))
    throw new ServiceError(403, "path_not_allowed", "path is not allowed");
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": contentType(candidate),
      "cache-control": "no-cache",
    });
    createReadStream(candidate).pipe(response);
  } catch {
    if (requested !== "/") {
      const fallback = path.join(root, "index.html");
      try {
        const info = await stat(fallback);
        if (!info.isFile()) throw new Error("not a file");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        });
        createReadStream(fallback).pipe(response);
        return;
      } catch {}
    }
    sendJson(response, 404, {
      error: "web build not found",
      code: "web_not_built",
    });
  }
}

export function createHttpServer(
  service: ReviewService,
  config: AppConfig,
): http.Server {
  const server = http.createServer(async (request, response) => {
    try {
      protectRequest(request, config);
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host}`,
      );
      const pathname = requestUrl.pathname;
      const oauthBrowser =
        request.headers.cookie
          ?.split(";")
          .map((item) => item.trim())
          .find((item) => item.startsWith("pr-review-mcp-browser="))
          ?.slice("pr-review-mcp-browser=".length) ?? "";
      if (
        ["/api/mcp/oauth/callback", "/api/mcp/oauth/complete"].includes(
          pathname,
        ) &&
        request.method === "GET"
      ) {
        try {
          if (
            request.headers.origin &&
            request.headers.origin !== service.mcpOAuth.appOrigin
          )
            throw new Error("OAuth callback origin mismatch");
          const { id, status } = await service.completeOAuthCallback(
            requestUrl.searchParams,
            oauthBrowser,
            requestUrl.origin,
            pathname === "/api/mcp/oauth/complete",
          );
          if (
            status.scopeReview &&
            request.headers.accept?.includes("text/html")
          ) {
            const location = await service.mcpOAuth.reviewReturnUrl(
              id,
              oauthBrowser,
            );
            response.writeHead(303, {
              location,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            });
            response.end();
            return;
          }
          if (status.scopeReview?.status === "missing_required")
            throw new OAuthScopeError("oauth_scopes_missing");
          const pending = status.scopeReview?.status === "approval_required";
          response.writeHead(pending ? 202 : 200, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          response.end(
            pending
              ? "Additional OAuth capabilities need your exact approval. Return to Connections to view the local scope disclosure. No new credential has been persisted or made usable."
              : "OAuth completed. Return to Connections. Authentication is not a verified read or tool permission.",
          );
        } catch (error) {
          if (
            error instanceof CredentialStoreError ||
            error instanceof OAuthScopeError
          )
            throw error;
          throw new ServiceError(
            409,
            "oauth_callback_failed",
            "OAuth callback expired, was cancelled or failed validation. Return to Connections and explicitly reconnect.",
          );
        }
        return;
      }
      if (
        pathname === "/api/mcp/oauth/review-return" &&
        request.method === "POST"
      ) {
        const body = bodyObject(await readBody(request));
        if (
          Object.keys(body).length !== 1 ||
          typeof body.continuation !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            body.continuation,
          )
        )
          throw new OAuthScopeError("oauth_scope_consent_invalid");
        const result = await service.mcpOAuth
          .continueReview(
            body as unknown as import("../shared/contracts.js").McpOAuthReviewReturnRequest,
            oauthBrowser,
          )
          .catch(() => {
            throw new OAuthScopeError("oauth_scope_consent_invalid");
          });
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("x-content-type-options", "nosniff");
        sendJson(response, 200, result);
        return;
      }
      if (pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write("event: change\ndata: {}\n\n");
        const listener = (prId?: string) => {
          if (!response.writableEnded)
            response.write(
              `event: change\ndata: ${JSON.stringify(prId ? { prId } : {})}\n\n`,
            );
        };
        const remove = service.onChange(listener);
        const heartbeat = setInterval(() => {
          if (!response.writableEnded) response.write(": heartbeat\n\n");
        }, 20_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          remove();
        });
        return;
      }
      if (pathname.startsWith("/api/")) {
        const parts = pathname
          .slice(5)
          .split("/")
          .filter(Boolean)
          .map((part) => decodeURIComponent(part));
        if (
          request.method === "GET" &&
          parts.length === 1 &&
          parts[0] === "state"
        ) {
          sendJson(response, 200, service.getState());
          return;
        }
        if (
          request.method === "PATCH" &&
          parts.length === 2 &&
          parts[0] === "settings" &&
          parts[1] === "auto-submission"
        ) {
          sendJson(
            response,
            200,
            service.saveAutoSubmission(
              bodyObject(
                await readBody(request),
              ) as unknown as import("../shared/contracts.js").AutoSubmissionUpdate,
            ),
          );
          return;
        }
        if (
          request.method === "GET" &&
          parts.length === 2 &&
          parts[0] === "settings" &&
          parts[1] === "integrations"
        ) {
          sendJson(response, 200, service.getIntegrations());
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "models" &&
          parts[2] === "discover"
        ) {
          const body = bodyObject(await readBody(request));
          if (
            Object.keys(body).length !== 1 ||
            typeof body.harness !== "string" ||
            !["claude", "codex", "pi"].includes(body.harness)
          )
            throw new ServiceError(
              400,
              "invalid_model_discovery",
              "Expected only a supported harness. Discovery accepts no paths, commands, model selection or execution changes.",
            );
          sendJson(
            response,
            200,
            await service.discoverModels(
              body.harness as HarnessModelDiscoveryRequest["harness"],
            ),
          );
          return;
        }
        if (parts[0] === "settings" && parts[1] === "harness") {
          if (request.method === "GET" && parts.length === 2) {
            sendJson(response, 200, service.getHarness());
            return;
          }
          if (request.method === "PATCH" && parts.length === 2) {
            const body = bodyObject(await readBody(request));
            if (
              Object.keys(body).some(
                (key) =>
                  ![
                    "harness",
                    "workflow",
                    "confirmation",
                    "version",
                    "reviewer",
                    "additional",
                  ].includes(key),
              ) ||
              (body.version !== 2 && body.version !== 3) ||
              (body.version === 2 &&
                !["docker", "dangerous"].includes(body.workflow as string)) ||
              !body.reviewer ||
              (body.version === 3 &&
                (body.workflow !== "separated" ||
                  !body.reviewer ||
                  !Array.isArray(body.additional) ||
                  body.additional.length > 8 ||
                  body.additional.some(
                    (entry) =>
                      !entry ||
                      typeof entry !== "object" ||
                      Array.isArray(entry) ||
                      Object.keys(entry).some(
                        (key) => !["id", "harness", "model"].includes(key),
                      ) ||
                      typeof entry.id !== "string" ||
                      entry.id === "main" ||
                      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id) ||
                      !["claude", "codex", "pi"].includes(entry.harness) ||
                      !validModel(entry.model),
                  ) ||
                  new Set(body.additional.map((entry) => entry.id)).size !==
                    body.additional.length)) ||
              (body.version !== 3 && body.additional !== undefined) ||
              (body.reviewer !== undefined &&
                ((body.version !== 2 && body.version !== 3) ||
                  !body.reviewer ||
                  typeof body.reviewer !== "object" ||
                  Array.isArray(body.reviewer) ||
                  Object.keys(body.reviewer).some(
                    (key) => !["skillPath", "model"].includes(key),
                  ) ||
                  typeof (body.reviewer as any).skillPath !== "string" ||
                  (body.reviewer as any).skillPath.length > 1024 ||
                  !validModel((body.reviewer as any).model))) ||
              typeof body.harness !== "string" ||
              !["claude", "codex", "pi"].includes(body.harness) ||
              typeof body.workflow !== "string" ||
              !["separated", "docker", "dangerous"].includes(body.workflow) ||
              (body.confirmation !== undefined &&
                (body.workflow !== "dangerous" ||
                  typeof body.confirmation !== "string"))
            )
              throw new ServiceError(
                400,
                "invalid_harness",
                "Select a supported harness/workflow. Version 3 requires separated, a Main reviewer and 0-8 Additional entries with unique ids (not main), supported harnesses and model ids or null. Version 2 accepts only Docker/Dangerous. Historical shapes and source ids are unsupported.",
              );
            sendJson(
              response,
              200,
              await service.selectSkillHarness(
                {
                  ...(body.version === 2 || body.version === 3
                    ? { version: body.version, reviewer: body.reviewer }
                    : {}),
                  ...(body.version === 3
                    ? { additional: body.additional }
                    : {}),
                  harness: body.harness,
                  workflow: body.workflow,
                } as import("../shared/contracts.js").HarnessSelection,
                body.confirmation as string | undefined,
              ),
            );
            return;
          }
        }
        if (
          request.method === "POST" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "execution" &&
          parts[2] === "library-leaf"
        ) {
          const body = bodyObject(await readBody(request));
          if (
            typeof body.source !== "string" ||
            body.source.length > 4096 ||
            Object.keys(body).some((key) => key !== "source")
          )
            throw new ServiceError(
              400,
              "invalid_library_leaf",
              "Provide one declared installed skill leaf for metadata-only discovery",
            );
          sendJson(
            response,
            200,
            await service.discoverDockerLibraryLeaf(body.source),
          );
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "execution" &&
          parts[2] === "exclusions"
        ) {
          if (Object.keys(bodyObject(await readBody(request))).length)
            throw new ServiceError(
              400,
              "invalid_exclusion_discovery",
              "Exclusion discovery accepts an empty object",
            );
          sendJson(response, 200, {
            exclusions: await service.discoverDockerExclusions(),
            nativeSettingsUnchanged: true,
          });
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "execution" &&
          parts[2] === "inspect"
        ) {
          const body = bodyObject(await readBody(request));
          if (
            Object.keys(body).some(
              (key) =>
                ![
                  "harness",
                  "localConnections",
                  "exclusions",
                  "libraryLeaves",
                ].includes(key),
            ) ||
            !["claude", "codex", "pi"].includes(String(body.harness)) ||
            (body.localConnections !== undefined &&
              !Array.isArray(body.localConnections)) ||
            (body.exclusions !== undefined &&
              (!Array.isArray(body.exclusions) ||
                body.exclusions.some((id) => typeof id !== "string"))) ||
            (body.libraryLeaves !== undefined &&
              (!Array.isArray(body.libraryLeaves) ||
                body.libraryLeaves.some((id) => typeof id !== "string")))
          )
            throw new ServiceError(
              400,
              "invalid_docker_inspection",
              "Provide a saved Docker harness and optional explicit local connection choices",
            );
          sendJson(
            response,
            200,
            await service.inspectDocker(
              body as unknown as import("../shared/contracts.js").DockerInspectRequest,
            ),
          );
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "execution" &&
          parts[2] === "setup"
        ) {
          const body = bodyObject(await readBody(request));
          if (
            Object.keys(body).some(
              (key) => !["harness", "confirmation", "approval"].includes(key),
            ) ||
            typeof body.harness !== "string" ||
            !["claude", "codex", "pi"].includes(body.harness) ||
            typeof body.confirmation !== "string"
          )
            throw new ServiceError(
              400,
              "invalid_setup",
              "Provide the selected harness and explicit setup confirmation",
            );
          sendJson(
            response,
            200,
            await service.setupDocker(
              body.harness as import("../shared/contracts.js").HarnessId,
              body.confirmation,
              body.approval as
                | import("../shared/contracts.js").DockerCapabilityApproval
                | undefined,
            ),
          );
          return;
        }
        if (
          request.method === "GET" &&
          parts.length === 2 &&
          parts[0] === "settings" &&
          parts[1] === "execution"
        ) {
          sendJson(response, 200, service.getExecution());
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "execution" &&
          parts[2] === "check"
        ) {
          sendJson(response, 200, await service.checkExecution());
          return;
        }
        if (
          request.method === "POST" &&
          parts[0] === "settings" &&
          parts[1] === "integrations" &&
          parts.length === 3 &&
          ["discover", "import-native"].includes(parts[2])
        ) {
          const body = bodyObject(await readBody(request));
          if (parts[2] === "discover") {
            if (
              !["claude", "codex", "pi"].includes(String(body.harness)) ||
              (body.path !== undefined &&
                (typeof body.path !== "string" || body.path.length > 1024)) ||
              Object.keys(body).some(
                (key) => !["harness", "path"].includes(key),
              )
            )
              throw new ServiceError(
                400,
                "invalid_integration",
                "Expected harness and optional absolute native source path",
              );
            sendJson(
              response,
              200,
              await service.discoverIntegrations(
                body as unknown as import("../shared/contracts.js").NativeMcpDiscoveryRequest,
              ),
            );
          } else {
            if (
              typeof body.id !== "string" ||
              typeof body.profileId !== "string" ||
              !Array.isArray(body.scope) ||
              body.scope.some((value) => typeof value !== "string") ||
              Object.keys(body).some(
                (key) => !["id", "profileId", "scope"].includes(key),
              )
            )
              throw new ServiceError(
                400,
                "invalid_integration",
                "Expected discovered id, known profileId and explicit resource scope",
              );
            sendJson(
              response,
              200,
              service.importNativeIntegration(
                body as unknown as import("../shared/contracts.js").NativeMcpImportRequest,
              ),
            );
          }
          return;
        }
        if (
          request.method === "POST" &&
          parts[0] === "settings" &&
          parts[1] === "integrations" &&
          ((parts.length === 3 &&
            ["import-oauth", "add-oauth"].includes(parts[2])) ||
            (parts.length === 5 && parts[3] === "oauth"))
        ) {
          if (
            request.headers.origin !== service.mcpOAuth.appOrigin ||
            requestUrl.origin !== request.headers.origin
          )
            throw new ServiceError(
              403,
              "oauth_origin",
              "OAuth actions require the exact configured loopback app origin",
            );
          const body = bodyObject(await readBody(request));
          try {
            if (parts[2] === "add-oauth") {
              if (
                Object.keys(body).some((key) => key !== "profileId") ||
                typeof body.profileId !== "string"
              )
                throw new Error("Expected reviewed OAuth profileId only");
              sendJson(
                response,
                200,
                service.addOAuthIntegration(body.profileId),
              );
              return;
            }
            if (parts[2] === "import-oauth") {
              if (
                Object.keys(body).some(
                  (key) => !["id", "profileId"].includes(key),
                ) ||
                typeof body.id !== "string" ||
                typeof body.profileId !== "string"
              )
                throw new Error("Expected discovered id and OAuth profileId");
              sendJson(
                response,
                200,
                await service.importOAuthIntegration(body.id, body.profileId),
              );
              return;
            }
            const [id, action] = [parts[2], parts[4]];
            if (
              ![
                "discover",
                "configure",
                "register",
                "connect",
                "cancel",
                "disconnect",
                "scope-preview",
                "accept-scopes",
              ].includes(action)
            )
              throw new Error("Unsupported OAuth action");
            const fields =
              action === "accept-scopes"
                ? ["previewId", "generation", "additionalScopes", "consent"]
                : action === "configure"
                  ? [
                      "clientId",
                      "clientAuthMethod",
                      "clientSecret",
                      "scopes",
                      "discoveryDigest",
                      "redirectUri",
                    ]
                  : action === "register"
                    ? [
                        "consent",
                        "clientAuthMethod",
                        "scopes",
                        "discoveryDigest",
                        "redirectUri",
                      ]
                    : [];
            if (Object.keys(body).some((key) => !fields.includes(key)))
              throw new Error("Unknown OAuth action field");
            if (!["cancel", "disconnect"].includes(action))
              await service.requireOAuthConnection(id);
            if (action === "scope-preview") {
              response.setHeader("referrer-policy", "no-referrer");
              response.setHeader("x-content-type-options", "nosniff");
              sendJson(
                response,
                200,
                await service.mcpOAuth.scopePreview(id, oauthBrowser),
              );
              return;
            }
            service.invalidateOAuthGrants(id);
            let result: unknown;
            if (action === "accept-scopes")
              result = await service.mcpOAuth.approveScopes(
                id,
                oauthBrowser,
                body as unknown as import("../shared/contracts.js").McpOAuthScopeApproval,
              );
            else if (action === "discover")
              result = await service.mcpOAuth.discover(id);
            else if (action === "configure")
              result = await service.mcpOAuth.configure(
                id,
                body as unknown as import("../shared/contracts.js").McpOAuthConfigureRequest,
              );
            else if (action === "register")
              result = await service.mcpOAuth.register(
                id,
                body as unknown as import("../shared/contracts.js").McpOAuthRegistrationRequest,
              );
            else if (action === "cancel") result = service.mcpOAuth.cancel(id);
            else if (action === "disconnect")
              result = await service.mcpOAuth.disconnect(id);
            else {
              const browser = /^[a-f0-9]{64}$/.test(oauthBrowser)
                ? oauthBrowser
                : randomBytes(32).toString("hex");
              result = await service.mcpOAuth.connect(id, browser);
              response.setHeader(
                "set-cookie",
                `pr-review-mcp-browser=${browser}; HttpOnly; SameSite=Lax; Path=/api/; Max-Age=300`,
              );
            }
            service.invalidateOAuthGrants(id);
            sendJson(response, 200, result);
          } catch (error) {
            if (
              error instanceof CredentialStoreError ||
              error instanceof OAuthCallbackError ||
              error instanceof OAuthScopeError ||
              error instanceof ServiceError
            )
              throw error;
            throw new ServiceError(
              409,
              "oauth_unavailable",
              "OAuth action failed or is unsupported. Check discovery, client configuration, storage and current source bindings. No secrets or provider errors are returned.",
            );
          }
          return;
        }
        if (
          request.method === "POST" &&
          parts[0] === "settings" &&
          parts[1] === "integrations" &&
          parts.length === 4 &&
          parts[3] === "load-tools"
        ) {
          if (Object.keys(bodyObject(await readBody(request))).length)
            throw new ServiceError(
              400,
              "invalid_integration",
              "Load tools accepts an empty object",
            );
          sendJson(response, 200, await service.loadIntegrationTools(parts[2]));
          return;
        }
        if (
          request.method === "PATCH" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "integrations"
        ) {
          const body = bodyObject(await readBody(request));
          if (
            Object.keys(body).some(
              (key) => !["enabled", "allowedTools"].includes(key),
            )
          )
            throw new ServiceError(
              400,
              "invalid_integration",
              "Only enabled and allowedTools can be updated; source identities require explicit import",
            );
          if (body.enabled !== undefined && typeof body.enabled !== "boolean")
            throw new ServiceError(
              400,
              "invalid_integration",
              "enabled must be a boolean",
            );
          if (
            body.allowedTools !== undefined &&
            (!Array.isArray(body.allowedTools) ||
              !body.allowedTools.every(
                (value) => typeof value === "string" && value.length <= 128,
              ))
          )
            throw new ServiceError(
              400,
              "invalid_integration",
              "allowedTools must be an array of tool ids",
            );
          sendJson(
            response,
            200,
            service.updateIntegration(parts[2], {
              ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
              ...(body.allowedTools === undefined
                ? {}
                : { allowedTools: body.allowedTools as string[] }),
            }),
          );
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 4 &&
          parts[0] === "settings" &&
          parts[1] === "integrations" &&
          parts[3] === "test"
        ) {
          sendJson(response, 200, await service.testIntegration(parts[2]));
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 3 &&
          parts[0] === "settings" &&
          parts[1] === "integrations" &&
          parts[2] === "import-read"
        ) {
          const body = bodyObject(await readBody(request));
          if (
            typeof body.path !== "string" ||
            body.path.length > 1024 ||
            Object.keys(body).some((key) => key !== "path")
          )
            throw new ServiceError(
              400,
              "invalid_integration",
              "Provide only an explicit read-provider manifest path",
            );
          sendJson(response, 200, await service.importReadProviders(body.path));
          return;
        }
        if (
          request.method === "PATCH" &&
          parts.length === 1 &&
          parts[0] === "settings"
        ) {
          const body = bodyObject(await readBody(request));
          const update: SettingsUpdate = {};
          if (body.repository !== undefined) {
            if (typeof body.repository !== "string")
              throw new ServiceError(
                400,
                "invalid_repository",
                "repository must be a string",
              );
            if (body.repository) repositoryParts(body.repository);
            update.repository = body.repository;
          }
          if (body.automation !== undefined) {
            const automation = bodyObject(body.automation);
            update.automation = {};
            for (const key of automationKeys) {
              if (automation[key] === undefined) continue;
              if (typeof automation[key] !== "boolean")
                throw new ServiceError(
                  400,
                  "invalid_settings",
                  `automation.${key} must be a boolean`,
                );
              update.automation[key] = automation[key] as boolean;
            }
          }
          if (body.pollIntervalSeconds !== undefined) {
            if (
              !Number.isInteger(body.pollIntervalSeconds) ||
              Number(body.pollIntervalSeconds) < 5 ||
              Number(body.pollIntervalSeconds) > 86_400
            )
              throw new ServiceError(
                400,
                "invalid_settings",
                "pollIntervalSeconds must be between 5 and 86400",
              );
            update.pollIntervalSeconds = Number(body.pollIntervalSeconds);
          }
          if (body.maxConcurrentReviews !== undefined) {
            if (!validConcurrentReviews(body.maxConcurrentReviews))
              throw new ServiceError(
                400,
                "invalid_settings",
                `maxConcurrentReviews must be an integer between ${maxConcurrentReviewsRange.min} and ${maxConcurrentReviewsRange.max}`,
              );
            update.maxConcurrentReviews = body.maxConcurrentReviews;
          }
          sendJson(response, 200, service.updateSettings(update));
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 1 &&
          parts[0] === "sync"
        ) {
          try {
            await service.sync();
          } catch (error) {
            if (error instanceof ServiceError && error.status < 500)
              throw error;
          }
          sendJson(response, 200, service.getState());
          return;
        }
        if (
          request.method === "POST" &&
          parts.length === 2 &&
          parts[0] === "prs" &&
          parts[1] === "import"
        ) {
          const body = bodyObject(await readBody(request));
          sendJson(
            response,
            200,
            await service.importPullRequest(stringBody(body, "url")),
          );
          return;
        }
        if (parts[0] === "prs" && parts.length >= 2) {
          const prId = parts[1];
          if (request.method === "GET" && parts.length === 2) {
            sendJson(response, 200, service.getDetail(prId));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 5 &&
            parts[2] === "jobs" &&
            (parts[4] === "unqueue" || parts[4] === "cancel")
          ) {
            const body = bodyObject(await readBody(request));
            if (
              typeof body.runId !== "string" ||
              typeof body.headSha !== "string" ||
              (body.confirmation !== undefined &&
                typeof body.confirmation !== "string") ||
              Object.keys(body).some(
                (key) => !["runId", "headSha", "confirmation"].includes(key),
              )
            )
              throw new ServiceError(
                400,
                "invalid_review_job_action",
                "Exact observed run and head are required",
              );
            const detail = service.reviewJobAction(
              prId,
              parts[3],
              parts[4],
              body as unknown as import("../shared/contracts.js").ReviewJobAction,
            );
            sendJson(response, parts[4] === "cancel" ? 202 : 200, detail);
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 3 &&
            parts[2] === "review"
          ) {
            sendJson(response, 202, await service.manualReview(prId));
            return;
          }
          if (
            request.method === "PATCH" &&
            parts.length === 3 &&
            parts[2] === "automation"
          ) {
            const body = bodyObject(await readBody(request));
            const overrides: Partial<AutomationOverrides> = {};
            for (const key of automationOverrideKeys) {
              if (body[key] === undefined) continue;
              if (!["inherit", "on", "off"].includes(String(body[key])))
                throw new ServiceError(
                  400,
                  "invalid_body",
                  `${key} must be inherit, on, or off`,
                );
              overrides[key] = body[key] as AutomationMode;
            }
            sendJson(response, 200, service.updateAutomation(prId, overrides));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 3 &&
            parts[2] === "check"
          ) {
            sendJson(response, 200, await service.checkFreshness(prId));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 4 &&
            parts[2] === "draft" &&
            parts[3] === "edit-intent"
          ) {
            const body = bodyObject(await readBody(request));
            if (
              Object.keys(body).some(
                (key) => !["draftId", "version"].includes(key),
              ) ||
              typeof body.draftId !== "string" ||
              !Number.isInteger(body.version) ||
              Number(body.version) < 1
            )
              throw new ServiceError(
                400,
                "invalid_draft",
                "Invalid draft edit intent",
              );
            sendJson(
              response,
              200,
              service.editIntent(
                prId,
                body as unknown as import("../shared/contracts.js").DraftEditIntent,
              ),
            );
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 4 &&
            parts[2] === "auto-submission"
          ) {
            const body = bodyObject(await readBody(request));
            if (parts[3] === "check")
              throw new ServiceError(
                404,
                "not_found",
                "Independent classifier checks are retired",
              );
            if (parts[3] === "reconcile" && Object.keys(body).length === 0) {
              sendJson(
                response,
                200,
                await service.reconcileAutoSubmission(prId),
              );
              return;
            }
            if (
              !Number.isInteger(body.expectedVersion) ||
              Number(body.expectedVersion) < 0
            )
              throw new ServiceError(
                400,
                "invalid_auto_submission",
                "Invalid hold version",
              );
            if (parts[3] === "acknowledge") {
              const source = body.source as Record<string, unknown> | null;
              if (
                Object.keys(body).some(
                  (key) =>
                    ![
                      "expectedVersion",
                      "evidenceId",
                      "source",
                      "action",
                    ].includes(key),
                ) ||
                typeof body.evidenceId !== "string" ||
                !["dismiss", "resolve"].includes(String(body.action)) ||
                !source ||
                typeof source !== "object" ||
                Object.keys(source).length !== 3 ||
                typeof source.id !== "string" ||
                typeof source.version !== "string" ||
                !["comment", "review", "inline_comment"].includes(
                  String(source.kind),
                )
              )
                throw new ServiceError(
                  400,
                  "invalid_auto_submission",
                  "Invalid source acknowledgment",
                );
              sendJson(
                response,
                200,
                service.acknowledgeHumanReview(
                  prId,
                  body as unknown as import("../shared/contracts.js").HumanReviewAcknowledgment,
                ),
              );
              return;
            }
            if (
              parts[3] === "re-enable" &&
              Object.keys(body).every((key) =>
                ["expectedVersion", "confirmation"].includes(key),
              )
            ) {
              sendJson(
                response,
                200,
                await service.reenableAutoSubmission(
                  prId,
                  body as unknown as import("../shared/contracts.js").AutoSubmissionReenable,
                ),
              );
              return;
            }
            throw new ServiceError(
              400,
              "invalid_auto_submission",
              "Invalid automatic submission action",
            );
          }
          if (
            request.method === "PUT" &&
            parts.length === 3 &&
            parts[2] === "draft"
          ) {
            const body = bodyObject(await readBody(request));
            const update = body as unknown as DraftUpdate;
            if (
              typeof update.draftId !== "string" ||
              !Number.isInteger(update.version) ||
              typeof update.body !== "string" ||
              !Array.isArray(update.findings) ||
              !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(
                update.verdict,
              )
            )
              throw new ServiceError(
                400,
                "invalid_draft",
                "draft update is invalid",
              );
            sendJson(response, 200, service.updateDraft(prId, update));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 3 &&
            parts[2] === "drafts"
          ) {
            bodyObject(await readBody(request));
            sendJson(response, 201, service.createManualDraft(prId));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 3 &&
            parts[2] === "questions"
          ) {
            const body = bodyObject(await readBody(request));
            sendJson(response, 202, service.ask(prId, questionBody(body)));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 5 &&
            parts[2] === "questions" &&
            parts[4] === "cancel"
          ) {
            sendJson(response, 200, service.cancelQuestion(prId, parts[3]));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 5 &&
            parts[2] === "questions" &&
            parts[4] === "retry"
          ) {
            sendJson(response, 202, service.retryQuestion(prId, parts[3]));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 3 &&
            parts[2] === "revise"
          ) {
            const body = bodyObject(await readBody(request));
            if (!Number.isInteger(body.draftVersion))
              throw new ServiceError(
                400,
                "invalid_body",
                "draftVersion must be an integer",
              );
            const revision: RevisionRequest = {
              draftId: stringBody(body, "draftId"),
              draftVersion: Number(body.draftVersion),
              instructions: stringBody(body, "instructions"),
              findingIds:
                body.findingIds === undefined
                  ? undefined
                  : Array.isArray(body.findingIds) &&
                      body.findingIds.every(
                        (value) => typeof value === "string",
                      )
                    ? (body.findingIds as string[])
                    : (() => {
                        throw new ServiceError(
                          400,
                          "invalid_body",
                          "findingIds must be an array of strings",
                        );
                      })(),
            };
            sendJson(response, 202, service.revise(prId, revision));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 5 &&
            parts[2] === "proposals" &&
            parts[4] === "apply"
          ) {
            const body = bodyObject(await readBody(request));
            sendJson(
              response,
              200,
              service.applyProposal(
                prId,
                parts[3],
                positiveInteger(body, "expectedVersion"),
              ),
            );
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 5 &&
            parts[2] === "proposals" &&
            parts[4] === "reject"
          ) {
            sendJson(response, 200, service.rejectProposal(prId, parts[3]));
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 3 &&
            parts[2] === "preview"
          ) {
            const body = bodyObject(await readBody(request));
            sendJson(
              response,
              200,
              await service.preview(
                prId,
                stringBody(body, "draftId"),
                positiveInteger(body, "draftVersion"),
              ),
            );
            return;
          }
          if (
            request.method === "POST" &&
            parts.length === 3 &&
            parts[2] === "submit"
          ) {
            const body = bodyObject(await readBody(request));
            const previewId = stringBody(body, "previewId");
            const detail = await service.submit(prId, previewId);
            sendJson(
              response,
              200,
              detail.submissions.find(
                (submission) => submission.previewId === previewId,
              )!,
            );
            return;
          }
        }
        throw new ServiceError(404, "not_found", "route not found");
      }
      await serveStatic(request, response);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });
  return server;
}

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ReadProviders,
  readSchemas,
  type ProviderHttp,
  type ProviderHttpRequest,
} from "../../read-providers.js";
const pageId = "11111111-1111-1111-1111-111111111111";
const secret = "synthetic-business-credential-never-project";
export async function providerFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-providers-"));
  const authPath = path.join(root, "existing-auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ selected: secret, unrelated: "unrelated-fixture-secret" }),
  );
  const manifestPath = path.join(root, "read-providers.json");
  const entries = [
    {
      id: "github",
      provider: "github",
      endpoint: "https://api.github.com",
      scope: ["fixture/repository"],
    },
    {
      id: "linear",
      provider: "linear",
      endpoint: "https://api.linear.app/graphql",
      scope: ["FIX-42"],
    },
    {
      id: "notion",
      provider: "notion",
      endpoint: "https://api.notion.com/v1",
      scope: [pageId],
    },
    {
      id: "custom:documents",
      provider: "documents",
      endpoint: "https://documents.example.invalid/mcp",
      scope: ["fixture-document"],
      vettedDefinition: "pr-review-documents/1",
    },
  ].map((entry) => ({
    ...entry,
    auth: {
      kind: "json-value",
      path: authPath,
      keys: ["selected"],
      format: "bearer",
    },
  }));
  const manifest = { version: 1, readProviders: entries };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const requests: Array<{ path: string; method: string; body: any }> = [];
  let mode = "normal";
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const part of request) chunks.push(part);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: request.url!, method: request.method!, body });
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    response.setHeader("content-type", "application/json");
    if (mode === "hang") return;
    if (mode === "leak") return response.end(JSON.stringify({ token: secret }));
    if (mode === "large")
      return response.end(JSON.stringify({ text: "x".repeat(210000) }));
    if (request.url!.startsWith("/api.github.com/user"))
      response.end(JSON.stringify({ id: 42, login: "fixture" }));
    else if (request.url!.includes("/pulls/"))
      response.end(
        JSON.stringify(
          request.url!.includes("?")
            ? []
            : {
                number: 42,
                title: "Synthetic PR",
                body: "Untrusted PR text",
                head: { sha: "fixture-head" },
                base: { sha: "fixture-base" },
                state: "open",
              },
        ),
      );
    else if (request.url!.startsWith("/api.linear.app/graphql")) {
      assert.equal(
        body.query,
        "query ReadIssue($id: String!) { issue(id: $id) { id identifier title description url state { name } } }",
      );
      response.end(
        JSON.stringify({
          data: {
            issue: {
              id: "fixture-issue",
              identifier: body.variables.id,
              title: "Synthetic issue",
              description: "Untrusted ticket content",
              url: "https://linear.app/fixture",
              state: { name: "Open" },
            },
          },
        }),
      );
    } else if (request.url!.includes("/api.notion.com/v1/pages/"))
      response.end(
        JSON.stringify({
          object: "page",
          id: pageId,
          properties: {},
          url: "https://notion.so/fixture",
          archived: false,
        }),
      );
    else if (request.url!.includes("/api.notion.com/v1/blocks/"))
      response.end(
        JSON.stringify({ object: "list", results: [], has_more: false }),
      );
    else if (request.url === "/documents.example.invalid/mcp") {
      assert.equal(request.headers["mcp-protocol-version"], "2025-03-26");
      if (body.method === "notifications/initialized") {
        response.statusCode = 202;
        response.end();
        return;
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities:
                mode === "capabilities"
                  ? { tools: {}, resources: {} }
                  : { tools: {} },
              serverInfo: {
                name: mode === "identity" ? "impostor" : "pr-review-documents",
                version: "1",
              },
            }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "documents_get",
                    inputSchema:
                      mode === "schema"
                        ? { type: "object" }
                        : readSchemas.documents,
                    ...(mode === "mutation"
                      ? {
                          annotations: {
                            readOnlyHint: true,
                            destructiveHint: true,
                          },
                        }
                      : {}),
                  },
                ],
              }
            : {
                content: [
                  { type: "text", text: "Untrusted synthetic document" },
                ],
              };
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } else {
      response.statusCode = 403;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport: ProviderHttp = async (input: ProviderHttpRequest) => {
    const original = new URL(input.url);
    const response = await fetch(
      `${base}/${original.hostname}${original.pathname}${original.search}`,
      {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("Synthetic provider rejected request");
    return input.notification && response.status === 202
      ? null
      : response.json();
  };
  const providers = new ReadProviders(transport, true);
  return {
    root,
    authPath,
    manifestPath,
    manifest,
    requests,
    providers,
    mode: (next: string) => {
      mode = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

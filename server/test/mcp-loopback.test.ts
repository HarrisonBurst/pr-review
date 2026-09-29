import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { oauthFixture } from "./fixtures/oauth-context.js";
import { integrationSnapshot } from "../integrations.js";
import type { McpOAuthDiagnostic } from "../mcp-oauth.js";

async function listen(server = createServer(), host = "127.0.0.1", port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ipv6Only: true }, resolve);
  });
  return { server, port: (server.address() as { port: number }).port };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function fixedFixture(
  host = "localhost",
  options: Parameters<typeof oauthFixture>[0] = {},
) {
  const reserved = await listen();
  const redirectUri = `http://${host}:${reserved.port}/callback`;
  await stop(reserved.server);
  const f = await oauthFixture({ ...options, clientAuthMethods: ["none"] });
  const catalog = await (
    await f.send("/api/settings/integrations/discover", {
      harness: "claude",
      path: f.source,
    })
  ).json();
  const id = catalog.connections[0].config.id as string;
  await f.send("/api/settings/integrations/import-oauth", {
    id,
    profileId: "slack-mcp/1",
  });
  const prefix = `/api/settings/integrations/${id}/oauth/`;
  const discovery = await (await f.send(prefix + "discover", {})).json();
  const configuration = {
    clientId: "synthetic-fixed-client",
    clientAuthMethod: "none",
    scopes: ["search:read.public"],
    discoveryDigest: discovery.discovery.digest,
    redirectUri,
  };
  const configure = (overrides = {}) =>
    f.send(prefix + "configure", { ...configuration, ...overrides });
  const connect = async () => {
    const response = await f.send(prefix + "connect", {});
    assert.equal(response.status, 200);
    const value = await response.json();
    const authorization = new URL(value.authorizationUrl);
    const callback = new URL(redirectUri);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "synthetic-fixed-code",
      iss: "https://mcp.slack.com",
    }).toString();
    return {
      authorization,
      callback,
      value,
      cookie: response.headers.get("set-cookie")!.split(";")[0],
    };
  };
  return {
    ...f,
    get service() {
      return f.service;
    },
    id,
    prefix,
    redirectUri,
    port: reserved.port,
    configuration,
    configure,
    connect,
  };
}
async function nativeRequest(
  url: URL,
  options: {
    method?: string;
    host?: string | string[];
    origin?: string;
    body?: string;
  } = {},
) {
  return new Promise<{
    status: number;
    location?: string;
    body: string;
    headers: Record<string, unknown>;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        setHost: false,
        headers: [
          ...(Array.isArray(options.host)
            ? options.host
            : [options.host ?? url.host]
          ).flatMap((host) => ["Host", host]),
          ...(options.origin ? ["Origin", options.origin] : []),
          ...(options.body
            ? ["Content-Length", String(Buffer.byteLength(options.body))]
            : []),
        ],
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            location: response.headers.location,
            body,
            headers: response.headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}
async function absent(port: number, host = "127.0.0.1") {
  const probe = await listen(createServer(), host.replace(/[\[\]]/g, ""), port);
  await stop(probe.server);
}

test("fixed callback is explicit, canonical, persistent and inert until Connect", async () => {
  const f = await fixedFixture();
  try {
    for (const redirectUri of [
      "https://localhost:4111/callback",
      "http://example.com:4111/callback",
      "http://0.0.0.0:4111/callback",
      "http://127.1:4111/callback",
      "http://LOCALHOST:4111/callback",
      "http://localhost/callback",
      "http://localhost:80/callback",
      "http://localhost:0/callback",
      "http://localhost:65536/callback",
      "http://user@localhost:4111/callback",
      "http://localhost:4111/callback?x=1",
      "http://localhost:4111/callback#x",
      "http://localhost:4111/a/../callback",
      "http://localhost:4111/%63allback",
      "http://localhost:4111//callback",
      `${f.base}/callback`,
      f.base.replace("127.0.0.1", "localhost") + "/callback",
      null,
    ]) {
      const response = await f.configure({ redirectUri });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "oauth_callback_invalid");
    }
    assert.equal(f.store.values.size, 0);
    assert.equal((await f.configure()).status, 200);
    const preserved = await f.configure({ redirectUri: undefined });
    assert.equal(preserved.status, 200);
    assert.equal((await preserved.json()).redirectUri, f.redirectUri);
    await absent(f.port);
    await f.restart();
    const status = f.service.mcpOAuth.status(f.id);
    assert.equal(status.redirectUri, f.redirectUri);
    assert.equal(status.appRedirectUri, `${f.base}/api/mcp/oauth/callback`);
    assert.equal(status.authenticated, false);
    await f.send("/api/settings/integrations");
    await absent(f.port);
    assert.equal(
      (
        await f.send(
          f.prefix + "connect",
          {},
          { origin: new URL(f.redirectUri).origin },
        )
      ).status,
      403,
    );
    assert.equal(f.tokenBindings.length, 0);
  } finally {
    await f.close();
  }
});

test("fixed loopback stages once then requires the original app browser before exact PKCE exchange", async () => {
  const f = await fixedFixture();
  try {
    assert.equal((await f.configure()).status, 200);
    const c = await f.connect();
    assert.equal(
      c.authorization.searchParams.get("redirect_uri"),
      f.redirectUri,
    );
    assert.equal(
      c.authorization.searchParams.get("client_id"),
      f.configuration.clientId,
    );
    assert.equal(
      c.authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.equal(
      c.authorization.searchParams.get("resource"),
      "https://mcp.slack.com",
    );
    assert.equal(
      (
        await f.send(
          `/api/mcp/oauth/callback?${c.callback.searchParams}`,
          undefined,
          { cookie: c.cookie },
        )
      ).status,
      409,
    );
    const staged = await nativeRequest(c.callback);
    assert.equal(staged.status, 303);
    assert.equal(staged.headers["referrer-policy"], "no-referrer");
    assert.equal(staged.headers["cache-control"], "no-store");
    assert.equal(f.tokenBindings.length, 0);
    assert.doesNotMatch(
      JSON.stringify(staged),
      /synthetic-fixed-code|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|code_verifier/,
    );
    assert.ok(
      staged.location!.startsWith(`${f.base}/api/mcp/oauth/complete?receipt=`),
    );
    await absent(f.port);
    await absent(f.port, "[::1]");
    const url = new URL(staged.location!);
    const route = url.pathname + url.search;
    for (const options of [
      {},
      { cookie: "pr-review-mcp-browser=" + "a".repeat(64) },
      { cookie: c.cookie, origin: "http://localhost:9999" },
    ])
      assert.equal((await f.send(route, undefined, options)).status, 409);
    assert.equal(
      (
        await f.send(route + "&receipt=duplicate", undefined, {
          cookie: c.cookie,
        })
      ).status,
      409,
    );
    assert.equal(f.tokenBindings.length, 0);
    const wrongHost = await nativeRequest(new URL(`${f.base}${route}`), {
      host: new URL(f.base).host.replace("127.0.0.1", "localhost"),
    });
    assert.equal(wrongHost.status, 409);
    const completed = await f.send(route, undefined, { cookie: c.cookie });
    assert.equal(completed.status, 200);
    assert.doesNotMatch(
      await completed.text(),
      /synthetic-fixed-code|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH/,
    );
    assert.deepEqual(f.tokenBindings, [
      {
        redirectUri: f.redirectUri,
        clientId: f.configuration.clientId,
        resource: "https://mcp.slack.com",
        challenge: c.authorization.searchParams.get("code_challenge"),
      },
    ]);
    assert.equal(
      (await f.send(route, undefined, { cookie: c.cookie })).status,
      409,
    );
    assert.equal(f.service.mcpOAuth.status(f.id).authenticated, true);
    const catalog = await (await f.send("/api/settings/integrations")).json();
    assert.equal(catalog.connections[0].config.enabled, false);
    assert.deepEqual(catalog.connections[0].config.allowedTools, []);
    const serialized = JSON.stringify(
      f.service.db.sqlite.prepare("select state_json from mcp_oauth").all(),
    );
    assert.doesNotMatch(
      serialized,
      /synthetic-fixed-code|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|receipt|verifier/,
    );
    assert.ok(!serialized.includes(url.searchParams.get("receipt")!));
    await f.restart();
    assert.equal(f.service.mcpOAuth.status(f.id).redirectUri, f.redirectUri);
    await absent(f.port);
  } finally {
    await f.close();
  }
});

test("listener refuses wrong method, exact host/path/origin, issuer, duplicate and expanded response fields", async () => {
  const f = await fixedFixture();
  try {
    await f.configure();
    const c = await f.connect();
    for (const options of [
      { method: "POST" },
      { method: "HEAD" },
      { host: `127.0.0.1:${f.port}` },
      { host: "attacker.invalid" },
      { host: [c.callback.host, "attacker.invalid"] },
      { body: "x" },
      { origin: f.base },
      { origin: "https://attacker.invalid" },
    ])
      assert.equal((await nativeRequest(c.callback, options)).status, 409);
    for (const change of [
      (u: URL) => {
        u.pathname = "/other";
      },
      (u: URL) => {
        u.pathname = "//callback";
      },
      (u: URL) => {
        u.searchParams.append("state", "duplicate");
      },
      (u: URL) => {
        u.searchParams.set("state", "unsolicited");
      },
      (u: URL) => {
        u.searchParams.set("iss", "https://attacker.invalid");
      },
      (u: URL) => {
        u.searchParams.delete("iss");
      },
      (u: URL) => {
        u.searchParams.set("scope", "write:any");
      },
      (u: URL) => {
        u.searchParams.set("error", "denied");
      },
      (u: URL) => {
        u.searchParams.set("code", "x".repeat(8193));
      },
    ]) {
      const url = new URL(c.callback);
      change(url);
      const response = await nativeRequest(url);
      assert.equal(response.status, 409);
      assert.doesNotMatch(
        response.body,
        /synthetic-fixed-code|attacker|write:any/,
      );
    }
    assert.equal(f.tokenBindings.length, 0);
    assert.equal((await nativeRequest(c.callback)).status, 303);
    await absent(f.port);
    await f.send(f.prefix + "cancel", {});
  } finally {
    await f.close();
  }
});

test("busy ports never get taken over, including localhost IPv6; cancel and shutdown release owned listeners", async () => {
  const f = await fixedFixture();
  let occupied: Server | undefined;
  try {
    await f.configure();
    for (const host of ["127.0.0.1", "::1"]) {
      occupied = (
        await listen(
          createServer((_q, r) => r.end("owned occupied fixture")),
          host,
          f.port,
        )
      ).server;
      const failed = await f.send(f.prefix + "connect", {});
      assert.equal(failed.status, 409);
      assert.equal((await failed.json()).code, "oauth_callback_unavailable");
      assert.equal(
        await (
          await fetch(`http://${host === "::1" ? "[::1]" : host}:${f.port}`)
        ).text(),
        "owned occupied fixture",
      );
      assert.equal(f.service.mcpOAuth.status(f.id).state, "disconnected");
      await stop(occupied);
      occupied = undefined;
      await absent(f.port);
    }
    await f.connect();
    await f.send(f.prefix + "cancel", {});
    await absent(f.port);
    await absent(f.port, "[::1]");
    await f.connect();
    await f.service.mcpOAuth.close();
    await absent(f.port);
    await absent(f.port, "[::1]");
    assert.equal(f.tokenBindings.length, 0);
  } finally {
    if (occupied) await stop(occupied);
    await f.close();
  }
});

test("expiry closes listeners and expires staged receipts without exchanging tokens", async (t) => {
  const f = await fixedFixture("127.0.0.1");
  try {
    await f.configure();
    await f.connect();
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    await f.send(f.prefix + "cancel", {});
    await f.connect();
    t.mock.timers.tick(300001);
    assert.equal(f.service.mcpOAuth.status(f.id).state, "reconnect_required");
    t.mock.timers.reset();
    await absent(f.port);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const c = await f.connect();
    const staged = await nativeRequest(c.callback);
    assert.equal(staged.status, 303);
    t.mock.timers.tick(60001);
    assert.equal(f.service.mcpOAuth.status(f.id).state, "reconnect_required");
    t.mock.timers.reset();
    const receipt = new URL(staged.location!);
    assert.equal(
      (
        await f.send(receipt.pathname + receipt.search, undefined, {
          cookie: c.cookie,
        })
      ).status,
      409,
    );
    assert.equal(f.service.mcpOAuth.status(f.id).state, "reconnect_required");
    t.mock.restoreAll();
    await absent(f.port);
    assert.equal(f.tokenBindings.length, 0);
  } finally {
    t.mock.timers.reset();
    t.mock.restoreAll();
    await f.close();
  }
});

test("fixed handback review survives delayed consent without extending the original deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixedFixture("127.0.0.1", {
    tokenOverrides: { scope: "search:read.public PRIVATE_DELAY_CANARY:read" },
  });
  try {
    await f.configure();
    const stored = [...f.store.values.values()].map((value) => value.slice());
    const c = await f.connect();
    t.mock.timers.tick(20000);
    const staged = await nativeRequest(c.callback);
    const receipt = new URL(staged.location!);
    const route = receipt.pathname + receipt.search;
    assert.equal(
      (await f.send(route, undefined, { cookie: c.cookie })).status,
      202,
    );
    assert.equal(
      f.service.mcpOAuth.status(f.id).scopeReview!.expiresAt,
      c.value.expiresAt,
    );
    t.mock.timers.tick(65000);
    const response = await f.send(
      f.prefix + "scope-preview",
      {},
      { cookie: c.cookie },
    );
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.status, "approval_required");
    assert.equal(preview.expiresAt, c.value.expiresAt);
    assert.deepEqual([...f.store.values.values()], stored);
    assert.equal(f.service.mcpOAuth.status(f.id).authenticated, false);
    assert.equal(
      (await f.send(route, undefined, { cookie: c.cookie })).status,
      409,
    );
    assert.equal(
      (
        await f.send(
          f.prefix + "accept-scopes",
          {
            previewId: preview.id,
            generation: preview.generation,
            additionalScopes: preview.additionalScopes,
            consent: "Accept these additional OAuth capabilities",
          },
          { cookie: c.cookie },
        )
      ).status,
      200,
    );
    assert.equal(f.service.mcpOAuth.status(f.id).authenticated, true);
    assert.deepEqual(
      f.service.getIntegrations().connections[0].config.allowedTools,
      [],
    );
    assert.equal(f.tokenBindings.length, 1);
  } finally {
    await f.close();
    t.mock.timers.reset();
  }
});

async function browserCompletion(f: Awaited<ReturnType<typeof fixedFixture>>) {
  await f.configure();
  const c = await f.connect();
  const staged = await nativeRequest(c.callback);
  const response = await fetch(staged.location!, {
    headers: { accept: "text/html", cookie: c.cookie },
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin, f.base);
  assert.equal(location.pathname, "/");
  assert.equal(location.search, "");
  assert.match(location.hash, /^#\/settings\?oauthReview=[a-f0-9-]{36}$/);
  const continuation = location.hash.split("=")[1];
  assert.equal(
    (
      await f.send(
        new URL(staged.location!).pathname + new URL(staged.location!).search,
        undefined,
        { cookie: c.cookie },
      )
    ).status,
    409,
  );
  return { ...c, continuation, location };
}

test("browser completion returns once to a names-free local review continuation for every disclosure outcome", async (t) => {
  for (const [scope, status] of [
    ["search:read.public", "accepted"],
    ["search:read.public PRIVATE_RETURN_CANARY:read", "approval_required"],
    ["PRIVATE_RETURN_CANARY:read", "missing_required"],
  ])
    await t.test(status, async () => {
      const f = await fixedFixture("127.0.0.1", { tokenOverrides: { scope } });
      const events: McpOAuthDiagnostic[] = [];
      f.service.mcpOAuth.onDiagnostic = (event) => events.push(event);
      try {
        const c = await browserCompletion(f);
        const body = { continuation: c.continuation };
        const route = "/api/mcp/oauth/review-return";
        for (const invalid of [
          {},
          { continuation: "unknown" },
          { ...body, extra: true },
        ])
          assert.equal(
            (await f.send(route, invalid, { cookie: c.cookie })).status,
            409,
          );
        assert.equal(
          (
            await f.send(route, body, {
              cookie: c.cookie,
              origin: "http://localhost:9999",
            })
          ).status,
          403,
        );
        assert.equal(
          (await f.send(route, body, { cookie: "pr-review-mcp-browser=wrong" }))
            .status,
          409,
        );
        assert.equal((await f.send(route)).status, 404);
        const [first, second] = await Promise.all([
          f.send(route, body, { cookie: c.cookie }),
          f.send(route, body, { cookie: c.cookie }),
        ]);
        assert.deepEqual([first.status, second.status].sort(), [200, 409]);
        const response = first.status === 200 ? first : second;
        const returned = await response.json();
        assert.deepEqual(returned, {
          connectionId: f.id,
          generation: c.value.status.generation,
          status,
          expiresAt: c.value.expiresAt,
        });
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        const local = await f.send(
          f.prefix + "scope-preview",
          {},
          { cookie: c.cookie },
        );
        assert.equal(local.status, 200);
        const preview = await local.json();
        assert.equal(preview.status, status);
        assert.deepEqual(preview.grantedScopes, scope.split(" "));
        if (status === "missing_required")
          assert.equal(
            (
              await f.send(
                f.prefix + "accept-scopes",
                {
                  previewId: preview.id,
                  generation: preview.generation,
                  additionalScopes: preview.additionalScopes,
                  consent: "Accept these additional OAuth capabilities",
                },
                { cookie: c.cookie },
              )
            ).status,
            409,
          );
        assert.equal(
          f.service.mcpOAuth.status(f.id).authenticated,
          status === "accepted",
        );
        assert.equal(
          [...f.store.values.values()].some(
            (v) => JSON.parse(Buffer.from(v).toString()).tokens,
          ),
          status === "accepted",
        );
        const catalog = f.service.getIntegrations();
        const publicEvidence = JSON.stringify([
          returned,
          catalog,
          integrationSnapshot(catalog),
          events,
          f.service.db.sqlite.prepare("SELECT * FROM mcp_oauth").all(),
        ]);
        assert.doesNotMatch(
          publicEvidence,
          /PRIVATE_RETURN_CANARY|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|synthetic-fixed-code/,
        );
        assert.equal(publicEvidence.includes(c.continuation), false);
        assert.equal(catalog.connections[0].config.enabled, false);
        assert.deepEqual(catalog.connections[0].config.allowedTools, []);
        assert.equal(
          f.operations.some((op) => /initialize|tools/.test(op)),
          false,
        );
        assert.equal(f.tokenBindings.length, 1);
      } finally {
        await f.close();
      }
    });
});

test("local review return fails closed after expiry, cancellation, restart and authority drift", async (t) => {
  for (const boundary of [
    "expiry",
    "token expiry",
    "cancel",
    "restart",
    "reconnect",
    "source",
    "generation",
    "profile",
  ])
    await t.test(boundary, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const f = await fixedFixture("127.0.0.1", {
        tokenOverrides: {
          scope: "search:read.public PRIVATE_RETURN_CANARY:read",
          expires_in: boundary === "token expiry" ? 30 : 3600,
        },
      });
      try {
        const c = await browserCompletion(f);
        const stored = [...f.store.values.values()].map((v) => v.slice());
        const before = f.service.mcpOAuth.status(f.id).scopeReview!;
        if (boundary === "token expiry") {
          assert.equal(Date.parse(before.expiresAt), Date.now() + 30000);
          t.mock.timers.tick(30001);
        }
        if (boundary === "expiry") t.mock.timers.tick(300001);
        if (boundary === "cancel") await f.send(f.prefix + "cancel", {});
        if (boundary === "restart") await f.restart();
        if (boundary === "reconnect") await f.connect();
        if (boundary === "source")
          await writeFile(f.source, JSON.stringify({ mcpServers: {} }));
        if (boundary === "generation" || boundary === "profile") {
          const row = f.service.db.sqlite
            .prepare("SELECT state_json FROM mcp_oauth WHERE id = ?")
            .get(f.id)!;
          const state = JSON.parse(String(row.state_json));
          state[boundary === "generation" ? "generation" : "profileDigest"] =
            "changed";
          f.service.db.sqlite
            .prepare("UPDATE mcp_oauth SET state_json = ? WHERE id = ?")
            .run(JSON.stringify(state), f.id);
        }
        const denied = await f.send(
          "/api/mcp/oauth/review-return",
          { continuation: c.continuation },
          { cookie: c.cookie },
        );
        assert.equal(denied.status, 409);
        assert.equal((await denied.json()).code, "oauth_scope_consent_invalid");
        assert.deepEqual([...f.store.values.values()], stored);
        assert.equal(f.service.mcpOAuth.status(f.id).authenticated, false);
        assert.equal(
          (await f.send(f.prefix + "scope-preview", {}, { cookie: c.cookie }))
            .status,
          409,
        );
        assert.equal(f.tokenBindings.length, 1);
      } finally {
        await f.close();
        t.mock.timers.reset();
      }
    });
});

test("late fixed receipt cannot reset the overall deadline and failed consent persistence remains unadmitted", async (t) => {
  for (const boundary of ["overall", "storage"])
    await t.test(boundary, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const f = await fixedFixture("127.0.0.1", {
        tokenOverrides: {
          scope: "search:read.public PRIVATE_RETURN_CANARY:read",
        },
      });
      try {
        await f.configure();
        const c = await f.connect();
        t.mock.timers.tick(280000);
        const staged = await nativeRequest(c.callback);
        const receipt = new URL(staged.location!);
        assert.equal(
          (
            await f.send(receipt.pathname + receipt.search, undefined, {
              cookie: c.cookie,
            })
          ).status,
          202,
        );
        const preview = await (
          await f.send(f.prefix + "scope-preview", {}, { cookie: c.cookie })
        ).json();
        assert.equal(preview.expiresAt, c.value.expiresAt);
        const stored = [...f.store.values.values()].map((v) => v.slice());
        if (boundary === "overall") t.mock.timers.tick(20001);
        else f.store.unavailable = true;
        const denied = await f.send(
          f.prefix + "accept-scopes",
          {
            previewId: preview.id,
            generation: preview.generation,
            additionalScopes: preview.additionalScopes,
            consent: "Accept these additional OAuth capabilities",
          },
          { cookie: c.cookie },
        );
        assert.equal(denied.status, 409);
        assert.deepEqual([...f.store.values.values()], stored);
        assert.equal(f.service.mcpOAuth.status(f.id).authenticated, false);
        assert.equal(
          (await f.send(f.prefix + "scope-preview", {}, { cookie: c.cookie }))
            .status,
          409,
        );
      } finally {
        await f.close();
        t.mock.timers.reset();
      }
    });
});

test("restart and cancel fence staged receipts; a new Connect never accepts an old state", async () => {
  const f = await fixedFixture("[::1]");
  try {
    await f.configure();
    const first = await f.connect();
    const staged = await fetch(first.callback, { redirect: "manual" });
    assert.equal(staged.status, 303);
    const receipt = new URL(staged.headers.get("location")!);
    await f.send(f.prefix + "cancel", {});
    assert.equal(
      (
        await f.send(receipt.pathname + receipt.search, undefined, {
          cookie: first.cookie,
        })
      ).status,
      409,
    );
    const next = await f.connect();
    assert.equal(
      (await fetch(first.callback, { redirect: "manual" })).status,
      409,
    );
    assert.equal(
      (await fetch(next.callback, { redirect: "manual" })).status,
      303,
    );
    await f.restart();
    await absent(f.port, "[::1]");
    assert.equal(f.service.mcpOAuth.status(f.id).state, "reconnect_required");
    assert.equal(f.tokenBindings.length, 0);
  } finally {
    await f.close();
  }
});

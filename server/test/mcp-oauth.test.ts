import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { OAuthTokens } from "@modelcontextprotocol/client";
import { McpOAuth, type McpOAuthDiagnostic } from "../mcp-oauth.js";
import type { CredentialStore } from "../credential-store.js";
import type { McpOAuthProfile } from "../../shared/contracts.js";
import type { GuardedFetch } from "../guarded-fetch.js";

const profile: McpOAuthProfile = {
  id: "fixture-oauth/1",
  label: "Deterministic OAuth fixture",
  endpoint: "https://mcp.example.com/mcp",
  resource: "https://mcp.example.com/mcp",
  issuers: ["https://auth.example.com"],
  origins: ["https://mcp.example.com", "https://auth.example.com"],
  clientAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
  dynamicRegistration: true,
  readScopes: ["context:read"],
  readSupport: "unavailable",
  message: "Synthetic protocol only, not live provider readiness",
};
const callback = "http://127.0.0.1:4549/api/mcp/oauth/callback";

function fixture(overrides: Partial<McpOAuthProfile> = {}) {
  const selectedProfile = { ...profile, ...overrides };
  const db = new DatabaseSync(":memory:");
  const secrets = new Map<string, Uint8Array>();
  const store: CredentialStore = {
    async read(id) {
      return secrets.get(id);
    },
    async replace(id, value) {
      secrets.set(id, value.slice());
    },
    async delete(id) {
      secrets.delete(id);
    },
  };
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let tokenCount = 0;
  const behavior = {
    expires: 3600,
    scopes: selectedProfile.readScopes.join(" "),
    failToken: false,
    tokenReply: "normal",
    tokenOverrides: {} as Partial<OAuthTokens>,
    resource: selectedProfile.resource,
    redirect: false,
    issuer: "https://auth.example.com",
    metadataIssuer: "https://auth.example.com",
    tokenEndpoint: "https://auth.example.com/token",
    methods: ["none", "client_secret_basic", "client_secret_post"],
  };
  let pause: (() => Promise<void>) | undefined;
  const fetch: GuardedFetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("oauth-protected-resource"))
      return behavior.redirect
        ? new Response(null, {
            status: 302,
            headers: { location: "https://auth.example.com/redirected" },
          })
        : Response.json({
            resource: behavior.resource,
            authorization_servers: [behavior.issuer],
            scopes_supported: selectedProfile.readScopes,
          });
    if (String(url).includes("oauth-authorization-server"))
      return Response.json({
        issuer: behavior.metadataIssuer,
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: behavior.tokenEndpoint,
        registration_endpoint: "https://auth.example.com/register",
        revocation_endpoint: "https://auth.example.com/revoke",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: selectedProfile.readScopes,
        token_endpoint_auth_methods_supported: behavior.methods,
        authorization_response_iss_parameter_supported: true,
      });
    if (String(url) === "https://auth.example.com/token") {
      tokenCount++;
      await pause?.();
      if (behavior.failToken)
        throw new Error("synthetic-secret-must-not-escape");
      if (behavior.tokenReply === "invalid_json")
        return new Response("SYNTHETIC_RESPONSE_CANARY", { status: 200 });
      if (behavior.tokenReply === "invalid_schema")
        return Response.json({ unexpected: "SYNTHETIC_RESPONSE_CANARY" });
      if (["invalid_grant", "unknown_error"].includes(behavior.tokenReply))
        return Response.json(
          {
            error:
              behavior.tokenReply === "invalid_grant"
                ? "invalid_grant"
                : "SYNTHETIC_ERROR_CODE_CANARY",
            error_description: "SYNTHETIC_RESPONSE_CANARY",
            error_uri: "https://example.com/SYNTHETIC_URI_CANARY",
          },
          { status: 400, headers: { "x-canary": "SYNTHETIC_HEADER_CANARY" } },
        );
      return Response.json({
        token_type: "Bearer",
        access_token: `synthetic-access-${tokenCount}`,
        refresh_token: `synthetic-refresh-${tokenCount}`,
        expires_in: behavior.expires,
        scope: behavior.scopes,
        ...behavior.tokenOverrides,
      });
    }
    if (String(url).endsWith("/register"))
      return Response.json(
        {
          ...JSON.parse(String(init.body)),
          client_id: "synthetic-registered",
          client_secret: "synthetic-client-secret",
        },
        { status: 201 },
      );
    if (String(url).endsWith("/revoke"))
      return new Response(null, { status: 200 });
    throw new Error("Unexpected synthetic request");
  };
  const create = (redirect = callback, profiles = [selectedProfile]) =>
    new McpOAuth(db, redirect, store, profiles, fetch, true);
  const manager = create();
  manager.import("fixture", profile.id);
  const configure = async () => {
    const discovered = await manager.discover("fixture");
    await manager.configure("fixture", {
      clientId: "synthetic-client",
      clientAuthMethod: "client_secret_post",
      clientSecret: "synthetic-client-secret",
      scopes: selectedProfile.readScopes,
      discoveryDigest: discovered.discovery!.digest,
    });
  };
  const connect = async () => {
    const value = await manager.connect("fixture", "synthetic-browser");
    const params = new URL(value.authorizationUrl).searchParams;
    const response = new URLSearchParams({
      state: params.get("state")!,
      code: "synthetic-code",
      iss: "https://auth.example.com",
    });
    return { value, params, response };
  };
  return {
    db,
    secrets,
    store,
    requests,
    behavior,
    manager,
    create,
    configure,
    connect,
    setPause(value: () => Promise<void>) {
      pause = value;
    },
    count: () => tokenCount,
  };
}

test("public PKCE policy is never inferred for other providers, even from a copied profile flag", async () => {
  const f = fixture({ publicClientPolicy: "slack-pkce" });
  try {
    f.behavior.methods = ["client_secret_post"];
    const status = await f.manager.discover("fixture");
    assert.deepEqual(status.discovery!.clientAuthMethods, [
      "client_secret_post",
    ]);
    assert.equal(status.discovery!.publicClientPolicy, undefined);
    await assert.rejects(
      f.manager.configure("fixture", {
        clientId: "synthetic-public-client",
        clientAuthMethod: "none",
        scopes: ["context:read"],
        discoveryDigest: status.discovery!.digest,
      }),
      /offered client method/,
    );
    assert.equal(f.secrets.size, 0);
    assert.equal(f.count(), 0);
  } finally {
    await f.manager.close();
    f.db.close();
  }
});

test("OAuth exchange diagnostics are opt-in, fixed vocabulary and never record secrets", async (t) => {
  for (const failure of [
    "success",
    "source",
    "client_read",
    "transport",
    "invalid_grant",
    "unknown_error",
    "invalid_json",
    "invalid_schema",
    "token_validation",
    "persistence",
  ])
    await t.test(failure, async () => {
      const f = fixture();
      const events: McpOAuthDiagnostic[] = [];
      try {
        f.manager.onDiagnostic = (event) => events.push(event);
        await f.configure();
        const { response, params } = await f.connect();
        assert.equal(events.length, 0);
        f.manager.validateSource = async () => {
          if (failure === "source") throw new Error("SOURCE_SECRET_CANARY");
        };
        if (failure === "client_read")
          f.store.read = async () => {
            throw new Error("STORE_SECRET_CANARY");
          };
        if (failure === "persistence")
          f.store.replace = async () => {
            throw new Error("STORE_SECRET_CANARY");
          };
        f.behavior.failToken = failure === "transport";
        f.behavior.tokenReply = failure;
        if (failure === "token_validation") f.behavior.scopes = "context:write";
        const finish = () =>
          f.manager.callback(
            response,
            "synthetic-browser",
            "http://127.0.0.1:4549",
          );
        if (failure === "success") await finish();
        else await assert.rejects(finish);
        assert.equal(
          f.manager.status("fixture").authenticated,
          failure === "success",
        );
        const failed = events.filter(
          (event) => "outcome" in event && event.outcome === "failed",
        );
        if (failure === "success") {
          assert.deepEqual(failed, []);
          assert.deepEqual(events.at(-1), {
            phase: "credential_persistence",
            outcome: "succeeded",
          });
        } else {
          const phase =
            failure === "source"
              ? "source_validation"
              : failure === "client_read"
                ? "client_read"
                : failure === "transport"
                  ? "guarded_transport"
                  : failure === "persistence"
                    ? "credential_persistence"
                    : failure === "token_validation"
                      ? "token_validation"
                      : "sdk_exchange";
          assert.deepEqual(failed[0], {
            phase,
            outcome: "failed",
            category:
              failure === "invalid_grant"
                ? "invalid_grant"
                : failure === "invalid_json"
                  ? "invalid_json"
                  : failure === "token_validation"
                    ? "token_scope"
                    : "unclassified",
          });
          assert.equal(
            events.some(
              (e) =>
                e.phase === "credential_persistence" &&
                e.outcome === "succeeded",
            ),
            false,
          );
        }
        const sent = !["source", "client_read"].includes(failure);
        assert.equal(f.count(), Number(sent));
        const syntheticResponse = events.find(
          (e) => e.phase === "synthetic_response",
        );
        assert.equal(!!syntheticResponse, sent && failure !== "transport");
        if (syntheticResponse)
          assert.equal(
            syntheticResponse.status,
            ["invalid_grant", "unknown_error"].includes(failure) ? 400 : 200,
          );
        assert.equal(
          events.some((e) =>
            ["request_dispatched", "response_headers"].includes(e.phase),
          ),
          false,
        );
        const serialized = JSON.stringify(events);
        for (const secret of [
          "CANARY",
          "synthetic-",
          "https:",
          "http:",
          response.get("state")!,
          params.get("code_challenge")!,
        ])
          assert.equal(serialized.includes(secret), false);
        for (const event of events)
          assert.ok(
            Object.keys(event).every((key) =>
              ["phase", "outcome", "category", "status"].includes(key),
            ),
          );
        const snapshot = JSON.stringify(
          f.db.prepare("SELECT * FROM mcp_oauth").all(),
        );
        assert.doesNotMatch(snapshot, /diagnostic|CANARY|synthetic-code/);
        const count = events.length;
        await assert.rejects(finish);
        assert.equal(events.length, count);
        assert.equal(f.count(), Number(sent));
      } finally {
        await f.manager.close();
        f.db.close();
      }
    });
});

test("token-policy diagnostics identify only fixed rules without changing acceptance or persistence", async (t) => {
  const cases: Array<{
    name: string;
    tokens: Partial<OAuthTokens>;
    category?: string;
  }> = [
    {
      name: "type",
      tokens: { token_type: "TYPE_VALUE_CANARY" },
      category: "token_type",
    },
    {
      name: "access size",
      tokens: { access_token: "A".repeat(16001) },
      category: "access_token",
    },
    {
      name: "access newline",
      tokens: { access_token: "ACCESS_VALUE_CANARY\n" },
      category: "access_token",
    },
    {
      name: "refresh size",
      tokens: { refresh_token: "R".repeat(16001) },
      category: "refresh_token",
    },
    {
      name: "refresh newline",
      tokens: { refresh_token: "REFRESH_VALUE_CANARY\r" },
      category: "refresh_token",
    },
    {
      name: "missing expiry",
      tokens: { expires_in: undefined },
      category: "token_expiry",
    },
    {
      name: "expiry bounds",
      tokens: { expires_in: 31536001 },
      category: "token_expiry",
    },
    {
      name: "scope widened",
      tokens: { scope: "context:read SCOPE_VALUE_CANARY" },
      category: "token_scope",
    },
    { name: "scope missing", tokens: { scope: "" }, category: "token_scope" },
    {
      name: "first rule",
      tokens: {
        token_type: "TYPE_VALUE_CANARY",
        expires_in: 31536001,
        scope: "SCOPE_VALUE_CANARY",
      },
      category: "token_type",
    },
    {
      name: "absent scope default",
      tokens: { scope: undefined, expires_in: 1 },
    },
    {
      name: "existing accepted boundaries",
      tokens: {
        token_type: "bEaReR",
        access_token: "A".repeat(16000),
        refresh_token: "R".repeat(16000),
        expires_in: 31536000,
        scope: " context:read context:read ",
      },
    },
  ];
  for (const entry of cases)
    await t.test(entry.name, async () => {
      const f = fixture();
      const events: McpOAuthDiagnostic[] = [];
      try {
        await f.configure();
        const { response } = await f.connect();
        f.behavior.tokenOverrides = entry.tokens;
        f.manager.onDiagnostic = (event) => events.push(event);
        const finish = () =>
          f.manager.callback(
            response,
            "synthetic-browser",
            "http://127.0.0.1:4549",
          );
        if (entry.category)
          await assert.rejects(finish, /OAuth callback failed/);
        else await finish();
        assert.ok(
          events.some(
            (event) =>
              event.phase === "sdk_exchange" && event.outcome === "succeeded",
          ),
        );
        const validation = events.filter(
          (event) => event.phase === "token_validation",
        );
        assert.deepEqual(validation, [
          { phase: "token_validation", outcome: "started" },
          entry.category
            ? {
                phase: "token_validation",
                outcome: "failed",
                category: entry.category,
              }
            : { phase: "token_validation", outcome: "succeeded" },
        ]);
        const persisted = [...f.secrets.values()].some(
          (value) => !!JSON.parse(Buffer.from(value).toString("utf8")).tokens,
        );
        assert.equal(persisted, !entry.category);
        assert.equal(
          f.manager.status("fixture").authenticated,
          !entry.category,
        );
        assert.equal(
          events.some((event) => event.phase === "credential_persistence"),
          !entry.category,
        );
        const serialized = JSON.stringify(events);
        assert.doesNotMatch(
          serialized,
          /CANARY|synthetic-|context:read|3153600[01]|Bearer|bEaReR|A{100}|R{100}|http|verifier|cookie|receipt|stack|message/,
        );
        const observed = events.length;
        await assert.rejects(finish);
        assert.equal(events.length, observed);
        assert.equal(f.count(), 1);
      } finally {
        await f.manager.close();
        f.db.close();
      }
    });
});

test("generic scope parsing and exact admission remain unchanged without scope diagnostics", async (t) => {
  const approved = ["context:read", "history:read"];
  const space = approved.join(" ");
  const comma = approved.join(",");
  const cases: Array<[string, string | undefined, boolean]> = [
    ["empty", "", false],
    ["whitespace empty", " \t\n", false],
    ["omitted", undefined, true],
    ["exact", space, true],
    [
      "order whitespace duplicates",
      ` \t${approved.toReversed().join("\n")} ${approved[0]} `,
      true,
    ],
    ["missing", approved[0], false],
    ["extra", `${space} PRIVATE_SCOPE_CANARY`, false],
    ["replaced", "PRIVATE_SCOPE_CANARY", false],
    ["mixed", `${approved[0]} PRIVATE_SCOPE_CANARY`, false],
    ["substring", `PRIVATE_${approved[0]}_CANARY`, false],
    ["comma equivalent", comma, false],
    [
      "comma whitespace duplicates",
      ` ${approved.toReversed().join(", ")},${approved[0]} `,
      false,
    ],
    ["comma empty segment", `${comma},`, false],
    ["comma leading and repeated empty", `,,${comma}`, false],
    ["comma trimmed empty", `${comma}, \t`, false],
    [
      "comma empty and nonempty outside",
      `,${comma},PRIVATE_SCOPE_CANARY,`,
      false,
    ],
    [
      "comma trimmed nonempty outside",
      `${comma}, PRIVATE_SCOPE_CANARY \t,`,
      false,
    ],
    ["comma missing", `${approved[0]},${approved[0]}`, false],
    ["comma extra", `${comma},PRIVATE_SCOPE_CANARY`, false],
    ["comma replaced", "PRIVATE_SCOPE_CANARY,PRIVATE_OTHER_CANARY", false],
    ["comma substring", `PRIVATE_${approved[0]}_CANARY,${approved[1]}`, false],
    ["comma with space group", `${comma} PRIVATE_SCOPE_CANARY`, false],
  ];
  for (const [name, scope, accepted] of cases)
    await t.test(name, async () => {
      const f = fixture({ readScopes: approved });
      const events: McpOAuthDiagnostic[] = [];
      try {
        await f.configure();
        f.manager.onDiagnostic = (event) => events.push(event);
        const { response } = await f.connect();
        assert.equal(events.length, 0);
        f.behavior.tokenOverrides = { scope };
        const finish = () =>
          f.manager.callback(
            response,
            "synthetic-browser",
            "http://127.0.0.1:4549",
          );
        if (accepted) await finish();
        else await assert.rejects(finish, /OAuth callback failed/);
        assert.doesNotMatch(
          JSON.stringify(events),
          /scope_comparison|context:read|history:read/,
        );
        assert.equal(f.manager.status("fixture").authenticated, accepted);
        assert.equal(
          events.some((event) => event.phase === "credential_persistence"),
          accepted,
        );
        assert.equal(
          [...f.secrets.values()].some(
            (value) => !!JSON.parse(Buffer.from(value).toString("utf8")).tokens,
          ),
          accepted,
        );
        if (accepted) {
          const stored = [...f.secrets.values()].map((value) =>
            JSON.parse(Buffer.from(value).toString("utf8")),
          );
          assert.ok(
            stored.some(
              (value) =>
                value.tokens?.scope ===
                (scope ?? space).split(/\s+/).filter(Boolean).join(" "),
            ),
          );
        } else
          assert.deepEqual(events.at(-1), {
            phase: "token_validation",
            outcome: "failed",
            category: "token_scope",
          });
        assert.doesNotMatch(
          JSON.stringify(events),
          /CANARY|PRIVATE_|synthetic-|http|scopeValue|verifier|cookie|receipt|stack|message/,
        );
        assert.doesNotMatch(
          JSON.stringify(f.db.prepare("SELECT * FROM mcp_oauth").all()),
          /CANARY|scope_comparison|commaHypothesis/,
        );
        const count = events.length;
        await assert.rejects(finish);
        assert.equal(events.length, count);
        assert.equal(f.count(), 1);
      } finally {
        await f.manager.close();
        f.db.close();
      }
    });
});

test("scope provenance stops at the SDK boundary without inspecting discarded fields", async (t) => {
  for (const [name, scope] of [
    ["null", null],
    ["number", 17],
    ["boolean", true],
    ["array", ["PRIVATE_SCOPE_CANARY"]],
    ["object", { value: "PRIVATE_SCOPE_CANARY" }],
    ["nested only", undefined],
  ] as const)
    await t.test(name, async () => {
      const f = fixture();
      const events: McpOAuthDiagnostic[] = [];
      try {
        await f.configure();
        f.manager.onDiagnostic = (event) => events.push(event);
        f.behavior.tokenOverrides = {
          scope,
          authed_user: { scope: "PRIVATE_NESTED_CANARY" },
        } as unknown as Partial<OAuthTokens>;
        const { response } = await f.connect();
        const finish = () =>
          f.manager.callback(
            response,
            "synthetic-browser",
            "http://127.0.0.1:4549",
          );
        const accepted = scope === undefined;
        if (accepted) await finish();
        else await assert.rejects(finish, /OAuth callback failed/);
        assert.equal(f.manager.status("fixture").authenticated, accepted);
        assert.equal(
          events.some((e) => e.phase === "credential_persistence"),
          accepted,
        );
        assert.equal(
          [...f.secrets.values()].some(
            (value) => !!JSON.parse(Buffer.from(value).toString("utf8")).tokens,
          ),
          accepted,
        );
        assert.doesNotMatch(JSON.stringify(events), /scope_comparison/);
        if (!accepted) {
          assert.deepEqual(events.at(-1), {
            phase: "sdk_exchange",
            outcome: "failed",
            category: "unclassified",
          });
        }
        assert.doesNotMatch(
          JSON.stringify(events),
          /CANARY|PRIVATE_|authed_user|context:read|synthetic-|stack|message/,
        );
      } finally {
        await f.manager.close();
        f.db.close();
      }
    });
});

test("scope diagnostic callbacks cannot promote a mismatched grant", async () => {
  const f = fixture({ readScopes: ["context:read", "history:read"] });
  try {
    await f.configure();
    const { response: initialResponse } = await f.connect();
    await f.manager.callback(
      initialResponse,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    const previous = new Map(
      [...f.secrets].map(([id, value]) => [id, Buffer.from(value)]),
    );
    f.behavior.tokenOverrides = { scope: "context:read,history:read" };
    f.manager.onDiagnostic = (event) => {
      if (event.phase === "token_validation") {
        event.outcome = "succeeded";
        throw new Error("OBSERVER_CANARY");
      }
    };
    const { response } = await f.connect();
    await assert.rejects(
      f.manager.callback(
        response,
        "synthetic-browser",
        "http://127.0.0.1:4549",
      ),
    );
    assert.equal(f.manager.status("fixture").authenticated, false);
    assert.equal(f.secrets.size, previous.size);
    for (const [id, value] of f.secrets)
      assert.ok(previous.get(id)?.equals(value));
  } finally {
    await f.manager.close();
    f.db.close();
  }
});

test("diagnostic observers cannot change authorization or binding checks", async () => {
  const f = fixture();
  let observations = 0;
  try {
    f.manager.onDiagnostic = () => {
      observations++;
      throw new Error("OBSERVER_SECRET_CANARY");
    };
    await f.configure();
    const { response } = await f.connect();
    await assert.rejects(
      f.manager.callback(response, "wrong-browser", "http://127.0.0.1:4549"),
    );
    assert.equal(observations, 0);
    assert.equal(f.count(), 0);
    await f.manager.callback(
      response,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    assert.equal(f.manager.status("fixture").authenticated, true);
    assert.ok(observations > 0);
  } finally {
    await f.manager.close();
    f.db.close();
  }
});

test("explicit SDK discovery, PKCE callback, secret isolation and restart", async () => {
  const f = fixture();
  try {
    assert.equal(f.requests.length, 0);
    assert.equal(f.manager.status("fixture").authenticated, false);
    await f.configure();
    const { params, response } = await f.connect();
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("redirect_uri"), callback);
    assert.equal(params.get("resource"), profile.resource);
    await f.manager.callback(
      response,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    assert.equal(f.manager.status("fixture").authenticated, true);
    assert.equal(f.manager.status("fixture").identity, null);
    const persisted = JSON.stringify(
      f.db.prepare("SELECT * FROM mcp_oauth").all(),
    );
    assert.doesNotMatch(
      persisted,
      /synthetic-(access|refresh|client-secret|code)/,
    );
    assert.doesNotMatch(
      JSON.stringify(f.manager.status("fixture")),
      /synthetic-(access|refresh|client-secret|code)/,
    );
    const restarted = f.create();
    assert.equal(
      await restarted.token("fixture", restarted.status("fixture").generation),
      "synthetic-access-1",
    );
    await assert.rejects(
      f.manager.callback(
        response,
        "synthetic-browser",
        "http://127.0.0.1:4549",
      ),
      /Invalid/,
    );
  } finally {
    f.manager.close();
    f.db.close();
  }
});

test("callback browser, issuer, origin, cancellation and replay are bound", async () => {
  const f = fixture();
  try {
    await f.configure();
    const { response } = await f.connect();
    await assert.rejects(
      f.manager.callback(response, "other-browser", "http://127.0.0.1:4549"),
      /mismatched/,
    );
    await assert.rejects(
      f.manager.callback(response, "synthetic-browser", "http://evil.example"),
      /mismatched/,
    );
    response.set("iss", "https://other.example.com");
    await assert.rejects(
      f.manager.callback(
        response,
        "synthetic-browser",
        "http://127.0.0.1:4549",
      ),
      /issuer or authority mismatch/,
    );
    assert.equal(f.count(), 0);
    const next = await f.connect();
    f.manager.cancel("fixture");
    await assert.rejects(
      f.manager.callback(
        next.response,
        "synthetic-browser",
        "http://127.0.0.1:4549",
      ),
      /Invalid/,
    );
  } finally {
    f.manager.close();
    f.db.close();
  }
});

test("refresh is single flight, rotation persists, old generations are denied", async () => {
  const f = fixture();
  try {
    await f.configure();
    f.behavior.expires = 1;
    const { response } = await f.connect();
    await f.manager.callback(
      response,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    f.behavior.expires = 3600;
    f.behavior.tokenOverrides = { scope: undefined };
    const refreshEvents: McpOAuthDiagnostic[] = [];
    f.manager.onDiagnostic = (event) => refreshEvents.push(event);
    const generation = f.manager.status("fixture").generation;
    assert.deepEqual(
      await Promise.all([
        f.manager.token("fixture", generation),
        f.manager.token("fixture", generation),
      ]),
      ["synthetic-access-2", "synthetic-access-2"],
    );
    assert.equal(f.count(), 2);
    assert.equal(
      JSON.stringify(refreshEvents).includes("scope_comparison"),
      false,
    );
    const stored = [...f.secrets.values()].map((value) =>
      JSON.parse(Buffer.from(value).toString("utf8")),
    );
    assert.ok(stored.some((value) => value.tokens?.scope === "context:read"));
    await f.manager.connect("fixture", "synthetic-browser");
    await assert.rejects(
      f.manager.token("fixture", generation),
      /no longer authorized/,
    );
  } finally {
    f.manager.close();
    f.db.close();
  }
});

test("ambiguous refresh survives restart without retry or secret error leakage", async () => {
  const f = fixture();
  try {
    await f.configure();
    f.behavior.expires = 1;
    const { response } = await f.connect();
    await f.manager.callback(
      response,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    f.behavior.failToken = true;
    const generation = f.manager.status("fixture").generation;
    await assert.rejects(f.manager.token("fixture", generation), /ambiguous/);
    const restarted = f.create();
    await assert.rejects(
      restarted.token("fixture", generation),
      /no longer authorized/,
    );
    assert.equal(f.count(), 2);
  } finally {
    f.manager.close();
    f.db.close();
  }
});

test("disconnect fences late refresh and deletes only app-owned credentials", async () => {
  const f = fixture();
  try {
    await f.configure();
    f.behavior.expires = 1;
    const { response } = await f.connect();
    await f.manager.callback(
      response,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    let resume!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.setPause(() => {
      entered();
      return new Promise<void>((resolve) => {
        resume = resolve;
      });
    });
    const refresh = f.manager.token(
      "fixture",
      f.manager.status("fixture").generation,
    );
    const rejected = assert.rejects(refresh, /authority changed/);
    await reached;
    const disconnect = f.manager.disconnect("fixture");
    assert.equal(f.manager.status("fixture").authenticated, false);
    resume();
    await rejected;
    await disconnect;
    assert.equal(f.secrets.size, 0);
    assert.equal(f.manager.status("fixture").remoteRevocation, "succeeded");
  } finally {
    f.manager.close();
    f.db.close();
  }
});

test("discovery destinations, scopes and stale approval fail closed", async () => {
  const f = fixture();
  try {
    f.behavior.issuer = "https://unapproved.example.com";
    await assert.rejects(f.manager.discover("fixture"), /unsupported/);
    assert.equal(f.requests.length, 1);
    f.behavior.issuer = "https://auth.example.com";
    f.behavior.tokenEndpoint = "https://127.0.0.1/token";
    await assert.rejects(f.manager.discover("fixture"), /unsupported/);
    f.behavior.tokenEndpoint = "https://auth.example.com/token";
    const status = await f.manager.discover("fixture");
    await assert.rejects(
      f.manager.configure("fixture", {
        clientId: "fixture",
        clientAuthMethod: "none",
        scopes: ["write"],
        discoveryDigest: status.discovery!.digest,
      }),
      /explicit supported read scopes/,
    );
    await assert.rejects(
      f.manager.configure("fixture", {
        clientId: "fixture",
        clientAuthMethod: "none",
        scopes: ["context:read"],
        discoveryDigest: "stale",
      }),
      /offered client method/,
    );
    assert.equal(f.secrets.size, 0);
  } finally {
    f.manager.close();
    f.db.close();
  }
});

test("expired callback and token scope expansion cannot authenticate", async (t) => {
  const f = fixture();
  try {
    await f.configure();
    const expired = await f.connect();
    t.mock.method(Date, "now", () => Date.parse(expired.value.expiresAt) + 1);
    await assert.rejects(
      f.manager.callback(
        expired.response,
        "synthetic-browser",
        "http://127.0.0.1:4549",
      ),
      /expired/,
    );
    assert.equal(f.count(), 0);
    t.mock.restoreAll();
    const fresh = await f.connect();
    f.behavior.scopes = "context:read context:write";
    await assert.rejects(
      f.manager.callback(
        fresh.response,
        "synthetic-browser",
        "http://127.0.0.1:4549",
      ),
      /callback failed/,
    );
    assert.equal(f.manager.status("fixture").authenticated, false);
  } finally {
    await f.manager.close();
    f.db.close();
  }
});

test("disconnect fences a late cached credential read without restoring authority", async () => {
  const f = fixture();
  try {
    await f.configure();
    const { response } = await f.connect();
    await f.manager.callback(
      response,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    const original = f.store.read.bind(f.store);
    let release!: () => void;
    let arrived!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let pause = true;
    f.store.read = async (reference) => {
      if (pause) {
        pause = false;
        arrived();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(reference);
    };
    const rejected = assert.rejects(
      f.manager.token("fixture", f.manager.status("fixture").generation),
      /authority changed/,
    );
    await entered;
    const disconnected = f.manager.disconnect("fixture");
    release();
    await rejected;
    await disconnected;
    assert.equal(f.manager.status("fixture").authenticated, false);
    assert.equal(f.secrets.size, 0);
  } finally {
    await f.manager.close();
    f.db.close();
  }
});

test("failed rotated-token persistence and failed deletion survive restart with local authority denied", async () => {
  const f = fixture();
  try {
    await f.configure();
    f.behavior.expires = 1;
    const { response } = await f.connect();
    await f.manager.callback(
      response,
      "synthetic-browser",
      "http://127.0.0.1:4549",
    );
    f.store.replace = async () => {
      throw new Error("synthetic-storage-failure-canary");
    };
    const generation = f.manager.status("fixture").generation;
    await assert.rejects(f.manager.token("fixture", generation), /ambiguous/);
    const restarted = f.create();
    await assert.rejects(
      restarted.token("fixture", generation),
      /no longer authorized/,
    );
    assert.equal(f.count(), 2);
    const deletion = f.store.delete.bind(f.store);
    f.store.delete = async () => {
      throw new Error("synthetic-deletion-failure-canary");
    };
    await assert.rejects(
      restarted.disconnect("fixture"),
      /unavailable or locked/,
    );
    assert.equal(restarted.status("fixture").authenticated, false);
    assert.throws(
      () => restarted.import("fixture", profile.id),
      /Disconnect before/,
    );
    f.store.delete = deletion;
    await restarted.disconnect("fixture");
    assert.equal(f.secrets.size, 0);
    await restarted.close();
  } finally {
    await f.manager.close();
    f.db.close();
  }
});

test("DCR is explicit and advertised, and does not authenticate or grant tools", async () => {
  const f = fixture();
  try {
    const status = await f.manager.discover("fixture");
    const request = {
      consent: "Register a new MCP OAuth client" as const,
      clientAuthMethod: "client_secret_post" as const,
      scopes: ["context:read"],
      discoveryDigest: status.discovery!.digest,
    };
    await assert.rejects(
      f.manager.register("fixture", {
        ...request,
        consent: "wrong" as typeof request.consent,
      }),
      /separate explicit consent/,
    );
    assert.equal(
      f.requests.some((item) => item.url.endsWith("/register")),
      false,
    );
    const registered = await f.manager.register("fixture", request);
    assert.equal(registered.configured, true);
    assert.equal(registered.authenticated, false);
    assert.equal(registered.clientId, "synthetic-registered");
    await assert.rejects(
      f.manager.register("fixture", request),
      /no existing client/,
    );
  } finally {
    f.manager.close();
    f.db.close();
  }
});

test("explicit DCR callback binds registration without listening or adopting native identity", async () => {
  const f = fixture();
  try {
    const discovery = await f.manager.discover("fixture");
    const redirectUri = "http://localhost:45678/native/callback";
    const status = await f.manager.register("fixture", {
      consent: "Register a new MCP OAuth client",
      clientAuthMethod: "client_secret_post",
      scopes: ["context:read"],
      discoveryDigest: discovery.discovery!.digest,
      redirectUri,
    });
    const body = JSON.parse(
      String(
        f.requests.find((item) => item.url.endsWith("/register"))!.init.body,
      ),
    );
    assert.deepEqual(body.redirect_uris, [redirectUri]);
    assert.equal(body.client_name, "Local PR Review");
    assert.equal(status.redirectUri, redirectUri);
    assert.equal(status.callbackMode, "fixed-loopback");
    assert.equal(status.authenticated, false);
    assert.equal(f.count(), 0);
  } finally {
    await f.manager.close();
    f.db.close();
  }
});

test("explicit root metadata selection retains exact audience and strict destination bindings", async () => {
  const rootProfile = {
    ...profile,
    resourceMetadataUrl:
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    resource: "https://mcp.example.com",
  };
  const f = fixture(rootProfile);
  try {
    await f.configure();
    assert.equal(f.requests[0].url, rootProfile.resourceMetadataUrl);
    assert.equal(f.requests[0].init.redirect, "error");
    const { params, response } = await f.connect();
    assert.equal(params.get("resource"), rootProfile.resource);
    await f.manager.callback(
      response,
      "synthetic-browser",
      new URL(callback).origin,
    );
    const token = f.requests.find(
      (request) => request.url === f.behavior.tokenEndpoint,
    )!;
    assert.equal(
      new URLSearchParams(String(token.init.body)).get("resource"),
      rootProfile.resource,
    );
  } finally {
    await f.manager.close();
    f.db.close();
  }
  for (const change of [
    { resource: rootProfile.resource + "/" },
    { resource: rootProfile.endpoint },
    { issuer: "https://unapproved.example.com" },
    { metadataIssuer: "https://unapproved.example.com" },
    { redirect: true },
    { tokenEndpoint: "https://unapproved.example.com/token" },
  ]) {
    const denied = fixture(rootProfile);
    try {
      Object.assign(denied.behavior, change);
      await assert.rejects(denied.manager.discover("fixture"), /unsupported/);
      assert.equal(denied.manager.status("fixture").discovery, undefined);
      assert.equal(denied.secrets.size, 0);
      assert.equal(denied.count(), 0);
      assert.equal(
        denied.requests.some(
          (item) =>
            item.url.includes("unapproved") || item.url.endsWith("redirected"),
        ),
        false,
      );
    } finally {
      await denied.manager.close();
      denied.db.close();
    }
  }
  const wrongOrigin = fixture({
    ...rootProfile,
    resourceMetadataUrl:
      "https://unapproved.example.com/.well-known/oauth-protected-resource",
  });
  try {
    await assert.rejects(
      wrongOrigin.manager.discover("fixture"),
      /unsupported/,
    );
    assert.equal(wrongOrigin.requests.length, 0);
    assert.equal(wrongOrigin.secrets.size, 0);
  } finally {
    await wrongOrigin.manager.close();
    wrongOrigin.db.close();
  }
});

test("profile resource or discovery URL drift fences persisted auth before I/O until explicit re-import and setup", async () => {
  for (const change of [
    { resource: "https://mcp.example.com" },
    {
      resourceMetadataUrl:
        "https://mcp.example.com/.well-known/oauth-protected-resource",
    },
  ]) {
    const f = fixture();
    let changed: McpOAuth | undefined;
    try {
      await f.configure();
      const { response } = await f.connect();
      await f.manager.callback(
        response,
        "synthetic-browser",
        new URL(callback).origin,
      );
      const captured = f.manager.status("fixture");
      await f.manager.close();
      changed = f.create(callback, [{ ...profile, ...change }]);
      const stored = JSON.stringify(
        f.db.prepare("SELECT * FROM mcp_oauth").all(),
      );
      const requestCount = f.requests.length;
      const read = f.store.read;
      f.store.read = async () => {
        throw new Error("Unexpected credential read after profile drift");
      };
      assert.equal(changed.status("fixture").state, "reconnect_required");
      assert.equal(changed.status("fixture").authenticated, false);
      assert.equal(changed.status("fixture").generation, captured.generation);
      await assert.rejects(
        changed.token("fixture", captured.generation),
        /profile changed/,
      );
      await assert.rejects(
        changed.connect("fixture", "synthetic-browser"),
        /profile changed/,
      );
      await assert.rejects(changed.inventory("fixture"), /profile changed/);
      await assert.rejects(changed.discover("fixture"), /Disconnect/);
      assert.throws(() => changed!.import("fixture", profile.id), /Disconnect/);
      assert.equal(f.requests.length, requestCount);
      assert.equal(
        JSON.stringify(f.db.prepare("SELECT * FROM mcp_oauth").all()),
        stored,
      );
      f.store.read = read;
      await changed.disconnect("fixture");
      assert.equal(f.requests.length, requestCount);
      const fresh = changed.import("fixture", profile.id);
      assert.equal(fresh.state, "needs_discovery");
      assert.equal(fresh.configured, false);
      assert.equal(fresh.discovery, undefined);
      assert.notEqual(fresh.generation, captured.generation);
      const setup = {
        clientId: "synthetic-reconfigured",
        clientAuthMethod: "none" as const,
        scopes: ["context:read"],
        discoveryDigest: captured.discovery!.digest,
      };
      await assert.rejects(
        changed.configure("fixture", setup),
        /offered client method/,
      );
      f.behavior.resource = change.resource ?? profile.resource;
      const discovered = await changed.discover("fixture");
      assert.notEqual(discovered.discovery!.digest, captured.discovery!.digest);
      await assert.rejects(
        changed.configure("fixture", setup),
        /offered client method/,
      );
      await changed.configure("fixture", {
        ...setup,
        discoveryDigest: discovered.discovery!.digest,
      });
      assert.equal(changed.status("fixture").authenticated, false);
      await assert.rejects(
        changed.token("fixture", captured.generation),
        /no longer authorized/,
      );
      assert.equal(f.count(), 1);
    } finally {
      await changed?.close();
      await f.manager.close();
      f.db.close();
    }
  }
});

test("app-origin drift requires explicit client reconfiguration, never an inferred fixed listener", async () => {
  const f = fixture();
  let changed: McpOAuth | undefined;
  try {
    await f.configure();
    await f.manager.close();
    const redirectUri = "http://127.0.0.1:4550/api/mcp/oauth/callback";
    changed = f.create(redirectUri);
    assert.equal(changed.status("fixture").state, "reconnect_required");
    assert.equal(changed.status("fixture").redirectUri, callback);
    await assert.rejects(
      changed.connect("fixture", "synthetic-browser"),
      /configured app callback changed/,
    );
    const request = {
      clientId: "synthetic-client",
      clientAuthMethod: "none" as const,
      scopes: ["context:read"],
      discoveryDigest: changed.status("fixture").discovery!.digest,
    };
    await assert.rejects(
      changed.configure("fixture", request),
      /configured app callback changed/,
    );
    const status = await changed.configure("fixture", {
      ...request,
      redirectUri,
    });
    assert.equal(status.callbackMode, "app");
    assert.equal(status.redirectUri, redirectUri);
    assert.equal(f.count(), 0);
  } finally {
    await changed?.close();
    await f.manager.close();
    f.db.close();
  }
});

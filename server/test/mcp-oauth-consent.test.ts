import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { oauthFixture } from "./fixtures/oauth-context.js";
import { integrationSnapshot } from "../integrations.js";
import { decodeOAuthScopes } from "../mcp-oauth-scopes.js";
import type { McpOAuthDiagnostic } from "../mcp-oauth.js";
import type {
  McpOAuthScopePreview,
  McpOAuthScopeApproval,
} from "../../shared/contracts.js";

const scopes = [
  "search:read.public",
  "search:read.private",
  "channels:history",
  "groups:history",
];
const extra = "PRIVATE_CAPABILITY_CANARY:read";
const approved = (preview: McpOAuthScopePreview): McpOAuthScopeApproval => ({
  previewId: preview.id,
  generation: preview.generation,
  additionalScopes: [...preview.additionalScopes],
  consent: "Accept these additional OAuth capabilities",
});

async function fixture(scope: unknown = scopes.join(","), expires = 3600) {
  const tokenOverrides: Record<string, unknown> = {
    scope,
    expires_in: expires,
  };
  const f = await oauthFixture({
    clientAuthMethods: ["none"],
    scopes,
    tokenOverrides,
  });
  const events: McpOAuthDiagnostic[] = [];
  f.service.mcpOAuth.onDiagnostic = (event) => events.push(event);
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
  assert.equal(
    (
      await f.send(prefix + "configure", {
        clientId: "synthetic-consent-client",
        clientAuthMethod: "none",
        scopes,
        discoveryDigest: discovery.discovery.digest,
      })
    ).status,
    200,
  );
  const begin = async () => {
    const result = await f.send(prefix + "connect", {});
    assert.equal(result.status, 200);
    const cookie = result.headers.get("set-cookie")!.split(";")[0];
    const authorization = new URL((await result.json()).authorizationUrl);
    const params = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code: "SYNTHETIC_CODE_CANARY",
      iss: "https://mcp.slack.com",
    });
    const finish = () =>
      f.send("/api/mcp/oauth/callback?" + params, undefined, { cookie });
    return { cookie, finish, result: await finish() };
  };
  const tokens = () =>
    [...f.store.values.values()]
      .map((value) => JSON.parse(Buffer.from(value).toString("utf8")))
      .find((value) => value.tokens)?.tokens;
  return {
    ...f,
    get service() {
      return f.service;
    },
    id,
    prefix,
    begin,
    tokens,
    events,
    tokenOverrides,
  };
}

function noLeaks(f: Awaited<ReturnType<typeof fixture>>) {
  const catalog = f.service.getIntegrations();
  assert.doesNotMatch(
    JSON.stringify([
      catalog,
      integrationSnapshot(catalog),
      f.events,
      f.service.db.sqlite.prepare("SELECT * FROM mcp_oauth").all(),
    ]),
    /PRIVATE_CAPABILITY_CANARY|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_CODE|scope_comparison/,
  );
  assert.equal(catalog.connections[0].config.enabled, false);
  assert.deepEqual(catalog.connections[0].config.allowedTools, []);
  assert.equal(
    f.operations.some((op) => /tools|initialize/.test(op)),
    false,
  );
}

test("Slack decoding preserves every nonempty identifier and does not change generic parsing", () => {
  assert.deepEqual(
    decodeOAuthScopes("slack-mcp/1", " , a:read,\tB:read ,a:read,,\n"),
    ["a:read", "B:read"],
  );
  assert.deepEqual(decodeOAuthScopes("other/1", "a:read,b:read a:read"), [
    "a:read,b:read",
    "a:read",
  ]);
  for (const value of [
    "<script>",
    "a:read\0",
    "a:read\x1b",
    "é:read",
    "a\\read",
    'a"read',
    "x".repeat(129),
    "x".repeat(8193),
    Array(129).fill("a:read").join(","),
  ])
    assert.throws(
      () => decodeOAuthScopes("slack-mcp/1", value),
      /malformed|limit/,
    );
});

test("local scope disclosure separates formatting, omission, missing requirements and unapproved capabilities", async (t) => {
  const cases: Array<
    [string, unknown, number, McpOAuthScopePreview["status"] | undefined]
  > = [
    ["space", scopes.join(" "), 200, "accepted"],
    ["comma", scopes.join(","), 200, "accepted"],
    [
      "padded empty separators",
      ` , ${scopes.join(" ,\t")} ,,\n`,
      200,
      "accepted",
    ],
    [
      "order duplicates",
      [...scopes.toReversed(), scopes[0]].join(","),
      200,
      "accepted",
    ],
    ["omitted", undefined, 200, "accepted"],
    ["empty supplied", "", 409, "missing_required"],
    ["only separators", " ,, \t", 409, "missing_required"],
    ["missing", scopes[0], 409, "missing_required"],
    ["missing plus extra", `${scopes[0]},${extra}`, 409, "missing_required"],
    ["extra", [...scopes, extra].join(","), 202, "approval_required"],
    [
      "empty and extra",
      `,${scopes.join(",")},${extra},`,
      202,
      "approval_required",
    ],
    [
      "case preserved",
      [...scopes, "Channels:history"].join(" "),
      202,
      "approval_required",
    ],
    [
      "substring not membership",
      `prefix_${scopes[0]},${scopes.slice(1).join(",")}`,
      409,
      "missing_required",
    ],
    ["HTML invalid", `${scopes.join(",")},<img/src=x>`, 409, undefined],
    ["control invalid", `${scopes.join(",")},bad\x1bname`, 409, undefined],
    ["long item", `${scopes.join(",")},${"x".repeat(129)}`, 409, undefined],
    ["long disclosure", "x".repeat(8193), 409, undefined],
    [
      "too many items",
      [...scopes, ...Array.from({ length: 125 }, (_, i) => `extra:${i}`)].join(
        ",",
      ),
      409,
      undefined,
    ],
    ["invalid SDK type", [extra], 409, undefined],
  ];
  for (const [name, scope, code, disposition] of cases)
    await t.test(name, async () => {
      const f = await fixture(scope);
      try {
        if (scope === undefined) f.tokenOverrides.scope = undefined;
        const { cookie, finish, result } = await f.begin();
        assert.equal(result.status, code);
        const message = await result.text();
        assert.doesNotMatch(
          message,
          /PRIVATE_CAPABILITY_CANARY|SYNTHETIC_|<img|bad\x1b/,
        );
        const local = await f.send(f.prefix + "scope-preview", {}, { cookie });
        assert.equal(local.status, disposition ? 200 : 409);
        assert.equal(local.headers.get("cache-control"), "no-store");
        if (disposition) {
          assert.equal(local.headers.get("x-content-type-options"), "nosniff");
          const preview: McpOAuthScopePreview = await local.json();
          assert.equal(preview.status, disposition);
          assert.equal(
            preview.source,
            scope === undefined ? "requested_fallback" : "provider",
          );
          assert.deepEqual(preview.requestedScopes, scopes);
          assert.deepEqual(
            preview.grantedScopes,
            scope === undefined
              ? scopes
              : decodeOAuthScopes("slack-mcp/1", String(scope)),
          );
          assert.equal(
            preview.additionalScopes.includes(extra),
            typeof scope === "string" && scope.includes(extra),
          );
          assert.equal(
            (
              await f.send(
                f.prefix + "scope-preview",
                {},
                { cookie: "pr-review-mcp-browser=wrong" },
              )
            ).status,
            409,
          );
          assert.equal(
            (
              await f.send(
                f.prefix + "scope-preview",
                {},
                { cookie, origin: "http://localhost:9999" },
              )
            ).status,
            403,
          );
          if (disposition !== "approval_required")
            assert.equal(
              (
                await f.send(f.prefix + "accept-scopes", approved(preview), {
                  cookie,
                })
              ).status,
              409,
            );
        }
        assert.equal(!!f.tokens(), disposition === "accepted");
        assert.equal(
          f.service.mcpOAuth.status(f.id).authenticated,
          disposition === "accepted",
        );
        assert.equal(
          f.events.some((event) => event.phase === "credential_persistence"),
          disposition === "accepted",
        );
        noLeaks(f);
        assert.equal((await finish()).status, 409);
        assert.equal(
          f.operations.filter((op) => op === "synthetic:token").length,
          1,
        );
      } finally {
        await f.close();
      }
    });
});

test("provider scope echoes of credentials or authorization codes never enter local disclosure", async (t) => {
  for (const value of [
    "SYNTHETIC_ACCESS_CANARY",
    "prefix_SYNTHETIC_REFRESH_CANARY_suffix",
    "SYNTHETIC_CODE_CANARY",
  ])
    await t.test(value.split("_")[1], async () => {
      const f = await fixture([...scopes, value].join(","));
      try {
        const { cookie, result } = await f.begin();
        assert.equal(result.status, 409);
        assert.doesNotMatch(await result.text(), /SYNTHETIC_/);
        const response = await f.send(
          f.prefix + "scope-preview",
          {},
          { cookie },
        );
        assert.equal(response.status, 409);
        assert.doesNotMatch(await response.text(), /SYNTHETIC_/);
        assert.equal(f.tokens(), undefined);
        noLeaks(f);
      } finally {
        await f.close();
      }
    });
});

test("only exact original-browser consent persists additional capabilities and it grants no tools", async () => {
  const f = await fixture([...scopes, extra, "chat:write"].join(","));
  try {
    const { cookie, result } = await f.begin();
    assert.equal(result.status, 202);
    const preview: McpOAuthScopePreview = await (
      await f.send(f.prefix + "scope-preview", {}, { cookie })
    ).json();
    const request = approved(preview);
    assert.equal(f.tokens(), undefined);
    await assert.rejects(
      f.service.mcpOAuth.token(f.id, preview.generation),
      /no longer authorized/,
    );
    for (const changes of [
      { previewId: "stale" },
      { generation: "stale" },
      { consent: "yes" },
      { additionalScopes: [] },
      { additionalScopes: [extra] },
      { additionalScopes: [...request.additionalScopes, "hidden:write"] },
      { additionalScopes: request.additionalScopes.toReversed() },
      { additionalScopes: null },
    ])
      assert.equal(
        (
          await f.send(
            f.prefix + "accept-scopes",
            { ...request, ...changes },
            { cookie },
          )
        ).status,
        409,
      );
    assert.equal(
      (
        await f.send(f.prefix + "accept-scopes", request, {
          cookie: "pr-review-mcp-browser=other",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.send(f.prefix + "accept-scopes", request, {
          cookie,
          origin: "http://localhost:9999",
        })
      ).status,
      403,
    );
    preview.additionalScopes.length = 0;
    const stream = await f.send("/api/events");
    const reader = stream.body!.getReader();
    await reader.read();
    assert.equal(
      (await f.send(f.prefix + "accept-scopes", request, { cookie })).status,
      200,
    );
    assert.doesNotMatch(
      new TextDecoder().decode((await reader.read()).value),
      /PRIVATE_CAPABILITY_CANARY|chat:write|SYNTHETIC_|grantedScopes|additionalScopes/,
    );
    await reader.cancel();
    assert.equal(f.service.mcpOAuth.status(f.id).authenticated, true);
    assert.equal(f.tokens().scope, [...scopes, extra, "chat:write"].join(" "));
    assert.equal(
      (await f.send(f.prefix + "accept-scopes", request, { cookie })).status,
      409,
    );
    noLeaks(f);
    const stateResponse = await (await f.send("/api/state")).text();
    assert.doesNotMatch(
      stateResponse,
      /PRIVATE_CAPABILITY_CANARY|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH/,
    );
  } finally {
    await f.close();
  }
});

test("pending scope consent is lost on cancellation, expiry, restart, new generation and source drift", async (t) => {
  for (const boundary of [
    "cancel",
    "expiry",
    "restart",
    "reconnect",
    "source drift",
    "storage failure",
  ] as const)
    await t.test(boundary, async () => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const f = await fixture([...scopes, extra].join(","));
      try {
        const { cookie } = await f.begin();
        const preview: McpOAuthScopePreview = await (
          await f.send(f.prefix + "scope-preview", {}, { cookie })
        ).json();
        if (boundary === "cancel") await f.send(f.prefix + "cancel", {});
        if (boundary === "expiry") t.mock.timers.tick(300001);
        if (boundary === "restart") await f.restart();
        if (boundary === "reconnect") await f.send(f.prefix + "connect", {});
        if (boundary === "source drift")
          await writeFile(f.source, JSON.stringify({ mcpServers: {} }));
        if (boundary === "storage failure") f.store.unavailable = true;
        assert.equal(
          (
            await f.send(f.prefix + "accept-scopes", approved(preview), {
              cookie,
            })
          ).status,
          409,
        );
        assert.equal(f.tokens(), undefined);
        assert.equal(f.service.mcpOAuth.status(f.id).authenticated, false);
        assert.equal(
          (await f.send(f.prefix + "scope-preview", {}, { cookie })).status,
          409,
        );
        noLeaks(f);
      } finally {
        await f.close();
        t.mock.timers.reset();
      }
    });
});

test("scope refusal preserves stored credentials and observers cannot authorize pending capabilities", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.begin()).result.status, 200);
    const stored = [...f.store.values.values()].map((value) => value.slice());
    f.tokenOverrides.scope = [...scopes, extra].join(",");
    f.service.mcpOAuth.onDiagnostic = (event) => {
      f.events.push(structuredClone(event));
      if ("outcome" in event) event.outcome = "succeeded";
      throw new Error("PRIVATE_OBSERVER_CANARY");
    };
    const { cookie, result } = await f.begin();
    assert.equal(result.status, 202);
    const preview: McpOAuthScopePreview = await (
      await f.send(f.prefix + "scope-preview", {}, { cookie })
    ).json();
    assert.equal(preview.status, "approval_required");
    assert.equal(f.service.mcpOAuth.status(f.id).authenticated, false);
    await assert.rejects(
      f.service.mcpOAuth.token(f.id, preview.generation),
      /no longer authorized/,
    );
    await f.send(f.prefix + "cancel", {});
    assert.deepEqual([...f.store.values.values()], stored);
    noLeaks(f);
  } finally {
    await f.close();
  }
});

test("cancellation or expiry during explicitly approved persistence cannot resurrect authority", async (t) => {
  for (const boundary of ["cancel", "expiry"])
    await t.test(boundary, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const f = await fixture([...scopes, extra].join(","));
      try {
        const { cookie } = await f.begin();
        const preview: McpOAuthScopePreview = await (
          await f.send(f.prefix + "scope-preview", {}, { cookie })
        ).json();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const replace = f.store.replace.bind(f.store);
        f.store.replace = async (reference, value) => {
          entered.resolve();
          await release.promise;
          await replace(reference, value);
        };
        const pending = f.send(f.prefix + "accept-scopes", approved(preview), {
          cookie,
        });
        await entered.promise;
        if (boundary === "cancel") await f.send(f.prefix + "cancel", {});
        else t.mock.timers.tick(300001);
        release.resolve();
        assert.equal((await pending).status, 409);
        assert.equal(f.service.mcpOAuth.status(f.id).authenticated, false);
        await assert.rejects(
          f.service.mcpOAuth.token(f.id, preview.generation),
          /no longer authorized/,
        );
        assert.equal(
          (await f.send(f.prefix + "scope-preview", {}, { cookie })).status,
          409,
        );
        noLeaks(f);
      } finally {
        await f.close();
        t.mock.timers.reset();
      }
    });
});

test("expiry removes the accepted initial disclosure without revoking authenticated state", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  try {
    const { cookie, result } = await f.begin();
    assert.equal(result.status, 200);
    t.mock.timers.tick(300001);
    assert.equal(
      (await f.send(f.prefix + "scope-preview", {}, { cookie })).status,
      409,
    );
    assert.equal(f.service.mcpOAuth.status(f.id).authenticated, true);
    assert.equal(f.service.mcpOAuth.status(f.id).scopeReview, undefined);
    noLeaks(f);
  } finally {
    await f.close();
    t.mock.timers.reset();
  }
});

test("refresh preserves explicit admission, omission fallback and refuses new or missing capabilities", async (t) => {
  for (const change of [
    "omitted",
    "same formatted",
    "narrow extras",
    "widened",
    "missing",
  ] as const)
    await t.test(change, async () => {
      const f = await fixture([...scopes, extra].join(","), 10);
      try {
        const { cookie } = await f.begin();
        const preview: McpOAuthScopePreview = await (
          await f.send(f.prefix + "scope-preview", {}, { cookie })
        ).json();
        await f.send(f.prefix + "accept-scopes", approved(preview), { cookie });
        const old = f.tokens();
        f.tokenOverrides.expires_in = 3600;
        f.tokenOverrides.scope =
          change === "omitted"
            ? undefined
            : change === "same formatted"
              ? `,${scopes.join(",")},${extra},`
              : change === "narrow extras"
                ? scopes.join(",")
                : change === "widened"
                  ? [...scopes, extra, "NEW_CAPABILITY_CANARY:write"].join(",")
                  : extra;
        const token = () => f.service.mcpOAuth.token(f.id, preview.generation);
        if (["widened", "missing"].includes(change)) {
          await assert.rejects(token, /Refresh failed/);
          assert.deepEqual(f.tokens(), old);
          assert.equal(f.service.mcpOAuth.status(f.id).authenticated, false);
        } else {
          await token();
          assert.equal(f.service.mcpOAuth.status(f.id).authenticated, true);
          assert.equal(
            f.tokens().scope,
            (change === "narrow extras" ? scopes : [...scopes, extra]).join(
              " ",
            ),
          );
        }
        noLeaks(f);
      } finally {
        await f.close();
      }
    });
});

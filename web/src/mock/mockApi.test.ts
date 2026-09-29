import { describe, expect, it } from "vitest";
import {
  dockerApprovalConfirmation,
  dockerSetupConfirmation,
  type HarnessModelDiscovery,
} from "../../../shared/contracts";
import { toUpdate } from "../lib/draft";
import * as fixtures from "./fixtures";
import {
  decodeMockOAuthScopes,
  MockBackend,
  MockError,
  OAUTH_SCOPE_CASES,
  OAUTH_SCOPE_CONSENT,
} from "./mockApi";

const backend = () => new MockBackend({ reviewDelayMs: 0 });

describe("MockBackend", () => {
  it("rejects stale draft saves with 409", () => {
    const b = backend();
    const draft = toUpdate(b.detail("pr-482").draft!);
    b.saveDraft("pr-482", draft);
    expect(() => b.saveDraft("pr-482", draft)).toThrowError(MockError);
    try {
      b.saveDraft("pr-482", draft);
    } catch (e) {
      expect((e as MockError).status).toBe(409);
    }
  });

  it("does not spawn duplicate manual reviews while one is pending", () => {
    const b = new MockBackend({ reviewDelayMs: 60_000 });
    b.review("pr-490");
    b.review("pr-490");
    expect(b.detail("pr-490").runs.filter((r) => r.status === "queued")).toHaveLength(1);
    expect(b.detail("pr-490").runs.map((r) => r.status)).toEqual(["interrupted", "queued"]);
  });

  it("adds a new latest draft when a later review completes and keeps the old one", () => {
    const b = backend();
    const before = b.detail("pr-482").draft!;
    b.review("pr-482");
    const after = b.detail("pr-482");
    expect(after.drafts).toHaveLength(3);
    expect(after.draft?.runId).toBe(after.runs.at(-1)?.id);
    expect(after.draft?.version).toBe(1);
    expect(after.drafts[1]).toEqual(before);
    expect(after.runs.at(-1)?.status).toBe("completed");
  });

  it("previews only included findings and anchors general ones in the body", () => {
    const b = backend();
    const draft = b.detail("pr-482").draft!;
    b.saveDraft("pr-482", {
      ...toUpdate(draft),
      findings: draft.findings.map((f) => (f.id === "f-3" ? { ...f, included: true } : f)),
    });
    const preview = b.preview("pr-482", draft.id, draft.version + 1);
    expect(preview.draftId).toBe(draft.id);
    expect(preview.payload.body.startsWith(draft.body)).toBe(true);
    expect(preview.payload.body).not.toContain("buildInvoice` now computes");
    expect(preview.payload.comments.map((c) => c.line)).toEqual([42]);
    expect(preview.payload.comments[0]!.body).toMatch(/^\*\*Blocking\.\*\* /);
    expect(preview.payload.body).toContain(
      "**Non-blocking.** `src/billing/invoice.ts:58` Rounding",
    );
    expect(preview.payload.body).toContain("**Non-blocking.** The migration in this PR");
    expect(preview.payload.body).toContain("populated table");
    expect(preview.payload.commit_id).toBe(b.detail("pr-482").pr.headSha);
  });

  it("refuses to preview an outdated draft", () => {
    expect(() => backend().preview("pr-475", "draft-475", 1)).toThrowError(/Draft targets/);
  });

  it("discovers models read-only per harness with retained saved ids and structured source failures", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved" });
    const before = structuredClone({ harness: b.harness, settings: b.settings });
    const codex = b.handle("POST", "/api/settings/models/discover", {
      harness: "codex",
    }) as HarnessModelDiscovery;
    expect(codex).toMatchObject({
      harness: "codex",
      status: "partial",
      availability: "not_checked",
    });
    expect(codex.models.map((m) => m.model)).toEqual([
      "mock-codex-configured",
      "model-one",
      "model-two",
    ]);
    expect(codex.models[1]!.sources).toEqual(["saved-selection"]);
    expect(codex.sources.map((s) => [s.id, s.status])).toEqual([
      ["native-settings", "ready"],
      ["saved-selection", "ready"],
      ["native-catalog", "unsupported"],
    ]);
    const pi = b.discoverModels({ harness: "pi" }) as HarnessModelDiscovery;
    expect(pi.models.find((m) => m.model === "openai-codex/mock-pi-cached")?.label).toBe(
      "Mock Pi Cached",
    );
    expect(pi.sources.find((s) => s.id === "pi-models-store")).toMatchObject({
      kind: "cached_catalog",
      freshness: "unknown",
    });
    for (const body of [{}, { harness: "codex", path: "/x" }, { harness: "nope" }])
      expect(() => b.discoverModels(body)).toThrow(/invalid_model_discovery|supported harness/);
    expect(() => b.handle("GET", "/api/settings/models/discover", undefined)).toThrow(
      /No mock route/,
    );
    expect({ harness: b.harness, settings: b.settings }).toEqual(before);
    expect(b.modelDiscoveryCalls).toEqual(["codex", "pi"]);

    const errored = new MockBackend({ reviewDelayMs: 0, harness: "saved", models: "error" });
    const partial = errored.discoverModels({ harness: "codex" }) as HarnessModelDiscovery;
    expect(partial.status).toBe("partial");
    expect(partial.models.map((m) => m.model)).toEqual(["model-one", "model-two"]);
    expect(partial.sources[0]).toMatchObject({
      id: "native-settings",
      status: "error",
      modifiedAt: null,
    });
    const unsupported = new MockBackend({
      reviewDelayMs: 0,
      harness: "fresh",
      models: "unsupported",
    });
    expect(unsupported.discoverModels({ harness: "claude" })).toMatchObject({
      status: "unsupported",
      models: [],
    });
    expect(() =>
      new MockBackend({ reviewDelayMs: 0, models: "transport" }).discoverModels({ harness: "pi" }),
    ).toThrow(/transport failure/);
  });

  it("routes requests by method and path", () => {
    const b = backend();
    expect(b.handle("GET", "/api/state", undefined)).toMatchObject({
      settings: { repository: "acme/rocket" },
    });
    expect(() => b.handle("GET", "/api/nope", undefined)).toThrowError(/No mock route/);
  });

  it("requires an explicit v3 save, resolves native defaults per entry and keeps same-harness rows distinct", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "fresh" });
    const fresh = b.harnessStatus();
    expect(fresh.requiresSave).toBe(true);
    expect(fresh.effective).toBeNull();
    expect(fresh.selection).toMatchObject({ version: 2, workflow: "dangerous" });
    expect(() => b.handle("POST", "/api/settings/harness/import", { path: "/x.json" })).toThrow(
      /No mock route/,
    );
    expect(() =>
      b.selectHarness({ harness: "claude", workflow: "legacy", sourceId: null }),
    ).toThrow(/invalid_harness|Historical shapes/);
    expect(() =>
      b.selectHarness({
        version: 3,
        workflow: "separated",
        harness: "claude",
        reviewer: { skillPath: fixtures.SKILL_PATH, model: null },
        additional: [{ id: "main", harness: "codex", model: null }],
      }),
    ).toThrow(/invalid_harness|Historical shapes/);
    const saved = b.selectHarness({
      version: 3,
      workflow: "separated",
      harness: "pi",
      reviewer: { skillPath: fixtures.SKILL_PATH, model: null },
      additional: [
        { id: "reviewer-1", harness: "codex", model: "model-one" },
        { id: "reviewer-2", harness: "codex", model: null },
      ],
    });
    expect(saved.requiresSave).toBe(false);
    expect(saved.effective).not.toBeNull();
    expect(saved.selection).toMatchObject({
      harness: "pi",
      reviewer: { model: "openai-codex/gpt-6-astra" },
      additional: [
        { id: "reviewer-1", harness: "codex", model: "model-one" },
        { id: "reviewer-2", harness: "codex", model: "gpt-6-astra" },
      ],
    });
    expect(saved.capabilities.map((c) => [c.id, c.policy.harness, c.policy.profile])).toEqual([
      ["main", "pi", "restricted-native-1"],
      ["reviewer-1", "codex", "restricted-native-1"],
      ["reviewer-2", "codex", "restricted-native-1"],
    ]);
    expect(() =>
      b.selectHarness({
        version: 3,
        workflow: "separated",
        harness: "pi",
        reviewer: { skillPath: fixtures.MISSING_SKILL_PATH, model: null },
        additional: [],
      }),
    ).toThrow(/skill_incompatible|missing/);
    expect(b.harnessStatus().selection?.harness).toBe("pi");
  });

  it("keeps archived choices display-only and refuses old question retries without clearing them", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "archived" });
    const status = b.harnessStatus();
    expect(status.selection).toBeNull();
    expect(status.archivedSelection).toMatchObject({ harness: "claude", workflow: "legacy" });
    expect(status.requiresSave).toBe(true);
    expect(status.mode).toBeNull();
    expect(() => b.review("pr-490")).toThrow(/execution_incompatible|archived or unsaved/);
    b.questions["pr-482"] = [
      {
        id: "q-old",
        prId: "pr-482",
        draftId: null,
        parentId: null,
        mode: "explain",
        status: "failed",
        baseSha: b.prs[0]!.baseSha,
        headSha: b.prs[0]!.headSha,
        selection: {
          path: "src/billing/invoice.ts",
          from: { side: "RIGHT", line: 42 },
          to: { side: "RIGHT", line: 42 },
          baseSha: b.prs[0]!.baseSha,
          headSha: b.prs[0]!.headSha,
          oldPath: null,
          snippet: "",
          kinds: { add: true, del: false, ctx: false },
          spansHunks: false,
          anchors: {},
        },
        question: "",
        answer: null,
        error: "old failure",
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
      },
    ];
    expect(() => b.retryQuestion("pr-482", "q-old")).toThrow(/execution_incompatible|archived/);
    expect(b.questions["pr-482"]![0]).toMatchObject({ status: "failed", error: "old failure" });
  });

  it("discovers native connections disabled, binds explicit scope, resets grants on Load and separates Test evidence", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved" });
    expect(b.integrations.connections).toEqual([]);
    expect(b.integrations.profiles?.map((p) => p.id)).toEqual(["pr-review-documents/1"]);
    expect(() => b.handle("POST", "/api/settings/integrations/import", {})).toThrow(
      /No mock route/,
    );
    expect(() => b.discoverIntegrations({ harness: "pi" })).toThrow(/native_mcp_unsupported|Pi/);
    expect(() => b.discoverIntegrations({ harness: "claude", path: "relative.json" })).toThrow(
      /absolute/,
    );
    expect(
      b.discoverIntegrations({ harness: "codex", path: fixtures.EMPTY_MCP_PATH }).connections,
    ).toEqual([]);
    const catalog = b.discoverIntegrations({ harness: "claude" });
    expect(
      catalog.connections.map((c) => [c.config.serverName, c.status, c.config.enabled]),
    ).toEqual([
      ["documents", "configured", false],
      ["local-tools", "unsupported", false],
      ["oauth-sse", "unsupported", false],
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(/SYNTHETIC_ONLY|Bearer /);
    const documents = catalog.connections[0]!.config.id;
    const stdio = catalog.connections[1]!.config.id;
    expect(() =>
      b.importNativeIntegration({ id: stdio, profileId: "pr-review-documents/1", scope: ["a"] }),
    ).toThrow(/native_mcp_unsupported|no permission/);
    expect(() =>
      b.importNativeIntegration({ id: documents, profileId: "pr-review-documents/1", scope: [] }),
    ).toThrow(/1-100/);
    const bound = b.importNativeIntegration({
      id: documents,
      profileId: "pr-review-documents/1",
      scope: ["doc-1", "doc-1", "doc-2"],
    }).connections[0]!;
    expect(bound.config.readProvider).toMatchObject({
      profileId: "pr-review-documents/1",
      scope: ["doc-1", "doc-2"],
    });
    expect(bound.status).toBe("needs_compatibility");
    expect(bound.definition.tools.map((t) => t.id)).toEqual(["document"]);
    let enabled = b.updateIntegration(documents, {
      enabled: true,
      allowedTools: ["document", "bogus"],
    }).connections[0]!;
    expect(enabled.config.allowedTools).toEqual(["document"]);
    expect(enabled.tools[0]!.state).toBe("unsupported");
    const loaded = b.loadIntegrationTools(documents).connections[0]!;
    expect(loaded.config.inventory).toMatchObject({
      status: "loaded",
      scope: "synthetic_transport",
      connected: false,
    });
    expect(loaded.config.enabled).toBe(false);
    expect(loaded.config.allowedTools).toEqual([]);
    enabled = b.updateIntegration(documents, { enabled: true, allowedTools: ["document"] })
      .connections[0]!;
    expect(enabled.effective).toBe("restricted");
    expect(enabled.tools[0]!.state).toBe("allowed");
    expect(b.testIntegration(documents)).toMatchObject({
      scope: "synthetic_transport",
      connected: false,
      containmentVerified: false,
    });
    expect(b.integrations.connections[0]!.evidence?.scope).toBe("synthetic_transport");
    expect(b.loadIntegrationTools(documents).connections[0]!.config.enabled).toBe(false);
    expect(b.integrations.connections[0]!.evidence).toBeUndefined();
    b.options.inventory = "changed";
    expect(b.loadIntegrationTools(documents).connections[0]!.config.inventory?.status).toBe(
      "changed",
    );
    expect(b.integrations.connections[0]!.status).toBe("needs_compatibility");
  });

  it("imports read providers disabled and bounds permission updates and tests", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved" });
    expect(() => b.importReadProviders("/Users/demo/wrong.json")).toThrow(/not a version-1/);
    const catalog = b.importReadProviders("/Users/demo/pr-review/read-providers.json");
    expect(catalog.connections.map((c) => c.definition.id)).toEqual([
      "github",
      "linear",
      "notion",
      "custom:documents",
    ]);
    expect(catalog.connections.every((c) => c.status === "configured" && !c.config.enabled)).toBe(
      true,
    );
    expect(() => b.updateIntegration("github", { endpoint: "https://x" })).toThrow(
      /Only enabled and allowedTools/,
    );
    const enabled = b.updateIntegration("github", { enabled: true, allowedTools: ["bogus"] });
    const github = enabled.connections.find((c) => c.definition.id === "github")!;
    expect(github.status).toBe("configured");
    expect(github.config.allowedTools).toEqual([]);
    expect(b.testIntegration("github")).toMatchObject({
      scope: "synthetic_transport",
      connected: false,
      mutating: false,
      containmentVerified: false,
    });
    expect(b.integrations.connections[0]!.evidence?.scope).toBe("synthetic_transport");
    b.importReadProviders("/Users/demo/pr-review/read-providers.json");
    expect(b.integrations.connections[0]!.evidence).toBeUndefined();
    expect(b.integrations.connections[0]!.config.enabled).toBe(false);
  });

  it("requires explicit Docker inspection and an exact, complete, fresh approval before setup", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "docker", native: "discovered" });
    const setup = (approval?: unknown) =>
      b.setupDocker({ harness: "codex", confirmation: dockerSetupConfirmation, approval });
    expect(() => setup()).toThrow(fixtures.DOCKER_INSPECTION_REQUIRED_MESSAGE);
    expect(() => b.inspectDocker({ harness: "pi" })).toThrow(
      fixtures.DOCKER_INSPECT_UNSAVED_MESSAGE,
    );
    expect(() => b.inspectDocker({ harness: "codex", extra: 1 })).toThrow(/optional explicit/);
    const localId = "native:claude-local-tools-mock-identity";
    expect(() =>
      b.inspectDocker({
        harness: "codex",
        localConnections: [
          { id: localId, profileId: "other", scope: ["doc"], enabled: false, allowedTools: [] },
        ],
      }),
    ).toThrow(fixtures.DOCKER_LOCAL_MCP_MESSAGE);
    expect(() =>
      b.inspectDocker({
        harness: "codex",
        localConnections: [
          {
            id: "native:claude-documents-mock-identity",
            profileId: fixtures.knownProfile.id,
            scope: ["doc"],
            enabled: false,
            allowedTools: [],
          },
        ],
      }),
    ).toThrow(fixtures.DOCKER_LOCAL_MCP_MESSAGE);
    const disclosure = b.inspectDocker({
      harness: "codex",
      localConnections: [
        {
          id: localId,
          profileId: fixtures.knownProfile.id,
          scope: ["doc"],
          enabled: true,
          allowedTools: ["document"],
        },
      ],
    });
    expect(disclosure.digest).toBe(b.inspected!.disclosure.digest);
    expect(JSON.stringify(disclosure)).not.toMatch(/SYNTHETIC|Bearer/);
    expect(disclosure.localConnections[0]).toMatchObject({
      transport: "container-stdio",
      inventory: "not_tested",
      connected: false,
    });
    const approval = fixtures.approveDisclosure(disclosure);
    for (const rejected of [
      undefined,
      { ...approval, confirmation: "yes" },
      { ...approval, customizations: [] },
      { ...approval, customizations: [...approval.customizations, "extra"] },
      { ...approval, customizations: [...approval.customizations, ...approval.customizations] },
      { ...approval, credentialExposures: [] },
      { ...approval, credentialExposures: ["codex", "pi"] },
      { ...approval, digest: "old" },
      { ...approval, note: "x" },
    ])
      expect(() => setup(rejected)).toThrow(fixtures.DOCKER_APPROVAL_MESSAGE);
    expect(b.harness.managed).toBeUndefined();
    expect(b.integrationConfigs.find((c) => c.id === localId)).toMatchObject({
      enabled: false,
      allowedTools: [],
    });
    b.selectHarness({
      version: 2,
      workflow: "docker",
      harness: "codex",
      reviewer: { skillPath: fixtures.SKILL_PATH, model: "gpt-6-astra" },
    });
    expect(b.inspected).toBeUndefined();
    expect(() => setup(approval)).toThrow(fixtures.DOCKER_INSPECTION_REQUIRED_MESSAGE);
    b.inspectDocker({ harness: "codex" });
    expect(() => setup(approval)).toThrow(fixtures.DOCKER_APPROVAL_MESSAGE);
    const fresh = fixtures.approveDisclosure(b.inspected!.disclosure);
    expect(fresh.confirmation).toBe(dockerApprovalConfirmation);
    const status = b.setupDocker({
      harness: "codex",
      confirmation: dockerSetupConfirmation,
      approval: fresh,
    }) as ReturnType<MockBackend["harnessStatus"]>;
    expect(status.effective?.workflow).toBe("docker");
    expect(b.executionStatus().snapshot?.docker?.approval).toEqual(fresh);
    const run = b.review("pr-490").runs.at(-1)!;
    expect(run.reviewer.execution?.docker?.disclosure.digest).toBe(fresh.digest);
  });

  it("keeps a marker-less cached Docker artifact readable but refuses new captures", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "docker-legacy" });
    expect(b.harnessStatus().setup.status).toBe("ready");
    expect(b.harnessStatus().effective).toBeNull();
    expect(b.executionStatus()).toMatchObject({
      status: "unavailable",
      message: fixtures.DOCKER_LEGACY_ARTIFACT_MESSAGE,
    });
    expect(b.executionStatus().snapshot?.docker).toBeUndefined();
    expect(() => b.review("pr-490")).toThrow(fixtures.DOCKER_LEGACY_ARTIFACT_MESSAGE);
    expect(b.detail("pr-482").runs.length).toBeGreaterThan(0);
  });
});

describe("MockBackend OAuth and Docker source contracts", () => {
  const slackId = "native:claude-slack-mock-identity";
  const configured = () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "configured" });
    return { b, state: b.oauthStates[slackId]! };
  };
  const status = (e: unknown) => (e as MockError).status;
  const code = (e: unknown) => (e as MockError).code;

  it("exposes declared native OAuth metadata read-only and accepts the public client only when advertised", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "metadata" });
    const slack = b.integrationConfigs.find((c) => c.id === slackId)!;
    expect(slack.native?.oauth).toEqual({
      clientId: fixtures.DECLARED_PLUGIN_CLIENT_ID,
      callbackPort: fixtures.DECLARED_PLUGIN_CALLBACK_PORT,
    });
    expect(slack.native?.message).toBe(fixtures.OAUTH_METADATA_MESSAGE);
    expect(b.oauthStates[slackId]).toBeUndefined();
    expect(slack.enabled).toBe(false);
    expect(
      b.integrationConfigs.find((c) => c.native?.name === "synthetic-oauth")?.native?.oauth,
    ).toBeUndefined();
    b.importOAuthIntegration({ id: slackId, profileId: fixtures.slackOAuthProfile.id });
    b.oauthAction(slackId, "discover", {});
    const discovery = b.oauthStates[slackId]!.discovery!;
    expect(discovery.clientAuthMethods).toEqual(["client_secret_post"]);
    const publicBody = {
      clientId: fixtures.DECLARED_PLUGIN_CLIENT_ID,
      clientAuthMethod: "none",
      scopes: ["search:read.public"],
      discoveryDigest: discovery.digest,
    };
    expect(() => b.oauthAction(slackId, "configure", publicBody)).toThrowError(MockError);
    expect(b.oauthStates[slackId]!.clientId).toBeUndefined();

    const advertised = new MockBackend({
      reviewDelayMs: 0,
      harness: "saved",
      oauth: "discovered",
      oauthMethods: "public",
    });
    const advertisedDiscovery = advertised.oauthStates[slackId]!.discovery!;
    expect(advertisedDiscovery.clientAuthMethods).toEqual(["client_secret_post", "none"]);
    const body = { ...publicBody, discoveryDigest: advertisedDiscovery.digest };
    expect(() =>
      advertised.oauthAction(slackId, "configure", { ...body, clientSecret: "SECRET_CANARY" }),
    ).toThrowError(MockError);
    const result = advertised.oauthAction(slackId, "configure", body);
    expect(result).toMatchObject({
      configured: true,
      authenticated: false,
      state: "disconnected",
      clientId: fixtures.DECLARED_PLUGIN_CLIENT_ID,
      clientAuthMethod: "none",
    });
    expect(JSON.stringify(advertised.integrations)).not.toContain("SECRET_CANARY");
    const config = advertised.integrationConfigs.find((c) => c.id === slackId)!;
    expect(config.native?.oauth?.clientId).toBe(fixtures.DECLARED_PLUGIN_CLIENT_ID);
    expect(config.enabled).toBe(false);
    expect(config.allowedTools).toEqual([]);
  });

  it("refuses document binding for app-owned OAuth metadata and imports only matching profiles", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "metadata" });
    expect(() =>
      b.importNativeIntegration({
        id: slackId,
        profileId: fixtures.knownProfile.id,
        scope: ["doc-1"],
      }),
    ).toThrowError(/does not match this supported known profile/);
    expect(() =>
      b.importOAuthIntegration({ id: slackId, profileId: fixtures.syntheticOAuthProfile.id }),
    ).toThrowError(/matching OAuth profile/);
    expect(() =>
      b.importOAuthIntegration({
        id: "native:claude-plugin-bearer-mock-identity",
        profileId: fixtures.slackOAuthProfile.id,
      }),
    ).toThrowError(/matching OAuth profile/);
    const catalog = b.importOAuthIntegration({
      id: slackId,
      profileId: fixtures.slackOAuthProfile.id,
    });
    const slack = catalog.connections.find((c) => c.definition.id === slackId)!;
    expect(slack.oauth?.state).toBe("needs_discovery");
    expect(slack.oauth?.configured).toBe(false);
    expect(slack.definition.supported).toBe(true);
    expect(slack.definition.tools).toEqual([]);
    expect(catalog.oauthProfiles?.map((p) => p.id)).toEqual([
      fixtures.slackOAuthProfile.id,
      fixtures.linearOAuthProfile.id,
      fixtures.axiomOAuthProfile.id,
      fixtures.syntheticOAuthProfile.id,
    ]);
    expect(() => b.oauthAction(slackId, "configure", { clientId: "x" })).toThrowError(MockError);
  });

  it("validates configure and register exactly, never echoes secrets and refuses Slack registration", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "discovered" });
    const digest = b.oauthStates[slackId]!.discovery!.digest;
    const base = {
      clientId: "app",
      clientAuthMethod: "client_secret_post",
      clientSecret: "SECRET_CANARY",
      scopes: ["search:read.public"],
      discoveryDigest: digest,
    };
    for (const bad of [
      { ...base, discoveryDigest: "stale" },
      { ...base, clientAuthMethod: "client_secret_basic" },
      { ...base, clientAuthMethod: "none" },
      { ...base, scopes: [] },
      { ...base, scopes: ["channels:history"] },
      { ...base, clientSecret: undefined },
      { ...base, clientId: "bad id!" },
      { ...base, extra: true },
    ])
      expect(() => b.oauthAction(slackId, "configure", bad), JSON.stringify(bad)).toThrowError(
        MockError,
      );
    expect(b.oauthStates[slackId]!.clientId).toBeUndefined();
    const result = b.oauthAction(slackId, "configure", base);
    expect(JSON.stringify(result)).not.toContain("SECRET_CANARY");
    expect(JSON.stringify(b.integrations)).not.toContain("SECRET_CANARY");
    expect(JSON.stringify(b.state())).not.toContain("SECRET_CANARY");
    expect("state" in result && result.state).toBe("disconnected");
    try {
      b.oauthAction(slackId, "register", {
        consent: "Register a new MCP OAuth client",
        clientAuthMethod: "client_secret_post",
        scopes: ["search:read.public"],
        discoveryDigest: digest,
      });
      expect.unreachable();
    } catch (e) {
      expect(status(e)).toBe(409);
      expect(code(e)).toBe("oauth_unavailable");
    }
  });

  it("fences generations on connect, cancel and disconnect, resets grants and keeps Test unsupported", () => {
    const { b, state } = configured();
    const before = state.generation;
    const connect = b.oauthAction(slackId, "connect", {}) as {
      authorizationUrl: string;
      expiresAt: string;
    };
    expect(connect.authorizationUrl).toContain("client_id=mock-app-owned-client");
    expect(state.state).toBe("authorizing");
    expect(state.generation).not.toBe(before);
    expect(() => b.oauthAction(slackId, "discover", {})).toThrowError(MockError);
    b.oauthAction(slackId, "cancel", {});
    expect(state.state).toBe("disconnected");
    expect(() => b.completeOAuthCallback(slackId)).toThrowError(/no longer active/);
    b.oauthAction(slackId, "connect", {});
    b.completeOAuthCallback(slackId);
    expect(state.state).toBe("authenticated");
    const loaded = b
      .loadIntegrationTools(slackId)
      .connections.find((c) => c.definition.id === slackId)!;
    expect(loaded.config.inventory?.scope).toBe("synthetic_transport");
    expect(loaded.config.inventory?.connected).toBe(false);
    expect(loaded.config.enabled).toBe(false);
    expect(loaded.definition.tools.map((tool) => tool.id)).toEqual(
      fixtures.mockSlackReadTools.map((tool) => tool.id),
    );
    expect(() =>
      b.updateIntegration(slackId, { allowedTools: ["synthetic_unvetted_read", "chat_post"] }),
    ).not.toThrow();
    expect(b.integrationConfigs.find((c) => c.id === slackId)!.allowedTools).toEqual([]);
    expect(b.testIntegration(slackId)).toMatchObject({
      status: "needs_compatibility",
      scope: "local_configuration",
      connected: false,
    });
    b.updateIntegration(slackId, { enabled: true, allowedTools: ["slack_read_channel"] });
    expect(b.testIntegration(slackId)).toMatchObject({
      status: "needs_compatibility",
      scope: "local_configuration",
      connected: false,
    });
    b.updateIntegration(slackId, { allowedTools: ["slack_search_public"] });
    const test = b.testIntegration(slackId);
    expect(test).toMatchObject({
      status: "ready",
      scope: "synthetic_transport",
      connected: false,
    });
    expect(b.oauthStatus(slackId).identity).toBeNull();
    const beforeRediscovery = structuredClone(b.integrations);
    expect(
      b.discoverIntegrations({ harness: "claude", path: fixtures.PLUGIN_MCP_PATH }).connections,
    ).toEqual(beforeRediscovery.connections);
    const disconnected = b.oauthAction(slackId, "disconnect", {}) as {
      state: string;
      remoteRevocation: string;
      configured: boolean;
    };
    expect(disconnected).toMatchObject({
      state: "needs_client",
      configured: false,
      remoteRevocation: "unsupported",
    });
    expect(b.integrationConfigs.find((c) => c.id === slackId)!.inventory).toBeUndefined();
    expect(
      b.integrations.connections.find((c) => c.definition.id === slackId)!.evidence,
    ).toBeUndefined();
    expect(
      b
        .discoverIntegrations({ harness: "claude", path: fixtures.PLUGIN_MCP_PATH })
        .connections.find((c) => c.definition.id === slackId)!.oauth,
    ).toMatchObject({ configured: false, authenticated: false });
  });

  it("requires saved Docker for source discovery and accepts only server-observed leaf and exclusion ids", () => {
    const fresh = new MockBackend({ reviewDelayMs: 0, harness: "saved" });
    expect(() => fresh.discoverDockerExclusions({})).toThrowError(/Save Docker before/);
    expect(() =>
      fresh.discoverDockerLibraryLeaf({ source: `${fixtures.HOME}/.codex/skills/helper` }),
    ).toThrowError(/Save Docker before/);
    const b = new MockBackend({ reviewDelayMs: 0, harness: "docker" });
    expect(() => b.discoverDockerExclusions({ extra: 1 })).toThrowError(MockError);
    expect(() => b.discoverDockerLibraryLeaf({ source: "relative" })).toThrowError(
      /not an arbitrary source/,
    );
    expect(() =>
      b.discoverDockerLibraryLeaf({ source: `${fixtures.HOME}/.codex/skills` }),
    ).toThrowError(/not an arbitrary source/);
    expect(() =>
      b.discoverDockerLibraryLeaf({ source: `${fixtures.HOME}/.claude/skills/fixture-leaf` }),
    ).toThrowError(/not an arbitrary source/);
    const a = b.discoverDockerLibraryLeaf({
      source: `${fixtures.HOME}/.agents/skills/fixture-leaf`,
    });
    const c = b.discoverDockerLibraryLeaf({
      source: `${fixtures.HOME}/.codex/skills/fixture-leaf`,
    });
    expect(a.resolvedSourcePath).toBe(c.resolvedSourcePath);
    expect(a.id).not.toBe(c.id);
    const { exclusions } = b.discoverDockerExclusions({});
    expect(exclusions).toHaveLength(4);
    expect(exclusions.map((item) => item.kind)).toEqual([
      "status-line",
      "herdr-session-start",
      "slack-plugin",
      "google-workspace-skill",
    ]);
    expect(() =>
      b.inspectDocker({ harness: "codex", libraryLeaves: ["f".repeat(64)] }),
    ).toThrowError(fixtures.DOCKER_LEAF_STALE_MESSAGE);
    expect(() => b.inspectDocker({ harness: "codex", exclusions: ["f".repeat(64)] })).toThrowError(
      /Docker exclusion changed or is unsupported/,
    );
    expect(() => b.inspectDocker({ harness: "codex", libraryLeaves: [a.id, a.id] })).toThrowError(
      /distinct/,
    );
    const disclosure = b.inspectDocker({
      harness: "codex",
      exclusions: [exclusions[0]!.id],
      libraryLeaves: [a.id],
    });
    expect(disclosure.exclusions?.map((e) => e.id)).toEqual([exclusions[0]!.id]);
    expect(disclosure.libraryLeaves?.map((l) => l.id)).toEqual([a.id]);
    expect(
      disclosure.resources.some((r) => r.encoding === "base64" && r.mediaType === "image/png"),
    ).toBe(true);
    expect(disclosure.sourceHandling?.length).toBeGreaterThan(0);
    const approval = fixtures.approveDisclosure(disclosure);
    expect(approval.exclusions).toEqual([exclusions[0]!.id]);
    expect(approval.libraryLeaves).toEqual([a.id]);
    for (const bad of [
      { ...approval, exclusions: [] },
      { ...approval, exclusions: undefined },
      { ...approval, libraryLeaves: [c.id] },
      { ...approval, libraryLeaves: [a.id, c.id] },
      { ...approval, exclusions: exclusions.map((e) => e.id) },
    ]) {
      try {
        b.setupDocker({ harness: "codex", confirmation: dockerSetupConfirmation, approval: bad });
        expect.unreachable();
      } catch (e) {
        expect(code(e), JSON.stringify(bad)).toBe("docker_setup_failed");
      }
      b.inspectDocker({ harness: "codex", exclusions: [exclusions[0]!.id], libraryLeaves: [a.id] });
    }
    b.setupDocker({ harness: "codex", confirmation: dockerSetupConfirmation, approval });
    expect(b.dockerApprovals.codex?.approval.libraryLeaves).toEqual([a.id]);
    b.clearInspection();
    expect(b.leafCandidates.size).toBe(0);
    expect(() => b.inspectDocker({ harness: "codex", libraryLeaves: [a.id] })).toThrowError(
      fixtures.DOCKER_LEAF_STALE_MESSAGE,
    );
  });
});

describe("MockBackend explicit callback selection", () => {
  const slackId = "native:claude-slack-mock-identity";
  const app = "http://127.0.0.1:4317/api/mcp/oauth/callback";
  const base = (b: MockBackend) => ({
    clientId: "explicit-client",
    clientAuthMethod: "client_secret_post",
    clientSecret: "SECRET_CANARY",
    scopes: ["search:read.public"],
    discoveryDigest: b.oauthStates[slackId]!.discovery!.digest,
  });

  it("defaults omitted redirects to the app callback, preserves a saved fixed choice on omission and reports both fields", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "discovered" });
    b.oauthAction(slackId, "configure", base(b));
    expect(b.oauthStatus(slackId)).toMatchObject({
      redirectUri: app,
      appRedirectUri: app,
      callbackMode: "app",
    });
    b.oauthAction(slackId, "configure", {
      ...base(b),
      redirectUri: "http://localhost:4548/callback",
    });
    expect(b.oauthStatus(slackId)).toMatchObject({
      redirectUri: "http://localhost:4548/callback",
      appRedirectUri: app,
      callbackMode: "fixed-loopback",
    });
    b.oauthAction(slackId, "configure", base(b));
    expect(b.oauthStatus(slackId).callbackMode).toBe("fixed-loopback");
    b.oauthAction(slackId, "configure", { ...base(b), redirectUri: app });
    expect(b.oauthStatus(slackId)).toMatchObject({ redirectUri: app, callbackMode: "app" });
    expect(JSON.stringify(b.integrations)).not.toContain("SECRET_CANARY");
  });

  it("rejects non-canonical fixed redirects with oauth_callback_invalid and keeps the previous client", () => {
    const b = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "discovered" });
    for (const redirectUri of [
      "http://localhost:4317/callback",
      "https://localhost:4548/callback",
      "http://localhost/callback",
      "http://localhost:80/callback",
      "http://127.0.0.1:4548/callback?x=1",
      "http://localhost:4548/callback#frag",
      "http://user:pw@localhost:4548/callback",
      "http://localhost:4548/../callback",
      "http://localhost:4548/call%20back",
      "http://example.test:4548/callback",
      "http://[::1]:70000/callback",
      "",
      42,
    ]) {
      let code: string | undefined;
      try {
        b.oauthAction(slackId, "configure", { ...base(b), redirectUri });
      } catch (e) {
        code = (e as MockError).code;
      }
      expect(code, JSON.stringify(redirectUri)).toBe("oauth_callback_invalid");
      expect(b.oauthStates[slackId]!.clientId).toBeUndefined();
    }
    for (const redirectUri of [
      "http://localhost:1024/",
      "http://127.0.0.1:65535/a/b-c_d/",
      "http://[::1]:4548/callback",
    ])
      expect(
        (
          b.oauthAction(slackId, "configure", { ...base(b), redirectUri }) as {
            redirectUri: string;
          }
        ).redirectUri,
      ).toBe(redirectUri);
    expect(
      b.oauthConfigureBodies.map((body) => (body as { redirectUri: string }).redirectUri),
    ).toEqual([
      "http://localhost:1024/",
      "http://127.0.0.1:65535/a/b-c_d/",
      "http://[::1]:4548/callback",
    ]);
  });

  it("fails Connect on an occupied fixed port without changing state, uses the fixed redirect in the authorization URL and clears it on disconnect", () => {
    const b = new MockBackend({
      reviewDelayMs: 0,
      harness: "saved",
      oauth: "configured",
      oauthCallback: "occupied",
    });
    expect(b.oauthStatus(slackId).callbackMode).toBe("fixed-loopback");
    expect(() => b.oauthAction(slackId, "connect", {})).toThrowError(
      /no port was replaced or taken over/,
    );
    expect(b.oauthStatus(slackId).state).toBe("disconnected");
    expect(b.pendingAuthorizations[slackId]).toBeUndefined();
    b.options.oauthCallback = "fixed";
    const started = b.oauthAction(slackId, "connect", {}) as { authorizationUrl: string };
    expect(new URL(started.authorizationUrl).searchParams.get("redirect_uri")).toBe(
      "http://localhost:4548/callback",
    );
    b.oauthAction(slackId, "cancel", {});
    b.oauthAction(slackId, "disconnect", {});
    expect(b.oauthStatus(slackId)).toMatchObject({ redirectUri: app, callbackMode: "app" });
  });
});

describe("MockBackend local OAuth capability disclosure", () => {
  const slackId = "native:claude-slack-mock-identity";
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as MockError).code;
    }
    return undefined;
  };
  const authorizing = () =>
    new MockBackend({ reviewDelayMs: 0, harness: "saved", oauth: "authorizing" });
  const approved = (b: MockBackend) => {
    const preview = b.oauthStates[slackId]!.review!.preview;
    return {
      previewId: preview.id,
      generation: preview.generation,
      additionalScopes: [...preview.additionalScopes],
      consent: OAUTH_SCOPE_CONSENT,
    };
  };

  it("decodes comma and whitespace separators, keeps case, order and every nonempty identifier, and refuses malformed or over-bound sets whole", () => {
    expect(decodeMockOAuthScopes(" ,search:read.public,,B:x ,a:y\tsearch:read.public\n")).toEqual([
      "search:read.public",
      "B:x",
      "a:y",
    ]);
    for (const value of [
      OAUTH_SCOPE_CASES.invalid!,
      "search:read.public bad\x1bcontrol",
      "search:read.public,-leading",
      `search:read.public,${"x".repeat(129)}`,
      Array.from({ length: 129 }, (_, i) => `s:${i}`).join(","),
      "a".repeat(8193),
    ])
      expect(
        code(() => decodeMockOAuthScopes(value)),
        JSON.stringify(value.slice(0, 40)),
      ).toBe("oauth_scopes_invalid");
  });

  it("classifies callbacks into accepted, fallback, approval_required and missing_required with names only in the preview", () => {
    for (const [name, expected] of [
      ["accepted", "accepted"],
      ["fallback", "accepted"],
      ["pending", "approval_required"],
      ["missing", "missing_required"],
    ] as const) {
      const b = authorizing();
      expect(b.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES[name])).toBe(expected);
      const status = b.oauthStatus(slackId);
      expect(status.scopeReview?.status).toBe(expected);
      expect(status.authenticated).toBe(expected === "accepted");
      expect(status.state).toBe(expected === "accepted" ? "authenticated" : "authorizing");
      expect(status.scopes).toEqual(["search:read.public"]);
      expect(JSON.stringify([status, b.integrations])).not.toContain("mock:");
      const preview = b.oauthAction(slackId, "scope-preview", {}) as {
        source: string;
        grantedScopes: string[];
      };
      expect(preview.source).toBe(name === "fallback" ? "requested_fallback" : "provider");
      expect(preview.grantedScopes).toEqual(
        name === "pending"
          ? [
              "search:read.public",
              "mock:additional.capability.canary",
              "mock:second.additional.canary",
            ]
          : name === "missing"
            ? ["mock:additional.capability.canary"]
            : ["search:read.public"],
      );
      expect(b.integrationConfigs.find((c) => c.id === slackId)?.allowedTools).toEqual([]);
    }
    const invalid = authorizing();
    expect(
      code(() => invalid.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.invalid)),
    ).toBe("oauth_scopes_invalid");
    expect(invalid.oauthStatus(slackId)).toMatchObject({ state: "reconnect_required" });
    expect(invalid.oauthStatus(slackId).scopeReview).toBeUndefined();
    expect(code(() => invalid.oauthAction(slackId, "scope-preview", {}))).toBe(
      "oauth_scope_consent_invalid",
    );
  });

  it("accepts only the exact one-use disclosure and refuses filtered, sorted, stale, replayed, missing-required and wrong-browser approvals", () => {
    const b = authorizing();
    b.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.pending);
    const exact = approved(b);
    for (const body of [
      { ...exact, additionalScopes: exact.additionalScopes.slice(0, 1) },
      { ...exact, additionalScopes: [...exact.additionalScopes].reverse() },
      { ...exact, additionalScopes: [...exact.additionalScopes, "mock:hidden.remainder"] },
      { ...exact, previewId: "other" },
      { ...exact, generation: "other" },
      { ...exact, consent: "accept" },
      { ...exact, extra: true },
    ])
      expect(
        code(() => b.oauthAction(slackId, "accept-scopes", body)),
        JSON.stringify(body),
      ).toMatch(/oauth_scope_consent_invalid|oauth_unavailable/);
    expect(b.oauthStatus(slackId).state).toBe("authorizing");
    expect(b.oauthApprovalBodies).toEqual([]);
    const status = b.oauthAction(slackId, "accept-scopes", exact) as {
      state: string;
      scopeReview?: { status: string };
    };
    expect(status.state).toBe("authenticated");
    expect(status.scopeReview?.status).toBe("accepted");
    expect(b.oauthApprovalBodies).toEqual([exact]);
    expect(code(() => b.oauthAction(slackId, "accept-scopes", exact))).toBe(
      "oauth_scope_consent_invalid",
    );
    expect(b.oauthApprovalBodies).toHaveLength(1);
    expect(JSON.stringify(b.integrations)).not.toContain("mock:");

    const missing = authorizing();
    missing.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.missing);
    expect(code(() => missing.oauthAction(slackId, "accept-scopes", approved(missing)))).toBe(
      "oauth_scope_consent_invalid",
    );
    expect(missing.oauthStatus(slackId).authenticated).toBe(false);

    const browser = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauthScopes: "browser" });
    expect(code(() => browser.oauthAction(slackId, "scope-preview", {}))).toBe(
      "oauth_scope_consent_invalid",
    );
    expect(browser.oauthStatus(slackId).scopeReview?.status).toBe("approval_required");
  });

  it("drops the disclosure on cancel, new Connect, disconnect, expiry and storage failure without persisting", () => {
    const cancelled = authorizing();
    cancelled.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.pending);
    cancelled.oauthAction(slackId, "cancel", {});
    expect(cancelled.oauthStatus(slackId)).toMatchObject({
      state: "disconnected",
      remoteRevocation: "not_attempted",
    });
    expect(cancelled.oauthStatus(slackId).scopeReview).toBeUndefined();
    expect(code(() => cancelled.oauthAction(slackId, "scope-preview", {}))).toBe(
      "oauth_scope_consent_invalid",
    );
    expect(cancelled.oauthActions).toEqual(["cancel", "scope-preview"]);

    const reconnected = authorizing();
    reconnected.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.pending);
    const stale = approved(reconnected);
    reconnected.oauthAction(slackId, "cancel", {});
    reconnected.oauthAction(slackId, "connect", {});
    expect(reconnected.oauthStatus(slackId).scopeReview).toBeUndefined();
    expect(code(() => reconnected.oauthAction(slackId, "accept-scopes", stale))).toBe(
      "oauth_scope_consent_invalid",
    );

    const expired = authorizing();
    expired.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.pending);
    expired.oauthStates[slackId]!.review!.preview.expiresAt = new Date(0).toISOString();
    expect(expired.oauthStatus(slackId).scopeReview).toBeUndefined();
    expect(code(() => expired.oauthAction(slackId, "scope-preview", {}))).toBe(
      "oauth_scope_consent_invalid",
    );

    const failing = new MockBackend({
      reviewDelayMs: 0,
      harness: "saved",
      oauthScopes: "pending",
      oauthStorage: "unavailable",
    });
    expect(code(() => failing.oauthAction(slackId, "accept-scopes", approved(failing)))).toBe(
      "credential_store_unavailable",
    );
    expect(failing.oauthStatus(slackId)).toMatchObject({
      state: "reconnect_required",
      authenticated: false,
    });
    expect(failing.oauthStatus(slackId).scopeReview).toBeUndefined();
    expect(failing.oauthApprovalBodies).toEqual([]);

    const disconnected = authorizing();
    disconnected.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.pending);
    disconnected.oauthAction(slackId, "disconnect", {});
    expect(disconnected.oauthStatus(slackId).scopeReview).toBeUndefined();
  });

  it("redeems the names-free review return once per disclosure in the original browser only", () => {
    const b = authorizing();
    b.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.pending);
    const continuation = b.reviewContinuation();
    expect(continuation).toBe(b.oauthStates[slackId]!.review!.preview.id);
    for (const invalid of [{}, { continuation: "unknown" }, { continuation, extra: true }, null])
      expect(code(() => b.reviewReturn(invalid))).toBe("oauth_scope_consent_invalid");
    const returned = b.reviewReturn({ continuation });
    expect(returned).toEqual({
      connectionId: slackId,
      generation: b.oauthStates[slackId]!.generation,
      status: "approval_required",
      expiresAt: b.oauthStatus(slackId).scopeReview!.expiresAt,
    });
    expect(JSON.stringify(returned)).not.toContain("mock:");
    expect(code(() => b.reviewReturn({ continuation }))).toBe("oauth_scope_consent_invalid");
    expect(b.oauthStatus(slackId).scopeReview?.status).toBe("approval_required");
    expect(b.oauthAction(slackId, "scope-preview", {})).toMatchObject({ id: continuation });

    const cancelled = authorizing();
    cancelled.completeOAuthCallback(slackId, "success", OAUTH_SCOPE_CASES.pending);
    const stale = cancelled.reviewContinuation();
    cancelled.oauthAction(slackId, "cancel", {});
    expect(code(() => cancelled.reviewReturn({ continuation: stale }))).toBe(
      "oauth_scope_consent_invalid",
    );

    const browser = new MockBackend({ reviewDelayMs: 0, harness: "saved", oauthScopes: "browser" });
    expect(code(() => browser.reviewReturn({ continuation: browser.reviewContinuation() }))).toBe(
      "oauth_scope_consent_invalid",
    );
    const staleOption = new MockBackend({
      reviewDelayMs: 0,
      harness: "saved",
      oauthScopes: "pending",
      oauthReturn: "stale",
    });
    expect(staleOption.reviewContinuation()).toBe("mock-stale-continuation");
    expect(code(() => staleOption.reviewReturn({ continuation: "mock-stale-continuation" }))).toBe(
      "oauth_scope_consent_invalid",
    );
  });
});

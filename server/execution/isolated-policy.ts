import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessId,
  IsolatedCapabilityPolicy,
  SkillSnapshot,
} from "../../shared/contracts.js";
import { loadSkill } from "./skill.js";
import { digest } from "./policy.js";

export async function isolatedPolicy(
  harness: HarnessId,
  root: string,
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<IsolatedCapabilityPolicy> {
  const provenance: IsolatedCapabilityPolicy["provenance"] = [];
  const record = (
    capability: string,
    state: IsolatedCapabilityPolicy["provenance"][number]["state"],
    message: string,
  ) =>
    provenance.push({
      source: root,
      capability,
      state,
      evidence: "local_configuration",
      message,
    });
  const inherited =
    harness === "claude"
      ? ["model", "effortLevel", "language"]
      : harness === "codex"
        ? [
            "model",
            "model_reasoning_effort",
            "developer_instructions",
            "personality",
          ]
        : [
            "defaultModel",
            "defaultProvider",
            "defaultThinkingLevel",
            "transport",
          ];
  const overridden =
    harness === "claude"
      ? [
          "hooks",
          "enabledPlugins",
          "extraKnownMarketplaces",
          "permissions",
          "disableAllHooks",
          "env",
          "mcpServers",
          "statusLine",
          "apiKeyHelper",
          "forceLoginMethod",
        ]
      : harness === "codex"
        ? [
            "hooks",
            "plugins",
            "features",
            "approval_policy",
            "sandbox_mode",
            "mcp_servers",
            "projects",
            "agents",
            "web_search",
            "notify",
            "skills",
          ]
        : [
            "extensions",
            "packages",
            "defaultProjectTrust",
            "enableSkillCommands",
            "defaultTools",
            "shellPath",
            "shellCommandPrefix",
            "npmCommand",
            "prompts",
            "themes",
            "skills",
          ];
  const preferences: IsolatedCapabilityPolicy["preferences"] = {};
  for (const key of Object.keys(settings)) {
    if (inherited.includes(key))
      record(
        key,
        "inherited",
        "Supported ordinary preference captured; explicit selected model takes precedence.",
      );
    else
      record(
        key,
        overridden.includes(key) ? "overridden" : "unsupported",
        overridden.includes(key)
          ? "Deliberately disabled or replaced by the approved restricted profile."
          : "Not projected by this bounded profile. It cannot grant capabilities.",
      );
  }
  for (const key of harness === "claude"
    ? ["language"]
    : harness === "codex"
      ? ["personality"]
      : ["transport"]) {
    const value = settings[key];
    if (
      typeof value === "string" &&
      value.length < 100 &&
      /^[a-zA-Z -]+$/.test(value)
    )
      preferences[key] = value;
  }
  if (
    harness === "codex" &&
    settings.model_provider &&
    settings.model_provider !== "openai"
  )
    throw new Error(
      "Isolated Codex custom model providers are unsupported; use the native OpenAI profile or explicitly choose another compatible mode.",
    );
  for (const file of harness === "pi"
    ? ["models.json", "SYSTEM.md", "APPEND_SYSTEM.md", "extensions"]
    : ["plugins"]) {
    if (await lstat(path.join(root, file)).catch(() => null))
      record(
        file,
        "overridden",
        "Installed executable/custom provider discovery is deliberately disabled; static skill roots are inspected separately.",
      );
  }
  record(
    "model",
    "overridden",
    "The app-selected resolved model is passed explicitly.",
  );
  record(
    "tools/configuration",
    "overridden",
    "Only app read/checker and captured gateway tools; no shell, project config, inherited executable customizations or publishing. Not OS containment.",
  );
  const providerEnv =
    harness === "claude"
      ? [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
          "CLAUDE_CODE_USE_FOUNDRY",
        ]
      : harness === "codex"
        ? ["OPENAI_BASE_URL"]
        : [];
  if (providerEnv.some((key) => env[key]))
    throw new Error(
      `Isolated ${harness} custom provider environment is unsupported; select the supported native provider configuration or another explicit compatible mode.`,
    );
  if (
    harness === "claude" &&
    env.CLAUDE_CONFIG_DIR &&
    !env.CLAUDE_CODE_OAUTH_TOKEN &&
    !env.ANTHROPIC_API_KEY
  )
    throw new Error(
      "Isolated Claude custom configuration roots require an existing supported model-auth environment reference; custom keychain service lookup is unsupported.",
    );
  if (
    harness === "codex" &&
    settings.cli_auth_credentials_store &&
    settings.cli_auth_credentials_store !== "file"
  )
    throw new Error(
      "Isolated Codex supports its native file login store only; keyring/auto stores are unsupported without a bounded projection.",
    );
  let auth: IsolatedCapabilityPolicy["auth"];
  if (harness === "claude")
    auth = env.ANTHROPIC_API_KEY
      ? { kind: "environment", source: "ANTHROPIC_API_KEY" }
      : env.CLAUDE_CODE_OAUTH_TOKEN
        ? { kind: "environment", source: "CLAUDE_CODE_OAUTH_TOKEN" }
        : { kind: "claude-keychain", source: "Claude Code-credentials" };
  else
    auth = {
      kind: harness === "codex" ? "codex-file" : "pi-file",
      source: path.join(root, "auth.json"),
    };
  const missingAuth =
    ["codex-file", "pi-file"].includes(auth.kind) &&
    !(await lstat(auth.source).catch(() => null));
  record(
    "model authentication",
    missingAuth ? "missing" : "inherited",
    `Execution-time ${auth.kind} reference only; ${missingAuth ? "source file is missing" : "credentials have not been read or tested"}. No login/refresh or cross-harness substitution.`,
  );
  const roots = [
    path.join(root, "skills"),
    ...(harness === "claude" ? [] : [path.join(env.HOME!, ".agents/skills")]),
  ];
  const diagnostics: string[] = [];
  if (harness === "pi" && Array.isArray(settings.skills))
    for (const value of settings.skills) {
      if (
        typeof value !== "string" ||
        /[*?!+]/.test(value) ||
        value.startsWith("-")
      ) {
        diagnostics.push(
          "Pi skill patterns/exclusions are unsupported; use an ordinary trusted native skill root.",
        );
        continue;
      }
      roots.push(
        value.startsWith("~/")
          ? path.join(env.HOME!, value.slice(2))
          : path.resolve(root, value),
      );
    }
  const disabledRoots: string[] = [];
  const configuredSkills = (
    settings.skills as
      { config?: Array<{ path?: unknown; enabled?: unknown }> } | undefined
  )?.config;
  if (harness === "codex" && Array.isArray(configuredSkills))
    for (const item of configuredSkills) {
      if (typeof item.path !== "string" || !path.isAbsolute(item.path)) {
        diagnostics.push(
          "Codex skill overrides require absolute operator-owned directories.",
        );
        continue;
      }
      if (item.enabled === false) disabledRoots.push(item.path);
      else roots.push(item.path);
    }
  const skills: SkillSnapshot[] = [];
  const seen = new Set<string>();
  let entries = 0;
  async function visit(file: string) {
    if (
      disabledRoots.some(
        (root) => file === root || file.startsWith(root + path.sep),
      )
    )
      return;
    if (++entries > 2000)
      throw new Error("Trusted library discovery exceeds 2000 entries");
    const info = await lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      diagnostics.push(`Unsupported symlink skill root/resource: ${file}`);
      return;
    }
    if (info.isDirectory()) {
      if (await lstat(path.join(file, "SKILL.md")).catch(() => null))
        return visit(path.join(file, "SKILL.md"));
      for (const name of (await readdir(file)).sort())
        if (!name.startsWith(".")) await visit(path.join(file, name));
    } else if (info.isFile() && file.endsWith(".md") && !seen.has(file)) {
      if (info.size > 2000000) {
        diagnostics.push(`Oversized library entry: ${file}`);
        return;
      }
      const text = await readFile(file, "utf8");
      if (!/^description:\s*\S/m.test(text)) return;
      seen.add(file);
      if (/!`|^\s*(?:hooks:|context:\s*fork|agent:)/m.test(text)) {
        diagnostics.push(
          `Unavailable executable skill activation semantics: ${file}`,
        );
        return;
      }
      try {
        const skill = await loadSkill(file);
        const prefix = `resources/.native-library/${digest(file).slice(0, 16)}/${skill.directory}`;
        skill.files = skill.files.map((item) => ({
          ...item,
          target: item.target.replace(`resources/${skill.directory}`, prefix),
          executable: false,
        }));
        if (
          skills.length >= 100 ||
          JSON.stringify([...skills, skill]).length > 2000000
        )
          throw new Error("Library exceeds 100 skills or 2 MB");
        skills.push(skill);
      } catch {
        diagnostics.push(
          `Unsupported nonportable or oversized library resources: ${file}`,
        );
      }
    }
  }
  for (const source of [...new Set(roots)]) await visit(source);
  return {
    version: 1,
    profile: "restricted-native-1",
    harness,
    configSource: root,
    configDigest: digest(
      JSON.stringify({
        preferences,
        inherited: Object.fromEntries(
          inherited.map((key) => [key, settings[key]]),
        ),
      }),
    ),
    provenance,
    auth,
    preferences,
    library: {
      digest: digest(JSON.stringify(skills)),
      roots: [...new Set(roots)],
      skills,
      diagnostics,
      loading: harness === "pi" ? "native-pi" : "static-read-catalog",
    },
  };
}

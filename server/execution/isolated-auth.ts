import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IsolatedCapabilityPolicy } from "../../shared/contracts.js";
import { nativeCredentials, piCredentials } from "./auth.js";

export async function isolatedEnvironment(
  policy: IsolatedCapabilityPolicy,
  base: NodeJS.ProcessEnv,
  home: string,
  signal?: AbortSignal,
) {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: base.PATH ?? "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    TMPDIR: path.join(home, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  await mkdir(env.TMPDIR!, { recursive: true, mode: 0o700 });
  const secrets: string[] = [];
  try {
    if (policy.harness === "claude") {
      env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
      await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
      if (policy.auth.kind === "environment") {
        if (
          !["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].includes(
            policy.auth.source,
          )
        )
          throw new Error();
        const value = base[policy.auth.source];
        if (!value || value.length > 16000 || /[\r\n]/.test(value))
          throw new Error();
        env[policy.auth.source] = value;
        secrets.push(value);
      } else if (policy.auth.kind === "claude-keychain") {
        const value = (
          await nativeCredentials(signal, { harness: "claude", nested: [] })
        ).claude.claudeAiOauth.accessToken;
        env.CLAUDE_CODE_OAUTH_TOKEN = value;
        secrets.push(value);
      } else throw new Error();
      env.DISABLE_AUTOUPDATER = "1";
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    } else if (
      policy.harness === "codex" &&
      policy.auth.kind === "codex-file"
    ) {
      env.CODEX_HOME = path.join(home, ".codex");
      await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
      const text = await readFile(policy.auth.source, "utf8");
      if (Buffer.byteLength(text) > 500000) throw new Error();
      const value = JSON.parse(text);
      let auth: unknown;
      if (
        typeof value.OPENAI_API_KEY === "string" &&
        value.OPENAI_API_KEY &&
        !/[\r\n]/.test(value.OPENAI_API_KEY)
      ) {
        auth = { OPENAI_API_KEY: value.OPENAI_API_KEY };
        secrets.push(value.OPENAI_API_KEY);
      } else {
        const t = value.tokens;
        const claims = JSON.parse(
          Buffer.from(t.access_token.split(".")[1], "base64url").toString(
            "utf8",
          ),
        );
        if (
          value.auth_mode !== "chatgpt" ||
          !(claims.exp * 1000 > Date.now() + 300000) ||
          typeof t.id_token !== "string" ||
          typeof t.account_id !== "string"
        )
          throw new Error();
        auth = {
          auth_mode: "chatgpt",
          tokens: {
            access_token: t.access_token,
            id_token: t.id_token,
            account_id: t.account_id,
            refresh_token: "",
          },
        };
        secrets.push(t.access_token, t.id_token);
      }
      await writeFile(
        path.join(env.CODEX_HOME, "auth.json"),
        JSON.stringify(auth),
        { mode: 0o600 },
      );
    } else if (policy.harness === "pi" && policy.auth.kind === "pi-file") {
      env.PI_CODING_AGENT_DIR = path.join(home, ".pi/agent");
      await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
      const auth = piCredentials(await readFile(policy.auth.source, "utf8"));
      secrets.push(auth.access);
      await writeFile(
        path.join(env.PI_CODING_AGENT_DIR, "auth.json"),
        JSON.stringify({
          "openai-codex": { type: "oauth", ...auth, refresh: "" },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(env.PI_CODING_AGENT_DIR, "settings.json"),
        JSON.stringify({
          ...policy.preferences,
          packages: [],
          defaultProjectTrust: "never",
          enableSkillCommands: false,
        }),
        { mode: 0o600 },
      );
      env.PI_OFFLINE = "1";
      env.PI_TELEMETRY = "0";
    } else throw new Error();
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      `Isolated ${policy.harness} model auth is missing, expired or unsupported at the captured ${policy.auth.kind} source. Check this harness's existing login outside the app; no login, refresh or other harness's credentials were used.`,
    );
  }
  return { env, secrets };
}

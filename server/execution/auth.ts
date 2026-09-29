import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../util.js";
import type { WorkflowConfig } from "./config.js";

export interface ModelCredentials {
  pi?: { access: string; expires: number; accountId: string };
  claude: {
    claudeAiOauth: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scopes: string[];
      subscriptionType?: string;
      rateLimitTier?: string;
    };
  };
  codex: {
    auth_mode: "chatgpt";
    tokens: {
      access_token: string;
      id_token: string;
      account_id: string;
      refresh_token: string;
    };
    last_refresh?: string;
  };
}

export const fixtureCredentials = (): ModelCredentials => {
  const expires = Date.now() + 3600000;
  const claims = Buffer.from(
    JSON.stringify({
      sub: "fixture-user",
      exp: Math.floor(expires / 1000),
      email: "fixture@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "fixture-account",
        chatgpt_user_id: "fixture-user",
        chatgpt_plan_type: "plus",
      },
    }),
  ).toString("base64url");
  const access = `eyJhbGciOiJub25lIn0.${claims}.synthetic`;
  return {
    pi: { access, expires, accountId: "fixture-account" },
    claude: {
      claudeAiOauth: {
        accessToken: "synthetic-model-only",
        refreshToken: "",
        expiresAt: Date.now() + 3600000,
        scopes: ["user:inference"],
      },
    },
    codex: {
      auth_mode: "chatgpt",
      tokens: {
        access_token: access,
        id_token: access,
        account_id: "fixture-account",
        refresh_token: "",
      },
    },
  };
};

export function selectedCredentials(
  credentials: ModelCredentials,
  config: Pick<WorkflowConfig, "harness" | "nested">,
): ModelCredentials {
  const required = new Set([config.harness, ...(config.nested ?? [])]);
  return {
    ...(required.has("pi") && credentials.pi ? { pi: credentials.pi } : {}),
    claude: {
      claudeAiOauth: {
        ...credentials.claude.claudeAiOauth,
        accessToken: required.has("claude")
          ? credentials.claude.claudeAiOauth.accessToken
          : "",
        refreshToken: "",
      },
    },
    codex: {
      auth_mode: "chatgpt",
      tokens: {
        access_token: required.has("codex")
          ? credentials.codex.tokens.access_token
          : "",
        id_token: required.has("codex")
          ? credentials.codex.tokens.id_token
          : "",
        account_id: required.has("codex")
          ? credentials.codex.tokens.account_id
          : "",
        refresh_token: "",
      },
    },
  };
}

export function piCredentials(
  text: string,
): NonNullable<ModelCredentials["pi"]> {
  if (Buffer.byteLength(text) > 500000)
    throw new Error("Pi credential source exceeds 500 KB");
  const auth = JSON.parse(text)["openai-codex"];
  if (
    auth?.type !== "oauth" ||
    typeof auth.access !== "string" ||
    auth.access.length > 16000 ||
    /[\r\n]/.test(auth.access)
  )
    throw new Error(
      "Pi requires an existing openai-codex OAuth access credential",
    );
  const claims = JSON.parse(
    Buffer.from(auth.access.split(".")[1], "base64url").toString("utf8"),
  );
  const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (
    !(auth.expires > Date.now() + 300000) ||
    !(claims.exp * 1000 > Date.now() + 300000) ||
    typeof accountId !== "string" ||
    !accountId
  )
    throw new Error(
      "Pi access credential is expired or missing its account identity; no refresh is attempted",
    );
  return { access: auth.access, expires: auth.expires, accountId };
}

export async function nativeCredentials(
  signal: AbortSignal | undefined,
  config: Pick<
    WorkflowConfig,
    "harness" | "nested" | "piAuthFile" | "authHome"
  >,
): Promise<ModelCredentials> {
  signal?.throwIfAborted();
  const required = new Set([config.harness, ...(config.nested ?? [])]);
  if (
    process.platform !== "darwin" ||
    (config.authHome && config.authHome !== os.homedir()) ||
    (required.has("claude") && process.env.CLAUDE_CONFIG_DIR) ||
    (required.has("codex") && process.env.CODEX_HOME)
  )
    throw new Error(
      "Native credential projection requires the captured own-harness macOS login root. Changed HOME or custom Claude/Codex stores are unsupported; no alternate login is substituted",
    );
  let reading = "selected harness";
  try {
    const credentials = fixtureCredentials();
    delete credentials.pi;
    credentials.claude.claudeAiOauth.accessToken = "";
    credentials.codex.tokens.access_token = "";
    credentials.codex.tokens.id_token = "";
    credentials.codex.tokens.account_id = "";
    if (required.has("pi")) {
      reading = "Pi openai-codex OAuth file";
      if (!config?.piAuthFile) throw new Error();
      credentials.pi = piCredentials(await readFile(config.piAuthFile, "utf8"));
    }
    if (required.has("claude")) {
      reading = "Claude default macOS Max keychain entry";
      const stored = await runCommand(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        {
          signal,
          timeoutMs: 10000,
          maxOutputBytes: 64000,
          env: { PATH: "/usr/bin:/bin", HOME: os.homedir() },
        },
      );
      if (stored.code !== 0 || stored.stdoutTruncated) throw new Error();
      let raw = stored.stdout.trim();
      if (/^[0-9a-f]+$/i.test(raw))
        raw = Buffer.from(raw, "hex").toString("utf8");
      const claude = JSON.parse(raw).claudeAiOauth;
      if (
        typeof claude.accessToken !== "string" ||
        !claude.accessToken ||
        !(claude.expiresAt > Date.now() + 300000) ||
        !claude.scopes?.includes("user:inference")
      )
        throw new Error();
      credentials.claude = {
        claudeAiOauth: {
          accessToken: claude.accessToken,
          refreshToken: "",
          expiresAt: claude.expiresAt,
          scopes: claude.scopes,
          subscriptionType: claude.subscriptionType,
          rateLimitTier: claude.rateLimitTier,
        },
      };
    }
    if (required.has("codex")) {
      reading = "Codex default ~/.codex/auth.json ChatGPT login";
      const text = await readFile(
        path.join(os.homedir(), ".codex/auth.json"),
        "utf8",
      );
      if (Buffer.byteLength(text) > 500000) throw new Error();
      const codex = JSON.parse(text);
      const claims = JSON.parse(
        Buffer.from(
          codex.tokens.access_token.split(".")[1],
          "base64url",
        ).toString("utf8"),
      );
      if (
        codex.auth_mode !== "chatgpt" ||
        !(claims.exp * 1000 > Date.now() + 300000) ||
        typeof codex.tokens.account_id !== "string" ||
        typeof codex.tokens.id_token !== "string"
      )
        throw new Error();
      credentials.codex = {
        auth_mode: "chatgpt",
        tokens: {
          access_token: codex.tokens.access_token,
          id_token: codex.tokens.id_token,
          account_id: codex.tokens.account_id,
          refresh_token: "",
        },
        last_refresh: codex.last_refresh,
      };
    }
    return credentials;
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      `${reading} is unavailable, incompatible or expires within five minutes. Check this selected harness's existing login outside the app. Claude supports default macOS Max auth, Codex default ChatGPT auth, and Pi its explicit openai-codex OAuth file. No login, refresh or cross-harness credential substitution was attempted`,
    );
  }
}

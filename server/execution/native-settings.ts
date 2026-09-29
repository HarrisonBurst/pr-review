import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionMode,
  HarnessId,
  ReviewerSettings,
} from "../../shared/contracts.js";
import { codexSettings, settingsObject } from "./projection.js";
import { isolatedPolicy } from "./isolated-policy.js";
import type { IsolatedCapabilityPolicy } from "../../shared/contracts.js";

async function optional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function nativeSettingsRoot(harness: HarnessId, env: NodeJS.ProcessEnv) {
  return harness === "claude"
    ? (env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME!, ".claude"))
    : harness === "codex"
      ? (env.CODEX_HOME ?? path.join(env.HOME!, ".codex"))
      : (env.PI_CODING_AGENT_DIR ?? path.join(env.HOME!, ".pi/agent"));
}

export async function nativeConfiguration(
  harness: HarnessId,
  mode: ExecutionMode,
  model: string | null,
  env: NodeJS.ProcessEnv,
): Promise<
  Pick<ReviewerSettings, "additionalInstructions" | "effort"> & {
    model: string;
    policy?: IsolatedCapabilityPolicy;
  }
> {
  const root = nativeSettingsRoot(harness, env);
  const text = await optional(
    path.join(root, harness === "codex" ? "config.toml" : "settings.json"),
  );
  const settings = text
    ? harness === "codex"
      ? codexSettings(text)
      : settingsObject(text)
    : {};
  const selected =
    model ??
    (harness === "pi"
      ? `${settings.defaultProvider ?? "openai-codex"}/${settings.defaultModel ?? "gpt-6-astra"}`
      : String(
          settings.model ??
            (harness === "claude" ? "claude-fable-5" : "gpt-6-astra"),
        ));
  if (
    mode !== "dangerous" &&
    harness === "pi" &&
    selected.includes("/") &&
    !selected.startsWith("openai-codex/")
  )
    throw new Error(
      "Restricted Pi supports its existing openai-codex OAuth store only. Select openai-codex/model or explicitly choose Dangerous for other native providers.",
    );
  const effort =
    settings[
      harness === "claude"
        ? "effortLevel"
        : harness === "codex"
          ? "model_reasoning_effort"
          : "defaultThinkingLevel"
    ];
  if (
    mode === "separated" &&
    effort !== undefined &&
    !["low", "medium", "high"].includes(String(effort))
  )
    throw new Error(
      `Isolated ${harness} cannot preserve effort ${effort}; this profile supports low/medium/high. Choose a compatible mode explicitly.`,
    );
  const instructions =
    mode === "separated"
      ? [
          await optional(
            path.join(root, harness === "claude" ? "CLAUDE.md" : "AGENTS.md"),
          ),
          settings.developer_instructions,
        ]
          .filter(Boolean)
          .join("\n\n")
      : "";
  return {
    ...(mode === "separated"
      ? { policy: await isolatedPolicy(harness, root, settings, env) }
      : {}),
    model: selected,
    additionalInstructions: instructions,
    ...(mode === "separated" && effort
      ? { effort: effort as ReviewerSettings["effort"] }
      : {}),
  };
}

export async function nativeModel(
  harness: HarnessId,
  mode: ExecutionMode,
  model: string | null,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return (await nativeConfiguration(harness, mode, model, env)).model!;
}

import os from "node:os";
import path from "node:path";

import type { ReviewerSettings } from "../shared/contracts.js";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  demo: boolean;
  workflowConfigPath?: string | null;
  reviewer: ReviewerSettings;
}

const asBoolean = (value: string | undefined) =>
  value === "1" || value === "true";

export function defaultDataDir(demo: boolean): string {
  if (process.env.PR_REVIEW_DATA_DIR) return process.env.PR_REVIEW_DATA_DIR;
  const root =
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), "Library", "Application Support");
  return path.join(root, demo ? "pr-review-demo" : "pr-review");
}

export function loadConfig(options: Partial<AppConfig> = {}): AppConfig {
  const demo = options.demo ?? asBoolean(process.env.PR_REVIEW_DEMO);
  const dataDir = options.dataDir ?? defaultDataDir(demo);
  return {
    host: options.host ?? process.env.PR_REVIEW_HOST ?? "127.0.0.1",
    port: options.port ?? Number(process.env.PR_REVIEW_PORT ?? 4317),
    dataDir,
    databasePath:
      options.databasePath ??
      process.env.PR_REVIEW_DB_PATH ??
      path.join(dataDir, "pr-review.sqlite"),
    demo,
    reviewer: options.reviewer ?? {
      skillPath:
        process.env.PR_REVIEW_SKILL_PATH ??
        path.join(os.homedir(), ".claude", "skills", "pr-review", "SKILL.md"),
      model: process.env.PR_REVIEW_MODEL ?? null,
      additionalInstructions:
        process.env.PR_REVIEW_ADDITIONAL_INSTRUCTIONS ?? "",
    },
  };
}

import type {
  CapturedHarnessEntry,
  ExecutionMode,
  HarnessEntryEvidence,
  HarnessId,
  ReviewRun,
  ReviewerSettings,
} from "../../../shared/contracts";
import { requireSupportedExecution } from "../../../server/execution/supported";

export const modeLabel: Record<ExecutionMode, string> = {
  separated: "Isolated Harnesses",
  docker: "Docker",
  dangerous: "Dangerous",
};

export const harnessLabel: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

export const roleText = (entry: Pick<CapturedHarnessEntry, "harness" | "model">) =>
  `${harnessLabel[entry.harness]} · ${entry.model}`;

export interface CapturedExecution {
  label: string;
  model: string;
  skill: string;
  note: string;
  archived: boolean;
  main: CapturedHarnessEntry | null;
  additional: CapturedHarnessEntry[];
}

export const ARCHIVED_LABEL = "Archived execution (not rerunnable)";

const ARCHIVED_NOTE = "Kept for display only; this capture is unsupported for execution.";

export function supportedCapture(reviewer: ReviewerSettings | undefined): boolean {
  try {
    requireSupportedExecution(reviewer);
    return true;
  } catch {
    return false;
  }
}

type Shape = Omit<CapturedExecution, "archived">;

function shapeOf(reviewer: ReviewerSettings): Shape {
  const model = reviewer.model ?? "native default";
  const skillExecution = reviewer.skillExecution;
  if (skillExecution?.version === 3) {
    const { roles, harness, skill } = skillExecution;
    const count = roles.additional.length;
    return {
      label: `${modeLabel.separated} · Main ${harnessLabel[harness]}`,
      model: roles.main.model,
      skill: skill.path,
      note:
        count > 0
          ? `Captured orchestration: ${count} Additional ${count === 1 ? "reviewer" : "reviewers"} in order, then Main verification and synthesis into one draft. Restricted native tools, not OS containment.`
          : "Captured orchestration: Main alone with the full review entry. Restricted native tools, not OS containment.",
      main: roles.main,
      additional: roles.additional,
    };
  }
  if (skillExecution?.version === 2) {
    const { mode, harness, skill } = skillExecution;
    return {
      label: `${modeLabel[mode]} · ${harnessLabel[harness]}`,
      model,
      skill: skill.path,
      note:
        mode === "dangerous"
          ? "Captured host consent: native tools and auth unrestricted by the app."
          : mode === "docker"
            ? reviewer.execution?.docker?.profile === "container-native-1"
              ? "Captured skill orchestration inside the approved container-native-1 boundary with frozen skill bytes and the exact approved disclosure."
              : "Captured Docker orchestration from before explicit container capability approval."
            : "Single-primary Isolated capture from before Main/Additional roles.",
      main: null,
      additional: [],
    };
  }
  if (reviewer.hostExecution)
    return {
      label: `${modeLabel.dangerous} · ${harnessLabel[reviewer.hostExecution.harness]}`,
      model,
      skill: reviewer.skillPath,
      note: "Host consent recorded without a paired execution capture.",
      main: null,
      additional: [],
    };
  if (reviewer.execution) {
    const { harness, version, models } = reviewer.execution;
    return {
      label: `Docker v${version} · ${harnessLabel[harness]}`,
      model: harness === "claude" ? models.claude : models.codex,
      skill: reviewer.skillPath,
      note: "Configured Docker snapshot without a paired skill capture; its historical tool inventory is unchanged.",
      main: null,
      additional: [],
    };
  }
  return {
    label: "",
    model,
    skill: reviewer.skillPath,
    note: "Recorded before captured execution existed; no current mode is inferred from it.",
    main: null,
    additional: [],
  };
}

export function capturedExecution(reviewer: ReviewerSettings): CapturedExecution {
  const shape = shapeOf(reviewer);
  if (supportedCapture(reviewer)) return { ...shape, archived: false };
  return {
    ...shape,
    label: shape.label ? `${ARCHIVED_LABEL} · ${shape.label}` : ARCHIVED_LABEL,
    note: `${shape.note} ${ARCHIVED_NOTE}`,
    archived: true,
  };
}

const outcomeOrder: HarnessEntryEvidence["status"][] = [
  "completed",
  "failed",
  "interrupted",
  "skipped",
  "running",
  "pending",
];

const statusOutcome: Record<ReviewRun["status"], string> = {
  queued: "Queued; nothing has run yet.",
  running: "Running; no per-entry evidence recorded yet.",
  completed: "Completed.",
  failed: "Failed; no draft was produced.",
  interrupted: "Interrupted; no draft was produced.",
};

export function runOutcome(run: Pick<ReviewRun, "status" | "result" | "progress">): string {
  const entries = run.progress?.entries ?? [];
  if (entries.length === 0)
    return run.status === "completed" && run.result
      ? `Completed with ${run.result.findings.length} findings.`
      : statusOutcome[run.status];
  const groups = outcomeOrder.flatMap((status) => {
    const ids = entries.filter((entry) => entry.status === status).map((entry) => entry.id);
    return ids.length ? [`${status}: ${ids.join(", ")}`] : [];
  });
  const draft =
    run.status === "completed" && run.result
      ? ` One draft with ${run.result.findings.length} findings.`
      : run.status === "failed" || run.status === "interrupted"
        ? " No draft was produced."
        : "";
  return `${groups.join(" · ")}.${draft}`;
}

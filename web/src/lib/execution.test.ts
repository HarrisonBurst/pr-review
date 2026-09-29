import { describe, expect, it } from "vitest";
import type { ReviewRun, ReviewerSettings } from "../../../shared/contracts";
import { ARCHIVED_LABEL, capturedExecution, runOutcome, supportedCapture } from "./execution";
import {
  archivedIsolatedReviewer,
  capturedDangerousReviewer,
  capturedDockerReviewer,
  capturedHostReviewer,
  capturedSkillReviewer,
  entryEvidence,
  historyRuns,
  markerlessDockerReviewer,
  policylessSkillReviewer,
  reviewer,
  unpairedDockerReviewer,
} from "../mock/fixtures";

const docker: ReviewerSettings = {
  ...reviewer,
  execution: {
    version: 1,
    digest: "d",
    image: "sha256:i",
    policy: "p",
    broker: "b",
    models: { claude: "claude-fable-5", codex: "gpt-6-astra" },
    harness: "pi",
    skillDigest: "s",
    fixture: true,
  },
};

describe("capturedExecution", () => {
  it("labels current v3 roles from the capture with neutral orchestration wording", () => {
    const captured = capturedExecution(capturedSkillReviewer);
    expect(captured).toMatchObject({
      label: "Isolated Harnesses · Main Claude Code",
      model: "fixture-main",
      skill: capturedSkillReviewer.skillPath,
      archived: false,
    });
    expect(captured.note).toMatch(/^Captured orchestration: 2 Additional reviewers in order/);
    expect(captured.note).not.toMatch(/ran|performed|synthesized/);
    expect(captured.main?.id).toBe("main");
    expect(captured.additional.map((entry) => [entry.id, entry.harness, entry.model])).toEqual([
      ["reviewer-1", "codex", "model-one"],
      ["reviewer-2", "codex", "model-two"],
    ]);
    const v3 = capturedSkillReviewer.skillExecution!;
    if (v3.version !== 3) throw new Error("fixture is not v3");
    expect(
      capturedExecution({
        ...capturedSkillReviewer,
        skillExecution: { ...v3, roles: { ...v3.roles, additional: [] } },
      }).note,
    ).toMatch(/^Captured orchestration: Main alone with the full review entry/);
  });

  it("archives v3 captures that lack per-role policy or carry contradictory snapshots, keeping recorded roles", () => {
    const policyless = capturedExecution(policylessSkillReviewer);
    expect(policyless).toMatchObject({
      label: `${ARCHIVED_LABEL} · Isolated Harnesses · Main Claude Code`,
      model: "fixture-main",
      skill: policylessSkillReviewer.skillPath,
      archived: true,
    });
    expect(policyless.note).toMatch(/unsupported for execution/);
    expect(policyless.additional.map((entry) => entry.id)).toEqual(["reviewer-1", "reviewer-2"]);
    expect(
      capturedExecution({
        ...capturedSkillReviewer,
        hostExecution: capturedHostReviewer.hostExecution,
      }),
    ).toMatchObject({ label: `${ARCHIVED_LABEL} · Isolated Harnesses · Main Claude Code` });
    expect(supportedCapture(capturedSkillReviewer)).toBe(true);
    expect(supportedCapture(policylessSkillReviewer)).toBe(false);
    expect(supportedCapture(undefined)).toBe(false);
  });

  it("keeps only paired Dangerous and Docker v2 captures current", () => {
    expect(capturedExecution(capturedDangerousReviewer)).toMatchObject({
      label: "Dangerous · Pi",
      model: "gpt-6-astra",
      archived: false,
    });
    expect(capturedExecution(capturedHostReviewer)).toMatchObject({
      label: `${ARCHIVED_LABEL} · Dangerous · Pi`,
      model: "gpt-6-astra",
      archived: true,
    });
    expect(capturedExecution(capturedDockerReviewer)).toMatchObject({
      label: "Docker · Codex",
      archived: false,
    });
    expect(capturedExecution(capturedDockerReviewer).note).toMatch(
      /approved container-native-1 boundary/,
    );
    expect(capturedExecution(markerlessDockerReviewer)).toMatchObject({
      label: `${ARCHIVED_LABEL} · Docker · Codex`,
      archived: true,
    });
    expect(capturedExecution(markerlessDockerReviewer).note).toMatch(
      /before explicit container capability approval/,
    );
    const approved = capturedDockerReviewer.execution!.docker!;
    expect(
      capturedExecution({
        ...capturedDockerReviewer,
        execution: {
          ...capturedDockerReviewer.execution!,
          docker: { ...approved, approval: { ...approved.approval, digest: "other" } },
        },
      }).archived,
    ).toBe(true);
    expect(capturedExecution(unpairedDockerReviewer)).toMatchObject({
      label: `${ARCHIVED_LABEL} · Docker · Codex`,
      archived: true,
    });
    expect(
      capturedExecution({
        ...capturedDockerReviewer,
        execution: { ...capturedDockerReviewer.execution!, harness: "claude" },
      }).archived,
    ).toBe(true);
    expect(
      capturedExecution({
        ...capturedDangerousReviewer,
        execution: capturedDockerReviewer.execution,
      }).archived,
    ).toBe(true);
  });

  it("archives single-primary, execution-only and absent captures", () => {
    expect(capturedExecution(archivedIsolatedReviewer)).toMatchObject({
      label: `${ARCHIVED_LABEL} · Isolated Harnesses · Codex`,
      model: "fixture-primary",
      archived: true,
    });
    expect(capturedExecution(docker)).toMatchObject({
      label: `${ARCHIVED_LABEL} · Docker v1 · Pi`,
      model: "gpt-6-astra",
      archived: true,
    });
    expect(capturedExecution(reviewer)).toMatchObject({
      label: ARCHIVED_LABEL,
      model: "native default",
      skill: reviewer.skillPath,
      archived: true,
    });
  });
});

describe("runOutcome", () => {
  const run = (id: string) => historyRuns.find((item) => item.id === id)!;
  const bare = (
    status: ReviewRun["status"],
  ): Pick<ReviewRun, "status" | "result" | "progress"> => ({
    status,
    result: null,
    progress: null,
  });

  it("derives outcome only from entries, result and status", () => {
    expect(runOutcome(run("run-h-queued"))).toBe("pending: reviewer-1, reviewer-2, main.");
    expect(runOutcome(run("run-h-failed"))).toBe(
      "completed: reviewer-1 · failed: reviewer-2 · skipped: main. No draft was produced.",
    );
    expect(runOutcome(run("run-h-interrupted"))).toBe(
      "completed: reviewer-1 · interrupted: reviewer-2 · skipped: main. No draft was produced.",
    );
    expect(
      runOutcome({
        status: "completed",
        result: run("run-h-policyless").result,
        progress: { ...run("run-h-policyless").progress!, entries: entryEvidence },
      }),
    ).toBe("completed: reviewer-1, main · failed: reviewer-2. One draft with 1 findings.");
    expect(runOutcome(bare("queued"))).toBe("Queued; nothing has run yet.");
    expect(runOutcome(bare("running"))).toBe("Running; no per-entry evidence recorded yet.");
    expect(runOutcome(bare("failed"))).toBe("Failed; no draft was produced.");
    expect(runOutcome(run("run-h-host-only"))).toBe("Completed with 1 findings.");
  });
});

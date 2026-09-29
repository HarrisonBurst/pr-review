import type {
  ArchivedHarnessSelection,
  HarnessSelection,
  ReviewerSettings,
} from "../../shared/contracts.js";

export const executionUpgradeAction =
  "This saved execution is no longer supported. History is unchanged. Explicitly save Isolated Main/Additional, Docker or Dangerous in Settings, then start a new review or independent question. Old questions cannot be retried or continued with different permissions.";

export function currentSelection(
  selection: ArchivedHarnessSelection | null,
): selection is HarnessSelection {
  return Boolean(
    selection?.reviewer &&
    !selection.sourceId &&
    ((selection.version === 3 &&
      selection.workflow === "separated" &&
      Array.isArray(selection.additional)) ||
      (selection.version === 2 &&
        ["docker", "dangerous"].includes(selection.workflow))),
  );
}

export function requireSupportedExecution(
  settings: ReviewerSettings | undefined,
): asserts settings is ReviewerSettings {
  const skill = settings?.skillExecution;
  if (!skill) throw new Error(executionUpgradeAction);
  if (skill.version === 3 && skill.mode === "separated") {
    const entries = skill.roles && [
      skill.roles.main,
      ...skill.roles.additional,
    ];
    if (
      !settings?.execution &&
      !settings?.hostExecution &&
      entries?.length &&
      entries.every(
        (entry) =>
          entry.policy?.profile === "restricted-native-1" &&
          entry.policy.version === 1 &&
          entry.policy.harness === entry.harness &&
          Boolean(entry.model),
      ) &&
      skill.policy?.profile === "restricted-native-1" &&
      skill.policy.version === 1 &&
      skill.policy.harness === skill.harness
    )
      return;
  }
  if (skill.version === 2 && skill.mode === "docker") {
    const execution = settings?.execution;
    if (
      !settings?.hostExecution &&
      execution?.version === 2 &&
      execution.docker?.profile === "container-native-1" &&
      execution.docker.approval?.digest ===
        execution.docker.disclosure?.digest &&
      execution.harness === skill.harness &&
      execution.sourceId &&
      /^[a-f0-9]{32}$/.test(execution.sourceId)
    )
      return;
  }
  if (skill.version === 2 && skill.mode === "dangerous") {
    const consent = settings?.hostExecution;
    if (
      !settings?.execution &&
      consent?.version === 1 &&
      consent.harness === skill.harness &&
      consent.confirmedAt
    )
      return;
  }
  throw new Error(executionUpgradeAction);
}

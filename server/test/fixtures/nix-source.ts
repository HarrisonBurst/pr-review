import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function nixSourceFixture(root: string) {
  const home = path.join(root, "home");
  const store = path.join(root, "nix/store");
  const skillPath = path.join(home, ".claude/skills/pr-review/SKILL.md");
  const middle = path.join(
    store,
    "aaaaaaaa-home-manager-files/.claude/skills/pr-review/SKILL.md",
  );
  const terminal = path.join(store, "bbbbbbbb-hm_SKILL.md");
  const content =
    "# SYNTHETIC NIX CAPTURE FIXTURE\nReview with codex exec. See [rubric](rubric.md).\n";
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(path.dirname(middle), { recursive: true });
  await writeFile(terminal, content);
  await symlink(terminal, middle);
  await symlink(middle, skillPath);
  for (const suffix of [".symlink-backup", ".nix-backup"])
    await symlink(
      path.join(store, "stale-generation-do-not-read"),
      skillPath + suffix,
    );
  await writeFile(
    path.join(path.dirname(skillPath), "rubric.md"),
    "FROZEN RUBRIC",
  );
  await writeFile(
    path.join(store, "auth.json"),
    "UNRELATED_STORE_CREDENTIAL_CANARY",
  );
  const settingsPath = path.join(home, ".claude/settings.json");
  const settingsMiddle = path.join(
    store,
    "aaaaaaaa-home-manager-files/.claude/settings.json",
  );
  const settingsTerminal = path.join(store, "cccccccc-hm_settings.json");
  await writeFile(
    settingsTerminal,
    JSON.stringify({ model: "claude-fable-5", effortLevel: "medium" }),
  );
  await symlink(settingsTerminal, settingsMiddle);
  await symlink(settingsMiddle, settingsPath);
  return {
    home,
    store,
    skillPath,
    middle,
    terminal,
    content,
    settingsPath,
    settingsTerminal,
  };
}

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export async function writeGoogleWorkspaceFixture(home: string) {
  const root = path.join(home, ".claude/skills/synced/fixture");
  const files = [
    "SKILL.md",
    "references/charts.md",
    "references/docs.md",
    "references/sheets.md",
    "references/slides.md",
    "scripts/docs_index.py",
    "scripts/render_export.py",
    "scripts/sheets_helper.py",
    "scripts/slides_helper.py",
  ];
  for (const file of files) {
    const target = path.join(root, "google-workspace", file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `Synthetic Google omission fixture: ${file}\n`, {
      mode: file.endsWith(".py") ? 0o755 : 0o644,
    });
  }
  await mkdir(path.join(root, "kept"));
  await writeFile(
    path.join(root, "kept/SKILL.md"),
    "Synthetic retained skill\n",
  );
  const value = {
    lastUpdated: 1,
    skills: [
      { skillId: "kept", name: "kept", description: "Retained fixture" },
      {
        skillId: "google-workspace",
        name: "google-workspace",
        description: "Synthetic omitted fixture, never execute",
        source: "fixture",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
    pendingClaims: ["fixture/kept", "fixture/google-workspace"],
    retainedMetadata: { nested: ["unchanged"] },
  };
  const manifest = path.join(root, "manifest.json");
  const original = JSON.stringify(value, null, 2);
  await writeFile(manifest, original);
  return { root, files, value, manifest, original };
}

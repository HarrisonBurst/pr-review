import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewService } from "../../service.js";

export async function saveFixtureExecution(service: ReviewService) {
  const home = path.join(service.config.dataDir, "deterministic-native-home");
  const skillPath = path.join(home, "review/ENTRY.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(
    skillPath,
    "# Deterministic test skill\nReview the supplied fixture.",
  );
  const settings = await service.executor!.prepareSelection(
    {
      version: 3,
      workflow: "separated",
      harness: "claude",
      additional: [],
      reviewer: { skillPath, model: "fixture-model" },
    },
    { HOME: home, PATH: path.dirname(process.execPath) },
  );
  service.db.updateHarness(settings);
  service.executor!.update(settings);
}

import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../config.js";
import { supportedImage } from "../../execution/policy.js";
import { inspectDockerCapabilities } from "../../execution/docker-capabilities.js";
import { dockerApprovalConfirmation } from "../../../shared/contracts.js";

export async function workflowFixture(root: string) {
  const bundle = path.join(root, "bundle");
  await mkdir(bundle);
  await copyFile(
    new URL("workflow.mjs", import.meta.url),
    path.join(bundle, "fixture.mjs"),
  );
  const workflowConfigPath = path.join(root, "workflow.json");
  const skillPath = path.join(root, "skill/SKILL.md");
  await mkdir(path.dirname(skillPath));
  await writeFile(
    skillPath,
    "Clearly labeled synthetic provider boundary fixture: codex exec",
  );
  await writeFile(
    workflowConfigPath,
    JSON.stringify({
      version: 2,
      nested: ["codex"],
      harness: "claude",
      image: supportedImage,
      bundle,
      auth: "fixture",
      models: { claude: "fixture-claude", codex: "fixture-codex" },
      effort: "low",
    }),
  );
  const app = {
    ...loadConfig({
      demo: true,
      dataDir: root,
      databasePath: path.join(root, "app.sqlite"),
      workflowConfigPath,
      reviewer: { skillPath, model: null, additionalInstructions: "" },
    }),
    workflowConfigPath,
  };
  const inspected = await inspectDockerCapabilities(
    { ...app, reviewer: { ...app.reviewer, model: "fixture-claude" } },
    "claude",
    { HOME: root },
  );
  const config = JSON.parse(await readFile(workflowConfigPath, "utf8"));
  config.docker = {
    profile: "container-native-1",
    disclosure: inspected.disclosure,
    approval: {
      digest: inspected.disclosure.digest,
      customizations: [],
      credentialExposures: inspected.disclosure.authentication.map(
        (item) => item.harness,
      ),
      confirmation: dockerApprovalConfirmation,
    },
  };
  await writeFile(workflowConfigPath, JSON.stringify(config));
  return app;
}

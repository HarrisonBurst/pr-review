import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const script = process.argv[2];
if (!script || !existsSync("web/package.json")) process.exit(0);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", script, "--workspace", "web"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [spawn(npm, ["run", "dev:backend"], { stdio: "inherit" })];
if (existsSync("web/package.json"))
  children.push(
    spawn(npm, ["run", "dev", "--workspace", "web"], { stdio: "inherit" }),
  );
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 100);
};
for (const child of children)
  child.once("exit", (code) => {
    if (!stopping && code !== 0) stop(code ?? 1);
  });
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());

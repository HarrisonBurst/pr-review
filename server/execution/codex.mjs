#!/usr/local/bin/node
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (
  args.some(
    (arg) => arg.startsWith("--dangerously-") || arg === "--ignore-user-config",
  )
) {
  process.stderr.write(
    "Keep the supplied workflow configuration and permissions\n",
  );
  process.exit(1);
}
const home = await mkdtemp("/scratch/codex-session-");
await cp("/scratch/.codex", home, { recursive: true });
const config = await readFile(`${home}/config.toml`, "utf8");
await writeFile(
  `${home}/config.toml`,
  config.replaceAll("/scratch/.codex/config.toml:", `${home}/config.toml:`),
);
const child = spawn(
  "/artifacts/codex/package/vendor/aarch64-unknown-linux-musl/bin/codex",
  args,
  {
    stdio: "inherit",
    env: { ...process.env, CODEX_HOME: home },
  },
);
child.on("error", () => process.exit(127));
child.on("exit", (code) => process.exit(code ?? 1));

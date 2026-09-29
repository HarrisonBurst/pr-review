import { createHash } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`Runtime installation failed: ${command}`);
};
const packages = [
  [
    "claude",
    "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64-musl/-/claude-code-linux-arm64-musl-2.1.280.tgz",
    "sha512-SCpowU8dQo7tlh0m0Pp6KByEtfLtQYNu9QTGSWT3CZ8XlxStT45z8q7DWdm5/WVpR5iFmQJbqT7y9BSPsT0G/Q==",
  ],
  [
    "codex",
    "https://registry.npmjs.org/@openai/codex/-/codex-0.155.0-linux-arm64.tgz",
    "sha512-iMyMjIYHlBUUDeTEGeEftQozQz0h7nYYCaLDJlZnqDF2Y0+bfdD/ppDS3vsw6mIz/z49haC6TCer11iEWO6fsA==",
  ],
  [
    "pi",
    "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.1.tgz",
    "sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==",
  ],
];
for (const [name, url, integrity] of packages) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(`Unable to download pinned ${name} runtime`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
    integrity
  )
    throw new Error(`Publisher integrity mismatch for ${name}`);
  const destination = `/bundle/artifacts/${name}`;
  await mkdir(destination, { recursive: true });
  const tarball = `/tmp/${name}.tgz`;
  await writeFile(tarball, bytes);
  if (name === "pi") {
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        tarball,
      ],
      destination,
    );
  } else run("tar", ["-xzf", tarball, "-C", destination]);
  await rm(tarball);
}
run("apk", [
  "--root",
  "/bundle/runtime",
  "--initdb",
  "--no-scripts",
  "--keys-dir",
  "/etc/apk/keys",
  "--repositories-file",
  "/etc/apk/repositories",
  "add",
  "bash=5.3.9-r1",
  "git=2.54.0-r0",
  "ripgrep=15.1.0-r0",
]);

#!/usr/local/bin/node
import { readFile } from "node:fs/promises";
const client = JSON.parse(await readFile("/scratch/client.json", "utf8"));
const args = process.argv.slice(2);
const valid =
  args[0] === "pr" &&
  ["view", "diff"].includes(args[1]) &&
  /^(?:\d+(?: --json [A-Za-z,]+)?|--json [A-Za-z,]+)?$/.test(
    args.slice(2).join(" "),
  );
if (!valid) {
  process.stderr.write(
    "Only this run's immutable PR view and diff are available; publishing is unavailable\n",
  );
  process.exit(1);
}
async function read(method) {
  const response = await fetch(`${client.base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${client.capability}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "pull_request_read", arguments: { method } },
    }),
  });
  if (!response.ok) process.exit(1);
  const result = await response.json();
  return JSON.parse(result.result.content[0].text);
}
const metadata = await read("get");
const requested = args.slice(2).find((arg) => /^\d+$/.test(arg));
if (requested && Number(requested) !== metadata.number) process.exit(1);
const value = args[1] === "view" ? metadata : await read("get_files");
process.stdout.write(
  (args[1] === "view"
    ? JSON.stringify(value)
    : value.diff + (value.truncated ? "\n[Snapshot diff truncated]" : "")) +
    "\n",
);

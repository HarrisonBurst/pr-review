import { createHash } from "node:crypto";
import defaults from "./seccomp-default.json" with { type: "json" };

export const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const allow = (name: string, index: number, value: number) => ({
  names: [name],
  action: "SCMP_ACT_ALLOW",
  args: [{ index, value, op: "SCMP_CMP_EQ" }],
});

export const policy = JSON.stringify({
  ...defaults,
  syscalls: [
    ...defaults.syscalls,
    allow("clone", 0, 0x78020011),
    allow("clone", 0, 0x38020011),
    ...[
      6, 10, 0x8c000, 0xc0edd000, 0xd000, 0x209027, 0x20902f, 0x9027, 0x4c000,
    ].map((flags) => allow("mount", 3, flags)),
    { names: ["pivot_root"], action: "SCMP_ACT_ALLOW" },
    allow("umount2", 1, 2),
    allow("unshare", 0, 0x10000000),
  ],
});

export const policyDigest = digest(policy);
export const supportedImage =
  "sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";

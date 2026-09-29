import { mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";

export const portableResourceLimits = {
  sources: 100,
  entries: 2000,
  fileBytes: 2000000,
  decodedBytes: 2000000,
};
export const dockerResourceLimits = {
  ...portableResourceLimits,
  decodedBytes: 8000000,
  serializedBytes: 16000000,
  workflowBytes: 32000000,
  initializeBytes: 20000000,
  inputBufferBytes: 24000000,
};

export const executables = {
  claude: "/artifacts/claude/package/claude",
  codex: "/artifacts/codex/package/vendor/aarch64-unknown-linux-musl/bin/codex",
  pi: "/artifacts/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
};

const tomlValue = (value) =>
  Array.isArray(value)
    ? `[${value.map(tomlValue).join(", ")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}`)
          .join(", ")}}`
      : JSON.stringify(value);

export function companionMediaType(file, bytes) {
  if (
    file.executable !== false ||
    file.target
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.includes("\\"),
      ) ||
    !/^(?:(?:\.claude|\.codex|\.agents|\.pi\/agent)\/skills\/.+|resources\/[^./][^/]*)\/assets\/.+\.(woff2|png)$/.test(
      file.target,
    ) ||
    bytes.length > portableResourceLimits.fileBytes
  )
    return undefined;
  if (file.target.endsWith(".woff2"))
    return bytes.length > 48 &&
      bytes.readUInt32BE(0) === 0x774f4632 &&
      [0x00010000, 0x4f54544f].includes(bytes.readUInt32BE(4)) &&
      bytes.readUInt32BE(8) === bytes.length &&
      bytes.readUInt16BE(12) > 0 &&
      bytes.readUInt16BE(14) === 0 &&
      bytes.readUInt32BE(20) > 0 &&
      bytes.readUInt32BE(20) < bytes.length - 48
      ? "font/woff2"
      : undefined;
  const depths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return bytes.length >= 57 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(16) <= 0x7fffffff &&
    bytes.readUInt32BE(20) > 0 &&
    bytes.readUInt32BE(20) <= 0x7fffffff &&
    depths[bytes[25]]?.includes(bytes[24]) &&
    bytes[26] === 0 &&
    bytes[27] === 0 &&
    [0, 1].includes(bytes[28]) &&
    bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
    ? "image/png"
    : undefined;
}

export function resourceBytes(file, docker = false) {
  if (typeof file.content !== "string")
    throw new Error("Invalid captured resource content");
  if (file.encoding === undefined || file.encoding === "utf8") {
    if (
      file.mediaType !== undefined ||
      file.content.includes("\0") ||
      file.content.includes("\ufffd")
    )
      throw new Error("Captured text resources must remain UTF-8");
    if (
      Buffer.byteLength(file.content, "utf8") > portableResourceLimits.fileBytes
    )
      throw new Error("Captured resource exceeds 2 MB per-file limit");
    return Buffer.from(file.content, "utf8");
  }
  if (
    file.encoding !== "base64" ||
    !docker ||
    !["font/woff2", "image/png"].includes(file.mediaType) ||
    file.content.length > 2666668
  )
    throw new Error("Unsupported captured resource encoding or execution mode");
  const bytes = Buffer.from(file.content, "base64");
  if (
    bytes.toString("base64") !== file.content ||
    companionMediaType(file, bytes) !== file.mediaType
  )
    throw new Error(
      "Captured opaque companion identity or encoding is invalid",
    );
  return bytes;
}

export function dockerInputFrame(input) {
  const frame = JSON.stringify({ type: "initialize", ...input }) + "\n";
  if (Buffer.byteLength(frame) > dockerResourceLimits.initializeBytes)
    throw new Error(
      "Docker initialization exceeds 20 MB serialized frame limit",
    );
  return frame;
}

export async function configureHarnesses(init, base, environment) {
  for (const dir of [".pi/agent/extensions", ".claude", ".codex", "resources"])
    await mkdir(`/scratch/${dir}`, { recursive: true });
  const files = init.files ?? [];
  if (
    files.length > dockerResourceLimits.entries ||
    Buffer.byteLength(JSON.stringify(files)) >
      dockerResourceLimits.serializedBytes
  )
    throw new Error(
      "Captured Docker resources exceed 2000 files or 16 MB serialized data",
    );
  let decodedBytes = 0;
  const contents = files.map((file) => {
    const bytes = resourceBytes(file, true);
    decodedBytes += bytes.length;
    if (decodedBytes > dockerResourceLimits.decodedBytes)
      throw new Error("Captured Docker resources exceed 8 MB decoded bytes");
    return bytes;
  });
  for (const [index, file] of files.entries()) {
    const target = `/scratch/${file.target}`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents[index], {
      mode: file.executable ? 0o700 : 0o600,
    });
  }
  const settings = init.projectedSettings ?? {};
  await writeFile(
    "/scratch/.claude/settings.json",
    JSON.stringify({
      ...settings.claude,
      model: init.models.claude,
      effortLevel: init.effort,
    }),
  );
  const codex = {
    ...settings.codex,
    model: init.models.codex,
    model_provider: "review_broker",
    model_reasoning_effort: init.effort,
    check_for_update_on_startup: false,
    cli_auth_credentials_store: "file",
    approval_policy: "never",
    sandbox_workspace_write: {
      writable_roots: ["/scratch"],
      network_access: true,
    },
    analytics: { enabled: false },
    projects: { "/source/checkout": { trust_level: "untrusted" } },
    model_providers: {
      review_broker: {
        name: "Run-scoped inference",
        base_url: `${base}/codex`,
        wire_api: "responses",
        requires_openai_auth: true,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
    mcp_servers: {
      snapshot: {
        url: `${base}/mcp`,
        bearer_token_env_var: "PR_REVIEW_READ_CAPABILITY",
        required: true,
      },
    },
  };
  await writeFile(
    "/scratch/.codex/config.toml",
    Object.entries(codex)
      .map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}`)
      .join("\n") + "\n",
  );
  await writeFile(
    "/scratch/.pi/agent/settings.json",
    JSON.stringify({
      ...settings.pi,
      defaultProvider: "openai-codex",
      defaultModel: init.models.codex,
      defaultThinkingLevel: init.effort,
      transport: "sse",
    }),
  );
  await writeFile(
    "/scratch/.pi/agent/models.json",
    JSON.stringify({
      providers: {
        "openai-codex": {
          baseUrl: `${base}/pi`,
          models: [
            {
              id: init.models.codex,
              api: "openai-codex-responses",
              reasoning: true,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    }),
  );
  if (init.credentials.pi)
    await writeFile(
      "/scratch/.pi/agent/auth.json",
      JSON.stringify({
        "openai-codex": { type: "oauth", ...init.credentials.pi, refresh: "" },
      }),
      { mode: 0o400 },
    );
  environment.PI_CODING_AGENT_DIR = "/scratch/.pi/agent";
  environment.PI_OFFLINE = "1";
  environment.PI_TELEMETRY = "0";
  environment.PI_SKIP_VERSION_CHECK = "1";
  environment.PR_REVIEW_READ_CAPABILITY = init.capability;
  const shim = `#!/bin/sh\nexec /usr/local/bin/node ${executables.pi} --no-approve --offline -e /control/pi.mjs "$@"\n`;
  await writeFile("/scratch/tools/pi", shim, { mode: 0o500 });
  await symlink(executables.claude, "/scratch/tools/claude");
}

export function harnessInvocation(init, claudeArgs) {
  if (init.harness === "claude") return [executables.claude, claudeArgs];
  const prompt = `${init.prompt}\n\nThe selected installed workflow is ${init.skillPath}. For a full review or revision read and follow it, including its configured nested orchestration. For a focused question do not invoke the full review workflow. Return exactly one JSON object matching the supplied schema as your final message.\n${JSON.stringify(init.schema)}`;
  if (init.harness === "codex")
    return [
      executables.codex,
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--output-schema",
        "/scratch/schema.json",
        "--",
        prompt,
      ],
    ];
  if (init.harness === "pi")
    return [
      process.execPath,
      [
        executables.pi,
        "--mode",
        "json",
        "--no-session",
        "--no-approve",
        "--offline",
        "-e",
        "/control/pi.mjs",
        "--",
        prompt,
      ],
    ];
  throw new Error("Unsupported harness selection");
}

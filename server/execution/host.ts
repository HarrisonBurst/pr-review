import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { materializeSkill, skillCompatibility } from "./skill.js";
import { localTools } from "./local-tools.js";
import { validateReviewResult } from "../review-output.js";
import { requireSupportedExecution } from "./supported.js";
import { isolatedEnvironment } from "./isolated-auth.js";
import path from "node:path";
import { parseJson, runCommand } from "../util.js";
import {
  ClaudeStream,
  CodexStream,
  PiStream,
  JsonLineDecoder,
} from "../stream.js";
import { validateSchema } from "../schema.js";
import type { ExecutionRequest } from "./executor.js";

export class HostExecutor {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async execute(
    request: ExecutionRequest,
  ): Promise<{ value: unknown; log: string }> {
    requireSupportedExecution(request.settings);
    const skill = request.settings.skillExecution!;
    const classification = request.kind === "classification";
    if (
      classification &&
      (skill.mode !== "separated" ||
        skill.harness !== "claude" ||
        skill.policy?.profile !== "restricted-native-1")
    )
      throw new Error(
        "No enforced zero-tool classifier is supported for this captured mode/harness/provider; no dispatch or fallback",
      );
    if (skill.mode === "docker")
      throw new Error("Docker execution cannot fall back to the host");
    const isolated = skill?.mode === "separated";
    const snapshot = request.settings.hostExecution;
    if (
      !isolated &&
      (!snapshot || snapshot.version !== 1 || !snapshot.confirmedAt)
    )
      throw new Error(
        "Dangerous host execution requires captured explicit consent; no fallback is permitted",
      );
    if (skill && request.kind !== "question" && !classification) {
      const diagnostics = skillCompatibility(
        skill.skill,
        skill.mode,
        skill.harness,
      );
      if (diagnostics.length) throw new Error(diagnostics.join("\n"));
    }
    request.signal?.throwIfAborted();
    const source = await request.prepare(request.signal);
    const skillPath =
      skill && !classification
        ? await materializeSkill(skill.skill, source)
        : request.settings.skillPath;
    const policy = isolated ? skill?.policy : undefined;
    if (policy && (policy.version !== 1 || policy.harness !== skill?.harness))
      throw new Error("Unsupported or mismatched captured native policy");
    if (policy)
      await rm(path.join(source, "resources/.native-library"), {
        recursive: true,
        force: true,
      });
    const library =
      policy && !classification
        ? await Promise.all(
            policy.library.skills.map((item) => materializeSkill(item, source)),
          )
        : [];
    const tools =
      skill && !classification
        ? await localTools(
            source,
            isolated,
            policy ? request.providers : undefined,
            policy ? request.integrationSnapshot : undefined,
            request.signal,
          )
        : null;
    let nativeHome: string | undefined;
    try {
      const projection = policy
        ? await isolatedEnvironment(
            policy,
            this.env,
            (nativeHome = await mkdtemp(path.join(source, ".native-home-"))),
            request.signal,
          )
        : null;
      const schemaPath = path.join(source, "result-schema.json");
      await writeFile(schemaPath, JSON.stringify(request.schema));
      const rolePrompt = request.prompt.replaceAll(
        "/source/checkout",
        path.join(source, "checkout"),
      );
      const prompt = classification
        ? `${rolePrompt}\nReturn exactly one JSON object matching this schema, without tools:\n${JSON.stringify(request.schema)}`
        : [
            skill?.version === 3 ? "" : rolePrompt,
            request.kind === "question"
              ? ""
              : `Follow the selected skill at ${skillPath}. Resolve its relative resources from ${path.dirname(skillPath)}. ${skill?.version === 3 ? "Use its review rubric. App-owned role instructions below override only reviewer orchestration and model selection." : "Preserve its own orchestration; do not invent extra reviewers."}\n${await readFile(skillPath, "utf8")}`,
            skill?.version === 3 ? rolePrompt : "",
            library.length
              ? `Trusted skill library (instructions/resources only, no permission grants). Use read_source on these entries on demand; native activation requiring scripts/interpolation/hooks/subagents is disabled:\n${library
                  .map((file, index) => {
                    const entry = policy!.library.skills[index];
                    const text = entry.files.find(
                      (item) => item.sourcePath === entry.path,
                    )!.content;
                    return `${file}\n${text.match(/^name:.*$/m)?.[0] ?? entry.directory}\n${text.match(/^description:.*$/m)?.[0] ?? ""}`;
                  })
                  .join("\n")}`
              : "",
            "Return one JSON object matching this schema as the final answer:",
            JSON.stringify(request.schema),
          ].join("\n\n");
      const harness = skill?.harness ?? snapshot!.harness;
      const args =
        harness === "claude"
          ? [
              "--print",
              "--output-format",
              "stream-json",
              "--verbose",
              ...(isolated
                ? [
                    ...(policy?.auth.source === "ANTHROPIC_API_KEY"
                      ? ["--bare"]
                      : []),
                    "--restricted",
                    "--setting-sources",
                    "",
                    "--settings",
                    JSON.stringify({
                      ...(policy?.preferences ?? {}),
                      disableAllHooks: true,
                    }),
                    "--disable-slash-commands",
                    "--no-session-persistence",
                    "--permission-mode",
                    "dontAsk",
                    "--tools",
                    "",
                    "--strict-mcp-config",
                    "--allowedTools",
                    tools?.names
                      .map((name) => `mcp__review__${name}`)
                      .join(",") ?? "",
                    ...(classification
                      ? [
                          "--mcp-config",
                          '{"mcpServers":{}}',
                          "--max-turns",
                          "1",
                        ]
                      : []),
                  ]
                : ["--dangerously-skip-permissions"]),
              ...(classification
                ? []
                : ["--json-schema", JSON.stringify(request.schema)]),
            ]
          : harness === "codex"
            ? [
                "exec",
                "--json",
                "--skip-git-repo-check",
                ...(isolated
                  ? [
                      "--ignore-user-config",
                      ...(policy
                        ? [
                            "--disable",
                            "shell_snapshot",
                            "--config",
                            "shell_environment_policy.experimental_use_profile=false",
                            "--config",
                            'shell_environment_policy.inherit="none"',
                            "--config",
                            'cli_auth_credentials_store="file"',
                            "--config",
                            "tools.view_image=false",
                          ]
                        : []),
                      "--ignore-rules",
                      "--ephemeral",
                      "--sandbox",
                      "read-only",
                      "--disable",
                      "shell_tool",
                      "--disable",
                      "unified_exec",
                      "--disable",
                      "hooks",
                      "--disable",
                      "apps",
                      "--disable",
                      "multi_agent",
                      "--disable",
                      "skill_mcp_dependency_install",
                      "--config",
                      'approval_policy="never"',
                      "--config",
                      "project_doc_max_bytes=0",
                      "--config",
                      'web_search="disabled"',
                    ]
                  : ["--dangerously-bypass-approvals-and-sandbox"]),
                "--output-schema",
                schemaPath,
                "-",
              ]
            : [
                "--mode",
                "json",
                "--print",
                ...(isolated
                  ? [
                      "--no-session",
                      "--no-approve",
                      "--offline",
                      "--no-extensions",
                      "--no-skills",
                      "--no-prompt-templates",
                      "--no-themes",
                      "--no-context-files",
                      "--tools",
                      tools!.names.join(","),
                    ]
                  : []),
              ];
      if (skill && request.settings.model)
        args.push("--model", request.settings.model);
      if (isolated && request.settings.effort) {
        if (harness === "claude")
          args.push("--effort", request.settings.effort);
        else if (harness === "codex")
          args.push(
            "--config",
            `model_reasoning_effort=${JSON.stringify(request.settings.effort)}`,
          );
        else args.push("--thinking", request.settings.effort);
      }
      if (policy && harness === "codex")
        for (const [key, value] of Object.entries(policy.preferences))
          args.push("--config", `${key}=${JSON.stringify(value)}`);
      if (policy && harness === "pi") {
        args.push("--provider", "openai-codex");
        for (const file of library) args.push("--skill", file);
      }
      if (skill && harness === "pi" && request.kind !== "question")
        args.push("--skill", skillPath);
      if (tools) {
        if (harness === "claude")
          args.push(
            "--mcp-config",
            JSON.stringify({
              mcpServers: {
                review: {
                  type: "http",
                  url: tools.url,
                  headers: { Authorization: `Bearer ${tools.token}` },
                },
              },
            }),
          );
        if (harness === "codex")
          args.push(
            "--config",
            `mcp_servers.review.url=${JSON.stringify(tools.url)}`,
            "--config",
            'mcp_servers.review.bearer_token_env_var="PR_REVIEW_LOCAL_TOKEN"',
            "--config",
            "mcp_servers.review.required=true",
          );
        if (harness === "pi")
          args.push(
            "-e",
            fileURLToPath(new URL("host-pi.mjs", import.meta.url)),
          );
      }
      const env: NodeJS.ProcessEnv = {
        ...(projection?.env ?? this.env),
        ...(tools
          ? {
              PR_REVIEW_LOCAL_TOOLS: tools.url,
              PR_REVIEW_LOCAL_TOKEN: tools.token,
            }
          : {}),
      };
      const progress =
        request.progress && projection
          ? {
              ...request.progress,
              phase: request.progress.phase.bind(request.progress),
              activity: (
                source: Parameters<
                  NonNullable<typeof request.progress>["activity"]
                >[0],
                kind: Parameters<
                  NonNullable<typeof request.progress>["activity"]
                >[1],
                label: string,
              ) =>
                request.progress!.activity(
                  source,
                  kind,
                  projection.secrets.some(
                    (secret) => secret && label.includes(secret),
                  )
                    ? "Native activity withheld"
                    : label,
                ),
            }
          : request.progress;
      const stream =
        harness === "claude"
          ? new ClaudeStream(
              progress,
              [path.join(source, "checkout"), source],
              source,
            )
          : harness === "codex"
            ? new CodexStream(progress)
            : new PiStream(progress);
      let classifierInitialized = false;
      let classifierTools = false;
      const classifierFrames = classification
        ? new JsonLineDecoder((frame) => {
            if (frame.type === "system" && frame.subtype === "init") {
              classifierInitialized = true;
              if (
                !Array.isArray(frame.tools) ||
                frame.tools.length !== 0 ||
                !Array.isArray(frame.mcp_servers) ||
                frame.mcp_servers.length !== 0
              )
                classifierTools = true;
            }
          })
        : null;
      const result = await runCommand(harness, args, {
        cwd: source,
        env,
        input: prompt,
        signal: request.signal,
        timeoutMs: classification ? 60_000 : 20 * 60_000,
        maxOutputBytes: 200_000,
        onStdout: (chunk) => {
          stream.decoder.push(chunk);
          classifierFrames?.push(chunk);
        },
      });
      request.signal?.throwIfAborted();
      stream.decoder.end();
      classifierFrames?.end();
      if (result.code !== 0 || result.timedOut || result.aborted)
        throw new Error(
          `${isolated ? "Isolated" : "Dangerous"} ${harness} ${result.timedOut ? (classification ? "classifier timed out after one minute" : "timed out after 20 minutes") : `process failed (exit ${result.code})`}; no fallback was used`,
        );
      if (
        stream.decoder.stats.malformed ||
        stream.decoder.stats.overflowed ||
        (stream instanceof ClaudeStream
          ? stream.resultFrames !== 1 ||
            !stream.envelope ||
            stream.envelope.is_error !== false ||
            stream.envelope.subtype !== "success"
          : stream instanceof CodexStream
            ? stream.incomplete() || stream.failure
            : !stream.completed || !stream.successful || !stream.lastMessage)
      )
        throw new Error(
          `Host harness did not produce one complete successful structured result (${stream.decoder.diagnostic()})`,
        );
      if (
        classification &&
        (!classifierInitialized ||
          classifierTools ||
          !(stream instanceof ClaudeStream) ||
          stream.toolCalls !== 0)
      )
        throw new Error(
          "Classifier emitted a forbidden tool attempt; result rejected",
        );
      if (
        projection?.secrets.some(
          (secret) =>
            secret &&
            (stream instanceof ClaudeStream
              ? JSON.stringify(stream.envelope)
              : (stream.lastMessage ?? "")
            ).includes(secret),
        )
      )
        throw new Error(
          "Native output contained model authentication material; result rejected",
        );
      const value =
        stream instanceof ClaudeStream
          ? classification
            ? parseJson<unknown>(
                String(stream.envelope!.result),
                "Classifier final result",
              )
            : stream.envelope!.structured_output
          : parseJson<unknown>(
              stream.lastMessage!,
              "Host harness final result",
            );
      if (
        skill?.version === 3 &&
        Buffer.byteLength(JSON.stringify(value)) > 200_000
      )
        throw new Error(
          "Isolated entry result exceeds the 200000-byte evidence limit; no truncated result is accepted",
        );
      if (
        projection?.secrets.some(
          (secret) => secret && JSON.stringify(value).includes(secret),
        )
      )
        throw new Error(
          "Native output contained model authentication material; result rejected",
        );
      if (request.kind === "review") validateReviewResult(value);
      else validateSchema(request.schema, value);
      return {
        value,
        log: isolated
          ? `Isolated ${harness} context; ${stream.decoder.diagnostic()}. Restricted local tools, not OS containment.`
          : `Dangerous host ${harness}; ${stream.decoder.diagnostic()}. Native tools and credentials were unrestricted by the app. App preview and integration permissions do not constrain direct harness side effects. Process cancellation is not descendant containment.`,
      };
    } finally {
      await tools?.close();
      if (nativeHome) await rm(nativeHome, { recursive: true, force: true });
    }
  }
}

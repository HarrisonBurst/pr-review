import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostExecutor } from "../execution/host.js";
import { loadSkill } from "../execution/skill.js";

const marker = "PRIVATE_FIXTURE_FRAME_DATA";

test("inert Dangerous Claude host accepts one successful result and distinguishes failed envelopes and exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pr-review-host-results-"));
  try {
    const bin = path.join(root, "bin");
    const source = path.join(root, "source");
    const skillPath = path.join(root, "trusted/SKILL.md");
    await mkdir(bin);
    await mkdir(path.dirname(skillPath));
    await mkdir(path.join(source, "checkout"), { recursive: true });
    await writeFile(skillPath, "Clearly labeled inert host review fixture");
    const executable = path.join(bin, "claude");
    await writeFile(
      executable,
      `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  const mode = process.env.INERT_MODE;
  const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
  emit({ type: "system", subtype: "init" });
  if (mode !== "missing") {
    const frame = {
      type: "result",
      subtype: mode === "non-success" ? "error" : mode === "unknown-subtype" ? "${marker}" : "success",
      is_error: mode === "non-success" ? true : mode === "unknown-is-error" ? "${marker}" : false,
      structured_output: { answer: "${marker}" },
    };
    emit(frame);
    if (mode === "duplicate") emit(frame);
  }
  if (mode === "nonzero") process.exitCode = 3;
});
`,
    );
    await chmod(executable, 0o700);
    const settings = {
      skillPath,
      model: null,
      additionalInstructions: "",
      skillExecution: {
        version: 2 as const,
        mode: "dangerous" as const,
        harness: "claude" as const,
        skill: await loadSkill(skillPath),
      },
      hostExecution: {
        version: 1 as const,
        harness: "claude" as const,
        confirmedAt: "fixture",
      },
    };
    const execute = (mode: string) =>
      new HostExecutor({
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        INERT_MODE: mode,
      }).execute({
        kind: "question",
        runId: "inert",
        settings,
        prepare: async () => source,
        metadata: {},
        diff: "",
        prompt: "Deterministic fixture",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      });
    const accepted = await execute("success");
    assert.deepEqual(accepted.value, { answer: marker });
    assert.match(accepted.log, /2 frames decoded, 0 malformed, 0 over/);
    for (const [mode, diagnostic] of [
      [
        "missing",
        "Claude result frames 0, final subtype absent, final is_error absent, final structured_output absent",
      ],
      [
        "duplicate",
        "Claude result frames 2, final subtype success, final is_error false, final structured_output present",
      ],
      [
        "non-success",
        "Claude result frames 1, final subtype error, final is_error true, final structured_output present",
      ],
      [
        "unknown-subtype",
        "Claude result frames 1, final subtype other, final is_error false, final structured_output present",
      ],
      [
        "unknown-is-error",
        "Claude result frames 1, final subtype success, final is_error other, final structured_output present",
      ],
    ]) {
      const error = await execute(mode).then(
        () => assert.fail(`${mode} was accepted`),
        (error: Error) => error.message,
      );
      assert.match(
        error,
        /Host harness did not produce one complete successful structured result \(\d+ frames decoded, 0 malformed, 0 over/,
      );
      assert.ok(error.includes(diagnostic), error);
      assert.equal(error.includes(marker), false);
      assert.ok(error.length < 350);
    }
    await assert.rejects(
      execute("nonzero"),
      /Dangerous claude process failed \(exit 3\); no fallback was used/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

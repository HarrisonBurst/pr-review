import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DiffSelection,
  Finding,
  QuestionAnswer,
  QuestionMode,
  ReviewerSettings,
  IntegrationSessionSnapshot,
  Severity,
} from "../shared/contracts.js";
import { describeSelection } from "../shared/diff.js";
import {
  SourceCheckout,
  commandDiagnostic,
  commandEnvironment,
} from "./checkout.js";
import { clampText, ensureDir, pathExists } from "./util.js";

export interface QuestionTurn {
  mode: QuestionMode;
  question: string;
  answer: QuestionAnswer | null;
}

export interface QuestionInput {
  id: string;
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
  mode: QuestionMode;
  question: string;
  selection: DiffSelection;
  fileDiff: string;
  diffTruncated: boolean;
  draft: {
    overview: string;
    body: string;
    findings: Finding[];
  } | null;
  history: QuestionTurn[];
  integrationSnapshot?: IntegrationSessionSnapshot;
}

export interface QuestionAdapter {
  ask(
    input: QuestionInput,
    settings: ReviewerSettings,
    signal?: AbortSignal,
  ): Promise<{ answer: QuestionAnswer; log: string }>;
}

const severities = new Set<Severity>(["blocking", "non_blocking"]);
const origins = new Set<Finding["origin"]>(["introduced", "pre_existing"]);

export function validateQuestionAnswer(
  mode: QuestionMode,
  value: unknown,
): QuestionAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("answer must be an object");
  const record = value as Record<string, unknown>;
  if (mode === "draft_comment") {
    if (
      typeof record.body !== "string" ||
      typeof record.evidence !== "string" ||
      !severities.has(record.severity as Severity) ||
      !origins.has(record.origin as Finding["origin"])
    )
      throw new Error("comment answer has invalid fields");
    if (!record.body.trim()) throw new Error("comment body must not be empty");
    return {
      kind: "comment",
      body: record.body,
      severity: record.severity as Severity,
      origin: record.origin as Finding["origin"],
      evidence: record.evidence,
    };
  }
  if (
    typeof record.answer !== "string" ||
    !Array.isArray(record.followUps) ||
    !record.followUps.every((item) => typeof item === "string")
  )
    throw new Error("answer has invalid fields");
  if (!record.answer.trim()) throw new Error("answer must not be empty");
  return {
    kind: "answer",
    answer: record.answer,
    followUps: (record.followUps as string[]).slice(0, 4),
  };
}

const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "followUps"],
  properties: {
    answer: { type: "string" },
    followUps: { type: "array", items: { type: "string" }, maxItems: 4 },
  },
};

const commentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["body", "severity", "origin", "evidence"],
  properties: {
    body: { type: "string" },
    severity: { enum: ["blocking", "non_blocking"] },
    origin: { enum: ["introduced", "pre_existing"] },
    evidence: { type: "string" },
  },
};

export const questionSchema = (mode: QuestionMode) =>
  mode === "draft_comment" ? commentSchema : answerSchema;

const modeInstructions: Record<QuestionMode, string> = {
  explain:
    "Explain the selected code concisely: what it does mechanically and how it interacts with the existing code it touches. Read the surrounding source only as far as needed to be accurate. Answer in 2-5 short Markdown bullets.",
  investigate:
    "Investigate the selected code in the prepared source: find its callers and callees, the tests that cover it, and the data flow in and out. Report what you actually found, in short Markdown bullets grouped by what matters most, and say plainly when something is not covered or could not be found.",
  draft_comment:
    "Draft one review comment about the selected code for the pull request author. body is the complete posted comment: one plain sentence stating the issue or suggestion, then at most three short Markdown bullets (consequence, scenario, suggested fix) and only the ones that add something. Do not start it with a severity label, path, or line number. Choose severity blocking only for a defect that must be fixed before merge. origin is pre_existing only when the selected code was not changed by this pull request. evidence is private verification support for the reviewer, never posted: the lines and symbols you checked and the reasoning that supports the comment.",
};

const citationRule =
  "Cite code as `path:line` using paths relative to the repository root and line numbers of the head commit, or `path:line (old)` for removed code, so the reviewer can jump to it. Keep every answer grounded in the prepared source and diff; never guess at code you did not read.";

function historyText(history: QuestionTurn[]): string {
  if (!history.length) return "";
  const turns = history.map((turn, index) => {
    const answer =
      turn.answer?.kind === "answer"
        ? turn.answer.answer
        : turn.answer?.kind === "comment"
          ? `Suggested comment (${turn.answer.severity}): ${turn.answer.body}`
          : "(no answer)";
    return `Turn ${index + 1} (${turn.mode})${turn.question ? `\nQuestion: ${turn.question}` : ""}\nAnswer: ${answer}`;
  });
  return `Earlier turns about this same selection, oldest first:\n<prior-turns>\n${turns.join("\n\n")}\n</prior-turns>`;
}

export function questionPrompt(
  input: QuestionInput,
  checkoutDir: string,
): string {
  const selection = input.selection;
  const draft = input.draft
    ? JSON.stringify(
        {
          overview: input.draft.overview,
          body: input.draft.body,
          findings: input.draft.findings.map((finding) => ({
            path: finding.path,
            line: finding.line,
            startLine: finding.startLine,
            side: finding.side,
            severity: finding.severity,
            body: finding.body,
          })),
        },
        null,
        2,
      )
    : "null (no draft is open)";
  return [
    `Repository: ${input.repository}, pull request #${input.number}`,
    `Base commit: ${input.baseSha}`,
    `Head commit: ${input.headSha}`,
    `Prepared source directory (detached at the head commit): ${checkoutDir}`,
    selection.kinds.del
      ? `The base-commit version of the selected file is materialized read-only at ${path.join(checkoutDir, "..", "base", selection.path)} for the removed lines.`
      : "",
    "Do not fetch, resolve, or substitute the current remote pull request. Reason only about these exact commits.",
    `Selected file: ${selection.path}${selection.oldPath ? ` (renamed from ${selection.oldPath})` : ""}`,
    `Selected range: ${describeSelection(selection)}${selection.spansHunks ? " (spans more than one hunk)" : ""}`,
    `Selected lines with diff prefixes (+ added, - removed, space unchanged):\n<selection>\n${selection.snippet}\n</selection>`,
    `Diff of the selected file for these commits${input.diffTruncated ? " (the saved diff was truncated by the backend)" : ""}:\n<file-diff>\n${clampText(input.fileDiff, 120_000)}\n</file-diff>`,
    `Open review draft, read-only context:\n<draft>\n${draft}\n</draft>`,
    historyText(input.history),
    modeInstructions[input.mode],
    input.question ? `Reviewer's question:\n${input.question}` : "",
    input.mode === "draft_comment"
      ? "Return only a JSON object matching the supplied schema."
      : `${citationRule}\n\nEnd with up to three short follow-up questions the reviewer might reasonably ask next in followUps. Return only a JSON object matching the supplied schema.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function safeRepoPath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (
    path.isAbsolute(value) ||
    normalized.startsWith("..") ||
    normalized.split("/").includes("..") ||
    value.includes("\0")
  )
    throw new Error(`refusing to materialize unsafe path ${value}`);
  return normalized;
}

export class QuestionCheckout {
  private readonly env: NodeJS.ProcessEnv;
  private readonly checkout: SourceCheckout;

  constructor(
    private readonly dataDir: string,
    commandEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.env = commandEnvironment(commandEnv);
    this.checkout = new SourceCheckout(this.env);
  }

  async prepare(
    input: QuestionInput,
    signal?: AbortSignal,
  ): Promise<{ sourceDir: string; checkoutDir: string; log: string[] }> {
    const sourceDir = path.join(
      this.dataDir,
      "questions",
      input.repository.replace(/[^\w.-]/g, "_"),
      input.headSha,
    );
    const checkoutDir = path.join(sourceDir, "checkout");
    await ensureDir(sourceDir);
    const log: string[] = [];
    if (
      (await pathExists(path.join(checkoutDir, ".git"))) &&
      (await this.checkout.matches(input, checkoutDir, signal))
    ) {
      log.push(`reused verified checkout at ${input.headSha}`);
    } else {
      await rm(checkoutDir, { recursive: true, force: true });
      log.push(
        ...(await this.checkout.prepare(input, sourceDir, checkoutDir, signal)),
      );
    }
    if (input.selection.kinds.del) {
      const relative = safeRepoPath(
        input.selection.oldPath ?? input.selection.path,
      );
      const shown = await this.checkout.git(
        ["show", `${input.baseSha}:${relative}`],
        checkoutDir,
        signal,
      );
      if (shown.code !== 0)
        throw new Error(
          `Unable to read ${relative} at base ${input.baseSha}: ${commandDiagnostic(shown)}`,
        );
      const target = path.join(
        sourceDir,
        "base",
        safeRepoPath(input.selection.path),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, shown.stdout);
      log.push(`materialized base version of ${relative}`);
    }
    return { sourceDir, checkoutDir, log };
  }
}

export class DemoQuestionRunner implements QuestionAdapter {
  async ask(
    input: QuestionInput,
  ): Promise<{ answer: QuestionAnswer; log: string }> {
    const where = `\`${input.selection.path}\` ${describeSelection(input.selection)}`;
    if (input.mode === "draft_comment")
      return {
        answer: {
          kind: "comment",
          body: `The selected change at ${where} has no accompanying test.\n- Add a case that exercises the new return value.`,
          severity: "non_blocking",
          origin: "introduced",
          evidence: `- Demo evidence: inspected ${where} in the deterministic fixture.`,
        },
        log: "demo question runner: deterministic comment",
      };
    return {
      answer: {
        kind: "answer",
        answer: `- Demo ${input.mode} of ${where}${input.question ? ` for "${input.question}"` : ""}.\n- The fixture returns the string "demo" at \`${input.selection.path}:${input.selection.to.line}\`.`,
        followUps: [
          "What calls this function?",
          "Is the old value still referenced?",
        ],
      },
      log: "demo question runner: deterministic answer",
    };
  }
}

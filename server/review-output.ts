import type {
  CommentSide,
  Finding,
  ReviewResult,
  ReviewVerdict,
  Severity,
} from "../shared/contracts.js";

const verdicts = new Set<ReviewVerdict>([
  "COMMENT",
  "APPROVE",
  "REQUEST_CHANGES",
]);
const severities = new Set<Severity>(["blocking", "non_blocking"]);
const origins = new Set<Finding["origin"]>(["introduced", "pre_existing"]);
const sides = new Set<CommentSide>(["LEFT", "RIGHT"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  if (typeof value[key] !== "string")
    throw new Error(`${label}.${key} must be a string`);
  return value[key] as string;
}

function nullableString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (value[key] !== null && typeof value[key] !== "string")
    throw new Error(`${label}.${key} must be a string or null`);
  return value[key] as string | null;
}

function nullableNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  if (
    value[key] !== null &&
    (!Number.isInteger(value[key]) || (value[key] as number) < 1)
  )
    throw new Error(`${label}.${key} must be a positive integer or null`);
  return value[key] as number | null;
}

export function validateResultFinding(item: unknown, label: string): Finding {
  const finding = object(item, label);
  const severity = stringField(finding, "severity", label) as Severity;
  const origin = stringField(finding, "origin", label) as Finding["origin"];
  if (!severities.has(severity))
    throw new Error(`${label}.severity is invalid`);
  if (!origins.has(origin)) throw new Error(`${label}.origin is invalid`);
  const id = stringField(finding, "id", label);
  if (!id) throw new Error(`${label}.id must not be empty`);
  const side = finding.side === undefined ? "RIGHT" : finding.side;
  if (!sides.has(side as CommentSide))
    throw new Error(`${label}.side must be LEFT or RIGHT`);
  const line = nullableNumber(finding, "line", label);
  const startLine =
    finding.startLine === undefined
      ? null
      : nullableNumber(finding, "startLine", label);
  if (startLine !== null && (line === null || startLine > line))
    throw new Error(`${label}.startLine must not exceed line`);
  const questionId =
    finding.questionId === undefined
      ? null
      : nullableString(finding, "questionId", label);
  if (typeof finding.included !== "boolean")
    throw new Error(`${label}.included must be a boolean`);
  return {
    id,
    severity,
    path: nullableString(finding, "path", label),
    line,
    startLine: startLine === line ? null : startLine,
    side: side as CommentSide,
    body: stringField(finding, "body", label),
    evidence: stringField(finding, "evidence", label),
    origin,
    included: finding.included,
    questionId,
  };
}

export function validateReviewResult(value: unknown): ReviewResult {
  const result = object(value, "result");
  const verdict = stringField(result, "verdict", "result") as ReviewVerdict;
  if (!verdicts.has(verdict)) throw new Error("result.verdict is invalid");
  if (!Array.isArray(result.findings))
    throw new Error("result.findings must be an array");
  const findings = result.findings.map((item, index) =>
    validateResultFinding(item, `result.findings[${index}]`),
  );
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length)
    throw new Error("result.findings ids must be unique");
  return {
    overview: stringField(result, "overview", "result"),
    body: stringField(result, "body", "result"),
    findings,
    verdict,
    rationale: stringField(result, "rationale", "result"),
  };
}

export const reviewSchema = {
  type: "object",
  additionalProperties: true,
  required: ["overview", "body", "findings", "verdict", "rationale"],
  properties: {
    overview: { type: "string" },
    body: { type: "string" },
    verdict: { enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"] },
    rationale: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: [
          "id",
          "severity",
          "path",
          "line",
          "body",
          "evidence",
          "origin",
          "included",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          severity: { enum: ["blocking", "non_blocking"] },
          path: { type: ["string", "null"] },
          line: { type: ["integer", "null"], minimum: 1 },
          startLine: { type: ["integer", "null"], minimum: 1 },
          side: { enum: ["LEFT", "RIGHT"] },
          questionId: { type: ["string", "null"] },
          body: { type: "string" },
          evidence: { type: "string" },
          origin: { enum: ["introduced", "pre_existing"] },
          included: { type: "boolean" },
        },
      },
    },
  },
};

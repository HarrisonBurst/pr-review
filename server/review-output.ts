import type {
  CommentSide,
  DiscussionSnapshot,
  Finding,
  HumanReviewRequest,
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

export function humanReviewExtension(value: unknown): {
  observation: HumanReviewRequest | null;
  diagnostics: string[];
} {
  try {
    if (value === undefined)
      throw new Error("humanReviewRequest is missing; detection unavailable");
    if (value === null)
      throw new Error("humanReviewRequest is null; detection unavailable");
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 200000)
      throw new Error("humanReviewRequest exceeds the 200000-byte limit");
    const exact = (value: unknown, keys: string[], label: string) => {
      const record = object(value, label);
      if (
        Object.keys(record).length !== keys.length ||
        keys.some((key) => !(key in record))
      )
        throw new Error(`${label} must contain exactly ${keys.join(", ")}`);
      return record;
    };
    const bounded = (
      value: Record<string, unknown>,
      key: string,
      label: string,
      max: number,
      bytes = false,
    ) => {
      const text = stringField(value, key, label);
      if (
        !text.trim() ||
        (bytes ? Buffer.byteLength(text, "utf8") : text.length) > max
      )
        throw new Error(
          `${label}.${key} must be nonempty and at most ${max} ${bytes ? "UTF-8 bytes" : "characters"}`,
        );
      return text;
    };
    const hash = (
      value: Record<string, unknown>,
      key: string,
      label: string,
    ) => {
      const text = stringField(value, key, label);
      if (!/^[a-f0-9]{64}$/.test(text))
        throw new Error(`${label}.${key} must be a lowercase SHA256`);
      return text;
    };
    const request = exact(
      value,
      ["version", "contextVersion", "evidence"],
      "humanReviewRequest",
    );
    if (request.version !== 1)
      throw new Error("humanReviewRequest.version is unsupported");
    const contextVersion = hash(
      request,
      "contextVersion",
      "humanReviewRequest",
    );
    if (!Array.isArray(request.evidence) || request.evidence.length > 1000)
      throw new Error(
        "humanReviewRequest.evidence must contain at most 1000 entries",
      );
    const seen = new Set<string>();
    const evidence = request.evidence.map((item, index) => {
      const label = `humanReviewRequest.evidence[${index}]`;
      const entry = exact(item, ["source", "author", "quote", "url"], label);
      const source = exact(
        entry.source,
        ["kind", "id", "version"],
        `${label}.source`,
      );
      if (
        !["comment", "review", "inline_comment"].includes(source.kind as string)
      )
        throw new Error(`${label}.source.kind is invalid`);
      const reference = {
        kind: source.kind as HumanReviewRequest["evidence"][number]["source"]["kind"],
        id: bounded(source, "id", `${label}.source`, 100),
        version: hash(source, "version", `${label}.source`),
      };
      const key = JSON.stringify(reference);
      if (seen.has(key))
        throw new Error(
          "humanReviewRequest.evidence source/version entries must be unique",
        );
      seen.add(key);
      return {
        source: reference,
        author: bounded(entry, "author", label, 100),
        quote: bounded(entry, "quote", label, 20000, true),
        url: bounded(entry, "url", label, 2048),
      };
    });
    return {
      observation: { version: 1, contextVersion, evidence },
      diagnostics: [],
    };
  } catch (error) {
    return {
      observation: null,
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function bindHumanReviewRequest(
  value: unknown,
  discussion: DiscussionSnapshot | null | undefined,
): ReturnType<typeof humanReviewExtension> {
  const extension = humanReviewExtension(value);
  if (!extension.observation) return extension;
  if (
    !discussion ||
    extension.observation.contextVersion !== discussion.revision
  )
    return {
      observation: null,
      diagnostics: [
        "Human-request context version does not match the captured discussion",
      ],
    };
  for (const evidence of extension.observation.evidence) {
    const source = discussion.sources.find(
      (item) =>
        item.kind === evidence.source.kind &&
        item.id === evidence.source.id &&
        item.version === evidence.source.version,
    );
    if (
      !source ||
      source.authorType !== "User" ||
      source.provenance !== "participant" ||
      source.author.endsWith("[bot]") ||
      source.author !== evidence.author ||
      source.url !== evidence.url ||
      !source.body.includes(evidence.quote)
    )
      return {
        observation: null,
        diagnostics: [
          "Human-request source identity, participant, author, URL or verbatim quotation does not match captured data",
        ],
      };
  }
  return extension;
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
    humanReviewRequest: humanReviewExtension(result.humanReviewRequest)
      .observation,
  };
}

export const reviewSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "overview",
    "body",
    "findings",
    "verdict",
    "rationale",
    "humanReviewRequest",
  ],
  properties: {
    humanReviewRequest: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["version", "contextVersion", "evidence"],
          properties: {
            version: { type: "integer", enum: [1] },
            contextVersion: { type: "string", pattern: "^[a-f0-9]{64}$" },
            evidence: {
              type: "array",
              maxItems: 1000,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["source", "author", "quote", "url"],
                properties: {
                  source: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "id", "version"],
                    properties: {
                      kind: { enum: ["comment", "review", "inline_comment"] },
                      id: { type: "string", minLength: 1, maxLength: 100 },
                      version: { type: "string", pattern: "^[a-f0-9]{64}$" },
                    },
                  },
                  author: { type: "string", minLength: 1, maxLength: 100 },
                  quote: { type: "string", minLength: 1, maxLength: 20000 },
                  url: { type: "string", minLength: 1, maxLength: 2048 },
                },
              },
            },
          },
        },
      ],
    },
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

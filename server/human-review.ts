import type {
  HumanReviewClassifierInput,
  HumanReviewClassifierOutput,
} from "../shared/contracts.js";
import { validateSchema } from "./schema.js";

export const classifierSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "revision", "results"],
  properties: {
    version: { enum: [1] },
    revision: { type: "string", minLength: 1, maxLength: 200 },
    results: {
      type: "array",
      maxItems: 1000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "decision", "quote", "reason"],
        properties: {
          source: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id", "version"],
            properties: {
              kind: { enum: ["comment", "review", "inline_comment"] },
              id: { type: "string", minLength: 1, maxLength: 200 },
              version: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
          decision: { enum: ["requested", "not_requested", "uncertain"] },
          quote: { type: ["string", "null"], maxLength: 1000 },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
};

export function validateClassification(
  input: HumanReviewClassifierInput,
  value: unknown,
): HumanReviewClassifierOutput {
  validateSchema(classifierSchema, value);
  const output = value as HumanReviewClassifierOutput;
  const expected = input.discussion.sources.filter(
    (source) => source.provenance === "participant",
  );
  if (
    output.revision !== input.discussion.revision ||
    output.results.length !== expected.length
  )
    throw new Error("Classifier coverage or revision mismatch");
  const seen = new Set<string>();
  for (const result of output.results) {
    const source = expected.find(
      (item) =>
        item.id === result.source.id &&
        item.kind === result.source.kind &&
        item.version === result.source.version,
    );
    const key = `${result.source.kind}:${result.source.id}`;
    if (
      !source ||
      seen.has(key) ||
      (result.decision === "requested" &&
        (!result.quote?.trim() || !source.body.includes(result.quote)))
    )
      throw new Error("Classifier source attribution or quotation is invalid");
    seen.add(key);
  }
  return output;
}

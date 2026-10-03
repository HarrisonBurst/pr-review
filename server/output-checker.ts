import {
  reviewOutputVersion,
  type ReviewOutputCheck,
} from "../shared/contracts.js";
import { humanReviewExtension, validateReviewResult } from "./review-output.js";

export const checkerGuidance =
  "Before returning a review payload, call check_review_output with {candidate: JSON.stringify(payload)}. It uses the same validation as final ingestion and reports the first field error. A valid format is not correctness, approval or permission to publish. Return the payload itself, not the checker response or a harness envelope.";

export const checkerTool = {
  name: "check_review_output",
  description: checkerGuidance,
  inputSchema: {
    type: "object",
    properties: { candidate: { type: "string", maxLength: 1000000 } },
    required: ["candidate"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function checkReviewOutput(candidate: unknown): ReviewOutputCheck {
  try {
    if (typeof candidate !== "string")
      throw new Error("candidate must be a JSON string");
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      throw new Error(
        "candidate must contain one complete JSON object without Markdown fences or transport envelopes",
      );
    }
    validateReviewResult(value);
    return {
      version: reviewOutputVersion,
      status: "valid",
      diagnostics: [],
      extensionDiagnostics: humanReviewExtension(
        (value as Record<string, unknown>).humanReviewRequest,
      ).diagnostics,
    };
  } catch (error) {
    return {
      version: reviewOutputVersion,
      status: "invalid",
      diagnostics: [error instanceof Error ? error.message : String(error)],
      extensionDiagnostics: [],
    };
  }
}

export function checkerResult(args: unknown) {
  const record = args as Record<string, unknown> | null;
  const checked = checkReviewOutput(record?.candidate);
  return {
    content: [{ type: "text", text: JSON.stringify(checked) }],
    isError: checked.status === "invalid",
  };
}

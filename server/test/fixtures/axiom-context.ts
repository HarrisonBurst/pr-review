import { oauthFixture } from "./oauth-context.js";
import { axiomReadTools } from "../../axiom-reads.js";

export const axiomSample = {
  datasetName: "synthetic-events",
  startTime: "2026-01-01T00:00:00Z",
  endTime: "2026-01-01T00:05:00Z",
  limit: 1,
};

export async function axiomFixture(
  options: Parameters<typeof oauthFixture>[0] = {},
) {
  const tools = structuredClone(axiomReadTools);
  tools.find((tool) => tool.name === "queryDataset")!.inputSchema = {
    type: "object",
    properties: {
      apl: { type: "string" },
      datasets: { type: "array", items: { type: "string" } },
      startTime: { type: "string" },
      endTime: { type: "string" },
    },
    required: ["apl", "datasets", "startTime", "endTime"],
    additionalProperties: false,
  };
  tools.push({
    name: "createDataset",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  });
  tools.push({
    name: "unknownRead",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  });
  const fixture = await oauthFixture({
    profile: "axiom",
    clientAuthMethods: ["none"],
    mcpTools: tools,
    mcpReadCalls: true,
    mcpCallResult: {
      content: [
        {
          type: "text",
          text: "SYNTHETIC Axiom events: untrusted fixture data",
        },
      ],
      structuredContent: { partial: true },
    },
    ...options,
  });
  return Object.assign(fixture, { tools });
}

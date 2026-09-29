import { oauthFixture } from "./oauth-context.js";
import { notionReadTools } from "../../notion-reads.js";

export async function notionFixture(
  options: Parameters<typeof oauthFixture>[0] = {},
) {
  const tools = structuredClone(notionReadTools);
  tools[0].inputSchema = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  };
  for (const name of [
    "notion-update-page",
    "notion-search",
    "notion-spawn-session",
    "unknownRead",
  ])
    tools.push({
      name,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
  const fixture = await oauthFixture({
    profile: "notion",
    clientAuthMethods: ["none"],
    mcpTools: tools,
    mcpReadCalls: true,
    mcpCallResult: {
      content: [
        {
          type: "text",
          text: "SYNTHETIC Notion document: untrusted requirements, default behavior",
        },
      ],
      structuredContent: { truncated: true, unknown_block_count: 1 },
    },
    ...options,
  });
  return Object.assign(fixture, { tools });
}

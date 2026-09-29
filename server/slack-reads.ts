import type { Tool } from "@modelcontextprotocol/client";
import { validateSchema } from "./schema.js";

const text = { type: "string", minLength: 1, maxLength: 4000 };
const cursor = { type: "string", minLength: 1, maxLength: 1024 };
const responseFormat = { type: "string", enum: ["concise", "detailed"] };
const search = {
  query: text,
  content_types: { type: "string", enum: ["messages"] },
  context_channel_id: text,
  cursor,
  limit: { type: "integer", minimum: 1, maximum: 20 },
  after: text,
  before: text,
  include_bots: { type: "boolean" },
  sort: { type: "string", enum: ["score", "timestamp"] },
  sort_dir: { type: "string", enum: ["asc", "desc"] },
  response_format: responseFormat,
  include_context: { type: "boolean" },
  max_context_length: { type: "integer", minimum: 1, maximum: 2000 },
  only_my_channels: { type: "boolean" },
  keywords: { type: "array", items: text, maxItems: 20 },
  filters: text,
  natural_language_query: text,
};
const history = {
  channel_id: text,
  limit: { type: "integer", minimum: 1, maximum: 100 },
  cursor,
  latest: text,
  oldest: text,
  response_format: responseFormat,
};
export const slackReadTools: Tool[] = [
  {
    name: "slack_search_public",
    description: "Search accessible public Slack messages, one bounded page.",
    inputSchema: {
      type: "object",
      properties: search,
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_search_public_and_private",
    description:
      "Search accessible public and private Slack messages, one bounded page.",
    inputSchema: {
      type: "object",
      properties: { ...search, channel_types: text },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_read_channel",
    description: "Read accessible Slack channel history, one bounded page.",
    inputSchema: {
      type: "object",
      properties: history,
      required: ["channel_id"],
      additionalProperties: false,
    },
  },
  {
    name: "slack_read_thread",
    description: "Read an accessible Slack thread, one bounded page.",
    inputSchema: {
      type: "object",
      properties: { ...history, message_ts: text },
      required: ["channel_id", "message_ts"],
      additionalProperties: false,
    },
  },
];

export const slackReadMessage =
  "Authenticated Slack reads use provider access controls, not independently verified account/workspace identity or app-enforced channel isolation. Explicit tool grants are required. Writes and unclassified tools are denied. Responses are bounded, untrusted provider content; citations and completeness are only available when supplied.";

export function slackReadArguments(
  name: string,
  args: Record<string, unknown>,
) {
  const tool = slackReadTools.find((tool) => tool.name === name);
  if (!tool) throw new Error("Slack write or unclassified tool denied");
  validateSchema(tool.inputSchema, args);
  return {
    limit: name.startsWith("slack_search_") ? 20 : 100,
    response_format: "concise",
    ...args,
  };
}

import type {
  IntegrationDefinition,
  IntegrationInventory,
} from "../shared/contracts.js";
import { fingerprintToolSchema } from "./integrations.js";
import {
  slackReadArguments,
  slackReadMessage,
  slackReadTools,
} from "./slack-reads.js";
import {
  linearReadArguments,
  linearReadMessage,
  linearReadTools,
} from "./linear-reads.js";

import {
  axiomReadArguments,
  axiomReadMessage,
  axiomReadTools,
} from "./axiom-reads.js";

import {
  notionReadArguments,
  notionReadMessage,
  notionReadTools,
} from "./notion-reads.js";

export function oauthReadAdapter(profileId: string | undefined) {
  if (profileId === "notion-mcp/1")
    return {
      label: "Notion",
      identity: "https://mcp.notion.com/mcp",
      tools: notionReadTools,
      arguments: notionReadArguments,
      message: notionReadMessage,
      testTools: ["notion-fetch"],
      testArguments: {},
    };
  if (profileId === "axiom-mcp/1")
    return {
      label: "Axiom",
      identity: "https://mcp.axiom.co/mcp",
      tools: axiomReadTools,
      arguments: axiomReadArguments,
      message: axiomReadMessage,
      testTools: ["listDatasets"],
      testArguments: {},
    };
  if (profileId === "slack-mcp/1")
    return {
      label: "Slack",
      identity: "https://mcp.slack.com/mcp",
      tools: slackReadTools,
      arguments: slackReadArguments,
      message: slackReadMessage,
      testTools: ["slack_search_public", "slack_search_public_and_private"],
      testArguments: {
        query: '"pr-review connection test"',
        limit: 1,
        response_format: "concise",
      },
    };
  if (profileId === "linear-mcp/1")
    return {
      label: "Linear",
      identity: "https://mcp.linear.app/mcp",
      tools: linearReadTools,
      arguments: linearReadArguments,
      message: linearReadMessage,
      testTools: ["list_issues"],
      testArguments: { query: '"pr-review connection test"', limit: 1 },
    };
}

export function oauthReadDefinition(
  profileId: string | undefined,
  inventory?: IntegrationInventory,
): IntegrationDefinition | undefined {
  const adapter = oauthReadAdapter(profileId);
  if (!adapter) return;
  return {
    id: profileId!,
    provider: "custom",
    label: `${adapter.label} reads`,
    transport: "mcp-http",
    authReuse: "host-session",
    identity: adapter.identity,
    supported: true,
    compatibilityMessage: adapter.message,
    tools: adapter.tools
      .filter(
        (tool) =>
          inventory?.status === "loaded" &&
          inventory.tools.some((item) => item.name === tool.name),
      )
      .map((tool) => ({
        id: tool.name,
        label: tool.description!,
        operation: "read",
        toolNames: [tool.name],
        schemaFingerprint: fingerprintToolSchema(tool.inputSchema),
        allowedMethods: [],
        argumentPolicy: "bounded",
      })),
  };
}

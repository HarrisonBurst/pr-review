import documents from "./mcp-profiles/documents.json" with { type: "json" };
import slack from "./mcp-profiles/slack.json" with { type: "json" };
import linear from "./mcp-profiles/linear.json" with { type: "json" };
import axiom from "./mcp-profiles/axiom.json" with { type: "json" };
import notion from "./mcp-profiles/notion.json" with { type: "json" };
import type { KnownMcpProfile, McpOAuthProfile } from "../shared/contracts.js";

export const knownMcpProfiles: KnownMcpProfile[] = [
  documents as KnownMcpProfile,
];

export const oauthMcpProfiles: McpOAuthProfile[] = [
  slack as McpOAuthProfile,
  linear as McpOAuthProfile,
  axiom as McpOAuthProfile,
  notion as McpOAuthProfile,
];

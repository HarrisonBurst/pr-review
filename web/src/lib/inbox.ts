import type { PullRequest } from "../../../shared/contracts";

export type InboxGroup = "direct" | "team" | "other";

export const inboxGroups: { key: InboxGroup; title: string; empty: string }[] = [
  {
    key: "direct",
    title: "Requested of you",
    empty: "No open pull requests are requested of you directly.",
  },
  {
    key: "team",
    title: "Requested of your teams",
    empty: "No open pull requests are requested of a team you belong to.",
  },
  {
    key: "other",
    title: "Other tracked PRs",
    empty: "Open pull requests you import by URL appear here while no review is requested of you.",
  },
];

export function groupOf(pr: PullRequest): InboxGroup {
  if (!pr.requested) return "other";
  if (pr.requestSource === "direct" || pr.requestSource === "both") return "direct";
  if (pr.requestSource === "team") return "team";
  return "other";
}

export interface InboxAge {
  kind: "requested" | "opened";
  at: string | null;
}

export function ageOf(pr: PullRequest): InboxAge {
  if (groupOf(pr) !== "other" && pr.requestedAt) return { kind: "requested", at: pr.requestedAt };
  return { kind: "opened", at: pr.createdAt };
}

export function settled(pr: PullRequest): boolean {
  return pr.status === "submitted";
}

function rank(pr: PullRequest): number {
  if (pr.status === "ready") return 0;
  return settled(pr) ? 2 : 1;
}

export function compareInbox(a: PullRequest, b: PullRequest): number {
  const byRank = rank(a) - rank(b);
  if (byRank) return byRank;
  const ageA = ageOf(a).at;
  const ageB = ageOf(b).at;
  if (ageA !== ageB) {
    if (ageA === null) return 1;
    if (ageB === null) return -1;
    return ageA.localeCompare(ageB);
  }
  return a.number - b.number || a.id.localeCompare(b.id);
}

export type Disclosure = Record<InboxGroup, boolean>;

export const defaultDisclosure: Disclosure = { direct: true, team: true, other: false };

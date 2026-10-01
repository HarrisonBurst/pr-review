import {
  automationOff,
  inheritAutomation,
  type CommitSummary,
  type Finding,
  type MergeBlocker,
  type MergeReadiness,
  type PullRequest,
  type RequestSource,
  type ReviewPayload,
  type ReviewResult,
  type ReviewVerdict,
  type ReviewerSettings,
  type IntegrationSessionSnapshot,
} from "../shared/contracts.js";
import type { ProgressReporter } from "./progress.js";
import {
  clampText,
  parseJson,
  prId,
  repositoryParts,
  runCommand,
} from "./util.js";

export interface RemotePullRequest {
  pr: PullRequest;
  diff: string;
  diffTruncated: boolean;
}

export interface PollRequest {
  eventId: string;
  prId: string;
  headSha: string;
  requestedAt: string;
}

export interface PollResult {
  user: string;
  pullRequests: RemotePullRequest[];
  requests: PollRequest[];
}

export interface PollScope {
  numbers: number[];
  requestNumbers: number[];
}

export interface ReviewSubmissionResult {
  githubReviewId: string;
  url: string | null;
}

export interface CommitComparison {
  status: "identical" | "ahead" | "behind" | "diverged";
  commits: CommitSummary[];
  truncated: boolean;
}

export class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
  }
}

export interface GithubAdapter {
  readonly demo: boolean;
  health(): Promise<{ user: string | null; message: string }>;
  getPullRequest(
    repository: string,
    number: number,
  ): Promise<RemotePullRequest>;
  poll(
    repository: string,
    known: PullRequest[],
    scope?: PollScope,
  ): Promise<PollResult>;
  compareCommits(
    repository: string,
    baseSha: string,
    headSha: string,
  ): Promise<CommitComparison>;
  submitReview(
    pr: PullRequest,
    payload: ReviewPayload,
  ): Promise<ReviewSubmissionResult>;
  findReview(
    pr: PullRequest,
    payload: ReviewPayload,
  ): Promise<ReviewSubmissionResult | null>;
  mergeReadiness(pr: PullRequest): Promise<MergeReadiness>;
}

interface GithubPullResponse {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  user: { login: string; avatar_url?: string };
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  state: "open" | "closed";
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

interface GithubRequestResponse {
  users?: Array<{ login: string }>;
  teams?: Array<{ id: number; slug?: string }>;
}

interface GithubListedPull {
  number: number;
  users: string[];
  teams: number[];
}

interface GithubEvent {
  id: number | string;
  event: string;
  created_at: string;
  commit_id?: string;
  requested_reviewer?: { login?: string };
  requested_team?: { id?: number; slug?: string };
}

interface GithubTeamResponse {
  id: number;
  slug: string;
  organization?: { login?: string };
}

interface RequestIdentity {
  login: string;
  teamIds: Set<number>;
}

interface GithubReviewResponse {
  id: number | string;
  html_url?: string;
  body?: string | null;
  commit_id?: string;
}

interface GithubCommitResponse {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string } | null;
    committer?: { name?: string; date?: string } | null;
  };
  author?: { login: string } | null;
}

interface GithubCompareResponse {
  status: CommitComparison["status"];
  total_commits: number;
  commits: GithubCommitResponse[];
}

interface GithubCheckContext {
  __typename: "CheckRun" | "StatusContext";
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
  isRequired?: boolean;
}

interface GithubMergeResponse {
  data?: {
    repository?: {
      pullRequest?: {
        isDraft: boolean;
        state: "OPEN" | "CLOSED" | "MERGED";
        headRefOid: string;
        mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
        mergeStateStatus: string;
        reviewDecision:
          "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
        isInMergeQueue: boolean;
        commits: {
          nodes: Array<{
            commit: {
              oid: string;
              statusCheckRollup: {
                state: string;
                contexts: { totalCount: number; nodes: GithubCheckContext[] };
              } | null;
            };
          }>;
        };
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

const mergeQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      isDraft state headRefOid mergeable mergeStateStatus reviewDecision isInMergeQueue
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

const failedConclusions = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

interface CheckSummary {
  name: string;
  url: string | null;
  required: boolean;
}

function classifyChecks(contexts: GithubCheckContext[]): {
  failed: CheckSummary[];
  pending: CheckSummary[];
} {
  const failed: CheckSummary[] = [];
  const pending: CheckSummary[] = [];
  for (const context of contexts) {
    const summary: CheckSummary = {
      name: context.name ?? context.context ?? "unnamed check",
      url: context.detailsUrl ?? context.targetUrl ?? null,
      required: context.isRequired ?? false,
    };
    if (context.__typename === "CheckRun") {
      if (context.status !== "COMPLETED") pending.push(summary);
      else if (failedConclusions.has(context.conclusion ?? ""))
        failed.push(summary);
    } else if (context.state === "ERROR" || context.state === "FAILURE")
      failed.push(summary);
    else if (context.state === "PENDING" || context.state === "EXPECTED")
      pending.push(summary);
  }
  return { failed, pending };
}

function checkBlocker(
  kind: "checks_failed" | "checks_pending",
  checks: CheckSummary[],
  required: boolean,
  checksUrl: string,
  truncated: boolean,
): MergeBlocker | null {
  if (checks.length === 0) return null;
  const count = `${truncated ? "at least " : ""}${checks.length}`;
  const verb = kind === "checks_failed" ? "failed" : "pending";
  const qualifier = required ? "required " : "";
  return {
    kind,
    summary: `${count} ${qualifier}check${checks.length === 1 && !truncated ? "" : "s"} ${verb}`,
    detail: checks.map((check) => check.name).join(", "),
    url: checks.length === 1 ? (checks[0]!.url ?? checksUrl) : checksUrl,
    required,
  };
}

export function deriveMergeReadiness(
  pr: PullRequest,
  response: GithubMergeResponse,
  checkedAt: string,
): MergeReadiness {
  const detail = response.data?.repository?.pullRequest;
  const errors = response.errors?.map((error) => error.message) ?? [];
  if (!detail)
    throw new GithubRequestError(
      `merge readiness for ${pr.repository}#${pr.number} unavailable: ${
        errors.join("; ") || "pull request not returned"
      }`,
      null,
    );
  const status = detail.mergeStateStatus ?? null;
  const snapshot = (
    state: MergeReadiness["state"],
    blockers: MergeBlocker[],
    checksTruncated = false,
    error: string | null = null,
  ): MergeReadiness => ({
    headSha: pr.headSha,
    checkedAt,
    state,
    mergeStateStatus: status,
    blockers,
    checksTruncated,
    error,
    lastKnown: null,
  });
  const unavailable = (error: string) => snapshot("unknown", [], false, error);
  if (errors.length > 0)
    return unavailable(
      `GitHub returned partial data: ${errors.join("; ")}; refresh to check again`,
    );
  if (detail.state !== "OPEN")
    return unavailable(
      `GitHub reports the pull request ${detail.state.toLowerCase()}; refresh to update it`,
    );
  if (detail.headRefOid !== pr.headSha)
    return unavailable(
      `GitHub moved to ${detail.headRefOid.slice(0, 7)} during the lookup; refresh to check the new head`,
    );
  const latest = detail.commits.nodes[0]?.commit ?? null;
  if (!latest)
    return unavailable(
      "GitHub returned no commit for the head; refresh to check again",
    );
  if (latest.oid !== pr.headSha)
    return unavailable(
      `GitHub's latest commit ${latest.oid.slice(0, 7)} is not the current head; refresh to check again`,
    );
  if (detail.isInMergeQueue) return snapshot("queued", []);
  const mergeable = status === "CLEAN" || status === "HAS_HOOKS";
  const enforced = !mergeable && status !== "UNSTABLE";
  const checksUrl = `${pr.url}/checks`;
  const rollup = latest.statusCheckRollup;
  const contexts = rollup?.contexts.nodes ?? [];
  const truncated = (rollup?.contexts.totalCount ?? 0) > contexts.length;
  const { failed, pending } = classifyChecks(contexts);
  const blockers: MergeBlocker[] = [];
  const push = (blocker: MergeBlocker | null) =>
    blocker && blockers.push(blocker);
  const prBlocker = (
    kind: MergeBlocker["kind"],
    summary: string,
    required: boolean,
    detailText: string | null = null,
  ): MergeBlocker => ({
    kind,
    summary,
    detail: detailText,
    url: pr.url,
    required,
  });
  if (detail.isDraft || status === "DRAFT")
    push(prBlocker("draft", "draft pull request", true));
  if (detail.mergeable === "CONFLICTING" || status === "DIRTY")
    push(prBlocker("conflicts", "merge conflicts with the base branch", true));
  if (status === "BEHIND")
    push(prBlocker("behind", "branch is behind the base branch", true));
  if (detail.reviewDecision === "CHANGES_REQUESTED")
    push(prBlocker("changes_requested", "changes requested", enforced));
  else if (detail.reviewDecision === "REVIEW_REQUIRED")
    push(prBlocker("review_required", "review required", enforced));
  for (const required of [true, false]) {
    const only = (checks: CheckSummary[]) =>
      checks.filter((check) => check.required === required);
    push(
      checkBlocker(
        "checks_failed",
        only(failed),
        required,
        checksUrl,
        truncated,
      ),
    );
    push(
      checkBlocker(
        "checks_pending",
        only(pending),
        required,
        checksUrl,
        truncated,
      ),
    );
  }
  if (status === "UNKNOWN" || detail.mergeable === "UNKNOWN")
    return snapshot(
      "unknown",
      blockers,
      truncated,
      "GitHub is still computing mergeability",
    );
  const contradictions = blockers.filter((blocker) => blocker.required);
  if ((mergeable || status === "UNSTABLE") && contradictions.length > 0)
    return snapshot(
      "unknown",
      blockers,
      truncated,
      `GitHub reports ${status} alongside ${contradictions
        .map((blocker) => blocker.summary)
        .join(", ")}; refresh to check again`,
    );
  if (mergeable && truncated)
    return snapshot(
      "unknown",
      blockers,
      truncated,
      `GitHub reports ${status} but returned only ${contexts.length} of ${rollup?.contexts.totalCount} checks; see the PR for the rest`,
    );
  if (mergeable) return snapshot("ready", blockers);
  if (status === "UNSTABLE") return snapshot("unstable", blockers, truncated);
  if (status === "BLOCKED" && contradictions.length === 0)
    push(
      prBlocker(
        "blocked",
        "blocked by branch protection or rules GitHub does not expose",
        true,
        truncated ? "the check list was truncated" : null,
      ),
    );
  if (
    status === "BLOCKED" ||
    status === "DIRTY" ||
    status === "BEHIND" ||
    status === "DRAFT"
  )
    return snapshot("blocked", blockers, truncated);
  return snapshot(
    "unknown",
    blockers,
    truncated,
    `GitHub reported an unrecognized merge state ${status ?? "(none)"}`,
  );
}

const unrequested = {
  requested: false,
  requestedAt: null,
  requestSource: null,
} as const;

const listProjection =
  "[.[] | {number, users: [(.requested_reviewers // [])[].login], teams: [(.requested_teams // [])[].id]}]";
const diffLimit = 2_000_000;
const pageLimit = 10;
const comparePageLimit = 3;
const shaPattern = /^[0-9a-f]{7,64}$/i;

export class GithubCliAdapter implements GithubAdapter {
  readonly demo = false;

  private async gh(
    args: string[],
    options: {
      input?: string;
      timeoutMs?: number;
      allowOutputOverflow?: boolean;
    } = {},
  ): Promise<string> {
    const result = await runCommand("gh", args, {
      input: options.input,
      timeoutMs: options.timeoutMs ?? 60_000,
      env: { ...process.env, GH_PAGER: "cat", GIT_PAGER: "cat" },
      maxOutputBytes: diffLimit,
    });
    if (
      !options.allowOutputOverflow &&
      (result.stdoutTruncated || result.stderrTruncated)
    )
      throw new GithubRequestError(
        `gh ${args.join(" ")} output overflow: exceeded ${diffLimit} character limit`,
        null,
      );
    if (result.code !== 0) {
      const detail = clampText(result.stderr || result.stdout, 4_000);
      const status = /\(HTTP (\d{3})\)/.exec(detail);
      throw new GithubRequestError(
        `gh ${args.join(" ")} failed: ${detail}`,
        status ? Number(status[1]) : null,
      );
    }
    return result.stdout;
  }

  async health(): Promise<{ user: string | null; message: string }> {
    try {
      const user = parseJson<{ login: string }>(
        await this.gh(["api", "user"], { timeoutMs: 15_000 }),
        "gh api user",
      );
      return { user: user.login, message: `Authenticated as ${user.login}` };
    } catch (error) {
      return {
        user: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getPullRequest(
    repository: string,
    number: number,
  ): Promise<RemotePullRequest> {
    const detail = parseJson<GithubPullResponse>(
      await this.gh(["api", `repos/${repository}/pulls/${number}`]),
      "pull request",
    );
    const pr = this.mapPr(repository, detail);
    if (!shaPattern.test(pr.baseSha) || !shaPattern.test(pr.headSha))
      throw new GithubRequestError(
        `pull request ${repository}#${number} returned no exact base and head SHAs`,
        null,
      );
    const diff = await this.gh(
      [
        "api",
        `repos/${repository}/compare/${pr.baseSha}...${pr.headSha}`,
        "-H",
        "Accept: application/vnd.github.v3.diff",
      ],
      { allowOutputOverflow: true },
    );
    return {
      pr,
      diff: clampText(diff, diffLimit),
      diffTruncated: diff.length > diffLimit,
    };
  }

  async poll(
    repository: string,
    known: PullRequest[],
    scope?: PollScope,
  ): Promise<PollResult> {
    const identity = await this.health();
    if (!identity.user) throw new Error(identity.message);
    let requester: RequestIdentity | null = null;
    const byId = new Map<string, RemotePullRequest>();
    const listed = new Map<number, GithubRequestResponse>();
    if (scope) {
      for (const number of scope.numbers)
        byId.set(
          prId(repository, number),
          await this.getPullRequest(repository, number),
        );
    } else {
      requester = {
        login: identity.user,
        teamIds: await this.teamIds(repository),
      };
      const candidates = new Map<number, PullRequest | null>();
      for (const [number, current] of await this.listOpen(repository)) {
        listed.set(number, current);
        const { direct, team } = this.addressed(current, requester);
        if (direct || team) candidates.set(number, null);
      }
      for (const previous of known)
        if (previous.repository === repository)
          candidates.set(previous.number, previous);
      for (const [number] of candidates) {
        const item = await this.getPullRequest(repository, number);
        byId.set(item.pr.id, item);
      }
    }
    const requests: PollRequest[] = [];
    for (const item of byId.values()) {
      if (item.pr.state !== "OPEN") {
        item.pr = { ...item.pr, ...unrequested };
        continue;
      }
      if (scope && !scope.requestNumbers.includes(item.pr.number)) {
        const previous = known.find((entry) => entry.id === item.pr.id);
        item.pr = {
          ...item.pr,
          requested: previous?.requested ?? false,
          requestedAt: previous?.requestedAt ?? null,
          requestSource: previous?.requestSource ?? null,
        };
        continue;
      }
      requester ??= {
        login: identity.user,
        teamIds: await this.teamIds(repository),
      };
      const requested = await this.requestedReviewer(
        repository,
        item.pr.number,
        requester,
        listed.get(item.pr.number),
      );
      item.pr = {
        ...item.pr,
        requested: requested.requested,
        requestedAt: requested.requestedAt,
        requestSource: requested.requestSource,
      };
      if (requested.requested)
        requests.push({
          eventId: requested.eventId,
          prId: item.pr.id,
          headSha: item.pr.headSha,
          requestedAt: requested.requestedAt ?? new Date().toISOString(),
        });
    }
    return { user: identity.user, pullRequests: [...byId.values()], requests };
  }

  async compareCommits(
    repository: string,
    baseSha: string,
    headSha: string,
  ): Promise<CommitComparison> {
    if (!shaPattern.test(baseSha) || !shaPattern.test(headSha))
      throw new GithubRequestError(
        "commit comparison requires exact SHAs",
        null,
      );
    const commits: CommitSummary[] = [];
    let status: CommitComparison["status"] = "identical";
    let total = 0;
    for (let page = 1; page <= comparePageLimit; page += 1) {
      const response = parseJson<GithubCompareResponse>(
        await this.gh([
          "api",
          `repos/${repository}/compare/${baseSha}...${headSha}?per_page=100&page=${page}`,
        ]),
        "commit comparison",
      );
      status = response.status;
      total = response.total_commits;
      for (const row of response.commits)
        commits.push({
          sha: row.sha,
          message: row.commit.message,
          author: row.author?.login ?? row.commit.author?.name ?? null,
          committedAt:
            row.commit.committer?.date ?? row.commit.author?.date ?? null,
          url: row.html_url,
        });
      if (commits.length >= total || response.commits.length === 0) break;
    }
    return { status, commits, truncated: commits.length < total };
  }

  async submitReview(
    pr: PullRequest,
    payload: ReviewPayload,
  ): Promise<ReviewSubmissionResult> {
    const response = parseJson<GithubReviewResponse>(
      await this.gh(
        [
          "api",
          `repos/${pr.repository}/pulls/${pr.number}/reviews`,
          "--method",
          "POST",
          "--input",
          "-",
        ],
        { input: JSON.stringify(payload) },
      ),
      "review submission",
    );
    return {
      githubReviewId: String(response.id),
      url: response.html_url ?? null,
    };
  }

  async findReview(
    pr: PullRequest,
    payload: ReviewPayload,
  ): Promise<ReviewSubmissionResult | null> {
    for (let page = 1; page <= pageLimit; page += 1) {
      const reviews = parseJson<GithubReviewResponse[]>(
        await this.gh([
          "api",
          `repos/${pr.repository}/pulls/${pr.number}/reviews?per_page=100&page=${page}`,
        ]),
        "review list",
      );
      const match = reviews.find(
        (review) =>
          review.commit_id === payload.commit_id &&
          (review.body ?? "") === payload.body,
      );
      if (match)
        return {
          githubReviewId: String(match.id),
          url: match.html_url ?? null,
        };
      if (reviews.length < 100) break;
    }
    return null;
  }

  async mergeReadiness(pr: PullRequest): Promise<MergeReadiness> {
    const { owner, name } = repositoryParts(pr.repository);
    const response = parseJson<GithubMergeResponse>(
      await this.gh([
        "api",
        "graphql",
        "-f",
        `query=${mergeQuery}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${pr.number}`,
      ]),
      "merge readiness",
    );
    return deriveMergeReadiness(pr, response, new Date().toISOString());
  }

  private async listOpen(
    repository: string,
  ): Promise<Map<number, GithubRequestResponse>> {
    const result = new Map<number, GithubRequestResponse>();
    for (let page = 1; page <= pageLimit; page += 1) {
      const rows = parseJson<GithubListedPull[]>(
        await this.gh([
          "api",
          `repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
          "--jq",
          listProjection,
        ]),
        "pull request list",
      );
      for (const row of rows)
        result.set(row.number, {
          users: row.users.map((login) => ({ login })),
          teams: row.teams.map((id) => ({ id })),
        });
      if (rows.length < 100) break;
    }
    return result;
  }

  private addressed(
    current: GithubRequestResponse,
    requester: RequestIdentity,
  ): { direct: boolean; team: boolean } {
    const login = requester.login.toLowerCase();
    return {
      direct:
        current.users?.some((item) => item.login.toLowerCase() === login) ??
        false,
      team:
        current.teams?.some((item) => requester.teamIds.has(item.id)) ?? false,
    };
  }

  private async teamIds(repository: string): Promise<Set<number>> {
    const owner = repositoryParts(repository).owner.toLowerCase();
    const ids = new Set<number>();
    for (let page = 1; page <= pageLimit; page += 1) {
      let rows: GithubTeamResponse[];
      try {
        rows = parseJson<GithubTeamResponse[]>(
          await this.gh(["api", `user/teams?per_page=100&page=${page}`]),
          "team membership",
        );
      } catch (error) {
        throw new GithubRequestError(
          `could not read team membership, so team review requests cannot be resolved (the GitHub token needs the read:org scope): ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof GithubRequestError ? error.httpStatus : null,
        );
      }
      for (const row of rows)
        if (row.organization?.login?.toLowerCase() === owner) ids.add(row.id);
      if (rows.length < 100) break;
    }
    return ids;
  }

  private async requestedReviewer(
    repository: string,
    number: number,
    requester: RequestIdentity,
    listed?: GithubRequestResponse,
  ): Promise<{
    requested: boolean;
    requestedAt: string | null;
    requestSource: RequestSource | null;
    eventId: string;
  }> {
    const current =
      listed ??
      parseJson<GithubRequestResponse>(
        await this.gh([
          "api",
          `repos/${repository}/pulls/${number}/requested_reviewers`,
        ]),
        "requested reviewers",
      );
    const login = requester.login.toLowerCase();
    const { direct, team } = this.addressed(current, requester);
    if (!direct && !team)
      return {
        ...unrequested,
        eventId: `request:${repository}#${number}`,
      };
    let latest: GithubEvent | null = null;
    for (let page = 1; page <= pageLimit; page += 1) {
      const events = parseJson<GithubEvent[]>(
        await this.gh([
          "api",
          `repos/${repository}/issues/${number}/events?per_page=100&page=${page}`,
        ]),
        "issue events",
      );
      for (const event of events) {
        const addressed =
          event.requested_reviewer?.login?.toLowerCase() === login ||
          (event.requested_team?.id !== undefined &&
            requester.teamIds.has(event.requested_team.id));
        if (
          event.event === "review_requested" &&
          addressed &&
          (!latest ||
            new Date(event.created_at).getTime() >
              new Date(latest.created_at).getTime())
        )
          latest = event;
      }
      if (events.length < 100) break;
    }
    return {
      requested: true,
      requestedAt: latest?.created_at ?? null,
      requestSource: direct && team ? "both" : direct ? "direct" : "team",
      eventId: latest ? String(latest.id) : `request:${repository}#${number}`,
    };
  }

  private mapPr(repository: string, row: GithubPullResponse): PullRequest {
    return {
      id: prId(repository, row.number),
      number: row.number,
      repository,
      url: row.html_url,
      title: row.title,
      body: row.body ?? "",
      author: row.user.login,
      authorAvatarUrl: row.user.avatar_url ?? null,
      headSha: row.head.sha,
      baseSha: row.base.sha,
      headRef: row.head.ref,
      baseRef: row.base.ref,
      state: row.merged_at
        ? "MERGED"
        : row.state === "open"
          ? "OPEN"
          : "CLOSED",
      ...unrequested,
      historicalRequestSource: null,
      imported: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: "unreviewed",
      blockingCount: 0,
      nonBlockingCount: 0,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changed_files,
      lastReviewedAt: null,
      hasReviewedHead: false,
      hasReviewHistory: false,
      mergeReadiness: null,
      automation: inheritAutomation,
      effectiveAutomation: automationOff,
    };
  }
}

const demoDiff = `diff --git a/src/demo.ts b/src/demo.ts
index 1111111..2222222 100644
--- a/src/demo.ts
+++ b/src/demo.ts
@@ -1,3 +1,4 @@
 export function demo() {
-  return "old";
+  return "demo";
 }
`;

function demoPullRequest(repository: string): RemotePullRequest {
  const number = 42;
  const currentRepository = repository || "demo/repository";
  return {
    pr: {
      id: prId(currentRepository, number),
      number,
      repository: currentRepository,
      url: `https://github.com/${currentRepository}/pull/${number}`,
      title: "Deterministic demo review",
      body: "This is an explicitly labeled local demo fixture.",
      author: "demo-author",
      authorAvatarUrl: null,
      headSha: "demo-head-sha-1",
      baseSha: "demo-base-sha-1",
      headRef: "demo/change",
      baseRef: "main",
      state: "OPEN",
      requested: true,
      requestedAt: "2026-01-01T00:00:00.000Z",
      requestSource: "direct",
      historicalRequestSource: null,
      imported: false,
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "unreviewed",
      blockingCount: 0,
      nonBlockingCount: 0,
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      lastReviewedAt: null,
      hasReviewedHead: false,
      hasReviewHistory: false,
      mergeReadiness: null,
      automation: inheritAutomation,
      effectiveAutomation: automationOff,
    },
    diff: demoDiff,
    diffTruncated: false,
  };
}

export class DemoGithubAdapter implements GithubAdapter {
  readonly demo = true;

  async health(): Promise<{ user: string | null; message: string }> {
    return { user: "demo-user", message: "Deterministic demo adapter enabled" };
  }

  async getPullRequest(
    repository: string,
    number: number,
  ): Promise<RemotePullRequest> {
    const result = demoPullRequest(repository);
    if (number !== result.pr.number)
      throw new Error("demo fixture only supports pull request 42");
    return result;
  }

  async poll(repository: string): Promise<PollResult> {
    const item = demoPullRequest(repository);
    return {
      user: "demo-user",
      pullRequests: [item],
      requests: [
        {
          eventId: "demo-request-event-1",
          prId: item.pr.id,
          headSha: item.pr.headSha,
          requestedAt: item.pr.requestedAt ?? new Date().toISOString(),
        },
      ],
    };
  }

  async compareCommits(): Promise<CommitComparison> {
    return { status: "identical", commits: [], truncated: false };
  }

  async submitReview(): Promise<ReviewSubmissionResult> {
    return {
      githubReviewId: "demo-review-1",
      url: "https://example.invalid/pr-review-demo/review-1",
    };
  }

  async findReview(): Promise<ReviewSubmissionResult | null> {
    return null;
  }

  async mergeReadiness(pr: PullRequest): Promise<MergeReadiness> {
    return {
      headSha: pr.headSha,
      checkedAt: new Date().toISOString(),
      state: "blocked",
      mergeStateStatus: "BLOCKED",
      blockers: [
        {
          kind: "review_required",
          summary: "review required",
          detail: null,
          url: pr.url,
          required: true,
        },
        {
          kind: "checks_pending",
          summary: "1 required check pending",
          detail: "demo-ci",
          url: `${pr.url}/checks`,
          required: true,
        },
      ],
      checksTruncated: false,
      error: null,
      lastKnown: null,
    };
  }
}

export interface ReviewerInput {
  pr: PullRequest;
  diff: string;
  draft: {
    overview: string;
    body: string;
    findings: Finding[];
    verdict: ReviewVerdict;
  } | null;
  instructions?: string;
  findingIds?: string[];
  integrationSnapshot?: IntegrationSessionSnapshot;
}

export interface ReviewerAdapter {
  health(): Promise<{
    status: "ready" | "unavailable" | "error";
    message: string;
  }>;
  run(
    input: ReviewerInput,
    settings: ReviewerSettings,
    runId: string,
    signal?: AbortSignal,
    progress?: ProgressReporter,
  ): Promise<{ result: ReviewResult; log: string }>;
}

const demoFinding: Finding = {
  id: "demo-finding-1",
  severity: "non_blocking",
  path: "src/demo.ts",
  line: 3,
  startLine: null,
  side: "RIGHT",
  body: "The demo branch changes the return value without a regression test.",
  evidence: "The changed return line has no accompanying test change.",
  origin: "introduced",
  included: true,
  questionId: null,
};

export class DemoReviewerAdapter implements ReviewerAdapter {
  async health(): Promise<{ status: "ready"; message: string }> {
    return { status: "ready", message: "Deterministic demo reviewer enabled" };
  }

  async run(
    input: ReviewerInput,
  ): Promise<{ result: ReviewResult; log: string }> {
    const result: ReviewResult = {
      overview:
        '- `demo()` now returns "demo" instead of "old"; callers of the return value see the new string.\n- No other code paths in the demo fixture change.',
      body: input.instructions
        ? `Demo revision: ${input.instructions}`
        : "Demo review completed with one non-blocking finding.",
      findings: [demoFinding],
      verdict: "COMMENT",
      rationale:
        "The deterministic demo fixture exercises the editable finding and preview flow.",
    };
    return { result, log: "demo adapter: deterministic fixture" };
  }
}

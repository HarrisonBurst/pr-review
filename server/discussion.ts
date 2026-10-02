import { createHash } from "node:crypto";
import type {
  DiscussionSnapshot,
  DiscussionSource,
  DiscussionCoverage,
  PullRequest,
  ReviewComment,
  ReviewPayload,
} from "../shared/contracts.js";
import type { ReviewInventory } from "./publication.js";
import { canonicalJson } from "./schema.js";

export type GithubRead = (args: string[]) => Promise<string>;
export const revision = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const emptyCoverage = (): DiscussionCoverage => ({
  complete: false,
  comments: { pages: 0, complete: false, error: null },
  reviews: { pages: 0, complete: false, error: null },
  threads: { pages: 0, complete: false, error: null },
});

export async function githubPages(
  read: GithubRead,
  endpoint: string,
): Promise<any[]> {
  const rows: any[] = [];
  const ids = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const batch = JSON.parse(
      await read(["api", `${endpoint}?per_page=100&page=${page}`]),
    );
    if (!Array.isArray(batch))
      throw new Error("GitHub pagination returned an invalid page");
    for (const row of batch) {
      if (!row || row.id === undefined || ids.has(String(row.id)))
        throw new Error(
          "GitHub pagination contained missing or duplicate identities",
        );
      ids.add(String(row.id));
      rows.push(row);
    }
    if (rows.length > 1000) throw new Error("GitHub source limit exceeded");
    if (batch.length < 100) return rows;
  }
  throw new Error("GitHub pagination exceeded its page limit");
}

function source(
  kind: DiscussionSource["kind"],
  row: any,
  thread?: any,
): DiscussionSource {
  const author = row.user?.login ?? row.author?.login;
  const validAuthor =
    typeof author === "string" && author.length > 0 && author.length <= 100;
  const authorType = validAuthor
    ? (row.user?.type ?? row.author?.__typename)
    : "unknown";
  const body = row.body;
  const url = row.html_url ?? row.url;
  if (
    row.id === undefined ||
    typeof body !== "string" ||
    typeof url !== "string" ||
    !/^https:\/\/github\.com\//.test(url)
  )
    throw new Error("GitHub discussion source is incomplete");
  const value = {
    kind,
    id: String(row.databaseId ?? row.id),
    author: typeof author === "string" ? author : "unknown",
    authorType:
      authorType === "User" || authorType === "Bot" ? authorType : "unknown",
    body,
    url,
    updatedAt: row.updated_at ?? row.updatedAt ?? row.submitted_at ?? null,
    threadId: thread?.id ?? null,
    replyToId: row.replyTo?.databaseId ? String(row.replyTo.databaseId) : null,
    reviewId: row.pullRequestReview?.databaseId
      ? String(row.pullRequestReview.databaseId)
      : null,
    resolved: thread?.isResolved ?? null,
    outdated: thread?.isOutdated ?? null,
    provenance:
      authorType === "Bot" ||
      (typeof author === "string" && author.endsWith("[bot]"))
        ? "bot"
        : authorType === "User"
          ? "participant"
          : "unknown",
  } as Omit<DiscussionSource, "version">;
  if (Buffer.byteLength(body) > 20000)
    throw new Error("GitHub discussion source exceeds the byte limit");
  return { ...value, version: revision(value) };
}

const commentFields =
  "id databaseId body url updatedAt author { __typename login } replyTo { databaseId } pullRequestReview { databaseId }";

export async function acquireDiscussion(
  read: GithubRead,
  pr: PullRequest,
): Promise<DiscussionSnapshot> {
  const coverage = emptyCoverage();
  const sources: DiscussionSource[] = [];
  const endpoint = `repos/${pr.repository}`;
  for (const [collection, path, kind] of [
    ["comments", `${endpoint}/issues/${pr.number}/comments`, "comment"],
    ["reviews", `${endpoint}/pulls/${pr.number}/reviews`, "review"],
  ] as const) {
    try {
      const rows = await githubPages(async (args) => {
        coverage[collection].pages++;
        return read(args);
      }, path);
      sources.push(
        ...rows.map((row) =>
          source(
            kind,
            kind === "review" ? { ...row, body: row.body ?? "" } : row,
          ),
        ),
      );
      coverage[collection].complete = true;
    } catch {
      coverage[collection].error =
        "Discussion acquisition failed, incomplete or exceeded its limits";
    }
  }
  const [owner, name] = pr.repository.split("/");
  const graph = async (
    query: string,
    fields: Record<string, string | number | null>,
  ) => {
    if (++coverage.threads.pages > 20)
      throw new Error("Inline discussion page limit exceeded");
    const value = JSON.parse(
      await read([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        ...Object.entries(fields)
          .filter(([, item]) => item !== null)
          .flatMap(([key, item]) => [
            typeof item === "number" ? "-F" : "-f",
            `${key}=${item}`,
          ]),
      ]),
    );
    if (value.errors?.length || !value.data)
      throw new Error("Inline discussion query was incomplete");
    return value.data;
  };
  const appendComments = (connection: any, thread: any) => {
    if (
      !Array.isArray(connection?.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    )
      throw new Error("Inline discussion page was incomplete");
    sources.push(
      ...connection.nodes.map((row: any) =>
        source("inline_comment", row, thread),
      ),
    );
    if (sources.length > 1000)
      throw new Error("Discussion source limit exceeded");
  };
  try {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const data = await graph(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated comments(first:100){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`,
        { owner: owner!, name: name!, number: pr.number, cursor },
      );
      const pull = data.repository?.pullRequest;
      if (
        pull?.headRefOid !== pr.headSha ||
        !Array.isArray(pull.reviewThreads?.nodes)
      )
        throw new Error(
          "PR head changed or inline discussions are unavailable",
        );
      for (const thread of pull.reviewThreads.nodes) {
        if (
          typeof thread?.id !== "string" ||
          typeof thread.isResolved !== "boolean" ||
          typeof thread.isOutdated !== "boolean"
        )
          throw new Error("Inline thread identity or state is incomplete");
        appendComments(thread.comments, thread);
        let next = thread.comments.pageInfo.hasNextPage
          ? thread.comments.pageInfo.endCursor
          : null;
        const commentCursors = new Set<string>();
        while (next) {
          if (typeof next !== "string" || commentCursors.has(next))
            throw new Error("Inline comment cursor repeated");
          commentCursors.add(next);
          const reply = await graph(
            `query($id:ID!,$cursor:String!){node(id:$id){... on PullRequestReviewThread{id isResolved isOutdated comments(first:100,after:$cursor){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}}}}`,
            { id: thread.id, cursor: next },
          );
          if (
            reply.node?.id !== thread.id ||
            reply.node.isResolved !== thread.isResolved ||
            reply.node.isOutdated !== thread.isOutdated
          )
            throw new Error("Inline thread changed during pagination");
          appendComments(reply.node.comments, thread);
          next = reply.node.comments.pageInfo.hasNextPage
            ? reply.node.comments.pageInfo.endCursor
            : null;
          if (reply.node.comments.pageInfo.hasNextPage && !next)
            throw new Error("Inline comment cursor missing");
        }
        if (
          thread.comments.pageInfo.hasNextPage &&
          !thread.comments.pageInfo.endCursor
        )
          throw new Error("Inline comment cursor missing");
      }
      const info = pull.reviewThreads.pageInfo;
      if (typeof info?.hasNextPage !== "boolean")
        throw new Error("Inline thread pagination incomplete");
      cursor = info.hasNextPage ? info.endCursor : null;
      if (info.hasNextPage && (!cursor || seen.has(cursor)))
        throw new Error("Inline thread cursor missing or repeated");
      if (cursor) seen.add(cursor);
    } while (cursor);
    coverage.threads.complete = true;
  } catch {
    coverage.threads.error =
      "Inline discussion acquisition failed, changed, incomplete or exceeded its limits";
  }
  const identities = sources.map((item) => `${item.kind}:${item.id}`);
  const complete = Object.values({
    comments: coverage.comments,
    reviews: coverage.reviews,
    threads: coverage.threads,
  }).every((item) => item.complete);
  coverage.complete =
    complete &&
    identities.length === new Set(identities).size &&
    sources.length <= 1000 &&
    Buffer.byteLength(
      JSON.stringify({ sources, title: pr.title, body: pr.body }),
    ) <= 200000;
  if (complete && !coverage.complete)
    coverage.threads.error =
      "Discussion identities or aggregate input limits are incomplete";
  return {
    prId: pr.id,
    headSha: pr.headSha,
    fetchedAt: new Date().toISOString(),
    coverage,
    sources,
    revision: revision({
      head: pr.headSha,
      title: pr.title,
      body: pr.body,
      author: pr.author,
      coverage,
      sources,
    }),
  };
}

export async function acquireReviewInventory(
  read: GithubRead,
  pr: PullRequest,
): Promise<ReviewInventory> {
  const user = JSON.parse(await read(["api", "user"]));
  if (typeof user.login !== "string" || !user.login)
    throw new Error("Review writer identity unavailable");
  const rows = await githubPages(
    read,
    `repos/${pr.repository}/pulls/${pr.number}/reviews`,
  );
  const reviews: ReviewInventory["reviews"] = [];
  let inlineRows: any[] | null = null;
  for (const row of rows) {
    if (
      !row.submitted_at ||
      !["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(row.state)
    )
      continue;
    if (
      typeof row.user?.login !== "string" ||
      typeof row.body !== "string" ||
      typeof row.commit_id !== "string" ||
      !Number.isFinite(Date.parse(row.submitted_at))
    )
      throw new Error("Review attribution or payload is incomplete");
    if (row.commit_id === pr.headSha && inlineRows === null) {
      inlineRows = await githubPages(
        read,
        `repos/${pr.repository}/pulls/${pr.number}/comments`,
      );
      if (
        inlineRows.some(
          (comment) => !Number.isInteger(comment.pull_request_review_id),
        )
      )
        throw new Error("Inline review attribution unavailable");
    }
    const inline =
      row.commit_id === pr.headSha
        ? inlineRows!.filter(
            (comment) =>
              String(comment.pull_request_review_id) === String(row.id),
          )
        : [];
    const comments: ReviewComment[] = inline.map((comment) => {
      if (
        typeof comment.path !== "string" ||
        !Number.isInteger(comment.line) ||
        !["LEFT", "RIGHT"].includes(comment.side) ||
        typeof comment.body !== "string" ||
        (comment.start_line !== null &&
          comment.start_line !== undefined &&
          (!Number.isInteger(comment.start_line) ||
            !["LEFT", "RIGHT"].includes(comment.start_side)))
      )
        throw new Error("Exact inline review placement unavailable");
      return {
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        ...(comment.start_line == null
          ? {}
          : { start_line: comment.start_line, start_side: comment.start_side }),
      };
    });
    const event: ReviewPayload["event"] =
      row.state === "APPROVED"
        ? "APPROVE"
        : row.state === "CHANGES_REQUESTED"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    reviews.push({
      id: String(row.id),
      url: row.html_url ?? null,
      author: row.user.login,
      submittedAt: row.submitted_at,
      payload: { event, body: row.body, commit_id: row.commit_id, comments },
      commentIds: inline.map((item) => String(item.id)),
    });
  }
  if (
    reviews.reduce(
      (count, item) => count + item.commentIds.length,
      rows.length,
    ) > 1000
  )
    throw new Error("Review/inline evidence limit exceeded");
  return {
    writer: user.login,
    reviewIds: rows.map((row) => String(row.id)),
    reviews,
  };
}

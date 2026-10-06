import type { PollScope, RemotePullRequest } from "../../adapters.js";
import { publicationFixture } from "./auto-submission.js";

export async function backlogFixture(count = 3) {
  const f = await publicationFixture(count === 0);
  const rows = new Map<number, RemotePullRequest>();
  for (let number = 42; number < 42 + count; number++) {
    const item = structuredClone(f.github.current);
    item.pr.id = `demo/repository#${number}`;
    item.pr.number = number;
    item.pr.url = `https://github.com/demo/repository/pull/${number}`;
    item.pr.title = `SYNTHETIC inert backlog ${number}`;
    item.pr.headSha = `synthetic-head-${number}`;
    item.pr.imported = false;
    rows.set(number, item);
    f.service.db.upsertPr(item.pr, item.diff, item.diffTruncated);
  }
  f.github.getPullRequest = async (_repository, number) => {
    await f.github.beforeHead?.();
    return structuredClone(rows.get(number)!);
  };
  f.github.poll = async (
    _repository?: string,
    _known?: unknown,
    scope?: PollScope,
  ) => {
    await f.github.beforeHead?.();
    const items = [...rows.values()].filter(
      (item) => !scope || scope.numbers.includes(item.pr.number),
    );
    return {
      user: "demo-user",
      pullRequests: structuredClone(items),
      requests: items
        .filter((item) => item.pr.requested)
        .map((item) => ({
          eventId: `synthetic-request-${item.pr.number}`,
          prId: item.pr.id,
          headSha: item.pr.headSha,
          requestedAt: "2026-01-01T00:00:00Z",
        })),
    };
  };
  f.service.updateSettings({
    repository: "demo/repository",
    automation: {
      pollCommits: true,
      reviewNewCommits: true,
      pollRequests: true,
      reviewRequests: true,
    },
    maxConcurrentReviews: 1,
  });
  await f.service.sync();
  return {
    ...f,
    rows,
    get service() {
      return f.service;
    },
  };
}

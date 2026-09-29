import type { PullRequest } from "../../../shared/contracts.js";
import { DemoGithubAdapter, type PollScope } from "../../adapters.js";
import { prId } from "../../util.js";

export function deferredWork() {
  const work = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  return { ...work, entered: entered.promise, enter: entered.resolve };
}

export class DeferredGithub extends DemoGithubAdapter {
  sync: ReturnType<typeof deferredWork> | null = null;
  imports = new Map<number, ReturnType<typeof deferredWork>>();
  readiness: ReturnType<typeof deferredWork> | null = null;
  pollCalls = 0;
  pollScopes: Array<PollScope | undefined> = [];
  fetched: number[] = [];
  readinessCalls: number[] = [];
  state: PullRequest["state"] = "OPEN";

  override async poll(
    repository: string,
    _known: PullRequest[] = [],
    scope?: PollScope,
  ) {
    this.pollCalls += 1;
    this.pollScopes.push(scope);
    this.sync?.enter();
    await this.sync?.promise;
    return super.poll(repository);
  }

  override async getPullRequest(repository: string, number: number) {
    this.fetched.push(number);
    const work = this.imports.get(number);
    work?.enter();
    await work?.promise;
    const remote = await super.getPullRequest(repository, 42);
    remote.pr = {
      ...remote.pr,
      id: prId(repository, number),
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      title: `Inert lifecycle fixture #${number}`,
      state: this.state,
    };
    return remote;
  }

  override async mergeReadiness(pr: PullRequest) {
    this.readinessCalls.push(pr.number);
    this.readiness?.enter();
    await this.readiness?.promise;
    return super.mergeReadiness(pr);
  }

  override async submitReview(): Promise<never> {
    throw new Error("Publishing is disabled in the inert lifecycle fixture");
  }
}

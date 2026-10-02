import {
  clampText,
  repositoryParts,
  runCommand,
  type CommandResult,
} from "./util.js";

export interface SourceIdentity {
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export function commandEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDE_CODE_SIMPLE: _simple, ...rest } = base;
  return {
    ...rest,
    GH_PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export class CommandFailure extends Error {
  constructor(
    message: string,
    readonly summary: string,
  ) {
    super(message);
  }
}

export function commandDiagnostic(result: {
  stdout: string;
  stderr: string;
  code: number;
}): string {
  return clampText(
    result.stderr || result.stdout || `process exited with code ${result.code}`,
    5_000,
  );
}

export class SourceCheckout {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  git(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    return runCommand("git", args, {
      cwd,
      signal,
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 2_000_000,
      env: this.env,
    });
  }

  private async fetchArguments(
    source: SourceIdentity,
    checkoutDir: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const { owner, name } = repositoryParts(source.repository);
    const remote = await this.git(
      ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"],
      checkoutDir,
      signal,
    );
    const configuration = await this.git(
      ["config", "--local", "--no-includes", "--name-only", "--list"],
      checkoutDir,
      signal,
    );
    const url = remote.stdout.trim();
    const repository = `${owner}/${name}`.toLowerCase();
    const https = /^https:\/\/github\.com\/([^\s?#]+)$/.exec(url);
    const ssh =
      /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^\s?#]+)$/.exec(url);
    const destination = (https ?? ssh)?.[1].replace(/\.git$/, "").toLowerCase();
    if (
      remote.code !== 0 ||
      configuration.code !== 0 ||
      destination !== repository ||
      configuration.stdout
        .trim()
        .split("\n")
        .some(
          (key) =>
            !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.[^.]+\.(?:url|fetch|tagopt)|branch\..+\.(?:remote|merge))$/.test(
              key,
            ),
        )
    )
      throw new CommandFailure(
        "Unable to prepare review checkout: origin or Git configuration is not trusted for the recorded GitHub repository",
        "Unable to prepare review checkout: origin or Git configuration is not trusted for the recorded GitHub repository",
      );
    return https
      ? [
          "-c",
          "credential.helper=",
          "-c",
          `credential.${url}.helper=`,
          "-c",
          `credential.${url}.helper=!gh auth git-credential 2>/dev/null`,
          "-c",
          "credential.useHttpPath=true",
          "-c",
          "core.askPass=",
          "-c",
          "http.followRedirects=false",
        ]
      : [];
  }

  private async verifyRevision(
    checkoutDir: string,
    label: string,
    revision: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const verified = await this.git(
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      checkoutDir,
      signal,
    );
    if (
      verified.code !== 0 ||
      verified.stdout.trim().toLowerCase() !== revision.toLowerCase()
    )
      throw new CommandFailure(
        `Prepared ${label} revision does not match recorded ${revision}: ${commandDiagnostic(verified)}`,
        `Prepared ${label} revision does not match recorded ${revision}`,
      );
  }

  async matches(
    source: SourceIdentity,
    checkoutDir: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const head = await this.git(
      ["rev-parse", "--verify", "HEAD"],
      checkoutDir,
      signal,
    );
    if (
      head.code !== 0 ||
      head.stdout.trim().toLowerCase() !== source.headSha.toLowerCase()
    )
      return false;
    const base = await this.git(
      [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${source.baseSha}^{commit}`,
      ],
      checkoutDir,
      signal,
    );
    return (
      base.code === 0 &&
      base.stdout.trim().toLowerCase() === source.baseSha.toLowerCase()
    );
  }

  async prepare(
    source: SourceIdentity,
    runDir: string,
    checkoutDir: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    repositoryParts(source.repository);
    const log: string[] = [];
    const clone = await runCommand(
      "gh",
      [
        "repo",
        "clone",
        source.repository,
        checkoutDir,
        "--",
        "--no-tags",
        "--no-checkout",
      ],
      {
        cwd: runDir,
        signal,
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 200_000,
        env: this.env,
      },
    );
    if (clone.code !== 0)
      throw new CommandFailure(
        `Unable to prepare review checkout: gh repo clone failed: ${commandDiagnostic(clone)}`,
        `Unable to prepare review checkout: gh repo clone failed`,
      );
    log.push("temporary repository checkout prepared");

    const fetchArguments = await this.fetchArguments(
      source,
      checkoutDir,
      signal,
    );
    const baseFetch = await this.git(
      [...fetchArguments, "fetch", "--no-tags", "origin", source.baseSha],
      checkoutDir,
      signal,
    );
    if (baseFetch.code !== 0)
      throw new CommandFailure(
        `Unable to prepare recorded base ${source.baseSha}: ${commandDiagnostic(baseFetch)}`,
        `Unable to prepare recorded base ${source.baseSha}`,
      );

    let headFetch = await this.git(
      [
        ...fetchArguments,
        "fetch",
        "--no-tags",
        "origin",
        `pull/${source.number}/head`,
      ],
      checkoutDir,
      signal,
    );
    const recordedHead =
      headFetch.code === 0
        ? await this.git(
            [
              "rev-parse",
              "--verify",
              "--end-of-options",
              `${source.headSha}^{commit}`,
            ],
            checkoutDir,
            signal,
          )
        : null;
    if (
      (headFetch.code !== 0 || recordedHead?.code !== 0) &&
      !/(?:authentication failed|could not read (?:username|password)|requested URL returned error: (?:401|403))/i.test(
        headFetch.stderr,
      )
    )
      headFetch = await this.git(
        [...fetchArguments, "fetch", "--no-tags", "origin", source.headSha],
        checkoutDir,
        signal,
      );
    if (headFetch.code !== 0)
      throw new CommandFailure(
        `Unable to prepare recorded head ${source.headSha}: ${commandDiagnostic(headFetch)}`,
        `Unable to prepare recorded head ${source.headSha}`,
      );

    await this.verifyRevision(checkoutDir, "base", source.baseSha, signal);
    await this.verifyRevision(checkoutDir, "head", source.headSha, signal);

    const checkout = await this.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "checkout",
        "--detach",
        "--force",
        source.headSha,
        "--",
      ],
      checkoutDir,
      signal,
    );
    if (checkout.code !== 0)
      throw new CommandFailure(
        `Unable to check out recorded head ${source.headSha}: ${commandDiagnostic(checkout)}`,
        `Unable to check out recorded head ${source.headSha}`,
      );
    const checkedOut = await this.git(
      ["rev-parse", "--verify", "HEAD"],
      checkoutDir,
      signal,
    );
    if (
      checkedOut.code !== 0 ||
      checkedOut.stdout.trim().toLowerCase() !== source.headSha.toLowerCase()
    )
      throw new CommandFailure(
        `Review checkout is not pinned to recorded head ${source.headSha}: ${commandDiagnostic(checkedOut)}`,
        `Review checkout is not pinned to recorded head ${source.headSha}`,
      );
    const diff = await this.git(
      [
        "diff",
        "--no-ext-diff",
        "--no-renames",
        `${source.baseSha}...${source.headSha}`,
      ],
      checkoutDir,
      signal,
    );
    if (diff.code !== 0)
      throw new CommandFailure(
        `Unable to prepare recorded diff ${source.baseSha}...${source.headSha}: ${commandDiagnostic(diff)}`,
        `Unable to prepare recorded diff ${source.baseSha}...${source.headSha}`,
      );
    log.push(
      `prepared immutable revisions ${source.baseSha}...${source.headSha}`,
    );
    return log;
  }
}

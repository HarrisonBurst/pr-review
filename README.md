# Local PR Review

Local PR Review is a single-user macOS app for reviewing GitHub pull requests with Claude Code, Codex or Pi and your own trusted review skill. It tracks requested and imported PRs, produces editable review drafts and lets you ask questions about selected code. You can also write comments without an AI review.

Review runs stay separate from editable drafts. Re-review and AI revision proposals never silently replace manual edits. Publishing through the app requires a preview of the exact payload and your explicit confirmation.

## Before you start

Fresh Settings selects Dangerous intent, which gives the selected harness full host-native tools, configuration and authentication. It cannot run until you explicitly Save and confirm the host risks. Dangerous tools can write files and publish outside the app's preview controls.

Choose Isolated Harnesses or Docker when their [documented limits](docs/execution-modes.md) fit your review skill. Isolated Harnesses restricts tools but does not provide OS or process containment. Docker requires separate capability approval and setup consent. Neither mode falls back to Dangerous.

The Node.js and TypeScript backend serves the React UI on loopback and stores private repository content, drafts and execution captures locally in SQLite and app files. The default data directory is `~/Library/Application Support/pr-review`; app-owned OAuth credentials use macOS Keychain. Setup and Save do not rewrite installed skills or native authentication, but Dangerous tools retain their own side effects. See [storage and backups](docs/configuration.md#configuration-and-storage).

## Prerequisites

### Required

- Use macOS. Linux and headless operation are not supported.
- Install Node.js 24 or newer, npm and Git. CI uses Node 24. The app uses Node's built-in SQLite and needs no database service.
- Install the official [GitHub CLI](https://cli.github.com/) and authenticate it with access to your repository. Check authentication with `gh auth status` and repository access with `gh repo view owner/repository`, replacing `owner/repository` with your target. The app invokes `gh`, not an agent-specific wrapper.

### For AI reviews and questions

- Install and authenticate one supported CLI through its native setup: [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://github.com/openai/codex) or [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). You do not need all three. Configure another harness only if your skill or selected workflow uses it.
- Supply your own trusted review skill. The default entry, `~/.claude/skills/pr-review/SKILL.md`, is not bundled; choose an absolute Markdown entry in Settings if yours differs. Its resources and output must satisfy the [review output contract](docs/review-output.md).

Model catalog discovery does not prove account or model access. You can write and edit comments without an AI harness or review skill.

### Optional Docker execution

Install Docker only if you choose Docker mode. Before consenting to app-managed setup, check the pinned runtime, architecture and authentication support in [Docker boundaries](docs/docker-boundaries.md). A working Docker installation alone is not enough.

## Install, build and run

Clone the public repository, install its locked dependencies and build the app:

```sh
git clone https://github.com/HarrisonBurst/pr-review.git
cd pr-review
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. Keep the app loopback-only and do not expose it through a reverse proxy or tunnel. Stop the foreground server with Ctrl-C; these commands install no login service.

On first launch:

1. Enter `owner/repository` or import a PR URL.
2. In Settings, leave automation off and choose an execution mode, harness, model and trusted skill. Follow that mode's [Save and consent requirements](docs/execution-modes.md).
3. Sync or import to read GitHub data. Review, Re-review and Ask AI invoke the configured harness.
4. Edit and Save a draft locally. AI revisions are proposals and never silently replace manual edits.
5. Inspect the exact Preview payload. Confirm a submission only when you intend to publish it to GitHub.

Connections for Isolated and Docker use separate app-owned authorization and explicit read grants. Authentication alone grants no reviewer tools, and Connected does not prove a successful content read. See [Connections](docs/execution-modes.md#connections) before granting provider access.

## Documentation

- [Reviewing pull requests](docs/reviewing.md): inbox, drafts, comments, Ask AI, automation and concurrency.
- [Execution and Settings](docs/execution-modes.md): mode selection, model discovery, connections and upgrade consequences.
- [Configuration and troubleshooting](docs/configuration.md): environment variables, storage, backups and common setup failures.
- [Review skill output](docs/review-output.md) and [trusted sources](docs/trusted-sources.md): skill requirements and capture limits.
- [Contributing](CONTRIBUTING.md): development commands, checks and safe fixtures. [API contracts](API_CONTRACT.md) and [execution boundaries](EXECUTION_BOUNDARY.md) describe implementation details.
- [Security reporting](SECURITY.md) and [public validation](docs/publication-readiness.md): reporting guidance and verification limits.

## License

Project code uses the [MIT license](LICENSE). The bundled seccomp component retains its [Apache-2.0 license](server/execution/LICENSE.seccomp). Dependencies and separately installed runtimes retain their own licenses.

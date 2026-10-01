# Configuration and troubleshooting

For installation and first launch, start with the [README](../README.md#install-build-and-run). Run shell commands below from the repository root. For execution choices and provider access, use the [Execution and Settings guide](execution-modes.md).

## Configuration and storage

Export environment variables in your shell; the app does not load a `.env` file. Settings defaults initialize new settings and do not overwrite saved choices. General Settings saves never choose an execution mode or grant tools.

| Variable                            | Purpose or default                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `PR_REVIEW_HOST`                    | Loopback only, default `127.0.0.1`.                                              |
| `PR_REVIEW_PORT`                    | Default `4317`.                                                                  |
| `PR_REVIEW_REPOSITORY`              | Optional `owner/name`.                                                           |
| `PR_REVIEW_POLL_INTERVAL`           | Default 300 seconds.                                                             |
| `PR_REVIEW_SKILL_PATH`              | Initial unsaved review entry.                                                    |
| `PR_REVIEW_MODEL`                   | Initial unsaved Main model, normally null for native-default resolution on Save. |
| `PR_REVIEW_ADDITIONAL_INSTRUCTIONS` | Additional trusted reviewer instructions.                                        |
| `PR_REVIEW_DATA_DIR`                | Overrides the data directory.                                                    |
| `PR_REVIEW_DB_PATH`                 | Overrides only the database location.                                            |
| `PR_REVIEW_DEMO=1`                  | Selects deterministic fixtures, never a fallback after a live error.             |

`PR_REVIEW_HARNESS_CONFIG` and `PR_REVIEW_WORKFLOW_CONFIG` are retired and select or import nothing. `XDG_DATA_HOME`, when set, changes the default data root.

The normal database is `~/Library/Application Support/pr-review/pr-review.sqlite`. Demo mode defaults to the separate `pr-review-demo` directory. Captured trusted skill and resource bytes are stored with app data; app-owned OAuth credentials use macOS Keychain rather than SQLite.

Treat the data directory as private. It contains repository content, drafts, execution captures and diagnostic evidence, and selected sources may contain sensitive text. Back up the whole directory only while the app is stopped; restoring SQLite does not restore Keychain authorization.

## Troubleshooting

### Node, SQLite or dependency errors

Use Node 24 or newer, run `npm ci` from the root and then run `npm run build`. `npm start` requires that build. Use `npm run dev` for backend and Vite development together.

### Port already in use

Stop your own prior instance or choose another `PR_REVIEW_PORT` for the built app. Vite's development proxy targets port 4317, so changing only the backend port does not update the proxy. Never bind to a public interface.

### GitHub unavailable or inbox empty

Run `gh auth status` in the same environment that launches the app and verify repository access. The app does not import every open PR; import other PRs explicitly by URL. Sync does not run reviews while automation is disabled.

### Checkout authentication

Reviews and questions acquire their recorded base/head on the host before any harness or container starts. Hardened Git ignores global/system configuration; HTTPS fetches explicitly use the existing `gh auth git-credential` route only for the validated GitHub origin, with redirects and prompts disabled. SSH origins retain their existing trusted SSH transport. Unexpected origins or clone-local transport configuration fail closed; authentication refusals do not retry through the recorded-head fallback. No login or global Git setup is performed.

This host transport route is separate from native model authentication and app-owned Connections grants. It is operation-only, never stored in checkout Git configuration or transferred to an Isolated reviewer or Docker container. A successful clone or sync does not prove access to the recorded commits.

### Execution unavailable

Install and authenticate the selected harness, verify the absolute skill path and explicitly Save. Archived captures require a new save, not a database reset. Dangerous requires fresh confirmation every time.

Isolated Harnesses disables inherited executable hooks, plugins and extensions. Unsupported native behavior does not permit automatic host fallback.

### Docker not ready

Read the readiness card and support matrix, inspect and approve exact sources and capabilities, then separately consent to setup host effects. Source or runtime drift requires revalidation. Do not delete captures or weaken guards to bypass a refusal.

### Connections not usable

Discovery reads the selected supported native configuration, not Claude built-in connectors or existing logins. Add provider starts disabled; Connect, Load tools and explicit per-tool grants are separate steps. Provider schemas, client eligibility and supported authentication may still prevent use.

Notion supports ID-only `notion-fetch`, not search, write or agent tools. Its Test is a local check, not live-read proof. See [Notion](notion-reads.md) and [OAuth](mcp-oauth.md).

### Tests fail or work is interrupted

Keep the failure, command and revision, and report a minimal synthetic reproduction. Never attach your database, credentials, native profiles or raw diagnostics. See [recorded preparation results](publication-readiness.md); live integrations and opt-in container or Keychain tests are separate from unit-test evidence.

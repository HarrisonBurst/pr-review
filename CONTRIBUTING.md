# Contributing

Project code is [MIT licensed](LICENSE); third-party components retain their own notices. Discuss substantial changes in an issue first; keep patches focused and follow [AGENTS.md](AGENTS.md).

## Local workflow

Use macOS and Node 24 with npm. From the root:

```sh
npm ci
npm run dev
```

The backend listens on `127.0.0.1:4317`; Vite on `127.0.0.1:5173` proxies `/api` there. For credential-free UI work use `npm run dev:mock --workspace web -- --host 127.0.0.1 --port 5174 --strictPort` instead. It is explicitly labeled and has seeded drafts; `/?setup` exercises empty onboarding. The mock resets on reload.

[README](README.md#try-the-ui-without-credentials) also describes the real backend's disposable demo mode, which refuses ordinary native review dispatch.

Run relevant fixture tests first, then the full checks once:

```sh
node --import tsx --test server/test/drafts.test.ts server/test/automation.test.ts
npm run format:check
npm run typecheck
npm test
npm run build
```

Root scripts include the web workspace. For backend-only fixtures, run `node --import tsx --test server/test/*.test.ts` from the root. There is no separate lint command.

`npm run format` formats the existing script scope. Check shared contracts and canonical docs explicitly with `npx --no-install prettier --check shared/contracts.ts API_CONTRACT.md EXECUTION_BOUNDARY.md docs`. CI also checks `CONTRIBUTING.md`, `SECURITY.md`, `docs/publication-readiness.md` and `.github` explicitly.

Use the lockfile's installed tools, not an unpinned downloaded formatter. For a production build, run `npm run build`, then `npm start` from the root. See the [README setup guide](README.md#install-build-and-run).

The default tests use deterministic fixtures. Docker/native-bundle and real Keychain cases are opt-in and skipped unless their documented test environment is explicitly provided; CI does not enable them.

Do not supply production credentials, run live model/provider requests, submit GitHub reviews or enable polling for tests. Never execute PR-provided scripts, hooks or agent configuration. Use disposable data and clearly labeled fixtures when exercising a real browser.

## Change boundaries

- Shared HTTP types belong in `shared/contracts.ts`; keep `API_CONTRACT.md` consistent.
- Preserve immutable runs, editable draft versions, exact-payload confirmation and uncertain-submission recovery. Cover stale heads, edited drafts, same-SHA re-requests, polling deduplication and restart persistence when changing these flows.
- Execution modes must fail closed without implicit Dangerous fallback. Keep credentials host-side where the mode requires it and tool grants default-denied.
- Do not hand-edit lockfiles, generated artifacts or changelogs; generate necessary changes with their owning tools. Keep source and tests concise.
- Do not include app data, native profiles, screenshots of private PRs, tokens, private paths or diagnostic dumps. Inspect staged files and reachable history before proposing publication.

In a pull request, describe the user-visible change, checks run, browser evidence when applicable, and anything skipped or failed. Deterministic tests are not live integration certification. Report unrelated failures honestly instead of bundling fixes. See [SECURITY.md](SECURITY.md) for safe reporting.

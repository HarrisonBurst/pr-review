# Public source validation

This source release uses MIT for project code. The unmodified Moby seccomp profile retains [its Apache-2.0 license](../server/execution/LICENSE.seccomp). Dependencies and separately downloaded runtimes retain their own licenses; the review skill is not distributed.

## Scope

The public repository starts with a parentless, sanitized commit. Private operational memory, screenshots, captures, run artifacts and diagnostic diaries are not part of this tree or its history. Source behavior is unchanged; demo account labels use a generic identity. Local scanning and asset review cover only intended-public files and reachable objects, not excluded private history or host data. No scanner receives source uploads. Secret scanning is bounded detection, not a guarantee against every possible secret format.

## Validation

Local verification used macOS, Node 24.20.0 and npm 11.19.0:

- `npm ci`: passed without lockfile changes. npm reported **2 moderate and 1 high dependency advisories**. Dependencies were not upgraded during publication; assess these before real use. npm also reported install-script approval warnings for esbuild/fsevents.
- Focused `node --import tsx --test server/test/{automation,drafts,freshness,http,notion-reads}.test.ts`: **65 passed**, including persistence, edited drafts, same-SHA requests, automation deduplication and submission guards.
- `npm run format:check`, `npm run typecheck`, `npm run build`: passed. Build retains Vite's greater-than-500-kB chunk warning.
- `npm test`: backend **640 passed, 18 opt-in skipped**; web **232 passed, 1 failed**. The failure is `freshness > groups run metadata and secondary badges into separate rows` at `web/src/App.test.tsx:1512`: an unexpected `older commit` badge. The suite was not rerun or declared green, and this publication does not diagnose its cause.
- Local Gitleaks 8.30.0 found no leaks in the intended tracked tree. detect-secrets 1.5.0 ran with network verification disabled: 44 candidates were triaged as 16 synthetic hashes/format signatures, 3 public npm integrity pins, 5 type checks/auth-method labels, 18 synthetic test/mock literals and 2 negative credential-URL fixtures. No real credential was identified. No blanket allowlist was added.
- All intended files are UTF-8 text, with no standalone binary/image/font assets or symlinks. The embedded synthetic PNG fixture was decoded and visually inspected as one solid pixel; the synthetic WOFF2 helper constructs header/filler bytes, not a captured font. Historical screenshots and runtime binaries are excluded, not certified.

The built backend ran with disposable HOME/data on loopback in explicit **Demo mode**. A real browser verified the empty inbox, polling off, unsaved Dangerous intent and risk wording, deterministic manual Sync, and a local manual draft without a model run. Its synthetic body survived a full reload at version 2 and appeared in the exact-payload preview; Submit remained disabled without confirmation and the preview was cancelled. Read-only fixture database checks found **1 draft, 1 preview, 0 runs and 0 submissions**. Chrome reported one form-field id/name advisory.

The separately labeled web mock exercised repository setup, the empty inbox with polling off, and a seeded draft edit/Save/exact-preview/Cancel flow. Mock persistence is in-memory only. Owned fixture servers and browser were stopped afterward; no browser captures are distributed.

Live GitHub submissions, OAuth registration/sign-in, provider content reads, model execution, Docker setup, Keychain mutation and installed-service changes were intentionally excluded. Deterministic tests do not establish live integration readiness. Historical fixture timeouts were not diagnosed. Check the repository's Actions tab for the independent remote CI result; a successful CI run does not erase the local web failure above.

## Safe future updates

Clone the public repository into a separate development checkout. Make ordinary commits descending only from public `main`. If importing approved private work, copy only individually reviewed source changes into that public checkout, excluding operational data and evidence; never merge, pull, cherry-pick or push private lineage into the public repository.

Before publishing, inspect the complete staged diff, new assets and commit metadata, run local secret scanners and the documented checks, and compare remote refs. Use the public identity `HarrisonBurst <105237327+HarrisonBurst@users.noreply.github.com>` in this checkout only. Verify that new commits descend from the public tip without additional private parents. Push only an explicit non-force refspec to the intended repository:

```sh
git push git@github.com:HarrisonBurst/pr-review.git HEAD:refs/heads/main
```

Never use `--all`, `--tags`, `--mirror` or force pushes for this transfer. If the remote changed, fetch and reconcile in the public-only checkout without importing private history. Do not copy private Git directories, alternate object stores, bundles, credentials or runtime data.

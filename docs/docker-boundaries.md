# Docker setup and boundaries

## Exact additive API handoff

Canonical types remain in `shared/contracts.ts`. Isolated Main/Additional, Dangerous confirmation, common Settings fields and existing connection endpoints keep their shapes. No retired compatibility/source/import product is restored.

### 1. Save the existing Docker selection

`PATCH /api/settings/harness` remains the version-2 `NativeHarnessSelection`, with selected harness, model and absolute Markdown skill entry. Save captures the skill and supported native defaults, not approval or setup. Existing callers remain valid but cannot acquire new capabilities by sending the old setup confirmation.

### 2. Explicitly inspect capabilities

New `POST /api/settings/execution/inspect`, body `DockerInspectRequest`:

```json
{
  "harness": "pi",
  "localConnections": [
    {
      "id": "native:existing-discovered-id",
      "profileId": "pr-review-documents/1",
      "scope": ["exact-document-id"],
      "enabled": false,
      "allowedTools": []
    }
  ]
}
```

`localConnections` is optional, default empty. Its entries reuse `NativeMcpImportRequest` plus explicit enable/tool choices. Maximum eight unique discovered ids. Discovery remains the existing explicit Claude JSON/Codex TOML action and never starts stdio on the host. The known-profile registry is unchanged and shared with Isolated. A profile preset/name/readOnlyHint is not authorization.

Response: `DockerCapabilityDisclosure`, version 1, profile `container-native-1`:

- `digest`: exact disclosure identity; never compute or modify it in the UI.
- `harness`, resolved invocation `model`, `skillPath`, `skillDigest`.
- `resources`: source path, container-relative target, content digest and executable bit. No resource bytes.
- `customizations`: stable content-bound id, harness, kind (`hooks`, `extensions`, `skill-code`, `shell-prefix`), source, digest and loaded authority. This authority is arbitrary container code, not a claimed exhaustive static tool inventory. Every such component can read container scratch/workcopy, the temporary model credentials, and use already captured brokers. None can add mounts or external egress.
- `authentication`: each required primary/nested harness's own source, local presence (`present`, `missing`, `not_checked`), `compatibility:supported_reference`, `tested:false`, `exposure:temporary-container-access-token`, `readers:all-container-code`, `refresh:false`. Keychain presence is not probed. File presence is not validity, expiry or login success. These states must not be relabeled authenticated/Connected.
- `localConnections`: exact request, original native discovery reference, shared profile and profile digest, portable source digest, entry target, `transport:container-stdio`, `inventory:not_tested`, `connected:false`. Native discovery can remain unsupported for host/Isolated stdio while this separate Docker adapter is locally compatible. The registry's HTTP transport description does not claim that HTTP and stdio are the same transport; the Docker adapter reuses only its audited document operation/server/schema contract.
- `boundary`: immutable input/disposable workcopy, no network except captured brokers, no source writeback, no host execution.
- `requirements` and `evidence:local_configuration`: reviewable restrictions, not runtime availability.

This action reads trusted local configuration/resource bytes and file metadata only. It never reads model credential contents, starts a process/server, calls a provider or installs anything. Native MCP headers encountered in Codex configuration are removed before frozen runtime projection; native MCP entries are not inherited. Remote access remains separately default-denied in Connections.

Inspection requires the matching saved Docker selection. Changed selected skill bytes require Save first. Invalid shape is 400 `invalid_docker_inspection`; missing/incompatible resources or selection are 409 `docker_inspection_failed`. Failed inspection changes no saved intent. GET/SSE never inspects or refreshes the preview. The pending preview is memory-only and is cleared by Settings updates/restart; the UI must explicitly inspect again.

### 3. Separate exact capability and host-effects consent

`POST /api/settings/execution/setup` keeps `DockerSetupRequest` and adds optional `approval: DockerCapabilityApproval`. It is optional in the wire type so old callers remain valid, but missing approval returns actionable 409 `docker_setup_failed` before installation/preflight. Old requests never approve the new behavior.

```json
{
  "harness": "pi",
  "confirmation": "Set up the app-owned Docker runtime and read my installed skill and supported harness configuration",
  "approval": {
    "digest": "exact-inspection-digest",
    "customizations": ["every-explicitly-reviewed-customization-id"],
    "credentialExposures": ["pi"],
    "confirmation": "I approve these exact container capabilities and temporary model credential exposures"
  }
}
```

Use the shared `dockerSetupConfirmation` and `dockerApprovalConfirmation` constants. Show all identities, sources, capabilities, selected local connection/tool/scope choices and each credential exposure before confirmation. No prechecked consent or consent on discovery/Save/GET. Cancel sends nothing. Partial/extra/duplicate customization or exposure choices do not match and fail closed. To omit an enabled customization, change its native configuration explicitly outside the app, then re-inspect; this endpoint never rewrites operator configuration.

The backend re-reads and revalidates the exact preview before any installer action. Source/config/approval drift fails. Successful setup freezes the approved skill, complete portable file projection and consent into the managed artifact. Response and cached setup lifecycle remain `HarnessStatus`/`DockerSetupStatus`. Setup readiness is not credential/provider/local-server testing. Separate host-effects consent still covers the existing credential-free installer and pins. Setup readiness does not prove model or provider authentication.

### 4. Captures and history

`ExecutionSnapshot` gains optional `docker: DockerBoundarySnapshot`, containing the profile, exact disclosure and approval. New supported Docker execution requires this marker and matching approval. Outer selection/execution version 2 and `SkillExecutionSnapshot` version 2 remain unchanged. This is additive Docker-only capture discrimination, not permission inference from older data.

Older Docker captures/artifacts without this marker stay readable but cannot preflight, run, retry or continue. The error directs the user to explicit inspection/approval/setup for new sessions. No database conversion/reset or historical rewrite occurs. Frozen approved managed artifacts, including resources and local grants, survive source edits, Settings changes and restart. Reinspection adopts changed sources only for a new approved artifact. Runtime/control/policy/artifact digest drift fails rather than substituting newer bytes. Question follow-ups/retries use the original supported capture; revisions use current explicitly saved execution with the original draft's pinned PR and remain proposals.

## Supported combinations

| Combination                               | Scope and limitations                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude, Codex, Pi Docker primaries        | Existing pinned Linux binaries/model broker; selected skill owns nested orchestration. Universal native-flag/provider parity is not claimed.                                                                                                                                                                                                                                                                     |
| Trusted selected Markdown entry/resources | Original entry name/directory, relative UTF-8 companions and executable bits; native library roots retained. No host script execution.                                                                                                                                                                                                                                                                           |
| Shared native library                     | Existing `.claude/skills`, `.codex/skills`, `.pi/agent/skills`, plus `.agents/skills` for Codex/Pi. Native loading remains native rather than Isolated's static catalog. Unsupported paths/resources fail.                                                                                                                                                                                                       |
| Hooks                                     | Existing supported Claude hooks and Codex hooks with the exact existing normalized saved trust. Additional app approval is mandatory. No hook-trust bypass.                                                                                                                                                                                                                                                      |
| Extensions/local plugins                  | Pi explicit portable extension files and already-installed absolute local Pi packages with plain relative manifest resource paths (or conventional directories). Snapshotted resources replace package reconciliation; `packages` is empty at runtime. No glob/filter/npm/git package resolution or marketplace install. Source and enabled extension authority are disclosed.                                   |
| Writable source                           | Container-owned `/scratch/workcopy`; immutable `/source/checkout` and host repository stay unchanged. Known PR agent configuration is excluded from the workcopy, retained as read-only evidence. Native tools start outside the PR tree.                                                                                                                                                                        |
| Remote business MCP                       | Existing shared registry/Connections flow, `ReadProviders` and host broker. Exact captured source/profile/schema/resource/destination grants; business credentials stay host-side. Existing Load/Test evidence rules are unchanged.                                                                                                                                                                              |
| Local MCP                                 | Discovered Claude/Codex stdio, only `node` or `/usr/local/bin/node` with one absolute `.mjs` entry, no env/auth/helpers/extra arguments. Portable sibling resources are frozen; Node built-ins/prepared dependencies only. Exact known document server/version/protocol/schema and resource ids. Disabled/ungranted local code is not materialized. No host child process.                                       |
| Local inventory/Test evidence             | Inspection is not inventory or Test. Actual container invocation validates initialization and complete inventory before each call. Bounded counts are execution evidence, never Connected. Existing host Load/Test deliberately remain unsupported for stdio; no new local Connected/Test claim or host probe is introduced.                                                                                     |
| Model authentication                      | Existing own Claude Max default macOS keychain, Codex ChatGPT default file, Pi own openai-codex file. Only required primary/nested model access/id/account fields enter temporary container storage; refresh is blank and unrelated harness files are absent. Host broker enforces fixed inference destinations. Exposure approval is mandatory. A host-only native-auth substitute was not invented or claimed. |

Unsupported: other engine/image/platform/native pins, unsupported native auth roots/providers/API-key modes, missing/expired credentials, source HOME drift, native marketplace plugins, binary/nonportable extensions, native Codex rules, connected apps, arbitrary MCP methods, legacy SSE and unreviewed OAuth MCP, host stdio, npx/package downloads, missing native/runtime dependencies and incompatible model/effort pins. Errors never select Isolated, Dangerous, another login or a weaker policy. Arbitrary third-party native compatibility is not inferred from copied files.

## Enforcement details

- No seccomp delta. Exact current policy/engine/image pins are retained. Network none, read-only root/mounts, unprivileged uid, no-new-privileges, dropped capabilities, private namespaces, 256 PIDs, 3 CPUs, 3 GiB memory and bounded tmpfs remain. Preflight now checks effective cgroup PID/memory/CPU limits as well as the prior capability/mount/network checks.
- The trusted checkout verifies base/head before review. Native container workcopy preparation re-verifies both commits and HEAD, bounds traversal to 100,000 entries and copied/generated files to 256 MiB, rejects escaping/special files and reconstructs safe Git configuration without copied hooks/remotes/config. One app-authored Git alternate reuses the object store inside the existing read-only source mount instead of duplicating history into scratch. Borrowed objects retain entry/path validation; inherited alternate chains are refused. Worktree/index/refs and new objects remain disposable, and both commits plus HEAD are verified again. See the [offline size-compatibility candidate and verification limits](docker-boundaries.md). Agent startup configuration (`.claude`, `.codex`, `.pi`, `.agents`, MCP and AGENTS/CLAUDE files) is excluded at every level. PR scripts are not executed by preparation. Immutable source retains omitted files for review.
- No writable host mount, Docker socket, host executable bridge, broad process environment, source export or fallback. Container-native tools may write scratch/workcopy and spawn descendants; supervisor cancellation, disconnect, timeout, shutdown and owner-journal recovery remove the entire owned container. Concurrent owners remain protected.
- Local MCP runs from captured resources inside that same container. Each inventory/read uses a bounded process with a 15-second limit, 200 KB response budget, 100-operation budget and four concurrent children. Each invocation validates server/protocol/schema, rejects server requests and unknown tools/arguments/resources, and passes no extra environment or authority. It cannot create external network/mount privileges. Local read results containing selected credential literals are rejected.
- Only one complete authoritative native result accepted by the existing canonical validator becomes a result/draft. Question validation, private overview/evidence, proposal/manual-edit guards and exact preview/submission behavior are retained. No source export endpoint exists.
- Execution logs add bounded workcopy and local inventory/read/denial counts, not prompts, commands, source contents, raw tool results or secrets. Counts are execution observations, not attestation of arbitrary native code. Existing literal secret filtering is not an information-flow proof against encoded tokens readable by explicitly approved container code.

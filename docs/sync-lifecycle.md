# Import and sync lifecycle

## Contract and scope

The authoritative [API contract](../API_CONTRACT.md#import-and-sync-lifecycle) defines `AppState.operations`, `SyncOperation` and `ImportOperation` in [shared/contracts.ts](../shared/contracts.ts). [ReviewService](../server/service.ts) owns the current/latest sync and the current/latest import per parsed PR identity in service memory. No SQLite migration or persisted busy bit exists. A new service starts with `sync:null, imports:[]`; its existing stored PRs, sync health, settings and review history remain separate.

An accepted operation receives a fresh UUID, captured repository, actual start timestamp and `running` status. Settlement atomically records `completed` or `failed`, final timestamp and error, clears the in-flight guard and emits the existing SSE invalidation. It includes all work already awaited by that action, including readiness, not AI jobs that existing policies might enqueue. Latest outcomes remain queryable after the initiating page closes, until that scope's next attempt or service restart. Import results are not a history log: each PR retains only its latest attempt; sync retains only its latest attempt. An interrupted service does not claim success or restore running operations on restart.

Existing `syncInFlight` deduplication and first-call manual/scheduled scope are preserved. Imports now coalesce only concurrent calls to the same parser-derived repository/number. A later call still refreshes, different PRs remain independent, and sync can overlap imports. This deliberate read coalescing avoids duplicate work and conflicting status for equivalent URLs without changing import provenance, open-only admission, repository matching or review policy. Invalid request validation leaves existing operations untouched. One accepted import's failure cannot clear another import or sync. No extra provider calls, progress counts, timer-based expiry, retries, automatic reviews or generalized job infrastructure were added.

The HTTP sync route still returns HTTP 200 with `AppState` on upstream failure; check `operations.sync.status`, not HTTP status alone. Import retains its detail/error response, with outcome available separately through state. GET and SSE reconnect never initiate work. The SSE stream starts with a `change {}` invalidation and publishes actual lifecycle transitions, so fresh state reconciles missed completion/failure without event replay. Best-effort merge-readiness failure still records unknown readiness rather than failing a successful metadata import/sync.

## Verification limits

Deterministic fixtures exercise the supported contract, not live provider or installed runtime readiness. See [public validation](publication-readiness.md).

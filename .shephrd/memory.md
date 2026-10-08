# Project memory index

- Inbox viewer identity versus approved-commit semantics, Submitted precedence and inert browser regression fixture: [reviewing guide](../docs/reviewing.md#ordering-and-settled-submissions) and [API contract](../API_CONTRACT.md). Revalidate against `web/src/lib/inbox.ts`, `web/src/components/ui.tsx` and `server/discussion.ts` when changing this behavior.
- Manual preview and submission progress, exact payload and fresh head/baseline preflight: [API contract](../API_CONTRACT.md). Revalidate against `server/service.ts`, `server/adapters.ts` and `web/src/components/SubmitModal.tsx` when changing this behavior.

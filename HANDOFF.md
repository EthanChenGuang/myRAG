# HANDOFF — Plan 03.1-33 (exec/03.1-33)

**Branch:** `exec/03.1-33` → base `claude/ecstatic-hamilton-86gtwv`  
**Requirement:** DATA-15 (Nango sync on ingest queue under async switch)

## Done

- Unified Nango `document-adapter` enqueues via `submitIngest` when `RAG_INGEST_PIPELINE=unified` and `RAG_INGEST_ASYNC=on`; inline `ingest()` when async is off.
- `tests/rag/ingest/enqueue-nango.test.ts` (8 cases): adapter dispatch + two-owner queued sync, provider skip, version-2 on byte change.
- Barrel: `queueConfigFromProcessEnv` exported from `@/lib/rag` (boundary hygiene; adapter uses env gate for mock compatibility).

## Next

- Merge PR; downstream **03.1-39** (soft delete) and ledger consumers can assume Nango jobs exist under async.
- Remaining write-path plans (03.1-29…32) still need their own `submitIngest` wiring on trunk.

## How to verify

```bash
npx vitest run tests/rag/ingest/enqueue-nango.test.ts tests/rag/ingest/write-path-nango.test.ts tests/nango
npx next typegen && npx tsc --noEmit -p tsconfig.json
node scripts/ci/check-rag-boundary.mjs
```

## Open questions

- None for this plan. Async gate intentionally mirrors queue-config via env in the adapter only so 03-33 tests stay untouched; confirm product wants strict `queueConfigFromProcessEnv()` once mocks use `importOriginal`.

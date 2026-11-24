# 04-29 Summary — exact_id RRF leg + invoice filter E2E

## Outcome

- **Task 1 (D-24):** `exact_id_lookup` runs inside `runSearchStages` when `RAG_EXACT_ID_LOOKUP` is on. Hits are exposed as RRF list `exact_id` (not prepended). Leg-only exact hits hydrate document rows via a single `fetchAssemblyRows` call. Stage failure degrades to two-leg fusion.
- **Task 2 (D-05):** `tests/rag-db/v2-invoice-filters.test.mts` seeds two-tenant invoice rows and drives `/api/internal/rag/run` under `RAG_PIPELINE=v2` with `retrieval_filters.invoice` (contract string amounts).

## Commits

1. `feat(04-29): fold exact_id_lookup into v2 RRF as third list (D-24)`
2. `test(04-29): v2 invoice filters two-tenant eval proof (D-05)`

## Verification

| Gate | Result |
|------|--------|
| `npx vitest run tests/rag/v2/exact-id-rrf.test.ts tests/rag/v2/search-stages.test.ts tests/rag/exact-id.test.ts` | 42 passed |
| `npx vitest run tests/rag/v2` | (run at PR time) |
| `node --import tsx --test tests/rag-db/v2-invoice-filters.test.mts` | 4 passed, 0 failed |
| `grep -c exact_id src/lib/rag/v2/stages/search.ts` | ≥ 1 |

## Deviations

- Invoice E2E tests enable `RAG_EXACT_ID_LOOKUP` and use invoice-number queries where high similarity is required; the amount-cap case uses a query without identifier tokens so exact-id does not bypass SQL invoice caps.

## Open questions

- None.
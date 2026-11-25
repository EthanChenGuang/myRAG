# 03-45 SUMMARY — Eval harness embedding_profile

**Phase:** 03-unified-ingestion-embedding-profiles  
**Plan:** 45  
**Status:** complete

## Delivered

- **Contract:** `embedding_profile` on `RagRunOptions` and `RunManifest`; `npm run gen:schemas`
- **Eval route:** passes `options.embedding_profile` into `runRetrieval` (`embeddingProfile`) for authenticated eval only
- **Pipeline:** eval-only profile override — `getEmbeddingProfileById`, `embedQueryForEvalProfile`, search via `match_chunks_by_profile` with `p_require_active: false`
- **Harness:** `embedText(text, dims?)` (default 1536 unchanged); fake-edge vendor routes (`/voyage/v1/embeddings`, DeepInfra, OpenRouter); `--embedding-profile` on `run-smoke.mts` (implies `--no-gate`, runs `runReembed` before eval, records profile on manifest)

## Tests

- `tests/eval-route-profile.test.ts`
- `tests/rag/embeddings/profile-search.test.ts` (eval override + `p_require_active`)
- `tests/rag-db/eval-profile-run.test.mts`

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | n/a (no UI) | n/a |
| Impeccable | n/a | n/a |
| web-design-guidelines | n/a (no UI files touched) | pass (all findings resolved) |

## Notes

- Profile comparison report remains plan **03-46**; live ranking gate remains **03-48** (Guang).
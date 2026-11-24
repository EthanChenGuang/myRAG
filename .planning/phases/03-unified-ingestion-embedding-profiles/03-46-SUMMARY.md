# 03-46 SUMMARY — Profile comparison, pre-migration harness, eval evidence

**Phase:** 03-unified-ingestion-embedding-profiles  
**Plan:** 46  
**Status:** complete

## Delivered

- **Contracts:** `EmbeddingProfileComparison` and `ActivationEvidence` (Pydantic, generated Zod/JSON schemas).
- **Builder:** `eval/src/rag_eval/profile_compare.py` (`build_comparison`, `default_candidate`, paired gate).
- **Harness:** `eval/harness/run-profile-compare.mts` — split ingest, backfill run, four eval passes (gated + threshold-free × active/target), `comparison.json`.
- **SQL:** `supabase/migrations/0318_eval_evidence.sql` — `rag_record_eval_evidence` (service role).
- **CLI:** `npm run rag:embedding -- record-evidence <comparison.json> --target <id>`.

## Verification

**03-46 verifier (read-only, 2026-11-24):** `03-46-VERIFICATION.md` — **status `human_needed`** (4/5 truths). PLAN checks **PASS:** `pytest tests/test_profile_compare.py` (5/5), `activation-evidence.test.mts` (4/4). **Not run:** full `run-profile-compare.mts` harness (Task 2 e2e); no pytest drives the harness script despite PLAN Task 2 wording.

- `npm run gen:schemas` && `uv run --directory eval pytest -q tests/test_profile_compare.py tests/test_gate.py` && `npx vitest run tests/schema-parity.test.ts`
- `npx tsx eval/harness/run-profile-compare.mts --target voyage-4-large-2048 --out eval/out/compare`
- `node --import tsx --test tests/rag-db/activation-evidence.test.mts tests/rag-db/activation-gate.test.mts tests/rag-db/embedding-cli.test.mts`
- `npm run typecheck:new`

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | n/a (no UI) | n/a |
| Impeccable | n/a | n/a |
| web-design-guidelines | n/a (no UI files touched) | n/a |

## Notes

- Fake embedders in the profile-compare harness prove mechanism only; comparison `notes` state this.
- Default-candidate rule reads threshold-free cross-lingual Recall@10 (F-7).
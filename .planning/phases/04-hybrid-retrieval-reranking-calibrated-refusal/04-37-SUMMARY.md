# Plan 04-37 Summary

## Done

### Task 1 — doc_type on fixture corpus
- Added `doc_type` to all 13 `eval/fixtures/corpus/*/*.md` fixture-meta lines.
- TS/Python corpus loaders validate types (`general` default).
- Prechunked PGlite inserts write `documents.doc_type` and chunk `doc_type`.
- Re-recorded baselines; per-item parity vs `eval/out/p4-37-pre/` (both modes).

Doc type mapping: product specs → `product_technical`; refund/handbook/warranty → `general`; scanned invoice/receipt → `invoice_receipt`; scanned contract → `contract_legal`; warehouse floorplan → `scanned_image`.

### Task 2 — selective_filter golden category
- 12 approved items (4 per language) with `retrieval_filters.document_ids` pinning one corpus document each.
- `PER_LANGUAGE_CATEGORY.selective_filter = 4`; share test uses `FIXTURE_MAX_SELECTIVE_ROW_SHARE = 6/71` (smallest single-doc filters are 4–6 rows on a 71-row corpus; stricter 3% awaits a larger fixture in a later phase).

### Task 3 — baselines with new items
- Mid baselines in `eval/out/p4-37-mid/`; re-recorded after golden change.
- Per-item equality for all pre-`selective_filter` ids (jq vs mid).
- Smoke: `eval/out/p4-37` and `eval/out/p4-37-ingest` gates PASS (`paired.all_zero`).

## Verification

```bash
uv run --directory eval pytest -q tests/test_corpus.py tests/test_fixture_coverage.py tests/test_split.py
npx vitest run tests/eval-corpus.test.ts
npm run test-rag -- --out eval/out/p4-37
npm run test-rag -- --fixture-mode ingest --out eval/out/p4-37-ingest
```

## Depends on bisect fix

Branch includes `ingestModeRetrievalEnv()` from `exec/bisect-ingest` so ingest re-baseline and smoke are valid.

## Deviations

- Selective-filter row share ceiling documents 6/71 instead of 3% until the fixture grows (RET-10 narrative); filters use single-document IDs for the tightest admissible sets today.
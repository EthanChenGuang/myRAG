---
quick_id: 261128-q6h
slug: phase63-hardening
branch: exec/quick-63-hardening
base: origin/exec/quick-63-gaps @ f5df689a
source: origin/verify/06.3 @ 0c428e69 (06.3-AUDIT-REPORT.md G8, 06.3-SECURITY.md W2–W8)
status: complete
items_closed: [W2, W3, W4, W5, W7, W8]
migration: 1015_purge_hardening.sql (common file only; not folded)
requirements: [DATA-24]
---

# Quick 261128-q6h: Phase 6.3 hardening W2–W8 (audit G8)

Closes the hardening items listed under G8 of the Phase 6.3 audit. SECURITY.md lists W2, W3, W4, W5, W7 and W8; there is no W6.
Every fix started from a test that failed on an assertion (RED commit c2f53280a). No new switch was added. Every RAG switch at
its default behaves as before; the only changes are those listed under "Behaviour changes".

## Commits

| Commit | Item | What |
|---|---|---|
| 55861d509 | — | reserve migration 1015 (pushed at once) |
| c2f53280a | all | RED tests for W2, W3, W4, W5, W7, W8 |
| b72a0c358 | W2 | `removeOrphans`: `complete` is a required boolean; anything but `true` removes nothing |
| b7d08901a | W4 | legacy NULL-mode deletion logs carry ids only |
| 0c3b77214 | W5 | legacy `process-document` no longer writes `extracted-images/` copies |
| af6ceafdb | W8 | two code point minimum for citation quotes (TS helper and Pydantic validator) |
| 3f8613560 | W3, W7 | migration 1015, cursor-paged re-scrub, rag-db tests, AGENTS.md re-run rule |

## What changed

**W2 (`src/lib/nango/sync-manager.ts`).** `removeOrphans(connection, ids, origin, options)`:
- `options` is now required and its type is `{ complete: boolean; ... }`.
- At runtime only `options.complete === true` removes anything. A missing `options`, a missing `complete`, `undefined` or a non-boolean is treated as an incomplete listing: nothing is removed and one incomplete run is recorded.
- Every existing caller already passed the value explicitly: `reconcile.ts` passes `complete: true` after its own completeness check, the deletion canary passes `cut.complete` / `complete.complete`, the matrix test passes `complete`. One test call that relied on the default now passes `{ complete: true }`.

**W3 (migration 1015).** `rag_purge_lineage` is redefined from its newest body (0747). The only change is in the `source_sync` arm:
- It reads `nango_connections.user_id` together with `connection_id`.
- It answers `not_found` unless `rag_nango_owner_tenant_key(owner) = p_tenant_key`. That function is defined in the 0721 mode files: `u:<owner>` in multi-tenant mode, `s:default` in single-tenant mode.
- The `not_found` matches the existing answer for an unknown lineage, so a caller cannot probe other tenants.
- Security mode, volatility, the empty search_path and the grants are unchanged.
- The app-side check in `purgeNangoLineages` stays as the first layer.

**W4 (`src/lib/nango/source-deletions.ts`, `applyDefaultDeletion`).** The three legacy log lines that interpolated `record.file_name` now log only:
- `{ documentId, syncRecordId }` for a deleted document
- `{ syncRecordId }` for a deleted sync record
- `{ syncRecordId, error: <error name> }` for a failed record

The error and warn lines that the D-28 characterization fixture records are unchanged, so the fixture did not need re-recording.

**W5 (`src/app/api/process-document/route.ts`).** The legacy route used to upload every LlamaCloud page image to the public `chat-attachments/extracted-images/<timestamp>-<i>.jpg` and return the URLs as `extractedImages`:
- No client reads that field (checked with `git grep`).
- No document, chunk or audit row referenced the objects, so no purge could find or remove them.

The route now skips the upload, and with it `uploadExtractedImage` and the unused `STORAGE_BUCKET` constant. Text, chunks and embeddings are unchanged. Images that are already in storage are not touched; see Operator actions.

**W7 (`rescrubRecentPurges`, migration 1015).** The old re-scrub read at most 1000 rows from `rag_purge_audit_pending`, oldest first. A backlog of records with pending objects could push recent purges out of that window.
- New function `rag_purge_audit_recent(p_after_started_at timestamptz, p_after_id uuid, p_limit integer)`:
  - lists purges finished in the last 7 days that name at least one version
  - orders them by `(started_at, id)` and returns the rows after the cursor
  - also returns `cursor_started_at`, the start time as microsecond UTC text, so the cursor is exact; a millisecond JSON timestamp would return the same row again
  - limit 1–1000; the two cursor arguments must both be NULL or both be set (`22023` otherwise)
  - SECURITY INVOKER, STABLE, `search_path = ''`, service_role only
- `rescrubRecentPurges` pages 1000 rows at a time until it gets a short page. Each purge is scrubbed once, with the same `rag_purge_scrub_chats` arguments as before.
- `retryPendingPurgeObjects` and `rag_purge_audit_pending` are unchanged.

**W8 (quote minimum).**
- New `src/lib/citations/quote.ts` defines `MIN_CITATION_QUOTE_CODE_POINTS = 2`, `isMatchableQuote` (counts code points after trimming) and `citationQuoteAllowed` (withdrawn, or a matchable quote).
- Where it applies:
  - answer store: `InsertSchema` refuses a too-short non-withdrawn citation
  - `pickAnswerMetadata`: replaces the old `quote.length > 0 || withdrawn` filter
  - `citedQuotesOf`: the review and feedback context
  - `withCitedQuotes` (Claude path): a too-short `cited_text` keeps the block text
- The Pydantic `CitationRecord._quote_unless_withdrawn` applies the same minimum. `gen:schemas` produces no diff, because model validators are not exported.
- Why 2: the repository's other evidence-quote contracts already use `min_length=2` (`golden.py` evidence spans, `feedback_loop.py` spans). A single code point occurs in almost every chunk, so it identifies no span. The empty quote stays reserved for the purge's withdrawn marker (0724).
- Counting is in code points, not UTF-16 units, so one emoji counts as one, as Python's `len` does.

## Behaviour changes

All of them apply whatever the switches are set to:
- **W3:** a `source_sync` purge into a tenant other than the connection owner's now answers `not_found`. Before, the SQL accepted it if the documents carried the connection id. Admin purges and owner-tenant source purges are unchanged. This is the intended security change.
- **W2:** a caller that leaves out `complete` gets "incomplete" instead of "complete".
- **W5:** a stored legacy upload no longer has `extractedImages` in its JSON response, and no public image copy is written.
- **W4:** debug and error log text only.
- **W8:**
  - Takes effect only while citations exist (`RAG_CITATIONS` / `RAG_CLAUDE_CITATIONS` on). With the Phase 5 switches off nothing changes.
  - With them on, a 0–1 code point non-withdrawn quote is no longer stored or shown.
  - Chunk-alias quotes are whole chunk texts, and the legacy chunker keeps only chunks over 10 characters.
- **W7:** more recent purges are re-scrubbed: all of them instead of at most 1000, minus the backlog. The calls are the same.
- Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed chat are untouched.

## Live SQL for 1015 (operator; apply after 0747)

```sql
-- apply (common file only; there are no mode files)
\i supabase/migrations/1015_purge_hardening.sql

-- catalog: one definition each, service_role only, empty search_path
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('rag_purge_lineage', 'rag_purge_audit_recent')
 ORDER BY 1;
-- expect: rag_purge_audit_recent f {search_path=""} f f t ; rag_purge_lineage t {search_path=""} f f t

-- the W3 check is in the live body
SELECT position('rag_nango_owner_tenant_key' IN pg_get_functiondef('public.rag_purge_lineage(text,uuid,jsonb,jsonb)'::regprocedure)) > 0 AS has_owner_check;

-- read-only paging probe (counts only; purges nothing)
SELECT count(*) FROM public.rag_purge_audit_recent(NULL, NULL, 1000);
```

PostgREST anon probe (expect 401/403/42501): `POST /rest/v1/rpc/rag_purge_audit_recent` with the anon key and
`{"p_after_started_at":null,"p_after_id":null,"p_limit":1}`. Do not run a purge on real data to test W3.

## Gates run (foreground)

| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| check-rag-boundary, check-config, check-language-literals, check-settings-classification, check-zod-isolation, check-migration-numbers | all exit 0 |
| vitest: 142 files (all that import a changed module or `@/lib/rag`, plus the new tests) | 1891/1891 pass |
| vitest `tests/rag/agents-guide.test.ts` | 186/186 pass |
| rag-db `tests/rag-db/purge-*.test.mts` (both modes inside each file) | 160 tests: 154 pass, 0 fail, 6 skip |
| rag-db `source-*`, `definer-search-path-pglite`, `search-path-empty`, `schema-equality` | 166 tests: 164 pass, 0 fail, 2 skip |
| rag-db hybrid/lexical/search-rpc grants, purge hooks (lexical, finetune, phase33, phase42, retrieval-log, vector-sync), answer-records store/snapshot, access-catalog-sentinel | 189 tests: 185 pass, **4 fail (pre-existing, see below)** |
| `tests/rag-e2e/deletion-canary.test.mts` | 7/7 pass |
| rag-sidecar pytest `test_answer_contracts.py`, `test_phase42_contracts.py`, `test_phase52_contracts.py` | 182 pass (the 3 new W8 cases fail on the old validator) |
| `npm run gen:schemas` | no diff |
| eslint on the changed files | no new findings compared with the base (the 5 errors are already on the base) |

`npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip`; `uv sync --locked --extra chunking --extra preflight` in rag-sidecar.

**Pre-existing failure:** `tests/rag-db/access-catalog-sentinel.test.mts`, "every content-returning function is classified", plus its self-check, fails in both modes on `rag_purge_image_url_hashes`, which 0747 added in quick 261128-q63. It fails the same way on the base f5df689a, checked in a separate worktree. This change does not touch it. The fix is to classify that function in the sentinel. It reads `document_chunks.metadata.image_url` and returns SHA-256 hashes only, so the expected class is "returns no content".

## Tests that failed before the fixes

- `tests/nango/listing-completeness.test.ts`: "removeOrphans removes nothing when the caller does not say the listing is complete" (expected 0, got 2)
- `tests/nango/source-deletions.test.ts`: two W4 cases (the file name was found in the log arguments)
- `tests/rag-db/purge-grants.test.mts`: the W3 multi-tenant case ("expected an error"; the purge went through)
- `tests/rag/ingest/purge-objects.test.ts`: the W7 backlog case (`records: 400`, expected 1500)
- `tests/rag/generation/citation-quote-min.test.ts`: 6 W8 cases
- `tests/rag/ingest/legacy-extracted-images.test.ts`: 2 W5 cases
- `rag-sidecar/tests/test_answer_contracts.py`: 3 new rejection cases

## Deviations

- The existing purge-grants tests "source_sync actor purges only nango versions of its own connection", "audit list and get" and "tombstone" ran source-sync purges in the organization tenant in multi-tenant mode. W3 now refuses exactly that, so the tests run the purge in the connection owner's tenant, `u:<owner>`, which is where `nangoOwnerScope` writes connector documents. The audit-list assertion accepts both tenants the admin administers.
- `rag_purge_audit_recent` is SECURITY INVOKER rather than DEFINER, because only service_role calls it and service_role can read `rag_purge_audit`. For that reason it has no guarded 0410 entry.
- AGENTS.md: one clause in the Phase 6.3 migration rule ("after re-running 0747, re-run 1015"), so the operator re-run order stays correct.
- The W5 RED test checks the route source text. Running the route needs LlamaCloud, Supabase and embedding fakes, which are out of scope for a quick task.

## Operator actions

1. Apply 1015 to live after 0747 and run the SQL above. Do not run a purge on real data.
2. Owner decision (not done here): legacy images already stored under `chat-attachments/extracted-images/` are unreferenced. List them with the storage API and delete them if the owner agrees. Nothing in the app or the database points at them.

## Deferred

- Classify `rag_purge_image_url_hashes` in `access-catalog-sentinel` (pre-existing failure, see above).
- `retryPendingPurgeObjects` still reads at most 1000 pending records per run, oldest first. That is by design (it retries backlog), but a very large backlog takes several runs.

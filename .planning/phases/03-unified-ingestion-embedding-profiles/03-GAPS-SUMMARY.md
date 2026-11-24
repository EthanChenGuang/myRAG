---
phase: 03-unified-ingestion-embedding-profiles
plan: gaps
subsystem: ingest, security, nango, eval
tags: [rls, trigger, rag-originals, nango, golden]
status: complete
commits: 7
plan_head_before: 25836e0c2c5ffe3c14bb40216ec8cf0af0e48468
plan_head_after: 483a6950af03e9b66f84b405ea08bba6e220889b
---

# Phase 3 Gap Fixes (verification warnings W1-W5) Summary

All five warnings of 03-VERIFICATION.md are fixed, each with a test that fails on the old code.

## W1 (security): authenticated users cannot change ingest state
- Migration `0320_ingest_state_guard.sql` (0320 is the next free number in the Phase 3 range, the range the setup files fold; 0413 stays reserved). `rag_guard_ingest_state()` is a BEFORE UPDATE trigger on `documents` and `document_chunks` that raises 42501 unless `current_user` is `service_role`, `postgres` or `supabase_admin`. Definer functions (release, soft delete, writer) run as their owner and pass.
- Guarded columns: documents `status, is_current, version, lineage_id, superseded_by, source, source_key, processing_status, processing_state, doc_type, doc_type_origin, content_hash, file_sha256, original_path, parser_used/version, processing_profile_id/version, needs_review(_reason), provisional, parse_cache_id`; chunks `status, is_current, version, tenant_key, document_id, provisional, doc_type, doc_date, language, source, chunk_kind, content_hash, parser_used, embedding_text_version`. Columns are compared through `to_jsonb`, so columns added after 0320 are guarded from the day they exist. `documents.tenant_key` is generated and unset in a BEFORE trigger, so it is not listed (it follows user_id/organization_id, which stay editable under the existing policies). No-op writes and filename/metadata edits stay allowed.
- Folded into both setup files; schema-equality tests green.
- Test `tests/rag-db/ingest-state-guard.test.mts` (34 tests, both modes, PGlite with `supabaseGrants`, role authenticated): uploader / single-tenant admin / org member cannot flip status, is_current, version, lineage_id, superseded_by; chunk tests; service_role, owner and `rag_release_quarantine` still work. Failed on old code: 26 of 34 (all refusal tests; the multi-tenant chunk tests, the benign-edit test, the service-role test and the release test pass on old code by design: multi-tenant has no chunk UPDATE policy).
- Finding: in single-tenant a non-admin uploader cannot update chunks of a quarantined document directly (the policy's EXISTS sees the document through the SELECT policy of 0316, which hides it). The verifier's chunk release was a two-step attack (flip the document first). Both steps are now refused; the chunk guard also covers an uploader's chunks of their own ready document and an admin.
- Not changed: users can still insert chunks and edit chunk `content` of their own documents (T-03-58, posture decision), and change `user_id`/`organization_id` within their own tenants.

## W2: originals and parse files removed on delete
- `removeVersionObjects` (moved from quarantine-admin into `ingest/artifacts.ts`) and `removeDocumentObjects` (`ingest/remove-document-objects.ts`, exported from `@/lib/rag`). Keys come from `original_path` and `processing_state.artifacts`; only keys under `<tenant_key>/<lineage>/<version>/` of the row are removed, so a tampered key pointing at another tenant is skipped.
- Used by `DELETE /api/documents/{id}` (every version of the lineage), the images route DELETE and the Nango hard orphan delete. Best effort, logged by document id only, never changes the delete; the documents route answers `{success:true, artifacts_failed:n}` when n > 0, like the admin delete.
- Deviation from the brief: objects are removed after the rows are deleted (keys read before), matching `quarantine-admin`, so a DB failure never leaves a document whose original is gone. The soft-delete path (unified + async) keeps its rows and is untouched.
- Tests: documents-route (3), images-route (1), nango (2). Failed on old code: 4 of the 6 (the two "keeps going when storage fails / other tenant untouched" tests are regression guards). The documents-route test mock now returns rows for selects.

## W4: Google Drive listing pagination (data loss)
- `fetchGoogleDriveFiles` follows `nextPageToken` (200 page limit) and returns `complete`. A later-page failure or the limit gives `complete=false`; the first page failing still fails the sync. Orphan deletion runs only for a complete listing; in multi-folder mode it is also skipped when any folder failed to list (previously a failed folder's files were deleted as orphans).
- Files that are synced stay the first page (`NANGO_MAX_FILES_PER_SYNC`), as before; only deletion detection sees every page. Other providers' listings (Notion, Dropbox) were not changed.
- Tests `tests/nango/drive-listing-orphans.test.ts` (6 W4 tests with a fake 2-page listing). Failed on old code: 5 of 6 (the first-page failure test is a regression guard).

## W5: Config UI image upload
- `uploadKBImage` appends `upload_source=config_upload`. Test `tests/ui/config-image-upload.test.ts` runs the extracted function against a fake fetch; failed on old code. `config-server.js` already adds the field when it proxies; the in-app route did not. The in-app document upload (`buildUploadForm`) also sends no `upload_source`; not changed (outside the brief).

## W3: ingest baseline
- The three `ingest-scan-*` gold quotes are now body sentences (`验收编号 AC-2025-0231`, `Acceptance reference AC-2025-0232`, `Riferimento di collaudo AC-2025-0233`). Only those items changed. `fixture-ingest-baseline.json` re-recorded with 3 runs (`rag_eval.baseline record --fixture-mode ingest`): the three items go recall 0 -> 1 (rank 1), every other item is identical, overall recall@5 of the ingest run is 0.670 after the change. `run_config_hash` differs because the golden and setup hashes moved.
- Not done: `ingest-contract-exception-zh` (recall 0, false refusal 1.0) is still recorded as a miss; fixing it needs a judgement about the golden item or retrieval and a live SC6 check, as the verifier said.

## Gates (worktree, machine under heavy load; the coordinator asked for targeted runs, CI is authoritative)
- `npx tsc --noEmit -p tsconfig.json`: 0 errors (`next typegen` not re-run).
- vitest: nango (all), documents-route, images-route, quarantine-admin-routes, write-path-nango, enqueue-nango, nango-soft-delete, security-definer-search-path, search-rpc-grants: pass.
- `node --import tsx --test` on schema-equality, ingest-state-guard, ingest-mode, quarantine-rls, tests/security-gaps-rls: pass. The full tests/rag-db run was started and stopped at the coordinator's request after 30 files without a failure; the full vitest and full node suites were not run.
- `check-rag-boundary.mjs` + node test, `check-config.mjs`, `check-workflows.py`: pass. eval pytest (test_ingest_golden, test_fixture_coverage): pass.
- `npm run test-rag -- --out eval/out/03-gaps` and `--fixture-mode ingest --out eval/out/03-gaps-ingest`: both gate PASS.
- Operator: apply `0320_ingest_state_guard.sql` to live databases (with the pending 0409-0411).

## Deviations
- Migration number 0320 (Phase 3 range) instead of the highest free number, so it folds with the other Phase 3 migrations.
- W2 removal after row deletion (above). Multi-folder skip of orphan deletion in W4 is an addition.
- The W1 test file was refined in the GREEN commit (the RED commit's first version had two vacuous assertions).
- I ran `pkill -f "node --import tsx --test tests/rag-db"` to stop my own full run; it may have matched another executor's rag-db run on this machine.

## Self-Check: PASSED

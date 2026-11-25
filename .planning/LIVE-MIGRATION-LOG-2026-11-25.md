# Live migration log: Supabase project myRAG (<live-project-ref>), 2026-11-25

**Result: STOPPED at step 29.** The 0425 pre-check found 24 legacy functions whose live body differs from the expected pre-0425 body, and 2 more that are missing. As instructed, 0425 was not applied. Nothing after 0424 was applied either: 0425, 0501, 0502, 0601, 0602, 0603, 0701, 0702, 0703 and the 0410 re-run (r2) are all still pending.

## Before starting
- `git pull --ff-only`: already up to date on claude/ecstatic-hamilton-86gtwv.
- `ls supabase/migrations`: every file between 0320 and 0703 is on the planned list. No file numbers or mode pairs are missing from it.
- Baseline data: document `<document-id>`, chunk `<chunk-id>`.

## Migrations (one apply_migration call per file, full file text)
| # | Name | Result |
|---|------|--------|
| 1 | 0320_ingest_state_guard | ok |
| 2 | 0351_ingestion_schema_r2 | ok |
| 3 | 0352_ingestion_claim | ok |
| 4 | 0353_ingestion_transitions | ok |
| 4 | 0353_ingestion_transitions_multi_tenant | ok |
| 5 | 0354_parse_budget | ok |
| 6 | 0355_parse_cache | ok |
| 7 | 0356_backfill | ok |
| 8 | 0357_soft_delete | ok |
| 9 | 0358_progressive | ok |
| 10 | 0359_vectors_complete | ok |
| 11 | 0401_lexical_index | ok |
| 12 | 0402_relex_batch | ok |
| 13 | 0403_tenant_key_guard_multi_tenant | ok |
| 14 | 0404_document_parents | ok |
| 15 | 0405_document_parents_rls_multi_tenant | ok |
| 16 | 0406_chunking_profiles | ok |
| 17 | 0407_hybrid_search_chunks | ok |
| 18 | 0408_profile_chunk_writer | ok |
| 19 | 0409_search_rpc_revoke | ok |
| 20 | 0410_security_definer_rpc_grants | ok (as written, it drops the old 4-argument rag_fail_ingestion_job; 0422 then creates the 5-argument version) |
| 21 | 0411_security_definer_search_path | ok |
| 22 | 0412_rechunk_functions | ok |
| 23 | 0413_chunking_activation | ok |
| 24 | 0420_ingestion_queue_retention | ok |
| 25 | 0421_ingestion_queue_indexes | ok |
| 26 | 0422_ingestion_dead_letter | ok |
| 27 | 0423_ingestion_claim_lease_dead_letter | ok |
| 28 | 0424_write_chunks_null_vector | ok |
| 29 | 0425 pre-checks | **failed: STOP** |
| 30–38 | 0425 (both files), 0501, 0502 (multi-tenant), 0601, 0602, 0603, 0701, 0702, 0703, 0410_r2 | not applied |

list_migrations shows all 28 new names from 0320_ingest_state_guard through 0424_write_chunks_null_vector, after the 22 earlier entries.

## 0425 pre-check
- pgvector schema: `public` (pass).
- md5 dry run: I used the multi-tenant key of supabase/migrations/0425_expected_pre_hashes.json (135 signatures), with the header query run unchanged. The coordinator's inlined JSON was confirmed equal to the repo file.
- **Every rag_*, hybrid_search_chunks and match_chunks_by_profile target matches**, including all functions from 0301–0319 and all functions that this session applied. Nothing from 0301 onward was edited by hand.
- **26 rows differ. All of them are legacy functions from the original multi-tenant setup, not from 0301+:**
  - md5 differs (24): can_view_org_member(uuid,uuid), check_admin_status(), create_organization_safe(text,text,uuid,boolean), delete_folder(uuid,boolean), get_admin_organization_id(), get_documents_by_type_slug(uuid,text,text), get_documents_by_type_slug_workspace(uuid,uuid,text,text), get_folder_stats(uuid), get_nango_stats(uuid), get_user_current_org(), get_user_org_ids(uuid), get_user_role_in_org(uuid), get_workspace_context(text,uuid), is_admin(uuid), is_org_member(uuid,uuid), is_subscribed(uuid), move_chats_to_folder(uuid[],uuid), set_last_updated_timestamp(), share_chat(uuid,jsonb), share_personal_organization(uuid), unshare_chat(uuid), update_org_storage(), update_updated_at_column()
  - missing (2): is_org_admin(uuid), is_org_owner(uuid). Neither exists in the live database under any signature.
  - The likely cause is that the live database was created from an older multi-tenant setup file than the one 0425 was generated from. 0425 would replace those 24 bodies with the repo versions without notice, and its existence guard would stop with 55000 on the 2 missing functions. Before 0425 can run, someone must compare pg_get_functiondef for each of these with supabase/multi-tenant-setup.sql and decide how to bring them into line, for example by adding is_org_admin and is_org_owner.

## Verification at the current state (after 0424; read-only)
- a. list_migrations: all 28 names from this session through 0424 are present. The names from 0425 onward are absent because those migrations were not applied.
- b. Definers without `search_path=""`: expected at this stage, because 0425 is what sets the empty path. About 110 rows: every rag_* SECURITY DEFINER function except those already created with `''` (0320, 0357, 0358, 0413, 0420, 0422, 0424 functions), all the legacy definers listed above, match_* and get_documents_by_type_slug*, plus `rls_auto_enable()` (search_path=pg_catalog). rls_auto_enable is not a repo function, and anon and authenticated can execute it.
- c. anon or authenticated EXECUTE on rag_*/hybrid_search_chunks/match_chunks_by_profile: one row, `rag_ingest_realtime_topic_allowed(text)` (authenticated=true, anon=false). This is by design: 0353 mode file and 0410 section 2 grant it to authenticated for the Realtime RLS policy. service_role can execute all of them (0 rows lack it, trigger functions excluded).
- d. RLS: enabled on every new table that exists (document_parents, chunking_profiles, chunking_build_runs, chunking_build_gaps, ingestion_jobs, ingestion_jobs_archive, ingestion_batches, rag_parse_*, rag_embed_batches and the 0301–0319 tables). rag_answer_records, rag_semantic_cache, vector_sync_outbox, rag_vector_sync_targets and rag_backend_index_state do not exist yet, because 0501+ were not applied.
- e. Security advisors: no ERROR-level items. There are WARN items: function_search_path_mutable on 10 legacy functions, extension_in_public for vector and pg_trgm (expected, do not act), GraphQL table exposure, and anon/authenticated-executable definers (check_admin_status, is_org_member, rls_auto_enable, and others). There is also INFO rls_enabled_no_policy on 17 server-only tables, and leaked password protection is disabled.
- f. Data intact: document `<document-id>` and chunk `<chunk-id>` are the same as before. The count is still 1 and 1.

## Unexpected
- 24 legacy function bodies differ and is_org_admin and is_org_owner are missing (details above). This is the reason for the stop.
- `public.rls_auto_enable()` is a SECURITY DEFINER function that is not in the repo, and anon and authenticated can execute it.
- `is_org_member`, `is_subscribed` and `get_nango_stats` are definers with no search_path at all. 0411 does not cover them; 0425 would.

## Continuation (patch, 0425–0703)

**Result: done.** The security patch, the line-ending fix, 0425 (both files), 0501–0703 and the 0410 re-run (r2) are applied. The 0425 pre-check returned 0 rows before 0425 ran. 0426 was not applied (not on trunk yet).

### Before starting
- `git pull --ff-only`: already up to date.
- Step 1 checks (read-only):
  - Live counts: nango_connections 0, tool_execution_states 0, organizations 1, organization_members 1.
  - pg_get_functiondef of create_organization_safe, get_nango_stats, is_org_member and is_subscribed, with `\r` removed, has the same md5 as the dumps the legacy-diff report was built from. Nothing changed since the report.
- Coordinator change mid-run: 0501–0603 and 0701–0703 went in as two batch migrations (the files' exact texts joined by a newline) instead of eight separate calls. Each file keeps its own BEGIN/COMMIT, so a batch is not atomic across files. Neither batch failed.

### Steps
| # | Migration name | Result |
|---|---|---|
| 1 | read-only checks | ok (matches report) |
| 2 | patch_2026_11_security_review_multi_tenant | ok. File text applied without its top-level `BEGIN;` (line 13) and `COMMIT;` (line 345); no other transaction control and no psql meta commands. |
| 3 | normalize_legacy_function_line_endings | ok. Before it ran, a read-only check confirmed all 19 listed functions existed and contained `\r`. The DO block was applied as given in the report. |
| 4 | 0425 pre-check (`0425-precheck.multi-tenant.sql`) | **0 rows** (pgvector in public; all 135 multi-tenant targets match the expected md5) |
| 5a | 0425_search_path_empty | ok |
| 5b | 0425_search_path_empty_multi_tenant | ok |
| 6a | 0501_0603_answers_lang_cache (0501, 0502 mt, 0601, 0602, 0603) | ok |
| 6b | 0701_0703_vector_sync (0701, 0702, 0703) | ok |
| 7 | 0410_security_definer_rpc_grants_r2 | ok on the second call. The first call returned a gateway error (502). Afterwards nothing was recorded in list_migrations and no matching session was running. The file only changes grants and is safe to run twice, so the same text was sent once more and succeeded. |

Body check: after each apply, an aggregate md5 over `proname=md5(prosrc)` of every function each file defines matched the value computed locally from the repo files:
- 0425 common: 111/111 bodies match.
- 0425 multi-tenant: 24/24.
- Batch A and Batch B together: 28/28.
- Every one of these functions has `search_path=""`.
- Exactly one `hybrid_search_chunks` overload exists.

### Verification after step 7 (post-verify.sql a–e, get_advisors security)
- **a.** SECURITY DEFINER functions in public without `search_path=""`: one row, `rls_auto_enable()` (`search_path=pg_catalog`). This is Supabase's own event-trigger function, not a repo function, as expected.
- **b.** rag_*, hybrid_search_chunks and match_chunks_by_profile executable by anon or authenticated: one row, `rag_ingest_realtime_topic_allowed(text)` (anon=false, authenticated=true). This is by design.
- **c.** The same functions that service_role cannot execute (trigger functions excluded): 0 rows.
- **d.** The 23 tables created by 0301+ that are missing or have RLS off: 0 rows. rag_answer_records, rag_semantic_cache, vector_sync_outbox, rag_vector_sync_targets and rag_backend_index_state now exist with RLS on.
- **e.** public function count: 343. This matches the PGlite end state in the legacy-diff report.
- **Security advisors:** no ERROR-level items. WARN and INFO items:
  - function_search_path_mutable on 4 legacy non-definer functions that are not 0425 targets: match_documents_by_organization, check_storage_quota, get_workspace_type and get_user_workspace_summary. This is down from 10.
  - extension_in_public for vector and pg_trgm. This is expected; do not act on it.
  - GraphQL table exposure (lints 0026/0027).
  - Definers executable by anon: check_admin_status, is_org_admin, is_org_member, is_org_owner and rls_auto_enable. All are by design per 0410 section 2, except rls_auto_enable.
  - Definers executable by authenticated: the 0410 section 2 list plus rls_auto_enable.
  - rls_enabled_no_policy (INFO) on 21 server-only tables.
  - Leaked password protection is disabled.
- **Data intact:** document `<document-id>` and chunk `<chunk-id>` are the same ids as before. The count is still 1 and 1.
- **Nango:** anon and authenticated have no INSERT, UPDATE or DELETE on nango_connections or nango_sync_records; SELECT remains. Nango write policies: 0. `unique_nango_connection_id` exists.
- **tool_execution_states.user_id** exists.
- **is_org_admin(uuid) and is_org_owner(uuid)** exist as SECURITY DEFINER with `search_path=""`. Grants are authenticated, anon and service_role, per 0410.

### Still pending
- 0426_quarantined_job_keeps_document.sql (not on trunk yet).

## 0426 (applied after merge train 8, 2026-11-25)

- Applied `0426_quarantined_job_keeps_document` to `<live-project-ref>` after train 8 (PR #30) merged into trunk with all 8 pr-smoke checks green. Only the file's top-level `BEGIN;` and `COMMIT;` were left out; the rest is the exact file text.
- Check: the live `public.rag_advance_ingestion_job` body md5 equals the repo file's body md5 (8f7099570eef907e07d36e24b022b3cb, 5570 characters). One overload, SECURITY DEFINER, `search_path=""`; EXECUTE for service_role only (anon and authenticated refused).
- Re-run note: re-running 0353 or 0425 restores the old quarantine transition, so re-run 0426 after either of them.

## 0427 (applied after merge train 10, 2026-11-25)

- Applied `0427_parse_attempt_cost_key` to `<live-project-ref>` after train 10 (PR #36) merged into trunk with all 8 pr-smoke checks green. Only the file's top-level `BEGIN;` and `COMMIT;` were left out.
- Check: the live `public.rag_record_parse_attempt` body md5 equals the repo file's body md5 (2334fc23d88d057214cdee4394f5b971, 1195 characters). One overload, SECURITY DEFINER, `search_path=""`; EXECUTE for service_role only (anon and authenticated refused).

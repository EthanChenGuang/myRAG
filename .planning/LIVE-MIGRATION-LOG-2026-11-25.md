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

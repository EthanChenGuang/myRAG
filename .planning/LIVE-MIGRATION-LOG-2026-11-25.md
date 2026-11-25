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

## 03.1-53 live checks (2026-11-25, through the database)

- Realtime: `realtime.messages` has RLS on and one read policy, `rag_ingest_broadcast_read`, that allows only broadcast messages on topics `rag_ingest_realtime_topic_allowed` accepts. That function runs for `authenticated` only (anon refused).
- Backups: `archive_mode` is on (WAL archiving). The backup list itself was not read: the Management API token was not provided, so it needs the dashboard (Database → Backups).
- Security advisor: no errors. `auth_leaked_password_protection` still reports the protection is off; the Realtime "Allow public access" project setting is not visible through SQL. Both are dashboard settings for the owner.

## 03.1-53 project settings (2026-11-25, Management API, owner-authorized)

- Realtime: `private_only` set to true (was unset, so public channels were allowed). The app's only Realtime channel (`use-ingest-job-status`) already subscribes with `private: true`, so nothing breaks. Verified by reading the config back.
- Leaked password protection: not enabled. The API answered 402 `entitlement_required`: HaveIBeenPwned checks need the Pro plan. `password_min_length` stays 6. Owner decision pending: upgrade, or raise the minimum length and required characters as a substitute.
- Backups: the project lists 0 scheduled backups and point-in-time recovery is off (WAL-G is enabled internally, but no downloadable backup exists). So there was no backup before the 2026-11-25 migrations. The live data is small (1 document, 1 chunk, 1 organization). Owner decision pending: upgrade to get daily backups or PITR, or take a manual `pg_dump` with the database connection string.
- Free substitute for leaked-password protection (owner: avoid paid plans): `password_min_length` 6 → 10 and `password_required_characters` = letters (lower and upper) plus digits, set through the Management API and read back. Applies to new sign-ups and password changes only. The app has no client-side length rule, so Supabase's own error message is shown.
- Backup: direct Postgres connections are refused from the cloud session, so `pg_dump` cannot run here. Free path: the owner takes a local `pg_dump` (schema, data and roles) and keeps the files off the repository.
- Owner decision (2026-11-25): no backup for now, because the project is not in production yet. Revisit before going live.

## 0440 and 0801 (applied after train 14, 2026-11-25)

Applied to `<live-project-ref>` from `origin/main` 207ba4b1 (train 14, PR #61), before the app redeploy. Neither file has a `.single-tenant`/`.multi-tenant` variant. For each file, only the top-level `BEGIN;` and `COMMIT;` were left out; the rest is the exact file text. No statement failed and nothing was retried.

### 0440 precondition
- Live `public.rag_chunk_embeddings_guard()` body md5 = `f7aa72d3c0bcc173f7dd103cced69c03` (777 characters), the 0425 body the file names. It matched, so 0440 could be applied. The function was SECURITY DEFINER with `search_path=""`.
- No live migration after 0440 (0501–0703, 0410_r2, 0426, 0427) redefines the guard.
- 0440 is numbered before 0501–0703, which are already live. It touches none of their objects, so applying it now is equivalent.

### Steps
| # | Migration name | Result |
|---|---|---|
| 1 | 0440_embedding_bindings | ok |
| 2 | 0410_security_definer_rpc_grants_r3 | ok. Re-run because the repo's 0410 changed since r2. 03.1.1-04 added `rag_embedding_bindings_guard()`, and the same file now also lists the three `rag_semantic_cache_on_documents_*` trigger functions. The file only changes grants. |
| 3 | 0801_phase32_columns_checks | ok |

### Verification
- **0440 body md5 matches the repo:**
  - `rag_chunk_embeddings_guard`: 985c1dd4957184b824b1dfd34f03637d, 1227 characters.
  - `rag_embedding_bindings_guard`: fc58a4c08e42f465f5ecfbd44956f886.
  - `rag_embedding_profiles_scope_guard`: 4106d1bb6132698b026c3439ba28aea4.
- **0440 function settings:**
  - Each function has one overload and `search_path=""`.
  - The two guards are SECURITY DEFINER.
  - The scope guard is SECURITY INVOKER, as the file defines it.
  - EXECUTE is granted to service_role only; anon and authenticated are refused.
- **0440 table:** `embedding_profile_bindings` exists with RLS on and no anon or authenticated grants. It has 0 rows.
- **0440 seeded profiles:** three scoped profiles were added with status `available` (5 → 8 profiles), each with its partial HNSW index.
- **0410 r3 grants:** after the re-run, `rag_embedding_bindings_guard`, `rag_chunk_embeddings_guard` and the three `rag_semantic_cache_on_documents_*` functions are service_role only.
- **0801 body md5 matches the repo:** all 13 replaced functions match (13/13):
  - rag_set_document_fields
  - rag_write_chunks
  - rag_write_profile_chunks
  - rag_advance_ingestion_job: adc43aa306d5c659051ccf69fd05209f, replacing the 0426 body
  - rag_claim_ingestion_job
  - rag_claim_ingestion_jobs
  - rag_enqueue_backfill_jobs
  - rag_enqueue_ingestion_job
  - rag_list_batch_jobs
  - rag_purge_stale_ingestion_jobs
  - rag_ingest_job_status_for_stage
  - rag_ingest_mirror_processing_status
  - rag_publish_deferred_ingestion_job
- **0801 function settings:**
  - Each function has one overload and `search_path=""`.
  - SECURITY mode is unchanged from before. These three are invokers: rag_ingest_job_status_for_stage, rag_ingest_mirror_processing_status and rag_publish_deferred_ingestion_job. The other ten are definers.
  - EXECUTE is granted to service_role only.
- **0801 columns, checks and indexes:**
  - 15 new columns are present.
  - Rebuilt checks: documents, document_chunks and ingestion_jobs status, and ingestion_jobs kind.
  - Six new value and order checks.
  - Indexes `document_chunks_scopes_gin` and `documents_tenant_fingerprint_idx`.
- **Whole database:**
  - Public functions: 343 → 345 (the two new 0440 functions).
  - Public tables with RLS off: 0.
  - Only one SECURITY DEFINER function lacks `search_path=""`: `rls_auto_enable()`, Supabase's own function, as before.
- **Security advisors:**
  - No ERROR.
  - No new WARN. The same set as after the continuation: function_search_path_mutable on the same 4 legacy functions, extension_in_public (vector, pg_trgm), GraphQL exposure (0026/0027), the by-design anon and authenticated definers plus rls_auto_enable, and leaked password protection.
  - The only new item is INFO rls_enabled_no_policy on `embedding_profile_bindings` (21 → 22 server-only tables), as intended.
- **Data intact:** documents 1, chunks 1, chunk_embeddings 0, ingestion_jobs 0 and vector_sync_outbox 0, the same as before. All document and chunk statuses are `ready`.

### Re-run notes
- Re-running 0425 restores the guard without the scope check, so re-run 0440 after it.
- Re-running any migration below 0801 that defines one of its 13 functions (0359, 0420, 0424, 0425, 0426) restores that older body, so re-run 0801 after it.

## 0441, 0802, 0803 and 0410 r4 (applied after train 15, 2026-11-25)

Applied to `<live-project-ref>` from `origin/main` 61cf1bcd (train 15). None of the four files has a `.single-tenant`/`.multi-tenant` variant. For each file, only the top-level `BEGIN;` and `COMMIT;` were left out; the rest is the exact file text (0803's trailing `NOTIFY` after `COMMIT` kept). No statement failed and nothing was retried.

### Preconditions
- 0441: `embedding_profile_bindings` and `rag_embedding_bindings_guard()` exist (0440 live); the file's own precheck passed. None of its eight functions existed before.
- 0802: no live migration after 0602 (0501_0603) redefines `hybrid_search_chunks`; only 0407, 0413 and 0602 define it, all live and older. Before: one overload, the 0602 signature (21 arguments, ending in `boolean`).
- 0803: `rag_publish_document_version` was last defined by 0425 (live md5 9f89d02ef0115e7ca5b2f31fab0c3c17); no later live migration touches it. `rag_admin_audit` had 0 rows, so the rebuilt action check could not fail. None of the eleven new functions existed. Dependencies present: `rag_admin_tenant_keys`, `rag_soft_delete_document`, `rag_assert_tenant_key`, `documents.approved_by`/`approved_at` and `document_chunks.approved_by` (0801).
- 0410: the repo file changed since r3 by +60 lines only, adding guarded REVOKE/GRANT blocks for the 0441 and 0803 definer functions. Grants only (its existing guarded `DROP` of the stale 4-argument `rag_fail_ingestion_job` was a no-op; only the 5-argument overload exists).

### Steps
| # | Migration name | Result |
|---|---|---|
| 1 | 0441_binding_gate | ok |
| 2 | 0802_hybrid_search_scopes_dates_und | ok |
| 3 | 0803_publish_hold | ok |
| 4 | 0410_security_definer_rpc_grants_r4 | ok |

### Verification
- **Body md5 matches the repo (21/21)**, one overload each, `search_path=""`, EXECUTE for service_role only (anon and authenticated refused):
  - 0441 (all SECURITY DEFINER; activate and rollback also carry `statement_timeout=120s` as the file defines):
    - rag_list_embedding_bindings 292a9c9d9596afd8bda94ab75cc91cd9
    - rag_list_embedding_profile_scopes 137e1974173d792f10ad83ad17049479
    - rag_create_embedding_binding 266f1b33c52023119442acf650f7105d
    - rag_set_embedding_binding_status 1d39648f3ae67320b445fdd81ff6dc13
    - rag_record_binding_evidence 09cb63723155d7e95df4103d10e7df7c
    - rag_activate_embedding_binding 9a8aae32ba62ef206db9d2a6a7443459
    - rag_rollback_embedding_binding aa1fd1de6230bf89db8998fcc91df8e2
    - rag_deactivate_embedding_binding bc94ec6c7d42244ec57f0043eda3563c
  - 0802: `hybrid_search_chunks` e28a92efe8922689d228bcbdb65d9e4c (10656 characters), SECURITY INVOKER. Exactly one overload, the new 24-argument signature ending in `text[], boolean, date`; the 0407 and 0602 signatures are gone. ACL is postgres and service_role only.
  - 0803 (definers: publish, approval keys, approve, reject, list pending, exemption add/remove/list; invokers: hold for review, is_tenant_admin, release_publish_hold, exemptions_for, as the file defines):
    - rag_publish_document_version 8793ead278eb810ba79ae4664969507a (replaces the 0425 body)
    - rag_hold_document_for_review 376d8ae4370592614d013b8119605236
    - rag_upload_approval_keys c40d783e590d4e80181f82dcc5b4fc26
    - rag_approve_upload ea48f0d6c15075430a969e1de9987c1f
    - rag_reject_upload 1339a066983b64cf5385e0e86a58b219
    - rag_list_pending_uploads 7b3c5b54d2c52120b072e2a0bcbce004
    - rag_is_tenant_admin 64a3ad2386a58678cb362308721a966c
    - rag_release_publish_hold 57327b7877e37e558a907d86c2ba00d5
    - rag_upload_exemption_add 6cba08b7708586098da5e33bf4000cca
    - rag_upload_exemption_remove 03b2c82c0e26550b363756437e39dffd
    - rag_upload_exemption_list 652212b2d18990523816b23795ae4b24
    - rag_upload_exemptions_for 5d0a2e9fc27f33913e174788da181788
- **0803 schema:** `ingestion_batches.hold_publish` boolean NOT NULL DEFAULT false. `rag_upload_approval_exemptions` exists with RLS on, no policies, 0 rows; anon and authenticated have no grant, service_role has SELECT only (no INSERT). `rag_admin_audit_action_check` rebuilt with `approve_upload` and `reject_upload`.
- **0410 r4 grants:** after the re-run, none of the 21 functions above is executable by anon or authenticated. The only `rag_*` function authenticated can execute is `rag_ingest_realtime_topic_allowed`, by design (Realtime policy helper).
- **Whole database:**
  - Public functions: 345 → 364 (8 from 0441, 11 from 0803; 0802 replaced one with one).
  - Public tables with RLS off: 0.
  - Only one SECURITY DEFINER function lacks `search_path=""`: `rls_auto_enable()`, Supabase's own function, as before.
- **Security advisors:**
  - No ERROR.
  - No new WARN: the same set and counts as before (function_search_path_mutable 4, extension_in_public 2, GraphQL 0026/0027 24/25, anon definers 5, authenticated definers 13, leaked password protection).
  - The only new item is INFO rls_enabled_no_policy on `rag_upload_approval_exemptions` (22 → 23 server-only tables), as intended.
- **Data intact:** documents 1, chunks 1, chunk_embeddings 0, ingestion_jobs 0, ingestion_batches 0, vector_sync_outbox 0 and embedding_profile_bindings 0, the same before and after. All document and chunk statuses are `ready`.

### Re-run notes
- Re-running 0407, 0413 or 0602 (live as `0501_0603_answers_lang_cache`) restores an older `hybrid_search_chunks` signature next to or instead of 0802's, so re-run 0802 after any of them.
- Re-running 0425 restores the old publish body without the pending and held branches, so re-run 0803 after it (as well as 0426, 0440 and 0801, as noted above).
- Re-running 0441 or 0803 alone keeps their own REVOKE/GRANT, so 0410 does not need to follow; re-run 0410 after any future migration that adds a definer function it lists.

## 0442, 0806, 0810 and 0410 r5 (applied after train 16, 2026-11-25)

Applied to `<live-project-ref>` from `origin/main` 9ddad6d0 (train 16, PR #88). None of the four files has a `.single-tenant`/`.multi-tenant` variant. For each file, only the top-level `BEGIN;` and `COMMIT;` and the leading header comment block were left out; every statement and every comment inside a function body is the exact file text. No statement failed and nothing was retried. The first two attempts at 0442 timed out waiting on the MCP server's confirmation prompt and changed nothing (checked after each).

### Preconditions
- 0442: the file's own read-only dry run returned no rows, so all seven live `rag_reembed_*` bodies were the 0425 ones (for example, start_run 36346f04a9f2012c4905b3ae0d5cb7c8). No live migration after 0425 redefines them. `embedding_profile_bindings` (0440) existed; `rag_reembed_require_binding` did not.
- 0806: the live `rag_publish_document_version` (8793ead278eb810ba79ae4664969507a) and `rag_approve_upload` (ea48f0d6c15075430a969e1de9987c1f) were the 0803 bodies the file replaces. Neither supersession table existed. The audit check held the seven actions as of 0803.
- 0810: the live advance, claim, claim-many and enqueue bodies were the 0801 ones (adc43aa3…, 358260ad…, 64de484b…, 089eed58…), and fail was the 0422 body (74da84cb…), exactly what the file says it replaces. The `kind` check already allowed `translate` (0801). Both claim indexes were in the two-kind form. pgvector is in `public`.
- 0410: the repo file changed since r4 (61cf1bcd) by +24 lines only, adding guarded REVOKE/GRANT for six 0806 definer functions. It only changes grants; the guarded `DROP` of the stale 4-argument `rag_fail_ingestion_job` was a no-op.

### Steps
| # | Migration name | Result |
|---|---|---|
| 1 | 0442_reembed_scope | ok |
| 2 | 0806_supersession | ok |
| 3 | 0810_chunk_translations | ok |
| 4 | 0410_security_definer_rpc_grants_r5 | ok |

### Verification
- **Body md5 matches the repo (36/36)**, one overload each, `search_path=""`, EXECUTE for service_role (anon and authenticated refused):
  - 0442 (8): the seven replaced functions are SECURITY DEFINER, as before. `rag_reembed_require_binding` (83a04b38081acfc710bd05ab1f82e4f1) is an invoker, as the file defines it. Bodies:
    - start_run 3e9083bc31a9cac4f3fbd48043f16250
    - pick 2b671c97c08036ee4ca591023db952d1
    - count 4f43ebe36caab2bc9c900ef536a59cd8
    - remaining 301ebeef39cf4efe9d217086fddeb1f2
    - resume_run 459835b27f04e55612aba6f726172f5c
    - derive_batch 5d3549f8a8055b540ba75f068f5ff7b3
    - rollback_run f5aa85662962cf83a4f99c7e80d721b8
  - 0806 (12):
    - Definers: `rag_publish_document_version` 720fa4c9c1482d2b2b4a47617d636ffe (replaces the 0803 body), `rag_approve_upload` 08070087b2752404228a63d740cb33a3 (replaces the 0803 body), confirm, dismiss, undo, list, raise and `rag_purge_hook_supersession` 93a4aa0836d5245e1bc2479307980355.
    - Invokers: document_state, stale, successor and lock_pair.
  - 0810 (16):
    - Ledger functions, still SECURITY DEFINER: advance 7b286ba5e67338d33326d6217c77c58a, claim cb6db5e10ac4875726929c7c43b35c45, claim-many dad4de90719eab43f204a52ac69c7d01, enqueue 4ca2e38d414e7bb37eb4a262c4f88be5, fail bb57d170a2daeb109a2f9c7845a5bd4d.
    - New, all SECURITY INVOKER: the two guards, `rag_write_chunk_translations`, `hybrid_search_translations` (c21fc1fadb6c7eff0d545ba0a6a8dbb1), settings get/set, eligible_chunks, coverage, pending_page, `rag_language_document_counts` and `rag_purge_hook_chunk_translations` (9bf68853b9abca6d48b969fc03266857).
- **Purge hooks:** `rag_purge_hook_supersession` and `rag_purge_hook_chunk_translations` each have one overload, `search_path=""`, and EXECUTE for service_role only.
- **New tables** (RLS on, no policies, 0 rows, no anon or authenticated grant):
  - `rag_supersession_candidates` and `rag_supersession_links`: service_role SELECT only; writes go through the functions.
  - `chunk_translations`, `chunk_translation_embeddings` and `rag_translation_settings`: service_role full access, as the file grants.
  - The two translation guard triggers exist.
- **0810 indexes:** five partial HNSW indexes on `chunk_translation_embeddings` (one per seeded unscoped profile), the translation indexes, and `ingestion_jobs_translate_active_ux`. `ingestion_jobs_claim_queued_idx` and `ingestion_jobs_claim_active_lease_idx` were rebuilt with `translate` in their predicate.
- **0806 audit check:** `rag_admin_audit_action_check` now has 10 actions (the 7 before, plus confirm, dismiss and undo supersession).
- **0410 r5 grants:** no `rag_*` or `hybrid_search*` function is executable by anon or authenticated except `rag_ingest_realtime_topic_allowed` (authenticated, by design).
- **Whole database:**
  - Public functions: 364 → 386 (+1 from 0442, +10 from 0806, +11 from 0810).
  - Public tables with RLS off: 0.
  - Only one SECURITY DEFINER function lacks `search_path=""`: `rls_auto_enable()`, Supabase's own, as before.
- **Security advisors:**
  - No ERROR.
  - No new WARN: the same set and counts as before (function_search_path_mutable 4, extension_in_public 2, GraphQL 0026/0027 24/25, anon definers 5, authenticated definers 13, leaked password protection).
  - The only new items are INFO rls_enabled_no_policy on the five new server-only tables (23 → 28), as intended.
- **Data intact:** documents 1, document_chunks 1, chunk_embeddings 0 and ingestion_jobs 0, the same before and after. All document and chunk statuses are `ready`.

### Re-run and ordering notes
- Re-running 0425 restores the unscoped re-embed bodies, so re-run 0442 after it (as well as 0426, 0440, 0801 and 0803, as noted above).
- Re-running 0803 restores the 0803 publish and approve bodies, so re-run 0806 after it.
- Re-running 0801 or 0422 restores the ledger bodies without the `translate` kind, and re-running 0421 restores the two-kind claim indexes, so re-run 0810 after any of them.
- 0806 and 0810 carry their own REVOKE/GRANT; re-run 0410 after any future migration that adds a definer function it lists.
- **0804 gap:** 0806 says the newest `rag_release_quarantine` body is in 0804, which accepts publish's new `superseded_lineage` outcome. 0804 is not on trunk and not live. The live `rag_release_quarantine` refuses any outcome other than `published` (it raises `release_failed` and its transaction rolls back), so releasing a quarantined version of a lineage that a confirmed supersession link has retired fails safe instead of succeeding. Nothing can reach this until an admin confirms a supersession. Apply 0804 when it reaches trunk.

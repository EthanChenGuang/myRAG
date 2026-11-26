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

## 0531-0533, 0812, 0813 and 0410 r6 (applied after train 17, 2026-11-25)

Applied to `<live-project-ref>` from `origin/main` 17fe2938 (train 17, PR #90). Only 0532 has a `.single-tenant`/`.multi-tenant` variant; the multi-tenant one was applied. For each file, only the top-level `BEGIN;` and `COMMIT;` and the leading header comment block were left out; every statement and every comment inside a function body is the exact file text. No statement failed. The first attempt at 0533 timed out waiting on the MCP server's confirmation prompt and changed nothing (checked: no function, no migration row); the main session then applied the same 0533 text, and this run continued from there.

### Preconditions
- 0531/0532/0533: none of `rag_retrieval_log`, `rag_feedback_loop_on_chat_delete` or `rag_purge_retrieval_log` existed. `public.organizations` exists (multi-tenant), so 0531 adds the organization foreign key. `public.chats` had only `update_chats_updated_at`.
- 0812: the live `rag_write_chunks` body md5 was 6a0a895510e2e7dfaf689933b6d654e0 (10824 characters), exactly the 0801 body the file says it replaces. 0810 does not redefine it; the only repo files that define it are 0408, 0424, 0801 and 0812 (0410 only grants). The repo diff 0801 → 0812 is only the per-chunk `language` check and its use in the insert and metadata, so nothing from a later live migration is dropped.
- 0813: none of its ten functions or two tables existed. Dependencies present: `rag_assert_tenant_key`, the invoice columns and `lineage_id` on `documents`, `chunk_embeddings.embedding_host`/`embedded_at`.
- 0410: the repo file changed since r5 (9ddad6d0) by +8 lines only, adding guarded REVOKE/GRANT for `rag_purge_retrieval_log` and `rag_feedback_loop_on_chat_delete`. Grants only; the guarded `DROP` of the stale 4-argument `rag_fail_ingestion_job` was a no-op (one overload remains).

### Steps
| # | Migration name | Result |
|---|---|---|
| 1 | 0531_rag_retrieval_log | ok |
| 2 | 0532_rag_retrieval_log_tenant_multi_tenant | ok |
| 3 | 0533_rag_retrieval_log_functions | first attempt timed out on the confirmation prompt, no change; applied by the main session with the same text, ok |
| 4 | 0812_chunk_language | ok |
| 5 | 0813_caption_language_recaption | ok |
| 6 | 0410_security_definer_rpc_grants_r6 | ok |

### Verification
- **Body md5 matches the repo (13/13)**, one overload each, `search_path=""`, EXECUTE for service_role only (anon and authenticated refused):
  - 0531: `rag_feedback_loop_on_chat_delete` 8d66bb3b5fa98d0f223b7dab6a788e16, SECURITY DEFINER.
  - 0533: `rag_purge_retrieval_log` 8ab457e2199a6621b14118a38190fddf, SECURITY DEFINER.
  - 0812: `rag_write_chunks` aa65730e587d66d5b30b4432099c1bb5 (11278 characters), SECURITY DEFINER as before (replaces the 0801 body).
  - 0813 (all SECURITY INVOKER, as the file defines):
    - rag_set_image_chunk_languages d5ce801c6f7b940d917fc9ffca2071dd
    - rag_recaption_candidates bdb8555dfe57f730941761d3b3a60166
    - rag_recaption_get_run 48ed98462ac57991dcfa916458a5988a
    - rag_recaption_start_run 94fd98c21b41384a85e57bc427a5566e
    - rag_recaption_resume_run 246d05a4b7fe7f20e0f4e1a48ea7d21b
    - rag_recaption_write_chunk dd12111f53a0c9e33e3d4c588b97e4c4
    - rag_recaption_advance e9b894fb539a909845f7cfe2ea6e1f91
    - rag_recaption_finish_run 9133f4700546dcf851c04094e04e1ca0
    - rag_recaption_rollback_run 57ba9e60528d229a3efcb0312c50ef28
    - rag_purge_hook_recaption 2c89399dc56a5b97dede332f2598d7af
- **Purge hooks:** `rag_purge_hook_supersession`, `rag_purge_hook_chunk_translations`, `rag_purge_hook_recaption` and `rag_purge_retrieval_log` each have one overload, `search_path=""`, and EXECUTE for service_role only.
- **New tables** (RLS on, no policies, 0 rows, no anon or authenticated grant; service_role full access as the files grant): `rag_retrieval_log`, `rag_recaption_runs`, `rag_recaption_items`.
- **0531/0532 schema:** foreign keys on `user_id` and `organization_id` (both cascade); indexes on created_at, chat_id, trace_id (unique), `(tenant_key, created_at desc)` and the partial negative-feedback index. `tenant_key` is generated as `o:<organization_id>` or `u:<user_id>`. The statement trigger `rag_feedback_loop_chats_delete` is on `public.chats`.
- **0410 r6 grants:** no `rag_*` or `hybrid_search*` function is executable by anon or authenticated except `rag_ingest_realtime_topic_allowed` (authenticated, by design).
- **Whole database:**
  - Public functions: 386 → 398 (+1 from 0531, +1 from 0533, +10 from 0813; 0812 replaced one with one).
  - Public tables with RLS off: 0.
  - Only one SECURITY DEFINER function lacks `search_path=""`: `rls_auto_enable()`, Supabase's own, as before.
- **Security advisors:**
  - No ERROR.
  - No new WARN: the same set and counts as before (function_search_path_mutable 4, extension_in_public 2, GraphQL 0026/0027 24/25, anon definers 5, authenticated definers 13, leaked password protection).
  - The only new items are INFO rls_enabled_no_policy on the three new server-only tables (28 → 31), as intended.
- **Data intact:** documents 4, document_chunks 1, chunk_embeddings 0 and ingestion_jobs 0, the same before and after (documents was 1 after train 16; the three new rows came from app use between trains, not from these migrations). All document and chunk statuses are `ready`. `rag_retrieval_log` has 0 rows.

### Re-run and ordering notes
- Re-running 0801, 0424 or 0408 restores an older `rag_write_chunks` body without per-chunk languages, so re-run 0812 after any of them (as well as the files noted above that follow 0801).
- 0532 depends on 0531's table; re-run them in order. 0533 only needs the table.
- 0813 creates new objects only and does not replace any earlier body; it needs `rag_assert_tenant_key` (0403/0425) and the 0801 chunk columns.
- 0531, 0533, 0812 and 0813 carry their own REVOKE/GRANT; re-run 0410 after any future migration that adds a definer function it lists.

## 0534, 0535, 0804, 0814 and 0410 r7 (applied after train 18, 2026-11-25)

Applied to `<live-project-ref>` from `origin/main` 0ded1157 (train 18, PR #93). None of the five files has a `.single-tenant`/`.multi-tenant` variant. For each file, only the top-level `BEGIN;` and `COMMIT;` (0814 has neither) and the leading header comment block were left out; every statement and every comment inside a function body is the exact file text. No statement failed, no call timed out and nothing was retried.

### Preconditions
- 0534: none of `rag_tenant_feedback_settings`, `rag_domain_experts` or `rag_review_items` existed. `rag_retrieval_log` (0531) and `public.admin_users` exist; `public.organizations` exists (multi-tenant, so experts need explicit grants). The live `rag_feedback_loop_on_chat_delete` was the 0531 body (8d66bb3b5fa98d0f223b7dab6a788e16), the one 0534 extends; only 0531 and 0534 define it.
- 0535: `rag_mine_failed_queries` did not exist. Every `rag_retrieval_log` column it reads exists, and `rag_answer_records` has `trace_id`, `tenant_key`, `feedback` and `groundedness`.
- 0804: of the four functions it defines, only `rag_release_quarantine` existed, with the 0425 body (11edc59c7d53481c0bb8331252baae65). No later live migration redefines it, and 0804 does not redefine anything 0806, 0810, 0812 or 0813 replaced: it calls `rag_publish_document_version` (still the 0806 body, 720fa4c9…) and leaves `rag_approve_upload` (0806 body, 08070087…) and `rag_list_quarantine` (0425 body, 4fc4f7f8…) unchanged. The columns it writes exist (`documents.approved_by`/`approved_at`/`hidden_text_check`/`processing_state`, `document_chunks.approved_by`), and `rag_admin_audit_action_check` already allows `release_quarantine`.
- 0814: the live `rag_upload_approval_keys` was the 0803 body (c40d783e590d4e80181f82dcc5b4fc26), which the file says it starts from. Only 0803 and 0814 define it; 0806 did not touch it.
- 0410: the repo file changed since r6 (17fe2938) by +20 lines only: guarded REVOKE/GRANT for the three new 0804 functions and `rag_mine_failed_queries` (section 1, service_role only) and for `rag_is_domain_expert` (section 2, authenticated and service_role, as an RLS helper). Grants only; the guarded `DROP` of the stale 4-argument `rag_fail_ingestion_job` was a no-op (one overload remains, bb57d170…).

### Steps
| # | Migration name | Result |
|---|---|---|
| 1 | 0534_rag_feedback_review | ok |
| 2 | 0535_rag_feedback_mining | ok |
| 3 | 0804_quarantine_reasons | ok |
| 4 | 0814_upload_approval_org_admins | ok |
| 5 | 0410_security_definer_rpc_grants_r7 | ok |

### Verification
- **Body md5 matches the repo (9/9)**, one overload each, `search_path=""`:
  - 0534:
    - `rag_is_domain_expert` 5a28557a001ba21e8d6eb5fce74ca77f, SECURITY DEFINER, EXECUTE for authenticated and service_role, anon refused (an RLS helper, by design).
    - `rag_review_items_guard` faa4cfad3f1cd0a7df35a7ffd7f66eaa, SECURITY INVOKER trigger function; anon and authenticated refused.
    - `rag_feedback_loop_on_chat_delete` 067f9d4f1146ff359acf7998c3b0d06b (replaces the 0531 body), SECURITY DEFINER, service_role only.
  - 0535: `rag_mine_failed_queries` 53691d19da071c2caa47c862be444d94, SECURITY DEFINER, service_role only.
  - 0804 (all SECURITY DEFINER, service_role only):
    - rag_list_quarantine_reasons d00f1fb8aac37b5be3a42514118ea038
    - rag_release_quarantine_reasons 9686686849a017b2e26a8ffccb1a7b04
    - rag_release_quarantine 57bf57d5e543dbb4ac70342269896189 (now the wrapper; same 0425 signature and return type)
    - rag_list_not_checked cf2b45fe11be8e1b7dd2ce7e2234b565
  - 0814: `rag_upload_approval_keys` c3e41c6a705469ec2ced8535f071d28a (replaces the 0803 body), SECURITY DEFINER, service_role only.
- **Unchanged neighbours:** `rag_publish_document_version` and `rag_approve_upload` still have the 0806 bodies, `rag_list_quarantine` the 0425 body.
- **Purge hooks:** `rag_purge_hook_supersession`, `rag_purge_hook_chunk_translations`, `rag_purge_hook_recaption` and `rag_purge_retrieval_log` each still have one overload, `search_path=""`, and EXECUTE for service_role only.
- **New tables** (RLS on, 0 rows):
  - `rag_tenant_feedback_settings` and `rag_domain_experts`: no policies, no anon or authenticated grant; service_role full access.
  - `rag_review_items`: no anon grant. authenticated has SELECT and column UPDATE on `status`, `triage`, `label` and `labelled_at` only, gated by the two policies `rag_review_items_expert_select`/`_expert_update` (`TO authenticated`, `rag_is_domain_expert(tenant_key)`), as the file grants. The `rag_review_items_guard` BEFORE UPDATE trigger exists.
- **0410 r7 grants:** no `rag_*` or `hybrid_search*` function is executable by anon. authenticated can execute only `rag_ingest_realtime_topic_allowed` and `rag_is_domain_expert`, both by design (section 2).
- **Whole database:**
  - Public functions: 398 → 404 (+2 from 0534, +1 from 0535, +3 from 0804; 0534, 0804 and 0814 each also replaced one body).
  - Public tables with RLS off: 0.
  - Only one SECURITY DEFINER function lacks `search_path=""`: `rls_auto_enable()`, Supabase's own, as before.
- **Security advisors:**
  - No ERROR.
  - Two new WARN findings, both intended: authenticated definers 13 → 14 (`rag_is_domain_expert`, the RLS helper of the review queue) and GraphQL 0027 25 → 26 (`rag_review_items`, which domain experts read through RLS). The rest are unchanged (function_search_path_mutable 4, extension_in_public 2, GraphQL 0026 24, anon definers 5, leaked password protection).
  - INFO rls_enabled_no_policy 31 → 33 for the two new server-only tables.
- **Data intact:** documents 1, document_chunks 15, chunk_embeddings 0 and ingestion_jobs 0, the same before and after (the changes since train 17 came from app use between trains, not from these migrations). All document and chunk statuses are `ready`.

### Re-run and ordering notes
- 0534 needs 0531's `rag_retrieval_log`; re-running 0531 puts back the old `rag_feedback_loop_on_chat_delete` body that does not clear review items, so re-run 0534 after it. 0535 needs 0534's `rag_review_items` and the 0501 `rag_answer_records`.
- **0804 gap closed:** the live `rag_release_quarantine` now accepts publish's `superseded_lineage` outcome. Re-running 0425 puts back the old `rag_release_quarantine` body; re-run 0804 after it.
- 0804 calls `rag_publish_document_version`; re-running 0803 restores the 0803 publish body, so re-run 0806 and then 0804 after it.
- Re-running 0803 also restores the 0803 `rag_upload_approval_keys` body (deployment admins only); re-run 0814 after it.
- All four files carry their own REVOKE/GRANT; re-run 0410 after any future migration that adds a definer function it lists.

## 0805, 0807, 0808, 0815, 0816 and 0410 r8 (applied after train 19, 2026-11-26)

Applied to `<live-project-ref>` from `origin/main` 78ca69f8 (train 19, PR #97). None of the five files has a `.single-tenant`/`.multi-tenant` variant on `origin/main`. As before, only the top-level `BEGIN;` and `COMMIT;` and the leading header comment block were left out; every statement and every comment inside a function body is the exact file text.

### Run history
- The five feature files were applied in an earlier run that a container restart interrupted before 0410 r8 and before this log entry. `list_migrations` shows them as `train19_0805_scope_tags`, `train19_0807_effective_dates`, `train19_0808_fingerprint_impact`, `train19_0815_relex_table_candidates` and `train19_0816_translation_settings_org_admins` (2026-11-26 00:05–00:06 UTC). They were not re-applied; the catalog checks below confirm each one's objects.
- 0410 r8 was applied in the resumed run. No statement failed, no call timed out and nothing was retried.

### Steps
| # | Migration name | Result |
|---|---|---|
| 1 | train19_0805_scope_tags | ok (interrupted run; verified) |
| 2 | train19_0807_effective_dates | ok (interrupted run; verified) |
| 3 | train19_0808_fingerprint_impact | ok (interrupted run; verified) |
| 4 | train19_0815_relex_table_candidates | ok (interrupted run; verified) |
| 5 | train19_0816_translation_settings_org_admins | ok (interrupted run; verified) |
| 6 | 0410_security_definer_rpc_grants_r8 | ok |

### Verification
- **Body md5 matches the repo (22/22)**, one overload each, `search_path=""`, EXECUTE for service_role only (anon, authenticated and PUBLIC refused):
  - 0805 SECURITY DEFINER:
    - rag_scope_names_taken 4b511ae03108882f556dc312493ca61e
    - rag_scope_admin c5e1ab71872a353449b784177f040cae
    - rag_scope_vocabulary_list 0f8ac437f074ce7206c4bdb030dc544a
    - rag_scope_vocabulary_for 5558db1464009ea400f0fe6e15e817c9
    - rag_scope_vocabulary_create d29fac171735e97da4ab0348a13a4770
    - rag_scope_vocabulary_update 7ad77bcfceb57a629fa68b92990a4be4
    - rag_set_document_scopes 01b11f57dcf80795b931e9f598f94e40
    - rag_list_documents_with_scopes b240b78a6f0511d321244070a1b5197f
    - rag_purge_hook_scope_tags 9ec13d90342a6f90bee355c588555385
  - 0805 SECURITY INVOKER:
    - rag_scope_slug 244acfb2e5baa06b731fbc25e9122542
    - rag_scope_name_key eae4b598eb61105bf95d77f03181208f
    - rag_scope_clean_aliases 0d4038b3fee35c2f09ee6dc5338fb7a7
    - rag_scope_lock_dimension 3a37e290336d717aadbb36e2a844d781
  - 0807:
    - rag_set_document_effective_dates 6efc459c2ca1d293c84ba3837f382590 (SECURITY DEFINER)
    - rag_dismiss_effective_date_proposal 6fe93e72aa59241310850697a82be3d0 (SECURITY DEFINER)
    - rag_propose_document_effective_dates 431cfed37be85243c3d204d6317a11c0 (SECURITY INVOKER)
    - rag_list_effective_date_proposals 616fab7882aaf102b4661f3d860f14fe (SECURITY INVOKER)
  - 0808 (all SECURITY INVOKER):
    - rag_fingerprint_groups 94b6ac0d6f4c2b9850e0909e67dd0a3d
    - rag_fingerprint_backfill_page c6fb1da21d8f371da89c0bf23e3ef43e
    - rag_fingerprint_backfill_write 45e26d597136b6a6f6076b4079106799
  - 0815: `rag_relex_table_candidates` b8b71c8474ddd64197b66e1198eb1f5f, SECURITY INVOKER.
  - 0816: `rag_translation_settings_set` d792922b08c06b4dd2dacfe4a796c188 (replaces the 0810 body, same signature), SECURITY INVOKER.
- **Audit check:** `rag_admin_audit_action_check` now also allows `set_effective_dates` and `dismiss_effective_dates` (rebuilt by 0807, keeping every earlier action).
- **New table** `rag_scope_vocabulary` (0805): RLS on, 0 rows, no policies, five CHECK constraints; service_role has SELECT only, no anon or authenticated grant, as the file grants.
- **Purge hooks:** `rag_purge_hook_supersession`, `rag_purge_hook_chunk_translations`, `rag_purge_hook_recaption` and the new `rag_purge_hook_scope_tags`: one overload each, service_role only.
- **0410 r8 grants:** the repo file changed since r7 (0ded1157) by +44 lines only: guarded REVOKE/GRANT for the two 0807 definers and the nine 0805 definers (section 1, service_role only). Every one of the 166 section 1 signatures exists and is service_role only; the 13 section 2 signatures present have exactly the roles the file grants (`kb_writes_locked()` does not exist on this multi-tenant project, so its guarded block was a no-op). The guarded `DROP` of the stale 4-argument `rag_fail_ingestion_job` was a no-op (one overload remains). No `rag_*` or `hybrid_search*` function is executable by anon; authenticated can execute only `rag_ingest_realtime_topic_allowed` and `rag_is_domain_expert`, by design.
- **Whole database:**
  - Public functions: 404 → 425 (+13 from 0805, +4 from 0807, +3 from 0808, +1 from 0815; 0816 replaced one body). 0410 r8 changed no count.
  - Public tables with RLS off: 0.
  - Only one SECURITY DEFINER function lacks `search_path=""`: `rls_auto_enable()`, Supabase's own, as before.
- **Security advisors:**
  - No ERROR.
  - WARN unchanged: function_search_path_mutable 4, extension_in_public 2 (`vector`, `pg_trgm`), GraphQL 0026 24, GraphQL 0027 26, anon definers 5, authenticated definers 14, leaked password protection.
  - INFO rls_enabled_no_policy 33 → 34 for the new server-only `rag_scope_vocabulary`.
- **Data intact:** documents 1, document_chunks 15, chunk_embeddings 0 and ingestion_jobs 0, the same as after train 18. All document and chunk statuses are `ready`.

### Re-run and ordering notes
- 0805 needs the 0801 `scopes` columns and GIN index and the 0814 `rag_upload_approval_keys`; 0807 needs the 0801 effective-date columns, `rag_upload_approval_keys` (0814), `rag_assert_tenant_key` and `rag_cache_invalidate` (0603).
- 0807 rebuilds `rag_admin_audit_action_check` from the live constraint; any later migration that rebuilds that check must keep `set_effective_dates` and `dismiss_effective_dates`.
- Re-running 0810 puts back the old `rag_translation_settings_set` body (deployment admins only); re-run 0816 after it.
- Re-running 0803 restores the 0803 `rag_upload_approval_keys` body; re-run 0814 after it, since 0805 and 0807 depend on its organization-admin rule.
- All five files carry their own REVOKE/GRANT; re-run 0410 after any future migration that adds a definer function it lists.

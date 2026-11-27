# Phase 4.2 live verification (plan 04.2-33)

Date: 2026-11-27. Branch `exec/04.2-33`, on top of `exec/04.2-32` (all Phase 4.2 gates pass in both fixture modes).
This report holds counts, names and status values only: no query, answer, document text or identifier from any live project.

## Task 1: upstream gate and live preconditions — passed
- `04.2-32-SUMMARY.md` and `eval/reports/phase-04.2/gates.json` are present, and the report has no failed gate.
- The run-config loader accepts the placeholder `proxy-injected` (`eval/harness/run-config.mts`).
- Request cap per live task: at most the 04.1-08 cap of 600 vendor requests in total. No live vendor request was sent by this plan (Tasks 3 to 5 did not run), so 0 were used.
- Live refusal recalibration: **not mandatory**. 04.2-32 kept `RAG_LEXICAL_STEM_IT=false` (`eval/decisions/04.2-lexical.md`), so the shipped effective lexical version stays 2 and no shipped cell goes stale.

## Task 2: migrations and grants (D-03, D-56) — read-only verification; apply and re-apply not performed
Project checked: `fsgaeysipkukqoocgzbx`, named in the orchestrator brief as the eval project. Its Supabase name is `myrag-medical`, status `ACTIVE_HEALTHY`. The production project was not touched.

What ran, as read-only catalog queries through the Supabase management API (`read_only: true`):
- Every Phase 4.2 object already exists there: the 36 functions granted in 0851–0864, `hybrid_search_chunks` (1 overload, as 0856 leaves it), and the tables `rag_table_rows`, `rag_dup_clusters`, `rag_dup_chunk_bands` and `rag_identifier_patterns`. `rag_retrieval_log` exists, so 0863 applies there.
- Grants, by `has_function_privilege` / `has_table_privilege`: `anon` has no EXECUTE or SELECT on any of them, `authenticated` has none, and `service_role` has all.

| Object | anon | authenticated | service_role |
| --- | --- | --- | --- |
| 36 functions of 0851–0864 and `hybrid_search_chunks` | refused | refused | granted |
| `rag_table_rows`, `rag_dup_clusters`, `rag_dup_chunk_bands`, `rag_identifier_patterns` (SELECT) | refused | refused | granted |

Function list: `rag_chunk_lexical_dict_version`, `rag_document_versions`, `rag_dup_assign`, `rag_dup_backfill_candidates`, `rag_dup_candidates`, `rag_dup_cluster_sources`, `rag_dup_clusters_mark_dirty_delete`, `rag_dup_clusters_mark_dirty_update`, `rag_dup_clusters_recompute`, `rag_dup_write_hashes`, `rag_exact_id_documents`, `rag_identifier_candidates`, `rag_identifier_pattern_create`, `rag_identifier_pattern_delete`, `rag_identifier_pattern_update`, `rag_identifier_patterns_list`, `rag_identifier_resolve`, `rag_index_backfill_documents`, `rag_index_document_chunks`, `rag_lexical_stale_count`, `rag_purge_hook_dup_chunk_bands`, `rag_purge_hook_dup_clusters`, `rag_purge_hook_duplicate_clusters`, `rag_purge_hook_identifiers`, `rag_purge_hook_table_rows`, `rag_relex_batch_stamped`, `rag_relex_candidates_stamped`, `rag_row_tenant_key_guard`, `rag_table_lookup`, `rag_table_rows_follow_document`, `rag_table_rows_guard`, `rag_version_history_ok`, `rag_version_period_ok`, `rag_write_chunk_identifiers`, `rag_write_table_rows`, plus `hybrid_search_chunks`.

Not done here, left as operator actions (`handoffs/04.2-33-live-blocked.md`):
- Apply and re-apply 0851–0864 in file order. This is a human-action checkpoint in the plan, and the project's name does not read as an eval project, so no DDL was run. The objects are present, but whether their bodies equal the files on this branch (for example the 04.2-32 rules, which are app-side only) was not compared.
- The PostgREST calls with the anon key and an authenticated user's JWT. The catalog privileges above are the same grants PostgREST enforces, but the HTTP status codes were not observed.

The plan's Task 2 sign-off line is therefore not written.

## Task 3: live pool sweep (D-06, D-14, D-36) — not run
Blocked: the sweep needs `--base-url` of a staging app deployment. None exists in this environment, and production Vercel is off limits. `eval/config/retrieval-params.json` is unchanged. The live diversity sweep (`mmr_lambda`) was not run either.

## Task 4: live TTFT (D-25, D-26, D-39) — not run
Blocked: it needs at least 30 staging turns per channel (chat in strict and balanced, an embed widget, and a voice session with the agent deployed together with the app) and their Langfuse or `[RAG Trace]` records. No staging deployment or voice room is available here. `ttft.json` was not written, and `eval/config/latency-budgets.json` keeps its starting values (not ratified).

## Task 5: optional live calibrations (D-49, D-24, F-4)
- Duplicate threshold: skipped. It needs a labelled candidate-pair sample exported from a real workspace and kept outside the repository. `eval/config/dup-cluster-params.json` is unchanged.
- Live refusal cells: skipped. They are not mandatory, because stemming stayed off. No lexical switch is on in production, so no shipped cell is stale.

The sign-off lines of Tasks 3, 4 and 5 are not written.

-- 0410: Every public SECURITY DEFINER function is service_role only unless it is an authenticated-callable RPC or an RLS helper (03-48 follow-up 2, D-08).
-- 0409 closed the four tenant search RPCs. Hosted Supabase grants EXECUTE on each new public function to anon and authenticated, and CREATE OR REPLACE
-- keeps whatever a function already had, so an upgraded database can still expose writers, queue and budget RPCs and the folder, sharing and
-- organisation helpers to anon through PostgREST. This migration closes all of them.
--
--   Section 1: service-role-only RPCs. EXECUTE is revoked from PUBLIC, anon and authenticated and granted to service_role.
--   Section 2: authenticated-callable RPCs and RLS helpers. EXECUTE is revoked from PUBLIC and anon and granted to authenticated and service_role.
--              Only the helpers that policies without a TO clause evaluate for anon (is_org_member, is_org_owner, is_org_admin, check_admin_status) keep anon.
--
-- The authoritative allow-list is tests/helpers/security-definer-allow-list.ts; tests/rag/search-rpc-grants.test.ts replays the setup files and the
-- migrations and fails when a SECURITY DEFINER function is neither covered here nor in the setup files' own REVOKE/GRANT.
-- Each function is guarded with to_regprocedure, so the file is safe on single-tenant and multi-tenant databases and on any partial upgrade state.
-- Idempotent: safe to run more than once. Matches the lock-down block at the end of both folded setup files.

BEGIN;

DO $service_role_only$
BEGIN
  IF to_regprocedure('public.can_view_org_member(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.can_view_org_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.can_view_org_member(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.get_admin_organization_id()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_admin_organization_id() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_admin_organization_id() TO service_role;
  END IF;
  IF to_regprocedure('public.get_documents_by_type_slug(uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.get_documents_by_type_slug_workspace(uuid, uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.get_folder_stats(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_folder_stats(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_folder_stats(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.get_user_current_org()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_user_current_org() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_user_current_org() TO service_role;
  END IF;
  IF to_regprocedure('public.get_user_org_ids(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_user_org_ids(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_user_org_ids(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.get_user_role_in_org(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_user_role_in_org(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_user_role_in_org(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.get_workspace_context(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_workspace_context(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_workspace_context(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.match_document_chunks_by_org(uuid, vector, integer, double precision)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.match_document_chunks_by_org(uuid, vector, integer, double precision) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_document_chunks_by_org(uuid, vector, integer, double precision) TO service_role;
  END IF;
  IF to_regprocedure('public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_activate_embedding_profile(text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_activate_embedding_profile(text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_activate_embedding_profile(text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_admin_document_scope(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_admin_document_scope(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_admin_document_scope(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_admin_tenant_keys(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_admin_tenant_keys(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_admin_tenant_keys(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_batch_has_room(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_batch_has_room(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_batch_has_room(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_batch_progress(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_batch_progress(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_batch_progress(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_begin_progressive_final(uuid, text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_begin_progressive_final(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_begin_progressive_final(uuid, text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_chunk_embeddings_guard()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chunk_embeddings_guard() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chunk_embeddings_guard() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_chunks_legacy_defaults()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chunks_legacy_defaults() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chunks_legacy_defaults() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_chunks_lexical_tsv()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chunks_lexical_tsv() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chunks_lexical_tsv() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_claim_ingestion_job(uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_claim_ingestion_jobs(text, integer, boolean, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_clear_provisional(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_clear_provisional(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_clear_provisional(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_create_ingestion_batch(text, text, text, numeric, integer, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_create_ingestion_batch(text, text, text, numeric, integer, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_create_ingestion_batch(text, text, text, numeric, integer, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_delete_doc_type_default(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_delete_doc_type_default(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_delete_doc_type_default(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_delete_ingestion_job(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_delete_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_delete_ingestion_job(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_delete_quarantined(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_delete_quarantined(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_delete_quarantined(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_enqueue_backfill_jobs(uuid, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_exact_id_documents(text, text[], integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_exact_id_documents(text, text[], integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_exact_id_documents(text, text[], integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_existing_file_hashes(text, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_existing_file_hashes(text, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_existing_file_hashes(text, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_fail_ingestion_job(uuid, text, text, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
    DROP FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean);
  END IF;
  IF to_regprocedure('public.rag_fail_ingestion_job(uuid, text, text, boolean, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_count_ingestion_dead_letters(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_count_ingestion_dead_letters(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_count_ingestion_dead_letters(text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_stale_ingestion_jobs(integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_find_content_duplicate(text, text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_find_content_duplicate(text, text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_find_content_duplicate(text, text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_doc_type_defaults(text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_doc_type_defaults(text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_doc_type_defaults(text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_document_for_type_change(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_document_for_type_change(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_document_for_type_change(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_ingest_document(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_ingest_document(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_ingest_document(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_ingest_origin(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_ingest_origin(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_ingest_origin(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_ingestion_job(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_ingestion_job(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_ingestion_job_internal(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_ingestion_job_internal(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_ingestion_job_internal(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_job_for_document(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_job_for_document(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_job_for_document(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_get_parse_tier_overrides()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_get_parse_tier_overrides() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_get_parse_tier_overrides() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_heartbeat_ingestion_job(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_heartbeat_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_heartbeat_ingestion_job(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_ingest_broadcast_job(ingestion_jobs)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_ingest_broadcast_job(ingestion_jobs) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_ingest_broadcast_job(ingestion_jobs) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_latest_backfill_runs(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_latest_backfill_runs(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_latest_backfill_runs(text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_batch_jobs(uuid, text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_chunking_profiles()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_chunking_profiles() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_chunking_profiles() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_embedding_profiles()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_embedding_profiles() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_embedding_profiles() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_ingestion_jobs(text, text[], text, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_ingestion_jobs(text, text[], text, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_ingestion_jobs(text, text[], text, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_quarantine(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_quarantine(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_quarantine(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_mark_provisional(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_mark_provisional(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_mark_provisional(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_mark_document_failed(uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_mark_document_failed(uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_mark_document_failed(uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_open_embed_batches(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_open_embed_batches(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_open_embed_batches(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_parse_budget_month(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_parse_budget_month(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_parse_budget_month(text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_parse_cache_for_document(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_parse_cache_for_document(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_parse_cache_for_document(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_parse_cache_lookup(uuid, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_parse_cache_lookup(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_parse_cache_lookup(uuid, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_parse_cache_prefix(uuid, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_parse_cache_prefix(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_parse_cache_prefix(uuid, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_parse_cache_put(uuid, text, text, text, text, jsonb, bigint)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_parse_cache_put(uuid, text, text, text, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_parse_cache_put(uuid, text, text, text, text, jsonb, bigint) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_publish_document_version(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_publish_document_version(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_publish_document_version(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_record_backfill_gap(uuid, uuid[], text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_record_backfill_gap(uuid, uuid[], text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_record_backfill_gap(uuid, uuid[], text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_record_embed_batch(uuid, text, text, text, text, integer, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_record_embed_batch(uuid, text, text, text, text, integer, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_record_embed_batch(uuid, text, text, text, text, integer, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_record_eval_evidence(text, jsonb, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_record_eval_evidence(text, jsonb, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_record_eval_evidence(text, jsonb, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_record_parse_attempt(uuid, text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_record_parse_attempt(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_record_parse_attempt(uuid, text, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_advance(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_advance(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_advance(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_documents(text, text, text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_documents(text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_documents(text, text, text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_finish_run(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_finish_run(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_finish_run(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_gaps(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_gaps(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_gaps(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_get_run(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_get_run(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_get_run(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_missing(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_missing(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_missing(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_record_gap(uuid, uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_record_gap(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_record_gap(uuid, uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_resume_run(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_resume_run(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_resume_run(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_start_run(text, text, text, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_start_run(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_start_run(text, text, text, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_count(text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_count(text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_count(text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_derive_batch(uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_derive_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_derive_batch(uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_finish_run(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_finish_run(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_finish_run(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_get_run(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_get_run(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_get_run(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_legacy_guard()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_legacy_guard() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_legacy_guard() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_missing_batch(uuid, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_missing_batch(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_missing_batch(uuid, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_next_batch(uuid, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_next_batch(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_next_batch(uuid, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_pick(text, text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_pick(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_pick(text, text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_preview_batch(text, text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_preview_batch(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_preview_batch(text, text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_remaining(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_remaining(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_remaining(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_resume_run(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_resume_run(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_resume_run(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_rollback_run(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_rollback_run(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_rollback_run(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_start_run(text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_start_run(text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_start_run(text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reembed_write_batch(uuid, jsonb, uuid, bigint)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reembed_write_batch(uuid, jsonb, uuid, bigint) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reembed_write_batch(uuid, jsonb, uuid, bigint) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_release_ingestion_job(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_release_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_release_ingestion_job(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_release_job_reservations(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_release_job_reservations(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_release_job_reservations(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_release_parse_budget(uuid, integer, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_release_parse_budget(uuid, integer, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_release_parse_budget(uuid, integer, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_release_quarantine(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_release_quarantine(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_release_quarantine(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reserve_batch_budget(uuid, numeric)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reserve_batch_budget(uuid, numeric) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reserve_batch_budget(uuid, numeric) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_reserve_parse_budget(uuid, integer, integer, text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reserve_parse_budget(uuid, integer, integer, text, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reserve_parse_budget(uuid, integer, integer, text, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_retry_ingestion_job(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rollback_embedding_profile(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rollback_embedding_profile(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rollback_embedding_profile(text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_save_ingest_state(uuid, text, text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_save_ingest_state(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_save_ingest_state(uuid, text, text, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_doc_type_default(text, text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_doc_type_default(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_doc_type_default(text, text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_document_fields(uuid, text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_document_fields(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_document_fields(uuid, text, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_document_parse_cache(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_document_parse_cache(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_document_parse_cache(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_embedding_profile_status(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_embedding_profile_status(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_embedding_profile_status(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_parse_tier_override(text, text, text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_parse_tier_override(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_parse_tier_override(text, text, text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_settle_parse_budget(uuid, integer, text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_settle_parse_budget(uuid, integer, text, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_settle_parse_budget(uuid, integer, text, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_soft_delete_document(text, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_soft_delete_document(text, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_soft_delete_document(text, uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_update_embed_batch(uuid, text, text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_chunking_profiles()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_chunking_profiles() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunking_profiles() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_chunks_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_chunks_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_chunks_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_documents_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_documents_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_documents_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_documents_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_documents_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_documents_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_embedding_profiles()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_embedding_profiles() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embedding_profiles() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_embeddings_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_embeddings_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embeddings_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_embeddings_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_embeddings_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embeddings_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_vector_sync_embeddings_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_vector_sync_embeddings_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_vector_sync_embeddings_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_sync_parent_currency()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_sync_parent_currency() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_sync_parent_currency() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.share_chat(uuid, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.share_chat(uuid, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.share_chat(uuid, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.unshare_chat(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.unshare_chat(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.unshare_chat(uuid) TO service_role;
  END IF;
END
$service_role_only$;

DO $authenticated_callable$
BEGIN
  IF to_regprocedure('public.check_admin_status()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.check_admin_status() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.check_admin_status() TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.create_organization_safe(text, text, uuid, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.create_organization_safe(text, text, uuid, boolean) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.create_organization_safe(text, text, uuid, boolean) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.delete_folder(uuid, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.delete_folder(uuid, boolean) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.delete_folder(uuid, boolean) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.get_nango_stats(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.get_nango_stats(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.get_nango_stats(uuid) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.is_admin(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.is_org_admin(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.is_org_admin(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.is_org_admin(uuid) TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.is_org_member(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.is_org_member(uuid, uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.is_org_owner(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.is_org_owner(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.is_org_owner(uuid) TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.is_subscribed(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.is_subscribed(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.is_subscribed(uuid) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.kb_writes_locked()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.kb_writes_locked() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.kb_writes_locked() TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.move_chats_to_folder(uuid[], uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.move_chats_to_folder(uuid[], uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.move_chats_to_folder(uuid[], uuid) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.rag_ingest_realtime_topic_allowed(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_ingest_realtime_topic_allowed(text) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.rag_ingest_realtime_topic_allowed(text) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.share_personal_organization(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.share_personal_organization(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.share_personal_organization(uuid) TO authenticated, service_role;
  END IF;
END
$authenticated_callable$;

NOTIFY pgrst, 'reload schema';

COMMIT;

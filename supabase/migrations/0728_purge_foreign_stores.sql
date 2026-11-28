-- 0728: The purge store inventory, and guarded purge and verify steps for stores owned by other phases (DATA-24, D-11, D-14, D-17,
-- D-37, D-41). rag_purge_store_inventory() lists every public table that references documents, document_chunks or document_parents
-- (by foreign key, or by a document_id / chunk_id / lineage_id column), each marked purge_step, cascade or exempt with a reason;
-- tests/rag-db/purge-store-coverage.test.mts fails when a table found in the catalog is missing here, so a phase that lands a new store
-- adds its row (and a rag_purge_hook_<name>) in the same change. Additive and idempotent, not folded into the setup files.

BEGIN;

-- A fixed list: no table is read, so the function needs no definer rights.
CREATE OR REPLACE FUNCTION public.rag_purge_store_inventory()
RETURNS TABLE (relation text, store_id text, handling text, reason text)
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT v.relation, v.store_id, v.handling, v.reason
    FROM (VALUES
      ('documents', 'documents', 'purge_step', 'every version of the lineage is deleted by rag_purge_lineage (0727)'),
      ('document_chunks', 'chunks', 'purge_step', 'deleted explicitly by rag_purge_lineage; the single-tenant schema has no cascade'),
      ('ingestion_jobs', 'ingestion_jobs', 'purge_step', 'deleted by tenant and lineage or version id (0727)'),
      ('ingestion_jobs_archive', 'ingestion_jobs', 'purge_step', 'deleted by tenant and lineage or version id (0727)'),
      ('rag_parse_cache', 'parse_cache', 'purge_step', 'rows whose file hash no other lineage of the tenant shares are deleted (0727)'),
      ('rag_semantic_cache', 'semantic_cache', 'purge_step', 'invalidated by version id through rag_cache_invalidate (0727)'),
      ('rag_answer_records', 'answer_citations', 'purge_step', 'citation snapshots scrubbed by rag_purge_scrub_answer_records (0724)'),
      ('chats', 'chat_messages', 'purge_step', 'saved citations scrubbed by rag_purge_scrub_chats (0724)'),
      ('nango_sync_records', 'sync_records', 'purge_step', 'deleted by version id or connection and file id (0727)'),
      ('chunk_translations', 'translations', 'purge_step', 'rag_purge_hook_chunk_translations (0810) through rag_purge_foreign_stores'),
      ('chunk_translation_gaps', 'translation_gaps', 'purge_step', 'rag_purge_hook_chunk_translation_gaps (0820) through rag_purge_foreign_stores'),
      ('rag_table_rows', 'table_rows', 'purge_step', 'rag_purge_hook_table_rows (0852) through rag_purge_foreign_stores'),
      ('rag_dup_clusters', 'duplicate_groups', 'purge_step', 'rag_purge_hook_dup_clusters (0853) removes the members and marks the cluster for recompute'),
      ('rag_supersession_candidates', 'supersession', 'purge_step', 'rag_purge_hook_supersession (0806) through rag_purge_foreign_stores'),
      ('rag_supersession_links', 'supersession', 'purge_step', 'rag_purge_hook_supersession (0806) through rag_purge_foreign_stores'),
      ('rag_rebuild_items', 'rebuild', 'purge_step', 'rag_purge_hook_rebuild (0809) through rag_purge_foreign_stores'),
      ('rag_rebuild_saved_vectors', 'rebuild', 'purge_step', 'rag_purge_hook_rebuild (0809) through rag_purge_foreign_stores'),
      ('rag_recaption_items', 'recaption', 'purge_step', 'rag_purge_hook_recaption (0813) through rag_purge_foreign_stores'),
      ('chunk_embeddings', 'vectors', 'cascade', 'ON DELETE CASCADE from document_chunks; counted before the chunk delete'),
      ('embedding_backfill_gaps', 'vectors', 'cascade', 'ON DELETE CASCADE from document_chunks'),
      ('document_parents', 'parents', 'cascade', 'ON DELETE CASCADE from documents; counted before the delete'),
      ('chunking_build_gaps', 'chunks', 'cascade', 'ON DELETE CASCADE from documents'),
      ('chunk_translation_embeddings', 'translations', 'cascade', 'ON DELETE CASCADE from chunk_translations'),
      ('rag_golden_evidence_index', 'golden_items', 'purge_step', 'rag_purge_hook_golden_items (0976) through rag_purge_foreign_stores'),
      ('rag_connector_document_access', 'access_labels', 'cascade', 'ON DELETE CASCADE from documents (0925)'),
      ('rag_connector_document_principals', 'access_labels', 'cascade', 'ON DELETE CASCADE from documents (0920)'),
      ('rag_dup_chunk_bands', 'duplicate_groups', 'cascade', 'ON DELETE CASCADE from document_chunks (0857); the clusters are purged by rag_purge_hook_dup_clusters'),
      ('rag_purge_audit', '', 'exempt', 'the purge''s own record; ids and hashes only, kept on purpose as the tombstone record (D-12, D-35)'),
      ('rag_admin_audit', '', 'exempt', 'admin action log; ids only, no document content (D-37)'),
      ('rag_access_audit', '', 'exempt', 'access label and group change log (0920); ids, groups and reasons only, no document content (D-37)'),
      ('rag_access_security_events', '', 'exempt', 'access violation events (0920); tenant, user, chunk and document ids only, no content (D-37)'),
      ('rag_security_events', '', 'exempt', 'security finding events (0942); ids, rule ids and counts only, no content (D-37)'),
      ('vector_sync_purges', '', 'exempt', 'the purge''s own outbox record for external backends (0740); tenant, lineage and version ids only (D-45)'),
      ('vector_sync_outbox', '', 'exempt', 'ids only; the purge enqueues its own delete rows here for the external backends (D-45)'),
      ('chunking_build_runs', '', 'exempt', 'run cursor: one position id, no content; a resumed run skips missing rows (D-37)'),
      ('embedding_backfill_runs', '', 'exempt', 'run cursor: one position id, no content; a resumed run skips missing rows (D-37)'),
      ('rag_recaption_runs', '', 'exempt', 'run cursor: one position id, no content; a resumed run skips missing rows (D-37)'),
      ('rag_rebuild_runs', '', 'exempt', 'run header: counts and settings, no document content; its items are purged (D-37)'),
      ('rag_retrieval_log', '', 'exempt', 'ids only, 30 and 90 day retention'),
      ('rag_review_items', '', 'exempt', 'ids only, 30 and 90 day retention'),
      ('rag_upload_approval_exemptions', '', 'exempt', 'tenant and user configuration, not per-document data'),
      ('ingestion_batches', '', 'exempt', 'batch header and hold_publish flag, not per-document data'),
      ('rag_identifier_patterns', '', 'exempt', 'tenant settings, not per-document data')
    ) AS v(relation, store_id, handling, reason)
   ORDER BY v.relation
$$;

-- One step per store: the reserved hook name first, then the owner phase's hook, then (for plain per-document tables) a guarded delete
-- by tenant and version id. Every hook is resolved by its fixed signature; relation names are literals of this file (%I) and values are
-- bound with USING. A store with neither hook nor relation adds no key to the counts.
CREATE OR REPLACE FUNCTION public.rag_purge_foreign_stores(p_tenant_key text, p_lineage_id uuid, p_version_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[] := COALESCE(p_version_ids, '{}'::uuid[]);
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.to_regprocedure('public.rag_purge_hook_translations(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_translations($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translations', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regprocedure('public.rag_purge_hook_chunk_translations(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_chunk_translations($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translations', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regclass('public.chunk_translations') IS NOT NULL THEN
    EXECUTE pg_catalog.format('DELETE FROM %I.%I t WHERE t.tenant_key = $1 AND t.document_id = ANY ($2)', 'public', 'chunk_translations')
      USING p_tenant_key, v_ids;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translations', v_n);
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_chunk_translation_gaps(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_chunk_translation_gaps($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translation_gaps', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regclass('public.chunk_translation_gaps') IS NOT NULL THEN
    EXECUTE pg_catalog.format('DELETE FROM %I.%I t WHERE t.tenant_key = $1 AND t.document_id = ANY ($2)', 'public', 'chunk_translation_gaps')
      USING p_tenant_key, v_ids;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || pg_catalog.jsonb_build_object('translation_gaps', v_n);
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_table_rows(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_table_rows($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('table_rows', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regclass('public.rag_table_rows') IS NOT NULL THEN
    EXECUTE pg_catalog.format('DELETE FROM %I.%I t WHERE t.tenant_key = $1 AND t.document_id = ANY ($2)', 'public', 'rag_table_rows')
      USING p_tenant_key, v_ids;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || pg_catalog.jsonb_build_object('table_rows', v_n);
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_duplicate_clusters(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_duplicate_clusters($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('duplicate_groups', COALESCE(v_n, 0));
  ELSIF pg_catalog.to_regprocedure('public.rag_purge_hook_dup_clusters(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_dup_clusters($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('duplicate_groups', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_supersession(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_supersession($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('supersession', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_rebuild(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_rebuild($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('rebuild', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_recaption(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_recaption($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('recaption', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_scope_tags(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_scope_tags($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('scope_tags', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_identifiers(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_identifiers($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('identifiers', COALESCE(v_n, 0));
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_golden_items(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_golden_items($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('golden_items', COALESCE(v_n, 0));
  END IF;

  RETURN v_counts;
END
$$;

-- Rows still present per foreign store, for rag_purge_verify. A store is reported only when its relation exists.
CREATE OR REPLACE FUNCTION public.rag_purge_foreign_leftovers(p_tenant_key text, p_lineage_id uuid, p_version_ids uuid[])
RETURNS TABLE (store text, remaining bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[] := COALESCE(p_version_ids, '{}'::uuid[]);
  v_step record;
  v_n bigint;
  v_total bigint;
  v_seen boolean;
  v_last text := NULL;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR v_step IN
    SELECT * FROM (VALUES
      (1, 'translations', 'chunk_translations', 't.document_id = ANY ($2)'),
      (2, 'translation_gaps', 'chunk_translation_gaps', 't.document_id = ANY ($2)'),
      (3, 'table_rows', 'rag_table_rows', 't.document_id = ANY ($2)'),
      (4, 'duplicate_groups', 'rag_dup_clusters', 't.source_document_ids OPERATOR(pg_catalog.&&) $2'),
      (5, 'supersession', 'rag_supersession_candidates',
          't.document_id = ANY ($2) OR t.candidate_document_id = ANY ($2) OR t.older_document_id = ANY ($2)'),
      (6, 'supersession', 'rag_supersession_links',
          't.older_document_id = ANY ($2) OR t.newer_document_id = ANY ($2) OR t.older_lineage_id = $3 OR t.newer_lineage_id = $3'),
      (7, 'rebuild', 'rag_rebuild_items', 't.document_id = ANY ($2) OR t.new_document_id = ANY ($2) OR t.lineage_id = $3'),
      (8, 'rebuild', 'rag_rebuild_saved_vectors', 't.document_id = ANY ($2)'),
      (9, 'recaption', 'rag_recaption_items', 't.document_id = ANY ($2)')
    ) AS s(ord, store, relation, predicate)
    ORDER BY s.ord
  LOOP
    IF v_last IS DISTINCT FROM v_step.store THEN
      IF v_last IS NOT NULL AND v_seen THEN
        store := v_last;
        remaining := v_total;
        RETURN NEXT;
      END IF;
      v_last := v_step.store;
      v_total := 0;
      v_seen := false;
    END IF;
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', v_step.relation)) IS NOT NULL THEN
      EXECUTE pg_catalog.format('SELECT pg_catalog.count(*) FROM %I.%I t WHERE t.tenant_key = $1 AND (%s)', 'public', v_step.relation, v_step.predicate)
        INTO v_n USING p_tenant_key, v_ids, p_lineage_id;
      v_total := v_total + v_n;
      v_seen := true;
    END IF;
  END LOOP;
  IF v_last IS NOT NULL AND v_seen THEN
    store := v_last;
    remaining := v_total;
    RETURN NEXT;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.rag_purge_store_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_store_inventory() TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

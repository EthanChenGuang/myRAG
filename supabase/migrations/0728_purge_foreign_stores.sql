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
      ('rag_purge_audit', '', 'exempt', 'the purge''s own record; ids and hashes only, kept on purpose as the tombstone record (D-12, D-35)'),
      ('rag_admin_audit', '', 'exempt', 'admin action log; ids only, no document content (D-37)'),
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

REVOKE ALL ON FUNCTION public.rag_purge_store_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_store_inventory() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

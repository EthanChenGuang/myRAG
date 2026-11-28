-- 0747: Phase 6.3 gap closure (quick 63-gaps, from 06.3-VERIFICATION / 06.3-SECURITY; train 43).
-- G1 (T-06.3-49): rag_purge_foreign_stores calls rag_purge_hook_doc_attributes (1009, Phase 3.3 hand-off) and rag_purge_hook_finetune
--   (0992, Phase 6.1 IW-1), each under a to_regprocedure guard (counts keys doc_attributes, finetune); rag_purge_foreign_leftovers
--   reports both (verify rows doc_attributes, finetune); rag_purge_store_inventory lists rag_staged_attributes, rag_finetune_consent,
--   embedding_model_versions and the four Phase 3.3 tenant rule tables.
-- G4 (T-06.3-26): the purge collects its chunks' metadata.image_url (and documents.metadata.image_url) before the delete, keeps only
--   their SHA-256 in rag_purge_audit.image_url_sha256, and the chat scrub (mode files) drops source_images / images entries whose URL
--   has one of those hashes as well as those under the lineage prefix. rag_purge_verify adds a source_images row.
-- G6 (owner decision 12a): rag_purge_hook_review_items removes the purged versions' candidate and source ids from the tenant's
--   review items (masked query kept; an item left without ids is tagged source_purged, and set to skipped while open); verify row
--   review_items; the inventory marks rag_review_items purge_step.
-- Bodies: rag_purge_store_inventory, rag_purge_foreign_stores and rag_purge_foreign_leftovers from 0728, rag_purge_lineage and
--   rag_purge_verify from 0746 (their newest definitions); only the edits above. Security mode, volatility, empty search_path and grants
--   (service_role only) are unchanged. New helpers are SECURITY INVOKER, empty search_path, service_role only.
-- Operator rule: after re-running 0724, 0727, 0728 or 0746, re-run this file (common file, then the mode file). Idempotent; not folded.

BEGIN;

DO $precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_purge_lineage(text,uuid,jsonb,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_purge_verify(text,uuid)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_purge_foreign_stores(text,uuid,uuid[])') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_purge_scrub_chats(text,uuid,uuid[],timestamptz)') IS NULL
     OR pg_catalog.to_regclass('public.rag_purge_audit') IS NULL THEN
    RAISE EXCEPTION '0747: apply 0724, 0726, 0727, 0728 and 0746 first' USING ERRCODE = '55000';
  END IF;
END
$precheck$;

-- G4: hashes of the picture URLs a purge removed; ids and hashes only, like the rest of the record.
ALTER TABLE public.rag_purge_audit ADD COLUMN IF NOT EXISTS image_url_sha256 text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.rag_purge_audit DROP CONSTRAINT IF EXISTS rag_purge_audit_image_url_sha256_check;
ALTER TABLE public.rag_purge_audit ADD CONSTRAINT rag_purge_audit_image_url_sha256_check CHECK (
  pg_catalog.cardinality(image_url_sha256) = 0
  OR pg_catalog.array_to_string(image_url_sha256, ',', '?') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'
);

-- SHA-256 of every picture URL recorded on the given versions or their chunks (metadata.image_url), sorted and distinct.
CREATE OR REPLACE FUNCTION public.rag_purge_image_url_hashes(p_document_ids uuid[])
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(u.url, 'UTF8')), 'hex')), '{}'::text[])
    FROM (
      SELECT c.metadata ->> 'image_url' AS url FROM public.document_chunks c
       WHERE c.document_id = ANY (COALESCE(p_document_ids, '{}'::uuid[])) AND pg_catalog.jsonb_typeof(c.metadata -> 'image_url') = 'string'
      UNION
      SELECT d.metadata ->> 'image_url' FROM public.documents d
       WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])) AND pg_catalog.jsonb_typeof(d.metadata -> 'image_url') = 'string'
    ) AS u
   WHERE u.url IS NOT NULL AND u.url <> ''
$$;

-- A saved picture link of a purge: under the lineage's prefix (0724) or with one of the recorded URL hashes.
CREATE OR REPLACE FUNCTION public.rag_purge_image_url_match(p_url text, p_image_pattern text, p_image_hashes text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(p_url, '') <> '' AND (
    (p_image_pattern IS NOT NULL AND p_url ~ p_image_pattern)
    OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_url, 'UTF8')), 'hex') = ANY (COALESCE(p_image_hashes, '{}'::text[]))
  )
$$;

-- 0724's message rewriter and chat predicate with the URL hashes as one more parameter (the four- and three-argument versions stay).
CREATE OR REPLACE FUNCTION public.rag_withdrawn_chat_messages(
  p_messages jsonb,
  p_document_ids text[],
  p_image_pattern text,
  p_withdrawn_at timestamptz,
  p_image_hashes text[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_messages IS NULL OR jsonb_typeof(p_messages) <> 'array' THEN p_messages
    ELSE COALESCE((
      SELECT jsonb_agg(
               CASE
                 WHEN jsonb_typeof(m.value) <> 'object' THEN m.value
                 ELSE m.value
                   || CASE WHEN jsonb_typeof(m.value -> 'metadata') = 'object' AND jsonb_typeof(m.value -> 'metadata' -> 'citations') = 'array'
                        THEN jsonb_build_object('metadata', jsonb_set(m.value -> 'metadata', '{citations}',
                               public.rag_withdrawn_citations(m.value -> 'metadata' -> 'citations', p_document_ids, p_withdrawn_at)))
                        ELSE '{}'::jsonb END
                   || CASE WHEN jsonb_typeof(m.value -> 'content') = 'array'
                        THEN jsonb_build_object('content', COALESCE((
                          SELECT jsonb_agg(
                                   CASE
                                     WHEN jsonb_typeof(p.value) <> 'object' THEN p.value
                                     ELSE p.value
                                       || CASE WHEN jsonb_typeof(p.value -> 'usedDocuments') = 'array'
                                            THEN jsonb_build_object('usedDocuments', public.rag_withdrawn_document_refs(p.value -> 'usedDocuments', p_document_ids))
                                            ELSE '{}'::jsonb END
                                       || CASE WHEN jsonb_typeof(p.value -> 'documents') = 'array'
                                            THEN jsonb_build_object('documents', public.rag_withdrawn_document_refs(p.value -> 'documents', p_document_ids))
                                            ELSE '{}'::jsonb END
                                       || CASE WHEN jsonb_typeof(p.value -> 'source_images') = 'array'
                                            THEN jsonb_build_object('source_images', COALESCE((
                                              SELECT jsonb_agg(i.value ORDER BY i.ordinality)
                                                FROM jsonb_array_elements(p.value -> 'source_images') WITH ORDINALITY i
                                               WHERE NOT public.rag_purge_image_url_match(i.value ->> 'url', p_image_pattern, p_image_hashes)), '[]'::jsonb))
                                            ELSE '{}'::jsonb END
                                       || CASE WHEN jsonb_typeof(p.value -> 'images') = 'array'
                                            THEN jsonb_build_object('images', COALESCE((
                                              SELECT jsonb_agg(i.value ORDER BY i.ordinality)
                                                FROM jsonb_array_elements(p.value -> 'images') WITH ORDINALITY i
                                               WHERE NOT public.rag_purge_image_url_match(i.value ->> 'url', p_image_pattern, p_image_hashes)), '[]'::jsonb))
                                            ELSE '{}'::jsonb END
                                   END
                                   ORDER BY p.ordinality)
                            FROM jsonb_array_elements(m.value -> 'content') WITH ORDINALITY p
                        ), '[]'::jsonb))
                        ELSE '{}'::jsonb END
               END
               ORDER BY m.ordinality)
        FROM jsonb_array_elements(p_messages) WITH ORDINALITY m
    ), '[]'::jsonb)
  END
$$;

CREATE OR REPLACE FUNCTION public.rag_chat_messages_reference(p_messages jsonb, p_document_ids text[], p_image_pattern text, p_image_hashes text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT p_messages IS NOT NULL AND jsonb_typeof(p_messages) = 'array' AND (
    public.rag_chat_messages_leftover_count(p_messages, p_document_ids) > 0
    OR EXISTS (
      SELECT 1
        FROM jsonb_path_query(p_messages, 'lax $[*].content[*].source_images[*].url') u
       WHERE jsonb_typeof(u) = 'string' AND public.rag_purge_image_url_match(u #>> '{}', p_image_pattern, p_image_hashes))
    OR EXISTS (
      SELECT 1
        FROM jsonb_path_query(p_messages, 'lax $[*].content[*].images[*].url') u
       WHERE jsonb_typeof(u) = 'string' AND public.rag_purge_image_url_match(u #>> '{}', p_image_pattern, p_image_hashes))
  )
$$;

-- Picture links still saved in one chats.messages array (source_images and images entries).
CREATE OR REPLACE FUNCTION public.rag_chat_image_leftover_count(p_messages jsonb, p_image_pattern text, p_image_hashes text[])
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_messages IS NULL OR pg_catalog.jsonb_typeof(p_messages) <> 'array' THEN 0::bigint
    ELSE (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_path_query(p_messages, 'lax $[*].content[*].source_images[*].url') u
           WHERE pg_catalog.jsonb_typeof(u) = 'string' AND public.rag_purge_image_url_match(u #>> '{}', p_image_pattern, p_image_hashes))
       + (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_path_query(p_messages, 'lax $[*].content[*].images[*].url') u
           WHERE pg_catalog.jsonb_typeof(u) = 'string' AND public.rag_purge_image_url_match(u #>> '{}', p_image_pattern, p_image_hashes))
  END
$$;

-- G6 (owner decision 12a): the purged versions' ids leave the tenant's review items. candidates elements naming a purged document or
-- chunk are dropped; snapshot.document_ids and snapshot.chunk_ids lose those ids; query_masked and every other field stay. An item
-- that named a purged id and is left with no candidate and no source id is tagged source_purged, and an open one is set to skipped
-- (it leaves the queue; an expert's label or export is kept). Returns the number of items changed. Runs before the chunk delete.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_review_items(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_chunks text[];
  v_n bigint := 0;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL THEN
    RETURN 0;
  END IF;
  v_docs := ARRAY(
    SELECT DISTINCT d.id::text FROM public.documents d
     WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])))
    UNION
    SELECT x::text FROM pg_catalog.unnest(COALESCE(p_document_ids, '{}'::uuid[])) AS x WHERE x IS NOT NULL
  );
  IF pg_catalog.cardinality(v_docs) = 0 THEN
    RETURN 0;
  END IF;
  v_chunks := ARRAY(SELECT c.id::text FROM public.document_chunks c WHERE c.document_id::text = ANY (v_docs));

  WITH hit AS (
    SELECT i.id,
           COALESCE((
             SELECT pg_catalog.jsonb_agg(c.v ORDER BY c.o)
               FROM pg_catalog.jsonb_array_elements(i.candidates) WITH ORDINALITY AS c(v, o)
              WHERE NOT (pg_catalog.jsonb_typeof(c.v) = 'object'
                         AND ((c.v ->> 'document_id') = ANY (v_docs) OR (c.v ->> 'chunk_id') = ANY (v_chunks)))
           ), '[]'::jsonb) AS candidates,
           CASE WHEN pg_catalog.jsonb_typeof(i.snapshot) = 'object' THEN
             i.snapshot
             || CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'document_ids') = 'array' THEN pg_catalog.jsonb_build_object('document_ids', COALESCE((
                  SELECT pg_catalog.jsonb_agg(e.v ORDER BY e.o) FROM pg_catalog.jsonb_array_elements(i.snapshot -> 'document_ids') WITH ORDINALITY AS e(v, o)
                   WHERE pg_catalog.lower(e.v #>> '{}') <> ALL (v_docs)), '[]'::jsonb)) ELSE '{}'::jsonb END
             || CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'chunk_ids') = 'array' THEN pg_catalog.jsonb_build_object('chunk_ids', COALESCE((
                  SELECT pg_catalog.jsonb_agg(e.v ORDER BY e.o) FROM pg_catalog.jsonb_array_elements(i.snapshot -> 'chunk_ids') WITH ORDINALITY AS e(v, o)
                   WHERE pg_catalog.lower(e.v #>> '{}') <> ALL (v_chunks)), '[]'::jsonb)) ELSE '{}'::jsonb END
           ELSE i.snapshot END AS snapshot
      FROM public.rag_review_items i
     WHERE i.tenant_key = p_tenant_key
       AND (
         EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(i.candidates) AS c(v)
                  WHERE pg_catalog.jsonb_typeof(c.v) = 'object'
                    AND ((c.v ->> 'document_id') = ANY (v_docs) OR (c.v ->> 'chunk_id') = ANY (v_chunks)))
         OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(
                      CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'document_ids') = 'array' THEN i.snapshot -> 'document_ids' ELSE '[]'::jsonb END) AS d(id)
                     WHERE pg_catalog.lower(d.id) = ANY (v_docs))
         OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(
                      CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'chunk_ids') = 'array' THEN i.snapshot -> 'chunk_ids' ELSE '[]'::jsonb END) AS d(id)
                     WHERE pg_catalog.lower(d.id) = ANY (v_chunks))
       )
       FOR UPDATE OF i
  ), emptied AS (
    SELECT h.*,
           pg_catalog.jsonb_array_length(h.candidates) = 0
           AND COALESCE(pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(h.snapshot -> 'document_ids') = 'array' THEN h.snapshot -> 'document_ids' END), 0) = 0
           AND COALESCE(pg_catalog.jsonb_array_length(CASE WHEN pg_catalog.jsonb_typeof(h.snapshot -> 'chunk_ids') = 'array' THEN h.snapshot -> 'chunk_ids' END), 0) = 0
             AS empty
      FROM hit h
  )
  UPDATE public.rag_review_items i
     SET candidates = e.candidates,
         snapshot = e.snapshot,
         tags = CASE WHEN e.empty AND NOT ('source_purged' = ANY (i.tags)) THEN i.tags || ARRAY['source_purged'] ELSE i.tags END,
         status = CASE WHEN e.empty AND i.status = 'open' THEN 'skipped' ELSE i.status END
    FROM emptied e
   WHERE i.id = e.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- G1: inventory rows for the Phase 3.3 and Phase 6.1 stores.
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
      ('rag_judge_labels', 'golden_items', 'purge_step', 'answer-check labels of the purged evidence, cleared by rag_purge_hook_golden_items (0976)'),
      ('rag_lexical_stats_pending', 'lexical_stats', 'purge_step', 'staged signed deltas, folded by rag_purge_hook_lexical_stats (0903, 0905), which rag_purge_lineage runs after its chunk delete (0746)'),
      ('rag_lexical_df', 'lexical_stats', 'purge_step', 'per-tenant document frequencies (no document id); the purged chunks are folded out by rag_purge_hook_lexical_stats (0746)'),
      ('rag_lexical_corpus', 'lexical_stats', 'purge_step', 'per-tenant chunk count and length (no document id); the purged chunks are folded out by rag_purge_hook_lexical_stats (0746)'),
      ('rag_lexical_cluster_dirty', 'lexical_stats', 'purge_step', 'markers of clusters to reconcile (no document id), emptied by the compaction rag_purge_hook_lexical_stats runs (0905, 0746)'),
      ('rag_lexical_cluster_units', 'lexical_stats', 'purge_step', 'cluster unit ledger (chunk id, lexemes, length); rag_purge_hook_lexical_stats marks every row whose chunk is gone and reconciles it away (0905, 0746)'),
      ('rag_connector_document_access', 'access_labels', 'cascade', 'ON DELETE CASCADE from documents (0925)'),
      ('rag_connector_document_principals', 'access_labels', 'cascade', 'ON DELETE CASCADE from documents (0920)'),
      ('rag_dup_chunk_bands', 'duplicate_groups', 'cascade', 'ON DELETE CASCADE from document_chunks (0857); the clusters are purged by rag_purge_hook_dup_clusters'),
      ('rag_purge_audit', '', 'exempt', 'the purge''s own record; ids and hashes only, kept on purpose as the tombstone record (D-12, D-35)'),
      ('rag_admin_audit', '', 'exempt', 'admin action log; ids only, no document content (D-37)'),
      ('rag_lexical_stats_state', '', 'exempt', 'per-tenant lexical statistics settings and status (0900, 0905); no document reference'),
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
      ('rag_review_items', 'review_items', 'purge_step', 'the purged versions candidate and source ids are removed from candidates and snapshot by rag_purge_hook_review_items (0747); the masked query stays; an item left without ids is tagged source_purged (owner decision 12a)'),
      ('rag_upload_approval_exemptions', '', 'exempt', 'tenant and user configuration, not per-document data'),
      ('ingestion_batches', '', 'exempt', 'batch header and hold_publish flag, not per-document data'),
      ('rag_identifier_patterns', '', 'exempt', 'tenant settings, not per-document data'),
      ('rag_staged_attributes', 'doc_attributes', 'purge_step', 'keyed by (source, source_key), no document id; the rows of the purged documents are deleted by rag_purge_hook_doc_attributes (1009) through rag_purge_foreign_stores (0747)'),
      ('rag_finetune_consent', 'finetune', 'purge_step', 'one consent row per tenant, no document id: a document purge keeps it, a tenant purge deletes it, both through rag_purge_hook_finetune (0992, 0747)'),
      ('embedding_model_versions', 'finetune', 'purge_step', 'tenant_keys only, no document id: every version trained on the tenant is tainted by rag_purge_hook_finetune (0992) through rag_purge_foreign_stores (0747)'),
      ('rag_section_rule_sets', '', 'exempt', 'tenant rule data (Phase 3.3), not per-document data; removed with the tenant by rag_tenant_rule_data_delete (1009)'),
      ('rag_boilerplate_rules', '', 'exempt', 'tenant rule data (Phase 3.3), not per-document data; removed with the tenant by rag_tenant_rule_data_delete (1009)'),
      ('rag_attribute_definitions', '', 'exempt', 'tenant attribute schema (Phase 3.3), not per-document data; removed with the tenant by rag_tenant_rule_data_delete (1009)'),
      ('rag_attribute_header_templates', '', 'exempt', 'tenant header template (Phase 3.3), not per-document data; removed with the tenant by rag_tenant_rule_data_delete (1009)')
    ) AS v(relation, store_id, handling, reason)
   ORDER BY v.relation
$$;

-- G1: the two handed-over hooks, after the 0728 steps.
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
  -- Phase 3.3 hand-off (03.3-24): staged attributes keyed by the purged documents' (source, source_key), and their attribute fields.
  -- It joins documents, so it runs here, before rag_purge_lineage deletes them.
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_doc_attributes(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_doc_attributes($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('doc_attributes', COALESCE(v_n, 0));
  END IF;
  -- Owner decision 12a (G6): review items lose the purged documents' candidate and source ids (before the chunk delete).
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_review_items(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_review_items($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('review_items', COALESCE(v_n, 0));
  END IF;
  -- Phase 6.1 hand-off (IW-1): every fine-tune version trained on the tenant is tainted; its weights may hold the purged text.
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_finetune(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT (public.rag_purge_hook_finetune($1, $2, $3))::bigint' INTO v_n USING p_tenant_key, p_lineage_id, v_ids;
    v_counts := v_counts || pg_catalog.jsonb_build_object('finetune', COALESCE(v_n, 0));
  END IF;

  RETURN v_counts;
END
$$;

-- G1: doc_attributes and finetune leftovers after the 0728 rows.
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
  v_audit_source text;
  v_audit_key text;
  v_audit_at timestamptz;
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

  -- The newest purge of the lineage, if any: after the purge the documents are gone and only its source and key hash are left.
  SELECT a.source, a.source_key_sha256, a.started_at INTO v_audit_source, v_audit_key, v_audit_at
    FROM public.rag_purge_audit a
   WHERE a.tenant_key = p_tenant_key AND a.lineage_id = p_lineage_id
   ORDER BY a.started_at DESC, a.id DESC
   LIMIT 1;

  -- doc_attributes (0747): staged rows of the tenant keyed by a (source, source_key) of the lineage's documents or of its purge record.
  IF pg_catalog.to_regclass('public.rag_staged_attributes') IS NOT NULL THEN
    EXECUTE $q$
      SELECT pg_catalog.count(*) FROM public.rag_staged_attributes s
       WHERE s.tenant_key = $1
         AND (
           EXISTS (SELECT 1 FROM public.documents d
                    WHERE d.tenant_key = $1 AND (d.lineage_id = $2 OR d.id = ANY ($3))
                      AND d.source = s.source AND d.source_key = s.source_key)
           OR ($4 IS NOT NULL AND $5 IS NOT NULL AND s.source = $4
               AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.source_key, 'UTF8')), 'hex') = $5)
         )
    $q$ INTO v_n USING p_tenant_key, p_lineage_id, v_ids, v_audit_source, v_audit_key;
    store := 'doc_attributes';
    remaining := v_n;
    RETURN NEXT;
  END IF;

  -- review_items (0747, G6): items of the tenant that still name a purged version in candidates or snapshot.document_ids.
  IF pg_catalog.to_regclass('public.rag_review_items') IS NOT NULL THEN
    EXECUTE $q$
      SELECT pg_catalog.count(*) FROM public.rag_review_items i
       WHERE i.tenant_key = $1
         AND (
           EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(i.candidates) AS c(v)
                    WHERE pg_catalog.jsonb_typeof(c.v) = 'object' AND (c.v ->> 'document_id') = ANY ($2))
           OR (pg_catalog.jsonb_typeof(pg_catalog.to_jsonb(i) -> 'snapshot' -> 'document_ids') = 'array'
               AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(pg_catalog.to_jsonb(i) -> 'snapshot' -> 'document_ids') AS d(id)
                            WHERE pg_catalog.lower(d.id) = ANY ($2)))
         )
    $q$ INTO v_n USING p_tenant_key, ARRAY(SELECT x::text FROM pg_catalog.unnest(v_ids) AS x);
    store := 'review_items';
    remaining := v_n;
    RETURN NEXT;
  END IF;

  -- finetune (0747): versions trained on the tenant that are not tainted, created before the newest purge (all of them before one).
  IF pg_catalog.to_regclass('public.embedding_model_versions') IS NOT NULL THEN
    EXECUTE $q$
      SELECT pg_catalog.count(*) FROM public.embedding_model_versions v
       WHERE $1 = ANY (v.tenant_keys) AND v.status <> 'tainted' AND ($2::timestamptz IS NULL OR v.created_at <= $2)
    $q$ INTO v_n USING p_tenant_key, v_audit_at;
    store := 'finetune';
    remaining := v_n;
    RETURN NEXT;
  END IF;
END
$$;

-- G4: the 0746 purge with the picture URL hashes recorded before the scrub.
CREATE OR REPLACE FUNCTION public.rag_purge_lineage(p_tenant_key text, p_lineage_id uuid, p_actor jsonb, p_reason jsonb)
RETURNS TABLE (audit_id uuid, counts jsonb, object_keys text[], parse_cache_prefixes text[], image_prefixes text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_n_lexical bigint;
  v_image_hashes text[];
  v_admin_codes constant text[] := ARRAY['owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other'];
  v_actor_kind text;
  v_actor_id uuid;
  v_reason_code text;
  v_reason_note text;
  v_connection text;
  v_ids uuid[];
  v_hashes text[];
  v_keys text[];
  v_file_ids text[];
  v_newest public.documents%ROWTYPE;
  v_source_key text;
  v_prefixes text[];
  v_counts jsonb;
  v_foreign jsonb;
  v_chunk_ids uuid[];
  v_n_documents bigint;
  v_n_chunks bigint;
  v_n_vectors bigint;
  v_n_parents bigint;
  v_n_jobs bigint;
  v_n_archive bigint;
  v_n_parse bigint;
  v_n_cache bigint;
  v_n_citations bigint;
  v_n_chats bigint;
  v_n_sync bigint;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_audit uuid;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  IF p_actor IS NULL OR pg_catalog.jsonb_typeof(p_actor) <> 'object'
     OR pg_catalog.jsonb_typeof(p_actor -> 'kind') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(p_actor -> 'id') IS DISTINCT FROM 'string'
     OR (p_actor ->> 'kind') NOT IN ('admin', 'source_sync')
     OR (p_actor ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'actor';
  END IF;
  v_actor_kind := p_actor ->> 'kind';
  v_actor_id := (p_actor ->> 'id')::uuid;

  IF p_reason IS NULL OR pg_catalog.jsonb_typeof(p_reason) <> 'object'
     OR pg_catalog.jsonb_typeof(p_reason -> 'code') IS DISTINCT FROM 'string'
     OR (p_reason ? 'note' AND pg_catalog.jsonb_typeof(p_reason -> 'note') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'reason';
  END IF;
  v_reason_code := p_reason ->> 'code';
  v_reason_note := NULLIF(pg_catalog.btrim(COALESCE(p_reason ->> 'note', '')), '');
  IF (v_actor_kind = 'admin' AND v_reason_code <> ALL (v_admin_codes))
     OR (v_actor_kind = 'source_sync' AND v_reason_code <> 'source_deleted')
     OR (v_reason_code = 'other' AND v_reason_note IS NULL)
     OR pg_catalog.char_length(COALESCE(v_reason_note, '')) > 500 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'reason';
  END IF;

  -- The actor must be entitled to the tenant; otherwise the answer equals an unknown lineage.
  IF v_actor_kind = 'admin' THEN
    IF NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = v_actor_id)
       OR NOT (p_tenant_key = ANY (public.rag_admin_tenant_keys(v_actor_id))) THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  ELSE
    SELECT c.connection_id INTO v_connection FROM public.nango_connections c WHERE c.id = v_actor_id;
    IF v_connection IS NULL THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  PERFORM 1 FROM public.documents d
   WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key
   ORDER BY d.id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_actor_kind = 'source_sync' AND EXISTS (
       SELECT 1 FROM public.documents d
        WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key
          AND (d.source IS DISTINCT FROM 'nango' OR d.source_connection_id IS DISTINCT FROM v_connection)
     ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT pg_catalog.array_agg(d.id ORDER BY d.version, d.id),
         COALESCE(pg_catalog.array_agg(DISTINCT d.file_sha256) FILTER (WHERE d.file_sha256 IS NOT NULL), '{}'::text[])
    INTO v_ids, v_hashes
    FROM public.documents d
   WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key;
  v_file_ids := ARRAY(
    SELECT DISTINCT f.id FROM public.documents d
     CROSS JOIN LATERAL (VALUES (d.source_key), (d.source_file_id)) AS f(id)
     WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key AND d.source = 'nango'
       AND f.id IS NOT NULL AND f.id <> ''
  );

  SELECT * INTO v_newest FROM public.documents d
   WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key
   ORDER BY d.is_current DESC, d.version DESC, d.id
   LIMIT 1;
  v_source_key := CASE WHEN v_newest.source = 'nango' THEN COALESCE(NULLIF(v_newest.source_file_id, ''), v_newest.source_key)
                       ELSE v_newest.source_key END;

  v_keys := ARRAY(
    SELECT DISTINCT s.key FROM public.documents d
     CROSS JOIN LATERAL (
       SELECT e.value AS key
         FROM pg_catalog.jsonb_each_text(CASE WHEN pg_catalog.jsonb_typeof(d.processing_state -> 'artifacts') = 'object'
                                              THEN d.processing_state -> 'artifacts' ELSE '{}'::jsonb END) AS e
       UNION ALL
       SELECT d.original_path
     ) AS s
     WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key AND s.key IS NOT NULL AND s.key <> ''
     ORDER BY s.key
  );

  -- Phase 7 external backends (D-45): the version ids are resolved before any delete; no applicable target writes nothing.
  IF pg_catalog.to_regprocedure('public.rag_vector_sync_enqueue_purge(text,uuid,uuid[],text,text)') IS NOT NULL THEN
    EXECUTE 'SELECT public.rag_vector_sync_enqueue_purge($1, $2, $3, $4, $5)'
      USING p_tenant_key, p_lineage_id, v_ids, v_actor_kind || ':' || v_actor_id::text, v_reason_code;
  END IF;

  -- Picture URLs of the versions' chunks (an image_upload picture lives outside rag/<tenant>/<lineage>/); only their SHA-256 is kept,
  -- in the audit row, so a later re-scrub and rag_purge_verify still find saved links to them (T-06.3-26, 0747).
  v_image_hashes := public.rag_purge_image_url_hashes(v_ids);

  -- Citation snapshots and saved chats of the tenant (D-13, 0724; picture URLs by hash since 0747).
  v_n_citations := public.rag_purge_scrub_answer_records(p_tenant_key, p_lineage_id, v_ids, v_now);
  v_n_chats := public.rag_purge_scrub_chats(p_tenant_key, p_lineage_id, v_ids, v_now);

  -- Stores owned by other phases (D-14, plan 06.3-19); counted before the chunk delete so cascading rows are still there.
  IF pg_catalog.to_regprocedure('public.rag_purge_foreign_stores(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT public.rag_purge_foreign_stores($1, $2, $3)' INTO v_foreign USING p_tenant_key, p_lineage_id, v_ids;
  END IF;

  v_chunk_ids := ARRAY(SELECT c.id FROM public.document_chunks c WHERE c.document_id = ANY (v_ids));
  SELECT pg_catalog.count(*) INTO v_n_vectors FROM public.chunk_embeddings e WHERE e.chunk_id = ANY (v_chunk_ids);
  SELECT pg_catalog.count(*) INTO v_n_parents FROM public.document_parents p WHERE p.document_id = ANY (v_ids);

  UPDATE public.documents d SET superseded_by = NULL WHERE d.superseded_by = ANY (v_ids) AND d.tenant_key = p_tenant_key;

  -- The single-tenant schema has no cascade from documents to document_chunks; vectors, gaps and parents cascade.
  DELETE FROM public.document_chunks c WHERE c.document_id = ANY (v_ids);
  GET DIAGNOSTICS v_n_chunks = ROW_COUNT;

  -- Lexical statistics (04.4-07 hand-off, 0903 and 0905): the delete triggers have just staged the purged chunks' -1 rows and
  -- cluster markers; the hook folds them and reconciles every ledger row whose chunk is gone, so no counter, marker or unit
  -- lexeme of the purged versions is left. It runs here, after the chunk delete, because nothing of the purge is staged before it.
  IF pg_catalog.to_regprocedure('public.rag_purge_hook_lexical_stats(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT public.rag_purge_hook_lexical_stats($1, $2, $3)' INTO v_n_lexical USING p_tenant_key, p_lineage_id, v_ids;
  END IF;

  DELETE FROM public.ingestion_jobs j
   WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids));
  GET DIAGNOSTICS v_n_jobs = ROW_COUNT;
  DELETE FROM public.ingestion_jobs_archive j
   WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids));
  GET DIAGNOSTICS v_n_archive = ROW_COUNT;

  WITH removed AS (
    DELETE FROM public.rag_parse_cache pc
     WHERE pc.tenant_key = p_tenant_key
       AND pc.file_sha256 = ANY (v_hashes)
       AND NOT EXISTS (
         SELECT 1 FROM public.documents d
          WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = pc.file_sha256 AND d.lineage_id <> p_lineage_id
       )
    RETURNING pc.object_prefix
  )
  SELECT pg_catalog.count(*), COALESCE(pg_catalog.array_agg(DISTINCT r.object_prefix ORDER BY r.object_prefix), '{}'::text[])
    INTO v_n_parse, v_prefixes
    FROM removed r;

  DELETE FROM public.nango_sync_records r
   WHERE r.document_id = ANY (v_ids)
      OR (v_newest.source = 'nango' AND r.connection_id = v_newest.source_connection_id AND r.file_id = ANY (v_file_ids));
  GET DIAGNOSTICS v_n_sync = ROW_COUNT;

  v_n_cache := public.rag_cache_invalidate(p_tenant_key, v_ids);

  DELETE FROM public.documents d WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_n_documents = ROW_COUNT;

  v_counts := pg_catalog.jsonb_build_object(
    'documents', v_n_documents,
    'chunks', v_n_chunks,
    'vectors', v_n_vectors,
    'parents', v_n_parents,
    'ingestion_jobs', v_n_jobs + v_n_archive,
    'parse_cache', v_n_parse,
    'semantic_cache', v_n_cache,
    'answer_citations', v_n_citations,
    'chat_messages', v_n_chats,
    'sync_records', v_n_sync
  );
  IF v_n_lexical IS NOT NULL THEN
    v_counts := v_counts || pg_catalog.jsonb_build_object('lexical_stats', v_n_lexical);
  END IF;
  IF v_foreign IS NOT NULL AND pg_catalog.jsonb_typeof(v_foreign) = 'object' THEN
    v_counts := v_foreign || v_counts;
  END IF;

  INSERT INTO public.rag_purge_audit (
    tenant_key, lineage_id, version_ids, file_sha256_values, source, source_key_sha256, source_connection_id,
    actor_kind, actor_id, reason_code, reason_note, started_at, counts, image_url_sha256
  ) VALUES (
    p_tenant_key, p_lineage_id, v_ids, v_hashes, v_newest.source,
    CASE WHEN v_source_key IS NULL OR v_source_key = '' THEN NULL
         ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_source_key, 'UTF8')), 'hex') END,
    CASE WHEN v_newest.source = 'nango' THEN v_newest.source_connection_id ELSE NULL END,
    v_actor_kind, v_actor_id, v_reason_code, v_reason_note, v_now, v_counts, v_image_hashes
  )
  RETURNING id INTO v_audit;

  RETURN QUERY SELECT v_audit, v_counts, v_keys, v_prefixes,
                      ARRAY['rag/' || p_tenant_key || '/' || p_lineage_id::text || '/'];
END
$$;

-- G4: the 0746 verify with a source_images row.
CREATE OR REPLACE FUNCTION public.rag_purge_verify(p_tenant_key text, p_lineage_id uuid)
RETURNS TABLE (store text, remaining bigint, state text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_lexical_on boolean;
  v_lexical_left bigint;
  v_audit public.rag_purge_audit%ROWTYPE;
  v_ids uuid[];
  v_hashes text[];
  v_text_ids text[];
  r record;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_audit FROM public.rag_purge_audit a
   WHERE a.tenant_key = p_tenant_key AND a.lineage_id = p_lineage_id
   ORDER BY a.started_at DESC, a.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  v_ids := v_audit.version_ids;
  v_hashes := v_audit.file_sha256_values;
  v_text_ids := ARRAY(SELECT u.id::text FROM pg_catalog.unnest(v_ids) AS u(id));

  RETURN QUERY SELECT 'documents'::text, (
    SELECT pg_catalog.count(*) FROM public.documents d
     WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (v_ids))
  ), NULL::text;
  RETURN QUERY SELECT 'chunks'::text, (
    SELECT pg_catalog.count(*) FROM public.document_chunks c WHERE c.document_id = ANY (v_ids)
  ), NULL::text;
  RETURN QUERY SELECT 'vectors'::text, (
    SELECT pg_catalog.count(*) FROM public.chunk_embeddings e
      JOIN public.document_chunks c ON c.id = e.chunk_id
     WHERE c.document_id = ANY (v_ids)
  ), NULL::text;
  RETURN QUERY SELECT 'parents'::text, (
    SELECT pg_catalog.count(*) FROM public.document_parents p WHERE p.document_id = ANY (v_ids)
  ), NULL::text;
  RETURN QUERY SELECT 'ingestion_jobs'::text, (
    SELECT pg_catalog.count(*) FROM public.ingestion_jobs j
     WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids))
  ) + (
    SELECT pg_catalog.count(*) FROM public.ingestion_jobs_archive j
     WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids))
  ), NULL::text;
  RETURN QUERY SELECT 'parse_cache'::text, (
    SELECT pg_catalog.count(*) FROM public.rag_parse_cache pc
     WHERE pc.tenant_key = p_tenant_key AND pc.file_sha256 = ANY (v_hashes)
       AND NOT EXISTS (
         SELECT 1 FROM public.documents d
          WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = pc.file_sha256 AND d.lineage_id <> p_lineage_id
       )
  ), NULL::text;
  RETURN QUERY SELECT 'semantic_cache'::text, (
    SELECT pg_catalog.count(*) FROM public.rag_semantic_cache sc
     WHERE sc.tenant_key = p_tenant_key
       AND EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(sc.source_versions) AS e(v) WHERE (e.v ->> 'document_id') = ANY (v_text_ids)
       )
  ), NULL::text;
  FOR r IN SELECT l.store, l.remaining FROM public.rag_purge_citation_leftovers(p_tenant_key, v_ids) AS l LOOP
    RETURN QUERY SELECT r.store::text, r.remaining::bigint, NULL::text;
  END LOOP;
  -- Picture links in the tenant's saved chats: under the lineage's prefix or with a URL hash of the purge record (0747).
  IF pg_catalog.to_regprocedure('public.rag_purge_chat_image_leftovers(text,uuid,text[])') IS NOT NULL THEN
    RETURN QUERY EXECUTE 'SELECT ''source_images''::text, public.rag_purge_chat_image_leftovers($1, $2, $3), NULL::text'
      USING p_tenant_key, p_lineage_id, COALESCE(v_audit.image_url_sha256, '{}'::text[]);
  END IF;
  RETURN QUERY SELECT 'sync_records'::text, (
    SELECT pg_catalog.count(*) FROM public.nango_sync_records s
     WHERE s.document_id = ANY (v_ids)
        OR (v_audit.source = 'nango' AND v_audit.source_key_sha256 IS NOT NULL
            AND s.connection_id = v_audit.source_connection_id
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.file_id, 'UTF8')), 'hex') = v_audit.source_key_sha256)
  ), NULL::text;

  -- Lexical statistics (0746): staged rows and cluster markers of the tenant, and ledger rows whose chunk is gone. Reported only for
  -- a tenant whose statistics are on (a state row); the counters hold no document id, so the check is tenant-wide, as the hand-off asks.
  IF pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = $1)' INTO v_lexical_on USING p_tenant_key;
    IF v_lexical_on THEN
      EXECUTE 'SELECT (SELECT pg_catalog.count(*) FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = $1)'
           || CASE WHEN pg_catalog.to_regclass('public.rag_lexical_cluster_units') IS NOT NULL THEN
                ' + (SELECT pg_catalog.count(*) FROM public.rag_lexical_cluster_dirty m WHERE m.tenant_key = $1)'
                || ' + (SELECT pg_catalog.count(*) FROM public.rag_lexical_cluster_units u WHERE u.tenant_key = $1'
                || ' AND NOT EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.id = u.chunk_id))'
              ELSE '' END
        INTO v_lexical_left USING p_tenant_key;
      RETURN QUERY SELECT 'lexical_stats'::text, v_lexical_left, NULL::text;
    END IF;
  END IF;

  IF pg_catalog.to_regprocedure('public.rag_purge_foreign_leftovers(text,uuid,uuid[])') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT f.store::text AS store, f.remaining::bigint AS remaining FROM public.rag_purge_foreign_leftovers($1, $2, $3) AS f'
             USING p_tenant_key, p_lineage_id, v_ids LOOP
      RETURN QUERY SELECT r.store, r.remaining, NULL::text;
    END LOOP;
  END IF;

  IF pg_catalog.to_regprocedure('public.rag_vector_sync_purge_status(text,uuid)') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT s.target::text AS target, s.state::text AS state FROM public.rag_vector_sync_purge_status($1, $2) AS s'
             USING p_tenant_key, p_lineage_id LOOP
      RETURN QUERY SELECT 'external:' || r.target,
                          CASE WHEN r.state IN ('done', 'not_applicable') THEN 0::bigint ELSE 1::bigint END,
                          r.state;
    END LOOP;
  END IF;
END
$$;


REVOKE ALL ON FUNCTION public.rag_purge_image_url_hashes(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_image_url_hashes(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_image_url_match(text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_image_url_match(text, text, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_chat_image_leftover_count(jsonb, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chat_image_leftover_count(jsonb, text, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_hook_review_items(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_review_items(text, uuid, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_store_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_store_inventory() TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_verify(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_verify(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

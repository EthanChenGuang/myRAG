-- Train 44 live SQL (ci/merge-train-44 @ 844660f71). Apply after train 43 is live (sql/train43-live.sql: 0742, 0743, 0744, 0745).
-- Multi-tenant production layout: 0747 is a common file plus a mode file. A single-tenant project applies
-- supabase/migrations/0747_purge_gap_closure.single-tenant.sql in place of the .multi-tenant section; nothing else differs.
-- Order: 0747 (common, then its .multi-tenant file), 1015, 1012, 1013, 1014, 0906, then 0410 re-run in full (grants only).
-- Source: 0747, 1012, 1013 = quick-63-gaps (Phase 6.3 verification gaps G1-G6); 1015 = quick-63-hardening (06.3-SECURITY W3, W7);
--   1014 = quick-44-t09 (T-04.4-09); 0906 = 04.4-21 (rag_lexical_rerank_stats, read by RAG_RERANK_LOCAL_STATS=tenant). 0410 gains one guarded line (rag_purge_chat_image_leftovers, from quick-63-gaps); it is re-run
--   whole here, which is idempotent. exec/06.2-43, exec/06.2-30, exec/04.4-20, exec/quick-41-p52-band, exec/quick-5221-mustkeep, exec/quick-ui-fixes-63-7-62,
--   exec/quick-deferred-batch and the verify/* branches add no SQL.
-- Migration numbers: check-migration-numbers passes on the train. 1012-1015 sort after the 09xx files whose bodies they replace
--   (0905 for 1014, 0920/0925 for 1012, 0963 for 1013), which is why they are not 07xx numbers. 0906 is a new function on the
--   0900-series tables only; it runs here after 0938, which production already has (number order on a fresh install is fine too).
-- Dependencies (each file stops or fails if they are missing):
--   0747 needs 0724 (chat scrub, mode files), 0726/0727/0746 (purge audit, lineage, verify), 0728 (foreign stores). It calls
--        rag_purge_hook_doc_attributes (1009) and rag_purge_hook_finetune (0992) only when to_regprocedure finds them.
--   1015 needs 0747 (rag_purge_image_url_hashes, the 0747 rag_purge_lineage body) and 0721's rag_nango_owner_tenant_key; it
--        prechecks both. After re-running 0727, 0746 or 0747, re-run 1015.
--   1012 needs 0920 and 0925 (connector access tables and functions). 1013 needs 0531 (rag_retrieval_log) and 0963
--        (rag_monitor_alerts); it prechecks with 55000. 1014 needs 0905 (it replaces both 0905 bodies). 0906 needs 0900/0901/0905 (rag_lexical_stats_state,
--        rag_lexical_df, rag_lexical_corpus) and rag_assert_tenant_key.
-- App compatibility: additive for the app on main. The purge has no switch: after this apply a purge also clears staged attributes,
--   taints fine-tune versions trained on the tenant, scrubs image_upload picture links from saved chats by URL hash and removes
--   purged ids from review items. 1012 only widens CHECKs (no row is written). 1013 adds nullable columns and widens CHECKs; with
--   RAG_MONITOR off nothing writes the new kinds. 1014 makes a malformed tenant key fail with 22023 instead of compacting nothing.
--   0906 adds a function only; RAG_RERANK_LOCAL_STATS stays pool, so nothing calls it. No default is flipped.
-- DROP sections: 0747, 1012 and 1013 drop and re-add their CHECK constraints by name inside the transaction; no table or function is dropped.
-- Rehearsed on PGlite on a train-43 database (setup file plus every train-43 migration), both modes, applied twice in a row:
--   both passes succeed in both modes, the Verify block returns the expected values (every check true, 19 function rows as
--   described, the 1014 NOTICE, zero rows written). The single-tenant run applies the .single-tenant 0747 file in place of the
--   .multi-tenant section.

-- ==== supabase/migrations/0747_purge_gap_closure.sql
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

-- ==== supabase/migrations/0747_purge_gap_closure.multi-tenant.sql
-- 0747 (multi-tenant): the chat scrub of 0724 with picture URL hashes, and the picture leftover count, both bounded by 0502's tenant-key
-- mapping (o:<organization_id> is that organization's chats, u:<user_id> the user's personal chats).
-- Picture URLs are matched by the lineage prefix (0724) or by a SHA-256 from the versions' chunks or the newest purge record of the
-- lineage, so a re-scrub after the purge still finds an image_upload link (T-06.3-26). Service_role only. Idempotent; re-run after 0724.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_purge_scrub_chats(
  p_tenant_key text,
  p_lineage_id uuid,
  p_document_ids uuid[],
  p_withdrawn_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids text[];
  v_pattern text;
  v_hashes text[];
  v_owner uuid;
  v_count integer := 0;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL OR p_withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_pattern := public.rag_purge_image_pattern(p_tenant_key, p_lineage_id);
  v_hashes := ARRAY(
    SELECT DISTINCT h FROM (
      SELECT pg_catalog.unnest(public.rag_purge_image_url_hashes(p_document_ids)) AS h
      UNION
      SELECT pg_catalog.unnest(a.image_url_sha256) FROM (
        SELECT x.image_url_sha256 FROM public.rag_purge_audit x
         WHERE x.tenant_key = p_tenant_key AND x.lineage_id = p_lineage_id
         ORDER BY x.started_at DESC, x.id DESC LIMIT 1
      ) AS a
    ) AS hs ORDER BY h
  );
  v_ids := ARRAY(SELECT DISTINCT x::text FROM unnest(COALESCE(p_document_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
  v_owner := substr(p_tenant_key, 3)::uuid;

  IF left(p_tenant_key, 2) = 'o:' THEN
    UPDATE public.chats c
       SET messages = public.rag_withdrawn_chat_messages(c.messages, v_ids, v_pattern, p_withdrawn_at, v_hashes)
     WHERE c.organization_id = v_owner
       AND public.rag_chat_messages_reference(c.messages, v_ids, v_pattern, v_hashes);
  ELSE
    UPDATE public.chats c
       SET messages = public.rag_withdrawn_chat_messages(c.messages, v_ids, v_pattern, p_withdrawn_at, v_hashes)
     WHERE c.user_id = v_owner
       AND c.organization_id IS NULL
       AND public.rag_chat_messages_reference(c.messages, v_ids, v_pattern, v_hashes);
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_purge_chat_image_leftovers(p_tenant_key text, p_lineage_id uuid, p_image_hashes text[])
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pattern text;
  v_owner uuid;
  v_org boolean;
  v_count bigint := 0;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_pattern := public.rag_purge_image_pattern(p_tenant_key, p_lineage_id);
  v_owner := substr(p_tenant_key, 3)::uuid;
  v_org := left(p_tenant_key, 2) = 'o:';
  SELECT COALESCE(sum(public.rag_chat_image_leftover_count(c.messages, v_pattern, p_image_hashes)), 0)::bigint INTO v_count
    FROM public.chats c
   WHERE (v_org AND c.organization_id = v_owner)
      OR (NOT v_org AND c.user_id = v_owner AND c.organization_id IS NULL);
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_chat_image_leftovers(text, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_chat_image_leftovers(text, uuid, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/1015_purge_hardening.sql
-- 1015: Phase 6.3 hardening (quick 261128-q6h, 06.3-SECURITY W3 and W7).
-- W3: rag_purge_lineage (newest body, 0747) adds the SQL-layer owner-tenant check to its source_sync arm: the acting connection's
--   owner tenant, rag_nango_owner_tenant_key(nango_connections.user_id) (0721 mode files), must equal p_tenant_key. The app already
--   checks it (purgeNangoLineages); a mismatch answers not_found like an unknown lineage. Admin purges are unchanged.
-- W7: rag_purge_audit_recent pages the purges finished in the last 7 days with a keyset cursor on (started_at, id), so the chat
--   re-scrub (rescrubRecentPurges) reaches every recent purge once, whatever the backlog of pending records.
-- Security mode, volatility, empty search_path and grants of rag_purge_lineage are unchanged (SECURITY DEFINER, service_role only).
-- rag_purge_audit_recent is SECURITY INVOKER (only service_role, which reads rag_purge_audit, may call it), STABLE, empty
--   search_path, service_role only.
-- Operator rule: apply after 0747; after re-running 0727, 0746 or 0747, re-run this file. Idempotent; not folded.

BEGIN;

DO $precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_purge_lineage(text,uuid,jsonb,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_purge_image_url_hashes(uuid[])') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_nango_owner_tenant_key(uuid)') IS NULL
     OR pg_catalog.to_regclass('public.rag_purge_audit') IS NULL THEN
    RAISE EXCEPTION '1015: apply 0721, 0726, 0727, 0746 and 0747 first' USING ERRCODE = '55000';
  END IF;
END
$precheck$;

-- W3: the 0747 purge with the owner-tenant check of the source_sync actor.
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
  v_owner uuid;
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
    SELECT c.connection_id, c.user_id INTO v_connection, v_owner FROM public.nango_connections c WHERE c.id = v_actor_id;
    -- 1015 (W3): the connection's documents live in its owner's tenant (nangoOwnerScope); any other tenant answers not_found.
    IF v_connection IS NULL OR public.rag_nango_owner_tenant_key(v_owner) IS DISTINCT FROM p_tenant_key THEN
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

-- W7: purges finished in the last 7 days that name versions, oldest started first, after the (started_at, id) cursor;
-- cursor_started_at is the value to pass back as p_after_started_at.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_recent(p_after_started_at timestamptz, p_after_id uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  lineage_id uuid,
  version_ids uuid[],
  started_at timestamptz,
  finished_at timestamptz,
  cursor_started_at text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000
     OR (p_after_started_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT a.id, a.tenant_key, a.lineage_id, a.version_ids, a.started_at, a.finished_at,
         -- Microsecond text of started_at: the next page's cursor, exact where a JSON timestamp would round.
         pg_catalog.to_char(a.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    FROM public.rag_purge_audit a
   WHERE a.finished_at IS NOT NULL
     AND a.finished_at > pg_catalog.now() - interval '7 days'
     AND pg_catalog.cardinality(a.version_ids) > 0
     AND (p_after_started_at IS NULL OR (a.started_at, a.id) > (p_after_started_at, p_after_id))
   ORDER BY a.started_at, a.id
   LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_audit_recent(timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_audit_recent(timestamptz, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/1012_connector_microsoft_providers.sql
-- 1012: Phase 6.3 gap closure G5 (quick 63-gaps; 06.3-VERIFICATION note for plan 06.3-26): the connector access tables of 0920 and
-- 0925 (rag_connector_group_map, rag_connector_sharing_rules, rag_connector_document_principals, rag_connector_document_access) and the
-- three connector functions that check the provider (rag_connector_apply_access, rag_connector_map_set, rag_connector_rule_set) accept
-- sharepoint-online and one-drive, the Nango provider names of the Phase 6.3 Microsoft connectors. Nothing else changes: no row is
-- written, and the Microsoft copies stay owner-only (fail closed) until 06.3-26 maps their permissions.
-- The function bodies are rewritten in place from their current definition (pg_get_functiondef), so the newest body is kept whatever
-- file last defined it; security mode, search_path and grants are part of that definition or survive CREATE OR REPLACE. A body that
-- already lists the two providers is left alone. Numbered after 0925 so a fresh apply in number order finds the objects.
-- Operator rule: after re-running 0920 or 0925, re-run this file. Idempotent; one common file for both modes; not folded.

BEGIN;

DO $precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_connector_group_map') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_connector_map_set(text,uuid,text,text,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '1012: apply 0920 and 0925 first' USING ERRCODE = '55000';
  END IF;
END
$precheck$;

-- G5: the connector access tables accept the two Microsoft providers (06.3-26 maps their permissions).
DO $providers$
DECLARE
  v_table record;
  v_fn record;
  v_def text;
BEGIN
  FOR v_table IN
    SELECT * FROM (VALUES
      ('rag_connector_group_map', 'rag_connector_group_map_provider_check'),
      ('rag_connector_sharing_rules', 'rag_connector_sharing_rules_provider_check'),
      ('rag_connector_document_principals', 'rag_connector_document_principals_provider_check'),
      ('rag_connector_document_access', 'rag_connector_document_access_provider_check')
    ) AS t(relation, constraint_name)
  LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table.relation)) IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_table.relation, v_table.constraint_name);
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (provider IN (''google-drive'', ''dropbox'', ''notion'', ''sharepoint-online'', ''one-drive''))',
        v_table.relation, v_table.constraint_name);
    END IF;
  END LOOP;

  FOR v_fn IN
    SELECT p.oid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('rag_connector_apply_access', 'rag_connector_map_set', 'rag_connector_map_delete', 'rag_connector_map_list',
                         'rag_connector_rule_set', 'rag_connector_rules_list', 'rag_connector_fail_closed_counts', 'rag_connector_match_members')
       AND pg_catalog.strpos(p.prosrc, 'NOT IN (''google-drive'', ''dropbox'', ''notion'')') > 0
  LOOP
    v_def := pg_catalog.pg_get_functiondef(v_fn.oid);
    EXECUTE pg_catalog.replace(v_def, 'NOT IN (''google-drive'', ''dropbox'', ''notion'')', 'NOT IN (''google-drive'', ''dropbox'', ''notion'', ''sharepoint-online'', ''one-drive'')');
  END LOOP;
END
$providers$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/1013_source_monitor_alerts.sql
-- 1013: Phase 6.3 gap closure G2 (quick 63-gaps; D-10, DATA-23, RET-14 on the Phase 5.3 OBS-03 store).
-- rag_monitor_alerts (0963) accepts the source-sync rules source_reconcile_paused, source_reconcile_overdue, source_reconcile_failed and
--   source_reconcile_incomplete (kind source_sync, raised by raiseSourceAlert while RAG_MONITOR is on) and the daily rule
--   stale_index_drop_rate (kind stale_index_drop). The vocabularies are the 0963 lists plus these; they mirror the MonitorAlert contract.
-- rag_retrieval_log (0531) gains source_rechecked and stale_index_drop: the source recheck's checked and dropped candidate counts,
--   written only when the recheck completed (both NULL otherwise, so a row written with the recheck off is unchanged). Counts only.
-- rag_monitor_stale_index_drop(p_day): per tenant, the logged retrievals of that UTC day with a completed recheck and their checked and
--   dropped sums, for the daily rule. SECURITY INVOKER, empty search_path, service_role only.
-- Numbered after 0963 so a fresh apply in number order finds rag_monitor_alerts. Precheck (55000): 0531 and 0963 are applied.
-- Operator rule: after re-running 0963, re-run this file. Idempotent; one common file for both modes; not folded.

BEGIN;

DO $precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_monitor_alerts') IS NULL OR pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RAISE EXCEPTION '1013: apply 0531 and 0963 first' USING ERRCODE = '55000';
  END IF;
END
$precheck$;

ALTER TABLE public.rag_monitor_alerts DROP CONSTRAINT IF EXISTS rag_monitor_alerts_rule_check;
ALTER TABLE public.rag_monitor_alerts ADD CONSTRAINT rag_monitor_alerts_rule_check CHECK (rule IN (
  'refusal_rate', 'zero_result_rate', 'below_threshold_rate', 'not_helpful_rate', 'groundedness_flagged_rate',
  'kb_error_rate', 'kb_degraded_rate', 'kb_unavailable_rate', 'top_score_psi', 'latency_p95', 'online_judge_mean',
  'test_set_not_representative', 'offline_online_gap', 'language_drop',
  'source_reconcile_paused', 'source_reconcile_overdue', 'source_reconcile_failed', 'source_reconcile_incomplete',
  'stale_index_drop_rate'
));
ALTER TABLE public.rag_monitor_alerts DROP CONSTRAINT IF EXISTS rag_monitor_alerts_kind_check;
ALTER TABLE public.rag_monitor_alerts ADD CONSTRAINT rag_monitor_alerts_kind_check CHECK (kind IN (
  'rate', 'distribution', 'latency', 'judge_mean', 'drift', 'offline_online_gap', 'language_drop',
  'source_sync', 'stale_index_drop'
));

ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS source_rechecked integer NULL;
ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS stale_index_drop integer NULL;
ALTER TABLE public.rag_retrieval_log DROP CONSTRAINT IF EXISTS rag_retrieval_log_source_recheck_check;
ALTER TABLE public.rag_retrieval_log ADD CONSTRAINT rag_retrieval_log_source_recheck_check CHECK (
  (source_rechecked IS NULL AND stale_index_drop IS NULL)
  OR (source_rechecked IS NOT NULL AND stale_index_drop IS NOT NULL
      AND source_rechecked >= 0 AND stale_index_drop >= 0 AND stale_index_drop <= source_rechecked)
);

CREATE OR REPLACE FUNCTION public.rag_monitor_stale_index_drop(p_day date)
RETURNS TABLE (tenant_key text, retrievals bigint, checked bigint, dropped bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT l.tenant_key,
         pg_catalog.count(*)::bigint,
         COALESCE(pg_catalog.sum(l.source_rechecked), 0)::bigint,
         COALESCE(pg_catalog.sum(l.stale_index_drop), 0)::bigint
    FROM public.rag_retrieval_log l
   WHERE p_day IS NOT NULL
     AND l.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
     AND l.created_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
     AND l.source_rechecked IS NOT NULL
     AND l.tenant_key IS NOT NULL
   GROUP BY l.tenant_key
   ORDER BY l.tenant_key
$$;

REVOKE ALL ON FUNCTION public.rag_monitor_stale_index_drop(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_monitor_stale_index_drop(date) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/1014_lexstats_compact_tenant_guard.sql
-- 1014: tenant guard on rag_lexstats_compact_tenant (quick-44-t09, T-04.4-09; LEX-06, D-32).
-- rag_lexstats_compact_tenant now calls rag_assert_tenant_key (0425) before any other statement, like every other Phase 4.4 function
-- taking p_tenant_key: a malformed key, NULL or a key of the other deployment mode raises 22023 and touches no row. The body is otherwise
-- the 0905 body (pending fold of both corpora, then cluster marker reconciliation under the same advisory lock).
-- rag_lexstats_compact_all is redefined from its 0905 body so that one stray rag_lexical_stats_state key still never stops it (plan
-- 04.4-04): a key the guard refuses is skipped inside its own subtransaction, the other tenants are compacted, and one WARNING carries
-- the skipped count only, never a key.
-- Security: both functions stay SECURITY INVOKER with an empty search_path, revoked from PUBLIC, anon and authenticated and granted to
-- service_role. No dynamic SQL.
-- Numbered 1014 so that it sorts after 0905, which defines the bodies it replaces (07xx would run first on a fresh apply and be
-- overwritten). Re-run rule: after re-running 0902 or 0905, re-run this file. Idempotent; not folded into the setup files.

BEGIN;

DO $lexstats_compact_guard_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact_tenant(text, integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact_all(integer)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_cluster_dirty') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_cluster_units') IS NULL THEN
    RAISE EXCEPTION '1014: apply migrations 0425 and 0900 to 0905 first' USING ERRCODE = '55000';
  END IF;
END
$lexstats_compact_guard_precheck$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_tenant(p_tenant_key text, p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_max integer := LEAST(GREATEST(COALESCE(p_max_rows, 5000), 1), 50000);
  v_cluster_status text;
  v_folded bigint;
  v_marks bigint := 0;
  v_mark_ids bigint[];
  v_clusters uuid[];
  v_df_corpus text[];
  v_df_lexeme text[];
  v_df_profile text[];
  v_df_language text[];
  v_c_corpus text[];
  v_c_profile text[];
  v_c_language text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));

  WITH taken AS (
    DELETE FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key
       AND p.id IN (
         SELECT q.id FROM public.rag_lexical_stats_pending q
          WHERE q.tenant_key = p_tenant_key
          ORDER BY q.id
          LIMIT v_max
       )
    RETURNING p.corpus, p.chunking_profile_id, p.language, p.sign, p.lexemes, p.dl
  ), df_delta AS (
    SELECT t.corpus, u.lexeme, t.chunking_profile_id, t.language, pg_catalog.sum(t.sign)::bigint AS d
      FROM taken t
     CROSS JOIN LATERAL pg_catalog.unnest(t.lexemes) AS u(lexeme)
     GROUP BY t.corpus, u.lexeme, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0
  ), df_up AS (
    INSERT INTO public.rag_lexical_df AS f (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
    SELECT p_tenant_key, x.corpus, x.lexeme, x.chunking_profile_id, x.language, x.d
      FROM df_delta x
     ORDER BY x.corpus, x.lexeme, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, lexeme, chunking_profile_id, language) DO UPDATE SET df = f.df + EXCLUDED.df
    RETURNING f.corpus, f.lexeme, f.chunking_profile_id, f.language, f.df
  ), corpus_delta AS (
    SELECT t.corpus, t.chunking_profile_id, t.language,
           pg_catalog.sum(t.sign)::bigint AS n, pg_catalog.sum(t.sign::bigint * t.dl)::bigint AS len
      FROM taken t
     GROUP BY t.corpus, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0 OR pg_catalog.sum(t.sign::bigint * t.dl) <> 0
  ), corpus_up AS (
    INSERT INTO public.rag_lexical_corpus AS c (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
    SELECT p_tenant_key, x.corpus, x.chunking_profile_id, x.language, x.n, x.len
      FROM corpus_delta x
     ORDER BY x.corpus, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, chunking_profile_id, language)
      DO UPDATE SET chunk_count = c.chunk_count + EXCLUDED.chunk_count, total_len = c.total_len + EXCLUDED.total_len
    RETURNING c.corpus, c.chunking_profile_id, c.language, c.chunk_count
  )
  SELECT (SELECT pg_catalog.count(*) FROM taken),
         z.dc, z.dl, z.dp, z.dg, y.cc, y.cp, y.cg
    INTO v_folded, v_df_corpus, v_df_lexeme, v_df_profile, v_df_language, v_c_corpus, v_c_profile, v_c_language
    FROM (SELECT pg_catalog.array_agg(d.corpus) AS dc, pg_catalog.array_agg(d.lexeme) AS dl,
                 pg_catalog.array_agg(d.chunking_profile_id) AS dp, pg_catalog.array_agg(d.language) AS dg
            FROM df_up d WHERE d.df <= 0) z,
         (SELECT pg_catalog.array_agg(k.corpus) AS cc, pg_catalog.array_agg(k.chunking_profile_id) AS cp,
                 pg_catalog.array_agg(k.language) AS cg
            FROM corpus_up k WHERE k.chunk_count <= 0) y;

  DELETE FROM public.rag_lexical_df f
   USING ROWS FROM (pg_catalog.unnest(v_df_corpus), pg_catalog.unnest(v_df_lexeme), pg_catalog.unnest(v_df_profile), pg_catalog.unnest(v_df_language)) AS k(corpus, lexeme, chunking_profile_id, language)
   WHERE f.tenant_key = p_tenant_key
     AND f.corpus = k.corpus AND f.lexeme = k.lexeme
     AND f.chunking_profile_id = k.chunking_profile_id AND f.language = k.language
     AND f.df <= 0;

  DELETE FROM public.rag_lexical_corpus c
   USING ROWS FROM (pg_catalog.unnest(v_c_corpus), pg_catalog.unnest(v_c_profile), pg_catalog.unnest(v_c_language)) AS k(corpus, chunking_profile_id, language)
   WHERE c.tenant_key = p_tenant_key
     AND c.corpus = k.corpus AND c.chunking_profile_id = k.chunking_profile_id AND c.language = k.language
     AND c.chunk_count <= 0;

  SELECT s.cluster_status INTO v_cluster_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_cluster_status IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.array_agg(m.id ORDER BY m.id), '{}'::bigint[]),
           COALESCE(pg_catalog.array_agg(DISTINCT m.dup_cluster_id), '{}'::uuid[])
      INTO v_mark_ids, v_clusters
      FROM (
        SELECT d.id, d.dup_cluster_id FROM public.rag_lexical_cluster_dirty d
         WHERE d.tenant_key = p_tenant_key
         ORDER BY d.id
         LIMIT v_max
      ) m;
    v_marks := pg_catalog.cardinality(v_mark_ids);
  END IF;

  IF v_marks > 0 THEN
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_cluster_delta (
      sign smallint NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_cluster_new_units (
      dup_cluster_id uuid NOT NULL,
      chunking_profile_id text NOT NULL,
      language text NOT NULL,
      chunk_id uuid NOT NULL,
      lexemes text[] NOT NULL,
      dl integer NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE pg_temp._rag_lexstats_cluster_delta;
    TRUNCATE pg_temp._rag_lexstats_cluster_new_units;

    INSERT INTO pg_temp._rag_lexstats_cluster_new_units (dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT DISTINCT ON (c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'))
           c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id,
           pg_catalog.tsvector_to_array(c.lexical_tsv), public.rag_lexical_dl(c.lexical_tsv)
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.dup_cluster_id = ANY (v_clusters)
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
     ORDER BY c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und'), c.id;

    INSERT INTO pg_temp._rag_lexstats_cluster_delta (sign, chunking_profile_id, language, lexemes, dl)
    SELECT (-1)::smallint, u.chunking_profile_id, u.language, u.lexemes, u.dl
      FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key AND u.dup_cluster_id = ANY (v_clusters)
    UNION ALL
    SELECT 1::smallint, n.chunking_profile_id, n.language, n.lexemes, n.dl
      FROM pg_temp._rag_lexstats_cluster_new_units n;

    WITH df_delta AS (
      SELECT u.lexeme, t.chunking_profile_id, t.language, pg_catalog.sum(t.sign)::bigint AS d
        FROM pg_temp._rag_lexstats_cluster_delta t
       CROSS JOIN LATERAL pg_catalog.unnest(t.lexemes) AS u(lexeme)
       GROUP BY u.lexeme, t.chunking_profile_id, t.language
      HAVING pg_catalog.sum(t.sign) <> 0
    ), df_up AS (
      INSERT INTO public.rag_lexical_df AS f (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
      SELECT p_tenant_key, 'chunks_cluster', x.lexeme, x.chunking_profile_id, x.language, x.d
        FROM df_delta x
       ORDER BY x.lexeme, x.chunking_profile_id, x.language
      ON CONFLICT (tenant_key, corpus, lexeme, chunking_profile_id, language) DO UPDATE SET df = f.df + EXCLUDED.df
      RETURNING f.corpus, f.lexeme, f.chunking_profile_id, f.language, f.df
    ), corpus_delta AS (
      SELECT t.chunking_profile_id, t.language,
             pg_catalog.sum(t.sign)::bigint AS n, pg_catalog.sum(t.sign::bigint * t.dl)::bigint AS len
        FROM pg_temp._rag_lexstats_cluster_delta t
       GROUP BY t.chunking_profile_id, t.language
      HAVING pg_catalog.sum(t.sign) <> 0 OR pg_catalog.sum(t.sign::bigint * t.dl) <> 0
    ), corpus_up AS (
      INSERT INTO public.rag_lexical_corpus AS c (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
      SELECT p_tenant_key, 'chunks_cluster', x.chunking_profile_id, x.language, x.n, x.len
        FROM corpus_delta x
       ORDER BY x.chunking_profile_id, x.language
      ON CONFLICT (tenant_key, corpus, chunking_profile_id, language)
        DO UPDATE SET chunk_count = c.chunk_count + EXCLUDED.chunk_count, total_len = c.total_len + EXCLUDED.total_len
      RETURNING c.corpus, c.chunking_profile_id, c.language, c.chunk_count
    )
    SELECT z.dc, z.dl, z.dp, z.dg, y.cc, y.cp, y.cg
      INTO v_df_corpus, v_df_lexeme, v_df_profile, v_df_language, v_c_corpus, v_c_profile, v_c_language
      FROM (SELECT pg_catalog.array_agg(d.corpus) AS dc, pg_catalog.array_agg(d.lexeme) AS dl,
                   pg_catalog.array_agg(d.chunking_profile_id) AS dp, pg_catalog.array_agg(d.language) AS dg
              FROM df_up d WHERE d.df <= 0) z,
           (SELECT pg_catalog.array_agg(k.corpus) AS cc, pg_catalog.array_agg(k.chunking_profile_id) AS cp,
                   pg_catalog.array_agg(k.language) AS cg
              FROM corpus_up k WHERE k.chunk_count <= 0) y;

    DELETE FROM public.rag_lexical_df f
     USING ROWS FROM (pg_catalog.unnest(v_df_corpus), pg_catalog.unnest(v_df_lexeme), pg_catalog.unnest(v_df_profile), pg_catalog.unnest(v_df_language)) AS k(corpus, lexeme, chunking_profile_id, language)
     WHERE f.tenant_key = p_tenant_key
       AND f.corpus = k.corpus AND f.lexeme = k.lexeme
       AND f.chunking_profile_id = k.chunking_profile_id AND f.language = k.language
       AND f.df <= 0;

    DELETE FROM public.rag_lexical_corpus c
     USING ROWS FROM (pg_catalog.unnest(v_c_corpus), pg_catalog.unnest(v_c_profile), pg_catalog.unnest(v_c_language)) AS k(corpus, chunking_profile_id, language)
     WHERE c.tenant_key = p_tenant_key
       AND c.corpus = k.corpus AND c.chunking_profile_id = k.chunking_profile_id AND c.language = k.language
       AND c.chunk_count <= 0;

    DELETE FROM public.rag_lexical_cluster_units u
     WHERE u.tenant_key = p_tenant_key AND u.dup_cluster_id = ANY (v_clusters);
    INSERT INTO public.rag_lexical_cluster_units (tenant_key, dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl)
    SELECT p_tenant_key, n.dup_cluster_id, n.chunking_profile_id, n.language, n.chunk_id, n.lexemes, n.dl
      FROM pg_temp._rag_lexstats_cluster_new_units n
     ORDER BY n.dup_cluster_id, n.chunking_profile_id, n.language;

    DELETE FROM public.rag_lexical_cluster_dirty d
     WHERE d.tenant_key = p_tenant_key AND d.id = ANY (v_mark_ids);

    TRUNCATE pg_temp._rag_lexstats_cluster_delta;
    TRUNCATE pg_temp._rag_lexstats_cluster_new_units;
  END IF;

  IF v_folded + v_marks > 0 THEN
    UPDATE public.rag_lexical_stats_state s SET compacted_at = pg_catalog.now() WHERE s.tenant_key = p_tenant_key;
  END IF;
  RETURN v_folded + v_marks;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_all(p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
  v_total bigint := 0;
  v_skipped integer := 0;
BEGIN
  FOR v_key IN
    SELECT s.tenant_key
      FROM public.rag_lexical_stats_state s
     WHERE EXISTS (SELECT 1 FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = s.tenant_key)
        OR (s.cluster_status IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.rag_lexical_cluster_dirty d WHERE d.tenant_key = s.tenant_key))
     ORDER BY s.tenant_key
  LOOP
    BEGIN
      v_total := v_total + public.rag_lexstats_compact_tenant(v_key, p_max_rows);
    EXCEPTION WHEN invalid_parameter_value THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;
  IF v_skipped > 0 THEN
    RAISE WARNING '[Lexical Stats] compact_all skipped % state row(s) with a tenant key not valid for this deployment mode', v_skipped;
  END IF;
  RETURN v_total;
END
$fn$;

-- Enable, rebuild, disable ----------------------------------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_all(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_all(integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0906_lexical_rerank_stats.sql
-- Phase 4.4 plan 04.4-21 (D-55, D-56): rag_lexical_rerank_stats, the tenant statistics read of the local_bm25 reranker under
-- RAG_RERANK_LOCAL_STATS=tenant. For each asked rerank candidate (a chunk id of the caller's tenant) it returns that chunk's own chunking
-- profile and language ('und' when none), the chunk count and total length of the tenant's compacted statistics for that profile and
-- language, and the df of each asked term (0 without a counter; the caller clamps). A chunk id of another tenant, or an unknown one, gives
-- no row. It reads the compacted counters only, as rag_bm25_search_chunks does; staged deltas are not folded in. Counts for the asked
-- terms only, never a lexeme list. Raises lexical_stats_not_ready (55000) for a tenant without ready statistics; the caller then uses pool
-- statistics. Both deployment modes, not folded, idempotent; no table, trigger or existing function changes. SECURITY INVOKER, empty
-- search_path, service_role only; the tenant key is checked by rag_assert_tenant_key.
BEGIN;

DO $guard$
BEGIN
  IF pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL THEN
    RAISE EXCEPTION '0906: apply 0900 to 0902 first' USING ERRCODE = '55000';
  END IF;
END
$guard$;

-- An earlier body of this file took (doc type, language) pairs; drop every overload so exactly one signature remains.
DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_lexical_rerank_stats'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.rag_lexical_rerank_stats(
  p_tenant_key text,
  p_terms text[],
  p_chunk_ids uuid[]
)
RETURNS TABLE (
  chunk_id uuid,
  chunking_profile_id text,
  language text,
  chunk_count bigint,
  total_len bigint,
  terms text[],
  dfs bigint[]
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_terms text[];
  v_status text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF pg_catalog.cardinality(COALESCE(p_terms, '{}'::text[])) > 64 THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: at most 64 terms' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.cardinality(COALESCE(p_chunk_ids, '{}'::uuid[])) > 500 THEN
    RAISE EXCEPTION 'rag_lexical_rerank_stats: at most 500 chunks' USING ERRCODE = '22023';
  END IF;

  -- The term forms rag_bm25_search_chunks accepts, distinct, in the asked order.
  SELECT pg_catalog.array_agg(t.tok ORDER BY t.first_ord) INTO v_terms
  FROM (
    SELECT u.tok, pg_catalog.min(u.ord) AS first_ord
    FROM pg_catalog.unnest(COALESCE(p_terms, '{}'::text[])) WITH ORDINALITY AS u(tok, ord)
    WHERE u.tok <> '' AND pg_catalog.octet_length(u.tok) <= 255 AND u.tok !~ '[''\\[:space:]]'
    GROUP BY u.tok
  ) AS t;
  IF v_terms IS NULL OR pg_catalog.cardinality(COALESCE(p_chunk_ids, '{}'::uuid[])) = 0 THEN
    RETURN;
  END IF;

  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the tenant has no ready lexical statistics' USING ERRCODE = '55000';
  END IF;

  RETURN QUERY
  WITH cand AS MATERIALIZED (
    SELECT c.id, c.chunking_profile_id AS profile_id, COALESCE(c.language, 'und') AS lang
    FROM public.document_chunks c
    WHERE c.tenant_key = p_tenant_key AND c.id = ANY (p_chunk_ids)
  ), grp AS MATERIALIZED (
    SELECT g.profile_id, g.lang,
           COALESCE(lc.chunk_count, 0)::bigint AS n,
           COALESCE(lc.total_len, 0)::bigint AS len,
           (SELECT pg_catalog.array_agg(COALESCE(d.df, 0)::bigint ORDER BY t.ord)
              FROM pg_catalog.unnest(v_terms) WITH ORDINALITY AS t(tok, ord)
              LEFT JOIN public.rag_lexical_df d
                ON d.tenant_key = p_tenant_key AND d.corpus = 'chunks' AND d.lexeme = t.tok
               AND d.chunking_profile_id = g.profile_id AND d.language = g.lang) AS df
    FROM (SELECT DISTINCT cand.profile_id, cand.lang FROM cand) AS g
    LEFT JOIN public.rag_lexical_corpus lc
      ON lc.tenant_key = p_tenant_key AND lc.corpus = 'chunks' AND lc.chunking_profile_id = g.profile_id AND lc.language = g.lang
  )
  SELECT cand.id, cand.profile_id, cand.lang, grp.n, grp.len, v_terms, grp.df
  FROM cand JOIN grp ON grp.profile_id = cand.profile_id AND grp.lang = cand.lang
  ORDER BY cand.id;
END
$fn$;

COMMENT ON FUNCTION public.rag_lexical_rerank_stats(text, text[], uuid[]) IS
  '04.4-21 D-55: per rerank candidate of the caller tenant, its profile and language bucket: compacted chunk count, total length and df of the asked terms; service_role only.';

REVOKE ALL ON FUNCTION public.rag_lexical_rerank_stats(text, text[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexical_rerank_stats(text, text[], uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0410_security_definer_rpc_grants.sql
-- 0410: Every public SECURITY DEFINER function is service_role only unless it is an authenticated-callable RPC or an RLS helper (03-48 follow-up 2, D-08).
-- 0409 closed the four tenant search RPCs. Hosted Supabase grants EXECUTE on each new public function to anon and authenticated, and CREATE OR REPLACE
-- keeps whatever a function already had, so an upgraded database can still expose writers, queue and budget RPCs and the folder, sharing and
-- organisation helpers to anon through PostgREST. This migration closes all of them.
--
--   Section 1: service-role-only RPCs. EXECUTE is revoked from PUBLIC, anon and authenticated and granted to service_role.
--   Section 2: authenticated-callable RPCs and RLS helpers. EXECUTE is revoked from PUBLIC and anon and granted to authenticated and service_role.
--              Only the helpers that policies without a TO clause evaluate for anon (is_org_member, is_org_owner, is_org_admin, check_admin_status) keep anon,
--              and the three helpers of the 0926 restrictive access-group policies (TO anon, authenticated): rag_access_enforced, rag_caller_access_keys,
--              rag_caller_is_access_admin.
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
  IF to_regprocedure('public.rag_access_groups_from_document()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_from_document() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_from_document() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_groups_propagate()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_propagate() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_groups_propagate_table_rows()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_table_rows() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_table_rows() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_groups_propagate_translations()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_translations() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_translations() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_groups_on_org_member_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_on_org_member_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_on_org_member_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_user_in_tenant(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_user_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_user_in_tenant(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_group_members_list(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_group_members_list(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_group_members_list(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_member_candidates(text, uuid, text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_member_candidates(text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_member_candidates(text, uuid, text, integer) TO service_role;
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
  IF to_regprocedure('public.rag_approve_upload(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_approve_upload(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_approve_upload(uuid, uuid) TO service_role;
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
  IF to_regprocedure('public.rag_confirm_supersession(uuid, uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_confirm_supersession(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_confirm_supersession(uuid, uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_connector_match_members(text, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_connector_match_members(text, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_connector_match_members(text, text[]) TO service_role;
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
  IF to_regprocedure('public.rag_dismiss_supersession(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_dismiss_supersession(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_dismiss_supersession(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_dismiss_effective_date_proposal(uuid, text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_dismiss_effective_date_proposal(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_dismiss_effective_date_proposal(uuid, text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_lexstats_chunks_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_lexstats_chunks_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_lexstats_chunks_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_document_effective_dates(uuid, text, date, date, text, real, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_document_effective_dates(uuid, text, date, date, text, real, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_document_effective_dates(uuid, text, date, date, text, real, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_embedding_bindings_guard()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_embedding_bindings_guard() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_embedding_bindings_guard() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_activate_embedding_binding(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_activate_embedding_binding(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_activate_embedding_binding(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_create_embedding_binding(text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_create_embedding_binding(text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_create_embedding_binding(text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_deactivate_embedding_binding(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_deactivate_embedding_binding(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_deactivate_embedding_binding(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_embedding_bindings()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_embedding_bindings() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_embedding_bindings() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_embedding_profile_scopes()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_embedding_profile_scopes() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_embedding_profile_scopes() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_supersession(uuid, text, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_supersession(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_supersession(uuid, text, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_hook_supersession(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_hook_supersession(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_hook_supersession(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_hook_scope_tags(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_hook_scope_tags(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_hook_scope_tags(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_names_taken(text, text, text[], uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_names_taken(text, text, text[], uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_names_taken(text, text, text[], uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_admin(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_admin(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_admin(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_vocabulary_list(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_list(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_list(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_vocabulary_for(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_for(text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_for(text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_vocabulary_create(uuid, text, text, text, text, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_create(uuid, text, text, text, text, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_create(uuid, text, text, text, text, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_vocabulary_update(uuid, text, uuid, text, text[], boolean, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_update(uuid, text, uuid, text, text[], boolean, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_update(uuid, text, uuid, text, text[], boolean, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_document_scopes(uuid, text, text[], uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_document_scopes(uuid, text, text[], uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_document_scopes(uuid, text, text[], uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_documents_with_scopes(uuid, text, text[], text, integer, integer, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_documents_with_scopes(uuid, text, text[], text, integer, integer, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_documents_with_scopes(uuid, text, text[], text, integer, integer, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_record_binding_evidence(uuid, jsonb, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_record_binding_evidence(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_record_binding_evidence(uuid, jsonb, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rollback_embedding_binding(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rollback_embedding_binding(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rollback_embedding_binding(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_set_embedding_binding_status(uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_embedding_binding_status(uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_embedding_binding_status(uuid, text, text) TO service_role;
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
  IF to_regprocedure('public.rag_list_quarantine_reasons(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_quarantine_reasons(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_quarantine_reasons(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_release_quarantine_reasons(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_release_quarantine_reasons(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_release_quarantine_reasons(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_not_checked(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_not_checked(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_not_checked(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_pending_uploads(uuid, text, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_pending_uploads(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_pending_uploads(uuid, text, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_stale_ingestion_jobs(integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_retrieval_log(integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_retrieval_log(integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_retrieval_log(integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_feedback_loop_on_chat_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_feedback_loop_on_chat_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_feedback_loop_on_chat_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) TO service_role;
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
  IF to_regprocedure('public.rag_golden_evidence_on_documents_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_golden_evidence_on_documents_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_golden_evidence_on_documents_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_golden_evidence_on_documents_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_golden_evidence_on_documents_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_golden_evidence_on_documents_update() TO service_role;
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
  IF to_regprocedure('public.rag_pilot_user_resolve(text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_pilot_user_resolve(text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_pilot_user_resolve(text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_pilot_users_list(text, integer, timestamptz, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_pilot_users_list(text, integer, timestamptz, uuid) TO service_role;
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
  IF to_regprocedure('public.rag_reject_upload(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_reject_upload(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_reject_upload(uuid, uuid) TO service_role;
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
  IF to_regprocedure('public.rag_semantic_cache_on_access_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_access_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_access_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_semantic_cache_on_documents_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_documents_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_documents_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_semantic_cache_on_documents_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_documents_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_documents_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_semantic_cache_on_documents_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_documents_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_documents_update() TO service_role;
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
  IF to_regprocedure('public.rag_supersession_raise(text, uuid, uuid, jsonb, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_supersession_raise(text, uuid, uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_supersession_raise(text, uuid, uuid, jsonb, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_undo_supersession(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_undo_supersession(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_undo_supersession(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_update_embed_batch(uuid, text, text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_upload_approval_keys(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_upload_approval_keys(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_upload_approval_keys(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_upload_exemption_add(uuid, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_upload_exemption_add(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_upload_exemption_add(uuid, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_upload_exemption_list(uuid, text, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_upload_exemption_list(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_upload_exemption_list(uuid, text, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_upload_exemption_remove(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_upload_exemption_remove(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_upload_exemption_remove(uuid, uuid) TO service_role;
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
  IF to_regprocedure('public.rag_term_apply_import(uuid, text, jsonb, text, bigint)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_apply_import(uuid, text, jsonb, text, bigint) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_apply_import(uuid, text, jsonb, text, bigint) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_delete_entry(uuid, text, uuid, bigint)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_delete_entry(uuid, text, uuid, bigint) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_delete_entry(uuid, text, uuid, bigint) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_list_audit(uuid, text, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_list_audit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_list_audit(uuid, text, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_list_entries(uuid, text, integer, integer, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_set_suppression(uuid, text, uuid, boolean, bigint)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_set_suppression(uuid, text, uuid, boolean, bigint) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_set_suppression(uuid, text, uuid, boolean, bigint) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_upsert_entry(uuid, text, jsonb, bigint)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_upsert_entry(uuid, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_upsert_entry(uuid, text, jsonb, bigint) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_corpus_df(text, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_corpus_df(text, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_corpus_df(text, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_decide_candidate(uuid, uuid, text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_decide_candidate(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_decide_candidate(uuid, uuid, text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_list_candidates(uuid, text, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_list_candidates(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_list_candidates(uuid, text, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_purge_misses(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_purge_misses(integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_purge_misses(integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_read_misses(text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_read_misses(text, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_read_misses(text, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_record_miss(text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_record_miss(text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_record_miss(text, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_upsert_candidates(text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_upsert_candidates(text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_upsert_candidates(text, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.share_chat(uuid, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.share_chat(uuid, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.share_chat(uuid, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.unshare_chat(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.unshare_chat(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.unshare_chat(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_withdrawn_citation(jsonb, timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_citation(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_citation(jsonb, timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_withdrawn_citations(jsonb, text[], timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_citations(jsonb, text[], timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_citations(jsonb, text[], timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_withdrawn_document_refs(jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_document_refs(jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_document_refs(jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_image_pattern(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_image_pattern(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_image_pattern(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_citation_leftover_count(jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_citation_leftover_count(jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_citation_leftover_count(jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_chat_messages_leftover_count(jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chat_messages_leftover_count(jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chat_messages_leftover_count(jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_chat_messages_reference(jsonb, text[], text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_citation_leftovers(text, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_citation_leftovers(text, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_citation_leftovers(text, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_chat_image_leftovers(text, uuid, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_chat_image_leftovers(text, uuid, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_chat_image_leftovers(text, uuid, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_admin_target(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_admin_target(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_admin_target(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_list(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_list(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_list(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_get(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_get(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_get(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_pending(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_pending(integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_pending(integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_tombstone_exists(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_tombstone_exists(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_tombstone_exists(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_lineage(text, uuid, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_verify(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_verify(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_verify(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_store_inventory()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_store_inventory() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_store_inventory() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_foreign_stores(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_stores(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_foreign_leftovers(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_foreign_leftovers(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_table_rows_follow_document()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_table_rows_follow_document() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_table_rows_follow_document() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_hook_table_rows(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_hook_table_rows(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_hook_table_rows(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_documents_access_inherit()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_documents_access_inherit() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_documents_access_inherit() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_dup_clusters_mark_dirty_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_dup_clusters_mark_dirty_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_dup_clusters_mark_dirty_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_dup_clusters_mark_dirty_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_dup_clusters_mark_dirty_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_dup_clusters_mark_dirty_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_hook_dup_clusters(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_hook_dup_clusters(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_hook_dup_clusters(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_nango_owner_tenant_key(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_nango_owner_tenant_key(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_nango_owner_tenant_key(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_record(text, uuid, text, text, jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_reconcile_run_decide(uuid, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_decide(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_decide(uuid, uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_reconcile_run_finish(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_reconcile_run_finish(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_reconcile_run_finish(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_sync_admin_connections(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_sync_admin_connections(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_sync_admin_connections(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_sync_set_deletion_mode(uuid, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_sync_set_deletion_mode(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_sync_set_deletion_mode(uuid, uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_purge_reserve(text, uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_purge_reserve(text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_purge_reserve(text, uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_purge_release(text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_purge_release(text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_purge_release(text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_purge_hold(text, uuid, text[], integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_purge_hold(text, uuid, text[], integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_purge_hold(text, uuid, text[], integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_hook_identifiers(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_hook_identifiers(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_hook_identifiers(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_hook_duplicate_clusters(text, uuid, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_hook_duplicate_clusters(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_hook_duplicate_clusters(text, uuid, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_set_consent(text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_set_consent(text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_set_consent(text, text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_list_consent()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_list_consent() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_list_consent() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_consent_for_export(text[], text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_consent_for_export(text[], text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_consent_for_export(text[], text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_register_model(jsonb, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_register_model(jsonb, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_register_model(jsonb, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_list_models(boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_list_models(boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_list_models(boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_set_model_status(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_set_model_status(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_set_model_status(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_bind_slot(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_bind_slot(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_bind_slot(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_clear_slot(text, text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_clear_slot(text, text, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_clear_slot(text, text, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_release_rollback(text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_release_rollback(text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_release_rollback(text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_slot_guard()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_slot_guard() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_slot_guard() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_version_taint_guard()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_version_taint_guard() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_version_taint_guard() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_export_vectors(text, text, text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_export_vectors(text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_export_vectors(text, text, text, uuid, integer) TO service_role;
  END IF;
  -- Phase 5.2, migrations 0940 to 0943: document version label, security events, alerts and uploader holds (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_set_document_version_label(text, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_set_document_version_label(text, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_set_document_version_label(text, uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_record_security_events(text, jsonb, integer, integer, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_record_security_events(text, jsonb, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_record_security_events(text, jsonb, integer, integer, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_hold_uploader(text, uuid, uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_hold_uploader(text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_hold_uploader(text, uuid, uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_release_uploader_hold(text, uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_release_uploader_hold(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_release_uploader_hold(text, uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_acknowledge_security_alert(text, uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_acknowledge_security_alert(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_acknowledge_security_alert(text, uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_uploader_hold_active(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_uploader_hold_active(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_uploader_hold_active(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_active_uploader_holds(text, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_active_uploader_holds(text, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_active_uploader_holds(text, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_security_events(text[], text, uuid, timestamptz, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_security_events(text[], text, uuid, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_security_events(text[], text, uuid, timestamptz, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_security_alerts(text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_security_alerts(text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_security_alerts(text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_list_security_uploaders(text[], integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_list_security_uploaders(text[], integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_list_security_uploaders(text[], integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_bind_scoped_slot(text, text, text[], text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_bind_scoped_slot(text, text, text[], text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_bind_scoped_slot(text, text, text[], text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_finetune_scope_slot(text, text[], text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_finetune_scope_slot(text, text[], text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_finetune_scope_slot(text, text[], text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_enqueue_review_item(text, text, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) TO service_role;
  END IF;
  -- Phase 5.2, migration 0945: security-events admin tenant resolution (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_security_admin_keys(uuid, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_security_admin_keys(uuid, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_security_admin_keys(uuid, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_security_uploader_in_tenant(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean, text[], boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid, text[], boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer, text[], boolean) TO service_role;
  END IF;
  -- Phase 4.3 follow-up, migration 0984: review-queue access sets (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_review_access_sets(text, jsonb, uuid[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) TO service_role;
  END IF;
  -- 0983 (Phase 6.2, 06.2-15): scope-gate invalidation helper and trigger functions, service_role only.
  IF to_regprocedure('public.rag_scope_centroids_invalidate(text[], text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_documents_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_documents_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_documents_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunks_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunks_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunks_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunk_embeddings_change()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() TO service_role;
  END IF;
  -- Migration 0987: scope centroids are cleared when the access enforcement flag changes (SECURITY DEFINER trigger, service_role only).
  IF to_regprocedure('public.rag_scope_centroids_on_access_settings_change()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_access_settings_change() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_access_settings_change() TO service_role;
  END IF;
  -- Migration 1010: the attribute resolver with the access filter (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_attribute_filter_values(text, integer, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_attribute_documents(text, jsonb, integer, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_recheck(text, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_recheck(text, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_recheck(text, uuid[]) TO service_role;
  END IF;
  -- Migration 0986: the tenant doc types with the access filter (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_tenant_doc_types(text, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) TO service_role;
  END IF;
  -- 0988 (quick task, renumbered from 0986 in train 40): Phase 5.3 review-queue writers with access sets (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_review_items_enqueue(text, text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_review_items_enqueue_re_review(text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) TO service_role;
  END IF;
  -- 0990 (quick task): review items owner trigger function (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_review_items_fill_owner()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_items_fill_owner() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_items_fill_owner() TO service_role;
  END IF;
  -- Migration 1011: the chunk attribute header stamp insert guard trigger function (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_chunk_attribute_header_stamp_insert_guard()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() TO service_role;
  END IF;
END
$service_role_only$;

DO $authenticated_callable$
BEGIN
  IF to_regprocedure('public.rag_access_enforced()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.rag_caller_access_keys()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_caller_access_keys() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.rag_caller_access_keys() TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.rag_caller_is_access_admin()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_caller_is_access_admin() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.rag_caller_is_access_admin() TO authenticated, anon, service_role;
  END IF;
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
  IF to_regprocedure('public.rag_is_domain_expert(text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_is_domain_expert(text) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.rag_is_domain_expert(text) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.rag_caller_reads_access_sets(text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) TO authenticated, service_role;
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

-- ==== Verify (read-only; run after the apply). Statements are separated by blank lines.
-- 1. Migration objects exist (expect every value true).
SELECT to_regprocedure('public.rag_purge_image_url_hashes(uuid[])') IS NOT NULL AS t0747_image_url_hashes,
       to_regprocedure('public.rag_purge_image_url_match(text, text, text[])') IS NOT NULL AS t0747_image_url_match,
       to_regprocedure('public.rag_purge_hook_review_items(text, uuid, uuid[])') IS NOT NULL AS t0747_hook_review_items,
       to_regprocedure('public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz, text[])') IS NOT NULL AS t0747_withdrawn_5arg,
       to_regprocedure('public.rag_chat_messages_reference(jsonb, text[], text, text[])') IS NOT NULL AS t0747_reference_4arg,
       to_regprocedure('public.rag_purge_chat_image_leftovers(text, uuid, text[])') IS NOT NULL AS t0747_mode_image_leftovers,
       to_regprocedure('public.rag_chat_image_leftover_count(jsonb, text, text[])') IS NOT NULL AS t0747_image_leftover_count,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_purge_audit'
                 AND column_name = 'image_url_sha256') AS t0747_audit_hash_column,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_purge_foreign_stores'
                 AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%rag_purge_hook_review_items%') AS t0747_foreign_stores_review_items,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_purge_lineage'
                 AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%rag_nango_owner_tenant_key%') AS t1015_lineage_owner_check,
       to_regprocedure('public.rag_purge_audit_recent(timestamptz, uuid, integer)') IS NOT NULL AS t1015_audit_recent,
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'public.rag_connector_group_map'::regclass AND c.contype = 'c'
                 AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%sharepoint-online%') AS t1012_group_map_check,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_connector_map_set'
                 AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%one-drive%') AS t1012_map_set_providers,
       to_regprocedure('public.rag_monitor_stale_index_drop(date)') IS NOT NULL AS t1013_stale_index_drop_fn,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'rag_retrieval_log'
                 AND column_name = 'stale_index_drop') AS t1013_log_column,
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = 'public.rag_monitor_alerts'::regclass
                 AND c.conname = 'rag_monitor_alerts_rule_check'
                 AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%stale_index_drop_rate%') AS t1013_alert_rule_check,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_lexstats_compact_tenant'
                 AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%rag_assert_tenant_key(p_tenant_key)%') AS t1014_compact_guard,
       to_regprocedure('public.rag_lexical_rerank_stats(text, text[], uuid[])') IS NOT NULL AS t0906_rerank_stats;

-- 2. Every train-44 function: empty search_path, service_role may execute, anon and authenticated may not.
SELECT p.proname, p.prosecdef AS security_definer,
       pg_catalog.array_to_string(p.proconfig, ',') AS config,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('rag_chat_image_leftover_count', 'rag_chat_messages_reference', 'rag_lexstats_compact_all',
       'rag_lexstats_compact_tenant', 'rag_monitor_stale_index_drop', 'rag_purge_audit_recent', 'rag_purge_chat_image_leftovers',
       'rag_purge_foreign_leftovers', 'rag_purge_foreign_stores', 'rag_purge_hook_review_items', 'rag_purge_image_url_hashes',
       'rag_purge_image_url_match', 'rag_purge_lineage', 'rag_purge_scrub_chats', 'rag_purge_store_inventory', 'rag_purge_verify',
       'rag_withdrawn_chat_messages', 'rag_lexical_rerank_stats')
ORDER BY 1, 2;
-- Expect 20 rows (rag_chat_messages_reference and rag_withdrawn_chat_messages have two overloads each, 0724 and 0747); config
-- 'search_path=""' on each (rag_lexical_rerank_stats is SECURITY INVOKER); service_role_exec true, anon_exec false, authenticated_exec false; security_definer true only for
-- rag_purge_lineage, rag_purge_verify, rag_purge_scrub_chats, rag_purge_foreign_stores, rag_purge_foreign_leftovers,
-- rag_purge_chat_image_leftovers and the older (0724) overloads of rag_chat_messages_reference and rag_withdrawn_chat_messages.

-- 3. 1014: the compact guard refuses a malformed key with 22023 (raises only when the guard is missing; writes nothing).
DO $chk$
BEGIN
  BEGIN
    PERFORM public.rag_lexstats_compact_tenant('not-a-key', 1);
    RAISE EXCEPTION 'train44 verify: rag_lexstats_compact_tenant accepted a malformed key';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE 'train44 verify: 1014 guard refuses a malformed key (22023)';
  END;
END
$chk$;
-- Expect the NOTICE 'train44 verify: 1014 guard refuses a malformed key (22023)' and no error.

-- 4. The apply wrote no row: no purge record, no monitor alert from the new rules.
SELECT (SELECT count(*) FROM public.rag_purge_audit WHERE pg_catalog.cardinality(image_url_sha256) > 0) AS purge_records_with_hashes,
       (SELECT count(*) FROM public.rag_monitor_alerts WHERE kind IN ('source_sync', 'stale_index_drop')) AS new_kind_alerts,
       (SELECT count(*) FROM public.rag_retrieval_log WHERE stale_index_drop IS NOT NULL) AS log_rows_with_recheck_counts;
-- Expect 0, 0, 0: the apply writes no purge record, no alert and no log row.

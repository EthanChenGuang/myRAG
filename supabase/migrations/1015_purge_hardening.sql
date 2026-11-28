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

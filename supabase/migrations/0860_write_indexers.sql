-- 0860: Phase 4.2 write-time indexers (RET-12, RET-15, D-15, D-28, D-45, D-56). Builds on 0852 (rag_table_rows) and 0854 (identifier columns).
-- Functions (service_role only, SECURITY INVOKER, empty search_path, tenant asserted first and named in every predicate; values travel in
-- one jsonb argument and no SQL text is built from them):
--   rag_index_document_chunks     keyset page of one document's chunks of every chunking profile (id order): what the indexer parses
--   rag_write_chunk_identifiers   identifiers_raw / identifiers_norm of a batch of that document's chunks, then the document union (the
--                                 chunks' arrays in profile, chunk and array order, de-duplicated by normalized form), written only when
--                                 it changed. The 0603 semantic-cache trigger compares is_current, status, version and tenant_key only,
--                                 so writing the union never flushes a tenant's cache.
--   rag_write_table_rows          replaces the rows of one document and chunking profile; version, is_current and status come from the
--                                 document, and every chunk id must be a chunk of that document, tenant and profile
--   rag_index_backfill_documents  keyset listing of the tenant's ready, non-provisional documents that are current or superseded, for the
--                                 rag:table-rows and rag:identifiers backfills (kind identifiers: only documents with an unindexed chunk)
-- Caps (ERRCODE 22023 above them): 1000 chunks or rows per call; 256 identifiers per chunk of at most 200 characters; 2048 identifiers on
-- the document; 32 columns per table row, 512 characters per cell or header name; page sizes 1..1000.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $write_indexers_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_table_rows') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'identifiers_norm' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0860: apply migrations 0852 and 0854 first' USING ERRCODE = '55000';
  END IF;
END
$write_indexers_precheck$;

CREATE OR REPLACE FUNCTION public.rag_index_document_chunks(p_tenant_key text, p_document_id uuid, p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, chunking_profile_id text, chunk_index integer, section_path text[], content text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'document id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'limit must be within 1..1000' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.id, c.chunking_profile_id, COALESCE(c.chunk_index, 0)::integer, COALESCE(c.section_path, '{}'::text[]), COALESCE(c.content, '')
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
  WHERE c.document_id = p_document_id
    AND c.tenant_key = p_tenant_key
    AND (p_after IS NULL OR c.id > p_after)
  ORDER BY c.id
  LIMIT p_limit;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_write_chunk_identifiers(p_tenant_key text, p_document_id uuid, p_rows jsonb)
RETURNS TABLE (chunks_written integer, document_changed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_written integer := 0;
  v_raw text[];
  v_norm text[];
  v_changed integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 rows per call' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) r
    WHERE pg_catalog.jsonb_typeof(r) <> 'object'
       OR COALESCE(r ->> 'chunk_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR pg_catalog.jsonb_typeof(r -> 'raw') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(r -> 'norm') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(r -> 'raw') <> pg_catalog.jsonb_array_length(r -> 'norm')
       OR pg_catalog.jsonb_array_length(r -> 'norm') > 256
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements((r -> 'raw') || (r -> 'norm')) v
         WHERE pg_catalog.jsonb_typeof(v) <> 'string' OR pg_catalog.length(v #>> '{}') NOT BETWEEN 1 AND 200
       )
  ) THEN
    RAISE EXCEPTION 'each row needs a chunk id and equal raw and norm string arrays (at most 256 of 1..200 characters)' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'tenant_mismatch: document not found in tenant' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.document_chunks c
      WHERE c.id = (r ->> 'chunk_id')::uuid AND c.document_id = p_document_id AND c.tenant_key = p_tenant_key
    )
  ) THEN
    RAISE EXCEPTION 'tenant_mismatch: chunk not in document' USING ERRCODE = '42501';
  END IF;

  UPDATE public.document_chunks c
     SET identifiers_raw = i.raw, identifiers_norm = i.norm
    FROM (
      SELECT DISTINCT ON ((r ->> 'chunk_id')::uuid)
             (r ->> 'chunk_id')::uuid AS id,
             ARRAY(SELECT pg_catalog.jsonb_array_elements_text(r -> 'raw')) AS raw,
             ARRAY(SELECT pg_catalog.jsonb_array_elements_text(r -> 'norm')) AS norm
      FROM pg_catalog.jsonb_array_elements(p_rows) r
      ORDER BY (r ->> 'chunk_id')::uuid
    ) i
   WHERE c.id = i.id
     AND c.document_id = p_document_id
     AND c.tenant_key = p_tenant_key
     AND (c.identifiers_raw IS DISTINCT FROM i.raw OR c.identifiers_norm IS DISTINCT FROM i.norm);
  GET DIAGNOSTICS v_written = ROW_COUNT;

  SELECT COALESCE(pg_catalog.array_agg(u.raw ORDER BY u.ord), '{}'::text[]), COALESCE(pg_catalog.array_agg(u.norm ORDER BY u.ord), '{}'::text[])
    INTO v_raw, v_norm
  FROM (
    SELECT f.norm, f.raw, f.ord
    FROM (
      SELECT DISTINCT ON (e.norm) e.norm, e.raw, e.ord
      FROM (
        SELECT n.norm, c.identifiers_raw[n.pos] AS raw,
               pg_catalog.row_number() OVER (ORDER BY (c.chunking_profile_id <> 'legacy'), c.chunking_profile_id, c.chunk_index, c.id, n.pos) AS ord
        FROM public.document_chunks c
        CROSS JOIN LATERAL pg_catalog.unnest(c.identifiers_norm) WITH ORDINALITY AS n(norm, pos)
        WHERE c.document_id = p_document_id
          AND c.tenant_key = p_tenant_key
          AND c.identifiers_norm IS NOT NULL
      ) e
      ORDER BY e.norm, e.ord
    ) f
    ORDER BY f.ord
    LIMIT 2048
  ) u;

  UPDATE public.documents d
     SET identifiers_raw = v_raw, identifiers_norm = v_norm
   WHERE d.id = p_document_id
     AND d.tenant_key = p_tenant_key
     AND (d.identifiers_raw IS DISTINCT FROM v_raw OR d.identifiers_norm IS DISTINCT FROM v_norm);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  RETURN QUERY SELECT v_written, v_changed > 0;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_write_table_rows(p_tenant_key text, p_document_id uuid, p_chunking_profile_id text, p_rows jsonb)
RETURNS TABLE (rows_written integer, rows_deleted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_version integer;
  v_is_current boolean;
  v_status text;
  v_written integer := 0;
  v_deleted integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_chunking_profile_id IS NULL OR pg_catalog.length(p_chunking_profile_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'chunking profile id is required (1..128 characters)' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 rows per call' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) r
    WHERE pg_catalog.jsonb_typeof(r) <> 'object'
       OR pg_catalog.jsonb_typeof(r -> 'table_key') IS DISTINCT FROM 'string'
       OR pg_catalog.length(r ->> 'table_key') NOT BETWEEN 1 AND 200
       OR pg_catalog.jsonb_typeof(r -> 'row_index') IS DISTINCT FROM 'number'
       OR (r ->> 'row_index') !~ '^[0-9]{1,9}$'
       OR pg_catalog.jsonb_typeof(r -> 'header') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(r -> 'header') > 32
       OR pg_catalog.jsonb_typeof(r -> 'cells') IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(r -> 'cell_tokens') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(r -> 'cell_tokens') <> pg_catalog.jsonb_array_length(r -> 'header')
       OR pg_catalog.jsonb_typeof(r -> 'cell_norm') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(r -> 'chunk_ids') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(r -> 'chunk_ids') NOT BETWEEN 1 AND 16
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(r -> 'header') h
         WHERE pg_catalog.jsonb_typeof(h) <> 'string' OR pg_catalog.length(h #>> '{}') > 512
       )
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(r -> 'cells')) > 32
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_each(r -> 'cells') e
         WHERE pg_catalog.jsonb_typeof(e.value) <> 'string' OR pg_catalog.length(e.value #>> '{}') > 512
       )
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(r -> 'cell_tokens') t
         WHERE pg_catalog.jsonb_typeof(t) <> 'array'
            OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(t) x WHERE pg_catalog.jsonb_typeof(x) <> 'string')
       )
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(r -> 'cell_norm') x WHERE pg_catalog.jsonb_typeof(x) <> 'string')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements_text(r -> 'chunk_ids') k
         WHERE k !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       )
  ) THEN
    RAISE EXCEPTION 'each row needs table_key, row_index, header, cells, cell_tokens, cell_norm and chunk_ids within the caps' USING ERRCODE = '22023';
  END IF;

  SELECT d.version, d.is_current, d.status INTO v_version, v_is_current, v_status
  FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch: document not found in tenant' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) r
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(r -> 'chunk_ids') k
    WHERE NOT EXISTS (
      SELECT 1 FROM public.document_chunks c
      WHERE c.id = k::uuid
        AND c.document_id = p_document_id
        AND c.tenant_key = p_tenant_key
        AND c.chunking_profile_id = p_chunking_profile_id
    )
  ) THEN
    RAISE EXCEPTION 'tenant_mismatch: chunk not in document and profile' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.rag_table_rows t
   WHERE t.document_id = p_document_id
     AND t.tenant_key = p_tenant_key
     AND t.chunking_profile_id = p_chunking_profile_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.rag_table_rows
    (tenant_key, document_id, version, is_current, status, chunking_profile_id, table_key, row_index, header, cells, cell_norm, cell_tokens, chunk_ids)
  SELECT p_tenant_key, p_document_id, COALESCE(v_version, 1), COALESCE(v_is_current, false), COALESCE(v_status, 'processing'), p_chunking_profile_id,
         r ->> 'table_key',
         (r ->> 'row_index')::integer,
         ARRAY(SELECT pg_catalog.jsonb_array_elements_text(r -> 'header')),
         r -> 'cells',
         ARRAY(SELECT pg_catalog.jsonb_array_elements_text(r -> 'cell_norm')),
         r -> 'cell_tokens',
         ARRAY(SELECT DISTINCT k::uuid FROM pg_catalog.jsonb_array_elements_text(r -> 'chunk_ids') k)
  FROM pg_catalog.jsonb_array_elements(p_rows) r;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  RETURN QUERY SELECT v_written, v_deleted;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_index_backfill_documents(p_tenant_key text, p_kind text, p_after uuid, p_limit integer)
RETURNS TABLE (document_id uuid, version integer, is_current boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_kind IS NULL OR p_kind NOT IN ('tables', 'identifiers') THEN
    RAISE EXCEPTION 'kind must be tables or identifiers' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'limit must be within 1..1000' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT d.id, d.version, d.is_current
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.status = 'ready'
    AND NOT d.provisional
    AND (d.is_current OR d.superseded_by IS NOT NULL)
    AND (p_after IS NULL OR d.id > p_after)
    AND (
      p_kind = 'tables'
      OR EXISTS (
        SELECT 1 FROM public.document_chunks c
        WHERE c.document_id = d.id AND c.tenant_key = p_tenant_key AND c.identifiers_norm IS NULL
      )
    )
  ORDER BY d.id
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_index_document_chunks(text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_write_chunk_identifiers(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_write_table_rows(text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_index_backfill_documents(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_index_document_chunks(text, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_write_chunk_identifiers(text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_write_table_rows(text, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_index_backfill_documents(text, text, uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- 0861: rag_table_lookup, the deterministic row lookup over rag_table_rows (RET-12, D-16, D-45, D-56).
-- rag_table_lookup(p_tenant_key, p_tokens, p_min_cells, p_limit, p_version_scope, p_identifiers_norm) returns the caller's table rows in
-- which at least p_min_cells distinct cells match the query tokens. A cell matches when every one of its tokens is among p_tokens (a cell
-- without tokens never matches). The function takes token arrays only, never SQL text; the tenant comes only from p_tenant_key, checked
-- first by rag_assert_tenant_key.
-- A row qualifies only through its chunks: at least one chunk of the row must pass the chunk predicates of hybrid_search_chunks (0856):
-- the caller's tenant, status ready or variant, the effective chunking profile of the chunk's doc type (the active profile, legacy chunks
-- of a document that has no chunks in it yet, and legacy image and invoice-header chunks), and, when p_identifiers_norm is set, an
-- identifiers_norm overlap. Current rows need a current, ready document; under the version scope all or range superseded ready rows of
-- the caller's tenant qualify too (rag_version_history_ok), and a range keeps only versions whose period overlaps it
-- (rag_version_period_ok). Quarantined, pending, deleted and failed versions never qualify. The returned chunk_ids are the row's
-- qualifying chunks only, in chunk order; chunk_id, content and metadata are those of the first of them.
-- Order: matched cells descending, then row index, document id, table key and row id.
-- Caps (ERRCODE 22023): at most 64 tokens, limit 1..50, min_cells 1..10, at most 100 identifiers; a malformed version scope raises 22023
-- as in 0856. SECURITY INVOKER with an empty search_path; service_role only. Reads existing tables only (no new store, so no purge hook).
-- Idempotent; not folded into the setup files.

BEGIN;

DO $table_lookup_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_table_rows') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_version_history_ok(uuid,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_version_period_ok(uuid,text,date,date)') IS NULL THEN
    RAISE EXCEPTION '0861: apply migrations 0401, 0852 and 0856 first' USING ERRCODE = '55000';
  END IF;
END
$table_lookup_precheck$;

CREATE OR REPLACE FUNCTION public.rag_table_lookup(
  p_tenant_key text,
  p_tokens text[],
  p_min_cells integer,
  p_limit integer,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL
)
RETURNS TABLE (
  row_id uuid,
  document_id uuid,
  table_key text,
  row_index integer,
  header text[],
  cells jsonb,
  matched_cells integer,
  chunk_ids uuid[],
  chunk_id uuid,
  content text,
  metadata jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_tokens text[];
  v_scope_mode text := 'current';
  v_widen boolean;
  v_range boolean;
  v_range_from date;
  v_range_to date;
  v_part text;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'rag_table_lookup: limit must be within 1..50' USING ERRCODE = '22023';
  END IF;
  IF p_min_cells IS NULL OR p_min_cells < 1 OR p_min_cells > 10 THEN
    RAISE EXCEPTION 'rag_table_lookup: min_cells must be within 1..10' USING ERRCODE = '22023';
  END IF;
  IF p_tokens IS NOT NULL AND pg_catalog.cardinality(p_tokens) > 64 THEN
    RAISE EXCEPTION 'rag_table_lookup: at most 64 tokens' USING ERRCODE = '22023';
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'rag_table_lookup: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_widen := v_scope_mode IN ('all', 'range');
  v_range := v_scope_mode = 'range';

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT t), ARRAY[]::text[]) INTO v_tokens
  FROM (
    SELECT pg_catalog.btrim(raw) AS t FROM pg_catalog.unnest(COALESCE(p_tokens, ARRAY[]::text[])) AS u(raw)
    WHERE raw IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(raw)) BETWEEN 1 AND 200
  ) cleaned;
  IF pg_catalog.cardinality(v_tokens) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH eff AS (
    SELECT dt.doc_type,
           COALESCE(
             (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
             'legacy'
           ) AS profile_id
    FROM pg_catalog.unnest(v_doc_types) AS dt(doc_type)
  ),
  candidates AS (
    SELECT r.id, r.document_id, r.table_key, r.row_index, r.header, r.cells, r.chunk_ids,
           (
             SELECT pg_catalog.count(DISTINCT t.cell)::integer
             FROM pg_catalog.jsonb_array_elements(r.cell_tokens) AS t(cell)
             WHERE pg_catalog.jsonb_typeof(t.cell) = 'array'
               AND pg_catalog.jsonb_array_length(t.cell) > 0
               AND NOT EXISTS (
                 SELECT 1 FROM pg_catalog.jsonb_array_elements_text(t.cell) AS x(token) WHERE NOT (x.token = ANY (v_tokens))
               )
           ) AS matched
    FROM public.rag_table_rows r
    WHERE r.tenant_key = p_tenant_key
      AND r.cell_norm OPERATOR(pg_catalog.&&) v_tokens
  ),
  qualified AS (
    SELECT m.id, m.document_id, m.table_key, m.row_index, m.header, m.cells, m.matched,
           (
             SELECT pg_catalog.array_agg(c.id ORDER BY c.chunk_index, c.id)
             FROM public.document_chunks c
             JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
             WHERE c.id = ANY (m.chunk_ids)
               AND c.document_id = m.document_id
               AND c.tenant_key = p_tenant_key
               AND c.status IN ('ready', 'variant')
               AND d.status = 'ready'
               AND (
                 (d.is_current AND c.is_current)
                 OR (v_widen AND NOT c.is_current AND NOT c.provisional AND public.rag_version_history_ok(c.document_id, p_tenant_key))
               )
               AND EXISTS (
                 SELECT 1 FROM eff ep WHERE ep.doc_type = c.doc_type AND (
                   c.chunking_profile_id = ep.profile_id
                   OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy' AND c.chunk_kind IN ('image', 'invoice_header'))
                   OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy'
                       AND NOT EXISTS (
                         SELECT 1 FROM public.document_chunks c2
                         WHERE c2.document_id = c.document_id AND c2.tenant_key = p_tenant_key
                           AND c2.is_current = c.is_current AND c2.chunking_profile_id = ep.profile_id
                       ))
                 )
               )
               AND (p_identifiers_norm IS NULL OR c.identifiers_norm OPERATOR(pg_catalog.&&) p_identifiers_norm)
               AND (NOT v_range OR public.rag_version_period_ok(c.document_id, p_tenant_key, v_range_from, v_range_to))
           ) AS qualified_chunks
    FROM candidates m
    WHERE m.matched >= p_min_cells
  )
  SELECT q.id, q.document_id, q.table_key, q.row_index, q.header, q.cells, q.matched, q.qualified_chunks,
         fc.id, fc.content, fc.metadata
  FROM qualified q
  JOIN public.document_chunks fc ON fc.id = q.qualified_chunks[1] AND fc.tenant_key = p_tenant_key
  WHERE q.qualified_chunks IS NOT NULL
  ORDER BY q.matched DESC, q.row_index, q.document_id, q.table_key, q.id
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_table_lookup(text, text[], integer, integer, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_table_lookup(text, text[], integer, integer, jsonb, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

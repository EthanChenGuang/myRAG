-- 0933: the Phase 3.2 and Phase 4.2 retrieval legs take the access filter, and rag_access_readiness() reports whether every retrieval
-- function can filter (Phase 4.3 plan 11; D-10, D-11, D-30, A-03, A-11, SEC-12).
-- 0930 (plans 04.3-03, 04.3-10), 0931 (04.3-12) and 0932 (rag_bm25_search_chunks, merge train 35) belong to other plans, so this plan's
-- redefinitions live in their own file; 0933 is now the last definition of the functions it redefines. Each is the newest body by name plus p_access_keys text[] and p_access_all boolean, appended
-- with defaults NULL and false, every earlier parameter keeping its name, position and default, with the guard of 0930: no keys while
-- public.rag_access_enforced() (0922) is true raises access_scope_required (42501), an empty key array or one holding NULL raises
-- access_keys_empty (22023). With keys and p_access_all not true, the row and its document must overlap the keys before ORDER BY and LIMIT:
--   hybrid_search_translations (0810): t.access_groups, c.access_groups and d.access_groups (translation row, source chunk and the source
--     chunk's document) are appended to v_filter, the one string the dense and the lexical query share. Both USING lists bind 20 positions
--     in 0810, so p_access_keys is bound at $21 in both and neither list needs padding.
--   rag_table_lookup (0861): the row's own label in the candidate scan, and the label of each qualifying chunk and its document, so a row
--     qualifies only through a chunk the caller may see.
--   rag_identifier_resolve and rag_identifier_candidates (0858): identifiers are taken from visible chunks of visible documents only, so an
--     identifier that occurs only in a restricted document is neither resolved nor suggested.
--   rag_dup_cluster_sources (0862): members are listed from visible chunks of visible documents only, so the other-sources list never
--     names a document the caller cannot see.
-- With no keys each function runs the query of its source file and returns what that returned. Every earlier overload of each is dropped by
-- catalog lookup first, so exactly one exists. Each keeps SECURITY INVOKER and the empty search_path, and is executable by service_role only.
-- rag_access_readiness() (STABLE, SECURITY INVOKER, service_role only) checks the catalog: every required retrieval function
-- (hybrid_search_chunks, rag_fetch_parents, rag_exact_id_documents, match_chunks_by_profile, rag_find_invoices and the mode's legacy search
-- RPC: match_document_chunks in single-tenant, match_documents_by_workspace in multi-tenant) and every optional one that exists
-- (hybrid_search_translations, rag_cache_check, rag_table_lookup, rag_identifier_resolve, rag_identifier_candidates,
-- rag_dup_cluster_sources, rag_bm25_search_chunks) has exactly one overload, both access parameters and the access_scope_required guard,
-- and every labelled table that exists (documents, document_chunks, document_parents required; chunk_translations, rag_table_rows optional)
-- has access_groups. reasons and objects are parallel arrays (reasons[i] is the code for objects[i]): function_missing,
-- function_overloaded, function_missing_access_parameters, function_missing_guard, table_missing, table_missing_column. Phase 7's
-- functions are not checked here (A-14). The deployment mode is read from rag_assert_tenant_key, which accepts s:default only in
-- single-tenant mode.
-- Operator rule (as 0930): after re-running 0810, 0858, 0861, 0862 or a file below them that defines one of these functions, re-run the
-- 0920 block through this file; the old signature then comes back as a second overload, and rag_access_readiness() reports
-- function_overloaded until this file runs again. Idempotent; not folded into the setup files.

BEGIN;

DO $seam_legs_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_access_enforced()') IS NULL
     OR pg_catalog.to_regclass('public.chunk_translations') IS NULL
     OR pg_catalog.to_regclass('public.rag_table_rows') IS NULL
     OR pg_catalog.to_regclass('public.rag_dup_clusters') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.chunk_translations'::regclass AND a.attname = 'access_groups' AND NOT a.attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.rag_table_rows'::regclass AND a.attname = 'access_groups' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0933: apply 0810, 0852, 0853 and the 0920 block through 0930 first (re-run 0921 if a derived store came later)' USING ERRCODE = '55000';
  END IF;
END
$seam_legs_precheck$;

DO $drop_seam_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('hybrid_search_translations', 'rag_table_lookup', 'rag_identifier_resolve', 'rag_identifier_candidates', 'rag_dup_cluster_sources')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_seam_overloads$;

-- hybrid_search_translations: the 0810 body plus the access parameters (bound at $21 in both USING lists).
CREATE OR REPLACE FUNCTION public.hybrid_search_translations(
  p_tenant_key text,
  p_profile_id text,
  p_language text,
  p_query_embedding public.vector,
  p_lexical_tokens text[],
  p_dense_limit integer,
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off',
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL,
  p_include_undated boolean DEFAULT false,
  p_scopes text[] DEFAULT NULL,
  p_scopes_include_untagged boolean DEFAULT false,
  p_effective_on date DEFAULT NULL,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  translation_id uuid,
  translation_language text,
  content text,
  metadata jsonb,
  chunk_index integer,
  translation_similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_restrict boolean;
  v_dims integer;
  v_storage text;
  v_tsq tsquery;
  v_filter text;
  v_date_filter text;
  v_sel text;
  v_vec text;
  v_pgvector text;
  v_key text;
  v_val text;
  v_tag text;
  v_dim text;
  v_scope_region text[];
  v_scope_legal_entity text[];
  v_scope_department text[];
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);

  IF p_language IS NULL OR p_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' THEN
    RAISE EXCEPTION 'hybrid_search_translations: invalid language' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 THEN
    RAISE EXCEPTION 'hybrid_search_translations: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_translations: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_translations: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(p_chunking_override) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_translations: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_tag IN ARRAY p_scopes LOOP
      v_dim := CASE WHEN v_tag IS NULL OR strpos(v_tag, ':') = 0 THEN NULL ELSE split_part(v_tag, ':', 1) END;
      IF v_dim IS NULL OR length(v_tag) <= length(v_dim) + 1 THEN
        RAISE EXCEPTION 'invalid_scope: a tag is dimension:value' USING ERRCODE = '22023';
      ELSIF v_dim = 'region' THEN
        v_scope_region := array_append(v_scope_region, v_tag);
      ELSIF v_dim = 'legal_entity' THEN
        v_scope_legal_entity := array_append(v_scope_legal_entity, v_tag);
      ELSIF v_dim = 'department' THEN
        v_scope_department := array_append(v_scope_department, v_tag);
      ELSE
        RAISE EXCEPTION 'invalid_scope: unknown dimension' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR public.vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp._hybrid_tr_eff_profile (doc_type text PRIMARY KEY, profile_id text) ON COMMIT DROP;
  DELETE FROM pg_temp._hybrid_tr_eff_profile;
  INSERT INTO pg_temp._hybrid_tr_eff_profile (doc_type, profile_id)
  SELECT dt.doc_type,
         COALESCE(
           NULLIF(trim(both FROM p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         )
  FROM unnest(v_doc_types) AS dt(doc_type);

  IF COALESCE(p_include_undated, false) THEN
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3 OR c.doc_date IS NULL)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4 OR c.doc_date IS NULL)';
  ELSE
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4)';
  END IF;

  v_filter :=
    ' t.tenant_key = $2 AND t.language = $14 AND c.tenant_key = $2 AND d.tenant_key = $2'
    || ' AND c.is_current AND c.status IN (''ready'', ''variant'') AND d.is_current AND d.status = ''ready'''
    || ' AND EXISTS (SELECT 1 FROM pg_temp._hybrid_tr_eff_profile ep WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM public.document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || v_date_filter
    || ' AND ($5::text[] IS NULL OR (cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8) OR (c.language = ''und'' AND d.language = ANY($8)))'
    || ' AND ($9::text IS NULL OR strpos(lower(d.supplier_name), lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  IF v_scope_region IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $16::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''region:'')))) ';
  END IF;
  IF v_scope_legal_entity IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $17::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''legal_entity:'')))) ';
  END IF;
  IF v_scope_department IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $18::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''department:'')))) ';
  END IF;
  IF p_effective_on IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.effective_from IS NULL OR c.effective_from <= $20::date)'
      || ' AND (c.effective_to IS NULL OR c.effective_to >= $20::date) ';
  END IF;

  IF v_restrict THEN
    v_filter := v_filter || ' AND t.access_groups && $21::text[] AND c.access_groups && $21::text[] AND d.access_groups && $21::text[] ';
  END IF;

  v_sel :=
    ' c.id, c.document_id, t.id, t.language, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200) ';

  IF p_dense_limit > 0 THEN
    v_vec := format('(e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)', v_dims);
    PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
    IF p_iterative_scan <> 'off' THEN
      SELECT extversion INTO v_pgvector FROM pg_catalog.pg_extension WHERE extname = 'vector';
      IF v_pgvector IS NULL OR (string_to_array(v_pgvector, '.'))[1:2]::int[] < ARRAY[0, 8] THEN
        RAISE EXCEPTION 'iterative_scan_unsupported' USING ERRCODE = '22023';
      END IF;
      PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);
    END IF;

    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT t.id AS tid, ' || v_vec || ' AS dist'
      || format(
        ' FROM public.chunk_translation_embeddings e JOIN public.chunk_translations t ON t.id = e.translation_id AND e.profile_id = %L'
        || ' AND e.tenant_key = $2',
        p_profile_id
      )
      || ' JOIN public.document_chunks c ON c.id = t.chunk_id JOIN public.documents d ON d.id = c.document_id WHERE ' || v_filter
      || ' ORDER BY ' || v_vec || ' LIMIT $13) '
      || ', top AS (SELECT tid, dist, (row_number() OVER (ORDER BY dist + 0, tid))::integer AS rnk FROM hits ORDER BY dist + 0, tid LIMIT $13) '
      || 'SELECT ''dense''::text, x.rnk, ' || format(v_sel, '(1 - x.dist)::double precision', 'NULL::real')
      || ' FROM top x JOIN public.chunk_translations t ON t.id = x.tid JOIN public.document_chunks c ON c.id = t.chunk_id'
      || ' JOIN public.documents d ON d.id = c.document_id ORDER BY x.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_dense_limit, p_language, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        p_access_keys;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT t.id AS tid, ts_rank_cd(t.lexical_tsv, $1, 1) AS score'
      || ' FROM public.chunk_translations t JOIN public.document_chunks c ON c.id = t.chunk_id'
      || ' JOIN public.documents d ON d.id = c.document_id WHERE ' || v_filter
      || ' AND t.lexical_tsv @@ $1 ORDER BY score DESC, t.id LIMIT $13) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY x.score DESC, x.tid))::integer, '
      || format(v_sel, 'NULL::double precision', 'x.score::real')
      || ' FROM hits x JOIN public.chunk_translations t ON t.id = x.tid JOIN public.document_chunks c ON c.id = t.chunk_id'
      || ' JOIN public.documents d ON d.id = c.document_id ORDER BY x.score DESC, x.tid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_language, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        p_access_keys;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_translations(
  text, text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text,
  text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, text[], boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_translations(
  text, text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text,
  text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, text[], boolean
) TO service_role;

-- rag_table_lookup: the 0861 body plus the access parameters (row label, and each qualifying chunk and its document).
CREATE OR REPLACE FUNCTION public.rag_table_lookup(
  p_tenant_key text,
  p_tokens text[],
  p_min_cells integer,
  p_limit integer,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
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
  v_restrict boolean;
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
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);

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
      AND (NOT v_restrict OR r.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
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
               AND (NOT v_restrict OR (c.access_groups OPERATOR(pg_catalog.&&) p_access_keys AND d.access_groups OPERATOR(pg_catalog.&&) p_access_keys))
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

REVOKE ALL ON FUNCTION public.rag_table_lookup(text, text[], integer, integer, jsonb, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_table_lookup(text, text[], integer, integer, jsonb, text[], text[], boolean) TO service_role;

-- rag_identifier_resolve and rag_identifier_candidates: the 0858 bodies plus the access parameters (visible chunks of visible documents).
CREATE OR REPLACE FUNCTION public.rag_identifier_resolve(
  p_tenant_key text,
  p_norm text[],
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (norm text, raw text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_restrict boolean;
  v_norms text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  IF COALESCE(pg_catalog.cardinality(p_norm), 0) > 16 THEN
    RAISE EXCEPTION 'too_many_identifiers' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT n.v), '{}'::text[]) INTO v_norms
  FROM pg_catalog.unnest(COALESCE(p_norm, '{}'::text[])) AS n(v)
  WHERE n.v IS NOT NULL AND pg_catalog.length(n.v) BETWEEN 1 AND 200;
  IF pg_catalog.cardinality(v_norms) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (x.norm) x.norm, COALESCE(x.raw, x.norm)
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
  CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(c.identifiers_norm), pg_catalog.unnest(c.identifiers_raw)) WITH ORDINALITY AS x(norm, raw, ord)
  WHERE c.tenant_key = p_tenant_key
    AND c.is_current
    AND c.status = 'ready'
    AND c.identifiers_norm OPERATOR(pg_catalog.&&) v_norms
    AND (NOT v_restrict OR (c.access_groups OPERATOR(pg_catalog.&&) p_access_keys AND d.access_groups OPERATOR(pg_catalog.&&) p_access_keys))
    AND x.norm = ANY (v_norms)
  ORDER BY x.norm, c.created_at, c.id, x.ord;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_identifier_candidates(
  p_tenant_key text,
  p_norm text,
  p_limit integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (raw text, norm text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_restrict boolean;
  v_cap integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_len integer := pg_catalog.length(p_norm);
  v_prefix text;
  v_suffix text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  IF v_len > 200 THEN
    RAISE EXCEPTION 'invalid_identifier' USING ERRCODE = '22023';
  END IF;
  IF p_norm IS NULL OR v_len < 2 THEN
    RETURN;
  END IF;
  v_prefix := pg_catalog.left(p_norm, 2);
  v_suffix := pg_catalog.right(p_norm, 2);

  RETURN QUERY
  SELECT g.raw, g.norm
  FROM (
    SELECT DISTINCT ON (x.norm) x.norm AS norm, COALESCE(x.raw, x.norm) AS raw
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
    CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(c.identifiers_norm), pg_catalog.unnest(c.identifiers_raw)) WITH ORDINALITY AS x(norm, raw, ord)
    WHERE c.tenant_key = p_tenant_key
      AND c.is_current
      AND c.status = 'ready'
      AND c.identifiers_norm IS NOT NULL
      AND (NOT v_restrict OR (c.access_groups OPERATOR(pg_catalog.&&) p_access_keys AND d.access_groups OPERATOR(pg_catalog.&&) p_access_keys))
      AND x.norm IS NOT NULL
      AND x.norm <> p_norm
      AND pg_catalog.abs(pg_catalog.length(x.norm) - v_len) <= 2
      AND (pg_catalog.left(x.norm, 2) = v_prefix OR pg_catalog.right(x.norm, 2) = v_suffix)
    ORDER BY x.norm, c.created_at, c.id, x.ord
  ) g
  ORDER BY pg_catalog.abs(pg_catalog.length(g.norm) - v_len), g.norm
  LIMIT v_cap;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_identifier_resolve(text, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_resolve(text, text[], text[], boolean) TO service_role;
REVOKE ALL ON FUNCTION public.rag_identifier_candidates(text, text, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_identifier_candidates(text, text, integer, text[], boolean) TO service_role;

-- rag_dup_cluster_sources: the 0862 body plus the access parameters (members from visible chunks of visible documents).
CREATE OR REPLACE FUNCTION public.rag_dup_cluster_sources(
  p_tenant_key text,
  p_cluster_ids uuid[],
  p_limit integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  cluster_id uuid,
  document_id uuid,
  filename text,
  chunk_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_restrict boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 30 THEN
    RAISE EXCEPTION 'rag_dup_cluster_sources: limit must be within 1..30' USING ERRCODE = '22023';
  END IF;
  IF p_cluster_ids IS NULL OR pg_catalog.cardinality(p_cluster_ids) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_cluster_ids) > 50 THEN
    RAISE EXCEPTION 'rag_dup_cluster_sources: at most 50 cluster ids' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT r.cluster_id, r.document_id, r.filename, r.chunk_id
  FROM (
    SELECT m.cluster_id, m.document_id, m.filename, m.chunk_id,
           pg_catalog.row_number() OVER (PARTITION BY m.cluster_id ORDER BY m.filename, m.document_id) AS n
    FROM (
      SELECT DISTINCT ON (c.dup_cluster_id, c.document_id)
             c.dup_cluster_id AS cluster_id, c.document_id, d.filename, c.id AS chunk_id
      FROM public.document_chunks c
      JOIN public.rag_dup_clusters k ON k.id = c.dup_cluster_id AND k.tenant_key = p_tenant_key
      JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
      WHERE c.tenant_key = p_tenant_key
        AND c.dup_cluster_id = ANY (p_cluster_ids)
        AND c.is_current
        AND c.status IN ('ready', 'variant')
        AND NOT c.provisional
        AND d.is_current
        AND d.status = 'ready'
        AND NOT d.provisional
        AND (NOT v_restrict OR (c.access_groups OPERATOR(pg_catalog.&&) p_access_keys AND d.access_groups OPERATOR(pg_catalog.&&) p_access_keys))
      ORDER BY c.dup_cluster_id, c.document_id, c.chunk_index, c.id
    ) m
  ) r
  WHERE r.n <= p_limit
  ORDER BY r.cluster_id, r.n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_dup_cluster_sources(text, uuid[], integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_dup_cluster_sources(text, uuid[], integer, text[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_readiness()
RETURNS TABLE (ready boolean, reasons text[], objects text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_multi boolean;
  v_required text[];
  v_optional constant text[] := ARRAY[
    'hybrid_search_translations', 'rag_cache_check', 'rag_table_lookup', 'rag_identifier_resolve',
    'rag_identifier_candidates', 'rag_dup_cluster_sources', 'rag_bm25_search_chunks'
  ];
  v_required_tables constant text[] := ARRAY['documents', 'document_chunks', 'document_parents'];
  v_optional_tables constant text[] := ARRAY['chunk_translations', 'rag_table_rows'];
  v_name text;
  v_overloads integer;
  v_missing_params integer;
  v_missing_guard integer;
  v_reasons text[] := ARRAY[]::text[];
  v_objects text[] := ARRAY[]::text[];
BEGIN
  BEGIN
    PERFORM public.rag_assert_tenant_key('s:default');
    v_multi := false;
  EXCEPTION WHEN others THEN
    v_multi := true;
  END;
  v_required := ARRAY['hybrid_search_chunks', 'rag_fetch_parents', 'rag_exact_id_documents', 'match_chunks_by_profile', 'rag_find_invoices',
    CASE WHEN v_multi THEN 'match_documents_by_workspace' ELSE 'match_document_chunks' END];

  FOREACH v_name IN ARRAY v_required || v_optional LOOP
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (
             WHERE p.proargnames IS NULL
                OR NOT ('p_access_keys' = ANY (p.proargnames) AND 'p_access_all' = ANY (p.proargnames))
           )::integer,
           pg_catalog.count(*) FILTER (WHERE pg_catalog.strpos(p.prosrc, 'access_scope_required') = 0)::integer
      INTO v_overloads, v_missing_params, v_missing_guard
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_overloads = 0 THEN
      IF v_name = ANY (v_required) THEN
        v_reasons := v_reasons || 'function_missing'::text;
        v_objects := v_objects || v_name;
      END IF;
      CONTINUE;
    END IF;
    IF v_overloads > 1 THEN
      v_reasons := v_reasons || 'function_overloaded'::text;
      v_objects := v_objects || v_name;
    END IF;
    IF v_missing_params > 0 THEN
      v_reasons := v_reasons || 'function_missing_access_parameters'::text;
      v_objects := v_objects || v_name;
    END IF;
    IF v_missing_guard > 0 THEN
      v_reasons := v_reasons || 'function_missing_guard'::text;
      v_objects := v_objects || v_name;
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY v_required_tables || v_optional_tables LOOP
    IF pg_catalog.to_regclass('public.' || v_name) IS NULL THEN
      IF v_name = ANY (v_required_tables) THEN
        v_reasons := v_reasons || 'table_missing'::text;
        v_objects := v_objects || v_name;
      END IF;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_name) AND a.attname = 'access_groups' AND NOT a.attisdropped
    ) THEN
      v_reasons := v_reasons || 'table_missing_column'::text;
      v_objects := v_objects || v_name;
    END IF;
  END LOOP;

  RETURN QUERY SELECT pg_catalog.cardinality(v_reasons) = 0, v_reasons, v_objects;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_readiness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_readiness() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

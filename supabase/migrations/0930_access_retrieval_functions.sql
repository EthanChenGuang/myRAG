-- 0930: the single Phase 4.3 home of every retrieval-function redefinition (D-11, D-12, D-31, A-04, SEC-12).
-- hybrid_search_chunks: the 0856 body (Phase 4.2, the newest definition) gains p_access_keys text[] and p_access_all boolean, appended with
-- defaults NULL and false; every earlier parameter keeps its name, position and default. With no keys the function builds the same SQL text
-- as 0856 and returns what 0856 returned, unless public.rag_access_enforced() (0922) is true: then it raises access_scope_required (42501).
-- An empty key array (or one holding NULL) raises access_keys_empty (22023). With keys and p_access_all not true, the predicate
-- c.access_groups && $24 AND d.access_groups && $24 is appended to v_filter, the one filter string the exact-count probe, the dense query
-- and the lexical query share, so all three apply it before ORDER BY and LIMIT. $24 is one above the highest position the three USING lists
-- bind in 0856 ($23, p_identifiers_norm, in each of them), and p_access_keys is bound at 24 in all three lists, so no list needs padding and
-- no leg compares labels to another argument. p_access_all (admin) is decided when the filter is built and is not bound.
-- Every hybrid_search_chunks overload is dropped by catalog lookup first (the 20-argument 0407/0413, 21-argument 0602, 24-argument 0802 and
-- 26-argument 0856 signatures), so exactly one exists. SECURITY INVOKER, VOLATILE, empty search_path, executable by service_role only.
-- Plan 04.3-10 adds, from their newest bodies and with the same two trailing parameters, guard and predicate: rag_fetch_parents (0413),
-- rag_exact_id_documents (0856, both branches), match_chunks_by_profile (0425, with the bounded-count exact path of D-13) and
-- rag_find_invoices (0425); every earlier overload of each is dropped by catalog lookup and each keeps its security mode. The mode files
-- 0930_access_retrieval_functions.single-tenant.sql and .multi-tenant.sql redefine the legacy search RPC of their mode and guard the unused
-- legacy content functions.
-- Operator rule: after re-running any file below 0920 that defines one of these functions (0306, 0308, 0314, 0316, 0404, 0407, 0413, 0425,
-- 0602, 0802, 0856 or a setup file), re-run the whole ordered sequence through the 0930 block (this file, then the mode file); a re-run of
-- this file repairs that state. 0425 alone stops with 55000 after this file because its precheck names the dropped signatures. Later phases
-- that need another parameter rebase on these bodies. Idempotent; not folded into the setup files.

BEGIN;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'hybrid_search_chunks'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text,
  p_profile_id text,
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
  p_exact_scan_cutoff integer DEFAULT 0,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL,
  p_include_undated boolean DEFAULT false,
  p_scopes text[] DEFAULT NULL,
  p_scopes_include_untagged boolean DEFAULT false,
  p_effective_on date DEFAULT NULL,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text,
  dup_cluster_id uuid,
  is_current boolean,
  document_version integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_storage text;
  v_tsq tsquery;
  v_n integer;
  v_mode text := 'ann';
  v_filter text;
  v_date_filter text;
  v_from text;
  v_vec text;
  v_sel text;
  v_pgvector text;
  v_key text;
  v_val text;
  v_tag text;
  v_dim text;
  v_scope_region text[];
  v_scope_legal_entity text[];
  v_scope_department text[];
  v_scope_mode text := 'current';
  v_range_from date;
  v_range_to date;
  v_part text;
  v_has_eff boolean;
  v_start_d text;
  v_start_s text;
  v_lex_filter text;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter".
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;

  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(p_chunking_override) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
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
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR public.vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  CREATE TEMP TABLE pg_temp._hybrid_eff_profile (doc_type text PRIMARY KEY, profile_id text) ON COMMIT DROP;
  INSERT INTO pg_temp._hybrid_eff_profile (doc_type, profile_id)
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
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM pg_temp._hybrid_eff_profile ep WHERE ep.doc_type = c.doc_type AND ('
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

  IF p_identifiers_norm IS NOT NULL THEN
    v_filter := v_filter || ' AND c.identifiers_norm && $23::text[] ';
  END IF;

  -- D-11, D-12: the caller's keys overlap the chunk's and its document's labels, before every ORDER BY and LIMIT (probe, dense, lexical).
  -- v_filter is one string for the three queries, so $24 is one fixed slot bound to p_access_keys in all three USING lists. p_access_all
  -- (admin) is decided here and never bound. Without keys (switch off) the text is exactly the 0856 text.
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN
    v_filter := v_filter || ' AND c.access_groups && $24::text[]'
      || ' AND d.access_groups && $24::text[] ';
  END IF;

  -- D-12: a range keeps a version whose period overlaps it. Start: effective_from when the column exists and is set, else the creation date
  -- (UTC); end: effective_to, else the successor's start (exclusive), else open. The effective-date columns are probed, so the same body
  -- runs on a database without them.
  IF v_scope_mode = 'range' THEN
    v_has_eff := (
      SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('effective_from', 'effective_to') AND NOT attisdropped
    );
    IF v_has_eff THEN
      v_start_d := 'COALESCE(d.effective_from, (d.created_at AT TIME ZONE ''UTC'')::date)';
      v_start_s := 'COALESCE(s.effective_from, (s.created_at AT TIME ZONE ''UTC'')::date)';
    ELSE
      v_start_d := '(d.created_at AT TIME ZONE ''UTC'')::date';
      v_start_s := '(s.created_at AT TIME ZONE ''UTC'')::date';
    END IF;
    v_filter := v_filter
      || ' AND ($22::date IS NULL OR ' || v_start_d || ' <= $22::date)'
      || ' AND ($21::date IS NULL OR '
      || CASE WHEN v_has_eff THEN '(d.effective_to IS NOT NULL AND d.effective_to >= $21::date) OR (d.effective_to IS NULL AND ' ELSE '(' END
      || 'NOT EXISTS (SELECT 1 FROM public.documents s WHERE s.id = d.superseded_by AND s.tenant_key = $2 AND '
      || v_start_s || ' <= $21::date))) ';
  END IF;

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text, c.dup_cluster_id, c.is_current, d.version ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' public.document_chunks c JOIN public.documents d ON d.id = c.document_id ';
      v_vec := format('c.embedding OPERATOR(public.<=>) $1::public.vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(
        ' public.chunk_embeddings e JOIN public.document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L'
        || ' JOIN public.documents d ON d.id = c.document_id ',
        p_profile_id
      );
      v_vec := format('(e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)', v_dims);
    END IF;

    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*)::int FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $13) s'
        INTO v_n
        USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
          p_supplier, p_amount_min, p_amount_max, p_currency, p_exact_scan_cutoff + 1, p_lexical_languages, p_query_embedding,
          v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, p_access_keys;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;

    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN
        SELECT extversion INTO v_pgvector FROM pg_catalog.pg_extension WHERE extname = 'vector';
        IF v_pgvector IS NULL OR (string_to_array(v_pgvector, '.'))[1:2]::int[] < ARRAY[0, 8] THEN
          RAISE EXCEPTION 'iterative_scan_unsupported' USING ERRCODE = '22023';
        END IF;
        PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);
      END IF;
    END IF;

    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $13) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $13) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_dense_limit, p_lexical_languages, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, p_access_keys;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
    v_lex_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    -- D-40: superseded chunks have no vectors, so only this leg widens. A superseded row is ready, not provisional, of a ready document
    -- of this tenant that is not current, and its content differs from its successor's (a re-publish of the same text is left out).
    IF v_scope_mode IN ('all', 'range') THEN
      v_lex_filter := replace(
        replace(v_lex_filter, ' c.tenant_key = $2 AND c.is_current AND ',
          ' c.tenant_key = $2 AND (c.is_current OR (NOT c.is_current AND NOT c.provisional AND d.tenant_key = $2 AND NOT d.is_current'
          || ' AND d.status = ''ready'' AND NOT d.provisional AND d.superseded_by IS NOT NULL'
          || ' AND EXISTS (SELECT 1 FROM public.documents sd WHERE sd.id = d.superseded_by AND sd.tenant_key = $2'
          || ' AND sd.content_hash IS DISTINCT FROM d.content_hash))) AND '),
        'c2.is_current AND c2.chunking_profile_id', 'c2.is_current = c.is_current AND c2.chunking_profile_id'
      );
    END IF;
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score'
      || ' FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id WHERE ' || v_lex_filter
      || ' AND ($14::text[] IS NULL OR (cardinality($14) > 0 AND (c.language = ANY($14) OR (c.language = ''und'' AND d.language = ANY($14)))))'
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $13) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(
        v_sel,
        CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
          THEN format('(1 - (c.embedding OPERATOR(public.<=>) $15::public.vector(%s)))::double precision', v_dims)
          ELSE 'NULL::double precision' END,
        't.score::real',
        'n/a'
      )
      || ' FROM hits t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, p_access_keys;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(
  text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, jsonb, text[], text[], boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(
  text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, jsonb, text[], text[], boolean
) TO service_role;

-- rag_fetch_parents (D-11, D-12): the 0413 body (newest) plus p_access_keys and p_access_all. The two-argument 0404/0413 signature is dropped
-- first, so exactly one exists. With keys and p_access_all not true, the parent's label and its document's label must overlap the keys, in
-- the same WHERE as the tenant predicate; caller-supplied parent ids of a restricted document return nothing. SECURITY INVOKER.
DO $drop_content_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('rag_fetch_parents', 'rag_exact_id_documents', 'match_chunks_by_profile', 'rag_find_invoices')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_content_overloads$;

CREATE OR REPLACE FUNCTION public.rag_fetch_parents(
  p_tenant_key text,
  p_parent_ids uuid[],
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  version integer,
  is_current boolean,
  chunking_profile_id text,
  section_path text[],
  content text,
  token_count integer,
  parent_index integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
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
  IF coalesce(cardinality(p_parent_ids), 0) > 200 THEN
    RAISE EXCEPTION 'too many parent ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT
    p.id,
    p.document_id,
    p.tenant_key,
    p.version,
    p.is_current,
    p.chunking_profile_id,
    p.section_path,
    p.content,
    p.token_count,
    p.parent_index
  FROM public.document_parents p
  JOIN public.documents d
    ON d.id = p.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
  WHERE p.tenant_key = p_tenant_key
    AND p.is_current
    AND p.id = ANY(p_parent_ids)
    AND (NOT v_restrict OR (p.access_groups && p_access_keys AND d.access_groups && p_access_keys));
END;
$$;

REVOKE ALL ON FUNCTION public.rag_fetch_parents(text, uuid[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fetch_parents(text, uuid[], text[], boolean) TO service_role;


-- rag_exact_id_documents (D-11, D-12): the 0856 body (newest) plus p_access_keys and p_access_all. Both earlier signatures (the 3-argument
-- 0314/0425 one and the 5-argument 0856 one) are dropped above. The first branch checks the chunk's and the joined document's label; the
-- second branch, which reads document_chunks alone, gains a semi-join to public.documents for the document-label recheck, so an identifier
-- that appears only in a restricted document returns nothing to an outsider. SECURITY INVOKER (as 0856).
CREATE OR REPLACE FUNCTION public.rag_exact_id_documents(
  p_tenant_key text,
  p_tokens text[],
  p_limit integer,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (chunk_id uuid, document_id uuid, content text, metadata jsonb, matched_field text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tokens text[];
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_scope_mode text := 'current';
  v_widen boolean;
  v_range boolean;
  v_range_from date;
  v_range_to date;
  v_part text;
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
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'rag_exact_id_documents: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;
  v_widen := v_scope_mode IN ('all', 'range');
  v_range := v_scope_mode = 'range';

  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[]) INTO tokens
  FROM (
    SELECT lower(btrim(raw)) AS t FROM unnest(COALESCE(p_tokens, ARRAY[]::text[])) WITH ORDINALITY AS u(raw, n)
    WHERE n <= 20 AND length(btrim(raw)) BETWEEN 2 AND 100
  ) cleaned;
  IF cardinality(tokens) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT hit.id, hit.document_id, hit.content, hit.metadata, hit.matched_field
  FROM (
    SELECT DISTINCT ON (m.id) m.id, m.document_id, m.content, m.metadata, m.matched_field, m.created_at, m.chunk_index
    FROM (
      SELECT c.id, c.document_id, c.content, c.metadata,
             CASE WHEN lower(d.invoice_number) = ANY (tokens) THEN 'invoice_number' ELSE 'supplier_tax_id' END AS matched_field,
             1 AS priority, c.created_at, c.chunk_index
      FROM public.documents d
      JOIN public.document_chunks c ON c.document_id = d.id
      WHERE d.tenant_key = p_tenant_key AND d.status = 'ready'
        AND c.tenant_key = p_tenant_key AND c.status = 'ready'
        AND ((d.is_current AND c.is_current) OR (v_widen AND NOT c.is_current AND public.rag_version_history_ok(c.document_id, p_tenant_key) AND NOT c.provisional))
        AND c.chunk_kind IN ('invoice_header', 'table')
        AND (lower(d.invoice_number) = ANY (tokens) OR lower(d.supplier_tax_id) = ANY (tokens))
        AND (p_identifiers_norm IS NULL OR c.identifiers_norm && p_identifiers_norm)
        AND (NOT v_restrict OR (c.access_groups && p_access_keys AND d.access_groups && p_access_keys))
        AND (NOT v_range OR public.rag_version_period_ok(c.document_id, p_tenant_key, v_range_from, v_range_to))
      UNION ALL
      SELECT c.id, c.document_id, c.content, c.metadata, 'lexical_text'::text, 2, c.created_at, c.chunk_index
      FROM public.document_chunks c
      WHERE c.tenant_key = p_tenant_key AND c.status = 'ready'
        AND (c.is_current OR (v_widen AND NOT c.provisional AND public.rag_version_history_ok(c.document_id, p_tenant_key)))
        AND c.lexical_text IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(tokens) AS k(token)
          WHERE lower(c.lexical_text) ~ ('(^|[^[:alnum:]_-])' || regexp_replace(k.token, '([][\\.^$|?*+(){}-])', '\\\1', 'g') || '($|[^[:alnum:]_-])')
        )
        AND (p_identifiers_norm IS NULL OR c.identifiers_norm && p_identifiers_norm)
        AND (NOT v_range OR public.rag_version_period_ok(c.document_id, p_tenant_key, v_range_from, v_range_to))
        AND (NOT v_restrict OR (c.access_groups && p_access_keys
          AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = c.document_id AND d.tenant_key = p_tenant_key AND d.access_groups && p_access_keys)))
    ) m
    ORDER BY m.id, m.priority
  ) hit
  ORDER BY (hit.matched_field = 'lexical_text'), hit.created_at, hit.chunk_index, hit.id
  LIMIT cap;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_exact_id_documents(text, text[], integer, jsonb, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_exact_id_documents(text, text[], integer, jsonb, text[], text[], boolean) TO service_role;

-- match_chunks_by_profile (D-11, D-12, D-13, A-09): the 0425 body (newest; earlier 0308) plus p_access_keys and p_access_all; the
-- 7-argument signature is dropped above. Without keys, or with p_access_all, the query text is the 0425 text. With keys and p_access_all not
-- true the query joins public.documents and requires the chunk's and the document's label to overlap the keys, inside the WHERE that holds the
-- profile and tenant predicates, before ORDER BY and LIMIT. Recall for a restricted caller: the rows it can see in the tenant and profile are
-- counted up to 1001; at or below 1000 the dense query is a materialized exact scan (no index order), above it the ANN scan runs with
-- hnsw.iterative_scan = relaxed_order (pgvector 0.8 or newer) and hnsw.ef_search raised as hybrid_search_chunks raises it, and the hits are
-- re-sorted by exact distance. SECURITY DEFINER (as 0425).
CREATE OR REPLACE FUNCTION public.match_chunks_by_profile(
  p_tenant_key text,
  p_profile_id text,
  p_dims integer,
  p_query public.halfvec,
  p_match_count integer,
  p_min_similarity double precision,
  p_require_active boolean DEFAULT true,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_dims integer;
  v_status text;
  v_version text;
  v_restrict boolean;
  v_visible integer;
BEGIN
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);

  SELECT p.dims, p.status INTO v_dims, v_status FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF v_dims IS NULL THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_dims <> p_dims OR public.vector_dims(p_query) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;
  IF p_require_active AND v_status <> 'active' THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: profile not active' USING ERRCODE = '22000';
  END IF;

  SELECT extversion INTO v_version FROM pg_catalog.pg_extension WHERE extname = 'vector';

  IF NOT v_restrict THEN
    IF v_version IS NOT NULL AND (string_to_array(v_version, '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
      PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
    END IF;

    RETURN QUERY EXECUTE format($q$
      SELECT c.id, c.document_id, c.content,
             1 - ((e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)) AS similarity,
             c.metadata
      FROM public.chunk_embeddings e
      JOIN public.document_chunks c ON c.id = e.chunk_id
      WHERE e.profile_id = %2$L
        AND e.tenant_key = $2
        AND c.is_current AND c.status = 'ready'
        AND 1 - ((e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)) > $3
      ORDER BY (e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)
      LIMIT $4
    $q$, v_dims, p_profile_id)
    USING p_query, p_tenant_key, p_min_similarity, p_match_count;
    RETURN;
  END IF;

  EXECUTE format($q$
    SELECT count(*)::integer FROM (
      SELECT 1
      FROM public.chunk_embeddings e
      JOIN public.document_chunks c ON c.id = e.chunk_id
      JOIN public.documents d ON d.id = c.document_id
      WHERE e.profile_id = %1$L
        AND e.tenant_key = $1
        AND c.is_current AND c.status = 'ready'
        AND c.access_groups && $2::text[] AND d.access_groups && $2::text[]
      LIMIT 1001
    ) s
  $q$, p_profile_id)
  INTO v_visible
  USING p_tenant_key, p_access_keys;

  IF v_visible > 1000 THEN
    IF v_version IS NOT NULL AND (string_to_array(v_version, '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
      PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
    END IF;
    PERFORM set_config('hnsw.ef_search', least(greatest(p_match_count * 2, 100), 1000)::text, true);
  END IF;

  RETURN QUERY EXECUTE format($q$
    WITH hits AS MATERIALIZED (
      SELECT c.id AS hid, (e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s) AS dist
      FROM public.chunk_embeddings e
      JOIN public.document_chunks c ON c.id = e.chunk_id
      JOIN public.documents d ON d.id = c.document_id
      WHERE e.profile_id = %2$L
        AND e.tenant_key = $2
        AND c.is_current AND c.status = 'ready'
        AND c.access_groups && $5::text[] AND d.access_groups && $5::text[]
        AND 1 - ((e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)) > $3
      %3$s
    )
    SELECT c.id, c.document_id, c.content, (1 - h.dist)::double precision AS similarity, c.metadata
    FROM hits h
    JOIN public.document_chunks c ON c.id = h.hid
    ORDER BY h.dist + 0, h.hid
    LIMIT $4
  $q$, v_dims, p_profile_id,
    CASE WHEN v_visible > 1000
      THEN format('ORDER BY (e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s) LIMIT $4', v_dims)
      ELSE '' END)
  USING p_query, p_tenant_key, p_min_similarity, p_match_count, p_access_keys;
END
$function$;

REVOKE ALL ON FUNCTION public.match_chunks_by_profile(text, text, integer, public.halfvec, integer, double precision, boolean, text[], boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_chunks_by_profile(text, text, integer, public.halfvec, integer, double precision, boolean, text[], boolean)
  TO service_role;

-- rag_find_invoices (D-11): the 0425 body (newest; earlier 0314) plus p_access_keys and p_access_all; the 8-argument signature is dropped
-- above. It returns document rows, so the document's own label is the checked label, in the same WHERE as the tenant predicate, before ORDER
-- BY and LIMIT. SECURITY DEFINER (as 0425).
CREATE OR REPLACE FUNCTION public.rag_find_invoices(
  p_tenant_key text,
  p_supplier text,
  p_date_from date,
  p_date_to date,
  p_amount_min numeric,
  p_amount_max numeric,
  p_currency text,
  p_limit integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE(document_id uuid, filename text, invoice_number text, supplier_name text, supplier_tax_id text, issue_date date, gross_total text, currency text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_column
DECLARE
  needle text := lower(btrim(COALESCE(p_supplier, '')));
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_restrict boolean;
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  RETURN QUERY
  SELECT d.id, d.filename, d.invoice_number, d.supplier_name, d.supplier_tax_id, d.issue_date, d.gross_total::text, d.currency
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type = 'invoice_receipt'
    AND (needle = '' OR position(needle IN lower(COALESCE(d.supplier_name, ''))) > 0 OR lower(COALESCE(d.supplier_tax_id, '')) = needle)
    AND (p_date_from IS NULL OR d.issue_date >= p_date_from)
    AND (p_date_to IS NULL OR d.issue_date <= p_date_to)
    AND (p_amount_min IS NULL OR d.gross_total >= p_amount_min)
    AND (p_amount_max IS NULL OR d.gross_total <= p_amount_max)
    AND (p_currency IS NULL OR d.currency = p_currency)
    AND (NOT v_restrict OR d.access_groups && p_access_keys)
  ORDER BY d.issue_date DESC NULLS LAST, d.created_at DESC, d.id
  LIMIT cap;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_find_invoices(text, text, date, date, numeric, numeric, text, integer, text[], boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

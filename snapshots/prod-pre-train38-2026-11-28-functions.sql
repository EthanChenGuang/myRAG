-- PROD (ppvywaxrycaxrtrrditl) function definitions before train 38, read-only snapshot taken 2026-11-28T08:07:14.933169+00:00.
-- Restore path only: overloads created by trains 38-41 must be dropped first.

-- get_documents_by_type_slug_workspace(uuid,uuid,text,text)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug_workspace(p_org_id uuid, p_user_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, user_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, true as is_tenant
    FROM public.documents d
    WHERE p_org_id IS NOT NULL
      AND d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  UNION ALL
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, false as is_tenant
    FROM public.documents d
    WHERE p_org_id IS NULL
      AND d.organization_id IS NULL
      AND d.user_id = p_user_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  LIMIT 10;
$function$
;

-- get_documents_by_type_slug(uuid,text,text)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug(p_org_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH tenant_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, true as is_tenant
    FROM public.documents d
    WHERE d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
    ORDER BY d.created_at DESC
  ),
  global_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, false as is_tenant
    FROM public.documents d
    WHERE d.organization_id IS NULL
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
      AND NOT EXISTS (SELECT 1 FROM tenant_docs)
    ORDER BY d.created_at DESC
  )
  SELECT * FROM tenant_docs
  UNION ALL
  SELECT * FROM global_docs
  LIMIT 10;
$function$
;

-- hybrid_search_chunks(text,text,vector,text[],integer,integer,date,date,text[],uuid[],text[],text[],text,integer,text[],text,numeric,numeric,text,jsonb,boolean,text[],boolean,date,jsonb,text[],text[],boolean)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(p_tenant_key text, p_profile_id text, p_query_embedding vector, p_lexical_tokens text[], p_dense_limit integer, p_lexical_limit integer, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_sources text[] DEFAULT NULL::text[], p_document_ids uuid[] DEFAULT NULL::uuid[], p_doc_types text[] DEFAULT NULL::text[], p_languages text[] DEFAULT NULL::text[], p_iterative_scan text DEFAULT 'off'::text, p_exact_scan_cutoff integer DEFAULT 0, p_lexical_languages text[] DEFAULT NULL::text[], p_supplier text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_currency text DEFAULT NULL::text, p_chunking_override jsonb DEFAULT NULL::jsonb, p_include_undated boolean DEFAULT false, p_scopes text[] DEFAULT NULL::text[], p_scopes_include_untagged boolean DEFAULT false, p_effective_on date DEFAULT NULL::date, p_version_scope jsonb DEFAULT NULL::jsonb, p_identifiers_norm text[] DEFAULT NULL::text[], p_access_keys text[] DEFAULT NULL::text[], p_access_all boolean DEFAULT false)
 RETURNS TABLE(leg text, rank integer, chunk_id uuid, document_id uuid, content text, metadata jsonb, chunk_index integer, similarity double precision, lexical_score real, doc_type text, language text, parent_id uuid, section_path text[], chunk_kind text, document_filename text, document_created_at timestamp with time zone, document_metadata jsonb, document_content_preview text, dense_mode text, dup_cluster_id uuid, is_current boolean, document_version integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;

-- hybrid_search_translations(text,text,text,vector,text[],integer,integer,date,date,text[],uuid[],text[],text[],text,text,numeric,numeric,text,jsonb,boolean,text[],boolean,date)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.hybrid_search_translations(p_tenant_key text, p_profile_id text, p_language text, p_query_embedding vector, p_lexical_tokens text[], p_dense_limit integer, p_lexical_limit integer, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_sources text[] DEFAULT NULL::text[], p_document_ids uuid[] DEFAULT NULL::uuid[], p_doc_types text[] DEFAULT NULL::text[], p_languages text[] DEFAULT NULL::text[], p_iterative_scan text DEFAULT 'off'::text, p_supplier text DEFAULT NULL::text, p_amount_min numeric DEFAULT NULL::numeric, p_amount_max numeric DEFAULT NULL::numeric, p_currency text DEFAULT NULL::text, p_chunking_override jsonb DEFAULT NULL::jsonb, p_include_undated boolean DEFAULT false, p_scopes text[] DEFAULT NULL::text[], p_scopes_include_untagged boolean DEFAULT false, p_effective_on date DEFAULT NULL::date)
 RETURNS TABLE(leg text, rank integer, chunk_id uuid, document_id uuid, translation_id uuid, translation_language text, content text, metadata jsonb, chunk_index integer, translation_similarity double precision, lexical_score real, doc_type text, language text, parent_id uuid, section_path text[], chunk_kind text, document_filename text, document_created_at timestamp with time zone, document_metadata jsonb, document_content_preview text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
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
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on;
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
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on;
  END IF;
END
$function$
;

-- match_chunks_by_profile(text,text,integer,halfvec,integer,double precision,boolean)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.match_chunks_by_profile(p_tenant_key text, p_profile_id text, p_dims integer, p_query halfvec, p_match_count integer, p_min_similarity double precision, p_require_active boolean DEFAULT true)
 RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dims integer;
  v_status text;
  v_version text;
BEGIN
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
END
$function$
;

-- match_document_chunks_by_org(uuid,vector,integer,double precision)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.match_document_chunks_by_org(p_org_id uuid, p_query_embedding vector, p_match_count integer DEFAULT 8, p_min_similarity double precision DEFAULT 0.2)
 RETURNS TABLE(document_id uuid, chunk_id uuid, content text, similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    dc.document_id,
    dc.id as chunk_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity
  FROM public.document_chunks dc
  WHERE (dc.organization_id = p_org_id OR dc.organization_id IS NULL)
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) >= p_min_similarity
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT p_match_count;
END;
$function$
;

-- match_document_chunks(vector,integer,double precision)  acl={=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.match_document_chunks(query_embedding vector, match_count integer, similarity_threshold double precision)
 RETURNS TABLE(chunk_id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  current_user_id UUID;
  current_org_id UUID;
BEGIN
  -- Get current user ID
  current_user_id := auth.uid();
  
  -- Get user's current organization if in multi-tenant mode
  SELECT current_organization_id INTO current_org_id
  FROM user_preferences
  WHERE user_id = current_user_id;
  
  -- Return chunks based on organization context
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity,
    dc.metadata
  FROM document_chunks dc
  INNER JOIN documents d ON dc.document_id = d.id
  WHERE dc.embedding IS NOT NULL 
    AND 1 - (dc.embedding <=> query_embedding) > similarity_threshold
    AND dc.is_current AND dc.status = 'ready'
    AND (
      -- Personal workspace: match null org_id docs
      (current_org_id IS NULL AND dc.organization_id IS NULL)
      OR
      -- Organization workspace: match org docs OR personal docs owned by user
      (current_org_id IS NOT NULL AND (
        dc.organization_id = current_org_id
        OR (dc.organization_id IS NULL AND d.user_id = current_user_id)
      ))
    )
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$function$
;

-- match_documents_by_organization(vector,double precision,integer,uuid)  acl={=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.match_documents_by_organization(query_embedding vector, match_threshold double precision, match_count integer, org_id uuid)
 RETURNS TABLE(id uuid, document_id uuid, chunk_index integer, content text, metadata jsonb, similarity double precision)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.metadata,
    1 - (dc.embedding <=> query_embedding) as similarity
  FROM document_chunks dc
  WHERE dc.organization_id = org_id
    AND 1 - (dc.embedding <=> query_embedding) > match_threshold
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$
;

-- match_documents_by_workspace(vector,integer,double precision,uuid,uuid)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(p_query_embedding vector, p_match_count integer, p_min_similarity double precision, p_org_id uuid, p_user_id uuid)
 RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity,
    dc.metadata
  FROM public.document_chunks dc
  INNER JOIN public.documents d ON d.id = dc.document_id
  WHERE dc.embedding IS NOT NULL
    AND dc.is_current AND dc.status = 'ready'
    AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
    AND (
      -- Personal workspace: user owns document and no organization
      (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
      OR
      -- Team workspace: document belongs to organization
      (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
    )
  ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT p_match_count;
END;
$function$
;

-- rag_attribute_documents(text,jsonb,integer)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_attribute_documents(p_tenant_key text, p_filters jsonb, p_limit integer)
 RETURNS TABLE(document_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  entry record;
  item record;
  v_type text;
  v_keys integer := 0;
  v_values integer;
  v_patterns jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_filters IS NULL OR pg_catalog.jsonb_typeof(p_filters) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR entry IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_filters) AS e(key, value) ORDER BY e.key COLLATE "C" LOOP
    v_keys := v_keys + 1;
    IF v_keys > 30 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.jsonb_typeof(entry.value) <> 'array' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    v_values := pg_catalog.jsonb_array_length(entry.value);
    IF v_values = 0 OR v_values > 50 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    FOR item IN SELECT i.value FROM pg_catalog.jsonb_array_elements(entry.value) AS i(value) LOOP
      IF pg_catalog.jsonb_typeof(item.value) <> 'string'
         OR pg_catalog.char_length(item.value #>> '{}') NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;
  IF v_keys = 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR entry IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_filters) AS e(key, value) ORDER BY e.key COLLATE "C" LOOP
    v_type := NULL;
    SELECT def.type INTO v_type
    FROM public.rag_attribute_definitions def
    WHERE def.tenant_key = p_tenant_key AND def.key = entry.key AND def.filterable;
    IF v_type IS NULL THEN
      RAISE EXCEPTION 'unknown_attribute' USING ERRCODE = '22023';
    END IF;
    FOR item IN SELECT DISTINCT i.value FROM pg_catalog.jsonb_array_elements(entry.value) AS i(value) LOOP
      v_patterns := v_patterns || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'key', entry.key,
        'pattern', pg_catalog.jsonb_build_object(
          entry.key,
          CASE WHEN v_type = 'text_list' THEN pg_catalog.jsonb_build_array(item.value) ELSE item.value END
        )
      ));
    END LOOP;
  END LOOP;

  RETURN QUERY
  SELECT hit.id
  FROM (
    SELECT DISTINCT probe.value ->> 'key' AS key, d.id
    FROM pg_catalog.jsonb_array_elements(v_patterns) AS probe(value)
    JOIN public.documents d
      ON d.tenant_key = p_tenant_key AND d.status = 'ready' AND d.is_current
     AND d.attributes @> (probe.value -> 'pattern')
  ) hit
  GROUP BY hit.id
  HAVING pg_catalog.count(*) = v_keys
  ORDER BY hit.id
  LIMIT p_limit;
END
$function$
;

-- rag_attribute_filter_values(text,integer)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_attribute_filter_values(p_tenant_key text, p_limit integer)
 RETURNS TABLE(key text, value text, type text, soft boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT v.key, v.value, v.type, v.soft
  FROM (
    SELECT DISTINCT def.key, item.value #>> '{}' AS value, def.type, def.soft
    FROM public.rag_attribute_definitions def
    JOIN public.documents d
      ON d.tenant_key = p_tenant_key AND d.status = 'ready' AND d.is_current
     AND d.attributes IS NOT NULL AND d.attributes ? def.key
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      CASE WHEN pg_catalog.jsonb_typeof(d.attributes -> def.key) = 'array' THEN d.attributes -> def.key
           ELSE pg_catalog.jsonb_build_array(d.attributes -> def.key) END
    ) AS item(value)
    WHERE def.tenant_key = p_tenant_key AND def.filterable
      AND pg_catalog.jsonb_typeof(item.value) = 'string'
  ) v
  ORDER BY v.key COLLATE "C", v.value COLLATE "C"
  LIMIT p_limit;
END
$function$
;

-- rag_dup_cluster_sources(text,uuid[],integer)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_dup_cluster_sources(p_tenant_key text, p_cluster_ids uuid[], p_limit integer)
 RETURNS TABLE(cluster_id uuid, document_id uuid, filename text, chunk_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
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
      ORDER BY c.dup_cluster_id, c.document_id, c.chunk_index, c.id
    ) m
  ) r
  WHERE r.n <= p_limit
  ORDER BY r.cluster_id, r.n;
END
$function$
;

-- rag_enqueue_review_item(text,text,jsonb,jsonb)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_enqueue_review_item(p_tenant_key text, p_reason text, p_source jsonb, p_snapshot jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_snapshot_in jsonb := coalesce(p_snapshot, '{}'::jsonb);
  v_key text;
  v_ids jsonb;
  v_chunks text[] := '{}'::text[];
  v_documents text[] := '{}'::text[];
  v_detector text;
  v_trace text;
  v_found integer;
  v_fingerprint text;
  v_window timestamptz;
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_reason IS NULL OR p_reason NOT IN ('claim_unsupported', 'output_guard', 'version_conflict', 'calc_mismatch', 'calc_unverified') THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR pg_catalog.jsonb_typeof(p_source) <> 'object' THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'p_source must be a JSON object';
  END IF;
  IF pg_catalog.jsonb_typeof(v_snapshot_in) <> 'object' THEN
    RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'p_snapshot must be a JSON object';
  END IF;

  FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(p_source) AS k LOOP
    IF v_key NOT IN ('chunk_ids', 'document_ids') THEN
      RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'p_source takes chunk_ids and document_ids only';
    END IF;
    v_ids := p_source -> v_key;
    IF pg_catalog.jsonb_typeof(v_ids) <> 'array' OR pg_catalog.jsonb_array_length(v_ids) > 50
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_ids) AS e
         WHERE pg_catalog.jsonb_typeof(e) <> 'string' OR pg_catalog.lower(e #>> '{}') !~ v_uuid
       ) THEN
      RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'ids must be at most 50 UUID strings';
    END IF;
  END LOOP;

  SELECT coalesce(pg_catalog.array_agg(x.id ORDER BY x.id COLLATE "C"), '{}'::text[]) INTO v_chunks
  FROM (SELECT DISTINCT pg_catalog.lower(e #>> '{}') AS id FROM pg_catalog.jsonb_array_elements(coalesce(p_source -> 'chunk_ids', '[]'::jsonb)) AS e) AS x;
  SELECT coalesce(pg_catalog.array_agg(x.id ORDER BY x.id COLLATE "C"), '{}'::text[]) INTO v_documents
  FROM (SELECT DISTINCT pg_catalog.lower(e #>> '{}') AS id FROM pg_catalog.jsonb_array_elements(coalesce(p_source -> 'document_ids', '[]'::jsonb)) AS e) AS x;
  IF pg_catalog.cardinality(v_chunks) + pg_catalog.cardinality(v_documents) = 0 THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'at least one chunk or document id is required';
  END IF;

  FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_snapshot_in) AS k LOOP
    IF v_key NOT IN ('detector', 'trace_id') THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'p_snapshot takes detector and trace_id only';
    END IF;
  END LOOP;
  IF v_snapshot_in ? 'detector' THEN
    IF pg_catalog.jsonb_typeof(v_snapshot_in -> 'detector') <> 'string' OR (v_snapshot_in ->> 'detector') !~ '^[a-z][a-z0-9_]{0,31}$' THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'detector must be a short lower-case token';
    END IF;
    v_detector := v_snapshot_in ->> 'detector';
  END IF;
  IF v_snapshot_in ? 'trace_id' THEN
    IF pg_catalog.jsonb_typeof(v_snapshot_in -> 'trace_id') <> 'string' OR (v_snapshot_in ->> 'trace_id') !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'trace_id must be an id token';
    END IF;
    v_trace := v_snapshot_in ->> 'trace_id';
  END IF;

  SELECT count(*) INTO v_found
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.id = ANY (v_chunks::uuid[])
    AND d.tenant_key = p_tenant_key
    AND (c.tenant_key IS NULL OR c.tenant_key = p_tenant_key);
  IF v_found <> pg_catalog.cardinality(v_chunks) THEN
    RAISE EXCEPTION 'source_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every chunk id must be a chunk of the tenant';
  END IF;
  SELECT count(*) INTO v_found FROM public.documents d WHERE d.id = ANY (v_documents::uuid[]) AND d.tenant_key = p_tenant_key;
  IF v_found <> pg_catalog.cardinality(v_documents) THEN
    RAISE EXCEPTION 'source_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every document id must be a document of the tenant';
  END IF;

  IF EXISTS (SELECT 1 FROM public.rag_tenant_feedback_settings s WHERE s.tenant_key = p_tenant_key AND s.retrieval_log = 'off') THEN
    RETURN NULL;
  END IF;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_reason || E'\n' || 'chunks:' || pg_catalog.array_to_string(v_chunks, ',') || E'\n' || 'documents:' || pg_catalog.array_to_string(v_documents, ','),
      'UTF8')),
    'hex');
  v_window := pg_catalog.date_trunc('week', pg_catalog.now(), 'UTC');

  INSERT INTO public.rag_review_items AS i (tenant_key, trace_id, query_masked, query_fingerprint, reasons, snapshot, status, mining_window, mined_at)
  VALUES (
    p_tenant_key, v_trace, '', v_fingerprint, ARRAY[p_reason]::text[],
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'reason', p_reason, 'detector', v_detector, 'trace_id', v_trace,
      'chunk_ids', pg_catalog.to_jsonb(v_chunks), 'document_ids', pg_catalog.to_jsonb(v_documents))),
    'open', v_window, pg_catalog.now()
  )
  ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
  RETURNING i.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT i.id INTO v_id FROM public.rag_review_items i
    WHERE i.tenant_key = p_tenant_key AND i.query_fingerprint = v_fingerprint AND i.mining_window = v_window;
  END IF;
  RETURN v_id;
END
$function$
;

-- rag_exact_id_documents(text,text[],integer,jsonb,text[])  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_exact_id_documents(p_tenant_key text, p_tokens text[], p_limit integer, p_version_scope jsonb DEFAULT NULL::jsonb, p_identifiers_norm text[] DEFAULT NULL::text[])
 RETURNS TABLE(chunk_id uuid, document_id uuid, content text, metadata jsonb, matched_field text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

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
    ) m
    ORDER BY m.id, m.priority
  ) hit
  ORDER BY (hit.matched_field = 'lexical_text'), hit.created_at, hit.chunk_index, hit.id
  LIMIT cap;
END
$function$
;

-- rag_fetch_parents(text,uuid[])  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_fetch_parents(p_tenant_key text, p_parent_ids uuid[])
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, version integer, is_current boolean, chunking_profile_id text, section_path text[], content text, token_count integer, parent_index integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
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
    AND p.id = ANY(p_parent_ids);
END;
$function$
;

-- rag_find_invoices(text,text,date,date,numeric,numeric,text,integer)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_find_invoices(p_tenant_key text, p_supplier text, p_date_from date, p_date_to date, p_amount_min numeric, p_amount_max numeric, p_currency text, p_limit integer)
 RETURNS TABLE(document_id uuid, filename text, invoice_number text, supplier_name text, supplier_tax_id text, issue_date date, gross_total text, currency text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  needle text := lower(btrim(COALESCE(p_supplier, '')));
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
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
  ORDER BY d.issue_date DESC NULLS LAST, d.created_at DESC, d.id
  LIMIT cap;
END
$function$
;

-- rag_guard_ingest_state()  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_guard_ingest_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  old_row jsonb;
  new_row jsonb;
  col text;
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  old_row := pg_catalog.to_jsonb(OLD);
  new_row := pg_catalog.to_jsonb(NEW);
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION 'ingest state column % of %.% cannot be changed by role %', col, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$
;

-- rag_identifier_candidates(text,text,integer)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_identifier_candidates(p_tenant_key text, p_norm text, p_limit integer)
 RETURNS TABLE(raw text, norm text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_cap integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_len integer := pg_catalog.length(p_norm);
  v_prefix text;
  v_suffix text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
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
      AND x.norm IS NOT NULL
      AND x.norm <> p_norm
      AND pg_catalog.abs(pg_catalog.length(x.norm) - v_len) <= 2
      AND (pg_catalog.left(x.norm, 2) = v_prefix OR pg_catalog.right(x.norm, 2) = v_suffix)
    ORDER BY x.norm, c.created_at, c.id, x.ord
  ) g
  ORDER BY pg_catalog.abs(pg_catalog.length(g.norm) - v_len), g.norm
  LIMIT v_cap;
END
$function$
;

-- rag_identifier_resolve(text,text[])  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_identifier_resolve(p_tenant_key text, p_norm text[])
 RETURNS TABLE(norm text, raw text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_norms text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
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
    AND x.norm = ANY (v_norms)
  ORDER BY x.norm, c.created_at, c.id, x.ord;
END
$function$
;

-- rag_mine_failed_queries(timestamp with time zone,timestamp with time zone,jsonb)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_mine_failed_queries(p_since timestamp with time zone, p_until timestamp with time zone, p_config jsonb)
 RETURNS TABLE(tenant_key text, reason text, inserted integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_limit integer;
  v_ttl_days integer;
  v_low_similarity double precision;
  v_low_rerank double precision;
  v_high_similarity double precision;
  v_high_rerank double precision;
  v_source_signal boolean;
  v_window timestamptz;
  v_path text[];
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR p_since >= p_until THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = '22023', DETAIL = 'p_since and p_until are required and p_since must be before p_until';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'p_config must be a JSON object';
  END IF;

  FOREACH v_path SLICE 1 IN ARRAY ARRAY[
    ARRAY['per_tenant_limit', ''],
    ARRAY['open_item_ttl_days', ''],
    ARRAY['low_score_ceiling', 'similarity'],
    ARRAY['low_score_ceiling', 'rerank'],
    ARRAY['refused_high_score_floor', 'similarity'],
    ARRAY['refused_high_score_floor', 'rerank']
  ] LOOP
    IF jsonb_typeof(p_config #> array_remove(v_path, '')) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = array_to_string(array_remove(v_path, ''), '.') || ' must be a number';
    END IF;
  END LOOP;
  IF p_config ? 'source_open_signal' AND jsonb_typeof(p_config -> 'source_open_signal') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'source_open_signal must be a boolean';
  END IF;

  IF (p_config ->> 'per_tenant_limit')::numeric NOT BETWEEN 1 AND 1000
     OR (p_config ->> 'per_tenant_limit')::numeric <> trunc((p_config ->> 'per_tenant_limit')::numeric) THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'per_tenant_limit must be an integer from 1 to 1000';
  END IF;
  IF (p_config ->> 'open_item_ttl_days')::numeric NOT BETWEEN 1 AND 3650
     OR (p_config ->> 'open_item_ttl_days')::numeric <> trunc((p_config ->> 'open_item_ttl_days')::numeric) THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'open_item_ttl_days must be an integer from 1 to 3650';
  END IF;

  v_limit := (p_config ->> 'per_tenant_limit')::integer;
  v_ttl_days := (p_config ->> 'open_item_ttl_days')::integer;
  v_low_similarity := (p_config #>> '{low_score_ceiling,similarity}')::double precision;
  v_low_rerank := (p_config #>> '{low_score_ceiling,rerank}')::double precision;
  v_high_similarity := (p_config #>> '{refused_high_score_floor,similarity}')::double precision;
  v_high_rerank := (p_config #>> '{refused_high_score_floor,rerank}')::double precision;
  v_source_signal := coalesce((p_config ->> 'source_open_signal')::boolean, false);
  v_window := pg_catalog.date_trunc('week', p_until, 'UTC');

  RETURN QUERY
  WITH source_rows AS (
    SELECT l.id, l.tenant_key, l.trace_id, l.query_fingerprint, l.created_at, l.outcome, l.refusal_decision, l.top_score,
           l.candidate_count, l.feedback_vote, l.feedback_kind, l.source_opened_count,
           (l.candidates @? '$[*].rerank_score') AS reranked
    FROM public.rag_retrieval_log l
    WHERE l.created_at >= p_since
      AND l.created_at < p_until
      AND l.query_masked IS NOT NULL
      AND l.query_fingerprint IS NOT NULL
      AND l.tenant_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.rag_tenant_feedback_settings s
        WHERE s.tenant_key = l.tenant_key AND s.retrieval_log <> 'inherit'
      )
  ),
  flagged AS (
    SELECT r.id, r.tenant_key, r.query_fingerprint, r.created_at,
      coalesce(
        (r.feedback_vote = -1 AND r.feedback_kind IN ('answer', 'embed'))
        OR EXISTS (
          SELECT 1 FROM public.rag_answer_records a
          WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND a.feedback ->> 'vote' = 'not_helpful'
        ),
        false) AS f_negative,
      coalesce(r.feedback_vote = -1 AND r.feedback_kind = 'refusal', false) AS f_disputed,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND a.groundedness ->> 'label' = 'possibly_unreliable'
      ) AS f_groundedness,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'claim_unsupported' = ANY (a.review_reasons)
      ) AS f_claim,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'calc_mismatch' = ANY (a.review_reasons)
      ) AS f_calc_mismatch,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'calc_unverified' = ANY (a.review_reasons)
      ) AS f_calc_unverified,
      coalesce(
        (r.outcome = 'refused_no_context' OR r.refusal_decision = 'refuse')
        AND r.top_score >= CASE WHEN r.reranked THEN v_high_rerank ELSE v_high_similarity END,
        false) AS f_high,
      coalesce(r.candidate_count = 0 AND r.outcome <> 'kb_unavailable', false) AS f_zero,
      coalesce(r.outcome = 'answered' AND r.top_score < CASE WHEN r.reranked THEN v_low_rerank ELSE v_low_similarity END, false) AS f_low,
      coalesce(v_source_signal AND r.outcome = 'answered' AND r.source_opened_count = 0, false) AS f_no_source
    FROM source_rows r
  ),
  grouped AS (
    SELECT f.id, f.tenant_key, f.query_fingerprint, f.created_at,
      row_number() OVER (PARTITION BY f.tenant_key, f.query_fingerprint ORDER BY f.created_at DESC, f.id DESC) AS newest,
      count(*) OVER g AS occurrences,
      bool_or(f.f_negative) OVER g AS g_negative,
      bool_or(f.f_disputed) OVER g AS g_disputed,
      bool_or(f.f_groundedness) OVER g AS g_groundedness,
      bool_or(f.f_claim) OVER g AS g_claim,
      bool_or(f.f_calc_mismatch) OVER g AS g_calc_mismatch,
      bool_or(f.f_calc_unverified) OVER g AS g_calc_unverified,
      bool_or(f.f_high) OVER g AS g_high,
      bool_or(f.f_zero) OVER g AS g_zero,
      bool_or(f.f_low) OVER g AS g_low,
      bool_or(f.f_no_source) OVER g AS g_no_source
    FROM flagged f
    WHERE f.f_negative OR f.f_disputed OR f.f_groundedness OR f.f_claim OR f.f_calc_mismatch OR f.f_calc_unverified
       OR f.f_high OR f.f_zero OR f.f_low
    WINDOW g AS (PARTITION BY f.tenant_key, f.query_fingerprint)
  ),
  kept AS (
    SELECT g.id, g.tenant_key, g.query_fingerprint, g.created_at, g.occurrences,
      array_remove(ARRAY[
        CASE WHEN g.g_negative THEN 'feedback_negative' END,
        CASE WHEN g.g_disputed THEN 'refusal_disputed' END,
        CASE WHEN g.g_groundedness THEN 'groundedness_flagged' END,
        CASE WHEN g.g_claim THEN 'claim_unsupported' END,
        CASE WHEN g.g_calc_mismatch THEN 'calc_mismatch' END,
        CASE WHEN g.g_calc_unverified THEN 'calc_unverified' END,
        CASE WHEN g.g_high THEN 'refused_high_score' END,
        CASE WHEN g.g_zero THEN 'zero_results' END,
        CASE WHEN g.g_low THEN 'low_score' END,
        CASE WHEN g.g_no_source THEN 'no_source_opened' END
      ]::text[], NULL) AS reasons,
      CASE
        WHEN g.g_negative THEN 1
        WHEN g.g_disputed THEN 2
        WHEN g.g_groundedness THEN 3
        WHEN g.g_claim THEN 4
        WHEN g.g_calc_mismatch THEN 5
        WHEN g.g_calc_unverified THEN 6
        WHEN g.g_high THEN 7
        WHEN g.g_zero THEN 8
        ELSE 9
      END AS priority
    FROM grouped g
    WHERE g.newest = 1
  ),
  selected AS (
    SELECT k.*
    FROM (
      SELECT k0.*,
        row_number() OVER (PARTITION BY k0.tenant_key ORDER BY k0.priority, k0.occurrences DESC, k0.created_at DESC, k0.id) AS tenant_rank
      FROM kept k0
    ) k
    WHERE k.tenant_rank <= v_limit
  ),
  ins AS (
    INSERT INTO public.rag_review_items AS i (
      tenant_key, retrieval_log_id, trace_id, user_id, chat_id,
      query_masked, query_fingerprint, query_language, query_language_confidence, answer_language, chunk_languages,
      channel, outcome, candidates, retrieval_config_hash, reasons, occurrences,
      status, mining_window, mined_at, expires_at
    )
    SELECT l.tenant_key, l.id, l.trace_id, l.user_id, l.chat_id,
      l.query_masked, l.query_fingerprint, l.query_language, l.query_language_confidence, l.answer_language, l.chunk_languages,
      l.channel, l.outcome, l.candidates, l.retrieval_config_hash, s.reasons, s.occurrences::integer,
      'open', v_window, now(), now() + make_interval(days => v_ttl_days)
    FROM selected s
    JOIN public.rag_retrieval_log l ON l.id = s.id AND l.tenant_key = s.tenant_key
    ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
    RETURNING i.tenant_key, i.query_fingerprint
  )
  SELECT s.tenant_key, r.reason, count(n.query_fingerprint)::integer
  FROM selected s
  CROSS JOIN LATERAL unnest(s.reasons) AS r(reason)
  LEFT JOIN ins n ON n.tenant_key = s.tenant_key AND n.query_fingerprint = s.query_fingerprint
  GROUP BY s.tenant_key, r.reason
  ORDER BY s.tenant_key, r.reason;
END
$function$
;

-- rag_review_items_enqueue_re_review(text,jsonb)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue_re_review(p_tenant_key text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
     WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value ->> 'query_masked', '') = ''
        OR COALESCE(e.value ->> 'query_fingerprint', '') = ''
        OR COALESCE(e.value ->> 'mining_window', '') = ''
  ) THEN
    RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
  END IF;

  EXECUTE $sql$
    WITH written AS (
      INSERT INTO public.rag_review_items AS i (
        tenant_key, query_masked, query_fingerprint, query_language, channel, reasons, status, mining_window, mined_at
      )
      SELECT $1, e.value ->> 'query_masked', e.value ->> 'query_fingerprint', NULLIF(e.value ->> 'language', ''),
             NULLIF(e.value ->> 'channel', ''), ARRAY['re_review']::text[], 'open', (e.value ->> 'mining_window')::timestamptz,
             pg_catalog.now()
        FROM pg_catalog.jsonb_array_elements($2) AS e(value)
      ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
      RETURNING 1
    )
    SELECT pg_catalog.count(*)::integer FROM written
  $sql$ INTO v_count USING p_tenant_key, p_rows;

  RETURN v_count;
END
$function$
;

-- rag_review_items_enqueue(text,text,jsonb)  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue(p_tenant_key text, p_source text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
    DECLARE
      v_row jsonb;
      v_id uuid;
      v_log uuid;
      v_reasons text[];
      v_count integer := 0;
    BEGIN
      PERFORM public.rag_assert_tenant_key(p_tenant_key);
      IF p_source IS NULL OR p_source NOT IN ('representative', 'pilot', 'drift_fill', 'historical') THEN
        RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023';
      END IF;
      IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
      END IF;

      FOR v_row IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value) LOOP
        IF pg_catalog.jsonb_typeof(v_row) <> 'object'
           OR coalesce(v_row ->> 'query_masked', '') = ''
           OR coalesce(v_row ->> 'query_fingerprint', '') = ''
           OR coalesce(v_row ->> 'mining_window', '') = ''
           OR coalesce(v_row ->> 'stratum', '') = ''
           OR coalesce(pg_catalog.jsonb_typeof(v_row -> 'sampling_weight'), '') <> 'number'
           OR (v_row ? 'reasons' AND pg_catalog.jsonb_typeof(v_row -> 'reasons') <> 'array') THEN
          RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
        END IF;

        v_log := NULLIF(v_row ->> 'retrieval_log_id', '')::uuid;
        IF v_log IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.rag_retrieval_log l WHERE l.id = v_log AND l.tenant_key = p_tenant_key
        ) THEN
          RAISE EXCEPTION 'retrieval_log_not_in_tenant' USING ERRCODE = '22023';
        END IF;

        IF v_row ? 'reasons' THEN
          v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(v_row -> 'reasons'));
        ELSE
          v_reasons := ARRAY['representative']::text[];
        END IF;

        v_id := NULL;
        INSERT INTO public.rag_review_items AS i (
          tenant_key, retrieval_log_id, trace_id, query_masked, query_fingerprint, query_language, channel,
          reasons, status, mining_window, mined_at, expires_at
        ) VALUES (
          p_tenant_key, v_log, NULLIF(v_row ->> 'trace_id', ''), v_row ->> 'query_masked', v_row ->> 'query_fingerprint',
          NULLIF(v_row ->> 'language', ''), NULLIF(v_row ->> 'channel', ''),
          v_reasons, 'open', (v_row ->> 'mining_window')::timestamptz, pg_catalog.now(), NULLIF(v_row ->> 'expires_at', '')::timestamptz
        )
        ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
        RETURNING i.id INTO v_id;

        IF v_id IS NOT NULL THEN
          INSERT INTO public.rag_review_item_strata (review_item_id, tenant_key, source, stratum, sampling_weight)
          VALUES (v_id, p_tenant_key, p_source, v_row ->> 'stratum', (v_row ->> 'sampling_weight')::real);
          v_count := v_count + 1;
        END IF;
      END LOOP;

      RETURN v_count;
    END
    $function$
;

-- rag_table_lookup(text,text[],integer,integer,jsonb,text[])  acl={postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.rag_table_lookup(p_tenant_key text, p_tokens text[], p_min_cells integer, p_limit integer, p_version_scope jsonb DEFAULT NULL::jsonb, p_identifiers_norm text[] DEFAULT NULL::text[])
 RETURNS TABLE(row_id uuid, document_id uuid, table_key text, row_index integer, header text[], cells jsonb, matched_cells integer, chunk_ids uuid[], chunk_id uuid, content text, metadata jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$
;


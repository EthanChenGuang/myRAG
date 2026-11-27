-- Train 38 live SQL (ci/merge-train-38). Apply after train 37 is live (0924, 0925, 0934, 0980 and 0410 r20). Multi-tenant production.
-- Order: 0930 (re-run of the changed common file), 0930 multi-tenant mode file (new), 0933, 0741, 0981, 0984, then the 0409 and 0410 r21 deltas
-- (grants only). Only 0930 has mode variants; production runs the .multi-tenant.sql one (a single-tenant deployment runs
-- 0930_access_retrieval_functions.single-tenant.sql in its place; it is not in this file).
-- Dependencies: 0930 needs 0920-0922 (access_groups columns, rag_access_enforced) and the newest bodies it rebases on (0413, 0425, 0856);
-- the mode file runs after the common file; 0933 needs 0930, 0921 (access_groups on chunk_translations and rag_table_rows) and the bodies of
-- 0810, 0858, 0861, 0862; 0741 needs rag_review_items (0534/0535/0537) and rag_assert_tenant_key; 0981 needs rag_assert_tenant_key (0410 era).
-- 0930 is already live (train 35) and is changed by this train (plans 04.3-09/04.3-10): the whole file is re-run. It is idempotent, and no
-- later file redefines any function it defines (checked: hybrid_search_chunks, rag_fetch_parents, rag_exact_id_documents,
-- match_chunks_by_profile, rag_find_invoices; 0932 defines rag_bm25_search_chunks, which 0930 does not touch).
-- 0409 and 0410 are not re-run: the deltas below repeat only the guarded lines train 38 adds to them.
-- Do NOT re-run 0425 after this file: its precheck names the dropped signatures and stops with 55000 (0930 header, operator rule).
-- App compatibility: every new parameter is appended with a default (p_access_keys NULL, p_access_all false), so the app on main keeps
-- calling the redefined functions by name unchanged. Apply this SQL before deploying the train-38 app.
-- DROP sections (each followed by a re-create in the same transaction):
--   0930: DO $drop_overloads$ drops every hybrid_search_chunks overload by catalog lookup (as in train 35; exactly one is re-created).
--   0930: DO $drop_content_overloads$ drops every overload of rag_fetch_parents, rag_exact_id_documents, match_chunks_by_profile and
--         rag_find_invoices; each is re-created from its newest body with p_access_keys text[] and p_access_all boolean appended.
--   0930 multi-tenant: DO $drop_overloads$ drops every match_documents_by_workspace overload; re-created as the 0425 body plus the two
--         access parameters (SECURITY DEFINER, service_role only).
--   0933: DO block drops every overload of hybrid_search_translations, rag_table_lookup, rag_identifier_resolve,
--         rag_identifier_candidates and rag_dup_cluster_sources; each is re-created with the two access parameters.
--   0984: DROP FUNCTION IF EXISTS public.rag_enqueue_review_item(text, text, jsonb, jsonb) (the four-argument signature); re-created
--         with a fifth argument p_access_sets jsonb DEFAULT NULL, so a four-argument call from the app on main still resolves.
--         rag_mine_failed_queries keeps its signature (CREATE OR REPLACE from the 0950 body, still SECURITY DEFINER).
-- Operational notes:
--   0930 multi-tenant also adds the enforcement guard to the unused legacy content functions (match_document_chunks_by_org,
--   get_documents_by_type_slug, get_documents_by_type_slug_workspace, match_documents_by_organization, match_document_chunks); the two
--   SECURITY INVOKER ones (0306) lose their anon/authenticated grant (no caller in src/). While rag_access_enforced() is false every
--   function returns what it returned before.
--   0933 adds rag_access_readiness() (STABLE, INVOKER, service_role only), read by the app's access startup check.
--   0741 (rag_red_team_open_cases) and 0981 (rag_tenant_doc_types): service_role only, INVOKER, empty search_path. Owner queue items 21 and
--   26 also ask for them on the eval project.
--   0984 adds rag_review_access_sets (INVOKER, service_role only). Its $backfill$ block writes rag_review_items.access_sets for items
--   that have none, and only while rag_access_enforced() is true at apply time; with enforcement off (expected today) it writes nothing.
--   Apart from that backfill, nothing here writes or rewrites existing rows; no index or column is added.

-- ==== supabase/migrations/0930_access_retrieval_functions.sql
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

-- ==== supabase/migrations/0930_access_retrieval_functions.multi-tenant.sql
-- 0930 (multi-tenant): the legacy search RPC and the unused content functions of multi-tenant mode (Phase 4.3 plan 10; D-10, D-11, D-12,
-- D-13, A-04, A-09, RESEARCH section 1a). Run after 0930_access_retrieval_functions.sql.
-- match_documents_by_workspace: the 0425 multi-tenant body (newest; earlier 0306) plus p_access_keys text[] DEFAULT NULL and p_access_all
-- boolean DEFAULT false. Every earlier overload is dropped by catalog lookup, so exactly one exists. With no keys, or with p_access_all, the
-- query is the 0425 query, unless public.rag_access_enforced() is true and no keys were sent: then it raises access_scope_required (42501);
-- an empty key array raises access_keys_empty (22023). With keys and p_access_all not true the chunk's label and its document's label must
-- overlap the keys, in the same WHERE as the workspace predicate, before ORDER BY and LIMIT; the visible rows are counted up to 1001, at or
-- below 1000 the query is a materialized exact scan, above it the ANN scan runs with hnsw.iterative_scan = relaxed_order (pgvector 0.8 or
-- newer) and a raised hnsw.ef_search, and the hits are re-sorted by exact distance (D-13). SECURITY DEFINER, empty search_path, service_role
-- only (as 0409, 0410).
-- Unused content functions (no caller in src/): match_document_chunks_by_org, get_documents_by_type_slug, get_documents_by_type_slug_workspace
-- (0425 bodies, SECURITY DEFINER), match_documents_by_organization and the multi-tenant match_document_chunks (0306 bodies, SECURITY
-- INVOKER) keep their signature, body and security mode and gain one guard at the top: while enforcement is on they raise
-- access_scope_required, so none of them returns unfiltered content; while it is off a server caller gets what it got before. The two
-- SQL-language functions become plpgsql with the same query, so the guard can raise. The 0306 ones also get an empty search_path with
-- schema-qualified names; all five are executable by service_role only (the two INVOKER ones were client-callable; with no caller they are
-- not kept open as a path around the access filter).
-- Operator rule: after re-running any file below 0920 that defines one of these functions (0306, 0409, 0425 or the setup file), re-run the
-- whole ordered sequence through the 0930 block. Idempotent; not folded into the setup file.

BEGIN;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'match_documents_by_workspace'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(
  p_query_embedding public.vector,
  p_match_count integer,
  p_min_similarity double precision,
  p_org_id uuid,
  p_user_id uuid,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_restrict boolean;
  v_visible integer;
  v_version text;
BEGIN
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);

  IF NOT v_restrict THEN
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
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_visible FROM (
    SELECT 1
    FROM public.document_chunks dc
    INNER JOIN public.documents d ON d.id = dc.document_id
    WHERE dc.embedding IS NOT NULL
      AND dc.is_current AND dc.status = 'ready'
      AND ((p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL) OR (p_org_id IS NOT NULL AND d.organization_id = p_org_id))
      AND dc.access_groups && p_access_keys AND d.access_groups && p_access_keys
    LIMIT 1001
  ) s;

  IF v_visible <= 1000 THEN
    RETURN QUERY
    WITH hits AS MATERIALIZED (
      SELECT dc.id AS hid, dc.embedding OPERATOR(public.<=>) p_query_embedding AS dist
      FROM public.document_chunks dc
      INNER JOIN public.documents d ON d.id = dc.document_id
      WHERE dc.embedding IS NOT NULL
        AND dc.is_current AND dc.status = 'ready'
        AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
        AND ((p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL) OR (p_org_id IS NOT NULL AND d.organization_id = p_org_id))
        AND dc.access_groups && p_access_keys AND d.access_groups && p_access_keys
    )
    SELECT c.id, c.document_id, c.content, (1 - h.dist)::double precision, c.metadata
    FROM hits h
    JOIN public.document_chunks c ON c.id = h.hid
    ORDER BY h.dist + 0, h.hid
    LIMIT p_match_count;
    RETURN;
  END IF;

  SELECT extversion INTO v_version FROM pg_catalog.pg_extension WHERE extname = 'vector';
  IF v_version IS NOT NULL AND (string_to_array(v_version, '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
    PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  END IF;
  PERFORM set_config('hnsw.ef_search', least(greatest(p_match_count * 2, 100), 1000)::text, true);

  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT dc.id AS hid, dc.embedding OPERATOR(public.<=>) p_query_embedding AS dist
    FROM public.document_chunks dc
    INNER JOIN public.documents d ON d.id = dc.document_id
    WHERE dc.embedding IS NOT NULL
      AND dc.is_current AND dc.status = 'ready'
      AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
      AND ((p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL) OR (p_org_id IS NOT NULL AND d.organization_id = p_org_id))
      AND dc.access_groups && p_access_keys AND d.access_groups && p_access_keys
    ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
    LIMIT p_match_count
  )
  SELECT c.id, c.document_id, c.content, (1 - h.dist)::double precision, c.metadata
  FROM hits h
  JOIN public.document_chunks c ON c.id = h.hid
  ORDER BY h.dist + 0, h.hid;
END;
$function$;

REVOKE ALL ON FUNCTION public.match_documents_by_workspace(public.vector, integer, double precision, uuid, uuid, text[], boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(public.vector, integer, double precision, uuid, uuid, text[], boolean)
  TO service_role;

-- Unused multi-tenant content functions: newest bodies (0425, 0306) with the guard at the top; the 0306 ones also get an empty search_path
-- and schema-qualified names. All are executable by service_role only.

CREATE OR REPLACE FUNCTION public.match_document_chunks_by_org(p_org_id uuid, p_query_embedding public.vector, p_match_count integer DEFAULT 8, p_min_similarity double precision DEFAULT 0.2)
 RETURNS TABLE(document_id uuid, chunk_id uuid, content text, similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
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
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug(p_org_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug_workspace(p_org_id uuid, p_user_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, user_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_documents_by_organization(
  query_embedding public.vector(1536),
  match_threshold float,
  match_count int,
  org_id uuid
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.metadata,
    1 - (dc.embedding OPERATOR(public.<=>) query_embedding) as similarity
  FROM public.document_chunks dc
  WHERE dc.organization_id = org_id
    AND 1 - (dc.embedding OPERATOR(public.<=>) query_embedding) > match_threshold
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding OPERATOR(public.<=>) query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding public.vector(1536),
  match_count integer,
  similarity_threshold double precision
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  current_user_id UUID;
  current_org_id UUID;
BEGIN
  IF public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  -- Get current user ID
  current_user_id := auth.uid();
  
  -- Get user's current organization if in multi-tenant mode
  SELECT current_organization_id INTO current_org_id
  FROM public.user_preferences
  WHERE user_id = current_user_id;
  
  -- Return chunks based on organization context
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) query_embedding) as similarity,
    dc.metadata
  FROM public.document_chunks dc
  INNER JOIN public.documents d ON dc.document_id = d.id
  WHERE dc.embedding IS NOT NULL 
    AND 1 - (dc.embedding OPERATOR(public.<=>) query_embedding) > similarity_threshold
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
$$;

REVOKE ALL ON FUNCTION public.match_documents_by_organization(public.vector, float, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents_by_organization(public.vector, float, int, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.match_document_chunks(public.vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_document_chunks(public.vector, integer, double precision) TO service_role;
REVOKE ALL ON FUNCTION public.match_document_chunks_by_org(uuid, public.vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_document_chunks_by_org(uuid, public.vector, integer, double precision) TO service_role;
REVOKE ALL ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0933_access_seam_legs.sql
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
-- rag_dup_cluster_sources, rag_bm25_search_chunks, and 1008's rag_attribute_filter_values and rag_attribute_documents, which this file
-- cannot redefine because 1008 runs after it) has exactly one overload, both access parameters and the access_scope_required guard,
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
    'rag_identifier_candidates', 'rag_dup_cluster_sources', 'rag_bm25_search_chunks',
    'rag_attribute_filter_values', 'rag_attribute_documents'
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

-- ==== supabase/migrations/0741_red_team_review_cases.sql
-- 0741: rag_red_team_open_cases, one open review item per red-team attack success (Phase 7 SEC-11, plan 07-42).
-- p_cases: [{ item_id, technique, language, trace_id, question }]. Every case is stored under p_tenant_key (a tenant named in a
-- case is ignored) with tags {red_team, rt_<technique>}, empty reasons, channel chat, outcome answered, the synthetic question as
-- query_masked (at most 2000 characters), mining_window p_run_started_at and the queue's 90-day open-item expiry
-- (config/rag/feedback-mining.json open_item_ttl_days). query_fingerprint is the sha256 hex of 'red_team:<run>:<item>:' plus the
-- normalised question, so one run inserts one item per corpus item; ON CONFLICT DO NOTHING on the Phase 5.1.1 key (tenant_key,
-- query_fingerprint, mining_window), so a repeat inserts nothing. Returns the number inserted. A malformed payload raises 22023
-- and writes nothing. The tenant key is checked first by rag_assert_tenant_key. SECURITY INVOKER, empty search_path,
-- service_role only. Idempotent, not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_red_team_open_cases(
  p_tenant_key text,
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_cases jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_run_id IS NULL OR p_run_started_at IS NULL THEN
    RAISE EXCEPTION 'run_required' USING ERRCODE = '22023';
  END IF;
  IF p_cases IS NULL OR pg_catalog.jsonb_typeof(p_cases) <> 'array' THEN
    RAISE EXCEPTION 'cases_not_array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_cases) > 500 THEN
    RAISE EXCEPTION 'too_many_cases' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_cases) AS e(value)
     WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value ->> 'item_id', '') = ''
        OR COALESCE(e.value ->> 'technique', '') !~ '^[a-z][a-z_]{0,28}$'
        OR COALESCE(e.value ->> 'language', '') !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'
        OR COALESCE(e.value ->> 'trace_id', '') = ''
        OR pg_catalog.btrim(COALESCE(e.value ->> 'question', '')) = ''
  ) THEN
    RAISE EXCEPTION 'invalid_case' USING ERRCODE = '22023';
  END IF;

  WITH written AS (
    INSERT INTO public.rag_review_items AS i (
      tenant_key, trace_id, query_masked, query_fingerprint, query_language, channel, outcome, reasons, tags, status,
      mining_window, mined_at, expires_at
    )
    SELECT p_tenant_key,
           e.value ->> 'trace_id',
           pg_catalog.left(e.value ->> 'question', 2000),
           pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(
               'red_team:' || p_run_id::text || ':' || (e.value ->> 'item_id') || ':'
                 || pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(e.value ->> 'question'), '\s+', ' ', 'g')),
               'UTF8'
             )),
             'hex'
           ),
           e.value ->> 'language',
           'chat',
           'answered',
           '{}'::text[],
           ARRAY['red_team', 'rt_' || (e.value ->> 'technique')]::text[],
           'open',
           p_run_started_at,
           pg_catalog.now(),
           pg_catalog.now() + pg_catalog.make_interval(days => 90)
      FROM pg_catalog.jsonb_array_elements(p_cases) AS e(value)
    ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_count FROM written;

  RETURN v_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_red_team_open_cases(text, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_red_team_open_cases(text, uuid, timestamptz, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0981_tenant_doc_types.sql
-- 0981: rag_tenant_doc_types — the distinct doc types of a tenant's current, ready documents, the doc-type vocabulary of the
-- sub-question filters (Phase 6.2 D-02, D-06, D-07, QRY-10). status = 'ready' already leaves quarantined, pending_review,
-- processing and failed versions out. The tenant comes only from p_tenant_key, checked first by rag_assert_tenant_key
-- (Phase 4 D-04): a malformed or wrong-mode key raises 22023. SECURITY INVOKER with an empty search_path and schema-qualified
-- names, after the 0601 pattern; service_role only. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_tenant_doc_types(p_tenant_key text)
RETURNS TABLE (
  doc_type text,
  docs bigint
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  RETURN QUERY
  SELECT d.doc_type AS doc_type, pg_catalog.count(*) AS docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type IS NOT NULL
  GROUP BY d.doc_type
  ORDER BY pg_catalog.count(*) DESC, d.doc_type;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_tenant_doc_types(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_doc_types(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0984_review_items_access_sets.sql
-- 0984: the review-queue writers carry access_sets (Phase 4.3 follow-up to 04.3-13 and 04.3-14; SEC-13, D-25, A-06).
-- Gap closed: rag_mine_failed_queries and rag_enqueue_review_item wrote rag_review_items.access_sets as NULL, so 0934's restrictive
-- policy rag_review_items_access_sets never hid a new item, and an expert outside a document's access group could read its evidence
-- through the review chunks route.
-- rag_review_access_sets(p_tenant_key, p_given, p_document_ids, p_strict): SECURITY INVOKER, empty search_path, service_role only. It
-- returns p_given (normalised: each set's keys sorted and deduplicated, the sets deduplicated and sorted) merged with one access_groups
-- set per document of p_document_ids in p_tenant_key, the documents' labels being added only while public.rag_access_enforced() is true.
-- With access off and p_given NULL the result is NULL (today's row). p_strict raises invalid_access_sets (22023) on a malformed p_given;
-- otherwise a malformed set is stored as a group key nobody holds (fail closed, readable by tenant admins only).
-- rag_mine_failed_queries is rebuilt from its 0950 body: the mined item gets the log row's access_sets merged with the label sets of
-- its candidates' documents. rag_enqueue_review_item is rebuilt from its 0950 body with a fifth argument p_access_sets jsonb DEFAULT
-- NULL (the caller's label sets, merged with the sets of the source documents read here). The four-argument signature is dropped first,
-- because CREATE OR REPLACE with a new argument list would add an overload. Security attributes are unchanged: the mining is SECURITY
-- DEFINER and the enqueue SECURITY INVOKER, both with an empty search_path and service_role only (and locked again in 0410).
-- While access is enforced at apply time, items still without access_sets get their sets from their candidates and snapshot ids.
-- One common file: nothing differs by deployment mode (tenant_key exists in both). Not folded into the setup files. Idempotent.
-- Re-running 0944 or 0950 later re-creates the four-argument enqueue and the old mining body; re-run this file after them.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_review_access_sets(p_tenant_key text, p_given jsonb, p_document_ids uuid[], p_strict boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key_re constant text := '^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
  v_unknown constant jsonb := '["g:00000000-0000-0000-0000-000000000000"]'::jsonb;
  v_sets jsonb[] := '{}'::jsonb[];
  v_set jsonb;
  v_valid boolean;
BEGIN
  IF p_given IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_given) <> 'array' OR pg_catalog.jsonb_array_length(p_given) > 200 THEN
      IF p_strict THEN
        RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'access sets must be an array of at most 200 key arrays';
      END IF;
      v_sets := v_sets || v_unknown;
    ELSE
      FOR v_set IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_given) AS e(value) LOOP
        v_valid := pg_catalog.jsonb_typeof(v_set) = 'array'
          AND pg_catalog.jsonb_array_length(v_set) BETWEEN 1 AND 64
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)
            WHERE pg_catalog.jsonb_typeof(k.value) <> 'string' OR (k.value #>> '{}') !~ v_key_re
          );
        IF NOT v_valid THEN
          IF p_strict THEN
            RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'each access set is 1 to 64 access keys';
          END IF;
          v_sets := v_sets || v_unknown;
        ELSE
          v_sets := v_sets || (
            SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C")
            FROM (SELECT DISTINCT k.value #>> '{}' AS key FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)) AS x
          );
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF public.rag_access_enforced() AND p_tenant_key IS NOT NULL THEN
    v_sets := v_sets || ARRAY(
      SELECT CASE WHEN pg_catalog.cardinality(d.access_groups) = 0 THEN v_unknown ELSE (
        SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C") FROM (SELECT DISTINCT k AS key FROM pg_catalog.unnest(d.access_groups) AS k) AS x
      ) END
      FROM public.documents d
      WHERE d.id = ANY (coalesce(p_document_ids, '{}'::uuid[])) AND d.tenant_key = p_tenant_key
    );
  END IF;

  IF p_given IS NULL AND pg_catalog.cardinality(v_sets) = 0 THEN
    RETURN NULL;
  END IF;
  RETURN coalesce(
    (SELECT pg_catalog.jsonb_agg(s.value ORDER BY s.value::text COLLATE "C") FROM (SELECT DISTINCT u AS value FROM pg_catalog.unnest(v_sets) AS u) AS s),
    '[]'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_mine_failed_queries(p_since timestamptz, p_until timestamptz, p_config jsonb)
RETURNS TABLE (tenant_key text, reason text, inserted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
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
      status, mining_window, mined_at, expires_at, access_sets
    )
    SELECT l.tenant_key, l.id, l.trace_id, l.user_id, l.chat_id,
      l.query_masked, l.query_fingerprint, l.query_language, l.query_language_confidence, l.answer_language, l.chunk_languages,
      l.channel, l.outcome, l.candidates, l.retrieval_config_hash, s.reasons, s.occurrences::integer,
      'open', v_window, now(), now() + make_interval(days => v_ttl_days),
      public.rag_review_access_sets(l.tenant_key, l.access_sets, ARRAY(
        SELECT DISTINCT (c ->> 'document_id')::uuid
        FROM pg_catalog.jsonb_array_elements(l.candidates) AS c
        WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ), false)
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
$fn$;

REVOKE ALL ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) TO service_role;

DROP FUNCTION IF EXISTS public.rag_enqueue_review_item(text, text, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.rag_enqueue_review_item(
  p_tenant_key text, p_reason text, p_source jsonb, p_snapshot jsonb, p_access_sets jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
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
  v_access_sets jsonb;
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

  v_access_sets := public.rag_review_access_sets(
    p_tenant_key, p_access_sets,
    ARRAY(
      SELECT DISTINCT c.document_id FROM public.document_chunks c WHERE c.id = ANY (v_chunks::uuid[])
      UNION
      SELECT d.id FROM public.documents d WHERE d.id = ANY (v_documents::uuid[])
    ),
    true);

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_reason || E'\n' || 'chunks:' || pg_catalog.array_to_string(v_chunks, ',') || E'\n' || 'documents:' || pg_catalog.array_to_string(v_documents, ','),
      'UTF8')),
    'hex');
  v_window := pg_catalog.date_trunc('week', pg_catalog.now(), 'UTC');

  INSERT INTO public.rag_review_items AS i (
    tenant_key, trace_id, query_masked, query_fingerprint, reasons, snapshot, status, mining_window, mined_at, access_sets
  )
  VALUES (
    p_tenant_key, v_trace, '', v_fingerprint, ARRAY[p_reason]::text[],
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'reason', p_reason, 'detector', v_detector, 'trace_id', v_trace,
      'chunk_ids', pg_catalog.to_jsonb(v_chunks), 'document_ids', pg_catalog.to_jsonb(v_documents))),
    'open', v_window, pg_catalog.now(), v_access_sets
  )
  ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
  RETURNING i.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT i.id INTO v_id FROM public.rag_review_items i
    WHERE i.tenant_key = p_tenant_key AND i.query_fingerprint = v_fingerprint AND i.mining_window = v_window;
  END IF;
  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) TO service_role;

DO $backfill$
BEGIN
  IF NOT public.rag_access_enforced() THEN
    RETURN;
  END IF;
  UPDATE public.rag_review_items AS i
  SET access_sets = public.rag_review_access_sets(i.tenant_key, NULL, ARRAY(
    SELECT DISTINCT (c ->> 'document_id')::uuid
    FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(i.candidates) = 'array' THEN i.candidates ELSE '[]'::jsonb END) AS c
    WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    UNION
    SELECT (e #>> '{}')::uuid
    FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'document_ids') = 'array' THEN i.snapshot -> 'document_ids' ELSE '[]'::jsonb END) AS e
    WHERE pg_catalog.lower(e #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    UNION
    SELECT ch.document_id FROM public.document_chunks ch
    WHERE ch.id = ANY (ARRAY(
      SELECT (e #>> '{}')::uuid
      FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(i.snapshot -> 'chunk_ids') = 'array' THEN i.snapshot -> 'chunk_ids' ELSE '[]'::jsonb END) AS e
      WHERE pg_catalog.lower(e #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ))
  ), false)
  WHERE i.access_sets IS NULL;
END
$backfill$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0409 delta (the lines train 38 adds to supabase/migrations/0409_search_rpc_revoke.sql)
DO $t38_0409$
BEGIN
  IF to_regprocedure('public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid, text[], boolean)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid, text[], boolean) TO service_role;
  END IF;
END
$t38_0409$;

-- ==== 0410 r21 delta (the lines train 38 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r21_service_role_only$
BEGIN
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
  IF to_regprocedure('public.rag_review_access_sets(text, jsonb, uuid[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb, jsonb) TO service_role;
  END IF;
END
$r21_service_role_only$;

NOTIFY pgrst, 'reload schema';

-- ==== Verify (read-only; run after the apply)
-- 1. Exactly one overload of each redefined function, each with both access parameters and an empty search_path.
SELECT p.oid::regprocedure AS fn, p.prosecdef AS security_definer, p.proconfig
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('hybrid_search_chunks', 'rag_fetch_parents', 'rag_exact_id_documents', 'match_chunks_by_profile', 'rag_find_invoices',
                    'match_documents_by_workspace', 'hybrid_search_translations', 'rag_table_lookup', 'rag_identifier_resolve',
                    'rag_identifier_candidates', 'rag_dup_cluster_sources', 'rag_access_readiness', 'rag_red_team_open_cases',
                    'rag_tenant_doc_types', 'rag_review_access_sets', 'rag_enqueue_review_item', 'rag_mine_failed_queries')
ORDER BY 1;
-- Expect one row per name, every redefined retrieval function ending in "text[], boolean", proconfig = {search_path=""} everywhere,
-- security_definer true only for match_chunks_by_profile, match_documents_by_workspace and rag_mine_failed_queries (each keeps
-- its security mode); rag_enqueue_review_item has the five-argument signature only.

-- 2. Readiness (read by the app's access startup check). Expect ready = false naming only rag_attribute_filter_values and
--    rag_attribute_documents (1008, function_missing_access_parameters / function_missing_guard): 0933 cannot redefine them because 1008
--    runs after it, so RAG_DOC_ACCESS_GROUPS enforcement stays off until a later plan gives them the filter. Anything else named is a
--    failed apply. (Checked on PGlite: multi-tenant setup + the 177 train-37 migrations, then this file applied twice.)
SELECT * FROM public.rag_access_readiness();

-- 3. Grants: none of these is client-callable.
SELECT p.oid::regprocedure AS fn,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('hybrid_search_chunks', 'rag_fetch_parents', 'rag_exact_id_documents', 'match_chunks_by_profile', 'rag_find_invoices',
                    'match_documents_by_workspace', 'hybrid_search_translations', 'rag_table_lookup', 'rag_identifier_resolve',
                    'rag_identifier_candidates', 'rag_dup_cluster_sources', 'rag_access_readiness', 'rag_red_team_open_cases',
                    'rag_tenant_doc_types', 'match_document_chunks_by_org', 'get_documents_by_type_slug',
                    'get_documents_by_type_slug_workspace', 'match_documents_by_organization', 'match_document_chunks',
                    'rag_review_access_sets', 'rag_enqueue_review_item', 'rag_mine_failed_queries')
ORDER BY 1;
-- Expect anon_exec and authenticated_exec false everywhere, service_role_exec true everywhere.

-- 4. rag_access_enforced stays callable by the 0926 restrictive policies (expect authenticated_exec and anon_exec true).
SELECT pg_catalog.has_function_privilege('authenticated', 'public.rag_access_enforced()', 'EXECUTE') AS authenticated_exec,
       pg_catalog.has_function_privilege('anon', 'public.rag_access_enforced()', 'EXECUTE') AS anon_exec;

-- 0810: retrieval-only chunk translations (Phase 3.2, XLG-04; D-28, D-29 ledger kind, D-30 SQL side, D-31 settings table, D-08 counts).
-- chunk_translations holds one translation per (source chunk, language); chunk_translation_embeddings holds its vector per unscoped
-- embedding profile as halfvec with one partial HNSW index per seeded unscoped profile (the 0308 form; a further profile is a further
-- migration). Both copy tenant_key (and document_id) from the source chunk in a guard trigger and refuse a different non-null value, so a
-- writer cannot place a translation or a vector in another tenant's search space. A translation goes with its chunk (ON DELETE CASCADE),
-- and its vectors go with it. document_chunks and every existing reader of it are untouched: a translation row is never a chunk row.
-- hybrid_search_translations is the search: the tenant comes only from p_tenant_key (rag_assert_tenant_key first), every hit is joined to
-- its source chunk and document, and the current-and-ready filter, the chunking profile rule and the DATA-08 filters of
-- hybrid_search_chunks (0802 body: dates, sources, document ids, doc types, languages, invoice fields, scopes, effective date) are applied
-- to the source chunk; the source document must also be current and ready. It returns the source chunk's columns with the translation id,
-- the translation language and translation_similarity (never the chunk similarity, 3.1.1 D-20). Lexical matching uses the same tokenizer
-- contract as hybrid_search_chunks (p_lexical_tokens, rag_lexical_tsquery, rag_lexical_tsvector).
-- Everything is for the server role only: RLS on without policies, nothing granted to anon or authenticated, every function SECURITY
-- INVOKER (the replaced ledger functions keep SECURITY DEFINER) with SET search_path = '' and schema-qualified names.
-- Not folded into the setup files. Idempotent: IF NOT EXISTS, CREATE OR REPLACE, constraints and indexes replaced only when they differ.

BEGIN;

DO $translations_precheck$
DECLARE
  v_vector_schema text;
BEGIN
  SELECT n.nspname INTO v_vector_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';
  IF v_vector_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION '0810: pgvector must be in schema public, found %', COALESCE(v_vector_schema, 'no vector extension') USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_tsvector(text)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'scopes' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0810: apply the earlier migrations first (0401, 0425, 0801, 0802)' USING ERRCODE = '55000';
  END IF;
END
$translations_precheck$;

-- Tables.

CREATE TABLE IF NOT EXISTS public.chunk_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id uuid NOT NULL REFERENCES public.document_chunks (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  language text NOT NULL CONSTRAINT chunk_translations_language_check CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  content text NOT NULL,
  lexical_text text NOT NULL DEFAULT '',
  lexical_tsv tsvector GENERATED ALWAYS AS (public.rag_lexical_tsvector(lexical_text)) STORED,
  source_content_hash text NOT NULL,
  model text NOT NULL,
  glossary_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunk_translations_chunk_language_ux UNIQUE (chunk_id, language)
);

CREATE INDEX IF NOT EXISTS chunk_translations_tenant_language_idx ON public.chunk_translations (tenant_key, language);
CREATE INDEX IF NOT EXISTS chunk_translations_document_idx ON public.chunk_translations (document_id);
CREATE INDEX IF NOT EXISTS chunk_translations_lexical_tsv_gin ON public.chunk_translations USING gin (lexical_tsv);

CREATE TABLE IF NOT EXISTS public.chunk_translation_embeddings (
  translation_id uuid NOT NULL REFERENCES public.chunk_translations (id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES public.embedding_profiles (id),
  tenant_key text NOT NULL,
  embedding public.halfvec NOT NULL,
  embedding_model text NOT NULL,
  dims integer NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (translation_id, profile_id)
);

CREATE INDEX IF NOT EXISTS chunk_translation_embeddings_profile_tenant_idx ON public.chunk_translation_embeddings (profile_id, tenant_key);

-- One partial HNSW index per seeded unscoped profile (any of them can be the active global profile, D-28).
CREATE INDEX IF NOT EXISTS chunk_translation_embeddings_openai_3_small_1536_hnsw ON public.chunk_translation_embeddings
  USING hnsw ((embedding::public.halfvec(1536)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'openai-3-small-1536';
CREATE INDEX IF NOT EXISTS chunk_translation_embeddings_voyage_4_large_2048_hnsw ON public.chunk_translation_embeddings
  USING hnsw ((embedding::public.halfvec(2048)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-2048';
CREATE INDEX IF NOT EXISTS chunk_translation_embeddings_voyage_4_large_1024_hnsw ON public.chunk_translation_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-1024';
CREATE INDEX IF NOT EXISTS chunk_translation_embeddings_qwen3_8b_2048_hnsw ON public.chunk_translation_embeddings
  USING hnsw ((embedding::public.halfvec(2048)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'qwen3-8b-2048';
CREATE INDEX IF NOT EXISTS chunk_translation_embeddings_qwen3_8b_1024_hnsw ON public.chunk_translation_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'qwen3-8b-1024';

-- Guards: tenant_key and document_id come from the source chunk; a different non-null value is refused.

CREATE OR REPLACE FUNCTION public.rag_chunk_translations_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_tenant text;
  v_document uuid;
BEGIN
  SELECT c.tenant_key, c.document_id INTO v_tenant, v_document FROM public.document_chunks c WHERE c.id = NEW.chunk_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'chunk_translations: source chunk has no tenant_key' USING ERRCODE = '23502';
  END IF;
  IF NEW.tenant_key IS NOT NULL AND NEW.tenant_key IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'chunk_translations: tenant_mismatch' USING ERRCODE = '42501';
  END IF;
  IF NEW.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM v_document THEN
    RAISE EXCEPTION 'chunk_translations: document_mismatch' USING ERRCODE = '22023';
  END IF;
  NEW.tenant_key := v_tenant;
  NEW.document_id := v_document;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.rag_chunk_translations_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_translations_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_chunk_translations_guard ON public.chunk_translations;
CREATE TRIGGER rag_chunk_translations_guard
  BEFORE INSERT OR UPDATE OF chunk_id, document_id, tenant_key ON public.chunk_translations
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunk_translations_guard();

CREATE OR REPLACE FUNCTION public.rag_chunk_translation_embeddings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_dims integer;
  v_scope text[];
  v_tenant text;
BEGIN
  SELECT p.dims, p.doc_types INTO v_dims, v_scope FROM public.embedding_profiles p WHERE p.id = NEW.profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_scope IS NOT NULL THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: scoped profile' USING ERRCODE = '22023';
  END IF;
  IF public.vector_dims(NEW.embedding) <> v_dims THEN
    RAISE EXCEPTION 'expected % dimensions, not %', v_dims, public.vector_dims(NEW.embedding) USING ERRCODE = '22000';
  END IF;

  SELECT t.tenant_key INTO v_tenant FROM public.chunk_translations t WHERE t.id = NEW.translation_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'chunk_translation_embeddings: translation has no tenant_key' USING ERRCODE = '23502';
  END IF;
  IF NEW.tenant_key IS NOT NULL AND NEW.tenant_key IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'chunk_translation_embeddings: tenant_mismatch' USING ERRCODE = '42501';
  END IF;
  NEW.tenant_key := v_tenant;
  NEW.dims := public.vector_dims(NEW.embedding);
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.rag_chunk_translation_embeddings_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_translation_embeddings_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_chunk_translation_embeddings_guard ON public.chunk_translation_embeddings;
CREATE TRIGGER rag_chunk_translation_embeddings_guard
  BEFORE INSERT OR UPDATE OF translation_id, profile_id, embedding, tenant_key, dims ON public.chunk_translation_embeddings
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunk_translation_embeddings_guard();

ALTER TABLE public.chunk_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chunk_translation_embeddings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chunk_translations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.chunk_translation_embeddings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.chunk_translations TO service_role;
GRANT ALL ON TABLE public.chunk_translation_embeddings TO service_role;

-- Writer. p_rows is an array of objects: chunk_id, language, content, lexical_text, source_content_hash, model, glossary_version and,
-- optionally, profile_id, embedding (a JSON number array) and embedding_model. One call upserts the translation per (chunk, language);
-- a changed translation drops its earlier vectors before the new one is stored, so a vector never describes other text. Every chunk must
-- belong to p_tenant_key; any other row refuses the whole call. Returns the number of rows written.
CREATE OR REPLACE FUNCTION public.rag_write_chunk_translations(p_tenant_key text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_row jsonb;
  v_chunk uuid;
  v_tenant text;
  v_id uuid;
  v_old public.chunk_translations%ROWTYPE;
  v_n integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'translation_refused: rows_must_be_array' USING ERRCODE = '22023';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) AS e(value) LOOP
    IF jsonb_typeof(v_row) <> 'object' OR NULLIF(v_row ->> 'chunk_id', '') IS NULL OR NULLIF(v_row ->> 'language', '') IS NULL
       OR v_row ->> 'content' IS NULL OR NULLIF(v_row ->> 'source_content_hash', '') IS NULL OR NULLIF(v_row ->> 'model', '') IS NULL THEN
      RAISE EXCEPTION 'translation_refused: invalid_row' USING ERRCODE = '22023';
    END IF;
    v_chunk := (v_row ->> 'chunk_id')::uuid;
    SELECT c.tenant_key INTO v_tenant FROM public.document_chunks c WHERE c.id = v_chunk;
    IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'translation_refused: chunk_tenant_mismatch' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_old FROM public.chunk_translations t WHERE t.chunk_id = v_chunk AND t.language = v_row ->> 'language' FOR UPDATE;
    IF FOUND THEN
      IF v_old.content IS DISTINCT FROM v_row ->> 'content'
         OR v_old.source_content_hash IS DISTINCT FROM v_row ->> 'source_content_hash'
         OR v_old.glossary_version IS DISTINCT FROM v_row ->> 'glossary_version'
         OR v_old.model IS DISTINCT FROM v_row ->> 'model' THEN
        DELETE FROM public.chunk_translation_embeddings e WHERE e.translation_id = v_old.id;
      END IF;
      UPDATE public.chunk_translations t
         SET content = v_row ->> 'content',
             lexical_text = COALESCE(v_row ->> 'lexical_text', ''),
             source_content_hash = v_row ->> 'source_content_hash',
             model = v_row ->> 'model',
             glossary_version = v_row ->> 'glossary_version'
       WHERE t.id = v_old.id;
      v_id := v_old.id;
    ELSE
      INSERT INTO public.chunk_translations (chunk_id, tenant_key, language, content, lexical_text, source_content_hash, model, glossary_version)
      VALUES (
        v_chunk, p_tenant_key, v_row ->> 'language', v_row ->> 'content', COALESCE(v_row ->> 'lexical_text', ''),
        v_row ->> 'source_content_hash', v_row ->> 'model', v_row ->> 'glossary_version'
      )
      RETURNING id INTO v_id;
    END IF;

    IF v_row ? 'embedding' AND jsonb_typeof(v_row -> 'embedding') = 'array' THEN
      IF NULLIF(v_row ->> 'profile_id', '') IS NULL OR NULLIF(v_row ->> 'embedding_model', '') IS NULL THEN
        RAISE EXCEPTION 'translation_refused: invalid_embedding' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.chunk_translation_embeddings (translation_id, profile_id, tenant_key, embedding, embedding_model, dims)
      VALUES (v_id, v_row ->> 'profile_id', p_tenant_key, ((v_row -> 'embedding')::text)::public.halfvec, v_row ->> 'embedding_model', 0)
      ON CONFLICT (translation_id, profile_id) DO UPDATE
        SET embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model, tenant_key = EXCLUDED.tenant_key, embedded_at = now();
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_write_chunk_translations(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_write_chunk_translations(text, jsonb) TO service_role;

-- Search. The shared filter is the 0802 one with the same positional parameters ($2 tenant, $3-$12 DATA-08, $16-$20 scopes and effective
-- date); $14 is the translation language and $13 the leg limit. Translations are always halfvec, so every profile reads
-- chunk_translation_embeddings, whatever its chunk storage.
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
  p_effective_on date DEFAULT NULL
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
$fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_translations(
  text, text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text,
  text, numeric, numeric, text, jsonb, boolean, text[], boolean, date
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hybrid_search_translations(
  text, text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text,
  text, numeric, numeric, text, jsonb, boolean, text[], boolean, date
) TO service_role;

-- Tenant settings (D-31). Targets are validated as registry-shaped codes here; the app validates them as a subset of the supported set.

CREATE TABLE IF NOT EXISTS public.rag_translation_settings (
  tenant_key text PRIMARY KEY CONSTRAINT rag_translation_settings_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  target_languages text[] NOT NULL DEFAULT '{}'::text[],
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rag_translation_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_translation_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_translation_settings TO service_role;

CREATE OR REPLACE FUNCTION public.rag_translation_settings_get(p_tenant_key text)
RETURNS TABLE (tenant_key text, target_languages text[], enabled boolean, updated_by uuid, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT p_tenant_key, COALESCE(s.target_languages, '{}'::text[]), COALESCE(s.enabled, false), s.updated_by, s.updated_at
  FROM (SELECT 1) AS one
  LEFT JOIN public.rag_translation_settings s ON s.tenant_key = p_tenant_key;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_translation_settings_set(p_actor uuid, p_tenant_key text, p_targets text[], p_enabled boolean)
RETURNS TABLE (tenant_key text, target_languages text[], enabled boolean, updated_by uuid, updated_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_targets text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT (p_tenant_key = ANY (public.rag_admin_tenant_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL OR p_targets IS NULL OR cardinality(p_targets) > 16 OR EXISTS (
    SELECT 1 FROM unnest(p_targets) AS u(code) WHERE u.code IS NULL OR u.code !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  ) THEN
    RAISE EXCEPTION 'translation_settings_refused: invalid_targets' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(x.code ORDER BY x.first), '{}'::text[]) INTO v_targets
  FROM (SELECT u.code, min(u.ord) AS first FROM unnest(p_targets) WITH ORDINALITY AS u(code, ord) GROUP BY u.code) AS x;

  INSERT INTO public.rag_translation_settings AS s (tenant_key, target_languages, enabled, updated_by, updated_at)
  VALUES (p_tenant_key, v_targets, p_enabled, p_actor, now())
  ON CONFLICT ON CONSTRAINT rag_translation_settings_pkey DO UPDATE
    SET target_languages = EXCLUDED.target_languages, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now();

  RETURN QUERY SELECT * FROM public.rag_translation_settings_get(p_tenant_key);
END
$fn$;

-- Eligible chunks for one target language: current text and table chunks of a current ready document, in the chunking profile the
-- search reads (the hybrid_search_chunks rule without an override), with a known language other than the target (image captions and
-- 'und' chunks are skipped, D-29). source_content_hash is the chunk's content_hash, or the sha256 of its content when it has none; the
-- producer stores it back so a later page can tell an up-to-date translation from a stale one.
CREATE OR REPLACE FUNCTION public.rag_translation_eligible_chunks(p_tenant_key text, p_language text)
RETURNS TABLE (chunk_id uuid, document_id uuid, language text, source_content_hash text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH eff AS (
    SELECT dt.doc_type,
           COALESCE(
             (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
             'legacy'
           ) AS profile_id
    FROM unnest(ARRAY['financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general']) AS dt(doc_type)
  )
  SELECT c.id, c.document_id, c.language,
         COALESCE(NULLIF(c.content_hash, ''), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.content, 'UTF8')), 'hex'))
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  JOIN eff ep ON ep.doc_type = c.doc_type
  WHERE c.tenant_key = p_tenant_key AND d.tenant_key = p_tenant_key
    AND c.is_current AND c.status IN ('ready', 'variant') AND d.is_current AND d.status = 'ready'
    AND c.chunk_kind IN ('text', 'table')
    AND c.language IS NOT NULL AND c.language <> 'und' AND c.language <> p_language
    AND (
      c.chunking_profile_id = ep.profile_id
      OR (
        ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy'
        AND NOT EXISTS (
          SELECT 1 FROM public.document_chunks c2
          WHERE c2.document_id = c.document_id AND c2.tenant_key = p_tenant_key AND c2.is_current AND c2.chunking_profile_id = ep.profile_id
        )
      )
    )
$fn$;

CREATE OR REPLACE FUNCTION public.rag_translation_coverage(p_tenant_key text)
RETURNS TABLE (language text, translated bigint, eligible bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT tl.code,
         count(t.id) FILTER (WHERE t.source_content_hash = e.source_content_hash),
         count(e.chunk_id)
  FROM public.rag_translation_settings s
  CROSS JOIN LATERAL unnest(s.target_languages) WITH ORDINALITY AS tl(code, ord)
  LEFT JOIN LATERAL public.rag_translation_eligible_chunks(p_tenant_key, tl.code) e ON true
  LEFT JOIN public.chunk_translations t ON t.chunk_id = e.chunk_id AND t.language = tl.code AND t.tenant_key = p_tenant_key
  WHERE s.tenant_key = p_tenant_key
  GROUP BY tl.code, tl.ord
  ORDER BY tl.ord;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_translation_pending_page(p_tenant_key text, p_language text, p_limit integer)
RETURNS TABLE (chunk_id uuid, document_id uuid, language text, source_content_hash text, content text, chunk_kind text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_language IS NULL OR p_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' THEN
    RAISE EXCEPTION 'translation_refused: invalid_language' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'translation_refused: limit out of range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT e.chunk_id, e.document_id, e.language, e.source_content_hash, c.content, c.chunk_kind
  FROM public.rag_translation_eligible_chunks(p_tenant_key, p_language) e
  JOIN public.document_chunks c ON c.id = e.chunk_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.chunk_translations t
    WHERE t.chunk_id = e.chunk_id AND t.language = p_language AND t.tenant_key = p_tenant_key AND t.source_content_hash = e.source_content_hash
  )
  ORDER BY e.document_id, c.chunk_index NULLS LAST, e.chunk_id
  LIMIT p_limit;
END
$fn$;

-- Deployment-wide number of current ready documents per language, aggregates only, for the Languages picker (D-08).
CREATE OR REPLACE FUNCTION public.rag_language_document_counts()
RETURNS TABLE (language text, documents bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT d.language, count(*)
  FROM public.documents d
  WHERE d.is_current AND d.status = 'ready' AND d.language IS NOT NULL AND d.language <> ''
  GROUP BY d.language
  ORDER BY d.language
$fn$;

-- Purge hook for the translation store (the rag_purge_hook_<name> seam of the purge work): removes the tenant's translations of the
-- given documents and of every version of the given lineage; their vectors go by cascade. Returns the number of translations removed.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_chunk_translations(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  DELETE FROM public.chunk_translations t
  WHERE t.tenant_key = p_tenant_key
    AND (
      t.document_id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      OR (
        p_lineage_id IS NOT NULL
        AND t.document_id IN (SELECT d.id FROM public.documents d WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key)
      )
    );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_translation_settings_get(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_settings_set(uuid, text, text[], boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_eligible_chunks(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_coverage(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_pending_page(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_language_document_counts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_chunk_translations(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_translation_settings_get(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_settings_set(uuid, text, text[], boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_eligible_chunks(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_coverage(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_pending_page(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_language_document_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_chunk_translations(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

-- Ledger kind translate (D-29, research F-15, Open Question 6). 0801 widened the kind check; here the enqueue function accepts the kind
-- (a document id and settings.target_language are required, no batch, status queued; source_key defaults to
-- translate:<document id>:<language>) and returns the active job for the same document and language instead of a second one (an
-- advisory lock plus a partial unique index). The claim functions hand translate jobs out and move a queued one straight to embedding
-- (no preflight, no parse); advance accepts only the embedding and ready statuses for the kind; neither advance nor fail ever writes the
-- document row of a translate job (its document stays as publish left it). Nothing here writes a parse attempt, parse-cache or budget row.
-- Bodies: 0801 for advance, both claims and enqueue, 0422 for fail; each keeps its signature, SECURITY DEFINER, SET search_path = '' and
-- grants. Re-running 0801 or 0422 after this file puts back their bodies: re-run 0810 after them. The two 0421 claim indexes are rebuilt
-- with translate in their predicate only when it is missing (re-running 0421 restores the two-kind form; re-run 0810 after it).

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_translate_active_ux
  ON public.ingestion_jobs (document_id, (settings ->> 'target_language'))
  WHERE kind = 'translate' AND deleted_at IS NULL
    AND status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review');

DO $translate_claim_indexes$
BEGIN
  IF COALESCE(pg_catalog.pg_get_indexdef(pg_catalog.to_regclass('public.ingestion_jobs_claim_queued_idx')), '') NOT LIKE '%translate%' THEN
    DROP INDEX IF EXISTS public.ingestion_jobs_claim_queued_idx;
    CREATE INDEX ingestion_jobs_claim_queued_idx
      ON public.ingestion_jobs (priority DESC, created_at ASC, id)
      WHERE deleted_at IS NULL
        AND kind IN ('ingest', 'dry_run', 'translate')
        AND status = 'queued';
  END IF;
  IF COALESCE(pg_catalog.pg_get_indexdef(pg_catalog.to_regclass('public.ingestion_jobs_claim_active_lease_idx')), '') NOT LIKE '%translate%' THEN
    DROP INDEX IF EXISTS public.ingestion_jobs_claim_active_lease_idx;
    CREATE INDEX ingestion_jobs_claim_active_lease_idx
      ON public.ingestion_jobs (lease_until ASC, priority DESC, created_at ASC)
      WHERE deleted_at IS NULL
        AND kind IN ('ingest', 'dry_run', 'translate')
        AND status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding');
  END IF;
END
$translate_claim_indexes$;

CREATE OR REPLACE FUNCTION public.rag_enqueue_ingestion_job(p_tenant_key text, p_kind text DEFAULT 'ingest'::text, p_source text DEFAULT NULL::text, p_source_key text DEFAULT NULL::text, p_file_sha256 text DEFAULT NULL::text, p_filename text DEFAULT NULL::text, p_mime_type text DEFAULT NULL::text, p_original_ref jsonb DEFAULT NULL::jsonb, p_settings jsonb DEFAULT '{}'::jsonb, p_priority integer DEFAULT 100, p_document_id uuid DEFAULT NULL::uuid, p_batch_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'queued'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_doc_tenant text;
  v_batch_tenant text;
  v_row public.ingestion_jobs%ROWTYPE;
  v_source_key text := p_source_key;
  v_target text;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_kind IS NULL OR p_kind NOT IN ('ingest', 'dry_run', 'delete', 'translate') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'translate' THEN
    IF p_document_id IS NULL THEN
      RAISE EXCEPTION 'ingest_refused: document_required' USING ERRCODE = '22023';
    END IF;
    v_target := p_settings ->> 'target_language';
    IF v_target IS NULL OR v_target !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' THEN
      RAISE EXCEPTION 'ingest_refused: invalid_target_language' USING ERRCODE = '22023';
    END IF;
    IF p_batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'ingest_refused: batch_not_allowed_for_kind' USING ERRCODE = '22023';
    END IF;
    IF p_status IS DISTINCT FROM 'queued' THEN
      RAISE EXCEPTION 'ingest_refused: invalid_status' USING ERRCODE = '22023';
    END IF;
    v_source_key := COALESCE(NULLIF(btrim(p_source_key), ''), 'translate:' || p_document_id::text || ':' || v_target);
  END IF;
  IF v_source_key IS NULL OR btrim(v_source_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_source_key' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review'
  ) THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT d.tenant_key INTO v_doc_tenant FROM public.documents d WHERE d.id = p_document_id;
    IF NOT FOUND OR v_doc_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: document_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT b.tenant_key INTO v_batch_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
    IF NOT FOUND OR v_batch_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: batch_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_kind = 'translate' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_translate:' || p_document_id::text || ':' || v_target, 0));
    SELECT j.* INTO v_row
      FROM public.ingestion_jobs j
     WHERE j.kind = 'translate'
       AND j.document_id = p_document_id
       AND j.tenant_key = p_tenant_key
       AND j.settings ->> 'target_language' = v_target
       AND j.deleted_at IS NULL
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
     ORDER BY j.created_at
     LIMIT 1;
    IF FOUND THEN
      RETURN v_row;
    END IF;
  END IF;

  INSERT INTO public.ingestion_jobs (
    tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
    original_ref, settings, priority, document_id, batch_id
  ) VALUES (
    p_tenant_key, p_kind, p_status, p_source, v_source_key, p_file_sha256, p_filename, p_mime_type,
    p_original_ref, COALESCE(p_settings, '{}'::jsonb), COALESCE(p_priority, 100), p_document_id, p_batch_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job(p_job_id uuid, p_worker text, p_runner text DEFAULT 'worker'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
BEGIN
  SELECT j.* INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.deleted_at IS NULL
     AND j.kind IN ('ingest', 'dry_run', 'translate')
     AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
     AND (
       (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
       OR (
         j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
         AND j.lease_until IS NOT NULL
         AND j.lease_until < now()
       )
     )
   FOR UPDATE OF j SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
    RETURN NULL;
  END IF;

  IF v_job.locked_by IS NOT NULL AND v_job.lease_until IS NOT NULL AND v_job.lease_until > now() THEN
    RETURN NULL;
  END IF;

  IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
    v_new_retries := v_job.retries + 1;
    IF v_new_retries > v_job.max_retries THEN
      PERFORM public.rag_release_job_reservations(v_job.id);
      UPDATE public.ingestion_jobs
         SET status = 'failed',
             error_class = 'lease_expired',
             error = 'lease expired',
             dead_letter_at = now(),
             retries = v_new_retries,
             locked_by = NULL,
             lease_until = NULL,
             runner = NULL,
             updated_at = now()
       WHERE id = v_job.id;
      RETURN NULL;
    END IF;
    PERFORM public.rag_release_job_reservations(v_job.id);
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = CASE
           WHEN j.status = 'queued' AND j.kind = 'translate' THEN 'embedding'
           WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
           ELSE j.status
         END,
         retries = CASE
           WHEN j.status = 'queued' THEN j.retries
           ELSE j.retries + 1
         END,
         locked_by = p_worker,
         runner = p_runner,
         lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_jobs(p_worker text, p_limit integer, p_allow_batch boolean, p_runner text DEFAULT 'worker'::text)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed integer := 0;
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_limit integer;
BEGIN
  v_limit := GREATEST(COALESCE(p_limit, 0), 0);
  IF v_limit < 1 THEN
    RETURN;
  END IF;

  WHILE v_claimed < v_limit LOOP
    SELECT j.* INTO v_job
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.kind IN ('ingest', 'dry_run', 'translate')
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
       AND (p_allow_batch OR j.batch_id IS NULL)
       AND (
         (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
         OR (
           j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < now()
         )
       )
       AND (j.batch_id IS NULL OR public.rag_batch_has_room(j.batch_id))
     ORDER BY j.priority DESC, j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      EXIT;
    END IF;

    IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
      CONTINUE;
    END IF;

    IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
      v_new_retries := v_job.retries + 1;
      IF v_new_retries > v_job.max_retries THEN
        PERFORM public.rag_release_job_reservations(v_job.id);
        UPDATE public.ingestion_jobs
           SET status = 'failed',
               error_class = 'lease_expired',
               error = 'lease expired',
               dead_letter_at = now(),
               retries = v_new_retries,
               locked_by = NULL,
               lease_until = NULL,
               runner = NULL,
               updated_at = now()
         WHERE id = v_job.id;
        CONTINUE;
      END IF;
      PERFORM public.rag_release_job_reservations(v_job.id);
    END IF;

    UPDATE public.ingestion_jobs j
       SET status = CASE
             WHEN j.status = 'queued' AND j.kind = 'translate' THEN 'embedding'
             WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
             ELSE j.status
           END,
           retries = CASE
             WHEN j.status = 'queued' THEN j.retries
             ELSE j.retries + 1
           END,
           locked_by = p_worker,
           runner = p_runner,
           lease_until = now() + interval '120 seconds',
           updated_at = now()
     WHERE j.id = v_job.id
     RETURNING j.* INTO v_job;

    v_claimed := v_claimed + 1;
    RETURN NEXT v_job;
  END LOOP;

  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_advance_ingestion_job(p_job_id uuid, p_worker text, p_stage text, p_status text, p_stage_state jsonb DEFAULT NULL::jsonb, p_timing_ms integer DEFAULT NULL::integer, p_fields jsonb DEFAULT '{}'::jsonb)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_expected text;
  v_timings jsonb;
  v_key text;
  v_value jsonb;
  v_whitelist text[] := ARRAY[
    'doc_class', 'tier', 'parser_used', 'parser_version', 'pages', 'page_ranges',
    'tier_page_counts', 'detect_counts', 'preflight_ref', 'est_cost_usd', 'embedding_profile',
    'document_id', 'needs_review_reason', 'routing_note', 'provisional_published_at', 'trace_id'
  ];
  v_terminal boolean;
  v_mirror text;
BEGIN
  IF p_stage IS NULL OR btrim(p_stage) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  v_expected := public.rag_ingest_job_status_for_stage(p_stage);
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status <> v_expected THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_stage' USING ERRCODE = '22023';
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) = 'object' THEN
    FOR v_key IN SELECT jsonb_object_keys(p_fields)
    LOOP
      IF NOT (v_key = ANY (v_whitelist)) THEN
        RAISE EXCEPTION 'ingest_refused: field_not_allowed' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);
  IF v_job.kind = 'translate' AND p_status NOT IN ('embedding', 'ready') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage_for_kind' USING ERRCODE = '22023';
  END IF;

  v_timings := COALESCE(v_job.timings, '{}'::jsonb);
  IF p_timing_ms IS NOT NULL AND p_stage IS NOT NULL THEN
    v_timings := v_timings || jsonb_build_object(
      p_stage,
      COALESCE((v_timings ->> p_stage)::bigint, 0) + p_timing_ms
    );
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = p_status,
         stage = p_stage,
         timings = v_timings,
         stage_state = CASE WHEN p_stage_state IS NOT NULL THEN p_stage_state ELSE j.stage_state END,
         doc_class = COALESCE(p_fields ->> 'doc_class', j.doc_class),
         tier = COALESCE(p_fields ->> 'tier', j.tier),
         parser_used = COALESCE(p_fields ->> 'parser_used', j.parser_used),
         parser_version = COALESCE(p_fields ->> 'parser_version', j.parser_version),
         pages = COALESCE((p_fields ->> 'pages')::integer, j.pages),
         page_ranges = CASE WHEN p_fields ? 'page_ranges' THEN p_fields -> 'page_ranges' ELSE j.page_ranges END,
         tier_page_counts = CASE WHEN p_fields ? 'tier_page_counts' THEN p_fields -> 'tier_page_counts' ELSE j.tier_page_counts END,
         detect_counts = CASE WHEN p_fields ? 'detect_counts' THEN p_fields -> 'detect_counts' ELSE j.detect_counts END,
         preflight_ref = COALESCE(p_fields ->> 'preflight_ref', j.preflight_ref),
         est_cost_usd = COALESCE((p_fields ->> 'est_cost_usd')::numeric, j.est_cost_usd),
         embedding_profile = COALESCE(p_fields ->> 'embedding_profile', j.embedding_profile),
         document_id = CASE
           WHEN j.document_id IS NULL AND p_fields ? 'document_id'
           THEN (p_fields ->> 'document_id')::uuid
           ELSE j.document_id
         END,
         needs_review_reason = COALESCE(p_fields ->> 'needs_review_reason', j.needs_review_reason),
         routing_note = COALESCE(p_fields ->> 'routing_note', j.routing_note),
         provisional_published_at = CASE
           WHEN p_fields ? 'provisional_published_at'
           THEN (p_fields ->> 'provisional_published_at')::timestamptz
           ELSE j.provisional_published_at
         END,
         trace_id = CASE WHEN p_fields ? 'trace_id' THEN (p_fields ->> 'trace_id')::uuid ELSE j.trace_id END,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  v_terminal := p_status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review');
  IF v_terminal THEN
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs
       SET locked_by = NULL, lease_until = NULL, runner = NULL
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  END IF;

  IF v_job.document_id IS NOT NULL AND v_job.kind <> 'translate' THEN
    v_mirror := public.rag_ingest_mirror_processing_status(v_job.status);
    IF v_mirror IS NOT NULL THEN
      UPDATE public.documents d
         SET processing_status = v_mirror
       WHERE d.id = v_job.document_id
         AND d.tenant_key = v_job.tenant_key;
    END IF;
    IF p_status = 'ready' THEN
      UPDATE public.documents d SET status = 'ready' WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    ELSIF p_status = 'failed' THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'quarantined' THEN
      UPDATE public.documents d
         SET status = CASE WHEN d.status = 'quarantined' THEN 'quarantined' ELSE 'failed' END,
             processing_status = CASE WHEN d.status = 'quarantined' THEN 'quarantined' ELSE 'failed' END
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'needs_review' THEN
      UPDATE public.documents d
         SET status = 'ready',
             needs_review = true,
             needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    END IF;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_fail_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_error_class text,
  p_retryable boolean,
  p_last_error text DEFAULT NULL
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_terminal boolean;
  v_last text;
BEGIN
  IF p_error_class IS NULL OR btrim(p_error_class) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_error_class' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_new_retries := v_job.retries + 1;
  v_terminal := (NOT p_retryable) OR v_new_retries > v_job.max_retries;
  v_last := COALESCE(NULLIF(btrim(p_last_error), ''), p_error_class);

  IF v_terminal THEN
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs j
       SET status = 'failed',
           error_class = p_error_class,
           error = v_last,
           dead_letter_at = CASE
             WHEN p_retryable AND v_new_retries > j.max_retries THEN now()
             ELSE NULL
           END,
           retries = v_new_retries,
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           run_after = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
    IF v_job.document_id IS NOT NULL AND v_job.kind <> 'translate' THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    END IF;
  ELSE
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs j
       SET status = 'queued',
           error_class = p_error_class,
           error = v_last,
           retries = v_new_retries,
           run_after = now() + (30 * power(2::numeric, j.retries)) * interval '1 second',
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Source: executed in PGlite (PostgreSQL 18.7, pgvector 0.8.7) this session
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS lexical_tsv tsvector,
                            ADD COLUMN IF NOT EXISTS lexical_version integer;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsvector(p_lexical_text text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT coalesce(string_agg(quote_literal(t.tok) || ':' || least(t.ord, 16383)::text, ' ' ORDER BY t.ord), '')::tsvector
  FROM unnest(string_to_array(coalesce(p_lexical_text, ''), ' ')) WITH ORDINALITY AS t(tok, ord)
  WHERE t.tok <> '' AND octet_length(t.tok) <= 255 AND t.tok !~ '[''\\[:space:]]'
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsquery(p_tokens text[]) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT string_agg(quote_literal(t.tok), ' | ')::tsquery
  FROM (SELECT DISTINCT tok FROM unnest(coalesce(p_tokens, '{}'::text[])) AS u(tok)
        WHERE tok <> '' AND octet_length(tok) <= 255 AND tok !~ '[''\\[:space:]]' LIMIT 64) AS t
$fn$;

CREATE OR REPLACE FUNCTION public.rag_chunks_lexical_tsv() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN NEW.lexical_tsv := public.rag_lexical_tsvector(NEW.lexical_text); RETURN NEW; END $fn$;
DROP TRIGGER IF EXISTS trg_document_chunks_lexical_tsv ON document_chunks;
CREATE TRIGGER trg_document_chunks_lexical_tsv BEFORE INSERT OR UPDATE OF lexical_text ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunks_lexical_tsv();
CREATE INDEX IF NOT EXISTS idx_document_chunks_lexical_tsv ON document_chunks USING gin (lexical_tsv);

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text, p_profile_id text, p_query_embedding vector, p_lexical_tokens text[],
  p_dense_limit integer, p_lexical_limit integer,
  p_date_from date DEFAULT NULL, p_date_to date DEFAULT NULL, p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL, p_doc_types text[] DEFAULT NULL, p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off', p_exact_scan_cutoff integer DEFAULT 0
) RETURNS TABLE (
  leg text, rank integer, chunk_id uuid, document_id uuid, content text, metadata jsonb, chunk_index integer,
  similarity double precision, lexical_score real, doc_type text, language text,
  document_filename text, document_created_at timestamptz, document_metadata jsonb, document_content_preview text,
  dense_mode text
) LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_multi boolean := to_regclass('public.organization_members') IS NOT NULL;
  v_dims integer; v_storage text; v_status text;
  v_tsq tsquery; v_n integer; v_mode text := 'ann';
  v_filter text; v_from text; v_vec text; v_sel text;
BEGIN
  IF p_tenant_key IS NULL OR p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: malformed tenant key' USING ERRCODE = '22023';
  END IF;
  IF v_multi = (p_tenant_key = 's:default') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: tenant key not valid for this deployment mode' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;
  SELECT e.dims, e.storage, e.status INTO v_dims, v_storage, v_status FROM embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  v_filter := ' c.tenant_key = $2 AND c.is_current AND c.status = ''ready'''
    || ' AND ($3::date IS NULL OR c.doc_date >= $3) AND ($4::date IS NULL OR c.doc_date <= $4)'
    || ' AND ($5::text[] IS NULL OR c.source = ANY($5)) AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7)) AND ($8::text[] IS NULL OR c.language = ANY($8)) ';
  v_sel := ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' document_chunks c '; v_vec := format('c.embedding <=> $1::vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(' chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L ', p_profile_id);
      v_vec := format('(e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)', v_dims);
    END IF;
    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*) FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $9) s'
        INTO v_n USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages, p_exact_scan_cutoff + 1;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;
    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true); END IF;
    END IF;
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $9) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $9) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages, p_dense_limit;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
    v_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score FROM document_chunks c WHERE ' || v_filter
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $9) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(v_sel, CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
                            THEN format('(1 - (c.embedding <=> $10::vector(%s)))::double precision', v_dims)
                            ELSE 'NULL::double precision' END, 't.score', 'n/a')
      || ' FROM hits t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages, p_lexical_limit, p_query_embedding;
  END IF;
END $fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer)
  TO service_role;

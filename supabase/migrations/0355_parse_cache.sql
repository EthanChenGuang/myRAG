-- 0355: tenant-scoped parse cache RPCs keyed through ingestion_jobs (D-20, F-12, A-6).

BEGIN;

CREATE OR REPLACE FUNCTION rag_parse_cache_version_segment(p_parser_version text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT left(encode(sha256(convert_to(p_parser_version, 'UTF8')), 'hex'), 16);
$$;

CREATE OR REPLACE FUNCTION rag_parse_cache_assert_key_parts(p_parser text, p_options_hash text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_parser IS NULL OR p_parser !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_parser' USING ERRCODE = '22023';
  END IF;
  IF p_options_hash IS NULL OR p_options_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_options_hash' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_prefix(
  p_job_id uuid,
  p_parser text,
  p_parser_version text,
  p_options_hash text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
  v_segment text;
BEGIN
  PERFORM rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
  RETURN NULL;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_segment := rag_parse_cache_version_segment(p_parser_version);
  RETURN v_job.tenant_key
    || '/_parse-cache/'
    || v_job.file_sha256
    || '/'
    || p_parser
    || '-'
    || v_segment
    || '-'
    || p_options_hash
    || '/';
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_lookup(
  p_job_id uuid,
  p_parser text,
  p_parser_version text,
  p_options_hash text
)
RETURNS SETOF public.rag_parse_cache
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
BEGIN
  PERFORM rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT c.*
    FROM rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_put(
  p_job_id uuid,
  p_parser text,
  p_parser_version text,
  p_options_hash text,
  p_object_prefix text,
  p_result jsonb DEFAULT '{}'::jsonb,
  p_byte_size bigint DEFAULT NULL
)
RETURNS public.rag_parse_cache
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
  v_expected text;
  v_row public.rag_parse_cache%ROWTYPE;
BEGIN
  PERFORM rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_expected := rag_parse_cache_prefix(p_job_id, p_parser, p_parser_version, p_options_hash);
  IF p_object_prefix IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'parse_cache_refused: prefix_mismatch' USING ERRCODE = '22023';
  END IF;
  INSERT INTO rag_parse_cache (
    tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix, result, byte_size
  )
  VALUES (
    v_job.tenant_key, v_job.file_sha256, p_parser, p_parser_version, p_options_hash, p_object_prefix,
    COALESCE(p_result, '{}'::jsonb), p_byte_size
  )
  ON CONFLICT (tenant_key, file_sha256, parser, parser_version, options_hash) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN v_row;
  END IF;
  SELECT c.* INTO v_row
    FROM rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_set_document_parse_cache(
  p_job_id uuid,
  p_cache_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
  v_cache record;
  v_doc_tenant text;
BEGIN
  SELECT j.tenant_key, j.document_id INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.document_id IS NULL THEN
    RAISE EXCEPTION 'parse_cache_refused: document_not_linked' USING ERRCODE = '22023';
  END IF;
  SELECT c.id, c.tenant_key INTO v_cache FROM rag_parse_cache c WHERE c.id = p_cache_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_cache.tenant_key IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT d.tenant_key INTO v_doc_tenant FROM documents d WHERE d.id = v_job.document_id;
  IF v_doc_tenant IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: document_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  UPDATE documents d SET parse_cache_id = p_cache_id
   WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_for_document(
  p_tenant_key text,
  p_document_id uuid
)
RETURNS SETOF public.rag_parse_cache
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM rag_ingest_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT c.*
    FROM documents d
    JOIN rag_parse_cache c ON c.id = d.parse_cache_id
   WHERE d.id = p_document_id
     AND d.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key;
END;
$$;

REVOKE ALL ON FUNCTION rag_parse_cache_version_segment(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_parse_cache_assert_key_parts(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_prefix(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_lookup(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_put(uuid, text, text, text, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_set_document_parse_cache(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_for_document(text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_parse_cache_version_segment(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_parse_cache_assert_key_parts(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_prefix(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_lookup(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_put(uuid, text, text, text, text, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_set_document_parse_cache(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_for_document(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
-- 0402: Service-role batch helpers for npm run rag:relex (Phase 4, D-08).
-- Candidates page by chunk id where lexical_version differs from the target version; the batch rewrites lexical_text and version only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_relex_candidates(
  p_after uuid,
  p_version integer,
  p_limit integer,
  p_tenant_key text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  metadata jsonb,
  language text,
  document_filename text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'relex_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT c.id,
         c.tenant_key,
         c.content,
         c.section_path,
         c.chunk_kind,
         c.metadata,
         c.language,
         d.filename AS document_filename
  FROM document_chunks c
  JOIN documents d ON d.id = c.document_id
  WHERE c.is_current
    AND c.status = 'ready'
    AND c.lexical_version IS DISTINCT FROM p_version
    AND (p_after IS NULL OR c.id > p_after)
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
  ORDER BY c.id
  LIMIT p_limit;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rag_relex_batch(p_rows jsonb, p_version integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_row jsonb;
  v_count integer := 0;
BEGIN
  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'relex_refused: invalid_version' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) AS e(value) LOOP
    IF jsonb_typeof(v_row) <> 'object' OR NOT (v_row ? 'id') OR jsonb_typeof(v_row -> 'id') IS DISTINCT FROM 'string' THEN
      CONTINUE;
    END IF;
    UPDATE document_chunks c
    SET lexical_text = v_row ->> 'lexical_text',
        lexical_version = p_version,
        metadata = jsonb_set(coalesce(c.metadata, '{}'::jsonb), '{lexical_version}', to_jsonb(p_version), true),
        language = CASE
          WHEN c.language IS NULL AND v_row ? 'language' THEN NULLIF(v_row ->> 'language', '')
          ELSE c.language
        END
    WHERE c.id = (v_row ->> 'id')::uuid
      AND c.is_current
      AND c.status = 'ready';
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rag_relex_candidates(uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_relex_batch(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_relex_candidates(uuid, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_relex_batch(jsonb, integer) TO service_role;

COMMIT;
-- 0653: fine-tune vector export (Phase 6.1, D-11, D-27, D-28, D-32).
-- rag_finetune_export_vectors hands the operator CLI (npm run rag:finetune -- export-vectors) the stored vectors of one profile for the
-- current, ready chunks of exactly one tenant, in chunk id order after a keyset cursor. The legacy_column profile reads
-- document_chunks.embedding; every other profile reads chunk_embeddings. The tenant's consent is checked inside the function through
-- rag_finetune_consent_for_export on every call, so a revocation between two pages or two commands stops the export.
-- Refusals: export_refused: consent (42501), unknown_profile (P0002), unbound (55000), invalid_limit (22023); a malformed or other-mode
-- tenant key raises tenant_key_invalid: (22023). Service role only.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_finetune_export_vectors(
  p_tenant_key text,
  p_purpose text,
  p_profile_id text,
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (chunk_id uuid, embedding real[], embedding_model text, dims integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'export_refused: invalid_limit (1 to 1000)' USING ERRCODE = '22023';
  END IF;

  BEGIN
    PERFORM public.rag_finetune_consent_for_export(ARRAY[p_tenant_key], p_purpose);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'export_refused: consent of % does not cover %', p_tenant_key, p_purpose USING ERRCODE = '42501';
  END;

  SELECT * INTO v_profile FROM public.embedding_profiles AS p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_refused: unknown_profile' USING ERRCODE = 'P0002';
  END IF;
  IF v_profile.model = 'unbound' THEN
    RAISE EXCEPTION 'export_refused: unbound (profile % has no model bound)', v_profile.id USING ERRCODE = '55000';
  END IF;

  IF v_profile.storage = 'legacy_column' THEN
    RETURN QUERY
      SELECT c.id, (c.embedding)::real[], v_profile.model, v_profile.dims
      FROM public.document_chunks AS c
      JOIN public.documents AS d ON d.id = c.document_id
      WHERE c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready' AND c.embedding IS NOT NULL
        AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
        AND (p_after IS NULL OR c.id > p_after)
      ORDER BY c.id
      LIMIT p_limit;
  ELSE
    RETURN QUERY
      SELECT c.id, ((e.embedding)::public.vector)::real[], e.embedding_model, e.dims
      FROM public.chunk_embeddings AS e
      JOIN public.document_chunks AS c ON c.id = e.chunk_id
      JOIN public.documents AS d ON d.id = c.document_id
      WHERE e.profile_id = v_profile.id AND e.tenant_key = p_tenant_key
        AND c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready'
        AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
        AND (p_after IS NULL OR c.id > p_after)
      ORDER BY c.id
      LIMIT p_limit;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_export_vectors(text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_export_vectors(text, text, text, uuid, integer) TO service_role;

COMMIT;

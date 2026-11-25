-- 0817: Scope tags chosen at upload (plan 03.2-43; D-40; DATA-18).
-- The ingest pipeline sets the uploader's tags on the version it has just begun, before any chunk is written, so the chunk writers (0801)
-- copy them onto every chunk. rag_set_document_scopes (0805) cannot serve this path: it admits a tenant admin or the document's user_id,
-- and a single-tenant document has no user_id, so a member's upload there could never carry its tags.
-- rag_set_upload_scopes writes only a version that is still being ingested (status 'processing', not current): a published, held,
-- quarantined or retired document is refused with not_found, so the function cannot retag existing documents; that stays with
-- rag_set_document_scopes. The route has already admitted the uploader for this workspace and checked the tags; the tags are checked again
-- here against the tenant's ACTIVE vocabulary only (a retired value is refused, unknown_scope_value), at most 20 (too_many_scopes), no
-- NULL. The tenant comes from p_tenant_key (rag_assert_tenant_key), and a document of another tenant is a miss (not_found).
-- No cache invalidation: a processing, not-current version is in no retrieval result and in no cache entry (Phase 3 D-08).
-- Purge: no new store; documents.scopes and document_chunks.scopes are cleared by rag_purge_hook_scope_tags (0805).
-- service_role only. Not folded into the setup files. Idempotent: CREATE OR REPLACE.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_set_upload_scopes(p_document_id uuid, p_tenant_key text, p_scopes text[])
 RETURNS TABLE(document_id uuid, scopes text[])
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_scopes text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL OR p_scopes IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  SELECT d.id INTO v_id
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status = 'processing' AND NOT d.is_current
  FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF pg_catalog.array_position(p_scopes, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'unknown_scope_value';
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT t.tag ORDER BY t.tag), '{}'::text[]) INTO v_scopes
  FROM pg_catalog.unnest(p_scopes) AS u(raw)
  CROSS JOIN LATERAL (SELECT u.raw COLLATE "C" AS tag) AS t;
  IF pg_catalog.cardinality(v_scopes) > 20 THEN
    RAISE EXCEPTION 'too_many_scopes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_scopes) AS s(tag)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rag_scope_vocabulary v
      WHERE v.tenant_key = p_tenant_key AND v.active AND (v.dimension || ':' || v.value) = s.tag
    )
  ) THEN
    RAISE EXCEPTION 'unknown_scope_value';
  END IF;

  UPDATE public.documents d SET scopes = v_scopes WHERE d.id = v_id;
  UPDATE public.document_chunks c SET scopes = v_scopes WHERE c.document_id = v_id;

  RETURN QUERY SELECT v_id, v_scopes;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_set_upload_scopes(uuid, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_upload_scopes(uuid, text, text[]) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

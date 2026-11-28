-- 1007: Attribute identifier feed listing (plan 03.3-16; TPL-04; D-02, D-25; research F-13).
-- Values of attributes flagged in_identifier_index reach identifiers_norm / identifiers_raw only through the Phase 4.2 indexer
-- (indexDocumentForLookup); this migration writes no identifier column. The 4.2 backfill listing (rag_index_backfill_documents) skips
-- documents that are already indexed, so a re-index after a definition's flag changed needs its own population:
--   rag_attribute_identifier_documents  keyset listing, in id order after the cursor, of the tenant's ready, non-provisional documents
--                                       that are current or superseded and whose attributes are a non-empty object. At most 1,000 rows
--                                       per call (ERRCODE 22023 outside 1..1000).
-- SECURITY INVOKER with an empty search_path; asserts the tenant key first (a key of the other deployment mode is rejected) and names the
-- tenant in every predicate; service_role only (REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role).
-- Purge: no new store. Idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_attribute_identifier_documents(p_tenant_key text, p_after uuid, p_limit integer)
RETURNS TABLE (document_id uuid, is_current boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'limit must be within 1..1000' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT d.id, d.is_current
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.status = 'ready'
    AND NOT d.provisional
    AND (d.is_current OR d.superseded_by IS NOT NULL)
    AND d.attributes IS NOT NULL
    AND pg_catalog.jsonb_typeof(d.attributes) = 'object'
    AND d.attributes <> '{}'::jsonb
    AND (p_after IS NULL OR d.id > p_after)
  ORDER BY d.id
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_attribute_identifier_documents(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_identifier_documents(text, uuid, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

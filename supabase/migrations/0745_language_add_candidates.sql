-- Phase 7 plan 07-52 (LANG-11): the documents a language addition may reprocess.
-- rag_language_add_candidates lists current, ready documents with their stored fingerprint parts and two flags computed here:
-- has_und (the document's language list contains und) and scanned (doc type scanned_image, or a stored processing profile of
-- scanned_image). The app adds the third group, documents whose stored fingerprint differs under the proposed settings, with the
-- Phase 3.2 comparison, and never selects a document in none of the three groups.
-- Tenant rule of 0808 rag_fingerprint_groups: the tenant comes only from p_tenant_key, checked by rag_assert_tenant_key; NULL means
-- every tenant (deployment admin and CLI), and every row carries its own tenant key. Keyset pages by document id.
-- SECURITY INVOKER with an empty search_path and schema-qualified names; service_role only. No new store, so no purge hook.
-- Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_language_add_candidates(
  p_tenant_key text DEFAULT NULL,
  p_after uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  doc_type text,
  ingest_fingerprint text,
  parts jsonb,
  has_und boolean,
  scanned boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;

  RETURN QUERY
  SELECT d.id,
         d.tenant_key,
         d.doc_type,
         d.ingest_fingerprint,
         CASE WHEN d.ingest_fingerprint IS NULL THEN NULL ELSE d.metadata -> 'ingest_fingerprint_parts' END AS parts,
         ('und' = ANY (d.languages)) AS has_und,
         (d.doc_type = 'scanned_image'
           OR pg_catalog.split_part(COALESCE(d.metadata -> 'ingest_fingerprint_parts' ->> 'processing_profile_id', ''), '@', 1) = 'scanned_image') AS scanned
    FROM public.documents d
   WHERE d.is_current
     AND d.status = 'ready'
     AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
     AND (p_after IS NULL OR d.id > p_after)
   ORDER BY d.id
   LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_language_add_candidates(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_language_add_candidates(text, uuid, integer) TO service_role;

COMMIT;

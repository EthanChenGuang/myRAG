-- 0941: documents.version_label and its setter (Phase 5.2, D-02, D-49).
-- version_label is an optional admin-set name for a document version (for example a title's version marker); when null the integer
-- documents.version is shown. It is rendered into context block headers, so it is limited to 40 characters and may not hold control characters.
-- rag_set_document_version_label takes the tenant only from p_tenant_key, checked first by rag_assert_tenant_key, and updates only a document whose
-- generated tenant_key equals it; it returns false when no such document exists (missing, or another tenant's). The label is trimmed and an empty
-- label is stored as null. SECURITY INVOKER with an empty search_path, service_role only (locked again in 0410). Not folded into the setup files.
-- Idempotent.

BEGIN;

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS version_label text;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_version_label_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_version_label_check
      CHECK (version_label IS NULL OR (pg_catalog.char_length(version_label) <= 40 AND version_label !~ '[[:cntrl:]]'));
  END IF;
END
$constraints$;

CREATE OR REPLACE FUNCTION public.rag_set_document_version_label(p_tenant_key text, p_document_id uuid, p_label text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_label text;
  v_updated integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'document id is required' USING ERRCODE = '22023';
  END IF;
  v_label := NULLIF(pg_catalog.btrim(p_label), '');
  IF v_label IS NOT NULL AND (pg_catalog.char_length(v_label) > 40 OR v_label ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'version label must be at most 40 characters without control characters' USING ERRCODE = '22023';
  END IF;

  UPDATE public.documents d
  SET version_label = v_label
  WHERE d.id = p_document_id
    AND d.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_set_document_version_label(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_document_version_label(text, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

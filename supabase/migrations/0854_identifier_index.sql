-- 0854: Phase 4.2 identifier index schema (RET-15, RET-16, D-28, D-29).
-- document_chunks and documents gain identifiers_norm (normalized identifiers, GIN) and identifiers_raw (original spellings); both stay
-- null until the write stage or the backfill of a later plan fills them. rag_identifier_patterns holds the admin-defined identifier patterns
-- of one tenant: name at most 80 characters, pattern at most 200, flags u or iu, unique per tenant and name. RLS is on with no policies;
-- only service_role reaches the table (admin routes of a later plan), and the shared tenant key guard of 0853 checks the key format.
-- Purge: rag_purge_hook_identifiers(p_tenant_key, p_lineage_id, p_document_ids) clears both columns on the purged documents and their
-- chunks. rag_identifier_patterns is tenant configuration, not document data, so no lineage purge applies to it.
-- Existing rows keep null in every new column. Idempotent; not folded into the setup files.

BEGIN;

DO $identifier_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_row_tenant_key_guard()') IS NULL THEN
    RAISE EXCEPTION '0854: apply 0853 first' USING ERRCODE = '55000';
  END IF;
END
$identifier_precheck$;

ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS identifiers_norm text[];
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS identifiers_raw text[];
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS identifiers_norm text[];
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS identifiers_raw text[];

CREATE INDEX IF NOT EXISTS idx_document_chunks_identifiers_norm ON public.document_chunks USING gin (identifiers_norm);
CREATE INDEX IF NOT EXISTS idx_documents_identifiers_norm ON public.documents USING gin (identifiers_norm);

CREATE TABLE IF NOT EXISTS public.rag_identifier_patterns (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  name text NOT NULL,
  pattern text NOT NULL,
  flags text NOT NULL DEFAULT 'u',
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_identifier_patterns_name_check CHECK (pg_catalog.length(pg_catalog.btrim(name)) >= 1 AND pg_catalog.length(name) <= 80),
  CONSTRAINT rag_identifier_patterns_pattern_check CHECK (pg_catalog.length(pattern) BETWEEN 1 AND 200),
  CONSTRAINT rag_identifier_patterns_flags_check CHECK (flags IN ('u', 'iu')),
  CONSTRAINT rag_identifier_patterns_tenant_name_ux UNIQUE (tenant_key, name)
);

ALTER TABLE public.rag_identifier_patterns ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_identifier_patterns FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_identifier_patterns TO service_role;

DROP TRIGGER IF EXISTS rag_identifier_patterns_tenant_key_guard ON public.rag_identifier_patterns;
CREATE TRIGGER rag_identifier_patterns_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_identifier_patterns
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

-- Purge hook (phase rule: every new 4.2 store). Returns the number of document and chunk rows changed.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_identifiers(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_docs uuid[];
  v_documents bigint;
  v_chunks bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT COALESCE(pg_catalog.array_agg(d.id), '{}'::uuid[]) INTO v_docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])));
  UPDATE public.documents d
     SET identifiers_norm = NULL, identifiers_raw = NULL
   WHERE d.id = ANY (v_docs) AND (d.identifiers_norm IS NOT NULL OR d.identifiers_raw IS NOT NULL);
  GET DIAGNOSTICS v_documents = ROW_COUNT;
  UPDATE public.document_chunks c
     SET identifiers_norm = NULL, identifiers_raw = NULL
   WHERE c.tenant_key = p_tenant_key AND c.document_id = ANY (v_docs) AND (c.identifiers_norm IS NOT NULL OR c.identifiers_raw IS NOT NULL);
  GET DIAGNOSTICS v_chunks = ROW_COUNT;
  RETURN v_documents + v_chunks;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_identifiers(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_identifiers(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

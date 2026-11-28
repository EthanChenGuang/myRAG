-- 0820: what the chunk translation producer needs on top of 0810 (Phase 3.2, XLG-04; D-28, D-29; plan 03.2-49).
-- * source_content_hash is the sha256 of the chunk content's UTF-8 bytes, always (0810 preferred the normalised content_hash): any change
--   of the source text, a single accent included, makes a stored translation stale. rag_translation_eligible_chunks is replaced with that
--   rule; rag_translation_coverage and rag_translation_pending_page read it, so they follow.
-- * chunk_translation_gaps records a chunk the producer skipped for one target (too long, a protected token lost, no usable output),
--   with the source hash it was tried on. A gap for the current hash keeps the chunk out of the pending page and scans until the source
--   changes; it goes with its chunk (ON DELETE CASCADE) and has a purge hook.
-- * rag_translation_pending_scan pages the pending chunks of one target by chunk id (keyset), optionally for one document;
--   rag_translation_pending_count counts them; rag_translation_vectors_missing pages up-to-date translations that lack a vector of one
--   profile (the re-embed path after a global profile flip); rag_record_translation_gaps writes gaps.
-- Everything is for the server role only: RLS on without policies, nothing granted to anon or authenticated, every function SECURITY
-- INVOKER with SET search_path = '' and schema-qualified names; the tenant comes only from p_tenant_key (rag_assert_tenant_key first).
-- Not folded into the setup files. Idempotent: IF NOT EXISTS and CREATE OR REPLACE. Re-running 0810 after this file puts back the 0810
-- eligible and pending bodies: re-run 0820 after it.

BEGIN;

DO $producer_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.chunk_translations') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_translation_eligible_chunks(text, text)') IS NULL THEN
    RAISE EXCEPTION '0820: apply 0810 first' USING ERRCODE = '55000';
  END IF;
END
$producer_precheck$;

CREATE TABLE IF NOT EXISTS public.chunk_translation_gaps (
  chunk_id uuid NOT NULL REFERENCES public.document_chunks (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  language text NOT NULL CONSTRAINT chunk_translation_gaps_language_check CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  source_content_hash text NOT NULL,
  reason text NOT NULL CONSTRAINT chunk_translation_gaps_reason_check
    CHECK (reason IN ('too_long', 'protected_token_lost', 'empty_output', 'invalid_output')),
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, language)
);

CREATE INDEX IF NOT EXISTS chunk_translation_gaps_tenant_language_idx ON public.chunk_translation_gaps (tenant_key, language);
CREATE INDEX IF NOT EXISTS chunk_translation_gaps_document_idx ON public.chunk_translation_gaps (document_id);

CREATE OR REPLACE FUNCTION public.rag_chunk_translation_gaps_guard()
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
    RAISE EXCEPTION 'chunk_translation_gaps: source chunk has no tenant_key' USING ERRCODE = '23502';
  END IF;
  IF NEW.tenant_key IS NOT NULL AND NEW.tenant_key IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'chunk_translation_gaps: tenant_mismatch' USING ERRCODE = '42501';
  END IF;
  IF NEW.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM v_document THEN
    RAISE EXCEPTION 'chunk_translation_gaps: document_mismatch' USING ERRCODE = '22023';
  END IF;
  NEW.tenant_key := v_tenant;
  NEW.document_id := v_document;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.rag_chunk_translation_gaps_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_translation_gaps_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_chunk_translation_gaps_guard ON public.chunk_translation_gaps;
CREATE TRIGGER rag_chunk_translation_gaps_guard
  BEFORE INSERT OR UPDATE OF chunk_id, document_id, tenant_key ON public.chunk_translation_gaps
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunk_translation_gaps_guard();

ALTER TABLE public.chunk_translation_gaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chunk_translation_gaps FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.chunk_translation_gaps TO service_role;

-- The 0810 eligibility rule with the byte hash: sha256 of the chunk content's UTF-8 bytes, whatever content_hash holds.
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
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.content, 'UTF8')), 'hex')
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

-- The 0810 pending page, with a gap recorded for the current source hash counting as handled.
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
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_translation_gaps g
      WHERE g.chunk_id = e.chunk_id AND g.language = p_language AND g.tenant_key = p_tenant_key AND g.source_content_hash = e.source_content_hash
    )
  ORDER BY e.document_id, c.chunk_index NULLS LAST, e.chunk_id
  LIMIT p_limit;
END
$fn$;

-- Pending chunks of one target in chunk id order after p_after (keyset), optionally of one document.
CREATE OR REPLACE FUNCTION public.rag_translation_pending_scan(
  p_tenant_key text,
  p_language text,
  p_document_id uuid,
  p_after uuid,
  p_limit integer
)
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
  WHERE (p_document_id IS NULL OR e.document_id = p_document_id)
    AND (p_after IS NULL OR e.chunk_id > p_after)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_translations t
      WHERE t.chunk_id = e.chunk_id AND t.language = p_language AND t.tenant_key = p_tenant_key AND t.source_content_hash = e.source_content_hash
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_translation_gaps g
      WHERE g.chunk_id = e.chunk_id AND g.language = p_language AND g.tenant_key = p_tenant_key AND g.source_content_hash = e.source_content_hash
    )
  ORDER BY e.chunk_id
  LIMIT p_limit;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_translation_pending_count(p_tenant_key text, p_language text, p_document_id uuid)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_language IS NULL OR p_language !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' THEN
    RAISE EXCEPTION 'translation_refused: invalid_language' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_n
  FROM public.rag_translation_eligible_chunks(p_tenant_key, p_language) e
  WHERE (p_document_id IS NULL OR e.document_id = p_document_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_translations t
      WHERE t.chunk_id = e.chunk_id AND t.language = p_language AND t.tenant_key = p_tenant_key AND t.source_content_hash = e.source_content_hash
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_translation_gaps g
      WHERE g.chunk_id = e.chunk_id AND g.language = p_language AND g.tenant_key = p_tenant_key AND g.source_content_hash = e.source_content_hash
    );
  RETURN v_n;
END
$fn$;

-- Up-to-date translations of current chunks of the tenant that have no vector of p_profile_id, in translation id order after p_after.
CREATE OR REPLACE FUNCTION public.rag_translation_vectors_missing(p_tenant_key text, p_profile_id text, p_after uuid, p_limit integer)
RETURNS TABLE (
  translation_id uuid,
  chunk_id uuid,
  language text,
  content text,
  lexical_text text,
  source_content_hash text,
  model text,
  glossary_version text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NULLIF(p_profile_id, '') IS NULL THEN
    RAISE EXCEPTION 'translation_refused: profile_required' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'translation_refused: limit out of range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT t.id, t.chunk_id, t.language, t.content, t.lexical_text, t.source_content_hash, t.model, t.glossary_version
  FROM public.chunk_translations t
  JOIN public.document_chunks c ON c.id = t.chunk_id
  WHERE t.tenant_key = p_tenant_key AND c.tenant_key = p_tenant_key AND c.is_current
    AND t.source_content_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(c.content, 'UTF8')), 'hex')
    AND (p_after IS NULL OR t.id > p_after)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_translation_embeddings v WHERE v.translation_id = t.id AND v.profile_id = p_profile_id
    )
  ORDER BY t.id
  LIMIT p_limit;
END
$fn$;

-- Gap writer. p_rows: objects with chunk_id, language, source_content_hash, reason and model; one gap per (chunk, language), replaced on
-- a second write. Every chunk must belong to p_tenant_key; any other row refuses the whole call. Returns the number of rows written.
CREATE OR REPLACE FUNCTION public.rag_record_translation_gaps(p_tenant_key text, p_rows jsonb)
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
  v_n integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'translation_refused: rows_must_be_array' USING ERRCODE = '22023';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) AS e(value) LOOP
    IF jsonb_typeof(v_row) <> 'object' OR NULLIF(v_row ->> 'chunk_id', '') IS NULL OR NULLIF(v_row ->> 'language', '') IS NULL
       OR NULLIF(v_row ->> 'source_content_hash', '') IS NULL OR NULLIF(v_row ->> 'reason', '') IS NULL OR NULLIF(v_row ->> 'model', '') IS NULL THEN
      RAISE EXCEPTION 'translation_refused: invalid_row' USING ERRCODE = '22023';
    END IF;
    v_chunk := (v_row ->> 'chunk_id')::uuid;
    SELECT c.tenant_key INTO v_tenant FROM public.document_chunks c WHERE c.id = v_chunk;
    IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'translation_refused: chunk_tenant_mismatch' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.chunk_translation_gaps (chunk_id, tenant_key, language, source_content_hash, reason, model)
    VALUES (v_chunk, p_tenant_key, v_row ->> 'language', v_row ->> 'source_content_hash', v_row ->> 'reason', v_row ->> 'model')
    ON CONFLICT (chunk_id, language) DO UPDATE
      SET source_content_hash = EXCLUDED.source_content_hash, reason = EXCLUDED.reason, model = EXCLUDED.model, created_at = now();
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$fn$;

-- Purge hook for the gap store: the tenant's gaps of the given documents and of every version of the given lineage.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_chunk_translation_gaps(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
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
  DELETE FROM public.chunk_translation_gaps g
  WHERE g.tenant_key = p_tenant_key
    AND (
      g.document_id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      OR (
        p_lineage_id IS NOT NULL
        AND g.document_id IN (SELECT d.id FROM public.documents d WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key)
      )
    );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_translation_eligible_chunks(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_pending_page(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_pending_scan(text, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_pending_count(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_translation_vectors_missing(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_record_translation_gaps(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_chunk_translation_gaps(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_translation_eligible_chunks(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_pending_page(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_pending_scan(text, text, uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_pending_count(text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_translation_vectors_missing(text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_record_translation_gaps(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_chunk_translation_gaps(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- 1004: Review flag of the ingest preparation step (plan 03.3-10; D-10, D-13; TPL-02, TPL-08).
-- Page boilerplate cleaning and section rules mark a document for review without holding it back: the document is still published.
-- rag_flag_document_review sets documents.needs_review, keeps the first needs_review_reason, and appends the code once to
-- metadata.review_reasons (a repeated call changes nothing). Only three codes are accepted (22023 otherwise). No status predicate: the
-- re-chunk command flags a published document as well. The tenant comes from p_tenant_key (rag_assert_tenant_key), and a document of
-- another tenant is a miss (not_found), so nothing changes there.
-- Purge: no new store; the flag and the metadata key go with the document row.
-- service_role only, invoker rights, empty search_path. Not folded into the setup files. Idempotent: CREATE OR REPLACE.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_flag_document_review(p_document_id uuid, p_tenant_key text, p_reason text)
 RETURNS TABLE(document_id uuid, needs_review boolean, needs_review_reason text, review_reasons jsonb)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_reasons jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL OR p_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_reason NOT IN ('section_rules_not_satisfied', 'boilerplate_above_threshold', 'tenant_pattern_timeout') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'reason';
  END IF;

  SELECT d.id,
         CASE WHEN pg_catalog.jsonb_typeof(d.metadata -> 'review_reasons') = 'array' THEN d.metadata -> 'review_reasons' ELSE '[]'::jsonb END
    INTO v_id, v_reasons
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key
  FOR UPDATE;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF NOT (v_reasons @> pg_catalog.jsonb_build_array(p_reason)) THEN
    v_reasons := v_reasons || pg_catalog.jsonb_build_array(p_reason);
  END IF;

  UPDATE public.documents d
     SET needs_review = true,
         needs_review_reason = COALESCE(d.needs_review_reason, p_reason),
         metadata = COALESCE(d.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('review_reasons', v_reasons)
   WHERE d.id = v_id AND d.tenant_key = p_tenant_key;

  RETURN QUERY
  SELECT d.id, d.needs_review, d.needs_review_reason, d.metadata -> 'review_reasons'
  FROM public.documents d
  WHERE d.id = v_id AND d.tenant_key = p_tenant_key;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_flag_document_review(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_flag_document_review(uuid, text, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

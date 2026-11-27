-- 0706: Phase 7 activation gate for external backends (D-06, RET-05, RET-09).
-- rag_activate_embedding_profile keeps the 0425 body (every Phase 3 refusal, in the same order) and adds one condition after them:
-- for each enabled target in rag_vector_sync_targets (qdrant first, then weaviate), every tenant with current ready chunks must have a
-- rag_backend_index_state row in state ready for that target and the target profile, otherwise activation raises
-- `external_not_ready:<target>` (55000) and changes nothing. With no target enabled the gate is the 0425 gate.
-- rag_rollback_embedding_profile is not changed: rolling back is never gated on an external index.
-- Signature, SECURITY DEFINER, search_path, statement_timeout and grants are unchanged. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_activate_embedding_profile(p_target text, p_actor text)
 RETURNS TABLE(activated_profile text, previous_profile text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_target public.embedding_profiles%ROWTYPE;
  v_active text;
  v_missing bigint;
  v_bad bigint;
  v_evidence jsonb;
  v_recorded timestamptz;
  v_last timestamptz;
  v_slice_ok boolean;
  v_ext_target text;
  v_ext_missing bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'activation_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_target FROM public.embedding_profiles WHERE id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_target.status = 'active' THEN
    RAISE EXCEPTION 'activation_refused: already_active' USING ERRCODE = '55000';
  END IF;
  SELECT p.id INTO v_active FROM public.embedding_profiles p WHERE p.status = 'active';

  IF v_target.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p_target);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'activation_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, p_target
      USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    SELECT count(*) INTO v_bad FROM public.chunk_embeddings e
    WHERE e.profile_id = p_target AND (e.embedding_model <> v_target.model OR e.dims <> v_target.dims);
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'activation_refused: model_mismatch (% rows of profile % differ from model % at % dims)', v_bad, p_target, v_target.model, v_target.dims
        USING ERRCODE = '55000';
    END IF;
  END IF;

  v_evidence := v_target.eval_evidence;
  IF v_evidence IS NULL OR jsonb_typeof(v_evidence) <> 'object' THEN
    RAISE EXCEPTION 'activation_refused: eval_missing' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'target_profile' IS DISTINCT FROM p_target THEN
    RAISE EXCEPTION 'activation_refused: eval_target_mismatch' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'baseline_profile' IS DISTINCT FROM v_active THEN
    RAISE EXCEPTION 'activation_refused: eval_baseline_mismatch (evidence baseline %, active profile %)', v_evidence->>'baseline_profile', v_active
      USING ERRCODE = '55000';
  END IF;
  IF v_evidence->'gate_passed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'activation_refused: eval_failed' USING ERRCODE = '55000';
  END IF;
  v_slice_ok := coalesce(v_evidence#>'{pre_migration,passed}' = 'true'::jsonb, false)
    AND coalesce(CASE WHEN jsonb_typeof(v_evidence#>'{pre_migration,n}') = 'number' THEN (v_evidence#>>'{pre_migration,n}')::numeric >= 1 END, false);
  IF NOT v_slice_ok THEN
    RAISE EXCEPTION 'activation_refused: pre_migration_missing' USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.embedding_backfill_runs r
      WHERE r.id::text = v_evidence->>'backfill_run_id' AND r.profile_id = p_target AND r.status = 'completed'
    ) THEN
      RAISE EXCEPTION 'activation_refused: eval_run_mismatch' USING ERRCODE = '55000';
    END IF;
    SELECT max(e.embedded_at) INTO v_last FROM public.chunk_embeddings e WHERE e.profile_id = p_target;
  ELSE
    SELECT max(c.created_at) INTO v_last FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NOT NULL;
  END IF;

  BEGIN
    v_recorded := (v_evidence->>'recorded_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_recorded := NULL;
  END;
  IF v_recorded IS NULL OR (v_last IS NOT NULL AND v_recorded < v_last) THEN
    RAISE EXCEPTION 'activation_refused: eval_stale (evidence recorded %, data embedded %)', v_recorded, v_last USING ERRCODE = '55000';
  END IF;

  FOR v_ext_target IN
    SELECT t.target FROM public.rag_vector_sync_targets t
    WHERE t.enabled
    ORDER BY CASE t.target WHEN 'qdrant' THEN 0 WHEN 'weaviate' THEN 1 ELSE 2 END, t.target
  LOOP
    SELECT count(*) INTO v_ext_missing
    FROM (
      SELECT DISTINCT c.tenant_key FROM public.document_chunks c
      WHERE c.is_current AND c.status = 'ready' AND c.tenant_key IS NOT NULL
    ) k
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rag_backend_index_state s
      WHERE s.target = v_ext_target AND s.profile_id = p_target AND s.tenant_key = k.tenant_key AND s.state = 'ready'
    );
    IF v_ext_missing > 0 THEN
      RAISE EXCEPTION 'external_not_ready:% (% tenants with current documents have no ready % index for profile %)', v_ext_target, v_ext_missing, v_ext_target, p_target
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active';
  UPDATE public.embedding_profiles
  SET status = 'active', previous_active_id = v_active, activated_at = now(), activated_by = p_actor
  WHERE id = p_target;

  RETURN QUERY SELECT p_target, v_active;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_activate_embedding_profile(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_activate_embedding_profile(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

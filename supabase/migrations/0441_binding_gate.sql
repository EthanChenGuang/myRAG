-- 0441: the binding gate (Phase 3.1.1, D-06, D-09, D-10, D-11, D-13, D-27).
-- A binding (0440) adds a scoped profile's vectors to every query of one doc type, for one tenant or deployment-wide. These functions are the
-- only way a binding row changes status: list, create, stage (available, backfilling, retired), record evidence, activate through the gate,
-- roll back to the previous binding and deactivate. Activation needs a complete index of the binding's scope and evidence proven on real
-- items; rollback and deactivate are pointer flips that delete no vector.
-- Every refusal starts with 'binding_refused: <code>' (the prefix the TS mapper reads, 03-40). Every function is SECURITY DEFINER with
-- SET search_path = '' and schema-qualified names (the 0425 rule), revoked from PUBLIC, anon and authenticated and granted to service_role.
-- The tenant is never taken from the caller beyond the binding row: completeness counts only the binding's tenant (all tenants for a
-- deployment-wide row), so one tenant's chunks never refuse or change another tenant's binding.
-- Idempotent: CREATE OR REPLACE and REVOKE/GRANT only.

BEGIN;

DO $binding_gate_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.embedding_profile_bindings') IS NULL OR pg_catalog.to_regprocedure('public.rag_embedding_bindings_guard()') IS NULL THEN
    RAISE EXCEPTION '0441: apply 0440 first' USING ERRCODE = '55000';
  END IF;
END
$binding_gate_precheck$;

-- Registry reads (D-06).

CREATE OR REPLACE FUNCTION public.rag_list_embedding_bindings()
RETURNS TABLE(
  id uuid, doc_type text, tenant_key text, profile_id text, model text, doc_types text[], status text, previous_binding_id uuid,
  has_evidence boolean, baseline_global_profile text, activated_at timestamptz, activated_by text, created_at timestamptz, created_by text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT b.id, b.doc_type, b.tenant_key, b.profile_id, p.model, p.doc_types, b.status, b.previous_binding_id,
         b.eval_evidence IS NOT NULL, b.eval_evidence->>'baseline_global_profile', b.activated_at, b.activated_by, b.created_at, b.created_by
  FROM public.embedding_profile_bindings b
  JOIN public.embedding_profiles p ON p.id = b.profile_id
  ORDER BY b.doc_type, b.tenant_key NULLS FIRST, b.profile_id
$$;

CREATE OR REPLACE FUNCTION public.rag_list_embedding_profile_scopes()
RETURNS TABLE(id text, doc_types text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id, p.doc_types FROM public.embedding_profiles p ORDER BY p.id
$$;

-- Create: returns the existing row for the same (doc type, tenant, profile). The 0440 guard refuses an unscoped profile, a doc type outside
-- the profile's scope and a tenant key of the other deployment mode.

CREATE OR REPLACE FUNCTION public.rag_create_embedding_binding(p_doc_type text, p_tenant_key text, p_profile_id text, p_actor text)
RETURNS TABLE(binding_id uuid, binding_status text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.embedding_profile_bindings%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'binding_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_row FROM public.embedding_profile_bindings b
  WHERE b.doc_type = p_doc_type AND COALESCE(b.tenant_key, '') = COALESCE(p_tenant_key, '') AND b.profile_id = p_profile_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_row.id, v_row.status, false;
    RETURN;
  END IF;

  INSERT INTO public.embedding_profile_bindings (doc_type, tenant_key, profile_id, status, created_by)
  VALUES (p_doc_type, p_tenant_key, p_profile_id, 'available', p_actor)
  RETURNING * INTO v_row;

  RETURN QUERY SELECT v_row.id, v_row.status, true;
END
$$;

-- Staging: available, backfilling and retired only. 'active' is reached through the gate, and an active row changes only through
-- activate, rollback or deactivate.

CREATE OR REPLACE FUNCTION public.rag_set_embedding_binding_status(p_binding_id uuid, p_status text, p_actor text)
RETURNS TABLE(binding_id uuid, binding_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current text;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'binding_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'active' THEN
    RAISE EXCEPTION 'binding_refused: use_activation_gate' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('available', 'backfilling', 'retired') THEN
    RAISE EXCEPTION 'binding_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE;

  SELECT b.status INTO v_current FROM public.embedding_profile_bindings b WHERE b.id = p_binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'binding_refused: unknown_binding' USING ERRCODE = '22023';
  END IF;
  IF v_current = 'active' THEN
    RAISE EXCEPTION 'binding_refused: binding_is_active' USING ERRCODE = '55000';
  END IF;

  BEGIN
    UPDATE public.embedding_profile_bindings b SET status = p_status WHERE b.id = p_binding_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'binding_refused: backfilling_exists' USING ERRCODE = '55000';
  END;

  RETURN QUERY SELECT p_binding_id, p_status;
END
$$;

-- Evidence (D-13): validated against the Pydantic BindingActivationEvidence before the call; here it must name this binding, its profile,
-- doc type and tenant. The gate re-checks every number it relies on.

CREATE OR REPLACE FUNCTION public.rag_record_binding_evidence(p_binding_id uuid, p_evidence jsonb, p_actor text)
RETURNS TABLE(binding_id uuid, recorded_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.embedding_profile_bindings%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'binding_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_row FROM public.embedding_profile_bindings b WHERE b.id = p_binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'binding_refused: unknown_binding' USING ERRCODE = '22023';
  END IF;
  IF v_row.status = 'active' THEN
    RAISE EXCEPTION 'binding_refused: binding_is_active' USING ERRCODE = '55000';
  END IF;
  IF p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'binding_refused: invalid_evidence' USING ERRCODE = '22023';
  END IF;
  IF p_evidence->>'binding_id' IS DISTINCT FROM v_row.id::text
     OR p_evidence->>'target_profile' IS DISTINCT FROM v_row.profile_id
     OR p_evidence->>'doc_type' IS DISTINCT FROM v_row.doc_type
     OR p_evidence->>'tenant_key' IS DISTINCT FROM v_row.tenant_key THEN
    RAISE EXCEPTION 'binding_refused: evidence_mismatch' USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profile_bindings b SET eval_evidence = p_evidence WHERE b.id = p_binding_id;

  RETURN QUERY SELECT p_binding_id, pg_catalog.now();
END
$$;

REVOKE ALL ON FUNCTION
  public.rag_list_embedding_bindings(),
  public.rag_list_embedding_profile_scopes(),
  public.rag_create_embedding_binding(text, text, text, text),
  public.rag_set_embedding_binding_status(uuid, text, text),
  public.rag_record_binding_evidence(uuid, jsonb, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.rag_list_embedding_bindings(),
  public.rag_list_embedding_profile_scopes(),
  public.rag_create_embedding_binding(text, text, text, text),
  public.rag_set_embedding_binding_status(uuid, text, text),
  public.rag_record_binding_evidence(uuid, jsonb, text)
TO service_role;


-- Activation gate (D-09, D-11, D-27), in the order of the Phase 3 gate (0309, newest body in 0425). Scope of a binding: current ready chunks
-- with COALESCE(chunk.doc_type, document.doc_type) = the binding's doc type, of the binding's tenant (every tenant when tenant_key is NULL).
-- The evidence must name the live baselines, pass on at least c_min_real_items real (production or human) items of the doc type, pass every
-- language sub-slice present in it (the keys are data: the deployment's languages, never a list in this function), pass the other slices,
-- name a completed run of the profile covering the binding's tenant, and be newer than the newest vector of the profile in scope. Fixture
-- evidence never reaches the real-items threshold, so it can never activate a binding.

CREATE OR REPLACE FUNCTION public.rag_activate_embedding_binding(p_binding_id uuid, p_actor text)
RETURNS TABLE(activated_binding uuid, previous_binding uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '120s'
AS $$
DECLARE
  c_min_real_items CONSTANT integer := 30;
  v_row public.embedding_profile_bindings%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_previous public.embedding_profile_bindings%ROWTYPE;
  v_has_previous boolean;
  v_global text;
  v_missing bigint;
  v_bad bigint;
  v_evidence jsonb;
  v_slice jsonb;
  v_real numeric;
  v_total numeric;
  v_lang record;
  v_recorded timestamptz;
  v_last timestamptz;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'binding_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.embedding_profiles IN SHARE MODE;

  SELECT * INTO v_row FROM public.embedding_profile_bindings b WHERE b.id = p_binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'binding_refused: unknown_binding' USING ERRCODE = '22023';
  END IF;
  IF v_row.status = 'active' THEN
    RAISE EXCEPTION 'binding_refused: already_active' USING ERRCODE = '55000';
  END IF;
  IF v_row.status NOT IN ('available', 'backfilling') THEN
    RAISE EXCEPTION 'binding_refused: binding_retired' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = v_row.profile_id;
  IF NOT FOUND OR v_profile.doc_types IS NULL OR NOT (v_row.doc_type = ANY (v_profile.doc_types)) THEN
    RAISE EXCEPTION 'binding_refused: profile_scope_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_previous FROM public.embedding_profile_bindings b
  WHERE b.status = 'active' AND b.doc_type = v_row.doc_type AND COALESCE(b.tenant_key, '') = COALESCE(v_row.tenant_key, '');
  v_has_previous := FOUND;
  SELECT p.id INTO v_global FROM public.embedding_profiles p WHERE p.status = 'active';

  SELECT count(*) INTO v_missing
  FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id
  WHERE c.is_current AND c.status = 'ready' AND COALESCE(c.doc_type, d.doc_type) = v_row.doc_type
    AND (v_row.tenant_key IS NULL OR c.tenant_key = v_row.tenant_key)
    AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = v_profile.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'binding_refused: incomplete (% current ready % chunks have no vector for profile %)', v_missing, v_row.doc_type, v_profile.id
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_bad
  FROM public.chunk_embeddings e
  JOIN public.document_chunks c ON c.id = e.chunk_id
  JOIN public.documents d ON d.id = c.document_id
  WHERE e.profile_id = v_profile.id AND c.is_current AND c.status = 'ready' AND COALESCE(c.doc_type, d.doc_type) = v_row.doc_type
    AND (v_row.tenant_key IS NULL OR c.tenant_key = v_row.tenant_key)
    AND (e.embedding_model <> v_profile.model OR e.dims <> v_profile.dims);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'binding_refused: model_mismatch (% rows of profile % differ from model % at % dims)', v_bad, v_profile.id, v_profile.model, v_profile.dims
      USING ERRCODE = '55000';
  END IF;

  v_evidence := v_row.eval_evidence;
  IF v_evidence IS NULL OR pg_catalog.jsonb_typeof(v_evidence) <> 'object' THEN
    RAISE EXCEPTION 'binding_refused: eval_missing' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'binding_id' IS DISTINCT FROM v_row.id::text
     OR v_evidence->>'target_profile' IS DISTINCT FROM v_row.profile_id
     OR v_evidence->>'doc_type' IS DISTINCT FROM v_row.doc_type
     OR v_evidence->>'tenant_key' IS DISTINCT FROM v_row.tenant_key THEN
    RAISE EXCEPTION 'binding_refused: evidence_mismatch' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'baseline_global_profile' IS DISTINCT FROM v_global THEN
    RAISE EXCEPTION 'binding_refused: eval_baseline_mismatch (evidence baseline %, active profile %)', v_evidence->>'baseline_global_profile', v_global
      USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'baseline_binding_profile' IS DISTINCT FROM (CASE WHEN v_has_previous THEN v_previous.profile_id END) THEN
    RAISE EXCEPTION 'binding_refused: eval_binding_baseline_mismatch (evidence baseline %, active binding profile %)',
      v_evidence->>'baseline_binding_profile', CASE WHEN v_has_previous THEN v_previous.profile_id END
      USING ERRCODE = '55000';
  END IF;
  IF v_evidence->'gate_passed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'binding_refused: eval_failed' USING ERRCODE = '55000';
  END IF;

  v_slice := v_evidence->'doc_type_slice';
  IF pg_catalog.jsonb_typeof(v_slice) = 'object'
     AND pg_catalog.jsonb_typeof(v_slice->'real_n') = 'number' AND pg_catalog.jsonb_typeof(v_slice->'n') = 'number' THEN
    v_real := (v_slice->>'real_n')::numeric;
    v_total := (v_slice->>'n')::numeric;
  END IF;
  IF v_real IS NULL OR v_real < c_min_real_items OR v_real > v_total THEN
    RAISE EXCEPTION 'binding_refused: eval_insufficient_real_items (% real of % items, % required)', v_real, v_total, c_min_real_items
      USING ERRCODE = '55000';
  END IF;
  IF v_slice->'passed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'binding_refused: eval_failed (doc type slice)' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.jsonb_typeof(v_slice->'by_language') IS DISTINCT FROM 'object' OR v_slice->'by_language' = '{}'::jsonb THEN
    RAISE EXCEPTION 'binding_refused: eval_language_regression (no language sub-slice)' USING ERRCODE = '55000';
  END IF;
  FOR v_lang IN SELECT l.key, l.value FROM pg_catalog.jsonb_each(v_slice->'by_language') l ORDER BY l.key LOOP
    IF v_lang.value IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'binding_refused: eval_language_regression (%)', v_lang.key USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF v_evidence->'other_slices_passed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'binding_refused: eval_other_slices' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs r
    WHERE r.id::text = v_evidence->>'backfill_run_id' AND r.profile_id = v_profile.id AND r.status = 'completed'
      AND (r.tenant_key IS NULL OR (v_row.tenant_key IS NOT NULL AND r.tenant_key = v_row.tenant_key))
  ) THEN
    RAISE EXCEPTION 'binding_refused: eval_run_mismatch' USING ERRCODE = '55000';
  END IF;

  SELECT max(e.embedded_at) INTO v_last
  FROM public.chunk_embeddings e
  JOIN public.document_chunks c ON c.id = e.chunk_id
  JOIN public.documents d ON d.id = c.document_id
  WHERE e.profile_id = v_profile.id AND COALESCE(c.doc_type, d.doc_type) = v_row.doc_type
    AND (v_row.tenant_key IS NULL OR c.tenant_key = v_row.tenant_key);
  BEGIN
    v_recorded := (v_evidence->>'recorded_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_recorded := NULL;
  END;
  IF v_recorded IS NULL OR (v_last IS NOT NULL AND v_recorded < v_last) THEN
    RAISE EXCEPTION 'binding_refused: eval_stale (evidence recorded %, data embedded %)', v_recorded, v_last USING ERRCODE = '55000';
  END IF;

  IF v_has_previous THEN
    UPDATE public.embedding_profile_bindings b SET status = 'available' WHERE b.id = v_previous.id;
  END IF;
  UPDATE public.embedding_profile_bindings b
  SET status = 'active', previous_binding_id = CASE WHEN v_has_previous THEN v_previous.id END, activated_at = pg_catalog.now(), activated_by = p_actor
  WHERE b.id = v_row.id;

  RETURN QUERY SELECT v_row.id, CASE WHEN v_has_previous THEN v_previous.id END;
END
$$;

-- Rollback (D-10): restores the previous binding of the key when its index is still complete; a pointer flip, no vector deleted.

CREATE OR REPLACE FUNCTION public.rag_rollback_embedding_binding(p_doc_type text, p_tenant_key text, p_actor text)
RETURNS TABLE(restored_binding uuid, rolled_back_binding uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '120s'
AS $$
DECLARE
  v_active public.embedding_profile_bindings%ROWTYPE;
  v_previous public.embedding_profile_bindings%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_missing bigint;
  v_bad bigint;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'binding_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;

  LOCK TABLE public.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_active FROM public.embedding_profile_bindings b
  WHERE b.status = 'active' AND b.doc_type = p_doc_type AND COALESCE(b.tenant_key, '') = COALESCE(p_tenant_key, '');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'binding_refused: no_active' USING ERRCODE = '55000';
  END IF;
  IF v_active.previous_binding_id IS NULL THEN
    RAISE EXCEPTION 'binding_refused: no_previous' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_previous FROM public.embedding_profile_bindings b WHERE b.id = v_active.previous_binding_id;
  IF NOT FOUND OR v_previous.status <> 'available' THEN
    RAISE EXCEPTION 'binding_refused: no_previous' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = v_previous.profile_id;

  SELECT count(*) INTO v_missing
  FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id
  WHERE c.is_current AND c.status = 'ready' AND COALESCE(c.doc_type, d.doc_type) = v_previous.doc_type
    AND (v_previous.tenant_key IS NULL OR c.tenant_key = v_previous.tenant_key)
    AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = v_profile.id);
  SELECT count(*) INTO v_bad
  FROM public.chunk_embeddings e
  JOIN public.document_chunks c ON c.id = e.chunk_id
  JOIN public.documents d ON d.id = c.document_id
  WHERE e.profile_id = v_profile.id AND c.is_current AND c.status = 'ready' AND COALESCE(c.doc_type, d.doc_type) = v_previous.doc_type
    AND (v_previous.tenant_key IS NULL OR c.tenant_key = v_previous.tenant_key)
    AND (e.embedding_model <> v_profile.model OR e.dims <> v_profile.dims);
  IF v_missing > 0 OR v_bad > 0 THEN
    RAISE EXCEPTION 'binding_refused: previous_incomplete (% chunks without a vector, % rows of another model for profile %)', v_missing, v_bad, v_profile.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profile_bindings b SET status = 'available' WHERE b.id = v_active.id;
  UPDATE public.embedding_profile_bindings b
  SET status = 'active', previous_binding_id = NULL, activated_at = pg_catalog.now(), activated_by = p_actor
  WHERE b.id = v_previous.id;

  RETURN QUERY SELECT v_previous.id, v_active.id;
END
$$;

-- Deactivate (D-10): the key falls back to the global profile alone, which is always complete (D-08); no gate.

CREATE OR REPLACE FUNCTION public.rag_deactivate_embedding_binding(p_doc_type text, p_tenant_key text, p_actor text)
RETURNS TABLE(deactivated_binding uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active uuid;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'binding_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;

  LOCK TABLE public.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE;

  SELECT b.id INTO v_active FROM public.embedding_profile_bindings b
  WHERE b.status = 'active' AND b.doc_type = p_doc_type AND COALESCE(b.tenant_key, '') = COALESCE(p_tenant_key, '');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'binding_refused: no_active' USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profile_bindings b SET status = 'available' WHERE b.id = v_active;

  RETURN QUERY SELECT v_active;
END
$$;

REVOKE ALL ON FUNCTION
  public.rag_activate_embedding_binding(uuid, text),
  public.rag_rollback_embedding_binding(text, text, text),
  public.rag_deactivate_embedding_binding(text, text, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.rag_activate_embedding_binding(uuid, text),
  public.rag_rollback_embedding_binding(text, text, text),
  public.rag_deactivate_embedding_binding(text, text, text)
TO service_role;

COMMIT;

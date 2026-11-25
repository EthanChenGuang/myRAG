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

REVOKE ALL ON FUNCTION public.rag_list_embedding_bindings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_embedding_bindings() TO service_role;
REVOKE ALL ON FUNCTION public.rag_list_embedding_profile_scopes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_embedding_profile_scopes() TO service_role;
REVOKE ALL ON FUNCTION public.rag_create_embedding_binding(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_create_embedding_binding(text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_set_embedding_binding_status(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_embedding_binding_status(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_record_binding_evidence(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_record_binding_evidence(uuid, jsonb, text) TO service_role;

COMMIT;

-- 0654: fine-tune slots served through Phase 3.1.1 bindings, and the guards that keep a slot inside its consent (Phase 6.1, FT-01, FT-09,
-- D-28, D-29, D-33, D-35).
-- A slot becomes a scoped profile (embedding_profiles.doc_types, 0440) in two ways: rag_finetune_bind_scoped_slot binds a registered
-- version and sets its doc types in one statement (the only way to bind a tenant-scope version), and rag_finetune_scope_slot scopes or
-- re-scopes a slot that already holds a version. A scoped profile is never backfilling or active (0440 scope trigger), so it serves only
-- through rows of embedding_profile_bindings. The slot guard of 0652 is replaced: doc_types of an ft-* slot change only inside these
-- functions or the final call of rag_finetune_clear_slot (all set the transaction-local myrag.ft_slot_op), a slot holding a tenant-scope
-- version can never go back to NULL doc_types (not even with the switch set), and such a slot never takes profile-level evidence: its
-- evidence lives on the 3.1.1 binding. rag_finetune_clear_slot is replaced: it refuses while a binding of the slot is active or
-- backfilling, and the call that empties the slot deletes the slot's remaining binding rows and resets doc_types, so a later version never
-- inherits a binding made for an earlier one.
-- Binding guard (D-33): a binding row whose profile is an ft-* slot is written only when the slot's version is not tainted and
--   (a) tenant_key IS NULL and the version is deployment scope, or
--   (b) the version is tenant scope and tenant_key is its single tenant, or
--   (c) the version is deployment scope and tenant_key is one of its tenants, or any tenant of this deployment while every tenant the
--       version was trained on currently has deployment consent (the consent rows are share-locked until the transaction ends).
-- It runs on INSERT and on every UPDATE except a move to available or retired that keeps the key, so the 3.1.1 activation gate and the
-- staging function re-check consent each time a binding starts serving or backfilling.
-- Backfill-run guard: a re-embed run of a slot holding a tenant-scope version is refused unless its tenant_key is the version's tenant
-- (reembed_refused: tenant_scope_use_binding_backfill); rag_reembed_start_run itself is not redefined.
-- Version taint (0652 trigger A, replaced): a tainted version's slot also has every active or backfilling binding set to available (the
-- 3.1.1 deactivation semantics: a pointer flip, no vector deleted).
-- Server role only: the slot, scope, bind and clear functions and the two replaced 0652 triggers are SECURITY DEFINER; the doc type helper
-- and the two new trigger functions run as the invoker (every writer of these tables is service_role). All use SET search_path = '' with
-- schema-qualified names, are revoked from PUBLIC, anon and authenticated and granted to service_role. Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

BEGIN;

DO $finetune_binding_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_finetune_bind_slot(text,text,text)') IS NULL THEN
    RAISE EXCEPTION '0654: apply 0652_finetune_slots.sql first' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_activate_embedding_binding(uuid,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_reembed_require_binding(text,text)') IS NULL THEN
    RAISE EXCEPTION '0654: apply 0441_binding_gate.sql and 0442_reembed_scope.sql first' USING ERRCODE = '55000';
  END IF;
END
$finetune_binding_precheck$;

-- Slot guard (trigger B): the 0652 body plus the doc type scope rules.

CREATE OR REPLACE FUNCTION public.rag_finetune_slot_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_op boolean := COALESCE(pg_catalog.current_setting('myrag.ft_slot_op', true), '') = 'on';
  v_version public.embedding_model_versions%ROWTYPE;
  v_has_version boolean;
  v_evidence_new boolean;
  v_serving_new boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.id LIKE 'ft-%' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'slot_refused: id_change' USING ERRCODE = '42501';
  END IF;
  IF NEW.id NOT LIKE 'ft-%' THEN
    RETURN NEW;
  END IF;

  IF NOT v_op THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.model <> 'unbound' OR NEW.query_instruction IS NOT NULL THEN
        RAISE EXCEPTION 'slot_refused: model_change_outside_bind (a slot is created unbound)' USING ERRCODE = '42501';
      END IF;
      IF NEW.doc_types IS NOT NULL THEN
        RAISE EXCEPTION 'slot_refused: scope_change_outside_bind (a slot is created unscoped)' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.model IS DISTINCT FROM OLD.model OR NEW.query_instruction IS DISTINCT FROM OLD.query_instruction
         OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.dims IS DISTINCT FROM OLD.dims OR NEW.storage IS DISTINCT FROM OLD.storage THEN
        RAISE EXCEPTION 'slot_refused: model_change_outside_bind (use rag_finetune_bind_slot or rag_finetune_clear_slot)' USING ERRCODE = '42501';
      END IF;
      IF NEW.doc_types IS DISTINCT FROM OLD.doc_types THEN
        RAISE EXCEPTION 'slot_refused: scope_change_outside_bind (use rag_finetune_scope_slot, rag_finetune_bind_scoped_slot or rag_finetune_clear_slot)'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_version FROM public.embedding_model_versions AS m WHERE m.id = NEW.model;
  v_has_version := FOUND;
  IF NOT v_has_version AND NEW.model <> 'unbound' THEN
    RAISE EXCEPTION 'slot_refused: unknown_version (%)', NEW.model USING ERRCODE = '22023';
  END IF;

  -- A slot holding a tenant-scope version never becomes unscoped again, whatever switch is set (D-35).
  IF TG_OP = 'UPDATE' AND v_has_version AND v_version.scope = 'tenant' AND OLD.doc_types IS NOT NULL AND NEW.doc_types IS NULL THEN
    RAISE EXCEPTION 'slot_refused: tenant_scope_global (a tenant-scope version keeps its doc types)' USING ERRCODE = '42501';
  END IF;

  -- A slot leaving active whose version is tainted or gone keeps no evidence, so it can never come back without new evidence.
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status <> 'active' AND (NOT v_has_version OR v_version.status = 'tainted') THEN
    NEW.eval_evidence := NULL;
  END IF;

  v_evidence_new := NEW.eval_evidence IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.eval_evidence IS DISTINCT FROM OLD.eval_evidence);
  v_serving_new := NEW.status IN ('backfilling', 'active') AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status);

  IF v_evidence_new THEN
    IF NOT v_has_version THEN
      RAISE EXCEPTION 'slot_refused: evidence_without_version (slot % is unbound)', NEW.id USING ERRCODE = '55000';
    END IF;
    IF v_version.status = 'tainted' THEN
      RAISE EXCEPTION 'slot_refused: version_tainted (%)', v_version.id USING ERRCODE = '55000';
    END IF;
    IF v_version.scope = 'tenant' AND NEW.doc_types IS NULL THEN
      RAISE EXCEPTION 'slot_refused: tenant_scope_global (a tenant-scope version is served only through scoped bindings)' USING ERRCODE = '42501';
    END IF;
    IF v_version.scope = 'tenant' THEN
      RAISE EXCEPTION 'slot_refused: tenant_scope_evidence (record the evidence on the 3.1.1 binding of the tenant)' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_serving_new THEN
    IF NOT v_has_version THEN
      RAISE EXCEPTION 'slot_refused: unbound (slot % has no model version)', NEW.id USING ERRCODE = '55000';
    END IF;
    IF v_version.status = 'tainted' THEN
      RAISE EXCEPTION 'slot_refused: version_tainted (%)', v_version.id USING ERRCODE = '55000';
    END IF;
    IF v_version.scope = 'tenant' AND NEW.doc_types IS NULL THEN
      RAISE EXCEPTION 'slot_refused: tenant_scope_global (a tenant-scope version is served only through scoped bindings)' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_slot_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_slot_guard() TO service_role;

-- The doc type list a scoping call takes: non-empty, no NULL entry, sorted and without repeats (the 0440 check constraint names the values).

CREATE OR REPLACE FUNCTION public.rag_finetune_normalize_doc_types(p_doc_types text[], p_prefix text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  v_out text[];
BEGIN
  IF p_doc_types IS NULL OR pg_catalog.cardinality(p_doc_types) = 0 THEN
    RAISE EXCEPTION '%: doc_types_empty (name at least one doc type)', p_prefix USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.array_position(p_doc_types, NULL) IS NOT NULL THEN
    RAISE EXCEPTION '%: doc_types_invalid (a NULL doc type)', p_prefix USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT d ORDER BY d) INTO v_out FROM pg_catalog.unnest(p_doc_types) AS u(d);
  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_normalize_doc_types(text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_normalize_doc_types(text[], text) TO service_role;

-- Bind a registered version, either scope, to an empty, free, unbound slot and scope the slot to p_doc_types in the same statement. The
-- only way to bind a tenant-scope version (D-35). Same checks and table lock as rag_finetune_bind_slot (0652).

CREATE OR REPLACE FUNCTION public.rag_finetune_bind_scoped_slot(p_slot text, p_version text, p_doc_types text[], p_actor text)
RETURNS TABLE (slot_id text, version_id text, version_scope text, doc_types text[], query_instruction text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_slot public.embedding_profiles%ROWTYPE;
  v_version public.embedding_model_versions%ROWTYPE;
  v_doc_types text[];
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'bind_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_slot IS NULL OR p_slot NOT IN ('ft-a-1024', 'ft-b-1024') THEN
    RAISE EXCEPTION 'bind_refused: unknown_slot (%)', COALESCE(p_slot, 'null') USING ERRCODE = '22023';
  END IF;
  v_doc_types := public.rag_finetune_normalize_doc_types(p_doc_types, 'bind_refused');

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_slot FROM public.embedding_profiles AS p WHERE p.id = p_slot;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bind_refused: unknown_slot (%)', p_slot USING ERRCODE = '22023';
  END IF;
  IF v_slot.status = 'active' THEN
    RAISE EXCEPTION 'bind_refused: slot_active' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.embedding_profiles AS p WHERE p.status = 'active' AND p.previous_active_id = p_slot) THEN
    RAISE EXCEPTION 'bind_refused: rollback_target (release it with rag_finetune_release_rollback first)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chunk_embeddings AS e WHERE e.profile_id = p_slot) THEN
    RAISE EXCEPTION 'bind_refused: slot_not_empty (clear it with rag_finetune_clear_slot first)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.embedding_backfill_runs AS r WHERE r.profile_id = p_slot AND r.status = 'running') THEN
    RAISE EXCEPTION 'bind_refused: reembed_running' USING ERRCODE = '55000';
  END IF;
  IF v_slot.model <> 'unbound' THEN
    RAISE EXCEPTION 'bind_refused: slot_bound (slot holds %, clear it first)', v_slot.model USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_version FROM public.embedding_model_versions AS m WHERE m.id = p_version FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bind_refused: unknown_version (%)', COALESCE(p_version, 'null') USING ERRCODE = 'P0002';
  END IF;
  IF v_version.status = 'bound' THEN
    RAISE EXCEPTION 'bind_refused: version_bound (held by %)', v_version.bound_slot USING ERRCODE = '55000';
  END IF;
  IF v_version.status <> 'registered' THEN
    RAISE EXCEPTION 'bind_refused: version_status (%)', v_version.status USING ERRCODE = '55000';
  END IF;
  IF v_version.dims <> v_slot.dims THEN
    RAISE EXCEPTION 'bind_refused: dims_mismatch (% vs %)', v_version.dims, v_slot.dims USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('myrag.ft_slot_op', 'on', true);
  UPDATE public.embedding_profiles AS p
  SET model = v_version.id, query_instruction = v_version.query_prompt, eval_evidence = NULL, doc_types = v_doc_types
  WHERE p.id = p_slot;
  PERFORM pg_catalog.set_config('myrag.ft_slot_op', '', true);

  UPDATE public.embedding_model_versions AS m
  SET status = 'bound', bound_slot = p_slot, updated_at = pg_catalog.now()
  WHERE m.id = v_version.id;

  RETURN QUERY SELECT p_slot, v_version.id, v_version.scope, v_doc_types, v_version.query_prompt;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_bind_scoped_slot(text, text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_bind_scoped_slot(text, text, text[], text) TO service_role;

-- Scope (or re-scope) a slot that already holds a version. p_doc_types NULL unscopes a slot holding a deployment-scope version (it then
-- uses the global EMB-05 path); a slot holding a tenant-scope version needs a non-empty list. The slot must be empty and free; the 0440
-- scope trigger also refuses a scope that drops the doc type of an existing binding of the slot.

CREATE OR REPLACE FUNCTION public.rag_finetune_scope_slot(p_slot text, p_doc_types text[], p_actor text)
RETURNS TABLE (slot_id text, version_id text, version_scope text, doc_types text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_slot public.embedding_profiles%ROWTYPE;
  v_version public.embedding_model_versions%ROWTYPE;
  v_doc_types text[];
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'scope_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_slot IS NULL OR p_slot NOT IN ('ft-a-1024', 'ft-b-1024') THEN
    RAISE EXCEPTION 'scope_refused: unknown_slot (%)', COALESCE(p_slot, 'null') USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_slot FROM public.embedding_profiles AS p WHERE p.id = p_slot;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope_refused: unknown_slot (%)', p_slot USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_version FROM public.embedding_model_versions AS m WHERE m.id = v_slot.model;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope_refused: unbound (bind a version first)' USING ERRCODE = '55000';
  END IF;
  IF p_doc_types IS NULL THEN
    IF v_version.scope = 'tenant' THEN
      RAISE EXCEPTION 'scope_refused: tenant_scope_requires_doc_types (a tenant-scope version is served only through scoped bindings)'
        USING ERRCODE = '42501';
    END IF;
    v_doc_types := NULL;
  ELSE
    IF pg_catalog.cardinality(p_doc_types) = 0 AND v_version.scope = 'tenant' THEN
      RAISE EXCEPTION 'scope_refused: tenant_scope_requires_doc_types (a tenant-scope version is served only through scoped bindings)'
        USING ERRCODE = '42501';
    END IF;
    v_doc_types := public.rag_finetune_normalize_doc_types(p_doc_types, 'scope_refused');
  END IF;
  IF v_version.status = 'tainted' THEN
    RAISE EXCEPTION 'scope_refused: version_tainted (%)', v_version.id USING ERRCODE = '55000';
  END IF;
  IF v_slot.status = 'active' THEN
    RAISE EXCEPTION 'scope_refused: slot_active' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.embedding_profiles AS p WHERE p.status = 'active' AND p.previous_active_id = p_slot) THEN
    RAISE EXCEPTION 'scope_refused: rollback_target (release it with rag_finetune_release_rollback first)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chunk_embeddings AS e WHERE e.profile_id = p_slot) THEN
    RAISE EXCEPTION 'scope_refused: slot_not_empty (clear it with rag_finetune_clear_slot first)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.embedding_backfill_runs AS r WHERE r.profile_id = p_slot AND r.status = 'running') THEN
    RAISE EXCEPTION 'scope_refused: reembed_running' USING ERRCODE = '55000';
  END IF;
  IF v_doc_types IS NULL AND v_slot.status = 'backfilling' THEN
    RAISE EXCEPTION 'scope_refused: slot_backfilling' USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.set_config('myrag.ft_slot_op', 'on', true);
  UPDATE public.embedding_profiles AS p SET doc_types = v_doc_types, eval_evidence = NULL, status = CASE WHEN v_doc_types IS NOT NULL AND p.status = 'backfilling' THEN 'available' ELSE p.status END
  WHERE p.id = p_slot;
  PERFORM pg_catalog.set_config('myrag.ft_slot_op', '', true);

  RETURN QUERY SELECT p_slot, v_version.id, v_version.scope, v_doc_types;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_scope_slot(text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_scope_slot(text, text[], text) TO service_role;

-- Clear (replaces 0652): refuses while a binding of the slot is active or backfilling; the call that leaves no vector also deletes the
-- slot's remaining binding rows and resets doc_types, so a later version never inherits a binding made for an earlier one.

CREATE OR REPLACE FUNCTION public.rag_finetune_clear_slot(p_slot text, p_actor text, p_limit integer DEFAULT 1000)
RETURNS TABLE (slot_id text, deleted bigint, remaining bigint, cleared boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '120s'
AS $fn$
DECLARE
  v_slot public.embedding_profiles%ROWTYPE;
  v_deleted bigint;
  v_remaining bigint;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'clear_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'clear_refused: invalid_limit (1 to 10000)' USING ERRCODE = '22023';
  END IF;
  IF p_slot IS NULL OR p_slot NOT IN ('ft-a-1024', 'ft-b-1024') THEN
    RAISE EXCEPTION 'clear_refused: unknown_slot (%)', COALESCE(p_slot, 'null') USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.embedding_profile_bindings IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_slot FROM public.embedding_profiles AS p WHERE p.id = p_slot;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'clear_refused: unknown_slot (%)', p_slot USING ERRCODE = '22023';
  END IF;
  IF v_slot.status = 'active' THEN
    RAISE EXCEPTION 'clear_refused: slot_active' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.embedding_profiles AS p WHERE p.status = 'active' AND p.previous_active_id = p_slot) THEN
    RAISE EXCEPTION 'clear_refused: rollback_target (release it with rag_finetune_release_rollback first)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.embedding_backfill_runs AS r WHERE r.profile_id = p_slot AND r.status = 'running') THEN
    RAISE EXCEPTION 'clear_refused: reembed_running' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.embedding_profile_bindings AS b WHERE b.profile_id = p_slot AND b.status IN ('active', 'backfilling')) THEN
    RAISE EXCEPTION 'clear_refused: binding_active (deactivate the slot''s bindings first)' USING ERRCODE = '55000';
  END IF;

  WITH doomed AS (
    SELECT e.chunk_id FROM public.chunk_embeddings AS e WHERE e.profile_id = p_slot ORDER BY e.chunk_id LIMIT p_limit
  )
  DELETE FROM public.chunk_embeddings AS e USING doomed AS d
  WHERE e.profile_id = p_slot AND e.chunk_id = d.chunk_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT pg_catalog.count(*) INTO v_remaining FROM public.chunk_embeddings AS e WHERE e.profile_id = p_slot;

  IF v_remaining = 0 THEN
    UPDATE public.embedding_profile_bindings AS b SET previous_binding_id = NULL
    WHERE b.previous_binding_id IN (SELECT s.id FROM public.embedding_profile_bindings AS s WHERE s.profile_id = p_slot);
    DELETE FROM public.embedding_profile_bindings AS b WHERE b.profile_id = p_slot;

    PERFORM pg_catalog.set_config('myrag.ft_slot_op', 'on', true);
    UPDATE public.embedding_profiles AS p
    SET model = 'unbound', query_instruction = NULL, eval_evidence = NULL, status = 'available', doc_types = NULL
    WHERE p.id = p_slot;
    PERFORM pg_catalog.set_config('myrag.ft_slot_op', '', true);

    UPDATE public.embedding_model_versions AS m
    SET status = CASE WHEN m.status = 'bound' THEN 'retired' ELSE m.status END, bound_slot = NULL, updated_at = pg_catalog.now()
    WHERE m.id = v_slot.model;
  END IF;

  RETURN QUERY SELECT p_slot, v_deleted, v_remaining, v_remaining = 0;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_clear_slot(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_clear_slot(text, text, integer) TO service_role;

-- Binding guard (D-33) on embedding_profile_bindings.

CREATE OR REPLACE FUNCTION public.rag_finetune_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_model text;
  v_version public.embedding_model_versions%ROWTYPE;
  v_key text;
  v_scope text;
BEGIN
  IF NEW.profile_id NOT LIKE 'ft-%' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IN ('available', 'retired')
     AND NEW.profile_id = OLD.profile_id AND NEW.doc_type = OLD.doc_type AND NEW.tenant_key IS NOT DISTINCT FROM OLD.tenant_key THEN
    RETURN NEW;
  END IF;

  SELECT p.model INTO v_model FROM public.embedding_profiles AS p WHERE p.id = NEW.profile_id;
  SELECT * INTO v_version FROM public.embedding_model_versions AS m WHERE m.id = v_model;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'binding_refused: finetune_unbound (slot % holds no model version)', NEW.profile_id USING ERRCODE = '42501';
  END IF;
  IF v_version.status = 'tainted' THEN
    RAISE EXCEPTION 'binding_refused: finetune_tainted (%)', v_version.id USING ERRCODE = '42501';
  END IF;

  IF v_version.scope = 'tenant' THEN
    IF NEW.tenant_key IS NULL THEN
      RAISE EXCEPTION 'binding_refused: finetune_deployment_wide (a tenant-scope version is bound only for its tenant)' USING ERRCODE = '42501';
    END IF;
    IF NEW.tenant_key IS DISTINCT FROM v_version.tenant_keys[1] OR pg_catalog.cardinality(v_version.tenant_keys) <> 1 THEN
      RAISE EXCEPTION 'binding_refused: finetune_tenant_mismatch (the version serves only the tenant it was trained on)' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tenant_key IS NULL OR NEW.tenant_key = ANY (v_version.tenant_keys) THEN
    RETURN NEW;
  END IF;
  FOREACH v_key IN ARRAY v_version.tenant_keys LOOP
    SELECT c.scope INTO v_scope FROM public.rag_finetune_consent AS c WHERE c.tenant_key = v_key FOR SHARE;
    IF NOT FOUND OR v_scope IS DISTINCT FROM 'deployment' THEN
      RAISE EXCEPTION 'binding_refused: finetune_consent (a trained tenant no longer grants deployment consent)' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_binding_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_binding_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_finetune_binding_guard ON public.embedding_profile_bindings;
CREATE TRIGGER rag_finetune_binding_guard
  BEFORE INSERT OR UPDATE ON public.embedding_profile_bindings
  FOR EACH ROW EXECUTE FUNCTION public.rag_finetune_binding_guard();

-- Backfill-run guard: a run of a slot holding a tenant-scope version covers that tenant only (D-33, D-35).

CREATE OR REPLACE FUNCTION public.rag_finetune_backfill_run_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_version public.embedding_model_versions%ROWTYPE;
BEGIN
  IF NEW.profile_id NOT LIKE 'ft-%' THEN
    RETURN NEW;
  END IF;
  SELECT m.* INTO v_version
  FROM public.embedding_profiles AS p JOIN public.embedding_model_versions AS m ON m.id = p.model
  WHERE p.id = NEW.profile_id;
  IF FOUND AND v_version.scope = 'tenant'
     AND (NEW.tenant_key IS NULL OR NEW.tenant_key IS DISTINCT FROM v_version.tenant_keys[1]) THEN
    RAISE EXCEPTION 'reembed_refused: tenant_scope_use_binding_backfill (slot % holds a tenant-scope version: run the 3.1.1 tenant-filtered binding backfill, npm run rag:reembed -- --profile % --tenant <its tenant>, after bind-status backfilling)',
      NEW.profile_id, NEW.profile_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_backfill_run_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_backfill_run_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_finetune_backfill_run_guard ON public.embedding_backfill_runs;
CREATE TRIGGER rag_finetune_backfill_run_guard
  BEFORE INSERT ON public.embedding_backfill_runs
  FOR EACH ROW EXECUTE FUNCTION public.rag_finetune_backfill_run_guard();

-- Version taint (trigger A, replaces 0652): the 0652 evidence drop plus the deactivation of every serving binding of the version's slot.

CREATE OR REPLACE FUNCTION public.rag_finetune_version_taint_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NEW.status = 'tainted' AND OLD.status IS DISTINCT FROM 'tainted' THEN
    UPDATE public.embedding_profiles AS p
    SET eval_evidence = NULL
    WHERE p.id LIKE 'ft-%' AND p.model = NEW.id AND p.status <> 'active' AND p.eval_evidence IS NOT NULL;

    UPDATE public.embedding_profile_bindings AS b
    SET status = 'available'
    WHERE b.status IN ('active', 'backfilling')
      AND b.profile_id IN (SELECT p.id FROM public.embedding_profiles AS p WHERE p.id LIKE 'ft-%' AND p.model = NEW.id);
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_version_taint_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_version_taint_guard() TO service_role;

COMMIT;

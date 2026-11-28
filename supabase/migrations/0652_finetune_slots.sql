-- 0652: two fixed fine-tune slots, their bind/clear/release functions and the taint and evidence triggers (Phase 6.1, D-22, D-25, D-33, D-35).
-- ft-a-1024 (provider ft_slot_a) and ft-b-1024 (provider ft_slot_b) are halfvec(1024) profiles seeded 'available' with model 'unbound',
-- each with its own partial HNSW index; no DDL is ever generated at run time. A slot serves one registered model version (0651) at a time:
-- rag_finetune_bind_slot sets the slot's model to the version id and its query_instruction to the card's query prompt, and
-- rag_finetune_clear_slot deletes the slot's vectors in batches and resets it. The slot guard trigger refuses any other change of a slot's
-- model, prompt, provider, dims or storage (the two functions set the transaction-local switch myrag.ft_slot_op around their own UPDATE and
-- turn it off again; the switch guards against accidental writes, it is not a permission: every caller here is service_role already).
-- The same trigger refuses evidence, backfilling and activation for a slot without a version, with a tainted version, or, while the slot is
-- unscoped, with a tenant-scope version (a private model is never served globally, D-35; 06.1-20 binds those through scoped bindings).
-- The version taint trigger drops the evidence of a tainted version's non-active slot, so the unchanged activation gate refuses eval_missing.
-- rag_activate_embedding_profile, rag_rollback_embedding_profile, rag_record_eval_evidence, rag_set_embedding_profile_status and the
-- re-embed functions are not redefined here (D-25); the triggers act on the rows they write.
-- Server role only: every function is SECURITY DEFINER with SET search_path = '' and schema-qualified names, revoked from PUBLIC, anon and
-- authenticated and granted to service_role. Idempotent: ON CONFLICT DO NOTHING, IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

BEGIN;

DO $finetune_slots_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.embedding_model_versions') IS NULL THEN
    RAISE EXCEPTION '0652: apply 0651_finetune_registry.sql first' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = pg_catalog.to_regclass('public.embedding_profiles') AND attname = 'doc_types' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '0652: apply 0440_embedding_bindings.sql first' USING ERRCODE = '55000';
  END IF;
END
$finetune_slots_precheck$;

-- Slot guard (trigger B). Runs for every row; returns at once for a profile that is not an ft-* slot.

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
    ELSIF NEW.model IS DISTINCT FROM OLD.model OR NEW.query_instruction IS DISTINCT FROM OLD.query_instruction
       OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.dims IS DISTINCT FROM OLD.dims OR NEW.storage IS DISTINCT FROM OLD.storage THEN
      RAISE EXCEPTION 'slot_refused: model_change_outside_bind (use rag_finetune_bind_slot or rag_finetune_clear_slot)' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_version FROM public.embedding_model_versions AS m WHERE m.id = NEW.model;
  v_has_version := FOUND;
  IF NOT v_has_version AND NEW.model <> 'unbound' THEN
    RAISE EXCEPTION 'slot_refused: unknown_version (%)', NEW.model USING ERRCODE = '22023';
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

DROP TRIGGER IF EXISTS rag_finetune_slot_guard ON public.embedding_profiles;
CREATE TRIGGER rag_finetune_slot_guard
  BEFORE INSERT OR UPDATE ON public.embedding_profiles
  FOR EACH ROW EXECUTE FUNCTION public.rag_finetune_slot_guard();

-- Slot rows and their indexes (D-22).

INSERT INTO public.embedding_profiles (id, provider, model, dims, storage, status, query_instruction, score_calibration)
VALUES
  ('ft-a-1024', 'ft_slot_a', 'unbound', 1024, 'halfvec', 'available', NULL, '{}'::jsonb),
  ('ft-b-1024', 'ft_slot_b', 'unbound', 1024, 'halfvec', 'available', NULL, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS chunk_embeddings_ft_a_1024_hnsw ON public.chunk_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'ft-a-1024';
CREATE INDEX IF NOT EXISTS chunk_embeddings_ft_b_1024_hnsw ON public.chunk_embeddings
  USING hnsw ((embedding::public.halfvec(1024)) public.halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'ft-b-1024';

-- Bind a registered deployment-scope version to an empty, free, unbound slot. Same table lock as the activation gate (0309), so a bind and
-- an activation or rollback never interleave.

CREATE OR REPLACE FUNCTION public.rag_finetune_bind_slot(p_slot text, p_version text, p_actor text)
RETURNS TABLE (slot_id text, version_id text, query_instruction text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_slot public.embedding_profiles%ROWTYPE;
  v_version public.embedding_model_versions%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'bind_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_slot IS NULL OR p_slot NOT IN ('ft-a-1024', 'ft-b-1024') THEN
    RAISE EXCEPTION 'bind_refused: unknown_slot (%)', COALESCE(p_slot, 'null') USING ERRCODE = '22023';
  END IF;

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
  IF v_version.scope = 'tenant' THEN
    RAISE EXCEPTION 'bind_refused: tenant_scope_requires_scoping (bind a tenant-scope version with its doc types)' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('myrag.ft_slot_op', 'on', true);
  UPDATE public.embedding_profiles AS p
  SET model = v_version.id, query_instruction = v_version.query_prompt, eval_evidence = NULL
  WHERE p.id = p_slot;
  PERFORM pg_catalog.set_config('myrag.ft_slot_op', '', true);

  UPDATE public.embedding_model_versions AS m
  SET status = 'bound', bound_slot = p_slot, updated_at = pg_catalog.now()
  WHERE m.id = v_version.id;

  RETURN QUERY SELECT p_slot, v_version.id, v_version.query_prompt;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_bind_slot(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_bind_slot(text, text, text) TO service_role;

-- Clear a free slot: delete up to p_limit of its vectors per call (slot-wide, every tenant: a slot holds one model version for the whole
-- deployment); the call that leaves none resets the slot to unbound and retires its bound version (a tainted version stays tainted).

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

  WITH doomed AS (
    SELECT e.chunk_id FROM public.chunk_embeddings AS e WHERE e.profile_id = p_slot ORDER BY e.chunk_id LIMIT p_limit
  )
  DELETE FROM public.chunk_embeddings AS e USING doomed AS d
  WHERE e.profile_id = p_slot AND e.chunk_id = d.chunk_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT pg_catalog.count(*) INTO v_remaining FROM public.chunk_embeddings AS e WHERE e.profile_id = p_slot;

  IF v_remaining = 0 THEN
    PERFORM pg_catalog.set_config('myrag.ft_slot_op', 'on', true);
    UPDATE public.embedding_profiles AS p
    SET model = 'unbound', query_instruction = NULL, eval_evidence = NULL, status = 'available'
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

-- Drop the active profile's rollback target, so the older slot becomes free to clear or rebind. Needs p_ack = 'drop-rollback'.

CREATE OR REPLACE FUNCTION public.rag_finetune_release_rollback(p_actor text, p_ack text)
RETURNS TABLE (active_profile text, dropped_previous text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_active text;
  v_previous text;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'release_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_ack IS DISTINCT FROM 'drop-rollback' THEN
    RAISE EXCEPTION 'release_refused: ack_required (pass drop-rollback)' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT p.id, p.previous_active_id INTO v_active, v_previous FROM public.embedding_profiles AS p WHERE p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'release_refused: no_active' USING ERRCODE = '55000';
  END IF;
  IF v_previous IS NOT NULL THEN
    UPDATE public.embedding_profiles AS p SET previous_active_id = NULL WHERE p.id = v_active;
  END IF;

  RETURN QUERY SELECT v_active, v_previous;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_release_rollback(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_release_rollback(text, text) TO service_role;

-- Version taint (trigger A): when a version becomes tainted, its non-active slot loses its evidence, so activation refuses eval_missing.
-- An active slot keeps it (serving does not stop by itself; the revoke output tells the operator to roll back); the slot guard drops it
-- when the slot leaves active and refuses new evidence and re-activation while the version is tainted.

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
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_version_taint_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_version_taint_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_finetune_version_taint_guard ON public.embedding_model_versions;
CREATE TRIGGER rag_finetune_version_taint_guard
  AFTER UPDATE OF status ON public.embedding_model_versions
  FOR EACH ROW EXECUTE FUNCTION public.rag_finetune_version_taint_guard();

COMMIT;

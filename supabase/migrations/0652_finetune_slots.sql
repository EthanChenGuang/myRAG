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

COMMIT;

-- 0309: gated activation and rollback of an embedding profile (Phase 3, D-36, D-40).
-- rag_activate_embedding_profile refuses, each with its own message prefix, unless the target is complete (every current ready chunk has
-- a vector), consistent (every row has the profile's model and dims) and proven (eval_evidence names the target, the active profile as
-- baseline, a passing gate, a passing pre_migration slice, a completed backfill run of the target, and is newer than the target's data).
-- Completeness is counted in the same transaction as the flip, under a table lock that serialises activations and status changes.
-- rag_rollback_embedding_profile restores previous_active_id when that profile still has a vector for every current ready chunk.
-- The legacy profile keeps its vectors in document_chunks.embedding, so for it the checks read that column. Server role only.

BEGIN;

CREATE OR REPLACE FUNCTION rag_activate_embedding_profile(p_target text, p_actor text)
RETURNS TABLE (activated_profile text, previous_profile text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_target embedding_profiles%ROWTYPE;
  v_active text;
  v_missing bigint;
  v_bad bigint;
  v_evidence jsonb;
  v_recorded timestamptz;
  v_last timestamptz;
  v_slice_ok boolean;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'activation_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_target FROM embedding_profiles WHERE id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_target.status = 'active' THEN
    RAISE EXCEPTION 'activation_refused: already_active' USING ERRCODE = '55000';
  END IF;
  SELECT p.id INTO v_active FROM embedding_profiles p WHERE p.status = 'active';

  IF v_target.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p_target);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'activation_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, p_target
      USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    SELECT count(*) INTO v_bad FROM chunk_embeddings e
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
      SELECT 1 FROM embedding_backfill_runs r
      WHERE r.id::text = v_evidence->>'backfill_run_id' AND r.profile_id = p_target AND r.status = 'completed'
    ) THEN
      RAISE EXCEPTION 'activation_refused: eval_run_mismatch' USING ERRCODE = '55000';
    END IF;
    SELECT max(e.embedded_at) INTO v_last FROM chunk_embeddings e WHERE e.profile_id = p_target;
  ELSE
    SELECT max(c.created_at) INTO v_last FROM document_chunks c
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

  UPDATE embedding_profiles SET status = 'available' WHERE status = 'active';
  UPDATE embedding_profiles
  SET status = 'active', previous_active_id = v_active, activated_at = now(), activated_by = p_actor
  WHERE id = p_target;

  RETURN QUERY SELECT p_target, v_active;
END
$$;

CREATE OR REPLACE FUNCTION rag_rollback_embedding_profile(p_actor text)
RETURNS TABLE (restored_profile text, rolled_back_profile text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_active embedding_profiles%ROWTYPE;
  v_previous embedding_profiles%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_active FROM embedding_profiles WHERE status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_active' USING ERRCODE = '55000';
  END IF;
  IF v_active.previous_active_id IS NULL THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_previous FROM embedding_profiles WHERE id = v_active.previous_active_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;

  IF v_previous.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = v_previous.id);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'rollback_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, v_previous.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE embedding_profiles SET status = 'available' WHERE id = v_active.id;
  UPDATE embedding_profiles
  SET status = 'active', previous_active_id = NULL, activated_at = now(), activated_by = p_actor
  WHERE id = v_previous.id;

  RETURN QUERY SELECT v_previous.id, v_active.id;
END
$$;

REVOKE ALL ON FUNCTION rag_activate_embedding_profile(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_rollback_embedding_profile(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_activate_embedding_profile(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_rollback_embedding_profile(text) TO service_role;

COMMIT;

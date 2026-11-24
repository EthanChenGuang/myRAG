-- 0318: record activation eval evidence on a target profile (Phase 3, D-40(c)).
-- rag_record_eval_evidence stores validated JSON on the target row for rag_activate_embedding_profile; service role only; refused for the active profile.

BEGIN;

CREATE OR REPLACE FUNCTION rag_record_eval_evidence(p_profile_id text, p_evidence jsonb, p_actor text)
RETURNS TABLE (profile_id text, recorded_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile embedding_profiles%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'evidence_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile FROM embedding_profiles WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'evidence_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'evidence_refused: invalid_evidence' USING ERRCODE = '22023';
  END IF;
  IF p_evidence->>'target_profile' IS DISTINCT FROM p_profile_id THEN
    RAISE EXCEPTION 'evidence_refused: target_mismatch' USING ERRCODE = '55000';
  END IF;

  UPDATE embedding_profiles SET eval_evidence = p_evidence WHERE id = p_profile_id;

  RETURN QUERY SELECT p_profile_id, now();
END
$$;

REVOKE ALL ON FUNCTION rag_record_eval_evidence(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_record_eval_evidence(text, jsonb, text) TO service_role;

COMMIT;
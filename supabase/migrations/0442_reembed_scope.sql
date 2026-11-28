-- 0442: re-embed scoped to a profile's doc types (Phase 3.1.1, D-14, D-27). A scoped profile (embedding_profiles.doc_types, 0440) is filled
-- only for current ready chunks whose COALESCE(chunk.doc_type, document.doc_type) is in its scope, with the predicate
--   (p.doc_types IS NULL OR COALESCE(c.doc_type, d.doc_type) = ANY (p.doc_types))
-- and its status is never moved: a scoped profile can never be 'backfilling' or 'active' (0440 scope trigger). Instead a run of a scoped
-- profile needs a binding of that profile in status 'backfilling' or 'active' (0441) whose tenant scope is the run's: a deployment-wide
-- binding (tenant_key NULL) covers a run for every tenant, a tenant binding covers a run for that tenant only. An active binding is accepted
-- so chunks written outside ingest dual-write can be topped up; rolling back a run is refused while an active binding of the profile
-- overlaps the run's tenant scope, since deleting its vectors would break the completeness the gate checked. Deriving (MRL truncation) a
-- scoped profile is refused. For an unscoped profile (doc_types NULL) every function returns and changes exactly what its 0425 body does.
--
-- Replaced, each starting from its body in 0425_search_path_empty.sql (the newest definition; 0315 and 0410 are older and nothing numbered
-- after 0425 redefines them), and differing from it only by the scope predicate and the scoped-profile branches:
--   rag_reembed_pick (predicate; next_batch, missing_batch and preview_batch select through it and are not replaced),
--   rag_reembed_count and rag_reembed_remaining (predicate, LEFT JOIN documents),
--   rag_reembed_start_run (predicate in the total; scoped: binding required, no status change, derive refused),
--   rag_reembed_resume_run (scoped: binding required, no status change),
--   rag_reembed_derive_batch (scoped: refused),
--   rag_reembed_rollback_run (scoped: refused under an active binding, no status change).
-- Signatures, return types, volatility, SECURITY DEFINER, the empty search_path, refusal prefixes and grants are unchanged (CREATE OR
-- REPLACE keeps the ACL and 0425 issued none, so 0410's grants stand). New: public.rag_reembed_require_binding(text, text), a plain
-- (invoker) helper the definer functions call; service_role only. write_batch, get_run, finish_run and the legacy guard are untouched: the
-- 0440 guard refuses an out-of-scope vector, and finish_run counts through rag_reembed_remaining.
--
-- Live upgrade: run this read-only dry run first. No rows means every live body is the 0425 one; for any row, compare pg_get_functiondef
-- with the repository before applying (the hashes are the same in both deployment modes).
--   SELECT x.sig, x.md5 AS expected, pg_catalog.md5(p.prosrc) AS live
--     FROM (VALUES
--       ('public.rag_reembed_count(text,text)', 'a573147095b3e58dc07c3933c4edac4f'),
--       ('public.rag_reembed_derive_batch(uuid,integer)', '39ea31daba0cfb81e06aea20990d6332'),
--       ('public.rag_reembed_pick(text,text,uuid,integer)', '1dff08e1c5088bc2939f54d985e21218'),
--       ('public.rag_reembed_remaining(uuid)', '4217c273d90319eca11334b371e64ef8'),
--       ('public.rag_reembed_resume_run(uuid,text)', 'f236ebb70cd2b6ea6d38c78a18ccdf7e'),
--       ('public.rag_reembed_rollback_run(uuid,text)', 'f6acfc5f24cac122f20848ef1edf494b'),
--       ('public.rag_reembed_start_run(text,text,text,text)', '36346f04a9f2012c4905b3ae0d5cb7c8')) AS x(sig, md5)
--     LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(x.sig)
--    WHERE p.oid IS NULL OR pg_catalog.md5(p.prosrc) <> x.md5;
-- Re-running 0425 after this file puts back the unscoped bodies, so re-run 0442 after it. Idempotent: CREATE OR REPLACE only.

BEGIN;

DO $reembed_scope_precheck$
DECLARE
  v_missing text[];
BEGIN
  SELECT pg_catalog.array_agg(s.sig ORDER BY s.sig) INTO v_missing
  FROM pg_catalog.unnest(ARRAY[
    'public.rag_reembed_count(text,text)',
    'public.rag_reembed_derive_batch(uuid,integer)',
    'public.rag_reembed_pick(text,text,uuid,integer)',
    'public.rag_reembed_remaining(uuid)',
    'public.rag_reembed_resume_run(uuid,text)',
    'public.rag_reembed_rollback_run(uuid,text)',
    'public.rag_reembed_start_run(text,text,text,text)'
  ]) AS s(sig)
  WHERE pg_catalog.to_regprocedure(s.sig) IS NULL;
  IF v_missing IS NOT NULL OR pg_catalog.to_regclass('public.embedding_profile_bindings') IS NULL THEN
    RAISE EXCEPTION '0442: apply the earlier migrations first (0315, 0425, 0440, 0441); missing: %', COALESCE(v_missing::text, 'public.embedding_profile_bindings')
      USING ERRCODE = '55000';
  END IF;
END
$reembed_scope_precheck$;

-- The binding a run of a scoped profile needs: one of this profile in status backfilling or active whose tenant is the run's (NULL for a
-- run over every tenant). The row is share-locked until the caller's transaction ends, so it cannot be retired under a starting run.
CREATE OR REPLACE FUNCTION public.rag_reembed_require_binding(p_profile_id text, p_tenant_key text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM 1 FROM public.embedding_profile_bindings b
  WHERE b.profile_id = p_profile_id AND b.status IN ('backfilling', 'active') AND b.tenant_key IS NOT DISTINCT FROM p_tenant_key
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: no_backfilling_binding' USING ERRCODE = '55000';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_reembed_require_binding(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_reembed_require_binding(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_reembed_pick(p_profile_id text, p_tenant_key text, p_after uuid, p_limit integer)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb, has_gap boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT c.id, c.document_id, c.tenant_key, c.content, c.section_path, c.chunk_kind,
         COALESCE(c.doc_type, d.doc_type),
         jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency),
         EXISTS (SELECT 1 FROM public.embedding_backfill_gaps g WHERE g.chunk_id = c.id AND g.profile_id = p.id)
  FROM public.embedding_profiles p
  JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
  JOIN public.documents d ON d.id = c.document_id
  WHERE p.id = p_profile_id
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    AND (p.doc_types IS NULL OR COALESCE(c.doc_type, d.doc_type) = ANY (p.doc_types))
    AND (p_after IS NULL OR c.id > p_after)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims)
  ORDER BY c.id
  LIMIT p_limit
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_count(p_profile_id text, p_tenant_key text)
 RETURNS TABLE(tenant_key text, chunks bigint, chunks_missing bigint, content_chars bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.embedding_profiles p WHERE p.id = p_profile_id) THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.tenant_key,
           count(*)::bigint,
           (count(*) FILTER (WHERE e.chunk_id IS NULL))::bigint,
           COALESCE(sum(length(c.content)) FILTER (WHERE e.chunk_id IS NULL), 0)::bigint
    FROM public.embedding_profiles p
    JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
    LEFT JOIN public.documents d ON d.id = c.document_id
    LEFT JOIN public.chunk_embeddings e
      ON e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims
    WHERE p.id = p_profile_id AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
      AND (p.doc_types IS NULL OR COALESCE(c.doc_type, d.doc_type) = ANY (p.doc_types))
    GROUP BY c.tenant_key
    ORDER BY c.tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_remaining(p_run_id uuid)
 RETURNS TABLE(chunks_missing bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_count bigint;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.embedding_profiles p
  JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
  LEFT JOIN public.documents d ON d.id = c.document_id
  WHERE p.id = v_run.profile_id
    AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
    AND (p.doc_types IS NULL OR COALESCE(c.doc_type, d.doc_type) = ANY (p.doc_types))
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims);
  RETURN QUERY SELECT v_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_start_run(p_profile_id text, p_tenant_key text, p_actor text, p_derived_from text DEFAULT NULL::text)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, chunks_total bigint, derived_from text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
  v_source public.embedding_profiles%ROWTYPE;
  v_total bigint;
  v_run uuid;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF v_profile.status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF v_profile.doc_types IS NOT NULL THEN
    IF p_derived_from IS NOT NULL THEN
      RAISE EXCEPTION 'reembed_refused: derive_unsupported' USING ERRCODE = '22023';
    END IF;
    PERFORM public.rag_reembed_require_binding(v_profile.id, p_tenant_key);
  END IF;

  IF p_derived_from IS NOT NULL THEN
    SELECT * INTO v_source FROM public.embedding_profiles p WHERE p.id = p_derived_from;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reembed_refused: unknown_derive_source' USING ERRCODE = '22023';
    END IF;
    IF v_source.id = v_profile.id OR v_source.storage <> 'halfvec' THEN
      RAISE EXCEPTION 'reembed_refused: derive_source_invalid' USING ERRCODE = '22023';
    END IF;
    IF v_source.provider <> v_profile.provider OR v_source.model <> v_profile.model THEN
      RAISE EXCEPTION 'reembed_refused: derive_model_mismatch' USING ERRCODE = '22023';
    END IF;
    IF v_source.dims <= v_profile.dims THEN
      RAISE EXCEPTION 'reembed_refused: derive_dims_not_smaller' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs r
    WHERE r.profile_id = p_profile_id AND r.status = 'running'
      AND (r.tenant_key IS NULL OR p_tenant_key IS NULL OR r.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.embedding_profiles p
  JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
  LEFT JOIN public.documents d ON d.id = c.document_id
  WHERE p.id = p_profile_id AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    AND (p.doc_types IS NULL OR COALESCE(c.doc_type, d.doc_type) = ANY (p.doc_types));

  IF v_profile.doc_types IS NULL THEN
    UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = p_profile_id AND status = 'available';
  END IF;

  INSERT INTO public.embedding_backfill_runs AS r (profile_id, tenant_key, chunks_total, derived_from)
  VALUES (p_profile_id, p_tenant_key, v_total, p_derived_from)
  RETURNING r.id INTO v_run;

  RETURN QUERY SELECT v_run, p_profile_id, p_tenant_key, v_total, p_derived_from;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_resume_run(p_run_id uuid, p_actor text)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, tokens bigint, status text, derived_from text, provider text, model text, dims integer, storage text, profile_status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_status text;
  v_scope text[];
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'completed' THEN
    RAISE EXCEPTION 'reembed_refused: run_completed' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'reembed_refused: run_rolled_back' USING ERRCODE = '55000';
  END IF;
  SELECT p.status, p.doc_types INTO v_status, v_scope FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs o
    WHERE o.id <> v_run.id AND o.profile_id = v_run.profile_id AND o.status = 'running'
      AND (o.tenant_key IS NULL OR v_run.tenant_key IS NULL OR o.tenant_key = v_run.tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  IF v_scope IS NOT NULL THEN
    PERFORM public.rag_reembed_require_binding(v_run.profile_id, v_run.tenant_key);
  ELSE
    UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = v_run.profile_id AND status = 'available';
  END IF;
  UPDATE public.embedding_backfill_runs SET status = 'running', updated_at = now() WHERE id = v_run.id;
  RETURN QUERY SELECT * FROM public.rag_reembed_get_run(p_run_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_derive_batch(p_run_id uuid, p_limit integer)
 RETURNS TABLE(chunks_derived integer, chunks_done bigint, cursor_chunk_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_target public.embedding_profiles%ROWTYPE;
  v_source public.embedding_profiles%ROWTYPE;
  v_ids uuid[];
  v_last uuid;
  derived integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF v_run.derived_from IS NULL THEN
    RAISE EXCEPTION 'reembed_refused: not_a_derive_run' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_target.doc_types IS NOT NULL THEN
    RAISE EXCEPTION 'reembed_refused: derive_unsupported' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_source FROM public.embedding_profiles p WHERE p.id = v_run.derived_from;

  WITH picked AS (
    SELECT c.id, c.tenant_key, s.embedding AS source_vector
    FROM public.document_chunks c
    JOIN public.chunk_embeddings s
      ON s.chunk_id = c.id AND s.profile_id = v_source.id AND s.embedding_model = v_source.model AND s.dims = v_source.dims
    WHERE c.is_current AND c.status = 'ready'
      AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
      AND NOT EXISTS (
        SELECT 1 FROM public.chunk_embeddings t
        WHERE t.chunk_id = c.id AND t.profile_id = v_target.id AND t.embedding_model = v_target.model AND t.dims = v_target.dims)
    ORDER BY c.id
    LIMIT p_limit
  ), written AS (
    INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT p.id, v_target.id, p.tenant_key, public.l2_normalize(public.subvector(p.source_vector, 1, v_target.dims)), v_target.model, v_target.dims, 'derived'
    FROM picked p
    ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      embedding_host = EXCLUDED.embedding_host,
      embedded_at = now()
    RETURNING ce.chunk_id
  )
  SELECT count(*)::integer, array_agg(w.chunk_id) INTO derived, v_ids FROM written w;

  IF derived > 0 THEN
    DELETE FROM public.embedding_backfill_gaps g WHERE g.profile_id = v_target.id AND g.chunk_id = ANY (v_ids);
    SELECT u.id INTO v_last FROM unnest(v_ids) AS u(id) ORDER BY u.id DESC LIMIT 1;
  END IF;

  UPDATE public.embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + derived,
    cursor_chunk_id = CASE
      WHEN v_last IS NOT NULL AND (r.cursor_chunk_id IS NULL OR v_last > r.cursor_chunk_id) THEN v_last
      ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT derived, v_done, v_cursor;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_rollback_run(p_run_id uuid, p_actor text)
 RETURNS TABLE(rows_deleted bigint, profile_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_deleted bigint;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'rollback_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'running' AND v_run.updated_at > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'rollback_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.activated_at IS NOT NULL
     AND (SELECT max(p.activated_at) FROM public.embedding_profiles p) > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: recently_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.doc_types IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.embedding_profile_bindings b
    WHERE b.profile_id = v_profile.id AND b.status = 'active'
      AND (b.tenant_key IS NULL OR v_run.tenant_key IS NULL OR b.tenant_key = v_run.tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: binding_active' USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.chunk_embeddings e
  WHERE e.profile_id = v_run.profile_id
    AND e.embedded_at >= v_run.started_at
    AND e.embedded_at <= v_run.updated_at
    AND (v_run.tenant_key IS NULL OR e.tenant_key = v_run.tenant_key);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM public.embedding_backfill_gaps g WHERE g.run_id = v_run.id;
  UPDATE public.embedding_backfill_runs AS r SET status = 'rolled_back', updated_at = now() WHERE r.id = v_run.id;

  IF v_profile.doc_types IS NULL AND v_profile.status = 'backfilling' AND NOT EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs o WHERE o.profile_id = v_run.profile_id AND o.status = 'running' AND o.id <> v_run.id
  ) THEN
    UPDATE public.embedding_profiles SET status = 'available' WHERE id = v_run.profile_id;
  END IF;
  SELECT p.status INTO v_status FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;

  RETURN QUERY SELECT v_deleted, v_status;
END
$function$;

COMMIT;

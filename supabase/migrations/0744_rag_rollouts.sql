-- 0744: Phase 7 per-tenant rollouts (plan 07-47, LANG-11).
-- rag_rollouts holds one row per rollout of an embedding profile, chunking profiles or a Phase 3.2 rebuild run; at most one active
-- rollout exists per kind. rag_rollout_tenants lists the tenants an operator included or excluded. A tenant is on the candidate arm
-- when it is included, or when the mode is share and rag_rollout_bucket(salt, key) < share_percent, and it is not excluded.
-- The bucket is the first 8 hex digits of sha256(salt || ':' || key) mod 100; src/lib/rag/rollout/resolve.ts computes the same value.
-- Rollouts are pointers: they never write or delete vectors or chunks. A rebuild_run rollout publishes the run's held versions of the
-- candidate-arm tenants through the run's own publish path (rag_release_publish_hold, rag_publish_document_version) after the same
-- eval gate as rag_rebuild_activate, and taking a tenant out restores its previous versions with the vectors rag_rebuild_activate's
-- path saved; the rebuilt version's vectors are moved into rag_rebuild_saved_vectors, never dropped.
-- Tables: RLS on, no policies, nothing granted to PUBLIC, anon or authenticated. Functions: SECURITY INVOKER, SET search_path = '',
-- schema-qualified names, REVOKE ALL FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature; every function
-- taking a tenant key calls rag_assert_tenant_key first. Refusals raise 'rollout_refused: <code>' (55000) or 22023. Not folded into the
-- setup files. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_rollouts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  kind text NOT NULL,
  candidate_ref jsonb NOT NULL,
  incumbent_ref jsonb,
  mode text NOT NULL,
  share_percent integer,
  salt text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ended_at timestamptz,
  ended_by uuid,
  CONSTRAINT rag_rollouts_kind_check CHECK (kind IN ('embedding_profile', 'chunking_profile', 'rebuild_run')),
  CONSTRAINT rag_rollouts_mode_check CHECK (mode IN ('tenants', 'share')),
  CONSTRAINT rag_rollouts_share_check CHECK (
    (mode = 'share' AND share_percent IS NOT NULL AND share_percent BETWEEN 0 AND 100) OR (mode = 'tenants' AND share_percent IS NULL)
  ),
  CONSTRAINT rag_rollouts_salt_check CHECK (salt ~ '^[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT rag_rollouts_state_check CHECK (state IN ('active', 'promoted', 'rolled_back', 'cancelled')),
  CONSTRAINT rag_rollouts_ended_check CHECK ((state = 'active') = (ended_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_rollouts_one_active_per_kind ON public.rag_rollouts (kind) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS public.rag_rollout_tenants (
  rollout_id uuid NOT NULL REFERENCES public.rag_rollouts (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  membership text NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (rollout_id, tenant_key),
  CONSTRAINT rag_rollout_tenants_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_rollout_tenants_membership_check CHECK (membership IN ('include', 'exclude'))
);

ALTER TABLE public.rag_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_rollout_tenants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_rollouts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_rollout_tenants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_rollouts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_rollout_tenants TO service_role;

-- The share bucket of a tenant for a salt, 0..99.
CREATE OR REPLACE FUNCTION public.rag_rollout_bucket(p_salt text, p_tenant_key text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_salt IS NULL OR p_salt !~ '^[A-Za-z0-9_-]{8,128}$' THEN
    RAISE EXCEPTION 'malformed salt' USING ERRCODE = '22023';
  END IF;
  RETURN (('x' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_salt || ':' || p_tenant_key, 'UTF8')), 'hex'), 8))::bit(32)::bigint % 100)::integer;
END
$fn$;

-- Whether a tenant is on the candidate arm of a rollout (exclusion first, then inclusion, then the share bucket).
CREATE OR REPLACE FUNCTION public.rag_rollout_in_arm(p_rollout_id uuid, p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_rollout public.rag_rollouts%ROWTYPE;
  v_membership text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT * INTO v_rollout FROM public.rag_rollouts r WHERE r.id = p_rollout_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT t.membership INTO v_membership FROM public.rag_rollout_tenants t WHERE t.rollout_id = p_rollout_id AND t.tenant_key = p_tenant_key;
  IF v_membership = 'exclude' THEN
    RETURN false;
  END IF;
  IF v_membership = 'include' THEN
    RETURN true;
  END IF;
  RETURN v_rollout.mode = 'share' AND public.rag_rollout_bucket(v_rollout.salt, p_tenant_key) < v_rollout.share_percent;
END
$fn$;

-- The candidate chunking profiles of a ref as the {doc_type: profile_id} map the search override takes. An entry is either
-- '<doc_type>:<profile_id>' or a bare profile id (every built doc type of that id).
CREATE OR REPLACE FUNCTION public.rag_rollout_chunking_map(p_ref jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT COALESCE(pg_catalog.jsonb_object_agg(cp.doc_type, cp.id), '{}'::jsonb)
    FROM public.chunking_profiles cp
   WHERE cp.status IN ('ready', 'active')
     AND EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements_text(COALESCE(p_ref -> 'chunking_profile_ids', '[]'::jsonb)) AS e(entry)
        WHERE e.entry = cp.id OR e.entry = cp.doc_type || ':' || cp.id
     )
$fn$;

-- Publishes one tenant's held versions of a complete, eval-passed rebuild run (the per-item body of rag_rebuild_activate).
CREATE OR REPLACE FUNCTION public.rag_rollout_rebuild_publish_tenant(p_run_id uuid, p_tenant_key text)
RETURNS TABLE (document_id uuid, tenant_key text, outcome text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run record;
  v_item record;
  v_prev public.documents%ROWTYPE;
  v_new public.documents%ROWTYPE;
  v_outcome text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollout_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.activation <> 'rebuild_batch' THEN
    RAISE EXCEPTION 'rollout_refused: not_batch' USING ERRCODE = '55000';
  END IF;
  IF v_run.eval_evidence IS NULL THEN
    RAISE EXCEPTION 'rollout_refused: eval_missing' USING ERRCODE = '55000';
  END IF;
  IF (v_run.eval_evidence ->> 'passed') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'rollout_refused: eval_failed' USING ERRCODE = '55000';
  END IF;
  IF v_run.state NOT IN ('complete', 'activated') THEN
    PERFORM public.rag_rebuild_settle(v_run.id);
    SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id;
    IF v_run.state <> 'complete' THEN
      RAISE EXCEPTION 'rollout_refused: run_not_complete' USING ERRCODE = '55000';
    END IF;
  END IF;

  FOR v_item IN
    SELECT * FROM public.rag_rebuild_items i WHERE i.run_id = v_run.id AND i.tenant_key = p_tenant_key AND i.state = 'done' ORDER BY i.document_id
  LOOP
    v_prev := NULL;
    v_new := NULL;
    SELECT * INTO v_prev FROM public.documents d WHERE d.id = v_item.document_id AND d.tenant_key = v_item.tenant_key;
    IF FOUND THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_prev.tenant_key || '|' || v_prev.source || '|' || v_prev.source_key, 0));
      SELECT * INTO v_prev FROM public.documents d WHERE d.id = v_item.document_id FOR UPDATE;
    END IF;
    SELECT * INTO v_new FROM public.documents d WHERE d.id = v_item.new_document_id AND d.tenant_key = v_item.tenant_key FOR UPDATE;
    IF v_prev.id IS NULL OR v_new.id IS NULL OR NOT v_prev.is_current OR v_new.is_current
       OR (v_new.metadata -> 'publish_hold' ->> 'batch_id') IS DISTINCT FROM v_item.batch_id::text THEN
      UPDATE public.rag_rebuild_items i SET state = 'superseded', updated_at = pg_catalog.now()
       WHERE i.run_id = v_item.run_id AND i.document_id = v_item.document_id;
      RETURN QUERY SELECT v_item.new_document_id, v_item.tenant_key, 'superseded'::text;
      CONTINUE;
    END IF;

    INSERT INTO public.rag_rebuild_saved_vectors (run_id, chunk_id, document_id, tenant_key, embedding, vectors)
    SELECT v_run.id, c.id, c.document_id, c.tenant_key, c.embedding::text,
           COALESCE((
             SELECT pg_catalog.jsonb_object_agg(e.profile_id, pg_catalog.jsonb_build_object(
               'embedding', e.embedding::text, 'embedding_model', e.embedding_model, 'dims', e.dims, 'embedding_host', e.embedding_host))
               FROM public.chunk_embeddings e WHERE e.chunk_id = c.id
           ), '{}'::jsonb)
      FROM public.document_chunks c
     WHERE c.document_id = v_prev.id AND c.tenant_key = v_prev.tenant_key
    ON CONFLICT (run_id, chunk_id) DO NOTHING;

    PERFORM public.rag_release_publish_hold(v_new.id, v_new.tenant_key);
    SELECT p.outcome INTO v_outcome FROM public.rag_publish_document_version(v_new.id, v_new.tenant_key) AS p;
    IF v_outcome IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'rollout_failed: %', COALESCE(v_outcome, 'unknown') USING ERRCODE = '55000';
    END IF;
    UPDATE public.rag_rebuild_items i SET state = 'active', updated_at = pg_catalog.now()
     WHERE i.run_id = v_item.run_id AND i.document_id = v_item.document_id;
    RETURN QUERY SELECT v_new.id, v_new.tenant_key, 'published'::text;
  END LOOP;
END
$fn$;

-- Makes one tenant's replaced versions of a rebuild run current again with the vectors they had (the per-item body of
-- rag_rebuild_rollback). The rebuilt version leaves retrieval; its vectors are kept in rag_rebuild_saved_vectors, not dropped.
CREATE OR REPLACE FUNCTION public.rag_rollout_rebuild_restore_tenant(p_run_id uuid, p_tenant_key text)
RETURNS TABLE (document_id uuid, tenant_key text, outcome text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_item record;
  v_prev public.documents%ROWTYPE;
  v_new public.documents%ROWTYPE;
  has_slug boolean;
  moved_type text;
  moved_slug text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM 1 FROM public.rag_rebuild_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollout_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  has_slug := (
    SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('content_type', 'slug') AND NOT attisdropped
  );

  FOR v_item IN
    SELECT * FROM public.rag_rebuild_items i WHERE i.run_id = p_run_id AND i.tenant_key = p_tenant_key AND i.state = 'active' ORDER BY i.document_id
  LOOP
    v_prev := NULL;
    v_new := NULL;
    SELECT * INTO v_prev FROM public.documents d WHERE d.id = v_item.document_id AND d.tenant_key = v_item.tenant_key;
    IF NOT FOUND THEN
      UPDATE public.rag_rebuild_items i SET state = 'superseded', updated_at = pg_catalog.now()
       WHERE i.run_id = v_item.run_id AND i.document_id = v_item.document_id;
      RETURN QUERY SELECT v_item.document_id, v_item.tenant_key, 'superseded'::text;
      CONTINUE;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_prev.tenant_key || '|' || v_prev.source || '|' || v_prev.source_key, 0));
    SELECT * INTO v_prev FROM public.documents d WHERE d.id = v_item.document_id FOR UPDATE;
    SELECT * INTO v_new FROM public.documents d WHERE d.id = v_item.new_document_id AND d.tenant_key = v_item.tenant_key FOR UPDATE;
    IF v_new.id IS NULL OR NOT v_new.is_current OR v_prev.is_current OR v_prev.status IN ('deleted', 'failed', 'quarantined') THEN
      UPDATE public.rag_rebuild_items i SET state = 'superseded', updated_at = pg_catalog.now()
       WHERE i.run_id = v_item.run_id AND i.document_id = v_item.document_id;
      RETURN QUERY SELECT v_item.document_id, v_item.tenant_key, 'superseded'::text;
      CONTINUE;
    END IF;

    INSERT INTO public.rag_rebuild_saved_vectors (run_id, chunk_id, document_id, tenant_key, embedding, vectors)
    SELECT p_run_id, c.id, c.document_id, c.tenant_key, c.embedding::text,
           COALESCE((
             SELECT pg_catalog.jsonb_object_agg(e.profile_id, pg_catalog.jsonb_build_object(
               'embedding', e.embedding::text, 'embedding_model', e.embedding_model, 'dims', e.dims, 'embedding_host', e.embedding_host))
               FROM public.chunk_embeddings e WHERE e.chunk_id = c.id
           ), '{}'::jsonb)
      FROM public.document_chunks c
     WHERE c.document_id = v_new.id AND c.tenant_key = v_new.tenant_key
    ON CONFLICT (run_id, chunk_id) DO NOTHING;

    moved_type := NULL;
    moved_slug := NULL;
    IF has_slug THEN
      EXECUTE 'SELECT content_type, slug FROM public.documents WHERE id = $1' INTO moved_type, moved_slug USING v_new.id;
      EXECUTE 'UPDATE public.documents SET content_type = NULL, slug = NULL WHERE id = $1' USING v_new.id;
    END IF;
    UPDATE public.documents d SET is_current = false, superseded_by = v_prev.id,
           metadata = COALESCE(d.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('rollout_restored', p_run_id::text)
     WHERE d.id = v_new.id;
    UPDATE public.document_chunks c SET is_current = false, embedding = NULL WHERE c.document_id = v_new.id;
    DELETE FROM public.chunk_embeddings ce USING public.document_chunks c WHERE ce.chunk_id = c.id AND c.document_id = v_new.id;
    DELETE FROM public.embedding_backfill_gaps g USING public.document_chunks c WHERE g.chunk_id = c.id AND c.document_id = v_new.id;

    UPDATE public.documents d SET is_current = true, status = 'ready', superseded_by = NULL WHERE d.id = v_prev.id;
    IF has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
      EXECUTE 'UPDATE public.documents SET content_type = $2, slug = $3 WHERE id = $1' USING v_prev.id, moved_type, moved_slug;
    END IF;
    UPDATE public.document_chunks c SET is_current = true, status = 'ready',
           embedding = (SELECT s.embedding::public.vector FROM public.rag_rebuild_saved_vectors s WHERE s.run_id = p_run_id AND s.chunk_id = c.id)
     WHERE c.document_id = v_prev.id;
    INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT s.chunk_id, v.profile_id, s.tenant_key, (v.value ->> 'embedding')::public.halfvec, v.value ->> 'embedding_model',
           (v.value ->> 'dims')::integer, v.value ->> 'embedding_host'
      FROM public.rag_rebuild_saved_vectors s
      CROSS JOIN LATERAL pg_catalog.jsonb_each(s.vectors) AS v(profile_id, value)
     WHERE s.run_id = p_run_id AND s.document_id = v_prev.id
    ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      embedding_host = EXCLUDED.embedding_host;

    UPDATE public.rag_rebuild_items i SET state = 'restored', updated_at = pg_catalog.now()
     WHERE i.run_id = v_item.run_id AND i.document_id = v_item.document_id;
    RETURN QUERY SELECT v_prev.id, v_prev.tenant_key, 'restored'::text;
  END LOOP;
END
$fn$;

-- Brings a rebuild run's tenants in line with the arm: candidate-arm tenants published, every other tenant restored.
CREATE OR REPLACE FUNCTION public.rag_rollout_rebuild_sync(p_rollout_id uuid)
RETURNS TABLE (document_id uuid, tenant_key text, outcome text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_rollout public.rag_rollouts%ROWTYPE;
  v_run_id uuid;
  v_key text;
BEGIN
  SELECT * INTO v_rollout FROM public.rag_rollouts r WHERE r.id = p_rollout_id;
  IF NOT FOUND OR v_rollout.kind <> 'rebuild_run' THEN
    RETURN;
  END IF;
  v_run_id := (v_rollout.candidate_ref ->> 'rebuild_run_id')::uuid;
  FOR v_key IN SELECT DISTINCT i.tenant_key FROM public.rag_rebuild_items i WHERE i.run_id = v_run_id ORDER BY 1 LOOP
    IF v_rollout.state = 'active' AND public.rag_rollout_in_arm(p_rollout_id, v_key) THEN
      RETURN QUERY SELECT * FROM public.rag_rollout_rebuild_publish_tenant(v_run_id, v_key);
    ELSE
      RETURN QUERY SELECT * FROM public.rag_rollout_rebuild_restore_tenant(v_run_id, v_key);
    END IF;
  END LOOP;
END
$fn$;

-- Starts a rollout. p_tenants are included tenants; mode share also takes p_share_percent. Refusals (rollout_refused: <code>):
-- bad_kind, bad_mode, bad_ref, active_exists, candidate_not_found, candidate_not_backfilling, no_incumbent, candidate_is_incumbent,
-- chunking_not_built, run_not_found, not_batch, eval_missing, eval_failed, run_not_complete.
CREATE OR REPLACE FUNCTION public.rag_rollout_start(
  p_kind text,
  p_candidate_ref jsonb,
  p_mode text,
  p_share_percent integer DEFAULT NULL,
  p_tenants text[] DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_id uuid;
  v_incumbent jsonb;
  v_candidate text;
  v_status text;
  v_key text;
  v_run record;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('embedding_profile', 'chunking_profile', 'rebuild_run') THEN
    RAISE EXCEPTION 'rollout_refused: bad_kind' USING ERRCODE = '22023';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('tenants', 'share') OR (p_mode = 'share') <> (p_share_percent IS NOT NULL)
     OR (p_share_percent IS NOT NULL AND (p_share_percent < 0 OR p_share_percent > 100)) THEN
    RAISE EXCEPTION 'rollout_refused: bad_mode' USING ERRCODE = '22023';
  END IF;
  IF p_candidate_ref IS NULL OR pg_catalog.jsonb_typeof(p_candidate_ref) <> 'object' THEN
    RAISE EXCEPTION 'rollout_refused: bad_ref' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY COALESCE(p_tenants, ARRAY[]::text[]) LOOP
    PERFORM public.rag_assert_tenant_key(v_key);
  END LOOP;
  PERFORM 1 FROM public.rag_rollouts r WHERE r.kind = p_kind AND r.state = 'active';
  IF FOUND THEN
    RAISE EXCEPTION 'rollout_refused: active_exists' USING ERRCODE = '55000';
  END IF;

  IF p_kind = 'embedding_profile' THEN
    v_candidate := p_candidate_ref ->> 'embedding_profile_id';
    IF v_candidate IS NULL OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_candidate_ref)) <> 1 THEN
      RAISE EXCEPTION 'rollout_refused: bad_ref' USING ERRCODE = '22023';
    END IF;
    SELECT p.status INTO v_status FROM public.embedding_profiles p WHERE p.id = v_candidate;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rollout_refused: candidate_not_found' USING ERRCODE = '55000';
    END IF;
    IF v_status = 'active' THEN
      RAISE EXCEPTION 'rollout_refused: candidate_is_incumbent' USING ERRCODE = '55000';
    END IF;
    IF v_status <> 'backfilling' THEN
      RAISE EXCEPTION 'rollout_refused: candidate_not_backfilling' USING ERRCODE = '55000';
    END IF;
    SELECT pg_catalog.jsonb_build_object('embedding_profile_id', p.id) INTO v_incumbent FROM public.embedding_profiles p WHERE p.status = 'active';
    IF v_incumbent IS NULL THEN
      RAISE EXCEPTION 'rollout_refused: no_incumbent' USING ERRCODE = '55000';
    END IF;
  ELSIF p_kind = 'chunking_profile' THEN
    IF pg_catalog.jsonb_typeof(p_candidate_ref -> 'chunking_profile_ids') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_candidate_ref -> 'chunking_profile_ids') = 0
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_candidate_ref)) <> 1 THEN
      RAISE EXCEPTION 'rollout_refused: bad_ref' USING ERRCODE = '22023';
    END IF;
    IF public.rag_rollout_chunking_map(p_candidate_ref) = '{}'::jsonb THEN
      RAISE EXCEPTION 'rollout_refused: chunking_not_built' USING ERRCODE = '55000';
    END IF;
    SELECT pg_catalog.jsonb_build_object('chunking_profile_ids', pg_catalog.jsonb_agg(cp.doc_type || ':' || cp.id ORDER BY cp.doc_type))
      INTO v_incumbent
      FROM public.chunking_profiles cp
     WHERE cp.status = 'active' AND public.rag_rollout_chunking_map(p_candidate_ref) ? cp.doc_type;
    IF v_incumbent -> 'chunking_profile_ids' IS NULL OR v_incumbent -> 'chunking_profile_ids' = 'null'::jsonb THEN
      v_incumbent := NULL;
    END IF;
  ELSE
    IF (p_candidate_ref ->> 'rebuild_run_id') IS NULL OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_candidate_ref)) <> 1
       OR (p_candidate_ref ->> 'rebuild_run_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'rollout_refused: bad_ref' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = (p_candidate_ref ->> 'rebuild_run_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rollout_refused: run_not_found' USING ERRCODE = '55000';
    END IF;
    IF v_run.activation <> 'rebuild_batch' THEN
      RAISE EXCEPTION 'rollout_refused: not_batch' USING ERRCODE = '55000';
    END IF;
    IF v_run.eval_evidence IS NULL THEN
      RAISE EXCEPTION 'rollout_refused: eval_missing' USING ERRCODE = '55000';
    END IF;
    IF (v_run.eval_evidence ->> 'passed') IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'rollout_refused: eval_failed' USING ERRCODE = '55000';
    END IF;
    v_incumbent := NULL;
  END IF;

  INSERT INTO public.rag_rollouts (kind, candidate_ref, incumbent_ref, mode, share_percent, salt, created_by)
  VALUES (p_kind, p_candidate_ref, v_incumbent, p_mode, p_share_percent,
          pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), p_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.rag_rollout_tenants (rollout_id, tenant_key, membership, changed_by)
  SELECT v_id, k, 'include', p_actor FROM pg_catalog.unnest(COALESCE(p_tenants, ARRAY[]::text[])) AS k
  ON CONFLICT (rollout_id, tenant_key) DO NOTHING;

  IF p_kind = 'rebuild_run' THEN
    PERFORM public.rag_rollout_rebuild_sync(v_id);
  END IF;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'rollout_refused: active_exists' USING ERRCODE = '55000';
END
$fn$;

-- Includes or excludes one tenant. Exclusion moves the tenant back to the incumbent (for a rebuild run: restores its previous versions).
CREATE OR REPLACE FUNCTION public.rag_rollout_set_tenant(p_rollout_id uuid, p_tenant_key text, p_membership text, p_actor uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_rollout public.rag_rollouts%ROWTYPE;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_membership IS NULL OR p_membership NOT IN ('include', 'exclude') THEN
    RAISE EXCEPTION 'rollout_refused: bad_membership' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rollout FROM public.rag_rollouts r WHERE r.id = p_rollout_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollout_refused: not_found' USING ERRCODE = '22023';
  END IF;
  IF v_rollout.state <> 'active' THEN
    RAISE EXCEPTION 'rollout_refused: not_active' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.rag_rollout_tenants (rollout_id, tenant_key, membership, changed_by)
  VALUES (p_rollout_id, p_tenant_key, p_membership, p_actor)
  ON CONFLICT (rollout_id, tenant_key) DO UPDATE SET membership = EXCLUDED.membership, changed_by = EXCLUDED.changed_by, changed_at = pg_catalog.now();
  IF v_rollout.kind = 'rebuild_run' THEN
    IF public.rag_rollout_in_arm(p_rollout_id, p_tenant_key) THEN
      PERFORM public.rag_rollout_rebuild_publish_tenant((v_rollout.candidate_ref ->> 'rebuild_run_id')::uuid, p_tenant_key);
    ELSE
      PERFORM public.rag_rollout_rebuild_restore_tenant((v_rollout.candidate_ref ->> 'rebuild_run_id')::uuid, p_tenant_key);
    END IF;
  END IF;
  RETURN p_membership;
END
$fn$;

-- Ends a rollout for every tenant: all go back to the incumbent. Deletes no vector, chunk or version.
CREATE OR REPLACE FUNCTION public.rag_rollout_rollback(p_rollout_id uuid, p_actor uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_rollout public.rag_rollouts%ROWTYPE;
BEGIN
  SELECT * INTO v_rollout FROM public.rag_rollouts r WHERE r.id = p_rollout_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollout_refused: not_found' USING ERRCODE = '22023';
  END IF;
  IF v_rollout.state <> 'active' THEN
    RAISE EXCEPTION 'rollout_refused: not_active' USING ERRCODE = '55000';
  END IF;
  UPDATE public.rag_rollouts r SET state = 'rolled_back', ended_at = pg_catalog.now(), ended_by = p_actor WHERE r.id = p_rollout_id;
  IF v_rollout.kind = 'rebuild_run' THEN
    PERFORM public.rag_rollout_rebuild_sync(p_rollout_id);
  END IF;
  RETURN 'rolled_back';
END
$fn$;

-- Closes an active rollout as promoted or cancelled (plan 07-49 runs the promotion itself). Cancelling a rebuild run restores its tenants.
CREATE OR REPLACE FUNCTION public.rag_rollout_finish(p_rollout_id uuid, p_state text, p_actor uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_rollout public.rag_rollouts%ROWTYPE;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('promoted', 'cancelled') THEN
    RAISE EXCEPTION 'rollout_refused: bad_state' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rollout FROM public.rag_rollouts r WHERE r.id = p_rollout_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollout_refused: not_found' USING ERRCODE = '22023';
  END IF;
  IF v_rollout.state <> 'active' THEN
    RAISE EXCEPTION 'rollout_refused: not_active' USING ERRCODE = '55000';
  END IF;
  UPDATE public.rag_rollouts r SET state = p_state, ended_at = pg_catalog.now(), ended_by = p_actor WHERE r.id = p_rollout_id;
  IF v_rollout.kind = 'rebuild_run' AND p_state = 'cancelled' THEN
    PERFORM public.rag_rollout_rebuild_sync(p_rollout_id);
  END IF;
  RETURN p_state;
END
$fn$;

-- The active rollouts with their tenant lists, for the request-path resolver (server role only; the salt never leaves the server).
CREATE OR REPLACE FUNCTION public.rag_rollout_active()
RETURNS TABLE (
  id uuid,
  kind text,
  candidate_ref jsonb,
  incumbent_ref jsonb,
  mode text,
  share_percent integer,
  salt text,
  included_tenants text[],
  excluded_tenants text[],
  chunking_map jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT r.id, r.kind, r.candidate_ref, r.incumbent_ref, r.mode, r.share_percent, r.salt,
         COALESCE((SELECT pg_catalog.array_agg(t.tenant_key ORDER BY t.tenant_key) FROM public.rag_rollout_tenants t
                    WHERE t.rollout_id = r.id AND t.membership = 'include'), ARRAY[]::text[]),
         COALESCE((SELECT pg_catalog.array_agg(t.tenant_key ORDER BY t.tenant_key) FROM public.rag_rollout_tenants t
                    WHERE t.rollout_id = r.id AND t.membership = 'exclude'), ARRAY[]::text[]),
         CASE WHEN r.kind = 'chunking_profile' THEN public.rag_rollout_chunking_map(r.candidate_ref) ELSE NULL END,
         r.created_at
    FROM public.rag_rollouts r
   WHERE r.state = 'active'
   ORDER BY r.kind
$fn$;

REVOKE ALL ON FUNCTION public.rag_rollout_bucket(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_in_arm(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_chunking_map(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_rebuild_publish_tenant(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_rebuild_restore_tenant(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_rebuild_sync(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_start(text, jsonb, text, integer, text[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_set_tenant(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_rollback(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_finish(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollout_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_rollout_bucket(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_in_arm(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_chunking_map(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_rebuild_publish_tenant(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_rebuild_restore_tenant(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_rebuild_sync(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_start(text, jsonb, text, integer, text[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_set_tenant(uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_rollback(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_finish(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollout_active() TO service_role;

COMMIT;

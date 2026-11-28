-- 0809: side-by-side rebuilds (plan 03.2-19; D-11, D-12; research F-1, F-9, Pattern 4; LANG-04).
-- rag_rebuild_runs is the run ledger of `npm run rag:rebuild` and the admin rebuild routes: one row per mechanism and settings hash, with
-- the activation that applies (rebuild_batch for reparse, chunking_profiles for rechunk; embedding_profiles and none are reserved for the
-- command mechanisms), progress counts, the recorded eval evidence and the activation and rollback times. Only one open run (running,
-- complete or incomplete) exists per mechanism and settings hash, so a second start returns the first run.
-- rag_rebuild_items lists the documents a reparse run rebuilds: the current version it replaces, the held version the queue wrote, the
-- per-tenant ingestion batch (hold_publish) and the job. rag_rebuild_saved_vectors keeps, per chunk of a replaced version, the vectors the
-- publish function deletes, so a rollback makes the previous version current again with exactly the vectors it had.
-- rag_rebuild_start, rag_rebuild_progress, rag_rebuild_report, rag_rebuild_record_evidence, rag_rebuild_activate and rag_rebuild_rollback
-- lock the run row and check its state after the lock. Activation requires recorded passing evidence and every item rebuilt; it releases
-- each held version (rag_release_publish_hold) and publishes it through rag_publish_document_version. An item whose replaced version is no
-- longer current (a newer upload) is skipped as superseded and its held version stays unpublished.
-- rag_rebuild_candidates lists current ready documents with their stored fingerprint parts for the selection, which the app computes.
-- Purge: rag_purge_hook_rebuild(p_tenant_key, p_lineage_id, p_document_ids) removes the items and saved vectors of those documents.
-- Tables: RLS on, no policies, nothing granted to anon or authenticated. Functions: SECURITY INVOKER, SET search_path = '', schema-qualified
-- names, REVOKE ALL FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature. The tenant of every item is the
-- tenant of its document row and is asserted with rag_assert_tenant_key. Not folded into the setup files. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_rebuild_runs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  mechanism text NOT NULL,
  settings_hash text NOT NULL,
  activation text NOT NULL,
  state text NOT NULL DEFAULT 'running',
  total integer NOT NULL DEFAULT 0,
  done integer NOT NULL DEFAULT 0,
  gaps integer NOT NULL DEFAULT 0,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  eval_evidence jsonb,
  started_by text,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  activated_at timestamptz,
  activated_by text,
  rolled_back_at timestamptz,
  rolled_back_by text,
  CONSTRAINT rag_rebuild_runs_mechanism_check CHECK (mechanism IN ('reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate')),
  CONSTRAINT rag_rebuild_runs_settings_hash_check CHECK (settings_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rag_rebuild_runs_activation_check CHECK (activation IN ('rebuild_batch', 'chunking_profiles', 'embedding_profiles', 'none')),
  CONSTRAINT rag_rebuild_runs_state_check CHECK (state IN ('running', 'complete', 'incomplete', 'activated', 'rolled_back')),
  CONSTRAINT rag_rebuild_runs_counts_check CHECK (total >= 0 AND done >= 0 AND gaps >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_rebuild_runs_one_open
  ON public.rag_rebuild_runs (mechanism, settings_hash)
  WHERE state IN ('running', 'complete', 'incomplete');

CREATE TABLE IF NOT EXISTS public.rag_rebuild_items (
  run_id uuid NOT NULL REFERENCES public.rag_rebuild_runs (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  tenant_key text NOT NULL,
  lineage_id uuid,
  new_document_id uuid,
  batch_id uuid,
  job_id uuid,
  state text NOT NULL DEFAULT 'pending',
  reason text,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (run_id, document_id),
  CONSTRAINT rag_rebuild_items_state_check CHECK (state IN ('pending', 'queued', 'done', 'gap', 'active', 'superseded', 'restored')),
  CONSTRAINT rag_rebuild_items_reason_check CHECK (reason IS NULL OR pg_catalog.length(reason) <= 64)
);

CREATE INDEX IF NOT EXISTS rag_rebuild_items_document ON public.rag_rebuild_items (tenant_key, document_id);

CREATE TABLE IF NOT EXISTS public.rag_rebuild_saved_vectors (
  run_id uuid NOT NULL REFERENCES public.rag_rebuild_runs (id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL,
  document_id uuid NOT NULL,
  tenant_key text NOT NULL,
  embedding text,
  vectors jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS rag_rebuild_saved_vectors_document ON public.rag_rebuild_saved_vectors (tenant_key, document_id);

ALTER TABLE public.rag_rebuild_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_rebuild_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_rebuild_saved_vectors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_rebuild_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_rebuild_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_rebuild_saved_vectors FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_rebuild_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_rebuild_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_rebuild_saved_vectors TO service_role;

-- Current ready documents with their stored fingerprint parts, in id order, optionally limited to some doc types (all tenants: the settings
-- are deployment-wide). The app decides which of them a mechanism affects.
CREATE OR REPLACE FUNCTION public.rag_rebuild_candidates(p_doc_types text[] DEFAULT NULL, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE (id uuid, tenant_key text, doc_type text, ingest_fingerprint text, parts jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT d.id, d.tenant_key, d.doc_type, d.ingest_fingerprint,
         CASE WHEN d.ingest_fingerprint IS NULL THEN NULL ELSE d.metadata -> 'ingest_fingerprint_parts' END
    FROM public.documents d
   WHERE d.is_current
     AND d.status = 'ready'
     AND (p_doc_types IS NULL OR d.doc_type = ANY (p_doc_types))
     AND (p_after IS NULL OR d.id > p_after)
   ORDER BY d.id
   LIMIT p_limit;
END
$fn$;

-- Item states from the ledger: a queued item whose job is ready and whose version carries the run's batch hold is done; a job that ended
-- in any other terminal status is a gap with that status as the reason. Then the run counts and state follow the items.
CREATE OR REPLACE FUNCTION public.rag_rebuild_settle(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_total integer;
  v_done integer;
  v_gaps integer;
  v_open integer;
BEGIN
  UPDATE public.rag_rebuild_items i SET state = 'done', reason = NULL, updated_at = pg_catalog.now()
    FROM public.ingestion_jobs j, public.documents d
   WHERE i.run_id = p_run_id AND i.state = 'queued' AND j.id = i.job_id AND j.status = 'ready'
     AND d.id = i.new_document_id AND d.tenant_key = i.tenant_key AND NOT d.is_current
     AND d.metadata -> 'publish_hold' ->> 'batch_id' = i.batch_id::text;
  UPDATE public.rag_rebuild_items i SET state = 'gap', reason = 'job_' || j.status, updated_at = pg_catalog.now()
    FROM public.ingestion_jobs j
   WHERE i.run_id = p_run_id AND i.state = 'queued' AND j.id = i.job_id
     AND j.status IN ('failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review');
  UPDATE public.rag_rebuild_items i SET state = 'gap', reason = 'not_held', updated_at = pg_catalog.now()
    FROM public.ingestion_jobs j
   WHERE i.run_id = p_run_id AND i.state = 'queued' AND j.id = i.job_id AND j.status = 'ready';

  SELECT pg_catalog.count(*)::integer,
         (pg_catalog.count(*) FILTER (WHERE i.state = 'done'))::integer,
         (pg_catalog.count(*) FILTER (WHERE i.state = 'gap'))::integer,
         (pg_catalog.count(*) FILTER (WHERE i.state IN ('pending', 'queued')))::integer
    INTO v_total, v_done, v_gaps, v_open
    FROM public.rag_rebuild_items i WHERE i.run_id = p_run_id;

  UPDATE public.rag_rebuild_runs r SET
    total = v_total, done = v_done, gaps = v_gaps,
    state = CASE WHEN v_open > 0 THEN 'running' WHEN v_gaps > 0 THEN 'incomplete' ELSE 'complete' END,
    updated_at = pg_catalog.now()
   WHERE r.id = p_run_id AND r.state IN ('running', 'complete', 'incomplete');
END
$fn$;

-- Starts a run, or returns the open run of the same mechanism and settings. An incomplete run is reopened: its gaps go back to pending, so
-- a restart processes only the documents that were not rebuilt. p_items: [{tenant_key, document_id}] of current ready documents; any other
-- entry is ignored. A reparse run gets one ingestion batch with hold_publish per tenant of its items.
CREATE OR REPLACE FUNCTION public.rag_rebuild_start(
  p_mechanism text,
  p_settings_hash text,
  p_activation text,
  p_plan jsonb,
  p_items jsonb,
  p_total integer,
  p_started_by text
)
RETURNS TABLE (run_id uuid, state text, resumed boolean, total integer, done integer, gaps integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_rebuild_runs%ROWTYPE;
  v_tenant text;
  v_batch uuid;
BEGIN
  IF p_mechanism IS NULL OR p_mechanism NOT IN ('reparse', 'rechunk') THEN
    RAISE EXCEPTION 'invalid_mechanism' USING ERRCODE = '22023';
  END IF;
  IF p_settings_hash IS NULL OR p_settings_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_settings_hash' USING ERRCODE = '22023';
  END IF;
  IF (p_mechanism = 'reparse' AND p_activation IS DISTINCT FROM 'rebuild_batch')
     OR (p_mechanism = 'rechunk' AND p_activation IS DISTINCT FROM 'chunking_profiles') THEN
    RAISE EXCEPTION 'invalid_activation' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NOT NULL AND pg_catalog.jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_items' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_rebuild|' || p_mechanism || '|' || p_settings_hash, 0));

  SELECT * INTO v_run FROM public.rag_rebuild_runs r
   WHERE r.mechanism = p_mechanism AND r.settings_hash = p_settings_hash AND r.state IN ('running', 'complete', 'incomplete')
   FOR UPDATE;
  IF FOUND THEN
    IF v_run.state = 'incomplete' THEN
      UPDATE public.rag_rebuild_items i SET state = 'pending', reason = NULL, new_document_id = NULL, job_id = NULL, updated_at = pg_catalog.now()
       WHERE i.run_id = v_run.id AND i.state = 'gap';
      UPDATE public.rag_rebuild_runs r SET state = 'running', gaps = 0, updated_at = pg_catalog.now() WHERE r.id = v_run.id;
    END IF;
    SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = v_run.id;
    RETURN QUERY SELECT v_run.id, v_run.state, true, v_run.total, v_run.done, v_run.gaps;
    RETURN;
  END IF;

  INSERT INTO public.rag_rebuild_runs AS r (mechanism, settings_hash, activation, state, plan, started_by, total)
  VALUES (p_mechanism, p_settings_hash, p_activation, 'running', COALESCE(p_plan, '{}'::jsonb), p_started_by, GREATEST(COALESCE(p_total, 0), 0))
  RETURNING r.* INTO v_run;

  IF p_mechanism = 'reparse' THEN
    INSERT INTO public.rag_rebuild_items (run_id, document_id, tenant_key, lineage_id)
    SELECT DISTINCT v_run.id, d.id, d.tenant_key, d.lineage_id
      FROM pg_catalog.jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb)) AS x(tenant_key text, document_id uuid)
      JOIN public.documents d ON d.id = x.document_id AND d.tenant_key = x.tenant_key
     WHERE d.is_current AND d.status = 'ready';
    IF NOT EXISTS (SELECT 1 FROM public.rag_rebuild_items i WHERE i.run_id = v_run.id) THEN
      RAISE EXCEPTION 'nothing_to_rebuild' USING ERRCODE = '22023';
    END IF;
    FOR v_tenant IN SELECT DISTINCT i.tenant_key FROM public.rag_rebuild_items i WHERE i.run_id = v_run.id ORDER BY 1 LOOP
      PERFORM public.rag_assert_tenant_key(v_tenant);
      INSERT INTO public.ingestion_batches AS b (tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, status, created_by, hold_publish)
      VALUES (v_tenant, 'manifest', 'rebuild:' || v_run.id::text, NULL, 2, 'worker', 'running', p_started_by, true)
      RETURNING b.id INTO v_batch;
      UPDATE public.rag_rebuild_items i SET batch_id = v_batch WHERE i.run_id = v_run.id AND i.tenant_key = v_tenant;
    END LOOP;
    UPDATE public.rag_rebuild_runs r SET total = (SELECT pg_catalog.count(*) FROM public.rag_rebuild_items i WHERE i.run_id = v_run.id)
     WHERE r.id = v_run.id;
  END IF;

  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = v_run.id;
  RETURN QUERY SELECT v_run.id, v_run.state, false, v_run.total, v_run.done, v_run.gaps;
END
$fn$;

-- One item's progress (queued with its job and held version, or a gap with a reason), then the run is settled from the items and the
-- ledger. A NULL document id only settles.
CREATE OR REPLACE FUNCTION public.rag_rebuild_progress(
  p_run_id uuid,
  p_document_id uuid,
  p_state text,
  p_new_document_id uuid,
  p_job_id uuid,
  p_reason text
)
RETURNS TABLE (run_id uuid, state text, total integer, done integer, gaps integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_rebuild_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NOT NULL THEN
    IF v_run.state NOT IN ('running', 'complete', 'incomplete') THEN
      RAISE EXCEPTION 'progress_refused: %', v_run.state USING ERRCODE = '55000';
    END IF;
    IF p_state IS NULL OR p_state NOT IN ('queued', 'gap') THEN
      RAISE EXCEPTION 'invalid_state' USING ERRCODE = '22023';
    END IF;
    UPDATE public.rag_rebuild_items i SET
      state = p_state,
      new_document_id = CASE WHEN p_state = 'queued' THEN p_new_document_id ELSE i.new_document_id END,
      job_id = CASE WHEN p_state = 'queued' THEN p_job_id ELSE i.job_id END,
      reason = CASE WHEN p_state = 'gap' THEN pg_catalog.left(COALESCE(p_reason, 'unknown'), 64) ELSE NULL END,
      updated_at = pg_catalog.now()
     WHERE i.run_id = p_run_id AND i.document_id = p_document_id AND i.state IN ('pending', 'queued');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'item_not_open' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF v_run.mechanism = 'reparse' THEN
    PERFORM public.rag_rebuild_settle(p_run_id);
  END IF;
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id;
  RETURN QUERY SELECT v_run.id, v_run.state, v_run.total, v_run.done, v_run.gaps;
END
$fn$;

-- Counts of a run without items (rechunk: the chunking-profile builds report them). p_finished settles the state.
CREATE OR REPLACE FUNCTION public.rag_rebuild_report(p_run_id uuid, p_total integer, p_done integer, p_gaps integer, p_finished boolean)
RETURNS TABLE (run_id uuid, state text, total integer, done integer, gaps integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_rebuild_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.state NOT IN ('running', 'complete', 'incomplete') THEN
    RAISE EXCEPTION 'progress_refused: %', v_run.state USING ERRCODE = '55000';
  END IF;
  UPDATE public.rag_rebuild_runs r SET
    total = GREATEST(COALESCE(p_total, r.total), 0),
    done = GREATEST(COALESCE(p_done, r.done), 0),
    gaps = GREATEST(COALESCE(p_gaps, r.gaps), 0),
    state = CASE WHEN p_finished IS NOT TRUE THEN 'running' WHEN COALESCE(p_gaps, r.gaps) > 0 THEN 'incomplete' ELSE 'complete' END,
    updated_at = pg_catalog.now()
   WHERE r.id = p_run_id
  RETURNING r.* INTO v_run;
  RETURN QUERY SELECT v_run.id, v_run.state, v_run.total, v_run.done, v_run.gaps;
END
$fn$;

-- Stores the eval result of a run that is not activated or rolled back. p_evidence must be an object with a boolean `passed`.
CREATE OR REPLACE FUNCTION public.rag_rebuild_record_evidence(p_run_id uuid, p_evidence jsonb)
RETURNS TABLE (run_id uuid, passed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_rebuild_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.state IN ('activated', 'rolled_back') THEN
    RAISE EXCEPTION 'evidence_refused: %', v_run.state USING ERRCODE = '55000';
  END IF;
  IF p_evidence IS NULL OR pg_catalog.jsonb_typeof(p_evidence) <> 'object' OR pg_catalog.jsonb_typeof(p_evidence -> 'passed') <> 'boolean' THEN
    RAISE EXCEPTION 'invalid_evidence' USING ERRCODE = '22023';
  END IF;
  UPDATE public.rag_rebuild_runs r SET
    eval_evidence = p_evidence || pg_catalog.jsonb_build_object('recorded_at', pg_catalog.now()),
    updated_at = pg_catalog.now()
   WHERE r.id = p_run_id;
  RETURN QUERY SELECT p_run_id, (p_evidence ->> 'passed')::boolean;
END
$fn$;

-- D-12: publishes the held versions of a complete reparse run that has passing evidence. The run row is locked and its state checked after
-- the lock, so a second or concurrent activation is refused. Refusals: activation_refused: not_batch, already_activated,
-- already_rolled_back, eval_missing, eval_failed, incomplete. Returns the published versions for the post-publish hooks.
CREATE OR REPLACE FUNCTION public.rag_rebuild_activate(p_run_id uuid, p_actor text)
RETURNS TABLE (document_id uuid, tenant_key text, outcome text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_rebuild_runs%ROWTYPE;
  v_item public.rag_rebuild_items%ROWTYPE;
  v_prev public.documents%ROWTYPE;
  v_new public.documents%ROWTYPE;
  v_outcome text;
BEGIN
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.activation <> 'rebuild_batch' THEN
    RAISE EXCEPTION 'activation_refused: not_batch' USING ERRCODE = '55000';
  END IF;
  IF v_run.state = 'activated' THEN
    RAISE EXCEPTION 'activation_refused: already_activated' USING ERRCODE = '55000';
  END IF;
  IF v_run.state = 'rolled_back' THEN
    RAISE EXCEPTION 'activation_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.eval_evidence IS NULL THEN
    RAISE EXCEPTION 'activation_refused: eval_missing' USING ERRCODE = '55000';
  END IF;
  IF (v_run.eval_evidence ->> 'passed') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'activation_refused: eval_failed' USING ERRCODE = '55000';
  END IF;
  PERFORM public.rag_rebuild_settle(v_run.id);
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id;
  IF v_run.state <> 'complete' THEN
    RAISE EXCEPTION 'activation_refused: incomplete' USING ERRCODE = '55000';
  END IF;

  FOR v_item IN SELECT * FROM public.rag_rebuild_items i WHERE i.run_id = v_run.id AND i.state = 'done' ORDER BY i.document_id LOOP
    PERFORM public.rag_assert_tenant_key(v_item.tenant_key);
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
      RAISE EXCEPTION 'activation_failed: %', COALESCE(v_outcome, 'unknown') USING ERRCODE = '55000';
    END IF;
    UPDATE public.rag_rebuild_items i SET state = 'active', updated_at = pg_catalog.now()
     WHERE i.run_id = v_item.run_id AND i.document_id = v_item.document_id;
    RETURN QUERY SELECT v_new.id, v_new.tenant_key, 'published'::text;
  END LOOP;

  UPDATE public.rag_rebuild_runs r SET state = 'activated', activated_at = pg_catalog.now(), activated_by = p_actor, updated_at = pg_catalog.now()
   WHERE r.id = v_run.id;
END
$fn$;

-- D-12: makes the replaced versions of an activated run current again with the vectors they had, and takes the rebuilt versions out of
-- retrieval. A rebuilt version that is no longer current (a newer version replaced it) is skipped as superseded. Refusals:
-- rollback_refused: not_activated, already_rolled_back. Returns the restored versions for the post-publish hooks.
CREATE OR REPLACE FUNCTION public.rag_rebuild_rollback(p_run_id uuid, p_actor text)
RETURNS TABLE (document_id uuid, tenant_key text, outcome text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_rebuild_runs%ROWTYPE;
  v_item public.rag_rebuild_items%ROWTYPE;
  v_prev public.documents%ROWTYPE;
  v_new public.documents%ROWTYPE;
  has_slug boolean;
  moved_type text;
  moved_slug text;
BEGIN
  SELECT * INTO v_run FROM public.rag_rebuild_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.state = 'rolled_back' THEN
    RAISE EXCEPTION 'rollback_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.state <> 'activated' OR v_run.activation <> 'rebuild_batch' THEN
    RAISE EXCEPTION 'rollback_refused: not_activated' USING ERRCODE = '55000';
  END IF;

  has_slug := (
    SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('content_type', 'slug') AND NOT attisdropped
  );

  FOR v_item IN SELECT * FROM public.rag_rebuild_items i WHERE i.run_id = v_run.id AND i.state = 'active' ORDER BY i.document_id LOOP
    PERFORM public.rag_assert_tenant_key(v_item.tenant_key);
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

    moved_type := NULL;
    moved_slug := NULL;
    IF has_slug THEN
      EXECUTE 'SELECT content_type, slug FROM public.documents WHERE id = $1' INTO moved_type, moved_slug USING v_new.id;
      EXECUTE 'UPDATE public.documents SET content_type = NULL, slug = NULL WHERE id = $1' USING v_new.id;
    END IF;
    UPDATE public.documents d SET is_current = false, superseded_by = v_prev.id,
           metadata = COALESCE(d.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('rebuild_rolled_back', v_run.id::text)
     WHERE d.id = v_new.id;
    UPDATE public.document_chunks c SET is_current = false, embedding = NULL WHERE c.document_id = v_new.id;
    DELETE FROM public.chunk_embeddings ce USING public.document_chunks c WHERE ce.chunk_id = c.id AND c.document_id = v_new.id;
    DELETE FROM public.embedding_backfill_gaps g USING public.document_chunks c WHERE g.chunk_id = c.id AND c.document_id = v_new.id;

    UPDATE public.documents d SET is_current = true, status = 'ready', superseded_by = NULL WHERE d.id = v_prev.id;
    IF has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
      EXECUTE 'UPDATE public.documents SET content_type = $2, slug = $3 WHERE id = $1' USING v_prev.id, moved_type, moved_slug;
    END IF;
    UPDATE public.document_chunks c SET is_current = true, status = 'ready',
           embedding = (SELECT s.embedding::public.vector FROM public.rag_rebuild_saved_vectors s WHERE s.run_id = v_run.id AND s.chunk_id = c.id)
     WHERE c.document_id = v_prev.id;
    INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT s.chunk_id, v.profile_id, s.tenant_key, (v.value ->> 'embedding')::public.halfvec, v.value ->> 'embedding_model',
           (v.value ->> 'dims')::integer, v.value ->> 'embedding_host'
      FROM public.rag_rebuild_saved_vectors s
      CROSS JOIN LATERAL pg_catalog.jsonb_each(s.vectors) AS v(profile_id, value)
     WHERE s.run_id = v_run.id AND s.document_id = v_prev.id
    ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      embedding_host = EXCLUDED.embedding_host;

    UPDATE public.rag_rebuild_items i SET state = 'restored', updated_at = pg_catalog.now()
     WHERE i.run_id = v_item.run_id AND i.document_id = v_item.document_id;
    RETURN QUERY SELECT v_prev.id, v_prev.tenant_key, 'restored'::text;
  END LOOP;

  UPDATE public.rag_rebuild_runs r SET state = 'rolled_back', rolled_back_at = pg_catalog.now(), rolled_back_by = p_actor, updated_at = pg_catalog.now()
   WHERE r.id = v_run.id;
END
$fn$;

-- Run rows for the admin view and the CLI: counts and state only, no document id or tenant key.
CREATE OR REPLACE FUNCTION public.rag_rebuild_list(p_run_id uuid DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  mechanism text,
  activation text,
  state text,
  total integer,
  done integer,
  gaps integer,
  plan jsonb,
  evidence_passed boolean,
  started_at timestamptz,
  activated_at timestamptz,
  rolled_back_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  RETURN QUERY
  SELECT r.id, r.mechanism, r.activation, r.state, r.total, r.done, r.gaps, r.plan,
         CASE WHEN r.eval_evidence IS NULL THEN NULL ELSE (r.eval_evidence ->> 'passed')::boolean END,
         r.started_at, r.activated_at, r.rolled_back_at
    FROM public.rag_rebuild_runs r
   WHERE p_run_id IS NULL OR r.id = p_run_id
   ORDER BY r.started_at DESC, r.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END
$fn$;

-- The items of a run in a state, in document order, for the runner.
CREATE OR REPLACE FUNCTION public.rag_rebuild_items_page(p_run_id uuid, p_state text, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS TABLE (document_id uuid, tenant_key text, lineage_id uuid, batch_id uuid, state text, reason text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  RETURN QUERY
  SELECT i.document_id, i.tenant_key, i.lineage_id, i.batch_id, i.state, i.reason
    FROM public.rag_rebuild_items i
   WHERE i.run_id = p_run_id AND (p_state IS NULL OR i.state = p_state) AND (p_after IS NULL OR i.document_id > p_after)
   ORDER BY i.document_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_rebuild(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_ids uuid[];
  v_n integer;
  v_m integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  v_ids := COALESCE(p_document_ids, '{}'::uuid[]) || COALESCE((
    SELECT pg_catalog.array_agg(d.id) FROM public.documents d WHERE p_lineage_id IS NOT NULL AND d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key
  ), '{}'::uuid[]);
  DELETE FROM public.rag_rebuild_saved_vectors s WHERE s.tenant_key = p_tenant_key AND s.document_id = ANY (v_ids);
  GET DIAGNOSTICS v_m = ROW_COUNT;
  DELETE FROM public.rag_rebuild_items i
   WHERE i.tenant_key = p_tenant_key
     AND (i.document_id = ANY (v_ids) OR i.new_document_id = ANY (v_ids) OR (p_lineage_id IS NOT NULL AND i.lineage_id = p_lineage_id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n + v_m;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_rebuild_candidates(text[], uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_settle(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_start(text, text, text, jsonb, jsonb, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_progress(uuid, uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_report(uuid, integer, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_record_evidence(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_activate(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_rollback(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_list(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rebuild_items_page(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_rebuild(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_candidates(text[], uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_settle(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_start(text, text, text, jsonb, jsonb, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_progress(uuid, uuid, text, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_report(uuid, integer, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_record_evidence(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_activate(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_rollback(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_list(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rebuild_items_page(uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_rebuild(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

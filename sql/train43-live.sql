-- Train 43 live SQL (ci/merge-train-43 @ 5d771c8d7, after main cbc51d53 = train 42 #142 and exec/quick-511-sec). Apply after
-- train 42 is live (sql/train42-live.sql, which itself runs after train 41's SQL). One file for both deployment modes: every
-- train-43 migration is common (no .single-tenant.sql / .multi-tenant.sql variant). quick-511-sec and the main merge add no migration.
-- Order: 0742, 0743, 0744, 0745. No 0410 delta: train 43 adds no line to 0410 (0742 redefines the two 0702 trigger functions with
-- CREATE OR REPLACE, which keeps their existing grants; every other new function grants itself to service_role only).
-- Source: Phase 7 line merged from exec/07-31 (c536c9e5) and exec/07-49 (d4af52b6): 0742 = 07-39 (vector sync carries access groups),
-- 0743 = 07-46 (rag_language_quality_cells), 0744 = 07-47 (per-tenant rollouts), 0745 = 07-52 (language add candidates).
-- 07-31 folds 0701-0707 into both setup files. That changes fresh installs only; nothing here re-runs 0701-0707 on a live database.
-- Migration numbers: check-migration-numbers passes on the train (07xx through 0746; 0746 is train 42's purge_lexical_stats).
-- Dependencies (each file stops or fails if they are missing):
--   0742 needs 0701-0705 (vector sync outbox, triggers, claim, rag_validate_chunks, reads) and 0921/0923 (access_groups on documents
--        and chunks; on a live database the column already exists, ADD COLUMN IF NOT EXISTS is a no-op). After re-running 0702 or 0705,
--        re-run 0742.
--   0743 needs 0531-0533 (rag_retrieval_log with the D-29 columns query_language, query_language_confidence, feedback_*).
--   0744 needs 0803 (rag_release_publish_hold), 0806 (rag_publish_document_version), 0809 (rag_rebuild_runs / _items / _saved_vectors),
--        the embedding and chunking profile tables, and rag_assert_tenant_key.
--   0745 needs 0808 (stored fingerprint parts) and rag_assert_tenant_key.
-- App compatibility: additive for the app on main. 0742 adds access_groups to the rows the vector sync read functions return
--   (same arguments) and to the compared columns of the two UPDATE triggers; with no external target enabled (the default) the
--   triggers enqueue nothing and the one-time re-sync enqueues nothing. 0743, 0744 and 0745 add new tables and functions only.
--   RAG_ROLLOUTS and RAG_LANG_CONFIDENCE stay at their defaults; nothing here flips a default.
-- DROP sections: none. 0742-0745 use CREATE OR REPLACE / CREATE ... IF NOT EXISTS only.
-- Rehearsed on PGlite on a train-42 database (setup file plus every train-42 migration), both modes, applied twice in a row, with no
-- external target and with weaviate enabled: both passes succeed, the Verify block returns the expected values, no row is queued.
-- Operational notes:
--   0742 replaces the documents and document_chunks UPDATE trigger functions in place; a concurrent update waits on the lock briefly.
--   0744 writes no row: rollouts start only through the rollout CLI or admin route (operator, later).

-- ==== supabase/migrations/0742_vector_sync_access_groups.sql
-- 0742: Phase 7 vector sync carries document access groups (SEC-12, RET-06; D-01, D-02, D-03 extended, A-7).
-- rag_vector_sync_document_rows and rag_vector_sync_chunk_row (0705) also return access_groups, the chunk column Phase 4.3 keeps equal to
-- its document's (0921, 0923). Arguments, SECURITY INVOKER, search_path '', the tenant guard and the service-role grants stay as in 0705.
-- The column is added here with 0921's exact definition (text[] NOT NULL DEFAULT '{all}', seam 2) because migrations apply in name order,
-- so 0742 runs before 0921 on a fresh install; 0921 then adds its check, index and copy trigger to the same column.
-- Group changes reach the outbox: access_groups joins the compared columns of the 0702 UPDATE trigger functions on documents and
-- document_chunks (rag_vector_sync_documents_update, rag_vector_sync_chunks_update), which enqueue a `document` row per changed document
-- for every enabled target through rag_vector_sync_enqueue. Their triggers stay as in 0702 (one statement trigger per event, A-7) and so
-- do their rights and early exit; after re-running 0702, re-run this file.
-- rag_validate_chunks_for_groups is rag_validate_chunks (0704) restricted to chunks whose access_groups overlap p_access_groups; NULL or
-- empty groups raise 22023 (fail closed). Plan 07-39 re-validates external hits with it.
-- One-time re-sync: when this file changes the read functions (they did not return access_groups yet), it enqueues one `tenant` row per
-- enabled target and tenant with index state, so points written before 0742 gain the field through the normal drain. A default install
-- (no target enabled) enqueues nothing; a re-run finds the functions already current and enqueues nothing.
-- Not folded into the setup files. Idempotent.

BEGIN;

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';

DO $reads$
DECLARE
  v_current boolean;
  v_target text;
  v_tenants text[];
  v_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'rag_vector_sync_document_rows'
       AND 'access_groups' = ANY(coalesce(p.proargnames, '{}'::text[]))
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'rag_vector_sync_chunk_row'
       AND 'access_groups' = ANY(coalesce(p.proargnames, '{}'::text[]))
  ) INTO v_current;

  IF v_current THEN
    RETURN;
  END IF;

  DROP FUNCTION IF EXISTS public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer);
  DROP FUNCTION IF EXISTS public.rag_vector_sync_chunk_row(text, uuid, text);

  CREATE FUNCTION public.rag_vector_sync_document_rows(
    p_tenant_key text,
    p_document_id uuid,
    p_profile_id text,
    p_after uuid,
    p_limit integer
  )
  RETURNS TABLE (
    chunk_id uuid,
    document_id uuid,
    tenant_key text,
    vector real[],
    lexical_text text,
    lexical_version integer,
    content_hash text,
    doc_type text,
    doc_date date,
    language text,
    source text,
    chunking_profile_id text,
    parent_id uuid,
    access_groups text[]
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY INVOKER
  SET search_path = ''
  AS $fn$
  DECLARE
    v_storage text;
  BEGIN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
    IF p_document_id IS NULL THEN
      RAISE EXCEPTION 'vector_sync_refused: document_required' USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
      RAISE EXCEPTION 'vector_sync_refused: invalid_limit' USING ERRCODE = '22023';
    END IF;
    SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
    IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
      RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
    END IF;

    IF v_storage = 'legacy_column' THEN
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, c.embedding::real[], c.lexical_text, c.lexical_version, c.content_hash, c.doc_type,
             c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
       WHERE s.document_id = p_document_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key
         AND (p_after IS NULL OR c.id > p_after)
         AND c.embedding IS NOT NULL
       ORDER BY c.id
       LIMIT p_limit;
    ELSE
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, (e.embedding::public.vector)::real[], c.lexical_text, c.lexical_version, c.content_hash,
             c.doc_type, c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
        JOIN public.chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
       WHERE s.document_id = p_document_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key
         AND (p_after IS NULL OR c.id > p_after)
       ORDER BY c.id
       LIMIT p_limit;
    END IF;
  END
  $fn$;

  CREATE FUNCTION public.rag_vector_sync_chunk_row(p_tenant_key text, p_chunk_id uuid, p_profile_id text)
  RETURNS TABLE (
    chunk_id uuid,
    document_id uuid,
    tenant_key text,
    vector real[],
    lexical_text text,
    lexical_version integer,
    content_hash text,
    doc_type text,
    doc_date date,
    language text,
    source text,
    chunking_profile_id text,
    parent_id uuid,
    access_groups text[]
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY INVOKER
  SET search_path = ''
  AS $fn$
  DECLARE
    v_storage text;
  BEGIN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
    IF p_chunk_id IS NULL THEN
      RAISE EXCEPTION 'vector_sync_refused: chunk_required' USING ERRCODE = '22023';
    END IF;
    SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
    IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
      RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
    END IF;

    IF v_storage = 'legacy_column' THEN
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, c.embedding::real[], c.lexical_text, c.lexical_version, c.content_hash, c.doc_type,
             c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
       WHERE s.chunk_id = p_chunk_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key
         AND c.embedding IS NOT NULL;
    ELSE
      RETURN QUERY
      SELECT c.id, c.document_id, c.tenant_key, (e.embedding::public.vector)::real[], c.lexical_text, c.lexical_version, c.content_hash,
             c.doc_type, c.doc_date, c.language, c.source, c.chunking_profile_id, c.parent_id, c.access_groups
        FROM public.rag_servable_chunks s
        JOIN public.document_chunks c ON c.id = s.chunk_id
        JOIN public.chunk_embeddings e ON e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
       WHERE s.chunk_id = p_chunk_id
         AND s.tenant_key = p_tenant_key
         AND c.tenant_key = p_tenant_key;
    END IF;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.rag_vector_sync_chunk_row(text, uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.rag_vector_sync_document_rows(text, uuid, text, uuid, integer) TO service_role;
  GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunk_row(text, uuid, text) TO service_role;

  -- One-time re-sync of the points written before this file (D-01: nothing while no target is enabled).
  FOR v_target IN SELECT t.target FROM public.rag_vector_sync_targets t WHERE t.enabled ORDER BY t.target LOOP
    SELECT pg_catalog.array_agg(k.tenant_key ORDER BY k.tenant_key)
      INTO v_tenants
      FROM (SELECT DISTINCT s.tenant_key FROM public.rag_backend_index_state s WHERE s.target = v_target AND s.tenant_key IS NOT NULL) k;
    v_count := coalesce(pg_catalog.array_length(v_tenants, 1), 0);
    PERFORM public.rag_vector_sync_enqueue('tenant', v_tenants, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[v_count]), v_target);
  END LOOP;
END
$reads$;

-- Group changes (SEC-12, T-07-145). access_groups is now a D-03 filter field, so it joins the synced columns of the two 0702 UPDATE
-- trigger functions; their triggers, the early exit and every other compared column stay exactly as in 0702 (A-7: one statement trigger
-- per event). A relabel updates documents (rag_set_document_access_groups) and then every chunk (rag_access_groups_propagate), and both
-- statements enqueue the same document row, which the pending-row rule of rag_vector_sync_enqueue absorbs.

CREATE OR REPLACE FUNCTION public.rag_vector_sync_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_tenants text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  -- Synced columns: the D-03 payload and filter fields (access_groups since 0742) plus what decides servability (D-02).
  WITH changed AS (
    SELECT o.document_id AS old_doc, o.tenant_key AS old_tenant, n.document_id AS new_doc, n.tenant_key AS new_tenant
      FROM old_rows o
      FULL JOIN new_rows n ON n.id = o.id
     WHERE o.id IS NULL OR n.id IS NULL
        OR (o.document_id, o.tenant_key, o.organization_id, o.is_current, o.status, o.embedding::text, o.lexical_text, o.lexical_version,
            o.content_hash, o.doc_type, o.doc_date, o.language, o.source, o.chunking_profile_id, o.parent_id, o.access_groups)
           IS DISTINCT FROM
           (n.document_id, n.tenant_key, n.organization_id, n.is_current, n.status, n.embedding::text, n.lexical_text, n.lexical_version,
            n.content_hash, n.doc_type, n.doc_date, n.language, n.source, n.chunking_profile_id, n.parent_id, n.access_groups)
  ), keys AS (
    SELECT c.old_doc AS document_id, c.old_tenant AS tenant_key FROM changed c WHERE c.old_doc IS NOT NULL
    UNION
    SELECT c.new_doc, c.new_tenant FROM changed c WHERE c.new_doc IS NOT NULL
  )
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key)
    INTO v_docs, v_tenants
    FROM keys k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_docs, 1), 0)]));
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_vector_sync_documents_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_docs text[];
  v_tenants text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_vector_sync_targets t WHERE t.enabled) THEN
    RETURN NULL;
  END IF;
  -- Tenant columns, is_current and status: soft delete, quarantine, release, version publish and tenant moves; access_groups: relabels.
  WITH changed AS (
    SELECT o.id AS old_id, o.tenant_key AS old_tenant, n.id AS new_id, n.tenant_key AS new_tenant
      FROM old_rows o
      FULL JOIN new_rows n ON n.id = o.id
     WHERE o.id IS NULL OR n.id IS NULL
        OR (o.user_id, o.organization_id, o.tenant_key, o.is_current, o.status, o.access_groups)
           IS DISTINCT FROM (n.user_id, n.organization_id, n.tenant_key, n.is_current, n.status, n.access_groups)
  ), keys AS (
    SELECT c.old_id AS document_id, c.old_tenant AS tenant_key FROM changed c WHERE c.old_id IS NOT NULL
    UNION
    SELECT c.new_id, c.new_tenant FROM changed c WHERE c.new_id IS NOT NULL
  )
  SELECT pg_catalog.array_agg(k.document_id::text), pg_catalog.array_agg(k.tenant_key)
    INTO v_docs, v_tenants
    FROM keys k;
  PERFORM public.rag_vector_sync_enqueue('document', v_docs, v_tenants, pg_catalog.array_fill(NULL::text, ARRAY[coalesce(pg_catalog.array_length(v_docs, 1), 0)]));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_vector_sync_documents_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_documents_update() TO service_role;

-- Group-aware re-validation for the query side (plan 07-39, T-07-146).

CREATE OR REPLACE FUNCTION public.rag_validate_chunks_for_groups(p_tenant_key text, p_ids uuid[], p_profile_id text, p_access_groups text[])
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_access_groups IS NULL OR coalesce(pg_catalog.cardinality(p_access_groups), 0) = 0 THEN
    RAISE EXCEPTION 'rag_validate_chunks_for_groups: access groups required' USING ERRCODE = '22023';
  END IF;

  IF coalesce(pg_catalog.cardinality(p_ids), 0) > 500 THEN
    RAISE EXCEPTION 'rag_validate_chunks: too many ids' USING ERRCODE = '22023';
  END IF;

  SELECT e.storage INTO v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_storage IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;

  IF coalesce(pg_catalog.cardinality(p_ids), 0) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.document_id, c.content, c.metadata, c.chunk_index, c.doc_type, c.language, c.parent_id, c.section_path, c.chunk_kind,
         d.filename, d.created_at, d.metadata, pg_catalog.left(d.content, 200)
    FROM public.rag_servable_chunks s
    JOIN public.document_chunks c ON c.id = s.chunk_id
    JOIN public.documents d ON d.id = c.document_id
   WHERE s.chunk_id = ANY(p_ids)
     AND s.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key
     AND d.tenant_key = p_tenant_key
     AND c.access_groups && p_access_groups
     AND d.access_groups && p_access_groups
     AND CASE
           WHEN v_storage = 'legacy_column' THEN c.embedding IS NOT NULL
           ELSE EXISTS (
             SELECT 1 FROM public.chunk_embeddings e
              WHERE e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key
           )
         END
   ORDER BY c.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_validate_chunks_for_groups(text, uuid[], text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_validate_chunks_for_groups(text, uuid[], text, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0743_language_quality_cells.sql
-- 0743: rag_language_quality_cells (Phase 7 plan 07-46, LANG-10, OBS-03). Per (tenant_key, query language) counts of
-- public.rag_retrieval_log rows created in [p_since, p_until), read from the columns Phase 5.1.1 froze (D-29) only:
-- outcome, feedback_vote, feedback_kind, query_language, query_language_confidence, created_at (and the generated tenant_key).
-- retrievals: rows; refused: outcome refused_no_context; kb_unavailable: outcome kb_unavailable; votes_up / votes_down:
-- feedback_vote 1 / -1 with feedback_kind answer or embed; low_confidence: query_language_confidence below p_min_confidence
-- (0.75 when null, so the mapped 0.5 is low and 1 is not). A row without a language, or with a confidence that is null or below
-- p_min_confidence when p_min_confidence is given, counts under und. p_tenant_keys null reads every tenant; every key given is
-- checked with rag_assert_tenant_key (22023 on a malformed key or a key of the other deployment mode). The window must be
-- non-empty and at most 400 days (22023). Counts only, never text. SECURITY INVOKER with an empty search path, service_role only.
-- Idempotent, not folded.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_language_quality_cells(
  p_since timestamptz,
  p_until timestamptz,
  p_tenant_keys text[] DEFAULT NULL,
  p_min_confidence real DEFAULT NULL
)
RETURNS TABLE (
  tenant_key text,
  language text,
  retrievals bigint,
  refused bigint,
  kb_unavailable bigint,
  votes_up bigint,
  votes_down bigint,
  low_confidence bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
  v_low real := COALESCE(p_min_confidence, 0.75::real);
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR p_since >= p_until THEN
    RAISE EXCEPTION 'window must be a non-empty range' USING ERRCODE = '22023';
  END IF;
  IF p_until - p_since > interval '400 days' THEN
    RAISE EXCEPTION 'window must not exceed 400 days' USING ERRCODE = '22023';
  END IF;
  IF p_min_confidence IS NOT NULL AND (p_min_confidence < 0 OR p_min_confidence > 1) THEN
    RAISE EXCEPTION 'min confidence must be within 0 and 1' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_keys IS NOT NULL THEN
    FOREACH v_key IN ARRAY p_tenant_keys LOOP
      PERFORM public.rag_assert_tenant_key(v_key);
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT
    l.tenant_key,
    CASE
      WHEN l.query_language IS NULL THEN 'und'
      WHEN p_min_confidence IS NOT NULL
        AND (l.query_language_confidence IS NULL OR l.query_language_confidence < p_min_confidence) THEN 'und'
      ELSE l.query_language
    END AS language,
    count(*)::bigint AS retrievals,
    count(*) FILTER (WHERE l.outcome = 'refused_no_context')::bigint AS refused,
    count(*) FILTER (WHERE l.outcome = 'kb_unavailable')::bigint AS kb_unavailable,
    count(*) FILTER (WHERE l.feedback_vote = 1 AND l.feedback_kind IN ('answer', 'embed'))::bigint AS votes_up,
    count(*) FILTER (WHERE l.feedback_vote = -1 AND l.feedback_kind IN ('answer', 'embed'))::bigint AS votes_down,
    count(*) FILTER (WHERE l.query_language_confidence IS NOT NULL AND l.query_language_confidence < v_low)::bigint AS low_confidence
  FROM public.rag_retrieval_log l
  WHERE l.created_at >= p_since
    AND l.created_at < p_until
    AND (p_tenant_keys IS NULL OR l.tenant_key = ANY (p_tenant_keys))
  GROUP BY 1, 2
  ORDER BY 1, 2;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_language_quality_cells(timestamptz, timestamptz, text[], real) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_language_quality_cells(timestamptz, timestamptz, text[], real) TO service_role;

COMMENT ON FUNCTION public.rag_language_quality_cells(timestamptz, timestamptz, text[], real) IS
  'LANG-10: per (tenant, query language) counts of the frozen FBK-01 log columns over a window; counts only, service_role only.';

COMMIT;

-- ==== supabase/migrations/0744_rag_rollouts.sql
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

-- ==== supabase/migrations/0745_language_add_candidates.sql
-- Phase 7 plan 07-52 (LANG-11): the documents a language addition may reprocess.
-- rag_language_add_candidates lists current, ready documents with their stored fingerprint parts and two flags computed here:
-- has_und (the document's language list contains und) and scanned (doc type scanned_image, or a stored processing profile of
-- scanned_image). The app adds the third group, documents whose stored fingerprint differs under the proposed settings, with the
-- Phase 3.2 comparison, and never selects a document in none of the three groups.
-- Tenant rule of 0808 rag_fingerprint_groups: the tenant comes only from p_tenant_key, checked by rag_assert_tenant_key; NULL means
-- every tenant (deployment admin and CLI), and every row carries its own tenant key. Keyset pages by document id.
-- SECURITY INVOKER with an empty search_path and schema-qualified names; service_role only. No new store, so no purge hook.
-- Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_language_add_candidates(
  p_tenant_key text DEFAULT NULL,
  p_after uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  doc_type text,
  ingest_fingerprint text,
  parts jsonb,
  has_und boolean,
  scanned boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit: p_limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;

  RETURN QUERY
  SELECT d.id,
         d.tenant_key,
         d.doc_type,
         d.ingest_fingerprint,
         CASE WHEN d.ingest_fingerprint IS NULL THEN NULL ELSE d.metadata -> 'ingest_fingerprint_parts' END AS parts,
         ('und' = ANY (d.languages)) AS has_und,
         (d.doc_type = 'scanned_image'
           OR pg_catalog.split_part(COALESCE(d.metadata -> 'ingest_fingerprint_parts' ->> 'processing_profile_id', ''), '@', 1) = 'scanned_image') AS scanned
    FROM public.documents d
   WHERE d.is_current
     AND d.status = 'ready'
     AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
     AND (p_after IS NULL OR d.id > p_after)
   ORDER BY d.id
   LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_language_add_candidates(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_language_add_candidates(text, uuid, integer) TO service_role;

COMMIT;

-- ==== Verify (read-only; run after the apply)
-- 1. Migration objects exist (expect every value true).
SELECT to_regprocedure('public.rag_validate_chunks_for_groups(text, uuid[], text, text[])') IS NOT NULL AS t0742_validate_for_groups,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_vector_sync_document_rows'
                 AND pg_catalog.pg_get_function_result(p.oid) LIKE '%access_groups%') AS t0742_document_rows_groups,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_vector_sync_chunk_row'
                 AND pg_catalog.pg_get_function_result(p.oid) LIKE '%access_groups%') AS t0742_chunk_row_groups,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_vector_sync_documents_update'
                 AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%access_groups%') AS t0742_documents_trigger,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_vector_sync_chunks_update'
                 AND pg_catalog.pg_get_functiondef(p.oid) LIKE '%access_groups%') AS t0742_chunks_trigger,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_language_quality_cells') AS t0743_cells,
       to_regclass('public.rag_rollouts') IS NOT NULL AS t0744_rollouts,
       to_regclass('public.rag_rollout_tenants') IS NOT NULL AS t0744_rollout_tenants,
       EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = 'rag_language_add_candidates') AS t0745_candidates;

-- 2. New tables: RLS on, no policy, nothing granted to anon or authenticated.
SELECT c.relname, c.relrowsecurity,
       (SELECT count(*) FROM pg_catalog.pg_policy pol WHERE pol.polrelid = c.oid) AS policies,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('rag_rollouts', 'rag_rollout_tenants')
ORDER BY 1;
-- Expect two rows: relrowsecurity true, policies 0, anon_select false, authenticated_select false.

-- 3. Every train-43 function: empty search_path, service_role may execute, anon and authenticated may not.
SELECT p.proname, p.prosecdef AS security_definer,
       pg_catalog.array_to_string(p.proconfig, ',') AS config,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'rag\_rollout\_%' OR p.proname IN ('rag_validate_chunks_for_groups', 'rag_vector_sync_document_rows',
       'rag_vector_sync_chunk_row', 'rag_vector_sync_documents_update', 'rag_vector_sync_chunks_update',
       'rag_language_quality_cells', 'rag_language_add_candidates'))
ORDER BY 1;
-- Expect 18 rows; config 'search_path=""' on each; service_role_exec true, anon_exec false, authenticated_exec false;
-- security_definer true only for rag_vector_sync_documents_update and rag_vector_sync_chunks_update (as in 0702).

-- 4. No rollout started and nothing queued by the apply on a default install: expect rollouts 0; recent_tenant_resync 0 while
--    enabled_targets is 0 (with a target enabled, the first apply queues the one-time 0742 re-sync, one row per enabled target and tenant that has index state).
SELECT (SELECT count(*) FROM public.rag_rollouts) AS rollouts,
       (SELECT count(*) FROM public.vector_sync_outbox WHERE entity = 'tenant' AND enqueued_at > now() - interval '1 hour') AS recent_tenant_resync,
       (SELECT count(*) FROM public.rag_vector_sync_targets WHERE enabled) AS enabled_targets;

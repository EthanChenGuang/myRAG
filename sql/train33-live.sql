-- Train 33 live SQL (ci/merge-train-33). Apply after trains 30-32 are live. Multi-tenant production.
-- Order: 0706, 0900, 0901, 0902, 0904, 0945, 0976, then the 0410 r16 delta (grants only).

-- ==== supabase/migrations/0706_activation_gate_external.sql
-- 0706: Phase 7 activation gate for external backends (D-06, RET-05, RET-09).
-- rag_activate_embedding_profile keeps the 0425 body (every Phase 3 refusal, in the same order) and adds one condition after them:
-- for each enabled target in rag_vector_sync_targets (qdrant first, then weaviate), every tenant with current ready chunks must have a
-- rag_backend_index_state row in state ready for that target and the target profile, otherwise activation raises
-- `external_not_ready:<target>` (55000) and changes nothing. With no target enabled the gate is the 0425 gate.
-- rag_rollback_embedding_profile is not changed: rolling back is never gated on an external index.
-- Signature, SECURITY DEFINER, search_path, statement_timeout and grants are unchanged. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_activate_embedding_profile(p_target text, p_actor text)
 RETURNS TABLE(activated_profile text, previous_profile text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_target public.embedding_profiles%ROWTYPE;
  v_active text;
  v_missing bigint;
  v_bad bigint;
  v_evidence jsonb;
  v_recorded timestamptz;
  v_last timestamptz;
  v_slice_ok boolean;
  v_ext_target text;
  v_ext_missing bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'activation_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_target FROM public.embedding_profiles WHERE id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_target.status = 'active' THEN
    RAISE EXCEPTION 'activation_refused: already_active' USING ERRCODE = '55000';
  END IF;
  SELECT p.id INTO v_active FROM public.embedding_profiles p WHERE p.status = 'active';

  IF v_target.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p_target);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'activation_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, p_target
      USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    SELECT count(*) INTO v_bad FROM public.chunk_embeddings e
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
      SELECT 1 FROM public.embedding_backfill_runs r
      WHERE r.id::text = v_evidence->>'backfill_run_id' AND r.profile_id = p_target AND r.status = 'completed'
    ) THEN
      RAISE EXCEPTION 'activation_refused: eval_run_mismatch' USING ERRCODE = '55000';
    END IF;
    SELECT max(e.embedded_at) INTO v_last FROM public.chunk_embeddings e WHERE e.profile_id = p_target;
  ELSE
    SELECT max(c.created_at) INTO v_last FROM public.document_chunks c
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

  FOR v_ext_target IN
    SELECT t.target FROM public.rag_vector_sync_targets t
    WHERE t.enabled
    ORDER BY CASE t.target WHEN 'qdrant' THEN 0 WHEN 'weaviate' THEN 1 ELSE 2 END, t.target
  LOOP
    SELECT count(*) INTO v_ext_missing
    FROM (
      SELECT DISTINCT c.tenant_key FROM public.document_chunks c
      WHERE c.is_current AND c.status = 'ready' AND c.tenant_key IS NOT NULL
    ) k
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rag_backend_index_state s
      WHERE s.target = v_ext_target AND s.profile_id = p_target AND s.tenant_key = k.tenant_key AND s.state = 'ready'
    );
    IF v_ext_missing > 0 THEN
      RAISE EXCEPTION 'external_not_ready:% (% tenants with current documents have no ready % index for profile %)', v_ext_target, v_ext_missing, v_ext_target, p_target
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active';
  UPDATE public.embedding_profiles
  SET status = 'active', previous_active_id = v_active, activated_at = now(), activated_by = p_actor
  WHERE id = p_target;

  RETURN QUERY SELECT p_target, v_active;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_activate_embedding_profile(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_activate_embedding_profile(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0900_lexical_stats_schema.sql
-- 0900: Phase 4.4 per-tenant lexical corpus statistics store (LEX-02, LEX-06, D-10, D-31).
-- rag_lexical_stats_state: one row per tenant that keeps statistics (status building | ready); no row means the tenant keeps none.
-- rag_lexical_stats_pending: signed deltas staged by the document_chunks triggers of 0901 (+1 or -1 per member chunk, its distinct
-- lexemes and its length); compaction (0902) folds them into the counters, nothing on the write path touches a counter.
-- rag_lexical_df: document frequency per (tenant, corpus, lexeme, chunking profile, language).
-- rag_lexical_corpus: chunk count and total lexical length per (tenant, corpus, chunking profile, language).
-- corpus is 'chunks' in this phase; 'translations' is reserved (D-21). A null chunk language is stored as 'und'.
-- rag_lexical_dl(tsvector): a vector's length, the sum of its stored positions (term frequency of a lexeme = its positions).
-- RLS on with no policy, every client role revoked, service_role only. Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_stats_schema_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_tsvector(text)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'lexical_tsv' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0900: apply migrations 0401 and 0403 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_schema_precheck$;

CREATE TABLE IF NOT EXISTS public.rag_lexical_stats_state (
  tenant_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'building',
  enabled_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  rebuilt_at timestamptz,
  compacted_at timestamptz,
  CONSTRAINT rag_lexical_stats_state_status_check CHECK (status IN ('building', 'ready'))
);

CREATE TABLE IF NOT EXISTS public.rag_lexical_stats_pending (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_key text NOT NULL,
  corpus text NOT NULL DEFAULT 'chunks',
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  sign smallint NOT NULL,
  lexemes text[] NOT NULL,
  dl integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_lexical_stats_pending_corpus_check CHECK (corpus IN ('chunks', 'translations')),
  CONSTRAINT rag_lexical_stats_pending_sign_check CHECK (sign IN (-1, 1))
);

CREATE INDEX IF NOT EXISTS rag_lexical_stats_pending_tenant_id_idx ON public.rag_lexical_stats_pending (tenant_key, id);

CREATE TABLE IF NOT EXISTS public.rag_lexical_df (
  tenant_key text NOT NULL,
  corpus text NOT NULL DEFAULT 'chunks',
  lexeme text NOT NULL,
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  df bigint NOT NULL,
  CONSTRAINT rag_lexical_df_pkey PRIMARY KEY (tenant_key, corpus, lexeme, chunking_profile_id, language),
  CONSTRAINT rag_lexical_df_corpus_check CHECK (corpus IN ('chunks', 'translations'))
);

CREATE TABLE IF NOT EXISTS public.rag_lexical_corpus (
  tenant_key text NOT NULL,
  corpus text NOT NULL DEFAULT 'chunks',
  chunking_profile_id text NOT NULL,
  language text NOT NULL,
  chunk_count bigint NOT NULL,
  total_len bigint NOT NULL,
  CONSTRAINT rag_lexical_corpus_pkey PRIMARY KEY (tenant_key, corpus, chunking_profile_id, language),
  CONSTRAINT rag_lexical_corpus_corpus_check CHECK (corpus IN ('chunks', 'translations'))
);

ALTER TABLE public.rag_lexical_stats_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_stats_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_df ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_lexical_corpus ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_lexical_stats_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_stats_pending FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_df FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_lexical_corpus FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.rag_lexical_stats_pending_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.rag_lexical_stats_state TO service_role;
GRANT ALL ON TABLE public.rag_lexical_stats_pending TO service_role;
GRANT ALL ON TABLE public.rag_lexical_df TO service_role;
GRANT ALL ON TABLE public.rag_lexical_corpus TO service_role;
GRANT ALL ON SEQUENCE public.rag_lexical_stats_pending_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.rag_lexical_dl(p_tsv tsvector)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
  SELECT COALESCE(pg_catalog.sum(pg_catalog.cardinality(u.positions)), 0)::integer
  FROM pg_catalog.unnest(p_tsv) AS u(lexeme, positions, weights)
$fn$;

REVOKE ALL ON FUNCTION public.rag_lexical_dl(tsvector) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexical_dl(tsvector) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0901_lexical_stats_triggers.sql
-- 0901: Phase 4.4 change capture for the lexical statistics (LEX-03, D-11, D-15, D-16, D-32).
-- One AFTER ... FOR EACH STATEMENT trigger per event on document_chunks, each reading its transition table (the 0702 pattern), so a
-- cascade or a bulk write stages once per statement. Each function stages one signed row per changed member chunk into
-- rag_lexical_stats_pending (tenant key, chunking profile, language or 'und', +1 or -1, the distinct lexemes, the length) and writes
-- nothing else: no counter is touched on the write path. Compaction (0902) folds the rows.
-- Membership (D-11): is_current AND status IN ('ready', 'variant') AND lexical_tsv IS NOT NULL AND lexical_tsv <> ''.
-- Inert by default (D-16): every function returns before reading a transition table while rag_lexical_stats_state is empty, and stages
-- rows only for tenants that have a state row. An update stages -1 for the old row and +1 for the new one only when membership,
-- lexical_tsv, tenant_key, chunking_profile_id or language changed. The AFTER triggers see the lexical_tsv the 0401 BEFORE trigger set.
-- SECURITY DEFINER with an empty search_path because the writing role (an owner editing a chunk, an ingest RPC) has no grant on the
-- pending table; the functions take no caller input. EXECUTE is revoked from PUBLIC, anon and authenticated and granted to service_role,
-- and section 1 of 0410 carries a guarded entry for each, as for the 0702 trigger functions. Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_stats_triggers_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.document_chunks') AND a.attname = 'lexical_tsv' AND NOT a.attisdropped
     )
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_pending') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_dl(tsvector)') IS NULL THEN
    RAISE EXCEPTION '0901: apply migrations 0401, 0403 and 0900 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_triggers_precheck$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT n.tenant_key, n.chunking_profile_id, COALESCE(n.language, 'und'), 1::smallint,
         pg_catalog.tsvector_to_array(n.lexical_tsv), public.rag_lexical_dl(n.lexical_tsv)
    FROM new_rows n
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = n.tenant_key
   WHERE n.is_current AND n.status IN ('ready', 'variant')
     AND n.lexical_tsv IS NOT NULL AND n.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY n.id;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  WITH pairs AS (
    SELECT o.id,
           o.tenant_key AS o_tenant, o.chunking_profile_id AS o_profile, o.language AS o_language, o.lexical_tsv AS o_tsv,
           COALESCE(o.is_current AND o.status IN ('ready', 'variant') AND o.lexical_tsv IS NOT NULL
                    AND o.lexical_tsv <> ''::pg_catalog.tsvector, false) AS o_member,
           n.tenant_key AS n_tenant, n.chunking_profile_id AS n_profile, n.language AS n_language, n.lexical_tsv AS n_tsv,
           COALESCE(n.is_current AND n.status IN ('ready', 'variant') AND n.lexical_tsv IS NOT NULL
                    AND n.lexical_tsv <> ''::pg_catalog.tsvector, false) AS n_member
      FROM old_rows o
      JOIN new_rows n ON n.id = o.id
  ), changed AS (
    SELECT p.* FROM pairs p
     WHERE (p.o_member OR p.n_member)
       AND (p.o_member IS DISTINCT FROM p.n_member
            OR p.o_tsv IS DISTINCT FROM p.n_tsv
            OR p.o_tenant IS DISTINCT FROM p.n_tenant
            OR p.o_profile IS DISTINCT FROM p.n_profile
            OR p.o_language IS DISTINCT FROM p.n_language)
  ), deltas AS (
    SELECT c.id, c.o_tenant AS tenant_key, c.o_profile AS chunking_profile_id, c.o_language AS language, (-1)::smallint AS sign, c.o_tsv AS tsv
      FROM changed c WHERE c.o_member
    UNION ALL
    SELECT c.id, c.n_tenant, c.n_profile, c.n_language, 1::smallint, c.n_tsv
      FROM changed c WHERE c.n_member
  )
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT x.tenant_key, x.chunking_profile_id, COALESCE(x.language, 'und'), x.sign,
         pg_catalog.tsvector_to_array(x.tsv), public.rag_lexical_dl(x.tsv)
    FROM deltas x
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = x.tenant_key
   ORDER BY x.id, x.sign;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_chunks_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.rag_lexical_stats_pending (tenant_key, chunking_profile_id, language, sign, lexemes, dl)
  SELECT o.tenant_key, o.chunking_profile_id, COALESCE(o.language, 'und'), (-1)::smallint,
         pg_catalog.tsvector_to_array(o.lexical_tsv), public.rag_lexical_dl(o.lexical_tsv)
    FROM old_rows o
    JOIN public.rag_lexical_stats_state s ON s.tenant_key = o.tenant_key
   WHERE o.is_current AND o.status IN ('ready', 'variant')
     AND o.lexical_tsv IS NOT NULL AND o.lexical_tsv <> ''::pg_catalog.tsvector
   ORDER BY o.id;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_delete() TO service_role;

DROP TRIGGER IF EXISTS rag_lexstats_chunks_insert ON public.document_chunks;
CREATE TRIGGER rag_lexstats_chunks_insert
  AFTER INSERT ON public.document_chunks
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_lexstats_chunks_insert();

DROP TRIGGER IF EXISTS rag_lexstats_chunks_update ON public.document_chunks;
CREATE TRIGGER rag_lexstats_chunks_update
  AFTER UPDATE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_lexstats_chunks_update();

DROP TRIGGER IF EXISTS rag_lexstats_chunks_delete ON public.document_chunks;
CREATE TRIGGER rag_lexstats_chunks_delete
  AFTER DELETE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_lexstats_chunks_delete();

COMMIT;

-- ==== supabase/migrations/0902_lexical_stats_functions.sql
-- 0902: Phase 4.4 maintenance of the per-tenant lexical statistics (LEX-02, LEX-03, LEX-06, D-17, D-18, D-19, D-32, D-34).
-- rag_lexstats_enable(tenant): adds the state row (status building) so the 0901 triggers start staging; idempotent, a ready tenant stays ready.
-- rag_lexstats_compact(tenant, max_rows): folds up to max_rows (1..50000) staged deltas, in id order, into rag_lexical_df and
-- rag_lexical_corpus with one ordered INSERT ... ON CONFLICT DO UPDATE each, then deletes the touched counters that reached zero or below;
-- returns the number of pending rows folded (0, without taking the lock, for a tenant with no state row).
-- rag_lexstats_compact_all(max_rows): one such batch for every enabled tenant with pending rows; returns the sum.
-- rag_lexstats_rebuild(tenant): raises lexical_stats_not_enabled (55000) without a state row; in one statement (one snapshot) deletes the
-- tenant's pending rows and scans its member chunks (D-11) into a staging temp table, then replaces the tenant's counters and sets ready.
-- A change committed after that snapshot keeps its pending row and is folded by the next compaction, so it is counted exactly once.
-- rag_lexstats_status(tenant) and rag_lexstats_check(tenant) return counts, timestamps and the state only, never a lexeme.
-- rag_lexstats_disable(tenant): removes the tenant's state row, pending rows and counters; the triggers then stage nothing for it.
-- Compaction, rebuild and disable serialise per tenant on pg_advisory_xact_lock(hashtextextended('rag_lexstats:' || tenant_key, 0)).
-- Every function is SECURITY INVOKER with an empty search_path and service_role only; each one that takes a tenant key calls
-- rag_assert_tenant_key first, and every statement names the tenant. rag_lexstats_compact_tenant is the unguarded body shared by
-- compact and compact_all (whose keys come from the state table), service_role only. No dynamic SQL. Idempotent; not folded into setup files.

BEGIN;

DO $lexical_stats_functions_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_pending') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_dl(tsvector)') IS NULL THEN
    RAISE EXCEPTION '0902: apply migrations 0403, 0900 and 0901 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_functions_precheck$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_enable(p_tenant_key text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_status text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  INSERT INTO public.rag_lexical_stats_state (tenant_key, status)
  VALUES (p_tenant_key, 'building')
  ON CONFLICT (tenant_key) DO NOTHING;
  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  RETURN v_status;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_tenant(p_tenant_key text, p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_max integer := LEAST(GREATEST(COALESCE(p_max_rows, 5000), 1), 50000);
  v_folded bigint;
  v_df_corpus text[];
  v_df_lexeme text[];
  v_df_profile text[];
  v_df_language text[];
  v_c_corpus text[];
  v_c_profile text[];
  v_c_language text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));

  WITH taken AS (
    DELETE FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key
       AND p.id IN (
         SELECT q.id FROM public.rag_lexical_stats_pending q
          WHERE q.tenant_key = p_tenant_key
          ORDER BY q.id
          LIMIT v_max
       )
    RETURNING p.corpus, p.chunking_profile_id, p.language, p.sign, p.lexemes, p.dl
  ), df_delta AS (
    SELECT t.corpus, u.lexeme, t.chunking_profile_id, t.language, pg_catalog.sum(t.sign)::bigint AS d
      FROM taken t
     CROSS JOIN LATERAL pg_catalog.unnest(t.lexemes) AS u(lexeme)
     GROUP BY t.corpus, u.lexeme, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0
  ), df_up AS (
    INSERT INTO public.rag_lexical_df AS f (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
    SELECT p_tenant_key, x.corpus, x.lexeme, x.chunking_profile_id, x.language, x.d
      FROM df_delta x
     ORDER BY x.corpus, x.lexeme, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, lexeme, chunking_profile_id, language) DO UPDATE SET df = f.df + EXCLUDED.df
    RETURNING f.corpus, f.lexeme, f.chunking_profile_id, f.language, f.df
  ), corpus_delta AS (
    SELECT t.corpus, t.chunking_profile_id, t.language,
           pg_catalog.sum(t.sign)::bigint AS n, pg_catalog.sum(t.sign::bigint * t.dl)::bigint AS len
      FROM taken t
     GROUP BY t.corpus, t.chunking_profile_id, t.language
    HAVING pg_catalog.sum(t.sign) <> 0 OR pg_catalog.sum(t.sign::bigint * t.dl) <> 0
  ), corpus_up AS (
    INSERT INTO public.rag_lexical_corpus AS c (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
    SELECT p_tenant_key, x.corpus, x.chunking_profile_id, x.language, x.n, x.len
      FROM corpus_delta x
     ORDER BY x.corpus, x.chunking_profile_id, x.language
    ON CONFLICT (tenant_key, corpus, chunking_profile_id, language)
      DO UPDATE SET chunk_count = c.chunk_count + EXCLUDED.chunk_count, total_len = c.total_len + EXCLUDED.total_len
    RETURNING c.corpus, c.chunking_profile_id, c.language, c.chunk_count
  )
  SELECT (SELECT pg_catalog.count(*) FROM taken),
         z.dc, z.dl, z.dp, z.dg, y.cc, y.cp, y.cg
    INTO v_folded, v_df_corpus, v_df_lexeme, v_df_profile, v_df_language, v_c_corpus, v_c_profile, v_c_language
    FROM (SELECT pg_catalog.array_agg(d.corpus) AS dc, pg_catalog.array_agg(d.lexeme) AS dl,
                 pg_catalog.array_agg(d.chunking_profile_id) AS dp, pg_catalog.array_agg(d.language) AS dg
            FROM df_up d WHERE d.df <= 0) z,
         (SELECT pg_catalog.array_agg(k.corpus) AS cc, pg_catalog.array_agg(k.chunking_profile_id) AS cp,
                 pg_catalog.array_agg(k.language) AS cg
            FROM corpus_up k WHERE k.chunk_count <= 0) y;

  DELETE FROM public.rag_lexical_df f
   USING ROWS FROM (pg_catalog.unnest(v_df_corpus), pg_catalog.unnest(v_df_lexeme), pg_catalog.unnest(v_df_profile), pg_catalog.unnest(v_df_language)) AS k(corpus, lexeme, chunking_profile_id, language)
   WHERE f.tenant_key = p_tenant_key
     AND f.corpus = k.corpus AND f.lexeme = k.lexeme
     AND f.chunking_profile_id = k.chunking_profile_id AND f.language = k.language
     AND f.df <= 0;

  DELETE FROM public.rag_lexical_corpus c
   USING ROWS FROM (pg_catalog.unnest(v_c_corpus), pg_catalog.unnest(v_c_profile), pg_catalog.unnest(v_c_language)) AS k(corpus, chunking_profile_id, language)
   WHERE c.tenant_key = p_tenant_key
     AND c.corpus = k.corpus AND c.chunking_profile_id = k.chunking_profile_id AND c.language = k.language
     AND c.chunk_count <= 0;

  IF v_folded > 0 THEN
    UPDATE public.rag_lexical_stats_state s SET compacted_at = pg_catalog.now() WHERE s.tenant_key = p_tenant_key;
  END IF;
  RETURN v_folded;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact(p_tenant_key text, p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN public.rag_lexstats_compact_tenant(p_tenant_key, p_max_rows);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_compact_all(p_max_rows integer DEFAULT 5000)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
  v_total bigint := 0;
BEGIN
  FOR v_key IN
    SELECT s.tenant_key
      FROM public.rag_lexical_stats_state s
     WHERE EXISTS (SELECT 1 FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = s.tenant_key)
     ORDER BY s.tenant_key
  LOOP
    v_total := v_total + public.rag_lexstats_compact_tenant(v_key, p_max_rows);
  END LOOP;
  RETURN v_total;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_rebuild(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_chunks bigint;
  v_lexeme_rows bigint;
  v_corpus_rows bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'lexical_stats_not_enabled' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));

  CREATE TEMP TABLE IF NOT EXISTS _rag_lexstats_staging (
    kind smallint NOT NULL,
    lexeme text,
    chunking_profile_id text NOT NULL,
    language text NOT NULL,
    n bigint NOT NULL,
    len bigint
  ) ON COMMIT DROP;
  TRUNCATE pg_temp._rag_lexstats_staging;

  -- One statement, one snapshot: the pending rows it deletes are exactly those whose changes the scan sees.
  WITH gone AS (
    DELETE FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
    RETURNING p.id
  ), member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  )
  INSERT INTO pg_temp._rag_lexstats_staging (kind, lexeme, chunking_profile_id, language, n, len)
  SELECT 1::smallint, u.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*), NULL::bigint
    FROM member m
   CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(m.lexical_tsv)) AS u(lexeme)
   GROUP BY u.lexeme, m.chunking_profile_id, m.language
  UNION ALL
  SELECT 2::smallint, NULL::text, m.chunking_profile_id, m.language, pg_catalog.count(*),
         pg_catalog.sum(public.rag_lexical_dl(m.lexical_tsv))::bigint
    FROM member m
   GROUP BY m.chunking_profile_id, m.language;

  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks';
  INSERT INTO public.rag_lexical_df (tenant_key, corpus, lexeme, chunking_profile_id, language, df)
  SELECT p_tenant_key, 'chunks', g.lexeme, g.chunking_profile_id, g.language, g.n
    FROM pg_temp._rag_lexstats_staging g
   WHERE g.kind = 1
   ORDER BY g.lexeme, g.chunking_profile_id, g.language;
  GET DIAGNOSTICS v_lexeme_rows = ROW_COUNT;

  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks';
  INSERT INTO public.rag_lexical_corpus (tenant_key, corpus, chunking_profile_id, language, chunk_count, total_len)
  SELECT p_tenant_key, 'chunks', g.chunking_profile_id, g.language, g.n, g.len
    FROM pg_temp._rag_lexstats_staging g
   WHERE g.kind = 2
   ORDER BY g.chunking_profile_id, g.language;
  GET DIAGNOSTICS v_corpus_rows = ROW_COUNT;

  SELECT COALESCE(pg_catalog.sum(g.n), 0)::bigint INTO v_chunks FROM pg_temp._rag_lexstats_staging g WHERE g.kind = 2;
  TRUNCATE pg_temp._rag_lexstats_staging;

  UPDATE public.rag_lexical_stats_state s
     SET status = 'ready', rebuilt_at = pg_catalog.now()
   WHERE s.tenant_key = p_tenant_key;

  RETURN pg_catalog.jsonb_build_object('chunk_count', v_chunks, 'lexeme_rows', v_lexeme_rows, 'corpus_rows', v_corpus_rows);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_status(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_out jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT pg_catalog.jsonb_build_object(
           'state', s.status,
           'chunk_count', COALESCE((SELECT pg_catalog.sum(c.chunk_count) FROM public.rag_lexical_corpus c
                                     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks'), 0)::bigint,
           'lexeme_count', (SELECT pg_catalog.count(DISTINCT f.lexeme) FROM public.rag_lexical_df f
                             WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks'),
           'pending', (SELECT pg_catalog.count(*) FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key),
           'oldest_pending_age_s', (SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.now() - pg_catalog.min(p.created_at)))::bigint
                                      FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key),
           'enabled_at', s.enabled_at,
           'rebuilt_at', s.rebuilt_at,
           'compacted_at', s.compacted_at)
    INTO v_out
    FROM (SELECT 1) AS one
    LEFT JOIN public.rag_lexical_stats_state s ON s.tenant_key = p_tenant_key;
  RETURN v_out;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_check(p_tenant_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_state text;
  v_pending bigint;
  v_df_mismatch bigint;
  v_df_mismatch_p bigint;
  v_count_diff bigint;
  v_count_diff_p bigint;
  v_len_diff bigint;
  v_len_diff_p bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT s.status INTO v_state FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  SELECT pg_catalog.count(*) INTO v_pending FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key;
  IF v_state IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'state', NULL::text, 'pending', v_pending,
      'df_mismatch', NULL::bigint, 'df_mismatch_with_pending', NULL::bigint,
      'chunk_count_diff', NULL::bigint, 'chunk_count_diff_with_pending', NULL::bigint,
      'total_len_diff', NULL::bigint, 'total_len_diff_with_pending', NULL::bigint,
      'clean', NULL::boolean);
  END IF;

  WITH member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  ), pend AS MATERIALIZED (
    SELECT p.chunking_profile_id, p.language, p.sign, p.lexemes, p.dl
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
  ), re_df AS (
    SELECT u.lexeme, m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS v
      FROM member m CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.tsvector_to_array(m.lexical_tsv)) AS u(lexeme)
     GROUP BY u.lexeme, m.chunking_profile_id, m.language
  ), ct_df AS (
    SELECT f.lexeme, f.chunking_profile_id, f.language, f.df AS v
      FROM public.rag_lexical_df f
     WHERE f.tenant_key = p_tenant_key AND f.corpus = 'chunks'
  ), pd_df AS (
    SELECT u.lexeme, p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS v
      FROM pend p CROSS JOIN LATERAL pg_catalog.unnest(p.lexemes) AS u(lexeme)
     GROUP BY u.lexeme, p.chunking_profile_id, p.language
  ), df_cmp AS (
    SELECT COALESCE(r.v, 0) AS r, COALESCE(c.v, 0) AS c, COALESCE(d.v, 0) AS d
      FROM re_df r
      FULL JOIN ct_df c USING (lexeme, chunking_profile_id, language)
      FULL JOIN pd_df d USING (lexeme, chunking_profile_id, language)
  )
  SELECT pg_catalog.count(*) FILTER (WHERE x.r <> x.c), pg_catalog.count(*) FILTER (WHERE x.r <> x.c + x.d)
    INTO v_df_mismatch, v_df_mismatch_p
    FROM df_cmp x;

  WITH member AS MATERIALIZED (
    SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, public.rag_lexical_dl(c.lexical_tsv) AS dl
      FROM public.document_chunks c
     WHERE c.tenant_key = p_tenant_key
       AND c.is_current AND c.status IN ('ready', 'variant')
       AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::pg_catalog.tsvector
  ), re_c AS (
    SELECT m.chunking_profile_id, m.language, pg_catalog.count(*)::bigint AS n, pg_catalog.sum(m.dl)::bigint AS len
      FROM member m GROUP BY m.chunking_profile_id, m.language
  ), ct_c AS (
    SELECT c.chunking_profile_id, c.language, c.chunk_count AS n, c.total_len AS len
      FROM public.rag_lexical_corpus c
     WHERE c.tenant_key = p_tenant_key AND c.corpus = 'chunks'
  ), pd_c AS (
    SELECT p.chunking_profile_id, p.language, pg_catalog.sum(p.sign)::bigint AS n, pg_catalog.sum(p.sign::bigint * p.dl)::bigint AS len
      FROM public.rag_lexical_stats_pending p
     WHERE p.tenant_key = p_tenant_key AND p.corpus = 'chunks'
     GROUP BY p.chunking_profile_id, p.language
  ), c_cmp AS (
    SELECT COALESCE(r.n, 0) AS rn, COALESCE(c.n, 0) AS cn, COALESCE(d.n, 0) AS dn,
           COALESCE(r.len, 0) AS rl, COALESCE(c.len, 0) AS cl, COALESCE(d.len, 0) AS dl
      FROM re_c r
      FULL JOIN ct_c c USING (chunking_profile_id, language)
      FULL JOIN pd_c d USING (chunking_profile_id, language)
  )
  SELECT COALESCE(pg_catalog.sum(pg_catalog.abs(x.rn - x.cn)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rn - x.cn - x.dn)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rl - x.cl)), 0)::bigint,
         COALESCE(pg_catalog.sum(pg_catalog.abs(x.rl - x.cl - x.dl)), 0)::bigint
    INTO v_count_diff, v_count_diff_p, v_len_diff, v_len_diff_p
    FROM c_cmp x;

  RETURN pg_catalog.jsonb_build_object(
    'state', v_state,
    'pending', v_pending,
    'df_mismatch', v_df_mismatch,
    'df_mismatch_with_pending', v_df_mismatch_p,
    'chunk_count_diff', v_count_diff,
    'chunk_count_diff_with_pending', v_count_diff_p,
    'total_len_diff', v_len_diff,
    'total_len_diff_with_pending', v_len_diff_p,
    'clean', v_df_mismatch_p = 0 AND v_count_diff_p = 0 AND v_len_diff_p = 0);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexstats_disable(p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_existed boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_lexstats:' || p_tenant_key, 0));
  DELETE FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  v_existed := FOUND;
  DELETE FROM public.rag_lexical_stats_pending p WHERE p.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_df f WHERE f.tenant_key = p_tenant_key;
  DELETE FROM public.rag_lexical_corpus c WHERE c.tenant_key = p_tenant_key;
  RETURN v_existed;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_lexstats_enable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_disable(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_rebuild(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_compact_all(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_status(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexstats_check(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_lexstats_enable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_disable(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_rebuild(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_tenant(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_compact_all(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_status(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexstats_check(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0904_bm25_search_chunks.sql
-- 0904: rag_bm25_search_chunks, the BM25 lexical leg of Phase 4.4 (LEX-04, LEX-02, LEX-06; D-13, D-22 to D-25, D-30, D-32).
-- A sibling of hybrid_search_chunks, which this file neither creates, replaces nor drops (D-03). Base body: hybrid_search_chunks of 0856,
-- the newest definition on trunk. It takes every parameter of that function except p_dense_limit, p_iterative_scan and
-- p_exact_scan_cutoff, under the same names, types and defaults, plus p_k1 (default 1.2, 0.5 to 3), p_b (default 0.75, 0 to 1) and
-- p_candidate_limit (default 500, 0 to 2000, 0 = every match). It returns the column list of hybrid_search_chunks with leg 'lexical',
-- lexical_score the BM25 score (unbounded; nothing may threshold it), dense_mode 'n/a' and similarity computed as the 0856 lexical leg
-- computes it (cosine of the hit under a legacy_column profile, else null).
-- Rows: the lexical filter of 0856 with its version-scope widening and the lexical-language clause, built from constants with every value
-- bound; the effective-profile map is a bound jsonb object {doc_type: profile_id} (no temp table, so both functions can run in one
-- transaction). Tokens are cleaned as rag_lexical_tsquery cleans them (non-empty, at most 255 bytes, no quote, backslash or whitespace,
-- at most 64 distinct) and the match tsquery is built from that same list.
-- Request statistics (D-13), read only under p_tenant_key from rag_lexical_corpus and rag_lexical_df (corpus 'chunks'): summed over the
-- distinct effective chunking profiles of the requested doc types (all six when none is named) and, when p_lexical_languages is given,
-- over those languages plus 'und' (every 'und' row of those profiles). Rows that the filter admits through the legacy-fallback clauses
-- and superseded rows under version scope all or range are scored with these statistics but are not counted in them. A lexeme with no
-- counter row has df 1; df is clamped to [1, N]. IDF is Lucene's ln(1 + (N - df + 0.5) / (df + 0.5)), never negative.
-- Two passes (D-23): candidates are the GIN matches ranked by sum(idf * ts_rank(lexical_tsv, term, 0)) and limited to p_candidate_limit;
-- each candidate is then scored exactly, tf = positions of the lexeme, dl = sum over its lexemes, score = sum(idf * tf * (k1 + 1) /
-- (tf + k1 * (1 - b + b * dl / avgdl))), ordered by score descending, then chunk id, limited to p_lexical_limit.
-- Errors: 55000 lexical_stats_not_ready when the tenant's rag_lexical_stats_state row is missing or not ready, or the request statistics
-- hold no chunk; 22023 for k1, b or a limit out of range and for every invalid filter argument hybrid_search_chunks rejects, with the same
-- messages; a zero lexical limit, an empty token list or a filter that can match nothing returns no row and checks no statistics.
-- Rebase rule: a later phase that adds a filter parameter to hybrid_search_chunks adds it here with the same predicate;
-- tests/rag-db/bm25-filter-parity.test.mts fails until it does. SECURITY INVOKER, empty search_path, rag_assert_tenant_key first;
-- REVOKE from PUBLIC, anon, authenticated and GRANT to service_role on the full signature. Idempotent; not folded into the setup files.

BEGIN;

DO $bm25_search_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_tsquery(text[])') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'hybrid_search_chunks' AND 'p_identifiers_norm' = ANY (p.proargnames)
     )
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL THEN
    RAISE EXCEPTION '0904: apply migrations 0401, 0403, 0856 and 0900 first' USING ERRCODE = '55000';
  END IF;
END
$bm25_search_precheck$;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.rag_bm25_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding public.vector,
  p_lexical_tokens text[],
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL,
  p_include_undated boolean DEFAULT false,
  p_scopes text[] DEFAULT NULL,
  p_scopes_include_untagged boolean DEFAULT false,
  p_effective_on date DEFAULT NULL,
  p_version_scope jsonb DEFAULT NULL,
  p_identifiers_norm text[] DEFAULT NULL,
  p_k1 double precision DEFAULT 1.2,
  p_b double precision DEFAULT 0.75,
  p_candidate_limit integer DEFAULT 500
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text,
  dup_cluster_id uuid,
  is_current boolean,
  document_version integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_storage text;
  v_tsq pg_catalog.tsquery;
  v_tokens text[];
  v_idfs double precision[];
  v_filter text;
  v_date_filter text;
  v_sel text;
  v_key text;
  v_val text;
  v_tag text;
  v_dim text;
  v_scope_region text[];
  v_scope_legal_entity text[];
  v_scope_department text[];
  v_scope_mode text := 'current';
  v_range_from date;
  v_range_to date;
  v_part text;
  v_has_eff boolean;
  v_start_d text;
  v_start_s text;
  v_eff jsonb;
  v_profiles text[];
  v_status text;
  v_n double precision;
  v_avgdl double precision;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_lexical_limit IS NULL OR p_lexical_limit NOT BETWEEN 0 AND 200
     OR p_candidate_limit IS NULL OR p_candidate_limit NOT BETWEEN 0 AND 2000 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_k1 IS NULL OR p_k1 = 'NaN'::double precision OR p_k1 < 0.5 OR p_k1 > 3 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: k1 out of range' USING ERRCODE = '22023';
  END IF;
  IF p_b IS NULL OR p_b = 'NaN'::double precision OR p_b < 0 OR p_b > 1 THEN
    RAISE EXCEPTION 'rag_bm25_search_chunks: b out of range' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND pg_catalog.jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT j.key, j.value FROM pg_catalog.jsonb_each_text(p_chunking_override) AS j(key, value) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_tag IN ARRAY p_scopes LOOP
      v_dim := CASE WHEN v_tag IS NULL OR pg_catalog.strpos(v_tag, ':') = 0 THEN NULL ELSE pg_catalog.split_part(v_tag, ':', 1) END;
      IF v_dim IS NULL OR pg_catalog.length(v_tag) <= pg_catalog.length(v_dim) + 1 THEN
        RAISE EXCEPTION 'invalid_scope: a tag is dimension:value' USING ERRCODE = '22023';
      ELSIF v_dim = 'region' THEN
        v_scope_region := pg_catalog.array_append(v_scope_region, v_tag);
      ELSIF v_dim = 'legal_entity' THEN
        v_scope_legal_entity := pg_catalog.array_append(v_scope_legal_entity, v_tag);
      ELSIF v_dim = 'department' THEN
        v_scope_department := pg_catalog.array_append(v_scope_department, v_tag);
      ELSE
        RAISE EXCEPTION 'invalid_scope: unknown dimension' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_version_scope IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_version_scope) <> 'object'
       OR pg_catalog.jsonb_typeof(p_version_scope -> 'mode') IS DISTINCT FROM 'string'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_version_scope) AS k(name) WHERE k.name NOT IN ('mode', 'from', 'to')) THEN
      RAISE EXCEPTION 'invalid_version_scope: an object with mode current, all or range' USING ERRCODE = '22023';
    END IF;
    v_scope_mode := p_version_scope ->> 'mode';
    IF v_scope_mode NOT IN ('current', 'all', 'range') THEN
      RAISE EXCEPTION 'invalid_version_scope: unknown mode' USING ERRCODE = '22023';
    END IF;
    IF v_scope_mode <> 'range' AND (p_version_scope ? 'from' OR p_version_scope ? 'to') THEN
      RAISE EXCEPTION 'invalid_version_scope: from and to need mode range' USING ERRCODE = '22023';
    END IF;
    FOREACH v_part IN ARRAY ARRAY['from', 'to'] LOOP
      CONTINUE WHEN NOT p_version_scope ? v_part;
      IF pg_catalog.jsonb_typeof(p_version_scope -> v_part) <> 'string'
         OR (p_version_scope ->> v_part) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END IF;
      BEGIN
        IF v_part = 'from' THEN v_range_from := (p_version_scope ->> v_part)::date; ELSE v_range_to := (p_version_scope ->> v_part)::date; END IF;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'invalid_version_scope: dates are YYYY-MM-DD' USING ERRCODE = '22023';
      END;
    END LOOP;
    IF v_range_from IS NOT NULL AND v_range_to IS NOT NULL AND v_range_from > v_range_to THEN
      RAISE EXCEPTION 'invalid_version_scope: from is later than to' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_identifiers_norm IS NOT NULL AND pg_catalog.cardinality(p_identifiers_norm) > 100 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: at most 100 identifiers' USING ERRCODE = '22023';
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM public.embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL AND public.vector_dims(p_query_embedding) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  -- The effective chunking profile of each doc type, by the rule of hybrid_search_chunks: the override, else the active profile, else legacy.
  SELECT pg_catalog.jsonb_object_agg(dt.doc_type, COALESCE(
           NULLIF(pg_catalog.btrim(p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         ))
  INTO v_eff
  FROM pg_catalog.unnest(v_doc_types) AS dt(doc_type);

  SELECT pg_catalog.array_agg(t.tok) INTO v_tokens
  FROM (
    SELECT DISTINCT u.tok
    FROM pg_catalog.unnest(COALESCE(p_lexical_tokens, '{}'::text[])) AS u(tok)
    WHERE u.tok <> '' AND pg_catalog.octet_length(u.tok) <= 255 AND u.tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t;
  v_tsq := public.rag_lexical_tsquery(v_tokens);

  SELECT pg_catalog.array_agg(DISTINCT j.value) INTO v_profiles
  FROM pg_catalog.jsonb_each_text(v_eff) AS j(key, value)
  WHERE p_doc_types IS NULL OR j.key = ANY (p_doc_types);

  IF p_lexical_limit = 0 OR v_tsq IS NULL OR v_profiles IS NULL
     OR (p_lexical_languages IS NOT NULL AND pg_catalog.cardinality(p_lexical_languages) = 0) THEN
    RETURN;
  END IF;

  SELECT s.status INTO v_status FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the tenant has no ready lexical statistics' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(pg_catalog.sum(lc.chunk_count), 0)::double precision,
         pg_catalog.sum(lc.total_len)::double precision / NULLIF(pg_catalog.sum(lc.chunk_count), 0)::double precision
  INTO v_n, v_avgdl
  FROM public.rag_lexical_corpus lc
  WHERE lc.tenant_key = p_tenant_key AND lc.corpus = 'chunks' AND lc.chunking_profile_id = ANY (v_profiles)
    AND (p_lexical_languages IS NULL OR lc.language = ANY (p_lexical_languages) OR lc.language = 'und');
  IF v_n IS NULL OR v_n <= 0 OR v_avgdl IS NULL OR v_avgdl <= 0 THEN
    RAISE EXCEPTION 'lexical_stats_not_ready: the request statistics hold no chunk' USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.array_agg(t.tok ORDER BY t.tok),
         pg_catalog.array_agg(pg_catalog.ln(1 + (v_n - x.df + 0.5) / (x.df + 0.5)) ORDER BY t.tok)
  INTO v_tokens, v_idfs
  FROM pg_catalog.unnest(v_tokens) AS t(tok)
  CROSS JOIN LATERAL (
    SELECT LEAST(GREATEST(COALESCE(pg_catalog.sum(d.df), 0)::double precision, 1), v_n) AS df
    FROM public.rag_lexical_df d
    WHERE d.tenant_key = p_tenant_key AND d.corpus = 'chunks' AND d.lexeme = t.tok AND d.chunking_profile_id = ANY (v_profiles)
      AND (p_lexical_languages IS NULL OR d.language = ANY (p_lexical_languages) OR d.language = 'und')
  ) AS x;

  IF COALESCE(p_include_undated, false) THEN
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3 OR c.doc_date IS NULL)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4 OR c.doc_date IS NULL)';
  ELSE
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4)';
  END IF;

  -- The lexical filter of hybrid_search_chunks (0856) with the effective-profile map bound as $24.
  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text($24::jsonb) AS ep(doc_type, profile_id) WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM public.document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || v_date_filter
    || ' AND ($5::text[] IS NULL OR (pg_catalog.cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8) OR (c.language = ''und'' AND d.language = ANY($8)))'
    || ' AND ($9::text IS NULL OR pg_catalog.strpos(pg_catalog.lower(d.supplier_name), pg_catalog.lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  IF v_scope_region IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $16::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''region:'')))) ';
  END IF;
  IF v_scope_legal_entity IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $17::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''legal_entity:'')))) ';
  END IF;
  IF v_scope_department IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $18::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(c.scopes) AS s(tag) WHERE pg_catalog.starts_with(s.tag, ''department:'')))) ';
  END IF;
  IF p_effective_on IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.effective_from IS NULL OR c.effective_from <= $20::date)'
      || ' AND (c.effective_to IS NULL OR c.effective_to >= $20::date) ';
  END IF;

  IF p_identifiers_norm IS NOT NULL THEN
    v_filter := v_filter || ' AND c.identifiers_norm && $23::text[] ';
  END IF;

  IF v_scope_mode = 'range' THEN
    v_has_eff := (
      SELECT pg_catalog.count(*) = 2 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname IN ('effective_from', 'effective_to') AND NOT attisdropped
    );
    IF v_has_eff THEN
      v_start_d := 'COALESCE(d.effective_from, (d.created_at AT TIME ZONE ''UTC'')::date)';
      v_start_s := 'COALESCE(s.effective_from, (s.created_at AT TIME ZONE ''UTC'')::date)';
    ELSE
      v_start_d := '(d.created_at AT TIME ZONE ''UTC'')::date';
      v_start_s := '(s.created_at AT TIME ZONE ''UTC'')::date';
    END IF;
    v_filter := v_filter
      || ' AND ($22::date IS NULL OR ' || v_start_d || ' <= $22::date)'
      || ' AND ($21::date IS NULL OR '
      || CASE WHEN v_has_eff THEN '(d.effective_to IS NOT NULL AND d.effective_to >= $21::date) OR (d.effective_to IS NULL AND ' ELSE '(' END
      || 'NOT EXISTS (SELECT 1 FROM public.documents s WHERE s.id = d.superseded_by AND s.tenant_key = $2 AND '
      || v_start_s || ' <= $21::date))) ';
  END IF;

  -- The version-scope widening of the 0856 lexical leg.
  IF v_scope_mode IN ('all', 'range') THEN
    v_filter := pg_catalog.replace(
      pg_catalog.replace(v_filter, ' c.tenant_key = $2 AND c.is_current AND ',
        ' c.tenant_key = $2 AND (c.is_current OR (NOT c.is_current AND NOT c.provisional AND d.tenant_key = $2 AND NOT d.is_current'
        || ' AND d.status = ''ready'' AND NOT d.provisional AND d.superseded_by IS NOT NULL'
        || ' AND EXISTS (SELECT 1 FROM public.documents sd WHERE sd.id = d.superseded_by AND sd.tenant_key = $2'
        || ' AND sd.content_hash IS DISTINCT FROM d.content_hash))) AND '),
      'c2.is_current AND c2.chunking_profile_id', 'c2.is_current = c.is_current AND c2.chunking_profile_id'
    );
  END IF;

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, pg_catalog.left(d.content, 200), %L::text, c.dup_cluster_id, c.is_current, d.version ';

  RETURN QUERY EXECUTE
    'WITH q AS MATERIALIZED (SELECT u.tok, u.idf, pg_catalog.quote_literal(u.tok)::pg_catalog.tsquery AS tsq'
    || ' FROM ROWS FROM (pg_catalog.unnest($28::text[]), pg_catalog.unnest($29::double precision[])) AS u(tok, idf)), '
    || 'cand AS MATERIALIZED (SELECT c.id AS hid,'
    || ' (SELECT pg_catalog.sum(q.idf * pg_catalog.ts_rank(c.lexical_tsv, q.tsq, 0)) FROM q) AS s1'
    || ' FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id WHERE ' || v_filter
    || ' AND ($14::text[] IS NULL OR (pg_catalog.cardinality($14) > 0 AND (c.language = ANY($14) OR (c.language = ''und'' AND d.language = ANY($14)))))'
    || ' AND c.lexical_tsv @@ $1 ORDER BY s1 DESC, c.id LIMIT NULLIF($27, 0)), '
    || 'scored AS (SELECT cand.hid, (SELECT pg_catalog.sum(q.idf * u.tf * ($25 + 1) / (u.tf + $25 * (1 - $26 + $26 * u.dl / $30)))'
    || ' FROM (SELECT x.lexeme, pg_catalog.cardinality(x.positions)::double precision AS tf,'
    || ' (pg_catalog.sum(pg_catalog.cardinality(x.positions)) OVER ())::double precision AS dl'
    || ' FROM pg_catalog.unnest(c.lexical_tsv) AS x(lexeme, positions, weights)) u JOIN q ON q.tok = u.lexeme) AS score'
    || ' FROM cand JOIN public.document_chunks c ON c.id = cand.hid), '
    || 'top AS (SELECT s.hid, s.score, (pg_catalog.row_number() OVER (ORDER BY s.score DESC, s.hid))::integer AS rnk'
    || ' FROM scored s ORDER BY s.score DESC, s.hid LIMIT $13) '
    || 'SELECT ''lexical''::text, t.rnk, '
    || pg_catalog.format(
      v_sel,
      CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
        THEN pg_catalog.format('(1 - (c.embedding OPERATOR(public.<=>) $15::public.vector(%s)))::double precision', v_dims)
        ELSE 'NULL::double precision' END,
      't.score::real',
      'n/a'
    )
    || ' FROM top t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.rnk'
    USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
      p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding,
      v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
      v_range_from, v_range_to, p_identifiers_norm, v_eff, p_k1, p_b, p_candidate_limit, v_tokens, v_idfs, v_avgdl;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0945_rag_security_admin_keys.sql
-- 0945: tenant resolution for the security-events admin routes (Phase 5.2, plan 05.2-18, SEC-10, D-47).
-- rag_security_admin_keys(p_actor, p_deployment_admin) returns the tenant keys whose security events, alerts and holds the actor may read
-- and act on. A deployment admin (the route verified the admin session; admin_users is checked again here) gets s:default in a
-- single-tenant database and every tenant key that has an event, alert or hold in a multi-tenant one. Anyone else gets, in a multi-tenant
-- database, the organizations they are owner or admin of plus the tenants they were granted as domain expert (the Phase 5.1.1 D-16 rule),
-- and in a single-tenant database s:default only through an explicit expert grant. A personal workspace (u:) is never an organization
-- admin's. rag_security_uploader_in_tenant tells whether a user is an uploader of the tenant (an event, alert, hold or document there), so
-- a hold or release on a user unrelated to the tenant answers not found. Both are SECURITY INVOKER with an empty search_path and
-- service_role only (locked again in 0410); they return keys and a boolean, never text. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_security_admin_keys(p_actor uuid, p_deployment_admin boolean)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_multi_tenant boolean;
  v_keys text[] := '{}'::text[];
BEGIN
  IF p_actor IS NULL THEN
    RETURN v_keys;
  END IF;
  v_multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );

  IF COALESCE(p_deployment_admin, false) THEN
    IF NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
      RAISE EXCEPTION 'not_admin' USING ERRCODE = '42501';
    END IF;
    IF NOT v_multi_tenant THEN
      RETURN ARRAY['s:default'];
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(k.tenant_key ORDER BY k.tenant_key COLLATE "C"), '{}'::text[]) INTO v_keys
    FROM (
      SELECT e.tenant_key FROM public.rag_security_events e
      UNION
      SELECT a.tenant_key FROM public.rag_security_alerts a
      UNION
      SELECT h.tenant_key FROM public.rag_uploader_holds h
    ) k
    WHERE k.tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    RETURN v_keys;
  END IF;

  IF NOT v_multi_tenant THEN
    IF EXISTS (SELECT 1 FROM public.rag_domain_experts x WHERE x.tenant_key = 's:default' AND x.user_id = p_actor) THEN
      RETURN ARRAY['s:default'];
    END IF;
    RETURN v_keys;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(k.tenant_key ORDER BY k.tenant_key COLLATE "C"), '{}'::text[]) INTO v_keys
  FROM (
    SELECT 'o:' || m.organization_id::text AS tenant_key
    FROM public.organization_members m
    WHERE m.user_id = p_actor AND m.role IN ('owner', 'admin')
    UNION
    SELECT x.tenant_key FROM public.rag_domain_experts x WHERE x.user_id = p_actor
  ) k
  WHERE k.tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  RETURN v_keys;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_security_uploader_in_tenant(p_tenant_key text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.rag_security_events e WHERE e.tenant_key = p_tenant_key AND e.uploader_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.rag_security_alerts a WHERE a.tenant_key = p_tenant_key AND a.uploader_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.rag_uploader_holds h WHERE h.tenant_key = p_tenant_key AND h.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.documents d WHERE d.tenant_key = p_tenant_key AND d.user_id = p_user_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_security_admin_keys(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_security_admin_keys(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0976_rag_purge_hook_golden_items.sql
-- 0976: rag_purge_hook_golden_items, the Phase 6.3 DATA-24 purge hook for this phase's per-document stores (Phase 5.3 plan 52,
-- EVAL-29, EVAL-24; Phase 6.3 D-14, D-17; D-48, D-55, D-56).
-- Signature reserved by Phase 6.3 (06.3-19): rag_purge_foreign_stores calls it through to_regprocedure inside the purge and counts the
-- returned number under the store golden_items. The classification of every 0960 to 0975 table is in the "DATA-24 purge hooks" section
-- of 05.3-PLAN-INDEX.md; only rag_golden_evidence_index and rag_judge_labels hold per-document data.
-- The purged versions are p_document_ids plus every version of p_lineage_id the tenant still has. For the tenant only: evidence rows
-- on those versions are deleted; each affected item keeps one tombstone (nil document id, all-zero quote hash, needs_check) and its
-- remaining rows are flagged, so rag_golden_evidence_pending returns it until the stale scan clears it. Labels of review items with a
-- kept candidate (kept true or absent) naming a purged version are deleted; that step is skipped without the Phase 5.1.1 tables.
-- SECURITY INVOKER (inside the 6.3 purge it runs with that definer's rights); empty search_path; service_role only.
-- Additive and idempotent. Not folded into the setup files (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_golden_items(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_versions uuid[];
  v_evidence bigint := 0;
  v_labels bigint := 0;
  v_affected jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  SELECT coalesce(pg_catalog.array_agg(DISTINCT v.id), '{}'::uuid[]) INTO v_versions
  FROM (
    SELECT pg_catalog.unnest(coalesce(p_document_ids, '{}'::uuid[])) AS id
    UNION
    SELECT d.id
    FROM public.documents d
    WHERE p_lineage_id IS NOT NULL
      AND d.lineage_id = p_lineage_id
      AND d.tenant_key = p_tenant_key
  ) v
  WHERE v.id IS NOT NULL;

  IF coalesce(pg_catalog.array_length(v_versions, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH removed AS (
    DELETE FROM public.rag_golden_evidence_index i
    WHERE i.tenant_key = p_tenant_key
      AND i.document_id = ANY (v_versions)
    RETURNING i.set_id, i.item_id
  )
  SELECT pg_catalog.count(*), coalesce(pg_catalog.jsonb_agg(DISTINCT pg_catalog.jsonb_build_array(r.set_id, r.item_id)), '[]'::jsonb)
  INTO v_evidence, v_affected
  FROM removed r;

  IF v_evidence > 0 THEN
    INSERT INTO public.rag_golden_evidence_index (tenant_key, set_id, item_id, document_id, quote_sha256, needs_check)
    SELECT p_tenant_key, a ->> 0, a ->> 1, '00000000-0000-0000-0000-000000000000'::uuid, pg_catalog.repeat('0', 64), true
    FROM pg_catalog.jsonb_array_elements(v_affected) AS a
    ON CONFLICT (tenant_key, set_id, item_id, document_id, quote_sha256) DO NOTHING;

    UPDATE public.rag_golden_evidence_index i
    SET needs_check = true
    WHERE i.tenant_key = p_tenant_key
      AND NOT i.needs_check
      AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_affected) AS a WHERE a ->> 0 = i.set_id AND a ->> 1 = i.item_id
      );
  END IF;

  IF pg_catalog.to_regclass('public.rag_judge_labels') IS NOT NULL
     AND pg_catalog.to_regclass('public.rag_review_items') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM public.rag_judge_labels l
      USING public.rag_review_items r
      WHERE l.tenant_key = $1
        AND r.tenant_key = $1
        AND r.id = l.review_item_id
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(r.candidates) AS c
          WHERE pg_catalog.jsonb_typeof(c) = 'object'
            AND (c ->> 'document_id') = ANY ($2)
            AND (NOT (c ? 'kept') OR c -> 'kept' = 'true'::jsonb)
        )
    $sql$ USING p_tenant_key, (SELECT pg_catalog.array_agg(x::text) FROM pg_catalog.unnest(v_versions) AS x);
    GET DIAGNOSTICS v_labels = ROW_COUNT;
  END IF;

  RETURN v_evidence + v_labels;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_golden_items(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_golden_items(text, uuid, uuid[]) TO service_role;

-- Phase 6.3 store inventory. Guarded: this file creates no Phase 6.3 object. Phase 6.3's rag_purge_store_inventory() (0728) was not
-- on trunk when this plan ran, so the block only reports; plan 06.3-19 lists rag_golden_evidence_index and rag_judge_labels (store
-- golden_items, handling purge_step) from the "DATA-24 purge hooks" section of 05.3-PLAN-INDEX.md.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_purge_store_inventory()') IS NULL THEN
    RAISE NOTICE '[0976] rag_purge_store_inventory() is missing; registration left to Phase 6.3';
    RETURN;
  END IF;
  RAISE NOTICE '[0976] rag_purge_store_inventory() exists; it lists the golden_items stores itself';
END
$do$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r16 delta (the lines train 33 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r16$
BEGIN
  IF to_regprocedure('public.rag_lexstats_chunks_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_lexstats_chunks_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_lexstats_chunks_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_lexstats_chunks_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_lexstats_chunks_update() TO service_role;
  END IF;
  -- Phase 5.2, migration 0945: security-events admin tenant resolution (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_security_admin_keys(uuid, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_security_admin_keys(uuid, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_security_admin_keys(uuid, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_security_uploader_in_tenant(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_security_uploader_in_tenant(text, uuid) TO service_role;
  END IF;
END
$r16$;

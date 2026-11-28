-- 0473: Phase 4.1.1 terminology mining: the miss log, the candidate table, corpus document frequency and candidate decisions
-- (D-01, D-07, D-25, D-26, PO-3, PO-4).
-- rag_term_misses holds masked missed queries per tenant (source miss_log; feedback and langfuse are reserved for Phase 5.1.1).
-- rag_term_candidates holds mined terms per tenant, language and term; a dismissed or accepted candidate keeps its status when mined again.
-- Retention is 30 days without any schedule (PO-4): rag_term_record_miss deletes the tenant's older rows before it inserts,
-- rag_term_read_misses never returns older rows, rag_term_upsert_candidates clears the examples of the tenant's candidates not seen for
-- 30 days, and rag_term_purge_misses lets the miner purge every tenant.
-- rag_term_corpus_df counts, per token, the tenant's distinct documents with a current, ready chunk whose lexical_tsv matches, with the
-- current-and-ready filter of the newest hybrid_search_chunks (0802: tenant_key, is_current, status ready or variant) and the same
-- rag_lexical_tsquery builder (D-26, D-38).
-- Candidate decisions check the actor like 0472: admin_users membership, then the candidate's tenant key in rag_admin_tenant_keys(p_actor);
-- a candidate or entry of another tenant answers not_found. Each decision writes one candidate_accept or candidate_dismiss row to
-- rag_term_audit with the layer's current version (a decision does not change the dictionary, so no version is bumped).
-- Errors are P0001 with the code as the whole message: invalid_miss, invalid_window, invalid_candidate, invalid_action, not_admin,
-- not_admin_of_layer, not_found, not_pending. A malformed or wrong-mode tenant key raises 22023 from rag_assert_tenant_key.
-- Server role only: RLS on without policies, nothing granted to PUBLIC, anon or authenticated, service_role may SELECT; every function is
-- SECURITY DEFINER with an empty search_path and executable by service_role only.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_term_misses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL
    CONSTRAINT rag_term_misses_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  source text NOT NULL DEFAULT 'miss_log'
    CONSTRAINT rag_term_misses_source_check CHECK (source IN ('miss_log', 'feedback', 'langfuse')),
  query_masked text NOT NULL CONSTRAINT rag_term_misses_query_check CHECK (char_length(query_masked) BETWEEN 1 AND 500),
  language text CONSTRAINT rag_term_misses_language_check CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  status text NOT NULL CONSTRAINT rag_term_misses_status_check CHECK (status IN ('ok', 'empty', 'degraded', 'error')),
  reason text CONSTRAINT rag_term_misses_reason_check CHECK (reason IS NULL OR char_length(reason) <= 120),
  top_score real,
  dictionary_version text
    CONSTRAINT rag_term_misses_dictionary_version_check CHECK (dictionary_version IS NULL OR dictionary_version ~ '^s[0-9]+(\.w[0-9]+)?$'),
  retrieval_config_hash text NOT NULL
    CONSTRAINT rag_term_misses_config_hash_check CHECK (char_length(retrieval_config_hash) BETWEEN 1 AND 128),
  profile text NOT NULL CONSTRAINT rag_term_misses_profile_check CHECK (profile IN ('chat', 'embed', 'voice')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_term_misses_tenant_time_idx ON public.rag_term_misses (tenant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_term_misses_time_idx ON public.rag_term_misses (created_at);

CREATE TABLE IF NOT EXISTS public.rag_term_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL
    CONSTRAINT rag_term_candidates_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  term text NOT NULL CONSTRAINT rag_term_candidates_term_check CHECK (char_length(term) BETWEEN 1 AND 64),
  language text NOT NULL
    CONSTRAINT rag_term_candidates_language_check CHECK (language = 'any' OR language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  support integer NOT NULL DEFAULT 0 CONSTRAINT rag_term_candidates_support_check CHECK (support >= 0),
  examples text[] NOT NULL DEFAULT '{}'::text[]
    CONSTRAINT rag_term_candidates_examples_check CHECK (
      cardinality(examples) <= 3
      AND array_position(examples, NULL) IS NULL
      AND NOT ('' = ANY (examples))
      AND char_length(array_to_string(examples, '')) <= 1500
    ),
  corpus_df integer NOT NULL DEFAULT 0 CONSTRAINT rag_term_candidates_corpus_df_check CHECK (corpus_df >= 0),
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT rag_term_candidates_status_check CHECK (status IN ('pending', 'accepted', 'dismissed')),
  source text NOT NULL DEFAULT 'miss_log'
    CONSTRAINT rag_term_candidates_source_check CHECK (source IN ('miss_log', 'feedback', 'langfuse')),
  entry_id uuid,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  CONSTRAINT rag_term_candidates_accepted_check CHECK (status <> 'accepted' OR entry_id IS NOT NULL),
  CONSTRAINT rag_term_candidates_key UNIQUE (tenant_key, language, term)
);

CREATE INDEX IF NOT EXISTS rag_term_candidates_tenant_status_idx ON public.rag_term_candidates (tenant_key, status, last_seen DESC);

ALTER TABLE public.rag_term_misses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_term_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rag_term_misses FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.rag_term_candidates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.rag_term_misses TO service_role;
GRANT SELECT ON public.rag_term_candidates TO service_role;

-- Inserts one miss for the tenant after deleting that tenant's rows older than 30 days. Returns the new id.
CREATE OR REPLACE FUNCTION public.rag_term_record_miss(p_tenant_key text, p_row jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_id uuid;
  v_query text;
  v_profile text;
  v_source text;
  v_status text;
  k text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_row IS NULL OR pg_catalog.jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'invalid_miss' USING ERRCODE = 'P0001';
  END IF;
  FOREACH k IN ARRAY ARRAY['query_masked', 'status', 'retrieval_config_hash', 'profile'] LOOP
    IF pg_catalog.jsonb_typeof(p_row -> k) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_miss' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['source', 'language', 'reason', 'dictionary_version'] LOOP
    IF p_row ? k AND pg_catalog.jsonb_typeof(p_row -> k) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_miss' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF p_row ? 'top_score' AND pg_catalog.jsonb_typeof(p_row -> 'top_score') NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'invalid_miss' USING ERRCODE = 'P0001';
  END IF;

  v_query := p_row ->> 'query_masked';
  v_profile := p_row ->> 'profile';
  v_status := p_row ->> 'status';
  v_source := COALESCE(p_row ->> 'source', 'miss_log');
  IF pg_catalog.char_length(v_query) NOT BETWEEN 1 AND 500
     OR v_profile NOT IN ('chat', 'embed', 'voice')
     OR v_source NOT IN ('miss_log', 'feedback', 'langfuse')
     OR v_status NOT IN ('ok', 'empty', 'degraded', 'error') THEN
    RAISE EXCEPTION 'invalid_miss' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.rag_term_misses m
   WHERE m.tenant_key = p_tenant_key AND m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => 30);

  BEGIN
    INSERT INTO public.rag_term_misses (
      tenant_key, source, query_masked, language, status, reason, top_score, dictionary_version, retrieval_config_hash, profile
    ) VALUES (
      p_tenant_key,
      v_source,
      v_query,
      p_row ->> 'language',
      v_status,
      p_row ->> 'reason',
      (p_row ->> 'top_score')::real,
      p_row ->> 'dictionary_version',
      p_row ->> 'retrieval_config_hash',
      v_profile
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid_miss' USING ERRCODE = 'P0001';
  END;
  RETURN v_id;
END
$fn$;

-- Deletes every tenant's misses older than p_older_than_days (at least 1) and returns the count.
CREATE OR REPLACE FUNCTION public.rag_term_purge_misses(p_older_than_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_older_than_days IS NULL OR p_older_than_days < 1 THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.rag_term_misses m WHERE m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_older_than_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

-- The tenant's misses of the last p_window_days (1 to 30; larger windows read 30 days), newest first.
CREATE OR REPLACE FUNCTION public.rag_term_read_misses(p_tenant_key text, p_window_days integer DEFAULT 14)
RETURNS TABLE (
  id uuid,
  source text,
  query_masked text,
  language text,
  status text,
  reason text,
  top_score real,
  dictionary_version text,
  retrieval_config_hash text,
  profile text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_days integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_window_days IS NULL OR p_window_days < 1 THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = 'P0001';
  END IF;
  v_days := LEAST(p_window_days, 30);
  RETURN QUERY
  SELECT m.id, m.source, m.query_masked, m.language, m.status, m.reason, m.top_score, m.dictionary_version, m.retrieval_config_hash,
         m.profile, m.created_at
    FROM public.rag_term_misses m
   WHERE m.tenant_key = p_tenant_key
     AND m.created_at >= pg_catalog.now() - pg_catalog.make_interval(days => v_days)
   ORDER BY m.created_at DESC, m.id;
END
$fn$;

-- Per distinct token (at most 200), the number of the tenant's documents with a current, ready chunk whose lexical_tsv matches it.
CREATE OR REPLACE FUNCTION public.rag_term_corpus_df(p_tenant_key text, p_tokens text[])
RETURNS TABLE (token text, df bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  WITH toks AS (
    SELECT DISTINCT u.tok
      FROM pg_catalog.unnest(COALESCE(p_tokens, '{}'::text[])) AS u(tok)
     WHERE u.tok IS NOT NULL AND u.tok <> ''
     LIMIT 200
  )
  SELECT t.tok,
         COALESCE((
           SELECT pg_catalog.count(DISTINCT c.document_id)
             FROM public.document_chunks c
            WHERE c.tenant_key = p_tenant_key
              AND c.is_current
              AND c.status IN ('ready', 'variant')
              AND c.lexical_tsv OPERATOR(pg_catalog.@@) public.rag_lexical_tsquery(ARRAY[t.tok])
         ), 0::bigint)
    FROM toks t
   ORDER BY t.tok;
END
$fn$;

-- Upserts mined candidates (at most 1,000 rows) keyed by (tenant, language, term). A new row is pending; an existing row keeps its status
-- and takes the new support, examples, corpus_df and last_seen. Clears the examples of the tenant's candidates not seen for 30 days.
CREATE OR REPLACE FUNCTION public.rag_term_upsert_candidates(p_tenant_key text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_row jsonb;
  v_count integer := 0;
  v_examples text[];
  v_source text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'invalid_candidate' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.rag_term_candidates c
     SET examples = '{}'::text[]
   WHERE c.tenant_key = p_tenant_key
     AND c.last_seen < pg_catalog.now() - pg_catalog.make_interval(days => 30)
     AND pg_catalog.cardinality(c.examples) > 0;

  FOR v_row IN SELECT x FROM pg_catalog.jsonb_array_elements(p_rows) AS x LOOP
    IF pg_catalog.jsonb_typeof(v_row) <> 'object'
       OR pg_catalog.jsonb_typeof(v_row -> 'term') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_row -> 'language') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_row -> 'support') IS DISTINCT FROM 'number'
       OR (v_row ? 'corpus_df' AND pg_catalog.jsonb_typeof(v_row -> 'corpus_df') NOT IN ('number', 'null'))
       OR (v_row ? 'source' AND pg_catalog.jsonb_typeof(v_row -> 'source') NOT IN ('string', 'null'))
       OR (v_row ? 'status')
       OR (v_row ? 'entry_id')
       OR pg_catalog.jsonb_typeof(COALESCE(v_row -> 'examples', '[]'::jsonb)) <> 'array'
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(COALESCE(v_row -> 'examples', '[]'::jsonb)) e
          WHERE pg_catalog.jsonb_typeof(e) <> 'string' OR pg_catalog.char_length(e #>> '{}') NOT BETWEEN 1 AND 500
       ) THEN
      RAISE EXCEPTION 'invalid_candidate' USING ERRCODE = 'P0001';
    END IF;
    v_examples := ARRAY(
      SELECT t.v FROM pg_catalog.jsonb_array_elements_text(COALESCE(v_row -> 'examples', '[]'::jsonb)) WITH ORDINALITY AS t(v, n) ORDER BY t.n
    );
    v_source := COALESCE(v_row ->> 'source', 'miss_log');
    BEGIN
      INSERT INTO public.rag_term_candidates AS c (tenant_key, term, language, support, examples, corpus_df, source)
      VALUES (
        p_tenant_key,
        v_row ->> 'term',
        v_row ->> 'language',
        (v_row ->> 'support')::integer,
        v_examples,
        COALESCE((v_row ->> 'corpus_df')::integer, 0),
        v_source
      )
      ON CONFLICT ON CONSTRAINT rag_term_candidates_key DO UPDATE
        SET support = EXCLUDED.support,
            examples = EXCLUDED.examples,
            corpus_df = EXCLUDED.corpus_df,
            last_seen = pg_catalog.now();
    EXCEPTION WHEN check_violation OR not_null_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'invalid_candidate' USING ERRCODE = 'P0001';
    END;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$fn$;

-- One page of a tenant's candidates for an admin of that tenant: pending first, then by support and recency, with total_count.
CREATE OR REPLACE FUNCTION public.rag_term_list_candidates(
  p_actor uuid,
  p_layer_key text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  term text,
  language text,
  support integer,
  examples text[],
  corpus_df integer,
  status text,
  source text,
  entry_id uuid,
  first_seen timestamptz,
  last_seen timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_page integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_skip integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;
  IF p_layer_key IS NULL OR NOT (p_layer_key = ANY (public.rag_admin_tenant_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin_of_layer' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT c.id, c.tenant_key, c.term, c.language, c.support,
         CASE WHEN c.last_seen < pg_catalog.now() - pg_catalog.make_interval(days => 30) THEN '{}'::text[] ELSE c.examples END,
         c.corpus_df, c.status, c.source, c.entry_id, c.first_seen, c.last_seen, c.decided_by, c.decided_at,
         pg_catalog.count(*) OVER ()
    FROM public.rag_term_candidates c
   WHERE c.tenant_key = p_layer_key
   ORDER BY (c.status = 'pending') DESC, c.support DESC, c.last_seen DESC, c.id
   LIMIT v_page OFFSET v_skip;
END
$fn$;

-- Dismisses a pending candidate, or accepts it with an entry of the candidate's tenant layer or of the shared layer; writes one audit row.
CREATE OR REPLACE FUNCTION public.rag_term_decide_candidate(
  p_actor uuid,
  p_candidate_id uuid,
  p_action text,
  p_entry_id uuid DEFAULT NULL
)
RETURNS TABLE (candidate_id uuid, status text, entry_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_keys text[];
  v_cand public.rag_term_candidates;
  v_after public.rag_term_candidates;
  v_version bigint;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('dismiss', 'accept') THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = 'P0001';
  END IF;
  v_keys := public.rag_admin_tenant_keys(p_actor);

  SELECT c.* INTO v_cand FROM public.rag_term_candidates c WHERE c.id = p_candidate_id FOR UPDATE;
  IF v_cand.id IS NULL OR NOT (v_cand.tenant_key = ANY (v_keys)) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_cand.status <> 'pending' THEN
    RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'accept' THEN
    IF p_entry_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.rag_term_entries e
       WHERE e.id = p_entry_id AND e.suppresses_entry_id IS NULL AND (e.layer_key = v_cand.tenant_key OR e.layer_key = 'shared')
    ) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.rag_term_candidates c
       SET status = 'accepted', entry_id = p_entry_id, decided_by = p_actor, decided_at = pg_catalog.now()
     WHERE c.id = v_cand.id
     RETURNING c.* INTO v_after;
  ELSE
    UPDATE public.rag_term_candidates c
       SET status = 'dismissed', decided_by = p_actor, decided_at = pg_catalog.now()
     WHERE c.id = v_cand.id
     RETURNING c.* INTO v_after;
  END IF;

  SELECT l.version INTO v_version FROM public.rag_term_layers l WHERE l.layer_key = v_cand.tenant_key;
  INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
  VALUES (
    v_cand.tenant_key,
    v_after.entry_id,
    CASE WHEN p_action = 'accept' THEN 'candidate_accept' ELSE 'candidate_dismiss' END,
    p_actor,
    pg_catalog.jsonb_build_object('candidate_id', v_cand.id, 'term', v_cand.term, 'language', v_cand.language, 'status', v_cand.status),
    pg_catalog.jsonb_build_object(
      'candidate_id', v_after.id, 'term', v_after.term, 'language', v_after.language, 'status', v_after.status, 'entry_id', v_after.entry_id
    ),
    COALESCE(v_version, 0::bigint)
  );

  RETURN QUERY SELECT v_after.id, v_after.status, v_after.entry_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_term_record_miss(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_purge_misses(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_read_misses(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_corpus_df(text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_upsert_candidates(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_list_candidates(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_decide_candidate(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_term_record_miss(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_purge_misses(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_read_misses(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_corpus_df(text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_upsert_candidates(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_list_candidates(uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_decide_candidate(uuid, uuid, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

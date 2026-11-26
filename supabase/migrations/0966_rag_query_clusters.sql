-- 0966: per-tenant query clusters for the weekly sampler and the drift report (Phase 5.3, D-40, D-55, EVAL-27, EVAL-28).
-- A cluster set is fitted on one tenant's masked queries with one embedder; it records the embedder id and the dimension so a
-- later run refits instead of assigning across models. Centroids are real[] with no pgvector column or index, so no pgvector
-- dimension limit applies. Assignments name a retrieval log row and are deleted with it.
-- No query text and no label: a cluster is named only by its opaque id (c-NN); `novel` is the reserved bucket for assignments.
-- Clusters and assignments carry the set's tenant_key through a composite foreign key, so no row can span tenants.
-- The writers are SECURITY INVOKER with an empty search_path and check the tenant key first (O-3). Service role only. Idempotent.

BEGIN;

DO $guard$
BEGIN
  IF pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RAISE EXCEPTION '[0966] public.rag_retrieval_log is missing; apply migrations 0531 to 0533 first' USING ERRCODE = '55000';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.rag_query_cluster_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  status text NOT NULL DEFAULT 'current',
  embedder text NOT NULL,
  dimension integer NOT NULL,
  k integer NOT NULL,
  fitted_at timestamptz NOT NULL DEFAULT now(),
  query_count integer NOT NULL,
  distance_threshold real NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_query_cluster_sets_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_query_cluster_sets_status_check CHECK (status IN ('current', 'superseded')),
  CONSTRAINT rag_query_cluster_sets_embedder_check CHECK (embedder ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
  CONSTRAINT rag_query_cluster_sets_dimension_check CHECK (dimension BETWEEN 1 AND 16000),
  CONSTRAINT rag_query_cluster_sets_k_check CHECK (k BETWEEN 1 AND 100),
  CONSTRAINT rag_query_cluster_sets_query_count_check CHECK (query_count >= 0),
  CONSTRAINT rag_query_cluster_sets_distance_threshold_check CHECK (distance_threshold >= 0 AND distance_threshold <= 2),
  CONSTRAINT rag_query_cluster_sets_id_tenant_key_key UNIQUE (id, tenant_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_query_cluster_sets_one_current_idx
  ON public.rag_query_cluster_sets (tenant_key) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS rag_query_cluster_sets_tenant_fitted_idx
  ON public.rag_query_cluster_sets (tenant_key, fitted_at DESC);

CREATE TABLE IF NOT EXISTS public.rag_query_clusters (
  set_id uuid NOT NULL,
  tenant_key text NOT NULL,
  cluster_id text NOT NULL,
  centroid real[] NOT NULL,
  member_count integer NOT NULL,
  PRIMARY KEY (set_id, cluster_id),
  CONSTRAINT rag_query_clusters_set_fkey FOREIGN KEY (set_id, tenant_key)
    REFERENCES public.rag_query_cluster_sets (id, tenant_key) ON DELETE CASCADE,
  CONSTRAINT rag_query_clusters_cluster_id_check CHECK (cluster_id ~ '^c-[0-9]{2,3}$'),
  CONSTRAINT rag_query_clusters_centroid_check CHECK (
    array_ndims(centroid) = 1 AND cardinality(centroid) BETWEEN 1 AND 16000 AND array_position(centroid, NULL) IS NULL
  ),
  CONSTRAINT rag_query_clusters_member_count_check CHECK (member_count >= 0)
);

CREATE TABLE IF NOT EXISTS public.rag_query_cluster_assignments (
  log_id uuid PRIMARY KEY REFERENCES public.rag_retrieval_log (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  set_id uuid NOT NULL,
  cluster_id text NOT NULL,
  distance real,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_query_cluster_assignments_set_fkey FOREIGN KEY (set_id, tenant_key)
    REFERENCES public.rag_query_cluster_sets (id, tenant_key) ON DELETE CASCADE,
  CONSTRAINT rag_query_cluster_assignments_cluster_id_check CHECK (cluster_id ~ '^c-[0-9]{2,3}$' OR cluster_id = 'novel'),
  CONSTRAINT rag_query_cluster_assignments_distance_check CHECK (distance IS NULL OR (distance >= 0 AND distance <= 2))
);

CREATE INDEX IF NOT EXISTS rag_query_cluster_assignments_set_cluster_idx
  ON public.rag_query_cluster_assignments (set_id, cluster_id);
CREATE INDEX IF NOT EXISTS rag_query_cluster_assignments_tenant_idx
  ON public.rag_query_cluster_assignments (tenant_key, set_id);

ALTER TABLE public.rag_query_cluster_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_query_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_query_cluster_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_query_cluster_sets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_query_clusters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_query_cluster_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_query_cluster_sets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_query_clusters TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_query_cluster_assignments TO service_role;

-- Writes a new current set with its clusters and marks the tenant's previous current set superseded.
-- p_set: { embedder, dimension, k, query_count, distance_threshold, fitted_at? }.
-- p_clusters: [{ cluster_id, centroid: number[dimension], member_count }]. Invalid input raises 22023 and writes nothing.
CREATE OR REPLACE FUNCTION public.rag_query_clusters_write(p_tenant_key text, p_set jsonb, p_clusters jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dimension integer;
  v_k integer;
  v_query_count integer;
  v_threshold double precision;
  v_fitted_at timestamptz := pg_catalog.now();
  v_cluster jsonb;
  v_seen text[] := ARRAY[]::text[];
  v_set_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_set IS NULL OR pg_catalog.jsonb_typeof(p_set) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'rag_query_clusters_write: p_set must be an object' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(p_set -> 'embedder') IS DISTINCT FROM 'string'
     OR NOT ((p_set ->> 'embedder') ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$') THEN
    RAISE EXCEPTION 'rag_query_clusters_write: embedder must be a model or profile id' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(p_set -> 'dimension') IS DISTINCT FROM 'number' OR NOT ((p_set ->> 'dimension') ~ '^[0-9]{1,5}$')
     OR pg_catalog.jsonb_typeof(p_set -> 'k') IS DISTINCT FROM 'number' OR NOT ((p_set ->> 'k') ~ '^[0-9]{1,3}$')
     OR pg_catalog.jsonb_typeof(p_set -> 'query_count') IS DISTINCT FROM 'number' OR NOT ((p_set ->> 'query_count') ~ '^[0-9]{1,9}$')
     OR pg_catalog.jsonb_typeof(p_set -> 'distance_threshold') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'rag_query_clusters_write: dimension, k, query_count and distance_threshold must be numbers' USING ERRCODE = '22023';
  END IF;

  v_dimension := (p_set ->> 'dimension')::integer;
  v_k := (p_set ->> 'k')::integer;
  v_query_count := (p_set ->> 'query_count')::integer;
  v_threshold := (p_set ->> 'distance_threshold')::double precision;
  IF v_dimension < 1 OR v_dimension > 16000 OR v_k < 1 OR v_k > 100 OR v_threshold < 0 OR v_threshold > 2 THEN
    RAISE EXCEPTION 'rag_query_clusters_write: dimension, k or distance_threshold out of range' USING ERRCODE = '22023';
  END IF;

  IF p_set ? 'fitted_at' AND pg_catalog.jsonb_typeof(p_set -> 'fitted_at') IS DISTINCT FROM 'null' THEN
    IF pg_catalog.jsonb_typeof(p_set -> 'fitted_at') IS DISTINCT FROM 'string'
       OR NOT ((p_set ->> 'fitted_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)?)?$') THEN
      RAISE EXCEPTION 'rag_query_clusters_write: fitted_at must be an ISO timestamp' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_fitted_at := (p_set ->> 'fitted_at')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'rag_query_clusters_write: fitted_at must be an ISO timestamp' USING ERRCODE = '22023';
    END;
  END IF;

  IF p_clusters IS NULL OR pg_catalog.jsonb_typeof(p_clusters) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_clusters) < 1 OR pg_catalog.jsonb_array_length(p_clusters) > 1000 THEN
    RAISE EXCEPTION 'rag_query_clusters_write: p_clusters must be a non-empty array' USING ERRCODE = '22023';
  END IF;

  FOR v_cluster IN SELECT e FROM pg_catalog.jsonb_array_elements(p_clusters) AS e LOOP
    IF pg_catalog.jsonb_typeof(v_cluster) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_cluster -> 'cluster_id') IS DISTINCT FROM 'string'
       OR NOT ((v_cluster ->> 'cluster_id') ~ '^c-[0-9]{2,3}$') THEN
      RAISE EXCEPTION 'rag_query_clusters_write: cluster_id must be an opaque id c-NN' USING ERRCODE = '22023';
    END IF;
    IF (v_cluster ->> 'cluster_id') = ANY (v_seen) THEN
      RAISE EXCEPTION 'rag_query_clusters_write: duplicate cluster_id' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || (v_cluster ->> 'cluster_id');
    IF pg_catalog.jsonb_typeof(v_cluster -> 'member_count') IS DISTINCT FROM 'number'
       OR NOT ((v_cluster ->> 'member_count') ~ '^[0-9]{1,9}$') THEN
      RAISE EXCEPTION 'rag_query_clusters_write: member_count must be a non-negative integer' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.jsonb_typeof(v_cluster -> 'centroid') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(v_cluster -> 'centroid') <> v_dimension
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_cluster -> 'centroid') AS c(value)
         WHERE pg_catalog.jsonb_typeof(c.value) IS DISTINCT FROM 'number'
       ) THEN
      RAISE EXCEPTION 'rag_query_clusters_write: centroid must hold exactly dimension numbers' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('rag_query_clusters_write:' || p_tenant_key));

  UPDATE public.rag_query_cluster_sets s
  SET status = 'superseded'
  WHERE s.tenant_key = p_tenant_key AND s.status = 'current';

  INSERT INTO public.rag_query_cluster_sets (tenant_key, status, embedder, dimension, k, fitted_at, query_count, distance_threshold)
  VALUES (p_tenant_key, 'current', p_set ->> 'embedder', v_dimension, v_k, v_fitted_at, v_query_count, v_threshold::real)
  RETURNING id INTO v_set_id;

  INSERT INTO public.rag_query_clusters (set_id, tenant_key, cluster_id, centroid, member_count)
  SELECT v_set_id,
         p_tenant_key,
         e.value ->> 'cluster_id',
         ARRAY(
           SELECT (c.value #>> '{}')::real
           FROM pg_catalog.jsonb_array_elements(e.value -> 'centroid') WITH ORDINALITY AS c(value, ord)
           ORDER BY c.ord
         ),
         (e.value ->> 'member_count')::integer
  FROM pg_catalog.jsonb_array_elements(p_clusters) AS e(value);

  RETURN v_set_id;
END
$fn$;

-- Assigns retrieval log rows to clusters of one of the tenant's sets. p_rows: [{ log_id, cluster_id (c-NN of the set or
-- novel), distance? }]. Rows whose log row is missing or belongs to another tenant are dropped and counted, never stored.
-- A set of another tenant, an unknown cluster id or a malformed row raises 22023. A log row assigned again is moved.
CREATE OR REPLACE FUNCTION public.rag_query_cluster_assign(p_tenant_key text, p_set_id uuid, p_rows jsonb)
RETURNS TABLE (stored integer, dropped integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_total integer;
  v_stored integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_set_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.rag_query_cluster_sets s WHERE s.id = p_set_id AND s.tenant_key = p_tenant_key
  ) THEN
    RAISE EXCEPTION 'rag_query_cluster_assign: unknown cluster set' USING ERRCODE = '22023';
  END IF;

  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rows) > 20000 THEN
    RAISE EXCEPTION 'rag_query_cluster_assign: p_rows must be an array of at most 20000 rows' USING ERRCODE = '22023';
  END IF;
  v_total := pg_catalog.jsonb_array_length(p_rows);

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS r(value)
    WHERE CASE
      WHEN pg_catalog.jsonb_typeof(r.value) IS DISTINCT FROM 'object' THEN true
      WHEN pg_catalog.jsonb_typeof(r.value -> 'log_id') IS DISTINCT FROM 'string' THEN true
      WHEN NOT ((r.value ->> 'log_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN true
      WHEN pg_catalog.jsonb_typeof(r.value -> 'cluster_id') IS DISTINCT FROM 'string' THEN true
      WHEN (r.value ->> 'cluster_id') <> 'novel' AND NOT EXISTS (
        SELECT 1 FROM public.rag_query_clusters c WHERE c.set_id = p_set_id AND c.cluster_id = (r.value ->> 'cluster_id')
      ) THEN true
      WHEN r.value -> 'distance' IS NULL OR pg_catalog.jsonb_typeof(r.value -> 'distance') = 'null' THEN false
      WHEN pg_catalog.jsonb_typeof(r.value -> 'distance') IS DISTINCT FROM 'number' THEN true
      ELSE NOT ((r.value ->> 'distance')::double precision BETWEEN 0 AND 2)
    END
  ) THEN
    RAISE EXCEPTION 'rag_query_cluster_assign: each row needs a uuid log_id, a cluster id of the set or novel, and a distance from 0 to 2'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT pg_catalog.lower(r.value ->> 'log_id'))
    FROM pg_catalog.jsonb_array_elements(p_rows) AS r(value)
  ) THEN
    RAISE EXCEPTION 'rag_query_cluster_assign: duplicate log_id' USING ERRCODE = '22023';
  END IF;

  WITH input AS (
    SELECT (r.value ->> 'log_id')::uuid AS log_id,
           r.value ->> 'cluster_id' AS cluster_id,
           CASE WHEN pg_catalog.jsonb_typeof(r.value -> 'distance') = 'number' THEN (r.value ->> 'distance')::real END AS distance
    FROM pg_catalog.jsonb_array_elements(p_rows) AS r(value)
  ),
  written AS (
    INSERT INTO public.rag_query_cluster_assignments AS a (log_id, tenant_key, set_id, cluster_id, distance, assigned_at)
    SELECT i.log_id, p_tenant_key, p_set_id, i.cluster_id, i.distance, pg_catalog.now()
    FROM input i
    JOIN public.rag_retrieval_log l ON l.id = i.log_id AND l.tenant_key = p_tenant_key
    ON CONFLICT (log_id) DO UPDATE
      SET set_id = EXCLUDED.set_id,
          cluster_id = EXCLUDED.cluster_id,
          distance = EXCLUDED.distance,
          assigned_at = EXCLUDED.assigned_at
      WHERE a.tenant_key = EXCLUDED.tenant_key
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO v_stored FROM written;

  RETURN QUERY SELECT v_stored, v_total - v_stored;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_query_clusters_write(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_query_cluster_assign(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_query_clusters_write(text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_query_cluster_assign(text, uuid, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

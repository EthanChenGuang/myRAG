-- 0857: Phase 4.2 duplicate cluster functions (DATA-21, D-18, D-19, D-20, D-49, D-56). Builds on 0853.
-- rag_dup_chunk_bands holds the 8 LSH bands (8 bits each) of a chunk's 64-bit SimHash for the embedding profile that was active when the
-- chunk was hashed, with the chunk's tenant and chunking profile, so candidate lookups stay inside one tenant and one pair of profiles.
-- The application computes the SimHash (src/lib/rag/dedupe/simhash.ts) and sends it as decimal text; the bands are split here.
-- Functions (service_role only, SECURITY INVOKER, empty search_path, tenant asserted first and named in every predicate):
--   rag_dup_write_hashes        store simhash and bands for a batch of chunks
--   rag_dup_candidates          candidates for a set of chunks: equal content_hash (exact) or a shared band within the Hamming cap whose
--                               stored-vector cosine is at or above the threshold; other documents, current and ready rows only
--   rag_dup_assign              put a set of chunks into one cluster (an existing one, or a new one); other clusters among them merge in
--   rag_dup_clusters_recompute  refresh member_count, source_document_ids and representative from current, ready members; a cluster left
--                               with fewer than two members dissolves; clears the dirty flag set by the 0853 triggers
--   rag_dup_backfill_candidates keyset listing of chunks to hash (chunks without bands for the active profile, or a document's chunks)
--   rag_purge_hook_dup_chunk_bands  purge hook (phase rule: every new 4.2 store): removes the band rows of the purged documents' chunks
-- Only the active embedding profile is compared; its vectors are document_chunks.embedding (legacy_column) or chunk_embeddings (halfvec).
-- Chunks of one document never share a cluster. Idempotent; not folded into the setup files.

BEGIN;

DO $dup_cluster_functions_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_dup_clusters') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_row_tenant_key_guard()') IS NULL THEN
    RAISE EXCEPTION '0857: apply migration 0853 first' USING ERRCODE = '55000';
  END IF;
END
$dup_cluster_functions_precheck$;

CREATE TABLE IF NOT EXISTS public.rag_dup_chunk_bands (
  chunk_id uuid NOT NULL REFERENCES public.document_chunks (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  embedding_profile_id text NOT NULL,
  chunking_profile_id text NOT NULL,
  band smallint NOT NULL,
  value smallint NOT NULL,
  CONSTRAINT rag_dup_chunk_bands_pkey PRIMARY KEY (chunk_id, embedding_profile_id, band),
  CONSTRAINT rag_dup_chunk_bands_band_check CHECK (band BETWEEN 0 AND 7),
  CONSTRAINT rag_dup_chunk_bands_value_check CHECK (value BETWEEN 0 AND 255),
  CONSTRAINT rag_dup_chunk_bands_profile_check CHECK (pg_catalog.length(embedding_profile_id) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS rag_dup_chunk_bands_lookup_idx
  ON public.rag_dup_chunk_bands (tenant_key, embedding_profile_id, chunking_profile_id, band, value);

CREATE INDEX IF NOT EXISTS idx_document_chunks_tenant_content_hash
  ON public.document_chunks (tenant_key, content_hash) WHERE content_hash IS NOT NULL;

ALTER TABLE public.rag_dup_chunk_bands ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_dup_chunk_bands FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_dup_chunk_bands TO service_role;

DROP TRIGGER IF EXISTS rag_dup_chunk_bands_tenant_key_guard ON public.rag_dup_chunk_bands;
CREATE TRIGGER rag_dup_chunk_bands_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_dup_chunk_bands
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

-- Hashes arrive as signed 64-bit decimal text: a JSON number above 2^53 would lose bits.
CREATE OR REPLACE FUNCTION public.rag_dup_write_hashes(p_tenant_key text, p_rows jsonb)
RETURNS TABLE (written integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_profile text;
  v_written integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 rows per call' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) r
    WHERE pg_catalog.jsonb_typeof(r) <> 'object'
       OR COALESCE(r ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR COALESCE(r ->> 'simhash', '') !~ '^-?[0-9]{1,19}$'
       OR (r ->> 'simhash')::numeric NOT BETWEEN -9223372036854775808 AND 9223372036854775807
  ) THEN
    RAISE EXCEPTION 'each row needs a chunk id and a signed 64-bit simhash as text' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  SELECT e.id INTO v_profile FROM public.embedding_profiles e WHERE e.status = 'active';
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'no active embedding profile' USING ERRCODE = '55000';
  END IF;

  UPDATE public.document_chunks c
     SET simhash = i.h
    FROM (
      SELECT DISTINCT ON ((r ->> 'id')::uuid) (r ->> 'id')::uuid AS id, (r ->> 'simhash')::bigint AS h
      FROM pg_catalog.jsonb_array_elements(p_rows) r
      ORDER BY (r ->> 'id')::uuid
    ) i
   WHERE c.id = i.id
     AND c.tenant_key = p_tenant_key
     AND c.is_current
     AND c.status IN ('ready', 'variant')
     AND c.simhash IS DISTINCT FROM i.h;

  DELETE FROM public.rag_dup_chunk_bands b
   WHERE b.tenant_key = p_tenant_key
     AND b.embedding_profile_id = v_profile
     AND b.chunk_id IN (SELECT (r ->> 'id')::uuid FROM pg_catalog.jsonb_array_elements(p_rows) r);

  INSERT INTO public.rag_dup_chunk_bands (chunk_id, tenant_key, embedding_profile_id, chunking_profile_id, band, value)
  SELECT c.id, c.tenant_key, v_profile, c.chunking_profile_id, g.band::smallint, ((c.simhash >> (8 * g.band)) & 255)::smallint
  FROM public.document_chunks c
  CROSS JOIN pg_catalog.generate_series(0, 7) AS g(band)
  WHERE c.id IN (SELECT (r ->> 'id')::uuid FROM pg_catalog.jsonb_array_elements(p_rows) r)
    AND c.tenant_key = p_tenant_key
    AND c.is_current
    AND c.status IN ('ready', 'variant')
    AND c.simhash IS NOT NULL;
  GET DIAGNOSTICS v_written = ROW_COUNT;

  RETURN QUERY SELECT (v_written / 8)::integer;
END
$fn$;

-- similarity is null for an exact pair without both vectors; an exact pair (equal content_hash) is accepted whatever its cosine.
CREATE OR REPLACE FUNCTION public.rag_dup_candidates(
  p_tenant_key text,
  p_chunk_ids uuid[],
  p_max_hamming integer,
  p_threshold double precision,
  p_limit integer
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  candidate_id uuid,
  candidate_document_id uuid,
  candidate_cluster_id uuid,
  similarity double precision,
  exact boolean,
  hamming integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_profile text;
  v_storage text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_chunk_ids IS NULL OR pg_catalog.cardinality(p_chunk_ids) > 1000 THEN
    RAISE EXCEPTION 'chunk ids: 0 to 1000 required' USING ERRCODE = '22023';
  END IF;
  IF p_max_hamming IS NULL OR p_max_hamming < 0 OR p_max_hamming > 64 THEN
    RAISE EXCEPTION 'max hamming must be within 0..64' USING ERRCODE = '22023';
  END IF;
  IF p_threshold IS NULL OR p_threshold <> p_threshold OR p_threshold < -1 OR p_threshold > 1 THEN
    RAISE EXCEPTION 'threshold must be within -1..1' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'limit must be within 1..200' USING ERRCODE = '22023';
  END IF;

  SELECT e.id, e.storage INTO v_profile, v_storage FROM public.embedding_profiles e WHERE e.status = 'active';
  IF v_profile IS NULL OR pg_catalog.cardinality(p_chunk_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH src AS MATERIALIZED (
    SELECT c.id, c.document_id, c.content_hash, c.simhash, c.chunking_profile_id
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
    WHERE c.id = ANY (p_chunk_ids)
      AND c.tenant_key = p_tenant_key
      AND c.is_current
      AND c.status IN ('ready', 'variant')
      AND d.is_current
      AND d.status = 'ready'
  ),
  pairs AS (
    SELECT s.id AS sid, o.id AS oid, true AS is_exact
    FROM src s
    JOIN public.document_chunks o
      ON o.tenant_key = p_tenant_key
     AND s.content_hash IS NOT NULL
     AND o.content_hash = s.content_hash
     AND o.chunking_profile_id = s.chunking_profile_id
     AND o.document_id <> s.document_id
    UNION ALL
    SELECT DISTINCT s.id, b2.chunk_id, false
    FROM src s
    JOIN public.rag_dup_chunk_bands b1
      ON b1.chunk_id = s.id
     AND b1.tenant_key = p_tenant_key
     AND b1.embedding_profile_id = v_profile
    JOIN public.rag_dup_chunk_bands b2
      ON b2.tenant_key = p_tenant_key
     AND b2.embedding_profile_id = v_profile
     AND b2.chunking_profile_id = s.chunking_profile_id
     AND b2.band = b1.band
     AND b2.value = b1.value
     AND b2.chunk_id <> s.id
  ),
  agg AS (
    SELECT p.sid, p.oid, pg_catalog.bool_or(p.is_exact) AS is_exact FROM pairs p GROUP BY p.sid, p.oid
  ),
  cand AS (
    SELECT a.sid, s.document_id AS sdoc, o.id AS oid, o.document_id AS odoc, o.dup_cluster_id AS ocluster, a.is_exact,
           CASE WHEN s.simhash IS NULL OR o.simhash IS NULL THEN NULL
                ELSE pg_catalog.bit_count(((s.simhash OPERATOR(pg_catalog.#) o.simhash))::bit(64))::integer END AS ham
    FROM agg a
    JOIN src s ON s.id = a.sid
    JOIN public.document_chunks o ON o.id = a.oid
    JOIN public.documents od ON od.id = o.document_id
    WHERE o.tenant_key = p_tenant_key
      AND o.is_current
      AND o.status IN ('ready', 'variant')
      AND od.tenant_key = p_tenant_key
      AND od.is_current
      AND od.status = 'ready'
      AND o.document_id <> s.document_id
      AND o.chunking_profile_id = s.chunking_profile_id
  ),
  filtered AS (
    SELECT k.* FROM cand k WHERE k.is_exact OR (k.ham IS NOT NULL AND k.ham <= p_max_hamming)
  ),
  scored AS (
    SELECT f.*,
           CASE WHEN v_storage = 'legacy_column' THEN (
             SELECT (1 - (x.embedding OPERATOR(public.<=>) y.embedding))::double precision
             FROM public.document_chunks x, public.document_chunks y
             WHERE x.id = f.sid AND y.id = f.oid
               AND x.tenant_key = p_tenant_key AND y.tenant_key = p_tenant_key
               AND x.embedding IS NOT NULL AND y.embedding IS NOT NULL
           ) ELSE (
             SELECT (1 - (x.embedding OPERATOR(public.<=>) y.embedding))::double precision
             FROM public.chunk_embeddings x, public.chunk_embeddings y
             WHERE x.chunk_id = f.sid AND x.profile_id = v_profile
               AND y.chunk_id = f.oid AND y.profile_id = v_profile
               AND x.tenant_key = p_tenant_key AND y.tenant_key = p_tenant_key
               AND public.vector_dims(x.embedding) = public.vector_dims(y.embedding)
           ) END AS sim
    FROM filtered f
  ),
  ranked AS (
    SELECT s.*, pg_catalog.row_number() OVER (PARTITION BY s.sid ORDER BY s.is_exact DESC, s.sim DESC NULLS LAST, s.oid) AS rn
    FROM scored s
    WHERE s.is_exact OR (s.sim IS NOT NULL AND s.sim >= p_threshold)
  )
  SELECT r.sid, r.sdoc, r.oid, r.odoc, r.ocluster, r.sim, r.is_exact, r.ham
  FROM ranked r
  WHERE r.rn <= p_limit
  ORDER BY r.sid, r.rn;
END
$fn$;

-- Refreshes the given clusters of the tenant, or every dirty one when p_cluster_ids is null.
CREATE OR REPLACE FUNCTION public.rag_dup_clusters_recompute(p_tenant_key text, p_cluster_ids uuid[])
RETURNS TABLE (recomputed integer, dissolved integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_targets uuid[];
  v_small uuid[];
  v_recomputed integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_cluster_ids IS NOT NULL AND pg_catalog.cardinality(p_cluster_ids) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 cluster ids per call' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(k.id ORDER BY k.id), '{}'::uuid[]) INTO v_targets
  FROM (
    SELECT k.id FROM public.rag_dup_clusters k
    WHERE k.tenant_key = p_tenant_key
      AND ((p_cluster_ids IS NULL AND k.dirty) OR k.id = ANY (COALESCE(p_cluster_ids, '{}'::uuid[])))
    ORDER BY k.id
    FOR UPDATE
  ) k;
  IF pg_catalog.cardinality(v_targets) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- Members that are no longer current and ready (superseded, soft-deleted, quarantined) leave their cluster.
  UPDATE public.document_chunks c
     SET dup_cluster_id = NULL
   WHERE c.tenant_key = p_tenant_key
     AND c.dup_cluster_id = ANY (v_targets)
     AND NOT (
       c.is_current
       AND c.status IN ('ready', 'variant')
       AND EXISTS (
         SELECT 1 FROM public.documents d
         WHERE d.id = c.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
       )
     );

  SELECT COALESCE(pg_catalog.array_agg(t.id), '{}'::uuid[]) INTO v_small
  FROM pg_catalog.unnest(v_targets) AS t(id)
  WHERE (SELECT pg_catalog.count(*) FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id = t.id) < 2;

  UPDATE public.document_chunks c
     SET dup_cluster_id = NULL
   WHERE c.tenant_key = p_tenant_key
     AND c.dup_cluster_id = ANY (v_small);
  DELETE FROM public.rag_dup_clusters k WHERE k.tenant_key = p_tenant_key AND k.id = ANY (v_small);

  UPDATE public.rag_dup_clusters k
     SET member_count = m.n,
         source_document_ids = m.docs,
         representative_chunk_id = CASE WHEN k.representative_chunk_id = ANY (m.ids) THEN k.representative_chunk_id ELSE m.first_id END,
         dirty = false,
         updated_at = pg_catalog.now()
    FROM (
      SELECT c.dup_cluster_id AS cluster_id,
             pg_catalog.count(*)::integer AS n,
             pg_catalog.array_agg(DISTINCT c.document_id ORDER BY c.document_id) AS docs,
             pg_catalog.array_agg(c.id) AS ids,
             (pg_catalog.array_agg(c.id ORDER BY c.created_at, c.id))[1] AS first_id
      FROM public.document_chunks c
      WHERE c.tenant_key = p_tenant_key
        AND c.dup_cluster_id = ANY (v_targets)
      GROUP BY c.dup_cluster_id
    ) m
   WHERE k.id = m.cluster_id
     AND k.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_recomputed = ROW_COUNT;

  RETURN QUERY SELECT v_recomputed, pg_catalog.cardinality(v_small)::integer;
END
$fn$;

-- Joins the chunks (and every member of the clusters they already belong to) into one cluster of the active profile: the largest of
-- those clusters, the preferred one on a tie, or a new one. A document already represented in the cluster adds no second chunk.
CREATE OR REPLACE FUNCTION public.rag_dup_assign(p_tenant_key text, p_chunk_ids uuid[], p_preferred_cluster_id uuid)
RETURNS TABLE (cluster_id uuid, member_count integer, merged integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_profile text;
  v_eligible uuid[];
  v_clusters uuid[];
  v_target uuid;
  v_others uuid[];
  v_add uuid[];
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_chunk_ids IS NULL OR pg_catalog.cardinality(p_chunk_ids) > 1000 THEN
    RAISE EXCEPTION 'chunk ids: 0 to 1000 required' USING ERRCODE = '22023';
  END IF;
  IF p_preferred_cluster_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.rag_dup_clusters k WHERE k.id = p_preferred_cluster_id AND k.tenant_key = p_tenant_key
  ) THEN
    RAISE EXCEPTION 'cluster not found in tenant' USING ERRCODE = '22023';
  END IF;

  SELECT e.id INTO v_profile FROM public.embedding_profiles e WHERE e.status = 'active';
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'no active embedding profile' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(c.id ORDER BY c.id), '{}'::uuid[]) INTO v_eligible
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
  WHERE c.id = ANY (p_chunk_ids)
    AND c.tenant_key = p_tenant_key
    AND c.is_current
    AND c.status IN ('ready', 'variant')
    AND d.is_current
    AND d.status = 'ready';

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT c.dup_cluster_id), '{}'::uuid[]) INTO v_clusters
  FROM public.document_chunks c
  WHERE c.id = ANY (v_eligible) AND c.tenant_key = p_tenant_key AND c.dup_cluster_id IS NOT NULL;

  SELECT k.id INTO v_target
  FROM public.rag_dup_clusters k
  WHERE k.tenant_key = p_tenant_key
    AND k.embedding_profile_id = v_profile
    AND (k.id = ANY (v_clusters) OR k.id = p_preferred_cluster_id)
  ORDER BY k.member_count DESC, COALESCE(k.id = p_preferred_cluster_id, false) DESC, k.id
  LIMIT 1
  FOR UPDATE;

  IF v_target IS NULL THEN
    IF pg_catalog.cardinality(v_eligible) < 2 THEN
      RETURN;
    END IF;
    INSERT INTO public.rag_dup_clusters (tenant_key, embedding_profile_id, dirty)
    VALUES (p_tenant_key, v_profile, true)
    RETURNING id INTO v_target;
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(x.id), '{}'::uuid[]) INTO v_others
  FROM pg_catalog.unnest(v_clusters) AS x(id)
  WHERE x.id <> v_target;

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT m.id), '{}'::uuid[]) INTO v_add
  FROM (
    SELECT pg_catalog.unnest(v_eligible) AS id
    UNION
    SELECT c.id FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key AND c.dup_cluster_id = ANY (v_others)
  ) m;

  -- Deleting a merged cluster clears dup_cluster_id on its chunks (0853 foreign key); they join the target below.
  DELETE FROM public.rag_dup_clusters k WHERE k.tenant_key = p_tenant_key AND k.id = ANY (v_others);

  UPDATE public.document_chunks c
     SET dup_cluster_id = v_target
    FROM (
      SELECT DISTINCT ON (x.document_id) x.id
      FROM public.document_chunks x
      JOIN public.documents d ON d.id = x.document_id AND d.tenant_key = p_tenant_key
      WHERE x.id = ANY (v_add)
        AND x.tenant_key = p_tenant_key
        AND x.is_current
        AND x.status IN ('ready', 'variant')
        AND d.is_current
        AND d.status = 'ready'
        AND x.dup_cluster_id IS DISTINCT FROM v_target
        AND NOT EXISTS (
          SELECT 1 FROM public.document_chunks m
          WHERE m.tenant_key = p_tenant_key AND m.dup_cluster_id = v_target AND m.document_id = x.document_id
        )
      ORDER BY x.document_id, x.id
    ) pick
   WHERE c.id = pick.id
     AND c.tenant_key = p_tenant_key;

  PERFORM 1 FROM public.rag_dup_clusters_recompute(p_tenant_key, ARRAY[v_target]);

  SELECT k.member_count INTO v_count FROM public.rag_dup_clusters k WHERE k.id = v_target AND k.tenant_key = p_tenant_key;
  IF v_count IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_target, v_count, pg_catalog.cardinality(v_others)::integer;
END
$fn$;

-- p_document_id or p_chunk_ids: those chunks (current, ready), hashed or not. Neither: chunks without bands for the active profile.
CREATE OR REPLACE FUNCTION public.rag_dup_backfill_candidates(
  p_tenant_key text,
  p_after uuid,
  p_limit integer,
  p_document_id uuid,
  p_chunk_ids uuid[]
)
RETURNS TABLE (id uuid, document_id uuid, content text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_profile text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'limit must be within 1..1000' USING ERRCODE = '22023';
  END IF;
  IF p_chunk_ids IS NOT NULL AND pg_catalog.cardinality(p_chunk_ids) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 chunk ids per call' USING ERRCODE = '22023';
  END IF;

  SELECT e.id INTO v_profile FROM public.embedding_profiles e WHERE e.status = 'active';
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.document_id, c.content
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
  WHERE c.tenant_key = p_tenant_key
    AND c.is_current
    AND c.status IN ('ready', 'variant')
    AND d.is_current
    AND d.status = 'ready'
    AND (p_after IS NULL OR c.id > p_after)
    AND (p_document_id IS NULL OR c.document_id = p_document_id)
    AND (p_chunk_ids IS NULL OR c.id = ANY (p_chunk_ids))
    AND (
      p_document_id IS NOT NULL
      OR p_chunk_ids IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.rag_dup_chunk_bands b
        WHERE b.chunk_id = c.id AND b.tenant_key = p_tenant_key AND b.embedding_profile_id = v_profile
      )
    )
  ORDER BY c.id
  LIMIT p_limit;
END
$fn$;

-- Purge hook for the band table; returns the number of band rows removed. The cluster fields are handled by 0853's hook.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_dup_chunk_bands(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_removed bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  DELETE FROM public.rag_dup_chunk_bands b
   USING public.document_chunks c, public.documents d
   WHERE b.chunk_id = c.id
     AND b.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key
     AND d.id = c.document_id
     AND d.tenant_key = p_tenant_key
     AND (d.lineage_id = p_lineage_id OR d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_dup_write_hashes(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_dup_candidates(text, uuid[], integer, double precision, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_dup_clusters_recompute(text, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_dup_assign(text, uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_dup_backfill_candidates(text, uuid, integer, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_dup_chunk_bands(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_dup_write_hashes(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_dup_chunk_bands(text, uuid, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_dup_candidates(text, uuid[], integer, double precision, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_dup_clusters_recompute(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_dup_assign(text, uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_dup_backfill_candidates(text, uuid, integer, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

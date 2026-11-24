-- 0315: SQL side of the re-embed job (Phase 3, D-38, EMB-04).
-- The job fills one embedding profile from stored chunk text. Every function is bound to a run row: the run names the profile and, when it
-- is limited to one tenant, the tenant, and no function takes either from the caller again, so a run limited to tenant A cannot read,
-- derive or write anything of tenant B. rag_reembed_write_batch upserts the vectors and moves the run's cursor and counts in one
-- transaction, which is what lets a run killed between batches resume without a duplicate or a gap. A chunk that already has a vector of
-- the profile (same model and dims) is not picked again, so a resumed run, the sweep and dual-written chunks never cost a second embedding.
-- rag_reembed_pick is the one shared selection (internal, not granted). Server role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION rag_reembed_pick(
  p_profile_id text,
  p_tenant_key text,
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb,
  has_gap boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.document_id, c.tenant_key, c.content, c.section_path, c.chunk_kind,
         COALESCE(c.doc_type, d.doc_type),
         jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency),
         EXISTS (SELECT 1 FROM embedding_backfill_gaps g WHERE g.chunk_id = c.id AND g.profile_id = p.id)
  FROM embedding_profiles p
  JOIN document_chunks c ON c.is_current AND c.status = 'ready'
  JOIN documents d ON d.id = c.document_id
  WHERE p.id = p_profile_id
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    AND (p_after IS NULL OR c.id > p_after)
    AND NOT EXISTS (
      SELECT 1 FROM chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims)
  ORDER BY c.id
  LIMIT p_limit
$$;

-- Starts a run. The profile moves to backfilling, which is what makes ingestion dual-write it (0313). Refused for the active profile, the
-- legacy-column profile, a retired or unknown profile, a tenant key that is not one of the three shapes, and while a running run of the
-- same profile overlaps the tenant scope. p_derived_from names a profile of the same provider and model with more dimensions whose stored
-- vectors the run truncates and normalises (rag_reembed_derive_batch).
CREATE OR REPLACE FUNCTION rag_reembed_start_run(
  p_profile_id text,
  p_tenant_key text,
  p_actor text,
  p_derived_from text DEFAULT NULL
)
RETURNS TABLE (run_id uuid, profile_id text, tenant_key text, chunks_total bigint, derived_from text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_profile embedding_profiles%ROWTYPE;
  v_source embedding_profiles%ROWTYPE;
  v_total bigint;
  v_run uuid;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_profile FROM embedding_profiles p WHERE p.id = p_profile_id;
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

  IF p_derived_from IS NOT NULL THEN
    SELECT * INTO v_source FROM embedding_profiles p WHERE p.id = p_derived_from;
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
    SELECT 1 FROM embedding_backfill_runs r
    WHERE r.profile_id = p_profile_id AND r.status = 'running'
      AND (r.tenant_key IS NULL OR p_tenant_key IS NULL OR r.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_total FROM document_chunks c
  WHERE c.is_current AND c.status = 'ready' AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key);

  UPDATE embedding_profiles SET status = 'backfilling' WHERE id = p_profile_id AND status = 'available';

  INSERT INTO embedding_backfill_runs AS r (profile_id, tenant_key, chunks_total, derived_from)
  VALUES (p_profile_id, p_tenant_key, v_total, p_derived_from)
  RETURNING r.id INTO v_run;

  RETURN QUERY SELECT v_run, p_profile_id, p_tenant_key, v_total, p_derived_from;
END
$$;

CREATE OR REPLACE FUNCTION rag_reembed_get_run(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  tenant_key text,
  cursor_chunk_id uuid,
  chunks_total bigint,
  chunks_done bigint,
  tokens bigint,
  status text,
  derived_from text,
  provider text,
  model text,
  dims integer,
  storage text,
  profile_status text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.profile_id, r.tenant_key, r.cursor_chunk_id, r.chunks_total, r.chunks_done, r.tokens, r.status, r.derived_from,
         p.provider, p.model, p.dims, p.storage, p.status, r.updated_at
  FROM embedding_backfill_runs r
  JOIN embedding_profiles p ON p.id = r.profile_id
  WHERE r.id = p_run_id
$$;

-- Puts a running or failed run back to running so a killed or failed run continues from its cursor. A completed or rolled-back run is not
-- resumed (start a new run; it only picks what is still missing). A profile that fell back to available returns to backfilling.
CREATE OR REPLACE FUNCTION rag_reembed_resume_run(p_run_id uuid, p_actor text)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  tenant_key text,
  cursor_chunk_id uuid,
  chunks_total bigint,
  chunks_done bigint,
  tokens bigint,
  status text,
  derived_from text,
  provider text,
  model text,
  dims integer,
  storage text,
  profile_status text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'completed' THEN
    RAISE EXCEPTION 'reembed_refused: run_completed' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'reembed_refused: run_rolled_back' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO v_status FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM embedding_backfill_runs o
    WHERE o.id <> v_run.id AND o.profile_id = v_run.profile_id AND o.status = 'running'
      AND (o.tenant_key IS NULL OR v_run.tenant_key IS NULL OR o.tenant_key = v_run.tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  UPDATE embedding_profiles SET status = 'backfilling' WHERE id = v_run.profile_id AND status = 'available';
  UPDATE embedding_backfill_runs SET status = 'running', updated_at = now() WHERE id = v_run.id;
  RETURN QUERY SELECT * FROM rag_reembed_get_run(p_run_id);
END
$$;

-- The keyset pass: current, ready chunks of the run's scope after the cursor, in id order, that have no vector of the profile yet.
CREATE OR REPLACE FUNCTION rag_reembed_next_batch(p_run_id uuid, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit) x;
END
$$;

-- The sweep after the keyset pass: the chunks that still lack a vector of the profile, which are the ones written behind the cursor while
-- the pass ran and the chunks whose dual-write failed (has_gap says which have a recorded gap).
CREATE OR REPLACE FUNCTION rag_reembed_missing_batch(p_run_id uuid, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 128)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb,
  has_gap boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT * FROM rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit);
END
$$;

-- One transaction: upsert the vectors, resolve the recorded gaps of those chunks and move the run's cursor, counts and token total.
-- p_rows is [{chunk_id, vector, host}]. The cursor only moves forward and a null cursor leaves it alone (the sweep passes null). Every chunk
-- must be inside the run's tenant scope and be current and ready, every vector must have the profile's length, and a chunk may appear once.
-- Any refusal rolls back the whole call, so nothing of a refused batch is written and the cursor stays where it was.
CREATE OR REPLACE FUNCTION rag_reembed_write_batch(p_run_id uuid, p_rows jsonb, p_cursor uuid, p_tokens bigint DEFAULT 0)
RETURNS TABLE (chunks_written integer, chunks_done bigint, cursor_chunk_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_profile embedding_profiles%ROWTYPE;
  v_ids uuid[];
  wanted integer;
  in_scope integer;
  current_count integer;
  written integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.storage <> 'halfvec' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_rows: p_rows must be a non-empty JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value)
    WHERE jsonb_typeof(r.value) <> 'object'
       OR jsonb_typeof(r.value -> 'chunk_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(r.value -> 'vector') IS DISTINCT FROM 'array'
       OR (r.value ? 'host' AND jsonb_typeof(r.value -> 'host') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_rows: every row needs a chunk_id string, a vector array and an optional host string' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg((r.value ->> 'chunk_id')::uuid) INTO v_ids FROM jsonb_array_elements(p_rows) AS r(value);
  wanted := cardinality(v_ids);
  IF (SELECT count(DISTINCT u.id) FROM unnest(v_ids) AS u(id)) <> wanted THEN
    RAISE EXCEPTION 'invalid_rows: a chunk may appear once per batch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value) WHERE jsonb_array_length(r.value -> 'vector') <> v_profile.dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  SELECT count(*) INTO in_scope FROM document_chunks c
  WHERE c.id = ANY (v_ids) AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key);
  IF in_scope <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in the run scope';
  END IF;
  SELECT count(*) INTO current_count FROM document_chunks c WHERE c.id = ANY (v_ids) AND c.is_current AND c.status = 'ready';
  IF current_count <> wanted THEN
    RAISE EXCEPTION 'reembed_refused: chunk_not_current' USING ERRCODE = '55000';
  END IF;

  INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
  SELECT (r.value ->> 'chunk_id')::uuid, v_profile.id, c.tenant_key, ((r.value -> 'vector')::text)::halfvec, v_profile.model, v_profile.dims,
         left(r.value ->> 'host', 120)
  FROM jsonb_array_elements(p_rows) AS r(value)
  JOIN document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
  ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model,
    dims = EXCLUDED.dims,
    embedding_host = EXCLUDED.embedding_host,
    embedded_at = now();
  GET DIAGNOSTICS written = ROW_COUNT;

  DELETE FROM embedding_backfill_gaps g WHERE g.profile_id = v_profile.id AND g.chunk_id = ANY (v_ids);

  UPDATE embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + written,
    tokens = r.tokens + GREATEST(COALESCE(p_tokens, 0), 0),
    cursor_chunk_id = CASE WHEN p_cursor IS NOT NULL AND (r.cursor_chunk_id IS NULL OR p_cursor > r.cursor_chunk_id) THEN p_cursor ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT written, v_done, v_cursor;
END
$$;

-- --derive-from: fills the run's profile from the stored vectors of the profile it derives from, as l2_normalize(subvector(source, 1, dims)),
-- for chunks of the run's scope that lack the target. No provider is involved. Chunks with no source vector stay missing.
CREATE OR REPLACE FUNCTION rag_reembed_derive_batch(p_run_id uuid, p_limit integer)
RETURNS TABLE (chunks_derived integer, chunks_done bigint, cursor_chunk_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_target embedding_profiles%ROWTYPE;
  v_source embedding_profiles%ROWTYPE;
  v_ids uuid[];
  v_last uuid;
  derived integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
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
  SELECT * INTO v_target FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  SELECT * INTO v_source FROM embedding_profiles p WHERE p.id = v_run.derived_from;

  WITH picked AS (
    SELECT c.id, c.tenant_key, s.embedding AS source_vector
    FROM document_chunks c
    JOIN chunk_embeddings s
      ON s.chunk_id = c.id AND s.profile_id = v_source.id AND s.embedding_model = v_source.model AND s.dims = v_source.dims
    WHERE c.is_current AND c.status = 'ready'
      AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
      AND NOT EXISTS (
        SELECT 1 FROM chunk_embeddings t
        WHERE t.chunk_id = c.id AND t.profile_id = v_target.id AND t.embedding_model = v_target.model AND t.dims = v_target.dims)
    ORDER BY c.id
    LIMIT p_limit
  ), written AS (
    INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT p.id, v_target.id, p.tenant_key, l2_normalize(subvector(p.source_vector, 1, v_target.dims)), v_target.model, v_target.dims, 'derived'
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
    DELETE FROM embedding_backfill_gaps g WHERE g.profile_id = v_target.id AND g.chunk_id = ANY (v_ids);
    SELECT u.id INTO v_last FROM unnest(v_ids) AS u(id) ORDER BY u.id DESC LIMIT 1;
  END IF;

  UPDATE embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + derived,
    cursor_chunk_id = CASE
      WHEN v_last IS NOT NULL AND (r.cursor_chunk_id IS NULL OR v_last > r.cursor_chunk_id) THEN v_last
      ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT derived, v_done, v_cursor;
END
$$;

-- How many current, ready chunks of the run's scope still lack a vector of the profile.
CREATE OR REPLACE FUNCTION rag_reembed_remaining(p_run_id uuid)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_count bigint;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count
  FROM embedding_profiles p
  JOIN document_chunks c ON c.is_current AND c.status = 'ready'
  WHERE p.id = v_run.profile_id
    AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims);
  RETURN v_count;
END
$$;

-- The dry-run totals per tenant: current ready chunks, how many still lack a vector of the profile, and the characters of those chunks.
CREATE OR REPLACE FUNCTION rag_reembed_count(p_profile_id text, p_tenant_key text)
RETURNS TABLE (tenant_key text, chunks bigint, chunks_missing bigint, content_chars bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM embedding_profiles p WHERE p.id = p_profile_id) THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.tenant_key,
           count(*)::bigint,
           (count(*) FILTER (WHERE e.chunk_id IS NULL))::bigint,
           COALESCE(sum(length(c.content)) FILTER (WHERE e.chunk_id IS NULL), 0)::bigint
    FROM embedding_profiles p
    JOIN document_chunks c ON c.is_current AND c.status = 'ready'
    LEFT JOIN chunk_embeddings e
      ON e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims
    WHERE p.id = p_profile_id AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    GROUP BY c.tenant_key
    ORDER BY c.tenant_key;
END
$$;

-- The dry run's read of the text it will count tokens for: the same selection as the keyset pass, with no run, no write and no profile
-- change. Refused for the legacy-column profile, which this job does not fill.
CREATE OR REPLACE FUNCTION rag_reembed_preview_batch(p_profile_id text, p_tenant_key text, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_storage text;
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  SELECT p.storage INTO v_storage FROM embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM rag_reembed_pick(p_profile_id, p_tenant_key, p_after, p_limit) x;
END
$$;

-- Ends a running run. completed is refused while any chunk of the run's scope still lacks a vector; failed is always allowed. The profile
-- stays backfilling either way: only the activation gate moves it on.
CREATE OR REPLACE FUNCTION rag_reembed_finish_run(p_run_id uuid, p_status text)
RETURNS TABLE (run_id uuid, status text, chunks_missing bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'reembed_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  v_missing := rag_reembed_remaining(p_run_id);
  IF p_status = 'completed' AND v_missing > 0 THEN
    RAISE EXCEPTION 'reembed_refused: incomplete (% current ready chunks have no vector)', v_missing USING ERRCODE = '55000';
  END IF;
  UPDATE embedding_backfill_runs AS r SET status = p_status, updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT p_run_id, p_status, v_missing;
END
$$;

-- Deletes the target-profile rows a run wrote (rows of that profile and scope stamped between the run's start and its last update) and its
-- gaps, marks the run rolled back, and returns a backfilling profile to available when no other run of it is running. Refused for the active
-- profile, for a run that was updated in the last 10 minutes and is still running, and for a profile that has been active when any pointer
-- flip happened in the last 10 minutes (instances may still hold the old pointer, pitfall P-9).
CREATE OR REPLACE FUNCTION rag_reembed_rollback_run(p_run_id uuid, p_actor text)
RETURNS TABLE (rows_deleted bigint, profile_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_profile embedding_profiles%ROWTYPE;
  v_deleted bigint;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'rollback_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'running' AND v_run.updated_at > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'rollback_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.activated_at IS NOT NULL
     AND (SELECT max(p.activated_at) FROM embedding_profiles p) > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: recently_active' USING ERRCODE = '55000';
  END IF;

  DELETE FROM chunk_embeddings e
  WHERE e.profile_id = v_run.profile_id
    AND e.embedded_at >= v_run.started_at
    AND e.embedded_at <= v_run.updated_at
    AND (v_run.tenant_key IS NULL OR e.tenant_key = v_run.tenant_key);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM embedding_backfill_gaps g WHERE g.run_id = v_run.id;
  UPDATE embedding_backfill_runs AS r SET status = 'rolled_back', updated_at = now() WHERE r.id = v_run.id;

  IF v_profile.status = 'backfilling' AND NOT EXISTS (
    SELECT 1 FROM embedding_backfill_runs o WHERE o.profile_id = v_run.profile_id AND o.status = 'running' AND o.id <> v_run.id
  ) THEN
    UPDATE embedding_profiles SET status = 'available' WHERE id = v_run.profile_id;
  END IF;
  SELECT p.status INTO v_status FROM embedding_profiles p WHERE p.id = v_run.profile_id;

  RETURN QUERY SELECT v_deleted, v_status;
END
$$;

-- What the destructive legacy mode of scripts/rag/reprocess-documents.js must not run over: documents past version 1 (it deletes chunk ids that
-- citations point at) and profiles other than the legacy one that are backfilling, active, or hold vectors (their rows go with the chunks).
CREATE OR REPLACE FUNCTION rag_reembed_legacy_guard()
RETURNS TABLE (versioned_documents bigint, profiles_in_use text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    (SELECT count(*) FROM documents d WHERE d.version > 1),
    COALESCE(
      (SELECT array_agg(p.id ORDER BY p.id) FROM embedding_profiles p
       WHERE p.id <> 'openai-3-small-1536'
         AND (p.status IN ('backfilling', 'active') OR EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.profile_id = p.id))),
      '{}'::text[])
$$;

REVOKE ALL ON FUNCTION rag_reembed_pick(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_start_run(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_get_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_resume_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_next_batch(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_missing_batch(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_write_batch(uuid, jsonb, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_derive_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_remaining(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_count(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_preview_batch(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_finish_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_rollback_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_legacy_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_reembed_start_run(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_get_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_resume_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_next_batch(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_missing_batch(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_write_batch(uuid, jsonb, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_derive_batch(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_remaining(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_count(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_preview_batch(text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_finish_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_rollback_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_legacy_guard() TO service_role;

COMMIT;

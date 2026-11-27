-- Train 39 live SQL (ci/merge-train-39). Apply after train 38 is live (0930 both files, 0933, 0741, 0981, 0984 and 0410 r21). Multi-tenant production.
-- Order: 0982, 0983, 0985, 1010, then the 0410 r22 delta (grants only). No file in this train has mode variants; every file is common to
-- single-tenant and multi-tenant (rag_assert_tenant_key decides the mode).
-- Dependencies: 0982 and 0983 run after 0981 (0983 reads the active chunking profile rule of 0856, chunk_embeddings of 0308 and
-- rag_assert_tenant_key; it adds statement triggers on documents, document_chunks and chunk_embeddings); 0985 needs 0820
-- (chunk_translation_gaps); 1010 needs 1008 (live since train 31) and the 0920 block (documents.access_groups, rag_access_enforced of 0922).
-- 0410 is not re-run: the delta below repeats only the guarded lines train 39 adds to it (r22).
-- App compatibility: 1010 appends p_access_keys text[] and p_access_all boolean with defaults NULL and false to both attribute resolver
-- functions, so the app on main keeps calling them by name unchanged. 0982/0983/0985 are additive. Apply this SQL before deploying the
-- train-39 app.
-- DROP sections (each followed by a re-create in the same transaction):
--   0982: ALTER TABLE ... DROP CONSTRAINT IF EXISTS for the five CHECK constraints of rag_scope_centroids and rag_scope_negative_examples
--         (new tables; each constraint is re-added right after).
--   0983: DROP TRIGGER IF EXISTS for every rag_scope_centroids_* statement trigger on documents, document_chunks and chunk_embeddings;
--         each is re-created right after.
--   0985: ALTER TABLE public.chunk_translation_gaps DROP CONSTRAINT IF EXISTS chunk_translation_gaps_reason_check; re-added with
--         glossary_term_lost added to the allowed reasons (only widens).
--   1010: DO block drops every overload of rag_attribute_filter_values and rag_attribute_documents by catalog lookup (the 1008
--         signatures (text, integer) and (text, jsonb, integer)); exactly one of each is re-created with the two access parameters.
-- Operational notes:
--   0982 adds rag_scope_centroids and rag_scope_negative_examples (RLS on, no policy, service_role only). They start empty; the scope gate
--   is off by default and nothing is rebuilt until an admin runs npm run rag:scope-centroids.
--   0983 trigger functions are SECURITY DEFINER (service_role only via the 0410 r22 delta) and only delete centroid rows of the tenants in
--   the transition tables; with the tables empty they delete nothing. Every other 0983 function is INVOKER, empty search_path.
--   After 1010, rag_access_readiness() (0933) must report ready: re-running 1008 later brings back second overloads (function_overloaded)
--   until 1010 is re-run.
--   Nothing here writes or rewrites existing rows; no column is added to an existing table.

-- ==== supabase/migrations/0982_scope_gate_tables.sql
-- 0982: scope-gate storage (Phase 6.2, QRY-14, D-25, D-34, D-02).
-- rag_scope_centroids holds one mean embedding per (tenant, embedding profile, group kind, group key). The kinds are doc_type, scope_tag and
-- tenant; each group key is language-specific (D-34): <doc_type>/<language>, <dimension>:<value>/<language>, tenant/<language>. Rows are
-- derived only from the tenant's own current, ready chunks (no topic list anywhere) and are written by rag_scope_centroids_rebuild (0983).
-- rag_scope_negative_examples holds the tenant's out-of-scope example texts with their embedding in one profile, at most 100 per tenant and
-- profile and 500 characters each (enforced in 0983 and by the CHECK below). The centroid and embedding columns are untyped halfvec plus
-- dims, as in chunk_embeddings (0308), so profiles of different dimensions share a table. RLS is on with no policies; only service_role
-- reaches the tables, through the 0983 functions. pgvector stays in schema public (0425). Additive, idempotent; not folded into the setup
-- files.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_scope_centroids (
  tenant_key text NOT NULL,
  embedding_profile_id text NOT NULL,
  group_kind text NOT NULL,
  group_key text NOT NULL,
  centroid public.halfvec NOT NULL,
  dims integer NOT NULL,
  member_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (tenant_key, embedding_profile_id, group_kind, group_key)
);

ALTER TABLE public.rag_scope_centroids DROP CONSTRAINT IF EXISTS rag_scope_centroids_group_kind_check;
ALTER TABLE public.rag_scope_centroids ADD CONSTRAINT rag_scope_centroids_group_kind_check
  CHECK (group_kind IN ('doc_type', 'scope_tag', 'tenant'));
ALTER TABLE public.rag_scope_centroids DROP CONSTRAINT IF EXISTS rag_scope_centroids_group_key_check;
ALTER TABLE public.rag_scope_centroids ADD CONSTRAINT rag_scope_centroids_group_key_check
  CHECK (pg_catalog.length(group_key) BETWEEN 3 AND 200 AND pg_catalog.strpos(group_key, '/') > 1);
ALTER TABLE public.rag_scope_centroids DROP CONSTRAINT IF EXISTS rag_scope_centroids_counts_check;
ALTER TABLE public.rag_scope_centroids ADD CONSTRAINT rag_scope_centroids_counts_check CHECK (dims > 0 AND member_count > 0);

CREATE TABLE IF NOT EXISTS public.rag_scope_negative_examples (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  text text NOT NULL,
  text_key text NOT NULL,
  embedding_profile_id text NOT NULL,
  embedding public.halfvec NOT NULL,
  dims integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.rag_scope_negative_examples DROP CONSTRAINT IF EXISTS rag_scope_negative_examples_text_check;
ALTER TABLE public.rag_scope_negative_examples ADD CONSTRAINT rag_scope_negative_examples_text_check
  CHECK (pg_catalog.char_length(text) BETWEEN 1 AND 500 AND pg_catalog.char_length(text_key) BETWEEN 1 AND 500);
ALTER TABLE public.rag_scope_negative_examples DROP CONSTRAINT IF EXISTS rag_scope_negative_examples_dims_check;
ALTER TABLE public.rag_scope_negative_examples ADD CONSTRAINT rag_scope_negative_examples_dims_check CHECK (dims > 0);

CREATE UNIQUE INDEX IF NOT EXISTS rag_scope_negative_examples_unique_text
  ON public.rag_scope_negative_examples (tenant_key, embedding_profile_id, text_key);

ALTER TABLE public.rag_scope_centroids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_scope_negative_examples ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_scope_centroids FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_scope_negative_examples FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.rag_scope_centroids TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.rag_scope_negative_examples TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0983_scope_gate_functions.sql
-- 0983: scope-gate functions and delete-on-change triggers (Phase 6.2, QRY-14, D-25, D-34, D-02, P-27).
-- rag_scope_centroids_rebuild replaces a tenant's centroids for one embedding profile with the mean of its current, ready chunk embeddings
-- per group: one row per <doc_type>/<language>, per <dimension>:<value>/<language> scope tag and per tenant/<language> (D-34). A chunk is a
-- member when it and its document are current and ready, neither is provisional, and it belongs to the chunking profile retrieval searches
-- for its doc type (the 0856 rule: the active chunking profile, else legacy; legacy chunks stay members while the document has no chunk in
-- the active profile, and legacy image and invoice-header chunks always do). Superseded, deleted, quarantined, pending and failed versions
-- never count. The legacy profile (storage legacy_column) reads document_chunks.embedding cast to halfvec; every other profile reads
-- chunk_embeddings. The chunk language is used, falling back to the document language for und; a chunk with neither is grouped as und.
-- Readers: rag_scope_centroids_list (at most 500 rows), rag_scope_status (group counts, chunks included, newest update, whether the tenant
-- has an active doc-type-scoped embedding binding, example count). Examples: rag_scope_example_add (500 characters, 100 per tenant and
-- profile, duplicates by case- and whitespace-folded text refused), rag_scope_examples_list, rag_scope_example_delete.
-- Every function asserts p_tenant_key first with rag_assert_tenant_key (Phase 4 D-04), is SECURITY INVOKER with an empty search_path and
-- schema-qualified names, and is service_role only.
-- Same-transaction invalidation (P-27): statement triggers on documents, document_chunks and chunk_embeddings delete the affected tenant's
-- centroid rows whenever membership or vectors can change (insert, delete, and updates of currency, status, version, tenant, doc type,
-- language, scope tags, provisional, supersession, chunking profile or embedding). Missing rows mean unsure, so a stale gate fails open.
-- The trigger functions take a shared transaction advisory lock per tenant and rebuild takes the exclusive one, so a rebuild that overlaps
-- a membership change either sees it or is cleared by it. The trigger functions are SECURITY DEFINER so invalidation works for any writer;
-- they delete only rows of tenant keys taken from the transition tables. Additive, idempotent; not folded into the setup files.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_scope_lock_key(p_tenant_key text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.hashtextextended('rag_scope_centroids:' OPERATOR(pg_catalog.||) p_tenant_key, 0)
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_profile_dims(p_profile_id text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
BEGIN
  IF p_profile_id IS NULL OR pg_catalog.btrim(p_profile_id) = '' OR pg_catalog.length(p_profile_id) > 200 THEN
    RAISE EXCEPTION 'malformed embedding profile id' USING ERRCODE = '22023';
  END IF;
  SELECT p.dims INTO v_dims FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF v_dims IS NULL THEN
    RAISE EXCEPTION 'unknown embedding profile' USING ERRCODE = '22023';
  END IF;
  RETURN v_dims;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_rebuild(p_tenant_key text, p_profile_id text)
RETURNS TABLE (group_kind text, groups integer, chunks bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_legacy boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  v_dims := public.rag_scope_profile_dims(p_profile_id);
  SELECT p.storage = 'legacy_column' INTO v_legacy FROM public.embedding_profiles p WHERE p.id = p_profile_id;

  PERFORM pg_catalog.pg_advisory_xact_lock(public.rag_scope_lock_key(p_tenant_key));

  DELETE FROM public.rag_scope_centroids c WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id;

  INSERT INTO public.rag_scope_centroids (tenant_key, embedding_profile_id, group_kind, group_key, centroid, dims, member_count, updated_at)
  WITH eff AS MATERIALIZED (
    SELECT dt.doc_type,
           COALESCE(
             (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
             'legacy'
           ) AS profile_id
    FROM (SELECT DISTINCT c.doc_type FROM public.document_chunks c WHERE c.tenant_key = p_tenant_key AND c.doc_type IS NOT NULL) dt
  ),
  members AS MATERIALIZED (
    SELECT c.id AS chunk_id,
           COALESCE(c.doc_type, d.doc_type) AS doc_type,
           d.scopes,
           CASE WHEN c.language IS NULL OR c.language = 'und' THEN COALESCE(NULLIF(d.language, 'und'), 'und') ELSE c.language END AS language,
           CASE WHEN v_legacy THEN c.embedding::public.halfvec ELSE e.embedding END AS embedding
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = p_tenant_key
    JOIN eff ep ON ep.doc_type = c.doc_type
    LEFT JOIN public.chunk_embeddings e
      ON NOT v_legacy AND e.chunk_id = c.id AND e.profile_id = p_profile_id AND e.tenant_key = p_tenant_key AND e.dims = v_dims
    WHERE c.tenant_key = p_tenant_key
      AND c.is_current AND c.status = 'ready' AND NOT c.provisional
      AND d.is_current AND d.status = 'ready' AND NOT d.provisional
      AND (c.chunking_profile_id = ep.profile_id
        OR (ep.profile_id <> 'legacy' AND c.chunking_profile_id = 'legacy'
          AND (c.chunk_kind IN ('image', 'invoice_header')
            OR NOT EXISTS (
              SELECT 1 FROM public.document_chunks c2
              WHERE c2.document_id = c.document_id AND c2.tenant_key = p_tenant_key AND c2.is_current
                AND c2.chunking_profile_id = ep.profile_id))))
  ),
  usable AS MATERIALIZED (
    SELECT m.* FROM members m
    WHERE m.embedding IS NOT NULL AND public.vector_dims(m.embedding) = v_dims
  )
  SELECT p_tenant_key, p_profile_id, g.kind, g.key, g.centroid, v_dims, g.n, pg_catalog.now()
  FROM (
    SELECT 'doc_type'::text AS kind, u.doc_type OPERATOR(pg_catalog.||) '/' OPERATOR(pg_catalog.||) u.language AS key,
           public.avg(u.embedding) AS centroid, pg_catalog.count(*)::integer AS n
    FROM usable u
    GROUP BY u.doc_type, u.language
    UNION ALL
    SELECT 'scope_tag'::text, t.tag OPERATOR(pg_catalog.||) '/' OPERATOR(pg_catalog.||) u.language,
           public.avg(u.embedding), pg_catalog.count(*)::integer
    FROM usable u
    CROSS JOIN LATERAL pg_catalog.unnest(u.scopes) AS t(tag)
    WHERE t.tag IS NOT NULL AND pg_catalog.length(t.tag) BETWEEN 3 AND 190
    GROUP BY t.tag, u.language
    UNION ALL
    SELECT 'tenant'::text, 'tenant/' OPERATOR(pg_catalog.||) u.language,
           public.avg(u.embedding), pg_catalog.count(*)::integer
    FROM usable u
    GROUP BY u.language
  ) g;

  RETURN QUERY
  SELECT k.kind, COALESCE(s.groups, 0), COALESCE(s.chunks, 0)
  FROM (VALUES ('doc_type'::text), ('scope_tag'::text), ('tenant'::text)) AS k(kind)
  LEFT JOIN (
    SELECT c.group_kind, pg_catalog.count(*)::integer AS groups, pg_catalog.sum(c.member_count)::bigint AS chunks
    FROM public.rag_scope_centroids c
    WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id
    GROUP BY c.group_kind
  ) s ON s.group_kind = k.kind
  ORDER BY k.kind;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_list(p_tenant_key text, p_profile_id text)
RETURNS TABLE (group_kind text, group_key text, centroid public.halfvec, dims integer, member_count integer, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM public.rag_scope_profile_dims(p_profile_id);
  RETURN QUERY
  SELECT c.group_kind, c.group_key, c.centroid, c.dims, c.member_count, c.updated_at
  FROM public.rag_scope_centroids c
  WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id
  ORDER BY c.group_kind, c.group_key
  LIMIT 500;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_status(p_tenant_key text, p_profile_id text)
RETURNS TABLE (
  doc_type_groups integer,
  scope_tag_groups integer,
  tenant_groups integer,
  chunks_included bigint,
  newest_update timestamptz,
  has_scoped_binding boolean,
  examples integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM public.rag_scope_profile_dims(p_profile_id);
  RETURN QUERY
  SELECT
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'doc_type'),
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'scope_tag'),
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'tenant'),
    (SELECT COALESCE(pg_catalog.sum(c.member_count), 0)::bigint FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id AND c.group_kind = 'tenant'),
    (SELECT pg_catalog.max(c.updated_at) FROM public.rag_scope_centroids c
      WHERE c.tenant_key = p_tenant_key AND c.embedding_profile_id = p_profile_id),
    EXISTS (SELECT 1 FROM public.embedding_profile_bindings b
      WHERE b.status = 'active' AND (b.tenant_key = p_tenant_key OR b.tenant_key IS NULL)),
    (SELECT pg_catalog.count(*)::integer FROM public.rag_scope_negative_examples x
      WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_example_add(
  p_tenant_key text,
  p_profile_id text,
  p_text text,
  p_embedding public.halfvec,
  p_actor uuid
)
RETURNS TABLE (id uuid, created_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_dims integer;
  v_text text := pg_catalog.btrim(COALESCE(p_text, ''));
  v_key text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  v_dims := public.rag_scope_profile_dims(p_profile_id);
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  IF v_text = '' THEN
    RAISE EXCEPTION 'example_empty' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(v_text) > 500 THEN
    RAISE EXCEPTION 'example_too_long' USING ERRCODE = '22001';
  END IF;
  IF p_embedding IS NULL OR public.vector_dims(p_embedding) <> v_dims THEN
    RAISE EXCEPTION 'embedding does not match the profile' USING ERRCODE = '22023';
  END IF;
  v_key := pg_catalog.lower(pg_catalog.regexp_replace(v_text, '\s+', ' ', 'g'));

  PERFORM pg_catalog.pg_advisory_xact_lock(public.rag_scope_lock_key(p_tenant_key));

  IF EXISTS (SELECT 1 FROM public.rag_scope_negative_examples x
             WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id AND x.text_key = v_key) THEN
    RAISE EXCEPTION 'example_duplicate' USING ERRCODE = '23505';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.rag_scope_negative_examples x
      WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id) >= 100 THEN
    RAISE EXCEPTION 'example_limit' USING ERRCODE = '54000';
  END IF;

  RETURN QUERY
  INSERT INTO public.rag_scope_negative_examples AS x (tenant_key, text, text_key, embedding_profile_id, embedding, dims, created_by)
  VALUES (p_tenant_key, v_text, v_key, p_profile_id, p_embedding, v_dims, p_actor)
  RETURNING x.id, x.created_at;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_examples_list(p_tenant_key text, p_profile_id text)
RETURNS TABLE (id uuid, text text, embedding public.halfvec, dims integer, created_by uuid, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  PERFORM public.rag_scope_profile_dims(p_profile_id);
  RETURN QUERY
  SELECT x.id, x.text, x.embedding, x.dims, x.created_by, x.created_at
  FROM public.rag_scope_negative_examples x
  WHERE x.tenant_key = p_tenant_key AND x.embedding_profile_id = p_profile_id
  ORDER BY x.created_at, x.id
  LIMIT 100;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_example_delete(p_tenant_key text, p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id is required' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.rag_scope_negative_examples x WHERE x.id = p_id AND x.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END
$fn$;

-- Shared invalidation body: delete the centroid rows of the given tenants (all profiles when p_profile_id is NULL), after taking each
-- tenant's shared advisory lock in key order.
CREATE OR REPLACE FUNCTION public.rag_scope_centroids_invalidate(p_tenant_keys text[], p_profile_id text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
BEGIN
  FOR v_key IN SELECT DISTINCT k FROM pg_catalog.unnest(p_tenant_keys) AS u(k) WHERE k IS NOT NULL ORDER BY k LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(public.rag_scope_lock_key(v_key));
    DELETE FROM public.rag_scope_centroids c
    WHERE c.tenant_key = v_key AND (p_profile_id IS NULL OR c.embedding_profile_id = p_profile_id);
  END LOOP;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_documents_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT n.tenant_key FROM new_rows n WHERE n.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_documents_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(
    SELECT DISTINCT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND (o.is_current IS DISTINCT FROM n.is_current
        OR o.status IS DISTINCT FROM n.status
        OR o.version IS DISTINCT FROM n.version
        OR o.tenant_key IS DISTINCT FROM n.tenant_key
        OR o.doc_type IS DISTINCT FROM n.doc_type
        OR o.language IS DISTINCT FROM n.language
        OR o.scopes IS DISTINCT FROM n.scopes
        OR o.provisional IS DISTINCT FROM n.provisional
        OR o.superseded_by IS DISTINCT FROM n.superseded_by)
  ));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_documents_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT o.tenant_key FROM old_rows o WHERE o.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunks_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT n.tenant_key FROM new_rows n WHERE n.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunks_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(
    SELECT DISTINCT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND (o.is_current IS DISTINCT FROM n.is_current
        OR o.status IS DISTINCT FROM n.status
        OR o.tenant_key IS DISTINCT FROM n.tenant_key
        OR o.doc_type IS DISTINCT FROM n.doc_type
        OR o.language IS DISTINCT FROM n.language
        OR o.scopes IS DISTINCT FROM n.scopes
        OR o.provisional IS DISTINCT FROM n.provisional
        OR o.chunking_profile_id IS DISTINCT FROM n.chunking_profile_id
        OR (o.embedding IS NULL) IS DISTINCT FROM (n.embedding IS NULL)
        OR (o.embedding IS NOT NULL AND n.embedding IS NOT NULL AND o.embedding OPERATOR(public.<>) n.embedding))
  ));
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunks_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_scope_centroids_invalidate(ARRAY(SELECT DISTINCT o.tenant_key FROM old_rows o WHERE o.tenant_key IS NOT NULL));
  RETURN NULL;
END
$fn$;

-- chunk_embeddings changes clear only the changed profile's rows of the tenant.
CREATE OR REPLACE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT DISTINCT n.tenant_key, n.profile_id FROM new_rows n ORDER BY 1, 2 LOOP
      PERFORM public.rag_scope_centroids_invalidate(ARRAY[r.tenant_key], r.profile_id);
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR r IN SELECT DISTINCT o.tenant_key, o.profile_id FROM old_rows o ORDER BY 1, 2 LOOP
      PERFORM public.rag_scope_centroids_invalidate(ARRAY[r.tenant_key], r.profile_id);
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT t.tenant_key, t.profile_id
      FROM (SELECT o.tenant_key, o.profile_id FROM old_rows o UNION SELECT n.tenant_key, n.profile_id FROM new_rows n) AS t
      ORDER BY 1, 2
    LOOP
      PERFORM public.rag_scope_centroids_invalidate(ARRAY[r.tenant_key], r.profile_id);
    END LOOP;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS rag_scope_centroids_documents_insert ON public.documents;
CREATE TRIGGER rag_scope_centroids_documents_insert
  AFTER INSERT ON public.documents
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_documents_insert();

DROP TRIGGER IF EXISTS rag_scope_centroids_documents_update ON public.documents;
CREATE TRIGGER rag_scope_centroids_documents_update
  AFTER UPDATE ON public.documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_documents_update();

DROP TRIGGER IF EXISTS rag_scope_centroids_documents_delete ON public.documents;
CREATE TRIGGER rag_scope_centroids_documents_delete
  AFTER DELETE ON public.documents
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_documents_delete();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunks_insert ON public.document_chunks;
CREATE TRIGGER rag_scope_centroids_chunks_insert
  AFTER INSERT ON public.document_chunks
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunks_insert();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunks_update ON public.document_chunks;
CREATE TRIGGER rag_scope_centroids_chunks_update
  AFTER UPDATE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunks_update();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunks_delete ON public.document_chunks;
CREATE TRIGGER rag_scope_centroids_chunks_delete
  AFTER DELETE ON public.document_chunks
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunks_delete();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunk_embeddings_insert ON public.chunk_embeddings;
CREATE TRIGGER rag_scope_centroids_chunk_embeddings_insert
  AFTER INSERT ON public.chunk_embeddings
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunk_embeddings_update ON public.chunk_embeddings;
CREATE TRIGGER rag_scope_centroids_chunk_embeddings_update
  AFTER UPDATE ON public.chunk_embeddings
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change();

DROP TRIGGER IF EXISTS rag_scope_centroids_chunk_embeddings_delete ON public.chunk_embeddings;
CREATE TRIGGER rag_scope_centroids_chunk_embeddings_delete
  AFTER DELETE ON public.chunk_embeddings
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change();

REVOKE ALL ON FUNCTION public.rag_scope_lock_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_profile_dims(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_rebuild(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_list(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_status(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_example_add(text, text, text, public.halfvec, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_examples_list(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_example_delete(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_lock_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_profile_dims(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_rebuild(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_list(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_status(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_example_add(text, text, text, public.halfvec, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_examples_list(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_example_delete(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_insert() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_delete() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0985_translation_gap_glossary_reason.sql
-- 0985 (Phase 6.2, XLG-05 D-14): a chunk translation that loses a required glossary term after the one deterministic correction is not
-- stored; the producer records it as a gap with reason glossary_term_lost, so the job finishes and the chunk is not retried until its
-- source changes (or an admin rebuild clears the gap). Additive and idempotent: only the reason CHECK of chunk_translation_gaps widens.
-- Needs 0820. Not folded into the setup files.

DO $gap_reason_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.chunk_translation_gaps') IS NULL THEN
    RAISE EXCEPTION '0985: apply 0820 first' USING ERRCODE = '55000';
  END IF;
END
$gap_reason_precheck$;

ALTER TABLE public.chunk_translation_gaps DROP CONSTRAINT IF EXISTS chunk_translation_gaps_reason_check;
ALTER TABLE public.chunk_translation_gaps ADD CONSTRAINT chunk_translation_gaps_reason_check
  CHECK (reason IN ('too_long', 'protected_token_lost', 'empty_output', 'invalid_output', 'glossary_term_lost'));

-- ==== supabase/migrations/1010_attribute_resolver_access.sql
-- 1010: the 1008 attribute resolver takes the access filter (quick task attribute-access; SEC-12, D-10, D-11 of Phase 4.3).
-- 1008 runs after the 0920 block (0930, 0933), so its two functions had no access parameters and rag_access_readiness() named them; this
-- file is now the last definition of both. Each is the 1008 body plus p_access_keys text[] and p_access_all boolean, appended with
-- defaults NULL and false, every earlier parameter keeping its name, position and default, with the guard of 0930/0933: no keys while
-- public.rag_access_enforced() (0922) is true raises access_scope_required (42501), an empty key array or one holding NULL raises
-- access_keys_empty (22023). The guard runs right after the tenant assertion, before any other check.
-- With keys and p_access_all not true, a document contributes only when documents.access_groups overlaps the keys:
--   rag_attribute_filter_values  a value carried only by documents outside the keys is not listed;
--   rag_attribute_documents      a document outside the keys is never returned.
-- Attribute values live on documents, so the document label is the predicate. With no keys each function runs the 1008 query and returns
-- what 1008 returned. Definitions are not access-labelled, so unknown_attribute is unchanged for every caller.
-- DROP section: every overload of both names is dropped by catalog lookup first (the 1008 signatures (text, integer) and
-- (text, jsonb, integer)), so exactly one of each exists. Both stay SECURITY INVOKER and STABLE with an empty search_path, and are
-- executable by service_role only (0410 carries the guarded grant rows for the new signatures).
-- Operator rule (as 0933): after re-running 1008, re-run this file; until then the old signatures come back as second overloads and
-- rag_access_readiness() reports function_overloaded. Common to single-tenant and multi-tenant (rag_assert_tenant_key decides the mode).
-- Purge: no new store. Idempotent; not folded into the setup files.

BEGIN;

DO $attribute_access_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_access_enforced()') IS NULL
     OR pg_catalog.to_regclass('public.rag_attribute_definitions') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'access_groups' AND NOT a.attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'attributes' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '1010: apply the 0920 block (0921, 0922) and 1001 through 1008 first' USING ERRCODE = '55000';
  END IF;
END
$attribute_access_precheck$;

DO $drop_attribute_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('rag_attribute_filter_values', 'rag_attribute_documents')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_attribute_overloads$;

CREATE OR REPLACE FUNCTION public.rag_attribute_filter_values(
  p_tenant_key text,
  p_limit integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
 RETURNS TABLE(key text, value text, type text, soft boolean)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_restrict boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT v.key, v.value, v.type, v.soft
  FROM (
    SELECT DISTINCT def.key, item.value #>> '{}' AS value, def.type, def.soft
    FROM public.rag_attribute_definitions def
    JOIN public.documents d
      ON d.tenant_key = p_tenant_key AND d.status = 'ready' AND d.is_current
     AND d.attributes IS NOT NULL AND d.attributes ? def.key
     AND (NOT v_restrict OR d.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      CASE WHEN pg_catalog.jsonb_typeof(d.attributes -> def.key) = 'array' THEN d.attributes -> def.key
           ELSE pg_catalog.jsonb_build_array(d.attributes -> def.key) END
    ) AS item(value)
    WHERE def.tenant_key = p_tenant_key AND def.filterable
      AND pg_catalog.jsonb_typeof(item.value) = 'string'
  ) v
  ORDER BY v.key COLLATE "C", v.value COLLATE "C"
  LIMIT p_limit;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_attribute_documents(
  p_tenant_key text,
  p_filters jsonb,
  p_limit integer,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
 RETURNS TABLE(document_id uuid)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  entry record;
  item record;
  v_type text;
  v_keys integer := 0;
  v_values integer;
  v_patterns jsonb := '[]'::jsonb;
  v_restrict boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_filters IS NULL OR pg_catalog.jsonb_typeof(p_filters) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR entry IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_filters) AS e(key, value) ORDER BY e.key COLLATE "C" LOOP
    v_keys := v_keys + 1;
    IF v_keys > 30 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.jsonb_typeof(entry.value) <> 'array' THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    v_values := pg_catalog.jsonb_array_length(entry.value);
    IF v_values = 0 OR v_values > 50 THEN
      RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
    END IF;
    FOR item IN SELECT i.value FROM pg_catalog.jsonb_array_elements(entry.value) AS i(value) LOOP
      IF pg_catalog.jsonb_typeof(item.value) <> 'string'
         OR pg_catalog.char_length(item.value #>> '{}') NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;
  IF v_keys = 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  FOR entry IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_filters) AS e(key, value) ORDER BY e.key COLLATE "C" LOOP
    v_type := NULL;
    SELECT def.type INTO v_type
    FROM public.rag_attribute_definitions def
    WHERE def.tenant_key = p_tenant_key AND def.key = entry.key AND def.filterable;
    IF v_type IS NULL THEN
      RAISE EXCEPTION 'unknown_attribute' USING ERRCODE = '22023';
    END IF;
    FOR item IN SELECT DISTINCT i.value FROM pg_catalog.jsonb_array_elements(entry.value) AS i(value) LOOP
      v_patterns := v_patterns || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'key', entry.key,
        'pattern', pg_catalog.jsonb_build_object(
          entry.key,
          CASE WHEN v_type = 'text_list' THEN pg_catalog.jsonb_build_array(item.value) ELSE item.value END
        )
      ));
    END LOOP;
  END LOOP;

  RETURN QUERY
  SELECT hit.id
  FROM (
    SELECT DISTINCT probe.value ->> 'key' AS key, d.id
    FROM pg_catalog.jsonb_array_elements(v_patterns) AS probe(value)
    JOIN public.documents d
      ON d.tenant_key = p_tenant_key AND d.status = 'ready' AND d.is_current
     AND d.attributes @> (probe.value -> 'pattern')
     AND (NOT v_restrict OR d.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
  ) hit
  GROUP BY hit.id
  HAVING pg_catalog.count(*) = v_keys
  ORDER BY hit.id
  LIMIT p_limit;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) TO service_role;
REVOKE ALL ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r22 delta (the lines train 39 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r22_service_role_only$
BEGIN
  -- 0983 (Phase 6.2, 06.2-15): scope-gate invalidation helper and trigger functions, service_role only.
  IF to_regprocedure('public.rag_scope_centroids_invalidate(text[], text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_invalidate(text[], text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_documents_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_documents_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_documents_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_documents_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_documents_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunks_insert()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_insert() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_insert() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunks_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunks_delete()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunks_delete() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunks_delete() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_scope_centroids_on_chunk_embeddings_change()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_scope_centroids_on_chunk_embeddings_change() TO service_role;
  END IF;
  -- Migration 1010: the attribute resolver with the access filter (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_attribute_filter_values(text, integer, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_attribute_filter_values(text, integer, text[], boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_attribute_documents(text, jsonb, integer, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_attribute_documents(text, jsonb, integer, text[], boolean) TO service_role;
  END IF;
END
$r22_service_role_only$;

NOTIFY pgrst, 'reload schema';

-- ==== Verify (read-only; run after the apply)
-- 1. Exactly one overload of each attribute resolver, each with both access parameters and an empty search_path.
SELECT p.oid::regprocedure AS signature, p.prosecdef AS security_definer, p.proconfig AS config
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('rag_attribute_filter_values', 'rag_attribute_documents')
ORDER BY 1;
-- Expect two rows: (text, integer, text[], boolean) and (text, jsonb, integer, text[], boolean), security_definer false, search_path="".

-- 2. Access readiness (expect ready).
SELECT public.rag_access_readiness();

-- 3. Grants: anon and authenticated cannot execute any function this train adds or redefines.
SELECT p.oid::regprocedure AS signature,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'rag\_scope\_%' OR p.proname IN ('rag_attribute_filter_values', 'rag_attribute_documents'))
ORDER BY 1;
-- Expect anon_exec and authenticated_exec false everywhere, service_role_exec true everywhere.

-- 4. New tables: RLS on, no policy.
SELECT c.relname, c.relrowsecurity,
       (SELECT count(*) FROM pg_catalog.pg_policy pol WHERE pol.polrelid = c.oid) AS policies
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('rag_scope_centroids', 'rag_scope_negative_examples');
-- Expect relrowsecurity true and policies 0 for both.

-- 5. The widened gap reason CHECK.
SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE conname = 'chunk_translation_gaps_reason_check';
-- Expect glossary_term_lost among the allowed values.

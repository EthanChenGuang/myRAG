-- Train 35 live SQL (ci/merge-train-35). Apply after train 34 is live. Multi-tenant production.
-- Order: 0921, 0922, 0930, 0932, then the 0410 r18 delta (grants only). No mode-specific (.single-tenant / .multi-tenant) files in this train.
-- DROP sections (each followed by a re-create in the same transaction):
--   0921: DROP TRIGGER IF EXISTS document_chunks_access_groups_from_document ON public.document_chunks  (re-created)
--   0921: ALTER TABLE ... DROP CONSTRAINT <table>_access_groups_check only when it still calls rag_access_keys_valid (re-added inline)
--   0930: DO $drop_overloads$ drops EVERY public.hybrid_search_chunks overload found in pg_catalog (the 26-argument 0856 one on a
--         current database), then CREATE OR REPLACE re-creates one 28-argument function (0856 arguments unchanged, plus
--         p_access_keys text[] DEFAULT NULL and p_access_all boolean DEFAULT false). Existing named-argument callers keep working.
--   0932: DO $drop_overloads$ drops every public.rag_bm25_search_chunks overload (the 26-argument 0904 one), then one 28-argument
--         function is created in the same transaction (0904 arguments unchanged plus the same two access parameters).
-- Operational notes:
--   0921 adds documents.access_groups and document_chunks.access_groups (text[] NOT NULL DEFAULT '{all}': metadata-only on PG 11+),
--   then adds an inline CHECK constraint per table (built-ins only, so authenticated owners can still write rows; validates every
--   existing row; a constraint an earlier 0921 created with rag_access_keys_valid is dropped and replaced) and two GIN indexes (built without CONCURRENTLY: writes to
--   documents / document_chunks wait while they build). Run in a quiet window.
--   rag_access_enforced() reads rag_access_group_settings (0920, train 34), which stays enforced = false until the app writes it.

-- ==== supabase/migrations/0921_access_groups_columns.sql
-- 0921: document access groups on documents and document_chunks (Phase 4.3, D-02, D-03, D-31, A-14 seam 2).
-- access_groups text[] NOT NULL DEFAULT '{all}' on both tables. Keys are 'all', 'g:<group uuid>' or 'u:<user uuid>' (lowercase); the array
-- is non-empty and 'all' never appears next to another key (rag_access_keys_valid; the guarded CHECK constraints state the same rule
-- inline). A GIN index on each column serves the overlap predicate. A chunk's array is always its document's, whatever the writer sent: rag_access_groups_from_document()
-- (SECURITY DEFINER so the lookup does not depend on what the writing role may read) runs BEFORE INSERT OR UPDATE OF access_groups on
-- document_chunks; a one-off UPDATE aligns existing rows. Retrieval also checks the joined documents column (D-12), so a chunk that ever
-- drifts is never returned on its own label. document_chunks.access_groups is a stable seam for Phase 7 (07-38: vector-sync payload).
-- Adding a column with a constant default does not rewrite the table. Functions: SET search_path = '', REVOKE from PUBLIC, anon and
-- authenticated, GRANT to service_role. Not folded into the setup files. Idempotent.

BEGIN;

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';

CREATE OR REPLACE FUNCTION public.rag_access_keys_valid(p_keys text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT p_keys IS NOT NULL
    AND pg_catalog.cardinality(p_keys) > 0
    AND pg_catalog.array_position(p_keys, NULL::text) IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_keys) AS k(key)
      WHERE k.key !~ '^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
    )
    AND (pg_catalog.array_position(p_keys, 'all') IS NULL OR pg_catalog.cardinality(p_keys) = 1)
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_keys_valid(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_keys_valid(text[]) TO service_role;

-- The CHECK constraints repeat rag_access_keys_valid's rule inline, with built-in functions only, so every role RLS lets write a row
-- (authenticated owners included) can evaluate them; a CHECK that calls the service_role-only function fails for those roles with
-- "permission denied for function". The keys are joined with ',' (no valid key contains one): the joined text must be a ','-separated
-- list of valid keys, and splitting it again must give back as many parts as the array has elements. A constraint an earlier version of
-- this file created with the function call is replaced.
DO $constraints$
DECLARE
  v_rule constant text := 'access_groups IS NOT NULL AND pg_catalog.cardinality(access_groups) > 0 AND pg_catalog.array_position(access_groups, NULL::text) IS NULL AND pg_catalog.array_to_string(access_groups, '','') ~ ''^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(,(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))*$'' AND pg_catalog.cardinality(access_groups) = pg_catalog.cardinality(pg_catalog.string_to_array(pg_catalog.array_to_string(access_groups, '',''), '','')) AND (pg_catalog.array_position(access_groups, ''all'') IS NULL OR pg_catalog.cardinality(access_groups) = 1)';
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['documents', 'document_chunks'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.' || v_table) AND conname = v_table || '_access_groups_check'
        AND pg_catalog.pg_get_constraintdef(oid) LIKE '%rag_access_keys_valid%'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_table || '_access_groups_check');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass('public.' || v_table) AND conname = v_table || '_access_groups_check'
    ) THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', v_table, v_table || '_access_groups_check', v_rule);
    END IF;
  END LOOP;
END
$constraints$;

CREATE INDEX IF NOT EXISTS documents_access_groups_gin ON public.documents USING gin (access_groups);
CREATE INDEX IF NOT EXISTS document_chunks_access_groups_gin ON public.document_chunks USING gin (access_groups);

CREATE OR REPLACE FUNCTION public.rag_access_groups_from_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_groups text[];
BEGIN
  SELECT d.access_groups INTO v_groups FROM public.documents d WHERE d.id = NEW.document_id;
  IF FOUND THEN
    NEW.access_groups := v_groups;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_from_document() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_from_document() TO service_role;

DROP TRIGGER IF EXISTS document_chunks_access_groups_from_document ON public.document_chunks;
CREATE TRIGGER document_chunks_access_groups_from_document
  BEFORE INSERT OR UPDATE OF access_groups ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_from_document();

UPDATE public.document_chunks c
SET access_groups = d.access_groups
FROM public.documents d
WHERE d.id = c.document_id AND c.access_groups IS DISTINCT FROM d.access_groups;

COMMIT;

-- ==== supabase/migrations/0922_access_resolution.sql
-- 0922: access resolution helpers (Phase 4.3, D-09, D-10, A-02, A-03).
-- rag_access_enforced() returns the enforced flag of the single rag_access_group_settings row (0920), false when the row is missing. It is
-- STABLE SECURITY DEFINER (the settings table is service_role only) with an empty search_path. hybrid_search_chunks (0930) raises
-- access_scope_required when it is true and no access keys were sent. Executable by service_role only here; the RLS plan (04.3-06) grants it
-- to the client roles. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_access_enforced()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT COALESCE((SELECT s.enforced FROM public.rag_access_group_settings s WHERE s.id), false)
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO service_role;

COMMIT;

-- ==== supabase/migrations/0930_access_retrieval_functions.sql
-- 0930: the single Phase 4.3 home of every retrieval-function redefinition (D-11, D-12, D-31, A-04, SEC-12).
-- hybrid_search_chunks: the 0856 body (Phase 4.2, the newest definition) gains p_access_keys text[] and p_access_all boolean, appended with
-- defaults NULL and false; every earlier parameter keeps its name, position and default. With no keys the function builds the same SQL text
-- as 0856 and returns what 0856 returned, unless public.rag_access_enforced() (0922) is true: then it raises access_scope_required (42501).
-- An empty key array (or one holding NULL) raises access_keys_empty (22023). With keys and p_access_all not true, the predicate
-- c.access_groups && $24 AND d.access_groups && $24 is appended to v_filter, the one filter string the exact-count probe, the dense query
-- and the lexical query share, so all three apply it before ORDER BY and LIMIT. $24 is one above the highest position the three USING lists
-- bind in 0856 ($23, p_identifiers_norm, in each of them), and p_access_keys is bound at 24 in all three lists, so no list needs padding and
-- no leg compares labels to another argument. p_access_all (admin) is decided when the filter is built and is not bound.
-- Every hybrid_search_chunks overload is dropped by catalog lookup first (the 20-argument 0407/0413, 21-argument 0602, 24-argument 0802 and
-- 26-argument 0856 signatures), so exactly one exists. SECURITY INVOKER, VOLATILE, empty search_path, executable by service_role only.
-- rag_exact_id_documents and the other retrieval functions are redefined here by later plans of this phase. Re-running a lower-numbered
-- file that defines hybrid_search_chunks (0407, 0413, 0602, 0802, 0856 or a setup file) requires re-running this file; a re-run of this file
-- repairs that state. Later phases that need another parameter rebase on this body. Idempotent; not folded into the setup files.

BEGIN;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'hybrid_search_chunks'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding public.vector,
  p_lexical_tokens text[],
  p_dense_limit integer,
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off',
  p_exact_scan_cutoff integer DEFAULT 0,
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
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
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
  v_tsq tsquery;
  v_n integer;
  v_mode text := 'ann';
  v_filter text;
  v_date_filter text;
  v_from text;
  v_vec text;
  v_sel text;
  v_pgvector text;
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
  v_lex_filter text;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter".
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;

  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(p_chunking_override) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_tag IN ARRAY p_scopes LOOP
      v_dim := CASE WHEN v_tag IS NULL OR strpos(v_tag, ':') = 0 THEN NULL ELSE split_part(v_tag, ':', 1) END;
      IF v_dim IS NULL OR length(v_tag) <= length(v_dim) + 1 THEN
        RAISE EXCEPTION 'invalid_scope: a tag is dimension:value' USING ERRCODE = '22023';
      ELSIF v_dim = 'region' THEN
        v_scope_region := array_append(v_scope_region, v_tag);
      ELSIF v_dim = 'legal_entity' THEN
        v_scope_legal_entity := array_append(v_scope_legal_entity, v_tag);
      ELSIF v_dim = 'department' THEN
        v_scope_department := array_append(v_scope_department, v_tag);
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
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR public.vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  CREATE TEMP TABLE pg_temp._hybrid_eff_profile (doc_type text PRIMARY KEY, profile_id text) ON COMMIT DROP;
  INSERT INTO pg_temp._hybrid_eff_profile (doc_type, profile_id)
  SELECT dt.doc_type,
         COALESCE(
           NULLIF(trim(both FROM p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM public.chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         )
  FROM unnest(v_doc_types) AS dt(doc_type);

  IF COALESCE(p_include_undated, false) THEN
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3 OR c.doc_date IS NULL)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4 OR c.doc_date IS NULL)';
  ELSE
    v_date_filter :=
      ' AND ($3::date IS NULL OR c.doc_date >= $3)'
      || ' AND ($4::date IS NULL OR c.doc_date <= $4)';
  END IF;

  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM pg_temp._hybrid_eff_profile ep WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM public.document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || v_date_filter
    || ' AND ($5::text[] IS NULL OR (cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8) OR (c.language = ''und'' AND d.language = ANY($8)))'
    || ' AND ($9::text IS NULL OR strpos(lower(d.supplier_name), lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  IF v_scope_region IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $16::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''region:'')))) ';
  END IF;
  IF v_scope_legal_entity IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $17::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''legal_entity:'')))) ';
  END IF;
  IF v_scope_department IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.scopes && $18::text[] OR ($19::boolean'
      || ' AND NOT EXISTS (SELECT 1 FROM unnest(c.scopes) AS s(tag) WHERE starts_with(s.tag, ''department:'')))) ';
  END IF;
  IF p_effective_on IS NOT NULL THEN
    v_filter := v_filter || ' AND (c.effective_from IS NULL OR c.effective_from <= $20::date)'
      || ' AND (c.effective_to IS NULL OR c.effective_to >= $20::date) ';
  END IF;

  IF p_identifiers_norm IS NOT NULL THEN
    v_filter := v_filter || ' AND c.identifiers_norm && $23::text[] ';
  END IF;

  -- D-11, D-12: the caller's keys overlap the chunk's and its document's labels, before every ORDER BY and LIMIT (probe, dense, lexical).
  -- v_filter is one string for the three queries, so $24 is one fixed slot bound to p_access_keys in all three USING lists. p_access_all
  -- (admin) is decided here and never bound. Without keys (switch off) the text is exactly the 0856 text.
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN
    v_filter := v_filter || ' AND c.access_groups && $24::text[]'
      || ' AND d.access_groups && $24::text[] ';
  END IF;

  -- D-12: a range keeps a version whose period overlaps it. Start: effective_from when the column exists and is set, else the creation date
  -- (UTC); end: effective_to, else the successor's start (exclusive), else open. The effective-date columns are probed, so the same body
  -- runs on a database without them.
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

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text, c.dup_cluster_id, c.is_current, d.version ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' public.document_chunks c JOIN public.documents d ON d.id = c.document_id ';
      v_vec := format('c.embedding OPERATOR(public.<=>) $1::public.vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(
        ' public.chunk_embeddings e JOIN public.document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L'
        || ' JOIN public.documents d ON d.id = c.document_id ',
        p_profile_id
      );
      v_vec := format('(e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)', v_dims);
    END IF;

    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*)::int FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $13) s'
        INTO v_n
        USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
          p_supplier, p_amount_min, p_amount_max, p_currency, p_exact_scan_cutoff + 1, p_lexical_languages, p_query_embedding,
          v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, p_access_keys;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;

    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN
        SELECT extversion INTO v_pgvector FROM pg_catalog.pg_extension WHERE extname = 'vector';
        IF v_pgvector IS NULL OR (string_to_array(v_pgvector, '.'))[1:2]::int[] < ARRAY[0, 8] THEN
          RAISE EXCEPTION 'iterative_scan_unsupported' USING ERRCODE = '22023';
        END IF;
        PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);
      END IF;
    END IF;

    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $13) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $13) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_dense_limit, p_lexical_languages, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, p_access_keys;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
    v_lex_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    -- D-40: superseded chunks have no vectors, so only this leg widens. A superseded row is ready, not provisional, of a ready document
    -- of this tenant that is not current, and its content differs from its successor's (a re-publish of the same text is left out).
    IF v_scope_mode IN ('all', 'range') THEN
      v_lex_filter := replace(
        replace(v_lex_filter, ' c.tenant_key = $2 AND c.is_current AND ',
          ' c.tenant_key = $2 AND (c.is_current OR (NOT c.is_current AND NOT c.provisional AND d.tenant_key = $2 AND NOT d.is_current'
          || ' AND d.status = ''ready'' AND NOT d.provisional AND d.superseded_by IS NOT NULL'
          || ' AND EXISTS (SELECT 1 FROM public.documents sd WHERE sd.id = d.superseded_by AND sd.tenant_key = $2'
          || ' AND sd.content_hash IS DISTINCT FROM d.content_hash))) AND '),
        'c2.is_current AND c2.chunking_profile_id', 'c2.is_current = c.is_current AND c2.chunking_profile_id'
      );
    END IF;
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score'
      || ' FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id WHERE ' || v_lex_filter
      || ' AND ($14::text[] IS NULL OR (cardinality($14) > 0 AND (c.language = ANY($14) OR (c.language = ''und'' AND d.language = ANY($14)))))'
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $13) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(
        v_sel,
        CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
          THEN format('(1 - (c.embedding OPERATOR(public.<=>) $15::public.vector(%s)))::double precision', v_dims)
          ELSE 'NULL::double precision' END,
        't.score::real',
        'n/a'
      )
      || ' FROM hits t JOIN public.document_chunks c ON c.id = t.hid JOIN public.documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding,
        v_scope_region, v_scope_legal_entity, v_scope_department, COALESCE(p_scopes_include_untagged, false), p_effective_on,
        v_range_from, v_range_to, p_identifiers_norm, p_access_keys;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(
  text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, jsonb, text[], text[], boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(
  text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb, boolean, text[], boolean, date, jsonb, text[], text[], boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0932_access_bm25_search.sql
-- 0932: rag_bm25_search_chunks gains the Phase 4.3 access filter of 0930 (D-05, D-09 to D-12, SEC-12), so the BM25 lexical leg never
-- returns a chunk the caller's access groups do not cover. The 0904 body (Phase 4.4, its only definition) gains p_access_keys text[] and
-- p_access_all boolean, appended with defaults NULL and false and the names, types and defaults of hybrid_search_chunks in 0930
-- (tests/rag-db/bm25-filter-parity.test.mts). With no keys the function builds the same SQL text as 0904 and returns what 0904 returned,
-- unless public.rag_access_enforced() (0922) is true: then it raises access_scope_required (42501). An empty key array (or one holding
-- NULL) raises access_keys_empty (22023). With keys and p_access_all not true, c.access_groups && $31 AND d.access_groups && $31 is
-- appended to v_filter before the candidate ORDER BY and LIMIT; $31 is one above the highest position 0904 binds ($30, avgdl).
-- p_access_all (admin) is decided when the filter is built and is not bound. Every rag_bm25_search_chunks overload is dropped by catalog
-- lookup first, so exactly one exists. Re-running 0904 requires re-running this file. SECURITY INVOKER, VOLATILE, empty search_path,
-- service_role only. Idempotent; not folded into the setup files.

BEGIN;

DO $bm25_access_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexical_tsquery(text[])') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'hybrid_search_chunks' AND 'p_identifiers_norm' = ANY (p.proargnames)
     )
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_df') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_corpus') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_access_enforced()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.document_chunks'::pg_catalog.regclass AND attname = 'access_groups' AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION '0932: apply migrations 0401, 0403, 0856, 0900, 0904, 0921 and 0922 first' USING ERRCODE = '55000';
  END IF;
END
$bm25_access_precheck$;

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
  p_candidate_limit integer DEFAULT 500,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
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

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter" (as 0930).
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;

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

  -- D-11, D-12: the caller's keys overlap the chunk's and its document's labels, before the candidate ORDER BY and LIMIT, as 0930 does.
  -- p_access_all (admin) is decided here and never bound. Without keys (switch off) the text is exactly the 0904 text.
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) THEN
    v_filter := v_filter || ' AND c.access_groups && $31::text[]'
      || ' AND d.access_groups && $31::text[] ';
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
      v_range_from, v_range_to, p_identifiers_norm, v_eff, p_k1, p_b, p_candidate_limit, v_tokens, v_idfs, v_avgdl, p_access_keys;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_bm25_search_chunks(
  text, text, public.vector, text[], integer, date, date, text[], uuid[], text[], text[], text[], text, numeric, numeric, text, jsonb,
  boolean, text[], boolean, date, jsonb, text[], double precision, double precision, integer, text[], boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r18 delta (the lines train 35 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r18$
BEGIN
  IF to_regprocedure('public.rag_access_enforced()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_groups_from_document()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_from_document() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_from_document() TO service_role;
  END IF;
END
$r18$;

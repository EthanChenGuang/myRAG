-- 0921: document access groups on documents and document_chunks (Phase 4.3, D-02, D-03, D-31, A-14 seam 2).
-- access_groups text[] NOT NULL DEFAULT '{all}' on both tables. Keys are 'all', 'g:<group uuid>' or 'u:<user uuid>' (lowercase); the array
-- is non-empty and 'all' never appears next to another key (rag_access_keys_valid; the CHECK constraints spell the same rule without a function call). A GIN index on each column
-- serves the overlap predicate. A chunk's array is always its document's, whatever the writer sent: rag_access_groups_from_document()
-- (SECURITY DEFINER so the lookup does not depend on what the writing role may read) runs BEFORE INSERT OR UPDATE OF access_groups on
-- document_chunks; a one-off UPDATE aligns existing rows. Retrieval also checks the joined documents column (D-12), so a chunk that ever
-- drifts is never returned on its own label. document_chunks.access_groups is a stable seam for Phase 7 (07-38: vector-sync payload).
-- Adding a column with a constant default does not rewrite the table. Functions: SET search_path = '', REVOKE from PUBLIC, anon and
-- authenticated, GRANT to service_role. Not folded into the setup files. Idempotent.
-- Plan 04.3-04 completes the file. document_parents carries the same column, check, GIN index and copy trigger. The optional derived stores
-- (chunk_translations, rag_table_rows) get them inside one to_regclass guard each, so an absent table is skipped and a later re-run of this
-- file completes it; duplicate-cluster membership is document_chunks.dup_cluster_id, so it is covered by the chunk column. A relabel of a
-- document reaches every derived row in the same transaction (rag_access_groups_propagate and one propagate function per optional store,
-- AFTER UPDATE OF access_groups ON documents). Clients cannot set the label: rag_documents_access_guard (SECURITY INVOKER, current_user is the
-- writing role) resets it to the default on a client insert and refuses a client update with access_groups_server_only (42501); the copy
-- triggers replace any client value on derived rows. rag_documents_access_inherit (SECURITY DEFINER) gives a new version inserted with the
-- default the label of its lineage's current version in the same tenant (D-19); trigger names fix the order guard, then inheritance.
-- rag_access_groups_drift() counts, per present store, the rows whose array differs from their document's, current and superseded alike.

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

-- The CHECK constraints are added below, after every labelled table has its column (one loop, function-free expression).

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

-- document_parents (D-03).

ALTER TABLE public.document_parents ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';

CREATE INDEX IF NOT EXISTS document_parents_access_groups_gin ON public.document_parents USING gin (access_groups);

DROP TRIGGER IF EXISTS document_parents_access_groups_from_document ON public.document_parents;
CREATE TRIGGER document_parents_access_groups_from_document
  BEFORE INSERT OR UPDATE OF access_groups ON public.document_parents
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_from_document();

UPDATE public.document_parents p
SET access_groups = d.access_groups
FROM public.documents d
WHERE d.id = p.document_id AND p.access_groups IS DISTINCT FROM d.access_groups;

-- Relabel propagation to chunks and parents (D-03, D-17).

CREATE OR REPLACE FUNCTION public.rag_access_groups_propagate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.document_chunks c
  SET access_groups = NEW.access_groups
  WHERE c.document_id = NEW.id AND c.access_groups IS DISTINCT FROM NEW.access_groups;
  UPDATE public.document_parents p
  SET access_groups = NEW.access_groups
  WHERE p.document_id = NEW.id AND p.access_groups IS DISTINCT FROM NEW.access_groups;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_propagate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate() TO service_role;

DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate ON public.documents;
CREATE TRIGGER rag_documents_access_groups_propagate
  AFTER UPDATE OF access_groups ON public.documents
  FOR EACH ROW
  WHEN (OLD.access_groups IS DISTINCT FROM NEW.access_groups)
  EXECUTE FUNCTION public.rag_access_groups_propagate();

-- Optional derived stores (D-03, D-30, A-11). The functions are top level; their triggers exist only when the table does.

CREATE OR REPLACE FUNCTION public.rag_access_groups_propagate_translations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.chunk_translations t
  SET access_groups = NEW.access_groups
  WHERE t.document_id = NEW.id AND t.access_groups IS DISTINCT FROM NEW.access_groups;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_translations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_translations() TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_groups_propagate_table_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.rag_table_rows r
  SET access_groups = NEW.access_groups
  WHERE r.document_id = NEW.id AND r.access_groups IS DISTINCT FROM NEW.access_groups;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_table_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_table_rows() TO service_role;

DO $translations_access$
BEGIN
  IF pg_catalog.to_regclass('public.chunk_translations') IS NULL THEN
    DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_translations ON public.documents;
    RAISE NOTICE '0921: public.chunk_translations is absent; re-run this file once it exists';
    RETURN;
  END IF;
  ALTER TABLE public.chunk_translations ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';
  CREATE INDEX IF NOT EXISTS chunk_translations_access_groups_gin ON public.chunk_translations USING gin (access_groups);
  DROP TRIGGER IF EXISTS chunk_translations_access_groups_from_document ON public.chunk_translations;
  CREATE TRIGGER chunk_translations_access_groups_from_document
    BEFORE INSERT OR UPDATE OF access_groups ON public.chunk_translations
    FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_from_document();
  DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_translations ON public.documents;
  CREATE TRIGGER rag_documents_access_groups_propagate_translations
    AFTER UPDATE OF access_groups ON public.documents
    FOR EACH ROW
    WHEN (OLD.access_groups IS DISTINCT FROM NEW.access_groups)
    EXECUTE FUNCTION public.rag_access_groups_propagate_translations();
  UPDATE public.chunk_translations t
  SET access_groups = d.access_groups
  FROM public.documents d
  WHERE d.id = t.document_id AND t.access_groups IS DISTINCT FROM d.access_groups;
END
$translations_access$;

DO $table_rows_access$
BEGIN
  IF pg_catalog.to_regclass('public.rag_table_rows') IS NULL THEN
    DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_table_rows ON public.documents;
    RAISE NOTICE '0921: public.rag_table_rows is absent; re-run this file once it exists';
    RETURN;
  END IF;
  ALTER TABLE public.rag_table_rows ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';
  CREATE INDEX IF NOT EXISTS rag_table_rows_access_groups_gin ON public.rag_table_rows USING gin (access_groups);
  DROP TRIGGER IF EXISTS rag_table_rows_access_groups_from_document ON public.rag_table_rows;
  CREATE TRIGGER rag_table_rows_access_groups_from_document
    BEFORE INSERT OR UPDATE OF access_groups ON public.rag_table_rows
    FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_from_document();
  DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_table_rows ON public.documents;
  CREATE TRIGGER rag_documents_access_groups_propagate_table_rows
    AFTER UPDATE OF access_groups ON public.documents
    FOR EACH ROW
    WHEN (OLD.access_groups IS DISTINCT FROM NEW.access_groups)
    EXECUTE FUNCTION public.rag_access_groups_propagate_table_rows();
  UPDATE public.rag_table_rows r
  SET access_groups = d.access_groups
  FROM public.documents d
  WHERE d.id = r.document_id AND r.access_groups IS DISTINCT FROM d.access_groups;
END
$table_rows_access$;

-- Key checks (D-02) on every labelled table. The expression is the one of rag_access_keys_valid written without a function call: a CHECK
-- runs with the writing role's privileges, and the function stays service_role only, so a client insert would otherwise fail with
-- permission denied (found by plan 04's client cases). Non-empty, no NULL element, each key 'all', 'g:<uuid>' or 'u:<uuid>', 'all' alone; the
-- comma count rules out an element that itself holds a comma. A constraint of the earlier form is replaced; absent tables are skipped.

DO $access_checks$
DECLARE
  v_table text;
  v_name text;
  v_def text;
  v_expr constant text := 'pg_catalog.cardinality(access_groups) > 0'
    || ' AND pg_catalog.array_position(access_groups, NULL::text) IS NULL'
    || ' AND pg_catalog.array_to_string(access_groups, '','') ~ ''^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*)$'''
    || ' AND pg_catalog.length(pg_catalog.array_to_string(access_groups, '',''))'
    || ' - pg_catalog.length(pg_catalog.replace(pg_catalog.array_to_string(access_groups, '',''), '','', '''')) = pg_catalog.cardinality(access_groups) - 1';
BEGIN
  FOREACH v_table IN ARRAY ARRAY['documents', 'document_chunks', 'document_parents', 'chunk_translations', 'rag_table_rows'] LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_table) AND a.attname = 'access_groups' AND NOT a.attisdropped
    );
    v_name := v_table || '_access_groups_check';
    v_def := NULL;
    SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = pg_catalog.to_regclass('public.' || v_table) AND c.conname = v_name;
    IF v_def IS NOT NULL AND v_def LIKE '%rag_access_keys_valid%' THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_name);
      v_def := NULL;
    END IF;
    IF v_def IS NULL THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', v_table, v_name, v_expr);
    END IF;
  END LOOP;
END
$access_checks$;

-- Client write guard on documents (D-06, D-16). Roles other than the server roles are clients; DEFINER writers run as their owner.

CREATE OR REPLACE FUNCTION public.rag_documents_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.access_groups := '{all}'::text[];
  ELSIF NEW.access_groups IS DISTINCT FROM OLD.access_groups THEN
    RAISE EXCEPTION 'access_groups_server_only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_documents_access_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_documents_access_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_documents_access_a_guard ON public.documents;
CREATE TRIGGER rag_documents_access_a_guard
  BEFORE INSERT OR UPDATE OF access_groups ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_documents_access_guard();

-- Version inheritance (D-19). documents.tenant_key is generated and unset in a BEFORE trigger, so the tenant is computed from the row.

CREATE OR REPLACE FUNCTION public.rag_documents_access_inherit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_multi_tenant boolean;
  v_tenant text;
  v_groups text[];
BEGIN
  IF NEW.lineage_id IS NULL OR NEW.access_groups IS DISTINCT FROM '{all}'::text[] THEN
    RETURN NEW;
  END IF;
  v_multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF v_multi_tenant THEN
    v_tenant := CASE WHEN NEW.organization_id IS NOT NULL THEN 'o:' || NEW.organization_id::text ELSE 'u:' || NEW.user_id::text END;
  ELSE
    v_tenant := 's:default';
  END IF;
  SELECT d.access_groups INTO v_groups
  FROM public.documents d
  WHERE d.lineage_id = NEW.lineage_id AND d.tenant_key = v_tenant AND d.is_current AND d.id IS DISTINCT FROM NEW.id
  ORDER BY d.version DESC NULLS LAST
  LIMIT 1;
  IF FOUND THEN
    NEW.access_groups := v_groups;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_documents_access_inherit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_documents_access_inherit() TO service_role;

DROP TRIGGER IF EXISTS rag_documents_access_b_inherit ON public.documents;
CREATE TRIGGER rag_documents_access_b_inherit
  BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_documents_access_inherit();

-- Drift check (D-33, A-08): rows whose array differs from their document's, per present store, current and superseded rows alike.

CREATE OR REPLACE FUNCTION public.rag_access_groups_drift()
RETURNS TABLE (store text, rows bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_store text;
  v_count bigint;
BEGIN
  RETURN QUERY
  SELECT 'document_chunks'::text, pg_catalog.count(*)
  FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id
  WHERE c.access_groups IS DISTINCT FROM d.access_groups;
  RETURN QUERY
  SELECT 'document_parents'::text, pg_catalog.count(*)
  FROM public.document_parents p JOIN public.documents d ON d.id = p.document_id
  WHERE p.access_groups IS DISTINCT FROM d.access_groups;
  FOREACH v_store IN ARRAY ARRAY['chunk_translations', 'rag_table_rows'] LOOP
    IF pg_catalog.to_regclass('public.' || v_store) IS NOT NULL AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_store) AND a.attname = 'access_groups' AND NOT a.attisdropped
    ) THEN
      EXECUTE pg_catalog.format(
        'SELECT pg_catalog.count(*) FROM public.%I x JOIN public.documents d ON d.id = x.document_id WHERE x.access_groups IS DISTINCT FROM d.access_groups',
        v_store
      ) INTO v_count;
      store := v_store;
      rows := v_count;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_drift() TO service_role;

COMMIT;

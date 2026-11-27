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

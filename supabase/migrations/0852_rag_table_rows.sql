-- 0852: Phase 4.2 typed row store for Markdown tables (RET-12, D-15, D-45).
-- One row per table row of a document version and chunking profile: header, cells (column name -> cell text), cell_norm (union of the
-- row's normalized cell tokens, GIN pre-filter) and cell_tokens (one token array per cell). RLS is on with no policies; only service_role
-- reaches the table. A guard refuses a tenant_key that differs from the document's and fills tenant, version, is_current and status from
-- the document when the writer leaves them out. A statement trigger on documents copies changed is_current and status to the document's
-- rows; deleting the document removes them (ON DELETE CASCADE). The column list is open for a later access_groups column (Phase 4.3).
-- Purge: rag_purge_hook_table_rows(p_tenant_key, p_lineage_id, p_document_ids) removes the rows of a purged lineage or of the listed
-- documents in that tenant. Readers and writers come in later plans. Idempotent; not folded into the setup files.

BEGIN;

DO $table_rows_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass('public.documents') AND a.attname = 'tenant_key' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0852: apply the earlier migrations first (0301, 0401)' USING ERRCODE = '55000';
  END IF;
END
$table_rows_precheck$;

CREATE TABLE IF NOT EXISTS public.rag_table_rows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  document_id uuid NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE,
  version integer NOT NULL,
  is_current boolean NOT NULL,
  status text NOT NULL,
  chunking_profile_id text NOT NULL DEFAULT 'legacy',
  table_key text NOT NULL,
  row_index integer NOT NULL,
  header text[] NOT NULL DEFAULT '{}'::text[],
  cells jsonb NOT NULL DEFAULT '{}'::jsonb,
  cell_norm text[] NOT NULL DEFAULT '{}'::text[],
  cell_tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
  chunk_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_table_rows_table_key_check CHECK (pg_catalog.length(table_key) BETWEEN 1 AND 200),
  CONSTRAINT rag_table_rows_row_index_check CHECK (row_index >= 0),
  CONSTRAINT rag_table_rows_cells_object CHECK (pg_catalog.jsonb_typeof(cells) = 'object'),
  CONSTRAINT rag_table_rows_cell_tokens_array CHECK (pg_catalog.jsonb_typeof(cell_tokens) = 'array'),
  CONSTRAINT rag_table_rows_row_ux UNIQUE (document_id, chunking_profile_id, table_key, row_index)
);

CREATE INDEX IF NOT EXISTS rag_table_rows_cell_norm_gin ON public.rag_table_rows USING gin (cell_norm);
CREATE INDEX IF NOT EXISTS rag_table_rows_tenant_document_idx ON public.rag_table_rows (tenant_key, document_id);

ALTER TABLE public.rag_table_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_table_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_table_rows TO service_role;

-- Guard: the row belongs to its document's tenant. Reads only the document row, so SECURITY INVOKER (D-56).
CREATE OR REPLACE FUNCTION public.rag_table_rows_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_tenant text;
  v_version integer;
  v_is_current boolean;
  v_status text;
BEGIN
  SELECT d.tenant_key, d.version, d.is_current, d.status INTO v_tenant, v_version, v_is_current, v_status
  FROM public.documents d WHERE d.id = NEW.document_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'rag_table_rows: document has no tenant_key' USING ERRCODE = '23502';
  END IF;
  IF NEW.tenant_key IS NOT NULL AND NEW.tenant_key IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'rag_table_rows: tenant_mismatch' USING ERRCODE = '42501';
  END IF;
  NEW.tenant_key := v_tenant;
  IF TG_OP = 'INSERT' THEN
    NEW.version := COALESCE(NEW.version, v_version);
    NEW.is_current := COALESCE(NEW.is_current, v_is_current);
    NEW.status := COALESCE(NEW.status, v_status);
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_table_rows_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_table_rows_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_table_rows_guard ON public.rag_table_rows;
CREATE TRIGGER rag_table_rows_guard
  BEFORE INSERT OR UPDATE OF document_id, tenant_key ON public.rag_table_rows
  FOR EACH ROW EXECUTE FUNCTION public.rag_table_rows_guard();

-- Follow the document: SECURITY DEFINER because the role that updates a document (an owner, an ingest RPC) cannot write the server-only
-- table. Takes no caller input: reads only the transition rows, and writes only rows of documents whose is_current or status changed.
CREATE OR REPLACE FUNCTION public.rag_table_rows_follow_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.rag_table_rows r
     SET is_current = c.is_current, status = c.status
    FROM (
      SELECT n.id, n.tenant_key, n.is_current, n.status
        FROM old_rows o
        JOIN new_rows n ON n.id = o.id
       WHERE (o.is_current, o.status) IS DISTINCT FROM (n.is_current, n.status)
    ) c
   WHERE r.document_id = c.id
     AND r.tenant_key = c.tenant_key
     AND (r.is_current, r.status) IS DISTINCT FROM (c.is_current, c.status);
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_table_rows_follow_document() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_table_rows_follow_document() TO service_role;

DROP TRIGGER IF EXISTS rag_table_rows_follow_document ON public.documents;
CREATE TRIGGER rag_table_rows_follow_document
  AFTER UPDATE ON public.documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_table_rows_follow_document();

-- Purge hook (phase rule: every new 4.2 store): removes the rows of a purged lineage's documents, or of the listed documents in that tenant.
-- Returns the number of rows removed.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_table_rows(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_removed bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  DELETE FROM public.rag_table_rows r
  WHERE r.tenant_key = p_tenant_key
    AND (r.document_id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      OR r.document_id IN (SELECT d.id FROM public.documents d WHERE d.tenant_key = p_tenant_key AND d.lineage_id = p_lineage_id));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_table_rows(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_table_rows(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

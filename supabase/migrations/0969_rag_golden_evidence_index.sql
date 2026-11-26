-- 0969: rag_golden_evidence_index, the gold evidence spans of registered golden sets and their stale flag (Phase 5.3 D-48).
-- One row per (tenant_key, set_id, item_id, document_id, quote_sha256). The quote itself is never stored, only its sha256.
-- rag_golden_evidence_register replaces the rows of one set; the tenant comes only from p_tenant_key, checked first by
-- rag_assert_tenant_key (a key of the other deployment mode raises 22023), and a row is kept only when its document belongs to that
-- tenant; malformed rows and rows of other tenants are dropped and counted.
-- Two statement-level triggers on public.documents (transition tables, like 0603 and 0702) set needs_check when a registered document
-- changes is_current, superseded_by, status or tenant_key, or is deleted. Each returns before touching any row when no changed
-- document is registered, so tenants without a golden set pay one indexed probe per statement.
-- The trigger functions are SECURITY DEFINER (a document write by an authenticated owner must still flag the index, which only the
-- service role may write) and take no caller input; they are locked in section 1 of 0410. Every other function is SECURITY INVOKER.
-- Empty search_path everywhere; service_role only. Additive and idempotent. Not folded into the setup files (D-56).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_golden_evidence_index (
  tenant_key text NOT NULL,
  set_id text NOT NULL,
  item_id text NOT NULL,
  document_id uuid NOT NULL,
  quote_sha256 text NOT NULL,
  needs_check boolean NOT NULL DEFAULT false,
  registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_key, set_id, item_id, document_id, quote_sha256),
  CONSTRAINT rag_golden_evidence_index_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_golden_evidence_index_quote_sha256_check CHECK (quote_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rag_golden_evidence_index_set_id_check CHECK (pg_catalog.length(set_id) BETWEEN 1 AND 200),
  CONSTRAINT rag_golden_evidence_index_item_id_check CHECK (pg_catalog.length(item_id) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS rag_golden_evidence_index_document_id_idx ON public.rag_golden_evidence_index (document_id);
CREATE INDEX IF NOT EXISTS rag_golden_evidence_index_pending_idx
  ON public.rag_golden_evidence_index (tenant_key, set_id) WHERE needs_check;

ALTER TABLE public.rag_golden_evidence_index ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_golden_evidence_index FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_golden_evidence_index TO service_role;

CREATE OR REPLACE FUNCTION public.rag_golden_evidence_register(p_tenant_key text, p_set_id text, p_rows jsonb)
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
  IF p_set_id IS NULL OR pg_catalog.length(p_set_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid set id' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22023';
  END IF;

  v_total := pg_catalog.jsonb_array_length(p_rows);

  DELETE FROM public.rag_golden_evidence_index
  WHERE tenant_key = p_tenant_key
    AND set_id = p_set_id;

  INSERT INTO public.rag_golden_evidence_index (tenant_key, set_id, item_id, document_id, quote_sha256)
  SELECT DISTINCT p_tenant_key, p_set_id, r.item_id, r.document_id::uuid, r.quote_sha256
  FROM (
    SELECT e ->> 'item_id' AS item_id, e ->> 'document_id' AS document_id, e ->> 'quote_sha256' AS quote_sha256
    FROM pg_catalog.jsonb_array_elements(p_rows) AS e
    WHERE pg_catalog.jsonb_typeof(e) = 'object'
  ) r
  WHERE pg_catalog.length(r.item_id) BETWEEN 1 AND 200
    AND r.quote_sha256 ~ '^[0-9a-f]{64}$'
    AND r.document_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1
      FROM public.documents d
      WHERE d.id = r.document_id::uuid
        AND d.tenant_key = p_tenant_key
    );

  GET DIAGNOSTICS v_stored = ROW_COUNT;
  stored := v_stored;
  dropped := v_total - v_stored;
  RETURN NEXT;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_golden_evidence_pending(p_tenant_key text, p_set_id text)
RETURNS SETOF text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT DISTINCT i.item_id
  FROM public.rag_golden_evidence_index i
  WHERE i.tenant_key = p_tenant_key
    AND i.set_id = p_set_id
    AND i.needs_check
  ORDER BY i.item_id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_golden_evidence_clear(p_tenant_key text, p_set_id text, p_item_ids text[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF coalesce(pg_catalog.array_length(p_item_ids, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH cleared AS (
    UPDATE public.rag_golden_evidence_index i
    SET needs_check = false
    WHERE i.tenant_key = p_tenant_key
      AND i.set_id = p_set_id
      AND i.item_id = ANY (p_item_ids)
      AND i.needs_check
    RETURNING i.item_id
  )
  SELECT pg_catalog.count(DISTINCT c.item_id)::integer INTO v_count FROM cleared c;

  RETURN v_count;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_golden_evidence_on_documents_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.rag_golden_evidence_index i
    WHERE i.document_id IN (SELECT o.id FROM old_rows o)
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.rag_golden_evidence_index i
  SET needs_check = true
  WHERE NOT i.needs_check
    AND i.document_id IN (
      SELECT o.id
      FROM old_rows o
      JOIN new_rows n ON n.id = o.id
      WHERE o.is_current IS DISTINCT FROM n.is_current
         OR o.superseded_by IS DISTINCT FROM n.superseded_by
         OR o.status IS DISTINCT FROM n.status
         OR o.tenant_key IS DISTINCT FROM n.tenant_key
    );
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_golden_evidence_on_documents_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.rag_golden_evidence_index i
    WHERE i.document_id IN (SELECT o.id FROM old_rows o)
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.rag_golden_evidence_index i
  SET needs_check = true
  WHERE NOT i.needs_check
    AND i.document_id IN (SELECT o.id FROM old_rows o);
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS rag_golden_evidence_documents_update ON public.documents;
CREATE TRIGGER rag_golden_evidence_documents_update
  AFTER UPDATE ON public.documents
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_golden_evidence_on_documents_update();

DROP TRIGGER IF EXISTS rag_golden_evidence_documents_delete ON public.documents;
CREATE TRIGGER rag_golden_evidence_documents_delete
  AFTER DELETE ON public.documents
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_golden_evidence_on_documents_delete();

REVOKE ALL ON FUNCTION public.rag_golden_evidence_register(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_golden_evidence_pending(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_golden_evidence_clear(text, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_golden_evidence_on_documents_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_golden_evidence_on_documents_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_golden_evidence_register(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_golden_evidence_pending(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_golden_evidence_clear(text, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_golden_evidence_on_documents_update() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_golden_evidence_on_documents_delete() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

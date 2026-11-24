-- 0312: admin defaults for the document type (Phase 3, D-15).
-- One row per (tenant_key, source_kind, source_ref): the tenant-wide default, a default per source, and for Nango a default per
-- connection or per folder. doc_type is one of the six types or 'auto' (run auto-detection). The table is for the server role only:
-- RLS is on without policies and nothing is granted to anon or authenticated. It is read and written only through the three
-- functions below, which are SECURITY DEFINER, executable by service_role only, and always filtered by the tenant_key they are given.
-- Whoever may change a default is decided by the caller (the admin guard of the route); the database refuses everyone but the server role.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS rag_doc_type_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL CONSTRAINT rag_doc_type_defaults_kind_check CHECK (source_kind IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload')),
  source_ref text,
  doc_type text NOT NULL CONSTRAINT rag_doc_type_defaults_type_check CHECK (doc_type IN ('auto', 'general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image')),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_doc_type_defaults_ref_check CHECK (source_ref IS NULL OR (source_kind = 'nango' AND btrim(source_ref) <> '' AND length(source_ref) <= 200))
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_doc_type_defaults_scope_ux ON rag_doc_type_defaults (tenant_key, source_kind, (COALESCE(source_ref, '')));

ALTER TABLE rag_doc_type_defaults ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rag_doc_type_defaults FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE rag_doc_type_defaults TO service_role;

-- A tenant key is s:default in the single-tenant schema and u:<uuid> or o:<uuid> (lower case) in the multi-tenant one. Internal helper
-- of the three functions below; nobody else may call it.
CREATE OR REPLACE FUNCTION rag_doc_type_tenant_key_ok(p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL THEN
    RETURN false;
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    RETURN p_tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  END IF;
  RETURN p_tenant_key = 's:default';
END
$$;

-- The rows of one tenant. With p_source NULL: every row of the tenant (the admin list). With a source: the tenant default, the default of
-- that source, and for 'nango' the connection and folder rows whose ref equals p_connection_id or p_folder_id. Never another tenant's row.
CREATE OR REPLACE FUNCTION rag_get_doc_type_defaults(
  p_tenant_key text,
  p_source text,
  p_connection_id text,
  p_folder_id text
)
RETURNS TABLE (tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  RETURN QUERY
  SELECT d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at
  FROM rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key
    AND (
      p_source IS NULL
      OR d.source_kind = 'tenant'
      OR (d.source_kind = p_source AND (
        d.source_ref IS NULL
        OR (p_source = 'nango' AND d.source_ref IS NOT NULL AND (d.source_ref = p_connection_id OR d.source_ref = p_folder_id))
      ))
    )
  ORDER BY d.source_kind, d.source_ref NULLS FIRST;
END
$$;

-- Creates or replaces one default. updated_by is the actor (required), updated_at is set here.
CREATE OR REPLACE FUNCTION rag_set_doc_type_default(
  p_tenant_key text,
  p_source_kind text,
  p_source_ref text,
  p_doc_type text,
  p_updated_by text
)
RETURNS TABLE (tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  ref text := p_source_ref;
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('auto', 'general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image') THEN
    RAISE EXCEPTION 'invalid_doc_type';
  END IF;
  IF p_updated_by IS NULL OR btrim(p_updated_by) = '' THEN
    RAISE EXCEPTION 'actor_required';
  END IF;
  IF ref IS NOT NULL THEN
    ref := btrim(ref);
    IF p_source_kind <> 'nango' OR ref = '' OR length(ref) > 200 THEN
      RAISE EXCEPTION 'invalid_argument: source_ref is only for nango connection or folder ids';
    END IF;
  END IF;

  RETURN QUERY
  INSERT INTO rag_doc_type_defaults AS d (tenant_key, source_kind, source_ref, doc_type, updated_by, updated_at)
  VALUES (p_tenant_key, p_source_kind, ref, p_doc_type, btrim(p_updated_by), now())
  ON CONFLICT (tenant_key, source_kind, (COALESCE(source_ref, '')))
  DO UPDATE SET doc_type = EXCLUDED.doc_type, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
  RETURNING d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at;
END
$$;

-- Removes one default of the tenant; false when there was none.
CREATE OR REPLACE FUNCTION rag_delete_doc_type_default(
  p_tenant_key text,
  p_source_kind text,
  p_source_ref text
)
RETURNS TABLE (deleted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  removed integer;
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  DELETE FROM rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key AND d.source_kind = p_source_kind AND COALESCE(d.source_ref, '') = COALESCE(btrim(p_source_ref), '');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN QUERY SELECT removed > 0;
END
$$;

REVOKE ALL ON FUNCTION rag_doc_type_tenant_key_ok(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_get_doc_type_defaults(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_set_doc_type_default(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_delete_doc_type_default(text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_get_doc_type_defaults(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_set_doc_type_default(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_delete_doc_type_default(text, text, text) TO service_role;

COMMIT;

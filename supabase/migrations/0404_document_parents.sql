-- 0404: parent storage, child profile columns, variant-status invariant, rag_fetch_parents (D-20, D-21).

BEGIN;

CREATE TABLE IF NOT EXISTS document_parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  organization_id uuid,
  version integer,
  is_current boolean NOT NULL DEFAULT true,
  chunking_profile_id text NOT NULL,
  section_path text[] NOT NULL DEFAULT '{}',
  content text NOT NULL,
  token_count integer NOT NULL CONSTRAINT document_parents_token_count_check CHECK (token_count >= 0),
  parent_index integer NOT NULL CONSTRAINT document_parents_parent_index_check CHECK (parent_index >= 0)
);

CREATE INDEX IF NOT EXISTS idx_document_parents_tenant_id ON document_parents (tenant_key, id);
CREATE INDEX IF NOT EXISTS idx_document_parents_document_profile ON document_parents (document_id, chunking_profile_id);

ALTER TABLE document_parents ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON TABLE document_parents FROM anon, authenticated;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES document_parents (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chunking_profile_id text NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_document_chunks_parent_id ON document_chunks (parent_id);

DO $$
DECLARE
  status_attnum smallint;
  check_name text;
BEGIN
  SELECT attnum INTO status_attnum
  FROM pg_attribute
  WHERE attrelid = to_regclass('public.document_chunks') AND attname = 'status' AND NOT attisdropped;
  FOR check_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = to_regclass('public.document_chunks') AND contype = 'c' AND conkey @> ARRAY[status_attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.document_chunks DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

ALTER TABLE document_chunks
  ADD CONSTRAINT document_chunks_status_check
  CHECK (status IN ('processing', 'ready', 'variant', 'quarantined', 'failed', 'deleted'));

CREATE OR REPLACE FUNCTION public.rag_chunks_profile_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.chunking_profile_id IS DISTINCT FROM 'legacy' AND NEW.status = 'ready' THEN
    NEW.status := 'variant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rag_chunks_profile_status ON document_chunks;
CREATE TRIGGER rag_chunks_profile_status
  BEFORE INSERT OR UPDATE OF status, chunking_profile_id ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunks_profile_status();

REVOKE ALL ON FUNCTION public.rag_chunks_profile_status() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rag_fetch_parents(p_tenant_key text, p_parent_ids uuid[])
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  version integer,
  is_current boolean,
  chunking_profile_id text,
  section_path text[],
  content text,
  token_count integer,
  parent_index integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF coalesce(cardinality(p_parent_ids), 0) > 200 THEN
    RAISE EXCEPTION 'too many parent ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT
    p.id,
    p.document_id,
    p.tenant_key,
    p.version,
    p.is_current,
    p.chunking_profile_id,
    p.section_path,
    p.content,
    p.token_count,
    p.parent_index
  FROM document_parents p
  WHERE p.tenant_key = p_tenant_key
    AND p.is_current
    AND p.id = ANY(p_parent_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.rag_fetch_parents(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fetch_parents(text, uuid[]) TO service_role;

COMMIT;
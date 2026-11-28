-- 0851: Phase 4.2 lexical dictionary fingerprint per chunk (LANG-07, D-09, D-42).
-- document_chunks.lexical_dict_version records the effective TERM dictionary version (s<shared> or s<shared>.w<tenant>) that the chunk's
-- lexical_text was built with; null means no dictionary. The ingestion and relex writers carry it as the chunk metadata key
-- lexical_dict_version, like lexical_version today. A separate row trigger copies a well-formed key into the column; a write without the key
-- leaves the column as it was and a malformed value is ignored. The lexical trigger (rag_chunks_lexical_tsv) and rag_write_chunks are not
-- redefined here. Existing rows keep null. Purge: the column holds a version string only, no content, so it has no purge hook.
-- Idempotent; not folded into the setup files.

BEGIN;

ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS lexical_dict_version text;

-- Touches only NEW, so SECURITY INVOKER (D-56).
CREATE OR REPLACE FUNCTION public.rag_chunk_lexical_dict_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_value text;
BEGIN
  IF NEW.metadata IS NULL OR pg_catalog.jsonb_typeof(NEW.metadata) <> 'object' THEN
    RETURN NEW;
  END IF;
  IF pg_catalog.jsonb_typeof(NEW.metadata -> 'lexical_dict_version') IS DISTINCT FROM 'string' THEN
    RETURN NEW;
  END IF;
  v_value := NEW.metadata ->> 'lexical_dict_version';
  IF v_value ~ '^s[0-9]{1,9}(\.w[0-9]{1,9})?$' THEN
    NEW.lexical_dict_version := v_value;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_chunk_lexical_dict_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_lexical_dict_version() TO service_role;

DROP TRIGGER IF EXISTS rag_chunk_lexical_dict_version ON public.document_chunks;
CREATE TRIGGER rag_chunk_lexical_dict_version
  BEFORE INSERT OR UPDATE OF metadata ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunk_lexical_dict_version();

NOTIFY pgrst, 'reload schema';

COMMIT;

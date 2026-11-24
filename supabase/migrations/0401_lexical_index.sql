-- 0401: Lexical index over application tokenizer output (Phase 4, D-08, RET-03).
-- Plain nullable lexical_tsv and lexical_version columns with a trigger (not a stored generated column) so the HNSW index is not rewritten.
-- Verbatim tsvector/tsquery builders avoid the Postgres text parser (F-1). No row backfill here; rag:relex fills batches (0402).
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, CREATE INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS.

BEGIN;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS lexical_tsv tsvector,
  ADD COLUMN IF NOT EXISTS lexical_version integer;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsvector(p_lexical_text text) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT coalesce(string_agg(quote_literal(t.tok) || ':' || least(t.ord, 16383)::text, ' ' ORDER BY t.ord), '')::tsvector
  FROM unnest(string_to_array(coalesce(p_lexical_text, ''), ' ')) WITH ORDINALITY AS t(tok, ord)
  WHERE t.tok <> '' AND octet_length(t.tok) <= 255 AND t.tok !~ '[''\\[:space:]]'
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsquery(p_tokens text[]) RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT NULLIF(string_agg(quote_literal(t.tok), ' | '), '')::tsquery
  FROM (
    SELECT DISTINCT tok
    FROM unnest(coalesce(p_tokens, '{}'::text[])) AS u(tok)
    WHERE tok <> '' AND octet_length(tok) <= 255 AND tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t
$fn$;

CREATE OR REPLACE FUNCTION public.rag_chunks_lexical_tsv() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_meta_version text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.lexical_text IS DISTINCT FROM OLD.lexical_text THEN
    NEW.lexical_tsv := public.rag_lexical_tsvector(NEW.lexical_text);
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    ELSE
      NEW.lexical_version := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_document_chunks_lexical_tsv ON document_chunks;
CREATE TRIGGER trg_document_chunks_lexical_tsv
  BEFORE INSERT OR UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunks_lexical_tsv();

CREATE INDEX IF NOT EXISTS idx_document_chunks_lexical_tsv ON document_chunks USING gin (lexical_tsv);
CREATE INDEX IF NOT EXISTS idx_document_chunks_lexical_version ON document_chunks (lexical_version);

REVOKE ALL ON FUNCTION public.rag_lexical_tsvector(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexical_tsquery(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_chunks_lexical_tsv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_lexical_tsvector(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexical_tsquery(text[]) TO service_role;

COMMIT;
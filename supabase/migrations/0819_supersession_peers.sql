-- 0819: Bounded reads for the supersession detector and the "Replaces..." upload field (plan 03.2-45; D-41; DATA-19).
-- rag_supersession_peers(p_tenant_key, p_document_id, p_limit, p_text_documents, p_max_chars) returns the published document itself (is_self)
-- and the most recent current, ready documents of the same tenant and doc type outside its lineage, at most p_limit of them. Stored content
-- is returned cut to p_max_chars, only for the document itself and the first p_text_documents peers; every other row carries no text.
-- rag_supersession_replace_target(p_tenant_key, p_document_id) returns the lineage and source identity of a current, ready document of the
-- tenant, or no row. The tenant key is the only tenant input and is asserted first; nothing here writes.
-- Both functions are SECURITY INVOKER, SET search_path = '', revoked from PUBLIC, anon and authenticated, executable by service_role only.
-- Not folded into the setup files. Idempotent: CREATE OR REPLACE.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_supersession_peers(
  p_tenant_key text,
  p_document_id uuid,
  p_limit integer,
  p_text_documents integer,
  p_max_chars integer
)
 RETURNS TABLE(
   is_self boolean, document_id uuid, lineage_id uuid, filename text, doc_type text, language text, doc_date date, effective_from date,
   content_hash text, uploader_id uuid, created_at timestamp with time zone, replaces jsonb, content text
 )
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  self public.documents%ROWTYPE;
  peer_limit integer := LEAST(GREATEST(COALESCE(p_limit, 0), 0), 500);
  text_limit integer := LEAST(GREATEST(COALESCE(p_text_documents, 0), 0), 50);
  max_chars integer := LEAST(GREATEST(COALESCE(p_max_chars, 0), 0), 100000);
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT * INTO self FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT true, self.id, self.lineage_id, self.filename, self.doc_type, self.language, self.doc_date, self.effective_from, self.content_hash,
         self.user_id, self.created_at, self.metadata -> 'supersession_replaces',
         CASE WHEN text_limit > 0 AND max_chars > 0 THEN pg_catalog.left(self.content, max_chars) END;

  RETURN QUERY
  SELECT false, p.id, p.lineage_id, p.filename, p.doc_type, p.language, p.doc_date, p.effective_from, p.content_hash, p.user_id, p.created_at,
         NULL::jsonb,
         CASE WHEN p.rn <= text_limit AND max_chars > 0 THEN pg_catalog.left(p.content, max_chars) END
  FROM (
    SELECT d.id, d.lineage_id, d.filename, d.doc_type, d.language, d.doc_date, d.effective_from, d.content_hash, d.user_id, d.created_at,
           d.content, pg_catalog.row_number() OVER (ORDER BY d.created_at DESC, d.id) AS rn
    FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready' AND d.doc_type = self.doc_type
      AND d.id <> self.id AND d.lineage_id IS DISTINCT FROM self.lineage_id
    ORDER BY d.created_at DESC, d.id
    LIMIT peer_limit
  ) p
  ORDER BY p.rn;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_supersession_replace_target(p_tenant_key text, p_document_id uuid)
 RETURNS TABLE(document_id uuid, lineage_id uuid, source text, source_key text)
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT d.id, d.lineage_id, d.source, d.source_key FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready';
END
$function$;

REVOKE ALL ON FUNCTION public.rag_supersession_peers(text, uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_supersession_peers(text, uuid, integer, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_supersession_replace_target(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_supersession_replace_target(text, uuid) TO service_role;

COMMIT;

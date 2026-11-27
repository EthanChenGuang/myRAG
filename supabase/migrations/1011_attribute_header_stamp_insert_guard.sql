-- 1011: attribute header stamp insert guard on document_chunks (03.3 verification G8, security F-2, T-03.3-1504).
-- rag_chunk_attribute_header_stamp (1006) copies metadata.attribute_header_stamp into the column on INSERT, and the 1001 column guard
-- covers UPDATE only, so a non-service role inserting a chunk row could choose its stamp (in the metadata key or the column itself).
-- This trigger runs after the 1006 stamp trigger (trigger names fire in name order) and clears the column on INSERT unless the role
-- is service_role, postgres or supabase_admin, like the 1005 documents insert guard. The service-role writers keep their stamps.
-- Same body in both deployment modes; idempotent; SECURITY INVOKER (touches only NEW); service_role only.

CREATE OR REPLACE FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    NEW.attribute_header_stamp := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS rag_chunk_attribute_header_stamp_x_insert_guard ON public.document_chunks;
CREATE TRIGGER rag_chunk_attribute_header_stamp_x_insert_guard
  BEFORE INSERT ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard();

REVOKE ALL ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_attribute_header_stamp_insert_guard() TO service_role;

-- 0724 (multi-tenant): tenant-bounded chat scrub and leftover count for a purge (Phase 6.3, D-13, D-16, D-36, D-37, D-43).
-- The bound follows 0502's tenant-key mapping: o:<organization_id> is that organization's chats, u:<user_id> is the
-- user's personal chats (organization_id IS NULL). A chat is rewritten only when the jsonb predicate finds a purged
-- document id or a picture link of the lineage (Pitfall 11). Service_role only. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_purge_scrub_chats(
  p_tenant_key text,
  p_lineage_id uuid,
  p_document_ids uuid[],
  p_withdrawn_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids text[];
  v_pattern text;
  v_owner uuid;
  v_count integer := 0;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL OR p_withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_pattern := public.rag_purge_image_pattern(p_tenant_key, p_lineage_id);
  v_ids := ARRAY(SELECT DISTINCT x::text FROM unnest(COALESCE(p_document_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
  v_owner := substr(p_tenant_key, 3)::uuid;

  IF left(p_tenant_key, 2) = 'o:' THEN
    UPDATE public.chats c
       SET messages = public.rag_withdrawn_chat_messages(c.messages, v_ids, v_pattern, p_withdrawn_at)
     WHERE c.organization_id = v_owner
       AND public.rag_chat_messages_reference(c.messages, v_ids, v_pattern);
  ELSE
    UPDATE public.chats c
       SET messages = public.rag_withdrawn_chat_messages(c.messages, v_ids, v_pattern, p_withdrawn_at)
     WHERE c.user_id = v_owner
       AND c.organization_id IS NULL
       AND public.rag_chat_messages_reference(c.messages, v_ids, v_pattern);
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_purge_citation_leftovers(p_tenant_key text, p_document_ids uuid[])
RETURNS TABLE (store text, remaining bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids text[];
  v_owner uuid;
  v_org boolean;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  v_ids := ARRAY(SELECT DISTINCT x::text FROM unnest(COALESCE(p_document_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
  v_owner := substr(p_tenant_key, 3)::uuid;
  v_org := left(p_tenant_key, 2) = 'o:';

  RETURN QUERY
  SELECT 'answer_citations'::text,
         COALESCE(sum(public.rag_citation_leftover_count(r.citations, v_ids)), 0)::bigint
    FROM public.rag_answer_records r
   WHERE r.tenant_key = p_tenant_key
  UNION ALL
  SELECT 'chat_messages'::text,
         COALESCE(sum(public.rag_chat_messages_leftover_count(c.messages, v_ids)), 0)::bigint
    FROM public.chats c
   WHERE (v_org AND c.organization_id = v_owner)
      OR (NOT v_org AND c.user_id = v_owner AND c.organization_id IS NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_citation_leftovers(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_citation_leftovers(text, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

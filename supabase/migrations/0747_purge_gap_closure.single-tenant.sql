-- 0747 (single-tenant): the chat scrub of 0724 with picture URL hashes, and the picture leftover count; every chat is in
-- bound (one tenant, s:default).
-- Picture URLs are matched by the lineage prefix (0724) or by a SHA-256 from the versions' chunks or the newest purge record of the
-- lineage, so a re-scrub after the purge still finds an image_upload link (T-06.3-26). Service_role only. Idempotent; re-run after 0724.

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
  v_hashes text[];
  v_count integer := 0;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL OR p_withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_pattern := public.rag_purge_image_pattern(p_tenant_key, p_lineage_id);
  v_hashes := ARRAY(
    SELECT DISTINCT h FROM (
      SELECT pg_catalog.unnest(public.rag_purge_image_url_hashes(p_document_ids)) AS h
      UNION
      SELECT pg_catalog.unnest(a.image_url_sha256) FROM (
        SELECT x.image_url_sha256 FROM public.rag_purge_audit x
         WHERE x.tenant_key = p_tenant_key AND x.lineage_id = p_lineage_id
         ORDER BY x.started_at DESC, x.id DESC LIMIT 1
      ) AS a
    ) AS hs ORDER BY h
  );
  v_ids := ARRAY(SELECT DISTINCT x::text FROM unnest(COALESCE(p_document_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);

  UPDATE public.chats c
     SET messages = public.rag_withdrawn_chat_messages(c.messages, v_ids, v_pattern, p_withdrawn_at, v_hashes)
   WHERE public.rag_chat_messages_reference(c.messages, v_ids, v_pattern, v_hashes);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_purge_chat_image_leftovers(p_tenant_key text, p_lineage_id uuid, p_image_hashes text[])
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pattern text;
  v_count bigint := 0;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_pattern := public.rag_purge_image_pattern(p_tenant_key, p_lineage_id);
  SELECT COALESCE(sum(public.rag_chat_image_leftover_count(c.messages, v_pattern, p_image_hashes)), 0)::bigint INTO v_count
    FROM public.chats c;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_chat_image_leftovers(text, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_chat_image_leftovers(text, uuid, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

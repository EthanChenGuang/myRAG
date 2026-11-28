-- Train 40 live SQL (ci/merge-train-40, PR #140). Apply after train 39 (0982, 0983, 0985, 1010, 0410 r22), 0989 (#138) and 0991 are live. Multi-tenant production.
-- Order: 0723, 0724 (common, then its .multi-tenant file), 0726, 0727, 0986, 0988, then the 0410 r23 delta (grants only).
-- A single-tenant project applies 0724_purge_citation_scrub.single-tenant.sql instead of the .multi-tenant file; nothing else differs.
-- Dependencies:
--   0723 (06.3-07/06.3-27, source recheck): rag_assert_tenant_key, documents and document_chunks with tenant_key, status, is_current.
--   0724 (06.3-10, citation scrub): chats and rag_answer_records (0501); the mode file defines rag_purge_scrub_chats and
--        rag_purge_citation_leftovers for the chats layout of the mode.
--   0726 before 0727 (06.3-15, purge audit and lineage): 0727's rag_purge_lineage writes rag_purge_audit (0726). It calls the vector-sync
--        purge seam (0740, live since train 34) and the foreign-store seam (0728, plan 06.3-19, not in this train) only when
--        to_regprocedure finds them.
--   0986 (quick-doc-types-access): after 0981 (rag_tenant_doc_types) and 0933 (rag_access_readiness, which 0986 replaces with a superset
--        that also checks rag_tenant_doc_types).
--   0988 (quick-review-writers-access, renumbered from 0986 in train 40): after 0967, 0974 and 0984 (rag_review_access_sets). Re-running
--        0967 or 0974 later restores their old writer bodies: re-run 0988 after them.
-- 0410 is not re-run: the delta below repeats only the guarded lines train 40 adds to it (r23).
-- App compatibility: every function is new except rag_tenant_doc_types (0986 appends p_access_keys text[] and p_access_all boolean with
--   defaults, so the train-39 app keeps calling it by name), rag_access_readiness (same signature) and the two review writers (0988, same
--   signatures; rows may carry optional keys the train-39 app does not send). Apply this SQL before deploying the train-40 app.
-- DROP sections (each followed by a re-create in the same transaction):
--   0723: DROP FUNCTION IF EXISTS public.rag_source_recheck(text, uuid[]) (new function; re-created right after).
--   0726: DROP TRIGGER IF EXISTS rag_purge_audit_guard and rag_purge_audit_no_truncate ON public.rag_purge_audit (new table; each trigger
--         is re-created right after).
--   0986: DO block drops every overload of rag_tenant_doc_types by catalog lookup (the 0981 signature (text)); exactly one is re-created
--         with the two access parameters.
--   0724, 0727 and 0988 have no DROP.
-- Operational notes:
--   0726 adds rag_purge_audit (RLS on, service_role only; guard triggers refuse DELETE and
--   TRUNCATE and allow UPDATE only of the finish columns, through rag_purge_audit_finish). It starts
--   empty. Nothing in this train calls rag_purge_lineage from the app; purge stays a manual, admin-started operation.
--   0988 backfills access_sets of existing review items from their retrieval log row only while rag_access_enforced() is true; with
--   access groups off it changes no row.
--   After 0986, rag_access_readiness() must report ready.

-- ==== supabase/migrations/0723_source_recheck.sql
-- 0723: Phase 6.3 source recheck (RET-14, D-19, D-43).
-- rag_source_recheck returns the ids among p_chunk_ids whose chunk and document belong to the caller's tenant, whose document is
-- current and ready, and whose chunk is current and ready or variant: a quarantined, failed, deleted or superseded row is not
-- returned, nor is a soft-deleted document. It checks currency only; chunking-profile servability stays with the search RPCs, so an
-- eval chunking override or a legacy-fallback chunk the search returned is kept. The tenant comes only from p_tenant_key, checked by
-- rag_assert_tenant_key; at most 500 ids per call. SECURITY DEFINER (D-02), service role only.
-- Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_source_recheck(text, uuid[]);

CREATE FUNCTION public.rag_source_recheck(p_tenant_key text, p_chunk_ids uuid[])
RETURNS TABLE (chunk_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF COALESCE(pg_catalog.cardinality(p_chunk_ids), 0) > 500 THEN
    RAISE EXCEPTION 'invalid_argument: rag_source_recheck takes at most 500 ids' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(pg_catalog.cardinality(p_chunk_ids), 0) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id
    FROM public.document_chunks c
    JOIN public.documents d ON d.id = c.document_id
   WHERE c.id = ANY(p_chunk_ids)
     AND c.tenant_key = p_tenant_key
     AND d.tenant_key = p_tenant_key
     AND c.is_current
     AND c.status IN ('ready', 'variant')
     AND d.is_current
     AND d.status = 'ready'
   ORDER BY c.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_source_recheck(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_source_recheck(text, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0724_purge_citation_scrub.sql
-- 0724: Withdrawn marker for stored citations of purged versions (Phase 6.3, D-13, D-36, D-37).
-- A marker keeps n, alias, chunkIds, documentId, documentVersion and strategy, and replaces everything derived
-- from the withdrawn content: quote '', quoteHash the SHA-256 of '', documentName '', page and sectionPath null,
-- withdrawn true, withdrawnAt the purge time. It validates as the generated CitationRecordSchema (plan 06.3-01).
-- This file holds the marker builders, the chat-message rewriters and the answer-record scrub; the tenant-bounded
-- chat scrub and the leftover count live in the mode files. All functions are service_role only. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_withdrawn_citation(p_citation jsonb, p_withdrawn_at timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_citation IS NULL OR jsonb_typeof(p_citation) <> 'object' THEN p_citation
    ELSE jsonb_strip_nulls(jsonb_build_object(
           'n', p_citation -> 'n',
           'alias', p_citation -> 'alias',
           'chunkIds', COALESCE(p_citation -> 'chunkIds', '[]'::jsonb),
           'documentId', p_citation -> 'documentId',
           'strategy', p_citation -> 'strategy'
         ))
         || jsonb_build_object(
           'documentVersion', COALESCE(p_citation -> 'documentVersion', 'null'::jsonb),
           'documentName', '',
           'page', NULL,
           'sectionPath', NULL,
           'quote', '',
           'quoteHash', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
           'withdrawn', true,
           'withdrawnAt', to_char(COALESCE(p_withdrawn_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         )
  END
$$;

-- Rewrites the citation elements of the given document ids into markers (in original order), leaves elements that
-- are already withdrawn as they are, and drops alsoIn entries that name a purged document from other citations.
CREATE OR REPLACE FUNCTION public.rag_withdrawn_citations(p_citations jsonb, p_document_ids text[], p_withdrawn_at timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_citations IS NULL OR jsonb_typeof(p_citations) <> 'array' THEN p_citations
    ELSE COALESCE((
      SELECT jsonb_agg(
               CASE
                 WHEN jsonb_typeof(e.value) <> 'object' THEN e.value
                 WHEN (e.value ->> 'documentId') = ANY(p_document_ids)
                   THEN CASE WHEN e.value -> 'withdrawn' = 'true'::jsonb THEN e.value
                             ELSE public.rag_withdrawn_citation(e.value, p_withdrawn_at) END
                 WHEN a.hit THEN CASE WHEN a.kept IS NULL THEN e.value - 'alsoIn' ELSE jsonb_set(e.value, '{alsoIn}', a.kept) END
                 ELSE e.value
               END
               ORDER BY e.ordinality)
        FROM jsonb_array_elements(p_citations) WITH ORDINALITY e
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(d.value ORDER BY d.ordinality)
                   FILTER (WHERE NOT COALESCE((d.value ->> 'documentId') = ANY(p_document_ids), false)) AS kept,
                 COALESCE(bool_or(COALESCE((d.value ->> 'documentId') = ANY(p_document_ids), false)), false) AS hit
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.value -> 'alsoIn') = 'array' THEN e.value -> 'alsoIn' ELSE '[]'::jsonb END)
                 WITH ORDINALITY d
        ) a ON true
    ), '[]'::jsonb)
  END
$$;

-- usedDocuments / documents entries of a purged document: text, name and links removed, withdrawn set; other keys kept.
CREATE OR REPLACE FUNCTION public.rag_withdrawn_document_refs(p_entries jsonb, p_document_ids text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN p_entries
    ELSE COALESCE((
      SELECT jsonb_agg(
               CASE
                 WHEN jsonb_typeof(e.value) = 'object'
                  AND (e.value ->> 'id') = ANY(p_document_ids)
                  AND e.value -> 'withdrawn' IS DISTINCT FROM 'true'::jsonb
                   THEN (e.value - 'filename' - 'image_url' - 'url' - 'content' - 'text' - 'snippet')
                        || jsonb_build_object('name', '', 'content_preview', '', 'matched_chunk', '', 'withdrawn', true)
                 ELSE e.value
               END
               ORDER BY e.ordinality)
        FROM jsonb_array_elements(p_entries) WITH ORDINALITY e
    ), '[]'::jsonb)
  END
$$;

-- The regex a public page-picture URL of the lineage matches: rag/<tenant>/<lineage>/, with the ':' of the tenant
-- key raw or percent-encoded. Tenant key and lineage are validated, so the pattern holds no caller text.
CREATE OR REPLACE FUNCTION public.rag_purge_image_pattern(p_tenant_key text, p_lineage_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN '(^|/)rag/' || replace(p_tenant_key, ':', '(:|%3[aA])') || '/' || p_lineage_id::text || '/';
END;
$$;

-- Rewrites one chats.messages array: metadata.citations to markers, usedDocuments / documents entries blanked,
-- source_images / images entries under the lineage's picture prefix dropped. Every other part is unchanged.
CREATE OR REPLACE FUNCTION public.rag_withdrawn_chat_messages(
  p_messages jsonb,
  p_document_ids text[],
  p_image_pattern text,
  p_withdrawn_at timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_messages IS NULL OR jsonb_typeof(p_messages) <> 'array' THEN p_messages
    ELSE COALESCE((
      SELECT jsonb_agg(
               CASE
                 WHEN jsonb_typeof(m.value) <> 'object' THEN m.value
                 ELSE m.value
                   || CASE WHEN jsonb_typeof(m.value -> 'metadata') = 'object' AND jsonb_typeof(m.value -> 'metadata' -> 'citations') = 'array'
                        THEN jsonb_build_object('metadata', jsonb_set(m.value -> 'metadata', '{citations}',
                               public.rag_withdrawn_citations(m.value -> 'metadata' -> 'citations', p_document_ids, p_withdrawn_at)))
                        ELSE '{}'::jsonb END
                   || CASE WHEN jsonb_typeof(m.value -> 'content') = 'array'
                        THEN jsonb_build_object('content', COALESCE((
                          SELECT jsonb_agg(
                                   CASE
                                     WHEN jsonb_typeof(p.value) <> 'object' THEN p.value
                                     ELSE p.value
                                       || CASE WHEN jsonb_typeof(p.value -> 'usedDocuments') = 'array'
                                            THEN jsonb_build_object('usedDocuments', public.rag_withdrawn_document_refs(p.value -> 'usedDocuments', p_document_ids))
                                            ELSE '{}'::jsonb END
                                       || CASE WHEN jsonb_typeof(p.value -> 'documents') = 'array'
                                            THEN jsonb_build_object('documents', public.rag_withdrawn_document_refs(p.value -> 'documents', p_document_ids))
                                            ELSE '{}'::jsonb END
                                       || CASE WHEN jsonb_typeof(p.value -> 'source_images') = 'array'
                                            THEN jsonb_build_object('source_images', COALESCE((
                                              SELECT jsonb_agg(i.value ORDER BY i.ordinality)
                                                FROM jsonb_array_elements(p.value -> 'source_images') WITH ORDINALITY i
                                               WHERE COALESCE(i.value ->> 'url', '') !~ p_image_pattern), '[]'::jsonb))
                                            ELSE '{}'::jsonb END
                                       || CASE WHEN jsonb_typeof(p.value -> 'images') = 'array'
                                            THEN jsonb_build_object('images', COALESCE((
                                              SELECT jsonb_agg(i.value ORDER BY i.ordinality)
                                                FROM jsonb_array_elements(p.value -> 'images') WITH ORDINALITY i
                                               WHERE COALESCE(i.value ->> 'url', '') !~ p_image_pattern), '[]'::jsonb))
                                            ELSE '{}'::jsonb END
                                   END
                                   ORDER BY p.ordinality)
                            FROM jsonb_array_elements(m.value -> 'content') WITH ORDINALITY p
                        ), '[]'::jsonb))
                        ELSE '{}'::jsonb END
               END
               ORDER BY m.ordinality)
        FROM jsonb_array_elements(p_messages) WITH ORDINALITY m
    ), '[]'::jsonb)
  END
$$;

-- Unflagged citation elements of the ids in one citations array, plus alsoIn entries that still name one of them.
CREATE OR REPLACE FUNCTION public.rag_citation_leftover_count(p_citations jsonb, p_document_ids text[])
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_citations IS NULL OR jsonb_typeof(p_citations) <> 'array' THEN 0::bigint
    ELSE (SELECT count(*) FROM jsonb_path_query(p_citations,
            'lax $[*] ? (@.documentId == $ids[*] && !(@.withdrawn == true))',
            jsonb_build_object('ids', to_jsonb(p_document_ids))))
       + (SELECT count(*) FROM jsonb_path_query(p_citations,
            'lax $[*] ? (!(@.documentId == $ids[*])).alsoIn[*] ? (@.documentId == $ids[*])',
            jsonb_build_object('ids', to_jsonb(p_document_ids))))
  END
$$;

-- Unflagged citations (metadata.citations) and used-document entries (usedDocuments, documents) of the ids in one
-- chats.messages array.
CREATE OR REPLACE FUNCTION public.rag_chat_messages_leftover_count(p_messages jsonb, p_document_ids text[])
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_messages IS NULL OR jsonb_typeof(p_messages) <> 'array' THEN 0::bigint
    ELSE COALESCE((
      SELECT sum(public.rag_citation_leftover_count(m.value -> 'metadata' -> 'citations', p_document_ids))
        FROM jsonb_array_elements(p_messages) m
       WHERE jsonb_typeof(m.value) = 'object' AND jsonb_typeof(m.value -> 'metadata') = 'object'
    ), 0)::bigint
       + (SELECT count(*) FROM jsonb_path_query(p_messages,
            'lax $[*].content[*].usedDocuments[*] ? (@.id == $ids[*] && !(@.withdrawn == true))',
            jsonb_build_object('ids', to_jsonb(p_document_ids))))
       + (SELECT count(*) FROM jsonb_path_query(p_messages,
            'lax $[*].content[*].documents[*] ? (@.id == $ids[*] && !(@.withdrawn == true))',
            jsonb_build_object('ids', to_jsonb(p_document_ids))))
  END
$$;

-- The jsonb predicate the chat scrub tests before rewriting (Pitfall 11): an unflagged citation, alsoIn entry or
-- used-document entry of one of the ids, or a picture link under the lineage's prefix.
CREATE OR REPLACE FUNCTION public.rag_chat_messages_reference(p_messages jsonb, p_document_ids text[], p_image_pattern text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_messages IS NOT NULL AND jsonb_typeof(p_messages) = 'array' AND (
    public.rag_chat_messages_leftover_count(p_messages, p_document_ids) > 0
    OR EXISTS (
      SELECT 1
        FROM jsonb_path_query(p_messages, 'lax $[*].content[*].source_images[*].url') u
       WHERE jsonb_typeof(u) = 'string' AND (u #>> '{}') ~ p_image_pattern)
    OR EXISTS (
      SELECT 1
        FROM jsonb_path_query(p_messages, 'lax $[*].content[*].images[*].url') u
       WHERE jsonb_typeof(u) = 'string' AND (u #>> '{}') ~ p_image_pattern)
  )
$$;

-- Rewrites the purged tenant's answer-record citations of the version ids; returns the number of rewritten elements.
CREATE OR REPLACE FUNCTION public.rag_purge_scrub_answer_records(
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
  v_count bigint := 0;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL OR p_withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT x::text FROM unnest(COALESCE(p_document_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
  IF cardinality(v_ids) = 0 THEN
    RETURN 0;
  END IF;

  WITH hit AS (
    SELECT r.id,
           (SELECT count(*) FROM jsonb_path_query(r.citations,
              'lax $[*] ? (@.documentId == $ids[*] && !(@.withdrawn == true))',
              jsonb_build_object('ids', to_jsonb(v_ids)))) AS n
      FROM public.rag_answer_records r
     WHERE r.tenant_key = p_tenant_key
       AND jsonb_typeof(r.citations) = 'array'
       AND public.rag_citation_leftover_count(r.citations, v_ids) > 0
       FOR UPDATE
  ), updated AS (
    UPDATE public.rag_answer_records r
       SET citations = public.rag_withdrawn_citations(r.citations, v_ids, p_withdrawn_at),
           updated_at = now()
      FROM hit
     WHERE r.id = hit.id
    RETURNING hit.n
  )
  SELECT COALESCE(sum(updated.n), 0) INTO v_count FROM updated;

  RETURN v_count::integer;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_withdrawn_citation(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_withdrawn_citation(jsonb, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rag_withdrawn_citations(jsonb, text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_withdrawn_citations(jsonb, text[], timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rag_withdrawn_document_refs(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_withdrawn_document_refs(jsonb, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_image_pattern(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_image_pattern(text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_citation_leftover_count(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_citation_leftover_count(jsonb, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_chat_messages_leftover_count(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chat_messages_leftover_count(jsonb, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0724_purge_citation_scrub.multi-tenant.sql
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

-- ==== supabase/migrations/0726_purge_audit.sql
-- 0726: Purge audit records (DATA-24, D-12, D-16, D-35). One row per lineage purge, written by rag_purge_lineage (0727) in the
-- purge transaction. Ids and hashes only: version ids, file_sha256 values, the SHA-256 of the source key, the Nango connection id,
-- the actor id, a reason code and an optional note of at most 500 characters; never a title, file name or text of the content.
-- No foreign key, so a record outlives the documents it names. RLS on with no policy; service_role may only SELECT. Updates go
-- through rag_purge_audit_finish and touch only the finish columns; deletes and truncates are refused.
-- Additive and idempotent, not folded into the setup files.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_purge_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  lineage_id uuid NOT NULL,
  version_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  file_sha256_values text[] NOT NULL DEFAULT '{}'::text[],
  source text,
  source_key_sha256 text,
  source_connection_id text,
  actor_kind text NOT NULL,
  actor_id uuid NOT NULL,
  reason_code text NOT NULL,
  reason_note text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  object_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification jsonb,
  verification_checked_at timestamptz,
  pending_object_paths text[] NOT NULL DEFAULT '{}'::text[],
  result text,
  CONSTRAINT rag_purge_audit_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_purge_audit_actor_kind_check CHECK (actor_kind IN ('admin', 'source_sync')),
  CONSTRAINT rag_purge_audit_reason_code_check CHECK (
    reason_code IN ('owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other', 'source_deleted')
  ),
  CONSTRAINT rag_purge_audit_reason_note_check CHECK (reason_note IS NULL OR char_length(reason_note) <= 500),
  CONSTRAINT rag_purge_audit_other_note_check CHECK (reason_code <> 'other' OR (reason_note IS NOT NULL AND btrim(reason_note) <> '')),
  CONSTRAINT rag_purge_audit_source_key_sha256_check CHECK (source_key_sha256 IS NULL OR source_key_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rag_purge_audit_file_sha256_check CHECK (array_position(file_sha256_values, NULL) IS NULL),
  CONSTRAINT rag_purge_audit_result_check CHECK (result IS NULL OR result IN ('verified', 'pending', 'failed')),
  CONSTRAINT rag_purge_audit_counts_check CHECK (jsonb_typeof(counts) = 'object' AND jsonb_typeof(object_counts) = 'object')
);

CREATE INDEX IF NOT EXISTS rag_purge_audit_lineage_idx ON public.rag_purge_audit (tenant_key, lineage_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rag_purge_audit_started_idx ON public.rag_purge_audit (started_at DESC);
CREATE INDEX IF NOT EXISTS rag_purge_audit_tombstone_idx
  ON public.rag_purge_audit (tenant_key, source_connection_id, source_key_sha256)
  WHERE actor_kind = 'admin';

ALTER TABLE public.rag_purge_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_purge_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rag_purge_audit TO service_role;

-- Refuses deletes, and updates unless rag_purge_audit_finish set its transaction-local flag; even then only the finish columns change.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_finish_columns constant text[] := ARRAY[
    'finished_at', 'object_counts', 'verification', 'verification_checked_at', 'pending_object_paths', 'result'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rag_purge_audit is append-only' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting('rag.purge_audit_finish', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'rag_purge_audit is append-only' USING ERRCODE = '42501';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - v_finish_columns) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_finish_columns) THEN
    RAISE EXCEPTION 'rag_purge_audit identity columns are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_purge_audit_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'rag_purge_audit is append-only' USING ERRCODE = '42501';
END
$$;

DROP TRIGGER IF EXISTS rag_purge_audit_guard ON public.rag_purge_audit;
CREATE TRIGGER rag_purge_audit_guard
  BEFORE UPDATE OR DELETE ON public.rag_purge_audit
  FOR EACH ROW EXECUTE FUNCTION public.rag_purge_audit_guard();

DROP TRIGGER IF EXISTS rag_purge_audit_no_truncate ON public.rag_purge_audit;
CREATE TRIGGER rag_purge_audit_no_truncate
  BEFORE TRUNCATE ON public.rag_purge_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_purge_audit_no_truncate();

-- Stores the app's object step and the verification: merges object counts, replaces pending paths and the verification when given,
-- sets the result and the finish time (and the check time with a verification). Unknown id: not_found.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_finish(
  p_audit_id uuid,
  p_object_counts jsonb,
  p_pending text[],
  p_verification jsonb,
  p_result text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_audit_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_object_counts IS NOT NULL AND pg_catalog.jsonb_typeof(p_object_counts) <> 'object' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_verification IS NOT NULL AND pg_catalog.jsonb_typeof(p_verification) NOT IN ('object', 'array') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_result IS NOT NULL AND p_result NOT IN ('verified', 'pending', 'failed') THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_pending IS NOT NULL AND (pg_catalog.cardinality(p_pending) > 10000 OR pg_catalog.array_position(p_pending, NULL) IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('rag.purge_audit_finish', 'on', true);
  UPDATE public.rag_purge_audit a
     SET object_counts = a.object_counts || COALESCE(p_object_counts, '{}'::jsonb),
         pending_object_paths = COALESCE(p_pending, a.pending_object_paths),
         verification = COALESCE(p_verification, a.verification),
         verification_checked_at = CASE WHEN p_verification IS NULL THEN a.verification_checked_at ELSE pg_catalog.now() END,
         result = COALESCE(p_result, a.result),
         finished_at = pg_catalog.now()
   WHERE a.id = p_audit_id;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('rag.purge_audit_finish', 'off', true);
    RAISE EXCEPTION 'not_found';
  END IF;
  PERFORM pg_catalog.set_config('rag.purge_audit_finish', 'off', true);
  RETURN true;
END
$$;

-- The tenant, lineage and connector flag of a document an admin may purge. Unknown, other-tenant and non-admin: not_found.
CREATE OR REPLACE FUNCTION public.rag_purge_admin_target(p_document_id uuid, p_actor uuid)
RETURNS TABLE (tenant_key text, lineage_id uuid, is_connector boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_keys text[];
  v_doc record;
BEGIN
  IF p_document_id IS NULL OR p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  v_keys := public.rag_admin_tenant_keys(p_actor);
  SELECT d.tenant_key, d.lineage_id, d.source INTO v_doc
    FROM public.documents d
   WHERE d.id = p_document_id AND d.tenant_key = ANY (v_keys);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  RETURN QUERY SELECT v_doc.tenant_key::text, v_doc.lineage_id::uuid, (v_doc.source = 'nango');
END
$$;

-- Purge records of the tenants the admin administers, newest first, with the provider of a source-sync row's connection when it
-- still exists.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_list(p_actor uuid, p_limit integer, p_offset integer)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  lineage_id uuid,
  version_ids uuid[],
  source text,
  source_connection_id text,
  connection_provider text,
  actor_kind text,
  actor_id uuid,
  reason_code text,
  reason_note text,
  started_at timestamptz,
  finished_at timestamptz,
  counts jsonb,
  object_counts jsonb,
  verification jsonb,
  verification_checked_at timestamptz,
  pending_object_paths text[],
  result text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_keys text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  v_keys := public.rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  SELECT a.id, a.tenant_key, a.lineage_id, a.version_ids, a.source, a.source_connection_id,
         (SELECT c.provider FROM public.nango_connections c WHERE a.actor_kind = 'source_sync' AND c.id = a.actor_id),
         a.actor_kind, a.actor_id, a.reason_code, a.reason_note, a.started_at, a.finished_at, a.counts, a.object_counts,
         a.verification, a.verification_checked_at, a.pending_object_paths, a.result
    FROM public.rag_purge_audit a
   WHERE a.tenant_key = ANY (v_keys)
   ORDER BY a.started_at DESC, a.id
   LIMIT p_limit OFFSET p_offset;
END
$$;

-- One purge record of a tenant the admin administers. Unknown and other-tenant ids: not_found.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_get(p_actor uuid, p_audit_id uuid)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  lineage_id uuid,
  version_ids uuid[],
  source text,
  source_connection_id text,
  connection_provider text,
  actor_kind text,
  actor_id uuid,
  reason_code text,
  reason_note text,
  started_at timestamptz,
  finished_at timestamptz,
  counts jsonb,
  object_counts jsonb,
  verification jsonb,
  verification_checked_at timestamptz,
  pending_object_paths text[],
  result text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_keys text[];
BEGIN
  IF p_actor IS NULL OR p_audit_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  v_keys := public.rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  SELECT a.id, a.tenant_key, a.lineage_id, a.version_ids, a.source, a.source_connection_id,
         (SELECT c.provider FROM public.nango_connections c WHERE a.actor_kind = 'source_sync' AND c.id = a.actor_id),
         a.actor_kind, a.actor_id, a.reason_code, a.reason_note, a.started_at, a.finished_at, a.counts, a.object_counts,
         a.verification, a.verification_checked_at, a.pending_object_paths, a.result
    FROM public.rag_purge_audit a
   WHERE a.id = p_audit_id AND a.tenant_key = ANY (v_keys);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
END
$$;

-- Records the reconcile job retries: pending object paths, or finished in the last 7 days (re-verification window). Ids only.
CREATE OR REPLACE FUNCTION public.rag_purge_audit_pending(p_limit integer)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  lineage_id uuid,
  version_ids uuid[],
  pending_object_paths text[],
  started_at timestamptz,
  finished_at timestamptz,
  result text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT a.id, a.tenant_key, a.lineage_id, a.version_ids, a.pending_object_paths, a.started_at, a.finished_at, a.result
    FROM public.rag_purge_audit a
   WHERE pg_catalog.cardinality(a.pending_object_paths) > 0
      OR a.finished_at > pg_catalog.now() - interval '7 days'
   ORDER BY a.started_at, a.id
   LIMIT p_limit;
END
$$;

-- True when an admin purged this connector file in the tenant (D-35). Source-sync purges leave no tombstone.
CREATE OR REPLACE FUNCTION public.rag_purge_tombstone_exists(p_tenant_key text, p_source_connection_id text, p_source_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_source_connection_id IS NULL OR btrim(p_source_connection_id) = '' OR p_source_key IS NULL OR p_source_key = '' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.rag_purge_audit a
     WHERE a.actor_kind = 'admin'
       AND a.tenant_key = p_tenant_key
       AND a.source_connection_id = p_source_connection_id
       AND a.source_key_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_source_key, 'UTF8')), 'hex')
  );
END
$$;

REVOKE ALL ON FUNCTION public.rag_purge_audit_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_audit_no_truncate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_admin_target(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_audit_list(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_audit_get(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_audit_pending(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_tombstone_exists(text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_admin_target(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_audit_list(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_audit_get(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_audit_pending(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_tombstone_exists(text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0727_purge_lineage.sql
-- 0727: Purge one lineage from every database store in one transaction, and verify it (DATA-24, D-11, D-13, D-15, D-16, D-37, D-43,
-- D-45). Modelled on rag_delete_quarantined (0425): tenant guard first, the lineage's rows locked FOR UPDATE, superseded_by cleared,
-- document_chunks deleted explicitly (single-tenant has no cascade), audit row in the same transaction, storage keys returned for the
-- app to remove after commit. One-way by design: purged rows cannot be restored; the audit row keeps ids and hashes only.
-- Phase 7's external purge seam (0740) and the foreign-store seam (0728, plan 06.3-19) are called only when to_regprocedure finds
-- them, so this file applies before or after either. Additive and idempotent, not folded into the setup files.

BEGIN;

-- p_actor: {"kind": "admin", "id": <admin user uuid>} or {"kind": "source_sync", "id": <nango_connections.id>}.
-- p_reason: {"code": <reason code>, "note": <optional, at most 500 characters; required for "other">}. Admins use the six admin
-- codes; source sync uses "source_deleted" only.
CREATE OR REPLACE FUNCTION public.rag_purge_lineage(p_tenant_key text, p_lineage_id uuid, p_actor jsonb, p_reason jsonb)
RETURNS TABLE (audit_id uuid, counts jsonb, object_keys text[], parse_cache_prefixes text[], image_prefixes text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_admin_codes constant text[] := ARRAY['owner_request', 'added_in_error', 'retention_ended', 'legal_or_policy', 'restricted_content', 'other'];
  v_actor_kind text;
  v_actor_id uuid;
  v_reason_code text;
  v_reason_note text;
  v_connection text;
  v_ids uuid[];
  v_hashes text[];
  v_keys text[];
  v_file_ids text[];
  v_newest public.documents%ROWTYPE;
  v_source_key text;
  v_prefixes text[];
  v_counts jsonb;
  v_foreign jsonb;
  v_chunk_ids uuid[];
  v_n_documents bigint;
  v_n_chunks bigint;
  v_n_vectors bigint;
  v_n_parents bigint;
  v_n_jobs bigint;
  v_n_archive bigint;
  v_n_parse bigint;
  v_n_cache bigint;
  v_n_citations bigint;
  v_n_chats bigint;
  v_n_sync bigint;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_audit uuid;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;

  IF p_actor IS NULL OR pg_catalog.jsonb_typeof(p_actor) <> 'object'
     OR pg_catalog.jsonb_typeof(p_actor -> 'kind') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(p_actor -> 'id') IS DISTINCT FROM 'string'
     OR (p_actor ->> 'kind') NOT IN ('admin', 'source_sync')
     OR (p_actor ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'actor';
  END IF;
  v_actor_kind := p_actor ->> 'kind';
  v_actor_id := (p_actor ->> 'id')::uuid;

  IF p_reason IS NULL OR pg_catalog.jsonb_typeof(p_reason) <> 'object'
     OR pg_catalog.jsonb_typeof(p_reason -> 'code') IS DISTINCT FROM 'string'
     OR (p_reason ? 'note' AND pg_catalog.jsonb_typeof(p_reason -> 'note') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'reason';
  END IF;
  v_reason_code := p_reason ->> 'code';
  v_reason_note := NULLIF(pg_catalog.btrim(COALESCE(p_reason ->> 'note', '')), '');
  IF (v_actor_kind = 'admin' AND v_reason_code <> ALL (v_admin_codes))
     OR (v_actor_kind = 'source_sync' AND v_reason_code <> 'source_deleted')
     OR (v_reason_code = 'other' AND v_reason_note IS NULL)
     OR pg_catalog.char_length(COALESCE(v_reason_note, '')) > 500 THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023', DETAIL = 'reason';
  END IF;

  -- The actor must be entitled to the tenant; otherwise the answer equals an unknown lineage.
  IF v_actor_kind = 'admin' THEN
    IF NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = v_actor_id)
       OR NOT (p_tenant_key = ANY (public.rag_admin_tenant_keys(v_actor_id))) THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  ELSE
    SELECT c.connection_id INTO v_connection FROM public.nango_connections c WHERE c.id = v_actor_id;
    IF v_connection IS NULL THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  PERFORM 1 FROM public.documents d
   WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key
   ORDER BY d.id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_actor_kind = 'source_sync' AND EXISTS (
       SELECT 1 FROM public.documents d
        WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key
          AND (d.source IS DISTINCT FROM 'nango' OR d.source_connection_id IS DISTINCT FROM v_connection)
     ) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT pg_catalog.array_agg(d.id ORDER BY d.version, d.id),
         COALESCE(pg_catalog.array_agg(DISTINCT d.file_sha256) FILTER (WHERE d.file_sha256 IS NOT NULL), '{}'::text[])
    INTO v_ids, v_hashes
    FROM public.documents d
   WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key;
  v_file_ids := ARRAY(
    SELECT DISTINCT f.id FROM public.documents d
     CROSS JOIN LATERAL (VALUES (d.source_key), (d.source_file_id)) AS f(id)
     WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key AND d.source = 'nango'
       AND f.id IS NOT NULL AND f.id <> ''
  );

  SELECT * INTO v_newest FROM public.documents d
   WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key
   ORDER BY d.is_current DESC, d.version DESC, d.id
   LIMIT 1;
  v_source_key := CASE WHEN v_newest.source = 'nango' THEN COALESCE(NULLIF(v_newest.source_file_id, ''), v_newest.source_key)
                       ELSE v_newest.source_key END;

  v_keys := ARRAY(
    SELECT DISTINCT s.key FROM public.documents d
     CROSS JOIN LATERAL (
       SELECT e.value AS key
         FROM pg_catalog.jsonb_each_text(CASE WHEN pg_catalog.jsonb_typeof(d.processing_state -> 'artifacts') = 'object'
                                              THEN d.processing_state -> 'artifacts' ELSE '{}'::jsonb END) AS e
       UNION ALL
       SELECT d.original_path
     ) AS s
     WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key AND s.key IS NOT NULL AND s.key <> ''
     ORDER BY s.key
  );

  -- Phase 7 external backends (D-45): the version ids are resolved before any delete; no applicable target writes nothing.
  IF pg_catalog.to_regprocedure('public.rag_vector_sync_enqueue_purge(text,uuid,uuid[],text,text)') IS NOT NULL THEN
    EXECUTE 'SELECT public.rag_vector_sync_enqueue_purge($1, $2, $3, $4, $5)'
      USING p_tenant_key, p_lineage_id, v_ids, v_actor_kind || ':' || v_actor_id::text, v_reason_code;
  END IF;

  -- Citation snapshots and saved chats of the tenant (D-13, 0724).
  v_n_citations := public.rag_purge_scrub_answer_records(p_tenant_key, p_lineage_id, v_ids, v_now);
  v_n_chats := public.rag_purge_scrub_chats(p_tenant_key, p_lineage_id, v_ids, v_now);

  -- Stores owned by other phases (D-14, plan 06.3-19); counted before the chunk delete so cascading rows are still there.
  IF pg_catalog.to_regprocedure('public.rag_purge_foreign_stores(text,uuid,uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT public.rag_purge_foreign_stores($1, $2, $3)' INTO v_foreign USING p_tenant_key, p_lineage_id, v_ids;
  END IF;

  v_chunk_ids := ARRAY(SELECT c.id FROM public.document_chunks c WHERE c.document_id = ANY (v_ids));
  SELECT pg_catalog.count(*) INTO v_n_vectors FROM public.chunk_embeddings e WHERE e.chunk_id = ANY (v_chunk_ids);
  SELECT pg_catalog.count(*) INTO v_n_parents FROM public.document_parents p WHERE p.document_id = ANY (v_ids);

  UPDATE public.documents d SET superseded_by = NULL WHERE d.superseded_by = ANY (v_ids) AND d.tenant_key = p_tenant_key;

  -- The single-tenant schema has no cascade from documents to document_chunks; vectors, gaps and parents cascade.
  DELETE FROM public.document_chunks c WHERE c.document_id = ANY (v_ids);
  GET DIAGNOSTICS v_n_chunks = ROW_COUNT;

  DELETE FROM public.ingestion_jobs j
   WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids));
  GET DIAGNOSTICS v_n_jobs = ROW_COUNT;
  DELETE FROM public.ingestion_jobs_archive j
   WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids));
  GET DIAGNOSTICS v_n_archive = ROW_COUNT;

  WITH removed AS (
    DELETE FROM public.rag_parse_cache pc
     WHERE pc.tenant_key = p_tenant_key
       AND pc.file_sha256 = ANY (v_hashes)
       AND NOT EXISTS (
         SELECT 1 FROM public.documents d
          WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = pc.file_sha256 AND d.lineage_id <> p_lineage_id
       )
    RETURNING pc.object_prefix
  )
  SELECT pg_catalog.count(*), COALESCE(pg_catalog.array_agg(DISTINCT r.object_prefix ORDER BY r.object_prefix), '{}'::text[])
    INTO v_n_parse, v_prefixes
    FROM removed r;

  DELETE FROM public.nango_sync_records r
   WHERE r.document_id = ANY (v_ids)
      OR (v_newest.source = 'nango' AND r.connection_id = v_newest.source_connection_id AND r.file_id = ANY (v_file_ids));
  GET DIAGNOSTICS v_n_sync = ROW_COUNT;

  v_n_cache := public.rag_cache_invalidate(p_tenant_key, v_ids);

  DELETE FROM public.documents d WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key;
  GET DIAGNOSTICS v_n_documents = ROW_COUNT;

  v_counts := pg_catalog.jsonb_build_object(
    'documents', v_n_documents,
    'chunks', v_n_chunks,
    'vectors', v_n_vectors,
    'parents', v_n_parents,
    'ingestion_jobs', v_n_jobs + v_n_archive,
    'parse_cache', v_n_parse,
    'semantic_cache', v_n_cache,
    'answer_citations', v_n_citations,
    'chat_messages', v_n_chats,
    'sync_records', v_n_sync
  );
  IF v_foreign IS NOT NULL AND pg_catalog.jsonb_typeof(v_foreign) = 'object' THEN
    v_counts := v_foreign || v_counts;
  END IF;

  INSERT INTO public.rag_purge_audit (
    tenant_key, lineage_id, version_ids, file_sha256_values, source, source_key_sha256, source_connection_id,
    actor_kind, actor_id, reason_code, reason_note, started_at, counts
  ) VALUES (
    p_tenant_key, p_lineage_id, v_ids, v_hashes, v_newest.source,
    CASE WHEN v_source_key IS NULL OR v_source_key = '' THEN NULL
         ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_source_key, 'UTF8')), 'hex') END,
    CASE WHEN v_newest.source = 'nango' THEN v_newest.source_connection_id ELSE NULL END,
    v_actor_kind, v_actor_id, v_reason_code, v_reason_note, v_now, v_counts
  )
  RETURNING id INTO v_audit;

  RETURN QUERY SELECT v_audit, v_counts, v_keys, v_prefixes,
                      ARRAY['rag/' || p_tenant_key || '/' || p_lineage_id::text || '/'];
END
$$;

-- Remaining rows per store after a purge, from the version ids and hashes of the newest audit row of the lineage. state is NULL for
-- database stores; with Phase 7's 0740, one external:<target> row per target (done, pending, dead or not_applicable). A purge is
-- successful only when every database count is 0 and no target is pending or dead. No audit row: not_found.
CREATE OR REPLACE FUNCTION public.rag_purge_verify(p_tenant_key text, p_lineage_id uuid)
RETURNS TABLE (store text, remaining bigint, state text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_audit public.rag_purge_audit%ROWTYPE;
  v_ids uuid[];
  v_hashes text[];
  v_text_ids text[];
  r record;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_audit FROM public.rag_purge_audit a
   WHERE a.tenant_key = p_tenant_key AND a.lineage_id = p_lineage_id
   ORDER BY a.started_at DESC, a.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  v_ids := v_audit.version_ids;
  v_hashes := v_audit.file_sha256_values;
  v_text_ids := ARRAY(SELECT u.id::text FROM pg_catalog.unnest(v_ids) AS u(id));

  RETURN QUERY SELECT 'documents'::text, (
    SELECT pg_catalog.count(*) FROM public.documents d
     WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (v_ids))
  ), NULL::text;
  RETURN QUERY SELECT 'chunks'::text, (
    SELECT pg_catalog.count(*) FROM public.document_chunks c WHERE c.document_id = ANY (v_ids)
  ), NULL::text;
  RETURN QUERY SELECT 'vectors'::text, (
    SELECT pg_catalog.count(*) FROM public.chunk_embeddings e
      JOIN public.document_chunks c ON c.id = e.chunk_id
     WHERE c.document_id = ANY (v_ids)
  ), NULL::text;
  RETURN QUERY SELECT 'parents'::text, (
    SELECT pg_catalog.count(*) FROM public.document_parents p WHERE p.document_id = ANY (v_ids)
  ), NULL::text;
  RETURN QUERY SELECT 'ingestion_jobs'::text, (
    SELECT pg_catalog.count(*) FROM public.ingestion_jobs j
     WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids))
  ) + (
    SELECT pg_catalog.count(*) FROM public.ingestion_jobs_archive j
     WHERE j.tenant_key = p_tenant_key AND (j.lineage_id = p_lineage_id OR j.document_id = ANY (v_ids))
  ), NULL::text;
  RETURN QUERY SELECT 'parse_cache'::text, (
    SELECT pg_catalog.count(*) FROM public.rag_parse_cache pc
     WHERE pc.tenant_key = p_tenant_key AND pc.file_sha256 = ANY (v_hashes)
       AND NOT EXISTS (
         SELECT 1 FROM public.documents d
          WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = pc.file_sha256 AND d.lineage_id <> p_lineage_id
       )
  ), NULL::text;
  RETURN QUERY SELECT 'semantic_cache'::text, (
    SELECT pg_catalog.count(*) FROM public.rag_semantic_cache sc
     WHERE sc.tenant_key = p_tenant_key
       AND EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(sc.source_versions) AS e(v) WHERE (e.v ->> 'document_id') = ANY (v_text_ids)
       )
  ), NULL::text;
  FOR r IN SELECT l.store, l.remaining FROM public.rag_purge_citation_leftovers(p_tenant_key, v_ids) AS l LOOP
    RETURN QUERY SELECT r.store::text, r.remaining::bigint, NULL::text;
  END LOOP;
  RETURN QUERY SELECT 'sync_records'::text, (
    SELECT pg_catalog.count(*) FROM public.nango_sync_records s
     WHERE s.document_id = ANY (v_ids)
        OR (v_audit.source = 'nango' AND v_audit.source_key_sha256 IS NOT NULL
            AND s.connection_id = v_audit.source_connection_id
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.file_id, 'UTF8')), 'hex') = v_audit.source_key_sha256)
  ), NULL::text;

  IF pg_catalog.to_regprocedure('public.rag_purge_foreign_leftovers(text,uuid,uuid[])') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT f.store::text AS store, f.remaining::bigint AS remaining FROM public.rag_purge_foreign_leftovers($1, $2, $3) AS f'
             USING p_tenant_key, p_lineage_id, v_ids LOOP
      RETURN QUERY SELECT r.store, r.remaining, NULL::text;
    END LOOP;
  END IF;

  IF pg_catalog.to_regprocedure('public.rag_vector_sync_purge_status(text,uuid)') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT s.target::text AS target, s.state::text AS state FROM public.rag_vector_sync_purge_status($1, $2) AS s'
             USING p_tenant_key, p_lineage_id LOOP
      RETURN QUERY SELECT 'external:' || r.target,
                          CASE WHEN r.state IN ('done', 'not_applicable') THEN 0::bigint ELSE 1::bigint END,
                          r.state;
    END LOOP;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_verify(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_verify(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0986_tenant_doc_types_access.sql
-- 0986: rag_tenant_doc_types (0981) takes the access filter (quick task doc-types-access; SEC-12, D-10, D-11 of Phase 4.3).
-- 0981 returned the doc types of every current, ready document of the tenant, so the doc-type vocabulary of the sub-question filters
-- (the shared.subq-filters.v1 prompt addendum and narrowFilters) named doc types that only restricted documents carry. The function is
-- the 0981 body plus p_access_keys text[] and p_access_all boolean, appended with defaults NULL and false, with the guard of 0930/0933
-- (as 1010): no keys while public.rag_access_enforced() (0922) is true raises access_scope_required (42501), an empty key array or one
-- holding NULL raises access_keys_empty (22023). The guard runs right after the tenant assertion. With keys and p_access_all not true,
-- a document counts only when documents.access_groups overlaps the keys, so a doc type carried only by documents outside the keys is
-- not listed and the counts leave those documents out. With no keys the function runs the 0981 query and returns what 0981 returned.
-- DROP section: every overload of rag_tenant_doc_types is dropped by catalog lookup first (the 0981 signature (text)), so exactly one
-- exists. SECURITY INVOKER, STABLE, empty search_path, executable by service_role only (0410 carries the guarded grant row).
-- rag_access_readiness() is redefined from its 0933 body with rag_tenant_doc_types added to the optional functions it checks; this file
-- is now the last definition of both. Operator rule (as 0933 and 1010): after re-running 0981 or 0933, re-run this file; until then the
-- old doc-type signature comes back as a second overload (readiness reports function_overloaded) or readiness stops checking it.
-- Common to single-tenant and multi-tenant (rag_assert_tenant_key decides the mode). Purge: no new store. Idempotent; not folded.

BEGIN;

DO $doc_types_access_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_access_enforced()') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_access_readiness()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'access_groups' AND NOT a.attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.documents'::regclass AND a.attname = 'doc_type' AND NOT a.attisdropped
     ) THEN
    RAISE EXCEPTION '0986: apply the 0920 block (0921, 0922, 0933) and 0981 first' USING ERRCODE = '55000';
  END IF;
END
$doc_types_access_precheck$;

DO $drop_doc_types_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_tenant_doc_types'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_doc_types_overloads$;

CREATE OR REPLACE FUNCTION public.rag_tenant_doc_types(
  p_tenant_key text,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (
  doc_type text,
  docs bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_restrict boolean;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  v_restrict := p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false);

  RETURN QUERY
  SELECT d.doc_type AS doc_type, pg_catalog.count(*) AS docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type IS NOT NULL
    AND (NOT v_restrict OR d.access_groups OPERATOR(pg_catalog.&&) p_access_keys)
  GROUP BY d.doc_type
  ORDER BY pg_catalog.count(*) DESC, d.doc_type;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_readiness()
RETURNS TABLE (ready boolean, reasons text[], objects text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_multi boolean;
  v_required text[];
  v_optional constant text[] := ARRAY[
    'hybrid_search_translations', 'rag_cache_check', 'rag_table_lookup', 'rag_identifier_resolve',
    'rag_identifier_candidates', 'rag_dup_cluster_sources', 'rag_bm25_search_chunks',
    'rag_attribute_filter_values', 'rag_attribute_documents', 'rag_tenant_doc_types'
  ];
  v_required_tables constant text[] := ARRAY['documents', 'document_chunks', 'document_parents'];
  v_optional_tables constant text[] := ARRAY['chunk_translations', 'rag_table_rows'];
  v_name text;
  v_overloads integer;
  v_missing_params integer;
  v_missing_guard integer;
  v_reasons text[] := ARRAY[]::text[];
  v_objects text[] := ARRAY[]::text[];
BEGIN
  BEGIN
    PERFORM public.rag_assert_tenant_key('s:default');
    v_multi := false;
  EXCEPTION WHEN others THEN
    v_multi := true;
  END;
  v_required := ARRAY['hybrid_search_chunks', 'rag_fetch_parents', 'rag_exact_id_documents', 'match_chunks_by_profile', 'rag_find_invoices',
    CASE WHEN v_multi THEN 'match_documents_by_workspace' ELSE 'match_document_chunks' END];

  FOREACH v_name IN ARRAY v_required || v_optional LOOP
    SELECT pg_catalog.count(*)::integer,
           pg_catalog.count(*) FILTER (
             WHERE p.proargnames IS NULL
                OR NOT ('p_access_keys' = ANY (p.proargnames) AND 'p_access_all' = ANY (p.proargnames))
           )::integer,
           pg_catalog.count(*) FILTER (WHERE pg_catalog.strpos(p.prosrc, 'access_scope_required') = 0)::integer
      INTO v_overloads, v_missing_params, v_missing_guard
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_overloads = 0 THEN
      IF v_name = ANY (v_required) THEN
        v_reasons := v_reasons || 'function_missing'::text;
        v_objects := v_objects || v_name;
      END IF;
      CONTINUE;
    END IF;
    IF v_overloads > 1 THEN
      v_reasons := v_reasons || 'function_overloaded'::text;
      v_objects := v_objects || v_name;
    END IF;
    IF v_missing_params > 0 THEN
      v_reasons := v_reasons || 'function_missing_access_parameters'::text;
      v_objects := v_objects || v_name;
    END IF;
    IF v_missing_guard > 0 THEN
      v_reasons := v_reasons || 'function_missing_guard'::text;
      v_objects := v_objects || v_name;
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY v_required_tables || v_optional_tables LOOP
    IF pg_catalog.to_regclass('public.' || v_name) IS NULL THEN
      IF v_name = ANY (v_required_tables) THEN
        v_reasons := v_reasons || 'table_missing'::text;
        v_objects := v_objects || v_name;
      END IF;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_name) AND a.attname = 'access_groups' AND NOT a.attisdropped
    ) THEN
      v_reasons := v_reasons || 'table_missing_column'::text;
      v_objects := v_objects || v_name;
    END IF;
  END LOOP;

  RETURN QUERY SELECT pg_catalog.cardinality(v_reasons) = 0, v_reasons, v_objects;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_readiness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_readiness() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0988_review_items_writers_access_sets.sql
-- 0988: the Phase 5.3 review-queue writers carry access_sets (Phase 4.3 follow-up to 0984; SEC-13, D-25, A-06).
-- Gap closed: rag_review_items_enqueue (0967) and rag_review_items_enqueue_re_review (0974) wrote rag_review_items.access_sets as
-- NULL, so 0934's restrictive policy rag_review_items_access_sets never hid such an item, and every expert of the tenant could read
-- its masked query even when it came from a document outside the expert's access groups.
-- Both functions keep their signatures and security attributes (SECURITY INVOKER, empty search_path, service_role only, locked again
-- in 0410); a row may now carry optional keys, which today's callers do not send:
--   access_sets   the caller's label sets (validated strictly by rag_review_access_sets: malformed raises 22023 and writes nothing);
--   document_ids  at most 50 UUIDs of source documents, each a document of p_tenant_key (otherwise 22023 document_not_in_tenant);
--   item_ids      re-review only: at most 50 golden item ids; their documents are read from rag_golden_evidence_index of the tenant.
-- rag_review_items_enqueue also derives the sources of a row's retrieval_log_id: the log row's access_sets (only while
-- public.rag_access_enforced() is true) and the documents of its candidates. Everything goes through rag_review_access_sets (0984),
-- which adds the documents' access_groups only while access is enforced. With access off and no access_sets key in a row the stored
-- value is NULL, exactly as before.
-- While access is enforced at apply time, items still without access_sets that have a retrieval log row get their sets from it.
-- Each writer is rebuilt only where its Phase 5.3 file already created it (no-op otherwise, so 0988 never owns a 5.3 function).
-- One common file: nothing differs by deployment mode. Not folded into the setup files. Idempotent. No signature changes, so no DROP.
-- Apply after 0967, 0974 and 0984; re-running 0967 or 0974 later restores the old bodies, so re-run this file after them.

BEGIN;

DO $do$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR pg_catalog.to_regclass('public.rag_review_item_strata') IS NULL THEN
    RAISE NOTICE '[0988] rag_review_items or rag_review_item_strata is missing; rag_review_items_enqueue skipped';
    RETURN;
  END IF;

  EXECUTE $sql$
    CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue(p_tenant_key text, p_source text, p_rows jsonb)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = ''
    AS $fn$
    DECLARE
      v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      v_row jsonb;
      v_id uuid;
      v_log uuid;
      v_reasons text[];
      v_count integer := 0;
      v_docs uuid[];
      v_row_docs uuid[];
      v_log_sets jsonb;
      v_sets jsonb;
      v_found integer;
    BEGIN
      PERFORM public.rag_assert_tenant_key(p_tenant_key);
      IF p_source IS NULL OR p_source NOT IN ('representative', 'pilot', 'drift_fill', 'historical') THEN
        RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023';
      END IF;
      IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
      END IF;

      FOR v_row IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value) LOOP
        IF pg_catalog.jsonb_typeof(v_row) <> 'object'
           OR coalesce(v_row ->> 'query_masked', '') = ''
           OR coalesce(v_row ->> 'query_fingerprint', '') = ''
           OR coalesce(v_row ->> 'mining_window', '') = ''
           OR coalesce(v_row ->> 'stratum', '') = ''
           OR coalesce(pg_catalog.jsonb_typeof(v_row -> 'sampling_weight'), '') <> 'number'
           OR (v_row ? 'reasons' AND pg_catalog.jsonb_typeof(v_row -> 'reasons') <> 'array') THEN
          RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
        END IF;
        IF v_row ? 'document_ids' AND pg_catalog.jsonb_typeof(v_row -> 'document_ids') <> 'null' AND (
             pg_catalog.jsonb_typeof(v_row -> 'document_ids') <> 'array'
             OR pg_catalog.jsonb_array_length(v_row -> 'document_ids') > 50
             OR EXISTS (
               SELECT 1 FROM pg_catalog.jsonb_array_elements(v_row -> 'document_ids') AS d(value)
               WHERE pg_catalog.jsonb_typeof(d.value) <> 'string' OR pg_catalog.lower(d.value #>> '{}') !~ v_uuid
             )) THEN
          RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023', DETAIL = 'document_ids must be at most 50 UUID strings';
        END IF;

        v_log := NULLIF(v_row ->> 'retrieval_log_id', '')::uuid;
        IF v_log IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.rag_retrieval_log l WHERE l.id = v_log AND l.tenant_key = p_tenant_key
        ) THEN
          RAISE EXCEPTION 'retrieval_log_not_in_tenant' USING ERRCODE = '22023';
        END IF;

        v_row_docs := ARRAY(
          SELECT DISTINCT pg_catalog.lower(d.value #>> '{}')::uuid
          FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(v_row -> 'document_ids') = 'array' THEN v_row -> 'document_ids' ELSE '[]'::jsonb END) AS d(value)
        );
        SELECT count(*) INTO v_found FROM public.documents d WHERE d.id = ANY (v_row_docs) AND d.tenant_key = p_tenant_key;
        IF v_found <> pg_catalog.cardinality(v_row_docs) THEN
          RAISE EXCEPTION 'document_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every document id must be a document of the tenant';
        END IF;

        v_docs := v_row_docs;
        v_log_sets := NULL;
        IF v_log IS NOT NULL THEN
          SELECT CASE WHEN public.rag_access_enforced() THEN l.access_sets END,
                 v_docs || ARRAY(
                   SELECT DISTINCT (c ->> 'document_id')::uuid
                   FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l.candidates) = 'array' THEN l.candidates ELSE '[]'::jsonb END) AS c
                   WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ v_uuid
                 )
            INTO v_log_sets, v_docs
          FROM public.rag_retrieval_log l
          WHERE l.id = v_log AND l.tenant_key = p_tenant_key;
        END IF;

        v_sets := public.rag_review_access_sets(p_tenant_key, NULLIF(v_row -> 'access_sets', 'null'::jsonb), v_docs, true);
        IF v_log_sets IS NOT NULL THEN
          v_sets := public.rag_review_access_sets(p_tenant_key, coalesce(v_sets, '[]'::jsonb) || v_log_sets, NULL, false);
        END IF;

        IF v_row ? 'reasons' THEN
          v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(v_row -> 'reasons'));
        ELSE
          v_reasons := ARRAY['representative']::text[];
        END IF;

        v_id := NULL;
        INSERT INTO public.rag_review_items AS i (
          tenant_key, retrieval_log_id, trace_id, query_masked, query_fingerprint, query_language, channel,
          reasons, status, mining_window, mined_at, expires_at, access_sets
        ) VALUES (
          p_tenant_key, v_log, NULLIF(v_row ->> 'trace_id', ''), v_row ->> 'query_masked', v_row ->> 'query_fingerprint',
          NULLIF(v_row ->> 'language', ''), NULLIF(v_row ->> 'channel', ''),
          v_reasons, 'open', (v_row ->> 'mining_window')::timestamptz, pg_catalog.now(), NULLIF(v_row ->> 'expires_at', '')::timestamptz,
          v_sets
        )
        ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
        RETURNING i.id INTO v_id;

        IF v_id IS NOT NULL THEN
          INSERT INTO public.rag_review_item_strata (review_item_id, tenant_key, source, stratum, sampling_weight)
          VALUES (v_id, p_tenant_key, p_source, v_row ->> 'stratum', (v_row ->> 'sampling_weight')::real);
          v_count := v_count + 1;
        END IF;
      END LOOP;

      RETURN v_count;
    END
    $fn$
  $sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) TO service_role';
END
$do$;

DO $do_re_review$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_review_items_enqueue_re_review(text, jsonb)') IS NULL THEN
    RAISE NOTICE '[0988] rag_review_items_enqueue_re_review is missing (apply 0974 first); skipped';
    RETURN;
  END IF;

  EXECUTE $create$
CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue_re_review(p_tenant_key text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_count integer;
  v_golden text := '';
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
     WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value ->> 'query_masked', '') = ''
        OR COALESCE(e.value ->> 'query_fingerprint', '') = ''
        OR COALESCE(e.value ->> 'mining_window', '') = ''
  ) THEN
    RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
     WHERE (e.value ? 'document_ids' AND pg_catalog.jsonb_typeof(e.value -> 'document_ids') <> 'null' AND (
              pg_catalog.jsonb_typeof(e.value -> 'document_ids') <> 'array'
              OR pg_catalog.jsonb_array_length(e.value -> 'document_ids') > 50
              OR EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_array_elements(e.value -> 'document_ids') AS d(value)
                WHERE pg_catalog.jsonb_typeof(d.value) <> 'string' OR pg_catalog.lower(d.value #>> '{}') !~ v_uuid)))
        OR (e.value ? 'item_ids' AND pg_catalog.jsonb_typeof(e.value -> 'item_ids') <> 'null' AND (
              pg_catalog.jsonb_typeof(e.value -> 'item_ids') <> 'array'
              OR pg_catalog.jsonb_array_length(e.value -> 'item_ids') > 50
              OR EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_array_elements(e.value -> 'item_ids') AS t(value)
                WHERE pg_catalog.jsonb_typeof(t.value) <> 'string' OR pg_catalog.length(t.value #>> '{}') NOT BETWEEN 1 AND 200)))
  ) THEN
    RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023', DETAIL = 'document_ids are at most 50 UUID strings, item_ids at most 50 ids';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'document_ids') = 'array' THEN e.value -> 'document_ids' ELSE '[]'::jsonb END) AS d(value)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.documents doc WHERE doc.id = pg_catalog.lower(d.value #>> '{}')::uuid AND doc.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'document_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every document id must be a document of the tenant';
  END IF;

  IF pg_catalog.to_regclass('public.rag_golden_evidence_index') IS NOT NULL THEN
    v_golden := $golden$
          UNION
          SELECT g.document_id FROM public.rag_golden_evidence_index g
           WHERE g.tenant_key = $1
             AND g.item_id IN (SELECT pg_catalog.jsonb_array_elements_text(
               CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'item_ids') = 'array' THEN e.value -> 'item_ids' ELSE '[]'::jsonb END))
    $golden$;
  END IF;

  EXECUTE $sql$
    WITH written AS (
      INSERT INTO public.rag_review_items AS i (
        tenant_key, query_masked, query_fingerprint, query_language, channel, reasons, status, mining_window, mined_at, access_sets
      )
      SELECT $1, e.value ->> 'query_masked', e.value ->> 'query_fingerprint', NULLIF(e.value ->> 'language', ''),
             NULLIF(e.value ->> 'channel', ''), ARRAY['re_review']::text[], 'open', (e.value ->> 'mining_window')::timestamptz,
             pg_catalog.now(),
             public.rag_review_access_sets($1, NULLIF(e.value -> 'access_sets', 'null'::jsonb), ARRAY(
               SELECT pg_catalog.lower(d.value #>> '{}')::uuid
                 FROM pg_catalog.jsonb_array_elements(
                   CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'document_ids') = 'array' THEN e.value -> 'document_ids' ELSE '[]'::jsonb END) AS d(value)
  $sql$ || v_golden || $sql$
             ), true)
        FROM pg_catalog.jsonb_array_elements($2) AS e(value)
      ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
      RETURNING 1
    )
    SELECT pg_catalog.count(*)::integer FROM written
  $sql$ INTO v_count USING p_tenant_key, p_rows;

  RETURN v_count;
END
$fn$
  $create$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) TO service_role';
END
$do_re_review$;

DO $backfill$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL
     OR NOT public.rag_access_enforced() THEN
    RETURN;
  END IF;
  UPDATE public.rag_review_items AS i
  SET access_sets = public.rag_review_access_sets(i.tenant_key, l.access_sets, ARRAY(
    SELECT DISTINCT (c ->> 'document_id')::uuid
    FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l.candidates) = 'array' THEN l.candidates ELSE '[]'::jsonb END) AS c
    WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), false)
  FROM public.rag_retrieval_log l
  WHERE i.access_sets IS NULL AND l.id = i.retrieval_log_id AND l.tenant_key = i.tenant_key;
END
$backfill$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r23 delta (the lines train 40 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r23_service_role_only$
BEGIN
  IF to_regprocedure('public.rag_withdrawn_citation(jsonb, timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_citation(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_citation(jsonb, timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_withdrawn_citations(jsonb, text[], timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_citations(jsonb, text[], timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_citations(jsonb, text[], timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_withdrawn_document_refs(jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_document_refs(jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_document_refs(jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_image_pattern(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_image_pattern(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_image_pattern(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_withdrawn_chat_messages(jsonb, text[], text, timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_citation_leftover_count(jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_citation_leftover_count(jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_citation_leftover_count(jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_chat_messages_leftover_count(jsonb, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chat_messages_leftover_count(jsonb, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chat_messages_leftover_count(jsonb, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_chat_messages_reference(jsonb, text[], text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_chat_messages_reference(jsonb, text[], text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_answer_records(text, uuid, uuid[], timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_scrub_chats(text, uuid, uuid[], timestamptz) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_citation_leftovers(text, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_citation_leftovers(text, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_citation_leftovers(text, uuid[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_admin_target(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_admin_target(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_admin_target(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_list(uuid, integer, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_list(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_list(uuid, integer, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_get(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_get(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_get(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_audit_pending(integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_audit_pending(integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_audit_pending(integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_tombstone_exists(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_tombstone_exists(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_tombstone_exists(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_lineage(text, uuid, jsonb, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_lineage(text, uuid, jsonb, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_purge_verify(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_purge_verify(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_purge_verify(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_source_recheck(text, uuid[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_source_recheck(text, uuid[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_source_recheck(text, uuid[]) TO service_role;
  END IF;
  -- Migration 0986: the tenant doc types with the access filter (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_tenant_doc_types(text, text[], boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_tenant_doc_types(text, text[], boolean) TO service_role;
  END IF;
  -- 0988 (quick task, renumbered from 0986 in train 40): Phase 5.3 review-queue writers with access sets (SECURITY INVOKER, service_role only).
  IF to_regprocedure('public.rag_review_items_enqueue(text, text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_review_items_enqueue_re_review(text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) TO service_role;
  END IF;
END
$r23_service_role_only$;

NOTIFY pgrst, 'reload schema';

-- ==== Verify (read-only; run after the apply)
-- 1. Exactly one overload of rag_tenant_doc_types, with both access parameters.
SELECT p.oid::regprocedure AS signature, p.prosecdef AS security_definer, p.proconfig AS config
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rag_tenant_doc_types';
-- Expect one row: (text, text[], boolean).

-- 2. Access readiness (expect ready).
SELECT public.rag_access_readiness();

-- 3. Grants: anon and authenticated cannot execute any function this train adds or redefines.
SELECT p.oid::regprocedure AS signature,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'rag\_purge\_%' OR p.proname LIKE 'rag\_withdrawn\_%'
       OR p.proname IN ('rag_source_recheck', 'rag_citation_leftover_count', 'rag_chat_messages_leftover_count',
                        'rag_chat_messages_reference', 'rag_tenant_doc_types', 'rag_access_readiness',
                        'rag_review_items_enqueue', 'rag_review_items_enqueue_re_review'))
ORDER BY 1;
-- Expect anon_exec and authenticated_exec false everywhere, service_role_exec true everywhere.

-- 4. New table: RLS on.
SELECT c.relname, c.relrowsecurity,
       (SELECT count(*) FROM pg_catalog.pg_policy pol WHERE pol.polrelid = c.oid) AS policies
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'rag_purge_audit';
-- Expect relrowsecurity true.

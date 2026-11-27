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

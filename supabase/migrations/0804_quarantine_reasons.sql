-- 0804: Quarantine reasons, release as approval, not-checked list (plan 03.2-34; D-32, D-34, D-35, D-36; SEC-07, SEC-08).
-- rag_list_quarantine is rebuilt from its 0425 body with four added columns: reasons (metadata.quarantine.reasons, '[]' for an older row,
-- which the service module presents as one injection_rule reason from its rule ids), unlocated (the summed unlocated span count of the
-- reasons), hidden_text_check (the 0801 column) and pending_approval (the upload also needed approval, metadata.quarantine.approval_required,
-- and nobody approved it yet); uploader_id (documents.user_id) is added for the uploader display. The return type changes, so the old
-- signature is dropped first (research F-8: CREATE OR REPLACE would fail or leave two overloads) and the grants are given again.
-- rag_release_quarantine is rebuilt from its 0425 body. The reasons stay; the targets of the untrusted_link reasons are stored as
-- metadata.quarantine.released_targets beside released_rule_ids (skipped on the next version, as Phase 5.1 D-10 does for rule ids); a release
-- counts as approval (D-36), so approved_by and approved_at are stamped on the document and approved_by on its chunks. The publish outcome
-- superseded_lineage (0806) is a completed release: the version is stored, retired by a confirmed link. The return type gains
-- released_targets and tenant_key (the service module calls afterPublish with it), so the old signature is dropped first.
-- rag_list_not_checked lists the current, ready documents of the actor's tenants whose hidden_text_check is not_checked (D-34).
-- Admin access is rag_admin_tenant_keys (the Quarantine panel rule): a non-admin and an admin of another tenant both see nothing or get
-- not_found. Every function here is SECURITY DEFINER with search_path '' and schema-qualified names, service_role only: REVOKE ALL FROM
-- PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature.
-- Not folded into the setup files. Idempotent: DROP FUNCTION IF EXISTS on the exact signatures, then CREATE. 0806 does not define
-- rag_release_quarantine. After this file 0425 cannot be re-run as it stands: its CREATE OR REPLACE of the two old return types fails with
-- 42P13 and the whole 0425 transaction rolls back, changing nothing.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_list_quarantine(uuid, integer, integer);

CREATE FUNCTION public.rag_list_quarantine(p_actor uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(document_id uuid, lineage_id uuid, tenant_key text, filename text, source text, version integer, rule_ids text[], snippets text[],
               quarantined_at timestamp with time zone, detected_by text, reasons jsonb, unlocated integer, hidden_text_check text,
               pending_approval boolean, uploader_id uuid, total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  page_size integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  skip integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  WITH quarantined AS (
    SELECT
      d.id,
      d.lineage_id,
      d.tenant_key,
      d.filename,
      d.source,
      d.version,
      CASE WHEN pg_catalog.jsonb_typeof(d.metadata #> '{quarantine,rule_ids}') = 'array'
           THEN ARRAY(SELECT pg_catalog.jsonb_array_elements_text(d.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END AS rule_ids,
      CASE WHEN pg_catalog.jsonb_typeof(d.metadata #> '{quarantine,snippets}') = 'array'
           THEN ARRAY(SELECT pg_catalog.left(s.value, 80) FROM pg_catalog.jsonb_array_elements_text(d.metadata #> '{quarantine,snippets}') AS s(value) LIMIT 3)
           ELSE '{}'::text[] END AS snippets,
      CASE WHEN (d.metadata #>> '{quarantine,quarantined_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
           THEN (d.metadata #>> '{quarantine,quarantined_at}')::timestamptz ELSE d.created_at END AS quarantined_at,
      CASE WHEN (d.metadata #>> '{invoice_extraction,status}') = 'quarantined' THEN 'invoice_extraction' ELSE 'injection_scan' END AS detected_by,
      CASE WHEN pg_catalog.jsonb_typeof(d.metadata #> '{quarantine,reasons}') = 'array'
           THEN d.metadata #> '{quarantine,reasons}' ELSE '[]'::jsonb END AS reasons,
      CASE WHEN pg_catalog.jsonb_typeof(d.metadata #> '{quarantine,reasons}') = 'array'
           THEN (
             SELECT COALESCE(sum((r.value ->> 'unlocated')::integer), 0)::integer
             FROM pg_catalog.jsonb_array_elements(d.metadata #> '{quarantine,reasons}') AS r(value)
             WHERE pg_catalog.jsonb_typeof(r.value -> 'unlocated') = 'number' AND (r.value ->> 'unlocated') ~ '^[0-9]{1,9}$'
           )
           ELSE 0 END AS unlocated,
      d.hidden_text_check,
      ((d.metadata #>> '{quarantine,approval_required}') = 'true' AND d.approved_at IS NULL) AS pending_approval,
      d.user_id
    FROM public.documents d
    WHERE d.status = 'quarantined' AND d.tenant_key = ANY (keys)
  )
  SELECT q.id, q.lineage_id, q.tenant_key, q.filename, q.source, q.version, q.rule_ids, q.snippets, q.quarantined_at, q.detected_by,
         q.reasons, q.unlocated, q.hidden_text_check, q.pending_approval, q.user_id,
         count(*) OVER () AS total_count
  FROM quarantined q
  ORDER BY q.quarantined_at DESC, q.id
  LIMIT page_size OFFSET skip;
END
$function$;

DROP FUNCTION IF EXISTS public.rag_release_quarantine(uuid, uuid);

CREATE FUNCTION public.rag_release_quarantine(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(outcome text, document_id uuid, version integer, superseded_document_id uuid, rule_ids text[], released_targets text[], tenant_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  doc public.documents%ROWTYPE;
  ids text[];
  targets text[];
  invoice_quarantined boolean;
  published record;
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN pg_catalog.jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT pg_catalog.jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  targets := CASE WHEN pg_catalog.jsonb_typeof(doc.metadata #> '{quarantine,reasons}') = 'array'
                  THEN ARRAY(
                    SELECT DISTINCT t.value
                    FROM pg_catalog.jsonb_array_elements(doc.metadata #> '{quarantine,reasons}') AS r(value)
                    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
                      CASE WHEN pg_catalog.jsonb_typeof(r.value -> 'targets') = 'array' THEN r.value -> 'targets' ELSE '[]'::jsonb END
                    ) AS t(value)
                    WHERE (r.value ->> 'kind') = 'untrusted_link'
                    ORDER BY t.value
                  )
                  ELSE '{}'::text[] END;
  invoice_quarantined := (doc.metadata #>> '{invoice_extraction,status}') = 'quarantined';

  UPDATE public.documents d SET
    status = 'processing',
    approved_by = p_actor,
    approved_at = pg_catalog.now(),
    metadata = COALESCE(d.metadata, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'quarantine',
        CASE WHEN pg_catalog.jsonb_typeof(d.metadata -> 'quarantine') = 'object' THEN d.metadata -> 'quarantine' ELSE '{}'::jsonb END
          || pg_catalog.jsonb_build_object(
            'released_by', p_actor::text,
            'released_at', pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'released_rule_ids', pg_catalog.to_jsonb(ids),
            'released_targets', pg_catalog.to_jsonb(targets)))
      || CASE WHEN invoice_quarantined
              THEN pg_catalog.jsonb_build_object('invoice_extraction', pg_catalog.jsonb_build_object('status', 'released_unextracted'))
              ELSE '{}'::jsonb END,
    processing_state = CASE WHEN pg_catalog.jsonb_typeof(d.processing_state -> 'quarantine') = 'object'
                            THEN pg_catalog.jsonb_set(d.processing_state, '{quarantine,released}', 'true'::jsonb)
                            ELSE d.processing_state END
  WHERE d.id = doc.id;
  UPDATE public.document_chunks c SET approved_by = p_actor WHERE c.document_id = doc.id;

  SELECT p.outcome, p.superseded_document_id INTO published FROM public.rag_publish_document_version(doc.id, doc.tenant_key) AS p;
  -- superseded_lineage (0806) is a completed release: the version is stored, retired by a confirmed link.
  IF published.outcome IS NULL OR published.outcome NOT IN ('published', 'superseded_lineage') THEN
    RAISE EXCEPTION 'release_failed: %', COALESCE(published.outcome, 'unknown');
  END IF;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('release_quarantine', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT published.outcome, doc.id, doc.version, published.superseded_document_id, ids, targets, doc.tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_not_checked(p_actor uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(document_id uuid, lineage_id uuid, tenant_key text, filename text, doc_type text, source text, uploaded_at timestamp with time zone,
               total_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  page_size integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  skip integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  SELECT d.id, d.lineage_id, d.tenant_key, d.filename, d.doc_type, d.source, d.created_at, count(*) OVER ()
  FROM public.documents d
  WHERE d.hidden_text_check = 'not_checked' AND d.is_current AND d.status = 'ready' AND d.tenant_key = ANY (keys)
  ORDER BY d.created_at DESC, d.id
  LIMIT page_size OFFSET skip;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_list_quarantine(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_quarantine(uuid, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_release_quarantine(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_release_quarantine(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_list_not_checked(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_not_checked(uuid, integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

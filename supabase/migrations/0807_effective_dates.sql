-- 0807: Effective dates on documents and chunks (plan 03.2-46; D-43, D-50; DATA-20; research F-12).
-- effective_from, effective_to, effective_dates_origin and effective_dates_confidence (0801) are a filter column only: setting them never
-- re-embeds, never touches ingest_fingerprint, and copies the two dates to every chunk of the document in the same transaction.
--   rag_set_document_effective_dates   writes the four document columns and the chunk dates, drops any stored proposal and invalidates the
--                                      semantic cache rows that name the document (rag_cache_invalidate, 0603) in the same transaction,
--                                      because the 0603 triggers only see is_current, status, version and tenant_key (F-12).
--                                      Admin path (p_actor given): origin must be admin, the tenant must be one of the actor's keys
--                                      (rag_upload_approval_keys: deployment admins, and organization owners and admins for their
--                                      organization, 0814), one rag_admin_audit row. Service path (p_actor NULL, the ingestion pipeline):
--                                      origin must be extracted, the tenant key is checked by rag_assert_tenant_key, and a document whose
--                                      dates an admin set is left as it is (outcome kept_admin), whatever the order of arrival.
--   rag_propose_document_effective_dates  service path: stores an extracted proposal that was not applied in
--                                      documents.metadata.effective_date_proposal (from, to, confidence, evidence_quote, status, proposed_at).
--                                      It changes neither the date columns nor retrieval. Refused (kept_admin) on admin-set dates.
--   rag_dismiss_effective_date_proposal  admin path: drops the stored proposal and keeps the current dates; one audit row.
--   rag_list_effective_date_proposals  admin path: documents with a stored proposal (awaiting confirmation first) or, with a query, the
--                                      documents whose file name contains it, with their current dates.
-- Bounds are inclusive; NULL on a side means unbounded; from later than to raises invalid_window (the 0801 check also refuses it).
-- No new store: proposals live on the document row and go with it, so no purge hook is needed.
-- The setter and the dismiss function are SECURITY DEFINER because they write rag_admin_audit (service_role may only read it); the other two
-- are SECURITY INVOKER. Every function: SET search_path = '', REVOKE ALL FROM PUBLIC, anon, authenticated, GRANT EXECUTE TO service_role.
-- Not folded into the setup files. Idempotent: CREATE OR REPLACE, the audit check rebuilt by name keeping every action already allowed.

BEGIN;

DO $audit_actions$
DECLARE
  allowed text[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}'::text[]) INTO allowed
  FROM pg_catalog.pg_constraint con
  CROSS JOIN LATERAL pg_catalog.regexp_matches(pg_catalog.pg_get_constraintdef(con.oid), '''([a-z_]+)''', 'g') AS m
  WHERE con.conrelid = 'public.rag_admin_audit'::regclass AND con.conname = 'rag_admin_audit_action_check';
  SELECT array_agg(DISTINCT a ORDER BY a) INTO allowed
  FROM pg_catalog.unnest(allowed || ARRAY['set_effective_dates', 'dismiss_effective_dates']) AS a;
  ALTER TABLE public.rag_admin_audit DROP CONSTRAINT IF EXISTS rag_admin_audit_action_check;
  EXECUTE pg_catalog.format(
    'ALTER TABLE public.rag_admin_audit ADD CONSTRAINT rag_admin_audit_action_check CHECK (action IN (%s))',
    (SELECT pg_catalog.string_agg(pg_catalog.quote_literal(a), ', ' ORDER BY a) FROM pg_catalog.unnest(allowed) AS a)
  );
END
$audit_actions$;

CREATE OR REPLACE FUNCTION public.rag_set_document_effective_dates(
  p_document_id uuid,
  p_tenant_key text,
  p_from date,
  p_to date,
  p_origin text,
  p_confidence real DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
 RETURNS TABLE(
   outcome text,
   document_id uuid,
   effective_from date,
   effective_to date,
   effective_dates_origin text,
   effective_dates_confidence real,
   chunks_updated integer
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
  updated integer;
BEGIN
  IF p_document_id IS NULL OR p_tenant_key IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'invalid_window';
  END IF;
  IF p_confidence IS NOT NULL AND (p_confidence < 0 OR p_confidence > 1 OR p_confidence <> p_confidence) THEN
    RAISE EXCEPTION 'invalid_confidence';
  END IF;

  IF p_actor IS NOT NULL THEN
    IF p_origin IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'invalid_origin';
    END IF;
    IF NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  ELSE
    IF p_origin IS DISTINCT FROM 'extracted' THEN
      RAISE EXCEPTION 'invalid_origin';
    END IF;
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;

  SELECT * INTO doc FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status IS DISTINCT FROM 'deleted'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF p_actor IS NULL AND doc.effective_dates_origin = 'admin' THEN
    RETURN QUERY SELECT 'kept_admin'::text, doc.id, doc.effective_from, doc.effective_to, doc.effective_dates_origin,
                        doc.effective_dates_confidence, 0;
    RETURN;
  END IF;

  UPDATE public.documents d
  SET effective_from = p_from,
      effective_to = p_to,
      effective_dates_origin = p_origin,
      effective_dates_confidence = CASE WHEN p_actor IS NOT NULL THEN NULL ELSE p_confidence END,
      metadata = COALESCE(d.metadata, '{}'::jsonb) - 'effective_date_proposal'
  WHERE d.id = doc.id;

  UPDATE public.document_chunks c
  SET effective_from = p_from, effective_to = p_to
  WHERE c.document_id = doc.id;
  GET DIAGNOSTICS updated = ROW_COUNT;

  PERFORM public.rag_cache_invalidate(doc.tenant_key, ARRAY[doc.id]);

  IF p_actor IS NOT NULL THEN
    INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
    VALUES ('set_effective_dates', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, '{}'::text[]);
  END IF;

  RETURN QUERY SELECT 'set'::text, doc.id, p_from, p_to, p_origin,
                      CASE WHEN p_actor IS NOT NULL THEN NULL::real ELSE p_confidence END, updated;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_propose_document_effective_dates(
  p_document_id uuid,
  p_tenant_key text,
  p_from date,
  p_to date,
  p_confidence real,
  p_evidence_quote text,
  p_status text
)
 RETURNS TABLE(outcome text, document_id uuid)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
BEGIN
  IF p_document_id IS NULL OR p_tenant_key IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF p_from IS NULL AND p_to IS NULL THEN
    RAISE EXCEPTION 'invalid_window';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'invalid_window';
  END IF;
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 OR p_confidence <> p_confidence THEN
    RAISE EXCEPTION 'invalid_confidence';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('awaiting_confirmation', 'low_confidence') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;
  IF p_evidence_quote IS NOT NULL AND pg_catalog.length(p_evidence_quote) > 2000 THEN
    RAISE EXCEPTION 'invalid_evidence';
  END IF;
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  SELECT * INTO doc FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status IS DISTINCT FROM 'deleted'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.effective_dates_origin = 'admin' THEN
    RETURN QUERY SELECT 'kept_admin'::text, doc.id;
    RETURN;
  END IF;

  UPDATE public.documents d
  SET metadata = COALESCE(d.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
    'effective_date_proposal',
    pg_catalog.jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'confidence', p_confidence,
      'evidence_quote', p_evidence_quote,
      'status', p_status,
      'proposed_at', pg_catalog.now()
    )
  )
  WHERE d.id = doc.id;

  RETURN QUERY SELECT 'stored'::text, doc.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_dismiss_effective_date_proposal(p_document_id uuid, p_tenant_key text, p_actor uuid)
 RETURNS TABLE(outcome text, document_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
BEGIN
  IF p_document_id IS NULL OR p_tenant_key IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;
  IF NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  SELECT * INTO doc FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status IS DISTINCT FROM 'deleted'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF NOT (COALESCE(doc.metadata, '{}'::jsonb) ? 'effective_date_proposal') THEN
    RAISE EXCEPTION 'no_proposal';
  END IF;

  UPDATE public.documents d
  SET metadata = COALESCE(d.metadata, '{}'::jsonb) - 'effective_date_proposal'
  WHERE d.id = doc.id;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('dismiss_effective_dates', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, '{}'::text[]);

  RETURN QUERY SELECT 'dismissed'::text, doc.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_effective_date_proposals(
  p_actor uuid,
  p_tenant_key text,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
 RETURNS TABLE(
   document_id uuid,
   lineage_id uuid,
   tenant_key text,
   filename text,
   version integer,
   status text,
   effective_from date,
   effective_to date,
   effective_dates_origin text,
   effective_dates_confidence real,
   proposal jsonb,
   total_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  page_size integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  skip integer := GREATEST(COALESCE(p_offset, 0), 0);
  needle text := NULLIF(pg_catalog.btrim(pg_catalog.left(COALESCE(p_query, ''), 200)), '');
  pattern text;
BEGIN
  IF p_actor IS NULL OR p_tenant_key IS NULL OR NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RETURN;
  END IF;
  IF needle IS NOT NULL THEN
    pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  RETURN QUERY
  SELECT d.id, d.lineage_id, d.tenant_key, d.filename, d.version, d.status, d.effective_from, d.effective_to,
         d.effective_dates_origin, d.effective_dates_confidence, d.metadata -> 'effective_date_proposal',
         count(*) OVER ()
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND ((d.is_current AND d.status = 'ready') OR d.status IN ('pending_review', 'quarantined'))
    AND CASE
          WHEN pattern IS NULL THEN COALESCE(d.metadata, '{}'::jsonb) ? 'effective_date_proposal'
          ELSE d.filename ILIKE pattern ESCAPE '\'
        END
  ORDER BY
    (d.metadata -> 'effective_date_proposal' ->> 'status') IS NOT DISTINCT FROM 'awaiting_confirmation' DESC,
    d.filename, d.id
  LIMIT page_size OFFSET skip;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_set_document_effective_dates(uuid, text, date, date, text, real, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_document_effective_dates(uuid, text, date, date, text, real, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_propose_document_effective_dates(uuid, text, date, date, real, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_propose_document_effective_dates(uuid, text, date, date, real, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_dismiss_effective_date_proposal(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_dismiss_effective_date_proposal(uuid, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_list_effective_date_proposals(uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_effective_date_proposals(uuid, text, text, integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

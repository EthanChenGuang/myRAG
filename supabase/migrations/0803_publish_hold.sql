-- 0803: Publish hold and upload approval (plan 03.2-12; D-12, D-36, D-37; research F-1, Pattern 4; SEC-09, LANG-04).
-- One hold mechanism, enforced in rag_publish_document_version (body from 0425, signature and grants unchanged): a pending_review document
-- returns outcome pending_review and a document whose metadata carries publish_hold returns outcome held, both before any lineage lock or
-- version swap, so a held document supersedes nothing, swaps no version and invalidates no cache entry. The quarantined branch stays first
-- (quarantine wins over pending and held).
-- rag_hold_document_for_review moves a processing document and its chunks to pending_review (the publish stage calls it, plan 14).
-- rag_approve_upload and rag_reject_upload are modelled on rag_release_quarantine: access from rag_admin_tenant_keys (the Quarantine panel
-- rule, through rag_upload_approval_keys so a non-admin gets not_found), FOR UPDATE with the status checked after the lock, publish or soft
-- delete through the existing functions, one rag_admin_audit row. An approval older than the lineage's current version is refused with
-- superseded_by_newer. rag_list_pending_uploads lists the actor's pending uploads oldest first.
-- rag_upload_approval_exemptions (RLS on, no policies) with actor-scoped add, remove and list, the pipeline read rag_upload_exemptions_for,
-- rag_is_tenant_admin, rag_release_publish_hold and ingestion_batches.hold_publish (D-12).
-- Every function here is service_role only: REVOKE ALL FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature.
-- Not folded into the setup files. Idempotent: CREATE OR REPLACE, IF NOT EXISTS, constraints rebuilt by name. Re-running 0425 puts back the
-- old publish body: re-run this file after it (research Pitfall 9).

BEGIN;

ALTER TABLE public.rag_admin_audit DROP CONSTRAINT IF EXISTS rag_admin_audit_action_check;
ALTER TABLE public.rag_admin_audit ADD CONSTRAINT rag_admin_audit_action_check CHECK (
  action IN (
    'release_quarantine',
    'delete_quarantined',
    'retry_ingestion_job',
    'delete_ingestion_job',
    'set_parse_tier_override',
    'approve_upload',
    'reject_upload'
  )
);

-- Batch-held publishing (D-12, research F-1): a batch with hold_publish writes its versions with metadata.publish_hold, so the publish
-- function returns held until rag_release_publish_hold clears it at activation.
ALTER TABLE public.ingestion_batches ADD COLUMN IF NOT EXISTS hold_publish boolean NOT NULL DEFAULT false;

-- Upload-approval exemptions (D-37). Server role only: RLS on without policies, nothing granted to anon or authenticated, and service_role
-- reads only; every write goes through the actor-scoped functions below.
CREATE TABLE IF NOT EXISTS public.rag_upload_approval_exemptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  kind text NOT NULL,
  ref text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_upload_approval_exemptions_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_upload_approval_exemptions_kind_check CHECK (kind IN ('connector', 'uploader')),
  CONSTRAINT rag_upload_approval_exemptions_ref_check CHECK (pg_catalog.btrim(ref) <> '' AND pg_catalog.length(ref) <= 512),
  CONSTRAINT rag_upload_approval_exemptions_unique UNIQUE (tenant_key, kind, ref)
);

ALTER TABLE public.rag_upload_approval_exemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_upload_approval_exemptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rag_upload_approval_exemptions TO service_role;

CREATE OR REPLACE FUNCTION public.rag_publish_document_version(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(outcome text, document_id uuid, version integer, superseded_document_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
  previous public.documents%ROWTYPE;
  has_slug boolean;
  moved_type text;
  moved_slug text;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status = 'quarantined' THEN
    RETURN QUERY SELECT 'quarantined'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;
  IF doc.status = 'pending_review' THEN
    RETURN QUERY SELECT 'pending_review'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;
  IF doc.metadata ? 'publish_hold' THEN
    RETURN QUERY SELECT 'held'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_publishable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF doc.is_current AND doc.status = 'ready' THEN
    RETURN QUERY SELECT 'already_current'::text, doc.id, doc.version, NULL::uuid;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(doc.tenant_key || '|' || doc.source || '|' || doc.source_key, 0));

  has_slug := (
    SELECT count(*) = 2 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname IN ('content_type', 'slug') AND NOT attisdropped
  );

  SELECT * INTO previous FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = doc.source AND d.source_key = doc.source_key AND d.is_current AND d.id <> doc.id
  FOR UPDATE;
  IF FOUND THEN
    IF has_slug THEN
      EXECUTE 'SELECT content_type, slug FROM public.documents WHERE id = $1' INTO moved_type, moved_slug USING previous.id;
    END IF;
    UPDATE public.documents d SET is_current = false, superseded_by = doc.id WHERE d.id = previous.id;
    IF has_slug THEN
      EXECUTE 'UPDATE public.documents SET content_type = NULL, slug = NULL WHERE id = $1' USING previous.id;
    END IF;
    UPDATE public.document_chunks c SET is_current = false, embedding = NULL WHERE c.document_id = previous.id;
    DELETE FROM public.chunk_embeddings ce USING public.document_chunks c WHERE ce.chunk_id = c.id AND c.document_id = previous.id;
    DELETE FROM public.embedding_backfill_gaps g USING public.document_chunks c WHERE g.chunk_id = c.id AND c.document_id = previous.id;
  END IF;

  UPDATE public.documents d SET is_current = true, status = 'ready' WHERE d.id = doc.id;
  IF previous.id IS NOT NULL AND has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
    EXECUTE 'UPDATE public.documents SET content_type = $2, slug = $3 WHERE id = $1' USING doc.id, moved_type, moved_slug;
  END IF;
  UPDATE public.document_chunks c SET is_current = true, status = 'ready' WHERE c.document_id = doc.id;

  RETURN QUERY SELECT 'published'::text, doc.id, doc.version, previous.id;
END
$function$;

-- The publish stage's hold (plan 14): only a processing document can be held; a quarantined, ready, failed, deleted or already pending
-- document is refused with not_holdable, so quarantine wins and a decided document is never re-held.
CREATE OR REPLACE FUNCTION public.rag_hold_document_for_review(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(outcome text, document_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION 'not_holdable' USING DETAIL = 'status is ' || COALESCE(doc.status, '(null)');
  END IF;

  UPDATE public.documents d SET status = 'pending_review' WHERE d.id = doc.id;
  UPDATE public.document_chunks c SET status = 'pending_review' WHERE c.document_id = doc.id;

  RETURN QUERY SELECT 'pending_review'::text, doc.id, doc.version;
END
$function$;

-- Admin access for the upload-approval functions: the actor's rag_admin_tenant_keys, or no key when the actor is not an admin, so a
-- non-admin and an admin of another tenant both get not_found.
CREATE OR REPLACE FUNCTION public.rag_upload_approval_keys(p_actor uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN public.rag_admin_tenant_keys(p_actor);
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'not_admin' THEN
    RETURN '{}'::text[];
  END IF;
  RAISE;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_approve_upload(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(outcome text, document_id uuid, version integer, superseded_document_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  doc public.documents%ROWTYPE;
  published record;
BEGIN
  keys := public.rag_upload_approval_keys(p_actor);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status IS DISTINCT FROM 'pending_review' THEN
    RAISE EXCEPTION 'not_pending';
  END IF;

  -- The lineage lock the publish function takes, so no newer version can become current between this check and the publish.
  PERFORM pg_advisory_xact_lock(hashtextextended(doc.tenant_key || '|' || doc.source || '|' || doc.source_key, 0));
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.tenant_key = doc.tenant_key AND d.source = doc.source AND d.source_key = doc.source_key
      AND d.is_current AND d.id <> doc.id AND d.version > doc.version
  ) THEN
    RAISE EXCEPTION 'superseded_by_newer';
  END IF;

  UPDATE public.documents d SET status = 'processing', approved_by = p_actor, approved_at = now() WHERE d.id = doc.id;
  UPDATE public.document_chunks c SET approved_by = p_actor WHERE c.document_id = doc.id;

  SELECT p.outcome, p.superseded_document_id INTO published FROM public.rag_publish_document_version(doc.id, doc.tenant_key) AS p;
  IF published.outcome IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'approve_failed: %', COALESCE(published.outcome, 'unknown');
  END IF;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('approve_upload', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, '{}'::text[]);

  RETURN QUERY SELECT published.outcome, doc.id, doc.version, published.superseded_document_id;
END
$function$;

-- Reject (D-36: reject is the soft delete, Phase 3.1 D-27). A pending document that is the only live version of its lineage goes through
-- rag_soft_delete_document (lineage deleted, delete ledger row for the vector-sync outbox). A pending new version of a lineage that still
-- has a live version is soft-deleted alone with the same row changes, because the seam deletes every version of the lineage and the current
-- version must stay untouched.
CREATE OR REPLACE FUNCTION public.rag_reject_upload(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(outcome text, document_id uuid, lineage_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  doc public.documents%ROWTYPE;
  deleted_outcome text;
BEGIN
  keys := public.rag_upload_approval_keys(p_actor);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status IS DISTINCT FROM 'pending_review' THEN
    RAISE EXCEPTION 'not_pending';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(doc.tenant_key || '|' || doc.source || '|' || doc.source_key, 0));
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.tenant_key = doc.tenant_key AND d.lineage_id = doc.lineage_id AND d.id <> doc.id
      AND (d.is_current OR d.status IN ('processing', 'ready', 'pending_review', 'quarantined'))
  ) THEN
    UPDATE public.documents d SET is_current = false, status = 'deleted' WHERE d.id = doc.id;
    UPDATE public.document_chunks c SET is_current = false, status = 'deleted', embedding = NULL WHERE c.document_id = doc.id;
    deleted_outcome := 'deleted';
  ELSE
    SELECT s.outcome INTO deleted_outcome FROM public.rag_soft_delete_document(doc.tenant_key, doc.lineage_id, doc.source) AS s;
    IF deleted_outcome IS DISTINCT FROM 'deleted' THEN
      RAISE EXCEPTION 'reject_failed: %', COALESCE(deleted_outcome, 'unknown');
    END IF;
  END IF;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('reject_upload', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, '{}'::text[]);

  RETURN QUERY SELECT deleted_outcome, doc.id, doc.lineage_id, doc.version;
END
$function$;

-- Pending uploads of the actor's tenants, oldest first with the id as tie-break. new_version: the lineage has a current version that the
-- approval would replace. A p_tenant_key outside the actor's keys returns nothing.
CREATE OR REPLACE FUNCTION public.rag_list_pending_uploads(p_actor uuid, p_tenant_key text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(document_id uuid, lineage_id uuid, tenant_key text, filename text, source text, doc_type text, version integer, uploader_id uuid, uploaded_at timestamp with time zone, new_version boolean, total_count bigint)
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
  keys := public.rag_upload_approval_keys(p_actor);
  IF p_tenant_key IS NOT NULL THEN
    keys := CASE WHEN p_tenant_key = ANY (keys) THEN ARRAY[p_tenant_key] ELSE '{}'::text[] END;
  END IF;
  RETURN QUERY
  SELECT d.id, d.lineage_id, d.tenant_key, d.filename, d.source, d.doc_type, d.version, d.user_id, d.created_at,
         EXISTS (
           SELECT 1 FROM public.documents cur
           WHERE cur.tenant_key = d.tenant_key AND cur.lineage_id = d.lineage_id AND cur.is_current AND cur.id <> d.id
         ),
         count(*) OVER ()
  FROM public.documents d
  WHERE d.status = 'pending_review' AND d.tenant_key = ANY (keys)
  ORDER BY d.created_at, d.id
  LIMIT page_size OFFSET skip;
END
$function$;

-- Whether p_user may approve uploads of p_tenant_key: the Quarantine panel access rule (rag_admin_tenant_keys); the pipeline asks it in
-- identify (plan 14). The tenant key is asserted first.
CREATE OR REPLACE FUNCTION public.rag_is_tenant_admin(p_user uuid, p_tenant_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN p_user IS NOT NULL AND p_tenant_key = ANY (public.rag_upload_approval_keys(p_user));
END
$function$;

-- Clears the batch publish hold of one document of the caller's tenant; publishing stays a separate call to the publish function.
CREATE OR REPLACE FUNCTION public.rag_release_publish_hold(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(outcome text, document_id uuid)
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.metadata IS NULL OR NOT (doc.metadata ? 'publish_hold') THEN
    RETURN QUERY SELECT 'not_held'::text, doc.id;
    RETURN;
  END IF;
  UPDATE public.documents d SET metadata = d.metadata - 'publish_hold' WHERE d.id = doc.id;
  RETURN QUERY SELECT 'released'::text, doc.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_upload_exemption_add(p_actor uuid, p_tenant_key text, p_kind text, p_ref text)
 RETURNS TABLE(outcome text, id uuid, tenant_key text, kind text, ref text, created_by uuid, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  clean_ref text := pg_catalog.btrim(COALESCE(p_ref, ''));
  entry public.rag_upload_approval_exemptions%ROWTYPE;
  result text := 'added';
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT (p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('connector', 'uploader') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF clean_ref = '' OR pg_catalog.length(clean_ref) > 512 THEN
    RAISE EXCEPTION 'invalid_ref' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rag_upload_approval_exemptions AS e (tenant_key, kind, ref, created_by)
  VALUES (p_tenant_key, p_kind, clean_ref, p_actor)
  ON CONFLICT ON CONSTRAINT rag_upload_approval_exemptions_unique DO NOTHING
  RETURNING e.* INTO entry;
  IF entry.id IS NULL THEN
    result := 'exists';
    SELECT e.* INTO entry FROM public.rag_upload_approval_exemptions e
    WHERE e.tenant_key = p_tenant_key AND e.kind = p_kind AND e.ref = clean_ref;
  END IF;

  RETURN QUERY SELECT result, entry.id, entry.tenant_key, entry.kind, entry.ref, entry.created_by, entry.created_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_upload_exemption_remove(p_actor uuid, p_exemption_id uuid)
 RETURNS TABLE(outcome text, id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  removed uuid;
BEGIN
  DELETE FROM public.rag_upload_approval_exemptions e
  WHERE e.id = p_exemption_id AND e.tenant_key = ANY (public.rag_upload_approval_keys(p_actor))
  RETURNING e.id INTO removed;
  IF removed IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  RETURN QUERY SELECT 'removed'::text, removed;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_upload_exemption_list(p_actor uuid, p_tenant_key text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, tenant_key text, kind text, ref text, created_by uuid, created_at timestamp with time zone, total_count bigint)
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
  keys := public.rag_upload_approval_keys(p_actor);
  IF p_tenant_key IS NOT NULL THEN
    keys := CASE WHEN p_tenant_key = ANY (keys) THEN ARRAY[p_tenant_key] ELSE '{}'::text[] END;
  END IF;
  RETURN QUERY
  SELECT e.id, e.tenant_key, e.kind, e.ref, e.created_by, e.created_at, count(*) OVER ()
  FROM public.rag_upload_approval_exemptions e
  WHERE e.tenant_key = ANY (keys)
  ORDER BY e.created_at, e.id
  LIMIT page_size OFFSET skip;
END
$function$;

-- The pipeline's read of a tenant's exemptions (plan 14), on the service-role client with the tenant key as the only input.
CREATE OR REPLACE FUNCTION public.rag_upload_exemptions_for(p_tenant_key text)
 RETURNS TABLE(kind text, ref text)
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT e.kind, e.ref FROM public.rag_upload_approval_exemptions e WHERE e.tenant_key = p_tenant_key ORDER BY e.kind, e.ref;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_publish_document_version(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_publish_document_version(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_hold_document_for_review(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_hold_document_for_review(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_upload_approval_keys(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_upload_approval_keys(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_approve_upload(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_approve_upload(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.rag_reject_upload(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_reject_upload(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_list_pending_uploads(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_pending_uploads(uuid, text, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.rag_is_tenant_admin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_is_tenant_admin(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_release_publish_hold(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_release_publish_hold(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_upload_exemption_add(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_upload_exemption_add(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_upload_exemption_remove(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_upload_exemption_remove(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_upload_exemption_list(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_upload_exemption_list(uuid, text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_upload_exemptions_for(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_upload_exemptions_for(text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

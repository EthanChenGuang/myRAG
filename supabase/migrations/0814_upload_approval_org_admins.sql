-- Phase 3.2 plan 16 (D-37, D-50): organization admins approve uploads of their own organization.
-- 0803 gave the upload-approval functions the Quarantine panel keys (rag_admin_tenant_keys), which require admin_users, so an owner or admin
-- of an organization who is not a deployment admin could neither approve nor be recognised as an admin of it. This rebuilds the shared key
-- helper only: a deployment admin keeps rag_admin_tenant_keys unchanged; in multi-tenant mode an owner or admin of an organization also gets
-- that organization's key. A personal workspace (u:) stays with deployment admins. rag_admin_tenant_keys itself, and with it Quarantine,
-- is not changed. rag_approve_upload, rag_reject_upload, rag_list_pending_uploads, the exemption functions and rag_is_tenant_admin read
-- this helper, so they follow without being redefined. Idempotent; body from 0803 with the same signature, grants and search_path.

CREATE OR REPLACE FUNCTION public.rag_upload_approval_keys(p_actor uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  keys text[] := '{}'::text[];
  multi_tenant boolean;
BEGIN
  IF p_actor IS NULL THEN
    RETURN keys;
  END IF;
  BEGIN
    keys := public.rag_admin_tenant_keys(p_actor);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'not_admin' THEN
      RAISE;
    END IF;
    keys := '{}'::text[];
  END;

  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    keys := keys || COALESCE(
      (
        SELECT pg_catalog.array_agg(DISTINCT 'o:' || m.organization_id::text)
        FROM public.organization_members m
        WHERE m.user_id = p_actor AND m.role IN ('owner', 'admin') AND NOT (('o:' || m.organization_id::text) = ANY (keys))
      ),
      '{}'::text[]
    );
  END IF;
  RETURN keys;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_upload_approval_keys(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_upload_approval_keys(uuid) TO service_role;

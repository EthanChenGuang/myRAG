-- 0411: Every public SECURITY DEFINER function has a fixed search_path (03-48 follow-up 3, MEDIUM-3; Supabase linter 0011 function_search_path_mutable).
-- Thirteen multi-tenant definer functions were created without one: they resolve unqualified table names (folders, chats, organizations,
-- admin_users, organization_members, user_preferences) through the caller's search_path, where pg_temp is searched first for relations, so a role that
-- can run its own SQL could shadow them with a temporary table while the function runs as its owner. The single-tenant setup already uses
-- SET search_path = pg_catalog, public on its versions; the multi-tenant setup now does too and this migration repairs databases created earlier.
--
-- Only the function configuration changes: no body, signature or grant is touched (ALTER FUNCTION ... SET keeps the ACL).
-- Each function is guarded with to_regprocedure, so the file is safe on single-tenant and multi-tenant databases.
-- tests/rag/security-definer-search-path.test.ts fails when a SECURITY DEFINER function in the setup files, migrations or patches has no search_path.
-- Idempotent: safe to run more than once.

BEGIN;

DO $definer_search_path$
BEGIN
  IF to_regprocedure('public.can_view_org_member(uuid, uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.can_view_org_member(uuid, uuid) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.check_admin_status()') IS NOT NULL THEN
    ALTER FUNCTION public.check_admin_status() SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.delete_folder(uuid, boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.delete_folder(uuid, boolean) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.get_admin_organization_id()') IS NOT NULL THEN
    ALTER FUNCTION public.get_admin_organization_id() SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.get_folder_stats(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.get_folder_stats(uuid) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.get_user_current_org()') IS NOT NULL THEN
    ALTER FUNCTION public.get_user_current_org() SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.get_user_org_ids(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.get_user_org_ids(uuid) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.get_user_role_in_org(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.get_user_role_in_org(uuid) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.is_admin(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.is_admin(uuid) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.move_chats_to_folder(uuid[], uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.move_chats_to_folder(uuid[], uuid) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.share_chat(uuid, jsonb)') IS NOT NULL THEN
    ALTER FUNCTION public.share_chat(uuid, jsonb) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.share_personal_organization(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.share_personal_organization(uuid) SET search_path = pg_catalog, public;
  END IF;
  IF to_regprocedure('public.unshare_chat(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.unshare_chat(uuid) SET search_path = pg_catalog, public;
  END IF;
END
$definer_search_path$;

COMMIT;

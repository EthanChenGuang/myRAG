-- 0920 (multi-tenant): a group belongs to one organization. organization_id is NOT NULL with a cascading foreign key to organizations;
-- tenant_key is generated as o:<organization_id>, the same expression as documents.tenant_key and scopeKey(); (tenant_key, key) is unique
-- (D-01). A member insert is refused with not_a_workspace_member unless the user has an organization_members row of the group's
-- organization; deleting that organization_members row removes the user's memberships in that organization's groups (D-04, RESEARCH 4).
-- rag_access_group_members_require_org_member is SECURITY INVOKER (members are written by service_role only);
-- rag_access_groups_on_org_member_delete is SECURITY DEFINER because the role that deletes an organization_members row may not read the
-- group tables. Both have SET search_path = '' and service_role execute only. Idempotent.

BEGIN;

ALTER TABLE public.rag_access_groups ADD COLUMN IF NOT EXISTS organization_id uuid NOT NULL;
ALTER TABLE public.rag_access_groups ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS ('o:' || organization_id::text) STORED;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_access_groups'::regclass AND conname = 'rag_access_groups_organization_id_fkey'
  ) THEN
    ALTER TABLE public.rag_access_groups
      ADD CONSTRAINT rag_access_groups_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_access_groups'::regclass AND conname = 'rag_access_groups_tenant_key_key'
  ) THEN
    ALTER TABLE public.rag_access_groups
      ADD CONSTRAINT rag_access_groups_tenant_key_key UNIQUE (tenant_key, key);
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS rag_access_groups_organization_idx ON public.rag_access_groups (organization_id);

CREATE OR REPLACE FUNCTION public.rag_access_group_members_require_org_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.rag_access_groups g
    JOIN public.organization_members m ON m.organization_id = g.organization_id
    WHERE g.id = NEW.group_id AND m.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'not_a_workspace_member' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_members_require_org_member() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_members_require_org_member() TO service_role;

DROP TRIGGER IF EXISTS rag_access_group_members_require_org_member ON public.rag_access_group_members;
CREATE TRIGGER rag_access_group_members_require_org_member
  BEFORE INSERT OR UPDATE OF group_id, user_id ON public.rag_access_group_members
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_group_members_require_org_member();

CREATE OR REPLACE FUNCTION public.rag_access_groups_on_org_member_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_access_group_members gm
  USING public.rag_access_groups g
  WHERE gm.group_id = g.id
    AND g.organization_id = OLD.organization_id
    AND gm.user_id = OLD.user_id;
  RETURN OLD;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_on_org_member_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_on_org_member_delete() TO service_role;

DROP TRIGGER IF EXISTS rag_access_groups_on_org_member_delete ON public.organization_members;
CREATE TRIGGER rag_access_groups_on_org_member_delete
  AFTER DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_on_org_member_delete();

NOTIFY pgrst, 'reload schema';

COMMIT;

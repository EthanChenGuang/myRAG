-- NF-1 production apply (owner desk). DO NOT run from an agent session.
-- Same effect as supabase/migrations/0989_chats_shared_rls{,.single-tenant,.multi-tenant}.sql.
-- Removes shared = true from the chats SELECT policies so anon and other users can no longer list shared chats
-- through PostgREST. Shared links keep working: /shared/[shareId] and /api/chats/[shareId] read one chat by
-- share_id with the service-role client, which RLS does not restrict.
-- Idempotent. The mode is detected from the policy names, so the same file serves single- and multi-tenant projects.
-- Run in the Supabase SQL editor (or psql as postgres) on the production project.

BEGIN;

DROP POLICY IF EXISTS "Allow public access to shared chats" ON public.chats;

DO $$
BEGIN
  -- Single-tenant policy name.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chats' AND policyname = 'Users can view their own chats') THEN
    DROP POLICY "Users can view their own chats" ON public.chats;
    CREATE POLICY "Users can view their own chats"
      ON public.chats FOR SELECT
      USING ((SELECT auth.uid()) = user_id);
    RAISE NOTICE '[NF-1] single-tenant SELECT policy replaced';
  END IF;

  -- Multi-tenant policy name.
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chats' AND policyname = 'Users can view chats') THEN
    DROP POLICY "Users can view chats" ON public.chats;
    CREATE POLICY "Users can view chats" ON public.chats
      FOR SELECT USING (
        (user_id = auth.uid() AND organization_id IS NULL)
        OR
        (user_id = auth.uid() AND organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
      );
    RAISE NOTICE '[NF-1] multi-tenant SELECT policy replaced';
  END IF;
END
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Checks after apply (read-only).
-- ---------------------------------------------------------------------------

-- 1. Every chats policy. Expect the four own-row policies of your mode (SELECT, INSERT, UPDATE, DELETE) and nothing else.
SELECT policyname, cmd, roles, permissive, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'chats'
ORDER BY cmd, policyname;

-- 2. No chats policy mentions shared. Expect 0 rows.
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'chats'
  AND (coalesce(qual, '') ~* 'shared' OR coalesce(with_check, '') ~* 'shared');

-- 3. RLS is still enabled on chats. Expect relrowsecurity = true.
SELECT relname, relrowsecurity FROM pg_class WHERE oid = 'public.chats'::regclass;

-- 4. What anon sees now (rolled back, changes nothing). Expect anon_shared_rows = 0.
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;
SELECT count(*) AS anon_shared_rows FROM public.chats WHERE shared = true;
ROLLBACK;

-- 5. Shared links still resolve for the service role (the role the share page and route use). Expect > 0 if any chat is shared.
SELECT count(*) AS shared_chats_for_service_role FROM public.chats WHERE shared = true AND share_id IS NOT NULL;

-- After the checks: open one existing /shared/<share_id> link in the browser and confirm it renders.

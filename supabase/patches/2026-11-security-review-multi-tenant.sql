-- Security review gap fixes for multi-tenant databases:
--   ME-03 nango_connections / nango_sync_records writable only by the service role
--   LO-05 tool_execution_states rows must carry the caller's user_id
--   LO-06 duplicate nango connection_id rows removed before the UNIQUE constraint
--   hardening of SECURITY DEFINER functions that trusted a caller-supplied id:
--     get_workspace_context, get_user_org_ids, get_admin_organization_id (service_role only),
--     is_org_member, create_organization_safe, is_subscribed, get_nango_stats (bound to the caller), is_admin (not anon)
--   organizations / organization_members policies rewritten on SECURITY DEFINER helpers (is_org_owner, is_org_admin,
--     is_org_member): the two SELECT policies referenced each other and every user-client query failed with 42P17
-- For databases created from an earlier multi-tenant-setup.sql. Idempotent: safe to run more than once.
-- Run in the Supabase SQL editor as the postgres role BEFORE deploying the matching application code.

BEGIN;

ALTER TABLE tool_execution_states ADD COLUMN IF NOT EXISTS user_id UUID;

DROP POLICY IF EXISTS "Users can view own tool states" ON tool_execution_states;
DROP POLICY IF EXISTS "Users can insert tool states" ON tool_execution_states;
DROP POLICY IF EXISTS "Users can update tool states" ON tool_execution_states;

CREATE POLICY "Users can view own tool states" ON tool_execution_states
  FOR SELECT USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chats
      WHERE chats.id = tool_execution_states.chat_id
        AND chats.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert tool states" ON tool_execution_states
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chats
      WHERE chats.id = tool_execution_states.chat_id
        AND chats.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update tool states" ON tool_execution_states
  FOR UPDATE USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chats
      WHERE chats.id = tool_execution_states.chat_id
        AND chats.user_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chats
      WHERE chats.id = tool_execution_states.chat_id
        AND chats.user_id = auth.uid()
    )
  );


-- One Nango connection may belong to exactly one user.
-- Rows that already share a connection_id (created before this constraint existed) are reduced to the oldest
-- row per connection_id, deterministically (created_at, then id), so this step succeeds on every run.
DO $$
DECLARE
  removed integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'unique_nango_connection_id'
      AND conrelid = 'public.nango_connections'::regclass
  ) THEN
    DELETE FROM public.nango_connections nc
    USING (
      SELECT id,
             row_number() OVER (
               PARTITION BY connection_id
               ORDER BY created_at ASC NULLS LAST, id ASC
             ) AS rn
      FROM public.nango_connections
    ) ranked
    WHERE nc.id = ranked.id AND ranked.rn > 1;
    GET DIAGNOSTICS removed = ROW_COUNT;
    IF removed > 0 THEN
      RAISE NOTICE 'nango_connections: removed % duplicate connection_id rows', removed;
    END IF;

    ALTER TABLE public.nango_connections
      ADD CONSTRAINT unique_nango_connection_id UNIQUE (connection_id);
  END IF;
END $$;

-- Nango tables
-- Connections are written only by the server (service role) after it has checked the Nango end_user.
-- Users get no INSERT/UPDATE/DELETE: a user-written connection_id would bypass that check.
DROP POLICY IF EXISTS "Users can insert own connections" ON nango_connections;
DROP POLICY IF EXISTS "Users can update own connections" ON nango_connections;
DROP POLICY IF EXISTS "Users can delete own connections" ON nango_connections;
REVOKE INSERT, UPDATE, DELETE ON nango_connections FROM anon, authenticated;

-- Sync records are written only by the server (service role).
DROP POLICY IF EXISTS "Users can insert own sync records" ON nango_sync_records;
DROP POLICY IF EXISTS "Users can update own sync records" ON nango_sync_records;
REVOKE INSERT, UPDATE, DELETE ON nango_sync_records FROM anon, authenticated;

-- Helper function to get connection statistics. Callers see only their own connections; service_role may ask for any user.
CREATE OR REPLACE FUNCTION get_nango_stats(p_user_id UUID)
RETURNS TABLE (
  provider TEXT,
  status TEXT,
  last_sync_at TIMESTAMPTZ,
  synced_files_count BIGINT,
  failed_files_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    nc.provider,
    nc.status,
    nc.last_sync_at,
    COUNT(CASE WHEN nsr.status = 'completed' THEN 1 END) AS synced_files_count,
    COUNT(CASE WHEN nsr.status = 'failed' THEN 1 END) AS failed_files_count
  FROM nango_connections nc
  LEFT JOIN nango_sync_records nsr
    ON nc.connection_id = nsr.connection_id AND nsr.user_id = nc.user_id
  WHERE nc.user_id = p_user_id
    AND (p_user_id = auth.uid() OR auth.role() = 'service_role')
  GROUP BY nc.provider, nc.status, nc.last_sync_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION get_nango_stats(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_nango_stats(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION is_org_member(org_id UUID, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN COALESCE(
    (check_user_id = auth.uid() OR auth.role() = 'service_role')
    AND EXISTS (
      SELECT 1 FROM organization_members
      WHERE organization_id = org_id AND user_id = check_user_id
    ),
    false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

COMMENT ON FUNCTION is_org_member IS 'Helper function to check organization membership without causing RLS recursion. Answers only for the calling user (or service_role).';

REVOKE EXECUTE ON FUNCTION is_org_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_org_member(UUID, UUID) TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION create_organization_safe(
  p_name TEXT,
  p_slug TEXT,
  p_owner_id UUID,
  p_is_personal BOOLEAN DEFAULT true
)
RETURNS organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org organizations;
  v_max_team_members INT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND p_owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not authorized to create an organization for another user' USING ERRCODE = '42501';
  END IF;

  -- Set team member limit based on organization type
  -- Personal projects: 1 member (owner only)
  -- Collaborative projects: 5 members (can invite)
  IF p_is_personal THEN
    v_max_team_members := 1;
  ELSE
    v_max_team_members := 5;
  END IF;

  -- Insert the organization
  INSERT INTO organizations (
    name,
    slug,
    owner_id,
    is_personal,
    max_team_members,
    subscription_tier,
    storage_limit_bytes,
    max_documents,
    max_monthly_messages
  ) VALUES (
    p_name,
    p_slug,
    p_owner_id,
    p_is_personal,
    v_max_team_members,
    'free',
    1073741824,  -- 1GB default
    50,          -- 50 documents default
    100          -- 100 messages default
  )
  RETURNING * INTO v_org;

  -- IMPORTANT: Also add the creator as owner member
  -- This ensures the user can immediately access the organization
  INSERT INTO organization_members (
    organization_id,
    user_id,
    role
  ) VALUES (
    v_org.id,
    p_owner_id,
    'owner'
  );

  RETURN v_org;
END;
$$;

COMMENT ON FUNCTION create_organization_safe IS 'Safely creates an organization and adds the creator as owner member. Uses SECURITY DEFINER to bypass RLS.';

REVOKE EXECUTE ON FUNCTION create_organization_safe(TEXT, TEXT, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_organization_safe(TEXT, TEXT, UUID, BOOLEAN) TO authenticated, service_role;

-- SECURITY DEFINER and trusts the caller-supplied user id: only the server-side service role may execute it.
REVOKE EXECUTE ON FUNCTION get_workspace_context(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_workspace_context(text, uuid) TO service_role;

-- SECURITY DEFINER and trusts the caller-supplied user id: only the server-side service role may execute it.
REVOKE EXECUTE ON FUNCTION get_user_org_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_user_org_ids(uuid) TO service_role;

-- Creates a row when missing and takes no caller identity: only the server-side service role may execute it.
REVOKE EXECUTE ON FUNCTION get_admin_organization_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_admin_organization_id() TO service_role;

REVOKE EXECUTE ON FUNCTION is_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_admin(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION is_subscribed(user_uuid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE(
    (user_uuid = auth.uid() OR auth.role() = 'service_role')
    AND EXISTS (
      SELECT 1
      FROM subscriptions
      WHERE user_id = user_uuid
      AND status = 'active'
      AND plan_type IN ('pro', 'enterprise')
    ),
    false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION is_subscribed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_subscribed(uuid) TO authenticated, service_role;

-- Policy helpers: SECURITY DEFINER, fixed search_path, keyed on auth.uid(). They read organizations and
-- organization_members without re-entering RLS, which breaks the policy cycle between the two tables.
CREATE OR REPLACE FUNCTION is_org_owner(org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM organizations o WHERE o.id = org_id AND o.owner_id = auth.uid()),
    false
  );
$$;

COMMENT ON FUNCTION is_org_owner IS 'True when the calling user owns the organization. Used by RLS policies without re-entering RLS.';

REVOKE EXECUTE ON FUNCTION is_org_owner(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_org_owner(UUID) TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION is_org_admin(org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.organization_id = org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    ),
    false
  );
$$;

COMMENT ON FUNCTION is_org_admin IS 'True when the calling user is an owner or admin member of the organization. Used by RLS policies without re-entering RLS.';

REVOKE EXECUTE ON FUNCTION is_org_admin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_org_admin(UUID) TO authenticated, anon, service_role;

DROP POLICY IF EXISTS "Users can view their organizations" ON organizations;
DROP POLICY IF EXISTS "Users can update organizations" ON organizations;
DROP POLICY IF EXISTS "Users can view org members" ON organization_members;
DROP POLICY IF EXISTS "Admins can add members" ON organization_members;
DROP POLICY IF EXISTS "Admins can remove members" ON organization_members;

CREATE POLICY "Users can view their organizations" ON organizations
  FOR SELECT USING (
    (is_personal = true AND owner_id = auth.uid())
    OR
    (is_personal = false AND is_org_member(id, auth.uid()))
  );

CREATE POLICY "Users can update organizations" ON organizations
  FOR UPDATE USING (
    (is_personal = true AND owner_id = auth.uid())
    OR
    (is_personal = false AND is_org_admin(id))
  );

CREATE POLICY "Users can view org members" ON organization_members
  FOR SELECT USING (
    is_org_owner(organization_id)
    OR
    user_id = auth.uid()
  );

CREATE POLICY "Admins can add members" ON organization_members
  FOR INSERT WITH CHECK (
    is_org_owner(organization_id)
  );

CREATE POLICY "Admins can remove members" ON organization_members
  FOR DELETE USING (
    is_org_owner(organization_id)
  );

COMMIT;

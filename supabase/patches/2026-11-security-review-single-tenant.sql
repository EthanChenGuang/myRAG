-- Security review gap fixes for single-tenant databases:
--   CR-01 knowledge-base writes limited to owners and admins, read_only_doc_dashboard enforced
--   ME-03 nango_connections / nango_sync_records writable only by the service role
--   LO-05 tool_execution_states rows must carry the caller's user_id
--   LO-06 duplicate nango connection_id rows removed before the UNIQUE constraint
--   hardening of is_admin, check_admin_status, is_subscribed, get_nango_stats
-- For databases created from an earlier single-tenant-setup.sql. Idempotent: safe to run more than once.
-- Run in the Supabase SQL editor as the postgres role BEFORE deploying the matching application code.

BEGIN;

ALTER TABLE tool_execution_states ADD COLUMN IF NOT EXISTS user_id uuid;

-- Owner of a knowledge-base document. NULL for documents stored before ownership was recorded: only admins may modify those.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);

-- Admin helper for the knowledge-base write policies (admin_users must already exist);
CREATE OR REPLACE FUNCTION is_admin(user_uuid UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users WHERE id = user_uuid
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION is_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_admin(UUID) TO authenticated, service_role;

-- True while admin_settings.read_only_doc_dashboard is on: only admins may then change the knowledge base.
CREATE OR REPLACE FUNCTION kb_writes_locked()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN COALESCE(
    (SELECT read_only_doc_dashboard FROM admin_settings ORDER BY updated_at DESC LIMIT 1),
    false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION kb_writes_locked() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kb_writes_locked() TO authenticated, service_role;

-- Document policies
-- Everyone can read the shared knowledge base. Writes: owners (user_id = auth.uid()) and admins only,
-- and non-admins only while the knowledge base is not locked read-only.
DROP POLICY IF EXISTS "Allow full access to authenticated users" ON documents;
DROP POLICY IF EXISTS "Allow read access to anonymous users" ON documents;
DROP POLICY IF EXISTS "Authenticated users insert own documents" ON documents;
DROP POLICY IF EXISTS "Owners and admins update documents" ON documents;
DROP POLICY IF EXISTS "Owners and admins delete documents" ON documents;

CREATE POLICY "Allow read access to anonymous users" ON documents
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users insert own documents" ON documents
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (NOT kb_writes_locked() OR is_admin((SELECT auth.uid())))
  );

CREATE POLICY "Owners and admins update documents" ON documents
  FOR UPDATE TO authenticated
  USING (
    is_admin((SELECT auth.uid()))
    OR (user_id = (SELECT auth.uid()) AND NOT kb_writes_locked())
  )
  WITH CHECK (
    is_admin((SELECT auth.uid()))
    OR (user_id = (SELECT auth.uid()) AND NOT kb_writes_locked())
  );

CREATE POLICY "Owners and admins delete documents" ON documents
  FOR DELETE TO authenticated
  USING (
    is_admin((SELECT auth.uid()))
    OR (user_id = (SELECT auth.uid()) AND NOT kb_writes_locked())
  );

-- Document chunks policies: a chunk follows the ownership of its parent document
DROP POLICY IF EXISTS "Allow full access to authenticated users" ON document_chunks;
DROP POLICY IF EXISTS "Allow read access to anonymous users" ON document_chunks;
DROP POLICY IF EXISTS "Authenticated users insert chunks of own documents" ON document_chunks;
DROP POLICY IF EXISTS "Owners and admins update chunks" ON document_chunks;
DROP POLICY IF EXISTS "Owners and admins delete chunks" ON document_chunks;

CREATE POLICY "Allow read access to anonymous users" ON document_chunks
  FOR SELECT USING (true);

CREATE POLICY "Authenticated users insert chunks of own documents" ON document_chunks
  FOR INSERT TO authenticated
  WITH CHECK (
    is_admin((SELECT auth.uid()))
    OR (
      NOT kb_writes_locked()
      AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id = document_chunks.document_id AND d.user_id = (SELECT auth.uid())
      )
    )
  );

CREATE POLICY "Owners and admins update chunks" ON document_chunks
  FOR UPDATE TO authenticated
  USING (
    is_admin((SELECT auth.uid()))
    OR (
      NOT kb_writes_locked()
      AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id = document_chunks.document_id AND d.user_id = (SELECT auth.uid())
      )
    )
  )
  WITH CHECK (
    is_admin((SELECT auth.uid()))
    OR (
      NOT kb_writes_locked()
      AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id = document_chunks.document_id AND d.user_id = (SELECT auth.uid())
      )
    )
  );

CREATE POLICY "Owners and admins delete chunks" ON document_chunks
  FOR DELETE TO authenticated
  USING (
    is_admin((SELECT auth.uid()))
    OR (
      NOT kb_writes_locked()
      AND EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id = document_chunks.document_id AND d.user_id = (SELECT auth.uid())
      )
    )
  );

-- Tool execution states policies
DROP POLICY IF EXISTS "Users can view their own tool execution states" ON tool_execution_states;
CREATE POLICY "Users can view their own tool execution states"
  ON tool_execution_states FOR SELECT
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM chats 
      WHERE chats.id = tool_execution_states.chat_id 
      AND chats.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can insert tool execution states for their own chats" ON tool_execution_states;
CREATE POLICY "Users can insert tool execution states for their own chats"
  ON tool_execution_states FOR INSERT
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM chats 
      WHERE chats.id = tool_execution_states.chat_id 
      AND chats.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can update their own tool execution states" ON tool_execution_states;
CREATE POLICY "Users can update their own tool execution states"
  ON tool_execution_states FOR UPDATE
  USING (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM chats 
      WHERE chats.id = tool_execution_states.chat_id 
      AND chats.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM chats 
      WHERE chats.id = tool_execution_states.chat_id 
      AND chats.user_id = (SELECT auth.uid())
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

-- Admin check for the calling user. The admin_session cookie is signed and verified by the application,
-- never read from the database session.
CREATE OR REPLACE FUNCTION check_admin_status()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM admin_users WHERE id = auth.uid()
  );
END;
$$;

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

CREATE OR REPLACE FUNCTION is_subscribed(user_uuid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

COMMIT;

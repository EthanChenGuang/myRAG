-- ============================================
-- myRAG Multi-Tenant Complete Setup
-- ============================================
--
-- Three-Tier Workspace Architecture:
-- 1. Personal Workspace (Flat) - No organization, user_id isolation
-- 2. Personal Projects - is_personal: true, owner only, can be made collaborative
-- 3. Collaborative Projects - is_personal: false, multi-member (via shareOrganization)
--
-- Features:
-- - Hybrid isolation model (user_id + organization_id)
-- - Organization-based multi-tenancy with RLS
-- - Collaborative projects with role-based access
-- - Storage quotas and usage tracking
-- - Subscription tier enforcement
-- - Vector database optimization (HNSW indexes)
-- - Personal project to collaborative conversion (shareOrganization)
--
-- Date: 2025-11-29
-- Version: 3.2 (Fixed organization creation + multiple workspaces)
-- ============================================

BEGIN;

------------------------------------------
-- EXTENSIONS
------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

------------------------------------------
-- ORGANIZATIONS TABLE (3-Tier Support)
------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  owner_id UUID REFERENCES auth.users(id) NOT NULL,

  -- Personal vs Collaborative Project Flag (MEANINGFUL)
  -- true: Personal project (owner only, can be made collaborative via shareOrganization)
  -- false: Collaborative project (multi-member, via conversion from personal)
  is_personal BOOLEAN DEFAULT true,

  -- Subscription & Billing
  subscription_tier TEXT DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro', 'enterprise', 'custom')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  polar_subscription_id TEXT,

  -- Storage Quotas
  storage_used_bytes BIGINT DEFAULT 0,
  storage_limit_bytes BIGINT DEFAULT 1073741824, -- 1GB for free tier

  -- Document Limits (per tier)
  max_documents INT DEFAULT 50,
  max_monthly_messages INT DEFAULT 100,
  max_team_members INT DEFAULT 1, -- 1 for personal, 5+ for teams

  -- Organization Settings
  settings JSONB DEFAULT '{}',

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  -- Constraint: Personal organizations must have an owner
  CONSTRAINT personal_org_must_have_owner CHECK (
    (is_personal = true AND owner_id IS NOT NULL)
    OR
    (is_personal = false)
  )
);

CREATE INDEX IF NOT EXISTS idx_organizations_owner_id ON organizations(owner_id);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_tier ON organizations(subscription_tier);
CREATE INDEX IF NOT EXISTS idx_organizations_personal ON organizations(owner_id, is_personal) WHERE is_personal = true;

-- NOTE: We intentionally do NOT create a unique constraint on (owner_id, is_personal)
-- Users can create MULTIPLE personal projects (workspaces)
-- The 3-tier architecture allows:
-- 1. Flat personal workspace (no organization)
-- 2. Multiple personal projects (is_personal=true)
-- 3. Collaborative projects (is_personal=false, via shareOrganization)

COMMENT ON TABLE organizations IS 'Organizations for both personal projects (is_personal=true) and collaborative projects (is_personal=false via shareOrganization)';
COMMENT ON COLUMN organizations.is_personal IS 'True for personal projects (owner only, can be converted), false for collaborative projects (multi-member, via conversion)';
COMMENT ON COLUMN organizations.max_team_members IS 'Team member limit: 1 for personal projects, 5+ for collaborative projects';

------------------------------------------
-- ORGANIZATION MEMBERS TABLE
------------------------------------------

CREATE TABLE IF NOT EXISTS organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_role ON organization_members(role);

COMMENT ON TABLE organization_members IS 'Team members with role-based access control';
COMMENT ON COLUMN organization_members.role IS 'owner: full control, admin: manage team, member: read/write, viewer: read-only';

------------------------------------------
-- TEAM INVITATIONS TABLE
------------------------------------------

CREATE TABLE IF NOT EXISTS team_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  invited_by UUID REFERENCES auth.users(id),
  token TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  UNIQUE(organization_id, email)
);

CREATE INDEX IF NOT EXISTS idx_team_invitations_token ON team_invitations(token);
CREATE INDEX IF NOT EXISTS idx_team_invitations_org_id ON team_invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_team_invitations_status ON team_invitations(status);

COMMENT ON TABLE team_invitations IS 'Pending team invitations with expiration (blocked for personal projects, only for collaborative projects)';

------------------------------------------
-- DOCUMENTS TABLE (HYBRID ISOLATION)
------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',

  -- HYBRID ISOLATION MODEL
  -- user_id: Always required (document owner)
  -- organization_id: NULL for flat personal, set for organizations
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES auth.users(id),

  -- Content classification fields
  content_type TEXT CHECK (content_type IN ('pricing', 'faq', 'policy', 'guide', 'announcement')),
  slug TEXT,
  is_public BOOLEAN DEFAULT true,

  -- Source tracking (for Nango integration)
  source TEXT DEFAULT 'upload' CHECK (source IN ('upload', 'google-drive', 'notion', 'dropbox')),
  source_provider TEXT,
  source_file_id TEXT,
  source_connection_id TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  -- Isolation constraint: must be EITHER personal (user_id + NULL org) OR organizational
  CONSTRAINT documents_isolation_check CHECK (
    (user_id IS NOT NULL AND organization_id IS NULL) -- Personal workspace (flat)
    OR
    (organization_id IS NOT NULL) -- Personal project or team workspace
  )
);

CREATE INDEX IF NOT EXISTS idx_documents_organization_id ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON documents(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_documents_filename ON documents(filename);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);

-- Hybrid indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_documents_personal ON documents(user_id) WHERE organization_id IS NULL;

-- Content type and slug indexes (for document dashboard)
CREATE INDEX IF NOT EXISTS documents_org_type_slug_idx ON documents(organization_id, content_type, slug, is_public);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_type_slug_ux ON documents(COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), content_type, slug);

-- Source tracking indexes
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
CREATE INDEX IF NOT EXISTS idx_documents_source_provider ON documents(source_provider);

COMMENT ON TABLE documents IS 'Documents with 3-tier isolation: flat personal (user_id, org_id=NULL), personal project (org_id + is_personal=true), or collaborative (org_id + is_personal=false)';
COMMENT ON COLUMN documents.user_id IS 'Document owner (required). For personal docs, this is the only identifier. For organizational docs, combined with organization_id';
COMMENT ON COLUMN documents.organization_id IS 'Organization context (NULL for flat personal workspace, UUID for personal/collaborative projects)';

------------------------------------------
-- DOCUMENT CHUNKS TABLE (HYBRID ISOLATION)
------------------------------------------

CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  chunk_index INT,
  metadata JSONB DEFAULT '{}',

  -- Multi-tenant field (nullable for flat personal workspace)
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_organization_id ON document_chunks(organization_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);

-- Optimized HNSW index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 64, ef_construction = 200);

-- Composite index for org-scoped vector search
CREATE INDEX IF NOT EXISTS idx_chunks_org_embedding ON document_chunks(organization_id, id);

COMMENT ON COLUMN document_chunks.embedding IS 'Vector embedding (1536 dimensions) - supports text-embedding-ada-002 and text-embedding-3-small';
COMMENT ON COLUMN document_chunks.organization_id IS 'Denormalized org_id for fast filtering (NULL for flat personal workspace)';
COMMENT ON COLUMN document_chunks.chunk_index IS 'Sequential index for chunk ordering within each document (0-based)';

------------------------------------------
-- FOLDERS TABLE (HYBRID ISOLATION)
------------------------------------------

CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  pinned BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_organization_id ON folders(organization_id);
CREATE INDEX IF NOT EXISTS idx_folders_pinned ON folders(pinned);
CREATE INDEX IF NOT EXISTS idx_folders_personal ON folders(user_id) WHERE organization_id IS NULL;

COMMENT ON TABLE folders IS 'User folders within organizations for chat organization (supports flat personal workspace)';

------------------------------------------
-- CHATS TABLE (HYBRID ISOLATION)
------------------------------------------

CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  messages JSONB NOT NULL,
  pinned BOOLEAN DEFAULT FALSE,
  folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  shared BOOLEAN DEFAULT false,
  share_id UUID UNIQUE DEFAULT NULL,
  is_shared BOOLEAN DEFAULT false,
  share_settings JSONB,
  mcp_tool_states JSONB,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_organization_id ON chats(organization_id);
CREATE INDEX IF NOT EXISTS idx_chats_folder_id ON chats(folder_id);
CREATE INDEX IF NOT EXISTS idx_chats_pinned ON chats(pinned);
CREATE INDEX IF NOT EXISTS idx_chats_share_id ON chats(share_id) WHERE shared = true;
CREATE INDEX IF NOT EXISTS idx_chats_user_id_updated_at_desc ON chats(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_org_updated_at ON chats(organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_personal ON chats(user_id) WHERE organization_id IS NULL;

COMMENT ON TABLE chats IS 'User chats with hybrid isolation: personal or organizational context';
COMMENT ON COLUMN chats.organization_id IS 'Organization context (NULL for flat personal workspace)';

------------------------------------------
-- USAGE TRACKING TABLES
------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  date DATE NOT NULL,

  -- Usage metrics
  chat_messages INT DEFAULT 0,
  documents_processed INT DEFAULT 0,
  vector_searches INT DEFAULT 0,
  tokens_used BIGINT DEFAULT 0,
  api_calls INT DEFAULT 0,
  storage_bytes_added BIGINT DEFAULT 0,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  UNIQUE(organization_id, user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_org_date ON tenant_usage(organization_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_usage_user_date ON tenant_usage(user_id, date DESC);

COMMENT ON TABLE tenant_usage IS 'Daily usage metrics per organization and user for quota enforcement';

------------------------------------------
-- API USAGE LOGS TABLE
------------------------------------------

CREATE TABLE IF NOT EXISTS api_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INT,
  response_time_ms INT,
  tokens_used INT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_org_id ON api_usage_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_user_id ON api_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_created_at ON api_usage_logs(created_at DESC);

COMMENT ON TABLE api_usage_logs IS 'API request logs for monitoring and analytics';

------------------------------------------
-- ORGANIZATION DOMAINS TABLE
------------------------------------------

CREATE TABLE IF NOT EXISTS organization_domains (
  domain TEXT PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_organization_domains_org_id ON organization_domains(organization_id);

COMMENT ON TABLE organization_domains IS 'Domain-based organization routing (e.g., acme.myrag.app → acme organization)';

------------------------------------------
-- SUBSCRIPTIONS TABLE
------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

  -- Payment provider info
  polar_subscription_id TEXT,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  payment_provider TEXT CHECK (payment_provider IN ('stripe', 'polar')) NOT NULL,

  -- Subscription details
  plan_type TEXT NOT NULL,
  status TEXT NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_organization_id ON subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id ON subscriptions(stripe_subscription_id);

CREATE TABLE IF NOT EXISTS pending_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  plan_type TEXT NOT NULL,
  status TEXT NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_pending_subscriptions_checkout_id ON pending_subscriptions(checkout_id);

------------------------------------------
-- USER PREFERENCES TABLE
------------------------------------------

CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  selected_model TEXT,
  current_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences(user_id);

COMMENT ON COLUMN user_preferences.current_organization_id IS 'Currently selected organization for the user (NULL for flat personal workspace)';

------------------------------------------
-- ADMIN TABLES
------------------------------------------

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  created_by UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_users_created_by ON admin_users(created_by);

CREATE TABLE IF NOT EXISTS admin_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  read_only_doc_dashboard BOOLEAN DEFAULT false,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_by UUID REFERENCES auth.users(id)
);

-- Seed initial admin settings
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_settings LIMIT 1) THEN
    INSERT INTO admin_settings (read_only_doc_dashboard) VALUES (false);
  END IF;
END $$;

------------------------------------------
-- TOOL EXECUTION STATES TABLE
------------------------------------------

CREATE TABLE IF NOT EXISTS tool_execution_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL,
  message_id BIGINT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'running', 'completed', 'error', 'cancelled')),
  tool_params JSONB,
  tool_result JSONB,
  error_message TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  UNIQUE(chat_id, message_id, tool_call_id)
);

ALTER TABLE tool_execution_states ADD COLUMN IF NOT EXISTS user_id UUID;

CREATE INDEX IF NOT EXISTS idx_tool_execution_states_chat_id ON tool_execution_states(chat_id);
CREATE INDEX IF NOT EXISTS idx_tool_execution_states_status ON tool_execution_states(status);

------------------------------------------
-- WHATSAPP INTEGRATION TABLES
------------------------------------------

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  status TEXT CHECK (status IN ('connecting', 'connected', 'disconnected', 'qr_pending', 'failed')) DEFAULT 'connecting',
  qr_code TEXT,
  qr_expires_at TIMESTAMP WITH TIME ZONE,
  koyeb_session_data JSONB,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  UNIQUE(user_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user_id ON whatsapp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_org_id ON whatsapp_sessions(organization_id);

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
  whatsapp_jid TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  contact_name TEXT,
  user_id UUID REFERENCES auth.users(id) NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),

  UNIQUE(user_id, whatsapp_jid)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_user_id ON whatsapp_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_chat_id ON whatsapp_conversations(chat_id);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  whatsapp_message_id TEXT NOT NULL UNIQUE,
  direction TEXT CHECK (direction IN ('incoming', 'outgoing')) NOT NULL,
  status TEXT CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  error_message TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation_id ON whatsapp_messages(conversation_id);

------------------------------------------
-- STORAGE BUCKETS
------------------------------------------

DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('chat-images', 'chat-images', true)
  ON CONFLICT (id) DO NOTHING;
END $$;

DO $$
BEGIN
  UPDATE storage.buckets
  SET public = true,
      file_size_limit = 10485760,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'model/gltf-binary']
  WHERE id = 'chat-images';
END $$;

DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('backgrounds', 'backgrounds', true)
  ON CONFLICT (id) DO NOTHING;
END $$;

DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('3d-models', '3d-models', true)
  ON CONFLICT (id) DO NOTHING;
END $$;

DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit)
  VALUES ('chat-videos', 'chat-videos', true, 52428800)
  ON CONFLICT (id) DO NOTHING;
END $$;

------------------------------------------
-- RPC FUNCTIONS
------------------------------------------

-- Helper function to check organization membership (prevents RLS recursion)
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

-- Policy helpers on organizations / organization_members. SECURITY DEFINER with a fixed search_path, keyed on
-- auth.uid() and never on a caller-supplied id. They read the tables without re-entering RLS, which breaks the
-- organizations <-> organization_members policy cycle (Postgres 42P17 infinite recursion).
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

-- Safe organization creation (creates org AND adds owner as member atomically)
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

-- Vector search with organization filter
CREATE OR REPLACE FUNCTION match_documents_by_organization(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  org_id uuid
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.metadata,
    1 - (dc.embedding <=> query_embedding) as similarity
  FROM document_chunks dc
  WHERE dc.organization_id = org_id
    AND 1 - (dc.embedding <=> query_embedding) > match_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_documents_by_organization IS 'Organization-scoped vector similarity search';

-- ============================================
-- WORKSPACE-SCOPED VECTOR SEARCH (3-TIER SUPPORT)
-- ============================================
-- This function performs vector similarity search with workspace isolation
-- supporting all three tiers:
-- 1. Personal Workspace (Flat): p_org_id = NULL, filters by user_id only
-- 2. Personal Projects: p_org_id set, is_personal = true
-- 3. Team Workspaces: p_org_id set, is_personal = false

CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(
  p_query_embedding vector(1536),
  p_match_count integer,
  p_min_similarity double precision,
  p_org_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> p_query_embedding) as similarity,
    dc.metadata
  FROM document_chunks dc
  INNER JOIN documents d ON d.id = dc.document_id
  WHERE dc.embedding IS NOT NULL
    AND 1 - (dc.embedding <=> p_query_embedding) > p_min_similarity
    AND (
      -- Personal workspace: user owns document and no organization
      (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
      OR
      -- Team workspace: document belongs to organization
      (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
    )
  ORDER BY dc.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

-- SECURITY DEFINER and trusts the caller-supplied tenant ids: only the server-side service role may execute it.
REVOKE EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.match_documents_by_workspace IS 
  'Performs workspace-scoped vector similarity search. Filters by personal workspace (user_id + org_id=NULL) or team workspace (organization_id).';

-- Legacy RAG function (for backward compatibility)
CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  match_count integer,
  similarity_threshold double precision
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  current_user_id UUID;
  current_org_id UUID;
BEGIN
  -- Get current user ID
  current_user_id := auth.uid();
  
  -- Get user's current organization if in multi-tenant mode
  SELECT current_organization_id INTO current_org_id
  FROM user_preferences
  WHERE user_id = current_user_id;
  
  -- Return chunks based on organization context
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity,
    dc.metadata
  FROM document_chunks dc
  INNER JOIN documents d ON dc.document_id = d.id
  WHERE dc.embedding IS NOT NULL 
    AND 1 - (dc.embedding <=> query_embedding) > similarity_threshold
    AND (
      -- Personal workspace: match null org_id docs
      (current_org_id IS NULL AND dc.organization_id IS NULL)
      OR
      -- Organization workspace: match org docs OR personal docs owned by user
      (current_org_id IS NOT NULL AND (
        dc.organization_id = current_org_id
        OR (dc.organization_id IS NULL AND d.user_id = current_user_id)
      ))
    )
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_document_chunks IS 'Legacy RAG vector search with automatic organization detection from user preferences';

-- Simplified org-scoped chunk search
CREATE OR REPLACE FUNCTION match_document_chunks_by_org(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count integer DEFAULT 8,
  p_min_similarity double precision DEFAULT 0.2
)
RETURNS TABLE (
  document_id uuid,
  chunk_id uuid,
  content text,
  similarity double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.document_id,
    dc.id as chunk_id,
    dc.content,
    1 - (dc.embedding <=> p_query_embedding) as similarity
  FROM document_chunks dc
  WHERE (dc.organization_id = p_org_id OR dc.organization_id IS NULL)
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding <=> p_query_embedding) >= p_min_similarity
  ORDER BY dc.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

COMMENT ON FUNCTION match_document_chunks_by_org IS 'Organization-scoped chunk search with fallback to global documents';

REVOKE EXECUTE ON FUNCTION match_document_chunks_by_org(uuid, vector, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_document_chunks_by_org(uuid, vector, integer, double precision) TO service_role;

-- Document retrieval by type and slug (for document dashboard)
CREATE OR REPLACE FUNCTION get_documents_by_type_slug(
  p_org_id uuid,
  p_content_type text,
  p_slug text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  content text,
  slug text,
  is_tenant boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $$
  WITH tenant_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, true as is_tenant
    FROM documents d
    WHERE d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
    ORDER BY d.created_at DESC
  ),
  global_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, false as is_tenant
    FROM documents d
    WHERE d.organization_id IS NULL
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
      AND NOT EXISTS (SELECT 1 FROM tenant_docs)
    ORDER BY d.created_at DESC
  )
  SELECT * FROM tenant_docs
  UNION ALL
  SELECT * FROM global_docs
  LIMIT 10;
$$;

COMMENT ON FUNCTION get_documents_by_type_slug IS 'Retrieve documents by type and slug with tenant/global fallback';

REVOKE EXECUTE ON FUNCTION get_documents_by_type_slug(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug(uuid, text, text) TO service_role;

-- Workspace-aware document retrieval
CREATE OR REPLACE FUNCTION get_documents_by_type_slug_workspace(
  p_org_id uuid,
  p_user_id uuid,
  p_content_type text,
  p_slug text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  user_id uuid,
  content text,
  slug text,
  is_tenant boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $$
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, true as is_tenant
    FROM documents d
    WHERE p_org_id IS NOT NULL
      AND d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  UNION ALL
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, false as is_tenant
    FROM documents d
    WHERE p_org_id IS NULL
      AND d.organization_id IS NULL
      AND d.user_id = p_user_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  LIMIT 10;
$$;

COMMENT ON FUNCTION get_documents_by_type_slug_workspace IS '3-tier workspace-aware document retrieval by type and slug';

REVOKE EXECUTE ON FUNCTION get_documents_by_type_slug_workspace(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_documents_by_type_slug_workspace(uuid, uuid, text, text) TO service_role;

-- Get workspace context from domain or user preferences
CREATE OR REPLACE FUNCTION get_workspace_context(
  p_domain text,
  p_user uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
  org_id uuid;
BEGIN
  -- First check domain routing
  SELECT od.organization_id INTO org_id
  FROM organization_domains od
  WHERE od.domain = p_domain;

  -- Fallback to user preferences
  IF org_id IS NULL THEN
    SELECT up.current_organization_id INTO org_id
    FROM user_preferences up
    WHERE up.user_id = p_user;
  END IF;

  RETURN org_id;
END;
$$;

COMMENT ON FUNCTION get_workspace_context(text, uuid) IS 'Resolve organization context from domain or user preferences';

-- SECURITY DEFINER and trusts the caller-supplied user id: only the server-side service role may execute it.
REVOKE EXECUTE ON FUNCTION get_workspace_context(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_workspace_context(text, uuid) TO service_role;

-- Get user organization IDs
CREATE OR REPLACE FUNCTION get_user_org_ids(check_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT organization_id
  FROM organization_members
  WHERE user_id = check_user_id;
$$;

COMMENT ON FUNCTION get_user_org_ids IS 'Get all organization IDs for a user';

-- SECURITY DEFINER and trusts the caller-supplied user id: only the server-side service role may execute it.
REVOKE EXECUTE ON FUNCTION get_user_org_ids(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_user_org_ids(uuid) TO service_role;

-- Get user role in organization
CREATE OR REPLACE FUNCTION get_user_role_in_org(org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  user_role TEXT;
BEGIN
  SELECT role INTO user_role
  FROM organization_members
  WHERE organization_id = org_id
    AND user_id = auth.uid();

  RETURN user_role;
END;
$$;

COMMENT ON FUNCTION get_user_role_in_org IS 'Get authenticated user role in specific organization';

-- Get user current organization
CREATE OR REPLACE FUNCTION get_user_current_org()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_id UUID;
BEGIN
  SELECT current_organization_id INTO org_id
  FROM user_preferences
  WHERE user_id = auth.uid();

  IF org_id IS NULL THEN
    SELECT organization_id INTO org_id
    FROM organization_members
    WHERE user_id = auth.uid()
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  RETURN org_id;
END;
$$;

COMMENT ON FUNCTION get_user_current_org IS 'Get current organization for authenticated user with fallback to first joined org';

-- Check if user can view org member
CREATE OR REPLACE FUNCTION can_view_org_member(member_user_id uuid, member_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  -- User can view if it's their own membership
  SELECT member_user_id = auth.uid()
  -- Or if they're in the same organization
  OR EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.organization_id = member_org_id
      AND om.user_id = auth.uid()
  )
  -- Or if they own the organization
  OR EXISTS (
    SELECT 1 FROM organizations o
    WHERE o.id = member_org_id
      AND o.owner_id = auth.uid()
  );
$$;

COMMENT ON FUNCTION can_view_org_member IS 'Check if user has permission to view organization member';

-- Folder management functions
CREATE OR REPLACE FUNCTION delete_folder(
  folder_uuid uuid,
  delete_chats boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM folders
    WHERE id = folder_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete this folder';
  END IF;

  IF delete_chats THEN
    DELETE FROM chats
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  ELSE
    UPDATE chats
    SET folder_id = NULL
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  END IF;

  DELETE FROM folders
  WHERE id = folder_uuid AND user_id = auth.uid();

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION delete_folder IS 'Delete folder and optionally all chats within it';

CREATE OR REPLACE FUNCTION get_folder_stats(folder_uuid uuid)
RETURNS TABLE (
  chat_count bigint,
  last_updated timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as chat_count,
    MAX(c.updated_at) as last_updated
  FROM chats c
  WHERE c.folder_id = folder_uuid
    AND c.user_id = auth.uid();
END;
$$;

COMMENT ON FUNCTION get_folder_stats IS 'Get statistics for a folder (chat count and last update)';

CREATE OR REPLACE FUNCTION move_chats_to_folder(
  chat_ids uuid[],
  target_folder_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  IF target_folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM folders
    WHERE id = target_folder_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to use this folder';
  END IF;

  UPDATE chats
  SET folder_id = target_folder_id,
      updated_at = TIMEZONE('utc', NOW())
  WHERE id = ANY(chat_ids)
    AND user_id = auth.uid();

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION move_chats_to_folder IS 'Move multiple chats to a folder';

-- Chat sharing functions
CREATE OR REPLACE FUNCTION share_chat(
  chat_uuid uuid,
  settings jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_share_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to share this chat';
  END IF;

  SELECT gen_random_uuid() INTO new_share_id;

  UPDATE chats
  SET is_shared = TRUE,
      share_id = new_share_id,
      share_settings = settings
  WHERE id = chat_uuid;

  RETURN new_share_id;
END;
$$;

COMMENT ON FUNCTION share_chat IS 'Share a chat and generate share ID';

CREATE OR REPLACE FUNCTION unshare_chat(chat_uuid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to unshare this chat';
  END IF;

  UPDATE chats
  SET is_shared = FALSE
  WHERE id = chat_uuid;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION unshare_chat IS 'Unshare a chat';

-- Admin organization helper (for config UI uploads)
CREATE OR REPLACE FUNCTION get_admin_organization_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  admin_org_id UUID;
BEGIN
  SELECT id INTO admin_org_id
  FROM organizations
  WHERE slug = 'admin-uploads'
  LIMIT 1;

  IF admin_org_id IS NULL THEN
    INSERT INTO organizations (
      name,
      slug,
      owner_id,
      is_personal,
      subscription_tier,
      storage_limit_bytes,
      max_documents,
      max_monthly_messages,
      max_team_members
    )
    SELECT
      'Admin Uploads (Config UI)',
      'admin-uploads',
      id,
      false,
      'enterprise',
      107374182400,
      10000,
      1000000,
      1000
    FROM auth.users
    LIMIT 1
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO admin_org_id;
  END IF;

  RETURN admin_org_id;
END;
$$;

COMMENT ON FUNCTION get_admin_organization_id IS 'Get or create admin organization for config UI uploads';

-- Creates a row when missing and takes no caller identity: only the server-side service role may execute it.
REVOKE EXECUTE ON FUNCTION get_admin_organization_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_admin_organization_id() TO service_role;

-- Storage quota check
CREATE OR REPLACE FUNCTION check_storage_quota(org_id uuid, file_size_bytes bigint)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  current_usage bigint;
  quota_limit bigint;
BEGIN
  SELECT storage_used_bytes, storage_limit_bytes
  INTO current_usage, quota_limit
  FROM organizations
  WHERE id = org_id;

  RETURN (current_usage + file_size_bytes) <= quota_limit;
END;
$$;

-- Update storage usage
CREATE OR REPLACE FUNCTION update_org_storage()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE organizations
    SET storage_used_bytes = storage_used_bytes + COALESCE((NEW.metadata->>'file_size')::BIGINT, 0)
    WHERE id = NEW.organization_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE organizations
    SET storage_used_bytes = GREATEST(0, storage_used_bytes - COALESCE((OLD.metadata->>'file_size')::BIGINT, 0))
    WHERE id = OLD.organization_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS track_document_storage ON documents;
CREATE TRIGGER track_document_storage
AFTER INSERT OR DELETE ON documents
FOR EACH ROW EXECUTE FUNCTION update_org_storage();

-- Get workspace type (3-tier model)
CREATE OR REPLACE FUNCTION get_workspace_type(org_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT
    CASE
      WHEN org_id IS NULL THEN 'personal_flat'
      WHEN o.is_personal = true THEN 'personal_project'
      WHEN o.is_personal = false THEN 'team'
      ELSE 'unknown'
    END
  FROM organizations o
  WHERE o.id = org_id;
$$;

COMMENT ON FUNCTION get_workspace_type IS 'Returns workspace type: personal_flat, personal_project, or collaborative';

-- Get user workspace summary
CREATE OR REPLACE FUNCTION get_user_workspace_summary()
RETURNS TABLE (
  has_flat_workspace BOOLEAN,
  personal_projects_count INT,
  team_workspaces_count INT,
  total_organizations INT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    true as has_flat_workspace,  -- Always available
    COALESCE((SELECT COUNT(*) FROM organizations WHERE owner_id = auth.uid() AND is_personal = true), 0)::INT as personal_projects_count,
    COALESCE((SELECT COUNT(*) FROM organization_members om INNER JOIN organizations o ON o.id = om.organization_id WHERE om.user_id = auth.uid() AND o.is_personal = false), 0)::INT as team_workspaces_count,
    COALESCE((SELECT COUNT(*) FROM organization_members WHERE user_id = auth.uid()), 0)::INT as total_organizations;
$$;

COMMENT ON FUNCTION get_user_workspace_summary IS 'Returns summary of user workspace types';

-- Share personal organization (convert to collaborative)
CREATE OR REPLACE FUNCTION share_personal_organization(
  org_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org_record RECORD;
BEGIN
  -- Verify the organization exists and is personal
  SELECT * INTO org_record
  FROM organizations
  WHERE id = org_id
    AND is_personal = true
    AND owner_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found or not a personal organization';
  END IF;

  -- Convert to collaborative project
  UPDATE organizations
  SET
    is_personal = false,
    max_team_members = 5,  -- Default collaboration limit
    updated_at = NOW()
  WHERE id = org_id;

  RAISE NOTICE 'Converted personal organization % to collaborative project', org_id;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION share_personal_organization IS 'Converts a personal project to a collaborative project (enables invitations)';

-- Admin check
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

-- Subscription check
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

-- Trigger functions
CREATE OR REPLACE FUNCTION set_last_updated_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc', NOW());
    RETURN NEW;
END;
$$;

------------------------------------------
-- ROW LEVEL SECURITY POLICIES
------------------------------------------

-- Enable RLS on all tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_execution_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_domains ENABLE ROW LEVEL SECURITY;

------------------------------------------
-- ORGANIZATIONS POLICIES (3-TIER AWARE)
------------------------------------------

DROP POLICY IF EXISTS "Users can view their organizations" ON organizations;
CREATE POLICY "Users can view their organizations" ON organizations
  FOR SELECT USING (
    -- Personal projects: only owner can see
    (is_personal = true AND owner_id = auth.uid())
    OR
    -- Collaborative projects: all members can see
    (is_personal = false AND is_org_member(id, auth.uid()))
  );

DROP POLICY IF EXISTS "Users can create organizations" ON organizations;
CREATE POLICY "Users can create organizations" ON organizations
  FOR INSERT WITH CHECK (
    auth.uid() = owner_id
    -- Only personal organizations can be created directly (is_personal: true)
    -- Team workspaces blocked at API level, only via shareOrganization conversion
  );

DROP POLICY IF EXISTS "Users can update organizations" ON organizations;
CREATE POLICY "Users can update organizations" ON organizations
  FOR UPDATE USING (
    -- Personal orgs: only owner
    (is_personal = true AND owner_id = auth.uid())
    OR
    -- Team orgs: owner or admin
    (is_personal = false AND is_org_admin(id))
  );

DROP POLICY IF EXISTS "Users can delete organizations" ON organizations;
CREATE POLICY "Users can delete organizations" ON organizations
  FOR DELETE USING (
    owner_id = auth.uid()
  );

------------------------------------------
-- ORGANIZATION MEMBERS POLICIES
------------------------------------------

DROP POLICY IF EXISTS "Users can view org members" ON organization_members;
CREATE POLICY "Users can view org members" ON organization_members
  FOR SELECT USING (
    is_org_owner(organization_id)
    OR
    user_id = auth.uid()
  );

DROP POLICY IF EXISTS "Admins can add members" ON organization_members;
CREATE POLICY "Admins can add members" ON organization_members
  FOR INSERT WITH CHECK (
    is_org_owner(organization_id)
  );


DROP POLICY IF EXISTS "Admins can remove members" ON organization_members;
CREATE POLICY "Admins can remove members" ON organization_members
  FOR DELETE USING (
    is_org_owner(organization_id)
  );

------------------------------------------
-- ORGANIZATION DOMAINS POLICIES
------------------------------------------

DROP POLICY IF EXISTS "Users can view org domains" ON organization_domains;
CREATE POLICY "Users can view org domains" ON organization_domains
  FOR SELECT USING (
    organization_id IN (
      SELECT id FROM organizations
      WHERE owner_id = auth.uid()
        OR id IN (
          SELECT organization_id FROM organization_members
          WHERE user_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "Owners can add org domains" ON organization_domains;
CREATE POLICY "Owners can add org domains" ON organization_domains
  FOR INSERT WITH CHECK (
    organization_id IN (
      SELECT id FROM organizations
      WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Owners can update org domains" ON organization_domains;
CREATE POLICY "Owners can update org domains" ON organization_domains
  FOR UPDATE USING (
    organization_id IN (
      SELECT id FROM organizations
      WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Owners can delete org domains" ON organization_domains;
CREATE POLICY "Owners can delete org domains" ON organization_domains
  FOR DELETE USING (
    organization_id IN (
      SELECT id FROM organizations
      WHERE owner_id = auth.uid()
    )
  );

------------------------------------------
-- TEAM INVITATIONS POLICIES (3-TIER)
------------------------------------------

DROP POLICY IF EXISTS "Users can view org invitations" ON team_invitations;
CREATE POLICY "Users can view org invitations" ON team_invitations
  FOR SELECT USING (
    organization_id IN (
      SELECT o.id FROM organizations o
      INNER JOIN organization_members om ON om.organization_id = o.id
      WHERE o.is_personal = false  -- Only collaborative projects
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Admins can create invitations" ON team_invitations;
CREATE POLICY "Admins can create invitations" ON team_invitations
  FOR INSERT WITH CHECK (
    organization_id IN (
      SELECT o.id FROM organizations o
      INNER JOIN organization_members om ON om.organization_id = o.id
      WHERE o.is_personal = false  -- Only collaborative projects can invite
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "Admins can delete invitations" ON team_invitations;
CREATE POLICY "Admins can delete invitations" ON team_invitations
  FOR DELETE USING (
    organization_id IN (
      SELECT o.id FROM organizations o
      INNER JOIN organization_members om ON om.organization_id = o.id
      WHERE o.is_personal = false  -- Only collaborative projects
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    )
  );

------------------------------------------
-- DOCUMENTS POLICIES (HYBRID ISOLATION)
------------------------------------------

DROP POLICY IF EXISTS "Users can view documents" ON documents;
CREATE POLICY "Users can view documents" ON documents
  FOR SELECT USING (
    -- Personal documents (flat workspace)
    (user_id = auth.uid() AND organization_id IS NULL)
    OR
    -- Organizational documents (personal projects + teams)
    (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Users can create documents" ON documents;
CREATE POLICY "Users can create documents" ON documents
  FOR INSERT WITH CHECK (
    -- Personal upload
    (user_id = auth.uid() AND organization_id IS NULL)
    OR
    -- Organizational upload (must be member)
    (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Users can delete documents" ON documents;
CREATE POLICY "Users can delete documents" ON documents
  FOR DELETE USING (
    -- Own personal documents
    (user_id = auth.uid() AND organization_id IS NULL)
    OR
    -- Organizational documents (must be member)
    (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Users can update documents" ON documents;
CREATE POLICY "Users can update documents" ON documents
  FOR UPDATE USING (
    -- Own personal documents
    (user_id = auth.uid() AND organization_id IS NULL)
    OR
    -- Organizational documents (must be member)
    (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

------------------------------------------
-- DOCUMENT CHUNKS POLICIES (HYBRID)
------------------------------------------

DROP POLICY IF EXISTS "Users can view chunks" ON document_chunks;
CREATE POLICY "Users can view chunks" ON document_chunks
  FOR SELECT USING (
    -- Personal chunks (via document ownership)
    document_id IN (
      SELECT id FROM documents
      WHERE user_id = auth.uid() AND organization_id IS NULL
    )
    OR
    -- Organizational chunks
    (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Users can create chunks" ON document_chunks;
CREATE POLICY "Users can create chunks" ON document_chunks
  FOR INSERT WITH CHECK (
    -- Personal chunks
    document_id IN (
      SELECT id FROM documents
      WHERE user_id = auth.uid() AND organization_id IS NULL
    )
    OR
    -- Organizational chunks
    (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Users can delete chunks" ON document_chunks;
CREATE POLICY "Users can delete chunks" ON document_chunks
  FOR DELETE USING (
    -- Personal chunks
    document_id IN (
      SELECT id FROM documents
      WHERE user_id = auth.uid() AND organization_id IS NULL
    )
    OR
    -- Organizational chunks
    (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

------------------------------------------
-- FOLDERS POLICIES (HYBRID)
------------------------------------------

DROP POLICY IF EXISTS "Users can view folders" ON folders;
CREATE POLICY "Users can view folders" ON folders
  FOR SELECT USING (
    -- Own personal folders
    (user_id = auth.uid() AND organization_id IS NULL)
    OR
    -- Organizational folders
    (user_id = auth.uid() AND organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

DROP POLICY IF EXISTS "Users can create folders" ON folders;
CREATE POLICY "Users can create folders" ON folders
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND (
      organization_id IS NULL
      OR
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can update folders" ON folders;
CREATE POLICY "Users can update folders" ON folders
  FOR UPDATE USING (
    user_id = auth.uid()
    AND (
      organization_id IS NULL
      OR
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can delete folders" ON folders;
CREATE POLICY "Users can delete folders" ON folders
  FOR DELETE USING (
    user_id = auth.uid()
    AND (
      organization_id IS NULL
      OR
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

------------------------------------------
-- CHATS POLICIES (HYBRID)
------------------------------------------

DROP POLICY IF EXISTS "Users can view chats" ON chats;
CREATE POLICY "Users can view chats" ON chats
  FOR SELECT USING (
    -- Own personal chats
    (user_id = auth.uid() AND organization_id IS NULL)
    OR
    -- Organizational chats
    (user_id = auth.uid() AND organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    OR
    -- Shared chats
    (shared = true)
  );

DROP POLICY IF EXISTS "Users can create chats" ON chats;
CREATE POLICY "Users can create chats" ON chats
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND (
      -- Personal chat
      organization_id IS NULL
      OR
      -- Organizational chat
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can update chats" ON chats;
CREATE POLICY "Users can update chats" ON chats
  FOR UPDATE USING (
    user_id = auth.uid()
    AND (
      organization_id IS NULL
      OR
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can delete chats" ON chats;
CREATE POLICY "Users can delete chats" ON chats
  FOR DELETE USING (
    user_id = auth.uid()
    AND (
      organization_id IS NULL
      OR
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

------------------------------------------
-- OTHER POLICIES
------------------------------------------

-- Tool execution states
DROP POLICY IF EXISTS "Users can view own tool states" ON tool_execution_states;
CREATE POLICY "Users can view own tool states" ON tool_execution_states
  FOR SELECT USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chats
      WHERE chats.id = tool_execution_states.chat_id
        AND chats.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert tool states" ON tool_execution_states;
CREATE POLICY "Users can insert tool states" ON tool_execution_states
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chats
      WHERE chats.id = tool_execution_states.chat_id
        AND chats.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update tool states" ON tool_execution_states;
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

-- User preferences
DROP POLICY IF EXISTS "Users can view own preferences" ON user_preferences;
CREATE POLICY "Users can view own preferences" ON user_preferences
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own preferences" ON user_preferences;
CREATE POLICY "Users can insert own preferences" ON user_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own preferences" ON user_preferences;
CREATE POLICY "Users can update own preferences" ON user_preferences
  FOR UPDATE USING (auth.uid() = user_id);

-- Admin
DROP POLICY IF EXISTS "Admins can view admin users" ON admin_users;
CREATE POLICY "Admins can view admin users" ON admin_users
  FOR SELECT USING (check_admin_status() OR auth.role() = 'service_role');

DROP POLICY IF EXISTS "Admins can view admin settings" ON admin_settings;
CREATE POLICY "Admins can view admin settings" ON admin_settings
  FOR SELECT USING (check_admin_status() OR auth.role() = 'service_role');

DROP POLICY IF EXISTS "Admins can update settings" ON admin_settings;
CREATE POLICY "Admins can update settings" ON admin_settings
  FOR UPDATE USING (check_admin_status() OR auth.role() = 'service_role');

-- Subscriptions
DROP POLICY IF EXISTS "Users can view own subscription" ON subscriptions;
CREATE POLICY "Users can view own subscription" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage subscriptions" ON subscriptions;
CREATE POLICY "Service role can manage subscriptions" ON subscriptions
  FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role can manage pending subscriptions" ON pending_subscriptions;
CREATE POLICY "Service role can manage pending subscriptions" ON pending_subscriptions
  FOR ALL USING (auth.role() = 'service_role');

-- WhatsApp
DROP POLICY IF EXISTS "Users can view own WhatsApp sessions" ON whatsapp_sessions;
CREATE POLICY "Users can view own WhatsApp sessions" ON whatsapp_sessions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own WhatsApp sessions" ON whatsapp_sessions;
CREATE POLICY "Users can manage own WhatsApp sessions" ON whatsapp_sessions
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own WhatsApp conversations" ON whatsapp_conversations;
CREATE POLICY "Users can view own WhatsApp conversations" ON whatsapp_conversations
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can manage own WhatsApp conversations" ON whatsapp_conversations;
CREATE POLICY "Users can manage own WhatsApp conversations" ON whatsapp_conversations
  FOR ALL USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view messages in their conversations" ON whatsapp_messages;
CREATE POLICY "Users can view messages in their conversations" ON whatsapp_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM whatsapp_conversations wc
      WHERE wc.id = whatsapp_messages.conversation_id
        AND wc.user_id = auth.uid()
    )
  );

-- Tenant usage
DROP POLICY IF EXISTS "Users can view org usage" ON tenant_usage;
CREATE POLICY "Users can view org usage" ON tenant_usage
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role can manage usage" ON tenant_usage;
CREATE POLICY "Service role can manage usage" ON tenant_usage
  FOR ALL USING (auth.role() = 'service_role');

-- API usage logs
DROP POLICY IF EXISTS "Users can view org API logs" ON api_usage_logs;
CREATE POLICY "Users can view org API logs" ON api_usage_logs
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
    OR
    user_id = auth.uid()
  );

DROP POLICY IF EXISTS "Service role can manage API logs" ON api_usage_logs;
CREATE POLICY "Service role can manage API logs" ON api_usage_logs
  FOR ALL USING (auth.role() = 'service_role');

-- Storage policies
DO $$
BEGIN
  CREATE POLICY "Chat images are publicly accessible" ON storage.objects
    FOR SELECT USING (bucket_id = 'chat-images');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Users can upload chat images" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'chat-images' AND auth.role() = 'authenticated');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Users can delete own chat images" ON storage.objects
    FOR DELETE USING (bucket_id = 'chat-images' AND auth.uid() = owner);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Backgrounds are publicly accessible" ON storage.objects
    FOR SELECT USING (bucket_id = 'backgrounds');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Users can upload backgrounds" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'backgrounds' AND auth.role() = 'authenticated');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Users can update own backgrounds" ON storage.objects
    FOR UPDATE USING (bucket_id = 'backgrounds' AND owner = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY "Users can delete own backgrounds" ON storage.objects
    FOR DELETE USING (bucket_id = 'backgrounds' AND owner = auth.uid());
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

------------------------------------------
-- TRIGGERS
------------------------------------------

DROP TRIGGER IF EXISTS update_organizations_updated_at ON organizations;
CREATE TRIGGER update_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_last_updated_timestamp();

DROP TRIGGER IF EXISTS update_chats_updated_at ON chats;
CREATE TRIGGER update_chats_updated_at
  BEFORE UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION set_last_updated_timestamp();

DROP TRIGGER IF EXISTS update_folders_updated_at ON folders;
CREATE TRIGGER update_folders_updated_at
  BEFORE UPDATE ON folders
  FOR EACH ROW EXECUTE FUNCTION set_last_updated_timestamp();

DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON user_preferences;
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

------------------------------------------
-- NANGO INTEGRATION TABLES
------------------------------------------

-- Table: nango_connections
-- Stores user connections to external document providers
CREATE TABLE IF NOT EXISTS nango_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
  connected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  sync_enabled BOOLEAN DEFAULT true,
  
  -- Folder-specific sync fields
  sync_folder_id TEXT,
  sync_folder_name TEXT,
  sync_folder_path TEXT,
  
  -- File-specific sync fields
  sync_file_ids TEXT[],
  sync_file_names TEXT[],
  
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_user_provider UNIQUE (user_id, provider)
);

-- Table: nango_sync_records
-- Tracks individual file sync status
CREATE TABLE IF NOT EXISTS nango_sync_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'disconnected')),
  last_synced_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_user_file UNIQUE (user_id, file_id)
);

-- Indexes for nango_connections
CREATE INDEX IF NOT EXISTS idx_nango_connections_user_id
  ON nango_connections(user_id);

CREATE INDEX IF NOT EXISTS idx_nango_connections_status
  ON nango_connections(status);

CREATE INDEX IF NOT EXISTS idx_nango_connections_provider
  ON nango_connections(provider);

CREATE INDEX IF NOT EXISTS idx_nango_connections_sync_folder
  ON nango_connections(sync_folder_id);

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

-- Indexes for nango_sync_records
CREATE INDEX IF NOT EXISTS idx_nango_sync_records_user_id
  ON nango_sync_records(user_id);

CREATE INDEX IF NOT EXISTS idx_nango_sync_records_status
  ON nango_sync_records(status);

CREATE INDEX IF NOT EXISTS idx_nango_sync_records_document_id
  ON nango_sync_records(document_id);

CREATE INDEX IF NOT EXISTS idx_nango_sync_records_connection
  ON nango_sync_records(connection_id, provider);

-- Enable RLS for nango tables
ALTER TABLE nango_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE nango_sync_records ENABLE ROW LEVEL SECURITY;

-- Users can only see their own connections
DROP POLICY IF EXISTS "Users can view own connections" ON nango_connections;
CREATE POLICY "Users can view own connections"
  ON nango_connections FOR SELECT
  USING (auth.uid() = user_id);

-- Connections are written only by the server (service role) after it has checked the Nango end_user.
-- Users get no INSERT/UPDATE/DELETE: a user-written connection_id would bypass that check.
DROP POLICY IF EXISTS "Users can insert own connections" ON nango_connections;
DROP POLICY IF EXISTS "Users can update own connections" ON nango_connections;
DROP POLICY IF EXISTS "Users can delete own connections" ON nango_connections;
REVOKE INSERT, UPDATE, DELETE ON nango_connections FROM anon, authenticated;

-- Users can only see their own sync records
DROP POLICY IF EXISTS "Users can view own sync records" ON nango_sync_records;
CREATE POLICY "Users can view own sync records"
  ON nango_sync_records FOR SELECT
  USING (auth.uid() = user_id);

-- Sync records are written only by the server (service role).
DROP POLICY IF EXISTS "Users can insert own sync records" ON nango_sync_records;
DROP POLICY IF EXISTS "Users can update own sync records" ON nango_sync_records;
REVOKE INSERT, UPDATE, DELETE ON nango_sync_records FROM anon, authenticated;

-- Grant service role access (for webhook and sync operations)
GRANT ALL ON nango_connections TO service_role;
GRANT ALL ON nango_sync_records TO service_role;

------------------------------------------
-- CONNECTOR CONFIG TABLES
------------------------------------------

-- Table: connector_config
-- Configuration for supported connectors
CREATE TABLE IF NOT EXISTS connector_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL UNIQUE,
  enabled BOOLEAN DEFAULT true,
  show_on_dashboard BOOLEAN DEFAULT true,
  button_label TEXT,
  description TEXT,
  icon_url TEXT,
  supported_file_types TEXT[] DEFAULT ARRAY['pdf', 'doc', 'docx', 'txt'],
  max_files_per_sync INTEGER DEFAULT 100,
  oauth_client_id TEXT,
  oauth_client_secret TEXT,
  oauth_scopes TEXT[],
  config_metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Table: connector_feature_settings
-- Global connector feature settings
CREATE TABLE IF NOT EXISTS connector_feature_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_enabled BOOLEAN DEFAULT true,
  show_on_dashboard BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_connector_config_provider ON connector_config(provider);
CREATE INDEX IF NOT EXISTS idx_connector_feature_settings_id ON connector_feature_settings(id);

-- Insert default configurations
INSERT INTO connector_config (provider, enabled, show_on_dashboard, button_label, description)
VALUES
  ('google-drive', true, true, 'Connect Google Drive', 'Import files from your Google Drive'),
  ('notion', true, true, 'Connect Notion', 'Sync pages from your Notion workspace'),
  ('dropbox', true, true, 'Connect Dropbox', 'Sync documents from Dropbox')
ON CONFLICT (provider) DO NOTHING;

-- Insert default feature settings
INSERT INTO connector_feature_settings (feature_enabled, show_on_dashboard)
VALUES (true, true)
ON CONFLICT DO NOTHING;

-- Enable RLS for connector tables
ALTER TABLE connector_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_feature_settings ENABLE ROW LEVEL SECURITY;

-- Admin-only policy for connector_config write
DROP POLICY IF EXISTS connector_config_admin ON connector_config;
CREATE POLICY connector_config_admin
  ON connector_config
  FOR ALL
  USING (auth.jwt()->>'role' = 'admin')
  WITH CHECK (auth.jwt()->>'role' = 'admin');

-- All users can read connector_config
DROP POLICY IF EXISTS connector_config_read ON connector_config;
CREATE POLICY connector_config_read
  ON connector_config
  FOR SELECT
  USING (true);

-- Admin-only policy for connector_feature_settings write
DROP POLICY IF EXISTS connector_feature_settings_admin ON connector_feature_settings;
CREATE POLICY connector_feature_settings_admin
  ON connector_feature_settings
  FOR ALL
  USING (auth.jwt()->>'role' = 'admin')
  WITH CHECK (auth.jwt()->>'role' = 'admin');

-- All users can read connector_feature_settings
DROP POLICY IF EXISTS connector_feature_settings_read ON connector_feature_settings;
CREATE POLICY connector_feature_settings_read
  ON connector_feature_settings
  FOR SELECT
  USING (true);

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

COMMIT;

------------------------------------------
-- COMPLETION MESSAGE
------------------------------------------

SELECT
  '✅ myRAG Multi-Tenant Setup Complete!' as status,
  NOW() as completed_at;

SELECT
  'Workspace Types:' as info,
  '1. Personal Workspace (Flat) - No organization, user_id isolation' as type1,
  '2. Personal Projects - is_personal=true, owner only, can be made collaborative' as type2,
  '3. Collaborative Projects - is_personal=false, multi-member (via shareOrganization)' as type3;

SELECT
  'Features Enabled:' as features,
  '✓ Three-tier workspace architecture' as feature1,
  '✓ Hybrid isolation (user_id + organization_id)' as feature2,
  '✓ Organization-based multi-tenancy with RLS' as feature3,
  '✓ Collaboration with role-based access' as feature4,
  '✓ Storage quotas and usage tracking' as feature5,
  '✓ Personal → Collaborative conversion (shareOrganization)' as feature6,
  '✓ Vector search optimization (HNSW)' as feature7;

SELECT
  'Next Steps:' as info,
  '1. Set NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=multi-tenant in .env.local' as step1,
  '2. Restart development server: npm run dev' as step2,
  '3. Test flat personal workspace (no orgs)' as step3,
  '4. Create personal projects via UI' as step4,
  '5. Enable collaboration on personal projects (via shareOrganization)' as step5,
  '6. Test inviting collaborators to collaborative projects' as step6;

------------------------------------------
-- Document URL Management Helper Functions
------------------------------------------

-- Function to update metadata for a document by filename
-- This is useful for adding external URLs to existing documents
CREATE OR REPLACE FUNCTION update_document_url_by_filename(doc_filename TEXT, url TEXT)
RETURNS void AS $$
DECLARE
    doc_id UUID;
    current_metadata JSONB;
BEGIN
    SELECT id, metadata INTO doc_id, current_metadata FROM documents WHERE filename = doc_filename LIMIT 1;
    IF doc_id IS NOT NULL THEN
        UPDATE documents 
        SET metadata = jsonb_set(COALESCE(current_metadata, '{}'::jsonb), '{external_url}', to_jsonb(url))
        WHERE id = doc_id;
        RAISE NOTICE 'Updated URL for document: % (ID: %)', doc_filename, doc_id;
    ELSE
        RAISE NOTICE 'Document not found: %', doc_filename;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Example usage (commented out - uncomment and modify as needed):
-- SELECT update_document_url_by_filename('example-document.pdf', 'https://example.com/source-page');

------------------------------------------
-- Phase 3: Unified ingestion & embedding profiles (migrations 0301-0319)
------------------------------------------

-- >>> supabase/migrations/0301_documents_versions.sql
-- 0301: document identity, versions, status, type, hashes, parser and profile columns (Phase 3, D-06).
-- Additive and idempotent. Existing rows become version 1, current, ready, type general, their own lineage, parsed by the legacy parser.
-- Run after the setup file; the tenant_key column and its indexes are in 0301_documents_versions.<mode>.sql, which runs right after this file.

BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS lineage_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS superseded_by uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_status text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'general';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type_origin text NOT NULL DEFAULT 'fallback';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_date date;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_sha256 text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parser_used text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parser_version text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_profile_id text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_profile_version integer;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS original_path text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_status_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_status_check
      CHECK (status IN ('processing', 'ready', 'quarantined', 'failed', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_doc_type_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_doc_type_check
      CHECK (doc_type IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_doc_type_origin_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_doc_type_origin_check
      CHECK (doc_type_origin IN ('picked', 'source_default', 'tenant_default', 'auto', 'fallback'));
  END IF;
END $$;

-- Rows that have no lineage yet are pre-Phase-3 rows: each is its own lineage, parsed by the legacy parser.
-- parser_used and parser_version are only stamped here, so rows written later keep what their writer recorded.
UPDATE documents
SET lineage_id = id,
    parser_used = COALESCE(parser_used, 'llamaparse'),
    parser_version = COALESCE(parser_version, 'legacy')
WHERE lineage_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_lineage_version_ux ON documents (lineage_id, version);

COMMIT;

-- >>> supabase/migrations/0301_documents_versions.multi-tenant.sql
-- 0301 (multi-tenant): tenant_key is o:<organization_id> for an organization row and u:<user_id> for a personal row.
-- Same semantics as scopeKey() and as the predicate of match_documents_by_workspace.
-- Adding a stored generated column rewrites the table once; run it in a quiet window on a large project.

BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS (
  CASE WHEN organization_id IS NOT NULL THEN 'o:' || organization_id::text ELSE 'u:' || user_id::text END
) STORED;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_file_sha256 ON documents (tenant_key, file_sha256);
CREATE INDEX IF NOT EXISTS idx_documents_tenant_content_hash ON documents (tenant_key, content_hash);

COMMIT;

-- >>> supabase/migrations/0302_documents_source.sql
-- 0302: widen documents.source to chat_upload | config_upload | nango | scraper | image_upload | ai_to_rag (Phase 3, D-06 with F-1).
-- The old CHECK is found through pg_constraint because the live name may differ from the committed one (the committed CHECK cannot hold
-- the values today's writers send, so a live project has probably been altered by hand). Old values map as follows:
--   upload -> config_upload; google-drive / notion / dropbox -> nango (source_provider filled from the old value when empty);
--   scrape -> scraper; anything else, or NULL -> config_upload.
-- A value that changed is kept in metadata.legacy_source.

BEGIN;

DO $$
DECLARE
  source_attnum smallint;
  check_name text;
BEGIN
  SELECT attnum INTO source_attnum
  FROM pg_attribute
  WHERE attrelid = to_regclass('public.documents') AND attname = 'source' AND NOT attisdropped;
  FOR check_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = to_regclass('public.documents') AND contype = 'c' AND conkey @> ARRAY[source_attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.documents DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

UPDATE documents
SET metadata = CASE
      WHEN source IS NULL OR (metadata IS NOT NULL AND metadata->'legacy_source' IS NOT NULL) THEN metadata
      ELSE COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('legacy_source', source)
    END,
    source_provider = CASE
      WHEN COALESCE(source_provider, '') = '' AND source IN ('google-drive', 'notion', 'dropbox') THEN source
      ELSE source_provider
    END,
    source = CASE
      WHEN source IN ('google-drive', 'notion', 'dropbox') THEN 'nango'
      WHEN source = 'scrape' THEN 'scraper'
      ELSE 'config_upload'
    END
WHERE source IS NULL OR source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag');

ALTER TABLE documents ALTER COLUMN source SET DEFAULT 'config_upload';

ALTER TABLE documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag'));

COMMIT;

-- >>> supabase/migrations/0303_documents_identity.sql
-- 0303: backfill documents.source_key and create the lineage identity index (Phase 3, D-06, D-10).
-- Nango and scraper rows take their source_file_id as source_key on the newest row per (tenant_key, source, source_file_id);
-- older duplicates and every other row get legacy:<id>. The unique index therefore cannot fail on existing duplicates, and the next
-- sync of a file becomes version 2 of its newest legacy row. Hashes are not backfilled here: content_hash comes from one TypeScript
-- normaliser, and file_sha256 stays NULL because the original bytes were never stored.

BEGIN;

WITH ranked AS (
  SELECT id,
         source_file_id,
         row_number() OVER (PARTITION BY tenant_key, source, source_file_id ORDER BY created_at DESC NULLS LAST, id DESC) AS position
  FROM documents
  WHERE source_key IS NULL
    AND source IN ('nango', 'scraper')
    AND source_file_id IS NOT NULL
    AND source_file_id <> ''
)
UPDATE documents d
SET source_key = ranked.source_file_id
FROM ranked
WHERE d.id = ranked.id AND ranked.position = 1;

UPDATE documents SET source_key = 'legacy:' || id::text WHERE source_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_lineage_identity_ux ON documents (tenant_key, source, source_key) WHERE is_current;

COMMIT;

-- >>> supabase/migrations/0304_chunks_promoted.sql
-- 0304: promoted and denormalised document_chunks columns (Phase 3, D-07).
-- tenant_key, version, is_current, status, doc_type, doc_date, language, source and parser_used mirror the parent document so that
-- retrieval can filter without a join. Existing chunks copy them from their document; chunks written later by a legacy writer get them
-- from the trigger in 0305. section_path, lexical_text and embedding_text_version are filled by the unified writer; embedding_text_version
-- 0 means "legacy text, no path prefix". No lexical_text index here: that belongs to hybrid search.

BEGIN;

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tenant_key text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS version integer;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS doc_type text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS doc_date date;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS page_start integer;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS page_end integer;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS section_path text[] NOT NULL DEFAULT '{}';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS chunk_kind text NOT NULL DEFAULT 'text';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS parser_used text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding_text_version integer NOT NULL DEFAULT 0;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS lexical_text text;
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS chunk_index integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.document_chunks') AND conname = 'document_chunks_status_check') THEN
    ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_status_check
      CHECK (status IN ('processing', 'ready', 'quarantined', 'failed', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.document_chunks') AND conname = 'document_chunks_chunk_kind_check') THEN
    ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_chunk_kind_check
      CHECK (chunk_kind IN ('text', 'table', 'image', 'invoice_header'));
  END IF;
END $$;

-- Existing chunks copy the denormalised values of their document; a chunk with an image URL is an image chunk.
UPDATE document_chunks dc
SET tenant_key = d.tenant_key,
    version = d.version,
    is_current = d.is_current,
    status = d.status,
    doc_type = d.doc_type,
    doc_date = d.doc_date,
    language = d.language,
    source = d.source,
    parser_used = d.parser_used,
    chunk_kind = CASE WHEN dc.metadata->'image_url' IS NOT NULL THEN 'image' ELSE dc.chunk_kind END
FROM documents d
WHERE d.id = dc.document_id AND dc.tenant_key IS NULL;

-- Every vector row records its model: the legacy column always holds text-embedding-3-small at 1536 dimensions.
UPDATE document_chunks
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536)
WHERE embedding IS NOT NULL AND (metadata IS NULL OR metadata->'embedding_model' IS NULL);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_chunk_index ON document_chunks (document_id, chunk_index);

COMMIT;

-- >>> supabase/migrations/0305_legacy_compat_triggers.sql
-- 0305: BEFORE INSERT triggers that keep today's legacy writers valid (Phase 3, F-1).
-- RAG_INGEST_PIPELINE=legacy stays the default writer. It inserts documents with source 'upload' | 'nango' | 'scrape' | 'google-drive'
-- (or none) and no lineage_id or source_key, and chunks with no tenant_key. The triggers fill what is missing and never overwrite a
-- value the writer supplied (a chunk's tenant_key is the exception: it always follows its document), so the unified writer is not
-- affected. Parser stamps are applied only to rows without a lineage_id.

BEGIN;

CREATE OR REPLACE FUNCTION rag_documents_legacy_defaults() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  original_source text;
BEGIN
  IF NEW.lineage_id IS NULL THEN
    NEW.parser_used := COALESCE(NEW.parser_used, 'llamaparse');
    NEW.parser_version := COALESCE(NEW.parser_version, 'legacy');
  END IF;

  IF NEW.source IS NULL OR NEW.source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    original_source := NEW.source;
    IF original_source IN ('google-drive', 'notion', 'dropbox') AND COALESCE(NEW.source_provider, '') = '' THEN
      NEW.source_provider := original_source;
    END IF;
    NEW.source := CASE
      WHEN original_source IN ('google-drive', 'notion', 'dropbox') THEN 'nango'
      WHEN original_source = 'scrape' THEN 'scraper'
      ELSE 'config_upload'
    END;
    IF original_source IS NOT NULL AND (NEW.metadata IS NULL OR NEW.metadata->'legacy_source' IS NULL) THEN
      NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('legacy_source', original_source);
    END IF;
  END IF;

  NEW.lineage_id := COALESCE(NEW.lineage_id, NEW.id);
  NEW.source_key := COALESCE(NEW.source_key, 'legacy:' || NEW.id::text);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION rag_chunks_legacy_defaults() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent record;
  legacy_shape boolean := NEW.tenant_key IS NULL;
BEGIN
  -- SECURITY DEFINER so the lookup does not depend on what the inserting role may read: the chunk's tenant_key is always its document's,
  -- whatever the writer sent. Every other denormalised column only fills a NULL.
  SELECT d.tenant_key, d.version, d.doc_type, d.doc_date, d.language, d.source, d.parser_used
  INTO parent
  FROM documents d
  WHERE d.id = NEW.document_id;
  IF FOUND THEN
    NEW.tenant_key := parent.tenant_key;
    NEW.version := COALESCE(NEW.version, parent.version);
    NEW.doc_type := COALESCE(NEW.doc_type, parent.doc_type);
    NEW.doc_date := COALESCE(NEW.doc_date, parent.doc_date);
    NEW.language := COALESCE(NEW.language, parent.language);
    NEW.source := COALESCE(NEW.source, parent.source);
    NEW.parser_used := COALESCE(NEW.parser_used, parent.parser_used);
  END IF;

  IF legacy_shape AND NEW.chunk_kind = 'text' AND NEW.metadata->'image_url' IS NOT NULL THEN
    NEW.chunk_kind := 'image';
  END IF;
  RETURN NEW;
END
$$;

-- Trigger functions run without an EXECUTE check on the inserting role; nothing but the triggers should be able to name them.
REVOKE ALL ON FUNCTION rag_documents_legacy_defaults() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_chunks_legacy_defaults() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_documents_legacy_defaults ON documents;
CREATE TRIGGER rag_documents_legacy_defaults
  BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION rag_documents_legacy_defaults();

DROP TRIGGER IF EXISTS rag_chunks_legacy_defaults ON document_chunks;
CREATE TRIGGER rag_chunks_legacy_defaults
  BEFORE INSERT ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION rag_chunks_legacy_defaults();

-- Rows inserted between 0303 and this file have no identity yet; the NOT NULL below needs them backfilled.
UPDATE documents SET lineage_id = id WHERE lineage_id IS NULL;
UPDATE documents SET source_key = 'legacy:' || id::text WHERE source_key IS NULL;

ALTER TABLE documents ALTER COLUMN lineage_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN source_key SET NOT NULL;

COMMIT;

-- >>> supabase/migrations/0306_retrieval_filters.multi-tenant.sql
-- 0306 (multi-tenant): retrieval hides non-current and non-ready chunks (Phase 3, D-08). There is no switch: quarantine is a security control.
-- Every function below is the definition from multi-tenant-setup.sql with one added predicate:
--   AND dc.is_current AND dc.status = 'ready'
-- CREATE OR REPLACE keeps the owner, the grants and the comment of each function. Existing rows are current and ready, so results on
-- existing data do not change.

BEGIN;

CREATE OR REPLACE FUNCTION match_documents_by_organization(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  org_id uuid
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  metadata jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    dc.metadata,
    1 - (dc.embedding <=> query_embedding) as similarity
  FROM document_chunks dc
  WHERE dc.organization_id = org_id
    AND 1 - (dc.embedding <=> query_embedding) > match_threshold
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(
  p_query_embedding vector(1536),
  p_match_count integer,
  p_min_similarity double precision,
  p_org_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> p_query_embedding) as similarity,
    dc.metadata
  FROM document_chunks dc
  INNER JOIN documents d ON d.id = dc.document_id
  WHERE dc.embedding IS NOT NULL
    AND dc.is_current AND dc.status = 'ready'
    AND 1 - (dc.embedding <=> p_query_embedding) > p_min_similarity
    AND (
      -- Personal workspace: user owns document and no organization
      (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
      OR
      -- Team workspace: document belongs to organization
      (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
    )
  ORDER BY dc.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;


CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  match_count integer,
  similarity_threshold double precision
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SET search_path = 'pg_catalog', 'public'
AS $$
DECLARE
  current_user_id UUID;
  current_org_id UUID;
BEGIN
  -- Get current user ID
  current_user_id := auth.uid();
  
  -- Get user's current organization if in multi-tenant mode
  SELECT current_organization_id INTO current_org_id
  FROM user_preferences
  WHERE user_id = current_user_id;
  
  -- Return chunks based on organization context
  RETURN QUERY
  SELECT
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity,
    dc.metadata
  FROM document_chunks dc
  INNER JOIN documents d ON dc.document_id = d.id
  WHERE dc.embedding IS NOT NULL 
    AND 1 - (dc.embedding <=> query_embedding) > similarity_threshold
    AND dc.is_current AND dc.status = 'ready'
    AND (
      -- Personal workspace: match null org_id docs
      (current_org_id IS NULL AND dc.organization_id IS NULL)
      OR
      -- Organization workspace: match org docs OR personal docs owned by user
      (current_org_id IS NOT NULL AND (
        dc.organization_id = current_org_id
        OR (dc.organization_id IS NULL AND d.user_id = current_user_id)
      ))
    )
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;


CREATE OR REPLACE FUNCTION match_document_chunks_by_org(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count integer DEFAULT 8,
  p_min_similarity double precision DEFAULT 0.2
)
RETURNS TABLE (
  document_id uuid,
  chunk_id uuid,
  content text,
  similarity double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.document_id,
    dc.id as chunk_id,
    dc.content,
    1 - (dc.embedding <=> p_query_embedding) as similarity
  FROM document_chunks dc
  WHERE (dc.organization_id = p_org_id OR dc.organization_id IS NULL)
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding <=> p_query_embedding) >= p_min_similarity
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;

COMMIT;

-- >>> supabase/migrations/0307_embedding_profiles.sql
-- 0307: embedding profile registry (Phase 3, D-34, D-36, F-7).
-- One row per embedding profile. The legacy profile stays in document_chunks.embedding (vector(1536)); every other profile stores
-- halfvec rows in chunk_embeddings (0308). Exactly one row is 'active', enforced by a partial unique index. Activation and rollback
-- go through rag_activate_embedding_profile and rag_rollback_embedding_profile (0309). score_calibration holds the similarity
-- thresholds tuned for the profile's model; the legacy row carries today's constants so nothing changes while the switch is off.
-- Everything here is for the server role only: RLS is on without policies and nothing is granted to anon or authenticated.

BEGIN;

CREATE TABLE IF NOT EXISTS embedding_profiles (
  id text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  dims integer NOT NULL CONSTRAINT embedding_profiles_dims_check CHECK (dims > 0 AND dims <= 4000),
  storage text NOT NULL CONSTRAINT embedding_profiles_storage_check CHECK (storage IN ('legacy_column', 'halfvec')),
  status text NOT NULL DEFAULT 'available' CONSTRAINT embedding_profiles_status_check CHECK (status IN ('available', 'backfilling', 'active', 'retired')),
  query_instruction text,
  score_calibration jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at timestamptz,
  activated_by text,
  previous_active_id text REFERENCES embedding_profiles (id),
  eval_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT embedding_profiles_legacy_dims CHECK (storage <> 'legacy_column' OR dims <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS embedding_profiles_single_active ON embedding_profiles ((status)) WHERE status = 'active';

INSERT INTO embedding_profiles (id, provider, model, dims, storage, status, query_instruction, score_calibration, activated_at, activated_by)
VALUES
  (
    'openai-3-small-1536', 'openai', 'text-embedding-3-small', 1536, 'legacy_column', 'active', NULL,
    '{"retrieval_threshold": 0.7, "context_threshold": 0.65, "fallback_threshold": 0.28, "context_image_threshold": 0.25}'::jsonb,
    now(), 'migration'
  ),
  ('voyage-4-large-2048', 'voyage', 'voyage-4-large', 2048, 'halfvec', 'available', NULL, '{}'::jsonb, NULL, NULL),
  ('voyage-4-large-1024', 'voyage', 'voyage-4-large', 1024, 'halfvec', 'available', NULL, '{}'::jsonb, NULL, NULL),
  (
    'qwen3-8b-2048', 'qwen3', 'Qwen/Qwen3-Embedding-8B', 2048, 'halfvec', 'available',
    'Given a web search query, retrieve relevant passages that answer the query', '{}'::jsonb, NULL, NULL
  ),
  (
    'qwen3-8b-1024', 'qwen3', 'Qwen/Qwen3-Embedding-8B', 1024, 'halfvec', 'available',
    'Given a web search query, retrieve relevant passages that answer the query', '{}'::jsonb, NULL, NULL
  )
ON CONFLICT (id) DO NOTHING;

ALTER TABLE embedding_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE embedding_profiles FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE embedding_profiles TO service_role;

CREATE OR REPLACE FUNCTION rag_list_embedding_profiles()
RETURNS TABLE (
  id text,
  provider text,
  model text,
  dims integer,
  storage text,
  status text,
  query_instruction text,
  score_calibration jsonb,
  activated_at timestamptz,
  activated_by text,
  previous_active_id text,
  has_evidence boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.id, p.provider, p.model, p.dims, p.storage, p.status, p.query_instruction, p.score_calibration,
         p.activated_at, p.activated_by, p.previous_active_id, p.eval_evidence IS NOT NULL, p.created_at
  FROM embedding_profiles p
  ORDER BY p.id
$$;

CREATE OR REPLACE FUNCTION rag_set_embedding_profile_status(p_profile_id text, p_status text, p_actor text)
RETURNS TABLE (profile_id text, profile_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'profile_status_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: use_activation_gate' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('available', 'backfilling', 'retired') THEN
    RAISE EXCEPTION 'profile_status_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT p.status INTO v_current FROM embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_status_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_current = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: profile_is_active' USING ERRCODE = '22000';
  END IF;

  UPDATE embedding_profiles SET status = p_status WHERE id = p_profile_id;
  RETURN QUERY SELECT p_profile_id, p_status;
END
$$;

REVOKE ALL ON FUNCTION rag_list_embedding_profiles() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_set_embedding_profile_status(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_list_embedding_profiles() TO service_role;
GRANT EXECUTE ON FUNCTION rag_set_embedding_profile_status(text, text, text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0308_chunk_embeddings.sql
-- 0308: side-by-side halfvec storage for the non-legacy embedding profiles (Phase 3, D-35, D-39).
-- chunk_embeddings holds one row per (chunk, profile). The embedding column has no fixed dimension: a partial expression HNSW index per
-- seeded profile pins the length, and rag_chunk_embeddings_guard enforces the registry length for every profile, so a vector of the
-- wrong length is rejected whether or not the profile has an index yet. The guard also copies tenant_key from the chunk, so a writer
-- cannot place a vector in another tenant's search space. embedding_backfill_runs and embedding_backfill_gaps record the re-embed job.
-- Server role only: RLS on without policies, nothing granted to anon or authenticated.

BEGIN;

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES document_chunks (id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  tenant_key text NOT NULL,
  embedding halfvec NOT NULL,
  embedding_model text NOT NULL,
  dims integer NOT NULL,
  embedding_host text,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, profile_id)
);

CREATE INDEX IF NOT EXISTS chunk_embeddings_profile_tenant_idx ON chunk_embeddings (profile_id, tenant_key);

CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_4_large_2048_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-2048';
CREATE INDEX IF NOT EXISTS chunk_embeddings_voyage_4_large_1024_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'voyage-4-large-1024';
CREATE INDEX IF NOT EXISTS chunk_embeddings_qwen3_8b_2048_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'qwen3-8b-2048';
CREATE INDEX IF NOT EXISTS chunk_embeddings_qwen3_8b_1024_hnsw ON chunk_embeddings
  USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WITH (m = 64, ef_construction = 200)
  WHERE profile_id = 'qwen3-8b-1024';

CREATE OR REPLACE FUNCTION rag_chunk_embeddings_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dims integer;
  v_tenant text;
BEGIN
  SELECT p.dims INTO v_dims FROM embedding_profiles p WHERE p.id = NEW.profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF vector_dims(NEW.embedding) <> v_dims THEN
    RAISE EXCEPTION 'expected % dimensions, not %', v_dims, vector_dims(NEW.embedding) USING ERRCODE = '22000';
  END IF;

  SELECT c.tenant_key INTO v_tenant FROM document_chunks c WHERE c.id = NEW.chunk_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'chunk_embeddings: chunk % has no tenant_key', NEW.chunk_id USING ERRCODE = '23502';
  END IF;
  NEW.tenant_key := v_tenant;
  NEW.dims := vector_dims(NEW.embedding);
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION rag_chunk_embeddings_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_chunk_embeddings_guard ON chunk_embeddings;
CREATE TRIGGER rag_chunk_embeddings_guard
  BEFORE INSERT OR UPDATE OF chunk_id, profile_id, embedding, tenant_key, dims ON chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION rag_chunk_embeddings_guard();

CREATE TABLE IF NOT EXISTS embedding_backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  tenant_key text,
  cursor_chunk_id uuid,
  chunks_total bigint NOT NULL DEFAULT 0,
  chunks_done bigint NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running'
    CONSTRAINT embedding_backfill_runs_status_check CHECK (status IN ('running', 'completed', 'failed', 'rolled_back')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  derived_from text REFERENCES embedding_profiles (id)
);

CREATE INDEX IF NOT EXISTS embedding_backfill_runs_profile_idx ON embedding_backfill_runs (profile_id, started_at DESC);

CREATE TABLE IF NOT EXISTS embedding_backfill_gaps (
  run_id uuid NOT NULL REFERENCES embedding_backfill_runs (id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES document_chunks (id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, chunk_id, profile_id)
);

CREATE INDEX IF NOT EXISTS embedding_backfill_gaps_chunk_idx ON embedding_backfill_gaps (chunk_id);

ALTER TABLE chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_backfill_gaps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE chunk_embeddings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE embedding_backfill_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE embedding_backfill_gaps FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE chunk_embeddings TO service_role;
GRANT ALL ON TABLE embedding_backfill_runs TO service_role;
GRANT ALL ON TABLE embedding_backfill_gaps TO service_role;

-- Profile-aware search. dims and status come from embedding_profiles; p_dims is only a cross-check, because halfvec(n) needs a literal n.
-- The dynamic statement interpolates one registry integer (%1$s) and one quoted literal (%2$L); every caller value is bound with USING.
-- The tenant predicate sits next to the index scan. Iterative scans keep filtered HNSW scans from under-filling on pgvector 0.8.0 and later.
CREATE OR REPLACE FUNCTION match_chunks_by_profile(
  p_tenant_key text,
  p_profile_id text,
  p_dims integer,
  p_query halfvec,
  p_match_count integer,
  p_min_similarity double precision,
  p_require_active boolean DEFAULT true
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  content text,
  similarity double precision,
  metadata jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_dims integer;
  v_status text;
  v_version text;
BEGIN
  SELECT p.dims, p.status INTO v_dims, v_status FROM embedding_profiles p WHERE p.id = p_profile_id;
  IF v_dims IS NULL THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_dims <> p_dims OR vector_dims(p_query) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;
  IF p_require_active AND v_status <> 'active' THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: profile not active' USING ERRCODE = '22000';
  END IF;

  SELECT extversion INTO v_version FROM pg_extension WHERE extname = 'vector';
  IF v_version IS NOT NULL AND (string_to_array(v_version, '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
    PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT c.id, c.document_id, c.content,
           1 - ((e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)) AS similarity,
           c.metadata
    FROM chunk_embeddings e
    JOIN document_chunks c ON c.id = e.chunk_id
    WHERE e.profile_id = %2$L
      AND e.tenant_key = $2
      AND c.is_current AND c.status = 'ready'
      AND 1 - ((e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)) > $3
    ORDER BY (e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)
    LIMIT $4
  $q$, v_dims, p_profile_id)
  USING p_query, p_tenant_key, p_min_similarity, p_match_count;
END
$fn$;

REVOKE ALL ON FUNCTION match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION match_chunks_by_profile(text, text, integer, halfvec, integer, double precision, boolean) TO service_role;

COMMIT;

-- >>> supabase/migrations/0309_profile_activation.sql
-- 0309: gated activation and rollback of an embedding profile (Phase 3, D-36, D-40).
-- rag_activate_embedding_profile refuses, each with its own message prefix, unless the target is complete (every current ready chunk has
-- a vector), consistent (every row has the profile's model and dims) and proven (eval_evidence names the target, the active profile as
-- baseline, a passing gate, a passing pre_migration slice, a completed backfill run of the target, and is newer than the target's data).
-- Completeness is counted in the same transaction as the flip, under a table lock that serialises activations and status changes.
-- rag_rollback_embedding_profile restores previous_active_id when that profile still has a vector for every current ready chunk.
-- The legacy profile keeps its vectors in document_chunks.embedding, so for it the checks read that column. Server role only.

BEGIN;

CREATE OR REPLACE FUNCTION rag_activate_embedding_profile(p_target text, p_actor text)
RETURNS TABLE (activated_profile text, previous_profile text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_target embedding_profiles%ROWTYPE;
  v_active text;
  v_missing bigint;
  v_bad bigint;
  v_evidence jsonb;
  v_recorded timestamptz;
  v_last timestamptz;
  v_slice_ok boolean;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'activation_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_target FROM embedding_profiles WHERE id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_target.status = 'active' THEN
    RAISE EXCEPTION 'activation_refused: already_active' USING ERRCODE = '55000';
  END IF;
  SELECT p.id INTO v_active FROM embedding_profiles p WHERE p.status = 'active';

  IF v_target.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p_target);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'activation_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, p_target
      USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    SELECT count(*) INTO v_bad FROM chunk_embeddings e
    WHERE e.profile_id = p_target AND (e.embedding_model <> v_target.model OR e.dims <> v_target.dims);
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'activation_refused: model_mismatch (% rows of profile % differ from model % at % dims)', v_bad, p_target, v_target.model, v_target.dims
        USING ERRCODE = '55000';
    END IF;
  END IF;

  v_evidence := v_target.eval_evidence;
  IF v_evidence IS NULL OR jsonb_typeof(v_evidence) <> 'object' THEN
    RAISE EXCEPTION 'activation_refused: eval_missing' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'target_profile' IS DISTINCT FROM p_target THEN
    RAISE EXCEPTION 'activation_refused: eval_target_mismatch' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'baseline_profile' IS DISTINCT FROM v_active THEN
    RAISE EXCEPTION 'activation_refused: eval_baseline_mismatch (evidence baseline %, active profile %)', v_evidence->>'baseline_profile', v_active
      USING ERRCODE = '55000';
  END IF;
  IF v_evidence->'gate_passed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'activation_refused: eval_failed' USING ERRCODE = '55000';
  END IF;
  v_slice_ok := coalesce(v_evidence#>'{pre_migration,passed}' = 'true'::jsonb, false)
    AND coalesce(CASE WHEN jsonb_typeof(v_evidence#>'{pre_migration,n}') = 'number' THEN (v_evidence#>>'{pre_migration,n}')::numeric >= 1 END, false);
  IF NOT v_slice_ok THEN
    RAISE EXCEPTION 'activation_refused: pre_migration_missing' USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    IF NOT EXISTS (
      SELECT 1 FROM embedding_backfill_runs r
      WHERE r.id::text = v_evidence->>'backfill_run_id' AND r.profile_id = p_target AND r.status = 'completed'
    ) THEN
      RAISE EXCEPTION 'activation_refused: eval_run_mismatch' USING ERRCODE = '55000';
    END IF;
    SELECT max(e.embedded_at) INTO v_last FROM chunk_embeddings e WHERE e.profile_id = p_target;
  ELSE
    SELECT max(c.created_at) INTO v_last FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NOT NULL;
  END IF;

  BEGIN
    v_recorded := (v_evidence->>'recorded_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_recorded := NULL;
  END;
  IF v_recorded IS NULL OR (v_last IS NOT NULL AND v_recorded < v_last) THEN
    RAISE EXCEPTION 'activation_refused: eval_stale (evidence recorded %, data embedded %)', v_recorded, v_last USING ERRCODE = '55000';
  END IF;

  UPDATE embedding_profiles SET status = 'available' WHERE status = 'active';
  UPDATE embedding_profiles
  SET status = 'active', previous_active_id = v_active, activated_at = now(), activated_by = p_actor
  WHERE id = p_target;

  RETURN QUERY SELECT p_target, v_active;
END
$$;

CREATE OR REPLACE FUNCTION rag_rollback_embedding_profile(p_actor text)
RETURNS TABLE (restored_profile text, rolled_back_profile text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_active embedding_profiles%ROWTYPE;
  v_previous embedding_profiles%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_active FROM embedding_profiles WHERE status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_active' USING ERRCODE = '55000';
  END IF;
  IF v_active.previous_active_id IS NULL THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_previous FROM embedding_profiles WHERE id = v_active.previous_active_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;

  IF v_previous.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = v_previous.id);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'rollback_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, v_previous.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE embedding_profiles SET status = 'available' WHERE id = v_active.id;
  UPDATE embedding_profiles
  SET status = 'active', previous_active_id = NULL, activated_at = now(), activated_by = p_actor
  WHERE id = v_previous.id;

  RETURN QUERY SELECT v_previous.id, v_active.id;
END
$$;

REVOKE ALL ON FUNCTION rag_activate_embedding_profile(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_rollback_embedding_profile(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_activate_embedding_profile(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_rollback_embedding_profile(text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0310_ingest_writer.sql
-- 0310: the ingest writer as SQL functions (Phase 3, Pattern 2; D-06, D-09, D-10, D-11).
-- Every write to documents and document_chunks made by the unified pipeline goes through these functions: one transaction per call,
-- the same behaviour in the single-tenant and multi-tenant schemas, safe to retry. They are SECURITY DEFINER, check that the row they touch
-- belongs to p_tenant_key (raising tenant_mismatch otherwise, which is also what a missing id raises, so ids of other tenants are not
-- distinguishable from unknown ones), and are executable by service_role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

-- Starts a version of an identity (tenant_key, source, source_key). Outcomes: created, resumed (a processing row of the same identity
-- and file hash already exists) and skipped_duplicate (a current document of this tenant already has the file hash; duplicate_of names it).
-- The new row is not current and is processing until rag_publish_document_version swaps it in. It carries the user-set external_url of the
-- previous version and no content_type or slug (documents_org_type_slug_ux is unique; the publish function moves them).
CREATE OR REPLACE FUNCTION rag_begin_document_version(
  p_tenant_key text,
  p_user_id uuid,
  p_org_id uuid,
  p_source text,
  p_source_key text,
  p_filename text,
  p_file_sha256 text,
  p_doc_type text,
  p_doc_type_origin text,
  p_profile_id text,
  p_profile_version integer
)
RETURNS TABLE (outcome text, document_id uuid, version integer, lineage_id uuid, duplicate_of uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  multi_tenant boolean;
  expected_key text;
  duplicate_id uuid;
  existing record;
  previous record;
  new_id uuid := gen_random_uuid();
  new_version integer;
  new_lineage uuid;
  carried jsonb := '{}'::jsonb;
BEGIN
  IF p_tenant_key IS NULL OR p_source_key IS NULL OR p_source_key = '' THEN
    RAISE EXCEPTION 'invalid_argument: p_tenant_key and p_source_key are required';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    RAISE EXCEPTION 'invalid_source: %', COALESCE(p_source, '(null)');
  END IF;

  -- user_id is NOT NULL in the multi-tenant schema and nullable in the single-tenant one.
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    expected_key := CASE WHEN p_org_id IS NOT NULL THEN 'o:' || p_org_id::text ELSE 'u:' || p_user_id::text END;
  ELSE
    expected_key := 's:default';
  END IF;
  IF p_tenant_key IS DISTINCT FROM expected_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'p_tenant_key is not the tenant key of the given user and organization';
  END IF;
  IF multi_tenant AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_user_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_key || '|' || p_source || '|' || p_source_key, 0));

  IF p_file_sha256 IS NOT NULL THEN
    SELECT d.id INTO duplicate_id
    FROM documents d
    WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = p_file_sha256 AND d.is_current AND d.status = 'ready'
    ORDER BY d.created_at, d.id
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'skipped_duplicate'::text, NULL::uuid, NULL::integer, NULL::uuid, duplicate_id;
      RETURN;
    END IF;
  END IF;

  SELECT d.id, d.version, d.lineage_id INTO existing
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
    AND d.status = 'processing' AND NOT d.is_current AND d.file_sha256 IS NOT DISTINCT FROM p_file_sha256
  ORDER BY d.version DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'resumed'::text, existing.id, existing.version, existing.lineage_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.lineage_id, d.metadata INTO previous
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
  ORDER BY d.is_current DESC, d.version DESC, d.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    new_lineage := previous.lineage_id;
    SELECT COALESCE(max(d.version), 0) + 1 INTO new_version FROM documents d WHERE d.lineage_id = new_lineage;
    IF previous.metadata ? 'external_url' THEN
      carried := jsonb_build_object('external_url', previous.metadata -> 'external_url');
    END IF;
  ELSE
    new_lineage := new_id;
    new_version := 1;
  END IF;

  INSERT INTO documents (
    id, lineage_id, version, is_current, status, source, source_key, filename, content, metadata,
    user_id, organization_id, file_sha256, doc_type, doc_type_origin, processing_profile_id, processing_profile_version
  ) VALUES (
    new_id, new_lineage, new_version, false, 'processing', p_source, p_source_key, COALESCE(NULLIF(p_filename, ''), p_source_key), '', carried,
    CASE WHEN multi_tenant THEN p_user_id END, CASE WHEN multi_tenant THEN p_org_id END, p_file_sha256,
    COALESCE(p_doc_type, 'general'), COALESCE(p_doc_type_origin, 'fallback'), p_profile_id, p_profile_version
  );

  RETURN QUERY SELECT 'created'::text, new_id, new_version, new_lineage, NULL::uuid;
END
$$;

-- The current, ready document of p_tenant_key with the same normalised content hash, other than p_document_id itself.
-- Nothing outside p_tenant_key is ever read.
CREATE OR REPLACE FUNCTION rag_find_content_duplicate(
  p_tenant_key text,
  p_content_hash text,
  p_document_id uuid
)
RETURNS TABLE (duplicate_of uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_document_id IS NOT NULL THEN
    PERFORM 1 FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
    END IF;
  END IF;
  IF p_content_hash IS NULL OR p_content_hash = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT d.id
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.content_hash = p_content_hash AND d.is_current AND d.status = 'ready'
    AND d.id IS DISTINCT FROM p_document_id
  ORDER BY d.created_at, d.id
  LIMIT 1;
END
$$;

-- Sets a whitelisted subset of document columns. A key that is present sets its column (an explicit null clears it); a key that is absent
-- leaves it alone; metadata is merged. Identity, version, currency and tenant columns are not settable; status may only move to
-- processing, quarantined, failed or deleted (ready is reached through rag_publish_document_version). The chunk columns that mirror a
-- changed field follow it.
CREATE OR REPLACE FUNCTION rag_set_document_fields(
  p_document_id uuid,
  p_tenant_key text,
  p_fields jsonb
)
RETURNS TABLE (document_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  field_name text;
  allowed text[] := ARRAY[
    'content_hash', 'language', 'doc_date', 'doc_type', 'doc_type_origin', 'parser_used', 'parser_version',
    'processing_profile_id', 'processing_profile_version', 'original_path', 'source_provider', 'source_file_id',
    'source_connection_id', 'status', 'metadata'
  ];
  doc documents%ROWTYPE;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_fields: p_fields must be a JSON object';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (field_name = ANY (allowed)) THEN
      RAISE EXCEPTION 'invalid_field: %', field_name;
    END IF;
  END LOOP;
  IF p_fields ? 'status' AND (jsonb_typeof(p_fields -> 'status') <> 'string'
      OR (p_fields ->> 'status') NOT IN ('processing', 'quarantined', 'failed', 'deleted')) THEN
    RAISE EXCEPTION 'invalid_status: %', p_fields ->> 'status';
  END IF;
  IF p_fields ? 'metadata' AND jsonb_typeof(p_fields -> 'metadata') <> 'object' THEN
    RAISE EXCEPTION 'invalid_metadata: metadata must be a JSON object';
  END IF;

  UPDATE documents d SET
    content_hash = CASE WHEN p_fields ? 'content_hash' THEN p_fields ->> 'content_hash' ELSE d.content_hash END,
    language = CASE WHEN p_fields ? 'language' THEN p_fields ->> 'language' ELSE d.language END,
    doc_date = CASE WHEN p_fields ? 'doc_date' THEN (p_fields ->> 'doc_date')::date ELSE d.doc_date END,
    doc_type = CASE WHEN p_fields ? 'doc_type' THEN p_fields ->> 'doc_type' ELSE d.doc_type END,
    doc_type_origin = CASE WHEN p_fields ? 'doc_type_origin' THEN p_fields ->> 'doc_type_origin' ELSE d.doc_type_origin END,
    parser_used = CASE WHEN p_fields ? 'parser_used' THEN p_fields ->> 'parser_used' ELSE d.parser_used END,
    parser_version = CASE WHEN p_fields ? 'parser_version' THEN p_fields ->> 'parser_version' ELSE d.parser_version END,
    processing_profile_id = CASE WHEN p_fields ? 'processing_profile_id' THEN p_fields ->> 'processing_profile_id' ELSE d.processing_profile_id END,
    processing_profile_version = CASE WHEN p_fields ? 'processing_profile_version' THEN (p_fields ->> 'processing_profile_version')::integer ELSE d.processing_profile_version END,
    original_path = CASE WHEN p_fields ? 'original_path' THEN p_fields ->> 'original_path' ELSE d.original_path END,
    source_provider = CASE WHEN p_fields ? 'source_provider' THEN p_fields ->> 'source_provider' ELSE d.source_provider END,
    source_file_id = CASE WHEN p_fields ? 'source_file_id' THEN p_fields ->> 'source_file_id' ELSE d.source_file_id END,
    source_connection_id = CASE WHEN p_fields ? 'source_connection_id' THEN p_fields ->> 'source_connection_id' ELSE d.source_connection_id END,
    status = CASE WHEN p_fields ? 'status' THEN p_fields ->> 'status' ELSE d.status END,
    metadata = CASE WHEN p_fields ? 'metadata' THEN COALESCE(d.metadata, '{}'::jsonb) || (p_fields -> 'metadata') ELSE d.metadata END
  WHERE d.id = p_document_id;

  IF p_fields ?| ARRAY['doc_type', 'doc_date', 'language', 'parser_used', 'status'] THEN
    UPDATE document_chunks c SET
      doc_type = d.doc_type,
      doc_date = d.doc_date,
      language = d.language,
      parser_used = d.parser_used,
      status = d.status,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('doc_type', d.doc_type, 'language', d.language, 'parser_used', d.parser_used)
    FROM documents d
    WHERE d.id = p_document_id AND c.document_id = d.id;
  END IF;

  RETURN QUERY SELECT d.id, d.status FROM documents d WHERE d.id = p_document_id;
END
$$;

-- Replaces processing_status and processing_state (the resumable stage record) on the row.
CREATE OR REPLACE FUNCTION rag_save_ingest_state(
  p_document_id uuid,
  p_tenant_key text,
  p_processing_status text,
  p_state jsonb
)
RETURNS TABLE (document_id uuid, processing_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_state IS NOT NULL AND jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'invalid_state: p_state must be a JSON object';
  END IF;
  UPDATE documents d
  SET processing_status = p_processing_status, processing_state = COALESCE(p_state, '{}'::jsonb)
  WHERE d.id = p_document_id;
  RETURN QUERY SELECT d.id, d.processing_status FROM documents d WHERE d.id = p_document_id;
END
$$;

-- The row a stage runner needs to resume a document. Another tenant's id, and an unknown id, return no row.
CREATE OR REPLACE FUNCTION rag_get_ingest_document(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (
  status text,
  version integer,
  processing_status text,
  processing_state jsonb,
  filename text,
  doc_type text,
  parser_used text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.status, d.version, d.processing_status, d.processing_state, d.filename, d.doc_type, d.parser_used, d.created_at
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$$;

-- Marks a version that did not publish as failed. A current version is never taken down by a failure path.
CREATE OR REPLACE FUNCTION rag_mark_document_failed(
  p_document_id uuid,
  p_tenant_key text,
  p_reason text
)
RETURNS TABLE (document_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  doc documents%ROWTYPE;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.is_current THEN
    RAISE EXCEPTION 'document_is_current' USING DETAIL = 'a current version is not marked failed';
  END IF;
  UPDATE documents d
  SET status = 'failed',
      processing_status = 'failed',
      processing_state = COALESCE(d.processing_state, '{}'::jsonb) || jsonb_build_object('failure_reason', left(COALESCE(p_reason, ''), 1000))
  WHERE d.id = p_document_id;
  UPDATE document_chunks c SET status = 'failed' WHERE c.document_id = p_document_id;
  RETURN QUERY SELECT p_document_id, 'failed'::text;
END
$$;

-- Upserts chunks of a version. A chunk id is a UUID taken from the first 16 bytes of sha256(document_id || ':' || chunk_index), so a retried
-- call lands on the same rows. The denormalised columns come from the document and follow its status and currency; the promoted columns
-- are mirrored into metadata next to the caller's keys. p_embeddings is an object keyed by profile id whose arrays line up with p_chunks;
-- only the legacy profile (the embedding column, 1536 dimensions) is supported here, any other id raises embedding_profile_unsupported
-- (the profile tables arrive with the profile write path). A rewrite replaces the row, so a chunk resent without a vector has none. On
-- p_final the chunks of this document at chunk_index >= p_total are removed.
CREATE OR REPLACE FUNCTION rag_write_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_chunks jsonb,
  p_embeddings jsonb,
  p_final boolean,
  p_total integer
)
RETURNS TABLE (chunks_written integer, chunks_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc documents%ROWTYPE;
  profile_id text;
  chunk_count integer;
  legacy_vectors jsonb;
  written integer := 0;
  deleted integer := 0;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_chunks must be a JSON array';
  END IF;
  chunk_count := jsonb_array_length(p_chunks);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every chunk needs a string content and a numeric chunk_index when it has one';
  END IF;
  IF (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)) <> chunk_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct';
  END IF;
  IF p_final AND (p_total IS NULL OR p_total < 0) THEN
    RAISE EXCEPTION 'invalid_total: p_total is required with p_final';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_id IN SELECT jsonb_object_keys(p_embeddings) LOOP
      IF profile_id <> legacy_profile THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_id;
      END IF;
    END LOOP;
    legacy_vectors := p_embeddings -> legacy_profile;
    IF legacy_vectors IS NOT NULL AND (jsonb_typeof(legacy_vectors) <> 'array' OR jsonb_array_length(legacy_vectors) <> chunk_count) THEN
      RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
    END IF;
  END IF;

  WITH prepared AS (
    SELECT
      e.value AS spec,
      (e.ord - 1)::integer AS position,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS written = ROW_COUNT;

  IF p_final THEN
    DELETE FROM document_chunks c WHERE c.document_id = p_document_id AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

-- The version swap (D-11), one transaction. A quarantined version is neither promoted nor allowed to demote the current one (a release
-- publishes it later); a version that is already current and ready is left as it is. Order matters: the previous current row is demoted
-- first because documents_lineage_identity_ux allows one current row per identity, its content_type and slug move to the new row because
-- documents_org_type_slug_ux is unique, and its legacy vectors are set to NULL so superseded rows stop occupying HNSW candidates. The old
-- documents and chunks keep their text, so a stored citation still resolves.
CREATE OR REPLACE FUNCTION rag_publish_document_version(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (outcome text, document_id uuid, version integer, superseded_document_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  doc documents%ROWTYPE;
  previous documents%ROWTYPE;
  has_slug boolean;
  moved_type text;
  moved_slug text;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status = 'quarantined' THEN
    RETURN QUERY SELECT 'quarantined'::text, doc.id, doc.version, NULL::uuid;
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
    SELECT count(*) = 2 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname IN ('content_type', 'slug') AND NOT attisdropped
  );

  SELECT * INTO previous FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = doc.source AND d.source_key = doc.source_key AND d.is_current AND d.id <> doc.id
  FOR UPDATE;
  IF FOUND THEN
    IF has_slug THEN
      EXECUTE 'SELECT content_type, slug FROM documents WHERE id = $1' INTO moved_type, moved_slug USING previous.id;
    END IF;
    UPDATE documents d SET is_current = false, superseded_by = doc.id WHERE d.id = previous.id;
    IF has_slug THEN
      EXECUTE 'UPDATE documents SET content_type = NULL, slug = NULL WHERE id = $1' USING previous.id;
    END IF;
    UPDATE document_chunks c SET is_current = false, embedding = NULL WHERE c.document_id = previous.id;
  END IF;

  UPDATE documents d SET is_current = true, status = 'ready' WHERE d.id = doc.id;
  IF previous.id IS NOT NULL AND has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
    EXECUTE 'UPDATE documents SET content_type = $2, slug = $3 WHERE id = $1' USING doc.id, moved_type, moved_slug;
  END IF;
  UPDATE document_chunks c SET is_current = true, status = 'ready' WHERE c.document_id = doc.id;

  RETURN QUERY SELECT 'published'::text, doc.id, doc.version, previous.id;
END
$$;

REVOKE ALL ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_publish_document_version(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_publish_document_version(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_find_content_duplicate(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_set_document_fields(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_save_ingest_state(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_get_ingest_document(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_mark_document_failed(uuid, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_find_content_duplicate(text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_set_document_fields(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_save_ingest_state(uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_get_ingest_document(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_mark_document_failed(uuid, text, text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0311_rag_originals_bucket.sql
-- 0311: the private rag-originals bucket (Phase 3, D-18 with F-2) and the origin of a document version for resume.
-- Bucket: holds each version's original and parse output at <tenant_key>/<lineage_id>/<version>/<fixed basename>. It is private, capped at
-- 20 MB like the upload limit, and gets no storage.objects policy: with row level security on and no policy, anon and authenticated reach
-- nothing, and only the service key (which bypasses it) reads or writes. Never add a policy for this bucket.
-- rag_get_ingest_origin: lineage_id, original_path, source and source_key of one document, so a resumed run finds its stored original
-- without the caller resending anything. It is a new function beside rag_get_ingest_document (whose result columns stay as 0310 made
-- them, so re-applying 0310 after this file keeps working). Same tenant check: another tenant's id, and an unknown id, return no row.
-- Idempotent: the bucket upsert resets a bucket that was made public or resized; CREATE OR REPLACE with a fixed signature, then REVOKE and GRANT.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('rag-originals', 'rag-originals', false, 20971520)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 20971520;

CREATE OR REPLACE FUNCTION rag_get_ingest_origin(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (
  lineage_id uuid,
  original_path text,
  source text,
  source_key text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.original_path, d.source, d.source_key
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$$;

REVOKE ALL ON FUNCTION rag_get_ingest_origin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_get_ingest_origin(uuid, text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0312_doc_type_defaults.sql
-- 0312: admin defaults for the document type (Phase 3, D-15).
-- One row per (tenant_key, source_kind, source_ref): the tenant-wide default, a default per source, and for Nango a default per
-- connection or per folder. doc_type is one of the six types or 'auto' (run auto-detection). The table is for the server role only:
-- RLS is on without policies and nothing is granted to anon or authenticated. It is read and written only through the three
-- functions below, which are SECURITY DEFINER, executable by service_role only, and always filtered by the tenant_key they are given.
-- Whoever may change a default is decided by the caller (the admin guard of the route); the database refuses everyone but the server role.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS rag_doc_type_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL CONSTRAINT rag_doc_type_defaults_kind_check CHECK (source_kind IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload')),
  source_ref text,
  doc_type text NOT NULL CONSTRAINT rag_doc_type_defaults_type_check CHECK (doc_type IN ('auto', 'general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image')),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_doc_type_defaults_ref_check CHECK (source_ref IS NULL OR (source_kind = 'nango' AND btrim(source_ref) <> '' AND length(source_ref) <= 200))
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_doc_type_defaults_scope_ux ON rag_doc_type_defaults (tenant_key, source_kind, (COALESCE(source_ref, '')));

ALTER TABLE rag_doc_type_defaults ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rag_doc_type_defaults FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE rag_doc_type_defaults TO service_role;

-- A tenant key is s:default in the single-tenant schema and u:<uuid> or o:<uuid> (lower case) in the multi-tenant one. Internal helper
-- of the three functions below; nobody else may call it.
CREATE OR REPLACE FUNCTION rag_doc_type_tenant_key_ok(p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL THEN
    RETURN false;
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    RETURN p_tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  END IF;
  RETURN p_tenant_key = 's:default';
END
$$;

-- The rows of one tenant. With p_source NULL: every row of the tenant (the admin list). With a source: the tenant default, the default of
-- that source, and for 'nango' the connection and folder rows whose ref equals p_connection_id or p_folder_id. Never another tenant's row.
CREATE OR REPLACE FUNCTION rag_get_doc_type_defaults(
  p_tenant_key text,
  p_source text,
  p_connection_id text,
  p_folder_id text
)
RETURNS TABLE (tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  RETURN QUERY
  SELECT d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at
  FROM rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key
    AND (
      p_source IS NULL
      OR d.source_kind = 'tenant'
      OR (d.source_kind = p_source AND (
        d.source_ref IS NULL
        OR (p_source = 'nango' AND d.source_ref IS NOT NULL AND (d.source_ref = p_connection_id OR d.source_ref = p_folder_id))
      ))
    )
  ORDER BY d.source_kind, d.source_ref NULLS FIRST;
END
$$;

-- Creates or replaces one default. updated_by is the actor (required), updated_at is set here.
CREATE OR REPLACE FUNCTION rag_set_doc_type_default(
  p_tenant_key text,
  p_source_kind text,
  p_source_ref text,
  p_doc_type text,
  p_updated_by text
)
RETURNS TABLE (tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  ref text := p_source_ref;
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('auto', 'general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image') THEN
    RAISE EXCEPTION 'invalid_doc_type';
  END IF;
  IF p_updated_by IS NULL OR btrim(p_updated_by) = '' THEN
    RAISE EXCEPTION 'actor_required';
  END IF;
  IF ref IS NOT NULL THEN
    ref := btrim(ref);
    IF p_source_kind <> 'nango' OR ref = '' OR length(ref) > 200 THEN
      RAISE EXCEPTION 'invalid_argument: source_ref is only for nango connection or folder ids';
    END IF;
  END IF;

  RETURN QUERY
  INSERT INTO rag_doc_type_defaults AS d (tenant_key, source_kind, source_ref, doc_type, updated_by, updated_at)
  VALUES (p_tenant_key, p_source_kind, ref, p_doc_type, btrim(p_updated_by), now())
  ON CONFLICT (tenant_key, source_kind, (COALESCE(source_ref, '')))
  DO UPDATE SET doc_type = EXCLUDED.doc_type, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
  RETURNING d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at;
END
$$;

-- Removes one default of the tenant; false when there was none.
CREATE OR REPLACE FUNCTION rag_delete_doc_type_default(
  p_tenant_key text,
  p_source_kind text,
  p_source_ref text
)
RETURNS TABLE (deleted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  removed integer;
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  DELETE FROM rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key AND d.source_kind = p_source_kind AND COALESCE(d.source_ref, '') = COALESCE(btrim(p_source_ref), '');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN QUERY SELECT removed > 0;
END
$$;

REVOKE ALL ON FUNCTION rag_doc_type_tenant_key_ok(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_get_doc_type_defaults(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_set_doc_type_default(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_delete_doc_type_default(text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_get_doc_type_defaults(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_set_doc_type_default(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_delete_doc_type_default(text, text, text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0313_write_chunks_profiles.sql
-- 0313: the ingest writer stores vectors for every embedding profile and records the ones that could not be written (Phase 3, D-35, D-39, F-9).
-- rag_write_chunks keeps its signature. p_embeddings is an object keyed by profile id; each value is the list of vectors that lines up with
-- p_chunks (a null entry means no vector for that chunk), or an object {"vectors": [...], "host": "<serving host>"}. The legacy profile still
-- fills document_chunks.embedding; every other profile of the registry upserts one chunk_embeddings row per chunk with the profile's model and
-- dims, the document's tenant_key and the host from the payload. A vector whose length differs from the profile's dims raises
-- embedding_profile_mismatch; an id that is not in the registry raises embedding_profile_unsupported. A rewrite that changes a chunk's text
-- drops that chunk's old vectors of the profiles that are not sent again, and a vector written for a chunk clears its recorded gap.
-- rag_publish_document_version also deletes the superseded version's chunk_embeddings rows (F-9); the chunk rows stay for citations.
-- rag_record_backfill_gap records chunks whose vector for a backfilling profile could not be written, against the run that will fill them;
-- rag_latest_backfill_runs names that run per profile. Both check the tenant. Server role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION rag_write_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_chunks jsonb,
  p_embeddings jsonb,
  p_final boolean,
  p_total integer
)
RETURNS TABLE (chunks_written integer, chunks_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc documents%ROWTYPE;
  profile_key text;
  profile_row embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  chunk_count integer;
  legacy_vectors jsonb;
  written integer := 0;
  deleted integer := 0;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_chunks must be a JSON array';
  END IF;
  chunk_count := jsonb_array_length(p_chunks);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every chunk needs a string content and a numeric chunk_index when it has one';
  END IF;
  IF (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)) <> chunk_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct';
  END IF;
  IF p_final AND (p_total IS NULL OR p_total < 0) THEN
    RAISE EXCEPTION 'invalid_total: p_total is required with p_final';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF vectors IS NULL OR jsonb_typeof(vectors) <> 'array' OR jsonb_array_length(vectors) <> chunk_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE jsonb_typeof(v.value) = 'array' AND jsonb_array_length(v.value) <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  -- A chunk whose text changed must not keep a vector made from the old text.
  DELETE FROM chunk_embeddings ce
  USING document_chunks c, jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      (e.ord - 1)::integer AS position,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS written = ROW_COUNT;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM embedding_backfill_gaps g
      USING jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    DELETE FROM document_chunks c WHERE c.document_id = p_document_id AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

-- The version swap (D-11), one transaction, as in 0310; additionally the superseded version's rows in chunk_embeddings go (F-9) together with
-- the gaps recorded for its chunks, so superseded rows stop occupying the profile indexes. The old documents and chunks keep their text.
CREATE OR REPLACE FUNCTION rag_publish_document_version(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (outcome text, document_id uuid, version integer, superseded_document_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  doc documents%ROWTYPE;
  previous documents%ROWTYPE;
  has_slug boolean;
  moved_type text;
  moved_slug text;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status = 'quarantined' THEN
    RETURN QUERY SELECT 'quarantined'::text, doc.id, doc.version, NULL::uuid;
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
    SELECT count(*) = 2 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname IN ('content_type', 'slug') AND NOT attisdropped
  );

  SELECT * INTO previous FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = doc.source AND d.source_key = doc.source_key AND d.is_current AND d.id <> doc.id
  FOR UPDATE;
  IF FOUND THEN
    IF has_slug THEN
      EXECUTE 'SELECT content_type, slug FROM documents WHERE id = $1' INTO moved_type, moved_slug USING previous.id;
    END IF;
    UPDATE documents d SET is_current = false, superseded_by = doc.id WHERE d.id = previous.id;
    IF has_slug THEN
      EXECUTE 'UPDATE documents SET content_type = NULL, slug = NULL WHERE id = $1' USING previous.id;
    END IF;
    UPDATE document_chunks c SET is_current = false, embedding = NULL WHERE c.document_id = previous.id;
    DELETE FROM chunk_embeddings ce USING document_chunks c WHERE ce.chunk_id = c.id AND c.document_id = previous.id;
    DELETE FROM embedding_backfill_gaps g USING document_chunks c WHERE g.chunk_id = c.id AND c.document_id = previous.id;
  END IF;

  UPDATE documents d SET is_current = true, status = 'ready' WHERE d.id = doc.id;
  IF previous.id IS NOT NULL AND has_slug AND (moved_type IS NOT NULL OR moved_slug IS NOT NULL) THEN
    EXECUTE 'UPDATE documents SET content_type = $2, slug = $3 WHERE id = $1' USING doc.id, moved_type, moved_slug;
  END IF;
  UPDATE document_chunks c SET is_current = true, status = 'ready' WHERE c.document_id = doc.id;

  RETURN QUERY SELECT 'published'::text, doc.id, doc.version, previous.id;
END
$$;

-- Records chunks that have no vector for p_profile_id because its provider failed or answered with the wrong model or dimensions. Every chunk
-- must belong to p_tenant_key (an unknown id is indistinguishable from another tenant's), the run must be a run of the profile, and a run
-- limited to one tenant takes gaps of that tenant only. A repeated call updates the reason and the time.
CREATE OR REPLACE FUNCTION rag_record_backfill_gap(
  p_run_id uuid,
  p_chunk_ids uuid[],
  p_profile_id text,
  p_reason text,
  p_tenant_key text
)
RETURNS TABLE (gaps_recorded integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  run embedding_backfill_runs%ROWTYPE;
  wanted integer;
  matched integer;
  recorded integer;
BEGIN
  IF p_run_id IS NULL OR p_profile_id IS NULL OR p_tenant_key IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_run_id, p_profile_id and p_tenant_key are required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid_gap: a reason is required';
  END IF;
  IF p_chunk_ids IS NULL OR cardinality(p_chunk_ids) = 0 THEN
    RAISE EXCEPTION 'invalid_gap: chunk ids are required';
  END IF;

  SELECT * INTO run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found';
  END IF;
  IF run.profile_id <> p_profile_id THEN
    RAISE EXCEPTION 'run_profile_mismatch' USING DETAIL = 'the run belongs to another profile';
  END IF;
  IF run.tenant_key IS NOT NULL AND run.tenant_key <> p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'the run is limited to another tenant';
  END IF;

  SELECT count(DISTINCT u.id) INTO wanted FROM unnest(p_chunk_ids) AS u(id);
  SELECT count(*) INTO matched FROM document_chunks c
  WHERE c.id IN (SELECT u.id FROM unnest(p_chunk_ids) AS u(id)) AND c.tenant_key = p_tenant_key;
  IF matched <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in tenant';
  END IF;

  INSERT INTO embedding_backfill_gaps AS g (run_id, chunk_id, profile_id, reason)
  SELECT DISTINCT p_run_id, u.id, p_profile_id, left(btrim(p_reason), 200) FROM unnest(p_chunk_ids) AS u(id)
  ON CONFLICT (run_id, chunk_id, profile_id) DO UPDATE SET reason = EXCLUDED.reason, recorded_at = now();
  GET DIAGNOSTICS recorded = ROW_COUNT;

  RETURN QUERY SELECT recorded;
END
$$;

-- The run a gap of each profile is recorded against: per profile the newest run that applies to p_tenant_key (an unlimited run or one limited
-- to that tenant), a running one first.
CREATE OR REPLACE FUNCTION rag_latest_backfill_runs(p_tenant_key text)
RETURNS TABLE (profile_id text, run_id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT ON (r.profile_id) r.profile_id, r.id, r.status
  FROM embedding_backfill_runs r
  WHERE r.tenant_key IS NULL OR r.tenant_key = p_tenant_key
  ORDER BY r.profile_id, (r.status = 'running') DESC, r.started_at DESC, r.id
$$;

REVOKE ALL ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_publish_document_version(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_record_backfill_gap(uuid, uuid[], text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_latest_backfill_runs(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_publish_document_version(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_record_backfill_gap(uuid, uuid[], text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_latest_backfill_runs(text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0314_invoice_columns.sql
-- 0314: promoted invoice columns, their per-tenant indexes, and the two read functions (Phase 3, D-27, D-28).
-- documents gains invoice_number, supplier_name, supplier_tax_id, issue_date, gross_total and currency. The full extraction result stays in
-- metadata.invoice. rag_set_document_fields accepts the six keys (validated, an explicit null clears). rag_find_invoices filters the current,
-- ready invoices of one tenant by supplier, date, amount and currency. rag_exact_id_documents returns the current, ready chunks of one tenant
-- matched by invoice number, supplier tax id, or a whole-word token in the chunk's lexical text. Both read functions are SECURITY DEFINER,
-- executable by service_role only, and always filtered by the tenant key they are given.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS invoice_number text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS supplier_name text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS supplier_tax_id text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS issue_date date;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS gross_total numeric(20, 4);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS currency text;

CREATE INDEX IF NOT EXISTS documents_tenant_invoice_number_idx ON documents USING btree (tenant_key, invoice_number);
CREATE INDEX IF NOT EXISTS documents_tenant_supplier_tax_id_idx ON documents USING btree (tenant_key, supplier_tax_id);
CREATE INDEX IF NOT EXISTS documents_tenant_issue_date_idx ON documents USING btree (tenant_key, issue_date);
CREATE INDEX IF NOT EXISTS documents_tenant_gross_total_idx ON documents USING btree (tenant_key, gross_total);

-- The 0310 function with the six invoice keys added. A key that is present sets its column (an explicit null clears it); a key that is
-- absent leaves it alone; metadata is merged. Invoice values are checked here so a bad value raises invalid_field and never echoes content.
CREATE OR REPLACE FUNCTION rag_set_document_fields(
  p_document_id uuid,
  p_tenant_key text,
  p_fields jsonb
)
RETURNS TABLE (document_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  field_name text;
  allowed text[] := ARRAY[
    'content_hash', 'language', 'doc_date', 'doc_type', 'doc_type_origin', 'parser_used', 'parser_version',
    'processing_profile_id', 'processing_profile_version', 'original_path', 'source_provider', 'source_file_id',
    'source_connection_id', 'status', 'metadata',
    'invoice_number', 'supplier_name', 'supplier_tax_id', 'issue_date', 'gross_total', 'currency'
  ];
  doc documents%ROWTYPE;
  issue date;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_fields: p_fields must be a JSON object';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (field_name = ANY (allowed)) THEN
      RAISE EXCEPTION 'invalid_field: %', field_name;
    END IF;
  END LOOP;
  IF p_fields ? 'status' AND (jsonb_typeof(p_fields -> 'status') <> 'string'
      OR (p_fields ->> 'status') NOT IN ('processing', 'quarantined', 'failed', 'deleted')) THEN
    RAISE EXCEPTION 'invalid_status: %', p_fields ->> 'status';
  END IF;
  IF p_fields ? 'metadata' AND jsonb_typeof(p_fields -> 'metadata') <> 'object' THEN
    RAISE EXCEPTION 'invalid_metadata: metadata must be a JSON object';
  END IF;

  IF p_fields ? 'invoice_number' AND jsonb_typeof(p_fields -> 'invoice_number') <> 'null'
      AND (jsonb_typeof(p_fields -> 'invoice_number') <> 'string' OR length(p_fields ->> 'invoice_number') > 64) THEN
    RAISE EXCEPTION 'invalid_field: invoice_number';
  END IF;
  IF p_fields ? 'supplier_name' AND jsonb_typeof(p_fields -> 'supplier_name') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_name') <> 'string' OR length(p_fields ->> 'supplier_name') > 300) THEN
    RAISE EXCEPTION 'invalid_field: supplier_name';
  END IF;
  IF p_fields ? 'supplier_tax_id' AND jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'string' OR length(p_fields ->> 'supplier_tax_id') > 64) THEN
    RAISE EXCEPTION 'invalid_field: supplier_tax_id';
  END IF;
  IF p_fields ? 'currency' AND jsonb_typeof(p_fields -> 'currency') <> 'null'
      AND (jsonb_typeof(p_fields -> 'currency') <> 'string' OR (p_fields ->> 'currency') !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'invalid_field: currency';
  END IF;
  IF p_fields ? 'gross_total' AND jsonb_typeof(p_fields -> 'gross_total') <> 'null'
      AND (jsonb_typeof(p_fields -> 'gross_total') <> 'string' OR (p_fields ->> 'gross_total') !~ '^-?[0-9]{1,16}(\.[0-9]{1,4})?$') THEN
    RAISE EXCEPTION 'invalid_field: gross_total';
  END IF;
  IF p_fields ? 'issue_date' AND jsonb_typeof(p_fields -> 'issue_date') <> 'null' THEN
    IF jsonb_typeof(p_fields -> 'issue_date') <> 'string' OR (p_fields ->> 'issue_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END IF;
    BEGIN
      issue := (p_fields ->> 'issue_date')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END;
  END IF;

  UPDATE documents d SET
    content_hash = CASE WHEN p_fields ? 'content_hash' THEN p_fields ->> 'content_hash' ELSE d.content_hash END,
    language = CASE WHEN p_fields ? 'language' THEN p_fields ->> 'language' ELSE d.language END,
    doc_date = CASE WHEN p_fields ? 'doc_date' THEN (p_fields ->> 'doc_date')::date ELSE d.doc_date END,
    doc_type = CASE WHEN p_fields ? 'doc_type' THEN p_fields ->> 'doc_type' ELSE d.doc_type END,
    doc_type_origin = CASE WHEN p_fields ? 'doc_type_origin' THEN p_fields ->> 'doc_type_origin' ELSE d.doc_type_origin END,
    parser_used = CASE WHEN p_fields ? 'parser_used' THEN p_fields ->> 'parser_used' ELSE d.parser_used END,
    parser_version = CASE WHEN p_fields ? 'parser_version' THEN p_fields ->> 'parser_version' ELSE d.parser_version END,
    processing_profile_id = CASE WHEN p_fields ? 'processing_profile_id' THEN p_fields ->> 'processing_profile_id' ELSE d.processing_profile_id END,
    processing_profile_version = CASE WHEN p_fields ? 'processing_profile_version' THEN (p_fields ->> 'processing_profile_version')::integer ELSE d.processing_profile_version END,
    original_path = CASE WHEN p_fields ? 'original_path' THEN p_fields ->> 'original_path' ELSE d.original_path END,
    source_provider = CASE WHEN p_fields ? 'source_provider' THEN p_fields ->> 'source_provider' ELSE d.source_provider END,
    source_file_id = CASE WHEN p_fields ? 'source_file_id' THEN p_fields ->> 'source_file_id' ELSE d.source_file_id END,
    source_connection_id = CASE WHEN p_fields ? 'source_connection_id' THEN p_fields ->> 'source_connection_id' ELSE d.source_connection_id END,
    status = CASE WHEN p_fields ? 'status' THEN p_fields ->> 'status' ELSE d.status END,
    metadata = CASE WHEN p_fields ? 'metadata' THEN COALESCE(d.metadata, '{}'::jsonb) || (p_fields -> 'metadata') ELSE d.metadata END,
    invoice_number = CASE WHEN p_fields ? 'invoice_number' THEN p_fields ->> 'invoice_number' ELSE d.invoice_number END,
    supplier_name = CASE WHEN p_fields ? 'supplier_name' THEN p_fields ->> 'supplier_name' ELSE d.supplier_name END,
    supplier_tax_id = CASE WHEN p_fields ? 'supplier_tax_id' THEN p_fields ->> 'supplier_tax_id' ELSE d.supplier_tax_id END,
    issue_date = CASE WHEN p_fields ? 'issue_date' THEN (p_fields ->> 'issue_date')::date ELSE d.issue_date END,
    gross_total = CASE WHEN p_fields ? 'gross_total' THEN (p_fields ->> 'gross_total')::numeric(20, 4) ELSE d.gross_total END,
    currency = CASE WHEN p_fields ? 'currency' THEN p_fields ->> 'currency' ELSE d.currency END
  WHERE d.id = p_document_id;

  IF p_fields ?| ARRAY['doc_type', 'doc_date', 'language', 'parser_used', 'status'] THEN
    UPDATE document_chunks c SET
      doc_type = d.doc_type,
      doc_date = d.doc_date,
      language = d.language,
      parser_used = d.parser_used,
      status = d.status,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('doc_type', d.doc_type, 'language', d.language, 'parser_used', d.parser_used)
    FROM documents d
    WHERE d.id = p_document_id AND c.document_id = d.id;
  END IF;

  RETURN QUERY SELECT d.id, d.status FROM documents d WHERE d.id = p_document_id;
END
$$;

-- Current, ready invoices of one tenant. p_supplier matches the supplier name (case-insensitive, as text: no pattern characters) or the
-- supplier tax id exactly (case-insensitive). The other filters are inclusive ranges; amounts compare as numbers. A NULL argument is no filter.
CREATE OR REPLACE FUNCTION rag_find_invoices(
  p_tenant_key text,
  p_supplier text,
  p_date_from date,
  p_date_to date,
  p_amount_min numeric,
  p_amount_max numeric,
  p_currency text,
  p_limit integer
)
RETURNS TABLE (
  document_id uuid,
  filename text,
  invoice_number text,
  supplier_name text,
  supplier_tax_id text,
  issue_date date,
  gross_total text,
  currency text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  needle text := lower(btrim(COALESCE(p_supplier, '')));
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  RETURN QUERY
  SELECT d.id, d.filename, d.invoice_number, d.supplier_name, d.supplier_tax_id, d.issue_date, d.gross_total::text, d.currency
  FROM documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type = 'invoice_receipt'
    AND (needle = '' OR position(needle IN lower(COALESCE(d.supplier_name, ''))) > 0 OR lower(COALESCE(d.supplier_tax_id, '')) = needle)
    AND (p_date_from IS NULL OR d.issue_date >= p_date_from)
    AND (p_date_to IS NULL OR d.issue_date <= p_date_to)
    AND (p_amount_min IS NULL OR d.gross_total >= p_amount_min)
    AND (p_amount_max IS NULL OR d.gross_total <= p_amount_max)
    AND (p_currency IS NULL OR d.currency = p_currency)
  ORDER BY d.issue_date DESC NULLS LAST, d.created_at DESC, d.id
  LIMIT cap;
END
$$;

-- Current, ready chunks of one tenant matched by an exact identifier. matched_field is invoice_number or supplier_tax_id for the
-- invoice_header and table chunks of a document whose column equals a token (case-insensitive), and lexical_text for a chunk whose
-- lexical text holds a token as a whole word (hyphens belong to the word). A chunk matched both ways is returned once, as a column match.
CREATE OR REPLACE FUNCTION rag_exact_id_documents(
  p_tenant_key text,
  p_tokens text[],
  p_limit integer
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  matched_field text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  tokens text[];
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  IF NOT rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[]) INTO tokens
  FROM (
    SELECT lower(btrim(raw)) AS t FROM unnest(COALESCE(p_tokens, ARRAY[]::text[])) WITH ORDINALITY AS u(raw, n)
    WHERE n <= 20 AND length(btrim(raw)) BETWEEN 2 AND 100
  ) cleaned;
  IF cardinality(tokens) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT hit.id, hit.document_id, hit.content, hit.metadata, hit.matched_field
  FROM (
    SELECT DISTINCT ON (m.id) m.id, m.document_id, m.content, m.metadata, m.matched_field, m.created_at, m.chunk_index
    FROM (
      SELECT c.id, c.document_id, c.content, c.metadata,
             CASE WHEN lower(d.invoice_number) = ANY (tokens) THEN 'invoice_number' ELSE 'supplier_tax_id' END AS matched_field,
             1 AS priority, c.created_at, c.chunk_index
      FROM documents d
      JOIN document_chunks c ON c.document_id = d.id
      WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
        AND c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready'
        AND c.chunk_kind IN ('invoice_header', 'table')
        AND (lower(d.invoice_number) = ANY (tokens) OR lower(d.supplier_tax_id) = ANY (tokens))
      UNION ALL
      SELECT c.id, c.document_id, c.content, c.metadata, 'lexical_text'::text, 2, c.created_at, c.chunk_index
      FROM document_chunks c
      WHERE c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready'
        AND c.lexical_text IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(tokens) AS k(token)
          WHERE lower(c.lexical_text) ~ ('(^|[^[:alnum:]_-])' || regexp_replace(k.token, '([][\\.^$|?*+(){}-])', '\\\1', 'g') || '($|[^[:alnum:]_-])')
        )
    ) m
    ORDER BY m.id, m.priority
  ) hit
  ORDER BY (hit.matched_field = 'lexical_text'), hit.created_at, hit.chunk_index, hit.id
  LIMIT cap;
END
$$;

REVOKE ALL ON FUNCTION rag_set_document_fields(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_find_invoices(text, text, date, date, numeric, numeric, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_exact_id_documents(text, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_set_document_fields(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_find_invoices(text, text, date, date, numeric, numeric, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_exact_id_documents(text, text[], integer) TO service_role;

COMMIT;

-- >>> supabase/migrations/0315_reembed_functions.sql
-- 0315: SQL side of the re-embed job (Phase 3, D-38, EMB-04).
-- The job fills one embedding profile from stored chunk text. Every function is bound to a run row: the run names the profile and, when it
-- is limited to one tenant, the tenant, and no function takes either from the caller again, so a run limited to tenant A cannot read,
-- derive or write anything of tenant B. rag_reembed_write_batch upserts the vectors and moves the run's cursor and counts in one
-- transaction, which is what lets a run killed between batches resume without a duplicate or a gap. A chunk that already has a vector of
-- the profile (same model and dims) is not picked again, so a resumed run, the sweep and dual-written chunks never cost a second embedding.
-- rag_reembed_pick is the one shared selection (internal, not granted). Server role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION rag_reembed_pick(
  p_profile_id text,
  p_tenant_key text,
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb,
  has_gap boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.document_id, c.tenant_key, c.content, c.section_path, c.chunk_kind,
         COALESCE(c.doc_type, d.doc_type),
         jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency),
         EXISTS (SELECT 1 FROM embedding_backfill_gaps g WHERE g.chunk_id = c.id AND g.profile_id = p.id)
  FROM embedding_profiles p
  JOIN document_chunks c ON c.is_current AND c.status = 'ready'
  JOIN documents d ON d.id = c.document_id
  WHERE p.id = p_profile_id
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    AND (p_after IS NULL OR c.id > p_after)
    AND NOT EXISTS (
      SELECT 1 FROM chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims)
  ORDER BY c.id
  LIMIT p_limit
$$;

-- Starts a run. The profile moves to backfilling, which is what makes ingestion dual-write it (0313). Refused for the active profile, the
-- legacy-column profile, a retired or unknown profile, a tenant key that is not one of the three shapes, and while a running run of the
-- same profile overlaps the tenant scope. p_derived_from names a profile of the same provider and model with more dimensions whose stored
-- vectors the run truncates and normalises (rag_reembed_derive_batch).
CREATE OR REPLACE FUNCTION rag_reembed_start_run(
  p_profile_id text,
  p_tenant_key text,
  p_actor text,
  p_derived_from text DEFAULT NULL
)
RETURNS TABLE (run_id uuid, profile_id text, tenant_key text, chunks_total bigint, derived_from text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_profile embedding_profiles%ROWTYPE;
  v_source embedding_profiles%ROWTYPE;
  v_total bigint;
  v_run uuid;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_profile FROM embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF v_profile.status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF p_derived_from IS NOT NULL THEN
    SELECT * INTO v_source FROM embedding_profiles p WHERE p.id = p_derived_from;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reembed_refused: unknown_derive_source' USING ERRCODE = '22023';
    END IF;
    IF v_source.id = v_profile.id OR v_source.storage <> 'halfvec' THEN
      RAISE EXCEPTION 'reembed_refused: derive_source_invalid' USING ERRCODE = '22023';
    END IF;
    IF v_source.provider <> v_profile.provider OR v_source.model <> v_profile.model THEN
      RAISE EXCEPTION 'reembed_refused: derive_model_mismatch' USING ERRCODE = '22023';
    END IF;
    IF v_source.dims <= v_profile.dims THEN
      RAISE EXCEPTION 'reembed_refused: derive_dims_not_smaller' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM embedding_backfill_runs r
    WHERE r.profile_id = p_profile_id AND r.status = 'running'
      AND (r.tenant_key IS NULL OR p_tenant_key IS NULL OR r.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_total FROM document_chunks c
  WHERE c.is_current AND c.status = 'ready' AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key);

  UPDATE embedding_profiles SET status = 'backfilling' WHERE id = p_profile_id AND status = 'available';

  INSERT INTO embedding_backfill_runs AS r (profile_id, tenant_key, chunks_total, derived_from)
  VALUES (p_profile_id, p_tenant_key, v_total, p_derived_from)
  RETURNING r.id INTO v_run;

  RETURN QUERY SELECT v_run, p_profile_id, p_tenant_key, v_total, p_derived_from;
END
$$;

CREATE OR REPLACE FUNCTION rag_reembed_get_run(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  tenant_key text,
  cursor_chunk_id uuid,
  chunks_total bigint,
  chunks_done bigint,
  tokens bigint,
  status text,
  derived_from text,
  provider text,
  model text,
  dims integer,
  storage text,
  profile_status text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.profile_id, r.tenant_key, r.cursor_chunk_id, r.chunks_total, r.chunks_done, r.tokens, r.status, r.derived_from,
         p.provider, p.model, p.dims, p.storage, p.status, r.updated_at
  FROM embedding_backfill_runs r
  JOIN embedding_profiles p ON p.id = r.profile_id
  WHERE r.id = p_run_id
$$;

-- Puts a running or failed run back to running so a killed or failed run continues from its cursor. A completed or rolled-back run is not
-- resumed (start a new run; it only picks what is still missing). A profile that fell back to available returns to backfilling.
CREATE OR REPLACE FUNCTION rag_reembed_resume_run(p_run_id uuid, p_actor text)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  tenant_key text,
  cursor_chunk_id uuid,
  chunks_total bigint,
  chunks_done bigint,
  tokens bigint,
  status text,
  derived_from text,
  provider text,
  model text,
  dims integer,
  storage text,
  profile_status text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'completed' THEN
    RAISE EXCEPTION 'reembed_refused: run_completed' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'reembed_refused: run_rolled_back' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO v_status FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM embedding_backfill_runs o
    WHERE o.id <> v_run.id AND o.profile_id = v_run.profile_id AND o.status = 'running'
      AND (o.tenant_key IS NULL OR v_run.tenant_key IS NULL OR o.tenant_key = v_run.tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  UPDATE embedding_profiles SET status = 'backfilling' WHERE id = v_run.profile_id AND status = 'available';
  UPDATE embedding_backfill_runs SET status = 'running', updated_at = now() WHERE id = v_run.id;
  RETURN QUERY SELECT * FROM rag_reembed_get_run(p_run_id);
END
$$;

-- The keyset pass: current, ready chunks of the run's scope after the cursor, in id order, that have no vector of the profile yet.
CREATE OR REPLACE FUNCTION rag_reembed_next_batch(p_run_id uuid, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit) x;
END
$$;

-- The sweep after the keyset pass: the chunks that still lack a vector of the profile, which are the ones written behind the cursor while
-- the pass ran and the chunks whose dual-write failed (has_gap says which have a recorded gap).
CREATE OR REPLACE FUNCTION rag_reembed_missing_batch(p_run_id uuid, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 128)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb,
  has_gap boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT * FROM rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit);
END
$$;

-- One transaction: upsert the vectors, resolve the recorded gaps of those chunks and move the run's cursor, counts and token total.
-- p_rows is [{chunk_id, vector, host}]. The cursor only moves forward and a null cursor leaves it alone (the sweep passes null). Every chunk
-- must be inside the run's tenant scope and be current and ready, every vector must have the profile's length, and a chunk may appear once.
-- Any refusal rolls back the whole call, so nothing of a refused batch is written and the cursor stays where it was.
CREATE OR REPLACE FUNCTION rag_reembed_write_batch(p_run_id uuid, p_rows jsonb, p_cursor uuid, p_tokens bigint DEFAULT 0)
RETURNS TABLE (chunks_written integer, chunks_done bigint, cursor_chunk_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_profile embedding_profiles%ROWTYPE;
  v_ids uuid[];
  wanted integer;
  in_scope integer;
  current_count integer;
  written integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.storage <> 'halfvec' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_rows: p_rows must be a non-empty JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value)
    WHERE jsonb_typeof(r.value) <> 'object'
       OR jsonb_typeof(r.value -> 'chunk_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(r.value -> 'vector') IS DISTINCT FROM 'array'
       OR (r.value ? 'host' AND jsonb_typeof(r.value -> 'host') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_rows: every row needs a chunk_id string, a vector array and an optional host string' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg((r.value ->> 'chunk_id')::uuid) INTO v_ids FROM jsonb_array_elements(p_rows) AS r(value);
  wanted := cardinality(v_ids);
  IF (SELECT count(DISTINCT u.id) FROM unnest(v_ids) AS u(id)) <> wanted THEN
    RAISE EXCEPTION 'invalid_rows: a chunk may appear once per batch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value) WHERE jsonb_array_length(r.value -> 'vector') <> v_profile.dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  SELECT count(*) INTO in_scope FROM document_chunks c
  WHERE c.id = ANY (v_ids) AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key);
  IF in_scope <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in the run scope';
  END IF;
  SELECT count(*) INTO current_count FROM document_chunks c WHERE c.id = ANY (v_ids) AND c.is_current AND c.status = 'ready';
  IF current_count <> wanted THEN
    RAISE EXCEPTION 'reembed_refused: chunk_not_current' USING ERRCODE = '55000';
  END IF;

  INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
  SELECT (r.value ->> 'chunk_id')::uuid, v_profile.id, c.tenant_key, ((r.value -> 'vector')::text)::halfvec, v_profile.model, v_profile.dims,
         left(r.value ->> 'host', 120)
  FROM jsonb_array_elements(p_rows) AS r(value)
  JOIN document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
  ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model,
    dims = EXCLUDED.dims,
    embedding_host = EXCLUDED.embedding_host,
    embedded_at = now();
  GET DIAGNOSTICS written = ROW_COUNT;

  DELETE FROM embedding_backfill_gaps g WHERE g.profile_id = v_profile.id AND g.chunk_id = ANY (v_ids);

  UPDATE embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + written,
    tokens = r.tokens + GREATEST(COALESCE(p_tokens, 0), 0),
    cursor_chunk_id = CASE WHEN p_cursor IS NOT NULL AND (r.cursor_chunk_id IS NULL OR p_cursor > r.cursor_chunk_id) THEN p_cursor ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT written, v_done, v_cursor;
END
$$;

-- --derive-from: fills the run's profile from the stored vectors of the profile it derives from, as l2_normalize(subvector(source, 1, dims)),
-- for chunks of the run's scope that lack the target. No provider is involved. Chunks with no source vector stay missing.
CREATE OR REPLACE FUNCTION rag_reembed_derive_batch(p_run_id uuid, p_limit integer)
RETURNS TABLE (chunks_derived integer, chunks_done bigint, cursor_chunk_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_target embedding_profiles%ROWTYPE;
  v_source embedding_profiles%ROWTYPE;
  v_ids uuid[];
  v_last uuid;
  derived integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF v_run.derived_from IS NULL THEN
    RAISE EXCEPTION 'reembed_refused: not_a_derive_run' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  SELECT * INTO v_source FROM embedding_profiles p WHERE p.id = v_run.derived_from;

  WITH picked AS (
    SELECT c.id, c.tenant_key, s.embedding AS source_vector
    FROM document_chunks c
    JOIN chunk_embeddings s
      ON s.chunk_id = c.id AND s.profile_id = v_source.id AND s.embedding_model = v_source.model AND s.dims = v_source.dims
    WHERE c.is_current AND c.status = 'ready'
      AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
      AND NOT EXISTS (
        SELECT 1 FROM chunk_embeddings t
        WHERE t.chunk_id = c.id AND t.profile_id = v_target.id AND t.embedding_model = v_target.model AND t.dims = v_target.dims)
    ORDER BY c.id
    LIMIT p_limit
  ), written AS (
    INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT p.id, v_target.id, p.tenant_key, l2_normalize(subvector(p.source_vector, 1, v_target.dims)), v_target.model, v_target.dims, 'derived'
    FROM picked p
    ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      embedding_host = EXCLUDED.embedding_host,
      embedded_at = now()
    RETURNING ce.chunk_id
  )
  SELECT count(*)::integer, array_agg(w.chunk_id) INTO derived, v_ids FROM written w;

  IF derived > 0 THEN
    DELETE FROM embedding_backfill_gaps g WHERE g.profile_id = v_target.id AND g.chunk_id = ANY (v_ids);
    SELECT u.id INTO v_last FROM unnest(v_ids) AS u(id) ORDER BY u.id DESC LIMIT 1;
  END IF;

  UPDATE embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + derived,
    cursor_chunk_id = CASE
      WHEN v_last IS NOT NULL AND (r.cursor_chunk_id IS NULL OR v_last > r.cursor_chunk_id) THEN v_last
      ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT derived, v_done, v_cursor;
END
$$;

-- How many current, ready chunks of the run's scope still lack a vector of the profile.
CREATE OR REPLACE FUNCTION rag_reembed_remaining(p_run_id uuid)
RETURNS TABLE (chunks_missing bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_count bigint;
BEGIN
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count
  FROM embedding_profiles p
  JOIN document_chunks c ON c.is_current AND c.status = 'ready'
  WHERE p.id = v_run.profile_id
    AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims);
  RETURN QUERY SELECT v_count;
END
$$;

-- The dry-run totals per tenant: current ready chunks, how many still lack a vector of the profile, and the characters of those chunks.
CREATE OR REPLACE FUNCTION rag_reembed_count(p_profile_id text, p_tenant_key text)
RETURNS TABLE (tenant_key text, chunks bigint, chunks_missing bigint, content_chars bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM embedding_profiles p WHERE p.id = p_profile_id) THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.tenant_key,
           count(*)::bigint,
           (count(*) FILTER (WHERE e.chunk_id IS NULL))::bigint,
           COALESCE(sum(length(c.content)) FILTER (WHERE e.chunk_id IS NULL), 0)::bigint
    FROM embedding_profiles p
    JOIN document_chunks c ON c.is_current AND c.status = 'ready'
    LEFT JOIN chunk_embeddings e
      ON e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims
    WHERE p.id = p_profile_id AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    GROUP BY c.tenant_key
    ORDER BY c.tenant_key;
END
$$;

-- The dry run's read of the text it will count tokens for: the same selection as the keyset pass, with no run, no write and no profile
-- change. Refused for the legacy-column profile, which this job does not fill.
CREATE OR REPLACE FUNCTION rag_reembed_preview_batch(p_profile_id text, p_tenant_key text, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_storage text;
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  SELECT p.storage INTO v_storage FROM embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM rag_reembed_pick(p_profile_id, p_tenant_key, p_after, p_limit) x;
END
$$;

-- Ends a running run. completed is refused while any chunk of the run's scope still lacks a vector; failed is always allowed. The profile
-- stays backfilling either way: only the activation gate moves it on.
CREATE OR REPLACE FUNCTION rag_reembed_finish_run(p_run_id uuid, p_status text)
RETURNS TABLE (run_id uuid, status text, chunks_missing bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'reembed_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  SELECT m.chunks_missing INTO v_missing FROM rag_reembed_remaining(p_run_id) AS m;
  IF p_status = 'completed' AND v_missing > 0 THEN
    RAISE EXCEPTION 'reembed_refused: incomplete (% current ready chunks have no vector)', v_missing USING ERRCODE = '55000';
  END IF;
  UPDATE embedding_backfill_runs AS r SET status = p_status, updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT p_run_id, p_status, v_missing;
END
$$;

-- Deletes the target-profile rows a run wrote (rows of that profile and scope stamped between the run's start and its last update) and its
-- gaps, marks the run rolled back, and returns a backfilling profile to available when no other run of it is running. Refused for the active
-- profile, for a run that was updated in the last 10 minutes and is still running, and for a profile that has been active when any pointer
-- flip happened in the last 10 minutes (instances may still hold the old pointer, pitfall P-9).
CREATE OR REPLACE FUNCTION rag_reembed_rollback_run(p_run_id uuid, p_actor text)
RETURNS TABLE (rows_deleted bigint, profile_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_run embedding_backfill_runs%ROWTYPE;
  v_profile embedding_profiles%ROWTYPE;
  v_deleted bigint;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'rollback_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'running' AND v_run.updated_at > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'rollback_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.activated_at IS NOT NULL
     AND (SELECT max(p.activated_at) FROM embedding_profiles p) > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: recently_active' USING ERRCODE = '55000';
  END IF;

  DELETE FROM chunk_embeddings e
  WHERE e.profile_id = v_run.profile_id
    AND e.embedded_at >= v_run.started_at
    AND e.embedded_at <= v_run.updated_at
    AND (v_run.tenant_key IS NULL OR e.tenant_key = v_run.tenant_key);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM embedding_backfill_gaps g WHERE g.run_id = v_run.id;
  UPDATE embedding_backfill_runs AS r SET status = 'rolled_back', updated_at = now() WHERE r.id = v_run.id;

  IF v_profile.status = 'backfilling' AND NOT EXISTS (
    SELECT 1 FROM embedding_backfill_runs o WHERE o.profile_id = v_run.profile_id AND o.status = 'running' AND o.id <> v_run.id
  ) THEN
    UPDATE embedding_profiles SET status = 'available' WHERE id = v_run.profile_id;
  END IF;
  SELECT p.status INTO v_status FROM embedding_profiles p WHERE p.id = v_run.profile_id;

  RETURN QUERY SELECT v_deleted, v_status;
END
$$;

-- What the destructive legacy mode of scripts/rag/reprocess-documents.js must not run over: documents past version 1 (it deletes chunk ids that
-- citations point at) and profiles other than the legacy one that are backfilling, active, or hold vectors (their rows go with the chunks).
CREATE OR REPLACE FUNCTION rag_reembed_legacy_guard()
RETURNS TABLE (versioned_documents bigint, profiles_in_use text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    (SELECT count(*) FROM documents d WHERE d.version > 1),
    COALESCE(
      (SELECT array_agg(p.id ORDER BY p.id) FROM embedding_profiles p
       WHERE p.id <> 'openai-3-small-1536'
         AND (p.status IN ('backfilling', 'active') OR EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.profile_id = p.id))),
      '{}'::text[])
$$;

REVOKE ALL ON FUNCTION rag_reembed_pick(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_start_run(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_get_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_resume_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_next_batch(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_missing_batch(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_write_batch(uuid, jsonb, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_derive_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_remaining(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_count(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_preview_batch(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_finish_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_rollback_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reembed_legacy_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_reembed_start_run(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_get_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_resume_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_next_batch(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_missing_batch(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_write_batch(uuid, jsonb, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_derive_batch(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_remaining(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_count(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_preview_batch(text, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_finish_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_rollback_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reembed_legacy_guard() TO service_role;

COMMIT;

-- >>> supabase/migrations/0316_quarantine_access.multi-tenant.sql
-- 0316 (multi-tenant): close the direct read of quarantined rows through the tables (Phase 3, D-08, SEC-01).
-- The owner of a personal document and the members of an organization can read their rows through PostgREST, quarantined text included,
-- and the search functions that run as the caller follow the same policy. The policies below keep the ownership and membership rules
-- exactly as they are and add one condition: the row is current and ready. A chunk also needs its document to be visible, so a chunk whose
-- copy of the status drifted never shows a quarantined document. Server code reads with the service role, which bypasses RLS, so
-- retrieval, the admin routes and the dashboard are unchanged; a stored citation still resolves through the by-id reads of the service role.
-- Idempotent: DROP POLICY IF EXISTS then CREATE POLICY.

BEGIN;

DROP POLICY IF EXISTS "Allow full access to authenticated users" ON documents;
DROP POLICY IF EXISTS "Allow full access to authenticated users" ON document_chunks;

DROP POLICY IF EXISTS "Users can view documents" ON documents;
CREATE POLICY "Users can view documents" ON documents
  FOR SELECT USING (
    is_current AND status = 'ready'
    AND (
      -- Personal documents (flat workspace)
      (user_id = auth.uid() AND organization_id IS NULL)
      OR
      -- Organizational documents (personal projects + teams)
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Users can view chunks" ON document_chunks;
CREATE POLICY "Users can view chunks" ON document_chunks
  FOR SELECT USING (
    is_current AND status = 'ready'
    AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_chunks.document_id)
    AND (
      -- Personal chunks (via document ownership)
      document_id IN (
        SELECT id FROM documents
        WHERE user_id = auth.uid() AND organization_id IS NULL
      )
      OR
      -- Organizational chunks
      (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

COMMIT;

-- >>> supabase/migrations/0316_quarantine_admin.sql
-- 0316: admin list, release and delete of quarantined documents, and the audit table (Phase 3, D-31, SEC-01).
-- A quarantined document (plan 03-20, and an invoice quarantined by extraction, plan 03-29) never reaches retrieval. These functions are the
-- only way out: release publishes the version through rag_publish_document_version (the D-11 swap) in the same transaction, delete removes
-- only that version. Both write one rag_admin_audit row (actor, document, lineage, tenant, version, rule ids, time; never document text).
-- Who may act: p_actor must be in admin_users, and only the tenants the actor administers are visible. Single-tenant: the single tenant
-- (s:default). Multi-tenant: the actor's personal tenant (u:<actor>) and every organization where the actor is owner or admin (o:<id>).
-- A document of any other tenant is indistinguishable from an unknown id (not_found), so ids of other tenants are not probed.
-- The functions are SECURITY DEFINER and executable by service_role only; the route layer passes the id of the verified admin as p_actor.
-- 0316_quarantine_access (mode-specific files, applied just before this one) closes the direct table read of quarantined rows.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS rag_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('release_quarantine', 'delete_quarantined')),
  document_id uuid NOT NULL,
  lineage_id uuid,
  tenant_key text NOT NULL,
  version integer,
  actor uuid NOT NULL,
  rule_ids text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_admin_audit_tenant_time_idx ON rag_admin_audit (tenant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_admin_audit_document_idx ON rag_admin_audit (document_id);

-- Server role only: RLS on without policies, nothing granted to anon or authenticated, and no document id is a foreign key so a row
-- outlives the document it records.
ALTER TABLE rag_admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rag_admin_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON rag_admin_audit TO service_role;

CREATE OR REPLACE FUNCTION rag_admin_audit_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'rag_admin_audit is append-only';
END
$$;

REVOKE ALL ON FUNCTION rag_admin_audit_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_admin_audit_immutable ON rag_admin_audit;
CREATE TRIGGER rag_admin_audit_immutable
  BEFORE UPDATE OR DELETE ON rag_admin_audit
  FOR EACH ROW EXECUTE FUNCTION rag_admin_audit_immutable();

DROP TRIGGER IF EXISTS rag_admin_audit_no_truncate ON rag_admin_audit;
CREATE TRIGGER rag_admin_audit_no_truncate
  BEFORE TRUNCATE ON rag_admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION rag_admin_audit_immutable();

-- The tenant keys p_actor administers. Raises not_admin for a user who is not in admin_users (checked on every call, nothing cached).
-- organization_members exists in the multi-tenant schema only; the statement is planned only on that branch.
CREATE OR REPLACE FUNCTION rag_admin_tenant_keys(p_actor uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  multi_tenant boolean;
  keys text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF NOT multi_tenant THEN
    RETURN ARRAY['s:default'];
  END IF;
  keys := ARRAY['u:' || p_actor::text];
  keys := keys || COALESCE(
    (SELECT array_agg('o:' || m.organization_id::text) FROM organization_members m WHERE m.user_id = p_actor AND m.role IN ('owner', 'admin')),
    '{}'::text[]
  );
  RETURN keys;
END
$$;

-- Quarantined versions of the tenants p_actor administers, newest first. Rule ids, up to three snippets of at most 80 characters and the
-- quarantine time come from documents.metadata.quarantine; detected_by tells an injection scan from an invoice extraction quarantine.
-- total_count is the number of matching rows before the page is cut.
CREATE OR REPLACE FUNCTION rag_list_quarantine(
  p_actor uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  document_id uuid,
  lineage_id uuid,
  tenant_key text,
  filename text,
  source text,
  version integer,
  rule_ids text[],
  snippets text[],
  quarantined_at timestamptz,
  detected_by text,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  page_size integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  skip integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  WITH quarantined AS (
    SELECT
      d.id,
      d.lineage_id,
      d.tenant_key,
      d.filename,
      d.source,
      d.version,
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,rule_ids}') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(d.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END AS rule_ids,
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,snippets}') = 'array'
           THEN ARRAY(SELECT left(s.value, 80) FROM jsonb_array_elements_text(d.metadata #> '{quarantine,snippets}') AS s(value) LIMIT 3)
           ELSE '{}'::text[] END AS snippets,
      CASE WHEN (d.metadata #>> '{quarantine,quarantined_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
           THEN (d.metadata #>> '{quarantine,quarantined_at}')::timestamptz ELSE d.created_at END AS quarantined_at,
      CASE WHEN (d.metadata #>> '{invoice_extraction,status}') = 'quarantined' THEN 'invoice_extraction' ELSE 'injection_scan' END AS detected_by
    FROM documents d
    WHERE d.status = 'quarantined' AND d.tenant_key = ANY (keys)
  )
  SELECT q.id, q.lineage_id, q.tenant_key, q.filename, q.source, q.version, q.rule_ids, q.snippets, q.quarantined_at, q.detected_by,
         count(*) OVER () AS total_count
  FROM quarantined q
  ORDER BY q.quarantined_at DESC, q.id
  LIMIT page_size OFFSET skip;
END
$$;

-- Releases one quarantined version: the rule ids it was released for, who and when go into metadata.quarantine and processing_state, the
-- status leaves quarantined, and rag_publish_document_version runs the swap (a quarantined v2 of a lineage whose v1 is current replaces it;
-- a quarantined first version becomes current). One transaction: a failed publish leaves the document quarantined and writes no audit row.
-- An invoice quarantined by extraction stored no invoice field; its extraction record becomes released_unextracted so it no longer claims
-- quarantine, and the promoted columns stay empty.
CREATE OR REPLACE FUNCTION rag_release_quarantine(
  p_document_id uuid,
  p_actor uuid
)
RETURNS TABLE (outcome text, document_id uuid, version integer, superseded_document_id uuid, rule_ids text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  doc documents%ROWTYPE;
  ids text[];
  invoice_quarantined boolean;
  published record;
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  invoice_quarantined := (doc.metadata #>> '{invoice_extraction,status}') = 'quarantined';

  UPDATE documents d SET
    status = 'processing',
    metadata = COALESCE(d.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'quarantine',
        CASE WHEN jsonb_typeof(d.metadata -> 'quarantine') = 'object' THEN d.metadata -> 'quarantine' ELSE '{}'::jsonb END
          || jsonb_build_object(
            'released_by', p_actor::text,
            'released_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'released_rule_ids', to_jsonb(ids)))
      || CASE WHEN invoice_quarantined
              THEN jsonb_build_object('invoice_extraction', jsonb_build_object('status', 'released_unextracted'))
              ELSE '{}'::jsonb END,
    processing_state = CASE WHEN jsonb_typeof(d.processing_state -> 'quarantine') = 'object'
                            THEN jsonb_set(d.processing_state, '{quarantine,released}', 'true'::jsonb)
                            ELSE d.processing_state END
  WHERE d.id = doc.id;

  SELECT p.outcome, p.superseded_document_id INTO published FROM rag_publish_document_version(doc.id, doc.tenant_key) AS p;
  IF published.outcome IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'release_failed: %', COALESCE(published.outcome, 'unknown');
  END IF;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('release_quarantine', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT published.outcome, doc.id, doc.version, published.superseded_document_id, ids;
END
$$;

-- Deletes one quarantined version and nothing else: its chunks, its profile vectors and its backfill gaps go with it, and a clean
-- current version of the lineage stays. The keys of its stored objects (processing_state.artifacts and original_path) are returned so the
-- caller removes them from the private rag-originals bucket; the object removal cannot run in this transaction.
CREATE OR REPLACE FUNCTION rag_delete_quarantined(
  p_document_id uuid,
  p_actor uuid
)
RETURNS TABLE (document_id uuid, lineage_id uuid, tenant_key text, version integer, rule_ids text[], artifact_keys text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  doc documents%ROWTYPE;
  ids text[];
  stored text[];
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  stored := ARRAY(
    SELECT DISTINCT s.key FROM (
      SELECT e.value AS key
      FROM jsonb_each_text(CASE WHEN jsonb_typeof(doc.processing_state -> 'artifacts') = 'object' THEN doc.processing_state -> 'artifacts' ELSE '{}'::jsonb END) AS e
      UNION ALL
      SELECT doc.original_path
    ) AS s
    WHERE s.key IS NOT NULL AND s.key <> ''
  );

  UPDATE documents d SET superseded_by = NULL WHERE d.superseded_by = doc.id;
  -- The single-tenant schema has no cascade from documents to document_chunks; chunk_embeddings and gaps cascade from the chunks.
  DELETE FROM document_chunks c WHERE c.document_id = doc.id;
  DELETE FROM documents d WHERE d.id = doc.id;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('delete_quarantined', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT doc.id, doc.lineage_id, doc.tenant_key, doc.version, ids, stored;
END
$$;

REVOKE ALL ON FUNCTION rag_admin_tenant_keys(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_list_quarantine(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_release_quarantine(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_delete_quarantined(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_admin_tenant_keys(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_list_quarantine(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_release_quarantine(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_delete_quarantined(uuid, uuid) TO service_role;

COMMIT;

-- >>> supabase/migrations/0317_doc_type_change.sql
-- 0317: change the document type of an existing document as a new version (Phase 3, D-18, DATA-10).
-- An admin type change re-runs the ingest pipeline on the same identity (tenant_key, source, source_key) with the new type. The file bytes did not
-- change, so the file-hash skip of rag_begin_document_version (D-10) would turn that run into skipped_duplicate. This file adds a flag,
-- p_force_new_version (default false), that the type-change path alone sets: it skips the file-hash duplicate check, and it resumes a processing
-- row only when that row already carries the requested type. Every other caller omits the flag and keeps D-10 as before.
-- Adding a parameter makes a new signature, so the 11-argument function of 0310 is dropped first: with both present, a call that names 11
-- arguments would match both and fail as ambiguous. Re-applying 0310 after this file brings the old overload back until this file runs again.
-- Two read functions for the type-change path, both SECURITY DEFINER and executable by service_role only:
--   rag_get_document_for_type_change: what the operation needs from the current version of one document (identity, type, parser, stored
--     original, origin fields, caller metadata, saved state). Another tenant's id and an unknown id return no row.
--   rag_admin_document_scope: the tenant of a document, for the tenants p_actor administers only (rag_admin_tenant_keys of 0316: the single
--     tenant; or the actor's personal tenant and the organizations where the actor is owner or admin). Any other document, and an unknown
--     id, return no row, so ids of other tenants are not probed. A p_actor outside admin_users raises not_admin.
-- Idempotent: DROP FUNCTION IF EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

DROP FUNCTION IF EXISTS rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer);

CREATE OR REPLACE FUNCTION rag_begin_document_version(
  p_tenant_key text,
  p_user_id uuid,
  p_org_id uuid,
  p_source text,
  p_source_key text,
  p_filename text,
  p_file_sha256 text,
  p_doc_type text,
  p_doc_type_origin text,
  p_profile_id text,
  p_profile_version integer,
  p_force_new_version boolean DEFAULT false
)
RETURNS TABLE (outcome text, document_id uuid, version integer, lineage_id uuid, duplicate_of uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  multi_tenant boolean;
  expected_key text;
  duplicate_id uuid;
  existing record;
  previous record;
  new_id uuid := gen_random_uuid();
  new_version integer;
  new_lineage uuid;
  carried jsonb := '{}'::jsonb;
  forced boolean := COALESCE(p_force_new_version, false);
BEGIN
  IF p_tenant_key IS NULL OR p_source_key IS NULL OR p_source_key = '' THEN
    RAISE EXCEPTION 'invalid_argument: p_tenant_key and p_source_key are required';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    RAISE EXCEPTION 'invalid_source: %', COALESCE(p_source, '(null)');
  END IF;

  -- user_id is NOT NULL in the multi-tenant schema and nullable in the single-tenant one.
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    expected_key := CASE WHEN p_org_id IS NOT NULL THEN 'o:' || p_org_id::text ELSE 'u:' || p_user_id::text END;
  ELSE
    expected_key := 's:default';
  END IF;
  IF p_tenant_key IS DISTINCT FROM expected_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'p_tenant_key is not the tenant key of the given user and organization';
  END IF;
  IF multi_tenant AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_user_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_key || '|' || p_source || '|' || p_source_key, 0));

  IF p_file_sha256 IS NOT NULL AND NOT forced THEN
    SELECT d.id INTO duplicate_id
    FROM documents d
    WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = p_file_sha256 AND d.is_current AND d.status = 'ready'
    ORDER BY d.created_at, d.id
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'skipped_duplicate'::text, NULL::uuid, NULL::integer, NULL::uuid, duplicate_id;
      RETURN;
    END IF;
  END IF;

  SELECT d.id, d.version, d.lineage_id INTO existing
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
    AND d.status = 'processing' AND NOT d.is_current AND d.file_sha256 IS NOT DISTINCT FROM p_file_sha256
    AND (NOT forced OR d.doc_type = COALESCE(p_doc_type, 'general'))
  ORDER BY d.version DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'resumed'::text, existing.id, existing.version, existing.lineage_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.lineage_id, d.metadata INTO previous
  FROM documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
  ORDER BY d.is_current DESC, d.version DESC, d.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    new_lineage := previous.lineage_id;
    SELECT COALESCE(max(d.version), 0) + 1 INTO new_version FROM documents d WHERE d.lineage_id = new_lineage;
    IF previous.metadata ? 'external_url' THEN
      carried := jsonb_build_object('external_url', previous.metadata -> 'external_url');
    END IF;
  ELSE
    new_lineage := new_id;
    new_version := 1;
  END IF;

  INSERT INTO documents (
    id, lineage_id, version, is_current, status, source, source_key, filename, content, metadata,
    user_id, organization_id, file_sha256, doc_type, doc_type_origin, processing_profile_id, processing_profile_version
  ) VALUES (
    new_id, new_lineage, new_version, false, 'processing', p_source, p_source_key, COALESCE(NULLIF(p_filename, ''), p_source_key), '', carried,
    CASE WHEN multi_tenant THEN p_user_id END, CASE WHEN multi_tenant THEN p_org_id END, p_file_sha256,
    COALESCE(p_doc_type, 'general'), COALESCE(p_doc_type_origin, 'fallback'), p_profile_id, p_profile_version
  );

  RETURN QUERY SELECT 'created'::text, new_id, new_version, new_lineage, NULL::uuid;
END
$$;

-- The current version of one document of p_tenant_key as the type change needs it. The caller checks is_current and status itself.
CREATE OR REPLACE FUNCTION rag_get_document_for_type_change(
  p_document_id uuid,
  p_tenant_key text
)
RETURNS TABLE (
  lineage_id uuid,
  version integer,
  is_current boolean,
  status text,
  source text,
  source_key text,
  filename text,
  doc_type text,
  processing_profile_id text,
  parser_used text,
  parser_version text,
  original_path text,
  source_provider text,
  source_file_id text,
  source_connection_id text,
  metadata jsonb,
  processing_state jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.version, d.is_current, d.status, d.source, d.source_key, d.filename, d.doc_type, d.processing_profile_id,
         d.parser_used, d.parser_version, d.original_path, d.source_provider, d.source_file_id, d.source_connection_id,
         COALESCE(d.metadata, '{}'::jsonb), COALESCE(d.processing_state, '{}'::jsonb)
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$$;

-- The tenant a document belongs to, for an admin who administers that tenant. user_id and organization_id are the row's own, so the
-- new version keeps its owner. No row for an unknown id or a tenant the actor does not administer.
CREATE OR REPLACE FUNCTION rag_admin_document_scope(
  p_document_id uuid,
  p_actor uuid
)
RETURNS TABLE (
  tenant_key text,
  user_id uuid,
  organization_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  SELECT d.tenant_key, d.user_id, d.organization_id
  FROM documents d
  WHERE d.id = p_document_id AND d.tenant_key = ANY (keys);
END
$$;

REVOKE ALL ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_get_document_for_type_change(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_admin_document_scope(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_begin_document_version(text, uuid, uuid, text, text, text, text, text, text, text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION rag_get_document_for_type_change(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_admin_document_scope(uuid, uuid) TO service_role;

COMMIT;

-- >>> supabase/migrations/0318_eval_evidence.sql
-- 0318: record activation eval evidence on a target profile (Phase 3, D-40(c)).
-- rag_record_eval_evidence stores validated JSON on the target row for rag_activate_embedding_profile; service role only; refused for the active profile.

BEGIN;

CREATE OR REPLACE FUNCTION rag_record_eval_evidence(p_profile_id text, p_evidence jsonb, p_actor text)
RETURNS TABLE (profile_id text, recorded_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile embedding_profiles%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'evidence_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile FROM embedding_profiles WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'evidence_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'evidence_refused: invalid_evidence' USING ERRCODE = '22023';
  END IF;
  IF p_evidence->>'target_profile' IS DISTINCT FROM p_profile_id THEN
    RAISE EXCEPTION 'evidence_refused: target_mismatch' USING ERRCODE = '55000';
  END IF;

  UPDATE embedding_profiles SET eval_evidence = p_evidence WHERE id = p_profile_id;

  RETURN QUERY SELECT p_profile_id, now();
END
$$;

REVOKE ALL ON FUNCTION rag_record_eval_evidence(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_record_eval_evidence(text, jsonb, text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0319_document_content.sql
-- 0319: rag_set_document_fields accepts content (Phase 3, plan 03-41a).
-- Unified ingestion left documents.content at '' (rag_begin_document_version inserts it empty and the 0314 allow-list had no content), while the
-- legacy relevance filter and the source previews read it (src/lib/rag/context/assemble.ts, refs/resolve.ts). The writer now stores the parsed text there.
-- The 0314 function exactly, plus the one text key: content must be a JSON string (a number, object, array or null raises invalid_field and writes
-- nothing); a call without the key leaves the column alone. SECURITY DEFINER, search_path, the tenant check and every other field are unchanged.
-- Idempotent: CREATE OR REPLACE with the same signature, then REVOKE and GRANT as 0314 left them.

BEGIN;

CREATE OR REPLACE FUNCTION rag_set_document_fields(
  p_document_id uuid,
  p_tenant_key text,
  p_fields jsonb
)
RETURNS TABLE (document_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  field_name text;
  allowed text[] := ARRAY[
    'content_hash', 'language', 'doc_date', 'doc_type', 'doc_type_origin', 'parser_used', 'parser_version',
    'processing_profile_id', 'processing_profile_version', 'original_path', 'source_provider', 'source_file_id',
    'source_connection_id', 'status', 'metadata',
    'invoice_number', 'supplier_name', 'supplier_tax_id', 'issue_date', 'gross_total', 'currency',
    'content'
  ];
  doc documents%ROWTYPE;
  issue date;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_fields: p_fields must be a JSON object';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (field_name = ANY (allowed)) THEN
      RAISE EXCEPTION 'invalid_field: %', field_name;
    END IF;
  END LOOP;
  IF p_fields ? 'status' AND (jsonb_typeof(p_fields -> 'status') <> 'string'
      OR (p_fields ->> 'status') NOT IN ('processing', 'quarantined', 'failed', 'deleted')) THEN
    RAISE EXCEPTION 'invalid_status: %', p_fields ->> 'status';
  END IF;
  IF p_fields ? 'metadata' AND jsonb_typeof(p_fields -> 'metadata') <> 'object' THEN
    RAISE EXCEPTION 'invalid_metadata: metadata must be a JSON object';
  END IF;

  IF p_fields ? 'content' AND jsonb_typeof(p_fields -> 'content') <> 'string' THEN
    RAISE EXCEPTION 'invalid_field: content';
  END IF;
  IF p_fields ? 'invoice_number' AND jsonb_typeof(p_fields -> 'invoice_number') <> 'null'
      AND (jsonb_typeof(p_fields -> 'invoice_number') <> 'string' OR length(p_fields ->> 'invoice_number') > 64) THEN
    RAISE EXCEPTION 'invalid_field: invoice_number';
  END IF;
  IF p_fields ? 'supplier_name' AND jsonb_typeof(p_fields -> 'supplier_name') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_name') <> 'string' OR length(p_fields ->> 'supplier_name') > 300) THEN
    RAISE EXCEPTION 'invalid_field: supplier_name';
  END IF;
  IF p_fields ? 'supplier_tax_id' AND jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'string' OR length(p_fields ->> 'supplier_tax_id') > 64) THEN
    RAISE EXCEPTION 'invalid_field: supplier_tax_id';
  END IF;
  IF p_fields ? 'currency' AND jsonb_typeof(p_fields -> 'currency') <> 'null'
      AND (jsonb_typeof(p_fields -> 'currency') <> 'string' OR (p_fields ->> 'currency') !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'invalid_field: currency';
  END IF;
  IF p_fields ? 'gross_total' AND jsonb_typeof(p_fields -> 'gross_total') <> 'null'
      AND (jsonb_typeof(p_fields -> 'gross_total') <> 'string' OR (p_fields ->> 'gross_total') !~ '^-?[0-9]{1,16}(\.[0-9]{1,4})?$') THEN
    RAISE EXCEPTION 'invalid_field: gross_total';
  END IF;
  IF p_fields ? 'issue_date' AND jsonb_typeof(p_fields -> 'issue_date') <> 'null' THEN
    IF jsonb_typeof(p_fields -> 'issue_date') <> 'string' OR (p_fields ->> 'issue_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END IF;
    BEGIN
      issue := (p_fields ->> 'issue_date')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END;
  END IF;

  UPDATE documents d SET
    content_hash = CASE WHEN p_fields ? 'content_hash' THEN p_fields ->> 'content_hash' ELSE d.content_hash END,
    language = CASE WHEN p_fields ? 'language' THEN p_fields ->> 'language' ELSE d.language END,
    doc_date = CASE WHEN p_fields ? 'doc_date' THEN (p_fields ->> 'doc_date')::date ELSE d.doc_date END,
    doc_type = CASE WHEN p_fields ? 'doc_type' THEN p_fields ->> 'doc_type' ELSE d.doc_type END,
    doc_type_origin = CASE WHEN p_fields ? 'doc_type_origin' THEN p_fields ->> 'doc_type_origin' ELSE d.doc_type_origin END,
    parser_used = CASE WHEN p_fields ? 'parser_used' THEN p_fields ->> 'parser_used' ELSE d.parser_used END,
    parser_version = CASE WHEN p_fields ? 'parser_version' THEN p_fields ->> 'parser_version' ELSE d.parser_version END,
    processing_profile_id = CASE WHEN p_fields ? 'processing_profile_id' THEN p_fields ->> 'processing_profile_id' ELSE d.processing_profile_id END,
    processing_profile_version = CASE WHEN p_fields ? 'processing_profile_version' THEN (p_fields ->> 'processing_profile_version')::integer ELSE d.processing_profile_version END,
    original_path = CASE WHEN p_fields ? 'original_path' THEN p_fields ->> 'original_path' ELSE d.original_path END,
    source_provider = CASE WHEN p_fields ? 'source_provider' THEN p_fields ->> 'source_provider' ELSE d.source_provider END,
    source_file_id = CASE WHEN p_fields ? 'source_file_id' THEN p_fields ->> 'source_file_id' ELSE d.source_file_id END,
    source_connection_id = CASE WHEN p_fields ? 'source_connection_id' THEN p_fields ->> 'source_connection_id' ELSE d.source_connection_id END,
    status = CASE WHEN p_fields ? 'status' THEN p_fields ->> 'status' ELSE d.status END,
    metadata = CASE WHEN p_fields ? 'metadata' THEN COALESCE(d.metadata, '{}'::jsonb) || (p_fields -> 'metadata') ELSE d.metadata END,
    invoice_number = CASE WHEN p_fields ? 'invoice_number' THEN p_fields ->> 'invoice_number' ELSE d.invoice_number END,
    supplier_name = CASE WHEN p_fields ? 'supplier_name' THEN p_fields ->> 'supplier_name' ELSE d.supplier_name END,
    supplier_tax_id = CASE WHEN p_fields ? 'supplier_tax_id' THEN p_fields ->> 'supplier_tax_id' ELSE d.supplier_tax_id END,
    issue_date = CASE WHEN p_fields ? 'issue_date' THEN (p_fields ->> 'issue_date')::date ELSE d.issue_date END,
    gross_total = CASE WHEN p_fields ? 'gross_total' THEN (p_fields ->> 'gross_total')::numeric(20, 4) ELSE d.gross_total END,
    currency = CASE WHEN p_fields ? 'currency' THEN p_fields ->> 'currency' ELSE d.currency END,
    content = CASE WHEN p_fields ? 'content' THEN p_fields ->> 'content' ELSE d.content END
  WHERE d.id = p_document_id;

  IF p_fields ?| ARRAY['doc_type', 'doc_date', 'language', 'parser_used', 'status'] THEN
    UPDATE document_chunks c SET
      doc_type = d.doc_type,
      doc_date = d.doc_date,
      language = d.language,
      parser_used = d.parser_used,
      status = d.status,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('doc_type', d.doc_type, 'language', d.language, 'parser_used', d.parser_used)
    FROM documents d
    WHERE d.id = p_document_id AND c.document_id = d.id;
  END IF;

  RETURN QUERY SELECT d.id, d.status FROM documents d WHERE d.id = p_document_id;
END
$$;

REVOKE ALL ON FUNCTION rag_set_document_fields(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_set_document_fields(uuid, text, jsonb) TO service_role;

-- 03-48 follow-up 2 (D-08): SECURITY DEFINER EXECUTE lock-down. Hosted Supabase grants EXECUTE on new public functions to anon and authenticated,
-- so a definer function that is not revoked here is callable through PostgREST. Matches supabase/migrations/0410_security_definer_rpc_grants.sql.
REVOKE ALL ON FUNCTION get_user_role_in_org(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_user_role_in_org(uuid) TO service_role;
REVOKE ALL ON FUNCTION get_user_current_org() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_user_current_org() TO service_role;
REVOKE ALL ON FUNCTION can_view_org_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION can_view_org_member(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION delete_folder(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_folder(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION get_folder_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_folder_stats(uuid) TO service_role;
REVOKE ALL ON FUNCTION move_chats_to_folder(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION move_chats_to_folder(uuid[], uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION share_chat(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION share_chat(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION unshare_chat(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION unshare_chat(uuid) TO service_role;
REVOKE ALL ON FUNCTION share_personal_organization(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION share_personal_organization(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION check_admin_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_admin_status() TO authenticated, anon, service_role;

COMMIT;

-- >>> supabase/migrations/0320_ingest_state_guard.sql
-- 0320: authenticated users cannot change ingest state through the tables (Phase 3 gap W1, SEC-01).
-- The table UPDATE policies (single-tenant "Owners and admins update documents/chunks", multi-tenant "Users can update documents") decide which rows a
-- user may write, not which columns. An unfiltered PostgREST PATCH skips the SELECT policy of 0316, so an uploader could set status = 'ready' and
-- is_current = true on their own quarantined document and its chunks (single-tenant), or an organization member could flip the document row
-- (multi-tenant), which releases the document without the admin release (rag_release_quarantine). Version, lineage and supersession columns have the same problem.
-- A column-level REVOKE is fragile next to the table-level grants Supabase gives the API roles, so the guard is a BEFORE UPDATE trigger: it raises 42501
-- when a role other than service_role, postgres or supabase_admin changes one of the listed columns. current_user is the role that runs the statement:
-- the SECURITY DEFINER functions (release, soft delete, writer, activation) run as their owner and pass; PostgREST requests run as authenticated and do not.
-- Columns are compared through to_jsonb, so a column that a later migration adds (needs_review, provisional, parse_cache_id) is guarded from the day it exists
-- and a column that does not exist yet is not an error. The service role returns before any comparison, so bulk writes of the pipeline pay nothing.
-- documents.tenant_key is a generated column (it follows user_id and organization_id) and is not in the list: a BEFORE trigger sees it unset.
-- Writing a guarded column to the value it already has is allowed; filename, metadata and the other content columns stay editable by the owner.
-- Idempotent: CREATE OR REPLACE the function, DROP TRIGGER IF EXISTS then CREATE TRIGGER, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION rag_guard_ingest_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  col text;
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  old_row := pg_catalog.to_jsonb(OLD);
  new_row := pg_catalog.to_jsonb(NEW);
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION 'ingest state column % of %.% cannot be changed by role %', col, TG_TABLE_SCHEMA, TG_TABLE_NAME, current_user
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- Trigger functions run without an EXECUTE check on the writing role; nothing but the triggers should be able to name this one.
REVOKE ALL ON FUNCTION rag_guard_ingest_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_guard_ingest_state() TO service_role;

DROP TRIGGER IF EXISTS rag_guard_ingest_state ON documents;
CREATE TRIGGER rag_guard_ingest_state
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION rag_guard_ingest_state(
    'status', 'is_current', 'version', 'lineage_id', 'superseded_by', 'source', 'source_key',
    'processing_status', 'processing_state', 'doc_type', 'doc_type_origin', 'content_hash', 'file_sha256', 'original_path',
    'parser_used', 'parser_version', 'processing_profile_id', 'processing_profile_version',
    'needs_review', 'needs_review_reason', 'provisional', 'parse_cache_id'
  );

DROP TRIGGER IF EXISTS rag_guard_ingest_state ON document_chunks;
CREATE TRIGGER rag_guard_ingest_state
  BEFORE UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION rag_guard_ingest_state(
    'status', 'is_current', 'version', 'tenant_key', 'document_id', 'provisional', 'doc_type', 'doc_date', 'language', 'source',
    'chunk_kind', 'content_hash', 'parser_used', 'embedding_text_version'
  );

COMMIT;

------------------------------------------
-- Phase 3.1: Tiered parsing, ingestion queue and bulk backfill (migrations 0351-0359)
------------------------------------------

-- >>> supabase/migrations/0351_ingestion_schema.sql
-- 0351: Phase 3.1 ingestion ledger, batches, parse cache, budget counters, tier overrides and embed batch tracking.
-- Additive and idempotent. Server role only on new tables (RLS enabled, no policies).
-- Document and chunk columns for needs_review and progressive publishing.

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rag_parse_tier_rank(p_tier text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_tier
    WHEN 'native' THEN 0
    WHEN 'fast' THEN 1
    WHEN 'structured' THEN 2
    WHEN 'premium' THEN 3
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION rag_ingest_assert_tenant_key(p_tenant_key text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL OR btrim(p_tenant_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key ~ '[A-Z]' OR position('=' IN p_tenant_key) > 0 OR position('''' IN p_tenant_key) > 0 THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    IF p_tenant_key !~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
    END IF;
  ELSIF p_tenant_key <> 's:default' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION rag_release_job_reservations(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  released integer := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT r.id, r.tenant_key, r.month, r.pages, r.kind
    FROM rag_parse_budget_reservations r
    WHERE r.job_id = p_job_id AND r.state = 'open'
    FOR UPDATE
  LOOP
    UPDATE rag_parse_budget_reservations SET state = 'released' WHERE id = rec.id;
  -- Per kind, decrement pages_reserved on the usage row (parse and vlm share the same counter).
    UPDATE rag_parse_budget_usage u
       SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages)
     WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;
    released := released + 1;
  END LOOP;
  RETURN released;
END;
$$;

REVOKE ALL ON FUNCTION rag_parse_tier_rank(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_assert_tenant_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_release_job_reservations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_parse_tier_rank(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_assert_tenant_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_release_job_reservations(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingestion_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_ref text NOT NULL,
  budget_usd numeric(12, 6),
  spent_usd numeric(12, 6) NOT NULL DEFAULT 0,
  concurrency integer NOT NULL DEFAULT 1,
  runner text NOT NULL DEFAULT 'worker',
  status text NOT NULL DEFAULT 'pending',
  dry_run_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_batches_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT ingestion_batches_source_kind_check CHECK (source_kind IN ('folder', 'bucket', 'manifest')),
  CONSTRAINT ingestion_batches_runner_check CHECK (runner IN ('worker', 'ray')),
  CONSTRAINT ingestion_batches_status_check CHECK (
    status IN ('pending', 'sampling', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT ingestion_batches_concurrency_check CHECK (concurrency > 0)
);

CREATE TABLE IF NOT EXISTS rag_parse_budget_usage (
  tenant_key text NOT NULL,
  month date NOT NULL,
  pages_reserved integer NOT NULL DEFAULT 0,
  pages_used integer NOT NULL DEFAULT 0,
  vlm_pages_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_key, month),
  CONSTRAINT rag_parse_budget_usage_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_parse_budget_usage_nonnegative CHECK (
    pages_reserved >= 0 AND pages_used >= 0 AND vlm_pages_used >= 0
  )
);

CREATE TABLE IF NOT EXISTS rag_parse_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  file_sha256 text NOT NULL,
  parser text NOT NULL,
  parser_version text NOT NULL,
  options_hash text NOT NULL,
  object_prefix text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  byte_size bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_parse_cache_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_parse_cache_options_hash_check CHECK (options_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_parse_cache_key_ux
  ON rag_parse_cache (tenant_key, file_sha256, parser, parser_version, options_hash);

CREATE INDEX IF NOT EXISTS rag_parse_cache_tenant_file_sha256_idx ON rag_parse_cache (tenant_key, file_sha256);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'ingest',
  status text NOT NULL DEFAULT 'queued',
  stage text,
  tenant_key text NOT NULL,
  document_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  lineage_id uuid,
  version integer,
  batch_id uuid REFERENCES ingestion_batches (id) ON DELETE SET NULL,
  source text,
  source_key text NOT NULL,
  file_sha256 text,
  filename text,
  mime_type text,
  original_ref jsonb,
  priority integer NOT NULL DEFAULT 100,
  retries integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  run_after timestamptz,
  lease_until timestamptz,
  locked_by text,
  runner text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  doc_class text,
  tier text,
  parser_used text,
  parser_version text,
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalations integer NOT NULL DEFAULT 0,
  pages integer,
  page_ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier_page_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  detect_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  preflight_ref text,
  est_cost_usd numeric(12, 6),
  embedding_profile text,
  error_class text,
  error text,
  needs_review_reason text,
  routing_note text,
  provisional_published_at timestamptz,
  trace_id uuid,
  timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT ingestion_jobs_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT ingestion_jobs_kind_check CHECK (kind IN ('ingest', 'dry_run', 'delete')),
  CONSTRAINT ingestion_jobs_status_check CHECK (
    status IN (
      'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
      'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
    )
  ),
  CONSTRAINT ingestion_jobs_runner_check CHECK (runner IS NULL OR runner IN ('worker', 'ray')),
  CONSTRAINT ingestion_jobs_source_check CHECK (
    source IS NULL OR source IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag')
  ),
  CONSTRAINT ingestion_jobs_tier_check CHECK (
    tier IS NULL OR tier IN ('native', 'fast', 'structured', 'premium')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_batch_kind_source_key_ux
  ON ingestion_jobs (batch_id, kind, source_key)
  WHERE batch_id IS NOT NULL;

-- Superseded by 0421_ingestion_queue_indexes.sql; drop on re-apply so the catalog stays idempotent.
DROP INDEX IF EXISTS public.ingestion_jobs_queued_claim_idx;
DROP INDEX IF EXISTS public.ingestion_jobs_active_lease_idx;

CREATE INDEX IF NOT EXISTS ingestion_jobs_document_id_idx ON ingestion_jobs (document_id);

CREATE TABLE IF NOT EXISTS rag_parse_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ingestion_jobs (id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  tenant_key text NOT NULL,
  month date NOT NULL,
  pages integer NOT NULL,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_parse_budget_reservations_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_parse_budget_reservations_kind_check CHECK (kind IN ('parse', 'vlm')),
  CONSTRAINT rag_parse_budget_reservations_state_check CHECK (state IN ('open', 'settled', 'released')),
  CONSTRAINT rag_parse_budget_reservations_pages_check CHECK (pages > 0),
  UNIQUE (job_id, attempt_no, kind)
);

CREATE TABLE IF NOT EXISTS rag_parse_tier_overrides (
  doc_type text PRIMARY KEY,
  min_tier text NOT NULL,
  max_tier text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_parse_tier_overrides_min_tier_check CHECK (min_tier IN ('native', 'fast', 'structured', 'premium')),
  CONSTRAINT rag_parse_tier_overrides_max_tier_check CHECK (max_tier IN ('native', 'fast', 'structured', 'premium')),
  CONSTRAINT rag_parse_tier_overrides_order_check CHECK (rag_parse_tier_rank(min_tier) <= rag_parse_tier_rank(max_tier))
);

CREATE TABLE IF NOT EXISTS rag_embed_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES ingestion_batches (id) ON DELETE SET NULL,
  profile_id text NOT NULL REFERENCES embedding_profiles (id),
  provider text NOT NULL,
  provider_batch_id text,
  input_file_id text,
  output_file_id text,
  error_file_id text,
  input_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_embed_batches_status_check CHECK (
    status IN (
      'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
      'expired', 'cancelling', 'cancelled'
    )
  )
);

-- ---------------------------------------------------------------------------
-- documents / document_chunks
-- ---------------------------------------------------------------------------

ALTER TABLE documents ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS needs_review_reason text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_cache_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_parse_cache_id_fkey'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_parse_cache_id_fkey
      FOREIGN KEY (parse_cache_id) REFERENCES rag_parse_cache (id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false;

-- status 'deleted' is already in documents_status_check from 0301; ensure constraint exists for older trees.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_status_check') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_status_check
      CHECK (status IN ('processing', 'ready', 'quarantined', 'failed', 'deleted'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS and grants (seven new tables)
-- ---------------------------------------------------------------------------

ALTER TABLE ingestion_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_budget_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_tier_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_parse_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_embed_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE ingestion_batches FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE ingestion_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_budget_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_budget_reservations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_tier_overrides FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_parse_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE rag_embed_batches FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE ingestion_batches TO service_role;
GRANT ALL ON TABLE ingestion_jobs TO service_role;
GRANT ALL ON TABLE rag_parse_budget_usage TO service_role;
GRANT ALL ON TABLE rag_parse_budget_reservations TO service_role;
GRANT ALL ON TABLE rag_parse_tier_overrides TO service_role;
GRANT ALL ON TABLE rag_parse_cache TO service_role;
GRANT ALL ON TABLE rag_embed_batches TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- >>> supabase/migrations/0352_ingestion_claim.sql
-- 0352: Ingestion ledger enqueue, claim, heartbeat and release (Phase 3.1 plan 07).

BEGIN;

-- ---------------------------------------------------------------------------
-- Batch concurrency (F-11): lock batch row, count live leases against concurrency
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_batch_has_room(p_batch_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_concurrency integer;
  v_leased integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RETURN true;
  END IF;
  SELECT b.concurrency INTO v_concurrency
    FROM ingestion_batches b
   WHERE b.id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT count(*)::integer INTO v_leased
    FROM ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();
  RETURN v_leased < v_concurrency;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_batch_has_room(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_batch_has_room(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Enqueue one ledger row (validated tenant, optional document and batch)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_enqueue_ingestion_job(
  p_tenant_key text,
  p_kind text DEFAULT 'ingest',
  p_source text DEFAULT NULL,
  p_source_key text DEFAULT NULL,
  p_file_sha256 text DEFAULT NULL,
  p_filename text DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_original_ref jsonb DEFAULT NULL,
  p_settings jsonb DEFAULT '{}'::jsonb,
  p_priority integer DEFAULT 100,
  p_document_id uuid DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL,
  p_status text DEFAULT 'queued'
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc_tenant text;
  v_batch_tenant text;
  v_row public.ingestion_jobs%ROWTYPE;
BEGIN
  PERFORM rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_kind IS NULL OR p_kind NOT IN ('ingest', 'dry_run', 'delete') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_source_key IS NULL OR btrim(p_source_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_source_key' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
  ) THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT d.tenant_key INTO v_doc_tenant FROM documents d WHERE d.id = p_document_id;
    IF NOT FOUND OR v_doc_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: document_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT b.tenant_key INTO v_batch_tenant FROM ingestion_batches b WHERE b.id = p_batch_id;
    IF NOT FOUND OR v_batch_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: batch_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO ingestion_jobs (
    tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
    original_ref, settings, priority, document_id, batch_id
  ) VALUES (
    p_tenant_key, p_kind, p_status, p_source, p_source_key, p_file_sha256, p_filename, p_mime_type,
    p_original_ref, COALESCE(p_settings, '{}'::jsonb), COALESCE(p_priority, 100), p_document_id, p_batch_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_enqueue_ingestion_job(
  text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_ingestion_job(
  text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text
) TO service_role;

-- ---------------------------------------------------------------------------
-- Claim up to p_limit jobs (priority, SKIP LOCKED, lease, batch slot, reclaim)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_jobs(
  p_worker text,
  p_limit integer,
  p_allow_batch boolean,
  p_runner text DEFAULT 'worker'
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed integer := 0;
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_limit integer;
BEGIN
  v_limit := GREATEST(COALESCE(p_limit, 0), 0);
  IF v_limit < 1 THEN
    RETURN;
  END IF;

  WHILE v_claimed < v_limit LOOP
    SELECT j.* INTO v_job
      FROM ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.kind IN ('ingest', 'dry_run')
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
       AND (p_allow_batch OR j.batch_id IS NULL)
       AND (
         (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
         OR (
           j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < now()
         )
       )
       AND (j.batch_id IS NULL OR rag_batch_has_room(j.batch_id))
     ORDER BY j.priority DESC, j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      EXIT;
    END IF;

    IF v_job.batch_id IS NOT NULL AND NOT rag_batch_has_room(v_job.batch_id) THEN
      CONTINUE;
    END IF;

    IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
      v_new_retries := v_job.retries + 1;
      IF v_new_retries > v_job.max_retries THEN
        PERFORM rag_release_job_reservations(v_job.id);
        UPDATE ingestion_jobs
           SET status = 'failed',
               error_class = 'lease_expired',
               retries = v_new_retries,
               locked_by = NULL,
               lease_until = NULL,
               runner = NULL,
               updated_at = now()
         WHERE id = v_job.id;
        CONTINUE;
      END IF;
      PERFORM rag_release_job_reservations(v_job.id);
    END IF;

    UPDATE ingestion_jobs j
       SET status = CASE
             WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
             ELSE j.status
           END,
           retries = CASE
             WHEN j.status = 'queued' THEN j.retries
             ELSE j.retries + 1
           END,
           locked_by = p_worker,
           runner = p_runner,
           lease_until = now() + interval '120 seconds',
           updated_at = now()
     WHERE j.id = v_job.id
     RETURNING j.* INTO v_job;

    v_claimed := v_claimed + 1;
    RETURN NEXT v_job;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Claim one named job (Ray run_once)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_runner text DEFAULT 'worker'
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
BEGIN
  SELECT j.* INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.deleted_at IS NULL
     AND j.kind IN ('ingest', 'dry_run')
     AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
     AND (
       (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
       OR (
         j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
         AND j.lease_until IS NOT NULL
         AND j.lease_until < now()
       )
     )
   FOR UPDATE OF j SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_job.batch_id IS NOT NULL AND NOT rag_batch_has_room(v_job.batch_id) THEN
    RETURN NULL;
  END IF;

  IF v_job.locked_by IS NOT NULL AND v_job.lease_until IS NOT NULL AND v_job.lease_until > now() THEN
    RETURN NULL;
  END IF;

  IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
    v_new_retries := v_job.retries + 1;
    IF v_new_retries > v_job.max_retries THEN
      PERFORM rag_release_job_reservations(v_job.id);
      UPDATE ingestion_jobs
         SET status = 'failed',
             error_class = 'lease_expired',
             retries = v_new_retries,
             locked_by = NULL,
             lease_until = NULL,
             runner = NULL,
             updated_at = now()
       WHERE id = v_job.id;
      RETURN NULL;
    END IF;
    PERFORM rag_release_job_reservations(v_job.id);
  END IF;

  UPDATE ingestion_jobs j
     SET status = CASE
           WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
           ELSE j.status
         END,
         retries = CASE
           WHEN j.status = 'queued' THEN j.retries
           ELSE j.retries + 1
         END,
         locked_by = p_worker,
         runner = p_runner,
         lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Heartbeat and release (owner + live lease only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_heartbeat_ingestion_job(
  p_job_id uuid,
  p_worker text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE ingestion_jobs j
     SET lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = p_job_id
     AND j.locked_by = p_worker
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now()
   RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.rag_heartbeat_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_heartbeat_ingestion_job(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_release_ingestion_job(
  p_job_id uuid,
  p_worker text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE ingestion_jobs j
     SET status = 'queued',
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
     AND j.locked_by = p_worker
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now()
   RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;

REVOKE ALL ON FUNCTION rag_release_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_release_ingestion_job(uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- >>> supabase/migrations/0353_ingestion_transitions.sql
-- 0353: Ingestion ledger transitions, parse attempts, fail/retry/delete, reads and guarded Realtime broadcast.

BEGIN;

ALTER TABLE rag_admin_audit DROP CONSTRAINT IF EXISTS rag_admin_audit_action_check;
ALTER TABLE rag_admin_audit ADD CONSTRAINT rag_admin_audit_action_check CHECK (
  action IN (
    'release_quarantine',
    'delete_quarantined',
    'retry_ingestion_job',
    'delete_ingestion_job'
  )
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rag_ingest_job_status_for_stage(p_stage text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_stage
    WHEN 'begin' THEN 'queued'
    WHEN 'preflight' THEN 'preflight'
    WHEN 'parse' THEN 'parsing'
    WHEN 'check' THEN 'checking'
    WHEN 'content_hash_dedup' THEN 'chunking'
    WHEN 'scan_injection' THEN 'chunking'
    WHEN 'chunk' THEN 'chunking'
    WHEN 'enrich' THEN 'chunking'
    WHEN 'extract' THEN 'chunking'
    WHEN 'images' THEN 'chunking'
    WHEN 'embed' THEN 'embedding'
    WHEN 'write' THEN 'embedding'
    WHEN 'publish' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'quarantined'
    WHEN 'needs_review' THEN 'needs_review'
    WHEN 'skipped_duplicate' THEN 'skipped_duplicate'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION rag_ingest_mirror_processing_status(p_ledger_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_ledger_status
    WHEN 'queued' THEN 'queued'
    WHEN 'preflight' THEN 'parsing'
    WHEN 'parsing' THEN 'parsing'
    WHEN 'checking' THEN 'parsing'
    WHEN 'chunking' THEN 'chunking'
    WHEN 'embedding' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'needs_review' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'failed'
    WHEN 'skipped_duplicate' THEN 'ready'
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION rag_ingest_assert_job_lease(p_job public.ingestion_jobs, p_worker text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_job.locked_by IS DISTINCT FROM p_worker
     OR p_job.lease_until IS NULL
     OR p_job.lease_until <= now() THEN
    RAISE EXCEPTION 'lease_lost' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Pitfall 4: every mutating path raises lease_lost when the worker does not own a live lease.

CREATE OR REPLACE FUNCTION rag_ingest_broadcast_job(p_job public.ingestion_jobs)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN
    RETURN;
  END IF;
  v_payload := jsonb_build_object(
    'job_id', p_job.id,
    'document_id', p_job.document_id,
    'status', p_job.status,
    'stage', p_job.stage,
    'provisional', p_job.provisional_published_at IS NOT NULL
  );
  PERFORM realtime.send(v_payload, 'ingest_status', 'rag-ingest:' || p_job.tenant_key, true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Advance and parse attempts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_advance_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_stage text,
  p_status text,
  p_stage_state jsonb DEFAULT NULL,
  p_timing_ms integer DEFAULT NULL,
  p_fields jsonb DEFAULT '{}'::jsonb
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_expected text;
  v_timings jsonb;
  v_key text;
  v_value jsonb;
  v_whitelist text[] := ARRAY[
    'doc_class', 'tier', 'parser_used', 'parser_version', 'pages', 'page_ranges',
    'tier_page_counts', 'detect_counts', 'preflight_ref', 'est_cost_usd', 'embedding_profile',
    'document_id', 'needs_review_reason', 'routing_note', 'provisional_published_at', 'trace_id'
  ];
  v_terminal boolean;
  v_mirror text;
BEGIN
  IF p_stage IS NULL OR btrim(p_stage) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  v_expected := rag_ingest_job_status_for_stage(p_stage);
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status <> v_expected THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_stage' USING ERRCODE = '22023';
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) = 'object' THEN
    FOR v_key IN SELECT jsonb_object_keys(p_fields)
    LOOP
      IF NOT (v_key = ANY (v_whitelist)) THEN
        RAISE EXCEPTION 'ingest_refused: field_not_allowed' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO v_job FROM ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM rag_ingest_assert_job_lease(v_job, p_worker);

  v_timings := COALESCE(v_job.timings, '{}'::jsonb);
  IF p_timing_ms IS NOT NULL AND p_stage IS NOT NULL THEN
    v_timings := v_timings || jsonb_build_object(
      p_stage,
      COALESCE((v_timings ->> p_stage)::bigint, 0) + p_timing_ms
    );
  END IF;

  UPDATE ingestion_jobs j
     SET status = p_status,
         stage = p_stage,
         timings = v_timings,
         stage_state = CASE WHEN p_stage_state IS NOT NULL THEN p_stage_state ELSE j.stage_state END,
         doc_class = COALESCE(p_fields ->> 'doc_class', j.doc_class),
         tier = COALESCE(p_fields ->> 'tier', j.tier),
         parser_used = COALESCE(p_fields ->> 'parser_used', j.parser_used),
         parser_version = COALESCE(p_fields ->> 'parser_version', j.parser_version),
         pages = COALESCE((p_fields ->> 'pages')::integer, j.pages),
         page_ranges = CASE WHEN p_fields ? 'page_ranges' THEN p_fields -> 'page_ranges' ELSE j.page_ranges END,
         tier_page_counts = CASE WHEN p_fields ? 'tier_page_counts' THEN p_fields -> 'tier_page_counts' ELSE j.tier_page_counts END,
         detect_counts = CASE WHEN p_fields ? 'detect_counts' THEN p_fields -> 'detect_counts' ELSE j.detect_counts END,
         preflight_ref = COALESCE(p_fields ->> 'preflight_ref', j.preflight_ref),
         est_cost_usd = COALESCE((p_fields ->> 'est_cost_usd')::numeric, j.est_cost_usd),
         embedding_profile = COALESCE(p_fields ->> 'embedding_profile', j.embedding_profile),
         document_id = CASE
           WHEN j.document_id IS NULL AND p_fields ? 'document_id'
           THEN (p_fields ->> 'document_id')::uuid
           ELSE j.document_id
         END,
         needs_review_reason = COALESCE(p_fields ->> 'needs_review_reason', j.needs_review_reason),
         routing_note = COALESCE(p_fields ->> 'routing_note', j.routing_note),
         provisional_published_at = CASE
           WHEN p_fields ? 'provisional_published_at'
           THEN (p_fields ->> 'provisional_published_at')::timestamptz
           ELSE j.provisional_published_at
         END,
         trace_id = CASE WHEN p_fields ? 'trace_id' THEN (p_fields ->> 'trace_id')::uuid ELSE j.trace_id END,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  v_terminal := p_status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate');
  IF v_terminal THEN
    PERFORM rag_release_job_reservations(p_job_id);
    UPDATE ingestion_jobs
       SET locked_by = NULL, lease_until = NULL, runner = NULL
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    v_mirror := rag_ingest_mirror_processing_status(v_job.status);
    IF v_mirror IS NOT NULL THEN
      UPDATE documents d
         SET processing_status = v_mirror
       WHERE d.id = v_job.document_id
         AND d.tenant_key = v_job.tenant_key;
    END IF;
    IF p_status = 'ready' THEN
      UPDATE documents d SET status = 'ready' WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    ELSIF p_status IN ('failed', 'quarantined') THEN
      UPDATE documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'needs_review' THEN
      UPDATE documents d
         SET status = 'ready',
             needs_review = true,
             needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    END IF;
  END IF;

  PERFORM rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_record_parse_attempt(
  p_job_id uuid,
  p_worker text,
  p_attempt jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_attempts jsonb;
  v_no integer;
  v_reason text;
  v_cost numeric;
BEGIN
  IF p_attempt IS NULL OR jsonb_typeof(p_attempt) <> 'object' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_attempt' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM rag_ingest_assert_job_lease(v_job, p_worker);

  v_attempts := COALESCE(v_job.attempts, '[]'::jsonb);
  v_no := jsonb_array_length(v_attempts) + 1;
  v_attempts := v_attempts || jsonb_build_array(p_attempt || jsonb_build_object('attempt_no', v_no));
  v_reason := p_attempt ->> 'reason';
  v_cost := COALESCE((p_attempt ->> 'est_cost')::numeric, 0);

  UPDATE ingestion_jobs j
     SET attempts = v_attempts,
         escalations = j.escalations + CASE WHEN v_reason = 'escalation' THEN 1 ELSE 0 END,
         est_cost_usd = COALESCE(j.est_cost_usd, 0) + v_cost,
         updated_at = now()
   WHERE j.id = p_job_id;

  RETURN v_no;
END;
$$;

-- ---------------------------------------------------------------------------
-- Fail, admin retry/delete, reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_fail_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_error_class text,
  p_retryable boolean
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_terminal boolean;
BEGIN
  IF p_error_class IS NULL OR btrim(p_error_class) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_error_class' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM rag_ingest_assert_job_lease(v_job, p_worker);

  v_new_retries := v_job.retries + 1;
  v_terminal := (NOT p_retryable) OR v_new_retries > v_job.max_retries;

  IF v_terminal THEN
    PERFORM rag_release_job_reservations(p_job_id);
    UPDATE ingestion_jobs j
       SET status = 'failed',
           error_class = p_error_class,
           retries = v_new_retries,
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           run_after = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
    IF v_job.document_id IS NOT NULL THEN
      UPDATE documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    END IF;
  ELSE
    PERFORM rag_release_job_reservations(p_job_id);
    UPDATE ingestion_jobs j
       SET status = 'queued',
           error_class = p_error_class,
           retries = v_new_retries,
           run_after = now() + (30 * power(2::numeric, j.retries)) * interval '1 second',
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
  END IF;

  PERFORM rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_retry_ingestion_job(p_job_id uuid, p_actor uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
BEGIN
  v_keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.status NOT IN ('failed', 'needs_review') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_retry' USING ERRCODE = '22023';
  END IF;

  UPDATE ingestion_jobs j
     SET status = 'queued',
         retries = 0,
         run_after = NULL,
         error_class = NULL,
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'retry_ingestion_job',
    COALESCE(v_job.document_id, v_job.id),
    v_job.lineage_id,
    v_job.tenant_key,
    v_job.version,
    p_actor,
    ARRAY[]::text[]
  );

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_delete_ingestion_job(p_job_id uuid, p_actor uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc documents%ROWTYPE;
BEGIN
  v_keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    SELECT * INTO v_doc FROM documents d WHERE d.id = v_job.document_id FOR UPDATE;
    IF FOUND AND v_doc.is_current THEN
      RAISE EXCEPTION 'ingest_refused: document_is_current' USING ERRCODE = '22023';
    END IF;
    IF FOUND AND NOT v_doc.is_current THEN
      UPDATE documents d SET superseded_by = NULL WHERE d.superseded_by = v_doc.id;
      DELETE FROM document_chunks c WHERE c.document_id = v_doc.id;
      DELETE FROM documents d WHERE d.id = v_doc.id;
    END IF;
  END IF;

  UPDATE ingestion_jobs j
     SET deleted_at = now(),
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'delete_ingestion_job',
    COALESCE(v_job.document_id, COALESCE(v_doc.id, v_job.id)),
    v_job.lineage_id,
    v_job.tenant_key,
    v_job.version,
    p_actor,
    ARRAY[]::text[]
  );

  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job(p_job_id uuid, p_tenant_key text)
RETURNS public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rag_get_job_for_document(p_document_id uuid, p_tenant_key text)
RETURNS public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.document_id = p_document_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   ORDER BY j.created_at DESC
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job_internal(p_job_id uuid)
RETURNS public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.* FROM ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rag_list_ingestion_jobs(
  p_tenant_key text DEFAULT NULL,
  p_statuses text[] DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.deleted_at IS NULL
     AND (p_tenant_key IS NULL OR j.tenant_key = p_tenant_key)
     AND (p_kind IS NULL OR j.kind = p_kind)
     AND (p_statuses IS NULL OR j.status = ANY (p_statuses))
   ORDER BY j.created_at DESC, j.id DESC
   LIMIT GREATEST(COALESCE(p_limit, 50), 0)
   OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

-- The Realtime read policy (rag_ingest_broadcast_read) is created by the mode file, right after the topic rule it calls.

REVOKE ALL ON FUNCTION rag_ingest_job_status_for_stage(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_mirror_processing_status(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_assert_job_lease(public.ingestion_jobs, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_ingest_broadcast_job(public.ingestion_jobs) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_ingest_job_status_for_stage(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_mirror_processing_status(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_assert_job_lease(public.ingestion_jobs, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_ingest_broadcast_job(public.ingestion_jobs) TO service_role;

REVOKE ALL ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_record_parse_attempt(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_fail_ingestion_job(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_delete_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_get_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_get_job_for_document(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_get_ingestion_job_internal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_list_ingestion_jobs(text, text[], text, integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_record_parse_attempt(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_fail_ingestion_job(uuid, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_delete_ingestion_job(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_get_ingestion_job(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_get_job_for_document(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_get_ingestion_job_internal(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_list_ingestion_jobs(text, text[], text, integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- >>> supabase/migrations/0353_ingestion_transitions.multi-tenant.sql
-- 0353 (multi-tenant): Realtime topic allow-list for own user topic and member organization topics.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_ingest_realtime_topic_allowed(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_org uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_topic IS NULL OR btrim(p_topic) = '' THEN
    RETURN false;
  END IF;
  IF p_topic = 'rag-ingest:u:' || v_uid::text THEN
    RETURN true;
  END IF;
  IF p_topic ~ '^rag-ingest:o:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    BEGIN
      v_org := (regexp_match(p_topic, '^rag-ingest:o:([0-9a-f-]{36})$'))[1]::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN false;
    END;
    RETURN is_org_member(v_org, v_uid);
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_ingest_realtime_topic_allowed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_ingest_realtime_topic_allowed(text) TO authenticated, service_role;

-- Realtime read policy (no-op when realtime.messages is absent). It calls the topic rule above, so it is created here, after it.
DO $policy$
BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN
    RETURN;
  END IF;
  DROP POLICY IF EXISTS rag_ingest_broadcast_read ON realtime.messages;
  CREATE POLICY rag_ingest_broadcast_read ON realtime.messages
    FOR SELECT TO authenticated
    USING (
      extension = 'broadcast'
      AND public.rag_ingest_realtime_topic_allowed((SELECT realtime.topic()))
    );
END
$policy$;

COMMIT;

-- >>> supabase/migrations/0354_parse_budget.sql
-- 0354: Atomic premium-page budget (reserve, settle, release), batch USD budget, monthly usage read, and deployment tier overrides.

BEGIN;

ALTER TABLE rag_admin_audit DROP CONSTRAINT IF EXISTS rag_admin_audit_action_check;
ALTER TABLE rag_admin_audit ADD CONSTRAINT rag_admin_audit_action_check CHECK (
  action IN (
    'release_quarantine',
    'delete_quarantined',
    'retry_ingestion_job',
    'delete_ingestion_job',
    'set_parse_tier_override'
  )
);

-- ---------------------------------------------------------------------------
-- Parse budget (D-17, D-19, D-32, A-6)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_reserve_parse_budget(
  p_job_id uuid,
  p_attempt_no integer,
  p_pages integer,
  p_kind text,
  p_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant text;
  v_month date;
  v_reserved integer;
  v_row public.rag_parse_budget_usage%ROWTYPE;
BEGIN
  IF p_pages IS NULL OR p_pages <= 0 THEN
    RETURN false;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 0 OR p_pages > p_limit THEN
    RETURN false;
  END IF;

  SELECT j.tenant_key INTO v_tenant FROM ingestion_jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_budget_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM rag_ingest_assert_tenant_key(v_tenant);

  v_month := date_trunc('month', now() AT TIME ZONE 'UTC')::date;

  IF EXISTS (
    SELECT 1 FROM rag_parse_budget_reservations r
    WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind AND r.state = 'open'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO rag_parse_budget_usage AS u (tenant_key, month, pages_reserved)
  VALUES (v_tenant, v_month, p_pages)
  ON CONFLICT (tenant_key, month) DO UPDATE
     SET pages_reserved = u.pages_reserved + EXCLUDED.pages_reserved
   WHERE u.pages_reserved + u.pages_used + u.vlm_pages_used + EXCLUDED.pages_reserved <= p_limit
  RETURNING u.* INTO v_row;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO rag_parse_budget_reservations (job_id, attempt_no, tenant_key, month, pages, kind, state)
  VALUES (p_job_id, p_attempt_no, v_tenant, v_month, p_pages, p_kind, 'open');

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_settle_parse_budget(
  p_job_id uuid,
  p_attempt_no integer,
  p_kind text,
  p_pages_used integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.rag_parse_budget_reservations%ROWTYPE;
  v_used integer;
BEGIN
  IF p_pages_used IS NULL OR p_pages_used < 0 THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_pages' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO rec
    FROM rag_parse_budget_reservations r
   WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind
   FOR UPDATE;

  IF NOT FOUND OR rec.state = 'released' THEN
    RETURN false;
  END IF;
  IF rec.state = 'settled' THEN
    RETURN true;
  END IF;

  v_used := GREATEST(0, LEAST(p_pages_used, rec.pages));

  UPDATE rag_parse_budget_reservations SET state = 'settled' WHERE id = rec.id;

  UPDATE rag_parse_budget_usage u
     SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages),
         pages_used = u.pages_used + CASE WHEN p_kind = 'parse' THEN v_used ELSE 0 END,
         vlm_pages_used = u.vlm_pages_used + CASE WHEN p_kind = 'vlm' THEN v_used ELSE 0 END
   WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_release_parse_budget(
  p_job_id uuid,
  p_attempt_no integer,
  p_kind text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.rag_parse_budget_reservations%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO rec
    FROM rag_parse_budget_reservations r
   WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind
   FOR UPDATE;

  IF NOT FOUND OR rec.state = 'released' THEN
    RETURN false;
  END IF;
  IF rec.state = 'settled' THEN
    RETURN true;
  END IF;

  UPDATE rag_parse_budget_reservations SET state = 'released' WHERE id = rec.id;

  UPDATE rag_parse_budget_usage u
     SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages)
   WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_reserve_batch_budget(p_job_id uuid, p_usd numeric)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch uuid;
  v_updated uuid;
BEGIN
  IF p_usd IS NULL OR p_usd < 0 THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_usd' USING ERRCODE = '22023';
  END IF;

  SELECT j.batch_id INTO v_batch FROM ingestion_jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_budget_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_batch IS NULL THEN
    RETURN true;
  END IF;

  UPDATE ingestion_batches b
     SET spent_usd = b.spent_usd + p_usd,
         updated_at = now()
   WHERE b.id = v_batch
     AND b.budget_usd IS NOT NULL
     AND b.spent_usd + p_usd <= b.budget_usd
  RETURNING b.id INTO v_updated;

  RETURN v_updated IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_budget_month(p_tenant_key text DEFAULT NULL)
RETURNS TABLE (
  tenant_key text,
  month date,
  pages_reserved integer,
  pages_used integer,
  vlm_pages_used integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.tenant_key, u.month, u.pages_reserved, u.pages_used, u.vlm_pages_used
    FROM rag_parse_budget_usage u
   WHERE u.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     AND (p_tenant_key IS NULL OR u.tenant_key = p_tenant_key)
   ORDER BY u.tenant_key;
$$;

-- ---------------------------------------------------------------------------
-- Tier overrides (D-13)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_parse_doc_type_ok(p_doc_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p_doc_type = ANY (ARRAY[
    'general',
    'financial_report',
    'contract_legal',
    'invoice_receipt',
    'product_technical',
    'scanned_image'
  ]::text[]);
$$;

CREATE OR REPLACE FUNCTION public.rag_get_parse_tier_overrides()
RETURNS TABLE (
  doc_type text,
  min_tier text,
  max_tier text,
  updated_by text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.doc_type, o.min_tier, o.max_tier, o.updated_by, o.updated_at
    FROM rag_parse_tier_overrides o
   ORDER BY o.doc_type;
$$;

CREATE OR REPLACE FUNCTION public.rag_set_parse_tier_override(
  p_doc_type text,
  p_min_tier text,
  p_max_tier text,
  p_actor uuid
)
RETURNS public.rag_parse_tier_overrides
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.rag_parse_tier_overrides%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'parse_tier_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  IF NOT rag_parse_doc_type_ok(p_doc_type) THEN
    RAISE EXCEPTION 'parse_tier_refused: invalid_doc_type' USING ERRCODE = '22023';
  END IF;

  IF p_min_tier IS NULL AND p_max_tier IS NULL THEN
    DELETE FROM rag_parse_tier_overrides WHERE doc_type = p_doc_type;
    INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
    VALUES (
      'set_parse_tier_override',
      '00000000-0000-4000-8000-000000000000',
      NULL,
      's:default',
      NULL,
      p_actor,
      ARRAY[p_doc_type, 'deleted']
    );
    RETURN NULL;
  END IF;

  IF p_min_tier IS NULL OR p_max_tier IS NULL
     OR p_min_tier NOT IN ('native', 'fast', 'structured', 'premium')
     OR p_max_tier NOT IN ('native', 'fast', 'structured', 'premium')
     OR rag_parse_tier_rank(p_min_tier) > rag_parse_tier_rank(p_max_tier) THEN
    RAISE EXCEPTION 'parse_tier_refused: invalid_bounds' USING ERRCODE = '22023';
  END IF;

  INSERT INTO rag_parse_tier_overrides AS o (doc_type, min_tier, max_tier, updated_by, updated_at)
  VALUES (p_doc_type, p_min_tier, p_max_tier, p_actor::text, now())
  ON CONFLICT (doc_type) DO UPDATE
     SET min_tier = EXCLUDED.min_tier,
         max_tier = EXCLUDED.max_tier,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at
  RETURNING o.* INTO v_row;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'set_parse_tier_override',
    '00000000-0000-4000-8000-000000000000',
    NULL,
    's:default',
    NULL,
    p_actor,
    ARRAY[p_doc_type, p_min_tier, p_max_tier]
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_reserve_parse_budget(uuid, integer, integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_settle_parse_budget(uuid, integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_release_parse_budget(uuid, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_reserve_batch_budget(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_budget_month(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_doc_type_ok(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_get_parse_tier_overrides() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_set_parse_tier_override(text, text, text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rag_reserve_parse_budget(uuid, integer, integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_settle_parse_budget(uuid, integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_release_parse_budget(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_reserve_batch_budget(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_budget_month(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_doc_type_ok(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_get_parse_tier_overrides() TO service_role;
GRANT EXECUTE ON FUNCTION rag_set_parse_tier_override(text, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- >>> supabase/migrations/0355_parse_cache.sql
-- 0355: tenant-scoped parse cache RPCs keyed through ingestion_jobs (D-20, F-12, A-6).

BEGIN;

CREATE OR REPLACE FUNCTION rag_parse_cache_version_segment(p_parser_version text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT left(encode(sha256(convert_to(p_parser_version, 'UTF8')), 'hex'), 16);
$$;

CREATE OR REPLACE FUNCTION rag_parse_cache_assert_key_parts(p_parser text, p_options_hash text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_parser IS NULL OR p_parser !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_parser' USING ERRCODE = '22023';
  END IF;
  IF p_options_hash IS NULL OR p_options_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_options_hash' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_prefix(
  p_job_id uuid,
  p_parser text,
  p_parser_version text,
  p_options_hash text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
  v_segment text;
BEGIN
  PERFORM rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
  RETURN NULL;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_segment := rag_parse_cache_version_segment(p_parser_version);
  RETURN v_job.tenant_key
    || '/_parse-cache/'
    || v_job.file_sha256
    || '/'
    || p_parser
    || '-'
    || v_segment
    || '-'
    || p_options_hash
    || '/';
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_lookup(
  p_job_id uuid,
  p_parser text,
  p_parser_version text,
  p_options_hash text
)
RETURNS SETOF public.rag_parse_cache
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
BEGIN
  PERFORM rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT c.*
    FROM rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_put(
  p_job_id uuid,
  p_parser text,
  p_parser_version text,
  p_options_hash text,
  p_object_prefix text,
  p_result jsonb DEFAULT '{}'::jsonb,
  p_byte_size bigint DEFAULT NULL
)
RETURNS public.rag_parse_cache
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
  v_expected text;
  v_row public.rag_parse_cache%ROWTYPE;
BEGIN
  PERFORM rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_expected := rag_parse_cache_prefix(p_job_id, p_parser, p_parser_version, p_options_hash);
  IF p_object_prefix IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'parse_cache_refused: prefix_mismatch' USING ERRCODE = '22023';
  END IF;
  INSERT INTO rag_parse_cache (
    tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix, result, byte_size
  )
  VALUES (
    v_job.tenant_key, v_job.file_sha256, p_parser, p_parser_version, p_options_hash, p_object_prefix,
    COALESCE(p_result, '{}'::jsonb), p_byte_size
  )
  ON CONFLICT (tenant_key, file_sha256, parser, parser_version, options_hash) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN v_row;
  END IF;
  SELECT c.* INTO v_row
    FROM rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_set_document_parse_cache(
  p_job_id uuid,
  p_cache_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job record;
  v_cache record;
  v_doc_tenant text;
BEGIN
  SELECT j.tenant_key, j.document_id INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.document_id IS NULL THEN
    RAISE EXCEPTION 'parse_cache_refused: document_not_linked' USING ERRCODE = '22023';
  END IF;
  SELECT c.id, c.tenant_key INTO v_cache FROM rag_parse_cache c WHERE c.id = p_cache_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_cache.tenant_key IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT d.tenant_key INTO v_doc_tenant FROM documents d WHERE d.id = v_job.document_id;
  IF v_doc_tenant IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: document_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  UPDATE documents d SET parse_cache_id = p_cache_id
   WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_for_document(
  p_tenant_key text,
  p_document_id uuid
)
RETURNS SETOF public.rag_parse_cache
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM rag_ingest_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT c.*
    FROM documents d
    JOIN rag_parse_cache c ON c.id = d.parse_cache_id
   WHERE d.id = p_document_id
     AND d.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key;
END;
$$;

REVOKE ALL ON FUNCTION rag_parse_cache_version_segment(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_parse_cache_assert_key_parts(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_prefix(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_lookup(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_put(uuid, text, text, text, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_set_document_parse_cache(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_parse_cache_for_document(text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rag_parse_cache_version_segment(text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_parse_cache_assert_key_parts(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_prefix(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_lookup(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_put(uuid, text, text, text, text, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_set_document_parse_cache(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_parse_cache_for_document(text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- >>> supabase/migrations/0356_backfill.sql
-- 0356: Backfill batch helpers — create batch, bulk enqueue, dedupe lookup, monitor and embed-batch tracking (Phase 3.1 plan 20).

BEGIN;

-- ---------------------------------------------------------------------------
-- Create a backfill batch row (validated tenant)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_create_ingestion_batch(
  p_tenant_key text,
  p_source_kind text,
  p_source_ref text,
  p_budget_usd numeric DEFAULT NULL,
  p_concurrency integer DEFAULT 1,
  p_runner text DEFAULT 'worker',
  p_created_by text DEFAULT NULL
)
RETURNS public.ingestion_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ingestion_batches%ROWTYPE;
BEGIN
  PERFORM rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_source_kind IS NULL OR p_source_kind NOT IN ('folder', 'bucket', 'manifest') THEN
    RAISE EXCEPTION 'backfill_refused: invalid_source_kind' USING ERRCODE = '22023';
  END IF;
  IF p_source_ref IS NULL OR btrim(p_source_ref) = '' THEN
    RAISE EXCEPTION 'backfill_refused: invalid_source_ref' USING ERRCODE = '22023';
  END IF;
  IF p_concurrency IS NULL OR p_concurrency < 1 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_concurrency' USING ERRCODE = '22023';
  END IF;
  IF p_runner IS NULL OR p_runner NOT IN ('worker', 'ray') THEN
    RAISE EXCEPTION 'backfill_refused: invalid_runner' USING ERRCODE = '22023';
  END IF;
  IF p_budget_usd IS NOT NULL AND p_budget_usd < 0 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_budget' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ingestion_batches (
    tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, created_by, status
  ) VALUES (
    p_tenant_key, p_source_kind, p_source_ref, p_budget_usd, p_concurrency, p_runner, p_created_by, 'pending'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_create_ingestion_batch(text, text, text, numeric, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_create_ingestion_batch(text, text, text, numeric, integer, text, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Bulk enqueue backfill jobs (re-entrant; inherits batch tenant; priority 10)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_enqueue_backfill_jobs(p_batch_id uuid, p_jobs jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant text;
  v_job jsonb;
  v_kind text;
  v_status text;
  v_inserted integer := 0;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.tenant_key INTO v_tenant FROM ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_jobs IS NULL OR jsonb_typeof(p_jobs) <> 'array' THEN
  RAISE EXCEPTION 'backfill_refused: jobs_must_be_array' USING ERRCODE = '22023';
  END IF;

  FOR v_job IN SELECT value FROM jsonb_array_elements(p_jobs) AS e(value) LOOP
    IF jsonb_typeof(v_job) <> 'object' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_job_object' USING ERRCODE = '22023';
    END IF;

    v_kind := v_job ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('ingest', 'dry_run') THEN
      RAISE EXCEPTION 'backfill_refused: invalid_kind' USING ERRCODE = '22023';
    END IF;
    IF v_job ->> 'source_key' IS NULL OR btrim(v_job ->> 'source_key') = '' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_source_key' USING ERRCODE = '22023';
    END IF;

    v_status := COALESCE(v_job ->> 'status', 'queued');
    IF v_status NOT IN (
      'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
      'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
    ) THEN
      RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
    END IF;

    INSERT INTO ingestion_jobs (
      tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
      original_ref, settings, priority, batch_id, document_id
    ) VALUES (
      v_tenant,
      v_kind,
      v_status,
      NULLIF(v_job ->> 'source', ''),
      v_job ->> 'source_key',
      NULLIF(v_job ->> 'file_sha256', ''),
      NULLIF(v_job ->> 'filename', ''),
      NULLIF(v_job ->> 'mime_type', ''),
      CASE WHEN v_job ? 'original_ref' THEN v_job -> 'original_ref' ELSE NULL END,
      COALESCE(v_job -> 'settings', '{}'::jsonb),
      10,
      p_batch_id,
      NULL
    )
    ON CONFLICT (batch_id, kind, source_key) WHERE batch_id IS NOT NULL DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Tenant-scoped hash dedupe lookup (at most 1,000 hashes per call)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_existing_file_hashes(
  p_tenant_key text,
  p_hashes text[]
)
RETURNS TABLE (id uuid, file_sha256 text, tenant_key text, source_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_hashes IS NULL OR array_length(p_hashes, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_hashes, 1) > 1000 THEN
    RAISE EXCEPTION 'backfill_refused: too_many_hashes' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT d.id, d.file_sha256, d.tenant_key, d.source_key
    FROM documents d
   WHERE d.tenant_key = p_tenant_key
     AND d.is_current
     AND d.status = 'ready'
     AND d.file_sha256 IS NOT NULL
     AND d.file_sha256 = ANY (p_hashes)
   ORDER BY d.created_at, d.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_existing_file_hashes(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_existing_file_hashes(text, text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Batch progress (counts by kind and status, leased jobs, spent USD)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_batch_progress(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_spent numeric;
  v_leased integer;
  v_counts jsonb := '{}'::jsonb;
  rec record;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.spent_usd INTO v_spent FROM ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_leased
    FROM ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();

  FOR rec IN
    SELECT j.kind, j.status, count(*)::integer AS n
      FROM ingestion_jobs j
     WHERE j.batch_id = p_batch_id AND j.deleted_at IS NULL
     GROUP BY j.kind, j.status
     ORDER BY j.kind, j.status
  LOOP
    IF NOT v_counts ? rec.kind THEN
      v_counts := jsonb_set(v_counts, ARRAY[rec.kind], '{}'::jsonb, true);
    END IF;
    v_counts := jsonb_set(v_counts, ARRAY[rec.kind, rec.status], to_jsonb(rec.n), true);
  END LOOP;

  RETURN jsonb_build_object(
    'spent_usd', COALESCE(v_spent, 0),
    'leased', COALESCE(v_leased, 0),
    'counts', v_counts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rag_batch_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_batch_progress(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Update batch status / dry-run report / totals
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_update_ingestion_batch(
  p_batch_id uuid,
  p_status text DEFAULT NULL,
  p_dry_run_report jsonb DEFAULT NULL,
  p_totals jsonb DEFAULT NULL
)
RETURNS public.ingestion_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ingestion_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  IF p_status IS NOT NULL AND p_status NOT IN (
    'pending', 'sampling', 'running', 'completed', 'failed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE ingestion_batches b
     SET status = COALESCE(p_status, b.status),
         dry_run_report = COALESCE(p_dry_run_report, b.dry_run_report),
         totals = COALESCE(p_totals, b.totals),
         updated_at = now()
   WHERE b.id = p_batch_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_update_ingestion_batch(uuid, text, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Page batch jobs for monitor / Ray runner (status filter, keyset on id)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_list_batch_jobs(
  p_batch_id uuid,
  p_status text DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_after_created_at timestamptz;
  v_after_id uuid;
  v_limit integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 100), 1000), 1);

  IF p_status IS NOT NULL AND p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_after_id IS NOT NULL THEN
    SELECT j.created_at, j.id INTO v_after_created_at, v_after_id
      FROM ingestion_jobs j
     WHERE j.id = p_after_id AND j.batch_id = p_batch_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backfill_refused: invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN QUERY
  SELECT j.*
    FROM ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND (p_status IS NULL OR j.status = p_status)
     AND (
       p_after_id IS NULL
       OR j.created_at > v_after_created_at
       OR (j.created_at = v_after_created_at AND j.id > v_after_id)
     )
   ORDER BY j.created_at, j.id
   LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- OpenAI embed-batch tracking (D-35)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rag_record_embed_batch(
  p_batch_id uuid,
  p_profile_id text,
  p_provider text,
  p_provider_batch_id text DEFAULT NULL,
  p_input_file_id text DEFAULT NULL,
  p_input_count integer DEFAULT 0,
  p_status text DEFAULT 'pending'
)
RETURNS public.rag_embed_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.rag_embed_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ingestion_batches b WHERE b.id = p_batch_id) THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM embedding_profiles ep WHERE ep.id = p_profile_id) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_profile' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS NULL OR btrim(p_provider) = '' THEN
    RAISE EXCEPTION 'backfill_refused: invalid_provider' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
    'expired', 'cancelling', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_input_count IS NULL OR p_input_count < 0 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_input_count' USING ERRCODE = '22023';
  END IF;

  INSERT INTO rag_embed_batches (
    batch_id, profile_id, provider, provider_batch_id, input_file_id, input_count, status
  ) VALUES (
    p_batch_id, p_profile_id, p_provider, p_provider_batch_id, p_input_file_id, COALESCE(p_input_count, 0), p_status
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_record_embed_batch(uuid, text, text, text, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_record_embed_batch(uuid, text, text, text, text, integer, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.rag_update_embed_batch(
  p_embed_batch_id uuid,
  p_status text,
  p_provider_batch_id text DEFAULT NULL,
  p_output_file_id text DEFAULT NULL,
  p_error_file_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS public.rag_embed_batches
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.rag_embed_batches%ROWTYPE;
BEGIN
  IF p_embed_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_embed_batch' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
    'expired', 'cancelling', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE rag_embed_batches e
     SET status = p_status,
         provider_batch_id = COALESCE(p_provider_batch_id, e.provider_batch_id),
         output_file_id = COALESCE(p_output_file_id, e.output_file_id),
         error_file_id = COALESCE(p_error_file_id, e.error_file_id),
         error = COALESCE(p_error, e.error),
         updated_at = now()
   WHERE e.id = p_embed_batch_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: embed_batch_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_update_embed_batch(uuid, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_open_embed_batches(p_batch_id uuid)
RETURNS SETOF public.rag_embed_batches
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
    FROM rag_embed_batches e
   WHERE e.batch_id = p_batch_id
     AND e.status NOT IN ('completed', 'cancelled')
   ORDER BY e.created_at, e.id;
$$;

REVOKE ALL ON FUNCTION public.rag_open_embed_batches(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_open_embed_batches(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- >>> supabase/migrations/0357_soft_delete.sql
-- 0357: Soft-delete a document lineage at the source (D-27). Rows are kept for citations; retrieval drops them via is_current/status.
-- The RET-05 outbox and semantic-cache invalidation read this function later; neither is wired here.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_soft_delete_document(
  p_tenant_key text,
  p_lineage_id uuid,
  p_source text
)
RETURNS TABLE (outcome text, lineage_id uuid, job_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_count integer;
  v_has_current boolean;
  v_source_key text;
  v_doc_id uuid;
  v_job_id uuid;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_lineage_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR p_source NOT IN (
    'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag'
  ) THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_count
    FROM public.documents d
   WHERE d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.documents d
     WHERE d.lineage_id = p_lineage_id
       AND d.tenant_key = p_tenant_key
       AND d.source = p_source
       AND (d.is_current OR d.status <> 'deleted')
  ) INTO v_has_current;

  IF NOT v_has_current THEN
    RETURN QUERY SELECT 'already_deleted'::text, p_lineage_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.id, d.source_key INTO v_doc_id, v_source_key
    FROM public.documents d
   WHERE d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source
   ORDER BY d.is_current DESC, d.version DESC NULLS LAST
   LIMIT 1;

  UPDATE public.documents d
     SET is_current = false,
         status = 'deleted'
   WHERE d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source;

  UPDATE public.document_chunks c
     SET is_current = false,
         status = 'deleted',
         embedding = NULL
    FROM public.documents d
   WHERE c.document_id = d.id
     AND d.lineage_id = p_lineage_id
     AND d.tenant_key = p_tenant_key
     AND d.source = p_source;

  INSERT INTO public.ingestion_jobs (
    tenant_key, kind, status, source, source_key, lineage_id, document_id
  ) VALUES (
    p_tenant_key, 'delete', 'ready', p_source, COALESCE(v_source_key, p_lineage_id::text), p_lineage_id, v_doc_id
  )
  RETURNING id INTO v_job_id;

  RETURN QUERY SELECT 'deleted'::text, p_lineage_id, v_job_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_soft_delete_document(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_soft_delete_document(text, uuid, text) TO service_role;

COMMIT;

-- >>> supabase/migrations/0358_progressive.sql
-- 0358: Progressive mode (D-30, A-9, F-10). A progressive job publishes the whole document parsed with the fast preset as a normal
-- version flagged provisional, then publishes the routed result as the next version through the Phase 3 swap. Three functions, each
-- resolving the tenant from the job row (A-6), SECURITY DEFINER with an empty search_path, executable by service_role only:
--   rag_mark_provisional: after the fast version was published, flags it and its chunks provisional, sets provisional_published_at
--     and puts the job back at parse for the routed run. Only an incremental ingest job whose snapshot has progressive on qualifies.
--   rag_begin_progressive_final: points the job at the processing version the routed run writes (same lineage, newer, not current).
--   rag_clear_provisional: the routed text equals the provisional text (a duplicate of the same lineage counts as unchanged): clears
--     the flags of the lineage's current version and its chunks in place and points the job back at that version. No new version.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_mark_provisional(p_job_id uuid, p_worker text)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);
  IF v_job.provisional_published_at IS NOT NULL THEN
    RETURN v_job;
  END IF;
  IF v_job.kind <> 'ingest' OR v_job.batch_id IS NOT NULL
     OR COALESCE((v_job.settings ->> 'progressive')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'ingest_refused: provisional_not_allowed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_doc FROM public.documents d
   WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key
   FOR UPDATE;
  IF NOT FOUND OR NOT v_doc.is_current OR v_doc.status <> 'ready' THEN
    RAISE EXCEPTION 'ingest_refused: version_not_published' USING ERRCODE = '22023';
  END IF;

  UPDATE public.documents d SET provisional = true, processing_status = 'ready' WHERE d.id = v_doc.id;
  UPDATE public.document_chunks c SET provisional = true WHERE c.document_id = v_doc.id;

  UPDATE public.ingestion_jobs j
     SET provisional_published_at = now(),
         stage = 'parse',
         status = 'parsing',
         stage_state = '{}'::jsonb,
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_begin_progressive_final(p_job_id uuid, p_worker text, p_document_id uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_current public.documents%ROWTYPE;
  v_next public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);
  IF v_job.provisional_published_at IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: not_provisional' USING ERRCODE = '22023';
  END IF;
  IF v_job.document_id = p_document_id THEN
    RETURN v_job;
  END IF;

  SELECT * INTO v_current FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_next FROM public.documents d
   WHERE d.id = p_document_id
     AND d.tenant_key = v_job.tenant_key
     AND d.lineage_id = v_current.lineage_id
     AND d.version > v_current.version
     AND d.status = 'processing'
     AND NOT d.is_current;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: version_not_allowed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ingestion_jobs j SET document_id = v_next.id, updated_at = now() WHERE j.id = v_job.id RETURNING j.* INTO v_job;
  UPDATE public.documents d SET processing_status = public.rag_ingest_mirror_processing_status(v_job.status) WHERE d.id = v_next.id;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_clear_provisional(p_job_id uuid)
RETURNS TABLE (document_id uuid, version integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_lineage uuid;
  v_current public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.provisional_published_at IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: not_provisional' USING ERRCODE = '22023';
  END IF;

  SELECT d.lineage_id INTO v_lineage FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
  IF v_lineage IS NULL THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_current FROM public.documents d
   WHERE d.tenant_key = v_job.tenant_key AND d.lineage_id = v_lineage AND d.is_current
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: no_current_version' USING ERRCODE = '22023';
  END IF;

  UPDATE public.documents d SET provisional = false WHERE d.id = v_current.id;
  UPDATE public.document_chunks c SET provisional = false WHERE c.document_id = v_current.id;
  UPDATE public.ingestion_jobs j SET document_id = v_current.id, updated_at = now() WHERE j.id = v_job.id;

  RETURN QUERY SELECT v_current.id, v_current.version;
END;
$$;

REVOKE ALL ON FUNCTION rag_mark_provisional(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_begin_progressive_final(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_clear_provisional(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_mark_provisional(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_begin_progressive_final(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_clear_provisional(uuid) TO service_role;

COMMIT;

-- >>> supabase/migrations/0359_vectors_complete.sql
-- 0359: Batch API embeddings for backfill jobs (D-35, D-36). With RAG_EMBED_BATCH_MODE=batch_api a backfill job on an OpenAI profile writes
-- its chunks without vectors and stops before publish (stage embed_deferred, lease released); the rag:backfill process embeds the chunks
-- through the OpenAI Batch API, writes the vectors and publishes the job. Publish refuses while a chunk lacks its active-profile vector.
--   rag_vectors_complete: true when every chunk of the version has a vector of the profile (tenant-checked).
--   rag_defer_ingestion_embed: the worker holding the lease parks a batch_api backfill job at embed_deferred and releases the lease.
--   rag_deferred_embed_chunks: the chunks of the batch's deferred jobs that lack a vector of a profile, keyset by chunk id.
--   rag_write_deferred_vectors: upserts vectors by chunk id, only for chunks of the batch's deferred jobs, only at the text version sent.
--   rag_publish_deferred_ingestion_job: vectors_incomplete unless complete, then the Phase 3 swap and the terminal ledger status.
--   rag_batch_progress: deferred jobs are counted under embed_deferred, so the monitor does not wait for them.
-- The tenant always comes from the job or batch row. SECURITY INVOKER (service_role bypasses RLS), empty search_path, service_role only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_vectors_complete(p_document_id uuid, p_profile_id text, p_tenant_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
BEGIN
  IF p_document_id IS NULL OR p_tenant_key IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023', DETAIL = 'document not found in tenant';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR (v_profile.storage = 'legacy_column' AND v_profile.id <> 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'embedding_profile_unsupported: %', p_profile_id USING ERRCODE = '22023';
  END IF;
  IF v_profile.storage = 'legacy_column' THEN
    RETURN NOT EXISTS (
      SELECT 1 FROM public.document_chunks c WHERE c.document_id = p_document_id AND c.embedding IS NULL
    );
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.document_chunks c
     WHERE c.document_id = p_document_id
       AND NOT EXISTS (
         SELECT 1 FROM public.chunk_embeddings e
          WHERE e.chunk_id = c.id AND e.profile_id = v_profile.id AND e.embedding_model = v_profile.model AND e.dims = v_profile.dims
       )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_defer_ingestion_embed(p_job_id uuid, p_worker text)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);
  IF v_job.kind <> 'ingest' OR v_job.batch_id IS NULL OR v_job.document_id IS NULL
     OR (v_job.settings ->> 'embed_mode') IS DISTINCT FROM 'batch_api' THEN
    RAISE EXCEPTION 'ingest_refused: defer_not_allowed' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_doc.is_current OR v_doc.status NOT IN ('processing', 'quarantined') THEN
    RAISE EXCEPTION 'ingest_refused: version_not_processing' USING ERRCODE = '22023';
  END IF;

  PERFORM public.rag_release_job_reservations(v_job.id);
  UPDATE public.ingestion_jobs j
     SET status = 'embedding',
         stage = 'embed_deferred',
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;
  UPDATE public.documents d SET processing_status = 'embedding' WHERE d.id = v_doc.id;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_deferred_embed_chunks(p_batch_id uuid, p_profile_id text, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  job_id uuid,
  tenant_key text,
  embedding_text_version integer,
  content text,
  section_path text[],
  chunk_kind text,
  doc_type text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_tenant text;
  v_profile public.embedding_profiles%ROWTYPE;
BEGIN
  SELECT b.tenant_key INTO v_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR (v_profile.storage = 'legacy_column' AND v_profile.id <> 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'embedding_profile_unsupported: %', p_profile_id USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.id, c.document_id, j.id, c.tenant_key, c.embedding_text_version, c.content, c.section_path, c.chunk_kind,
         COALESCE(c.doc_type, d.doc_type),
         jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency)
    FROM public.ingestion_jobs j
    JOIN public.documents d ON d.id = j.document_id AND d.tenant_key = j.tenant_key
    JOIN public.document_chunks c ON c.document_id = d.id AND c.tenant_key = d.tenant_key
   WHERE j.batch_id = p_batch_id
     AND j.tenant_key = v_tenant
     AND j.deleted_at IS NULL
     AND j.kind = 'ingest'
     AND j.status = 'embedding'
     AND j.stage = 'embed_deferred'
     AND (p_after IS NULL OR c.id > p_after)
     AND CASE
           WHEN v_profile.storage = 'legacy_column' THEN c.embedding IS NULL
           ELSE NOT EXISTS (
             SELECT 1 FROM public.chunk_embeddings e
              WHERE e.chunk_id = c.id AND e.profile_id = v_profile.id AND e.embedding_model = v_profile.model AND e.dims = v_profile.dims
           )
         END
   ORDER BY c.id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000);
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_write_deferred_vectors(p_batch_id uuid, p_profile_id text, p_rows jsonb)
RETURNS TABLE (written integer, skipped integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_tenant text;
  v_profile public.embedding_profiles%ROWTYPE;
  v_total integer;
  v_written integer := 0;
  v_ids uuid[];
BEGIN
  SELECT b.tenant_key INTO v_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR (v_profile.storage = 'legacy_column' AND v_profile.id <> 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'embedding_profile_unsupported: %', p_profile_id USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'invalid_rows: p_rows must be a JSON array' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_rows);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value)
     WHERE jsonb_typeof(r.value) <> 'object'
        OR jsonb_typeof(r.value -> 'chunk_id') IS DISTINCT FROM 'string'
        OR (r.value ->> 'chunk_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(r.value -> 'embedding_text_version') IS DISTINCT FROM 'number'
        OR jsonb_typeof(r.value -> 'embedding') IS DISTINCT FROM 'array'
        OR (r.value ? 'host' AND jsonb_typeof(r.value -> 'host') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_rows: every row needs chunk_id, embedding_text_version and embedding' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value) WHERE jsonb_array_length(r.value -> 'embedding') <> v_profile.dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  IF v_profile.storage = 'legacy_column' THEN
    WITH targets AS (
      SELECT DISTINCT ON (c.id) c.id AS chunk_id, r.value -> 'embedding' AS embedding
        FROM jsonb_array_elements(p_rows) AS r(value)
        JOIN public.document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
        JOIN public.ingestion_jobs j ON j.document_id = c.document_id AND j.tenant_key = c.tenant_key
       WHERE j.batch_id = p_batch_id AND j.tenant_key = v_tenant AND j.deleted_at IS NULL AND j.kind = 'ingest'
         AND j.status = 'embedding' AND j.stage = 'embed_deferred'
         AND c.embedding_text_version = (r.value ->> 'embedding_text_version')::integer
       ORDER BY c.id
    ), updated AS (
      UPDATE public.document_chunks c
         SET embedding = (t.embedding::text)::public.vector,
             metadata = COALESCE(c.metadata, '{}'::jsonb)
               || jsonb_build_object('embedding_model', v_profile.model, 'embedding_dims', v_profile.dims)
        FROM targets t
       WHERE c.id = t.chunk_id
      RETURNING c.id
    )
    SELECT array_agg(u.id) INTO v_ids FROM updated u;
  ELSE
    WITH targets AS (
      SELECT DISTINCT ON (c.id) c.id AS chunk_id, r.value -> 'embedding' AS embedding, r.value ->> 'host' AS host
        FROM jsonb_array_elements(p_rows) AS r(value)
        JOIN public.document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
        JOIN public.ingestion_jobs j ON j.document_id = c.document_id AND j.tenant_key = c.tenant_key
       WHERE j.batch_id = p_batch_id AND j.tenant_key = v_tenant AND j.deleted_at IS NULL AND j.kind = 'ingest'
         AND j.status = 'embedding' AND j.stage = 'embed_deferred'
         AND c.embedding_text_version = (r.value ->> 'embedding_text_version')::integer
       ORDER BY c.id
    ), inserted AS (
      INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
      SELECT t.chunk_id, v_profile.id, v_tenant, (t.embedding::text)::public.halfvec, v_profile.model, v_profile.dims, t.host
        FROM targets t
      ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
        embedding = EXCLUDED.embedding,
        embedding_model = EXCLUDED.embedding_model,
        dims = EXCLUDED.dims,
        embedding_host = EXCLUDED.embedding_host,
        embedded_at = now()
      RETURNING ce.chunk_id
    )
    SELECT array_agg(i.chunk_id) INTO v_ids FROM inserted i;
  END IF;
  v_written := COALESCE(array_length(v_ids, 1), 0);

  IF v_written > 0 THEN
    DELETE FROM public.embedding_backfill_gaps g WHERE g.profile_id = v_profile.id AND g.chunk_id = ANY (v_ids);
  END IF;

  RETURN QUERY SELECT v_written, v_total - v_written;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_publish_deferred_ingestion_job(p_job_id uuid, p_profile_id text)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_outcome text;
  v_status text;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.status IN ('ready', 'quarantined', 'needs_review') AND v_job.kind = 'ingest' AND v_job.batch_id IS NOT NULL THEN
    RETURN v_job;
  END IF;
  IF v_job.kind <> 'ingest' OR v_job.batch_id IS NULL OR v_job.status <> 'embedding' OR v_job.stage IS DISTINCT FROM 'embed_deferred'
     OR v_job.document_id IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: not_deferred' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR NOT (v_profile.status = 'active' OR v_profile.id = 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'ingest_refused: profile_not_active' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_doc.status <> 'quarantined' AND NOT public.rag_vectors_complete(v_doc.id, v_profile.id, v_job.tenant_key) THEN
    RAISE EXCEPTION 'vectors_incomplete' USING ERRCODE = '22023', DETAIL = 'a chunk lacks its active-profile vector';
  END IF;

  SELECT r.outcome INTO v_outcome FROM public.rag_publish_document_version(v_doc.id, v_job.tenant_key) AS r;
  v_status := CASE
    WHEN v_outcome = 'quarantined' THEN 'quarantined'
    WHEN v_job.needs_review_reason IS NOT NULL THEN 'needs_review'
    ELSE 'ready'
  END;

  PERFORM public.rag_release_job_reservations(v_job.id);
  UPDATE public.ingestion_jobs j
     SET status = v_status,
         stage = v_status,
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  UPDATE public.documents d
     SET processing_status = public.rag_ingest_mirror_processing_status(v_status)
   WHERE d.id = v_doc.id;
  IF v_status = 'needs_review' THEN
    UPDATE public.documents d
       SET status = 'ready', needs_review = true, needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
     WHERE d.id = v_doc.id;
  ELSIF v_status = 'quarantined' THEN
    UPDATE public.documents d SET status = 'failed', processing_status = 'failed' WHERE d.id = v_doc.id AND NOT d.is_current;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_batch_progress(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_spent numeric;
  v_leased integer;
  v_counts jsonb := '{}'::jsonb;
  rec record;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.spent_usd INTO v_spent FROM ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_leased
    FROM ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();

  FOR rec IN
    SELECT j.kind,
           CASE WHEN j.status = 'embedding' AND j.stage = 'embed_deferred' THEN 'embed_deferred' ELSE j.status END AS status,
           count(*)::integer AS n
      FROM ingestion_jobs j
     WHERE j.batch_id = p_batch_id AND j.deleted_at IS NULL
     GROUP BY 1, 2
     ORDER BY 1, 2
  LOOP
    IF NOT v_counts ? rec.kind THEN
      v_counts := jsonb_set(v_counts, ARRAY[rec.kind], '{}'::jsonb, true);
    END IF;
    v_counts := jsonb_set(v_counts, ARRAY[rec.kind, rec.status], to_jsonb(rec.n), true);
  END LOOP;

  RETURN jsonb_build_object(
    'spent_usd', COALESCE(v_spent, 0),
    'leased', COALESCE(v_leased, 0),
    'counts', v_counts
  );
END;
$$;

REVOKE ALL ON FUNCTION rag_vectors_complete(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_defer_ingestion_embed(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_deferred_embed_chunks(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_write_deferred_vectors(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_publish_deferred_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_batch_progress(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_vectors_complete(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_defer_ingestion_embed(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_deferred_embed_chunks(uuid, text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_write_deferred_vectors(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION rag_publish_deferred_ingestion_job(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag_batch_progress(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

------------------------------------------
-- Phase 4: Hybrid retrieval, reranking and calibrated refusal (migrations 0401-0413)
------------------------------------------

-- >>> supabase/migrations/0401_lexical_index.sql
-- 0401: Lexical index over application tokenizer output (Phase 4, D-08, RET-03).
-- Plain nullable lexical_tsv and lexical_version columns with a trigger (not a stored generated column) so the HNSW index is not rewritten.
-- Verbatim tsvector/tsquery builders avoid the Postgres text parser (F-1). No row backfill here; rag:relex fills batches (0402).
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, CREATE INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS.

BEGIN;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS lexical_tsv tsvector,
  ADD COLUMN IF NOT EXISTS lexical_version integer;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsvector(p_lexical_text text) RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT coalesce(string_agg(quote_literal(t.tok) || ':' || least(t.ord, 16383)::text, ' ' ORDER BY t.ord), '')::tsvector
  FROM unnest(string_to_array(coalesce(p_lexical_text, ''), ' ')) WITH ORDINALITY AS t(tok, ord)
  WHERE t.tok <> '' AND octet_length(t.tok) <= 255 AND t.tok !~ '[''\\[:space:]]'
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsquery(p_tokens text[]) RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT NULLIF(string_agg(quote_literal(t.tok), ' | '), '')::tsquery
  FROM (
    SELECT DISTINCT tok
    FROM unnest(coalesce(p_tokens, '{}'::text[])) AS u(tok)
    WHERE tok <> '' AND octet_length(tok) <= 255 AND tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t
$fn$;

CREATE OR REPLACE FUNCTION public.rag_chunks_lexical_tsv() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_meta_version text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.lexical_text IS DISTINCT FROM OLD.lexical_text THEN
    NEW.lexical_tsv := public.rag_lexical_tsvector(NEW.lexical_text);
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    ELSE
      NEW.lexical_version := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_document_chunks_lexical_tsv ON document_chunks;
CREATE TRIGGER trg_document_chunks_lexical_tsv
  BEFORE INSERT OR UPDATE ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunks_lexical_tsv();

CREATE INDEX IF NOT EXISTS idx_document_chunks_lexical_tsv ON document_chunks USING gin (lexical_tsv);
CREATE INDEX IF NOT EXISTS idx_document_chunks_lexical_version ON document_chunks (lexical_version);

REVOKE ALL ON FUNCTION public.rag_lexical_tsvector(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_lexical_tsquery(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_chunks_lexical_tsv() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunks_lexical_tsv() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexical_tsvector(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_lexical_tsquery(text[]) TO service_role;

COMMIT;
-- >>> supabase/migrations/0402_relex_batch.sql
-- 0402: Service-role batch helpers for npm run rag:relex (Phase 4, D-08).
-- Candidates page by chunk id where lexical_version differs from the target version; the batch rewrites lexical_text and version only.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_relex_candidates(
  p_after uuid,
  p_version integer,
  p_limit integer,
  p_tenant_key text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_key text,
  content text,
  section_path text[],
  chunk_kind text,
  metadata jsonb,
  language text,
  document_filename text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'relex_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT c.id,
         c.tenant_key,
         c.content,
         c.section_path,
         c.chunk_kind,
         c.metadata,
         c.language,
         d.filename AS document_filename
  FROM document_chunks c
  JOIN documents d ON d.id = c.document_id
  WHERE c.is_current
    AND c.status = 'ready'
    AND c.lexical_version IS DISTINCT FROM p_version
    AND (p_after IS NULL OR c.id > p_after)
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
  ORDER BY c.id
  LIMIT p_limit;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rag_relex_batch(p_rows jsonb, p_version integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_row jsonb;
  v_count integer := 0;
BEGIN
  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'relex_refused: invalid_version' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) AS e(value) LOOP
    IF jsonb_typeof(v_row) <> 'object' OR NOT (v_row ? 'id') OR jsonb_typeof(v_row -> 'id') IS DISTINCT FROM 'string' THEN
      CONTINUE;
    END IF;
    UPDATE document_chunks c
    SET lexical_text = v_row ->> 'lexical_text',
        lexical_version = p_version,
        metadata = jsonb_set(coalesce(c.metadata, '{}'::jsonb), '{lexical_version}', to_jsonb(p_version), true),
        language = CASE
          WHEN c.language IS NULL AND v_row ? 'language' THEN NULLIF(v_row ->> 'language', '')
          ELSE c.language
        END
    WHERE c.id = (v_row ->> 'id')::uuid
      AND c.is_current
      AND c.status = 'ready';
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rag_relex_candidates(uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_relex_batch(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_relex_candidates(uuid, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_relex_batch(jsonb, integer) TO service_role;

COMMIT;
-- >>> supabase/migrations/0403_tenant_key_guard.multi-tenant.sql
-- 0403 (multi-tenant): central tenant-key guard for Phase 4 service-role functions (D-04, F-12).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_assert_tenant_key(p_tenant_key text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_tenant_key IS NULL OR p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'malformed tenant key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key = 's:default' THEN
    RAISE EXCEPTION 'tenant key not valid for this deployment mode' USING ERRCODE = '22023';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.rag_assert_tenant_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_assert_tenant_key(text) TO service_role;

COMMIT;
-- >>> supabase/migrations/0404_document_parents.sql
-- 0404: parent storage, child profile columns, variant-status invariant, rag_fetch_parents (D-20, D-21).

BEGIN;

CREATE TABLE IF NOT EXISTS document_parents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  organization_id uuid,
  version integer,
  is_current boolean NOT NULL DEFAULT true,
  chunking_profile_id text NOT NULL,
  section_path text[] NOT NULL DEFAULT '{}',
  content text NOT NULL,
  token_count integer NOT NULL CONSTRAINT document_parents_token_count_check CHECK (token_count >= 0),
  parent_index integer NOT NULL CONSTRAINT document_parents_parent_index_check CHECK (parent_index >= 0)
);

CREATE INDEX IF NOT EXISTS idx_document_parents_tenant_id ON document_parents (tenant_key, id);
CREATE INDEX IF NOT EXISTS idx_document_parents_document_profile ON document_parents (document_id, chunking_profile_id);

ALTER TABLE document_parents ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON TABLE document_parents FROM anon, authenticated;

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES document_parents (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chunking_profile_id text NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_document_chunks_parent_id ON document_chunks (parent_id);

DO $$
DECLARE
  status_attnum smallint;
  check_name text;
BEGIN
  SELECT attnum INTO status_attnum
  FROM pg_attribute
  WHERE attrelid = to_regclass('public.document_chunks') AND attname = 'status' AND NOT attisdropped;
  FOR check_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = to_regclass('public.document_chunks') AND contype = 'c' AND conkey @> ARRAY[status_attnum]
  LOOP
    EXECUTE format('ALTER TABLE public.document_chunks DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

ALTER TABLE document_chunks
  ADD CONSTRAINT document_chunks_status_check
  CHECK (status IN ('processing', 'ready', 'variant', 'quarantined', 'failed', 'deleted'));

CREATE OR REPLACE FUNCTION public.rag_chunks_profile_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.chunking_profile_id IS DISTINCT FROM 'legacy' AND NEW.status = 'ready' THEN
    NEW.status := 'variant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rag_chunks_profile_status ON document_chunks;
CREATE TRIGGER rag_chunks_profile_status
  BEFORE INSERT OR UPDATE OF status, chunking_profile_id ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunks_profile_status();

REVOKE ALL ON FUNCTION public.rag_chunks_profile_status() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rag_fetch_parents(p_tenant_key text, p_parent_ids uuid[])
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  version integer,
  is_current boolean,
  chunking_profile_id text,
  section_path text[],
  content text,
  token_count integer,
  parent_index integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF coalesce(cardinality(p_parent_ids), 0) > 200 THEN
    RAISE EXCEPTION 'too many parent ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT
    p.id,
    p.document_id,
    p.tenant_key,
    p.version,
    p.is_current,
    p.chunking_profile_id,
    p.section_path,
    p.content,
    p.token_count,
    p.parent_index
  FROM document_parents p
  WHERE p.tenant_key = p_tenant_key
    AND p.is_current
    AND p.id = ANY(p_parent_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.rag_fetch_parents(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fetch_parents(text, uuid[]) TO service_role;

COMMIT;
-- >>> supabase/migrations/0405_document_parents_rls.multi-tenant.sql
-- 0405 (multi-tenant): document_parents SELECT policy mirrors document_chunks.

BEGIN;

DROP POLICY IF EXISTS "Users can view document_parents" ON document_parents;
CREATE POLICY "Users can view document_parents" ON document_parents
  FOR SELECT USING (
    is_current
    AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_parents.document_id AND d.is_current AND d.status = 'ready'
    )
    AND (
      document_id IN (
        SELECT doc.id FROM documents doc
        WHERE doc.user_id = auth.uid() AND doc.organization_id IS NULL
      )
      OR (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
    )
  );

COMMIT;
-- >>> supabase/migrations/0406_chunking_profiles.sql
-- 0406: chunking profile registry with one active legacy row per doc type (D-21).

BEGIN;

CREATE TABLE IF NOT EXISTS chunking_profiles (
  id text NOT NULL,
  doc_type text NOT NULL,
  child_tokens integer NOT NULL CONSTRAINT chunking_profiles_child_tokens_check CHECK (child_tokens > 0),
  parent_mode text NOT NULL CONSTRAINT chunking_profiles_parent_mode_check CHECK (parent_mode IN ('none', 'structure', 'fixed')),
  parent_tokens integer,
  status text NOT NULL CONSTRAINT chunking_profiles_status_check CHECK (status IN ('building', 'ready', 'active', 'retired')),
  preset text NOT NULL CONSTRAINT chunking_profiles_preset_check CHECK (preset IN ('128/512', '256/1024', '256/2048', 'custom')),
  previous_active_id text,
  eval_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  activated_by text,
  PRIMARY KEY (id, doc_type),
  CONSTRAINT chunking_profiles_doc_type_check CHECK (
    doc_type IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general')
  ),
  CONSTRAINT chunking_profiles_parent_tokens_required CHECK (parent_mode = 'none' OR parent_tokens IS NOT NULL),
  CONSTRAINT chunking_profiles_parent_ratio CHECK (parent_tokens IS NULL OR parent_tokens >= child_tokens * 2)
);

CREATE UNIQUE INDEX IF NOT EXISTS chunking_profiles_single_active ON chunking_profiles (doc_type) WHERE status = 'active';

INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset, activated_at, activated_by)
VALUES
  ('legacy', 'financial_report', 512, 'none', NULL, 'active', '256/1024', now(), 'migration'),
  ('legacy', 'contract_legal', 768, 'none', NULL, 'active', '256/1024', now(), 'migration'),
  ('legacy', 'invoice_receipt', 512, 'none', NULL, 'active', '256/1024', now(), 'migration'),
  ('legacy', 'product_technical', 512, 'none', NULL, 'active', '256/1024', now(), 'migration'),
  ('legacy', 'scanned_image', 512, 'none', NULL, 'active', '256/1024', now(), 'migration'),
  ('legacy', 'general', 512, 'none', NULL, 'active', '256/1024', now(), 'migration')
ON CONFLICT (id, doc_type) DO NOTHING;

ALTER TABLE chunking_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE chunking_profiles FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE chunking_profiles TO service_role;

CREATE OR REPLACE FUNCTION rag_list_chunking_profiles()
RETURNS TABLE (
  id text,
  doc_type text,
  child_tokens integer,
  parent_mode text,
  parent_tokens integer,
  status text,
  preset text,
  previous_active_id text,
  is_active boolean,
  created_at timestamptz,
  activated_at timestamptz,
  activated_by text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    p.id,
    p.doc_type,
    p.child_tokens,
    p.parent_mode,
    p.parent_tokens,
    p.status,
    p.preset,
    p.previous_active_id,
  (p.status = 'active') AS is_active,
    p.created_at,
    p.activated_at,
    p.activated_by
  FROM chunking_profiles p
  ORDER BY p.doc_type, p.id
$$;

REVOKE ALL ON FUNCTION rag_list_chunking_profiles() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_list_chunking_profiles() TO service_role;

COMMIT;
-- >>> supabase/migrations/0407_hybrid_search_chunks.sql
-- 0407: hybrid_search_chunks — filtered dense + lexical legs, service_role only (D-04, D-05, D-06).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_document_chunks_tenant_key ON document_chunks USING btree (tenant_key);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_profile ON document_chunks (document_id, chunking_profile_id)
  WHERE chunking_profile_id <> 'legacy';

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding vector,
  p_lexical_tokens text[],
  p_dense_limit integer,
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off',
  p_exact_scan_cutoff integer DEFAULT 0,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_dims integer;
  v_storage text;
  v_tsq tsquery;
  v_n integer;
  v_mode text := 'ann';
  v_filter text;
  v_from text;
  v_vec text;
  v_sel text;
  v_pgvector text;
  v_key text;
  v_val text;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(p_chunking_override) LOOP
      IF NOT EXISTS (SELECT 1 FROM chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  CREATE TEMP TABLE _hybrid_eff_profile (doc_type text PRIMARY KEY, profile_id text) ON COMMIT DROP;
  INSERT INTO _hybrid_eff_profile (doc_type, profile_id)
  SELECT dt.doc_type,
         COALESCE(
           NULLIF(trim(both FROM p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         )
  FROM unnest(v_doc_types) AS dt(doc_type);

  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM _hybrid_eff_profile ep WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || ' AND ($3::date IS NULL OR c.doc_date >= $3)'
    || ' AND ($4::date IS NULL OR c.doc_date <= $4)'
    || ' AND ($5::text[] IS NULL OR (cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8))'
    || ' AND ($9::text IS NULL OR strpos(lower(d.supplier_name), lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' document_chunks c JOIN documents d ON d.id = c.document_id ';
      v_vec := format('c.embedding <=> $1::vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(
        ' chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L'
        || ' JOIN documents d ON d.id = c.document_id ',
        p_profile_id
      );
      v_vec := format('(e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)', v_dims);
    END IF;

    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*)::int FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $13) s'
        INTO v_n
        USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
          p_supplier, p_amount_min, p_amount_max, p_currency, p_exact_scan_cutoff + 1;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;

    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN
        SELECT extversion INTO v_pgvector FROM pg_extension WHERE extname = 'vector';
        IF v_pgvector IS NULL OR (string_to_array(v_pgvector, '.'))[1:2]::int[] < ARRAY[0, 8] THEN
          RAISE EXCEPTION 'iterative_scan_unsupported' USING ERRCODE = '22023';
        END IF;
        PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);
      END IF;
    END IF;

    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $13) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $13) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_dense_limit;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
  v_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score'
      || ' FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE ' || v_filter
      || ' AND ($14::text[] IS NULL OR (cardinality($14) > 0 AND c.language = ANY($14)))'
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $13) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(
        v_sel,
        CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
          THEN format('(1 - (c.embedding <=> $15::vector(%s)))::double precision', v_dims)
          ELSE 'NULL::double precision' END,
        't.score::real',
        'n/a'
      )
      || ' FROM hits t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(
  text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(
  text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
-- >>> supabase/migrations/0408_profile_chunk_writer.sql
-- 0408: profile chunk writer and re-chunk build-run tables (Phase 4, D-20, D-21, CHK-03, CHK-04).
-- rag_write_profile_chunks stores the parents and children of one chunking profile for one document version in one transaction. Parents go to
-- document_parents, children to document_chunks with parent_id and chunking_profile_id. Row ids are the first 16 bytes of
-- sha256(document id : profile id : parent|child : index), so a rewrite lands on the same rows and cannot collide with the legacy ids of
-- rag_write_chunks (document id : index). The document must belong to p_tenant_key (tenant_mismatch otherwise); the tenant key, organization,
-- version, currency, doc type, language and source of every row are copied from the document row, never from the payload. The 0404 trigger keeps
-- every child of a non-legacy profile at status variant once its document is ready, so legacy readers never see them.
-- p_embeddings has the shape of rag_write_chunks: an object keyed by embedding profile id whose value lines up with p_children (a null entry means
-- no vector), or {"vectors": [...], "host": "..."}; the legacy-storage profile fills document_chunks.embedding, a halfvec profile upserts one
-- chunk_embeddings row per child. Only children carry lexical text and vectors; parents carry neither. A child whose text changed drops its old
-- vectors. With p_final (the default) children from index p_total on (default: the number sent) and parents no child points to any more are removed,
-- so a smaller rewrite leaves nothing behind; a caller that splits a large profile across calls sends all parents in the first call and p_final on the last.
-- chunking_build_runs and chunking_build_gaps record re-chunk progress and documents that have no stored parse output (plan 04-32 writes them).
-- rag_write_chunks is replaced once more so its final cleanup removes legacy rows only (profile children share the document).
-- Server role only. Idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE with a fixed signature, then guarded REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS chunking_build_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL,
  doc_type text NOT NULL,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer NOT NULL DEFAULT 0 CONSTRAINT chunking_build_runs_docs_total_check CHECK (docs_total >= 0),
  docs_done integer NOT NULL DEFAULT 0 CONSTRAINT chunking_build_runs_docs_done_check CHECK (docs_done >= 0),
  status text NOT NULL DEFAULT 'running'
    CONSTRAINT chunking_build_runs_status_check CHECK (status IN ('running', 'completed', 'incomplete', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunking_build_runs_profile_fk FOREIGN KEY (profile_id, doc_type) REFERENCES chunking_profiles (id, doc_type)
);

CREATE INDEX IF NOT EXISTS chunking_build_runs_profile_idx ON chunking_build_runs (profile_id, doc_type, started_at DESC);

CREATE TABLE IF NOT EXISTS chunking_build_gaps (
  run_id uuid NOT NULL REFERENCES chunking_build_runs (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  reason text NOT NULL CONSTRAINT chunking_build_gaps_reason_check CHECK (reason IN ('no_parse_output', 'failed')),
  detail text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, document_id)
);

CREATE INDEX IF NOT EXISTS chunking_build_gaps_document_idx ON chunking_build_gaps (document_id);

ALTER TABLE chunking_build_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunking_build_gaps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE chunking_build_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE chunking_build_gaps FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE chunking_build_runs TO service_role;
GRANT ALL ON TABLE chunking_build_gaps TO service_role;

-- The legacy writer's final cleanup ("chunk_index >= p_total") must only remove legacy rows: the children of a chunking profile share the
-- document and have their own index range. Body as in 0313 except for that one predicate.
CREATE OR REPLACE FUNCTION rag_write_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_chunks jsonb,
  p_embeddings jsonb,
  p_final boolean,
  p_total integer
)
RETURNS TABLE (chunks_written integer, chunks_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc documents%ROWTYPE;
  profile_key text;
  profile_row embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  chunk_count integer;
  legacy_vectors jsonb;
  written integer := 0;
  deleted integer := 0;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_chunks must be a JSON array';
  END IF;
  chunk_count := jsonb_array_length(p_chunks);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every chunk needs a string content and a numeric chunk_index when it has one';
  END IF;
  IF (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)) <> chunk_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct';
  END IF;
  IF p_final AND (p_total IS NULL OR p_total < 0) THEN
    RAISE EXCEPTION 'invalid_total: p_total is required with p_final';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF vectors IS NULL OR jsonb_typeof(vectors) <> 'array' OR jsonb_array_length(vectors) <> chunk_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE jsonb_typeof(v.value) = 'array' AND jsonb_array_length(v.value) <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  -- A chunk whose text changed must not keep a vector made from the old text.
  DELETE FROM chunk_embeddings ce
  USING document_chunks c, jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      (e.ord - 1)::integer AS position,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS written = ROW_COUNT;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM embedding_backfill_gaps g
      USING jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    DELETE FROM document_chunks c WHERE c.document_id = p_document_id AND c.chunking_profile_id = 'legacy' AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

CREATE OR REPLACE FUNCTION rag_write_profile_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_profile_id text,
  p_parents jsonb,
  p_children jsonb,
  p_embeddings jsonb,
  p_final boolean DEFAULT true,
  p_total integer DEFAULT NULL
)
RETURNS TABLE (parents_written integer, children_written integer, parents_deleted integer, children_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc documents%ROWTYPE;
  chunking chunking_profiles%ROWTYPE;
  parents jsonb := COALESCE(p_parents, '[]'::jsonb);
  profile_key text;
  profile_row embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  parent_count integer;
  child_count integer;
  legacy_vectors jsonb;
  total integer;
  parents_in integer := 0;
  children_in integer := 0;
  parents_out integer := 0;
  children_out integer := 0;
BEGIN
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_profile_id IS NULL OR p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_profile' USING DETAIL = 'legacy chunks are written by rag_write_chunks';
  END IF;
  SELECT * INTO chunking FROM chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = doc.doc_type AND cp.status <> 'retired';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chunking_profile_unsupported' USING DETAIL = 'no live profile of this id for the document type';
  END IF;

  IF jsonb_typeof(parents) <> 'array' THEN
    RAISE EXCEPTION 'invalid_parents: p_parents must be a JSON array';
  END IF;
  IF p_children IS NULL OR jsonb_typeof(p_children) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_children must be a JSON array';
  END IF;
  parent_count := jsonb_array_length(parents);
  child_count := jsonb_array_length(p_children);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e.value -> 'parent_index') IS DISTINCT FROM 'number'
       OR jsonb_typeof(e.value -> 'token_count') IS DISTINCT FROM 'number'
       OR (e.value ? 'section_path' AND jsonb_typeof(e.value -> 'section_path') <> 'array')
  ) THEN
    RAISE EXCEPTION 'invalid_parents: every parent needs a string content, a numeric parent_index and a numeric token_count';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$' OR (e.value ->> 'token_count') !~ '^[0-9]{1,9}$'
  ) OR (SELECT count(DISTINCT (e.value ->> 'parent_index')::integer) FROM jsonb_array_elements(parents) AS e(value)) <> parent_count THEN
    RAISE EXCEPTION 'invalid_parents: parent_index values must be distinct non-negative integers and token_count a non-negative integer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
       OR (e.value ? 'parent_index' AND jsonb_typeof(e.value -> 'parent_index') NOT IN ('number', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every child needs a string content, and a numeric chunk_index and parent_index when it has them';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
    WHERE COALESCE(e.value ->> 'chunk_index', (e.ord - 1)::text) !~ '^[0-9]{1,9}$'
       OR (jsonb_typeof(e.value -> 'parent_index') = 'number' AND (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$')
  ) OR (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)) <> child_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct non-negative integers';
  END IF;
  IF p_final AND p_total IS NOT NULL AND p_total < 0 THEN
    RAISE EXCEPTION 'invalid_total: p_total must not be negative';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF vectors IS NULL OR jsonb_typeof(vectors) <> 'array' OR jsonb_array_length(vectors) <> child_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', child_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE jsonb_typeof(v.value) = 'array' AND jsonb_array_length(v.value) <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO document_parents AS dp (
    id, document_id, tenant_key, organization_id, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    doc.tenant_key,
    doc.organization_id,
    doc.version,
    true,
    p_profile_id,
    CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END,
    e.value ->> 'content',
    (e.value ->> 'token_count')::integer,
    (e.value ->> 'parent_index')::integer
  FROM jsonb_array_elements(parents) AS e(value)
  ON CONFLICT (id) DO UPDATE SET
    tenant_key = EXCLUDED.tenant_key,
    organization_id = EXCLUDED.organization_id,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    chunking_profile_id = EXCLUDED.chunking_profile_id,
    section_path = EXCLUDED.section_path,
    content = EXCLUDED.content,
    token_count = EXCLUDED.token_count,
    parent_index = EXCLUDED.parent_index
  WHERE dp.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS parents_in = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value -> 'parent_index') = 'number'
      AND NOT EXISTS (
        SELECT 1 FROM document_parents dp
        WHERE dp.id = substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
          AND dp.document_id = p_document_id
          AND dp.chunking_profile_id = p_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: parent_index names a parent that was not written';
  END IF;

  -- A child whose text changed must not keep a vector made from the old text.
  DELETE FROM chunk_embeddings ce
  USING document_chunks c, jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.chunking_profile_id = p_profile_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN jsonb_typeof(e.value -> 'parent_index') = 'number'
           THEN substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
      END AS parent_id,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text
    FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text, parent_id, chunking_profile_id
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':child:' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version,
        'chunking_profile_id', p_profile_id)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text,
    p.parent_id,
    p_profile_id
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text,
    parent_id = EXCLUDED.parent_id,
    chunking_profile_id = EXCLUDED.chunking_profile_id
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS children_in = ROW_COUNT;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM embedding_backfill_gaps g
      USING jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    total := COALESCE(p_total, child_count);
    DELETE FROM document_chunks c
    WHERE c.document_id = p_document_id AND c.chunking_profile_id = p_profile_id AND c.chunk_index >= total;
    GET DIAGNOSTICS children_out = ROW_COUNT;
    DELETE FROM document_parents dp
    WHERE dp.document_id = p_document_id
      AND dp.chunking_profile_id = p_profile_id
      AND NOT EXISTS (SELECT 1 FROM document_chunks c WHERE c.parent_id = dp.id);
    GET DIAGNOSTICS parents_out = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT parents_in, children_in, parents_out, children_out;
END
$$;

DO $profile_writer_acl$
BEGIN
  IF to_regprocedure('public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
END
$profile_writer_acl$;

COMMIT;

-- >>> supabase/migrations/0409_search_rpc_revoke.sql
-- 0409 (03-48 follow-up, D-08): the REVOKE from PUBLIC, anon and authenticated and the GRANT to service_role of the tenant search RPCs are
-- already part of each function's definition above, so this file adds nothing to a fresh install. Upgrades run the migration.

-- >>> supabase/migrations/0410_security_definer_rpc_grants.sql
-- 0410 (03-48 follow-up 2, D-08): every public SECURITY DEFINER function is service_role only unless it is an authenticated-callable RPC or an RLS helper.
-- A fresh install already gets that from the 03-48 follow-up 2 block before 0320 and from the REVOKE and GRANT next to each function; the Phase 3.1
-- queue and budget clauses cover functions that the Phase 3.1 migrations create with the same grants. What is left for a fresh install is the
-- service_role grant on three Phase 3 functions, below. Upgrades run the migration itself.

BEGIN;

REVOKE ALL ON FUNCTION public.rag_chunk_embeddings_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunk_embeddings_guard() TO service_role;
REVOKE ALL ON FUNCTION public.rag_chunks_legacy_defaults() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunks_legacy_defaults() TO service_role;
REVOKE ALL ON FUNCTION public.rag_reembed_pick(text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_reembed_pick(text, text, uuid, integer) TO service_role;

COMMIT;

-- >>> supabase/migrations/0411_security_definer_search_path.sql
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

-- >>> supabase/migrations/0412_rechunk_functions.sql
-- 0412: server functions of the rechunk job (Phase 4, plan 04-32, D-21, CHK-04).
-- The job builds one chunking profile for the current ready documents of the profile's doc type from stored parse output. These functions are
-- its only door to the database besides rag_write_profile_chunks (0408), which writes the parents, children and vectors of one document under
-- that document's own tenant key. Here: the document selection, the build run (chunking_build_runs) with its cursor, and the documents that
-- cannot be built (chunking_build_gaps).
--   Selection: current, ready documents of the profile's doc type (optionally one tenant) that have no current chunk in the profile, in id order.
--              The same predicate serves a first build, a resume, and the repair of an active profile (nothing already complete is selected).
--   Status:    a run never moves an active or ready profile. A building profile becomes ready when the run finishes and no current ready document
--              of the type, in any tenant, is missing children. The pointer flip to active is the activation function's job, not this file's.
-- Refusals raise 'rechunk_refused: <reason>' and carry no row content. Server role only (SECURITY DEFINER, fixed search_path).
-- Idempotent: CREATE OR REPLACE with fixed signatures, then guarded REVOKE and GRANT.

BEGIN;

-- Current ready documents of the type that have no current chunk in the profile. Internal count used by the start and finish functions.
CREATE OR REPLACE FUNCTION rag_rechunk_missing(p_profile_id text, p_doc_type text, p_tenant_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM chunking_profiles p
  JOIN documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
  WHERE p.id = p_profile_id
    AND p.doc_type = p_doc_type
    AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM document_chunks c
      WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
$$;

-- The documents a run still has to build, after the cursor, in id order. lineage_id and version locate the stored parse output.
CREATE OR REPLACE FUNCTION rag_rechunk_documents(p_profile_id text, p_doc_type text, p_tenant_key text, p_after uuid, p_limit integer)
RETURNS TABLE (
  document_id uuid,
  tenant_key text,
  lineage_id uuid,
  version integer,
  filename text,
  doc_type text,
  source text,
  template_row jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT d.id, d.tenant_key, d.lineage_id, d.version, d.filename, d.doc_type, d.source,
           jsonb_build_object(
             'invoice_number', d.invoice_number,
             'supplier_name', d.supplier_name,
             'supplier_tax_id', d.supplier_tax_id,
             'issue_date', d.issue_date::text,
             'gross_total', d.gross_total::text,
             'currency', d.currency)
    FROM chunking_profiles p
    JOIN documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
    WHERE p.id = p_profile_id
      AND p.doc_type = p_doc_type
      AND p.id <> 'legacy'
      AND p.status IN ('building', 'ready', 'active')
      AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
      AND (p_after IS NULL OR d.id > p_after)
      AND NOT EXISTS (
        SELECT 1 FROM document_chunks c
        WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
    ORDER BY d.id
    LIMIT p_limit;
END
$$;

CREATE OR REPLACE FUNCTION rag_rechunk_get_run(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  doc_type text,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer,
  docs_done integer,
  status text,
  profile_status text,
  child_tokens integer,
  parent_mode text,
  parent_tokens integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.profile_id, r.doc_type, r.tenant_key, r.cursor_document_id, r.docs_total, r.docs_done, r.status,
         p.status, p.child_tokens, p.parent_mode, p.parent_tokens
  FROM chunking_build_runs r
  JOIN chunking_profiles p ON p.id = r.profile_id AND p.doc_type = r.doc_type
  WHERE r.id = p_run_id
$$;

-- Opens a run. With p_resume_open the newest running run of the same profile and tenant scope is returned instead of a new one, so bounded
-- calls (an admin route inside its function limit) continue one run. The profile keeps its status: a run only reads and writes children.
CREATE OR REPLACE FUNCTION rag_rechunk_start_run(
  p_profile_id text,
  p_doc_type text DEFAULT NULL,
  p_tenant_key text DEFAULT NULL,
  p_resume_open boolean DEFAULT false
)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  doc_type text,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer,
  docs_done integer,
  status text,
  profile_status text,
  child_tokens integer,
  parent_mode text,
  parent_tokens integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  matches integer;
  chosen chunking_profiles%ROWTYPE;
  opened uuid;
BEGIN
  IF p_profile_id IS NULL OR btrim(p_profile_id) = '' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_required' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_is_legacy' USING ERRCODE = '55000';
  END IF;
  IF p_tenant_key IS NOT NULL
     AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO matches FROM chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF matches = 0 THEN
    RAISE EXCEPTION 'rechunk_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF matches > 1 THEN
    RAISE EXCEPTION 'rechunk_refused: profile_ambiguous' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO chosen FROM chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF chosen.status = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF p_resume_open THEN
    SELECT r.id INTO opened
    FROM chunking_build_runs r
    WHERE r.profile_id = chosen.id AND r.doc_type = chosen.doc_type AND r.tenant_key IS NOT DISTINCT FROM p_tenant_key AND r.status = 'running'
    ORDER BY r.started_at DESC
    LIMIT 1;
  END IF;
  IF opened IS NULL THEN
    INSERT INTO chunking_build_runs (profile_id, doc_type, tenant_key, docs_total)
    VALUES (chosen.id, chosen.doc_type, p_tenant_key, rag_rechunk_missing(chosen.id, chosen.doc_type, p_tenant_key))
    RETURNING id INTO opened;
  END IF;
  RETURN QUERY SELECT * FROM rag_rechunk_get_run(opened);
END
$$;

-- Continues a run that was killed (running) or stopped by a failure (failed) from its cursor.
CREATE OR REPLACE FUNCTION rag_rechunk_resume_run(p_run_id uuid)
RETURNS TABLE (
  run_id uuid,
  profile_id text,
  doc_type text,
  tenant_key text,
  cursor_document_id uuid,
  docs_total integer,
  docs_done integer,
  status text,
  profile_status text,
  child_tokens integer,
  parent_mode text,
  parent_tokens integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  existing chunking_build_runs%ROWTYPE;
  profile_state text;
BEGIN
  SELECT * INTO existing FROM chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status NOT IN ('running', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_resumable' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO profile_state FROM chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  IF profile_state = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  UPDATE chunking_build_runs r SET status = 'running', updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT * FROM rag_rechunk_get_run(p_run_id);
END
$$;

-- Moves the cursor to the document just handled (built or recorded as a gap) and counts it.
CREATE OR REPLACE FUNCTION rag_rechunk_advance(p_run_id uuid, p_document_id uuid)
RETURNS TABLE (docs_done integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  handled integer;
BEGIN
  UPDATE chunking_build_runs r
  SET cursor_document_id = p_document_id, docs_done = r.docs_done + 1, updated_at = now()
  WHERE r.id = p_run_id AND r.status = 'running'
  RETURNING r.docs_done INTO handled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT handled;
END
$$;

-- Records a document the run could not build. The document must be of the run's doc type and tenant scope.
CREATE OR REPLACE FUNCTION rag_rechunk_record_gap(p_run_id uuid, p_document_id uuid, p_reason text, p_detail text DEFAULT NULL)
RETURNS TABLE (recorded integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  existing chunking_build_runs%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM chunking_build_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('no_parse_output', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_gap' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM documents d
  WHERE d.id = p_document_id AND d.doc_type = existing.doc_type AND (existing.tenant_key IS NULL OR d.tenant_key = existing.tenant_key);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: document_out_of_scope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO chunking_build_gaps (run_id, document_id, reason, detail)
  VALUES (p_run_id, p_document_id, p_reason, left(p_detail, 200))
  ON CONFLICT (run_id, document_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, recorded_at = now();
  RETURN QUERY SELECT 1;
END
$$;

-- Ends a run. 'completed' becomes 'incomplete' while a document in the run's scope still lacks children; a building profile becomes ready only
-- when no current ready document of the type, in any tenant, lacks children. 'failed' only marks the run.
CREATE OR REPLACE FUNCTION rag_rechunk_finish_run(p_run_id uuid, p_status text DEFAULT 'completed')
RETURNS TABLE (
  status text,
  docs_missing integer,
  docs_missing_total integer,
  gaps integer,
  profile_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  existing chunking_build_runs%ROWTYPE;
  scope_missing integer;
  total_missing integer;
  final_status text;
  gap_count integer;
  profile_state text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO existing FROM chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;

  scope_missing := rag_rechunk_missing(existing.profile_id, existing.doc_type, existing.tenant_key);
  total_missing := rag_rechunk_missing(existing.profile_id, existing.doc_type, NULL);
  IF p_status = 'failed' THEN
    final_status := 'failed';
  ELSIF scope_missing = 0 THEN
    final_status := 'completed';
  ELSE
    final_status := 'incomplete';
  END IF;
  UPDATE chunking_build_runs r SET status = final_status, updated_at = now() WHERE r.id = p_run_id;

  IF final_status = 'completed' AND total_missing = 0 THEN
    UPDATE chunking_profiles p SET status = 'ready'
    WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type AND p.status = 'building';
  END IF;
  SELECT count(*)::integer INTO gap_count FROM chunking_build_gaps g WHERE g.run_id = p_run_id;
  SELECT p.status INTO profile_state FROM chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  RETURN QUERY SELECT final_status, scope_missing, total_missing, gap_count, profile_state;
END
$$;

-- The documents a run recorded as gaps, with the tenant each belongs to.
CREATE OR REPLACE FUNCTION rag_rechunk_gaps(p_run_id uuid)
RETURNS TABLE (
  document_id uuid,
  tenant_key text,
  reason text,
  detail text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT g.document_id, d.tenant_key, g.reason, g.detail
  FROM chunking_build_gaps g
  JOIN documents d ON d.id = g.document_id
  WHERE g.run_id = p_run_id
  ORDER BY g.document_id
$$;

DO $rechunk_acl$
BEGIN
  IF to_regprocedure('public.rag_rechunk_missing(text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_missing(text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_missing(text, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_documents(text, text, text, uuid, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_documents(text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_documents(text, text, text, uuid, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_get_run(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_get_run(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_get_run(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_start_run(text, text, text, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_start_run(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_start_run(text, text, text, boolean) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_resume_run(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_resume_run(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_resume_run(uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_advance(uuid, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_advance(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_advance(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_record_gap(uuid, uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_record_gap(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_record_gap(uuid, uuid, text, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_finish_run(uuid, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_finish_run(uuid, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_finish_run(uuid, text) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_rechunk_gaps(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_rechunk_gaps(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_rechunk_gaps(uuid) TO service_role;
  END IF;
END
$rechunk_acl$;

COMMIT;

-- >>> supabase/migrations/0413_chunking_activation.sql
-- 0413: chunking profile activation, rollback and coverage; parent currency; image and invoice-header chunks under an active profile
-- (Phase 4, plan 04-33, D-21, CHK-03, CHK-04). The plan named 0409; that number is taken, 0413 is the number reserved for this plan.
--
-- Activation (D-21). One chunking profile per doc type is active at deployment level. rag_create_chunking_profile inserts a building profile
-- (lower-case slug, `legacy` reserved, one of the six doc types, parent at least twice the child; the full rule set, including the embedding
-- input limit, lives in Pydantic and src/lib/rag/chunking/validate.ts). rag_record_chunking_decision stores a ChunkingDecision as the profile's
-- eval evidence after checking that its doc_type and profile id match the row. rag_activate_chunking_profile flips the pointer in one
-- transaction under a row lock on the doc type's profiles and otherwise raises `chunking_activation_refused:<reason>` with the reason one of
-- unknown_profile, ambiguous_profile, not_ready, incomplete, open_gaps, no_evidence, eval_failed, stale_evidence, checked in that order. A profile id is only
-- unique per doc type, so p_doc_type names the type when the id exists for more than one (and is required for `legacy`). Activating the active
-- profile changes nothing; activating `legacy` needs no evidence. rag_rollback_chunking_profile restores previous_active_id (legacy when null or
-- retired), returns the rolled-back profile to ready with every row kept, and refuses `no_previous` only when legacy is already active.
-- rag_chunking_coverage counts, per doc type and profile, the current ready documents, those with current chunks in the profile and those
-- missing (counts only: no ids, names or tenant keys). rag_chunking_profile_state adds, per profile, the open gaps of its latest build run and
-- whether the recorded decision passed (for rag:chunking status). Pointer flips never touch chunk rows, so legacy readers are unaffected.
-- These six functions are SECURITY INVOKER with an empty search_path and schema-qualified names; only service_role may execute them.
--
-- Parent currency (round G MEDIUM-3). document_parents.is_current was written true and never updated, so a superseded, unpublished or
-- quarantined version kept current parents. It now follows the document row: a BEFORE trigger keeps a parent non-current while its document
-- is, an AFTER trigger on documents carries every is_current flip to the parents, existing rows are corrected, and rag_fetch_parents also joins the document
-- (current and ready, same tenant).
--
-- Image and invoice-header chunks (round G MEDIUM-5, round F deferred item). Profile children are cut from the parse text only, so the legacy
-- chunk_kind 'image' and 'invoice_header' rows have no counterpart in a profile; hybrid_search_chunks used a document's legacy rows only when it
-- had no rows of the effective profile, which hid them (and source_images) as soon as a profile was active. They now stay searchable
-- whatever profile is effective. The function is replaced from 0407 with that one added predicate.
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_parent_currency_from_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_current boolean;
BEGIN
  SELECT d.is_current INTO v_current FROM public.documents d WHERE d.id = NEW.document_id;
  IF FOUND THEN
    NEW.is_current := NEW.is_current AND v_current;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_sync_parent_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.document_parents p
  SET is_current = NEW.is_current
  WHERE p.document_id = NEW.id AND p.is_current IS DISTINCT FROM NEW.is_current;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS rag_document_parents_currency ON public.document_parents;
CREATE TRIGGER rag_document_parents_currency
  BEFORE INSERT OR UPDATE OF is_current ON public.document_parents
  FOR EACH ROW EXECUTE FUNCTION public.rag_parent_currency_from_document();

DROP TRIGGER IF EXISTS rag_documents_sync_parent_currency ON public.documents;
CREATE TRIGGER rag_documents_sync_parent_currency
  AFTER UPDATE OF is_current ON public.documents
  FOR EACH ROW
  WHEN (OLD.is_current IS DISTINCT FROM NEW.is_current)
  EXECUTE FUNCTION public.rag_sync_parent_currency();

UPDATE public.document_parents p
SET is_current = d.is_current
FROM public.documents d
WHERE d.id = p.document_id AND p.is_current IS DISTINCT FROM d.is_current;

CREATE OR REPLACE FUNCTION public.rag_fetch_parents(p_tenant_key text, p_parent_ids uuid[])
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  version integer,
  is_current boolean,
  chunking_profile_id text,
  section_path text[],
  content text,
  token_count integer,
  parent_index integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF coalesce(cardinality(p_parent_ids), 0) > 200 THEN
    RAISE EXCEPTION 'too many parent ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT
    p.id,
    p.document_id,
    p.tenant_key,
    p.version,
    p.is_current,
    p.chunking_profile_id,
    p.section_path,
    p.content,
    p.token_count,
    p.parent_index
  FROM public.document_parents p
  JOIN public.documents d
    ON d.id = p.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
  WHERE p.tenant_key = p_tenant_key
    AND p.is_current
    AND p.id = ANY(p_parent_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding vector,
  p_lexical_tokens text[],
  p_dense_limit integer,
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off',
  p_exact_scan_cutoff integer DEFAULT 0,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_dims integer;
  v_storage text;
  v_tsq tsquery;
  v_n integer;
  v_mode text := 'ann';
  v_filter text;
  v_from text;
  v_vec text;
  v_sel text;
  v_pgvector text;
  v_key text;
  v_val text;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(p_chunking_override) LOOP
      IF NOT EXISTS (SELECT 1 FROM chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  CREATE TEMP TABLE _hybrid_eff_profile (doc_type text PRIMARY KEY, profile_id text) ON COMMIT DROP;
  INSERT INTO _hybrid_eff_profile (doc_type, profile_id)
  SELECT dt.doc_type,
         COALESCE(
           NULLIF(trim(both FROM p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         )
  FROM unnest(v_doc_types) AS dt(doc_type);

  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM _hybrid_eff_profile ep WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || ' AND ($3::date IS NULL OR c.doc_date >= $3)'
    || ' AND ($4::date IS NULL OR c.doc_date <= $4)'
    || ' AND ($5::text[] IS NULL OR (cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8))'
    || ' AND ($9::text IS NULL OR strpos(lower(d.supplier_name), lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' document_chunks c JOIN documents d ON d.id = c.document_id ';
      v_vec := format('c.embedding <=> $1::vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(
        ' chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L'
        || ' JOIN documents d ON d.id = c.document_id ',
        p_profile_id
      );
      v_vec := format('(e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)', v_dims);
    END IF;

    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*)::int FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $13) s'
        INTO v_n
        USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
          p_supplier, p_amount_min, p_amount_max, p_currency, p_exact_scan_cutoff + 1;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;

    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN
        SELECT extversion INTO v_pgvector FROM pg_extension WHERE extname = 'vector';
        IF v_pgvector IS NULL OR (string_to_array(v_pgvector, '.'))[1:2]::int[] < ARRAY[0, 8] THEN
          RAISE EXCEPTION 'iterative_scan_unsupported' USING ERRCODE = '22023';
        END IF;
        PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);
      END IF;
    END IF;

    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $13) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $13) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_dense_limit;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
  v_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score'
      || ' FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE ' || v_filter
      || ' AND ($14::text[] IS NULL OR (cardinality($14) > 0 AND c.language = ANY($14)))'
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $13) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(
        v_sel,
        CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
          THEN format('(1 - (c.embedding <=> $15::vector(%s)))::double precision', v_dims)
          ELSE 'NULL::double precision' END,
        't.score::real',
        'n/a'
      )
      || ' FROM hits t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding;
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_create_chunking_profile(
  p_id text,
  p_doc_type text,
  p_child_tokens integer,
  p_parent_mode text,
  p_parent_tokens integer,
  p_preset text
)
RETURNS TABLE (profile_id text, doc_type text, status text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_id IS NULL OR p_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_profile: the id must be a lower-case slug' USING ERRCODE = '22023';
  END IF;
  IF p_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_profile: legacy is reserved' USING ERRCODE = '22023';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general') THEN
    RAISE EXCEPTION 'invalid_profile: unknown doc type' USING ERRCODE = '22023';
  END IF;
  IF p_child_tokens IS NULL OR p_child_tokens < 1 OR p_child_tokens > 32768 THEN
    RAISE EXCEPTION 'invalid_profile: child_tokens must be between 1 and 32768' USING ERRCODE = '22023';
  END IF;
  IF p_parent_mode IS NULL OR p_parent_mode NOT IN ('none', 'structure', 'fixed') THEN
    RAISE EXCEPTION 'invalid_profile: unknown parent mode' USING ERRCODE = '22023';
  END IF;
  IF p_parent_mode <> 'none' AND p_parent_tokens IS NULL THEN
    RAISE EXCEPTION 'invalid_profile: parent_tokens is required unless the parent mode is none' USING ERRCODE = '22023';
  END IF;
  IF p_parent_tokens IS NOT NULL AND p_parent_tokens < p_child_tokens * 2 THEN
    RAISE EXCEPTION 'invalid_profile: a parent must hold at least twice the child tokens' USING ERRCODE = '22023';
  END IF;
  IF p_preset IS NULL OR p_preset NOT IN ('128/512', '256/1024', '256/2048', 'custom') THEN
    RAISE EXCEPTION 'invalid_profile: unknown preset' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
  VALUES (p_id, p_doc_type, p_child_tokens, p_parent_mode, p_parent_tokens, 'building', p_preset);

  RETURN QUERY SELECT p_id, p_doc_type, 'building'::text;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_record_chunking_decision(p_profile_id text, p_decision jsonb)
RETURNS TABLE (profile_id text, doc_type text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_doc_type text;
  v_row public.chunking_profiles%ROWTYPE;
BEGIN
  IF p_decision IS NULL OR jsonb_typeof(p_decision) <> 'object' THEN
    RAISE EXCEPTION 'invalid_decision: a decision must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_decision -> 'gate_passed') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'invalid_decision: gate_passed must be a boolean' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_decision -> 'doc_type') IS DISTINCT FROM 'string' OR jsonb_typeof(p_decision -> 'profile_id') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_decision: doc_type and profile_id must be strings' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_decision -> 'build_run_id') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid_decision: build_run_id must be a string or null' USING ERRCODE = '22023';
  END IF;
  IF (p_decision ->> 'profile_id') IS DISTINCT FROM p_profile_id THEN
    RAISE EXCEPTION 'invalid_decision: the decision names another profile' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_decision: legacy needs no evidence' USING ERRCODE = '22023';
  END IF;
  v_doc_type := p_decision ->> 'doc_type';

  SELECT * INTO v_row FROM public.chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = v_doc_type FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_decision: no profile of that id for that doc type' USING ERRCODE = '22023';
  END IF;
  IF v_row.status = 'retired' THEN
    RAISE EXCEPTION 'invalid_decision: the profile is retired' USING ERRCODE = '22023';
  END IF;

  UPDATE public.chunking_profiles cp SET eval_evidence = p_decision WHERE cp.id = p_profile_id AND cp.doc_type = v_doc_type;
  RETURN QUERY SELECT p_profile_id, v_doc_type;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_activate_chunking_profile(p_profile_id text, p_actor text, p_doc_type text DEFAULT NULL)
RETURNS TABLE (activated_profile text, previous_profile text, doc_type text, changed boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '120s'
AS $$
#variable_conflict use_column
DECLARE
  v_actor text;
  v_doc_type text;
  v_count integer;
  v_target public.chunking_profiles%ROWTYPE;
  v_active public.chunking_profiles%ROWTYPE;
  v_missing integer;
  v_run uuid;
  v_evidence jsonb;
BEGIN
  IF p_actor IS NOT NULL AND p_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_actor: the actor must be a uuid' USING ERRCODE = '22023';
  END IF;
  v_actor := COALESCE(p_actor, 'cli');

  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'chunking_activation_refused:unknown_profile' USING ERRCODE = '55000';
  END IF;
  IF p_doc_type IS NOT NULL THEN
    v_doc_type := p_doc_type;
  ELSE
    SELECT count(*)::integer, min(cp.doc_type) INTO v_count, v_doc_type FROM public.chunking_profiles cp WHERE cp.id = p_profile_id;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'chunking_activation_refused:unknown_profile' USING ERRCODE = '55000';
    END IF;
    IF v_count > 1 THEN
      RAISE EXCEPTION 'chunking_activation_refused:ambiguous_profile (the id exists for % doc types; name the doc type)', v_count USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_doc_type ORDER BY cp.id FOR UPDATE;

  SELECT * INTO v_target FROM public.chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = v_doc_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chunking_activation_refused:unknown_profile' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_active FROM public.chunking_profiles cp WHERE cp.doc_type = v_doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1;

  IF v_target.status = 'active' THEN
    RETURN QUERY SELECT v_target.id, v_target.previous_active_id, v_doc_type, false;
    RETURN;
  END IF;
  IF v_target.status <> 'ready' THEN
    RAISE EXCEPTION 'chunking_activation_refused:not_ready (status %)', v_target.status USING ERRCODE = '55000';
  END IF;

  IF v_target.id <> 'legacy' THEN
    SELECT count(*)::integer INTO v_missing
    FROM public.documents d
    WHERE d.doc_type = v_doc_type AND d.is_current AND d.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM public.document_chunks c
        WHERE c.document_id = d.id AND c.chunking_profile_id = v_target.id AND c.is_current);
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'chunking_activation_refused:incomplete (% current ready documents have no children in profile %)', v_missing, v_target.id
        USING ERRCODE = '55000';
    END IF;

    SELECT r.id INTO v_run
    FROM public.chunking_build_runs r
    WHERE r.profile_id = v_target.id AND r.doc_type = v_doc_type
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 1;
    IF v_run IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.chunking_build_gaps g
      JOIN public.documents d ON d.id = g.document_id AND d.is_current AND d.status = 'ready'
      WHERE g.run_id = v_run
    ) THEN
      RAISE EXCEPTION 'chunking_activation_refused:open_gaps (the latest build run of profile % recorded gaps)', v_target.id USING ERRCODE = '55000';
    END IF;

    v_evidence := v_target.eval_evidence;
    IF v_evidence IS NULL OR jsonb_typeof(v_evidence) <> 'object'
       OR (v_evidence ->> 'profile_id') IS DISTINCT FROM v_target.id
       OR (v_evidence ->> 'doc_type') IS DISTINCT FROM v_doc_type THEN
      RAISE EXCEPTION 'chunking_activation_refused:no_evidence' USING ERRCODE = '55000';
    END IF;
    IF (v_evidence -> 'gate_passed') IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'chunking_activation_refused:eval_failed' USING ERRCODE = '55000';
    END IF;

    SELECT r.id INTO v_run
    FROM public.chunking_build_runs r
    WHERE r.profile_id = v_target.id AND r.doc_type = v_doc_type AND r.status = 'completed'
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 1;
    IF (v_evidence ->> 'build_run_id') IS DISTINCT FROM v_run::text THEN
      RAISE EXCEPTION 'chunking_activation_refused:stale_evidence (the decision is not for the latest completed build run)' USING ERRCODE = '55000';
    END IF;
  END IF;

  UPDATE public.chunking_profiles cp SET status = 'ready' WHERE cp.doc_type = v_doc_type AND cp.status = 'active';
  UPDATE public.chunking_profiles cp
  SET status = 'active', previous_active_id = v_active.id, activated_at = now(), activated_by = v_actor
  WHERE cp.id = v_target.id AND cp.doc_type = v_doc_type;

  RETURN QUERY SELECT v_target.id, v_active.id, v_doc_type, true;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_rollback_chunking_profile(p_doc_type text, p_actor text)
RETURNS TABLE (restored_profile text, rolled_back_profile text, doc_type text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '120s'
AS $$
#variable_conflict use_column
DECLARE
  v_actor text;
  v_active public.chunking_profiles%ROWTYPE;
  v_restore public.chunking_profiles%ROWTYPE;
BEGIN
  IF p_actor IS NOT NULL AND p_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_actor: the actor must be a uuid' USING ERRCODE = '22023';
  END IF;
  v_actor := COALESCE(p_actor, 'cli');
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general') THEN
    RAISE EXCEPTION 'invalid_doc_type: unknown doc type' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.chunking_profiles cp WHERE cp.doc_type = p_doc_type ORDER BY cp.id FOR UPDATE;

  SELECT * INTO v_active FROM public.chunking_profiles cp WHERE cp.doc_type = p_doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1;
  IF NOT FOUND OR v_active.id = 'legacy' THEN
    RAISE EXCEPTION 'chunking_activation_refused:no_previous' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_restore FROM public.chunking_profiles cp
  WHERE cp.doc_type = p_doc_type AND cp.id = COALESCE(v_active.previous_active_id, 'legacy') AND cp.status <> 'retired';
  IF NOT FOUND THEN
    SELECT * INTO v_restore FROM public.chunking_profiles cp WHERE cp.doc_type = p_doc_type AND cp.id = 'legacy';
  END IF;

  UPDATE public.chunking_profiles cp SET status = 'ready' WHERE cp.doc_type = p_doc_type AND cp.id = v_active.id;
  UPDATE public.chunking_profiles cp
  SET status = 'active', previous_active_id = NULL, activated_at = now(), activated_by = v_actor
  WHERE cp.doc_type = p_doc_type AND cp.id = v_restore.id;

  RETURN QUERY SELECT v_restore.id, v_active.id, p_doc_type;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_chunking_coverage()
RETURNS TABLE (
  doc_type text,
  profile_id text,
  is_active boolean,
  current_ready_documents integer,
  documents_with_children integer,
  missing_documents integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH ready AS (
    SELECT d.id, d.doc_type FROM public.documents d WHERE d.is_current AND d.status = 'ready'
  ),
  totals AS (
    SELECT r.doc_type, count(*)::integer AS n FROM ready r GROUP BY r.doc_type
  ),
  covered AS (
    SELECT p.doc_type, p.id AS profile_id, count(*)::integer AS n
    FROM public.chunking_profiles p
    JOIN ready r ON r.doc_type = p.doc_type
    WHERE EXISTS (
      SELECT 1 FROM public.document_chunks c
      WHERE c.document_id = r.id AND c.chunking_profile_id = p.id AND c.is_current)
    GROUP BY p.doc_type, p.id
  )
  SELECT
    p.doc_type,
    p.id,
    (p.status = 'active'),
    COALESCE(t.n, 0),
    COALESCE(c.n, 0),
    COALESCE(t.n, 0) - COALESCE(c.n, 0)
  FROM public.chunking_profiles p
  LEFT JOIN totals t ON t.doc_type = p.doc_type
  LEFT JOIN covered c ON c.doc_type = p.doc_type AND c.profile_id = p.id
  ORDER BY p.doc_type, p.id
$$;

-- Per profile: the gaps of the latest build run that still matter (their document is current and ready) and whether the recorded decision
-- passed. Counts and words only; rag:chunking status prints it.
CREATE OR REPLACE FUNCTION public.rag_chunking_profile_state()
RETURNS TABLE (doc_type text, profile_id text, open_gaps integer, evidence text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT
    p.doc_type,
    p.id,
    COALESCE((
      SELECT count(*)::integer
      FROM public.chunking_build_gaps g
      JOIN public.documents d ON d.id = g.document_id AND d.is_current AND d.status = 'ready'
      WHERE g.run_id = (
        SELECT r.id FROM public.chunking_build_runs r
        WHERE r.profile_id = p.id AND r.doc_type = p.doc_type
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT 1)
    ), 0),
    CASE
      WHEN p.eval_evidence IS NULL OR jsonb_typeof(p.eval_evidence) <> 'object' THEN 'none'
      WHEN (p.eval_evidence -> 'gate_passed') = 'true'::jsonb THEN 'passed'
      ELSE 'failed'
    END
  FROM public.chunking_profiles p
  ORDER BY p.doc_type, p.id
$$;

REVOKE ALL ON FUNCTION public.rag_parent_currency_from_document() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_sync_parent_currency() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_sync_parent_currency() TO service_role;

REVOKE ALL ON FUNCTION public.rag_fetch_parents(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fetch_parents(text, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(
  text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(
  text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.rag_create_chunking_profile(text, text, integer, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_record_chunking_decision(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_activate_chunking_profile(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollback_chunking_profile(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_chunking_coverage() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_chunking_profile_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_create_chunking_profile(text, text, integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_record_chunking_decision(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_activate_chunking_profile(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollback_chunking_profile(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_chunking_coverage() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_chunking_profile_state() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

------------------------------------------
-- Phase 3.1: Ingestion queue hardening and chunk writer fix (migrations 0420-0424, after Phase 4 in migration order)
------------------------------------------

-- >>> supabase/migrations/0420_ingestion_queue_retention.sql
-- 0420: Archive and purge terminal ingestion jobs past a retention window (queue hardening).
-- Slim archive rows keep idempotency and citation seams; heavy jsonb is dropped. Service role only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ingestion_jobs_archive (
  id uuid PRIMARY KEY,
  tenant_key text NOT NULL,
  kind text NOT NULL,
  source text,
  source_key text NOT NULL,
  batch_id uuid,
  document_id uuid,
  lineage_id uuid,
  version integer,
  file_sha256 text,
  status text NOT NULL,
  error_class text,
  last_error text,
  trace_id uuid,
  retries integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_jobs_archive_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  )
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_archive_archived_at_idx
  ON public.ingestion_jobs_archive (archived_at DESC);

ALTER TABLE public.ingestion_jobs_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ingestion_jobs_archive FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ingestion_jobs_archive TO service_role;

CREATE OR REPLACE FUNCTION public.rag_purge_stale_ingestion_jobs(
  p_retention_days integer DEFAULT 90,
  p_batch_size integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days integer;
  v_limit integer;
  v_cutoff timestamptz;
  v_archived integer := 0;
  v_purged integer := 0;
  rec record;
BEGIN
  v_days := GREATEST(COALESCE(p_retention_days, 90), 1);
  v_limit := GREATEST(LEAST(COALESCE(p_batch_size, 500), 5000), 1);
  v_cutoff := now() - (v_days || ' days')::interval;

  FOR rec IN
    SELECT j.id
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.updated_at < v_cutoff
       AND (
         j.status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
         OR j.kind = 'delete'
       )
     ORDER BY j.updated_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.ingestion_jobs_archive (
      id, tenant_key, kind, source, source_key, batch_id, document_id, lineage_id, version,
      file_sha256, status, error_class, last_error, trace_id, retries,
      created_at, updated_at, archived_at
    )
    SELECT
      j.id, j.tenant_key, j.kind, j.source, j.source_key, j.batch_id, j.document_id, j.lineage_id, j.version,
      j.file_sha256, j.status, j.error_class, j.error, j.trace_id, j.retries,
      j.created_at, j.updated_at, now()
      FROM public.ingestion_jobs j
     WHERE j.id = rec.id
    ON CONFLICT (id) DO UPDATE SET
      archived_at = EXCLUDED.archived_at,
      status = EXCLUDED.status,
      error_class = EXCLUDED.error_class,
      last_error = EXCLUDED.last_error;

    DELETE FROM public.ingestion_jobs j WHERE j.id = rec.id;
    v_archived := v_archived + 1;
    v_purged := v_purged + 1;
  END LOOP;

  FOR rec IN
    SELECT j.id
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NOT NULL
       AND j.deleted_at < v_cutoff
     ORDER BY j.deleted_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.ingestion_jobs_archive (
      id, tenant_key, kind, source, source_key, batch_id, document_id, lineage_id, version,
      file_sha256, status, error_class, last_error, trace_id, retries,
      created_at, updated_at, archived_at
    )
    SELECT
      j.id, j.tenant_key, j.kind, j.source, j.source_key, j.batch_id, j.document_id, j.lineage_id, j.version,
      j.file_sha256, j.status, j.error_class, j.error, j.trace_id, j.retries,
      j.created_at, j.updated_at, now()
      FROM public.ingestion_jobs j
     WHERE j.id = rec.id
    ON CONFLICT (id) DO UPDATE SET archived_at = EXCLUDED.archived_at;

    DELETE FROM public.ingestion_jobs j WHERE j.id = rec.id;
    v_archived := v_archived + 1;
    v_purged := v_purged + 1;
  END LOOP;

  RETURN jsonb_build_object('archived', v_archived, 'purged', v_purged, 'retention_days', v_days);
END;
$$;

REVOKE ALL ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- >>> supabase/migrations/0421_ingestion_queue_indexes.sql
-- 0421: Partial indexes for ingestion job claim, lease reclaim, and operator listing.

BEGIN;

DROP INDEX IF EXISTS public.ingestion_jobs_queued_claim_idx;
DROP INDEX IF EXISTS public.ingestion_jobs_active_lease_idx;

CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_queued_idx
  ON public.ingestion_jobs (priority DESC, created_at ASC, id)
  WHERE deleted_at IS NULL
    AND kind IN ('ingest', 'dry_run')
    AND status = 'queued';

CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_active_lease_idx
  ON public.ingestion_jobs (lease_until ASC, priority DESC, created_at ASC)
  WHERE deleted_at IS NULL
    AND kind IN ('ingest', 'dry_run')
    AND status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding');

CREATE INDEX IF NOT EXISTS ingestion_jobs_list_created_idx
  ON public.ingestion_jobs (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- >>> supabase/migrations/0422_ingestion_dead_letter.sql
-- 0422: Dead-letter tracking for exhausted ingestion retries (status stays failed).

BEGIN;

DROP FUNCTION IF EXISTS public.rag_fail_ingestion_job(uuid, text, text, boolean);

ALTER TABLE public.ingestion_jobs
  ADD COLUMN IF NOT EXISTS dead_letter_at timestamptz;

ALTER TABLE public.ingestion_jobs_archive
  ADD COLUMN IF NOT EXISTS dead_letter_at timestamptz;

CREATE INDEX IF NOT EXISTS ingestion_jobs_dead_letter_idx
  ON public.ingestion_jobs (dead_letter_at DESC)
  WHERE deleted_at IS NULL AND dead_letter_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.rag_fail_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_error_class text,
  p_retryable boolean,
  p_last_error text DEFAULT NULL
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_terminal boolean;
  v_last text;
BEGIN
  IF p_error_class IS NULL OR btrim(p_error_class) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_error_class' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_new_retries := v_job.retries + 1;
  v_terminal := (NOT p_retryable) OR v_new_retries > v_job.max_retries;
  v_last := COALESCE(NULLIF(btrim(p_last_error), ''), p_error_class);

  IF v_terminal THEN
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs j
       SET status = 'failed',
           error_class = p_error_class,
           error = v_last,
           dead_letter_at = CASE
             WHEN p_retryable AND v_new_retries > j.max_retries THEN now()
             ELSE NULL
           END,
           retries = v_new_retries,
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           run_after = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
    IF v_job.document_id IS NOT NULL THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    END IF;
  ELSE
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs j
       SET status = 'queued',
           error_class = p_error_class,
           error = v_last,
           retries = v_new_retries,
           run_after = now() + (30 * power(2::numeric, j.retries)) * interval '1 second',
           locked_by = NULL,
           lease_until = NULL,
           runner = NULL,
           updated_at = now()
     WHERE j.id = p_job_id
     RETURNING j.* INTO v_job;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_count_ingestion_dead_letters(p_tenant_key text DEFAULT NULL)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::bigint
    FROM public.ingestion_jobs j
   WHERE j.deleted_at IS NULL
     AND j.status = 'failed'
     AND j.dead_letter_at IS NOT NULL
     AND (p_tenant_key IS NULL OR j.tenant_key = p_tenant_key);
$$;

REVOKE ALL ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fail_ingestion_job(uuid, text, text, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.rag_count_ingestion_dead_letters(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_count_ingestion_dead_letters(text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_retry_ingestion_job(p_job_id uuid, p_actor uuid)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
BEGIN
  v_keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.status NOT IN ('failed', 'needs_review') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_retry' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = 'queued',
         retries = 0,
         run_after = NULL,
         error_class = NULL,
         error = NULL,
         dead_letter_at = NULL,
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'retry_ingestion_job',
    COALESCE(v_job.document_id, v_job.id),
    v_job.lineage_id,
    v_job.tenant_key,
    v_job.version,
    p_actor,
    ARRAY[]::text[]
  );

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_retry_ingestion_job(uuid, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- >>> supabase/migrations/0423_ingestion_claim_lease_dead_letter.sql
-- 0423: Dead-letter exhausted jobs when claim reclaims an expired lease.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_jobs(
  p_worker text,
  p_limit integer,
  p_allow_batch boolean,
  p_runner text DEFAULT 'worker'
)
RETURNS SETOF public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed integer := 0;
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_limit integer;
BEGIN
  v_limit := GREATEST(COALESCE(p_limit, 0), 0);
  IF v_limit < 1 THEN
    RETURN;
  END IF;

  WHILE v_claimed < v_limit LOOP
    SELECT j.* INTO v_job
      FROM ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.kind IN ('ingest', 'dry_run')
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
       AND (p_allow_batch OR j.batch_id IS NULL)
       AND (
         (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
         OR (
           j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < now()
         )
       )
       AND (j.batch_id IS NULL OR rag_batch_has_room(j.batch_id))
     ORDER BY j.priority DESC, j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      EXIT;
    END IF;

    IF v_job.batch_id IS NOT NULL AND NOT rag_batch_has_room(v_job.batch_id) THEN
      CONTINUE;
    END IF;

    IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
      v_new_retries := v_job.retries + 1;
      IF v_new_retries > v_job.max_retries THEN
        PERFORM rag_release_job_reservations(v_job.id);
        UPDATE ingestion_jobs
           SET status = 'failed',
               error_class = 'lease_expired',
               error = 'lease expired',
               dead_letter_at = now(),
               retries = v_new_retries,
               locked_by = NULL,
               lease_until = NULL,
               runner = NULL,
               updated_at = now()
         WHERE id = v_job.id;
        CONTINUE;
      END IF;
      PERFORM rag_release_job_reservations(v_job.id);
    END IF;

    UPDATE ingestion_jobs j
       SET status = CASE
             WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
             ELSE j.status
           END,
           retries = CASE
             WHEN j.status = 'queued' THEN j.retries
             ELSE j.retries + 1
           END,
           locked_by = p_worker,
           runner = p_runner,
           lease_until = now() + interval '120 seconds',
           updated_at = now()
     WHERE j.id = v_job.id
     RETURNING j.* INTO v_job;

    v_claimed := v_claimed + 1;
    RETURN NEXT v_job;
  END LOOP;

  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job(
  p_job_id uuid,
  p_worker text,
  p_runner text DEFAULT 'worker'
)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
BEGIN
  SELECT j.* INTO v_job
    FROM ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.deleted_at IS NULL
     AND j.kind IN ('ingest', 'dry_run')
     AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
     AND (
       (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
       OR (
         j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
         AND j.lease_until IS NOT NULL
         AND j.lease_until < now()
       )
     )
   FOR UPDATE OF j SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_job.batch_id IS NOT NULL AND NOT rag_batch_has_room(v_job.batch_id) THEN
    RETURN NULL;
  END IF;

  IF v_job.locked_by IS NOT NULL AND v_job.lease_until IS NOT NULL AND v_job.lease_until > now() THEN
    RETURN NULL;
  END IF;

  IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
    v_new_retries := v_job.retries + 1;
    IF v_new_retries > v_job.max_retries THEN
      PERFORM rag_release_job_reservations(v_job.id);
      UPDATE ingestion_jobs
         SET status = 'failed',
             error_class = 'lease_expired',
             error = 'lease expired',
             dead_letter_at = now(),
             retries = v_new_retries,
             locked_by = NULL,
             lease_until = NULL,
             runner = NULL,
             updated_at = now()
       WHERE id = v_job.id;
      RETURN NULL;
    END IF;
    PERFORM rag_release_job_reservations(v_job.id);
  END IF;

  UPDATE ingestion_jobs j
     SET status = CASE
           WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
           ELSE j.status
         END,
         retries = CASE
           WHEN j.status = 'queued' THEN j.retries
           ELSE j.retries + 1
         END,
         locked_by = p_worker,
         runner = p_runner,
         lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$$;

COMMIT;

-- >>> supabase/migrations/0424_write_chunks_null_vector.sql
-- 0424: rag_write_chunks and rag_write_profile_chunks accept a null vector entry again (reported by 03.1-49).
-- p_embeddings maps a profile id to a list that lines up with the chunks, and a null entry means "no vector for this chunk". The 0408 dims check
-- read "jsonb_typeof(v.value) = 'array' AND jsonb_array_length(v.value) <> dims", but PostgreSQL does not promise to evaluate AND left to
-- right, so a null entry reached jsonb_array_length and the whole write failed with "cannot get array length of a scalar". The length is now
-- taken inside CASE WHEN jsonb_typeof(...) = 'array', which is evaluated in order; the vector-count check uses the same guard.
-- Behaviour is otherwise that of 0408: a null entry writes the chunk without a vector, any other non-array entry raises invalid_embeddings,
-- a vector of the wrong length raises embedding_profile_mismatch, and every refusal rolls the whole call back.
-- Both functions stay SECURITY DEFINER and now run with an empty search_path and schema-qualified names. Server role only.
-- Idempotent: CREATE OR REPLACE with the 0408 signatures, then guarded REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_write_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_chunks jsonb,
  p_embeddings jsonb,
  p_final boolean,
  p_total integer
)
RETURNS TABLE (chunks_written integer, chunks_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc public.documents%ROWTYPE;
  profile_key text;
  profile_row public.embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  chunk_count integer;
  legacy_vectors jsonb;
  written integer := 0;
  deleted integer := 0;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_chunks must be a JSON array';
  END IF;
  chunk_count := jsonb_array_length(p_chunks);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every chunk needs a string content and a numeric chunk_index when it has one';
  END IF;
  IF (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)) <> chunk_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct';
  END IF;
  IF p_final AND (p_total IS NULL OR p_total < 0) THEN
    RAISE EXCEPTION 'invalid_total: p_total is required with p_final';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF COALESCE(CASE WHEN jsonb_typeof(vectors) = 'array' THEN jsonb_array_length(vectors) END, -1) <> chunk_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE CASE WHEN jsonb_typeof(v.value) = 'array' THEN jsonb_array_length(v.value) END <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  -- A chunk whose text changed must not keep a vector made from the old text.
  DELETE FROM public.chunk_embeddings ce
  USING public.document_chunks c, jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      (e.ord - 1)::integer AS position,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::public.vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO public.document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS written = ROW_COUNT;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::public.halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM public.embedding_backfill_gaps g
      USING jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    DELETE FROM public.document_chunks c WHERE c.document_id = p_document_id AND c.chunking_profile_id = 'legacy' AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_write_profile_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_profile_id text,
  p_parents jsonb,
  p_children jsonb,
  p_embeddings jsonb,
  p_final boolean DEFAULT true,
  p_total integer DEFAULT NULL
)
RETURNS TABLE (parents_written integer, children_written integer, parents_deleted integer, children_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc public.documents%ROWTYPE;
  chunking public.chunking_profiles%ROWTYPE;
  parents jsonb := COALESCE(p_parents, '[]'::jsonb);
  profile_key text;
  profile_row public.embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  parent_count integer;
  child_count integer;
  legacy_vectors jsonb;
  total integer;
  parents_in integer := 0;
  children_in integer := 0;
  parents_out integer := 0;
  children_out integer := 0;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_profile_id IS NULL OR p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_profile' USING DETAIL = 'legacy chunks are written by rag_write_chunks';
  END IF;
  SELECT * INTO chunking FROM public.chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = doc.doc_type AND cp.status <> 'retired';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chunking_profile_unsupported' USING DETAIL = 'no live profile of this id for the document type';
  END IF;

  IF jsonb_typeof(parents) <> 'array' THEN
    RAISE EXCEPTION 'invalid_parents: p_parents must be a JSON array';
  END IF;
  IF p_children IS NULL OR jsonb_typeof(p_children) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_children must be a JSON array';
  END IF;
  parent_count := jsonb_array_length(parents);
  child_count := jsonb_array_length(p_children);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e.value -> 'parent_index') IS DISTINCT FROM 'number'
       OR jsonb_typeof(e.value -> 'token_count') IS DISTINCT FROM 'number'
       OR (e.value ? 'section_path' AND jsonb_typeof(e.value -> 'section_path') <> 'array')
  ) THEN
    RAISE EXCEPTION 'invalid_parents: every parent needs a string content, a numeric parent_index and a numeric token_count';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$' OR (e.value ->> 'token_count') !~ '^[0-9]{1,9}$'
  ) OR (SELECT count(DISTINCT (e.value ->> 'parent_index')::integer) FROM jsonb_array_elements(parents) AS e(value)) <> parent_count THEN
    RAISE EXCEPTION 'invalid_parents: parent_index values must be distinct non-negative integers and token_count a non-negative integer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
       OR (e.value ? 'parent_index' AND jsonb_typeof(e.value -> 'parent_index') NOT IN ('number', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every child needs a string content, and a numeric chunk_index and parent_index when it has them';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
    WHERE COALESCE(e.value ->> 'chunk_index', (e.ord - 1)::text) !~ '^[0-9]{1,9}$'
       OR (jsonb_typeof(e.value -> 'parent_index') = 'number' AND (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$')
  ) OR (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)) <> child_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct non-negative integers';
  END IF;
  IF p_final AND p_total IS NOT NULL AND p_total < 0 THEN
    RAISE EXCEPTION 'invalid_total: p_total must not be negative';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF COALESCE(CASE WHEN jsonb_typeof(vectors) = 'array' THEN jsonb_array_length(vectors) END, -1) <> child_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', child_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE CASE WHEN jsonb_typeof(v.value) = 'array' THEN jsonb_array_length(v.value) END <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.document_parents AS dp (
    id, document_id, tenant_key, organization_id, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    doc.tenant_key,
    doc.organization_id,
    doc.version,
    true,
    p_profile_id,
    CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END,
    e.value ->> 'content',
    (e.value ->> 'token_count')::integer,
    (e.value ->> 'parent_index')::integer
  FROM jsonb_array_elements(parents) AS e(value)
  ON CONFLICT (id) DO UPDATE SET
    tenant_key = EXCLUDED.tenant_key,
    organization_id = EXCLUDED.organization_id,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    chunking_profile_id = EXCLUDED.chunking_profile_id,
    section_path = EXCLUDED.section_path,
    content = EXCLUDED.content,
    token_count = EXCLUDED.token_count,
    parent_index = EXCLUDED.parent_index
  WHERE dp.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS parents_in = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value -> 'parent_index') = 'number'
      AND NOT EXISTS (
        SELECT 1 FROM public.document_parents dp
        WHERE dp.id = substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
          AND dp.document_id = p_document_id
          AND dp.chunking_profile_id = p_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: parent_index names a parent that was not written';
  END IF;

  -- A child whose text changed must not keep a vector made from the old text.
  DELETE FROM public.chunk_embeddings ce
  USING public.document_chunks c, jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.chunking_profile_id = p_profile_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN jsonb_typeof(e.value -> 'parent_index') = 'number'
           THEN substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
      END AS parent_id,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::public.vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text
    FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO public.document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text, parent_id, chunking_profile_id
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':child:' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version,
        'chunking_profile_id', p_profile_id)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text,
    p.parent_id,
    p_profile_id
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text,
    parent_id = EXCLUDED.parent_id,
    chunking_profile_id = EXCLUDED.chunking_profile_id
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS children_in = ROW_COUNT;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::public.halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM public.embedding_backfill_gaps g
      USING jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    total := COALESCE(p_total, child_count);
    DELETE FROM public.document_chunks c
    WHERE c.document_id = p_document_id AND c.chunking_profile_id = p_profile_id AND c.chunk_index >= total;
    GET DIAGNOSTICS children_out = ROW_COUNT;
    DELETE FROM public.document_parents dp
    WHERE dp.document_id = p_document_id
      AND dp.chunking_profile_id = p_profile_id
      AND NOT EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.parent_id = dp.id);
    GET DIAGNOSTICS parents_out = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT parents_in, children_in, parents_out, children_out;
END
$$;

DO $write_chunks_null_acl$
BEGIN
  IF to_regprocedure('public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) TO service_role;
  END IF;
END
$write_chunks_null_acl$;

COMMIT;

------------------------------------------
-- Phase 4 gap closure: empty search_path for SECURITY DEFINER, trigger and post-Phase-3 functions (migration 0425, plan 04-47, after 0424)
------------------------------------------

-- >>> supabase/migrations/0425_search_path_empty.sql
-- 0425: empty search_path for every public SECURITY DEFINER function, every trigger function and every
-- function created from 0301 on (Phase 4 gap closure, plan 04-47). 0411 and the Phase 3, 3.1 and 4 migrations fixed search_path to
-- pg_catalog, public or to public (a few legacy functions to public, pg_temp, three multi-tenant legacy triggers to nothing), and a trigger
-- runs with the search_path of the statement that fired it, so a trigger without its own path breaks under an empty-path writer.
-- search_path = '' does not take pg_temp out of the path: when pg_temp is not listed, PostgreSQL still searches it first for relations and
-- types, before pg_catalog. So '' alone does not stop a temporary table from shadowing a name; qualifying every relation does, and the bodies
-- therefore name catalog tables pg_catalog.pg_attribute and pg_catalog.pg_extension as well. Functions and operators are never looked up in
-- pg_temp. Each function below is replaced with SET search_path = '' and a body that differs from the one it replaces only by schema-qualified
-- names: public. tables, row types, functions and the vector and halfvec types, OPERATOR(public.<=>) for pgvector (both setup files install
-- vector in public), and pg_catalog. catalog tables. Signature, defaults, volatility, SECURITY mode, owner and grants are unchanged: CREATE OR
-- REPLACE keeps the ACL and this file issues no GRANT or REVOKE. The first block stops with 55000 unless pgvector is in schema public (the
-- bodies name public.vector and OPERATOR(public.<=>)) and every function already exists, so the file never creates one with default PUBLIC
-- execute. tests/rag-db/search-path-empty.test.mts. Idempotent: CREATE OR REPLACE only.

BEGIN;

DO $search_path_precheck$
DECLARE
  v_missing text[];
  v_vector_schema text;
BEGIN
  SELECT n.nspname INTO v_vector_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';
  IF v_vector_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION '0425: pgvector must be in schema public, found %; check with: SELECT extname, extnamespace::regnamespace FROM pg_catalog.pg_extension WHERE extname = ''vector''',
      COALESCE(v_vector_schema, 'no vector extension') USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(s.sig ORDER BY s.sig) INTO v_missing
  FROM pg_catalog.unnest(ARRAY[
    'public.check_admin_status()',
    'public.get_nango_stats(uuid)',
    'public.is_admin(uuid)',
    'public.is_subscribed(uuid)',
    'public.match_chunks_by_profile(text,text,integer,public.halfvec,integer,double precision,boolean)',
    'public.rag_activate_embedding_profile(text,text)',
    'public.rag_admin_audit_immutable()',
    'public.rag_admin_document_scope(uuid,uuid)',
    'public.rag_advance_ingestion_job(uuid,text,text,text,jsonb,integer,jsonb)',
    'public.rag_batch_has_room(uuid)',
    'public.rag_batch_progress(uuid)',
    'public.rag_begin_document_version(text,uuid,uuid,text,text,text,text,text,text,text,integer,boolean)',
    'public.rag_chunk_embeddings_guard()',
    'public.rag_chunks_legacy_defaults()',
    'public.rag_chunks_lexical_tsv()',
    'public.rag_chunks_profile_status()',
    'public.rag_claim_ingestion_job(uuid,text,text)',
    'public.rag_claim_ingestion_jobs(text,integer,boolean,text)',
    'public.rag_create_ingestion_batch(text,text,text,numeric,integer,text,text)',
    'public.rag_delete_doc_type_default(text,text,text)',
    'public.rag_delete_ingestion_job(uuid,uuid)',
    'public.rag_delete_quarantined(uuid,uuid)',
    'public.rag_doc_type_tenant_key_ok(text)',
    'public.rag_documents_legacy_defaults()',
    'public.rag_enqueue_backfill_jobs(uuid,jsonb)',
    'public.rag_enqueue_ingestion_job(text,text,text,text,text,text,text,jsonb,jsonb,integer,uuid,uuid,text)',
    'public.rag_exact_id_documents(text,text[],integer)',
    'public.rag_existing_file_hashes(text,text[])',
    'public.rag_find_content_duplicate(text,text,uuid)',
    'public.rag_find_invoices(text,text,date,date,numeric,numeric,text,integer)',
    'public.rag_get_doc_type_defaults(text,text,text,text)',
    'public.rag_get_document_for_type_change(uuid,text)',
    'public.rag_get_ingest_document(uuid,text)',
    'public.rag_get_ingest_origin(uuid,text)',
    'public.rag_get_ingestion_job(uuid,text)',
    'public.rag_get_ingestion_job_internal(uuid)',
    'public.rag_get_job_for_document(uuid,text)',
    'public.rag_get_parse_tier_overrides()',
    'public.rag_heartbeat_ingestion_job(uuid,text)',
    'public.rag_ingest_assert_job_lease(public.ingestion_jobs,text)',
    'public.rag_ingest_assert_tenant_key(text)',
    'public.rag_ingest_broadcast_job(public.ingestion_jobs)',
    'public.rag_ingest_job_status_for_stage(text)',
    'public.rag_ingest_mirror_processing_status(text)',
    'public.rag_latest_backfill_runs(text)',
    'public.rag_lexical_tsquery(text[])',
    'public.rag_lexical_tsvector(text)',
    'public.rag_list_batch_jobs(uuid,text,uuid,integer)',
    'public.rag_list_chunking_profiles()',
    'public.rag_list_embedding_profiles()',
    'public.rag_list_ingestion_jobs(text,text[],text,integer,integer)',
    'public.rag_list_quarantine(uuid,integer,integer)',
    'public.rag_mark_document_failed(uuid,text,text)',
    'public.rag_open_embed_batches(uuid)',
    'public.rag_parse_budget_month(text)',
    'public.rag_parse_cache_assert_key_parts(text,text)',
    'public.rag_parse_cache_for_document(text,uuid)',
    'public.rag_parse_cache_lookup(uuid,text,text,text)',
    'public.rag_parse_cache_prefix(uuid,text,text,text)',
    'public.rag_parse_cache_put(uuid,text,text,text,text,jsonb,bigint)',
    'public.rag_parse_cache_version_segment(text)',
    'public.rag_parse_doc_type_ok(text)',
    'public.rag_parse_tier_rank(text)',
    'public.rag_publish_document_version(uuid,text)',
    'public.rag_rechunk_advance(uuid,uuid)',
    'public.rag_rechunk_documents(text,text,text,uuid,integer)',
    'public.rag_rechunk_finish_run(uuid,text)',
    'public.rag_rechunk_gaps(uuid)',
    'public.rag_rechunk_get_run(uuid)',
    'public.rag_rechunk_missing(text,text,text)',
    'public.rag_rechunk_record_gap(uuid,uuid,text,text)',
    'public.rag_rechunk_resume_run(uuid)',
    'public.rag_rechunk_start_run(text,text,text,boolean)',
    'public.rag_record_backfill_gap(uuid,uuid[],text,text,text)',
    'public.rag_record_embed_batch(uuid,text,text,text,text,integer,text)',
    'public.rag_record_eval_evidence(text,jsonb,text)',
    'public.rag_record_parse_attempt(uuid,text,jsonb)',
    'public.rag_reembed_count(text,text)',
    'public.rag_reembed_derive_batch(uuid,integer)',
    'public.rag_reembed_finish_run(uuid,text)',
    'public.rag_reembed_get_run(uuid)',
    'public.rag_reembed_legacy_guard()',
    'public.rag_reembed_missing_batch(uuid,uuid,integer)',
    'public.rag_reembed_next_batch(uuid,uuid,integer)',
    'public.rag_reembed_pick(text,text,uuid,integer)',
    'public.rag_reembed_preview_batch(text,text,uuid,integer)',
    'public.rag_reembed_remaining(uuid)',
    'public.rag_reembed_resume_run(uuid,text)',
    'public.rag_reembed_rollback_run(uuid,text)',
    'public.rag_reembed_start_run(text,text,text,text)',
    'public.rag_reembed_write_batch(uuid,jsonb,uuid,bigint)',
    'public.rag_release_ingestion_job(uuid,text)',
    'public.rag_release_job_reservations(uuid)',
    'public.rag_release_parse_budget(uuid,integer,text)',
    'public.rag_release_quarantine(uuid,uuid)',
    'public.rag_relex_batch(jsonb,integer)',
    'public.rag_relex_candidates(uuid,integer,integer,text)',
    'public.rag_reserve_batch_budget(uuid,numeric)',
    'public.rag_reserve_parse_budget(uuid,integer,integer,text,integer)',
    'public.rag_rollback_embedding_profile(text)',
    'public.rag_save_ingest_state(uuid,text,text,jsonb)',
    'public.rag_set_doc_type_default(text,text,text,text,text)',
    'public.rag_set_document_fields(uuid,text,jsonb)',
    'public.rag_set_document_parse_cache(uuid,uuid)',
    'public.rag_set_embedding_profile_status(text,text,text)',
    'public.rag_set_parse_tier_override(text,text,text,uuid)',
    'public.rag_settle_parse_budget(uuid,integer,text,integer)',
    'public.rag_update_embed_batch(uuid,text,text,text,text,text)',
    'public.rag_update_ingestion_batch(uuid,text,jsonb,jsonb)',
    'public.set_last_updated_timestamp()',
    'public.update_updated_at_column()'
  ]::text[]) AS s(sig)
  WHERE pg_catalog.to_regprocedure(s.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0425: apply the earlier migrations first, these functions are missing: %', v_missing USING ERRCODE = '55000';
  END IF;
END
$search_path_precheck$;

CREATE OR REPLACE FUNCTION public.check_admin_status()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin_users WHERE id = auth.uid()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_nango_stats(p_user_id uuid)
 RETURNS TABLE(provider text, status text, last_sync_at timestamp with time zone, synced_files_count bigint, failed_files_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    nc.provider,
    nc.status,
    nc.last_sync_at,
    COUNT(CASE WHEN nsr.status = 'completed' THEN 1 END) AS synced_files_count,
    COUNT(CASE WHEN nsr.status = 'failed' THEN 1 END) AS failed_files_count
  FROM public.nango_connections nc
  LEFT JOIN public.nango_sync_records nsr
    ON nc.connection_id = nsr.connection_id AND nsr.user_id = nc.user_id
  WHERE nc.user_id = p_user_id
    AND (p_user_id = auth.uid() OR auth.role() = 'service_role')
  GROUP BY nc.provider, nc.status, nc.last_sync_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin(user_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin_users WHERE id = user_uuid
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_subscribed(user_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN COALESCE(
    (user_uuid = auth.uid() OR auth.role() = 'service_role')
    AND EXISTS (
      SELECT 1
      FROM public.subscriptions
      WHERE user_id = user_uuid
      AND status = 'active'
      AND plan_type IN ('pro', 'enterprise')
    ),
    false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_chunks_by_profile(p_tenant_key text, p_profile_id text, p_dims integer, p_query public.halfvec, p_match_count integer, p_min_similarity double precision, p_require_active boolean DEFAULT true)
 RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dims integer;
  v_status text;
  v_version text;
BEGIN
  SELECT p.dims, p.status INTO v_dims, v_status FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF v_dims IS NULL THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF v_dims <> p_dims OR public.vector_dims(p_query) <> v_dims THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;
  IF p_require_active AND v_status <> 'active' THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: profile not active' USING ERRCODE = '22000';
  END IF;

  SELECT extversion INTO v_version FROM pg_catalog.pg_extension WHERE extname = 'vector';
  IF v_version IS NOT NULL AND (string_to_array(v_version, '.'))[1:2]::int[] >= ARRAY[0, 8] THEN
    PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT c.id, c.document_id, c.content,
           1 - ((e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)) AS similarity,
           c.metadata
    FROM public.chunk_embeddings e
    JOIN public.document_chunks c ON c.id = e.chunk_id
    WHERE e.profile_id = %2$L
      AND e.tenant_key = $2
      AND c.is_current AND c.status = 'ready'
      AND 1 - ((e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)) > $3
    ORDER BY (e.embedding::public.halfvec(%1$s)) OPERATOR(public.<=>) $1::public.halfvec(%1$s)
    LIMIT $4
  $q$, v_dims, p_profile_id)
  USING p_query, p_tenant_key, p_min_similarity, p_match_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_activate_embedding_profile(p_target text, p_actor text)
 RETURNS TABLE(activated_profile text, previous_profile text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_target public.embedding_profiles%ROWTYPE;
  v_active text;
  v_missing bigint;
  v_bad bigint;
  v_evidence jsonb;
  v_recorded timestamptz;
  v_last timestamptz;
  v_slice_ok boolean;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'activation_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_target FROM public.embedding_profiles WHERE id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_target.status = 'active' THEN
    RAISE EXCEPTION 'activation_refused: already_active' USING ERRCODE = '55000';
  END IF;
  SELECT p.id INTO v_active FROM public.embedding_profiles p WHERE p.status = 'active';

  IF v_target.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p_target);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'activation_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, p_target
      USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    SELECT count(*) INTO v_bad FROM public.chunk_embeddings e
    WHERE e.profile_id = p_target AND (e.embedding_model <> v_target.model OR e.dims <> v_target.dims);
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'activation_refused: model_mismatch (% rows of profile % differ from model % at % dims)', v_bad, p_target, v_target.model, v_target.dims
        USING ERRCODE = '55000';
    END IF;
  END IF;

  v_evidence := v_target.eval_evidence;
  IF v_evidence IS NULL OR jsonb_typeof(v_evidence) <> 'object' THEN
    RAISE EXCEPTION 'activation_refused: eval_missing' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'target_profile' IS DISTINCT FROM p_target THEN
    RAISE EXCEPTION 'activation_refused: eval_target_mismatch' USING ERRCODE = '55000';
  END IF;
  IF v_evidence->>'baseline_profile' IS DISTINCT FROM v_active THEN
    RAISE EXCEPTION 'activation_refused: eval_baseline_mismatch (evidence baseline %, active profile %)', v_evidence->>'baseline_profile', v_active
      USING ERRCODE = '55000';
  END IF;
  IF v_evidence->'gate_passed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'activation_refused: eval_failed' USING ERRCODE = '55000';
  END IF;
  v_slice_ok := coalesce(v_evidence#>'{pre_migration,passed}' = 'true'::jsonb, false)
    AND coalesce(CASE WHEN jsonb_typeof(v_evidence#>'{pre_migration,n}') = 'number' THEN (v_evidence#>>'{pre_migration,n}')::numeric >= 1 END, false);
  IF NOT v_slice_ok THEN
    RAISE EXCEPTION 'activation_refused: pre_migration_missing' USING ERRCODE = '55000';
  END IF;

  IF v_target.storage <> 'legacy_column' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.embedding_backfill_runs r
      WHERE r.id::text = v_evidence->>'backfill_run_id' AND r.profile_id = p_target AND r.status = 'completed'
    ) THEN
      RAISE EXCEPTION 'activation_refused: eval_run_mismatch' USING ERRCODE = '55000';
    END IF;
    SELECT max(e.embedded_at) INTO v_last FROM public.chunk_embeddings e WHERE e.profile_id = p_target;
  ELSE
    SELECT max(c.created_at) INTO v_last FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NOT NULL;
  END IF;

  BEGIN
    v_recorded := (v_evidence->>'recorded_at')::timestamptz;
  EXCEPTION WHEN others THEN
    v_recorded := NULL;
  END;
  IF v_recorded IS NULL OR (v_last IS NOT NULL AND v_recorded < v_last) THEN
    RAISE EXCEPTION 'activation_refused: eval_stale (evidence recorded %, data embedded %)', v_recorded, v_last USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET status = 'available' WHERE status = 'active';
  UPDATE public.embedding_profiles
  SET status = 'active', previous_active_id = v_active, activated_at = now(), activated_by = p_actor
  WHERE id = p_target;

  RETURN QUERY SELECT p_target, v_active;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_admin_audit_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'rag_admin_audit is append-only';
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_admin_document_scope(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(tenant_key text, user_id uuid, organization_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  SELECT d.tenant_key, d.user_id, d.organization_id
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = ANY (keys);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_advance_ingestion_job(p_job_id uuid, p_worker text, p_stage text, p_status text, p_stage_state jsonb DEFAULT NULL::jsonb, p_timing_ms integer DEFAULT NULL::integer, p_fields jsonb DEFAULT '{}'::jsonb)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_expected text;
  v_timings jsonb;
  v_key text;
  v_value jsonb;
  v_whitelist text[] := ARRAY[
    'doc_class', 'tier', 'parser_used', 'parser_version', 'pages', 'page_ranges',
    'tier_page_counts', 'detect_counts', 'preflight_ref', 'est_cost_usd', 'embedding_profile',
    'document_id', 'needs_review_reason', 'routing_note', 'provisional_published_at', 'trace_id'
  ];
  v_terminal boolean;
  v_mirror text;
BEGIN
  IF p_stage IS NULL OR btrim(p_stage) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  v_expected := public.rag_ingest_job_status_for_stage(p_stage);
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status <> v_expected THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_stage' USING ERRCODE = '22023';
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) = 'object' THEN
    FOR v_key IN SELECT jsonb_object_keys(p_fields)
    LOOP
      IF NOT (v_key = ANY (v_whitelist)) THEN
        RAISE EXCEPTION 'ingest_refused: field_not_allowed' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_timings := COALESCE(v_job.timings, '{}'::jsonb);
  IF p_timing_ms IS NOT NULL AND p_stage IS NOT NULL THEN
    v_timings := v_timings || jsonb_build_object(
      p_stage,
      COALESCE((v_timings ->> p_stage)::bigint, 0) + p_timing_ms
    );
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = p_status,
         stage = p_stage,
         timings = v_timings,
         stage_state = CASE WHEN p_stage_state IS NOT NULL THEN p_stage_state ELSE j.stage_state END,
         doc_class = COALESCE(p_fields ->> 'doc_class', j.doc_class),
         tier = COALESCE(p_fields ->> 'tier', j.tier),
         parser_used = COALESCE(p_fields ->> 'parser_used', j.parser_used),
         parser_version = COALESCE(p_fields ->> 'parser_version', j.parser_version),
         pages = COALESCE((p_fields ->> 'pages')::integer, j.pages),
         page_ranges = CASE WHEN p_fields ? 'page_ranges' THEN p_fields -> 'page_ranges' ELSE j.page_ranges END,
         tier_page_counts = CASE WHEN p_fields ? 'tier_page_counts' THEN p_fields -> 'tier_page_counts' ELSE j.tier_page_counts END,
         detect_counts = CASE WHEN p_fields ? 'detect_counts' THEN p_fields -> 'detect_counts' ELSE j.detect_counts END,
         preflight_ref = COALESCE(p_fields ->> 'preflight_ref', j.preflight_ref),
         est_cost_usd = COALESCE((p_fields ->> 'est_cost_usd')::numeric, j.est_cost_usd),
         embedding_profile = COALESCE(p_fields ->> 'embedding_profile', j.embedding_profile),
         document_id = CASE
           WHEN j.document_id IS NULL AND p_fields ? 'document_id'
           THEN (p_fields ->> 'document_id')::uuid
           ELSE j.document_id
         END,
         needs_review_reason = COALESCE(p_fields ->> 'needs_review_reason', j.needs_review_reason),
         routing_note = COALESCE(p_fields ->> 'routing_note', j.routing_note),
         provisional_published_at = CASE
           WHEN p_fields ? 'provisional_published_at'
           THEN (p_fields ->> 'provisional_published_at')::timestamptz
           ELSE j.provisional_published_at
         END,
         trace_id = CASE WHEN p_fields ? 'trace_id' THEN (p_fields ->> 'trace_id')::uuid ELSE j.trace_id END,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  v_terminal := p_status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate');
  IF v_terminal THEN
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs
       SET locked_by = NULL, lease_until = NULL, runner = NULL
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    v_mirror := public.rag_ingest_mirror_processing_status(v_job.status);
    IF v_mirror IS NOT NULL THEN
      UPDATE public.documents d
         SET processing_status = v_mirror
       WHERE d.id = v_job.document_id
         AND d.tenant_key = v_job.tenant_key;
    END IF;
    IF p_status = 'ready' THEN
      UPDATE public.documents d SET status = 'ready' WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    ELSIF p_status IN ('failed', 'quarantined') THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'needs_review' THEN
      UPDATE public.documents d
         SET status = 'ready',
             needs_review = true,
             needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    END IF;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_batch_has_room(p_batch_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_concurrency integer;
  v_leased integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RETURN true;
  END IF;
  SELECT b.concurrency INTO v_concurrency
    FROM public.ingestion_batches b
   WHERE b.id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT count(*)::integer INTO v_leased
    FROM public.ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();
  RETURN v_leased < v_concurrency;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_batch_progress(p_batch_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_spent numeric;
  v_leased integer;
  v_counts jsonb := '{}'::jsonb;
  rec record;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.spent_usd INTO v_spent FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT count(*)::integer INTO v_leased
    FROM public.ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now();

  FOR rec IN
    SELECT j.kind,
           CASE WHEN j.status = 'embedding' AND j.stage = 'embed_deferred' THEN 'embed_deferred' ELSE j.status END AS status,
           count(*)::integer AS n
      FROM public.ingestion_jobs j
     WHERE j.batch_id = p_batch_id AND j.deleted_at IS NULL
     GROUP BY 1, 2
     ORDER BY 1, 2
  LOOP
    IF NOT v_counts ? rec.kind THEN
      v_counts := jsonb_set(v_counts, ARRAY[rec.kind], '{}'::jsonb, true);
    END IF;
    v_counts := jsonb_set(v_counts, ARRAY[rec.kind, rec.status], to_jsonb(rec.n), true);
  END LOOP;

  RETURN jsonb_build_object(
    'spent_usd', COALESCE(v_spent, 0),
    'leased', COALESCE(v_leased, 0),
    'counts', v_counts
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_begin_document_version(p_tenant_key text, p_user_id uuid, p_org_id uuid, p_source text, p_source_key text, p_filename text, p_file_sha256 text, p_doc_type text, p_doc_type_origin text, p_profile_id text, p_profile_version integer, p_force_new_version boolean DEFAULT false)
 RETURNS TABLE(outcome text, document_id uuid, version integer, lineage_id uuid, duplicate_of uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  multi_tenant boolean;
  expected_key text;
  duplicate_id uuid;
  existing record;
  previous record;
  new_id uuid := gen_random_uuid();
  new_version integer;
  new_lineage uuid;
  carried jsonb := '{}'::jsonb;
  forced boolean := COALESCE(p_force_new_version, false);
BEGIN
  IF p_tenant_key IS NULL OR p_source_key IS NULL OR p_source_key = '' THEN
    RAISE EXCEPTION 'invalid_argument: p_tenant_key and p_source_key are required';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    RAISE EXCEPTION 'invalid_source: %', COALESCE(p_source, '(null)');
  END IF;

  -- user_id is NOT NULL in the multi-tenant schema and nullable in the single-tenant one.
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    expected_key := CASE WHEN p_org_id IS NOT NULL THEN 'o:' || p_org_id::text ELSE 'u:' || p_user_id::text END;
  ELSE
    expected_key := 's:default';
  END IF;
  IF p_tenant_key IS DISTINCT FROM expected_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'p_tenant_key is not the tenant key of the given user and organization';
  END IF;
  IF multi_tenant AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_user_id is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_key || '|' || p_source || '|' || p_source_key, 0));

  IF p_file_sha256 IS NOT NULL AND NOT forced THEN
    SELECT d.id INTO duplicate_id
    FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.file_sha256 = p_file_sha256 AND d.is_current AND d.status = 'ready'
    ORDER BY d.created_at, d.id
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'skipped_duplicate'::text, NULL::uuid, NULL::integer, NULL::uuid, duplicate_id;
      RETURN;
    END IF;
  END IF;

  SELECT d.id, d.version, d.lineage_id INTO existing
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
    AND d.status = 'processing' AND NOT d.is_current AND d.file_sha256 IS NOT DISTINCT FROM p_file_sha256
    AND (NOT forced OR d.doc_type = COALESCE(p_doc_type, 'general'))
  ORDER BY d.version DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'resumed'::text, existing.id, existing.version, existing.lineage_id, NULL::uuid;
    RETURN;
  END IF;

  SELECT d.lineage_id, d.metadata INTO previous
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.source = p_source AND d.source_key = p_source_key
  ORDER BY d.is_current DESC, d.version DESC, d.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    new_lineage := previous.lineage_id;
    SELECT COALESCE(max(d.version), 0) + 1 INTO new_version FROM public.documents d WHERE d.lineage_id = new_lineage;
    IF previous.metadata ? 'external_url' THEN
      carried := jsonb_build_object('external_url', previous.metadata -> 'external_url');
    END IF;
  ELSE
    new_lineage := new_id;
    new_version := 1;
  END IF;

  INSERT INTO public.documents (
    id, lineage_id, version, is_current, status, source, source_key, filename, content, metadata,
    user_id, organization_id, file_sha256, doc_type, doc_type_origin, processing_profile_id, processing_profile_version
  ) VALUES (
    new_id, new_lineage, new_version, false, 'processing', p_source, p_source_key, COALESCE(NULLIF(p_filename, ''), p_source_key), '', carried,
    CASE WHEN multi_tenant THEN p_user_id END, CASE WHEN multi_tenant THEN p_org_id END, p_file_sha256,
    COALESCE(p_doc_type, 'general'), COALESCE(p_doc_type_origin, 'fallback'), p_profile_id, p_profile_version
  );

  RETURN QUERY SELECT 'created'::text, new_id, new_version, new_lineage, NULL::uuid;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunk_embeddings_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dims integer;
  v_tenant text;
BEGIN
  SELECT p.dims INTO v_dims FROM public.embedding_profiles p WHERE p.id = NEW.profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF public.vector_dims(NEW.embedding) <> v_dims THEN
    RAISE EXCEPTION 'expected % dimensions, not %', v_dims, public.vector_dims(NEW.embedding) USING ERRCODE = '22000';
  END IF;

  SELECT c.tenant_key INTO v_tenant FROM public.document_chunks c WHERE c.id = NEW.chunk_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'chunk_embeddings: chunk % has no tenant_key', NEW.chunk_id USING ERRCODE = '23502';
  END IF;
  NEW.tenant_key := v_tenant;
  NEW.dims := public.vector_dims(NEW.embedding);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunks_legacy_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  parent record;
  legacy_shape boolean := NEW.tenant_key IS NULL;
BEGIN
  -- SECURITY DEFINER so the lookup does not depend on what the inserting role may read: the chunk's tenant_key is always its document's,
  -- whatever the writer sent. Every other denormalised column only fills a NULL.
  SELECT d.tenant_key, d.version, d.doc_type, d.doc_date, d.language, d.source, d.parser_used
  INTO parent
  FROM public.documents d
  WHERE d.id = NEW.document_id;
  IF FOUND THEN
    NEW.tenant_key := parent.tenant_key;
    NEW.version := COALESCE(NEW.version, parent.version);
    NEW.doc_type := COALESCE(NEW.doc_type, parent.doc_type);
    NEW.doc_date := COALESCE(NEW.doc_date, parent.doc_date);
    NEW.language := COALESCE(NEW.language, parent.language);
    NEW.source := COALESCE(NEW.source, parent.source);
    NEW.parser_used := COALESCE(NEW.parser_used, parent.parser_used);
  END IF;

  IF legacy_shape AND NEW.chunk_kind = 'text' AND NEW.metadata->'image_url' IS NOT NULL THEN
    NEW.chunk_kind := 'image';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunks_lexical_tsv()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_meta_version text;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.lexical_text IS DISTINCT FROM OLD.lexical_text THEN
    NEW.lexical_tsv := public.rag_lexical_tsvector(NEW.lexical_text);
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    ELSE
      NEW.lexical_version := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    v_meta_version := NEW.metadata ->> 'lexical_version';
    IF v_meta_version ~ '^[1-9][0-9]*$' THEN
      NEW.lexical_version := v_meta_version::integer;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_chunks_profile_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.chunking_profile_id IS DISTINCT FROM 'legacy' AND NEW.status = 'ready' THEN
    NEW.status := 'variant';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job(p_job_id uuid, p_worker text, p_runner text DEFAULT 'worker'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
BEGIN
  SELECT j.* INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.deleted_at IS NULL
     AND j.kind IN ('ingest', 'dry_run')
     AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
     AND (
       (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
       OR (
         j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
         AND j.lease_until IS NOT NULL
         AND j.lease_until < now()
       )
     )
   FOR UPDATE OF j SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
    RETURN NULL;
  END IF;

  IF v_job.locked_by IS NOT NULL AND v_job.lease_until IS NOT NULL AND v_job.lease_until > now() THEN
    RETURN NULL;
  END IF;

  IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
    v_new_retries := v_job.retries + 1;
    IF v_new_retries > v_job.max_retries THEN
      PERFORM public.rag_release_job_reservations(v_job.id);
      UPDATE public.ingestion_jobs
         SET status = 'failed',
             error_class = 'lease_expired',
             error = 'lease expired',
             dead_letter_at = now(),
             retries = v_new_retries,
             locked_by = NULL,
             lease_until = NULL,
             runner = NULL,
             updated_at = now()
       WHERE id = v_job.id;
      RETURN NULL;
    END IF;
    PERFORM public.rag_release_job_reservations(v_job.id);
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = CASE
           WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
           ELSE j.status
         END,
         retries = CASE
           WHEN j.status = 'queued' THEN j.retries
           ELSE j.retries + 1
         END,
         locked_by = p_worker,
         runner = p_runner,
         lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_jobs(p_worker text, p_limit integer, p_allow_batch boolean, p_runner text DEFAULT 'worker'::text)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed integer := 0;
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_limit integer;
BEGIN
  v_limit := GREATEST(COALESCE(p_limit, 0), 0);
  IF v_limit < 1 THEN
    RETURN;
  END IF;

  WHILE v_claimed < v_limit LOOP
    SELECT j.* INTO v_job
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.kind IN ('ingest', 'dry_run')
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')
       AND (p_allow_batch OR j.batch_id IS NULL)
       AND (
         (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
         OR (
           j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < now()
         )
       )
       AND (j.batch_id IS NULL OR public.rag_batch_has_room(j.batch_id))
     ORDER BY j.priority DESC, j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      EXIT;
    END IF;

    IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
      CONTINUE;
    END IF;

    IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
      v_new_retries := v_job.retries + 1;
      IF v_new_retries > v_job.max_retries THEN
        PERFORM public.rag_release_job_reservations(v_job.id);
        UPDATE public.ingestion_jobs
           SET status = 'failed',
               error_class = 'lease_expired',
               error = 'lease expired',
               dead_letter_at = now(),
               retries = v_new_retries,
               locked_by = NULL,
               lease_until = NULL,
               runner = NULL,
               updated_at = now()
         WHERE id = v_job.id;
        CONTINUE;
      END IF;
      PERFORM public.rag_release_job_reservations(v_job.id);
    END IF;

    UPDATE public.ingestion_jobs j
       SET status = CASE
             WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
             ELSE j.status
           END,
           retries = CASE
             WHEN j.status = 'queued' THEN j.retries
             ELSE j.retries + 1
           END,
           locked_by = p_worker,
           runner = p_runner,
           lease_until = now() + interval '120 seconds',
           updated_at = now()
     WHERE j.id = v_job.id
     RETURNING j.* INTO v_job;

    v_claimed := v_claimed + 1;
    RETURN NEXT v_job;
  END LOOP;

  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_create_ingestion_batch(p_tenant_key text, p_source_kind text, p_source_ref text, p_budget_usd numeric DEFAULT NULL::numeric, p_concurrency integer DEFAULT 1, p_runner text DEFAULT 'worker'::text, p_created_by text DEFAULT NULL::text)
 RETURNS public.ingestion_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.ingestion_batches%ROWTYPE;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_source_kind IS NULL OR p_source_kind NOT IN ('folder', 'bucket', 'manifest') THEN
    RAISE EXCEPTION 'backfill_refused: invalid_source_kind' USING ERRCODE = '22023';
  END IF;
  IF p_source_ref IS NULL OR btrim(p_source_ref) = '' THEN
    RAISE EXCEPTION 'backfill_refused: invalid_source_ref' USING ERRCODE = '22023';
  END IF;
  IF p_concurrency IS NULL OR p_concurrency < 1 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_concurrency' USING ERRCODE = '22023';
  END IF;
  IF p_runner IS NULL OR p_runner NOT IN ('worker', 'ray') THEN
    RAISE EXCEPTION 'backfill_refused: invalid_runner' USING ERRCODE = '22023';
  END IF;
  IF p_budget_usd IS NOT NULL AND p_budget_usd < 0 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_budget' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ingestion_batches (
    tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, created_by, status
  ) VALUES (
    p_tenant_key, p_source_kind, p_source_ref, p_budget_usd, p_concurrency, p_runner, p_created_by, 'pending'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_delete_doc_type_default(p_tenant_key text, p_source_kind text, p_source_ref text)
 RETURNS TABLE(deleted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  removed integer;
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  DELETE FROM public.rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key AND d.source_kind = p_source_kind AND COALESCE(d.source_ref, '') = COALESCE(btrim(p_source_ref), '');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN QUERY SELECT removed > 0;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_delete_ingestion_job(p_job_id uuid, p_actor uuid)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_keys text[];
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
BEGIN
  v_keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO v_job FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL AND j.tenant_key = ANY (v_keys)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_job.document_id FOR UPDATE;
    IF FOUND AND v_doc.is_current THEN
      RAISE EXCEPTION 'ingest_refused: document_is_current' USING ERRCODE = '22023';
    END IF;
    IF FOUND AND NOT v_doc.is_current THEN
      UPDATE public.documents d SET superseded_by = NULL WHERE d.superseded_by = v_doc.id;
      DELETE FROM public.document_chunks c WHERE c.document_id = v_doc.id;
      DELETE FROM public.documents d WHERE d.id = v_doc.id;
    END IF;
  END IF;

  UPDATE public.ingestion_jobs j
     SET deleted_at = now(),
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'delete_ingestion_job',
    COALESCE(v_job.document_id, COALESCE(v_doc.id, v_job.id)),
    v_job.lineage_id,
    v_job.tenant_key,
    v_job.version,
    p_actor,
    ARRAY[]::text[]
  );

  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_delete_quarantined(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(document_id uuid, lineage_id uuid, tenant_key text, version integer, rule_ids text[], artifact_keys text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  doc public.documents%ROWTYPE;
  ids text[];
  stored text[];
BEGIN
  keys := public.rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  stored := ARRAY(
    SELECT DISTINCT s.key FROM (
      SELECT e.value AS key
      FROM jsonb_each_text(CASE WHEN jsonb_typeof(doc.processing_state -> 'artifacts') = 'object' THEN doc.processing_state -> 'artifacts' ELSE '{}'::jsonb END) AS e
      UNION ALL
      SELECT doc.original_path
    ) AS s
    WHERE s.key IS NOT NULL AND s.key <> ''
  );

  UPDATE public.documents d SET superseded_by = NULL WHERE d.superseded_by = doc.id;
  -- The single-tenant schema has no cascade from documents to document_chunks; chunk_embeddings and gaps cascade from the chunks.
  DELETE FROM public.document_chunks c WHERE c.document_id = doc.id;
  DELETE FROM public.documents d WHERE d.id = doc.id;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('delete_quarantined', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT doc.id, doc.lineage_id, doc.tenant_key, doc.version, ids, stored;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_doc_type_tenant_key_ok(p_tenant_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL THEN
    RETURN false;
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    RETURN p_tenant_key ~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  END IF;
  RETURN p_tenant_key = 's:default';
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_documents_legacy_defaults()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  original_source text;
BEGIN
  IF NEW.lineage_id IS NULL THEN
    NEW.parser_used := COALESCE(NEW.parser_used, 'llamaparse');
    NEW.parser_version := COALESCE(NEW.parser_version, 'legacy');
  END IF;

  IF NEW.source IS NULL OR NEW.source NOT IN ('chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag') THEN
    original_source := NEW.source;
    IF original_source IN ('google-drive', 'notion', 'dropbox') AND COALESCE(NEW.source_provider, '') = '' THEN
      NEW.source_provider := original_source;
    END IF;
    NEW.source := CASE
      WHEN original_source IN ('google-drive', 'notion', 'dropbox') THEN 'nango'
      WHEN original_source = 'scrape' THEN 'scraper'
      ELSE 'config_upload'
    END;
    IF original_source IS NOT NULL AND (NEW.metadata IS NULL OR NEW.metadata->'legacy_source' IS NULL) THEN
      NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb) || jsonb_build_object('legacy_source', original_source);
    END IF;
  END IF;

  NEW.lineage_id := COALESCE(NEW.lineage_id, NEW.id);
  NEW.source_key := COALESCE(NEW.source_key, 'legacy:' || NEW.id::text);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_enqueue_backfill_jobs(p_batch_id uuid, p_jobs jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tenant text;
  v_job jsonb;
  v_kind text;
  v_status text;
  v_inserted integer := 0;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.tenant_key INTO v_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_jobs IS NULL OR jsonb_typeof(p_jobs) <> 'array' THEN
  RAISE EXCEPTION 'backfill_refused: jobs_must_be_array' USING ERRCODE = '22023';
  END IF;

  FOR v_job IN SELECT value FROM jsonb_array_elements(p_jobs) AS e(value) LOOP
    IF jsonb_typeof(v_job) <> 'object' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_job_object' USING ERRCODE = '22023';
    END IF;

    v_kind := v_job ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('ingest', 'dry_run') THEN
      RAISE EXCEPTION 'backfill_refused: invalid_kind' USING ERRCODE = '22023';
    END IF;
    IF v_job ->> 'source_key' IS NULL OR btrim(v_job ->> 'source_key') = '' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_source_key' USING ERRCODE = '22023';
    END IF;

    v_status := COALESCE(v_job ->> 'status', 'queued');
    IF v_status NOT IN (
      'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
      'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
    ) THEN
      RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.ingestion_jobs (
      tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
      original_ref, settings, priority, batch_id, document_id
    ) VALUES (
      v_tenant,
      v_kind,
      v_status,
      NULLIF(v_job ->> 'source', ''),
      v_job ->> 'source_key',
      NULLIF(v_job ->> 'file_sha256', ''),
      NULLIF(v_job ->> 'filename', ''),
      NULLIF(v_job ->> 'mime_type', ''),
      CASE WHEN v_job ? 'original_ref' THEN v_job -> 'original_ref' ELSE NULL END,
      COALESCE(v_job -> 'settings', '{}'::jsonb),
      10,
      p_batch_id,
      NULL
    )
    ON CONFLICT (batch_id, kind, source_key) WHERE batch_id IS NOT NULL DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_enqueue_ingestion_job(p_tenant_key text, p_kind text DEFAULT 'ingest'::text, p_source text DEFAULT NULL::text, p_source_key text DEFAULT NULL::text, p_file_sha256 text DEFAULT NULL::text, p_filename text DEFAULT NULL::text, p_mime_type text DEFAULT NULL::text, p_original_ref jsonb DEFAULT NULL::jsonb, p_settings jsonb DEFAULT '{}'::jsonb, p_priority integer DEFAULT 100, p_document_id uuid DEFAULT NULL::uuid, p_batch_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'queued'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_doc_tenant text;
  v_batch_tenant text;
  v_row public.ingestion_jobs%ROWTYPE;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_kind IS NULL OR p_kind NOT IN ('ingest', 'dry_run', 'delete') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_source_key IS NULL OR btrim(p_source_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_source_key' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
  ) THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT d.tenant_key INTO v_doc_tenant FROM public.documents d WHERE d.id = p_document_id;
    IF NOT FOUND OR v_doc_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: document_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT b.tenant_key INTO v_batch_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
    IF NOT FOUND OR v_batch_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: batch_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.ingestion_jobs (
    tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
    original_ref, settings, priority, document_id, batch_id
  ) VALUES (
    p_tenant_key, p_kind, p_status, p_source, p_source_key, p_file_sha256, p_filename, p_mime_type,
    p_original_ref, COALESCE(p_settings, '{}'::jsonb), COALESCE(p_priority, 100), p_document_id, p_batch_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_exact_id_documents(p_tenant_key text, p_tokens text[], p_limit integer)
 RETURNS TABLE(chunk_id uuid, document_id uuid, content text, metadata jsonb, matched_field text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  tokens text[];
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::text[]) INTO tokens
  FROM (
    SELECT lower(btrim(raw)) AS t FROM unnest(COALESCE(p_tokens, ARRAY[]::text[])) WITH ORDINALITY AS u(raw, n)
    WHERE n <= 20 AND length(btrim(raw)) BETWEEN 2 AND 100
  ) cleaned;
  IF cardinality(tokens) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT hit.id, hit.document_id, hit.content, hit.metadata, hit.matched_field
  FROM (
    SELECT DISTINCT ON (m.id) m.id, m.document_id, m.content, m.metadata, m.matched_field, m.created_at, m.chunk_index
    FROM (
      SELECT c.id, c.document_id, c.content, c.metadata,
             CASE WHEN lower(d.invoice_number) = ANY (tokens) THEN 'invoice_number' ELSE 'supplier_tax_id' END AS matched_field,
             1 AS priority, c.created_at, c.chunk_index
      FROM public.documents d
      JOIN public.document_chunks c ON c.document_id = d.id
      WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
        AND c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready'
        AND c.chunk_kind IN ('invoice_header', 'table')
        AND (lower(d.invoice_number) = ANY (tokens) OR lower(d.supplier_tax_id) = ANY (tokens))
      UNION ALL
      SELECT c.id, c.document_id, c.content, c.metadata, 'lexical_text'::text, 2, c.created_at, c.chunk_index
      FROM public.document_chunks c
      WHERE c.tenant_key = p_tenant_key AND c.is_current AND c.status = 'ready'
        AND c.lexical_text IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM unnest(tokens) AS k(token)
          WHERE lower(c.lexical_text) ~ ('(^|[^[:alnum:]_-])' || regexp_replace(k.token, '([][\\.^$|?*+(){}-])', '\\\1', 'g') || '($|[^[:alnum:]_-])')
        )
    ) m
    ORDER BY m.id, m.priority
  ) hit
  ORDER BY (hit.matched_field = 'lexical_text'), hit.created_at, hit.chunk_index, hit.id
  LIMIT cap;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_existing_file_hashes(p_tenant_key text, p_hashes text[])
 RETURNS TABLE(id uuid, file_sha256 text, tenant_key text, source_key text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_hashes IS NULL OR array_length(p_hashes, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_hashes, 1) > 1000 THEN
    RAISE EXCEPTION 'backfill_refused: too_many_hashes' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT d.id, d.file_sha256, d.tenant_key, d.source_key
    FROM public.documents d
   WHERE d.tenant_key = p_tenant_key
     AND d.is_current
     AND d.status = 'ready'
     AND d.file_sha256 IS NOT NULL
     AND d.file_sha256 = ANY (p_hashes)
   ORDER BY d.created_at, d.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_find_content_duplicate(p_tenant_key text, p_content_hash text, p_document_id uuid)
 RETURNS TABLE(duplicate_of uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF p_document_id IS NOT NULL THEN
    PERFORM 1 FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
    END IF;
  END IF;
  IF p_content_hash IS NULL OR p_content_hash = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT d.id
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.content_hash = p_content_hash AND d.is_current AND d.status = 'ready'
    AND d.id IS DISTINCT FROM p_document_id
  ORDER BY d.created_at, d.id
  LIMIT 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_find_invoices(p_tenant_key text, p_supplier text, p_date_from date, p_date_to date, p_amount_min numeric, p_amount_max numeric, p_currency text, p_limit integer)
 RETURNS TABLE(document_id uuid, filename text, invoice_number text, supplier_name text, supplier_tax_id text, issue_date date, gross_total text, currency text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  needle text := lower(btrim(COALESCE(p_supplier, '')));
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  RETURN QUERY
  SELECT d.id, d.filename, d.invoice_number, d.supplier_name, d.supplier_tax_id, d.issue_date, d.gross_total::text, d.currency
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key
    AND d.is_current
    AND d.status = 'ready'
    AND d.doc_type = 'invoice_receipt'
    AND (needle = '' OR position(needle IN lower(COALESCE(d.supplier_name, ''))) > 0 OR lower(COALESCE(d.supplier_tax_id, '')) = needle)
    AND (p_date_from IS NULL OR d.issue_date >= p_date_from)
    AND (p_date_to IS NULL OR d.issue_date <= p_date_to)
    AND (p_amount_min IS NULL OR d.gross_total >= p_amount_min)
    AND (p_amount_max IS NULL OR d.gross_total <= p_amount_max)
    AND (p_currency IS NULL OR d.currency = p_currency)
  ORDER BY d.issue_date DESC NULLS LAST, d.created_at DESC, d.id
  LIMIT cap;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_doc_type_defaults(p_tenant_key text, p_source text, p_connection_id text, p_folder_id text)
 RETURNS TABLE(tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  RETURN QUERY
  SELECT d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at
  FROM public.rag_doc_type_defaults d
  WHERE d.tenant_key = p_tenant_key
    AND (
      p_source IS NULL
      OR d.source_kind = 'tenant'
      OR (d.source_kind = p_source AND (
        d.source_ref IS NULL
        OR (p_source = 'nango' AND d.source_ref IS NOT NULL AND (d.source_ref = p_connection_id OR d.source_ref = p_folder_id))
      ))
    )
  ORDER BY d.source_kind, d.source_ref NULLS FIRST;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_document_for_type_change(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(lineage_id uuid, version integer, is_current boolean, status text, source text, source_key text, filename text, doc_type text, processing_profile_id text, parser_used text, parser_version text, original_path text, source_provider text, source_file_id text, source_connection_id text, metadata jsonb, processing_state jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.version, d.is_current, d.status, d.source, d.source_key, d.filename, d.doc_type, d.processing_profile_id,
         d.parser_used, d.parser_version, d.original_path, d.source_provider, d.source_file_id, d.source_connection_id,
         COALESCE(d.metadata, '{}'::jsonb), COALESCE(d.processing_state, '{}'::jsonb)
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingest_document(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(status text, version integer, processing_status text, processing_state jsonb, filename text, doc_type text, parser_used text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.status, d.version, d.processing_status, d.processing_state, d.filename, d.doc_type, d.parser_used, d.created_at
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingest_origin(p_document_id uuid, p_tenant_key text)
 RETURNS TABLE(lineage_id uuid, original_path text, source text, source_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT d.lineage_id, d.original_path, d.source, d.source_key
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job(p_job_id uuid, p_tenant_key text)
 RETURNS public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_ingestion_job_internal(p_job_id uuid)
 RETURNS public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.* FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_job_for_document(p_document_id uuid, p_tenant_key text)
 RETURNS public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.document_id = p_document_id
     AND j.tenant_key = p_tenant_key
     AND j.deleted_at IS NULL
   ORDER BY j.created_at DESC
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.rag_get_parse_tier_overrides()
 RETURNS TABLE(doc_type text, min_tier text, max_tier text, updated_by text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT o.doc_type, o.min_tier, o.max_tier, o.updated_by, o.updated_at
    FROM public.rag_parse_tier_overrides o
   ORDER BY o.doc_type;
$function$;

CREATE OR REPLACE FUNCTION public.rag_heartbeat_ingestion_job(p_job_id uuid, p_worker text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.ingestion_jobs j
     SET lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = p_job_id
     AND j.locked_by = p_worker
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now()
   RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_assert_job_lease(p_job public.ingestion_jobs, p_worker text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_job.locked_by IS DISTINCT FROM p_worker
     OR p_job.lease_until IS NULL
     OR p_job.lease_until <= now() THEN
    RAISE EXCEPTION 'lease_lost' USING ERRCODE = '55000';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_assert_tenant_key(p_tenant_key text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  multi_tenant boolean;
BEGIN
  IF p_tenant_key IS NULL OR btrim(p_tenant_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key ~ '[A-Z]' OR position('=' IN p_tenant_key) > 0 OR position('''' IN p_tenant_key) > 0 THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF multi_tenant THEN
    IF p_tenant_key !~ '^[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
    END IF;
  ELSIF p_tenant_key <> 's:default' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_broadcast_job(p_job public.ingestion_jobs)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN
    RETURN;
  END IF;
  v_payload := jsonb_build_object(
    'job_id', p_job.id,
    'document_id', p_job.document_id,
    'status', p_job.status,
    'stage', p_job.stage,
    'provisional', p_job.provisional_published_at IS NOT NULL
  );
  PERFORM realtime.send(v_payload, 'ingest_status', 'rag-ingest:' || p_job.tenant_key, true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_job_status_for_stage(p_stage text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_stage
    WHEN 'begin' THEN 'queued'
    WHEN 'preflight' THEN 'preflight'
    WHEN 'parse' THEN 'parsing'
    WHEN 'check' THEN 'checking'
    WHEN 'content_hash_dedup' THEN 'chunking'
    WHEN 'scan_injection' THEN 'chunking'
    WHEN 'chunk' THEN 'chunking'
    WHEN 'enrich' THEN 'chunking'
    WHEN 'extract' THEN 'chunking'
    WHEN 'images' THEN 'chunking'
    WHEN 'embed' THEN 'embedding'
    WHEN 'write' THEN 'embedding'
    WHEN 'publish' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'quarantined'
    WHEN 'needs_review' THEN 'needs_review'
    WHEN 'skipped_duplicate' THEN 'skipped_duplicate'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_mirror_processing_status(p_ledger_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_ledger_status
    WHEN 'queued' THEN 'queued'
    WHEN 'preflight' THEN 'parsing'
    WHEN 'parsing' THEN 'parsing'
    WHEN 'checking' THEN 'parsing'
    WHEN 'chunking' THEN 'chunking'
    WHEN 'embedding' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'needs_review' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'failed'
    WHEN 'skipped_duplicate' THEN 'ready'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_latest_backfill_runs(p_tenant_key text)
 RETURNS TABLE(profile_id text, run_id uuid, status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT DISTINCT ON (r.profile_id) r.profile_id, r.id, r.status
  FROM public.embedding_backfill_runs r
  WHERE r.tenant_key IS NULL OR r.tenant_key = p_tenant_key
  ORDER BY r.profile_id, (r.status = 'running') DESC, r.started_at DESC, r.id
$function$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsquery(p_tokens text[])
 RETURNS tsquery
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  SELECT NULLIF(string_agg(quote_literal(t.tok), ' | '), '')::tsquery
  FROM (
    SELECT DISTINCT tok
    FROM unnest(coalesce(p_tokens, '{}'::text[])) AS u(tok)
    WHERE tok <> '' AND octet_length(tok) <= 255 AND tok !~ '[''\\[:space:]]'
    LIMIT 64
  ) AS t
$function$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsvector(p_lexical_text text)
 RETURNS tsvector
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  SELECT coalesce(string_agg(quote_literal(t.tok) || ':' || least(t.ord, 16383)::text, ' ' ORDER BY t.ord), '')::tsvector
  FROM unnest(string_to_array(coalesce(p_lexical_text, ''), ' ')) WITH ORDINALITY AS t(tok, ord)
  WHERE t.tok <> '' AND octet_length(t.tok) <= 255 AND t.tok !~ '[''\\[:space:]]'
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_batch_jobs(p_batch_id uuid, p_status text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_after_created_at timestamptz;
  v_after_id uuid;
  v_limit integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 100), 1000), 1);

  IF p_status IS NOT NULL AND p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_after_id IS NOT NULL THEN
    SELECT j.created_at, j.id INTO v_after_created_at, v_after_id
      FROM public.ingestion_jobs j
     WHERE j.id = p_after_id AND j.batch_id = p_batch_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backfill_refused: invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN QUERY
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND (p_status IS NULL OR j.status = p_status)
     AND (
       p_after_id IS NULL
       OR j.created_at > v_after_created_at
       OR (j.created_at = v_after_created_at AND j.id > v_after_id)
     )
   ORDER BY j.created_at, j.id
   LIMIT v_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_chunking_profiles()
 RETURNS TABLE(id text, doc_type text, child_tokens integer, parent_mode text, parent_tokens integer, status text, preset text, previous_active_id text, is_active boolean, created_at timestamp with time zone, activated_at timestamp with time zone, activated_by text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    p.id,
    p.doc_type,
    p.child_tokens,
    p.parent_mode,
    p.parent_tokens,
    p.status,
    p.preset,
    p.previous_active_id,
  (p.status = 'active') AS is_active,
    p.created_at,
    p.activated_at,
    p.activated_by
  FROM public.chunking_profiles p
  ORDER BY p.doc_type, p.id
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_embedding_profiles()
 RETURNS TABLE(id text, provider text, model text, dims integer, storage text, status text, query_instruction text, score_calibration jsonb, activated_at timestamp with time zone, activated_by text, previous_active_id text, has_evidence boolean, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT p.id, p.provider, p.model, p.dims, p.storage, p.status, p.query_instruction, p.score_calibration,
         p.activated_at, p.activated_by, p.previous_active_id, p.eval_evidence IS NOT NULL, p.created_at
  FROM public.embedding_profiles p
  ORDER BY p.id
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_ingestion_jobs(p_tenant_key text DEFAULT NULL::text, p_statuses text[] DEFAULT NULL::text[], p_kind text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.deleted_at IS NULL
     AND (p_tenant_key IS NULL OR j.tenant_key = p_tenant_key)
     AND (p_kind IS NULL OR j.kind = p_kind)
     AND (p_statuses IS NULL OR j.status = ANY (p_statuses))
   ORDER BY j.created_at DESC, j.id DESC
   LIMIT GREATEST(COALESCE(p_limit, 50), 0)
   OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_quarantine(p_actor uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(document_id uuid, lineage_id uuid, tenant_key text, filename text, source text, version integer, rule_ids text[], snippets text[], quarantined_at timestamp with time zone, detected_by text, total_count bigint)
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
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,rule_ids}') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(d.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END AS rule_ids,
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,snippets}') = 'array'
           THEN ARRAY(SELECT left(s.value, 80) FROM jsonb_array_elements_text(d.metadata #> '{quarantine,snippets}') AS s(value) LIMIT 3)
           ELSE '{}'::text[] END AS snippets,
      CASE WHEN (d.metadata #>> '{quarantine,quarantined_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
           THEN (d.metadata #>> '{quarantine,quarantined_at}')::timestamptz ELSE d.created_at END AS quarantined_at,
      CASE WHEN (d.metadata #>> '{invoice_extraction,status}') = 'quarantined' THEN 'invoice_extraction' ELSE 'injection_scan' END AS detected_by
    FROM public.documents d
    WHERE d.status = 'quarantined' AND d.tenant_key = ANY (keys)
  )
  SELECT q.id, q.lineage_id, q.tenant_key, q.filename, q.source, q.version, q.rule_ids, q.snippets, q.quarantined_at, q.detected_by,
         count(*) OVER () AS total_count
  FROM quarantined q
  ORDER BY q.quarantined_at DESC, q.id
  LIMIT page_size OFFSET skip;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_mark_document_failed(p_document_id uuid, p_tenant_key text, p_reason text)
 RETURNS TABLE(document_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc public.documents%ROWTYPE;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.is_current THEN
    RAISE EXCEPTION 'document_is_current' USING DETAIL = 'a current version is not marked failed';
  END IF;
  UPDATE public.documents d
  SET status = 'failed',
      processing_status = 'failed',
      processing_state = COALESCE(d.processing_state, '{}'::jsonb) || jsonb_build_object('failure_reason', left(COALESCE(p_reason, ''), 1000))
  WHERE d.id = p_document_id;
  UPDATE public.document_chunks c SET status = 'failed' WHERE c.document_id = p_document_id;
  RETURN QUERY SELECT p_document_id, 'failed'::text;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_open_embed_batches(p_batch_id uuid)
 RETURNS SETOF public.rag_embed_batches
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT e.*
    FROM public.rag_embed_batches e
   WHERE e.batch_id = p_batch_id
     AND e.status NOT IN ('completed', 'cancelled')
   ORDER BY e.created_at, e.id;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_budget_month(p_tenant_key text DEFAULT NULL::text)
 RETURNS TABLE(tenant_key text, month date, pages_reserved integer, pages_used integer, vlm_pages_used integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT u.tenant_key, u.month, u.pages_reserved, u.pages_used, u.vlm_pages_used
    FROM public.rag_parse_budget_usage u
   WHERE u.month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     AND (p_tenant_key IS NULL OR u.tenant_key = p_tenant_key)
   ORDER BY u.tenant_key;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_assert_key_parts(p_parser text, p_options_hash text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_parser IS NULL OR p_parser !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_parser' USING ERRCODE = '22023';
  END IF;
  IF p_options_hash IS NULL OR p_options_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'parse_cache_refused: invalid_options_hash' USING ERRCODE = '22023';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_for_document(p_tenant_key text, p_document_id uuid)
 RETURNS SETOF public.rag_parse_cache
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT c.*
    FROM public.documents d
    JOIN public.rag_parse_cache c ON c.id = d.parse_cache_id
   WHERE d.id = p_document_id
     AND d.tenant_key = p_tenant_key
     AND c.tenant_key = p_tenant_key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_lookup(p_job_id uuid, p_parser text, p_parser_version text, p_options_hash text)
 RETURNS SETOF public.rag_parse_cache
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
BEGIN
  PERFORM public.rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT c.*
    FROM public.rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_prefix(p_job_id uuid, p_parser text, p_parser_version text, p_options_hash text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
  v_segment text;
BEGIN
  PERFORM public.rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
  RETURN NULL;
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_segment := public.rag_parse_cache_version_segment(p_parser_version);
  RETURN v_job.tenant_key
    || '/_parse-cache/'
    || v_job.file_sha256
    || '/'
    || p_parser
    || '-'
    || v_segment
    || '-'
    || p_options_hash
    || '/';
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_put(p_job_id uuid, p_parser text, p_parser_version text, p_options_hash text, p_object_prefix text, p_result jsonb DEFAULT '{}'::jsonb, p_byte_size bigint DEFAULT NULL::bigint)
 RETURNS public.rag_parse_cache
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
  v_expected text;
  v_row public.rag_parse_cache%ROWTYPE;
BEGIN
  PERFORM public.rag_parse_cache_assert_key_parts(p_parser, p_options_hash);
  SELECT j.tenant_key, j.file_sha256 INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.file_sha256 IS NULL OR btrim(v_job.file_sha256) = '' THEN
    RAISE EXCEPTION 'parse_cache_refused: missing_file_sha256' USING ERRCODE = '22023';
  END IF;
  v_expected := public.rag_parse_cache_prefix(p_job_id, p_parser, p_parser_version, p_options_hash);
  IF p_object_prefix IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'parse_cache_refused: prefix_mismatch' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.rag_parse_cache (
    tenant_key, file_sha256, parser, parser_version, options_hash, object_prefix, result, byte_size
  )
  VALUES (
    v_job.tenant_key, v_job.file_sha256, p_parser, p_parser_version, p_options_hash, p_object_prefix,
    COALESCE(p_result, '{}'::jsonb), p_byte_size
  )
  ON CONFLICT (tenant_key, file_sha256, parser, parser_version, options_hash) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN v_row;
  END IF;
  SELECT c.* INTO v_row
    FROM public.rag_parse_cache c
   WHERE c.tenant_key = v_job.tenant_key
     AND c.file_sha256 = v_job.file_sha256
     AND c.parser = p_parser
     AND c.parser_version = p_parser_version
     AND c.options_hash = p_options_hash;
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_cache_version_segment(p_parser_version text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT left(encode(sha256(convert_to(p_parser_version, 'UTF8')), 'hex'), 16);
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_doc_type_ok(p_doc_type text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT p_doc_type = ANY (ARRAY[
    'general',
    'financial_report',
    'contract_legal',
    'invoice_receipt',
    'product_technical',
    'scanned_image'
  ]::text[]);
$function$;

CREATE OR REPLACE FUNCTION public.rag_parse_tier_rank(p_tier text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_tier
    WHEN 'native' THEN 0
    WHEN 'fast' THEN 1
    WHEN 'structured' THEN 2
    WHEN 'premium' THEN 3
    ELSE NULL
  END;
$function$;

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

CREATE OR REPLACE FUNCTION public.rag_rechunk_advance(p_run_id uuid, p_document_id uuid)
 RETURNS TABLE(docs_done integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  handled integer;
BEGIN
  UPDATE public.chunking_build_runs r
  SET cursor_document_id = p_document_id, docs_done = r.docs_done + 1, updated_at = now()
  WHERE r.id = p_run_id AND r.status = 'running'
  RETURNING r.docs_done INTO handled;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT handled;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_documents(p_profile_id text, p_doc_type text, p_tenant_key text, p_after uuid, p_limit integer)
 RETURNS TABLE(document_id uuid, tenant_key text, lineage_id uuid, version integer, filename text, doc_type text, source text, template_row jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT d.id, d.tenant_key, d.lineage_id, d.version, d.filename, d.doc_type, d.source,
           jsonb_build_object(
             'invoice_number', d.invoice_number,
             'supplier_name', d.supplier_name,
             'supplier_tax_id', d.supplier_tax_id,
             'issue_date', d.issue_date::text,
             'gross_total', d.gross_total::text,
             'currency', d.currency)
    FROM public.chunking_profiles p
    JOIN public.documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
    WHERE p.id = p_profile_id
      AND p.doc_type = p_doc_type
      AND p.id <> 'legacy'
      AND p.status IN ('building', 'ready', 'active')
      AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
      AND (p_after IS NULL OR d.id > p_after)
      AND NOT EXISTS (
        SELECT 1 FROM public.document_chunks c
        WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
    ORDER BY d.id
    LIMIT p_limit;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_finish_run(p_run_id uuid, p_status text DEFAULT 'completed'::text)
 RETURNS TABLE(status text, docs_missing integer, docs_missing_total integer, gaps integer, profile_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  existing public.chunking_build_runs%ROWTYPE;
  scope_missing integer;
  total_missing integer;
  final_status text;
  gap_count integer;
  profile_state text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO existing FROM public.chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;

  scope_missing := public.rag_rechunk_missing(existing.profile_id, existing.doc_type, existing.tenant_key);
  total_missing := public.rag_rechunk_missing(existing.profile_id, existing.doc_type, NULL);
  IF p_status = 'failed' THEN
    final_status := 'failed';
  ELSIF scope_missing = 0 THEN
    final_status := 'completed';
  ELSE
    final_status := 'incomplete';
  END IF;
  UPDATE public.chunking_build_runs r SET status = final_status, updated_at = now() WHERE r.id = p_run_id;

  IF final_status = 'completed' AND total_missing = 0 THEN
    UPDATE public.chunking_profiles p SET status = 'ready'
    WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type AND p.status = 'building';
  END IF;
  SELECT count(*)::integer INTO gap_count FROM public.chunking_build_gaps g WHERE g.run_id = p_run_id;
  SELECT p.status INTO profile_state FROM public.chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  RETURN QUERY SELECT final_status, scope_missing, total_missing, gap_count, profile_state;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_gaps(p_run_id uuid)
 RETURNS TABLE(document_id uuid, tenant_key text, reason text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT g.document_id, d.tenant_key, g.reason, g.detail
  FROM public.chunking_build_gaps g
  JOIN public.documents d ON d.id = g.document_id
  WHERE g.run_id = p_run_id
  ORDER BY g.document_id
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_get_run(p_run_id uuid)
 RETURNS TABLE(run_id uuid, profile_id text, doc_type text, tenant_key text, cursor_document_id uuid, docs_total integer, docs_done integer, status text, profile_status text, child_tokens integer, parent_mode text, parent_tokens integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT r.id, r.profile_id, r.doc_type, r.tenant_key, r.cursor_document_id, r.docs_total, r.docs_done, r.status,
         p.status, p.child_tokens, p.parent_mode, p.parent_tokens
  FROM public.chunking_build_runs r
  JOIN public.chunking_profiles p ON p.id = r.profile_id AND p.doc_type = r.doc_type
  WHERE r.id = p_run_id
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_missing(p_profile_id text, p_doc_type text, p_tenant_key text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT count(*)::integer
  FROM public.chunking_profiles p
  JOIN public.documents d ON d.doc_type = p.doc_type AND d.is_current AND d.status = 'ready'
  WHERE p.id = p_profile_id
    AND p.doc_type = p_doc_type
    AND (p_tenant_key IS NULL OR d.tenant_key = p_tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM public.document_chunks c
      WHERE c.document_id = d.id AND c.chunking_profile_id = p.id AND c.is_current)
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_record_gap(p_run_id uuid, p_document_id uuid, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS TABLE(recorded integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  existing public.chunking_build_runs%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM public.chunking_build_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status <> 'running' THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('no_parse_output', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_gap' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.documents d
  WHERE d.id = p_document_id AND d.doc_type = existing.doc_type AND (existing.tenant_key IS NULL OR d.tenant_key = existing.tenant_key);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: document_out_of_scope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.chunking_build_gaps (run_id, document_id, reason, detail)
  VALUES (p_run_id, p_document_id, p_reason, left(p_detail, 200))
  ON CONFLICT (run_id, document_id) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, recorded_at = now();
  RETURN QUERY SELECT 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_resume_run(p_run_id uuid)
 RETURNS TABLE(run_id uuid, profile_id text, doc_type text, tenant_key text, cursor_document_id uuid, docs_total integer, docs_done integer, status text, profile_status text, child_tokens integer, parent_mode text, parent_tokens integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  existing public.chunking_build_runs%ROWTYPE;
  profile_state text;
BEGIN
  SELECT * INTO existing FROM public.chunking_build_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF existing.status NOT IN ('running', 'failed') THEN
    RAISE EXCEPTION 'rechunk_refused: run_not_resumable' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO profile_state FROM public.chunking_profiles p WHERE p.id = existing.profile_id AND p.doc_type = existing.doc_type;
  IF profile_state = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  UPDATE public.chunking_build_runs r SET status = 'running', updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT * FROM public.rag_rechunk_get_run(p_run_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_rechunk_start_run(p_profile_id text, p_doc_type text DEFAULT NULL::text, p_tenant_key text DEFAULT NULL::text, p_resume_open boolean DEFAULT false)
 RETURNS TABLE(run_id uuid, profile_id text, doc_type text, tenant_key text, cursor_document_id uuid, docs_total integer, docs_done integer, status text, profile_status text, child_tokens integer, parent_mode text, parent_tokens integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  matches integer;
  chosen public.chunking_profiles%ROWTYPE;
  opened uuid;
BEGIN
  IF p_profile_id IS NULL OR btrim(p_profile_id) = '' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_required' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_is_legacy' USING ERRCODE = '55000';
  END IF;
  IF p_tenant_key IS NOT NULL
     AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'rechunk_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO matches FROM public.chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF matches = 0 THEN
    RAISE EXCEPTION 'rechunk_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF matches > 1 THEN
    RAISE EXCEPTION 'rechunk_refused: profile_ambiguous' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO chosen FROM public.chunking_profiles p WHERE p.id = p_profile_id AND (p_doc_type IS NULL OR p.doc_type = p_doc_type);
  IF chosen.status = 'retired' THEN
    RAISE EXCEPTION 'rechunk_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF p_resume_open THEN
    SELECT r.id INTO opened
    FROM public.chunking_build_runs r
    WHERE r.profile_id = chosen.id AND r.doc_type = chosen.doc_type AND r.tenant_key IS NOT DISTINCT FROM p_tenant_key AND r.status = 'running'
    ORDER BY r.started_at DESC
    LIMIT 1;
  END IF;
  IF opened IS NULL THEN
    INSERT INTO public.chunking_build_runs (profile_id, doc_type, tenant_key, docs_total)
    VALUES (chosen.id, chosen.doc_type, p_tenant_key, public.rag_rechunk_missing(chosen.id, chosen.doc_type, p_tenant_key))
    RETURNING id INTO opened;
  END IF;
  RETURN QUERY SELECT * FROM public.rag_rechunk_get_run(opened);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_backfill_gap(p_run_id uuid, p_chunk_ids uuid[], p_profile_id text, p_reason text, p_tenant_key text)
 RETURNS TABLE(gaps_recorded integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  run public.embedding_backfill_runs%ROWTYPE;
  wanted integer;
  matched integer;
  recorded integer;
BEGIN
  IF p_run_id IS NULL OR p_profile_id IS NULL OR p_tenant_key IS NULL THEN
    RAISE EXCEPTION 'invalid_argument: p_run_id, p_profile_id and p_tenant_key are required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'invalid_gap: a reason is required';
  END IF;
  IF p_chunk_ids IS NULL OR cardinality(p_chunk_ids) = 0 THEN
    RAISE EXCEPTION 'invalid_gap: chunk ids are required';
  END IF;

  SELECT * INTO run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'run_not_found';
  END IF;
  IF run.profile_id <> p_profile_id THEN
    RAISE EXCEPTION 'run_profile_mismatch' USING DETAIL = 'the run belongs to another profile';
  END IF;
  IF run.tenant_key IS NOT NULL AND run.tenant_key <> p_tenant_key THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'the run is limited to another tenant';
  END IF;

  SELECT count(DISTINCT u.id) INTO wanted FROM unnest(p_chunk_ids) AS u(id);
  SELECT count(*) INTO matched FROM public.document_chunks c
  WHERE c.id IN (SELECT u.id FROM unnest(p_chunk_ids) AS u(id)) AND c.tenant_key = p_tenant_key;
  IF matched <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in tenant';
  END IF;

  INSERT INTO public.embedding_backfill_gaps AS g (run_id, chunk_id, profile_id, reason)
  SELECT DISTINCT p_run_id, u.id, p_profile_id, left(btrim(p_reason), 200) FROM unnest(p_chunk_ids) AS u(id)
  ON CONFLICT (run_id, chunk_id, profile_id) DO UPDATE SET reason = EXCLUDED.reason, recorded_at = now();
  GET DIAGNOSTICS recorded = ROW_COUNT;

  RETURN QUERY SELECT recorded;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_embed_batch(p_batch_id uuid, p_profile_id text, p_provider text, p_provider_batch_id text DEFAULT NULL::text, p_input_file_id text DEFAULT NULL::text, p_input_count integer DEFAULT 0, p_status text DEFAULT 'pending'::text)
 RETURNS public.rag_embed_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.rag_embed_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ingestion_batches b WHERE b.id = p_batch_id) THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.embedding_profiles ep WHERE ep.id = p_profile_id) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_profile' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS NULL OR btrim(p_provider) = '' THEN
    RAISE EXCEPTION 'backfill_refused: invalid_provider' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
    'expired', 'cancelling', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_input_count IS NULL OR p_input_count < 0 THEN
    RAISE EXCEPTION 'backfill_refused: invalid_input_count' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rag_embed_batches (
    batch_id, profile_id, provider, provider_batch_id, input_file_id, input_count, status
  ) VALUES (
    p_batch_id, p_profile_id, p_provider, p_provider_batch_id, p_input_file_id, COALESCE(p_input_count, 0), p_status
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_eval_evidence(p_profile_id text, p_evidence jsonb, p_actor text)
 RETURNS TABLE(profile_id text, recorded_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'evidence_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile FROM public.embedding_profiles WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'evidence_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'evidence_refused: invalid_evidence' USING ERRCODE = '22023';
  END IF;
  IF p_evidence->>'target_profile' IS DISTINCT FROM p_profile_id THEN
    RAISE EXCEPTION 'evidence_refused: target_mismatch' USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET eval_evidence = p_evidence WHERE id = p_profile_id;

  RETURN QUERY SELECT p_profile_id, now();
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_record_parse_attempt(p_job_id uuid, p_worker text, p_attempt jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_attempts jsonb;
  v_no integer;
  v_reason text;
  v_cost numeric;
BEGIN
  IF p_attempt IS NULL OR jsonb_typeof(p_attempt) <> 'object' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_attempt' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_attempts := COALESCE(v_job.attempts, '[]'::jsonb);
  v_no := jsonb_array_length(v_attempts) + 1;
  v_attempts := v_attempts || jsonb_build_array(p_attempt || jsonb_build_object('attempt_no', v_no));
  v_reason := p_attempt ->> 'reason';
  v_cost := COALESCE((p_attempt ->> 'est_cost')::numeric, 0);

  UPDATE public.ingestion_jobs j
     SET attempts = v_attempts,
         escalations = j.escalations + CASE WHEN v_reason = 'escalation' THEN 1 ELSE 0 END,
         est_cost_usd = COALESCE(j.est_cost_usd, 0) + v_cost,
         updated_at = now()
   WHERE j.id = p_job_id;

  RETURN v_no;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_count(p_profile_id text, p_tenant_key text)
 RETURNS TABLE(tenant_key text, chunks bigint, chunks_missing bigint, content_chars bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.embedding_profiles p WHERE p.id = p_profile_id) THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT c.tenant_key,
           count(*)::bigint,
           (count(*) FILTER (WHERE e.chunk_id IS NULL))::bigint,
           COALESCE(sum(length(c.content)) FILTER (WHERE e.chunk_id IS NULL), 0)::bigint
    FROM public.embedding_profiles p
    JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
    LEFT JOIN public.chunk_embeddings e
      ON e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims
    WHERE p.id = p_profile_id AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    GROUP BY c.tenant_key
    ORDER BY c.tenant_key;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_derive_batch(p_run_id uuid, p_limit integer)
 RETURNS TABLE(chunks_derived integer, chunks_done bigint, cursor_chunk_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_target public.embedding_profiles%ROWTYPE;
  v_source public.embedding_profiles%ROWTYPE;
  v_ids uuid[];
  v_last uuid;
  derived integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF v_run.derived_from IS NULL THEN
    RAISE EXCEPTION 'reembed_refused: not_a_derive_run' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_target FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  SELECT * INTO v_source FROM public.embedding_profiles p WHERE p.id = v_run.derived_from;

  WITH picked AS (
    SELECT c.id, c.tenant_key, s.embedding AS source_vector
    FROM public.document_chunks c
    JOIN public.chunk_embeddings s
      ON s.chunk_id = c.id AND s.profile_id = v_source.id AND s.embedding_model = v_source.model AND s.dims = v_source.dims
    WHERE c.is_current AND c.status = 'ready'
      AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
      AND NOT EXISTS (
        SELECT 1 FROM public.chunk_embeddings t
        WHERE t.chunk_id = c.id AND t.profile_id = v_target.id AND t.embedding_model = v_target.model AND t.dims = v_target.dims)
    ORDER BY c.id
    LIMIT p_limit
  ), written AS (
    INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT p.id, v_target.id, p.tenant_key, public.l2_normalize(public.subvector(p.source_vector, 1, v_target.dims)), v_target.model, v_target.dims, 'derived'
    FROM picked p
    ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      embedding_host = EXCLUDED.embedding_host,
      embedded_at = now()
    RETURNING ce.chunk_id
  )
  SELECT count(*)::integer, array_agg(w.chunk_id) INTO derived, v_ids FROM written w;

  IF derived > 0 THEN
    DELETE FROM public.embedding_backfill_gaps g WHERE g.profile_id = v_target.id AND g.chunk_id = ANY (v_ids);
    SELECT u.id INTO v_last FROM unnest(v_ids) AS u(id) ORDER BY u.id DESC LIMIT 1;
  END IF;

  UPDATE public.embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + derived,
    cursor_chunk_id = CASE
      WHEN v_last IS NOT NULL AND (r.cursor_chunk_id IS NULL OR v_last > r.cursor_chunk_id) THEN v_last
      ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT derived, v_done, v_cursor;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_finish_run(p_run_id uuid, p_status text)
 RETURNS TABLE(run_id uuid, status text, chunks_missing bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'reembed_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  SELECT m.chunks_missing INTO v_missing FROM public.rag_reembed_remaining(p_run_id) AS m;
  IF p_status = 'completed' AND v_missing > 0 THEN
    RAISE EXCEPTION 'reembed_refused: incomplete (% current ready chunks have no vector)', v_missing USING ERRCODE = '55000';
  END IF;
  UPDATE public.embedding_backfill_runs AS r SET status = p_status, updated_at = now() WHERE r.id = p_run_id;
  RETURN QUERY SELECT p_run_id, p_status, v_missing;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_get_run(p_run_id uuid)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, tokens bigint, status text, derived_from text, provider text, model text, dims integer, storage text, profile_status text, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT r.id, r.profile_id, r.tenant_key, r.cursor_chunk_id, r.chunks_total, r.chunks_done, r.tokens, r.status, r.derived_from,
         p.provider, p.model, p.dims, p.storage, p.status, r.updated_at
  FROM public.embedding_backfill_runs r
  JOIN public.embedding_profiles p ON p.id = r.profile_id
  WHERE r.id = p_run_id
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_legacy_guard()
 RETURNS TABLE(versioned_documents bigint, profiles_in_use text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    (SELECT count(*) FROM public.documents d WHERE d.version > 1),
    COALESCE(
      (SELECT array_agg(p.id ORDER BY p.id) FROM public.embedding_profiles p
       WHERE p.id <> 'openai-3-small-1536'
         AND (p.status IN ('backfilling', 'active') OR EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.profile_id = p.id))),
      '{}'::text[])
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_missing_batch(p_run_id uuid, p_after uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 128)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb, has_gap boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT * FROM public.rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_next_batch(p_run_id uuid, p_after uuid, p_limit integer)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM public.rag_reembed_pick(v_run.profile_id, v_run.tenant_key, p_after, p_limit) x;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_pick(p_profile_id text, p_tenant_key text, p_after uuid, p_limit integer)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb, has_gap boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT c.id, c.document_id, c.tenant_key, c.content, c.section_path, c.chunk_kind,
         COALESCE(c.doc_type, d.doc_type),
         jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency),
         EXISTS (SELECT 1 FROM public.embedding_backfill_gaps g WHERE g.chunk_id = c.id AND g.profile_id = p.id)
  FROM public.embedding_profiles p
  JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
  JOIN public.documents d ON d.id = c.document_id
  WHERE p.id = p_profile_id
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    AND (p_after IS NULL OR c.id > p_after)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims)
  ORDER BY c.id
  LIMIT p_limit
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_preview_batch(p_profile_id text, p_tenant_key text, p_after uuid, p_limit integer)
 RETURNS TABLE(id uuid, document_id uuid, tenant_key text, content text, section_path text[], chunk_kind text, doc_type text, template_row jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_storage text;
BEGIN
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;
  SELECT p.storage INTO v_storage FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'reembed_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id, x.document_id, x.tenant_key, x.content, x.section_path, x.chunk_kind, x.doc_type, x.template_row
    FROM public.rag_reembed_pick(p_profile_id, p_tenant_key, p_after, p_limit) x;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_remaining(p_run_id uuid)
 RETURNS TABLE(chunks_missing bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_count bigint;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.embedding_profiles p
  JOIN public.document_chunks c ON c.is_current AND c.status = 'ready'
  WHERE p.id = v_run.profile_id
    AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
    AND NOT EXISTS (
      SELECT 1 FROM public.chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.profile_id = p.id AND e.embedding_model = p.model AND e.dims = p.dims);
  RETURN QUERY SELECT v_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_resume_run(p_run_id uuid, p_actor text)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, tokens bigint, status text, derived_from text, provider text, model text, dims integer, storage text, profile_status text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'completed' THEN
    RAISE EXCEPTION 'reembed_refused: run_completed' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'reembed_refused: run_rolled_back' USING ERRCODE = '55000';
  END IF;
  SELECT p.status INTO v_status FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs o
    WHERE o.id <> v_run.id AND o.profile_id = v_run.profile_id AND o.status = 'running'
      AND (o.tenant_key IS NULL OR v_run.tenant_key IS NULL OR o.tenant_key = v_run.tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = v_run.profile_id AND status = 'available';
  UPDATE public.embedding_backfill_runs SET status = 'running', updated_at = now() WHERE id = v_run.id;
  RETURN QUERY SELECT * FROM public.rag_reembed_get_run(p_run_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_rollback_run(p_run_id uuid, p_actor text)
 RETURNS TABLE(rows_deleted bigint, profile_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_deleted bigint;
  v_status text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'rollback_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'running' AND v_run.updated_at > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'rollback_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.activated_at IS NOT NULL
     AND (SELECT max(p.activated_at) FROM public.embedding_profiles p) > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: recently_active' USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.chunk_embeddings e
  WHERE e.profile_id = v_run.profile_id
    AND e.embedded_at >= v_run.started_at
    AND e.embedded_at <= v_run.updated_at
    AND (v_run.tenant_key IS NULL OR e.tenant_key = v_run.tenant_key);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM public.embedding_backfill_gaps g WHERE g.run_id = v_run.id;
  UPDATE public.embedding_backfill_runs AS r SET status = 'rolled_back', updated_at = now() WHERE r.id = v_run.id;

  IF v_profile.status = 'backfilling' AND NOT EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs o WHERE o.profile_id = v_run.profile_id AND o.status = 'running' AND o.id <> v_run.id
  ) THEN
    UPDATE public.embedding_profiles SET status = 'available' WHERE id = v_run.profile_id;
  END IF;
  SELECT p.status INTO v_status FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;

  RETURN QUERY SELECT v_deleted, v_status;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_start_run(p_profile_id text, p_tenant_key text, p_actor text, p_derived_from text DEFAULT NULL::text)
 RETURNS TABLE(run_id uuid, profile_id text, tenant_key text, chunks_total bigint, derived_from text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_profile public.embedding_profiles%ROWTYPE;
  v_source public.embedding_profiles%ROWTYPE;
  v_total bigint;
  v_run uuid;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'reembed_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL AND p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'reembed_refused: invalid_tenant_key' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_profile.status = 'active' THEN
    RAISE EXCEPTION 'reembed_refused: profile_is_active' USING ERRCODE = '55000';
  END IF;
  IF v_profile.storage = 'legacy_column' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;
  IF v_profile.status = 'retired' THEN
    RAISE EXCEPTION 'reembed_refused: profile_retired' USING ERRCODE = '55000';
  END IF;

  IF p_derived_from IS NOT NULL THEN
    SELECT * INTO v_source FROM public.embedding_profiles p WHERE p.id = p_derived_from;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reembed_refused: unknown_derive_source' USING ERRCODE = '22023';
    END IF;
    IF v_source.id = v_profile.id OR v_source.storage <> 'halfvec' THEN
      RAISE EXCEPTION 'reembed_refused: derive_source_invalid' USING ERRCODE = '22023';
    END IF;
    IF v_source.provider <> v_profile.provider OR v_source.model <> v_profile.model THEN
      RAISE EXCEPTION 'reembed_refused: derive_model_mismatch' USING ERRCODE = '22023';
    END IF;
    IF v_source.dims <= v_profile.dims THEN
      RAISE EXCEPTION 'reembed_refused: derive_dims_not_smaller' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.embedding_backfill_runs r
    WHERE r.profile_id = p_profile_id AND r.status = 'running'
      AND (r.tenant_key IS NULL OR p_tenant_key IS NULL OR r.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'reembed_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_total FROM public.document_chunks c
  WHERE c.is_current AND c.status = 'ready' AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key);

  UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = p_profile_id AND status = 'available';

  INSERT INTO public.embedding_backfill_runs AS r (profile_id, tenant_key, chunks_total, derived_from)
  VALUES (p_profile_id, p_tenant_key, v_total, p_derived_from)
  RETURNING r.id INTO v_run;

  RETURN QUERY SELECT v_run, p_profile_id, p_tenant_key, v_total, p_derived_from;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_reembed_write_batch(p_run_id uuid, p_rows jsonb, p_cursor uuid, p_tokens bigint DEFAULT 0)
 RETURNS TABLE(chunks_written integer, chunks_done bigint, cursor_chunk_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_run public.embedding_backfill_runs%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_ids uuid[];
  wanted integer;
  in_scope integer;
  current_count integer;
  written integer;
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM public.embedding_backfill_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reembed_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'reembed_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = v_run.profile_id;
  IF v_profile.storage <> 'halfvec' THEN
    RAISE EXCEPTION 'reembed_refused: legacy_storage' USING ERRCODE = '55000';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_rows: p_rows must be a non-empty JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value)
    WHERE jsonb_typeof(r.value) <> 'object'
       OR jsonb_typeof(r.value -> 'chunk_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(r.value -> 'vector') IS DISTINCT FROM 'array'
       OR (r.value ? 'host' AND jsonb_typeof(r.value -> 'host') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_rows: every row needs a chunk_id string, a vector array and an optional host string' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg((r.value ->> 'chunk_id')::uuid) INTO v_ids FROM jsonb_array_elements(p_rows) AS r(value);
  wanted := cardinality(v_ids);
  IF (SELECT count(DISTINCT u.id) FROM unnest(v_ids) AS u(id)) <> wanted THEN
    RAISE EXCEPTION 'invalid_rows: a chunk may appear once per batch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) AS r(value) WHERE jsonb_array_length(r.value -> 'vector') <> v_profile.dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  SELECT count(*) INTO in_scope FROM public.document_chunks c
  WHERE c.id = ANY (v_ids) AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key);
  IF in_scope <> wanted THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'chunk not found in the run scope';
  END IF;
  SELECT count(*) INTO current_count FROM public.document_chunks c WHERE c.id = ANY (v_ids) AND c.is_current AND c.status = 'ready';
  IF current_count <> wanted THEN
    RAISE EXCEPTION 'reembed_refused: chunk_not_current' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
  SELECT (r.value ->> 'chunk_id')::uuid, v_profile.id, c.tenant_key, ((r.value -> 'vector')::text)::public.halfvec, v_profile.model, v_profile.dims,
         left(r.value ->> 'host', 120)
  FROM jsonb_array_elements(p_rows) AS r(value)
  JOIN public.document_chunks c ON c.id = (r.value ->> 'chunk_id')::uuid
  ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model,
    dims = EXCLUDED.dims,
    embedding_host = EXCLUDED.embedding_host,
    embedded_at = now();
  GET DIAGNOSTICS written = ROW_COUNT;

  DELETE FROM public.embedding_backfill_gaps g WHERE g.profile_id = v_profile.id AND g.chunk_id = ANY (v_ids);

  UPDATE public.embedding_backfill_runs AS r SET
    chunks_done = r.chunks_done + written,
    tokens = r.tokens + GREATEST(COALESCE(p_tokens, 0), 0),
    cursor_chunk_id = CASE WHEN p_cursor IS NOT NULL AND (r.cursor_chunk_id IS NULL OR p_cursor > r.cursor_chunk_id) THEN p_cursor ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;

  RETURN QUERY SELECT written, v_done, v_cursor;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_ingestion_job(p_job_id uuid, p_worker text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.ingestion_jobs j
     SET status = 'queued',
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = p_job_id
     AND j.locked_by = p_worker
     AND j.lease_until IS NOT NULL
     AND j.lease_until > now()
   RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_job_reservations(p_job_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  released integer := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT r.id, r.tenant_key, r.month, r.pages, r.kind
    FROM public.rag_parse_budget_reservations r
    WHERE r.job_id = p_job_id AND r.state = 'open'
    FOR UPDATE
  LOOP
    UPDATE public.rag_parse_budget_reservations SET state = 'released' WHERE id = rec.id;
  -- Per kind, decrement pages_reserved on the usage row (parse and vlm share the same counter).
    UPDATE public.rag_parse_budget_usage u
       SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages)
     WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;
    released := released + 1;
  END LOOP;
  RETURN released;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_parse_budget(p_job_id uuid, p_attempt_no integer, p_kind text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  rec public.rag_parse_budget_reservations%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO rec
    FROM public.rag_parse_budget_reservations r
   WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind
   FOR UPDATE;

  IF NOT FOUND OR rec.state = 'released' THEN
    RETURN false;
  END IF;
  IF rec.state = 'settled' THEN
    RETURN true;
  END IF;

  UPDATE public.rag_parse_budget_reservations SET state = 'released' WHERE id = rec.id;

  UPDATE public.rag_parse_budget_usage u
     SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages)
   WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_release_quarantine(p_document_id uuid, p_actor uuid)
 RETURNS TABLE(outcome text, document_id uuid, version integer, superseded_document_id uuid, rule_ids text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  doc public.documents%ROWTYPE;
  ids text[];
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

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  invoice_quarantined := (doc.metadata #>> '{invoice_extraction,status}') = 'quarantined';

  UPDATE public.documents d SET
    status = 'processing',
    metadata = COALESCE(d.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'quarantine',
        CASE WHEN jsonb_typeof(d.metadata -> 'quarantine') = 'object' THEN d.metadata -> 'quarantine' ELSE '{}'::jsonb END
          || jsonb_build_object(
            'released_by', p_actor::text,
            'released_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'released_rule_ids', to_jsonb(ids)))
      || CASE WHEN invoice_quarantined
              THEN jsonb_build_object('invoice_extraction', jsonb_build_object('status', 'released_unextracted'))
              ELSE '{}'::jsonb END,
    processing_state = CASE WHEN jsonb_typeof(d.processing_state -> 'quarantine') = 'object'
                            THEN jsonb_set(d.processing_state, '{quarantine,released}', 'true'::jsonb)
                            ELSE d.processing_state END
  WHERE d.id = doc.id;

  SELECT p.outcome, p.superseded_document_id INTO published FROM public.rag_publish_document_version(doc.id, doc.tenant_key) AS p;
  IF published.outcome IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'release_failed: %', COALESCE(published.outcome, 'unknown');
  END IF;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('release_quarantine', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT published.outcome, doc.id, doc.version, published.superseded_document_id, ids;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_relex_batch(p_rows jsonb, p_version integer)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_row jsonb;
  v_count integer := 0;
BEGIN
  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'relex_refused: invalid_version' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN 0;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) AS e(value) LOOP
    IF jsonb_typeof(v_row) <> 'object' OR NOT (v_row ? 'id') OR jsonb_typeof(v_row -> 'id') IS DISTINCT FROM 'string' THEN
      CONTINUE;
    END IF;
    UPDATE public.document_chunks c
    SET lexical_text = v_row ->> 'lexical_text',
        lexical_version = p_version,
        metadata = jsonb_set(coalesce(c.metadata, '{}'::jsonb), '{lexical_version}', to_jsonb(p_version), true),
        language = CASE
          WHEN c.language IS NULL AND v_row ? 'language' THEN NULLIF(v_row ->> 'language', '')
          ELSE c.language
        END
    WHERE c.id = (v_row ->> 'id')::uuid
      AND c.is_current
      AND c.status = 'ready';
    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_relex_candidates(p_after uuid, p_version integer, p_limit integer, p_tenant_key text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, tenant_key text, content text, section_path text[], chunk_kind text, metadata jsonb, language text, document_filename text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'relex_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT c.id,
         c.tenant_key,
         c.content,
         c.section_path,
         c.chunk_kind,
         c.metadata,
         c.language,
         d.filename AS document_filename
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.is_current
    AND c.status = 'ready'
    AND c.lexical_version IS DISTINCT FROM p_version
    AND (p_after IS NULL OR c.id > p_after)
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
  ORDER BY c.id
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_reserve_batch_budget(p_job_id uuid, p_usd numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_batch uuid;
  v_updated uuid;
BEGIN
  IF p_usd IS NULL OR p_usd < 0 THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_usd' USING ERRCODE = '22023';
  END IF;

  SELECT j.batch_id INTO v_batch FROM public.ingestion_jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_budget_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_batch IS NULL THEN
    RETURN true;
  END IF;

  UPDATE public.ingestion_batches b
     SET spent_usd = b.spent_usd + p_usd,
         updated_at = now()
   WHERE b.id = v_batch
     AND b.budget_usd IS NOT NULL
     AND b.spent_usd + p_usd <= b.budget_usd
  RETURNING b.id INTO v_updated;

  RETURN v_updated IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_reserve_parse_budget(p_job_id uuid, p_attempt_no integer, p_pages integer, p_kind text, p_limit integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tenant text;
  v_month date;
  v_reserved integer;
  v_row public.rag_parse_budget_usage%ROWTYPE;
BEGIN
  IF p_pages IS NULL OR p_pages <= 0 THEN
    RETURN false;
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 0 OR p_pages > p_limit THEN
    RETURN false;
  END IF;

  SELECT j.tenant_key INTO v_tenant FROM public.ingestion_jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_budget_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_tenant_key(v_tenant);

  v_month := date_trunc('month', now() AT TIME ZONE 'UTC')::date;

  IF EXISTS (
    SELECT 1 FROM public.rag_parse_budget_reservations r
    WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind AND r.state = 'open'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.rag_parse_budget_usage AS u (tenant_key, month, pages_reserved)
  VALUES (v_tenant, v_month, p_pages)
  ON CONFLICT (tenant_key, month) DO UPDATE
     SET pages_reserved = u.pages_reserved + EXCLUDED.pages_reserved
   WHERE u.pages_reserved + u.pages_used + u.vlm_pages_used + EXCLUDED.pages_reserved <= p_limit
  RETURNING u.* INTO v_row;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.rag_parse_budget_reservations (job_id, attempt_no, tenant_key, month, pages, kind, state)
  VALUES (p_job_id, p_attempt_no, v_tenant, v_month, p_pages, p_kind, 'open');

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_rollback_embedding_profile(p_actor text)
 RETURNS TABLE(restored_profile text, rolled_back_profile text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_active public.embedding_profiles%ROWTYPE;
  v_previous public.embedding_profiles%ROWTYPE;
  v_missing bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_active FROM public.embedding_profiles WHERE status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_active' USING ERRCODE = '55000';
  END IF;
  IF v_active.previous_active_id IS NULL THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_previous FROM public.embedding_profiles WHERE id = v_active.previous_active_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: no_previous' USING ERRCODE = '55000';
  END IF;

  IF v_previous.storage = 'legacy_column' THEN
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready' AND c.embedding IS NULL;
  ELSE
    SELECT count(*) INTO v_missing FROM public.document_chunks c
    WHERE c.is_current AND c.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = v_previous.id);
  END IF;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'rollback_refused: incomplete (% current ready chunks have no vector for profile %)', v_missing, v_previous.id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.embedding_profiles SET status = 'available' WHERE id = v_active.id;
  UPDATE public.embedding_profiles
  SET status = 'active', previous_active_id = NULL, activated_at = now(), activated_by = p_actor
  WHERE id = v_previous.id;

  RETURN QUERY SELECT v_previous.id, v_active.id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_save_ingest_state(p_document_id uuid, p_tenant_key text, p_processing_status text, p_state jsonb)
 RETURNS TABLE(document_id uuid, processing_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM 1 FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_state IS NOT NULL AND jsonb_typeof(p_state) <> 'object' THEN
    RAISE EXCEPTION 'invalid_state: p_state must be a JSON object';
  END IF;
  UPDATE public.documents d
  SET processing_status = p_processing_status, processing_state = COALESCE(p_state, '{}'::jsonb)
  WHERE d.id = p_document_id;
  RETURN QUERY SELECT d.id, d.processing_status FROM public.documents d WHERE d.id = p_document_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_doc_type_default(p_tenant_key text, p_source_kind text, p_source_ref text, p_doc_type text, p_updated_by text)
 RETURNS TABLE(tenant_key text, source_kind text, source_ref text, doc_type text, updated_by text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  ref text := p_source_ref;
BEGIN
  IF NOT public.rag_doc_type_tenant_key_ok(p_tenant_key) THEN
    RAISE EXCEPTION 'invalid_tenant_key';
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN ('tenant', 'chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload') THEN
    RAISE EXCEPTION 'invalid_source_kind';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('auto', 'general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image') THEN
    RAISE EXCEPTION 'invalid_doc_type';
  END IF;
  IF p_updated_by IS NULL OR btrim(p_updated_by) = '' THEN
    RAISE EXCEPTION 'actor_required';
  END IF;
  IF ref IS NOT NULL THEN
    ref := btrim(ref);
    IF p_source_kind <> 'nango' OR ref = '' OR length(ref) > 200 THEN
      RAISE EXCEPTION 'invalid_argument: source_ref is only for nango connection or folder ids';
    END IF;
  END IF;

  RETURN QUERY
  INSERT INTO public.rag_doc_type_defaults AS d (tenant_key, source_kind, source_ref, doc_type, updated_by, updated_at)
  VALUES (p_tenant_key, p_source_kind, ref, p_doc_type, btrim(p_updated_by), now())
  ON CONFLICT (tenant_key, source_kind, (COALESCE(source_ref, '')))
  DO UPDATE SET doc_type = EXCLUDED.doc_type, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
  RETURNING d.tenant_key, d.source_kind, d.source_ref, d.doc_type, d.updated_by, d.updated_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_document_fields(p_document_id uuid, p_tenant_key text, p_fields jsonb)
 RETURNS TABLE(document_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  field_name text;
  allowed text[] := ARRAY[
    'content_hash', 'language', 'doc_date', 'doc_type', 'doc_type_origin', 'parser_used', 'parser_version',
    'processing_profile_id', 'processing_profile_version', 'original_path', 'source_provider', 'source_file_id',
    'source_connection_id', 'status', 'metadata',
    'invoice_number', 'supplier_name', 'supplier_tax_id', 'issue_date', 'gross_total', 'currency',
    'content'
  ];
  doc public.documents%ROWTYPE;
  issue date;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_fields: p_fields must be a JSON object';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (field_name = ANY (allowed)) THEN
      RAISE EXCEPTION 'invalid_field: %', field_name;
    END IF;
  END LOOP;
  IF p_fields ? 'status' AND (jsonb_typeof(p_fields -> 'status') <> 'string'
      OR (p_fields ->> 'status') NOT IN ('processing', 'quarantined', 'failed', 'deleted')) THEN
    RAISE EXCEPTION 'invalid_status: %', p_fields ->> 'status';
  END IF;
  IF p_fields ? 'metadata' AND jsonb_typeof(p_fields -> 'metadata') <> 'object' THEN
    RAISE EXCEPTION 'invalid_metadata: metadata must be a JSON object';
  END IF;

  IF p_fields ? 'content' AND jsonb_typeof(p_fields -> 'content') <> 'string' THEN
    RAISE EXCEPTION 'invalid_field: content';
  END IF;
  IF p_fields ? 'invoice_number' AND jsonb_typeof(p_fields -> 'invoice_number') <> 'null'
      AND (jsonb_typeof(p_fields -> 'invoice_number') <> 'string' OR length(p_fields ->> 'invoice_number') > 64) THEN
    RAISE EXCEPTION 'invalid_field: invoice_number';
  END IF;
  IF p_fields ? 'supplier_name' AND jsonb_typeof(p_fields -> 'supplier_name') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_name') <> 'string' OR length(p_fields ->> 'supplier_name') > 300) THEN
    RAISE EXCEPTION 'invalid_field: supplier_name';
  END IF;
  IF p_fields ? 'supplier_tax_id' AND jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'string' OR length(p_fields ->> 'supplier_tax_id') > 64) THEN
    RAISE EXCEPTION 'invalid_field: supplier_tax_id';
  END IF;
  IF p_fields ? 'currency' AND jsonb_typeof(p_fields -> 'currency') <> 'null'
      AND (jsonb_typeof(p_fields -> 'currency') <> 'string' OR (p_fields ->> 'currency') !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'invalid_field: currency';
  END IF;
  IF p_fields ? 'gross_total' AND jsonb_typeof(p_fields -> 'gross_total') <> 'null'
      AND (jsonb_typeof(p_fields -> 'gross_total') <> 'string' OR (p_fields ->> 'gross_total') !~ '^-?[0-9]{1,16}(\.[0-9]{1,4})?$') THEN
    RAISE EXCEPTION 'invalid_field: gross_total';
  END IF;
  IF p_fields ? 'issue_date' AND jsonb_typeof(p_fields -> 'issue_date') <> 'null' THEN
    IF jsonb_typeof(p_fields -> 'issue_date') <> 'string' OR (p_fields ->> 'issue_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END IF;
    BEGIN
      issue := (p_fields ->> 'issue_date')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END;
  END IF;

  UPDATE public.documents d SET
    content_hash = CASE WHEN p_fields ? 'content_hash' THEN p_fields ->> 'content_hash' ELSE d.content_hash END,
    language = CASE WHEN p_fields ? 'language' THEN p_fields ->> 'language' ELSE d.language END,
    doc_date = CASE WHEN p_fields ? 'doc_date' THEN (p_fields ->> 'doc_date')::date ELSE d.doc_date END,
    doc_type = CASE WHEN p_fields ? 'doc_type' THEN p_fields ->> 'doc_type' ELSE d.doc_type END,
    doc_type_origin = CASE WHEN p_fields ? 'doc_type_origin' THEN p_fields ->> 'doc_type_origin' ELSE d.doc_type_origin END,
    parser_used = CASE WHEN p_fields ? 'parser_used' THEN p_fields ->> 'parser_used' ELSE d.parser_used END,
    parser_version = CASE WHEN p_fields ? 'parser_version' THEN p_fields ->> 'parser_version' ELSE d.parser_version END,
    processing_profile_id = CASE WHEN p_fields ? 'processing_profile_id' THEN p_fields ->> 'processing_profile_id' ELSE d.processing_profile_id END,
    processing_profile_version = CASE WHEN p_fields ? 'processing_profile_version' THEN (p_fields ->> 'processing_profile_version')::integer ELSE d.processing_profile_version END,
    original_path = CASE WHEN p_fields ? 'original_path' THEN p_fields ->> 'original_path' ELSE d.original_path END,
    source_provider = CASE WHEN p_fields ? 'source_provider' THEN p_fields ->> 'source_provider' ELSE d.source_provider END,
    source_file_id = CASE WHEN p_fields ? 'source_file_id' THEN p_fields ->> 'source_file_id' ELSE d.source_file_id END,
    source_connection_id = CASE WHEN p_fields ? 'source_connection_id' THEN p_fields ->> 'source_connection_id' ELSE d.source_connection_id END,
    status = CASE WHEN p_fields ? 'status' THEN p_fields ->> 'status' ELSE d.status END,
    metadata = CASE WHEN p_fields ? 'metadata' THEN COALESCE(d.metadata, '{}'::jsonb) || (p_fields -> 'metadata') ELSE d.metadata END,
    invoice_number = CASE WHEN p_fields ? 'invoice_number' THEN p_fields ->> 'invoice_number' ELSE d.invoice_number END,
    supplier_name = CASE WHEN p_fields ? 'supplier_name' THEN p_fields ->> 'supplier_name' ELSE d.supplier_name END,
    supplier_tax_id = CASE WHEN p_fields ? 'supplier_tax_id' THEN p_fields ->> 'supplier_tax_id' ELSE d.supplier_tax_id END,
    issue_date = CASE WHEN p_fields ? 'issue_date' THEN (p_fields ->> 'issue_date')::date ELSE d.issue_date END,
    gross_total = CASE WHEN p_fields ? 'gross_total' THEN (p_fields ->> 'gross_total')::numeric(20, 4) ELSE d.gross_total END,
    currency = CASE WHEN p_fields ? 'currency' THEN p_fields ->> 'currency' ELSE d.currency END,
    content = CASE WHEN p_fields ? 'content' THEN p_fields ->> 'content' ELSE d.content END
  WHERE d.id = p_document_id;

  IF p_fields ?| ARRAY['doc_type', 'doc_date', 'language', 'parser_used', 'status'] THEN
    UPDATE public.document_chunks c SET
      doc_type = d.doc_type,
      doc_date = d.doc_date,
      language = d.language,
      parser_used = d.parser_used,
      status = d.status,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('doc_type', d.doc_type, 'language', d.language, 'parser_used', d.parser_used)
    FROM public.documents d
    WHERE d.id = p_document_id AND c.document_id = d.id;
  END IF;

  RETURN QUERY SELECT d.id, d.status FROM public.documents d WHERE d.id = p_document_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_document_parse_cache(p_job_id uuid, p_cache_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job record;
  v_cache record;
  v_doc_tenant text;
BEGIN
  SELECT j.tenant_key, j.document_id INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id AND j.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.document_id IS NULL THEN
    RAISE EXCEPTION 'parse_cache_refused: document_not_linked' USING ERRCODE = '22023';
  END IF;
  SELECT c.id, c.tenant_key INTO v_cache FROM public.rag_parse_cache c WHERE c.id = p_cache_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_cache.tenant_key IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: cache_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  SELECT d.tenant_key INTO v_doc_tenant FROM public.documents d WHERE d.id = v_job.document_id;
  IF v_doc_tenant IS DISTINCT FROM v_job.tenant_key THEN
    RAISE EXCEPTION 'parse_cache_refused: document_tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  UPDATE public.documents d SET parse_cache_id = p_cache_id
   WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_embedding_profile_status(p_profile_id text, p_status text, p_actor text)
 RETURNS TABLE(profile_id text, profile_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_current text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'profile_status_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: use_activation_gate' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('available', 'backfilling', 'retired') THEN
    RAISE EXCEPTION 'profile_status_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  LOCK TABLE public.embedding_profiles IN SHARE ROW EXCLUSIVE MODE;

  SELECT p.status INTO v_current FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_status_refused: unknown_profile' USING ERRCODE = '22023';
  END IF;
  IF v_current = 'active' THEN
    RAISE EXCEPTION 'profile_status_refused: profile_is_active' USING ERRCODE = '22000';
  END IF;

  UPDATE public.embedding_profiles SET status = p_status WHERE id = p_profile_id;
  RETURN QUERY SELECT p_profile_id, p_status;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_set_parse_tier_override(p_doc_type text, p_min_tier text, p_max_tier text, p_actor uuid)
 RETURNS public.rag_parse_tier_overrides
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.rag_parse_tier_overrides%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'parse_tier_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  IF NOT public.rag_parse_doc_type_ok(p_doc_type) THEN
    RAISE EXCEPTION 'parse_tier_refused: invalid_doc_type' USING ERRCODE = '22023';
  END IF;

  IF p_min_tier IS NULL AND p_max_tier IS NULL THEN
    DELETE FROM public.rag_parse_tier_overrides WHERE doc_type = p_doc_type;
    INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
    VALUES (
      'set_parse_tier_override',
      '00000000-0000-4000-8000-000000000000',
      NULL,
      's:default',
      NULL,
      p_actor,
      ARRAY[p_doc_type, 'deleted']
    );
    RETURN NULL;
  END IF;

  IF p_min_tier IS NULL OR p_max_tier IS NULL
     OR p_min_tier NOT IN ('native', 'fast', 'structured', 'premium')
     OR p_max_tier NOT IN ('native', 'fast', 'structured', 'premium')
     OR public.rag_parse_tier_rank(p_min_tier) > public.rag_parse_tier_rank(p_max_tier) THEN
    RAISE EXCEPTION 'parse_tier_refused: invalid_bounds' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rag_parse_tier_overrides AS o (doc_type, min_tier, max_tier, updated_by, updated_at)
  VALUES (p_doc_type, p_min_tier, p_max_tier, p_actor::text, now())
  ON CONFLICT (doc_type) DO UPDATE
     SET min_tier = EXCLUDED.min_tier,
         max_tier = EXCLUDED.max_tier,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at
  RETURNING o.* INTO v_row;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES (
    'set_parse_tier_override',
    '00000000-0000-4000-8000-000000000000',
    NULL,
    's:default',
    NULL,
    p_actor,
    ARRAY[p_doc_type, p_min_tier, p_max_tier]
  );

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_settle_parse_budget(p_job_id uuid, p_attempt_no integer, p_kind text, p_pages_used integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  rec public.rag_parse_budget_reservations%ROWTYPE;
  v_used integer;
BEGIN
  IF p_pages_used IS NULL OR p_pages_used < 0 THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_pages' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('parse', 'vlm') THEN
    RAISE EXCEPTION 'parse_budget_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO rec
    FROM public.rag_parse_budget_reservations r
   WHERE r.job_id = p_job_id AND r.attempt_no = p_attempt_no AND r.kind = p_kind
   FOR UPDATE;

  IF NOT FOUND OR rec.state = 'released' THEN
    RETURN false;
  END IF;
  IF rec.state = 'settled' THEN
    RETURN true;
  END IF;

  v_used := GREATEST(0, LEAST(p_pages_used, rec.pages));

  UPDATE public.rag_parse_budget_reservations SET state = 'settled' WHERE id = rec.id;

  UPDATE public.rag_parse_budget_usage u
     SET pages_reserved = GREATEST(0, u.pages_reserved - rec.pages),
         pages_used = u.pages_used + CASE WHEN p_kind = 'parse' THEN v_used ELSE 0 END,
         vlm_pages_used = u.vlm_pages_used + CASE WHEN p_kind = 'vlm' THEN v_used ELSE 0 END
   WHERE u.tenant_key = rec.tenant_key AND u.month = rec.month;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_update_embed_batch(p_embed_batch_id uuid, p_status text, p_provider_batch_id text DEFAULT NULL::text, p_output_file_id text DEFAULT NULL::text, p_error_file_id text DEFAULT NULL::text, p_error text DEFAULT NULL::text)
 RETURNS public.rag_embed_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.rag_embed_batches%ROWTYPE;
BEGIN
  IF p_embed_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_embed_batch' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'pending', 'validating', 'failed', 'in_progress', 'finalizing', 'completed',
    'expired', 'cancelling', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.rag_embed_batches e
     SET status = p_status,
         provider_batch_id = COALESCE(p_provider_batch_id, e.provider_batch_id),
         output_file_id = COALESCE(p_output_file_id, e.output_file_id),
         error_file_id = COALESCE(p_error_file_id, e.error_file_id),
         error = COALESCE(p_error, e.error),
         updated_at = now()
   WHERE e.id = p_embed_batch_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: embed_batch_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_update_ingestion_batch(p_batch_id uuid, p_status text DEFAULT NULL::text, p_dry_run_report jsonb DEFAULT NULL::jsonb, p_totals jsonb DEFAULT NULL::jsonb)
 RETURNS public.ingestion_batches
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.ingestion_batches%ROWTYPE;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  IF p_status IS NOT NULL AND p_status NOT IN (
    'pending', 'sampling', 'running', 'completed', 'failed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ingestion_batches b
     SET status = COALESCE(p_status, b.status),
         dry_run_report = COALESCE(p_dry_run_report, b.dry_run_report),
         totals = COALESCE(p_totals, b.totals),
         updated_at = now()
   WHERE b.id = p_batch_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_last_updated_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at = TIMEZONE('utc', NOW());
    RETURN NEW;
END;
$function$;

COMMIT;

-- >>> supabase/migrations/0425_search_path_empty.multi-tenant.sql
-- 0425 (multi-tenant): empty search_path for every public SECURITY DEFINER function, every trigger function and every
-- function created from 0301 on (Phase 4 gap closure, plan 04-47). 0411 and the Phase 3, 3.1 and 4 migrations fixed search_path to
-- pg_catalog, public or to public (a few legacy functions to public, pg_temp, three multi-tenant legacy triggers to nothing), and a trigger
-- runs with the search_path of the statement that fired it, so a trigger without its own path breaks under an empty-path writer.
-- search_path = '' does not take pg_temp out of the path: when pg_temp is not listed, PostgreSQL still searches it first for relations and
-- types, before pg_catalog. So '' alone does not stop a temporary table from shadowing a name; qualifying every relation does, and the bodies
-- therefore name catalog tables pg_catalog.pg_attribute and pg_catalog.pg_extension as well. Functions and operators are never looked up in
-- pg_temp. Each function below is replaced with SET search_path = '' and a body that differs from the one it replaces only by schema-qualified
-- names: public. tables, row types, functions and the vector and halfvec types, OPERATOR(public.<=>) for pgvector (both setup files install
-- vector in public), and pg_catalog. catalog tables. Signature, defaults, volatility, SECURITY mode, owner and grants are unchanged: CREATE OR
-- REPLACE keeps the ACL and this file issues no GRANT or REVOKE. The first block stops with 55000 unless pgvector is in schema public (the
-- bodies name public.vector and OPERATOR(public.<=>)) and every function already exists, so the file never creates one with default PUBLIC
-- execute. tests/rag-db/search-path-empty.test.mts. Idempotent: CREATE OR REPLACE only.

BEGIN;

DO $search_path_precheck$
DECLARE
  v_missing text[];
  v_vector_schema text;
BEGIN
  SELECT n.nspname INTO v_vector_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';
  IF v_vector_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION '0425: pgvector must be in schema public, found %; check with: SELECT extname, extnamespace::regnamespace FROM pg_catalog.pg_extension WHERE extname = ''vector''',
      COALESCE(v_vector_schema, 'no vector extension') USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(s.sig ORDER BY s.sig) INTO v_missing
  FROM pg_catalog.unnest(ARRAY[
    'public.can_view_org_member(uuid,uuid)',
    'public.create_organization_safe(text,text,uuid,boolean)',
    'public.delete_folder(uuid,boolean)',
    'public.get_admin_organization_id()',
    'public.get_documents_by_type_slug(uuid,text,text)',
    'public.get_documents_by_type_slug_workspace(uuid,uuid,text,text)',
    'public.get_folder_stats(uuid)',
    'public.get_user_current_org()',
    'public.get_user_org_ids(uuid)',
    'public.get_user_role_in_org(uuid)',
    'public.get_workspace_context(text,uuid)',
    'public.is_org_admin(uuid)',
    'public.is_org_member(uuid,uuid)',
    'public.is_org_owner(uuid)',
    'public.match_document_chunks_by_org(uuid,public.vector,integer,double precision)',
    'public.match_documents_by_workspace(public.vector,integer,double precision,uuid,uuid)',
    'public.move_chats_to_folder(uuid[],uuid)',
    'public.rag_admin_tenant_keys(uuid)',
    'public.rag_assert_tenant_key(text)',
    'public.rag_ingest_realtime_topic_allowed(text)',
    'public.share_chat(uuid,jsonb)',
    'public.share_personal_organization(uuid)',
    'public.unshare_chat(uuid)',
    'public.update_org_storage()'
  ]::text[]) AS s(sig)
  WHERE pg_catalog.to_regprocedure(s.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0425: apply the earlier migrations first, these functions are missing: %', v_missing USING ERRCODE = '55000';
  END IF;
END
$search_path_precheck$;

CREATE OR REPLACE FUNCTION public.can_view_org_member(member_user_id uuid, member_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- User can view if it's their own membership
  SELECT member_user_id = auth.uid()
  -- Or if they're in the same organization
  OR EXISTS (
    SELECT 1 FROM public.organization_members om
    WHERE om.organization_id = member_org_id
      AND om.user_id = auth.uid()
  )
  -- Or if they own the organization
  OR EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = member_org_id
      AND o.owner_id = auth.uid()
  );
$function$;

CREATE OR REPLACE FUNCTION public.create_organization_safe(p_name text, p_slug text, p_owner_id uuid, p_is_personal boolean DEFAULT true)
 RETURNS public.organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_org public.organizations;
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
  INSERT INTO public.organizations (
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
  INSERT INTO public.organization_members (
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
$function$;

CREATE OR REPLACE FUNCTION public.delete_folder(folder_uuid uuid, delete_chats boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.folders
    WHERE id = folder_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete this folder';
  END IF;

  IF delete_chats THEN
    DELETE FROM public.chats
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  ELSE
    UPDATE public.chats
    SET folder_id = NULL
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  END IF;

  DELETE FROM public.folders
  WHERE id = folder_uuid AND user_id = auth.uid();

  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_organization_id()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  admin_org_id UUID;
BEGIN
  SELECT id INTO admin_org_id
  FROM public.organizations
  WHERE slug = 'admin-uploads'
  LIMIT 1;

  IF admin_org_id IS NULL THEN
    INSERT INTO public.organizations (
      name,
      slug,
      owner_id,
      is_personal,
      subscription_tier,
      storage_limit_bytes,
      max_documents,
      max_monthly_messages,
      max_team_members
    )
    SELECT
      'Admin Uploads (Config UI)',
      'admin-uploads',
      id,
      false,
      'enterprise',
      107374182400,
      10000,
      1000000,
      1000
    FROM auth.users
    LIMIT 1
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO admin_org_id;
  END IF;

  RETURN admin_org_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug(p_org_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH tenant_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, true as is_tenant
    FROM public.documents d
    WHERE d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
    ORDER BY d.created_at DESC
  ),
  global_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, false as is_tenant
    FROM public.documents d
    WHERE d.organization_id IS NULL
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
      AND NOT EXISTS (SELECT 1 FROM tenant_docs)
    ORDER BY d.created_at DESC
  )
  SELECT * FROM tenant_docs
  UNION ALL
  SELECT * FROM global_docs
  LIMIT 10;
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug_workspace(p_org_id uuid, p_user_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, user_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, true as is_tenant
    FROM public.documents d
    WHERE p_org_id IS NOT NULL
      AND d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  UNION ALL
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, false as is_tenant
    FROM public.documents d
    WHERE p_org_id IS NULL
      AND d.organization_id IS NULL
      AND d.user_id = p_user_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  LIMIT 10;
$function$;

CREATE OR REPLACE FUNCTION public.get_folder_stats(folder_uuid uuid)
 RETURNS TABLE(chat_count bigint, last_updated timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as chat_count,
    MAX(c.updated_at) as last_updated
  FROM public.chats c
  WHERE c.folder_id = folder_uuid
    AND c.user_id = auth.uid();
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_current_org()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  org_id UUID;
BEGIN
  SELECT current_organization_id INTO org_id
  FROM public.user_preferences
  WHERE user_id = auth.uid();

  IF org_id IS NULL THEN
    SELECT organization_id INTO org_id
    FROM public.organization_members
    WHERE user_id = auth.uid()
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  RETURN org_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_org_ids(check_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT organization_id
  FROM public.organization_members
  WHERE user_id = check_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_role_in_org(org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  user_role TEXT;
BEGIN
  SELECT role INTO user_role
  FROM public.organization_members
  WHERE organization_id = org_id
    AND user_id = auth.uid();

  RETURN user_role;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_workspace_context(p_domain text, p_user uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  org_id uuid;
BEGIN
  -- First check domain routing
  SELECT od.organization_id INTO org_id
  FROM public.organization_domains od
  WHERE od.domain = p_domain;

  -- Fallback to user preferences
  IF org_id IS NULL THEN
    SELECT up.current_organization_id INTO org_id
    FROM public.user_preferences up
    WHERE up.user_id = p_user;
  END IF;

  RETURN org_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_org_admin(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_org_member(org_id uuid, check_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN COALESCE(
    (check_user_id = auth.uid() OR auth.role() = 'service_role')
    AND EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE organization_id = org_id AND user_id = check_user_id
    ),
    false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_org_owner(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = org_id AND o.owner_id = auth.uid()),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.match_document_chunks_by_org(p_org_id uuid, p_query_embedding public.vector, p_match_count integer DEFAULT 8, p_min_similarity double precision DEFAULT 0.2)
 RETURNS TABLE(document_id uuid, chunk_id uuid, content text, similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    dc.document_id,
    dc.id as chunk_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity
  FROM public.document_chunks dc
  WHERE (dc.organization_id = p_org_id OR dc.organization_id IS NULL)
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) >= p_min_similarity
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT p_match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(p_query_embedding public.vector, p_match_count integer, p_min_similarity double precision, p_org_id uuid, p_user_id uuid)
 RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity,
    dc.metadata
  FROM public.document_chunks dc
  INNER JOIN public.documents d ON d.id = dc.document_id
  WHERE dc.embedding IS NOT NULL
    AND dc.is_current AND dc.status = 'ready'
    AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
    AND (
      -- Personal workspace: user owns document and no organization
      (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
      OR
      -- Team workspace: document belongs to organization
      (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
    )
  ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT p_match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.move_chats_to_folder(chat_ids uuid[], target_folder_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  updated_count INTEGER;
BEGIN
  IF target_folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.folders
    WHERE id = target_folder_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to use this folder';
  END IF;

  UPDATE public.chats
  SET folder_id = target_folder_id,
      updated_at = TIMEZONE('utc', NOW())
  WHERE id = ANY(chat_ids)
    AND user_id = auth.uid();

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  RETURN updated_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_admin_tenant_keys(p_actor uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  multi_tenant boolean;
  keys text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF NOT multi_tenant THEN
    RETURN ARRAY['s:default'];
  END IF;
  keys := ARRAY['u:' || p_actor::text];
  keys := keys || COALESCE(
    (SELECT array_agg('o:' || m.organization_id::text) FROM public.organization_members m WHERE m.user_id = p_actor AND m.role IN ('owner', 'admin')),
    '{}'::text[]
  );
  RETURN keys;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_assert_tenant_key(p_tenant_key text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF p_tenant_key IS NULL OR p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'malformed tenant key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key = 's:default' THEN
    RAISE EXCEPTION 'tenant key not valid for this deployment mode' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_realtime_topic_allowed(p_topic text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid;
  v_org uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_topic IS NULL OR btrim(p_topic) = '' THEN
    RETURN false;
  END IF;
  IF p_topic = 'rag-ingest:u:' || v_uid::text THEN
    RETURN true;
  END IF;
  IF p_topic ~ '^rag-ingest:o:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    BEGIN
      v_org := (regexp_match(p_topic, '^rag-ingest:o:([0-9a-f-]{36})$'))[1]::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN false;
    END;
    RETURN public.is_org_member(v_org, v_uid);
  END IF;
  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.share_chat(chat_uuid uuid, settings jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  new_share_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to share this chat';
  END IF;

  SELECT gen_random_uuid() INTO new_share_id;

  UPDATE public.chats
  SET is_shared = TRUE,
      share_id = new_share_id,
      share_settings = settings
  WHERE id = chat_uuid;

  RETURN new_share_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.share_personal_organization(org_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  org_record RECORD;
BEGIN
  -- Verify the organization exists and is personal
  SELECT * INTO org_record
  FROM public.organizations
  WHERE id = org_id
    AND is_personal = true
    AND owner_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found or not a personal organization';
  END IF;

  -- Convert to collaborative project
  UPDATE public.organizations
  SET
    is_personal = false,
    max_team_members = 5,  -- Default collaboration limit
    updated_at = NOW()
  WHERE id = org_id;

  RAISE NOTICE 'Converted personal organization % to collaborative project', org_id;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unshare_chat(chat_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to unshare this chat';
  END IF;

  UPDATE public.chats
  SET is_shared = FALSE
  WHERE id = chat_uuid;

  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_org_storage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.organizations
    SET storage_used_bytes = storage_used_bytes + COALESCE((NEW.metadata->>'file_size')::BIGINT, 0)
    WHERE id = NEW.organization_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.organizations
    SET storage_used_bytes = GREATEST(0, storage_used_bytes - COALESCE((OLD.metadata->>'file_size')::BIGINT, 0))
    WHERE id = OLD.organization_id;
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;

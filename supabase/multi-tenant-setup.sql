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

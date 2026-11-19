<overview>
myRAG uses Supabase (PostgreSQL + pgvector) with HNSW vector indexes. Schema files are in `supabase/single-tenant-setup.sql` (1665 lines) and `supabase/multi-tenant-setup.sql` (2199 lines). All tables enforce Row Level Security (RLS).
</overview>

<extensions>

## PostgreSQL Extensions

- `vector` - pgvector for embedding storage and similarity search
- `pg_trgm` - Trigram text search for fuzzy matching

</extensions>

<tables>

## Core Tables

### documents
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
filename    TEXT NOT NULL
content     TEXT
metadata    JSONB DEFAULT '{}'
organization_id UUID NULLABLE (FK → organizations)
source      TEXT  -- 'upload'|'google-drive'|'notion'|'dropbox'
source_provider TEXT
source_file_id TEXT
source_connection_id TEXT
created_at  TIMESTAMPTZ DEFAULT now()
```
Indexes: `idx_documents_filename`, `idx_documents_organization_id`, `idx_documents_source`, `idx_documents_source_provider`

### document_chunks
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
document_id     UUID NOT NULL (FK → documents ON DELETE CASCADE)
content         TEXT NOT NULL
embedding       vector(1536) NOT NULL
metadata        JSONB DEFAULT '{}'
organization_id UUID NULLABLE (FK → organizations)
created_at      TIMESTAMPTZ DEFAULT now()
```

**Critical HNSW Vector Index:**
```sql
CREATE INDEX idx_document_chunks_embedding ON document_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 64, ef_construction = 200);
```
- Algorithm: HNSW (Hierarchical Navigable Small World)
- Distance: cosine similarity (`vector_cosine_ops`)
- m=64: High connection pool for better recall
- ef_construction=200: High quality index construction
- 15-28x faster than IVFFlat
- Dimensions: 1536 (text-embedding-3-small)

Other indexes: `idx_document_chunks_document_id`, `idx_document_chunks_organization_id`

### chats
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id         UUID NOT NULL (FK → auth.users)
title           TEXT
messages        JSONB NOT NULL DEFAULT '[]'
pinned          BOOLEAN DEFAULT false
folder_id       UUID NULLABLE (FK → folders)
organization_id UUID NULLABLE (FK → organizations)
shared          BOOLEAN DEFAULT false
share_id        UUID UNIQUE
is_shared       BOOLEAN DEFAULT false
share_settings  JSONB DEFAULT '{}'
mcp_tool_states JSONB DEFAULT '{}'
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()
```
Indexes: `idx_chats_user_id_updated_at_desc`, `idx_chats_updated_at_desc`, `idx_chats_share_id`, `idx_chats_mcp_tool_states` (GIN), `chats_pinned_idx`

### folders
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id         UUID NOT NULL (FK → auth.users)
name            TEXT NOT NULL
color           TEXT DEFAULT '#6366f1'
pinned          BOOLEAN DEFAULT false
organization_id UUID NULLABLE
created_at      TIMESTAMPTZ DEFAULT now()
updated_at      TIMESTAMPTZ DEFAULT now()
```
Indexes: `idx_folders_user_id`, `idx_folders_pinned`, `idx_folders_created_at`, `idx_folders_organization_id`

### subscriptions
```sql
id                      UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id                 UUID UNIQUE NOT NULL (FK → auth.users)
polar_subscription_id   TEXT
stripe_subscription_id  TEXT
stripe_customer_id      TEXT
-- Additional subscription state fields
```

### admin_users
```sql
id         UUID PRIMARY KEY DEFAULT gen_random_uuid()
email      TEXT UNIQUE NOT NULL
user_id    UUID (FK → auth.users)
created_at TIMESTAMPTZ DEFAULT now()
```

### admin_settings
```sql
id                      UUID PRIMARY KEY DEFAULT gen_random_uuid()
read_only_doc_dashboard BOOLEAN DEFAULT true
updated_by              TEXT
updated_at              TIMESTAMPTZ DEFAULT now()
```

### tool_execution_states
```sql
tool_call_id TEXT PRIMARY KEY
chat_id      TEXT NOT NULL
message_id   INTEGER NOT NULL
tool_name    TEXT NOT NULL
tool_input   JSONB
status       TEXT DEFAULT 'pending'  -- pending|approved|running|completed|error|cancelled
result       JSONB
error_message TEXT
created_at   TIMESTAMPTZ DEFAULT now()
updated_at   TIMESTAMPTZ DEFAULT now()
```

</tables>

<multi_tenant_tables>

## Multi-Tenant Tables (additional)

### organizations
```sql
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
name        TEXT NOT NULL
slug        TEXT UNIQUE NOT NULL
is_personal BOOLEAN DEFAULT false
owner_id    UUID NOT NULL (FK → auth.users)
settings    JSONB DEFAULT '{}'
created_at  TIMESTAMPTZ DEFAULT now()
updated_at  TIMESTAMPTZ DEFAULT now()
```

### organization_members
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
organization_id UUID NOT NULL (FK → organizations)
user_id         UUID NOT NULL (FK → auth.users)
role            TEXT DEFAULT 'member'  -- admin|member
joined_at       TIMESTAMPTZ DEFAULT now()
UNIQUE(organization_id, user_id)
```

### team_invites
```sql
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
organization_id UUID NOT NULL (FK → organizations)
email           TEXT NOT NULL
role            TEXT DEFAULT 'member'
token           TEXT UNIQUE NOT NULL
invited_by      UUID (FK → auth.users)
status          TEXT DEFAULT 'pending'  -- pending|accepted|expired
created_at      TIMESTAMPTZ DEFAULT now()
expires_at      TIMESTAMPTZ
```

</multi_tenant_tables>

<rpc_functions>

## Key RPC Functions

- `match_document_chunks(query_embedding, match_count, similarity_threshold)` - Vector search
- `match_documents_by_workspace(p_org_id, p_user_id, p_query_embedding, p_match_count, p_min_similarity)` - Multi-tenant vector search
- `is_admin()` - Check if current user is admin
- `delete_folder(folder_id, delete_chats)` - Cascade folder deletion
- `move_chats_to_folder(chat_ids, folder_id)` - Bulk chat move
- `create_organization_safe(name, slug)` - Safe org creation with validation

</rpc_functions>

<rls_policies>

## Row Level Security

All tables enforce RLS. Key patterns:

**Single-tenant:** Users access only their own data via `auth.uid() = user_id`

**Multi-tenant:** Users access data through organization membership:
```sql
-- Example: chats policy
CREATE POLICY "Users can access own chats or org chats" ON chats
FOR ALL USING (
  user_id = auth.uid()
  OR organization_id IN (
    SELECT organization_id FROM organization_members
    WHERE user_id = auth.uid()
  )
);
```

**Documents (single-tenant):** May allow public read depending on mode
**Admin tables:** Restricted to users in `admin_users` table

</rls_policies>

<performance>

## Performance Notes

- HNSW index: 15-28x faster than IVFFlat for similarity search
- Composite indexes on frequent query patterns (user_id + updated_at)
- GIN indexes for JSONB queries (mcp_tool_states)
- Partial indexes for conditional filters (pinned chats)
- Connection pooling via Supabase
- Cascading deletes prevent orphaned data

</performance>

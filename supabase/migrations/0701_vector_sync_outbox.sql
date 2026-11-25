-- 0701: Phase 7 vector sync change capture, tables (D-01, D-11, A-12).
-- vector_sync_outbox is notification-only: it names what changed, never its content; the drain worker reads the current row.
-- entity_id is text: a chunk or document UUID, a tenant key, or a prefixed profile id (embedding:<id>, chunking:<doc_type>).
-- cursor holds the paging position of a tenant, profile or large-document row. last_error holds codes only, never content.
-- rag_vector_sync_targets switches each backend; both are seeded disabled, which makes every 0702 trigger a no-op.
-- rag_backend_index_state is the per (target, profile, tenant) readiness record that retrieval falls back on (RET-09).
-- Additive and idempotent. Server role only: RLS on, no policies, no client grants.

BEGIN;

CREATE TABLE IF NOT EXISTS public.vector_sync_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  tenant_key text,
  profile_id text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  lease_until timestamptz,
  last_error text,
  cursor text,
  CONSTRAINT vector_sync_outbox_target_check CHECK (target IN ('weaviate', 'qdrant')),
  CONSTRAINT vector_sync_outbox_entity_check CHECK (entity IN ('chunk', 'document', 'profile', 'tenant')),
  CONSTRAINT vector_sync_outbox_status_check CHECK (status IN ('pending', 'leased', 'done', 'dead')),
  CONSTRAINT vector_sync_outbox_tenant_key_check CHECK (
    tenant_key IS NULL OR tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT vector_sync_outbox_tenant_required CHECK (entity = 'profile' OR tenant_key IS NOT NULL),
  CONSTRAINT vector_sync_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT vector_sync_outbox_last_error_length CHECK (last_error IS NULL OR length(last_error) <= 200)
);

CREATE INDEX IF NOT EXISTS vector_sync_outbox_claim_idx ON public.vector_sync_outbox (status, lease_until, enqueued_at);
CREATE INDEX IF NOT EXISTS vector_sync_outbox_entity_idx ON public.vector_sync_outbox (target, entity, entity_id);

CREATE TABLE IF NOT EXISTS public.rag_vector_sync_targets (
  target text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT rag_vector_sync_targets_target_check CHECK (target IN ('weaviate', 'qdrant'))
);

INSERT INTO public.rag_vector_sync_targets (target, enabled) VALUES ('weaviate', false), ('qdrant', false)
ON CONFLICT (target) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.rag_backend_index_state (
  target text NOT NULL,
  profile_id text NOT NULL,
  tenant_key text NOT NULL,
  state text NOT NULL DEFAULT 'building',
  last_reconciled_at timestamptz,
  lag_seconds integer,
  supabase_count bigint,
  backend_count bigint,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target, profile_id, tenant_key),
  CONSTRAINT rag_backend_index_state_target_check CHECK (target IN ('weaviate', 'qdrant')),
  CONSTRAINT rag_backend_index_state_state_check CHECK (state IN ('building', 'ready', 'stale', 'failed')),
  CONSTRAINT rag_backend_index_state_tenant_key_check CHECK (
    tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  CONSTRAINT rag_backend_index_state_last_error_length CHECK (last_error IS NULL OR length(last_error) <= 200)
);

ALTER TABLE public.vector_sync_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_vector_sync_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_backend_index_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vector_sync_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_vector_sync_targets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_backend_index_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vector_sync_outbox TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_vector_sync_targets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_backend_index_state TO service_role;

DO $$
DECLARE
  v_seq text := pg_get_serial_sequence('public.vector_sync_outbox', 'id');
BEGIN
  IF v_seq IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', v_seq);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', v_seq);
  END IF;
END
$$;

COMMIT;

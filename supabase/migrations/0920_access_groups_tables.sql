-- 0920: document access group stores (Phase 4.3, SEC-12, SEC-13, DATA-22; D-01, D-04, D-20, D-26, A-03, A-07).
-- rag_access_groups and rag_access_group_members: a group belongs to exactly one tenant (the tenant columns come from the mode files);
-- the key matches ^[a-z0-9][a-z0-9-]{0,62}$, is never 'all' and cannot change after insert. rag_access_group_settings holds one row with
-- enforced false (A-03: the app writes it from RAG_DOC_ACCESS_GROUPS at startup). rag_connector_group_map, rag_connector_sharing_rules
-- (created off) and rag_connector_document_principals hold the connector permission mapping (D-20); principals are groups, teams,
-- workspaces, domains and link kinds, never a person. rag_access_security_events (D-26) and rag_access_audit (A-07) hold ids, arrays and
-- codes only, with no content column; audit rows carry no foreign keys, so they outlive deletes. rag_admin_audit is unchanged.
-- The D-26 store is named rag_access_security_events because Phase 5.2 (0942) already owns public.rag_security_events with another shape.
-- Access: RLS on everywhere; every privilege revoked from PUBLIC, anon and authenticated; service_role reads and writes; the one client
-- policy is rag_access_group_members_select_own (an authenticated user reads their own membership rows). Trigger functions are
-- SECURITY INVOKER with SET search_path = '' and service_role execute only. Not folded into the setup files. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_access_groups (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT rag_access_groups_key_check CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT rag_access_groups_key_reserved_check CHECK (key <> 'all'),
  CONSTRAINT rag_access_groups_name_check CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT rag_access_groups_source_check CHECK (source IN ('manual', 'connector'))
);

CREATE OR REPLACE FUNCTION public.rag_access_groups_immutable_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'access_group_key_immutable' USING ERRCODE = '22023';
  END IF;
  IF (pg_catalog.to_jsonb(NEW) -> 'organization_id') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) -> 'organization_id') THEN
    RAISE EXCEPTION 'access_group_tenant_immutable' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_immutable_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_immutable_key() TO service_role;

DROP TRIGGER IF EXISTS rag_access_groups_immutable_key ON public.rag_access_groups;
CREATE TRIGGER rag_access_groups_immutable_key
  BEFORE UPDATE ON public.rag_access_groups
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_immutable_key();

CREATE TABLE IF NOT EXISTS public.rag_access_group_members (
  group_id uuid NOT NULL REFERENCES public.rag_access_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  source text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (user_id, group_id),
  CONSTRAINT rag_access_group_members_source_check CHECK (source IN ('manual', 'connector'))
);

CREATE INDEX IF NOT EXISTS rag_access_group_members_group_idx ON public.rag_access_group_members (group_id);

CREATE TABLE IF NOT EXISTS public.rag_access_group_settings (
  id boolean PRIMARY KEY DEFAULT true,
  enforced boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid,
  CONSTRAINT rag_access_group_settings_single_row CHECK (id)
);

INSERT INTO public.rag_access_group_settings (id, enforced) VALUES (true, false) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.rag_connector_group_map (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  provider text NOT NULL,
  external_principal_id text NOT NULL,
  kind text NOT NULL,
  group_id uuid NOT NULL REFERENCES public.rag_access_groups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid,
  CONSTRAINT rag_connector_group_map_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_connector_group_map_provider_check CHECK (provider IN ('google-drive', 'dropbox', 'notion')),
  CONSTRAINT rag_connector_group_map_kind_check CHECK (kind IN ('group', 'team', 'workspace')),
  CONSTRAINT rag_connector_group_map_principal_check CHECK (pg_catalog.char_length(external_principal_id) BETWEEN 1 AND 512),
  CONSTRAINT rag_connector_group_map_principal_key UNIQUE (tenant_key, provider, external_principal_id)
);

CREATE INDEX IF NOT EXISTS rag_connector_group_map_group_idx ON public.rag_connector_group_map (group_id);

CREATE OR REPLACE FUNCTION public.rag_connector_group_map_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_group_tenant text;
BEGIN
  SELECT g.tenant_key INTO v_group_tenant FROM public.rag_access_groups g WHERE g.id = NEW.group_id;
  IF v_group_tenant IS NULL OR v_group_tenant IS DISTINCT FROM NEW.tenant_key THEN
    RAISE EXCEPTION 'cross_tenant_group' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_group_map_same_tenant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_group_map_same_tenant() TO service_role;

DROP TRIGGER IF EXISTS rag_connector_group_map_same_tenant ON public.rag_connector_group_map;
CREATE TRIGGER rag_connector_group_map_same_tenant
  BEFORE INSERT OR UPDATE OF tenant_key, group_id ON public.rag_connector_group_map
  FOR EACH ROW EXECUTE FUNCTION public.rag_connector_group_map_same_tenant();

CREATE TABLE IF NOT EXISTS public.rag_connector_sharing_rules (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL,
  domain text,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid,
  CONSTRAINT rag_connector_sharing_rules_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_connector_sharing_rules_provider_check CHECK (provider IN ('google-drive', 'dropbox', 'notion')),
  CONSTRAINT rag_connector_sharing_rules_kind_check CHECK (kind IN ('domain', 'anyone', 'public')),
  CONSTRAINT rag_connector_sharing_rules_domain_check CHECK (
    (kind = 'domain' AND domain IS NOT NULL AND pg_catalog.char_length(domain) <= 253
      AND domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
    OR (kind <> 'domain' AND domain IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_connector_sharing_rules_unique_idx
  ON public.rag_connector_sharing_rules (tenant_key, provider, kind, COALESCE(domain, ''));

CREATE TABLE IF NOT EXISTS public.rag_connector_document_principals (
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  provider text NOT NULL,
  kind text NOT NULL,
  external_principal_id text NOT NULL DEFAULT '',
  mapped boolean NOT NULL DEFAULT false,
  seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (document_id, provider, kind, external_principal_id),
  CONSTRAINT rag_connector_document_principals_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_connector_document_principals_provider_check CHECK (provider IN ('google-drive', 'dropbox', 'notion')),
  CONSTRAINT rag_connector_document_principals_kind_check
    CHECK (kind IN ('group', 'team', 'workspace', 'domain', 'anyone', 'public')),
  CONSTRAINT rag_connector_document_principals_principal_check CHECK (pg_catalog.char_length(external_principal_id) <= 512)
);

CREATE INDEX IF NOT EXISTS rag_connector_document_principals_lookup_idx
  ON public.rag_connector_document_principals (tenant_key, provider, kind, external_principal_id);

CREATE TABLE IF NOT EXISTS public.rag_access_security_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event text NOT NULL,
  chunk_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  document_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  request_id text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_access_security_events_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_access_security_events_event_check CHECK (event IN ('citation_access_violation')),
  CONSTRAINT rag_access_security_events_ids_check
    CHECK (pg_catalog.cardinality(chunk_ids) <= 1000 AND pg_catalog.cardinality(document_ids) <= 1000),
  CONSTRAINT rag_access_security_events_request_id_check CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9_.:-]{1,200}$')
);

CREATE INDEX IF NOT EXISTS rag_access_security_events_tenant_created_idx
  ON public.rag_access_security_events (tenant_key, created_at);

CREATE TABLE IF NOT EXISTS public.rag_access_audit (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  action text NOT NULL,
  actor uuid,
  actor_kind text NOT NULL,
  group_id uuid,
  document_id uuid,
  lineage_id uuid,
  before_groups text[],
  after_groups text[],
  reason text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_access_audit_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_access_audit_action_check CHECK (action IN (
    'group_create', 'group_rename', 'group_delete', 'member_add', 'member_remove', 'document_set', 'document_fallback',
    'connector_map_set', 'connector_map_delete', 'sharing_rule_set', 'enforcement_set'
  )),
  CONSTRAINT rag_access_audit_actor_kind_check CHECK (actor_kind IN ('admin', 'connector', 'system')),
  CONSTRAINT rag_access_audit_reason_check CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$')
);

CREATE INDEX IF NOT EXISTS rag_access_audit_tenant_created_idx ON public.rag_access_audit (tenant_key, created_at);

ALTER TABLE public.rag_access_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_group_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_connector_group_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_connector_sharing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_connector_document_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_access_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_access_groups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_group_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_group_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_connector_group_map FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_connector_sharing_rules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_connector_document_principals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_security_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_access_audit FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.rag_access_security_events FROM service_role;
REVOKE ALL ON TABLE public.rag_access_audit FROM service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_access_groups TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_access_group_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_access_group_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_connector_group_map TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_connector_sharing_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_connector_document_principals TO service_role;
GRANT SELECT, INSERT ON TABLE public.rag_access_security_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.rag_access_audit TO service_role;

GRANT SELECT ON TABLE public.rag_access_group_members TO authenticated;

DROP POLICY IF EXISTS rag_access_group_members_select_own ON public.rag_access_group_members;
CREATE POLICY rag_access_group_members_select_own ON public.rag_access_group_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';

COMMIT;

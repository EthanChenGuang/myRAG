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
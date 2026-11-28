-- 1001: Phase 3.3 schema for templated-collection ingestion (TPL-08, D-02, D-12, D-16, D-18, D-22, D-26, D-27).
-- Five tenant tables: rag_section_rule_sets (section rule sets with an optional document type and source binding, at most one enabled per
-- binding), rag_boilerplate_rules (line rules with a pattern or fragment rules with a maximum length and a minimum page share, never both),
-- rag_attribute_definitions (the attribute schema of a tenant), rag_attribute_header_templates (one header template per tenant) and
-- rag_staged_attributes (attribute values staged by source and source key before their document exists).
-- Security: row security is enabled on each table and no policy is created; every privilege is revoked from PUBLIC, anon and authenticated and
-- only service_role reads and writes them (the writer functions of later Phase 3.3 migrations). The shared tenant key guard of 0853 checks the
-- tenant key format of the deployment mode on insert and on every tenant key change.
-- documents gains attributes, attribute_header and attribute_header_stamp; document_chunks gains attributes (GIN index) and
-- attribute_header_stamp. All are nullable without a default, so every existing row keeps null. A second update trigger runs the column guard
-- of 0320 with the new column names, so a signed-in user cannot change them through the tables; the Phase 3 guard triggers are untouched.
-- Row limits of D-12 are CHECK constraints here. Count limits per tenant (10 rule sets, 40 boilerplate rules, 30 attribute definitions) and the
-- limits on values inside jsonb (heading pattern length and flags, 200 characters per value, 50 values per list) are enforced by the writer
-- functions of plans 03.3-07, 03.3-08 and 03.3-11.
-- Purge: no new table refers to a document, chunk or lineage; the new document and chunk columns go with their rows. This file defines no
-- function and replaces no trigger of another phase.
-- Idempotent; not folded into the setup files.

BEGIN;

DO $phase33_precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_identifier_patterns') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_row_tenant_key_guard()') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_guard_ingest_state()') IS NULL THEN
    RAISE EXCEPTION '1001: apply 0854 first' USING ERRCODE = '55000';
  END IF;
END
$phase33_precheck$;

-- Section rule sets (D-18): the binding columns hold a document type and a source in identifier shape; the writers check the values.
CREATE TABLE IF NOT EXISTS public.rag_section_rule_sets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  name text NOT NULL,
  doc_type text,
  source text,
  enabled boolean NOT NULL DEFAULT true,
  rules jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_section_rule_sets_name_check CHECK (pg_catalog.length(pg_catalog.btrim(name)) >= 1 AND pg_catalog.length(name) <= 80),
  CONSTRAINT rag_section_rule_sets_doc_type_check CHECK (doc_type IS NULL OR doc_type ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT rag_section_rule_sets_source_check CHECK (source IS NULL OR source ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT rag_section_rule_sets_rules_check CHECK (
    CASE
      WHEN pg_catalog.jsonb_typeof(rules) = 'object' AND pg_catalog.jsonb_typeof(rules -> 'headings') = 'array'
        THEN pg_catalog.jsonb_array_length(rules -> 'headings') BETWEEN 1 AND 60
      ELSE false
    END
  ),
  CONSTRAINT rag_section_rule_sets_version_check CHECK (version >= 1),
  CONSTRAINT rag_section_rule_sets_tenant_name_ux UNIQUE (tenant_key, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_section_rule_sets_enabled_binding_ux
  ON public.rag_section_rule_sets (tenant_key, (COALESCE(doc_type, '')), (COALESCE(source, '')))
  WHERE enabled;

-- Boilerplate rules (D-16): a line rule has a pattern and flags and no fragment numbers; a fragment rule has both numbers and no pattern.
CREATE TABLE IF NOT EXISTS public.rag_boilerplate_rules (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  pattern text,
  flags text,
  max_length integer,
  min_page_share double precision,
  doc_type text,
  source text,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_boilerplate_rules_name_check CHECK (pg_catalog.length(pg_catalog.btrim(name)) >= 1 AND pg_catalog.length(name) <= 80),
  CONSTRAINT rag_boilerplate_rules_kind_check CHECK (kind IN ('line', 'fragment')),
  CONSTRAINT rag_boilerplate_rules_shape_check CHECK (
    (kind = 'line' AND pattern IS NOT NULL AND pg_catalog.length(pattern) BETWEEN 1 AND 200 AND flags IS NOT NULL AND flags IN ('u', 'iu')
      AND max_length IS NULL AND min_page_share IS NULL)
    OR
    (kind = 'fragment' AND pattern IS NULL AND flags IS NULL AND max_length IS NOT NULL AND max_length BETWEEN 1 AND 200
      AND min_page_share IS NOT NULL AND min_page_share > 0 AND min_page_share <= 1)
  ),
  CONSTRAINT rag_boilerplate_rules_doc_type_check CHECK (doc_type IS NULL OR doc_type ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT rag_boilerplate_rules_source_check CHECK (source IS NULL OR source ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT rag_boilerplate_rules_version_check CHECK (version >= 1),
  CONSTRAINT rag_boilerplate_rules_tenant_name_ux UNIQUE (tenant_key, name)
);

-- Attribute definitions (D-22): the identifier-index flag applies to type code only.
CREATE TABLE IF NOT EXISTS public.rag_attribute_definitions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  key text NOT NULL,
  type text NOT NULL,
  filterable boolean NOT NULL DEFAULT false,
  in_header boolean NOT NULL DEFAULT false,
  in_identifier_index boolean NOT NULL DEFAULT false,
  soft boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_attribute_definitions_key_check CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT rag_attribute_definitions_type_check CHECK (type IN ('text', 'text_list', 'code')),
  CONSTRAINT rag_attribute_definitions_identifier_index_check CHECK (NOT in_identifier_index OR type = 'code'),
  CONSTRAINT rag_attribute_definitions_tenant_key_ux UNIQUE (tenant_key, key)
);

-- Header template (D-26): one row per tenant.
CREATE TABLE IF NOT EXISTS public.rag_attribute_header_templates (
  tenant_key text PRIMARY KEY,
  template text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_attribute_header_templates_template_check CHECK (pg_catalog.length(template) BETWEEN 1 AND 200),
  CONSTRAINT rag_attribute_header_templates_version_check CHECK (version >= 1)
);

-- Staged attribute values (D-23, D-24). Byte bound: 30 keys of at most 40 characters, each with up to 50 values of 200 characters; a character
-- takes at most 6 bytes in the JSON text (an escape sequence), so 30 * (50 * (200 * 6 + 4) + 50) stays under 2,000,000 bytes.
CREATE TABLE IF NOT EXISTS public.rag_staged_attributes (
  tenant_key text NOT NULL,
  source text NOT NULL,
  source_key text NOT NULL,
  attributes jsonb NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_staged_attributes_pkey PRIMARY KEY (tenant_key, source, source_key),
  CONSTRAINT rag_staged_attributes_source_check CHECK (source ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT rag_staged_attributes_source_key_check CHECK (pg_catalog.length(source_key) BETWEEN 1 AND 1024),
  CONSTRAINT rag_staged_attributes_attributes_check CHECK (
    pg_catalog.jsonb_typeof(attributes) = 'object' AND pg_catalog.octet_length(attributes::text) <= 2000000
  )
);

ALTER TABLE public.rag_section_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_boilerplate_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_attribute_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_attribute_header_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_staged_attributes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_section_rule_sets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_boilerplate_rules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_attribute_definitions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_attribute_header_templates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_staged_attributes FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_section_rule_sets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_boilerplate_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_attribute_definitions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_attribute_header_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_staged_attributes TO service_role;

DROP TRIGGER IF EXISTS rag_section_rule_sets_tenant_key_guard ON public.rag_section_rule_sets;
CREATE TRIGGER rag_section_rule_sets_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_section_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

DROP TRIGGER IF EXISTS rag_boilerplate_rules_tenant_key_guard ON public.rag_boilerplate_rules;
CREATE TRIGGER rag_boilerplate_rules_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_boilerplate_rules
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

DROP TRIGGER IF EXISTS rag_attribute_definitions_tenant_key_guard ON public.rag_attribute_definitions;
CREATE TRIGGER rag_attribute_definitions_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_attribute_definitions
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

DROP TRIGGER IF EXISTS rag_attribute_header_templates_tenant_key_guard ON public.rag_attribute_header_templates;
CREATE TRIGGER rag_attribute_header_templates_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_attribute_header_templates
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

DROP TRIGGER IF EXISTS rag_staged_attributes_tenant_key_guard ON public.rag_staged_attributes;
CREATE TRIGGER rag_staged_attributes_tenant_key_guard
  BEFORE INSERT OR UPDATE OF tenant_key ON public.rag_staged_attributes
  FOR EACH ROW EXECUTE FUNCTION public.rag_row_tenant_key_guard();

-- Document and chunk columns (D-22, D-26, D-27): nullable, no default.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS attributes jsonb;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS attribute_header text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS attribute_header_stamp text;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS attributes jsonb;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS attribute_header_stamp text;

DO $phase33_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_attributes_object_check') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_attributes_object_check
      CHECK (attributes IS NULL OR pg_catalog.jsonb_typeof(attributes) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_attribute_header_stamp_check') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_attribute_header_stamp_check
      CHECK (attribute_header_stamp IS NULL OR pg_catalog.length(attribute_header_stamp) <= 64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.document_chunks'::regclass AND conname = 'document_chunks_attributes_object_check') THEN
    ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_attributes_object_check
      CHECK (attributes IS NULL OR pg_catalog.jsonb_typeof(attributes) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.document_chunks'::regclass AND conname = 'document_chunks_attribute_header_stamp_check') THEN
    ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_attribute_header_stamp_check
      CHECK (attribute_header_stamp IS NULL OR pg_catalog.length(attribute_header_stamp) <= 64);
  END IF;
END
$phase33_checks$;

CREATE INDEX IF NOT EXISTS document_chunks_attributes_gin ON public.document_chunks USING gin (attributes);

-- Column guard (T-03.3-11): the guard function of 0320 with the new column names, under its own trigger name.
DROP TRIGGER IF EXISTS rag_guard_phase33_columns ON public.documents;
CREATE TRIGGER rag_guard_phase33_columns
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_ingest_state('attributes', 'attribute_header', 'attribute_header_stamp');

DROP TRIGGER IF EXISTS rag_guard_phase33_columns ON public.document_chunks;
CREATE TRIGGER rag_guard_phase33_columns
  BEFORE UPDATE ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_guard_ingest_state('attributes', 'attribute_header_stamp');

NOTIFY pgrst, 'reload schema';

COMMIT;

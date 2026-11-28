-- 0471: Phase 4.1.1 terminology dictionary storage and the effective-dictionary read (D-01, D-02, D-04, D-06, D-07, D-22, D-32, D-35).
-- rag_term_layers holds one row per layer ('shared' for the deployment, or a tenant key) with the version every write bumps.
-- rag_term_entries holds the entries of every layer; a workspace row with suppresses_entry_id set hides that shared entry for its tenant.
-- rag_term_audit is append-only. No entry id is a foreign key there, so audit rows outlive deleted entries.
-- Languages are checked by shape only (the literal any or a lower-case code); whether a code is enabled is checked in the app (D-35).
-- Translation pairs (kind translation) carry source_language and target_language; no other kind does (D-04, D-32).
-- Server role only: RLS on without policies, nothing granted to PUBLIC, anon or authenticated, service_role may SELECT. Writes go through
-- the SECURITY DEFINER writers of 0472.
-- rag_term_effective(p_tenant_key) is SECURITY INVOKER with an empty search_path, executable by service_role only, and checks the tenant
-- key with rag_assert_tenant_key first. It returns the enabled shared entries the tenant does not suppress plus the tenant's enabled
-- entries, translation pairs included, with both layer versions (0 when the layer row does not exist).
-- Idempotent: IF NOT EXISTS, guarded constraints, DROP and CREATE of the read function, then REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_term_layers (
  layer_key text PRIMARY KEY
    CONSTRAINT rag_term_layers_layer_key_check
    CHECK (layer_key = 'shared' OR layer_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  version bigint NOT NULL DEFAULT 0 CONSTRAINT rag_term_layers_version_check CHECK (version >= 0),
  entries_sha256 text CONSTRAINT rag_term_layers_sha_check CHECK (entries_sha256 IS NULL OR entries_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.rag_term_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_key text NOT NULL
    CONSTRAINT rag_term_entries_layer_key_check
    CHECK (layer_key = 'shared' OR layer_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  canonical text NOT NULL CONSTRAINT rag_term_entries_canonical_check CHECK (char_length(canonical) BETWEEN 1 AND 64),
  variants text[] NOT NULL DEFAULT '{}'::text[],
  normalized_variants text[] NOT NULL DEFAULT '{}'::text[],
  language text NOT NULL
    CONSTRAINT rag_term_entries_language_check CHECK (language = 'any' OR language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  kind text NOT NULL
    CONSTRAINT rag_term_entries_kind_check
    CHECK (kind IN ('synonym', 'abbreviation', 'alias', 'identifier', 'translation', 'misspelling')),
  source_language text CONSTRAINT rag_term_entries_source_language_check CHECK (source_language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  target_language text CONSTRAINT rag_term_entries_target_language_check CHECK (target_language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
  mode text NOT NULL DEFAULT 'one_way' CONSTRAINT rag_term_entries_mode_check CHECK (mode IN ('one_way', 'equivalent')),
  enabled boolean NOT NULL DEFAULT true,
  note text CONSTRAINT rag_term_entries_note_check CHECK (note IS NULL OR char_length(note) <= 500),
  suppresses_entry_id uuid REFERENCES public.rag_term_entries (id) ON DELETE CASCADE,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A suppression row lives on a tenant layer and has no variants; every other row has 1 to 16 non-empty variants.
  CONSTRAINT rag_term_entries_suppression_check CHECK (
    suppresses_entry_id IS NULL OR (layer_key <> 'shared' AND cardinality(variants) = 0 AND cardinality(normalized_variants) = 0)
  ),
  CONSTRAINT rag_term_entries_variants_check CHECK (
    suppresses_entry_id IS NOT NULL OR (cardinality(variants) BETWEEN 1 AND 16 AND array_position(variants, NULL) IS NULL AND NOT ('' = ANY (variants)))
  ),
  CONSTRAINT rag_term_entries_normalized_variants_check CHECK (
    array_position(normalized_variants, NULL) IS NULL AND NOT ('' = ANY (normalized_variants))
  ),
  -- Translation pair (D-04, D-32): both languages set exactly for kind translation; they differ, neither is any, the entry language is the
  -- source language and the mode is one_way.
  CONSTRAINT rag_term_entries_translation_check CHECK (
    (kind <> 'translation' AND source_language IS NULL AND target_language IS NULL)
    OR (
      kind = 'translation'
      AND source_language IS NOT NULL
      AND target_language IS NOT NULL
      AND source_language <> 'any'
      AND target_language <> 'any'
      AND source_language <> target_language
      AND language = source_language
      AND mode = 'one_way'
    )
  )
);

-- One non-suppression entry per layer, language, target language and canonical; one suppression per tenant layer and suppressed entry.
CREATE UNIQUE INDEX IF NOT EXISTS rag_term_entries_canonical_key
  ON public.rag_term_entries (layer_key, language, (COALESCE(target_language, '')), lower(canonical))
  WHERE suppresses_entry_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rag_term_entries_suppression_key
  ON public.rag_term_entries (layer_key, suppresses_entry_id)
  WHERE suppresses_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rag_term_entries_layer_idx ON public.rag_term_entries (layer_key);
CREATE INDEX IF NOT EXISTS rag_term_entries_normalized_variants_idx ON public.rag_term_entries USING gin (normalized_variants);

CREATE TABLE IF NOT EXISTS public.rag_term_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_key text NOT NULL
    CONSTRAINT rag_term_audit_layer_key_check
    CHECK (layer_key = 'shared' OR layer_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  entry_id uuid,
  action text NOT NULL
    CONSTRAINT rag_term_audit_action_check
    CHECK (action IN ('create', 'update', 'delete', 'import', 'suppress', 'unsuppress', 'candidate_accept', 'candidate_dismiss')),
  actor uuid NOT NULL,
  before jsonb,
  after jsonb,
  layer_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_term_audit_layer_time_idx ON public.rag_term_audit (layer_key, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_term_audit_entry_idx ON public.rag_term_audit (entry_id);

ALTER TABLE public.rag_term_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_term_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_term_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rag_term_layers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.rag_term_entries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.rag_term_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.rag_term_layers TO service_role;
GRANT SELECT ON public.rag_term_entries TO service_role;
GRANT SELECT ON public.rag_term_audit TO service_role;

CREATE OR REPLACE FUNCTION public.rag_term_audit_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  RAISE EXCEPTION 'rag_term_audit is append-only';
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_term_audit_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_term_audit_immutable ON public.rag_term_audit;
CREATE TRIGGER rag_term_audit_immutable
  BEFORE UPDATE OR DELETE ON public.rag_term_audit
  FOR EACH ROW EXECUTE FUNCTION public.rag_term_audit_immutable();

DROP TRIGGER IF EXISTS rag_term_audit_no_truncate ON public.rag_term_audit;
CREATE TRIGGER rag_term_audit_no_truncate
  BEFORE TRUNCATE ON public.rag_term_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_term_audit_immutable();

DROP FUNCTION IF EXISTS public.rag_term_effective(text);

CREATE FUNCTION public.rag_term_effective(p_tenant_key text)
RETURNS TABLE (
  entry_id uuid,
  layer text,
  canonical text,
  variants text[],
  normalized_variants text[],
  language text,
  kind text,
  mode text,
  source_language text,
  target_language text,
  shared_version bigint,
  tenant_version bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_shared bigint;
  v_tenant bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  SELECT l.version INTO v_shared FROM public.rag_term_layers l WHERE l.layer_key = 'shared';
  SELECT l.version INTO v_tenant FROM public.rag_term_layers l WHERE l.layer_key = p_tenant_key;

  RETURN QUERY
  SELECT e.id,
         CASE WHEN e.layer_key = 'shared' THEN 'shared' ELSE 'workspace' END,
         e.canonical,
         e.variants,
         e.normalized_variants,
         e.language,
         e.kind,
         e.mode,
         e.source_language,
         e.target_language,
         COALESCE(v_shared, 0::bigint),
         COALESCE(v_tenant, 0::bigint)
    FROM public.rag_term_entries e
   WHERE e.enabled
     AND e.suppresses_entry_id IS NULL
     AND (
       e.layer_key = p_tenant_key
       OR (
         e.layer_key = 'shared'
         AND NOT EXISTS (
           SELECT 1
             FROM public.rag_term_entries s
            WHERE s.layer_key = p_tenant_key
              AND s.suppresses_entry_id = e.id
              AND s.enabled
         )
       )
     )
   ORDER BY (e.layer_key = 'shared') DESC, e.language, pg_catalog.lower(e.canonical), e.target_language NULLS FIRST, e.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_term_effective(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_term_effective(text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

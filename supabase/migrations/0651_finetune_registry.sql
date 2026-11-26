-- 0651: fine-tune consent and model registry (Phase 6.1, FT-01, FT-10, D-27..D-30, D-32).
-- rag_finetune_consent holds one row per tenant that opted in; no row means scope none. private: the tenant's data may train a model that
-- serves only that tenant; deployment: it may also train a model shared across the deployment. A grant needs an evidence reference (a ticket
-- or agreement id, never contact data) and an actor. embedding_model_versions is the registry of fine-tuned model cards: ids, hashes, prompts,
-- probe vectors and offline metrics as numbers, never chunk or query text. Setting a tenant's consent to a scope that no longer covers a
-- version trained on it marks that version tainted in the same transaction (D-29); 0652 reacts to the taint on the slot side.
-- Every object is service_role only: RLS on without policies, nothing granted to anon or authenticated, every function SECURITY DEFINER with
-- an empty search_path and schema-qualified names. Tenant keys are checked by public.rag_assert_tenant_key, so a key of the other deployment
-- mode is refused. Idempotent.

BEGIN;

DO $finetune_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL THEN
    RAISE EXCEPTION '0651: apply 0403 first, public.rag_assert_tenant_key(text) is missing' USING ERRCODE = '55000';
  END IF;
END
$finetune_precheck$;

CREATE TABLE IF NOT EXISTS public.rag_finetune_consent (
  tenant_key text PRIMARY KEY
    CONSTRAINT rag_finetune_consent_tenant_key_shape
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  scope text NOT NULL CONSTRAINT rag_finetune_consent_scope_check CHECK (scope IN ('none', 'private', 'deployment')),
  evidence_ref text CONSTRAINT rag_finetune_consent_evidence_shape
    CHECK (evidence_ref IS NULL OR (pg_catalog.length(evidence_ref) BETWEEN 1 AND 200 AND evidence_ref !~ '[@[:cntrl:]]')),
  granted_by text,
  granted_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_finetune_consent_grant_complete CHECK (
    scope = 'none'
    OR (COALESCE(pg_catalog.btrim(evidence_ref), '') <> '' AND COALESCE(pg_catalog.btrim(granted_by), '') <> ''
        AND granted_at IS NOT NULL AND revoked_at IS NULL)
  )
);

ALTER TABLE public.rag_finetune_consent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_finetune_consent FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_finetune_consent TO service_role;

CREATE TABLE IF NOT EXISTS public.embedding_model_versions (
  id text PRIMARY KEY CONSTRAINT embedding_model_versions_id_shape CHECK (id ~ '^ft-[a-z0-9][a-z0-9.-]{2,58}$'),
  base_model text NOT NULL CONSTRAINT embedding_model_versions_base_model_check CHECK (pg_catalog.btrim(base_model) <> ''),
  base_revision text NOT NULL CONSTRAINT embedding_model_versions_base_revision_shape CHECK (base_revision ~ '^[0-9a-f]{40}$'),
  scope text NOT NULL CONSTRAINT embedding_model_versions_scope_check CHECK (scope IN ('deployment', 'tenant')),
  tenant_keys text[] NOT NULL,
  dataset_manifest_sha256 text NOT NULL CONSTRAINT embedding_model_versions_manifest_shape CHECK (dataset_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  training_config_sha256 text NOT NULL CONSTRAINT embedding_model_versions_config_shape CHECK (training_config_sha256 ~ '^[0-9a-f]{64}$'),
  offline_metrics jsonb NOT NULL,
  probe jsonb NOT NULL,
  query_prompt text NOT NULL,
  document_prompt text NOT NULL,
  dims integer NOT NULL CONSTRAINT embedding_model_versions_dims_check CHECK (dims = 1024),
  artifact_uri text NOT NULL CONSTRAINT embedding_model_versions_artifact_uri_shape
    CHECK (artifact_uri ~ '^[a-z][a-z0-9+.-]*://[^@?#[:space:][:cntrl:]]+$'),
  status text NOT NULL DEFAULT 'registered'
    CONSTRAINT embedding_model_versions_status_check CHECK (status IN ('registered', 'bound', 'retired', 'tainted')),
  bound_slot text,
  tainted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT embedding_model_versions_tenant_keys_shape CHECK (
    pg_catalog.cardinality(tenant_keys) >= 1
    AND pg_catalog.array_to_string(tenant_keys, ',', '?') ~
      '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(,(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))*$'
  ),
  CONSTRAINT embedding_model_versions_tenant_scope_single CHECK (scope <> 'tenant' OR pg_catalog.cardinality(tenant_keys) = 1),
  CONSTRAINT embedding_model_versions_bound_slot CHECK (status <> 'bound' OR bound_slot IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS embedding_model_versions_tenant_keys_idx ON public.embedding_model_versions USING gin (tenant_keys);

ALTER TABLE public.embedding_model_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.embedding_model_versions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.embedding_model_versions TO service_role;

-- Records a tenant's consent. private and deployment need an evidence reference and an actor; none needs an actor and sets revoked_at.
-- Every version whose tenant_keys contain the tenant and that the new scope no longer covers becomes tainted in the same transaction (D-29):
-- none taints all of them, private taints the deployment-scope ones. Returns the ids tainted by this call.
CREATE OR REPLACE FUNCTION public.rag_finetune_set_consent(p_tenant_key text, p_scope text, p_evidence_ref text, p_actor text)
RETURNS TABLE (tenant_key text, scope text, tainted_versions text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_tainted text[] := ARRAY[]::text[];
BEGIN
  BEGIN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION 'tenant_key_invalid: %', SQLERRM USING ERRCODE = '22023';
  END;
  IF p_scope IS NULL OR p_scope NOT IN ('none', 'private', 'deployment') THEN
    RAISE EXCEPTION 'consent_refused: scope must be none, private or deployment' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'consent_refused: actor_required' USING ERRCODE = '22023';
  END IF;

  IF p_scope = 'none' THEN
    INSERT INTO public.rag_finetune_consent AS c (tenant_key, scope, revoked_at, revoked_by, updated_at)
    VALUES (p_tenant_key, 'none', pg_catalog.now(), p_actor, pg_catalog.now())
    ON CONFLICT ON CONSTRAINT rag_finetune_consent_pkey DO UPDATE
      SET scope = 'none', revoked_at = pg_catalog.now(), revoked_by = p_actor, updated_at = pg_catalog.now();
  ELSE
    IF p_evidence_ref IS NULL OR pg_catalog.btrim(p_evidence_ref) = '' THEN
      RAISE EXCEPTION 'consent_refused: evidence_required' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.length(p_evidence_ref) > 200 OR p_evidence_ref ~ '[@[:cntrl:]]' THEN
      RAISE EXCEPTION 'consent_refused: evidence_ref_invalid (a ticket or agreement reference of at most 200 characters, no contact data)'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.rag_finetune_consent AS c (tenant_key, scope, evidence_ref, granted_by, granted_at, revoked_at, revoked_by, updated_at)
    VALUES (p_tenant_key, p_scope, p_evidence_ref, p_actor, pg_catalog.now(), NULL, NULL, pg_catalog.now())
    ON CONFLICT ON CONSTRAINT rag_finetune_consent_pkey DO UPDATE
      SET scope = EXCLUDED.scope, evidence_ref = EXCLUDED.evidence_ref, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at,
          revoked_at = NULL, revoked_by = NULL, updated_at = pg_catalog.now();
  END IF;

  RETURN QUERY SELECT p_tenant_key, p_scope, v_tainted;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_set_consent(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_set_consent(text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_finetune_list_consent()
RETURNS TABLE (
  tenant_key text,
  scope text,
  evidence_ref text,
  granted_by text,
  granted_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT c.tenant_key, c.scope, c.evidence_ref, c.granted_by, c.granted_at, c.revoked_at, c.revoked_by, c.updated_at
  FROM public.rag_finetune_consent AS c
  ORDER BY c.tenant_key
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_list_consent() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_list_consent() TO service_role;

-- Returns p_tenant_keys when every key's consent covers p_purpose, else raises consent_refused naming the first key that is not covered (D-27).
-- private: exactly one key whose scope is private or deployment; deployment: every key has scope deployment. The consent rows are locked
-- FOR SHARE, so a concurrent revocation waits until the caller's transaction ends.
CREATE OR REPLACE FUNCTION public.rag_finetune_consent_for_export(p_tenant_keys text[], p_purpose text)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_key text;
  v_scope text;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('private', 'deployment') THEN
    RAISE EXCEPTION 'consent_refused: purpose must be private or deployment' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_keys IS NULL OR pg_catalog.cardinality(p_tenant_keys) = 0 THEN
    RAISE EXCEPTION 'consent_refused: tenant_keys_empty' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY p_tenant_keys LOOP
    BEGIN
      PERFORM public.rag_assert_tenant_key(v_key);
    EXCEPTION WHEN invalid_parameter_value THEN
      RAISE EXCEPTION 'tenant_key_invalid: %', SQLERRM USING ERRCODE = '22023';
    END;
  END LOOP;
  IF (SELECT pg_catalog.count(DISTINCT k) FROM pg_catalog.unnest(p_tenant_keys) AS u(k)) <> pg_catalog.cardinality(p_tenant_keys) THEN
    RAISE EXCEPTION 'consent_refused: tenant_keys_duplicate' USING ERRCODE = '22023';
  END IF;
  IF p_purpose = 'private' AND pg_catalog.cardinality(p_tenant_keys) <> 1 THEN
    RAISE EXCEPTION 'consent_refused: private_takes_one_tenant' USING ERRCODE = '22023';
  END IF;

  FOREACH v_key IN ARRAY p_tenant_keys LOOP
    SELECT c.scope INTO v_scope FROM public.rag_finetune_consent AS c WHERE c.tenant_key = v_key FOR SHARE;
    IF NOT FOUND OR v_scope = 'none' OR (p_purpose = 'deployment' AND v_scope <> 'deployment') THEN
      RAISE EXCEPTION 'consent_refused: consent of % does not cover %', v_key, p_purpose USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN p_tenant_keys;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_consent_for_export(text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_consent_for_export(text[], text) TO service_role;

COMMIT;

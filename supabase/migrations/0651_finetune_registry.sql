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

  WITH tainted AS (
    UPDATE public.embedding_model_versions AS v
    SET status = 'tainted', tainted_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE p_tenant_key = ANY (v.tenant_keys)
      AND v.status <> 'tainted'
      AND (p_scope = 'none' OR (p_scope = 'private' AND v.scope = 'deployment'))
    RETURNING v.id
  )
  SELECT COALESCE(pg_catalog.array_agg(t.id ORDER BY t.id), ARRAY[]::text[]) INTO v_tainted FROM tainted AS t;

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

-- Registers a model version card (D-30). Refuses a card that is not a candidate (rejected_offline: offline_gate), whose dims is not 1024,
-- whose id exists, whose artifact_uri carries userinfo, a query string or a fragment, whose offline report holds text, whose probe is not
-- three unit vectors of 1024 numbers computed with the card's prompts, or whose tenants' consent does not cover the card scope
-- (tenant: exactly one tenant with private or deployment; deployment: every tenant with deployment). The consent rows are locked FOR SHARE.
CREATE OR REPLACE FUNCTION public.rag_finetune_register_model(p_card jsonb, p_actor text)
RETURNS TABLE (version_id text, version_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_id text;
  v_scope text;
  v_keys text[];
  v_key text;
  v_consent text;
  v_probe jsonb;
  v_offline jsonb;
  v_vector jsonb;
  v_norm double precision;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'register_refused: actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_card IS NULL OR pg_catalog.jsonb_typeof(p_card) <> 'object' THEN
    RAISE EXCEPTION 'register_refused: card must be a json object' USING ERRCODE = '22023';
  END IF;

  v_id := CASE WHEN pg_catalog.jsonb_typeof(p_card -> 'id') = 'string' THEN p_card ->> 'id' END;
  IF v_id IS NULL OR v_id !~ '^ft-[a-z0-9][a-z0-9.-]{2,58}$' THEN
    RAISE EXCEPTION 'register_refused: id must match ^ft-[a-z0-9][a-z0-9.-]{2,58}$' USING ERRCODE = '22023';
  END IF;
  IF p_card -> 'status' = '"rejected_offline"'::jsonb THEN
    RAISE EXCEPTION 'register_refused: offline_gate (the card failed the offline evaluation)' USING ERRCODE = '22023';
  END IF;
  IF p_card -> 'status' IS DISTINCT FROM '"candidate"'::jsonb THEN
    RAISE EXCEPTION 'register_refused: status must be candidate' USING ERRCODE = '22023';
  END IF;
  IF p_card -> 'dims' IS DISTINCT FROM '1024'::jsonb THEN
    RAISE EXCEPTION 'register_refused: dims must be 1024' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(p_card -> 'artifact_uri') IS DISTINCT FROM 'string'
     OR pg_catalog.length(p_card ->> 'artifact_uri') > 2048
     OR (p_card ->> 'artifact_uri') !~ '^[a-z][a-z0-9+.-]*://[^@?#[:space:][:cntrl:]]+$' THEN
    RAISE EXCEPTION 'register_refused: artifact_uri must be scheme://location without userinfo, query string or fragment' USING ERRCODE = '22023';
  END IF;

  v_scope := CASE WHEN pg_catalog.jsonb_typeof(p_card -> 'scope') = 'string' THEN p_card ->> 'scope' END;
  IF v_scope IS NULL OR v_scope NOT IN ('deployment', 'tenant') THEN
    RAISE EXCEPTION 'register_refused: scope must be deployment or tenant' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(p_card -> 'tenant_keys') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_card -> 'tenant_keys') = 0
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_card -> 'tenant_keys') AS e(k) WHERE pg_catalog.jsonb_typeof(e.k) <> 'string') THEN
    RAISE EXCEPTION 'register_refused: tenant_keys must be a non-empty array of tenant keys' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT e.k ORDER BY e.k) INTO v_keys FROM pg_catalog.jsonb_array_elements_text(p_card -> 'tenant_keys') AS e(k);
  IF pg_catalog.cardinality(v_keys) <> pg_catalog.jsonb_array_length(p_card -> 'tenant_keys') THEN
    RAISE EXCEPTION 'register_refused: tenant_keys must not repeat a key' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    BEGIN
      PERFORM public.rag_assert_tenant_key(v_key);
    EXCEPTION WHEN invalid_parameter_value THEN
      RAISE EXCEPTION 'register_refused: tenant_keys hold a key this deployment cannot use (%)', SQLERRM USING ERRCODE = '22023';
    END;
  END LOOP;
  IF v_scope = 'tenant' AND pg_catalog.cardinality(v_keys) <> 1 THEN
    RAISE EXCEPTION 'register_refused: tenant_scope_single (a tenant-scope card names exactly one tenant)' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_typeof(p_card -> 'base_model') IS DISTINCT FROM 'string'
     OR pg_catalog.btrim(p_card ->> 'base_model') = '' OR pg_catalog.length(p_card ->> 'base_model') > 200 THEN
    RAISE EXCEPTION 'register_refused: base_model must be a non-empty model name' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(p_card -> 'base_revision') IS DISTINCT FROM 'string' OR (p_card ->> 'base_revision') !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'register_refused: base_revision must be a 40-character hex revision' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(p_card -> 'dataset_manifest_sha256') IS DISTINCT FROM 'string'
     OR (p_card ->> 'dataset_manifest_sha256') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(p_card -> 'training_config_sha256') IS DISTINCT FROM 'string'
     OR (p_card ->> 'training_config_sha256') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'register_refused: hashes must be 64-character hex sha256 values' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(p_card -> 'query_prompt') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(p_card -> 'document_prompt') IS DISTINCT FROM 'string'
     OR pg_catalog.length(p_card ->> 'query_prompt') > 2000 OR pg_catalog.length(p_card ->> 'document_prompt') > 2000 THEN
    RAISE EXCEPTION 'register_refused: prompts must be strings of at most 2000 characters' USING ERRCODE = '22023';
  END IF;

  v_offline := p_card -> 'offline';
  IF pg_catalog.jsonb_typeof(v_offline) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_path_exists(v_offline - 'reasons', 'lax $.** ? (@.type() == "string")')
     OR (v_offline ? 'reasons' AND (
       pg_catalog.jsonb_typeof(v_offline -> 'reasons') <> 'array'
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_offline -> 'reasons') AS r(x)
         WHERE pg_catalog.jsonb_typeof(r.x) <> 'string' OR (r.x #>> '{}') !~ '^[a-z][a-z0-9_]{0,63}$'
       )
     )) THEN
    RAISE EXCEPTION 'register_refused: offline must be a report of numbers (reasons as enum codes only)' USING ERRCODE = '22023';
  END IF;

  v_probe := p_card -> 'probe';
  IF pg_catalog.jsonb_typeof(v_probe) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_probe -> 'texts') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_probe -> 'vectors') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'register_refused: probe must hold texts and vectors' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(v_probe -> 'texts') <> 3 OR pg_catalog.jsonb_array_length(v_probe -> 'vectors') <> 3
     OR EXISTS (
       SELECT 1 FROM pg_catalog.jsonb_array_elements(v_probe -> 'texts') AS t(x)
       WHERE pg_catalog.jsonb_typeof(t.x) <> 'string' OR pg_catalog.btrim(t.x #>> '{}') = ''
     )
     OR v_probe -> 'query_prompt' IS DISTINCT FROM p_card -> 'query_prompt'
     OR v_probe -> 'document_prompt' IS DISTINCT FROM p_card -> 'document_prompt' THEN
    RAISE EXCEPTION 'register_refused: probe must hold three texts and the card''s prompts' USING ERRCODE = '22023';
  END IF;
  FOR v_vector IN SELECT e.v FROM pg_catalog.jsonb_array_elements(v_probe -> 'vectors') AS e(v) LOOP
    IF pg_catalog.jsonb_typeof(v_vector) <> 'array' OR pg_catalog.jsonb_array_length(v_vector) <> 1024
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_vector) AS x(n) WHERE pg_catalog.jsonb_typeof(x.n) <> 'number') THEN
      RAISE EXCEPTION 'register_refused: probe vectors must be three arrays of 1024 numbers' USING ERRCODE = '22023';
    END IF;
    SELECT pg_catalog.sqrt(pg_catalog.sum((x.n)::double precision * (x.n)::double precision)) INTO v_norm
    FROM pg_catalog.jsonb_array_elements(v_vector) AS x(n);
    IF pg_catalog.abs(v_norm - 1) > 1e-3 THEN
      RAISE EXCEPTION 'register_refused: probe vectors must have unit length' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.embedding_model_versions AS m WHERE m.id = v_id) THEN
    RAISE EXCEPTION 'register_refused: duplicate (version % exists)', v_id USING ERRCODE = '23505';
  END IF;

  FOREACH v_key IN ARRAY v_keys LOOP
    SELECT c.scope INTO v_consent FROM public.rag_finetune_consent AS c WHERE c.tenant_key = v_key FOR SHARE;
    IF NOT FOUND OR v_consent = 'none' OR (v_scope = 'deployment' AND v_consent <> 'deployment') THEN
      RAISE EXCEPTION 'register_refused: consent of % does not cover a % scope model', v_key, v_scope USING ERRCODE = '42501';
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO public.embedding_model_versions (
      id, base_model, base_revision, scope, tenant_keys, dataset_manifest_sha256, training_config_sha256, offline_metrics, probe,
      query_prompt, document_prompt, dims, artifact_uri, status, created_by
    )
    VALUES (
      v_id, p_card ->> 'base_model', p_card ->> 'base_revision', v_scope, v_keys, p_card ->> 'dataset_manifest_sha256',
      p_card ->> 'training_config_sha256', v_offline,
      pg_catalog.jsonb_build_object(
        'texts', v_probe -> 'texts', 'vectors', v_probe -> 'vectors',
        'query_prompt', v_probe -> 'query_prompt', 'document_prompt', v_probe -> 'document_prompt'
      ),
      p_card ->> 'query_prompt', p_card ->> 'document_prompt', 1024, p_card ->> 'artifact_uri', 'registered', p_actor
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'register_refused: duplicate (version % exists)', v_id USING ERRCODE = '23505';
  END;

  RETURN QUERY SELECT v_id, 'registered'::text;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_register_model(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_register_model(jsonb, text) TO service_role;

-- Lists the registry. Probe vectors are large, so they are returned only with p_include_probe.
CREATE OR REPLACE FUNCTION public.rag_finetune_list_models(p_include_probe boolean DEFAULT false)
RETURNS TABLE (
  id text,
  base_model text,
  base_revision text,
  scope text,
  tenant_keys text[],
  dataset_manifest_sha256 text,
  training_config_sha256 text,
  offline_metrics jsonb,
  query_prompt text,
  document_prompt text,
  dims integer,
  artifact_uri text,
  status text,
  bound_slot text,
  tainted_at timestamptz,
  created_at timestamptz,
  created_by text,
  updated_at timestamptz,
  probe jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT m.id, m.base_model, m.base_revision, m.scope, m.tenant_keys, m.dataset_manifest_sha256, m.training_config_sha256,
         m.offline_metrics, m.query_prompt, m.document_prompt, m.dims, m.artifact_uri, m.status, m.bound_slot, m.tainted_at,
         m.created_at, m.created_by, m.updated_at,
         CASE WHEN COALESCE(p_include_probe, false) THEN m.probe END
  FROM public.embedding_model_versions AS m
  ORDER BY m.created_at, m.id
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_list_models(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_list_models(boolean) TO service_role;

-- Operator status changes (D-30): registered to retired, and any status to tainted. Taint is final. bound and its reverse belong to the
-- slot functions of 0652.
CREATE OR REPLACE FUNCTION public.rag_finetune_set_model_status(p_version_id text, p_status text, p_actor text)
RETURNS TABLE (version_id text, version_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_current text;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'status_refused: actor is required' USING ERRCODE = '22023';
  END IF;
  SELECT m.status INTO v_current FROM public.embedding_model_versions AS m WHERE m.id = p_version_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'status_refused: not_found (%)', p_version_id USING ERRCODE = 'P0002';
  END IF;
  IF v_current = 'tainted' THEN
    IF p_status = 'tainted' THEN
      RETURN QUERY SELECT p_version_id, v_current;
      RETURN;
    END IF;
    RAISE EXCEPTION 'status_refused: tainted_final (a tainted version never changes status)' USING ERRCODE = '22023';
  END IF;

  IF p_status = 'tainted' THEN
    UPDATE public.embedding_model_versions AS m
    SET status = 'tainted', tainted_at = pg_catalog.now(), updated_at = pg_catalog.now()
    WHERE m.id = p_version_id;
  ELSIF p_status = 'retired' AND v_current = 'registered' THEN
    UPDATE public.embedding_model_versions AS m
    SET status = 'retired', updated_at = pg_catalog.now()
    WHERE m.id = p_version_id;
  ELSE
    RAISE EXCEPTION 'status_refused: transition % to % is not allowed', v_current, COALESCE(p_status, 'null') USING ERRCODE = '22023';
  END IF;

  RETURN QUERY SELECT p_version_id, p_status;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_finetune_set_model_status(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_finetune_set_model_status(text, text, text) TO service_role;

COMMIT;

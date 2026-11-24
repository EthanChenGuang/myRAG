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
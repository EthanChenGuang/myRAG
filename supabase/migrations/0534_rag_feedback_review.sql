-- 0534: tenant feedback settings, domain-expert grants and the review queue (Phase 5.1.1, FBK-02, FBK-05, FBK-06, D-06, D-14, D-16).
-- rag_tenant_feedback_settings: a tenant may only lower the global retrieval-log level (inherit, off, ids). Service role only.
-- rag_domain_experts: explicit (tenant_key, user_id) grants made by operator admins. Service role only.
-- rag_review_items: one row per mined case with a snapshot that survives the log purge (query, language codes D-03a, candidates ids
-- and scores, reasons). tags (D-29) is a seam for Phase 5.3; this phase writes none and experts cannot write it.
-- Access: authenticated may SELECT items and UPDATE status, triage, label and labelled_at only where public.rag_is_domain_expert(tenant_key)
-- is true. Single-tenant (no public.organizations table): admin_users are experts of s:default without a grant row. Multi-tenant: every
-- expert needs an explicit grant, operator admins included. The guard trigger sets labelled_by for client callers, limits their status to
-- labelled or skipped, keeps exported items closed to them and freezes split and split_group once either is set, for every caller.
-- chat_id has no foreign key; rag_feedback_loop_on_chat_delete() (0531) is extended here to delete the items of a deleted chat. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_tenant_feedback_settings (
  tenant_key text PRIMARY KEY CONSTRAINT rag_tenant_feedback_settings_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  retrieval_log text NOT NULL DEFAULT 'inherit' CONSTRAINT rag_tenant_feedback_settings_retrieval_log_check
    CHECK (retrieval_log IN ('inherit', 'off', 'ids')),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rag_domain_experts (
  tenant_key text NOT NULL CONSTRAINT rag_domain_experts_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_domain_experts_pkey PRIMARY KEY (tenant_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_domain_experts_user ON public.rag_domain_experts (user_id);

CREATE TABLE IF NOT EXISTS public.rag_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL CONSTRAINT rag_review_items_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  retrieval_log_id uuid NULL REFERENCES public.rag_retrieval_log(id) ON DELETE SET NULL,
  trace_id text NULL,
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id uuid NULL,
  query_masked text NOT NULL CONSTRAINT rag_review_items_query_masked_check CHECK (char_length(query_masked) <= 2000),
  query_fingerprint text NULL CONSTRAINT rag_review_items_query_fingerprint_check CHECK (query_fingerprint ~ '^[0-9a-f]{64}$'),
  query_language text NULL CONSTRAINT rag_review_items_query_language_check
    CHECK (query_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  query_language_confidence real NULL CONSTRAINT rag_review_items_query_language_confidence_check
    CHECK (query_language_confidence BETWEEN 0 AND 1),
  answer_language text NULL CONSTRAINT rag_review_items_answer_language_check
    CHECK (answer_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  chunk_languages text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT rag_review_items_chunk_languages_check
    CHECK (
      cardinality(chunk_languages) = 0
      OR (
        array_ndims(chunk_languages) = 1
        AND array_position(chunk_languages, NULL) IS NULL
        AND array_to_string(chunk_languages, ',') ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?(,[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)*$'
        AND array_to_string(chunk_languages, ';') ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?(;[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)*$'
      )
    ),
  channel text NULL CONSTRAINT rag_review_items_channel_check CHECK (channel IN ('chat', 'embed', 'voice')),
  outcome text NULL CONSTRAINT rag_review_items_outcome_check
    CHECK (outcome IN ('answered', 'refused_no_context', 'kb_unavailable', 'degraded_answer', 'unknown')),
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT rag_review_items_candidates_check
    CHECK (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 50),
  retrieval_config_hash text NULL,
  reasons text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT rag_review_items_reasons_check
    CHECK (reasons <@ ARRAY['feedback_negative', 'refusal_disputed', 'groundedness_flagged', 'refused_high_score', 'zero_results',
                            'low_score', 'no_source_opened']::text[]),
  occurrences integer NOT NULL DEFAULT 1 CONSTRAINT rag_review_items_occurrences_check CHECK (occurrences >= 1),
  tags text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT rag_review_items_tags_check
    CHECK (
      cardinality(tags) = 0
      OR (
        array_ndims(tags) = 1
        AND array_position(tags, NULL) IS NULL
        AND array_to_string(tags, ',') ~ '^[a-z_]{1,32}(,[a-z_]{1,32})*$'
        AND array_to_string(tags, ';') ~ '^[a-z_]{1,32}(;[a-z_]{1,32})*$'
      )
    ),
  status text NOT NULL DEFAULT 'open' CONSTRAINT rag_review_items_status_check
    CHECK (status IN ('open', 'labelled', 'skipped', 'exported')),
  triage text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT rag_review_items_triage_check
    CHECK (triage <@ ARRAY['dictionary', 'training', 'golden', 'kb_gap', 'not_a_failure']::text[]),
  label jsonb NULL CONSTRAINT rag_review_items_label_check CHECK (jsonb_typeof(label) = 'object'),
  labelled_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  labelled_at timestamptz NULL,
  split text NULL CONSTRAINT rag_review_items_split_check CHECK (split IN ('dev', 'test')),
  split_group text NULL,
  mining_window timestamptz NULL,
  mined_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  CONSTRAINT rag_review_items_tenant_fingerprint_window_key UNIQUE (tenant_key, query_fingerprint, mining_window)
);

CREATE INDEX IF NOT EXISTS idx_rag_review_items_tenant_status ON public.rag_review_items (tenant_key, status, mined_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_review_items_chat_id ON public.rag_review_items (chat_id);
CREATE INDEX IF NOT EXISTS idx_rag_review_items_user_id ON public.rag_review_items (user_id);
CREATE INDEX IF NOT EXISTS idx_rag_review_items_retrieval_log_id ON public.rag_review_items (retrieval_log_id);
CREATE INDEX IF NOT EXISTS idx_rag_review_items_expires ON public.rag_review_items (expires_at) WHERE status = 'open';

ALTER TABLE public.rag_tenant_feedback_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_domain_experts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_review_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_tenant_feedback_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_tenant_feedback_settings TO service_role;
REVOKE ALL ON TABLE public.rag_domain_experts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_domain_experts TO service_role;
REVOKE ALL ON TABLE public.rag_review_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_review_items TO service_role;
GRANT SELECT ON TABLE public.rag_review_items TO authenticated;
GRANT UPDATE (status, triage, label, labelled_at) ON TABLE public.rag_review_items TO authenticated;

-- True only for the calling user: an explicit grant for the tenant, or, in a single-tenant database, an admin asking about s:default.
CREATE OR REPLACE FUNCTION public.rag_is_domain_expert(p_tenant_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT auth.uid() IS NOT NULL
    AND p_tenant_key IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.rag_domain_experts e
        WHERE e.tenant_key = p_tenant_key AND e.user_id = auth.uid()
      )
      OR (
        p_tenant_key = 's:default'
        AND pg_catalog.to_regclass('public.organizations') IS NULL
        AND EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = auth.uid())
      )
    )
$fn$;

REVOKE ALL ON FUNCTION public.rag_is_domain_expert(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rag_is_domain_expert(text) TO authenticated, service_role;

DROP POLICY IF EXISTS rag_review_items_expert_select ON public.rag_review_items;
CREATE POLICY rag_review_items_expert_select ON public.rag_review_items
  FOR SELECT TO authenticated
  USING (public.rag_is_domain_expert(tenant_key));

DROP POLICY IF EXISTS rag_review_items_expert_update ON public.rag_review_items;
CREATE POLICY rag_review_items_expert_update ON public.rag_review_items
  FOR UPDATE TO authenticated
  USING (public.rag_is_domain_expert(tenant_key))
  WITH CHECK (public.rag_is_domain_expert(tenant_key));

-- Callers that bypass RLS (service_role, the database owner) are trusted writers; every other caller is a client.
CREATE OR REPLACE FUNCTION public.rag_review_items_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_trusted boolean;
BEGIN
  IF (OLD.split IS NOT NULL OR OLD.split_group IS NOT NULL)
     AND (NEW.split IS DISTINCT FROM OLD.split OR NEW.split_group IS DISTINCT FROM OLD.split_group) THEN
    RAISE EXCEPTION 'split_immutable' USING ERRCODE = '23514', DETAIL = 'split and split_group cannot change once set';
  END IF;

  SELECT r.rolsuper OR r.rolbypassrls INTO v_trusted FROM pg_catalog.pg_roles r WHERE r.rolname = current_user;
  IF coalesce(v_trusted, false) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'exported' THEN
    RAISE EXCEPTION 'review_item_exported' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('labelled', 'skipped') THEN
    RAISE EXCEPTION 'review_status_not_allowed' USING ERRCODE = '42501', DETAIL = 'clients may set labelled or skipped only';
  END IF;
  NEW.labelled_by := auth.uid();
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_items_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_review_items_guard ON public.rag_review_items;
CREATE TRIGGER rag_review_items_guard
  BEFORE UPDATE ON public.rag_review_items
  FOR EACH ROW EXECUTE FUNCTION public.rag_review_items_guard();

CREATE OR REPLACE FUNCTION public.rag_feedback_loop_on_chat_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_retrieval_log l
  WHERE l.chat_id IN (SELECT o.id FROM old_rows o);
  DELETE FROM public.rag_review_items i
  WHERE i.chat_id IN (SELECT o.id FROM old_rows o);
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_feedback_loop_on_chat_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_feedback_loop_on_chat_delete() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

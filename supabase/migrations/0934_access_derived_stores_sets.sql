-- 0934: derived stores under document access groups, part two (Phase 4.3 plan 13; SEC-13, D-25, D-30, A-06, A-13). 0931 (plan 12) holds
-- the semantic cache part; this file holds the answer records, the retrieval log and the review queue.
-- access_sets jsonb (nullable) is a JSON array with one element per cited or retrieved document: that document's access_groups keys
-- ('all', 'u:<uuid>', 'g:<uuid>'), never group names or text. NULL means the row was written with access groups off (today's row).
-- rag_answer_records gets the column only: the owner keeps reading their delivered answers (A-13); the answer read path drops the link
-- of a citation whose document is no longer visible. rag_retrieval_log and rag_review_items (Phase 5.1.1) get the column and a
-- restrictive SELECT policy for authenticated, rag_retrieval_log_access_sets and rag_review_items_access_sets: a row with sets is
-- readable only when public.rag_caller_reads_access_sets(tenant_key, access_sets) is true. rag_retrieval_log has no client grant and no
-- policy (0531); the restrictive policy is defence in depth for a later change that opens it, and adds no grant. Both table blocks are
-- guarded by to_regclass so the file applies without the 5.1.1 tables and completes when re-run after they exist (D-30).
-- rag_caller_reads_access_sets(p_tenant_key, p_sets): true when p_sets is NULL, when the caller administers the tenant (o: owner or
-- admin of the organization, s: admin_users, u: the personal owner; the rules of rag_resolve_access_scope in 0922), or when every set
-- shares a key with the caller's keys ('all', 'u:<auth.uid()>' and 'g:<id>' of the caller's groups in that tenant). Identity comes from
-- auth.uid() only; anon (no uid) is false for any non-NULL set. A malformed set is never readable (fails closed). STABLE SECURITY
-- DEFINER (the membership tables are not client-readable), empty search_path, granted to authenticated and service_role
-- (allow-listed in tests/helpers/security-definer-allow-list.ts). Idempotent; not folded into the setup files; re-running 0501, 0531
-- or 0534 requires re-running this file.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_caller_reads_access_sets(p_tenant_key text, p_sets jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_prefix text;
  v_tenant_id uuid;
  v_keys text[];
  v_set jsonb;
BEGIN
  IF p_sets IS NULL THEN
    RETURN true;
  END IF;
  IF v_uid IS NULL OR p_tenant_key IS NULL OR pg_catalog.jsonb_typeof(p_sets) <> 'array' THEN
    RETURN false;
  END IF;
  IF p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RETURN false;
  END IF;

  v_prefix := pg_catalog.left(p_tenant_key, 2);
  IF v_prefix = 'o:' THEN
    v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
    IF EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = v_tenant_id AND m.user_id = v_uid AND m.role IN ('owner', 'admin')
    ) OR EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_tenant_id AND o.owner_id = v_uid) THEN
      RETURN true;
    END IF;
  ELSIF v_prefix = 's:' THEN
    IF EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = v_uid) THEN
      RETURN true;
    END IF;
  ELSE
    IF pg_catalog.substr(p_tenant_key, 3)::uuid = v_uid THEN
      RETURN true;
    END IF;
  END IF;

  SELECT ARRAY['all', 'u:' || v_uid::text]::text[] || COALESCE(pg_catalog.array_agg('g:' || gm.group_id::text), '{}'::text[])
    INTO v_keys
  FROM public.rag_access_group_members gm
  JOIN public.rag_access_groups g ON g.id = gm.group_id
  WHERE gm.user_id = v_uid AND g.tenant_key = p_tenant_key;

  FOR v_set IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_sets) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_set) <> 'array' THEN
      RETURN false;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)
      WHERE pg_catalog.jsonb_typeof(k.value) = 'string' AND (k.value #>> '{}') = ANY (v_keys)
    ) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) TO authenticated;

ALTER TABLE public.rag_answer_records ADD COLUMN IF NOT EXISTS access_sets jsonb;
ALTER TABLE public.rag_answer_records DROP CONSTRAINT IF EXISTS rag_answer_records_access_sets_check;
ALTER TABLE public.rag_answer_records ADD CONSTRAINT rag_answer_records_access_sets_check
  CHECK (access_sets IS NULL OR jsonb_typeof(access_sets) = 'array');

DO $retrieval_log$
BEGIN
  IF to_regclass('public.rag_retrieval_log') IS NULL THEN
    RAISE NOTICE '[RAG Access] rag_retrieval_log is absent; access_sets and rag_retrieval_log_access_sets were not created';
    RETURN;
  END IF;
  ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS access_sets jsonb;
  ALTER TABLE public.rag_retrieval_log DROP CONSTRAINT IF EXISTS rag_retrieval_log_access_sets_check;
  ALTER TABLE public.rag_retrieval_log ADD CONSTRAINT rag_retrieval_log_access_sets_check
    CHECK (access_sets IS NULL OR jsonb_typeof(access_sets) = 'array');
  DROP POLICY IF EXISTS rag_retrieval_log_access_sets ON public.rag_retrieval_log;
  CREATE POLICY rag_retrieval_log_access_sets ON public.rag_retrieval_log
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING (access_sets IS NULL OR public.rag_caller_reads_access_sets(tenant_key, access_sets));
END
$retrieval_log$;

DO $review_items$
BEGIN
  IF to_regclass('public.rag_review_items') IS NULL THEN
    RAISE NOTICE '[RAG Access] rag_review_items is absent; access_sets and rag_review_items_access_sets were not created';
    RETURN;
  END IF;
  ALTER TABLE public.rag_review_items ADD COLUMN IF NOT EXISTS access_sets jsonb;
  ALTER TABLE public.rag_review_items DROP CONSTRAINT IF EXISTS rag_review_items_access_sets_check;
  ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_access_sets_check
    CHECK (access_sets IS NULL OR jsonb_typeof(access_sets) = 'array');
  DROP POLICY IF EXISTS rag_review_items_access_sets ON public.rag_review_items;
  CREATE POLICY rag_review_items_access_sets ON public.rag_review_items
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING (access_sets IS NULL OR public.rag_caller_reads_access_sets(tenant_key, access_sets));
END
$review_items$;

NOTIFY pgrst, 'reload schema';

COMMIT;

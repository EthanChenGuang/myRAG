-- 0990: review-queue hardening after the Phase 5.1.1 verification (quick task review-items-hardening; G5, G6, G8, G9).
-- G5 (privacy): rag_review_items_fill_owner(), a BEFORE INSERT trigger on rag_review_items, copies user_id and chat_id from the item's
-- retrieval log row of the same tenant when the writer left them NULL. The sampled writer rag_review_items_enqueue (0967, 0988) wrote
-- retrieval_log_id only, and that key is ON DELETE SET NULL (0534), so a deleted user's or chat's sampled items kept their masked query
-- until expires_at. With the owner columns set, the user cascade (0534) and rag_feedback_loop_on_chat_delete (0534) remove them; the
-- log retention purge still leaves the item (its snapshot outlives the log). A trigger rather than a rebuilt writer body, so re-running
-- 0967 or 0988 cannot bring the gap back. Existing items are backfilled from their log rows. SECURITY INVOKER (writers run as
-- service_role or as a SECURITY DEFINER owner, both of which read the log), empty search_path, service_role only.
-- G8: rag_review_access_sets (0984) is rebuilt with one change: while public.rag_access_enforced() is true, a write with no given sets
-- and no source document returns '[]' (no restricted source: readable by every expert of the tenant) instead of NULL. The restrictive
-- policy rag_review_items_access_sets (0934) is replaced so that NULL fails closed while access is enforced: a NULL row is then readable
-- only by those who administer the tenant (rag_caller_reads_access_sets on a group key nobody holds). With access off a NULL row reads
-- as before. So items written while access was off, or by a writer restored by an out-of-order re-run, never leak once access is on;
-- the 0984 and 0988 backfills, re-run while enforced, recompute their sets.
-- G6 and G9 are covered elsewhere: 0944 and 0950 drop their four-argument rag_enqueue_review_item again when the five-argument one
-- (0984) exists, and tests/rag-db/review-items-hardening.test.mts checks that every rag_review_items writer sets access_sets.
-- One common file: nothing differs by deployment mode. Not folded into the setup files. Idempotent. Apply after 0934, 0984 and 0988;
-- re-running any of them later restores the older function or policy, so re-run this file and then 0410 after them.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_review_access_sets(p_tenant_key text, p_given jsonb, p_document_ids uuid[], p_strict boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key_re constant text := '^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
  v_unknown constant jsonb := '["g:00000000-0000-0000-0000-000000000000"]'::jsonb;
  v_sets jsonb[] := '{}'::jsonb[];
  v_set jsonb;
  v_valid boolean;
BEGIN
  IF p_given IS NOT NULL THEN
    IF pg_catalog.jsonb_typeof(p_given) <> 'array' OR pg_catalog.jsonb_array_length(p_given) > 200 THEN
      IF p_strict THEN
        RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'access sets must be an array of at most 200 key arrays';
      END IF;
      v_sets := v_sets || v_unknown;
    ELSE
      FOR v_set IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_given) AS e(value) LOOP
        v_valid := pg_catalog.jsonb_typeof(v_set) = 'array'
          AND pg_catalog.jsonb_array_length(v_set) BETWEEN 1 AND 64
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)
            WHERE pg_catalog.jsonb_typeof(k.value) <> 'string' OR (k.value #>> '{}') !~ v_key_re
          );
        IF NOT v_valid THEN
          IF p_strict THEN
            RAISE EXCEPTION 'invalid_access_sets' USING ERRCODE = '22023', DETAIL = 'each access set is 1 to 64 access keys';
          END IF;
          v_sets := v_sets || v_unknown;
        ELSE
          v_sets := v_sets || (
            SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C")
            FROM (SELECT DISTINCT k.value #>> '{}' AS key FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)) AS x
          );
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF public.rag_access_enforced() AND p_tenant_key IS NOT NULL THEN
    v_sets := v_sets || ARRAY(
      SELECT CASE WHEN pg_catalog.cardinality(d.access_groups) = 0 THEN v_unknown ELSE (
        SELECT pg_catalog.jsonb_agg(x.key ORDER BY x.key COLLATE "C") FROM (SELECT DISTINCT k AS key FROM pg_catalog.unnest(d.access_groups) AS k) AS x
      ) END
      FROM public.documents d
      WHERE d.id = ANY (coalesce(p_document_ids, '{}'::uuid[])) AND d.tenant_key = p_tenant_key
    );
  END IF;

  IF p_given IS NULL AND pg_catalog.cardinality(v_sets) = 0 THEN
    IF public.rag_access_enforced() AND p_tenant_key IS NOT NULL THEN
      RETURN '[]'::jsonb;
    END IF;
    RETURN NULL;
  END IF;
  RETURN coalesce(
    (SELECT pg_catalog.jsonb_agg(s.value ORDER BY s.value::text COLLATE "C") FROM (SELECT DISTINCT u AS value FROM pg_catalog.unnest(v_sets) AS u) AS s),
    '[]'::jsonb);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_access_sets(text, jsonb, uuid[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_review_items_fill_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid;
  v_chat uuid;
BEGIN
  IF NEW.retrieval_log_id IS NULL OR (NEW.user_id IS NOT NULL AND NEW.chat_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  SELECT l.user_id, l.chat_id INTO v_user, v_chat
  FROM public.rag_retrieval_log l
  WHERE l.id = NEW.retrieval_log_id AND l.tenant_key = NEW.tenant_key;
  NEW.user_id := coalesce(NEW.user_id, v_user);
  NEW.chat_id := coalesce(NEW.chat_id, v_chat);
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_review_items_fill_owner() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_review_items_fill_owner() TO service_role;

DO $owner$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL THEN
    RAISE NOTICE '[0990] rag_review_items or rag_retrieval_log is missing; owner trigger skipped';
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS rag_review_items_fill_owner ON public.rag_review_items;
  CREATE TRIGGER rag_review_items_fill_owner
    BEFORE INSERT ON public.rag_review_items
    FOR EACH ROW EXECUTE FUNCTION public.rag_review_items_fill_owner();

  UPDATE public.rag_review_items AS i
  SET user_id = coalesce(i.user_id, l.user_id),
      chat_id = coalesce(i.chat_id, l.chat_id)
  FROM public.rag_retrieval_log l
  WHERE l.id = i.retrieval_log_id
    AND l.tenant_key = i.tenant_key
    AND ((i.user_id IS NULL AND l.user_id IS NOT NULL) OR (i.chat_id IS NULL AND l.chat_id IS NOT NULL));
END
$owner$;

DO $policy$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.rag_review_items'::regclass AND a.attname = 'access_sets' AND NOT a.attisdropped
  ) THEN
    RAISE NOTICE '[0990] rag_review_items.access_sets is missing (apply 0934 first); policy skipped';
    RETURN;
  END IF;
  DROP POLICY IF EXISTS rag_review_items_access_sets ON public.rag_review_items;
  CREATE POLICY rag_review_items_access_sets ON public.rag_review_items
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING (
      (access_sets IS NULL AND NOT public.rag_access_enforced())
      OR public.rag_caller_reads_access_sets(tenant_key, coalesce(access_sets, '["g:00000000-0000-0000-0000-000000000000"]'::jsonb))
    );
END
$policy$;

NOTIFY pgrst, 'reload schema';

COMMIT;

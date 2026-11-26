-- 0976: rag_purge_hook_golden_items, the Phase 6.3 DATA-24 purge hook for this phase's per-document stores (Phase 5.3 plan 52,
-- EVAL-29, EVAL-24; Phase 6.3 D-14, D-17; D-48, D-55, D-56).
-- Signature reserved by Phase 6.3 (06.3-19): rag_purge_foreign_stores calls it through to_regprocedure inside the purge and counts the
-- returned number under the store golden_items. The classification of every 0960 to 0975 table is in the "DATA-24 purge hooks" section
-- of 05.3-PLAN-INDEX.md; only rag_golden_evidence_index and rag_judge_labels hold per-document data.
-- The purged versions are p_document_ids plus every version of p_lineage_id the tenant still has. For the tenant only: evidence rows
-- on those versions are deleted; each affected item keeps one tombstone (nil document id, all-zero quote hash, needs_check) and its
-- remaining rows are flagged, so rag_golden_evidence_pending returns it until the stale scan clears it. Labels of review items with a
-- kept candidate (kept true or absent) naming a purged version are deleted; that step is skipped without the Phase 5.1.1 tables.
-- SECURITY INVOKER (inside the 6.3 purge it runs with that definer's rights); empty search_path; service_role only.
-- Additive and idempotent. Not folded into the setup files (D-56).

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_golden_items(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_versions uuid[];
  v_evidence bigint := 0;
  v_labels bigint := 0;
  v_affected jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  SELECT coalesce(pg_catalog.array_agg(DISTINCT v.id), '{}'::uuid[]) INTO v_versions
  FROM (
    SELECT pg_catalog.unnest(coalesce(p_document_ids, '{}'::uuid[])) AS id
    UNION
    SELECT d.id
    FROM public.documents d
    WHERE p_lineage_id IS NOT NULL
      AND d.lineage_id = p_lineage_id
      AND d.tenant_key = p_tenant_key
  ) v
  WHERE v.id IS NOT NULL;

  IF coalesce(pg_catalog.array_length(v_versions, 1), 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH removed AS (
    DELETE FROM public.rag_golden_evidence_index i
    WHERE i.tenant_key = p_tenant_key
      AND i.document_id = ANY (v_versions)
    RETURNING i.set_id, i.item_id
  )
  SELECT pg_catalog.count(*), coalesce(pg_catalog.jsonb_agg(DISTINCT pg_catalog.jsonb_build_array(r.set_id, r.item_id)), '[]'::jsonb)
  INTO v_evidence, v_affected
  FROM removed r;

  IF v_evidence > 0 THEN
    INSERT INTO public.rag_golden_evidence_index (tenant_key, set_id, item_id, document_id, quote_sha256, needs_check)
    SELECT p_tenant_key, a ->> 0, a ->> 1, '00000000-0000-0000-0000-000000000000'::uuid, pg_catalog.repeat('0', 64), true
    FROM pg_catalog.jsonb_array_elements(v_affected) AS a
    ON CONFLICT (tenant_key, set_id, item_id, document_id, quote_sha256) DO NOTHING;

    UPDATE public.rag_golden_evidence_index i
    SET needs_check = true
    WHERE i.tenant_key = p_tenant_key
      AND NOT i.needs_check
      AND EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_affected) AS a WHERE a ->> 0 = i.set_id AND a ->> 1 = i.item_id
      );
  END IF;

  IF pg_catalog.to_regclass('public.rag_judge_labels') IS NOT NULL
     AND pg_catalog.to_regclass('public.rag_review_items') IS NOT NULL THEN
    EXECUTE $sql$
      DELETE FROM public.rag_judge_labels l
      USING public.rag_review_items r
      WHERE l.tenant_key = $1
        AND r.tenant_key = $1
        AND r.id = l.review_item_id
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(r.candidates) AS c
          WHERE pg_catalog.jsonb_typeof(c) = 'object'
            AND (c ->> 'document_id') = ANY ($2)
            AND (NOT (c ? 'kept') OR c -> 'kept' = 'true'::jsonb)
        )
    $sql$ USING p_tenant_key, (SELECT pg_catalog.array_agg(x::text) FROM pg_catalog.unnest(v_versions) AS x);
    GET DIAGNOSTICS v_labels = ROW_COUNT;
  END IF;

  RETURN v_evidence + v_labels;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_golden_items(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_golden_items(text, uuid, uuid[]) TO service_role;

-- Phase 6.3 store inventory. Guarded: this file creates no Phase 6.3 object. Phase 6.3's rag_purge_store_inventory() (0728) was not
-- on trunk when this plan ran, so the block only reports; plan 06.3-19 lists rag_golden_evidence_index and rag_judge_labels (store
-- golden_items, handling purge_step) from the "DATA-24 purge hooks" section of 05.3-PLAN-INDEX.md.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_purge_store_inventory()') IS NULL THEN
    RAISE NOTICE '[0976] rag_purge_store_inventory() is missing; registration left to Phase 6.3';
    RETURN;
  END IF;
  RAISE NOTICE '[0976] rag_purge_store_inventory() exists; it lists the golden_items stores itself';
END
$do$;

NOTIFY pgrst, 'reload schema';

COMMIT;

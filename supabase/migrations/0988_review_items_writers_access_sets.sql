-- 0988: the Phase 5.3 review-queue writers carry access_sets (Phase 4.3 follow-up to 0984; SEC-13, D-25, A-06).
-- Gap closed: rag_review_items_enqueue (0967) and rag_review_items_enqueue_re_review (0974) wrote rag_review_items.access_sets as
-- NULL, so 0934's restrictive policy rag_review_items_access_sets never hid such an item, and every expert of the tenant could read
-- its masked query even when it came from a document outside the expert's access groups.
-- Both functions keep their signatures and security attributes (SECURITY INVOKER, empty search_path, service_role only, locked again
-- in 0410); a row may now carry optional keys, which today's callers do not send:
--   access_sets   the caller's label sets (validated strictly by rag_review_access_sets: malformed raises 22023 and writes nothing);
--   document_ids  at most 50 UUIDs of source documents, each a document of p_tenant_key (otherwise 22023 document_not_in_tenant);
--   item_ids      re-review only: at most 50 golden item ids; their documents are read from rag_golden_evidence_index of the tenant.
-- rag_review_items_enqueue also derives the sources of a row's retrieval_log_id: the log row's access_sets (only while
-- public.rag_access_enforced() is true) and the documents of its candidates. Everything goes through rag_review_access_sets (0984),
-- which adds the documents' access_groups only while access is enforced. With access off and no access_sets key in a row the stored
-- value is NULL, exactly as before.
-- While access is enforced at apply time, items still without access_sets that have a retrieval log row get their sets from it.
-- Each writer is rebuilt only where its Phase 5.3 file already created it (no-op otherwise, so 0988 never owns a 5.3 function).
-- One common file: nothing differs by deployment mode. Not folded into the setup files. Idempotent. No signature changes, so no DROP.
-- Apply after 0967, 0974 and 0984; re-running 0967 or 0974 later restores the old bodies, so re-run this file after them.

BEGIN;

DO $do$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR pg_catalog.to_regclass('public.rag_review_item_strata') IS NULL THEN
    RAISE NOTICE '[0988] rag_review_items or rag_review_item_strata is missing; rag_review_items_enqueue skipped';
    RETURN;
  END IF;

  EXECUTE $sql$
    CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue(p_tenant_key text, p_source text, p_rows jsonb)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = ''
    AS $fn$
    DECLARE
      v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      v_row jsonb;
      v_id uuid;
      v_log uuid;
      v_reasons text[];
      v_count integer := 0;
      v_docs uuid[];
      v_row_docs uuid[];
      v_log_sets jsonb;
      v_sets jsonb;
      v_found integer;
    BEGIN
      PERFORM public.rag_assert_tenant_key(p_tenant_key);
      IF p_source IS NULL OR p_source NOT IN ('representative', 'pilot', 'drift_fill', 'historical') THEN
        RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023';
      END IF;
      IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
      END IF;

      FOR v_row IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value) LOOP
        IF pg_catalog.jsonb_typeof(v_row) <> 'object'
           OR coalesce(v_row ->> 'query_masked', '') = ''
           OR coalesce(v_row ->> 'query_fingerprint', '') = ''
           OR coalesce(v_row ->> 'mining_window', '') = ''
           OR coalesce(v_row ->> 'stratum', '') = ''
           OR coalesce(pg_catalog.jsonb_typeof(v_row -> 'sampling_weight'), '') <> 'number'
           OR (v_row ? 'reasons' AND pg_catalog.jsonb_typeof(v_row -> 'reasons') <> 'array') THEN
          RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
        END IF;
        IF v_row ? 'document_ids' AND pg_catalog.jsonb_typeof(v_row -> 'document_ids') <> 'null' AND (
             pg_catalog.jsonb_typeof(v_row -> 'document_ids') <> 'array'
             OR pg_catalog.jsonb_array_length(v_row -> 'document_ids') > 50
             OR EXISTS (
               SELECT 1 FROM pg_catalog.jsonb_array_elements(v_row -> 'document_ids') AS d(value)
               WHERE pg_catalog.jsonb_typeof(d.value) <> 'string' OR pg_catalog.lower(d.value #>> '{}') !~ v_uuid
             )) THEN
          RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023', DETAIL = 'document_ids must be at most 50 UUID strings';
        END IF;

        v_log := NULLIF(v_row ->> 'retrieval_log_id', '')::uuid;
        IF v_log IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.rag_retrieval_log l WHERE l.id = v_log AND l.tenant_key = p_tenant_key
        ) THEN
          RAISE EXCEPTION 'retrieval_log_not_in_tenant' USING ERRCODE = '22023';
        END IF;

        v_row_docs := ARRAY(
          SELECT DISTINCT pg_catalog.lower(d.value #>> '{}')::uuid
          FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(v_row -> 'document_ids') = 'array' THEN v_row -> 'document_ids' ELSE '[]'::jsonb END) AS d(value)
        );
        SELECT count(*) INTO v_found FROM public.documents d WHERE d.id = ANY (v_row_docs) AND d.tenant_key = p_tenant_key;
        IF v_found <> pg_catalog.cardinality(v_row_docs) THEN
          RAISE EXCEPTION 'document_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every document id must be a document of the tenant';
        END IF;

        v_docs := v_row_docs;
        v_log_sets := NULL;
        IF v_log IS NOT NULL THEN
          SELECT CASE WHEN public.rag_access_enforced() THEN l.access_sets END,
                 v_docs || ARRAY(
                   SELECT DISTINCT (c ->> 'document_id')::uuid
                   FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l.candidates) = 'array' THEN l.candidates ELSE '[]'::jsonb END) AS c
                   WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ v_uuid
                 )
            INTO v_log_sets, v_docs
          FROM public.rag_retrieval_log l
          WHERE l.id = v_log AND l.tenant_key = p_tenant_key;
        END IF;

        v_sets := public.rag_review_access_sets(p_tenant_key, NULLIF(v_row -> 'access_sets', 'null'::jsonb), v_docs, true);
        IF v_log_sets IS NOT NULL THEN
          v_sets := public.rag_review_access_sets(p_tenant_key, coalesce(v_sets, '[]'::jsonb) || v_log_sets, NULL, false);
        END IF;

        IF v_row ? 'reasons' THEN
          v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(v_row -> 'reasons'));
        ELSE
          v_reasons := ARRAY['representative']::text[];
        END IF;

        v_id := NULL;
        INSERT INTO public.rag_review_items AS i (
          tenant_key, retrieval_log_id, trace_id, query_masked, query_fingerprint, query_language, channel,
          reasons, status, mining_window, mined_at, expires_at, access_sets
        ) VALUES (
          p_tenant_key, v_log, NULLIF(v_row ->> 'trace_id', ''), v_row ->> 'query_masked', v_row ->> 'query_fingerprint',
          NULLIF(v_row ->> 'language', ''), NULLIF(v_row ->> 'channel', ''),
          v_reasons, 'open', (v_row ->> 'mining_window')::timestamptz, pg_catalog.now(), NULLIF(v_row ->> 'expires_at', '')::timestamptz,
          v_sets
        )
        ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
        RETURNING i.id INTO v_id;

        IF v_id IS NOT NULL THEN
          INSERT INTO public.rag_review_item_strata (review_item_id, tenant_key, source, stratum, sampling_weight)
          VALUES (v_id, p_tenant_key, p_source, v_row ->> 'stratum', (v_row ->> 'sampling_weight')::real);
          v_count := v_count + 1;
        END IF;
      END LOOP;

      RETURN v_count;
    END
    $fn$
  $sql$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue(text, text, jsonb) TO service_role';
END
$do$;

DO $do_re_review$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_review_items_enqueue_re_review(text, jsonb)') IS NULL THEN
    RAISE NOTICE '[0988] rag_review_items_enqueue_re_review is missing (apply 0974 first); skipped';
    RETURN;
  END IF;

  EXECUTE $create$
CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue_re_review(p_tenant_key text, p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_count integer;
  v_golden text := '';
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows_not_array' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
     WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
        OR COALESCE(e.value ->> 'query_masked', '') = ''
        OR COALESCE(e.value ->> 'query_fingerprint', '') = ''
        OR COALESCE(e.value ->> 'mining_window', '') = ''
  ) THEN
    RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
     WHERE (e.value ? 'document_ids' AND pg_catalog.jsonb_typeof(e.value -> 'document_ids') <> 'null' AND (
              pg_catalog.jsonb_typeof(e.value -> 'document_ids') <> 'array'
              OR pg_catalog.jsonb_array_length(e.value -> 'document_ids') > 50
              OR EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_array_elements(e.value -> 'document_ids') AS d(value)
                WHERE pg_catalog.jsonb_typeof(d.value) <> 'string' OR pg_catalog.lower(d.value #>> '{}') !~ v_uuid)))
        OR (e.value ? 'item_ids' AND pg_catalog.jsonb_typeof(e.value -> 'item_ids') <> 'null' AND (
              pg_catalog.jsonb_typeof(e.value -> 'item_ids') <> 'array'
              OR pg_catalog.jsonb_array_length(e.value -> 'item_ids') > 50
              OR EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_array_elements(e.value -> 'item_ids') AS t(value)
                WHERE pg_catalog.jsonb_typeof(t.value) <> 'string' OR pg_catalog.length(t.value #>> '{}') NOT BETWEEN 1 AND 200)))
  ) THEN
    RAISE EXCEPTION 'invalid_row' USING ERRCODE = '22023', DETAIL = 'document_ids are at most 50 UUID strings, item_ids at most 50 ids';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_array_elements(p_rows) AS e(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
        CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'document_ids') = 'array' THEN e.value -> 'document_ids' ELSE '[]'::jsonb END) AS d(value)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.documents doc WHERE doc.id = pg_catalog.lower(d.value #>> '{}')::uuid AND doc.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'document_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every document id must be a document of the tenant';
  END IF;

  IF pg_catalog.to_regclass('public.rag_golden_evidence_index') IS NOT NULL THEN
    v_golden := $golden$
          UNION
          SELECT g.document_id FROM public.rag_golden_evidence_index g
           WHERE g.tenant_key = $1
             AND g.item_id IN (SELECT pg_catalog.jsonb_array_elements_text(
               CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'item_ids') = 'array' THEN e.value -> 'item_ids' ELSE '[]'::jsonb END))
    $golden$;
  END IF;

  EXECUTE $sql$
    WITH written AS (
      INSERT INTO public.rag_review_items AS i (
        tenant_key, query_masked, query_fingerprint, query_language, channel, reasons, status, mining_window, mined_at, access_sets
      )
      SELECT $1, e.value ->> 'query_masked', e.value ->> 'query_fingerprint', NULLIF(e.value ->> 'language', ''),
             NULLIF(e.value ->> 'channel', ''), ARRAY['re_review']::text[], 'open', (e.value ->> 'mining_window')::timestamptz,
             pg_catalog.now(),
             public.rag_review_access_sets($1, NULLIF(e.value -> 'access_sets', 'null'::jsonb), ARRAY(
               SELECT pg_catalog.lower(d.value #>> '{}')::uuid
                 FROM pg_catalog.jsonb_array_elements(
                   CASE WHEN pg_catalog.jsonb_typeof(e.value -> 'document_ids') = 'array' THEN e.value -> 'document_ids' ELSE '[]'::jsonb END) AS d(value)
  $sql$ || v_golden || $sql$
             ), true)
        FROM pg_catalog.jsonb_array_elements($2) AS e(value)
      ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
      RETURNING 1
    )
    SELECT pg_catalog.count(*)::integer FROM written
  $sql$ INTO v_count USING p_tenant_key, p_rows;

  RETURN v_count;
END
$fn$
  $create$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.rag_review_items_enqueue_re_review(text, jsonb) TO service_role';
END
$do_re_review$;

DO $backfill$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL OR pg_catalog.to_regclass('public.rag_retrieval_log') IS NULL
     OR NOT public.rag_access_enforced() THEN
    RETURN;
  END IF;
  UPDATE public.rag_review_items AS i
  SET access_sets = public.rag_review_access_sets(i.tenant_key, l.access_sets, ARRAY(
    SELECT DISTINCT (c ->> 'document_id')::uuid
    FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l.candidates) = 'array' THEN l.candidates ELSE '[]'::jsonb END) AS c
    WHERE pg_catalog.jsonb_typeof(c) = 'object' AND pg_catalog.lower(c ->> 'document_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), false)
  FROM public.rag_retrieval_log l
  WHERE i.access_sets IS NULL AND l.id = i.retrieval_log_id AND l.tenant_key = i.tenant_key;
END
$backfill$;

NOTIFY pgrst, 'reload schema';

COMMIT;

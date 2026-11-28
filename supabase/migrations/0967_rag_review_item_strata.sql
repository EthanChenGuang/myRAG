-- 0967: review-item strata, the widened reasons check and rag_review_items_enqueue (Phase 5.3, EVAL-27, EVAL-30, D-41, D-50,
-- D-51, D-55, D-56, research X-4).
-- rag_review_item_strata keeps source (representative | pilot | drift_fill | historical), stratum code (cluster, language,
-- channel) and sampling weight per review item, so Phase 5.1.1's rag_review_items keeps its column shape. Its tenant_key is tied
-- to the item's by a composite foreign key; the row goes with its item. Service role only (RLS on, no policy).
-- rag_review_items: the reasons check is re-created with representative and re_review added to the Phase 5.1.1 list, and
-- trace_id loses NOT NULL where a database still has it (items without a log row or a trace are allowed).
-- rag_review_items_enqueue(p_tenant_key, p_source, p_rows): service role only, SECURITY INVOKER, empty search_path. It asserts the
-- tenant key for this deployment mode first, stores every row under p_tenant_key (a tenant named in a row is ignored), refuses a
-- retrieval_log_id that is not a log row of that tenant, inserts with ON CONFLICT DO NOTHING on (tenant_key, query_fingerprint,
-- mining_window) and writes one strata row per inserted item. Returns the number inserted.
-- No-op without the Phase 5.1.1 review queue (to_regclass guard). Idempotent; not folded into the setup files.

BEGIN;

DO $do$
DECLARE
  v_constraint name;
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL THEN
    RAISE NOTICE '[0967] rag_review_items is missing; skipped';
    RETURN;
  END IF;

  FOR v_constraint IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.rag_review_items'::regclass AND c.contype = 'c' AND a.attname = 'reasons'
      AND pg_catalog.cardinality(c.conkey) = 1
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.rag_review_items DROP CONSTRAINT %I', v_constraint);
  END LOOP;
  EXECUTE $sql$
    ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_reasons_check
      CHECK (reasons <@ ARRAY['feedback_negative', 'refusal_disputed', 'groundedness_flagged', 'refused_high_score', 'zero_results',
                              'low_score', 'no_source_opened', 'representative', 're_review']::text[])
  $sql$;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.rag_review_items'::regclass AND attname = 'trace_id' AND attnotnull AND NOT attisdropped
  ) THEN
    EXECUTE 'ALTER TABLE public.rag_review_items ALTER COLUMN trace_id DROP NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_review_items'::regclass AND conname = 'rag_review_items_id_tenant_key_key'
  ) THEN
    EXECUTE 'ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_id_tenant_key_key UNIQUE (id, tenant_key)';
  END IF;

  EXECUTE $sql$
    CREATE TABLE IF NOT EXISTS public.rag_review_item_strata (
      review_item_id uuid PRIMARY KEY,
      tenant_key text NOT NULL CONSTRAINT rag_review_item_strata_tenant_key_check
        CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
      source text NOT NULL CONSTRAINT rag_review_item_strata_source_check
        CHECK (source IN ('representative', 'pilot', 'drift_fill', 'historical')),
      stratum text NOT NULL CONSTRAINT rag_review_item_strata_stratum_check
        CHECK (stratum ~ '^[A-Za-z0-9_.:|-]{1,128}$'),
      sampling_weight real NOT NULL CONSTRAINT rag_review_item_strata_sampling_weight_check
        CHECK (sampling_weight > 0 AND sampling_weight < 'Infinity'::real),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rag_review_item_strata_item_tenant_fkey FOREIGN KEY (review_item_id, tenant_key)
        REFERENCES public.rag_review_items (id, tenant_key) ON DELETE CASCADE
    )
  $sql$;

  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_rag_review_item_strata_tenant_source ON public.rag_review_item_strata (tenant_key, source, created_at DESC)';
  EXECUTE 'ALTER TABLE public.rag_review_item_strata ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE public.rag_review_item_strata FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT ALL ON TABLE public.rag_review_item_strata TO service_role';

  EXECUTE $sql$
    CREATE OR REPLACE FUNCTION public.rag_review_items_enqueue(p_tenant_key text, p_source text, p_rows jsonb)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = ''
    AS $fn$
    DECLARE
      v_row jsonb;
      v_id uuid;
      v_log uuid;
      v_reasons text[];
      v_count integer := 0;
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

        v_log := NULLIF(v_row ->> 'retrieval_log_id', '')::uuid;
        IF v_log IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.rag_retrieval_log l WHERE l.id = v_log AND l.tenant_key = p_tenant_key
        ) THEN
          RAISE EXCEPTION 'retrieval_log_not_in_tenant' USING ERRCODE = '22023';
        END IF;

        IF v_row ? 'reasons' THEN
          v_reasons := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(v_row -> 'reasons'));
        ELSE
          v_reasons := ARRAY['representative']::text[];
        END IF;

        v_id := NULL;
        INSERT INTO public.rag_review_items AS i (
          tenant_key, retrieval_log_id, trace_id, query_masked, query_fingerprint, query_language, channel,
          reasons, status, mining_window, mined_at, expires_at
        ) VALUES (
          p_tenant_key, v_log, NULLIF(v_row ->> 'trace_id', ''), v_row ->> 'query_masked', v_row ->> 'query_fingerprint',
          NULLIF(v_row ->> 'language', ''), NULLIF(v_row ->> 'channel', ''),
          v_reasons, 'open', (v_row ->> 'mining_window')::timestamptz, pg_catalog.now(), NULLIF(v_row ->> 'expires_at', '')::timestamptz
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

NOTIFY pgrst, 'reload schema';

COMMIT;

-- 0413: chunking profile activation, rollback and coverage; parent currency; image and invoice-header chunks under an active profile
-- (Phase 4, plan 04-33, D-21, CHK-03, CHK-04). The plan named 0409; that number is taken, 0413 is the number reserved for this plan.
--
-- Activation (D-21). One chunking profile per doc type is active at deployment level. rag_create_chunking_profile inserts a building profile
-- (lower-case slug, `legacy` reserved, one of the six doc types, parent at least twice the child; the full rule set, including the embedding
-- input limit, lives in Pydantic and src/lib/rag/chunking/validate.ts). rag_record_chunking_decision stores a ChunkingDecision as the profile's
-- eval evidence after checking that its doc_type and profile id match the row. rag_activate_chunking_profile flips the pointer in one
-- transaction under a row lock on the doc type's profiles and otherwise raises `chunking_activation_refused:<reason>` with the reason one of
-- unknown_profile, ambiguous_profile, not_ready, incomplete, open_gaps, no_evidence, eval_failed, stale_evidence, checked in that order. A profile id is only
-- unique per doc type, so p_doc_type names the type when the id exists for more than one (and is required for `legacy`). Activating the active
-- profile changes nothing; activating `legacy` needs no evidence. rag_rollback_chunking_profile restores previous_active_id (legacy when null or
-- retired), returns the rolled-back profile to ready with every row kept, and refuses `no_previous` only when legacy is already active.
-- rag_chunking_coverage counts, per doc type and profile, the current ready documents, those with current chunks in the profile and those
-- missing (counts only: no ids, names or tenant keys). Pointer flips never touch chunk rows, so legacy readers are unaffected.
-- These five functions are SECURITY INVOKER with an empty search_path and schema-qualified names; only service_role may execute them.
--
-- Parent currency (round G MEDIUM-3). document_parents.is_current was written true and never updated, so a superseded, unpublished or
-- quarantined version kept current parents. It now follows the document row: a BEFORE trigger keeps a parent non-current while its document
-- is, an AFTER trigger on documents carries every is_current flip to the parents, existing rows are corrected, and rag_fetch_parents also joins the document
-- (current and ready, same tenant).
--
-- Image and invoice-header chunks (round G MEDIUM-5, round F deferred item). Profile children are cut from the parse text only, so the legacy
-- chunk_kind 'image' and 'invoice_header' rows have no counterpart in a profile; hybrid_search_chunks used a document's legacy rows only when it
-- had no rows of the effective profile, which hid them (and source_images) as soon as a profile was active. They now stay searchable
-- whatever profile is effective. The function is replaced from 0407 with that one added predicate.
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_parent_currency_from_document()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_current boolean;
BEGIN
  SELECT d.is_current INTO v_current FROM public.documents d WHERE d.id = NEW.document_id;
  IF FOUND THEN
    NEW.is_current := NEW.is_current AND v_current;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_sync_parent_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.document_parents p
  SET is_current = NEW.is_current
  WHERE p.document_id = NEW.id AND p.is_current IS DISTINCT FROM NEW.is_current;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS rag_document_parents_currency ON public.document_parents;
CREATE TRIGGER rag_document_parents_currency
  BEFORE INSERT OR UPDATE OF is_current ON public.document_parents
  FOR EACH ROW EXECUTE FUNCTION public.rag_parent_currency_from_document();

DROP TRIGGER IF EXISTS rag_documents_sync_parent_currency ON public.documents;
CREATE TRIGGER rag_documents_sync_parent_currency
  AFTER UPDATE OF is_current ON public.documents
  FOR EACH ROW
  WHEN (OLD.is_current IS DISTINCT FROM NEW.is_current)
  EXECUTE FUNCTION public.rag_sync_parent_currency();

UPDATE public.document_parents p
SET is_current = d.is_current
FROM public.documents d
WHERE d.id = p.document_id AND p.is_current IS DISTINCT FROM d.is_current;

CREATE OR REPLACE FUNCTION public.rag_fetch_parents(p_tenant_key text, p_parent_ids uuid[])
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  version integer,
  is_current boolean,
  chunking_profile_id text,
  section_path text[],
  content text,
  token_count integer,
  parent_index integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF coalesce(cardinality(p_parent_ids), 0) > 200 THEN
    RAISE EXCEPTION 'too many parent ids' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT
    p.id,
    p.document_id,
    p.tenant_key,
    p.version,
    p.is_current,
    p.chunking_profile_id,
    p.section_path,
    p.content,
    p.token_count,
    p.parent_index
  FROM public.document_parents p
  JOIN public.documents d
    ON d.id = p.document_id AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready'
  WHERE p.tenant_key = p_tenant_key
    AND p.is_current
    AND p.id = ANY(p_parent_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text,
  p_profile_id text,
  p_query_embedding vector,
  p_lexical_tokens text[],
  p_dense_limit integer,
  p_lexical_limit integer,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL,
  p_doc_types text[] DEFAULT NULL,
  p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off',
  p_exact_scan_cutoff integer DEFAULT 0,
  p_lexical_languages text[] DEFAULT NULL,
  p_supplier text DEFAULT NULL,
  p_amount_min numeric DEFAULT NULL,
  p_amount_max numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_chunking_override jsonb DEFAULT NULL
)
RETURNS TABLE (
  leg text,
  rank integer,
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  chunk_index integer,
  similarity double precision,
  lexical_score real,
  doc_type text,
  language text,
  parent_id uuid,
  section_path text[],
  chunk_kind text,
  document_filename text,
  document_created_at timestamptz,
  document_metadata jsonb,
  document_content_preview text,
  dense_mode text
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_dims integer;
  v_storage text;
  v_tsq tsquery;
  v_n integer;
  v_mode text := 'ann';
  v_filter text;
  v_from text;
  v_vec text;
  v_sel text;
  v_pgvector text;
  v_key text;
  v_val text;
  v_doc_types text[] := ARRAY[
    'financial_report', 'contract_legal', 'invoice_receipt',
    'product_technical', 'scanned_image', 'general'
  ];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;

  IF p_chunking_override IS NOT NULL AND jsonb_typeof(p_chunking_override) <> 'object' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid chunking override' USING ERRCODE = '22023';
  END IF;
  IF p_chunking_override IS NOT NULL THEN
    FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(p_chunking_override) LOOP
      IF NOT EXISTS (SELECT 1 FROM chunking_profiles cp WHERE cp.doc_type = v_key AND cp.id = v_val) THEN
        RAISE EXCEPTION 'hybrid_search_chunks: unknown chunking profile in override' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT e.dims, e.storage INTO v_dims, v_storage FROM embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  CREATE TEMP TABLE _hybrid_eff_profile (doc_type text PRIMARY KEY, profile_id text) ON COMMIT DROP;
  INSERT INTO _hybrid_eff_profile (doc_type, profile_id)
  SELECT dt.doc_type,
         COALESCE(
           NULLIF(trim(both FROM p_chunking_override ->> dt.doc_type), ''),
           (SELECT cp.id FROM chunking_profiles cp WHERE cp.doc_type = dt.doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1),
           'legacy'
         )
  FROM unnest(v_doc_types) AS dt(doc_type);

  v_filter :=
    ' c.tenant_key = $2 AND c.is_current AND c.status IN (''ready'', ''variant'')'
    || ' AND EXISTS (SELECT 1 FROM _hybrid_eff_profile ep WHERE ep.doc_type = c.doc_type AND ('
    || '   c.chunking_profile_id = ep.profile_id'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'' AND c.chunk_kind IN (''image'', ''invoice_header''))'
    || '   OR (ep.profile_id <> ''legacy'' AND c.chunking_profile_id = ''legacy'''
    || '       AND NOT EXISTS (SELECT 1 FROM document_chunks c2 WHERE c2.document_id = c.document_id'
    || '         AND c2.tenant_key = $2 AND c2.is_current AND c2.chunking_profile_id = ep.profile_id))'
    || ' ))'
    || ' AND ($3::date IS NULL OR c.doc_date >= $3)'
    || ' AND ($4::date IS NULL OR c.doc_date <= $4)'
    || ' AND ($5::text[] IS NULL OR (cardinality($5) > 0 AND c.source = ANY($5)))'
    || ' AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7))'
    || ' AND ($8::text[] IS NULL OR c.language = ANY($8))'
    || ' AND ($9::text IS NULL OR strpos(lower(d.supplier_name), lower($9)) > 0 OR d.supplier_tax_id = $9)'
    || ' AND ($10::numeric IS NULL OR d.gross_total >= $10)'
    || ' AND ($11::numeric IS NULL OR d.gross_total <= $11)'
    || ' AND ($12::text IS NULL OR d.currency = $12) ';

  v_sel :=
    ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' c.parent_id, c.section_path, c.chunk_kind,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' document_chunks c JOIN documents d ON d.id = c.document_id ';
      v_vec := format('c.embedding <=> $1::vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(
        ' chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L'
        || ' JOIN documents d ON d.id = c.document_id ',
        p_profile_id
      );
      v_vec := format('(e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)', v_dims);
    END IF;

    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*)::int FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $13) s'
        INTO v_n
        USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
          p_supplier, p_amount_min, p_amount_max, p_currency, p_exact_scan_cutoff + 1;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;

    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN
        SELECT extversion INTO v_pgvector FROM pg_extension WHERE extname = 'vector';
        IF v_pgvector IS NULL OR (string_to_array(v_pgvector, '.'))[1:2]::int[] < ARRAY[0, 8] THEN
          RAISE EXCEPTION 'iterative_scan_unsupported' USING ERRCODE = '22023';
        END IF;
        PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true);
      END IF;
    END IF;

    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $13) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $13) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_dense_limit;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
  v_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score'
      || ' FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE ' || v_filter
      || ' AND ($14::text[] IS NULL OR (cardinality($14) > 0 AND c.language = ANY($14)))'
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $13) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(
        v_sel,
        CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
          THEN format('(1 - (c.embedding <=> $15::vector(%s)))::double precision', v_dims)
          ELSE 'NULL::double precision' END,
        't.score::real',
        'n/a'
      )
      || ' FROM hits t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages,
        p_supplier, p_amount_min, p_amount_max, p_currency, p_lexical_limit, p_lexical_languages, p_query_embedding;
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_create_chunking_profile(
  p_id text,
  p_doc_type text,
  p_child_tokens integer,
  p_parent_mode text,
  p_parent_tokens integer,
  p_preset text
)
RETURNS TABLE (profile_id text, doc_type text, status text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  IF p_id IS NULL OR p_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_profile: the id must be a lower-case slug' USING ERRCODE = '22023';
  END IF;
  IF p_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_profile: legacy is reserved' USING ERRCODE = '22023';
  END IF;
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general') THEN
    RAISE EXCEPTION 'invalid_profile: unknown doc type' USING ERRCODE = '22023';
  END IF;
  IF p_child_tokens IS NULL OR p_child_tokens < 1 OR p_child_tokens > 32768 THEN
    RAISE EXCEPTION 'invalid_profile: child_tokens must be between 1 and 32768' USING ERRCODE = '22023';
  END IF;
  IF p_parent_mode IS NULL OR p_parent_mode NOT IN ('none', 'structure', 'fixed') THEN
    RAISE EXCEPTION 'invalid_profile: unknown parent mode' USING ERRCODE = '22023';
  END IF;
  IF p_parent_mode <> 'none' AND p_parent_tokens IS NULL THEN
    RAISE EXCEPTION 'invalid_profile: parent_tokens is required unless the parent mode is none' USING ERRCODE = '22023';
  END IF;
  IF p_parent_tokens IS NOT NULL AND p_parent_tokens < p_child_tokens * 2 THEN
    RAISE EXCEPTION 'invalid_profile: a parent must hold at least twice the child tokens' USING ERRCODE = '22023';
  END IF;
  IF p_preset IS NULL OR p_preset NOT IN ('128/512', '256/1024', '256/2048', 'custom') THEN
    RAISE EXCEPTION 'invalid_profile: unknown preset' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
  VALUES (p_id, p_doc_type, p_child_tokens, p_parent_mode, p_parent_tokens, 'building', p_preset);

  RETURN QUERY SELECT p_id, p_doc_type, 'building'::text;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_record_chunking_decision(p_profile_id text, p_decision jsonb)
RETURNS TABLE (profile_id text, doc_type text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_doc_type text;
  v_row public.chunking_profiles%ROWTYPE;
BEGIN
  IF p_decision IS NULL OR jsonb_typeof(p_decision) <> 'object' THEN
    RAISE EXCEPTION 'invalid_decision: a decision must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_decision -> 'gate_passed') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'invalid_decision: gate_passed must be a boolean' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_decision -> 'doc_type') IS DISTINCT FROM 'string' OR jsonb_typeof(p_decision -> 'profile_id') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_decision: doc_type and profile_id must be strings' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_decision -> 'build_run_id') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid_decision: build_run_id must be a string or null' USING ERRCODE = '22023';
  END IF;
  IF (p_decision ->> 'profile_id') IS DISTINCT FROM p_profile_id THEN
    RAISE EXCEPTION 'invalid_decision: the decision names another profile' USING ERRCODE = '22023';
  END IF;
  IF p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_decision: legacy needs no evidence' USING ERRCODE = '22023';
  END IF;
  v_doc_type := p_decision ->> 'doc_type';

  SELECT * INTO v_row FROM public.chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = v_doc_type FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_decision: no profile of that id for that doc type' USING ERRCODE = '22023';
  END IF;
  IF v_row.status = 'retired' THEN
    RAISE EXCEPTION 'invalid_decision: the profile is retired' USING ERRCODE = '22023';
  END IF;

  UPDATE public.chunking_profiles cp SET eval_evidence = p_decision WHERE cp.id = p_profile_id AND cp.doc_type = v_doc_type;
  RETURN QUERY SELECT p_profile_id, v_doc_type;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_activate_chunking_profile(p_profile_id text, p_actor text, p_doc_type text DEFAULT NULL)
RETURNS TABLE (activated_profile text, previous_profile text, doc_type text, changed boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '120s'
AS $$
#variable_conflict use_column
DECLARE
  v_actor text;
  v_doc_type text;
  v_count integer;
  v_target public.chunking_profiles%ROWTYPE;
  v_active public.chunking_profiles%ROWTYPE;
  v_missing integer;
  v_run uuid;
  v_evidence jsonb;
BEGIN
  IF p_actor IS NOT NULL AND p_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_actor: the actor must be a uuid' USING ERRCODE = '22023';
  END IF;
  v_actor := COALESCE(p_actor, 'cli');

  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'chunking_activation_refused:unknown_profile' USING ERRCODE = '55000';
  END IF;
  IF p_doc_type IS NOT NULL THEN
    v_doc_type := p_doc_type;
  ELSE
    SELECT count(*)::integer, min(cp.doc_type) INTO v_count, v_doc_type FROM public.chunking_profiles cp WHERE cp.id = p_profile_id;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'chunking_activation_refused:unknown_profile' USING ERRCODE = '55000';
    END IF;
    IF v_count > 1 THEN
      RAISE EXCEPTION 'chunking_activation_refused:ambiguous_profile (the id exists for % doc types; name the doc type)', v_count USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM 1 FROM public.chunking_profiles cp WHERE cp.doc_type = v_doc_type ORDER BY cp.id FOR UPDATE;

  SELECT * INTO v_target FROM public.chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = v_doc_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chunking_activation_refused:unknown_profile' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_active FROM public.chunking_profiles cp WHERE cp.doc_type = v_doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1;

  IF v_target.status = 'active' THEN
    RETURN QUERY SELECT v_target.id, v_target.previous_active_id, v_doc_type, false;
    RETURN;
  END IF;
  IF v_target.status <> 'ready' THEN
    RAISE EXCEPTION 'chunking_activation_refused:not_ready (status %)', v_target.status USING ERRCODE = '55000';
  END IF;

  IF v_target.id <> 'legacy' THEN
    SELECT count(*)::integer INTO v_missing
    FROM public.documents d
    WHERE d.doc_type = v_doc_type AND d.is_current AND d.status = 'ready'
      AND NOT EXISTS (
        SELECT 1 FROM public.document_chunks c
        WHERE c.document_id = d.id AND c.chunking_profile_id = v_target.id AND c.is_current);
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'chunking_activation_refused:incomplete (% current ready documents have no children in profile %)', v_missing, v_target.id
        USING ERRCODE = '55000';
    END IF;

    SELECT r.id INTO v_run
    FROM public.chunking_build_runs r
    WHERE r.profile_id = v_target.id AND r.doc_type = v_doc_type
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 1;
    IF v_run IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.chunking_build_gaps g
      JOIN public.documents d ON d.id = g.document_id AND d.is_current AND d.status = 'ready'
      WHERE g.run_id = v_run
    ) THEN
      RAISE EXCEPTION 'chunking_activation_refused:open_gaps (the latest build run of profile % recorded gaps)', v_target.id USING ERRCODE = '55000';
    END IF;

    v_evidence := v_target.eval_evidence;
    IF v_evidence IS NULL OR jsonb_typeof(v_evidence) <> 'object'
       OR (v_evidence ->> 'profile_id') IS DISTINCT FROM v_target.id
       OR (v_evidence ->> 'doc_type') IS DISTINCT FROM v_doc_type THEN
      RAISE EXCEPTION 'chunking_activation_refused:no_evidence' USING ERRCODE = '55000';
    END IF;
    IF (v_evidence -> 'gate_passed') IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'chunking_activation_refused:eval_failed' USING ERRCODE = '55000';
    END IF;

    SELECT r.id INTO v_run
    FROM public.chunking_build_runs r
    WHERE r.profile_id = v_target.id AND r.doc_type = v_doc_type AND r.status = 'completed'
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 1;
    IF (v_evidence ->> 'build_run_id') IS DISTINCT FROM v_run::text THEN
      RAISE EXCEPTION 'chunking_activation_refused:stale_evidence (the decision is not for the latest completed build run)' USING ERRCODE = '55000';
    END IF;
  END IF;

  UPDATE public.chunking_profiles cp SET status = 'ready' WHERE cp.doc_type = v_doc_type AND cp.status = 'active';
  UPDATE public.chunking_profiles cp
  SET status = 'active', previous_active_id = v_active.id, activated_at = now(), activated_by = v_actor
  WHERE cp.id = v_target.id AND cp.doc_type = v_doc_type;

  RETURN QUERY SELECT v_target.id, v_active.id, v_doc_type, true;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_rollback_chunking_profile(p_doc_type text, p_actor text)
RETURNS TABLE (restored_profile text, rolled_back_profile text, doc_type text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '120s'
AS $$
#variable_conflict use_column
DECLARE
  v_actor text;
  v_active public.chunking_profiles%ROWTYPE;
  v_restore public.chunking_profiles%ROWTYPE;
BEGIN
  IF p_actor IS NOT NULL AND p_actor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid_actor: the actor must be a uuid' USING ERRCODE = '22023';
  END IF;
  v_actor := COALESCE(p_actor, 'cli');
  IF p_doc_type IS NULL OR p_doc_type NOT IN ('financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image', 'general') THEN
    RAISE EXCEPTION 'invalid_doc_type: unknown doc type' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.chunking_profiles cp WHERE cp.doc_type = p_doc_type ORDER BY cp.id FOR UPDATE;

  SELECT * INTO v_active FROM public.chunking_profiles cp WHERE cp.doc_type = p_doc_type AND cp.status = 'active' ORDER BY cp.id LIMIT 1;
  IF NOT FOUND OR v_active.id = 'legacy' THEN
    RAISE EXCEPTION 'chunking_activation_refused:no_previous' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_restore FROM public.chunking_profiles cp
  WHERE cp.doc_type = p_doc_type AND cp.id = COALESCE(v_active.previous_active_id, 'legacy') AND cp.status <> 'retired';
  IF NOT FOUND THEN
    SELECT * INTO v_restore FROM public.chunking_profiles cp WHERE cp.doc_type = p_doc_type AND cp.id = 'legacy';
  END IF;

  UPDATE public.chunking_profiles cp SET status = 'ready' WHERE cp.doc_type = p_doc_type AND cp.id = v_active.id;
  UPDATE public.chunking_profiles cp
  SET status = 'active', previous_active_id = NULL, activated_at = now(), activated_by = v_actor
  WHERE cp.doc_type = p_doc_type AND cp.id = v_restore.id;

  RETURN QUERY SELECT v_restore.id, v_active.id, p_doc_type;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_chunking_coverage()
RETURNS TABLE (
  doc_type text,
  profile_id text,
  is_active boolean,
  current_ready_documents integer,
  documents_with_children integer,
  missing_documents integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH ready AS (
    SELECT d.id, d.doc_type FROM public.documents d WHERE d.is_current AND d.status = 'ready'
  ),
  totals AS (
    SELECT r.doc_type, count(*)::integer AS n FROM ready r GROUP BY r.doc_type
  ),
  covered AS (
    SELECT p.doc_type, p.id AS profile_id, count(*)::integer AS n
    FROM public.chunking_profiles p
    JOIN ready r ON r.doc_type = p.doc_type
    WHERE EXISTS (
      SELECT 1 FROM public.document_chunks c
      WHERE c.document_id = r.id AND c.chunking_profile_id = p.id AND c.is_current)
    GROUP BY p.doc_type, p.id
  )
  SELECT
    p.doc_type,
    p.id,
    (p.status = 'active'),
    COALESCE(t.n, 0),
    COALESCE(c.n, 0),
    COALESCE(t.n, 0) - COALESCE(c.n, 0)
  FROM public.chunking_profiles p
  LEFT JOIN totals t ON t.doc_type = p.doc_type
  LEFT JOIN covered c ON c.doc_type = p.doc_type AND c.profile_id = p.id
  ORDER BY p.doc_type, p.id
$$;

REVOKE ALL ON FUNCTION public.rag_parent_currency_from_document() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_sync_parent_currency() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_sync_parent_currency() TO service_role;

REVOKE ALL ON FUNCTION public.rag_fetch_parents(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_fetch_parents(text, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(
  text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(
  text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer,
  text[], text, numeric, numeric, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.rag_create_chunking_profile(text, text, integer, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_record_chunking_decision(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_activate_chunking_profile(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_rollback_chunking_profile(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_chunking_coverage() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_create_chunking_profile(text, text, integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_record_chunking_decision(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_activate_chunking_profile(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_rollback_chunking_profile(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_chunking_coverage() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

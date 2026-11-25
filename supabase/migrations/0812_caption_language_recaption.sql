-- 0812: caption languages and the recaption run (plan 03.2-33; D-23, D-24; XLG-06). Phase 3.2 gap-closure number: 0801-0811 are assigned.
-- rag_set_image_chunk_languages: under RAG_CAPTION_LANGUAGE=document the write stage stores, per picture caption of a version, the language
-- detected on the caption as written. The chunk writers copy the document language onto every chunk; this function then sets language and
-- metadata.language of the version's image chunks named by image URL. Nothing calls it with the switch at en. A later rag_set_document_fields
-- call that names language, doc_type, doc_date, parser_used or status copies the document language back (0801), as for every chunk.
-- Recaption (D-24, npm run rag:reembed -- --recaption): rag_recaption_runs is the run ledger (cursor by chunk id, counts, status) and
-- rag_recaption_items keeps, per rewritten chunk, everything needed to undo it: previous content, content hash, lexical text, language,
-- metadata and every vector the chunk held (legacy column and chunk_embeddings rows, as text). It is a ledger of its own rather than rows of
-- embedding_backfill_runs: a recaption run rewrites the active profile's vectors, and rag_reembed_resume_run / rag_reembed_rollback_run would
-- treat such a row as a backfill of that profile (rollback deletes every vector of the profile embedded in the run window). The cursor,
-- resume and rollback follow the re-embed job. rag_recaption_write_chunk rewrites content, content_hash, lexical_text, language, metadata
-- (previous_caption, caption_language, recaption_run_id) and every vector the chunk holds in one transaction, and refuses unless the vectors
-- given cover exactly the profiles that hold one. rag_recaption_rollback_run restores the items whose chunk still carries the run id.
-- Purge: rag_purge_hook_recaption(p_tenant_key, p_lineage_id, p_document_ids) removes the items (they hold previous caption text).
-- Every function here is service_role only: REVOKE ALL FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature.
-- SECURITY INVOKER with an empty search_path unless stated; the tenant is checked with rag_assert_tenant_key and every row is matched on it.
-- Not folded into the setup files. Idempotent: CREATE OR REPLACE and IF NOT EXISTS.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_set_image_chunk_languages(p_document_id uuid, p_tenant_key text, p_items jsonb)
RETURNS TABLE (chunks_updated integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_items IS NULL OR pg_catalog.jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_items: p_items must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(p_items) AS e(value)
    WHERE pg_catalog.jsonb_typeof(e.value) <> 'object'
       OR pg_catalog.jsonb_typeof(e.value -> 'image_url') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(e.value -> 'language') IS DISTINCT FROM 'string'
       OR (e.value ->> 'language') !~ '^[a-z]{2,3}$'
  ) THEN
    RAISE EXCEPTION 'invalid_items: every item needs a string image_url and a language code' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key AND d.status NOT IN ('failed', 'deleted');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;

  UPDATE public.document_chunks c SET
    language = i.language,
    metadata = COALESCE(c.metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('language', i.language)
  FROM (
    SELECT DISTINCT ON (e.value ->> 'image_url') e.value ->> 'image_url' AS image_url, e.value ->> 'language' AS language
    FROM pg_catalog.jsonb_array_elements(p_items) AS e(value)
    ORDER BY e.value ->> 'image_url'
  ) i
  WHERE c.document_id = p_document_id
    AND c.tenant_key = p_tenant_key
    AND c.chunk_kind = 'image'
    AND c.metadata ->> 'image_url' = i.image_url;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_set_image_chunk_languages(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_image_chunk_languages(uuid, text, jsonb) TO service_role;

CREATE TABLE IF NOT EXISTS public.rag_recaption_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text,
  actor text NOT NULL,
  cursor_chunk_id uuid,
  chunks_total bigint NOT NULL DEFAULT 0,
  chunks_done bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rag_recaption_runs_status_check CHECK (status IN ('running', 'completed', 'failed', 'rolled_back'))
);

CREATE TABLE IF NOT EXISTS public.rag_recaption_items (
  run_id uuid NOT NULL REFERENCES public.rag_recaption_runs (id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES public.document_chunks (id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  document_id uuid NOT NULL,
  previous_content text NOT NULL,
  previous_content_hash text,
  previous_lexical_text text,
  previous_language text,
  previous_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_embedding text,
  previous_vectors jsonb NOT NULL DEFAULT '{}'::jsonb,
  recaptioned_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  PRIMARY KEY (run_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS rag_recaption_items_chunk_idx ON public.rag_recaption_items (chunk_id);
CREATE INDEX IF NOT EXISTS rag_recaption_items_tenant_document_idx ON public.rag_recaption_items (tenant_key, document_id);

ALTER TABLE public.rag_recaption_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_recaption_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_recaption_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.rag_recaption_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_recaption_runs TO service_role;
GRANT ALL ON TABLE public.rag_recaption_items TO service_role;

-- A page of current ready image chunks with a stored image URL, by chunk id. picture_document: every current chunk of the document is an
-- image (a picture upload, whose document language is its own caption's). profiles: every profile that holds a vector of the chunk, with
-- what is needed to embed for it again (the legacy column counts as openai-3-small-1536).
CREATE OR REPLACE FUNCTION public.rag_recaption_candidates(p_tenant_key text, p_after uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  tenant_key text,
  content text,
  language text,
  caption_language text,
  document_language text,
  picture_document boolean,
  image_url text,
  image_type text,
  section_path text[],
  doc_type text,
  template_row jsonb,
  profiles jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'recaption_refused: invalid_limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT c.id, c.document_id, c.tenant_key, c.content, c.language,
         c.metadata ->> 'caption_language',
         d.language,
         NOT EXISTS (SELECT 1 FROM public.document_chunks o WHERE o.document_id = c.document_id AND o.chunk_kind <> 'image'),
         c.metadata ->> 'image_url',
         c.metadata ->> 'image_type',
         c.section_path,
         COALESCE(c.doc_type, d.doc_type),
         pg_catalog.jsonb_build_object(
           'invoice_number', d.invoice_number,
           'supplier_name', d.supplier_name,
           'supplier_tax_id', d.supplier_tax_id,
           'issue_date', d.issue_date::text,
           'gross_total', d.gross_total::text,
           'currency', d.currency),
         COALESCE((
           SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.id, 'provider', p.provider, 'model', p.model, 'dims', p.dims, 'storage', p.storage) ORDER BY p.id)
           FROM public.embedding_profiles p
           WHERE (p.id = 'openai-3-small-1536' AND c.embedding IS NOT NULL)
              OR EXISTS (SELECT 1 FROM public.chunk_embeddings e WHERE e.chunk_id = c.id AND e.profile_id = p.id)
         ), '[]'::jsonb)
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id AND d.tenant_key = c.tenant_key
  WHERE c.is_current AND c.status = 'ready' AND c.chunk_kind = 'image'
    AND pg_catalog.jsonb_typeof(c.metadata -> 'image_url') = 'string'
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key)
    AND (p_after IS NULL OR c.id > p_after)
  ORDER BY c.id
  LIMIT p_limit;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_recaption_get_run(p_run_id uuid)
RETURNS TABLE (run_id uuid, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, status text, started_at timestamptz, updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT r.id, r.tenant_key, r.cursor_chunk_id, r.chunks_total, r.chunks_done, r.status, r.started_at, r.updated_at
  FROM public.rag_recaption_runs r WHERE r.id = p_run_id
$fn$;

CREATE OR REPLACE FUNCTION public.rag_recaption_start_run(p_tenant_key text, p_actor text)
RETURNS TABLE (run_id uuid, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, status text, started_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_total bigint;
  v_run uuid;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'recaption_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key IS NOT NULL THEN
    PERFORM public.rag_assert_tenant_key(p_tenant_key);
  END IF;
  LOCK TABLE public.rag_recaption_runs IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM public.rag_recaption_runs r
    WHERE r.status = 'running' AND (r.tenant_key IS NULL OR p_tenant_key IS NULL OR r.tenant_key = p_tenant_key)
  ) THEN
    RAISE EXCEPTION 'recaption_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.count(*) INTO v_total
  FROM public.document_chunks c
  WHERE c.is_current AND c.status = 'ready' AND c.chunk_kind = 'image'
    AND pg_catalog.jsonb_typeof(c.metadata -> 'image_url') = 'string'
    AND (p_tenant_key IS NULL OR c.tenant_key = p_tenant_key);
  INSERT INTO public.rag_recaption_runs AS r (tenant_key, actor, chunks_total) VALUES (p_tenant_key, p_actor, v_total) RETURNING r.id INTO v_run;
  RETURN QUERY SELECT * FROM public.rag_recaption_get_run(v_run);
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_recaption_resume_run(p_run_id uuid, p_actor text)
RETURNS TABLE (run_id uuid, tenant_key text, cursor_chunk_id uuid, chunks_total bigint, chunks_done bigint, status text, started_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_recaption_runs%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'recaption_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.rag_recaption_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recaption_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status IN ('completed', 'rolled_back') THEN
    RAISE EXCEPTION 'recaption_refused: run_%', v_run.status USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rag_recaption_runs o
    WHERE o.id <> v_run.id AND o.status = 'running'
      AND (o.tenant_key IS NULL OR v_run.tenant_key IS NULL OR o.tenant_key = v_run.tenant_key)
  ) THEN
    RAISE EXCEPTION 'recaption_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;
  UPDATE public.rag_recaption_runs SET status = 'running', updated_at = now() WHERE id = v_run.id;
  RETURN QUERY SELECT * FROM public.rag_recaption_get_run(p_run_id);
END
$fn$;

-- One chunk, one transaction: the previous state goes to the run's items (the first write of a chunk in a run is kept), then content,
-- content_hash, lexical_text, language, metadata and every vector of the chunk are replaced. p_vectors maps a profile id to a JSON array of
-- numbers and must name exactly the profiles that hold a vector of the chunk now.
CREATE OR REPLACE FUNCTION public.rag_recaption_write_chunk(
  p_run_id uuid,
  p_chunk_id uuid,
  p_content text,
  p_content_hash text,
  p_lexical_text text,
  p_language text,
  p_vectors jsonb
)
RETURNS TABLE (chunks_done bigint, cursor_chunk_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  v_run public.rag_recaption_runs%ROWTYPE;
  v_chunk public.document_chunks%ROWTYPE;
  v_held text[];
  v_given text[];
  v_done bigint;
  v_cursor uuid;
BEGIN
  SELECT * INTO v_run FROM public.rag_recaption_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recaption_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status <> 'running' THEN
    RAISE EXCEPTION 'recaption_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  IF p_content IS NULL OR pg_catalog.btrim(p_content) = '' THEN
    RAISE EXCEPTION 'recaption_refused: empty_caption' USING ERRCODE = '22023';
  END IF;
  IF p_language IS NOT NULL AND p_language !~ '^[a-z]{2,3}$' THEN
    RAISE EXCEPTION 'recaption_refused: invalid_language' USING ERRCODE = '22023';
  END IF;
  IF p_vectors IS NULL OR pg_catalog.jsonb_typeof(p_vectors) <> 'object' THEN
    RAISE EXCEPTION 'recaption_refused: vectors_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_chunk FROM public.document_chunks c
  WHERE c.id = p_chunk_id AND c.is_current AND c.status = 'ready' AND c.chunk_kind = 'image'
    AND (v_run.tenant_key IS NULL OR c.tenant_key = v_run.tenant_key)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recaption_refused: chunk_not_eligible' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(x.id ORDER BY x.id), '{}'::text[]) INTO v_held
  FROM (
    SELECT legacy_profile AS id WHERE v_chunk.embedding IS NOT NULL
    UNION
    SELECT e.profile_id FROM public.chunk_embeddings e WHERE e.chunk_id = v_chunk.id
  ) x;
  SELECT COALESCE(pg_catalog.array_agg(k ORDER BY k), '{}'::text[]) INTO v_given FROM pg_catalog.jsonb_object_keys(p_vectors) AS k;
  IF v_held IS DISTINCT FROM v_given THEN
    RAISE EXCEPTION 'recaption_refused: vectors_mismatch' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(p_vectors) AS v(profile_id, vector)
    JOIN public.embedding_profiles p ON p.id = v.profile_id
    WHERE pg_catalog.jsonb_typeof(v.vector) <> 'array' OR pg_catalog.jsonb_array_length(v.vector) <> p.dims
  ) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  INSERT INTO public.rag_recaption_items (
    run_id, chunk_id, tenant_key, document_id, previous_content, previous_content_hash, previous_lexical_text, previous_language,
    previous_metadata, previous_embedding, previous_vectors
  )
  SELECT v_run.id, v_chunk.id, v_chunk.tenant_key, v_chunk.document_id, v_chunk.content, v_chunk.content_hash, v_chunk.lexical_text,
         v_chunk.language, COALESCE(v_chunk.metadata, '{}'::jsonb), v_chunk.embedding::text,
         COALESCE((
           SELECT pg_catalog.jsonb_object_agg(e.profile_id, pg_catalog.jsonb_build_object(
             'embedding', e.embedding::text, 'embedding_model', e.embedding_model, 'dims', e.dims, 'embedding_host', e.embedding_host))
           FROM public.chunk_embeddings e WHERE e.chunk_id = v_chunk.id
         ), '{}'::jsonb)
  ON CONFLICT (run_id, chunk_id) DO NOTHING;

  UPDATE public.document_chunks c SET
    content = p_content,
    content_hash = p_content_hash,
    lexical_text = p_lexical_text,
    language = COALESCE(p_language, c.language),
    embedding = CASE WHEN p_vectors ? legacy_profile THEN ((p_vectors -> legacy_profile)::text)::public.vector ELSE c.embedding END,
    metadata = COALESCE(c.metadata, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('previous_caption', v_chunk.content, 'recaption_run_id', v_run.id::text)
      || CASE WHEN p_language IS NOT NULL
              THEN pg_catalog.jsonb_build_object('caption_language', p_language, 'language', p_language) ELSE '{}'::jsonb END
  WHERE c.id = v_chunk.id;

  INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
  SELECT v_chunk.id, p.id, v_chunk.tenant_key, ((v.vector)::text)::public.halfvec, p.model, p.dims, 'recaption'
  FROM pg_catalog.jsonb_each(p_vectors) AS v(profile_id, vector)
  JOIN public.embedding_profiles p ON p.id = v.profile_id
  WHERE v.profile_id <> legacy_profile
  ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model,
    dims = EXCLUDED.dims,
    embedding_host = EXCLUDED.embedding_host,
    embedded_at = now();

  UPDATE public.rag_recaption_runs AS r SET
    chunks_done = r.chunks_done + 1,
    cursor_chunk_id = CASE WHEN r.cursor_chunk_id IS NULL OR v_chunk.id > r.cursor_chunk_id THEN v_chunk.id ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = v_run.id
  RETURNING r.chunks_done, r.cursor_chunk_id INTO v_done, v_cursor;
  RETURN QUERY SELECT v_done, v_cursor;
END
$fn$;

-- Moves the cursor past chunks the job looked at and left alone (already in their target language, or no usable image).
CREATE OR REPLACE FUNCTION public.rag_recaption_advance(p_run_id uuid, p_cursor uuid)
RETURNS TABLE (cursor_chunk_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_cursor uuid;
BEGIN
  UPDATE public.rag_recaption_runs AS r SET
    cursor_chunk_id = CASE WHEN r.cursor_chunk_id IS NULL OR p_cursor > r.cursor_chunk_id THEN p_cursor ELSE r.cursor_chunk_id END,
    updated_at = now()
  WHERE r.id = p_run_id AND r.status = 'running'
  RETURNING r.cursor_chunk_id INTO v_cursor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recaption_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT v_cursor;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_recaption_finish_run(p_run_id uuid, p_status text)
RETURNS TABLE (status text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_status text;
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'recaption_refused: invalid_status' USING ERRCODE = '22023';
  END IF;
  UPDATE public.rag_recaption_runs AS r SET status = p_status, updated_at = now()
  WHERE r.id = p_run_id AND r.status = 'running'
  RETURNING r.status INTO v_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recaption_refused: run_not_running' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT v_status;
END
$fn$;

-- Restores every chunk of the run that still carries the run's id (a chunk recaptioned again by a later run is left to that run): content,
-- content_hash, lexical_text, language, metadata, the legacy vector and the chunk_embeddings rows as they were. A profile row added after the
-- recaption (embedded from the new caption) is removed. Refused while the run is running and was active in the last 10 minutes.
CREATE OR REPLACE FUNCTION public.rag_recaption_rollback_run(p_run_id uuid, p_actor text)
RETURNS TABLE (chunks_restored bigint, chunks_skipped bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_run public.rag_recaption_runs%ROWTYPE;
  v_item public.rag_recaption_items%ROWTYPE;
  v_restored bigint := 0;
  v_skipped bigint := 0;
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'rollback_refused: actor_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.rag_recaption_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_refused: run_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_run.status = 'rolled_back' THEN
    RAISE EXCEPTION 'rollback_refused: already_rolled_back' USING ERRCODE = '55000';
  END IF;
  IF v_run.status = 'running' AND v_run.updated_at > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'rollback_refused: run_in_progress' USING ERRCODE = '55000';
  END IF;

  FOR v_item IN
    SELECT * FROM public.rag_recaption_items i WHERE i.run_id = v_run.id AND i.restored_at IS NULL ORDER BY i.chunk_id
  LOOP
    PERFORM 1 FROM public.document_chunks c
    WHERE c.id = v_item.chunk_id AND c.tenant_key = v_item.tenant_key AND c.metadata ->> 'recaption_run_id' = v_run.id::text
    FOR UPDATE;
    IF NOT FOUND THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    UPDATE public.document_chunks c SET
      content = v_item.previous_content,
      content_hash = v_item.previous_content_hash,
      lexical_text = v_item.previous_lexical_text,
      language = v_item.previous_language,
      metadata = v_item.previous_metadata,
      embedding = (v_item.previous_embedding)::public.vector
    WHERE c.id = v_item.chunk_id;
    DELETE FROM public.chunk_embeddings e WHERE e.chunk_id = v_item.chunk_id AND NOT (v_item.previous_vectors ? e.profile_id);
    INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
    SELECT v_item.chunk_id, v.profile_id, v_item.tenant_key, ((v.value ->> 'embedding'))::public.halfvec, v.value ->> 'embedding_model',
           (v.value ->> 'dims')::integer, v.value ->> 'embedding_host'
    FROM pg_catalog.jsonb_each(v_item.previous_vectors) AS v(profile_id, value)
    ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
      embedding = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      dims = EXCLUDED.dims,
      embedding_host = EXCLUDED.embedding_host,
      embedded_at = now();
    UPDATE public.rag_recaption_items i SET restored_at = now() WHERE i.run_id = v_item.run_id AND i.chunk_id = v_item.chunk_id;
    v_restored := v_restored + 1;
  END LOOP;

  UPDATE public.rag_recaption_runs AS r SET status = 'rolled_back', updated_at = now() WHERE r.id = v_run.id;
  RETURN QUERY SELECT v_restored, v_skipped;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_recaption(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  DELETE FROM public.rag_recaption_items i
  WHERE i.tenant_key = p_tenant_key
    AND (
      i.document_id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      OR (
        p_lineage_id IS NOT NULL
        AND i.document_id IN (SELECT d.id FROM public.documents d WHERE d.lineage_id = p_lineage_id AND d.tenant_key = p_tenant_key)
      )
    );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_recaption_candidates(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_recaption_get_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_recaption_start_run(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_recaption_resume_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_recaption_write_chunk(uuid, uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_recaption_advance(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_recaption_finish_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_recaption_rollback_run(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_purge_hook_recaption(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_recaption_candidates(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_recaption_get_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_recaption_start_run(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_recaption_resume_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_recaption_write_chunk(uuid, uuid, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_recaption_advance(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_recaption_finish_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_recaption_rollback_run(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_recaption(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

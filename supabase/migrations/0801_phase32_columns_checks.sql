-- 0801: Phase 3.2 schema seam (plan 03.2-04; D-10, D-13, D-34, D-36, D-37, D-38, D-43, D-48; research F-8, F-15, F-16).
-- Status value pending_review on documents and document_chunks (D-36): one named check per table, rebuilt with the 0404 loop that drops
-- every single-column check on status first. The chunk list keeps variant. A pending_review row stays out of every retrieval function
-- through the existing current-and-ready filter (Phase 3 D-08): hybrid_search_chunks reads c.status IN ('ready', 'variant'), the profile and
-- legacy match functions c.status = 'ready'; none of them is replaced here.
-- Ledger (research F-15): ingestion_jobs.kind accepts translate (D-29; rag_enqueue_ingestion_job learns it in plan 48), and
-- ingestion_jobs.status accepts pending_review, a terminal status.
-- New columns on documents (languages, ingest_fingerprint, hidden_text_check, scopes, effective_from, effective_to, effective_dates_origin,
-- effective_dates_confidence, approved_by, approved_at) and document_chunks (language_confidence, scopes, effective_from, effective_to,
-- approved_by), named checks added only when absent, a GIN index on document_chunks.scopes and documents (tenant_key, ingest_fingerprint).
-- rag_set_document_fields (body from 0425) accepts the status pending_review (still refuses ready) and the fields languages,
-- ingest_fingerprint and hidden_text_check. rag_write_chunks and rag_write_profile_chunks (bodies from 0424) store language_confidence
-- and copy scopes and effective dates from the document row to every chunk they write.
-- Ledger functions with pending_review added as a terminal or valid status: rag_advance_ingestion_job, rag_claim_ingestion_job,
-- rag_claim_ingestion_jobs, rag_enqueue_ingestion_job, rag_enqueue_backfill_jobs, rag_list_batch_jobs, rag_ingest_job_status_for_stage,
-- rag_ingest_mirror_processing_status, rag_purge_stale_ingestion_jobs and rag_publish_deferred_ingestion_job.
-- Every replaced function keeps its signature, SECURITY mode, SET search_path = '' and schema-qualified names (0425 rule), and the file
-- repeats REVOKE ALL ... FROM PUBLIC, anon, authenticated and GRANT EXECUTE ... TO service_role on each exact signature.
-- Not folded into the setup files. Idempotent and additive: constraints are rebuilt by name, functions use CREATE OR REPLACE.
-- Re-running a migration numbered below 0801 that defines one of the functions replaced here (0425, 0426, 0420, 0359, 0424 and older)
-- puts back that body: re-run this file after it (research Pitfall 9).

BEGIN;

DO $phase32_status_checks$
DECLARE
  v_table text;
  v_attnum smallint;
  v_check text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['documents', 'document_chunks'] LOOP
    SELECT a.attnum INTO v_attnum
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_table) AND a.attname = 'status' AND NOT a.attisdropped;
    FOR v_check IN
      SELECT c.conname FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = pg_catalog.to_regclass('public.' || v_table) AND c.contype = 'c' AND c.conkey = ARRAY[v_attnum]
    LOOP
      EXECUTE pg_catalog.format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_check);
    END LOOP;
  END LOOP;
END
$phase32_status_checks$;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_status_check
  CHECK (status IN ('processing', 'ready', 'quarantined', 'failed', 'deleted', 'pending_review'));

ALTER TABLE public.document_chunks
  ADD CONSTRAINT document_chunks_status_check
  CHECK (status IN ('processing', 'ready', 'variant', 'quarantined', 'failed', 'deleted', 'pending_review'));

ALTER TABLE public.ingestion_jobs DROP CONSTRAINT IF EXISTS ingestion_jobs_kind_check;
ALTER TABLE public.ingestion_jobs
  ADD CONSTRAINT ingestion_jobs_kind_check CHECK (kind IN ('ingest', 'dry_run', 'delete', 'translate'));

ALTER TABLE public.ingestion_jobs DROP CONSTRAINT IF EXISTS ingestion_jobs_status_check;
ALTER TABLE public.ingestion_jobs
  ADD CONSTRAINT ingestion_jobs_status_check CHECK (
    status IN (
      'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
      'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review'
    )
  );

-- New columns (D-10, D-13, D-34, D-37, D-38, D-43). Tags and effective dates are filter columns: rag_set_document_fields does not write
-- them (their own setter functions arrive with plans 41 and 46); the chunk writers copy them from the document row. approved_by and
-- approved_at are stamped at publish (plan 12). None of them is a vector-sync column (0702).
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS languages text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS ingest_fingerprint text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS hidden_text_check text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS effective_to date;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS effective_dates_origin text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS effective_dates_confidence real;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS language_confidence real;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS effective_to date;
ALTER TABLE public.document_chunks ADD COLUMN IF NOT EXISTS approved_by uuid;

DO $phase32_column_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = pg_catalog.to_regclass('public.documents') AND conname = 'documents_hidden_text_check_values') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_hidden_text_check_values
      CHECK (hidden_text_check IS NULL OR hidden_text_check IN ('clean', 'hidden_found', 'not_checked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = pg_catalog.to_regclass('public.documents') AND conname = 'documents_effective_dates_order') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_effective_dates_order
      CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = pg_catalog.to_regclass('public.documents') AND conname = 'documents_effective_dates_origin_values') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_effective_dates_origin_values
      CHECK (effective_dates_origin IS NULL OR effective_dates_origin IN ('extracted', 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = pg_catalog.to_regclass('public.documents') AND conname = 'documents_effective_dates_confidence_range') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_effective_dates_confidence_range
      CHECK (effective_dates_confidence IS NULL OR (effective_dates_confidence >= 0 AND effective_dates_confidence <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = pg_catalog.to_regclass('public.document_chunks') AND conname = 'document_chunks_language_confidence_range') THEN
    ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_language_confidence_range
      CHECK (language_confidence IS NULL OR (language_confidence >= 0 AND language_confidence <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = pg_catalog.to_regclass('public.document_chunks') AND conname = 'document_chunks_effective_dates_order') THEN
    ALTER TABLE public.document_chunks ADD CONSTRAINT document_chunks_effective_dates_order
      CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to);
  END IF;
END
$phase32_column_checks$;

CREATE INDEX IF NOT EXISTS document_chunks_scopes_gin ON public.document_chunks USING gin (scopes);
CREATE INDEX IF NOT EXISTS documents_tenant_fingerprint_idx ON public.documents (tenant_key, ingest_fingerprint);

CREATE OR REPLACE FUNCTION public.rag_set_document_fields(p_document_id uuid, p_tenant_key text, p_fields jsonb)
 RETURNS TABLE(document_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  field_name text;
  allowed text[] := ARRAY[
    'content_hash', 'language', 'doc_date', 'doc_type', 'doc_type_origin', 'parser_used', 'parser_version',
    'processing_profile_id', 'processing_profile_version', 'original_path', 'source_provider', 'source_file_id',
    'source_connection_id', 'status', 'metadata',
    'invoice_number', 'supplier_name', 'supplier_tax_id', 'issue_date', 'gross_total', 'currency',
    'content',
    'languages', 'ingest_fingerprint', 'hidden_text_check'
  ];
  doc public.documents%ROWTYPE;
  issue date;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'invalid_fields: p_fields must be a JSON object';
  END IF;
  FOR field_name IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (field_name = ANY (allowed)) THEN
      RAISE EXCEPTION 'invalid_field: %', field_name;
    END IF;
  END LOOP;
  IF p_fields ? 'status' AND (jsonb_typeof(p_fields -> 'status') <> 'string'
      OR (p_fields ->> 'status') NOT IN ('processing', 'quarantined', 'failed', 'deleted', 'pending_review')) THEN
    RAISE EXCEPTION 'invalid_status: %', p_fields ->> 'status';
  END IF;
  IF p_fields ? 'metadata' AND jsonb_typeof(p_fields -> 'metadata') <> 'object' THEN
    RAISE EXCEPTION 'invalid_metadata: metadata must be a JSON object';
  END IF;

  IF p_fields ? 'languages' THEN
    IF jsonb_typeof(p_fields -> 'languages') <> 'array' THEN
      RAISE EXCEPTION 'invalid_field: languages';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_fields -> 'languages') AS l(value) WHERE jsonb_typeof(l.value) <> 'string') THEN
      RAISE EXCEPTION 'invalid_field: languages';
    END IF;
  END IF;
  IF p_fields ? 'ingest_fingerprint' AND jsonb_typeof(p_fields -> 'ingest_fingerprint') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'invalid_field: ingest_fingerprint';
  END IF;
  IF p_fields ? 'hidden_text_check' AND jsonb_typeof(p_fields -> 'hidden_text_check') <> 'null'
      AND (jsonb_typeof(p_fields -> 'hidden_text_check') <> 'string'
           OR (p_fields ->> 'hidden_text_check') NOT IN ('clean', 'hidden_found', 'not_checked')) THEN
    RAISE EXCEPTION 'invalid_field: hidden_text_check';
  END IF;
  IF p_fields ? 'content' AND jsonb_typeof(p_fields -> 'content') <> 'string' THEN
    RAISE EXCEPTION 'invalid_field: content';
  END IF;
  IF p_fields ? 'invoice_number' AND jsonb_typeof(p_fields -> 'invoice_number') <> 'null'
      AND (jsonb_typeof(p_fields -> 'invoice_number') <> 'string' OR length(p_fields ->> 'invoice_number') > 64) THEN
    RAISE EXCEPTION 'invalid_field: invoice_number';
  END IF;
  IF p_fields ? 'supplier_name' AND jsonb_typeof(p_fields -> 'supplier_name') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_name') <> 'string' OR length(p_fields ->> 'supplier_name') > 300) THEN
    RAISE EXCEPTION 'invalid_field: supplier_name';
  END IF;
  IF p_fields ? 'supplier_tax_id' AND jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'null'
      AND (jsonb_typeof(p_fields -> 'supplier_tax_id') <> 'string' OR length(p_fields ->> 'supplier_tax_id') > 64) THEN
    RAISE EXCEPTION 'invalid_field: supplier_tax_id';
  END IF;
  IF p_fields ? 'currency' AND jsonb_typeof(p_fields -> 'currency') <> 'null'
      AND (jsonb_typeof(p_fields -> 'currency') <> 'string' OR (p_fields ->> 'currency') !~ '^[A-Z]{3}$') THEN
    RAISE EXCEPTION 'invalid_field: currency';
  END IF;
  IF p_fields ? 'gross_total' AND jsonb_typeof(p_fields -> 'gross_total') <> 'null'
      AND (jsonb_typeof(p_fields -> 'gross_total') <> 'string' OR (p_fields ->> 'gross_total') !~ '^-?[0-9]{1,16}(\.[0-9]{1,4})?$') THEN
    RAISE EXCEPTION 'invalid_field: gross_total';
  END IF;
  IF p_fields ? 'issue_date' AND jsonb_typeof(p_fields -> 'issue_date') <> 'null' THEN
    IF jsonb_typeof(p_fields -> 'issue_date') <> 'string' OR (p_fields ->> 'issue_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END IF;
    BEGIN
      issue := (p_fields ->> 'issue_date')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_field: issue_date';
    END;
  END IF;

  UPDATE public.documents d SET
    content_hash = CASE WHEN p_fields ? 'content_hash' THEN p_fields ->> 'content_hash' ELSE d.content_hash END,
    language = CASE WHEN p_fields ? 'language' THEN p_fields ->> 'language' ELSE d.language END,
    doc_date = CASE WHEN p_fields ? 'doc_date' THEN (p_fields ->> 'doc_date')::date ELSE d.doc_date END,
    doc_type = CASE WHEN p_fields ? 'doc_type' THEN p_fields ->> 'doc_type' ELSE d.doc_type END,
    doc_type_origin = CASE WHEN p_fields ? 'doc_type_origin' THEN p_fields ->> 'doc_type_origin' ELSE d.doc_type_origin END,
    parser_used = CASE WHEN p_fields ? 'parser_used' THEN p_fields ->> 'parser_used' ELSE d.parser_used END,
    parser_version = CASE WHEN p_fields ? 'parser_version' THEN p_fields ->> 'parser_version' ELSE d.parser_version END,
    processing_profile_id = CASE WHEN p_fields ? 'processing_profile_id' THEN p_fields ->> 'processing_profile_id' ELSE d.processing_profile_id END,
    processing_profile_version = CASE WHEN p_fields ? 'processing_profile_version' THEN (p_fields ->> 'processing_profile_version')::integer ELSE d.processing_profile_version END,
    original_path = CASE WHEN p_fields ? 'original_path' THEN p_fields ->> 'original_path' ELSE d.original_path END,
    source_provider = CASE WHEN p_fields ? 'source_provider' THEN p_fields ->> 'source_provider' ELSE d.source_provider END,
    source_file_id = CASE WHEN p_fields ? 'source_file_id' THEN p_fields ->> 'source_file_id' ELSE d.source_file_id END,
    source_connection_id = CASE WHEN p_fields ? 'source_connection_id' THEN p_fields ->> 'source_connection_id' ELSE d.source_connection_id END,
    status = CASE WHEN p_fields ? 'status' THEN p_fields ->> 'status' ELSE d.status END,
    metadata = CASE WHEN p_fields ? 'metadata' THEN COALESCE(d.metadata, '{}'::jsonb) || (p_fields -> 'metadata') ELSE d.metadata END,
    invoice_number = CASE WHEN p_fields ? 'invoice_number' THEN p_fields ->> 'invoice_number' ELSE d.invoice_number END,
    supplier_name = CASE WHEN p_fields ? 'supplier_name' THEN p_fields ->> 'supplier_name' ELSE d.supplier_name END,
    supplier_tax_id = CASE WHEN p_fields ? 'supplier_tax_id' THEN p_fields ->> 'supplier_tax_id' ELSE d.supplier_tax_id END,
    issue_date = CASE WHEN p_fields ? 'issue_date' THEN (p_fields ->> 'issue_date')::date ELSE d.issue_date END,
    gross_total = CASE WHEN p_fields ? 'gross_total' THEN (p_fields ->> 'gross_total')::numeric(20, 4) ELSE d.gross_total END,
    currency = CASE WHEN p_fields ? 'currency' THEN p_fields ->> 'currency' ELSE d.currency END,
    content = CASE WHEN p_fields ? 'content' THEN p_fields ->> 'content' ELSE d.content END,
    languages = CASE WHEN p_fields ? 'languages' THEN ARRAY(SELECT jsonb_array_elements_text(p_fields -> 'languages')) ELSE d.languages END,
    ingest_fingerprint = CASE WHEN p_fields ? 'ingest_fingerprint' THEN p_fields ->> 'ingest_fingerprint' ELSE d.ingest_fingerprint END,
    hidden_text_check = CASE WHEN p_fields ? 'hidden_text_check' THEN p_fields ->> 'hidden_text_check' ELSE d.hidden_text_check END
  WHERE d.id = p_document_id;

  IF p_fields ?| ARRAY['doc_type', 'doc_date', 'language', 'parser_used', 'status'] THEN
    UPDATE public.document_chunks c SET
      doc_type = d.doc_type,
      doc_date = d.doc_date,
      language = d.language,
      parser_used = d.parser_used,
      status = d.status,
      metadata = COALESCE(c.metadata, '{}'::jsonb)
        || jsonb_build_object('doc_type', d.doc_type, 'language', d.language, 'parser_used', d.parser_used)
    FROM public.documents d
    WHERE d.id = p_document_id AND c.document_id = d.id;
  END IF;

  RETURN QUERY SELECT d.id, d.status FROM public.documents d WHERE d.id = p_document_id;
END
$function$;

-- Chunk writers, bodies from 0424: the optional chunk key language_confidence is stored, and scopes, effective_from and effective_to
-- are copied from the document row selected at the top of the call. Every other column is written exactly as in 0424.
CREATE OR REPLACE FUNCTION public.rag_write_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_chunks jsonb,
  p_embeddings jsonb,
  p_final boolean,
  p_total integer
)
RETURNS TABLE (chunks_written integer, chunks_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc public.documents%ROWTYPE;
  profile_key text;
  profile_row public.embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  chunk_count integer;
  legacy_vectors jsonb;
  written integer := 0;
  deleted integer := 0;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_chunks IS NULL OR jsonb_typeof(p_chunks) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_chunks must be a JSON array';
  END IF;
  chunk_count := jsonb_array_length(p_chunks);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every chunk needs a string content and a numeric chunk_index when it has one';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_chunks) AS e(value)
    WHERE e.value ? 'language_confidence' AND jsonb_typeof(e.value -> 'language_confidence') NOT IN ('number', 'null')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: language_confidence must be a number when a chunk has it';
  END IF;
  IF (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
      FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)) <> chunk_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct';
  END IF;
  IF p_final AND (p_total IS NULL OR p_total < 0) THEN
    RAISE EXCEPTION 'invalid_total: p_total is required with p_final';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF COALESCE(CASE WHEN jsonb_typeof(vectors) = 'array' THEN jsonb_array_length(vectors) END, -1) <> chunk_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', chunk_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE CASE WHEN jsonb_typeof(v.value) = 'array' THEN jsonb_array_length(v.value) END <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  -- A chunk whose text changed must not keep a vector made from the old text.
  DELETE FROM public.chunk_embeddings ce
  USING public.document_chunks c, jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      (e.ord - 1)::integer AS position,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::public.vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text,
      (e.value ->> 'language_confidence')::real AS language_confidence
    FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO public.document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text, language_confidence, scopes, effective_from, effective_to
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text,
    p.language_confidence,
    doc.scopes,
    doc.effective_from,
    doc.effective_to
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text,
    language_confidence = EXCLUDED.language_confidence,
    scopes = EXCLUDED.scopes,
    effective_from = EXCLUDED.effective_from,
    effective_to = EXCLUDED.effective_to
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS written = ROW_COUNT;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::public.halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM public.embedding_backfill_gaps g
      USING jsonb_array_elements(p_chunks) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    DELETE FROM public.document_chunks c WHERE c.document_id = p_document_id AND c.chunking_profile_id = 'legacy' AND c.chunk_index >= p_total;
    GET DIAGNOSTICS deleted = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT written, deleted;
END
$$;

CREATE OR REPLACE FUNCTION public.rag_write_profile_chunks(
  p_document_id uuid,
  p_tenant_key text,
  p_profile_id text,
  p_parents jsonb,
  p_children jsonb,
  p_embeddings jsonb,
  p_final boolean DEFAULT true,
  p_total integer DEFAULT NULL
)
RETURNS TABLE (parents_written integer, children_written integer, parents_deleted integer, children_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  legacy_profile constant text := 'openai-3-small-1536';
  doc public.documents%ROWTYPE;
  chunking public.chunking_profiles%ROWTYPE;
  parents jsonb := COALESCE(p_parents, '[]'::jsonb);
  profile_key text;
  profile_row public.embedding_profiles%ROWTYPE;
  payload jsonb;
  vectors jsonb;
  host_name text;
  parent_count integer;
  child_count integer;
  legacy_vectors jsonb;
  total integer;
  parents_in integer := 0;
  children_in integer := 0;
  parents_out integer := 0;
  children_out integer := 0;
BEGIN
  SELECT * INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING DETAIL = 'document not found in tenant';
  END IF;
  IF doc.status IN ('failed', 'deleted') THEN
    RAISE EXCEPTION 'document_not_writable' USING DETAIL = 'status is ' || doc.status;
  END IF;
  IF p_profile_id IS NULL OR p_profile_id = 'legacy' THEN
    RAISE EXCEPTION 'invalid_profile' USING DETAIL = 'legacy chunks are written by rag_write_chunks';
  END IF;
  SELECT * INTO chunking FROM public.chunking_profiles cp WHERE cp.id = p_profile_id AND cp.doc_type = doc.doc_type AND cp.status <> 'retired';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chunking_profile_unsupported' USING DETAIL = 'no live profile of this id for the document type';
  END IF;

  IF jsonb_typeof(parents) <> 'array' THEN
    RAISE EXCEPTION 'invalid_parents: p_parents must be a JSON array';
  END IF;
  IF p_children IS NULL OR jsonb_typeof(p_children) <> 'array' THEN
    RAISE EXCEPTION 'invalid_chunks: p_children must be a JSON array';
  END IF;
  parent_count := jsonb_array_length(parents);
  child_count := jsonb_array_length(p_children);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e.value -> 'parent_index') IS DISTINCT FROM 'number'
       OR jsonb_typeof(e.value -> 'token_count') IS DISTINCT FROM 'number'
       OR (e.value ? 'section_path' AND jsonb_typeof(e.value -> 'section_path') <> 'array')
  ) THEN
    RAISE EXCEPTION 'invalid_parents: every parent needs a string content, a numeric parent_index and a numeric token_count';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(parents) AS e(value)
    WHERE (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$' OR (e.value ->> 'token_count') !~ '^[0-9]{1,9}$'
  ) OR (SELECT count(DISTINCT (e.value ->> 'parent_index')::integer) FROM jsonb_array_elements(parents) AS e(value)) <> parent_count THEN
    RAISE EXCEPTION 'invalid_parents: parent_index values must be distinct non-negative integers and token_count a non-negative integer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value) <> 'object'
       OR jsonb_typeof(e.value -> 'content') IS DISTINCT FROM 'string'
       OR (e.value ? 'chunk_index' AND jsonb_typeof(e.value -> 'chunk_index') <> 'number')
       OR (e.value ? 'parent_index' AND jsonb_typeof(e.value -> 'parent_index') NOT IN ('number', 'null'))
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: every child needs a string content, and a numeric chunk_index and parent_index when it has them';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE e.value ? 'language_confidence' AND jsonb_typeof(e.value -> 'language_confidence') NOT IN ('number', 'null')
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: language_confidence must be a number when a child has it';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
    WHERE COALESCE(e.value ->> 'chunk_index', (e.ord - 1)::text) !~ '^[0-9]{1,9}$'
       OR (jsonb_typeof(e.value -> 'parent_index') = 'number' AND (e.value ->> 'parent_index') !~ '^[0-9]{1,9}$')
  ) OR (SELECT count(DISTINCT COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer))
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)) <> child_count THEN
    RAISE EXCEPTION 'invalid_chunk: chunk_index values must be distinct non-negative integers';
  END IF;
  IF p_final AND p_total IS NOT NULL AND p_total < 0 THEN
    RAISE EXCEPTION 'invalid_total: p_total must not be negative';
  END IF;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'invalid_embeddings: p_embeddings must be a JSON object keyed by profile id';
  END IF;
  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      IF NOT FOUND OR (profile_row.storage = 'legacy_column' AND profile_row.id <> legacy_profile) THEN
        RAISE EXCEPTION 'embedding_profile_unsupported: %', profile_key;
      END IF;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        IF jsonb_typeof(payload -> 'host') NOT IN ('string', 'null') THEN
          RAISE EXCEPTION 'invalid_embeddings: host must be a string';
        END IF;
      ELSE
        vectors := payload;
      END IF;
      IF COALESCE(CASE WHEN jsonb_typeof(vectors) = 'array' THEN jsonb_array_length(vectors) END, -1) <> child_count THEN
        RAISE EXCEPTION 'embedding_count_mismatch: expected % vectors', child_count;
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(vectors) AS v(value) WHERE jsonb_typeof(v.value) NOT IN ('array', 'null')) THEN
        RAISE EXCEPTION 'invalid_embeddings: every vector must be a JSON array or null';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(vectors) AS v(value)
        WHERE CASE WHEN jsonb_typeof(v.value) = 'array' THEN jsonb_array_length(v.value) END <> profile_row.dims
      ) THEN
        RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
      END IF;
      IF profile_row.id = legacy_profile THEN
        legacy_vectors := vectors;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.document_parents AS dp (
    id, document_id, tenant_key, organization_id, version, is_current, chunking_profile_id, section_path, content, token_count, parent_index
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    doc.tenant_key,
    doc.organization_id,
    doc.version,
    true,
    p_profile_id,
    CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END,
    e.value ->> 'content',
    (e.value ->> 'token_count')::integer,
    (e.value ->> 'parent_index')::integer
  FROM jsonb_array_elements(parents) AS e(value)
  ON CONFLICT (id) DO UPDATE SET
    tenant_key = EXCLUDED.tenant_key,
    organization_id = EXCLUDED.organization_id,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    chunking_profile_id = EXCLUDED.chunking_profile_id,
    section_path = EXCLUDED.section_path,
    content = EXCLUDED.content,
    token_count = EXCLUDED.token_count,
    parent_index = EXCLUDED.parent_index
  WHERE dp.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS parents_in = ROW_COUNT;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_children) AS e(value)
    WHERE jsonb_typeof(e.value -> 'parent_index') = 'number'
      AND NOT EXISTS (
        SELECT 1 FROM public.document_parents dp
        WHERE dp.id = substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
          AND dp.document_id = p_document_id
          AND dp.chunking_profile_id = p_profile_id
      )
  ) THEN
    RAISE EXCEPTION 'invalid_chunk: parent_index names a parent that was not written';
  END IF;

  -- A child whose text changed must not keep a vector made from the old text.
  DELETE FROM public.chunk_embeddings ce
  USING public.document_chunks c, jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  WHERE ce.chunk_id = c.id
    AND c.document_id = p_document_id
    AND c.chunking_profile_id = p_profile_id
    AND c.id = substr(encode(sha256(convert_to(
          p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid
    AND c.content IS DISTINCT FROM (e.value ->> 'content');

  WITH prepared AS (
    SELECT
      e.value AS spec,
      COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer) AS chunk_index,
      CASE WHEN jsonb_typeof(e.value -> 'parent_index') = 'number'
           THEN substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':parent:' || (e.value ->> 'parent_index'), 'UTF8')), 'hex'), 1, 32)::uuid
      END AS parent_id,
      CASE WHEN legacy_vectors IS NOT NULL AND jsonb_typeof(legacy_vectors -> (e.ord - 1)::integer) = 'array'
           THEN ((legacy_vectors -> (e.ord - 1)::integer)::text)::public.vector END AS embedding,
      CASE WHEN jsonb_typeof(e.value -> 'section_path') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(e.value -> 'section_path')) ELSE '{}'::text[] END AS section_path,
      COALESCE(e.value ->> 'chunk_kind', 'text') AS chunk_kind,
      COALESCE((e.value ->> 'embedding_text_version')::integer, 0) AS embedding_text_version,
      (e.value ->> 'page_start')::integer AS page_start,
      (e.value ->> 'page_end')::integer AS page_end,
      e.value ->> 'content_hash' AS content_hash,
      e.value ->> 'lexical_text' AS lexical_text,
      (e.value ->> 'language_confidence')::real AS language_confidence
    FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
  )
  INSERT INTO public.document_chunks AS dc (
    id, document_id, content, embedding, chunk_index, metadata, organization_id, tenant_key, version, is_current, status,
    doc_type, doc_date, language, source, page_start, page_end, section_path, content_hash, chunk_kind, parser_used,
    embedding_text_version, lexical_text, parent_id, chunking_profile_id, language_confidence, scopes, effective_from, effective_to
  )
  SELECT
    substr(encode(sha256(convert_to(p_document_id::text || ':' || p_profile_id || ':child:' || p.chunk_index::text, 'UTF8')), 'hex'), 1, 32)::uuid,
    p_document_id,
    p.spec ->> 'content',
    p.embedding,
    p.chunk_index,
    (CASE WHEN jsonb_typeof(p.spec -> 'metadata') = 'object' THEN p.spec -> 'metadata' ELSE '{}'::jsonb END)
      || jsonb_build_object(
        'chunk_index', p.chunk_index,
        'section_path', to_jsonb(p.section_path),
        'doc_type', doc.doc_type,
        'language', doc.language,
        'content_hash', p.content_hash,
        'chunk_kind', p.chunk_kind,
        'parser_used', doc.parser_used,
        'embedding_text_version', p.embedding_text_version,
        'chunking_profile_id', p_profile_id)
      || CASE WHEN p.embedding IS NOT NULL
              THEN jsonb_build_object('embedding_model', 'text-embedding-3-small', 'embedding_dims', 1536) ELSE '{}'::jsonb END
      || jsonb_strip_nulls(jsonb_build_object('doc_date', doc.doc_date, 'source', doc.source, 'page_start', p.page_start, 'page_end', p.page_end)),
    doc.organization_id,
    doc.tenant_key,
    doc.version,
    doc.is_current,
    doc.status,
    doc.doc_type,
    doc.doc_date,
    doc.language,
    doc.source,
    p.page_start,
    p.page_end,
    p.section_path,
    p.content_hash,
    p.chunk_kind,
    doc.parser_used,
    p.embedding_text_version,
    p.lexical_text,
    p.parent_id,
    p_profile_id,
    p.language_confidence,
    doc.scopes,
    doc.effective_from,
    doc.effective_to
  FROM prepared p
  ON CONFLICT (id) DO UPDATE SET
    content = EXCLUDED.content,
    embedding = EXCLUDED.embedding,
    chunk_index = EXCLUDED.chunk_index,
    metadata = EXCLUDED.metadata,
    organization_id = EXCLUDED.organization_id,
    tenant_key = EXCLUDED.tenant_key,
    version = EXCLUDED.version,
    is_current = EXCLUDED.is_current,
    status = EXCLUDED.status,
    doc_type = EXCLUDED.doc_type,
    doc_date = EXCLUDED.doc_date,
    language = EXCLUDED.language,
    source = EXCLUDED.source,
    page_start = EXCLUDED.page_start,
    page_end = EXCLUDED.page_end,
    section_path = EXCLUDED.section_path,
    content_hash = EXCLUDED.content_hash,
    chunk_kind = EXCLUDED.chunk_kind,
    parser_used = EXCLUDED.parser_used,
    embedding_text_version = EXCLUDED.embedding_text_version,
    lexical_text = EXCLUDED.lexical_text,
    parent_id = EXCLUDED.parent_id,
    chunking_profile_id = EXCLUDED.chunking_profile_id,
    language_confidence = EXCLUDED.language_confidence,
    scopes = EXCLUDED.scopes,
    effective_from = EXCLUDED.effective_from,
    effective_to = EXCLUDED.effective_to
  WHERE dc.document_id = EXCLUDED.document_id;
  GET DIAGNOSTICS children_in = ROW_COUNT;

  IF p_embeddings IS NOT NULL AND jsonb_typeof(p_embeddings) = 'object' THEN
    FOR profile_key IN SELECT jsonb_object_keys(p_embeddings) LOOP
      SELECT * INTO profile_row FROM public.embedding_profiles p WHERE p.id = profile_key;
      payload := p_embeddings -> profile_key;
      IF jsonb_typeof(payload) = 'object' THEN
        vectors := payload -> 'vectors';
        host_name := payload ->> 'host';
      ELSE
        vectors := payload;
        host_name := NULL;
      END IF;

      IF profile_row.storage <> 'legacy_column' THEN
        INSERT INTO public.chunk_embeddings AS ce (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
        SELECT
          substr(encode(sha256(convert_to(
            p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid,
          profile_row.id,
          doc.tenant_key,
          (v.value::text)::public.halfvec,
          profile_row.model,
          profile_row.dims,
          host_name
        FROM jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord)
        JOIN jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord) ON v.ord = e.ord
        WHERE jsonb_typeof(v.value) = 'array'
        ON CONFLICT (chunk_id, profile_id) DO UPDATE SET
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model,
          dims = EXCLUDED.dims,
          embedding_host = EXCLUDED.embedding_host,
          embedded_at = now();
      END IF;

      DELETE FROM public.embedding_backfill_gaps g
      USING jsonb_array_elements(p_children) WITH ORDINALITY AS e(value, ord),
            jsonb_array_elements(vectors) WITH ORDINALITY AS v(value, ord)
      WHERE v.ord = e.ord
        AND jsonb_typeof(v.value) = 'array'
        AND g.profile_id = profile_row.id
        AND g.chunk_id = substr(encode(sha256(convert_to(
              p_document_id::text || ':' || p_profile_id || ':child:' || COALESCE((e.value ->> 'chunk_index')::integer, (e.ord - 1)::integer)::text, 'UTF8')), 'hex'), 1, 32)::uuid;
    END LOOP;
  END IF;

  IF p_final THEN
    total := COALESCE(p_total, child_count);
    DELETE FROM public.document_chunks c
    WHERE c.document_id = p_document_id AND c.chunking_profile_id = p_profile_id AND c.chunk_index >= total;
    GET DIAGNOSTICS children_out = ROW_COUNT;
    DELETE FROM public.document_parents dp
    WHERE dp.document_id = p_document_id
      AND dp.chunking_profile_id = p_profile_id
      AND NOT EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.parent_id = dp.id);
    GET DIAGNOSTICS parents_out = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT parents_in, children_in, parents_out, children_out;
END
$$;

-- Ledger functions (research F-15). Each body is its newest on trunk (0426 for rag_advance_ingestion_job, 0420 for
-- rag_purge_stale_ingestion_jobs, 0359 for rag_publish_deferred_ingestion_job, 0425 for the rest) with pending_review added to its terminal
-- or valid status list and nothing else changed: claims never pick a pending_review job (nor reclaim its lease), advance accepts the
-- pending_review stage and status as terminal and clears the lease, so the job cannot be advanced, failed or dead-lettered again; retry
-- (rag_retry_ingestion_job, 0422) already refuses every status but failed and needs_review and is not replaced. The processing_status
-- mirror of pending_review is ready: processing is finished and the hold is the document status (plan 12).

CREATE OR REPLACE FUNCTION public.rag_advance_ingestion_job(p_job_id uuid, p_worker text, p_stage text, p_status text, p_stage_state jsonb DEFAULT NULL::jsonb, p_timing_ms integer DEFAULT NULL::integer, p_fields jsonb DEFAULT '{}'::jsonb)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_expected text;
  v_timings jsonb;
  v_key text;
  v_value jsonb;
  v_whitelist text[] := ARRAY[
    'doc_class', 'tier', 'parser_used', 'parser_version', 'pages', 'page_ranges',
    'tier_page_counts', 'detect_counts', 'preflight_ref', 'est_cost_usd', 'embedding_profile',
    'document_id', 'needs_review_reason', 'routing_note', 'provisional_published_at', 'trace_id'
  ];
  v_terminal boolean;
  v_mirror text;
BEGIN
  IF p_stage IS NULL OR btrim(p_stage) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  v_expected := public.rag_ingest_job_status_for_stage(p_stage);
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: invalid_stage' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status <> v_expected THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status_for_stage' USING ERRCODE = '22023';
  END IF;
  IF p_fields IS NOT NULL AND jsonb_typeof(p_fields) = 'object' THEN
    FOR v_key IN SELECT jsonb_object_keys(p_fields)
    LOOP
      IF NOT (v_key = ANY (v_whitelist)) THEN
        RAISE EXCEPTION 'ingest_refused: field_not_allowed' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO v_job FROM public.ingestion_jobs WHERE id = p_job_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.rag_ingest_assert_job_lease(v_job, p_worker);

  v_timings := COALESCE(v_job.timings, '{}'::jsonb);
  IF p_timing_ms IS NOT NULL AND p_stage IS NOT NULL THEN
    v_timings := v_timings || jsonb_build_object(
      p_stage,
      COALESCE((v_timings ->> p_stage)::bigint, 0) + p_timing_ms
    );
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = p_status,
         stage = p_stage,
         timings = v_timings,
         stage_state = CASE WHEN p_stage_state IS NOT NULL THEN p_stage_state ELSE j.stage_state END,
         doc_class = COALESCE(p_fields ->> 'doc_class', j.doc_class),
         tier = COALESCE(p_fields ->> 'tier', j.tier),
         parser_used = COALESCE(p_fields ->> 'parser_used', j.parser_used),
         parser_version = COALESCE(p_fields ->> 'parser_version', j.parser_version),
         pages = COALESCE((p_fields ->> 'pages')::integer, j.pages),
         page_ranges = CASE WHEN p_fields ? 'page_ranges' THEN p_fields -> 'page_ranges' ELSE j.page_ranges END,
         tier_page_counts = CASE WHEN p_fields ? 'tier_page_counts' THEN p_fields -> 'tier_page_counts' ELSE j.tier_page_counts END,
         detect_counts = CASE WHEN p_fields ? 'detect_counts' THEN p_fields -> 'detect_counts' ELSE j.detect_counts END,
         preflight_ref = COALESCE(p_fields ->> 'preflight_ref', j.preflight_ref),
         est_cost_usd = COALESCE((p_fields ->> 'est_cost_usd')::numeric, j.est_cost_usd),
         embedding_profile = COALESCE(p_fields ->> 'embedding_profile', j.embedding_profile),
         document_id = CASE
           WHEN j.document_id IS NULL AND p_fields ? 'document_id'
           THEN (p_fields ->> 'document_id')::uuid
           ELSE j.document_id
         END,
         needs_review_reason = COALESCE(p_fields ->> 'needs_review_reason', j.needs_review_reason),
         routing_note = COALESCE(p_fields ->> 'routing_note', j.routing_note),
         provisional_published_at = CASE
           WHEN p_fields ? 'provisional_published_at'
           THEN (p_fields ->> 'provisional_published_at')::timestamptz
           ELSE j.provisional_published_at
         END,
         trace_id = CASE WHEN p_fields ? 'trace_id' THEN (p_fields ->> 'trace_id')::uuid ELSE j.trace_id END,
         updated_at = now()
   WHERE j.id = p_job_id
   RETURNING j.* INTO v_job;

  v_terminal := p_status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review');
  IF v_terminal THEN
    PERFORM public.rag_release_job_reservations(p_job_id);
    UPDATE public.ingestion_jobs
       SET locked_by = NULL, lease_until = NULL, runner = NULL
     WHERE id = p_job_id
     RETURNING * INTO v_job;
  END IF;

  IF v_job.document_id IS NOT NULL THEN
    v_mirror := public.rag_ingest_mirror_processing_status(v_job.status);
    IF v_mirror IS NOT NULL THEN
      UPDATE public.documents d
         SET processing_status = v_mirror
       WHERE d.id = v_job.document_id
         AND d.tenant_key = v_job.tenant_key;
    END IF;
    IF p_status = 'ready' THEN
      UPDATE public.documents d SET status = 'ready' WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    ELSIF p_status = 'failed' THEN
      UPDATE public.documents d
         SET status = 'failed', processing_status = 'failed'
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'quarantined' THEN
      UPDATE public.documents d
         SET status = CASE WHEN d.status = 'quarantined' THEN 'quarantined' ELSE 'failed' END,
             processing_status = CASE WHEN d.status = 'quarantined' THEN 'quarantined' ELSE 'failed' END
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key AND NOT d.is_current;
    ELSIF p_status = 'needs_review' THEN
      UPDATE public.documents d
         SET status = 'ready',
             needs_review = true,
             needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
       WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key;
    END IF;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_job(p_job_id uuid, p_worker text, p_runner text DEFAULT 'worker'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
BEGIN
  SELECT j.* INTO v_job
    FROM public.ingestion_jobs j
   WHERE j.id = p_job_id
     AND j.deleted_at IS NULL
     AND j.kind IN ('ingest', 'dry_run')
     AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
     AND (
       (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
       OR (
         j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
         AND j.lease_until IS NOT NULL
         AND j.lease_until < now()
       )
     )
   FOR UPDATE OF j SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
    RETURN NULL;
  END IF;

  IF v_job.locked_by IS NOT NULL AND v_job.lease_until IS NOT NULL AND v_job.lease_until > now() THEN
    RETURN NULL;
  END IF;

  IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
    v_new_retries := v_job.retries + 1;
    IF v_new_retries > v_job.max_retries THEN
      PERFORM public.rag_release_job_reservations(v_job.id);
      UPDATE public.ingestion_jobs
         SET status = 'failed',
             error_class = 'lease_expired',
             error = 'lease expired',
             dead_letter_at = now(),
             retries = v_new_retries,
             locked_by = NULL,
             lease_until = NULL,
             runner = NULL,
             updated_at = now()
       WHERE id = v_job.id;
      RETURN NULL;
    END IF;
    PERFORM public.rag_release_job_reservations(v_job.id);
  END IF;

  UPDATE public.ingestion_jobs j
     SET status = CASE
           WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
           ELSE j.status
         END,
         retries = CASE
           WHEN j.status = 'queued' THEN j.retries
           ELSE j.retries + 1
         END,
         locked_by = p_worker,
         runner = p_runner,
         lease_until = now() + interval '120 seconds',
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_claim_ingestion_jobs(p_worker text, p_limit integer, p_allow_batch boolean, p_runner text DEFAULT 'worker'::text)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed integer := 0;
  v_job public.ingestion_jobs%ROWTYPE;
  v_new_retries integer;
  v_limit integer;
BEGIN
  v_limit := GREATEST(COALESCE(p_limit, 0), 0);
  IF v_limit < 1 THEN
    RETURN;
  END IF;

  WHILE v_claimed < v_limit LOOP
    SELECT j.* INTO v_job
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.kind IN ('ingest', 'dry_run')
       AND j.status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
       AND (p_allow_batch OR j.batch_id IS NULL)
       AND (
         (j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= now()))
         OR (
           j.status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < now()
         )
       )
       AND (j.batch_id IS NULL OR public.rag_batch_has_room(j.batch_id))
     ORDER BY j.priority DESC, j.created_at
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      EXIT;
    END IF;

    IF v_job.batch_id IS NOT NULL AND NOT public.rag_batch_has_room(v_job.batch_id) THEN
      CONTINUE;
    END IF;

    IF v_job.status <> 'queued' AND v_job.lease_until IS NOT NULL AND v_job.lease_until < now() THEN
      v_new_retries := v_job.retries + 1;
      IF v_new_retries > v_job.max_retries THEN
        PERFORM public.rag_release_job_reservations(v_job.id);
        UPDATE public.ingestion_jobs
           SET status = 'failed',
               error_class = 'lease_expired',
               error = 'lease expired',
               dead_letter_at = now(),
               retries = v_new_retries,
               locked_by = NULL,
               lease_until = NULL,
               runner = NULL,
               updated_at = now()
         WHERE id = v_job.id;
        CONTINUE;
      END IF;
      PERFORM public.rag_release_job_reservations(v_job.id);
    END IF;

    UPDATE public.ingestion_jobs j
       SET status = CASE
             WHEN j.status = 'queued' THEN COALESCE(NULLIF(j.stage, ''), 'preflight')
             ELSE j.status
           END,
           retries = CASE
             WHEN j.status = 'queued' THEN j.retries
             ELSE j.retries + 1
           END,
           locked_by = p_worker,
           runner = p_runner,
           lease_until = now() + interval '120 seconds',
           updated_at = now()
     WHERE j.id = v_job.id
     RETURNING j.* INTO v_job;

    v_claimed := v_claimed + 1;
    RETURN NEXT v_job;
  END LOOP;

  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_enqueue_backfill_jobs(p_batch_id uuid, p_jobs jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tenant text;
  v_job jsonb;
  v_kind text;
  v_status text;
  v_inserted integer := 0;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  SELECT b.tenant_key INTO v_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backfill_refused: batch_not_found' USING ERRCODE = '22023';
  END IF;

  IF p_jobs IS NULL OR jsonb_typeof(p_jobs) <> 'array' THEN
  RAISE EXCEPTION 'backfill_refused: jobs_must_be_array' USING ERRCODE = '22023';
  END IF;

  FOR v_job IN SELECT value FROM jsonb_array_elements(p_jobs) AS e(value) LOOP
    IF jsonb_typeof(v_job) <> 'object' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_job_object' USING ERRCODE = '22023';
    END IF;

    v_kind := v_job ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('ingest', 'dry_run') THEN
      RAISE EXCEPTION 'backfill_refused: invalid_kind' USING ERRCODE = '22023';
    END IF;
    IF v_job ->> 'source_key' IS NULL OR btrim(v_job ->> 'source_key') = '' THEN
      RAISE EXCEPTION 'backfill_refused: invalid_source_key' USING ERRCODE = '22023';
    END IF;

    v_status := COALESCE(v_job ->> 'status', 'queued');
    IF v_status NOT IN (
      'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
      'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review'
    ) THEN
      RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.ingestion_jobs (
      tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
      original_ref, settings, priority, batch_id, document_id
    ) VALUES (
      v_tenant,
      v_kind,
      v_status,
      NULLIF(v_job ->> 'source', ''),
      v_job ->> 'source_key',
      NULLIF(v_job ->> 'file_sha256', ''),
      NULLIF(v_job ->> 'filename', ''),
      NULLIF(v_job ->> 'mime_type', ''),
      CASE WHEN v_job ? 'original_ref' THEN v_job -> 'original_ref' ELSE NULL END,
      COALESCE(v_job -> 'settings', '{}'::jsonb),
      10,
      p_batch_id,
      NULL
    )
    ON CONFLICT (batch_id, kind, source_key) WHERE batch_id IS NOT NULL DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_enqueue_ingestion_job(p_tenant_key text, p_kind text DEFAULT 'ingest'::text, p_source text DEFAULT NULL::text, p_source_key text DEFAULT NULL::text, p_file_sha256 text DEFAULT NULL::text, p_filename text DEFAULT NULL::text, p_mime_type text DEFAULT NULL::text, p_original_ref jsonb DEFAULT NULL::jsonb, p_settings jsonb DEFAULT '{}'::jsonb, p_priority integer DEFAULT 100, p_document_id uuid DEFAULT NULL::uuid, p_batch_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'queued'::text)
 RETURNS public.ingestion_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_doc_tenant text;
  v_batch_tenant text;
  v_row public.ingestion_jobs%ROWTYPE;
BEGIN
  PERFORM public.rag_ingest_assert_tenant_key(p_tenant_key);

  IF p_kind IS NULL OR p_kind NOT IN ('ingest', 'dry_run', 'delete') THEN
    RAISE EXCEPTION 'ingest_refused: invalid_kind' USING ERRCODE = '22023';
  END IF;
  IF p_source_key IS NULL OR btrim(p_source_key) = '' THEN
    RAISE EXCEPTION 'ingest_refused: invalid_source_key' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review'
  ) THEN
    RAISE EXCEPTION 'ingest_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT d.tenant_key INTO v_doc_tenant FROM public.documents d WHERE d.id = p_document_id;
    IF NOT FOUND OR v_doc_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: document_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT b.tenant_key INTO v_batch_tenant FROM public.ingestion_batches b WHERE b.id = p_batch_id;
    IF NOT FOUND OR v_batch_tenant IS DISTINCT FROM p_tenant_key THEN
      RAISE EXCEPTION 'ingest_refused: batch_tenant_mismatch' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.ingestion_jobs (
    tenant_key, kind, status, source, source_key, file_sha256, filename, mime_type,
    original_ref, settings, priority, document_id, batch_id
  ) VALUES (
    p_tenant_key, p_kind, p_status, p_source, p_source_key, p_file_sha256, p_filename, p_mime_type,
    p_original_ref, COALESCE(p_settings, '{}'::jsonb), COALESCE(p_priority, 100), p_document_id, p_batch_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_list_batch_jobs(p_batch_id uuid, p_status text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS SETOF public.ingestion_jobs
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_after_created_at timestamptz;
  v_after_id uuid;
  v_limit integer;
BEGIN
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'backfill_refused: invalid_batch' USING ERRCODE = '22023';
  END IF;

  v_limit := GREATEST(LEAST(COALESCE(p_limit, 100), 1000), 1);

  IF p_status IS NOT NULL AND p_status NOT IN (
    'queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding',
    'ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review'
  ) THEN
    RAISE EXCEPTION 'backfill_refused: invalid_status' USING ERRCODE = '22023';
  END IF;

  IF p_after_id IS NOT NULL THEN
    SELECT j.created_at, j.id INTO v_after_created_at, v_after_id
      FROM public.ingestion_jobs j
     WHERE j.id = p_after_id AND j.batch_id = p_batch_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backfill_refused: invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN QUERY
  SELECT j.*
    FROM public.ingestion_jobs j
   WHERE j.batch_id = p_batch_id
     AND j.deleted_at IS NULL
     AND (p_status IS NULL OR j.status = p_status)
     AND (
       p_after_id IS NULL
       OR j.created_at > v_after_created_at
       OR (j.created_at = v_after_created_at AND j.id > v_after_id)
     )
   ORDER BY j.created_at, j.id
   LIMIT v_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_purge_stale_ingestion_jobs(
  p_retention_days integer DEFAULT 90,
  p_batch_size integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days integer;
  v_limit integer;
  v_cutoff timestamptz;
  v_archived integer := 0;
  v_purged integer := 0;
  rec record;
BEGIN
  v_days := GREATEST(COALESCE(p_retention_days, 90), 1);
  v_limit := GREATEST(LEAST(COALESCE(p_batch_size, 500), 5000), 1);
  v_cutoff := now() - (v_days || ' days')::interval;

  FOR rec IN
    SELECT j.id
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NULL
       AND j.updated_at < v_cutoff
       AND (
         j.status IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review')
         OR j.kind = 'delete'
       )
     ORDER BY j.updated_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.ingestion_jobs_archive (
      id, tenant_key, kind, source, source_key, batch_id, document_id, lineage_id, version,
      file_sha256, status, error_class, last_error, trace_id, retries,
      created_at, updated_at, archived_at
    )
    SELECT
      j.id, j.tenant_key, j.kind, j.source, j.source_key, j.batch_id, j.document_id, j.lineage_id, j.version,
      j.file_sha256, j.status, j.error_class, j.error, j.trace_id, j.retries,
      j.created_at, j.updated_at, now()
      FROM public.ingestion_jobs j
     WHERE j.id = rec.id
    ON CONFLICT (id) DO UPDATE SET
      archived_at = EXCLUDED.archived_at,
      status = EXCLUDED.status,
      error_class = EXCLUDED.error_class,
      last_error = EXCLUDED.last_error;

    DELETE FROM public.ingestion_jobs j WHERE j.id = rec.id;
    v_archived := v_archived + 1;
    v_purged := v_purged + 1;
  END LOOP;

  FOR rec IN
    SELECT j.id
      FROM public.ingestion_jobs j
     WHERE j.deleted_at IS NOT NULL
       AND j.deleted_at < v_cutoff
     ORDER BY j.deleted_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.ingestion_jobs_archive (
      id, tenant_key, kind, source, source_key, batch_id, document_id, lineage_id, version,
      file_sha256, status, error_class, last_error, trace_id, retries,
      created_at, updated_at, archived_at
    )
    SELECT
      j.id, j.tenant_key, j.kind, j.source, j.source_key, j.batch_id, j.document_id, j.lineage_id, j.version,
      j.file_sha256, j.status, j.error_class, j.error, j.trace_id, j.retries,
      j.created_at, j.updated_at, now()
      FROM public.ingestion_jobs j
     WHERE j.id = rec.id
    ON CONFLICT (id) DO UPDATE SET archived_at = EXCLUDED.archived_at;

    DELETE FROM public.ingestion_jobs j WHERE j.id = rec.id;
    v_archived := v_archived + 1;
    v_purged := v_purged + 1;
  END LOOP;

  RETURN jsonb_build_object('archived', v_archived, 'purged', v_purged, 'retention_days', v_days);
END;
$$;

CREATE OR REPLACE FUNCTION public.rag_ingest_job_status_for_stage(p_stage text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_stage
    WHEN 'begin' THEN 'queued'
    WHEN 'preflight' THEN 'preflight'
    WHEN 'parse' THEN 'parsing'
    WHEN 'check' THEN 'checking'
    WHEN 'content_hash_dedup' THEN 'chunking'
    WHEN 'scan_injection' THEN 'chunking'
    WHEN 'chunk' THEN 'chunking'
    WHEN 'enrich' THEN 'chunking'
    WHEN 'extract' THEN 'chunking'
    WHEN 'images' THEN 'chunking'
    WHEN 'embed' THEN 'embedding'
    WHEN 'write' THEN 'embedding'
    WHEN 'publish' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'quarantined'
    WHEN 'needs_review' THEN 'needs_review'
    WHEN 'skipped_duplicate' THEN 'skipped_duplicate'
    WHEN 'pending_review' THEN 'pending_review'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_mirror_processing_status(p_ledger_status text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_ledger_status
    WHEN 'queued' THEN 'queued'
    WHEN 'preflight' THEN 'parsing'
    WHEN 'parsing' THEN 'parsing'
    WHEN 'checking' THEN 'parsing'
    WHEN 'chunking' THEN 'chunking'
    WHEN 'embedding' THEN 'embedding'
    WHEN 'ready' THEN 'ready'
    WHEN 'needs_review' THEN 'ready'
    WHEN 'failed' THEN 'failed'
    WHEN 'quarantined' THEN 'failed'
    WHEN 'skipped_duplicate' THEN 'ready'
    WHEN 'pending_review' THEN 'ready'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_publish_deferred_ingestion_job(p_job_id uuid, p_profile_id text)
RETURNS public.ingestion_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_job public.ingestion_jobs%ROWTYPE;
  v_doc public.documents%ROWTYPE;
  v_profile public.embedding_profiles%ROWTYPE;
  v_outcome text;
  v_status text;
BEGIN
  SELECT * INTO v_job FROM public.ingestion_jobs j WHERE j.id = p_job_id AND j.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingest_refused: job_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_job.status IN ('ready', 'quarantined', 'needs_review', 'pending_review') AND v_job.kind = 'ingest' AND v_job.batch_id IS NOT NULL THEN
    RETURN v_job;
  END IF;
  IF v_job.kind <> 'ingest' OR v_job.batch_id IS NULL OR v_job.status <> 'embedding' OR v_job.stage IS DISTINCT FROM 'embed_deferred'
     OR v_job.document_id IS NULL THEN
    RAISE EXCEPTION 'ingest_refused: not_deferred' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_profile FROM public.embedding_profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR NOT (v_profile.status = 'active' OR v_profile.id = 'openai-3-small-1536') THEN
    RAISE EXCEPTION 'ingest_refused: profile_not_active' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_doc FROM public.documents d WHERE d.id = v_job.document_id AND d.tenant_key = v_job.tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_mismatch' USING ERRCODE = '22023';
  END IF;
  IF v_doc.status <> 'quarantined' AND NOT public.rag_vectors_complete(v_doc.id, v_profile.id, v_job.tenant_key) THEN
    RAISE EXCEPTION 'vectors_incomplete' USING ERRCODE = '22023', DETAIL = 'a chunk lacks its active-profile vector';
  END IF;

  SELECT r.outcome INTO v_outcome FROM public.rag_publish_document_version(v_doc.id, v_job.tenant_key) AS r;
  v_status := CASE
    WHEN v_outcome = 'quarantined' THEN 'quarantined'
    WHEN v_job.needs_review_reason IS NOT NULL THEN 'needs_review'
    ELSE 'ready'
  END;

  PERFORM public.rag_release_job_reservations(v_job.id);
  UPDATE public.ingestion_jobs j
     SET status = v_status,
         stage = v_status,
         locked_by = NULL,
         lease_until = NULL,
         runner = NULL,
         updated_at = now()
   WHERE j.id = v_job.id
   RETURNING j.* INTO v_job;

  UPDATE public.documents d
     SET processing_status = public.rag_ingest_mirror_processing_status(v_status)
   WHERE d.id = v_doc.id;
  IF v_status = 'needs_review' THEN
    UPDATE public.documents d
       SET status = 'ready', needs_review = true, needs_review_reason = COALESCE(v_job.needs_review_reason, d.needs_review_reason)
     WHERE d.id = v_doc.id;
  ELSIF v_status = 'quarantined' THEN
    UPDATE public.documents d SET status = 'failed', processing_status = 'failed' WHERE d.id = v_doc.id AND NOT d.is_current;
  END IF;

  PERFORM public.rag_ingest_broadcast_job(v_job);
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.rag_set_document_fields(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_document_fields(uuid, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_write_chunks(uuid, text, jsonb, jsonb, boolean, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_write_profile_chunks(uuid, text, text, jsonb, jsonb, jsonb, boolean, integer) TO service_role;

REVOKE ALL ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_advance_ingestion_job(uuid, text, text, text, jsonb, integer, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_job(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_claim_ingestion_jobs(text, integer, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_backfill_jobs(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_ingestion_job(text, text, text, text, text, text, text, jsonb, jsonb, integer, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_list_batch_jobs(uuid, text, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_stale_ingestion_jobs(integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rag_ingest_job_status_for_stage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_ingest_job_status_for_stage(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_ingest_mirror_processing_status(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_ingest_mirror_processing_status(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_publish_deferred_ingestion_job(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_publish_deferred_ingestion_job(uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

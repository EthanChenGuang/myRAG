-- 0942: rag_security_events — one row per security event (Phase 5.2, SEC-10, D-02, D-43).
-- Sources: ingestion injection rules, the retrieval-time check, the output guard, hidden text and the link check. A row holds ids, rule ids,
-- the detector name and the action only; there is no column for answer, chunk, query or document text. uploader_id is the document's
-- documents.user_id (null when the document is gone or has no owner); such events are stored but never counted toward an alert (0943).
-- The tenant is a copied tenant_key validated by rag_assert_tenant_key in every writer and reader (0943), so this file has no mode variants;
-- document_id and chunk_id carry no foreign key, so an event outlives the document it names.
-- Access: RLS on with no policy; every grant revoked from PUBLIC, anon and authenticated; service_role reads and writes through the 0943
-- functions and the admin routes. Not folded into the setup files. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_security_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  source text NOT NULL,
  action text NOT NULL,
  detector text NOT NULL,
  rule_ids text[] NOT NULL DEFAULT '{}'::text[],
  document_id uuid,
  chunk_id uuid,
  uploader_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_security_events_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_security_events_source_check
    CHECK (source IN ('ingest_injection', 'retrieval_injection', 'output_guard', 'hidden_text', 'untrusted_link')),
  CONSTRAINT rag_security_events_action_check
    CHECK (action IN ('detected', 'quarantined', 'dropped', 'downweighted', 'removed', 'blocked', 'warned')),
  CONSTRAINT rag_security_events_detector_check CHECK (detector ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT rag_security_events_rule_ids_check CHECK (
    pg_catalog.cardinality(rule_ids) <= 32
    AND pg_catalog.array_position(rule_ids, NULL) IS NULL
    AND pg_catalog.array_to_string(rule_ids, ',') ~ '^([A-Za-z0-9_.:-]{1,100}(,|$))*$'
  ),
  CONSTRAINT rag_security_events_trace_id_check CHECK (trace_id IS NULL OR trace_id ~ '^[A-Za-z0-9_.:-]{1,200}$')
);

CREATE INDEX IF NOT EXISTS rag_security_events_tenant_created_idx
  ON public.rag_security_events (tenant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_security_events_tenant_uploader_created_idx
  ON public.rag_security_events (tenant_key, uploader_id, created_at);

ALTER TABLE public.rag_security_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_security_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.rag_security_events TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

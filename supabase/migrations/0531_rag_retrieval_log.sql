-- 0531: rag_retrieval_log, one row per knowledge-base retrieval (Phase 5.1.1, FBK-01, FBK-02, D-03, D-03a, D-06).
-- Written by the service role after the response; ids, scores and language codes only, never answer, chunk or document text.
-- chat_id has no foreign key: a new chat's row is created after its first answer. The AFTER DELETE trigger on public.chats removes
-- the rows of a deleted chat instead. user_id and organization_id cascade, so deleting a user or an organization deletes their rows.
-- The organization foreign key is added only where public.organizations exists (multi-tenant).
-- tenant_key is a generated column added per mode by 0532. The column names and types read by Phases 5.3 and 7 are frozen (D-29).
-- Access: RLS on with no policy; no grant to PUBLIC, anon or authenticated; only service_role reads and writes. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_retrieval_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text NOT NULL CONSTRAINT rag_retrieval_log_trace_id_key UNIQUE,
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NULL,
  chat_id uuid NULL,
  answer_id uuid NULL,
  channel text NOT NULL CONSTRAINT rag_retrieval_log_channel_check CHECK (channel IN ('chat', 'embed', 'voice')),
  rag_mode text NULL,
  pipeline text NOT NULL CONSTRAINT rag_retrieval_log_pipeline_check CHECK (pipeline IN ('legacy', 'v2')),
  retrieval_config_hash text NULL,
  query_language text NULL CONSTRAINT rag_retrieval_log_query_language_check
    CHECK (query_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  query_language_confidence real NULL CONSTRAINT rag_retrieval_log_query_language_confidence_check
    CHECK (query_language_confidence BETWEEN 0 AND 1),
  chunk_languages text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT rag_retrieval_log_chunk_languages_check
    CHECK (
      cardinality(chunk_languages) = 0
      OR (
        array_ndims(chunk_languages) = 1
        AND array_position(chunk_languages, NULL) IS NULL
        AND array_to_string(chunk_languages, ',') ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?(,[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)*$'
        AND array_to_string(chunk_languages, ';') ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?(;[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)*$'
      )
    ),
  answer_language text NULL CONSTRAINT rag_retrieval_log_answer_language_check
    CHECK (answer_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  query_masked text NULL CONSTRAINT rag_retrieval_log_query_masked_check CHECK (char_length(query_masked) <= 2000),
  query_fingerprint text NULL CONSTRAINT rag_retrieval_log_query_fingerprint_check CHECK (query_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CONSTRAINT rag_retrieval_log_status_check CHECK (status IN ('ok', 'empty', 'error', 'degraded')),
  refusal_decision text NULL,
  refusal_reason text NULL,
  outcome text NOT NULL DEFAULT 'unknown' CONSTRAINT rag_retrieval_log_outcome_check
    CHECK (outcome IN ('answered', 'refused_no_context', 'kb_unavailable', 'degraded_answer', 'unknown')),
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT rag_retrieval_log_candidates_check
    CHECK (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 50),
  candidate_count integer NOT NULL DEFAULT 0 CONSTRAINT rag_retrieval_log_candidate_count_check CHECK (candidate_count >= 0),
  top_score real NULL,
  latency_ms integer NULL CONSTRAINT rag_retrieval_log_latency_ms_check CHECK (latency_ms >= 0),
  stage_latency jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback_vote smallint NULL CONSTRAINT rag_retrieval_log_feedback_vote_check CHECK (feedback_vote IN (-1, 1)),
  feedback_kind text NULL CONSTRAINT rag_retrieval_log_feedback_kind_check CHECK (feedback_kind IN ('answer', 'refusal', 'embed')),
  feedback_reasons text[] NOT NULL DEFAULT '{}'::text[],
  feedback_at timestamptz NULL,
  source_opened_count integer NOT NULL DEFAULT 0 CONSTRAINT rag_retrieval_log_source_opened_count_check
    CHECK (source_opened_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $org_fk$
BEGIN
  IF to_regclass('public.organizations') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_retrieval_log'::regclass AND conname = 'rag_retrieval_log_organization_id_fkey'
  ) THEN
    ALTER TABLE public.rag_retrieval_log
      ADD CONSTRAINT rag_retrieval_log_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END
$org_fk$;

CREATE INDEX IF NOT EXISTS idx_rag_retrieval_log_created ON public.rag_retrieval_log (created_at);
CREATE INDEX IF NOT EXISTS idx_rag_retrieval_log_chat_id ON public.rag_retrieval_log (chat_id);

ALTER TABLE public.rag_retrieval_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_retrieval_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rag_retrieval_log TO service_role;

CREATE OR REPLACE FUNCTION public.rag_feedback_loop_on_chat_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_retrieval_log l
  WHERE l.chat_id IN (SELECT o.id FROM old_rows o);
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_feedback_loop_on_chat_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_feedback_loop_on_chat_delete() TO service_role;

DROP TRIGGER IF EXISTS rag_feedback_loop_chats_delete ON public.chats;
CREATE TRIGGER rag_feedback_loop_chats_delete
  AFTER DELETE ON public.chats
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.rag_feedback_loop_on_chat_delete();

NOTIFY pgrst, 'reload schema';

COMMIT;

-- 0501: rag_answer_records — one server-written record per RAG answer (Phase 5, D-16, D-03).
-- id is the answerId the app mints (no default). The citation snapshot lives in citations, so the table has no
-- foreign key to documents or document_chunks: deleting or re-versioning a document leaves its records intact.
-- chat_id is nullable: a new chat's row is created only after its first answer; plan 05-09 attaches the record later.
-- organization_id gets its foreign key in the multi-tenant 0502 (single-tenant has no organizations table).
-- tenant_key is a generated column added per mode by 0502.
-- Access: RLS on; authenticated may only SELECT its own rows; no client write grant or policy; only service_role writes.
-- Shared-chat policies do not extend here (shared chats render from message metadata). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_answer_records (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NULL,
  chat_id uuid NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  trace_id text,
  model_id text,
  citation_strategy text CONSTRAINT rag_answer_records_citation_strategy_check
    CHECK (citation_strategy IN ('claude-citations', 'chunk-alias')),
  rag_mode text NOT NULL CONSTRAINT rag_answer_records_rag_mode_check
    CHECK (rag_mode IN ('strict', 'balanced', 'flexible', 'bypass')),
  answer_language text,
  invalid_citations integer NOT NULL DEFAULT 0 CONSTRAINT rag_answer_records_invalid_citations_check
    CHECK (invalid_citations >= 0),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  groundedness jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback jsonb,
  review_reasons text[] NOT NULL DEFAULT '{}'::text[] CONSTRAINT rag_answer_records_review_reasons_check
    CHECK (review_reasons <@ ARRAY['feedback_negative', 'groundedness_flagged']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_answer_records_chat_id ON public.rag_answer_records (chat_id);
CREATE INDEX IF NOT EXISTS idx_rag_answer_records_user_created ON public.rag_answer_records (user_id, created_at);

ALTER TABLE public.rag_answer_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_answer_records FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.rag_answer_records TO authenticated;
GRANT ALL ON TABLE public.rag_answer_records TO service_role;

DROP POLICY IF EXISTS rag_answer_records_select_own ON public.rag_answer_records;
CREATE POLICY rag_answer_records_select_own ON public.rag_answer_records
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';

COMMIT;

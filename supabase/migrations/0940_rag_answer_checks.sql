-- 0940: rag_answer_records.checks and texts_source (Phase 5.2, D-02, D-23).
-- checks holds the per-answer results of Phase 5.2 and 5.2.1 (sentence records, output guard, version conflict, truncation, calculation,
-- prompt budget), validated in the app by the AnswerChecks contract; it is always a JSON object and defaults to {} so old rows keep loading.
-- texts_source records where the answer's fixed texts came from: 'registry', 'legacy' or null (written before this phase or with every switch off).
-- Access is unchanged from 0501: authenticated reads its own rows, only service_role writes. Not folded into the setup files. Idempotent.

BEGIN;

ALTER TABLE public.rag_answer_records ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.rag_answer_records ADD COLUMN IF NOT EXISTS texts_source text;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_answer_records'::regclass AND conname = 'rag_answer_records_checks_object'
  ) THEN
    ALTER TABLE public.rag_answer_records
      ADD CONSTRAINT rag_answer_records_checks_object CHECK (pg_catalog.jsonb_typeof(checks) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_answer_records'::regclass AND conname = 'rag_answer_records_texts_source_check'
  ) THEN
    ALTER TABLE public.rag_answer_records
      ADD CONSTRAINT rag_answer_records_texts_source_check CHECK (texts_source IS NULL OR texts_source IN ('registry', 'legacy'));
  END IF;
END
$constraints$;

NOTIFY pgrst, 'reload schema';

COMMIT;

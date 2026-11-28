-- 0863: rag_retrieval_log.topk_redundancy, the largest share of the kept chunks in one duplicate cluster (Phase 4.2, D-22, RET-13).
-- Nullable: written only when a kept chunk carried a cluster id. A number between 0 and 1, never chunk or document text.
-- Access is the table's own (0531): RLS on with no policy, service_role only. Skipped where 0531 has not run. Idempotent.

BEGIN;

DO $redundancy$
BEGIN
  IF to_regclass('public.rag_retrieval_log') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS topk_redundancy real NULL;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_retrieval_log'::regclass AND conname = 'rag_retrieval_log_topk_redundancy_check'
  ) THEN
    ALTER TABLE public.rag_retrieval_log
      ADD CONSTRAINT rag_retrieval_log_topk_redundancy_check CHECK (topk_redundancy BETWEEN 0 AND 1);
  END IF;
END
$redundancy$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- 0532 (single-tenant): rag_retrieval_log.tenant_key is the constant s:default, the single-tenant scopeKey (0502 pattern).
-- Adds the (tenant_key, created_at desc) index read by Phases 5.3 and 7 and the partial index for negative feedback. Idempotent.

BEGIN;

ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS ('s:default'::text) STORED;

CREATE INDEX IF NOT EXISTS idx_rag_retrieval_log_tenant_created ON public.rag_retrieval_log (tenant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_retrieval_log_tenant_negative ON public.rag_retrieval_log (tenant_key, created_at)
  WHERE feedback_vote = -1;

COMMIT;

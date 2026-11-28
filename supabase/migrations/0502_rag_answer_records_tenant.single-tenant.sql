-- 0502 (single-tenant): rag_answer_records.tenant_key is the constant s:default, the single-tenant scopeKey.
-- Generated, so it cannot drift from TenantScope semantics. Idempotent.

BEGIN;

ALTER TABLE public.rag_answer_records ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS ('s:default'::text) STORED;

CREATE INDEX IF NOT EXISTS idx_rag_answer_records_tenant_created ON public.rag_answer_records (tenant_key, created_at);

COMMIT;

-- 0502 (multi-tenant): rag_answer_records.tenant_key is o:<organization_id> for an organization answer and
-- u:<user_id> for a personal one, the same expression as documents.tenant_key (0301) and scopeKey().
-- Also adds the organization foreign key. Idempotent.

BEGIN;

ALTER TABLE public.rag_answer_records ADD COLUMN IF NOT EXISTS tenant_key text GENERATED ALWAYS AS (
  CASE WHEN organization_id IS NOT NULL THEN 'o:' || organization_id::text ELSE 'u:' || user_id::text END
) STORED;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_answer_records'::regclass AND conname = 'rag_answer_records_organization_id_fkey'
  ) THEN
    ALTER TABLE public.rag_answer_records
      ADD CONSTRAINT rag_answer_records_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS idx_rag_answer_records_tenant_created ON public.rag_answer_records (tenant_key, created_at);

COMMIT;

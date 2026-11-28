-- 0965: rag_judge_labels, expert answer-check verdicts on review items (Phase 5.3, EVAL-24, D-31, D-55, D-56).
-- One row per (review item, labeller) with three verdicts: supported, relevant, unsupported_content. No answer or query text.
-- Tenant isolation: the label's tenant_key is tied to its item's tenant_key by a composite foreign key (on the unique
-- (id, tenant_key) of rag_review_items added here), so no caller, the service role included, can file a label under another
-- tenant. authenticated may SELECT, INSERT and UPDATE (verdicts and labelled_at only) where public.rag_is_domain_expert(tenant_key)
-- is true (0534); writes also need labelled_by = auth.uid(), and an UPDATE touches only the caller's own label. No DELETE for
-- clients; labels go with their review item (ON DELETE CASCADE) or their labeller. Adds no function.
-- No-op without the Phase 5.1.1 review queue (to_regclass guard). Idempotent; not folded into the setup files.

BEGIN;

DO $do$
BEGIN
  IF pg_catalog.to_regclass('public.rag_review_items') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_is_domain_expert(text)') IS NULL THEN
    RAISE NOTICE '[0965] rag_review_items or rag_is_domain_expert is missing; skipped';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rag_review_items'::regclass AND conname = 'rag_review_items_id_tenant_key_key'
  ) THEN
    EXECUTE 'ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_id_tenant_key_key UNIQUE (id, tenant_key)';
  END IF;

  EXECUTE $sql$
    CREATE TABLE IF NOT EXISTS public.rag_judge_labels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      review_item_id uuid NOT NULL,
      tenant_key text NOT NULL CONSTRAINT rag_judge_labels_tenant_key_check
        CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
      supported boolean NOT NULL,
      relevant boolean NOT NULL,
      unsupported_content boolean NOT NULL,
      labelled_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      labelled_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rag_judge_labels_item_tenant_fkey FOREIGN KEY (review_item_id, tenant_key)
        REFERENCES public.rag_review_items (id, tenant_key) ON DELETE CASCADE,
      CONSTRAINT rag_judge_labels_item_labeller_key UNIQUE (review_item_id, labelled_by)
    )
  $sql$;

  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_rag_judge_labels_tenant ON public.rag_judge_labels (tenant_key, labelled_at DESC)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_rag_judge_labels_labelled_by ON public.rag_judge_labels (labelled_by)';

  EXECUTE 'ALTER TABLE public.rag_judge_labels ENABLE ROW LEVEL SECURITY';

  EXECUTE 'REVOKE ALL ON TABLE public.rag_judge_labels FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT, INSERT ON TABLE public.rag_judge_labels TO authenticated';
  EXECUTE 'GRANT UPDATE (supported, relevant, unsupported_content, labelled_at) ON TABLE public.rag_judge_labels TO authenticated';
  EXECUTE 'GRANT ALL ON TABLE public.rag_judge_labels TO service_role';

  EXECUTE 'DROP POLICY IF EXISTS rag_judge_labels_expert_select ON public.rag_judge_labels';
  EXECUTE $sql$
    CREATE POLICY rag_judge_labels_expert_select ON public.rag_judge_labels
      FOR SELECT TO authenticated
      USING (public.rag_is_domain_expert(tenant_key))
  $sql$;

  EXECUTE 'DROP POLICY IF EXISTS rag_judge_labels_expert_insert ON public.rag_judge_labels';
  EXECUTE $sql$
    CREATE POLICY rag_judge_labels_expert_insert ON public.rag_judge_labels
      FOR INSERT TO authenticated
      WITH CHECK (public.rag_is_domain_expert(tenant_key) AND labelled_by = auth.uid())
  $sql$;

  EXECUTE 'DROP POLICY IF EXISTS rag_judge_labels_expert_update ON public.rag_judge_labels';
  EXECUTE $sql$
    CREATE POLICY rag_judge_labels_expert_update ON public.rag_judge_labels
      FOR UPDATE TO authenticated
      USING (public.rag_is_domain_expert(tenant_key) AND labelled_by = auth.uid())
      WITH CHECK (public.rag_is_domain_expert(tenant_key) AND labelled_by = auth.uid())
  $sql$;
END
$do$;

NOTIFY pgrst, 'reload schema';

COMMIT;

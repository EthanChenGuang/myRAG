-- 1012: Phase 6.3 gap closure G5 (quick 63-gaps; 06.3-VERIFICATION note for plan 06.3-26): the connector access tables of 0920 and
-- 0925 (rag_connector_group_map, rag_connector_sharing_rules, rag_connector_document_principals, rag_connector_document_access) and the
-- three connector functions that check the provider (rag_connector_apply_access, rag_connector_map_set, rag_connector_rule_set) accept
-- sharepoint-online and one-drive, the Nango provider names of the Phase 6.3 Microsoft connectors. Nothing else changes: no row is
-- written, and the Microsoft copies stay owner-only (fail closed) until 06.3-26 maps their permissions.
-- The function bodies are rewritten in place from their current definition (pg_get_functiondef), so the newest body is kept whatever
-- file last defined it; security mode, search_path and grants are part of that definition or survive CREATE OR REPLACE. A body that
-- already lists the two providers is left alone. Numbered after 0925 so a fresh apply in number order finds the objects.
-- Operator rule: after re-running 0920 or 0925, re-run this file. Idempotent; one common file for both modes; not folded.

BEGIN;

DO $precheck$
BEGIN
  IF pg_catalog.to_regclass('public.rag_connector_group_map') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_connector_map_set(text,uuid,text,text,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '1012: apply 0920 and 0925 first' USING ERRCODE = '55000';
  END IF;
END
$precheck$;

-- G5: the connector access tables accept the two Microsoft providers (06.3-26 maps their permissions).
DO $providers$
DECLARE
  v_table record;
  v_fn record;
  v_def text;
BEGIN
  FOR v_table IN
    SELECT * FROM (VALUES
      ('rag_connector_group_map', 'rag_connector_group_map_provider_check'),
      ('rag_connector_sharing_rules', 'rag_connector_sharing_rules_provider_check'),
      ('rag_connector_document_principals', 'rag_connector_document_principals_provider_check'),
      ('rag_connector_document_access', 'rag_connector_document_access_provider_check')
    ) AS t(relation, constraint_name)
  LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', v_table.relation)) IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_table.relation, v_table.constraint_name);
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (provider IN (''google-drive'', ''dropbox'', ''notion'', ''sharepoint-online'', ''one-drive''))',
        v_table.relation, v_table.constraint_name);
    END IF;
  END LOOP;

  FOR v_fn IN
    SELECT p.oid
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('rag_connector_apply_access', 'rag_connector_map_set', 'rag_connector_map_delete', 'rag_connector_map_list',
                         'rag_connector_rule_set', 'rag_connector_rules_list', 'rag_connector_fail_closed_counts', 'rag_connector_match_members')
       AND pg_catalog.strpos(p.prosrc, 'NOT IN (''google-drive'', ''dropbox'', ''notion'')') > 0
  LOOP
    v_def := pg_catalog.pg_get_functiondef(v_fn.oid);
    EXECUTE pg_catalog.replace(v_def, 'NOT IN (''google-drive'', ''dropbox'', ''notion'')', 'NOT IN (''google-drive'', ''dropbox'', ''notion'', ''sharepoint-online'', ''one-drive'')');
  END LOOP;
END
$providers$;

NOTIFY pgrst, 'reload schema';

COMMIT;

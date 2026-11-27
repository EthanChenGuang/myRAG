-- Train 36 live SQL (ci/merge-train-36). Apply after train 35 is live (0921, 0922, 0930, 0932 and 0410 r18). Multi-tenant production.
-- Order: 0903, 0923, 0926 (common, then .multi-tenant), 0931, 0950, then the 0410 r19 delta (grants only).
-- Not in this file: 0967 changed in place (05.2.1-06) only so that a fresh build in file order keeps calc_mismatch / calc_unverified
-- (0967 sorts after 0950); on production 0967 is already applied and 0950 widens the same check, so 0967 is not re-run.
-- 0921 and 0922 are unchanged from train 35 (the 04.3-04 and 04.3-05 additions live in 0923).
-- DROP sections (each followed by a re-create in the same transaction):
--   0923: DROP TRIGGER IF EXISTS on document_parents_access_groups_from_document, rag_documents_access_groups_propagate,
--         rag_documents_access_a_guard, rag_documents_access_b_inherit and, when the table exists, the chunk_translations /
--         rag_table_rows copy and propagate triggers (all re-created). When chunk_translations or rag_table_rows is absent its
--         propagate trigger on documents is dropped and not re-created (both tables exist on production).
--   0923: ALTER TABLE ... DROP CONSTRAINT <table>_access_groups_check only when it still calls rag_access_keys_valid (re-added inline;
--         after train 35 none does on documents / document_chunks, so this only adds the check to document_parents, chunk_translations
--         and rag_table_rows).
--   0923: ALTER TABLE public.rag_access_audit DROP CONSTRAINT IF EXISTS rag_access_audit_tenant_key_check (re-added, widened for the
--         one 'deployment' / enforcement_set row kind).
--   0926: DROP POLICY IF EXISTS rag_access_groups_restrict on documents, document_chunks, document_parents (re-created RESTRICTIVE
--         FOR SELECT TO anon, authenticated; with rag_access_group_settings.enforced = false they change no read).
--   0931: DO $drop_overloads$ drops EVERY public.rag_cache_check overload, then one function (0603 arguments plus p_access_keys,
--         p_access_all with defaults) is created; DROP TRIGGER IF EXISTS rag_access_semantic_cache_update ON documents (re-created).
--   0950: DROP CONSTRAINT IF EXISTS rag_answer_records_review_reasons_check and rag_review_items_reasons_check (re-added, widened).
-- Operational notes:
--   0923 adds document_parents.access_groups, chunk_translations.access_groups and rag_table_rows.access_groups (text[] NOT NULL
--   DEFAULT '{all}': metadata-only), one-off UPDATEs aligning them with their documents (every row is '{all}' until labels are set),
--   inline CHECK constraints (validate every row) and three GIN indexes built without CONCURRENTLY. Run in a quiet window.
--   0926 needs 0923 (document_parents.access_groups) and grants rag_access_enforced, rag_caller_access_keys and (single-tenant)
--   rag_caller_is_access_admin to anon and authenticated; the 0410 r19 delta repeats those grants.

-- ==== supabase/migrations/0903_lexical_stats_purge_hook.sql
-- 0903: Phase 4.4 reserved purge hook of the per-tenant lexical statistics for the Phase 6.3 purge (LEX-06, D-33).
-- rag_purge_hook_lexical_stats(p_tenant_key, p_lineage_id, p_document_ids) RETURNS bigint. The statistics (rag_lexical_df,
-- rag_lexical_corpus) hold no document id: when the purge deletes a version's chunks, the 0901 delete trigger stages one -1 row per
-- member chunk in rag_lexical_stats_pending, and this hook folds the tenant's staged rows through rag_lexstats_compact (0902) until none
-- is left (at most 200 batches of 5000), returning the number of pending rows folded. Counters that reach zero are deleted, so a tenant
-- with no member chunk left keeps no counter row. Phase 6.3 calls it by name (counts key lexical_stats); called before the chunk delete
-- it folds only what is already staged, so it must be called again after the chunk delete.
-- The hook checks the tenant key first (rag_assert_tenant_key) and refuses (22023) a listed id whose document belongs to another tenant
-- or, when p_lineage_id is given, to another lineage; ids of documents that no longer exist are accepted. A tenant without a state row
-- returns 0 and writes nothing. rag_purge_store_inventory() (Phase 6.3, 0728) is absent on trunk, so this file adds no inventory row
-- (hand-off: .planning/phases/04.4-true-bm25-lexical-scoring/handoffs/04.4-07-purge-inventory.md).
-- SECURITY INVOKER with an empty search_path; service_role only. Idempotent; not folded into the setup files.

BEGIN;

DO $lexical_stats_purge_hook_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('public.rag_assert_tenant_key(text)') IS NULL
     OR pg_catalog.to_regclass('public.rag_lexical_stats_state') IS NULL
     OR pg_catalog.to_regprocedure('public.rag_lexstats_compact(text, integer)') IS NULL THEN
    RAISE EXCEPTION '0903: apply migrations 0401, 0900, 0901 and 0902 first' USING ERRCODE = '55000';
  END IF;
END
$lexical_stats_purge_hook_precheck$;

CREATE OR REPLACE FUNCTION public.rag_purge_hook_lexical_stats(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_folded bigint;
  v_total bigint := 0;
  v_round integer := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
      AND (d.tenant_key IS DISTINCT FROM p_tenant_key OR (p_lineage_id IS NOT NULL AND d.lineage_id IS DISTINCT FROM p_lineage_id))
  ) THEN
    RAISE EXCEPTION 'rag_purge_hook_lexical_stats: a document id is outside the tenant or lineage' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rag_lexical_stats_state s WHERE s.tenant_key = p_tenant_key) THEN
    RETURN 0;
  END IF;
  LOOP
    v_round := v_round + 1;
    v_folded := public.rag_lexstats_compact(p_tenant_key, 5000);
    v_total := v_total + v_folded;
    EXIT WHEN v_folded = 0 OR v_round >= 200;
  END LOOP;
  RETURN v_total;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_lexical_stats(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0923_access_labels_and_resolution.sql
-- 0923: completion of the access-group columns (0921) and resolution functions (0922) (Phase 4.3 plans 04 and 05).
-- Plans 04.3-04 and 04.3-05 first edited 0921 and 0922 in place. Both files had already shipped with merge train 35, so their additions
-- live here instead; on a fresh database 0921, 0922 and this file give the end state of the edited files. The section order is the
-- plan order: part 1 is 04.3-04 (0921), part 2 is 04.3-05 (0922). The key checks of part 1 replace any constraint of the earlier
-- function-call form on every labelled table, so this file does not depend on which 0921 form a database ran. Not folded into the
-- setup files. Idempotent: CREATE OR REPLACE, ADD COLUMN / CREATE INDEX IF NOT EXISTS, DROP ... IF EXISTS then CREATE, guarded DO blocks.
--
-- Part 1 (04.3-04):
-- Plan 04.3-04. document_parents carries the same column, check, GIN index and copy trigger. The optional derived stores
-- (chunk_translations, rag_table_rows) get them inside one to_regclass guard each, so an absent table is skipped and a later re-run of this
-- file completes it; duplicate-cluster membership is document_chunks.dup_cluster_id, so it is covered by the chunk column. A relabel of a
-- document reaches every derived row in the same transaction (rag_access_groups_propagate and one propagate function per optional store,
-- AFTER UPDATE OF access_groups ON documents). Clients cannot set the label: rag_documents_access_guard (SECURITY INVOKER, current_user is the
-- writing role) resets it to the default on a client insert and refuses a client update with access_groups_server_only (42501); the copy
-- triggers replace any client value on derived rows. rag_documents_access_inherit (SECURITY DEFINER) gives a new version inserted with the
-- default the label of its lineage's current version in the same tenant (D-19); trigger names fix the order guard, then inheritance.
-- rag_access_groups_drift() counts, per present store, the rows whose array differs from their document's, current and superseded alike.
--
-- Part 2 (04.3-05):
-- Plan 04.3-05 adds the service-role functions the phase calls. Each takes the tenant key first and opens with
-- rag_assert_tenant_key; the tenant mode is read from the key prefix (o:, s:, u:), so the file has no mode variant. All are SECURITY INVOKER
-- except rag_access_user_in_tenant (DEFINER: it reads auth.users) and every one is executable by service_role only.
-- rag_resolve_access_scope(tenant, user): is_admin (o: owner or admin of the organization, s: admin_users, u: the owner), the caller's group
-- ids in this tenant (an o: tenant also requires the organization membership) and the effective keys: all plus each of u:<user> and
-- g:<group> that labels at least one current document of the tenant (A-05). rag_access_group_by_key(tenant, key) serves the embed scope.
-- rag_set_document_access_groups is the one write path for document labels (D-17, A-07): keys are trimmed, lower-cased, deduplicated and
-- sorted, all alone wins; it raises empty_access, invalid_access_key, unknown_group, unknown_user or invalid_actor_kind (22023, reason word
-- first) before any write, relabels every version of each lineage (RESEARCH Pitfall 6) under a row lock, and writes one document_set audit
-- row per changed lineage. An admin call skips a lineage that a nango_sync_records row links (skipped_connector). rag_chunks_visible and
-- rag_documents_visible check ids in one batch: the tenant always, both labels unless p_access_all; chunks must also be current and
-- ready or variant (the hybrid_search_chunks rule), documents may be of any version. Missing or empty keys without p_access_all raise
-- access_keys_empty (fail closed).
-- rag_access_set_enforced(boolean) upserts the single settings row and returns the stored value; only a change writes an enforcement_set
-- audit row (tenant key 'deployment', actor NULL, actor_kind system, reason enforced_on or enforced_off). The audit tenant_key CHECK is
-- widened for that one row kind: 'deployment' is accepted only with action enforcement_set. rag_security_event_record stores tenant, user,
-- event, chunk ids, document ids and request id in rag_access_security_events (0920) and returns the new id; it takes no text.

BEGIN;

-- Part 1 (04.3-04). document_parents (D-03).

ALTER TABLE public.document_parents ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';

CREATE INDEX IF NOT EXISTS document_parents_access_groups_gin ON public.document_parents USING gin (access_groups);

DROP TRIGGER IF EXISTS document_parents_access_groups_from_document ON public.document_parents;
CREATE TRIGGER document_parents_access_groups_from_document
  BEFORE INSERT OR UPDATE OF access_groups ON public.document_parents
  FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_from_document();

UPDATE public.document_parents p
SET access_groups = d.access_groups
FROM public.documents d
WHERE d.id = p.document_id AND p.access_groups IS DISTINCT FROM d.access_groups;

-- Relabel propagation to chunks and parents (D-03, D-17).

CREATE OR REPLACE FUNCTION public.rag_access_groups_propagate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.document_chunks c
  SET access_groups = NEW.access_groups
  WHERE c.document_id = NEW.id AND c.access_groups IS DISTINCT FROM NEW.access_groups;
  UPDATE public.document_parents p
  SET access_groups = NEW.access_groups
  WHERE p.document_id = NEW.id AND p.access_groups IS DISTINCT FROM NEW.access_groups;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_propagate() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate() TO service_role;

DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate ON public.documents;
CREATE TRIGGER rag_documents_access_groups_propagate
  AFTER UPDATE OF access_groups ON public.documents
  FOR EACH ROW
  WHEN (OLD.access_groups IS DISTINCT FROM NEW.access_groups)
  EXECUTE FUNCTION public.rag_access_groups_propagate();

-- Optional derived stores (D-03, D-30, A-11). The functions are top level; their triggers exist only when the table does.

CREATE OR REPLACE FUNCTION public.rag_access_groups_propagate_translations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.chunk_translations t
  SET access_groups = NEW.access_groups
  WHERE t.document_id = NEW.id AND t.access_groups IS DISTINCT FROM NEW.access_groups;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_translations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_translations() TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_groups_propagate_table_rows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.rag_table_rows r
  SET access_groups = NEW.access_groups
  WHERE r.document_id = NEW.id AND r.access_groups IS DISTINCT FROM NEW.access_groups;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_table_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_table_rows() TO service_role;

DO $translations_access$
BEGIN
  IF pg_catalog.to_regclass('public.chunk_translations') IS NULL THEN
    DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_translations ON public.documents;
    RAISE NOTICE '0923: public.chunk_translations is absent; re-run this file once it exists';
    RETURN;
  END IF;
  ALTER TABLE public.chunk_translations ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';
  CREATE INDEX IF NOT EXISTS chunk_translations_access_groups_gin ON public.chunk_translations USING gin (access_groups);
  DROP TRIGGER IF EXISTS chunk_translations_access_groups_from_document ON public.chunk_translations;
  CREATE TRIGGER chunk_translations_access_groups_from_document
    BEFORE INSERT OR UPDATE OF access_groups ON public.chunk_translations
    FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_from_document();
  DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_translations ON public.documents;
  CREATE TRIGGER rag_documents_access_groups_propagate_translations
    AFTER UPDATE OF access_groups ON public.documents
    FOR EACH ROW
    WHEN (OLD.access_groups IS DISTINCT FROM NEW.access_groups)
    EXECUTE FUNCTION public.rag_access_groups_propagate_translations();
  UPDATE public.chunk_translations t
  SET access_groups = d.access_groups
  FROM public.documents d
  WHERE d.id = t.document_id AND t.access_groups IS DISTINCT FROM d.access_groups;
END
$translations_access$;

DO $table_rows_access$
BEGIN
  IF pg_catalog.to_regclass('public.rag_table_rows') IS NULL THEN
    DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_table_rows ON public.documents;
    RAISE NOTICE '0923: public.rag_table_rows is absent; re-run this file once it exists';
    RETURN;
  END IF;
  ALTER TABLE public.rag_table_rows ADD COLUMN IF NOT EXISTS access_groups text[] NOT NULL DEFAULT '{all}';
  CREATE INDEX IF NOT EXISTS rag_table_rows_access_groups_gin ON public.rag_table_rows USING gin (access_groups);
  DROP TRIGGER IF EXISTS rag_table_rows_access_groups_from_document ON public.rag_table_rows;
  CREATE TRIGGER rag_table_rows_access_groups_from_document
    BEFORE INSERT OR UPDATE OF access_groups ON public.rag_table_rows
    FOR EACH ROW EXECUTE FUNCTION public.rag_access_groups_from_document();
  DROP TRIGGER IF EXISTS rag_documents_access_groups_propagate_table_rows ON public.documents;
  CREATE TRIGGER rag_documents_access_groups_propagate_table_rows
    AFTER UPDATE OF access_groups ON public.documents
    FOR EACH ROW
    WHEN (OLD.access_groups IS DISTINCT FROM NEW.access_groups)
    EXECUTE FUNCTION public.rag_access_groups_propagate_table_rows();
  UPDATE public.rag_table_rows r
  SET access_groups = d.access_groups
  FROM public.documents d
  WHERE d.id = r.document_id AND r.access_groups IS DISTINCT FROM d.access_groups;
END
$table_rows_access$;

-- Key checks (D-02) on every labelled table. The expression is the inline rule of 0921 (train 35), character for character, so every
-- labelled table carries the same check: a CHECK runs with the writing role's privileges and rag_access_keys_valid stays service_role
-- only, so a check that called it would fail client inserts with permission denied (found by plan 04's client cases). A constraint of
-- the function-call form is replaced; an inline one is kept; absent tables are skipped.

DO $access_checks$
DECLARE
  v_table text;
  v_name text;
  v_def text;
  v_expr constant text := 'access_groups IS NOT NULL AND pg_catalog.cardinality(access_groups) > 0 AND pg_catalog.array_position(access_groups, NULL::text) IS NULL AND pg_catalog.array_to_string(access_groups, '','') ~ ''^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(,(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))*$'' AND pg_catalog.cardinality(access_groups) = pg_catalog.cardinality(pg_catalog.string_to_array(pg_catalog.array_to_string(access_groups, '',''), '','')) AND (pg_catalog.array_position(access_groups, ''all'') IS NULL OR pg_catalog.cardinality(access_groups) = 1)';
BEGIN
  FOREACH v_table IN ARRAY ARRAY['documents', 'document_chunks', 'document_parents', 'chunk_translations', 'rag_table_rows'] LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_table) AND a.attname = 'access_groups' AND NOT a.attisdropped
    );
    v_name := v_table || '_access_groups_check';
    v_def := NULL;
    SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = pg_catalog.to_regclass('public.' || v_table) AND c.conname = v_name;
    IF v_def IS NOT NULL AND v_def LIKE '%rag_access_keys_valid%' THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_name);
      v_def := NULL;
    END IF;
    IF v_def IS NULL THEN
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%s)', v_table, v_name, v_expr);
    END IF;
  END LOOP;
END
$access_checks$;

-- Client write guard on documents (D-06, D-16). Roles other than the server roles are clients; DEFINER writers run as their owner.

CREATE OR REPLACE FUNCTION public.rag_documents_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.access_groups := '{all}'::text[];
  ELSIF NEW.access_groups IS DISTINCT FROM OLD.access_groups THEN
    RAISE EXCEPTION 'access_groups_server_only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_documents_access_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_documents_access_guard() TO service_role;

DROP TRIGGER IF EXISTS rag_documents_access_a_guard ON public.documents;
CREATE TRIGGER rag_documents_access_a_guard
  BEFORE INSERT OR UPDATE OF access_groups ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_documents_access_guard();

-- Version inheritance (D-19). documents.tenant_key is generated and unset in a BEFORE trigger, so the tenant is computed from the row.

CREATE OR REPLACE FUNCTION public.rag_documents_access_inherit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_multi_tenant boolean;
  v_tenant text;
  v_groups text[];
BEGIN
  IF NEW.lineage_id IS NULL OR NEW.access_groups IS DISTINCT FROM '{all}'::text[] THEN
    RETURN NEW;
  END IF;
  v_multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF v_multi_tenant THEN
    v_tenant := CASE WHEN NEW.organization_id IS NOT NULL THEN 'o:' || NEW.organization_id::text ELSE 'u:' || NEW.user_id::text END;
  ELSE
    v_tenant := 's:default';
  END IF;
  SELECT d.access_groups INTO v_groups
  FROM public.documents d
  WHERE d.lineage_id = NEW.lineage_id AND d.tenant_key = v_tenant AND d.is_current AND d.id IS DISTINCT FROM NEW.id
  ORDER BY d.version DESC NULLS LAST
  LIMIT 1;
  IF FOUND THEN
    NEW.access_groups := v_groups;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_documents_access_inherit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_documents_access_inherit() TO service_role;

DROP TRIGGER IF EXISTS rag_documents_access_b_inherit ON public.documents;
CREATE TRIGGER rag_documents_access_b_inherit
  BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.rag_documents_access_inherit();

-- Drift check (D-33, A-08): rows whose array differs from their document's, per present store, current and superseded rows alike.

CREATE OR REPLACE FUNCTION public.rag_access_groups_drift()
RETURNS TABLE (store text, rows bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_store text;
  v_count bigint;
BEGIN
  RETURN QUERY
  SELECT 'document_chunks'::text, pg_catalog.count(*)
  FROM public.document_chunks c JOIN public.documents d ON d.id = c.document_id
  WHERE c.access_groups IS DISTINCT FROM d.access_groups;
  RETURN QUERY
  SELECT 'document_parents'::text, pg_catalog.count(*)
  FROM public.document_parents p JOIN public.documents d ON d.id = p.document_id
  WHERE p.access_groups IS DISTINCT FROM d.access_groups;
  FOREACH v_store IN ARRAY ARRAY['chunk_translations', 'rag_table_rows'] LOOP
    IF pg_catalog.to_regclass('public.' || v_store) IS NOT NULL AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_store) AND a.attname = 'access_groups' AND NOT a.attisdropped
    ) THEN
      EXECUTE pg_catalog.format(
        'SELECT pg_catalog.count(*) FROM public.%I x JOIN public.documents d ON d.id = x.document_id WHERE x.access_groups IS DISTINCT FROM d.access_groups',
        v_store
      ) INTO v_count;
      store := v_store;
      rows := v_count;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_drift() TO service_role;

-- Part 2 (04.3-05).

CREATE OR REPLACE FUNCTION public.rag_resolve_access_scope(p_tenant_key text, p_user_id uuid)
RETURNS TABLE (is_admin boolean, group_ids uuid[], effective_keys text[])
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_prefix text;
  v_tenant_id uuid;
  v_admin boolean := false;
  v_member boolean := false;
  v_groups uuid[] := '{}'::uuid[];
  v_keys text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT false, '{}'::uuid[], ARRAY['all']::text[];
    RETURN;
  END IF;
  v_prefix := pg_catalog.left(p_tenant_key, 2);
  IF v_prefix = 'o:' THEN
    v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
    SELECT pg_catalog.count(*) > 0, COALESCE(pg_catalog.bool_or(m.role IN ('owner', 'admin')), false)
      INTO v_member, v_admin
    FROM public.organization_members m
    WHERE m.organization_id = v_tenant_id AND m.user_id = p_user_id;
    IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_tenant_id AND o.owner_id = p_user_id) THEN
      v_member := true;
      v_admin := true;
    END IF;
  ELSIF v_prefix = 's:' THEN
    v_member := true;
    v_admin := EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_user_id);
  ELSE
    v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
    v_member := v_tenant_id = p_user_id;
    v_admin := v_member;
  END IF;

  IF v_member THEN
    SELECT COALESCE(pg_catalog.array_agg(gm.group_id ORDER BY gm.group_id), '{}'::uuid[])
      INTO v_groups
    FROM public.rag_access_group_members gm
    JOIN public.rag_access_groups g ON g.id = gm.group_id
    WHERE gm.user_id = p_user_id AND g.tenant_key = p_tenant_key;
  END IF;

  SELECT ARRAY['all']::text[] || COALESCE(pg_catalog.array_agg(k.key ORDER BY k.key COLLATE "C"), '{}'::text[])
    INTO v_keys
  FROM (
    SELECT 'u:' || p_user_id::text AS key
    UNION
    SELECT 'g:' || gid::text FROM pg_catalog.unnest(v_groups) AS u(gid)
  ) k
  WHERE EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups @> ARRAY[k.key]
  );

  RETURN QUERY SELECT v_admin, v_groups, v_keys;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_resolve_access_scope(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_resolve_access_scope(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_group_by_key(p_tenant_key text, p_key text)
RETURNS TABLE (id uuid, name text, labels_current boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT g.id, g.name, EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups @> ARRAY['g:' || g.id::text]
  )
  FROM public.rag_access_groups g
  WHERE g.tenant_key = p_tenant_key AND g.key = p_key;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_by_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_by_key(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_user_in_tenant(p_tenant_key text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_prefix text;
  v_tenant_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  v_prefix := pg_catalog.left(p_tenant_key, 2);
  IF v_prefix = 's:' THEN
    RETURN EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = p_user_id
        AND (NOT (pg_catalog.to_jsonb(u) ? 'confirmed_at') OR (pg_catalog.to_jsonb(u) ->> 'confirmed_at') IS NOT NULL)
        AND (pg_catalog.to_jsonb(u) ->> 'deleted_at') IS NULL
    );
  END IF;
  v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
  IF v_prefix = 'u:' THEN
    RETURN v_tenant_id = p_user_id;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = v_tenant_id AND m.user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_tenant_id AND o.owner_id = p_user_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_user_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_user_in_tenant(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_set_document_access_groups(
  p_tenant_key text,
  p_document_ids uuid[],
  p_keys text[],
  p_actor uuid,
  p_actor_kind text,
  p_reason text
)
RETURNS TABLE (document_id uuid, outcome text, before_groups text[], after_groups text[])
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_keys text[];
  v_key text;
  v_lineage record;
  v_before text[];
  v_changed integer;
  v_outcome text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('admin', 'connector', 'system') THEN
    RAISE EXCEPTION 'invalid_actor_kind' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(k.key ORDER BY k.key COLLATE "C")
    INTO v_keys
  FROM (
    SELECT DISTINCT pg_catalog.lower(pg_catalog.btrim(raw.key)) AS key
    FROM pg_catalog.unnest(p_keys) AS raw(key)
    WHERE raw.key IS NOT NULL AND pg_catalog.btrim(raw.key) <> ''
  ) k;
  IF v_keys IS NULL OR pg_catalog.cardinality(v_keys) = 0 THEN
    RAISE EXCEPTION 'empty_access' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF v_key !~ '^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
      RAISE EXCEPTION 'invalid_access_key' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF 'all' = ANY (v_keys) THEN
    v_keys := ARRAY['all']::text[];
  END IF;
  FOREACH v_key IN ARRAY v_keys LOOP
    IF pg_catalog.left(v_key, 2) = 'g:' AND NOT EXISTS (
      SELECT 1 FROM public.rag_access_groups g WHERE g.id = pg_catalog.substr(v_key, 3)::uuid AND g.tenant_key = p_tenant_key
    ) THEN
      RAISE EXCEPTION 'unknown_group' USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.left(v_key, 2) = 'u:' AND NOT public.rag_access_user_in_tenant(p_tenant_key, pg_catalog.substr(v_key, 3)::uuid) THEN
      RAISE EXCEPTION 'unknown_user' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  CREATE TEMP TABLE IF NOT EXISTS _rag_access_set_targets (req_id uuid PRIMARY KEY, lineage uuid) ON COMMIT DROP;
  TRUNCATE pg_temp._rag_access_set_targets;
  INSERT INTO pg_temp._rag_access_set_targets (req_id, lineage)
  SELECT r.id, COALESCE(d.lineage_id, d.id)
  FROM (SELECT DISTINCT x.id FROM pg_catalog.unnest(p_document_ids) AS x(id) WHERE x.id IS NOT NULL) r
  LEFT JOIN public.documents d ON d.id = r.id AND d.tenant_key = p_tenant_key;

  RETURN QUERY
  SELECT t.req_id, 'not_found'::text, NULL::text[], NULL::text[]
  FROM pg_temp._rag_access_set_targets t WHERE t.lineage IS NULL;

  FOR v_lineage IN
    SELECT t.lineage, pg_catalog.min(t.req_id::text)::uuid AS first_id
    FROM pg_temp._rag_access_set_targets t
    WHERE t.lineage IS NOT NULL
    GROUP BY t.lineage
    ORDER BY t.lineage
  LOOP
    PERFORM 1 FROM public.documents d
    WHERE (d.lineage_id = v_lineage.lineage OR d.id = v_lineage.lineage) AND d.tenant_key = p_tenant_key
    FOR UPDATE;

    SELECT d.access_groups INTO v_before
    FROM public.documents d
    WHERE (d.lineage_id = v_lineage.lineage OR d.id = v_lineage.lineage) AND d.tenant_key = p_tenant_key
    ORDER BY d.is_current DESC, d.version DESC NULLS LAST
    LIMIT 1;

    IF p_actor_kind = 'admin' AND EXISTS (
      SELECT 1 FROM public.nango_sync_records r
      JOIN public.documents d ON d.id = r.document_id
      WHERE (d.lineage_id = v_lineage.lineage OR d.id = v_lineage.lineage) AND d.tenant_key = p_tenant_key
    ) THEN
      v_outcome := 'skipped_connector';
    ELSE
      UPDATE public.documents d
      SET access_groups = v_keys
      WHERE (d.lineage_id = v_lineage.lineage OR d.id = v_lineage.lineage)
        AND d.tenant_key = p_tenant_key
        AND d.access_groups IS DISTINCT FROM v_keys;
      GET DIAGNOSTICS v_changed = ROW_COUNT;
      IF v_changed > 0 THEN
        v_outcome := 'changed';
        INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, document_id, lineage_id, before_groups, after_groups, reason)
        VALUES (p_tenant_key, 'document_set', p_actor, p_actor_kind, v_lineage.first_id, v_lineage.lineage, v_before, v_keys, p_reason);
      ELSE
        v_outcome := 'unchanged';
      END IF;
    END IF;

    RETURN QUERY
    SELECT t.req_id, v_outcome, v_before,
      CASE WHEN v_outcome = 'skipped_connector' THEN NULL::text[] ELSE v_keys END
    FROM pg_temp._rag_access_set_targets t WHERE t.lineage = v_lineage.lineage;
  END LOOP;

  TRUNCATE pg_temp._rag_access_set_targets;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_set_document_access_groups(text, uuid[], text[], uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_document_access_groups(text, uuid[], text[], uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_chunks_visible(p_tenant_key text, p_chunk_ids uuid[], p_access_keys text[], p_access_all boolean)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_all boolean := COALESCE(p_access_all, false);
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT v_all AND (p_access_keys IS NULL OR pg_catalog.cardinality(p_access_keys) = 0
      OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT DISTINCT c.id
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.id = ANY (p_chunk_ids)
    AND c.tenant_key = p_tenant_key
    AND d.tenant_key = p_tenant_key
    AND c.is_current
    AND c.status IN ('ready', 'variant')
    AND (v_all OR (c.access_groups && p_access_keys AND d.access_groups && p_access_keys));
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_chunks_visible(text, uuid[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_chunks_visible(text, uuid[], text[], boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_documents_visible(p_tenant_key text, p_document_ids uuid[], p_access_keys text[], p_access_all boolean)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_all boolean := COALESCE(p_access_all, false);
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT v_all AND (p_access_keys IS NULL OR pg_catalog.cardinality(p_access_keys) = 0
      OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT d.id
  FROM public.documents d
  WHERE d.id = ANY (p_document_ids)
    AND d.tenant_key = p_tenant_key
    AND (v_all OR d.access_groups && p_access_keys);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_documents_visible(text, uuid[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_documents_visible(text, uuid[], text[], boolean) TO service_role;

ALTER TABLE public.rag_access_audit DROP CONSTRAINT IF EXISTS rag_access_audit_tenant_key_check;
ALTER TABLE public.rag_access_audit ADD CONSTRAINT rag_access_audit_tenant_key_check CHECK (
  tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  OR (tenant_key = 'deployment' AND action = 'enforcement_set')
);

CREATE OR REPLACE FUNCTION public.rag_access_set_enforced(p_enforced boolean)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_old boolean;
  v_new boolean;
BEGIN
  IF p_enforced IS NULL THEN
    RAISE EXCEPTION 'enforced_required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.rag_access_group_settings (id, enforced) VALUES (true, false) ON CONFLICT (id) DO NOTHING;
  SELECT s.enforced INTO v_old FROM public.rag_access_group_settings s WHERE s.id FOR UPDATE;
  IF v_old IS DISTINCT FROM p_enforced THEN
    UPDATE public.rag_access_group_settings s
    SET enforced = p_enforced, updated_at = pg_catalog.now(), updated_by = NULL
    WHERE s.id;
    INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, reason)
    VALUES ('deployment', 'enforcement_set', NULL, 'system', CASE WHEN p_enforced THEN 'enforced_on' ELSE 'enforced_off' END);
  END IF;
  SELECT s.enforced INTO v_new FROM public.rag_access_group_settings s WHERE s.id;
  RETURN v_new;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_set_enforced(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_set_enforced(boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_security_event_record(
  p_tenant_key text,
  p_user_id uuid,
  p_event text,
  p_chunk_ids uuid[],
  p_document_ids uuid[],
  p_request_id text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  INSERT INTO public.rag_access_security_events (tenant_key, user_id, event, chunk_ids, document_ids, request_id)
  VALUES (p_tenant_key, p_user_id, p_event, COALESCE(p_chunk_ids, '{}'::uuid[]), COALESCE(p_document_ids, '{}'::uuid[]), p_request_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_security_event_record(text, uuid, text, uuid[], uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_security_event_record(text, uuid, text, uuid[], uuid[], text) TO service_role;

COMMIT;

-- ==== supabase/migrations/0926_access_rls.sql
-- 0926: access-group helpers for the restrictive client read policies (Phase 4.3, SEC-12; D-09, D-15, A-01, A-02).
-- rag_caller_access_keys() returns the access keys of the calling client: 'all' for everyone, plus 'u:<auth.uid()>' and 'g:<group id>' for
-- each rag_access_group_members row of a signed-in user. It takes no argument and reads identity only from auth.uid(), so a caller cannot
-- name another user. STABLE SECURITY DEFINER (rag_access_group_members is not readable by anon) with an empty search_path. The mode files
-- call it, rag_access_enforced() (0922) and the mode's admin check from sub-selects in policy rag_access_groups_restrict, so each is
-- evaluated once per statement. Both are granted to anon and authenticated here (allow-listed in tests/helpers/security-definer-allow-list.ts);
-- everything else stays service_role only. Not folded into the setup files. Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_caller_access_keys()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN ARRAY['all']::text[]
    ELSE ARRAY['all', 'u:' || auth.uid()::text]::text[] || COALESCE(
      (SELECT pg_catalog.array_agg('g:' || m.group_id::text ORDER BY m.group_id)
         FROM public.rag_access_group_members m
        WHERE m.user_id = auth.uid()),
      ARRAY[]::text[]
    )
  END
$fn$;

REVOKE ALL ON FUNCTION public.rag_caller_access_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_caller_access_keys() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_caller_access_keys() TO anon, authenticated;

REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO anon, authenticated;

COMMIT;

-- ==== supabase/migrations/0926_access_rls.multi-tenant.sql
-- 0926 (multi-tenant): restrictive client read policies for access groups (Phase 4.3, SEC-12; D-04, D-15, A-01, A-02).
-- rag_access_groups_restrict on documents, document_chunks and document_parents, TO anon, authenticated: a row stays readable when
-- enforcement is off, when its access_groups overlap the caller's keys, or when the caller is an owner or admin of the row's own
-- organization (public.is_org_admin(organization_id), which reads auth.uid() only and is already executable by anon). An admin of another
-- organization gets no bypass here; a personal document (organization_id NULL) has no admin bypass, its owner reads it through the
-- 'all' or 'u:' key. Each table carries organization_id itself. Restrictive policies are ANDed with the existing permissive ones, so they
-- only narrow access; no existing policy changes. Idempotent: DROP POLICY IF EXISTS then CREATE POLICY.

BEGIN;

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.documents;
CREATE POLICY rag_access_groups_restrict ON public.documents
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id))
  );

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.document_chunks;
CREATE POLICY rag_access_groups_restrict ON public.document_chunks
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id))
  );

DROP POLICY IF EXISTS rag_access_groups_restrict ON public.document_parents;
CREATE POLICY rag_access_groups_restrict ON public.document_parents
  AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (
    (SELECT public.rag_access_enforced()) IS NOT TRUE
    OR access_groups OPERATOR(pg_catalog.&&) (SELECT public.rag_caller_access_keys())
    OR (organization_id IS NOT NULL AND public.is_org_admin(organization_id))
  );

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0931_access_derived_stores.sql
-- 0931: derived stores under document access groups (SEC-13, D-23, D-24, D-31, A-05, A-06). Part one (04.3-12): the semantic cache.
-- rag_cache_check: the 0603 body (the newest definition) gains p_access_keys text[] and p_access_all boolean, appended with defaults NULL
-- and false. With no keys it returns what 0603 returned, unless public.rag_access_enforced() (0922) is true: then it raises
-- access_scope_required (42501). An empty key array (or one holding NULL) raises access_keys_empty (22023). After the 0603 currency check
-- (a hit whose sources are no longer current and ready is still deleted), a hit is served only when every document_id in source_versions is a
-- document of the tenant whose access_groups overlap the keys (p_access_all skips the check). An entry that is current but not visible to
-- this caller is a miss with a NULL distance and is not deleted (RESEARCH Pitfall 10): it stays valid for callers who can see its sources.
-- No access-label column is added to rag_semantic_cache and rag_cache_store is unchanged: the live per-document recheck over source_versions
-- replaces the stored union of source labels for the cache (A-06, RESEARCH R-6). A refusal entry has no sources and is protected by the key
-- hash alone, which carries the caller's effective access set (A-05, src/lib/rag/cache/keys.ts).
-- rag_semantic_cache_on_access_update (SECURITY DEFINER, like the 0603 trigger functions, so invalidation works for any writer) and the
-- statement trigger rag_access_semantic_cache_update delete every cache row of each tenant whose documents changed access_groups (D-24). A
-- transition-table trigger cannot have a column list, so the body compares the column. The 0603 trigger function
-- rag_semantic_cache_on_documents_update is not replaced. The trigger is created only while rag_semantic_cache exists. The vector-sync outbox
-- is not touched here (Phase 7 plan 07-38, A-14).
-- Every rag_cache_check overload is dropped by catalog lookup first, so exactly one exists. SECURITY INVOKER, VOLATILE, empty search_path,
-- executable by service_role only. Re-running 0603 or a setup file requires re-running this file. Idempotent; not folded into the setup
-- files.

BEGIN;

DO $drop_overloads$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rag_cache_check'
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature::text;
  END LOOP;
END
$drop_overloads$;

CREATE OR REPLACE FUNCTION public.rag_cache_check(
  p_tenant_key text,
  p_key_hash text,
  p_profile text,
  p_embedding public.halfvec,
  p_max_distance double precision,
  p_access_keys text[] DEFAULT NULL,
  p_access_all boolean DEFAULT false
)
RETURNS TABLE (hit boolean, entry_id uuid, distance double precision, answer jsonb, is_refusal boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_id uuid;
  v_distance double precision;
  v_answer jsonb;
  v_is_refusal boolean;
  v_sources jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  -- D-09, D-10: no keys while enforcement is on is refused; an empty key array never means "no filter".
  IF p_access_keys IS NULL AND public.rag_access_enforced() THEN
    RAISE EXCEPTION 'access_scope_required' USING ERRCODE = '42501';
  END IF;
  IF p_access_keys IS NOT NULL AND (pg_catalog.cardinality(p_access_keys) = 0 OR pg_catalog.array_position(p_access_keys, NULL::text) IS NOT NULL) THEN
    RAISE EXCEPTION 'access_keys_empty' USING ERRCODE = '22023';
  END IF;

  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'malformed cache key hash' USING ERRCODE = '22023';
  END IF;
  IF p_profile IS NULL OR pg_catalog.btrim(p_profile) = '' OR pg_catalog.length(p_profile) > 200 THEN
    RAISE EXCEPTION 'malformed embedding profile id' USING ERRCODE = '22023';
  END IF;
  IF p_embedding IS NULL THEN
    RAISE EXCEPTION 'embedding is required' USING ERRCODE = '22023';
  END IF;
  IF p_max_distance IS NULL OR p_max_distance < 0 OR p_max_distance > 2 OR p_max_distance <> p_max_distance THEN
    RAISE EXCEPTION 'max distance must be within 0..2' USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT c.id, c.embedding, c.answer, c.is_refusal, c.source_versions
    FROM public.rag_semantic_cache c
    WHERE c.tenant_key = p_tenant_key
      AND c.key_hash = p_key_hash
      AND c.embedding_profile_id = p_profile
      AND c.expires_at > pg_catalog.now()
      AND public.vector_dims(c.embedding) = public.vector_dims(p_embedding)
  )
  SELECT k.id, (k.embedding OPERATOR(public.<=>) p_embedding)::double precision, k.answer, k.is_refusal, k.source_versions
  INTO v_id, v_distance, v_answer, v_is_refusal, v_sources
  FROM candidates k
  ORDER BY 2, k.id
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::double precision, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;
  IF v_distance > p_max_distance THEN
    RETURN QUERY SELECT false, NULL::uuid, v_distance, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;

  IF NOT public.rag_cache_sources_current(p_tenant_key, v_sources) THEN
    DELETE FROM public.rag_semantic_cache c WHERE c.id = v_id AND c.tenant_key = p_tenant_key;
    RETURN QUERY SELECT false, NULL::uuid, v_distance, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;

  -- D-23: every source must be visible to this caller. Not visible is a miss without delete and without a distance (Pitfall 10).
  IF p_access_keys IS NOT NULL AND NOT COALESCE(p_access_all, false) AND EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_sources) AS s(document_id uuid, version integer)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = s.document_id
        AND d.tenant_key = p_tenant_key
        AND d.access_groups OPERATOR(pg_catalog.&&) p_access_keys
    )
  ) THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::double precision, NULL::jsonb, NULL::boolean;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_id, v_distance, v_answer, v_is_refusal;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_cache_check(text, text, text, public.halfvec, double precision, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_cache_check(text, text, text, public.halfvec, double precision, text[], boolean) TO service_role;

-- D-24: a relabel deletes every cache row of the tenants whose documents changed access_groups, in the same transaction.
CREATE OR REPLACE FUNCTION public.rag_semantic_cache_on_access_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  DELETE FROM public.rag_semantic_cache c
  WHERE c.tenant_key IN (
    SELECT t.tenant_key
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    CROSS JOIN LATERAL (VALUES (o.tenant_key), (n.tenant_key)) AS t(tenant_key)
    WHERE t.tenant_key IS NOT NULL
      AND o.access_groups IS DISTINCT FROM n.access_groups
  );
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_access_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_access_update() TO service_role;

DO $access_trigger$
BEGIN
  DROP TRIGGER IF EXISTS rag_access_semantic_cache_update ON public.documents;
  IF to_regclass('public.rag_semantic_cache') IS NOT NULL THEN
    CREATE TRIGGER rag_access_semantic_cache_update
      AFTER UPDATE ON public.documents
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION public.rag_semantic_cache_on_access_update();
  ELSE
    RAISE NOTICE '[RAG Access] rag_semantic_cache is absent; the access invalidation trigger was not created';
  END IF;
END
$access_trigger$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0950_calc_review_reasons.sql
-- 0950: Phase 5.2.1 calculation review reasons calc_mismatch and calc_unverified (GEN-17, D-55, D-90, D-02).
-- Widens every review-reason check that Phase 5.2 left (0944) by exactly these two values; no earlier value is dropped:
--   rag_answer_records.review_reasons  feedback_negative, groundedness_flagged, claim_unsupported, calc_mismatch, calc_unverified;
--   rag_review_items.reasons           the 0944 list plus calc_mismatch and calc_unverified.
-- rag_mine_failed_queries is rebuilt from its 0944 body: an answer record on the same trace_id and tenant_key whose review_reasons
-- holds calc_mismatch or calc_unverified flags the row; both reasons rank right after claim_unsupported (calc_mismatch first) and
-- before the retrieval reasons. rag_enqueue_review_item is rebuilt from its 0944 body with only its accepted reasons extended (the
-- immediate route for channels without an answer record). Security attributes, the empty search_path and the service_role-only
-- grants are unchanged and re-asserted here. 0967 re-creates the rag_review_items check later in file order and lists the two
-- values too, so a database built in order keeps them.
-- One common file (the values do not differ by deployment mode). Not folded into the setup files (D-02). Idempotent.

BEGIN;

ALTER TABLE public.rag_answer_records DROP CONSTRAINT IF EXISTS rag_answer_records_review_reasons_check;
ALTER TABLE public.rag_answer_records ADD CONSTRAINT rag_answer_records_review_reasons_check
  CHECK (review_reasons <@ ARRAY['feedback_negative', 'groundedness_flagged', 'claim_unsupported', 'calc_mismatch', 'calc_unverified']::text[]);

ALTER TABLE public.rag_review_items DROP CONSTRAINT IF EXISTS rag_review_items_reasons_check;
ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_reasons_check
  CHECK (reasons <@ ARRAY['feedback_negative', 'refusal_disputed', 'groundedness_flagged', 'refused_high_score', 'zero_results',
                          'low_score', 'no_source_opened', 'claim_unsupported', 'output_guard', 'version_conflict',
                          'representative', 're_review', 'calc_mismatch', 'calc_unverified']::text[]);

CREATE OR REPLACE FUNCTION public.rag_mine_failed_queries(p_since timestamptz, p_until timestamptz, p_config jsonb)
RETURNS TABLE (tenant_key text, reason text, inserted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit integer;
  v_ttl_days integer;
  v_low_similarity double precision;
  v_low_rerank double precision;
  v_high_similarity double precision;
  v_high_rerank double precision;
  v_source_signal boolean;
  v_window timestamptz;
  v_path text[];
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR p_since >= p_until THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = '22023', DETAIL = 'p_since and p_until are required and p_since must be before p_until';
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'p_config must be a JSON object';
  END IF;

  FOREACH v_path SLICE 1 IN ARRAY ARRAY[
    ARRAY['per_tenant_limit', ''],
    ARRAY['open_item_ttl_days', ''],
    ARRAY['low_score_ceiling', 'similarity'],
    ARRAY['low_score_ceiling', 'rerank'],
    ARRAY['refused_high_score_floor', 'similarity'],
    ARRAY['refused_high_score_floor', 'rerank']
  ] LOOP
    IF jsonb_typeof(p_config #> array_remove(v_path, '')) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = array_to_string(array_remove(v_path, ''), '.') || ' must be a number';
    END IF;
  END LOOP;
  IF p_config ? 'source_open_signal' AND jsonb_typeof(p_config -> 'source_open_signal') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'source_open_signal must be a boolean';
  END IF;

  IF (p_config ->> 'per_tenant_limit')::numeric NOT BETWEEN 1 AND 1000
     OR (p_config ->> 'per_tenant_limit')::numeric <> trunc((p_config ->> 'per_tenant_limit')::numeric) THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'per_tenant_limit must be an integer from 1 to 1000';
  END IF;
  IF (p_config ->> 'open_item_ttl_days')::numeric NOT BETWEEN 1 AND 3650
     OR (p_config ->> 'open_item_ttl_days')::numeric <> trunc((p_config ->> 'open_item_ttl_days')::numeric) THEN
    RAISE EXCEPTION 'invalid_config' USING ERRCODE = '22023', DETAIL = 'open_item_ttl_days must be an integer from 1 to 3650';
  END IF;

  v_limit := (p_config ->> 'per_tenant_limit')::integer;
  v_ttl_days := (p_config ->> 'open_item_ttl_days')::integer;
  v_low_similarity := (p_config #>> '{low_score_ceiling,similarity}')::double precision;
  v_low_rerank := (p_config #>> '{low_score_ceiling,rerank}')::double precision;
  v_high_similarity := (p_config #>> '{refused_high_score_floor,similarity}')::double precision;
  v_high_rerank := (p_config #>> '{refused_high_score_floor,rerank}')::double precision;
  v_source_signal := coalesce((p_config ->> 'source_open_signal')::boolean, false);
  v_window := pg_catalog.date_trunc('week', p_until, 'UTC');

  RETURN QUERY
  WITH source_rows AS (
    SELECT l.id, l.tenant_key, l.trace_id, l.query_fingerprint, l.created_at, l.outcome, l.refusal_decision, l.top_score,
           l.candidate_count, l.feedback_vote, l.feedback_kind, l.source_opened_count,
           (l.candidates @? '$[*].rerank_score') AS reranked
    FROM public.rag_retrieval_log l
    WHERE l.created_at >= p_since
      AND l.created_at < p_until
      AND l.query_masked IS NOT NULL
      AND l.query_fingerprint IS NOT NULL
      AND l.tenant_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.rag_tenant_feedback_settings s
        WHERE s.tenant_key = l.tenant_key AND s.retrieval_log <> 'inherit'
      )
  ),
  flagged AS (
    SELECT r.id, r.tenant_key, r.query_fingerprint, r.created_at,
      coalesce(
        (r.feedback_vote = -1 AND r.feedback_kind IN ('answer', 'embed'))
        OR EXISTS (
          SELECT 1 FROM public.rag_answer_records a
          WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND a.feedback ->> 'vote' = 'not_helpful'
        ),
        false) AS f_negative,
      coalesce(r.feedback_vote = -1 AND r.feedback_kind = 'refusal', false) AS f_disputed,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND a.groundedness ->> 'label' = 'possibly_unreliable'
      ) AS f_groundedness,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'claim_unsupported' = ANY (a.review_reasons)
      ) AS f_claim,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'calc_mismatch' = ANY (a.review_reasons)
      ) AS f_calc_mismatch,
      EXISTS (
        SELECT 1 FROM public.rag_answer_records a
        WHERE a.trace_id = r.trace_id AND a.tenant_key = r.tenant_key AND 'calc_unverified' = ANY (a.review_reasons)
      ) AS f_calc_unverified,
      coalesce(
        (r.outcome = 'refused_no_context' OR r.refusal_decision = 'refuse')
        AND r.top_score >= CASE WHEN r.reranked THEN v_high_rerank ELSE v_high_similarity END,
        false) AS f_high,
      coalesce(r.candidate_count = 0 AND r.outcome <> 'kb_unavailable', false) AS f_zero,
      coalesce(r.outcome = 'answered' AND r.top_score < CASE WHEN r.reranked THEN v_low_rerank ELSE v_low_similarity END, false) AS f_low,
      coalesce(v_source_signal AND r.outcome = 'answered' AND r.source_opened_count = 0, false) AS f_no_source
    FROM source_rows r
  ),
  grouped AS (
    SELECT f.id, f.tenant_key, f.query_fingerprint, f.created_at,
      row_number() OVER (PARTITION BY f.tenant_key, f.query_fingerprint ORDER BY f.created_at DESC, f.id DESC) AS newest,
      count(*) OVER g AS occurrences,
      bool_or(f.f_negative) OVER g AS g_negative,
      bool_or(f.f_disputed) OVER g AS g_disputed,
      bool_or(f.f_groundedness) OVER g AS g_groundedness,
      bool_or(f.f_claim) OVER g AS g_claim,
      bool_or(f.f_calc_mismatch) OVER g AS g_calc_mismatch,
      bool_or(f.f_calc_unverified) OVER g AS g_calc_unverified,
      bool_or(f.f_high) OVER g AS g_high,
      bool_or(f.f_zero) OVER g AS g_zero,
      bool_or(f.f_low) OVER g AS g_low,
      bool_or(f.f_no_source) OVER g AS g_no_source
    FROM flagged f
    WHERE f.f_negative OR f.f_disputed OR f.f_groundedness OR f.f_claim OR f.f_calc_mismatch OR f.f_calc_unverified
       OR f.f_high OR f.f_zero OR f.f_low
    WINDOW g AS (PARTITION BY f.tenant_key, f.query_fingerprint)
  ),
  kept AS (
    SELECT g.id, g.tenant_key, g.query_fingerprint, g.created_at, g.occurrences,
      array_remove(ARRAY[
        CASE WHEN g.g_negative THEN 'feedback_negative' END,
        CASE WHEN g.g_disputed THEN 'refusal_disputed' END,
        CASE WHEN g.g_groundedness THEN 'groundedness_flagged' END,
        CASE WHEN g.g_claim THEN 'claim_unsupported' END,
        CASE WHEN g.g_calc_mismatch THEN 'calc_mismatch' END,
        CASE WHEN g.g_calc_unverified THEN 'calc_unverified' END,
        CASE WHEN g.g_high THEN 'refused_high_score' END,
        CASE WHEN g.g_zero THEN 'zero_results' END,
        CASE WHEN g.g_low THEN 'low_score' END,
        CASE WHEN g.g_no_source THEN 'no_source_opened' END
      ]::text[], NULL) AS reasons,
      CASE
        WHEN g.g_negative THEN 1
        WHEN g.g_disputed THEN 2
        WHEN g.g_groundedness THEN 3
        WHEN g.g_claim THEN 4
        WHEN g.g_calc_mismatch THEN 5
        WHEN g.g_calc_unverified THEN 6
        WHEN g.g_high THEN 7
        WHEN g.g_zero THEN 8
        ELSE 9
      END AS priority
    FROM grouped g
    WHERE g.newest = 1
  ),
  selected AS (
    SELECT k.*
    FROM (
      SELECT k0.*,
        row_number() OVER (PARTITION BY k0.tenant_key ORDER BY k0.priority, k0.occurrences DESC, k0.created_at DESC, k0.id) AS tenant_rank
      FROM kept k0
    ) k
    WHERE k.tenant_rank <= v_limit
  ),
  ins AS (
    INSERT INTO public.rag_review_items AS i (
      tenant_key, retrieval_log_id, trace_id, user_id, chat_id,
      query_masked, query_fingerprint, query_language, query_language_confidence, answer_language, chunk_languages,
      channel, outcome, candidates, retrieval_config_hash, reasons, occurrences,
      status, mining_window, mined_at, expires_at
    )
    SELECT l.tenant_key, l.id, l.trace_id, l.user_id, l.chat_id,
      l.query_masked, l.query_fingerprint, l.query_language, l.query_language_confidence, l.answer_language, l.chunk_languages,
      l.channel, l.outcome, l.candidates, l.retrieval_config_hash, s.reasons, s.occurrences::integer,
      'open', v_window, now(), now() + make_interval(days => v_ttl_days)
    FROM selected s
    JOIN public.rag_retrieval_log l ON l.id = s.id AND l.tenant_key = s.tenant_key
    ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
    RETURNING i.tenant_key, i.query_fingerprint
  )
  SELECT s.tenant_key, r.reason, count(n.query_fingerprint)::integer
  FROM selected s
  CROSS JOIN LATERAL unnest(s.reasons) AS r(reason)
  LEFT JOIN ins n ON n.tenant_key = s.tenant_key AND n.query_fingerprint = s.query_fingerprint
  GROUP BY s.tenant_key, r.reason
  ORDER BY s.tenant_key, r.reason;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_mine_failed_queries(timestamptz, timestamptz, jsonb) TO service_role;

-- One review item at once for a finding that must not wait for the weekly mining. p_source: {chunk_ids, document_ids}, UUID strings only,
-- at most 50 each, at least one id, every id a chunk or document of p_tenant_key. p_snapshot: optional detector and trace_id, no other key.
-- query_masked is empty (no question), query_fingerprint is sha256 hex of the reason and the sorted ids, mining_window the UTC week of
-- the call, so a repeated finding in the same week returns the existing item. A tenant whose retrieval_log setting is off gets no item.
CREATE OR REPLACE FUNCTION public.rag_enqueue_review_item(p_tenant_key text, p_reason text, p_source jsonb, p_snapshot jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_snapshot_in jsonb := coalesce(p_snapshot, '{}'::jsonb);
  v_key text;
  v_ids jsonb;
  v_chunks text[] := '{}'::text[];
  v_documents text[] := '{}'::text[];
  v_detector text;
  v_trace text;
  v_found integer;
  v_fingerprint text;
  v_window timestamptz;
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_reason IS NULL OR p_reason NOT IN ('claim_unsupported', 'output_guard', 'version_conflict', 'calc_mismatch', 'calc_unverified') THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR pg_catalog.jsonb_typeof(p_source) <> 'object' THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'p_source must be a JSON object';
  END IF;
  IF pg_catalog.jsonb_typeof(v_snapshot_in) <> 'object' THEN
    RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'p_snapshot must be a JSON object';
  END IF;

  FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(p_source) AS k LOOP
    IF v_key NOT IN ('chunk_ids', 'document_ids') THEN
      RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'p_source takes chunk_ids and document_ids only';
    END IF;
    v_ids := p_source -> v_key;
    IF pg_catalog.jsonb_typeof(v_ids) <> 'array' OR pg_catalog.jsonb_array_length(v_ids) > 50
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_ids) AS e
         WHERE pg_catalog.jsonb_typeof(e) <> 'string' OR pg_catalog.lower(e #>> '{}') !~ v_uuid
       ) THEN
      RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'ids must be at most 50 UUID strings';
    END IF;
  END LOOP;

  SELECT coalesce(pg_catalog.array_agg(x.id ORDER BY x.id COLLATE "C"), '{}'::text[]) INTO v_chunks
  FROM (SELECT DISTINCT pg_catalog.lower(e #>> '{}') AS id FROM pg_catalog.jsonb_array_elements(coalesce(p_source -> 'chunk_ids', '[]'::jsonb)) AS e) AS x;
  SELECT coalesce(pg_catalog.array_agg(x.id ORDER BY x.id COLLATE "C"), '{}'::text[]) INTO v_documents
  FROM (SELECT DISTINCT pg_catalog.lower(e #>> '{}') AS id FROM pg_catalog.jsonb_array_elements(coalesce(p_source -> 'document_ids', '[]'::jsonb)) AS e) AS x;
  IF pg_catalog.cardinality(v_chunks) + pg_catalog.cardinality(v_documents) = 0 THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = '22023', DETAIL = 'at least one chunk or document id is required';
  END IF;

  FOR v_key IN SELECT k FROM pg_catalog.jsonb_object_keys(v_snapshot_in) AS k LOOP
    IF v_key NOT IN ('detector', 'trace_id') THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'p_snapshot takes detector and trace_id only';
    END IF;
  END LOOP;
  IF v_snapshot_in ? 'detector' THEN
    IF pg_catalog.jsonb_typeof(v_snapshot_in -> 'detector') <> 'string' OR (v_snapshot_in ->> 'detector') !~ '^[a-z][a-z0-9_]{0,31}$' THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'detector must be a short lower-case token';
    END IF;
    v_detector := v_snapshot_in ->> 'detector';
  END IF;
  IF v_snapshot_in ? 'trace_id' THEN
    IF pg_catalog.jsonb_typeof(v_snapshot_in -> 'trace_id') <> 'string' OR (v_snapshot_in ->> 'trace_id') !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
      RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023', DETAIL = 'trace_id must be an id token';
    END IF;
    v_trace := v_snapshot_in ->> 'trace_id';
  END IF;

  SELECT count(*) INTO v_found
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.id = ANY (v_chunks::uuid[])
    AND d.tenant_key = p_tenant_key
    AND (c.tenant_key IS NULL OR c.tenant_key = p_tenant_key);
  IF v_found <> pg_catalog.cardinality(v_chunks) THEN
    RAISE EXCEPTION 'source_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every chunk id must be a chunk of the tenant';
  END IF;
  SELECT count(*) INTO v_found FROM public.documents d WHERE d.id = ANY (v_documents::uuid[]) AND d.tenant_key = p_tenant_key;
  IF v_found <> pg_catalog.cardinality(v_documents) THEN
    RAISE EXCEPTION 'source_not_in_tenant' USING ERRCODE = '22023', DETAIL = 'every document id must be a document of the tenant';
  END IF;

  IF EXISTS (SELECT 1 FROM public.rag_tenant_feedback_settings s WHERE s.tenant_key = p_tenant_key AND s.retrieval_log = 'off') THEN
    RETURN NULL;
  END IF;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_reason || E'\n' || 'chunks:' || pg_catalog.array_to_string(v_chunks, ',') || E'\n' || 'documents:' || pg_catalog.array_to_string(v_documents, ','),
      'UTF8')),
    'hex');
  v_window := pg_catalog.date_trunc('week', pg_catalog.now(), 'UTC');

  INSERT INTO public.rag_review_items AS i (tenant_key, trace_id, query_masked, query_fingerprint, reasons, snapshot, status, mining_window, mined_at)
  VALUES (
    p_tenant_key, v_trace, '', v_fingerprint, ARRAY[p_reason]::text[],
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'reason', p_reason, 'detector', v_detector, 'trace_id', v_trace,
      'chunk_ids', pg_catalog.to_jsonb(v_chunks), 'document_ids', pg_catalog.to_jsonb(v_documents))),
    'open', v_window, pg_catalog.now()
  )
  ON CONFLICT ON CONSTRAINT rag_review_items_tenant_fingerprint_window_key DO NOTHING
  RETURNING i.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT i.id INTO v_id FROM public.rag_review_items i
    WHERE i.tenant_key = p_tenant_key AND i.query_fingerprint = v_fingerprint AND i.mining_window = v_window;
  END IF;
  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_enqueue_review_item(text, text, jsonb, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r19 delta (the lines train 36 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r19_service_role_only$
BEGIN
  IF to_regprocedure('public.rag_access_groups_propagate()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_propagate() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_groups_propagate_table_rows()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_table_rows() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_table_rows() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_groups_propagate_translations()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_groups_propagate_translations() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_groups_propagate_translations() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_user_in_tenant(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_user_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_user_in_tenant(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_semantic_cache_on_access_update()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_semantic_cache_on_access_update() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_semantic_cache_on_access_update() TO service_role;
  END IF;
  IF to_regprocedure('public.rag_documents_access_inherit()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_documents_access_inherit() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_documents_access_inherit() TO service_role;
  END IF;
END
$r19_service_role_only$;

DO $r19_authenticated_callable$
BEGIN
  IF to_regprocedure('public.rag_access_enforced()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.rag_caller_access_keys()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_caller_access_keys() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.rag_caller_access_keys() TO authenticated, anon, service_role;
  END IF;
  IF to_regprocedure('public.rag_caller_is_access_admin()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_caller_is_access_admin() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.rag_caller_is_access_admin() TO authenticated, anon, service_role;
  END IF;
END
$r19_authenticated_callable$;

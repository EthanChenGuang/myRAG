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

-- Key checks (D-02) on every labelled table. The expression is the one of rag_access_keys_valid written without a function call: a CHECK
-- runs with the writing role's privileges, and the function stays service_role only, so a client insert would otherwise fail with
-- permission denied (found by plan 04's client cases). Non-empty, no NULL element, each key 'all', 'g:<uuid>' or 'u:<uuid>', 'all' alone; the
-- comma count rules out an element that itself holds a comma. A constraint of the earlier form is replaced; absent tables are skipped.

DO $access_checks$
DECLARE
  v_table text;
  v_name text;
  v_def text;
  v_expr constant text := 'pg_catalog.cardinality(access_groups) > 0'
    || ' AND pg_catalog.array_position(access_groups, NULL::text) IS NULL'
    || ' AND pg_catalog.array_to_string(access_groups, '','') ~ ''^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*)$'''
    || ' AND pg_catalog.length(pg_catalog.array_to_string(access_groups, '',''))'
    || ' - pg_catalog.length(pg_catalog.replace(pg_catalog.array_to_string(access_groups, '',''), '','', '''')) = pg_catalog.cardinality(access_groups) - 1';
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

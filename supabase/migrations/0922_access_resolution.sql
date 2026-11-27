-- 0922: access resolution helpers (Phase 4.3, D-09, D-10, A-02, A-03).
-- rag_access_enforced() returns the enforced flag of the single rag_access_group_settings row (0920), false when the row is missing. It is
-- STABLE SECURITY DEFINER (the settings table is service_role only) with an empty search_path. hybrid_search_chunks (0930) raises
-- access_scope_required when it is true and no access keys were sent. Executable by service_role only here; the RLS plan (04.3-06) grants it
-- to the client roles. Not folded into the setup files. Idempotent.
-- Plan 04.3-05 completes the file with the service-role functions the phase calls. Each takes the tenant key first and opens with
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

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_access_enforced()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT COALESCE((SELECT s.enforced FROM public.rag_access_group_settings s WHERE s.id), false)
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_enforced() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_enforced() TO service_role;


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

COMMIT;

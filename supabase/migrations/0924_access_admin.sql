-- 0924: access group administration (Phase 4.3, SEC-12; D-01, D-04, D-16, D-17, D-18, D-28, D-29, A-07, D-31). Plan 04.3-20.
-- The service-role functions behind /api/rag/access-groups/* (D-28: both surfaces call the same routes). Each takes the tenant key first and opens
-- with rag_assert_tenant_key; the tenant mode is read from the key prefix (o:, s:, u:), so the file has no mode variant. A u: (personal) tenant has
-- no groups. Errors raise ERRCODE 22023 (23505 for group_exists and member_exists) with the reason word first, which the TypeScript layer maps to the
-- codes of UI-SPEC 8.2: invalid_key, reserved_key, group_exists, invalid_name, personal_tenant, not_found, member_exists, not_a_workspace_member,
-- count_required, actor_required, invalid_filter, invalid_cursor.
-- Groups: rag_access_group_create, _rename, _impact, _delete and rag_access_groups_list (50 per page, ordered by name, member and current-document
-- counts). Deletion (D-18) recounts the documents restricted to the group alone inside the function and refuses with count_required unless the caller
-- passes that count; it removes the key from every version of every affected lineage, sets a lineage whose label would become empty to u:<uploader>
-- of its current version (the deleting admin's key when the uploader is unknown), never to all, writes one document_fallback row (reason
-- group_deleted) per fallen-back lineage and one document_set row (reason group_deleted) per lineage that kept another key, then one group_delete
-- row, and deletes the group so members and connector mappings cascade. Connector-managed lineages are relabelled too: removing a key only narrows.
-- Members: rag_access_member_add, _remove, rag_access_group_members_list, rag_access_member_candidates. Member audit rows carry the member's key
-- u:<id> in after_groups (add) or before_groups (remove); the audit table has no person column. Candidates need at least 2 characters, match the
-- display name or e-mail with an escaped ILIKE, return at most 20 people of the tenant only and flag those already in the group.
-- rag_access_my_groups(tenant, user): is_admin, the user's own groups and the groups they may assign at upload (every group of the tenant for an
-- admin); a non-admin learns nothing about other groups (D-16, D-29).
-- Documents: rag_access_document_audience, rag_access_documents_list (filters restricted, uploader_only, everyone, all; file-name search; 50 rows per
-- page with an opaque cursor) and rag_access_documents_counts read current documents of the tenant only. The audience kind is everyone for {all},
-- uploader_only when the array is exactly the uploader's key, else groups; people_count counts the other u: keys; fallback_reason is the reason
-- of the latest label audit row of the lineage when that row produced the current label and is a fallback (group_deleted, unmapped_source,
-- source_error); connector_managed follows the setter's rule (a nango_sync_records row links any version of the lineage).
-- Security (A-04, D-31): SECURITY INVOKER except the functions that read auth.users (rag_access_group_members_list,
-- rag_access_member_candidates: DEFINER, guarded entries in 0410); SET search_path = '' with qualified names; REVOKE from PUBLIC, anon and
-- authenticated, GRANT to service_role. No address of anyone outside the tenant is returned. Not folded into the setup files. Idempotent.

BEGIN;

-- Shared helpers.

CREATE OR REPLACE FUNCTION public.rag_access_like_pattern(p_query text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_like_pattern(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_like_pattern(text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_group_in_tenant(p_tenant_key text, p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.rag_access_groups g WHERE g.id = p_group_id AND g.tenant_key = p_tenant_key)
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_in_tenant(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_in_tenant(text, uuid) TO service_role;

-- Groups.

CREATE OR REPLACE FUNCTION public.rag_access_group_create(p_tenant_key text, p_key text, p_name text, p_actor uuid)
RETURNS TABLE (id uuid, key text, name text, source text, created_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_prefix text := pg_catalog.left(p_tenant_key, 2);
  v_org uuid;
  v_key text := pg_catalog.btrim(p_key);
  v_name text := pg_catalog.btrim(p_name);
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = '22023';
  END IF;
  IF v_prefix = 'u:' THEN
    RAISE EXCEPTION 'personal_tenant' USING ERRCODE = '22023';
  END IF;
  IF v_key IS NULL OR v_key !~ '^[a-z0-9][a-z0-9-]{0,62}$' THEN
    RAISE EXCEPTION 'invalid_key' USING ERRCODE = '22023';
  END IF;
  IF v_key = 'all' THEN
    RAISE EXCEPTION 'reserved_key' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NULL OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rag_access_groups g WHERE g.tenant_key = p_tenant_key AND g.key = v_key) THEN
    RAISE EXCEPTION 'group_exists' USING ERRCODE = '23505';
  END IF;

  IF v_prefix = 'o:' THEN
    v_org := pg_catalog.substr(p_tenant_key, 3)::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_org) THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.organizations o WHERE o.id = v_org AND COALESCE((pg_catalog.to_jsonb(o) ->> 'is_personal')::boolean, false)
    ) THEN
      RAISE EXCEPTION 'personal_tenant' USING ERRCODE = '22023';
    END IF;
    BEGIN
      INSERT INTO public.rag_access_groups (key, name, organization_id, created_by)
      VALUES (v_key, v_name, v_org, p_actor)
      RETURNING public.rag_access_groups.id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'group_exists' USING ERRCODE = '23505';
    END;
  ELSE
    BEGIN
      INSERT INTO public.rag_access_groups (key, name, created_by)
      VALUES (v_key, v_name, p_actor)
      RETURNING public.rag_access_groups.id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'group_exists' USING ERRCODE = '23505';
    END;
  END IF;

  INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id)
  VALUES (p_tenant_key, 'group_create', p_actor, 'admin', v_id);

  RETURN QUERY SELECT g.id, g.key, g.name, g.source, g.created_at FROM public.rag_access_groups g WHERE g.id = v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_create(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_create(text, text, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_group_impact(p_tenant_key text, p_group_id uuid)
RETURNS TABLE (only_count bigint, shared_count bigint, member_count bigint, mapping_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text := 'g:' || p_group_id::text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_group_id IS NULL OR NOT public.rag_access_group_in_tenant(p_tenant_key, p_group_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT pg_catalog.count(*) FROM public.documents d
     WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups = ARRAY[v_key]),
    (SELECT pg_catalog.count(*) FROM public.documents d
     WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups @> ARRAY[v_key] AND pg_catalog.cardinality(d.access_groups) > 1),
    (SELECT pg_catalog.count(*) FROM public.rag_access_group_members m WHERE m.group_id = p_group_id),
    (SELECT pg_catalog.count(*) FROM public.rag_connector_group_map c WHERE c.group_id = p_group_id AND c.tenant_key = p_tenant_key);
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_impact(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_impact(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_group_delete(p_tenant_key text, p_group_id uuid, p_expected_only_count bigint, p_actor uuid)
RETURNS TABLE (fell_back bigint, relabelled bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_key text := 'g:' || p_group_id::text;
  v_only bigint;
  v_lineage record;
  v_before text[];
  v_after text[];
  v_uploader uuid;
  v_fallback text[];
  v_fell_back bigint := 0;
  v_relabelled bigint := 0;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.rag_access_groups g WHERE g.id = p_group_id AND g.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;

  -- Lock every version that carries the key before counting, so the count and the writes see the same rows.
  PERFORM 1 FROM public.documents d WHERE d.tenant_key = p_tenant_key AND d.access_groups @> ARRAY[v_key] FOR UPDATE;
  SELECT pg_catalog.count(*) INTO v_only
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups = ARRAY[v_key];
  IF p_expected_only_count IS NULL OR p_expected_only_count IS DISTINCT FROM v_only THEN
    RAISE EXCEPTION 'count_required: %', v_only USING ERRCODE = '22023';
  END IF;

  FOR v_lineage IN
    SELECT DISTINCT COALESCE(d.lineage_id, d.id) AS lineage
    FROM public.documents d
    WHERE d.tenant_key = p_tenant_key AND d.access_groups @> ARRAY[v_key]
    ORDER BY 1
  LOOP
    SELECT d.access_groups, d.user_id INTO v_before, v_uploader
    FROM public.documents d
    WHERE (d.lineage_id = v_lineage.lineage OR d.id = v_lineage.lineage) AND d.tenant_key = p_tenant_key
    ORDER BY d.is_current DESC, d.version DESC NULLS LAST
    LIMIT 1;
    v_fallback := ARRAY['u:' || COALESCE(v_uploader, p_actor)::text];

    UPDATE public.documents d
    SET access_groups = CASE
      WHEN pg_catalog.cardinality(pg_catalog.array_remove(d.access_groups, v_key)) > 0 THEN pg_catalog.array_remove(d.access_groups, v_key)
      ELSE v_fallback
    END
    WHERE (d.lineage_id = v_lineage.lineage OR d.id = v_lineage.lineage)
      AND d.tenant_key = p_tenant_key
      AND d.access_groups @> ARRAY[v_key];

    v_after := pg_catalog.array_remove(v_before, v_key);
    IF v_before @> ARRAY[v_key] AND COALESCE(pg_catalog.cardinality(v_after), 0) = 0 THEN
      v_fell_back := v_fell_back + 1;
      INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, document_id, lineage_id, before_groups, after_groups, reason)
      VALUES (p_tenant_key, 'document_fallback', p_actor, 'admin', p_group_id, v_lineage.lineage, v_lineage.lineage, v_before, v_fallback, 'group_deleted');
    ELSE
      IF NOT (v_before @> ARRAY[v_key]) THEN
        v_after := v_before;
      END IF;
      v_relabelled := v_relabelled + 1;
      INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, document_id, lineage_id, before_groups, after_groups, reason)
      VALUES (p_tenant_key, 'document_set', p_actor, 'admin', p_group_id, v_lineage.lineage, v_lineage.lineage, v_before, v_after, 'group_deleted');
    END IF;
  END LOOP;

  INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, before_groups, after_groups)
  VALUES (p_tenant_key, 'group_delete', p_actor, 'admin', p_group_id, ARRAY[v_key], NULL);

  DELETE FROM public.rag_access_groups g WHERE g.id = p_group_id AND g.tenant_key = p_tenant_key;

  RETURN QUERY SELECT v_fell_back, v_relabelled;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_delete(text, uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_delete(text, uuid, bigint, uuid) TO service_role;

-- Members.

CREATE OR REPLACE FUNCTION public.rag_access_member_add(p_tenant_key text, p_group_id uuid, p_user_id uuid, p_actor uuid)
RETURNS TABLE (group_id uuid, user_id uuid, added_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_group_id IS NULL OR NOT public.rag_access_group_in_tenant(p_tenant_key, p_group_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF NOT public.rag_access_user_in_tenant(p_tenant_key, p_user_id) THEN
    RAISE EXCEPTION 'not_a_workspace_member' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rag_access_group_members m WHERE m.group_id = p_group_id AND m.user_id = p_user_id) THEN
    RAISE EXCEPTION 'member_exists' USING ERRCODE = '23505';
  END IF;
  BEGIN
    INSERT INTO public.rag_access_group_members (group_id, user_id, added_by) VALUES (p_group_id, p_user_id, p_actor);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'member_exists' USING ERRCODE = '23505';
  END;
  INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, after_groups)
  VALUES (p_tenant_key, 'member_add', p_actor, 'admin', p_group_id, ARRAY['u:' || p_user_id::text]);
  RETURN QUERY
  SELECT m.group_id, m.user_id, m.added_at FROM public.rag_access_group_members m WHERE m.group_id = p_group_id AND m.user_id = p_user_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_member_add(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_member_add(text, uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

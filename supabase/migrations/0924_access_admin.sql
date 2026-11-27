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

CREATE OR REPLACE FUNCTION public.rag_access_group_rename(p_tenant_key text, p_group_id uuid, p_name text, p_actor uuid)
RETURNS TABLE (id uuid, key text, name text, source text, created_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_name text := pg_catalog.btrim(p_name);
  v_old text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = '22023';
  END IF;
  SELECT g.name INTO v_old FROM public.rag_access_groups g WHERE g.id = p_group_id AND g.tenant_key = p_tenant_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NULL OR pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
  END IF;
  IF v_old IS DISTINCT FROM v_name THEN
    UPDATE public.rag_access_groups g SET name = v_name WHERE g.id = p_group_id AND g.tenant_key = p_tenant_key;
    INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id)
    VALUES (p_tenant_key, 'group_rename', p_actor, 'admin', p_group_id);
  END IF;
  RETURN QUERY SELECT g.id, g.key, g.name, g.source, g.created_at FROM public.rag_access_groups g WHERE g.id = p_group_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_rename(text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_rename(text, uuid, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_groups_list(p_tenant_key text, p_cursor text, p_limit integer)
RETURNS TABLE (
  id uuid, key text, name text, source text, created_at timestamptz, member_count bigint, document_count bigint, cursor text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_decoded text;
  v_after_id uuid;
  v_after_name text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_decoded := pg_catalog.convert_from(pg_catalog.decode(p_cursor, 'base64'), 'UTF8');
      v_after_id := pg_catalog.split_part(v_decoded, ':', 1)::uuid;
      v_after_name := pg_catalog.substr(v_decoded, 38);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END;
    IF pg_catalog.substr(v_decoded, 37, 1) <> ':' THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN QUERY
  SELECT g.id, g.key, g.name, g.source, g.created_at,
    (SELECT pg_catalog.count(*) FROM public.rag_access_group_members m WHERE m.group_id = g.id),
    (SELECT pg_catalog.count(*) FROM public.documents d
     WHERE d.tenant_key = p_tenant_key AND d.is_current AND d.access_groups @> ARRAY['g:' || g.id::text]),
    pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to(g.id::text || ':' || g.name, 'UTF8'), 'base64'), E'\n', '')
  FROM public.rag_access_groups g
  WHERE g.tenant_key = p_tenant_key
    AND (v_after_id IS NULL OR (g.name COLLATE "C", g.id) > (v_after_name COLLATE "C", v_after_id))
  ORDER BY g.name COLLATE "C", g.id
  LIMIT v_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_groups_list(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_groups_list(text, text, integer) TO service_role;

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

CREATE OR REPLACE FUNCTION public.rag_access_member_remove(p_tenant_key text, p_group_id uuid, p_user_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_count integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = '22023';
  END IF;
  IF p_group_id IS NULL OR NOT public.rag_access_group_in_tenant(p_tenant_key, p_group_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.rag_access_group_members m WHERE m.group_id = p_group_id AND m.user_id = p_user_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, before_groups)
  VALUES (p_tenant_key, 'member_remove', p_actor, 'admin', p_group_id, ARRAY['u:' || p_user_id::text]);
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_member_remove(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_member_remove(text, uuid, uuid, uuid) TO service_role;

-- Display name: full_name, then name, from the user metadata when that column exists, else the e-mail (the fixture shim has only id and email).

CREATE OR REPLACE FUNCTION public.rag_access_group_members_list(p_tenant_key text, p_group_id uuid)
RETURNS TABLE (user_id uuid, display_name text, email text, added_at timestamptz, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_group_id IS NULL OR NOT public.rag_access_group_in_tenant(p_tenant_key, p_group_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT p.user_id, p.display_name, p.email, p.added_at, p.source
  FROM (
    SELECT m.user_id,
      COALESCE(
        NULLIF(pg_catalog.btrim(pg_catalog.to_jsonb(u) -> 'raw_user_meta_data' ->> 'full_name'), ''),
        NULLIF(pg_catalog.btrim(pg_catalog.to_jsonb(u) -> 'raw_user_meta_data' ->> 'name'), ''),
        u.email::text,
        m.user_id::text
      ) AS display_name,
      u.email::text AS email, m.added_at, m.source
    FROM public.rag_access_group_members m
    JOIN auth.users u ON u.id = m.user_id
    WHERE m.group_id = p_group_id
      AND public.rag_access_user_in_tenant(p_tenant_key, m.user_id)
  ) p
  ORDER BY pg_catalog.lower(p.display_name) COLLATE "C", p.user_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_group_members_list(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_group_members_list(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_member_candidates(p_tenant_key text, p_group_id uuid, p_query text, p_limit integer)
RETURNS TABLE (user_id uuid, display_name text, email text, already_member boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_prefix text := pg_catalog.left(p_tenant_key, 2);
  v_query text := pg_catalog.btrim(COALESCE(p_query, ''));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 20);
  v_pattern text;
  v_org uuid;
  v_ids uuid[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_group_id IS NULL OR NOT public.rag_access_group_in_tenant(p_tenant_key, p_group_id) THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(v_query) < 2 THEN
    RETURN;
  END IF;
  v_pattern := public.rag_access_like_pattern(pg_catalog.left(v_query, 200));

  IF v_prefix = 'o:' THEN
    v_org := pg_catalog.substr(p_tenant_key, 3)::uuid;
    SELECT COALESCE(pg_catalog.array_agg(x.id), '{}'::uuid[]) INTO v_ids
    FROM (
      SELECT m.user_id AS id FROM public.organization_members m WHERE m.organization_id = v_org
      UNION
      SELECT o.owner_id FROM public.organizations o WHERE o.id = v_org AND o.owner_id IS NOT NULL
    ) x;
  ELSIF v_prefix <> 's:' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.display_name, p.email, EXISTS (
    SELECT 1 FROM public.rag_access_group_members gm WHERE gm.group_id = p_group_id AND gm.user_id = p.id
  )
  FROM (
    SELECT u.id,
      COALESCE(
        NULLIF(pg_catalog.btrim(pg_catalog.to_jsonb(u) -> 'raw_user_meta_data' ->> 'full_name'), ''),
        NULLIF(pg_catalog.btrim(pg_catalog.to_jsonb(u) -> 'raw_user_meta_data' ->> 'name'), ''),
        u.email::text,
        u.id::text
      ) AS display_name,
      u.email::text AS email
    FROM auth.users u
    WHERE CASE
      WHEN v_prefix = 'o:' THEN u.id = ANY (v_ids)
      ELSE (NOT (pg_catalog.to_jsonb(u) ? 'confirmed_at') OR (pg_catalog.to_jsonb(u) ->> 'confirmed_at') IS NOT NULL)
        AND (pg_catalog.to_jsonb(u) ->> 'deleted_at') IS NULL
    END
  ) p
  WHERE p.display_name ILIKE v_pattern ESCAPE '\' OR COALESCE(p.email, '') ILIKE v_pattern ESCAPE '\'
  ORDER BY pg_catalog.lower(p.display_name) COLLATE "C", p.id
  LIMIT v_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_member_candidates(text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_member_candidates(text, uuid, text, integer) TO service_role;

-- The caller's own groups (D-16, D-29).

CREATE OR REPLACE FUNCTION public.rag_access_my_groups(p_tenant_key text, p_user_id uuid)
RETURNS TABLE (is_admin boolean, own_groups jsonb, assignable_groups jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_admin boolean;
  v_groups uuid[];
  v_own jsonb;
  v_assignable jsonb;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT r.is_admin, r.group_ids INTO v_admin, v_groups FROM public.rag_resolve_access_scope(p_tenant_key, p_user_id) r;
  v_admin := COALESCE(v_admin, false);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name COLLATE "C", g.id), '[]'::jsonb)
    INTO v_own
  FROM public.rag_access_groups g
  WHERE g.tenant_key = p_tenant_key AND g.id = ANY (COALESCE(v_groups, '{}'::uuid[]));
  IF v_admin THEN
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name COLLATE "C", g.id), '[]'::jsonb)
      INTO v_assignable
    FROM public.rag_access_groups g
    WHERE g.tenant_key = p_tenant_key;
  ELSE
    v_assignable := v_own;
  END IF;
  RETURN QUERY SELECT v_admin, v_own, v_assignable;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_my_groups(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_my_groups(text, uuid) TO service_role;

-- Admin document view (D-17, D-20, D-28; UI-SPEC 6.2.1, 6.4, 8.1). Current documents of the tenant only.

CREATE INDEX IF NOT EXISTS rag_access_audit_lineage_idx ON public.rag_access_audit (lineage_id, created_at);

CREATE OR REPLACE FUNCTION public.rag_access_audience_kind(p_groups text[], p_uploader uuid)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN p_groups = ARRAY['all']::text[] THEN 'everyone'
    WHEN p_uploader IS NOT NULL AND p_groups = ARRAY['u:' || p_uploader::text] THEN 'uploader_only'
    ELSE 'groups'
  END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_audience_kind(text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_audience_kind(text[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_audience_details(p_tenant_key text, p_lineage uuid, p_groups text[], p_uploader uuid)
RETURNS TABLE (
  group_ids uuid[], group_names text[], people_count integer, fallback_reason text, connector_managed boolean, source text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_ids uuid[];
  v_names text[];
  v_people integer;
  v_reason text;
  v_after text[];
  v_action_reason text;
  v_source text;
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(g.id ORDER BY g.id), '{}'::uuid[]), COALESCE(pg_catalog.array_agg(g.name ORDER BY g.id), '{}'::text[])
    INTO v_ids, v_names
  FROM public.rag_access_groups g
  WHERE g.tenant_key = p_tenant_key
    AND ('g:' || g.id::text) = ANY (p_groups);

  SELECT pg_catalog.count(*)::integer INTO v_people
  FROM pg_catalog.unnest(p_groups) AS k(key)
  WHERE pg_catalog.left(k.key, 2) = 'u:' AND k.key IS DISTINCT FROM ('u:' || p_uploader::text);

  SELECT a.after_groups, a.reason INTO v_after, v_action_reason
  FROM public.rag_access_audit a
  WHERE a.lineage_id = p_lineage AND a.tenant_key = p_tenant_key AND a.action IN ('document_set', 'document_fallback')
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1;
  IF FOUND AND v_after = p_groups AND v_action_reason IN ('group_deleted', 'unmapped_source', 'source_error') THEN
    v_reason := v_action_reason;
  END IF;

  SELECT r.provider INTO v_source
  FROM public.nango_sync_records r
  JOIN public.documents d ON d.id = r.document_id
  WHERE (d.lineage_id = p_lineage OR d.id = p_lineage) AND d.tenant_key = p_tenant_key
  ORDER BY r.created_at DESC NULLS LAST, r.id
  LIMIT 1;

  RETURN QUERY SELECT v_ids, v_names, v_people, v_reason, v_source IS NOT NULL, v_source;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_audience_details(text, uuid, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_audience_details(text, uuid, text[], uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_document_audience(p_tenant_key text, p_document_ids uuid[])
RETURNS TABLE (
  document_id uuid, filename text, doc_type text, status text, created_at timestamptz, kind text, group_ids uuid[], group_names text[],
  people_count integer, fallback_reason text, connector_managed boolean, source text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT d.id, d.filename::text, d.doc_type::text, d.status::text, d.created_at,
    public.rag_access_audience_kind(d.access_groups, d.user_id),
    x.group_ids, x.group_names, x.people_count, x.fallback_reason, x.connector_managed, x.source
  FROM public.documents d
  CROSS JOIN LATERAL public.rag_access_audience_details(p_tenant_key, COALESCE(d.lineage_id, d.id), d.access_groups, d.user_id) x
  WHERE d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[]))
    AND d.tenant_key = p_tenant_key
    AND d.is_current;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_document_audience(text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_document_audience(text, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_documents_list(p_tenant_key text, p_filter text, p_query text, p_cursor text, p_limit integer)
RETURNS TABLE (
  document_id uuid, filename text, doc_type text, status text, created_at timestamptz, kind text, group_ids uuid[], group_names text[],
  people_count integer, fallback_reason text, connector_managed boolean, source text, cursor text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_filter text := COALESCE(p_filter, 'all');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 50);
  v_query text := NULLIF(pg_catalog.btrim(COALESCE(p_query, '')), '');
  v_pattern text;
  v_decoded text;
  v_after_id uuid;
  v_after_name text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF v_filter NOT IN ('restricted', 'uploader_only', 'everyone', 'all') THEN
    RAISE EXCEPTION 'invalid_filter' USING ERRCODE = '22023';
  END IF;
  IF v_query IS NOT NULL THEN
    v_pattern := public.rag_access_like_pattern(pg_catalog.left(v_query, 200));
  END IF;
  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_decoded := pg_catalog.convert_from(pg_catalog.decode(p_cursor, 'base64'), 'UTF8');
      v_after_id := pg_catalog.split_part(v_decoded, ':', 1)::uuid;
      v_after_name := pg_catalog.substr(v_decoded, 38);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END;
    IF pg_catalog.substr(v_decoded, 37, 1) <> ':' THEN
      RAISE EXCEPTION 'invalid_cursor' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN QUERY
  SELECT p.id, p.filename, p.doc_type, p.status, p.created_at, p.kind,
    x.group_ids, x.group_names, x.people_count, x.fallback_reason, x.connector_managed, x.source,
    pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to(p.id::text || ':' || p.filename, 'UTF8'), 'base64'), E'\n', '')
  FROM (
    SELECT d.id, COALESCE(d.filename::text, '') AS filename, d.doc_type::text AS doc_type, d.status::text AS status, d.created_at,
      public.rag_access_audience_kind(d.access_groups, d.user_id) AS kind,
      COALESCE(d.lineage_id, d.id) AS lineage, d.access_groups, d.user_id
    FROM public.documents d
    WHERE d.tenant_key = p_tenant_key
      AND d.is_current
      AND (v_pattern IS NULL OR COALESCE(d.filename::text, '') ILIKE v_pattern ESCAPE '\')
  ) p
  CROSS JOIN LATERAL public.rag_access_audience_details(p_tenant_key, p.lineage, p.access_groups, p.user_id) x
  WHERE (v_filter = 'all'
      OR (v_filter = 'restricted' AND p.kind = 'groups')
      OR (v_filter = 'uploader_only' AND p.kind = 'uploader_only')
      OR (v_filter = 'everyone' AND p.kind = 'everyone'))
    AND (v_after_id IS NULL OR (p.filename COLLATE "C", p.id) > (v_after_name COLLATE "C", v_after_id))
  ORDER BY p.filename COLLATE "C", p.id
  LIMIT v_limit;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_documents_list(text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_documents_list(text, text, text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_access_documents_counts(p_tenant_key text, p_query text)
RETURNS TABLE (restricted bigint, uploader_only bigint, everyone bigint, "all" bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_query text := NULLIF(pg_catalog.btrim(COALESCE(p_query, '')), '');
  v_pattern text;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF v_query IS NOT NULL THEN
    v_pattern := public.rag_access_like_pattern(pg_catalog.left(v_query, 200));
  END IF;
  RETURN QUERY
  SELECT
    pg_catalog.count(*) FILTER (WHERE k.kind = 'groups'),
    pg_catalog.count(*) FILTER (WHERE k.kind = 'uploader_only'),
    pg_catalog.count(*) FILTER (WHERE k.kind = 'everyone'),
    pg_catalog.count(*)
  FROM (
    SELECT public.rag_access_audience_kind(d.access_groups, d.user_id) AS kind
    FROM public.documents d
    WHERE d.tenant_key = p_tenant_key
      AND d.is_current
      AND (v_pattern IS NULL OR COALESCE(d.filename::text, '') ILIKE v_pattern ESCAPE '\')
  ) k;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_access_documents_counts(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_access_documents_counts(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

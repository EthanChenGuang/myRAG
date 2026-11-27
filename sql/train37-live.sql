-- Train 37 live SQL (ci/merge-train-37). Apply after train 36 is live (0903, 0923, 0926, 0931, 0950 and 0410 r19). Multi-tenant production.
-- Order: 0924, 0925, 0934, 0980, then the 0410 r20 delta (grants only). None of the four has a .single-tenant / .multi-tenant variant.
-- Dependencies: 0924 and 0925 need the access-group tables and functions of 0920-0923 and 0926 (trains 35 and 36); 0925 calls
-- rag_set_document_access_groups (0923); 0934 needs 0922 (rag_resolve_access_scope rules) and 0931; 0980 needs 0471 and 0472 (it stops
-- with 55000 otherwise). 0410 itself is not re-run: the r20 delta below repeats only the lines train 37 adds to it.
-- Not in this file: supabase/optional/lexical-stats-schedule.sql (04.4, optional pg_cron schedule, not a migration; apply only on request).
-- No migration already applied in production is changed by this train; 0410 only gains guarded grant lines (r20).
-- DROP sections (each followed by a re-create in the same transaction):
--   0934: ALTER TABLE ... DROP CONSTRAINT IF EXISTS rag_answer_records_access_sets_check, rag_retrieval_log_access_sets_check and
--         rag_review_items_access_sets_check (re-added: access_sets IS NULL OR a JSON array).
--   0934: DROP POLICY IF EXISTS rag_retrieval_log_access_sets ON rag_retrieval_log and rag_review_items_access_sets ON rag_review_items
--         (re-created AS RESTRICTIVE FOR SELECT TO authenticated; rows written with access groups off have access_sets NULL and stay
--         readable as today).
--   0980: DROP FUNCTION IF EXISTS public.rag_term_list_entries(uuid, text, integer, integer, text); re-created with three optional
--         Glossary filters (p_kind, p_source_language, p_target_language; eight arguments). A five-argument call from the app still
--         resolves because the new arguments default to NULL. Deploy the app with this train (the Glossary filters call the new signature).
-- Operational notes:
--   0924 adds about twenty service-role functions for /api/rag/access-groups/* and one index (rag_access_audit_lineage_idx, built without
--   CONCURRENTLY; rag_access_audit is small). rag_access_group_members_list and rag_access_member_candidates are SECURITY DEFINER (they read
--   auth.users); every function has SET search_path = '' and is REVOKEd from PUBLIC, anon, authenticated and GRANTed to service_role.
--   0925 creates rag_connector_document_access (RLS on, service_role only) and the connector mapping functions; rag_connector_match_members
--   is SECURITY DEFINER (reads auth.users), the rest INVOKER, all service_role only.
--   0934 adds access_sets jsonb (nullable, metadata-only) to rag_answer_records, rag_retrieval_log and rag_review_items, CHECK constraints
--   (validated; every existing row is NULL) and rag_caller_reads_access_sets(text, jsonb) (SECURITY DEFINER, executable by authenticated
--   and service_role, used by the two restrictive policies).
--   Nothing here writes or rewrites existing rows.

-- ==== supabase/migrations/0924_access_admin.sql
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

-- ==== supabase/migrations/0925_access_connectors.sql
-- 0925: connector permission sync in SQL (Phase 4.3 plan 30, DATA-22, D-20, D-21, D-22, A-07, A-10, D-31).
-- rag_connector_apply_access maps one synced document's source principals to access keys in one call: a user principal carries the member
-- id the caller matched with rag_connector_match_members (u:<id> when that id belongs to the tenant); a group, team or workspace becomes
-- g:<group> through rag_connector_group_map; a domain, anyone-with-the-link or published principal becomes all only when an enabled
-- rag_connector_sharing_rules row of that provider (and domain) exists. Any unmappable principal, or status source_error, sets the document
-- to u:<owner> (fail closed, D-20, D-21). The result goes through rag_set_document_access_groups with actor NULL, actor kind connector and
-- reason source_mapped, owner_only, unmapped_source or source_error, so it is lineage-wide and audited, and it runs whatever the enforcement
-- flag says (D-22). The document's non-person principals replace its lineage's rows in rag_connector_document_principals with their mapped
-- flag; a person is never stored. rag_connector_document_access keeps the last outcome per lineage, so fallback counts survive a source error.
-- A-10: in multi-tenant mode connector documents live in the owner's personal tenant (u:<owner>), which has no groups, so group principals
-- fall back to u:<owner>, the visibility that tenant already has. Principal ids are untrusted provider data, stored as given (Google Drive
-- group addresses and domains trimmed and lower-cased), never interpreted. No function returns or logs an address.
-- Functions: SET search_path = '', schema-qualified names, INVOKER except rag_connector_match_members (DEFINER, reads auth.users), literal
-- REVOKE from PUBLIC, anon and authenticated and GRANT to service_role. Error reasons come first in the message (22023). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_connector_document_access (
  lineage_id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  tenant_key text NOT NULL,
  provider text NOT NULL,
  fail_closed boolean NOT NULL,
  reason text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT rag_connector_document_access_tenant_key_check
    CHECK (tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  CONSTRAINT rag_connector_document_access_provider_check CHECK (provider IN ('google-drive', 'dropbox', 'notion')),
  CONSTRAINT rag_connector_document_access_reason_check
    CHECK (reason IN ('source_mapped', 'owner_only', 'unmapped_source', 'source_error'))
);

CREATE INDEX IF NOT EXISTS rag_connector_document_access_tenant_idx
  ON public.rag_connector_document_access (tenant_key, fail_closed);
CREATE INDEX IF NOT EXISTS rag_connector_document_access_document_idx
  ON public.rag_connector_document_access (document_id);

ALTER TABLE public.rag_connector_document_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_connector_document_access FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_connector_document_access TO service_role;

CREATE OR REPLACE FUNCTION public.rag_connector_apply_access(
  p_tenant_key text,
  p_document_id uuid,
  p_provider text,
  p_principals jsonb,
  p_owner uuid,
  p_status text
)
RETURNS TABLE (keys text[], fail_closed boolean, reason text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_lineage uuid;
  v_item jsonb;
  v_kind text;
  v_pid text;
  v_member text;
  v_group uuid;
  v_mapped boolean;
  v_keys text[] := ARRAY[]::text[];
  v_unmapped boolean := false;
  v_fail boolean;
  v_reason text;
  v_result text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_provider IS NULL OR p_provider NOT IN ('google-drive', 'dropbox', 'notion') THEN
    RAISE EXCEPTION 'invalid_provider' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('ok', 'source_error') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023';
  END IF;
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'owner_required' USING ERRCODE = '22023';
  END IF;
  IF p_principals IS NOT NULL AND pg_catalog.jsonb_typeof(p_principals) <> 'array' THEN
    RAISE EXCEPTION 'invalid_principal' USING ERRCODE = '22023';
  END IF;
  IF p_principals IS NOT NULL AND pg_catalog.jsonb_array_length(p_principals) > 5000 THEN
    RAISE EXCEPTION 'too_many_principals' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(d.lineage_id, d.id) INTO v_lineage
  FROM public.documents d
  WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key;
  IF v_lineage IS NULL THEN
    RAISE EXCEPTION 'document_not_found' USING ERRCODE = '22023';
  END IF;
  IF NOT public.rag_access_user_in_tenant(p_tenant_key, p_owner) THEN
    RAISE EXCEPTION 'unknown_user' USING ERRCODE = '22023';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _rag_connector_principals (kind text, pid text, mapped boolean, PRIMARY KEY (kind, pid)) ON COMMIT DROP;
  TRUNCATE pg_temp._rag_connector_principals;

  IF p_status = 'ok' AND p_principals IS NOT NULL THEN
    FOR v_item IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_principals) AS e(value) LOOP
      IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
        RAISE EXCEPTION 'invalid_principal' USING ERRCODE = '22023';
      END IF;
      v_kind := v_item ->> 'kind';
      IF v_kind = 'user' THEN
        v_member := pg_catalog.btrim(v_item ->> 'member_id');
        IF v_member IS NULL OR v_member = '' THEN
          v_unmapped := true;
        ELSIF v_member !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
          RAISE EXCEPTION 'invalid_principal' USING ERRCODE = '22023';
        ELSIF public.rag_access_user_in_tenant(p_tenant_key, v_member::uuid) THEN
          v_keys := v_keys || ('u:' || pg_catalog.lower(v_member));
        ELSE
          v_unmapped := true;
        END IF;
        CONTINUE;
      END IF;

      IF v_kind IN ('group', 'team', 'workspace', 'domain') THEN
        v_pid := pg_catalog.btrim(v_item ->> 'id');
        IF v_pid IS NULL OR v_pid = '' OR pg_catalog.char_length(v_pid) > 512 THEN
          RAISE EXCEPTION 'invalid_principal' USING ERRCODE = '22023';
        END IF;
        IF v_kind = 'domain' OR (p_provider = 'google-drive' AND v_kind = 'group') THEN
          v_pid := pg_catalog.lower(v_pid);
        END IF;
      ELSIF v_kind IN ('anyone', 'public') THEN
        v_pid := '';
      ELSE
        RAISE EXCEPTION 'invalid_principal' USING ERRCODE = '22023';
      END IF;

      IF v_kind IN ('group', 'team', 'workspace') THEN
        SELECT m.group_id INTO v_group
        FROM public.rag_connector_group_map m
        JOIN public.rag_access_groups g ON g.id = m.group_id AND g.tenant_key = p_tenant_key
        WHERE m.tenant_key = p_tenant_key AND m.provider = p_provider AND m.kind = v_kind AND m.external_principal_id = v_pid;
        v_mapped := v_group IS NOT NULL;
        IF v_mapped THEN
          v_keys := v_keys || ('g:' || v_group::text);
        END IF;
      ELSE
        v_mapped := EXISTS (
          SELECT 1 FROM public.rag_connector_sharing_rules r
          WHERE r.tenant_key = p_tenant_key AND r.provider = p_provider AND r.kind = v_kind AND r.enabled
            AND COALESCE(r.domain, '') = v_pid
        );
        IF v_mapped THEN
          v_keys := v_keys || 'all'::text;
        END IF;
      END IF;
      IF NOT v_mapped THEN
        v_unmapped := true;
      END IF;
      INSERT INTO pg_temp._rag_connector_principals (kind, pid, mapped) VALUES (v_kind, v_pid, v_mapped) ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  IF p_status = 'source_error' THEN
    v_fail := true;
    v_reason := 'source_error';
  ELSIF v_unmapped THEN
    v_fail := true;
    v_reason := 'unmapped_source';
  ELSIF pg_catalog.cardinality(v_keys) = 0 THEN
    v_fail := false;
    v_reason := 'owner_only';
  ELSE
    v_fail := false;
    v_reason := 'source_mapped';
  END IF;
  IF v_fail OR pg_catalog.cardinality(v_keys) = 0 THEN
    v_keys := ARRAY['u:' || p_owner::text];
  END IF;

  DELETE FROM public.rag_connector_document_principals p
  USING public.documents d
  WHERE p.document_id = d.id AND d.tenant_key = p_tenant_key AND (d.lineage_id = v_lineage OR d.id = v_lineage);
  INSERT INTO public.rag_connector_document_principals (document_id, tenant_key, provider, kind, external_principal_id, mapped)
  SELECT p_document_id, p_tenant_key, p_provider, t.kind, t.pid, t.mapped FROM pg_temp._rag_connector_principals t;
  TRUNCATE pg_temp._rag_connector_principals;

  SELECT s.after_groups INTO v_result
  FROM public.rag_set_document_access_groups(p_tenant_key, ARRAY[p_document_id], v_keys, NULL::uuid, 'connector', v_reason) s
  WHERE s.document_id = p_document_id;

  INSERT INTO public.rag_connector_document_access (lineage_id, document_id, tenant_key, provider, fail_closed, reason, applied_at)
  VALUES (v_lineage, p_document_id, p_tenant_key, p_provider, v_fail, v_reason, pg_catalog.now())
  ON CONFLICT (lineage_id) DO UPDATE
    SET document_id = EXCLUDED.document_id, tenant_key = EXCLUDED.tenant_key, provider = EXCLUDED.provider,
        fail_closed = EXCLUDED.fail_closed, reason = EXCLUDED.reason, applied_at = EXCLUDED.applied_at;

  RETURN QUERY SELECT v_result, v_fail, v_reason;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_apply_access(text, uuid, text, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_apply_access(text, uuid, text, jsonb, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_connector_match_members(p_tenant_key text, p_addresses text[])
RETURNS TABLE (idx integer, user_id uuid)
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
  IF p_addresses IS NULL OR pg_catalog.cardinality(p_addresses) = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_addresses) > 5000 THEN
    RAISE EXCEPTION 'too_many_addresses' USING ERRCODE = '22023';
  END IF;
  v_prefix := pg_catalog.left(p_tenant_key, 2);
  IF v_prefix <> 's:' THEN
    v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
  END IF;

  -- One query per mode: organization_members exists only in multi-tenant databases.
  IF v_prefix = 's:' THEN
    RETURN QUERY
    WITH c AS (
      SELECT a.ord::integer AS idx, u.id AS user_id
      FROM pg_catalog.unnest(p_addresses) WITH ORDINALITY AS a(address, ord)
      JOIN auth.users u ON pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(a.address))
      WHERE a.address IS NOT NULL
        AND pg_catalog.btrim(a.address) <> ''
        AND (pg_catalog.to_jsonb(u) ->> 'email_confirmed_at') IS NOT NULL
        AND (pg_catalog.to_jsonb(u) ->> 'deleted_at') IS NULL
    )
    SELECT c.idx, c.user_id FROM c ORDER BY c.idx;
  ELSIF v_prefix = 'u:' THEN
    RETURN QUERY
    WITH c AS (
      SELECT a.ord::integer AS idx, u.id AS user_id
      FROM pg_catalog.unnest(p_addresses) WITH ORDINALITY AS a(address, ord)
      JOIN auth.users u ON pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(a.address))
      WHERE a.address IS NOT NULL
        AND pg_catalog.btrim(a.address) <> ''
        AND (pg_catalog.to_jsonb(u) ->> 'email_confirmed_at') IS NOT NULL
        AND (pg_catalog.to_jsonb(u) ->> 'deleted_at') IS NULL
    )
    SELECT c.idx, c.user_id FROM c WHERE c.user_id = v_tenant_id ORDER BY c.idx;
  ELSE
    RETURN QUERY
    WITH c AS (
      SELECT a.ord::integer AS idx, u.id AS user_id
      FROM pg_catalog.unnest(p_addresses) WITH ORDINALITY AS a(address, ord)
      JOIN auth.users u ON pg_catalog.lower(u.email) = pg_catalog.lower(pg_catalog.btrim(a.address))
      WHERE a.address IS NOT NULL
        AND pg_catalog.btrim(a.address) <> ''
        AND (pg_catalog.to_jsonb(u) ->> 'email_confirmed_at') IS NOT NULL
        AND (pg_catalog.to_jsonb(u) ->> 'deleted_at') IS NULL
    )
    SELECT c.idx, c.user_id FROM c
    WHERE EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = v_tenant_id AND m.user_id = c.user_id)
       OR EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_tenant_id AND o.owner_id = c.user_id)
    ORDER BY c.idx;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_match_members(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_match_members(text, text[]) TO service_role;

-- Administration (D-20, D-28, A-07, UI-SPEC 6.5, 8.1). Rows come from mappings and rules an admin created and from principals a sync has
-- seen; documents is the number of document lineages whose last apply left that principal unmapped, i.e. that fell back because of it.
-- A mapping or rule change relabels nothing by itself: it applies at the next sync of each connection.

CREATE OR REPLACE FUNCTION public.rag_connector_map_list(p_tenant_key text, p_offset integer DEFAULT 0)
RETURNS TABLE (id uuid, provider text, kind text, external_principal_id text, group_id uuid, documents bigint, total bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'invalid_offset' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH seen AS (
    SELECT p.provider, p.kind, p.external_principal_id,
      pg_catalog.count(DISTINCT COALESCE(d.lineage_id, d.id)) FILTER (WHERE NOT p.mapped) AS fell_back
    FROM public.rag_connector_document_principals p
    JOIN public.documents d ON d.id = p.document_id AND d.tenant_key = p_tenant_key
    WHERE p.tenant_key = p_tenant_key AND p.kind IN ('group', 'team', 'workspace')
    GROUP BY p.provider, p.kind, p.external_principal_id
  ),
  rows_all AS (
    SELECT m.id, m.provider, m.kind, m.external_principal_id, m.group_id, COALESCE(s.fell_back, 0) AS documents
    FROM public.rag_connector_group_map m
    LEFT JOIN seen s ON s.provider = m.provider AND s.external_principal_id = m.external_principal_id
    WHERE m.tenant_key = p_tenant_key
    UNION ALL
    SELECT NULL::uuid, s.provider, s.kind, s.external_principal_id, NULL::uuid, s.fell_back
    FROM seen s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rag_connector_group_map m
      WHERE m.tenant_key = p_tenant_key AND m.provider = s.provider AND m.external_principal_id = s.external_principal_id
    )
  )
  SELECT r.id, r.provider, r.kind, r.external_principal_id, r.group_id, r.documents, pg_catalog.count(*) OVER () AS total
  FROM rows_all r
  ORDER BY (r.id IS NULL) DESC, r.provider COLLATE "C", r.kind COLLATE "C", r.external_principal_id COLLATE "C"
  OFFSET p_offset
  LIMIT 50;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_map_list(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_map_list(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_connector_map_set(
  p_tenant_key text,
  p_id uuid,
  p_provider text,
  p_kind text,
  p_external_principal_id text,
  p_group_id uuid,
  p_actor uuid
)
RETURNS TABLE (id uuid, group_id uuid, outcome text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_row record;
  v_pid text;
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group_required' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT m.id, m.group_id INTO v_row
    FROM public.rag_connector_group_map m
    WHERE m.id = p_id AND m.tenant_key = p_tenant_key
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mapping_not_found' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rag_access_groups g WHERE g.id = p_group_id AND g.tenant_key = p_tenant_key) THEN
    RAISE EXCEPTION 'unknown_group' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NOT NULL THEN
    IF v_row.group_id = p_group_id THEN
      RETURN QUERY SELECT p_id, p_group_id, 'unchanged'::text;
      RETURN;
    END IF;
    UPDATE public.rag_connector_group_map m SET group_id = p_group_id WHERE m.id = p_id AND m.tenant_key = p_tenant_key;
    INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, before_groups, after_groups, reason)
    VALUES (p_tenant_key, 'connector_map_set', p_actor, 'admin', p_group_id,
      ARRAY['g:' || v_row.group_id::text], ARRAY['g:' || p_group_id::text], 'changed');
    RETURN QUERY SELECT p_id, p_group_id, 'changed'::text;
    RETURN;
  END IF;

  IF p_provider IS NULL OR p_provider NOT IN ('google-drive', 'dropbox', 'notion') THEN
    RAISE EXCEPTION 'invalid_provider' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('group', 'team', 'workspace') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  v_pid := pg_catalog.btrim(p_external_principal_id);
  IF v_pid IS NULL OR v_pid = '' OR pg_catalog.char_length(v_pid) > 512 THEN
    RAISE EXCEPTION 'invalid_principal' USING ERRCODE = '22023';
  END IF;
  IF p_provider = 'google-drive' AND p_kind = 'group' THEN
    v_pid := pg_catalog.lower(v_pid);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rag_connector_group_map m
    WHERE m.tenant_key = p_tenant_key AND m.provider = p_provider AND m.external_principal_id = v_pid
  ) THEN
    RAISE EXCEPTION 'mapping_exists' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rag_connector_group_map (tenant_key, provider, external_principal_id, kind, group_id, created_by)
  VALUES (p_tenant_key, p_provider, v_pid, p_kind, p_group_id, p_actor)
  RETURNING public.rag_connector_group_map.id INTO v_id;
  INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, before_groups, after_groups, reason)
  VALUES (p_tenant_key, 'connector_map_set', p_actor, 'admin', p_group_id, NULL, ARRAY['g:' || p_group_id::text], 'created');
  RETURN QUERY SELECT v_id, p_group_id, 'created'::text;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_map_set(text, uuid, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_map_set(text, uuid, text, text, text, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_connector_map_delete(p_tenant_key text, p_id uuid, p_actor uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_group uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  DELETE FROM public.rag_connector_group_map m
  WHERE m.id = p_id AND m.tenant_key = p_tenant_key
  RETURNING m.group_id INTO v_group;
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'mapping_not_found' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, group_id, before_groups, after_groups, reason)
  VALUES (p_tenant_key, 'connector_map_delete', p_actor, 'admin', v_group, ARRAY['g:' || v_group::text], NULL, 'removed');
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_map_delete(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_map_delete(text, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_connector_rules_list(p_tenant_key text)
RETURNS TABLE (id uuid, provider text, kind text, domain text, enabled boolean, documents bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  WITH seen AS (
    SELECT p.provider, p.kind, p.external_principal_id AS domain_key,
      pg_catalog.count(DISTINCT COALESCE(d.lineage_id, d.id)) FILTER (WHERE NOT p.mapped) AS fell_back
    FROM public.rag_connector_document_principals p
    JOIN public.documents d ON d.id = p.document_id AND d.tenant_key = p_tenant_key
    WHERE p.tenant_key = p_tenant_key AND p.kind IN ('domain', 'anyone', 'public')
    GROUP BY p.provider, p.kind, p.external_principal_id
  ),
  rows_all AS (
    SELECT r.id, r.provider, r.kind, r.domain, r.enabled, COALESCE(s.fell_back, 0) AS documents
    FROM public.rag_connector_sharing_rules r
    LEFT JOIN seen s ON s.provider = r.provider AND s.kind = r.kind AND s.domain_key = COALESCE(r.domain, '')
    WHERE r.tenant_key = p_tenant_key
    UNION ALL
    SELECT NULL::uuid, s.provider, s.kind, NULLIF(s.domain_key, ''), false, s.fell_back
    FROM seen s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rag_connector_sharing_rules r
      WHERE r.tenant_key = p_tenant_key AND r.provider = s.provider AND r.kind = s.kind AND COALESCE(r.domain, '') = s.domain_key
    )
  )
  SELECT x.id, x.provider, x.kind, x.domain, x.enabled, x.documents
  FROM rows_all x
  ORDER BY x.provider COLLATE "C", x.kind COLLATE "C", COALESCE(x.domain, '') COLLATE "C"
  LIMIT 1000;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_rules_list(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_rules_list(text) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_connector_rule_set(
  p_tenant_key text,
  p_id uuid,
  p_provider text,
  p_kind text,
  p_domain text,
  p_enabled boolean,
  p_actor uuid
)
RETURNS TABLE (id uuid, enabled boolean, outcome text)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_current boolean;
  v_domain text;
  v_id uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);

  IF p_id IS NOT NULL THEN
    SELECT r.enabled INTO v_current
    FROM public.rag_connector_sharing_rules r
    WHERE r.id = p_id AND r.tenant_key = p_tenant_key
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rule_not_found' USING ERRCODE = '22023';
    END IF;
    IF p_enabled IS NULL THEN
      RAISE EXCEPTION 'enabled_required' USING ERRCODE = '22023';
    END IF;
    IF v_current = p_enabled THEN
      RETURN QUERY SELECT p_id, p_enabled, 'unchanged'::text;
      RETURN;
    END IF;
    UPDATE public.rag_connector_sharing_rules r
    SET enabled = p_enabled, updated_at = pg_catalog.now(), updated_by = p_actor
    WHERE r.id = p_id AND r.tenant_key = p_tenant_key;
    INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, reason)
    VALUES (p_tenant_key, 'sharing_rule_set', p_actor, 'admin', CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END);
    RETURN QUERY SELECT p_id, p_enabled, CASE WHEN p_enabled THEN 'enabled' ELSE 'disabled' END;
    RETURN;
  END IF;

  IF p_provider IS NULL OR p_provider NOT IN ('google-drive', 'dropbox', 'notion') THEN
    RAISE EXCEPTION 'invalid_provider' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('domain', 'anyone', 'public') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
  END IF;
  v_domain := NULLIF(pg_catalog.lower(pg_catalog.btrim(p_domain)), '');
  IF p_kind = 'domain' THEN
    IF v_domain IS NULL OR pg_catalog.char_length(v_domain) > 253
      OR v_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' THEN
      RAISE EXCEPTION 'bad_domain' USING ERRCODE = '22023';
    END IF;
  ELSIF p_domain IS NOT NULL THEN
    RAISE EXCEPTION 'bad_domain' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.rag_connector_sharing_rules r
    WHERE r.tenant_key = p_tenant_key AND r.provider = p_provider AND r.kind = p_kind AND COALESCE(r.domain, '') = COALESCE(v_domain, '')
  ) THEN
    RAISE EXCEPTION 'rule_exists' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.rag_connector_sharing_rules (tenant_key, provider, kind, domain, enabled, updated_by)
  VALUES (p_tenant_key, p_provider, p_kind, v_domain, false, p_actor)
  RETURNING public.rag_connector_sharing_rules.id INTO v_id;
  INSERT INTO public.rag_access_audit (tenant_key, action, actor, actor_kind, reason)
  VALUES (p_tenant_key, 'sharing_rule_set', p_actor, 'admin', 'created');
  RETURN QUERY SELECT v_id, false, 'created'::text;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_rule_set(text, uuid, text, text, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_rule_set(text, uuid, text, text, text, boolean, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.rag_connector_fail_closed_counts(p_tenant_key text)
RETURNS TABLE (connection_id text, documents bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT r.connection_id, pg_catalog.count(DISTINCT s.lineage_id)
  FROM public.rag_connector_document_access s
  JOIN public.documents d ON d.tenant_key = p_tenant_key AND COALESCE(d.lineage_id, d.id) = s.lineage_id
  JOIN public.nango_sync_records r ON r.document_id = d.id
  WHERE s.tenant_key = p_tenant_key AND s.fail_closed
  GROUP BY r.connection_id
  ORDER BY r.connection_id COLLATE "C";
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_connector_fail_closed_counts(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_connector_fail_closed_counts(text) TO service_role;

COMMIT;

-- ==== supabase/migrations/0934_access_derived_stores_sets.sql
-- 0934: derived stores under document access groups, part two (Phase 4.3 plan 13; SEC-13, D-25, D-30, A-06, A-13). 0931 (plan 12) holds
-- the semantic cache part; this file holds the answer records, the retrieval log and the review queue.
-- access_sets jsonb (nullable) is a JSON array with one element per cited or retrieved document: that document's access_groups keys
-- ('all', 'u:<uuid>', 'g:<uuid>'), never group names or text. NULL means the row was written with access groups off (today's row).
-- rag_answer_records gets the column only: the owner keeps reading their delivered answers (A-13); the answer read path drops the link
-- of a citation whose document is no longer visible. rag_retrieval_log and rag_review_items (Phase 5.1.1) get the column and a
-- restrictive SELECT policy for authenticated, rag_retrieval_log_access_sets and rag_review_items_access_sets: a row with sets is
-- readable only when public.rag_caller_reads_access_sets(tenant_key, access_sets) is true. rag_retrieval_log has no client grant and no
-- policy (0531); the restrictive policy is defence in depth for a later change that opens it, and adds no grant. Both table blocks are
-- guarded by to_regclass so the file applies without the 5.1.1 tables and completes when re-run after they exist (D-30).
-- rag_caller_reads_access_sets(p_tenant_key, p_sets): true when p_sets is NULL, when the caller administers the tenant (o: owner or
-- admin of the organization, s: admin_users, u: the personal owner; the rules of rag_resolve_access_scope in 0922), or when every set
-- shares a key with the caller's keys ('all', 'u:<auth.uid()>' and 'g:<id>' of the caller's groups in that tenant). Identity comes from
-- auth.uid() only; anon (no uid) is false for any non-NULL set. A malformed set is never readable (fails closed). STABLE SECURITY
-- DEFINER (the membership tables are not client-readable), empty search_path, granted to authenticated and service_role
-- (allow-listed in tests/helpers/security-definer-allow-list.ts). Idempotent; not folded into the setup files; re-running 0501, 0531
-- or 0534 requires re-running this file.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_caller_reads_access_sets(p_tenant_key text, p_sets jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_prefix text;
  v_tenant_id uuid;
  v_keys text[];
  v_set jsonb;
BEGIN
  IF p_sets IS NULL THEN
    RETURN true;
  END IF;
  IF v_uid IS NULL OR p_tenant_key IS NULL OR pg_catalog.jsonb_typeof(p_sets) <> 'array' THEN
    RETURN false;
  END IF;
  IF p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RETURN false;
  END IF;

  v_prefix := pg_catalog.left(p_tenant_key, 2);
  IF v_prefix = 'o:' THEN
    v_tenant_id := pg_catalog.substr(p_tenant_key, 3)::uuid;
    IF EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = v_tenant_id AND m.user_id = v_uid AND m.role IN ('owner', 'admin')
    ) OR EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_tenant_id AND o.owner_id = v_uid) THEN
      RETURN true;
    END IF;
  ELSIF v_prefix = 's:' THEN
    IF EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = v_uid) THEN
      RETURN true;
    END IF;
  ELSE
    IF pg_catalog.substr(p_tenant_key, 3)::uuid = v_uid THEN
      RETURN true;
    END IF;
  END IF;

  SELECT ARRAY['all', 'u:' || v_uid::text]::text[] || COALESCE(pg_catalog.array_agg('g:' || gm.group_id::text), '{}'::text[])
    INTO v_keys
  FROM public.rag_access_group_members gm
  JOIN public.rag_access_groups g ON g.id = gm.group_id
  WHERE gm.user_id = v_uid AND g.tenant_key = p_tenant_key;

  FOR v_set IN SELECT e.value FROM pg_catalog.jsonb_array_elements(p_sets) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_set) <> 'array' THEN
      RETURN false;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_set) AS k(value)
      WHERE pg_catalog.jsonb_typeof(k.value) = 'string' AND (k.value #>> '{}') = ANY (v_keys)
    ) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) TO authenticated;

ALTER TABLE public.rag_answer_records ADD COLUMN IF NOT EXISTS access_sets jsonb;
ALTER TABLE public.rag_answer_records DROP CONSTRAINT IF EXISTS rag_answer_records_access_sets_check;
ALTER TABLE public.rag_answer_records ADD CONSTRAINT rag_answer_records_access_sets_check
  CHECK (access_sets IS NULL OR jsonb_typeof(access_sets) = 'array');

DO $retrieval_log$
BEGIN
  IF to_regclass('public.rag_retrieval_log') IS NULL THEN
    RAISE NOTICE '[RAG Access] rag_retrieval_log is absent; access_sets and rag_retrieval_log_access_sets were not created';
    RETURN;
  END IF;
  ALTER TABLE public.rag_retrieval_log ADD COLUMN IF NOT EXISTS access_sets jsonb;
  ALTER TABLE public.rag_retrieval_log DROP CONSTRAINT IF EXISTS rag_retrieval_log_access_sets_check;
  ALTER TABLE public.rag_retrieval_log ADD CONSTRAINT rag_retrieval_log_access_sets_check
    CHECK (access_sets IS NULL OR jsonb_typeof(access_sets) = 'array');
  DROP POLICY IF EXISTS rag_retrieval_log_access_sets ON public.rag_retrieval_log;
  CREATE POLICY rag_retrieval_log_access_sets ON public.rag_retrieval_log
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING (access_sets IS NULL OR public.rag_caller_reads_access_sets(tenant_key, access_sets));
END
$retrieval_log$;

DO $review_items$
BEGIN
  IF to_regclass('public.rag_review_items') IS NULL THEN
    RAISE NOTICE '[RAG Access] rag_review_items is absent; access_sets and rag_review_items_access_sets were not created';
    RETURN;
  END IF;
  ALTER TABLE public.rag_review_items ADD COLUMN IF NOT EXISTS access_sets jsonb;
  ALTER TABLE public.rag_review_items DROP CONSTRAINT IF EXISTS rag_review_items_access_sets_check;
  ALTER TABLE public.rag_review_items ADD CONSTRAINT rag_review_items_access_sets_check
    CHECK (access_sets IS NULL OR jsonb_typeof(access_sets) = 'array');
  DROP POLICY IF EXISTS rag_review_items_access_sets ON public.rag_review_items;
  CREATE POLICY rag_review_items_access_sets ON public.rag_review_items
    AS RESTRICTIVE FOR SELECT TO authenticated
    USING (access_sets IS NULL OR public.rag_caller_reads_access_sets(tenant_key, access_sets));
END
$review_items$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== supabase/migrations/0980_term_translation_target.sql
-- 0980: Phase 6.2 translation glossary on the TERM dictionary (D-02, D-13, D-15, D-36).
-- Glossary pairs are rag_term_entries rows of kind translation: variants in language (the source language) map to the required translation
-- canonical in target_language. 0471 already stores target_language with a validated translation CHECK (required for translation, NULL for
-- every other kind, different from the source language, which equals language), and rag_term_effective, the 0472 writers and the entries
-- hash already carry it, so this file adds no column and no constraint: it stops with 55000 when that 0471 shape is missing.
-- Whether target_language is an enabled language is checked by the app validator on every write path, never here (D-36).
-- It re-creates rag_term_list_entries (body from 0472) with three optional Glossary filters: p_kind, p_source_language (matched against
-- language) and p_target_language. NULL means no filter, so a five-argument call lists the whole layer as before. Same hardening as 0472:
-- SECURITY DEFINER, empty search_path, schema-qualified names, rag_term__authorize first, executable by service_role only.
-- Not folded into the setup files. Re-running 0472 or a setup file brings the five-argument signature back next to this one; re-run 0980
-- afterwards (it drops that signature). Idempotent.

BEGIN;

DO $guard$
BEGIN
  IF pg_catalog.to_regclass('public.rag_term_entries') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = 'public.rag_term_entries'::pg_catalog.regclass AND attname = 'target_language' AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.rag_term_entries'::pg_catalog.regclass AND conname = 'rag_term_entries_translation_check'
     )
     OR pg_catalog.to_regprocedure('public.rag_term__authorize(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '0980 needs the 0471 and 0472 terminology schema; apply them first' USING ERRCODE = '55000';
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.rag_term_list_entries(uuid, text, integer, integer, text);

CREATE OR REPLACE FUNCTION public.rag_term_list_entries(
  p_actor uuid,
  p_layer_key text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL,
  p_kind text DEFAULT NULL,
  p_source_language text DEFAULT NULL,
  p_target_language text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  layer_key text,
  canonical text,
  variants text[],
  normalized_variants text[],
  language text,
  kind text,
  mode text,
  source_language text,
  target_language text,
  enabled boolean,
  note text,
  suppresses_entry_id uuid,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  layer_version bigint,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_page integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_skip integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := pg_catalog.lower(NULLIF(pg_catalog.btrim(p_search), ''));
  v_kind text := NULLIF(pg_catalog.btrim(p_kind), '');
  v_source text := NULLIF(pg_catalog.btrim(p_source_language), '');
  v_target text := NULLIF(pg_catalog.btrim(p_target_language), '');
  v_version bigint;
BEGIN
  PERFORM public.rag_term__authorize(p_actor, p_layer_key);
  SELECT l.version INTO v_version FROM public.rag_term_layers l WHERE l.layer_key = p_layer_key;
  RETURN QUERY
  SELECT e.id, e.layer_key, e.canonical, e.variants, e.normalized_variants, e.language, e.kind, e.mode, e.source_language,
         e.target_language, e.enabled, e.note, e.suppresses_entry_id, e.created_by, e.updated_by, e.created_at, e.updated_at,
         COALESCE(v_version, 0::bigint), pg_catalog.count(*) OVER ()
    FROM public.rag_term_entries e
   WHERE e.layer_key = p_layer_key
     AND (v_kind IS NULL OR e.kind = v_kind)
     AND (v_source IS NULL OR e.language = v_source)
     AND (v_target IS NULL OR e.target_language = v_target)
     AND (
       v_search IS NULL
       OR pg_catalog.strpos(pg_catalog.lower(e.canonical), v_search) > 0
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(e.variants) AS u(v) WHERE pg_catalog.strpos(pg_catalog.lower(u.v), v_search) > 0)
     )
   ORDER BY pg_catalog.lower(e.canonical), e.language, COALESCE(e.target_language, ''), e.id
   LIMIT v_page OFFSET v_skip;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==== 0410 r20 delta (the lines train 37 adds to supabase/migrations/0410_security_definer_rpc_grants.sql)
DO $r20_service_role_only$
BEGIN
  IF to_regprocedure('public.rag_access_group_members_list(text, uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_group_members_list(text, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_group_members_list(text, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_access_member_candidates(text, uuid, text, integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_access_member_candidates(text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_access_member_candidates(text, uuid, text, integer) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_connector_match_members(text, text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_connector_match_members(text, text[]) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_connector_match_members(text, text[]) TO service_role;
  END IF;
  IF to_regprocedure('public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text, text, text, text) TO service_role;
  END IF;
END
$r20_service_role_only$;

DO $r20_authenticated_callable$
BEGIN
  IF to_regprocedure('public.rag_caller_reads_access_sets(text, jsonb)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.rag_caller_reads_access_sets(text, jsonb) TO authenticated, service_role;
  END IF;
END
$r20_authenticated_callable$;

NOTIFY pgrst, 'reload schema';

-- ==== Verify (read-only; run after the apply)
-- 1. Every function of this train exists, has an empty search_path and the expected security mode.
SELECT p.oid::regprocedure AS fn, p.prosecdef AS security_definer, p.proconfig
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'rag\_access\_%' OR p.proname LIKE 'rag\_connector\_%'
       OR p.proname IN ('rag_caller_reads_access_sets', 'rag_term_list_entries'))
ORDER BY 1;
-- Expect proconfig = {search_path=""} on every row; security_definer true only for rag_access_group_members_list,
-- rag_access_member_candidates, rag_connector_match_members, rag_caller_reads_access_sets, rag_term_list_entries (and the train 35/36
-- definer functions already live).

-- 2. Only the eight-argument rag_term_list_entries is left (expect one row).
SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p WHERE p.proname = 'rag_term_list_entries' AND p.pronamespace = 'public'::regnamespace;

-- 3. Grants: anon and authenticated cannot execute the service-role functions; authenticated can run rag_caller_reads_access_sets.
SELECT p.oid::regprocedure AS fn,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_exec
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'rag\_access\_group%' OR p.proname LIKE 'rag\_access\_member%' OR p.proname LIKE 'rag\_access\_audience%'
       OR p.proname LIKE 'rag\_access\_document%' OR p.proname IN ('rag_access_my_groups', 'rag_access_like_pattern')
       OR p.proname LIKE 'rag\_connector\_%' OR p.proname IN ('rag_caller_reads_access_sets', 'rag_term_list_entries'))
ORDER BY 1;
-- Expect anon_exec false everywhere, authenticated_exec true only for rag_caller_reads_access_sets, service_role_exec true everywhere.

-- 4. access_sets columns and the restrictive policies (expect three columns and two policies, permissive = RESTRICTIVE).
SELECT table_name, column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'access_sets'
  AND table_name IN ('rag_answer_records', 'rag_retrieval_log', 'rag_review_items') ORDER BY 1;
SELECT tablename, policyname, permissive, roles, cmd FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND policyname IN ('rag_retrieval_log_access_sets', 'rag_review_items_access_sets') ORDER BY 1;

-- 5. rag_connector_document_access exists with RLS on and no client grant (expect relrowsecurity true, both privileges false).
SELECT c.relname, c.relrowsecurity,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
       pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select
FROM pg_catalog.pg_class c WHERE c.oid = 'public.rag_connector_document_access'::regclass;

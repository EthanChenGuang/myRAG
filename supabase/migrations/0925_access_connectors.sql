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

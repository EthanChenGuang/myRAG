-- 0425 (multi-tenant): empty search_path for every public SECURITY DEFINER function, every trigger function and every
-- function created from 0301 on (Phase 4 gap closure, plan 04-47). 0411 and the Phase 3, 3.1 and 4 migrations fixed search_path to
-- pg_catalog, public or to public (a few legacy functions to public, pg_temp, three multi-tenant legacy triggers to nothing), and a trigger
-- runs with the search_path of the statement that fired it, so a trigger without its own path breaks under an empty-path writer.
-- search_path = '' does not take pg_temp out of the path: when pg_temp is not listed, PostgreSQL still searches it first for relations and
-- types, before pg_catalog. So '' alone does not stop a temporary table from shadowing a name; qualifying every relation does, and the bodies
-- therefore name catalog tables pg_catalog.pg_attribute and pg_catalog.pg_extension as well. Functions and operators are never looked up in
-- pg_temp. Each function below is replaced with SET search_path = '' and a body that differs from the one it replaces only by schema-qualified
-- names: public. tables, row types, functions and the vector and halfvec types, OPERATOR(public.<=>) for pgvector (both setup files install
-- vector in public), and pg_catalog. catalog tables. Signature, defaults, volatility, SECURITY mode, owner and grants are unchanged: CREATE OR
-- REPLACE keeps the ACL and this file issues no GRANT or REVOKE. The first block stops with 55000 unless pgvector is in schema public (the
-- bodies name public.vector and OPERATOR(public.<=>)) and every function already exists, so the file never creates one with default PUBLIC
-- execute. tests/rag-db/search-path-empty.test.mts. Idempotent: CREATE OR REPLACE only.

BEGIN;

DO $search_path_precheck$
DECLARE
  v_missing text[];
  v_vector_schema text;
BEGIN
  SELECT n.nspname INTO v_vector_schema
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'vector';
  IF v_vector_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION '0425: pgvector must be in schema public, found %; check with: SELECT extname, extnamespace::regnamespace FROM pg_catalog.pg_extension WHERE extname = ''vector''',
      COALESCE(v_vector_schema, 'no vector extension') USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(s.sig ORDER BY s.sig) INTO v_missing
  FROM pg_catalog.unnest(ARRAY[
    'public.can_view_org_member(uuid,uuid)',
    'public.create_organization_safe(text,text,uuid,boolean)',
    'public.delete_folder(uuid,boolean)',
    'public.get_admin_organization_id()',
    'public.get_documents_by_type_slug(uuid,text,text)',
    'public.get_documents_by_type_slug_workspace(uuid,uuid,text,text)',
    'public.get_folder_stats(uuid)',
    'public.get_user_current_org()',
    'public.get_user_org_ids(uuid)',
    'public.get_user_role_in_org(uuid)',
    'public.get_workspace_context(text,uuid)',
    'public.is_org_admin(uuid)',
    'public.is_org_member(uuid,uuid)',
    'public.is_org_owner(uuid)',
    'public.match_document_chunks_by_org(uuid,public.vector,integer,double precision)',
    'public.match_documents_by_workspace(public.vector,integer,double precision,uuid,uuid)',
    'public.move_chats_to_folder(uuid[],uuid)',
    'public.rag_admin_tenant_keys(uuid)',
    'public.rag_assert_tenant_key(text)',
    'public.rag_ingest_realtime_topic_allowed(text)',
    'public.share_chat(uuid,jsonb)',
    'public.share_personal_organization(uuid)',
    'public.unshare_chat(uuid)',
    'public.update_org_storage()'
  ]::text[]) AS s(sig)
  WHERE pg_catalog.to_regprocedure(s.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0425: apply the earlier migrations first, these functions are missing: %', v_missing USING ERRCODE = '55000';
  END IF;
END
$search_path_precheck$;

CREATE OR REPLACE FUNCTION public.can_view_org_member(member_user_id uuid, member_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- User can view if it's their own membership
  SELECT member_user_id = auth.uid()
  -- Or if they're in the same organization
  OR EXISTS (
    SELECT 1 FROM public.organization_members om
    WHERE om.organization_id = member_org_id
      AND om.user_id = auth.uid()
  )
  -- Or if they own the organization
  OR EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = member_org_id
      AND o.owner_id = auth.uid()
  );
$function$;

CREATE OR REPLACE FUNCTION public.create_organization_safe(p_name text, p_slug text, p_owner_id uuid, p_is_personal boolean DEFAULT true)
 RETURNS public.organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_org public.organizations;
  v_max_team_members INT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND p_owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not authorized to create an organization for another user' USING ERRCODE = '42501';
  END IF;

  -- Set team member limit based on organization type
  -- Personal projects: 1 member (owner only)
  -- Collaborative projects: 5 members (can invite)
  IF p_is_personal THEN
    v_max_team_members := 1;
  ELSE
    v_max_team_members := 5;
  END IF;

  -- Insert the organization
  INSERT INTO public.organizations (
    name,
    slug,
    owner_id,
    is_personal,
    max_team_members,
    subscription_tier,
    storage_limit_bytes,
    max_documents,
    max_monthly_messages
  ) VALUES (
    p_name,
    p_slug,
    p_owner_id,
    p_is_personal,
    v_max_team_members,
    'free',
    1073741824,  -- 1GB default
    50,          -- 50 documents default
    100          -- 100 messages default
  )
  RETURNING * INTO v_org;

  -- IMPORTANT: Also add the creator as owner member
  -- This ensures the user can immediately access the organization
  INSERT INTO public.organization_members (
    organization_id,
    user_id,
    role
  ) VALUES (
    v_org.id,
    p_owner_id,
    'owner'
  );

  RETURN v_org;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_folder(folder_uuid uuid, delete_chats boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.folders
    WHERE id = folder_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete this folder';
  END IF;

  IF delete_chats THEN
    DELETE FROM public.chats
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  ELSE
    UPDATE public.chats
    SET folder_id = NULL
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  END IF;

  DELETE FROM public.folders
  WHERE id = folder_uuid AND user_id = auth.uid();

  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_organization_id()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  admin_org_id UUID;
BEGIN
  SELECT id INTO admin_org_id
  FROM public.organizations
  WHERE slug = 'admin-uploads'
  LIMIT 1;

  IF admin_org_id IS NULL THEN
    INSERT INTO public.organizations (
      name,
      slug,
      owner_id,
      is_personal,
      subscription_tier,
      storage_limit_bytes,
      max_documents,
      max_monthly_messages,
      max_team_members
    )
    SELECT
      'Admin Uploads (Config UI)',
      'admin-uploads',
      id,
      false,
      'enterprise',
      107374182400,
      10000,
      1000000,
      1000
    FROM auth.users
    LIMIT 1
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO admin_org_id;
  END IF;

  RETURN admin_org_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug(p_org_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH tenant_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, true as is_tenant
    FROM public.documents d
    WHERE d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
    ORDER BY d.created_at DESC
  ),
  global_docs AS (
    SELECT d.id, d.organization_id, d.content, d.slug, false as is_tenant
    FROM public.documents d
    WHERE d.organization_id IS NULL
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
      AND NOT EXISTS (SELECT 1 FROM tenant_docs)
    ORDER BY d.created_at DESC
  )
  SELECT * FROM tenant_docs
  UNION ALL
  SELECT * FROM global_docs
  LIMIT 10;
$function$;

CREATE OR REPLACE FUNCTION public.get_documents_by_type_slug_workspace(p_org_id uuid, p_user_id uuid, p_content_type text, p_slug text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, organization_id uuid, user_id uuid, content text, slug text, is_tenant boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, true as is_tenant
    FROM public.documents d
    WHERE p_org_id IS NOT NULL
      AND d.organization_id = p_org_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  UNION ALL
  (
    SELECT d.id, d.organization_id, d.user_id, d.content, d.slug, false as is_tenant
    FROM public.documents d
    WHERE p_org_id IS NULL
      AND d.organization_id IS NULL
      AND d.user_id = p_user_id
      AND d.content_type = p_content_type
      AND (p_slug IS NULL OR d.slug = p_slug)
  )
  LIMIT 10;
$function$;

CREATE OR REPLACE FUNCTION public.get_folder_stats(folder_uuid uuid)
 RETURNS TABLE(chat_count bigint, last_updated timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as chat_count,
    MAX(c.updated_at) as last_updated
  FROM public.chats c
  WHERE c.folder_id = folder_uuid
    AND c.user_id = auth.uid();
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_current_org()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  org_id UUID;
BEGIN
  SELECT current_organization_id INTO org_id
  FROM public.user_preferences
  WHERE user_id = auth.uid();

  IF org_id IS NULL THEN
    SELECT organization_id INTO org_id
    FROM public.organization_members
    WHERE user_id = auth.uid()
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  RETURN org_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_org_ids(check_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT organization_id
  FROM public.organization_members
  WHERE user_id = check_user_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_role_in_org(org_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  user_role TEXT;
BEGIN
  SELECT role INTO user_role
  FROM public.organization_members
  WHERE organization_id = org_id
    AND user_id = auth.uid();

  RETURN user_role;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_workspace_context(p_domain text, p_user uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  org_id uuid;
BEGIN
  -- First check domain routing
  SELECT od.organization_id INTO org_id
  FROM public.organization_domains od
  WHERE od.domain = p_domain;

  -- Fallback to user preferences
  IF org_id IS NULL THEN
    SELECT up.current_organization_id INTO org_id
    FROM public.user_preferences up
    WHERE up.user_id = p_user;
  END IF;

  RETURN org_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_org_admin(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = org_id
        AND om.user_id = auth.uid()
        AND om.role IN ('owner', 'admin')
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_org_member(org_id uuid, check_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN COALESCE(
    (check_user_id = auth.uid() OR auth.role() = 'service_role')
    AND EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE organization_id = org_id AND user_id = check_user_id
    ),
    false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_org_owner(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(
    EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = org_id AND o.owner_id = auth.uid()),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.match_document_chunks_by_org(p_org_id uuid, p_query_embedding public.vector, p_match_count integer DEFAULT 8, p_min_similarity double precision DEFAULT 0.2)
 RETURNS TABLE(document_id uuid, chunk_id uuid, content text, similarity double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    dc.document_id,
    dc.id as chunk_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity
  FROM public.document_chunks dc
  WHERE (dc.organization_id = p_org_id OR dc.organization_id IS NULL)
    AND dc.embedding IS NOT NULL
    AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) >= p_min_similarity
    AND dc.is_current AND dc.status = 'ready'
  ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT p_match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(p_query_embedding public.vector, p_match_count integer, p_min_similarity double precision, p_org_id uuid, p_user_id uuid)
 RETURNS TABLE(id uuid, document_id uuid, content text, similarity double precision, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) as similarity,
    dc.metadata
  FROM public.document_chunks dc
  INNER JOIN public.documents d ON d.id = dc.document_id
  WHERE dc.embedding IS NOT NULL
    AND dc.is_current AND dc.status = 'ready'
    AND 1 - (dc.embedding OPERATOR(public.<=>) p_query_embedding) > p_min_similarity
    AND (
      -- Personal workspace: user owns document and no organization
      (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
      OR
      -- Team workspace: document belongs to organization
      (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
    )
  ORDER BY dc.embedding OPERATOR(public.<=>) p_query_embedding
  LIMIT p_match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.move_chats_to_folder(chat_ids uuid[], target_folder_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  updated_count INTEGER;
BEGIN
  IF target_folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.folders
    WHERE id = target_folder_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to use this folder';
  END IF;

  UPDATE public.chats
  SET folder_id = target_folder_id,
      updated_at = TIMEZONE('utc', NOW())
  WHERE id = ANY(chat_ids)
    AND user_id = auth.uid();

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  RETURN updated_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rag_admin_tenant_keys(p_actor uuid)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  multi_tenant boolean;
  keys text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF NOT multi_tenant THEN
    RETURN ARRAY['s:default'];
  END IF;
  keys := ARRAY['u:' || p_actor::text];
  keys := keys || COALESCE(
    (SELECT array_agg('o:' || m.organization_id::text) FROM public.organization_members m WHERE m.user_id = p_actor AND m.role IN ('owner', 'admin')),
    '{}'::text[]
  );
  RETURN keys;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_assert_tenant_key(p_tenant_key text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF p_tenant_key IS NULL OR p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'malformed tenant key' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_key = 's:default' THEN
    RAISE EXCEPTION 'tenant key not valid for this deployment mode' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_realtime_topic_allowed(p_topic text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid;
  v_org uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_topic IS NULL OR btrim(p_topic) = '' THEN
    RETURN false;
  END IF;
  IF p_topic = 'rag-ingest:u:' || v_uid::text THEN
    RETURN true;
  END IF;
  IF p_topic ~ '^rag-ingest:o:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    BEGIN
      v_org := (regexp_match(p_topic, '^rag-ingest:o:([0-9a-f-]{36})$'))[1]::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN false;
    END;
    RETURN public.is_org_member(v_org, v_uid);
  END IF;
  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.share_chat(chat_uuid uuid, settings jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  new_share_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to share this chat';
  END IF;

  SELECT gen_random_uuid() INTO new_share_id;

  UPDATE public.chats
  SET is_shared = TRUE,
      share_id = new_share_id,
      share_settings = settings
  WHERE id = chat_uuid;

  RETURN new_share_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.share_personal_organization(org_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  org_record RECORD;
BEGIN
  -- Verify the organization exists and is personal
  SELECT * INTO org_record
  FROM public.organizations
  WHERE id = org_id
    AND is_personal = true
    AND owner_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found or not a personal organization';
  END IF;

  -- Convert to collaborative project
  UPDATE public.organizations
  SET
    is_personal = false,
    max_team_members = 5,  -- Default collaboration limit
    updated_at = NOW()
  WHERE id = org_id;

  RAISE NOTICE 'Converted personal organization % to collaborative project', org_id;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unshare_chat(chat_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to unshare this chat';
  END IF;

  UPDATE public.chats
  SET is_shared = FALSE
  WHERE id = chat_uuid;

  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_org_storage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.organizations
    SET storage_used_bytes = storage_used_bytes + COALESCE((NEW.metadata->>'file_size')::BIGINT, 0)
    WHERE id = NEW.organization_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.organizations
    SET storage_used_bytes = GREATEST(0, storage_used_bytes - COALESCE((OLD.metadata->>'file_size')::BIGINT, 0))
    WHERE id = OLD.organization_id;
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;

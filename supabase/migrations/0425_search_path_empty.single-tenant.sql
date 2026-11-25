-- 0425 (single-tenant): empty search_path for every public SECURITY DEFINER function, every trigger function and every
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
    'public.cleanup_old_chats()',
    'public.delete_folder(uuid,boolean)',
    'public.get_folder_stats(uuid)',
    'public.handle_updated_at()',
    'public.kb_writes_locked()',
    'public.move_chats_to_folder(uuid[],uuid)',
    'public.notify_mcp_tool_state_change()',
    'public.rag_admin_tenant_keys(uuid)',
    'public.rag_assert_tenant_key(text)',
    'public.rag_ingest_realtime_topic_allowed(text)',
    'public.share_chat(uuid,jsonb)',
    'public.unshare_chat(uuid)',
    'public.update_chat_timestamp()',
    'public.update_tool_execution_states_updated_at()',
    'public.update_whatsapp_timestamp()'
  ]::text[]) AS s(sig)
  WHERE pg_catalog.to_regprocedure(s.sig) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0425: apply the earlier migrations first, these functions are missing: %', v_missing USING ERRCODE = '55000';
  END IF;
END
$search_path_precheck$;

CREATE OR REPLACE FUNCTION public.cleanup_old_chats()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  -- Delete chats older than 3 days
  DELETE FROM public.chats
  WHERE created_at < NOW() - INTERVAL '3 days';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_folder(folder_uuid uuid, delete_chats boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Verify user owns the folder
  IF NOT EXISTS (
    SELECT 1 FROM public.folders
    WHERE id = folder_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to delete this folder';
  END IF;

  -- If delete_chats is true, delete all chats in the folder
  IF delete_chats THEN
    DELETE FROM public.chats
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  ELSE
    -- Otherwise, just remove the folder reference from chats
    UPDATE public.chats
    SET folder_id = NULL
    WHERE folder_id = folder_uuid AND user_id = auth.uid();
  END IF;

  -- Delete the folder
  DELETE FROM public.folders
  WHERE id = folder_uuid AND user_id = auth.uid();

  RETURN TRUE;
END;
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

CREATE OR REPLACE FUNCTION public.handle_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.kb_writes_locked()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN COALESCE(
    (SELECT read_only_doc_dashboard FROM public.admin_settings ORDER BY updated_at DESC LIMIT 1),
    false
  );
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
  -- Verify user owns the target folder (if not null)
  IF target_folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.folders
    WHERE id = target_folder_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to use this folder';
  END IF;

  -- Update chats that belong to the user
  UPDATE public.chats
  SET folder_id = target_folder_id,
      updated_at = TIMEZONE('utc', NOW())
  WHERE id = ANY(chat_ids)
    AND user_id = auth.uid();
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  
  RETURN updated_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_mcp_tool_state_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.mcp_tool_states IS DISTINCT FROM NEW.mcp_tool_states THEN
    PERFORM pg_notify(
      'mcp_tool_state_change',
      json_build_object(
        'table', TG_TABLE_NAME,
        'id', NEW.id
      )::text
    );
  END IF;
  RETURN NEW;
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
    (SELECT array_agg('o:' || m.organization_id::text) FROM organization_members m WHERE m.user_id = p_actor AND m.role IN ('owner', 'admin')),
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
  IF p_tenant_key <> 's:default' THEN
    RAISE EXCEPTION 'tenant key not valid for this deployment mode' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.rag_ingest_realtime_topic_allowed(p_topic text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND p_topic IS NOT NULL
    AND p_topic = 'rag-ingest:s:default';
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
  -- Verify the user owns this chat
  IF NOT EXISTS (
    SELECT 1 FROM public.chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to share this chat';
  END IF;

  -- Generate a new share ID
  SELECT gen_random_uuid() INTO new_share_id;

  -- Update the chat record
  UPDATE public.chats
  SET is_shared = TRUE,
      share_id = new_share_id,
      share_settings = settings
  WHERE id = chat_uuid;

  RETURN new_share_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unshare_chat(chat_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Verify the user owns this chat
  IF NOT EXISTS (
    SELECT 1 FROM public.chats
    WHERE id = chat_uuid AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to unshare this chat';
  END IF;

  -- Update the chat record
  UPDATE public.chats
  SET is_shared = FALSE
  WHERE id = chat_uuid;

  RETURN TRUE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_chat_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.chats 
  SET updated_at = CURRENT_TIMESTAMP 
  WHERE id = NEW.chat_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_tool_execution_states_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_whatsapp_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = TIMEZONE('utc', NOW());
  RETURN NEW;
END;
$function$;

COMMIT;

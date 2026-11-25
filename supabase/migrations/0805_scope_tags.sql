-- 0805: Scope tag vocabulary and the document tag setter (plan 03.2-41; D-38, D-40, D-50; DATA-18; research F-12).
-- rag_scope_vocabulary holds each tenant's values for the three fixed dimensions (region, legal_entity, department). Every value, label
-- and alias comes from the tenant's admin; product code ships none. A tag is stored as dimension:value in documents.scopes and copied to
-- document_chunks.scopes (columns and GIN index from 0801). Tags are a retrieval filter column only: they never grant, hide or protect a
-- document from a user of the tenant, they are not part of the ingestion fingerprint, and setting them re-embeds nothing.
-- The table has RLS on and no policies; service_role may only read it and every write goes through the service_role functions below.
-- Admin access is rag_upload_approval_keys (0803, rebuilt by 0814): a deployment admin for its workspaces, and in multi-tenant mode the
-- owner or admin of an organization for that organization. rag_set_document_scopes also accepts the document's uploader as actor (the
-- upload path of plan 43). The setter locks the document row, writes the document and all its chunks, and calls rag_cache_invalidate for
-- the document in the same transaction, because the 0603 triggers do not see a scopes change (F-12).
-- Purge: rag_purge_hook_scope_tags(p_tenant_key, p_lineage_id, p_document_ids) clears the tags of a purged lineage's documents and chunks.
-- The vocabulary is tenant configuration, not document data, and is not touched by a lineage purge.
-- Every function here is service_role only: REVOKE ALL FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature.
-- Not folded into the setup files. Idempotent: CREATE OR REPLACE, IF NOT EXISTS, constraints rebuilt by name.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_scope_vocabulary (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  dimension text NOT NULL,
  value text NOT NULL,
  label text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}'::text[],
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.rag_scope_vocabulary DROP CONSTRAINT IF EXISTS rag_scope_vocabulary_tenant_key_check;
ALTER TABLE public.rag_scope_vocabulary ADD CONSTRAINT rag_scope_vocabulary_tenant_key_check CHECK (
  tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
);
ALTER TABLE public.rag_scope_vocabulary DROP CONSTRAINT IF EXISTS rag_scope_vocabulary_dimension_check;
ALTER TABLE public.rag_scope_vocabulary ADD CONSTRAINT rag_scope_vocabulary_dimension_check CHECK (dimension IN ('region', 'legal_entity', 'department'));
ALTER TABLE public.rag_scope_vocabulary DROP CONSTRAINT IF EXISTS rag_scope_vocabulary_value_check;
ALTER TABLE public.rag_scope_vocabulary ADD CONSTRAINT rag_scope_vocabulary_value_check CHECK (
  pg_catalog.length(value) <= 64 AND value ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
);
ALTER TABLE public.rag_scope_vocabulary DROP CONSTRAINT IF EXISTS rag_scope_vocabulary_label_check;
ALTER TABLE public.rag_scope_vocabulary ADD CONSTRAINT rag_scope_vocabulary_label_check CHECK (
  pg_catalog.length(label) BETWEEN 1 AND 200 AND label = pg_catalog.btrim(label)
);
ALTER TABLE public.rag_scope_vocabulary DROP CONSTRAINT IF EXISTS rag_scope_vocabulary_aliases_check;
ALTER TABLE public.rag_scope_vocabulary ADD CONSTRAINT rag_scope_vocabulary_aliases_check CHECK (
  pg_catalog.cardinality(aliases) <= 50 AND pg_catalog.array_position(aliases, NULL) IS NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_scope_vocabulary_value_idx ON public.rag_scope_vocabulary (tenant_key, dimension, value);

ALTER TABLE public.rag_scope_vocabulary ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_scope_vocabulary FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rag_scope_vocabulary TO service_role;

-- The slug a value is stored as: lower case, every run of characters other than a-z and 0-9 becomes one hyphen, no leading or trailing
-- hyphen. 'Area  A', 'area--a' and ' AREA_A ' are all 'area-a'. A text without ASCII letters or digits gives '' (refused as invalid_value).
CREATE OR REPLACE FUNCTION public.rag_scope_slug(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(COALESCE(p_value, '')), '[^a-z0-9]+', '-', 'g'), '-')
$function$;

-- The comparison form of a label or alias: trimmed, inner whitespace collapsed, lower case.
CREATE OR REPLACE FUNCTION public.rag_scope_name_key(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(COALESCE(p_name, '')), '\s+', ' ', 'g'))
$function$;

-- Aliases as stored: trimmed, inner whitespace collapsed, empty ones dropped, the first of names equal by rag_scope_name_key kept, order kept.
CREATE OR REPLACE FUNCTION public.rag_scope_clean_aliases(p_aliases text[])
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(pg_catalog.array_agg(c.alias ORDER BY c.position), '{}'::text[])
  FROM (
    SELECT DISTINCT ON (public.rag_scope_name_key(a.alias)) pg_catalog.regexp_replace(pg_catalog.btrim(a.alias), '\s+', ' ', 'g') AS alias, a.position
    FROM pg_catalog.unnest(COALESCE(p_aliases, '{}'::text[])) WITH ORDINALITY AS a(alias, position)
    WHERE a.alias IS NOT NULL AND public.rag_scope_name_key(a.alias) <> ''
    ORDER BY public.rag_scope_name_key(a.alias), a.position
  ) c
$function$;

-- True when one of p_names (labels and aliases, any form) equals a label or alias of another active entry of the tenant's dimension. Two
-- active values must never share a name, or rule-based suggestions (D-40) and the admin's pickers would be ambiguous.
CREATE OR REPLACE FUNCTION public.rag_scope_names_taken(p_tenant_key text, p_dimension text, p_names text[], p_exclude uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.rag_scope_vocabulary v
    CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.array_prepend(v.label, v.aliases)) AS taken(name)
    WHERE v.tenant_key = p_tenant_key AND v.dimension = p_dimension AND v.active AND v.id IS DISTINCT FROM p_exclude
      AND public.rag_scope_name_key(taken.name) IN (SELECT public.rag_scope_name_key(n.name) FROM pg_catalog.unnest(p_names) AS n(name))
  )
$function$;

-- Serializes vocabulary writes of one tenant and dimension, so two concurrent creates cannot both pass the name check.
CREATE OR REPLACE FUNCTION public.rag_scope_lock_dimension(p_tenant_key text, p_dimension text)
 RETURNS void
 LANGUAGE sql
 VOLATILE
 SET search_path TO ''
AS $function$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rag_scope_vocabulary|' || p_tenant_key || '|' || p_dimension, 0))
$function$;

-- True when the actor may administer the tenant's tags (rag_upload_approval_keys). Raises nothing for a non-admin.
CREATE OR REPLACE FUNCTION public.rag_scope_admin(p_actor uuid, p_tenant_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_actor IS NULL OR p_tenant_key IS NULL THEN
    RETURN false;
  END IF;
  RETURN p_tenant_key = ANY (public.rag_upload_approval_keys(p_actor));
END
$function$;

-- The tenant's vocabulary for an admin of it, in dimension order (region, legal_entity, department), then label, then value.
-- Another tenant's key or a non-admin actor gives no rows.
CREATE OR REPLACE FUNCTION public.rag_scope_vocabulary_list(p_actor uuid, p_tenant_key text)
 RETURNS TABLE(
   id uuid, tenant_key text, dimension text, value text, label text, aliases text[], active boolean,
   created_at timestamp with time zone, updated_at timestamp with time zone
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.rag_scope_admin(p_actor, p_tenant_key) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT v.id, v.tenant_key, v.dimension, v.value, v.label, v.aliases, v.active, v.created_at, v.updated_at
  FROM public.rag_scope_vocabulary v
  WHERE v.tenant_key = p_tenant_key
  ORDER BY pg_catalog.array_position(ARRAY['region', 'legal_entity', 'department'], v.dimension), pg_catalog.lower(v.label) COLLATE "C", v.value COLLATE "C";
END
$function$;

-- Service path (filter validation, upload tags, suggestions): the tenant's whole vocabulary with the active flag.
CREATE OR REPLACE FUNCTION public.rag_scope_vocabulary_for(p_tenant_key text)
 RETURNS TABLE(dimension text, value text, label text, aliases text[], active boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  RETURN QUERY
  SELECT v.dimension, v.value, v.label, v.aliases, v.active
  FROM public.rag_scope_vocabulary v
  WHERE v.tenant_key = p_tenant_key
  ORDER BY pg_catalog.array_position(ARRAY['region', 'legal_entity', 'department'], v.dimension), pg_catalog.lower(v.label) COLLATE "C", v.value COLLATE "C";
END
$function$;

-- Creates one value. Reason words: not_admin, invalid_dimension, invalid_value, invalid_label, invalid_aliases, tag_exists.
CREATE OR REPLACE FUNCTION public.rag_scope_vocabulary_create(
  p_actor uuid, p_tenant_key text, p_dimension text, p_value text, p_label text, p_aliases text[] DEFAULT '{}'::text[]
)
 RETURNS TABLE(
   id uuid, tenant_key text, dimension text, value text, label text, aliases text[], active boolean,
   created_at timestamp with time zone, updated_at timestamp with time zone
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_label text := pg_catalog.regexp_replace(pg_catalog.btrim(COALESCE(p_label, '')), '\s+', ' ', 'g');
  v_aliases text[];
  v_value text := public.rag_scope_slug(p_value);
  created public.rag_scope_vocabulary%ROWTYPE;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT public.rag_scope_admin(p_actor, p_tenant_key) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  IF p_dimension IS NULL OR p_dimension NOT IN ('region', 'legal_entity', 'department') THEN
    RAISE EXCEPTION 'invalid_dimension';
  END IF;
  IF pg_catalog.length(v_value) > 64 OR v_value !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'invalid_value';
  END IF;
  IF pg_catalog.length(v_label) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_label';
  END IF;
  IF pg_catalog.cardinality(COALESCE(p_aliases, '{}'::text[])) > 50
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p_aliases, '{}'::text[])) AS a(alias) WHERE pg_catalog.length(a.alias) > 200) THEN
    RAISE EXCEPTION 'invalid_aliases';
  END IF;
  v_aliases := public.rag_scope_clean_aliases(p_aliases);

  PERFORM public.rag_scope_lock_dimension(p_tenant_key, p_dimension);
  IF public.rag_scope_names_taken(p_tenant_key, p_dimension, pg_catalog.array_prepend(v_label, v_aliases), NULL) THEN
    RAISE EXCEPTION 'tag_exists';
  END IF;

  INSERT INTO public.rag_scope_vocabulary AS v (tenant_key, dimension, value, label, aliases, created_by, updated_by)
  VALUES (p_tenant_key, p_dimension, v_value, v_label, v_aliases, p_actor, p_actor)
  ON CONFLICT (tenant_key, dimension, value) DO NOTHING
  RETURNING v.* INTO created;
  IF created.id IS NULL THEN
    RAISE EXCEPTION 'tag_exists';
  END IF;

  RETURN QUERY SELECT created.id, created.tenant_key, created.dimension, created.value, created.label, created.aliases, created.active,
                      created.created_at, created.updated_at;
END
$function$;

-- Changes the label, the aliases or the active flag of one value. The value and the dimension never change: p_dimension and p_value, when
-- given, must equal the stored ones (value_immutable). Reason words: not_admin, not_found, value_immutable, invalid_label, invalid_aliases.
CREATE OR REPLACE FUNCTION public.rag_scope_vocabulary_update(
  p_actor uuid, p_tenant_key text, p_id uuid, p_label text DEFAULT NULL, p_aliases text[] DEFAULT NULL, p_active boolean DEFAULT NULL,
  p_dimension text DEFAULT NULL, p_value text DEFAULT NULL
)
 RETURNS TABLE(
   id uuid, tenant_key text, dimension text, value text, label text, aliases text[], active boolean,
   created_at timestamp with time zone, updated_at timestamp with time zone
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  entry public.rag_scope_vocabulary%ROWTYPE;
  v_label text;
  v_aliases text[];
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF NOT public.rag_scope_admin(p_actor, p_tenant_key) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  SELECT v.* INTO entry FROM public.rag_scope_vocabulary v WHERE v.id = p_id AND v.tenant_key = p_tenant_key FOR UPDATE;
  IF entry.id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF (p_dimension IS NOT NULL AND p_dimension <> entry.dimension) OR (p_value IS NOT NULL AND public.rag_scope_slug(p_value) <> entry.value) THEN
    RAISE EXCEPTION 'value_immutable';
  END IF;
  v_label := COALESCE(pg_catalog.regexp_replace(pg_catalog.btrim(p_label), '\s+', ' ', 'g'), entry.label);
  IF pg_catalog.length(v_label) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_label';
  END IF;
  IF pg_catalog.cardinality(COALESCE(p_aliases, '{}'::text[])) > 50
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p_aliases, '{}'::text[])) AS a(alias) WHERE pg_catalog.length(a.alias) > 200) THEN
    RAISE EXCEPTION 'invalid_aliases';
  END IF;
  v_aliases := CASE WHEN p_aliases IS NULL THEN entry.aliases ELSE public.rag_scope_clean_aliases(p_aliases) END;

  PERFORM public.rag_scope_lock_dimension(p_tenant_key, entry.dimension);
  IF COALESCE(p_active, entry.active)
     AND public.rag_scope_names_taken(p_tenant_key, entry.dimension, pg_catalog.array_prepend(v_label, v_aliases), entry.id) THEN
    RAISE EXCEPTION 'tag_exists';
  END IF;

  UPDATE public.rag_scope_vocabulary v
  SET label = v_label, aliases = v_aliases, active = COALESCE(p_active, entry.active), updated_by = p_actor, updated_at = pg_catalog.now()
  WHERE v.id = entry.id
  RETURNING v.* INTO entry;

  RETURN QUERY SELECT entry.id, entry.tenant_key, entry.dimension, entry.value, entry.label, entry.aliases, entry.active,
                      entry.created_at, entry.updated_at;
END
$function$;

-- Sets the complete tag list of one document and copies it to all its chunks in one transaction (no re-embed, fingerprint untouched),
-- then removes the tenant's cached answers that name the document (F-12). The actor must be an admin of the tenant or the document's
-- uploader; anyone else, another tenant's document and an unknown id all get not_found. Every tag must be dimension:value of an entry of
-- the tenant's vocabulary (unknown_scope_value).
CREATE OR REPLACE FUNCTION public.rag_set_document_scopes(p_document_id uuid, p_tenant_key text, p_scopes text[], p_actor uuid)
 RETURNS TABLE(document_id uuid, scopes text[], chunks_updated integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  doc record;
  v_scopes text[];
  v_chunks integer;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL OR p_actor IS NULL OR p_scopes IS NULL THEN
    RAISE EXCEPTION 'invalid_argument';
  END IF;

  SELECT d.id, d.user_id, d.scopes INTO doc FROM public.documents d WHERE d.id = p_document_id AND d.tenant_key = p_tenant_key FOR UPDATE;
  IF doc.id IS NULL OR NOT (public.rag_scope_admin(p_actor, p_tenant_key) OR doc.user_id IS NOT DISTINCT FROM p_actor) THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(DISTINCT t.tag ORDER BY t.tag), '{}'::text[]) INTO v_scopes
  FROM pg_catalog.unnest(p_scopes) AS u(raw)
  CROSS JOIN LATERAL (SELECT u.raw COLLATE "C" AS tag) AS t;
  IF pg_catalog.array_position(p_scopes, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'unknown_scope_value';
  END IF;
  IF pg_catalog.cardinality(v_scopes) > 20 THEN
    RAISE EXCEPTION 'too_many_scopes';
  END IF;
  -- Every tag must be an active entry of the tenant's vocabulary; a retired entry is accepted only where the document already carries it,
  -- so editing a document's other tags does not force a retired tag off it.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(v_scopes) AS s(tag)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rag_scope_vocabulary v
      WHERE v.tenant_key = p_tenant_key AND (v.dimension || ':' || v.value) = s.tag AND (v.active OR s.tag = ANY (doc.scopes))
    )
  ) THEN
    RAISE EXCEPTION 'unknown_scope_value';
  END IF;

  UPDATE public.documents d SET scopes = v_scopes WHERE d.id = doc.id;
  UPDATE public.document_chunks c SET scopes = v_scopes WHERE c.document_id = doc.id;
  GET DIAGNOSTICS v_chunks = ROW_COUNT;
  PERFORM public.rag_cache_invalidate(p_tenant_key, ARRAY[doc.id]);

  RETURN QUERY SELECT doc.id, v_scopes, v_chunks;
END
$function$;

-- Purge hook (phase rule: every new 3.2 store): clears the tags of a purged lineage's documents, or of the listed documents in that
-- tenant, and of their chunks. Returns the number of rows changed.
CREATE OR REPLACE FUNCTION public.rag_purge_hook_scope_tags(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  docs uuid[];
  changed_documents bigint;
  changed_chunks bigint;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  SELECT COALESCE(pg_catalog.array_agg(d.id), '{}'::uuid[]) INTO docs
  FROM public.documents d
  WHERE d.tenant_key = p_tenant_key AND (d.lineage_id = p_lineage_id OR d.id = ANY (COALESCE(p_document_ids, '{}'::uuid[])));
  UPDATE public.documents d SET scopes = '{}'::text[] WHERE d.id = ANY (docs) AND d.scopes <> '{}'::text[];
  GET DIAGNOSTICS changed_documents = ROW_COUNT;
  UPDATE public.document_chunks c SET scopes = '{}'::text[] WHERE c.document_id = ANY (docs) AND c.scopes <> '{}'::text[];
  GET DIAGNOSTICS changed_chunks = ROW_COUNT;
  RETURN changed_documents + changed_chunks;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_scope_slug(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_slug(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_name_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_name_key(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_clean_aliases(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_clean_aliases(text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_names_taken(text, text, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_names_taken(text, text, text[], uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_lock_dimension(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_lock_dimension(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_admin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_admin(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_list(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_list(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_for(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_for(text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_create(uuid, text, text, text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_create(uuid, text, text, text, text, text[]) TO service_role;
REVOKE ALL ON FUNCTION public.rag_scope_vocabulary_update(uuid, text, uuid, text, text[], boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_scope_vocabulary_update(uuid, text, uuid, text, text[], boolean, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_set_document_scopes(uuid, text, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_set_document_scopes(uuid, text, text[], uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rag_purge_hook_scope_tags(text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_purge_hook_scope_tags(text, uuid, uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

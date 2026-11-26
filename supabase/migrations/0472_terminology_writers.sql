-- 0472: Phase 4.1.1 terminology writers, suppression, atomic import and the admin reads (D-03, D-04, D-05, D-06, D-07, D-23, D-32, D-35).
-- Every dictionary change goes through these functions; the tables of 0471 grant service_role SELECT only.
-- Who may act (D-03): p_actor is the guard-verified admin id from the route layer. The shared layer needs admin_users membership; a tenant
-- layer needs the key in rag_admin_tenant_keys(p_actor); in single-tenant mode a tenant layer is refused with workspace_layer_unavailable.
-- An entry id of another layer answers not_found, so ids are not probed.
-- Versions (D-05): each successful write locks the layer row, checks p_expected_version (version_conflict when stale, the current version in
-- DETAIL), increments the version by exactly one (creating the layer row at 1), recomputes entries_sha256 and writes one rag_term_audit row
-- per changed entry with before and after JSON and the new layer version, all in the caller's transaction.
-- entries_sha256 is the sha256 of the layer's entries as canonical JSON without the row id, sorted, so equal content gives an equal hash.
-- Deleting a shared entry removes every tenant suppression of it (ON DELETE CASCADE in 0471); those rows are audited as unsuppress on their
-- tenant layer first, and each such tenant layer is bumped too.
-- Entries (D-04, D-32): the entry JSON carries canonical, variants, normalized_variants, language, kind, mode, enabled, note,
-- source_language and target_language. The writers do not normalize text: normalized_variants are stored as sent and must have the length of
-- variants. A row the table CHECKs or the writer rules reject raises invalid_entry. No language code is named here (D-35).
-- Import (D-23): all-or-nothing, keyed by (language, target_language or empty, lower(canonical)); replace also deletes absent entries.
-- At most 5,000 rows per import and 20,000 entries per layer (limit).
-- Errors are P0001 with the code as the whole message: not_admin, not_admin_of_layer, workspace_layer_unavailable, not_found,
-- version_conflict, invalid_entry, limit.
-- The six rag_term_ functions run with definer rights and are executable by service_role only. The internal rag_term__ helpers are SECURITY INVOKER
-- with no grant at all: they run only inside those functions, as the owner. Lock order: shared layer, shared entry, tenant layers.
-- Idempotent: CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.rag_term__authorize(p_actor uuid, p_layer_key text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_multi_tenant boolean;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_admin' USING ERRCODE = 'P0001';
  END IF;
  IF p_layer_key = 'shared' THEN
    RETURN;
  END IF;
  v_multi_tenant := EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.documents'::pg_catalog.regclass AND attname = 'user_id' AND attnotnull AND NOT attisdropped
  );
  IF NOT v_multi_tenant THEN
    RAISE EXCEPTION 'workspace_layer_unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF p_layer_key IS NULL OR NOT (p_layer_key = ANY (public.rag_admin_tenant_keys(p_actor))) THEN
    RAISE EXCEPTION 'not_admin_of_layer' USING ERRCODE = 'P0001';
  END IF;
END
$fn$;

-- Locks the layer row (creating it at version 0), checks the expected version when p_check, and returns the incremented version.
CREATE OR REPLACE FUNCTION public.rag_term__bump(p_layer_key text, p_actor uuid, p_expected bigint, p_check boolean DEFAULT true)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_current bigint;
BEGIN
  INSERT INTO public.rag_term_layers (layer_key, version) VALUES (p_layer_key, 0) ON CONFLICT (layer_key) DO NOTHING;
  SELECT l.version INTO v_current FROM public.rag_term_layers l WHERE l.layer_key = p_layer_key FOR UPDATE;
  IF p_check AND (p_expected IS NULL OR p_expected <> v_current) THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001',
      DETAIL = pg_catalog.jsonb_build_object('current_version', v_current)::text;
  END IF;
  UPDATE public.rag_term_layers l
     SET version = v_current + 1, updated_at = pg_catalog.now(), updated_by = p_actor
   WHERE l.layer_key = p_layer_key;
  RETURN v_current + 1;
END
$fn$;

-- The canonical JSON of one entry, used for the audit and (without id) for entries_sha256.
CREATE OR REPLACE FUNCTION public.rag_term__entry_json(p_row public.rag_term_entries)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'layer_key', p_row.layer_key,
    'canonical', p_row.canonical,
    'variants', pg_catalog.to_jsonb(p_row.variants),
    'normalized_variants', pg_catalog.to_jsonb(p_row.normalized_variants),
    'language', p_row.language,
    'kind', p_row.kind,
    'mode', p_row.mode,
    'source_language', p_row.source_language,
    'target_language', p_row.target_language,
    'enabled', p_row.enabled,
    'note', p_row.note,
    'suppresses_entry_id', p_row.suppresses_entry_id
  )
$fn$;

CREATE OR REPLACE FUNCTION public.rag_term__refresh_sha(p_layer_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_sha text;
BEGIN
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(c.doc, E'\n' ORDER BY c.doc COLLATE "C"), ''), 'UTF8')),
           'hex')
    INTO v_sha
    FROM (
      SELECT (public.rag_term__entry_json(e.*) - 'id')::text AS doc
        FROM public.rag_term_entries e
       WHERE e.layer_key = p_layer_key
    ) c;
  UPDATE public.rag_term_layers l SET entries_sha256 = v_sha WHERE l.layer_key = p_layer_key;
  RETURN v_sha;
END
$fn$;

-- Parses an entry JSON into a row (no id, no layer). Shape errors raise invalid_entry; the table CHECKs run when the row is written.
CREATE OR REPLACE FUNCTION public.rag_term__parse_entry(p_entry jsonb)
RETURNS public.rag_term_entries
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  r public.rag_term_entries;
  k text;
BEGIN
  IF p_entry IS NULL OR pg_catalog.jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
  END IF;
  FOREACH k IN ARRAY ARRAY['canonical', 'language', 'kind'] LOOP
    IF pg_catalog.jsonb_typeof(p_entry -> k) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['mode', 'note', 'source_language', 'target_language'] LOOP
    IF p_entry ? k AND pg_catalog.jsonb_typeof(p_entry -> k) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF p_entry ? 'enabled' AND pg_catalog.jsonb_typeof(p_entry -> 'enabled') NOT IN ('boolean', 'null') THEN
    RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
  END IF;
  FOREACH k IN ARRAY ARRAY['variants', 'normalized_variants'] LOOP
    IF pg_catalog.jsonb_typeof(p_entry -> k) IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(p_entry -> k) x WHERE pg_catalog.jsonb_typeof(x) <> 'string') THEN
      RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  r.canonical := p_entry ->> 'canonical';
  r.variants := ARRAY(SELECT t.v FROM pg_catalog.jsonb_array_elements_text(p_entry -> 'variants') WITH ORDINALITY AS t(v, n) ORDER BY t.n);
  r.normalized_variants := ARRAY(
    SELECT t.v FROM pg_catalog.jsonb_array_elements_text(p_entry -> 'normalized_variants') WITH ORDINALITY AS t(v, n) ORDER BY t.n
  );
  IF pg_catalog.cardinality(r.variants) <> pg_catalog.cardinality(r.normalized_variants)
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(r.variants) AS u(v) WHERE pg_catalog.char_length(u.v) > 64) THEN
    RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
  END IF;
  r.language := p_entry ->> 'language';
  r.kind := p_entry ->> 'kind';
  r.mode := COALESCE(p_entry ->> 'mode', 'one_way');
  r.enabled := COALESCE((p_entry ->> 'enabled')::boolean, true);
  r.note := p_entry ->> 'note';
  r.source_language := p_entry ->> 'source_language';
  r.target_language := p_entry ->> 'target_language';
  r.suppresses_entry_id := NULL;
  RETURN r;
END
$fn$;

-- Refuses a layer whose entries (suppressions not counted) would exceed 20,000.
CREATE OR REPLACE FUNCTION public.rag_term__assert_layer_size(p_layer_key text, p_adding integer)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.rag_term_entries e WHERE e.layer_key = p_layer_key AND e.suppresses_entry_id IS NULL) + p_adding > 20000 THEN
    RAISE EXCEPTION 'limit' USING ERRCODE = 'P0001';
  END IF;
END
$fn$;

-- Before shared entries are deleted: audits, per tenant layer, the suppressions the cascade will remove, bumps that layer and removes them.
CREATE OR REPLACE FUNCTION public.rag_term__release_suppressions(p_entry_ids uuid[], p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_layer text;
  v_version bigint;
BEGIN
  FOR v_layer IN
    SELECT DISTINCT s.layer_key FROM public.rag_term_entries s WHERE s.suppresses_entry_id = ANY (p_entry_ids) ORDER BY s.layer_key
  LOOP
    v_version := public.rag_term__bump(v_layer, p_actor, NULL, false);
    INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
    SELECT s.layer_key, s.suppresses_entry_id, 'unsuppress', p_actor, public.rag_term__entry_json(s.*), NULL, v_version
      FROM public.rag_term_entries s
     WHERE s.layer_key = v_layer AND s.suppresses_entry_id = ANY (p_entry_ids)
     ORDER BY s.id;
    DELETE FROM public.rag_term_entries s WHERE s.layer_key = v_layer AND s.suppresses_entry_id = ANY (p_entry_ids);
    PERFORM public.rag_term__refresh_sha(v_layer);
  END LOOP;
END
$fn$;

-- Creates an entry (no id in p_entry) or replaces the content of an entry of this layer (id given).
CREATE OR REPLACE FUNCTION public.rag_term_upsert_entry(
  p_actor uuid,
  p_layer_key text,
  p_entry jsonb,
  p_expected_version bigint
)
RETURNS TABLE (entry_id uuid, layer_version bigint, entries_sha256 text, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_row public.rag_term_entries;
  v_old public.rag_term_entries;
  v_new public.rag_term_entries;
  v_version bigint;
  v_action text;
  v_sha text;
BEGIN
  PERFORM public.rag_term__authorize(p_actor, p_layer_key);
  IF p_entry IS NOT NULL AND pg_catalog.jsonb_typeof(p_entry) = 'object' AND p_entry ? 'id'
     AND pg_catalog.jsonb_typeof(p_entry -> 'id') <> 'null' THEN
    IF pg_catalog.jsonb_typeof(p_entry -> 'id') <> 'string'
       OR (p_entry ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
    END IF;
    v_id := (p_entry ->> 'id')::uuid;
  END IF;
  v_row := public.rag_term__parse_entry(p_entry);
  v_version := public.rag_term__bump(p_layer_key, p_actor, p_expected_version);

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old
      FROM public.rag_term_entries e
     WHERE e.id = v_id AND e.layer_key = p_layer_key AND e.suppresses_entry_id IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
    END IF;
    BEGIN
      UPDATE public.rag_term_entries e
         SET canonical = v_row.canonical,
             variants = v_row.variants,
             normalized_variants = v_row.normalized_variants,
             language = v_row.language,
             kind = v_row.kind,
             mode = v_row.mode,
             enabled = v_row.enabled,
             note = v_row.note,
             source_language = v_row.source_language,
             target_language = v_row.target_language,
             updated_by = p_actor,
             updated_at = pg_catalog.now()
       WHERE e.id = v_id
      RETURNING * INTO v_new;
    EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation THEN
      RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
    END;
    v_action := 'update';
  ELSE
    PERFORM public.rag_term__assert_layer_size(p_layer_key, 1);
    BEGIN
      INSERT INTO public.rag_term_entries
        (layer_key, canonical, variants, normalized_variants, language, kind, mode, enabled, note, source_language, target_language,
         created_by, updated_by)
      VALUES
        (p_layer_key, v_row.canonical, v_row.variants, v_row.normalized_variants, v_row.language, v_row.kind, v_row.mode, v_row.enabled,
         v_row.note, v_row.source_language, v_row.target_language, p_actor, p_actor)
      RETURNING * INTO v_new;
    EXCEPTION WHEN check_violation OR not_null_violation OR unique_violation THEN
      RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
    END;
    v_action := 'create';
  END IF;

  INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
  VALUES (
    p_layer_key,
    v_new.id,
    v_action,
    p_actor,
    CASE WHEN v_old.id IS NULL THEN NULL ELSE public.rag_term__entry_json(v_old) END,
    public.rag_term__entry_json(v_new),
    v_version
  );
  v_sha := public.rag_term__refresh_sha(p_layer_key);
  RETURN QUERY SELECT v_new.id, v_version, v_sha, v_action;
END
$fn$;

CREATE OR REPLACE FUNCTION public.rag_term_delete_entry(
  p_actor uuid,
  p_layer_key text,
  p_entry_id uuid,
  p_expected_version bigint
)
RETURNS TABLE (layer_version bigint, entries_sha256 text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_old public.rag_term_entries;
  v_version bigint;
  v_sha text;
BEGIN
  PERFORM public.rag_term__authorize(p_actor, p_layer_key);
  v_version := public.rag_term__bump(p_layer_key, p_actor, p_expected_version);
  SELECT * INTO v_old
    FROM public.rag_term_entries e
   WHERE e.id = p_entry_id AND e.layer_key = p_layer_key AND e.suppresses_entry_id IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  IF p_layer_key = 'shared' THEN
    PERFORM public.rag_term__release_suppressions(ARRAY[p_entry_id], p_actor);
  END IF;
  INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
  VALUES (p_layer_key, v_old.id, 'delete', p_actor, public.rag_term__entry_json(v_old), NULL, v_version);
  DELETE FROM public.rag_term_entries e WHERE e.id = v_old.id;
  v_sha := public.rag_term__refresh_sha(p_layer_key);
  RETURN QUERY SELECT v_version, v_sha;
END
$fn$;

-- Suppresses (or unsuppresses) a shared entry for one tenant layer. The suppression row copies the shared entry's canonical, languages and
-- kind and has no variants (the 0471 suppression CHECK). The audit row's entry_id is the shared entry id.
CREATE OR REPLACE FUNCTION public.rag_term_set_suppression(
  p_actor uuid,
  p_layer_key text,
  p_shared_entry_id uuid,
  p_suppressed boolean,
  p_expected_version bigint
)
RETURNS TABLE (layer_version bigint, entries_sha256 text, suppressed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_shared public.rag_term_entries;
  v_old public.rag_term_entries;
  v_new public.rag_term_entries;
  v_version bigint;
  v_sha text;
BEGIN
  PERFORM public.rag_term__authorize(p_actor, p_layer_key);
  IF p_layer_key = 'shared' OR p_suppressed IS NULL THEN
    RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_shared
    FROM public.rag_term_entries e
   WHERE e.id = p_shared_entry_id AND e.layer_key = 'shared' AND e.suppresses_entry_id IS NULL
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0001';
  END IF;
  v_version := public.rag_term__bump(p_layer_key, p_actor, p_expected_version);
  SELECT * INTO v_old
    FROM public.rag_term_entries s
   WHERE s.layer_key = p_layer_key AND s.suppresses_entry_id = p_shared_entry_id
     FOR UPDATE;

  IF p_suppressed THEN
    IF v_old.id IS NULL THEN
      INSERT INTO public.rag_term_entries
        (layer_key, canonical, variants, normalized_variants, language, kind, mode, enabled, source_language, target_language,
         suppresses_entry_id, created_by, updated_by)
      VALUES
        (p_layer_key, v_shared.canonical, '{}'::text[], '{}'::text[], v_shared.language, v_shared.kind, v_shared.mode, true,
         v_shared.source_language, v_shared.target_language, v_shared.id, p_actor, p_actor)
      RETURNING * INTO v_new;
      INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
      VALUES (p_layer_key, v_shared.id, 'suppress', p_actor, NULL, public.rag_term__entry_json(v_new), v_version);
    ELSIF NOT v_old.enabled THEN
      UPDATE public.rag_term_entries s SET enabled = true, updated_by = p_actor, updated_at = pg_catalog.now()
       WHERE s.id = v_old.id
      RETURNING * INTO v_new;
      INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
      VALUES (p_layer_key, v_shared.id, 'suppress', p_actor, public.rag_term__entry_json(v_old), public.rag_term__entry_json(v_new), v_version);
    END IF;
  ELSIF v_old.id IS NOT NULL THEN
    INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
    VALUES (p_layer_key, v_shared.id, 'unsuppress', p_actor, public.rag_term__entry_json(v_old), NULL, v_version);
    DELETE FROM public.rag_term_entries s WHERE s.id = v_old.id;
  END IF;

  v_sha := public.rag_term__refresh_sha(p_layer_key);
  RETURN QUERY SELECT v_version, v_sha, p_suppressed;
END
$fn$;

-- All-or-nothing import (D-23). p_rows is a JSON array of entry objects without ids; p_mode is merge or replace. A rejected row raises
-- invalid_entry with its 1-based position as DETAIL {"row": n}; nothing is written.
CREATE OR REPLACE FUNCTION public.rag_term_apply_import(
  p_actor uuid,
  p_layer_key text,
  p_rows jsonb,
  p_mode text,
  p_expected_version bigint
)
RETURNS TABLE (layer_version bigint, entries_sha256 text, created integer, updated integer, unchanged integer, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_rows public.rag_term_entries[] := '{}'::public.rag_term_entries[];
  v_keys text[] := '{}'::text[];
  v_elem jsonb;
  v_n bigint;
  v_i integer;
  v_row public.rag_term_entries;
  v_old public.rag_term_entries;
  v_new public.rag_term_entries;
  v_key text;
  v_version bigint;
  v_delete uuid[];
  v_created integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_deleted integer := 0;
  v_sha text;
BEGIN
  PERFORM public.rag_term__authorize(p_actor, p_layer_key);
  IF p_mode IS NULL OR p_mode NOT IN ('merge', 'replace') OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'limit' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    FOR v_elem, v_n IN SELECT t.value, t.n FROM pg_catalog.jsonb_array_elements(p_rows) WITH ORDINALITY AS t(value, n) ORDER BY t.n LOOP
      v_row := public.rag_term__parse_entry(v_elem);
      v_key := v_row.language || E'\x1f' || COALESCE(v_row.target_language, '') || E'\x1f' || pg_catalog.lower(v_row.canonical);
      IF v_key = ANY (v_keys) THEN
        RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
      END IF;
      v_keys := v_keys || v_key;
      v_rows := v_rows || v_row;
    END LOOP;
    v_n := NULL;

    v_version := public.rag_term__bump(p_layer_key, p_actor, p_expected_version);

    FOR v_i IN 1 .. COALESCE(pg_catalog.cardinality(v_rows), 0) LOOP
      v_n := v_i;
      v_row := v_rows[v_i];
      v_old := NULL;
      SELECT * INTO v_old
        FROM public.rag_term_entries e
       WHERE e.layer_key = p_layer_key
         AND e.suppresses_entry_id IS NULL
         AND e.language = v_row.language
         AND COALESCE(e.target_language, '') = COALESCE(v_row.target_language, '')
         AND pg_catalog.lower(e.canonical) = pg_catalog.lower(v_row.canonical)
         FOR UPDATE;
      IF v_old.id IS NOT NULL THEN
        v_row.id := v_old.id;
        v_row.layer_key := p_layer_key;
        IF public.rag_term__entry_json(v_row) = public.rag_term__entry_json(v_old) THEN
          v_unchanged := v_unchanged + 1;
          CONTINUE;
        END IF;
        UPDATE public.rag_term_entries e
           SET canonical = v_row.canonical,
               variants = v_row.variants,
               normalized_variants = v_row.normalized_variants,
               language = v_row.language,
               kind = v_row.kind,
               mode = v_row.mode,
               enabled = v_row.enabled,
               note = v_row.note,
               source_language = v_row.source_language,
               target_language = v_row.target_language,
               updated_by = p_actor,
               updated_at = pg_catalog.now()
         WHERE e.id = v_old.id
        RETURNING * INTO v_new;
        INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
        VALUES (p_layer_key, v_new.id, 'import', p_actor, public.rag_term__entry_json(v_old), public.rag_term__entry_json(v_new), v_version);
        v_updated := v_updated + 1;
      ELSE
        INSERT INTO public.rag_term_entries
          (layer_key, canonical, variants, normalized_variants, language, kind, mode, enabled, note, source_language, target_language,
           created_by, updated_by)
        VALUES
          (p_layer_key, v_row.canonical, v_row.variants, v_row.normalized_variants, v_row.language, v_row.kind, v_row.mode, v_row.enabled,
           v_row.note, v_row.source_language, v_row.target_language, p_actor, p_actor)
        RETURNING * INTO v_new;
        INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
        VALUES (p_layer_key, v_new.id, 'import', p_actor, NULL, public.rag_term__entry_json(v_new), v_version);
        v_created := v_created + 1;
      END IF;
    END LOOP;
    v_n := NULL;
  EXCEPTION
    WHEN check_violation OR not_null_violation OR unique_violation THEN
      IF v_n IS NULL THEN
        RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001', DETAIL = pg_catalog.jsonb_build_object('row', v_n)::text;
    WHEN raise_exception THEN
      IF SQLERRM = 'invalid_entry' AND v_n IS NOT NULL THEN
        RAISE EXCEPTION 'invalid_entry' USING ERRCODE = 'P0001', DETAIL = pg_catalog.jsonb_build_object('row', v_n)::text;
      END IF;
      RAISE;
  END;

  IF p_mode = 'replace' THEN
    SELECT pg_catalog.array_agg(e.id ORDER BY e.id) INTO v_delete
      FROM public.rag_term_entries e
     WHERE e.layer_key = p_layer_key
       AND e.suppresses_entry_id IS NULL
       AND NOT ((e.language || E'\x1f' || COALESCE(e.target_language, '') || E'\x1f' || pg_catalog.lower(e.canonical)) = ANY (v_keys));
    IF v_delete IS NOT NULL THEN
      PERFORM 1 FROM public.rag_term_entries e WHERE e.id = ANY (v_delete) ORDER BY e.id FOR UPDATE;
      IF p_layer_key = 'shared' THEN
        PERFORM public.rag_term__release_suppressions(v_delete, p_actor);
      END IF;
      INSERT INTO public.rag_term_audit (layer_key, entry_id, action, actor, before, after, layer_version)
      SELECT p_layer_key, e.id, 'import', p_actor, public.rag_term__entry_json(e.*), NULL, v_version
        FROM public.rag_term_entries e
       WHERE e.id = ANY (v_delete)
       ORDER BY e.id;
      DELETE FROM public.rag_term_entries e WHERE e.id = ANY (v_delete);
      v_deleted := pg_catalog.cardinality(v_delete);
    END IF;
  END IF;

  PERFORM public.rag_term__assert_layer_size(p_layer_key, 0);
  v_sha := public.rag_term__refresh_sha(p_layer_key);
  RETURN QUERY SELECT v_version, v_sha, v_created, v_updated, v_unchanged, v_deleted;
END
$fn$;

-- One page of a layer's entries (suppression rows included, marked by suppresses_entry_id), with the layer version and total_count before
-- the page is cut. p_search matches canonical or any variant, case-insensitively, as a plain substring.
CREATE OR REPLACE FUNCTION public.rag_term_list_entries(
  p_actor uuid,
  p_layer_key text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL
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
     AND (
       v_search IS NULL
       OR pg_catalog.strpos(pg_catalog.lower(e.canonical), v_search) > 0
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(e.variants) AS u(v) WHERE pg_catalog.strpos(pg_catalog.lower(u.v), v_search) > 0)
     )
   ORDER BY pg_catalog.lower(e.canonical), e.language, COALESCE(e.target_language, ''), e.id
   LIMIT v_page OFFSET v_skip;
END
$fn$;

-- One page of a layer's audit, newest first. Actors are ids only; nothing joins auth.users.
CREATE OR REPLACE FUNCTION public.rag_term_list_audit(
  p_actor uuid,
  p_layer_key text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  layer_key text,
  entry_id uuid,
  action text,
  actor uuid,
  before jsonb,
  after jsonb,
  layer_version bigint,
  created_at timestamptz,
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
BEGIN
  PERFORM public.rag_term__authorize(p_actor, p_layer_key);
  RETURN QUERY
  SELECT a.id, a.layer_key, a.entry_id, a.action, a.actor, a.before, a.after, a.layer_version, a.created_at, pg_catalog.count(*) OVER ()
    FROM public.rag_term_audit a
   WHERE a.layer_key = p_layer_key
   ORDER BY a.layer_version DESC, a.created_at DESC, a.id
   LIMIT v_page OFFSET v_skip;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_term__authorize(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rag_term__bump(text, uuid, bigint, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rag_term__entry_json(public.rag_term_entries) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rag_term__refresh_sha(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rag_term__parse_entry(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rag_term__assert_layer_size(text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rag_term__release_suppressions(uuid[], uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.rag_term_upsert_entry(uuid, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_delete_entry(uuid, text, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_set_suppression(uuid, text, uuid, boolean, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_apply_import(uuid, text, jsonb, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rag_term_list_audit(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_term_upsert_entry(uuid, text, jsonb, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_delete_entry(uuid, text, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_set_suppression(uuid, text, uuid, boolean, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_apply_import(uuid, text, jsonb, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_list_entries(uuid, text, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rag_term_list_audit(uuid, text, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

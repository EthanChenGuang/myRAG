-- 0806: Supersession candidates and confirmed lineage links (plan 03.2-44; D-41 tables, D-42; DATA-19).
-- An older version uploaded as a different file is retired only by an admin's confirmation. rag_supersession_candidates holds the pairs
-- (raised by the detector, by an uploader's "Replaces..." or by an answer conflict); rag_supersession_links records each confirmed retirement
-- of one lineage by another. Both tables have RLS on and no policies; service_role may only read them and every write goes through the
-- service_role functions below. Nothing changes a document until rag_confirm_supersession: it sets the older document and its chunks to
-- is_current = false with superseded_by = the newer document in one transaction (the DATA-07 row change; vectors are kept so that
-- rag_undo_supersession restores retrieval), records the link and writes one rag_admin_audit row. The semantic cache of the tenant is
-- invalidated by the existing documents triggers (0603). Admin access is rag_admin_tenant_keys through rag_upload_approval_keys (0803), so a
-- non-admin and an admin of another tenant both get not_found.
-- Locking: a decision locks the candidate row, then the lineage advisory locks of both documents (the lock rag_publish_document_version
-- takes) in key order, then both document rows in id order, and checks the candidate's status and staleness after the locks.
-- Purge: rag_purge_hook_supersession(p_tenant_key, p_lineage_id, p_document_ids) removes the candidates and links of a purged lineage.
-- Every function here is service_role only: REVOKE ALL FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role per signature.
-- Not folded into the setup files. Idempotent: CREATE OR REPLACE, IF NOT EXISTS, constraints rebuilt by name.

BEGIN;

-- rag_admin_audit actions: keep every action already allowed (0803 and any later migration) and add the three supersession decisions.
DO $audit_actions$
DECLARE
  allowed text[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}'::text[]) INTO allowed
  FROM pg_catalog.pg_constraint con
  CROSS JOIN LATERAL pg_catalog.regexp_matches(pg_catalog.pg_get_constraintdef(con.oid), '''([a-z_]+)''', 'g') AS m
  WHERE con.conrelid = 'public.rag_admin_audit'::regclass AND con.conname = 'rag_admin_audit_action_check';
  SELECT array_agg(DISTINCT a ORDER BY a) INTO allowed
  FROM pg_catalog.unnest(allowed || ARRAY['confirm_supersession', 'dismiss_supersession', 'undo_supersession']) AS a;
  ALTER TABLE public.rag_admin_audit DROP CONSTRAINT IF EXISTS rag_admin_audit_action_check;
  EXECUTE pg_catalog.format(
    'ALTER TABLE public.rag_admin_audit ADD CONSTRAINT rag_admin_audit_action_check CHECK (action IN (%s))',
    (SELECT pg_catalog.string_agg(pg_catalog.quote_literal(a), ', ' ORDER BY a) FROM pg_catalog.unnest(allowed) AS a)
  );
END
$audit_actions$;

-- Candidates (D-41). direction: document_newer (document_id is the newer one), candidate_newer, or NULL when unknown (the admin chooses).
-- older_document_id is filled at confirmation. The same unordered pair has at most one pending candidate.
CREATE TABLE IF NOT EXISTS public.rag_supersession_candidates (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  document_id uuid NOT NULL,
  candidate_document_id uuid NOT NULL,
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  direction text,
  status text NOT NULL DEFAULT 'pending',
  origin text NOT NULL,
  older_document_id uuid,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.rag_supersession_candidates DROP CONSTRAINT IF EXISTS rag_supersession_candidates_tenant_key_check;
ALTER TABLE public.rag_supersession_candidates ADD CONSTRAINT rag_supersession_candidates_tenant_key_check CHECK (
  tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
);
ALTER TABLE public.rag_supersession_candidates DROP CONSTRAINT IF EXISTS rag_supersession_candidates_pair_check;
ALTER TABLE public.rag_supersession_candidates ADD CONSTRAINT rag_supersession_candidates_pair_check CHECK (document_id <> candidate_document_id);
ALTER TABLE public.rag_supersession_candidates DROP CONSTRAINT IF EXISTS rag_supersession_candidates_signals_check;
ALTER TABLE public.rag_supersession_candidates ADD CONSTRAINT rag_supersession_candidates_signals_check CHECK (pg_catalog.jsonb_typeof(signals) = 'object');
ALTER TABLE public.rag_supersession_candidates DROP CONSTRAINT IF EXISTS rag_supersession_candidates_direction_check;
ALTER TABLE public.rag_supersession_candidates ADD CONSTRAINT rag_supersession_candidates_direction_check CHECK (
  direction IS NULL OR direction IN ('document_newer', 'candidate_newer')
);
ALTER TABLE public.rag_supersession_candidates DROP CONSTRAINT IF EXISTS rag_supersession_candidates_status_check;
ALTER TABLE public.rag_supersession_candidates ADD CONSTRAINT rag_supersession_candidates_status_check CHECK (status IN ('pending', 'confirmed', 'dismissed'));
ALTER TABLE public.rag_supersession_candidates DROP CONSTRAINT IF EXISTS rag_supersession_candidates_origin_check;
ALTER TABLE public.rag_supersession_candidates ADD CONSTRAINT rag_supersession_candidates_origin_check CHECK (origin IN ('detected', 'uploader', 'answer_conflict'));
ALTER TABLE public.rag_supersession_candidates DROP CONSTRAINT IF EXISTS rag_supersession_candidates_older_check;
ALTER TABLE public.rag_supersession_candidates ADD CONSTRAINT rag_supersession_candidates_older_check CHECK (
  older_document_id IS NULL OR older_document_id IN (document_id, candidate_document_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS rag_supersession_candidates_pending_pair_idx
  ON public.rag_supersession_candidates (tenant_key, LEAST(document_id, candidate_document_id), GREATEST(document_id, candidate_document_id))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS rag_supersession_candidates_tenant_time_idx ON public.rag_supersession_candidates (tenant_key, created_at, id);
CREATE INDEX IF NOT EXISTS rag_supersession_candidates_document_idx ON public.rag_supersession_candidates (document_id);
CREATE INDEX IF NOT EXISTS rag_supersession_candidates_candidate_document_idx ON public.rag_supersession_candidates (candidate_document_id);

ALTER TABLE public.rag_supersession_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_supersession_candidates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rag_supersession_candidates TO service_role;

-- Confirmed links: lineage older_lineage_id is retired by lineage newer_lineage_id. A lineage is retired by at most one link.
CREATE TABLE IF NOT EXISTS public.rag_supersession_links (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tenant_key text NOT NULL,
  older_lineage_id uuid NOT NULL,
  newer_lineage_id uuid NOT NULL,
  older_document_id uuid NOT NULL,
  newer_document_id uuid NOT NULL,
  candidate_id uuid NOT NULL REFERENCES public.rag_supersession_candidates (id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.rag_supersession_links DROP CONSTRAINT IF EXISTS rag_supersession_links_tenant_key_check;
ALTER TABLE public.rag_supersession_links ADD CONSTRAINT rag_supersession_links_tenant_key_check CHECK (
  tenant_key ~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
);
ALTER TABLE public.rag_supersession_links DROP CONSTRAINT IF EXISTS rag_supersession_links_lineages_check;
ALTER TABLE public.rag_supersession_links ADD CONSTRAINT rag_supersession_links_lineages_check CHECK (older_lineage_id <> newer_lineage_id);

CREATE UNIQUE INDEX IF NOT EXISTS rag_supersession_links_older_lineage_idx ON public.rag_supersession_links (tenant_key, older_lineage_id);
CREATE UNIQUE INDEX IF NOT EXISTS rag_supersession_links_candidate_idx ON public.rag_supersession_links (candidate_id);
CREATE INDEX IF NOT EXISTS rag_supersession_links_newer_lineage_idx ON public.rag_supersession_links (tenant_key, newer_lineage_id);

ALTER TABLE public.rag_supersession_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rag_supersession_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.rag_supersession_links TO service_role;

-- Raise a candidate (service path: the detector, the upload route, the answer-conflict writer). Both documents must be current and ready in
-- the tenant. Returns raised, or exists with the pending candidate of the same unordered pair.
CREATE OR REPLACE FUNCTION public.rag_supersession_raise(
  p_tenant_key text,
  p_document_id uuid,
  p_candidate_document_id uuid,
  p_signals jsonb,
  p_direction text,
  p_origin text
)
 RETURNS TABLE(outcome text, candidate_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  found_count integer;
  created uuid;
BEGIN
  PERFORM public.rag_assert_tenant_key(p_tenant_key);
  IF p_document_id IS NULL OR p_candidate_document_id IS NULL THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF p_document_id = p_candidate_document_id THEN
    RAISE EXCEPTION 'same_document' USING ERRCODE = '22023';
  END IF;
  IF p_direction IS NOT NULL AND p_direction NOT IN ('document_newer', 'candidate_newer') THEN
    RAISE EXCEPTION 'invalid_direction' USING ERRCODE = '22023';
  END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('detected', 'uploader', 'answer_conflict') THEN
    RAISE EXCEPTION 'invalid_origin' USING ERRCODE = '22023';
  END IF;
  IF p_signals IS NOT NULL AND pg_catalog.jsonb_typeof(p_signals) <> 'object' THEN
    RAISE EXCEPTION 'invalid_signals' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO found_count FROM public.documents d
  WHERE d.id IN (p_document_id, p_candidate_document_id) AND d.tenant_key = p_tenant_key AND d.is_current AND d.status = 'ready';
  IF found_count <> 2 THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  INSERT INTO public.rag_supersession_candidates AS c (tenant_key, document_id, candidate_document_id, signals, direction, origin)
  VALUES (p_tenant_key, p_document_id, p_candidate_document_id, COALESCE(p_signals, '{}'::jsonb), p_direction, p_origin)
  ON CONFLICT DO NOTHING
  RETURNING c.id INTO created;
  IF created IS NOT NULL THEN
    RETURN QUERY SELECT 'raised'::text, created;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'exists'::text, c.id FROM public.rag_supersession_candidates c
  WHERE c.tenant_key = p_tenant_key AND c.status = 'pending'
    AND LEAST(c.document_id, c.candidate_document_id) = LEAST(p_document_id, p_candidate_document_id)
    AND GREATEST(c.document_id, c.candidate_document_id) = GREATEST(p_document_id, p_candidate_document_id);
END
$function$;

-- Confirm (D-42). p_older_document_id names the older document when the candidate has no direction.
CREATE OR REPLACE FUNCTION public.rag_confirm_supersession(p_candidate_id uuid, p_actor uuid, p_older_document_id uuid DEFAULT NULL)
 RETURNS TABLE(outcome text, candidate_id uuid, older_document_id uuid, newer_document_id uuid, link_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  keys text[];
  cand public.rag_supersession_candidates%ROWTYPE;
  older_id uuid;
  newer_id uuid;
  older public.documents%ROWTYPE;
  newer public.documents%ROWTYPE;
  lock_key bigint;
  created uuid;
BEGIN
  keys := public.rag_upload_approval_keys(p_actor);
  SELECT * INTO cand FROM public.rag_supersession_candidates c WHERE c.id = p_candidate_id AND c.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF cand.status <> 'pending' THEN
    RAISE EXCEPTION 'already_decided';
  END IF;

  IF cand.direction = 'document_newer' THEN
    older_id := cand.candidate_document_id;
  ELSIF cand.direction = 'candidate_newer' THEN
    older_id := cand.document_id;
  END IF;
  older_id := COALESCE(older_id, p_older_document_id);
  newer_id := CASE WHEN older_id = cand.document_id THEN cand.candidate_document_id ELSE cand.document_id END;

  -- The lineage locks the publish function takes, in key order, then both document rows in id order.
  FOR lock_key IN
    SELECT DISTINCT pg_catalog.hashtextextended(d.tenant_key || '|' || d.source || '|' || d.source_key, 0) AS k
    FROM public.documents d WHERE d.id IN (cand.document_id, cand.candidate_document_id) AND d.tenant_key = cand.tenant_key
    ORDER BY 1
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(lock_key);
  END LOOP;
  PERFORM 1 FROM public.documents d
  WHERE d.id IN (cand.document_id, cand.candidate_document_id) AND d.tenant_key = cand.tenant_key
  ORDER BY d.id FOR UPDATE;

  SELECT * INTO older FROM public.documents d WHERE d.id = older_id AND d.tenant_key = cand.tenant_key;
  SELECT * INTO newer FROM public.documents d WHERE d.id = newer_id AND d.tenant_key = cand.tenant_key;
  IF older.id IS NULL OR newer.id IS NULL OR NOT (older.is_current AND older.status = 'ready' AND newer.is_current AND newer.status = 'ready') THEN
    RAISE EXCEPTION 'stale_candidate';
  END IF;

  UPDATE public.documents d SET is_current = false, superseded_by = newer.id WHERE d.id = older.id;
  UPDATE public.document_chunks c SET is_current = false WHERE c.document_id = older.id;

  INSERT INTO public.rag_supersession_links (tenant_key, older_lineage_id, newer_lineage_id, older_document_id, newer_document_id, candidate_id, created_by)
  VALUES (cand.tenant_key, older.lineage_id, newer.lineage_id, older.id, newer.id, cand.id, p_actor)
  RETURNING id INTO created;

  UPDATE public.rag_supersession_candidates c
  SET status = 'confirmed', older_document_id = older.id, decided_by = p_actor, decided_at = pg_catalog.now()
  WHERE c.id = cand.id;

  INSERT INTO public.rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('confirm_supersession', older.id, older.lineage_id, older.tenant_key, older.version, p_actor, '{}'::text[]);

  RETURN QUERY SELECT 'confirmed'::text, cand.id, older.id, newer.id, created;
END
$function$;

REVOKE ALL ON FUNCTION public.rag_supersession_raise(text, uuid, uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_supersession_raise(text, uuid, uuid, jsonb, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.rag_confirm_supersession(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_confirm_supersession(uuid, uuid, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- 0316: admin list, release and delete of quarantined documents, and the audit table (Phase 3, D-31, SEC-01).
-- A quarantined document (plan 03-20, and an invoice quarantined by extraction, plan 03-29) never reaches retrieval. These functions are the
-- only way out: release publishes the version through rag_publish_document_version (the D-11 swap) in the same transaction, delete removes
-- only that version. Both write one rag_admin_audit row (actor, document, lineage, tenant, version, rule ids, time; never document text).
-- Who may act: p_actor must be in admin_users, and only the tenants the actor administers are visible. Single-tenant: the single tenant
-- (s:default). Multi-tenant: the actor's personal tenant (u:<actor>) and every organization where the actor is owner or admin (o:<id>).
-- A document of any other tenant is indistinguishable from an unknown id (not_found), so ids of other tenants are not probed.
-- The functions are SECURITY DEFINER and executable by service_role only; the route layer passes the id of the verified admin as p_actor.
-- 0316_quarantine_access (mode-specific files, applied just before this one) closes the direct table read of quarantined rows.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE with fixed signatures, then REVOKE and GRANT.

BEGIN;

CREATE TABLE IF NOT EXISTS rag_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('release_quarantine', 'delete_quarantined')),
  document_id uuid NOT NULL,
  lineage_id uuid,
  tenant_key text NOT NULL,
  version integer,
  actor uuid NOT NULL,
  rule_ids text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_admin_audit_tenant_time_idx ON rag_admin_audit (tenant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS rag_admin_audit_document_idx ON rag_admin_audit (document_id);

-- Server role only: RLS on without policies, nothing granted to anon or authenticated, and no document id is a foreign key so a row
-- outlives the document it records.
ALTER TABLE rag_admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rag_admin_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON rag_admin_audit TO service_role;

CREATE OR REPLACE FUNCTION rag_admin_audit_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'rag_admin_audit is append-only';
END
$$;

REVOKE ALL ON FUNCTION rag_admin_audit_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rag_admin_audit_immutable ON rag_admin_audit;
CREATE TRIGGER rag_admin_audit_immutable
  BEFORE UPDATE OR DELETE ON rag_admin_audit
  FOR EACH ROW EXECUTE FUNCTION rag_admin_audit_immutable();

DROP TRIGGER IF EXISTS rag_admin_audit_no_truncate ON rag_admin_audit;
CREATE TRIGGER rag_admin_audit_no_truncate
  BEFORE TRUNCATE ON rag_admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION rag_admin_audit_immutable();

-- The tenant keys p_actor administers. Raises not_admin for a user who is not in admin_users (checked on every call, nothing cached).
-- organization_members exists in the multi-tenant schema only; the statement is planned only on that branch.
CREATE OR REPLACE FUNCTION rag_admin_tenant_keys(p_actor uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  multi_tenant boolean;
  keys text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM admin_users a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;
  multi_tenant := EXISTS (
    SELECT 1 FROM pg_attribute
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
$$;

-- Quarantined versions of the tenants p_actor administers, newest first. Rule ids, up to three snippets of at most 80 characters and the
-- quarantine time come from documents.metadata.quarantine; detected_by tells an injection scan from an invoice extraction quarantine.
-- total_count is the number of matching rows before the page is cut.
CREATE OR REPLACE FUNCTION rag_list_quarantine(
  p_actor uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  document_id uuid,
  lineage_id uuid,
  tenant_key text,
  filename text,
  source text,
  version integer,
  rule_ids text[],
  snippets text[],
  quarantined_at timestamptz,
  detected_by text,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  page_size integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  skip integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  RETURN QUERY
  WITH quarantined AS (
    SELECT
      d.id,
      d.lineage_id,
      d.tenant_key,
      d.filename,
      d.source,
      d.version,
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,rule_ids}') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(d.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END AS rule_ids,
      CASE WHEN jsonb_typeof(d.metadata #> '{quarantine,snippets}') = 'array'
           THEN ARRAY(SELECT left(s.value, 80) FROM jsonb_array_elements_text(d.metadata #> '{quarantine,snippets}') AS s(value) LIMIT 3)
           ELSE '{}'::text[] END AS snippets,
      CASE WHEN (d.metadata #>> '{quarantine,quarantined_at}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
           THEN (d.metadata #>> '{quarantine,quarantined_at}')::timestamptz ELSE d.created_at END AS quarantined_at,
      CASE WHEN (d.metadata #>> '{invoice_extraction,status}') = 'quarantined' THEN 'invoice_extraction' ELSE 'injection_scan' END AS detected_by
    FROM documents d
    WHERE d.status = 'quarantined' AND d.tenant_key = ANY (keys)
  )
  SELECT q.id, q.lineage_id, q.tenant_key, q.filename, q.source, q.version, q.rule_ids, q.snippets, q.quarantined_at, q.detected_by,
         count(*) OVER () AS total_count
  FROM quarantined q
  ORDER BY q.quarantined_at DESC, q.id
  LIMIT page_size OFFSET skip;
END
$$;

-- Releases one quarantined version: the rule ids it was released for, who and when go into metadata.quarantine and processing_state, the
-- status leaves quarantined, and rag_publish_document_version runs the swap (a quarantined v2 of a lineage whose v1 is current replaces it;
-- a quarantined first version becomes current). One transaction: a failed publish leaves the document quarantined and writes no audit row.
-- An invoice quarantined by extraction stored no invoice field; its extraction record becomes released_unextracted so it no longer claims
-- quarantine, and the promoted columns stay empty.
CREATE OR REPLACE FUNCTION rag_release_quarantine(
  p_document_id uuid,
  p_actor uuid
)
RETURNS TABLE (outcome text, document_id uuid, version integer, superseded_document_id uuid, rule_ids text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  doc documents%ROWTYPE;
  ids text[];
  invoice_quarantined boolean;
  published record;
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  invoice_quarantined := (doc.metadata #>> '{invoice_extraction,status}') = 'quarantined';

  UPDATE documents d SET
    status = 'processing',
    metadata = COALESCE(d.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'quarantine',
        CASE WHEN jsonb_typeof(d.metadata -> 'quarantine') = 'object' THEN d.metadata -> 'quarantine' ELSE '{}'::jsonb END
          || jsonb_build_object(
            'released_by', p_actor::text,
            'released_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'released_rule_ids', to_jsonb(ids)))
      || CASE WHEN invoice_quarantined
              THEN jsonb_build_object('invoice_extraction', jsonb_build_object('status', 'released_unextracted'))
              ELSE '{}'::jsonb END,
    processing_state = CASE WHEN jsonb_typeof(d.processing_state -> 'quarantine') = 'object'
                            THEN jsonb_set(d.processing_state, '{quarantine,released}', 'true'::jsonb)
                            ELSE d.processing_state END
  WHERE d.id = doc.id;

  SELECT p.outcome, p.superseded_document_id INTO published FROM rag_publish_document_version(doc.id, doc.tenant_key) AS p;
  IF published.outcome IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'release_failed: %', COALESCE(published.outcome, 'unknown');
  END IF;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('release_quarantine', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT published.outcome, doc.id, doc.version, published.superseded_document_id, ids;
END
$$;

-- Deletes one quarantined version and nothing else: its chunks, its profile vectors and its backfill gaps go with it, and a clean
-- current version of the lineage stays. The keys of its stored objects (processing_state.artifacts and original_path) are returned so the
-- caller removes them from the private rag-originals bucket; the object removal cannot run in this transaction.
CREATE OR REPLACE FUNCTION rag_delete_quarantined(
  p_document_id uuid,
  p_actor uuid
)
RETURNS TABLE (document_id uuid, lineage_id uuid, tenant_key text, version integer, rule_ids text[], artifact_keys text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  keys text[];
  doc documents%ROWTYPE;
  ids text[];
  stored text[];
BEGIN
  keys := rag_admin_tenant_keys(p_actor);
  SELECT * INTO doc FROM documents d WHERE d.id = p_document_id AND d.tenant_key = ANY (keys) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF doc.status <> 'quarantined' THEN
    RAISE EXCEPTION 'not_quarantined';
  END IF;

  ids := CASE WHEN jsonb_typeof(doc.metadata #> '{quarantine,rule_ids}') = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(doc.metadata #> '{quarantine,rule_ids}')) ELSE '{}'::text[] END;
  stored := ARRAY(
    SELECT DISTINCT s.key FROM (
      SELECT e.value AS key
      FROM jsonb_each_text(CASE WHEN jsonb_typeof(doc.processing_state -> 'artifacts') = 'object' THEN doc.processing_state -> 'artifacts' ELSE '{}'::jsonb END) AS e
      UNION ALL
      SELECT doc.original_path
    ) AS s
    WHERE s.key IS NOT NULL AND s.key <> ''
  );

  UPDATE documents d SET superseded_by = NULL WHERE d.superseded_by = doc.id;
  -- The single-tenant schema has no cascade from documents to document_chunks; chunk_embeddings and gaps cascade from the chunks.
  DELETE FROM document_chunks c WHERE c.document_id = doc.id;
  DELETE FROM documents d WHERE d.id = doc.id;

  INSERT INTO rag_admin_audit (action, document_id, lineage_id, tenant_key, version, actor, rule_ids)
  VALUES ('delete_quarantined', doc.id, doc.lineage_id, doc.tenant_key, doc.version, p_actor, ids);

  RETURN QUERY SELECT doc.id, doc.lineage_id, doc.tenant_key, doc.version, ids, stored;
END
$$;

REVOKE ALL ON FUNCTION rag_admin_tenant_keys(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_list_quarantine(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_release_quarantine(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rag_delete_quarantined(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rag_admin_tenant_keys(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_list_quarantine(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION rag_release_quarantine(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION rag_delete_quarantined(uuid, uuid) TO service_role;

COMMIT;

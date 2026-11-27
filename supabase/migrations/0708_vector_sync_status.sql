-- 0708: Phase 7 vector sync status read (D-04, D-24).
-- rag_vector_sync_status returns one row per target: the enabled flag, the pending, leased and dead outbox counts and the age in
-- seconds of the oldest pending row (null when none). It returns counts only, never a tenant key, entity id or error text.
-- The CLI status command and the post-response kick's cached "is any target enabled" read both call it.
-- SECURITY INVOKER, search_path '', service role only. Idempotent: safe to run more than once.

BEGIN;

DROP FUNCTION IF EXISTS public.rag_vector_sync_status();

CREATE FUNCTION public.rag_vector_sync_status()
RETURNS TABLE (target text, enabled boolean, pending bigint, leased bigint, dead bigint, oldest_pending_seconds integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT t.target,
         t.enabled,
         (SELECT pg_catalog.count(*) FROM public.vector_sync_outbox o WHERE o.target = t.target AND o.status = 'pending'),
         (SELECT pg_catalog.count(*) FROM public.vector_sync_outbox o WHERE o.target = t.target AND o.status = 'leased'),
         (SELECT pg_catalog.count(*) FROM public.vector_sync_outbox o WHERE o.target = t.target AND o.status = 'dead'),
         (SELECT pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now() - pg_catalog.min(o.enqueued_at)))::integer
            FROM public.vector_sync_outbox o
           WHERE o.target = t.target AND o.status = 'pending')
    FROM public.rag_vector_sync_targets t
   ORDER BY t.target;
$fn$;

REVOKE ALL ON FUNCTION public.rag_vector_sync_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rag_vector_sync_status() TO service_role;

COMMIT;

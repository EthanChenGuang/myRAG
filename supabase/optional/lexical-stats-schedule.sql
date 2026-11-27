-- Optional: a pg_cron schedule that compacts the Phase 4.4 lexical statistics (LEX-03, D-17). OPT-IN, NOT A MIGRATION.
--
-- No setup script, migration runner or test path of the app applies this file. With RAG_LEXICAL_SCORING=bm25 the publish stage and
-- `npm run rag:relex` already compact the tenant they wrote, and `npm run rag:lexstats -- compact --all` does it by hand; this job only
-- folds what those callers left (a timeout, a write outside the ingest path) every five minutes. An operator who wants it runs the whole
-- file once in the Supabase SQL editor after reading it. Running it again replaces the job, so it is idempotent.
--
-- Requirements:
--   * the pg_cron extension (Supabase: Database > Extensions > pg_cron); jobs run as the role that schedules them (postgres);
--   * migrations 0900 to 0902 applied (rag_lexstats_compact_all).
-- Without either, the block below only prints a notice and changes nothing.
--
-- This file holds no secret: pg_cron calls a service-role function inside the database, so no key, URL or token is needed.
-- One job, myrag-lexical-stats-compact: one batch of at most 5000 pending rows for every enabled tenant with pending rows.

DO $lexical_stats_schedule$
BEGIN
  IF pg_catalog.to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'lexical-stats-schedule: pg_cron is not installed; nothing scheduled';
    RETURN;
  END IF;
  IF pg_catalog.to_regprocedure('public.rag_lexstats_compact_all(integer)') IS NULL THEN
    RAISE NOTICE 'lexical-stats-schedule: apply migrations 0900 to 0902 first; nothing scheduled';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'myrag-lexical-stats-compact') THEN
    PERFORM cron.unschedule('myrag-lexical-stats-compact');
  END IF;
  PERFORM cron.schedule('myrag-lexical-stats-compact', '*/5 * * * *', 'SELECT public.rag_lexstats_compact_all(5000);');
END
$lexical_stats_schedule$;

-- To inspect or remove the job:
-- SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'myrag-lexical-stats-compact';
-- SELECT cron.unschedule('myrag-lexical-stats-compact');

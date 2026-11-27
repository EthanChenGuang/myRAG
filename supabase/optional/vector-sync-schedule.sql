-- Optional: the default scheduler for Phase 7 vector sync (D-04 b, A-6). OPERATOR-RUN, NOT A MIGRATION.
--
-- No setup script, migration runner or test applies this file; the migrations loader reads supabase/migrations/ only. An operator
-- runs it once in the Supabase SQL editor after replacing the two placeholders below. It is safe to run again: the secrets are
-- updated in place and cron.schedule replaces a job of the same name.
--
-- What it installs:
--   * two Vault secrets: the app's base URL (rag_app_url) and the drain route's bearer secret (rag_vector_sync_secret);
--   * rag-vector-sync-drain: every minute, POST /api/internal/vector-sync/drain {"mode":"drain"} (one 45 s slice);
--   * rag-vector-sync-reconcile: daily at 03:17 UTC, the same call with {"mode":"reconcile"};
--   * rag-vector-sync-cleanup: weekly, deletes these jobs' cron.job_run_details rows older than 7 days (not cleaned automatically).
--
-- Requirements:
--   * the pg_cron, pg_net and supabase_vault extensions (Supabase: Database > Extensions);
--   * the app deployed with RAG_VECTOR_SYNC_SECRET set (32 characters or more) to the same value stored here;
--   * migrations 0701 to 0708 applied. With every target disabled each drain call is cheap and changes nothing.
--
-- pg_net is asynchronous; timeout_milliseconds 58000 keeps the call open past the route's 45 s slice (research Pitfall 9). The
-- secret lives only in Vault: it is never written into a job's command text, so cron.job does not show it.
--
-- Vercel Cron instead (Pro plans): it sends GET with `Authorization: Bearer $CRON_SECRET`; set CRON_SECRET to the value of
-- RAG_VECTOR_SYNC_SECRET and add the crons entry in the Vercel project, not in the committed vercel.json (A-6).

DO $setup$
DECLARE
  v_url text := '<APP_URL>';
  v_secret text := '<RAG_VECTOR_SYNC_SECRET>';
  v_id uuid;
BEGIN
  IF v_url LIKE '<%' OR v_url !~ '^https?://[^/]+' THEN
    RAISE EXCEPTION 'vector-sync-schedule: replace <APP_URL> with the app base URL, for example https://app.example.com';
  END IF;
  IF v_secret LIKE '<%' OR length(v_secret) < 32 THEN
    RAISE EXCEPTION 'vector-sync-schedule: replace <RAG_VECTOR_SYNC_SECRET> with the deployed secret (32 characters or more)';
  END IF;
  v_url := rtrim(v_url, '/');

  SELECT s.id INTO v_id FROM vault.secrets s WHERE s.name = 'rag_app_url';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(v_url, 'rag_app_url', 'myRAG app base URL for the vector sync drain route');
  ELSE
    PERFORM vault.update_secret(v_id, v_url);
  END IF;

  SELECT s.id INTO v_id FROM vault.secrets s WHERE s.name = 'rag_vector_sync_secret';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(v_secret, 'rag_vector_sync_secret', 'Bearer secret of /api/internal/vector-sync/drain');
  ELSE
    PERFORM vault.update_secret(v_id, v_secret);
  END IF;
END
$setup$;

SELECT cron.schedule(
  'rag-vector-sync-drain',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rag_app_url') || '/api/internal/vector-sync/drain',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rag_vector_sync_secret')
    ),
    body := '{"mode":"drain"}'::jsonb,
    timeout_milliseconds := 58000
  ) AS request_id;
  $job$
);

SELECT cron.schedule(
  'rag-vector-sync-reconcile',
  '17 3 * * *',
  $job$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rag_app_url') || '/api/internal/vector-sync/drain',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'rag_vector_sync_secret')
    ),
    body := '{"mode":"reconcile"}'::jsonb,
    timeout_milliseconds := 58000
  ) AS request_id;
  $job$
);

SELECT cron.schedule(
  'rag-vector-sync-cleanup',
  '41 4 * * 0',
  $job$
  DELETE FROM cron.job_run_details d
   USING cron.job j
   WHERE d.jobid = j.jobid
     AND j.jobname LIKE 'rag-vector-sync-%'
     AND d.end_time < now() - interval '7 days';
  $job$
);

-- To remove the schedule:
--
-- SELECT cron.unschedule('rag-vector-sync-drain');
-- SELECT cron.unschedule('rag-vector-sync-reconcile');
-- SELECT cron.unschedule('rag-vector-sync-cleanup');
-- DELETE FROM vault.secrets WHERE name IN ('rag_app_url', 'rag_vector_sync_secret');

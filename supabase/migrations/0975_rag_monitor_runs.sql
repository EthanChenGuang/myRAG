-- 0975: rag_monitor_runs, one row per monitor run with counts only (Phase 5.3, D-20, UI-SPEC 6.7 and 8.1).
-- Deployment-wide (a run covers every tenant), so no tenant_key (D-55 as ratified). The Config UI reads the last run and the
-- number of groups with too little data. No text column beyond the source code. runDaily deletes rows older than 400 days.
-- Access: RLS on with no policy; no grant to PUBLIC, anon or authenticated; only service_role reads and writes.
-- Idempotent, not folded (D-56).

BEGIN;

CREATE TABLE IF NOT EXISTS public.rag_monitor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  day date NOT NULL,
  source text NOT NULL,
  days_aggregated integer NOT NULL DEFAULT 0,
  groups_checked integer NOT NULL DEFAULT 0,
  groups_insufficient integer NOT NULL DEFAULT 0,
  alerts_opened integer NOT NULL DEFAULT 0,
  alerts_updated integer NOT NULL DEFAULT 0,
  deliveries integer NOT NULL DEFAULT 0,
  CONSTRAINT rag_monitor_runs_source_check CHECK (source IN ('cli', 'route', 'schedule')),
  CONSTRAINT rag_monitor_runs_counts_check CHECK (
    days_aggregated >= 0 AND groups_checked >= 0 AND groups_insufficient >= 0
    AND alerts_opened >= 0 AND alerts_updated >= 0 AND deliveries >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_rag_monitor_runs_ran_at ON public.rag_monitor_runs (ran_at DESC);

ALTER TABLE public.rag_monitor_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rag_monitor_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rag_monitor_runs TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

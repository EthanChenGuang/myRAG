# Human blockers (non-orchestrator)

Listed for Guang; other plans continue per `exec-ledger.md`.

| Item | Reason | Unblock |
|------|--------|---------|
| **03-48** live verification | No live keys/Docker on cloud VM — see `03-48-LIVE-PREFLIGHT.md` | Inject non-placeholder `.env.local` + Supabase direct URL; then run Plan tasks 1–3 |
| **03.1-04** package legitimacy | **cleared** — Guang `approved` (2026-11-24); orchestrator pinned & locked on trunk (see exec-ledger) | Executor [bc-4969184f](bc-4969184f-7107-55b3-a450-d63435dcb0a0) task 3 only |
| **03-46** profile-compare e2e | Verifier `human_needed` (5/5) | Run `run-profile-compare.mts`; confirm `pre_migration.n >= 1` (optional for close) |

**03.1-04:** do not resume [bc-4969184f](bc-4969184f-7107-55b3-a450-d63435dcb0a0) until both rows above are satisfied.
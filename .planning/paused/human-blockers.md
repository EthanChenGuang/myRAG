# Human blockers (non-orchestrator)

Listed for Guang; other plans continue per `exec-ledger.md`.

| Item | Reason | Unblock |
|------|--------|---------|
| **03-48** live verification | No automated executor (Guang live) | Complete live checks; write `03-48-SUMMARY.md` |
| **03.1-04** package legitimacy | pdfplumber / ray `[SUS]` checkpoint | After 03-48 SUMMARY, reply `approved` or `approved ray 2.60.0` |
| **03-46** profile-compare e2e | Verifier `human_needed` (5/5) | Run `run-profile-compare.mts`; confirm `pre_migration.n >= 1` (optional for close) |

**03.1-04:** do not resume [bc-4969184f](bc-4969184f-7107-55b3-a450-d63435dcb0a0) until both rows above are satisfied.
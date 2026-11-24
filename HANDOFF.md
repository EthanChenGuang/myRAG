# Handoff: exec/03.1-36 → claude/ecstatic-hamilton-86gtwv

**Plan:** 03.1-36 Config UI Ingestion panel + upload monitor + `provisional` projection

## Branch / PR

- Branch: `exec/03.1-36`
- Base: `claude/ecstatic-hamilton-86gtwv`
- Summary: `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-36-SUMMARY.md`

## What shipped

1. RAG administration **Ingestion** section (`#rag-administration-ingestion`) with jobs, tier bounds, and relocated 03.1-03 settings.
2. Shared job strings in `status-monitor.js`; upload polling via `process-documents.js` + inline `DocumentProcessor` 202 handling.
3. Admin API: `provisional: boolean` on `projectJob` (timestamp still hidden).

## MED-4 / Q4

UI-SPEC default retained: **any admin** may edit deployment-wide tier bounds, with `tiers.note` warning. Safer owner-only restriction left for PO override (ledger deferred item).

## Gates (executor)

- Vitest (plan scope): **110/110** pass
- TypeScript: **0** errors
- check-rag-boundary, check-config, check-workflows: pass
- frontend-design SUMMARY gate (isolated): pass

## Operator follow-up

- Visual UAT on Config UI (documented in SUMMARY): panel retry/delete, settings Save All Changes, upload monitor after 03.1-29 lands.
- Full-repo vitest has 5 known-unrelated failures; no action required for this PR unless CI enforces full suite.

## Blockers

None.
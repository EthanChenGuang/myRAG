---
phase: 03-unified-ingestion-embedding-profiles
plan: 47
subsystem: database
tags: [supabase, pglite, migrations, ingest, gates]
requirements-completed: [DATA-01, DATA-02, DATA-06, DATA-07, EMB-02, EMB-05, XLG-02]
status: complete
completed: 2026-11-24
---

# 03-47 — Fold Phase 3 schema, final gates, AGENTS.md

**Phase 3 closes on fresh-install parity: setup SQL carries 0301–0319, legacy defaults reproduce zero paired differences, ingest-mode gate passes, and the agents guide documents ingestion.**

## Commits (exec/03-47)

| Task | SHA | Message |
|------|-----|---------|
| 1 | `2313a77` | feat(03-47): fold Phase 3 migrations into both setup files |
| 2 | `8ef58fc` | test(03-47): record Phase 3 final gates all green (empty) |
| 3 | `1edf4a5` | docs(03-47): AGENTS.md unified ingestion and phase summary |

## Task 1 — Setup fold & schema-equality

- Appended Phase 3 migrations to `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql` (includes 0301–0319; plan baseline named 0301–0318, plus 0319 for idempotent re-apply).
- Extended `tests/rag-db/schema-equality.test.mts`: `${mode} setup applies cleanly on fresh PGlite`, equals migrated schema, unchanged by re-applying migrations; `assertRagFunctionsNotCallableByClients`.
- Fixed `tests/rag-db/schema-migrations.test.mts` incremental cases to use frozen pre-Phase-3 setup when `migrations: false`.

**Verify:** `node --import tsx --test tests/rag-db/schema-equality.test.mts tests/rag-db/schema-migrations.test.mts` → **45 pass, 0 fail**

**Acceptance:** `rag_publish_document_version` in multi-tenant setup (≥1); `match_chunks_by_profile` in single-tenant setup (≥1).

## Task 2 — Final gates (defaults)

| Command | Exit |
|---------|------|
| `npm run test-rag -- --out eval/out/p3-final` | 0 |
| `jq -e '.passed == true and .paired.all_zero == true' eval/out/p3-final/gate.json` | 0 |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/p3-final-ingest` | 0 |
| `jq -e '.passed == true' eval/out/p3-final-ingest/gate.json` | 0 |
| `npx vitest run` | 0 |
| `node --import tsx --test tests/*.test.mts tests/rag-db/*.test.mts` | 0 |
| `uv run --directory rag-sidecar --extra chunking pytest -q` | 0 |
| `uv run --directory eval pytest -q` | 0 |
| `npm run typecheck:new` | 0 |
| `npx next typegen && node scripts/ci/tsc-ratchet.mjs` | 0 |
| `node scripts/ci/check-rag-boundary.mjs` | 0 |
| `node scripts/check-config.mjs` | 0 |
| `uv run --directory eval python ../scripts/ci/check-workflows.py` | 0 |

**Prechunked paired:** `all_zero: true` (includes `category:cross_lingual` with `n_nonzero: 0` on recall@5, recall@10, mrr).

**Ingest gate:** `passed: true` (ingest fixture mode).

Full log: `eval/out/p3-47-gates.log` (local, not committed).

## Task 3 — AGENTS.md

- §6 **Unified ingestion** (stages, migrations path, switches/defaults, rag-originals, quarantine/D-08, service_role RPCs).
- §16 commands: `rag:reembed`, `rag:embedding`, `rag:backfill-hashes`, Docling `docker build --target docling` sizing note.

## Blockers

None. Plan **03-48** skipped per orchestrator.

## Deviations

- Folded **0319** alongside 0301–0318 so `migrationFiles()` re-apply is a catalog no-op (required by schema-equality idempotency test with last migration 0319).
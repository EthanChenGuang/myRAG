# 03-48 follow-up: multi-tenant-setup.sql idempotency

**Queue:** spawn when an executor slot frees (disjoint from SECURITY plan).

**Objective:** Live Task 1 hit `ERROR 42710` (trigger `track_document_storage` on `documents` already exists). Either make `supabase/multi-tenant-setup.sql` safe to re-run on an existing DB, or document **fresh-install only** in `scripts/setup-database.sh` and `supabase/README.md`.

**TDD:** Failing test first if behavior changes (e.g. script refuses re-apply with clear exit code, or idempotent `DROP TRIGGER IF EXISTS` / `CREATE OR REPLACE` pattern documented and covered).

**autonomous:** true
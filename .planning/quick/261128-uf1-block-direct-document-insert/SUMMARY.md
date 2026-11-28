# Quick 261128-uf1: block direct INSERT into documents / document_chunks (UF-1)

## Problem
Signed-in users (single-tenant: own `user_id`; multi-tenant: any organization member) could INSERT `documents` and `document_chunks` over PostgREST. `status` defaults to `ready` and `is_current` to `true` (0301, 0304) and 0320 guards only UPDATE, so such a row bypassed upload approval (`RAG_UPLOAD_APPROVAL`), the uploader hold (`RAG_UPLOADER_HOLD`) and the injection, hidden-text and link scans, and was retrievable at once.

## Write-path audit (step 2)
Every app writer of the two tables uses the service-role client:
- `src/lib/supabase.ts` `storeDocument` (`supabaseAdmin`, service key): used by upload, scrapers, Nango sync, images.
- `src/app/api/process-document/route.ts` (local `supabaseAdmin` from `SUPABASE_SERVICE_ROLE_KEY`).
- `src/app/api/ai-to-rag/route.ts` (local `supabaseAdmin` from `SUPABASE_SERVICE_ROLE_KEY`).
- Unified ingest: `rag_*` writer RPCs, service_role only, called on the admin client.
- `scripts/rag/reprocess-documents.js`: service key.
No SQL function that inserts into these tables is executable by anon or authenticated. No path writes with a user session, so both measures were applied.

## Fix
- Migration `0991_block_direct_document_insert.sql` (one file, both modes, idempotent, `SET search_path = ''`): `public.rag_guard_direct_insert()` BEFORE INSERT trigger on both tables raising 42501 unless `current_user` is `service_role`, `postgres` or `supabase_admin` (the 0320 rule); drops the INSERT policies of both modes.
- Both setup files: INSERT policies no longer created; the trigger block follows the 0320 guard.
- 0410 unchanged: the trigger function is SECURITY INVOKER (revoked from PUBLIC, anon, authenticated; granted to service_role).
- `supabase/patches/2026-11-security-review-single-tenant.sql` still recreates the single-tenant INSERT policy; left untouched (historical patch); the trigger keeps it inert.

## Tests
RED commit first (assertion failures "a row was written"), then GREEN:
- `tests/rag-db/ingest-state-guard.test.mts`: authenticated document and chunk inserts refused with 42501 (uploader, single-tenant admin, org member), anon refused, service_role and owner still insert.
- `tests/rag-db/upload-approval.test.mts`: a member cannot insert a ready document past the hold; no client can plant a ready chunk under a published document (not retrievable); service_role still writes.
- `tests/security-gaps-rls.test.mts`: the old "owner may insert own document" expectation now asserts refusal.

## Production
`prod-apply.sql` in this directory: the migration body plus checks (triggers, function grants, no INSERT/ALL policy left, RLS on, rolled-back probe). Not executed.

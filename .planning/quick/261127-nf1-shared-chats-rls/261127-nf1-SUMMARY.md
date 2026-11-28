---
quick_id: 261127-nf1
slug: shared-chats-rls
branch: fix/nf1-shared-chats-rls
source: .planning/phases/04.3-document-access-groups/04.3-SECURITY.md and 04.3-VERIFICATION.md on origin/verify/04.3 (NF-1, maps to T-04.3-151)
severity: high
migration: 0989
---

# 261127-nf1: shared chats no longer readable through client RLS (NF-1)

## Problem
The chats SELECT policies allowed `shared = true` for every role:
- single-tenant: `"Users can view their own chats"` had `OR (shared = true)`, and `"Allow public access to shared chats"` had `USING (shared = true)`;
- multi-tenant: `"Users can view chats"` had an `OR (shared = true)` branch.

Anyone holding the anon key could run `GET /rest/v1/chats?shared=eq.true&select=title,messages` and list every shared chat of every user and tenant, with no share id needed. Any signed-in user could do the same. This affected origin/main and production.

## How shared links read data (investigated first)
- `src/app/shared/[shareId]/page.tsx` (page and `generateMetadata`) and `src/app/api/chats/[shareId]/route.ts` both use `getSupabaseAdmin()` (service role) with `.eq('share_id', id).eq('shared', true)`. They select only `title, messages, created_at, updated_at` (plus `title` for the metadata).
- `src/app/api/chats/share/route.ts` (creating a share) reads the caller's own chat with the user client, filtered by `user_id`. The own-row policy covers that read.
- No other code (src, scripts, voice-agent, baileys-whatsapp) reads shared chats through the anon or user client.

**Decision: option A.** Shared reads already go through service role + share id, so `shared = true` was removed from the anon/authenticated policies. Route code is unchanged, and no new rate limiter was added: the existing route needs no new surface.

## Changes
| Commit | What |
|---|---|
| `cc1815129` | Placeholder for migration 0989, pushed at once to claim the number (all origin branches checked: 0980–0987 used, 0988 reserved elsewhere, 0989 free) |
| `10886c18e` | RED: `tests/rag-db/chats-shared-rls.test.mts` (both modes) and `tests/api/shared-chat-route.test.ts` |
| `f13f64289` | Fix: migration 0989 (common + `.single-tenant` + `.multi-tenant`), both setup files, `prod-apply.sql` |
| (this commit) | SUMMARY |

- `supabase/migrations/0989_chats_shared_rls.sql` (common): `DROP POLICY IF EXISTS "Allow public access to shared chats"`.
- `0989_chats_shared_rls.single-tenant.sql`: DROP IF EXISTS + CREATE `"Users can view their own chats"` with `USING ((SELECT auth.uid()) = user_id)`.
- `0989_chats_shared_rls.multi-tenant.sql`: DROP IF EXISTS + CREATE `"Users can view chats"` with the own personal chat and own org chat (`is_org_member`) branches only.
- `supabase/single-tenant-setup.sql` / `supabase/multi-tenant-setup.sql`: same policy shape, and each drops the public shared policy, so a fresh install is safe on day one. The setup files and setup plus migrations give equal schemas (schema-equality passes).
- The migration is idempotent; re-running it equals running it once (schema-equality checks this).

## Tests that failed before the fix
`tests/rag-db/chats-shared-rls.test.mts` on old code: 10 assertion failures (`ERR_ASSERTION`), 5 per mode:
- anon with `shared = true` read rows (expected 0);
- anon by share_id read the row (expected 0);
- an authenticated user read other users'/tenants' shared chats (same org and other org);
- a user's "own chats" list also contained another tenant's shared chat;
- a chats policy mentioned `shared`.
The service-role share_id read passed both before and after (shared links keep working).

`tests/api/shared-chat-route.test.ts` (5 tests) guards the share-link behaviour and passes before and after. The route and the page read `chats` with the admin client, `share_id` and `shared = true`, select only the render columns, and return exactly `{title, messages, createdAt, updatedAt}`. They answer 404 when no row matches and 500 without the admin client. The anon `createClient` is mocked to throw, so any fallback to a client RLS path fails the test.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: pass (0 new errors)
- `node scripts/check-config.mjs`, `node scripts/ci/check-rag-boundary.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all pass
- `node --import tsx --test tests/rag-db/chats-shared-rls.test.mts tests/rag-db/schema-equality.test.mts tests/rag-db/schema-migrations.test.mts tests/rag-db/search-path-empty.test.mts tests/rag-db/definer-search-path-pglite.test.mts`: 115/115 (both modes)
- Full `node --import tsx --test tests/rag-db/*.test.mts` (both modes; every file runs both): 4644 tests, 4625 pass, 0 fail, 0 cancelled, 19 skipped (skips are tests gated off in this environment, not touched by this change); 265 files, about 99 min locally
- vitest, chats/share related (every test file that references the chats table, shareId or the share routes, 10 files): 109/109
- Extra: `prod-apply.sql` applied twice in PGlite to origin/main's (vulnerable) setup files, no migrations: anon `shared = true` rows went 1 → 0 in both modes, 0 chats policies mention `shared`, and the second run was a no-op.

## Operator actions (owner desk)
- Apply `.planning/quick/261127-nf1-shared-chats-rls/prod-apply.sql` to production Supabase (not executed by this session). The mode is detected from the policy names, so one file serves both modes. It ends with check queries: the `pg_policies` list, 0 chats policies mentioning `shared`, RLS on, an anon count of 0 (rolled back) and the service-role shared count. Then open one existing `/shared/<share_id>` link to confirm it renders.
- Ship order does not matter: the app does not depend on the old policies.

## Deviations / notes
- Migration 0989 is three files (common + both mode files) because the policy names differ per mode.
- Not folded into any setup-file-only list. 0989 is outside `FOLDED_MIGRATION`, so it runs on top of the setup files like every 07xx–10xx migration, and the setup files carry the same final shape.
- The frozen fixtures `tests/fixtures/sql/pre-phase3-*-setup.sql` keep the old policies on purpose: they are frozen history, and the migration upgrades them.
- Out of scope: NF-4 (deleted restricted document still passes the share check), the `is_shared` org-sharing column (no policy uses it), and rate limiting the share route.

## Requirement / threat ids
NF-1 → T-04.3-151 (the PostgREST bypass part). The live `canViewShared` re-check (04.3 plan 15) is not on main and is not part of this fix.

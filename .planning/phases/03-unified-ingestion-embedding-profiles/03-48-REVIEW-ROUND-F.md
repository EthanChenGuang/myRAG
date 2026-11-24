---
phase: 03-unified-ingestion-embedding-profiles
round: F
reviewed: 2026-11-24T13:49:13Z
diff: 3b7617b..ba1057d
depth: deep
focus: security, multi-tenant isolation
files_reviewed: 13
files_reviewed_list:
  - supabase/migrations/0409_search_rpc_revoke.sql
  - supabase/migrations/0410_security_definer_rpc_grants.sql
  - supabase/multi-tenant-setup.sql (lock-down tail, lines 6250-6271)
  - supabase/single-tenant-setup.sql (lock-down tail, lines 5696-5709)
  - tests/helpers/security-definer-allow-list.ts
  - tests/helpers/sql-function-acl.ts
  - tests/rag/search-rpc-grants.test.ts
  - tests/rag-db/search-rpc-grants-pglite.test.mts
  - src/lib/rag/ingest/backfill/sources.ts
  - src/lib/rag/ingest/backfill/inventory.ts
  - src/lib/rag/tenant/backfill-scope.ts
  - tests/rag/ingest/backfill-inventory.test.ts
  - tests/rag-db/backfill-inventory.test.mts
findings:
  blocker: 0
  high: 1
  medium: 4
  low: 9
  total: 14
status: issues_found
---

# 03-48 Round F review: SECURITY DEFINER lock-down and backfill sources

## Summary

**Part 1 (grants).** I found no SECURITY DEFINER function that anon or authenticated can still run when it should not. I checked three upgrade paths:

- the folded setup on its own;
- the folded setup followed by every migration;
- the real upgrade path, `tests/fixtures/sql/pre-phase3-*-setup.sql` followed by every migration. The committed tests do not cover this path. I ran it myself with `simulateFunctionAcls` and found no violations in either mode.

I also replayed the 22 versions of both setup files in git history. Every SECURITY DEFINER signature that ever existed appears, with the exact same signature, in 0410.

The allow-list entries are justified:

- `is_org_*` keep anon because they are used in policies that have no `TO` clause.
- `check_admin_status` keeps anon for the `admin_users` and `admin_settings` policies, which also have no `TO` clause.
- `is_admin` and `kb_writes_locked` are used only in `TO authenticated` policies.
- `rag_ingest_realtime_topic_allowed` is used in a `TO authenticated` policy on `realtime.messages`.
- `delete_folder`, `move_chats_to_folder`, `share_personal_organization` and `create_organization_safe` are called with the user's session and check `auth.uid()`.

I checked every `.rpc()` call in `src/`, `scripts/`, `voice-agent/src`, `baileys-whatsapp/src` and `rag-sidecar`. Each one calls either an allow-listed function with the user's session, or a function that is service_role-only with the service-role client. In the repo SQL, no policy, view or function body calls any of the functions that are newly closed to authenticated.

Remaining problems in part 1:

- Several definer functions in the multi-tenant setup still have no `search_path` (MEDIUM-3).
- The revocations are not checked against live database objects, which may have drifted from the repo (LOW-1).
- Some gaps in robustness and tests (LOW-2, LOW-3, LOW-8, LOW-9).

**Part 2 (backfill).** The bucket source decides what it may read with a deny-list, and the list leaves out four buckets that hold every tenant's files. The listing reads with the service-role client, which ignores storage RLS, so a tenant-A backfill can copy tenant B's files (HIGH-1, checked by running it). The inventory checks for duplicates against a tenant key the caller passes in, not the tenant stored on the batch row (MEDIUM-1, checked by running it). The URL fetch checks DNS once and then lets `fetch` resolve the name again, which leaves a DNS-rebinding window (MEDIUM-2). For manifest paths, the allowed root is the directory the manifest sits in, so a manifest stored in the app directory can pull in `.env.local` (MEDIUM-4). `backfillScope` is correct in both deployment modes.

## Verification performed

| What | Result |
|---|---|
| `npx vitest run tests/rag/search-rpc-grants.test.ts tests/rag/ingest/backfill-inventory.test.ts` | 79/79 pass |
| `npx tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts` | 6/6 pass |
| `npx tsx --test tests/rag-db/backfill-inventory.test.mts` | 7/7 pass |
| Simulation of the pre-phase3 fixture plus all migrations, both modes (scratch script using `simulateFunctionAcls`) | 0 violations (108 definers multi-tenant, 94 single-tenant) |
| Replay of 22 historical setup-file versions from git, compared with 0410 | every definer signature present in 0410 |
| Scan of every SECURITY DEFINER function for `SET search_path` | 13 in `multi-tenant-setup.sql` have none (MEDIUM-3) |
| `listSource({kind:'bucket'})` on `chat-attachments`, `chat-videos`, `3d-models`, `backgrounds` | all four listed both tenants' objects (HIGH-1) |
| `inventory()` with a batch of tenant A and `tenantKey` set to tenant B | duplicate lookup sent B, skipped row written to A's batch (MEDIUM-1) |
| `isBlockedAddress` probe | `::127.0.0.1`, `::7f00:1`, `64:ff9b:1::a9fe:a9fe`, `fec0::1` return `false` (LOW-5) |
| `to_regprocedure('public.foo(nonexistent_type)')` | returns NULL on PGlite (PG 18). A PG16 cluster would not start in the sandbox, so behaviour before PG16 is **not verified** (LOW-2) |

---

## HIGH

### HIGH-1: The bucket source's deny-list leaves out four buckets that hold every tenant's files

**File:** `src/lib/rag/ingest/backfill/sources.ts:70-71`, `:281-325`

**Issue:** `INTERNAL_BUCKETS` contains only `rag-originals` and `chat-images`. Several other buckets also hold files from every tenant:

- `chat-attachments`: images extracted by `process-document`, stored as `extracted-images/<file>` with no tenant prefix (`src/app/api/process-document/route.ts:30,387`).
- `chat-videos` (`generate-video/route.ts:73`).
- `3d-models` (`generate-3d/route.ts:54`).
- `backgrounds`: created by both setup files.

`listBucket` walks the whole bucket from the root with no tenant prefix. It reads with `deps.storage`, which is the service-role client, so storage RLS does not apply. The deny-list is the only thing that stops a cross-tenant read.

**Failure scenario (reproduced):** An operator runs a backfill for tenant `o:A` with `--bucket chat-attachments` (or `chat-videos`). Every tenant's objects are listed and handed to `inventory()`, then ingested into tenant A's knowledge base. Tenant A can then retrieve tenant B's images and transcripts in chat. Running it against a fake storage client gave `chat-attachments LISTED ['tenantB-user/secret.pdf','tenantA-user/secret.pdf']`, and the same for the other three buckets.

There is no production caller yet (the CLI step of D-33 has not been built), so this is a latent defect. It still breaks the guarantee stated in the 03.1-25 summary: "A bucket source refuses buckets that hold other tenants' files".

**Fix:** Switch to an allow-list. Refuse every bucket the application owns, and require the operator to name the bucket explicitly in configuration. For example:

```ts
// in sources.ts
const APP_BUCKETS = new Set([ORIGINALS_BUCKET, PUBLIC_IMAGES_BUCKET, 'chat-attachments', 'chat-videos', '3d-models', 'backgrounds']);
if (APP_BUCKETS.has(bucket)) throw new SourceRejection('bucket_internal');
const allowed = (process.env.RAG_BACKFILL_BUCKETS ?? '').split(',').map((b) => b.trim()).filter(Boolean);
if (!allowed.includes(bucket)) throw new SourceRejection('bucket_not_allowed');
```

Also accept an optional prefix (`bucket/prefix`). In multi-tenant mode, require that prefix and bind it to the batch tenant. Add `RAG_BACKFILL_BUCKETS` to `env.ts`, `init-env.js`, `config-server.js` and the Config UI, as AGENTS.md section 4 requires. Add a test that loops over every bucket created in the setup files and asserts each one is refused.

---

## MEDIUM

### MEDIUM-1: The inventory checks duplicates against a caller-supplied tenant key, not the batch's stored tenant

**File:** `src/lib/rag/ingest/backfill/inventory.ts:10-13`, `:89-103`, `:160`, `:181`

**Issue:** `existingHashes()` sends `batch.tenantKey`, a plain string the caller passes in. `rag_enqueue_backfill_jobs` instead reads the tenant from `ingestion_batches.tenant_key` for `p_batch_id` (`0356_backfill.sql:84`). Nothing checks that the two are the same. The tenant check on line 99 only compares the returned rows with the same untrusted key, so it does not help.

**Failure scenario (reproduced):** A caller builds `BackfillBatchRef` with tenant B's key and tenant A's batch id. This can happen through a copy-paste mistake, a resumed batch, or a CLI that takes `--tenant` and `--batch` separately. Then:

1. Every file whose hash tenant B already has is written into tenant A's batch as `skipped_duplicate`. Those files are never ingested for A, so data is silently lost.
2. The totals and ledger show which of A's files exist in B's corpus. That is a cross-tenant existence oracle.
3. If the key differs only in case or whitespace, nothing matches, and duplicate detection is silently switched off.

The probe printed `[["rag_existing_file_hashes","o:2222…"],["rag_enqueue_backfill_jobs","batch-of-tenant-A"]]` with `existingDuplicates: 1`.

**Fix:** Take the tenant from the batch row inside SQL. Add `rag_existing_file_hashes_for_batch(p_batch_id uuid, p_hashes text[])`, which selects `tenant_key` from `ingestion_batches`, and remove `tenantKey` from `BackfillBatchRef`. Alternatively, have `inventory()` take the `TenantScope` minted by `backfillScope`, read the batch with `rag_batch_progress` or a small getter, and throw unless `scopeKey(scope) === batch.tenant_key`.

### MEDIUM-2: DNS-rebinding window in the manifest URL fetch

**File:** `src/lib/rag/ingest/backfill/sources.ts:128-149`, `:186-189`

**Issue:** `assertPublicUrl` resolves the host with `dns.lookup` and checks every answer. Then `fetchFn(current.toString(), …)` passes the **hostname** to undici, which calls `getaddrinfo` again when it connects. The comment on line 42 ("the same lookup a connection uses") is true of the function, but the connection does not reuse the vetted result.

**Failure scenario:** The attacker's domain uses a TTL-0 record that answers `93.184.x.x` to the check and `10.0.0.5` or `169.254.169.254` to the connect. The request then goes to the internal address. HTTPS-only plus certificate verification limits this to blind SSRF (internal port and host probing through error and timing differences), because an internal service cannot present a certificate for the attacker's name. That is why this is MEDIUM and not HIGH. If certificate checks are ever relaxed (for example `NODE_TLS_REJECT_UNAUTHORIZED=0` in a dev box or worker), it becomes full SSRF.

**Fix:** Check the address at connect time with an undici `Agent` whose `connect.lookup` validates each address it returns:

```ts
import { Agent } from 'undici';
const agent = new Agent({ connect: { lookup: (host, opts, cb) => dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
  if (err) return cb(err, []);
  const bad = (addrs as dns.LookupAddress[]).find((a) => isBlockedAddress(a.address));
  return bad ? cb(new SourceRejection('private_url'), []) : cb(null, addrs as never);
}) } });
await fetchFn(url, { redirect: 'manual', signal, dispatcher: agent } as RequestInit);
```

Add a test whose `lookupHost` stub answers public the first time and private the second time.

### MEDIUM-3: 13 SECURITY DEFINER functions in the multi-tenant setup have no `SET search_path`, and 0410 does not fix them

**File:** `supabase/multi-tenant-setup.sql`, functions at these lines:

- 1018 `get_user_org_ids`
- 1036 `get_user_role_in_org`
- 1056 `get_user_current_org`
- 1083 `can_view_org_member`
- 1108 `delete_folder`
- 1142 `get_folder_stats`
- 1163 `move_chats_to_folder`
- 1196 `share_chat`
- 1228 `unshare_chat`
- 1252 `get_admin_organization_id`
- 1383 `share_personal_organization`
- 1420 `check_admin_status`
- 1432 `is_admin`

**Issue:** Five of these remain callable through 0410: `delete_folder`, `move_chats_to_folder`, `share_personal_organization` and `is_admin` (authenticated), and `check_admin_status` (anon and authenticated). They use unqualified table names (`folders`, `chats`, `organizations`, `admin_users`). Without a fixed `search_path`, those names are looked up through the caller's `search_path`, and `pg_temp` is searched first for relations. Any role that can run SQL with its own `search_path` or temporary tables can therefore swap in its own `admin_users`, `folders` or `chats` table while running as the function owner. This is Supabase linter 0011, `function_search_path_mutable`. PostgREST callers cannot exploit it directly, which is why this is not HIGH. The single-tenant setup already sets `SET search_path = pg_catalog, public` on its versions of these functions, so the two modes have drifted. The new tests check ACLs only, not `search_path`, so nothing catches this.

**Fix:** In 0410, or in a new 0411 so 0410 stays unchanged, and in the multi-tenant setup:

```sql
DO $definer_search_path$
BEGIN
  IF to_regprocedure('public.delete_folder(uuid, boolean)') IS NOT NULL THEN
    ALTER FUNCTION public.delete_folder(uuid, boolean) SET search_path = pg_catalog, public;
  END IF;
  -- ...repeat for the other 12 signatures
END
$definer_search_path$;
```

Then extend `simulateFunctionAcls`, or add a static test, so that every `SECURITY DEFINER` without `SET search_path` fails.

### MEDIUM-4: Manifest paths are confined only to the manifest's own directory, and folder and manifest sources do not refuse sensitive files

**File:** `src/lib/rag/ingest/backfill/sources.ts:352-354`, `:376-403`, `:231-279`

**Issue:** For a manifest, the allowed root is `dirname(realpath(manifest))`. Absolute paths and any relative path without `..` are accepted as long as they resolve under that directory. No rule refuses dotfiles, `.env*`, `.git/` or key files. The same holds for folder roots.

**Failure scenario:** A customer-supplied manifest is saved in the app's working directory, or in `$HOME`, and run for tenant A. A line `{"source_key":"x","path":".env.local"}` (or `.ssh/id_ed25519`) passes every check. The file is ingested into A's knowledge base, and tenant A can read the server's secrets back through chat retrieval. This turns a misplaced file into secret exfiltration across the tenant boundary.

**Fix:** Require an explicit `--root` for manifest paths, separate from the manifest's location, and refuse absolute paths. Refuse path segments that start with `.` in both folder and manifest sources, unless the operator opts in. Add tests for `.env.local` and `.git/config`.

---

## LOW

### LOW-1: Authenticated EXECUTE is revoked without first checking the live database for dependents

**File:** `supabase/migrations/0410_security_definer_rpc_grants.sql:19-54`, `:35-37`, `:395-402`

**Issue:** 0410 closes `can_view_org_member`, `get_user_role_in_org`, `get_user_current_org`, `get_folder_stats`, `share_chat` and `unshare_chat` to authenticated. Databases built from the folded setup previously granted these to authenticated. In the repo SQL I found no policy, view or function body that calls them, and no app `.rpc()` call. However, the git history starts at an imported squash ("ChatRAG Open Source v1"). `can_view_org_member` is shaped like an RLS helper (STABLE, SECURITY DEFINER, boolean, takes a member and org id), and `2026-11-security-review-multi-tenant.sql:308-340` rewrote the `organization_members` policies. A live database that skipped that patch, or that has a hand-written policy using the helper, would raise 42501 on every authenticated read through that policy. That includes subqueries on `organization_members` inside other policies.

**Fix:** Before the revokes in 0410, add a guard that raises with a clear message if any `pg_policies.qual` or `with_check`, `pg_views.definition`, or `prosrc` of a non-definer function references one of these names. Or document a pre-flight query in `supabase/README.md`.

### LOW-2: "Safe on any partial upgrade state" holds only when migrations run in order

**File:** `supabase/migrations/0410_security_definer_rpc_grants.sql:12`, `:55`, `:191`

**Issue:** Some guards name argument types that come from later migrations or newer extensions: `ingestion_jobs` (0351) and `halfvec` (pgvector 0.7 or later, 0307 and 0308). Before PG16, `to_regprocedure` raises an error for an unknown argument type instead of returning NULL. Applied in order this is harmless, because 0351 and 0307 run first. Applied on its own as a hot-fix to an older database, the whole transaction would abort on PG15. This was **not verified**: only PG18 (PGlite) was available, and it returns NULL.

**Fix:** Guard on `to_regtype('public.ingestion_jobs') IS NOT NULL AND to_regprocedure(...)`, and do the same for `halfvec`. Otherwise, drop the "any partial upgrade state" claim from the header comment.

### LOW-3: The allow-list is keyed by function name, not by signature

**File:** `tests/helpers/security-definer-allow-list.ts:7`, `tests/rag/search-rpc-grants.test.ts:98`, `tests/rag-db/search-rpc-grants-pglite.test.mts:126`

**Issue:** `AUTHENTICATED_ALLOW_LIST[acl.name]` / `[row.proname]` approves every overload with that name. A future `delete_folder(uuid)` or `is_org_member(uuid)` SECURITY DEFINER overload with no `auth.uid()` check would be accepted as authenticated- or anon-callable, and the test would stay green.

**Fix:** Key entries by normalised signature, for example `'delete_folder(uuid,boolean)'`, and compare against `signatureKey` or `regprocedure::text`.

### LOW-4: The static test does not model the real upgrade baseline

**File:** `tests/rag/search-rpc-grants.test.ts:80-90`

**Issue:** The "migrations only" scenario never sees functions that were created before Phase 3. As a result, a missing 0410 entry for a pre-Phase-3 definer would only be caught by the PGlite test, which uses the **current** setup as its baseline. I ran the pre-phase3 fixture plus migrations myself and it was clean, but the repo has no test for it.

**Fix:** Add the scenario `files: ['tests/fixtures/sql/pre-phase3-<mode>-setup.sql', ...migrations]` to `scenarios()`.

### LOW-5: Gaps in the IPv6 blocklist

**File:** `src/lib/rag/ingest/backfill/sources.ts:86-96`

**Issue:** These ranges are missing (each one was checked by running `isBlockedAddress`):

- `::/96`, the IPv4-compatible form: `::127.0.0.1` and `::7f00:1` return false.
- `64:ff9b:1::/48`, the RFC 8215 local-use NAT64 range: `64:ff9b:1::a9fe:a9fe` returns false.
- `fec0::/10`, deprecated site-local addresses.

On NAT64 networks, `64:ff9b:1::/48` maps to private IPv4. Normal Linux hosts do not route the first and third.

**Fix:** Add `['::', 96]`, `['64:ff9b:1::', 48]` and `['fec0::', 10]`, and unwrap `::a.b.c.d` the same way `::ffff:` is unwrapped.

### LOW-6: One filesystem error aborts the whole folder listing

**File:** `src/lib/rag/ingest/backfill/sources.ts:238`, `:242`, `:259`

**Issue:** `readdir`, `lstat` and `stat(canonical)` are not wrapped. If a file is deleted between `readdir` and `lstat` (ENOENT), or a subdirectory cannot be read (EACCES), the generator throws and `inventory()` rejects the whole batch. That contradicts the summary's statement that "unreadable files do not abort an inventory".

**Fix:** Wrap each call, `reject('path_unreadable')`, and continue.

### LOW-7: The size limit is checked only at listing time, never at `open()`

**File:** `src/lib/rag/ingest/backfill/sources.ts:270-274`, `:306-319`

**Issue:** A folder file can grow after `stat`. For a bucket object with no `metadata.size`, size defaults to 0, so the check is skipped, and `download()` then loads the entire blob into memory. For example, `chat-videos` allows 50 MiB, against the 20 MiB limit.

**Fix:** Enforce `ORIGINALS_MAX_BYTES` inside `open()`: use `createReadStream` with an `end` bound or a counting transform, and check `blob.size` before `arrayBuffer()`. Refuse bucket rows that have no size.

### LOW-8: Hashes are taken at inventory time, but ingest reads the bytes again later

**File:** `src/lib/rag/ingest/backfill/inventory.ts:145`, `:170-178`; `sources.ts:418-435`

**Issue:** `InventoryEntry` carries `fileSha256` but not the bytes. The ingest step has to read the file again or fetch the URL again, and the content can change in between. The ledger's `file_sha256` can then describe content that was never ingested, which weakens duplicate detection and audit.

**Fix:** At ingest, recompute the hash and fail the job with a `hash_changed` reason if it differs from the ledger.

### LOW-9: Helpers now limited to service_role cannot be used at all, and some allow-list reasons are incomplete

**File:** `0410_security_definer_rpc_grants.sql:19-54`, `:395-402`; `security-definer-allow-list.ts:15-16`

**Issue:** `get_folder_stats`, `share_chat`, `unshare_chat`, `get_user_role_in_org`, `get_user_current_org` and `can_view_org_member` all depend on `auth.uid()`. For the service role, `auth.uid()` is NULL, so after 0410 these functions always return nothing or raise "Not authorized". They are dead code and should be dropped rather than kept.

Two allow-list reasons are also incomplete:

- `is_admin(uuid)` accepts any UUID, so any authenticated user can check whether a given user is an admin. This is pre-existing and is not mentioned in the reason.
- `check_admin_status` keeps anon only because the `admin_users` and `admin_settings` policies have no `TO` clause. Adding `TO authenticated` to those policies would let anon be revoked.

**Fix:** Drop the dead helpers in a later migration. Bind `is_admin` with `user_uuid = auth.uid() OR auth.role() = 'service_role'`, after checking the single-tenant policies, which only pass `auth.uid()`. Add `TO authenticated` to the admin policies.

---

## Not issues (checked)

- `backfillScope`: the key is lower-cased once, `s:default` is accepted only in single-tenant mode, `u:` and `o:` only in multi-tenant mode, users and orgs must exist (checked with the admin client), and a failed lookup refuses instead of minting a scope.
- URL redirects: `redirect: 'manual'`, every hop checked, `http:` refused, userinfo refused, at most 5 hops, the body capped at 20 MiB after decompression, and a 30 s limit per hop.
- Folder symlinks: links that point outside the root are refused, links to directories are never followed (no loops), and `open()` checks `realpath` again.
- `rag_enqueue_backfill_jobs` takes the tenant from the batch row, and `rag_existing_file_hashes` filters on `tenant_key`. Both are service_role only.
- Trigger functions that are now service_role-only (`rag_chunk_embeddings_guard`, `rag_chunks_legacy_defaults`) still fire for authenticated writes, because EXECUTE on a trigger function is checked only at CREATE TRIGGER.
- `rag_ingest_broadcast_job` is called only from SECURITY DEFINER callers that run as the owner.

_Reviewer: Claude (gsd-code-reviewer), read-only; no source files modified._

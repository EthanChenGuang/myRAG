import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0961_rag_eval_run_requests.sql';
const ORG_B = '00000000-0000-4000-8000-0000000009b1';

type Role = 'anon' | 'authenticated' | 'service_role';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function enqueue(db: PGlite, tenantKey: string | null, reason: string, refId: string | null): Promise<boolean> {
  const result = await db.query<{ queued: boolean }>('SELECT public.rag_eval_run_request_enqueue($1, $2, $3) AS queued', [tenantKey, reason, refId]);
  return result.rows[0]!.queued;
}

for (const mode of MODES) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const otherTenant = `o:${ORG_B}`;
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`rag_eval_run_requests (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
    });

    after(async () => {
      await db?.close();
    });

    test('RLS is on with no policy', async () => {
      const rls = await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_eval_run_requests'::regclass");
      assert.equal(rls.rows[0]?.relrowsecurity, true);
      const policies = await db.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rag_eval_run_requests'");
      assert.equal(policies.rows.length, 0);
    });

    test('enqueue returns true the first time and false the second, with one pending row', async () => {
      assert.equal(await asRole(db, 'service_role', () => enqueue(db, tenant, 'backfill_completed', 'batch-1')), true);
      assert.equal(await asRole(db, 'service_role', () => enqueue(db, tenant, 'backfill_completed', 'batch-1')), false);
      const rows = await asRole(db, 'service_role', () =>
        db.query<{ status: string; tenant_key: string }>(
          "SELECT status, tenant_key FROM public.rag_eval_run_requests WHERE reason = 'backfill_completed' AND ref_id = 'batch-1'",
        ),
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0]?.status, 'pending');
      assert.equal(rows.rows[0]?.tenant_key, tenant);
    });

    test('a different reason or ref_id is a new request', async () => {
      assert.equal(await asRole(db, 'service_role', () => enqueue(db, tenant, 'reembed_completed', 'batch-1')), true);
      assert.equal(await asRole(db, 'service_role', () => enqueue(db, tenant, 'backfill_completed', 'batch-2')), true);
      assert.equal(await asRole(db, 'service_role', () => enqueue(db, tenant, 'manual', 'run-1')), true);
    });

    if (mode === 'multi-tenant') {
      test('the same reason and ref_id for another tenant is its own request', async () => {
        assert.equal(await asRole(db, 'service_role', () => enqueue(db, otherTenant, 'backfill_completed', 'batch-1')), true);
        const rows = await asRole(db, 'service_role', () =>
          db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_eval_run_requests WHERE tenant_key = $1", [tenant]),
        );
        assert.equal(rows.rows[0]?.n, 4);
      });
    }

    test('an unknown reason is rejected', async () => {
      await assert.rejects(
        () => asRole(db, 'service_role', () => enqueue(db, tenant, 'nightly', 'x')),
        (error: unknown) => sqlState(error) === '23514' || sqlState(error) === '22023',
      );
    });

    test('an empty or over-long ref_id is rejected', async () => {
      for (const ref of ['', 'r'.repeat(201)]) {
        await assert.rejects(
          () => asRole(db, 'service_role', () => enqueue(db, tenant, 'manual', ref)),
          (error: unknown) => sqlState(error) === '23514' || sqlState(error) === '22023',
        );
      }
    });

    test('status outside its list is rejected by a CHECK', async () => {
      await assert.rejects(
        () => asRole(db, 'service_role', () => db.query("UPDATE public.rag_eval_run_requests SET status = 'queued'")),
        (error: unknown) => sqlState(error) === '23514',
      );
      await asRole(db, 'service_role', () =>
        db.query(
          `UPDATE public.rag_eval_run_requests SET status = 'skipped', skip_reason = 'no_real_set', result_summary = '{"items":0}'::jsonb
           WHERE reason = 'manual'`,
        ),
      );
    });

    test('a malformed tenant key is rejected by the table CHECK', async () => {
      await assert.rejects(
        () =>
          asRole(db, 'service_role', () =>
            db.query("INSERT INTO public.rag_eval_run_requests (tenant_key, reason, ref_id) VALUES ('x:1', 'manual', 'direct')"),
          ),
        (error: unknown) => sqlState(error) === '23514',
      );
    });

    for (const [label, key] of [
      ['NULL', null],
      ['x:1', 'x:1'],
      ['an upper-case uuid', `u:${FIXTURE_USER_ID.toUpperCase()}`],
      ['the other mode key', wrongModeKey],
    ] as const) {
      test(`${label} key raises 22023`, async () => {
        await assert.rejects(
          () => asRole(db, 'service_role', () => enqueue(db, key, 'manual', 'guarded')),
          (error: unknown) => sqlState(error) === '22023',
        );
      });
    }

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on the table and the function`, async () => {
        const refused = (run: () => Promise<unknown>) => assert.rejects(() => asRole(db, role, run), (error: unknown) => sqlState(error) === '42501');
        await refused(() => enqueue(db, tenant, 'manual', 'denied'));
        await refused(() => db.query('SELECT id FROM public.rag_eval_run_requests'));
        await refused(() => db.query("INSERT INTO public.rag_eval_run_requests (tenant_key, reason, ref_id) VALUES ($1, 'manual', 'denied')", [tenant]));
        await refused(() => db.query("UPDATE public.rag_eval_run_requests SET status = 'done'"));
        await refused(() => db.query('DELETE FROM public.rag_eval_run_requests'));
      });
    }

    test('the function is SECURITY INVOKER with an empty search_path, executable by service_role only', async () => {
      const proc = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.rag_eval_run_request_enqueue(text, text, text)'::regprocedure",
      );
      assert.equal(proc.rows[0]?.prosecdef, false);
      assert.ok((proc.rows[0]?.proconfig ?? []).some((entry) => entry === 'search_path=""' || entry === 'search_path='));
      const grants = await db.query<{ role: string; allowed: boolean }>(
        `SELECT r AS role, has_function_privilege(r, 'public.rag_eval_run_request_enqueue(text, text, text)', 'EXECUTE') AS allowed
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
      );
      assert.deepEqual(Object.fromEntries(grants.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true });
      const publicGrant = await db.query(
        `SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE p.oid = 'public.rag_eval_run_request_enqueue(text, text, text)'::regprocedure AND a.grantee = 0`,
      );
      assert.equal(publicGrant.rows.length, 0);
    });

    test('applying the file a second time raises no error and keeps the rows', async () => {
      const before = await asRole(db, 'service_role', () => db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_eval_run_requests'));
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      const afterCount = await asRole(db, 'service_role', () => db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_eval_run_requests'));
      assert.equal(afterCount.rows[0]?.n, before.rows[0]?.n);
      assert.equal(await asRole(db, 'service_role', () => enqueue(db, tenant, 'backfill_completed', 'batch-1')), false);
    });
  });
}

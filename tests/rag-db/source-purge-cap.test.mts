import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants';

type Row = Record<string, unknown>;

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const USER_A = '00000000-0000-4000-8000-0000000007a1';
const USER_B = '00000000-0000-4000-8000-0000000007b1';

const SIGNATURES = [
  'public.rag_source_purge_reserve(text, uuid, integer, integer)',
  'public.rag_source_purge_release(text, uuid, integer)',
  'public.rag_source_purge_hold(text, uuid, text[], integer)',
];

const reserveSql = 'SELECT public.rag_source_purge_reserve(p_tenant_key => $1, p_connection_id => $2, p_requested => $3, p_cap => $4) AS n';
const releaseSql = 'SELECT public.rag_source_purge_release(p_tenant_key => $1, p_connection_id => $2, p_count => $3) AS n';
const holdSql = 'SELECT public.rag_source_purge_hold(p_tenant_key => $1, p_connection_id => $2, p_file_ids => $3::text[], p_cap => $4) AS id';
const recordSql =
  'SELECT * FROM public.rag_source_reconcile_run_record(p_tenant_key => $1, p_connection_id => $2, p_origin => $3, p_status => $4, p_counts => $5::jsonb, p_candidate_file_ids => $6::text[])';

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code: string; message: string } | undefined> {
  try {
    await db.query(sql, params);
    return undefined;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? 'unknown', message: e.message ?? '' };
  }
}

for (const mode of MODES) {
  describe(`source purge daily cap (${mode})`, () => {
    let db: PGlite;
    const keyOf = (user: string) => (mode === 'multi-tenant' ? `u:${user}` : 's:default');
    const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query<Row>(sql, params)).rows;
    const connection = async (owner: string): Promise<string> => {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO public.nango_connections (id, user_id, connection_id, provider, status, connected_at) VALUES ($1, $2, $3, $4, 'connected', now())", [
        id,
        owner,
        `conn-${id}`,
        `provider-${id.slice(0, 8)}`,
      ]);
      return id;
    };
    const reserve = async (c: string, requested: number, cap: number, owner = USER_A): Promise<number> =>
      Number((await rows(reserveSql, [keyOf(owner), c, requested, cap]))[0]!.n);
    const used = async (c: string): Promise<number | undefined> => {
      const r = await rows("SELECT purged_count FROM public.rag_source_purge_daily_usage WHERE connection_id = $1 AND usage_day = (now() AT TIME ZONE 'utc')::date", [c]);
      return r.length ? Number(r[0]!.purged_count) : undefined;
    };
    const hold = async (c: string, ids: string[], cap = 3): Promise<string> => String((await rows(holdSql, [keyOf(USER_A), c, ids, cap]))[0]!.id);
    const run = async (id: string): Promise<Row> => (await rows('SELECT * FROM public.rag_source_reconcile_runs WHERE id = $1', [id]))[0]!;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [USER_A, 'cap-a@example.invalid', USER_B, 'cap-b@example.invalid']);
    });

    after(async () => {
      await db?.close();
    });

    test('reserve grants up to the cap per UTC day, then nothing, and again on a new day', async () => {
      const c = await connection(USER_A);
      assert.equal(await reserve(c, 5, 3), 3);
      assert.equal(await reserve(c, 5, 3), 0);
      assert.equal(await used(c), 3);
      await db.query('UPDATE public.rag_source_purge_daily_usage SET usage_day = usage_day - 1 WHERE connection_id = $1', [c]);
      assert.equal(await reserve(c, 5, 3), 3);
      assert.equal(await reserve(c, 0, 3), 0, 'a zero request is allowed and grants nothing');
    });

    test('reserve deletes counter rows older than 30 days', async () => {
      const c = await connection(USER_A);
      await db.query(
        "INSERT INTO public.rag_source_purge_daily_usage (connection_id, usage_day, tenant_key, purged_count) VALUES ($1, (now() AT TIME ZONE 'utc')::date - 31, $2, 4), ($1, (now() AT TIME ZONE 'utc')::date - 30, $2, 4)",
        [c, keyOf(USER_A)],
      );
      await reserve(c, 1, 3);
      const days = await rows(
        "SELECT ((now() AT TIME ZONE 'utc')::date - usage_day) AS age FROM public.rag_source_purge_daily_usage WHERE connection_id = $1 ORDER BY usage_day",
        [c],
      );
      assert.deepEqual(days.map((d) => Number(d.age)), [30, 0]);
    });

    test('release lowers the count and never below 0', async () => {
      const c = await connection(USER_A);
      await reserve(c, 3, 3);
      assert.equal(Number((await rows(releaseSql, [keyOf(USER_A), c, 2]))[0]!.n), 1);
      assert.equal(await used(c), 1);
      assert.equal(Number((await rows(releaseSql, [keyOf(USER_A), c, 5]))[0]!.n), 0);
      assert.equal(await used(c), 0);
      assert.equal(await reserve(c, 5, 3), 3, 'released allowance can be reserved again');
      const fresh = await connection(USER_A);
      assert.equal(Number((await rows(releaseSql, [keyOf(USER_A), fresh, 1]))[0]!.n), 0, 'no row: nothing to release');
    });

    test('two concurrent reservations cannot exceed the cap together', async () => {
      const c = await connection(USER_A);
      const granted = await Promise.all([reserve(c, 2, 3), reserve(c, 2, 3)]);
      assert.equal(granted[0]! + granted[1]!, 3);
      assert.equal(await used(c), 3);
    });

    test('a foreign tenant key, an unknown connection and invalid arguments are refused', async () => {
      const c = await connection(USER_A);
      const foreign = mode === 'multi-tenant' ? keyOf(USER_B) : `u:${USER_B}`;
      for (const [sql, params] of [
        [reserveSql, [foreign, c, 1, 3]],
        [releaseSql, [foreign, c, 1]],
        [holdSql, [foreign, c, ['file-x'], 3]],
      ] as const) {
        const err = await failure(db, sql, [...params]);
        assert.ok(err, `${sql} with a foreign key fails`);
        assert.match(err.message, /tenant_mismatch|tenant/);
      }
      if (mode === 'multi-tenant') {
        const err = await failure(db, reserveSql, [keyOf(USER_B), c, 1, 3]);
        assert.match(err?.message ?? '', /tenant_mismatch/);
      }
      assert.match((await failure(db, reserveSql, [keyOf(USER_A), crypto.randomUUID(), 1, 3]))?.message ?? '', /not_found/);
      for (const params of [
        [keyOf(USER_A), c, -1, 3],
        [keyOf(USER_A), c, 1, 0],
      ]) {
        const err = await failure(db, reserveSql, params);
        assert.equal(err?.code, '22023');
        assert.match(err?.message ?? '', /invalid_argument/);
      }
      assert.equal((await failure(db, releaseSql, [keyOf(USER_A), c, -1]))?.code, '22023');
      assert.equal((await failure(db, holdSql, [keyOf(USER_A), c, [], 3]))?.code, '22023');
      assert.equal((await failure(db, holdSql, [keyOf(USER_A), c, ['file-x'], 0]))?.code, '22023');
      assert.equal((await failure(db, holdSql, [keyOf(USER_A), c, [''], 3]))?.code, '22023');
      assert.equal(await used(c), undefined, 'refused calls write no counter row');
    });

    test('hold creates one awaiting change_feed run with the cap reason, then appends without duplicates', async () => {
      const c = await connection(USER_A);
      const first = await hold(c, ['file-1', 'file-2', 'file-1']);
      const r1 = await run(first);
      assert.equal(r1.origin, 'change_feed');
      assert.equal(r1.status, 'awaiting_confirmation');
      assert.equal(r1.pause_reason, 'purge_daily_cap');
      assert.equal(r1.daily_cap, 3);
      assert.equal(r1.tenant_key, keyOf(USER_A));
      assert.deepEqual(r1.candidate_file_ids, ['file-1', 'file-2']);
      assert.equal(r1.candidate_count, 2);
      const hours = ((r1.expires_at as Date).getTime() - (r1.created_at as Date).getTime()) / 3_600_000;
      assert.equal(hours, 24);
      const conn = (await rows('SELECT last_reconcile_status FROM public.nango_connections WHERE id = $1', [c]))[0]!;
      assert.equal(conn.last_reconcile_status, 'paused');

      const second = await hold(c, ['file-2', 'file-3']);
      assert.equal(second, first, 'the same run of the day');
      const r2 = await run(first);
      assert.deepEqual(r2.candidate_file_ids, ['file-1', 'file-2', 'file-3']);
      assert.equal(r2.candidate_count, 3);
      const count = await rows("SELECT count(*)::int AS n FROM public.rag_source_reconcile_runs WHERE connection_id = $1", [c]);
      assert.equal(count[0]!.n, 1);
    });

    test('an expired or decided cap run is not reused; share runs keep pause_reason NULL', async () => {
      const c = await connection(USER_A);
      const first = await hold(c, ['file-1']);
      await db.query("UPDATE public.rag_source_reconcile_runs SET expires_at = now() - interval '1 minute' WHERE id = $1", [first]);
      const second = await hold(c, ['file-2']);
      assert.notEqual(second, first);
      assert.equal((await run(first)).status, 'expired');
      await db.query("UPDATE public.rag_source_reconcile_runs SET status = 'dismissed' WHERE id = $1", [second]);
      const third = await hold(c, ['file-3']);
      assert.notEqual(third, second);
      assert.deepEqual((await run(third)).candidate_file_ids, ['file-3']);

      const shareRun = await rows(recordSql, [keyOf(USER_A), c, 'scheduled', 'awaiting_confirmation', JSON.stringify({ total: 10, candidates: 6 }), ['s1', 's2']]);
      assert.equal((await run(String(shareRun[0]!.run_id))).pause_reason, null);
      const fourth = await hold(c, ['file-4']);
      assert.equal(fourth, third, 'a share pause of the same connection is never the cap run');
    });

    test('ids past the 2,000-id limit are not stored and candidate_count keeps the true total', async () => {
      const c = await connection(USER_A);
      const ids = Array.from({ length: 1990 }, (_, i) => `f-${i}`);
      const id = await hold(c, ids);
      await hold(c, Array.from({ length: 30 }, (_, i) => `g-${i}`));
      const r = await run(id);
      assert.equal((r.candidate_file_ids as string[]).length, 2000);
      assert.equal(r.candidate_count, 2020);
    });

    test('the counter table and the three functions are service-role only', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          assert.ok(await failure(db, 'SELECT * FROM public.rag_source_purge_daily_usage'), `${role} cannot read the counter`);
          assert.ok(await failure(db, reserveSql, [keyOf(USER_A), crypto.randomUUID(), 1, 3]), `${role} cannot reserve`);
          assert.ok(await failure(db, releaseSql, [keyOf(USER_A), crypto.randomUUID(), 1]), `${role} cannot release`);
          assert.ok(await failure(db, holdSql, [keyOf(USER_A), crypto.randomUUID(), ['f'], 3]), `${role} cannot hold`);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      for (const signature of SIGNATURES) {
        const r = await rows(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
             FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
          [signature],
        );
        assert.equal(r.length, 1, `${signature} exists`);
        assert.equal(r[0]!.definer, true);
        assert.ok((r[0]!.config as string[]).some((entry) => entry === 'search_path=""'), `${signature} search_path`);
        assert.equal(r[0]!.service, true);
        assert.equal(r[0]!.anon, false);
        assert.equal(r[0]!.auth, false);
      }
      const rls = await rows("SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.rag_source_purge_daily_usage'::regclass");
      assert.equal(rls[0]!.on, true);
      const overloads = await rows(
        "SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'rag\\_source\\_purge\\_%' GROUP BY proname HAVING count(*) > 1",
      );
      assert.deepEqual(overloads, []);
      await assertNoClientCallableRagFunctions(db);
    });
  });
}

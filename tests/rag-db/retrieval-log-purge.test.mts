import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { allowListEntryFor } from '../helpers/security-definer-allow-list';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function insertAged(db: PGlite, userId: string, ageDays: number): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status, created_at)
     VALUES ($1, $2, 'chat', 'legacy', 'ok', now() - make_interval(days => $3::int)) RETURNING id`,
    [crypto.randomUUID(), userId, ageDays],
  );
  return result.rows[0]?.id as string;
}

async function remainingIds(db: PGlite): Promise<string[]> {
  return (await db.query<{ id: string }>('SELECT id FROM rag_retrieval_log ORDER BY created_at')).rows.map((row) => row.id);
}

for (const mode of MODES) {
  describe(`rag_purge_retrieval_log (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let userId: string;
    let aged: { fresh: string; month: string; year: string };

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      userId = crypto.randomUUID();
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, `user-${userId.slice(0, 8)}@example.invalid`]);
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec('DELETE FROM rag_retrieval_log');
      aged = { fresh: await insertAged(db, userId, 10), month: await insertAged(db, userId, 40), year: await insertAged(db, userId, 400) };
    });

    test('deletes every row older than the retention window and returns the count', async () => {
      const deleted = (await db.query<{ n: number }>('SELECT public.rag_purge_retrieval_log(30, 1000) AS n')).rows[0]?.n;
      assert.equal(deleted, 2);
      assert.deepEqual(await remainingIds(db), [aged.fresh]);
    });

    test('deletes at most one batch, oldest first', async () => {
      const deleted = (await db.query<{ n: number }>('SELECT public.rag_purge_retrieval_log(30, 1) AS n')).rows[0]?.n;
      assert.equal(deleted, 1);
      assert.deepEqual(await remainingIds(db), [aged.month, aged.fresh]);
      const none = (await db.query<{ n: number }>('SELECT public.rag_purge_retrieval_log(500, 10) AS n')).rows[0]?.n;
      assert.equal(none, 0);
    });

    test('refuses a retention below one day and a batch outside 1..10000', async () => {
      for (const [days, batch] of [[0, 10], [30, 0], [30, 10001], [-5, 10]]) {
        await assert.rejects(
          () => db.query('SELECT public.rag_purge_retrieval_log($1, $2)', [days, batch]),
          (error: unknown) => sqlState(error) === '22023',
        );
      }
      await assert.rejects(() => db.query('SELECT public.rag_purge_retrieval_log(NULL, 10)'), (error: unknown) => sqlState(error) === '22023');
      assert.equal((await remainingIds(db)).length, 3);
    });

    test('anon is refused through the fake edge; the service role purges', async () => {
      const call = (apikey: string) =>
        fetch(`${edge.url}/rest/v1/rpc/rag_purge_retrieval_log`, {
          method: 'POST',
          headers: { apikey, authorization: `Bearer ${apikey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_retention_days: 30, p_batch_size: 1000 }),
        });
      const anon = await call(ANON_KEY);
      assert.notEqual(anon.status, 200);
      assert.match(await anon.text(), /42501|permission denied/i);
      assert.equal((await remainingIds(db)).length, 3);

      const service = await call(SERVICE_KEY);
      assert.equal(service.status, 200, await service.clone().text());
      assert.deepEqual(await remainingIds(db), [aged.fresh]);
    });

    test('authenticated cannot execute it; only service_role holds EXECUTE', async () => {
      await db.exec('SET ROLE authenticated');
      try {
        await assert.rejects(() => db.query('SELECT public.rag_purge_retrieval_log(30, 10)'), (error: unknown) => sqlState(error) === '42501');
      } finally {
        await db.exec('RESET ROLE');
      }
      const row = (
        await db.query<Record<string, unknown>>(
          `SELECT p.prosecdef AS definer, p.proconfig AS config,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
                  (SELECT coalesce(bool_or(acl.grantee = 0), false) FROM aclexplode(p.proacl) acl) AS public_exec
           FROM pg_proc p WHERE p.oid = 'public.rag_purge_retrieval_log(integer, integer)'::regprocedure`,
        )
      ).rows[0];
      assert.deepEqual(row, { definer: true, config: ['search_path=""'], anon_exec: false, auth_exec: false, service_exec: true, public_exec: false });
      assert.equal(allowListEntryFor('rag_purge_retrieval_log(integer,integer)'), undefined);
      assert.equal(allowListEntryFor('rag_feedback_loop_on_chat_delete()'), undefined);
    });
  });
}

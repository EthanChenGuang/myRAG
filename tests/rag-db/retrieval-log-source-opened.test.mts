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

function traceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

async function insertRow(db: PGlite, trace: string, userId: string, count = 0): Promise<void> {
  await db.query(
    `INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status, outcome, source_opened_count)
     VALUES ($1, $2, 'chat', 'legacy', 'ok', 'answered', $3)`,
    [trace, userId, count],
  );
}

async function countOf(db: PGlite, trace: string): Promise<number> {
  return (await db.query<{ n: number }>('SELECT source_opened_count AS n FROM rag_retrieval_log WHERE trace_id = $1', [trace])).rows[0]?.n as number;
}

async function call(db: PGlite, trace: string | null, userId: string | null): Promise<number | null> {
  return (await db.query<{ n: number | null }>('SELECT public.rag_record_source_opened($1, $2::uuid) AS n', [trace, userId])).rows[0]?.n ?? null;
}

for (const mode of MODES) {
  describe(`rag_record_source_opened (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let owner: string;
    let other: string;
    let own: string;
    let foreign: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      owner = crypto.randomUUID();
      other = crypto.randomUUID();
      for (const id of [owner, other]) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
      }
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec('DELETE FROM rag_retrieval_log');
      own = traceId();
      foreign = traceId();
      await insertRow(db, own, owner);
      await insertRow(db, foreign, other);
    });

    test('increments the owner row by one per call and returns the new count', async () => {
      assert.equal(await call(db, own, owner), 1);
      assert.equal(await call(db, own, owner), 2);
      assert.equal(await countOf(db, own), 2);
    });

    test('stops at 20 and still returns the count for the owner', async () => {
      for (let i = 0; i < 25; i += 1) await call(db, own, owner);
      assert.equal(await countOf(db, own), 20);
      assert.equal(await call(db, own, owner), 20);
    });

    test('returns NULL and changes nothing for another user, an unknown trace or invalid input', async () => {
      assert.equal(await call(db, foreign, owner), null);
      assert.equal(await call(db, traceId(), owner), null);
      assert.equal(await call(db, own.toUpperCase(), owner), null);
      assert.equal(await call(db, null, owner), null);
      assert.equal(await call(db, own, null), null);
      assert.equal(await countOf(db, foreign), 0);
      assert.equal(await countOf(db, own), 0);
    });

    test('anon is refused through the fake edge; the service role increments', async () => {
      const post = (apikey: string) =>
        fetch(`${edge.url}/rest/v1/rpc/rag_record_source_opened`, {
          method: 'POST',
          headers: { apikey, authorization: `Bearer ${apikey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_trace_id: own, p_user_id: owner }),
        });
      const anon = await post(ANON_KEY);
      assert.notEqual(anon.status, 200);
      assert.match(await anon.text(), /42501|permission denied/i);
      assert.equal(await countOf(db, own), 0);

      const service = await post(SERVICE_KEY);
      assert.equal(service.status, 200, await service.clone().text());
      assert.equal(await countOf(db, own), 1);
    });

    test('is an invoker function with an empty search_path; only service_role holds EXECUTE', async () => {
      await db.exec('SET ROLE authenticated');
      try {
        await assert.rejects(() => call(db, own, owner), (error: unknown) => sqlState(error) === '42501');
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
           FROM pg_proc p WHERE p.oid = 'public.rag_record_source_opened(text, uuid)'::regprocedure`,
        )
      ).rows[0];
      assert.deepEqual(row, { definer: false, config: ['search_path=""'], anon_exec: false, auth_exec: false, service_exec: true, public_exec: false });
      assert.equal(allowListEntryFor('rag_record_source_opened(text,uuid)'), undefined);
    });

    test('the migration is idempotent', async () => {
      const fs = await import('node:fs');
      const sql = fs.readFileSync(new URL('../../supabase/migrations/0536_rag_retrieval_log_source_opened.sql', import.meta.url), 'utf8');
      await db.exec(sql);
      await db.exec(sql);
      assert.equal(await call(db, own, owner), 1);
    });
  });
}

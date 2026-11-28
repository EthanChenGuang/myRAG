import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATION = 'supabase/migrations/0741_red_team_review_cases.sql';
const STARTED_AT = '2026-11-27T10:00:00Z';

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `o:${crypto.randomUUID()}`;
}

function otherModeTenant(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? `o:${crypto.randomUUID()}` : 's:default';
}

function aCase(overrides: Row = {}): Row {
  return {
    item_id: 'rt-direct-override-en-001',
    technique: 'direct_override',
    language: 'en',
    trace_id: 'trace-red-team-0001',
    question: 'What does the zorvel sheet say about the quarnet cycle?',
    ...overrides,
  };
}

async function openCases(db: PGlite, tenantKey: string, runId: string, cases: unknown, role: Role = 'service_role'): Promise<number> {
  return asRole(db, role, async () => {
    const result = await db.query<{ n: number }>('SELECT public.rag_red_team_open_cases($1, $2::uuid, $3::timestamptz, $4::jsonb) AS n', [
      tenantKey,
      runId,
      STARTED_AT,
      JSON.stringify(cases),
    ]);
    return result.rows[0]?.n as number;
  });
}

async function itemsOf(db: PGlite, tenantKey: string): Promise<Row[]> {
  return (await db.query<Row>("SELECT * FROM rag_review_items WHERE tenant_key = $1 AND 'red_team' = ANY(tags) ORDER BY trace_id", [tenantKey])).rows;
}

async function catalog(db: PGlite): Promise<string[]> {
  const rows = await db.query<Row>(
    `SELECT p.oid::regprocedure::text AS sig, md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, '') AS def FROM pg_proc p
     WHERE p.proname = 'rag_red_team_open_cases'`,
  );
  return rows.rows.map((row) => JSON.stringify(row)).sort();
}

for (const mode of MODES) {
  describe(`0741 rag_red_team_open_cases (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await db.query("DELETE FROM rag_review_items WHERE 'red_team' = ANY(tags)");
    });

    test('a success becomes one open review item tagged red_team and rt_<technique>', async () => {
      const tenantKey = tenantFor(mode);
      const runId = crypto.randomUUID();
      assert.equal(await openCases(db, tenantKey, runId, [aCase()]), 1);
      const items = await itemsOf(db, tenantKey);
      assert.equal(items.length, 1);
      const item = items[0] as Row;
      assert.deepEqual(item.tags, ['red_team', 'rt_direct_override']);
      assert.deepEqual(item.reasons, []);
      assert.equal(item.status, 'open');
      assert.equal(item.channel, 'chat');
      assert.equal(item.outcome, 'answered');
      assert.equal(item.trace_id, 'trace-red-team-0001');
      assert.equal(item.query_language, 'en');
      assert.equal(item.query_masked, 'What does the zorvel sheet say about the quarnet cycle?');
      assert.match(String(item.query_fingerprint), /^[0-9a-f]{64}$/);
      const window = await db.query<{ same: boolean; ttl: boolean }>(
        "SELECT $1::timestamptz = $2::timestamptz AS same, $3::timestamptz > now() + interval '89 days' AS ttl",
        [item.mining_window, STARTED_AT, item.expires_at],
      );
      assert.equal(window.rows[0]?.same, true);
      assert.equal(window.rows[0]?.ttl, true);
    });

    test('the same run and item inserts nothing twice; another item or another run inserts again', async () => {
      const tenantKey = tenantFor(mode);
      const runId = crypto.randomUUID();
      assert.equal(await openCases(db, tenantKey, runId, [aCase()]), 1);
      assert.equal(await openCases(db, tenantKey, runId, [aCase({ trace_id: 'trace-red-team-0002' })]), 0);
      assert.equal(await openCases(db, tenantKey, runId, [aCase({ item_id: 'rt-direct-override-en-002', trace_id: 'trace-red-team-0003' })]), 1);
      assert.equal(await openCases(db, tenantKey, crypto.randomUUID(), [aCase({ trace_id: 'trace-red-team-0004' })]), 1);
      assert.equal((await itemsOf(db, tenantKey)).length, 3);
    });

    test('a long question is cut to 2000 characters', async () => {
      const tenantKey = tenantFor(mode);
      assert.equal(await openCases(db, tenantKey, crypto.randomUUID(), [aCase({ question: `Quarnet ${'lorem '.repeat(600)}` })]), 1);
      const item = (await itemsOf(db, tenantKey))[0] as Row;
      assert.equal(String(item.query_masked).length, 2000);
    });

    test('a tenant key of the other deployment mode or a malformed key is refused before any write', async () => {
      await rejectsWith(() => openCases(db, otherModeTenant(mode), crypto.randomUUID(), [aCase()]), '22023');
      await rejectsWith(() => openCases(db, 'bogus', crypto.randomUUID(), [aCase()]), '22023');
    });

    test('a malformed payload raises 22023 and writes nothing', async () => {
      const tenantKey = tenantFor(mode);
      const runId = crypto.randomUUID();
      await rejectsWith(() => openCases(db, tenantKey, runId, { cases: [] }), '22023');
      await rejectsWith(() => openCases(db, tenantKey, runId, [aCase(), aCase({ technique: 'Bad-Technique' })]), '22023');
      await rejectsWith(() => openCases(db, tenantKey, runId, [aCase({ question: '   ' })]), '22023');
      await rejectsWith(() => openCases(db, tenantKey, runId, [aCase({ language: 'english' })]), '22023');
      await rejectsWith(() => openCases(db, tenantKey, runId, [aCase({ trace_id: '' })]), '22023');
      await rejectsWith(() => openCases(db, tenantKey, runId, Array.from({ length: 501 }, (_, i) => aCase({ item_id: `rt-x-${i}` }))), '22023');
      assert.equal((await itemsOf(db, tenantKey)).length, 0);
    });

    test('anon and authenticated cannot execute it; it is SECURITY INVOKER with an empty search_path', async () => {
      const tenantKey = tenantFor(mode);
      await rejectsWith(() => openCases(db, tenantKey, crypto.randomUUID(), [aCase()], 'anon'), '42501');
      await rejectsWith(() => openCases(db, tenantKey, crypto.randomUUID(), [aCase()], 'authenticated'), '42501');
      const row = (
        await db.query<{ anon: boolean; authenticated: boolean; public_: boolean; service: boolean; definer: boolean; config: string[] | null }>(
          `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                  EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
                  p.prosecdef AS definer, p.proconfig AS config
             FROM pg_proc p WHERE p.proname = 'rag_red_team_open_cases'`,
        )
      ).rows[0];
      assert.ok(row);
      assert.equal(row.anon, false);
      assert.equal(row.authenticated, false);
      assert.equal(row.public_, false);
      assert.equal(row.service, true);
      assert.equal(row.definer, false);
      assert.deepEqual(row.config, ['search_path=""']);
      await assertNoClientCallableRagFunctions(db);
    });

    test('applying 0741 a second time succeeds and leaves the catalog unchanged', async () => {
      const once = await catalog(db);
      assert.equal(once.length, 1);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      assert.deepEqual(await catalog(db), once);
    });
  });
}

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const MIGRATION = 'supabase/migrations/0967_rag_review_item_strata.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const PHASE_511_REASONS = ['feedback_negative', 'refusal_disputed', 'groundedness_flagged', 'refused_high_score', 'zero_results', 'low_score', 'no_source_opened'];

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => sqlState(error) === code);
}

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  }
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

function fingerprint(): string {
  return crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
}

function orgKey(): string {
  return `o:${crypto.randomUUID()}`;
}

function queueRow(overrides: Row = {}): Row {
  return {
    query_masked: 'A synthetic question about the sample topic',
    query_fingerprint: fingerprint(),
    language: 'en',
    mining_window: '2026-11-23T00:00:00Z',
    reasons: ['representative'],
    stratum: 'c3|en|chat',
    sampling_weight: 2.5,
    ...overrides,
  };
}

async function enqueue(db: PGlite, tenantKey: string, source: string, rows: Row[] | unknown): Promise<number> {
  return asRole(db, 'service_role', null, async () => {
    const result = await db.query<{ n: number }>('SELECT public.rag_review_items_enqueue($1, $2, $3::jsonb) AS n', [tenantKey, source, JSON.stringify(rows)]);
    return (result.rows[0] as { n: number }).n;
  });
}

async function insertItem(db: PGlite, row: Row): Promise<string> {
  const values: Row = {
    tenant_key: 's:default',
    query_masked: 'A synthetic question about the sample topic',
    query_fingerprint: fingerprint(),
    reasons: ['low_score'],
    mining_window: '2026-11-23T00:00:00Z',
    ...row,
  };
  const names = Object.keys(values);
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    names.map((name) => values[name]),
  );
  return (result.rows[0] as { id: string }).id;
}

for (const mode of MODES) {
  describe(`rag_review_item_strata and rag_review_items_enqueue (${mode})`, () => {
    let db: PGlite;
    let tenant: string;
    let otherModeKey: string;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      tenant = mode === 'single-tenant' ? 's:default' : orgKey();
      otherModeKey = mode === 'single-tenant' ? orgKey() : 's:default';
    });

    after(async () => {
      await db.close();
    });

    test('the strata table and the enqueue function exist', async () => {
      const row = (
        await db.query<{ t: string | null; f: string | null }>(
          "SELECT to_regclass('public.rag_review_item_strata')::text AS t, to_regprocedure('public.rag_review_items_enqueue(text,text,jsonb)')::text AS f",
        )
      ).rows[0];
      assert.equal(row?.t, 'rag_review_item_strata');
      assert.ok(row?.f);
    });

    test('reasons representative and re_review are accepted, every Phase 5.1.1 reason still is, an unknown one is not', async () => {
      await insertItem(db, { tenant_key: tenant, reasons: ['representative'] });
      await insertItem(db, { tenant_key: tenant, reasons: ['re_review'] });
      await insertItem(db, { tenant_key: tenant, reasons: PHASE_511_REASONS });
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, reasons: ['sampled_by_hand'] }), '23514');
    });

    test('an item without a retrieval log row and without a trace id is accepted', async () => {
      const id = await insertItem(db, { tenant_key: tenant, reasons: ['representative'], trace_id: null, retrieval_log_id: null });
      const row = (await db.query<Row>('SELECT trace_id, retrieval_log_id FROM rag_review_items WHERE id = $1', [id])).rows[0];
      assert.equal(row?.trace_id, null);
      assert.equal(row?.retrieval_log_id, null);
    });

    test('enqueue inserts the items with one strata row each, returns the count, and a second call inserts 0', async () => {
      const rows = [queueRow(), queueRow({ stratum: 'c1|zh-Hans|voice', sampling_weight: 1, language: 'zh-Hans', reasons: ['re_review'] })];
      assert.equal(await enqueue(db, tenant, 'historical', rows), 2);
      assert.equal(await enqueue(db, tenant, 'historical', rows), 0);
      const fps = rows.map((row) => row.query_fingerprint as string);
      const stored = (
        await db.query<Row>(
          `SELECT i.tenant_key, i.query_language, i.reasons, i.trace_id, i.retrieval_log_id, i.status, s.source, s.stratum, s.sampling_weight, s.tenant_key AS strata_tenant
           FROM rag_review_items i JOIN rag_review_item_strata s ON s.review_item_id = i.id
           WHERE i.query_fingerprint = ANY($1) ORDER BY s.sampling_weight DESC`,
          [fps],
        )
      ).rows;
      assert.equal(stored.length, 2);
      assert.equal(stored[0]?.tenant_key, tenant);
      assert.equal(stored[0]?.strata_tenant, tenant);
      assert.equal(stored[0]?.source, 'historical');
      assert.equal(stored[0]?.stratum, 'c3|en|chat');
      assert.equal(stored[0]?.sampling_weight, 2.5);
      assert.equal(stored[0]?.status, 'open');
      assert.equal(stored[0]?.trace_id, null);
      assert.equal(stored[1]?.query_language, 'zh-Hans');
      assert.deepEqual(stored[1]?.reasons, ['re_review']);
    });

    test('a duplicate inside one call inserts once', async () => {
      const row = queueRow();
      assert.equal(await enqueue(db, tenant, 'representative', [row, row]), 1);
    });

    test('every source in representative, pilot, drift_fill, historical is accepted; any other is rejected', async () => {
      for (const source of ['representative', 'pilot', 'drift_fill', 'historical']) {
        assert.equal(await enqueue(db, tenant, source, [queueRow()]), 1, source);
      }
      await rejectsWith(() => enqueue(db, tenant, 'manual', [queueRow()]), '22023');
      const id = await insertItem(db, { tenant_key: tenant });
      await rejectsWith(
        () => db.query("INSERT INTO rag_review_item_strata (review_item_id, tenant_key, source, stratum, sampling_weight) VALUES ($1, $2, 'manual', 's', 1)", [id, tenant]),
        '23514',
      );
    });

    test('a negative or zero sampling weight is rejected and nothing is inserted', async () => {
      const negative = queueRow({ sampling_weight: -1 });
      await rejectsWith(() => enqueue(db, tenant, 'representative', [negative]), '23514');
      await rejectsWith(() => enqueue(db, tenant, 'representative', [queueRow({ sampling_weight: 0 })]), '23514');
      const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_review_items WHERE query_fingerprint = $1', [negative.query_fingerprint])).rows[0]?.n;
      assert.equal(count, 0);
    });

    test('malformed input is rejected with 22023: not an array, a row without fingerprint, mining window or stratum', async () => {
      await rejectsWith(() => enqueue(db, tenant, 'historical', { rows: [] }), '22023');
      for (const missing of ['query_fingerprint', 'mining_window', 'stratum', 'query_masked', 'sampling_weight']) {
        const row = queueRow();
        delete row[missing];
        await rejectsWith(() => enqueue(db, tenant, 'historical', [row]), '22023');
      }
      assert.equal(await enqueue(db, tenant, 'historical', []), 0);
    });

    test('rows are stored under p_tenant_key only, even when a row names another tenant', async () => {
      const row = queueRow({ tenant_key: otherModeKey });
      assert.equal(await enqueue(db, tenant, 'pilot', [row]), 1);
      const stored = (await db.query<Row>('SELECT tenant_key FROM rag_review_items WHERE query_fingerprint = $1', [row.query_fingerprint])).rows;
      assert.deepEqual(stored, [{ tenant_key: tenant }]);
    });

    test('a tenant key of the other deployment mode or a malformed key raises 22023', async () => {
      await rejectsWith(() => enqueue(db, otherModeKey, 'historical', [queueRow()]), '22023');
      await rejectsWith(() => enqueue(db, 'tenant-a', 'historical', [queueRow()]), '22023');
    });

    test("a retrieval_log_id of the same tenant is kept; one of another tenant or an unknown id is rejected", async () => {
      const owner = await createUser(db);
      const log = await db.query<{ id: string; tenant_key: string }>(
        "INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status) VALUES ($1, $2, 'chat', 'legacy', 'ok') RETURNING id, tenant_key",
        [crypto.randomUUID(), owner],
      );
      const logRow = log.rows[0] as { id: string; tenant_key: string };
      if (logRow.tenant_key === tenant) {
        assert.equal(await enqueue(db, tenant, 'drift_fill', [queueRow({ retrieval_log_id: logRow.id, trace_id: 'trace-1' })]), 1);
      } else {
        await rejectsWith(() => enqueue(db, tenant, 'drift_fill', [queueRow({ retrieval_log_id: logRow.id })]), '22023');
        assert.equal(await enqueue(db, logRow.tenant_key, 'drift_fill', [queueRow({ retrieval_log_id: logRow.id })]), 1);
      }
      await rejectsWith(() => enqueue(db, tenant, 'drift_fill', [queueRow({ retrieval_log_id: crypto.randomUUID() })]), '22023');
    });

    test('anon and authenticated get 42501 on the function and on the strata table', async () => {
      const user = await createUser(db);
      await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2)', [tenant, user]);
      for (const [role, id] of [['anon', null], ['authenticated', user]] as const) {
        await rejectsWith(
          () => asRole(db, role, id, () => db.query('SELECT public.rag_review_items_enqueue($1, $2, $3::jsonb)', [tenant, 'historical', JSON.stringify([queueRow()])])),
          '42501',
        );
        await rejectsWith(() => asRole(db, role, id, () => db.query('SELECT * FROM rag_review_item_strata')), '42501');
      }
    });

    test("a strata row must carry its item's tenant", async () => {
      const id = await insertItem(db, { tenant_key: tenant });
      await rejectsWith(
        () => db.query("INSERT INTO rag_review_item_strata (review_item_id, tenant_key, source, stratum, sampling_weight) VALUES ($1, $2, 'pilot', 's', 1)", [id, otherModeKey]),
        '23503',
      );
    });

    test('deleting a review item deletes its strata row', async () => {
      const row = queueRow();
      await enqueue(db, tenant, 'historical', [row]);
      const id = (await db.query<{ id: string }>('SELECT id FROM rag_review_items WHERE query_fingerprint = $1', [row.query_fingerprint])).rows[0]?.id;
      assert.equal((await db.query('SELECT 1 FROM rag_review_item_strata WHERE review_item_id = $1', [id])).rows.length, 1);
      await db.query('DELETE FROM rag_review_items WHERE id = $1', [id]);
      assert.equal((await db.query('SELECT 1 FROM rag_review_item_strata WHERE review_item_id = $1', [id])).rows.length, 0);
    });

    test('the function is SECURITY INVOKER with an empty search_path; RLS is on for the strata table', async () => {
      const fn = (
        await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
          "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.rag_review_items_enqueue(text,text,jsonb)'::regprocedure",
        )
      ).rows[0];
      assert.equal(fn?.prosecdef, false);
      assert.deepEqual(fn?.proconfig, ['search_path=""']);
      const rls = (await db.query<{ r: boolean }>("SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.rag_review_item_strata'::regclass")).rows[0]?.r;
      assert.equal(rls, true);
    });

    test('0967 is idempotent: applying it again keeps the reasons check and the stored rows', async () => {
      const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_review_item_strata')).rows[0]?.n;
      await applyMigrationFiles(db, [MIGRATION]);
      assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_review_item_strata')).rows[0]?.n, before);
      const checks = (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.rag_review_items'::regclass AND conname = 'rag_review_items_reasons_check'",
        )
      ).rows[0]?.n;
      assert.equal(checks, 1);
      await insertItem(db, { tenant_key: tenant, reasons: ['re_review'] });
      await rejectsWith(() => insertItem(db, { tenant_key: tenant, reasons: ['sampled_by_hand'] }), '23514');
    });
  });
}

describe('0967 without the Phase 5.1.1 tables', () => {
  test('applies as a no-op on a database without rag_review_items', async () => {
    const db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant', migrations: false })).db;
    try {
      await db.exec('DROP TABLE IF EXISTS public.rag_review_items CASCADE;');
      await applyMigrationFiles(db, [MIGRATION]);
      const row = (
        await db.query<{ t: string | null; f: string | null }>(
          "SELECT to_regclass('public.rag_review_item_strata')::text AS t, to_regprocedure('public.rag_review_items_enqueue(text,text,jsonb)')::text AS f",
        )
      ).rows[0];
      assert.deepEqual(row, { t: null, f: null });
    } finally {
      await db.close();
    }
  });
});

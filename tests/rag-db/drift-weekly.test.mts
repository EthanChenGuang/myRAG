import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MIGRATION = 'supabase/migrations/0968_rag_drift_weekly.sql';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];

type Role = 'anon' | 'authenticated' | 'service_role';

function codeOf(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => codeOf(error) === code || assert.fail(`expected ${code}, got ${codeOf(error)}: ${String(error)}`));
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    week: '2026-11-16',
    divergence: 0.12,
    state: 'ok',
    null_p95: 0.07,
    limits: { warn: 0.15, alert: 0.25, gap: 0.1 },
    clusters: [
      { id: 'c-01', production_share: 0.6, test_share: 0.55, test_items: 11, state: 'ok' },
      { id: 'c-02', production_share: 0.3, test_share: 0.4, test_items: 8, state: 'ok' },
      { id: 'novel', production_share: 0.1, test_share: 0.05, test_items: 1, state: 'under' },
    ],
    scores: { unweighted: 0.81, weighted: 0.78, uncovered_share: 0.1 },
    gaps: [{ slice: 'channel:chat', offline: 0.8, online: 0.74, online_n: 120, gap: 0.06, result: 'ok' }],
    ...overrides,
  };
}

async function upsert(db: PGlite, tenantKey: string | null, week: string, body: unknown): Promise<boolean> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ inserted: boolean }>('SELECT public.rag_drift_weekly_upsert($1, $2::date, $3::jsonb) AS inserted', [tenantKey, week, JSON.stringify(body)]),
  );
  return result.rows[0]?.inserted as boolean;
}

async function rows(db: PGlite, tenantKey: string): Promise<Record<string, unknown>[]> {
  return (
    await asRole(db, 'service_role', () =>
      db.query<Record<string, unknown>>(
        "SELECT tenant_key, to_char(week, 'YYYY-MM-DD') AS week, divergence, null_p95, state, report FROM public.rag_drift_weekly WHERE tenant_key = $1 ORDER BY week DESC LIMIT 8",
        [tenantKey],
      ),
    )
  ).rows;
}

function mondayOffset(weeks: number): string {
  const base = Date.UTC(2026, 10, 16);
  return new Date(base - weeks * 7 * 86400000).toISOString().slice(0, 10);
}

describe('0968 file text', () => {
  const file = path.join(REPO_ROOT, MIGRATION);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  test('the upsert is SECURITY INVOKER with an empty search_path and checks the tenant key first', () => {
    assert.ok(text.length > 0, `${MIGRATION} exists`);
    assert.equal(/SECURITY DEFINER/i.test(text), false);
    const functions = text.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$fn\$;/g) ?? [];
    assert.equal(functions.length, 1);
    const body = functions[0] as string;
    assert.ok(/SECURITY INVOKER/.test(body));
    assert.ok(/SET search_path = ''/.test(body));
    assert.ok(/^\s*PERFORM public\.rag_assert_tenant_key\(p_tenant_key\);/.test(body.slice(body.indexOf('BEGIN') + 'BEGIN'.length)));
  });
});

for (const mode of MODES) {
  const otherModeKey = mode === 'multi-tenant' ? 's:default' : `u:${crypto.randomUUID()}`;
  const tenantA = mode === 'multi-tenant' ? `u:${crypto.randomUUID()}` : 's:default';
  const tenantB = `o:${crypto.randomUUID()}`;

  describe(`rag_drift_weekly (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
    });

    after(async () => {
      await db?.close();
    });

    test('the first upsert inserts one row; the same tenant and week again replaces it', async () => {
      assert.equal(await upsert(db, tenantA, '2026-11-16', report()), true);
      assert.equal(await upsert(db, tenantA, '2026-11-16', report({ divergence: 0.31, state: 'alert', null_p95: 0.08 })), false);
      const stored = await rows(db, tenantA);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.week, '2026-11-16');
      assert.ok(Math.abs(Number(stored[0]?.divergence) - 0.31) < 1e-6);
      assert.ok(Math.abs(Number(stored[0]?.null_p95) - 0.08) < 1e-6);
      assert.equal(stored[0]?.state, 'alert');
      assert.deepEqual((stored[0]?.report as { clusters: unknown[] }).clusters, report().clusters);
    });

    test('a date inside a week is stored under the Monday that starts it', async () => {
      await upsert(db, tenantA, '2026-11-19', report({ divergence: 0.2, state: 'warn' }));
      const stored = await rows(db, tenantA);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.state, 'warn');
    });

    test('the last 8 weeks of a tenant come back newest first, never another tenant', async () => {
      for (let i = 0; i < 10; i += 1) await upsert(db, tenantA, mondayOffset(i), report({ divergence: i / 20 }));
      if (mode === 'multi-tenant') {
        for (let i = 0; i < 3; i += 1) await upsert(db, tenantB, mondayOffset(i - 1), report());
      }
      const stored = await rows(db, tenantA);
      assert.equal(stored.length, 8);
      assert.deepEqual(
        stored.map((row) => row.week),
        Array.from({ length: 8 }, (_, i) => mondayOffset(i)),
      );
      assert.ok(stored.every((row) => row.tenant_key === tenantA));
      if (mode === 'multi-tenant') {
        const other = await rows(db, tenantB);
        assert.equal(other.length, 3);
        assert.ok(other.every((row) => row.tenant_key === tenantB));
      }
    });

    for (const [label, body] of [
      ['a divergence above 1', report({ divergence: 1.5 })],
      ['a negative divergence', report({ divergence: -0.1 })],
      ['a missing divergence', report({ divergence: null })],
      ['a state outside ok, warn, alert', report({ state: 'bad' })],
      ['a null_p95 outside 0 to 1', report({ null_p95: 3 })],
      ['a report that is not an object', [report()]],
      ['free text in a string value', report({ clusters: [{ id: 'c-01', note: 'a sentence with words', production_share: 0.5 }] })],
      ['free text as a key', report({ 'a key with spaces': 1 })],
    ] as const) {
      test(`upsert rejects ${label} with 22023 and stores nothing`, async () => {
        const week = '2025-01-06';
        await rejectsWith(() => upsert(db, tenantA, week, body), '22023');
        const found = (
          await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_drift_weekly WHERE tenant_key = $1 AND week = $2::date', [tenantA, week])
        ).rows[0]?.n;
        assert.equal(found, 0);
      });
    }

    test('a NULL week raises 22023', async () => {
      await rejectsWith(
        () => asRole(db, 'service_role', () => db.query("SELECT public.rag_drift_weekly_upsert($1, NULL, '{}'::jsonb)", [tenantA])),
        '22023',
      );
    });

    test('the table check refuses an out-of-range divergence or a non-Monday week on a direct insert', async () => {
      await rejectsWith(
        () => db.query("INSERT INTO rag_drift_weekly (tenant_key, week, divergence, state, report) VALUES ($1, '2024-01-01', 1.2, 'ok', '{}')", [tenantA]),
        '23514',
      );
      await rejectsWith(
        () => db.query("INSERT INTO rag_drift_weekly (tenant_key, week, divergence, state, report) VALUES ($1, '2024-01-03', 0.2, 'ok', '{}')", [tenantA]),
        '23514',
      );
    });

    for (const [label, key] of [
      ['NULL', null],
      ['x:1', 'x:1'],
      ['the other mode key', otherModeKey],
    ] as const) {
      test(`${label} key raises 22023`, async () => {
        await rejectsWith(() => upsert(db, key, '2026-11-16', report()), '22023');
      });
    }

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on the table and the function`, async () => {
        await rejectsWith(() => asRole(db, role, () => db.query('SELECT * FROM public.rag_drift_weekly')), '42501');
        await rejectsWith(
          () => asRole(db, role, () => db.query("SELECT public.rag_drift_weekly_upsert($1, '2026-11-16'::date, '{}'::jsonb)", [tenantA])),
          '42501',
        );
      });
    }

    test('PUBLIC has no execute grant and RLS is on', async () => {
      const grants = (
        await db.query<{ grantee: string }>(
          `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(p.proacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_drift_weekly_upsert' AND a.privilege_type = 'EXECUTE'`,
        )
      ).rows.map((row) => row.grantee);
      assert.deepEqual(grants.filter((grantee) => ['PUBLIC', 'anon', 'authenticated'].includes(grantee)), []);
      assert.ok(grants.includes('service_role'));
      const rls = (await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rag_drift_weekly'::regclass")).rows[0];
      assert.equal(rls?.relrowsecurity, true);
    });

    test('the file applies twice without error and keeps the data', async () => {
      const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_drift_weekly')).rows[0]?.n;
      await applyMigrationFiles(db, [MIGRATION]);
      await applyMigrationFiles(db, [MIGRATION]);
      assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_drift_weekly')).rows[0]?.n, before);
    });
  });
}

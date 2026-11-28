import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MIGRATION = 'supabase/migrations/0966_rag_query_clusters.sql';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const TABLES = ['rag_query_cluster_sets', 'rag_query_clusters', 'rag_query_cluster_assignments'];
const DIM = 4;

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

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function insertLog(db: PGlite, userId: string): Promise<{ id: string; tenant_key: string }> {
  const result = await db.query<{ id: string; tenant_key: string }>(
    "INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status) VALUES ($1, $2, 'chat', 'legacy', 'ok') RETURNING id, tenant_key",
    [crypto.randomUUID(), userId],
  );
  return result.rows[0] as { id: string; tenant_key: string };
}

function unit(index: number, dim = DIM): number[] {
  return Array.from({ length: dim }, (_, i) => (i === index % dim ? 1 : 0));
}

function setSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { embedder: 'profile:fixture-embedder-1', dimension: DIM, k: 2, query_count: 40, distance_threshold: 0.35, ...overrides };
}

function clusterSpecs(count = 2, dim = DIM): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ cluster_id: `c-${String(i + 1).padStart(2, '0')}`, centroid: unit(i, dim), member_count: 10 + i }));
}

async function writeClusters(db: PGlite, tenantKey: string | null, set: unknown, clusters: unknown): Promise<string> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ id: string }>('SELECT public.rag_query_clusters_write($1, $2::jsonb, $3::jsonb) AS id', [
      tenantKey,
      JSON.stringify(set),
      JSON.stringify(clusters),
    ]),
  );
  return result.rows[0]?.id as string;
}

async function assign(db: PGlite, tenantKey: string | null, setId: string, rows: unknown): Promise<{ stored: number; dropped: number }> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ stored: number; dropped: number }>('SELECT stored, dropped FROM public.rag_query_cluster_assign($1, $2::uuid, $3::jsonb)', [
      tenantKey,
      setId,
      JSON.stringify(rows),
    ]),
  );
  const row = result.rows[0] as { stored: number; dropped: number };
  return { stored: Number(row.stored), dropped: Number(row.dropped) };
}

async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]?.n ?? -1);
}

describe('0966 file text', () => {
  const file = path.join(REPO_ROOT, MIGRATION);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  test('no pgvector column or index: centroids are real[]', () => {
    assert.ok(text.length > 0, `${MIGRATION} exists`);
    assert.equal(/USING hnsw|vector\(/i.test(text), false);
    assert.ok(/centroid real\[\]/.test(text));
  });

  test('every function is SECURITY INVOKER with an empty search_path and checks the tenant key first', () => {
    assert.equal(/SECURITY DEFINER/i.test(text), false);
    const functions = text.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$fn\$;/g) ?? [];
    assert.equal(functions.length, 2);
    for (const body of functions) {
      assert.ok(/SECURITY INVOKER/.test(body));
      assert.ok(/SET search_path = ''/.test(body));
      const begin = body.indexOf('BEGIN');
      assert.ok(/^\s*PERFORM public\.rag_assert_tenant_key\(p_tenant_key\);/.test(body.slice(begin + 'BEGIN'.length)), 'rag_assert_tenant_key is the first statement');
    }
  });
});

for (const mode of MODES) {
  const otherModeKey = mode === 'multi-tenant' ? 's:default' : `u:${crypto.randomUUID()}`;

  describe(`rag query clusters (${mode})`, () => {
    let db: PGlite;
    let userA: string;
    let userB: string;
    let tenantA: string;
    let tenantB: string;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      userA = await createUser(db);
      userB = await createUser(db);
      tenantA = mode === 'multi-tenant' ? `u:${userA}` : 's:default';
      tenantB = `u:${userB}`;
    });

    after(async () => {
      await db?.close();
    });

    test('the tables hold no text beyond the tenant key, status, embedder id and opaque cluster ids; centroids are real[]', async () => {
      const rows = (
        await db.query<{ table_name: string; column_name: string; udt_name: string }>(
          `SELECT table_name, column_name, udt_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name, column_name`,
          [TABLES],
        )
      ).rows;
      const textColumns = rows.filter((row) => ['text', 'varchar', 'jsonb', 'json', '_text'].includes(row.udt_name)).map((row) => `${row.table_name}.${row.column_name}`);
      assert.deepEqual(textColumns.sort(), [
        'rag_query_cluster_assignments.cluster_id',
        'rag_query_cluster_assignments.tenant_key',
        'rag_query_cluster_sets.embedder',
        'rag_query_cluster_sets.status',
        'rag_query_cluster_sets.tenant_key',
        'rag_query_clusters.cluster_id',
        'rag_query_clusters.tenant_key',
      ]);
      assert.equal(rows.find((row) => row.table_name === 'rag_query_clusters' && row.column_name === 'centroid')?.udt_name, '_float4');
      const vectorColumns = rows.filter((row) => /vector/.test(row.udt_name));
      assert.deepEqual(vectorColumns, []);
    });

    test('write creates one current set with its clusters, recording the embedder and dimension', async () => {
      const setId = await writeClusters(db, tenantA, setSpec(), clusterSpecs(2));
      assert.match(setId, /^[0-9a-f-]{36}$/);
      const set = (
        await db.query<Record<string, unknown>>('SELECT tenant_key, status, embedder, dimension, k, query_count, distance_threshold FROM rag_query_cluster_sets WHERE id = $1', [setId])
      ).rows[0];
      assert.equal(set?.tenant_key, tenantA);
      assert.equal(set?.status, 'current');
      assert.equal(set?.embedder, 'profile:fixture-embedder-1');
      assert.equal(set?.dimension, DIM);
      assert.equal(set?.k, 2);
      assert.equal(set?.query_count, 40);
      assert.ok(Math.abs(Number(set?.distance_threshold) - 0.35) < 1e-6);
      const clusters = (
        await db.query<{ cluster_id: string; centroid: number[]; member_count: number; tenant_key: string }>(
          'SELECT cluster_id, centroid, member_count, tenant_key FROM rag_query_clusters WHERE set_id = $1 ORDER BY cluster_id',
          [setId],
        )
      ).rows;
      assert.deepEqual(
        clusters.map((row) => [row.cluster_id, row.centroid.map(Number), row.member_count, row.tenant_key]),
        [
          ['c-01', unit(0), 10, tenantA],
          ['c-02', unit(1), 11, tenantA],
        ],
      );
    });

    test('a second write supersedes the previous current set of that tenant only', async () => {
      const otherSet = mode === 'multi-tenant' ? await writeClusters(db, tenantB, setSpec(), clusterSpecs(2)) : null;
      const first = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id;
      const second = await writeClusters(db, tenantA, setSpec({ k: 3 }), clusterSpecs(3));
      assert.notEqual(second, first);
      const statuses = (
        await db.query<{ id: string; status: string }>('SELECT id, status FROM rag_query_cluster_sets WHERE tenant_key = $1', [tenantA])
      ).rows;
      assert.equal(statuses.filter((row) => row.status === 'current').length, 1);
      assert.equal(statuses.find((row) => row.id === second)?.status, 'current');
      assert.equal(statuses.find((row) => row.id === first)?.status, 'superseded');
      if (otherSet) {
        assert.equal((await db.query<{ status: string }>('SELECT status FROM rag_query_cluster_sets WHERE id = $1', [otherSet])).rows[0]?.status, 'current');
      }
    });

    test('a second current set for one tenant is refused by the partial unique index', async () => {
      await rejectsWith(
        () =>
          db.query(
            "INSERT INTO rag_query_cluster_sets (tenant_key, status, embedder, dimension, k, query_count, distance_threshold) VALUES ($1, 'current', 'profile:x', 4, 2, 10, 0.3)",
            [tenantA],
          ),
        '23505',
      );
    });

    for (const [label, set, clusters] of [
      ['a centroid shorter than the dimension', setSpec(), [{ cluster_id: 'c-01', centroid: [1, 0, 0], member_count: 5 }]],
      ['a centroid longer than the dimension', setSpec(), [{ cluster_id: 'c-01', centroid: [1, 0, 0, 0, 0], member_count: 5 }]],
      ['a centroid with a non-number', setSpec(), [{ cluster_id: 'c-01', centroid: [1, 0, 'x', 0], member_count: 5 }]],
      ['a cluster id that is not opaque', setSpec(), [{ cluster_id: 'Topic about something', centroid: unit(0), member_count: 5 }]],
      ['a word as cluster id', setSpec(), [{ cluster_id: 'topic', centroid: unit(0), member_count: 5 }]],
      ['the reserved id novel as a centroid', setSpec(), [{ cluster_id: 'novel', centroid: unit(0), member_count: 5 }]],
      ['a duplicate cluster id', setSpec(), [{ cluster_id: 'c-01', centroid: unit(0), member_count: 5 }, { cluster_id: 'c-01', centroid: unit(1), member_count: 5 }]],
      ['an empty cluster list', setSpec(), []],
      ['a negative member count', setSpec(), [{ cluster_id: 'c-01', centroid: unit(0), member_count: -1 }]],
      ['a missing embedder', setSpec({ embedder: null }), clusterSpecs(1)],
      ['an embedder with free text', setSpec({ embedder: 'some model name' }), clusterSpecs(1)],
      ['a zero dimension', setSpec({ dimension: 0 }), clusterSpecs(1, 0)],
      ['a set that is not an object', ['x'], clusterSpecs(1)],
    ] as const) {
      test(`write rejects ${label} with 22023 and changes nothing`, async () => {
        const before = await count(db, 'rag_query_cluster_sets');
        const current = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id;
        await rejectsWith(() => writeClusters(db, tenantA, set, clusters), '22023');
        assert.equal(await count(db, 'rag_query_cluster_sets'), before);
        assert.equal((await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id, current);
      });
    }

    test('assign stores rows of the tenant, accepts novel, drops unknown log ids and counts them', async () => {
      const setId = await writeClusters(db, tenantA, setSpec(), clusterSpecs(2));
      const a1 = await insertLog(db, userA);
      const a2 = await insertLog(db, userA);
      const a3 = await insertLog(db, userA);
      assert.equal(a1.tenant_key, tenantA);
      const result = await assign(db, tenantA, setId, [
        { log_id: a1.id, cluster_id: 'c-01', distance: 0.1 },
        { log_id: a2.id, cluster_id: 'c-02', distance: 0.2 },
        { log_id: a3.id, cluster_id: 'novel', distance: 0.9 },
        { log_id: crypto.randomUUID(), cluster_id: 'c-01', distance: 0.1 },
      ]);
      assert.deepEqual(result, { stored: 3, dropped: 1 });
      const rows = (
        await db.query<{ log_id: string; cluster_id: string; tenant_key: string; set_id: string }>(
          'SELECT log_id, cluster_id, tenant_key, set_id FROM rag_query_cluster_assignments WHERE log_id = ANY($1::uuid[]) ORDER BY cluster_id',
          [[a1.id, a2.id, a3.id]],
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => [row.cluster_id, row.tenant_key, row.set_id]),
        [
          ['c-01', tenantA, setId],
          ['c-02', tenantA, setId],
          ['novel', tenantA, setId],
        ],
      );
    });

    test('assigning a log row again moves it to the new cluster', async () => {
      const setId = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id as string;
      const log = await insertLog(db, userA);
      await assign(db, tenantA, setId, [{ log_id: log.id, cluster_id: 'c-01', distance: 0.1 }]);
      assert.deepEqual(await assign(db, tenantA, setId, [{ log_id: log.id, cluster_id: 'c-02', distance: 0.15 }]), { stored: 1, dropped: 0 });
      assert.equal((await db.query<{ cluster_id: string }>('SELECT cluster_id FROM rag_query_cluster_assignments WHERE log_id = $1', [log.id])).rows[0]?.cluster_id, 'c-02');
    });

    for (const [label, row] of [
      ['a cluster id not in the set', { cluster_id: 'c-09', distance: 0.1 }],
      ['a text cluster id', { cluster_id: 'some words', distance: 0.1 }],
      ['a distance above 2', { cluster_id: 'c-01', distance: 2.5 }],
      ['a log id that is not a uuid', { log_id: 'not-a-uuid', cluster_id: 'c-01', distance: 0.1 }],
    ] as const) {
      test(`assign rejects ${label} with 22023`, async () => {
        const setId = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id as string;
        const log = await insertLog(db, userA);
        await rejectsWith(() => assign(db, tenantA, setId, [{ log_id: log.id, ...row }]), '22023');
        assert.equal(await count(db, 'rag_query_cluster_assignments WHERE log_id = $1', [log.id]), 0);
      });
    }

    test('assign rejects the same log id twice in one call', async () => {
      const setId = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id as string;
      const log = await insertLog(db, userA);
      await rejectsWith(
        () => assign(db, tenantA, setId, [{ log_id: log.id, cluster_id: 'c-01', distance: 0.1 }, { log_id: log.id, cluster_id: 'c-02', distance: 0.1 }]),
        '22023',
      );
    });

    test('an unknown set id raises 22023', async () => {
      await rejectsWith(() => assign(db, tenantA, crypto.randomUUID(), []), '22023');
    });

    test('deleting the log row deletes its assignment', async () => {
      const setId = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id as string;
      const log = await insertLog(db, userA);
      await assign(db, tenantA, setId, [{ log_id: log.id, cluster_id: 'c-01', distance: 0.1 }]);
      assert.equal(await count(db, 'rag_query_cluster_assignments WHERE log_id = $1', [log.id]), 1);
      await db.query('DELETE FROM rag_retrieval_log WHERE id = $1', [log.id]);
      assert.equal(await count(db, 'rag_query_cluster_assignments WHERE log_id = $1', [log.id]), 0);
    });

    if (mode === 'multi-tenant') {
      test('a log row of another tenant is dropped and counted, never stored', async () => {
        const setA = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id as string;
        const own = await insertLog(db, userA);
        const foreign = await insertLog(db, userB);
        assert.equal(foreign.tenant_key, tenantB);
        assert.deepEqual(
          await assign(db, tenantA, setA, [
            { log_id: own.id, cluster_id: 'c-01', distance: 0.1 },
            { log_id: foreign.id, cluster_id: 'c-01', distance: 0.1 },
          ]),
          { stored: 1, dropped: 1 },
        );
        assert.equal(await count(db, 'rag_query_cluster_assignments WHERE log_id = $1', [foreign.id]), 0);
      });

      test("another tenant's set id raises 22023 and stores nothing", async () => {
        const setB = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantB])).rows[0]?.id as string;
        const own = await insertLog(db, userA);
        await rejectsWith(() => assign(db, tenantA, setB, [{ log_id: own.id, cluster_id: 'c-01', distance: 0.1 }]), '22023');
        const foreign = await insertLog(db, userB);
        await rejectsWith(() => assign(db, tenantA, setB, [{ log_id: foreign.id, cluster_id: 'c-01', distance: 0.1 }]), '22023');
        assert.equal(await count(db, 'rag_query_cluster_assignments WHERE log_id = ANY($1::uuid[])', [[own.id, foreign.id]]), 0);
      });

      test('a cluster or assignment row whose tenant differs from its set is refused by the foreign key', async () => {
        const setA = (await db.query<{ id: string }>("SELECT id FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0]?.id as string;
        await rejectsWith(
          () => db.query("INSERT INTO rag_query_clusters (set_id, tenant_key, cluster_id, centroid, member_count) VALUES ($1, $2, 'c-77', '{1,0,0,0}', 5)", [setA, tenantB]),
          '23503',
        );
        const foreign = await insertLog(db, userB);
        await rejectsWith(
          () => db.query("INSERT INTO rag_query_cluster_assignments (log_id, tenant_key, set_id, cluster_id, distance) VALUES ($1, $2, $3, 'novel', 0.5)", [foreign.id, tenantB, setA]),
          '23503',
        );
      });
    }

    for (const [label, key] of [
      ['NULL', null],
      ['x:1', 'x:1'],
      ['the other mode key', otherModeKey],
    ] as const) {
      test(`${label} key raises 22023 in both functions`, async () => {
        await rejectsWith(() => writeClusters(db, key, setSpec(), clusterSpecs(1)), '22023');
        await rejectsWith(() => assign(db, key, crypto.randomUUID(), []), '22023');
      });
    }

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on the three tables and both functions`, async () => {
        for (const table of TABLES) {
          await rejectsWith(() => asRole(db, role, () => db.query(`SELECT * FROM public.${table}`)), '42501');
        }
        await rejectsWith(
          () => asRole(db, role, () => db.query("SELECT public.rag_query_clusters_write($1, '{}'::jsonb, '[]'::jsonb)", [tenantA])),
          '42501',
        );
        await rejectsWith(
          () => asRole(db, role, () => db.query("SELECT * FROM public.rag_query_cluster_assign($1, $2::uuid, '[]'::jsonb)", [tenantA, crypto.randomUUID()])),
          '42501',
        );
      });
    }

    test('PUBLIC has no execute grant and RLS is on for the three tables', async () => {
      const grants = (
        await db.query<{ grantee: string }>(
          `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(p.proacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rag_query_clusters_write', 'rag_query_cluster_assign') AND a.privilege_type = 'EXECUTE'`,
        )
      ).rows.map((row) => row.grantee);
      assert.equal(grants.includes('PUBLIC'), false);
      assert.equal(grants.includes('anon'), false);
      assert.equal(grants.includes('authenticated'), false);
      assert.ok(grants.includes('service_role'));
      const rls = (
        await db.query<{ relname: string; relrowsecurity: boolean }>(
          "SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])",
          [TABLES],
        )
      ).rows;
      assert.equal(rls.length, 3);
      assert.ok(rls.every((row) => row.relrowsecurity));
    });

    test('the file applies twice without error and keeps the data', async () => {
      const before = await count(db, 'rag_query_cluster_sets');
      const assignments = await count(db, 'rag_query_cluster_assignments');
      await applyMigrationFiles(db, [MIGRATION]);
      await applyMigrationFiles(db, [MIGRATION]);
      assert.equal(await count(db, 'rag_query_cluster_sets'), before);
      assert.equal(await count(db, 'rag_query_cluster_assignments'), assignments);
    });
  });
}

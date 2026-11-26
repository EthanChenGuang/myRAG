import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import type { QueryEmbedding } from '@/lib/rag/embeddings/query-embedding';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const { refreshClusters, loadClusterSamplingConfig } = await import('@/lib/rag/monitor/clusters');

const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const DIM = 8;
const DAY = 86_400_000;
const NOW = new Date('2026-11-18T12:00:00Z');
const CONFIG = { max_queries: 5000, min_queries: 30 };

type Row = Record<string, unknown>;

/** A supabase-js shaped client over PGlite with exactly the calls refreshClusters makes, every statement run as service_role. */
function pgliteServiceClient(db: PGlite, tap?: (table: string, rows: Row[]) => Row[]): SupabaseClient {
  const asService = async <T,>(sql: string, params: unknown[]) =>
    db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      return tx.query<T>(sql, params);
    });
  const ident = (name: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`);
    return `"${name}"`;
  };
  const plain = (rows: unknown[]) => JSON.parse(JSON.stringify(rows)) as Row[];

  const client = {
    from(table: string) {
      const where: string[] = [];
      const params: unknown[] = [];
      let columns = '*';
      let order = '';
      let range = '';
      const bind = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      const run = async (single: boolean) => {
        const sql = `SELECT ${columns
          .split(',')
          .map((c) => ident(c.trim()))
          .join(', ')} FROM public.${ident(table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${order}${range}`;
        try {
          let rows = plain((await asService<Row>(sql, params)).rows);
          if (tap) rows = tap(table, rows);
          if (single) return { data: rows[0] ?? null, error: rows.length > 1 ? { code: 'PGRST116' } : null };
          return { data: rows, error: null };
        } catch (error) {
          return { data: null, error: { code: (error as { code?: string }).code ?? 'XX000', message: String(error) } };
        }
      };
      const builder = {
        select(next: string) {
          columns = next;
          return builder;
        },
        eq(column: string, value: unknown) {
          where.push(`${ident(column)} = ${bind(value)}`);
          return builder;
        },
        gte(column: string, value: unknown) {
          where.push(`${ident(column)} >= ${bind(value)}`);
          return builder;
        },
        lt(column: string, value: unknown) {
          where.push(`${ident(column)} < ${bind(value)}`);
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          if (operator !== 'is' || value !== null) throw new Error('not() supports is null only');
          where.push(`${ident(column)} IS NOT NULL`);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          order += `${order ? ', ' : ' ORDER BY '}${ident(column)} ${options?.ascending === false ? 'DESC' : 'ASC'}`;
          return builder;
        },
        range(from: number, to: number) {
          range = ` LIMIT ${to - from + 1} OFFSET ${from}`;
          return builder;
        },
        maybeSingle: () => run(true),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run(false).then(resolve, reject),
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        if (name === 'rag_query_clusters_write') {
          const result = await asService<{ id: string }>('SELECT public.rag_query_clusters_write($1, $2::jsonb, $3::jsonb) AS id', [
            args.p_tenant_key,
            JSON.stringify(args.p_set),
            JSON.stringify(args.p_clusters),
          ]);
          return { data: result.rows[0]?.id ?? null, error: null };
        }
        if (name === 'rag_query_cluster_assign') {
          const result = await asService<Row>('SELECT stored, dropped FROM public.rag_query_cluster_assign($1, $2::uuid, $3::jsonb)', [
            args.p_tenant_key,
            args.p_set_id,
            JSON.stringify(args.p_rows),
          ]);
          return { data: plain(result.rows), error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      } catch (error) {
        return { data: null, error: { code: (error as { code?: string }).code ?? 'XX000', message: String(error) } };
      }
    },
  };
  return client as unknown as SupabaseClient;
}

function profile(id: string, dims: number): EmbeddingProfile {
  return {
    id,
    provider: 'fixture',
    model: 'fixture-model',
    dims,
    storage: 'profile_table',
    status: 'active',
    queryInstruction: null,
    scoreCalibration: {},
    activatedAt: null,
    activatedBy: null,
    previousActiveId: null,
    hasEvidence: false,
  } as unknown as EmbeddingProfile;
}

/** Synthetic questions name their topic group; the fake embedder maps a group to an axis plus small deterministic noise. */
function fakeEmbedder(options: { profileId?: string; dims?: number; calls?: string[] } = {}) {
  const dims = options.dims ?? DIM;
  const id = options.profileId ?? 'fixture-embedder-1';
  return async (texts: string[]): Promise<QueryEmbedding[]> => {
    options.calls?.push(...texts);
    return texts.map((text) => {
      const group = Number(/topic (\d+)/.exec(text)?.[1] ?? 0);
      const digest = crypto.createHash('sha256').update(text).digest();
      const vector = Array.from({ length: dims }, (_, d) => (d === group % dims ? 1 : 0) + ((digest[d % 32] as number) / 255 - 0.5) * 0.04);
      return { vector, profile: profile(id, dims) };
    });
  };
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

/** Inserts masked log rows spread over the four groups, at the given time, and returns their ids. */
async function insertQueries(db: PGlite, userId: string, count: number, at: Date, label: string, groupCount = 4): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status, query_masked, created_at)
     SELECT gen_random_uuid()::text, $1::uuid, 'chat', 'legacy', 'ok',
            'synthetic question topic ' || ((g - 1) % $4) || ' item ' || $3 || '-' || g,
            $2::timestamptz + (g || ' seconds')::interval
     FROM generate_series(1, $5::int) AS g
     RETURNING id`,
    [userId, at.toISOString(), label, groupCount, count],
  );
  return result.rows.map((row) => row.id);
}

async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]?.n ?? -1);
}

async function clusterIds(db: PGlite, setId: string): Promise<string[]> {
  return (await db.query<{ cluster_id: string }>('SELECT cluster_id FROM rag_query_clusters WHERE set_id = $1 ORDER BY cluster_id', [setId])).rows.map(
    (row) => row.cluster_id,
  );
}

function idNumber(id: string): number {
  return Number(id.slice(2));
}

test('the default sampling config is the monitor-alerts.json sampling block', () => {
  assert.deepEqual(loadClusterSamplingConfig(), { max_queries: 5000, min_queries: 30 });
  assert.throws(() => loadClusterSamplingConfig({ sampling: { max_queries: 0, min_queries: 30 } }));
});

for (const mode of MODES) {
  describe(`refreshClusters (${mode})`, () => {
    let db: PGlite;
    let admin: SupabaseClient;
    let userA: string;
    let userB: string;
    let tenantA: string;
    let tenantB: string;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      admin = pgliteServiceClient(db);
      userA = await createUser(db);
      userB = await createUser(db);
      tenantA = mode === 'multi-tenant' ? `u:${userA}` : 's:default';
      tenantB = `u:${userB}`;
    });

    after(async () => {
      await db?.close();
    });

    test('fewer masked queries than min_queries: too_few_queries and no write', async () => {
      await insertQueries(db, userA, 20, new Date(NOW.getTime() - 5 * DAY), 'few');
      const calls: string[] = [];
      const result = await refreshClusters(admin, { tenantKey: tenantA, now: NOW, embed: fakeEmbedder({ calls }), config: CONFIG });
      assert.deepEqual(result, { written: false, reason: 'too_few_queries', queryCount: 20 });
      assert.equal(calls.length, 0);
      assert.equal(await count(db, 'rag_query_cluster_sets'), 0);
      assert.equal(await count(db, 'rag_query_cluster_assignments'), 0);
    });

    test('first call fits a set (k 10 before merging), stores centroids only and assigns every row', async () => {
      await insertQueries(db, userA, 180, new Date(NOW.getTime() - 10 * DAY), 'fit');
      // Rows outside the 30-day window and rows without a masked query are never read.
      await insertQueries(db, userA, 40, new Date(NOW.getTime() - 40 * DAY), 'old');
      await db.query(
        "INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status, created_at) VALUES ($1, $2, 'chat', 'legacy', 'ok', $3)",
        [crypto.randomUUID(), userA, new Date(NOW.getTime() - DAY).toISOString()],
      );

      const result = await refreshClusters(admin, { tenantKey: tenantA, now: NOW, embed: fakeEmbedder(), config: CONFIG });
      assert.equal(result.written, true);
      if (!result.written) return;
      assert.equal(result.refit, true);
      assert.equal(result.queryCount, 200);
      assert.equal(result.k, 10);
      assert.equal(result.embedded, 200);
      assert.equal(result.assigned, 200);
      assert.equal(result.dropped, 0);
      assert.ok(result.clusters >= 4 && result.clusters <= 10);

      const set = (await db.query<Row>('SELECT * FROM rag_query_cluster_sets WHERE id = $1', [result.setId])).rows[0] as Row;
      assert.equal(set.tenant_key, tenantA);
      assert.equal(set.status, 'current');
      assert.equal(set.embedder, 'profile:fixture-embedder-1');
      assert.equal(set.dimension, DIM);
      assert.equal(set.k, 10);
      assert.equal(set.query_count, 200);
      assert.equal(new Date(String(set.fitted_at)).toISOString(), NOW.toISOString());
      assert.ok(Number(set.distance_threshold) >= 0 && Number(set.distance_threshold) <= 2);

      const ids = await clusterIds(db, result.setId);
      assert.equal(ids.length, result.clusters);
      for (const id of ids) assert.match(id, /^c-[0-9]{2,3}$/);
      const members = (await db.query<{ n: number }>('SELECT sum(member_count)::int AS n FROM rag_query_clusters WHERE set_id = $1', [result.setId])).rows[0];
      assert.equal(members?.n, 200);
      assert.equal(await count(db, 'rag_query_clusters WHERE set_id = $1 AND member_count < 5', [result.setId]), 0);
      assert.equal(await count(db, 'rag_query_cluster_assignments WHERE set_id = $1 AND tenant_key = $2', [result.setId, tenantA]), 200);

      // Each topic group lands in clusters of its own: no cluster mixes groups.
      const mixed = await db.query<{ cluster_id: string; groups: number }>(
        `SELECT a.cluster_id, count(DISTINCT substring(l.query_masked from 'topic ([0-9]+)'))::int AS groups
         FROM rag_query_cluster_assignments a JOIN rag_retrieval_log l ON l.id = a.log_id
         WHERE a.set_id = $1 GROUP BY a.cluster_id`,
        [result.setId],
      );
      for (const row of mixed.rows) assert.equal(row.groups, 1, `cluster ${row.cluster_id} mixes topic groups`);

      if (mode === 'multi-tenant') {
        assert.equal(await count(db, 'rag_query_cluster_sets WHERE tenant_key = $1', [tenantB]), 0);
        assert.equal(await count(db, 'rag_query_clusters WHERE tenant_key = $1', [tenantB]), 0);
        assert.equal(await count(db, 'rag_query_cluster_assignments WHERE tenant_key = $1', [tenantB]), 0);
      }
    });

    test('a second call in the same month assigns only new rows; the set is unchanged', async () => {
      const before = (await db.query<Row>("SELECT * FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0] as Row;
      const centroidsBefore = (await db.query<Row>('SELECT cluster_id, centroid, member_count FROM rag_query_clusters WHERE set_id = $1 ORDER BY cluster_id', [before.id])).rows;
      const later = new Date(NOW.getTime() + 7 * DAY);
      const fresh = await insertQueries(db, userA, 20, new Date(later.getTime() - DAY), 'new');
      const outlier = (
        await db.query<{ id: string }>(
          "INSERT INTO rag_retrieval_log (trace_id, user_id, channel, pipeline, status, query_masked, created_at) VALUES ($1, $2, 'chat', 'legacy', 'ok', 'synthetic question topic 6 outlier', $3) RETURNING id",
          [crypto.randomUUID(), userA, new Date(later.getTime() - DAY).toISOString()],
        )
      ).rows[0]?.id as string;
      const calls: string[] = [];

      const result = await refreshClusters(admin, { tenantKey: tenantA, now: later, embed: fakeEmbedder({ calls }), config: CONFIG });
      assert.equal(result.written, true);
      if (!result.written) return;
      assert.equal(result.refit, false);
      assert.equal(result.setId, before.id);
      assert.equal(result.embedded, 21);
      assert.equal(calls.length, 21);
      assert.equal(result.assigned, 21);
      assert.ok(result.novel >= 1 && result.novel <= 21);
      assert.equal(await count(db, 'rag_query_cluster_sets WHERE tenant_key = $1', [tenantA]), 1);
      const centroidsAfter = (await db.query<Row>('SELECT cluster_id, centroid, member_count FROM rag_query_clusters WHERE set_id = $1 ORDER BY cluster_id', [before.id])).rows;
      assert.deepEqual(centroidsAfter, centroidsBefore);
      assert.equal(
        (await db.query<{ cluster_id: string }>('SELECT cluster_id FROM rag_query_cluster_assignments WHERE log_id = $1', [outlier])).rows[0]?.cluster_id,
        'novel',
      );
      assert.equal(await count(db, 'rag_query_cluster_assignments WHERE log_id = ANY($1::uuid[]) AND set_id = $2', [fresh, before.id]), 20);
      assert.equal(await count(db, "rag_query_cluster_assignments WHERE set_id = $1 AND cluster_id = 'novel'", [before.id]), result.novel);
      // A new row outside novel joins a cluster whose fit-time members share its topic group.
      const wrong = await count(
        db,
        `rag_query_cluster_assignments a JOIN rag_retrieval_log l ON l.id = a.log_id
         WHERE a.log_id = ANY($1::uuid[]) AND a.cluster_id <> 'novel' AND EXISTS (
           SELECT 1 FROM rag_query_cluster_assignments m JOIN rag_retrieval_log ml ON ml.id = m.log_id
           WHERE m.set_id = a.set_id AND m.cluster_id = a.cluster_id AND NOT (m.log_id = ANY($1::uuid[]))
             AND substring(ml.query_masked from 'topic ([0-9]+)') <> substring(l.query_masked from 'topic ([0-9]+)'))`,
        [fresh],
      );
      assert.equal(wrong, 0);
    });

    test('31 days after fitted_at the set is refit and close centroids keep their ids', async () => {
      const old = (await db.query<Row>("SELECT * FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0] as Row;
      const oldIds = await clusterIds(db, String(old.id));
      const later = new Date(NOW.getTime() + 31 * DAY);
      await insertQueries(db, userA, 120, new Date(later.getTime() - 3 * DAY), 'month');

      const result = await refreshClusters(admin, { tenantKey: tenantA, now: later, embed: fakeEmbedder(), config: CONFIG });
      assert.equal(result.written, true);
      if (!result.written) return;
      assert.equal(result.refit, true);
      assert.notEqual(result.setId, old.id);
      assert.equal((await db.query<Row>('SELECT status FROM rag_query_cluster_sets WHERE id = $1', [old.id])).rows[0]?.status, 'superseded');
      const newIds = await clusterIds(db, result.setId);
      const kept = newIds.filter((id) => oldIds.includes(id));
      assert.ok(kept.length >= 4, `at least one id per topic group is carried over (kept ${kept.length})`);
      const maxOld = Math.max(...oldIds.map(idNumber));
      for (const id of newIds.filter((id) => !oldIds.includes(id))) assert.ok(idNumber(id) > maxOld);
    });

    test('an embedder or dimension change forces a refit within the month', async () => {
      const old = (await db.query<Row>("SELECT * FROM rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA])).rows[0] as Row;
      const fittedAt = new Date(String(old.fitted_at));
      const swapped = await refreshClusters(admin, {
        tenantKey: tenantA,
        now: new Date(fittedAt.getTime() + DAY),
        embed: fakeEmbedder({ profileId: 'fixture-embedder-2' }),
        config: CONFIG,
      });
      assert.equal(swapped.written && swapped.refit, true);
      if (!swapped.written) return;
      const swappedSet = (await db.query<Row>('SELECT embedder, dimension FROM rag_query_cluster_sets WHERE id = $1', [swapped.setId])).rows[0] as Row;
      assert.equal(swappedSet.embedder, 'profile:fixture-embedder-2');
      // Same vectors from another embedder id: the 0.85 rule still carries the ids.
      const oldIds = await clusterIds(db, String(old.id));
      assert.ok((await clusterIds(db, swapped.setId)).filter((id) => oldIds.includes(id)).length >= 4);

      const idsBefore = await clusterIds(db, swapped.setId);
      const resized = await refreshClusters(admin, {
        tenantKey: tenantA,
        now: new Date(fittedAt.getTime() + 2 * DAY),
        embed: fakeEmbedder({ profileId: 'fixture-embedder-2', dims: DIM + 4 }),
        config: CONFIG,
      });
      assert.equal(resized.written && resized.refit, true);
      if (!resized.written) return;
      assert.equal((await db.query<Row>('SELECT dimension FROM rag_query_cluster_sets WHERE id = $1', [resized.setId])).rows[0]?.dimension, DIM + 4);
      const maxBefore = Math.max(...idsBefore.map(idNumber));
      for (const id of await clusterIds(db, resized.setId)) assert.ok(idNumber(id) > maxBefore, 'centroids of another dimension never keep an old id');
      assert.equal(await count(db, "rag_query_cluster_sets WHERE tenant_key = $1 AND status = 'current'", [tenantA]), 1);
    });

    if (mode === 'multi-tenant') {
      test('rows of tenant B handed to the assign writer under tenant A are dropped by SQL and counted', async () => {
        const userC = await createUser(db);
        const tenantC = `u:${userC}`;
        await insertQueries(db, userC, 60, new Date(NOW.getTime() - 2 * DAY), 'c');
        await insertQueries(db, userB, 7, new Date(NOW.getTime() - 2 * DAY), 'b');
        const foreign = (
          await db.query<Row>('SELECT id, query_masked FROM rag_retrieval_log WHERE tenant_key = $1', [tenantB])
        ).rows.map((row) => ({ id: row.id, query_masked: row.query_masked }));
        // A faulty read that leaks tenant B's rows into tenant C's batch.
        const leaky = pgliteServiceClient(db, (table, rows) => (table === 'rag_retrieval_log' ? [...rows, ...foreign] : rows));

        const result = await refreshClusters(leaky, { tenantKey: tenantC, now: NOW, embed: fakeEmbedder(), config: CONFIG });
        assert.equal(result.written, true);
        if (!result.written) return;
        assert.equal(result.assigned, 60);
        assert.equal(result.dropped, 7);
        assert.equal(await count(db, 'rag_query_cluster_assignments WHERE tenant_key = $1', [tenantB]), 0);
        assert.equal(
          await count(db, 'rag_query_cluster_assignments a JOIN rag_retrieval_log l ON l.id = a.log_id WHERE a.tenant_key <> l.tenant_key'),
          0,
        );
        assert.equal(await count(db, 'rag_query_cluster_sets WHERE tenant_key = $1', [tenantB]), 0);
      });

      test('above max_queries a seeded subsample is embedded; the same week draws the same subsample', async () => {
        const userD = await createUser(db);
        const tenantD = `u:${userD}`;
        await insertQueries(db, userD, 5100, new Date(NOW.getTime() - 3 * DAY), 'big', 6);
        const first: string[] = [];
        const result = await refreshClusters(admin, { tenantKey: tenantD, now: NOW, embed: fakeEmbedder({ calls: first }), config: CONFIG });
        assert.equal(result.written, true);
        if (!result.written) return;
        assert.equal(result.queryCount, 5100);
        assert.equal(result.embedded, 5000);
        assert.equal(first.length, 5000);
        assert.equal(result.k, 40);

        await db.query('DELETE FROM rag_query_cluster_sets WHERE tenant_key = $1', [tenantD]);
        const second: string[] = [];
        await refreshClusters(admin, { tenantKey: tenantD, now: new Date(NOW.getTime() + DAY), embed: fakeEmbedder({ calls: second }), config: CONFIG });
        assert.deepEqual([...second].sort(), [...first].sort());
      });
    }
  });
}

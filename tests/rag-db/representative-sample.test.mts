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
const { drawWeeklySample, sampleStatus, sampleTenants } = await import('@/lib/rag/monitor/sample');
const { storeDriftReport } = await import('@/lib/rag/monitor/drift-store');
const { loadMonitorAlertsConfig } = await import('@/lib/rag/monitor/alerts-config');

const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const DIM = 8;
const DAY = 86_400_000;
const NOW = new Date('2026-11-25T12:00:00Z');
const WEEK_START = '2026-11-16T00:00:00.000Z';
const ON = { RAG_REPRESENTATIVE_SAMPLE: 'true', RAG_RETRIEVAL_LOG: 'masked_query', RAG_DOMAIN_EXPERT_REVIEW: 'true' };
const SHARES = [40, 30, 20, 10];
const QUOTAS = [12, 9, 6, 3];
const LANGS = ['xx', 'yy'];

type Row = Record<string, unknown>;

/** A supabase-js shaped client over PGlite with the calls the sampler makes, every statement run as service_role. */
function serviceClient(db: PGlite): SupabaseClient {
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
  const param = (value: unknown) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
  const error = (e: unknown) => ({ data: null, error: { code: (e as { code?: string }).code ?? 'XX000', message: String(e) } });

  return {
    from(table: string) {
      const where: string[] = [];
      const params: unknown[] = [];
      let columns = '*';
      let order = '';
      let tail = '';
      const bind = (value: unknown) => {
        params.push(param(value));
        return `$${params.length}`;
      };
      const run = async (single: boolean) => {
        const cols = columns.split(',').map((c) => ident(c.trim())).join(', ');
        const sql = `SELECT ${cols} FROM public.${ident(table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${order}${tail}`;
        try {
          const rows = plain((await asService<Row>(sql, params)).rows);
          if (single) return { data: rows[0] ?? null, error: rows.length > 1 ? { code: 'PGRST116' } : null };
          return { data: rows, error: null };
        } catch (e) {
          return error(e);
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
        neq(column: string, value: unknown) {
          where.push(`${ident(column)} <> ${bind(value)}`);
          return builder;
        },
        in(column: string, values: unknown[]) {
          where.push(`${ident(column)}::text = ANY(${bind(values.map(String))}::text[])`);
          params[params.length - 1] = values.map(String);
          return builder;
        },
        contains(column: string, values: unknown[]) {
          where.push(`${ident(column)} @> ${bind(values.map(String))}::text[]`);
          params[params.length - 1] = values.map(String);
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
          tail = ` LIMIT ${to - from + 1} OFFSET ${from}`;
          return builder;
        },
        limit(count: number) {
          tail = ` LIMIT ${count}`;
          return builder;
        },
        maybeSingle: () => run(true),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run(false).then(resolve, reject),
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      const params: unknown[] = [];
      const named = Object.entries(args).map(([key, value]) => {
        params.push(param(value));
        return `${ident(key)} => $${params.length}`;
      });
      try {
        if (name === 'rag_query_cluster_assign') {
          const result = await asService<Row>(`SELECT stored, dropped FROM public.rag_query_cluster_assign(${named.join(', ')})`, params);
          return { data: plain(result.rows), error: null };
        }
        const result = await asService<{ value: unknown }>(`SELECT to_jsonb(public.${ident(name)}(${named.join(', ')})) AS value`, params);
        return { data: result.rows[0]?.value ?? null, error: null };
      } catch (e) {
        return error(e);
      }
    },
  } as unknown as SupabaseClient;
}

function profile(id: string): EmbeddingProfile {
  return { id, provider: 'fixture', model: 'fixture-model', dims: DIM, storage: 'profile_table', status: 'active' } as unknown as EmbeddingProfile;
}

/** Questions name their topic; the fake embedder maps topic g to axis g plus small deterministic noise. */
async function fakeEmbed(texts: string[]): Promise<QueryEmbedding[]> {
  return texts.map((text) => {
    const group = Number(/topic (\d+)/.exec(text)?.[1] ?? 0);
    const digest = crypto.createHash('sha256').update(text).digest();
    const vector = Array.from({ length: DIM }, (_, d) => (d === group ? 1 : 0) + ((digest[d % 32] as number) / 255 - 0.5) * 0.04);
    return { vector, profile: profile('fixture-embedder-1') };
  });
}

async function createUser(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(0, 8)}@example.invalid`]);
  return id;
}

async function createOrg(db: PGlite, owner: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO organizations (id, name, slug, owner_id) VALUES ($1, $2, $2, $3)', [id, `org-${id.slice(0, 8)}`, owner]);
  return id;
}

/** One current cluster set c-01..c-04 on axes 0..3, fitted a day before NOW, so the sampler assigns instead of refitting. */
async function writeClusterSet(db: PGlite, tenantKey: string): Promise<void> {
  const centroid = (g: number) => Array.from({ length: DIM }, (_, d) => (d === g ? 1 : 0));
  await db.query('SELECT public.rag_query_clusters_write($1, $2::jsonb, $3::jsonb)', [
    tenantKey,
    JSON.stringify({ embedder: 'profile:fixture-embedder-1', dimension: DIM, k: 4, query_count: 100, distance_threshold: 1.5, fitted_at: new Date(NOW.getTime() - DAY).toISOString() }),
    JSON.stringify([0, 1, 2, 3].map((g) => ({ cluster_id: `c-0${g + 1}`, centroid: centroid(g), member_count: 25 }))),
  ]);
}

interface LogSpec {
  userId: string;
  orgId: string | null;
  topic: number;
  count: number;
  at: Date;
  label: string;
}

async function insertLog(db: PGlite, spec: LogSpec): Promise<void> {
  for (let i = 0; i < spec.count; i += 1) {
    const text = `synthetic question topic ${spec.topic} item ${spec.label}-${i}`;
    await db.query(
      `INSERT INTO rag_retrieval_log (trace_id, user_id, organization_id, channel, pipeline, status, query_masked, query_fingerprint, query_language, created_at)
       VALUES ($1, $2, $3, 'chat', 'legacy', 'ok', $4, $5, $6, $7)`,
      [crypto.randomUUID(), spec.userId, spec.orgId, text, crypto.createHash('sha256').update(text).digest('hex'), LANGS[i % 2], new Date(spec.at.getTime() + i * 1000).toISOString()],
    );
  }
}

async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]?.n ?? -1);
}

const lastWeek = new Date('2026-11-17T09:00:00Z');

for (const mode of MODES) {
  describe(`drawWeeklySample (${mode})`, () => {
    let db: PGlite;
    let admin: SupabaseClient;
    let tenantA: string;
    let tenantB: string | null = null;
    let orgA: string | null = null;
    let userA: string;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      admin = serviceClient(db);
      userA = await createUser(db);
      if (mode === 'multi-tenant') {
        orgA = await createOrg(db, userA);
        const userB = await createUser(db);
        const orgB = await createOrg(db, userB);
        tenantA = `o:${orgA}`;
        tenantB = `o:${orgB}`;
        for (let g = 0; g < 4; g += 1) await insertLog(db, { userId: userB, orgId: orgB, topic: g, count: 15, at: lastWeek, label: `b${g}` });
      } else {
        tenantA = 's:default';
      }
      await writeClusterSet(db, tenantA);
      for (let g = 0; g < 4; g += 1) {
        await insertLog(db, { userId: userA, orgId: orgA, topic: g, count: SHARES[g] as number, at: lastWeek, label: `a${g}` });
      }
      // Rows of the current week and of three weeks ago are outside the sampled week.
      await insertLog(db, { userId: userA, orgId: orgA, topic: 0, count: 10, at: new Date('2026-11-24T09:00:00Z'), label: 'current' });
      await insertLog(db, { userId: userA, orgId: orgA, topic: 1, count: 10, at: new Date('2026-11-03T09:00:00Z'), label: 'old' });
    });

    after(async () => {
      await db?.close();
    });

    test('a missing prerequisite writes nothing and names it', async () => {
      const before = await count(db, 'rag_review_items');
      assert.deepEqual(await drawWeeklySample(admin, { tenantKey: tenantA, now: NOW, embed: fakeEmbed, env: {} }), {
        written: false,
        missing: ['sample', 'log', 'review'],
      });
      assert.deepEqual(await drawWeeklySample(admin, { tenantKey: tenantA, now: NOW, embed: fakeEmbed, env: { ...ON, RAG_RETRIEVAL_LOG: 'ids' } }), {
        written: false,
        missing: ['log'],
      });
      assert.deepEqual(await drawWeeklySample(admin, { tenantKey: tenantA, now: NOW, embed: fakeEmbed, env: { ...ON, RAG_DOMAIN_EXPERT_REVIEW: 'false' } }), {
        written: false,
        missing: ['review'],
      });
      assert.equal(await count(db, 'rag_review_items'), before);
      assert.equal(await count(db, 'rag_query_cluster_assignments'), 0);
    });

    test('30 items cover every cluster within one item of its proportional quota, under tenant A only', async () => {
      const result = await drawWeeklySample(admin, { tenantKey: tenantA, now: NOW, embed: fakeEmbed, env: ON });
      assert.equal(result.written, true);
      if (!result.written) return;
      assert.equal(result.added, 30);
      assert.equal(result.week, '2026-W47');
      assert.deepEqual(result.by_source, { representative: 30, pilot: 0, drift_fill: 0 });
      assert.equal(result.excluded_queued, 0);
      assert.equal(result.by_language.xx! + result.by_language.yy!, 30);

      const items = (
        await db.query<{ query_masked: string; reasons: string[]; mining_window: string; source: string; stratum: string; sampling_weight: number; tenant_key: string }>(
          `SELECT i.query_masked, i.reasons, i.mining_window::text, s.source, s.stratum, s.sampling_weight, s.tenant_key
             FROM rag_review_items i JOIN rag_review_item_strata s ON s.review_item_id = i.id WHERE i.tenant_key = $1`,
          [tenantA],
        )
      ).rows;
      assert.equal(items.length, 30);
      for (const item of items) {
        assert.deepEqual(item.reasons, ['representative']);
        assert.equal(new Date(item.mining_window).toISOString(), WEEK_START);
        assert.equal(item.source, 'representative');
        assert.equal(item.tenant_key, tenantA);
        assert.match(item.stratum, /^c-0[1-4]\|(xx|yy)\|chat$/);
        assert.ok(item.sampling_weight > 1);
        assert.doesNotMatch(item.query_masked, /item (current|old)-/);
      }
      for (let g = 0; g < 4; g += 1) {
        const drawn = items.filter((item) => item.query_masked.includes(`topic ${g} `));
        assert.ok(Math.abs(drawn.length - (QUOTAS[g] as number)) <= 1, `topic ${g}: ${drawn.length} vs ${QUOTAS[g]}`);
        assert.ok(drawn.every((item) => item.stratum.startsWith(`c-0${g + 1}|`)));
      }
      const weights = items.reduce((sum, item) => sum + Number(item.sampling_weight), 0);
      assert.ok(Math.abs(weights - 100) < 0.01, `weights add up to the week's rows, got ${weights}`);
      if (tenantB) assert.equal(await count(db, 'rag_review_items WHERE tenant_key = $1', [tenantB]), 0);
    });

    test('a second run in the same week adds nothing', async () => {
      const result = await drawWeeklySample(admin, { tenantKey: tenantA, now: NOW, embed: fakeEmbed, env: ON });
      assert.equal(result.written, true);
      if (!result.written) return;
      assert.equal(result.added, 0);
      assert.equal(await count(db, 'rag_review_items WHERE tenant_key = $1', [tenantA]), 30);
    });

    test('sampleStatus reports counts only', async () => {
      const status = await sampleStatus(admin, tenantA, { env: ON });
      assert.equal(status.enabled, true);
      assert.deepEqual(status.missing, []);
      assert.equal(typeof status.last_sample_at, 'string');
      assert.equal(status.added, 30);
      assert.deepEqual(status.by_source, { representative: 30, pilot: 0, drift_fill: 0 });
      assert.equal(Object.values(status.by_language).reduce((a, b) => a + b, 0), 30);
      assert.equal(status.clusters.count, 4);
      assert.equal(typeof status.clusters.refit_at, 'string');
      assert.equal(typeof status.clusters.novel, 'number');
      assert.doesNotMatch(JSON.stringify(status), /synthetic question/);
      const off = await sampleStatus(admin, tenantA, { env: { ...ON, RAG_RETRIEVAL_LOG: 'off', RAG_DOMAIN_EXPERT_REVIEW: 'false' } });
      assert.deepEqual(off.missing, ['log', 'review']);
    });

    test('sampleTenants lists the tenants with masked rows in the sampled week', async () => {
      const tenants = await sampleTenants(admin, NOW);
      assert.deepEqual(tenants, [tenantA, ...(tenantB ? [tenantB] : [])].sort());
    });

    if (mode === 'multi-tenant') {
      test('pilot rows and under-covered clusters get their capped shares, with sources in the strata rows', async () => {
        const owner = await createUser(db);
        const pilot = await createUser(db);
        const org = await createOrg(db, owner);
        const tenant = `o:${org}`;
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [org, pilot]);
        await db.query('SELECT public.rag_pilot_user_add($1, $2, NULL)', [tenant, pilot]);
        await writeClusterSet(db, tenant);
        await db.query('SELECT public.rag_drift_weekly_upsert($1, $2::date, $3::jsonb)', [
          tenant,
          '2026-11-16',
          JSON.stringify({
            week: '2026-W47',
            divergence: 0.3,
            null_p95: 0.05,
            state: 'alert',
            limits: { warn: 0.1, alert: 0.2, gap: 0.15 },
            clusters: [
              { id: 'c-03', production_share: 0.3, test_share: 0.02, test_items: 1, state: 'under' },
              { id: 'c-01', production_share: 0.4, test_share: 0.5, test_items: 30, state: 'ok' },
            ],
          }),
        ]);
        for (let g = 0; g < 4; g += 1) await insertLog(db, { userId: owner, orgId: org, topic: g, count: 30, at: lastWeek, label: `o${g}` });
        await insertLog(db, { userId: pilot, orgId: org, topic: 0, count: 40, at: lastWeek, label: 'pilot' });

        const result = await drawWeeklySample(admin, { tenantKey: tenant, now: NOW, embed: fakeEmbed, env: ON });
        assert.equal(result.written, true);
        if (!result.written) return;
        assert.equal(result.added, 30);
        assert.equal(result.by_source.drift_fill, 15);
        // The 15 left after drift_fill: pilot mass 5 x 40 against 90 other rows gives round(15 x 200 / 290) = 10, under the cap of 12.
        assert.equal(result.by_source.pilot, 10);
        assert.equal(result.by_source.representative, 5);

        const rows = (
          await db.query<{ source: string; stratum: string; user_id: string | null }>(
            `SELECT s.source, s.stratum, l.user_id::text AS user_id FROM rag_review_item_strata s
               JOIN rag_review_items i ON i.id = s.review_item_id LEFT JOIN rag_retrieval_log l ON l.id = i.retrieval_log_id
              WHERE s.tenant_key = $1`,
            [tenant],
          )
        ).rows;
        assert.equal(rows.length, 30);
        assert.ok(rows.filter((row) => row.source === 'drift_fill').every((row) => row.stratum.startsWith('c-03|')));
        assert.ok(rows.filter((row) => row.source === 'pilot').every((row) => row.user_id === pilot));
        assert.ok(rows.filter((row) => row.source === 'representative').every((row) => row.user_id !== pilot && !row.stratum.startsWith('c-03|')));
        assert.equal(await count(db, 'rag_review_items WHERE tenant_key = $1', [tenantB]), 0);
      });

      test('a posted drift report names the under-covered cluster, raises one alert and the next sample draws drift_fill from it (SC 8)', async () => {
        const owner = await createUser(db);
        const org = await createOrg(db, owner);
        const tenant = `o:${org}`;
        await writeClusterSet(db, tenant);
        const config = loadMonitorAlertsConfig();
        assert.ok(config);
        const report = {
          week: '2026-W47',
          divergence: 0.3,
          null_p95: 0.05,
          state: 'ok',
          limits: { warn: 0.1, alert: 0.2, gap: 0.15 },
          clusters: [
            { id: 'c-03', production_share: 0.3, test_share: 0.02, test_items: 1, state: 'ok' },
            { id: 'c-01', production_share: 0.7, test_share: 0.98, test_items: 60, state: 'ok' },
          ],
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const stored = await storeDriftReport(admin, { tenantKey: tenant, report, config: config!, monitorOn: true, channels: [], now: NOW });
          assert.equal(stored.ok, true);
          if (stored.ok) assert.equal(stored.state, 'alert');
        }
        const weekly = (await db.query<{ state: string; report: { clusters: Array<{ id: string; state: string }> } }>(
          'SELECT state, report FROM rag_drift_weekly WHERE tenant_key = $1', [tenant])).rows;
        assert.equal(weekly.length, 1);
        assert.equal(weekly[0]?.state, 'alert');
        assert.deepEqual(weekly[0]?.report.clusters.map((c) => [c.id, c.state]), [['c-03', 'under'], ['c-01', 'off']]);
        const alerts = (await db.query<{ rule: string; cluster_ids: string[] }>(
          'SELECT rule, cluster_ids FROM rag_monitor_alerts WHERE tenant_key = $1', [tenant])).rows;
        assert.deepEqual(alerts, [{ rule: 'test_set_not_representative', cluster_ids: ['c-03'] }]);

        for (let g = 0; g < 4; g += 1) await insertLog(db, { userId: owner, orgId: org, topic: g, count: 30, at: lastWeek, label: `d${g}` });
        const result = await drawWeeklySample(admin, { tenantKey: tenant, now: NOW, embed: fakeEmbed, env: ON });
        assert.equal(result.written, true);
        if (!result.written) return;
        assert.equal(result.by_source.drift_fill, 15);
        const fill = (await db.query<{ stratum: string }>(
          "SELECT stratum FROM rag_review_item_strata WHERE tenant_key = $1 AND source = 'drift_fill'", [tenant])).rows;
        assert.equal(fill.length, 15);
        assert.ok(fill.every((row) => row.stratum.startsWith('c-03|')));
      });
    }
  });
}

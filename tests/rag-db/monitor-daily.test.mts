import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { loadMonitorAlertsConfig } from '../../src/lib/rag/monitor/alerts-config.ts';
import { runDaily } from '../../src/lib/rag/monitor/daily.ts';
import { RULE_KIND_REGISTRY, type AlertCandidate, type RuleKindRegistry } from '../../src/lib/rag/monitor/rule-registry.ts';
import { dedupKey } from '../../src/lib/rag/monitor/rules.ts';
import { createPgliteAdmin } from '../helpers/pglite-admin.ts';
import { seedRetrievalLog, type SeedCell, type SeededRow } from '../helpers/retrieval-log-seed.ts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ENV = { RAG_MONITOR: 'true', RAG_RETRIEVAL_LOG: 'ids' };
const NEW_HASH = 'e'.repeat(64);
const DAY5 = '2026-03-05';
const DAY6 = '2026-03-06';
const BASELINE_DAYS = ['2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];

const baseConfig = loadMonitorAlertsConfig();
assert.ok(baseConfig, 'committed monitor config loads');
/** Rate rules only, so a seeded scenario raises exactly the rate alerts it was built for. */
const RATE_CONFIG = { ...baseConfig, rules: baseConfig.rules.filter((rule) => rule.kind === 'rate') };
const CONTEXT_RULE = { id: 'language_drop', kind: 'language_drop', enabled: true, min_sample: 1 } as unknown as (typeof baseConfig.rules)[number];

interface AlertRow {
  id: string;
  tenant_key: string;
  rule: string;
  language: string;
  day: string;
  status: string;
  sample_trace_ids: string[];
  config_changes: Array<Record<string, unknown>>;
  delivered: Record<string, { state: string }>;
}

function tenantKeys(mode: DeploymentMode): { a: string; b: string | null } {
  if (mode === 'single-tenant') return { a: 's:default', b: null };
  return { a: `o:${crypto.randomUUID()}`, b: `u:${crypto.randomUUID()}` };
}

function baseline(tenantKey: string, refused: number, extra: Partial<SeedCell> = {}): SeedCell[] {
  return BASELINE_DAYS.map((day) => ({ tenantKey, day, language: 'it', ragMode: 'strict', channel: 'chat', rows: 25, counts: { refused }, ...extra }));
}

function spike(tenantKey: string, day: string, counts: SeedCell['counts'], extra: Partial<SeedCell> = {}): SeedCell {
  return { tenantKey, day, language: 'it', ragMode: 'strict', channel: 'chat', rows: 100, counts, ...extra };
}

/** A client whose every property access is recorded: the off paths must not touch it. */
function recordingClient(): { client: SupabaseClient; touched: string[] } {
  const touched: string[] = [];
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new Error(`unexpected client access: ${String(property)}`);
      },
    },
  ) as SupabaseClient;
  return { client, touched };
}

async function alerts(db: PGlite): Promise<AlertRow[]> {
  return (
    await db.query<AlertRow>(
      `SELECT id, tenant_key, rule, language, day::text AS day, status, sample_trace_ids, config_changes, delivered
         FROM public.rag_monitor_alerts ORDER BY tenant_key, rule, language`,
    )
  ).rows;
}

test('runDaily with RAG_MONITOR off reads and writes nothing', async () => {
  const { client, touched } = recordingClient();
  const result = await runDaily(client, { source: 'cli', env: { RAG_MONITOR: 'false', RAG_RETRIEVAL_LOG: 'ids' } });
  assert.deepEqual(result, { ran: false, reason: 'switched_off' });
  assert.deepEqual(touched, []);
});

test('runDaily with the retrieval log off writes nothing', async () => {
  const { client, touched } = recordingClient();
  const result = await runDaily(client, { source: 'cli', env: { RAG_MONITOR: 'true', RAG_RETRIEVAL_LOG: 'off' } });
  assert.deepEqual(result, { ran: false, reason: 'log_off' });
  assert.deepEqual(touched, []);
});

for (const mode of MODES) {
  describe(`runDaily on PGlite (${mode})`, () => {
    let db: PGlite;
    let keys: ReturnType<typeof tenantKeys>;
    let admin: SupabaseClient;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      keys = tenantKeys(mode);
      admin = createPgliteAdmin(db) as unknown as SupabaseClient;
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec(`
        DELETE FROM public.rag_monitor_runs;
        DELETE FROM public.rag_monitor_alerts;
        DELETE FROM public.rag_monitor_daily;
        DELETE FROM public.rag_config_change_records;
        DELETE FROM public.rag_online_judge_scores;
        DELETE FROM public.rag_answer_records;
        DELETE FROM public.rag_retrieval_log;
        UPDATE public.embedding_profiles SET activated_at = NULL WHERE activated_at >= '2026-01-01';
      `);
    });

    test('a refusal rise raises one refusal_rate alert for tenant A; a later day updates the same row', async () => {
      const cells: SeedCell[] = [
        ...baseline(keys.a, 3),
        spike(keys.a, DAY5, { refused: 38 }),
        spike(keys.a, DAY6, { refused: 50 }),
      ];
      if (keys.b) cells.push(...baseline(keys.b, 3), spike(keys.b, DAY5, { refused: 12 }), spike(keys.b, DAY6, { refused: 12 }));
      await seedRetrievalLog(db, { seed: `refusal-${mode}`, cells });

      const first = await runDaily(admin, { source: 'cli', env: ENV, now: new Date('2026-03-06T00:30:00Z'), config: RATE_CONFIG, budgets: null });
      assert.equal(first.ran, true);
      let rows = await alerts(db);
      assert.deepEqual(
        rows.map((row) => [row.tenant_key, row.rule, row.language, row.day, row.status]),
        [[keys.a, 'refusal_rate', 'it', DAY5, 'open']],
      );
      const firstId = rows[0]!.id;
      assert.equal(rows[0]!.sample_trace_ids.length, 10);

      const second = await runDaily(admin, { source: 'cli', env: ENV, now: new Date('2026-03-07T00:30:00Z'), config: RATE_CONFIG, budgets: null });
      assert.equal(second.ran && second.alertsUpdated, 1);
      rows = await alerts(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.id, firstId);
      assert.equal(rows[0]!.day, DAY6);

      const runs = await db.query<{ day: string; source: string; alerts_opened: number; alerts_updated: number; groups_checked: number }>(
        'SELECT day::text AS day, source, alerts_opened, alerts_updated, groups_checked FROM public.rag_monitor_runs ORDER BY day',
      );
      assert.deepEqual(
        runs.rows.map((row) => [row.day, row.source, row.alerts_opened, row.alerts_updated]),
        [
          [DAY5, 'cli', 1, 0],
          [DAY6, 'cli', 0, 1],
        ],
      );
      assert.ok(runs.rows.every((row) => row.groups_checked > 0));
    });

    test('a degraded spike lists the change record, the profile activation and the unrecorded hash with degraded sample traces', async () => {
      const cells: SeedCell[] = [...baseline(keys.a, 0), spike(keys.a, DAY5, { degraded: 30 }, { retrievalConfigHash: NEW_HASH })];
      if (keys.b) cells.push(...baseline(keys.b, 0), spike(keys.b, DAY5, { degraded: 30 }));
      const seeded = await seedRetrievalLog(db, { seed: `degraded-${mode}`, cells });
      const recordId = crypto.randomUUID();
      await db.query(
        `INSERT INTO public.rag_config_change_records (id, created_at, actor, source, changed_keys, before_hash, after_hash, gate_result)
         VALUES ($1, '2026-03-04T09:00:00Z', 'local-config-ui', 'config_ui', ARRAY['RAG_RERANKER'], $2, $3, 'pass')`,
        [recordId, '1'.repeat(64), '2'.repeat(64)],
      );
      await db.query("UPDATE public.embedding_profiles SET activated_at = '2026-03-04T10:00:00Z' WHERE id = (SELECT min(id) FROM public.embedding_profiles)");

      const result = await runDaily(admin, { source: 'route', env: ENV, now: new Date('2026-03-06T00:30:00Z'), config: RATE_CONFIG, budgets: null });
      assert.equal(result.ran, true);
      const rows = (await alerts(db)).filter((row) => row.tenant_key === keys.a);
      assert.deepEqual(rows.map((row) => row.rule), ['kb_degraded_rate']);
      const alert = rows[0]!;

      const record = alert.config_changes.find((change) => change.record_id === recordId);
      assert.ok(record, 'the change record of day 4 is listed');
      assert.deepEqual(record.changed_keys, ['RAG_RERANKER']);
      assert.equal(record.source, 'config_ui');
      assert.equal(record.unrecorded, false);

      const activation = alert.config_changes.find((change) => change.source === 'embedding_profile');
      assert.ok(activation, 'the embedding profile activation is listed');
      assert.equal(String(activation.at).slice(0, 10), '2026-03-04');

      const unrecorded = alert.config_changes.find((change) => change.unrecorded === true);
      assert.ok(unrecorded, 'the new hash without a record is listed');
      assert.equal(unrecorded.after_hash, NEW_HASH);
      assert.equal(unrecorded.source, 'retrieval_log');

      const degradedA = new Set(seeded.rows.filter((row: SeededRow) => row.tenantKey === keys.a && row.kind === 'degraded').map((row) => row.traceId));
      assert.equal(alert.sample_trace_ids.length, 10);
      for (const id of alert.sample_trace_ids) assert.ok(degradedA.has(id), `${id} is not a degraded row of tenant A`);

      if (keys.b) {
        const rowsB = (await alerts(db)).filter((row) => row.tenant_key === keys.b);
        assert.deepEqual(rowsB.map((row) => row.rule), ['kb_degraded_rate']);
        assert.ok(!rowsB[0]!.config_changes.some((change) => change.after_hash === NEW_HASH), 'tenant A hash in tenant B alert');
        for (const id of rowsB[0]!.sample_trace_ids) assert.ok(!degradedA.has(id), 'tenant A trace in tenant B alert');
      }
      assert.ok(!JSON.stringify(await alerts(db)).includes('q-'), 'masked query text in an alert row');
    });

    test('run rows and daily cells older than 400 days are purged', async () => {
      await db.query("INSERT INTO public.rag_monitor_runs (ran_at, day, source) VALUES ('2024-01-01T00:00:00Z', '2023-12-31', 'cli')");
      await db.query(
        `INSERT INTO public.rag_monitor_daily (tenant_key, day, language, rag_mode, channel, doc_type, retrievals)
         VALUES ($1, '2024-01-01', 'it', 'strict', 'chat', 'general', 1)`,
        [keys.a],
      );
      const result = await runDaily(admin, { source: 'schedule', env: ENV, now: new Date('2026-03-06T00:30:00Z'), config: RATE_CONFIG, budgets: null });
      assert.equal(result.ran, true);
      const runs = await db.query<{ source: string }>('SELECT source FROM public.rag_monitor_runs');
      assert.deepEqual(runs.rows.map((row) => row.source), ['schedule']);
      const old = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_monitor_daily WHERE day = '2024-01-01'");
      assert.equal(old.rows[0]!.n, 0);
    });

    test('a context-input rule stores its candidates through the same dedup and channels; a throwing one is skipped', async () => {
      const cells: SeedCell[] = [...baseline(keys.a, 3), spike(keys.a, DAY5, { refused: 38 })];
      await seedRetrievalLog(db, { seed: `context-${mode}`, cells });
      const seen: string[][] = [];
      const stub = async (_rule: unknown, ctx: { tenantKeys: readonly string[]; day: string }): Promise<AlertCandidate[]> => {
        seen.push([...ctx.tenantKeys]);
        return [
          {
            tenant_key: keys.a,
            rule: 'language_drop',
            kind: 'language_drop',
            language: 'it',
            day: ctx.day,
            window_days: 1,
            severity: 'warning',
            observed: { count: 1, n: 10, value: 0.1 },
            baseline: null,
            band: {},
            breakdown: {},
            companions: [],
            cluster_ids: [],
            suggestion: null,
            dedup_key: dedupKey(keys.a, 'it', 'language_drop'),
          } as unknown as AlertCandidate,
        ];
      };
      const config = { ...RATE_CONFIG, rules: [...RATE_CONFIG.rules, CONTEXT_RULE] };
      const env = { ...ENV, RAG_MONITOR_WEBHOOK_URL: 'https://hooks.example.invalid/monitor' };
      const registry: RuleKindRegistry = { ...RULE_KIND_REGISTRY, language_drop: { input: 'context', evaluate: stub } };

      const result = await runDaily(admin, { source: 'cli', env, now: new Date('2026-03-06T00:30:00Z'), config, registry, budgets: null });
      assert.equal(result.ran, true);
      assert.deepEqual(seen, [[keys.a]]);
      let rows = await alerts(db);
      assert.deepEqual(rows.map((row) => row.rule).sort(), ['language_drop', 'refusal_rate']);
      for (const row of rows) assert.equal(row.delivered.webhook?.state, 'pending');
      assert.equal(result.ran && result.deliveries, 2);

      await db.exec('DELETE FROM public.rag_monitor_alerts');
      const throwing: RuleKindRegistry = {
        ...RULE_KIND_REGISTRY,
        language_drop: {
          input: 'context',
          evaluate: async () => {
            throw new Error('context evaluator down');
          },
        },
      };
      const failed = await runDaily(admin, { source: 'cli', env, now: new Date('2026-03-06T00:30:00Z'), config, registry: throwing, budgets: null });
      assert.equal(failed.ran && failed.contextRulesFailed.join(','), 'language_drop');
      rows = await alerts(db);
      assert.deepEqual(rows.map((row) => row.rule), ['refusal_rate']);
    });
  });
}

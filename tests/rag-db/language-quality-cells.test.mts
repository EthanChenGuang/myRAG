import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin.ts';
import { seedRetrievalLog, type SeedCell, type SeededRow } from '../helpers/retrieval-log-seed.ts';

process.env.OPENAI_API_KEY ||= 'placeholder-openai-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key';
const { evaluateLanguageDrop, languageDropRuleOf, readLanguageQualityCells, toLanguageQualityCells, LANGUAGE_DROP_RULE_ID } =
  await import('../../src/lib/rag/monitor/language-drop.ts');
const { loadMonitorAlertsConfig } = await import('../../src/lib/rag/monitor/alerts-config.ts');
const { runDaily } = await import('../../src/lib/rag/monitor/daily.ts');

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const CELLS = 'SELECT * FROM public.rag_language_quality_cells($1::timestamptz, $2::timestamptz, $3::text[], $4::real) ORDER BY tenant_key, language';
const WINDOW_DAY = '2026-03-05';
const WINDOW = { since: WINDOW_DAY, until: WINDOW_DAY };
const BASELINE = { since: '2026-02-03', until: '2026-03-04' };
const BASELINE_DAYS = ['2026-02-10', '2026-02-20', '2026-03-01'];
const LANGUAGES = ['zh', 'en', 'it'] as const;
type Lang = (typeof LANGUAGES)[number];

const baseConfig = loadMonitorAlertsConfig();
assert.ok(baseConfig, 'committed monitor config loads');

const MONITOR_RULE = {
  id: 'language_drop',
  kind: 'language_drop',
  enabled: true,
  min_sample: 50,
  baseline_min_sample: 100,
  params: {
    metrics: ['refusal_rate', 'not_helpful_rate'],
    language_band_refusal_rate: 0.05,
    overall_band_refusal_rate: 0.02,
    language_band_not_helpful_rate: 0.1,
    overall_band_not_helpful_rate: 0.05,
    window_days: 1,
  },
} as unknown as (typeof baseConfig.rules)[number];
const RULE = languageDropRuleOf(MONITOR_RULE);
assert.ok(RULE, 'the test rule parses');

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function tenantKeys(mode: DeploymentMode): { a: string; b: string | null; foreign: string } {
  if (mode === 'single-tenant') return { a: 's:default', b: null, foreign: `u:${crypto.randomUUID()}` };
  return { a: `o:${crypto.randomUUID()}`, b: `u:${crypto.randomUUID()}`, foreign: 's:default' };
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

/** Baseline refusal shares per language (100 rows on each of three days) and the window day (100 rows per language). */
function scenario(tenantKey: string, baseline: Record<Lang, number>, window: Record<Lang, number>): SeedCell[] {
  const cells: SeedCell[] = [];
  for (const day of BASELINE_DAYS) {
    for (const language of LANGUAGES) {
      cells.push({ tenantKey, day, language, ragMode: 'strict', channel: 'chat', rows: 100, counts: { refused: baseline[language] } });
    }
  }
  for (const language of LANGUAGES) {
    cells.push({ tenantKey, day: WINDOW_DAY, language, ragMode: 'strict', channel: 'chat', rows: 100, counts: { refused: window[language] } });
  }
  return cells;
}

const DROP = { baseline: { zh: 10, en: 10, it: 20 }, window: { zh: 10, en: 30, it: 0 } };
const STABLE = { baseline: { zh: 10, en: 10, it: 20 }, window: { zh: 10, en: 10, it: 20 } };

for (const mode of MODES) {
  describe(`rag_language_quality_cells 0743 and evaluateLanguageDrop (${mode})`, () => {
    let db: PGlite;
    let admin: SupabaseClient;
    let keys: ReturnType<typeof tenantKeys>;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      admin = createPgliteAdmin(db) as unknown as SupabaseClient;
      keys = tenantKeys(mode);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec(`
        DELETE FROM public.rag_monitor_alerts;
        DELETE FROM public.rag_monitor_daily;
        DO $$ BEGIN IF to_regclass('public.rag_monitor_runs') IS NOT NULL THEN DELETE FROM public.rag_monitor_runs; END IF; END $$;
        DELETE FROM public.rag_online_judge_scores;
        DELETE FROM public.rag_answer_records;
        DELETE FROM public.rag_retrieval_log;
      `);
    });

    async function cells(window: { since: string; until: string }, tenants: string[] | null, minConfidence: number | null = null) {
      return readLanguageQualityCells(admin, { window, tenantKeys: tenants, minConfidence });
    }

    test('TRACER: one language drops while the average holds gives exactly one alert with counts only', async () => {
      const seeded = await seedRetrievalLog(db, { seed: `drop-${mode}`, cells: scenario(keys.a, DROP.baseline, DROP.window) });
      const current = await cells(WINDOW, [keys.a]);
      const baseline = await cells(BASELINE, [keys.a]);
      assert.deepEqual(
        current.map((cell) => [cell.language, cell.retrievals, cell.refused]),
        [['en', 100, 30], ['it', 100, 0], ['zh', 100, 10]],
      );
      const overallNow = current.reduce((s, c) => s + c.refused, 0) / current.reduce((s, c) => s + c.retrievals, 0);
      const overallBefore = baseline.reduce((s, c) => s + c.refused, 0) / baseline.reduce((s, c) => s + c.retrievals, 0);
      assert.ok(Math.abs(overallNow - overallBefore) < 1e-9, 'the overall refusal rate holds');

      const enTraces = seeded.rows.filter((row: SeededRow) => row.createdAt.startsWith(WINDOW_DAY) && row.cellIndex === 10).map((row) => row.traceId);
      const alerts = evaluateLanguageDrop({ current, baseline, rule: RULE!, samples: { en: enTraces } });
      assert.equal(alerts.length, 1);
      const [alert] = alerts;
      assert.deepEqual(
        { ...alert, sample_trace_ids: undefined },
        {
          rule_id: LANGUAGE_DROP_RULE_ID,
          metric: 'refusal_rate',
          language: 'en',
          tenant_key: keys.a,
          events: 30,
          total: 100,
          baseline_events: 30,
          baseline_total: 300,
          window: WINDOW,
          sample_trace_ids: undefined,
        },
      );
      assert.equal(alert!.sample_trace_ids?.length, 10);
      for (const value of Object.values(alert!)) {
        if (typeof value === 'string') assert.match(value, /^[A-Za-z0-9:_.-]+$/);
      }
    });

    test('the same rows pooled over all tenants alert with tenant_key null', async () => {
      await seedRetrievalLog(db, { seed: `pooled-${mode}`, cells: scenario(keys.a, DROP.baseline, DROP.window) });
      const window = { since: WINDOW_DAY, until: WINDOW_DAY };
      const pooled = (w: typeof window) => readLanguageQualityCells(admin, { window: w, tenantKeys: null, pooled: true });
      const alerts = evaluateLanguageDrop({ current: await pooled(window), baseline: await pooled(BASELINE), rule: RULE! });
      assert.deepEqual(alerts.map((a) => [a.language, a.tenant_key]), [['en', null]]);
    });

    test('a fixture where every language holds gives no alert', async () => {
      await seedRetrievalLog(db, { seed: `stable-${mode}`, cells: scenario(keys.a, STABLE.baseline, STABLE.window) });
      const alerts = evaluateLanguageDrop({ current: await cells(WINDOW, [keys.a]), baseline: await cells(BASELINE, [keys.a]), rule: RULE! });
      assert.deepEqual(alerts, []);
    });

    test('the daily job raises the language_drop alert for the dropping language only (average holds)', async () => {
      await seedRetrievalLog(db, { seed: `job-${mode}`, cells: scenario(keys.a, DROP.baseline, DROP.window) });
      const result = await runDaily(admin, {
        source: 'cli',
        env: { RAG_MONITOR: 'true', RAG_RETRIEVAL_LOG: 'ids' },
        now: new Date('2026-03-06T00:30:00Z'),
        config: { ...baseConfig, rules: [MONITOR_RULE] },
        budgets: null,
      });
      assert.equal(result.ran, true);
      assert.deepEqual(result.ran && result.contextRulesFailed, []);
      const rows = (
        await db.query<{ tenant_key: string; rule: string; kind: string; language: string; observed_count: number; observed_total: number; sample_trace_ids: string[] }>(
          'SELECT tenant_key, rule, kind, language, observed_count, observed_total, sample_trace_ids FROM public.rag_monitor_alerts',
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0]!.tenant_key, rows[0]!.rule, rows[0]!.kind, rows[0]!.language], [keys.a, 'language_drop', 'language_drop', 'en']);
      assert.deepEqual([Number(rows[0]!.observed_count), Number(rows[0]!.observed_total)], [30, 100]);
      assert.ok(rows[0]!.sample_trace_ids.length > 0 && rows[0]!.sample_trace_ids.length <= 10);
    });

    test('counts outcomes and answer or embed votes; a row without a language or below the confidence floor is und', async () => {
      await seedRetrievalLog(db, {
        seed: `counts-${mode}`,
        cells: [
          { tenantKey: keys.a, day: WINDOW_DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 20, counts: { refused: 3, error: 4, kbUnavailable: 2, helpful: 5, notHelpful: 3 } },
          { tenantKey: keys.a, day: WINDOW_DAY, language: null, ragMode: 'strict', channel: 'chat', rows: 4 },
        ],
      });
      await db.exec(`UPDATE public.rag_retrieval_log SET query_language_confidence = 1 WHERE query_language = 'en'`);
      await db.exec(`UPDATE public.rag_retrieval_log SET query_language_confidence = 0.5
                      WHERE trace_id IN (SELECT trace_id FROM public.rag_retrieval_log WHERE query_language = 'en' ORDER BY trace_id LIMIT 6)`);
      await db.exec(`UPDATE public.rag_retrieval_log SET feedback_kind = 'refusal'
                      WHERE trace_id IN (SELECT trace_id FROM public.rag_retrieval_log WHERE feedback_vote = 1 ORDER BY trace_id LIMIT 1)`);
      const plain = await cells(WINDOW, [keys.a]);
      assert.deepEqual(
        plain.map((c) => [c.language, c.retrievals, c.refused, c.kb_unavailable, c.votes_up, c.votes_down, c.low_confidence]),
        [['en', 20, 3, 2, 4, 3, 6], ['und', 4, 0, 0, 0, 0, 0]],
      );
      const floored = await cells(WINDOW, [keys.a], 0.75);
      assert.deepEqual(floored.map((c) => [c.language, c.retrievals, c.low_confidence]), [['en', 14, 0], ['und', 10, 6]]);
    });

    test('anon and authenticated get 42501 on the function', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        await assert.rejects(
          asRole(db, role, () => db.query(CELLS, ['2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', [keys.a], null])),
          (error: unknown) => codeOf(error) === '42501',
        );
      }
    });

    test('rejects a malformed or other-mode tenant key and a bad window with 22023', async () => {
      for (const key of ['not-a-key', keys.foreign]) {
        await assert.rejects(db.query(CELLS, ['2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', [key], null]), (error: unknown) => codeOf(error) === '22023');
      }
      await assert.rejects(db.query(CELLS, ['2026-03-06T00:00:00Z', '2026-03-05T00:00:00Z', null, null]), (error: unknown) => codeOf(error) === '22023');
      await assert.rejects(db.query(CELLS, ['2025-01-01T00:00:00Z', '2026-03-05T00:00:00Z', null, null]), (error: unknown) => codeOf(error) === '22023');
    });

    test('a tenant list never returns another tenant`s rows', { skip: mode === 'single-tenant' }, async () => {
      await seedRetrievalLog(db, {
        seed: `iso-${mode}`,
        cells: [
          { tenantKey: keys.a, day: WINDOW_DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 5 },
          { tenantKey: keys.b!, day: WINDOW_DAY, language: 'en', ragMode: 'strict', channel: 'chat', rows: 7, counts: { refused: 7 } },
        ],
      });
      const onlyA = await cells(WINDOW, [keys.a]);
      assert.deepEqual(onlyA.map((c) => [c.tenant_key, c.retrievals, c.refused]), [[keys.a, 5, 0]]);
      const all = toLanguageQualityCells(
        (await db.query(CELLS, ['2026-03-05T00:00:00Z', '2026-03-06T00:00:00Z', null, null])).rows as never,
        WINDOW,
      );
      assert.deepEqual(all.map((c) => c.tenant_key).sort(), [keys.a, keys.b].sort());
    });
  });
}

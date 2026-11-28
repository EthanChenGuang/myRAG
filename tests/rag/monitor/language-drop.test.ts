import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LanguageQualityCell } from '@/lib/rag-eval/contracts.generated';
import { loadMonitorAlertsConfig } from '@/lib/rag/monitor/alerts-config';
import { runDaily } from '@/lib/rag/monitor/daily';
import { deliverAlerts, fromAlertRow } from '@/lib/rag/monitor/deliver';
import {
  evaluateLanguageDrop,
  evaluateLanguageJudgeDrop,
  LANGUAGE_DROP_RULE_ID,
  languageDropRuleOf,
  readLanguageQualityCells,
  type LanguageDropRule,
  type LanguageJudgeCell,
} from '@/lib/rag/monitor/language-drop';
import { registryEntryFor } from '@/lib/rag/monitor/rule-registry';
import { createEmptyFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { createPgliteAdmin } from '../../helpers/pglite-admin';
import { seedRetrievalLog, type SeedCell } from '../../helpers/retrieval-log-seed';

const TENANT = 's:default';
const WINDOW_DAY = '2026-03-05';
const BASELINE_DAYS = ['2026-02-10', '2026-02-20', '2026-03-01'];
const LANGUAGES = ['zh', 'en', 'it'] as const;
type Lang = (typeof LANGUAGES)[number];
const SAFE = /^[A-Za-z0-9:_.|@/+-]+$/;

const committed = loadMonitorAlertsConfig();
const committedRule = committed?.rules.find((rule) => rule.id === LANGUAGE_DROP_RULE_ID);

function scenario(baseline: Record<Lang, number>, window: Record<Lang, number>): SeedCell[] {
  const cells: SeedCell[] = [];
  for (const day of BASELINE_DAYS) {
    for (const language of LANGUAGES) {
      cells.push({ tenantKey: TENANT, day, language, ragMode: 'strict', channel: 'chat', rows: 100, counts: { refused: baseline[language] } });
    }
  }
  for (const language of LANGUAGES) {
    cells.push({ tenantKey: TENANT, day: WINDOW_DAY, language, ragMode: 'strict', channel: 'chat', rows: 100, counts: { refused: window[language] } });
  }
  return cells;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

describe('the language_drop rule of the OBS-03 daily job', () => {
  let db: PGlite;
  let admin: SupabaseClient;

  beforeAll(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    admin = createPgliteAdmin(db) as unknown as SupabaseClient;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await db.exec(`
      DELETE FROM public.rag_monitor_alerts;
      DELETE FROM public.rag_monitor_daily;
      DO $$ BEGIN IF to_regclass('public.rag_monitor_runs') IS NOT NULL THEN DELETE FROM public.rag_monitor_runs; END IF; END $$;
      DELETE FROM public.rag_retrieval_log;
    `);
  });

  it('is committed in eval/config/monitor-alerts.json and registered as a context entry', () => {
    expect(committedRule).toBeDefined();
    expect(committedRule?.kind).toBe('language_drop');
    expect(registryEntryFor('language_drop')?.input).toBe('context');
    const rule = languageDropRuleOf(committedRule!);
    expect(rule?.metrics).toEqual(['refusal_rate', 'not_helpful_rate', 'judge_mean']);
  });

  it('raises one language_drop alert through a fake channel; the payload is the LanguageDropAlert counts and no text', async () => {
    expect(committed && committedRule).toBeTruthy();
    await seedRetrievalLog(db, { seed: 'job-channel', cells: scenario({ zh: 10, en: 10, it: 20 }, { zh: 10, en: 30, it: 0 }) });
    const result = await runDaily(admin, {
      source: 'cli',
      env: { RAG_MONITOR: 'true', RAG_RETRIEVAL_LOG: 'ids' },
      now: new Date('2026-03-06T00:30:00Z'),
      config: committed!,
      budgets: null,
    });
    expect(result.ran && result.contextRulesFailed).toEqual([]);

    const rows = (await db.query<Record<string, unknown>>(`SELECT * FROM public.rag_monitor_alerts WHERE rule = 'language_drop'`)).rows;
    expect(rows).toHaveLength(1);
    const alert = fromAlertRow(rows[0]!);
    expect(alert).not.toBeNull();

    const rule = languageDropRuleOf(committedRule!)!;
    const window = { since: WINDOW_DAY, until: WINDOW_DAY };
    const baselineWindow = { since: '2026-02-03', until: '2026-03-04' };
    const [expected] = evaluateLanguageDrop({
      current: await readLanguageQualityCells(admin, { window, tenantKeys: [TENANT] }),
      baseline: await readLanguageQualityCells(admin, { window: baselineWindow, tenantKeys: [TENANT] }),
      rule,
    });
    expect(expected).toBeDefined();

    const sent: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const [report] = await deliverAlerts([alert!], {
      settings: { monitor: true, webhookUrl: 'https://alerts.example.invalid/hook', webhookSecret: null, configGate: 'off', configGateLive: false, representativeSample: false },
      fetch: fakeFetch,
      lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
      langfuse: { enabled: false } as never,
    });
    expect(report?.delivered.webhook?.state).toBe('delivered');
    expect(sent).toHaveLength(1);
    const payload = sent[0]!;
    expect(payload).toMatchObject({
      tenant_key: TENANT,
      rule: 'language_drop',
      kind: 'language_drop',
      language: expected!.language,
      observed: { count: expected!.events, n: expected!.total },
      baseline: { count: expected!.baseline_events, n: expected!.baseline_total },
    });
    expect(expected!.metric).toBe('refusal_rate');
    expect((payload.sample_trace_ids as string[]).length).toBeLessThanOrEqual(10);
    for (const value of strings(payload)) expect(value).toMatch(SAFE);
  }, 120_000);

  it('does nothing with RAG_MONITOR off', async () => {
    const touched: string[] = [];
    const client = new Proxy({}, { get: (_t, p) => { touched.push(String(p)); throw new Error('unexpected access'); } }) as SupabaseClient;
    const result = await runDaily(client, { source: 'cli', env: { RAG_MONITOR: 'false', RAG_RETRIEVAL_LOG: 'ids' }, config: committed! });
    expect(result).toEqual({ ran: false, reason: 'switched_off' });
    expect(touched).toEqual([]);
  });
});

const RULE: LanguageDropRule = {
  id: 'language_drop',
  metrics: ['refusal_rate', 'not_helpful_rate', 'judge_mean'],
  minSample: 50,
  baselineMinSample: 100,
  bands: {
    refusal_rate: { language: 0.05, overall: 0.02 },
    not_helpful_rate: { language: 0.1, overall: 0.05 },
    judge_mean: { language: 0.1, overall: 0.05 },
  },
  windowDays: 1,
  minConfidence: null,
};

function cell(language: string, retrievals: number, refused: number, window = { since: WINDOW_DAY, until: WINDOW_DAY }, votes = { up: 0, down: 0 }): LanguageQualityCell {
  return { tenant_key: TENANT, language, window, retrievals, refused, kb_unavailable: 0, votes_up: votes.up, votes_down: votes.down, low_confidence: 0 };
}

const BASE_WINDOW = { since: '2026-02-03', until: '2026-03-04' };
const baseline = [cell('zh', 300, 30, BASE_WINDOW), cell('en', 300, 30, BASE_WINDOW), cell('it', 300, 60, BASE_WINDOW)];

describe('evaluateLanguageDrop', () => {
  it('alerts the language that drops while the overall average holds, with ids and counts', () => {
    const current = [cell('zh', 100, 10), cell('en', 100, 30), cell('it', 100, 0)];
    const alerts = evaluateLanguageDrop({ current, baseline, rule: RULE });
    expect(alerts.map((a) => [a.language, a.metric, a.events, a.total, a.baseline_events, a.baseline_total])).toEqual([['en', 'refusal_rate', 30, 100, 30, 300]]);
  });

  it('gives no alert when the minimum sample is not met in the window or the baseline', () => {
    const small = [cell('zh', 100, 10), cell('en', 40, 12), cell('it', 100, 8)];
    expect(evaluateLanguageDrop({ current: small, baseline, rule: RULE })).toEqual([]);
    const thinBaseline = [cell('zh', 300, 30, BASE_WINDOW), cell('en', 90, 9, BASE_WINDOW), cell('it', 300, 60, BASE_WINDOW)];
    expect(evaluateLanguageDrop({ current: [cell('zh', 100, 10), cell('en', 100, 30), cell('it', 100, 0)], baseline: thinBaseline, rule: RULE })).toEqual([]);
  });

  it('gives no language_drop alert when the overall average drops too', () => {
    const current = [cell('zh', 100, 10), cell('en', 100, 30), cell('it', 100, 20)];
    expect(evaluateLanguageDrop({ current, baseline, rule: RULE })).toEqual([]);
  });

  it('compares each language with its own baseline, not with the overall average', () => {
    // it sits above the overall rate in both windows but holds its own rate: no alert
    const current = [cell('zh', 100, 10), cell('en', 100, 10), cell('it', 100, 20)];
    expect(evaluateLanguageDrop({ current, baseline, rule: RULE })).toEqual([]);
  });

  it('measures the not-helpful vote rate over answer votes', () => {
    const votesBaseline = [cell('zh', 300, 30, BASE_WINDOW, { up: 90, down: 10 }), cell('en', 300, 30, BASE_WINDOW, { up: 90, down: 10 }), cell('it', 300, 60, BASE_WINDOW, { up: 60, down: 40 })];
    const current = [cell('zh', 100, 10, undefined, { up: 54, down: 6 }), cell('en', 100, 10, undefined, { up: 36, down: 24 }), cell('it', 100, 20, undefined, { up: 54, down: 6 })];
    const alerts = evaluateLanguageDrop({ current, baseline: votesBaseline, rule: { ...RULE, minSample: 50, baselineMinSample: 100 } });
    expect(alerts.map((a) => [a.language, a.metric, a.events, a.total])).toEqual([['en', 'not_helpful_rate', 24, 60]]);
  });

  it('caps sample trace ids at 10 and never alerts und', () => {
    const current = [cell('zh', 100, 10), cell('en', 100, 30), cell('it', 100, 0), cell('und', 100, 90)];
    const und = [...baseline, cell('und', 300, 270, BASE_WINDOW)];
    const ids = Array.from({ length: 25 }, (_, i) => `trace-${i}`);
    const alerts = evaluateLanguageDrop({ current, baseline: und, rule: RULE, samples: { en: ids } });
    expect(alerts.map((a) => a.language)).toEqual(['en']);
    expect(alerts[0]!.sample_trace_ids).toEqual(ids.slice(0, 10));
  });
});

describe('evaluateLanguageJudgeDrop', () => {
  const judge = (language: string, judged: number, mean: number): LanguageJudgeCell => ({
    tenant_key: TENANT,
    language,
    judged,
    score_sums: { faithfulness: judged * mean, answer_relevance: judged * mean },
  });

  it('alerts a judge-score drop of one language while the overall mean holds', () => {
    const before = [judge('zh', 200, 0.8), judge('en', 200, 0.8), judge('it', 200, 0.6)];
    const now = [judge('zh', 60, 0.8), judge('en', 60, 0.6), judge('it', 60, 0.8)];
    const drops = evaluateLanguageJudgeDrop({ current: now, baseline: before, rule: RULE });
    expect(drops.map((d) => [d.language, d.metric, d.n, d.baseline_n])).toEqual([['en', 'judge_mean', 60, 200]]);
    expect(drops[0]!.mean).toBeCloseTo(0.6);
    expect(drops[0]!.baseline_mean).toBeCloseTo(0.8);
  });

  it('gives no alert when the overall judge mean drops too', () => {
    const before = [judge('zh', 200, 0.8), judge('en', 200, 0.8), judge('it', 200, 0.8)];
    const now = [judge('zh', 60, 0.8), judge('en', 60, 0.5), judge('it', 60, 0.7)];
    expect(evaluateLanguageJudgeDrop({ current: now, baseline: before, rule: RULE })).toEqual([]);
  });
});

describe('languageDropRuleOf', () => {
  it('refuses unknown metrics and missing bands', () => {
    const base = { id: 'language_drop', kind: 'language_drop', enabled: true, min_sample: 50 } as const;
    expect(languageDropRuleOf({ ...base, params: { metrics: ['refusal_rate', 'unknown_rate'], language_band_refusal_rate: 0.1, overall_band_refusal_rate: 0.1 } } as never)).toBeNull();
    expect(languageDropRuleOf({ ...base, params: { metrics: ['refusal_rate'], language_band_refusal_rate: 0.1 } } as never)).toBeNull();
    expect(languageDropRuleOf({ ...base, params: {} } as never)).toBeNull();
  });
});

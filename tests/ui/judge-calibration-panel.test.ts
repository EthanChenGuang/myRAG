import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { judgeCalibrationStatus } from '@/lib/rag/judge/calibration-status';
import { FakeDocument, FakeElement, FakeText, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type FetchResult = { ok: boolean; status: number; body?: unknown };
type Fetcher = (path: string, init?: { method?: string }) => Promise<FetchResult>;

interface JudgeCal {
  JUDGE_CAL_LABELS: Record<Locale, Record<string, string>>;
  judgeCalLabel: (key: string, locale: Locale, vars?: Record<string, unknown>) => string;
  judgeCalRows: (status: unknown, locale: Locale) => Array<{
    role: string;
    title: string;
    version: { short: string; full: string } | null;
    rows: Array<Record<string, unknown> & { reasons: Array<{ text: string }>; kappa: { text: string; flagged: boolean }; accuracy: { text: string; flagged: boolean } }>;
  }>;
  judgeCalWarningView: (warning: unknown, locale: Locale) => { tone: string; icon: string; text: string; lang?: string };
  JudgeCalPanel: new (root: unknown, deps: { fetcher: Fetcher; locale?: Locale; appUrl?: string }) => { mount: () => Promise<void>; load: () => Promise<void> };
  initJudgeCalPanel: () => void;
}

function load(): JudgeCal {
  return require('../../scripts/config-ui/rag-panels/judge-calibration.js') as JudgeCal;
}

function text(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const XSS = '<img src=x onerror=alert(1)>';
const FP_NIGHTLY = 'a1b2c3d4'.padEnd(64, '0');
const FP_ONLINE = 'e5f6a7b8'.padEnd(64, '1');
const GATES = JSON.parse(fs.readFileSync('eval/config/quality-gates.json', 'utf8'));
const TODAY = new Date('2026-11-20T00:00:00Z');

function cell(role: 'nightly' | 'online', language: 'zh' | 'en' | 'it', metric: string, extra: Record<string, unknown> = {}) {
  const fp = role === 'nightly' ? FP_NIGHTLY : FP_ONLINE;
  return {
    key: `${fp}|${role}|${language}|deepeval.${metric}`,
    role,
    language,
    library: 'deepeval',
    metric,
    fingerprint: fp,
    status: 'gating',
    reasons: [],
    kappa: 0.71,
    accuracy: 0.88,
    n: 120,
    source: 'review_queue',
    labels_human_confirmed: true,
    unsupported_recall: 0.91,
    unsupported_precision: 0.84,
    length_bias_delta: 0.03,
    expanded_delta: 0.02,
    assertive_delta: 0.04,
    recorded_at: '2026-11-03',
    ...extra,
  };
}

function statusOf(cells: unknown[]) {
  const calibration = { schema_version: 1, provenance: { source: 'calibration' }, running_fingerprints: { nightly: FP_NIGHTLY, online: FP_ONLINE }, cells };
  return JSON.parse(JSON.stringify({ success: true, ...judgeCalibrationStatus(calibration, GATES, TODAY) })) as Record<string, unknown>;
}

const MIXED = () =>
  statusOf([
    cell('nightly', 'it', 'faithfulness', { status: 'report_only', reasons: ['kappa_below_floor', 'labels_not_confirmed'], kappa: 0.48, accuracy: 0.79, n: 52, source: 'seed', labels_human_confirmed: false }),
    cell('nightly', 'en', 'faithfulness'),
    cell('nightly', 'zh', 'answer_relevance', { kappa: 0.55 }),
    cell('online', 'en', 'partial_answer', { recorded_at: '2026-09-01' }),
  ]);

function panelRoot(doc: FakeDocument): FakeElement {
  const root = doc.createElement('section');
  root.id = 'rag-administration-judge';
  for (const attr of ['data-judge-cal-title', 'data-judge-cal-description', 'data-judge-cal-alert', 'data-judge-cal-content', 'data-judge-cal-status']) {
    const el = doc.createElement(attr === 'data-judge-cal-title' ? 'h3' : 'div');
    el.setAttribute(attr, '');
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  return root;
}

async function withDoc<T>(fn: (doc: FakeDocument) => Promise<T>): Promise<T> {
  const doc = new FakeDocument();
  const holder = globalThis as unknown as { document?: unknown };
  const previous = holder.document;
  holder.document = doc;
  try {
    return await fn(doc);
  } finally {
    holder.document = previous;
  }
}

function fakeFetcher(result: FetchResult) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    return result;
  };
  return { fetcher, calls };
}

describe('JUDGE_CAL_LABELS', () => {
  it('has the same keys in en, zh and it', () => {
    const { JUDGE_CAL_LABELS } = load();
    const en = Object.keys(JUDGE_CAL_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(45);
    expect(Object.keys(JUDGE_CAL_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(JUDGE_CAL_LABELS.it).sort()).toEqual(en);
  });

  it('holds the UI-SPEC 12.5 words', () => {
    const { judgeCalLabel } = load();
    expect(judgeCalLabel('status.gating', 'en')).toBe('Enforced');
    expect(judgeCalLabel('status.uncalibrated', 'en')).toBe('Out of date');
    expect(judgeCalLabel('empty.title', 'zh')).toBe('尚无评判模型校准');
  });
});

describe('judgeCalRows', () => {
  it('one table per role, languages zh, en, it, statuses as words with reasons as sentences', () => {
    const { judgeCalRows } = load();
    const roles = judgeCalRows(MIXED(), 'en');
    expect(roles.map((r) => r.role)).toEqual(['nightly', 'online']);
    expect(roles[0].title).toBe('Nightly judge');
    expect(roles[0].version).toEqual({ short: 'a1b2c3d4', full: FP_NIGHTLY });
    expect(roles[0].rows.map((r) => r.languageName)).toEqual(['Chinese', 'English', 'Italian']);
    const italian = roles[0].rows[2];
    expect(italian.statusLabel).toBe('Report only');
    expect(italian.reasons.map((r) => r.text)).toEqual(['Agreement (kappa) is below the floor.', 'The labels are not yet confirmed by a person.']);
    expect(roles[0].rows[1].statusLabel).toBe('Enforced');
    const online = roles[1].rows[0];
    expect(online.statusLabel).toBe('Out of date');
    expect(online.reasons.map((r) => r.text)).toEqual(['Last checked more than 35 days ago.']);
    expect(online.measure).toBe('Partial answer');
  });

  it('flags a kappa only when the server names it in a reason; the browser compares nothing', () => {
    const { judgeCalRows } = load();
    const roles = judgeCalRows(MIXED(), 'en');
    expect(roles[0].rows[2].kappa).toEqual({ text: '0.48', flagged: true });
    expect(roles[0].rows[0].kappa).toEqual({ text: '0.55', flagged: false });
    expect(roles[0].rows[2].accuracy.flagged).toBe(false);
  });

  it('a changed judge reads Out of date with the fingerprint reason', () => {
    const { judgeCalRows } = load();
    const status = statusOf([cell('nightly', 'en', 'faithfulness', { fingerprint: 'f'.repeat(64), key: `${'f'.repeat(64)}|nightly|en|deepeval.faithfulness` })]);
    const row = judgeCalRows(status, 'en')[0].rows[0];
    expect(row.statusLabel).toBe('Out of date');
    expect(row.reasons.map((r) => r.text)).toContain('The judge model, prompt or rubric changed since this check.');
  });

  it('an unknown reason code is shown as a code in a sentence', () => {
    const { judgeCalRows } = load();
    const status = MIXED();
    ((status.cells as Array<Record<string, unknown>>)[0].reasons as string[]).push('brand_new_reason');
    const reasons = judgeCalRows(status, 'en')[0].rows[0].reasons.map((r) => r.text);
    expect(reasons).toContain('Reason code: brand_new_reason.');
  });
});

describe('judgeCalWarningView', () => {
  it('none_enforced is an info alert, calibration_invalid an error, the rest warnings; unknown codes use the route message in English', () => {
    const { judgeCalWarningView } = load();
    expect(judgeCalWarningView({ code: 'none_enforced', message: 'x' }, 'en')).toMatchObject({ tone: 'info', icon: 'bi-info-circle' });
    expect(judgeCalWarningView({ code: 'calibration_invalid', message: 'x' }, 'en')).toMatchObject({ tone: 'error' });
    expect(judgeCalWarningView({ code: 'expired_cells', count: 2, days: 35, keys: [], message: 'x' }, 'en')).toMatchObject({
      tone: 'warning',
      text: 'Calibrations older than 35 days: 2. They are report only until python -m rag_eval.judge_calibration run runs again.',
    });
    expect(judgeCalWarningView({ code: 'judge_changed', roles: ['nightly'], keys: [], message: 'x' }, 'en').tone).toBe('warning');
    expect(judgeCalWarningView({ code: 'new_code', message: 'Route message.' }, 'zh')).toMatchObject({ text: 'Route message.', lang: 'en' });
  });
});

describe('JudgeCalPanel', () => {
  it('is read-only: one GET, one Refresh status button, one details legend, no input control', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const { fetcher, calls } = fakeFetcher({ ok: true, status: 200, body: MIXED() });
      const root = panelRoot(doc);
      await new JudgeCalPanel(root, { fetcher, locale: 'en' }).mount();
      expect(calls).toEqual(['GET /api/rag/admin/judge-calibration']);
      for (const tag of ['input', 'select', 'textarea']) expect(root.querySelectorAll(tag)).toHaveLength(0);
      expect(root.querySelectorAll('[contenteditable]')).toHaveLength(0);
      expect(root.querySelectorAll('button').map((b) => text(b).trim())).toEqual(['Refresh status']);
      const legends = root.querySelectorAll('details').filter((d) => text(d.querySelector('summary') as FakeElement) === 'What the statuses mean');
      expect(legends).toHaveLength(1);
      const all = text(root);
      expect(all).toContain('Needed to be enforced: kappa at least 0.60, accuracy at least 0.80, labels at least 100 per language (50 from the starter set), checked within the last 35 days.');
      expect(all).toContain('Whole-answer scores on a 1 to 5 scale are reported and never count towards a limit.');
      expect(all).toContain('Judge version: a1b2c3d4');
      expect(all).not.toContain(FP_NIGHTLY);
      expect(all).not.toContain(`${FP_NIGHTLY}|`);
      expect(root.querySelectorAll('table')).toHaveLength(2);
      expect(root.getAttribute('lang')).toBe('en');
      expect(text(root.querySelector('[data-judge-cal-status]') as FakeElement)).toBe('Judge calibration loaded. Rows: 4. Enforced: 2.');
    });
  });

  it('a kappa named by kappa_below_floor carries the warning icon and the screen-reader phrase', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const root = panelRoot(doc);
      await new JudgeCalPanel(root, { fetcher: fakeFetcher({ ok: true, status: 200, body: MIXED() }).fetcher, locale: 'en' }).mount();
      const flagged = root.querySelectorAll('.bi-exclamation-triangle').filter((i) => i.parentNode?.tagName === 'td');
      expect(flagged).toHaveLength(1);
      expect(text(flagged[0].parentNode as FakeElement)).toContain('Named in the reasons below');
      expect(text(flagged[0].parentNode as FakeElement)).toContain('0.48');
    });
  });

  it('the version cell keeps the full fingerprint in the title only', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const root = panelRoot(doc);
      await new JudgeCalPanel(root, { fetcher: fakeFetcher({ ok: true, status: 200, body: MIXED() }).fetcher, locale: 'en' }).mount();
      const titled = root.querySelectorAll('[title]').map((el) => el.getAttribute('title'));
      expect(titled).toContain(FP_NIGHTLY);
    });
  });

  it('hides the wide columns below 1024px and Checked below 768px', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const root = panelRoot(doc);
      await new JudgeCalPanel(root, { fetcher: fakeFetcher({ ok: true, status: 200, body: MIXED() }).fetcher, locale: 'en' }).mount();
      const heads = (root.querySelector('table') as FakeElement).querySelectorAll('th[scope="col"]');
      const cls = (label: string) => heads.find((h) => text(h) === label)?.className ?? '';
      for (const label of ['Unsupported content found', 'Length bias', 'Same answer, reworded']) expect(cls(label)).toContain('hidden lg:table-cell');
      expect(cls('Checked')).toContain('hidden md:table-cell');
      for (const label of ['Language', 'Measure', 'Status', 'Kappa', 'Accuracy', 'Labels']) expect(cls(label)).not.toContain('hidden');
      expect(root.querySelectorAll('details.lg\\:hidden').length).toBeGreaterThan(0);
    });
  });

  it('with no cells shows the empty title and body and still the floors line; none_enforced is an info alert', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const root = panelRoot(doc);
      await new JudgeCalPanel(root, { fetcher: fakeFetcher({ ok: true, status: 200, body: statusOf([]) }).fetcher, locale: 'en' }).mount();
      const all = text(root);
      expect(all).toContain('No judge calibration yet');
      expect(all).toContain('Until a calibration is recorded, every judge score is report only and no limit depends on a judge.');
      expect(all).toContain('Needed to be enforced: kappa at least 0.60');
      expect(root.querySelectorAll('table')).toHaveLength(0);
      expect(root.querySelector('.alert-info')).not.toBeNull();
      expect(root.querySelector('code')?.textContent).toBe('python -m rag_eval.judge_calibration run');
    });
  });

  it('401 replaces the content with the sign-in message and Reload panel', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const root = panelRoot(doc);
      await new JudgeCalPanel(root, { fetcher: fakeFetcher({ ok: false, status: 401, body: {} }).fetcher, locale: 'en', appUrl: 'http://app.example' }).mount();
      const alert = root.querySelector('[data-judge-cal-alert]') as FakeElement;
      expect(text(alert)).toContain('http://app.example');
      expect(alert.querySelector('.alert-warning')).not.toBeNull();
      expect(alert.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Reload panel']);
      expect((root.querySelector('[data-judge-cal-content]') as FakeElement).hidden).toBe(true);
    });
  });

  it('500 after a good load keeps the earlier content dimmed with error.unavailable', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const root = panelRoot(doc);
      let result: FetchResult = { ok: true, status: 200, body: MIXED() };
      const panel = new JudgeCalPanel(root, { fetcher: async () => result, locale: 'en' });
      await panel.mount();
      result = { ok: false, status: 500, body: { error: 'judge_calibration_status_unavailable' } };
      await panel.load();
      expect(text(root.querySelector('[data-judge-cal-alert]') as FakeElement)).toContain('Judge calibration is unavailable right now. Select Reload panel in a moment.');
      expect(root.querySelectorAll('table')).toHaveLength(2);
      expect(root.querySelectorAll('.opacity-60').length).toBeGreaterThan(0);
    });
  });

  it('markup in a metric name, reason code and warning message is inserted as text', async () => {
    await withDoc(async (doc) => {
      const { JudgeCalPanel } = load();
      const status = MIXED();
      const cells = status.cells as Array<Record<string, unknown>>;
      cells[0].metric = XSS;
      (cells[0].reasons as string[]).push(XSS);
      (status.warnings as Array<Record<string, unknown>>).push({ code: XSS, message: XSS });
      const root = panelRoot(doc);
      doc.created = [];
      await new JudgeCalPanel(root, { fetcher: fakeFetcher({ ok: true, status: 200, body: status }).fetcher, locale: 'en' }).mount();
      expect(doc.created).not.toContain('img');
      expect(root.querySelectorAll('img')).toHaveLength(0);
      expect(doc.innerHtmlWrites).toBe(0);
      expect(text(root)).toContain(XSS);
    });
  });
});

describe('binding and index.html skeleton', () => {
  const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

  it('the section follows the Refusal calibration panel with heading, description, alert, content and status hosts', () => {
    const refusal = html.indexOf('id="rag-administration-refusal"');
    const judge = html.indexOf('id="rag-administration-judge"');
    expect(refusal).toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(refusal);
    const section = html.slice(judge, html.indexOf('</section>', judge));
    expect(section).toMatch(/<h3[^>]*tabindex="-1"[^>]*data-judge-cal-title/);
    for (const attr of ['data-judge-cal-description', 'data-judge-cal-alert', 'data-judge-cal-content']) expect(section).toContain(attr);
    expect(section).toMatch(/data-judge-cal-status[^>]*role="status"[^>]*aria-live="polite"/);
  });

  it('loads judge-calibration.js after gates-ui.js', () => {
    expect(html).toMatch(/<script src="rag-panels\/gates-ui\.js"><\/script>\s*<script src="rag-panels\/judge-calibration\.js"><\/script>/);
  });

  it('binds every RAG administration link', () => {
    const source = fs.readFileSync('scripts/config-ui/rag-panels/judge-calibration.js', 'utf8');
    expect(source).toMatch(/querySelectorAll\('\[data-tab="rag-administration"\]'\)/);
  });
});

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type FetchResult = { ok: boolean; status: number; body?: unknown };
type FetchInit = { method?: string; body?: string };
type Fetcher = (path: string, init?: FetchInit) => Promise<FetchResult>;

interface Segment {
  text?: string;
  code?: string;
}
interface Message {
  key: string;
  text: string;
  segments: Segment[];
}
interface Badge {
  key: string;
  label: string;
  tone: string;
  icon: string;
}
interface CoverageView {
  empty: boolean;
  emptyTitle?: string;
  emptyBody?: Message;
  week?: { label: string; text: string; iso: string | null };
  divergence?: { text: string; badge: Badge | null };
  limits?: Message;
  trend?: Array<{ week: string; text: string; current: boolean; missing: boolean; divergence: string; badge: Badge | null }>;
  groups?: Array<{
    id: string;
    name: string;
    novel: boolean;
    production: { text: string; bar: number };
    test: { text: string; bar: number };
    items: string;
    badge: Badge | null;
  }>;
  scores?: Array<{ key: string; label: string; text: string }> | null;
  gaps?: { rows: Array<{ slice: string; offline: string; online: string; gap: string; badge: Badge | null }>; help: Message } | null;
  rates?: { columns: Array<{ key: string; label: string }>; rows: Array<{ slice: string; cells: string[] }> } | null;
}

interface Monitor {
  MONITOR_LABELS: Record<Locale, Record<string, string>>;
  monitorCoverageView: (report: unknown, locale: Locale) => CoverageView;
  MonitorPanel: new (
    root: unknown,
    deps: { fetcher: Fetcher; locale?: Locale; config?: () => Record<string, string> },
  ) => { mount: () => Promise<void>; selectTab: (id: string) => Promise<void> };
}

function load(): Monitor {
  return require('../../scripts/config-ui/rag-panels/monitor.js') as Monitor;
}

function coverageView(report: unknown, locale: Locale = 'en'): CoverageView {
  const { monitorCoverageView } = load();
  expect(typeof monitorCoverageView, 'monitorCoverageView is exported').toBe('function');
  return monitorCoverageView(report, locale);
}

function text(node: FakeNode | null | undefined): string {
  if (!node) return '';
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const XSS = '<img src=x onerror=PWNED(1)>';
const LIMITS = { warn: 0.1, alert: 0.2, gap: 0.15 };

function report(extra: Record<string, unknown> = {}) {
  return {
    success: true,
    week: '2026-W47',
    divergence: 0.24,
    null_p95: 0.05,
    state: 'alert',
    limits: LIMITS,
    trend: [
      { week: '2026-W47', divergence: 0.24, state: 'alert' },
      { week: '2026-W46', divergence: 0.12, state: 'warn' },
      { week: '2026-W44', divergence: 0.08, state: 'ok' },
      { week: '2026-W43', divergence: 0.07, state: 'ok' },
      { week: '2026-W40', divergence: 0.05, state: 'ok' },
    ],
    clusters: [
      { id: 'c-02', production_share: 0.18, test_share: 0.2, test_items: 14, state: 'ok' },
      { id: 'novel', production_share: 0.06, test_share: 0, test_items: 0, state: 'under' },
      { id: 'c-07', production_share: 0.22, test_share: 0.04, test_items: 3, state: 'under' },
      { id: 'c-11', production_share: 0.01, test_share: 0.11, test_items: 9, state: 'off' },
    ],
    ...extra,
  };
}

const SCORES = { unweighted: 0.82, weighted: 0.77, uncovered_share: 0.12 };
const GAPS = [
  { slice: 'all', offline: 0.81, online: 0.62, online_n: 120, gap: 0.19, result: 'failed' },
  { slice: 'language:it', offline: 0.8, online: null, online_n: 4, gap: null, result: 'insufficient_n' },
  { slice: 'channel:embed', offline: 0.78, online: 0.74, online_n: 80, gap: 0.04, result: 'passed' },
];
const RATES = [
  { slice: 'all', metric: 'refusal_rate', online: 0.1, online_n: 200, offline: 0.12 },
  { slice: 'all', metric: 'not_helpful_rate', online: 0.05, online_n: 200, offline: null },
];

describe('MONITOR_LABELS: coverage strings (UI-SPEC 12.4)', () => {
  it('holds the coverage words in en, zh and it', () => {
    const { MONITOR_LABELS: L } = load();
    expect(L.en['cov.noWeek']).toBe('No report for this week');
    expect(L.en['group.novel']).toBe('Not in any group');
    expect(L.zh['cov.state.alert']).toBe('告警');
    expect(L.it['cov.empty.title']).toBe('Nessun report di copertura');
    for (const locale of ['zh', 'it'] as const) expect(Object.keys(L[locale]).sort()).toEqual(Object.keys(L.en).sort());
  });
});

describe('monitorCoverageView', () => {
  it('renders the divergence with two decimals, the server state badge and the route limits', () => {
    const v = coverageView(report());
    expect(v.empty).toBe(false);
    expect(v.divergence?.text).toBe('0.24');
    expect(v.divergence?.badge).toMatchObject({ key: 'cov.state.alert', label: 'Alert', tone: 'badge-warning' });
    expect(v.limits?.text).toBe('0 means the same mix of topic groups, 1 means no overlap. Limits: warning 0.10, alert 0.20.');
    expect(v.week?.text).toBe('Week of Nov 16, 2026');
    const other = coverageView(report({ limits: { warn: 0.3, alert: 0.45, gap: 0.2 }, state: 'warn' }));
    expect(other.limits?.text).toContain('warning 0.30, alert 0.45');
    expect(other.divergence?.badge).toMatchObject({ key: 'cov.state.warn', tone: 'badge-warning badge-outline' });
  });

  it('colours nothing from a browser comparison: an unknown state gets no badge', () => {
    const v = coverageView(report({ divergence: 0.9, state: 'bogus' }));
    expect(v.divergence?.badge).toBeNull();
  });

  it('sorts groups by real-question share with novel among them, and scales both bars on the largest share', () => {
    const v = coverageView(report());
    expect(v.groups?.map((g) => g.id)).toEqual(['c-07', 'c-02', 'novel', 'c-11']);
    const [c07, c02, novel, c11] = v.groups ?? [];
    expect(novel.name).toBe('Not in any group');
    expect(novel.novel).toBe(true);
    expect(c07.name).toBe('c-07');
    expect(c07.production).toEqual({ text: '22.0%', bar: 1 });
    expect(c07.test.text).toBe('4.0%');
    expect(c07.test.bar).toBeCloseTo(0.04 / 0.22, 6);
    expect(c02.test.bar).toBeCloseTo(0.2 / 0.22, 6);
    expect(c11.test.bar).toBeCloseTo(0.11 / 0.22, 6);
    expect(c07.badge).toMatchObject({ key: 'group.state.under', tone: 'badge-warning' });
    expect(c11.badge).toMatchObject({ key: 'group.state.off', tone: 'badge-warning badge-outline' });
    expect(c02.badge).toMatchObject({ key: 'group.state.ok', tone: 'badge-ghost' });
    expect(c02.items).toBe('14');
  });

  it('keeps at most 40 groups plus the novel bucket', () => {
    const clusters = Array.from({ length: 45 }, (_, i) => ({ id: `c-${String(i).padStart(2, '0')}`, production_share: 0.02, test_share: 0.02, test_items: 1, state: 'ok' }));
    clusters.push({ id: 'novel', production_share: 0.001, test_share: 0, test_items: 0, state: 'under' });
    const v = coverageView(report({ clusters }));
    expect(v.groups).toHaveLength(41);
    expect(v.groups?.some((g) => g.novel)).toBe(true);
  });

  it('leaves out scores, gaps and rates when the route does not send them', () => {
    const v = coverageView(report());
    expect(v.scores).toBeNull();
    expect(v.gaps).toBeNull();
    expect(v.rates).toBeNull();
  });

  it('with scores renders the weighted score labelled report only', () => {
    const v = coverageView(report({ scores: SCORES }));
    expect(v.scores?.map((s) => [s.label, s.text])).toEqual([
      ['Unweighted (the score the limits use)', '0.82'],
      ['Weighted by real-question share (report only)', '0.77'],
      ['Share of real questions with no test item', '12.0%'],
    ]);
    const partial = coverageView(report({ scores: { unweighted: 0.5, weighted: null, uncovered_share: null } }));
    expect(partial.scores?.map((s) => s.key)).toEqual(['cov.unweighted']);
  });

  it('words the gap verdicts Above the limit and Not enough data, with the limit from the route', () => {
    const v = coverageView(report({ gaps: GAPS }));
    expect(v.gaps?.rows.map((r) => [r.slice, r.offline, r.online, r.gap, r.badge?.label])).toEqual([
      ['All questions', '0.81', '0.62 (n = 120)', '0.19', 'Above the limit'],
      ['Questions in Italian', '0.80', '— (n = 4)', '—', 'Not enough data'],
      ['channel:embed', '0.78', '0.74 (n = 80)', '0.04', 'Within limits'],
    ]);
    expect(v.gaps?.rows[0].badge?.tone).toBe('badge-warning');
    expect(v.gaps?.rows[2].badge?.tone).toBe('badge-ghost');
    expect(v.gaps?.help.text).toBe('A gap above 0.15 with enough data raises an alert.');
  });

  it('pivots votes and refusals per slice, numbers only', () => {
    const v = coverageView(report({ rates: RATES }));
    expect(v.rates?.columns.map((c) => c.label)).toEqual(['Questions', 'Not-helpful votes (online)', 'Refusals (online)', 'Refusals (offline)']);
    expect(v.rates?.rows).toEqual([{ slice: 'All questions', cells: ['5.0% (n = 200)', '10.0% (n = 200)', '12.0%'] }]);
    const offline = coverageView(report({ rates: [...RATES, { slice: 'all', metric: 'false_refusal_rate', online: null, online_n: 0, offline: 0.03 }] }));
    expect(offline.rates?.columns.map((c) => c.key)).toContain('cov.col.falseRefusal');
  });

  it('a trend of 5 weeks renders 8 rows newest first, 3 of them an em dash', () => {
    const v = coverageView(report());
    expect(v.trend).toHaveLength(8);
    expect(v.trend?.map((r) => r.week)).toEqual(['2026-W47', '2026-W46', '2026-W45', '2026-W44', '2026-W43', '2026-W42', '2026-W41', '2026-W40']);
    expect(v.trend?.filter((r) => r.missing).map((r) => r.week)).toEqual(['2026-W45', '2026-W42', '2026-W41']);
    expect(v.trend?.filter((r) => r.missing).every((r) => r.divergence === '—' && r.badge === null)).toBe(true);
    expect(v.trend?.[0]).toMatchObject({ current: true, divergence: '0.24' });
    expect(v.trend?.filter((r) => r.current)).toHaveLength(1);
  });

  it('crosses a year boundary when it fills the 8 weeks', () => {
    const v = coverageView(report({ week: '2027-W02', trend: [{ week: '2027-W02', divergence: 0.1, state: 'warn' }] }));
    expect(v.trend?.map((r) => r.week)).toEqual(['2027-W02', '2027-W01', '2026-W53', '2026-W52', '2026-W51', '2026-W50', '2026-W49', '2026-W48']);
  });

  it('no report: the empty title and body with the drift command in code', () => {
    const v = coverageView({ success: true, week: null, divergence: null, state: null, limits: LIMITS, trend: [], clusters: [] });
    expect(v.empty).toBe(true);
    expect(v.emptyTitle).toBe('No coverage report yet');
    expect(v.emptyBody?.segments.find((s) => s.code !== undefined)?.code).toMatch(/^python -m rag_eval\.drift /);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// DOM

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

function monitorRoot(doc: FakeDocument): FakeElement {
  const root = doc.createElement('section');
  root.id = 'rag-administration-monitor';
  for (const attr of ['data-monitor-title', 'data-monitor-description', 'data-monitor-alert', 'data-monitor-summary', 'data-monitor-content', 'data-monitor-status']) {
    const el = doc.createElement('div');
    el.setAttribute(attr, '');
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  return root;
}

function workspaceSelector(doc: FakeDocument): FakeElement {
  const select = doc.createElement('select');
  select.id = 'workspace-selector';
  for (const [value, name] of [
    ['org-1', 'Workspace one'],
    ['org-2', 'Workspace two'],
  ]) {
    const option = doc.createElement('option');
    option.setAttribute('value', value);
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = 'org-1';
  doc.body.appendChild(select);
  return select;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const ON = () => ({ RAG_MONITOR: 'true', RAG_RETRIEVAL_LOG: 'masked_query', RAG_REPRESENTATIVE_SAMPLE: 'true' });
const ALERTS = { monitor: { enabled: true, last_run_at: null, log_level: 'ids' }, counts: { open: 0, acknowledged: 0 }, alerts: [], next_cursor: null };

function fakeFetcher(answer: (path: string) => FetchResult | Promise<FetchResult>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (path) => {
    calls.push(path);
    return answer(path);
  };
  return { fetcher, calls };
}

function driftAnswer(body: unknown) {
  return (path: string): FetchResult => (path.includes('/monitor/drift') ? { ok: true, status: 200, body } : { ok: true, status: 200, body: ALERTS });
}

async function openCoverage(doc: FakeDocument, fetcher: Fetcher, config: () => Record<string, string> = ON) {
  const { MonitorPanel } = load();
  const root = monitorRoot(doc);
  const panel = new MonitorPanel(root, { fetcher, locale: 'en', config });
  await panel.mount();
  await panel.selectTab('coverage');
  await flush();
  const host = root.querySelector('[data-monitor-coverage-host]') as FakeElement;
  expect(host).toBeTruthy();
  return { root, host, panel };
}

describe('MonitorPanel: Test set coverage', () => {
  it('requests the drift route for the selected workspace and renders the view', async () => {
    await withDoc(async (doc) => {
      workspaceSelector(doc);
      const { fetcher, calls } = fakeFetcher(driftAnswer(report({ scores: SCORES, gaps: GAPS, rates: RATES })));
      const { host } = await openCoverage(doc, fetcher);
      expect(calls.filter((c) => c.includes('/monitor/drift'))).toEqual(['/api/rag/admin/monitor/drift?organizationId=org-1']);
      const all = text(host);
      expect(all).toContain('Workspace: Workspace one');
      expect(all).toContain('Week of Nov 16, 2026');
      expect(all).toContain('Difference between real questions and the test set');
      expect(all).toContain('Limits: warning 0.10, alert 0.20.');
      expect(all).toContain('Score on the test set');
      expect(all).toContain('Offline and online scores');
      expect(all).toContain('Votes and refusals next to the offline refusal results');
      const tables = host.querySelectorAll('table');
      expect(tables.length).toBe(4);
      for (const table of tables) expect(table.querySelector('caption')).toBeTruthy();
      const trendRows = (host.querySelector('[data-monitor-coverage-trend]') as FakeElement).querySelectorAll('tbody tr');
      expect(trendRows).toHaveLength(8);
      expect(trendRows[0].className).toContain('font-semibold');
      expect(trendRows[1].className).not.toContain('font-semibold');
      const missing = trendRows[2];
      expect(text(missing)).toContain('—');
      expect(text(missing.querySelector('.sr-only'))).toBe('No report for this week');
      const regions = host.querySelectorAll('[role="region"]');
      expect(regions.length).toBeGreaterThanOrEqual(2);
      for (const region of regions) {
        expect(region.getAttribute('tabindex')).toBe('0');
        expect(region.className).toContain('overflow-x-auto');
        expect(region.getAttribute('aria-label')).toBeTruthy();
      }
      const buttons = host.querySelectorAll('button');
      expect(buttons.map((b) => text(b).trim())).toEqual(['Refresh coverage']);
    });
  });

  it('renders the groups as ids in mono with neutral share bars on one scale', async () => {
    await withDoc(async (doc) => {
      workspaceSelector(doc);
      const { fetcher } = fakeFetcher(driftAnswer(report()));
      const { host } = await openCoverage(doc, fetcher);
      const groups = host.querySelector('[data-monitor-coverage-groups]') as FakeElement;
      const rows = groups.querySelectorAll('tbody tr');
      expect(rows.map((r) => text(r.querySelector('th')))).toEqual(['c-07', 'c-02', 'Not in any group', 'c-11']);
      expect(rows[0].querySelector('th code')?.className).toContain('font-mono');
      const bars = groups.querySelectorAll('[aria-hidden="true"].w-24');
      expect(bars).toHaveLength(8);
      for (const bar of bars) {
        expect(bar.className).toContain('max-md:hidden');
        expect(bar.className).toContain('bg-base-300');
        const fill = bar.childNodes[0] as FakeElement;
        expect(fill.className).toContain('bg-base-content/60');
        expect(fill.className).not.toMatch(/warning|error|success|primary/);
      }
      expect((bars[0].childNodes[0] as FakeElement).style.width).toBe('100%');
      expect((bars[1].childNodes[0] as FakeElement).style.width).toBe('18.2%');
      expect(text(host)).toContain('Under-covered groups get up to half of the next weekly sample.');
      expect(text(host)).not.toContain('Score on the test set');
      expect(text(host)).not.toContain('Offline and online scores');
      expect(host.querySelectorAll('table')).toHaveLength(2);
    });
  });

  it('no report: the empty title and body with the command in code', async () => {
    await withDoc(async (doc) => {
      workspaceSelector(doc);
      const { fetcher } = fakeFetcher(driftAnswer({ success: true, week: null, divergence: null, state: null, limits: LIMITS, trend: [], clusters: [] }));
      const { host } = await openCoverage(doc, fetcher);
      expect(text(host)).toContain('No coverage report yet');
      expect(text(host.querySelector('code'))).toMatch(/^python -m rag_eval\.drift /);
      expect(host.querySelectorAll('table')).toHaveLength(0);
    });
  });

  it('with Weekly sampling off requests nothing and shows the off state without numbers', async () => {
    await withDoc(async (doc) => {
      workspaceSelector(doc);
      const { fetcher, calls } = fakeFetcher(driftAnswer(report()));
      const { host } = await openCoverage(doc, fetcher, () => ({ RAG_MONITOR: 'true', RAG_REPRESENTATIVE_SAMPLE: 'false' }));
      expect(calls.filter((c) => c.includes('/monitor/drift'))).toEqual([]);
      expect(text(host)).toContain('Test set coverage is off');
      expect(text(host)).not.toMatch(/\d/);
    });
  });

  it('a 404 while the saved switch is on says the app has the feature off', async () => {
    await withDoc(async (doc) => {
      workspaceSelector(doc);
      const { fetcher } = fakeFetcher((path) => (path.includes('/monitor/drift') ? { ok: false, status: 404, body: {} } : { ok: true, status: 200, body: ALERTS }));
      const { host } = await openCoverage(doc, fetcher);
      expect(text(host)).toContain('The app answered that this feature is off.');
    });
  });

  it('changing #workspace-selector reloads the view for the new workspace', async () => {
    await withDoc(async (doc) => {
      const selector = workspaceSelector(doc);
      const { fetcher, calls } = fakeFetcher(driftAnswer(report()));
      const { host } = await openCoverage(doc, fetcher);
      selector.value = 'org-2';
      selector.dispatch('change');
      await flush();
      expect(calls.filter((c) => c.includes('/monitor/drift'))).toEqual([
        '/api/rag/admin/monitor/drift?organizationId=org-1',
        '/api/rag/admin/monitor/drift?organizationId=org-2',
      ]);
      expect(text(host)).toContain('Workspace: Workspace two');
    });
  });

  it('changing the workspace on another sub-view requests nothing until coverage is opened', async () => {
    await withDoc(async (doc) => {
      const selector = workspaceSelector(doc);
      const { fetcher, calls } = fakeFetcher(driftAnswer(report()));
      const { MonitorPanel } = load();
      const root = monitorRoot(doc);
      const panel = new MonitorPanel(root, { fetcher, locale: 'en', config: ON });
      await panel.mount();
      selector.value = 'org-2';
      selector.dispatch('change');
      await flush();
      expect(calls.filter((c) => c.includes('/monitor/drift'))).toEqual([]);
      await panel.selectTab('coverage');
      await flush();
      expect(calls.filter((c) => c.includes('/monitor/drift'))).toEqual(['/api/rag/admin/monitor/drift?organizationId=org-2']);
    });
  });

  it('Refresh coverage keeps the content dimmed while it loads', async () => {
    await withDoc(async (doc) => {
      workspaceSelector(doc);
      let release: () => void = () => {};
      let hold = false;
      const { fetcher, calls } = fakeFetcher(async (path) => {
        if (path.includes('/monitor/drift') && hold) await new Promise<void>((resolve) => (release = resolve));
        return driftAnswer(report())(path);
      });
      const { host } = await openCoverage(doc, fetcher);
      const body = host.querySelector('[data-monitor-coverage-body]') as FakeElement;
      expect(host.querySelectorAll('table').length).toBe(2);
      hold = true;
      const refresh = host.querySelectorAll('button').find((b) => text(b).includes('Refresh coverage')) as FakeElement;
      refresh.click();
      await flush();
      expect(body.className).toContain('opacity-60');
      expect(body.getAttribute('aria-busy')).toBe('true');
      expect(refresh.disabled).toBe(true);
      expect(host.querySelectorAll('table').length).toBe(2);
      release();
      await flush();
      await flush();
      expect(body.className).not.toContain('opacity-60');
      expect(body.getAttribute('aria-busy')).toBeNull();
      expect(calls.filter((c) => c.includes('/monitor/drift'))).toHaveLength(2);
    });
  });

  it('markup in cluster ids, slices, metrics and states creates no element', async () => {
    await withDoc(async (doc) => {
      workspaceSelector(doc);
      const body = report({
        week: XSS,
        state: XSS,
        clusters: [{ id: XSS, production_share: 0.3, test_share: 0.1, test_items: 2, state: XSS }],
        trend: [{ week: XSS, divergence: 0.2, state: XSS }],
        scores: SCORES,
        gaps: [{ slice: XSS, offline: 0.5, online: 0.4, online_n: 60, gap: 0.1, result: XSS }],
        rates: [{ slice: XSS, metric: XSS, online: 0.1, online_n: 3, offline: null }],
      });
      const { fetcher } = fakeFetcher(driftAnswer({ ...body, week: '2026-W47' }));
      const { host, root } = await openCoverage(doc, fetcher);
      expect(text(host)).toContain(XSS);
      expect(injectedElements(root)).toEqual([]);
      expect(root.querySelectorAll('img')).toHaveLength(0);
    });
  });
});

describe('Test set coverage as classic scripts (the way index.html loads them)', () => {
  it('renders the groups with share bars when gates-ui.js and monitor.js share one global scope', async () => {
    const doc = new FakeDocument();
    workspaceSelector(doc);
    const root = monitorRoot(doc);
    const errors: unknown[] = [];
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error: (...args: unknown[]) => errors.push(args), warn() {}, info() {}, debug() {} },
      navigator: { language: 'en-US' },
      location: { origin: 'http://config.local' },
      setTimeout,
      clearTimeout,
      Intl,
      URLSearchParams,
      configManager: { savedConfig: ON() },
      ragFetch: async (apiPath: string) => driftAnswer(report())(apiPath),
    };
    context.window = context;
    vm.createContext(context);
    const dir = path.resolve(__dirname, '../../scripts/config-ui');
    for (const file of ['utils/safe-dom.js', 'rag-panels/gates-ui.js', 'rag-panels/monitor.js']) {
      new vm.Script(fs.readFileSync(path.join(dir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    (context.initMonitorPanel as () => void)();
    await flush();
    const panel = context.monitorPanel as { selectTab: (id: string) => Promise<void> };
    await panel.selectTab('coverage');
    await flush();
    const groups = root.querySelector('[data-monitor-coverage-groups]') as FakeElement;
    expect(groups, 'topic group table').toBeTruthy();
    expect(groups.querySelectorAll('[aria-hidden="true"].w-24')).toHaveLength(8);
    expect(text(root)).toContain('Not in any group');
    expect(errors).toEqual([]);
  });
});

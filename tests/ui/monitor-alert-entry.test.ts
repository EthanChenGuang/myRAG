import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type FetchResult = { ok: boolean; status: number; body?: unknown };
type FetchInit = { method?: string; body?: string };
type Fetcher = (path: string, init?: FetchInit) => Promise<FetchResult>;
type Message = { text: string; segments: Array<{ text?: string; code?: string; mono?: string }> };

interface AlertView {
  id: string;
  measure: { text: string; code: boolean };
  severity: { label: string; tone: string };
  status: { key: string; label: string };
  meta: Message[];
  measurement: Message;
  crossed: Message | null;
  actions: string[];
  ackAria: string;
  resolveAria: string;
}

interface EvidenceView {
  breakdown: Array<{ dimension: string; title: string; rows: Array<{ label: string; mono: boolean; requests: string; count: string; rate: string }> }>;
  companions: Array<{ measure: string; code: boolean; measured: string; usual: string }>;
  changes: { rows: Array<Record<string, unknown>>; empty: Message | null };
  traces: { ids: string[]; title: string };
  suggestion: { message: Message; refusalLink: boolean } | null;
  delivery: Array<{ channel: string; label: string; message: Message }>;
}

interface Monitor {
  monitorAlertView: (alert: unknown, locale: Locale, ctx?: Record<string, unknown>) => AlertView;
  monitorEvidenceView: (alert: unknown, locale: Locale, ctx?: Record<string, unknown>) => EvidenceView;
  MonitorPanel: new (
    root: unknown,
    deps: { fetcher: Fetcher; locale?: Locale; config?: () => Record<string, string>; refreshBanner?: () => void; clipboard?: { writeText: (t: string) => Promise<void> } | null; openRefusal?: () => void },
  ) => { mount: () => Promise<void>; refresh: () => Promise<void> };
}

function load(): Monitor {
  return require('../../scripts/config-ui/rag-panels/monitor.js') as Monitor;
}

function text(node: FakeNode | null | undefined): string {
  if (!node) return '';
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const XSS = '<img src=x onerror=PWNED(1)>';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function alert(extra: Record<string, unknown> = {}) {
  return {
    id: uuid(1),
    tenant_key: 's:default',
    rule: 'refusal_rate',
    kind: 'rate',
    language: 'it',
    day: '2026-11-24',
    window_days: 1,
    severity: 'alert',
    status: 'open',
    observed: { count: 76, n: 200, value: 0.38 },
    baseline: { count: 720, n: 6000, value: 0.12 },
    band: { ratio: 2, min_abs_delta: 0.05, min_z: 3, measured_ratio: 3.1666, measured_delta: 0.26, measured_z: 9.1, alert: null, budget: null, drop: null, measured_value: null, warn: null },
    breakdown: {
      by_mode: { strict: { count: 60, n: 120, value: 0.5 }, balanced: { count: 16, n: 80, value: 0.2 } },
      by_doc_type: { unknown: { count: 4, n: 10, value: 0.4 }, policy: { count: 72, n: 190, value: 0.3789 } },
    },
    companions: [
      { rule: 'not_helpful_rate', value: 0.05, baseline: 0.05, n: 40 },
      { rule: 'latency_p95', value: 2400, baseline: 2300, n: 200 },
    ],
    sample_trace_ids: ['trace-0001', 'trace-0002'],
    config_changes: [],
    suggestion: null,
    delivered: { webhook: { attempts: 1, last_attempt_at: '2026-11-25T02:11:00Z', state: 'delivered' }, langfuse: { attempts: 0, last_attempt_at: null, state: 'disabled' } },
    dedup_key: 'secret-dedup-key-value',
    acknowledged_at: null,
    created_at: '2026-11-25T02:10:00Z',
    updated_at: '2026-11-25T02:10:00Z',
    ...extra,
  };
}

function summary(extra: Record<string, unknown> = {}) {
  return { enabled: true, last_run_day: '2026-11-24', last_run_at: '2026-11-25T02:10:00Z', log_level: 'ids', groups_checked: 48, groups_insufficient: 31, ...extra };
}

function root(doc: FakeDocument): FakeElement {
  const section = doc.createElement('section');
  section.id = 'rag-administration-monitor';
  for (const attr of ['data-monitor-title', 'data-monitor-description', 'data-monitor-alert', 'data-monitor-summary', 'data-monitor-content', 'data-monitor-status']) {
    const el = doc.createElement(attr === 'data-monitor-title' ? 'h3' : 'div');
    el.setAttribute(attr, '');
    section.appendChild(el);
  }
  doc.body.appendChild(section);
  return section;
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

function fakeFetcher(answer: (path: string, init?: FetchInit) => FetchResult | Promise<FetchResult>) {
  const calls: Array<{ method: string; path: string }> = [];
  const fetcher: Fetcher = async (path, init) => {
    calls.push({ method: init?.method ?? 'GET', path });
    return answer(path, init);
  };
  return { fetcher, calls };
}

const ON = () => ({ RAG_MONITOR: 'true' });
const MULTI = () => ({ RAG_MONITOR: 'true', NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'multi-tenant' });

function buttonsByText(el: FakeElement | FakeDocument, label: string): FakeElement[] {
  return el.querySelectorAll('button').filter((b) => text(b).trim() === label);
}

function entries(section: FakeElement): FakeElement[] {
  return section.querySelectorAll('article');
}

describe('monitorAlertView', () => {
  it('a refusal_rate alert: the measurement from its own counts and the crossed conditions from its band', () => {
    const { monitorAlertView } = load();
    const v = monitorAlertView(alert(), 'en');
    expect(v.measure.text).toBe('Refusal rate');
    expect(v.severity.label).toBe('Alert');
    expect(v.status.label).toBe('Open');
    expect(v.measurement.text).toBe('Measured: 38.0% (76 of 200). Usual: 12.0% (720 of 6,000, the 30 days before).');
    expect(v.crossed?.text).toBe('Crossed: 3.2 times the usual value (limit 2.0); changed by 26.0 points (limit 5.0); z-score 9.10 (limit 3.00)');
    expect(v.meta.map((m) => m.text)).toEqual(['Language: Italian', 'Day: Nov 24, 2026']);
    expect(v.actions).toEqual(['ack', 'resolve']);
    expect(v.ackAria).toBe('Acknowledge alert: Refusal rate, Italian');
    expect(v.resolveAria).toBe('Resolve alert: Refusal rate, Italian');
  });

  it('uses the locale number format', () => {
    const { monitorAlertView } = load();
    const v = monitorAlertView(alert(), 'it');
    expect(v.measurement.text).toBe('Misurato: 38,0% (76 su 200). Abituale: 12,0% (720 su 6000, nei 30 giorni precedenti).');
  });

  it('a widened window, all languages and, in multi-tenant mode, the workspace', () => {
    const { monitorAlertView } = load();
    const v = monitorAlertView(alert({ window_days: 3, language: 'all', tenant_key: 'o:11111111-2222-4333-8444-555555555555' }), 'en', {
      multiTenant: true,
      workspaceName: () => 'Workspace one',
    });
    expect(v.meta.map((m) => m.text)).toEqual(['Language: all', 'Workspace: Workspace one', 'Window: 3 days ending Nov 24, 2026']);
  });

  it('acknowledged shows the date and only Resolve alert; resolved has no action', () => {
    const { monitorAlertView } = load();
    const ack = monitorAlertView(alert({ status: 'acknowledged', acknowledged_at: '2026-11-25T08:00:00Z' }), 'en');
    expect(ack.status.label).toBe('Acknowledged Nov 25, 2026');
    expect(ack.actions).toEqual(['resolve']);
    expect(monitorAlertView(alert({ status: 'resolved', updated_at: '2026-11-26T08:00:00Z' }), 'en').actions).toEqual([]);
  });

  it('kinds: distribution, latency, judge mean and drift', () => {
    const { monitorAlertView } = load();
    const psi = monitorAlertView(alert({ rule: 'top_score_psi', kind: 'distribution', severity: 'warning', band: { warn: 0.1, alert: 0.25, measured_value: 0.18 } }), 'en');
    expect(psi.measure.text).toBe('Top score distribution');
    expect(psi.severity.label).toBe('Warning');
    expect(psi.measurement.text).toBe('Shift (PSI): 0.18. Limits: warning 0.10, alert 0.25.');
    const lat = monitorAlertView(
      alert({ rule: 'latency_p95', kind: 'latency', observed: { n: 300, value: 4200, count: null }, baseline: { n: 9000, value: 2100, count: null }, band: { ratio: 1.5, budget: 4000, measured_ratio: 2, measured_value: 4200 } }),
      'en',
    );
    expect(lat.measurement.text).toBe('p95: 4,200\u00a0ms. Usual: 2,100\u00a0ms. Budget: 4,000\u00a0ms.');
    expect(lat.crossed?.text).toBe('Crossed: 2.0 times the usual value (limit 1.5)');
    const judge = monitorAlertView(
      alert({ rule: 'online_judge_mean', kind: 'judge_mean', observed: { n: 50, value: 0.61, count: null }, baseline: { n: 900, value: 0.8, count: null }, band: { drop: 0.1, measured_delta: -0.19, measured_value: 0.61 } }),
      'en',
    );
    expect(judge.measurement.text).toBe('Mean score: 0.61 (n = 50). Usual: 0.80.');
    expect(judge.crossed?.text).toBe('Crossed: dropped by 0.19 (limit 0.10)');
    const drift = monitorAlertView(
      alert({ rule: 'test_set_not_representative', kind: 'drift', observed: { n: 1, value: 0.42, count: null }, baseline: null, band: { warn: 0.2, alert: 0.35, measured_value: 0.42 }, cluster_ids: ['c-01', 'c-02'] }),
      'en',
    );
    expect(drift.measurement.text).toBe('Difference from real questions: 0.42. Topic groups: c-01, c-02.');
  });

  it('an unknown rule or kind shows the id in code and measure.generic from the fields that exist', () => {
    const { monitorAlertView } = load();
    const v = monitorAlertView(alert({ rule: 'offline_online_gap', kind: 'offline_online_gap', observed: { n: 10, value: 0.3, count: null }, baseline: { n: 10, value: 0.1, count: null }, band: {} }), 'en');
    expect(v.measure).toEqual({ text: 'offline_online_gap', code: true });
    expect(v.measurement.text).toBe('Measured: 0.30. Usual: 0.10.');
    expect(v.crossed).toBeNull();
    const only = monitorAlertView(alert({ rule: 'something_new', kind: 'other', observed: { n: 10, value: 0.3 }, baseline: null, band: {} }), 'en');
    expect(only.measurement.text).toBe('Measured: 0.30.');
  });

  it('never carries the dedup key, the actor or a full hash', () => {
    const { monitorAlertView } = load();
    const v = JSON.stringify(monitorAlertView(alert({ acknowledged_by: 'user-xyz' }), 'en'));
    expect(v).not.toContain('secret-dedup-key-value');
    expect(v).not.toContain('user-xyz');
  });
});

describe('monitorEvidenceView', () => {
  it('breakdown: one table per dimension present; unknown document type reads Type no longer known', () => {
    const { monitorEvidenceView } = load();
    const v = monitorEvidenceView(alert(), 'en');
    expect(v.breakdown.map((b) => b.title)).toEqual(['RAG mode', 'Document type']);
    expect(v.breakdown[0].rows[0]).toMatchObject({ label: 'strict', mono: true, requests: '120', count: '60', rate: '50.0%' });
    expect(v.breakdown[1].rows.map((r) => r.label)).toContain('Type no longer known');
  });

  it('companions read the other measures with measured and usual', () => {
    const { monitorEvidenceView } = load();
    const v = monitorEvidenceView(alert(), 'en');
    expect(v.companions).toEqual([
      { measure: 'Not-helpful votes', code: false, measured: '5.0%', usual: '5.0%' },
      { measure: 'Latency (p95)', code: false, measured: '2,400\u00a0ms', usual: '2,300\u00a0ms' },
    ]);
  });

  it('absent breakdown, companions and suggestion are left out; changes and traces say none; delivery has three rows', () => {
    const { monitorEvidenceView } = load();
    const v = monitorEvidenceView(alert({ breakdown: {}, companions: [], sample_trace_ids: [], config_changes: [], delivered: {} }), 'en');
    expect(v.breakdown).toEqual([]);
    expect(v.companions).toEqual([]);
    expect(v.suggestion).toBeNull();
    expect(v.changes.empty?.text).toBe('No setting change is recorded in this window.');
    expect(v.traces.ids).toEqual([]);
    expect(v.delivery.map((d) => `${d.label}: ${d.message.text}`)).toEqual([
      'Config UI banner: Delivered Nov 25, 2026, 2:10 AM',
      'Admin webhook: Not set up',
      'Langfuse score on the sample traces: Not set up',
    ]);
  });

  it('delivery: delivered with a time, pending, not configured; never the address', () => {
    const { monitorEvidenceView } = load();
    const v = monitorEvidenceView(alert({ delivered: { webhook: { attempts: 2, last_attempt_at: null, state: 'failed' }, langfuse: { attempts: 1, last_attempt_at: '2026-11-25T02:12:00Z', state: 'delivered' } } }), 'en');
    expect(v.delivery[1].message.text).toBe('Not delivered yet. It is tried again on the next run.');
    expect(v.delivery[2].message.text).toContain('Delivered');
  });

  it('setting changes: names in code, the first 8 characters of each hash, the record id; unrecorded rows carry the command; no override reason', () => {
    const { monitorEvidenceView } = load();
    const before = 'a'.repeat(64);
    const after = 'b'.repeat(64);
    const v = monitorEvidenceView(
      alert({
        config_changes: [
          { record_id: uuid(9), at: '2026-11-24T10:00:00Z', source: 'config_ui', changed_keys: ['RAG_EXAMPLE_SETTING'], before_hash: before, after_hash: after, unrecorded: false, reason: 'secret reason text' },
          { record_id: null, at: '2026-11-24T11:00:00Z', source: 'cli', changed_keys: [], before_hash: before, after_hash: after, unrecorded: true },
        ],
      }),
      'en',
    );
    const json = JSON.stringify(v.changes);
    expect(json).not.toContain(before);
    expect(json).not.toContain('secret reason text');
    expect(v.changes.rows[0]).toMatchObject({ source: { text: 'Config UI', code: false }, keys: ['RAG_EXAMPLE_SETTING'], record: uuid(9) });
    expect((v.changes.rows[0].config as Message).text).toBe('aaaaaaaa to bbbbbbbb');
    expect((v.changes.rows[1].unrecorded as Message).segments.map((s) => s.code).filter(Boolean)).toEqual(['npm run rag:monitor -- record-change --keys <names> --reason <text>']);
    expect(v.changes.empty).toBeNull();
  });

  it('traces: at most 10 ids with the count in the heading', () => {
    const { monitorEvidenceView } = load();
    const ids = Array.from({ length: 12 }, (_, i) => `trace-${String(i).padStart(4, '0')}`);
    const v = monitorEvidenceView(alert({ sample_trace_ids: ids }), 'en');
    expect(v.traces.ids).toHaveLength(10);
    expect(v.traces.title).toBe('Sample traces: 10');
  });

  it('suggestion recalibrate_refusal names the command and offers the refusal link', () => {
    const { monitorEvidenceView } = load();
    const v = monitorEvidenceView(alert({ suggestion: 'recalibrate_refusal' }), 'en');
    expect(v.suggestion?.refusalLink).toBe(true);
    expect(v.suggestion?.message.segments.map((s) => s.code).filter(Boolean)).toEqual(['python -m rag_eval.calibrate refusal']);
  });
});

describe('MonitorPanel: alert list and actions', () => {
  it('renders entries as articles labelled by their h4, with badges, meta, measurement and an evidence details', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: { monitor: summary(), counts: { open: 1, acknowledged: 0 }, alerts: [alert()], next_cursor: null } }));
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON }).mount();
      const [article] = entries(section);
      const heading = article.querySelector('h4') as FakeElement;
      expect(article.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(text(heading)).toBe('Refusal rate');
      expect(article.parentNode?.tagName).toBe('li');
      expect(text(article)).toContain('Measured: 38.0% (76 of 200)');
      expect(text(article.querySelector('details summary'))).toBe('Show evidence');
      expect(buttonsByText(article, 'Acknowledge alert')[0].getAttribute('aria-label')).toBe('Acknowledge alert: Refusal rate, Italian');
      expect(text(section)).not.toContain('secret-dedup-key-value');
    });
  });

  it('no alert: alerts.empty with the thin count; before the first run neverRan; a filter that hides alerts says filtered', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      let body: Record<string, unknown> = { monitor: summary(), counts: { open: 0, acknowledged: 0 }, alerts: [], next_cursor: null };
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body }));
      const section = root(doc);
      const panel = new MonitorPanel(section, { fetcher, locale: 'en', config: ON });
      await panel.mount();
      expect(text(section)).toContain('No open alerts');
      expect(text(section)).toContain('Groups with too little data: 31.');
      body = { ...body, monitor: summary({ last_run_at: null, last_run_day: null }) };
      await panel.refresh();
      expect(text(section)).toContain('The monitor has not run yet.');
      body = { ...body, monitor: summary() };
      const resolved = section.querySelectorAll('input[type="radio"]').find((r) => r.getAttribute('value') === 'resolved') as FakeElement;
      resolved.checked = true;
      resolved.dispatch('change');
      await flush();
      await flush();
      expect(text(section)).toContain('No alerts match this filter.');
    });
  });

  it('the status filter is a fieldset of three radios and narrows the request', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: { monitor: summary(), counts: { open: 0, acknowledged: 0 }, alerts: [], next_cursor: null } }));
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON }).mount();
      const fieldset = section.querySelector('fieldset') as FakeElement;
      expect(text(fieldset.querySelector('legend'))).toBe('Show alerts');
      const radios = fieldset.querySelectorAll('input[type="radio"]');
      expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Open and acknowledged', 'Resolved', 'All']);
      radios[2].checked = true;
      radios[2].dispatch('change');
      await flush();
      expect(calls[calls.length - 1].path).toBe('/api/rag/admin/monitor/alerts?status=all&limit=20');
    });
  });

  it('in multi-tenant mode a workspace select built from the tenants present narrows the list', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const t1 = 'o:11111111-2222-4333-8444-555555555555';
      const t2 = 'o:66666666-7777-4888-9999-aaaaaaaaaaaa';
      const { fetcher, calls } = fakeFetcher(() => ({
        ok: true,
        status: 200,
        body: { monitor: summary(), counts: { open: 2, acknowledged: 0 }, alerts: [alert({ tenant_key: t1 }), alert({ id: uuid(2), tenant_key: t2 })], next_cursor: null },
      }));
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: MULTI }).mount();
      const select = section.querySelector('select[data-monitor-workspace]') as FakeElement;
      expect(select.querySelectorAll('option').map((o) => o.getAttribute('value'))).toEqual(['', t1, t2]);
      expect(text(section)).toContain('Workspace: ');
      select.value = t2;
      select.dispatch('change');
      await flush();
      expect(calls[calls.length - 1].path).toBe(`/api/rag/admin/monitor/alerts?status=active&limit=20&tenant=${encodeURIComponent(t2)}`);
    });
  });

  it('60 alerts: 20 per page, then Load more alerts fetches the cursor', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const all = Array.from({ length: 60 }, (_, i) => alert({ id: uuid(i + 1) }));
      const { fetcher, calls } = fakeFetcher((path) => {
        const m = /cursor=(\d+)/.exec(path);
        const start = m ? Number(m[1]) : 0;
        const next = start + 20 < all.length ? String(start + 20) : null;
        return { ok: true, status: 200, body: { monitor: summary(), counts: { open: 60, acknowledged: 0 }, alerts: all.slice(start, start + 20), next_cursor: next } };
      });
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON }).mount();
      expect(entries(section)).toHaveLength(20);
      buttonsByText(section, 'Load more alerts')[0].click();
      await flush();
      await flush();
      expect(calls[1].path).toBe('/api/rag/admin/monitor/alerts?status=active&limit=20&cursor=20');
      expect(entries(section)).toHaveLength(40);
      buttonsByText(section, 'Load more alerts')[0].click();
      await flush();
      await flush();
      expect(entries(section)).toHaveLength(60);
      expect(buttonsByText(section, 'Load more alerts')).toHaveLength(0);
      expect(entries(section).every((a) => buttonsByText(a, 'Resolve alert').length === 1)).toBe(true);
    });
  });

  it('Acknowledge alert: no confirmation, the badge changes in place, ack.done, focus stays in the entry, the banner refreshes', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      let banner = 0;
      const { fetcher, calls } = fakeFetcher((path, init) => {
        if (init?.method === 'POST') return { ok: true, status: 200, body: { alert: alert({ status: 'acknowledged', acknowledged_at: '2026-11-25T08:00:00Z' }) } };
        return { ok: true, status: 200, body: { monitor: summary(), counts: { open: 1, acknowledged: 0 }, alerts: [alert()], next_cursor: null } };
      });
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON, refreshBanner: () => (banner += 1) }).mount();
      const ack = buttonsByText(section, 'Acknowledge alert')[0];
      ack.click();
      expect(ack.disabled).toBe(true);
      expect(ack.querySelector('.loading')).toBeTruthy();
      await flush();
      await flush();
      expect(doc.body.querySelector('dialog')).toBeNull();
      expect(calls.find((c) => c.method === 'POST')?.path).toBe(`/api/rag/admin/monitor/alerts/${uuid(1)}/acknowledge`);
      const [article] = entries(section);
      expect(text(article)).toContain('Acknowledged Nov 25, 2026');
      expect(buttonsByText(article, 'Acknowledge alert')).toHaveLength(0);
      expect(text(section.querySelector('[data-monitor-status]'))).toBe('Alert acknowledged. It leaves the banner and stays in this list until it is resolved.');
      expect(doc.activeElement).toBe(buttonsByText(article, 'Resolve alert')[0]);
      expect(banner).toBe(1);
    });
  });

  it('Resolve alert: confirmation with focus on Keep alert open, then the entry leaves and focus moves to the next heading', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      let banner = 0;
      const { fetcher } = fakeFetcher((path, init) => {
        if (init?.method === 'POST') return { ok: true, status: 200, body: { alert: alert({ status: 'resolved' }) } };
        return { ok: true, status: 200, body: { monitor: summary(), counts: { open: 2, acknowledged: 0 }, alerts: [alert(), alert({ id: uuid(2), rule: 'zero_result_rate' })], next_cursor: null } };
      });
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON, refreshBanner: () => (banner += 1) }).mount();
      buttonsByText(entries(section)[0], 'Resolve alert')[0].click();
      await flush();
      const dialog = doc.body.querySelector('dialog') as FakeElement;
      expect(text(dialog)).toContain('Resolve this alert?');
      expect(text(dialog)).toContain('Refusal rate, Italian.');
      expect(text(doc.activeElement)).toBe('Keep alert open');
      buttonsByText(dialog, 'Resolve alert')[0].click();
      await flush();
      await flush();
      expect(entries(section)).toHaveLength(1);
      expect(text(doc.activeElement)).toBe('Searches with no result');
      expect(text(section.querySelector('[data-monitor-status]'))).toBe('Alert resolved.');
      expect(banner).toBe(1);
    });
  });

  it('a 409 on an action reloads the list and says error.alertGone', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const { fetcher, calls } = fakeFetcher((path, init) => {
        if (init?.method === 'POST') return { ok: false, status: 409, body: { error: 'Alert state changed' } };
        return { ok: true, status: 200, body: { monitor: summary(), counts: { open: 1, acknowledged: 0 }, alerts: [alert()], next_cursor: null } };
      });
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON }).mount();
      buttonsByText(section, 'Acknowledge alert')[0].click();
      await flush();
      await flush();
      await flush();
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
      expect(text(section.querySelector('[data-monitor-status]'))).toContain('This alert changed since the list was loaded. The list has been reloaded.');
    });
  });

  it('Run monitor now: run.running, then run.done with the counts; the list and the banner reload', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      let banner = 0;
      let release: (v: FetchResult) => void = () => {};
      const { fetcher, calls } = fakeFetcher((path, init) => {
        if (path === '/api/rag/admin/monitor/run') return new Promise<FetchResult>((r) => (release = r));
        void init;
        return { ok: true, status: 200, body: { monitor: summary(), counts: { open: 0, acknowledged: 0 }, alerts: [], next_cursor: null } };
      });
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON, refreshBanner: () => (banner += 1) }).mount();
      const run = buttonsByText(section, 'Run monitor now')[0];
      run.click();
      await flush();
      expect(run.disabled).toBe(true);
      expect(text(run).trim()).toBe('Running the monitor…');
      release({ ok: true, status: 200, body: { success: true, ran: true, days_aggregated: 2, alerts_opened: 1, alerts_updated: 3 } });
      await flush();
      await flush();
      await flush();
      expect(text(section.querySelector('[data-monitor-status]'))).toBe('Monitor finished. Days added: 2. Alerts opened: 1. Alerts updated: 3.');
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
      expect(banner).toBe(1);
      expect(buttonsByText(section, 'Run monitor now')[0].disabled).toBe(false);
    });
  });

  it('a failed run says run.failed', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const { fetcher } = fakeFetcher((path) => {
        if (path === '/api/rag/admin/monitor/run') return { ok: false, status: 503 };
        return { ok: true, status: 200, body: { monitor: summary(), counts: { open: 0, acknowledged: 0 }, alerts: [], next_cursor: null } };
      });
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON }).mount();
      buttonsByText(section, 'Run monitor now')[0].click();
      await flush();
      await flush();
      expect(text(section.querySelector('[data-monitor-status]'))).toContain('The monitor did not finish.');
    });
  });
});

describe('MonitorPanel: evidence DOM', () => {
  it('tables sit in focusable scroll regions; traces in a capped list; Copy trace ids writes one per line', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const written: string[] = [];
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: { monitor: summary(), counts: { open: 1, acknowledged: 0 }, alerts: [alert({ suggestion: 'recalibrate_refusal' })], next_cursor: null } }));
      let opened = 0;
      const section = root(doc);
      await new MonitorPanel(section, {
        fetcher,
        locale: 'en',
        config: ON,
        clipboard: { writeText: async (t: string) => void written.push(t) },
        openRefusal: () => (opened += 1),
      }).mount();
      const details = section.querySelector('details') as FakeElement;
      const regions = details.querySelectorAll('[role="region"]');
      expect(regions.length).toBeGreaterThanOrEqual(3);
      expect(regions.every((r) => r.getAttribute('tabindex') === '0' && Boolean(r.getAttribute('aria-label')))).toBe(true);
      expect(details.querySelectorAll('h5').map((h) => text(h))).toEqual([
        'Where it happened',
        'Other measures for the same group',
        'Setting changes in this window',
        'Sample traces: 2',
        'Suggested next step',
        'Where this alert was sent',
      ]);
      const list = details.querySelector('ul.max-h-40') as FakeElement;
      expect(list.querySelectorAll('code').map((c) => text(c))).toEqual(['trace-0001', 'trace-0002']);
      buttonsByText(details, 'Copy trace ids')[0].click();
      await flush();
      expect(written).toEqual(['trace-0001\ntrace-0002']);
      expect(text(section.querySelector('[data-monitor-status]'))).toBe('Trace ids copied.');
      buttonsByText(details, 'Open refusal calibration')[0].click();
      expect(opened).toBe(1);
    });
  });

  it('Copy trace ids is not rendered without the clipboard API', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: { monitor: summary(), counts: { open: 1, acknowledged: 0 }, alerts: [alert()], next_cursor: null } }));
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON, clipboard: null }).mount();
      expect(buttonsByText(section, 'Copy trace ids')).toHaveLength(0);
    });
  });

  it('markup in a trace id, rule id, env name, mode value or source creates no element', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const evil = alert({
        rule: XSS,
        kind: XSS,
        sample_trace_ids: [XSS],
        breakdown: { by_mode: { [XSS]: { count: 1, n: 2, value: 0.5 } } },
        companions: [{ rule: XSS, value: 1, baseline: 1, n: 1 }],
        config_changes: [{ record_id: XSS, at: '2026-11-24T10:00:00Z', source: XSS, changed_keys: [XSS], before_hash: XSS, after_hash: XSS, unrecorded: false }],
        suggestion: XSS,
        language: XSS,
      });
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: { monitor: summary(), counts: { open: 1, acknowledged: 0 }, alerts: [evil], next_cursor: null } }));
      const section = root(doc);
      await new MonitorPanel(section, { fetcher, locale: 'en', config: ON, clipboard: { writeText: async () => {} } }).mount();
      expect(entries(section)).toHaveLength(1);
      expect(injectedElements(doc)).toHaveLength(0);
      expect(text(section)).toContain(XSS);
    });
  });
});

describe('monitorAlertView in zh', () => {
  it('writes the crossed conditions without a space after the full-width colon', () => {
    const { monitorAlertView } = load();
    expect(monitorAlertView(alert(), 'zh').crossed?.text.startsWith('超出：为通常值的 3.2 倍')).toBe(true);
  });
});

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type FetchResult = { ok: boolean; status: number; body?: unknown };
type FetchInit = { method?: string; body?: string; headers?: Record<string, string> };
type Fetcher = (path: string, init?: FetchInit) => Promise<FetchResult>;

interface PanelLike {
  mount: () => Promise<void>;
  refresh: () => Promise<void>;
  selectTab: (id: string) => Promise<void>;
}

interface PanelDeps {
  fetcher: Fetcher;
  configFetcher?: Fetcher;
  locale?: Locale;
  config?: () => Record<string, string>;
  secretsSet?: () => Set<string>;
}

interface Monitor {
  MONITOR_LABELS: Record<Locale, Record<string, string>>;
  MonitorPanel: new (root: unknown, deps: PanelDeps) => PanelLike;
  monitorSummaryView: (monitor: unknown, enabled: boolean, locale: Locale) => Array<{ label: string; text: string }>;
  monitorSettingsWarnings: (values: Record<string, string | undefined>) => string[];
  initMonitorPanel: () => void;
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

export function monitorRoot(doc: FakeDocument): FakeElement {
  const root = doc.createElement('section');
  root.id = 'rag-administration-monitor';
  for (const attr of ['data-monitor-title', 'data-monitor-description', 'data-monitor-alert', 'data-monitor-summary', 'data-monitor-content', 'data-monitor-status']) {
    const el = doc.createElement(attr === 'data-monitor-title' ? 'h3' : 'div');
    el.setAttribute(attr, '');
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  return root;
}

function settingsBlock(doc: FakeDocument) {
  const block = doc.createElement('div');
  block.id = 'rag-phase053-settings';
  block.className = 'hidden';
  const group = doc.createElement('div');
  group.setAttribute('data-rag-settings-group', 'monitor');
  const mk = (tag: string, attrs: Record<string, string>, content = '') => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (content) el.textContent = content;
    group.appendChild(el);
    return el;
  };
  mk('span', { 'data-rag-i18n': 'settings.monitor.label' }, 'Daily monitoring');
  const monitor = mk('select', { id: 'RAG_MONITOR' });
  monitor.id = 'RAG_MONITOR';
  monitor.value = 'false';
  const urlField = doc.createElement('div');
  urlField.setAttribute('data-monitor-webhook-field', '');
  group.appendChild(urlField);
  const url = doc.createElement('input');
  url.id = 'RAG_MONITOR_WEBHOOK_URL';
  url.setAttribute('type', 'url');
  urlField.appendChild(url);
  const urlHelp = doc.createElement('span');
  urlHelp.id = 'rag-monitor-webhook-url-help';
  urlHelp.setAttribute('data-rag-i18n', 'settings.webhook.help');
  urlHelp.textContent = 'Optional. Each alert is posted here as JSON with counts and ids. HTTPS only.';
  urlField.appendChild(urlHelp);
  const secret = mk('input', { type: 'password' });
  secret.id = 'RAG_MONITOR_WEBHOOK_SECRET';
  const reveal = mk('button', { type: 'button', 'data-for': 'RAG_MONITOR_WEBHOOK_SECRET', 'aria-label': 'Show or hide the webhook secret' });
  const secretHelp = mk('span', { 'data-rag-i18n': 'settings.secret.help' }, 'Optional. At least 32 characters.');
  secretHelp.id = 'rag-monitor-webhook-secret-help';
  mk('p', { 'data-rag-i18n': 'settings.saveHint' }, 'These settings are saved with Save All Changes at the top of the page and apply after the app restarts.');
  block.appendChild(group);
  doc.body.appendChild(block);
  const log = doc.createElement('select');
  log.id = 'RAG_RETRIEVAL_LOG';
  log.value = 'ids';
  doc.body.appendChild(log);
  return { block, group, monitor, url, urlHelp, secret, secretHelp, reveal, log };
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
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetcher: Fetcher = async (path, init) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined });
    return answer(path, init);
  };
  return { fetcher, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export function summary(extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    last_run_day: '2026-11-24',
    last_run_at: '2026-11-25T02:10:00Z',
    log_level: 'ids',
    groups_checked: 48,
    groups_insufficient: 31,
    ...extra,
  };
}

function listBody(extra: Record<string, unknown> = {}) {
  return { monitor: summary(), counts: { open: 0, acknowledged: 0 }, alerts: [], next_cursor: null, ...extra };
}

const ON = () => ({ RAG_MONITOR: 'true', RAG_RETRIEVAL_LOG: 'ids' });
const OFF = () => ({ RAG_MONITOR: 'false', RAG_RETRIEVAL_LOG: 'off' });

function view(root: FakeElement, id: string): FakeElement {
  const el = root.querySelector(`[data-monitor-view="${id}"]`);
  expect(el, `view ${id}`).toBeTruthy();
  return el as FakeElement;
}

function buttonsByText(root: FakeElement, label: string): FakeElement[] {
  return root.querySelectorAll('button').filter((b) => text(b).trim() === label);
}

describe('MONITOR_LABELS', () => {
  it('has the same keys in en, zh and it', () => {
    const { MONITOR_LABELS } = load();
    const en = Object.keys(MONITOR_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(100);
    expect(Object.keys(MONITOR_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(MONITOR_LABELS.it).sort()).toEqual(en);
  });

  it('holds the UI-SPEC 12.4 words', () => {
    const { MONITOR_LABELS: L } = load();
    expect(L.en['panel.title']).toBe('Monitoring');
    expect(L.zh['tab.alerts']).toBe('告警');
    expect(L.it['action.run']).toBe('Esegui monitoraggio ora');
    expect(L.en['confirm.resolve.keep']).toBe('Keep alert open');
    expect(L.en['confirm.webhook.keep']).toBe('Keep webhook');
    expect(L.en['measure.rate']).toBe('Measured: {rate} ({count} of {total}). Usual: {baseRate} ({baseCount} of {baseTotal}, the 30 days before).');
  });
});

describe('monitorSummaryView', () => {
  it('with the switch off says Daily monitoring: Off and nothing else', () => {
    const { monitorSummaryView } = load();
    const rows = monitorSummaryView(summary(), false, 'en');
    expect(rows.map((r) => `${r.label}: ${r.text}`)).toEqual(['Daily monitoring: Off']);
  });

  it('from a route answer: state, last run, log level and the two group counts', () => {
    const { monitorSummaryView } = load();
    const rows = monitorSummaryView(summary(), true, 'en');
    expect(rows.map((r) => r.label)).toEqual(['Daily monitoring', 'Last run', 'Retrieval log', 'Groups checked', 'Groups with too little data']);
    expect(rows[0].text).toBe('On');
    expect(rows[1].text).toContain('Nov 25, 2026');
    expect(rows[2].text).toBe('ids');
    expect(rows[3].text).toBe('48');
    expect(rows[4].text).toBe('31');
  });

  it('never ran shows Not run yet', () => {
    const { monitorSummaryView } = load();
    const rows = monitorSummaryView(summary({ last_run_at: null, last_run_day: null, groups_checked: null, groups_insufficient: null }), true, 'en');
    expect(rows[1].text).toBe('Not run yet');
  });
});

describe('monitorSettingsWarnings', () => {
  it('warns when the monitor is on and the retrieval log is off, and when the webhook is not https', () => {
    const { monitorSettingsWarnings } = load();
    expect(monitorSettingsWarnings({ monitor: 'true', log: 'off', url: '' })).toEqual(['warn.monitorNeedsLog']);
    expect(monitorSettingsWarnings({ monitor: 'true', log: 'ids', url: 'http://hooks.example.test/x' })).toEqual(['warn.webhookHttps']);
    expect(monitorSettingsWarnings({ monitor: 'false', log: 'off', url: 'https://hooks.example.test/x' })).toEqual([]);
    expect(monitorSettingsWarnings({ monitor: 'true', log: undefined, url: '' })).toEqual([]);
  });
});

describe('MonitorPanel: chrome and summary', () => {
  it('has the sub-tabs Alerts (default), Test set coverage and Settings', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      const tabs = root.querySelectorAll('[role="tab"]');
      expect(tabs.map((t) => text(t))).toEqual(['Alerts', 'Test set coverage', 'Settings']);
      expect(root.querySelector('[data-monitor-tab="alerts"]')?.getAttribute('aria-selected')).toBe('true');
      expect(root.getAttribute('lang')).toBe('en');
      expect(text(root.querySelector('[data-monitor-title]'))).toBe('Monitoring');
      expect(root.querySelector('[data-monitor-coverage-host]')).toBeTruthy();
    });
  });

  it('with RAG_MONITOR false: summary Off, the off block, no request and no Run monitor now', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, locale: 'en', config: OFF }).mount();
      expect(calls).toEqual([]);
      const summaryHost = root.querySelector('[data-monitor-summary]') as FakeElement;
      expect(text(summaryHost)).toBe('Daily monitoringOff');
      const alerts = view(root, 'alerts');
      expect(text(alerts)).toContain('Monitoring is off');
      expect(text(alerts)).toContain('Nothing is measured and no alert is raised.');
      expect(buttonsByText(root, 'Run monitor now')).toHaveLength(0);
      expect(text(alerts)).not.toMatch(/\d/);
    });
  });

  it('renders the summary as a dl with the last run in a time element and the counts', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/rag/admin/monitor/alerts?status=active&limit=20']);
      const dl = root.querySelector('[data-monitor-summary] dl') as FakeElement;
      expect(dl).toBeTruthy();
      expect(dl.querySelectorAll('dt').map((d) => text(d))).toEqual(['Daily monitoring', 'Last run', 'Retrieval log', 'Groups checked', 'Groups with too little data']);
      const time = dl.querySelector('time') as FakeElement;
      expect(time.getAttribute('datetime')).toBe('2026-11-25T02:10:00Z');
      expect(dl.querySelectorAll('dd').map((d) => text(d)).slice(3)).toEqual(['48', '31']);
      expect(buttonsByText(root, 'Run monitor now')).toHaveLength(1);
    });
  });

  it('with the retrieval log off at the app, the alert host says needsLog with the variable in code', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody({ monitor: summary({ log_level: 'off' }) }) }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      const host = root.querySelector('[data-monitor-alert]') as FakeElement;
      expect(text(host)).toContain('The retrieval log is off, so the monitor has nothing to read and writes nothing.');
      expect(host.querySelectorAll('code').map((c) => text(c))).toContain('RAG_RETRIEVAL_LOG');
    });
  });

  it('a 404 while the saved switch is on shows error.switchedOffApp with Reload panel', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: false, status: 404, body: { error: 'Not found' } }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      const alerts = view(root, 'alerts');
      expect(text(alerts)).toContain('The app answered that this feature is off.');
      expect(buttonsByText(alerts, 'Reload panel')).toHaveLength(1);
    });
  });

  it('a 401 shows the sign-in alert in Alerts and Settings stays usable', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: false, status: 401 }));
      const root = monitorRoot(doc);
      const panel = new MonitorPanel(root, { fetcher, locale: 'en', config: ON });
      await panel.mount();
      expect(text(view(root, 'alerts'))).toContain('Admin sign-in required');
      await panel.selectTab('settings');
      expect(view(root, 'settings').querySelector('#RAG_MONITOR')).toBeTruthy();
    });
  });

  it('first load says Loading alerts… in the status region', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      let release: (v: FetchResult) => void = () => {};
      const { fetcher } = fakeFetcher(() => new Promise<FetchResult>((r) => (release = r)));
      const root = monitorRoot(doc);
      const done = new MonitorPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      await flush();
      expect(text(root.querySelector('[data-monitor-status]'))).toBe('Loading alerts…');
      release({ ok: true, status: 200, body: listBody() });
      await done;
      expect(text(root.querySelector('[data-monitor-status]'))).toBe('Alerts loaded. Open: 0. Acknowledged: 0.');
    });
  });

  it('renders summary values from the route as text (XSS)', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody({ monitor: summary({ log_level: XSS }) }) }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      expect(injectedElements(doc)).toHaveLength(0);
    });
  });
});

describe('MonitorPanel: Settings', () => {
  it('moves the monitor group into Settings once, localized, and makes no request for it', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const s = settingsBlock(doc);
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const root = monitorRoot(doc);
      const panel = new MonitorPanel(root, { fetcher, locale: 'it', config: OFF });
      await panel.mount();
      await panel.selectTab('settings');
      await panel.mount();
      const settings = view(root, 'settings');
      expect(s.group.parentNode).toBe(settings);
      expect(root.querySelectorAll('[data-rag-settings-group="monitor"]')).toHaveLength(1);
      expect(text(s.group)).toContain('Monitoraggio giornaliero');
      expect(s.reveal.getAttribute('aria-label')).toBe('Mostra o nascondi il segreto del webhook');
      expect(calls).toEqual([]);
    });
  });

  it('without a stored webhook: state line not set and no Remove webhook', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const root = monitorRoot(doc);
      const panel = new MonitorPanel(root, { fetcher, locale: 'en', config: OFF, secretsSet: () => new Set() });
      await panel.mount();
      const settings = view(root, 'settings');
      expect(text(settings)).toContain('Webhook: not set');
      expect(buttonsByText(settings, 'Remove webhook')).toHaveLength(0);
    });
  });

  it('a stored webhook shows the set state, the stored help line, and Remove webhook clears it through the config server', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const s = settingsBlock(doc);
      const secrets = new Set(['RAG_MONITOR_WEBHOOK_URL', 'RAG_MONITOR_WEBHOOK_SECRET']);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const config = fakeFetcher(() => ({ ok: true, status: 200, body: { success: true } }));
      const root = monitorRoot(doc);
      const panel = new MonitorPanel(root, { fetcher, configFetcher: config.fetcher, locale: 'en', config: OFF, secretsSet: () => secrets });
      await panel.mount();
      const settings = view(root, 'settings');
      expect(text(settings)).toContain('Webhook: set');
      expect(text(s.urlHelp)).toBe('A webhook URL is stored and is not shown. Enter a new one to replace it, or leave empty to keep it.');
      expect(text(s.secretHelp)).toBe('A secret is stored. Leave empty to keep it.');
      expect(s.url.value).toBe('');
      const remove = buttonsByText(settings, 'Remove webhook')[0];
      remove.click();
      await flush();
      const dialog = doc.body.querySelector('dialog') as FakeElement;
      expect(text(dialog)).toContain('Remove the webhook?');
      expect(doc.activeElement && text(doc.activeElement)).toBe('Keep webhook');
      buttonsByText(dialog, 'Remove webhook')[0].click();
      await flush();
      await flush();
      expect(config.calls).toEqual([{ method: 'POST', path: '/api/config', body: { clear: ['RAG_MONITOR_WEBHOOK_URL'] } }]);
      expect(text(settings)).toContain('Webhook: not set');
      expect(buttonsByText(settings, 'Remove webhook')).toHaveLength(0);
      expect(secrets.has('RAG_MONITOR_WEBHOOK_URL')).toBe(false);
      expect(text(root.querySelector('[data-monitor-status]'))).toBe('Webhook removed.');
    });
  });

  it('a failed removal says webhook.removeFailed and keeps the set state', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const secrets = new Set(['RAG_MONITOR_WEBHOOK_URL']);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const config = fakeFetcher(() => ({ ok: false, status: 500 }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, configFetcher: config.fetcher, locale: 'en', config: OFF, secretsSet: () => secrets }).mount();
      const settings = view(root, 'settings');
      buttonsByText(settings, 'Remove webhook')[0].click();
      await flush();
      buttonsByText(doc.body.querySelector('dialog') as FakeElement, 'Remove webhook')[0].click();
      await flush();
      await flush();
      expect(text(settings)).toContain('Webhook: set');
      expect(text(root.querySelector('[data-monitor-status]'))).toContain('The webhook was not removed');
      expect(secrets.has('RAG_MONITOR_WEBHOOK_URL')).toBe(true);
    });
  });

  it('Keep webhook sends nothing', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const config = fakeFetcher(() => ({ ok: true, status: 200 }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, configFetcher: config.fetcher, locale: 'en', config: OFF, secretsSet: () => new Set(['RAG_MONITOR_WEBHOOK_URL']) }).mount();
      buttonsByText(view(root, 'settings'), 'Remove webhook')[0].click();
      await flush();
      buttonsByText(doc.body.querySelector('dialog') as FakeElement, 'Keep webhook')[0].click();
      await flush();
      expect(config.calls).toEqual([]);
      expect(text(view(root, 'settings'))).toContain('Webhook: set');
    });
  });

  it('recomputes the combination notes on change: http webhook marks the field invalid; monitor on with the log off', async () => {
    await withDoc(async (doc) => {
      const { MonitorPanel } = load();
      const s = settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: listBody() }));
      const root = monitorRoot(doc);
      await new MonitorPanel(root, { fetcher, locale: 'en', config: OFF }).mount();
      const settings = view(root, 'settings');
      s.url.value = 'http://hooks.example.test/x';
      s.url.dispatch('change');
      expect(text(settings)).toContain('The webhook URL must start with https://.');
      expect(s.url.getAttribute('aria-invalid')).toBe('true');
      expect(s.url.className).toContain('input-error');
      s.url.value = 'https://hooks.example.test/x';
      s.url.dispatch('change');
      expect(text(settings)).not.toContain('must start with https://');
      expect(s.url.getAttribute('aria-invalid')).toBeNull();
      s.monitor.value = 'true';
      s.log.value = 'off';
      s.monitor.dispatch('change');
      expect(text(settings)).toContain('Monitoring is on, but the retrieval log is off.');
      s.log.value = 'masked_query';
      s.log.dispatch('change');
      expect(text(settings)).not.toContain('Monitoring is on, but the retrieval log is off.');
    });
  });
});

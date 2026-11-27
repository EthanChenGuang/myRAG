import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type FetchResult = { ok: boolean; status: number; body?: unknown; thrown?: boolean };
type FetchInit = { method?: string; body?: string; headers?: Record<string, string> };
type Fetcher = (path: string, init?: FetchInit) => Promise<FetchResult>;

interface PanelLike {
  mount: () => Promise<void>;
  refresh: () => Promise<void>;
  selectTab: (id: string) => Promise<void>;
  current: string;
}

interface PanelDeps {
  fetcher: Fetcher;
  configFetcher: Fetcher;
  locale?: Locale;
  config?: () => Record<string, string>;
}

interface RunRow {
  id: string;
  workspace: { name: string | null; key: string } | null;
  reason: { label: string | null; code: string };
  verdict: { value: string; reason: string | null };
  failed: string[];
}

interface SettingCheckModule {
  SETTING_CHECK_LABELS: Record<Locale, Record<string, string>>;
  SettingChecksPanel: new (root: unknown, deps: PanelDeps) => PanelLike;
  settingChecksRunsRows: (requests: unknown, locale: Locale, ctx?: { multiTenant?: boolean; workspaceName?: (key: string) => string | null }) => RunRow[];
  settingChecksSettingsWarnings: (values: { gate?: string; live?: string; savedGate?: string }) => string[];
  initSettingChecksPanel: () => void;
}

function load(): SettingCheckModule {
  const mod = require('../../scripts/config-ui/rag-panels/setting-check.js') as SettingCheckModule;
  expect(typeof mod.SettingChecksPanel, 'SettingChecksPanel is exported').toBe('function');
  expect(typeof mod.settingChecksRunsRows, 'settingChecksRunsRows is exported').toBe('function');
  return mod;
}

function text(node: FakeNode | null | undefined): string {
  if (!node) return '';
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const XSS = '<img src=x onerror=PWNED(1)>';
const TENANT_A = 'u:00000000-0000-4000-8000-000000000001';
const TENANT_B = 'o:00000000-0000-4000-8000-000000000002';

function panelRoot(doc: FakeDocument): FakeElement {
  const root = doc.createElement('section');
  root.id = 'rag-administration-setting-checks';
  for (const attr of ['data-setting-checks-title', 'data-setting-checks-description', 'data-setting-checks-alert', 'data-setting-checks-content', 'data-setting-checks-status']) {
    const el = doc.createElement(attr === 'data-setting-checks-title' ? 'h3' : 'div');
    el.setAttribute(attr, '');
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  return root;
}

function settingsBlock(doc: FakeDocument, gateValue = 'off', liveValue = 'false') {
  const block = doc.createElement('div');
  block.id = 'rag-phase053-settings';
  block.className = 'hidden';
  const group = doc.createElement('div');
  group.setAttribute('data-rag-settings-group', 'gate');
  const label = doc.createElement('span');
  label.setAttribute('data-rag-i18n', 'settings.gate.label');
  label.textContent = 'Check settings before saving';
  group.appendChild(label);
  const gate = doc.createElement('select');
  gate.id = 'RAG_CONFIG_GATE';
  gate.value = gateValue;
  group.appendChild(gate);
  const live = doc.createElement('select');
  live.id = 'RAG_CONFIG_GATE_LIVE';
  live.value = liveValue;
  group.appendChild(live);
  block.appendChild(group);
  doc.body.appendChild(block);
  return { block, group, gate, live, label };
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function check(extra: Record<string, unknown> = {}) {
  return {
    check_id: '00000000-0000-4000-8000-0000000000c1',
    status: 'done',
    started_at: '2026-11-25T14:00:00Z',
    finished_at: '2026-11-25T14:02:00Z',
    mode: 'enforce',
    changed_keys: ['RAG_EXAMPLE_SETTING', 'RAG_OTHER_SETTING'],
    result: 'fail',
    layers: [
      {
        layer: 'deterministic',
        result: 'fail',
        checks: [
          { check: 'false_answer_rate', slice: 'overall', measured: 0.2, numerator: 2, denominator: 10, limit: 0.1, limit_kind: 'max', result: 'fail' },
          { check: 'false_refusal_rate', slice: 'overall', measured: 0.05, limit: 0.1, limit_kind: 'max', result: 'pass' },
        ],
      },
      { layer: 'live', result: 'skipped', reason: 'live_off', checks: [] },
      { layer: 'real_set', result: 'skipped', reason: 'no_real_set', checks: [] },
    ],
    saved_as: 'override',
    ...extra,
  };
}

function run(extra: Record<string, unknown> = {}) {
  return {
    id: 'r-01',
    tenant_key: TENANT_A,
    reason: 'backfill_completed',
    ref_id: 'batch-0001',
    requested_at: '2026-11-25T03:00:00Z',
    updated_at: '2026-11-25T03:00:00Z',
    status: 'pending',
    skip_reason: null,
    result: null,
    checks: [],
    counts: {},
    ...extra,
  };
}

const ENFORCE = () => ({ RAG_CONFIG_GATE: 'enforce', RAG_CONFIG_GATE_LIVE: 'false', NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'multi-tenant' });
const OFF = () => ({ RAG_CONFIG_GATE: 'off', RAG_CONFIG_GATE_LIVE: 'false', NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'multi-tenant' });

function view(root: FakeElement, id: string): FakeElement {
  const el = root.querySelector(`[data-setting-checks-view="${id}"]`);
  expect(el, `view ${id}`).toBeTruthy();
  return el as FakeElement;
}

function buttonsByText(root: FakeElement, label: string): FakeElement[] {
  return root.querySelectorAll('button').filter((b) => text(b).trim() === label);
}

function runsAnswer(requests: unknown[], next: string | null = null): FetchResult {
  return { ok: true, status: 200, body: { requests, next_cursor: next } };
}

describe('settingChecksRunsRows', () => {
  it('maps each request status onto a verdict line, never green for a skip', () => {
    const { settingChecksRunsRows } = load();
    const rows = settingChecksRunsRows(
      [
        run({ id: 'r-01', status: 'pending' }),
        run({ id: 'r-02', status: 'running' }),
        run({ id: 'r-03', status: 'done', result: 'pass' }),
        run({ id: 'r-04', status: 'done', result: 'fail', checks: ['false_answer_rate', 'stale_share'] }),
        run({ id: 'r-05', status: 'skipped', skip_reason: 'no_real_set' }),
        run({ id: 'r-06', status: 'failed' }),
        run({ id: 'r-07', status: 'done', result: null }),
      ],
      'en',
      { multiTenant: true },
    );
    expect(rows.map((r) => [r.id, r.verdict.value, r.verdict.reason])).toEqual([
      ['r-01', 'pending', null],
      ['r-02', 'running', null],
      ['r-03', 'pass', null],
      ['r-04', 'fail', null],
      ['r-05', 'skipped', 'no_real_set'],
      ['r-06', 'error', null],
      ['r-07', 'error', null],
    ]);
    expect(rows[3].failed).toEqual(['False answers', 'Out-of-date test items']);
    expect(rows[0].reason).toEqual({ label: 'After a bulk import', code: 'backfill_completed' });
  });

  it('keeps an unknown reason as its code and hides the workspace in single-tenant mode', () => {
    const { settingChecksRunsRows } = load();
    const [multi] = settingChecksRunsRows([run({ reason: 'something_new' })], 'en', { multiTenant: true, workspaceName: () => null });
    expect(multi.reason).toEqual({ label: null, code: 'something_new' });
    expect(multi.workspace).toEqual({ name: null, key: TENANT_A });
    const [named] = settingChecksRunsRows([run()], 'en', { multiTenant: true, workspaceName: () => 'Workspace one' });
    expect(named.workspace).toEqual({ name: 'Workspace one', key: TENANT_A });
    const [single] = settingChecksRunsRows([run({ tenant_key: 's:default' })], 'en', { multiTenant: false });
    expect(single.workspace).toBeNull();
  });

  it('drops rows without an id and has labels in zh and it', () => {
    const { settingChecksRunsRows } = load();
    expect(settingChecksRunsRows([null, { status: 'done' }, run()], 'zh').length).toBe(1);
    expect(settingChecksRunsRows([run({ reason: 'reembed_completed' })], 'it')[0].reason.label).toBe('Dopo il ricalcolo degli embedding');
  });
});

describe('settingChecksSettingsWarnings', () => {
  it('warns when the live check is on with the gate off, and suggests warn mode before enforce', () => {
    const { settingChecksSettingsWarnings } = load();
    expect(settingChecksSettingsWarnings({ gate: 'off', live: 'true', savedGate: 'off' })).toEqual(['warn.liveNeedsGate']);
    expect(settingChecksSettingsWarnings({ gate: 'enforce', live: 'false', savedGate: 'off' })).toEqual(['warn.enforceFirst']);
    expect(settingChecksSettingsWarnings({ gate: 'enforce', live: 'false', savedGate: 'warn' })).toEqual([]);
    expect(settingChecksSettingsWarnings({ gate: 'warn', live: 'true', savedGate: 'off' })).toEqual([]);
  });
});

describe('SettingChecksPanel', () => {
  it('with the mode off: the off block in Last check and no rag-gate request', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'off');
      const app = fakeFetcher(() => runsAnswer([]));
      const cfg = fakeFetcher(() => ({ ok: true, status: 200, body: check() }));
      const panel = new SettingChecksPanel(root, { fetcher: app.fetcher, configFetcher: cfg.fetcher, config: OFF, locale: 'en' });
      await panel.mount();
      await flush();
      const last = view(root, 'last');
      expect(text(last)).toContain('Setting checks are off');
      expect(text(last)).toContain('Settings are saved at once, as before.');
      expect(cfg.calls.filter((c) => c.path.includes('rag-gate'))).toEqual([]);
      expect(app.calls).toEqual([]);
      const summary = text(root.querySelector('[data-setting-checks-summary]'));
      expect(summary).toContain('Mode');
      expect(summary).toContain('Off: settings are saved at once, as before');
      expect(summary).toContain('Live model check');
      expect(summary).toContain('Off');
    });
  });

  it('latest check: one verdict line per layer, failed rows first, and how the save ended; names only', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'enforce');
      const cfg = fakeFetcher((path) => {
        expect(path).toBe('/api/config/rag-gate/check/latest');
        return { ok: true, status: 200, body: check({ override_reason: 'SECRET REASON TEXT', value: 'SECRET VALUE' }) };
      });
      const app = fakeFetcher(() => runsAnswer([]));
      const panel = new SettingChecksPanel(root, { fetcher: app.fetcher, configFetcher: cfg.fetcher, config: ENFORCE, locale: 'en' });
      await panel.mount();
      await flush();
      const last = view(root, 'last');
      const all = text(last);
      expect(all).toContain('Changed settings: 2');
      expect(all).toContain('RAG_EXAMPLE_SETTING');
      const layers = last.querySelectorAll('[data-setting-checks-layer]');
      expect(layers.map((l) => l.getAttribute('data-setting-checks-layer'))).toEqual(['deterministic', 'live', 'real_set']);
      expect(text(layers[0])).toContain('Failed');
      expect(text(layers[1])).toContain('Skipped');
      expect(text(layers[1])).toContain('The live model check is switched off.');
      expect(text(layers[2])).toContain('This workspace has no test set of its own on this machine.');
      expect(all).toContain('What failed');
      const firstTable = last.querySelector('table');
      expect(text(firstTable)).toContain('False answers');
      expect(text(firstTable)).not.toContain('False refusals');
      expect(all).toContain('Show all checks: 1');
      expect(all).toContain('Saved: with a reason');
      expect(all).toContain('Checked');
      expect(last.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-25T14:02:00Z');
      expect(all).not.toContain('SECRET');
      expect(buttonsByText(last, 'Save settings')).toEqual([]);
      expect(buttonsByText(last, 'Save settings with reason')).toEqual([]);
      expect(buttonsByText(last, 'Refresh check').length).toBe(1);
    });
  });

  it('a 404 from the latest route renders the empty state', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'warn');
      const cfg = fakeFetcher(() => ({ ok: false, status: 404, body: { error: 'not_found' } }));
      const panel = new SettingChecksPanel(root, { fetcher: fakeFetcher(() => runsAnswer([])).fetcher, configFetcher: cfg.fetcher, config: () => ({ RAG_CONFIG_GATE: 'warn' }), locale: 'en' });
      await panel.mount();
      await flush();
      const last = view(root, 'last');
      expect(text(last)).toContain('No check yet');
      expect(text(last)).toContain('Its result appears here.');
    });
  });

  it('a failed latest request shows the unavailable alert with Reload panel', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'warn');
      const cfg = fakeFetcher(() => ({ ok: false, status: 500, body: { error: 'rag_gate_failed' } }));
      const panel = new SettingChecksPanel(root, { fetcher: fakeFetcher(() => runsAnswer([])).fetcher, configFetcher: cfg.fetcher, config: () => ({ RAG_CONFIG_GATE: 'warn' }), locale: 'en' });
      await panel.mount();
      await flush();
      const last = view(root, 'last');
      expect(text(last)).toContain('is unavailable right now');
      expect(buttonsByText(last, 'Reload panel').length).toBe(1);
      expect(text(root.querySelector('[data-setting-checks-status]'))).toContain('unavailable');
    });
  });

  it('evaluation runs: verdicts, failed checks in a details, skipped with its reason, the drain command', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'enforce');
      const app = fakeFetcher((path) => {
        expect(path).toBe('/api/rag/admin/eval-run-requests?limit=20');
        return runsAnswer([
          run({ id: 'r-01', status: 'done', result: 'fail', checks: ['false_answer_rate'] }),
          run({ id: 'r-02', status: 'skipped', skip_reason: 'no_real_set', reason: 'reembed_completed', tenant_key: TENANT_B }),
          run({ id: 'r-03', status: 'failed' }),
          run({ id: 'r-04', status: 'running' }),
        ]);
      });
      const cfg = fakeFetcher(() => ({ ok: false, status: 404 }));
      const panel = new SettingChecksPanel(root, { fetcher: app.fetcher, configFetcher: cfg.fetcher, config: ENFORCE, locale: 'en' });
      await panel.mount();
      await panel.selectTab('runs');
      await flush();
      const runs = view(root, 'runs');
      const rows = runs.querySelectorAll('tbody tr');
      expect(rows.length).toBe(4);
      expect(text(rows[0])).toContain('Failed');
      const details = rows[0].querySelector('details');
      expect(details).toBeTruthy();
      expect(text(details)).toContain('Show failed checks: 1');
      expect(text(details)).toContain('False answers');
      expect(text(rows[1])).toContain('Skipped');
      expect(text(rows[1])).toContain('This workspace has no test set of its own on this machine.');
      expect(text(rows[1])).toContain('After re-embedding');
      expect(text(rows[2])).toContain('No result');
      expect(text(rows[3])).toContain('Running');
      const tenantCell = rows[0].querySelector('[data-setting-checks-workspace]');
      expect(text(tenantCell)).toBe(TENANT_A);
      expect(tenantCell?.className).toContain('font-mono');
      expect(tenantCell?.className).toContain('break-all');
      expect(text(runs)).toContain('python -m rag_eval.tenant_nightly --drain');
      expect(text(runs.querySelector('thead'))).toContain('Workspace');
    });
  });

  it('pages the runs by 20 with Load more runs, every row reachable with 60 runs', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'enforce');
      const all = Array.from({ length: 60 }, (_, i) => run({ id: 'r-' + String(i + 1).padStart(2, '0') }));
      const app = fakeFetcher((path) => {
        const url = new URL(path, 'http://x');
        const cursor = url.searchParams.get('cursor');
        const start = cursor ? Number(cursor) : 0;
        const page = all.slice(start, start + 20);
        return runsAnswer(page, start + 20 < all.length ? String(start + 20) : null);
      });
      const panel = new SettingChecksPanel(root, { fetcher: app.fetcher, configFetcher: fakeFetcher(() => ({ ok: false, status: 404 })).fetcher, config: ENFORCE, locale: 'en' });
      await panel.mount();
      await panel.selectTab('runs');
      await flush();
      const runs = view(root, 'runs');
      expect(runs.querySelectorAll('tbody tr').length).toBe(20);
      for (let page = 0; page < 2; page += 1) {
        const more = buttonsByText(runs, 'Load more runs');
        expect(more.length).toBe(1);
        more[0].click();
        await flush();
        await flush();
      }
      expect(runs.querySelectorAll('tbody tr').length).toBe(60);
      expect(buttonsByText(runs, 'Load more runs')).toEqual([]);
      expect(app.calls.map((c) => c.path)).toEqual([
        '/api/rag/admin/eval-run-requests?limit=20',
        '/api/rag/admin/eval-run-requests?limit=20&cursor=20',
        '/api/rag/admin/eval-run-requests?limit=20&cursor=40',
      ]);
    });
  });

  it('hides the workspace column in single-tenant mode and renders the empty state with no runs', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'enforce');
      let requests: unknown[] = [run({ tenant_key: 's:default' })];
      const app = fakeFetcher(() => runsAnswer(requests));
      const panel = new SettingChecksPanel(root, {
        fetcher: app.fetcher,
        configFetcher: fakeFetcher(() => ({ ok: false, status: 404 })).fetcher,
        config: () => ({ RAG_CONFIG_GATE: 'enforce', NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant' }),
        locale: 'en',
      });
      await panel.mount();
      await panel.selectTab('runs');
      await flush();
      const runs = view(root, 'runs');
      expect(text(runs.querySelector('thead'))).not.toContain('Workspace');
      expect(runs.querySelector('[data-setting-checks-workspace]')).toBeNull();
      requests = [];
      buttonsByText(runs, 'Refresh runs')[0].click();
      await flush();
      await flush();
      expect(text(runs)).toContain('No evaluation runs requested');
    });
  });

  it('a 401 on the runs route shows the sign-in alert instead of the list', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'enforce');
      const panel = new SettingChecksPanel(root, {
        fetcher: fakeFetcher(() => ({ ok: false, status: 401 })).fetcher,
        configFetcher: fakeFetcher(() => ({ ok: false, status: 404 })).fetcher,
        config: ENFORCE,
        locale: 'en',
      });
      await panel.mount();
      await panel.selectTab('runs');
      await flush();
      const runs = view(root, 'runs');
      expect(text(runs)).toContain('Admin sign-in required');
      expect(runs.querySelector('table')).toBeNull();
    });
  });

  it('moves the gate group into Settings once and recomputes the combination notes on change', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      const { group, gate, live, block } = settingsBlock(doc, 'off');
      const panel = new SettingChecksPanel(root, {
        fetcher: fakeFetcher(() => runsAnswer([])).fetcher,
        configFetcher: fakeFetcher(() => ({ ok: false, status: 404 })).fetcher,
        config: OFF,
        locale: 'en',
      });
      await panel.mount();
      const settings = view(root, 'settings');
      expect(group.parentNode).toBe(settings);
      expect(block.querySelector('[data-rag-settings-group="gate"]')).toBeNull();
      gate.value = 'enforce';
      gate.dispatch('change');
      expect(text(settings)).toContain('Consider running in warn mode first');
      expect(text(root.querySelector('[data-setting-checks-summary]'))).toContain('The mode you selected applies after you save it.');
      gate.value = 'off';
      live.value = 'true';
      live.dispatch('change');
      expect(text(settings)).toContain('The live model check has no effect while setting checks are off.');
      expect(text(settings)).not.toContain('Consider running in warn mode first');
      expect(text(root.querySelector('[data-setting-checks-summary]'))).not.toContain('The mode you selected applies');
      await panel.refresh();
      expect(settings.querySelectorAll('[data-rag-settings-group="gate"]').length).toBe(1);
    });
  });

  it('translates the moved group in zh and it', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      const { label } = settingsBlock(doc, 'off');
      const panel = new SettingChecksPanel(root, { fetcher: fakeFetcher(() => runsAnswer([])).fetcher, configFetcher: fakeFetcher(() => ({ ok: false, status: 404 })).fetcher, config: OFF, locale: 'zh' });
      await panel.mount();
      expect(text(label)).toBe('保存前检查设置');
      expect(root.getAttribute('lang')).toBe('zh');
    });
  });

  it('a second mount keeps the selected sub-tab', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'enforce');
      const app = fakeFetcher(() => runsAnswer([run()]));
      const panel = new SettingChecksPanel(root, { fetcher: app.fetcher, configFetcher: fakeFetcher(() => ({ ok: false, status: 404 })).fetcher, config: ENFORCE, locale: 'en' });
      await panel.mount();
      await panel.selectTab('runs');
      await flush();
      await panel.mount();
      await flush();
      expect(panel.current).toBe('runs');
      const tab = root.querySelector('[data-setting-checks-tab="runs"]');
      expect(tab?.getAttribute('aria-selected')).toBe('true');
      expect(view(root, 'runs').hidden).toBe(false);
      expect(root.querySelectorAll('[role="tablist"]').length).toBe(1);
    });
  });

  it('initSettingChecksPanel twice keeps the selected sub-tab', async () => {
    await withDoc(async (doc) => {
      const mod = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'off');
      const holder = globalThis as unknown as { window?: Record<string, unknown> };
      const previous = holder.window;
      holder.window = { configManager: { savedConfig: OFF() }, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) };
      try {
        mod.initSettingChecksPanel();
        await flush();
        const tab = root.querySelector('[data-setting-checks-tab="settings"]') as FakeElement;
        tab.click();
        await flush();
        mod.initSettingChecksPanel();
        await flush();
        expect(root.querySelector('[data-setting-checks-tab="settings"]')?.getAttribute('aria-selected')).toBe('true');
        expect(root.querySelectorAll('[role="tablist"]').length).toBe(1);
      } finally {
        holder.window = previous;
      }
    });
  });

  it('inserts server strings as text only', async () => {
    await withDoc(async (doc) => {
      const { SettingChecksPanel } = load();
      const root = panelRoot(doc);
      settingsBlock(doc, 'enforce');
      const cfg = fakeFetcher(() => ({
        ok: true,
        status: 200,
        body: check({
          changed_keys: [XSS],
          saved_as: XSS,
          layers: [{ layer: 'deterministic', result: XSS, reason: XSS, checks: [{ check: XSS, slice: XSS, measured: 1, result: 'fail' }] }],
        }),
      }));
      const app = fakeFetcher(() => runsAnswer([run({ tenant_key: XSS, reason: XSS, status: 'skipped', skip_reason: XSS }), run({ id: 'r-02', status: 'done', result: 'fail', checks: [XSS] })]));
      const panel = new SettingChecksPanel(root, { fetcher: app.fetcher, configFetcher: cfg.fetcher, config: ENFORCE, locale: 'en' });
      await panel.mount();
      await flush();
      await panel.selectTab('runs');
      await flush();
      expect(text(root)).toContain(XSS);
      expect(injectedElements(root)).toEqual([]);
    });
  });
});

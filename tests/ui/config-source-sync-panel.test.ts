import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const panelFile = path.join(configUiDir, 'rag-panels/source-sync.js');
const statusMonitorFile = path.join(configUiDir, 'document-processing/status-monitor.js');

type Locale = 'en' | 'zh' | 'it';
type Row = Record<string, unknown>;

interface SourceSyncModule {
  SOURCE_SYNC_LABELS: Record<Locale, Record<string, string>>;
  sourceSyncLabel: (key: string, locale: Locale, vars?: Record<string, unknown>) => string;
  buildSourceSyncRowView: (row: Row, locale: Locale, limits?: Row, now?: number) => Record<string, any>;
  buildPausedRunView: (run: Row, locale: Locale, now?: number, limits?: Row) => Record<string, any>;
  mapSourceSyncError: (result: Row, locale: Locale, context?: string, appUrl?: string) => Record<string, any>;
  sourceSyncSortRows: (rows: Row[]) => Row[];
}

function loadModule(): SourceSyncModule {
  return require(panelFile) as SourceSyncModule;
}

const NOW = Date.parse('2026-11-20T10:00:00Z');
const LIMITS = { max_age_days: 7, max_delete_share: 0.3 };
const CONN_A = '11111111-1111-4111-8111-111111111111';
const CONN_B = '22222222-2222-4222-8222-222222222222';
const CONN_C = '33333333-3333-4333-8333-333333333333';
const RUN_B = '44444444-4444-4444-8444-444444444444';

function pausedRun(overrides: Row = {}): Row {
  return {
    id: RUN_B,
    found_at: '2026-11-20T09:00:00Z',
    expires_at: '2026-11-21T09:00:00Z',
    candidate_count: 25,
    total_count: 40,
    file_names: ['file-a.pdf', 'file-b.pdf'],
    names_not_sent: 23,
    ...overrides,
  };
}

function rowA(overrides: Row = {}): Row {
  return {
    id: CONN_A,
    provider: 'provider-a',
    provider_name: 'Provider A',
    owner: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'owner-a' },
    workspace_key: 'u:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'connected',
    document_count: 412,
    connected_at: '2026-10-01T10:00:00Z',
    last_full_reconcile_at: '2026-11-18T10:00:00Z',
    states: ['in_step'],
    reason: null,
    days_without_reconcile: 2,
    deletion_mode: null,
    paused_run: null,
    ...overrides,
  };
}

function rowB(overrides: Row = {}): Row {
  return rowA({
    id: CONN_B,
    provider_name: 'Provider B',
    owner: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'owner-b' },
    workspace_key: 'u:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    document_count: 40,
    last_full_reconcile_at: '2026-11-11T10:00:00Z',
    states: ['overdue', 'paused'],
    reason: null,
    days_without_reconcile: 9,
    deletion_mode: 'purge',
    paused_run: pausedRun(),
    ...overrides,
  });
}

function rowC(overrides: Row = {}): Row {
  return rowA({
    id: CONN_C,
    provider_name: 'Provider C',
    owner: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', label: 'owner-c' },
    workspace_key: 's:default',
    document_count: 8,
    connected_at: '2026-11-17T10:00:00Z',
    last_full_reconcile_at: null,
    states: ['not_run'],
    days_without_reconcile: null,
    deletion_mode: 'soft',
    ...overrides,
  });
}

function listBody(items: Row[], extra: Row = {}): Row {
  return { success: true, total: items.length, limit: 50, offset: 0, limits: LIMITS, items, ...extra };
}

describe('buildSourceSyncRowView', () => {
  it('maps a wire row to the 6.3 view: names, key, count, times, badges and mode help', () => {
    const { buildSourceSyncRowView } = loadModule();
    const view = buildSourceSyncRowView(rowA(), 'en', LIMITS, NOW);
    expect(view.id).toBe(CONN_A);
    expect(view.connection).toBe('Provider A');
    expect(view.owner).toBe('owner-a');
    expect(view.workspaceKey).toBe('u:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(view.documents).toBe('412');
    expect(view.never).toBe(false);
    expect(view.lastReconcile.iso).toBe('2026-11-18T10:00:00Z');
    expect(view.lastReconcile.relative).toBe('2 days ago');
    expect(view.lastReconcile.absolute).toBeTruthy();
    expect(view.badges.map((b: Row) => b.state)).toEqual(['in_step']);
    expect(view.badges[0].label).toBe('In step');
    expect(view.badges[0].icon).toBe('bi-check-circle');
    expect(view.mode).toBe('');
    expect(view.modeHelp).toMatch(/^Follows the ingestion pipeline settings/);
    expect(view.pausedRun).toBeNull();
  });

  it('puts Paused before Overdue and gives the overdue reason with the day count and limit', () => {
    const { buildSourceSyncRowView } = loadModule();
    const view = buildSourceSyncRowView(rowB(), 'en', LIMITS, NOW);
    expect(view.badges.map((b: Row) => b.state)).toEqual(['paused', 'overdue']);
    expect(view.reasonLines).toEqual(['Days without a completed full reconcile: 9. Limit: 7.']);
    expect(view.mode).toBe('purge');
    expect(view.modeHelp).toMatch(/Cannot be undone\.$/);
    expect(view.pausedRun).not.toBeNull();
  });

  it('a connection that never reconciled shows Never, the connected time and Not run yet', () => {
    const { buildSourceSyncRowView } = loadModule();
    const view = buildSourceSyncRowView(rowC(), 'en', LIMITS, NOW);
    expect(view.never).toBe(true);
    expect(view.neverLabel).toBe('Never');
    expect(view.connectedLine).toBe('Connected 3 days ago');
    expect(view.badges[0].label).toBe('Not run yet');
    expect(view.badges[0].className).toContain('badge-ghost');
  });

  it('an unknown state is shown as the raw value in monospace', () => {
    const { buildSourceSyncRowView } = loadModule();
    const view = buildSourceSyncRowView(rowA({ states: ['mystery_state'] }), 'en', LIMITS, NOW);
    expect(view.badges[0]).toMatchObject({ state: 'mystery_state', label: 'mystery_state', unknown: true, icon: null });
  });

  it('carries only the contracted fields: server text beyond names, keys and file names never reaches the view', () => {
    const { buildSourceSyncRowView } = loadModule();
    const view = buildSourceSyncRowView(
      rowB({ reason: 'MARKER_REASON', status: 'MARKER_STATUS', secret: 'MARKER_SECRET', owner: { id: 'MARKER_OWNER_ID', label: 'owner-b' } }),
      'en',
      LIMITS,
      NOW,
    );
    const text = JSON.stringify(view);
    expect(text).not.toContain('MARKER_');
  });

  it('localizes badges and help lines in zh and it', () => {
    const { buildSourceSyncRowView } = loadModule();
    expect(buildSourceSyncRowView(rowB(), 'zh', LIMITS, NOW).badges[0].label).toBe('已暂停');
    expect(buildSourceSyncRowView(rowB(), 'it', LIMITS, NOW).badges[1].label).toBe('In ritardo');
  });
});

describe('buildPausedRunView', () => {
  it('gives the count, total, percent and limit, both times, at most 20 names and the not-shown count', () => {
    const { buildPausedRunView } = loadModule();
    const names = Array.from({ length: 25 }, (_, i) => `file-${i}.pdf`);
    const view = buildPausedRunView(pausedRun({ file_names: names, names_not_sent: 5 }), 'en', NOW, LIMITS);
    expect(view.expired).toBe(false);
    expect(view.body).toBe('Documents whose file is missing at the source: 25 of 40 (63%). That is above the 30% limit, so nothing was removed.');
    expect(view.foundAt.iso).toBe('2026-11-20T09:00:00Z');
    expect(view.expiresAt.iso).toBe('2026-11-21T09:00:00Z');
    expect(view.names).toHaveLength(20);
    expect(view.filesSummary).toBe('Show files: 25');
    expect(view.filesMore).toBe('Not shown: 10');
  });

  it('uses paused.bodyAll when every document would be removed', () => {
    const { buildPausedRunView } = loadModule();
    const view = buildPausedRunView(pausedRun({ candidate_count: 40, total_count: 40 }), 'en', NOW, LIMITS);
    expect(view.body).toBe('The source returned no files. All documents of this connection (40) would be removed, so nothing was removed.');
  });

  it('turns into the expired form once expires_at has passed', () => {
    const { buildPausedRunView } = loadModule();
    const view = buildPausedRunView(pausedRun({ expires_at: '2026-11-20T09:59:00Z' }), 'en', NOW, LIMITS);
    expect(view.expired).toBe(true);
    expect(view.expiredBody).toMatch(/^This paused run is older than 24 hours/);
  });

  it('lists file ids when the server sends no names', () => {
    const { buildPausedRunView } = loadModule();
    const view = buildPausedRunView(pausedRun({ file_names: [], file_ids: ['id-1', 'id-2'], names_not_sent: 25 }), 'en', NOW, LIMITS);
    expect(view.names).toEqual([]);
    expect(view.ids).toEqual(['id-1', 'id-2']);
  });
});

describe('mapSourceSyncError', () => {
  it('maps every status and code of UI-SPEC 8.2', () => {
    const { mapSourceSyncError } = loadModule();
    expect(mapSourceSyncError({ thrown: true }, 'en', 'list').key).toBe('error.network');
    expect(mapSourceSyncError({ status: 401, body: { error: 'Unauthorized' } }, 'en', 'list', 'http://app.local').message).toContain('http://app.local');
    expect(mapSourceSyncError({ status: 403, body: { error: 'Forbidden' } }, 'en', 'list').key).toBe('error.signIn');
    expect(mapSourceSyncError({ status: 503, body: {} }, 'en', 'list').key).toBe('list.unavailable');
    expect(mapSourceSyncError({ status: 500, body: {} }, 'en', 'list').key).toBe('list.unavailable');
    expect(mapSourceSyncError({ status: 503, body: {} }, 'en', 'mode').key).toBe('error.unavailable');
    expect(mapSourceSyncError({ status: 404, body: { error: 'not_found' } }, 'en', 'mode')).toMatchObject({ key: 'error.connectionGone', reload: true });
    expect(mapSourceSyncError({ status: 400, body: {} }, 'en', 'mode').key).toBe('mode.failed');
    expect(mapSourceSyncError({ status: 500, body: {} }, 'en', 'mode').key).toBe('mode.failed');
    expect(mapSourceSyncError({ status: 409, body: { error: 'confirmation_expired' } }, 'en', 'confirm')).toMatchObject({ key: 'expired.body', expired: true });
    expect(mapSourceSyncError({ status: 409, body: { error: 'run_not_pending' } }, 'en', 'dismiss')).toMatchObject({ key: 'error.runGone', reload: true });
    expect(mapSourceSyncError({ status: 404, body: { error: 'not_found' } }, 'en', 'confirm')).toMatchObject({ key: 'error.runGone', reload: true });
    expect(mapSourceSyncError({ status: 502, body: {} }, 'en', 'confirm').key).toBe('remove.failed');
  });

  it('appends an unknown code to the generic sentence', () => {
    const { mapSourceSyncError } = loadModule();
    const mapped = mapSourceSyncError({ status: 418, body: { error: 'odd_code' } }, 'en', 'dismiss');
    expect(mapped.key).toBe('error.generic');
    expect(mapped.message).toContain('418');
    expect(mapped.code).toBe('odd_code');
  });
});

describe('sourceSyncSortRows', () => {
  it('orders paused, overdue, failed or incomplete, then the rest; then provider and owner', () => {
    const { sourceSyncSortRows } = loadModule();
    const failed = rowA({ id: 'f', provider_name: 'Provider F', states: ['failed'] });
    const overdue = rowA({ id: 'o', provider_name: 'Provider O', states: ['overdue'] });
    const order = sourceSyncSortRows([rowA(), failed, overdue, rowB(), rowC()]).map((r) => r.id);
    expect(order).toEqual([CONN_B, 'o', 'f', CONN_A, CONN_C]);
  });
});

describe('labels', () => {
  it('every key exists in en, zh and it', () => {
    const { SOURCE_SYNC_LABELS } = loadModule();
    const keys = Object.keys(SOURCE_SYNC_LABELS.en);
    expect(keys.length).toBeGreaterThan(60);
    for (const loc of ['zh', 'it'] as const) {
      expect(Object.keys(SOURCE_SYNC_LABELS[loc]).sort()).toEqual([...keys].sort());
    }
  });
});

// ---------------------------------------------------------------- fake DOM

interface Call {
  path: string;
  init: Record<string, unknown>;
}

type Responder = (call: Call) => Row | Promise<Row>;

function setupPanel(responder: Responder, opts: { language?: string } = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('section');
  root.id = 'rag-administration-source-sync';
  const title = doc.createElement('h3');
  title.setAttribute('data-source-sync-title', '');
  const desc = doc.createElement('p');
  desc.setAttribute('data-source-sync-description', '');
  const alertHost = doc.createElement('div');
  alertHost.setAttribute('data-source-sync-alert', '');
  const content = doc.createElement('div');
  content.setAttribute('data-source-sync-content', '');
  const settings = doc.createElement('div');
  settings.id = 'rag-source-sync-settings';
  settings.setAttribute('data-source-sync-settings', '');
  const field = doc.createElement('input');
  field.id = 'RAG_SOURCE_RECONCILE_INTERVAL_DAYS';
  settings.appendChild(field);
  const openModes = doc.createElement('button');
  openModes.setAttribute('data-source-sync-open-rag-modes', '');
  settings.appendChild(openModes);
  const status = doc.createElement('div');
  status.setAttribute('data-source-sync-status', '');
  status.setAttribute('role', 'status');
  root.append(title, desc, alertHost, content, settings, status);
  doc.body.appendChild(root);
  const tabLink = doc.createElement('a');
  tabLink.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(tabLink);
  const connectorsLink = doc.createElement('a');
  connectorsLink.setAttribute('data-tab', 'connectors');
  doc.body.appendChild(connectorsLink);

  const calls: Call[] = [];
  const context: Record<string, unknown> = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: opts.language ?? 'en-US' },
    location: { origin: 'http://config.local', search: '' },
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    Intl,
    Date,
    ragFetch: async (p: string, init: Record<string, unknown>) => {
      const call = { path: p, init: init || {} };
      calls.push(call);
      return responder(call);
    },
  };
  context.window = context;
  vm.createContext(context);
  new vm.Script(fs.readFileSync(statusMonitorFile, 'utf8'), { filename: 'status-monitor.js' }).runInContext(context);
  new vm.Script(fs.readFileSync(panelFile, 'utf8'), { filename: 'source-sync.js' }).runInContext(context);
  return { doc, root, context, calls, status, alertHost, content, tabLink, connectorsLink };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function ok(body: Row): Row {
  return { ok: true, status: 200, body };
}

function byText(root: FakeElement, tag: string, text: string): FakeElement | undefined {
  return root.querySelectorAll(tag).find((el) => el.textContent.trim() === text || el.textContent.includes(text));
}

async function mounted(responder: Responder, opts: { language?: string } = {}) {
  const env = setupPanel(responder, opts);
  (env.context.initSourceSyncPanel as () => void)();
  await flush();
  return env;
}

describe('SourceSyncPanel in a fake DOM', () => {
  it('mount requests the first page and renders the table with the paused row and its block', async () => {
    const env = await mounted(() => ok(listBody([rowA(), rowB()])));
    expect(env.calls[0]!.path).toBe('admin/source-sync/connections?limit=50&offset=0');
    expect(env.calls[0]!.init.method).toBe('GET');
    const table = env.root.querySelector('table');
    expect(table).toBeTruthy();
    expect(table!.querySelector('caption')!.textContent).toBe('Connections and their reconcile status');
    const rowHeaders = table!.querySelectorAll('th').filter((th) => th.getAttribute('scope') === 'row');
    expect(rowHeaders.map((th) => th.querySelector('div')!.textContent)).toEqual(['Provider B', 'Provider A']);
    const group = env.root.querySelector('[role="group"]');
    expect(group).toBeTruthy();
    expect(group!.getAttribute('aria-label')).toBe('Paused run for Provider B');
    expect(byText(group!, 'button', 'Dismiss run')).toBeTruthy();
    expect(byText(group!, 'button', 'Remove documents…')).toBeTruthy();
    const region = env.root.querySelector('[role="region"]');
    expect(region!.getAttribute('tabindex')).toBe('0');
    expect(env.status.textContent).toBe('Connections loaded: 2. Overdue: 1. Paused: 1.');
  });

  it('shows the overdue summary alert naming the command, without a live role', async () => {
    const env = await mounted(() => ok(listBody([rowA(), rowB()])));
    const summary = env.root.querySelectorAll('.alert-warning').find((el) => el.textContent.includes('Connections past the reconcile age limit: 1.'));
    expect(summary).toBeTruthy();
    expect(summary!.getAttribute('role')).toBeNull();
    expect(summary!.querySelector('code')!.textContent).toBe('npm run rag:source-reconcile');
  });

  it('Dismiss run posts to the run, reloads the list and announces dismiss.done', async () => {
    let dismissed = false;
    const env = await mounted((call) => {
      if (call.path.endsWith('/dismiss')) {
        dismissed = true;
        return ok({ success: true, status: 'dismissed' });
      }
      return ok(listBody(dismissed ? [rowA(), rowB({ states: ['overdue'], paused_run: null })] : [rowA(), rowB()]));
    });
    const button = byText(env.root.querySelector('[role="group"]')!, 'button', 'Dismiss run')!;
    button.click();
    await flush();
    const dismissCall = env.calls.find((c) => c.path.endsWith('/dismiss'))!;
    expect(dismissCall.path).toBe(`admin/source-sync/runs/${RUN_B}/dismiss`);
    expect(dismissCall.init.method).toBe('POST');
    expect(env.calls.filter((c) => c.path.startsWith('admin/source-sync/connections?')).length).toBe(2);
    expect(env.status.textContent).toBe('Run dismissed. No document was removed.');
    expect(env.root.querySelector('[role="group"]')).toBeNull();
  });

  it('the Settings sub-tab holds the moved static fields and the tabs use the tablist roles', async () => {
    const env = await mounted(() => ok(listBody([rowA()])));
    const tablist = env.root.querySelector('[role="tablist"]')!;
    const tabs = tablist.querySelectorAll('[role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual(['Connections', 'Settings']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    const settingsPanel = env.doc.getElementById(tabs[1]!.getAttribute('aria-controls')!)!;
    expect(settingsPanel.querySelector('#RAG_SOURCE_RECONCILE_INTERVAL_DAYS')).toBeTruthy();
    expect(settingsPanel.hidden).toBe(true);
    tabs[1]!.click();
    expect(settingsPanel.hidden).toBe(false);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    tabs[1]!.dispatch('keydown', { key: 'ArrowLeft' });
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(env.doc.activeElement).toBe(tabs[0]);
  });

  it('a second init refreshes instead of mounting again', async () => {
    const env = await mounted(() => ok(listBody([rowA()])));
    (env.context.initSourceSyncPanel as () => void)();
    await flush();
    expect(env.root.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(env.calls.length).toBe(2);
  });

  it('the panel offers no control that starts a reconcile', async () => {
    const env = await mounted(() => ok(listBody([rowA(), rowB(), rowC()])));
    const buttons = env.root.querySelectorAll('button').map((b) => b.textContent);
    expect(buttons.some((t) => /reconcile|run now|sync now/i.test(t))).toBe(false);
    expect(env.calls.every((c) => c.path.startsWith('admin/source-sync/'))).toBe(true);
  });

  it('localizes the panel in zh and sets lang on the root', async () => {
    const env = await mounted(() => ok(listBody([rowB()])), { language: 'zh-CN' });
    expect(env.root.getAttribute('lang')).toBe('zh');
    expect(env.root.querySelector('[data-source-sync-title]')!.textContent).toBe('来源同步');
    expect(byText(env.root, 'button', '忽略此次运行')).toBeTruthy();
  });
});

describe('index.html loads the panel', () => {
  it('loads rag-panels/source-sync.js once, after rag-panels/ingestion.js', () => {
    const html = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
    const tags = html.match(/<script src="rag-panels\/source-sync\.js"><\/script>/g) || [];
    expect(tags).toHaveLength(1);
    expect(html.indexOf('rag-panels/source-sync.js')).toBeGreaterThan(html.indexOf('rag-panels/ingestion.js'));
  });
});


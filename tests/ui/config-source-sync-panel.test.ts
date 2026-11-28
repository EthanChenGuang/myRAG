import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';

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
    expires_at: '2099-01-01T09:00:00Z',
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
    expect(view.expiresAt.iso).toBe('2099-01-01T09:00:00Z');
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

describe('purge-cap pause (D-49)', () => {
  const CAP_TEXT = {
    en: 'The source reported 4 deleted files after this connection reached its daily purge limit of 3, so they were not purged.',
    zh: '该连接已达到每日 3 个的清除上限，来源之后报告删除的 4 个文件因此没有被清除。',
    it: 'La fonte ha segnalato 4 file eliminati dopo che questa connessione ha raggiunto il limite giornaliero di 3 eliminazioni definitive, quindi non sono stati eliminati.',
  } as const;

  it('uses paused.bodyCap with the count and the cap in en, zh and it, never the share sentence', () => {
    const { buildPausedRunView, SOURCE_SYNC_LABELS } = loadModule();
    for (const locale of ['en', 'zh', 'it'] as const) {
      const run = pausedRun({ candidate_count: 4, total_count: null, pause_reason: 'purge_daily_cap', daily_cap: 3 });
      const view = buildPausedRunView(run, locale, NOW, LIMITS);
      expect(view.body, locale).toBe(CAP_TEXT[locale]);
      const share = buildPausedRunView(pausedRun(), locale, NOW, LIMITS);
      expect(view.body).not.toBe(share.body);
      expect(SOURCE_SYNC_LABELS[locale]['paused.bodyCap']).toBeTruthy();
    }
    const fromLimits = buildPausedRunView(pausedRun({ candidate_count: 4, pause_reason: 'purge_daily_cap' }), 'en', NOW, { ...LIMITS, purge_daily_cap: 3 });
    expect(fromLimits.body).toBe(CAP_TEXT.en);
  });

  it('a share pause view is unchanged whether pause_reason is share or absent', () => {
    const { buildPausedRunView } = loadModule();
    expect(buildPausedRunView(pausedRun({ pause_reason: 'share' }), 'en', NOW, LIMITS)).toEqual(buildPausedRunView(pausedRun(), 'en', NOW, LIMITS));
  });

  it('builds one paused view per entry of paused_runs, newest first, and falls back to paused_run', () => {
    const { buildSourceSyncRowView } = loadModule();
    const capRun = pausedRun({ id: 'run-cap', candidate_count: 4, total_count: null, pause_reason: 'purge_daily_cap', daily_cap: 3 });
    const shareRun = pausedRun();
    const both = buildSourceSyncRowView(rowB({ paused_run: capRun, paused_runs: [capRun, shareRun] }), 'en', LIMITS, NOW);
    expect(both.pausedRuns.map((run: Row) => run.id)).toEqual(['run-cap', RUN_B]);
    expect(both.pausedRun.id).toBe('run-cap');
    const legacy = buildSourceSyncRowView(rowB(), 'en', LIMITS, NOW);
    expect(legacy.pausedRuns.map((run: Row) => run.id)).toEqual([RUN_B]);
    expect(buildSourceSyncRowView(rowA(), 'en', LIMITS, NOW).pausedRuns).toEqual([]);
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

  it('renders one paused block per open run, each with its own sentence and buttons (D-49)', async () => {
    const capRun = pausedRun({ id: 'run-cap', candidate_count: 4, total_count: null, pause_reason: 'purge_daily_cap', daily_cap: 3, file_names: [], file_ids: ['src-1'] });
    const env = await mounted(() => ok(listBody([rowB({ paused_run: capRun, paused_runs: [capRun, pausedRun()] })])));
    const groups = env.root.querySelectorAll('[role="group"]');
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.getAttribute('data-source-sync-run'))).toEqual(['run-cap', RUN_B]);
    expect(groups[0]!.textContent).toContain('daily purge limit of 3');
    expect(groups.map((g) => g.getAttribute('aria-describedby'))).toEqual(['source-sync-run-body-run-cap', `source-sync-run-body-${RUN_B}`]);
    expect(groups[1]!.textContent).toContain('That is above the 30% limit');
    for (const group of groups) {
      expect(byText(group, 'button', 'Dismiss run')).toBeTruthy();
      expect(byText(group, 'button', 'Remove documents…')).toBeTruthy();
    }
    byText(groups[0]!, 'button', 'Dismiss run')!.click();
    await flush();
    const dismissCall = env.calls.find((c) => c.path.endsWith('/dismiss'))!;
    expect(dismissCall.path).toBe('admin/source-sync/runs/run-cap/dismiss');
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


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function modeSelect(root: FakeElement, id: string): FakeElement {
  const el = root.querySelector(`[data-source-sync-mode="${id}"]`);
  expect(el, `mode select for ${id}`).toBeTruthy();
  return el!;
}

function choose(select: FakeElement, value: string) {
  select.value = value;
  select.dispatch('change');
}

function openDialog(doc: FakeDocument): FakeElement | undefined {
  return doc.querySelectorAll('dialog').find((d) => d.open);
}

function listResponder(rows: () => Row[], extra: Record<string, Responder> = {}): Responder {
  return (call) => {
    for (const [suffix, fn] of Object.entries(extra)) if (call.path.includes(suffix)) return fn(call);
    return ok(listBody(rows()));
  };
}

describe('deletion mode select', () => {
  it('Soft delete saves at once: select disabled with Saving… in place of the help line, then mode.saved', async () => {
    const gate = deferred<Row>();
    const env = await mounted(listResponder(() => [rowA()], { 'deletion-mode': () => gate.promise }));
    const select = modeSelect(env.root, CONN_A);
    choose(select, 'soft');
    await flush(2);
    const put = env.calls.find((c) => c.path.endsWith('/deletion-mode'))!;
    expect(put.path).toBe(`admin/source-sync/connections/${CONN_A}/deletion-mode`);
    expect(put.init.method).toBe('PUT');
    expect(JSON.parse(String(put.init.body))).toEqual({ mode: 'soft' });
    expect(select.disabled).toBe(true);
    const help = env.doc.getElementById(select.getAttribute('aria-describedby')!)!;
    expect(help.textContent).toContain('Saving…');
    gate.resolve(ok({ success: true, id: CONN_A, deletion_mode: 'soft' }));
    await flush();
    expect(select.disabled).toBe(false);
    expect(help.textContent).toMatch(/^The document stops being used in answers/);
    expect(env.status.textContent).toBe('Deletion mode for Provider A: Soft delete. It applies to deletions from now on.');
    expect(openDialog(env.doc)).toBeUndefined();
  });

  it('Default sends mode null', async () => {
    const env = await mounted(listResponder(() => [rowC()], { 'deletion-mode': () => ok({ success: true, id: CONN_C, deletion_mode: null }) }));
    choose(modeSelect(env.root, CONN_C), '');
    await flush();
    const put = env.calls.find((c) => c.path.endsWith('/deletion-mode'))!;
    expect(JSON.parse(String(put.init.body))).toEqual({ mode: null });
  });

  it('Purge mode dialog: nothing is saved before the dialog, Keep restores the previous value and focuses the select', async () => {
    const env = await mounted(listResponder(() => [rowA()], { 'deletion-mode': () => ok({ success: true }) }));
    const select = modeSelect(env.root, CONN_A);
    choose(select, 'purge');
    await flush(2);
    expect(env.calls.some((c) => c.path.endsWith('/deletion-mode'))).toBe(false);
    const dialog = openDialog(env.doc)!;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('lang')).toBe('en');
    expect(dialog.querySelector('h3')!.textContent).toBe('Use Purge mode for Provider A?');
    expect(dialog.textContent).toContain('more than 30% of this connection');
    expect(env.doc.activeElement!.textContent).toBe('Keep current mode');
    byText(dialog, 'button', 'Keep current mode')!.click();
    await flush(2);
    expect(select.value).toBe('');
    expect(env.doc.activeElement).toBe(select);
    expect(env.calls.some((c) => c.path.endsWith('/deletion-mode'))).toBe(false);
  });

  it('Purge mode dialog: Escape restores the previous value', async () => {
    const env = await mounted(listResponder(() => [rowC()], { 'deletion-mode': () => ok({ success: true }) }));
    const select = modeSelect(env.root, CONN_C);
    choose(select, 'purge');
    const dialog = openDialog(env.doc)!;
    const cancel = dialog.dispatch('cancel');
    expect(cancel.defaultPrevented).toBe(false);
    dialog.close();
    await flush(2);
    expect(select.value).toBe('soft');
    expect(env.calls.some((c) => c.path.endsWith('/deletion-mode'))).toBe(false);
  });

  it('Purge mode dialog: Use Purge mode saves purge', async () => {
    const env = await mounted(listResponder(() => [rowA()], { 'deletion-mode': () => ok({ success: true, id: CONN_A, deletion_mode: 'purge' }) }));
    const select = modeSelect(env.root, CONN_A);
    choose(select, 'purge');
    byText(openDialog(env.doc)!, 'button', 'Use Purge mode')!.click();
    await flush();
    const put = env.calls.find((c) => c.path.endsWith('/deletion-mode'))!;
    expect(JSON.parse(String(put.init.body))).toEqual({ mode: 'purge' });
    expect(select.value).toBe('purge');
    expect(env.status.textContent).toContain('Purge');
  });

  it('a refused save restores the value and shows mode.failed in a role=alert line, cleared on the next change', async () => {
    let fail = true;
    const env = await mounted(listResponder(() => [rowC()], {
      'deletion-mode': () => (fail ? { ok: false, status: 500, body: { error: 'unavailable' } } : ok({ success: true })),
    }));
    const select = modeSelect(env.root, CONN_C);
    choose(select, '');
    await flush();
    expect(select.value).toBe('soft');
    const alert = env.root.querySelectorAll('[role="alert"]').find((el) => el.textContent === 'The deletion mode was not changed. Try again.');
    expect(alert).toBeTruthy();
    fail = false;
    choose(select, '');
    await flush();
    expect(env.root.querySelectorAll('[role="alert"]').some((el) => el.textContent.includes('was not changed'))).toBe(false);
  });

  it('a 404 announces error.connectionGone and reloads the list', async () => {
    const env = await mounted(listResponder(() => [rowA()], { 'deletion-mode': () => ({ ok: false, status: 404, body: { success: false, error: 'not_found' } }) }));
    choose(modeSelect(env.root, CONN_A), 'soft');
    await flush();
    expect(env.status.textContent).toMatch(/^This connection no longer exists/);
    expect(env.calls.filter((c) => c.path.startsWith('admin/source-sync/connections?')).length).toBe(2);
  });
});

describe('Remove documents', () => {
  it('opens the dialog on Go back with the mode sentence; while running it is inert; then it reloads and announces', async () => {
    const gate = deferred<Row>();
    let confirmed = false;
    const env = await mounted(listResponder(() => (confirmed ? [rowA(), rowB({ paused_run: null, states: ['overdue'] })] : [rowA(), rowB()]), {
      '/confirm': () => gate.promise,
    }));
    byText(env.root.querySelector('[role="group"]')!, 'button', 'Remove documents…')!.click();
    const dialog = openDialog(env.doc)!;
    expect(dialog.querySelector('h3')!.textContent).toBe('Remove documents from Provider B?');
    expect(dialog.textContent).toContain('Documents: 25');
    expect(dialog.textContent).toContain('This cannot be undone.');
    expect(env.doc.activeElement!.textContent).toBe('Go back');
    const confirm = byText(dialog, 'button', 'Remove documents')!;
    const goBack = byText(dialog, 'button', 'Go back')!;
    confirm.click();
    await flush(2);
    const post = env.calls.find((c) => c.path.endsWith('/confirm'))!;
    expect(post.path).toBe(`admin/source-sync/runs/${RUN_B}/confirm`);
    expect(post.init.method).toBe('POST');
    expect(confirm.disabled).toBe(true);
    expect(goBack.disabled).toBe(true);
    expect(confirm.textContent).toContain('Removing…');
    expect(dialog.dispatch('cancel').defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    confirmed = true;
    gate.resolve(ok({ success: true, removed: 25, failed: 0 }));
    await flush();
    expect(dialog.open).toBe(false);
    expect(env.status.textContent).toBe('Removed from Provider B: 25.');
    expect(env.doc.activeElement).toBe(modeSelect(env.root, CONN_B));
  });

  it('a partial removal shows remove.partial in a warning alert above the table', async () => {
    const env = await mounted(listResponder(() => [rowB()], { '/confirm': () => ok({ success: true, removed: 20, failed: 5 }) }));
    byText(env.root.querySelector('[role="group"]')!, 'button', 'Remove documents…')!.click();
    byText(openDialog(env.doc)!, 'button', 'Remove documents')!.click();
    await flush();
    const partial = env.root.querySelectorAll('.alert-warning').find((el) => el.textContent.includes('Not removed: 5.'));
    expect(partial).toBeTruthy();
  });

  it('409 confirmation_expired turns the block into the expired form with only Dismiss run', async () => {
    const env = await mounted(listResponder(() => [rowB()], { '/confirm': () => ({ ok: false, status: 409, body: { success: false, error: 'confirmation_expired' } }) }));
    byText(env.root.querySelector('[role="group"]')!, 'button', 'Remove documents…')!.click();
    byText(openDialog(env.doc)!, 'button', 'Remove documents')!.click();
    await flush();
    const group = env.root.querySelector('[role="group"]')!;
    expect(group.className).not.toContain('alert-warning');
    expect(group.textContent).toContain('older than 24 hours');
    expect(byText(group, 'button', 'Remove documents…')).toBeUndefined();
    expect(byText(group, 'button', 'Dismiss run')).toBeTruthy();
  });

  it('5xx keeps the block with remove.failed in a role=alert line and focus on the used button', async () => {
    const env = await mounted(listResponder(() => [rowB()], { '/confirm': () => ({ ok: false, status: 500, body: { success: false, error: 'unavailable' } }) }));
    byText(env.root.querySelector('[role="group"]')!, 'button', 'Remove documents…')!.click();
    byText(openDialog(env.doc)!, 'button', 'Remove documents')!.click();
    await flush();
    const group = env.root.querySelector('[role="group"]')!;
    const line = group.querySelectorAll('[role="alert"]').find((el) => el.textContent === 'The documents were not removed. Try again.');
    expect(line).toBeTruthy();
    expect(env.doc.activeElement!.textContent).toBe('Remove documents…');
  });

  it('a run handled elsewhere announces error.runGone and reloads', async () => {
    const env = await mounted(listResponder(() => [rowB()], { '/dismiss': () => ({ ok: false, status: 409, body: { success: false, error: 'run_not_pending' } }) }));
    byText(env.root.querySelector('[role="group"]')!, 'button', 'Dismiss run')!.click();
    await flush();
    expect(env.status.textContent).toBe('This run was already confirmed or dismissed. The list was reloaded.');
    expect(env.calls.filter((c) => c.path.startsWith('admin/source-sync/connections?')).length).toBe(2);
  });

  it('Dismiss run shows its in-flight text and disables the sibling button', async () => {
    const gate = deferred<Row>();
    const env = await mounted(listResponder(() => [rowB()], { '/dismiss': () => gate.promise }));
    const group = env.root.querySelector('[role="group"]')!;
    const dismiss = byText(group, 'button', 'Dismiss run')!;
    const remove = byText(group, 'button', 'Remove documents…')!;
    dismiss.click();
    await flush(2);
    expect(dismiss.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(dismiss.textContent).toContain('Dismissing…');
    gate.resolve(ok({ success: true, status: 'dismissed' }));
    await flush();
  });

  it('an expired run by expires_at offers only Dismiss run', async () => {
    const env = await mounted(() => ok(listBody([rowB({ paused_run: pausedRun({ expires_at: '2000-01-01T00:00:00Z' }) })])));
    const group = env.root.querySelector('[role="group"]')!;
    expect(byText(group, 'button', 'Remove documents…')).toBeUndefined();
    expect(byText(group, 'button', 'Dismiss run')).toBeTruthy();
  });

  it('Show files lists ids in monospace when no names are sent, and the not-shown count', async () => {
    const env = await mounted(() => ok(listBody([rowB({ paused_run: pausedRun({ file_names: [], file_ids: ['id-1'], names_not_sent: 25 }) })])));
    const details = env.root.querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Show files: 25');
    const id = details.querySelectorAll('li').find((li) => li.textContent === 'id-1')!;
    expect(id.className).toContain('font-mono');
  });

  it('paused.bodyAll replaces paused.body when the source returned no files', async () => {
    const env = await mounted(() => ok(listBody([rowB({ paused_run: pausedRun({ candidate_count: 40, total_count: 40 }) })])));
    expect(env.root.querySelector('[role="group"]')!.textContent).toContain('The source returned no files.');
  });
});

describe('panel states', () => {
  it('401 replaces the data view with the sign-in sentence and Reload panel; Settings stays usable', async () => {
    const env = await mounted(() => ({ ok: false, status: 401, body: { error: 'Unauthorized' } }));
    expect(env.root.querySelector('table')).toBeNull();
    const warn = env.root.querySelectorAll('.alert-warning').find((el) => el.textContent.includes('Admin sign-in required'));
    expect(warn).toBeTruthy();
    expect(byText(warn!, 'button', 'Reload panel')).toBeTruthy();
    const tabs = env.root.querySelectorAll('[role="tab"]');
    tabs[1]!.click();
    const settingsPanel = env.doc.getElementById(tabs[1]!.getAttribute('aria-controls')!)!;
    expect(settingsPanel.hidden).toBe(false);
  });

  it('503 after a load keeps the table dimmed and shows list.unavailable with Reload panel', async () => {
    let fail = false;
    const env = await mounted(() => (fail ? { ok: false, status: 503, body: {} } : ok(listBody([rowA()]))));
    fail = true;
    byText(env.root, 'button', 'Refresh connections')!.click();
    await flush();
    expect(env.root.querySelector('table')).toBeTruthy();
    const err = env.alertHost.querySelectorAll('.alert-error').find((el) => el.textContent.includes('Connections could not be loaded.'));
    expect(err).toBeTruthy();
    expect(byText(err!, 'button', 'Reload panel')).toBeTruthy();
    const view = env.root.querySelector('[data-source-sync-view]')!;
    expect(view.className).toContain('opacity-60');
  });

  it('a refresh keeps the content at 60% opacity with aria-busy while loading', async () => {
    let gate: ReturnType<typeof deferred<Row>> | null = null;
    const env = await mounted(() => (gate ? gate.promise : ok(listBody([rowA()]))));
    gate = deferred<Row>();
    byText(env.root, 'button', 'Refresh connections')!.click();
    await flush(2);
    const view = env.root.querySelector('[data-source-sync-view]')!;
    expect(view.getAttribute('aria-busy')).toBe('true');
    expect(view.className).toContain('opacity-60');
    expect(env.root.querySelector('table')).toBeTruthy();
    gate.resolve(ok(listBody([rowA()])));
    await flush();
    expect(view.getAttribute('aria-busy')).toBeNull();
  });

  it('first load shows the spinner with the loading text', () => {
    const env = setupPanel(() => new Promise(() => {}));
    (env.context.initSourceSyncPanel as () => void)();
    const view = env.root.querySelector('[data-source-sync-view]')!;
    expect(view.textContent).toContain('Loading connections…');
    expect(view.querySelector('.loading')).toBeTruthy();
  });

  it('empty list shows the empty title and body and Open Connectors opens that tab', async () => {
    const env = await mounted(() => ok(listBody([])));
    expect(env.root.textContent).toContain('No connections to manage');
    let opened = false;
    env.connectorsLink.addEventListener('click', () => {
      opened = true;
    });
    byText(env.root, 'button', 'Open Connectors')!.click();
    expect(opened).toBe(true);
  });

  it('Load more connections requests the next page and appends it', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => rowA({ id: `id-${i}`, provider_name: `Provider ${String(i).padStart(2, '0')}` }));
    const env = await mounted((call) => {
      if (call.path.includes('offset=50')) return ok(listBody([rowA({ id: 'id-50', provider_name: 'Provider 50' })], { total: 51, offset: 50 }));
      return ok(listBody(page1, { total: 51 }));
    });
    byText(env.root, 'button', 'Load more connections')!.click();
    await flush();
    expect(env.calls.at(-1)!.path).toBe('admin/source-sync/connections?limit=50&offset=50');
    expect(env.root.querySelectorAll('select').length).toBe(51);
    expect(byText(env.root, 'button', 'Load more connections')).toBeUndefined();
  });

  it('file names and owner labels render as text only (XSS)', async () => {
    const env = await mounted(() =>
      ok(listBody([rowB({ provider_name: XSS_PAYLOAD, owner: { id: 'x', label: XSS_PAYLOAD }, workspace_key: XSS_PAYLOAD, paused_run: pausedRun({ file_names: [XSS_PAYLOAD] }) })])),
    );
    byText(env.root.querySelector('[role="group"]')!, 'button', 'Remove documents…')!.click();
    expect(injectedElements(env.doc)).toEqual([]);
    expect(env.root.textContent).toContain(XSS_PAYLOAD);
    expect(env.doc.innerHtmlWrites).toBe(0);
  });

  it('source has no innerHTML and no top-level name outside the panel prefixes', () => {
    const source = fs.readFileSync(panelFile, 'utf8');
    expect(source.includes('innerHTML')).toBe(false);
    const names = [...source.matchAll(/^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
    const allowed = /^(SourceSync|SOURCE_SYNC_|sourceSync|buildSourceSyncRowView$|buildPausedRunView$|mapSourceSyncError$|initSourceSyncPanel$|bindSourceSyncPanel$)/;
    expect(names.filter((n) => !allowed.test(n))).toEqual([]);
  });
});

describe('UI review 06.3 fixes', () => {
  it('a list 404 shows the feature-off sentence in a neutral alert, in en, zh and it', async () => {
    for (const [language, loc] of [['en-US', 'en'], ['zh-CN', 'zh'], ['it-IT', 'it']] as const) {
      const env = await mounted(() => ({ ok: false, status: 404, body: { error: 'Not found' } }), { language });
      const { SOURCE_SYNC_LABELS } = loadModule();
      const off = env.root.querySelector('[data-source-sync-off]');
      expect(off).toBeTruthy();
      expect(off!.className).not.toContain('alert-error');
      expect(off!.textContent).toContain(SOURCE_SYNC_LABELS[loc]['error.off']);
      expect(env.root.textContent).not.toContain('404');
      expect(env.alertHost.children).toHaveLength(0);
    }
  });

  it('the paused-run buttons are solid on the amber alert, never white outline', async () => {
    const env = await mounted(() => ok(listBody([rowB()])));
    const group = env.root.querySelector('[role="group"]')!;
    const remove = byText(group, 'button', 'Remove documents…')!;
    const dismiss = byText(group, 'button', 'Dismiss run')!;
    expect(remove.className).toContain('btn-error');
    expect(remove.className).not.toContain('btn-outline');
    expect(dismiss.className).not.toContain('btn-outline');
    expect(dismiss.className).toContain('bg-base-100');
    expect(dismiss.className).toContain('text-base-content');
  });

  it('Reload panel on the error alert is a solid base-100 button', async () => {
    const env = await mounted(() => ({ ok: false, status: 500, body: {} }));
    const reload = byText(env.alertHost, 'button', 'Reload panel')!;
    expect(reload.className).not.toContain('btn-outline');
    expect(reload.className).toContain('bg-base-100');
    expect(reload.className).toContain('text-base-content');
  });

  it('below 1024px the table stacks: rows, cells and the paused row become blocks and the header is hidden', async () => {
    const env = await mounted(() => ok(listBody([rowA(), rowB()])));
    const table = env.root.querySelector('table')!;
    expect(table.className).toContain('max-lg:block');
    expect(table.querySelector('thead')!.className).toContain('max-lg:hidden');
    expect(table.querySelector('tbody')!.className).toContain('max-lg:block');
    for (const tr of table.querySelector('tbody')!.children) {
      expect(tr.className).toContain('max-lg:flex');
      for (const cell of tr.children.filter((c) => !c.className.includes('hidden lg:table-cell'))) expect(cell.className).toContain('max-lg:block');
    }
    const statusCell = table.querySelector('tbody')!.children[0]!.children[3]!;
    expect(statusCell.children[0]!.textContent).toBe('Status');
    expect(statusCell.children[0]!.className).toContain('lg:hidden');
  });

  it('the deletion-mode select has a visible primary focus ring and a 48px target below 768px', async () => {
    const env = await mounted(() => ok(listBody([rowA()])));
    const select = env.root.querySelector(`[data-source-sync-mode="${CONN_A}"]`)!;
    expect(select.className).toMatch(/focus-visible:\[outline-color:[^\]]*--p/);
    expect(select.className).toContain('max-md:h-12');
  });

  it('the Show files summary is a 48px touch target below 768px', async () => {
    const env = await mounted(() => ok(listBody([rowB()])));
    const summary = env.root.querySelector('summary')!;
    expect(summary.className).toContain('max-md:min-h-12');
  });
});

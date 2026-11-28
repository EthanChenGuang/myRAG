import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const panelFile = path.join(configUiDir, 'rag-panels/purge.js');
const statusMonitorFile = path.join(configUiDir, 'document-processing/status-monitor.js');

type Row = Record<string, unknown>;

interface PurgeModule {
  buildPurgeRecordView: (record: Row, locale: string, now?: number) => Record<string, any>;
}

function loadModule(): PurgeModule {
  return require(panelFile) as PurgeModule;
}

const ADMIN_ID = '7f3a1b2c-0000-4000-8000-000000000001';
const LINEAGE_A = '9c1e2d3f-0000-4000-8000-0000000000a1';
const LINEAGE_B = '44ab5566-0000-4000-8000-0000000000b2';
const REC_A = 'aaaa0000-0000-4000-8000-000000000001';
const REC_B = 'bbbb0000-0000-4000-8000-000000000002';

function adminRecord(overrides: Row = {}): Row {
  return {
    id: REC_A,
    started_at: '2026-11-25T14:01:00Z',
    actor_kind: 'admin',
    actor_id: ADMIN_ID,
    provider: null,
    workspace_key: 'u:1a2b3c4d-0000-4000-8000-000000000009',
    reason_code: 'added_in_error',
    reason_note: 'Uploaded to the wrong workspace',
    lineage_id: LINEAGE_A,
    version_count: 3,
    result: 'verified',
    removed: { documents: 3, chunks: 48 },
    left: { documents: 0, chunks: 0 },
    pending_files: 0,
    checked_at: '2026-11-25T14:01:30Z',
    ...overrides,
  };
}

function syncRecord(overrides: Row = {}): Row {
  return adminRecord({
    id: REC_B,
    started_at: '2026-11-25T09:40:00Z',
    actor_kind: 'source_sync',
    actor_id: 'conn-row-id',
    provider: 'Provider B',
    reason_code: 'source_deleted',
    reason_note: null,
    lineage_id: LINEAGE_B,
    version_count: 1,
    result: 'pending',
    left: { documents: 0, original_files: 0 },
    pending_files: 2,
    ...overrides,
  });
}

function listBody(items: Row[], extra: Row = {}): Row {
  return { success: true, limit: 50, offset: 0, has_more: false, items, ...extra };
}

describe('buildPurgeRecordView', () => {
  it('an admin record: shortened admin id with the full id in title, reason, note, lineage and badge', () => {
    const view = loadModule().buildPurgeRecordView(adminRecord(), 'en');
    expect(view.who.kind).toBe('admin');
    expect(view.who.text).toBe('Admin 7f3a1b2c');
    expect(view.who.idShort).toBe('7f3a1b2c');
    expect(view.who.idFull).toBe(ADMIN_ID);
    expect(view.workspaceKey).toBe('u:1a2b3c4d-0000-4000-8000-000000000009');
    expect(view.reason).toEqual({ text: 'Added by mistake', known: true });
    expect(view.note).toBe('Uploaded to the wrong workspace');
    expect(view.document.idShort).toBe('9c1e2d3f');
    expect(view.document.idFull).toBe(LINEAGE_A);
    expect(view.document.versions).toBe('Versions: 3');
    expect(view.badge).toMatchObject({ result: 'verified', label: 'Nothing left', icon: 'bi-check-circle-fill' });
    expect(view.badge.className).toContain('badge-success');
    expect(view.when.iso).toBe('2026-11-25T14:01:00Z');
    expect(view.receipt.rows.map((r: Row) => r.label)).toEqual(['Document versions', 'Text chunks']);
  });

  it('a source-sync record: provider, Deleted at the source and no note', () => {
    const view = loadModule().buildPurgeRecordView(syncRecord(), 'en');
    expect(view.who).toMatchObject({ kind: 'source_sync', text: 'Source sync, Provider B' });
    expect(view.reason).toEqual({ text: 'Deleted at the source', known: true });
    expect(view.note).toBeNull();
    expect(view.noteNone).toBe('No note');
    expect(view.badge).toMatchObject({ result: 'pending', label: 'Cleanup pending', icon: 'bi-hourglass-split' });
    expect(view.receipt.pendingFiles).toBe(2);
  });

  it('remaining counts the rows left; unchecked gives Not checked and no receipt', () => {
    const { buildPurgeRecordView } = loadModule();
    const remaining = buildPurgeRecordView(adminRecord({ result: 'remaining', left: { documents: 1, chunks: 4 } }), 'en');
    expect(remaining.badge.label).toBe('Rows left: 5');
    expect(remaining.badge.className).toContain('badge-error');
    const unchecked = buildPurgeRecordView(adminRecord({ result: 'unchecked', left: null, checked_at: null }), 'en');
    expect(unchecked.badge).toMatchObject({ result: 'unchecked', label: 'Not checked' });
    expect(unchecked.badge.className).toContain('badge-ghost');
    expect(unchecked.receipt).toBeNull();
    expect(unchecked.noCheck).toBe('No check has run for this record.');
  });

  it('an unknown reason code is kept as a code, to be shown in monospace', () => {
    const view = loadModule().buildPurgeRecordView(adminRecord({ reason_code: 'new_code' }), 'en');
    expect(view.reason).toEqual({ text: 'new_code', known: false });
  });

  it('carries no file name, path or hash, even when the server sent extra fields', () => {
    const view = loadModule().buildPurgeRecordView(
      adminRecord({ filename: 'file-a.pdf', path: 'tenant/file-a.pdf', sha256: 'deadbeef', title: 'Title A' }),
      'en',
    );
    const json = JSON.stringify(view);
    expect(json).not.toContain('file-a');
    expect(json).not.toContain('deadbeef');
    expect(json).not.toContain('Title A');
  });

  it('localizes in zh', () => {
    const view = loadModule().buildPurgeRecordView(syncRecord(), 'zh');
    expect(view.who.text).toBe('来源同步，Provider B');
    expect(view.badge.label).toBe('清理未完成');
  });
});

// ---------------------------------------------------------------- fake DOM

interface Call {
  path: string;
  init: Record<string, unknown>;
}
type Responder = (call: Call) => Row | Promise<Row>;

function setup(responder: Responder, opts: { language?: string } = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('section');
  root.id = 'rag-administration-purge';
  const title = doc.createElement('h3');
  title.setAttribute('data-purge-title', '');
  const desc = doc.createElement('p');
  desc.setAttribute('data-purge-description', '');
  const alertHost = doc.createElement('div');
  alertHost.setAttribute('data-purge-alert', '');
  const content = doc.createElement('div');
  content.setAttribute('data-purge-content', '');
  const status = doc.createElement('div');
  status.setAttribute('data-purge-status', '');
  status.setAttribute('role', 'status');
  root.append(title, desc, alertHost, content, status);
  doc.body.appendChild(root);
  const docsLink = doc.createElement('a');
  docsLink.setAttribute('data-tab', 'document-processing');
  doc.body.appendChild(docsLink);
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
    JSON,
    ragFetch: async (p: string, init: Record<string, unknown>) => {
      const call = { path: p, init: init || {} };
      calls.push(call);
      return responder(call);
    },
  };
  context.window = context;
  vm.createContext(context);
  new vm.Script(fs.readFileSync(statusMonitorFile, 'utf8'), { filename: 'status-monitor.js' }).runInContext(context);
  new vm.Script(fs.readFileSync(panelFile, 'utf8'), { filename: 'purge.js' }).runInContext(context);
  return { doc, root, context, calls, status, alertHost, content, docsLink, title };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function ok(body: Row): Row {
  return { ok: true, status: 200, body };
}

function byText(root: FakeElement, tag: string, text: string): FakeElement | undefined {
  return root.querySelectorAll(tag).find((el) => el.textContent.trim() === text);
}

function recordRows(root: FakeElement): FakeElement[] {
  return root.querySelector('table')!.querySelector('tbody')!.children;
}

async function mounted(responder: Responder, opts: { language?: string } = {}) {
  const env = setup(responder, opts);
  (env.context.initPurgePanel as () => void)();
  await flush();
  return env;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('PurgePanel in a fake DOM', () => {
  it('mount requests the first page and renders two rows per record, newest first, in a named region', async () => {
    const env = await mounted(() => ok(listBody([adminRecord(), syncRecord()])));
    expect(env.calls[0]!.path).toBe('admin/purges?limit=50&offset=0');
    expect(env.calls[0]!.init.method).toBe('GET');
    expect(env.title.textContent).toBe('Purge records');
    const table = env.root.querySelector('table')!;
    expect(table.querySelector('caption')!.textContent).toBe('Purge records, newest first');
    const heads = table.querySelector('thead')!.querySelectorAll('th');
    expect(heads.map((h) => h.textContent)).toEqual(['When', 'Started by', 'Reason', 'Document', 'Check']);
    expect(heads[2]!.className).toContain('hidden md:table-cell');
    expect(heads[3]!.className).toContain('hidden lg:table-cell');
    const body = recordRows(env.root);
    expect(body).toHaveLength(4);
    expect(body[0]!.textContent).toContain('Admin 7f3a1b2c');
    expect(body[2]!.textContent).toContain('Source sync, Provider B');
    const region = env.root.querySelector('[role="region"]')!;
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBe('Purge records, newest first');
    expect(env.status.textContent).toBe('Purge records loaded: 2.');
    expect(env.root.textContent).not.toContain('file-a');
  });

  it('the detail row holds Show check with the receipt and Check again with its accessible name', async () => {
    const env = await mounted(() => ok(listBody([adminRecord()])));
    const details = env.root.querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Show check');
    expect(details.querySelector('table caption')!.textContent).toBe('Check after purge, by store');
    const check = byText(env.root, 'button', 'Check again')!;
    expect(check.getAttribute('aria-label')).toBe('Check purge record aaaa0000 again');
  });

  it('a source-sync record without a note shows an em dash with the hidden No note', async () => {
    const env = await mounted(() => ok(listBody([syncRecord()])));
    const reasonCell = recordRows(env.root)[0]!.querySelectorAll('td')[2]!;
    expect(reasonCell.textContent).toContain('Deleted at the source');
    expect(reasonCell.querySelector('.sr-only')!.textContent).toBe('No note');
  });

  it('an unchecked record shows Not checked and result.noCheck in the disclosure', async () => {
    const env = await mounted(() => ok(listBody([adminRecord({ result: 'unchecked', left: null, checked_at: null })])));
    expect(env.root.textContent).toContain('Not checked');
    expect(env.root.querySelector('details')!.textContent).toContain('No check has run for this record.');
    expect(byText(env.root, 'button', 'Check again')).toBeTruthy();
  });

  it('an unknown reason code renders in monospace inside the normal layout', async () => {
    const env = await mounted(() => ok(listBody([adminRecord({ reason_code: 'new_code' })])));
    const code = env.root.querySelectorAll('.font-mono').find((el) => el.textContent === 'new_code');
    expect(code).toBeTruthy();
  });

  it('Load more records requests the next offset and appends without re-rendering earlier rows', async () => {
    const env = await mounted((call) =>
      call.path.endsWith('offset=0')
        ? ok(listBody([adminRecord()], { has_more: true }))
        : ok(listBody([syncRecord()], { offset: 50, has_more: false })),
    );
    const firstRow = recordRows(env.root)[0];
    const region = env.root.querySelector('[role="region"]')!;
    region.scrollTop = 120;
    byText(env.root, 'button', 'Load more records')!.click();
    await flush();
    expect(env.calls[1]!.path).toBe('admin/purges?limit=50&offset=1');
    expect(recordRows(env.root)).toHaveLength(4);
    expect(recordRows(env.root)[0]).toBe(firstRow);
    expect(env.root.querySelector('[role="region"]')!.scrollTop).toBe(120);
    expect(byText(env.root, 'button', 'Load more records')).toBeUndefined();
  });

  it('Refresh records keeps the content dimmed with aria-busy while loading', async () => {
    let gate = deferred<Row>();
    let first = true;
    const env = await mounted(() => {
      if (first) {
        first = false;
        return ok(listBody([adminRecord()]));
      }
      return gate.promise;
    });
    byText(env.root, 'button', 'Refresh records')!.click();
    await flush(1);
    const view = env.root.querySelector('[data-purge-view]')!;
    expect(view.getAttribute('aria-busy')).toBe('true');
    expect(view.className).toContain('opacity-60');
    expect(view.textContent).toContain('Admin 7f3a1b2c');
    gate.resolve(ok(listBody([adminRecord()])));
    await flush();
    expect(view.getAttribute('aria-busy')).toBeNull();
    gate = deferred<Row>();
  });

  it('Check again posts to the record, replaces badge and receipt, opens the disclosure and announces', async () => {
    let verify = deferred<Row>();
    const env = await mounted((call) => (call.path.endsWith('/verify') ? verify.promise : ok(listBody([adminRecord({ result: 'pending', pending_files: 1 })]))));
    const button = byText(env.root, 'button', 'Check again')!;
    button.click();
    await flush(1);
    expect(env.calls[1]!.path).toBe(`admin/purges/${REC_A}/verify`);
    expect(env.calls[1]!.init.method).toBe('POST');
    const busy = env.root.querySelectorAll('button').find((b) => b.getAttribute('aria-busy') === 'true')!;
    expect(busy.textContent).toBe('Checking…');
    expect(byText(env.root, 'button', 'Refresh records')!.disabled).toBe(true);
    verify.resolve(
      ok({ success: true, record_id: REC_A, check: { left: { documents: 0, chunks: 0 }, pending_files: 0, queued_external: 0, result: 'verified' }, checked_at: '2026-11-26T08:00:00Z' }),
    );
    await flush();
    expect(env.root.textContent).toContain('Nothing left');
    expect(env.root.textContent).not.toContain('Cleanup pending');
    const details = env.root.querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(true);
    expect(env.status.textContent).toMatch(/^Checked .+\.$/);
    expect(env.calls.filter((c) => c.path.startsWith('admin/purges?'))).toHaveLength(1);
    verify = deferred<Row>();
  });

  it('Check again on a record that is gone shows error.recordGone and reloads the list', async () => {
    const env = await mounted((call) => (call.path.endsWith('/verify') ? { ok: false, status: 404, body: { error: 'not_found' } } : ok(listBody([adminRecord()]))));
    byText(env.root, 'button', 'Check again')!.click();
    await flush();
    expect(env.status.textContent).toBe('This record no longer exists. The list was reloaded.');
    expect(env.calls.filter((c) => c.path.startsWith('admin/purges?'))).toHaveLength(2);
  });

  it('an empty list shows the empty state with Open Document Processing', async () => {
    const env = await mounted(() => ok(listBody([])));
    expect(env.root.querySelector('h4')!.textContent).toBe('No purge records');
    expect(env.root.textContent).toContain('Nothing has been purged in the workspaces you administer.');
    let clicked = 0;
    env.docsLink.addEventListener('click', () => (clicked += 1));
    byText(env.root, 'button', 'Open Document Processing')!.click();
    expect(clicked).toBe(1);
  });

  it('401 replaces the view with the sign-in sentence and Reload panel', async () => {
    const env = await mounted(() => ({ ok: false, status: 401, body: null }));
    const alert = env.root.querySelector('.alert-warning')!;
    expect(alert.textContent).toContain('http://config.local');
    expect(byText(alert, 'button', 'Reload panel')).toBeTruthy();
    expect(env.root.querySelector('table')).toBeNull();
  });

  it('503 after a load keeps the earlier content dimmed and shows list.unavailable', async () => {
    let fail = false;
    const env = await mounted(() => (fail ? { ok: false, status: 503, body: null } : ok(listBody([adminRecord()]))));
    fail = true;
    byText(env.root, 'button', 'Refresh records')!.click();
    await flush();
    expect(env.alertHost.textContent).toContain('Purge records could not be loaded.');
    expect(byText(env.alertHost, 'button', 'Reload panel')).toBeTruthy();
    expect(env.root.querySelector('table')).toBeTruthy();
    expect(env.root.querySelector('[data-purge-view]')!.className).toContain('opacity-60');
  });

  it('a second init refreshes instead of mounting again and keeps an open disclosure', async () => {
    const env = await mounted(() => ok(listBody([adminRecord()])));
    env.root.querySelector('details')!.setAttribute('open', '');
    env.root.querySelector('details')!.dispatch('toggle');
    (env.context.initPurgePanel as () => void)();
    await flush();
    expect(env.calls).toHaveLength(2);
    expect(env.root.querySelectorAll('table caption').filter((c) => c.textContent === 'Purge records, newest first')).toHaveLength(1);
    expect(env.root.querySelector('details')!.hasAttribute('open')).toBe(true);
  });

  it('markup in notes, keys and codes creates no element', async () => {
    const env = await mounted(() =>
      ok(listBody([adminRecord({ reason_note: XSS_PAYLOAD, workspace_key: XSS_PAYLOAD, reason_code: XSS_PAYLOAD, provider: XSS_PAYLOAD })])),
    );
    expect(injectedElements(env.doc)).toEqual([]);
    expect(env.root.textContent).toContain(XSS_PAYLOAD);
  });

  it('localizes the panel in it and sets lang on the root', async () => {
    const env = await mounted(() => ok(listBody([adminRecord()])), { language: 'it-IT' });
    expect(env.root.getAttribute('lang')).toBe('it');
    expect(env.title.textContent).toBe('Registro delle eliminazioni definitive');
  });
});

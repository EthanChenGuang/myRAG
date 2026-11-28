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
const managerFile = path.join(configUiDir, 'document-processing/document-manager.js');

type Row = Record<string, unknown>;

interface PurgeModule {
  PURGE_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
  buildPurgeReceiptView: (check: Row, removed: Row | null, locale: string) => Record<string, any>;
  mapPurgeError: (result: Row, locale: string, context: string, appUrl?: string) => Record<string, any>;
}

function loadModule(): PurgeModule {
  return require(panelFile) as PurgeModule;
}

const DOC_ID = '9c1e0000-0000-4000-8000-000000000001';
const RECORD_ID = '7f3a0000-0000-4000-8000-0000000000aa';

interface Call {
  path: string;
  init: Record<string, unknown>;
}
type Responder = (call: Call) => Row | Promise<Row>;

function setup(responder: Responder, opts: { language?: string } = {}) {
  const doc = new FakeDocument();
  const heading = doc.createElement('h3');
  heading.id = 'documents-management-title';
  heading.setAttribute('tabindex', '-1');
  doc.body.appendChild(heading);
  const purgeSection = doc.createElement('section');
  purgeSection.id = 'rag-administration-purge';
  const purgeTitle = doc.createElement('h3');
  purgeTitle.setAttribute('data-purge-title', '');
  purgeSection.appendChild(purgeTitle);
  doc.body.appendChild(purgeSection);
  const tabLink = doc.createElement('a');
  tabLink.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(tabLink);
  const calls: Call[] = [];
  const reloads: number[] = [];
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
    documentManager: { loadDocuments: () => reloads.push(1) },
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
  return { doc, context, calls, reloads, heading, purgeTitle, tabLink };
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

function openDialog(doc: FakeDocument): FakeElement | undefined {
  return doc.querySelectorAll('dialog').find((d) => d.open);
}

function open(env: ReturnType<typeof setup>, filename = 'file-a.pdf', source = 'upload') {
  (env.context.openPurgeDialog as (id: string, name: string, source: string) => void)(DOC_ID, filename, source);
  const dialog = openDialog(env.doc);
  expect(dialog, 'open purge dialog').toBeTruthy();
  return dialog!;
}

function choose(dialog: FakeElement, code: string, note?: string) {
  const select = dialog.querySelector('select')!;
  select.value = code;
  select.dispatch('change');
  if (note !== undefined) {
    const area = dialog.querySelector('textarea')!;
    area.value = note;
    area.dispatch('input');
  }
}

function confirmButton(dialog: FakeElement): FakeElement {
  return byText(dialog, 'button', 'Purge document')!;
}

function verifiedBody(): Row {
  return {
    success: true,
    record_id: RECORD_ID,
    removed: { documents: 3, chunks: 48, vectors: 48, semantic_cache: 2, original_files: 4 },
    check: {
      left: { documents: 0, chunks: 0, vectors: 0, semantic_cache: 0, original_files: 0, page_images: 0 },
      pending_files: 0,
      queued_external: 0,
      result: 'verified',
    },
    checked_at: '2026-11-25T14:01:00Z',
  };
}

function receiptRows(root: FakeElement) {
  const table = root.querySelector('table')!;
  return table
    .querySelector('tbody')!
    .querySelectorAll('tr')
    .map((tr) => ({ store: tr.querySelector('th')!.textContent, cells: tr.querySelectorAll('td') }));
}

describe('Documents table: Purge row button', () => {
  function loadManager(globals: Record<string, unknown>) {
    const doc = new FakeDocument();
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      setTimeout: () => 0,
      clearTimeout: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
      ...globals,
    };
    context.window = context;
    vm.createContext(context);
    const source = fs.readFileSync(managerFile, 'utf8');
    const start = source.indexOf('class DocumentManager');
    const end = source.indexOf('\n}\n', start);
    new vm.Script(`${source.slice(start, end + 2)}\nglobalThis.__Class = DocumentManager;`).runInContext(context);
    const Klass = context.__Class as { prototype: object };
    return { doc, instance: Object.create(Klass.prototype) as { createDocumentRow: (d: Row) => FakeElement } };
  }

  const docRow = (extra: Row = {}): Row => ({
    id: DOC_ID,
    filename: 'file-a.pdf',
    size: 10,
    status: 'ready',
    chunk_count: 4,
    created_at: '2026-01-01',
    source: 'nango',
    metadata: {},
    ...extra,
  });

  it('renders Purge after Delete with an aria-label naming the file, and passes the raw values', () => {
    const seen: unknown[][] = [];
    const { instance } = loadManager({ openPurgeDialog: (...args: unknown[]) => seen.push(args) });
    const row = instance.createDocumentRow(docRow());
    const buttons = row.querySelectorAll('button');
    expect(buttons.map((b) => b.getAttribute('data-doc-action'))).toEqual(['type', 'url', 'delete', 'purge']);
    const purge = buttons[3]!;
    expect(purge.textContent.trim()).toBe('Purge');
    expect(purge.getAttribute('aria-label')).toBe('Purge file-a.pdf: remove it from every store and from past citations');
    expect(purge.className).toContain('btn-error');
    expect(purge.className).toContain('btn-outline');
    purge.click();
    expect(seen).toEqual([[DOC_ID, 'file-a.pdf', 'nango']]);
  });

  it('a connector document with a connection id is passed as a connector source', () => {
    const seen: unknown[][] = [];
    const { instance } = loadManager({ openPurgeDialog: (...args: unknown[]) => seen.push(args) });
    instance.createDocumentRow(docRow({ source: 'upload', source_connection_id: 'c-1' })).querySelectorAll('button')[3]!.click();
    expect(seen[0]![2]).toBe('connector');
  });

  it('renders no Purge button when the purge script is not loaded', () => {
    const { instance } = loadManager({});
    const row = instance.createDocumentRow(docRow());
    expect(row.querySelector('[data-doc-action="purge"]')).toBeNull();
  });

  it('a file name with markup reaches neither an element nor an inline handler', () => {
    const seen: unknown[][] = [];
    const { doc, instance } = loadManager({ openPurgeDialog: (...args: unknown[]) => seen.push(args) });
    const row = instance.createDocumentRow(docRow({ filename: XSS_PAYLOAD }));
    doc.body.appendChild(row);
    expect(injectedElements(doc)).toEqual([]);
    const purge = row.querySelector('[data-doc-action="purge"]')!;
    expect(purge.getAttribute('onclick')).toBeNull();
    expect(purge.getAttribute('aria-label')).toContain(XSS_PAYLOAD);
    purge.click();
    expect(seen[0]![1]).toBe(XSS_PAYLOAD);
  });
});

describe('purge dialog form', () => {
  it('opens with focus on Keep document, the confirm disabled and dialog.needReason', () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    expect(dialog.querySelector('h3')!.textContent).toBe('Purge “file-a.pdf”?');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(env.doc.activeElement?.textContent.trim()).toBe('Keep document');
    expect(confirmButton(dialog).disabled).toBe(true);
    expect(dialog.querySelector('[role="status"]')!.textContent).toBe('Choose a reason to continue.');
    const options = dialog.querySelector('select')!.querySelectorAll('option');
    expect(options.map((o) => o.getAttribute('value'))).toEqual([
      '',
      'owner_request',
      'added_in_error',
      'retention_ended',
      'legal_or_policy',
      'restricted_content',
      'other',
    ]);
    expect(options[0]!.hasAttribute('disabled')).toBe(true);
    expect(dialog.querySelector('textarea')!.getAttribute('maxlength')).toBe('500');
  });

  it('Other needs a non-blank note before the confirm is enabled', () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    choose(dialog, 'other');
    expect(confirmButton(dialog).disabled).toBe(true);
    expect(dialog.querySelector('[role="status"]')!.textContent).toBe('Add a note for Other.');
    expect(dialog.textContent).toContain('required for Other');
    choose(dialog, 'other', '   ');
    expect(confirmButton(dialog).disabled).toBe(true);
    choose(dialog, 'other', 'Asked by the owner');
    expect(confirmButton(dialog).disabled).toBe(false);
    expect(dialog.querySelector('[role="status"]')!.textContent).toBe('');
  });

  it('a non-Other reason enables the confirm without a note', () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    choose(dialog, 'added_in_error');
    expect(confirmButton(dialog).disabled).toBe(false);
    expect(dialog.textContent).toContain('optional');
  });

  it('confirming sends exactly reason_code and reason_note to the purge route', async () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    choose(dialog, 'other', ' Asked by the owner ');
    confirmButton(dialog).click();
    await flush();
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]!.path).toBe(`admin/documents/${DOC_ID}/purge`);
    expect(env.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(env.calls[0]!.init.body))).toEqual({ reason_code: 'other', reason_note: 'Asked by the owner' });
  });

  it('an empty note is sent as null', async () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    choose(dialog, 'retention_ended');
    confirmButton(dialog).click();
    await flush();
    expect(JSON.parse(String(env.calls[0]!.init.body))).toEqual({ reason_code: 'retention_ended', reason_note: null });
  });

  it('while running every control is disabled and Escape is inert', async () => {
    let release!: (v: Row) => void;
    const env = setup(() => new Promise<Row>((r) => (release = r)));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush(1);
    expect(dialog.querySelector('select')!.disabled).toBe(true);
    expect(dialog.querySelector('textarea')!.disabled).toBe(true);
    expect(byText(dialog, 'button', 'Keep document')!.disabled).toBe(true);
    const busy = dialog.querySelectorAll('button').find((b) => b.getAttribute('aria-busy') === 'true')!;
    expect(busy.textContent).toBe('Purging…');
    expect(busy.disabled).toBe(true);
    expect(dialog.dispatch('cancel').defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    release(ok(verifiedBody()));
    await flush();
  });

  it('the connector sentence shows only for a connector source', () => {
    const env = setup(() => ok(verifiedBody()));
    expect(open(env, 'file-a.pdf', 'upload').textContent).not.toContain('came from a connected source');
    const env2 = setup(() => ok(verifiedBody()));
    expect(open(env2, 'file-a.pdf', 'nango').textContent).toContain('This file came from a connected source.');
  });

  it('markup in the file name creates no element in the dialog', () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env, XSS_PAYLOAD);
    expect(injectedElements(env.doc)).toEqual([]);
    expect(dialog.querySelector('h3')!.textContent).toContain(XSS_PAYLOAD);
    expect(dialog.querySelector('h3')!.className).toContain('break-words');
  });

  it('localizes the dialog in it with the Italian quotation marks', () => {
    const env = setup(() => ok(verifiedBody()), { language: 'it-IT' });
    const dialog = open(env);
    expect(dialog.getAttribute('lang')).toBe('it');
    expect(dialog.querySelector('h3')!.textContent).toBe('Eliminare definitivamente «file-a.pdf»?');
  });
});

describe('purge result and receipt', () => {
  it('a verified answer replaces the form with the focused title and a receipt of zeros', async () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('select')).toBeNull();
    const title = env.doc.activeElement!;
    expect(title.textContent).toBe('Purged. Nothing left.');
    expect(title.getAttribute('tabindex')).toBe('-1');
    const rows = receiptRows(dialog);
    expect(rows.map((r) => r.store)).toEqual([
      'Document versions',
      'Text chunks',
      'Search vectors',
      'Cached answers',
      'Original and parsed files',
      'Page images',
    ]);
    expect(rows.map((r) => r.cells[1]!.textContent)).toEqual(['0', '0', '0', '0', '0', '0']);
    expect(rows[0]!.cells[0]!.textContent).toBe('3');
    expect(dialog.querySelector('caption')!.textContent).toBe('Check after purge, by store');
    expect(dialog.querySelectorAll('.bi-exclamation-triangle')).toHaveLength(0);
    expect(byText(dialog, 'button', 'Open purge records')).toBeTruthy();
    expect(byText(dialog, 'button', 'Close dialog')).toBeTruthy();
  });

  it('Page images without a removed count shows an em dash with Not reported', async () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush();
    const page = receiptRows(dialog).find((r) => r.store === 'Page images')!;
    expect(page.cells[0]!.textContent).toBe('—Not reported');
    expect(page.cells[0]!.querySelector('.sr-only')!.textContent).toBe('Not reported');
  });

  it('a remaining answer marks the non-zero Left cell and names the record id', async () => {
    const body = verifiedBody();
    body.check = { left: { documents: 0, chunks: 2, 'external:index-a': 1 }, pending_files: 0, queued_external: 0, result: 'remaining' };
    const env = setup(() => ok(body));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush();
    expect(env.doc.activeElement!.textContent).toBe('Purged, but rows are left.');
    const bodyText = dialog.querySelectorAll('p').find((p) => p.textContent.includes('report it with record id'))!;
    expect(bodyText.querySelector('.font-mono')!.textContent).toBe(RECORD_ID);
    const rows = receiptRows(dialog);
    const chunks = rows.find((r) => r.store === 'Text chunks')!;
    expect(chunks.cells[1]!.className).toContain('font-semibold');
    expect(chunks.cells[1]!.querySelector('.bi-exclamation-triangle')!.getAttribute('aria-hidden')).toBe('true');
    expect(chunks.cells[1]!.querySelector('.sr-only')!.textContent).toContain('rows still left in this store');
    const external = rows.find((r) => r.store === 'external:index-a')!;
    expect(external.cells.length).toBe(2);
    expect(rows[rows.length - 1]!.store).toBe('external:index-a');
    const th = dialog.querySelectorAll('th').find((t) => t.textContent === 'external:index-a')!;
    expect(th.querySelector('.font-mono')).toBeTruthy();
  });

  it('a pending answer states the files waiting for cleanup and the queued external deletions', async () => {
    const body = verifiedBody();
    body.check = { left: { documents: 0 }, pending_files: 2, queued_external: 1, result: 'pending' };
    const env = setup(() => ok(body));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush();
    expect(env.doc.activeElement!.textContent).toBe('Purged. Cleanup is not finished.');
    expect(dialog.textContent).toContain('Some stored files could not be removed yet');
    expect(dialog.textContent).toContain('Stored files waiting for cleanup: 2. The next scheduled reconcile tries again.');
    expect(dialog.textContent).toContain('Deletions queued for the external index: 1.');
  });

  it('Close dialog reloads the Documents table and returns focus to its heading', async () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush();
    byText(dialog, 'button', 'Close dialog')!.click();
    expect(dialog.open).toBe(false);
    expect(env.reloads).toHaveLength(1);
    expect(env.doc.activeElement).toBe(env.heading);
  });

  it('Open purge records activates the RAG administration tab and focuses the panel heading', async () => {
    const env = setup(() => ok(verifiedBody()));
    let clicked = 0;
    env.tabLink.addEventListener('click', () => (clicked += 1));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush();
    byText(dialog, 'button', 'Open purge records')!.click();
    expect(clicked).toBe(1);
    expect(env.doc.activeElement).toBe(env.purgeTitle);
  });

  it('Keep document closes without a request, reload or purge', () => {
    const env = setup(() => ok(verifiedBody()));
    const dialog = open(env);
    byText(dialog, 'button', 'Keep document')!.click();
    expect(dialog.open).toBe(false);
    expect(env.calls).toHaveLength(0);
    expect(env.reloads).toHaveLength(0);
  });

  it('buildPurgeReceiptView carries counts only, in server order, with no file name', () => {
    const { buildPurgeReceiptView } = loadModule();
    const view = buildPurgeReceiptView(
      { left: { chunks: 0, documents: 1, mystery: 0 }, pending_files: 0, queued_external: 0, result: 'remaining' },
      { documents: 2, chunks: 9 },
      'en',
    );
    expect(view.rows.map((r: Row) => r.store)).toEqual(['chunks', 'documents', 'mystery']);
    expect(view.rows[1]).toMatchObject({ label: 'Document versions', removed: '2', left: '1', leftNonZero: true, known: true });
    expect(view.rows[2]).toMatchObject({ label: 'mystery', known: false, removed: null });
    expect(JSON.stringify(view)).not.toMatch(/file-a|\.pdf|sha256/);
  });

  it('labels the sync_records store in en, zh and it', () => {
    const { PURGE_LABELS } = loadModule();
    expect(PURGE_LABELS.en['store.sync_records']).toBe('Connector sync records');
    expect(PURGE_LABELS.zh['store.sync_records']).toBe('连接器同步记录');
    expect(PURGE_LABELS.it['store.sync_records']).toBe('Record di sincronizzazione del connettore');
  });
});

describe('purge refusals', () => {
  it('404 shows error.notFound and leaves only Close dialog, which reloads the table', async () => {
    const env = setup(() => ({ ok: false, status: 404, body: { success: false, error: 'not_found' } }));
    const dialog = open(env);
    choose(dialog, 'owner_request');
    confirmButton(dialog).click();
    await flush();
    const alert = dialog.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('This document no longer exists or is not in a workspace you administer. Nothing was removed.');
    const visible = dialog.querySelector('.modal-action')!.querySelectorAll('button').filter((b) => !b.hidden);
    expect(visible.map((b) => b.textContent.trim())).toEqual(['Close dialog']);
    visible[0]!.click();
    expect(env.reloads).toHaveLength(1);
  });

  it('400 shows error.invalidReason, marks the select invalid and keeps the values', async () => {
    const env = setup(() => ({ ok: false, status: 400, body: { success: false, error: 'invalid_request' } }));
    const dialog = open(env);
    choose(dialog, 'other', 'Asked by the owner');
    confirmButton(dialog).click();
    await flush();
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe('The reason was not accepted. Choose a reason and, for Other, add a note.');
    expect(dialog.querySelector('select')!.getAttribute('aria-invalid')).toBe('true');
    expect(dialog.querySelector('select')!.value).toBe('other');
    expect(dialog.querySelector('textarea')!.value).toBe('Asked by the owner');
    expect(confirmButton(dialog).disabled).toBe(false);
  });

  it('a 5xx or a thrown fetch shows error.failed and never claims nothing was removed', async () => {
    const responders: Responder[] = [
      () => ({ ok: false, status: 500, body: null }),
      () => {
        throw new Error('offline');
      },
    ];
    for (const responder of responders) {
      const env = setup(responder);
      const dialog = open(env);
      choose(dialog, 'owner_request');
      confirmButton(dialog).click();
      await flush();
      const text = dialog.querySelector('[role="alert"]')!.textContent;
      expect(text).toBe('The purge did not finish. Open Purge records to see whether a record was written before trying again.');
      expect(text).not.toContain('Nothing was removed');
      expect(dialog.querySelector('select')!.value).toBe('owner_request');
      expect(byText(dialog, 'button', 'Keep document')!.disabled).toBe(false);
    }
  });

  it('mapPurgeError: 403 read_only, sign-in, and an unknown code in monospace', () => {
    const { mapPurgeError } = loadModule();
    expect(mapPurgeError({ ok: false, status: 403, body: { error: 'read_only' } }, 'en', 'purge').key).toBe('error.readOnly');
    const auth = mapPurgeError({ ok: false, status: 401, body: null }, 'en', 'purge', 'http://app.local');
    expect(auth.kind).toBe('auth');
    expect(auth.message).toContain('http://app.local');
    const unknown = mapPurgeError({ ok: false, status: 418, body: { error: 'teapot' } }, 'en', 'verify');
    expect(unknown.key).toBe('error.generic');
    expect(unknown.code).toBe('teapot');
  });
});

describe('index.html loads the purge panel', () => {
  const html = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
  it('loads rag-panels/purge.js once, after rag-panels/source-sync.js', () => {
    const tags = html.match(/<script src="rag-panels\/purge\.js"><\/script>/g) || [];
    expect(tags).toHaveLength(1);
    expect(html.indexOf('rag-panels/purge.js')).toBeGreaterThan(html.indexOf('rag-panels/source-sync.js'));
  });

  it('places #rag-administration-purge after Source sync and before Embedding profiles, with its hosts', () => {
    const at = html.indexOf('id="rag-administration-purge"');
    expect(at).toBeGreaterThan(html.indexOf('id="rag-administration-source-sync"'));
    expect(at).toBeLessThan(html.indexOf('id="rag-administration-profiles"'));
    const section = html.slice(at, html.indexOf('</section>', at));
    for (const hook of ['data-purge-title', 'data-purge-description', 'data-purge-alert', 'data-purge-content', 'data-purge-status']) {
      expect(section).toContain(hook);
    }
    expect(section).toContain('role="status"');
    expect(html).toContain('id="documents-management-title"');
  });

  it('purge.js never writes markup through innerHTML', () => {
    expect(fs.readFileSync(panelFile, 'utf8')).not.toContain('innerHTML');
  });
});

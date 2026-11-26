import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';

const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const safeDomPath = path.join(configUiDir, 'utils/safe-dom.js');

/** Loads a Config UI script's class without running the instantiation at the bottom of the file. */
function loadClass(doc: FakeDocument, file: string, className: string, globals: Record<string, unknown> = {}) {
  const context: Record<string, unknown> = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    ...globals,
  };
  context.window = context;
  vm.createContext(context);
  if (fs.existsSync(safeDomPath)) new vm.Script(fs.readFileSync(safeDomPath, 'utf8')).runInContext(context);
  const source = fs.readFileSync(path.join(configUiDir, file), 'utf8');
  const start = source.indexOf(`class ${className}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  new vm.Script(`${source.slice(start, end + 2)}\nglobalThis.__Class = ${className};`, { filename: file }).runInContext(context);
  const Klass = context.__Class as { prototype: object };
  return { context, instance: Object.create(Klass.prototype) as Record<string, unknown> & Record<string, (...args: unknown[]) => unknown> };
}

function host(doc: FakeDocument, id: string, tag = 'div'): FakeElement {
  const el = doc.createElement(tag);
  el.id = id;
  doc.body.appendChild(el);
  return el;
}

function onclickWithPayload(doc: FakeDocument): FakeElement[] {
  return doc.documentElement.querySelectorAll('*').filter((el) => (el.getAttribute('onclick') || '').includes('PWNED('));
}

function expectSafe(doc: FakeDocument) {
  expect(injectedElements(doc).map((el) => `${el.tagName} ${[...el.attributes].map(([k, v]) => `${k}=${v}`).join(' ')}`)).toEqual([]);
  expect(onclickWithPayload(doc)).toEqual([]);
}

const JS_BREAKOUT = `');PWNED(1);//${XSS_PAYLOAD}`;

describe('document-manager.js renders document data as text (XSS)', () => {
  it('document rows: file name, doc type, URL and id do not reach markup or inline handlers', () => {
    const doc = new FakeDocument();
    const { instance } = loadClass(doc, 'document-processing/document-manager.js', 'DocumentManager');
    const row = instance.createDocumentRow({
      id: `id${JS_BREAKOUT}`,
      filename: JS_BREAKOUT,
      doc_type: JS_BREAKOUT,
      size: 10,
      status: 'completed',
      chunk_count: XSS_PAYLOAD,
      created_at: '2026-01-01',
      source_provider: 'firecrawl',
      source_file_id: XSS_PAYLOAD,
      metadata: { external_url: JS_BREAKOUT },
    }) as FakeElement;
    doc.body.appendChild(row);
    expectSafe(doc);
    expect(row.textContent).toContain(JS_BREAKOUT);
    expect(row.querySelectorAll('button')).toHaveLength(3);
  });

  it('delete confirmation: document name', () => {
    const doc = new FakeDocument();
    const { instance } = loadClass(doc, 'document-processing/document-manager.js', 'DocumentManager');
    instance.confirmDelete(`id${JS_BREAKOUT}`, XSS_PAYLOAD);
    expectSafe(doc);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
  });

  it('toast: message', () => {
    const doc = new FakeDocument();
    const { instance } = loadClass(doc, 'document-processing/document-manager.js', 'DocumentManager');
    instance.showToast(XSS_PAYLOAD, 'error');
    expectSafe(doc);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
  });
});

describe('status-monitor.js renders queue data as text (XSS)', () => {
  it('queue list: file names and errors', () => {
    const doc = new FakeDocument();
    host(doc, 'queueList');
    const { instance } = loadClass(doc, 'document-processing/status-monitor.js', 'DocumentStatusMonitor');
    instance.updateQueueDisplay([{ id: 'q1', status: 'failed', file: { name: XSS_PAYLOAD, size: 5 }, error: XSS_PAYLOAD }]);
    expectSafe(doc);
    expect(doc.getElementById('queueList')!.textContent).toContain(XSS_PAYLOAD);
  });

  it('file status update: a new error message', () => {
    const doc = new FakeDocument();
    host(doc, 'queueList');
    const { instance } = loadClass(doc, 'document-processing/status-monitor.js', 'DocumentStatusMonitor');
    instance.updateQueueDisplay([{ id: 'q1', status: 'processing', file: { name: 'a.pdf', size: 5 } }]);
    instance.updateFileStatus({ id: 'q1', status: 'failed', error: XSS_PAYLOAD });
    expectSafe(doc);
    expect(doc.getElementById('queueList')!.textContent).toContain(XSS_PAYLOAD);
  });

  it('RAG config display and batch result: values from the server', () => {
    const doc = new FakeDocument();
    host(doc, 'ragConfigDisplay');
    const { instance } = loadClass(doc, 'document-processing/status-monitor.js', 'DocumentStatusMonitor');
    instance.updateRagConfig({ chunkStrategy: XSS_PAYLOAD, chunkSize: XSS_PAYLOAD, chunkOverlap: XSS_PAYLOAD, multimodal: true, embeddingModel: XSS_PAYLOAD });
    instance.showBatchResult({ processed: XSS_PAYLOAD, failed: 1 });
    expectSafe(doc);
  });
});

describe('connectors-config.js renders connector data as text (XSS)', () => {
  const provider = (overrides: Record<string, unknown> = {}) => ({
    provider: 'google-drive',
    button_label: XSS_PAYLOAD,
    enabled: true,
    show_on_dashboard: true,
    supported_file_types: [XSS_PAYLOAD],
    max_files_per_sync: XSS_PAYLOAD,
    stats: { connected_users: XSS_PAYLOAD, total_syncs: 2, failed_syncs: 1, last_sync: null },
    user_connection: { sync_folder_id: 'f1', sync_folder_name: XSS_PAYLOAD, sync_file_ids: ['a'], last_sync_at: null },
    ...overrides,
  });

  it('provider cards: Drive folder names, labels and stats', () => {
    for (const p of [provider(), provider({ provider: 'notion' }), provider({ provider: `x${JS_BREAKOUT}`, user_connection: null })]) {
      const doc = new FakeDocument();
      host(doc, 'providers-list');
      const { instance } = loadClass(doc, 'connectors-config.js', 'ConnectorsConfigManager');
      Object.assign(instance, { config: { providers: [p] } });
      instance.renderProvidersList();
      expectSafe(doc);
    }
  });

  it('connections table: labels and counts', () => {
    const doc = new FakeDocument();
    host(doc, 'connections-table-body', 'tbody');
    const { instance } = loadClass(doc, 'connectors-config.js', 'ConnectorsConfigManager');
    Object.assign(instance, { config: { providers: [provider()] } });
    instance.renderConnectionsTable();
    expectSafe(doc);
  });

  it('notification banner and confirmation dialog: messages', () => {
    const doc = new FakeDocument();
    host(doc, 'connectors-config-container');
    const { instance } = loadClass(doc, 'connectors-config.js', 'ConnectorsConfigManager', { encodeURIComponent });
    instance.showNotification(XSS_PAYLOAD, 'error');
    void instance.showConfirmationDialog(XSS_PAYLOAD, XSS_PAYLOAD, XSS_PAYLOAD, XSS_PAYLOAD);
    expectSafe(doc);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
  });
});

describe('mcp-config.js renders MCP server data as text (XSS)', () => {
  const server = {
    id: `custom${JS_BREAKOUT}`,
    name: XSS_PAYLOAD,
    description: `${XSS_PAYLOAD}</textarea><img src=x onerror=PWNED(2)>`,
    host: XSS_PAYLOAD,
    type: XSS_PAYLOAD,
    enabled: true,
    hasCredentials: true,
    endpoint: XSS_PAYLOAD,
    authentication: { type: 'basic', credentials: { username: XSS_PAYLOAD, password: XSS_PAYLOAD } },
    settings: { enabledInChat: true, timeout: XSS_PAYLOAD, retryAttempts: XSS_PAYLOAD },
  };

  it('server list: names, descriptions, hosts and ids', () => {
    const doc = new FakeDocument();
    host(doc, 'mcp-servers-list');
    const { instance } = loadClass(doc, 'mcp-config.js', 'McpConfigManager');
    Object.assign(instance, { servers: [server, { ...server, id: 'zapier' }] });
    instance.renderServerList();
    expectSafe(doc);
    expect(doc.getElementById('mcp-servers-list')!.textContent).toContain(XSS_PAYLOAD);
  });

  it('add/edit dialog: stored values and credentials', () => {
    for (const editing of [false, true]) {
      const doc = new FakeDocument();
      const { instance } = loadClass(doc, 'mcp-config.js', 'McpConfigManager');
      Object.assign(instance, { currentEditingServer: editing ? server : null });
      instance.showServerDialog(server);
      expectSafe(doc);
      expect(doc.getElementById('server-name')!.value || doc.getElementById('server-name')!.getAttribute('value')).toBe(XSS_PAYLOAD);
    }
  });

  it('auth fields: credential values', () => {
    const doc = new FakeDocument();
    const container = host(doc, 'auth-fields');
    const { instance } = loadClass(doc, 'mcp-config.js', 'McpConfigManager');
    for (const auth of [
      { type: 'bearer', credentials: { token: XSS_PAYLOAD } },
      { type: 'api-key', credentials: { apiKey: XSS_PAYLOAD } },
      { type: 'basic', credentials: { username: XSS_PAYLOAD, password: XSS_PAYLOAD } },
    ]) {
      container.innerHTML = instance.renderAuthFields(auth) as string;
      expectSafe(doc);
    }
  });

  it('notification: message', () => {
    const doc = new FakeDocument();
    const { instance } = loadClass(doc, 'mcp-config.js', 'McpConfigManager');
    instance.showNotification(XSS_PAYLOAD, 'error');
    expectSafe(doc);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
  });

  it('built-in server dialog: server name', () => {
    const doc = new FakeDocument();
    const { instance } = loadClass(doc, 'mcp-config.js', 'McpConfigManager');
    instance.showBuiltinServerDialog('zapier', { ...server, id: 'zapier' });
    expectSafe(doc);
  });
});

describe('rag-panels/languages.js and rag-ui.js render server data as text (XSS)', () => {
  it('pack names, reason ids and refused-save details create no element and no inline handler', async () => {
    const doc = new FakeDocument();
    const section = host(doc, 'rag-administration-languages', 'section');
    for (const attr of ['data-languages-title', 'data-languages-description', 'data-languages-alert', 'data-languages-content', 'data-languages-mirrors', 'data-languages-status']) {
      const el = doc.createElement('div');
      el.setAttribute(attr, '');
      section.appendChild(el);
    }
    host(doc, 'rag-language-banner');
    const answer = {
      configured: false,
      languages: [],
      primary: null,
      variablesSet: {},
      pipelines: { RAG_PIPELINE: { value: 'v2', explicit: true } },
      verifiedAgainstActiveProfile: false,
      packs: [
        { code: 'zh', nativeName: JS_BREAKOUT, englishName: XSS_PAYLOAD, groundedness: 'none', selectable: true, reasons: [] },
        { code: 'en', nativeName: XSS_PAYLOAD, englishName: JS_BREAKOUT, selectable: false, reasons: [{ code: 'reranker_unsupported', id: JS_BREAKOUT }] },
      ],
    };
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      navigator: { language: 'en-US' },
      location: { origin: 'http://config.local' },
      setTimeout,
      clearTimeout,
      AbortController,
      Intl,
      fetch: async (_url: string, init: { method?: string } = {}) => ({
        ok: init.method !== 'POST',
        status: init.method === 'POST' ? 400 : 200,
        json: async () =>
          init.method === 'POST' ? { success: false, details: [{ code: 'incomplete_pack', language: XSS_PAYLOAD }, { code: JS_BREAKOUT }] } : answer,
      }),
      ragFetch: async () => ({ ok: true, status: 200, body: { counts: [{ language: 'zh', documents: 3 }] } }),
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['rag-panels/rag-ui.js', 'rag-panels/languages.js']) {
      new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    await (context.initLanguagesPanel as () => Promise<void>)();
    const save = doc.body.querySelectorAll('button').find((b) => b.textContent === 'Save languages')!;
    save.click();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expectSafe(doc);
    expect(doc.innerHtmlWrites).toBe(0);
    expect(doc.body.textContent).toContain(JS_BREAKOUT);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
  });
});

describe('rag-panels/ingest-impact.js renders server data and setting values as text (XSS)', () => {
  it('mechanisms, doc types, commands, states and changed values create no element and no inline handler', async () => {
    const doc = new FakeDocument();
    const section = host(doc, 'rag-administration-ingest-impact', 'section');
    for (const attr of ['data-ingest-impact-title', 'data-ingest-impact-description', 'data-ingest-impact-alert', 'data-ingest-impact-content', 'data-ingest-impact-status']) {
      const el = doc.createElement('div');
      el.setAttribute(attr, '');
      section.appendChild(el);
    }
    const coverage = {
      success: true,
      pending: [
        { mechanism: XSS_PAYLOAD, affected: 3, start: 'cli', command: JS_BREAKOUT },
        { mechanism: 'reparse', affected: 2, start: 'needs_async', command: XSS_PAYLOAD },
        { mechanism: 'rechunk', affected: 1, start: JS_BREAKOUT, command: XSS_PAYLOAD },
      ],
      without_fingerprint: { count: 2, command: XSS_PAYLOAD },
      rebuilds: [
        { id: XSS_PAYLOAD, mechanism: JS_BREAKOUT, done: 1, total: 2, gaps: 1, state: XSS_PAYLOAD, started: JS_BREAKOUT, activation: 'rebuild_batch' },
        { id: 'r2', mechanism: 'reparse', done: 2, total: 2, gaps: 0, state: 'built', started: XSS_PAYLOAD, activation: 'rebuild_batch' },
      ],
    };
    const impact = {
      ingestion_keys: ['RAG_TABLE_HEADER_REPEAT', XSS_PAYLOAD],
      by_mechanism: [
        { mechanism: XSS_PAYLOAD, doc_type: JS_BREAKOUT, affected: 4 },
        { mechanism: 'rechunk', doc_type: XSS_PAYLOAD, affected: 5 },
      ],
      without_fingerprint: 1,
    };
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      navigator: { language: 'en-US', clipboard: { writeText: async () => {} } },
      location: { origin: 'http://config.local' },
      setTimeout,
      clearTimeout,
      AbortController,
      Intl,
      showToast() {},
      ragFetch: async (apiPath: string, init: { method?: string } = {}) => {
        if (apiPath.endsWith('/impact')) return { ok: true, status: 200, body: impact };
        if (init.method === 'POST') return { ok: false, status: 409, body: { success: false, error: 'activation_refused', reason: XSS_PAYLOAD } };
        return { ok: true, status: 200, body: coverage };
      },
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['rag-panels/rag-ui.js', 'rag-panels/ingest-impact.js']) {
      new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    const flushAll = async () => {
      for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await (context.initIngestImpactPanel as () => Promise<void>)();
    await flushAll();
    const activate = doc.body.querySelectorAll('button').find((b) => b.textContent === 'Activate rebuild')!;
    activate.click();
    await flushAll();
    doc.body.querySelectorAll('dialog').find((d) => d.open)!.querySelectorAll('button').find((b) => b.textContent === 'Activate rebuild')!.click();
    await flushAll();
    const guard = context.ragIngestImpactGuard as (next: Record<string, string>, saved: Record<string, string>) => Promise<unknown>;
    const pending = guard({ RAG_TABLE_HEADER_REPEAT: XSS_PAYLOAD }, { RAG_TABLE_HEADER_REPEAT: JS_BREAKOUT });
    await flushAll();
    expectSafe(doc);
    expect(doc.innerHtmlWrites).toBe(0);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
    expect(doc.body.textContent).toContain(JS_BREAKOUT);
    doc.body.querySelectorAll('dialog').find((d) => d.open)!.close('keep');
    await pending;
  });
});

describe('rag-panels/upload-approvals.js renders server data as text (XSS)', () => {
  it('file names, uploader names, sources, kinds and exemption names create no element and no inline handler', async () => {
    const doc = new FakeDocument();
    const section = host(doc, 'rag-administration-approvals', 'section');
    for (const attr of ['data-upload-approvals-title', 'data-upload-approvals-description', 'data-upload-approvals-workspace', 'data-upload-approvals-alert', 'data-upload-approvals-content', 'data-upload-approvals-status']) {
      const el = doc.createElement('div');
      el.setAttribute(attr, '');
      section.appendChild(el);
    }
    const selector = host(doc, 'workspace-selector', 'select');
    const option = doc.createElement('option');
    option.setAttribute('value', 'org-1');
    option.textContent = XSS_PAYLOAD;
    selector.appendChild(option);
    selector.value = 'org-1';
    const user = (display: string) => ({ id: JS_BREAKOUT, display });
    const list = {
      success: true,
      mode: 'members',
      total: 2,
      items: [
        { id: 'd1', file_name: XSS_PAYLOAD, uploader: user(JS_BREAKOUT), source: XSS_PAYLOAD, doc_type: JS_BREAKOUT, uploaded_at: XSS_PAYLOAD, new_version: true },
        { id: JS_BREAKOUT, file_name: JS_BREAKOUT, uploader: user(''), source: 'upload', doc_type: 'general', uploaded_at: '2026-11-20T09:30:00.000Z' },
      ],
    };
    const exemptions = {
      success: true,
      total: 1,
      items: [{ id: 'e1', kind: XSS_PAYLOAD, ref: JS_BREAKOUT, display: XSS_PAYLOAD, added_by: user(XSS_PAYLOAD), added_at: JS_BREAKOUT }],
      choices: { connector: [{ ref: JS_BREAKOUT, display: XSS_PAYLOAD }], uploader: [] },
    };
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      navigator: { language: 'en-US' },
      location: { origin: 'http://config.local' },
      setTimeout,
      clearTimeout,
      AbortController,
      URLSearchParams,
      Intl,
      ragFetch: async (apiPath: string, init: { method?: string } = {}) => {
        if (apiPath.includes('/exemptions')) return { ok: true, status: 200, body: exemptions };
        if (init.method === 'POST') return { ok: false, status: 409, body: { success: false, error: XSS_PAYLOAD, reason: JS_BREAKOUT } };
        return { ok: true, status: 200, body: list };
      },
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['rag-panels/rag-ui.js', 'rag-panels/upload-approvals.js']) {
      new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    const flushAll = async () => {
      for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await (context.initUploadApprovalsPanel as () => Promise<void>)();
    await flushAll();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Approve upload')!.click();
    await flushAll();
    doc.getElementById('rag-upload-approvals-tab-exemptions')!.click();
    await flushAll();
    const kind = doc.getElementById('rag-upload-approvals-exempt-kind')!;
    kind.value = 'connector';
    kind.dispatch('change');
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Reject upload')!.click();
    await flushAll();
    expectSafe(doc);
    expect(doc.innerHtmlWrites).toBe(0);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
    expect(doc.body.textContent).toContain(JS_BREAKOUT);
    doc.body.querySelectorAll('dialog').find((d) => d.open)!.close('keep');
  });
});

describe('rag-panels/scope-tags.js renders server data as text (XSS)', () => {
  it('tag labels, other names, values, file names, sources and queue labels create no element and no inline handler', async () => {
    const doc = new FakeDocument();
    const section = host(doc, 'rag-administration-scopes', 'section');
    for (const attr of ['data-scope-tags-title', 'data-scope-tags-description', 'data-scope-tags-workspace', 'data-scope-tags-alert', 'data-scope-tags-content', 'data-scope-tags-status']) {
      const el = doc.createElement('div');
      el.setAttribute(attr, '');
      section.appendChild(el);
    }
    const selector = host(doc, 'workspace-selector', 'select');
    const option = doc.createElement('option');
    option.setAttribute('value', 'org-1');
    option.textContent = XSS_PAYLOAD;
    selector.appendChild(option);
    selector.value = 'org-1';
    const vocab = {
      success: true,
      items: [
        { id: 'e1', dimension: 'region', value: 'region-a', label: XSS_PAYLOAD, aliases: [JS_BREAKOUT, XSS_PAYLOAD], active: true },
        { id: JS_BREAKOUT, dimension: 'department', value: 'dept-a', label: JS_BREAKOUT, aliases: [], active: false },
      ],
    };
    const docs = {
      success: true,
      total: 1,
      suggested_total: 1,
      items: [
        {
          id: 'd1',
          file_name: XSS_PAYLOAD,
          doc_type: JS_BREAKOUT,
          tags: ['region:region-a', 'region:unknown-value'],
          suggestions: [{ dimension: 'department', value: 'dept-a', source: XSS_PAYLOAD }],
          uploaded_at: JS_BREAKOUT,
        },
      ],
    };
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      navigator: { language: 'en-US' },
      location: { origin: 'http://config.local' },
      setTimeout,
      clearTimeout,
      AbortController,
      URLSearchParams,
      Intl,
      ragFetch: async (apiPath: string, init: { method?: string } = {}) => {
        if (init.method === 'PATCH' || init.method === 'POST' || init.method === 'PUT') return { ok: false, status: 409, body: { success: false, error: XSS_PAYLOAD } };
        if (apiPath.startsWith('/api/rag/admin/scope-vocabulary')) return { ok: true, status: 200, body: vocab };
        return { ok: true, status: 200, body: docs };
      },
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['rag-panels/rag-ui.js', 'rag-panels/scope-tags.js']) {
      new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    const flushAll = async () => {
      for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await (context.initScopeTagsPanel as () => Promise<void>)();
    await flushAll();
    doc.getElementById('rag-scope-tags-tab-documents')!.click();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Edit tags')!.click();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Save tags')!.click();
    await flushAll();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Retire tag')!.click();
    await flushAll();
    const queue = doc.createElement('div');
    const extras = doc.createElement('div');
    extras.setAttribute('data-queue-extras', '1');
    queue.appendChild(extras);
    doc.body.appendChild(queue);
    (context.scopeTagsMountQueueControls as (...args: unknown[]) => void)(
      queue,
      [{ id: 1, name: XSS_PAYLOAD, replaces: { id: 'b0000000-0000-4000-8000-000000000001', name: JS_BREAKOUT } }],
      { tags: { enabled: true, vocabulary: [{ dimension: 'region', value: 'region-a', label: JS_BREAKOUT }] }, replaces: { enabled: true } },
      { organizationId: 'org-1' },
    );
    expectSafe(doc);
    expect(doc.innerHtmlWrites).toBe(0);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
    expect(doc.body.textContent).toContain(JS_BREAKOUT);
    doc.body.querySelectorAll('dialog').find((d) => d.open)!.close('keep');
  });
});

describe('rag-panels/versions-dates.js renders server data as text (XSS)', () => {
  it('file names, uploader names, origins, signals and evidence quotes create no element and no inline handler', async () => {
    const doc = new FakeDocument();
    const section = host(doc, 'rag-administration-versions', 'section');
    for (const attr of ['data-versions-dates-title', 'data-versions-dates-description', 'data-versions-dates-workspace', 'data-versions-dates-alert', 'data-versions-dates-content', 'data-versions-dates-status']) {
      const el = doc.createElement('div');
      el.setAttribute(attr, '');
      section.appendChild(el);
    }
    const selector = host(doc, 'workspace-selector', 'select');
    const option = doc.createElement('option');
    option.setAttribute('value', 'org-1');
    option.textContent = XSS_PAYLOAD;
    selector.appendChild(option);
    selector.value = 'org-1';
    const docOf = (id: string) => ({
      id,
      file_name: XSS_PAYLOAD,
      doc_type: JS_BREAKOUT,
      document_date: JS_BREAKOUT,
      effective_from: '2026-01-01',
      effective_to: null,
      uploaded_at: JS_BREAKOUT,
      uploader: { id: 'u', display: XSS_PAYLOAD },
    });
    const list = {
      success: true,
      detect: 'on',
      total: 2,
      items: [
        { kind: 'candidate', id: 'c1', origin: JS_BREAKOUT, direction: null, stale: true, signals: { title_match: true, content_overlap_percent: 80, conflicting_numbers: 2 }, document: docOf('d1'), candidate_document: docOf('d2') },
        { kind: 'link', id: 'c2', origin: 'detected', older_document: docOf('d3'), newer_document: docOf('d4'), decided_at: JS_BREAKOUT, decided_by: { id: 'x', display: JS_BREAKOUT } },
      ],
    };
    const dates = {
      success: true,
      total: 1,
      items: [{ id: 'd5', file_name: JS_BREAKOUT, effective_from: null, effective_to: null, origin: null, proposal: { from: '2099-01-01', to: null, confidence: 0.9, evidence_quote: XSS_PAYLOAD + ' ' + JS_BREAKOUT, awaiting: true } }],
    };
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      navigator: { language: 'en-US' },
      location: { origin: 'http://config.local' },
      setTimeout,
      clearTimeout,
      AbortController,
      URLSearchParams,
      Intl,
      ragFetch: async (apiPath: string, init: { method?: string } = {}) => {
        if (init.method === 'POST' || init.method === 'PUT') return { ok: false, status: 400, body: { success: false, error: XSS_PAYLOAD, details: [{ path: 'from', message: JS_BREAKOUT }] } };
        if (apiPath.startsWith('/api/rag/admin/supersession')) return { ok: true, status: 200, body: list };
        return { ok: true, status: 200, body: dates };
      },
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['rag-panels/rag-ui.js', 'rag-panels/versions-dates.js']) {
      new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    const flushAll = async () => {
      for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await (context.initVersionsDatesPanel as () => Promise<void>)();
    await flushAll();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Dismiss candidate')!.click();
    await flushAll();
    doc.getElementById('rag-versions-dates-tab-dates')!.click();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Edit dates')!.click();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Save dates')!.click();
    await flushAll();
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Apply dates')!.click();
    await flushAll();
    expectSafe(doc);
    expect(doc.innerHtmlWrites).toBe(0);
    expect(doc.body.querySelectorAll('a')).toHaveLength(0);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
    expect(doc.body.textContent).toContain(JS_BREAKOUT);
    doc.body.querySelectorAll('dialog').find((d) => d.open)!.close('keep');
  });
});

describe('rag-panels/translation-targets.js renders server data as text (XSS)', () => {
  it('language codes, coverage values, error codes and details create no element and no inline handler', async () => {
    const doc = new FakeDocument();
    const section = host(doc, 'rag-administration-translation', 'section');
    for (const attr of ['data-translation-targets-title', 'data-translation-targets-description', 'data-translation-targets-workspace', 'data-translation-targets-alert', 'data-translation-targets-content', 'data-translation-targets-status']) {
      const el = doc.createElement('div');
      el.setAttribute(attr, '');
      section.appendChild(el);
    }
    const selector = host(doc, 'workspace-selector', 'select');
    const option = doc.createElement('option');
    option.setAttribute('value', 'org-1');
    option.textContent = XSS_PAYLOAD;
    selector.appendChild(option);
    selector.value = 'org-1';
    const settings = {
      success: true,
      enabled: true,
      targets: ['en', XSS_PAYLOAD],
      supportedLanguages: ['zh', 'en', XSS_PAYLOAD, JS_BREAKOUT],
      languagesConfigured: true,
      monolingual: false,
      coverage: [
        { language: 'en', done: XSS_PAYLOAD, total: JS_BREAKOUT, gaps: 2 },
        { language: XSS_PAYLOAD, done: 1, total: 2, gaps: JS_BREAKOUT },
      ],
      stale: true,
      deploymentSwitch: 'on',
      model: XSS_PAYLOAD,
    };
    const context: Record<string, unknown> = {
      document: doc,
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      navigator: { language: 'en-US', clipboard: { writeText: async () => {} } },
      location: { origin: 'http://config.local' },
      setTimeout,
      clearTimeout,
      AbortController,
      URLSearchParams,
      Intl,
      ragFetch: async (_apiPath: string, init: { method?: string } = {}) => {
        if (init.method === 'PUT') return { ok: false, status: 400, body: { success: false, error: XSS_PAYLOAD, details: [{ path: 'targets', message: JS_BREAKOUT }] } };
        return { ok: true, status: 200, body: settings };
      },
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['rag-panels/rag-ui.js', 'rag-panels/translation-targets.js']) {
      new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    const flushAll = async () => {
      for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await (context.initTranslationTargetsPanel as () => Promise<void>)();
    await flushAll();
    const zh = doc.body.querySelector('[data-translation-targets-target="zh"]')!;
    zh.checked = true;
    zh.dispatch('change');
    doc.body.querySelectorAll('button').find((b) => b.textContent === 'Save targets')!.click();
    await flushAll();
    expectSafe(doc);
    expect(doc.innerHtmlWrites).toBe(0);
    expect(doc.body.querySelectorAll('a')).toHaveLength(0);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
    expect(doc.body.textContent).toContain(JS_BREAKOUT);
    expect(doc.body.querySelectorAll('[data-translation-targets-target]').map((b) => b.getAttribute('data-translation-targets-target'))).toEqual(['zh', 'en']);
  });
});

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
  return doc.documentElement.querySelectorAll('*').filter((el) => (el.getAttribute('onclick') || '').includes('PWNED'));
}

function expectSafe(doc: FakeDocument) {
  expect(injectedElements(doc)).toEqual([]);
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
      instance.config = { providers: [p] };
      instance.renderProvidersList();
      expectSafe(doc);
    }
  });

  it('connections table: labels and counts', () => {
    const doc = new FakeDocument();
    host(doc, 'connections-table-body', 'tbody');
    const { instance } = loadClass(doc, 'connectors-config.js', 'ConnectorsConfigManager');
    instance.config = { providers: [provider()] };
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
    instance.servers = [server, { ...server, id: 'zapier' }];
    instance.renderServerList();
    expectSafe(doc);
    expect(doc.getElementById('mcp-servers-list')!.textContent).toContain(XSS_PAYLOAD);
  });

  it('add/edit dialog: stored values and credentials', () => {
    for (const editing of [false, true]) {
      const doc = new FakeDocument();
      const { instance } = loadClass(doc, 'mcp-config.js', 'McpConfigManager');
      instance.currentEditingServer = editing ? server : null;
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

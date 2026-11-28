import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { FakeDocument, FakeElement } from './html-fake-dom';
import { markedBlock } from './ingest-impact-harness';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');

export type Json = Record<string, unknown>;

export interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}

export type Route = 'vocab' | 'create' | 'update' | 'documents' | 'setScopes' | 'dateSearch';

export interface RagCall {
  route: Route | 'unknown';
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}

export interface ScopeTagsHarnessOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | ((call: RagCall) => Reply)>>;
  workspaces?: Array<{ value: string; text: string }>;
  workspace?: string;
  scopeTags?: string;
  suggest?: string;
  pipeline?: string;
  ingestPipeline?: string;
  /** Mount only the queue: no panel skeleton. */
  queueOnly?: boolean;
}

export function entry(n: number, extra: Json = {}): Json {
  return {
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    dimension: 'region',
    value: `region-${n}`,
    label: `Region ${n}`,
    aliases: [`Area ${n}`, `Zone ${n}`],
    active: true,
    updated_at: '2026-11-20T09:30:00.000Z',
    ...extra,
  };
}

export function vocabAnswer(items: Json[]): Json {
  return { success: true, dimensions: ['region', 'legal_entity', 'department'], items };
}

export const DEFAULT_VOCAB = [
  entry(1),
  entry(2, { active: false }),
  entry(3, { dimension: 'department', value: 'dept-1', label: 'Dept. 1', aliases: [] }),
];

export function doc(n: number, extra: Json = {}): Json {
  return {
    id: `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    file_name: `document-${n}.pdf`,
    doc_type: 'general',
    status: 'ready',
    version: 1,
    tags: ['region:region-1'],
    suggestions: [{ dimension: 'department', value: 'dept-1', source: 'rule' }],
    uploaded_at: '2026-11-20T09:30:00.000Z',
    ...extra,
  };
}

export function docsAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, total: items.length, suggested_total: 3, limit: 50, offset: 0, items, ...extra };
}

const VOCAB = '/api/rag/admin/scope-vocabulary';
const DOCS = '/api/rag/admin/documents';

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const pathname = apiPath.split('?')[0]!;
  if (pathname === VOCAB && method === 'GET') return 'vocab';
  if (pathname === VOCAB && method === 'POST') return 'create';
  if (pathname === VOCAB && method === 'PATCH') return 'update';
  if (pathname === DOCS && method === 'GET') return 'documents';
  if (/^\/api\/rag\/admin\/documents\/[^/]+\/scopes$/.test(pathname) && method === 'PUT') return 'setScopes';
  if (pathname === '/api/rag/admin/effective-dates' && method === 'GET') return 'dateSearch';
  return 'unknown';
}

function defaultReply(call: RagCall): Reply {
  switch (call.route) {
    case 'vocab':
      return { status: 200, body: vocabAnswer(DEFAULT_VOCAB) };
    case 'create':
      return { status: 201, body: { success: true, item: entry(9, { ...(call.body as Json) }) } };
    case 'update':
      return { status: 200, body: { success: true, item: entry(1, { ...(call.body as Json) }) } };
    case 'documents':
      return { status: 200, body: docsAnswer([doc(1), doc(2, { tags: [], suggestions: [] })]) };
    case 'setScopes':
      return { status: 200, body: { success: true, id: 'x', scopes: (call.body as Json).scopes } };
    case 'dateSearch':
      return { status: 200, body: { success: true, total: 0, items: [] } };
    default:
      return { status: 500, body: null };
  }
}

function addSelect(doc: FakeDocument, id: string, value: string): FakeElement {
  const select = doc.createElement('select');
  select.id = id;
  select.value = value;
  doc.body.appendChild(select);
  return select;
}

/** The RAG administration tab with the real Document tags skeleton and settings block of index.html, and the panel scripts. */
export function loadScopeTagsPage(options: ScopeTagsHarnessOptions = {}) {
  const doc = new FakeDocument();
  const ragCalls: RagCall[] = [];

  for (const label of ['desktop', 'mobile']) {
    const link = doc.createElement('a');
    link.setAttribute('data-tab', 'rag-administration');
    link.setAttribute('data-test-link', label);
    doc.body.appendChild(link);
  }

  const pipeline = addSelect(doc, 'RAG_PIPELINE', options.pipeline ?? 'v2');
  const ingestPipeline = addSelect(doc, 'RAG_INGEST_PIPELINE', options.ingestPipeline ?? 'unified');

  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  for (const ws of options.workspaces ?? [{ value: '', text: 'Default Workspace' }]) {
    const option = doc.createElement('option');
    option.setAttribute('value', ws.value);
    option.textContent = ws.text;
    selector.appendChild(option);
  }
  selector.value = options.workspace ?? '';
  doc.body.appendChild(selector);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = options.queueOnly ? 'tab-content' : 'tab-content active';
  doc.body.appendChild(tab);

  if (!options.queueOnly) {
    const ingestion = doc.createElement('section');
    ingestion.id = 'rag-administration-ingestion';
    tab.appendChild(ingestion);
    const settingsHolder = doc.createElement('div');
    ingestion.appendChild(settingsHolder);
    settingsHolder.innerHTML = markedBlock('rag-phase032-settings');
    const tags = doc.getElementById('RAG_SCOPE_TAGS');
    if (tags) tags.value = options.scopeTags ?? 'true';
    const suggest = doc.getElementById('RAG_SCOPE_TAG_SUGGEST');
    if (suggest) suggest.value = options.suggest ?? 'false';

    const holder = doc.createElement('div');
    tab.appendChild(holder);
    holder.innerHTML = markedBlock('rag-scope-tags');
  }
  doc.innerHtmlWrites = 0;

  const replyFor = (call: RagCall): Reply => {
    const custom = options.replies?.[call.route as Route];
    if (typeof custom === 'function') return custom(call);
    return custom ?? defaultReply(call);
  };

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const route = routeOf(apiPath, method);
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const call: RagCall = { route, path: apiPath, method, query, body };
    ragCalls.push(call);
    if (route === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const reply = replyFor(call);
    if (reply.throws) throw new TypeError('Failed to fetch');
    const answer = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: answer };
  };

  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    location: { origin: 'http://config.local', search: '', hash: '' },
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    Intl,
    Date,
    ragFetch,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/doc-types.js', 'rag-panels/scope-tags.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }

  const root = doc.getElementById('rag-administration-scopes');
  return {
    doc,
    context,
    root: root as FakeElement,
    selector,
    pipeline,
    ingestPipeline,
    ragCalls,
    calls(route: Route) {
      return ragCalls.filter((c) => c.route === route);
    },
    async init() {
      const init = context.initScopeTagsPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initScopeTagsPanel is not defined');
      await init();
      await flush();
    },
    dialog(): FakeElement | null {
      return doc.querySelectorAll('dialog').find((d) => d.open) ?? null;
    },
    status(): FakeElement {
      return doc.querySelector('[data-scope-tags-status]') as FakeElement;
    },
    alertHost(): FakeElement {
      return doc.querySelector('[data-scope-tags-alert]') as FakeElement;
    },
    tabButton(id: 'vocabulary' | 'documents' | 'settings'): FakeElement {
      const button = doc.getElementById(`rag-scope-tags-tab-${id}`);
      if (!button) throw new Error('no tab ' + id);
      return button;
    },
    panel(id: 'vocabulary' | 'documents' | 'settings'): FakeElement {
      const el = doc.getElementById(`rag-scope-tags-panel-${id}`);
      if (!el) throw new Error('no panel ' + id);
      return el;
    },
  };
}

export type ScopeTagsPage = ReturnType<typeof loadScopeTagsPage>;

export async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function buttonByText(root: FakeElement | null, text: string): FakeElement {
  const button = (root ? root.querySelectorAll('button') : []).find((b) => b.textContent.trim() === text);
  if (!button) throw new Error('no button ' + text);
  return button;
}

export function buttonsByText(root: FakeElement | null, text: string): FakeElement[] {
  return (root ? root.querySelectorAll('button') : []).filter((b) => b.textContent.trim() === text);
}

/** The queue item template method of DocumentProcessor in index.html, runnable on a stand-in object. */
export function queueItemTemplate(): (self: Json, item: Json) => string {
  const html = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
  const start = html.indexOf('createQueueItemHTML(item) {');
  if (start < 0) throw new Error('createQueueItemHTML not found');
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', start); i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = html.slice(html.indexOf('{', start) + 1, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('item', 'window', body) as (item: Json, window: Json) => string;
  return (self, item) => fn.call(self, item, (self.window as Json) ?? {});
}

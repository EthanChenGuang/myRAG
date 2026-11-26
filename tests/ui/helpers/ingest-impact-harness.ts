import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { FakeDocument, FakeElement } from './html-fake-dom';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
export const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');

export type Json = Record<string, unknown>;

export interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}

export type Route = 'coverage' | 'impact' | 'start' | 'activate' | 'rollback';

export interface RagCall {
  route: Route | 'unknown';
  path: string;
  method: string;
  body: unknown;
}

export interface ImpactHarnessOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | ((body: unknown, path: string) => Reply)>>;
  hold?: Route[];
  activeTab?: boolean;
  clipboard?: boolean;
  visibility?: 'visible' | 'hidden';
  globals?: Json;
}

/** The markup between `<!-- name:start -->` and `<!-- name:end -->` in index.html. */
export function markedBlock(name: string): string {
  const start = indexHtml.indexOf(`<!-- ${name}:start -->`);
  const end = indexHtml.indexOf(`<!-- ${name}:end -->`);
  if (start < 0 || end < start) return '';
  return indexHtml.slice(start, end);
}

export function impactAnswer(extra: Json = {}): Json {
  return {
    ingestion_keys: ['RAG_TABLE_HEADER_REPEAT'],
    by_mechanism: [
      { mechanism: 'rechunk', doc_type: 'general', affected: 212 },
      { mechanism: 'rechunk', doc_type: 'contract_legal', affected: 41 },
      { mechanism: 'rechunk', doc_type: 'invoice', affected: 0 },
    ],
    without_fingerprint: 0,
    total_current: 400,
    ...extra,
  };
}

export function pendingRow(mechanism: string, affected: number, start: 'ui' | 'cli' | 'needs_async', command = `npm run rag:rebuild -- start --mechanism ${mechanism}`): Json {
  return { mechanism, affected, by_doc_type: { general: affected }, start, command };
}

export function runRow(extra: Json = {}): Json {
  return {
    id: '7d1c2a3b-0000-4000-8000-00000000abcd',
    mechanism: 'reparse',
    done: 120,
    total: 310,
    gaps: 0,
    state: 'running',
    started: '2026-11-20T09:30:00.000Z',
    activation: 'rebuild_batch',
    ...extra,
  };
}

export function coverageAnswer(extra: Json = {}): Json {
  return {
    success: true,
    pending: [],
    without_fingerprint: { count: 0, command: 'npm run rag:fingerprint -- backfill' },
    total_current: 400,
    rebuilds: [],
    ...extra,
  };
}

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  if (apiPath === '/api/rag/admin/ingest-fingerprint' && method === 'GET') return 'coverage';
  if (apiPath === '/api/rag/admin/ingest-fingerprint/impact' && method === 'POST') return 'impact';
  if (apiPath === '/api/rag/admin/ingest-fingerprint/rebuild' && method === 'POST') return 'start';
  if (/^\/api\/rag\/admin\/ingest-fingerprint\/rebuild\/[^/]+\/activate$/.test(apiPath) && method === 'POST') return 'activate';
  if (/^\/api\/rag\/admin\/ingest-fingerprint\/rebuild\/[^/]+\/rollback$/.test(apiPath) && method === 'POST') return 'rollback';
  return 'unknown';
}

const DEFAULT_REPLIES: Record<Route, Reply> = {
  coverage: { status: 200, body: coverageAnswer() },
  impact: { status: 200, body: impactAnswer() },
  start: { status: 200, body: { success: true, mechanism: 'rechunk', affected: 253, status: 'started', run: runRow({ mechanism: 'rechunk' }) } },
  activate: { status: 200, body: { success: true, published: 310, superseded: 310 } },
  rollback: { status: 200, body: { success: true, restored: 310 } },
};

function addSection(doc: FakeDocument, parent: FakeElement, id: string, headingId: string, title: string): FakeElement {
  const section = doc.createElement('section');
  section.id = id;
  const heading = doc.createElement('h3');
  heading.id = headingId;
  heading.textContent = title;
  section.appendChild(heading);
  parent.appendChild(section);
  return section;
}

/** The RAG administration tab with the real Ingestion changes skeleton and settings block of index.html, and the panel scripts. */
export function loadImpactPage(options: ImpactHarnessOptions = {}) {
  const doc = new FakeDocument();
  (doc as unknown as Json).visibilityState = options.visibility ?? 'visible';
  const ragCalls: RagCall[] = [];
  const toasts: Array<{ message: string; type: string }> = [];
  const clipboardWrites: string[] = [];
  const held = new Map<Route, Array<(reply: Reply) => void>>();

  for (const label of ['desktop', 'mobile']) {
    const link = doc.createElement('a');
    link.className = 'menu-item';
    link.setAttribute('data-tab', 'rag-administration');
    link.setAttribute('data-test-link', label);
    doc.body.appendChild(link);
  }

  const pipeline = doc.createElement('select');
  pipeline.id = 'RAG_INGEST_PIPELINE';
  pipeline.value = 'legacy';
  doc.body.appendChild(pipeline);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = options.activeTab === false ? 'tab-content' : 'tab-content active';
  doc.body.appendChild(tab);

  const ingestion = doc.createElement('section');
  ingestion.id = 'rag-administration-ingestion';
  tab.appendChild(ingestion);
  const settingsHolder = doc.createElement('div');
  ingestion.appendChild(settingsHolder);
  settingsHolder.innerHTML = markedBlock('rag-phase032-settings');

  const impactHolder = doc.createElement('div');
  tab.appendChild(impactHolder);
  impactHolder.innerHTML = markedBlock('rag-ingest-impact');
  doc.innerHtmlWrites = 0;

  const chunking = addSection(doc, tab, 'rag-administration-chunking', 'rag-chunking-title', 'Chunking profiles');
  const profiles = addSection(doc, tab, 'rag-administration-profiles', 'rag-profiles-title', 'Embedding profiles');

  const replyFor = (route: Route, body: unknown, apiPath: string): Reply => {
    const custom = options.replies?.[route];
    if (typeof custom === 'function') return custom(body, apiPath);
    return custom ?? DEFAULT_REPLIES[route];
  };

  const answer = (reply: Reply) => {
    if (reply.throws) throw new TypeError('Failed to fetch');
    const body = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body };
  };

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const route = routeOf(apiPath, method);
    ragCalls.push({ route, path: apiPath, method, body });
    if (route === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    if (options.hold?.includes(route)) {
      const reply = await new Promise<Reply>((resolve) => {
        held.set(route, [...(held.get(route) ?? []), resolve]);
      });
      return answer(reply);
    }
    return answer(replyFor(route, body, apiPath));
  };

  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: {
      language: options.locale ?? 'en-US',
      ...(options.clipboard === false ? {} : { clipboard: { writeText: async (text: string) => void clipboardWrites.push(text) } }),
    },
    location: { origin: 'http://config.local', search: '', hash: '' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    URLSearchParams,
    Intl,
    Date,
    ragFetch,
    showToast: (message: string, type = 'info') => void toasts.push({ message, type }),
    ...(options.globals ?? {}),
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/doc-types.js', 'rag-panels/ingest-impact.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }

  const root = doc.getElementById('rag-administration-ingest-impact');
  return {
    doc,
    context,
    root,
    tab,
    pipeline,
    chunking,
    profiles,
    ragCalls,
    toasts,
    clipboardWrites,
    calls(route: Route) {
      return ragCalls.filter((c) => c.route === route);
    },
    release(route: Route, reply: Reply) {
      const queue = held.get(route) ?? [];
      const resolve = queue.shift();
      held.set(route, queue);
      if (!resolve) throw new Error('nothing held for ' + route);
      resolve(reply);
    },
    pending(route: Route) {
      return (held.get(route) ?? []).length;
    },
    input(id: string): FakeElement {
      const el = doc.getElementById(id);
      if (!el) throw new Error('no input ' + id);
      return el;
    },
    dialog(): FakeElement | null {
      return doc.querySelectorAll('dialog').find((d) => d.open) ?? null;
    },
    status(): FakeElement {
      return doc.querySelector('[data-ingest-impact-status]') as FakeElement;
    },
  };
}

export type ImpactPage = ReturnType<typeof loadImpactPage>;

export async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buttonByText(root: FakeElement | null, text: string): FakeElement {
  const button = (root ? root.querySelectorAll('button') : []).find((b) => b.textContent.trim() === text);
  if (!button) throw new Error('no button ' + text);
  return button;
}

export function maybeButton(root: FakeElement | null, text: string): FakeElement | undefined {
  return (root ? root.querySelectorAll('button') : []).find((b) => b.textContent.trim() === text);
}

/** Every attribute value and text node under root, for "never rendered" checks. */
export function everything(root: FakeElement): string {
  const parts: string[] = [root.textContent];
  for (const el of [root, ...root.querySelectorAll('*')]) for (const value of el.attributes.values()) parts.push(value);
  return parts.join('\n');
}

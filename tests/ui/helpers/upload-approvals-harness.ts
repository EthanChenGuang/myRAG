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

export type Route = 'list' | 'approve' | 'reject' | 'exemptions' | 'addExemption' | 'removeExemption';

export interface RagCall {
  route: Route | 'unknown';
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}

export interface ApprovalsHarnessOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | ((call: RagCall) => Reply)>>;
  hold?: Route[];
  workspaces?: Array<{ value: string; text: string }>;
  workspace?: string;
  approvalMode?: string;
  pipeline?: string;
}

export function pendingItem(n: number, extra: Json = {}): Json {
  return {
    id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    lineage_id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    file_name: `report-${n}.pdf`,
    uploader: { id: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`, display: `member${n}@example.test` },
    source: 'upload',
    doc_type: 'general',
    version: 1,
    uploaded_at: '2026-11-20T09:30:00.000Z',
    new_version: false,
    ...extra,
  };
}

export function listAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, mode: 'members', total: items.length, limit: 50, offset: 0, items, exemptions: [], exemptions_total: 0, ...extra };
}

export function exemptionItem(n: number, extra: Json = {}): Json {
  return {
    id: `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    kind: 'uploader',
    ref: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    display: `member${n}@example.test`,
    added_by: { id: '60000000-0000-4000-8000-000000000001', display: 'admin@example.test' },
    added_at: '2026-11-21T10:00:00.000Z',
    ...extra,
  };
}

export function exemptionsAnswer(items: Json[], extra: Json = {}): Json {
  return {
    success: true,
    total: items.length,
    limit: 100,
    offset: 0,
    items,
    choices: {
      connector: [{ ref: '70000000-0000-4000-8000-000000000001', display: 'Shared drive' }],
      uploader: [
        { ref: '40000000-0000-4000-8000-000000000007', display: 'member7@example.test' },
        { ref: '40000000-0000-4000-8000-000000000008', display: '40000000-0000-4000-8000-000000000008' },
      ],
    },
    ...extra,
  };
}

const BASE = '/api/rag/admin/upload-approvals';

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const pathname = apiPath.split('?')[0]!;
  if (pathname === BASE && method === 'GET') return 'list';
  if (pathname === `${BASE}/exemptions`) {
    if (method === 'GET') return 'exemptions';
    if (method === 'POST') return 'addExemption';
    if (method === 'DELETE') return 'removeExemption';
  }
  if (/^\/api\/rag\/admin\/upload-approvals\/[^/]+\/approve$/.test(pathname) && method === 'POST') return 'approve';
  if (/^\/api\/rag\/admin\/upload-approvals\/[^/]+\/reject$/.test(pathname) && method === 'POST') return 'reject';
  return 'unknown';
}

const DEFAULT_REPLIES: Record<Route, Reply> = {
  list: { status: 200, body: listAnswer([pendingItem(1), pendingItem(2)]) },
  approve: { status: 200, body: { success: true, outcome: 'published', status: 'ready', version: 1 } },
  reject: { status: 200, body: { success: true } },
  exemptions: { status: 200, body: exemptionsAnswer([exemptionItem(1)]) },
  addExemption: { status: 201, body: { success: true, outcome: 'added', item: exemptionItem(7) } },
  removeExemption: { status: 200, body: { success: true } },
};

/** The RAG administration tab with the real Upload approvals skeleton and settings block of index.html, and the panel scripts. */
export function loadApprovalsPage(options: ApprovalsHarnessOptions = {}) {
  const doc = new FakeDocument();
  const ragCalls: RagCall[] = [];
  const held = new Map<Route, Array<(reply: Reply) => void>>();

  for (const label of ['desktop', 'mobile']) {
    const link = doc.createElement('a');
    link.setAttribute('data-tab', 'rag-administration');
    link.setAttribute('data-test-link', label);
    doc.body.appendChild(link);
  }

  const pipeline = doc.createElement('select');
  pipeline.id = 'RAG_INGEST_PIPELINE';
  pipeline.value = options.pipeline ?? 'unified';
  doc.body.appendChild(pipeline);

  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  for (const ws of options.workspaces ?? [{ value: '', text: '👤 Default Workspace' }]) {
    const option = doc.createElement('option');
    option.setAttribute('value', ws.value);
    option.textContent = ws.text;
    selector.appendChild(option);
  }
  selector.value = options.workspace ?? '';
  doc.body.appendChild(selector);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);

  const ingestion = doc.createElement('section');
  ingestion.id = 'rag-administration-ingestion';
  tab.appendChild(ingestion);
  const settingsHolder = doc.createElement('div');
  ingestion.appendChild(settingsHolder);
  settingsHolder.innerHTML = markedBlock('rag-phase032-settings');
  const approval = doc.getElementById('RAG_UPLOAD_APPROVAL');
  if (approval) approval.value = options.approvalMode ?? 'members';

  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-upload-approvals');
  doc.innerHtmlWrites = 0;

  const replyFor = (call: RagCall): Reply => {
    const custom = options.replies?.[call.route as Route];
    if (typeof custom === 'function') return custom(call);
    return custom ?? DEFAULT_REPLIES[call.route as Route];
  };

  const answer = (reply: Reply) => {
    if (reply.throws) throw new TypeError('Failed to fetch');
    const body = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body };
  };

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const route = routeOf(apiPath, method);
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const call: RagCall = { route, path: apiPath, method, query, body };
    ragCalls.push(call);
    if (route === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    if (options.hold?.includes(route)) {
      const reply = await new Promise<Reply>((resolve) => {
        held.set(route, [...(held.get(route) ?? []), resolve]);
      });
      return answer(reply);
    }
    return answer(replyFor(call));
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
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/doc-types.js', 'rag-panels/upload-approvals.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }

  const root = doc.getElementById('rag-administration-approvals');
  return {
    doc,
    context,
    root: root as FakeElement,
    selector,
    pipeline,
    ragCalls,
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
    async init() {
      const init = context.initUploadApprovalsPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initUploadApprovalsPanel is not defined');
      await init();
      await flush();
    },
    dialog(): FakeElement | null {
      return doc.querySelectorAll('dialog').find((d) => d.open) ?? null;
    },
    status(): FakeElement {
      return doc.querySelector('[data-upload-approvals-status]') as FakeElement;
    },
    alertHost(): FakeElement {
      return doc.querySelector('[data-upload-approvals-alert]') as FakeElement;
    },
    tabButton(id: 'pending' | 'exemptions' | 'settings'): FakeElement {
      const button = doc.getElementById(`rag-upload-approvals-tab-${id}`);
      if (!button) throw new Error('no tab ' + id);
      return button;
    },
    panel(id: 'pending' | 'exemptions' | 'settings'): FakeElement {
      const el = doc.getElementById(`rag-upload-approvals-panel-${id}`);
      if (!el) throw new Error('no panel ' + id);
      return el;
    },
    rows(): FakeElement[] {
      return doc.querySelectorAll('tr[data-upload-approvals-row]');
    },
  };
}

export type ApprovalsPage = ReturnType<typeof loadApprovalsPage>;

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

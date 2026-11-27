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

export interface Call {
  path: string;
  method: string;
  body: unknown;
}

export interface PipelineHarnessOptions {
  locale?: string;
  entries?: Json[];
  envModifiedAt?: string | null;
  manifest?: Reply;
  compat?: Reply;
  targets?: Reply;
  put?: Reply | ((call: Call) => Reply);
  test?: (call: Call) => Reply;
  /** Markup placed before the section, for example a hidden staging block holding a hand-written control. */
  before?: string;
  /** The page markup to mount instead of the skeleton (for example the real RAG Modes tab). */
  page?: string;
}

/** One manifest entry as the config server sends it. */
export function entry(name: string, extra: Json = {}): Json {
  return { name, group: 'retrieval', label: name.toLowerCase().replace(/_/g, ' '), type: 'string', options: [], requires: [], default: '', value: null, ...extra };
}

export function secretEntry(name: string, extra: Json = {}): Json {
  return { name, group: 'backends', label: name.toLowerCase().replace(/_/g, ' '), type: 'secret', requires: [], default: '', secret: { state: 'unset' }, ...extra };
}

export const SKELETON = `
<section id="rag-pipeline-settings" class="mt-6 min-w-0 scroll-mt-4" aria-labelledby="rag-pipeline-title">
  <h3 id="rag-pipeline-title" class="text-lg font-semibold mb-2" tabindex="-1" data-rag-pipeline-title>RAG pipeline settings</h3>
  <p class="text-sm text-base-content/70 mb-2 max-w-prose" data-rag-pipeline-description></p>
  <p class="text-xs text-base-content/70 mb-4 max-w-prose" data-rag-pipeline-secrets-note></p>
  <div data-rag-pipeline-alert class="mb-4 empty:mb-0"></div>
  <nav data-rag-pipeline-nav class="flex flex-wrap gap-2 mb-4"></nav>
  <div data-rag-pipeline-content class="grid gap-6">Loading settings…</div>
  <div data-rag-pipeline-status class="text-sm mt-4" role="status" aria-live="polite"></div>
</section>`;

export function compatAnswer(extra: Json = {}): Json {
  return {
    success: true,
    warnings: [],
    backends: [
      { target: 'qdrant', enabled: false, pending: 0, leased: 0, dead: 0, oldestPendingSeconds: null, selected: false, profiles: [] },
      { target: 'weaviate', enabled: false, pending: 0, leased: 0, dead: 0, oldestPendingSeconds: null, selected: false, profiles: [] },
    ],
    envLoadedAt: '2026-11-20T10:00:00.000Z',
    ...extra,
  };
}

export function loadScript(context: vm.Context, file: string): void {
  vm.runInContext(fs.readFileSync(path.join(configUiDir, file), 'utf8'), context, { filename: file });
}

export async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function loadPipelinePage(options: PipelineHarnessOptions = {}) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const holder = doc.createElement('div');
  doc.body.appendChild(holder);
  holder.innerHTML = options.page ?? `${options.before ?? ''}${SKELETON}`;
  doc.innerHtmlWrites = 0;

  const answer = (reply: Reply) => {
    if (reply.throws) throw new TypeError('Failed to fetch');
    const body = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body };
  };

  const manifestReply = (): Reply =>
    options.manifest ?? { status: 200, body: { success: true, entries: options.entries ?? [], envModifiedAt: options.envModifiedAt ?? '2026-11-20T09:00:00.000Z' } };

  const fetchStub = async (url: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    calls.push({ path: url, method, body: init.body });
    if (url !== '/api/rag-pipeline/manifest') throw new TypeError('unexpected fetch ' + url);
    const reply = answer(manifestReply());
    return { ok: reply.ok, status: reply.status, json: async () => reply.body };
  };

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call: Call = { path: apiPath, method, body };
    calls.push(call);
    if (apiPath === '/api/rag/admin/index-compat') return answer(options.compat ?? { status: 200, body: compatAnswer() });
    if (apiPath === '/api/rag/admin/vector-sync/targets' && method === 'GET') {
      return answer(options.targets ?? { status: 200, body: { success: true, targets: [{ target: 'qdrant', enabled: false }, { target: 'weaviate', enabled: false }] } });
    }
    if (apiPath === '/api/rag/admin/vector-sync/targets' && method === 'PUT') {
      const put = options.put;
      return answer(typeof put === 'function' ? put(call) : put ?? { status: 200, body: { success: true, target: (body as Json).target, enabled: (body as Json).enabled, tenantsEnqueued: 3 } });
    }
    if (apiPath === '/api/rag/admin/providers/test' && method === 'POST') {
      return answer(options.test ? options.test(call) : { status: 200, body: { provider: (body as Json).provider, ok: true, latencyMs: 42, code: 'ok', message: 'Connected.' } });
    }
    throw new TypeError('unexpected request ' + method + ' ' + apiPath);
  };

  const configManager = { config: {} as Record<string, string> };
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
    Promise,
    fetch: fetchStub,
    ragFetch,
    configManager,
  };
  context.window = context;
  vm.createContext(context);
  loadScript(context, 'rag-panels/rag-fetch.js');
  context.ragFetch = ragFetch;
  loadScript(context, 'rag-panels/rag-ui.js');
  loadScript(context, 'rag-panels/rag-pipeline.js');
  doc.dispatch('DOMContentLoaded');

  const section = () => doc.getElementById('rag-pipeline-settings') as FakeElement;
  const row = (name: string) => section().querySelector(`[data-rag-pipeline-row="${name}"]`);
  const control = (name: string) => doc.getElementById(name);
  return { doc, calls, context, configManager, section, row, control };
}

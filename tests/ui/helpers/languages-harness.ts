import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { FakeDocument, FakeElement } from './html-fake-dom';

const configUiDir = path.resolve(import.meta.dirname, '../../../scripts/config-ui');

export type Json = Record<string, unknown>;

export interface FetchCall {
  url: string;
  init: Json;
  body: unknown;
}

export interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}

export function pack(code: string, nativeName: string, englishName: string, extra: Json = {}): Json {
  return { code, nativeName, englishName, groundedness: 'hhem', selectable: true, reasons: [], ...extra };
}

export function languagesAnswer(extra: Json = {}): Json {
  return {
    configured: false,
    languages: [],
    primary: null,
    variablesSet: { RAG_SUPPORTED_LANGUAGES: false, RAG_PRIMARY_LANGUAGE: false },
    pipelines: {
      RAG_PIPELINE: { value: null, explicit: false },
      RAG_INGEST_PIPELINE: { value: null, explicit: false },
    },
    reranker: null,
    embeddingProfile: { id: 'profile-default' },
    verifiedAgainstActiveProfile: true,
    packs: [pack('zh', '中文', 'Chinese'), pack('en', 'English', 'English'), pack('it', 'Italiano', 'Italian')],
    ...extra,
  };
}

export interface HarnessOptions {
  locale?: string;
  get?: Reply | (() => Reply);
  post?: Reply | ((body: unknown) => Reply);
  counts?: Reply;
  scripts?: string[];
  activeTab?: boolean;
  withMirrors?: boolean;
  globals?: Json;
}

function makeResponse(reply: Reply) {
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => {
      if (reply.body === undefined) throw new Error('no body');
      return JSON.parse(JSON.stringify(reply.body));
    },
  };
}

/** Builds the page skeleton of index.html that languages.js needs and loads the scripts in one classic-script context. */
export function loadLanguagesPage(options: HarnessOptions = {}) {
  const doc = new FakeDocument();
  const calls: FetchCall[] = [];
  const ragCalls: FetchCall[] = [];

  const link = doc.createElement('a');
  link.className = 'menu-item';
  link.setAttribute('data-tab', 'rag-administration');
  const tabClicks: string[] = [];
  link.addEventListener('click', () => tabClicks.push('desktop'));
  doc.body.appendChild(link);
  const mobileLink = doc.createElement('a');
  mobileLink.className = 'menu-item';
  mobileLink.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(mobileLink);

  const main = doc.createElement('div');
  main.className = 'p-6';
  doc.body.appendChild(main);
  const banner = doc.createElement('div');
  banner.id = 'rag-language-banner';
  main.appendChild(banner);
  const tab = doc.createElement('div');
  tab.className = options.activeTab ? 'tab-content active' : 'tab-content';
  tab.id = 'rag-administration';
  main.appendChild(tab);

  const section = doc.createElement('section');
  section.id = 'rag-administration-languages';
  tab.appendChild(section);
  const heading = doc.createElement('h3');
  heading.id = 'rag-languages-title';
  heading.setAttribute('tabindex', '-1');
  heading.setAttribute('data-languages-title', '');
  section.appendChild(heading);
  const description = doc.createElement('p');
  description.setAttribute('data-languages-description', '');
  section.appendChild(description);
  const alertHost = doc.createElement('div');
  alertHost.setAttribute('data-languages-alert', '');
  section.appendChild(alertHost);
  const content = doc.createElement('div');
  content.setAttribute('data-languages-content', '');
  section.appendChild(content);
  const mirrorsHost = doc.createElement('div');
  mirrorsHost.setAttribute('data-languages-mirrors', '');
  section.appendChild(mirrorsHost);
  const status = doc.createElement('div');
  status.setAttribute('data-languages-status', '');
  status.setAttribute('role', 'status');
  section.appendChild(status);

  const settings = doc.createElement('div');
  settings.id = 'rag-phase032-settings';
  settings.className = 'hidden';
  doc.body.appendChild(settings);
  const group = doc.createElement('div');
  group.setAttribute('data-rag-settings-group', 'languages');
  settings.appendChild(group);
  if (options.withMirrors !== false) {
    for (const id of ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE']) {
      const input = doc.createElement('input');
      input.type = 'hidden';
      input.id = id;
      input.setAttribute('name', id);
      input.value = '';
      group.appendChild(input);
    }
  }

  const configManager = { config: { RAG_SUPPORTED_LANGUAGES: '', RAG_PRIMARY_LANGUAGE: '', OTHER: 'kept' } as Json };
  let pendingPost: ((reply: Reply) => void) | null = null;
  let holdPost = false;

  const fetchImpl = async (url: string, init: Json = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, init, body });
    if (url === '/api/config/languages' && (init.method ?? 'GET') === 'GET') {
      const reply = typeof options.get === 'function' ? options.get() : options.get ?? { status: 200, body: languagesAnswer() };
      if (reply.throws) throw new TypeError('Failed to fetch');
      return makeResponse(reply);
    }
    if (url === '/api/config/languages' && init.method === 'POST') {
      if (holdPost) {
        const reply = await new Promise<Reply>((resolve) => {
          pendingPost = resolve;
        });
        if (reply.throws) throw new TypeError('Failed to fetch');
        return makeResponse(reply);
      }
      const reply =
        typeof options.post === 'function'
          ? options.post(body)
          : options.post ?? { status: 200, body: { success: true, languages: (body as Json).languages, primary: (body as Json).primary, warnings: [], verifiedAgainstActiveProfile: true } };
      if (reply.throws) throw new TypeError('Failed to fetch');
      return makeResponse(reply);
    }
    throw new TypeError('unexpected fetch ' + url);
  };

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    ragCalls.push({ url: apiPath, init, body: undefined });
    const reply = options.counts ?? {
      status: 200,
      body: { success: true, counts: [{ language: 'zh', documents: 132 }, { language: 'en', documents: 48 }, { language: 'it', documents: 0 }] },
    };
    if (reply.throws) throw new TypeError('Failed to fetch');
    if (reply.status >= 200 && reply.status < 300) return { ok: true, status: reply.status, body: reply.body };
    return { ok: false, status: reply.status, body: reply.body ?? null, message: 'failed' };
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
    fetch: fetchImpl,
    ragFetch,
    configManager,
    ...(options.globals ?? {}),
  };
  context.window = context;
  vm.createContext(context);
  const scripts = options.scripts ?? ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/languages.js'];
  for (const file of scripts) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }

  return {
    doc,
    context,
    calls,
    ragCalls,
    link,
    mobileLink,
    tabClicks,
    banner,
    section,
    heading,
    alertHost,
    content,
    mirrorsHost,
    status,
    group,
    configManager,
    holdPosts() {
      holdPost = true;
    },
    releasePost(reply: Reply) {
      const resolve = pendingPost;
      pendingPost = null;
      if (resolve) resolve(reply);
    },
    mirror(id: string): FakeElement {
      return doc.getElementById(id) as FakeElement;
    },
  };
}

export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function rowFor(root: FakeElement, code: string): FakeElement {
  const row = root.querySelectorAll('tr').find((tr) => tr.getAttribute('data-language') === code);
  if (!row) throw new Error('no row for ' + code);
  return row;
}

export function useBox(root: FakeElement, code: string): FakeElement {
  return rowFor(root, code).querySelector('input[type="checkbox"]') as FakeElement;
}

export function primaryRadio(root: FakeElement, code: string): FakeElement {
  return rowFor(root, code).querySelector('input[type="radio"]') as FakeElement;
}

export function toggle(box: FakeElement, checked: boolean): void {
  box.checked = checked;
  box.dispatch('change');
}

export function buttonByText(root: FakeElement, text: string): FakeElement {
  const button = root.querySelectorAll('button').find((b) => b.textContent.includes(text));
  if (!button) throw new Error('no button ' + text);
  return button;
}

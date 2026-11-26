import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOC_TYPE_CHOICES, docTypeLabel } from '@/components/ui/doc-type-labels';
import { FakeDocument, FakeElement } from './helpers/html-fake-dom';
import { markedBlock } from './helpers/ingest-impact-harness';

const require = createRequire(import.meta.url);

interface StubCapture {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
}

function loadRagFetch() {
  return require('../../scripts/config-ui/rag-panels/rag-fetch.js') as {
    authMessage: (status: number, appUrl?: string) => string;
    buildRagFetchInit: (apiPath: string, init?: RequestInit) => { url: string; init: RequestInit };
    ragFetch: (apiPath: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; message?: string; body: unknown }>;
  };
}

function loadDocTypes() {
  return require('../../scripts/config-ui/rag-panels/doc-types.js') as {
    CONFIG_UI_DOC_TYPE_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
    buildUploadForm: (file: File, docType: string, pickerEnabled: boolean) => FormData;
    docTypeLabelForLocale: (id: string, locale: 'en' | 'zh' | 'it') => string;
  };
}

function loadQuarantine() {
  return require('../../scripts/config-ui/rag-panels/quarantine.js') as {
    buildQuarantineItemView: (item: Record<string, unknown>) => { filename: string; ruleIds: string; snippets: string[] };
  };
}

function loadEmbeddingProfiles() {
  return require('../../scripts/config-ui/rag-panels/embedding-profiles.js') as {
    formatActivationRefusal: (body: { reason?: string; error?: string }) => string;
    buildProfileRowView: (
      profile: Record<string, unknown>,
      options?: { chosenLanguages?: string[]; locale?: string },
    ) => { id: string; summary: string; evidence: string; languages: string[]; missingLanguages: string[]; servingMode: string | null };
  };
}

describe('RAG panel helpers', () => {
  it('authMessage points to the main app for 401 and 403 and retries on 503', () => {
    const { authMessage } = loadRagFetch();
    const app = 'http://localhost:3000';
    expect(authMessage(401, app)).toContain(app);
    expect(authMessage(401, app)).toMatch(/sign in/i);
    expect(authMessage(403, app)).toContain(app);
    expect(authMessage(503, app)).toMatch(/retry/i);
  });

  it('buildRagFetchInit uses same-origin credentials and does not add Authorization', () => {
    const { buildRagFetchInit } = loadRagFetch();
    const { url, init } = buildRagFetchInit('admin/quarantine', { method: 'GET' });
    expect(url).toBe('/api/rag/admin/quarantine');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('Config UI label table matches doc-type-labels.ts for zh, en and it', () => {
    const { CONFIG_UI_DOC_TYPE_LABELS, docTypeLabelForLocale } = loadDocTypes();
    for (const locale of ['en', 'zh', 'it'] as const) {
      for (const id of DOC_TYPE_CHOICES) {
        expect(docTypeLabelForLocale(id, locale)).toBe(docTypeLabel(id, locale));
        expect(CONFIG_UI_DOC_TYPE_LABELS[locale][id]).toBe(docTypeLabel(id, locale));
      }
    }
  });

  it('buildUploadForm omits doc_type when the picker is disabled', () => {
    const { buildUploadForm } = loadDocTypes();
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const legacy = buildUploadForm(file, 'invoice_receipt', false);
    expect(legacy.has('doc_type')).toBe(false);
    const unified = buildUploadForm(file, 'contract_legal', true);
    expect(unified.get('doc_type')).toBe('contract_legal');
  });

  it('quarantine view model keeps snippets as plain text fields', () => {
    const { buildQuarantineItemView } = loadQuarantine();
    const view = buildQuarantineItemView({
      filename: '<img onerror=alert(1)>',
      rule_ids: ['xss'],
      snippets: ['<script>alert(1)</script>', 'ok'],
    });
    expect(view.filename).toBe('<img onerror=alert(1)>');
    expect(view.snippets[0]).toBe('<script>alert(1)</script>');
    expect(view.ruleIds).toContain('xss');
  });

  it('formatActivationRefusal surfaces activation_refused reasons', () => {
    const { formatActivationRefusal } = loadEmbeddingProfiles();
    expect(formatActivationRefusal({ reason: 'activation_refused: incomplete' })).toBe(
      'activation_refused: incomplete',
    );
    expect(formatActivationRefusal({ error: 'Activation refused', reason: 'activation_refused: unknown_profile' })).toBe(
      'activation_refused: unknown_profile',
    );
  });

  it('embedding profile row view summarizes completeness', () => {
    const { buildProfileRowView } = loadEmbeddingProfiles();
    const row = buildProfileRowView({
      id: 'openai.text-3-small',
      status: 'backfilling',
      dims: 1536,
      has_evidence: true,
      completeness: { state: 'measured', percent: 42 },
    });
    expect(row.id).toBe('openai.text-3-small');
    expect(row.summary).toContain('1536');
    expect(row.evidence).toMatch(/yes/i);
  });
});

describe('config-server /api/rag proxy', () => {
  let root: string;
  let stub: http.Server;
  let stubPort: number;
  let configServer: http.Server;
  let configPort: number;
  let lastStub: StubCapture | null;

  function configCall(method: string, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const uiHeaders =
      method === 'GET' || method === 'HEAD'
        ? {}
        : { 'x-config-ui': '1', Origin: `http://127.0.0.1:${configPort}` };
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: configPort,
          method,
          path: urlPath,
          headers: {
            Host: `127.0.0.1:${configPort}`,
            ...uiHeaders,
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      lastStub = { method: req.method, url: req.url, headers: req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, stub: true }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as AddressInfo).port;

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-proxy-'));
    fs.writeFileSync(
      path.join(root, '.env.local'),
      ['NEXT_PUBLIC_APP_NAME=Demo', `MYRAG_APP_URL=http://127.0.0.1:${stubPort}`, ''].join('\n'),
    );
    process.env.MYRAG_CONFIG_ROOT = root;
    process.env.MYRAG_APP_URL = `http://127.0.0.1:${stubPort}`;
    const modPath = require.resolve('../../scripts/config-server.js');
    delete require.cache[modPath];
    const mod = require('../../scripts/config-server.js') as { server: http.Server };
    configServer = mod.server;
    await new Promise<void>((resolve) => configServer.listen(0, '127.0.0.1', resolve));
    configPort = (configServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => configServer.close(resolve));
    await new Promise((resolve) => stub.close(resolve));
    delete process.env.MYRAG_CONFIG_ROOT;
    delete process.env.MYRAG_APP_URL;
  });

  it('forwards Cookie and Authorization to the stub unchanged', async () => {
  const cookie = 'admin_session=signed-value';
    lastStub = null;
    const a = await configCall('GET', '/api/rag/admin/quarantine', { Cookie: cookie });
    expect(a.status).toBe(200);
    expect(lastStub).not.toBeNull();
    expect(lastStub!.headers.cookie).toBe(cookie);
    expect(JSON.parse(a.body).stub).toBe(true);

    lastStub = null;
    const bearer = 'Bearer ey.test.token';
    const b = await configCall('GET', '/api/rag/admin/embedding-profiles', { Authorization: bearer });
    expect(b.status).toBe(200);
    expect(lastStub).not.toBeNull();
    expect(lastStub!.headers.authorization).toBe(bearer);
  });

  it('does not invent credentials when the browser sends none', async () => {
    lastStub = null;
    const reply = await configCall('GET', '/api/rag/admin/quarantine');
    expect(reply.status).toBe(200);
    expect(lastStub).not.toBeNull();
    expect(lastStub!.headers.cookie).toBeUndefined();
    expect(lastStub!.headers.authorization).toBeUndefined();
  });

  it('refuses encoded dot segments with 400', async () => {
    lastStub = null;
    const reply = await configCall('GET', '/api/rag/%2e%2e/config');
    expect(reply.status).toBe(400);
    expect(lastStub).toBeNull();
  });

  it('refuses double-encoded dot segments that URL resolution would escape /api/rag', async () => {
    lastStub = null;
    const reply = await configCall('GET', '/api/rag/%252e%252e/admin/quarantine');
    expect(reply.status).toBe(400);
    expect(lastStub).toBeNull();
  });
});

describe('config-server static guards', () => {
  it('registers the RAG proxy and keeps withAuthHeaders usage', () => {
    const source = fs.readFileSync('scripts/config-server.js', 'utf8');
    expect(source).toContain("app.all('/api/rag/*path'");
    expect(source.match(/withAuthHeaders/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(source).not.toMatch(/console\.log\([^)]*Cookie/i);
  });

  it('index.html mounts rag panel scripts', () => {
    const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
    expect(html).toContain('rag-panels/rag-fetch.js');
    expect(html).toContain('rag-panels/doc-types.js');
    expect(html).toContain('rag-panels/quarantine.js');
    expect(html).toContain('rag-panels/embedding-profiles.js');
    expect(html).toContain('rag-administration');
  });

  it('rag panel scripts avoid browser token storage patterns', () => {
    const dir = path.join('scripts/config-ui/rag-panels');
    const merged = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(merged).not.toMatch(/sessionStorage|localStorage|anonKey|auth\/v1\/token/);
  });

  it('quarantine panel does not use innerHTML', () => {
    const source = fs.readFileSync('scripts/config-ui/rag-panels/quarantine.js', 'utf8');
    expect(source).not.toContain('innerHTML');
  });
});
const PROFILES_HTML = (() => {
  const html = fs.readFileSync('scripts/config-ui/index.html', 'utf8');
  const start = html.indexOf('<section id="rag-administration-profiles"');
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
})();

type Json = Record<string, unknown>;

function profile(id: string, provider: string, model: string, extra: Json = {}): Json {
  return { id, provider, model, dims: 1024, storage: 'halfvec', status: 'available', has_evidence: false, supportedLanguages: ['zh', 'en', 'it'], ...extra };
}

const LIST_ANSWER = {
  success: true,
  switch: 'on',
  active: 'openai-3-small-1536',
  profiles: [
    profile('openai-3-small-1536', 'openai', 'text-embedding-3-small', { dims: 1536, storage: 'legacy_column', status: 'active' }),
    profile('bge-m3-1024', 'bge-m3', 'BAAI/bge-m3', { servingMode: 'sidecar' }),
    profile('voyage-finance-2-1024', 'voyage', 'voyage-finance-2', { supportedLanguages: ['en'] }),
  ],
};

function loadProfilesPage(options: { locale?: string; supported?: string; reply?: { status: number; body?: unknown } } = {}) {
  const doc = new FakeDocument();
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  doc.body.appendChild(tab);
  const settings = doc.createElement('div');
  tab.appendChild(settings);
  settings.innerHTML = markedBlock('rag-phase032-settings');
  (doc.getElementById('RAG_SUPPORTED_LANGUAGES') as FakeElement).value = options.supported ?? 'zh,en,it';
  (doc.getElementById('RAG_BGE_M3_SERVING') as FakeElement).value = 'hosted';
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = PROFILES_HTML;
  doc.innerHtmlWrites = 0;
  const calls: string[] = [];
  const reply = options.reply ?? { status: 200, body: LIST_ANSWER };
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    location: { origin: 'http://config.local', search: '', hash: '' },
    setTimeout,
    clearTimeout,
    URLSearchParams,
    ragFetch: async (apiPath: string) => {
      calls.push(apiPath);
      const ok = reply.status >= 200 && reply.status < 300;
      return { ok, status: reply.status, message: ok ? undefined : 'Sign in to the main app first.', body: JSON.parse(JSON.stringify(reply.body ?? null)) };
    },
    authMessage: () => 'Sign in to the main app first.',
  };
  context.window = context;
  vm.createContext(context);
  const file = 'scripts/config-ui/rag-panels/embedding-profiles.js';
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(context);
  const root = doc.getElementById('rag-administration-profiles') as FakeElement;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    doc,
    root,
    calls,
    async init() {
      (context.initEmbeddingProfilesPanel as () => void)();
      await flush();
    },
    card: (id: string) => {
      const found = root.querySelectorAll('article').find((el) => el.querySelector('h4')?.textContent.startsWith(id));
      if (!found) throw new Error('no card for ' + id);
      return found;
    },
  };
}

const lines = (card: FakeElement) => card.querySelectorAll('p').map((el) => el.textContent);

describe('Embedding profiles panel: declared languages and BGE-M3 serving', () => {
  it('row view carries declared languages, the chosen languages it misses and the serving mode, with the summary unchanged', () => {
    const { buildProfileRowView } = loadEmbeddingProfiles();
    const bge = buildProfileRowView(profile('bge-m3-1024', 'bge-m3', 'BAAI/bge-m3', { servingMode: 'hosted' }), { chosenLanguages: ['zh', 'en', 'it'] });
    expect(bge.summary).toBe('available · 1024 dims · not measured');
    expect(bge.languages).toEqual(['zh', 'en', 'it']);
    expect(bge.missingLanguages).toEqual([]);
    expect(bge.servingMode).toBe('hosted');
    const narrow = buildProfileRowView(profile('voyage-finance-2-1024', 'voyage', 'voyage-finance-2', { supportedLanguages: ['en'] }), {
      chosenLanguages: ['zh', 'en', 'it'],
    });
    expect(narrow.missingLanguages).toEqual(['zh', 'it']);
    expect(narrow.servingMode).toBeNull();
    expect(buildProfileRowView(profile('x', 'openai', 'm', { supportedLanguages: ['en'] }), { chosenLanguages: [] }).missingLanguages).toEqual([]);
    expect(buildProfileRowView(profile('x', 'openai', 'm', { supportedLanguages: undefined }), {}).languages).toEqual([]);
  });

  it('every card shows the declared languages by native name and code; only the BGE-M3 card shows the serving mode', async () => {
    const page = loadProfilesPage();
    await page.init();
    expect(page.calls).toEqual(['admin/embedding-profiles?completeness=true']);
    const bge = page.card('bge-m3-1024');
    expect(lines(bge)).toContain('Languages: 中文 (zh), English (en), Italiano (it)');
    expect(lines(bge)).toContain('Served by: the sidecar, in-house');
    const zhName = bge.querySelectorAll('span').find((el) => el.textContent === '中文');
    expect(zhName?.getAttribute('lang')).toBe('zh');
    for (const id of ['openai-3-small-1536', 'voyage-finance-2-1024']) {
      expect(lines(page.card(id)).some((text) => text.startsWith('Served by'))).toBe(false);
    }
    expect(lines(page.card('openai-3-small-1536'))).toContain('available · 1024 dims · not measured'.replace('available', 'active').replace('1024', '1536'));
    expect(page.doc.innerHtmlWrites).toBe(0);
  });

  it('a profile missing a chosen language shows a warning line per language, with icon and word', async () => {
    const page = loadProfilesPage();
    await page.init();
    const warnings = page.card('voyage-finance-2-1024').querySelectorAll('p').filter((el) => el.className.includes('text-warning'));
    expect(warnings.map((el) => el.textContent)).toEqual([
      'Warning: Does not declare 中文, which this deployment supports.',
      'Warning: Does not declare Italiano, which this deployment supports.',
    ]);
    for (const line of warnings) {
      const icon = line.querySelector('i');
      expect(icon?.className).toContain('bi-exclamation-triangle');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(page.card('bge-m3-1024').querySelectorAll('p').some((el) => el.className.includes('text-warning'))).toBe(false);
  });

  it('shows no warning before languages are chosen', async () => {
    const page = loadProfilesPage({ supported: '' });
    await page.init();
    expect(page.root.querySelectorAll('p').some((el) => el.className.includes('text-warning'))).toBe(false);
  });

  it('renders zh and it strings, and server strings only as text', async () => {
    const zh = loadProfilesPage({ locale: 'zh-CN' });
    await zh.init();
    expect(lines(zh.card('bge-m3-1024'))).toContain('语言：中文 (zh)、English (en)、Italiano (it)');
    expect(lines(zh.card('bge-m3-1024'))).toContain('服务方式：侧车服务（本地）');
    const it_ = loadProfilesPage({ locale: 'it-IT' });
    await it_.init();
    expect(lines(it_.card('bge-m3-1024'))).toContain('Servito da: il sidecar, in sede');

    const hostile = '<img src=x onerror=alert(1)>';
    const xss = loadProfilesPage({
      reply: { status: 200, body: { ...LIST_ANSWER, profiles: [profile(hostile, 'voyage', 'voyage-finance-2', { supportedLanguages: [hostile] })] } },
    });
    await xss.init();
    expect(xss.root.querySelectorAll('img')).toEqual([]);
    expect(xss.root.textContent).toContain(hostile);
    expect(xss.doc.innerHtmlWrites).toBe(0);
  });

  it('moves the bge settings group under the list, keeps the select id, label and option values, and explains both modes', async () => {
    const page = loadProfilesPage();
    await page.init();
    const group = page.doc.querySelector('[data-rag-settings-group="bge"]')!;
    expect(page.root.querySelectorAll('[data-rag-settings-group="bge"]')).toHaveLength(1);
    const list = page.root.querySelector('[data-rag-profiles-list]')!;
    const host = group.parentElement!;
    expect(host.parentElement).toBe(list.parentElement);
    expect(host.parentElement!.children.indexOf(host)).toBeGreaterThan(host.parentElement!.children.indexOf(list));
    expect(host.querySelector('h4')?.textContent).toBe('BGE-M3 serving');
    const select = page.doc.getElementById('RAG_BGE_M3_SERVING')!;
    expect(group.querySelector('label')?.getAttribute('for')).toBe('RAG_BGE_M3_SERVING');
    expect(select.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent])).toEqual([
      ['hosted', 'Hosted API'],
      ['sidecar', 'Sidecar, in-house'],
    ]);
    const help = page.doc.getElementById('rag-bge-m3-serving-help')!.textContent;
    expect(help).toMatch(/Hosted API: .*sent to the hosted API.*existing .*key\./);
    expect(help).toMatch(/Sidecar: .*stays on your servers.*never falls back to the hosted API\./);
    expect(help).toMatch(/no re-embedding/);
    expect(page.doc.innerHtmlWrites).toBe(0);
  });

  it('localizes the serving control in zh and it, keeping BGE-M3 untranslated', async () => {
    const zh = loadProfilesPage({ locale: 'zh-CN' });
    await zh.init();
    const zhSelect = zh.doc.getElementById('RAG_BGE_M3_SERVING')!;
    expect(zhSelect.querySelectorAll('option').map((o) => o.textContent)).toEqual(['托管 API', '侧车服务（本地）']);
    expect(zh.doc.getElementById('rag-bge-m3-serving-help')!.textContent).toMatch(/不会回退到托管 API/);
    const label = zh.doc.querySelector('label[for="RAG_BGE_M3_SERVING"]')!;
    expect(label.textContent.trim()).toBe('BGE-M3 服务方式');
    expect(label.querySelector('[translate="no"]')?.textContent).toBe('BGE-M3');
    const it_ = loadProfilesPage({ locale: 'it-IT' });
    await it_.init();
    expect(it_.doc.querySelector('label[for="RAG_BGE_M3_SERVING"]')!.textContent.trim()).toBe('Servizio di BGE-M3');
  });

  it('keeps the serving control usable when the list answers 401', async () => {
    const page = loadProfilesPage({ reply: { status: 401, body: { success: false } } });
    await page.init();
    expect(page.root.querySelector('[data-rag-profiles-status]')!.textContent).toMatch(/sign in/i);
    const select = page.doc.getElementById('RAG_BGE_M3_SERVING')!;
    expect(page.root.querySelectorAll('#RAG_BGE_M3_SERVING')).toHaveLength(1);
    expect(select.hasAttribute('disabled')).toBe(false);
  });

  it('init is idempotent: a second call reloads instead of mounting again', async () => {
    const page = loadProfilesPage();
    await page.init();
    await page.init();
    expect(page.calls).toHaveLength(2);
    expect(page.root.querySelectorAll('[data-rag-settings-group="bge"]')).toHaveLength(1);
    expect(page.root.querySelectorAll('h4').filter((el) => el.textContent === 'BGE-M3 serving')).toHaveLength(1);
    page.calls.length = 0;
    page.root.querySelector('[data-rag-profiles-refresh]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.calls).toHaveLength(1);
  });

  it('the BGE-M3 card has only the existing Activate action', async () => {
    const page = loadProfilesPage();
    await page.init();
    expect(page.card('bge-m3-1024').querySelectorAll('button').map((b) => b.textContent)).toEqual(['Activate']);
    expect(page.card('openai-3-small-1536').querySelectorAll('button')).toEqual([]);
  });
});

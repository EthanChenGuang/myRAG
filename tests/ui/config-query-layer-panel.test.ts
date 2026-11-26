import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ENDPOINT = '/api/config/query-layer/status';

let root: string;
let server: http.Server;
let port: number;

function call(method: string, url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { Host: host ?? `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECRETS = ['placeholder-langsmith-key', 'placeholder-openrouter-key', 'redis://placeholder-host:6379'];

function writeEnv(lines: string[]) {
  fs.writeFileSync(
    path.join(root, '.env.local'),
    [...lines, 'OPENROUTER_API_KEY=placeholder-openrouter-key', 'REDIS_URL=redis://placeholder-host:6379', ''].join('\n'),
  );
}

const calibrationPath = () => path.join(root, 'eval/config/semantic-cache.json');
const langchainDir = () => path.join(root, 'node_modules/@langchain/classic');

function installFakeLangchain() {
  fs.mkdirSync(langchainDir(), { recursive: true });
  fs.writeFileSync(path.join(langchainDir(), 'package.json'), JSON.stringify({ name: '@langchain/classic', version: '0.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(langchainDir(), 'index.js'), 'module.exports = {};\n');
}

async function status() {
  const reply = await call('GET', ENDPOINT);
  expect(reply.status).toBe(200);
  for (const secret of SECRETS) expect(reply.body).not.toContain(secret);
  return JSON.parse(reply.body) as {
    framework: string;
    backend: string;
    pipeline: string;
    langchain_installed: boolean;
    calibration: { calibrated: boolean; state: string; profiles: Array<Record<string, unknown>> };
    warnings: string[];
  };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-query-layer-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  writeEnv([]);
  process.env.MYRAG_CONFIG_ROOT = root;
  const mod = require('../../scripts/config-server.js') as { server: http.Server };
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
});

beforeEach(() => {
  fs.rmSync(path.join(root, 'eval'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  writeEnv([]);
});

describe('GET /api/config/query-layer/status', () => {
  it('status: defaults report llamaindex, the cache off, calibrated false and no warnings', async () => {
    const body = await status();
    expect(body).toMatchObject({ framework: 'llamaindex', backend: 'off', pipeline: 'legacy', langchain_installed: false, warnings: [] });
    expect(body.calibration).toEqual({ calibrated: false, state: 'missing', profiles: [] });
  });

  it('status: the cache on under the legacy pipeline warns cache_under_legacy, and v2 does not', async () => {
    writeEnv(['RAG_SEMANTIC_CACHE=pgvector']);
    expect((await status()).warnings).toEqual(['cache_under_legacy']);
    writeEnv(['RAG_SEMANTIC_CACHE=redisvl', 'RAG_PIPELINE=legacy']);
    expect((await status()).warnings).toEqual(['cache_under_legacy']);
    writeEnv(['RAG_SEMANTIC_CACHE=pgvector', 'RAG_PIPELINE=v2']);
    expect((await status()).warnings).toEqual([]);
  });

  it('status: LangChain selected without its package warns langchain_missing; installed it does not', async () => {
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain']);
    const missing = await status();
    expect(missing.langchain_installed).toBe(false);
    expect(missing.warnings).toEqual(['langchain_missing']);
    installFakeLangchain();
    const installed = await status();
    expect(installed.langchain_installed).toBe(true);
    expect(installed.warnings).toEqual([]);
  });

  it('status: LANGSMITH_* or LANGCHAIN_TRACING* with LangChain selected warns langsmith_tracing_set, without the value', async () => {
    installFakeLangchain();
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'LANGSMITH_API_KEY=placeholder-langsmith-key']);
    expect((await status()).warnings).toEqual(['langsmith_tracing_set']);
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'LANGCHAIN_TRACING_V2=true']);
    expect((await status()).warnings).toEqual(['langsmith_tracing_set']);
    writeEnv(['RAG_QUERY_FRAMEWORK=llamaindex', 'LANGSMITH_API_KEY=placeholder-langsmith-key']);
    expect((await status()).warnings).toEqual([]);
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'LANGSMITH_API_KEY=']);
    expect((await status()).warnings).toEqual([]);
  });

  it('status: reads the calibrated distance per embedding profile from eval/config/semantic-cache.json on each call', async () => {
    fs.mkdirSync(path.dirname(calibrationPath()), { recursive: true });
    fs.writeFileSync(
      calibrationPath(),
      JSON.stringify({
        schema_version: 1,
        profiles: [
          { embedding_profile_id: 'legacy', max_distance: 0.06, source: 'calibrated', fitted_at: '2026-11-20T00:00:00Z', dev: null, test: null },
          { embedding_profile_id: 'profile-b', max_distance: 0.05, source: 'default', fitted_at: null, dev: null, test: null },
        ],
      }),
    );
    const body = await status();
    expect(body.calibration).toEqual({
      calibrated: true,
      state: 'ok',
      profiles: [
        { embedding_profile_id: 'legacy', max_distance: 0.06, source: 'calibrated', fitted_at: '2026-11-20T00:00:00Z' },
        { embedding_profile_id: 'profile-b', max_distance: 0.05, source: 'default', fitted_at: null },
      ],
    });
    fs.writeFileSync(calibrationPath(), '{not json');
    expect((await status()).calibration).toEqual({ calibrated: false, state: 'invalid', profiles: [] });
    fs.writeFileSync(calibrationPath(), JSON.stringify({ schema_version: 1, profiles: [{ embedding_profile_id: '<b>', max_distance: 0.9, source: 'calibrated' }] }));
    expect((await status()).calibration).toEqual({ calibrated: false, state: 'invalid', profiles: [] });
  });

  it('status: all three warnings together, in a fixed order', async () => {
    writeEnv(['RAG_QUERY_FRAMEWORK=langchain', 'RAG_SEMANTIC_CACHE=pgvector', 'LANGCHAIN_TRACING=true']);
    expect((await status()).warnings).toEqual(['cache_under_legacy', 'langchain_missing', 'langsmith_tracing_set']);
  });

  it('status: refuses a foreign Host like every config endpoint', async () => {
    const reply = await call('GET', ENDPOINT, 'evil.example');
    expect(reply.status).toBeGreaterThanOrEqual(400);
  });
});

class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public textContent: string) {}
}

type FakeNode = FakeElement | FakeText;

class FakeElement {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
  hidden = false;
  constructor(public tagName: string) {}
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', String(value));
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value !== '') this.appendChild(new FakeText(String(value)));
  }
  set innerHTML(_value: string) {
    throw new Error('innerHTML is not allowed in Config UI panels');
  }
  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes: Array<FakeNode | string>) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }
  replaceChildren(...nodes: Array<FakeNode | string>) {
    this.childNodes = [];
    this.append(...nodes);
  }
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

const fakeDoc = {
  createElement: (tag: string) => new FakeElement(tag.toLowerCase()),
  createTextNode: (text: string) => new FakeText(String(text)),
};

interface QueryLayerPanel {
  QUERY_LAYER_STATUS_ENDPOINT: string;
  SEMANTIC_CACHE_CLEAR_PATH: string;
  QUERY_LAYER_WARNING_TEXT: Record<string, string>;
  renderQueryLayerStatus: (container: FakeElement, status: unknown, doc: typeof fakeDoc) => void;
  loadQueryLayerStatus: (container: FakeElement, options: { fetcher: typeof fetch; doc: typeof fakeDoc }) => Promise<unknown>;
  renderFrameworkWarning: (el: FakeElement, framework: string, status: unknown, doc: typeof fakeDoc) => void;
  clearTenantCache: (
    tenantKey: string,
    options: { ragFetch: (path: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; message?: string; body: unknown }> },
  ) => Promise<{ ok: boolean; message: string }>;
}

function loadPanel(): QueryLayerPanel {
  return require('../../scripts/config-ui/rag-panels/query-layer.js') as QueryLayerPanel;
}

const STATUS = {
  framework: 'langchain',
  backend: 'pgvector',
  pipeline: 'legacy',
  langchain_installed: false,
  calibration: {
    calibrated: true,
    state: 'ok',
    profiles: [
      { embedding_profile_id: 'legacy', max_distance: 0.06, source: 'calibrated', fitted_at: '2026-11-20T00:00:00Z' },
      { embedding_profile_id: 'profile-b', max_distance: 0.05, source: 'default', fitted_at: null },
    ],
  },
  warnings: ['cache_under_legacy', 'langchain_missing', 'langsmith_tracing_set'],
};

describe('Query layer panel module (D-44)', () => {
  it('renders the calibrated distance per profile read-only and each warning as a visible alert', () => {
    const { renderQueryLayerStatus, QUERY_LAYER_WARNING_TEXT } = loadPanel();
    const container = new FakeElement('div');
    renderQueryLayerStatus(container, STATUS, fakeDoc);
    const text = container.textContent;
    expect(text).toContain('legacy');
    expect(text).toContain('0.06');
    expect(text).toContain('profile-b');
    expect(text).toContain('0.05');
    const alerts = container.all().filter((el) => el.getAttribute('role') === 'alert');
    expect(alerts).toHaveLength(3);
    for (const code of STATUS.warnings) expect(text).toContain(QUERY_LAYER_WARNING_TEXT[code]);
    expect(container.all().some((el) => el.tagName === 'input' || el.tagName === 'button')).toBe(false);
  });

  it('shows the not-calibrated state and inserts hostile ids as text only', () => {
    const { renderQueryLayerStatus } = loadPanel();
    const container = new FakeElement('div');
    renderQueryLayerStatus(container, { ...STATUS, warnings: [], calibration: { calibrated: false, state: 'missing', profiles: [] } }, fakeDoc);
    expect(container.textContent).toMatch(/not calibrated/i);
    expect(container.all().filter((el) => el.getAttribute('role') === 'alert')).toHaveLength(0);
    const hostile = { ...STATUS, calibration: { ...STATUS.calibration, profiles: [{ ...STATUS.calibration.profiles[0], embedding_profile_id: '<img src=x>' }] } };
    renderQueryLayerStatus(container, hostile, fakeDoc);
    expect(container.textContent).toContain('<img src=x>');
    expect(container.all().some((el) => el.tagName === 'img')).toBe(false);
  });

  it('loads the status from the config server and renders an error line on failure', async () => {
    const { loadQueryLayerStatus, QUERY_LAYER_STATUS_ENDPOINT } = loadPanel();
    expect(QUERY_LAYER_STATUS_ENDPOINT).toBe(ENDPOINT);
    const calls: string[] = [];
    const ok = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => STATUS } as Response;
    }) as unknown as typeof fetch;
    const container = new FakeElement('div');
    expect(await loadQueryLayerStatus(container, { fetcher: ok, doc: fakeDoc })).toEqual(STATUS);
    expect(calls).toEqual([ENDPOINT]);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await loadQueryLayerStatus(container, { fetcher: down, doc: fakeDoc })).toBeNull();
    expect(container.textContent).toMatch(/unavailable/i);
  });

  it('selecting langchain while the package is missing shows the install warning next to the select', () => {
    const { renderFrameworkWarning } = loadPanel();
    const el = new FakeElement('p');
    renderFrameworkWarning(el, 'langchain', STATUS, fakeDoc);
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('@langchain/classic');
    renderFrameworkWarning(el, 'llamaindex', STATUS, fakeDoc);
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
    renderFrameworkWarning(el, 'langchain', { ...STATUS, langchain_installed: true }, fakeDoc);
    expect(el.hidden).toBe(true);
  });

  it('"Clear cache for tenant" posts { tenantKey } through ragFetch and shows the deleted count', async () => {
    const { clearTenantCache, SEMANTIC_CACHE_CLEAR_PATH } = loadPanel();
    expect(SEMANTIC_CACHE_CLEAR_PATH).toBe('/api/rag/admin/semantic-cache');
    const calls: Array<[string, RequestInit | undefined]> = [];
    const result = await clearTenantCache(' s:default ', {
      ragFetch: async (p, init) => {
        calls.push([p, init]);
        return { ok: true, status: 200, body: { success: true, deleted: 4, backend: 'pgvector' } };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/rag/admin/semantic-cache');
    expect(calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ tenantKey: 's:default' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('4');
  });

  it('a 403 shows the error text, and an empty key sends nothing', async () => {
    const { clearTenantCache } = loadPanel();
    const denied = await clearTenantCache('s:default', {
      ragFetch: async () => ({ ok: false, status: 403, message: 'Admin sign-in required.', body: { success: false, error: 'Admin access required' } }),
    });
    expect(denied).toEqual({ ok: false, message: 'Admin sign-in required.' });
    let sent = 0;
    const empty = await clearTenantCache('  ', {
      ragFetch: async () => {
        sent += 1;
        return { ok: true, status: 200, body: {} };
      },
    });
    expect(empty.ok).toBe(false);
    expect(sent).toBe(0);
  });

  it('index.html loads the module after rag-fetch.js and gives it its mount points in the Query layer card', () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, '../../scripts/config-ui/index.html'), 'utf8');
    const fetchAt = html.indexOf('<script src="rag-panels/rag-fetch.js"></script>');
    const moduleAt = html.indexOf('<script src="rag-panels/query-layer.js"></script>');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(fetchAt);
    const start = html.indexOf('<!-- Query layer -->');
    const card = html.slice(start, html.indexOf('<!-- Ingestion and embedding profiles -->', start));
    for (const id of ['query-layer-status', 'query-layer-framework-warning', 'query-layer-clear-tenant', 'query-layer-clear-button', 'query-layer-clear-result']) {
      expect(card).toContain(`id="${id}"`);
    }
    const tenantInput = /<input[^>]*id="query-layer-clear-tenant"[^>]*>/.exec(card)![0];
    expect(tenantInput).not.toMatch(/\bname=/);
    expect(card.replace(/<[^>]+>/g, '')).toContain('voice always uses the native condense');
  });
});

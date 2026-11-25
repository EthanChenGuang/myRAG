import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const ENDPOINT = '/api/config/injection-defense';

let root: string;
let server: http.Server;
let port: number;

interface Reply {
  status: number;
  body: string;
}

function call(method: string, url: string, options: { host?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${port}`, ...(options.headers ?? {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const rulesPath = () => path.join(root, 'config/rag/injection-rules.json');
const detectorsPath = () => path.join(root, 'config/rag/injection-detectors.json');

function copyRealConfig() {
  fs.mkdirSync(path.join(root, 'config/rag'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'config/rag/injection-rules.json'), rulesPath());
  fs.copyFileSync(path.join(repoRoot, 'config/rag/injection-detectors.json'), detectorsPath());
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-injection-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.env.local'),
    ['LAKERA_GUARD_API_KEY=placeholder-lakera-key', 'RAG_INJECTION_CHECK=drop', 'RAG_SIDECAR_SECRET=placeholder-sidecar-secret', ''].join('\n'),
  );
  copyRealConfig();
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

beforeEach(() => copyRealConfig());

describe('GET /api/config/injection-defense (D-18)', () => {
  it('returns the rule version, counts per language and the detector summary', async () => {
    const reply = await call('GET', ENDPOINT);
    expect(reply.status).toBe(200);
    const bytes = fs.readFileSync(path.join(repoRoot, 'config/rag/injection-rules.json'));
    const rules = JSON.parse(bytes.toString('utf8')) as { rules: Array<{ language: string }> };
    const detectors = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/rag/injection-detectors.json'), 'utf8'));
    const count = (lang: string) => rules.rules.filter((r) => r.language === lang).length;
    expect(JSON.parse(reply.body)).toEqual({
      rules: {
        version: createHash('sha256').update(bytes).digest('hex').slice(0, 12),
        counts: { zh: count('zh'), en: count('en'), it: count('it'), any: count('any') },
      },
      detectors: {
        version: detectors.version,
        prompt_guard: {
          model_id: detectors.prompt_guard.model_id,
          revision: detectors.prompt_guard.revision,
          threshold: detectors.prompt_guard.threshold,
          languages: detectors.prompt_guard.languages,
        },
        lakera: { detector_types: detectors.lakera.detector_types, min_level: detectors.lakera.min_level },
      },
    });
  });

  it('the rule version equals injectionRulesVersion() for the same file', async () => {
    const { injectionRulesVersion } = await import('@/lib/rag/security/injection-rules');
    const reply = await call('GET', ENDPOINT);
    expect(JSON.parse(reply.body).rules.version).toBe(injectionRulesVersion(path.join(repoRoot, 'config/rag/injection-rules.json')));
  });

  it('returns no rule pattern, rule id or env value', async () => {
    const reply = await call('GET', ENDPOINT);
    const rules = JSON.parse(fs.readFileSync(rulesPath(), 'utf8')) as { rules: Array<{ id: string; pattern: string }> };
    for (const rule of rules.rules) {
      expect(reply.body).not.toContain(rule.pattern);
      expect(reply.body).not.toContain(rule.id);
    }
    for (const value of ['placeholder-lakera-key', 'placeholder-sidecar-secret', 'pattern', '"drop"']) expect(reply.body).not.toContain(value);
  });

  it('reads the files on each request (no caching)', async () => {
    const first = JSON.parse((await call('GET', ENDPOINT)).body);
    const detectors = JSON.parse(fs.readFileSync(detectorsPath(), 'utf8'));
    detectors.version = '2030-01-01.7';
    fs.writeFileSync(detectorsPath(), JSON.stringify(detectors));
    fs.appendFileSync(rulesPath(), '\n');
    const second = JSON.parse((await call('GET', ENDPOINT)).body);
    expect(second.detectors.version).toBe('2030-01-01.7');
    expect(second.rules.version).not.toBe(first.rules.version);
  });

  it('refuses a foreign Host exactly like GET /api/config', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:9999']) {
      const reply = await call('GET', ENDPOINT, { host });
      const reference = await call('GET', '/api/config', { host });
      expect(reply.status).toBe(403);
      expect(reply.body).toBe(reference.body);
      expect(reply.body).not.toContain('prompt_guard');
    }
  });

  it('refuses a cross-site POST exactly like the other config endpoints', async () => {
    const reply = await call('POST', ENDPOINT, { headers: { Origin: 'http://evil.example' } });
    const reference = await call('POST', '/api/config', { headers: { Origin: 'http://evil.example' } });
    expect(reply.status).toBe(403);
    expect(reply.body).toBe(reference.body);
  });

  it.each([
    ['missing detector file', () => fs.rmSync(detectorsPath()), 'injection_detectors_missing'],
    ['detector file that is not JSON', () => fs.writeFileSync(detectorsPath(), '{not json'), 'injection_detectors_invalid'],
    [
      'detector file with a bad revision',
      () => {
        const d = JSON.parse(fs.readFileSync(detectorsPath(), 'utf8'));
        d.prompt_guard.revision = '<script>';
        fs.writeFileSync(detectorsPath(), JSON.stringify(d));
      },
      'injection_detectors_invalid',
    ],
    [
      'detector file without lakera',
      () => {
        const d = JSON.parse(fs.readFileSync(detectorsPath(), 'utf8'));
        delete d.lakera;
        fs.writeFileSync(detectorsPath(), JSON.stringify(d));
      },
      'injection_detectors_invalid',
    ],
    ['missing rule file', () => fs.rmSync(rulesPath()), 'injection_rules_missing'],
    ['rule file without rules', () => fs.writeFileSync(rulesPath(), '{"schema_version":1}'), 'injection_rules_invalid'],
  ])('a %s answers 500 with a code and no stack', async (_name, mutate, code) => {
    mutate();
    const reply = await call('GET', ENDPOINT);
    expect(reply.status).toBe(500);
    const body = JSON.parse(reply.body);
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe('string');
    expect(reply.body).not.toMatch(/at .*\.js:\d+|ENOENT|Unexpected token|SyntaxError/);
    expect(reply.body).not.toContain(root);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// A minimal DOM: innerHTML and insertAdjacentHTML throw, so a panel that parses markup fails the test.

class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

type FakeNode = FakeElement | FakeText;

class FakeElement {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  attributes = new Map<string, string>();
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
  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML is not allowed in Config UI panels');
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

interface PanelModule {
  INJECTION_DEFENSE_ENDPOINT: string;
  PROMPT_GUARD_LANGUAGE_NOTE: string;
  renderInjectionDefenseSummary: (container: FakeElement, summary: unknown, doc: typeof fakeDoc) => void;
  loadInjectionDefenseSummary: (container: FakeElement, options: { fetcher: typeof fetch; doc: typeof fakeDoc }) => Promise<void>;
}

function loadPanel(): PanelModule {
  return require('../../scripts/config-ui/rag-panels/injection-defense.js') as PanelModule;
}

const SUMMARY = {
  rules: { version: 'abcdef012345', counts: { zh: 7, en: 8, it: 6, any: 1 } },
  detectors: {
    version: '2026-11-24.1',
    prompt_guard: { model_id: 'meta-llama/Llama-Prompt-Guard-2-86M', revision: 'a'.repeat(40), threshold: 0.5, languages: ['en', 'it'] },
    lakera: { detector_types: ['prompt_attack'], min_level: null },
  },
};

function jsonFetch(status: number, body: unknown): { fetcher: typeof fetch; calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe('Prompt-injection defense card: detector summary (D-18, A-12)', () => {
  it('renders the versions, counts, Prompt Guard model, revision, threshold, the language note and Lakera types', () => {
    const { renderInjectionDefenseSummary, PROMPT_GUARD_LANGUAGE_NOTE } = loadPanel();
    expect(PROMPT_GUARD_LANGUAGE_NOTE).toBe('Prompt Guard: en and it only; on CPU it runs inline only in eval runs and fills a warm cache for chat');
    const container = new FakeElement('div');
    renderInjectionDefenseSummary(container, SUMMARY, fakeDoc);
    const text = container.textContent;
    for (const value of ['abcdef012345', 'zh 7', 'en 8', 'it 6', '2026-11-24.1', 'meta-llama/Llama-Prompt-Guard-2-86M', 'a'.repeat(40), '0.5', 'prompt_attack', PROMPT_GUARD_LANGUAGE_NOTE]) {
      expect(text).toContain(value);
    }
    expect(text).not.toContain('null');
  });

  it('inserts values as text, never as markup', () => {
    const { renderInjectionDefenseSummary } = loadPanel();
    const hostile = structuredClone(SUMMARY);
    hostile.detectors.prompt_guard.model_id = '<img src=x onerror=alert(1)>';
    hostile.detectors.lakera.detector_types = ['<b>bold</b>'];
    const container = new FakeElement('div');
    renderInjectionDefenseSummary(container, hostile, fakeDoc);
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('<b>bold</b>');
    expect(container.all().map((e) => e.tagName)).not.toContain('img');
    expect(container.all().map((e) => e.tagName)).not.toContain('b');
  });

  it('fetches the config server endpoint same-origin and renders it', async () => {
    const { loadInjectionDefenseSummary, INJECTION_DEFENSE_ENDPOINT } = loadPanel();
    expect(INJECTION_DEFENSE_ENDPOINT).toBe(ENDPOINT);
    const { fetcher, calls } = jsonFetch(200, SUMMARY);
    const container = new FakeElement('div');
    await loadInjectionDefenseSummary(container, { fetcher, doc: fakeDoc });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(ENDPOINT);
    expect(calls[0][1]?.credentials).toBe('same-origin');
    expect(container.textContent).toContain('abcdef012345');
  });

  it.each([
    ['a 500 with a code', () => jsonFetch(500, { error: 'Detector configuration is invalid', code: 'injection_detectors_invalid' }).fetcher],
    ['a 403', () => jsonFetch(403, { error: 'Forbidden host' }).fetcher],
    ['a malformed body', () => jsonFetch(200, { rules: 'x' }).fetcher],
    [
      'a network error',
      () =>
        (async () => {
          throw new Error('offline');
        }) as unknown as typeof fetch,
    ],
  ])('on %s shows exactly one error line', async (_name, makeFetcher) => {
    const { loadInjectionDefenseSummary } = loadPanel();
    const container = new FakeElement('div');
    await expect(loadInjectionDefenseSummary(container, { fetcher: makeFetcher(), doc: fakeDoc })).resolves.toBeUndefined();
    expect(container.children).toHaveLength(1);
    expect(container.children[0].getAttribute('role')).toBe('status');
    expect(container.textContent).toMatch(/^Detector summary unavailable/);
    expect(container.textContent).not.toContain('abcdef012345');
  });
});

describe('Config UI wiring', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/index.html'), 'utf8');
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/config-ui/rag-panels/injection-defense.js'), 'utf8');

  it('index.html includes the panel script and its container inside the Prompt-injection defense card', () => {
    expect(html).toContain('<script src="rag-panels/injection-defense.js"></script>');
    const card = html.slice(html.indexOf('<!-- Prompt-injection defense -->'), html.indexOf('<!-- Info Box -->'));
    expect(card).toContain('id="injection-defense-summary"');
    expect(card).toContain('id="RAG_INJECTION_CHECK"');
    expect(card).toContain('Sends chunk text to Lakera, a third party');
    expect(card).toMatch(/id="LAKERA_GUARD_API_KEY"[^>]*type="password"|type="password"[^>]*id="LAKERA_GUARD_API_KEY"/);
  });

  it('the panel script never parses markup', () => {
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

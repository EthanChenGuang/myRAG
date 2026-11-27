import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, injectedElements } from './helpers/html-fake-dom';
import { markedBlock } from './helpers/ingest-impact-harness';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const panelFile = path.join(configUiDir, 'rag-panels/identifier-patterns.js');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');

type Json = Record<string, unknown>;
type Locale = 'en' | 'zh' | 'it';

interface Mapped {
  key: string;
  kind: string;
  field?: string;
  code?: string;
  reload?: boolean;
  closeForm?: boolean;
  vars?: Json;
  findings?: Array<{ key: string; field: string; code?: string }>;
}

interface Module {
  IDENTIFIER_PATTERNS_LABELS: Record<Locale, Record<string, string>>;
  IDENTIFIER_PATTERNS_COMMANDS: { identifiers: string; relex: string };
  identifierPatternsLabel: (key: string, locale: string, vars?: Json) => string;
  identifierPatternsListView: (body: unknown) => {
    items: Array<{ id: string; name: string; pattern: string; flags: string; flagKey: string; enabled: boolean; updatedAt: string | null }>;
    limits: { max_patterns: number; max_pattern_length: number; max_name_length: number; max_sample_length: number };
  };
  identifierPatternsLocalFindings: (
    draft: { name: string; pattern: string; ignoreCase: boolean },
    limits?: Json,
  ) => Array<{ field: string; key: string; vars?: Json; detail?: string }>;
  identifierPatternsSegments: (sample: string, matches: Json[]) => Array<{ text: string; mark: boolean }> | null;
  identifierPatternsLedger: (
    matches: Json[],
    items: Array<{ id: string; name: string }>,
  ) => Array<{ stored: string; spellings: string[]; sources: Array<{ kind: string; name?: string }> }>;
  mapIdentifierPatternsError: (result: Json, call: string) => Mapped;
}

function loadModule(): Module {
  return require(panelFile) as Module;
}

const ID1 = 'c0000000-0000-4000-8000-000000000001';
const ID2 = 'c0000000-0000-4000-8000-000000000002';
const ID3 = 'c0000000-0000-4000-8000-000000000003';
const ORG = '80000000-0000-4000-8000-000000000001';

function item(id: string, extra: Json = {}): Json {
  return {
    id,
    name: 'Two letters, four digits',
    pattern: '[A-Z]{2}[ -]?\\d{4}',
    flags: 'iu',
    enabled: true,
    updated_at: '2026-11-25T10:00:00.000Z',
    ...extra,
  };
}

const LIMITS = { max_patterns: 20, max_pattern_length: 200, max_name_length: 80, max_sample_length: 10000 };

function listAnswer(items: Json[], limits: Json = LIMITS): Json {
  return { success: true, items, limits };
}

describe('view builders (UI-SPEC 6.4, 6.5, 6.7)', () => {
  it('maps the list answer to the named fields only and reads limits with defaults', () => {
    const { identifierPatternsListView } = loadModule();
    const view = identifierPatternsListView(
      listAnswer([item(ID1, { tenant_key: 'o:secret', created_by: 'user-secret' }), item(ID2, { flags: 'u', enabled: false, updated_at: null }), item(ID3, { flags: 'gimsu' })]),
    );
    expect(view.items.map((i) => i.id)).toEqual([ID1, ID2, ID3]);
    expect(view.items.map((i) => i.flagKey)).toEqual(['flag.ignoreCase', 'flag.matchCase', 'flag.other']);
    expect(view.items[1]).toMatchObject({ enabled: false, updatedAt: null });
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(identifierPatternsListView({ success: true, items: [] }).limits).toEqual(LIMITS);
    expect(identifierPatternsListView(null).items).toEqual([]);
  });

  it('checks a draft locally: required, length, one line, compiles with u, does not match the empty string', () => {
    const { identifierPatternsLocalFindings } = loadModule();
    const ok = { name: 'Shape', pattern: '[A-Z]{4}-[A-Z]{4}', ignoreCase: true };
    expect(identifierPatternsLocalFindings(ok)).toEqual([]);
    const keys = (d: Json) => identifierPatternsLocalFindings({ ...ok, ...d }).map((f) => `${f.field}:${f.key}`);
    expect(keys({ name: '   ' })).toEqual(['name:form.nameRequired']);
    expect(keys({ name: 'x'.repeat(81) })).toEqual(['name:form.nameTooLong']);
    expect(keys({ pattern: '' })).toEqual(['pattern:form.patternRequired']);
    expect(keys({ pattern: 'AB\n\\d{4}' })).toEqual(['pattern:form.patternLineBreak']);
    expect(keys({ pattern: 'A'.repeat(201) })).toEqual(['pattern:finding.too_long']);
    expect(keys({ pattern: '[A-Z' })).toEqual(['pattern:finding.invalid_regex']);
    expect(keys({ pattern: 'a*' })).toEqual(['pattern:finding.no_alphanumeric']);
    const tooLong = identifierPatternsLocalFindings({ ...ok, name: 'x'.repeat(90) })[0]!;
    expect(tooLong.vars).toMatchObject({ count: 90, max: 80 });
    expect(identifierPatternsLocalFindings({ ...ok, pattern: '[A-Z' })[0]!.detail).toBeTruthy();
  });

  it('draws marked segments from the server offsets only and merges overlapping ranges', () => {
    const { identifierPatternsSegments } = loadModule();
    const sample = 'see AB-1234 and ab 1234 end';
    const segments = identifierPatternsSegments(sample, [
      { raw: 'AB-1234', normalized: 'ab1234', source: 'built_in', start: 4, end: 11 },
      { raw: 'AB-12', normalized: 'ab12', source: ID1, start: 4, end: 9 },
      { raw: 'ab 1234', normalized: 'ab1234', source: ID1, start: 16, end: 23 },
    ]);
    expect(segments).toEqual([
      { text: 'see ', mark: false },
      { text: 'AB-1234', mark: true },
      { text: ' and ', mark: false },
      { text: 'ab 1234', mark: true },
      { text: ' end', mark: false },
    ]);
    expect(identifierPatternsSegments(sample, [{ raw: 'x', normalized: 'x', source: 'built_in' }])).toBeNull();
    expect(identifierPatternsSegments(sample, [{ raw: 'x', normalized: 'x', source: 'built_in', start: 5, end: 5 }])).toBeNull();
    expect(identifierPatternsSegments(sample, [{ raw: 'x', normalized: 'x', source: 'built_in', start: 2, end: 999 }])).toBeNull();
  });

  it('builds one ledger row per stored form in order of first appearance, with distinct spellings and sources', () => {
    const { identifierPatternsLedger } = loadModule();
    const rows = identifierPatternsLedger(
      [
        { raw: 'CD-5678', normalized: 'cd5678', source: 'built_in', start: 30, end: 37 },
        { raw: 'AB-1234', normalized: 'ab1234', source: 'built_in', start: 4, end: 11 },
        { raw: 'ab 1234', normalized: 'ab1234', source: ID1, start: 16, end: 23 },
        { raw: 'AB-1234', normalized: 'ab1234', source: 'draft', start: 40, end: 47 },
        { raw: 'EF​12', normalized: 'ef12', source: ID3, start: 50, end: 55 },
      ],
      [{ id: ID1, name: 'Saved shape' }],
    );
    expect(rows.map((r) => r.stored)).toEqual(['ab1234', 'cd5678', 'ef12']);
    expect(rows[0]!.spellings).toEqual(['AB-1234', 'ab 1234']);
    expect(rows[0]!.sources).toEqual([{ kind: 'builtin' }, { kind: 'saved', name: 'Saved shape' }, { kind: 'draft' }]);
    expect(rows[2]!.sources).toEqual([{ kind: 'unknown' }]);
  });

  it('keeps the rebuild commands exactly as UI-SPEC 12 names them', () => {
    const { IDENTIFIER_PATTERNS_COMMANDS } = loadModule();
    expect(IDENTIFIER_PATTERNS_COMMANDS).toEqual({
      identifiers: 'npm run rag:identifiers -- --tenant <key>',
      relex: 'npm run rag:relex -- --tenant <key>',
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['rag:identifiers']).toBeTruthy();
    expect(pkg.scripts['rag:relex']).toBeTruthy();
  });

  it('has the same keys in en, zh and it, and falls back to English', () => {
    const { IDENTIFIER_PATTERNS_LABELS, identifierPatternsLabel } = loadModule();
    const en = Object.keys(IDENTIFIER_PATTERNS_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(100);
    expect(Object.keys(IDENTIFIER_PATTERNS_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(IDENTIFIER_PATTERNS_LABELS.it).sort()).toEqual(en);
    expect(identifierPatternsLabel('list.count', 'it', { count: 2, max: 20 })).toBe('Modelli: 2 di 20');
    expect(identifierPatternsLabel('list.count', 'fr', { count: 2, max: 20 })).toBe('Patterns: 2 of 20');
  });
});

describe('mapIdentifierPatternsError (UI-SPEC 8.2)', () => {
  const m = () => loadModule().mapIdentifierPatternsError;
  const r = (status: number, body: Json | null = null) => ({ ok: false, status, body });

  it('maps thrown and timed-out calls per call', () => {
    expect(m()({ thrown: true }, 'list')).toMatchObject({ key: 'error.network', kind: 'alert' });
    expect(m()({ thrown: true }, 'save')).toMatchObject({ key: 'error.saveUnavailable' });
    for (const call of ['toggle', 'delete']) expect(m()({ thrown: true }, call)).toMatchObject({ key: 'error.changeUnknown', reload: true });
    expect(m()({ thrown: true }, 'test')).toMatchObject({ key: 'test.unavailable' });
  });

  it('tells Forbidden from Admin access required', () => {
    expect(m()(r(401, { error: 'Admin authentication required' }), 'list')).toMatchObject({ key: 'error.signIn', kind: 'signIn' });
    expect(m()(r(403, { error: 'Admin access required' }), 'save')).toMatchObject({ key: 'error.signIn', kind: 'signIn' });
    expect(m()(r(403, { error: 'Forbidden' }), 'test')).toMatchObject({ key: 'error.workspace', kind: 'workspace' });
  });

  it('maps 503 per call', () => {
    expect(m()(r(503), 'list')).toMatchObject({ key: 'error.listUnavailable', kind: 'alert' });
    expect(m()(r(503), 'save')).toMatchObject({ key: 'error.saveUnavailable' });
    expect(m()(r(503), 'toggle')).toMatchObject({ key: 'error.changeUnknown', reload: true });
    expect(m()(r(503), 'delete')).toMatchObject({ key: 'error.changeUnknown', reload: true });
    expect(m()(r(503), 'test')).toMatchObject({ key: 'test.unavailable' });
  });

  it('maps 404 and 409', () => {
    const gone = { error: 'pattern_not_found' };
    expect(m()(r(404, gone), 'save')).toMatchObject({ key: 'error.patternGone', reload: true, closeForm: true });
    expect(m()(r(404, gone), 'toggle')).toMatchObject({ key: 'error.patternGone', reload: true });
    expect(m()(r(404, gone), 'delete')).toMatchObject({ key: 'delete.done', kind: 'done', reload: true });
    expect(m()(r(409, { error: 'limit_reached' }), 'save')).toMatchObject({ key: 'finding.limit_reached', field: 'form', reload: true });
    expect(m()(r(409, { error: 'name_exists' }), 'save')).toMatchObject({ key: 'finding.name_exists', field: 'name' });
  });

  it('maps every pattern finding code, and an unknown one to finding.other with its code', () => {
    const codes: Array<[string, string]> = [
      ['too_long', 'finding.too_long'],
      ['invalid_regex', 'finding.invalid_regex'],
      ['nested_unbounded_quantifier', 'finding.nested_quantifier'],
      ['probe_too_slow', 'finding.too_slow'],
      ['no_alphanumeric', 'finding.no_alphanumeric'],
      ['matches_empty', 'finding.no_alphanumeric'],
    ];
    for (const call of ['save', 'test']) {
      for (const [code, key] of codes) {
        const mapped = m()(r(400, { error: 'invalid_identifier_pattern', details: [{ path: 'pattern', message: code }] }), call);
        expect(mapped, code).toMatchObject({ key, field: 'pattern', kind: 'finding' });
      }
      const other = m()(r(400, { error: 'invalid_identifier_pattern', details: [{ path: 'pattern', message: 'backreference' }] }), call);
      expect(other).toMatchObject({ key: 'finding.other', code: 'backreference', field: 'pattern' });
    }
    const many = m()(
      r(400, { error: 'invalid_identifier_pattern', details: [{ path: 'pattern', message: 'too_long' }, { path: 'pattern', message: 'lookbehind' }] }),
      'save',
    );
    expect(many.findings!.map((f) => f.key)).toEqual(['finding.too_long', 'finding.other']);
  });

  it('maps field-level and other 400s, and anything else to the generic sentence', () => {
    for (const [p, label] of [
      ['name', 'form.name'],
      ['pattern', 'form.pattern'],
      ['flags', 'form.ignoreCase'],
      ['sample', 'test.sample'],
    ]) {
      expect(m()(r(400, { error: 'Invalid request data', details: [{ path: p, message: 'x' }] }), 'save')).toMatchObject({
        key: 'error.invalidField',
        field: p,
        vars: { fieldKey: label },
      });
    }
    expect(m()(r(400, { error: 'Invalid request data', details: [{ path: '', message: 'x' }] }), 'save')).toMatchObject({ key: 'error.invalid' });
    expect(m()(r(500), 'list')).toMatchObject({ key: 'error.generic', vars: { status: 500 } });
  });
});

interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
  hang?: boolean;
}
type Route = 'list' | 'create' | 'update' | 'delete' | 'test';
interface Call {
  route: Route | 'unknown';
  path: string;
  method: string;
  query: URLSearchParams;
  body: Json | null;
  init: Json;
}

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const p = apiPath.split('?')[0]!;
  const base = 'admin/identifier-patterns';
  if (p === base && method === 'GET') return 'list';
  if (p === base && method === 'POST') return 'create';
  if (p === `${base}/test` && method === 'POST') return 'test';
  if (p.startsWith(`${base}/`) && method === 'PATCH') return 'update';
  if (p.startsWith(`${base}/`) && method === 'DELETE') return 'delete';
  return 'unknown';
}

interface PageOptions {
  locale?: string;
  multiTenant?: boolean;
  indexOn?: boolean;
  items?: Json[];
  replies?: Partial<Record<Route, Reply | ((call: Call) => Reply)>>;
}

function loadPage(options: PageOptions = {}) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  let items = (options.items ?? [item(ID1), item(ID2, { name: 'Letters only', pattern: '[A-Z]{4}-[A-Z]{4}', enabled: false })]).map((i) => ({ ...i }));
  for (const label of ['desktop', 'mobile']) {
    const link = doc.createElement('a');
    link.className = 'menu-item';
    link.setAttribute('data-tab', 'rag-administration');
    link.setAttribute('data-test-link', label);
    doc.body.appendChild(link);
  }
  const modes = doc.createElement('a');
  modes.className = 'menu-item';
  modes.setAttribute('data-tab', 'rag-modes');
  doc.body.appendChild(modes);
  const index = doc.createElement('input');
  index.id = 'RAG_IDENTIFIER_INDEX';
  index.setAttribute('type', 'checkbox');
  index.checked = Boolean(options.indexOn);
  doc.body.appendChild(index);
  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  for (const ws of [
    { value: '', text: 'Default Workspace' },
    { value: ORG, text: 'Team One' },
  ]) {
    const option = doc.createElement('option');
    option.setAttribute('value', ws.value);
    option.textContent = ws.text;
    selector.appendChild(option);
  }
  doc.body.appendChild(selector);
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-identifier-patterns');
  doc.innerHtmlWrites = 0;

  const defaultReply = (call: Call): Reply => {
    switch (call.route) {
      case 'list':
        return { status: 200, body: listAnswer(items) };
      case 'create': {
        const created = item(ID3, { ...(call.body as Json), organizationId: undefined });
        items = [...items, created];
        return { status: 201, body: { success: true, item: created } };
      }
      case 'update': {
        const id = call.path.split('?')[0]!.split('/').pop()!;
        items = items.map((i) => (i.id === id ? { ...i, ...(call.body as Json), organizationId: undefined } : i));
        return { status: 200, body: { success: true, item: items.find((i) => i.id === id) } };
      }
      case 'delete': {
        const id = call.path.split('?')[0]!.split('/').pop()!;
        items = items.filter((i) => i.id !== id);
        return { status: 200, body: { success: true, id } };
      }
      case 'test':
        return {
          status: 200,
          body: {
            success: true,
            matches: [
              { raw: 'AB-1234', normalized: 'ab1234', source: 'built_in', start: 4, end: 11 },
              { raw: 'ab 1234', normalized: 'ab1234', source: ID1, start: 16, end: 23 },
            ],
            tested: { pattern_ids: [ID1] },
            truncated: false,
            total: 2,
          },
        };
      default:
        return { status: 500 };
    }
  };

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : null;
    const route = routeOf(apiPath, method);
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const call: Call = { route, path: apiPath, method, query, body, init };
    calls.push(call);
    if (route === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const custom = options.replies?.[route];
    const reply = typeof custom === 'function' ? custom(call) : custom ?? defaultReply(call);
    if (reply.hang) return new Promise(() => {});
    if (reply.throws) throw new TypeError('Failed to fetch');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body)) };
  };

  const regexCalls: string[] = [];
  const storage: string[] = [];
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    location: { origin: 'http://config.local', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: (k: string) => storage.push(k), removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: (k: string) => storage.push(k), removeItem: () => {} },
    currentConfig: { NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: options.multiTenant ? 'multi-tenant' : 'single-tenant' },
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    Intl,
    Date,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    ragFetch,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/identifier-patterns.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  // Record every RegExp method call made with a non-empty string, inside the panel's realm.
  new vm.Script(`
    (function () {
      const names = ['exec', 'test', Symbol.match, Symbol.matchAll, Symbol.replace, Symbol.split];
      for (const n of names) {
        const orig = RegExp.prototype[n];
        RegExp.prototype[n] = function (s, ...rest) { if (typeof s === 'string' && s.length > 0 && s.includes('SAMPLE')) __regexCalls.push(String(n)); return orig.call(this, s, ...rest); };
      }
    })();
  `).runInContext(Object.assign(context, { __regexCalls: regexCalls }));

  const root = doc.getElementById('rag-administration-identifiers');
  const page = {
    doc,
    context,
    root: root as FakeElement,
    calls,
    regexCalls,
    storage,
    selector,
    index,
    routeCalls(route: Route) {
      return calls.filter((c) => c.route === route);
    },
    async init() {
      const init = context.initIdentifierPatternsPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initIdentifierPatternsPanel is not defined');
      await init();
      await flush();
    },
    status(): string {
      return text(doc.querySelector('[data-identifier-patterns-status]'));
    },
    alertHost(): FakeElement {
      return doc.querySelector('[data-identifier-patterns-alert]') as FakeElement;
    },
    content(): FakeElement {
      return doc.querySelector('[data-identifier-patterns-content]') as FakeElement;
    },
    dialog(): FakeElement | null {
      return doc.querySelectorAll('dialog').find((d) => d.open) ?? null;
    },
  };
  return page;
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function text(el: FakeElement | null): string {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

function button(root: FakeElement | null, label: string): FakeElement {
  const found = (root ? root.querySelectorAll('button') : []).find((b) => text(b) === label);
  if (!found) throw new Error('no button ' + label);
  return found;
}

function control(root: FakeElement, name: string): FakeElement {
  const el = root.querySelectorAll('input, textarea').find((c) => c.getAttribute('name') === name);
  if (!el) throw new Error('no control ' + name);
  return el;
}

function type(el: FakeElement, value: string) {
  el.value = value;
  el.dispatch('input');
}

describe('index.html skeleton (UI-SPEC 6.1)', () => {
  it('has the section before Refusal calibration, the script tag after refusal-calibration.js and the intro words', () => {
    expect(indexHtml.match(/id="rag-administration-identifiers"/g)?.length).toBe(1);
    expect(indexHtml.indexOf('id="rag-administration-identifiers"')).toBeLessThan(indexHtml.indexOf('id="rag-administration-refusal"'));
    const scripts = [...indexHtml.matchAll(/<script src="(rag-panels\/[^"]+)"/g)].map((x) => x[1]);
    expect(scripts.filter((s) => s === 'rag-panels/identifier-patterns.js').length).toBe(1);
    expect(scripts.indexOf('rag-panels/identifier-patterns.js')).toBeGreaterThan(scripts.indexOf('rag-panels/refusal-calibration.js'));
    expect(scripts.indexOf('rag-panels/identifier-patterns.js')).toBeGreaterThan(scripts.indexOf('rag-panels/rag-ui.js'));
    expect(indexHtml).toMatch(/identifier patterns/);
    const block = markedBlock('rag-identifier-patterns');
    expect(block).toContain('role="status"');
    expect(block).toContain('aria-live="polite"');
    expect(block).toContain('tabindex="-1"');
  });

  it('the panel file has no innerHTML, no web storage, no cookie writes and no Authorization header', () => {
    const source = fs.readFileSync(panelFile, 'utf8');
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|Authorization/);
    expect(source).not.toMatch(/console\./);
    for (const name of source.matchAll(/^(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      expect(name[1], 'top-level name prefix').toMatch(/^(IdentifierPatterns|IDENTIFIER_PATTERNS_|identifierPatterns)/);
    }
  });
});

describe('panel (UI-SPEC 6.3 to 7)', () => {
  it('mounts in single-tenant mode: no organizationId, scope sentence, list, built-in line, test region', async () => {
    const page = loadPage();
    await page.init();
    expect(page.root).toBeTruthy();
    const list = page.routeCalls('list');
    expect(list).toHaveLength(1);
    expect(list[0]!.query.has('organizationId')).toBe(false);
    expect(text(page.root)).toContain('Applies to this deployment.');
    expect(text(page.root)).not.toContain('Workspace:');
    expect(text(page.content())).toContain('Built-in rule, always on');
    expect(text(page.content())).toContain('Patterns: 2 of 20');
    expect(page.root.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(text(page.content())).toContain('Test patterns');
    expect(page.status()).toContain('Patterns loaded: 2.');
    expect(page.root.getAttribute('lang')).toBe('en');
    expect(page.calls.every((c) => !(c.init.headers as Json | undefined)?.Authorization)).toBe(true);
  });

  it('shows the index-off note with a button to the switch, and no note when the index is on', async () => {
    const off = loadPage();
    await off.init();
    expect(text(off.content())).toContain('The identifier index switch is off on this page.');
    let modesClicked = 0;
    (off.doc.querySelector('[data-tab="rag-modes"]') as FakeElement).addEventListener('click', () => (modesClicked += 1));
    button(off.content(), 'Open retrieval switches').click();
    expect(modesClicked).toBe(1);
    expect(off.doc.activeElement).toBe(off.index);
    const on = loadPage({ indexOn: true });
    await on.init();
    expect(text(on.content())).not.toContain('The identifier index switch is off');
  });

  it('is idempotent: a second mount refreshes the list and keeps the form, its values, the sample and the result', async () => {
    const page = loadPage();
    await page.init();
    button(page.content(), 'Add pattern').click();
    type(control(page.content(), 'identifier-pattern-name'), 'Kept name');
    type(control(page.content(), 'identifier-pattern-sample'), 'see AB-1234 and ab 1234 SAMPLE');
    button(page.content(), 'Run test').click();
    await flush();
    expect(text(page.content())).toContain('Identifiers found: 2. Stored forms: 1.');
    await page.init();
    expect(page.routeCalls('list')).toHaveLength(2);
    expect(control(page.content(), 'identifier-pattern-name').value).toBe('Kept name');
    expect(control(page.content(), 'identifier-pattern-sample').value).toContain('SAMPLE');
    expect(text(page.content())).toContain('Identifiers found: 2. Stored forms: 1.');
    expect(page.root.querySelectorAll('[data-identifier-patterns-form]')).toHaveLength(1);
  });

  it('binds every RAG administration link', async () => {
    const page = loadPage();
    page.doc.dispatch('DOMContentLoaded');
    await flush();
    const before = page.routeCalls('list').length;
    for (const link of page.doc.querySelectorAll('[data-tab="rag-administration"]')) link.click();
    await flush();
    expect(page.routeCalls('list').length).toBe(before + 2);
  });

  it('multi-tenant: sends the workspace on every call, shows its name and reloads on change', async () => {
    const page = loadPage({ multiTenant: true });
    page.selector.value = ORG;
    await page.init();
    expect(page.routeCalls('list')[0]!.query.get('organizationId')).toBe(ORG);
    expect(text(page.root)).toContain('Workspace: Team One');
    expect(text(page.root)).toContain('Applies to the workspace chosen under Document Processing.');
    button(page.content(), 'Add pattern').click();
    type(control(page.content(), 'identifier-pattern-name'), 'Shape');
    type(control(page.content(), 'identifier-pattern'), '[A-Z]{4}-[A-Z]{4}');
    button(page.content(), 'Save pattern').click();
    await flush();
    expect(page.routeCalls('create')[0]!.body).toMatchObject({ organizationId: ORG, name: 'Shape', pattern: '[A-Z]{4}-[A-Z]{4}', flags: 'iu', enabled: true });
    button(page.content(), 'Disable pattern').click();
    await flush();
    expect(page.routeCalls('update')[0]!.body).toMatchObject({ organizationId: ORG, enabled: false });
    page.selector.value = '';
    page.selector.dispatch('change');
    await flush();
    const last = page.routeCalls('list').at(-1)!;
    expect(last.query.has('organizationId')).toBe(false);
    expect(text(page.root)).toContain('Workspace: Default workspace');
    expect(text(page.root)).not.toContain('Tenant');
  });

  it('adds a pattern, shows the rebuild note with both commands as code, and moves focus to the row', async () => {
    const page = loadPage();
    await page.init();
    expect(text(page.content())).not.toContain('Patterns changed.');
    button(page.content(), 'Add pattern').click();
    expect(page.doc.activeElement).toBe(control(page.content(), 'identifier-pattern-name'));
    type(control(page.content(), 'identifier-pattern-name'), 'Three digit groups');
    type(control(page.content(), 'identifier-pattern'), '\\d{3} \\d{3} \\d{3}');
    const ignore = page.content().querySelectorAll('input').find((i) => i.getAttribute('type') === 'checkbox')!;
    ignore.checked = false;
    ignore.dispatch('change');
    button(page.content(), 'Save pattern').click();
    await flush();
    expect(page.routeCalls('create')[0]!.body).toEqual({ name: 'Three digit groups', pattern: '\\d{3} \\d{3} \\d{3}', flags: 'u', enabled: true });
    expect(page.status()).toContain('Pattern Three digit groups added.');
    expect(page.root.querySelectorAll('[data-identifier-patterns-form]')).toHaveLength(0);
    const note = page.content().querySelector('[data-identifier-patterns-rebuild]')!;
    expect(text(note)).toContain('Patterns changed.');
    const codes = note.querySelectorAll('code').map((c) => text(c));
    expect(codes).toEqual(['npm run rag:identifiers -- --tenant <key>', 'npm run rag:relex -- --tenant <key>']);
    expect(page.doc.activeElement?.getAttribute('aria-label')).toBe('Edit pattern Three digit groups');
  });

  it('a local finding blocks the request and focuses the field', async () => {
    const page = loadPage();
    await page.init();
    button(page.content(), 'Add pattern').click();
    type(control(page.content(), 'identifier-pattern-name'), 'Bad');
    type(control(page.content(), 'identifier-pattern'), '[A-Z');
    const pattern = control(page.content(), 'identifier-pattern');
    expect(pattern.getAttribute('aria-invalid')).toBe('true');
    button(page.content(), 'Save pattern').click();
    await flush();
    expect(page.routeCalls('create')).toHaveLength(0);
    expect(page.doc.activeElement).toBe(pattern);
    expect(text(page.content())).toContain('This is not a valid pattern.');
  });

  it('shows each server finding at its field and keeps the values', async () => {
    const page = loadPage({
      replies: { create: { status: 400, body: { success: false, error: 'invalid_identifier_pattern', details: [{ path: 'pattern', message: 'nested_unbounded_quantifier' }] } } },
    });
    await page.init();
    button(page.content(), 'Add pattern').click();
    type(control(page.content(), 'identifier-pattern-name'), 'Nested');
    type(control(page.content(), 'identifier-pattern'), '(a+)+b');
    button(page.content(), 'Save pattern').click();
    await flush();
    expect(text(page.content())).toContain('The pattern repeats a group that already repeats without a limit');
    expect(control(page.content(), 'identifier-pattern').value).toBe('(a+)+b');
    expect(page.doc.activeElement).toBe(control(page.content(), 'identifier-pattern'));
  });

  it('an unknown finding code is shown in a code element inside a sentence', async () => {
    const page = loadPage({
      replies: { create: { status: 400, body: { success: false, error: 'invalid_identifier_pattern', details: [{ path: 'pattern', message: XSS_PAYLOAD }] } } },
    });
    await page.init();
    button(page.content(), 'Add pattern').click();
    type(control(page.content(), 'identifier-pattern-name'), 'Shape');
    type(control(page.content(), 'identifier-pattern'), 'AB\\d');
    button(page.content(), 'Save pattern').click();
    await flush();
    const finding = page.content().querySelectorAll('code').find((c) => c.textContent === XSS_PAYLOAD);
    expect(finding).toBeTruthy();
    expect(text(finding!.parentElement)).toContain('The server did not accept the pattern');
    expect(injectedElements(page.doc)).toHaveLength(0);
  });

  it('enable and disable update the row in place and keep focus on the same button', async () => {
    const page = loadPage();
    await page.init();
    const disable = button(page.content(), 'Disable pattern');
    disable.click();
    await flush();
    expect(page.routeCalls('list')).toHaveLength(1);
    expect(page.status()).toContain('disabled.');
    const now = page.content().querySelectorAll('button').filter((b) => text(b) === 'Enable pattern');
    expect(now).toHaveLength(2);
    expect(page.doc.activeElement).toBe(now[0]);
    expect(text(page.content())).toContain('Patterns changed.');
  });

  it('delete asks first with focus on Keep pattern, then deletes and reports done', async () => {
    const page = loadPage();
    await page.init();
    button(page.content(), 'Delete pattern').click();
    const dialog = page.dialog()!;
    expect(dialog).toBeTruthy();
    expect(text(dialog)).toContain('Delete pattern Two letters, four digits?');
    expect(page.doc.activeElement).toBe(button(dialog, 'Keep pattern'));
    button(dialog, 'Delete pattern').click();
    await flush();
    expect(page.routeCalls('delete')).toHaveLength(1);
    expect(page.routeCalls('delete')[0]!.path).toBe(`admin/identifier-patterns/${ID1}`);
    expect(page.status()).toContain('Pattern Two letters, four digits deleted.');
    expect(page.root.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('a 404 on delete counts as done; a 503 on toggle reloads with changeUnknown', async () => {
    const page = loadPage({ replies: { delete: { status: 404, body: { success: false, error: 'pattern_not_found' } }, update: { status: 503, body: {} } } });
    await page.init();
    button(page.content(), 'Delete pattern').click();
    button(page.dialog(), 'Delete pattern').click();
    await flush();
    expect(page.status()).toContain('deleted.');
    button(page.content(), 'Disable pattern').click();
    await flush();
    expect(page.status()).toContain('The server did not confirm the change');
    expect(page.routeCalls('list').length).toBeGreaterThanOrEqual(3);
  });

  it('closing a changed form opens the Discard dialog with focus on Keep editing', async () => {
    const page = loadPage();
    await page.init();
    button(page.content(), 'Add pattern').click();
    type(control(page.content(), 'identifier-pattern-name'), 'Changed');
    button(page.content(), 'Close form').click();
    const dialog = page.dialog()!;
    expect(text(dialog)).toContain('Discard unsaved changes?');
    expect(page.doc.activeElement).toBe(button(dialog, 'Keep editing'));
    expect(button(dialog, 'Discard changes').className).not.toContain('btn-primary');
    button(dialog, 'Discard changes').click();
    await flush();
    expect(page.root.querySelectorAll('[data-identifier-patterns-form]')).toHaveLength(0);
  });

  it('runs a test with the draft and draws the marked sample and the ledger from the server answer only', async () => {
    const page = loadPage();
    await page.init();
    button(page.content(), 'Edit pattern').click();
    type(control(page.content(), 'identifier-pattern'), '[A-Z]{2} ?\\d{4}');
    type(control(page.content(), 'identifier-pattern-sample'), 'see AB-1234 and ab 1234 SAMPLE');
    button(page.content(), 'Run test').click();
    await flush();
    const call = page.routeCalls('test')[0]!;
    expect(call.body).toEqual({ sample: 'see AB-1234 and ab 1234 SAMPLE', draft: { id: ID1, pattern: '[A-Z]{2} ?\\d{4}', flags: 'iu' } });
    const content = text(page.content());
    expect(content).toContain('in place of the saved version of Two letters, four digits');
    expect(content).toContain('Identifiers found: 2. Stored forms: 1.');
    const marks = page.content().querySelectorAll('mark').map((mk) => mk.textContent);
    expect(marks).toEqual(['AB-1234', 'ab 1234']);
    const ledger = page.content().querySelectorAll('tbody tr').at(-1)!;
    expect(text(ledger)).toContain('ab1234');
    expect(text(ledger)).toContain('Built-in rule and Two letters, four digits');
    expect(page.regexCalls).toEqual([]);
    expect(page.storage).toEqual([]);
  });

  it('leaves a locally invalid draft out and says so; a server-refused draft shows draftRefused', async () => {
    const page = loadPage();
    await page.init();
    button(page.content(), 'Add pattern').click();
    type(control(page.content(), 'identifier-pattern-name'), 'Bad');
    type(control(page.content(), 'identifier-pattern'), '[A-Z');
    type(control(page.content(), 'identifier-pattern-sample'), 'AB-1234 SAMPLE');
    button(page.content(), 'Run test').click();
    await flush();
    expect(page.routeCalls('test')[0]!.body).toEqual({ sample: 'AB-1234 SAMPLE' });
    expect(text(page.content())).toContain('The pattern in the form has an error and was left out.');

    const refused = loadPage({
      replies: { test: { status: 400, body: { success: false, error: 'invalid_identifier_pattern', details: [{ path: 'pattern', message: 'probe_too_slow' }] } } },
    });
    await refused.init();
    button(refused.content(), 'Add pattern').click();
    type(control(refused.content(), 'identifier-pattern-name'), 'Slow');
    type(control(refused.content(), 'identifier-pattern'), '(ab|a)*c');
    type(control(refused.content(), 'identifier-pattern-sample'), 'text SAMPLE');
    button(refused.content(), 'Run test').click();
    await flush();
    expect(text(refused.content())).toContain('The test did not run because the pattern in the form has an error.');
    expect(text(refused.content())).toContain('The pattern took too long on a 10 KB test text');
    expect(refused.doc.activeElement).toBe(control(refused.content(), 'identifier-pattern'));
  });

  it('an empty sample sends nothing; no offsets shows the unavailable line; no match shows the none block', async () => {
    const page = loadPage({
      replies: {
        test: (call) =>
          String(call.body?.sample).includes('none')
            ? { status: 200, body: { success: true, matches: [], tested: { pattern_ids: [] }, truncated: false, total: 0 } }
            : { status: 200, body: { success: true, matches: [{ raw: 'AB-1', normalized: 'ab1', source: 'built_in' }], tested: { pattern_ids: [] }, truncated: true, total: 900 } },
      },
    });
    await page.init();
    button(page.content(), 'Run test').click();
    await flush();
    expect(page.routeCalls('test')).toHaveLength(0);
    expect(text(page.content())).toContain('Paste some text first.');
    type(control(page.content(), 'identifier-pattern-sample'), 'AB-1 SAMPLE');
    button(page.content(), 'Run test').click();
    await flush();
    expect(text(page.content())).toContain('The positions of the identifiers in the sample are not available');
    expect(text(page.content())).toContain('Showing the first 1 of 900 identifiers.');
    type(control(page.content(), 'identifier-pattern-sample'), 'none SAMPLE');
    expect(text(page.content())).toContain('The patterns or the sample changed after this test.');
    button(page.content(), 'Run test').click();
    await flush();
    expect(text(page.content())).toContain('No identifiers found');
  });

  it('401 replaces the panel content with the sign-in alert; Forbidden shows the workspace alert', async () => {
    const signIn = loadPage({ replies: { list: { status: 401, body: { success: false, error: 'Admin authentication required' } } } });
    await signIn.init();
    expect(signIn.content().querySelectorAll('table')).toHaveLength(0);
    expect(text(signIn.root)).toMatch(/sign/i);
    expect(button(signIn.root, 'Reload panel')).toBeTruthy();
    const forbidden = loadPage({ multiTenant: true, replies: { list: { status: 403, body: { success: false, error: 'Forbidden' } } } });
    await forbidden.init();
    expect(text(forbidden.alertHost())).toContain('Your admin account is not a member of this workspace.');
    expect(text(forbidden.content())).not.toContain('Test patterns');
  });

  it('a list 503 after a successful load keeps the list dimmed and disables writes', async () => {
    let fail = false;
    const page = loadPage({ replies: { list: () => (fail ? { status: 503, body: {} } : { status: 200, body: listAnswer([item(ID1)]) }) } });
    await page.init();
    fail = true;
    button(page.content(), 'Refresh patterns').click();
    await flush();
    expect(text(page.alertHost())).toContain('Identifier patterns are unavailable right now.');
    expect(page.root.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(button(page.content(), 'Add pattern').disabled).toBe(true);
    expect(button(page.content(), 'Edit pattern').disabled).toBe(true);
  });

  it('at the limit, Add pattern is aria-disabled with the reason and opens nothing', async () => {
    const page = loadPage({ items: Array.from({ length: 20 }, (_, i) => item(`c0000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`, { name: `Shape ${i}` })) });
    await page.init();
    const add = button(page.content(), 'Add pattern');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.disabled).toBe(false);
    const reason = page.doc.getElementById(add.getAttribute('aria-describedby')!)!;
    expect(text(reason)).toContain('The limit of 20 patterns is reached.');
    add.click();
    expect(page.root.querySelectorAll('[data-identifier-patterns-form]')).toHaveLength(0);
  });

  it('drops a stale list answer and times a call out after 15 seconds', async () => {
    const source = fs.readFileSync(panelFile, 'utf8');
    expect(source).toMatch(/AbortController/);
    expect(source).toMatch(/15000|RAG_UI_REQUEST_TIMEOUT_MS/);
    let n = 0;
    let release: (() => void) | null = null;
    const page = loadPage({
      replies: {
        list: () => {
          n += 1;
          return n === 1 ? { status: 200, body: listAnswer([item(ID1, { name: 'Old answer' })]) } : { status: 200, body: listAnswer([item(ID1, { name: 'New answer' })]) };
        },
      },
    });
    const fetcher = page.context.ragFetch as (p: string, i: Json) => Promise<unknown>;
    page.context.ragFetch = async (p: string, i: Json) => {
      if (n === 0) {
        const answer = fetcher(p, i);
        await new Promise<void>((resolve) => (release = resolve));
        return answer;
      }
      return fetcher(p, i);
    };
    const init = page.context.initIdentifierPatternsPanel as () => Promise<void>;
    void init();
    await flush(3);
    await init();
    release!();
    await flush();
    expect(text(page.content())).toContain('New answer');
    expect(text(page.content())).not.toContain('Old answer');
  });

  it('renders names, patterns, spellings, stored forms and invisible characters as text', async () => {
    const page = loadPage({
      items: [item(ID1, { name: XSS_PAYLOAD, pattern: XSS_PAYLOAD, flags: XSS_PAYLOAD })],
      replies: {
        test: {
          status: 200,
          body: {
            success: true,
            matches: [{ raw: `${XSS_PAYLOAD}​‮`, normalized: XSS_PAYLOAD, source: ID1, start: 0, end: 5 }],
            tested: { pattern_ids: [ID1] },
            truncated: false,
            total: 1,
          },
        },
      },
    });
    await page.init();
    button(page.content(), 'Delete pattern').click();
    button(page.dialog(), 'Keep pattern').click();
    await flush();
    type(control(page.content(), 'identifier-pattern-sample'), `${XSS_PAYLOAD} SAMPLE`);
    button(page.content(), 'Run test').click();
    await flush();
    expect(injectedElements(page.doc)).toHaveLength(0);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(text(page.content())).toContain('[U+200B][U+202E]');
  });

  it('localizes the panel in zh and it', async () => {
    for (const [locale, word] of [
      ['zh-CN', '标识符模式'],
      ['it-IT', 'Modelli di identificatori'],
    ] as const) {
      const page = loadPage({ locale });
      await page.init();
      expect(text(page.root)).toContain(word);
      expect(page.root.getAttribute('lang')).toBe(locale.slice(0, 2));
    }
  });
});

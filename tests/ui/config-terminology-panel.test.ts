import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement } from './helpers/html-fake-dom';
import { markedBlock } from './helpers/ingest-impact-harness';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/terminology.js'), 'utf8');
const mod = require('../../scripts/config-ui/rag-panels/terminology.js');

type Json = Record<string, unknown>;

const XSS = '<img src=x onerror=alert(1)>';
const ORG = 'c0000000-0000-4000-8000-000000000001';
const ENTRY_ID = 'e0000000-0000-4000-8000-000000000001';
const SHARED_ID = 'e0000000-0000-4000-8000-000000000002';
const NEW_ID = 'e0000000-0000-4000-8000-000000000003';
const CANDIDATE_ID = 'f0000000-0000-4000-8000-000000000001';
const ENABLED = ['zh', 'en', 'it'];
const BASE = '/api/rag/admin/terminology';

function entry(extra: Json = {}): Json {
  return {
    id: ENTRY_ID,
    layer_key: 'shared',
    canonical: 'term alpha beta',
    variants: ['termalpha', 'alpha beta'],
    language: 'en',
    kind: 'synonym',
    mode: 'one_way',
    source_language: null,
    target_language: null,
    enabled: true,
    note: null,
    suppresses_entry_id: null,
    created_by: null,
    updated_by: null,
    created_at: '2026-11-20T09:30:00.000Z',
    updated_at: '2026-11-20T09:30:00.000Z',
    ...extra,
  };
}

function listAnswer(items: Json[] = [entry()], extra: Json = {}): Json {
  return { success: true, layer: 'shared', layer_version: 7, entries_sha256: 'a'.repeat(64), enabled_languages: ENABLED, items, total: items.length, limit: 25, offset: 0, ...extra };
}

function versionsAnswer(multiTenant: boolean): Json {
  return {
    success: true,
    shared: { version: 7, entries_sha256: 'a'.repeat(64) },
    workspace: multiTenant ? { version: 3, entries_sha256: 'b'.repeat(64) } : null,
    enabled_languages: ENABLED,
  };
}

interface Call {
  key: string;
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}
interface Reply {
  status: number;
  body?: unknown;
}
type Replies = Record<string, Reply | ((call: Call) => Reply)>;

function routeKey(p: string, method: string): string {
  const rest = p.slice(BASE.length).replace(/^\//, '');
  if (rest === '') return method === 'GET' ? 'list' : method === 'POST' ? 'create' : 'unknown';
  if (rest === 'versions' || rest === 'audit' || rest === 'preview' || rest === 'import' || rest === 'suppressions') return rest;
  if (rest === 'candidates') return 'candidates';
  if (rest.startsWith('candidates/')) return 'decide';
  if (method === 'PATCH') return 'patch';
  if (method === 'DELETE') return 'delete';
  return 'unknown';
}

function loadPage(options: { multiTenant?: boolean; locale?: string; replies?: Replies; list?: Json; organization?: string } = {}) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  for (const [value, text] of [
    ['', 'Default Workspace'],
    [ORG, 'Workspace One'],
  ]) {
    const option = doc.createElement('option');
    option.setAttribute('value', value!);
    option.textContent = text!;
    selector.appendChild(option);
  }
  selector.value = options.organization ?? (options.multiTenant ? ORG : '');
  doc.body.appendChild(selector);
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-terminology');
  doc.innerHtmlWrites = 0;

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : init.body;
    const p = apiPath.split('?')[0]!;
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const key = p.startsWith(BASE) ? routeKey(p, method) : 'unknown';
    const call: Call = { key, path: apiPath, method, query, body };
    calls.push(call);
    if (key === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const defaults: Record<string, Reply> = {
      versions: { status: 200, body: versionsAnswer(Boolean(options.multiTenant)) },
      list: { status: 200, body: options.list ?? listAnswer() },
      create: { status: 201, body: { success: true, entry_id: NEW_ID, layer_version: 8, entries_sha256: 'c'.repeat(64), warnings: [] } },
      patch: { status: 200, body: { success: true, entry_id: ENTRY_ID, layer_version: 8, entries_sha256: 'c'.repeat(64), warnings: [] } },
      delete: { status: 200, body: { success: true, layer_version: 8, entries_sha256: 'c'.repeat(64) } },
      suppressions: { status: 200, body: { success: true, layer_version: 4, entries_sha256: 'd'.repeat(64), suppressed: true } },
      audit: { status: 200, body: { success: true, layer: 'shared', items: [], total: 0, limit: 20, offset: 0 } },
      candidates: { status: 200, body: { success: true, items: [], limit: 25, offset: 0, next_offset: null } },
      decide: { status: 200, body: { success: true, candidate_id: CANDIDATE_ID, status: 'accepted', entry_id: NEW_ID } },
      preview: { status: 200, body: { success: true, capped: false, expansion_tokens: [], issues: [], matches: [], original_tokens: [], overrides: [], version: 's7' } },
      import: { status: 200, body: { success: true, report: { applied: false, create: 0, update: 0, unchanged: 0, delete: 0, issues: [], layer_version_seen: 7 } } },
    };
    const custom = options.replies?.[key];
    const reply = typeof custom === 'function' ? custom(call) : (custom ?? defaults[key]!);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body)) };
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
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/terminology.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-terminology') as FakeElement;
  return {
    doc,
    root,
    calls,
    of: (key: string) => calls.filter((c) => c.key === key),
    async init() {
      const init = context.initTerminologyPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initTerminologyPanel is not defined');
      await init();
      await flush();
    },
    status: () => doc.querySelector('[data-terminology-status]') as FakeElement,
  };
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function button(root: FakeElement, text: string): FakeElement {
  const found = root.querySelectorAll('button').find((b) => b.textContent.trim() === text);
  expect(found, 'button ' + text).toBeTruthy();
  return found as FakeElement;
}

function field(root: FakeElement, name: string): FakeElement {
  const found = root.querySelector(`[data-terminology-field="${name}"]`);
  expect(found, 'field ' + name).toBeTruthy();
  return found as FakeElement;
}

function setValue(el: FakeElement, value: string) {
  el.value = value;
  el.dispatch('input');
  el.dispatch('change');
}

function optionValues(select: FakeElement): string[] {
  return select.querySelectorAll('option').map((o) => o.getAttribute('value') ?? '');
}

function noMarkup(doc: FakeDocument) {
  expect(doc.innerHtmlWrites).toBe(0);
  expect(doc.body.querySelectorAll('img')).toHaveLength(0);
  expect(doc.body.querySelectorAll('script')).toHaveLength(0);
  for (const el of doc.body.querySelectorAll('*')) {
    for (const name of el.attributes.keys()) expect(name.startsWith('on')).toBe(false);
  }
}

describe('index.html and source rules', () => {
  it('has the Terminology section and loads terminology.js after rag-ui.js', () => {
    const block = markedBlock('rag-terminology');
    expect(block).toContain('id="rag-administration-terminology"');
    for (const attr of ['data-terminology-title', 'data-terminology-description', 'data-terminology-workspace', 'data-terminology-alert', 'data-terminology-content', 'data-terminology-status']) {
      expect(block).toContain(attr);
    }
    expect(block).toMatch(/role="status" aria-live="polite"/);
    const script = indexHtml.indexOf('<script src="rag-panels/terminology.js"></script>');
    expect(script).toBeGreaterThan(indexHtml.indexOf('<script src="rag-panels/rag-ui.js"></script>'));
  });

  it('never writes markup and holds no list of language codes (D-35)', () => {
    expect(panelSource).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(panelSource).toContain('enabled_languages');
    expect(panelSource).not.toMatch(/\[\s*'(zh|en|it)'\s*,\s*'(zh|en|it)'/);
    expect(panelSource).not.toMatch(/['"](zh|en|it)['"]\s*:\s*\{\s*name/);
  });

  it('has the same label keys in en, zh and it', () => {
    const labels = mod.TERMINOLOGY_LABELS as Record<string, Record<string, string>>;
    const en = Object.keys(labels.en!).sort();
    expect(en.length).toBeGreaterThan(50);
    expect(Object.keys(labels.zh!).sort()).toEqual(en);
    expect(Object.keys(labels.it!).sort()).toEqual(en);
  });
});

describe('pure view builders', () => {
  it('buildEntryView keeps a payload canonical as plain text and joins variants', () => {
    const view = mod.buildEntryView(entry({ canonical: XSS, variants: [XSS, 'termalpha'] }), 'en');
    expect(view.canonical).toBe(XSS);
    expect(view.variants).toBe(XSS + ', termalpha');
    expect(view.kind).toBe('Synonym');
    expect(view.suppression).toBe(false);
    for (const value of Object.values(view)) expect(typeof value === 'object' && value !== null && 'nodeType' in (value as object)).toBe(false);
  });

  it('buildEntryView shows a translation pair as source → target and a suppression row as hidden', () => {
    const pair = mod.buildEntryView(entry({ kind: 'translation', language: 'zh', source_language: 'zh', target_language: 'en', canonical: 'term alpha beta', variants: ['术语甲乙丙'] }), 'en');
    expect(pair.language).toContain('→');
    expect(pair.language).toContain('English');
    const hidden = mod.buildEntryView(entry({ suppresses_entry_id: SHARED_ID, variants: [] }), 'en');
    expect(hidden.suppression).toBe(true);
    expect(hidden.status).toBe('Hidden shared entry');
  });

  it('buildEntryForm for kind translation has source and target selects of exactly the enabled languages and a fixed one_way mode', () => {
    const form = mod.buildEntryForm({ kind: 'translation' }, ENABLED, 'en');
    const names = form.fields.map((f: { name: string }) => f.name);
    expect(names).toContain('source_language');
    expect(names).toContain('target_language');
    expect(names).not.toContain('language');
    for (const name of ['source_language', 'target_language']) {
      const f = form.fields.find((x: { name: string }) => x.name === name);
      expect(f.options.map((o: { value: string }) => o.value)).toEqual(ENABLED);
    }
    const mode = form.fields.find((x: { name: string }) => x.name === 'mode');
    expect(mode.control).toBe('fixed');
    expect(mode.value).toBe('one_way');
  });

  it('buildEntryForm for another kind has a language select of the enabled languages plus any and no pair fields', () => {
    for (const kind of ['synonym', 'abbreviation', 'alias', 'identifier', 'misspelling']) {
      const form = mod.buildEntryForm({ kind }, ENABLED, 'en');
      const names = form.fields.map((f: { name: string }) => f.name);
      expect(names).not.toContain('source_language');
      expect(names).not.toContain('target_language');
      const language = form.fields.find((x: { name: string }) => x.name === 'language');
      expect(language.options.map((o: { value: string }) => o.value)).toEqual(['any', ...ENABLED]);
      const mode = form.fields.find((x: { name: string }) => x.name === 'mode');
      expect(mode.control).toBe('select');
    }
  });

  it('buildIssueList places every issue code next to a field', () => {
    const issues = [
      { code: 'conflict', severity: 'error', message: 'conflict text' },
      { code: 'invalid_language', severity: 'error', message: 'language text' },
      { code: 'invalid_translation', severity: 'error', message: 'translation text' },
      { code: 'override', severity: 'warning', message: 'override text' },
      { code: 'limit', severity: 'error', message: 'limit text' },
    ];
    const plain = mod.buildIssueList(issues, 'synonym', 'en');
    expect(plain.map((i: { field: string }) => i.field)).toEqual(['variants', 'language', 'kind', 'canonical', 'summary']);
    const pair = mod.buildIssueList(issues, 'translation', 'en');
    expect(pair.map((i: { field: string }) => i.field)).toEqual(['variants', 'source_language', 'target_language', 'canonical', 'summary']);
    expect(pair[1].message).toBe('language text');
    expect(pair[1].label).not.toBe('');
  });

  it('buildImportReport counts the diff and blocks apply on an error issue only', () => {
    const report = { applied: false, create: 2, update: 1, unchanged: 5, delete: 0, layer_version_seen: 7, issues: [{ code: 'override', severity: 'warning', message: XSS, row: 3 }] };
    const ok = mod.buildImportReport(report, 'en');
    expect(ok.counts.map((c: { value: number }) => c.value)).toEqual([2, 1, 5, 0]);
    expect(ok.blocking).toBe(false);
    expect(ok.issues[0].row).toBe(3);
    expect(ok.issues[0].message).toBe(XSS);
    const bad = mod.buildImportReport({ ...report, issues: [{ code: 'cycle', severity: 'error', message: 'x', row: 1 }] }, 'en');
    expect(bad.blocking).toBe(true);
  });

  it('buildCandidateView keeps masked examples as text and candidateDraft prefills a variant', () => {
    const candidate = { id: CANDIDATE_ID, term: 'termalpha', language: 'en', support: 4, examples: [XSS, 'where is termalpha'], corpus_df: 0, status: 'pending', source: 'miss_log', entry_id: null, first_seen: null, last_seen: '2026-11-25T10:00:00.000Z' };
    const view = mod.buildCandidateView(candidate, 'en');
    expect(view.term).toBe('termalpha');
    expect(view.examples).toEqual([XSS, 'where is termalpha']);
    expect(view.support).toContain('4');
    const draft = mod.candidateDraft(candidate, ENABLED);
    expect(draft.variantsText).toBe('termalpha');
    expect(draft.language).toBe('en');
    expect(draft.kind).toBe('synonym');
    expect(mod.candidateDraft({ ...candidate, language: 'xx' }, ENABLED).language).toBe('any');
  });
});

describe('Terminology panel', () => {
  it('single-tenant: hides the layer switch and lists the shared layer', async () => {
    const page = loadPage();
    await page.init();
    expect(page.root.querySelector('[data-terminology-layer]')).toBeNull();
    expect(page.of('list')[0]!.query.get('layer')).toBe('shared');
    expect(page.of('list')[0]!.query.has('organization_id')).toBe(false);
    expect(page.root.textContent).toContain('term alpha beta');
  });

  it('multi-tenant: shows the layer switch, and the workspace layer sends the selected organization', async () => {
    const page = loadPage({ multiTenant: true });
    await page.init();
    const layer = page.root.querySelector('[data-terminology-layer]') as FakeElement;
    expect(layer).toBeTruthy();
    const workspace = layer.querySelector('input[value="workspace"]') as FakeElement;
    workspace.checked = true;
    workspace.dispatch('change');
    await flush();
    const last = page.of('list').at(-1)!;
    expect(last.query.get('layer')).toBe('workspace');
    expect(last.query.get('organization_id')).toBe(ORG);
  });

  it('renders a payload entry as text only', async () => {
    const page = loadPage({ list: listAnswer([entry({ canonical: XSS, variants: [XSS], note: XSS })]) });
    await page.init();
    expect(page.root.textContent).toContain(XSS);
    noMarkup(page.doc);
  });

  it('create sends the layer version and the fields, and a 409 shows the reload message', async () => {
    const page = loadPage({ replies: { create: { status: 409, body: { success: false, error: 'version_conflict', current_version: 9 } } } });
    await page.init();
    button(page.root, 'New entry').click();
    await flush();
    setValue(field(page.root, 'canonical'), 'term alpha beta');
    setValue(field(page.root, 'variants'), 'termalpha\nalpha beta');
    button(page.root, 'Save entry').click();
    await flush();
    const call = page.of('create')[0]!;
    expect(call.body).toMatchObject({ layer: 'shared', expected_version: 7, canonical: 'term alpha beta', variants: ['termalpha', 'alpha beta'], kind: 'synonym', language: 'any' });
    expect(page.root.textContent).toContain('This dictionary changed since you loaded it');
    expect(button(page.root, 'Reload')).toBeTruthy();
    expect((field(page.root, 'canonical') as FakeElement).value).toBe('term alpha beta');
  });

  it('a translation pair shows source and target selects from enabled_languages, sends one_way and its source as language', async () => {
    const page = loadPage();
    await page.init();
    button(page.root, 'New entry').click();
    await flush();
    setValue(field(page.root, 'kind'), 'translation');
    await flush();
    expect(page.root.querySelector('[data-terminology-field="language"]')).toBeNull();
    expect(optionValues(field(page.root, 'source_language')).filter(Boolean)).toEqual(ENABLED);
    expect(optionValues(field(page.root, 'target_language')).filter(Boolean)).toEqual(ENABLED);
    expect(page.root.querySelector('[data-terminology-field="mode"]')).toBeNull();
    setValue(field(page.root, 'canonical'), 'term alpha beta');
    setValue(field(page.root, 'variants'), '术语甲乙丙');
    setValue(field(page.root, 'source_language'), 'zh');
    setValue(field(page.root, 'target_language'), 'en');
    button(page.root, 'Save entry').click();
    await flush();
    expect(page.of('create')[0]!.body).toMatchObject({ kind: 'translation', mode: 'one_way', language: 'zh', source_language: 'zh', target_language: 'en' });
  });

  it('a 422 renders invalid_language and invalid_translation next to their fields', async () => {
    const page = loadPage({
      replies: {
        create: {
          status: 422,
          body: {
            success: false,
            error: 'Validation failed',
            issues: [
              { code: 'invalid_language', severity: 'error', message: 'Language code is not enabled.', row: null },
              { code: 'invalid_translation', severity: 'error', message: 'Source and target must differ.', row: null },
            ],
          },
        },
      },
    });
    await page.init();
    button(page.root, 'New entry').click();
    await flush();
    setValue(field(page.root, 'kind'), 'translation');
    await flush();
    setValue(field(page.root, 'canonical'), 'term alpha beta');
    setValue(field(page.root, 'variants'), 'termalpha');
    setValue(field(page.root, 'source_language'), 'en');
    setValue(field(page.root, 'target_language'), 'zh');
    button(page.root, 'Save entry').click();
    await flush();
    expect((page.root.querySelector('[data-terminology-issues="source_language"]') as FakeElement).textContent).toContain('Language code is not enabled.');
    expect((page.root.querySelector('[data-terminology-issues="target_language"]') as FakeElement).textContent).toContain('Source and target must differ.');
  });

  it('refuses a variant with | before any request', async () => {
    const page = loadPage();
    await page.init();
    button(page.root, 'New entry').click();
    await flush();
    setValue(field(page.root, 'canonical'), 'term alpha beta');
    setValue(field(page.root, 'variants'), 'alpha|beta');
    button(page.root, 'Save entry').click();
    await flush();
    expect(page.of('create')).toHaveLength(0);
    expect((page.root.querySelector('[data-terminology-issues="variants"]') as FakeElement).textContent).not.toBe('');
  });

  it('a 401 on load shows the sign-in message', async () => {
    const page = loadPage({ replies: { versions: { status: 401, body: { success: false, error: 'Unauthorized' } } } });
    await page.init();
    expect(page.root.textContent).toContain('Admin sign-in required');
  });

  it('import: dry run shows the report, apply sends the version the dry run saw', async () => {
    const page = loadPage({
      replies: {
        import: (call) =>
          (call.body as Json).dry_run
            ? { status: 200, body: { success: true, report: { applied: false, create: 1, update: 0, unchanged: 0, delete: 0, issues: [], layer_version_seen: 11 } } }
            : { status: 200, body: { success: true, report: { applied: true, create: 1, update: 0, unchanged: 0, delete: 0, issues: [], layer_version_seen: 11 }, layer_version: 12 } },
      },
    });
    await page.init();
    button(page.root, 'Import and export').click();
    await flush();
    const input = page.root.querySelector('input[type="file"]') as FakeElement & { files?: unknown[] };
    const csv = 'canonical,variants,language,kind,mode,enabled,note,source_language,target_language\nterm alpha beta,termalpha,any,synonym,one_way,true,,,\n';
    input.files = [{ name: 'dictionary.csv', size: csv.length, text: async () => csv }];
    input.dispatch('change');
    await flush();
    button(page.root, 'Check file').click();
    await flush();
    expect(page.of('import')[0]!.body).toMatchObject({ layer: 'shared', mode: 'merge', format: 'csv', csv, dry_run: true });
    expect(page.root.textContent).toContain('To create');
    button(page.root, 'Apply import').click();
    await flush();
    expect(page.of('import')[1]!.body).toMatchObject({ dry_run: false, expected_version: 11 });
  });

  it('preview sends the query and lists matches and added tokens', async () => {
    const page = loadPage({
      replies: {
        preview: {
          status: 200,
          body: {
            success: true,
            capped: false,
            expansion_tokens: ['term', 'beta'],
            issues: [],
            matches: [{ canonical: 'term alpha beta', end: 9, entry_id: ENTRY_ID, kind: 'synonym', language: 'en', layer: 'shared', start: 0, surface: 'termalpha' }],
            original_tokens: ['termalpha'],
            overrides: [],
            version: 's7',
          },
        },
      },
    });
    await page.init();
    button(page.root, 'Preview').click();
    await flush();
    setValue(field(page.root, 'preview_query'), 'termalpha');
    const run = page.root.querySelectorAll('button').filter((b) => b.textContent.trim() === 'Preview').at(-1)!;
    run.click();
    await flush();
    expect(page.of('preview')[0]!.body).toMatchObject({ layer: 'shared', query: 'termalpha' });
    expect(page.root.textContent).toContain('termalpha');
    expect(page.root.textContent).toContain('beta');
  });

  it('candidate accept opens the form with the term as a variant and accepts it with the new entry id after saving', async () => {
    const page = loadPage({
      replies: {
        candidates: {
          status: 200,
          body: { success: true, items: [{ id: CANDIDATE_ID, term: 'termalpha', language: 'en', support: 4, examples: ['where is termalpha'], corpus_df: 0, status: 'pending', source: 'miss_log', entry_id: null, first_seen: null, last_seen: null }], limit: 25, offset: 0, next_offset: null },
        },
      },
    });
    await page.init();
    button(page.root, 'Candidates').click();
    await flush();
    button(page.root, 'Add to dictionary').click();
    await flush();
    expect(field(page.root, 'variants').value).toBe('termalpha');
    setValue(field(page.root, 'canonical'), 'term alpha beta');
    button(page.root, 'Save entry').click();
    await flush();
    const decide = page.of('decide')[0]!;
    expect(decide.path).toContain(CANDIDATE_ID);
    expect(decide.body).toEqual({ action: 'accept', entry_id: NEW_ID });
  });
});

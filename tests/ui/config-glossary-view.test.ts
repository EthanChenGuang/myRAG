import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, type FakeEvent } from './helpers/html-fake-dom';
import { markedBlock } from './helpers/ingest-impact-harness';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const viewSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/glossary.js'), 'utf8');
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/terminology.js'), 'utf8');

type Json = Record<string, unknown>;

const XSS = '<img src=x onerror=alert(1)>';
const JS_URL = 'javascript:alert(1)';
const ORG = 'c0000000-0000-4000-8000-000000000001';
const PAIR_ID = 'e0000000-0000-4000-8000-000000000011';
const LEGACY_ID = 'e0000000-0000-4000-8000-000000000012';
const ENABLED = ['zh', 'en', 'it'];
const BASE = '/api/rag/admin/terminology';

function pair(extra: Json = {}): Json {
  return {
    id: PAIR_ID,
    layer_key: 'shared',
    canonical: 'term alpha',
    variants: ['术语甲乙', '术语丙丁'],
    language: 'zh',
    kind: 'translation',
    mode: 'one_way',
    source_language: 'zh',
    target_language: 'en',
    enabled: true,
    note: null,
    suppresses_entry_id: null,
    normalized_variants: ['hidden normalized'],
    created_at: '2026-11-20T09:30:00.000Z',
    updated_at: '2026-11-20T09:30:00.000Z',
    ...extra,
  };
}

function listAnswer(items: Json[] = [pair()], extra: Json = {}): Json {
  return { success: true, layer: 'shared', layer_version: 7, entries_sha256: 'a'.repeat(64), enabled_languages: ENABLED, items, total: items.length, limit: 25, offset: 0, ...extra };
}

interface Call {
  key: string;
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}
interface Reply {
  status?: number;
  body?: unknown;
  thrown?: boolean;
}
type Replies = Record<string, Reply | ((call: Call) => Reply)>;

function routeKey(p: string, method: string, query: URLSearchParams): string {
  const rest = p.slice(BASE.length).replace(/^\//, '');
  if (rest === '') return method === 'GET' ? (query.get('kind') === 'translation' ? 'glossary' : 'list') : method === 'POST' ? 'create' : 'unknown';
  if (['versions', 'audit', 'preview', 'import', 'suppressions', 'candidates'].includes(rest)) return rest;
  if (method === 'PATCH') return 'patch';
  if (method === 'DELETE') return 'delete';
  return 'unknown';
}

interface PageOptions {
  multiTenant?: boolean;
  locale?: string;
  replies?: Replies;
  glossary?: Json;
  glossarySwitch?: boolean | null;
}

function loadPage(options: PageOptions = {}) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const configWrites: Array<[string, unknown]> = [];
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
  selector.value = options.multiTenant ? ORG : '';
  doc.body.appendChild(selector);
  const modesLink = doc.createElement('a');
  modesLink.setAttribute('data-tab', 'rag-modes');
  modesLink.className = 'menu-item';
  let modesClicks = 0;
  modesLink.addEventListener('click', () => {
    modesClicks += 1;
  });
  doc.body.appendChild(modesLink);
  if (options.glossarySwitch !== null) {
    const card = doc.createElement('div');
    card.id = 'query-layer-card';
    const box = doc.createElement('input');
    box.id = 'RAG_TRANSLATION_GLOSSARY';
    box.setAttribute('type', 'checkbox');
    box.checked = options.glossarySwitch !== false;
    card.appendChild(box);
    doc.body.appendChild(card);
  }
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-terminology');
  doc.innerHtmlWrites = 0;
  // The page-wide writer of index.html: every bubbling change of a field with an id becomes a config key.
  doc.addEventListener('change', (event: FakeEvent) => {
    const target = event.target as FakeElement;
    if (target && target.id) configWrites.push([target.id, target.value]);
  });

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : init.body;
    const p = apiPath.split('?')[0]!;
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const key = p.startsWith(BASE) ? routeKey(p, method, query) : 'unknown';
    const call: Call = { key, path: apiPath, method, query, body };
    calls.push(call);
    if (key === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const defaults: Record<string, Reply> = {
      versions: { status: 200, body: { success: true, shared: { version: 7, entries_sha256: 'a'.repeat(64) }, workspace: options.multiTenant ? { version: 3, entries_sha256: 'b'.repeat(64) } : null, enabled_languages: ENABLED } },
      list: { status: 200, body: listAnswer([]) },
      glossary: { status: 200, body: options.glossary ?? listAnswer() },
      create: { status: 201, body: { success: true, entry_id: PAIR_ID, layer_version: 8, entries_sha256: 'c'.repeat(64), warnings: [] } },
      patch: { status: 200, body: { success: true, entry_id: PAIR_ID, layer_version: 8, entries_sha256: 'c'.repeat(64), warnings: [] } },
      delete: { status: 200, body: { success: true, layer_version: 8, entries_sha256: 'c'.repeat(64) } },
      audit: { status: 200, body: { success: true, layer: 'shared', items: [], total: 0, limit: 20, offset: 0 } },
      candidates: { status: 200, body: { success: true, items: [], limit: 25, offset: 0, next_offset: null } },
      import: { status: 200, body: { success: true, report: { applied: false, create: 1, update: 0, unchanged: 0, delete: 2, issues: [], layer_version_seen: 7 } } },
    };
    const custom = options.replies?.[key];
    const reply = typeof custom === 'function' ? custom(call) : (custom ?? defaults[key]!);
    if (reply.thrown) throw new TypeError('network');
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, body: reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body)) };
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
    configManager: {
      updateConfig(key: string, value: unknown) {
        configWrites.push([key, value]);
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/terminology.js', 'rag-panels/glossary.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-terminology') as FakeElement;
  const page = {
    doc,
    root,
    calls,
    context,
    configWrites,
    modesClicks: () => modesClicks,
    of: (key: string) => calls.filter((c) => c.key === key),
    status: () => doc.querySelector('[data-terminology-status]') as FakeElement,
    glossaryTab: () => root.querySelectorAll('[role="tab"]').find((b) => b.textContent.trim() === glossaryWord(options.locale)) as FakeElement,
    view: () => doc.querySelector('[data-glossary-view]') as FakeElement,
    dialog: () => doc.body.querySelector('dialog[data-glossary-dialog]') as FakeElement | null,
    async open() {
      const init = context.initTerminologyPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initTerminologyPanel is not defined');
      await init();
      await flush();
      const tabButton = page.glossaryTab();
      expect(tabButton, 'Glossary tab').toBeTruthy();
      tabButton.click();
      await flush();
    },
  };
  return page;
}

function glossaryWord(locale?: string): string {
  if (locale && locale.startsWith('zh')) return '术语对照表';
  if (locale && locale.startsWith('it')) return 'Glossario';
  return 'Glossary';
}

async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function buttons(root: FakeElement, text: string): FakeElement[] {
  return root.querySelectorAll('button').filter((b) => b.textContent.trim() === text);
}

function button(root: FakeElement, text: string): FakeElement {
  const found = buttons(root, text)[0];
  expect(found, 'button ' + text).toBeTruthy();
  return found as FakeElement;
}

function field(dialog: FakeElement, name: string): FakeElement {
  const found = dialog.querySelector(`[data-glossary-field="${name}"]`);
  expect(found, 'field ' + name).toBeTruthy();
  return found as FakeElement;
}

function setValue(el: FakeElement, value: string) {
  el.value = value;
  el.dispatch('input');
  bubble(el, 'change');
}

/** Dispatches an event that bubbles through the fake tree to the document, honouring stopPropagation. */
function bubble(el: FakeElement, type: string) {
  let stopped = false;
  const event: FakeEvent = {
    type,
    target: el,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
  };
  let current: FakeElement | null = el;
  while (current && !stopped) {
    event.currentTarget = current;
    for (const fn of [...(current.listeners.get(type) ?? [])]) fn(event);
    current = current.parentNode;
  }
  if (!stopped) for (const fn of [...(el.doc.listeners.get(type) ?? [])]) fn(event);
}

function key(el: FakeElement, k: string, extra: Json = {}) {
  return el.dispatch('keydown', { key: k, ...extra });
}

function noMarkup(doc: FakeDocument) {
  expect(doc.innerHtmlWrites).toBe(0);
  expect(doc.body.querySelectorAll('img')).toHaveLength(0);
  expect(doc.body.querySelectorAll('script')).toHaveLength(0);
  expect(doc.body.querySelectorAll('a').filter((a) => a.getAttribute('data-tab') !== 'rag-modes')).toHaveLength(0);
  for (const el of doc.body.querySelectorAll('*')) {
    for (const [name, value] of el.attributes.entries()) {
      expect(name.startsWith('on')).toBe(false);
      expect(value.toLowerCase()).not.toContain('javascript:');
    }
  }
}

describe('files and source rules', () => {
  it('loads glossary.js once, after terminology.js, and the panel calls initGlossaryView', () => {
    expect(indexHtml.split('rag-panels/glossary.js').length - 1).toBe(1);
    expect(indexHtml.indexOf('<script src="rag-panels/glossary.js"></script>')).toBeGreaterThan(indexHtml.indexOf('<script src="rag-panels/terminology.js"></script>'));
    expect(panelSource).toContain('initGlossaryView');
  });

  it('writes no markup, keeps the Glossary prefix and renders no hidden fields', () => {
    expect(viewSource).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    expect(viewSource).not.toMatch(/normalized_variants|entries_sha256/);
    expect(viewSource).toContain('stopPropagation');
    const tops = viewSource.match(/^(?:const|let|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm) ?? [];
    expect(tops.length).toBeGreaterThan(5);
    for (const decl of tops) expect(decl.replace(/^(?:const|let|class|async function|function)\s+/, '')).toMatch(/^(glossary|Glossary|GLOSSARY_)/);
  });

  it('has the same label keys in en, zh and it', () => {
    const labels = (loadPage().context.GLOSSARY_LABELS ?? {}) as Record<string, Record<string, string>>;
    const en = Object.keys(labels.en ?? {}).sort();
    expect(en.length).toBeGreaterThan(60);
    expect(Object.keys(labels.zh ?? {}).sort()).toEqual(en);
    expect(Object.keys(labels.it ?? {}).sort()).toEqual(en);
  });
});

describe('Glossary tab and list', () => {
  it('adds one Glossary tab right after the entry list with roving tabindex and arrow keys', async () => {
    const page = loadPage();
    await page.open();
    const tabs = page.root.querySelectorAll('[role="tab"]');
    const names = tabs.map((t) => t.textContent.trim());
    expect(names.filter((n) => n === 'Glossary')).toHaveLength(1);
    expect(names.indexOf('Glossary')).toBe(1);
    const glossary = page.glossaryTab();
    expect(glossary.getAttribute('aria-selected')).toBe('true');
    expect(glossary.getAttribute('tabindex')).toBe('0');
    const panel = page.doc.getElementById(glossary.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.querySelector('[data-glossary-view]')).toBeTruthy();
    key(glossary, 'ArrowLeft');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    key(tabs[0]!, 'ArrowRight');
    expect(page.glossaryTab().getAttribute('aria-selected')).toBe('true');
  });

  it('lists translation entries only, with the layer and organization, and shows terms, languages and state', async () => {
    const page = loadPage({ multiTenant: true });
    await page.open();
    const call = page.of('glossary').at(-1)!;
    expect(call.query.get('kind')).toBe('translation');
    expect(call.query.get('layer')).toBe('shared');
    expect(call.query.get('organization_id')).toBe(ORG);
    const view = page.view();
    const row = view.querySelector('tbody tr')!;
    const head = row.querySelector('th')!;
    expect(head.getAttribute('scope')).toBe('row');
    const term = head.querySelector('[lang="zh"]')!;
    expect(term.textContent).toBe('术语甲乙');
    expect(term.getAttribute('translate')).toBe('no');
    expect(head.textContent).toContain('Other forms: 1');
    expect(head.textContent).toContain('(zh)');
    const translation = row.querySelector('[lang="en"]')!;
    expect(translation.textContent).toBe('term alpha');
    expect(row.textContent).toContain('English (en)');
    expect(row.textContent).toContain('In use');
    expect(row.textContent).not.toContain('hidden normalized');
    expect(view.textContent).toContain('Entries: 1');
    expect(page.status().textContent).toContain('Glossary loaded. Entries: 1.');
    expect(view.querySelector('caption')!.textContent).toContain('Glossary entries');
    const region = view.querySelector('[role="region"]')!;
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(button(view, 'Edit entry').getAttribute('aria-label')).toBe('Edit entry: 术语甲乙');
  });

  it('marks a row without a target as Incomplete with Set target language and never guesses a target', async () => {
    const legacy = pair({ id: LEGACY_ID, target_language: null, canonical: 'term gamma', variants: ['termine delta'], language: 'it', source_language: 'it' });
    const unsupported = pair({ id: 'e0000000-0000-4000-8000-000000000013', target_language: 'fr' });
    const off = pair({ id: 'e0000000-0000-4000-8000-000000000014', enabled: false });
    const page = loadPage({ glossary: listAnswer([legacy, unsupported, off]) });
    await page.open();
    const rows = page.view().querySelectorAll('tbody tr');
    expect(rows[0]!.textContent).toContain('Incomplete');
    expect(rows[0]!.textContent).toContain('No target language, so this entry is not enforced.');
    expect(rows[0]!.textContent).toContain('None');
    expect(buttons(rows[0]!, 'Edit entry')).toHaveLength(0);
    expect(button(rows[0]!, 'Set target language').getAttribute('aria-label')).toBe('Set target language: termine delta');
    expect(rows[1]!.textContent).toContain('Incomplete');
    expect(rows[1]!.textContent).toMatch(/\(fr\) is not a supported language now/);
    expect(rows[2]!.textContent).toContain('Turned off');
    button(rows[0]!, 'Set target language').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.open).toBe(true);
    expect(field(dialog, 'target_language').value).toBe('');
    expect(field(dialog, 'canonical').value).toBe('term gamma');
    expect(page.doc.activeElement).toBe(field(dialog, 'target_language'));
  });

  it('shows invisible characters as code points in the table only', async () => {
    const page = loadPage({ glossary: listAnswer([pair({ variants: ['term​mark'] })]) });
    await page.open();
    expect(page.view().querySelector('tbody th')!.textContent).toContain('term[U+200B]mark');
    button(page.view(), 'Edit entry').click();
    await flush();
    expect(field(page.dialog()!, 'variants').value).toBe('term​mark');
  });

  it('filters by source and target language and searches on Enter', async () => {
    const page = loadPage();
    await page.open();
    const view = page.view();
    const from = view.querySelector('#rag-glossary-filter-from')!;
    expect(from.querySelectorAll('option').map((o) => o.getAttribute('value'))).toEqual(['', ...ENABLED]);
    expect(from.querySelectorAll('option')[0]!.textContent).toBe('Any language');
    setValue(from, 'zh');
    await flush();
    expect(page.of('glossary').at(-1)!.query.get('source_language')).toBe('zh');
    setValue(view.querySelector('#rag-glossary-filter-to')!, 'en');
    await flush();
    expect(page.of('glossary').at(-1)!.query.get('target_language')).toBe('en');
    const search = view.querySelector('#rag-glossary-search')!;
    search.value = 'alpha';
    search.dispatch('input');
    key(search, 'Enter');
    await flush();
    const last = page.of('glossary').at(-1)!;
    expect(last.query.get('search')).toBe('alpha');
    expect(last.query.get('source_language')).toBe('zh');
  });

  it('empty: names both ways to add; filtered: Clear filters resets and reloads', async () => {
    const page = loadPage({ glossary: listAnswer([]) });
    await page.open();
    const view = page.view();
    expect(view.textContent).toContain('No glossary entries');
    expect(view.textContent).toContain('Select Add glossary entry, or import a CSV file.');
    setValue(view.querySelector('#rag-glossary-filter-from')!, 'it');
    await flush();
    expect(view.textContent).toContain('No entry matches these filters.');
    button(view, 'Clear filters').click();
    await flush();
    const last = page.of('glossary').at(-1)!;
    expect(last.query.get('source_language')).toBeNull();
    expect((view.querySelector('#rag-glossary-filter-from') as FakeElement).value).toBe('');
    expect(view.textContent).toContain('No glossary entries');
  });

  it('one supported language: note.monolingual and no add or import action', async () => {
    const page = loadPage({ glossary: listAnswer([pair()], { enabled_languages: ['en'] }) });
    await page.open();
    const view = page.view();
    expect(view.textContent).toContain('One language is supported, so there is nothing to translate between.');
    expect(buttons(view, 'Add glossary entry')).toHaveLength(0);
    expect(buttons(view, 'Import glossary CSV')).toHaveLength(0);
    expect(view.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('switch note reads the page checkbox, makes no request and opens the query layer settings', async () => {
    const off = loadPage({ glossarySwitch: false });
    await off.open();
    expect(off.view().textContent).toContain('The glossary is not enforced');
    const before = off.calls.length;
    button(off.view(), 'Open query layer settings').click();
    expect(off.calls.length).toBe(before);
    expect(off.modesClicks()).toBe(1);
    expect(off.doc.activeElement && off.doc.activeElement.id).toBe('RAG_TRANSLATION_GLOSSARY');
    expect(buttons(off.view(), 'Add glossary entry')).toHaveLength(1);
    const on = loadPage({ glossarySwitch: true });
    await on.open();
    expect(on.view().textContent).not.toContain('The glossary is not enforced');
  });

  it('zh locale: localized tab, counts as label: number', async () => {
    const page = loadPage({ locale: 'zh-CN' });
    await page.open();
    expect(page.view().getAttribute('lang')).toBe('zh');
    expect(page.view().textContent).toContain('条目：1');
    expect(page.view().textContent).toContain('使用中');
  });
});

describe('entry form', () => {
  it('untouched submit: Save stays enabled, three fields marked, focus on the first, no request', async () => {
    const page = loadPage();
    await page.open();
    button(page.view(), 'Add glossary entry').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelectorAll('fieldset')).toHaveLength(2);
    expect(dialog.querySelectorAll('legend').map((l) => l.textContent)).toEqual(['Source', 'Translation']);
    expect(page.doc.activeElement).toBe(field(dialog, 'source_language'));
    const save = button(dialog, 'Save entry');
    expect(save.disabled).toBe(false);
    const writes = page.calls.length;
    save.click();
    await flush();
    expect(page.calls.length).toBe(writes);
    for (const name of ['variants', 'target_language', 'canonical']) expect(field(dialog, name).getAttribute('aria-invalid')).toBe('true');
    expect(field(dialog, 'source_language').getAttribute('aria-invalid')).toBeNull();
    expect(dialog.textContent).toContain('Enter at least one source term.');
    expect(dialog.textContent).toContain('Choose a target language.');
    expect(dialog.textContent).toContain('Enter the required translation.');
    expect(page.doc.activeElement).toBe(field(dialog, 'variants'));
    const described = field(dialog, 'variants').getAttribute('aria-describedby')!.split(' ');
    expect(described.some((id) => (page.doc.getElementById(id)?.textContent ?? '').includes('Enter at least one source term.'))).toBe(true);
  });

  it('offers only enabled languages and disables the source language as target', async () => {
    const page = loadPage();
    await page.open();
    button(page.view(), 'Add glossary entry').click();
    await flush();
    const dialog = page.dialog()!;
    const source = field(dialog, 'source_language');
    const target = field(dialog, 'target_language');
    expect(source.querySelectorAll('option').map((o) => o.getAttribute('value')).filter(Boolean)).toEqual(ENABLED);
    setValue(source, 'en');
    setValue(target, 'it');
    const disabled = target.querySelectorAll('option').filter((o) => o.disabled || o.getAttribute('disabled') !== null).map((o) => o.getAttribute('value'));
    expect(disabled).toEqual(['en']);
    setValue(source, 'it');
    expect(field(dialog, 'target_language').value).toBe('');
    expect(field(dialog, 'variants').getAttribute('lang')).toBe('it');
  });

  it('length limits: too many terms and too-long translation are messages, not maxlength', async () => {
    const page = loadPage();
    await page.open();
    button(page.view(), 'Add glossary entry').click();
    await flush();
    const dialog = page.dialog()!;
    expect(field(dialog, 'canonical').getAttribute('maxlength')).toBeNull();
    setValue(field(dialog, 'variants'), Array.from({ length: 17 }, (_, i) => 'term' + i).join('\n'));
    setValue(field(dialog, 'target_language'), 'en');
    setValue(field(dialog, 'canonical'), 'x'.repeat(65));
    button(dialog, 'Save entry').click();
    await flush();
    expect(dialog.textContent).toContain('Up to 16 source terms. This entry has 17.');
    expect(dialog.textContent).toContain('Up to 64 characters. This has 65.');
  });

  it('saves a pair with kind translation, one_way, the layer version and the organization; announces and closes', async () => {
    const page = loadPage({ multiTenant: true });
    await page.open();
    const opener = button(page.view(), 'Add glossary entry');
    opener.click();
    await flush();
    const dialog = page.dialog()!;
    setValue(field(dialog, 'source_language'), 'zh');
    setValue(field(dialog, 'variants'), '术语甲乙\n术语丙丁');
    setValue(field(dialog, 'target_language'), 'en');
    setValue(field(dialog, 'canonical'), 'term alpha');
    button(dialog, 'Save entry').click();
    await flush();
    const create = page.of('create').at(-1)!;
    expect(create.body).toMatchObject({
      kind: 'translation',
      mode: 'one_way',
      language: 'zh',
      source_language: 'zh',
      target_language: 'en',
      canonical: 'term alpha',
      variants: ['术语甲乙', '术语丙丁'],
      enabled: true,
      note: null,
      layer: 'shared',
      expected_version: 7,
      organization_id: ORG,
    });
    expect(page.dialog()).toBeNull();
    expect(page.status().textContent).toBe('Saved: 术语甲乙.');
    expect(page.doc.activeElement).toBe(opener);
  });

  it('edit: PATCH by id, focus on Required translation, Enter saves, override warning announced', async () => {
    const page = loadPage({ replies: { patch: { status: 200, body: { success: true, entry_id: PAIR_ID, layer_version: 8, warnings: [{ code: 'override', severity: 'warning', message: 'm', row: null }] } } } });
    await page.open();
    button(page.view(), 'Edit entry').click();
    await flush();
    const dialog = page.dialog()!;
    const canonical = field(dialog, 'canonical');
    expect(page.doc.activeElement).toBe(canonical);
    expect(canonical.getAttribute('lang')).toBe('en');
    setValue(canonical, 'term beta');
    key(canonical, 'Enter');
    await flush();
    const patch = page.of('patch').at(-1)!;
    expect(patch.path).toContain('/' + PAIR_ID);
    expect(patch.body).toMatchObject({ canonical: 'term beta', target_language: 'en', expected_version: 7 });
    expect(page.status().textContent).toContain('This workspace entry replaces a shared entry for 术语甲乙.');
  });

  it('422: issue codes at their fields, an unknown code in font-mono in the alert', async () => {
    const issues = [
      { code: 'target_language_not_enabled', severity: 'error', message: 'x', row: null },
      { code: 'conflict', severity: 'error', message: 'y', row: null },
      { code: 'novel_code', severity: 'error', message: 'z', row: null },
    ];
    const page = loadPage({ replies: { patch: { status: 422, body: { success: false, error: 'validation_failed', issues } } } });
    await page.open();
    button(page.view(), 'Edit entry').click();
    await flush();
    const dialog = page.dialog()!;
    button(dialog, 'Save entry').click();
    await flush();
    expect(field(dialog, 'target_language').getAttribute('aria-invalid')).toBe('true');
    expect(field(dialog, 'variants').getAttribute('aria-invalid')).toBe('true');
    expect(dialog.textContent).toContain('English (en) is not a supported language.');
    expect(dialog.textContent).toContain('术语甲乙 already has a different required translation into English (en) in this layer.');
    const code = dialog.querySelectorAll('code').find((c) => c.textContent === 'novel_code')!;
    expect(code).toBeTruthy();
    expect(code.className).toContain('font-mono');
    expect(code.closest('.alert')!.textContent).toContain('The entry was not accepted. Code: novel_code');
    expect(page.dialog()!.open).toBe(true);
  });

  it('400 target codes from the validator map at Target language', async () => {
    const page = loadPage({ replies: { patch: { status: 400, body: { success: false, error: 'target_language_same' } } } });
    await page.open();
    button(page.view(), 'Edit entry').click();
    await flush();
    const dialog = page.dialog()!;
    button(dialog, 'Save entry').click();
    await flush();
    expect(field(dialog, 'target_language').getAttribute('aria-invalid')).toBe('true');
    expect(dialog.textContent).toContain('Choose a target language different from the source language.');
  });

  it('409: version conflict alert with Reload entries keeps every typed value; 413 layer full', async () => {
    let n = 0;
    let loads = 0;
    const page = loadPage({
      replies: {
        create: () => (n++ === 0 ? { status: 409, body: { success: false, error: 'version_conflict', current_version: 9 } } : { status: 413, body: { success: false, error: 'limit' } }),
        glossary: () => ({ status: 200, body: listAnswer([pair()], { layer_version: loads++ === 0 ? 7 : 9 }) }),
      },
    });
    await page.open();
    button(page.view(), 'Add glossary entry').click();
    await flush();
    const dialog = page.dialog()!;
    setValue(field(dialog, 'variants'), 'term one');
    setValue(field(dialog, 'target_language'), 'en');
    setValue(field(dialog, 'canonical'), 'term two');
    button(dialog, 'Save entry').click();
    await flush();
    const alert = dialog.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('This dictionary changed since you loaded it.');
    expect(field(dialog, 'canonical').value).toBe('term two');
    const before = page.of('glossary').length;
    button(dialog, 'Reload entries').click();
    await flush();
    expect(page.of('glossary').length).toBe(before + 1);
    expect(field(page.dialog()!, 'variants').value).toBe('term one');
    button(page.dialog()!, 'Save entry').click();
    await flush();
    expect(page.of('create').at(-1)!.body).toMatchObject({ expected_version: 9 });
    expect(page.dialog()!.textContent).toContain('This dictionary layer has reached its entry limit.');
  });

  it('timeout on save: outcome unknown, then reload; 404: changed, then reload', async () => {
    const thrown = loadPage({ replies: { create: { thrown: true } } });
    await thrown.open();
    button(thrown.view(), 'Add glossary entry').click();
    await flush();
    let dialog = thrown.dialog()!;
    setValue(field(dialog, 'variants'), 'term one');
    setValue(field(dialog, 'target_language'), 'en');
    setValue(field(dialog, 'canonical'), 'term two');
    const loads = thrown.of('glossary').length;
    button(dialog, 'Save entry').click();
    await flush();
    expect(thrown.status().textContent).toContain('The server did not answer, so the change may or may not have been made.');
    expect(thrown.of('glossary').length).toBeGreaterThan(loads);

    const gone = loadPage({ replies: { patch: { status: 404, body: { success: false, error: 'not_found' } } } });
    await gone.open();
    button(gone.view(), 'Edit entry').click();
    await flush();
    dialog = gone.dialog()!;
    const before = gone.of('glossary').length;
    button(dialog, 'Save entry').click();
    await flush();
    expect(gone.status().textContent).toContain('This item was changed by someone else.');
    expect(gone.of('glossary').length).toBeGreaterThan(before);
    expect(gone.dialog()).toBeNull();
  });

  it('while saving: spinner and Saving… on Save entry, Close form disabled, Escape does nothing', async () => {
    let release: (() => void) | null = null;
    const page = loadPage();
    await page.open();
    (page.context as { ragFetch: unknown }).ragFetch = ((original) => async (p: string, init: Json) => {
      if (init && init.method === 'PATCH') await new Promise<void>((resolve) => (release = resolve));
      return (original as (p: string, i: Json) => Promise<unknown>)(p, init);
    })((page.context as { ragFetch: unknown }).ragFetch);
    button(page.view(), 'Edit entry').click();
    await flush();
    const dialog = page.dialog()!;
    const save = button(dialog, 'Save entry');
    save.click();
    await flush(5);
    expect(save.textContent).toContain('Saving…');
    expect(save.querySelector('.loading')).toBeTruthy();
    expect(button(dialog, 'Close form').disabled).toBe(true);
    const cancel = dialog.dispatch('cancel');
    expect(cancel.defaultPrevented).toBe(true);
    expect(page.dialog()!.open).toBe(true);
    release!();
    await flush();
    expect(page.dialog()).toBeNull();
  });

  it('closing with typed changes asks in the footer; Keep editing keeps the values', async () => {
    const page = loadPage();
    await page.open();
    button(page.view(), 'Add glossary entry').click();
    await flush();
    const dialog = page.dialog()!;
    setValue(field(dialog, 'canonical'), 'term two');
    dialog.dispatch('cancel');
    expect(dialog.textContent).toContain('Discard what you typed?');
    expect(page.doc.activeElement).toBe(button(dialog, 'Keep editing'));
    button(dialog, 'Keep editing').click();
    expect(field(dialog, 'canonical').value).toBe('term two');
    button(dialog, 'Close form').click();
    button(dialog, 'Discard changes').click();
    expect(page.dialog()).toBeNull();
  });
});

describe('delete', () => {
  it('confirms with Keep entry focused, sends the expected version, announces and reloads', async () => {
    const page = loadPage();
    await page.open();
    button(page.view(), 'Delete entry').click();
    await flush();
    const confirm = page.doc.body.querySelectorAll('dialog').find((d) => d.textContent.includes('Delete the glossary entry for 术语甲乙?'))!;
    expect(confirm).toBeTruthy();
    expect(page.doc.activeElement).toBe(button(confirm, 'Keep entry'));
    const before = page.of('glossary').length;
    button(confirm, 'Delete entry').click();
    await flush();
    const del = page.of('delete').at(-1)!;
    expect(del.path).toContain('/' + PAIR_ID);
    expect(del.query.get('expected_version')).toBe('7');
    expect(page.status().textContent).toBe('Deleted: 术语甲乙.');
    expect(page.of('glossary').length).toBeGreaterThan(before);
  });

  it('409 keeps the dialog open with the conflict sentence; a timeout reports outcome unknown', async () => {
    const conflict = loadPage({ replies: { delete: { status: 409, body: { success: false, error: 'version_conflict' } } } });
    await conflict.open();
    button(conflict.view(), 'Delete entry').click();
    await flush();
    let dialog = conflict.doc.body.querySelectorAll('dialog').find((d) => d.open)!;
    button(dialog, 'Delete entry').click();
    await flush();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('This dictionary changed since you loaded it.');

    const thrown = loadPage({ replies: { delete: { thrown: true } } });
    await thrown.open();
    button(thrown.view(), 'Delete entry').click();
    await flush();
    dialog = thrown.doc.body.querySelectorAll('dialog').find((d) => d.open)!;
    button(dialog, 'Delete entry').click();
    await flush();
    expect(thrown.status().textContent).toContain('The server did not answer');
  });
});

describe('load errors', () => {
  it('401: data blocks replaced by the sign-in sentence and Reload panel', async () => {
    const page = loadPage({ replies: { glossary: { status: 401, body: { error: 'Unauthorized' } } } });
    await page.open();
    const view = page.view();
    expect(view.querySelector('table')).toBeNull();
    expect(buttons(view, 'Add glossary entry')).toHaveLength(0);
    expect(button(view, 'Reload panel')).toBeTruthy();
    expect(view.querySelector('.alert-warning')).toBeTruthy();
    expect(view.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('503 after content: unavailable sentence, earlier content stays dimmed; refresh uses aria-busy', async () => {
    let fail = false;
    const page = loadPage({ replies: { glossary: () => (fail ? { status: 503, body: { error: 'Admin verification is unavailable' } } : { status: 200, body: listAnswer() }) } });
    await page.open();
    fail = true;
    button(page.view(), 'Delete entry');
    setValue(page.view().querySelector('#rag-glossary-filter-from')!, 'zh');
    await flush();
    const view = page.view();
    expect(view.textContent).toContain('The glossary is unavailable right now.');
    expect(view.querySelector('table')).toBeTruthy();
    expect(view.querySelector('[data-glossary-results]')!.className).toContain('opacity-60');
    expect(button(view, 'Reload panel')).toBeTruthy();
  });

  it('first load shows the loading spinner text', async () => {
    let release: (() => void) | null = null;
    const page = loadPage({});
    const init = page.context.initTerminologyPanel as () => Promise<void>;
    await init();
    await flush();
    (page.context as { ragFetch: unknown }).ragFetch = ((original) => async (p: string, i: Json) => {
      if (p.includes('kind=translation')) await new Promise<void>((resolve) => (release = resolve));
      return (original as (p: string, i: Json) => Promise<unknown>)(p, i);
    })((page.context as { ragFetch: unknown }).ragFetch);
    page.glossaryTab().click();
    await flush(5);
    expect(page.view().textContent).toContain('Loading the glossary…');
    release!();
    await flush();
    expect(page.view().textContent).not.toContain('Loading the glossary…');
  });
});

describe('import from the Glossary view', () => {
  it('opens the panel import flow with the target_language format line and the replace warning', async () => {
    const page = loadPage();
    await page.open();
    button(page.view(), 'Import glossary CSV').click();
    await flush();
    const importTab = page.root.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true')!;
    expect(importTab.textContent.trim()).not.toBe('Glossary');
    const panel = page.doc.getElementById(importTab.getAttribute('aria-controls')!)!;
    const format = panel.querySelector('[data-glossary-import-format]')!;
    expect(format.textContent).toContain('target_language');
    expect(format.querySelectorAll('code').map((c) => c.textContent)).toEqual(['translation', 'target_language']);
    const replace = panel.querySelector('input[value="replace"]')!;
    replace.checked = true;
    replace.dispatch('change');
    const file = panel.querySelector('input[type="file"]')! as FakeElement & { files: unknown };
    file.files = [{ name: 'glossary.csv', size: 20, text: async () => 'canonical,variants\n' }];
    file.dispatch('change');
    await flush();
    button(panel, 'Check file').click();
    await flush();
    expect(panel.textContent).toContain('Replace covers the whole dictionary layer, not only the glossary.');
    expect(panel.querySelector('[data-glossary-replace-warning]')!.className).toContain('alert-warning');
  });

  it('the import report names a missing target with the glossary issue', async () => {
    const page = loadPage({ replies: { import: { status: 200, body: { success: true, report: { applied: false, create: 0, update: 0, unchanged: 0, delete: 0, issues: [{ code: 'target_language_required', severity: 'error', message: 'm', row: 2 }], layer_version_seen: 7 } } } } });
    await page.open();
    button(page.view(), 'Import glossary CSV').click();
    await flush();
    const panel = page.root.querySelector('[data-glossary-import-format]')!.closest('[role="tabpanel"]')!;
    const file = panel.querySelector('input[type="file"]')! as FakeElement & { files: unknown };
    file.files = [{ name: 'glossary.csv', size: 20, text: async () => 'canonical,variants\n' }];
    file.dispatch('change');
    await flush();
    button(panel, 'Check file').click();
    await flush();
    expect(panel.textContent).toContain('A translation row needs a target_language value.');
  });

  it('opening the import tab directly shows no glossary additions', async () => {
    const page = loadPage();
    await page.open();
    const importTab = page.root.querySelectorAll('[role="tab"]')[2]!;
    importTab.click();
    await flush();
    expect(page.root.querySelector('[data-glossary-import-format]')).toBeNull();
  });
});

describe('isolation and XSS', () => {
  it('a bubbling change from every glossary field and filter never reaches the config writer', async () => {
    const page = loadPage();
    await page.open();
    for (const id of ['rag-glossary-filter-from', 'rag-glossary-filter-to', 'rag-glossary-search']) bubble(page.view().querySelector('#' + id)!, 'change');
    button(page.view(), 'Add glossary entry').click();
    await flush();
    const dialog = page.dialog()!;
    const fields = dialog.querySelectorAll('[data-glossary-field]');
    expect(fields.length).toBe(6);
    for (const f of fields) {
      expect(f.id).not.toBe('');
      bubble(f, 'change');
    }
    expect(page.configWrites).toEqual([]);
  });

  it('markup and javascript: in terms, translations and notes create no element and no link', async () => {
    const payload = pair({ canonical: XSS, variants: [XSS, JS_URL], note: XSS + JS_URL, source_language: 'zh' });
    const legacy = pair({ id: LEGACY_ID, canonical: JS_URL, variants: [JS_URL], target_language: null });
    const page = loadPage({ glossary: listAnswer([payload, legacy]) });
    await page.open();
    expect(page.view().textContent).toContain(XSS);
    expect(page.view().textContent).toContain(JS_URL);
    noMarkup(page.doc);
    button(page.view(), 'Edit entry').click();
    await flush();
    expect(field(page.dialog()!, 'note').value).toBe(XSS + JS_URL);
    noMarkup(page.doc);
    button(page.dialog()!, 'Close form').click();
    button(page.view(), 'Delete entry').click();
    await flush();
    const confirm = page.doc.body.querySelectorAll('dialog').find((d) => d.open)!;
    expect(confirm.textContent).toContain(XSS);
    noMarkup(page.doc);
    const issues = [{ code: XSS, severity: 'error', message: XSS, row: null }];
    const bad = loadPage({ replies: { patch: { status: 422, body: { success: false, issues } } } });
    await bad.open();
    button(bad.view(), 'Edit entry').click();
    await flush();
    button(bad.dialog()!, 'Save entry').click();
    await flush();
    expect(bad.dialog()!.textContent).toContain(XSS);
    noMarkup(bad.doc);
  });
});

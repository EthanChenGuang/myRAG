import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, injectedElements } from './helpers/html-fake-dom';

const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const scriptFile = 'rag-panels/query-additions.js';
const source = fs.readFileSync(path.join(configUiDir, scriptFile), 'utf8');

type Json = Record<string, unknown>;
interface Model {
  id: string;
  displayName: string;
  [key: string]: unknown;
}

const FAST = 'anthropic/claude-haiku-5.5';
const QUALITY = 'anthropic/claude-sonnet-5.5';
const LIST: Model[] = [
  { id: 'vendor-a/model-default', displayName: 'Model Default', isDefault: true },
  { id: 'auto', displayName: 'Auto' },
  { id: 'vendor-b/model-small', displayName: 'Model Small' },
  { id: FAST, displayName: 'Claude Haiku 5.5' },
  { id: QUALITY, displayName: 'Claude Sonnet 5.5' },
];
const XSS = '<img src=x onerror=PWNED(1)>';
const JS_URL = 'javascript:PWNED(1)';
const READABLE_KEYS = ['RAG_MODEL_ROUTING', 'RAG_ROUTING_FAST_MODEL', 'RAG_ROUTING_QUALITY_MODEL', 'NEXT_PUBLIC_OPENROUTER_MODELS', 'NEXT_PUBLIC_AI_PROVIDER'];

function cardMarkup(): string {
  const start = indexHtml.indexOf('<!-- Query layer -->');
  const end = indexHtml.indexOf('<!-- Ingestion and embedding profiles -->', start);
  expect(start).toBeGreaterThan(-1);
  // Plan 07-20: the transform switches the nested rows depend on are rows of the generated RAG pipeline section, which renders
  // them with id and name equal to the env name; the static card no longer holds them, so the harness adds them the same way.
  const generated =
    '<div id="rag-pipeline-settings">' +
    '<input type="checkbox" id="RAG_QUERY_CONDENSE" name="RAG_QUERY_CONDENSE" checked>' +
    '<input type="checkbox" id="RAG_QUERY_DECOMPOSE" name="RAG_QUERY_DECOMPOSE" checked>' +
    '</div>';
  return generated + indexHtml.slice(start, end);
}

interface PageOptions {
  /** modelConfig.openrouterModels as the AI Models tab leaves it; [] means the tab was never opened. */
  models?: Model[];
  provider?: string;
  config?: Json;
  terminology?: boolean;
  glossaryTab?: boolean;
}

function menuLink(doc: FakeDocument, tab: string, clicks: string[]): FakeElement {
  const link = doc.createElement('a');
  link.className = 'menu-item';
  link.setAttribute('data-tab', tab);
  link.addEventListener('click', () => clicks.push(tab));
  doc.body.appendChild(link);
  return link;
}

/** The page's populateFields: field.value = saved value; a select without that option ends up with no value (UI-SPEC finding 4). */
function populate(doc: FakeDocument, config: Json) {
  for (const [key, value] of Object.entries(config)) {
    const field = doc.getElementById(key);
    if (!field) continue;
    if (field.getAttribute('type') === 'checkbox') field.checked = value === 'true' || value === true;
    else if (field.tagName === 'select') {
      const has = field.querySelectorAll('option').some((o) => o.getAttribute('value') === String(value));
      field.value = has ? String(value) : '';
    } else field.value = String(value ?? '');
  }
}

function loadPage(options: PageOptions = {}) {
  const doc = new FakeDocument();
  const clicks: string[] = [];
  const requests: string[] = [];
  const configWrites: Array<[string, unknown]> = [];
  const configReads = new Set<string>();
  const tabSelects: string[] = [];
  menuLink(doc, 'rag-modes', clicks);
  const adminLink = menuLink(doc, 'rag-administration', clicks);
  menuLink(doc, 'ai', clicks);

  const modes = doc.createElement('div');
  modes.id = 'rag-modes';
  modes.className = 'tab-content active';
  doc.body.appendChild(modes);
  modes.innerHTML = cardMarkup();
  for (const input of modes.querySelectorAll('input')) if (input.hasAttribute('checked')) input.checked = true;
  for (const select of modes.querySelectorAll('select')) {
    const options = select.querySelectorAll('option');
    const chosen = options.find((o) => o.hasAttribute('selected')) ?? options[0];
    select.value = chosen ? (chosen.getAttribute('value') ?? '') : '';
  }

  if (options.terminology !== false) {
    const admin = doc.createElement('div');
    admin.id = 'rag-administration';
    admin.className = 'tab-content';
    doc.body.appendChild(admin);
    admin.innerHTML =
      '<section id="rag-administration-terminology"><h3 id="rag-terminology-title" tabindex="-1" data-terminology-title>Terminology</h3>' +
      (options.glossaryTab === false ? '' : '<button type="button" role="tab" id="rag-terminology-tab-glossary">Glossary</button>') +
      '</section>';
  }

  const rawConfig: Json = { ...(options.config ?? {}) };
  const config = new Proxy(rawConfig, {
    get(target, key) {
      if (typeof key === 'string') configReads.add(key);
      return target[key as string];
    },
    has(target, key) {
      if (typeof key === 'string') configReads.add(key);
      return key in target;
    },
    set() {
      throw new Error('query-additions.js wrote window.configManager.config');
    },
  });
  const modelConfig = { provider: options.provider ?? 'openrouter', openaiModels: [], openrouterModels: options.models ?? [], groqModels: [] };
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: 'en-US' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    matchMedia: () => ({ matches: false }),
    fetch: (url: string) => {
      requests.push(url);
      throw new Error('unexpected fetch');
    },
    ragFetch: (url: string) => {
      requests.push(url);
      throw new Error('unexpected ragFetch');
    },
    configManager: {
      config,
      updateConfig(key: string, value: unknown) {
        configWrites.push([key, value]);
      },
    },
    modelConfig,
  };
  context.window = context;
  if (options.terminology !== false && options.glossaryTab !== false) {
    adminLink.addEventListener('click', () => {
      context.terminologyPanel = {
        tabs: {
          select(id: string) {
            tabSelects.push(id);
          },
          current: () => tabSelects[tabSelects.length - 1] ?? 'entries',
        },
      };
    });
  }
  vm.createContext(context);
  populate(doc, rawConfig);
  const createdBefore = doc.created.length;
  new vm.Script(source, { filename: scriptFile }).runInContext(context);
  doc.dispatch('DOMContentLoaded');

  const select = (id: string) => doc.getElementById(id) as FakeElement;
  const page = {
    doc,
    context,
    clicks,
    requests,
    configWrites,
    configReads,
    tabSelects,
    rawConfig,
    modelConfig,
    createdByScript: () => doc.created.slice(createdBefore),
    select,
    options: (id: string) => select(id).querySelectorAll('option').map((o) => ({ value: o.getAttribute('value') ?? '', text: o.textContent })),
    selected: (id: string) => {
      const chosen = select(id).querySelectorAll('option').filter((o) => (o as unknown as { selected?: boolean }).selected || o.hasAttribute('selected'));
      return { value: select(id).value, options: chosen.map((o) => o.getAttribute('value')) };
    },
    host: () => doc.getElementById('query-additions-routing-warnings') as FakeElement,
    warnings: () => page.host().children.map((alert) => ({ className: alert.className, text: (alert.querySelector('span') ?? alert).textContent.replace(/\s+/g, ' ').trim() })),
    change: (id: string, value?: string | boolean) => {
      const el = select(id);
      if (typeof value === 'boolean') el.checked = value;
      else if (value !== undefined) el.value = value;
      el.dispatch('change');
      if (typeof value === 'string') rawConfig[id] = value;
    },
  };
  return page;
}

const D35 = { RAG_MODEL_ROUTING: 'off', RAG_ROUTING_FAST_MODEL: FAST, RAG_ROUTING_QUALITY_MODEL: QUALITY };

describe('query-additions.js: routing selects', () => {
  it('fills both selects with "{displayName} ({id})" in list order, without the auto entry', () => {
    const page = loadPage({ models: LIST, config: D35 });
    const expected = [
      { value: '', text: 'Not set' },
      { value: 'vendor-a/model-default', text: 'Model Default (vendor-a/model-default)' },
      { value: 'vendor-b/model-small', text: 'Model Small (vendor-b/model-small)' },
      { value: FAST, text: `Claude Haiku 5.5 (${FAST})` },
      { value: QUALITY, text: `Claude Sonnet 5.5 (${QUALITY})` },
    ];
    expect(page.options('RAG_ROUTING_FAST_MODEL')).toEqual(expected);
    expect(page.options('RAG_ROUTING_QUALITY_MODEL')).toEqual(expected);
  });

  it('shows the D-35 defaults as saved values with no routing warning about them, and never writes them', () => {
    const page = loadPage({ models: LIST, config: D35 });
    expect(page.selected('RAG_ROUTING_FAST_MODEL')).toEqual({ value: FAST, options: [FAST] });
    expect(page.selected('RAG_ROUTING_QUALITY_MODEL')).toEqual({ value: QUALITY, options: [QUALITY] });
    expect(page.warnings()).toEqual([]);
    expect(page.host().className).toContain('empty:mt-0');
    expect(page.configWrites).toEqual([]);
    expect(page.rawConfig).toEqual(D35);
  });

  it('re-applies the saved value on tab select and focus after the list changes, and keeps an unknown saved id once', () => {
    const page = loadPage({ models: LIST, config: { ...D35, RAG_ROUTING_FAST_MODEL: 'vendor-x/gone' } });
    const missing = () => page.options('RAG_ROUTING_FAST_MODEL').filter((o) => o.value === 'vendor-x/gone');
    expect(missing()).toEqual([{ value: 'vendor-x/gone', text: 'vendor-x/gone (not in the model list)' }]);
    expect(page.selected('RAG_ROUTING_FAST_MODEL').value).toBe('vendor-x/gone');
    expect(page.warnings()).toEqual([
      { className: expect.stringContaining('alert-warning'), text: 'The fast model vendor-x/gone is not in the OpenRouter model list. Choose a listed model, or add it under AI Models.' },
    ]);

    const many = Array.from({ length: 60 }, (_v, i) => ({ id: `vendor-c/model-${i}`, displayName: `Model ${i}` }));
    page.modelConfig.openrouterModels = [LIST[0]!, LIST[1]!, ...many, LIST[4]!];
    page.select('RAG_ROUTING_QUALITY_MODEL').value = '';
    page.doc.querySelector('.menu-item[data-tab="rag-modes"]')!.click();
    expect(page.options('RAG_ROUTING_QUALITY_MODEL')).toHaveLength(1 + 1 + 60 + 1);
    expect(page.selected('RAG_ROUTING_QUALITY_MODEL').value).toBe(QUALITY);
    expect(missing()).toHaveLength(1);

    page.select('RAG_ROUTING_FAST_MODEL').value = '';
    page.select('RAG_ROUTING_FAST_MODEL').dispatch('focus');
    expect(page.selected('RAG_ROUTING_FAST_MODEL').value).toBe('vendor-x/gone');
    expect(missing()).toHaveLength(1);
    expect(page.configWrites).toEqual([]);
    expect(page.rawConfig.RAG_ROUTING_FAST_MODEL).toBe('vendor-x/gone');
  });

  it('with nothing saved selects Not set, warns about the quality model, and about the fast model only under auto', () => {
    const page = loadPage({ models: LIST, config: { RAG_MODEL_ROUTING: 'off', RAG_ROUTING_FAST_MODEL: '', RAG_ROUTING_QUALITY_MODEL: '' } });
    expect(page.selected('RAG_ROUTING_FAST_MODEL').value).toBe('');
    expect(page.selected('RAG_ROUTING_QUALITY_MODEL').value).toBe('');
    expect(page.warnings().map((w) => w.text)).toEqual(['The quality model is not set. A user who selects Auto needs it. Choose one.']);
    page.change('RAG_MODEL_ROUTING', 'auto');
    expect(page.warnings().map((w) => w.text)).toEqual([
      'The quality model is not set. A user who selects Auto needs it. Choose one.',
      'Model routing is auto, but the fast model is not set. Choose one.',
    ]);
    page.change('RAG_ROUTING_QUALITY_MODEL', QUALITY);
    page.change('RAG_ROUTING_FAST_MODEL', QUALITY);
    expect(page.warnings()).toEqual([{ className: expect.stringContaining('alert-info'), text: 'The fast and quality models are the same, so routing changes nothing.' }]);
    expect(page.configWrites).toEqual([]);
  });

  it('says the list has no Auto entry (info under off, warning under auto) with an Open AI Models button', () => {
    const noAuto = LIST.filter((m) => m.id !== 'auto');
    const page = loadPage({ models: noAuto, config: D35 });
    const text = 'The model list has no Auto entry, so users cannot select it. Under AI Models, add a model with the ID auto and the name Auto.';
    expect(page.warnings()).toEqual([{ className: expect.stringContaining('alert-info'), text }]);
    const code = page.host().querySelector('code')!;
    expect(code.textContent).toBe('auto');
    expect(code.getAttribute('translate')).toBe('no');
    page.change('RAG_MODEL_ROUTING', 'auto');
    expect(page.warnings()).toEqual([{ className: expect.stringContaining('alert-warning'), text }]);
    expect(page.host().querySelector('button')!.textContent).toBe('Open AI Models');
    page.host().querySelector('button')!.click();
    expect(page.clicks).toEqual(['ai']);
    expect(page.requests).toEqual([]);
  });

  it('notes a provider other than OpenRouter', () => {
    const page = loadPage({ models: LIST, provider: 'groq', config: D35 });
    expect(page.warnings().map((w) => w.text)).toEqual(['Auto is offered with the OpenRouter provider only. The provider is set to groq under AI Models.']);
  });

  it('before the model list is known shows Not set plus the saved id and no warning; the saved list is used when present', () => {
    const page = loadPage({ models: [], config: D35 });
    expect(page.options('RAG_ROUTING_FAST_MODEL')).toEqual([
      { value: '', text: 'Not set' },
      { value: FAST, text: FAST },
    ]);
    expect(page.selected('RAG_ROUTING_FAST_MODEL').value).toBe(FAST);
    expect(page.warnings()).toEqual([]);

    const saved = loadPage({ models: [], config: { ...D35, NEXT_PUBLIC_AI_PROVIDER: 'openrouter', NEXT_PUBLIC_OPENROUTER_MODELS: JSON.stringify(LIST) } });
    expect(saved.options('RAG_ROUTING_FAST_MODEL')).toHaveLength(5);
    expect(saved.warnings()).toEqual([]);
  });
});

describe('query-additions.js: nested switches', () => {
  it('dims nested rows with the parentOff line while the parent is off, keeping the checkbox operable', () => {
    const page = loadPage({ models: LIST, config: D35 });
    const row = (id: string) => page.select(id).closest('.form-control')!;
    const help = (id: string) => page.doc.getElementById(page.select(id).getAttribute('aria-describedby')!)!;
    for (const id of ['RAG_QUERY_HISTORY_FALLBACK', 'RAG_DECOMPOSED_ANSWER']) expect(row(id).classList.contains('opacity-60')).toBe(false);

    page.change('RAG_QUERY_DECOMPOSE', false);
    for (const id of ['RAG_QUERY_DECOMPOSE_COMPLETENESS', 'RAG_QUERY_SUBQ_FILTERS', 'RAG_DECOMPOSED_ANSWER']) {
      expect(row(id).classList.contains('opacity-60'), id).toBe(true);
      expect(help(id).textContent, id).toMatch(/No effect while “Decompose compound questions” is off\.$/);
      expect(page.select(id).disabled, id).toBe(false);
    }
    expect(row('RAG_QUERY_HISTORY_FALLBACK').classList.contains('opacity-60')).toBe(false);

    page.change('RAG_QUERY_CONDENSE', false);
    expect(help('RAG_QUERY_HISTORY_FALLBACK').textContent).toMatch(/No effect while “Condense follow-up questions” is off\.$/);

    page.change('RAG_QUERY_DECOMPOSE', true);
    expect(row('RAG_DECOMPOSED_ANSWER').classList.contains('opacity-60')).toBe(false);
    expect(help('RAG_DECOMPOSED_ANSWER').textContent).not.toContain('No effect while');
    expect(help('RAG_DECOMPOSED_ANSWER').textContent.match(/Each part cites/g)).toHaveLength(1);
    expect(page.configWrites).toEqual([]);
  });
});

describe('query-additions.js: Open glossary pointer', () => {
  it('selects the RAG administration tab, activates the Glossary tab and focuses it, with no request', () => {
    const page = loadPage({ models: LIST, config: D35 });
    const row = page.doc.querySelector('[data-query-additions-glossary-pointer]')!;
    expect(row.hidden).toBe(false);
    expect(row.textContent.replace(/\s+/g, ' ').trim()).toBe('Entries are edited under RAG administration, Terminology, Glossary. Open glossary');
    row.querySelector('button')!.click();
    expect(page.clicks).toEqual(['rag-administration']);
    expect(page.tabSelects).toEqual(['glossary']);
    expect(page.doc.activeElement?.id).toBe('rag-terminology-tab-glossary');
    expect(page.requests).toEqual([]);
  });

  it('falls back to the Terminology heading without a Glossary tab, and is not rendered without the Terminology panel', () => {
    const noTab = loadPage({ models: LIST, config: D35, glossaryTab: false });
    noTab.doc.querySelector('[data-query-additions-glossary-pointer] button')!.click();
    expect(noTab.doc.activeElement?.id).toBe('rag-terminology-title');

    const page = loadPage({ models: LIST, config: D35, terminology: false });
    const row = page.doc.querySelector('[data-query-additions-glossary-pointer]');
    expect(row === null || row.hidden).toBe(true);
    expect(page.doc.querySelectorAll('[data-query-additions-glossary-pointer] button').filter((b) => !b.closest('[hidden]'))).toEqual([]);
  });
});

describe('query-additions.js: safety', () => {
  it('renders markup and javascript: in model names, ids and saved ids as text only', () => {
    const models: Model[] = [
      { id: `vendor/${XSS}`, displayName: XSS },
      { id: JS_URL, displayName: `Name ${JS_URL}` },
    ];
    const page = loadPage({ models, provider: XSS, config: { RAG_MODEL_ROUTING: 'auto', RAG_ROUTING_FAST_MODEL: `saved${XSS}`, RAG_ROUTING_QUALITY_MODEL: JS_URL } });
    expect(page.options('RAG_ROUTING_FAST_MODEL').map((o) => o.text)).toContain(`${XSS} (vendor/${XSS})`);
    expect(page.warnings().map((w) => w.text).join(' ')).toContain(`saved${XSS}`);
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.doc.querySelectorAll('a').filter((a) => a.getAttribute('href'))).toEqual([]);
    expect(page.createdByScript()).not.toContain('img');
    expect(page.createdByScript()).not.toContain('a');
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });

  it('reads only the routing and model-list keys, writes nothing to storage and keeps the prefix on every top-level name', () => {
    const page = loadPage({ models: LIST, config: { ...D35, OPENROUTER_API_KEY: 'placeholder-secret' } });
    page.change('RAG_MODEL_ROUTING', 'auto');
    for (const key of page.configReads) expect(READABLE_KEYS, key).toContain(key);
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|updateConfig|saveConfig/);
    const tops = source.match(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm) ?? [];
    expect(tops.length).toBeGreaterThan(5);
    for (const decl of tops) expect(decl.replace(/^(?:const|let|var|class|async function|function)\s+/, '')).toMatch(/^(queryAdditions|QueryAdditions|QUERY_ADDITIONS_)/);
  });

  it('is loaded once from index.html, after rag-fetch.js', () => {
    expect(indexHtml.split('rag-panels/query-additions.js').length - 1).toBe(1);
    expect(indexHtml.indexOf('rag-panels/query-additions.js')).toBeGreaterThan(indexHtml.indexOf('rag-panels/rag-fetch.js'));
  });
});

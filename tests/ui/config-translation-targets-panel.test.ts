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
const mod = require('../../scripts/config-ui/rag-panels/translation-targets.js');

type Json = Record<string, unknown>;
type Route = 'get' | 'put';
interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}
interface RagCall {
  route: Route | 'unknown';
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}

const XSS = '<img src=x onerror=alert(1)>';
const ORG = 'c0000000-0000-4000-8000-000000000001';
const MODEL = 'vendor/translation-model-x';
const TRANSLATED = 'TRANSLATED CHUNK TEXT SHOULD NEVER SHOW';
const PATH = '/api/rag/admin/translation-settings';

function answer(extra: Json = {}): Json {
  return {
    success: true,
    enabled: true,
    targets: ['en'],
    supportedLanguages: ['zh', 'en', 'it'],
    languagesConfigured: true,
    monolingual: false,
    coverage: [{ language: 'en', done: 1204, total: 1530, gaps: 3 }],
    stale: false,
    deploymentSwitch: 'on',
    updatedAt: '2026-11-20T09:30:00.000Z',
    model: MODEL,
    sample: { content: TRANSLATED },
    tenantKey: 'o:' + ORG,
    ...extra,
  };
}

interface HarnessOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | ((call: RagCall) => Reply)>>;
  docTranslation?: string;
  model?: string;
  supported?: string;
  organization?: string;
  multiTenant?: boolean;
  clipboard?: boolean;
}

function loadPage(options: HarnessOptions = {}) {
  const doc = new FakeDocument();
  const ragCalls: RagCall[] = [];
  const copied: string[] = [];
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
  selector.value = options.organization ?? ORG;
  doc.body.appendChild(selector);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  const settingsHolder = doc.createElement('div');
  tab.appendChild(settingsHolder);
  settingsHolder.innerHTML = markedBlock('rag-phase032-settings');
  doc.getElementById('RAG_DOC_TRANSLATION')!.value = options.docTranslation ?? 'on';
  doc.getElementById('RAG_DOC_TRANSLATION_MODEL')!.value = options.model ?? MODEL;
  doc.getElementById('RAG_SUPPORTED_LANGUAGES')!.value = options.supported ?? 'zh,en,it';
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-translation-targets');
  doc.innerHtmlWrites = 0;

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : init.body;
    const p = apiPath.split('?')[0];
    const route: Route | 'unknown' = p === PATH && method === 'GET' ? 'get' : p === PATH && method === 'PUT' ? 'put' : 'unknown';
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const call: RagCall = { route, path: apiPath, method, query, body };
    ragCalls.push(call);
    if (route === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const custom = options.replies?.[route];
    const fallback: Reply = route === 'get' ? { status: 200, body: answer() } : { status: 200, body: answer(call.body as Json) };
    const reply = typeof custom === 'function' ? custom(call) : (custom ?? fallback);
    if (reply.throws) throw new TypeError('Failed to fetch');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body)) };
  };

  const navigator: Json = { language: options.locale ?? 'en-US' };
  if (options.clipboard !== false) {
    navigator.clipboard = {
      writeText: async (text: string) => {
        copied.push(text);
      },
    };
  }
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator,
    location: { origin: 'http://config.local', search: '', hash: '' },
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    Intl,
    Date,
    ragFetch,
    currentConfig: { NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: options.multiTenant ? 'multi-tenant' : 'single-tenant' },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/translation-targets.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-translation') as FakeElement;
  return {
    doc,
    root,
    selector,
    ragCalls,
    copied,
    calls: (route: Route) => ragCalls.filter((c) => c.route === route),
    async init() {
      const init = context.initTranslationTargetsPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initTranslationTargetsPanel is not defined');
      await init();
      await flush();
    },
    status: () => doc.querySelector('[data-translation-targets-status]') as FakeElement,
    alertHost: () => doc.querySelector('[data-translation-targets-alert]') as FakeElement,
    content: () => doc.querySelector('[data-translation-targets-content]') as FakeElement,
    save: () => button(root, 'Save targets'),
    enable: () => present(root.querySelector('[data-translation-targets-enabled]'), 'workspace switch'),
    target: (code: string) => present(root.querySelector(`[data-translation-targets-target="${code}"]`), 'target ' + code),
    fieldset: () => present(root.querySelector('fieldset'), 'targets fieldset'),
    table: () => present(root.querySelector('table'), 'coverage table'),
  };
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function present(el: FakeElement | null, what: string): FakeElement {
  expect(el, what).toBeTruthy();
  return el as FakeElement;
}

function button(root: FakeElement | null, text: string): FakeElement {
  const found = (root ? root.querySelectorAll('button') : []).find((b) => b.textContent.trim() === text);
  expect(found, 'button ' + text).toBeTruthy();
  return found as FakeElement;
}

function hasButton(root: FakeElement | null, text: string): boolean {
  return (root ? root.querySelectorAll('button') : []).some((b) => b.textContent.trim() === text);
}

function toggle(el: FakeElement, checked: boolean) {
  el.checked = checked;
  el.dispatch('change');
}

function describedText(doc: FakeDocument, el: FakeElement): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
}

function noMarkup(doc: FakeDocument) {
  expect(doc.innerHtmlWrites).toBe(0);
  expect(doc.body.querySelectorAll('img')).toHaveLength(0);
  expect(doc.body.querySelectorAll('script')).toHaveLength(0);
  for (const el of doc.body.querySelectorAll('*')) {
    for (const name of el.attributes.keys()) expect(name.startsWith('on')).toBe(false);
  }
}

describe('index.html skeleton', () => {
  it('has the Translation targets section after Versions and dates, before Embedding profiles, and its script after versions-dates.js', () => {
    const at = indexHtml.indexOf('id="rag-administration-translation"');
    expect(at).toBeGreaterThan(indexHtml.indexOf('id="rag-administration-versions"'));
    expect(at).toBeLessThan(indexHtml.indexOf('id="rag-administration-profiles"'));
    const script = indexHtml.indexOf('<script src="rag-panels/translation-targets.js"></script>');
    expect(script).toBeGreaterThan(indexHtml.indexOf('<script src="rag-panels/versions-dates.js"></script>'));
    expect(script).toBeGreaterThan(indexHtml.indexOf('<script src="rag-panels/rag-ui.js"></script>'));
    const block = markedBlock('rag-translation-targets');
    for (const attr of [
      'data-translation-targets-title',
      'data-translation-targets-description',
      'data-translation-targets-workspace',
      'data-translation-targets-alert',
      'data-translation-targets-content',
      'data-translation-targets-status',
    ]) {
      expect(block).toContain(attr);
    }
    expect(block).toMatch(/role="status" aria-live="polite"/);
  });
});

describe('view-model builder', () => {
  it('maps the route answer to named fields: switch, supported languages with native names, coverage per saved target', () => {
    const view = mod.translationTargetsView(answer({ targets: ['en', 'it'], coverage: [{ language: 'en', done: 1204, total: 1530, gaps: 3 }, { language: 'it', done: 0, total: 1530, gaps: null }] }), 'en');
    expect(view).toBeTruthy();
    expect(view.enabled).toBe(true);
    expect(view.deploymentOn).toBe(true);
    expect(view.supported.map((s: { code: string }) => s.code)).toEqual(['zh', 'en', 'it']);
    expect(view.supported.map((s: { name: string }) => s.name)).toEqual(['中文', 'English', 'Italiano']);
    expect(view.targets).toEqual(['en', 'it']);
    expect(view.coverage).toEqual([
      { language: 'en', name: 'English', done: 1204, total: 1530, gaps: 3 },
      { language: 'it', name: 'Italiano', done: 0, total: 1530, gaps: null },
    ]);
    const json = JSON.stringify(view);
    expect(json).not.toContain(MODEL);
    expect(json).not.toContain(TRANSLATED);
    expect(json).not.toContain('o:' + ORG);
  });

  it('drops targets and coverage rows outside the supported set and reads a missing switch as off', () => {
    const view = mod.translationTargetsView(answer({ targets: ['en', 'xx'], coverage: [{ language: 'xx', done: 1, total: 2, gaps: 0 }], deploymentSwitch: undefined }), 'en');
    expect(view).toBeTruthy();
    expect(view.targets).toEqual(['en']);
    expect(view.coverage).toEqual([]);
    expect(view.deploymentOn).toBe(false);
  });
});

describe('Translation targets panel', () => {
  it('renders the enabled switch, one labelled checkbox per supported language in a fieldset with legend, and the coverage table', async () => {
    const page = loadPage();
    await page.init();
    expect(page.calls('get')).toHaveLength(1);
    expect(page.calls('get')[0]!.query.get('organizationId')).toBe(ORG);
    expect(page.enable().checked).toBe(true);
    const fieldset = page.fieldset();
    expect(fieldset.querySelector('legend')?.textContent).toBe('Translate into');
    const boxes = fieldset.querySelectorAll('input[type="checkbox"]');
    expect(boxes.map((b) => b.getAttribute('data-translation-targets-target'))).toEqual(['zh', 'en', 'it']);
    const labels = fieldset.querySelectorAll('label');
    expect(labels.map((l) => l.textContent.replace(/\s+/g, ' ').trim())).toEqual(['中文 zh', 'English en', 'Italiano it']);
    expect(labels.map((l) => l.querySelector('[lang]')?.getAttribute('lang'))).toEqual(['zh', 'en', 'it']);
    expect(page.target('en')!.checked).toBe(true);
    expect(page.target('it')!.checked).toBe(false);
    const table = page.table()!;
    expect(table.querySelectorAll('th').map((th) => th.textContent)).toEqual(['Language', 'Chunks translated', 'Gaps']);
    const cells = table.querySelectorAll('tbody td').map((td) => td.textContent.trim());
    expect(cells).toEqual(['English', '1,204 of 1,530', '3']);
    expect(table.querySelector('tbody td.tabular-nums')).toBeTruthy();
    expect(page.root.querySelector('[data-rag-panel-workspace], [data-translation-targets-workspace]')!.textContent).toBe('Workspace: Workspace One');
    noMarkup(page.doc);
  });

  it('states that translations are for search only and what enabling sends, and never renders a model name or translated text', async () => {
    const page = loadPage();
    await page.init();
    const text = page.root.textContent;
    expect(text).toContain('Answers and citations always use the original text.');
    expect(text).toContain('Chunk text is sent to the translation model set under Settings.');
    expect(text).not.toContain(MODEL);
    expect(text).not.toContain(TRANSLATED);
    const outsideCommands = page.root.querySelectorAll('*').filter((el) => el.tagName !== 'code' && el.childNodes.some((n) => n.nodeType === 3 && String((n as unknown as { data: string }).data).includes('o:' + ORG)));
    expect(outsideCommands).toHaveLength(0);
    for (const code of page.root.querySelectorAll('code').filter((c) => c.textContent.includes('o:' + ORG))) expect(code.textContent.startsWith('npm run rag:translate')).toBe(true);
  });

  it('Save targets is disabled with its reason on screen until something changed', async () => {
    const page = loadPage();
    await page.init();
    const save = page.save();
    expect(save.disabled).toBe(true);
    expect(describedText(page.doc, save)).toContain('No changes to save.');
    toggle(page.target('it')!, true);
    expect(save.disabled).toBe(false);
    toggle(page.target('it')!, false);
    expect(save.disabled).toBe(true);
  });

  it('enabled with no target ticked keeps Save disabled with targets.needOne', async () => {
    const page = loadPage();
    await page.init();
    toggle(page.target('en')!, false);
    expect(page.save().disabled).toBe(true);
    expect(describedText(page.doc, page.save())).toContain('Choose at least one language to translate into.');
  });

  it('with the workspace switch off the target checkboxes are disabled with targets.needEnable', async () => {
    const page = loadPage({ replies: { get: { status: 200, body: answer({ enabled: false, targets: [] , coverage: [] }) } } });
    await page.init();
    expect(page.enable().checked).toBe(false);
    for (const code of ['zh', 'en', 'it']) expect(page.target(code)!.disabled).toBe(true);
    expect(page.fieldset()!.textContent).toContain('Turn on translation for this workspace to choose languages.');
    toggle(page.enable(), true);
    expect(page.target('it')!.disabled).toBe(false);
  });

  it('sends PUT with { enabled, targets, organizationId }, shows the saved status and reloads coverage', async () => {
    let gets = 0;
    const page = loadPage({
      replies: {
        get: () => {
          gets += 1;
          return gets === 1
            ? { status: 200, body: answer() }
            : { status: 200, body: answer({ targets: ['en', 'it'], coverage: [{ language: 'en', done: 1204, total: 1530, gaps: 3 }, { language: 'it', done: 0, total: 1530, gaps: 0 }] }) };
        },
      },
    });
    await page.init();
    toggle(page.target('it')!, true);
    page.save().click();
    await flush();
    const put = page.calls('put');
    expect(put).toHaveLength(1);
    expect(put[0]!.query.get('organizationId')).toBe(ORG);
    expect(put[0]!.body).toEqual({ enabled: true, targets: ['en', 'it'], organizationId: ORG });
    expect(page.status().textContent).toBe('Translation targets saved.');
    expect(page.calls('get')).toHaveLength(2);
    const cells = page.table()!.querySelectorAll('tbody td').map((td) => td.textContent.trim());
    expect(cells).toEqual(['English', '1,204 of 1,530', '3', 'Italiano', '0 of 1,530', '0']);
    expect(page.save().disabled).toBe(true);
  });

  it('the default workspace sends no organizationId', async () => {
    const page = loadPage({ organization: '' });
    await page.init();
    expect(page.calls('get')).toHaveLength(1);
    expect(page.calls('get')[0]!.query.has('organizationId')).toBe(false);
    toggle(page.target('it')!, true);
    page.save().click();
    await flush();
    expect(page.calls('put')).toHaveLength(1);
    expect(page.calls('put')[0]!.body).toEqual({ enabled: true, targets: ['en', 'it'] });
  });

  it('400 target_not_supported is shown at the fieldset with the language name', async () => {
    const page = loadPage({ replies: { put: { status: 400, body: { success: false, error: 'target_not_supported' } } } });
    await page.init();
    toggle(page.target('it')!, true);
    page.save().click();
    await flush();
    const fieldset = page.fieldset()!;
    expect(describedText(page.doc, fieldset)).toContain('Not saved.');
    expect(fieldset.textContent).toContain('is not one of the supported languages.');
    expect(page.status().classList.contains('text-error')).toBe(true);
  });

  it('with the deployment switch off the form is read-only and a sentence says where to turn it on', async () => {
    const page = loadPage({ docTranslation: 'off', replies: { get: { status: 200, body: answer({ deploymentSwitch: 'off' }) } } });
    await page.init();
    expect(page.enable().disabled).toBe(true);
    for (const code of ['zh', 'en', 'it']) expect(page.target(code)!.disabled).toBe(true);
    const save = page.save();
    expect(save.disabled).toBe(true);
    const reason = describedText(page.doc, save);
    expect(reason).toContain('Document translation is off for this deployment');
    expect(reason).toContain('Settings');
    expect(page.alertHost().textContent).toContain('Document translation is off for this deployment');
    save.click();
    await flush();
    expect(page.calls('put')).toHaveLength(0);
  });

  it('reloads on a workspace change', async () => {
    const page = loadPage();
    await page.init();
    page.selector.value = '';
    page.selector.dispatch('change');
    await flush();
    expect(page.calls('get')).toHaveLength(2);
    expect(page.calls('get')[1]!.query.has('organizationId')).toBe(false);
    expect(page.root.querySelector('[data-translation-targets-workspace]')!.textContent).toBe('Workspace: Default workspace');
  });

  it('renders server strings as text', async () => {
    const page = loadPage({ replies: { get: { status: 200, body: answer({ supportedLanguages: ['en', XSS], targets: [XSS], coverage: [{ language: XSS, done: XSS, total: XSS, gaps: XSS }] }) }, put: { status: 400, body: { success: false, error: XSS, details: [{ path: 'targets', message: XSS }] } } } });
    await page.init();
    toggle(page.enable(), false);
    page.save().click();
    await flush();
    noMarkup(page.doc);
  });
});

describe('Settings, backfill command, monolingual, stale and empty states', () => {
  it('moves the translation settings group under a Settings heading; both controls end with the stored-documents sentence', async () => {
    const page = loadPage();
    await page.init();
    const group = page.doc.querySelector('[data-rag-settings-group="translation"]')!;
    expect(page.root.contains(group)).toBe(true);
    const heading = page.root.querySelectorAll('h4').find((h) => h.textContent === 'Settings');
    expect(heading).toBeTruthy();
    for (const id of ['RAG_DOC_TRANSLATION', 'RAG_DOC_TRANSLATION_MODEL']) {
      const control = page.doc.getElementById(id)!;
      expect(group.contains(control)).toBe(true);
      expect(describedText(page.doc, control).trim().endsWith('Changing this affects documents already stored; saving shows how many.')).toBe(true);
    }
  });

  it('localizes the settings group in zh and it', async () => {
    for (const [locale, label] of [
      ['zh-CN', '文档翻译'],
      ['it-IT', 'Traduzione dei documenti'],
    ] as const) {
      const page = loadPage({ locale });
      await page.init();
      const group = page.doc.querySelector('[data-rag-settings-group="translation"]')!;
      expect(group.querySelector('[data-rag-i18n="RAG_DOC_TRANSLATION.label"]')!.textContent).toBe(label);
      expect(page.root.querySelectorAll('h4').some((h) => h.textContent === (locale === 'zh-CN' ? '设置' : 'Impostazioni'))).toBe(true);
    }
  });

  it('warns that translation needs languages when RAG_DOC_TRANSLATION=on and languages are unset, recomputed on change', async () => {
    const page = loadPage({ supported: '', docTranslation: 'off' });
    await page.init();
    const needs = 'This setting has no effect until the supported languages are chosen in the Languages panel.';
    expect(page.alertHost().textContent).not.toContain(needs);
    const control = page.doc.getElementById('RAG_DOC_TRANSLATION')!;
    control.value = 'on';
    control.dispatch('change');
    expect(page.alertHost().textContent).toContain(needs);
  });

  it('warns that one supported language keeps translation off', async () => {
    const page = loadPage({ supported: 'en', docTranslation: 'on' });
    await page.init();
    expect(page.alertHost().textContent).toContain('One language is supported, so document translation stays off.');
    const none = loadPage({ supported: 'zh,en', docTranslation: 'on' });
    await none.init();
    expect(none.alertHost().textContent).not.toContain('One language is supported');
  });

  it('with one supported language the targets area shows the monolingual sentence and no checkbox', async () => {
    const page = loadPage({ supported: 'en', replies: { get: { status: 200, body: answer({ supportedLanguages: ['en'], monolingual: true, enabled: false, targets: [], coverage: [] }) } } });
    await page.init();
    expect(page.root.textContent).toContain('This deployment supports one language, so there is nothing to translate into.');
    expect(page.root.querySelector('fieldset')).toBeNull();
    expect(page.root.querySelectorAll('[data-translation-targets-target]')).toHaveLength(0);
    expect(hasButton(page.root, 'Save targets')).toBe(false);
  });

  it('before any translation each target reads "0 of {total}" and the backfill help shows the dry-run and the run command with Copy command', async () => {
    const page = loadPage({ replies: { get: { status: 200, body: answer({ targets: ['en', 'it'], coverage: [{ language: 'en', done: 0, total: 1530, gaps: null }, { language: 'it', done: 0, total: 1530, gaps: null }] }) } } });
    await page.init();
    const cells = page.table().querySelectorAll('tbody td').map((td) => td.textContent.trim());
    expect(cells[1]).toBe('0 of 1,530');
    expect(cells[4]).toBe('0 of 1,530');
    expect(cells[2]).toContain('—');
    const text = page.root.textContent;
    expect(text).toContain('Saving translates nothing by itself. New documents are translated after they are published; for existing ones run:');
    const codes = page.root.querySelectorAll('code').map((c) => c.textContent);
    const dry = `npm run rag:translate -- --tenant o:${ORG} --dry-run`;
    const run = `npm run rag:translate -- --tenant o:${ORG} --budget <USD>`;
    expect(codes).toContain(dry);
    expect(codes).toContain(run);
    for (const c of page.root.querySelectorAll('code').filter((el) => el.textContent.startsWith('npm run'))) {
      expect(c.getAttribute('translate')).toBe('no');
      expect(c.className).toContain('font-mono');
      expect(c.className).toContain('break-all');
    }
    const order = page.root.querySelectorAll('code').map((c) => c.textContent);
    expect(order.indexOf(dry)).toBeLessThan(order.indexOf(run));
    const copies = page.root.querySelectorAll('button').filter((b) => b.textContent === 'Copy command');
    expect(copies).toHaveLength(2);
    copies[0]!.click();
    await flush();
    expect(page.copied).toEqual([dry]);
    expect(page.status().textContent).toBe('Command copied.');
  });

  it('fills s:default for the default workspace of a single-tenant deployment and a placeholder in multi-tenant mode', async () => {
    const single = loadPage({ organization: '' });
    await single.init();
    expect(single.root.querySelectorAll('code').map((c) => c.textContent)).toContain('npm run rag:translate -- --tenant s:default --dry-run');
    const multi = loadPage({ organization: '', multiTenant: true });
    await multi.init();
    expect(multi.root.querySelectorAll('code').map((c) => c.textContent)).toContain('npm run rag:translate -- --tenant u:<user-id> --dry-run');
  });

  it('without a clipboard the commands stay as selectable text and no Copy command button is offered', async () => {
    const page = loadPage({ clipboard: false });
    await page.init();
    expect(hasButton(page.root, 'Copy command')).toBe(false);
    expect(page.root.querySelectorAll('code').some((c) => c.textContent.includes('--dry-run'))).toBe(true);
  });

  it('shows the stale notice with the re-embed command and a stale badge per row when the answer says stale', async () => {
    const page = loadPage({ replies: { get: { status: 200, body: answer({ stale: true }) } } });
    await page.init();
    const alert = page.alertHost();
    expect(alert.textContent).toContain('The embedding profile changed, so stored translations are not used for search.');
    expect(alert.querySelectorAll('code').map((c) => c.textContent)).toContain(`npm run rag:translate -- --tenant o:${ORG} --reembed --budget <USD>`);
    expect(page.table().textContent).toContain('Not used for search');
    const fresh = loadPage();
    await fresh.init();
    expect(fresh.alertHost().textContent).not.toContain('The embedding profile changed');
    expect(fresh.table().textContent).not.toContain('Not used for search');
  });

  it('gaps above zero show the gaps sentence; zero gaps do not', async () => {
    const page = loadPage();
    await page.init();
    expect(page.root.textContent).toContain('Some chunks were left untranslated');
    const none = loadPage({ replies: { get: { status: 200, body: answer({ coverage: [{ language: 'en', done: 5, total: 5, gaps: 0 }] }) } } });
    await none.init();
    expect(none.root.textContent).not.toContain('Some chunks were left untranslated');
  });

  it('renders the sign-in and unavailable states without a password field, and Reload panel loads again', async () => {
    const page = loadPage({ replies: { get: { status: 401, body: { error: 'Unauthorized' } } } });
    await page.init();
    expect(page.content().textContent).toContain('Sign in');
    expect(page.root.querySelector('input[type="password"]')).toBeNull();
    expect(page.root.querySelector('fieldset')).toBeNull();
    const down = loadPage({ replies: { get: { status: 503, body: { success: false, error: 'Translation settings are unavailable' } } } });
    await down.init();
    expect(down.alertHost().textContent).toContain('Translation targets are unavailable right now. Select Reload panel in a moment.');
    button(down.alertHost(), 'Reload panel').click();
    await flush();
    expect(down.calls('get')).toHaveLength(2);
  });

  it('shows the loading text while the first request runs', async () => {
    const page = loadPage();
    const started = page.init();
    expect(page.content().textContent).toContain('Loading translation targets…');
    await started;
    expect(page.content().textContent).not.toContain('Loading translation targets…');
  });

  it('the Settings sub-view stays usable when the data call answers 401', async () => {
    const page = loadPage({ replies: { get: { status: 401, body: { error: 'Unauthorized' } } } });
    await page.init();
    const group = page.doc.querySelector('[data-rag-settings-group="translation"]')!;
    expect(page.root.contains(group)).toBe(true);
    expect(page.doc.getElementById('RAG_DOC_TRANSLATION')!.disabled).toBe(false);
  });

  it('renders no cost figure, model name or translated text in any state', async () => {
    const page = loadPage({ replies: { get: { status: 200, body: answer({ stale: true, cost: { usd: 12.34 }, estimatedCostUsd: 56.78 }) } } });
    await page.init();
    const text = page.root.querySelector('[data-translation-targets-content]')!.textContent + page.alertHost().textContent;
    expect(text).not.toMatch(/\$|USD \d|12\.34|56\.78/);
    expect(text).not.toContain(MODEL);
    expect(text).not.toContain(TRANSLATED);
  });

  it('has zh and it for every English label', () => {
    const en = Object.keys(mod.TRANSLATION_TARGETS_LABELS.en).sort();
    expect(Object.keys(mod.TRANSLATION_TARGETS_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(mod.TRANSLATION_TARGETS_LABELS.it).sort()).toEqual(en);
  });
});

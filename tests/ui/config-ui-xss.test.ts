import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, blockFrom, functionSource, injectedElements } from './helpers/html-fake-dom';

const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const html = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const safeDomPath = path.join(configUiDir, 'utils/safe-dom.js');

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, endMarker).toBeGreaterThan(start);
  return source.slice(start, end);
}

function methodSource(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  return blockFrom(source, start);
}

function makeContext(doc: FakeDocument, globals: Record<string, unknown> = {}) {
  const context: Record<string, unknown> = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    showToast: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    location: { origin: 'http://config.local', port: '3333', href: 'http://config.local/', search: '' },
    URLSearchParams,
    encodeURIComponent,
    decodeURIComponent,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    JSON,
    Date,
    Object,
    ...globals,
  };
  if (!('window' in globals)) context.window = context;
  vm.createContext(context);
  if (fs.existsSync(safeDomPath)) new vm.Script(fs.readFileSync(safeDomPath, 'utf8')).runInContext(context);
  return context;
}

function host(doc: FakeDocument, id: string, tag = 'div'): FakeElement {
  const el = doc.createElement(tag);
  el.id = id;
  doc.body.appendChild(el);
  return el;
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: { entries: () => [] },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function expectNoInjection(doc: FakeDocument, payloadShown = true) {
  expect(injectedElements(doc)).toEqual([]);
  if (payloadShown) {
    const all = [doc.documentElement, ...doc.documentElement.querySelectorAll('*')];
    const visible = all.some((el) => el.textContent.includes('PWNED') || (el.value || '').includes('PWNED') || (el.getAttribute('value') || '').includes('PWNED'));
    expect(visible, 'the payload is shown as text').toBe(true);
  }
}

describe('Config UI index.html renders untrusted data as text (XSS)', () => {
  it('Knowledge-base image picker: selected file names', () => {
    const doc = new FakeDocument();
    const selectedGrid = host(doc, 'selected-grid');
    const selectedSection = host(doc, 'selected-section');
    class FakeReader {
      onload: ((e: { target: { result: string } }) => void) | null = null;
      readAsDataURL() {
        this.onload?.({ target: { result: 'data:image/png;base64,AAAA' } });
      }
    }
    const context = makeContext(doc, { selectedGrid, selectedSection, FileReader: FakeReader, Array });
    vm.runInContext(`${functionSource(html, 'showSelectedImages')}\nglobalThis.__run = showSelectedImages;`, context);
    (context.__run as (files: unknown[]) => void)([{ name: XSS_PAYLOAD }]);
    expectNoInjection(doc, false);
    expect(selectedGrid.querySelector('span')!.getAttribute('title')).toBe(XSS_PAYLOAD);
    const previews = selectedGrid.querySelectorAll('img');
    expect(previews).toHaveLength(1);
    expect(previews[0]!.getAttribute('alt')).toBe(XSS_PAYLOAD);
  });

  it('Knowledge-base image grid: image url, name and id from /api/images', async () => {
    const doc = new FakeDocument();
    const grid = host(doc, 'uploaded-images-grid');
    host(doc, 'no-images-message');
    const context = makeContext(doc, {
      fetch: async () => jsonResponse({ images: [{ id: `id${XSS_PAYLOAD}`, url: `https://cdn.example.test/a.png${XSS_PAYLOAD}`, name: XSS_PAYLOAD }] }),
      openImageLightbox: () => {},
    });
    vm.runInContext(methodSource(html, 'window.loadUploadedImages = async function ()'), context);
    await (context.loadUploadedImages as () => Promise<void>)();
    expectNoInjection(doc, false);
    const imgs = grid.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('alt')).toBe(XSS_PAYLOAD);
    expect(grid.querySelectorAll('button')[0]!.hasAttribute('onclick')).toBe(false);
  });

  it('Knowledge-base image lightbox: url and name', () => {
    const doc = new FakeDocument();
    const context = makeContext(doc);
    vm.runInContext(`${functionSource(html, 'openImageLightbox')}\nglobalThis.__run = openImageLightbox;`, context);
    (context.__run as (u: string, n: string) => void)(`https://cdn.example.test/a.png${XSS_PAYLOAD}`, XSS_PAYLOAD);
    expectNoInjection(doc, false);
    expect(doc.body.querySelectorAll('img')[0]!.getAttribute('alt')).toBe(XSS_PAYLOAD);
  });

  it('Knowledge-base notification: message', () => {
    const doc = new FakeDocument();
    const context = makeContext(doc);
    vm.runInContext(`${functionSource(html, 'showNotification')}\nglobalThis.__run = showNotification;`, context);
    (context.__run as (m: string, t: string) => void)(XSS_PAYLOAD, 'error');
    expectNoInjection(doc);
  });

  it('Branding favicon preview: NEXT_PUBLIC_FAVICON_URL from .env.local', () => {
    const doc = new FakeDocument();
    host(doc, 'faviconPreview');
    const context = makeContext(doc);
    const body = between(html, 'const faviconUrl = this.config.NEXT_PUBLIC_FAVICON_URL', '// Update model cards after config is loaded');
    vm.runInContext(`globalThis.__run = function () { ${body} };`, context);
    (context.__run as (this: unknown) => void).call({ config: { NEXT_PUBLIC_FAVICON_URL: `/x.png${XSS_PAYLOAD}` } });
    expectNoInjection(doc, false);
    expect(doc.getElementById('faviconPreview')!.querySelectorAll('img')).toHaveLength(1);
  });

  it('Suggestion groups: group label, icon name and item text', () => {
    const doc = new FakeDocument();
    host(doc, 'suggestionGroupsList');
    const context = makeContext(doc);
    const render = methodSource(html, 'renderGroups: function ()');
    const icon = methodSource(html, 'getIconEmoji: function (icon)');
    vm.runInContext(`globalThis.suggestionsManager = { ${render}, ${icon} };`, context);
    const manager = context.suggestionsManager as { suggestionGroups: unknown[]; renderGroups: () => void };
    manager.suggestionGroups = [{ label: XSS_PAYLOAD, icon: XSS_PAYLOAD, items: [{ text: XSS_PAYLOAD }] }];
    manager.renderGroups();
    expectNoInjection(doc);
    const inputs = doc.getElementById('suggestionGroupsList')!.querySelectorAll('input');
    expect(inputs.map((i) => i.value)).toEqual([XSS_PAYLOAD, XSS_PAYLOAD]);
  });

  it('Welcome messages: message text, keeping the {Username} highlight', () => {
    const doc = new FakeDocument();
    const welcomeMessagesList = host(doc, 'welcomeMessagesList');
    const context = makeContext(doc, { welcomeMessagesList, welcomeMessages: [`Hi {Username} ${XSS_PAYLOAD}`], messagesCountBadge: null });
    vm.runInContext(`${functionSource(html, 'renderWelcomeMessages')}\nglobalThis.__run = renderWelcomeMessages;`, context);
    (context.__run as () => void)();
    expectNoInjection(doc);
    expect(welcomeMessagesList.querySelector('.text-primary')!.textContent).toBe('John');
  });

  it('Workspace selector: organization names and ids', () => {
    const doc = new FakeDocument();
    host(doc, 'workspace-selector', 'select');
    host(doc, 'workspace-selector-container');
    const context = makeContext(doc);
    vm.runInContext(`globalThis.__obj = { ${methodSource(html, 'populateWorkspaceSelector() {')}, refreshUploadPickerDefaults() {}, getWorkspaceName() { return ''; } };`, context);
    const obj = context.__obj as { workspaces: unknown; populateWorkspaceSelector: () => void };
    obj.workspaces = { personal: [{ id: `p${XSS_PAYLOAD}`, name: XSS_PAYLOAD }], teams: [{ id: 't1', name: XSS_PAYLOAD }], currentSelection: null };
    obj.populateWorkspaceSelector();
    expectNoInjection(doc);
    const options = doc.getElementById('workspace-selector')!.querySelectorAll('option');
    expect(options.some((o) => o.getAttribute('value') === `p${XSS_PAYLOAD}`)).toBe(true);
  });

  it('Custom prompt templates: id, name and description from localStorage', () => {
    const doc = new FakeDocument();
    host(doc, 'customTemplatesSection');
    host(doc, 'customTemplatesContainer');
    const context = makeContext(doc, {
      getCustomTemplates: () => ({ [`id${XSS_PAYLOAD}`]: { name: XSS_PAYLOAD, description: XSS_PAYLOAD } }),
      deleteCustomTemplateAndRefresh: () => {},
    });
    vm.runInContext(`${functionSource(html, 'refreshCustomTemplatesDisplay')}\nglobalThis.__run = refreshCustomTemplatesDisplay;`, context);
    (context.__run as () => void)();
    expectNoInjection(doc);
    const card = doc.getElementById('customTemplatesContainer')!.querySelector('.template-option')!;
    expect(card.getAttribute('data-template')).toBe(`id${XSS_PAYLOAD}`);
  });

  it('Share modal: the share URL', () => {
    const doc = new FakeDocument();
    const context = makeContext(doc);
    vm.runInContext(`${functionSource(html, 'showShareModal')}\nglobalThis.__run = showShareModal;`, context);
    (context.__run as (u: string) => void)(`https://config.example.test/?s=${XSS_PAYLOAD}`);
    expectNoInjection(doc);
    expect(doc.body.querySelectorAll('button').some((b) => b.hasAttribute('onclick') && b.getAttribute('onclick')!.includes('PWNED'))).toBe(false);
  });

  it('Shared prompt import: a crafted ?sharedPrompt= link', () => {
    const doc = new FakeDocument();
    const shared = Buffer.from(encodeURIComponent(JSON.stringify({ preContext: XSS_PAYLOAD, postContext: '' })), 'binary').toString('base64');
    const context = makeContext(doc, {
      location: { origin: 'http://config.local', port: '3333', href: 'http://config.local/', search: `?sharedPrompt=${encodeURIComponent(shared)}`, pathname: '/' },
      history: { replaceState() {} },
      ragPreContextArea: null,
      ragPostContextArea: null,
      updateLivePreview: () => {},
    });
    vm.runInContext(`${functionSource(html, 'checkForSharedTemplate')}\nglobalThis.__run = checkForSharedTemplate;`, context);
    (context.__run as () => void)();
    expect(doc.body.querySelector('.modal')).toBeTruthy();
    expectNoInjection(doc);
  });

  it('Translated prompt preview: model output', () => {
    const doc = new FakeDocument();
    const previewContent = host(doc, 'preview-content');
    const previewDiv = host(doc, 'preview-div');
    const context = makeContext(doc, { previewContent, previewDiv });
    const body = between(html, '// Show preview - combine pre and post context for display', 'previewDiv.classList.remove(');
    vm.runInContext(`globalThis.__run = function (result) { ${body} };`, context);
    const run = context.__run as (this: unknown, result: unknown) => void;
    run.call({}, { translated: { preContext: `A {{context}} ${XSS_PAYLOAD}`, postContext: XSS_PAYLOAD } });
    expectNoInjection(doc);
    expect(previewContent.querySelector('.bg-yellow-300')!.textContent).toBe('{{context}}');
    previewContent.replaceChildren();
    run.call({}, { translated: { preContext: XSS_PAYLOAD, postContext: XSS_PAYLOAD } });
    expectNoInjection(doc);
    expect(previewContent.textContent).toContain('[CONTEXT WILL BE INSERTED HERE]');
  });

  it('Admin status indicator: text', () => {
    const doc = new FakeDocument();
    const el = host(doc, 'status');
    const context = makeContext(doc);
    vm.runInContext(`${functionSource(html, 'updateStatusIndicator')}\nglobalThis.__run = updateStatusIndicator;`, context);
    for (const status of ['loading', 'success', 'error', 'warning']) {
      (context.__run as (e: FakeElement, s: string, t: string) => void)(el, status, XSS_PAYLOAD);
      expectNoInjection(doc);
    }
  });

  it('Admin users list: emails, ids and server errors', async () => {
    for (const body of [
      { users: [{ id: `u${XSS_PAYLOAD}`, email: XSS_PAYLOAD }] },
      { error: XSS_PAYLOAD },
    ]) {
      const doc = new FakeDocument();
      const adminUsersList = host(doc, 'adminUsersList');
      const context = makeContext(doc, { adminUsersList, fetch: async () => jsonResponse(body), removeAdmin: () => {} });
      vm.runInContext(`${functionSource(html, 'fetchAdminUsers')}\nglobalThis.__run = fetchAdminUsers;`, context);
      await (context.__run as () => Promise<void>)();
      expectNoInjection(doc);
      expect(adminUsersList.querySelectorAll('[onclick]')).toHaveLength(0);
    }
    const doc = new FakeDocument();
    const adminUsersList = host(doc, 'adminUsersList');
    const context = makeContext(doc, { adminUsersList, fetch: async () => { throw new Error(XSS_PAYLOAD); } });
    vm.runInContext(`${functionSource(html, 'fetchAdminUsers')}\nglobalThis.__run = fetchAdminUsers;`, context);
    await (context.__run as () => Promise<void>)();
    expectNoInjection(doc);
  });

  it('Admin action and setup results: messages that carry server output', () => {
    for (const [name, hostName] of [['showAdminResult', 'adminActionResult'], ['showSetupResult', 'setupAdminResult']] as const) {
      for (const type of ['success', 'error', 'loading', 'info']) {
        const doc = new FakeDocument();
        const el = host(doc, hostName);
        const context = makeContext(doc, { [hostName]: el });
        vm.runInContext(`${functionSource(html, name)}\nglobalThis.__run = ${name};`, context);
        (context.__run as (m: string, t: string) => void)(XSS_PAYLOAD, type);
        expectNoInjection(doc);
      }
    }
  });

  it('Processing activity log: file names and errors', () => {
    const doc = new FakeDocument();
    host(doc, 'activity-log');
    const context = makeContext(doc, { activityLog: [], updateLastUpdate: () => {}, updateProcessingSpeed: () => {} });
    vm.runInContext(methodSource(html, 'window.updateActivityLog = function (message'), context);
    (context.updateActivityLog as (m: string, t: string) => void)(`✗ Failed: ${XSS_PAYLOAD}`, 'error');
    expectNoInjection(doc);
  });

  it('Document processor activity log: file names, workspace names and errors', () => {
    const doc = new FakeDocument();
    const log = host(doc, 'activity-log');
    const context = makeContext(doc);
    vm.runInContext(`globalThis.__obj = { ${methodSource(html, 'logActivity(message) {')} };`, context);
    const obj = context.__obj as { logActivity: (m: string) => void };
    obj.logActivity(`❌ Failed to process ${XSS_PAYLOAD}: ${XSS_PAYLOAD}`);
    expectNoInjection(doc);
    expect(log.textContent).toContain(`Failed to process ${XSS_PAYLOAD}`);
  });

  it('Add model auto-fetch: model data and error text', async () => {
    const ids = ['new-model-id', 'fetch-model-btn', 'fetch-btn-text', 'model-fetch-status'];
    const cases = [
      async () => jsonResponse({ success: true, model: { displayName: XSS_PAYLOAD, contextLength: 1000, isFree: true, supportsReasoning: true, reasoningMethod: XSS_PAYLOAD, confidence: XSS_PAYLOAD } }),
      async () => jsonResponse({ success: false, error: XSS_PAYLOAD }),
      async () => jsonResponse(XSS_PAYLOAD, false, 500),
    ];
    for (const fetch of cases) {
      const doc = new FakeDocument();
      for (const id of ids) host(doc, id, id === 'new-model-id' ? 'input' : 'div');
      doc.getElementById('new-model-id')!.value = `evil/${XSS_PAYLOAD}`;
      const context = makeContext(doc, { fetch, fillModelForm: () => {} });
      vm.runInContext(`${functionSource(html, 'fetchModelInfo')}\nglobalThis.__run = fetchModelInfo;`, context);
      await (context.__run as () => Promise<void>)();
      expectNoInjection(doc);
    }
  });

  it('OpenRouter connection test: model ids, counts and errors', async () => {
    const cases = [
      async () => jsonResponse({ success: true, totalModels: XSS_PAYLOAD, testModels: [{ id: XSS_PAYLOAD, found: true }] }),
      async () => jsonResponse({ success: false, error: XSS_PAYLOAD, details: XSS_PAYLOAD }),
      async () => {
        throw new Error(XSS_PAYLOAD);
      },
    ];
    for (const fetch of cases) {
      const doc = new FakeDocument();
      host(doc, 'model-fetch-status');
      const context = makeContext(doc, { fetch });
      vm.runInContext(`${functionSource(html, 'testOpenRouterConnection')}\nglobalThis.__run = testOpenRouterConnection;`, context);
      await (context.__run as () => Promise<void>)();
      expectNoInjection(doc);
    }
  });

  it('Embed widget suggestions: suggestion text from NEXT_PUBLIC_EMBED_SUGGESTIONS', () => {
    const doc = new FakeDocument();
    host(doc, 'embed-suggestions-list');
    const context = makeContext(doc, { embedSuggestions: [XSS_PAYLOAD], updateSuggestionsPreview: () => {} });
    vm.runInContext(`${functionSource(html, 'renderEmbedSuggestions')}\nglobalThis.__run = renderEmbedSuggestions;`, context);
    (context.__run as () => void)();
    expectNoInjection(doc);
    expect(doc.getElementById('embed-suggestions-list')!.querySelectorAll('input')[0]!.value).toBe(XSS_PAYLOAD);
  });
});

void flush;

// Phase 5.2 plan 36: the answer-rules card (UI-SPEC section 11). Every server string and every page value it shows is text.

const ANSWER_RULES_JS_LINK = 'javascript:PWNED(1)';
const ANSWER_RULES_SCRIPT = `<script>PWNED(1)</script>`;

function answerRulesDoc(allowlistField: string | null) {
  const doc = new FakeDocument();
  const card = host(doc, 'rag-answer-rules');
  for (const id of [
    'rag-answer-rules-alerts',
    'rag-answer-rules-judge-calibration',
    'rag-answer-rules-caps',
    'rag-answer-rules-guard-now',
    'rag-answer-rules-allowlist',
    'rag-answer-rules-guard-rules',
    'rag-answer-rules-events-actions',
  ]) {
    const el = doc.createElement('div');
    el.id = id;
    card.appendChild(el);
  }
  const amount = doc.createElement('input');
  amount.setAttribute('data-answer-cap', 'value');
  card.appendChild(amount);
  const judgeModel = doc.createElement('input');
  judgeModel.id = 'RAG_GROUNDEDNESS_JUDGE_MODEL';
  judgeModel.value = XSS_PAYLOAD;
  card.appendChild(judgeModel);
  const guard = doc.createElement('select');
  guard.id = 'RAG_OUTPUT_GUARD';
  guard.value = 'enforce';
  card.appendChild(guard);
  if (allowlistField !== null) {
    const area = doc.createElement('textarea');
    area.id = 'RAG_OUTPUT_LINK_ALLOWLIST';
    area.value = allowlistField;
    doc.body.appendChild(area);
  }
  return doc;
}

function answerRulesSummary() {
  return {
    caps: [
      { mode: 'strict', limit: null, source: 'default' },
      { mode: 'balanced', limit: 700, source: 'sweep' },
    ],
    floor: 300,
    judgeLanguages: [
      { language: XSS_PAYLOAD, calibrated: false },
      { language: ANSWER_RULES_JS_LINK, calibrated: true },
    ],
    sameFamily: true,
    allowlist: [XSS_PAYLOAD, ANSWER_RULES_JS_LINK, ANSWER_RULES_SCRIPT],
    rulesVersion: `${XSS_PAYLOAD}${ANSWER_RULES_JS_LINK}`,
    ruleCounts: { zh: 1, en: 2, it: 3 },
  };
}

async function runAnswerRules(doc: FakeDocument, reply: unknown) {
  const context = makeContext(doc, {
    navigator: { language: 'en-US', clipboard: { writeText: async () => {} } },
    fetch: async () => jsonResponse(reply),
    setTimeout,
    clearTimeout,
    AbortController,
    Intl,
    URL,
  });
  for (const file of ['rag-panels/rag-ui.js', 'rag-panels/answer-rules.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  await (context.initAnswerRulesPanel as () => Promise<unknown>)();
  await flush(10);
}

function expectAnswerRulesSafe(doc: FakeDocument) {
  expectNoInjection(doc);
  const all = [doc.documentElement, ...doc.documentElement.querySelectorAll('*')];
  expect(all.filter((el) => ['a', 'img', 'script', 'iframe'].includes(el.tagName)).map((el) => el.tagName)).toEqual([]);
  for (const el of all) {
    for (const [name, value] of el.attributes) {
      expect(name.startsWith('on'), `${el.tagName} ${name}`).toBe(false);
      expect(['href', 'src', 'title', 'style'].includes(name), `${el.tagName} ${name}`).toBe(false);
      expect(value.includes('PWNED'), `${el.tagName} ${name}=${value}`).toBe(name === 'value');
    }
  }
  expect(doc.innerHtmlWrites).toBe(0);
}

describe('rag-panels/answer-rules.js renders server data and page values as text (XSS, UI-SPEC section 11)', () => {
  it('allowlist entries, language codes and the rule-set version from the summary create no element and no link', async () => {
    const doc = answerRulesDoc(null);
    await runAnswerRules(doc, answerRulesSummary());
    expectAnswerRulesSafe(doc);
    const list = doc.getElementById('rag-answer-rules-allowlist')!;
    expect(list.querySelectorAll('li code').map((c) => c.textContent)).toEqual([XSS_PAYLOAD, ANSWER_RULES_JS_LINK, ANSWER_RULES_SCRIPT]);
    expect(doc.getElementById('rag-answer-rules-judge-calibration')!.textContent).toContain(ANSWER_RULES_JS_LINK);
    expect(doc.getElementById('rag-answer-rules-guard-rules')!.textContent).toContain(XSS_PAYLOAD);
  });

  it('allowlist lines of the page field and the judge model id create no element and no link', async () => {
    const doc = answerRulesDoc(`${XSS_PAYLOAD}\n${ANSWER_RULES_JS_LINK},${ANSWER_RULES_SCRIPT}`);
    await runAnswerRules(doc, answerRulesSummary());
    expectAnswerRulesSafe(doc);
    const codes = doc.getElementById('rag-answer-rules-allowlist')!.querySelectorAll('li code').map((c) => c.textContent);
    expect(codes).toHaveLength(3);
    expect(codes.join(' ')).toMatch(/pwned/i);
    expect(doc.getElementById('rag-answer-rules-alerts')!.querySelector('[data-answer-rules-warning="warn.judgeSameFamily"]')).not.toBeNull();
  });

  it('a server error message is not shown and creates nothing', async () => {
    const doc = answerRulesDoc(null);
    await runAnswerRules(doc, { error: XSS_PAYLOAD, code: ANSWER_RULES_JS_LINK });
    expectNoInjection(doc, false);
    expect(doc.body.textContent).not.toContain('PWNED');
  });

  it('answer-rules.js has no innerHTML, inline handler, anchor or link attribute in its source', () => {
    const source = fs.readFileSync(path.join(configUiDir, 'rag-panels/answer-rules.js'), 'utf8');
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    expect(source).not.toMatch(/\bon[a-z]+\s*=|setAttribute\(\s*['"]on/i);
    expect(source).not.toMatch(/createElement\(\s*['"]a['"]|ragUiEl\([^)]*['"]a['"]|this\.el\(\s*['"]a['"]/);
    expect(source).not.toMatch(/['"](href|src|srcdoc|formaction)['"]\s*:|\.href\s*=|\.src\s*=|mailto:/);
  });

  it('the English copy of ANSWER_RULES_LABELS names no subject area', async () => {
    const mod = (await import('../../scripts/config-ui/rag-panels/answer-rules.js')) as unknown as {
      ANSWER_RULES_LABELS?: { en: Record<string, string> };
      default?: { ANSWER_RULES_LABELS: { en: Record<string, string> } };
    };
    const labels = mod.ANSWER_RULES_LABELS ?? mod.default!.ANSWER_RULES_LABELS;
    const denylist = [
      /travel/i,
      /lodging/i,
      /hotel/i,
      /accommodation/i,
      /per diem/i,
      /leave day/i,
      /annual leave/i,
      /vacation/i,
      /salar/i,
      /payroll/i,
      /restaurant/i,
      /\bmeal/i,
      /\bvpn\b/i,
      /password/i,
      /branch office/i,
      /reimburse/i,
      /expense/i,
    ];
    for (const [key, value] of Object.entries(labels.en)) {
      for (const word of denylist) expect(value, `${key} ${word}`).not.toMatch(word);
    }
  });
});

const SECURITY_JS_LINK = 'javascript:alert(1)';

function securityEventsDoc(): FakeDocument {
  const doc = new FakeDocument();
  const banner = doc.createElement('div');
  banner.id = 'rag-security-alert-banner';
  doc.body.appendChild(banner);
  const holder = doc.createElement('div');
  doc.body.appendChild(holder);
  holder.innerHTML = between(html, '<section id="rag-administration-security-events"', '<!-- rag-security-events:end -->');
  doc.innerHtmlWrites = 0;
  return doc;
}

function securityEventsReplies(apiPath: string): unknown {
  const uploader = { uploader_id: 'b1000000-0000-4000-8000-000000000001', uploader_name: XSS_PAYLOAD, uploader_email: SECURITY_JS_LINK };
  if (apiPath.startsWith('/api/rag/admin/security-events/alerts')) {
    return {
      success: true,
      events_recorded: true,
      hold_mode: 'manual',
      alert_level: 5,
      window_hours: 24,
      open_count: 1,
      next_cursor: null,
      items: [
        { id: 'a1000000-0000-4000-8000-000000000001', tenant_key: `o:${XSS_PAYLOAD}`, workspace_name: XSS_PAYLOAD, event_count: 7, window_hours: 24, threshold: 5, opened_at: XSS_PAYLOAD, status: 'open', held: false, ...uploader },
        { id: 'a1000000-0000-4000-8000-000000000002', tenant_key: 's:default', workspace_name: null, event_count: 7, window_hours: 24, threshold: 5, opened_at: '2026-11-20T09:30:00.000Z', status: 'acknowledged', held: true, ...uploader },
      ],
    };
  }
  if (apiPath.startsWith('/api/rag/admin/security-events/uploaders')) {
    return {
      success: true,
      events_recorded: true,
      hold_mode: 'manual',
      next_cursor: null,
      items: [{ user_id: uploader.uploader_id, tenant_key: 's:default', workspace_name: XSS_PAYLOAD, display_name: XSS_PAYLOAD, email: SECURITY_JS_LINK, event_count: 2, last_event_at: XSS_PAYLOAD, held: true, held_since: XSS_PAYLOAD }],
    };
  }
  if (apiPath.startsWith('/api/rag/admin/security-events/link-previews')) {
    return { success: true, state: 'mismatch', preview_hosts: [XSS_PAYLOAD], hosts_not_allowlisted: [XSS_PAYLOAD, SECURITY_JS_LINK] };
  }
  return {
    success: true,
    events_recorded: true,
    next_cursor: null,
    items: [
      { id: 'c1000000-0000-4000-8000-000000000001', tenant_key: 's:default', workspace_name: XSS_PAYLOAD, created_at: XSS_PAYLOAD, source: XSS_PAYLOAD, action: SECURITY_JS_LINK, detector: 'rules', document_id: 'd1', file_name: XSS_PAYLOAD, rule_ids: [XSS_PAYLOAD, SECURITY_JS_LINK], ...uploader },
    ],
  };
}

describe('rag-panels/security-events.js renders server data as text (XSS, D-57, UI-SPEC section 11)', () => {
  it('uploader names, e-mails, workspace and file names, hosts, rule ids and codes create no element, link or title', async () => {
    const doc = securityEventsDoc();
    const context = makeContext(doc, {
      navigator: { language: 'en-US' },
      setTimeout,
      clearTimeout,
      AbortController,
      Intl,
      URL,
      ragFetch: async (apiPath: string) => ({ ok: true, status: 200, body: securityEventsReplies(apiPath) }),
    });
    for (const file of ['rag-panels/rag-ui.js', 'rag-panels/security-events.js']) {
      new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
    }
    await (context.initSecurityEventsPanel as () => Promise<unknown>)();
    await flush(10);
    for (const tab of ['uploaders', 'events', 'previews']) {
      doc.getElementById(`rag-security-events-tab-${tab}`)!.click();
      await flush(10);
    }
    doc.dispatch('DOMContentLoaded');
    await flush(10);
    doc.getElementById('rag-security-events-tab-alerts')!.click();
    await flush(10);
    doc.querySelector('[data-security-hold]')!.click();
    await flush(10);
    expectNoInjection(doc);
    const all = [doc.documentElement, ...doc.documentElement.querySelectorAll('*')];
    expect(all.filter((el) => ['a', 'img', 'script', 'iframe'].includes(el.tagName)).map((el) => el.tagName)).toEqual([]);
    for (const el of all) {
      for (const [name, value] of el.attributes) {
        expect(name.startsWith('on'), `${el.tagName} ${name}`).toBe(false);
        expect(['href', 'src', 'title', 'style'].includes(name), `${el.tagName} ${name}`).toBe(false);
        // UI-SPEC 9.11 row-action names carry the uploader ("Hold uploads: Uploader A"); setAttribute keeps them inert.
        if (value.includes('PWNED')) expect(['value', 'aria-label'], `${el.tagName} ${name}=${value}`).toContain(name);
      }
    }
    expect(doc.innerHtmlWrites).toBe(0);
    expect(doc.body.textContent).toContain(XSS_PAYLOAD);
    expect(doc.body.textContent).toContain(SECURITY_JS_LINK);
  });

  it('security-events.js and the panel additions have no innerHTML, inline handler, anchor or link attribute in their source', () => {
    for (const file of ['security-events.js', 'injection-defense.js']) {
      const source = fs.readFileSync(path.join(configUiDir, 'rag-panels', file), 'utf8');
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
      expect(source, file).not.toMatch(/\bon[a-z]+\s*=|setAttribute\(\s*['"]on/i);
      expect(source, file).not.toMatch(/createElement\(\s*['"]a['"]|ragUiEl\([^)]*['"]a['"]|this\.el\(\s*['"]a['"]/);
      expect(source, file).not.toMatch(/['"](href|src|srcdoc|formaction)['"]\s*:|\.href\s*=|\.src\s*=|mailto:/);
    }
    for (const [file, start] of [
      ['quarantine.js', '  uploaderNodes(item) {'],
      ['upload-approvals.js', '  renderRow(row) {'],
      ['versions-dates.js', '  versionLabelField() {'],
      ['versions-dates.js', '  versionNode(view) {'],
      ['review-labelling.js', '  renderCheckDetails() {'],
      ['review-labelling.js', '  checkUploader(d) {'],
    ] as const) {
      const block = methodSource(fs.readFileSync(path.join(configUiDir, 'rag-panels', file), 'utf8'), start);
      expect(block, `${file} ${start}`).not.toMatch(/innerHTML|['"]a['"]|href|mailto:|['"]title['"]/);
    }
  });
});

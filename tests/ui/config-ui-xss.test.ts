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

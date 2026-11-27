import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, XSS_PAYLOAD, functionSource, injectedElements } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');




type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body?: unknown;
}

const G_A = '11111111-1111-4111-8111-111111111111';
const G_B = '22222222-2222-4222-8222-222222222222';




function groupsBody(extra: Json = {}): Json {
  return {
    success: true,
    personal: false,
    enabled: true,
    groups: [
      { id: G_A, key: 'group-a', name: 'group-a' },
      { id: G_B, key: 'group-b', name: 'group-b' },
    ],
    nextCursor: null,
    ...extra,
  };
}

function loadPage(options: { locale?: string; reply?: (apiPath: string) => Reply } = {}) {
  const doc = new FakeDocument();
  const calls: string[] = [];
  const ragFetch = async (apiPath: string) => {
    calls.push(apiPath);
    const reply = options.reply ? options.reply(apiPath) : { status: 200, body: groupsBody() };
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
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/access-groups.js', 'rag-panels/scope-tags.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  return { doc, context, calls };
}

type Page = ReturnType<typeof loadPage>;

interface QueueControls {
  load: (organizationId: string | null) => Promise<Json>;
  mount: (container: FakeElement, queue: Json[], picker: Json) => void;
  uploadField: (item: Json, picker: Json) => string | null;
  uploadErrorText: (code: string, locale: string) => string | null;
}

function controls(page: Page): QueueControls {
  return page.context.AccessGroupsQueueControls as QueueControls;
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function queueHost(page: Page, item: Json): { container: FakeElement; host: FakeElement } {
  const container = page.doc.createElement('div');
  page.doc.body.appendChild(container);
  const host = page.doc.createElement('div');
  host.setAttribute('data-queue-extras', String(item.id));
  container.appendChild(host);
  return { container, host };
}

function option(root: FakeElement, value: string): FakeElement {
  const found = root.querySelectorAll('[data-access-groups-queue-option]').find((n) => n.getAttribute('data-access-groups-queue-option') === value);
  if (!found) throw new Error('no option ' + value);
  return found;
}

function tick(root: FakeElement, value: string, checked: boolean): void {
  const box = option(root, value);
  box.checked = checked;
  box.dispatch('change');
}

function triggerText(root: FakeElement): string {
  const summary = root.querySelector('summary')!;
  return summary.childNodes
    .filter((n): n is FakeElement => n instanceof FakeElement && n.tagName === 'span' && !n.className.includes('sr-only'))
    .map((n) => n.textContent)
    .join('');
}

describe('the queue choice rules (UI-SPEC 6.2.3)', () => {
  const mod = require('../../scripts/config-ui/rag-panels/access-groups.js') as {
    accessGroupsQueueToggle: (value: Json | null, target: string, checked: boolean) => { mode: string; groupIds: string[] };
    accessGroupsQueueOptions: (body: Json) => { shown: boolean; enabled: boolean; groups: Array<{ id: string; name: string }> };
  };

  it('Everyone unticks every group; a group unticks Everyone; the last group off returns to untouched', () => {
    const groups = mod.accessGroupsQueueToggle({ mode: 'groups', groupIds: [G_A] }, 'everyone', true);
    expect(groups).toEqual({ mode: 'everyone', groupIds: [] });
    const one = mod.accessGroupsQueueToggle(groups, G_B, true);
    expect(one).toEqual({ mode: 'groups', groupIds: [G_B] });
    expect(mod.accessGroupsQueueToggle(one, G_B, false)).toEqual({ mode: 'untouched', groupIds: [] });
    expect(mod.accessGroupsQueueToggle({ mode: 'everyone', groupIds: [] }, 'everyone', false)).toEqual({ mode: 'untouched', groupIds: [] });
    expect(mod.accessGroupsQueueToggle(one, 'clear', false)).toEqual({ mode: 'untouched', groupIds: [] });
  });

  it('is shown only with the switch on, an organization workspace and at least one group (D-16)', () => {
    expect(mod.accessGroupsQueueOptions(groupsBody()).shown).toBe(true);
    expect(mod.accessGroupsQueueOptions(groupsBody({ enabled: false })).shown).toBe(false);
    expect(mod.accessGroupsQueueOptions(groupsBody({ groups: [] })).shown).toBe(false);
    expect(mod.accessGroupsQueueOptions(groupsBody({ personal: true })).shown).toBe(false);
    expect(mod.accessGroupsQueueOptions(groupsBody({ groups: [{ id: 'g:not-an-id', name: 'x' }] })).shown).toBe(false);
  });
});

describe('buildUploadForm and the access field (04.3-23 form contract, UI-SPEC 6.7)', () => {
  const { buildUploadForm } = require('../../scripts/config-ui/rag-panels/doc-types.js') as {
    buildUploadForm: (file: File, docType: string, pickerEnabled: boolean, item?: Json, picker?: Json) => FormData;
  };
  const { AccessGroupsQueueControls, accessGroupsQueueOptions } = require('../../scripts/config-ui/rag-panels/access-groups.js') as {
    AccessGroupsQueueControls: QueueControls;
    accessGroupsQueueOptions: (body: Json) => Json;
  };
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.AccessGroupsQueueControls;
  });

  const entries = (form: FormData) => [...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${(v as File).name}`]);
  const file = () => new File(['x'], 'document-a.pdf', { type: 'application/pdf' });
  const shown = { access: accessGroupsQueueOptions(groupsBody()) };

  it('untouched, hidden or absent: exactly today\'s entries', () => {
    g.AccessGroupsQueueControls = AccessGroupsQueueControls;
    const today = entries(buildUploadForm(file(), 'contract_legal', true));
    expect(today).toEqual([['file', 'file:document-a.pdf'], ['doc_type', 'contract_legal']]);
    expect(entries(buildUploadForm(file(), 'contract_legal', true, { id: 1, accessChoice: null }, shown))).toEqual(today);
    const hidden = { access: accessGroupsQueueOptions(groupsBody({ enabled: false })) };
    expect(entries(buildUploadForm(file(), 'contract_legal', true, { id: 1, accessChoice: { mode: 'everyone' } }, hidden))).toEqual(today);
    expect(entries(buildUploadForm(file(), 'contract_legal', true, { id: 1, accessChoice: { mode: 'everyone' } }, {}))).toEqual(today);
    expect(entries(buildUploadForm(file(), 'auto', false, { id: 1 }, shown))).toEqual([['file', 'file:document-a.pdf']]);
    delete g.AccessGroupsQueueControls;
    expect(entries(buildUploadForm(file(), 'contract_legal', true, { id: 1, accessChoice: { mode: 'everyone' } }, shown))).toEqual(today);
  });

  it('Everyone and groups append one access field with group ids only', () => {
    g.AccessGroupsQueueControls = AccessGroupsQueueControls;
    const everyone = buildUploadForm(file(), 'auto', false, { id: 1, accessChoice: { mode: 'everyone', groupIds: [] } }, shown);
    expect(entries(everyone)).toEqual([['file', 'file:document-a.pdf'], ['access', '{"everyone":true}']]);
    const groups = buildUploadForm(file(), 'contract_legal', true, { id: 1, accessChoice: { mode: 'groups', groupIds: [G_B, G_A, 'g:group-a'] } }, shown);
    expect(groups.getAll('access')).toEqual([JSON.stringify({ groupIds: [G_B, G_A] })]);
    expect(String(groups.get('access'))).not.toMatch(/g:|u:|"all"/);
  });

  it('the Config UI passes the queue item and the picker to buildUploadForm', () => {
    const processFile = indexHtml.slice(indexHtml.indexOf('async processFile(fileItem)'), indexHtml.indexOf('pauseProcessing()'));
    expect(processFile.match(/buildUploadForm\([^)]*fileItem, this\.uploadPicker\)/g)).toHaveLength(2);
  });
});

describe('AccessGroupsQueueControls in the queue host (UI-SPEC 6.7)', () => {
  it('loads every page of groups and hides itself with the switch off, no groups or a failed request', async () => {
    const page = loadPage({
      reply: (p) =>
        p.includes('cursor=c2')
          ? { status: 200, body: groupsBody({ groups: [{ id: G_B, name: 'group-b' }], nextCursor: null }) }
          : { status: 200, body: groupsBody({ groups: [{ id: G_A, name: 'group-a' }], nextCursor: 'c2' }) },
    });
    const options = await controls(page).load('org-1');
    expect(options.shown).toBe(true);
    expect((options.groups as Json[]).map((g) => g.id)).toEqual([G_A, G_B]);
    expect(page.calls[0]).toBe('/api/rag/access-groups?organizationId=org-1&limit=50');
    expect(page.calls).toHaveLength(2);

    expect((await controls(loadPage({ reply: () => ({ status: 200, body: groupsBody({ enabled: false }) }) })).load(null)).shown).toBe(false);
    expect((await controls(loadPage({ reply: () => ({ status: 200, body: groupsBody({ groups: [] }) }) })).load(null)).shown).toBe(false);
    expect((await controls(loadPage({ reply: () => ({ status: 401, body: { error: 'unauthorized' } }) })).load(null)).shown).toBe(false);
  });

  it('is not rendered when hidden: the host stays as Phase 3.2 leaves it', async () => {
    const page = loadPage({ reply: () => ({ status: 200, body: groupsBody({ enabled: false }) }) });
    const item: Json = { id: 7, name: 'document-a.pdf' };
    const { container, host } = queueHost(page, item);
    controls(page).mount(container, [item], { access: await controls(page).load(null) });
    expect(host.children).toHaveLength(0);
    expect(indexHtml).toContain("(picker.access && picker.access.shown === true)");
  });

  it('renders the three states with Everyone, the group fieldset, the note and Clear choice once touched', async () => {
    const page = loadPage();
    const item: Json = { id: 7, name: 'document-a.pdf' };
    const picker = { access: await controls(page).load(null) };
    const { container, host } = queueHost(page, item);
    const existing = page.doc.createElement('button');
    existing.setAttribute('data-scope-tags-replaces', '');
    host.appendChild(existing);
    controls(page).mount(container, [item], picker);

    const wrap = host.children[1]!;
    expect(host.children[0]).toBe(existing);
    expect(wrap.hasAttribute('data-access-groups-queue')).toBe(true);
    const menu = wrap.querySelector('.dropdown-content')!;
    expect(menu.className).toContain('max-h-72');
    expect(menu.className).toContain('overflow-y-auto');
    expect(menu.querySelector('legend')!.textContent).toBe('Only these groups');
    expect(menu.textContent).toContain('If you choose nothing, a new document is visible to everyone');
    expect(menu.querySelectorAll('fieldset input')).toHaveLength(2);
    expect(triggerText(wrap)).toBe('Access');
    expect(wrap.querySelector('summary .sr-only')!.textContent).toBe(' Choose who can see document-a.pdf');
    expect(wrap.querySelectorAll('[data-access-groups-queue-option]').map((n) => n.getAttribute('data-access-groups-queue-option'))).not.toContain('clear');

    tick(wrap, 'everyone', true);
    expect(item.accessChoice).toEqual({ mode: 'everyone', groupIds: [] });
    expect(triggerText(wrap)).toBe('Everyone');
    expect(option(wrap, 'clear').textContent).toBe('Clear choice');
    expect(controls(page).uploadField(item, picker)).toBe('{"everyone":true}');

    tick(wrap, G_A, true);
    expect(option(wrap, 'everyone').checked).toBe(false);
    expect(option(wrap, G_A).checked).toBe(true);
    expect(triggerText(wrap)).toBe('Groups: 1');
    expect(wrap.querySelector('summary i')!.className).toContain('bi-lock');
    expect(wrap.querySelectorAll('[data-access-groups-queue-chip]').map((c) => c.textContent)).toEqual(['group-a']);
    expect(page.doc.activeElement).toBe(option(wrap, G_A));

    tick(wrap, G_A, false);
    expect(item.accessChoice).toBeNull();
    expect(triggerText(wrap)).toBe('Access');
    expect(controls(page).uploadField(item, picker)).toBeNull();

    tick(wrap, G_B, true);
    option(wrap, 'clear').click();
    expect(item.accessChoice).toBeNull();
    expect(page.doc.activeElement).toBe(wrap.querySelector('summary'));
  });

  it('a chip remove button returns to untouched; Escape closes the menu onto its trigger', async () => {
    const page = loadPage();
    const item: Json = { id: 7, name: 'document-a.pdf', accessChoice: { mode: 'groups', groupIds: [G_B, 'gone-id'] } };
    const picker = { access: await controls(page).load(null) };
    const { container, host } = queueHost(page, item);
    controls(page).mount(container, [item], picker);
    const wrap = host.children[0]!;
    expect(item.accessChoice).toEqual({ mode: 'groups', groupIds: [G_B] });
    const remove = wrap.querySelector('[data-access-groups-queue-chip-remove]')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove group: group-b');
    remove.click();
    expect(item.accessChoice).toBeNull();
    const details = wrap.querySelector('details')!;
    details.open = true;
    details.dispatch('keydown', { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(page.doc.activeElement).toBe(wrap.querySelector('summary'));
  });

  it('a scope-tag re-render of the host keeps the Access control after Replaces…', () => {
    const render = functionSource(fs.readFileSync(path.join(configUiDir, 'rag-panels/scope-tags.js'), 'utf8'), 'scopeTagsRenderQueueHost');
    expect(render).toContain("host.replaceChildren(...nodes, ...tail)");
    expect(render).toContain("'data-queue-extras-tail'");
  });

  it('group_not_allowed: the row shows error.groupNotAllowed and the control reloads its groups', () => {
    const page = loadPage({ locale: 'it-IT' });
    expect(controls(page).uploadErrorText('group_not_allowed', 'it')).toBe('Non caricato. Scegli Tutti oppure uno dei tuoi gruppi.');
    expect(controls(page).uploadErrorText('invalid_access', 'en')).toBeNull();
    const processFile = indexHtml.slice(indexHtml.indexOf('async processFile(fileItem)'), indexHtml.indexOf('pauseProcessing()'));
    const branch = processFile.slice(processFile.indexOf('const accessControlError'), processFile.indexOf('throw new Error(errorMessage)'));
    expect(branch).toContain('this.refreshUploadPickerDefaults();');
    expect(branch).toContain('errorMessage = accessControlError;');
    const refresh = indexHtml.slice(indexHtml.indexOf('async refreshUploadPickerDefaults()'), indexHtml.indexOf('async loadWorkspaces()'));
    expect(refresh).toContain('this.uploadPicker.access = await accessOptions;');
  });

  it('markup in file and group names creates no element', async () => {
    const page = loadPage({ reply: () => ({ status: 200, body: groupsBody({ groups: [{ id: G_A, name: XSS_PAYLOAD }] }) }) });
    const item: Json = { id: 7, name: XSS_PAYLOAD, accessChoice: { mode: 'groups', groupIds: [G_A] } };
    const { container, host } = queueHost(page, item);
    page.doc.innerHtmlWrites = 0;
    controls(page).mount(container, [item], { access: await controls(page).load(null) });
    expect(injectedElements(host)).toHaveLength(0);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(host.textContent).toContain(XSS_PAYLOAD);
  });

  it('200 groups: every group is offered in the scrolling menu and the 50-group server limit is never exceeded', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, name: `group-${i}` }));
    const page = loadPage({ reply: () => ({ status: 200, body: groupsBody({ groups: many }) }) });
    const item: Json = { id: 7, name: 'document-a.pdf' };
    const picker = { access: await controls(page).load(null) };
    const { container, host } = queueHost(page, item);
    controls(page).mount(container, [item], picker);
    let wrap = host.children[0]!;
    expect(wrap.querySelectorAll('fieldset input')).toHaveLength(200);
    for (const g of many.slice(0, 50)) tick(wrap, g.id, true);
    wrap = host.children[0]!;
    expect(option(wrap, many[199]!.id).disabled).toBe(true);
    expect(JSON.parse(controls(page).uploadField(item, picker)!).groupIds).toHaveLength(50);
  });
});


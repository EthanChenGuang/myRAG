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
const managerSource = fs.readFileSync(path.join(configUiDir, 'document-processing/document-manager.js'), 'utf8');
const connectorsSource = fs.readFileSync(path.join(configUiDir, 'connectors-config.js'), 'utf8');
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/access-groups.js'), 'utf8');

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body?: unknown;
}

const G_A = '11111111-1111-4111-8111-111111111111';
const G_B = '22222222-2222-4222-8222-222222222222';
const D_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const D_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const D_3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

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

function tablePage(reply: (apiPath: string) => Reply, locale?: string) {
  const page = loadPage({ reply, locale });
  const container = page.doc.createElement('div');
  container.id = 'documents-table-container';
  page.doc.body.appendChild(container);
  const body = page.doc.createElement('tbody');
  container.appendChild(body);
  for (const [id, name] of [[D_1, 'document-a.pdf'], [D_2, XSS_PAYLOAD], [D_3, 'document-c.pdf']] as const) {
    const row = page.doc.createElement('tr');
    row.innerHTML = '<td><div class="font-medium">x</div></td><td>date</td>';
    row.children[0]!.children[0]!.textContent = name;
    row.setAttribute('data-access-groups-doc', id);
    body.appendChild(row);
  }
  return { ...page, container, body };
}

function audienceReply(enabled = true) {
  return (p: string): Reply => {
    if (p.startsWith('/api/rag/access-groups/documents?ids=')) {
      return {
        status: 200,
        body: {
          success: true,
          personal: false,
          audiences: [
            { documentId: D_1, kind: 'groups', groups: [{ id: G_A, name: 'group-a' }] },
            { documentId: D_2, kind: 'uploader_only', groups: [], fallbackReason: 'group_deleted' },
            { documentId: D_3, kind: 'everyone', groups: [] },
          ],
        },
      };
    }
    return { status: 200, body: groupsBody({ enabled }) };
  };
}

describe('stored-documents badge (UI-SPEC 6.8)', () => {
  const apply = (page: Page, body: FakeElement, org: string | null = null) => {
    expect(typeof page.context.AccessGroupsDocumentBadges).toBe('object');
    return (page.context.AccessGroupsDocumentBadges as { apply: (b: FakeElement, o: string | null) => Promise<void> }).apply(body, org);
  };

  it('Restricted for groups, the warning badge for the fallback, nothing for Everyone, and docs.manageHint under the table', async () => {
    const page = tablePage(audienceReply());
    await apply(page, page.body, 'org-1');
    const [r1, r2, r3] = page.body.children;
    const b1 = r1!.querySelector('[data-access-groups-table-badge]')!;
    expect(b1.textContent).toBe('Restricted');
    expect(b1.querySelector('i')!.className).toContain('bi-lock');
    expect(b1.getAttribute('title')).toBe('Only some members can see this document.');
    const b2 = r2!.querySelector('[data-access-groups-table-badge]')!;
    expect(b2.textContent).toBe('Uploader and admins only');
    expect(b2.className).toContain('badge-warning');
    expect(b2.querySelector('i')!.className).toContain('bi-shield-exclamation');
    expect(r3!.querySelector('[data-access-groups-table-badge]')).toBeNull();
    expect(page.container.querySelector('[data-access-groups-manage-hint]')!.textContent).toBe(
      'To change who can see a document, open RAG administration, Access groups, Documents.',
    );
    expect(page.calls).toContain(`/api/rag/access-groups/documents?ids=${D_1},${D_2},${D_3}&organizationId=org-1`);
    expect(r1!.textContent).not.toContain('group-a');
  });

  it('re-applying replaces, never duplicates; the switch off or a failed request leaves the table as today', async () => {
    const page = tablePage(audienceReply());
    await apply(page, page.body);
    await apply(page, page.body);
    expect(page.body.querySelectorAll('[data-access-groups-table-badge]')).toHaveLength(2);
    expect(page.container.querySelectorAll('[data-access-groups-manage-hint]')).toHaveLength(1);

    const off = tablePage(audienceReply(false));
    await apply(off, off.body);
    expect(off.body.querySelectorAll('[data-access-groups-table-badge]')).toHaveLength(0);
    expect(off.container.querySelector('[data-access-groups-manage-hint]')).toBeNull();
    expect(off.calls.some((c) => c.includes('/documents?ids='))).toBe(false);

    const failed = tablePage((p) => (p.includes('/documents') ? { status: 500, body: { error: 'x' } } : { status: 200, body: groupsBody() }));
    await apply(failed, failed.body);
    expect(failed.body.querySelectorAll('[data-access-groups-table-badge]')).toHaveLength(0);
  });

  it('the it badge wraps inside the name cell, and file names stay text', async () => {
    const page = tablePage(audienceReply(), 'it-IT');
    await apply(page, page.body);
    const b2 = page.body.children[1]!.querySelector('[data-access-groups-table-badge]')!;
    expect(b2.textContent).toBe('Solo chi ha caricato e amministratori');
    expect(b2.className).toContain('whitespace-normal');
    expect(b2.className).toContain('max-w-full');
    expect(injectedElements(page.body)).toHaveLength(0);
  });

  it('the table marks rows by id with setAttribute and calls the badge after the rows are set', () => {
    expect(managerSource).toContain("row.setAttribute('data-access-groups-doc', String(doc.id));");
    const render = managerSource.slice(managerSource.indexOf('renderDocuments() {'), managerSource.indexOf('createDocumentRow(doc) {'));
    expect(render.indexOf('AccessGroupsDocumentBadges.apply')).toBeGreaterThan(render.indexOf('this.elements.tableBody.appendChild(row)'));
  });
});

describe('Connectors card notice (UI-SPEC 6.8, D-20, D-22)', () => {
  type Card = { host: FakeElement; connectionId: string };
  const apply = (page: Page, cards: Card[]) => {
    expect(typeof page.context.AccessGroupsConnectorNotices).toBe('object');
    return (page.context.AccessGroupsConnectorNotices as { apply: (c: Card[], o: string | null) => Promise<void> }).apply(cards, null);
  };

  function cardsPage(enabled: boolean, counts: Array<{ connectionId: string; documents: number }>) {
    const page = loadPage({
      reply: (p) => (p.startsWith('/api/rag/access-groups/connector-map/fail-closed') ? { status: 200, body: { success: true, connections: counts } } : { status: 200, body: groupsBody({ enabled }) }),
    });
    const cards = ['conn-a', 'conn-b'].map((connectionId) => {
      const host = page.doc.createElement('div');
      host.setAttribute('data-connector-extras', '');
      page.doc.body.appendChild(host);
      return { host, connectionId };
    });
    return { page, cards };
  }

  it('shows connector.failClosed with the count and Open connector mapping only on the card with fallen-back documents', async () => {
    const { page, cards } = cardsPage(true, [{ connectionId: 'conn-a', documents: 1200 }]);
    await apply(page, cards);
    const notice = cards[0]!.host.querySelector('[data-access-groups-connector-notice]')!;
    expect(notice.getAttribute('data-access-groups-connector-notice')).toBe('connector.failClosed');
    expect(notice.className).toContain('alert-warning');
    expect(notice.querySelector('i')!.className).toContain('bi-shield-exclamation');
    expect(notice.querySelector('p')!.textContent).toBe(
      'Documents visible to their uploader and admins only: 1,200. Their sharing at the source is not mapped to an access group.',
    );
    expect(notice.querySelector('button')!.textContent).toBe('Open connector mapping');
    expect(cards[1]!.host.children).toHaveLength(0);
  });

  it('uses connector.failClosedOff with the switch off, and shows nothing without counts', async () => {
    const off = cardsPage(false, [{ connectionId: 'conn-b', documents: 3 }]);
    await apply(off.page, off.cards);
    expect(off.cards[1]!.host.querySelector('[data-access-groups-connector-notice]')!.getAttribute('data-access-groups-connector-notice')).toBe('connector.failClosedOff');
    const none = cardsPage(true, [{ connectionId: 'conn-a', documents: 0 }]);
    await apply(none.page, none.cards);
    expect(none.cards.every((c) => c.host.children.length === 0)).toBe(true);
  });

  it('Open connector mapping activates RAG administration through its menu link and scrolls with reduced motion honoured', async () => {
    const { page, cards } = cardsPage(true, [{ connectionId: 'conn-a', documents: 2 }]);
    const link = page.doc.createElement('a');
    link.setAttribute('data-tab', 'rag-administration');
    let clicked = 0;
    link.addEventListener('click', () => {
      clicked += 1;
    });
    page.doc.body.appendChild(link);
    const section = page.doc.createElement('section');
    section.id = 'rag-administration-access';
    const scrolled: Json[] = [];
    (section as unknown as { scrollIntoView: (o: Json) => void }).scrollIntoView = (o: Json) => scrolled.push(o);
    page.doc.body.appendChild(section);
    page.context.matchMedia = () => ({ matches: true });
    page.context.initAccessGroupsPanel = () => null;
    await apply(page, cards);
    cards[0]!.host.querySelector('button')!.click();
    await flush();
    expect(clicked).toBe(1);
    expect(scrolled).toEqual([{ behavior: 'auto', block: 'start' }]);
  });

  it('markup in counts answers and connection ids creates no element; the card hook is static markup', async () => {
    const { page, cards } = cardsPage(true, [{ connectionId: XSS_PAYLOAD, documents: 1 }]);
    cards[0]!.connectionId = XSS_PAYLOAD;
    await apply(page, cards);
    expect(injectedElements(page.doc)).toHaveLength(0);
    expect(connectorsSource).toContain("${isConnected ? '<div data-connector-extras></div>' : ''}");
    const notices = panelSource.slice(panelSource.indexOf('async function accessGroupsApplyConnectorNotices'), panelSource.indexOf('const AccessGroupsDocumentBadges'));
    expect(notices).not.toMatch(/innerHTML|insertAdjacentHTML|`/);
  });
});

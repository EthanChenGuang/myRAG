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
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/access-groups.js'), 'utf8');

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}
type Route = 'list' | 'documents' | 'access' | 'status';

interface View {
  kind: string;
  restricted: boolean;
  badge: string | null;
  text: string;
  groups: string[];
  peopleCount: number;
  peopleText: string | null;
  reason: { code: string; known: boolean; text: string } | null;
  action: string | null;
  summary: string;
}
interface DocsModule {
  buildAccessGroupsAudienceView: (audience: Json, locale: string) => View | null;
  buildAccessGroupsDocumentRow: (audience: Json) => Json | null;
  buildAccessGroupsDocumentsList: (body: Json) => { personal: boolean; rows: Json[]; nextCursor: string | null; counts: Json };
  accessGroupsInitialChoice: (rows: Json[]) => { choice: string | null; chips: string[]; mixed: boolean };
  accessGroupsFieldFindings: (state: Json) => { choice: string | null; canSave: boolean; needGroup: boolean; noGroups: boolean; widen: boolean; widenKey: string; reasonKey: string | null };
  accessGroupsAccessBody: (ids: string[], choice: string | null, chips: string[]) => Json | null;
  mapAccessGroupsError: (result: Json | null, locale: string, ctx?: Json) => { key: string; kind: string; reload?: boolean };
}

function loadModule(): DocsModule {
  return require('../../scripts/config-ui/rag-panels/access-groups.js') as DocsModule;
}

const G_A = '00000000-0000-4000-8000-0000000000a1';
const G_B = '00000000-0000-4000-8000-0000000000b2';
const G_C = '00000000-0000-4000-8000-0000000000c3';
const D_1 = '00000000-0000-4000-8000-000000000d01';
const D_2 = '00000000-0000-4000-8000-000000000d02';
const D_3 = '00000000-0000-4000-8000-000000000d03';
const D_4 = '00000000-0000-4000-8000-000000000d04';

function group(id: string, name: string, extra: Json = {}): Json {
  return { id, key: name, name, source: 'manual', createdAt: '2026-11-26T09:00:00.000Z', memberCount: 1, documentCount: 1, ...extra };
}
const GROUPS = [group(G_A, 'group-a'), group(G_B, 'group-b'), group(G_C, 'group-c')];

function listBody(groups: Json[], extra: Json = {}): Json {
  return { success: true, personal: false, enabled: true, groups, nextCursor: null, alerts: { unmappedSourceGroups: 0, enforcement: {} }, ...extra };
}

function audience(id: string, extra: Json = {}): Json {
  return {
    documentId: id,
    filename: 'document-' + id.slice(-1) + '.pdf',
    docType: 'general',
    source: 'config_upload',
    status: 'ready',
    createdAt: '2026-11-26T09:00:00.000Z',
    kind: 'everyone',
    groups: [],
    peopleCount: 0,
    fallbackReason: null,
    connectorManaged: false,
    ...extra,
  };
}
const RESTRICTED = (id: string, extra: Json = {}) => audience(id, { kind: 'groups', groups: [{ id: G_A, name: 'group-a' }, { id: G_B, name: 'group-b' }], ...extra });
const FALLBACK = (id: string, extra: Json = {}) => audience(id, { kind: 'uploader_only', fallbackReason: 'group_deleted', ...extra });

function docsBody(documents: Json[], extra: Json = {}): Json {
  return { success: true, personal: false, documents, nextCursor: null, counts: { restricted: 1, uploaderOnly: 1, everyone: 1, all: 3 }, ...extra };
}

const STATUS = { success: true, status: { runningSwitch: 'on', databaseFlag: true, status: 'ready', ready: true, reasons: [], objects: [], embedGroup: null, checkedAt: '2026-11-26T10:00:00.000Z' } };

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const base = '/api/rag/access-groups';
  const rest = apiPath.split('?')[0]!.slice(base.length);
  if (!apiPath.startsWith(base)) return 'unknown';
  if (rest === '' && method === 'GET') return 'list';
  if (rest === '/documents' && method === 'GET') return 'documents';
  if (rest === '/documents/access' && method === 'PUT') return 'access';
  if (rest === '/status' && method === 'GET') return 'status';
  return 'unknown';
}

interface PageOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | Reply[]>>;
  hold?: Route[];
  workspace?: { value: string; options: Array<[string, string]> };
}

function loadPage(options: PageOptions = {}) {
  const doc = new FakeDocument();
  const calls: Array<{ route: string; path: string; init: Json; query: URLSearchParams }> = [];
  const held = new Map<Route, Array<(reply: Reply) => void>>();
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  if (options.workspace) {
    const container = doc.createElement('div');
    container.id = 'workspace-selector-container';
    const select = doc.createElement('select');
    select.id = 'workspace-selector';
    for (const [value, label] of options.workspace.options) {
      const option = doc.createElement('option');
      option.setAttribute('value', value);
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = options.workspace.value;
    container.appendChild(select);
    tab.appendChild(container);
  }
  const settingsHolder = doc.createElement('div');
  tab.appendChild(settingsHolder);
  settingsHolder.innerHTML = markedBlock('rag-phase043-settings');
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-access-groups');
  doc.innerHtmlWrites = 0;

  const queues: Partial<Record<Route, Reply[]>> = {};
  for (const [route, reply] of Object.entries(options.replies ?? {})) queues[route as Route] = Array.isArray(reply) ? [...reply] : [reply as Reply];
  const defaults: Record<Route, Reply> = {
    list: { status: 200, body: listBody(GROUPS) },
    documents: { status: 200, body: docsBody([RESTRICTED(D_1), FALLBACK(D_2), audience(D_3)]) },
    access: { status: 200, body: { success: true, changed: 1, skipped: 0, notFound: 0, audiences: [audience(D_3, { kind: 'groups', groups: [{ id: G_A, name: 'group-a' }] })] } },
    status: { status: 200, body: STATUS },
  };
  const next = (route: Route): Reply => {
    const queue = queues[route];
    if (queue && queue.length > 1) return queue.shift()!;
    if (queue && queue.length === 1) return queue[0]!;
    return defaults[route];
  };
  const answer = (reply: Reply) => {
    if (reply.throws) throw new TypeError('Failed to fetch');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body)) };
  };
  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const route = routeOf(apiPath, String(init.method ?? 'GET'));
    calls.push({ route, path: apiPath, init, query: new URLSearchParams(apiPath.split('?')[1] ?? '') });
    if (route === 'unknown') throw new TypeError('unexpected request ' + apiPath);
    if (options.hold?.includes(route)) {
      const reply = await new Promise<Reply>((resolve) => held.set(route, [...(held.get(route) ?? []), resolve]));
      return answer(reply);
    }
    return answer(next(route));
  };

  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    location: { origin: 'http://config.local', search: '', hash: '' },
    setTimeout: (fn: () => void, ms = 0) => {
      timerId += 1;
      timers.set(timerId, { at: now + ms, fn });
      return timerId;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    AbortController,
    URLSearchParams,
    Intl,
    Date,
    ragFetch,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/access-groups.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-access') as FakeElement;
  const page = {
    doc,
    context,
    root,
    calls,
    count(route: Route) {
      return calls.filter((c) => c.route === route).length;
    },
    last(route: Route) {
      const found = calls.filter((c) => c.route === route);
      return found[found.length - 1]!;
    },
    body(route: Route): Json {
      return JSON.parse(String(page.last(route).init.body ?? 'null')) as Json;
    },
    release(route: Route, reply: Reply) {
      const resolve = (held.get(route) ?? []).shift();
      if (!resolve) throw new Error('nothing held for ' + route);
      resolve(reply);
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
      await flush();
    },
    async init() {
      await (context.initAccessGroupsPanel as () => Promise<void>)();
      await flush();
    },
    async openDocuments() {
      await page.init();
      (doc.getElementById('rag-access-groups-tab-documents') as FakeElement).click();
      await flush();
    },
    panel(): FakeElement {
      return doc.getElementById('rag-access-groups-panel-documents') as FakeElement;
    },
    status(): FakeElement {
      return root.querySelector('[data-access-groups-status]') as FakeElement;
    },
    rows(): FakeElement[] {
      return root.querySelectorAll('[data-access-groups-doc-row]');
    },
    row(id: string): FakeElement {
      const found = page.rows().find((r) => r.getAttribute('data-access-groups-doc-row') === id);
      if (!found) throw new Error('no row ' + id);
      return found;
    },
    visibleTo(id: string): FakeElement {
      return page.row(id).querySelector('[data-access-groups-visible-to]') as FakeElement;
    },
    editor(): FakeElement | null {
      return root.querySelector('[data-access-groups-editor]');
    },
    dialog(): FakeElement | null {
      return doc.querySelector('[data-access-groups-bulk-dialog]');
    },
  };
  return page;
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function button(root: FakeElement, text: string): FakeElement {
  const found = root.querySelectorAll('button').find((b) => b.textContent.trim() === text);
  if (!found) throw new Error('no button ' + text + ' in ' + root.querySelectorAll('button').map((b) => b.textContent.trim()).join(' | '));
  return found;
}

function choose(root: FakeElement, value: 'everyone' | 'groups') {
  const radio = root.querySelector('[data-access-groups-choice="' + value + '"]')!;
  radio.checked = true;
  radio.dispatch('change');
}

function addGroup(root: FakeElement, id: string) {
  const option = root.querySelector('[data-access-groups-add-option="' + id + '"]');
  if (!option) throw new Error('no add option ' + id);
  option.click();
}

function tick(page: ReturnType<typeof loadPage>, id: string, on = true) {
  const box = page.row(id).querySelector('[data-access-groups-select]')!;
  box.checked = on;
  box.dispatch('change');
}

function saveButton(root: FakeElement): FakeElement {
  return button(root, 'Save access');
}

describe('audience view-model (D-02, D-18, D-20, UI-SPEC 6.2.1)', () => {
  const m = loadModule();

  it('Everyone reads as plain text with Edit access', () => {
    const v = m.buildAccessGroupsAudienceView(audience(D_3), 'en')!;
    expect(v).toMatchObject({ kind: 'everyone', restricted: false, badge: null, text: 'Visible to: Everyone', reason: null, action: 'editAccess' });
  });

  it('named groups read as the Restricted badge with the names, and people at the source as a count only', () => {
    const v = m.buildAccessGroupsAudienceView(RESTRICTED(D_1, { peopleCount: 3 }), 'en')!;
    expect(v).toMatchObject({ kind: 'groups', badge: 'Restricted', text: 'Visible to: group-a, group-b', groups: ['group-a', 'group-b'], peopleCount: 3, peopleText: 'people at the source: 3', action: 'editAccess' });
    expect(v.summary).toBe('Visible to: group-a, group-b; people at the source: 3');
    expect(JSON.stringify(v)).not.toContain(G_A);
    expect(m.buildAccessGroupsAudienceView(RESTRICTED(D_1), 'zh')!.text).toBe('可见范围：group-a、group-b');
  });

  it('uploader and admins only carries its reason and one action', () => {
    const deleted = m.buildAccessGroupsAudienceView(FALLBACK(D_2), 'en')!;
    expect(deleted).toMatchObject({ kind: 'uploader_only', badge: 'Uploader and admins only', action: 'editAccess', reason: { code: 'group_deleted', known: true, text: 'Its access group was deleted.' } });
    const unmapped = m.buildAccessGroupsAudienceView(FALLBACK(D_2, { fallbackReason: 'unmapped_source', connectorManaged: true }), 'en')!;
    expect(unmapped.action).toBe('openMapping');
    expect(unmapped.reason!.text).toBe('Its sharing at the source is not mapped to an access group.');
    expect(m.buildAccessGroupsAudienceView(FALLBACK(D_2, { fallbackReason: 'source_error' }), 'it')!.badge).toBe('Solo chi ha caricato e amministratori');
  });

  it('an unknown reason sits inside reason.other; an unknown kind never reads as Everyone', () => {
    const v = m.buildAccessGroupsAudienceView(FALLBACK(D_2, { fallbackReason: 'mystery_code' }), 'en')!;
    expect(v.reason).toMatchObject({ code: 'mystery_code', known: false, text: 'Restricted by the system with the code mystery_code.' });
    const odd = m.buildAccessGroupsAudienceView(audience(D_2, { kind: 'strange' }), 'en')!;
    expect(odd.kind).toBe('uploader_only');
    expect(odd.reason!.code).toBe('strange');
    expect(m.buildAccessGroupsAudienceView(audience(D_2, { kind: 'groups', groups: [] }), 'en')!.kind).toBe('uploader_only');
  });

  it('a connector document that has not fallen back offers no action', () => {
    expect(m.buildAccessGroupsAudienceView(RESTRICTED(D_1, { connectorManaged: true }), 'en')!.action).toBeNull();
  });

  it('the list keeps cursor, personal flag and counts', () => {
    expect(m.buildAccessGroupsDocumentsList(docsBody([audience(D_1)], { nextCursor: 'c1' }))).toMatchObject({ personal: false, nextCursor: 'c1', counts: { restricted: 1, uploader_only: 1, everyone: 1, all: 3 } });
  });
});

describe('audience field rules (D-02, UI-SPEC 6.2.2)', () => {
  const m = loadModule();
  const row = (a: Json) => m.buildAccessGroupsDocumentRow(a)!;

  it('can never be saved empty', () => {
    expect(m.accessGroupsFieldFindings({ choice: 'groups', chips: [], groupCount: 2 })).toMatchObject({ canSave: false, needGroup: true, reasonKey: 'field.needGroup' });
    expect(m.accessGroupsFieldFindings({ choice: 'groups', chips: [G_A], groupCount: 2 }).canSave).toBe(true);
    expect(m.accessGroupsFieldFindings({ choice: 'everyone', chips: [], groupCount: 0 }).canSave).toBe(true);
    expect(m.accessGroupsFieldFindings({ choice: null, chips: [], groupCount: 2 })).toMatchObject({ canSave: false, reasonKey: 'field.choose' });
    expect(m.accessGroupsFieldFindings({ choice: 'groups', chips: [], groupCount: 0 })).toMatchObject({ choice: null, canSave: false, noGroups: true });
  });

  it('widens only when Everyone is chosen for a restricted document', () => {
    expect(m.accessGroupsFieldFindings({ choice: 'everyone', restrictedNow: true, groupCount: 1 })).toMatchObject({ widen: true, widenKey: 'field.widen' });
    expect(m.accessGroupsFieldFindings({ choice: 'everyone', restrictedNow: true, many: true, groupCount: 1 }).widenKey).toBe('field.widenMany');
    expect(m.accessGroupsFieldFindings({ choice: 'everyone', restrictedNow: false, groupCount: 1 }).widen).toBe(false);
  });

  it('pre-chooses one shared audience; uploader_only and mixed selections choose nothing', () => {
    expect(m.accessGroupsInitialChoice([row(RESTRICTED(D_1))])).toEqual({ choice: 'groups', chips: [G_A, G_B], mixed: false });
    expect(m.accessGroupsInitialChoice([row(audience(D_3)), row(audience(D_4))])).toEqual({ choice: 'everyone', chips: [], mixed: false });
    expect(m.accessGroupsInitialChoice([row(FALLBACK(D_2))])).toEqual({ choice: null, chips: [], mixed: false });
    expect(m.accessGroupsInitialChoice([row(audience(D_3)), row(RESTRICTED(D_1))])).toEqual({ choice: null, chips: [], mixed: true });
  });

  it('the body carries document ids and everyone or group ids only', () => {
    expect(m.accessGroupsAccessBody([D_1], 'everyone', [G_A])).toEqual({ documentIds: [D_1], everyone: true });
    expect(m.accessGroupsAccessBody([D_1, D_2], 'groups', [G_A, G_A, G_B])).toEqual({ documentIds: [D_1, D_2], groupIds: [G_A, G_B] });
    expect(m.accessGroupsAccessBody([D_1], 'groups', [])).toBeNull();
    expect(m.accessGroupsAccessBody([D_1], null, [G_A])).toBeNull();
  });

  it('the error mapper knows unknown_group and access_managed_by_connector', () => {
    expect(m.mapAccessGroupsError({ ok: false, status: 400, body: { error: 'unknown_group' } }, 'en', { write: true })).toMatchObject({ key: 'error.groupGone', kind: 'groupGone' });
    expect(m.mapAccessGroupsError({ ok: false, status: 409, body: { error: 'access_managed_by_connector' } }, 'en', { write: true })).toMatchObject({ key: 'docs.connectorManaged', reload: true });
  });
});

describe('Documents sub-view (D-17, D-28, UI-SPEC 6.4)', () => {
  it('is the second sub-tab, loads only when selected, with the Restricted filter by default', async () => {
    const page = loadPage();
    await page.init();
    const tabs = page.root.querySelectorAll('[role="tab"]').map((t) => t.textContent);
    expect(tabs).toEqual(['Groups: 3', 'Documents', 'Enforcement']);
    expect(page.count('documents')).toBe(0);
    (page.doc.getElementById('rag-access-groups-tab-documents') as FakeElement).click();
    await flush();
    expect(page.count('documents')).toBe(1);
    expect(page.last('documents').query.get('filter')).toBe('restricted');
    const filters = page.panel().querySelectorAll('[data-access-groups-doc-filter]');
    expect(filters.map((f) => f.getAttribute('aria-label'))).toEqual(['Restricted', 'Uploader and admins only', 'Everyone', 'All']);
    expect(filters[0]!.checked).toBe(true);
    expect(page.status().textContent).toBe('Documents shown: 3.');
  });

  it('a row shows each of the three audiences in the Visible to column', async () => {
    const page = loadPage({ replies: { documents: { status: 200, body: docsBody([RESTRICTED(D_1, { peopleCount: 2 }), FALLBACK(D_2), audience(D_3)]) } } });
    await page.openDocuments();
    expect(page.rows()).toHaveLength(3);
    const restricted = page.visibleTo(D_1);
    expect(restricted.querySelector('.badge')!.textContent).toBe('Restricted');
    expect(restricted.querySelector('.badge')!.querySelector('i')!.className).toContain('bi-lock');
    expect(restricted.textContent).toContain('Visible to: group-a, group-b');
    expect(restricted.textContent).toContain('people at the source: 2');
    const fallback = page.visibleTo(D_2);
    expect(fallback.querySelector('.badge')!.className).toContain('badge-warning');
    expect(fallback.querySelector('.badge')!.querySelector('i')!.className).toContain('bi-shield-exclamation');
    expect(fallback.textContent).toContain('Its access group was deleted.');
    const everyone = page.visibleTo(D_3);
    expect(everyone.querySelector('.badge')).toBeNull();
    expect(everyone.textContent).toBe('Visible to: Everyone');
    expect(button(page.row(D_3), 'Edit access').getAttribute('aria-label')).toBe('Edit access: document-3.pdf');
    expect(page.row(D_1).querySelector('th')!.getAttribute('scope')).toBe('row');
  });

  it('an unknown reason renders its code in font-mono inside reason.other', async () => {
    const page = loadPage({ replies: { documents: { status: 200, body: docsBody([FALLBACK(D_2, { fallbackReason: 'mystery_code' })]) } } });
    await page.openDocuments();
    const reason = page.visibleTo(D_2).querySelector('[data-access-groups-reason]')!;
    expect(reason.textContent).toBe('Restricted by the system with the code mystery_code.');
    expect(reason.querySelector('code')!.className).toContain('font-mono');
    expect(reason.querySelector('code')!.textContent).toBe('mystery_code');
  });

  it('filters, searches on Enter or after 400 ms, and pages by 50 with Load more documents', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => audience('00000000-0000-4000-8000-' + String(i).padStart(12, '0')));
    const page = loadPage({
      replies: {
        documents: [
          { status: 200, body: docsBody([RESTRICTED(D_1)]) },
          { status: 200, body: docsBody(fifty, { nextCursor: 'cursor-1' }) },
          { status: 200, body: docsBody([audience(D_4)]) },
          { status: 200, body: docsBody([audience(D_4)]) },
          { status: 200, body: docsBody([audience(D_4)]) },
        ],
      },
    });
    await page.openDocuments();
    const all = page.panel().querySelector('[data-access-groups-doc-filter="all"]')!;
    all.checked = true;
    all.dispatch('change');
    await flush();
    expect(page.last('documents').query.get('filter')).toBe('all');
    expect(page.rows()).toHaveLength(50);
    button(page.panel(), 'Load more documents').click();
    await flush();
    expect(page.last('documents').query.get('cursor')).toBe('cursor-1');
    expect(page.rows()).toHaveLength(51);
    expect(page.doc.activeElement!.getAttribute('data-access-groups-select')).toBe(D_4);
    const search = page.panel().querySelector('[data-access-groups-doc-search]')!;
    expect(page.panel().querySelector('label[for="' + search.id + '"]')!.textContent).toBe('Search by file name');
    search.value = 'report';
    search.dispatch('input');
    await flush();
    const before = page.count('documents');
    await page.advance(399);
    expect(page.count('documents')).toBe(before);
    await page.advance(1);
    expect(page.count('documents')).toBe(before + 1);
    expect(page.last('documents').query.get('q')).toBe('report');
    search.value = 'other';
    const enter = search.dispatch('keydown', { key: 'Enter' });
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(page.last('documents').query.get('q')).toBe('other');
  });

  it('Restricted with no row shows docs.empty.restricted; any other filter or a search shows docs.empty.filter', async () => {
    const page = loadPage({ replies: { documents: { status: 200, body: docsBody([]) } } });
    await page.openDocuments();
    const empty = page.panel().querySelector('[data-access-groups-docs-empty]')!;
    expect(empty.getAttribute('data-access-groups-docs-empty')).toBe('restricted');
    expect(empty.textContent).toContain('No restricted documents');
    expect(empty.textContent).toContain('Choose All, then Edit access, to restrict one.');
    const everyone = page.panel().querySelector('[data-access-groups-doc-filter="everyone"]')!;
    everyone.checked = true;
    everyone.dispatch('change');
    await flush();
    expect(page.panel().querySelector('[data-access-groups-docs-empty]')!.textContent).toBe('No document matches this filter. Choose All or clear the search.');
  });

  it('a personal workspace shows groups.personal; a failed load the unavailable sentence', async () => {
    const page = loadPage({ replies: { documents: { status: 200, body: { success: true, personal: true, documents: [], nextCursor: null, counts: {} } } } });
    await page.openDocuments();
    expect(page.panel().textContent).toContain('A personal workspace has one user, so it has no access groups.');
    const failed = loadPage({ replies: { documents: { status: 503, body: { success: false, error: 'access_groups_unavailable' } } } });
    await failed.openDocuments();
    expect(failed.panel().textContent).toContain('The document list is unavailable right now. Select Reload panel in a moment.');
  });

  it('follows the workspace selector', async () => {
    const page = loadPage({ workspace: { value: 'org-1', options: [['org-1', 'workspace-a'], ['org-2', 'workspace-b']] } });
    await page.openDocuments();
    expect(page.last('documents').query.get('organizationId')).toBe('org-1');
    const select = page.doc.getElementById('workspace-selector')!;
    select.value = 'org-2';
    select.dispatch('change');
    await flush();
    expect(page.last('documents').query.get('organizationId')).toBe('org-2');
  });
});

describe('editor row and single save (D-02, D-17, UI-SPEC 6.2.2, 6.4)', () => {
  it('Edit access opens the field; Only these groups with group-a enables Save access, which PUTs ids only and updates the row', async () => {
    const page = loadPage();
    await page.openDocuments();
    button(page.row(D_3), 'Edit access').click();
    const editor = page.editor()!;
    expect(editor.querySelector('h4')!.textContent).toBe('Who can see document-3.pdf?');
    const fieldset = editor.querySelector('fieldset')!;
    expect(fieldset.querySelector('legend')!.textContent).toBe('Visible to');
    expect(fieldset.querySelector('[data-access-groups-choice="everyone"]')!.checked).toBe(true);
    expect(page.doc.activeElement!.getAttribute('data-access-groups-choice')).toBe('everyone');
    expect(fieldset.textContent).toContain('Every user of this deployment, including embedded chat and WhatsApp.');
    expect(fieldset.textContent).not.toContain('Uploader and admins only');
    choose(editor, 'groups');
    const save = saveButton(editor);
    expect(save.disabled).toBe(true);
    const findings = editor.querySelector('[data-access-groups-findings]')!;
    expect(findings.hidden).toBe(false);
    expect(findings.textContent).toBe('Add at least one group, or choose Everyone.');
    expect(save.getAttribute('aria-describedby')).toBe(findings.id);
    addGroup(editor, G_A);
    expect(save.disabled).toBe(false);
    expect(findings.hidden).toBe(true);
    expect(editor.querySelector('[data-access-groups-chip-live]')!.textContent).toBe('group-a added');
    expect(editor.querySelector('[data-access-groups-chip-remove]')!.getAttribute('aria-label')).toBe('Remove group: group-a');
    save.click();
    await flush();
    expect(page.body('access')).toEqual({ documentIds: [D_3], groupIds: [G_A] });
    expect(page.last('access').query.has('organizationId')).toBe(false);
    expect(page.editor()).toBeNull();
    expect(page.visibleTo(D_3).textContent).toContain('Visible to: group-a');
    expect(page.visibleTo(D_3).querySelector('.badge')!.textContent).toBe('Restricted');
    expect(page.status().textContent).toBe('Access saved for document-3.pdf. Visible to: group-a');
    expect(page.doc.activeElement!.getAttribute('data-access-groups-edit-access')).toBe(D_3);
  });

  it('Everyone for a restricted document shows field.widen and sends everyone: true', async () => {
    const page = loadPage({ replies: { access: { status: 200, body: { success: true, changed: 1, skipped: 0, notFound: 0, audiences: [audience(D_1)] } } } });
    await page.openDocuments();
    button(page.row(D_1), 'Edit access').click();
    const editor = page.editor()!;
    expect(editor.querySelectorAll('[data-access-groups-chip]').map((c) => c.textContent)).toEqual(['group-a', 'group-b']);
    const widen = editor.querySelector('[data-access-groups-widen]')!;
    expect(widen.hidden).toBe(true);
    choose(editor, 'everyone');
    expect(widen.hidden).toBe(false);
    expect(widen.textContent).toBe('Everyone will be able to get answers from this document.');
    expect(editor.querySelector('[data-access-groups-chip-area]')!.hidden).toBe(true);
    choose(editor, 'groups');
    expect(editor.querySelectorAll('[data-access-groups-chip]')).toHaveLength(2);
    choose(editor, 'everyone');
    saveButton(editor).click();
    await flush();
    expect(page.body('access')).toEqual({ documentIds: [D_1], everyone: true });
    expect(page.status().textContent).toBe('Access saved for document-1.pdf. Visible to: Everyone');
  });

  it('an uploader-only document shows its current line and pre-chooses nothing', async () => {
    const page = loadPage();
    await page.openDocuments();
    button(page.row(D_2), 'Edit access').click();
    const editor = page.editor()!;
    expect(editor.textContent).toContain('Its access group was deleted.');
    const save = saveButton(editor);
    expect(save.disabled).toBe(true);
    expect(editor.querySelector('[data-access-groups-choice="everyone"]')!.checked).toBe(false);
    expect(editor.querySelector('[data-access-groups-choice="groups"]')!.checked).toBe(false);
    expect(page.doc.getElementById(save.getAttribute('aria-describedby')!)!.textContent).toBe('Choose Everyone or Only these groups.');
  });

  it('Cancel editing and Escape close the editor and return focus to Edit access; one row edits at a time', async () => {
    const page = loadPage();
    await page.openDocuments();
    button(page.row(D_3), 'Edit access').click();
    expect(button(page.row(D_3), 'Edit access').disabled).toBe(true);
    button(page.row(D_1), 'Edit access').click();
    expect(page.root.querySelectorAll('[data-access-groups-editor]')).toHaveLength(1);
    expect(page.editor()!.getAttribute('data-access-groups-editor')).toBe(D_1);
    button(page.editor()!, 'Cancel editing').click();
    expect(page.editor()).toBeNull();
    expect(page.doc.activeElement!.getAttribute('data-access-groups-edit-access')).toBe(D_1);
    button(page.row(D_3), 'Edit access').click();
    page.editor()!.dispatch('keydown', { key: 'Escape' });
    expect(page.editor()).toBeNull();
    expect(page.doc.activeElement!.getAttribute('data-access-groups-edit-access')).toBe(D_3);
  });

  it('chips wrap and the Add group menu is a details.dropdown capped at max-h-72', async () => {
    const page = loadPage();
    await page.openDocuments();
    button(page.row(D_1), 'Edit access').click();
    const editor = page.editor()!;
    expect(editor.querySelector('[data-access-groups-chips]')!.className).toContain('flex-wrap');
    expect(editor.querySelector('[data-access-groups-chips]')!.getAttribute('role')).toBe('list');
    const details = editor.querySelector('details')!;
    expect(details.className).toContain('dropdown');
    expect(details.querySelector('summary')!.textContent).toBe('Add group');
    const menu = editor.querySelector('[data-access-groups-add-menu]')!;
    expect(menu.className).toContain('max-h-72');
    expect(menu.className).toContain('overflow-y-auto');
    expect(menu.querySelectorAll('button').map((b) => b.textContent)).toEqual(['group-c']);
    addGroup(editor, G_C);
    const add = editor.querySelector('[data-access-groups-add-group]')!;
    expect(add.tagName).toBe('button');
    expect(add.disabled).toBe(true);
    const actions = saveButton(editor).parentNode!;
    const fieldset = editor.querySelector('fieldset')!;
    const kids = editor.children;
    expect(kids.indexOf(actions)).toBeGreaterThan(kids.indexOf(fieldset));
  });
});

describe('connector documents (D-20, UI-SPEC decision 9)', () => {
  it('Edit access and the checkbox are disabled with docs.connectorManaged', async () => {
    const page = loadPage({ replies: { documents: { status: 200, body: docsBody([RESTRICTED(D_1, { connectorManaged: true, source: 'nango' })]) } } });
    await page.openDocuments();
    const row = page.row(D_1);
    const edit = button(row, 'Edit access');
    expect(edit.disabled).toBe(true);
    expect(row.querySelector('[data-access-groups-select]')!.disabled).toBe(true);
    const note = row.querySelector('[data-access-groups-managed]')!;
    expect(note.textContent).toBe('Access follows the sharing at the source. Change it there, or change the connector mapping.');
    expect(edit.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('a fallen-back connector document offers Open connector mapping, which selects that sub-tab and focuses its heading', async () => {
    const page = loadPage({ replies: { documents: { status: 200, body: docsBody([FALLBACK(D_2, { connectorManaged: true, fallbackReason: 'unmapped_source' })]) } } });
    await page.openDocuments();
    const open = button(page.row(D_2), 'Open connector mapping');
    expect(page.visibleTo(D_2).textContent).toContain('Its sharing at the source is not mapped to an access group.');
    expect(page.row(D_2).querySelector('[data-access-groups-managed]')).toBeTruthy();
    // Until plan 44 mounts the Connector mapping sub-tab, the button is disabled and described by docs.connectorManaged.
    expect(open.disabled).toBe(true);
    const instance = page.context.accessGroupsPanel as { tabs: { panels: Record<string, FakeElement>; select: (id: string) => void }; renderDocuments: () => void };
    const heading = page.doc.createElement('h4');
    heading.setAttribute('data-access-groups-mapping-heading', '');
    const mappingPanel = page.doc.createElement('div');
    mappingPanel.appendChild(heading);
    const selected: string[] = [];
    const realSelect = instance.tabs.select;
    instance.tabs.panels.mapping = mappingPanel;
    instance.tabs.select = (id: string) => {
      selected.push(id);
      if (id !== 'mapping') realSelect(id);
    };
    instance.renderDocuments();
    const enabled = button(page.row(D_2), 'Open connector mapping');
    expect(enabled.disabled).toBe(false);
    enabled.click();
    expect(selected).toEqual(['mapping']);
    expect(page.doc.activeElement).toBe(heading);
  });

  it('a 409 access_managed_by_connector on a single save says docs.connectorManaged and reloads', async () => {
    const page = loadPage({ replies: { access: { status: 409, body: { success: false, error: 'access_managed_by_connector' } } } });
    await page.openDocuments();
    const before = page.count('documents');
    button(page.row(D_3), 'Edit access').click();
    choose(page.editor()!, 'groups');
    addGroup(page.editor()!, G_A);
    saveButton(page.editor()!).click();
    await flush();
    expect(page.status().textContent).toContain('Access follows the sharing at the source.');
    expect(page.count('documents')).toBe(before + 1);
  });
});

describe('selection and bulk dialog (D-17, UI-SPEC decision 7, 9.10)', () => {
  it('ticking rows shows the selection bar, announced once; the header checkbox selects the rows on screen and shows the mixed state', async () => {
    const page = loadPage({ replies: { documents: { status: 200, body: docsBody([RESTRICTED(D_1), audience(D_3), audience(D_4), RESTRICTED(D_2, { connectorManaged: true })]) } } });
    await page.openDocuments();
    const bar = page.panel().querySelector('[data-access-groups-selection]')!;
    expect(bar.hidden).toBe(true);
    tick(page, D_1);
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Selected: 1');
    expect(page.status().textContent).toBe('Selected: 1');
    page.status().textContent = '';
    tick(page, D_3);
    expect(bar.textContent).toContain('Selected: 2');
    expect(page.status().textContent).toBe('');
    const header = page.panel().querySelector('[data-access-groups-select-all]')!;
    expect(header.getAttribute('aria-label')).toBe('Select all documents shown');
    expect((header as unknown as { indeterminate: boolean }).indeterminate).toBe(true);
    header.checked = true;
    header.dispatch('change');
    expect(bar.textContent).toContain('Selected: 3');
    expect((header as unknown as { indeterminate: boolean }).indeterminate).toBe(false);
    expect(page.row(D_2).querySelector('[data-access-groups-select]')!.checked).toBe(false);
    button(bar, 'Clear selection').click();
    expect(bar.hidden).toBe(true);
    expect(page.row(D_1).querySelector('[data-access-groups-select]')!.getAttribute('aria-label')).toBe('Select document-1.pdf');
  });

  it('one way at a time: ticking a row closes the editor, opening the editor clears the selection', async () => {
    const page = loadPage();
    await page.openDocuments();
    button(page.row(D_3), 'Edit access').click();
    expect(page.editor()).toBeTruthy();
    tick(page, D_1);
    expect(page.editor()).toBeNull();
    expect(page.row(D_1).querySelector('[data-access-groups-select]')!.checked).toBe(true);
    button(page.row(D_3), 'Edit access').click();
    expect(page.panel().querySelector('[data-access-groups-selection]')!.hidden).toBe(true);
    expect(page.row(D_1).querySelector('[data-access-groups-select]')!.checked).toBe(false);
  });

  it('Change access opens a dialog.modal with bulk.title, bulk.selected and the field; a mixed selection chooses nothing', async () => {
    const page = loadPage();
    await page.openDocuments();
    tick(page, D_1);
    tick(page, D_3);
    button(page.panel(), 'Change access').click();
    const dialog = page.dialog()!;
    expect(dialog.className).toContain('modal');
    expect(dialog.open).toBe(true);
    expect(page.doc.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Who can see the selected documents?');
    expect(page.doc.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('Selected: 2');
    expect(page.doc.activeElement!.textContent).toBe('Keep current access');
    const mixed = dialog.querySelector('[data-access-groups-mixed]')!;
    expect(mixed.hidden).toBe(false);
    expect(mixed.textContent).toBe('The selected documents have different access now. Your choice replaces it for all of them.');
    expect(dialog.querySelector('[data-access-groups-choice="everyone"]')!.checked).toBe(false);
    expect(dialog.querySelector('[data-access-groups-choice="groups"]')!.checked).toBe(false);
    const save = saveButton(dialog);
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-describedby')).toBe(mixed.id);
    choose(dialog, 'everyone');
    expect(dialog.querySelector('[data-access-groups-widen]')!.textContent).toBe('Everyone will be able to get answers from the selected documents.');
    expect(save.disabled).toBe(false);
  });

  it('saves the choice for every selected document, announces save.doneMany and save.skipped, and clears the selection', async () => {
    const page = loadPage({ replies: { access: { status: 200, body: { success: true, changed: 2, skipped: 1, notFound: 0, audiences: [] } } } });
    await page.openDocuments();
    tick(page, D_1);
    tick(page, D_3);
    button(page.panel(), 'Change access').click();
    const dialog = page.dialog()!;
    choose(dialog, 'groups');
    addGroup(dialog, G_C);
    saveButton(dialog).click();
    await flush();
    expect(page.body('access')).toEqual({ documentIds: [D_1, D_3], groupIds: [G_C] });
    expect(page.dialog()).toBeNull();
    expect(page.status().textContent).toBe('Access saved. Documents changed: 2. Not changed, because their access follows a connector: 1.');
    expect(page.panel().querySelector('[data-access-groups-selection]')!.hidden).toBe(true);
    expect(page.doc.activeElement).toBe(page.status());
  });

  it('Keep current access closes without saving; Escape is refused while the save runs', async () => {
    const page = loadPage({ hold: ['access'] });
    await page.openDocuments();
    tick(page, D_3);
    button(page.panel(), 'Change access').click();
    button(page.dialog()!, 'Keep current access').click();
    expect(page.dialog()).toBeNull();
    expect(page.count('access')).toBe(0);
    expect(page.doc.activeElement!.textContent).toBe('Change access');
    button(page.panel(), 'Change access').click();
    const dialog = page.dialog()!;
    choose(dialog, 'everyone');
    saveButton(dialog).click();
    await flush();
    const cancel = dialog.dispatch('cancel');
    expect(cancel.defaultPrevented).toBe(true);
    page.release('access', { status: 200, body: { success: true, changed: 1, skipped: 0, notFound: 0, audiences: [] } });
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.status().textContent).toBe('Access saved. Documents changed: 1.');
  });

  it('a 404 or 409 says error.changed and reloads; a timeout says error.outcomeUnknown', async () => {
    const page = loadPage({ replies: { access: [{ status: 409, body: { success: false, error: 'conflict' } }, { status: 0, throws: true }] } });
    await page.openDocuments();
    tick(page, D_3);
    button(page.panel(), 'Change access').click();
    choose(page.dialog()!, 'everyone');
    saveButton(page.dialog()!).click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.status().textContent).toContain('changed');
    const after = page.count('documents');
    expect(after).toBe(2);
    button(page.row(D_3), 'Edit access').click();
    choose(page.editor()!, 'everyone');
    saveButton(page.editor()!).click();
    await flush();
    expect(page.status().textContent).toContain('the change may or may not have been made');
    expect(page.count('documents')).toBe(3);
  });
});

describe('field edge states (UI Considerations)', () => {
  it('no group in the workspace: the second radio is disabled with field.noGroups and Everyone stays available', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: listBody([]) } } });
    await page.openDocuments();
    button(page.row(D_3), 'Edit access').click();
    const editor = page.editor()!;
    const second = editor.querySelector('[data-access-groups-choice="groups"]')!;
    expect(second.disabled).toBe(true);
    expect(page.doc.getElementById(second.getAttribute('aria-describedby')!)!.textContent).toBe('No access groups yet. Create one first.');
    expect(editor.querySelector('[data-access-groups-choice="everyone"]')!.disabled).toBe(false);
  });

  it('400 unknown_group: error.groupGone, the groups reload and the remaining chips stay', async () => {
    const page = loadPage({
      replies: {
        list: [{ status: 200, body: listBody(GROUPS) }, { status: 200, body: listBody([GROUPS[0]!, GROUPS[2]!]) }],
        access: { status: 400, body: { success: false, error: 'unknown_group' } },
      },
    });
    await page.openDocuments();
    button(page.row(D_1), 'Edit access').click();
    const editor = page.editor()!;
    const lists = page.count('list');
    saveButton(editor).click();
    await flush();
    expect(page.count('list')).toBe(lists + 1);
    expect(page.status().textContent).toBe('Not saved. One of the chosen groups no longer exists. The groups have been reloaded.');
    expect(page.editor()).toBe(editor);
    expect(editor.querySelectorAll('[data-access-groups-chip]').map((c) => c.textContent)).toEqual(['group-a']);
    expect(editor.textContent).toContain('One of the chosen groups no longer exists.');
  });

  it('removing a chip moves focus to the next chip, then to Add group, and announces chip.removed', async () => {
    const page = loadPage();
    await page.openDocuments();
    button(page.row(D_1), 'Edit access').click();
    const editor = page.editor()!;
    (editor.querySelector('[data-access-groups-chip-remove="' + G_A + '"]') as FakeElement).click();
    expect(editor.querySelector('[data-access-groups-chip-live]')!.textContent).toBe('group-a removed');
    expect(page.doc.activeElement!.getAttribute('data-access-groups-chip-remove')).toBe(G_B);
    (editor.querySelector('[data-access-groups-chip-remove="' + G_B + '"]') as FakeElement).click();
    expect(page.doc.activeElement!.hasAttribute('data-access-groups-add-group')).toBe(true);
    expect(saveButton(editor).disabled).toBe(true);
  });
});

describe('injection, keys and copy (T-04.3-432, T-04.3-433)', () => {
  it('markup in file names and group names creates no element and no link, and no key is rendered', async () => {
    const evil = audience(D_1, { filename: XSS_PAYLOAD + '.pdf', kind: 'groups', groups: [{ id: G_A, name: 'javascript:' + XSS_PAYLOAD }] });
    const page = loadPage({ replies: { list: { status: 200, body: listBody([group(G_A, 'javascript:' + XSS_PAYLOAD)]) }, documents: { status: 200, body: docsBody([evil, FALLBACK(D_2, { fallbackReason: XSS_PAYLOAD })]) } } });
    await page.openDocuments();
    button(page.row(D_1), 'Edit access').click();
    tick(page, D_2);
    button(page.panel(), 'Change access').click();
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.root.querySelectorAll('a')).toHaveLength(0);
    expect(page.row(D_1).textContent).toContain(XSS_PAYLOAD);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.root.textContent).not.toMatch(/\bg:|\bu:|principal/);
  });

  it('a 200-character file name breaks in the table and in the editor title', async () => {
    const long = 'x'.repeat(200) + '.pdf';
    const page = loadPage({ replies: { documents: { status: 200, body: docsBody([audience(D_3, { filename: long })]) } } });
    await page.openDocuments();
    expect(page.row(D_3).querySelector('[data-access-groups-doc-name]')!.className).toContain('break-words');
    button(page.row(D_3), 'Edit access').click();
    expect(page.editor()!.querySelector('h4')!.className).toContain('break-words');
  });

  it('renders zh and it, including the long it filter label', async () => {
    const it = loadPage({ locale: 'it-IT' });
    await it.openDocuments();
    expect(it.panel().querySelector('[data-access-groups-doc-filter="uploader_only"]')!.getAttribute('aria-label')).toBe('Solo chi ha caricato e amministratori');
    expect(it.panel().querySelector('[data-access-groups-doc-filters]')!.className).toContain('flex-wrap');
    const zh = loadPage({ locale: 'zh-CN' });
    await zh.openDocuments();
    expect(button(zh.row(D_3), '编辑可见范围')).toBeTruthy();
  });

  it('responsive columns: Document type and Source hide below lg, Visible to below md with the line under the file name', async () => {
    const page = loadPage();
    await page.openDocuments();
    const heads = page.panel().querySelectorAll('thead th');
    expect(heads.map((h) => h.className.includes('hidden'))).toEqual([false, false, true, true, true, false]);
    expect(heads[2]!.className).toContain('lg:table-cell');
    expect(heads[3]!.className).toContain('md:table-cell');
    const file = page.row(D_1).querySelector('th')!;
    expect(file.querySelector('[data-access-groups-audience]')!.className).toContain('md:hidden');
    expect(file.textContent).toContain('config_upload');
    const region = page.panel().querySelector('[data-access-groups-docs-table]')!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).toBe('0');
  });

  it('the panel never chains array methods on a NodeList (regression: browsers have no NodeList.filter or .find)', () => {
    expect(panelSource).not.toMatch(/(?<!Array\.from\()[\w.]*querySelectorAll\([^)]*\)\.(filter|find|map|some|every)\(/);
  });
});

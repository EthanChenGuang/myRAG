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

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}
type Route = 'list' | 'create' | 'rename' | 'delete' | 'impact' | 'members' | 'addMember' | 'removeMember' | 'candidates' | 'status';

interface GroupsModule {
  buildAccessGroupsGroupRow: (group: Json) => Json | null;
  buildAccessGroupsList: (body: Json) => { personal: boolean; rows: Json[]; nextCursor: string | null };
  accessGroupsSuggestKey: (name: string) => string;
  accessGroupsFormFindings: (name: string, key: string) => { findings: Array<{ field: string; key: string }>; valid: boolean };
  accessGroupsMemberName: (member: Json) => { text: string; mono: boolean };
  buildAccessGroupsImpactView: (body: Json) => Json | null;
  accessGroupsCountLabel: (template: string) => string;
  mapAccessGroupsError: (result: Json | null, locale: string, ctx?: Json) => { key: string; kind: string; field?: string; count?: number | null; reload?: boolean };
}

function loadModule(): GroupsModule {
  return require('../../scripts/config-ui/rag-panels/access-groups.js') as GroupsModule;
}

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const USER_1 = '00000000-0000-4000-8000-000000000001';
const USER_2 = '00000000-0000-4000-8000-000000000002';
const USER_3 = '00000000-0000-4000-8000-000000000003';

function group(id: string, extra: Json = {}): Json {
  return { id, key: 'group-' + id.slice(-1), name: 'group-' + id.slice(-1), source: 'manual', createdAt: '2026-11-26T09:00:00.000Z', memberCount: 4, documentCount: 12, ...extra };
}

function listBody(groups: Json[], extra: Json = {}): Json {
  return { success: true, personal: false, enabled: true, groups, nextCursor: null, alerts: { unmappedSourceGroups: 0, enforcement: {} }, ...extra };
}

const STATUS = { success: true, status: { runningSwitch: 'on', databaseFlag: true, status: 'ready', ready: true, reasons: [], objects: [], embedGroup: null, checkedAt: '2026-11-26T10:00:00.000Z' } };

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const base = '/api/rag/access-groups';
  const pathOnly = apiPath.split('?')[0]!;
  if (!pathOnly.startsWith(base)) return 'unknown';
  const rest = pathOnly.slice(base.length);
  if (rest === '' && method === 'GET') return 'list';
  if (rest === '' && method === 'POST') return 'create';
  if (rest === '/status' && method === 'GET') return 'status';
  if (rest === '/members/candidates' && method === 'GET') return 'candidates';
  if (/^\/[^/]+$/.test(rest) && method === 'PATCH') return 'rename';
  if (/^\/[^/]+$/.test(rest) && method === 'DELETE') return 'delete';
  if (/^\/[^/]+\/impact$/.test(rest) && method === 'GET') return 'impact';
  if (/^\/[^/]+\/members$/.test(rest) && method === 'GET') return 'members';
  if (/^\/[^/]+\/members$/.test(rest) && method === 'POST') return 'addMember';
  if (/^\/[^/]+\/members\/[^/]+$/.test(rest) && method === 'DELETE') return 'removeMember';
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
    container.className = 'mb-4';
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
    list: { status: 200, body: listBody([group(ID_A), group(ID_B, { source: 'connector', memberCount: 0, documentCount: 3 })]) },
    create: { status: 201, body: { success: true, group: { id: ID_B, key: 'group-new', name: 'group-new', source: 'manual', createdAt: '2026-11-26T10:00:00.000Z' } } },
    rename: { status: 200, body: { success: true, group: { id: ID_A, key: 'group-a', name: 'group-renamed', source: 'manual' } } },
    delete: { status: 200, body: { success: true, fellBack: 7, relabelled: 12 } },
    impact: { status: 200, body: { success: true, impact: { onlyCount: 7, sharedCount: 5, memberCount: 4, mappingCount: 0 } } },
    members: { status: 200, body: { success: true, members: [{ userId: USER_1, displayName: 'member-a', email: 'a@example.org', addedAt: '2026-11-26T09:30:00.000Z', source: 'manual' }] } },
    addMember: { status: 201, body: { success: true, member: { groupId: ID_A, userId: USER_2, addedAt: '2026-11-26T10:00:00.000Z' } } },
    removeMember: { status: 200, body: { success: true, removed: true } },
    candidates: { status: 200, body: { success: true, candidates: [{ userId: USER_1, displayName: 'member-a', email: 'a@example.org', already: true }, { userId: USER_2, displayName: 'member-b', email: 'b@example.org', already: false }] } },
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
  const fakeSetTimeout = (fn: () => void, ms = 0) => {
    timerId += 1;
    timers.set(timerId, { at: now + ms, fn });
    return timerId;
  };
  const fakeClearTimeout = (id: number) => {
    timers.delete(id);
  };

  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    location: { origin: 'http://config.local', search: '', hash: '' },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
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
      const queue = held.get(route) ?? [];
      const resolve = queue.shift();
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
      const init = context.initAccessGroupsPanel as () => Promise<void>;
      await init();
      await flush();
    },
    groupsPanel(): FakeElement {
      return doc.getElementById('rag-access-groups-panel-groups') as FakeElement;
    },
    statusRegion(): FakeElement {
      return root.querySelector('[data-access-groups-status]') as FakeElement;
    },
    rows(): FakeElement[] {
      return root.querySelectorAll('[data-access-groups-row]');
    },
    row(id: string): FakeElement {
      const found = page.rows().find((r) => r.getAttribute('data-access-groups-row') === id);
      if (!found) throw new Error('no row ' + id);
      return found;
    },
    dialog(): FakeElement | null {
      return doc.querySelector('[data-access-groups-delete-dialog]');
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

function type(input: FakeElement, value: string) {
  input.value = value;
  input.dispatch('input');
}

function many(count: number, offset = 0): Json[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + offset).padStart(12, '0');
    return group('00000000-0000-4000-8000-' + n, { key: 'group-' + (i + offset), name: 'group-' + (i + offset) });
  });
}

describe('pure builders (D-01, UI-SPEC 6.3)', () => {
  const m = loadModule();

  it('a group row carries name, key, counts and the connector badge flag', () => {
    expect(m.buildAccessGroupsGroupRow(group(ID_B, { source: 'connector', memberCount: 2, documentCount: 9 }))).toEqual({
      id: ID_B,
      key: 'group-b',
      name: 'group-b',
      source: 'connector',
      connector: true,
      memberCount: 2,
      documentCount: 9,
    });
    expect(m.buildAccessGroupsGroupRow(group(ID_A))!.connector).toBe(false);
    expect(m.buildAccessGroupsGroupRow({ name: 'x' })).toBeNull();
  });

  it('the list keeps the cursor and the personal flag', () => {
    expect(m.buildAccessGroupsList(listBody([group(ID_A)], { nextCursor: 'c1' }))).toMatchObject({ personal: false, nextCursor: 'c1' });
    expect(m.buildAccessGroupsList({ success: true, personal: true, groups: [] }).personal).toBe(true);
  });

  it('suggests a key from ASCII letters, digits and hyphens, and nothing without an ASCII letter', () => {
    expect(m.accessGroupsSuggestKey('Group A 2')).toBe('group-a-2');
    expect(m.accessGroupsSuggestKey('  --Group__B!! ')).toBe('group-b');
    expect(m.accessGroupsSuggestKey('访问组')).toBe('');
    expect(m.accessGroupsSuggestKey('123')).toBe('');
    expect(m.accessGroupsSuggestKey('All')).toBe('');
    expect(m.accessGroupsSuggestKey('x'.repeat(80))).toHaveLength(63);
  });

  it('the form refuses an empty name, a bad key and the reserved key all', () => {
    expect(m.accessGroupsFormFindings('', '').findings.map((f) => f.key)).toEqual(['form.needName', 'form.badKey']);
    expect(m.accessGroupsFormFindings('group-a', 'all')).toEqual({ findings: [{ field: 'key', key: 'form.reservedKey' }], valid: false });
    expect(m.accessGroupsFormFindings('group-a', '-group').valid).toBe(false);
    expect(m.accessGroupsFormFindings('group-a', 'Group-A').valid).toBe(false);
    expect(m.accessGroupsFormFindings('group-a', 'group-a').valid).toBe(true);
  });

  it('the error mapper places group_exists at the Key field', () => {
    expect(m.mapAccessGroupsError({ ok: false, status: 409, body: { error: 'group_exists' } }, 'en', { write: true })).toMatchObject({ key: 'error.groupExists', field: 'key' });
  });
});

describe('Groups sub-view: list, empty, personal (D-28, UI-SPEC 6.3, 7.2)', () => {
  it('Groups is the default sub-tab, first in the list, with the count', async () => {
    const page = loadPage();
    await page.init();
    const tabs = page.root.querySelectorAll('[role="tab"]');
    expect(tabs[0]!.id).toBe('rag-access-groups-tab-groups');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.textContent).toBe('Groups: 2');
    expect(page.groupsPanel().hidden).toBe(false);
    expect(page.doc.getElementById('rag-access-groups-panel-enforcement')!.hidden).toBe(true);
  });

  it('lists name, mono key, connector badge, counts and the three actions', async () => {
    const page = loadPage();
    await page.init();
    expect(page.rows()).toHaveLength(2);
    const a = page.row(ID_A);
    const head = a.querySelector('th')!;
    expect(head.getAttribute('scope')).toBe('row');
    expect(head.querySelector('[data-access-groups-name]')!.textContent).toBe('group-a');
    expect(head.querySelector('code')!.textContent).toBe('group-a');
    expect(head.querySelector('code')!.className).toContain('font-mono');
    expect(a.querySelectorAll('td').map((td) => td.textContent).slice(0, 2)).toEqual(['4', '12']);
    expect(a.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Manage members', 'Rename group', 'Delete group']);
    expect(button(a, 'Delete group').getAttribute('aria-label')).toBe('Delete group: group-a');
    expect(page.row(ID_B).textContent).toContain('From a connector');
    expect(a.textContent).not.toContain('From a connector');
    const region = page.root.querySelector('[data-access-groups-table]')!;
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('role')).toBe('region');
    expect(page.statusRegion().textContent).not.toBe('');
    expect(page.root.querySelector('[data-access-groups-updated]')!.querySelector('time')).toBeTruthy();
  });

  it('shows the empty state with New group as the next step', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: listBody([]) } } });
    await page.init();
    const empty = page.root.querySelector('[data-access-groups-empty]')!;
    expect(empty.textContent).toContain('No access groups yet');
    expect(empty.textContent).toContain('Select New group.');
    expect(button(page.groupsPanel(), 'New group').hidden).toBe(false);
  });

  it('a personal workspace shows groups.personal and no New group', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: { success: true, personal: true, enabled: true, groups: [], nextCursor: null } } } });
    await page.init();
    expect(page.groupsPanel().textContent).toContain('A personal workspace has one user, so it has no access groups.');
    expect(button(page.groupsPanel(), 'New group').hidden).toBe(true);
    expect(page.rows()).toHaveLength(0);
  });

  it('follows #workspace-selector: the workspace line, organizationId and a reload on change', async () => {
    const page = loadPage({ workspace: { value: 'org-1', options: [['', 'Default Workspace'], ['org-1', 'workspace-a'], ['org-2', 'workspace-b']] } });
    await page.init();
    expect(page.root.querySelector('[data-access-groups-workspace]')!.textContent).toBe('Workspace: workspace-a');
    expect(page.last('list').query.get('organizationId')).toBe('org-1');
    const select = page.doc.getElementById('workspace-selector')!;
    select.value = 'org-2';
    select.dispatch('change');
    await flush();
    expect(page.last('list').query.get('organizationId')).toBe('org-2');
    expect(page.root.querySelector('[data-access-groups-workspace]')!.textContent).toBe('Workspace: workspace-b');
  });

  it('single-tenant: no workspace line and no organizationId', async () => {
    const page = loadPage();
    await page.init();
    const line = page.root.querySelector('[data-access-groups-workspace]');
    expect(!line || line.hidden).toBe(true);
    expect(page.last('list').query.has('organizationId')).toBe(false);
  });

  it('pages by 50 with Load more groups and moves focus to the first new row', async () => {
    const page = loadPage({
      replies: {
        list: [
          { status: 200, body: listBody(many(50), { nextCursor: 'cursor-1' }) },
          { status: 200, body: listBody(many(10, 50)) },
        ],
      },
    });
    await page.init();
    expect(page.rows()).toHaveLength(50);
    expect(page.last('list').query.get('limit')).toBe('50');
    expect(page.root.querySelector('[role="tab"]')!.textContent).toBe('Groups');
    button(page.groupsPanel(), 'Load more groups').click();
    await flush();
    expect(page.last('list').query.get('cursor')).toBe('cursor-1');
    expect(page.rows()).toHaveLength(60);
    expect(page.doc.activeElement!.getAttribute('data-access-groups-manage')).toBe(page.rows()[50]!.getAttribute('data-access-groups-row'));
    expect(page.root.querySelector('[data-access-groups-load-more]')).toBeNull();
  });

  it('a failed first load shows the unavailable sentence with Reload panel', async () => {
    const page = loadPage({ replies: { list: { status: 503, body: { success: false, error: 'access_groups_unavailable' } } } });
    await page.init();
    expect(page.groupsPanel().textContent).toContain('Access groups are unavailable right now. Select Reload panel in a moment.');
    expect(button(page.groupsPanel(), 'Reload panel')).toBeTruthy();
  });
});

describe('New group form (D-01, UI-SPEC 6.3, 9.5, 9.6)', () => {
  it('untouched: Create group is disabled and the findings line names the missing fields', async () => {
    const page = loadPage();
    await page.init();
    button(page.groupsPanel(), 'New group').click();
    const create = button(page.groupsPanel(), 'Create group');
    expect(create.disabled).toBe(true);
    expect(create.getAttribute('aria-describedby')).toContain('rag-access-groups-findings');
    expect(page.doc.getElementById('rag-access-groups-findings')!.textContent).toContain('Enter a name.');
    expect(page.doc.activeElement!.id).toBe('rag-access-groups-name');
    expect(button(page.groupsPanel(), 'New group').getAttribute('aria-expanded')).toBe('true');
    const key = page.doc.getElementById('rag-access-groups-key')!;
    expect(key.getAttribute('autocomplete')).toBe('off');
    expect(key.getAttribute('spellcheck')).toBe('false');
    expect(key.getAttribute('translate')).toBe('no');
  });

  it('suggests the key from the name, posts the body, closes, announces and focuses Manage members of the new row', async () => {
    const page = loadPage({
      replies: { list: [{ status: 200, body: listBody([group(ID_A)]) }, { status: 200, body: listBody([group(ID_A), group(ID_B, { key: 'group-new', name: 'group-new', memberCount: 0, documentCount: 0 })]) }] },
    });
    await page.init();
    button(page.groupsPanel(), 'New group').click();
    type(page.doc.getElementById('rag-access-groups-name')!, 'Group New');
    expect(page.doc.getElementById('rag-access-groups-key')!.value).toBe('group-new');
    const create = button(page.groupsPanel(), 'Create group');
    expect(create.disabled).toBe(false);
    create.click();
    await flush();
    expect(page.count('create')).toBe(1);
    expect(page.body('create')).toEqual({ key: 'group-new', name: 'Group New' });
    expect(page.root.querySelector('[data-access-groups-form]')).toBeNull();
    expect(page.statusRegion().textContent).toBe('Group group-new created. Add members, then restrict documents to it.');
    expect(page.doc.activeElement!.getAttribute('data-access-groups-manage')).toBe(ID_B);
  });

  it('refuses the key all and an invalid key in the browser', async () => {
    const page = loadPage();
    await page.init();
    button(page.groupsPanel(), 'New group').click();
    type(page.doc.getElementById('rag-access-groups-name')!, 'group-x');
    const key = page.doc.getElementById('rag-access-groups-key')!;
    type(key, 'all');
    expect(button(page.groupsPanel(), 'Create group').disabled).toBe(true);
    expect(page.doc.getElementById('rag-access-groups-key-error')!.textContent).toBe('The key "all" is reserved. Enter another key.');
    expect(key.getAttribute('aria-invalid')).toBe('true');
    type(key, 'Bad Key');
    expect(button(page.groupsPanel(), 'Create group').disabled).toBe(true);
    expect(page.doc.getElementById('rag-access-groups-key-error')!.textContent).toContain('Use lower-case letters');
    button(page.groupsPanel(), 'Create group').click();
    await flush();
    expect(page.count('create')).toBe(0);
    type(key, 'group-x');
    expect(button(page.groupsPanel(), 'Create group').disabled).toBe(false);
    expect(key.getAttribute('aria-invalid')).toBeNull();
  });

  it('a name without an ASCII letter suggests no key and the key stays required', async () => {
    const page = loadPage();
    await page.init();
    button(page.groupsPanel(), 'New group').click();
    type(page.doc.getElementById('rag-access-groups-name')!, '访问组');
    expect(page.doc.getElementById('rag-access-groups-key')!.value).toBe('');
    expect(button(page.groupsPanel(), 'Create group').disabled).toBe(true);
  });

  it('409 group_exists: error.groupExists at the Key field, focus on it, values kept', async () => {
    const page = loadPage({ replies: { create: { status: 409, body: { success: false, error: 'group_exists' } } } });
    await page.init();
    button(page.groupsPanel(), 'New group').click();
    type(page.doc.getElementById('rag-access-groups-name')!, 'group-a');
    button(page.groupsPanel(), 'Create group').click();
    await flush();
    const key = page.doc.getElementById('rag-access-groups-key')!;
    expect(page.doc.getElementById('rag-access-groups-key-error')!.textContent).toBe('A group with this key already exists. Change the key.');
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(key.getAttribute('aria-describedby')).toContain('rag-access-groups-key-error');
    expect(page.doc.activeElement).toBe(key);
    expect(key.value).toBe('group-a');
    expect(page.doc.getElementById('rag-access-groups-name')!.value).toBe('group-a');
  });

  it('Escape closes the form and returns focus to New group', async () => {
    const page = loadPage();
    await page.init();
    const open = button(page.groupsPanel(), 'New group');
    open.click();
    page.doc.getElementById('rag-access-groups-name')!.dispatch('keydown', { key: 'Escape' });
    expect(page.root.querySelector('[data-access-groups-form]')).toBeNull();
    expect(page.doc.activeElement).toBe(open);
    expect(open.getAttribute('aria-expanded')).toBe('false');
  });

  it('a refresh keeps the open form and its values', async () => {
    const page = loadPage();
    await page.init();
    button(page.groupsPanel(), 'New group').click();
    type(page.doc.getElementById('rag-access-groups-name')!, 'group-keep');
    await page.init();
    expect(page.doc.getElementById('rag-access-groups-name')!.value).toBe('group-keep');
    expect(page.doc.getElementById('rag-access-groups-key')!.value).toBe('group-keep');
  });
});

describe('injection (T-04.3-421)', () => {
  it('markup in group names and keys creates no element and no link', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: listBody([group(ID_A, { name: XSS_PAYLOAD, key: 'javascript:' + XSS_PAYLOAD })]) } } });
    await page.init();
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.root.querySelectorAll('a')).toHaveLength(0);
    expect(page.row(ID_A).textContent).toContain(XSS_PAYLOAD);
    expect(page.doc.innerHtmlWrites).toBe(0);
  });
});

describe('Rename group (D-01)', () => {
  it('turns the name into an input with Save name and Cancel editing; the key stays', async () => {
    const page = loadPage();
    await page.init();
    button(page.row(ID_A), 'Rename group').click();
    expect(page.doc.getElementById('rag-access-groups-rename-input'), 'the rename editor is open').not.toBeNull();
    const input = page.doc.getElementById('rag-access-groups-rename-input')!;
    expect(page.doc.activeElement).toBe(input);
    expect(input.value).toBe('group-a');
    expect(page.row(ID_A).querySelector('code')!.textContent).toBe('group-a');
    type(input, '');
    expect(button(page.row(ID_A), 'Save name').disabled).toBe(true);
    type(input, 'group-renamed');
    button(page.row(ID_A), 'Save name').click();
    await flush();
    expect(page.count('rename')).toBe(1);
    expect(page.last('rename').path.split('?')[0]).toBe('/api/rag/access-groups/' + ID_A);
    expect(page.body('rename')).toEqual({ name: 'group-renamed' });
    expect(page.statusRegion().textContent).toBe('Group renamed to group-renamed. Its documents and members are unchanged.');
    expect(page.row(ID_A).querySelector('[data-access-groups-name]')!.textContent).toBe('group-renamed');
    expect(page.row(ID_A).querySelector('code')!.textContent).toBe('group-a');
    expect(page.doc.activeElement!.getAttribute('data-access-groups-rename')).toBe(ID_A);
  });

  it('one row edits at a time, and Escape cancels with focus back on Rename group', async () => {
    const page = loadPage();
    await page.init();
    button(page.row(ID_A), 'Rename group').click();
    button(page.row(ID_B), 'Rename group').click();
    expect(page.root.querySelectorAll('[data-access-groups-rename-editor]')).toHaveLength(1);
    expect(page.row(ID_B).querySelector('[data-access-groups-rename-editor]')).toBeTruthy();
    page.doc.getElementById('rag-access-groups-rename-input')!.dispatch('keydown', { key: 'Escape' });
    expect(page.root.querySelectorAll('[data-access-groups-rename-editor]')).toHaveLength(0);
    expect(page.doc.activeElement!.getAttribute('data-access-groups-rename')).toBe(ID_B);
    expect(page.count('rename')).toBe(0);
  });

  it('a 404 says error.changed and reloads the list', async () => {
    const page = loadPage({ replies: { rename: { status: 404, body: { success: false, error: 'not_found' } } } });
    await page.init();
    const before = page.count('list');
    button(page.row(ID_A), 'Rename group').click();
    expect(page.doc.getElementById('rag-access-groups-rename-input'), 'the rename editor is open').not.toBeNull();
    type(page.doc.getElementById('rag-access-groups-rename-input')!, 'group-z');
    button(page.row(ID_A), 'Save name').click();
    await flush();
    expect(page.statusRegion().textContent).toContain('This item was changed by someone else.');
    expect(page.count('list')).toBe(before + 1);
  });
});

describe('Members region and member search (D-01, D-04, UI-SPEC decision 21)', () => {
  async function openMembers(options: PageOptions = {}, id = ID_A) {
    const page = loadPage(options);
    await page.init();
    button(page.row(id), 'Manage members').click();
    await flush();
    expect(page.root.querySelector('[data-access-groups-member-search]'), 'the members region is open').not.toBeNull();
    return page;
  }

  function search(page: ReturnType<typeof loadPage>): FakeElement {
    return page.root.querySelector('[data-access-groups-member-search]')!;
  }

  it('toggles the region with aria-expanded and aria-controls and moves focus to the search field', async () => {
    const page = await openMembers();
    const manage = page.row(ID_A).querySelector('[data-access-groups-manage]')!;
    expect(manage.getAttribute('aria-expanded')).toBe('true');
    expect(manage.textContent).toBe('Close members');
    const region = page.doc.getElementById(manage.getAttribute('aria-controls')!)!;
    expect(region).toBeTruthy();
    expect(region.querySelector('h4')!.textContent).toBe('Members of group-a');
    expect(page.doc.activeElement).toBe(search(page));
    expect(region.textContent).toContain('Owners and admins see every document and do not need to be in a group.');
    expect(region.textContent).toContain('Type at least 2 characters.');
    expect(page.last('members').path.split('?')[0]).toBe('/api/rag/access-groups/' + ID_A + '/members');
    expect(region.querySelector('table')!.textContent).toContain('member-a');
  });

  it('one region is open at a time; Close members and Escape return focus to the opening button', async () => {
    const page = await openMembers();
    button(page.row(ID_B), 'Manage members').click();
    await flush();
    expect(page.root.querySelectorAll('[data-access-groups-members-row]')).toHaveLength(1);
    expect(page.row(ID_A).querySelector('[data-access-groups-manage]')!.getAttribute('aria-expanded')).toBe('false');
    search(page).dispatch('keydown', { key: 'Escape' });
    expect(page.root.querySelectorAll('[data-access-groups-members-row]')).toHaveLength(0);
    expect(page.doc.activeElement!.getAttribute('data-access-groups-manage')).toBe(ID_B);
    button(page.row(ID_A), 'Manage members').click();
    await flush();
    button(page.groupsPanel(), 'Close members').click();
    expect(page.doc.activeElement!.getAttribute('data-access-groups-manage')).toBe(ID_A);
  });

  it('searches only after 2 characters and 400 ms, with the group id in the query', async () => {
    const page = await openMembers();
    type(search(page), 'm');
    await page.advance(1000);
    expect(page.count('candidates')).toBe(0);
    expect(page.groupsPanel().textContent).toContain('Type at least 2 characters.');
    type(search(page), 'me');
    await page.advance(399);
    expect(page.count('candidates')).toBe(0);
    await page.advance(1);
    expect(page.count('candidates')).toBe(1);
    expect(page.last('candidates').query.get('q')).toBe('me');
    expect(page.last('candidates').query.get('groupId')).toBe(ID_A);
    const results = page.root.querySelector('[data-access-groups-results]')!;
    const items = results.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('In this group');
    expect(items[0]!.querySelector('button')).toBeNull();
    expect(button(items[1]!, 'Add member').getAttribute('aria-label')).toBe('Add member: member-b');
  });

  it('Enter runs the search at once; a spinner with text shows while earlier results stay', async () => {
    const page = await openMembers({ hold: ['candidates'] });
    type(search(page), 'me');
    search(page).dispatch('keydown', { key: 'Enter' });
    await flush();
    expect(page.count('candidates')).toBe(1);
    page.release('candidates', { status: 200, body: { success: true, candidates: [{ userId: USER_2, displayName: 'member-b', email: '', already: false }] } });
    await flush();
    type(search(page), 'mem');
    await page.advance(400);
    const region = page.root.querySelector('[data-access-groups-members-row]')!;
    expect(region.textContent).toContain('Searching members…');
    expect(region.querySelector('.loading')).toBeTruthy();
    expect(page.root.querySelector('[data-access-groups-results]')!.textContent).toContain('member-b');
    page.release('candidates', { status: 200, body: { success: true, candidates: [] } });
    await flush();
    expect(region.textContent).toContain('No member of this workspace matches "mem".');
  });

  it('lists at most 20 results', async () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({ userId: '00000000-0000-4000-8000-1000000000' + String(i).padStart(2, '0'), displayName: 'member-' + i, email: '', already: false }));
    const page = await openMembers({ replies: { candidates: { status: 200, body: { success: true, candidates } } } });
    type(search(page), 'member');
    await page.advance(400);
    expect(page.root.querySelector('[data-access-groups-results]')!.querySelectorAll('li')).toHaveLength(20);
  });

  it('Add member acts at once, announces member.added and reloads the members', async () => {
    const page = await openMembers({
      replies: {
        members: [
          { status: 200, body: { success: true, members: [] } },
          { status: 200, body: { success: true, members: [{ userId: USER_2, displayName: 'member-b', email: '', addedAt: '2026-11-26T10:00:00.000Z' }] } },
        ],
      },
    });
    expect(page.root.querySelector('[data-access-groups-members-empty]')!.textContent).toBe(
      'No members yet. Until someone is added, only admins see documents restricted to this group.',
    );
    type(search(page), 'me');
    await page.advance(400);
    button(page.root.querySelector('[data-access-groups-results]')!, 'Add member').click();
    await flush();
    expect(page.count('addMember')).toBe(1);
    expect(page.body('addMember')).toEqual({ userId: USER_2 });
    expect(page.statusRegion().textContent).toBe('member-b added to group-a. They can see its documents from their next question.');
    expect(page.root.querySelector('[data-access-groups-members]')!.textContent).toContain('member-b');
    expect(page.root.querySelector('[data-access-groups-results]')!.querySelectorAll('button')).toHaveLength(0);
    expect(page.row(ID_A).querySelector('td')!.textContent).toBe('5');
  });

  it('Remove member acts at once and announces member.removed', async () => {
    const page = await openMembers();
    const remove = button(page.root.querySelector('[data-access-groups-members]')!, 'Remove member');
    expect(remove.getAttribute('aria-label')).toBe('Remove member: member-a');
    remove.click();
    await flush();
    expect(page.last('removeMember').path.split('?')[0]).toBe('/api/rag/access-groups/' + ID_A + '/members/' + USER_1);
    expect(page.last('removeMember').init.method).toBe('DELETE');
    expect(page.statusRegion().textContent).toBe('member-a removed from group-a. They lose access through this group from their next question.');
    expect(page.root.querySelector('[data-access-groups-members-empty]')).toBeTruthy();
    expect(page.doc.activeElement).toBe(search(page));
    expect(page.row(ID_A).querySelector('td')!.textContent).toBe('3');
  });

  it.each([
    ['member_exists', 409, 'This person is already in the group. The list has been reloaded.'],
    ['not_a_workspace_member', 400, 'This person is no longer a member of the workspace. The list has been reloaded.'],
  ])('%s shows its message and reloads', async (code, statusCode, message) => {
    const page = await openMembers({ replies: { addMember: { status: statusCode, body: { success: false, error: code } } } });
    type(search(page), 'me');
    await page.advance(400);
    const membersBefore = page.count('members');
    const candidatesBefore = page.count('candidates');
    button(page.root.querySelector('[data-access-groups-results]')!, 'Add member').click();
    await flush();
    expect(page.statusRegion().textContent).toContain(message);
    expect(page.count('members')).toBe(membersBefore + 1);
    expect(page.count('candidates')).toBe(candidatesBefore + 1);
  });

  it('a member without a display name shows the e-mail, or the id in font-mono', async () => {
    const page = await openMembers({
      replies: {
        members: {
          status: 200,
          body: {
            success: true,
            members: [
              { userId: USER_1, displayName: '', email: 'a@example.org', addedAt: '2026-11-26T09:30:00.000Z' },
              { userId: USER_3, displayName: null, email: null, addedAt: '2026-11-26T09:30:00.000Z' },
            ],
          },
        },
      },
    });
    const rows = page.root.querySelectorAll('[data-access-groups-member]');
    expect(rows[0]!.querySelector('th')!.textContent).toBe('a@example.org');
    const code = rows[1]!.querySelector('th code')!;
    expect(code.textContent).toBe(USER_3);
    expect(code.className).toContain('font-mono');
    expect(rows[0]!.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-26T09:30:00.000Z');
  });

  it('markup in member names creates no element and no link', async () => {
    const page = await openMembers({
      replies: {
        members: { status: 200, body: { success: true, members: [{ userId: USER_1, displayName: XSS_PAYLOAD, email: '', addedAt: null }] } },
        candidates: { status: 200, body: { success: true, candidates: [{ userId: USER_2, displayName: '', email: 'javascript:' + XSS_PAYLOAD, already: false }] } },
      },
    });
    type(search(page), 'me');
    await page.advance(400);
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.root.querySelectorAll('a')).toHaveLength(0);
    expect(page.root.querySelector('[data-access-groups-members]')!.textContent).toContain(XSS_PAYLOAD);
    expect(page.doc.innerHtmlWrites).toBe(0);
  });
});

describe('Counted delete dialog (D-18, UI-SPEC decision 10)', () => {
  async function openDelete(options: PageOptions = {}) {
    const page = loadPage(options);
    await page.init();
    const opener = button(page.row(ID_A), 'Delete group');
    opener.click();
    await flush();
    expect(page.dialog(), 'the delete dialog is open').not.toBeNull();
    return { page, opener };
  }

  function confirmButton(page: ReturnType<typeof loadPage>): FakeElement {
    return page.dialog()!.querySelector('[data-access-groups-confirm-delete]')!;
  }

  it('opens with delete.counting, Delete group disabled and the default focus on Keep group', async () => {
    const { page } = await openDelete({ hold: ['impact'] });
    const dialog = page.dialog()!;
    expect(dialog.className).toContain('modal');
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Delete group-a?');
    expect(dialog.textContent).toContain('Counting affected documents…');
    expect(confirmButton(page).disabled).toBe(true);
    expect(page.doc.activeElement!.textContent).toBe('Keep group');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(page.doc.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Delete group-a?');
    page.release('impact', { status: 200, body: { success: true, impact: { onlyCount: 7, sharedCount: 5, memberCount: 4, mappingCount: 0 } } });
    await flush();
    expect(confirmButton(page).disabled).toBe(false);
  });

  it('shows the three counts right-aligned in tabular-nums and the body', async () => {
    const { page } = await openDelete();
    const dialog = page.dialog()!;
    expect(dialog.querySelectorAll('dt').map((d) => d.textContent)).toEqual([
      'Documents restricted to this group alone',
      'Documents that stay visible to their other groups',
      'Members who lose access through this group',
    ]);
    const dd = dialog.querySelectorAll('dd');
    expect(dd.map((d) => d.textContent)).toEqual(['7', '5', '4']);
    for (const d of dd) expect(d.className).toContain('tabular-nums');
    for (const d of dd) expect(d.className).toContain('text-right');
    expect(dialog.textContent).toContain("Documents restricted to this group alone become visible to their uploader and admins only, never to everyone. This can't be undone.");
    expect(dialog.textContent).not.toContain('Connector mappings removed with it');
  });

  it('zero documents and zero members show three zeros; mappings show when they point at the group', async () => {
    const { page } = await openDelete({ replies: { impact: { status: 200, body: { success: true, impact: { onlyCount: 0, sharedCount: 0, memberCount: 0, mappingCount: 2 } } } } });
    expect(page.dialog()!.querySelectorAll('dd').map((d) => d.textContent)).toEqual(['0', '0', '0']);
    expect(page.dialog()!.textContent).toContain('Connector mappings removed with it: 2');
    expect(confirmButton(page).disabled).toBe(false);
  });

  it('a failed count shows delete.countUnavailable with Count again, and Delete group stays disabled', async () => {
    const { page } = await openDelete({
      replies: { impact: [{ status: 503, body: { success: false, error: 'access_groups_unavailable' } }, { status: 200, body: { success: true, impact: { onlyCount: 1, sharedCount: 0, memberCount: 2, mappingCount: 0 } } }] },
    });
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('The affected documents could not be counted, so the group cannot be deleted now. Select Count again.');
    expect(confirmButton(page).disabled).toBe(true);
    confirmButton(page).click();
    await flush();
    expect(page.count('delete')).toBe(0);
    button(dialog, 'Count again').click();
    await flush();
    expect(page.count('impact')).toBe(2);
    expect(dialog.querySelectorAll('dd').map((d) => d.textContent)).toEqual(['1', '0', '2']);
    expect(confirmButton(page).disabled).toBe(false);
  });

  it('sends the count with the delete, announces how many documents fell back and focuses the status region', async () => {
    const { page } = await openDelete();
    confirmButton(page).click();
    await flush();
    expect(page.count('delete')).toBe(1);
    expect(page.last('delete').path.split('?')[0]).toBe('/api/rag/access-groups/' + ID_A);
    expect(page.body('delete')).toEqual({ expectedCount: 7 });
    expect(page.dialog()).toBeNull();
    expect(page.statusRegion().textContent).toBe('Group group-a deleted. Documents now visible to their uploader and admins only: 7.');
    expect(page.doc.activeElement).toBe(page.statusRegion());
    expect(page.rows().map((r) => r.getAttribute('data-access-groups-row'))).toEqual([ID_B]);
  });

  it('a 409 count_required recounts and shows the new numbers before Delete group is enabled again', async () => {
    const { page } = await openDelete({
      hold: ['delete'],
      replies: {
        impact: [
          { status: 200, body: { success: true, impact: { onlyCount: 7, sharedCount: 5, memberCount: 4, mappingCount: 0 } } },
          { status: 200, body: { success: true, impact: { onlyCount: 9, sharedCount: 5, memberCount: 4, mappingCount: 0 } } },
        ],
      },
    });
    confirmButton(page).click();
    await flush();
    expect(confirmButton(page).disabled).toBe(true);
    page.release('delete', { status: 409, body: { success: false, error: 'count_required', count: 9 } });
    await flush();
    expect(page.count('impact')).toBe(2);
    expect(page.dialog()).not.toBeNull();
    expect(page.dialog()!.querySelectorAll('dd').map((d) => d.textContent)).toEqual(['9', '5', '4']);
    expect(confirmButton(page).disabled).toBe(false);
    confirmButton(page).click();
    await flush();
    page.release('delete', { status: 200, body: { success: true, fellBack: 9, relabelled: 14 } });
    await flush();
    expect(JSON.parse(String(page.calls.filter((c) => c.route === 'delete')[1]!.init.body))).toEqual({ expectedCount: 9 });
    expect(page.statusRegion().textContent).toContain('Documents now visible to their uploader and admins only: 9.');
  });

  it('Keep group closes without deleting and returns focus to Delete group; Escape is refused while the delete runs', async () => {
    const { page, opener } = await openDelete({ hold: ['delete'] });
    button(page.dialog()!, 'Keep group').click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.count('delete')).toBe(0);
    expect(page.doc.activeElement).toBe(opener);
    opener.click();
    await flush();
    confirmButton(page).click();
    await flush();
    const cancel = page.dialog()!.dispatch('cancel');
    expect(cancel.defaultPrevented).toBe(true);
    button(page.dialog()!, 'Keep group').click();
    expect(page.dialog()).not.toBeNull();
    page.release('delete', { status: 200, body: { success: true, fellBack: 7, relabelled: 12 } });
    await flush();
    expect(page.dialog()).toBeNull();
  });

  it('a 404 closes the dialog, says error.changed and reloads the list', async () => {
    const { page } = await openDelete({ replies: { delete: { status: 404, body: { success: false, error: 'not_found' } } } });
    const before = page.count('list');
    confirmButton(page).click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.statusRegion().textContent).toContain('This item was changed by someone else.');
    expect(page.count('list')).toBe(before + 1);
  });

  it('a long name without spaces breaks in the dialog title; markup in it creates no element', async () => {
    const long = 'g'.repeat(120);
    const page = loadPage({ replies: { list: { status: 200, body: listBody([group(ID_A, { name: long + XSS_PAYLOAD })]) } } });
    await page.init();
    button(page.row(ID_A), 'Delete group').click();
    await flush();
    expect(page.dialog(), 'the delete dialog is open').not.toBeNull();
    const title = page.doc.getElementById(page.dialog()!.getAttribute('aria-labelledby')!)!;
    expect(title.className).toContain('break-words');
    expect(title.textContent).toContain(XSS_PAYLOAD);
    expect(page.row(ID_A).querySelector('[data-access-groups-name]')!.className).toContain('break-words');
    expect(injectedElements(page.doc)).toEqual([]);
  });
});

describe('design pass: layout classes, locales and the findings line (UI-SPEC 9, 10)', () => {
  it('hides the count columns below 768px and shows them under the key; the table scrolls inside its region', async () => {
    const page = loadPage();
    await page.init();
    const heads = page.root.querySelector('[data-access-groups-table]')!.querySelectorAll('thead th');
    expect(heads.map((h) => h.className.includes('hidden md:table-cell'))).toEqual([false, true, true, false]);
    const line = page.row(ID_A).querySelector('th')!.querySelector('.md\\:hidden')!;
    expect(line.textContent).toBe('Members: 4Documents: 12');
    expect(page.root.querySelector('[data-access-groups-table]')!.className).toContain('overflow-x-auto');
    for (const b of page.row(ID_A).querySelectorAll('button')) expect(b.className).toContain('whitespace-normal');
  });

  it('a key error is shown once: at the field, not again in the findings line', async () => {
    const page = loadPage();
    await page.init();
    button(page.groupsPanel(), 'New group').click();
    type(page.doc.getElementById('rag-access-groups-name')!, 'group-x');
    type(page.doc.getElementById('rag-access-groups-key')!, 'all');
    expect(page.doc.getElementById('rag-access-groups-findings')!.textContent).toBe('');
    expect(page.doc.getElementById('rag-access-groups-key-error')!.textContent).toContain('reserved');
  });

  it.each([
    ['zh-CN', '访问组：2', '新建访问组', '管理成员'],
    ['it-IT', 'Gruppi: 2', 'Nuovo gruppo', 'Gestisci membri'],
  ])('renders %s', async (locale, tabLabel, newGroup, manage) => {
    const page = loadPage({ locale });
    await page.init();
    expect(page.root.querySelector('[role="tab"]')!.textContent).toBe(tabLabel);
    expect(button(page.groupsPanel(), newGroup)).toBeTruthy();
    expect(button(page.row(ID_A), manage)).toBeTruthy();
    button(page.row(ID_A), manage).click();
    await flush();
    expect(page.groupsPanel().textContent).not.toContain('Type at least 2 characters.');
  });
});

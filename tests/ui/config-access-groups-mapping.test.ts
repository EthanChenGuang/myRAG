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
type Route = 'list' | 'status' | 'map' | 'mapCreate' | 'mapChange' | 'mapRemove' | 'rules' | 'ruleCreate' | 'ruleChange';

interface MappingRow {
  key: string;
  id: string | null;
  provider: string;
  kind: string;
  principal: string;
  groupId: string | null;
  documents: number;
  mapped: boolean;
}
interface MappingModule {
  buildAccessGroupsMappingRow: (row: Json) => MappingRow | null;
  buildAccessGroupsMappingList: (body: Json) => { personal: boolean; visibilityApplies: boolean; rows: MappingRow[]; total: number; nextOffset: number | null };
  accessGroupsMappingKindLabel: (row: Json, locale: string) => string;
  accessGroupsMappingAction: (row: Json, selected: string) => string;
  buildAccessGroupsRuleRow: (rule: Json) => Json | null;
  buildAccessGroupsRulesList: (body: Json) => { personal: boolean; rows: Json[] };
  accessGroupsRuleText: (rule: Json, locale: string) => string;
  accessGroupsNormalizeDomain: (value: string) => string | null;
  accessGroupsMappingFindings: (form: Json) => { missing: string[]; valid: boolean };
  accessGroupsProviderName: (provider: string) => string;
  mapAccessGroupsError: (result: Json | null, locale: string, ctx?: Json) => { key: string; kind: string; field?: string; reload?: boolean };
}

function loadModule(): MappingModule {
  return require('../../scripts/config-ui/rag-panels/access-groups.js') as MappingModule;
}

const G_A = '00000000-0000-4000-8000-0000000000a1';
const G_B = '00000000-0000-4000-8000-0000000000b2';
const M_1 = '00000000-0000-4000-8000-0000000000e1';
const R_1 = '00000000-0000-4000-8000-0000000000f1';
const R_2 = '00000000-0000-4000-8000-0000000000f2';
const R_3 = '00000000-0000-4000-8000-0000000000f3';

function group(id: string, name: string): Json {
  return { id, key: name, name, source: 'manual', createdAt: '2026-11-26T09:00:00.000Z', memberCount: 1, documentCount: 1 };
}
const GROUPS = [group(G_A, 'group-a'), group(G_B, 'group-b')];

function listBody(unmapped = 0): Json {
  return { success: true, personal: false, enabled: true, groups: GROUPS, nextCursor: null, alerts: { unmappedSourceGroups: unmapped, enforcement: {} } };
}

const UNMAPPED = { id: null, provider: 'google-drive', kind: 'group', externalPrincipalId: 'group-x@example.org', groupId: null, documents: 9 };
const MAPPED = { id: M_1, provider: 'dropbox', kind: 'team', externalPrincipalId: 'dbgid:AAA', groupId: G_A, documents: 2 };
const NOTION = { id: null, provider: 'notion', kind: 'workspace', externalPrincipalId: 'workspace-1', groupId: null, documents: 1 };

function mapBody(rows: Json[], extra: Json = {}): Json {
  return { success: true, personal: false, visibilityApplies: true, rows, total: rows.length, nextOffset: null, ...extra };
}

const RULES = [
  { id: R_1, provider: 'google-drive', kind: 'domain', domain: 'example.org', enabled: false, documents: 14 },
  { id: R_2, provider: 'google-drive', kind: 'anyone', domain: null, enabled: false, documents: 3 },
  { id: R_3, provider: 'notion', kind: 'public', domain: null, enabled: true, documents: 1 },
];
function rulesBody(rules: Json[], extra: Json = {}): Json {
  return { success: true, personal: false, visibilityApplies: true, rules, ...extra };
}

const STATUS = { success: true, status: { runningSwitch: 'on', databaseFlag: true, status: 'ready', ready: true, reasons: [], objects: [], embedGroup: null, checkedAt: '2026-11-26T10:00:00.000Z' } };

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const base = '/api/rag/access-groups';
  if (!apiPath.startsWith(base)) return 'unknown';
  const rest = apiPath.split('?')[0]!.slice(base.length);
  if (rest === '' && method === 'GET') return 'list';
  if (rest === '/status' && method === 'GET') return 'status';
  if (rest === '/connector-map' && method === 'GET') return 'map';
  if (rest === '/connector-map' && method === 'POST') return 'mapCreate';
  if (/^\/connector-map\/[0-9a-f-]{36}$/.test(rest) && method === 'PUT') return 'mapChange';
  if (/^\/connector-map\/[0-9a-f-]{36}$/.test(rest) && method === 'DELETE') return 'mapRemove';
  if (rest === '/sharing-rules' && method === 'GET') return 'rules';
  if (rest === '/sharing-rules' && method === 'POST') return 'ruleCreate';
  if (/^\/sharing-rules\/[0-9a-f-]{36}$/.test(rest) && method === 'PUT') return 'ruleChange';
  return 'unknown';
}

interface PageOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | Reply[]>>;
  hold?: Route[];
  multiTenant?: boolean;
}

function loadPage(options: PageOptions = {}) {
  const doc = new FakeDocument();
  const calls: Array<{ route: string; path: string; init: Json; query: URLSearchParams }> = [];
  const held = new Map<Route, Array<(reply: Reply) => void>>();
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  if (options.multiTenant) {
    const container = doc.createElement('div');
    container.id = 'workspace-selector-container';
    const select = doc.createElement('select');
    select.id = 'workspace-selector';
    const option = doc.createElement('option');
    option.setAttribute('value', 'org-1');
    option.textContent = 'workspace-a';
    select.appendChild(option);
    select.value = 'org-1';
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
    list: { status: 200, body: listBody(2) },
    status: { status: 200, body: STATUS },
    map: { status: 200, body: mapBody([MAPPED, UNMAPPED, NOTION]) },
    mapCreate: { status: 201, body: { success: true, mapping: { id: M_1, groupId: G_B, outcome: 'created' }, appliesAt: 'next_sync', visibilityApplies: true } },
    mapChange: { status: 200, body: { success: true, mapping: { id: M_1, groupId: G_B, outcome: 'changed' }, appliesAt: 'next_sync', visibilityApplies: true } },
    mapRemove: { status: 200, body: { success: true, removed: true, appliesAt: 'next_sync' } },
    rules: { status: 200, body: rulesBody(RULES) },
    ruleCreate: { status: 201, body: { success: true, rule: { id: R_1, enabled: false, outcome: 'created' }, appliesAt: 'next_sync' } },
    ruleChange: { status: 200, body: { success: true, rule: { id: R_1, enabled: true, outcome: 'enabled' }, appliesAt: 'next_sync' } },
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

  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    location: { origin: 'http://config.local', search: '', hash: '' },
    setTimeout: () => 0,
    clearTimeout: () => {},
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
    async init() {
      await (context.initAccessGroupsPanel as () => Promise<void>)();
      await flush();
    },
    async openMapping() {
      await page.init();
      (doc.getElementById('rag-access-groups-tab-mapping') as FakeElement).click();
      await flush();
    },
    panel(): FakeElement {
      return doc.getElementById('rag-access-groups-panel-mapping') as FakeElement;
    },
    status(): FakeElement {
      return root.querySelector('[data-access-groups-status]') as FakeElement;
    },
    rows(): FakeElement[] {
      return root.querySelectorAll('[data-access-groups-mapping-row]');
    },
    row(principal: string): FakeElement {
      const found = page.rows().find((r) => (r.querySelector('code')?.textContent ?? '') === principal);
      if (!found) throw new Error('no mapping row ' + principal);
      return found;
    },
    ruleRows(): FakeElement[] {
      return root.querySelectorAll('[data-access-groups-rule-row]');
    },
    ruleRow(id: string): FakeElement {
      const found = page.ruleRows().find((r) => r.getAttribute('data-access-groups-rule-row') === id);
      if (!found) throw new Error('no rule row ' + id);
      return found;
    },
    dialog(): FakeElement | null {
      return doc.querySelector('dialog');
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

function pick(select: FakeElement, value: string) {
  select.value = value;
  select.dispatch('change');
}

function typeInto(input: FakeElement, value: string) {
  input.value = value;
  input.dispatch('input');
}

function rowSelect(row: FakeElement): FakeElement {
  return row.querySelector('[data-access-groups-mapping-select]') as FakeElement;
}

describe('mapping view-model (D-20, D-21, UI-SPEC 6.5)', () => {
  const m = loadModule();

  it('a row keeps the source id exactly as given and never invents a name', () => {
    const row = m.buildAccessGroupsMappingRow({ ...UNMAPPED, externalPrincipalId: 'Group-X@Example.org' })!;
    expect(row).toMatchObject({ id: null, provider: 'google-drive', kind: 'group', principal: 'Group-X@Example.org', groupId: null, documents: 9, mapped: false });
    expect(m.buildAccessGroupsMappingRow(MAPPED)).toMatchObject({ id: M_1, mapped: true, groupId: G_A, principal: 'dbgid:AAA' });
    expect(m.buildAccessGroupsMappingRow({ ...UNMAPPED, externalPrincipalId: '' })).toBeNull();
    expect(m.buildAccessGroupsMappingRow({ ...UNMAPPED, provider: 7 })).toBeNull();
  });

  it('the list puts unmapped rows first and keeps the server order within each part', () => {
    const list = m.buildAccessGroupsMappingList(mapBody([MAPPED, UNMAPPED, { ...MAPPED, id: G_B, externalPrincipalId: 'dbgid:BBB' }, NOTION], { total: 60, nextOffset: 50 }));
    expect(list.rows.map((r) => r.principal)).toEqual(['group-x@example.org', 'workspace-1', 'dbgid:AAA', 'dbgid:BBB']);
    expect(list).toMatchObject({ personal: false, visibilityApplies: true, total: 60, nextOffset: 50 });
    expect(m.buildAccessGroupsMappingList({ success: true, personal: true, visibilityApplies: false, rows: [] })).toMatchObject({ personal: true, visibilityApplies: false, rows: [] });
  });

  it('the kind is in words; Notion reads as Whole workspace', () => {
    expect(m.accessGroupsMappingKindLabel(UNMAPPED, 'en')).toBe('Group');
    expect(m.accessGroupsMappingKindLabel(MAPPED, 'en')).toBe('Team');
    expect(m.accessGroupsMappingKindLabel(NOTION, 'en')).toBe('Whole workspace');
    expect(m.accessGroupsMappingKindLabel(NOTION, 'it')).toBe('Intero spazio di lavoro');
  });

  it('the select decides create, change, remove or nothing', () => {
    const unmapped = m.buildAccessGroupsMappingRow(UNMAPPED)!;
    const mapped = m.buildAccessGroupsMappingRow(MAPPED)!;
    expect(m.accessGroupsMappingAction(unmapped, '')).toBe('none');
    expect(m.accessGroupsMappingAction(unmapped, G_A)).toBe('create');
    expect(m.accessGroupsMappingAction(mapped, G_A)).toBe('none');
    expect(m.accessGroupsMappingAction(mapped, G_B)).toBe('change');
    expect(m.accessGroupsMappingAction(mapped, '')).toBe('remove');
  });

  it('product names come from the provider configuration, not translated', () => {
    expect(m.accessGroupsProviderName('google-drive')).toBe('Google Drive');
    expect(m.accessGroupsProviderName('notion')).toBe('Notion');
    expect(m.accessGroupsProviderName('something-else')).toBe('something-else');
  });

  it('sharing rules read as their kind; an unknown kind is dropped', () => {
    expect(m.accessGroupsRuleText(RULES[0]!, 'en')).toBe('Everyone at example.org');
    expect(m.accessGroupsRuleText(RULES[1]!, 'en')).toBe('Anyone with the link');
    expect(m.accessGroupsRuleText(RULES[2]!, 'zh')).toBe('已发布到网络');
    expect(m.buildAccessGroupsRuleRow({ ...RULES[0], kind: 'everyone' })).toBeNull();
    expect(m.buildAccessGroupsRulesList(rulesBody(RULES)).rows).toHaveLength(3);
  });

  it('a domain is a host name with a dot, without scheme, path, port, wildcard or space', () => {
    expect(m.accessGroupsNormalizeDomain(' Example.ORG ')).toBe('example.org');
    expect(m.accessGroupsNormalizeDomain('sub.example.org')).toBe('sub.example.org');
    for (const bad of ['example', 'https://example.org', 'example.org/path', 'example.org:443', '*.example.org', 'exa mple.org', '', '-a.example.org', 'a..org']) {
      expect(m.accessGroupsNormalizeDomain(bad)).toBeNull();
    }
  });

  it('the new mapping form names every missing field', () => {
    expect(m.accessGroupsMappingFindings({ provider: '', principal: ' ', groupId: '' })).toEqual({ missing: ['provider', 'principal', 'groupId'], valid: false });
    expect(m.accessGroupsMappingFindings({ provider: 'dropbox', principal: 'dbgid:AAA', groupId: G_A })).toEqual({ missing: [], valid: true });
  });

  it('maps the mapping and rule codes', () => {
    expect(m.mapAccessGroupsError({ ok: false, status: 409, body: { error: 'mapping_exists' } }, 'en', { write: true })).toMatchObject({ key: 'error.mappingExists', kind: 'field', field: 'principal' });
    expect(m.mapAccessGroupsError({ ok: false, status: 400, body: { error: 'bad_domain' } }, 'en', { write: true })).toMatchObject({ key: 'rules.badDomain', kind: 'field', field: 'domain' });
    expect(m.mapAccessGroupsError({ ok: false, status: 409, body: { error: 'rule_exists' } }, 'en', { write: true })).toMatchObject({ key: 'error.ruleExists', kind: 'field', field: 'domain' });
  });
});

describe('Connector mapping sub-view (D-20, UI-SPEC 6.5, 7.2)', () => {
  it('the sub-tab sits between Documents and Enforcement and carries the unmapped count; nothing loads before it is opened', async () => {
    const page = loadPage();
    await page.init();
    const tabs = page.root.querySelectorAll('[role="tab"]').map((t) => t.textContent);
    expect(tabs).toEqual(['Groups: 2', 'Documents', 'Connector mapping, not mapped: 2', 'Enforcement']);
    expect(page.count('map')).toBe(0);
    expect(page.count('rules')).toBe(0);
  });

  it('alert.unmapped with the count and Open connector mapping shows on every sub-view, also with the switch off', async () => {
    const off = { success: true, status: { ...STATUS.status, runningSwitch: 'off', databaseFlag: false } };
    const page = loadPage({ replies: { status: { status: 200, body: off } } });
    await page.init();
    const host = page.root.querySelector('[data-access-groups-alert]')!;
    expect(host.textContent).toContain('Source groups not mapped: 2. Their documents are visible to their uploader and admins only.');
    const open = button(host, 'Open connector mapping');
    open.click();
    await flush();
    expect(page.panel().hidden).toBe(false);
    expect(page.doc.activeElement?.getAttribute('data-access-groups-mapping-heading')).toBe('');
    expect(page.count('map')).toBe(1);
  });

  it('no alert and a plain tab label while every source group is mapped', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: listBody(0) } } });
    await page.init();
    expect(page.root.querySelector('[data-access-groups-alert]')!.textContent).not.toContain('Source groups not mapped');
    expect(page.doc.getElementById('rag-access-groups-tab-mapping')!.textContent).toBe('Connector mapping');
  });

  it('renders the description, unmapped rows first with the Not mapped badge and their count, ids as code with the kind in words', async () => {
    const page = loadPage();
    await page.openMapping();
    expect(page.panel().textContent).toContain('Match groups and teams at the source to access groups.');
    const rows = page.rows();
    expect(rows.map((r) => r.querySelector('code')!.textContent)).toEqual(['group-x@example.org', 'workspace-1', 'dbgid:AAA']);
    const first = page.row('group-x@example.org');
    expect(first.textContent).toContain('Not mapped');
    expect(first.textContent).toContain('Google Drive');
    expect(first.textContent).toContain('Group');
    expect(first.querySelector('[data-access-groups-mapping-documents]')!.textContent).toBe('9');
    const code = first.querySelector('code')!;
    expect(code.className).toContain('font-mono');
    expect(code.className).toContain('break-all');
    expect(code.getAttribute('translate')).toBe('no');
    expect(page.row('workspace-1').textContent).toContain('Whole workspace');
    expect(page.row('dbgid:AAA').textContent).not.toContain('Not mapped');
    expect(page.panel().querySelector('[data-access-groups-mapping-note]')).toBeNull();
  });

  it('the Documents column hides below md and the count moves under the id', async () => {
    const page = loadPage();
    await page.openMapping();
    const cell = page.row('group-x@example.org').querySelector('[data-access-groups-mapping-documents]')!;
    expect(cell.className).toContain('hidden md:table-cell');
    const under = page.row('group-x@example.org').querySelector('[data-access-groups-mapping-documents-under]')!;
    expect(under.className).toContain('md:hidden');
    expect(under.textContent).toBe('Documents: 9');
  });

  it('choosing a group in an unmapped row enables Save mapping, which posts and announces mapping.saved with the next-sync clause', async () => {
    const page = loadPage();
    await page.openMapping();
    const row = page.row('group-x@example.org');
    const save = button(row, 'Save mapping');
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-label')).toBe('Save mapping: group-x@example.org');
    pick(rowSelect(row), G_B);
    expect(button(page.row('group-x@example.org'), 'Save mapping').disabled).toBe(false);
    button(page.row('group-x@example.org'), 'Save mapping').click();
    await flush();
    expect(page.body('mapCreate')).toEqual({ provider: 'google-drive', kind: 'group', externalPrincipalId: 'group-x@example.org', groupId: G_B });
    expect(page.status().textContent).toBe('group-x@example.org is mapped to group-b. Applies at the next sync.');
    expect(page.count('map')).toBe(2);
  });

  it('pointing a mapped row at another group PUTs the group id', async () => {
    const page = loadPage();
    await page.openMapping();
    pick(rowSelect(page.row('dbgid:AAA')), G_B);
    button(page.row('dbgid:AAA'), 'Save mapping').click();
    await flush();
    expect(page.last('mapChange').path).toContain('/connector-map/' + M_1);
    expect(page.body('mapChange')).toEqual({ groupId: G_B });
    expect(page.status().textContent).toBe('dbgid:AAA is mapped to group-b. Applies at the next sync.');
  });

  it('choosing Not mapped on a mapped row and saving removes the mapping, as Remove mapping does', async () => {
    const page = loadPage();
    await page.openMapping();
    pick(rowSelect(page.row('dbgid:AAA')), '');
    button(page.row('dbgid:AAA'), 'Save mapping').click();
    await flush();
    expect(page.count('mapRemove')).toBe(1);
    expect(page.last('mapRemove').path).toContain('/connector-map/' + M_1);
    expect(page.status().textContent).toBe('Mapping removed: dbgid:AAA. From the next sync its documents are visible to their uploader and admins only.');
    button(page.row('dbgid:AAA'), 'Remove mapping').click();
    await flush();
    expect(page.count('mapRemove')).toBe(2);
    expect(button(page.row('dbgid:AAA'), 'Remove mapping').getAttribute('aria-label')).toBe('Remove mapping: dbgid:AAA');
  });

  it('unmapped rows offer no Remove mapping; the select starts at Not mapped and lists the workspace groups by name', async () => {
    const page = loadPage();
    await page.openMapping();
    const row = page.row('group-x@example.org');
    expect(row.querySelectorAll('button').map((b) => b.textContent.trim())).toEqual(['Save mapping']);
    const options = rowSelect(row).querySelectorAll('option');
    expect(options.map((o) => o.textContent)).toEqual(['Not mapped', 'group-a', 'group-b']);
    expect(rowSelect(row).value).toBe('');
    expect(rowSelect(page.row('dbgid:AAA')).value).toBe(G_A);
  });

  it('a group deleted meanwhile says error.groupGone and reloads the groups', async () => {
    const page = loadPage({ replies: { mapCreate: { status: 400, body: { success: false, error: 'unknown_group' } } } });
    await page.openMapping();
    const lists = page.count('list');
    pick(rowSelect(page.row('group-x@example.org')), G_A);
    button(page.row('group-x@example.org'), 'Save mapping').click();
    await flush();
    expect(page.status().textContent).toContain('no longer exists');
    expect(page.count('list')).toBeGreaterThan(lists);
  });

  it('nothing in the view starts a sync', async () => {
    const page = loadPage();
    await page.openMapping();
    pick(rowSelect(page.row('group-x@example.org')), G_A);
    button(page.row('group-x@example.org'), 'Save mapping').click();
    await flush();
    expect(page.calls.some((c) => /sync/i.test(c.path))).toBe(false);
    expect(page.panel().querySelectorAll('button').some((b) => /sync/i.test(b.textContent) && !/next sync/i.test(b.textContent))).toBe(false);
  });

  it('in multi-tenant mode mapping.personalNote says mappings do not change who sees those documents', async () => {
    const page = loadPage({ multiTenant: true, replies: { map: { status: 200, body: mapBody([UNMAPPED], { visibilityApplies: false }) } } });
    await page.openMapping();
    const note = page.panel().querySelector('[data-access-groups-mapping-note]')!;
    expect(note.className).toContain('alert-info');
    expect(note.textContent).toContain('Mappings are saved, but they do not change who can see those documents.');
  });

  it('nothing seen and nothing mapped shows mapping.empty; the rules table shows rules.empty', async () => {
    const page = loadPage({ replies: { map: { status: 200, body: mapBody([]) }, rules: { status: 200, body: rulesBody([]) } } });
    await page.openMapping();
    const empty = page.panel().querySelector('[data-access-groups-mapping-empty]')!;
    expect(empty.textContent).toContain('No source groups seen yet');
    expect(empty.textContent).toContain('Select New mapping to add one in advance.');
    expect(page.panel().querySelector('[data-access-groups-rules-empty]')!.textContent).toBe(
      'No sharing with a whole domain or by link seen yet. Rules appear after the next connector sync.',
    );
  });

  it('50 rows per page, then Load more asks for the next offset and moves focus to the first new row', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...UNMAPPED, externalPrincipalId: 'group-' + i + '@example.org' }));
    const page = loadPage({
      replies: {
        map: [
          { status: 200, body: mapBody(many, { total: 51, nextOffset: 50 }) },
          { status: 200, body: mapBody([{ ...UNMAPPED, externalPrincipalId: 'group-50@example.org' }], { total: 51, nextOffset: null }) },
        ],
      },
    });
    await page.openMapping();
    expect(page.rows()).toHaveLength(50);
    button(page.panel(), 'Load more source groups').click();
    await flush();
    expect(page.last('map').query.get('offset')).toBe('50');
    expect(page.rows()).toHaveLength(51);
    expect(page.doc.activeElement).toBe(rowSelect(page.row('group-50@example.org')));
  });

  it('a personal workspace shows groups.personal', async () => {
    const page = loadPage({ replies: { map: { status: 200, body: { success: true, personal: true, visibilityApplies: false, rows: [], total: 0, nextOffset: null } }, rules: { status: 200, body: { success: true, personal: true, visibilityApplies: false, rules: [] } } } });
    await page.openMapping();
    expect(page.panel().textContent).toContain('A personal workspace has one user');
    expect(page.rows()).toHaveLength(0);
  });

  it('sign-in failures replace the view with the shared sign-in alert', async () => {
    const page = loadPage({ replies: { map: { status: 401, body: { success: false, error: 'Unauthorized' } } } });
    await page.openMapping();
    expect(page.panel().querySelector('.alert-warning')).toBeTruthy();
    expect(page.rows()).toHaveLength(0);
  });
});

describe('New mapping form (D-20, UI-SPEC 6.5, 9.5, 9.6)', () => {
  async function openForm(options: PageOptions = {}) {
    const page = loadPage(options);
    await page.openMapping();
    button(page.panel(), 'New mapping').click();
    const form = page.panel().querySelector('[data-access-groups-mapping-form]')!;
    return { page, form };
  }

  it('Create mapping is disabled until all three fields are filled; the findings line names the missing fields', async () => {
    const { page, form } = await openForm();
    const create = button(form, 'Create mapping');
    expect(create.disabled).toBe(true);
    const findings = form.querySelector('[data-access-groups-mapping-findings]')!;
    expect(findings.textContent).toBe('To create the mapping, fill in: Source, Group or team ID at the source, Access group.');
    expect(create.getAttribute('aria-describedby')).toContain(findings.id);
    pick(form.querySelector('[data-access-groups-mapping-provider]')!, 'dropbox');
    typeInto(form.querySelector('[data-access-groups-mapping-principal]')!, 'dbgid:CCC');
    expect(button(form, 'Create mapping').disabled).toBe(true);
    pick(form.querySelector('[data-access-groups-mapping-group]')!, G_A);
    expect(button(form, 'Create mapping').disabled).toBe(false);
    button(form, 'Create mapping').click();
    await flush();
    expect(page.body('mapCreate')).toEqual({ provider: 'dropbox', kind: 'team', externalPrincipalId: 'dbgid:CCC', groupId: G_A });
    expect(page.status().textContent).toBe('dbgid:CCC is mapped to group-a. Applies at the next sync.');
    expect(page.panel().querySelector('[data-access-groups-mapping-form]')).toBeNull();
  });

  it('the source id field is mono, untranslated and not autocorrected; a Notion mapping is the whole workspace', async () => {
    const { page, form } = await openForm();
    const principal = form.querySelector('[data-access-groups-mapping-principal]')!;
    expect(principal.className).toContain('font-mono');
    expect(principal.getAttribute('autocomplete')).toBe('off');
    expect(principal.getAttribute('spellcheck')).toBe('false');
    expect(principal.getAttribute('translate')).toBe('no');
    expect(form.querySelector('label[for="' + principal.id + '"]')).toBeTruthy();
    pick(form.querySelector('[data-access-groups-mapping-provider]')!, 'notion');
    typeInto(principal, 'workspace-2');
    pick(form.querySelector('[data-access-groups-mapping-group]')!, G_B);
    button(form, 'Create mapping').click();
    await flush();
    expect(page.body('mapCreate')).toMatchObject({ provider: 'notion', kind: 'workspace' });
  });

  it('mapping_exists shows error.mappingExists at the form and keeps it open', async () => {
    const { page, form } = await openForm({ replies: { mapCreate: { status: 409, body: { success: false, error: 'mapping_exists' } } } });
    pick(form.querySelector('[data-access-groups-mapping-provider]')!, 'google-drive');
    typeInto(form.querySelector('[data-access-groups-mapping-principal]')!, 'group-x@example.org');
    pick(form.querySelector('[data-access-groups-mapping-group]')!, G_A);
    button(form, 'Create mapping').click();
    await flush();
    const still = page.panel().querySelector('[data-access-groups-mapping-form]')!;
    const principal = still.querySelector('[data-access-groups-mapping-principal]')!;
    expect(principal.getAttribute('aria-invalid')).toBe('true');
    expect(still.textContent).toContain('This group or team is already mapped. Change its access group in the table.');
    expect(page.doc.activeElement).toBe(principal);
  });

  it('Close form and Escape close it and return focus to New mapping', async () => {
    const { page, form } = await openForm();
    form.querySelector('[data-access-groups-mapping-principal]')!.dispatch('keydown', { key: 'Escape' });
    expect(page.panel().querySelector('[data-access-groups-mapping-form]')).toBeNull();
    expect(page.doc.activeElement?.textContent).toBe('New mapping');
  });
});

describe('Sharing rules (D-20, UI-SPEC 6.5, decisions 11 and 17)', () => {
  function toggle(page: ReturnType<typeof loadPage>, id: string): FakeElement {
    return page.ruleRow(id).querySelector('[data-access-groups-rule-toggle]') as FakeElement;
  }

  it('lists domain, link and published sharing with counts and a toggle with the word On or Off', async () => {
    const page = loadPage();
    await page.openMapping();
    expect(page.ruleRows()).toHaveLength(3);
    const domain = page.ruleRow(R_1);
    expect(domain.textContent).toContain('Google Drive');
    expect(domain.textContent).toContain('Everyone at example.org');
    expect(domain.querySelector('code')!.textContent).toBe('example.org');
    expect(domain.textContent).toContain('14');
    expect(domain.querySelector('[data-access-groups-rule-word]')!.textContent).toBe('Off');
    expect(page.ruleRow(R_3).querySelector('[data-access-groups-rule-word]')!.textContent).toBe('On');
    expect(toggle(page, R_1).getAttribute('aria-label')).toBe('Count as Everyone: Everyone at example.org, Google Drive');
    expect(toggle(page, R_1).className).toContain('toggle');
  });

  it('turning a rule on opens the confirmation with source, rule and count, focused on Keep rule off; Keep rule off sends nothing', async () => {
    const page = loadPage();
    await page.openMapping();
    const t = toggle(page, R_2);
    t.checked = true;
    t.dispatch('change');
    await flush();
    const dialog = page.dialog()!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Count this sharing as Everyone?');
    expect(dialog.textContent).toContain('Google Drive, Anyone with the link. Documents: 3. From the next sync they are visible to everyone who can use this workspace.');
    expect(page.doc.activeElement?.textContent).toBe('Keep rule off');
    expect(button(dialog, 'Turn rule on').className).toContain('btn-primary');
    expect(toggle(page, R_2).checked).toBe(false);
    button(dialog, 'Keep rule off').click();
    await flush();
    expect(page.count('ruleChange')).toBe(0);
    expect(toggle(page, R_2).checked).toBe(false);
  });

  it('confirming PUTs enabled true and announces rules.turnedOn with the next-sync clause', async () => {
    const page = loadPage({ replies: { ruleChange: { status: 200, body: { success: true, rule: { id: R_2, enabled: true, outcome: 'enabled' }, appliesAt: 'next_sync' } } } });
    await page.openMapping();
    const t = toggle(page, R_2);
    t.checked = true;
    t.dispatch('change');
    await flush();
    button(page.dialog()!, 'Turn rule on').click();
    await flush();
    expect(page.last('ruleChange').path).toContain('/sharing-rules/' + R_2);
    expect(page.body('ruleChange')).toEqual({ enabled: true });
    expect(page.status().textContent).toBe('Rule on: Anyone with the link, Google Drive. Applies at the next sync.');
    expect(page.ruleRow(R_2).querySelector('[data-access-groups-rule-word]')!.textContent).toBe('On');
    expect(page.dialog()).toBeNull();
  });

  it('turning a rule off acts at once without a dialog', async () => {
    const page = loadPage({ replies: { ruleChange: { status: 200, body: { success: true, rule: { id: R_3, enabled: false, outcome: 'disabled' }, appliesAt: 'next_sync' } } } });
    await page.openMapping();
    const t = toggle(page, R_3);
    t.checked = false;
    t.dispatch('change');
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.body('ruleChange')).toEqual({ enabled: false });
    expect(page.status().textContent).toBe('Rule off: Published to the web, Notion. From the next sync those documents are visible to their uploader and admins only.');
  });

  it('Add domain rule refuses a malformed domain with rules.badDomain and creates a valid rule off', async () => {
    const page = loadPage();
    await page.openMapping();
    button(page.panel(), 'Add domain rule').click();
    const form = page.panel().querySelector('[data-access-groups-rule-form]')!;
    const domain = form.querySelector('[data-access-groups-rule-domain]')!;
    pick(form.querySelector('[data-access-groups-rule-provider]')!, 'google-drive');
    typeInto(domain, 'https://example.org/path');
    const after = page.panel().querySelector('[data-access-groups-rule-form]')!;
    expect(after.querySelector('[data-access-groups-rule-domain]')!.getAttribute('aria-invalid')).toBe('true');
    expect(after.textContent).toContain('Enter a domain such as example.org, without a scheme, path or port.');
    expect(button(after, 'Create rule').disabled).toBe(true);
    button(after, 'Create rule').click();
    await flush();
    expect(page.count('ruleCreate')).toBe(0);
    typeInto(after.querySelector('[data-access-groups-rule-domain]')!, 'Example.org');
    expect(after.querySelector('[data-access-groups-rule-domain]')!.getAttribute('aria-invalid')).toBeNull();
    button(after, 'Create rule').click();
    await flush();
    expect(page.body('ruleCreate')).toEqual({ provider: 'google-drive', kind: 'domain', domain: 'example.org' });
    expect(page.body('ruleCreate')).not.toHaveProperty('enabled');
    expect(page.status().textContent).toContain('next sync');
  });
});

describe('text only (T-04.3-442)', () => {
  it('markup and script injected into source group ids and domains create no element and no link', async () => {
    const page = loadPage({
      replies: {
        map: { status: 200, body: mapBody([{ ...UNMAPPED, externalPrincipalId: XSS_PAYLOAD }, { ...MAPPED, externalPrincipalId: 'javascript:PWNED(2)' }]) },
        rules: { status: 200, body: rulesBody([{ ...RULES[0], domain: XSS_PAYLOAD }]) },
        list: { status: 200, body: { ...listBody(1), groups: [group(G_A, XSS_PAYLOAD)] } },
      },
    });
    await page.openMapping();
    expect(injectedElements(page.root)).toEqual([]);
    expect(page.root.querySelectorAll('a')).toHaveLength(0);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.row(XSS_PAYLOAD).querySelector('code')!.textContent).toBe(XSS_PAYLOAD);
    pick(rowSelect(page.row(XSS_PAYLOAD)), G_A);
    button(page.row(XSS_PAYLOAD), 'Save mapping').click();
    await flush();
    expect(injectedElements(page.root)).toEqual([]);
  });

  it('the panel writes no innerHTML in the mapping code', () => {
    expect(panelSource).not.toMatch(/\.innerHTML\s*=/);
    expect(panelSource).not.toMatch(/insertAdjacentHTML/);
  });
});

describe('locales (UI-SPEC 12.4)', () => {
  it('zh and it render the mapping view', async () => {
    const zh = loadPage({ locale: 'zh-CN' });
    await zh.openMapping();
    expect(zh.row('group-x@example.org').textContent).toContain('未映射');
    expect(button(zh.panel(), '新建映射')).toBeTruthy();
    const it_ = loadPage({ locale: 'it-IT' });
    await it_.openMapping();
    expect(it_.row('workspace-1').textContent).toContain('Intero spazio di lavoro');
    expect(button(it_.panel(), 'Aggiungi regola di dominio')).toBeTruthy();
  });
});

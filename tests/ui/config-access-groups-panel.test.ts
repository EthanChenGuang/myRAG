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
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/access-groups.js'), 'utf8');

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}
type Route = 'status' | 'sync' | 'drift';

interface PanelModule {
  ACCESS_GROUPS_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
  buildAccessGroupsEnforcementView: (saved: string, status: Json | null) => { state: string; canSync: boolean; actions: string[] };
  accessGroupsDriftView: (body: Json) => { stores: Array<{ store: string; rows: number }>; differing: unknown[]; total: number };
  accessGroupsEmbedCheck: (value: string, switchValue: string, embedGroup: Json | null) => { finding: { key: string } | null; warn: boolean };
  mapAccessGroupsError: (result: Json | null, locale: string, ctx?: Json) => { key: string; kind: string; message: string };
  accessGroupsLabel: (key: string, locale: string, vars?: Json) => string;
}

function loadModule(): PanelModule {
  return require('../../scripts/config-ui/rag-panels/access-groups.js') as PanelModule;
}

function status(extra: Json = {}): Json {
  return {
    runningSwitch: 'on',
    databaseFlag: true,
    status: 'ready',
    ready: true,
    reasons: [],
    objects: [],
    embedGroup: null,
    checkedAt: '2026-11-26T10:00:00.000Z',
    ...extra,
  };
}

const OFF = status({ runningSwitch: 'off', databaseFlag: false, status: 'off', ready: false });

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  if (apiPath === '/api/rag/access-groups/status' && method === 'GET') return 'status';
  if (apiPath === '/api/rag/access-groups/status/sync' && method === 'POST') return 'sync';
  if (apiPath === '/api/rag/access-groups/drift' && method === 'POST') return 'drift';
  return 'unknown';
}

interface PageOptions {
  locale?: string;
  saved?: string;
  embed?: string;
  replies?: Partial<Record<Route, Reply | Reply[]>>;
  hold?: Route[];
}

function loadPage(options: PageOptions = {}) {
  const doc = new FakeDocument();
  const calls: Array<{ route: string; init: Json }> = [];
  const held = new Map<Route, Array<(reply: Reply) => void>>();
  for (const label of ['desktop', 'mobile']) {
    const link = doc.createElement('a');
    link.setAttribute('data-tab', 'rag-administration');
    link.setAttribute('data-test-link', label);
    doc.body.appendChild(link);
  }
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  const settingsHolder = doc.createElement('div');
  tab.appendChild(settingsHolder);
  settingsHolder.innerHTML = markedBlock('rag-phase043-settings');
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-access-groups');
  const select = doc.getElementById('RAG_DOC_ACCESS_GROUPS')!;
  select.value = options.saved ?? 'on';
  const embed = doc.getElementById('RAG_EMBED_ACCESS_GROUP')!;
  embed.value = options.embed ?? '';
  doc.innerHtmlWrites = 0;

  const queues: Partial<Record<Route, Reply[]>> = {};
  for (const [route, reply] of Object.entries(options.replies ?? {})) queues[route as Route] = Array.isArray(reply) ? [...reply] : [reply as Reply];
  const defaults: Record<Route, Reply> = {
    status: { status: 200, body: { success: true, status: status() } },
    sync: { status: 200, body: { success: true, status: status() } },
    drift: { status: 200, body: { success: true, stores: [{ store: 'document_chunks', rows: 0 }], checkedAt: '2026-11-26T10:05:00.000Z' } },
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
    calls.push({ route, init });
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
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/access-groups.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-access') as FakeElement;
  return {
    doc,
    context,
    root,
    select,
    embed,
    calls,
    count(route: Route) {
      return calls.filter((c) => c.route === route).length;
    },
    release(route: Route, reply: Reply) {
      const queue = held.get(route) ?? [];
      const resolve = queue.shift();
      if (!resolve) throw new Error('nothing held for ' + route);
      resolve(reply);
    },
    async init() {
      const init = context.initAccessGroupsPanel as () => Promise<void>;
      await init();
      await flush();
    },
    badge(): FakeElement | null {
      return root.querySelector('[data-access-groups-badge]');
    },
    stateHost(): FakeElement {
      return root.querySelector('[data-access-groups-state]') as FakeElement;
    },
    statusRegion(): FakeElement {
      return root.querySelector('[data-access-groups-status]') as FakeElement;
    },
    alertHost(): FakeElement {
      return root.querySelector('[data-access-groups-alert]') as FakeElement;
    },
    saved(config: Json) {
      context.configManager = { savedConfig: config };
      for (const fn of doc.listeners.get('rag:config-saved') ?? []) fn({ type: 'rag:config-saved', detail: { config } } as never);
    },
  };
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function button(root: FakeElement, text: string): FakeElement {
  const found = root.querySelectorAll('button').find((b) => b.textContent.trim() === text);
  if (!found) throw new Error('no button ' + text);
  return found;
}

function buttonTexts(root: FakeElement): string[] {
  return root.querySelectorAll('button').map((b) => b.textContent.trim());
}

describe('the enforcement state builder (A-03, UI-SPEC 6.6)', () => {
  const { buildAccessGroupsEnforcementView } = loadModule();

  it('off: saved, running and database all off', () => {
    expect(buildAccessGroupsEnforcementView('off', OFF).state).toBe('off');
  });

  it('enforced: all on and ready', () => {
    expect(buildAccessGroupsEnforcementView('on', status()).state).toBe('enforced');
  });

  it('restart: the saved setting differs from the running app', () => {
    expect(buildAccessGroupsEnforcementView('on', OFF).state).toBe('restart');
    expect(buildAccessGroupsEnforcementView('off', status()).state).toBe('restart');
  });

  it('unsynced: the running app and the database flag differ; Sync is offered', () => {
    const view = buildAccessGroupsEnforcementView('off', { ...OFF, databaseFlag: true });
    expect(view.state).toBe('unsynced');
    expect(view.actions).toEqual(['sync', 'check']);
    expect(buildAccessGroupsEnforcementView('off', { ...OFF, databaseFlag: null }).state).toBe('unsynced');
  });

  it('blocked: running on and not ready', () => {
    const view = buildAccessGroupsEnforcementView('on', status({ status: 'not_ready', ready: false, reasons: ['readiness_not_ready', 'column_missing'] }));
    expect(view.state).toBe('blocked');
    expect(view.actions).toEqual(['check']);
  });

  it('blocked offers Sync only when the flag write is among the reasons', () => {
    for (const reason of ['flag_write_failed', 'flag_readback_mismatch']) {
      const view = buildAccessGroupsEnforcementView('on', status({ status: 'not_ready', ready: false, reasons: [reason], databaseFlag: null }));
      expect(view.state).toBe('blocked');
      expect(view.actions).toEqual(['sync', 'check']);
    }
  });

  it('unknown: no status answer', () => {
    expect(buildAccessGroupsEnforcementView('on', null).state).toBe('unknown');
    expect(buildAccessGroupsEnforcementView('off', null).actions).toEqual(['check']);
  });

  it('precedence: blocked wins over unsynced, which wins over restart', () => {
    const blockedAndUnsynced = status({ status: 'not_ready', ready: false, databaseFlag: false, reasons: ['flag_write_failed'] });
    expect(buildAccessGroupsEnforcementView('off', blockedAndUnsynced).state).toBe('blocked');
    const unsyncedAndRestart = { ...OFF, databaseFlag: true };
    expect(buildAccessGroupsEnforcementView('on', unsyncedAndRestart).state).toBe('unsynced');
  });
});

describe('labels (UI-SPEC 12.2 to 12.5)', () => {
  const { ACCESS_GROUPS_LABELS, accessGroupsLabel } = loadModule();

  it('has every key in en, zh and it', () => {
    const en = Object.keys(ACCESS_GROUPS_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(250);
    expect(Object.keys(ACCESS_GROUPS_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(ACCESS_GROUPS_LABELS.it).sort()).toEqual(en);
  });

  it('fills placeholders and falls back to English, then to the shared table', () => {
    expect(accessGroupsLabel('group.members', 'it', { count: 3 })).toBe('Membri: 3');
    expect(accessGroupsLabel('enforce.state.blocked', 'fr')).toBe('Blocked');
    expect(accessGroupsLabel('action.reload', 'zh')).toBe('重新加载面板');
  });

  it('every count is "label: number", with no plural form', () => {
    for (const locale of ['en', 'zh', 'it'] as const) {
      for (const [key, text] of Object.entries(ACCESS_GROUPS_LABELS[locale])) {
        if (!text.includes('{count}') && !text.includes('{n}')) continue;
        expect(text, `${locale} ${key}`).toMatch(/[:：]\s?\{(count|n)\}/);
      }
    }
  });

  it('carries no domain example strings', () => {
    const all = JSON.stringify(ACCESS_GROUPS_LABELS).toLowerCase();
    for (const word of ['travel', 'hotel', 'salary', 'leave day', 'restaurant', 'vpn', 'password', 'branch']) expect(all).not.toContain(word);
  });
});

describe('mount (D-28, UI-SPEC 6.1)', () => {
  it('index.html has the section after Upload approvals and before Document tags, and the script after rag-ui.js', () => {
    const approvals = indexHtml.indexOf('id="rag-administration-approvals"');
    const access = indexHtml.indexOf('id="rag-administration-access"');
    const scopes = indexHtml.indexOf('id="rag-administration-scopes"');
    expect(access).toBeGreaterThan(approvals);
    expect(scopes).toBeGreaterThan(access);
    const ui = indexHtml.indexOf('<script src="rag-panels/rag-ui.js">');
    const script = indexHtml.indexOf('<script src="rag-panels/access-groups.js">');
    expect(script).toBeGreaterThan(ui);
    const section = markedBlock('rag-access-groups');
    expect(section).toContain('scroll-mt-4');
    expect(section).toMatch(/<h3 [^>]*tabindex="-1"/);
    expect(section).toMatch(/role="status" aria-live="polite"/);
    expect(indexHtml).toContain('held uploads, access groups, tags');
  });

  it('every top-level name of the script is namespaced', () => {
    const names = [...panelSource.matchAll(/^(?:const|let|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(name, name).toMatch(/^(AccessGroups|ACCESS_GROUPS_|accessGroups|buildAccessGroups|mapAccessGroups|initAccessGroups)/);
  });

  it('a second init mounts once and refreshes the status', async () => {
    const page = loadPage();
    await page.init();
    const tablist = page.root.querySelectorAll('[role="tablist"]');
    expect(tablist).toHaveLength(1);
    await page.init();
    expect(page.root.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(page.root.querySelectorAll('[data-access-groups-state]')).toHaveLength(1);
    expect(page.count('status')).toBe(2);
  });

  it('every RAG administration link starts the panel', async () => {
    const page = loadPage();
    page.doc.dispatch('DOMContentLoaded');
    await flush();
    expect(page.context.accessGroupsPanel).toBeTruthy();
    const links = page.doc.querySelectorAll('[data-tab="rag-administration"]');
    expect(links.every((l) => l.getAttribute('data-access-groups-bound') === '1')).toBe(true);
  });

  it('shows the badge with icon and word and the state sentence', async () => {
    const page = loadPage();
    await page.init();
    const badge = page.badge()!;
    expect(badge.getAttribute('data-access-groups-badge')).toBe('enforced');
    expect(badge.className).toContain('badge-success');
    expect(badge.querySelector('i')!.className).toContain('bi-shield-check');
    expect(badge.textContent).toBe('Enforced');
    expect(page.stateHost().textContent).toContain('Access groups are applied in search, answers, citations');
    const dl = page.stateHost().querySelector('dl')!;
    expect(dl.querySelectorAll('dt').map((d) => d.textContent)).toEqual(['Saved setting', 'Running app', 'Database', 'Checked']);
    expect(dl.querySelectorAll('dd').slice(0, 3).map((d) => d.textContent)).toEqual(['On', 'On', 'Enforced']);
    expect(dl.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-26T10:00:00.000Z');
    expect(buttonTexts(page.stateHost())).toEqual(['Check again']);
  });

  it('moves the settings group into the Settings block and keeps the ids', async () => {
    const page = loadPage();
    await page.init();
    const settings = page.root.querySelector('[data-access-groups-settings]')!;
    const group = settings.querySelector('[data-rag-settings-group="access"]')!;
    expect(group).toBeTruthy();
    expect(group.querySelector('#RAG_DOC_ACCESS_GROUPS')).toBeTruthy();
    expect(group.querySelector('#RAG_EMBED_ACCESS_GROUP')).toBeTruthy();
    expect(page.doc.getElementById('rag-phase043-settings')!.querySelector('[data-rag-settings-group="access"]')).toBeNull();
  });

  it('reads Not checked with a spinner until the status call answers', async () => {
    const page = loadPage({ hold: ['status'] });
    const done = (page.context.initAccessGroupsPanel as () => Promise<void>)();
    await flush();
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('unknown');
    expect(page.badge()!.textContent).toBe('Not checked');
    expect(page.stateHost().querySelector('.loading')).toBeTruthy();
    page.release('status', { status: 200, body: { success: true, status: status() } });
    await done;
    await flush();
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('enforced');
  });

  it.each([
    ['off', 'off', OFF, 'Access groups are off. Every member sees every document', ['Check again']],
    ['restart', 'on', OFF, 'The saved setting is On, but the running app still uses Off.', ['Check again']],
    ['unsynced', 'off', { ...OFF, databaseFlag: true }, 'the app is Off, the database is Enforced', ['Sync enforcement', 'Check again']],
    ['blocked', 'on', status({ status: 'not_ready', ready: false, reasons: ['column_missing'], objects: ['document_parents'] }), 'a part of the system cannot apply them', ['Check again']],
  ])('state %s shows its badge, sentence, values and action', async (state, saved, body, sentence, actions) => {
    const page = loadPage({ saved, replies: { status: { status: 200, body: { success: true, status: body } } } });
    await page.init();
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe(state);
    expect(page.stateHost().textContent).toContain(sentence);
    expect(page.stateHost().querySelectorAll('dd')).toHaveLength(4);
    expect(buttonTexts(page.stateHost())).toEqual(actions);
  });

  it('the saved setting comes from the page config when it is loaded', async () => {
    const page = loadPage({ saved: 'on', replies: { status: { status: 200, body: { success: true, status: OFF } } } });
    page.context.configManager = { savedConfig: { RAG_DOC_ACCESS_GROUPS: 'off' } };
    await page.init();
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('off');
  });

  it('localizes the panel and the settings in zh and it', async () => {
    const zh = loadPage({ locale: 'zh-CN' });
    await zh.init();
    expect(zh.root.getAttribute('lang')).toBe('zh');
    expect(zh.badge()!.textContent).toBe('已生效');
    expect(zh.root.querySelector('label[for="RAG_DOC_ACCESS_GROUPS"]')!.textContent.trim()).toBe('访问组');
    const it_ = loadPage({ locale: 'it-IT' });
    await it_.init();
    expect(it_.badge()!.textContent).toBe('Applicato');
    expect(it_.doc.getElementById('RAG_DOC_ACCESS_GROUPS')!.querySelector('option')!.textContent).toBe('Disattivati, come oggi');
  });
});

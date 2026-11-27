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

describe('sync, label check, settings, alerts and errors (A-03, A-08, D-03, D-07, D-09)', () => {
  it('Sync enforcement runs status/sync, re-reads and announces sync.done', async () => {
    const page = loadPage({
      saved: 'off',
      replies: { status: { status: 200, body: { success: true, status: { ...OFF, databaseFlag: true } } }, sync: { status: 200, body: { success: true, status: OFF } } },
    });
    await page.init();
    button(page.stateHost(), 'Sync enforcement').click();
    await flush();
    expect(page.count('sync')).toBe(1);
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('off');
    expect(page.statusRegion().textContent).toBe('The database now matches the app: Not enforced.');
  });

  it('a running sync shows its in-flight text with Check again disabled', async () => {
    const page = loadPage({ saved: 'off', hold: ['sync'], replies: { status: { status: 200, body: { success: true, status: { ...OFF, databaseFlag: true } } } } });
    await page.init();
    const sync = button(page.stateHost(), 'Sync enforcement');
    sync.click();
    await flush();
    expect(sync.textContent).toBe('Syncing…');
    expect(sync.disabled).toBe(true);
    expect(button(page.stateHost(), 'Check again').disabled).toBe(true);
    page.release('sync', { status: 200, body: { success: true, status: OFF } });
    await flush();
  });

  it('a failed sync shows sync.failed as an alert and the state stays Blocked', async () => {
    const blocked = status({ status: 'not_ready', ready: false, databaseFlag: null, reasons: ['flag_write_failed'] });
    const page = loadPage({ replies: { status: { status: 200, body: { success: true, status: blocked } }, sync: { status: 200, body: { success: true, status: blocked } } } });
    await page.init();
    button(page.stateHost(), 'Sync enforcement').click();
    await flush();
    const alert = page.root.querySelector('[data-access-groups-sync-alert] [role="alert"]')!;
    expect(alert.textContent).toContain('The database setting could not be written.');
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('blocked');
  });

  it('a sync answered with 503 also shows sync.failed', async () => {
    const blocked = status({ status: 'not_ready', ready: false, databaseFlag: null, reasons: ['flag_write_failed'] });
    const page = loadPage({ replies: { status: { status: 200, body: { success: true, status: blocked } }, sync: { status: 503, body: { success: false, error: 'access_groups_unavailable' } } } });
    await page.init();
    button(page.stateHost(), 'Sync enforcement').click();
    await flush();
    expect(page.root.querySelector('[data-access-groups-sync-alert] [role="alert"]')).toBeTruthy();
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('blocked');
  });

  it('a sync timeout shows error.outcomeUnknown and reloads the status', async () => {
    const page = loadPage({ saved: 'off', replies: { status: { status: 200, body: { success: true, status: { ...OFF, databaseFlag: true } } }, sync: { status: 0, throws: true } } });
    await page.init();
    button(page.stateHost(), 'Sync enforcement').click();
    await flush();
    expect(page.statusRegion().textContent).toContain('may or may not have been made');
    expect(page.count('status')).toBe(2);
  });

  it('lists the blocked reasons; an unknown code is shown in font-mono inside a sentence', async () => {
    const page = loadPage({
      replies: {
        status: {
          status: 200,
          body: { success: true, status: status({ status: 'not_ready', ready: false, reasons: ['readiness_not_ready', 'function_missing_filter', 'mystery_code'], objects: ['match_chunks'] }) },
        },
      },
    });
    await page.init();
    const items = page.stateHost().querySelectorAll('li');
    expect(items.map((li) => li.getAttribute('data-access-groups-reason'))).toEqual(['function_missing_filter', 'mystery_code']);
    expect(items[0]!.textContent).toBe('A search function has no access filter: match_chunks. Apply the database migrations 0920 to 0939.');
    expect(items[0]!.querySelector('code')!.textContent).toBe('match_chunks');
    const code = items[1]!.querySelector('code')!;
    expect(code.className).toContain('font-mono');
    expect(items[1]!.textContent).toBe('Reported with the code mystery_code. Check the app log for [RAG Access].');
  });

  it('label check not run yet shows drift.body and the button only, no repair button', async () => {
    const page = loadPage();
    await page.init();
    const drift = page.root.querySelector('[data-access-groups-drift]')!;
    expect(drift.childNodes).toHaveLength(0);
    expect(page.root.textContent).toContain('This check finds copies that differ from their document.');
    expect(buttonTexts(page.root).filter((t) => /repair/i.test(t))).toEqual([]);
  });

  it('Run label check shows drift.none with the time', async () => {
    const page = loadPage();
    await page.init();
    button(page.root, 'Run label check').click();
    await flush();
    expect(page.count('drift')).toBe(1);
    expect(page.root.querySelector('[data-access-groups-drift]')!.textContent).toMatch(/^No differences found\. Checked .+\.$/);
  });

  it('a running label check shows drift.running on the button and in the result', async () => {
    const page = loadPage({ hold: ['drift'] });
    await page.init();
    const run = button(page.root, 'Run label check');
    run.click();
    await flush();
    expect(run.textContent).toBe('Checking…');
    expect(page.root.querySelector('[data-access-groups-drift]')!.textContent).toBe('Checking…');
    page.release('drift', { status: 200, body: { success: true, stores: [], checkedAt: null } });
    await flush();
  });

  it('drift.found lists only the stores the server reports, never a missing store as zero', async () => {
    const page = loadPage({
      replies: { drift: { status: 200, body: { success: true, stores: [{ store: 'document_chunks', rows: 3 }, { store: 'document_parents', rows: 0 }, { store: 'new_store', rows: 2 }], checkedAt: '2026-11-26T10:05:00.000Z' } } },
    });
    await page.init();
    button(page.root, 'Run label check').click();
    await flush();
    const host = page.root.querySelector('[data-access-groups-drift]')!;
    expect(host.textContent).toContain('Rows that differ from their document: 5.');
    const rows = host.querySelectorAll('tr[data-access-groups-drift-row]');
    expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(['Chunks', 'The server reported new_store.']);
    expect(host.textContent).not.toContain('Translations');
    expect(host.textContent).not.toContain('Table rows');
  });

  it('a failed label check shows drift.unavailable', async () => {
    const page = loadPage({ replies: { drift: { status: 503, body: { success: false, error: 'access_groups_unavailable' } } } });
    await page.init();
    button(page.root, 'Run label check').click();
    await flush();
    expect(page.root.querySelector('[data-access-groups-drift]')!.textContent).toBe('The label check could not run. Select Run label check in a moment.');
  });

  it('the what-it-does-now sentence follows the select before saving', async () => {
    const page = loadPage({ saved: 'off' });
    await page.init();
    const help = page.doc.getElementById('rag-doc-access-groups-help')!;
    expect(help.textContent).toContain('Every member sees every document.');
    page.select.value = 'on';
    page.select.dispatch('change');
    expect(help.textContent).toContain('A restricted document is visible only to members of its groups');
  });

  it('a group key while the switch is off shows warn.embedNeedsSwitch; a malformed key shows form.badKey', async () => {
    const page = loadPage({ saved: 'off' });
    await page.init();
    page.embed.value = 'group-a';
    page.embed.dispatch('input');
    expect(page.root.textContent).toContain('The embedded chat group has no effect while access groups are off.');
    page.embed.value = 'Group A';
    page.embed.dispatch('input');
    expect(page.root.textContent).toContain('Use lower-case letters, digits and hyphens, starting with a letter or a digit.');
    expect(page.embed.getAttribute('aria-invalid')).toBe('true');
    expect(page.embed.getAttribute('aria-describedby')).toContain('rag-access-groups-embed-check');
    page.select.value = 'on';
    page.select.dispatch('change');
    page.embed.value = 'group-a';
    page.embed.dispatch('input');
    expect(page.root.textContent).not.toContain('has no effect while access groups are off');
    expect(page.embed.getAttribute('aria-invalid')).toBeNull();
  });

  it('the status check of the embed group shows found with its name or notFound', async () => {
    const found = loadPage({ embed: 'group-a', replies: { status: { status: 200, body: { success: true, status: status({ embedGroup: { key: 'group-a', valid: true, exists: true, name: 'Group A' } }) } } } });
    await found.init();
    expect(found.root.textContent).toContain('Group found: Group A.');
    const missing = loadPage({ embed: 'group-a', replies: { status: { status: 200, body: { success: true, status: status({ embedGroup: { key: 'group-a', valid: true, exists: false, name: null } }) } } } });
    await missing.init();
    expect(missing.root.textContent).toContain('No group with this key exists in the embedded chat');
  });

  it('after Save All Changes that changed a setting, settings.restart appears', async () => {
    const page = loadPage({ saved: 'off', replies: { status: { status: 200, body: { success: true, status: OFF } } } });
    await page.init();
    expect(page.root.querySelector('[data-access-groups-restart]')!.textContent).toBe('');
    page.saved({ RAG_DOC_ACCESS_GROUPS: 'on', RAG_EMBED_ACCESS_GROUP: '' });
    expect(page.root.querySelector('[data-access-groups-restart]')!.textContent).toBe('Saved. Restart the app to apply.');
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('restart');
  });

  it('401 replaces the state with the sign-in alert and Reload panel; the Settings block stays usable', async () => {
    const page = loadPage({ replies: { status: { status: 401, body: { success: false, error: 'Unauthorized' } } } });
    await page.init();
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('unknown');
    expect(page.stateHost().querySelector('.alert-warning')).toBeTruthy();
    expect(page.stateHost().querySelector('i.bi-person-lock')).toBeTruthy();
    expect(buttonTexts(page.stateHost())).toEqual(['Reload panel']);
    expect(page.stateHost().querySelector('input[type="password"]')).toBeNull();
    const settings = page.root.querySelector('[data-access-groups-settings]')!;
    expect(settings.querySelector('#RAG_DOC_ACCESS_GROUPS')!.disabled).toBe(false);
    page.select.value = 'on';
    page.select.dispatch('change');
    expect(page.doc.getElementById('rag-doc-access-groups-help')!.textContent).toContain('A restricted document is visible only');
  });

  it('403 Admin access required is the sign-in alert too', async () => {
    const page = loadPage({ replies: { status: { status: 403, body: { success: false, error: 'Admin access required' } } } });
    await page.init();
    expect(page.stateHost().querySelector('i.bi-person-lock')).toBeTruthy();
  });

  it('503 shows the unavailable sentence with Reload panel and keeps earlier content dimmed', async () => {
    const page = loadPage({ replies: { status: [{ status: 200, body: { success: true, status: status() } }, { status: 503, body: { success: false, error: 'access_groups_unavailable' } }] } });
    await page.init();
    button(page.stateHost(), 'Check again').click();
    await flush();
    expect(page.stateHost().textContent).toContain('The enforcement status is unavailable right now. Select Reload panel in a moment.');
    expect(buttonTexts(page.stateHost())).toContain('Reload panel');
    const body = page.stateHost().querySelector('[data-access-groups-state-body]')!;
    expect(body.className).toContain('opacity-60');
    expect(page.badge()!.getAttribute('data-access-groups-badge')).toBe('enforced');
  });

  it('a refresh keeps content at 60% opacity with aria-busy while it runs', async () => {
    const page = loadPage({ hold: ['status'] });
    const first = (page.context.initAccessGroupsPanel as () => Promise<void>)();
    await flush();
    page.release('status', { status: 200, body: { success: true, status: status() } });
    await first;
    await flush();
    button(page.stateHost(), 'Check again').click();
    await flush();
    expect(page.stateHost().className).toContain('opacity-60');
    expect(page.stateHost().getAttribute('aria-busy')).toBe('true');
    page.release('status', { status: 200, body: { success: true, status: status() } });
    await flush();
    expect(page.stateHost().getAttribute('aria-busy')).toBeNull();
  });

  it('the alert host shows alert.blocked with a button that opens Enforcement', async () => {
    const page = loadPage({ replies: { status: { status: 200, body: { success: true, status: status({ status: 'not_ready', ready: false, reasons: ['column_missing'] }) } } } });
    await page.init();
    const alert = page.alertHost().querySelector('.alert-error')!;
    expect(alert.textContent).toContain('Access groups are on, but the app cannot apply them.');
    expect(alert.getAttribute('role')).toBeNull();
    button(alert, 'Open enforcement').click();
    expect(page.doc.activeElement!.id).toBe('rag-access-groups-tab-enforcement');
  });

  it('the alert host shows alert.off while the running app has the switch off', async () => {
    const page = loadPage({ saved: 'off', replies: { status: { status: 200, body: { success: true, status: OFF } } } });
    await page.init();
    const alert = page.alertHost().querySelector('.alert-info')!;
    expect(alert.textContent).toContain('Access groups are off. Groups, members and document access set here are saved but not applied');
    expect(buttonTexts(alert)).toEqual(['Open enforcement']);
    const enforced = loadPage();
    await enforced.init();
    expect(enforced.alertHost().childNodes).toHaveLength(0);
  });

  it('the error mapper splits 403 by body.error and maps writes (UI-SPEC 8.2)', () => {
    const { mapAccessGroupsError } = loadModule();
    expect(mapAccessGroupsError({ status: 403, body: { error: 'Admin access required' } }, 'en').kind).toBe('signIn');
    expect(mapAccessGroupsError({ status: 403, body: { error: 'Forbidden' } }, 'en').kind).toBe('workspace');
    expect(mapAccessGroupsError({ status: 401, body: {} }, 'en').kind).toBe('signIn');
    expect(mapAccessGroupsError({ thrown: true }, 'en', { write: true }).key).toBe('error.outcomeUnknown');
    expect(mapAccessGroupsError({ thrown: true }, 'en').key).toBe('error.network');
    expect(mapAccessGroupsError({ status: 404, body: {} }, 'en', { write: true }).key).toBe('error.changed');
    expect(mapAccessGroupsError({ status: 409, body: { error: 'whatever' } }, 'en', { write: true }).key).toBe('error.changed');
    expect(mapAccessGroupsError({ status: 400, body: { error: 'invalid_key' } }, 'en').key).toBe('form.badKey');
    expect(mapAccessGroupsError({ status: 400, body: { error: 'reserved_key' } }, 'en').key).toBe('form.reservedKey');
    expect(mapAccessGroupsError({ status: 503, body: { error: 'access_groups_unavailable' } }, 'en', { unavailable: 'U' }).message).toBe('U');
  });

  it('embed check and drift builders are pure', () => {
    const { accessGroupsEmbedCheck, accessGroupsDriftView } = loadModule();
    expect(accessGroupsEmbedCheck('', 'off', null)).toEqual({ finding: null, warn: false });
    expect(accessGroupsEmbedCheck('all', 'on', null).finding!.key).toBe('form.reservedKey');
    expect(accessGroupsEmbedCheck('group-a', 'off', null).warn).toBe(true);
    const view = accessGroupsDriftView({ stores: [{ store: 'document_chunks', rows: 0 }, { store: 'bad', rows: -1 }, null] });
    expect(view.stores).toEqual([{ store: 'document_chunks', key: 'drift.store.chunks', rows: 0 }]);
    expect(view.total).toBe(0);
  });

  it('markup injected into reason codes, objects, store names and the embed group name creates no element and no link', async () => {
    const hostile = 'javascript:alert(1)' + XSS_PAYLOAD;
    const page = loadPage({
      embed: 'group-a',
      replies: {
        status: {
          status: 200,
          body: {
            success: true,
            status: status({
              status: 'not_ready',
              ready: false,
              reasons: [hostile, 'column_missing'],
              objects: [hostile],
              embedGroup: { key: 'group-a', valid: true, exists: true, name: hostile },
            }),
          },
        },
        drift: { status: 200, body: { success: true, stores: [{ store: hostile, rows: 1 }], checkedAt: hostile } },
      },
    });
    await page.init();
    button(page.root, 'Run label check').click();
    await flush();
    expect(injectedElements(page.doc)).toHaveLength(0);
    expect(page.doc.querySelectorAll('a')).toHaveLength(2);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.root.textContent).toContain(XSS_PAYLOAD);
  });
});

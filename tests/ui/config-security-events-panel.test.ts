import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, injectedElements, XSS_PAYLOAD } from './helpers/html-fake-dom';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/security-events.js'), 'utf8');

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}

type Route = 'alerts' | 'uploaders' | 'events' | 'previews' | 'hold' | 'release' | 'acknowledge' | 'injection';

interface RagCall {
  route: Route | 'unknown';
  path: string;
  method: string;
  query: URLSearchParams;
  body: Json | null;
}

const BASE = '/api/rag/admin/security-events';

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const [pathname] = apiPath.split('?');
  if (pathname === BASE && method === 'GET') return 'events';
  if (pathname === `${BASE}/alerts` && method === 'GET') return 'alerts';
  if (pathname === `${BASE}/uploaders` && method === 'GET') return 'uploaders';
  if (pathname === `${BASE}/link-previews` && method === 'GET') return 'previews';
  if (/^\/api\/rag\/admin\/security-events\/uploaders\/[^/]+\/hold$/.test(pathname!) && method === 'POST') return 'hold';
  if (/^\/api\/rag\/admin\/security-events\/uploaders\/[^/]+\/release$/.test(pathname!) && method === 'POST') return 'release';
  if (/^\/api\/rag\/admin\/security-events\/alerts\/[^/]+\/acknowledge$/.test(pathname!) && method === 'POST') return 'acknowledge';
  return 'unknown';
}

function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const TENANT_A = 'o:aaaaaaaa-0000-4000-8000-000000000001';
const TENANT_B = 'o:bbbbbbbb-0000-4000-8000-000000000002';

function alertItem(n: number, extra: Json = {}): Json {
  return {
    id: uuid('a1', n),
    tenant_key: TENANT_A,
    workspace_name: 'Workspace 1',
    uploader_id: uuid('b1', n),
    uploader_name: `Uploader ${n}`,
    uploader_email: null,
    event_count: 7,
    window_hours: 24,
    threshold: 5,
    opened_at: '2026-11-20T09:30:00.000Z',
    status: 'open',
    held: false,
    ...extra,
  };
}

function alertsAnswer(items: Json[], extra: Json = {}): Json {
  return {
    success: true,
    events_recorded: true,
    hold_mode: 'manual',
    alert_level: 5,
    window_hours: 24,
    open_count: items.filter((i) => i.status === 'open').length,
    items,
    next_cursor: null,
    ...extra,
  };
}

function uploaderItem(n: number, extra: Json = {}): Json {
  return {
    user_id: uuid('b1', n),
    tenant_key: TENANT_A,
    workspace_name: 'Workspace 1',
    display_name: `Uploader ${n}`,
    email: null,
    event_count: n,
    last_event_at: '2026-11-21T10:00:00.000Z',
    held: false,
    held_since: null,
    ...extra,
  };
}

function uploadersAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, events_recorded: true, hold_mode: 'manual', window_hours: 24, items, next_cursor: null, ...extra };
}

function eventItem(n: number, extra: Json = {}): Json {
  return {
    id: uuid('c1', n),
    tenant_key: TENANT_A,
    workspace_name: 'Workspace 1',
    created_at: '2026-11-21T10:00:00.000Z',
    source: 'output_guard',
    action: 'removed',
    detector: 'rules',
    document_id: uuid('d1', n),
    file_name: `document-${n}.pdf`,
    uploader_id: uuid('b1', n),
    uploader_name: `Uploader ${n}`,
    uploader_email: null,
    rule_ids: ['rule-1', 'rule-2'],
    ...extra,
  };
}

function eventsAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, events_recorded: true, items, next_cursor: null, ...extra };
}

const DEFAULT_REPLIES: Record<Route, Reply> = {
  alerts: { status: 200, body: alertsAnswer([]) },
  uploaders: { status: 200, body: uploadersAnswer([]) },
  events: { status: 200, body: eventsAnswer([]) },
  previews: { status: 200, body: { success: true, state: 'none', preview_hosts: [], hosts_not_allowlisted: [] } },
  hold: { status: 200, body: { success: true, held: true } },
  release: { status: 200, body: { success: true, held: false, held_uploads: 'pending_approval' } },
  acknowledge: { status: 200, body: { success: true, status: 'acknowledged' } },
  injection: { status: 200, body: {} },
};

const SECURITY_EVENTS_SKELETON = (() => {
  const start = indexHtml.indexOf('<section id="rag-administration-security-events"');
  if (start < 0) {
    return `<section id="rag-administration-security-events" class="card bg-base-200 shadow-md min-w-0 scroll-mt-4" aria-labelledby="rag-security-events-title">
<div class="card-body">
<h3 id="rag-security-events-title" class="text-lg font-semibold mb-2" tabindex="-1" data-security-events-title>Security events</h3>
<p data-security-events-description></p>
<div data-security-events-alert></div>
<div data-security-events-content></div>
<div data-security-events-status role="status" aria-live="polite" tabindex="-1"></div>
</div>
</section>`;
  }
  const end = indexHtml.indexOf('</section>', start);
  return indexHtml.slice(start, end + '</section>'.length);
})();

interface HarnessOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | ((call: RagCall) => Reply)>>;
  activeTab?: boolean;
}

function loadPage(options: HarnessOptions = {}) {
  const doc = new FakeDocument();
  const ragCalls: RagCall[] = [];
  const clicked: string[] = [];

  for (const tab of ['rag-administration', 'rag-modes']) {
    const link = doc.createElement('a');
    link.className = 'menu-item';
    link.setAttribute('data-tab', tab);
    link.addEventListener('click', () => {
      clicked.push(tab);
      for (const pane of doc.querySelectorAll('.tab-content')) pane.classList.toggle('active', pane.id === tab);
    });
    doc.body.appendChild(link);
  }
  const banner = doc.createElement('div');
  banner.id = 'rag-security-alert-banner';
  doc.body.appendChild(banner);

  const modes = doc.createElement('div');
  modes.id = 'rag-modes';
  modes.className = 'tab-content';
  doc.body.appendChild(modes);
  for (const id of ['RAG_SECURITY_EVENTS', 'RAG_UPLOADER_ALERT_THRESHOLD', 'RAG_UPLOADER_HOLD']) {
    const control = doc.createElement('input');
    control.id = id;
    modes.appendChild(control);
  }

  const admin = doc.createElement('div');
  admin.id = 'rag-administration';
  admin.className = 'tab-content' + (options.activeTab ? ' active' : '');
  doc.body.appendChild(admin);
  const holder = doc.createElement('div');
  admin.appendChild(holder);
  holder.innerHTML = SECURITY_EVENTS_SKELETON;
  doc.innerHtmlWrites = 0;

  const replyFor = (call: RagCall): Reply => {
    const custom = options.replies?.[call.route as Route];
    if (typeof custom === 'function') return custom(call);
    return custom ?? DEFAULT_REPLIES[call.route as Route];
  };

  const ragFetch = async (rawPath: string, init: Json = {}) => {
    const apiPath = rawPath.startsWith('/') ? rawPath : `/api/rag/${rawPath}`;
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as Json) : null;
    const route = routeOf(apiPath, method);
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const call: RagCall = { route, path: apiPath, method, query, body };
    ragCalls.push(call);
    if (route === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const reply = replyFor(call);
    if (reply.throws) throw new TypeError('Failed to fetch');
    const answer = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: answer };
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
    URL,
    Intl,
    Date,
    ragFetch,
    fetch: async () => {
      throw new TypeError('the panel must not call fetch directly');
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/security-events.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-security-events') as FakeElement;
  return {
    doc,
    context,
    root,
    ragCalls,
    clicked,
    calls(route: Route) {
      return ragCalls.filter((c) => c.route === route);
    },
    async init() {
      const init = context.initSecurityEventsPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initSecurityEventsPanel is not defined');
      await init();
      await flush();
    },
    async domReady() {
      doc.dispatch('DOMContentLoaded');
      await flush();
    },
    banner(): FakeElement {
      return doc.getElementById('rag-security-alert-banner') as FakeElement;
    },
    tab(name: 'alerts' | 'uploaders' | 'events' | 'previews'): FakeElement {
      const el = doc.getElementById(`rag-security-events-tab-${name}`);
      if (!el) throw new Error('no tab ' + name);
      return el;
    },
    view(name: 'alerts' | 'uploaders' | 'events' | 'previews'): FakeElement {
      const el = root.querySelector(`[data-security-view="${name}"]`);
      if (!el) throw new Error('no view ' + name);
      return el;
    },
    dialog(): FakeElement | null {
      return doc.querySelectorAll('dialog').find((d) => d.open) ?? null;
    },
    status(): string {
      return (root.querySelector('[data-security-events-status]') as FakeElement).textContent;
    },
  };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function selectTab(page: ReturnType<typeof loadPage>, name: 'alerts' | 'uploaders' | 'events' | 'previews') {
  page.tab(name).click();
  await flush();
}

function links(root: FakeElement): FakeElement[] {
  return [root, ...root.querySelectorAll('*')].filter((el) => el.tagName === 'a' || el.hasAttribute('href') || el.hasAttribute('src'));
}

describe('Security events panel: Alerts (UI-SPEC 6.13.2, D-45 to D-47)', () => {
  it('shows one article per open alert with the hold line, the meta row and the three actions', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1), alertItem(2)]) } } });
    await page.init();
    expect(page.tab('alerts').textContent).toBe('Alerts: 2');
    const articles = page.root.querySelectorAll('article[data-security-alert]');
    expect(articles).toHaveLength(2);
    const first = articles[0]!;
    expect(first.querySelector('h4')!.textContent).toBe('Uploader 1');
    const hold = first.querySelector('[data-security-hold-line]')!;
    expect(hold.getAttribute('data-security-hold-line')).toBe('open');
    expect(hold.textContent).toContain('Open alert');
    expect(hold.textContent).toContain('Documents from this uploader keep triggering security checks.');
    const meta = first.querySelector('[data-security-alert-meta]')!.textContent;
    expect(meta).toContain('Events: 7');
    expect(meta).toContain('Window: 24 h');
    expect(meta).toContain('Alert level: 5');
    expect(meta).toContain('Opened:');
    expect(meta).not.toContain('Workspace:');
    expect(first.querySelector('[data-security-hold]')!.getAttribute('aria-label')).toBe('Hold uploads: Uploader 1');
    expect(first.querySelector('[data-security-ack]')!.textContent).toBe('Acknowledge alert');
    expect(first.querySelector('[data-security-show-events]')!.textContent).toBe('Show events');
    expect(page.calls('alerts')).toHaveLength(1);
  });

  it('shows the e-mail line only when the route returned one, and the workspace only with several workspaces', async () => {
    const page = loadPage({
      replies: {
        alerts: {
          status: 200,
          body: alertsAnswer([alertItem(1, { uploader_email: 'uploader-a@example.test' }), alertItem(2, { tenant_key: TENANT_B, workspace_name: 'Workspace 2' })]),
        },
      },
    });
    await page.init();
    const [a, b] = page.root.querySelectorAll('article[data-security-alert]');
    expect(a!.querySelector('h4')!.textContent).toBe('Uploader 1uploader-a@example.test');
    expect(b!.querySelector('h4')!.textContent).toBe('Uploader 2');
    expect(b!.querySelector('[data-security-alert-meta]')!.textContent).toContain('Workspace: Workspace 2');
    expect(links(page.root)).toEqual([]);
  });

  it('shows a held alert with Release hold, and acknowledged alerts in a details table', async () => {
    const page = loadPage({
      replies: {
        alerts: {
          status: 200,
          body: alertsAnswer([alertItem(1, { held: true }), alertItem(2, { status: 'acknowledged', held: true }), alertItem(3, { status: 'acknowledged' })]),
        },
      },
    });
    await page.init();
    const articles = page.root.querySelectorAll('article[data-security-alert]');
    expect(articles).toHaveLength(1);
    expect(articles[0]!.querySelector('[data-security-hold-line]')!.textContent).toContain('Uploads held');
    expect(articles[0]!.querySelector('[data-security-hold-line]')!.textContent).toContain('New uploads from this uploader wait for approval.');
    expect(articles[0]!.querySelector('[data-security-release]')).not.toBeNull();
    expect(articles[0]!.querySelector('[data-security-hold]')).toBeNull();
    const details = page.root.querySelector('details[data-security-acknowledged]')!;
    expect(details.querySelector('summary')!.textContent).toBe('Acknowledged alerts: 2');
    const rows = details.querySelectorAll('tr[data-security-acknowledged-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Uploads held');
    expect(rows[1]!.textContent).toContain('Allowed');
  });

  it('replaces Hold uploads with the hold.off line and a link to the setting when hold mode is off', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1)], { hold_mode: 'off' }) } } });
    await page.init();
    const article = page.root.querySelector('article[data-security-alert]')!;
    expect(article.querySelector('[data-security-hold]')).toBeNull();
    const off = article.querySelector('[data-security-hold-off]')!;
    expect(off.textContent).toContain('Holding uploads is switched off.');
    off.querySelector('[data-security-open-setting]')!.click();
    expect(page.clicked).toContain('rag-modes');
    expect(page.doc.activeElement?.id).toBe('RAG_UPLOADER_HOLD');
  });

  it('shows the empty state, or alerts.levelZero with a link when the alert level is 0', async () => {
    const empty = loadPage();
    await empty.init();
    expect(empty.view('alerts').textContent).toContain('No open alerts');
    expect(empty.view('alerts').textContent).toContain('An alert opens when documents from one uploader');
    const zero = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([], { alert_level: 0 }) } } });
    await zero.init();
    expect(zero.view('alerts').textContent).toContain('Alerts are off: the alert level is 0.');
    expect(zero.view('alerts').querySelector('[data-security-open-setting="RAG_UPLOADER_ALERT_THRESHOLD"]')).not.toBeNull();
  });

  it('Acknowledge alert acts at once, reloads the list and the banner disappears without a reload', async () => {
    let acknowledged = false;
    const page = loadPage({
      replies: {
        alerts: () => ({ status: 200, body: alertsAnswer(acknowledged ? [alertItem(1, { status: 'acknowledged' })] : [alertItem(1)]) }),
        acknowledge: () => {
          acknowledged = true;
          return { status: 200, body: { success: true } };
        },
      },
    });
    await page.init();
    expect(page.banner().textContent).toContain('Security alerts: 1 open');
    page.root.querySelector('[data-security-ack]')!.click();
    await flush();
    expect(page.calls('acknowledge')).toHaveLength(1);
    expect(page.calls('acknowledge')[0]!.path).toBe(`${BASE}/alerts/${uuid('a1', 1)}/acknowledge`);
    expect(page.calls('alerts')).toHaveLength(2);
    expect(page.root.querySelectorAll('article[data-security-alert]')).toHaveLength(0);
    expect(page.banner().textContent).toBe('');
    expect(page.status()).toBe('Alert acknowledged.');
  });

  it('maps 409 already_acknowledged and 404 to error.changed with a reload', async () => {
    for (const reply of [
      { status: 409, body: { success: false, error: 'already_acknowledged' } },
      { status: 404, body: { success: false, error: 'not_found' } },
    ]) {
      const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1)]) }, acknowledge: reply } });
      await page.init();
      page.root.querySelector('[data-security-ack]')!.click();
      await flush();
      expect(page.status()).toContain('This item was changed by someone else.');
      expect(page.calls('alerts')).toHaveLength(2);
    }
  });

  it('Release hold acts at once, posts the tenant and says held uploads still wait', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1, { held: true })]) } } });
    await page.init();
    page.root.querySelector('[data-security-release]')!.click();
    await flush();
    expect(page.dialog()).toBeNull();
    const call = page.calls('release')[0]!;
    expect(call.path).toBe(`${BASE}/uploaders/${uuid('b1', 1)}/release`);
    expect(call.body).toEqual({ tenantKey: TENANT_A });
    expect(page.status()).toBe('Hold released for Uploader 1. Uploads already held still wait in Upload approvals.');
    expect(page.calls('alerts')).toHaveLength(2);
  });

  it('a thrown release shows error.outcomeUnknown and reloads', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1, { held: true })]) }, release: { status: 0, throws: true } } });
    await page.init();
    page.root.querySelector('[data-security-release]')!.click();
    await flush();
    expect(page.status()).toContain('The request did not finish.');
    expect(page.calls('alerts')).toHaveLength(2);
  });
});

describe('Security events panel: the hold dialog (UI-SPEC 6.13.2, 7.2, 8.2)', () => {
  async function openHold(replies: HarnessOptions['replies'] = {}) {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1)]) }, ...replies } });
    await page.init();
    const button = page.root.querySelector('[data-security-hold]')!;
    button.click();
    await flush();
    return { page, button };
  }

  it('opens with focus on Keep uploads allowed, an optional reason of at most 200 characters, and the uploader as text', async () => {
    const { page } = await openHold();
    const dialog = page.dialog()!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('h3')!.textContent).toBe('Hold uploads from Uploader 1?');
    expect(page.doc.activeElement!.textContent).toBe('Keep uploads allowed');
    const input = dialog.querySelector('input[data-security-hold-reason]')!;
    expect(input.getAttribute('maxlength')).toBe('200');
    const label = dialog.querySelector('label')!;
    expect(label.getAttribute('for')).toBe(input.id);
    expect(label.textContent).toBe('Reason (optional)');
    expect(dialog.querySelector('.btn-primary')!.textContent).toBe('Hold uploads');
  });

  it('Keep uploads allowed posts nothing and returns focus to the opener', async () => {
    const { page, button } = await openHold();
    page.dialog()!.querySelectorAll('button').find((b) => b.textContent === 'Keep uploads allowed')!.click();
    await flush();
    expect(page.calls('hold')).toHaveLength(0);
    expect(page.dialog()).toBeNull();
    expect(page.doc.activeElement).toBe(button);
  });

  it('confirming posts the tenant and the reason, reloads and announces hold.done', async () => {
    const { page } = await openHold();
    const dialog = page.dialog()!;
    const input = dialog.querySelector('input[data-security-hold-reason]')!;
    input.value = '  repeated findings  ';
    dialog.querySelector('.btn-primary')!.click();
    await flush();
    const call = page.calls('hold')[0]!;
    expect(call.path).toBe(`${BASE}/uploaders/${uuid('b1', 1)}/hold`);
    expect(call.body).toEqual({ tenantKey: TENANT_A, reason: 'repeated findings' });
    expect(page.dialog()).toBeNull();
    expect(page.status()).toBe('Uploads from Uploader 1 are held.');
    expect(page.calls('alerts')).toHaveLength(2);
  });

  it('an empty reason is sent as null', async () => {
    const { page } = await openHold();
    page.dialog()!.querySelector('.btn-primary')!.click();
    await flush();
    expect(page.calls('hold')[0]!.body).toEqual({ tenantKey: TENANT_A, reason: null });
  });

  it('409 hold_disabled shows hold.off and reloads', async () => {
    const { page } = await openHold({ hold: { status: 409, body: { success: false, error: 'hold_disabled' } } });
    page.dialog()!.querySelector('.btn-primary')!.click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.status()).toContain('Holding uploads is switched off.');
    expect(page.calls('alerts')).toHaveLength(2);
  });

  it('409 already_held shows error.changed and reloads', async () => {
    const { page } = await openHold({ hold: { status: 409, body: { success: false, error: 'already_held' } } });
    page.dialog()!.querySelector('.btn-primary')!.click();
    await flush();
    expect(page.status()).toContain('This item was changed by someone else.');
    expect(page.calls('alerts')).toHaveLength(2);
  });

  it('a thrown request shows error.outcomeUnknown, then reloads', async () => {
    const { page } = await openHold({ hold: { status: 0, throws: true } });
    page.dialog()!.querySelector('.btn-primary')!.click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.status()).toContain('The request did not finish.');
    expect(page.calls('alerts')).toHaveLength(2);
  });

  it('a failed hold keeps the dialog open with error.holdFailed as an alert and focus on it', async () => {
    const { page } = await openHold({ hold: { status: 503, body: { success: false, error: 'Security administration is unavailable' } } });
    page.dialog()!.querySelector('.btn-primary')!.click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog).not.toBeNull();
    const error = dialog.querySelector('[data-rag-dialog-error]')!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe('The hold was not saved. Select Hold uploads again.');
    expect(page.doc.activeElement).toBe(error);
    expect(page.calls('alerts')).toHaveLength(1);
  });

  it('a 400 with details marks the reason field invalid and keeps the dialog open', async () => {
    const { page } = await openHold({ hold: { status: 400, body: { success: false, error: 'Invalid request data', details: [{ path: 'reason', message: 'too long' }] } } });
    page.dialog()!.querySelector('.btn-primary')!.click();
    await flush();
    const dialog = page.dialog()!;
    const input = dialog.querySelector('input[data-security-hold-reason]')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(dialog.querySelector('[data-rag-dialog-error]')!.textContent).toContain('too long');
    expect(page.doc.activeElement).toBe(input);
  });
});

describe('Security events panel: Uploaders, Events and Link previews', () => {
  it('Uploaders lists counts, last event, uploads state and the one row action', async () => {
    const page = loadPage({
      replies: {
        uploaders: {
          status: 200,
          body: uploadersAnswer([uploaderItem(7, { held: true, held_since: '2026-11-19T08:00:00.000Z' }), uploaderItem(2)]),
        },
      },
    });
    await page.init();
    await selectTab(page, 'uploaders');
    const rows = page.view('uploaders').querySelectorAll('tr[data-security-uploader-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Uploads held');
    expect(rows[0]!.textContent).toContain('Held since Nov 19, 2026');
    expect(rows[0]!.querySelector('[data-security-release]')).not.toBeNull();
    expect(rows[0]!.querySelector('[data-security-hold]')).toBeNull();
    expect(rows[1]!.textContent).toContain('Allowed');
    expect(rows[1]!.querySelector('[data-security-hold]')!.getAttribute('aria-label')).toBe('Hold uploads: Uploader 2');
    expect(page.view('uploaders').querySelectorAll('th').map((th) => th.textContent)).not.toContain('Workspace');
  });

  it('an uploader without a display name shows the id in monospace; empty list shows uploaders.empty', async () => {
    const page = loadPage({ replies: { uploaders: { status: 200, body: uploadersAnswer([uploaderItem(3, { display_name: null })]) } } });
    await page.init();
    await selectTab(page, 'uploaders');
    const code = page.view('uploaders').querySelector('tr[data-security-uploader-row] code')!;
    expect(code.textContent).toBe(uuid('b1', 3));
    const empty = loadPage();
    await empty.init();
    await selectTab(empty, 'uploaders');
    expect(empty.view('uploaders').textContent).toContain('No uploaders with events.');
  });

  it('pages uploaders with Load more and focuses the first new row', async () => {
    const first = Array.from({ length: 50 }, (_, i) => uploaderItem(i + 1));
    const second = Array.from({ length: 3 }, (_, i) => uploaderItem(i + 51));
    const page = loadPage({
      replies: {
        uploaders: (call) =>
          call.query.get('cursor') === '50'
            ? { status: 200, body: uploadersAnswer(second) }
            : { status: 200, body: uploadersAnswer(first, { next_cursor: '50' }) },
      },
    });
    await page.init();
    await selectTab(page, 'uploaders');
    expect(page.view('uploaders').querySelectorAll('tr[data-security-uploader-row]')).toHaveLength(50);
    page.view('uploaders').querySelector('[data-security-more="uploaders"]')!.click();
    await flush();
    expect(page.view('uploaders').querySelectorAll('tr[data-security-uploader-row]')).toHaveLength(53);
    expect(page.view('uploaders').querySelector('[data-security-more]')).toBeNull();
    expect(page.doc.activeElement!.getAttribute('aria-label')).toBe('Hold uploads: Uploader 51');
  });

  it('Events shows time, check badge, result word, document, uploader and rule ids', async () => {
    const page = loadPage({
      replies: {
        events: {
          status: 200,
          body: eventsAnswer([
            eventItem(1),
            eventItem(2, { source: 'ingest_injection', action: 'quarantined', document_id: uuid('d1', 2), file_name: null }),
            eventItem(3, { document_id: null, file_name: null, uploader_id: null, uploader_name: null, rule_ids: [] }),
            eventItem(4, { source: 'future_check', action: 'future_action' }),
          ]),
        },
      },
    });
    await page.init();
    await selectTab(page, 'events');
    const rows = page.view('events').querySelectorAll('tr[data-security-event-row]');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.querySelector('.badge')!.textContent).toBe('Answer guard');
    expect(rows[0]!.querySelector('.badge i')!.className).toContain('bi-shield-lock');
    expect(rows[0]!.textContent).toContain('Link removed');
    expect(rows[0]!.textContent).toContain('document-1.pdf');
    expect(rows[0]!.textContent).toContain('Uploader 1');
    expect(rows[0]!.textContent).toContain('rule-1, rule-2');
    expect(rows[0]!.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-21T10:00:00.000Z');
    expect(rows[1]!.textContent).toContain('Upload: instruction rule');
    expect(rows[1]!.textContent).toContain('Quarantined');
    expect(rows[1]!.textContent).toContain('Document removed');
    expect(rows[2]!.textContent).toContain('No source document');
    expect(rows[2]!.textContent).toContain('Unknown uploader');
    expect(rows[3]!.textContent).toContain('Unrecognized value: future_check');
    expect(rows[3]!.querySelector('code')!.textContent).toBe('future_check');
    expect(links(page.root)).toEqual([]);
  });

  it('Events filters by check and period and pages with Load more', async () => {
    const page = loadPage({
      replies: {
        events: (call) =>
          call.query.get('cursor') === '50'
            ? { status: 200, body: eventsAnswer([eventItem(51)]) }
            : { status: 200, body: eventsAnswer(Array.from({ length: 50 }, (_, i) => eventItem(i + 1)), { next_cursor: '50' }) },
      },
    });
    await page.init();
    await selectTab(page, 'events');
    const firstQuery = page.calls('events')[0]!.query;
    expect(firstQuery.get('source')).toBeNull();
    const since = Date.parse(firstQuery.get('since')!);
    expect(Math.abs(Date.now() - since - 24 * 3600 * 1000)).toBeLessThan(60_000);
    const check = page.doc.getElementById('rag-security-events-filter-check')!;
    check.value = 'hidden_text';
    check.dispatch('change');
    await flush();
    expect(page.calls('events').at(-1)!.query.get('source')).toBe('hidden_text');
    const period = page.doc.getElementById('rag-security-events-filter-period')!;
    period.value = 'week';
    period.dispatch('change');
    await flush();
    const weekSince = Date.parse(page.calls('events').at(-1)!.query.get('since')!);
    expect(Math.abs(Date.now() - weekSince - 7 * 24 * 3600 * 1000)).toBeLessThan(60_000);
    expect(page.calls('events').at(-1)!.query.get('source')).toBe('hidden_text');
    page.view('events').querySelector('[data-security-more="events"]')!.click();
    await flush();
    expect(page.calls('events').at(-1)!.query.get('cursor')).toBe('50');
    expect(page.view('events').querySelectorAll('tr[data-security-event-row]')).toHaveLength(51);
  });

  it('Show events switches to Events filtered to that uploader', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(4)]) } } });
    await page.init();
    page.root.querySelector('[data-security-show-events]')!.click();
    await flush();
    expect(page.tab('events').getAttribute('aria-selected')).toBe('true');
    expect(page.calls('events').at(-1)!.query.get('uploader')).toBe(uuid('b1', 4));
    expect(page.view('events').querySelector('[data-security-uploader-filter]')!.textContent).toContain('Uploaded by: Uploader 4');
    page.view('events').querySelector('[data-security-clear-uploader]')!.click();
    await flush();
    expect(page.calls('events').at(-1)!.query.get('uploader')).toBeNull();
  });

  it('shows the events empty state', async () => {
    const page = loadPage();
    await page.init();
    await selectTab(page, 'events');
    expect(page.view('events').textContent).toContain('No security events');
  });

  it('reloads a list on tab activation; nothing polls', async () => {
    const page = loadPage();
    await page.init();
    await selectTab(page, 'uploaders');
    await selectTab(page, 'alerts');
    await selectTab(page, 'uploaders');
    expect(page.calls('uploaders')).toHaveLength(2);
    expect(page.calls('alerts')).toHaveLength(2);
    expect(panelSource).not.toMatch(/setInterval/);
  });

  it('Link previews renders the four states with host names in code elements, never links', async () => {
    const cases: Array<[string, Json, string]> = [
      ['unknown', { state: 'unknown' }, 'The preview hosts could not be read'],
      ['none', { state: 'none' }, 'The WhatsApp service fetches no link previews.'],
      ['subset', { state: 'subset', preview_hosts: ['host.example'] }, 'Every preview host is on the answer link allowlist.'],
      ['mismatch', { state: 'mismatch', preview_hosts: ['host.example', 'other.example'], hosts_not_allowlisted: ['other.example'] }, 'These preview hosts are not on'],
    ];
    for (const [state, body, sentence] of cases) {
      const page = loadPage({ replies: { previews: { status: 200, body: { success: true, preview_hosts: [], hosts_not_allowlisted: [], ...body } } } });
      await page.init();
      await selectTab(page, 'previews');
      const view = page.view('previews');
      expect(view.querySelector('[data-security-previews-state]')!.getAttribute('data-security-previews-state')).toBe(state);
      expect(view.textContent).toContain(sentence);
      expect(view.textContent).toContain('While the answer guard is on, replies are sent with link previews off.');
      if (state === 'subset') expect(view.querySelectorAll('[data-security-preview-hosts] code').map((c) => c.textContent)).toEqual(['host.example']);
      if (state === 'mismatch') {
        expect(view.querySelector('.alert-warning')).not.toBeNull();
        expect(view.querySelectorAll('[data-security-preview-hosts] code').map((c) => c.textContent)).toEqual(['other.example']);
        expect(view.querySelectorAll('code').map((c) => c.textContent)).toContain('WHATSAPP_LINK_PREVIEW_HOSTS');
      }
      expect(links(page.root)).toEqual([]);
    }
  });
});

describe('Security events panel: events off, unavailable and sign-in states', () => {
  it('with RAG_SECURITY_EVENTS off the three data views show events.off with a link to the setting', async () => {
    const page = loadPage({
      replies: {
        alerts: { status: 200, body: alertsAnswer([alertItem(1)], { events_recorded: false }) },
        uploaders: { status: 200, body: uploadersAnswer([uploaderItem(1)], { events_recorded: false }) },
        events: { status: 200, body: eventsAnswer([eventItem(1)], { events_recorded: false }) },
      },
    });
    await page.init();
    for (const view of ['alerts', 'uploaders', 'events'] as const) {
      if (view !== 'alerts') await selectTab(page, view);
      const host = page.view(view);
      expect(host.textContent).toContain('Security events are not recorded.');
      expect(host.querySelector('[data-security-open-setting="RAG_SECURITY_EVENTS"]')).not.toBeNull();
      expect(host.querySelector('table')).toBeNull();
      expect(host.querySelector('article')).toBeNull();
    }
    expect(page.banner().textContent).toBe('');
  });

  it('a 404 shows events.unavailableOff as an info alert and no banner', async () => {
    const page = loadPage({ replies: { alerts: { status: 404, body: { success: false, error: 'Not found' } } } });
    await page.init();
    const alert = page.root.querySelector('[data-security-events-alert] .alert-info')!;
    expect(alert.textContent).toContain('Security events are not available on this deployment yet.');
    expect(page.banner().textContent).toBe('');
  });

  it('401 shows the sign-in alert; 503 and network failures show the unavailable alert with Reload panel', async () => {
    const signIn = loadPage({ replies: { alerts: { status: 401, body: { success: false, error: 'Admin authentication required' } } } });
    await signIn.init();
    expect(signIn.view('alerts').querySelector('.alert')).not.toBeNull();
    expect(signIn.view('alerts').textContent).toContain('Reload panel');
    for (const reply of [{ status: 503, body: { success: false } }, { status: 0, throws: true }]) {
      const page = loadPage({ replies: { alerts: reply as Reply } });
      await page.init();
      const alert = page.root.querySelector('[data-security-events-alert] .alert-error')!;
      expect(alert.textContent).toContain('Security events are unavailable right now. Select Reload panel in a moment.');
      alert.querySelector('button')!.click();
      await flush();
      expect(page.calls('alerts')).toHaveLength(2);
    }
  });

  it('calls only the security-events routes and never fetch directly', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1)]) } } });
    await page.init();
    for (const view of ['uploaders', 'events', 'previews'] as const) await selectTab(page, view);
    expect(page.ragCalls.every((c) => c.path.startsWith(BASE))).toBe(true);
    expect(page.ragCalls.filter((c) => /chunks|text|snippet|answer/.test(c.path))).toEqual([]);
  });
});

describe('Security events panel: untrusted values stay text (D-57, UI-SPEC 11)', () => {
  it('markup and javascript: in names, e-mails, file names, hosts, workspaces and rule ids create no element and no link', async () => {
    const page = loadPage({
      replies: {
        alerts: {
          status: 200,
          body: alertsAnswer([alertItem(1, { uploader_name: XSS_PAYLOAD, uploader_email: 'javascript:alert(1)', workspace_name: XSS_PAYLOAD, tenant_key: TENANT_B }), alertItem(2)]),
        },
        uploaders: { status: 200, body: uploadersAnswer([uploaderItem(1, { display_name: XSS_PAYLOAD, email: 'javascript:alert(1)' })]) },
        events: { status: 200, body: eventsAnswer([eventItem(1, { file_name: XSS_PAYLOAD, uploader_name: XSS_PAYLOAD, rule_ids: [XSS_PAYLOAD, 'javascript:alert(1)'] })]) },
        previews: { status: 200, body: { success: true, state: 'mismatch', preview_hosts: [XSS_PAYLOAD], hosts_not_allowlisted: [XSS_PAYLOAD, 'javascript:alert(1)'] } },
      },
    });
    await page.init();
    for (const view of ['uploaders', 'events', 'previews'] as const) await selectTab(page, view);
    await selectTab(page, 'alerts');
    page.root.querySelector('[data-security-hold]')!.click();
    await flush();
    expect(page.dialog()!.querySelector('h3')!.textContent).toBe(`Hold uploads from ${XSS_PAYLOAD}?`);
    expect(injectedElements(page.doc)).toEqual([]);
    expect(links(page.root)).toEqual([]);
    expect(links(page.dialog()!)).toEqual([]);
    expect(links(page.banner())).toEqual([]);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.root.textContent).toContain(XSS_PAYLOAD);
  });

  it('hides responsive columns with max-* variants: the page rule .hidden { display: none !important } would beat md:table-cell', () => {
    expect(indexHtml).toMatch(/\.hidden\s*\{\s*display:\s*none\s*!important;/);
    expect(panelSource).not.toMatch(/['" ]hidden (?:sm|md|lg|xl):/);
    expect(panelSource).toContain('max-md:hidden');
    expect(panelSource).toContain('max-lg:hidden');
  });

  it('alert paragraphs keep the alert colour against the page rule [data-theme="dark"] .card-body p', async () => {
    expect(indexHtml).toMatch(/\[data-theme="dark"\] \.card-body p \{/);
    const page = loadPage({
      replies: {
        alerts: { status: 200, body: alertsAnswer([], { events_recorded: false }) },
        previews: { status: 200, body: { success: true, state: 'mismatch', preview_hosts: ['host.example'], hosts_not_allowlisted: ['host.example'] } },
      },
    });
    await page.init();
    await selectTab(page, 'previews');
    const paragraphs = [...page.view('alerts').querySelectorAll('.alert p'), ...page.view('previews').querySelectorAll('.alert p')];
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    for (const p of paragraphs) expect(p.className).toContain('!text-current');
  });

  it('filter selects carry a name', async () => {
    const page = loadPage();
    await page.init();
    await selectTab(page, 'events');
    for (const id of ['rag-security-events-filter-check', 'rag-security-events-filter-period']) expect(page.doc.getElementById(id)!.getAttribute('name')).toBe(id);
  });

  it('the panel source never parses markup or builds links', () => {
    expect(panelSource).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
    expect(panelSource).not.toMatch(/mailto:|\.href\s*=|'href'|"href"/);
  });
});

describe('Page banner (UI-SPEC 6.13.1, D-45)', () => {
  it('renders "Security alerts: 2 open" with Review alerts on DOMContentLoaded, without an alert role', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1), alertItem(2)]) } } });
    await page.domReady();
    const banner = page.banner().querySelector('[data-security-banner]')!;
    expect(banner.className).toContain('alert-warning');
    expect(banner.getAttribute('role')).toBeNull();
    expect(banner.textContent).toContain('Security alerts: 2 open');
    expect(banner.textContent).toContain('Documents from one or more uploaders passed the alert level for security events.');
    expect(banner.querySelector('button')!.textContent).toBe('Review alerts');
    expect(banner.querySelector('button')!.className).not.toContain('btn-primary');
    expect(banner.querySelector('.bi-shield-exclamation')).not.toBeNull();
  });

  it('Review alerts activates RAG administration, selects Alerts and focuses the panel heading', async () => {
    const page = loadPage({ replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1), alertItem(2)]) } } });
    await page.domReady();
    page.banner().querySelector('[data-security-banner-review]')!.click();
    await flush();
    expect(page.clicked).toContain('rag-administration');
    expect(page.tab('alerts').getAttribute('aria-selected')).toBe('true');
    expect(page.doc.activeElement!.id).toBe('rag-security-events-title');
  });

  it('is not rendered on 401, 403, 404, failure, events off or no open alert', async () => {
    const replies: Reply[] = [
      { status: 401, body: {} },
      { status: 403, body: {} },
      { status: 404, body: {} },
      { status: 503, body: {} },
      { status: 0, throws: true },
      { status: 200, body: alertsAnswer([alertItem(1)], { events_recorded: false }) },
      { status: 200, body: alertsAnswer([alertItem(1, { status: 'acknowledged' })]) },
    ];
    for (const reply of replies) {
      const page = loadPage({ replies: { alerts: reply } });
      await page.domReady();
      expect(page.banner().textContent).toBe('');
    }
  });

  it('shows the banner in zh and it', async () => {
    for (const [locale, text] of [
      ['zh-CN', '安全提醒：1 条未处理'],
      ['it-IT', 'Avvisi di sicurezza: 1 aperti'],
    ]) {
      const page = loadPage({ locale, replies: { alerts: { status: 200, body: alertsAnswer([alertItem(1)]) } } });
      await page.domReady();
      expect(page.banner().textContent).toContain(text);
    }
  });
});

describe('Labels and mount', () => {
  it('has every key in en, zh and it', async () => {
    const page = loadPage();
    const labels = page.context.SECURITY_EVENTS_LABELS as Record<string, Record<string, string>>;
    const keys = Object.keys(labels.en!).sort();
    expect(Object.keys(labels.zh!).sort()).toEqual(keys);
    expect(Object.keys(labels.it!).sort()).toEqual(keys);
  });

  it('mounts once and reloads the visible view on later calls', async () => {
    const page = loadPage();
    await page.init();
    await page.init();
    expect(page.root.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(page.calls('alerts')).toHaveLength(2);
  });

  it('applies the locale to the panel root, heading and tabs', async () => {
    const page = loadPage({ locale: 'it-IT' });
    await page.init();
    expect(page.root.getAttribute('lang')).toBe('it');
    expect(page.root.querySelector('h3')!.textContent).toBe('Eventi di sicurezza');
    expect(page.tab('uploaders').textContent).toBe('Autori');
  });
});

describe('index.html wiring (UI-SPEC 6.11, 6.13.1)', () => {
  it('has the banner host directly after the language banner, above every tab', () => {
    expect(indexHtml.match(/id="rag-security-alert-banner"/g)).toHaveLength(1);
    const language = indexHtml.indexOf('<div id="rag-language-banner"></div>');
    const banner = indexHtml.indexOf('<div id="rag-security-alert-banner"></div>');
    expect(banner).toBeGreaterThan(language);
    expect(indexHtml.slice(language, banner)).toMatch(/^<div id="rag-language-banner"><\/div>\s*$/);
    expect(banner).toBeLessThan(indexHtml.indexOf('class="tab-content"'));
  });

  it('mounts the panel section after Upload approvals in RAG administration', () => {
    const section = indexHtml.indexOf('<section id="rag-administration-security-events"');
    expect(section).toBeGreaterThan(indexHtml.indexOf('<!-- rag-upload-approvals:end -->'));
    expect(section).toBeLessThan(indexHtml.indexOf('<section id="rag-administration-scopes"'));
    expect(section).toBeGreaterThan(indexHtml.indexOf('<div class="tab-content" id="rag-administration">'));
    for (const hook of ['data-security-events-content', 'data-security-events-alert', 'data-security-events-status', 'id="rag-security-events-title"']) {
      expect(SECURITY_EVENTS_SKELETON).toContain(hook);
    }
    expect(SECURITY_EVENTS_SKELETON).toMatch(/<h3 id="rag-security-events-title"[^>]*tabindex="-1"/);
  });

  it('loads the script once, after rag-ui.js and answer-rules.js', () => {
    expect(indexHtml.match(/rag-panels\/security-events\.js/g)).toHaveLength(1);
    const script = indexHtml.indexOf('<script src="rag-panels/security-events.js"></script>');
    expect(script).toBeGreaterThan(indexHtml.indexOf('<script src="rag-panels/rag-ui.js"></script>'));
    expect(script).toBe(indexHtml.indexOf('<script src="rag-panels/answer-rules.js"></script>') + '<script src="rag-panels/answer-rules.js"></script>\n    '.length);
  });
});

describe('Prompt-injection defense card: pointer to Security events (UI-SPEC 6.14, 12.5)', () => {
  function loadCard(locale: string, withPanel: boolean) {
    const doc = new FakeDocument();
    const opened: unknown[] = [];
    if (withPanel) {
      const section = doc.createElement('section');
      section.id = 'rag-administration-security-events';
      doc.body.appendChild(section);
    }
    const host = doc.createElement('div');
    host.id = 'injection-defense-events-pointer';
    doc.body.appendChild(host);
    const summary = doc.createElement('div');
    summary.id = 'injection-defense-summary';
    doc.body.appendChild(summary);
    const context: Json = {
      document: doc,
      console: { log() {}, error() {}, warn() {} },
      navigator: { language: locale },
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      openSecurityEvents: async (options: unknown) => {
        opened.push(options);
      },
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    new vm.Script(fs.readFileSync(path.join(configUiDir, 'rag-panels/injection-defense.js'), 'utf8')).runInContext(context);
    return { doc, host, context, opened };
  }

  it('shows the pointer line with Open security events, which opens the Events view', async () => {
    const { doc, host, opened } = loadCard('en-US', true);
    doc.dispatch('DOMContentLoaded');
    await flush();
    expect(host.textContent).toBe('Detections are listed with their uploaders in RAG administration, Security events. Open security events');
    const button = host.querySelector('[data-injection-open-events]')!;
    expect(button.className).toContain('btn-link');
    button.click();
    expect(opened).toEqual([{ tab: 'events' }]);
  });

  it('is in the browser language and absent when the panel is not on the page', async () => {
    const zh = loadCard('zh-CN', true);
    zh.doc.dispatch('DOMContentLoaded');
    expect(zh.host.textContent).toContain('检测结果及其上传者列在“RAG 管理”的“安全事件”中。');
    const none = loadCard('en-US', false);
    none.doc.dispatch('DOMContentLoaded');
    expect(none.host.textContent).toBe('');
  });

  it('index.html places the pointer host under the detector summary', () => {
    const summary = indexHtml.indexOf('id="injection-defense-summary"');
    const pointer = indexHtml.indexOf('id="injection-defense-events-pointer"');
    expect(pointer).toBeGreaterThan(summary);
    expect(pointer).toBeLessThan(indexHtml.indexOf('<!-- Answer rules and output safety -->'));
  });
});

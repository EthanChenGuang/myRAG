import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, injectedElements, XSS_PAYLOAD } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const PANEL_FILE = path.join(configUiDir, 'rag-panels/review-admin.js');

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}

interface RagCall {
  url: string;
  method: string;
  body: unknown;
}

type Route = (call: RagCall) => Reply | undefined;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_1 = '00000000-0000-4000-8000-000000000001';
const USER_2 = '00000000-0000-4000-8000-000000000002';
const NEW_USER = '00000000-0000-4000-8000-000000000003';
const PERSONAL = 'u:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HASH_A = 'aaaa1111bbbb2222';
const HASH_B = 'bbbb1111cccc2222';

function grantsBody(tenantKey: string): Json {
  return {
    grants: [
      { tenant_key: tenantKey, user_id: USER_1, email: '***@example.org', granted_by: 'admin-should-never-render', created_at: '2026-11-18T10:00:00Z' },
      { tenant_key: tenantKey, user_id: USER_2, email: '***@example.com', granted_by: null, created_at: null },
    ],
  };
}

function settingsBody(tenantKey: string, retrievalLog = 'inherit', updatedAt: string | null = null): Json {
  return { success: true, settings: { tenant_key: tenantKey, retrieval_log: retrievalLog, updated_by: 'admin-should-never-render', updated_at: updatedAt } };
}

function tenantOf(url: string): string {
  return new URL(url, 'http://config.local').searchParams.get('tenantKey') ?? '';
}

function defaultRoute(call: RagCall): Reply | undefined {
  if (call.url.startsWith('/api/rag/admin/domain-experts')) {
    if (call.method === 'GET') return { status: 200, body: grantsBody(tenantOf(call.url)) };
    if (call.method === 'POST') return { status: 201, body: { ...(call.body as Json), created: true } };
    if (call.method === 'DELETE') return { status: 204 };
  }
  if (call.url.startsWith('/api/rag/admin/feedback-loop/tenant-settings')) {
    if (call.method === 'GET') return { status: 200, body: settingsBody(tenantOf(call.url)) };
    if (call.method === 'PUT') {
      const body = call.body as Json;
      return { status: 200, body: settingsBody(String(body.tenantKey), String(body.retrievalLog), '2026-11-25T09:00:00Z') };
    }
  }
  if (call.url === '/api/rag/admin/feedback-loop/mine') {
    return {
      status: 200,
      body: {
        success: true,
        result: {
          schema_version: 1,
          status: 'completed',
          since: '2026-11-18T00:00:00.000Z',
          until: '2026-11-26T00:00:00.000Z',
          config_sha256: 'f'.repeat(64),
          purged_log_rows: 0,
          purged_review_items: 0,
          total_inserted: 6,
          tenants: [
            { tenant_hash: HASH_B, inserted: 1, tenant_key: `o:${ORG_A}`, by_reason: { zero_results: 1 } },
            { tenant_hash: HASH_A, inserted: 5, by_reason: { low_score: 2, feedback_negative: 3, groundedness_flagged: 0 } },
          ],
        },
      },
    };
  }
  if (call.url === '/api/rag/admin/feedback-loop/purge') return { status: 200, body: { success: true, retentionDays: 30, logRows: 12, reviewItems: 3 } };
  return undefined;
}

interface LoadOptions {
  route?: Route;
  locale?: string;
  mode?: 'single-tenant' | 'multi-tenant';
  workspaces?: Array<{ value: string; text: string }>;
  retentionDays?: string;
}

function loadPanel(options: LoadOptions = {}) {
  const doc = new FakeDocument();
  const calls: RagCall[] = [];
  const link = doc.createElement('a');
  link.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(link);
  const drawerLink = doc.createElement('a');
  drawerLink.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(drawerLink);

  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  for (const option of options.workspaces ?? []) {
    const el = doc.createElement('option');
    el.setAttribute('value', option.value);
    el.textContent = option.text;
    selector.appendChild(el);
  }
  doc.body.appendChild(selector);

  const retention = doc.createElement('input');
  retention.id = 'RAG_RETRIEVAL_LOG_RETENTION_DAYS';
  retention.value = options.retentionDays ?? '';
  doc.body.appendChild(retention);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content';
  doc.body.appendChild(tab);
  const section = doc.createElement('section');
  section.id = 'rag-administration-feedback-loop';
  tab.appendChild(section);
  const body = doc.createElement('div');
  body.className = 'card-body';
  section.appendChild(body);
  const title = doc.createElement('h3');
  title.id = 'rag-feedback-loop-title';
  title.setAttribute('tabindex', '-1');
  title.setAttribute('data-review-admin-title', '');
  title.textContent = 'Feedback loop';
  body.appendChild(title);
  for (const name of ['data-review-admin-description', 'data-review-admin-alert', 'data-review-admin-content']) {
    const el = doc.createElement(name === 'data-review-admin-description' ? 'p' : 'div');
    el.setAttribute(name, '');
    body.appendChild(el);
  }
  const status = doc.createElement('div');
  status.setAttribute('data-review-admin-status', '');
  status.setAttribute('role', 'status');
  body.appendChild(status);

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const call: RagCall = { url: apiPath, method: String(init.method ?? 'GET'), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const reply = (options.route && options.route(call)) ?? defaultRoute(call) ?? { status: 500, body: { error: 'unexpected' } };
    if (reply.throws) throw new TypeError('Failed to fetch');
    const copy = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    if (reply.status >= 200 && reply.status < 300) return { ok: true, status: reply.status, body: copy };
    return { ok: false, status: reply.status, body: copy, message: copy && copy.error ? copy.error : 'failed' };
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
    currentConfig: { NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: options.mode ?? 'single-tenant' },
    getSelection: () => null,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/review-labelling.js', 'rag-panels/review-admin.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const init = () => (context.initReviewAdminPanel as () => Promise<unknown>)();
  return { doc, section, calls, context, init, status, link, drawerLink, retention };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function q(root: FakeElement | FakeDocument, selector: string): FakeElement {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

function change(el: FakeElement, value?: string): void {
  if (value !== undefined) el.value = value;
  el.dispatch('change');
}

function input(el: FakeElement, value: string): void {
  el.value = value;
  el.dispatch('input');
}

const MULTI = {
  mode: 'multi-tenant' as const,
  workspaces: [
    { value: '', text: '👤 Default Workspace' },
    { value: ORG_A, text: '  💼 Workspace A' },
    { value: ORG_B, text: '  🏢 Workspace B' },
  ],
};

describe('review-admin.js: experts and logging level (D-06, D-16)', () => {
  it('loads s:default in single-tenant mode, lists masked e-mails and user ids, and shows no chooser', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    const gets = panel.calls.filter((c) => c.method === 'GET').map((c) => c.url);
    expect(gets).toContain('/api/rag/admin/domain-experts?tenantKey=s%3Adefault');
    expect(gets).toContain('/api/rag/admin/feedback-loop/tenant-settings?tenantKey=s%3Adefault');
    expect(panel.section.querySelector('select[data-review-admin-tenant]')).toBeNull();
    const text = panel.section.textContent;
    expect(text).toContain('This deployment has one knowledge base.');
    const rows = panel.section.querySelectorAll('tr[data-review-admin-expert]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('***@example.org');
    expect(rows[0]!.textContent).toContain(USER_1);
    expect(rows[1]!.textContent).toContain('No date recorded');
    expect(text).not.toContain('admin-should-never-render');
    expect(q(panel.section, 'select[data-review-admin-log]').value).toBe('inherit');
    expect(panel.section.getAttribute('lang')).toBe('en');
    expect(q(panel.section, '[data-review-admin-title]').textContent).toBe('Feedback loop');
  });

  it('offers the workspaces of #workspace-selector in multi-tenant mode, loads the first and reloads on change', async () => {
    const panel = loadPanel(MULTI);
    await panel.init();
    await flush();
    const select = q(panel.section, 'select[data-review-admin-tenant]');
    const options = select.querySelectorAll('option');
    expect(options.map((o) => o.getAttribute('value'))).toEqual([`o:${ORG_A}`, `o:${ORG_B}`, '__other__']);
    expect(options[0]!.textContent).toBe('Workspace A');
    expect(options[2]!.textContent).toBe('Enter a tenant key…');
    expect(panel.calls[0]!.url).toBe(`/api/rag/admin/domain-experts?tenantKey=o%3A${ORG_A}`);
    expect(panel.section.textContent).toContain('In multi-tenant mode nobody sees a workspace’s queue without a grant');
    const before = panel.calls.length;
    change(select, `o:${ORG_B}`);
    await flush();
    const urls = panel.calls.slice(before).map((c) => c.url);
    expect(urls).toContain(`/api/rag/admin/domain-experts?tenantKey=o%3A${ORG_B}`);
    expect(urls).toContain(`/api/rag/admin/feedback-loop/tenant-settings?tenantKey=o%3A${ORG_B}`);
  });

  it('accepts a typed tenant key only when it is o: or u: followed by a UUID', async () => {
    const panel = loadPanel(MULTI);
    await panel.init();
    await flush();
    change(q(panel.section, 'select[data-review-admin-tenant]'), '__other__');
    await flush();
    const keyInput = q(panel.section, 'input[data-review-admin-key]');
    expect(keyInput.getAttribute('autocomplete')).toBe('off');
    expect(keyInput.getAttribute('spellcheck')).toBe('false');
    const before = panel.calls.length;
    input(keyInput, 's:default');
    q(panel.section, '[data-review-admin-load]').click();
    await flush();
    expect(panel.calls.length).toBe(before);
    expect(keyInput.getAttribute('aria-invalid')).toBe('true');
    expect(panel.section.textContent).toContain('This is not a tenant key.');
    input(keyInput, PERSONAL);
    q(panel.section, '[data-review-admin-load]').click();
    await flush();
    expect(panel.calls.at(-2)!.url).toBe(`/api/rag/admin/domain-experts?tenantKey=${encodeURIComponent(PERSONAL)}`);
  });

  it('shows the tenant key field and requests nothing when the selector offers no workspace', async () => {
    const panel = loadPanel({ mode: 'multi-tenant', workspaces: [{ value: '', text: 'Loading workspaces...' }] });
    await panel.init();
    await flush();
    expect(panel.calls).toHaveLength(0);
    expect(panel.section.querySelector('input[data-review-admin-key]')).not.toBeNull();
    expect(panel.section.textContent).toContain('Enter a tenant key to see its experts and its logging level.');
  });

  it('grants by user ID: an invalid ID sends nothing, 201 announces the grant and reloads, 200 says it exists', async () => {
    let created = true;
    const panel = loadPanel({
      route: (call) => (call.method === 'POST' && call.url === '/api/rag/admin/domain-experts' ? { status: created ? 201 : 200, body: { created } } : undefined),
    });
    await panel.init();
    await flush();
    const field = q(panel.section, 'input[data-review-admin-grant-input]');
    const button = q(panel.section, '[data-review-admin-grant]');
    expect(button.className).toContain('btn-primary');
    const before = panel.calls.length;
    input(field, 'someone@example.org');
    button.click();
    await flush();
    expect(panel.calls.length).toBe(before);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(panel.section.textContent).toContain('A user ID has 36 characters');
    input(q(panel.section, 'input[data-review-admin-grant-input]'), NEW_USER.toUpperCase());
    q(panel.section, '[data-review-admin-grant]').click();
    await flush();
    const post = panel.calls.find((c) => c.method === 'POST');
    expect(post).toMatchObject({ url: '/api/rag/admin/domain-experts', body: { tenantKey: 's:default', userId: NEW_USER.toUpperCase() } });
    expect(panel.status.textContent).toContain('Access granted.');
    expect(panel.calls.at(-1)!.method).toBe('GET');
    created = false;
    input(q(panel.section, 'input[data-review-admin-grant-input]'), NEW_USER);
    q(panel.section, '[data-review-admin-grant]').click();
    await flush();
    expect(panel.status.textContent).toContain('This user already has access.');
  });

  it('shows the server detail when a grant is refused', async () => {
    const panel = loadPanel({
      route: (call) =>
        call.method === 'POST' ? { status: 400, body: { success: false, error: 'Invalid request data', details: [{ path: 'userId', message: 'Unknown user' }] } } : undefined,
    });
    await panel.init();
    await flush();
    input(q(panel.section, 'input[data-review-admin-grant-input]'), NEW_USER);
    q(panel.section, '[data-review-admin-grant]').click();
    await flush();
    expect(panel.section.textContent).toContain('The server did not accept this grant: Unknown user');
    expect(q(panel.section, 'input[data-review-admin-grant-input]').getAttribute('aria-invalid')).toBe('true');
  });

  it('revokes only after the confirmation dialog, then reloads the list', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    const revoke = q(panel.section, 'tr[data-review-admin-expert] [data-review-admin-revoke]');
    expect(revoke.getAttribute('aria-label')).toBe('Revoke access: ***@example.org');
    revoke.click();
    await flush();
    let dialog = q(panel.section, 'dialog[data-review-admin-dialog="revoke"]');
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Revoke access for ***@example.org?');
    expect(panel.doc.activeElement?.hasAttribute('data-review-admin-dialog-keep')).toBe(true);
    expect(panel.calls.some((c) => c.method === 'DELETE')).toBe(false);
    q(dialog, '[data-review-admin-dialog-keep]').click();
    await flush();
    expect(panel.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(panel.section.querySelector('dialog[data-review-admin-dialog="revoke"]')).toBeNull();
    q(panel.section, 'tr[data-review-admin-expert] [data-review-admin-revoke]').click();
    await flush();
    dialog = q(panel.section, 'dialog[data-review-admin-dialog="revoke"]');
    q(dialog, '[data-review-admin-dialog-confirm]').click();
    await flush();
    const del = panel.calls.find((c) => c.method === 'DELETE');
    expect(del).toMatchObject({ url: '/api/rag/admin/domain-experts', body: { tenantKey: 's:default', userId: USER_1 } });
    expect(panel.status.textContent).toContain('Access revoked.');
    expect(panel.calls.at(-1)!.method).toBe('GET');
  });

  it('shows the empty state when the workspace has no experts', async () => {
    const panel = loadPanel({ route: (call) => (call.method === 'GET' && call.url.startsWith('/api/rag/admin/domain-experts') ? { status: 200, body: { grants: [] } } : undefined) });
    await panel.init();
    await flush();
    expect(panel.section.textContent).toContain('No experts yet');
    expect(panel.section.querySelector('input[data-review-admin-grant-input]')).not.toBeNull();
  });

  it('saves the logging level with PUT and shows the stored row', async () => {
    const panel = loadPanel({
      route: (call) =>
        call.method === 'GET' && call.url.startsWith('/api/rag/admin/feedback-loop/tenant-settings')
          ? { status: 200, body: settingsBody('s:default', 'off', '2026-11-20T09:00:00Z') }
          : undefined,
    });
    await panel.init();
    await flush();
    const select = q(panel.section, 'select[data-review-admin-log]');
    expect(select.value).toBe('off');
    expect(panel.section.textContent).toContain('With this level, weekly mining adds no new review cases for this workspace.');
    expect(panel.section.textContent).toContain('Last changed:');
    change(select, 'ids');
    q(panel.section, '[data-review-admin-save-log]').click();
    await flush();
    const put = panel.calls.find((c) => c.method === 'PUT');
    expect(put).toMatchObject({ url: '/api/rag/admin/feedback-loop/tenant-settings', body: { tenantKey: 's:default', retrievalLog: 'ids' } });
    expect(panel.status.textContent).toContain('Logging level saved: IDs and scores only: never store the question');
    change(q(panel.section, 'select[data-review-admin-log]'), 'inherit');
    expect(panel.section.textContent).not.toContain('With this level, weekly mining adds no new review cases');
  });

  it('treats a 404 on the settings read as no stored row', async () => {
    const panel = loadPanel({ route: (call) => (call.method === 'GET' && call.url.includes('tenant-settings') ? { status: 404, body: { error: 'Not found' } } : undefined) });
    await panel.init();
    await flush();
    expect(q(panel.section, 'select[data-review-admin-log]').value).toBe('inherit');
  });

  for (const status of [401, 403]) {
    it(`shows only the sign-in alert and no data for ${status}`, async () => {
      const panel = loadPanel({
        route: (call) => (call.url.startsWith('/api/rag/admin/domain-experts') && call.method === 'GET' ? { status, body: { error: 'Unauthorized' } } : undefined),
      });
      await panel.init();
      await flush();
      const alert = q(panel.section, '[data-review-admin-alert]');
      expect(alert.textContent).toContain('Admin sign-in required');
      expect(alert.querySelector('[data-review-admin-reload]')).not.toBeNull();
      const content = q(panel.section, '[data-review-admin-content]');
      expect(content.childNodes).toHaveLength(0);
      expect(panel.section.textContent).not.toContain('***@example.org');
      expect(panel.section.querySelector('select[data-review-admin-log]')).toBeNull();
      expect(panel.section.querySelector('[data-review-admin-mine]')).toBeNull();
      expect(panel.section.querySelector('[data-review-admin-purge]')).toBeNull();
    });
  }

  it('shows the unavailable alert for 503 and the network sentence when the request throws', async () => {
    const down = loadPanel({ route: (call) => (call.method === 'GET' ? { status: 503 } : undefined) });
    await down.init();
    await flush();
    expect(q(down.section, '[data-review-admin-alert]').textContent).toContain('The feedback loop routes are unavailable right now.');
    const offline = loadPanel({ route: (call) => (call.method === 'GET' ? { status: 0, throws: true } : undefined) });
    await offline.init();
    await flush();
    expect(q(offline.section, '[data-review-admin-alert]').textContent).toContain("Can't reach the Config UI server");
  });

  it('inserts server values as text, never as markup', async () => {
    const panel = loadPanel({
      ...MULTI,
      workspaces: [{ value: ORG_A, text: XSS_PAYLOAD }],
      route: (call) =>
        call.method === 'GET' && call.url.startsWith('/api/rag/admin/domain-experts')
          ? { status: 200, body: { grants: [{ user_id: USER_1, email: XSS_PAYLOAD, created_at: '<script>PWNED(2)</script>' }] } }
          : call.method === 'POST'
            ? { status: 400, body: { error: XSS_PAYLOAD } }
            : undefined,
    });
    await panel.init();
    await flush();
    input(q(panel.section, 'input[data-review-admin-grant-input]'), NEW_USER);
    q(panel.section, '[data-review-admin-grant]').click();
    await flush();
    expect(panel.section.textContent).toContain(XSS_PAYLOAD);
    expect(injectedElements(panel.section)).toHaveLength(0);
    expect(panel.section.querySelectorAll('script')).toHaveLength(0);
    expect(panel.doc.innerHtmlWrites).toBe(0);
  });

  it('localizes the card for zh and it', async () => {
    const zh = loadPanel({ locale: 'zh-CN' });
    await zh.init();
    await flush();
    expect(zh.section.getAttribute('lang')).toBe('zh');
    expect(zh.section.textContent).toContain('授予权限');
    const itPanel = loadPanel({ locale: 'it-IT' });
    await itPanel.init();
    await flush();
    expect(itPanel.section.textContent).toContain('Concedi accesso');
  });

  it('binds every rag-administration link and mounts once', async () => {
    const panel = loadPanel();
    panel.doc.dispatch('DOMContentLoaded');
    panel.drawerLink.click();
    await flush();
    expect(panel.calls.length).toBeGreaterThan(0);
    const first = panel.calls.length;
    panel.link.click();
    await flush();
    expect(panel.section.querySelectorAll('[data-review-admin-grant]')).toHaveLength(1);
    expect(panel.calls.length).toBeGreaterThan(first);
  });
});

function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + days));
  return date.toISOString().slice(0, 10);
}

describe('review-admin.js: mining and purge (D-15, D-06)', () => {
  it('defaults the window to the last seven days and runs mining only after confirmation', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    const today = isoDay(new Date());
    const since = q(panel.section, 'input[data-review-admin-since]');
    const until = q(panel.section, 'input[data-review-admin-until]');
    expect(since.getAttribute('type')).toBe('date');
    expect(until.value).toBe(today);
    expect(since.value).toBe(shiftDays(today, -7));
    expect(panel.section.textContent).toContain('are starting values and are not calibrated');
    const mine = q(panel.section, '[data-review-admin-mine]');
    expect(mine.className).not.toContain('btn-primary');
    mine.click();
    await flush();
    let dialog = q(panel.section, 'dialog[data-review-admin-dialog="mine"]');
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Run mining for');
    expect(panel.doc.activeElement?.hasAttribute('data-review-admin-dialog-keep')).toBe(true);
    q(dialog, '[data-review-admin-dialog-keep]').click();
    await flush();
    expect(panel.calls.some((c) => c.url.endsWith('/feedback-loop/mine'))).toBe(false);
    q(panel.section, '[data-review-admin-mine]').click();
    await flush();
    dialog = q(panel.section, 'dialog[data-review-admin-dialog="mine"]');
    q(dialog, '[data-review-admin-dialog-confirm]').click();
    await flush();
    const call = panel.calls.find((c) => c.url === '/api/rag/admin/feedback-loop/mine');
    expect(call).toMatchObject({ method: 'POST', body: { since: shiftDays(today, -7), until: shiftDays(today, 1) } });
  });

  it('renders the mining result as hash, reason and count rows sorted by hash then reason priority, never tenant keys', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    q(panel.section, '[data-review-admin-mine]').click();
    await flush();
    q(q(panel.section, 'dialog[data-review-admin-dialog="mine"]'), '[data-review-admin-dialog-confirm]').click();
    await flush();
    const table = q(panel.section, 'table[data-review-admin-mine-result]');
    expect(table.textContent).toContain('Mining result');
    const rows = table.querySelectorAll('tbody tr');
    expect(rows.map((r) => r.textContent)).toEqual([`${HASH_A}Marked not helpful3`, `${HASH_A}Weak matches only2`, `${HASH_B}Nothing retrieved1`]);
    expect(rows[0]!.querySelector('th')!.className).toContain('font-mono');
    expect(rows[0]!.querySelectorAll('td')[1]!.className).toContain('tabular-nums');
    expect(panel.status.textContent).toContain('Mining finished. New cases: 6');
    expect(panel.section.textContent).toContain('Workspaces are shown as hashes here');
    expect(panel.section.textContent).not.toContain(`o:${ORG_A}`);
    expect(panel.section.textContent).not.toContain('f'.repeat(64));
  });

  it('says nothing was found and shows no table when the run added nothing', async () => {
    const panel = loadPanel({
      route: (call) =>
        call.url.endsWith('/feedback-loop/mine')
          ? { status: 200, body: { success: true, result: { status: 'completed', since: 'a', until: 'b', total_inserted: 0, tenants: [{ tenant_hash: HASH_A, inserted: 0, by_reason: {} }] } } }
          : undefined,
    });
    await panel.init();
    await flush();
    q(panel.section, '[data-review-admin-mine]').click();
    await flush();
    q(q(panel.section, 'dialog[data-review-admin-dialog="mine"]'), '[data-review-admin-dialog-confirm]').click();
    await flush();
    expect(panel.section.textContent).toContain('No new cases.');
    expect(panel.section.querySelector('table[data-review-admin-mine-result]')).toBeNull();
  });

  it('shows the switched-off notice for a 404 and keeps the controls', async () => {
    const panel = loadPanel({ route: (call) => (call.url.endsWith('/feedback-loop/mine') ? { status: 404, body: { error: 'Not found' } } : undefined) });
    await panel.init();
    await flush();
    q(panel.section, '[data-review-admin-mine]').click();
    await flush();
    q(q(panel.section, 'dialog[data-review-admin-dialog="mine"]'), '[data-review-admin-dialog-confirm]').click();
    await flush();
    const notice = q(panel.section, '[data-review-admin-mine-notice]');
    expect(notice.className).toContain('alert-info');
    expect(notice.textContent).toContain('Mining is switched off.');
    expect(notice.textContent).toContain('IDs, scores and the masked question');
    expect(notice.textContent).toContain('RAG Modes');
    expect(panel.section.querySelector('[data-review-admin-mine]')).not.toBeNull();
    expect(panel.section.querySelector('input[data-review-admin-since]')).not.toBeNull();
  });

  it('refuses a window that ends before it starts or is longer than 31 days, sending nothing', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    const since = q(panel.section, 'input[data-review-admin-since]');
    const until = q(panel.section, 'input[data-review-admin-until]');
    for (const [from, to] of [
      ['2026-11-20', '2026-11-10'],
      ['2026-10-01', '2026-11-20'],
      ['', '2026-11-20'],
    ]) {
      change(since, from);
      change(until, to);
      q(panel.section, '[data-review-admin-mine]').click();
      await flush();
      expect(panel.section.querySelector('dialog[data-review-admin-dialog="mine"]')).toBeNull();
      expect(panel.section.textContent).toContain('Choose a start date before the end date, 31 days apart at most.');
      expect(since.getAttribute('aria-invalid')).toBe('true');
    }
    change(since, '2026-11-01');
    change(until, '2026-12-01');
    q(panel.section, '[data-review-admin-mine]').click();
    await flush();
    expect(panel.section.querySelector('dialog[data-review-admin-dialog="mine"]')).not.toBeNull();
    expect(panel.calls.some((c) => c.url.endsWith('/feedback-loop/mine'))).toBe(false);
  });

  it('says the outcome is unknown when mining gets no answer', async () => {
    const panel = loadPanel({ route: (call) => (call.url.endsWith('/feedback-loop/mine') ? { status: 0, throws: true } : undefined) });
    await panel.init();
    await flush();
    q(panel.section, '[data-review-admin-mine]').click();
    await flush();
    q(q(panel.section, 'dialog[data-review-admin-dialog="mine"]'), '[data-review-admin-dialog-confirm]').click();
    await flush();
    expect(panel.status.textContent).toContain('Mining may still be running');
  });

  it('purges only after the destructive confirmation and shows the two counts', async () => {
    const panel = loadPanel({ retentionDays: '30' });
    await panel.init();
    await flush();
    const purge = q(panel.section, '[data-review-admin-purge]');
    expect(purge.className).toContain('btn-error');
    expect(purge.className).toContain('btn-outline');
    purge.click();
    await flush();
    const dialog = q(panel.section, 'dialog[data-review-admin-dialog="purge"]');
    expect(dialog.textContent).toContain('Purge expired data?');
    expect(dialog.textContent).toContain('Log rows older than 30 days');
    expect(q(dialog, '[data-review-admin-dialog-confirm]').className).toContain('btn-error');
    expect(panel.doc.activeElement?.hasAttribute('data-review-admin-dialog-keep')).toBe(true);
    expect(panel.calls.some((c) => c.url.endsWith('/purge'))).toBe(false);
    q(dialog, '[data-review-admin-dialog-confirm]').click();
    await flush();
    expect(panel.calls.find((c) => c.url === '/api/rag/admin/feedback-loop/purge')).toMatchObject({ method: 'POST' });
    const table = q(panel.section, 'table[data-review-admin-purge-result]');
    expect(table.querySelectorAll('tbody tr').map((r) => r.textContent)).toEqual(['Retrieval log rows12', 'Open review cases3']);
    expect(panel.status.textContent).toContain('Purge finished.');
  });

  it('names the retention period generically when the page holds no valid number', async () => {
    const panel = loadPanel({ retentionDays: '9999' });
    await panel.init();
    await flush();
    q(panel.section, '[data-review-admin-purge]').click();
    await flush();
    expect(q(panel.section, 'dialog[data-review-admin-dialog="purge"]').textContent).toContain('older than the retention period');
  });

  it('says the purge outcome is unknown when there is no answer, and shows the sign-in alert for 401', async () => {
    const offline = loadPanel({ route: (call) => (call.url.endsWith('/purge') ? { status: 0, throws: true } : undefined) });
    await offline.init();
    await flush();
    q(offline.section, '[data-review-admin-purge]').click();
    await flush();
    q(q(offline.section, 'dialog[data-review-admin-dialog="purge"]'), '[data-review-admin-dialog-confirm]').click();
    await flush();
    expect(offline.status.textContent).toContain('The purge may still be running');
    const denied = loadPanel({ route: (call) => (call.url.endsWith('/purge') ? { status: 401, body: { error: 'Unauthorized' } } : undefined) });
    await denied.init();
    await flush();
    q(denied.section, '[data-review-admin-purge]').click();
    await flush();
    q(q(denied.section, 'dialog[data-review-admin-dialog="purge"]'), '[data-review-admin-dialog-confirm]').click();
    await flush();
    expect(q(denied.section, '[data-review-admin-alert]').textContent).toContain('Admin sign-in required');
    expect(q(denied.section, '[data-review-admin-content]').childNodes).toHaveLength(0);
    expect(denied.section.querySelector('dialog')).toBeNull();
  });

  it('shows the mining and purge blocks in multi-tenant mode before a workspace is chosen', async () => {
    const panel = loadPanel({ mode: 'multi-tenant', workspaces: [] });
    await panel.init();
    await flush();
    expect(panel.section.querySelector('[data-review-admin-mine]')).not.toBeNull();
    expect(panel.section.querySelector('[data-review-admin-purge]')).not.toBeNull();
  });
});

describe('review-admin.js: registration and static rules', () => {
  const source = fs.readFileSync(PANEL_FILE, 'utf8');
  const html = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');

  it('is registered in index.html after review-labelling.js with its panel skeleton after the review queue', () => {
    const labelling = html.indexOf('<script src="rag-panels/review-labelling.js"></script>');
    const admin = html.indexOf('<script src="rag-panels/review-admin.js"></script>');
    expect(labelling).toBeGreaterThan(0);
    expect(admin).toBeGreaterThan(labelling);
    const review = html.indexOf('id="rag-administration-review"');
    const card = html.indexOf('id="rag-administration-feedback-loop"');
    expect(card).toBeGreaterThan(review);
    const skeleton = html.slice(card, html.indexOf('</section>', card));
    for (const hook of ['aria-labelledby="rag-feedback-loop-title"', 'id="rag-feedback-loop-title"', 'data-review-admin-title', 'data-review-admin-description', 'data-review-admin-alert', 'data-review-admin-content', 'data-review-admin-status']) {
      expect(skeleton).toContain(hook);
    }
    expect(skeleton).toContain('role="status"');
  });

  it('uses no innerHTML, no browser storage and no Authorization header', () => {
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(source).not.toMatch(/Authorization/);
  });

  it('has no export, promotion or split control', () => {
    expect(source).not.toMatch(/\/export|split_group|'split'|promote/i);
  });

  it('prefixes every top-level name with reviewAdmin', () => {
    const names = [...source.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^(reviewAdmin|ReviewAdmin|REVIEW_ADMIN_|initReviewAdminPanel$)/);
  });

  it('carries en, zh and it for every label', () => {
    const { REVIEW_ADMIN_LABELS } = require(PANEL_FILE) as { REVIEW_ADMIN_LABELS: Record<string, Record<string, string>> };
    const en = Object.keys(REVIEW_ADMIN_LABELS.en!).sort();
    expect(en.length).toBeGreaterThan(50);
    expect(Object.keys(REVIEW_ADMIN_LABELS.zh!).sort()).toEqual(en);
    expect(Object.keys(REVIEW_ADMIN_LABELS.it!).sort()).toEqual(en);
  });
});

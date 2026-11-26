import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, injectedElements } from './helpers/html-fake-dom';
import { markedBlock } from './helpers/ingest-impact-harness';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/quarantine.js'), 'utf8');

type Json = Record<string, unknown>;
type Locale = 'en' | 'zh' | 'it';

interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}

type Route = 'list' | 'notChecked' | 'release' | 'delete' | 'coverage' | 'rescan';

interface RagCall {
  route: Route | 'unknown';
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}

const LIST = '/api/rag/admin/quarantine';

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const [pathname, search = ''] = apiPath.split('?');
  const query = new URLSearchParams(search);
  if (pathname === LIST && method === 'GET') return query.get('view') === 'not_checked' ? 'notChecked' : 'list';
  if (/^\/api\/rag\/admin\/quarantine\/[^/]+\/release$/.test(pathname!) && method === 'POST') return 'release';
  if (/^\/api\/rag\/admin\/quarantine\/[^/]+$/.test(pathname!) && method === 'DELETE') return 'delete';
  if (pathname === '/api/rag/admin/ingest-fingerprint' && method === 'GET') return 'coverage';
  if (pathname === '/api/rag/admin/ingest-fingerprint/rebuild' && method === 'POST') return 'rescan';
  return 'unknown';
}

function id(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function quarantineItem(n: number, extra: Json = {}): Json {
  return {
    id: id('10', n),
    lineage_id: id('20', n),
    tenant_key: 'tenant-north',
    filename: `document-${n}.pdf`,
    source: 'upload',
    version: 2,
    rule_ids: [],
    snippets: [],
    quarantined_at: '2026-11-20T09:30:00.000Z',
    detected_by: 'scan_injection',
    reasons: [],
    unlocated: 0,
    uploader: { id: id('30', n), display: `member${n}@example.test` },
    pending_approval: false,
    ...extra,
  };
}

function hiddenReason(spans: Json[], extra: Json = {}): Json {
  return { kind: 'hidden_text', detail: 'hidden spans', spans, unlocated: 0, ...extra };
}

function linkReason(targets: string[], extra: Json = {}): Json {
  return { kind: 'untrusted_link', detail: 'off allowlist', targets, unlocated: 0, ...extra };
}

function listAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, total: items.length, limit: 50, offset: 0, items, ...extra };
}

function notCheckedAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, view: 'not_checked', total: items.length, limit: 50, offset: 0, items, ...extra };
}

function notCheckedItem(n: number, extra: Json = {}): Json {
  return {
    id: id('40', n),
    lineage_id: id('50', n),
    tenant_key: 'tenant-north',
    filename: `sheet-${n}.xlsx`,
    doc_type: 'general',
    source: 'upload',
    uploaded_at: '2026-11-19T08:00:00.000Z',
    ...extra,
  };
}

function coverageAnswer(rescan: Json | null): Json {
  const pending = rescan ? [{ mechanism: 'rescan', affected: 12, by_doc_type: { general: 12 }, start: 'cli', command: 'npm run rag:rebuild -- rescan', ...rescan }] : [];
  return { success: true, pending, without_fingerprint: { count: 0, command: 'npm run rag:fingerprint -- backfill' }, total_current: 40, rebuilds: [] };
}

const DEFAULT_REPLIES: Record<Route, Reply> = {
  list: { status: 200, body: listAnswer([]) },
  notChecked: { status: 200, body: notCheckedAnswer([]) },
  release: { status: 200, body: { success: true, status: 'ready' } },
  delete: { status: 200, body: { success: true } },
  coverage: { status: 200, body: coverageAnswer({}) },
  rescan: { status: 202, body: { success: true, status: 'started' } },
};

interface HarnessOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | ((call: RagCall) => Reply)>>;
  hiddenCheck?: string;
  linkCheck?: string;
  injectionScan?: string;
  allowlist?: string;
  siteUrl?: string;
  innerGuard?: (next: Json, saved: Json) => unknown;
}

function quarantineSkeleton(): string {
  const start = indexHtml.indexOf('<section id="rag-administration-quarantine"');
  const end = indexHtml.indexOf('</section>', start);
  if (start < 0 || end < start) throw new Error('quarantine section not found in index.html');
  return indexHtml.slice(start, end + '</section>'.length);
}

function loadQuarantinePage(options: HarnessOptions = {}) {
  const doc = new FakeDocument();
  const ragCalls: RagCall[] = [];
  const toasts: Array<[string, string]> = [];

  for (const label of ['desktop', 'mobile']) {
    const link = doc.createElement('a');
    link.setAttribute('data-tab', 'rag-administration');
    link.setAttribute('data-test-link', label);
    doc.body.appendChild(link);
  }

  const scan = doc.createElement('select');
  scan.id = 'RAG_INJECTION_SCAN';
  scan.value = options.injectionScan ?? 'off';
  doc.body.appendChild(scan);
  const site = doc.createElement('input');
  site.id = 'NEXT_PUBLIC_SITE_URL';
  site.value = options.siteUrl ?? '';
  doc.body.appendChild(site);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);

  const settingsHolder = doc.createElement('div');
  tab.appendChild(settingsHolder);
  settingsHolder.innerHTML = markedBlock('rag-phase032-settings');
  const hidden = doc.getElementById('RAG_HIDDEN_TEXT_CHECK');
  if (hidden) hidden.value = options.hiddenCheck ?? 'off';
  const links = doc.getElementById('RAG_INGEST_LINK_CHECK');
  if (links) links.value = options.linkCheck ?? 'off';
  const allow = doc.getElementById('RAG_OUTPUT_LINK_ALLOWLIST');
  if (allow) allow.value = options.allowlist ?? '';

  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = quarantineSkeleton();
  doc.innerHtmlWrites = 0;

  const replyFor = (call: RagCall): Reply => {
    const custom = options.replies?.[call.route as Route];
    if (typeof custom === 'function') return custom(call);
    return custom ?? DEFAULT_REPLIES[call.route as Route];
  };

  const ragFetch = async (rawPath: string, init: Json = {}) => {
    const apiPath = rawPath.startsWith('/') ? rawPath : `/api/rag/${rawPath}`;
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : init.body;
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
    Intl,
    Date,
    ragFetch,
    confirm: () => {
      throw new Error('window.confirm must not be used');
    },
    showToast: (message: string, type: string) => toasts.push([message, type]),
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  };
  if (options.innerGuard) context.ragIngestImpactGuard = options.innerGuard;
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/doc-types.js', 'rag-panels/quarantine.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }

  const root = doc.getElementById('rag-administration-quarantine') as FakeElement;
  return {
    doc,
    context,
    root,
    ragCalls,
    toasts,
    calls(route: Route) {
      return ragCalls.filter((c) => c.route === route);
    },
    async init() {
      const init = context.initQuarantinePanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initQuarantinePanel is not defined');
      await init();
      await flush();
    },
    dialog(): FakeElement | null {
      return doc.querySelectorAll('dialog').find((d) => d.open) ?? null;
    },
    status(): FakeElement {
      return root.querySelector('[data-rag-quarantine-status]') as FakeElement;
    },
    cards(): FakeElement[] {
      return root.querySelectorAll('article[data-quarantine-card]');
    },
    tabButton(name: 'quarantined' | 'not-checked' | 'checks'): FakeElement {
      const button = doc.getElementById(`rag-quarantine-tab-${name}`);
      if (!button) throw new Error('no tab ' + name);
      return button;
    },
    panel(name: 'quarantined' | 'not-checked' | 'checks'): FakeElement {
      const el = doc.getElementById(`rag-quarantine-panel-${name}`);
      if (!el) throw new Error('no panel ' + name);
      return el;
    },
  };
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function buttonByText(root: FakeElement | null, text: string): FakeElement {
  const button = (root ? root.querySelectorAll('button') : []).find((b) => b.textContent.trim() === text);
  if (!button) throw new Error('no button ' + text);
  return button;
}

function loadModule() {
  return require('../../scripts/config-ui/rag-panels/quarantine.js') as {
    QUARANTINE_LABELS: Record<Locale, Record<string, string>>;
    buildQuarantineItemView: (item: Json) => { filename: string; ruleIds: string; snippets: string[] };
    quarantineItemView: (
      item: Json,
      locale: Locale,
    ) => {
      id: string;
      file: string;
      unlocated: number;
      pendingApproval: boolean;
      groups: Array<{
        kind: string;
        known: boolean;
        rules: string[];
        snippets: string[];
        spans: Array<{ text: string; reason: string; page: number | null; caption: string }>;
        targets: string[];
      }>;
    };
  };
}

const MARKUP_SPAN = '<img src=x onerror=PWNED(1)>';
const JS_TARGET = 'javascript:PWNED(2)';
const PLAIN_TARGET = 'https://evil.example/login';

function twoReasonItem(extra: Json = {}): Json {
  return quarantineItem(1, {
    reasons: [
      linkReason([JS_TARGET, PLAIN_TARGET, 'mailto:someone@evil.example']),
      hiddenReason([
        { page: 3, text: MARKUP_SPAN, reason: 'tiny_font' },
        { page: null, text: 'second hidden sentence', reason: 'near_background' },
      ]),
    ],
    ...extra,
  });
}

function everyAttributeValue(root: FakeElement): string[] {
  return [root, ...root.querySelectorAll('*')].flatMap((el) => [...el.attributes.values()]);
}

describe('quarantineItemView maps the route answer to reason groups (UI-SPEC 6.5.2, 11.4)', () => {
  it('orders the groups injection_rule, hidden_text, untrusted_link, invoice_extraction and keeps evidence as plain strings', () => {
    const { quarantineItemView } = loadModule();
    const view = quarantineItemView(twoReasonItem(), 'en');
    expect(view.groups.map((g) => g.kind)).toEqual(['hidden_text', 'untrusted_link']);
    const hidden = view.groups[0]!;
    expect(hidden.spans.map((s) => s.text)).toEqual([MARKUP_SPAN, 'second hidden sentence']);
    expect(hidden.spans[0]!.caption).toBe('Very small text, page 3');
    expect(hidden.spans[1]!.caption).toBe('Text in the background colour');
    expect(view.groups[1]!.targets).toEqual([JS_TARGET, PLAIN_TARGET, 'mailto:someone@evil.example']);
  });

  it('puts every kind in the fixed order whatever order the server sends', () => {
    const { quarantineItemView } = loadModule();
    const view = quarantineItemView(
      quarantineItem(2, {
        rule_ids: ['ignore_previous'],
        snippets: ['ignore previous instructions'],
        reasons: [
          { kind: 'invoice_extraction', detail: 'fields', unlocated: 0 },
          linkReason(['evil.example']),
          { kind: 'injection_rule', detail: 'rules', unlocated: 0 },
          hiddenReason([{ page: 1, text: 'x', reason: 'off_page' }]),
        ],
      }),
      'en',
    );
    expect(view.groups.map((g) => g.kind)).toEqual(['injection_rule', 'hidden_text', 'untrusted_link', 'invoice_extraction']);
    expect(view.groups[0]!.rules).toEqual(['ignore_previous']);
    expect(view.groups[0]!.snippets).toEqual(['ignore previous instructions']);
  });

  it('keeps the old buildQuarantineItemView fields', () => {
    const { buildQuarantineItemView } = loadModule();
    const view = buildQuarantineItemView({ filename: '<b>x</b>', rule_ids: ['a', 'b'], snippets: ['s'] });
    expect(view).toMatchObject({ filename: '<b>x</b>', ruleIds: 'a, b', snippets: ['s'] });
  });

  it('has the same label keys in en, zh and it', () => {
    const { QUARANTINE_LABELS } = loadModule();
    const en = Object.keys(QUARANTINE_LABELS.en).sort();
    expect(Object.keys(QUARANTINE_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(QUARANTINE_LABELS.it).sort()).toEqual(en);
  });
});

describe('a held document with hidden text and links renders both with inert evidence (UI-SPEC 6.5.1, 11.1)', () => {
  it('shows one hold line with the badge word, the reason sentence and Release document', async () => {
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([twoReasonItem()]) } } });
    await page.init();
    const cards = page.cards();
    expect(cards).toHaveLength(1);
    const holds = cards[0]!.querySelectorAll('[data-quarantine-hold]');
    expect(holds).toHaveLength(1);
    const hold = holds[0]!;
    expect(hold.querySelector('.badge')!.textContent).toContain('Quarantined');
    expect(hold.textContent).toContain('Held out of answers: hidden text and links outside the allowlist.');
    expect(hold.querySelector('button')!.textContent.trim()).toBe('Release document');
    expect(cards[0]!.querySelector('h4')!.textContent).toBe('document-1.pdf');
  });

  it('renders one group per kind with the inert line once, evidence in figures whose pre holds text only', async () => {
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([twoReasonItem()]) } } });
    await page.init();
    const card = page.cards()[0]!;
    const groups = card.querySelectorAll('[data-quarantine-reason]');
    expect(groups.map((g) => g.getAttribute('data-quarantine-reason'))).toEqual(['hidden_text', 'untrusted_link']);
    for (const group of groups) {
      const inert = group.querySelectorAll('p').filter((p) => p.textContent === 'Shown as text. Never a link.');
      expect(inert).toHaveLength(1);
      expect(group.querySelectorAll('figure').length).toBeGreaterThan(0);
    }
    const pres = groups[0]!.querySelectorAll('pre');
    expect(pres).toHaveLength(2);
    expect(pres[0]!.textContent).toBe(MARKUP_SPAN);
    for (const pre of pres) expect(pre.childNodes.every((node) => node.nodeType === 3)).toBe(true);
    expect(groups[0]!.querySelector('figcaption')!.textContent).toBe('Very small text, page 3');
    const targetCodes = groups[1]!.querySelectorAll('figure li code');
    expect(targetCodes.map((c) => c.textContent)).toEqual([JS_TARGET, PLAIN_TARGET, 'mailto:someone@evil.example']);
    expect(groups[1]!.textContent).toContain('Link targets outside the allowlist: 3');
  });

  it('creates no img, no anchor and no attribute carrying a span or target (onerror, javascript:, plain URL)', async () => {
    const page = loadQuarantinePage({
      replies: { list: { status: 200, body: listAnswer([twoReasonItem({ filename: '<img src=x onerror=PWNED(3)>.pdf', uploader: { id: 'u', display: '<a href="javascript:PWNED(4)">x</a>' } })]) } },
    });
    await page.init();
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.root.querySelectorAll('a')).toEqual([]);
    expect(page.root.querySelectorAll('img')).toEqual([]);
    expect(page.root.querySelectorAll('iframe, embed, object')).toEqual([]);
    const values = everyAttributeValue(page.root);
    for (const needle of ['PWNED(1)', 'PWNED(2)', 'evil.example', 'javascript:']) {
      expect(values.filter((v) => v.includes(needle)), needle).toEqual([]);
    }
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.root.textContent).toContain(JS_TARGET);
    expect(page.root.textContent).toContain(PLAIN_TARGET);
  });

  it('shows the meta line and never the tenant key of another workspace, bounding boxes or checker versions', async () => {
    const item = twoReasonItem({
      reasons: [hiddenReason([{ page: 2, text: 'span', reason: 'covered', bbox: [1, 2, 3, 4], checker_version: 'hidden-text/9.9' }], { checker_version: 'hidden-text/9.9' })],
    });
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([item]) } } });
    await page.init();
    const card = page.cards()[0]!;
    const meta = card.querySelector('dl')!;
    expect(meta.textContent).toContain('Workspace');
    expect(meta.textContent).toContain('tenant-north');
    expect(meta.textContent).toContain('Uploaded by');
    expect(meta.textContent).toContain('member1@example.test');
    expect(card.textContent).not.toContain('hidden-text/9.9');
    expect(card.textContent).not.toContain('1,2,3,4');
    expect(card.querySelectorAll('time').length).toBeGreaterThan(0);
  });
});

describe('Release and Delete use the modal dialog (UI-SPEC finding 7, 12.4)', () => {
  it('Release opens a dialog that lists the consequences for the reasons present and focuses Keep in quarantine', async () => {
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([twoReasonItem()]) } } });
    await page.init();
    buttonByText(page.cards()[0]!, 'Release document').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog).toBeTruthy();
    expect(dialog.className).toContain('modal');
    expect(dialog.textContent).toContain('Release document-1.pdf from quarantine?');
    expect(dialog.textContent).toContain('The document becomes searchable at once.');
    expect(dialog.textContent).toContain('The hidden text stays removed and will not be searchable.');
    expect(dialog.textContent).toContain('The listed link targets are recorded as reviewed for this document');
    expect(dialog.textContent).not.toContain('The matched rules are recorded as reviewed');
    expect(dialog.textContent).not.toContain('Releasing it approves it.');
    expect(page.doc.activeElement!.textContent.trim()).toBe('Keep in quarantine');
  });

  it('states that release counts as approval when the upload also awaits approval, and the rules note for rule reasons', async () => {
    const item = quarantineItem(3, { rule_ids: ['r1'], snippets: ['s1'], pending_approval: true });
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([item]) } } });
    await page.init();
    buttonByText(page.cards()[0]!, 'Release document').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('The matched rules are recorded as reviewed for this document.');
    expect(dialog.textContent).toContain('This upload is also awaiting approval. Releasing it approves it.');
  });

  it('on confirm posts to the release route, reloads and announces the outcome', async () => {
    let listed = 0;
    const page = loadQuarantinePage({
      replies: { list: () => ({ status: 200, body: listAnswer(listed++ === 0 ? [twoReasonItem()] : []) }) },
    });
    await page.init();
    buttonByText(page.cards()[0]!, 'Release document').click();
    await flush();
    buttonByText(page.dialog(), 'Release document').click();
    await flush();
    const release = page.calls('release');
    expect(release).toHaveLength(1);
    expect(release[0]!.path).toBe(`/api/rag/admin/quarantine/${id('10', 1)}/release`);
    expect(release[0]!.body).toEqual({});
    expect(page.calls('list')).toHaveLength(2);
    expect(page.dialog()).toBeNull();
    expect(page.status().textContent).toContain('document-1.pdf is released and searchable.');
  });

  it('Keep in quarantine closes the dialog without a request', async () => {
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([twoReasonItem()]) } } });
    await page.init();
    const opener = buttonByText(page.cards()[0]!, 'Release document');
    opener.click();
    await flush();
    buttonByText(page.dialog(), 'Keep in quarantine').click();
    await flush();
    expect(page.calls('release')).toHaveLength(0);
    expect(page.dialog()).toBeNull();
    expect(page.doc.activeElement).toBe(opener);
  });

  it('Delete uses the error-coloured dialog with Keep document focused, then sends DELETE', async () => {
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([twoReasonItem()]) } } });
    await page.init();
    buttonByText(page.cards()[0]!, 'Delete document').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('Delete document-1.pdf?');
    expect(dialog.textContent).toContain("The quarantined version is removed. This can't be undone.");
    expect(page.doc.activeElement!.textContent.trim()).toBe('Keep document');
    const confirm = buttonByText(dialog, 'Delete document');
    expect(confirm.className).toContain('btn-error');
    confirm.click();
    await flush();
    const calls = page.calls('delete');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/api/rag/admin/quarantine/${id('10', 1)}`);
    expect(page.status().textContent).toContain('document-1.pdf is deleted.');
  });

  it('a 409 not_quarantined shows the item-changed sentence and reloads the list', async () => {
    const page = loadQuarantinePage({
      replies: {
        list: { status: 200, body: listAnswer([twoReasonItem()]) },
        release: { status: 409, body: { success: false, error: 'not_quarantined' } },
      },
    });
    await page.init();
    buttonByText(page.cards()[0]!, 'Release document').click();
    await flush();
    buttonByText(page.dialog(), 'Release document').click();
    await flush();
    expect(page.status().textContent).toContain('This item was changed by someone else. The list has been reloaded.');
    expect(page.calls('list')).toHaveLength(2);
  });

  it('the release and delete buttons name the file in their accessible name', async () => {
    const page = loadQuarantinePage({ replies: { list: { status: 200, body: listAnswer([twoReasonItem()]) } } });
    await page.init();
    const card = page.cards()[0]!;
    expect(buttonByText(card, 'Release document').getAttribute('aria-label')).toBe('Release document: document-1.pdf');
    expect(buttonByText(card, 'Delete document').getAttribute('aria-label')).toBe('Delete document: document-1.pdf');
  });

  it('does not call window.confirm anywhere', () => {
    expect(panelSource).not.toMatch(/\bconfirm\(\s*`|globalThis\.confirm|window\.confirm/);
    expect(panelSource).not.toContain('innerHTML');
  });
});

describe('init binds to every RAG administration link (UI-SPEC finding 13)', () => {
  it('starts from the desktop and the mobile drawer link, once per link', async () => {
    for (const which of ['desktop', 'mobile']) {
      const page = loadQuarantinePage();
      page.doc.getElementById('rag-administration')!.className = 'tab-content';
      page.doc.dispatch('DOMContentLoaded');
      expect(page.context.quarantinePanel).toBeUndefined();
      const link = page.doc.querySelectorAll('[data-tab="rag-administration"]').find((l) => l.getAttribute('data-test-link') === which)!;
      link.click();
      await flush();
      expect(page.context.quarantinePanel, which).toBeTruthy();
      const before = page.calls('list').length;
      page.doc.dispatch('DOMContentLoaded');
      link.click();
      await flush();
      expect(page.calls('list').length - before).toBe(1);
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, injectedElements, XSS_PAYLOAD } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);
const configUiDir = path.resolve(import.meta.dirname, '../../scripts/config-ui');
const PANEL_FILE = path.join(configUiDir, 'rag-panels/review-labelling.js');

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

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHUNK_1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const CHUNK_2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const CHUNK_3 = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const TENANT = 'o:99999999-9999-4999-8999-999999999999';

const PASSAGE_1 = 'The quarterly summary lists three steps.\nStep two needs a signed form before the review date.';
const PASSAGE_2 = 'Section two describes the archive and its retention rules.';

function item(id: string, extra: Json = {}): Json {
  return {
    id,
    tenant_key: TENANT,
    trace_id: 'trace-should-never-render',
    query_masked: 'What does step two need?',
    query_language: 'en',
    answer_language: 'en',
    chunk_languages: ['en'],
    channel: 'chat',
    outcome: 'refused_no_context',
    candidates: [
      { chunk_id: CHUNK_1, document_id: DOC_A, rank: 1, similarity: 0.41234, kept: true, language: 'en' },
      { chunk_id: CHUNK_2, document_id: DOC_A, rank: 2, similarity: 0.3, rerank_score: 0.7777, kept: false },
    ],
    retrieval_config_hash: 'hash-should-never-render',
    reasons: ['refusal_disputed', 'low_score'],
    occurrences: 3,
    tags: [],
    status: 'open',
    triage: [],
    label: null,
    labelled_by: null,
    labelled_at: null,
    split: null,
    split_group: null,
    mining_window: null,
    mined_at: '2026-11-18T10:00:00Z',
    expires_at: null,
    answer_masked: null,
    ...extra,
  };
}

function chunksBody(id = ITEM_A): Json {
  return {
    item_id: id,
    chunks: [
      { chunk_id: CHUNK_1, document_id: DOC_A, available: true, document_name: 'document-a.pdf', section: '2.1', text: PASSAGE_1 },
      { chunk_id: CHUNK_2, document_id: DOC_A, available: true, document_name: 'document-a.pdf', section: '', text: PASSAGE_2 },
    ],
  };
}

function defaultRoute(call: RagCall): Reply | undefined {
  if (call.url.startsWith('/api/rag/review/items?') || call.url === '/api/rag/review/items') {
    return { status: 200, body: { items: [item(ITEM_A), item(ITEM_B, { query_masked: 'Where is the archive kept?', status: 'labelled', reasons: ['zero_results'], occurrences: 1 })], next_cursor: null } };
  }
  if (call.url === `/api/rag/review/items/${ITEM_A}`) return { status: 200, body: item(ITEM_A) };
  if (call.url === `/api/rag/review/items/${ITEM_B}`) return { status: 200, body: item(ITEM_B, { query_masked: 'Where is the archive kept?', candidates: [] }) };
  if (call.url === `/api/rag/review/items/${ITEM_A}/chunks`) return { status: 200, body: chunksBody(ITEM_A) };
  if (call.url === `/api/rag/review/items/${ITEM_B}/chunks`) return { status: 200, body: { item_id: ITEM_B, chunks: [] } };
  if (call.url.endsWith('/search')) {
    return {
      status: 200,
      body: { item_id: ITEM_A, hits: [{ rank: 1, chunk_id: CHUNK_3, document_id: DOC_B, document_name: 'document-b.pdf', section: '4', text: 'The signed form goes to the second office.', score: 0.5 }] },
    };
  }
  if (call.url.endsWith('/label')) {
    const body = call.body as Json;
    return { status: 200, body: { item_id: ITEM_A, status: body.status, triage: [], label: body.label ?? null, labelled_at: '2026-11-26T10:00:00Z' } };
  }
  return undefined;
}

export function loadPanel(options: { route?: Route; locale?: string; selection?: () => unknown } = {}) {
  const doc = new FakeDocument();
  const calls: RagCall[] = [];
  const link = doc.createElement('a');
  link.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(link);
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content';
  doc.body.appendChild(tab);
  const section = doc.createElement('section');
  section.id = 'rag-administration-review';
  tab.appendChild(section);
  const body = doc.createElement('div');
  body.className = 'card-body';
  section.appendChild(body);
  const title = doc.createElement('h3');
  title.id = 'rag-review-title';
  title.setAttribute('tabindex', '-1');
  title.setAttribute('data-review-title', '');
  title.textContent = 'Review queue';
  body.appendChild(title);
  for (const name of ['data-review-description', 'data-review-alert', 'data-review-content']) {
    const el = doc.createElement(name === 'data-review-description' ? 'p' : 'div');
    el.setAttribute(name, '');
    body.appendChild(el);
  }
  const status = doc.createElement('div');
  status.setAttribute('data-review-status', '');
  status.setAttribute('role', 'status');
  body.appendChild(status);

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const call: RagCall = { url: apiPath, method: String(init.method ?? 'GET'), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const reply = (options.route && options.route(call)) ?? defaultRoute(call) ?? { status: 500, body: { error: 'unexpected' } };
    if (reply.throws) throw new TypeError('Failed to fetch');
    const copy = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    if (reply.status >= 200 && reply.status < 300) return { ok: true, status: reply.status, body: copy };
    return { ok: false, status: reply.status, body: copy, message: 'failed' };
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
    ragFetch,
    getSelection: options.selection ?? (() => null),
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/review-labelling.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const init = () => (context.initReviewLabellingPanel as () => Promise<unknown>)();
  return { doc, section, calls, context, init, status };
}

export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

export function q(root: FakeElement | FakeDocument, selector: string): FakeElement {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

export function change(el: FakeElement, value?: string): void {
  if (value !== undefined) el.value = value;
  el.dispatch('change');
}

export async function openFirstCase(panel: ReturnType<typeof loadPanel>): Promise<void> {
  await panel.init();
  await flush();
  q(panel.section, '[data-review-open]').click();
  await flush();
}

describe('review-labelling.js: queue view (D-16)', () => {
  it('lists the visible cases with masked question, reasons, occurrences and status', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    expect(panel.calls[0]).toMatchObject({ url: '/api/rag/review/items?status=open', method: 'GET' });
    const rows = panel.section.querySelectorAll('tr[data-review-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('What does step two need?');
    expect(rows[0]!.textContent).toContain('Refusal disputed');
    expect(rows[0]!.textContent).toContain('Weak matches only');
    expect(rows[0]!.textContent).toContain('Asked: 3');
    expect(rows[0]!.textContent).toContain('Open');
    expect(rows[1]!.textContent).toContain('Labelled');
    expect(rows[1]!.textContent).not.toContain('Asked:');
    expect(panel.status.textContent).toContain('Cases shown: 2');
    const text = panel.section.textContent;
    for (const hidden of ['trace-should-never-render', 'hash-should-never-render', TENANT]) expect(text).not.toContain(hidden);
  });

  it('puts the filters in the query string and omits "All"', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    change(q(panel.section, 'select[data-review-filter="status"]'), 'labelled');
    await flush();
    expect(panel.calls.at(-1)!.url).toBe('/api/rag/review/items?status=labelled');
    change(q(panel.section, 'select[data-review-filter="reason"]'), 'zero_results');
    await flush();
    change(q(panel.section, 'select[data-review-filter="language"]'), 'it');
    await flush();
    expect(panel.calls.at(-1)!.url).toBe('/api/rag/review/items?status=labelled&reason=zero_results&language=it');
    change(q(panel.section, 'select[data-review-filter="status"]'), '');
    await flush();
    expect(panel.calls.at(-1)!.url).toBe('/api/rag/review/items?reason=zero_results&language=it');
  });

  it('pages with the cursor and appends', async () => {
    let page = 0;
    const panel = loadPanel({
      route: (call) => {
        if (!call.url.startsWith('/api/rag/review/items?')) return undefined;
        page += 1;
        if (page === 1) return { status: 200, body: { items: [item(ITEM_A)], next_cursor: 'cursor-1' } };
        return { status: 200, body: { items: [item(ITEM_B)], next_cursor: null } };
      },
    });
    await panel.init();
    await flush();
    q(panel.section, '[data-review-load-more]').click();
    await flush();
    expect(panel.calls.at(-1)!.url).toBe('/api/rag/review/items?status=open&cursor=cursor-1');
    expect(panel.section.querySelectorAll('tr[data-review-row]')).toHaveLength(2);
    expect(panel.section.querySelector('[data-review-load-more]')).toBeNull();
  });

  it('shows the workspace only when the cases span more than one', async () => {
    const other = 'o:88888888-8888-4888-8888-888888888888';
    const panel = loadPanel({
      route: (call) =>
        call.url.startsWith('/api/rag/review/items?') ? { status: 200, body: { items: [item(ITEM_A), item(ITEM_B, { tenant_key: other })], next_cursor: null } } : undefined,
    });
    await panel.init();
    await flush();
    expect(panel.section.textContent).toContain(TENANT);
    expect(panel.section.textContent).toContain(other);
  });

  it('shows the sign-in message for 401 and 403, with the expert line', async () => {
    for (const status of [401, 403]) {
      const panel = loadPanel({ route: (call) => (call.url.startsWith('/api/rag/review/items') ? { status, body: { error: 'Unauthorized' } } : undefined) });
      await panel.init();
      await flush();
      const alert = q(panel.section, '[data-review-alert]');
      expect(alert.textContent).toContain('Admin sign-in required');
      expect(alert.textContent).toContain('No admin role is needed for this panel.');
      expect(panel.section.querySelectorAll('tr[data-review-row]')).toHaveLength(0);
    }
  });

  it('shows the switched-off notice for a 404 on the list', async () => {
    const panel = loadPanel({ route: (call) => (call.url.startsWith('/api/rag/review/items') ? { status: 404, body: { error: 'Not found' } } : undefined) });
    await panel.init();
    await flush();
    const alert = q(panel.section, '[data-review-alert]');
    expect(alert.textContent).toContain('Expert review is switched off');
    expect(alert.textContent).toContain('RAG Modes');
    expect(alert.textContent).toContain('Retrieval log and feedback');
    expect(panel.section.querySelector('select[data-review-filter="status"]')).toBeNull();
  });

  it('shows the unavailable sentence for 503 and the network sentence when the request throws', async () => {
    const down = loadPanel({ route: (call) => (call.url.startsWith('/api/rag/review/items') ? { status: 503 } : undefined) });
    await down.init();
    await flush();
    expect(q(down.section, '[data-review-alert]').textContent).toContain('The review queue is unavailable right now.');
    const offline = loadPanel({ route: (call) => (call.url.startsWith('/api/rag/review/items') ? { status: 0, throws: true } : undefined) });
    await offline.init();
    await flush();
    expect(q(offline.section, '[data-review-alert]').textContent).toContain("Can't reach the Config UI server");
  });

  it('shows the empty state and the filtered empty state', async () => {
    const panel = loadPanel({ route: (call) => (call.url.startsWith('/api/rag/review/items?') ? { status: 200, body: { items: [], next_cursor: null } } : undefined) });
    await panel.init();
    await flush();
    expect(panel.section.textContent).toContain('No cases to review');
    change(q(panel.section, 'select[data-review-filter="reason"]'), 'low_score');
    await flush();
    expect(panel.section.textContent).toContain('No case matches these filters.');
    q(panel.section, '[data-review-reset-filters]').click();
    await flush();
    expect(panel.calls.at(-1)!.url).toBe('/api/rag/review/items?status=open');
  });

  it('localizes the panel for zh and it', async () => {
    const zh = loadPanel({ locale: 'zh-CN' });
    await zh.init();
    await flush();
    expect(zh.section.textContent).toContain('拒答被质疑');
    expect(zh.section.getAttribute('lang')).toBe('zh');
    const itPanel = loadPanel({ locale: 'it-IT' });
    await itPanel.init();
    await flush();
    expect(itPanel.section.textContent).toContain('Rifiuto contestato');
  });
});

describe('review-labelling.js: case view (D-16, D-19)', () => {
  it('shows the masked question, outcome, reasons and the candidates with rank, score and kept mark, then the chunk text', async () => {
    const panel = loadPanel();
    await openFirstCase(panel);
    expect(panel.calls.map((c) => c.url)).toContain(`/api/rag/review/items/${ITEM_A}`);
    expect(panel.calls.map((c) => c.url)).toContain(`/api/rag/review/items/${ITEM_A}/chunks`);
    const view = panel.section.textContent;
    expect(view).toContain('What does step two need?');
    expect(view).toContain('Refused: not in the documents');
    expect(view).toContain('Asked: 3');
    expect(view).toContain('No answer text is kept for this case.');
    const passages = panel.section.querySelectorAll('article[data-review-passage]');
    expect(passages).toHaveLength(2);
    expect(passages[0]!.textContent).toContain('Passage 1: document-a.pdf');
    expect(passages[0]!.textContent).toContain('Similarity: 0.412');
    expect(passages[0]!.textContent).toContain('Used for the answer');
    expect(passages[0]!.textContent).toContain('Section: 2.1');
    expect(passages[1]!.textContent).toContain('Rerank score: 0.778');
    expect(passages[1]!.textContent).toContain('Retrieved, not used');
    expect(q(passages[0]!, '[data-review-passage-text]').textContent).toBe(PASSAGE_1);
    expect(panel.doc.activeElement?.hasAttribute('data-review-back')).toBe(true);
    for (const hidden of ['trace-should-never-render', 'hash-should-never-render']) expect(view).not.toContain(hidden);
  });

  it('shows the masked answer when the route returns one', async () => {
    const panel = loadPanel({ route: (call) => (call.url === `/api/rag/review/items/${ITEM_A}` ? { status: 200, body: item(ITEM_A, { answer_masked: 'The answer said nothing useful.' }) } : undefined) });
    await openFirstCase(panel);
    expect(q(panel.section, '[data-review-answer]').textContent).toBe('The answer said nothing useful.');
  });

  it('marks a passage that is no longer available and disables its controls', async () => {
    const panel = loadPanel({
      route: (call) =>
        call.url.endsWith('/chunks')
          ? { status: 200, body: { item_id: ITEM_A, chunks: [{ chunk_id: CHUNK_1, document_id: DOC_A, available: false }, (chunksBody().chunks as Json[])[1]] } }
          : undefined,
    });
    await openFirstCase(panel);
    const first = panel.section.querySelectorAll('article[data-review-passage]')[0]!;
    expect(first.textContent).toContain('This passage is no longer available.');
    expect(q(first, '[data-review-add-quote]').disabled).toBe(true);
    expect(q(first, 'input[data-review-not-relevant]').disabled).toBe(true);
  });

  it('shows the passages error with a reload button and keeps the form', async () => {
    let fail = true;
    const panel = loadPanel({ route: (call) => (call.url.endsWith('/chunks') && fail ? { status: 503 } : undefined) });
    await openFirstCase(panel);
    expect(panel.section.textContent).toContain('The passages could not be loaded.');
    expect(panel.section.querySelector('[data-review-save]')).not.toBeNull();
    fail = false;
    q(panel.section, '[data-review-reload-passages]').click();
    await flush();
    expect(panel.section.textContent).not.toContain('The passages could not be loaded.');
    expect(q(panel.section, '[data-review-passage-text]').textContent).toBe(PASSAGE_1);
  });

  it('says so when nothing was retrieved', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    panel.section.querySelectorAll('[data-review-open]')[1]!.click();
    await flush();
    expect(panel.section.textContent).toContain('Nothing was retrieved for this question.');
    expect(panel.section.querySelector('form[data-review-search]')).not.toBeNull();
  });

  it('searches the case and lists the hits the same way', async () => {
    const panel = loadPanel();
    await openFirstCase(panel);
    change(q(panel.section, 'input[data-review-search-input]'), 'signed form');
    q(panel.section, 'form[data-review-search]').dispatch('submit');
    await flush();
    const search = panel.calls.find((c) => c.url.endsWith('/search'))!;
    expect(search).toMatchObject({ url: `/api/rag/review/items/${ITEM_A}/search`, method: 'POST', body: { query: 'signed form' } });
    expect(panel.section.textContent).toContain('Search results: 1');
    const result = q(panel.section, 'article[data-review-result]');
    expect(result.textContent).toContain('Result 1: document-b.pdf');
    expect(q(result, '[data-review-passage-text]').textContent).toBe('The signed form goes to the second office.');
    expect(result.querySelector('input[data-review-not-relevant]')).toBeNull();
  });

  it('refuses a search over 500 characters without a request, and maps 503 and empty results', async () => {
    let reply: Reply = { status: 503 };
    const panel = loadPanel({ route: (call) => (call.url.endsWith('/search') ? reply : undefined) });
    await openFirstCase(panel);
    change(q(panel.section, 'input[data-review-search-input]'), 'x'.repeat(501));
    q(panel.section, 'form[data-review-search]').dispatch('submit');
    await flush();
    expect(panel.calls.some((c) => c.url.endsWith('/search'))).toBe(false);
    expect(panel.section.textContent).toContain('Use 500 characters or fewer.');
    change(q(panel.section, 'input[data-review-search-input]'), 'archive');
    q(panel.section, 'form[data-review-search]').dispatch('submit');
    await flush();
    expect(panel.section.textContent).toContain('Search is unavailable for this workspace right now.');
    reply = { status: 200, body: { item_id: ITEM_A, hits: [] } };
    q(panel.section, 'form[data-review-search]').dispatch('submit');
    await flush();
    expect(panel.section.textContent).toContain('No passage matched.');
  });

  it('returns to the queue and reloads it when the case is gone (404)', async () => {
    const panel = loadPanel({ route: (call) => (call.url === `/api/rag/review/items/${ITEM_A}` ? { status: 404 } : undefined) });
    await openFirstCase(panel);
    expect(panel.status.textContent).toContain('This case is no longer in your queue.');
    expect(panel.section.querySelectorAll('tr[data-review-row]')).toHaveLength(2);
    expect(panel.calls.filter((c) => c.url.startsWith('/api/rag/review/items?'))).toHaveLength(2);
  });

  it('goes back to the queue and focuses the row of the case', async () => {
    const panel = loadPanel();
    await openFirstCase(panel);
    q(panel.section, '[data-review-back]').click();
    await flush();
    expect(panel.section.querySelectorAll('tr[data-review-row]')).toHaveLength(2);
    expect(panel.doc.activeElement?.getAttribute('data-review-open')).toBe(ITEM_A);
  });

  it('renders markup in every server string as text (XSS)', async () => {
    const payload = `${XSS_PAYLOAD}<script>PWNED(2)</script>`;
    const evil = item(ITEM_A, { query_masked: payload, answer_masked: payload, tenant_key: TENANT });
    const panel = loadPanel({
      route: (call) => {
        if (call.url.startsWith('/api/rag/review/items?')) return { status: 200, body: { items: [evil, item(ITEM_B, { tenant_key: 's:default' })], next_cursor: null } };
        if (call.url === `/api/rag/review/items/${ITEM_A}`) return { status: 200, body: evil };
        if (call.url.endsWith('/chunks'))
          return { status: 200, body: { item_id: ITEM_A, chunks: [{ chunk_id: CHUNK_1, document_id: DOC_A, available: true, document_name: payload, section: payload, text: payload }] } };
        if (call.url.endsWith('/search'))
          return { status: 200, body: { item_id: ITEM_A, hits: [{ rank: 1, chunk_id: CHUNK_3, document_id: DOC_B, document_name: payload, section: payload, text: payload }] } };
        return undefined;
      },
    });
    await panel.init();
    await flush();
    expect(panel.section.textContent).toContain(payload);
    q(panel.section, '[data-review-open]').click();
    await flush();
    change(q(panel.section, 'input[data-review-search-input]'), 'form');
    q(panel.section, 'form[data-review-search]').dispatch('submit');
    await flush();
    expect(q(panel.section, '[data-review-passage-text]').textContent).toBe(payload);
    expect(injectedElements(panel.doc)).toEqual([]);
    expect(panel.doc.created).not.toContain('script');
    expect(panel.doc.created).not.toContain('img');
    expect(panel.doc.innerHtmlWrites).toBe(0);
  });

  it('calls nothing outside /api/rag/review/ and sends no tenant', async () => {
    const panel = loadPanel();
    await openFirstCase(panel);
    change(q(panel.section, 'input[data-review-search-input]'), 'form');
    q(panel.section, 'form[data-review-search]').dispatch('submit');
    await flush();
    for (const call of panel.calls) {
      expect(call.url.startsWith('/api/rag/review/items')).toBe(true);
      expect(call.url).not.toMatch(/tenant/i);
      expect(JSON.stringify(call.body ?? {})).not.toMatch(/tenant/i);
    }
  });
});

describe('review-labelling.js static guards', () => {
  it('uses no innerHTML, no browser storage and no Authorization header', () => {
    const source = fs.readFileSync(PANEL_FILE, 'utf8');
    expect(source).not.toContain('innerHTML');
    expect(source).not.toContain('insertAdjacentHTML');
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|Authorization/);
  });

  it('is registered in index.html after injection-defense.js with its panel skeleton', () => {
    const html = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
    const tag = html.indexOf('<script src="rag-panels/review-labelling.js"></script>');
    expect(tag).toBeGreaterThan(html.indexOf('rag-panels/injection-defense.js'));
    expect(html).toContain('id="rag-administration-review"');
    expect(html.indexOf('id="rag-administration-review"')).toBeGreaterThan(html.indexOf('id="rag-administration-refusal"'));
    for (const hook of ['data-review-title', 'data-review-description', 'data-review-alert', 'data-review-content', 'data-review-status']) expect(html).toContain(hook);
    expect(html).toContain('Domain experts label failed questions in the Review queue with their own sign-in.');
  });

  it('keeps the en, zh and it label tables in step', () => {
    const mod = require(PANEL_FILE) as { REVIEW_LABELLING_LABELS: Record<string, Record<string, string>> };
    const en = Object.keys(mod.REVIEW_LABELLING_LABELS.en!).sort();
    expect(Object.keys(mod.REVIEW_LABELLING_LABELS.zh!).sort()).toEqual(en);
    expect(Object.keys(mod.REVIEW_LABELLING_LABELS.it!).sort()).toEqual(en);
  });
});

function selectIn(panel: ReturnType<typeof loadPanel>, region: FakeElement, text: string, state: { sel: unknown }) {
  const node = region.childNodes[0];
  state.sel = { toString: () => text, anchorNode: node, focusNode: node };
  region.dispatch('mouseup');
  void panel;
}

function loadWithSelection(options: { route?: Route; locale?: string } = {}) {
  const state: { sel: unknown } = { sel: null };
  const panel = loadPanel({ ...options, selection: () => state.sel });
  return { panel, state };
}

function labelCalls(panel: ReturnType<typeof loadPanel>) {
  return panel.calls.filter((c) => c.url.endsWith('/label'));
}

function check(el: FakeElement, on = true) {
  el.checked = on;
  el.dispatch('change');
}

function typeInto(el: FakeElement, value: string) {
  el.value = value;
  el.dispatch('input');
}

/** Answerable yes, one quote from passage 1, an expected answer and Test set ticked. */
async function fillAnswerable(panel: ReturnType<typeof loadPanel>, state: { sel: unknown }, quote = 'needs a signed form') {
  await openFirstCase(panel);
  const passage = panel.section.querySelectorAll('article[data-review-passage]')[0]!;
  selectIn(panel, q(passage, '[data-review-passage-text]'), quote, state);
  q(passage, '[data-review-add-quote]').click();
  check(q(panel.section, 'input[data-review-answerable="yes"]'));
  typeInto(q(panel.section, 'textarea[data-review-expected]'), 'It needs a signed form.');
}

describe('review-labelling.js: label form (D-18, D-22)', () => {
  it('adds a quote with the exact selected substring and checks it on every edit', async () => {
    const { panel, state } = loadWithSelection();
    await openFirstCase(panel);
    const passage = panel.section.querySelectorAll('article[data-review-passage]')[0]!;
    selectIn(panel, q(passage, '[data-review-passage-text]'), 'Step two needs', state);
    q(passage, '[data-review-add-quote]').click();
    const slip = q(panel.section, 'figure[data-review-quote]');
    const field = q(slip, 'textarea[data-review-quote-text]');
    expect(field.value).toBe('Step two needs');
    expect(slip.textContent).toContain('Quote 1 from Passage 1: document-a.pdf');
    expect(q(slip, '[data-review-quote-check]').textContent).toBe('Found word for word in the passage.');
    expect(panel.doc.activeElement).toBe(field);
    typeInto(field, 'Step three needs');
    expect(q(slip, '[data-review-quote-check]').textContent).toContain('This text is not in the passage word for word.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    typeInto(field, 'S');
    expect(q(slip, '[data-review-quote-check]').textContent).toBe('A quote needs at least 2 characters.');
    typeInto(field, '  step TWO, needs ');
    expect(q(slip, '[data-review-quote-check]').textContent).toBe('Found word for word in the passage.');
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('ignores a selection made outside the passage and adds an empty quote for keyboard use', async () => {
    const { panel, state } = loadWithSelection();
    await openFirstCase(panel);
    const [first, second] = panel.section.querySelectorAll('article[data-review-passage]');
    selectIn(panel, q(first!, '[data-review-passage-text]'), 'Step two needs', state);
    q(second!, '[data-review-add-quote]').click();
    expect(q(panel.section, 'textarea[data-review-quote-text]').value).toBe('');
    expect(panel.section.textContent).toContain('Quote 1 from Passage 2: document-a.pdf');
  });

  it('keeps Save enabled but sends nothing while a quote is not a substring, and marks the field', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    typeInto(q(panel.section, 'textarea[data-review-quote-text]'), 'a sentence that is not there');
    const save = q(panel.section, '[data-review-save]');
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(0);
    expect(panel.status.textContent).toContain('Fix the marked fields before saving.');
    expect(panel.status.querySelector('[role="alert"]')).not.toBeNull();
    const field = q(panel.section, 'textarea[data-review-quote-text]');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(panel.doc.activeElement).toBe(field);
  });

  it('marks every missing field of an untouched form and sends nothing', async () => {
    const panel = loadPanel();
    await openFirstCase(panel);
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(0);
    const text = panel.section.textContent;
    expect(text).toContain('Choose Yes or No.');
    expect(text).toContain('Choose at least one use for this case.');
    expect(panel.doc.activeElement?.getAttribute('data-review-answerable')).toBe('yes');
  });

  it('sends a complete answerable label with evidence and not-relevant passages', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-triage="training"]'));
    check(q(panel.section, `input[data-review-not-relevant="${CHUNK_2}"]`));
    change(q(panel.section, 'select[data-review-category]'), 'exact_term');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(1);
    expect(labelCalls(panel)[0]).toMatchObject({ url: `/api/rag/review/items/${ITEM_A}/label`, method: 'POST' });
    expect(labelCalls(panel)[0]!.body).toEqual({
      status: 'labelled',
      label: {
        answerable: true,
        category: 'exact_term',
        language: 'en',
        expected_answer: 'It needs a signed form.',
        evidence: [{ chunk_id: CHUNK_1, document_id: DOC_A, document_name: 'document-a.pdf', section: '2.1', quote: 'needs a signed form' }],
        triage: ['training'],
        not_relevant_chunk_ids: [CHUNK_2],
        pii_checked: false,
        paraphrased_question: null,
        confirm_near_duplicate_of: null,
      },
    });
  });

  it('locks "not relevant" on a quoted passage', async () => {
    const { panel, state } = loadWithSelection();
    await openFirstCase(panel);
    check(q(panel.section, `input[data-review-not-relevant="${CHUNK_1}"]`));
    const passage = panel.section.querySelectorAll('article[data-review-passage]')[0]!;
    selectIn(panel, q(passage, '[data-review-passage-text]'), 'Step two', state);
    q(passage, '[data-review-add-quote]').click();
    const box = q(panel.section, `input[data-review-not-relevant="${CHUNK_1}"]`);
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(panel.section.textContent).toContain('A passage you quote can’t be marked not relevant.');
  });

  it('sends an unanswerable label without evidence or expected answer and switches the category to no_answer', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-answerable="no"]'));
    expect(q(panel.section, 'textarea[data-review-expected]').disabled).toBe(true);
    expect(q(panel.section, 'select[data-review-category]').value).toBe('no_answer');
    expect(panel.section.textContent).toContain('Quotes are not saved for a question the documents can’t answer.');
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    q(panel.section, '[data-review-save]').click();
    await flush();
    const label = (labelCalls(panel)[0]!.body as Json).label as Json;
    expect(label).toMatchObject({ answerable: false, category: 'no_answer', expected_answer: null, triage: ['kb_gap'] });
    expect(label.evidence).toBeUndefined();
  });

  it('requires a matching category for the answer', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    change(q(panel.section, 'select[data-review-category]'), 'small_talk');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(0);
    expect(panel.section.textContent).toContain('Choose “No answer in the documents” or “Small talk” only when');
  });

  it('blocks a test-set label until the personal data check is confirmed or a rewritten question is written', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    expect(panel.section.querySelector('input[data-review-pii-confirm]')).toBeNull();
    check(q(panel.section, 'input[data-review-triage="golden"]'));
    const block = q(panel.section, '[data-review-pii]');
    expect(block.textContent).toContain('What does step two need?');
    expect(block.textContent).toContain('Names of people');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(0);
    expect(panel.section.textContent).toContain('Tick the personal data check or write a rewritten question');

    typeInto(q(panel.section, 'textarea[data-review-paraphrase]'), 'What does the second step require?');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(1);
    expect((labelCalls(panel)[0]!.body as Json).label).toMatchObject({ triage: ['golden'], pii_checked: true, paraphrased_question: 'What does the second step require?' });
  });

  it('sends pii_checked and the near-duplicate id when the check is ticked', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-triage="golden"]'));
    check(q(panel.section, 'input[data-review-pii-confirm]'));
    typeInto(q(panel.section, 'input[data-review-dup]'), 'Not an id!');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(0);
    expect(panel.section.textContent).toContain('Paste the item ID exactly as the promotion command printed it.');
    typeInto(q(panel.section, 'input[data-review-dup]'), 'golden-item-007');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect((labelCalls(panel)[0]!.body as Json).label).toMatchObject({ pii_checked: true, paraphrased_question: null, confirm_near_duplicate_of: 'golden-item-007' });
  });

  it('shows term pairs only while Dictionary terms is ticked and sends them', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    expect(panel.section.querySelector('[data-review-term]')).toBeNull();
    check(q(panel.section, 'input[data-review-triage="dictionary"]'));
    expect(panel.section.querySelectorAll('[data-review-term]')).toHaveLength(1);
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(0);
    expect(panel.section.textContent).toContain('Fill both words of each term pair, or remove the pair.');
    typeInto(q(panel.section, 'input[data-review-term-observed]'), 'form B');
    typeInto(q(panel.section, 'input[data-review-term-canonical]'), 'signed form');
    q(panel.section, '[data-review-add-term]').click();
    const rows = panel.section.querySelectorAll('[data-review-term]');
    expect(rows).toHaveLength(2);
    typeInto(q(rows[1]!, 'input[data-review-term-observed]'), 'modulo');
    typeInto(q(rows[1]!, 'input[data-review-term-canonical]'), 'form');
    change(q(rows[1]!, 'select[data-review-term-relation]'), 'translation');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(labelCalls(panel)).toHaveLength(0);
    expect(panel.section.textContent).toContain('Choose the language of the documents’ word for a translation.');
    change(q(panel.section.querySelectorAll('[data-review-term]')[1]!, 'select[data-review-term-language]'), 'en');
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect((labelCalls(panel)[0]!.body as Json).label).toMatchObject({
      triage: ['dictionary'],
      dictionary_terms: [
        { observed_term: 'form B', canonical_term: 'signed form', relation: 'synonym', canonical_language: null },
        { observed_term: 'modulo', canonical_term: 'form', relation: 'translation', canonical_language: 'en' },
      ],
    });
    check(q(panel.section, 'input[data-review-triage="dictionary"]'), false);
    expect(panel.section.querySelector('[data-review-term]')).toBeNull();
  });

  it('marks the quote the server refused (400 with a span index) and moves focus to it', async () => {
    const { panel, state } = loadWithSelection({
      route: (call) => (call.url.endsWith('/label') ? { status: 400, body: { error: 'invalid_evidence', span: 1, reason: 'quote_not_found' } } : undefined),
    });
    await fillAnswerable(panel, state);
    const second = panel.section.querySelectorAll('article[data-review-passage]')[1]!;
    selectIn(panel, q(second, '[data-review-passage-text]'), 'the archive', state);
    q(second, '[data-review-add-quote]').click();
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    q(panel.section, '[data-review-save]').click();
    await flush();
    const slips = panel.section.querySelectorAll('figure[data-review-quote]');
    expect(q(slips[0]!, '[data-review-quote-check]').textContent).toBe('Found word for word in the passage.');
    expect(q(slips[1]!, '[data-review-quote-check]').textContent).toContain('The server did not find this text in the passage.');
    expect(panel.doc.activeElement).toBe(q(slips[1]!, 'textarea[data-review-quote-text]'));
    typeInto(q(slips[1]!, 'textarea[data-review-quote-text]'), 'the archive and');
    expect(q(slips[1]!, '[data-review-quote-check]').textContent).toBe('Found word for word in the passage.');
  });

  it('maps a gone chunk and an unknown span reason', async () => {
    let reason = 'chunk_not_servable';
    const { panel, state } = loadWithSelection({ route: (call) => (call.url.endsWith('/label') ? { status: 400, body: { error: 'invalid_evidence', span: 0, reason } } : undefined) });
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(panel.section.textContent).toContain('This passage can no longer be quoted.');
    reason = 'document_mismatch';
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(panel.section.textContent).toContain('The server rejected this quote (document_mismatch).');
  });

  it('shows "already exported" on 409 and reloads the case read-only', async () => {
    let exported = false;
    const { panel, state } = loadWithSelection({
      route: (call) => {
        if (call.url.endsWith('/label')) {
          exported = true;
          return { status: 409, body: { error: 'Review item already exported' } };
        }
        if (call.url === `/api/rag/review/items/${ITEM_A}` && exported) return { status: 200, body: item(ITEM_A, { status: 'exported' }) };
        return undefined;
      },
    });
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(panel.section.textContent).toContain('This case was exported to the test set. Its label can no longer be changed.');
    expect(panel.section.querySelector('[data-review-save]')).toBeNull();
    expect(panel.section.querySelector('[data-review-skip]')).toBeNull();
    expect(q(panel.section, 'textarea[data-review-expected]').disabled).toBe(true);
  });

  it('skips with status skipped and opens the next case', async () => {
    const panel = loadPanel();
    await openFirstCase(panel);
    q(panel.section, '[data-review-skip]').click();
    await flush();
    expect(labelCalls(panel)[0]).toMatchObject({ method: 'POST', body: { status: 'skipped' } });
    expect(panel.status.textContent).toContain('Case skipped. Next case opened.');
    expect(q(panel.section, '[data-review-question]').textContent).toBe('Where is the archive kept?');
  });

  it('returns to the queue after the last case is saved', async () => {
    const { panel, state } = loadWithSelection();
    await panel.init();
    await flush();
    panel.section.querySelectorAll('[data-review-open]')[1]!.click();
    await flush();
    check(q(panel.section, 'input[data-review-answerable="no"]'));
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    q(panel.section, '[data-review-save]').click();
    await flush();
    void state;
    expect(labelCalls(panel)).toHaveLength(1);
    expect(panel.status.textContent).toContain('Label saved. No more cases in this view.');
    expect(panel.section.querySelectorAll('tr[data-review-row]').length).toBeGreaterThan(0);
  });

  it('reports an unknown outcome when the save request throws and reloads the case', async () => {
    const { panel, state } = loadWithSelection({ route: (call) => (call.url.endsWith('/label') ? { status: 0, throws: true } : undefined) });
    await fillAnswerable(panel, state);
    check(q(panel.section, 'input[data-review-triage="kb_gap"]'));
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(panel.status.textContent).toContain('No answer from the server. The label may or may not be saved');
    expect(panel.calls.filter((c) => c.url === `/api/rag/review/items/${ITEM_A}`)).toHaveLength(2);
  });

  it('fills in a stored label', async () => {
    const stored = {
      answerable: true,
      category: 'exact_term',
      language: 'en',
      expected_answer: 'A signed form.',
      evidence: [{ chunk_id: CHUNK_1, document_id: DOC_A, document_name: 'document-a.pdf', section: '2.1', quote: 'signed form' }],
      triage: ['training', 'golden'],
      not_relevant_chunk_ids: [CHUNK_2],
      dictionary_terms: [],
      paraphrased_question: null,
      pii_checked: true,
      confirm_near_duplicate_of: null,
    };
    const panel = loadPanel({ route: (call) => (call.url === `/api/rag/review/items/${ITEM_A}` ? { status: 200, body: item(ITEM_A, { status: 'labelled', label: stored, triage: stored.triage }) } : undefined) });
    await openFirstCase(panel);
    expect(q(panel.section, 'input[data-review-answerable="yes"]').checked).toBe(true);
    expect(q(panel.section, 'textarea[data-review-expected]').value).toBe('A signed form.');
    expect(q(panel.section, 'select[data-review-category]').value).toBe('exact_term');
    expect(q(panel.section, 'input[data-review-triage="golden"]').checked).toBe(true);
    expect(q(panel.section, 'input[data-review-pii-confirm]').checked).toBe(true);
    expect(q(panel.section, 'textarea[data-review-quote-text]').value).toBe('signed form');
    expect(q(panel.section, '[data-review-quote-check]').textContent).toBe('Found word for word in the passage.');
    expect(q(panel.section, `input[data-review-not-relevant="${CHUNK_2}"]`).checked).toBe(true);
    q(panel.section, '[data-review-save]').click();
    await flush();
    expect(((labelCalls(panel)[0]!.body as Json).label as Json).triage).toEqual(['training', 'golden']);
  });

  it('asks before leaving a case with unsaved changes', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    q(panel.section, '[data-review-back]').click();
    const dialog = q(panel.section, 'dialog[data-review-discard]');
    expect(dialog.open).toBe(true);
    expect(panel.doc.activeElement?.hasAttribute('data-review-discard-keep')).toBe(true);
    q(dialog, '[data-review-discard-keep]').click();
    expect(panel.section.querySelector('[data-review-question]')).not.toBeNull();
    q(panel.section, '[data-review-back]').click();
    q(panel.section, '[data-review-discard-confirm]').click();
    await flush();
    expect(panel.section.querySelectorAll('tr[data-review-row]')).toHaveLength(2);
  });

  it('offers no control to delete, export or change the split of a case', async () => {
    const { panel, state } = loadWithSelection();
    await fillAnswerable(panel, state);
    for (const button of panel.section.querySelectorAll('button')) expect(button.textContent).not.toMatch(/delete|export|split/i);
    const source = fs.readFileSync(PANEL_FILE, 'utf8');
    expect(source).not.toMatch(/method:\s*'DELETE'/);
    expect(source).not.toMatch(/['"]split['"]\s*:/);
  });

  it('renders markup in quotes and stored labels as text (XSS)', async () => {
    const payload = `${XSS_PAYLOAD}<script>PWNED(3)</script>`;
    const stored = {
      answerable: false,
      category: 'no_answer',
      language: 'en',
      expected_answer: null,
      triage: ['dictionary', 'golden'],
      dictionary_terms: [{ observed_term: payload, canonical_term: payload, relation: 'synonym', canonical_language: null }],
      paraphrased_question: payload,
      pii_checked: true,
      confirm_near_duplicate_of: null,
    };
    const panel = loadPanel({ route: (call) => (call.url === `/api/rag/review/items/${ITEM_A}` ? { status: 200, body: item(ITEM_A, { query_masked: payload, label: stored, status: 'labelled' }) } : undefined) });
    await openFirstCase(panel);
    expect(q(panel.section, 'input[data-review-term-observed]').value).toBe(payload);
    expect(q(panel.section, 'textarea[data-review-paraphrase]').value).toBe(payload);
    expect(injectedElements(panel.doc)).toEqual([]);
    expect(panel.doc.created).not.toContain('script');
    expect(panel.doc.innerHtmlWrites).toBe(0);
  });
});

describe('review-labelling.js: quote normalisation', () => {
  it('equals the Python normalize_text result on every shared fixture string', () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/feedback-loop/normalize-quotes.json'), 'utf8')) as {
      cases: Array<{ input: string; expected: string }>;
    };
    const mod = require(PANEL_FILE) as { reviewLabellingNormalize: (text: string) => string };
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
    for (const entry of fixture.cases) expect(mod.reviewLabellingNormalize(entry.input)).toBe(entry.expected);
  });
});

describe('review-labelling.js: bodies the label route accepts', () => {
  it('every label the form sends passes the server LabelRequestSchema', async () => {
    const { LabelRequestSchema } = await import('@/lib/rag/feedback-loop/labels');
    const mod = require(PANEL_FILE) as {
      reviewLabellingValidate: (form: unknown, quotes: unknown[], textFor: (q: unknown) => string | null) => { ok: boolean; label: unknown };
    };
    const quote = { chunkId: CHUNK_1, documentId: DOC_A, documentName: 'document-a.pdf', section: '2.1', quote: 'signed form', text: PASSAGE_1 };
    const base = {
      answerable: true,
      expected: 'A signed form.',
      category: 'general',
      language: 'en',
      triage: new Set(['training']),
      terms: [{ observed: 'form B', canonical: 'form', relation: 'translation', language: 'it' }],
      piiConfirmed: false,
      paraphrase: '',
      dup: '',
      notRelevant: new Set([CHUNK_2]),
    };
    const forms = [
      base,
      { ...base, triage: new Set(['dictionary', 'golden']), piiConfirmed: true, dup: 'golden-item-007' },
      { ...base, triage: new Set(['golden']), paraphrase: 'Rewritten question?' },
      { ...base, answerable: false, category: 'no_answer', expected: '', triage: new Set(['kb_gap', 'not_a_failure']) },
    ];
    for (const form of forms) {
      const result = mod.reviewLabellingValidate(form, form.answerable ? [quote] : [], (q) => (q as { text: string }).text);
      expect(result.ok).toBe(true);
      const parsed = LabelRequestSchema.safeParse(JSON.parse(JSON.stringify({ status: 'labelled', label: result.label })));
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.errors)).toBe(true);
    }
    expect(LabelRequestSchema.safeParse({ status: 'skipped' }).success).toBe(true);
  });
});

describe('review-labelling.js: selection capture', () => {
  it('remembers a selection reported by selectionchange inside one passage', async () => {
    const { panel, state } = loadWithSelection();
    await openFirstCase(panel);
    const passage = panel.section.querySelectorAll('article[data-review-passage]')[1]!;
    const node = q(passage, '[data-review-passage-text]').childNodes[0];
    state.sel = { toString: () => 'the archive', anchorNode: node, focusNode: node };
    panel.doc.dispatch('selectionchange');
    state.sel = { toString: () => '', anchorNode: null, focusNode: null };
    panel.doc.dispatch('selectionchange');
    q(passage, '[data-review-add-quote]').click();
    expect(q(panel.section, 'textarea[data-review-quote-text]').value).toBe('the archive');
  });
});

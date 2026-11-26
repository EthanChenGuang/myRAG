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
          ? { status: 200, body: { item_id: ITEM_A, chunks: [{ chunk_id: CHUNK_1, document_id: DOC_A, available: false }, chunksBody().chunks[1]] } }
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

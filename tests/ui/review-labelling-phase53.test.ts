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
const CHUNK_1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const TENANT = 'o:99999999-9999-4999-8999-999999999999';
const ANSWER = 'The sample component has two parts.';

const EN = {
  representative: 'Weekly sample',
  reReview: 'Due for re-review',
  historical: 'Imported question',
  pilot: 'Pilot user',
  driftFill: 'Under-covered topic group',
  noAnswer: 'No answer is recorded for this question, so there is nothing to check. Use the search to find the evidence for your label.',
  incomplete: 'Answer all three questions before saving.',
  saved: 'Answer check saved.',
  notAllowed: 'Not saved. You are not an expert for this workspace. Ask an admin for access.',
  gone: 'Not saved. This item is no longer in the queue. The list has been reloaded.',
  exported: 'This case was exported to the test set. Its label can no longer be changed.',
};

function item(id: string, extra: Json = {}): Json {
  return {
    id,
    tenant_key: TENANT,
    trace_id: null,
    query_masked: 'Which parts does the sample component have?',
    query_language: 'en',
    answer_language: 'en',
    chunk_languages: ['en'],
    channel: 'chat',
    outcome: 'answered',
    candidates: [{ chunk_id: CHUNK_1, document_id: DOC_A, rank: 1, similarity: 0.5, kept: true, language: 'en' }],
    retrieval_config_hash: null,
    reasons: ['low_score'],
    occurrences: 1,
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
    source: null,
    ...extra,
  };
}

const EMPTY_CHECK = { supported: null, relevant: null, unsupported_content: null, labelled_at: null };

function defaultRoute(call: RagCall): Reply | undefined {
  if (call.url.startsWith('/api/rag/review/items?') || call.url === '/api/rag/review/items') {
    return {
      status: 200,
      body: {
        items: [item(ITEM_A, { reasons: ['representative'], source: 'pilot' }), item(ITEM_B, { reasons: ['re_review'], source: null })],
        next_cursor: null,
      },
    };
  }
  if (call.url === `/api/rag/review/items/${ITEM_A}`) return { status: 200, body: item(ITEM_A, { answer_masked: ANSWER, reasons: ['representative'], source: 'pilot' }) };
  if (call.url === `/api/rag/review/items/${ITEM_B}`) return { status: 200, body: item(ITEM_B) };
  if (call.url.endsWith('/chunks')) {
    return { status: 200, body: { item_id: ITEM_A, chunks: [{ chunk_id: CHUNK_1, document_id: DOC_A, available: true, document_name: 'document-a.pdf', section: '1', text: 'The sample component has two parts.' }] } };
  }
  if (call.url.endsWith('/answer-check') && call.method === 'GET') return { status: 200, body: EMPTY_CHECK };
  if (call.url.endsWith('/answer-check') && call.method === 'POST') return { status: 200, body: { ...(call.body as Json), labelled_at: '2026-11-25T14:02:00Z' } };
  return undefined;
}

function loadPanel(options: { route?: Route; locale?: string } = {}) {
  const doc = new FakeDocument();
  const calls: RagCall[] = [];
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  doc.body.appendChild(tab);
  const section = doc.createElement('section');
  section.id = 'rag-administration-review';
  tab.appendChild(section);
  const title = doc.createElement('h3');
  title.setAttribute('tabindex', '-1');
  title.setAttribute('data-review-title', '');
  section.appendChild(title);
  for (const name of ['data-review-description', 'data-review-alert', 'data-review-content']) {
    const el = doc.createElement('div');
    el.setAttribute(name, '');
    section.appendChild(el);
  }
  const status = doc.createElement('div');
  status.setAttribute('data-review-status', '');
  status.setAttribute('role', 'status');
  section.appendChild(status);

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
    getSelection: () => null,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/review-labelling.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const init = () => (context.initReviewLabellingPanel as () => Promise<unknown>)();
  return { doc, section, calls, init, status };
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

async function open(panel: ReturnType<typeof loadPanel>, id = ITEM_A): Promise<void> {
  await panel.init();
  await flush();
  q(panel.section, `[data-review-open="${id}"]`).click();
  await flush();
}

function badgeTexts(root: FakeElement): string[] {
  return root.querySelectorAll('.badge').map((el) => el.textContent.trim());
}

describe('review-labelling.js Phase 5.3: reason and source tags (UI-SPEC 6.11, 12.7)', () => {
  it('shows Weekly sample then Pilot user as outline badges, and Due for re-review', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    const [rowA, rowB] = panel.section.querySelectorAll('tr[data-review-row]');
    const badgesA = rowA!.querySelectorAll('.badge');
    const textsA = badgeTexts(rowA!);
    expect(textsA).toContain(EN.representative);
    expect(textsA.indexOf(EN.representative)).toBeLessThan(textsA.indexOf(EN.pilot));
    for (const badge of badgesA.filter((b) => [EN.representative, EN.pilot].includes(b.textContent.trim()))) {
      expect(badge.className).toContain('badge-outline');
      expect(badge.className).toContain('badge-sm');
    }
    expect(rowB!.textContent).toContain(EN.reReview);
  });

  it('shows the reasons, then the source, in the head of the item view', async () => {
    const panel = loadPanel();
    await open(panel);
    const texts = badgeTexts(panel.section);
    expect(texts.indexOf(EN.representative)).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf(EN.representative)).toBeLessThan(texts.indexOf(EN.pilot));
  });

  it('labels every source', async () => {
    const sources = { historical: EN.historical, pilot: EN.pilot, drift_fill: EN.driftFill, representative: EN.representative };
    for (const [source, text] of Object.entries(sources)) {
      const panel = loadPanel({
        route: (call) => (call.url.startsWith('/api/rag/review/items?') ? { status: 200, body: { items: [item(ITEM_A, { reasons: [], source })], next_cursor: null } } : undefined),
      });
      await panel.init();
      await flush();
      expect(badgeTexts(q(panel.section, 'tr[data-review-row]'))).toContain(text);
    }
  });

  it('renders an unknown reason or source code in code inside a sentence, and markup in it creates no element', async () => {
    const payload = `${XSS_PAYLOAD}<script>PWNED(2)</script>`;
    const panel = loadPanel({
      route: (call) =>
        call.url.startsWith('/api/rag/review/items?') ? { status: 200, body: { items: [item(ITEM_A, { reasons: [payload], source: `x${payload}` })], next_cursor: null } } : undefined,
    });
    await panel.init();
    await flush();
    const codes = panel.section.querySelectorAll('tr[data-review-row] code');
    expect(codes.map((c) => c.textContent)).toEqual([payload, `x${payload}`]);
    for (const code of codes) expect(code.parentNode!.textContent.length).toBeGreaterThan(code.textContent.length);
    expect(injectedElements(panel.doc)).toEqual([]);
    expect(panel.doc.created).not.toContain('script');
    expect(panel.doc.created).not.toContain('img');
  });
});

describe('review-labelling.js Phase 5.3: reason filter values', () => {
  it('offers the two new reasons and Imported question; Imported question filters on source historical', async () => {
    const panel = loadPanel();
    await panel.init();
    await flush();
    const select = q(panel.section, 'select[data-review-filter="reason"]');
    const labels = select.querySelectorAll('option').map((o) => o.textContent);
    for (const text of [EN.representative, EN.reReview, EN.historical]) expect(labels).toContain(text);
    const values = select.querySelectorAll('option').map((o) => o.getAttribute('value'));
    expect(values).toContain('representative');
    expect(values).toContain('re_review');
    change(select, 're_review');
    await flush();
    expect(panel.calls.at(-1)!.url).toBe('/api/rag/review/items?status=open&reason=re_review');
    const imported = select.querySelectorAll('option').find((o) => o.textContent === EN.historical)!;
    change(q(panel.section, 'select[data-review-filter="reason"]'), imported.getAttribute('value')!);
    await flush();
    expect(panel.calls.at(-1)!.url).toBe('/api/rag/review/items?status=open&source=historical');
  });
});

describe('review-labelling.js Phase 5.3: imported question without an answer', () => {
  it('shows item.noAnswer in muted text in place of the answer and the candidates, keeps the search and renders no answer check', async () => {
    const panel = loadPanel({
      route: (call) => {
        if (call.url.startsWith('/api/rag/review/items?')) return { status: 200, body: { items: [item(ITEM_A, { source: 'historical', candidates: [] })], next_cursor: null } };
        if (call.url === `/api/rag/review/items/${ITEM_A}`) return { status: 200, body: item(ITEM_A, { source: 'historical', reasons: ['representative'], answer_masked: null }) };
        return undefined;
      },
    });
    await open(panel);
    const note = q(panel.section, '[data-review-no-answer]');
    expect(note.textContent).toBe(EN.noAnswer);
    expect(note.className).toContain('text-sm');
    expect(note.className).toContain('text-base-content/70');
    expect(panel.section.querySelector('[data-review-answer]')).toBeNull();
    expect(panel.section.querySelector('article[data-review-passage]')).toBeNull();
    expect(panel.section.querySelector('form[data-review-search]')).not.toBeNull();
    expect(panel.section.querySelector('[data-review-check]')).toBeNull();
    expect(panel.calls.some((c) => c.url.endsWith('/answer-check'))).toBe(false);
  });
});

describe('review-labelling.js Phase 5.3: label tables', () => {
  it('has the new labels in en, zh and it, with the UI-SPEC 12.7 wording', () => {
    const mod = require(PANEL_FILE) as { REVIEW_LABELLING_LABELS: Record<string, Record<string, string>> };
    const t = mod.REVIEW_LABELLING_LABELS;
    expect(t.en!['tag.representative']).toBe(EN.representative);
    expect(t.zh!['tag.re_review']).toBe('需要复审');
    expect(t.it!['tag.drift_fill']).toBe('Gruppo di argomenti poco coperto');
    for (const key of ['tag.representative', 'tag.re_review', 'tag.historical', 'tag.pilot', 'tag.drift_fill', 'item.noAnswerImported', 'source.unknown']) {
      for (const locale of ['en', 'zh', 'it']) expect(t[locale]![key], `${locale} ${key}`).toBeTruthy();
    }
  });
});

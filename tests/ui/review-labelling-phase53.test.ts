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

const FIELDS = ['supported', 'relevant', 'unsupported_content'] as const;

function radio(panel: ReturnType<typeof loadPanel>, field: string, value: boolean): FakeElement {
  return q(panel.section, `input[data-review-check-field="${field}"][value="${value}"]`);
}

function pick(el: FakeElement): void {
  el.checked = true;
  el.dispatch('change');
}

function checkPosts(panel: ReturnType<typeof loadPanel>) {
  return panel.calls.filter((c) => c.url.endsWith('/answer-check') && c.method === 'POST');
}

describe('review-labelling.js Phase 5.3: answer check (D-31, UI-SPEC 6.11)', () => {
  it('sits directly under the masked answer: heading, help line, three fieldsets of two radios, none selected', async () => {
    const panel = loadPanel();
    await open(panel);
    expect(panel.calls.some((c) => c.url === `/api/rag/review/items/${ITEM_A}/answer-check` && c.method === 'GET')).toBe(true);
    const answer = q(panel.section, '[data-review-answer]');
    const host = q(panel.section, '[data-review-check]');
    const siblings = answer.parentNode!.childNodes;
    expect(siblings.indexOf(host)).toBe(siblings.indexOf(answer) + 1);
    expect(q(host, 'h4').textContent).toBe('Answer check');
    expect(host.textContent).toContain('Your three answers are compared with the model judges');
    const fieldsets = host.querySelectorAll('fieldset');
    expect(fieldsets).toHaveLength(3);
    expect(fieldsets.map((f) => q(f, 'legend').textContent)).toEqual([
      'Is the answer backed by the documents shown?',
      'Does the answer address the question?',
      'Does it contain any statement the documents do not back, even a minor one?',
    ]);
    for (const fieldset of fieldsets) {
      const radios = fieldset.querySelectorAll('input[type="radio"]');
      expect(radios).toHaveLength(2);
      for (const r of radios) expect(r.checked).toBe(false);
    }
    expect(host.textContent).toContain('Choose Supported when the main statements are backed.');
    const save = q(host, '[data-review-save-check]');
    expect(save.textContent).toBe('Save answer check');
    expect(save.disabled).toBe(false);
  });

  it('with a group unanswered shows check.incomplete, focuses the first radio of that group and sends nothing', async () => {
    const panel = loadPanel();
    await open(panel);
    pick(radio(panel, 'supported', true));
    pick(radio(panel, 'unsupported_content', false));
    q(panel.section, '[data-review-save-check]').click();
    await flush();
    const status = q(panel.section, '[data-review-check-status]');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe(EN.incomplete);
    expect(panel.doc.activeElement).toBe(q(panel.section, 'fieldset[data-review-check-group="relevant"] input[type="radio"]'));
    expect(checkPosts(panel)).toEqual([]);
  });

  it('posts exactly the three verdicts and shows check.saved with the saved time', async () => {
    const panel = loadPanel();
    await open(panel);
    pick(radio(panel, 'supported', true));
    pick(radio(panel, 'relevant', false));
    pick(radio(panel, 'unsupported_content', true));
    q(panel.section, '[data-review-save-check]').click();
    await flush();
    expect(checkPosts(panel).map((c) => c.body)).toEqual([{ supported: true, relevant: false, unsupported_content: true }]);
    const status = q(panel.section, '[data-review-check-status]');
    expect(status.textContent).toContain(EN.saved);
    expect(q(panel.section, '[data-review-check] time').getAttribute('datetime')).toBe('2026-11-25T14:02:00Z');
    expect(q(panel.section, '[data-review-check]').textContent).toContain('Last saved');
    expect(panel.calls.some((c) => c.url.endsWith('/label'))).toBe(false);
  });

  it('shows a saved check selected when the item is opened again, without any judge score', async () => {
    const panel = loadPanel({
      route: (call) =>
        call.url.endsWith('/answer-check') && call.method === 'GET'
          ? { status: 200, body: { supported: false, relevant: true, unsupported_content: false, labelled_at: '2026-11-24T09:00:00Z', judge_score: 0.987654 } }
          : undefined,
    });
    await open(panel);
    expect(radio(panel, 'supported', false).checked).toBe(true);
    expect(radio(panel, 'supported', true).checked).toBe(false);
    expect(radio(panel, 'relevant', true).checked).toBe(true);
    expect(radio(panel, 'unsupported_content', false).checked).toBe(true);
    const host = q(panel.section, '[data-review-check]');
    expect(q(host, 'time').getAttribute('datetime')).toBe('2026-11-24T09:00:00Z');
    expect(host.textContent).not.toMatch(/0[.,]98|score|judge_score/i);
    pick(radio(panel, 'supported', true));
    q(panel.section, '[data-review-save-check]').click();
    await flush();
    const [post] = checkPosts(panel);
    expect(Object.keys(post!.body as Json).sort()).toEqual([...FIELDS].sort());
  });

  it('maps 403 to check.notAllowed, 404 to check.gone with a list reload, and 409 to the already-exported message', async () => {
    for (const [statusCode, text] of [
      [403, EN.notAllowed],
      [404, EN.gone],
      [409, EN.exported],
    ] as const) {
      const panel = loadPanel({
        route: (call) => (call.url.endsWith('/answer-check') && call.method === 'POST' ? { status: statusCode, body: { error: 'x' } } : undefined),
      });
      await open(panel);
      for (const field of FIELDS) pick(radio(panel, field, true));
      const listCalls = panel.calls.filter((c) => c.url.startsWith('/api/rag/review/items?')).length;
      q(panel.section, '[data-review-save-check]').click();
      await flush();
      expect(panel.section.textContent + panel.status.textContent, String(statusCode)).toContain(text);
      if (statusCode === 404) {
        expect(panel.calls.filter((c) => c.url.startsWith('/api/rag/review/items?')).length).toBe(listCalls + 1);
        expect(panel.section.querySelector('tr[data-review-row]')).not.toBeNull();
      }
    }
  });

  it('localizes the answer check for zh and it', async () => {
    const zh = loadPanel({ locale: 'zh-CN' });
    await open(zh);
    expect(q(zh.section, '[data-review-check] h4').textContent).toBe('回答检查');
    expect(q(zh.section, '[data-review-save-check]').textContent).toBe('保存回答检查');
    const itPanel = loadPanel({ locale: 'it-IT' });
    await open(itPanel);
    expect(q(itPanel.section, '[data-review-check] h4').textContent).toBe('Verifica della risposta');
    expect(q(itPanel.section, '[data-review-save-check]').textContent).toBe('Salva verifica della risposta');
  });
});

describe('review-labelling.js Phase 5.3: answer check edge cases', () => {
  it('removes the answer check when the route says the item has no answer (409), and sends nothing', async () => {
    const panel = loadPanel({
      route: (call) => (call.url.endsWith('/answer-check') && call.method === 'GET' ? { status: 409, body: { error: 'no_answer' } } : undefined),
    });
    await open(panel);
    expect(panel.section.querySelector('[data-review-check]')).toBeNull();
    expect(q(panel.section, '[data-review-answer]').textContent).toBe(ANSWER);
    expect(checkPosts(panel)).toEqual([]);
  });

  it('locks the answer check of an exported item', async () => {
    const panel = loadPanel({
      route: (call) => (call.url === `/api/rag/review/items/${ITEM_A}` ? { status: 200, body: item(ITEM_A, { answer_masked: ANSWER, status: 'exported' }) } : undefined),
    });
    await open(panel);
    expect(q(panel.section, '[data-review-save-check]').disabled).toBe(true);
    for (const field of FIELDS) expect(radio(panel, field, true).disabled).toBe(true);
  });

  it('renders markup in the saved time and the masked answer as text', async () => {
    const payload = `${XSS_PAYLOAD}<script>PWNED(3)</script>`;
    const panel = loadPanel({
      route: (call) => {
        if (call.url === `/api/rag/review/items/${ITEM_A}`) return { status: 200, body: item(ITEM_A, { answer_masked: payload }) };
        if (call.url.endsWith('/answer-check')) return { status: 200, body: { supported: true, relevant: true, unsupported_content: false, labelled_at: payload } };
        return undefined;
      },
    });
    await open(panel);
    expect(q(panel.section, '[data-review-check] time').textContent).toBe(payload);
    expect(injectedElements(panel.doc)).toEqual([]);
    expect(panel.doc.created).not.toContain('script');
    expect(panel.doc.innerHtmlWrites).toBe(0);
  });
});

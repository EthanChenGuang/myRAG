import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement } from './helpers/html-fake-dom';
import { markedBlock } from './helpers/ingest-impact-harness';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const mod = require('../../scripts/config-ui/rag-panels/versions-dates.js');

type Json = Record<string, unknown>;
type Route = 'list' | 'confirm' | 'dismiss' | 'undo' | 'dates' | 'setDates' | 'dismissDates';
interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}
interface RagCall {
  route: Route | 'unknown';
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}

const XSS = '<img src=x onerror=alert(1)>';
const ORG = 'c0000000-0000-4000-8000-000000000001';
const TENANT_KEY = 'o:c0000000-0000-4000-8000-000000000001';

function isoDay(offsetDays: number): string {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays));
  return day.toISOString().slice(0, 10);
}

function docView(n: number, extra: Json = {}): Json {
  return {
    id: `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    file_name: `report-${2020 + n}.pdf`,
    doc_type: 'general',
    document_date: `${2020 + n}-03-01`,
    effective_from: `${2020 + n}-04-01`,
    effective_to: null,
    uploaded_at: '2026-11-20T09:30:00.000Z',
    uploader: { id: 'u-1', display: 'member@example.test' },
    ...extra,
  };
}

function candidate(n: number, extra: Json = {}): Json {
  return {
    kind: 'candidate',
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    origin: 'detected',
    direction: 'document_newer',
    stale: false,
    signals: { title_match: true, content_overlap_percent: 73, conflicting_numbers: 5 },
    document: docView(5),
    candidate_document: docView(4),
    created_at: '2026-11-21T10:00:00.000Z',
    tenant_key: TENANT_KEY,
    run_id: 'run-hidden-1',
    ...extra,
  };
}

function link(n: number, extra: Json = {}): Json {
  return {
    kind: 'link',
    id: `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    link_id: `l0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    origin: 'uploader',
    older_document: docView(1),
    newer_document: docView(2),
    decided_at: '2026-11-22T08:15:00.000Z',
    decided_by: { id: 'u-2', display: 'admin@example.test' },
    ...extra,
  };
}

function listAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, detect: 'on', total: items.length, limit: 50, offset: 0, items, ...extra };
}

function dateItem(n: number, extra: Json = {}): Json {
  return {
    id: `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    lineage_id: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    file_name: `notice-${n}.pdf`,
    version: 1,
    status: 'ready',
    effective_from: null,
    effective_to: null,
    origin: null,
    confidence: null,
    proposal: {
      from: isoDay(30),
      to: null,
      confidence: 0.86,
      evidence_quote: 'This notice applies from the first day of next month.',
      awaiting: true,
      proposed_at: '2026-11-20T09:30:00.000Z',
    },
    ...extra,
  };
}

function datesAnswer(items: Json[], extra: Json = {}): Json {
  return { success: true, total: items.length, limit: 50, offset: 0, query: null, items, ...extra };
}

const SUP = '/api/rag/admin/supersession';
const DATES = '/api/rag/admin/effective-dates';

function routeOf(apiPath: string, method: string): Route | 'unknown' {
  const p = apiPath.split('?')[0]!;
  if (p === SUP && method === 'GET') return 'list';
  if (/^\/api\/rag\/admin\/supersession\/[^/]+\/confirm$/.test(p) && method === 'POST') return 'confirm';
  if (/^\/api\/rag\/admin\/supersession\/[^/]+\/dismiss$/.test(p) && method === 'POST') return 'dismiss';
  if (/^\/api\/rag\/admin\/supersession\/[^/]+\/undo$/.test(p) && method === 'POST') return 'undo';
  if (p === DATES && method === 'GET') return 'dates';
  if (/^\/api\/rag\/admin\/effective-dates\/[^/]+$/.test(p) && method === 'PUT') return 'setDates';
  if (/^\/api\/rag\/admin\/effective-dates\/[^/]+\/dismiss$/.test(p) && method === 'POST') return 'dismissDates';
  return 'unknown';
}

function defaultReply(call: RagCall): Reply {
  switch (call.route) {
    case 'list':
      return { status: 200, body: listAnswer([candidate(1), link(1)]) };
    case 'confirm':
      return { status: 200, body: { success: true, outcome: 'confirmed' } };
    case 'dismiss':
      return { status: 200, body: { success: true, outcome: 'dismissed' } };
    case 'undo':
      return { status: 200, body: { success: true, outcome: 'undone' } };
    case 'dates':
      return { status: 200, body: datesAnswer([dateItem(1)]) };
    case 'setDates':
      return { status: 200, body: { success: true, origin: 'admin', ...(call.body as Json) } };
    case 'dismissDates':
      return { status: 200, body: { success: true, outcome: 'dismissed' } };
    default:
      return { status: 500 };
  }
}

interface HarnessOptions {
  locale?: string;
  replies?: Partial<Record<Route, Reply | ((call: RagCall) => Reply)>>;
  detect?: string;
  effectiveDates?: string;
  pipeline?: string;
  ingestPipeline?: string;
}

function addSelect(doc: FakeDocument, id: string, value: string): FakeElement {
  const select = doc.createElement('select');
  select.id = id;
  select.value = value;
  doc.body.appendChild(select);
  return select;
}

function loadPage(options: HarnessOptions = {}) {
  const doc = new FakeDocument();
  const ragCalls: RagCall[] = [];
  addSelect(doc, 'RAG_PIPELINE', options.pipeline ?? 'v2');
  addSelect(doc, 'RAG_INGEST_PIPELINE', options.ingestPipeline ?? 'unified');
  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  for (const [value, text] of [
    ['', 'Default Workspace'],
    [ORG, 'Workspace One'],
  ]) {
    const option = doc.createElement('option');
    option.setAttribute('value', value!);
    option.textContent = text!;
    selector.appendChild(option);
  }
  selector.value = ORG;
  doc.body.appendChild(selector);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  const settingsHolder = doc.createElement('div');
  tab.appendChild(settingsHolder);
  settingsHolder.innerHTML = markedBlock('rag-phase032-settings');
  doc.getElementById('RAG_SUPERSESSION_DETECT')!.value = options.detect ?? 'on';
  doc.getElementById('RAG_EFFECTIVE_DATES')!.value = options.effectiveDates ?? 'true';
  doc.getElementById('RAG_EFFECTIVE_DATE_LLM_EXTRACT')!.value = 'false';
  const holder = doc.createElement('div');
  tab.appendChild(holder);
  holder.innerHTML = markedBlock('rag-versions-dates');
  doc.innerHtmlWrites = 0;

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : init.body;
    const route = routeOf(apiPath, method);
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const call: RagCall = { route, path: apiPath, method, query, body };
    ragCalls.push(call);
    if (route === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const custom = options.replies?.[route];
    const reply = typeof custom === 'function' ? custom(call) : (custom ?? defaultReply(call));
    if (reply.throws) throw new TypeError('Failed to fetch');
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body)) };
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
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/versions-dates.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-versions') as FakeElement;
  return {
    doc,
    root,
    ragCalls,
    calls: (route: Route) => ragCalls.filter((c) => c.route === route),
    async init() {
      const init = context.initVersionsDatesPanel as (() => Promise<void>) | undefined;
      if (typeof init !== 'function') throw new Error('initVersionsDatesPanel is not defined');
      await init();
      await flush();
    },
    dialog: () => doc.querySelectorAll('dialog').find((d) => d.open) ?? null,
    status: () => doc.querySelector('[data-versions-dates-status]') as FakeElement,
    alertHost: () => doc.querySelector('[data-versions-dates-alert]') as FakeElement,
    tab: (id: 'candidates' | 'dates' | 'settings') => doc.getElementById(`rag-versions-dates-tab-${id}`) as FakeElement,
    panel: (id: 'candidates' | 'dates' | 'settings') => doc.getElementById(`rag-versions-dates-panel-${id}`) as FakeElement,
  };
}

async function flush(times = 25): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function button(root: FakeElement | null, text: string): FakeElement {
  const found = (root ? root.querySelectorAll('button') : []).find((b) => b.textContent.trim() === text);
  if (!found) throw new Error('no button ' + text);
  return found;
}

function hasButton(root: FakeElement | null, text: string): boolean {
  return (root ? root.querySelectorAll('button') : []).some((b) => b.textContent.trim() === text);
}

function noMarkup(doc: FakeDocument) {
  expect(doc.innerHtmlWrites).toBe(0);
  expect(doc.body.querySelectorAll('img')).toHaveLength(0);
  expect(doc.body.querySelectorAll('script')).toHaveLength(0);
  for (const el of doc.body.querySelectorAll('*')) {
    for (const name of el.attributes.keys()) expect(name.startsWith('on')).toBe(false);
  }
}

describe('index.html skeleton', () => {
  it('has the Versions and dates section after Document tags and its script after scope-tags.js', () => {
    expect(indexHtml).toContain('id="rag-administration-versions"');
    expect(indexHtml.indexOf('id="rag-administration-versions"')).toBeGreaterThan(indexHtml.indexOf('id="rag-administration-scopes"'));
    expect(indexHtml.indexOf('id="rag-administration-versions"')).toBeLessThan(indexHtml.indexOf('id="rag-administration-profiles"'));
    const script = indexHtml.indexOf('<script src="rag-panels/versions-dates.js"></script>');
    expect(script).toBeGreaterThan(indexHtml.indexOf('<script src="rag-panels/scope-tags.js"></script>'));
    expect(script).toBeGreaterThan(indexHtml.indexOf('<script src="rag-panels/rag-ui.js"></script>'));
    const block = markedBlock('rag-versions-dates');
    for (const attr of ['data-versions-dates-title', 'data-versions-dates-description', 'data-versions-dates-workspace', 'data-versions-dates-alert', 'data-versions-dates-content', 'data-versions-dates-status']) {
      expect(block).toContain(attr);
    }
    expect(block).toMatch(/role="status" aria-live="polite"/);
  });
});

describe('view-model builders', () => {
  it('maps a candidate with a direction to Older and Newer, sentences for the signals and no score', () => {
    const view = mod.versionsDatesCandidateView(candidate(1), 'en');
    expect(view.title).toBe('report-2024.pdf may be an older version of report-2025.pdf');
    expect(view.directed).toBe(true);
    expect(view.older.file).toBe('report-2024.pdf');
    expect(view.newer.file).toBe('report-2025.pdf');
    expect(view.signals.map((s: { key: string }) => s.key)).toEqual(['signal.title_match', 'signal.content_overlap']);
    const json = JSON.stringify(view);
    expect(json).not.toContain('73');
    expect(json).not.toContain('run-hidden-1');
    expect(json).not.toContain(TENANT_KEY);
  });

  it('candidate_newer puts the published document in the Older column', () => {
    const view = mod.versionsDatesCandidateView(candidate(1, { direction: 'candidate_newer' }), 'en');
    expect(view.older.file).toBe('report-2025.pdf');
    expect(view.newer.file).toBe('report-2024.pdf');
  });

  it('a candidate without a direction has two documents A and B and the unknown title', () => {
    const view = mod.versionsDatesCandidateView(candidate(1, { direction: null }), 'en');
    expect(view.directed).toBe(false);
    expect(view.title).toBe('report-2025.pdf and report-2024.pdf may be two versions of one document');
  });

  it('origin uploader adds the uploader sentence; an unknown origin becomes a code sentence', () => {
    const named = mod.versionsDatesCandidateView(candidate(1, { origin: 'uploader', signals: { title_match: false, content_overlap_percent: 0, conflicting_numbers: 0 } }), 'en');
    expect(named.signals.map((s: { key: string }) => s.key)).toEqual(['signal.uploader']);
    const other = mod.versionsDatesCandidateView(candidate(1, { origin: 'new_origin', signals: { title_match: false, content_overlap_percent: 0, conflicting_numbers: 0 } }), 'en');
    expect(other.origin).toBeNull();
    expect(other.signals).toEqual([{ key: 'signal.other', code: 'new_origin' }]);
  });

  it('computes the effect of a window from today (inclusive bounds)', () => {
    const today = '2026-11-26';
    expect(mod.versionsDatesEffect('2026-12-01', null, today)).toEqual({ key: 'effect.future', date: '2026-12-01', hides: true });
    expect(mod.versionsDatesEffect(null, '2026-11-25', today)).toEqual({ key: 'effect.expired', date: '2026-11-25', hides: true });
    expect(mod.versionsDatesEffect('2026-11-26', '2026-11-26', today)).toEqual({ key: 'effect.inForce', date: null, hides: false });
    expect(mod.versionsDatesEffect(null, '2027-01-01', today)).toEqual({ key: 'effect.inForce', date: null, hides: false });
    expect(mod.versionsDatesEffect('2026-01-01', null, today)).toEqual({ key: 'effect.inForce', date: null, hides: false });
    expect(mod.versionsDatesEffect(null, null, today)).toEqual({ key: 'effect.open', date: null, hides: false });
  });

  it('a date row shows the proposed window when a proposal waits, and the stored window otherwise', () => {
    const proposed = mod.versionsDatesDateRowView(dateItem(1), '2026-11-26');
    expect(proposed.awaiting).toBe(true);
    expect(proposed.window.from).toBe(dateItem(1).proposal && (dateItem(1).proposal as Json).from);
    expect(proposed.confidence).toBe(0.86);
    expect(proposed.quote).toBe('This notice applies from the first day of next month.');
    const stored = mod.versionsDatesDateRowView(dateItem(2, { proposal: null, effective_from: '2026-01-01', effective_to: '2026-06-30', origin: 'admin' }), '2026-11-26');
    expect(stored.awaiting).toBe(false);
    expect(stored.window).toEqual({ from: '2026-01-01', to: '2026-06-30' });
    expect(stored.effect.key).toBe('effect.expired');
    expect(stored.origin).toBe('admin');
    expect(stored.confidence).toBeNull();
  });

  it('settings warnings: detection needs the unified pipeline, dates need v2', () => {
    expect(mod.versionsDatesSettingsWarnings({ RAG_SUPERSESSION_DETECT: 'on', RAG_INGEST_PIPELINE: 'legacy', RAG_EFFECTIVE_DATES: 'false', RAG_PIPELINE: 'legacy' })).toEqual(['warn.needsUnified']);
    expect(mod.versionsDatesSettingsWarnings({ RAG_SUPERSESSION_DETECT: 'off', RAG_INGEST_PIPELINE: 'legacy', RAG_EFFECTIVE_DATES: 'true', RAG_PIPELINE: 'legacy' })).toEqual(['warn.datesNeedV2']);
    expect(mod.versionsDatesSettingsWarnings({ RAG_SUPERSESSION_DETECT: 'on', RAG_INGEST_PIPELINE: 'unified', RAG_EFFECTIVE_DATES: 'true', RAG_PIPELINE: 'v2' })).toEqual([]);
  });

  it('labels have the same keys in en, zh and it', () => {
    const keys = (l: string) => Object.keys(mod.VERSIONS_DATES_LABELS[l]).sort();
    expect(keys('zh')).toEqual(keys('en'));
    expect(keys('it')).toEqual(keys('en'));
  });
});

describe('Possible older versions', () => {
  it('renders a candidate block: title, hold line, origin and signals, the comparison and two actions', async () => {
    const page = loadPage();
    await page.init();
    const panel = page.panel('candidates');
    const article = panel.querySelector('article')!;
    expect(article).toBeTruthy();
    expect(article.querySelector('h4')!.textContent).toBe('report-2024.pdf may be an older version of report-2025.pdf');
    const text = article.textContent;
    expect(text).toContain('Both in use');
    expect(text).toContain('Both documents answer questions until you decide.');
    expect(text).toContain('Detected');
    expect(text).toContain('The titles are the same apart from a year or version mark.');
    expect(text).toContain('Most of the content is the same, with different numbers.');
    const headers = article.querySelectorAll('h5').map((h) => h.textContent.trim());
    expect(headers).toEqual(['Older', 'Newer']);
    for (const row of ['File', 'Document type', 'Document date', 'Effective', 'Uploaded']) expect(text).toContain(row);
    expect(text).toContain('by member@example.test');
    const times = article.querySelectorAll('time').map((t) => t.getAttribute('datetime'));
    expect(times).toContain('2024-03-01');
    expect(times).toContain('2026-11-20T09:30:00.000Z');
    expect(hasButton(article, 'Confirm replacement')).toBe(true);
    expect(hasButton(article, 'Dismiss candidate')).toBe(true);
    expect(text).not.toContain('73');
    expect(text).not.toContain('run-hidden-1');
    expect(page.root.textContent).not.toContain(TENANT_KEY);
    expect(text).not.toContain('title_match');
    expect(page.tab('candidates').textContent).toBe('Possible older versions: 1');
    for (const call of page.ragCalls) expect(call.query.get('organizationId')).toBe(ORG);
  });

  it('Confirm replacement asks first, Keep both documents posts nothing, confirming posts and reloads', async () => {
    const page = loadPage();
    await page.init();
    const article = page.panel('candidates').querySelector('article')!;
    button(article, 'Confirm replacement').click();
    await flush();
    let dialog = page.dialog()!;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Replace report-2024.pdf with report-2025.pdf?');
    expect(dialog.textContent).toContain('report-2024.pdf stops being used for answers at once.');
    expect(page.calls('confirm')).toHaveLength(0);
    button(dialog, 'Keep both documents').click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.calls('confirm')).toHaveLength(0);

    const listsBefore = page.calls('list').length;
    button(page.panel('candidates').querySelector('article')!, 'Confirm replacement').click();
    await flush();
    dialog = page.dialog()!;
    button(dialog, 'Confirm replacement').click();
    await flush();
    const posts = page.calls('confirm');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path.split('?')[0]).toBe(`${SUP}/${candidate(1).id}/confirm`);
    expect(posts[0]!.query.get('organizationId')).toBe(ORG);
    expect(posts[0]!.body).toEqual({ olderDocumentId: docView(4).id });
    expect(page.calls('list').length).toBeGreaterThan(listsBefore);
    expect(page.status().textContent).toContain('report-2025.pdf now replaces report-2024.pdf.');
  });

  it('Dismiss candidate posts at once without a dialog', async () => {
    const page = loadPage();
    await page.init();
    button(page.panel('candidates').querySelector('article')!, 'Dismiss candidate').click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.calls('dismiss')).toHaveLength(1);
    expect(page.calls('dismiss')[0]!.path.split('?')[0]).toBe(`${SUP}/${candidate(1).id}/dismiss`);
    expect(page.status().textContent).toContain('Candidate dismissed. Both documents stay in use.');
  });

  it.each([
    [409, 'already_decided'],
    [404, 'Candidate not found'],
  ])('a %s %s on an action shows the item-changed sentence and reloads', async (status, error) => {
    const page = loadPage({ replies: { dismiss: { status, body: { success: false, error } } } });
    await page.init();
    const before = page.calls('list').length;
    button(page.panel('candidates').querySelector('article')!, 'Dismiss candidate').click();
    await flush();
    expect(page.status().textContent).toContain('This item was changed by someone else. The list has been reloaded.');
    expect(page.calls('list').length).toBeGreaterThan(before);
  });

  it('the confirmed list shows date, actor and Undo replacement behind a confirmation', async () => {
    const page = loadPage();
    await page.init();
    const details = page.panel('candidates').querySelector('details')!;
    expect(details.querySelector('summary')!.textContent).toBe('Confirmed replacements: 1');
    const row = details.querySelector('tbody tr')!;
    expect(row.textContent).toContain('report-2021.pdf');
    expect(row.textContent).toContain('report-2022.pdf');
    expect(row.textContent).toContain('by admin@example.test');
    expect(row.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-22T08:15:00.000Z');
    expect(row.textContent).not.toContain('u-2');
    button(row, 'Undo replacement').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('Undo the replacement of report-2021.pdf?');
    expect(page.calls('undo')).toHaveLength(0);
    button(dialog, 'Undo replacement').click();
    await flush();
    expect(page.calls('undo')).toHaveLength(1);
    expect(page.calls('undo')[0]!.path.split('?')[0]).toBe(`${SUP}/${link(1).id}/undo`);
    expect(page.status().textContent).toContain('Replacement undone. Both documents are in use.');
  });

  it('file names and uploader names containing markup create no element', async () => {
    const evil = (n: number) => docView(n, { file_name: XSS + n, uploader: { id: 'u', display: XSS }, doc_type: XSS });
    const page = loadPage({
      replies: {
        list: { status: 200, body: listAnswer([candidate(1, { document: evil(5), candidate_document: evil(4), origin: XSS }), link(1, { older_document: evil(1), decided_by: { id: 'x', display: XSS } })]) },
        dates: { status: 200, body: datesAnswer([dateItem(1, { file_name: XSS, proposal: { ...(dateItem(1).proposal as Json), evidence_quote: XSS + ' javascript:alert(1)' } })]) },
      },
    });
    await page.init();
    button(page.panel('candidates').querySelector('article')!, 'Confirm replacement').click();
    await flush();
    noMarkup(page.doc);
    expect(page.root.textContent).toContain(XSS);
    expect(page.doc.body.querySelectorAll('a')).toHaveLength(0);
    page.dialog()!.close('keep');
  });

  it('with no candidate the empty title and body show while the confirmed list still renders', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: listAnswer([link(1)]) } } });
    await page.init();
    const panel = page.panel('candidates');
    expect(panel.querySelector('article')).toBeNull();
    expect(panel.textContent).toContain('No possible older versions');
    expect(panel.textContent).toContain('When an upload looks like a newer version of a document that is still in use, both appear here for you to decide.');
    expect(panel.querySelector('details summary')!.textContent).toBe('Confirmed replacements: 1');
    expect(page.tab('candidates').textContent).toBe('Possible older versions: 0');
  });

  it('with detection off the detect-off line shows and uploader-named candidates are listed', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: listAnswer([candidate(1, { origin: 'uploader' })], { detect: 'off' }) } } });
    await page.init();
    const panel = page.panel('candidates');
    expect(panel.textContent).toContain('Automatic detection is off. Only replacements named at upload appear here.');
    expect(panel.querySelector('article')!.textContent).toContain('Named by the uploader');
  });

  it('a candidate without a direction shows Document A and B and needs a choice before Confirm replacement', async () => {
    const page = loadPage({ replies: { list: { status: 200, body: listAnswer([candidate(1, { direction: null })]) } } });
    await page.init();
    const article = page.panel('candidates').querySelector('article')!;
    expect(article.querySelectorAll('h5').map((h) => h.textContent.trim())).toEqual(['Document A', 'Document B']);
    const fieldset = article.querySelector('fieldset')!;
    expect(fieldset.querySelector('legend')!.textContent).toBe('Which document is the older one?');
    const radios = fieldset.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'radio');
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => r.hasAttribute('required'))).toBe(true);
    const confirm = button(article, 'Confirm replacement');
    expect(confirm.disabled).toBe(true);
    const reasonId = confirm.getAttribute('aria-describedby')!;
    expect(page.doc.getElementById(reasonId)!.textContent).toBe('Choose the older document first.');
    const second = radios[1]!;
    second.checked = true;
    second.dispatch('change');
    await flush();
    const enabled = button(page.panel('candidates').querySelector('article')!, 'Confirm replacement');
    expect(enabled.disabled).toBe(false);
    enabled.click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('Replace report-2024.pdf with report-2025.pdf?');
    button(dialog, 'Confirm replacement').click();
    await flush();
    expect(page.calls('confirm')[0]!.body).toEqual({ olderDocumentId: docView(4).id });
  });

  it('a 401 replaces the data views with the sign-in alert while Settings stays usable', async () => {
    const page = loadPage({ replies: { list: { status: 401 }, dates: { status: 401 } } });
    await page.init();
    expect(page.panel('candidates').textContent).toContain('Reload panel');
    expect(page.panel('candidates').querySelector('article')).toBeNull();
    expect(page.panel('settings').querySelector('#RAG_SUPERSESSION_DETECT')).toBeTruthy();
  });

  it('a 503 shows the unavailable sentence with Reload panel', async () => {
    const page = loadPage({ replies: { list: { status: 503, body: { error: 'Supersession administration is unavailable' } } } });
    await page.init();
    expect(page.alertHost().textContent).toContain('Versions and dates are unavailable right now. Select Reload panel in a moment.');
  });
});

describe('Effective dates', () => {
  async function openDates(options: HarnessOptions = {}) {
    const page = loadPage(options);
    await page.init();
    page.tab('dates').click();
    await flush();
    return page;
  }

  it('lists a proposal with from, to, confidence, the quote in the evidence block, the effect and the actions', async () => {
    const page = await openDates();
    expect(page.tab('dates').textContent).toBe('Effective dates: 1');
    const panel = page.panel('dates');
    const row = panel.querySelectorAll('tbody tr')[0]!;
    expect(row.querySelector('th')!.textContent).toContain('notice-1.pdf');
    expect(row.textContent).toContain('Dates to confirm');
    const from = isoDay(30);
    expect(row.querySelectorAll('time').map((t) => t.getAttribute('datetime'))).toContain(from);
    expect(row.textContent).toContain('—');
    expect(row.textContent).toContain('No end date');
    expect(row.textContent).toContain('86%');
    expect(row.textContent).toContain(`Not used until ${from}`);
    expect(hasButton(row, 'Apply dates')).toBe(true);
    expect(hasButton(row, 'Dismiss dates')).toBe(true);
    const figure = panel.querySelector('figure')!;
    expect(figure.className).toContain('border-base-300');
    expect(figure.querySelector('figcaption')!.textContent).toBe('Text the dates were read from');
    expect(figure.querySelector('pre')!.textContent).toBe('This notice applies from the first day of next month.');
    expect(panel.textContent).toContain("Dates are compared with today's date in UTC.");
  });

  it('Apply dates asks for confirmation when the dates would hide the document, then puts them', async () => {
    const page = await openDates();
    button(page.panel('dates'), 'Apply dates').click();
    await flush();
    const dialog = page.dialog()!;
    expect(dialog.textContent).toContain('Apply these dates to notice-1.pdf?');
    expect(dialog.textContent).toContain(`The document will not be used for answers until ${isoDay(30)}.`);
    expect(page.calls('setDates')).toHaveLength(0);
    button(dialog, 'Apply dates').click();
    await flush();
    const put = page.calls('setDates');
    expect(put).toHaveLength(1);
    expect(put[0]!.path.split('?')[0]).toBe(`${DATES}/${dateItem(1).id}`);
    expect(put[0]!.query.get('organizationId')).toBe(ORG);
    expect(put[0]!.body).toEqual({ from: isoDay(30), to: null });
    expect(page.status().textContent).toContain('Dates saved: notice-1.pdf.');
  });

  it('an expired window gets the expired sentence and the confirmation says it will no longer be used', async () => {
    const expired = dateItem(1, { proposal: { ...(dateItem(1).proposal as Json), from: null, to: isoDay(-3) } });
    const page = await openDates({ replies: { dates: { status: 200, body: datesAnswer([expired]) } } });
    const row = page.panel('dates').querySelectorAll('tbody tr')[0]!;
    expect(row.textContent).toContain(`Ended on ${isoDay(-3)}; kept as history, not used for answers`);
    expect(row.textContent).toContain('No start date');
    button(page.panel('dates'), 'Apply dates').click();
    await flush();
    expect(page.dialog()!.textContent).toContain(`The document ended on ${isoDay(-3)}. It will no longer be used for answers.`);
    page.dialog()!.close('keep');
  });

  it('Apply dates acts at once when the document stays in use', async () => {
    const inForce = dateItem(1, { proposal: { ...(dateItem(1).proposal as Json), from: isoDay(-10), to: isoDay(10), awaiting: true } });
    const page = await openDates({ replies: { dates: { status: 200, body: datesAnswer([inForce]) } } });
    expect(page.panel('dates').textContent).toContain('In force today');
    button(page.panel('dates'), 'Apply dates').click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.calls('setDates')[0]!.body).toEqual({ from: isoDay(-10), to: isoDay(10) });
  });

  it('Dismiss dates posts at once', async () => {
    const page = await openDates();
    button(page.panel('dates'), 'Dismiss dates').click();
    await flush();
    expect(page.dialog()).toBeNull();
    expect(page.calls('dismissDates')).toHaveLength(1);
    expect(page.calls('dismissDates')[0]!.path.split('?')[0]).toBe(`${DATES}/${dateItem(1).id}/dismiss`);
    expect(page.status().textContent).toContain('Dates dismissed: notice-1.pdf. The document stays in use.');
  });

  it('an evidence quote with markup stays text in the inert block', async () => {
    const page = await openDates({
      replies: { dates: { status: 200, body: datesAnswer([dateItem(1, { proposal: { ...(dateItem(1).proposal as Json), evidence_quote: XSS + ' javascript:alert(1) ‮' } })]) } },
    });
    const pre = page.panel('dates').querySelector('figure pre')!;
    expect(pre.textContent).toContain(XSS);
    expect(pre.textContent).toContain('[U+202E]');
    expect(pre.children).toHaveLength(0);
    noMarkup(page.doc);
    expect(page.doc.body.querySelectorAll('a')).toHaveLength(0);
  });

  it('with no date awaiting confirmation the empty sentences show', async () => {
    const page = await openDates({ replies: { dates: { status: 200, body: datesAnswer([]) } } });
    const panel = page.panel('dates');
    expect(panel.textContent).toContain('No dates to confirm');
    expect(panel.textContent).toContain("Extracted dates that would take a document out of today's answers wait here for your decision.");
    expect(page.tab('dates').textContent).toBe('Effective dates: 0');
  });

  it('the search finds documents by file name; a search without result shows the no-match sentence', async () => {
    const found = dateItem(7, { proposal: null, effective_from: '2026-01-01', effective_to: null, origin: 'admin' });
    const page = await openDates({
      replies: {
        dates: (call) =>
          call.query.get('query') === 'nothing'
            ? { status: 200, body: datesAnswer([], { query: 'nothing' }) }
            : call.query.get('query')
              ? { status: 200, body: datesAnswer([found], { query: call.query.get('query') }) }
              : { status: 200, body: datesAnswer([dateItem(1)]) },
      },
    });
    const panel = page.panel('dates');
    const all = panel.querySelectorAll('input').find((i) => i.getAttribute('type') === 'radio' && i.getAttribute('value') === 'all')!;
    all.checked = true;
    all.dispatch('change');
    await flush();
    expect(panel.textContent).toContain('Search by file name to find any document and set its dates.');
    const search = panel.querySelectorAll('input').find((i) => i.getAttribute('type') === 'search')!;
    expect(panel.querySelector(`label[for="${search.id}"]`)!.textContent).toBe('Search by file name');
    search.value = 'notice-7';
    search.dispatch('keydown', { key: 'Enter' });
    await flush();
    expect(page.calls('dates').at(-1)!.query.get('query')).toBe('notice-7');
    const row = panel.querySelectorAll('tbody tr')[0]!;
    expect(row.textContent).toContain('notice-7.pdf');
    expect(row.textContent).toContain('Set by an admin');
    expect(row.textContent).toContain('In force today');
    expect(hasButton(row, 'Edit dates')).toBe(true);
    expect(hasButton(row, 'Apply dates')).toBe(false);
    search.value = 'nothing';
    search.dispatch('keydown', { key: 'Enter' });
    await flush();
    expect(panel.textContent).toContain('No document matches this search.');
  });

  it('Edit dates opens two date inputs, refuses From after To, saves and allows clearing both', async () => {
    const page = await openDates();
    const panel = page.panel('dates');
    button(panel, 'Edit dates').click();
    await flush();
    const inputs = panel.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'date');
    expect(inputs).toHaveLength(2);
    const [from, to] = inputs as [FakeElement, FakeElement];
    expect(panel.querySelector(`label[for="${from.id}"]`)!.textContent).toBe('From');
    expect(panel.querySelector(`label[for="${to.id}"]`)!.textContent).toBe('To');
    from.value = '2026-12-10';
    from.dispatch('input');
    to.value = '2026-12-01';
    to.dispatch('input');
    await flush();
    expect(panel.textContent).toContain('“From” must not be later than “To”.');
    expect(button(panel, 'Save dates').disabled).toBe(true);
    expect(to.getAttribute('aria-invalid')).toBe('true');
    expect(to.getAttribute('min')).toBe('2026-12-10');
    to.value = '2026-12-31';
    to.dispatch('input');
    await flush();
    const save = button(panel, 'Save dates');
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    expect(page.calls('setDates').at(-1)!.body).toEqual({ from: '2026-12-10', to: '2026-12-31' });

    button(panel, 'Edit dates').click();
    await flush();
    const again = panel.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'date') as [FakeElement, FakeElement];
    again[0].value = '';
    again[0].dispatch('input');
    again[1].value = '';
    again[1].dispatch('input');
    await flush();
    button(panel, 'Save dates').click();
    await flush();
    expect(page.calls('setDates').at(-1)!.body).toEqual({ from: null, to: null });
  });

  it('Cancel editing closes the editor without a request and returns focus to Edit dates', async () => {
    const page = await openDates();
    const panel = page.panel('dates');
    button(panel, 'Edit dates').click();
    await flush();
    button(panel, 'Cancel editing').click();
    await flush();
    expect(panel.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'date')).toHaveLength(0);
    expect(page.calls('setDates')).toHaveLength(0);
    expect(page.doc.activeElement!.textContent).toBe('Edit dates');
  });

  it('every label a view can show exists in the panel table or the shared one', () => {
    const source = fs.readFileSync(path.join(configUiDir, 'rag-panels/versions-dates.js'), 'utf8');
    const keys = new Set([...source.matchAll(/this\.t\('([\w.]+)'/g)].map((m) => m[1]!));
    for (const origin of ['detected', 'uploader', 'answer_conflict']) keys.add('origin.' + origin);
    for (const key of keys) {
      if (key.endsWith('.')) continue;
      const text = mod.versionsDatesLabel(key, 'en');
      expect(text, key).not.toBe(key);
    }
  });

  it('a 400 from the server is shown at the date fields and the editor stays open', async () => {
    const page = await openDates({ replies: { setDates: { status: 400, body: { success: false, error: 'invalid_window' } } } });
    const panel = page.panel('dates');
    button(panel, 'Edit dates').click();
    await flush();
    const [from] = panel.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'date') as [FakeElement];
    from.value = '2026-12-10';
    from.dispatch('input');
    button(panel, 'Save dates').click();
    await flush();
    expect(panel.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'date')).toHaveLength(2);
    expect(panel.textContent).toContain('“From” must not be later than “To”.');
  });

  it('with RAG_EFFECTIVE_DATES off the dates-off alert stands above the table', async () => {
    const page = await openDates({ effectiveDates: 'false' });
    expect(page.panel('dates').textContent).toContain('Effective dates are stored and can be edited, but they do not limit answers while RAG_EFFECTIVE_DATES is off.');
  });
});

describe('Settings', () => {
  it('moves the versions group in and shows its warnings', async () => {
    const page = loadPage({ detect: 'on', ingestPipeline: 'legacy', effectiveDates: 'true', pipeline: 'legacy' });
    await page.init();
    const settings = page.panel('settings');
    for (const id of ['RAG_SUPERSESSION_DETECT', 'RAG_EFFECTIVE_DATES', 'RAG_EFFECTIVE_DATE_LLM_EXTRACT']) expect(settings.querySelector('#' + id)).toBeTruthy();
    const alerts = page.alertHost().textContent;
    expect(alerts).toContain('This setting works in the unified ingest pipeline only.');
    expect(alerts).toContain('This filter applies in the v2 retrieval pipeline only.');
    const detect = page.doc.getElementById('RAG_SUPERSESSION_DETECT')!;
    detect.value = 'off';
    detect.dispatch('change');
    expect(page.alertHost().textContent).not.toContain('This setting works in the unified ingest pipeline only.');
  });

  it('localizes the panel and the moved settings in zh and it', async () => {
    const zh = loadPage({ locale: 'zh-CN' });
    await zh.init();
    expect(zh.root.querySelector('[data-versions-dates-title]')!.textContent).toBe('版本与日期');
    expect(zh.panel('settings').textContent).toContain('发现可能的旧版本');
    expect(zh.tab('settings').textContent).toBe('设置');
    const it = loadPage({ locale: 'it-IT' });
    await it.init();
    expect(it.panel('settings').textContent).toContain('Usa le date di validità nelle risposte');
    expect(it.panel('candidates').textContent).toContain('Conferma sostituzione');
  });

  it('initVersionsDatesPanel is idempotent: a second call refreshes and keeps the selected sub-tab', async () => {
    const page = loadPage();
    await page.init();
    page.tab('dates').click();
    await page.init();
    expect(page.tab('dates').getAttribute('aria-selected')).toBe('true');
    expect(page.root.querySelectorAll('[role="tablist"]')).toHaveLength(1);
  });
});

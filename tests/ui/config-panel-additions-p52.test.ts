import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, injectedElements, XSS_PAYLOAD } from './helpers/html-fake-dom';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body?: unknown;
  throws?: boolean;
}

interface Call {
  path: string;
  method: string;
  body: Json | null;
}

const TENANT = 's:default';
const UPLOADER = 'b1000000-0000-4000-8000-000000000001';
const DOC_A = 'd1000000-0000-4000-8000-000000000001';
const DOC_B = 'd1000000-0000-4000-8000-000000000002';

function section(id: string): string {
  const start = indexHtml.indexOf(`<section id="${id}"`);
  if (start < 0) throw new Error('section not found: ' + id);
  const end = indexHtml.indexOf('</section>', start);
  return indexHtml.slice(start, end + '</section>'.length);
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface PageOptions {
  sections: string[];
  scripts: string[];
  route: (call: Call) => Reply | undefined;
  locale?: string;
  securityEvents?: boolean;
  extra?: (doc: FakeDocument, context: Json) => void;
}

function loadPage(options: PageOptions) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const opened: unknown[] = [];
  const link = doc.createElement('a');
  link.className = 'menu-item';
  link.setAttribute('data-tab', 'rag-administration');
  doc.body.appendChild(link);
  const events = doc.createElement('input');
  events.id = 'RAG_SECURITY_EVENTS';
  events.setAttribute('type', 'checkbox');
  events.checked = options.securityEvents ?? false;
  doc.body.appendChild(events);
  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  for (const id of options.sections) {
    const holder = doc.createElement('div');
    tab.appendChild(holder);
    holder.innerHTML = section(id);
  }
  doc.innerHtmlWrites = 0;
  const ragFetch = async (rawPath: string, init: Json = {}) => {
    const apiPath = rawPath.startsWith('/') ? rawPath : `/api/rag/${rawPath}`;
    const call: Call = { path: apiPath, method: String(init.method ?? 'GET'), body: typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : null };
    calls.push(call);
    const reply = options.route(call) ?? { status: 200, body: { success: true, items: [], total: 0, next_cursor: null } };
    if (reply.throws) throw new TypeError('Failed to fetch');
    const copy = reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body));
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, body: copy };
  };
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US' },
    location: { origin: 'http://config.local', search: '', hash: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    URL,
    Intl,
    Date,
    ragFetch,
    getSelection: () => null,
    showToast: () => {},
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  };
  context.window = context;
  if (options.securityEvents) {
    const panel = doc.createElement('section');
    panel.id = 'rag-administration-security-events';
    tab.appendChild(panel);
    context.openSecurityEvents = async (opts: unknown) => {
      opened.push(opts);
    };
  }
  if (options.extra) options.extra(doc, context);
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', ...options.scripts]) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  return { doc, calls, context, opened, tab };
}

function links(root: FakeElement): FakeElement[] {
  return [root, ...root.querySelectorAll('*')].filter((el) => el.tagName === 'a' || el.hasAttribute('href') || el.hasAttribute('src'));
}

function quarantineItem(extra: Json = {}): Json {
  return {
    id: DOC_A,
    lineage_id: DOC_B,
    tenant_key: TENANT,
    filename: 'document-a.pdf',
    source: 'upload',
    version: 1,
    rule_ids: ['rule-1'],
    snippets: [],
    quarantined_at: '2026-11-20T09:30:00.000Z',
    detected_by: 'scan_injection',
    reasons: [],
    unlocated: 0,
    uploader: { id: UPLOADER, display: 'Uploader A' },
    pending_approval: false,
    ...extra,
  };
}

function loadQuarantine(item: Json, securityEvents: boolean, locale?: string) {
  const page = loadPage({
    sections: ['rag-administration-quarantine'],
    scripts: ['rag-panels/rag-ui.js', 'rag-panels/doc-types.js', 'rag-panels/quarantine.js'],
    securityEvents,
    locale,
    route: (call) => {
      if (call.path.startsWith('/api/rag/admin/quarantine?') && !call.path.includes('view=not_checked')) {
        return { status: 200, body: { success: true, total: 1, limit: 50, offset: 0, items: [item] } };
      }
      if (call.path.includes('view=not_checked')) return { status: 200, body: { success: true, view: 'not_checked', total: 0, items: [] } };
      return undefined;
    },
  });
  return {
    ...page,
    async init() {
      await (page.context.initQuarantinePanel as () => Promise<void>)();
      await flush();
    },
    card(): FakeElement {
      return page.doc.querySelector('article[data-quarantine-card]')!;
    },
  };
}

describe('Quarantine: held badge and Show uploader’s events (UI-SPEC 6.14)', () => {
  it('shows the held badge beside the uploader name when uploader_held is true', async () => {
    const page = loadQuarantine(quarantineItem({ uploader_held: true }), false);
    await page.init();
    const badge = page.card().querySelector('[data-quarantine-uploader-held]')!;
    expect(badge.className).toContain('badge-warning');
    expect(badge.textContent).toBe('Uploads held');
    expect(badge.querySelector('.bi-pause-circle')).not.toBeNull();
    expect(badge.parentNode!.textContent).toContain('Uploader A');
  });

  it('shows no badge without the flag, and the uploader line stays as before', async () => {
    for (const extra of [{}, { uploader_held: false }]) {
      const page = loadQuarantine(quarantineItem(extra), false);
      await page.init();
      expect(page.card().querySelector('[data-quarantine-uploader-held]')).toBeNull();
      expect(page.card().textContent).toContain('Uploader A');
      expect(page.card().querySelector('[data-quarantine-uploader-events]')).toBeNull();
    }
  });

  it('with events recorded, Show uploader’s events opens the Events view filtered to the uploader', async () => {
    const page = loadQuarantine(quarantineItem({ uploader_held: true }), true);
    await page.init();
    const show = page.card().querySelector('[data-quarantine-uploader-events]')!;
    expect(show.textContent).toBe('Show uploader’s events'.replace('’', "'"));
    expect(show.className).toContain('btn-link');
    show.click();
    expect(page.opened).toEqual([{ tab: 'events', uploader: { id: UPLOADER, label: 'Uploader A' } }]);
  });

  it('labels the additions in zh and it', async () => {
    for (const [locale, word] of [
      ['zh-CN', '上传已暂缓'],
      ['it-IT', 'Caricamenti sospesi'],
    ]) {
      const page = loadQuarantine(quarantineItem({ uploader_held: true }), false, locale);
      await page.init();
      expect(page.card().querySelector('[data-quarantine-uploader-held]')!.textContent).toBe(word);
    }
  });
});

function pendingItem(extra: Json = {}): Json {
  return {
    id: DOC_A,
    lineage_id: DOC_B,
    tenant_key: TENANT,
    file_name: 'document-a.pdf',
    uploader: { id: UPLOADER, display: 'Uploader A' },
    source: 'upload',
    doc_type: null,
    uploaded_at: '2026-11-20T09:30:00.000Z',
    new_version: false,
    ...extra,
  };
}

function loadApprovals(items: Json[]) {
  const page = loadPage({
    sections: ['rag-administration-approvals'],
    scripts: ['rag-panels/rag-ui.js', 'rag-panels/upload-approvals.js'],
    route: (call) => {
      if (call.path.startsWith('/api/rag/admin/upload-approvals') && call.method === 'GET' && !call.path.includes('exemptions')) {
        return { status: 200, body: { success: true, mode: 'members', total: items.length, items } };
      }
      if (/\/approve/.test(call.path)) return { status: 200, body: { success: true, status: 'ready' } };
      return undefined;
    },
  });
  return {
    ...page,
    async init() {
      await (page.context.initUploadApprovalsPanel as () => Promise<void>)();
      await flush();
    },
  };
}

describe('Upload approvals: pending.uploaderHold (UI-SPEC 6.14)', () => {
  it('a pending upload held by an uploader hold shows the line under the file name; Approve works as before', async () => {
    const page = loadApprovals([pendingItem({ held_by_uploader_hold: true }), pendingItem({ id: DOC_B, file_name: 'document-b.pdf' })]);
    await page.init();
    const rows = page.doc.querySelectorAll('tr[data-upload-approvals-row]');
    expect(rows).toHaveLength(2);
    const line = rows[0]!.querySelector('[data-upload-approvals-uploader-hold]')!;
    expect(line.textContent).toBe('Held because uploads from this uploader are on hold.');
    expect(line.className).toContain('text-xs');
    expect(rows[1]!.querySelector('[data-upload-approvals-uploader-hold]')).toBeNull();
    rows[0]!.querySelector('[data-upload-approvals-approve]')!.click();
    await flush();
    expect(page.calls.some((c) => c.method === 'POST' && c.path.includes(DOC_A) && c.path.includes('approve'))).toBe(true);
  });
});

function versionDoc(id: string, file: string, label: string | null, extra: Json = {}): Json {
  return {
    id,
    file_name: file,
    doc_type: null,
    document_date: null,
    effective_from: null,
    effective_to: null,
    uploaded_at: '2026-11-20T09:30:00.000Z',
    uploader: { id: UPLOADER, display: 'Uploader A' },
    version_label: label,
    ...extra,
  };
}

function loadVersions(route: (call: Call) => Reply | undefined) {
  const page = loadPage({
    sections: ['rag-administration-versions'],
    scripts: ['rag-panels/rag-ui.js', 'rag-panels/doc-types.js', 'rag-panels/versions-dates.js'],
    route,
    extra: (doc) => {
      for (const id of ['RAG_SUPERSESSION_DETECT', 'RAG_EFFECTIVE_DATES']) {
        const control = doc.createElement('select');
        control.id = id;
        control.value = id === 'RAG_EFFECTIVE_DATES' ? 'true' : 'on';
        doc.body.appendChild(control);
      }
    },
  });
  return {
    ...page,
    async init() {
      await (page.context.initVersionsDatesPanel as () => Promise<void>)();
      await flush();
    },
  };
}

const candidate = (origin: string) => ({
  kind: 'candidate',
  id: 'c1000000-0000-4000-8000-000000000001',
  origin,
  direction: null,
  stale: false,
  signals: { title_match: true, content_overlap_percent: 80, conflicting_numbers: 1 },
  document: versionDoc(DOC_A, 'document-a.pdf', 'Release 2'),
  candidate_document: versionDoc(DOC_B, 'document-b.pdf', null),
  created_at: '2026-11-20T09:30:00.000Z',
});

describe('Versions and dates: Version row, answer_conflict badge and the Version label field (UI-SPEC 6.14)', () => {
  function supersessionRoute(items: Json[]) {
    return (call: Call): Reply | undefined => {
      if (call.path.startsWith('/api/rag/admin/supersession') && call.method === 'GET') return { status: 200, body: { success: true, total: items.length, items } };
      return undefined;
    };
  }

  it('the comparison table shows a Version row above Document date, with the label or No label', async () => {
    const page = loadVersions(supersessionRoute([candidate('answer_conflict')]));
    await page.init();
    const article = page.doc.querySelector('#rag-administration-versions article')!;
    const columns = article.querySelectorAll('section');
    expect(columns).toHaveLength(2);
    const terms = columns[0]!.querySelectorAll('dt').map((dt) => dt.textContent);
    expect(terms.indexOf('Version')).toBeGreaterThan(-1);
    expect(terms.indexOf('Version')).toBe(terms.indexOf('Document date') - 1);
    expect(columns[0]!.querySelector('[data-versions-dates-version]')!.textContent).toBe('Release 2');
    expect(columns[1]!.textContent).toContain('No label');
    expect(article.textContent).toContain('Conflicting answers');
    expect(article.querySelector('.bi-chat-dots')).not.toBeNull();
  });

  it('Edit dates shows a Version label field (maxlength 40) saved by Save dates with the dates', async () => {
    const dateItem = { id: DOC_A, file_name: 'document-a.pdf', effective_from: '2026-01-01', effective_to: null, origin: 'admin', confidence: null, proposal: null, version_label: 'Release 2' };
    const page = loadVersions((call) => {
      if (call.path.startsWith('/api/rag/admin/effective-dates') && call.method === 'GET') return { status: 200, body: { success: true, total: 1, items: [dateItem] } };
      if (call.path.startsWith('/api/rag/admin/effective-dates/') && call.method === 'PUT') return { status: 200, body: { success: true } };
      if (call.path.startsWith('/api/rag/admin/supersession')) return { status: 200, body: { success: true, total: 0, items: [] } };
      return undefined;
    });
    await page.init();
    page.doc.getElementById('rag-versions-dates-tab-dates')!.click();
    await flush();
    const all = page.doc.getElementById('rag-versions-dates-filter-all')!;
    all.checked = true;
    all.dispatch('change');
    await flush();
    const edit = page.doc.querySelectorAll('button').find((b) => b.textContent === 'Edit dates')!;
    edit.click();
    await flush();
    const input = page.doc.getElementById('rag-versions-dates-edit-version')!;
    expect(input.getAttribute('maxlength')).toBe('40');
    expect(input.value).toBe('Release 2');
    expect(page.doc.querySelector('label[for="rag-versions-dates-edit-version"]')!.textContent).toBe('Version label');
    expect(page.doc.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Shown to readers next to citations. Leave empty to show the version number.',
    );
    input.value = 'Release 3';
    input.dispatch('input');
    page.doc.querySelector('[data-versions-dates-save]')!.click();
    await flush();
    const put = page.calls.filter((c) => c.method === 'PUT').at(-1)!;
    expect(put.path).toContain(`/api/rag/admin/effective-dates/${DOC_A}`);
    expect(put.body).toEqual({ from: '2026-01-01', to: null, versionLabel: 'Release 3' });
  });

  it('clearing the label sends null; an untouched label is not sent', async () => {
    const dateItem = { id: DOC_A, file_name: 'document-a.pdf', effective_from: null, effective_to: null, origin: 'admin', confidence: null, proposal: null, version_label: 'Release 2' };
    const page = loadVersions((call) => {
      if (call.path.startsWith('/api/rag/admin/effective-dates') && call.method === 'GET') return { status: 200, body: { success: true, total: 1, items: [dateItem] } };
      if (call.method === 'PUT') return { status: 200, body: { success: true } };
      return undefined;
    });
    await page.init();
    page.doc.getElementById('rag-versions-dates-tab-dates')!.click();
    await flush();
    const all = page.doc.getElementById('rag-versions-dates-filter-all')!;
    all.checked = true;
    all.dispatch('change');
    await flush();
    const openEditor = async () => {
      page.doc.querySelectorAll('button').find((b) => b.textContent === 'Edit dates')!.click();
      await flush();
    };
    await openEditor();
    page.doc.querySelector('[data-versions-dates-save]')!.click();
    await flush();
    expect(page.calls.filter((c) => c.method === 'PUT').at(-1)!.body).toEqual({ from: null, to: null });
    await openEditor();
    const input = page.doc.getElementById('rag-versions-dates-edit-version')!;
    input.value = '';
    input.dispatch('input');
    page.doc.querySelector('[data-versions-dates-save]')!.click();
    await flush();
    expect(page.calls.filter((c) => c.method === 'PUT').at(-1)!.body).toEqual({ from: null, to: null, versionLabel: null });
  });
});

function reviewItem(id: string, extra: Json = {}): Json {
  return {
    id,
    tenant_key: TENANT,
    query_masked: null,
    query_language: null,
    answer_language: null,
    chunk_languages: [],
    channel: null,
    outcome: 'answered',
    candidates: [],
    reasons: ['output_guard'],
    occurrences: 1,
    tags: [],
    status: 'open',
    triage: [],
    label: null,
    mined_at: '2026-11-18T10:00:00Z',
    answer_masked: null,
    ...extra,
  };
}

const ITEM = 'item-check-01';

function loadReview(item: Json, locale?: string) {
  const page = loadPage({
    sections: ['rag-administration-review'],
    scripts: ['rag-panels/review-labelling.js'],
    locale,
    route: (call) => {
      if (call.path.startsWith('/api/rag/review/items?') || call.path === '/api/rag/review/items') return { status: 200, body: { items: [item], next_cursor: null } };
      if (call.path === `/api/rag/review/items/${item.id}`) return { status: 200, body: item };
      if (call.path === `/api/rag/review/items/${item.id}/label`) return { status: 200, body: { ...item, status: 'skipped' } };
      return { status: 500, body: { error: 'unexpected' } };
    },
    extra: (doc, context) => {
      const versions = doc.createElement('section');
      versions.id = 'rag-administration-versions';
      const heading = doc.createElement('h3');
      heading.id = 'rag-versions-dates-title';
      versions.appendChild(heading);
      doc.body.appendChild(versions);
      const selected: string[] = [];
      context.versionsSelected = selected;
      context.initVersionsDatesPanel = () => {
        context.versionsDatesPanel = { tabs: { select: (id: string) => selected.push(id) } };
        return Promise.resolve();
      };
    },
  });
  return {
    ...page,
    section(): FakeElement {
      return page.doc.getElementById('rag-administration-review')!;
    },
    async openCase() {
      await (page.context.initReviewLabellingPanel as () => Promise<void>)();
      await flush();
      page.doc.querySelector('[data-review-open]')!.click();
      await flush();
    },
  };
}

describe('Review queue: Phase 5.2 reasons and check-raised items (UI-SPEC 6.14, 12.5, 14.4)', () => {
  it('labels the five new reasons in the filter and on rows', async () => {
    const page = loadReview(reviewItem(ITEM, { reasons: ['claim_unsupported', 'calc_mismatch'] }));
    await (page.context.initReviewLabellingPanel as () => Promise<void>)();
    await flush();
    const options = page.section().querySelectorAll('option').map((o) => o.textContent);
    for (const text of [
      'Sentence not confirmed by the documents',
      'Link or sign-in request in an answer',
      'Two versions disagree',
      'Calculation corrected',
      'Calculation not verified',
    ]) {
      expect(options).toContain(text);
    }
    const rowText = page.section().querySelector('tbody')!.textContent;
    expect(rowText).toContain('Sentence not confirmed by the documents');
    expect(rowText).toContain('Calculation corrected');
    expect(rowText).not.toContain('Reason code');
  });

  it('an output_guard item shows review.noQuestion, the documents by name, the uploader and the check, and no labelling form', async () => {
    const item = reviewItem(ITEM, {
      check_details: {
        check: 'output_guard',
        detector: 'rules',
        documents: [
          { document_id: DOC_A, file_name: 'document-a.pdf', uploader_id: UPLOADER, uploader_name: 'Uploader A', uploader_email: null },
          { document_id: DOC_B, file_name: null, uploader_id: null, uploader_name: null, uploader_email: null },
        ],
      },
    });
    const page = loadReview(item);
    await page.openCase();
    const section = page.section();
    expect(section.querySelector('[data-review-question]')!.textContent).toBe('Raised by a check, not by a question.');
    expect(section.querySelector('[data-review-check]')!.textContent).toBe('Link or sign-in request in an answer');
    const docs = section.querySelectorAll('[data-review-check-documents] li');
    expect(docs).toHaveLength(2);
    expect(docs[0]!.textContent).toContain('document-a.pdf');
    expect(docs[0]!.textContent).toContain('Uploaded by: Uploader A');
    expect(docs[1]!.textContent).toContain('Document removed');
    expect(docs[1]!.textContent).toContain('Unknown uploader');
    expect(section.querySelector('[data-review-form]')).toBeNull();
    expect(section.querySelector('[data-review-save]')).toBeNull();
    expect(section.querySelector('[data-review-skip]')).not.toBeNull();
    expect(section.querySelector('[data-review-open-versions]')).toBeNull();
    expect(page.calls.some((c) => c.path.endsWith('/chunks'))).toBe(false);
  });

  it('a version_conflict item offers Open possible older versions, and Skip case still closes it', async () => {
    const item = reviewItem(ITEM, {
      reasons: ['version_conflict'],
      check_details: { check: 'version_conflict', detector: null, documents: [{ document_id: DOC_A, file_name: 'document-a.pdf', uploader_id: UPLOADER, uploader_name: null, uploader_email: 'uploader-a@example.test' }] },
    });
    const page = loadReview(item);
    await page.openCase();
    const section = page.section();
    expect(section.querySelector('[data-review-check]')!.textContent).toBe('Two versions disagree');
    const doc = section.querySelector('[data-review-check-documents] li')!;
    expect(doc.querySelector('code')!.textContent).toBe(UPLOADER);
    expect(doc.textContent).toContain('uploader-a@example.test');
    section.querySelector('[data-review-open-versions]')!.click();
    await flush();
    expect(page.context.versionsSelected).toEqual(['candidates']);
    expect(page.doc.activeElement!.id).toBe('rag-versions-dates-title');
    section.querySelector('[data-review-skip]')!.click();
    await flush();
    expect(page.calls.find((c) => c.path.endsWith('/label'))!.body).toEqual({ status: 'skipped' });
  });

  it('a question item is unchanged: the question shows and the labelling form renders', async () => {
    const page = loadReview(reviewItem(ITEM, { reasons: ['claim_unsupported'], query_masked: 'What does step two need?', query_language: 'en' }));
    await page.openCase();
    expect(page.section().querySelector('[data-review-question]')!.textContent).toBe('What does step two need?');
    expect(page.section().querySelector('[data-review-form]')).not.toBeNull();
  });

  it('shows the additions in zh and it', async () => {
    for (const [locale, text] of [
      ['zh-CN', '由检查触发，并非来自提问。'],
      ['it-IT', 'Segnalato da un controllo, non da una domanda.'],
    ]) {
      const page = loadReview(reviewItem(ITEM, { check_details: { check: 'output_guard', documents: [] } }), locale);
      await page.openCase();
      expect(page.section().querySelector('[data-review-question]')!.textContent).toBe(text);
    }
  });
});

describe('Untrusted names in the additions stay text (D-57, UI-SPEC 11)', () => {
  it('uploader names, file names and version labels create no element and no link', async () => {
    const quarantine = loadQuarantine(quarantineItem({ filename: XSS_PAYLOAD, uploader: { id: UPLOADER, display: XSS_PAYLOAD }, uploader_held: true }), true);
    await quarantine.init();
    expect(quarantine.card().textContent).toContain(XSS_PAYLOAD);
    expect(injectedElements(quarantine.doc)).toEqual([]);
    expect(links(quarantine.tab).filter((el) => el.tagName !== 'a' || el.getAttribute('data-tab') === null)).toEqual([]);

    const approvals = loadApprovals([pendingItem({ file_name: XSS_PAYLOAD, uploader: { id: UPLOADER, display: XSS_PAYLOAD }, held_by_uploader_hold: true })]);
    await approvals.init();
    expect(injectedElements(approvals.doc)).toEqual([]);

    const evil = candidate('answer_conflict');
    (evil.document as Json).version_label = XSS_PAYLOAD;
    (evil.candidate_document as Json).version_label = 'javascript:alert(1)';
    (evil.document as Json).file_name = XSS_PAYLOAD;
    const versions = loadVersions((call) =>
      call.path.startsWith('/api/rag/admin/supersession') ? { status: 200, body: { success: true, total: 1, items: [evil] } } : undefined,
    );
    await versions.init();
    const article = versions.doc.querySelector('#rag-administration-versions article')!;
    expect(article.textContent).toContain(XSS_PAYLOAD);
    expect(article.textContent).toContain('javascript:alert(1)');
    expect(injectedElements(versions.doc)).toEqual([]);
    expect(links(article)).toEqual([]);

    const review = loadReview(
      reviewItem(ITEM, {
        reasons: ['version_conflict'],
        check_details: { check: 'version_conflict', documents: [{ document_id: DOC_A, file_name: XSS_PAYLOAD, uploader_id: UPLOADER, uploader_name: XSS_PAYLOAD, uploader_email: 'javascript:alert(1)' }] },
      }),
    );
    await review.openCase();
    expect(review.section().textContent).toContain(XSS_PAYLOAD);
    expect(injectedElements(review.doc)).toEqual([]);
    expect(links(review.section())).toEqual([]);
    for (const page of [quarantine, approvals, versions, review]) expect(page.doc.innerHtmlWrites).toBe(0);
  });
});

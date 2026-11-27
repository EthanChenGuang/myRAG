import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type FetchResult = { ok: boolean; status: number; body?: unknown };
type Fetcher = (path: string, init?: { method?: string }) => Promise<FetchResult>;
type Message = { key: string; text: string; segments: Array<Record<string, unknown>> };

interface PendingView {
  kind: 'pending' | 'shift';
  label: string;
  hint: Message;
}

interface RefusalModule {
  REFUSAL_LABELS: Record<Locale, Record<string, string>>;
  cellRows: (status: Record<string, unknown>, locale: Locale) => Array<Record<string, unknown> & { pending?: PendingView }>;
  refusalWarningView: (warning: Record<string, unknown>, locale: Locale) => Message & { code: string; tone: string; changedSettings?: Message | null; reviewAlerts?: boolean };
  RefusalCalibrationPanel: new (
    root: unknown,
    deps: { fetcher: Fetcher; locale?: Locale; page?: Record<string, unknown>; openMonitor?: () => void; refreshBanner?: () => void },
  ) => { mount: () => Promise<void> };
}

function load(): RefusalModule {
  return require('../../scripts/config-ui/rag-panels/refusal-calibration.js') as RefusalModule;
}

function text(node: FakeNode | null | undefined): string {
  if (!node) return '';
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const XSS = '<img src=x onerror=PWNED(1)>';

function cell(extra: Record<string, unknown> = {}) {
  return {
    key: 'raw-key-should-never-show|model-a|en|same',
    provider: 'cohere',
    model: 'model-a',
    query_language: 'en',
    pairing: 'same',
    status: 'calibrated',
    source: 'live',
    stale: false,
    threshold: 0.42,
    dev: { answerable_count: 10, no_answer_count: 10, false_refusal_point_estimate: 0.1, false_refusal_upper_bound_95: 0.3, correct_refusal_point_estimate: 0.9 },
    holdout: { answerable_count: 10, no_answer_count: 10, false_refusal_point_estimate: 0.1, false_refusal_upper_bound_95: 0.3, correct_refusal_point_estimate: 0.9 },
    recorded_at: '2026-11-01',
    ...extra,
  };
}

function status(cells: unknown[], warnings: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    success: true,
    pipeline: 'v2',
    refusal_threshold: true,
    reranker: { provider: 'cohere', score_kind: 'calibrated', tiers: { chat: { tier: 'quality', models: { zh: 'model-a', en: 'model-a', it: 'model-a' } }, voice: { tier: 'fast', models: { zh: 'model-a', en: 'model-a', it: 'model-a' } } } },
    versions: { tokenizer: 1, rerank_text: 1 },
    cells,
    warnings,
    ...extra,
  };
}

function panelRoot(doc: FakeDocument): FakeElement {
  const root = doc.createElement('section');
  root.id = 'rag-administration-refusal';
  for (const attr of ['data-refusal-title', 'data-refusal-description', 'data-refusal-alert', 'data-refusal-content', 'data-refusal-status']) {
    const el = doc.createElement(attr === 'data-refusal-title' ? 'h3' : 'div');
    el.setAttribute(attr, '');
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  return root;
}

async function withDoc<T>(fn: (doc: FakeDocument) => Promise<T>): Promise<T> {
  const doc = new FakeDocument();
  const holder = globalThis as unknown as { document?: unknown };
  const previous = holder.document;
  holder.document = doc;
  try {
    return await fn(doc);
  } finally {
    holder.document = previous;
  }
}

async function rendered(body: unknown, deps: { openMonitor?: () => void; refreshBanner?: () => void; locale?: Locale } = {}) {
  const doc = new FakeDocument();
  const holder = globalThis as unknown as { document?: unknown };
  const previous = holder.document;
  holder.document = doc;
  const { RefusalCalibrationPanel } = load();
  const root = panelRoot(doc);
  const calls: string[] = [];
  const fetcher: Fetcher = async (path) => {
    calls.push(path);
    return { ok: true, status: 200, body };
  };
  const panel = new RefusalCalibrationPanel(root, { fetcher, page: { refusalThreshold: true, reranker: 'cohere' }, ...deps });
  await panel.mount();
  return { doc, root, calls, restore: () => (holder.document = previous) };
}

/** The panel markup with the snapshot time removed (it changes on every run). */
function stableMarkup(root: FakeElement): string {
  return root.innerHTML.replace(/<time datetime="\d{4}-\d{2}-\d{2}T[^"]*">[^<]*<\/time>/g, '<time/>');
}

describe('REFUSAL_LABELS additions (UI-SPEC 12.5)', () => {
  it('holds the new keys in en, zh and it with the UI-SPEC words', () => {
    const { REFUSAL_LABELS: L } = load();
    const keys = [
      'warning.uncalibrated_after_change',
      'warning.changedSettings',
      'warning.possibly_stale_scores',
      'badge.pending',
      'badge.shift',
      'hint.pending.reranker_model',
      'hint.pending.embedding_model',
      'hint.pending.tokenizer',
      'hint.shift',
      'legend.pending',
      'legend.shift',
      'action.reviewAlerts',
    ];
    for (const locale of ['en', 'zh', 'it'] as const) for (const key of keys) expect(L[locale][key], `${locale} ${key}`).toBeTruthy();
    expect(L.en['badge.pending']).toBe('Uncalibrated after a change');
    expect(L.zh['badge.shift']).toBe('可能已过期');
    expect(L.it['badge.pending']).toBe('Non calibrata dopo una modifica');
    expect(L.en['action.reviewAlerts']).toBe('Review alerts');
    expect(L.en['status.uncalibrated']).toBe('Not calibrated');
    expect(L.en['badge.stale']).toBe('Stale');
  });
});

describe('cellRows pending marks', () => {
  it('a reranker change gives the pending badge and the hint with its date, next to the stored status', () => {
    const { cellRows } = load();
    const [row] = cellRows(status([cell({ pending: { reason: 'reranker_model', since: '2026-11-20', changed_keys: ['RAG_RERANKER'] } })]), 'en');
    expect(row.statusKey).toBe('calibrated');
    expect(row.pending?.kind).toBe('pending');
    expect(row.pending?.label).toBe('Uncalibrated after a change');
    expect(row.pending?.hint.text).toBe('The reranker model changed on Nov 20, 2026. Not applied until calibrated again.');
  });

  it('a score shift gives Possibly stale with the alert day', () => {
    const { cellRows } = load();
    const [row] = cellRows(status([cell({ pending: { reason: 'score_shift', since: '2026-11-22', alert_id: 'a-01' } })]), 'it');
    expect(row.pending?.kind).toBe('shift');
    expect(row.pending?.label).toBe('Forse non più valida');
    expect(row.pending?.hint.text).toContain('22 nov 2026');
  });

  it('a cell without a mark, or with an unknown reason, gets no pending field', () => {
    const { cellRows } = load();
    const rows = cellRows(status([cell(), cell({ pending: null }), cell({ pending: { reason: 'something_new', since: '2026-11-22' } })]), 'en');
    expect(rows.map((r) => Object.prototype.hasOwnProperty.call(r, 'pending'))).toEqual([false, false, false]);
  });
});

describe('refusal warnings for the derived marks', () => {
  it('uncalibrated_after_change: count, command and the changed setting names as code', () => {
    const { refusalWarningView } = load();
    const view = refusalWarningView({ code: 'uncalibrated_after_change', keys: ['k1', 'k2'], changed_keys: ['RAG_RERANKER', 'RAG_EXAMPLE_SETTING'], message: 'x' }, 'en');
    expect(view.tone).toBe('warning');
    expect(view.text).toContain('Thresholds not applied since a setting change: 2.');
    expect(view.segments).toContainEqual({ code: 'python -m rag_eval.calibrate refusal' });
    expect(view.changedSettings?.text).toBe('Changed settings: RAG_RERANKER, RAG_EXAMPLE_SETTING');
    expect(view.changedSettings?.segments).toContainEqual({ code: 'RAG_RERANKER' });
    expect(view.text).not.toContain('k1');
  });

  it('possibly_stale_scores: count and a Review alerts action; every locale fills its placeholders', () => {
    const { refusalWarningView } = load();
    for (const locale of ['en', 'zh', 'it'] as const) {
      const view = refusalWarningView({ code: 'possibly_stale_scores', keys: ['k1'], alert_id: 'a-01', message: 'x' }, locale);
      expect(view.text).not.toMatch(/\{\w+\}/);
      expect(view.reviewAlerts).toBe(true);
    }
    expect(refusalWarningView({ code: 'possibly_stale_scores', keys: ['k1'], alert_id: 'a-01', message: 'x' }, 'en').text).toContain(': 1.');
  });
});

describe('RefusalCalibrationPanel with the derived marks', () => {
  it('shows Not calibrated, Stale and the pending badge together, each on its own line, with the hint line', async () => {
    const r = await rendered(status([cell({ status: 'uncalibrated', threshold: null, stale: true, pending: { reason: 'tokenizer', since: '2026-11-20', changed_keys: ['RAG_EXAMPLE_SETTING'] } })]));
    try {
      const row = r.root.querySelector('tbody tr') as FakeElement;
      const badges = row.querySelector('[data-refusal-badges]') as FakeElement;
      expect(badges.className).toContain('flex-col');
      const words = badges.querySelectorAll('.badge').map((b) => text(b));
      expect(words).toEqual(['Not calibrated', 'Stale', 'Uncalibrated after a change']);
      const pendingBadge = badges.querySelectorAll('.badge')[2];
      expect(pendingBadge.className).toContain('badge-warning');
      expect(pendingBadge.className).toContain('badge-outline');
      expect(text(row)).toContain('The tokenizer changed on Nov 20, 2026. Not applied until calibrated again.');
      expect(text(row)).toContain('No threshold was fitted. Never causes a refusal.');
      expect(text(r.root)).not.toContain('raw-key-should-never-show');
    } finally {
      r.restore();
    }
  });

  it('renders the two warnings, the changed settings line and a Review alerts link button that opens Monitoring', async () => {
    let opened = 0;
    const r = await rendered(
      status(
        [cell({ pending: { reason: 'reranker_model', since: '2026-11-20', changed_keys: ['RAG_RERANKER'] } }), cell({ pending: { reason: 'score_shift', since: '2026-11-22', alert_id: 'a-01' } })],
        [
          { code: 'uncalibrated_after_change', keys: ['k1'], changed_keys: ['RAG_RERANKER'], message: 'x' },
          { code: 'possibly_stale_scores', keys: ['k2'], alert_id: 'a-01', message: 'x' },
        ],
      ),
      { openMonitor: () => (opened += 1) },
    );
    try {
      const all = text(r.root);
      expect(all).toContain('Thresholds not applied since a setting change: 1.');
      expect(all).toContain('Changed settings: RAG_RERANKER');
      expect(all).toContain('Thresholds that may no longer fit');
      const review = r.root.querySelectorAll('button').filter((b) => text(b).trim() === 'Review alerts');
      expect(review.length).toBe(1);
      expect(review[0].className).toContain('btn-link');
      expect(review[0].className).toContain('btn-xs');
      review[0].click();
      expect(opened).toBe(1);
      expect(all).toContain('Possibly stale');
      expect(all).toContain('The score distribution moved on Nov 22, 2026. Still applied.');
      expect(all).toContain('Uncalibrated after a change: the reranker model');
      expect(all).toContain('Possibly stale: the monitor saw the score distribution move.');
    } finally {
      r.restore();
    }
  });

  it('a status without the new fields renders exactly as before this phase', async () => {
    const r = await rendered(
      status([cell(), cell({ status: 'uncalibrated', threshold: null, stale: true, model: 'model-b', query_language: 'zh' })], [{ code: 'stale_cells', keys: ['k1'], message: 'x' }]),
    );
    try {
      expect(text(r.root)).not.toContain('Uncalibrated after a change');
      expect(text(r.root)).not.toContain('Possibly stale');
      expect(stableMarkup(r.root)).toMatchSnapshot();
    } finally {
      r.restore();
    }
  });

  it('refreshes the page banner after a refresh of the panel, not on the first load', async () => {
    let banner = 0;
    const r = await rendered(status([cell()]), { refreshBanner: () => (banner += 1) });
    try {
      expect(banner).toBe(0);
      const refresh = r.root.querySelectorAll('button').find((b) => text(b).trim() === 'Refresh status') as FakeElement;
      refresh.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(banner).toBe(1);
    } finally {
      r.restore();
    }
  });

  it('inserts server strings in the marks as text only', async () => {
    await withDoc(async () => undefined);
    const r = await rendered(
      status([cell({ pending: { reason: 'embedding_model', since: XSS, changed_keys: [XSS] } })], [{ code: 'uncalibrated_after_change', keys: ['k1'], changed_keys: [XSS], message: XSS }]),
    );
    try {
      expect(text(r.root)).toContain(XSS);
      expect(injectedElements(r.root)).toEqual([]);
    } finally {
      r.restore();
    }
  });
});

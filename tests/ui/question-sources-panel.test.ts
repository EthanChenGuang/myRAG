import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type FetchResult = { ok: boolean; status: number; body?: unknown };
type FetchInit = { method?: string; body?: string; headers?: Record<string, string> };
type Fetcher = (path: string, init?: FetchInit) => Promise<FetchResult>;

interface PanelLike {
  mount: () => Promise<void>;
  refresh: () => Promise<void>;
  selectTab: (id: string) => Promise<void>;
}

interface QuestionSources {
  QUESTION_SOURCES_LABELS: Record<Locale, Record<string, string>>;
  QuestionSourcesPanel: new (root: unknown, deps: { fetcher: Fetcher; locale?: Locale; config?: () => Record<string, string> }) => PanelLike;
  initQuestionSourcesPanel: () => void;
}

function load(): QuestionSources {
  return require('../../scripts/config-ui/rag-panels/question-sources.js') as QuestionSources;
}

function text(node: FakeNode | null | undefined): string {
  if (!node) return '';
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const XSS = '<img src=x onerror=PWNED(1)>';
const ORG = '11111111-2222-4333-8444-555555555555';
const ORG2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function settingsBlock(doc: FakeDocument): FakeElement {
  const block = doc.createElement('div');
  block.id = 'rag-phase053-settings';
  block.className = 'hidden';
  const group = doc.createElement('div');
  group.setAttribute('data-rag-settings-group', 'sample');
  const label = doc.createElement('span');
  label.setAttribute('data-rag-i18n', 'settings.sample.label');
  label.textContent = 'Weekly sampling';
  const select = doc.createElement('select');
  select.id = 'RAG_REPRESENTATIVE_SAMPLE';
  select.value = 'false';
  const hint = doc.createElement('p');
  hint.setAttribute('data-rag-i18n', 'settings.saveHint');
  hint.textContent = 'These settings are saved with Save All Changes at the top of the page and apply after the app restarts.';
  group.append(label, select, hint);
  block.appendChild(group);
  doc.body.appendChild(block);
  return block;
}

function pageInputs(doc: FakeDocument, log = 'masked_query', review = true) {
  const logSelect = doc.createElement('select');
  logSelect.id = 'RAG_RETRIEVAL_LOG';
  logSelect.value = log;
  const reviewToggle = doc.createElement('input');
  reviewToggle.id = 'RAG_DOMAIN_EXPERT_REVIEW';
  reviewToggle.setAttribute('type', 'checkbox');
  reviewToggle.checked = review;
  doc.body.append(logSelect, reviewToggle);
  return { logSelect, reviewToggle };
}

function workspaceSelector(doc: FakeDocument, value = ORG) {
  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  for (const [v, name] of [
    [ORG, '🏢 Workspace one'],
    [ORG2, '🏢 Workspace two'],
  ]) {
    const option = doc.createElement('option');
    option.setAttribute('value', v);
    option.textContent = name;
    selector.appendChild(option);
  }
  selector.value = value;
  doc.body.appendChild(selector);
  return selector;
}

function panelRoot(doc: FakeDocument): FakeElement {
  const root = doc.createElement('section');
  root.id = 'rag-administration-question-sources';
  for (const attr of [
    'data-question-sources-title',
    'data-question-sources-description',
    'data-question-sources-workspace',
    'data-question-sources-alert',
    'data-question-sources-content',
    'data-question-sources-status',
  ]) {
    const el = doc.createElement(attr === 'data-question-sources-title' ? 'h3' : 'div');
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

function fakeFetcher(answer: (path: string, init?: FetchInit) => FetchResult | Promise<FetchResult>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetcher: Fetcher = async (path, init) => {
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined });
    return answer(path, init);
  };
  return { fetcher, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function status(extra: Record<string, unknown> = {}) {
  return {
    success: true,
    enabled: true,
    missing: [],
    last_sample_at: '2026-11-24T09:00:00Z',
    added: 30,
    by_source: { representative: 18, pilot: 6, drift_fill: 6 },
    by_language: { en: 20, it: 10 },
    clusters: { count: 12, refit_at: '2026-11-03T12:00:00Z', novel: 41 },
    ...extra,
  };
}

const ON = () => ({ RAG_REPRESENTATIVE_SAMPLE: 'true', RAG_RETRIEVAL_LOG: 'masked_query', RAG_DOMAIN_EXPERT_REVIEW: 'true' });
const OFF = () => ({ RAG_REPRESENTATIVE_SAMPLE: 'false', RAG_RETRIEVAL_LOG: 'off', RAG_DOMAIN_EXPERT_REVIEW: 'false' });

function buttonsByText(root: FakeElement, label: string): FakeElement[] {
  return root.querySelectorAll('button').filter((b) => text(b).trim() === label);
}

function tab(root: FakeElement, id: string): FakeElement {
  const el = root.querySelector(`[data-question-sources-tab="${id}"]`);
  expect(el, `tab ${id}`).toBeTruthy();
  return el as FakeElement;
}

function view(root: FakeElement, id: string): FakeElement {
  const el = root.querySelector(`[data-question-sources-view="${id}"]`);
  expect(el, `view ${id}`).toBeTruthy();
  return el as FakeElement;
}

describe('QUESTION_SOURCES_LABELS', () => {
  it('has the same keys in en, zh and it', () => {
    const { QUESTION_SOURCES_LABELS } = load();
    const en = Object.keys(QUESTION_SOURCES_LABELS.en).sort();
    expect(en.length).toBeGreaterThan(70);
    expect(Object.keys(QUESTION_SOURCES_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(QUESTION_SOURCES_LABELS.it).sort()).toEqual(en);
  });

  it('holds the UI-SPEC 12.6 words', () => {
    const { QUESTION_SOURCES_LABELS: L } = load();
    expect(L.en['panel.title']).toBe('Question sources');
    expect(L.zh['tab.sample']).toBe('每周抽样');
    expect(L.it['action.runSample']).toBe('Esegui campionamento ora');
    expect(L.en['import.progress']).toBe('{done} of {total} questions');
    expect(L.en['confirm.remove.keep']).toBe('Keep pilot user');
  });
});

describe('QuestionSourcesPanel: chrome and Weekly sample', () => {
  it('has the sub-tabs Weekly sample (default), Pilot users, Import questions and Settings, and names the workspace', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      workspaceSelector(doc);
      pageInputs(doc);
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: status() }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      const tabs = root.querySelectorAll('[role="tab"]');
      expect(tabs.map((t) => text(t))).toEqual(['Weekly sample', 'Pilot users', 'Import questions', 'Settings']);
      expect(tab(root, 'sample').getAttribute('aria-selected')).toBe('true');
      expect(root.getAttribute('lang')).toBe('en');
      expect(text(root.querySelector('[data-question-sources-title]'))).toBe('Question sources');
      expect(text(root.querySelector('[data-question-sources-workspace]'))).toBe('Workspace: Workspace one');
    });
  });

  it('with RAG_REPRESENTATIVE_SAMPLE false renders the off block and makes no request', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: status() }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: OFF }).mount();
      expect(calls).toEqual([]);
      const sample = view(root, 'sample');
      expect(text(sample)).toContain('Weekly sampling is off');
      expect(text(sample)).toContain('Only failed answers reach the review queue.');
      expect(buttonsByText(sample, 'Run sample now')).toHaveLength(0);
      expect(text(sample)).not.toMatch(/\d/);
    });
  });

  it('a missing log prerequisite names RAG_RETRIEVAL_LOG in code and renders no Run sample now', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: status({ missing: ['log'], added: 0, last_sample_at: null }) }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/rag/admin/monitor/sample`]);
      const sample = view(root, 'sample');
      expect(text(sample)).toContain('Sampling needs the retrieval log at the level masked_query. Set RAG_RETRIEVAL_LOG.');
      expect(sample.querySelectorAll('code').map((c) => text(c))).toContain('RAG_RETRIEVAL_LOG');
      expect(buttonsByText(sample, 'Run sample now')).toHaveLength(0);
    });
  });

  it('a missing review prerequisite names RAG_DOMAIN_EXPERT_REVIEW', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: status({ missing: ['review'] }) }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      const sample = view(root, 'sample');
      expect(text(sample)).toContain('Sampling needs expert review switched on. Set RAG_DOMAIN_EXPERT_REVIEW to true.');
      expect(buttonsByText(sample, 'Run sample now')).toHaveLength(0);
    });
  });

  it('a populated status renders every count as "label: number" and the by-language table, for the selected workspace', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      workspaceSelector(doc);
      settingsBlock(doc);
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: status() }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      expect(calls[0].path).toBe(`/api/rag/admin/monitor/sample?organizationId=${ORG}`);
      const sample = view(root, 'sample');
      const all = text(sample);
      expect(all).toContain('Weekly sampling: On');
      expect(all).toContain('Last sample: Nov 24, 2026');
      expect(all).toContain('Questions added to the review queue: 30');
      expect(all).toContain('From the weekly sample: 18');
      expect(all).toContain('From pilot users: 6');
      expect(all).toContain('From under-covered topic groups: 6');
      expect(all).toContain('Topic groups: 12, refitted Nov 3, 2026');
      expect(all).toContain('Questions not in any group: 41');
      const table = sample.querySelector('table') as FakeElement;
      expect(table).toBeTruthy();
      const rows = table.querySelectorAll('tbody tr').map((r) => r.childNodes.map((c) => text(c)));
      expect(rows).toEqual([
        ['English', '20'],
        ['Italian', '10'],
      ]);
      expect(sample.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-24T09:00:00Z');
      expect(text(root.querySelector('[data-question-sources-status]'))).toContain('Questions added to the review queue: 30');
    });
  });

  it('before the first run renders sample.empty and keeps Run sample now', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: status({ last_sample_at: null, added: 0, by_source: { representative: 0, pilot: 0, drift_fill: 0 }, by_language: {} }) }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      const sample = view(root, 'sample');
      expect(text(sample)).toContain('No sample yet');
      expect(text(sample)).toContain('The first sample is drawn by the weekly job, or now with Run sample now.');
      expect(buttonsByText(sample, 'Run sample now')).toHaveLength(1);
    });
  });

  it('Run sample now disables itself with a spinner until the answer, then says run.done with the number added', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      let release: (value: FetchResult) => void = () => {};
      const { fetcher, calls } = fakeFetcher((_path, init) => {
        if (init?.method === 'POST') return new Promise<FetchResult>((resolve) => (release = resolve));
        return { ok: true, status: 200, body: status() };
      });
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      const run = buttonsByText(view(root, 'sample'), 'Run sample now')[0];
      run.click();
      await flush();
      const pressed = view(root, 'sample').querySelectorAll('button').find((b) => text(b).includes('Drawing the sample…')) as FakeElement;
      expect(pressed).toBeTruthy();
      expect(pressed.disabled).toBe(true);
      expect(pressed.querySelector('.loading')).toBeTruthy();
      expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/rag/admin/monitor/sample' });
      release({ ok: true, status: 200, body: { ...status({ added: 42 }), run: { written: true, week: '2026-W47', added: 12, excluded_queued: 0, missing: [] } } });
      await flush();
      await flush();
      expect(text(root.querySelector('[data-question-sources-status]'))).toBe('Sample finished. Questions added to the review queue: 12.');
      expect(text(view(root, 'sample'))).toContain('Questions added to the review queue: 42');
      const again = buttonsByText(view(root, 'sample'), 'Run sample now')[0];
      expect(again.disabled).toBe(false);
    });
  });

  it('a failed run says run.failed in the status region', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher((_path, init) => (init?.method === 'POST' ? { ok: false, status: 503, body: null } : { ok: true, status: 200, body: status() }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      buttonsByText(view(root, 'sample'), 'Run sample now')[0].click();
      await flush();
      await flush();
      const region = root.querySelector('[data-question-sources-status]') as FakeElement;
      expect(text(region)).toContain('The sample did not finish. Nothing was added.');
      expect(region.classList.contains('text-error')).toBe(true);
    });
  });

  it('a 404 while the saved switch is on says the app has not picked up the setting', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: false, status: 404, body: { success: false, error: 'Not found' } }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      expect(text(view(root, 'sample'))).toContain('The app answered that this feature is off.');
      expect(buttonsByText(view(root, 'sample'), 'Reload panel')).toHaveLength(1);
    });
  });

  it('401 shows the sign-in alert and keeps the Settings sub-tab usable', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: false, status: 401, body: null }));
      const root = panelRoot(doc);
      const panel = new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON });
      await panel.mount();
      expect(text(view(root, 'sample'))).toContain('Admin sign-in required.');
      await panel.selectTab('settings');
      expect(view(root, 'settings').querySelector('#RAG_REPRESENTATIVE_SAMPLE')).toBeTruthy();
    });
  });

  it('changing #workspace-selector reloads the panel for the new workspace', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      const selector = workspaceSelector(doc);
      settingsBlock(doc);
      const { fetcher, calls } = fakeFetcher(() => ({ ok: true, status: 200, body: status() }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      selector.value = ORG2;
      selector.dispatch('change');
      await flush();
      await flush();
      expect(calls.map((c) => c.path)).toEqual([`/api/rag/admin/monitor/sample?organizationId=${ORG}`, `/api/rag/admin/monitor/sample?organizationId=${ORG2}`]);
      expect(text(root.querySelector('[data-question-sources-workspace]'))).toBe('Workspace: Workspace two');
    });
  });

  it('renders server language codes and counts as text only', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: status({ by_language: { [XSS]: 3 }, missing: [] }) }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: ON }).mount();
      expect(injectedElements(doc)).toEqual([]);
      expect(doc.innerHtmlWrites).toBe(0);
    });
  });

  it('zh and it render their own strings', async () => {
    for (const [locale, word] of [
      ['zh', '最近一次抽样'],
      ['it', 'Ultimo campione'],
    ] as const) {
      await withDoc(async (doc) => {
        const { QuestionSourcesPanel } = load();
        settingsBlock(doc);
        const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: status() }));
        const root = panelRoot(doc);
        await new QuestionSourcesPanel(root, { fetcher, locale, config: ON }).mount();
        expect(root.getAttribute('lang')).toBe(locale);
        expect(text(view(root, 'sample'))).toContain(word);
      });
    }
  });
});

describe('QuestionSourcesPanel: Settings', () => {
  it('moves the sample group into Settings once, localized, ending with the save hint', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      const block = settingsBlock(doc);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: status() }));
      const root = panelRoot(doc);
      const panel = new QuestionSourcesPanel(root, { fetcher, locale: 'it', config: ON });
      await panel.mount();
      await panel.mount();
      const settings = view(root, 'settings');
      expect(settings.querySelectorAll('[data-rag-settings-group="sample"]')).toHaveLength(1);
      expect(block.querySelectorAll('[data-rag-settings-group="sample"]')).toHaveLength(0);
      expect(text(settings)).toContain('Campionamento settimanale');
      expect(text(settings)).toContain('Save All Changes');
    });
  });

  it('warns when sampling is on while the retrieval log is not masked_query or expert review is off, recomputed on change', async () => {
    await withDoc(async (doc) => {
      const { QuestionSourcesPanel } = load();
      settingsBlock(doc);
      const { logSelect, reviewToggle } = pageInputs(doc, 'ids', false);
      const { fetcher } = fakeFetcher(() => ({ ok: true, status: 200, body: status() }));
      const root = panelRoot(doc);
      await new QuestionSourcesPanel(root, { fetcher, locale: 'en', config: OFF }).mount();
      const settings = view(root, 'settings');
      const notes = () => settings.querySelectorAll('.alert').map((a) => text(a));
      expect(notes()).toEqual([]);
      const select = settings.querySelector('#RAG_REPRESENTATIVE_SAMPLE') as FakeElement;
      select.value = 'true';
      select.dispatch('change');
      expect(notes()).toEqual([
        'Weekly sampling is on, but the retrieval log is not at the level masked_query. Nothing will be sampled.',
        'Weekly sampling is on, but expert review is off. Nothing will be sampled.',
      ]);
      logSelect.value = 'masked_query';
      logSelect.dispatch('change');
      reviewToggle.checked = true;
      reviewToggle.dispatch('change');
      expect(notes()).toEqual([]);
    });
  });
});

describe('initQuestionSourcesPanel', () => {
  it('is exported and safe to call without the section', () => {
    const { initQuestionSourcesPanel } = load();
    expect(typeof initQuestionSourcesPanel).toBe('function');
    expect(() => withDoc(async () => initQuestionSourcesPanel())).not.toThrow();
  });
});

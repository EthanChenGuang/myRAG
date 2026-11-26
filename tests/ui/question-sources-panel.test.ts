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
      expect(sample.querySelector('ul time')?.getAttribute('datetime')).toBe('2026-11-24T09:00:00Z');
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

const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'aaaaaaaa-0000-4000-8000-000000000002';

function pilotUser(i: number, masked: string | null = `u•••@e••••••.com`) {
  const id = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
  return { user_id: id, masked_email: masked, added_at: `2026-11-${String(20 - (i % 10)).padStart(2, '0')}T12:00:00Z` };
}

async function openPilot(doc: FakeDocument, answer: (path: string, init?: FetchInit) => FetchResult | Promise<FetchResult>, locale: Locale = 'en') {
  const { QuestionSourcesPanel } = load();
  workspaceSelector(doc);
  settingsBlock(doc);
  const { fetcher, calls } = fakeFetcher(answer);
  const root = panelRoot(doc);
  const panel = new QuestionSourcesPanel(root, { fetcher, locale, config: ON });
  await panel.mount();
  await panel.selectTab('pilot');
  await flush();
  await flush();
  return { root, calls, panel, pilot: view(root, 'pilot') };
}

function pilotForm(pilot: FakeElement) {
  const form = pilot.querySelector('form') as FakeElement;
  const input = form.querySelector('input[name="pilot-user"]') as FakeElement;
  const help = pilot.querySelector('[data-question-sources-pilot-help]') as FakeElement;
  return { form, input, help };
}

describe('QuestionSourcesPanel: Pilot users', () => {
  it('lists the masked e-mail or the user id in code, the date added and Remove pilot user with the user in its accessible name', async () => {
    await withDoc(async (doc) => {
      const users = [
        { user_id: USER_A, masked_email: 'm•••@e••••••.com', added_at: '2026-11-20T12:00:00Z' },
        { user_id: USER_B, masked_email: null, added_at: '2026-11-18T12:00:00Z' },
      ];
      const { pilot, calls } = await openPilot(doc, (path) =>
        path.startsWith('/api/rag/admin/pilot-users') ? { ok: true, status: 200, body: { success: true, users, weight: 3, cap_share: 0.25, next_cursor: null } } : { ok: true, status: 200, body: status() },
      );
      expect(calls.at(-1)).toMatchObject({ method: 'GET', path: `/api/rag/admin/pilot-users?organizationId=${ORG}` });
      expect(text(pilot)).toContain('Questions from pilot users are sampled 3 times as often, up to 25.0% of each weekly sample.');
      const rows = pilot.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(2);
      expect(text(rows[0].childNodes[0] as FakeElement)).toBe('m•••@e••••••.com');
      expect(text(rows[0].childNodes[1] as FakeElement)).toBe('Nov 20, 2026');
      expect((rows[1].childNodes[0] as FakeElement).querySelector('code')).toBeTruthy();
      expect(text(rows[1].childNodes[0] as FakeElement)).toBe(USER_B);
      const remove = rows[0].querySelector('button') as FakeElement;
      expect(text(remove)).toBe('Remove pilot user');
      expect(remove.getAttribute('aria-label')).toBe('Remove pilot user m•••@e••••••.com');
      const { input, form } = pilotForm(pilot);
      expect(input.getAttribute('autocomplete')).toBe('off');
      expect(input.getAttribute('spellcheck')).toBe('false');
      expect(pilot.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
      expect(text(form)).toContain('Add pilot user');
    });
  });

  it('pilot.explain has no numbers when the route sends no weight', async () => {
    await withDoc(async (doc) => {
      const { pilot } = await openPilot(doc, (path) =>
        path.startsWith('/api/rag/admin/pilot-users') ? { ok: true, status: 200, body: { success: true, users: [], next_cursor: null } } : { ok: true, status: 200, body: status() },
      );
      expect(text(pilot)).toContain('Questions from pilot users are sampled more often than others.');
      expect(text(pilot)).toContain('No pilot users');
      expect(text(pilot)).toContain('Add the people who try the system first.');
      expect(pilotForm(pilot).form).toBeTruthy();
    });
  });

  it('an empty field shows pilot.empty.field on submit and keeps focus; no request is made', async () => {
    await withDoc(async (doc) => {
      const { pilot, calls } = await openPilot(doc, (path) =>
        path.startsWith('/api/rag/admin/pilot-users') ? { ok: true, status: 200, body: { success: true, users: [], next_cursor: null } } : { ok: true, status: 200, body: status() },
      );
      const before = calls.length;
      const { form, input, help } = pilotForm(pilot);
      input.value = '   ';
      const event = form.dispatch('submit');
      await flush();
      expect(event.defaultPrevented).toBe(true);
      expect(calls.length).toBe(before);
      expect(text(help)).toBe('Enter an e-mail address or a user ID.');
      expect(help.classList.contains('text-error')).toBe(true);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(doc.activeElement).toBe(input);
    });
  });

  it('201 clears the field, reloads the list, says pilot.added and returns focus to the field; the button spins while in flight', async () => {
    await withDoc(async (doc) => {
      let release: (value: FetchResult) => void = () => {};
      let listed: unknown[] = [];
      const { pilot, calls } = await openPilot(doc, (path, init) => {
        if (path.startsWith('/api/rag/admin/pilot-users') && init?.method === 'POST') return new Promise<FetchResult>((resolve) => (release = resolve));
        if (path.startsWith('/api/rag/admin/pilot-users')) return { ok: true, status: 200, body: { success: true, users: listed, next_cursor: null } };
        return { ok: true, status: 200, body: status() };
      });
      const { form, input } = pilotForm(pilot);
      input.value = 'person@example.invalid';
      form.dispatch('submit');
      await flush();
      const button = form.querySelector('button') as FakeElement;
      expect(button.disabled).toBe(true);
      expect(button.querySelector('.loading')).toBeTruthy();
      expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/rag/admin/pilot-users?organizationId=${ORG}`, body: { user: 'person@example.invalid' } });
      listed = [{ user_id: USER_A, masked_email: 'p•••@e••••••.invalid', added_at: '2026-11-26T12:00:00Z' }];
      release({ ok: true, status: 201, body: { success: true, user: listed[0] } });
      await flush();
      await flush();
      await flush();
      expect(input.value).toBe('');
      expect(button.disabled).toBe(false);
      expect(calls.at(-1)).toMatchObject({ method: 'GET', path: `/api/rag/admin/pilot-users?organizationId=${ORG}` });
      expect(pilot.querySelectorAll('tbody tr')).toHaveLength(1);
      expect(text(doc.querySelector('[data-question-sources-status]'))).toBe('Pilot user added.');
      expect(doc.activeElement).toBe(input);
    });
  });

  it('404 user_not_found and 409 already_pilot show their messages at the field with aria-invalid', async () => {
    for (const [code, statusCode, message] of [
      ['user_not_found', 404, 'No user with that e-mail or ID belongs to this workspace.'],
      ['already_pilot', 409, 'This user is already a pilot user.'],
    ] as const) {
      await withDoc(async (doc) => {
        const { pilot } = await openPilot(doc, (path, init) => {
          if (path.startsWith('/api/rag/admin/pilot-users') && init?.method === 'POST') return { ok: false, status: statusCode, body: { success: false, error: code } };
          if (path.startsWith('/api/rag/admin/pilot-users')) return { ok: true, status: 200, body: { success: true, users: [], next_cursor: null } };
          return { ok: true, status: 200, body: status() };
        });
        const { form, input, help } = pilotForm(pilot);
        input.value = USER_A;
        form.dispatch('submit');
        await flush();
        await flush();
        expect(text(help)).toBe(message);
        expect(help.classList.contains('text-error')).toBe(true);
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(input.getAttribute('aria-describedby')).toContain(help.id);
        expect(input.value).toBe(USER_A);
      });
    }
  });

  it('Remove pilot user asks first (default focus Keep pilot user); on 200 the row leaves and focus moves to the next row', async () => {
    await withDoc(async (doc) => {
      const users = [pilotUser(1, 'a•••@e••••••.com'), pilotUser(2, 'b•••@e••••••.com')];
      const { pilot, calls } = await openPilot(doc, (path, init) => {
        if (init?.method === 'DELETE') return { ok: true, status: 200, body: { success: true } };
        if (path.startsWith('/api/rag/admin/pilot-users')) return { ok: true, status: 200, body: { success: true, users, next_cursor: null } };
        return { ok: true, status: 200, body: status() };
      });
      const first = pilot.querySelectorAll('tbody tr')[0].querySelector('button') as FakeElement;
      first.click();
      await flush();
      const dialog = doc.querySelector('dialog') as FakeElement;
      expect(dialog).toBeTruthy();
      expect(text(dialog)).toContain('Remove this pilot user?');
      expect(text(dialog)).toContain('a•••@e••••••.com goes back to the normal sampling rate.');
      expect(text(doc.activeElement)).toBe('Keep pilot user');
      const confirm = dialog.querySelectorAll('button').find((b) => text(b) === 'Remove pilot user') as FakeElement;
      confirm.click();
      await flush();
      await flush();
      expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/rag/admin/pilot-users?organizationId=${ORG}&user_id=${users[0].user_id}` });
      const rows = pilot.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(1);
      expect(text(doc.querySelector('[data-question-sources-status]'))).toBe('Pilot user removed.');
      expect(doc.activeElement).toBe(rows[0].querySelector('button'));
    });
  });

  it('Keep pilot user sends nothing; a 404 on remove says pilot.gone and reloads the list', async () => {
    await withDoc(async (doc) => {
      const users = [pilotUser(1)];
      const { pilot, calls } = await openPilot(doc, (path, init) => {
        if (init?.method === 'DELETE') return { ok: false, status: 404, body: { success: false, error: 'not_found' } };
        if (path.startsWith('/api/rag/admin/pilot-users')) return { ok: true, status: 200, body: { success: true, users, next_cursor: null } };
        return { ok: true, status: 200, body: status() };
      });
      const remove = pilot.querySelector('tbody button') as FakeElement;
      remove.click();
      await flush();
      (doc.querySelector('dialog') as FakeElement).querySelectorAll('button').find((b) => text(b) === 'Keep pilot user')!.click();
      await flush();
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
      remove.click();
      await flush();
      (doc.querySelector('dialog') as FakeElement).querySelectorAll('button').find((b) => text(b) === 'Remove pilot user')!.click();
      await flush();
      await flush();
      await flush();
      expect(text(doc.querySelector('[data-question-sources-status]'))).toBe('This pilot user was already removed. The list has been reloaded.');
      expect(calls.at(-1)).toMatchObject({ method: 'GET', path: `/api/rag/admin/pilot-users?organizationId=${ORG}` });
    });
  });

  it('60 pilot users: 50 rows, then Load more pilot users appends the rest and every Remove stays reachable', async () => {
    await withDoc(async (doc) => {
      const all = Array.from({ length: 60 }, (_, i) => pilotUser(i + 1));
      const { pilot, calls } = await openPilot(doc, (path) => {
        if (path.startsWith('/api/rag/admin/pilot-users') && path.includes('cursor=')) return { ok: true, status: 200, body: { success: true, users: all.slice(50), next_cursor: null } };
        if (path.startsWith('/api/rag/admin/pilot-users')) return { ok: true, status: 200, body: { success: true, users: all.slice(0, 50), next_cursor: 'CURSOR-1' } };
        return { ok: true, status: 200, body: status() };
      });
      expect(pilot.querySelectorAll('tbody tr')).toHaveLength(50);
      const more = buttonsByText(pilot, 'Load more pilot users');
      expect(more).toHaveLength(1);
      more[0].click();
      await flush();
      await flush();
      expect(calls.at(-1)?.path).toBe(`/api/rag/admin/pilot-users?organizationId=${ORG}&cursor=CURSOR-1`);
      const rows = pilot.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(60);
      expect(rows.every((r) => r.querySelector('button') && !(r.querySelector('button') as FakeElement).disabled)).toBe(true);
      expect(buttonsByText(pilot, 'Load more pilot users')).toHaveLength(0);
    });
  });

  it('renders server user ids and masked e-mails as text only, and never unmasks', async () => {
    await withDoc(async (doc) => {
      const users = [{ user_id: USER_A, masked_email: XSS, added_at: '2026-11-20T12:00:00Z' }];
      const { pilot } = await openPilot(doc, (path) =>
        path.startsWith('/api/rag/admin/pilot-users') ? { ok: true, status: 200, body: { success: true, users, next_cursor: null } } : { ok: true, status: 200, body: status() },
      );
      expect(text(pilot)).toContain(XSS);
      expect(injectedElements(doc)).toEqual([]);
      expect(doc.innerHtmlWrites).toBe(0);
    });
  });
});

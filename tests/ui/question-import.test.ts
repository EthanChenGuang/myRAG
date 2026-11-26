import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type FetchResult = { ok: boolean; status: number; body?: unknown };
type FetchInit = { method?: string; body?: string };
type Fetcher = (path: string, init?: FetchInit) => Promise<FetchResult>;

interface QuestionSources {
  QuestionSourcesPanel: new (root: unknown, deps: { fetcher: Fetcher; locale?: string; config?: () => Record<string, string> }) => {
    mount: () => Promise<void>;
    selectTab: (id: string) => Promise<void>;
  };
  questionSourcesReadHeader: (text: string, format: 'csv' | 'jsonl') => string[];
  questionSourcesBatches: (questions: string[], maxBytes: number, envelope?: Record<string, unknown>) => string[][];
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
const ON = () => ({ RAG_REPRESENTATIVE_SAMPLE: 'false', RAG_DOMAIN_EXPERT_REVIEW: 'true' });
const REVIEW_OFF = () => ({ RAG_REPRESENTATIVE_SAMPLE: 'false', RAG_DOMAIN_EXPERT_REVIEW: 'false' });
const flush = async (n = 3) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const utf8 = (value: string) => new TextEncoder().encode(value).length;

const storage = () => ({ getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() });
let local: ReturnType<typeof storage>;
let session: ReturnType<typeof storage>;
beforeEach(() => {
  local = storage();
  session = storage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
  const selector = doc.createElement('select');
  selector.id = 'workspace-selector';
  const option = doc.createElement('option');
  option.setAttribute('value', ORG);
  option.textContent = 'Workspace one';
  selector.appendChild(option);
  selector.value = ORG;
  doc.body.append(selector, root);
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

function counts(read: number, extra: Record<string, unknown> = {}) {
  return { success: true, read, added: read, duplicates: 0, rejected_pii: 0, truncated: 0, empty: 0, by_language: { en: read }, ...extra };
}

function importFetcher(answer: (body: Record<string, unknown>, index: number) => FetchResult) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher: Fetcher = async (path, init) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ path, body });
    return answer(body, calls.length - 1);
  };
  return { fetcher, calls };
}

async function openImport(doc: FakeDocument, fetcher: Fetcher, config = ON) {
  const { QuestionSourcesPanel } = load();
  const root = panelRoot(doc);
  const panel = new QuestionSourcesPanel(root, { fetcher, locale: 'en', config });
  await panel.mount();
  await panel.selectTab('import');
  await flush();
  const view = root.querySelector('[data-question-sources-view="import"]') as FakeElement;
  return { root, view };
}

function controls(view: FakeElement) {
  const file = view.querySelector('input[type="file"]') as FakeElement;
  const column = view.querySelector('select') as FakeElement;
  const fileMessage = view.querySelector('[data-question-sources-file-message]') as FakeElement;
  const button = (label: string) => view.querySelectorAll('button').find((b) => text(b).trim() === label) ?? null;
  return { file, column, fileMessage, button };
}

async function choose(file: FakeElement, name: string, content: string | null, size?: number) {
  (file as unknown as { files: unknown[] }).files = [
    {
      name,
      type: '',
      size: size ?? utf8(content ?? ''),
      text: async () => {
        if (content === null) throw new Error('unreadable');
        return content;
      },
    },
  ];
  file.dispatch('change');
  await flush();
}

function csv(n: number, header = 'id,question,channel') {
  const lines = [header];
  for (let i = 1; i <= n; i += 1) lines.push(`${i},"Neutral synthetic sentence number ${i}, with a comma",chat`);
  return lines.join('\n');
}

describe('questionSourcesReadHeader', () => {
  it('returns the CSV header cells or the keys of the first JSON line', () => {
    const { questionSourcesReadHeader } = load();
    expect(questionSourcesReadHeader('id, question ,"lang"\n1,a,en\n', 'csv')).toEqual(['id', 'question', 'lang']);
    expect(questionSourcesReadHeader('﻿question\nx\n', 'csv')).toEqual(['question']);
    expect(questionSourcesReadHeader('\n{"q":"a","meta":{"x":1}}\n{"q":"b"}\n', 'jsonl')).toEqual(['q', 'meta']);
    expect(questionSourcesReadHeader('[1,2]\n', 'jsonl')).toEqual([]);
    expect(questionSourcesReadHeader('', 'csv')).toEqual([]);
  });
});

describe('questionSourcesBatches', () => {
  it('never yields a JSON body over 60 KB and keeps every question exactly once in order', () => {
    const { questionSourcesBatches } = load();
    const questions: string[] = [];
    for (let i = 0; i < 3000; i += 1) questions.push(`Synthetic sentence ${i} ` + 'é"\\中'.repeat(i % 97) + (i % 13 === 0 ? 'x'.repeat(4000) : ''));
    const envelope = { organizationId: ORG, format: 'csv', column: 'c'.repeat(128), dry_run: false };
    const batches = questionSourcesBatches(questions, 60 * 1024, envelope);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(2000);
      expect(utf8(JSON.stringify({ ...envelope, rows: batch }))).toBeLessThanOrEqual(60 * 1024);
    }
    expect(batches.flat()).toEqual(questions);
  });

  it('reserves room for the request fields when no envelope is given', () => {
    const { questionSourcesBatches } = load();
    const questions = Array.from({ length: 500 }, (_, i) => `q${i} ` + 'y'.repeat(300));
    const batches = questionSourcesBatches(questions, 60 * 1024);
    const envelope = { organizationId: ORG, format: 'jsonl', column: 'c'.repeat(128), dry_run: true };
    for (const batch of batches) expect(utf8(JSON.stringify({ ...envelope, rows: batch }))).toBeLessThanOrEqual(60 * 1024);
    expect(batches.flat()).toEqual(questions);
  });
});

describe('Import questions view', () => {
  it('with no file: Check file is disabled and points at import.chooseFirst; the column select is disabled', async () => {
    await withDoc(async (doc) => {
      const { fetcher, calls } = importFetcher(() => ({ ok: true, status: 200, body: counts(0) }));
      const { view } = await openImport(doc, fetcher);
      const { file, column, button } = controls(view);
      expect(file.getAttribute('accept')).toBe('.csv,.jsonl,text/csv,application/x-ndjson');
      expect(column.disabled).toBe(true);
      const check = button('Check file') as FakeElement;
      expect(check.disabled).toBe(true);
      const described = doc.getElementById(String(check.getAttribute('aria-describedby')));
      expect(text(described)).toBe('Choose a file to check.');
      expect(button('Import questions')).toBeNull();
      expect(text(view)).toContain('Only counts are shown here, and the file is not kept.');
      expect(calls).toEqual([]);
    });
  });

  it('with expert review off the form is replaced by import.needs.review', async () => {
    await withDoc(async (doc) => {
      const { fetcher } = importFetcher(() => ({ ok: true, status: 200, body: counts(0) }));
      const { view } = await openImport(doc, fetcher, REVIEW_OFF);
      expect(view.querySelector('input[type="file"]')).toBeNull();
      expect(text(view)).toContain('Importing needs expert review switched on. Set RAG_DOMAIN_EXPERT_REVIEW to true.');
      expect(view.querySelectorAll('code').map((c) => text(c))).toContain('RAG_DOMAIN_EXPERT_REVIEW');
    });
  });

  it('fills the column select from the first line, inserting markup in column names as text only', async () => {
    await withDoc(async (doc) => {
      const { fetcher } = importFetcher(() => ({ ok: true, status: 200, body: counts(0) }));
      const { view } = await openImport(doc, fetcher);
      const { file, column, button } = controls(view);
      await choose(file, 'export.csv', `id,question,"${XSS}"\n1,Neutral synthetic sentence,x\n`);
      expect(column.disabled).toBe(false);
      expect(column.querySelectorAll('option').map((o) => text(o))).toEqual(['id', 'question', XSS]);
      expect(text(column.querySelectorAll('option')[Number(column.value)])).toBe('question');
      expect((button('Check file') as FakeElement).disabled).toBe(false);
      await choose(file, 'export.jsonl', `{"${XSS}":"Neutral synthetic sentence","q":"x"}\n`);
      expect(column.querySelectorAll('option').map((o) => text(o))).toEqual([XSS, 'q']);
      expect(injectedElements(doc)).toEqual([]);
      expect(doc.innerHtmlWrites).toBe(0);
    });
  });

  it('a 12 MB file and a file with 25,000 rows show import.tooLarge and send nothing', async () => {
    await withDoc(async (doc) => {
      const { fetcher, calls } = importFetcher(() => ({ ok: true, status: 200, body: counts(0) }));
      const { view } = await openImport(doc, fetcher);
      const { file, fileMessage, button } = controls(view);
      await choose(file, 'big.csv', 'question\nx\n', 12 * 1024 * 1024);
      expect(text(fileMessage)).toBe('This file is too large (limit: 10 MB, 20,000 rows). Split it and import the parts one after the other.');
      expect(fileMessage.classList.contains('text-error')).toBe(true);
      expect((button('Check file') as FakeElement).disabled).toBe(true);
      await choose(file, 'many.csv', csv(25000));
      expect(text(fileMessage)).toContain('This file is too large');
      expect((button('Check file') as FakeElement).disabled).toBe(true);
      expect(calls).toEqual([]);
    });
  });

  it('an unreadable file shows import.badFormat with a line number; a file without columns shows import.noColumn', async () => {
    await withDoc(async (doc) => {
      const { fetcher, calls } = importFetcher(() => ({ ok: true, status: 200, body: counts(0) }));
      const { view } = await openImport(doc, fetcher);
      const { file, fileMessage } = controls(view);
      await choose(file, 'broken.jsonl', '{"q":"a"}\n{"q":"b"}\nnot json at all\n');
      expect(text(fileMessage)).toBe('This file could not be read as CSV or JSONL. Line 3 is not valid. Fix the file and choose it again.');
      expect(text(fileMessage)).not.toContain('not json');
      await choose(file, 'gone.csv', null);
      expect(text(fileMessage)).toContain('This file could not be read as CSV or JSONL.');
      await choose(file, 'empty.csv', '\n\n');
      expect(text(fileMessage)).toBe('No column could be read from the first line. A CSV file needs a header row; a JSONL file needs one object per line.');
      await choose(file, 'array.jsonl', '[1,2,3]\n');
      expect(text(fileMessage)).toContain('No column could be read from the first line.');
      expect(calls).toEqual([]);
    });
  });

  it('Check file sends every batch as a dry run, sums the counts and renders Import questions only when something would be added', async () => {
    await withDoc(async (doc) => {
      const { fetcher, calls } = importFetcher((body) => ({ ok: true, status: 200, body: counts((body.rows as string[]).length, { added: 1, duplicates: (body.rows as string[]).length - 1, by_language: { en: 1, it: (body.rows as string[]).length - 1 } }) }));
      const { view } = await openImport(doc, fetcher);
      const { file, button } = controls(view);
      await choose(file, 'export.csv', csv(1500));
      (button('Check file') as FakeElement).click();
      await flush(10);
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        expect(call.path).toBe('/api/rag/admin/questions-import');
        expect(call.body).toMatchObject({ organizationId: ORG, format: 'csv', column: 'question', dry_run: true });
      }
      expect(calls.flatMap((c) => c.body.rows as string[])).toHaveLength(1500);
      expect((calls[0].body.rows as string[])[0]).toBe('Neutral synthetic sentence number 1, with a comma');
      const all = text(view);
      expect(all).toContain('Check result. Nothing was imported yet.');
      expect(all).toContain('Questions read');
      expect(all).toContain('1,500');
      expect(all).toContain('Would be added to the review queue');
      expect(all).not.toContain('Neutral synthetic sentence');
      expect(button('Import questions')).toBeTruthy();
      expect(button('Choose another file')).toBeTruthy();
      expect(button('Check file')).toBeNull();
      expect(view.querySelectorAll('.btn-primary')).toHaveLength(1);
    });
  });

  it('a check that would add nothing says import.nothingNew and renders no Import questions', async () => {
    await withDoc(async (doc) => {
      const { fetcher } = importFetcher((body) => ({ ok: true, status: 200, body: counts((body.rows as string[]).length, { added: 0, duplicates: (body.rows as string[]).length }) }));
      const { view } = await openImport(doc, fetcher);
      const { file, button } = controls(view);
      await choose(file, 'export.jsonl', '{"q":"Neutral synthetic sentence"}\n{"q":"Another neutral sentence"}\n');
      (button('Check file') as FakeElement).click();
      await flush(6);
      expect(text(view)).toContain('Nothing new to import: every question is already in the queue, was rejected or is empty.');
      expect(button('Import questions')).toBeNull();
      expect(button('Choose another file')).toBeTruthy();
    });
  });

  it('Import questions sends the batches for real with a determinate progress bar and the controls disabled, then shows import.result.done and import.done', async () => {
    await withDoc(async (doc) => {
      let gate: (() => void) | null = null;
      const { fetcher, calls } = importFetcher((body) => ({ ok: true, status: 200, body: counts((body.rows as string[]).length) }));
      const slow: Fetcher = async (path, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (body.dry_run === false && calls.filter((c) => c.body.dry_run === false).length === 0) await new Promise<void>((resolve) => (gate = resolve));
        return fetcher(path, init);
      };
      const { view, root } = await openImport(doc, slow);
      const { file, column, button } = controls(view);
      await choose(file, 'export.csv', csv(1500));
      (button('Check file') as FakeElement).click();
      await flush(10);
      (button('Import questions') as FakeElement).click();
      await flush();
      const progress = view.querySelector('progress') as FakeElement;
      expect(progress).toBeTruthy();
      expect(progress.getAttribute('max')).toBe('1500');
      expect(progress.getAttribute('value')).toBe('0');
      expect(progress.getAttribute('aria-label')).toBe('Import progress');
      expect(text(view)).toContain('0 of 1,500 questions');
      expect(file.disabled).toBe(true);
      expect(column.disabled).toBe(true);
      expect(view.querySelectorAll('button').every((b) => b.disabled || b.getAttribute('role') === 'tab')).toBe(true);
      gate!();
      await flush(10);
      const real = calls.filter((c) => c.body.dry_run === false);
      expect(real.flatMap((c) => c.body.rows as string[])).toHaveLength(1500);
      expect(text(view)).toContain('Import result');
      expect(text(view)).toContain('Added to the review queue');
      expect(text(root.querySelector('[data-question-sources-status]'))).toBe('Import finished. Questions added to the review queue: 1,500.');
      expect(button('Import questions')).toBeNull();
      expect(button('Choose another file')).toBeTruthy();
      expect(file.disabled).toBe(false);
    });
  });

  it('a 500 on the third batch stops the run and shows the sums of the first two with import.interrupted', async () => {
    await withDoc(async (doc) => {
      const { fetcher, calls } = importFetcher((body, index) => {
        if (body.dry_run === false && calls.filter((c) => c.body.dry_run === false).length === 3) return { ok: false, status: 500, body: null };
        void index;
        return { ok: true, status: 200, body: counts((body.rows as string[]).length) };
      });
      const { view, root } = await openImport(doc, fetcher);
      const { file, button } = controls(view);
      const questions = Array.from({ length: 900 }, (_, i) => JSON.stringify({ q: `Neutral synthetic sentence ${i} ` + 'z'.repeat(150) })).join('\n');
      await choose(file, 'export.jsonl', questions);
      (button('Check file') as FakeElement).click();
      await flush(12);
      (button('Import questions') as FakeElement).click();
      await flush(12);
      const real = calls.filter((c) => c.body.dry_run === false);
      expect(real).toHaveLength(3);
      const sent = (real[0].body.rows as string[]).length + (real[1].body.rows as string[]).length;
      const formatted = new Intl.NumberFormat('en').format(sent);
      expect(text(view)).toContain(`The import stopped after ${formatted} of 900 questions.`);
      const countsTable = view.querySelector('[data-question-sources-counts]') as FakeElement;
      expect(text(countsTable)).toContain(formatted);
      expect(button('Import questions')).toBeTruthy();
      expect(text(root.querySelector('[data-question-sources-status]'))).not.toBe('');
    });
  });

  it('nothing from the file is written to web storage', async () => {
    await withDoc(async (doc) => {
      const { fetcher } = importFetcher((body) => ({ ok: true, status: 200, body: counts((body.rows as string[]).length) }));
      const { view } = await openImport(doc, fetcher);
      const { file, button } = controls(view);
      await choose(file, 'export.csv', csv(20));
      (button('Check file') as FakeElement).click();
      await flush(6);
      (button('Import questions') as FakeElement).click();
      await flush(6);
      expect(local.setItem).not.toHaveBeenCalled();
      expect(session.setItem).not.toHaveBeenCalled();
    });
  });

  it('Choose another file clears the result and the column select', async () => {
    await withDoc(async (doc) => {
      const { fetcher } = importFetcher((body) => ({ ok: true, status: 200, body: counts((body.rows as string[]).length) }));
      const { view } = await openImport(doc, fetcher);
      const { file, column, button } = controls(view);
      await choose(file, 'export.csv', csv(5));
      (button('Check file') as FakeElement).click();
      await flush(6);
      (button('Choose another file') as FakeElement).click();
      await flush();
      expect(file.value).toBe('');
      expect(column.disabled).toBe(true);
      expect(column.querySelectorAll('option')).toHaveLength(0);
      expect(text(view)).not.toContain('Check result');
      expect((button('Check file') as FakeElement).disabled).toBe(true);
      expect(doc.activeElement).toBe(file);
    });
  });
});

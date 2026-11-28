import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

/** SEC-11 (plan 07-48, 07-UI-SPEC 6.3, 7.3, 8.4): the Red-team runs panel. Technique ids and labels are synthetic placeholders. */

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type Reply = { ok: boolean; status: number; body?: unknown; thrown?: boolean };
type Call = { url: string; method: string; body?: string; timeoutMs?: number };

interface Panel {
  mount(): Promise<void>;
  poll(): Promise<void>;
  run: { id: string; state: string } | null;
}

const mod = require('../../scripts/config-ui/rag-panels/red-team.js') as {
  RED_TEAM_LABELS: Record<Locale, Record<string, string>>;
  RED_TEAM_POLL_MS: number;
  RedTeamPanel: new (root: unknown, deps: Record<string, unknown>) => Panel;
  redTeamResultView: (run: unknown) => { rows: Array<{ technique: string; language: string }>; total: { attacks: number; successes: number } };
};

const RUN_ID = '00000000-0000-4000-8000-0000000048f1';
const XSS = '<img src=x onerror=PWNED(1)><script>PWNED(2)</script>';

function text(node: FakeNode | null | undefined): string {
  if (!node) return '';
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

function finishedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    state: 'finished',
    startedAt: '2026-11-01T10:00:00.000Z',
    finishedAt: '2026-11-01T10:07:00.000Z',
    progress: { done: 5, total: 5 },
    cells: [
      { technique: 'zeta_family', techniqueLabel: 'Zeta family', language: 'en', attacks: 3, successes: 2 },
      { technique: 'alpha_family', techniqueLabel: 'Alpha family', language: 'zh', attacks: 2, successes: 0 },
    ],
    reviewCasesOpened: 2,
    casesSkippedReason: null,
    errorCode: null,
    ...overrides,
  };
}

function runningRun(progress = { done: null as number | null, total: null as number | null }) {
  return { ...finishedRun(), state: 'running', finishedAt: null, progress, cells: [], reviewCasesOpened: null };
}

function setup(options: { replies: Record<string, Reply | Reply[]>; locale?: Locale; review?: boolean; withReviewPanel?: boolean }) {
  const doc = new FakeDocument();
  const root = doc.createElement('section');
  root.id = 'rag-administration-red-team';
  for (const name of ['title', 'description', 'alert', 'content', 'status']) {
    const el = doc.createElement(name === 'title' ? 'h3' : 'div');
    el.setAttribute('data-red-team-' + name, '');
    if (name === 'status') {
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
    }
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  if (options.withReviewPanel) {
    const review = doc.createElement('section');
    review.id = 'rag-administration-review';
    const h3 = doc.createElement('h3');
    h3.setAttribute('tabindex', '-1');
    review.appendChild(h3);
    doc.body.appendChild(review);
  }
  const calls: Call[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const fetcher = async (url: string, init: { method?: string; body?: string } = {}, timeoutMs?: number) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body, timeoutMs });
    const key = `${method} ${url}`;
    const configured = options.replies[key];
    if (Array.isArray(configured)) return configured.length > 1 ? configured.shift()! : configured[0];
    return configured ?? { ok: false, status: 0, thrown: true };
  };
  const panel = new mod.RedTeamPanel(root, {
    doc,
    locale: options.locale ?? 'en',
    configFetcher: fetcher,
    config: () => ({ RAG_DOMAIN_EXPERT_REVIEW: options.review === false ? 'false' : 'true' }),
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
    isVisible: () => true,
  });
  const part = (name: string) => root.querySelector(`[data-red-team-${name}]`) as FakeElement;
  return { doc, root, panel, calls, timers, part };
}

const LIST = 'GET /api/red-team/runs';
const RUN = `GET /api/red-team/runs/${RUN_ID}`;
const START = 'POST /api/red-team/runs';

async function confirmStart(ctx: ReturnType<typeof setup>) {
  const start = ctx.root.querySelector('[data-red-team-start]') as FakeElement;
  start.click();
  await Promise.resolve();
  const dialog = ctx.doc.body.querySelector('dialog') as FakeElement;
  expect(dialog).toBeTruthy();
  const confirm = dialog.querySelectorAll('button').find((b) => text(b) === 'Start red-team run') as FakeElement;
  confirm.click();
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  return dialog;
}

describe('Red-team runs panel', () => {
  it('no run yet: one GET on mount, the empty block, the run-configuration select with the current-settings option first', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: null, runConfigs: ['a-run.json', 'b-run.json'] } } } });
    await ctx.panel.mount();
    expect(ctx.calls).toEqual([{ url: '/api/red-team/runs', method: 'GET', body: undefined, timeoutMs: undefined }]);
    expect(ctx.root.querySelector('[data-red-team-empty]')).toBeTruthy();
    expect(text(ctx.part('content'))).toContain('No red-team run yet');
    const options = ctx.root.querySelectorAll('option').map((o) => [o.getAttribute('value'), text(o)]);
    expect(options).toEqual([
      ['', 'Current deployment settings'],
      ['a-run.json', 'a-run.json'],
      ['b-run.json', 'b-run.json'],
    ]);
    const select = ctx.root.querySelector('select') as FakeElement;
    const label = ctx.root.querySelector('label') as FakeElement;
    expect(label.getAttribute('for')).toBe(select.id);
    const start = ctx.root.querySelector('[data-red-team-start]') as FakeElement;
    expect(text(start)).toBe('Start red-team run');
    expect(start.className).toContain('btn-primary');
    expect(start.disabled).toBe(false);
  });

  it('finished: table with caption, header cells, rows sorted by technique label, total row, review cases and Open Review queue', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: finishedRun(), runConfigs: [] } } }, withReviewPanel: true });
    await ctx.panel.mount();
    const table = ctx.root.querySelector('table') as FakeElement;
    expect(text(table.querySelector('caption'))).toBe('Attack results by technique and language');
    expect(table.querySelectorAll('th').filter((th) => th.getAttribute('scope') === 'col')).toHaveLength(5);
    const rowHeads = table.querySelectorAll('tbody th').map((th) => th.getAttribute('scope'));
    expect(rowHeads.every((s) => s === 'row')).toBe(true);
    const rows = table.querySelectorAll('tbody tr').map((tr) => text(tr));
    expect(rows[0]).toContain('Alpha family');
    expect(rows[0]).toContain('alpha_family');
    expect(rows[1]).toContain('Zeta family');
    expect(rows[2]).toContain('All techniques');
    const region = table.parentNode as FakeElement;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).toBe('0');
    const content = text(ctx.part('content'));
    expect(content).toContain('Finished');
    expect(content).toContain('Attacks replayed: 5');
    expect(content).toContain('Attacks that succeeded: 2');
    expect(content).toContain('Review cases opened: 2');
    expect(content).toContain('40.0%');
    expect(content).not.toContain(RUN_ID);
    expect(ctx.root.querySelectorAll('button').some((b) => text(b) === 'Open Review queue')).toBe(true);
    expect(ctx.root.querySelector('[data-red-team-none]')).toBeNull();
  });

  it('finished with no success shows result.none; skipped cases show meta.casesSkipped', async () => {
    const run = finishedRun({
      cells: [{ technique: 'alpha_family', techniqueLabel: 'Alpha family', language: 'en', attacks: 2, successes: 0 }],
      casesSkippedReason: 'domain_expert_review_off',
      reviewCasesOpened: 0,
    });
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: run, runConfigs: [] } } } });
    await ctx.panel.mount();
    expect(ctx.root.querySelector('[data-red-team-none]')).toBeTruthy();
    expect(text(ctx.part('content'))).toContain('Review cases opened: none, because expert review is switched off');
  });

  it('running with a known total: progress bar, start disabled with the busy reason referenced, polling every 5 seconds', async () => {
    const ctx = setup({
      replies: {
        [LIST]: { ok: true, status: 200, body: { latest: runningRun({ done: 2, total: 8 }), runConfigs: [] } },
        [RUN]: { ok: true, status: 200, body: { run: finishedRun() } },
      },
    });
    await ctx.panel.mount();
    const progress = ctx.root.querySelector('progress') as FakeElement;
    expect(progress.getAttribute('max')).toBe('8');
    expect(progress.getAttribute('value')).toBe('2');
    expect(progress.getAttribute('aria-label')).toBe('Replayed: 2 of 8');
    const start = ctx.root.querySelector('[data-red-team-start]') as FakeElement;
    expect(start.disabled).toBe(true);
    const reason = ctx.root.querySelector('#' + start.getAttribute('aria-describedby')) as FakeElement;
    expect(text(reason)).toBe('A red-team run is already in progress. Its status is shown below.');
    expect(ctx.timers.map((t) => t.ms)).toEqual([mod.RED_TEAM_POLL_MS]);
    expect(mod.RED_TEAM_POLL_MS).toBe(5000);
    await ctx.panel.poll();
    expect(ctx.calls.at(-1)).toMatchObject({ url: `/api/red-team/runs/${RUN_ID}`, method: 'GET' });
    expect(text(ctx.part('status'))).toBe('Red-team run finished. Attacks that succeeded: 2.');
    expect(ctx.root.querySelector('table')).toBeTruthy();
  });

  it('running without a total shows the spinner with the unknown-progress text; the status region is polite', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: runningRun(), runConfigs: [] } } } });
    await ctx.panel.mount();
    expect(ctx.root.querySelector('progress')).toBeNull();
    expect(text(ctx.part('content'))).toContain('Running…');
    const status = ctx.part('status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(text(status)).toBe('');
  });

  it('a poll that re-renders keeps focus on the control the admin was using', async () => {
    const ctx = setup({
      replies: {
        [LIST]: { ok: true, status: 200, body: { latest: runningRun({ done: 1, total: 4 }), runConfigs: ['a-run.json'] } },
        [RUN]: { ok: true, status: 200, body: { run: runningRun({ done: 2, total: 4 }) } },
      },
    });
    await ctx.panel.mount();
    (ctx.root.querySelector('select') as FakeElement).focus();
    await ctx.panel.poll();
    const active = ctx.doc.activeElement as FakeElement | null;
    expect(active?.id).toBe('red-team-run-config');
    expect(active?.isConnected).toBe(true);
    expect((ctx.root.querySelector('progress') as FakeElement).getAttribute('value')).toBe('2');
  });

  it('polling stops after three failed reads with poll.stalled and Refresh status; a 404 shows error.gone and the empty block', async () => {
    const ctx = setup({
      replies: {
        [LIST]: { ok: true, status: 200, body: { latest: runningRun(), runConfigs: [] } },
        [RUN]: { ok: false, status: 500, body: {} },
      },
    });
    await ctx.panel.mount();
    await ctx.panel.poll();
    await ctx.panel.poll();
    await ctx.panel.poll();
    expect(text(ctx.part('status'))).toContain('could not be read three times in a row');
    expect(ctx.root.querySelectorAll('button').filter((b) => text(b) === 'Refresh status').length).toBeGreaterThan(0);

    const gone = setup({
      replies: { [LIST]: { ok: true, status: 200, body: { latest: runningRun(), runConfigs: [] } }, [RUN]: { ok: false, status: 404, body: {} } },
    });
    await gone.panel.mount();
    await gone.panel.poll();
    expect(text(gone.part('alert'))).toContain('no longer on this machine');
    expect(gone.root.querySelector('[data-red-team-empty]')).toBeTruthy();
  });

  it('failed: run.failed with the code in font-mono, start enabled again', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: finishedRun({ state: 'failed', cells: [], errorCode: 'runner_refused' }), runConfigs: [] } } } });
    await ctx.panel.mount();
    const code = ctx.part('content').querySelectorAll('code').find((c) => text(c) === 'runner_refused');
    expect(code?.className).toContain('font-mono');
    expect(text(ctx.part('content'))).toContain('The red-team run failed (runner_refused).');
    expect((ctx.root.querySelector('[data-red-team-start]') as FakeElement).disabled).toBe(false);
  });

  it('start: confirm dialog backs out first, POST sends only the run configuration name, then announces the start and polls', async () => {
    const ctx = setup({
      replies: {
        [LIST]: { ok: true, status: 200, body: { latest: null, runConfigs: ['a-run.json'] } },
        [START]: { ok: true, status: 202, body: { run: runningRun() } },
      },
    });
    await ctx.panel.mount();
    const select = ctx.root.querySelector('select') as FakeElement;
    select.value = 'a-run.json';
    select.dispatch('change');
    const start = ctx.root.querySelector('[data-red-team-start]') as FakeElement;
    start.click();
    await Promise.resolve();
    const dialog = ctx.doc.body.querySelector('dialog') as FakeElement;
    expect(ctx.doc.activeElement && text(ctx.doc.activeElement as FakeElement)).toBe('Close without starting');
    expect(text(dialog)).toContain('Start a red-team run?');
    const confirm = dialog.querySelectorAll('button').find((b) => text(b) === 'Start red-team run') as FakeElement;
    confirm.click();
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    const post = ctx.calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({ runConfig: 'a-run.json' });
    expect(post.timeoutMs).toBe(30000);
    expect(text(ctx.part('status'))).toBe('Red-team run started.');
    expect(ctx.timers.length).toBe(1);
  });

  for (const [status, expected] of [
    [401, 'Sign in'],
    [403, 'Only an operator admin can start a red-team run.'],
    [503, 'The admin check is unavailable right now, so no run was started.'],
    [400, 'That run configuration is not available.'],
  ] as const) {
    it(`start answered ${status}: shows the mapped sentence`, async () => {
      const ctx = setup({
        replies: { [LIST]: { ok: true, status: 200, body: { latest: null, runConfigs: [] } }, [START]: { ok: false, status, body: { code: 'x' } } },
      });
      await ctx.panel.mount();
      await confirmStart(ctx);
      expect(text(ctx.root)).toContain(expected);
    });
  }

  it('start answered 409: the busy sentence and the run named by runningRunId is loaded', async () => {
    const ctx = setup({
      replies: {
        [LIST]: { ok: true, status: 200, body: { latest: null, runConfigs: [] } },
        [START]: { ok: false, status: 409, body: { code: 'run_active', runningRunId: RUN_ID } },
        [RUN]: { ok: true, status: 200, body: { run: runningRun() } },
      },
    });
    await ctx.panel.mount();
    await confirmStart(ctx);
    expect(text(ctx.part('alert'))).toContain('A red-team run is already in progress.');
    expect(ctx.calls.some((c) => c.url === `/api/red-team/runs/${RUN_ID}`)).toBe(true);
    expect(ctx.panel.run?.state).toBe('running');
  });

  it('expert review off: the switched-off notice; the dialog adds the no-cases sentence', async () => {
    const ctx = setup({ review: false, replies: { [LIST]: { ok: true, status: 200, body: { latest: null, runConfigs: [] } } } });
    await ctx.panel.mount();
    expect(text(ctx.part('alert'))).toContain('Expert review is switched off.');
    (ctx.root.querySelector('[data-red-team-start]') as FakeElement).click();
    await Promise.resolve();
    expect(text(ctx.doc.body.querySelector('dialog'))).toContain('so no review case will be opened');
  });

  it('server strings are inert text: no element is created from technique labels, ids or error codes', async () => {
    const run = finishedRun({ cells: [{ technique: XSS, techniqueLabel: XSS, language: XSS, attacks: 1, successes: 1 }] });
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: run, runConfigs: [XSS] } } } });
    await ctx.panel.mount();
    expect(injectedElements(ctx.doc)).toEqual([]);
    expect(ctx.root.querySelectorAll('script')).toHaveLength(0);
    const failed = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: finishedRun({ state: 'failed', errorCode: XSS }), runConfigs: [] } } } });
    await failed.panel.mount();
    expect(injectedElements(failed.doc)).toEqual([]);
  });

  it('a technique without a label shows its id once, in font-mono', async () => {
    const run = finishedRun({ cells: [{ technique: 'beta_family', techniqueLabel: 'beta_family', language: 'en', attacks: 1, successes: 0 }] });
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: { latest: run, runConfigs: [] } } } });
    await ctx.panel.mount();
    const head = ctx.root.querySelector('tbody th') as FakeElement;
    const spans = head.querySelectorAll('span').filter((s) => text(s) === 'beta_family');
    expect(spans).toHaveLength(1);
    expect(spans[0].className).toContain('font-mono');
  });

  it('every key has en, zh and it text', () => {
    const keys = Object.keys(mod.RED_TEAM_LABELS.en).sort();
    expect(Object.keys(mod.RED_TEAM_LABELS.zh).sort()).toEqual(keys);
    expect(Object.keys(mod.RED_TEAM_LABELS.it).sort()).toEqual(keys);
  });

  it('a load failure shows the unavailable alert with Reload panel', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: false, status: 500, body: null } } });
    await ctx.panel.mount();
    expect(text(ctx.part('alert'))).toContain('could not be read from the Config UI server');
    expect(ctx.part('alert').querySelectorAll('button').some((b) => text(b) === 'Reload panel')).toBe(true);
  });
});

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, FakeText, injectedElements, type FakeNode } from './helpers/html-fake-dom';

/** LANG-11 (plan 07-49, 07-UI-SPEC 6.4, 7.4, 8.4, 12.4): the Rollouts panel. Profile ids and workspace keys are synthetic. */

const require = createRequire(import.meta.url);

type Locale = 'en' | 'zh' | 'it';
type Reply = { ok: boolean; status: number; body?: unknown; thrown?: boolean };
type Call = { path: string; method: string; body?: string; timeoutMs?: number };

interface Panel {
  mount(): Promise<void>;
}

const mod = require('../../scripts/config-ui/rag-panels/rollouts.js') as {
  ROLLOUTS_LABELS: Record<Locale, Record<string, string>>;
  RolloutsPanel: new (root: unknown, deps: Record<string, unknown>) => Panel;
  rolloutsRefusal: (code: string, locale: Locale) => { text?: string; template?: string; vars?: Record<string, string> };
  rolloutsValidateForm: (form: Record<string, string>, locale: Locale, active: string[]) => { ok: boolean; errors: Record<string, string>; payload: unknown };
};

const ROLLOUT_ID = '00000000-0000-4000-8000-0000000000aa';
const A = 'o:00000000-0000-4000-8000-000000000001';
const X = 'o:00000000-0000-4000-8000-000000000009';
const XSS = '<img src=x onerror=PWNED(1)><script>PWNED(2)</script>';
const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const PATH = '/api/rag/admin/rollouts';
const LIST = `GET ${PATH}`;
const POST = `POST ${PATH}`;

function text(node: FakeNode | null | undefined): string {
  if (!node) return '';
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

function measure(name: string, candidate: number | null, verdict: string) {
  return { measure: name, candidate: { value: candidate, n: 240 }, before: { value: 0.115, n: 260 }, others: { value: 0.118, n: 2400 }, verdict };
}

function activeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ROLLOUT_ID,
    kind: 'embedding_profile',
    candidate: ['profile-b'],
    incumbent: ['profile-a'],
    mode: 'share',
    share: 10,
    state: 'active',
    createdAt: '2026-11-21T00:00:00.000Z',
    included: [A],
    excluded: [X],
    arms: { candidate: 14, incumbent: 126 },
    languages: [
      { language: 'en', measures: [measure('refusal_rate', 0.12, 'holds'), measure('not_helpful_rate', 0.083, 'holds'), measure('judge_score', null, 'unmeasured')] },
      { language: 'it', measures: [measure('refusal_rate', 0.194, 'worse')] },
    ],
    ...overrides,
  };
}

function listBody(active: unknown[] = [activeEntry()], ended: unknown[] = []) {
  return { active, ended, policy: { observationDays: 7, minSamples: 30 } };
}

function setup(options: { replies: Record<string, Reply | Reply[]>; locale?: Locale; config?: Record<string, string> }) {
  const doc = new FakeDocument();
  const root = doc.createElement('section');
  root.id = 'rag-administration-rollouts';
  for (const name of ['title', 'description', 'alert', 'content', 'status']) {
    const el = doc.createElement(name === 'title' ? 'h3' : 'div');
    el.setAttribute('data-rollouts-' + name, '');
    if (name === 'status') {
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
    }
    root.appendChild(el);
  }
  doc.body.appendChild(root);
  const calls: Call[] = [];
  const request = async (requestPath: string, init: { method?: string; body?: string } = {}, timeoutMs?: number) => {
    const method = init.method || 'GET';
    calls.push({ path: requestPath, method, body: init.body, timeoutMs });
    const configured = options.replies[`${method} ${requestPath}`];
    if (Array.isArray(configured)) return configured.length > 1 ? configured.shift()! : configured[0];
    return configured ?? { ok: false, status: 0, thrown: true };
  };
  const panel = new mod.RolloutsPanel(root, { doc, locale: options.locale ?? 'en', request, config: () => options.config ?? { RAG_PIPELINE: 'v2' }, now: () => NOW });
  const part = (name: string) => root.querySelector(`[data-rollouts-${name}]`) as FakeElement;
  return { doc, root, panel, calls, part };
}

async function settle() {
  for (let i = 0; i < 15; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function button(scope: FakeElement | FakeDocument, label: string): FakeElement {
  const found = scope.querySelectorAll('button').find((b) => text(b) === label);
  expect(found, label).toBeTruthy();
  return found as FakeElement;
}

async function confirmDialog(ctx: ReturnType<typeof setup>, confirmLabel: string) {
  await Promise.resolve();
  const dialog = ctx.doc.body.querySelector('dialog') as FakeElement;
  expect(dialog).toBeTruthy();
  button(dialog, confirmLabel).click();
  await settle();
  return dialog;
}

describe('Rollouts panel', () => {
  it('switched off: the info alert with RAG_ROLLOUTS in code, no button, no form, no table', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: false, status: 404 } } });
    await ctx.panel.mount();
    const alert = text(ctx.part('alert'));
    expect(alert).toContain('Rollouts are switched off');
    expect(ctx.part('alert').querySelector('code')?.textContent).toBe('RAG_ROLLOUTS');
    expect(ctx.root.querySelectorAll('button')).toHaveLength(0);
    expect(ctx.root.querySelector('table')).toBeNull();
    expect(ctx.root.querySelector('form')).toBeNull();
  });

  it('401 shows the sign-in message; 5xx the unavailable sentence with Reload panel', async () => {
    const signIn = setup({ replies: { [LIST]: { ok: false, status: 401 } } });
    await signIn.panel.mount();
    expect(signIn.part('alert').querySelector('.bi-person-lock')).toBeTruthy();
    expect(signIn.root.querySelector('[data-rollouts-card]')).toBeNull();
    const down = setup({ replies: { [LIST]: { ok: false, status: 503 } } });
    await down.panel.mount();
    expect(text(down.part('alert'))).toContain('Rollouts are unavailable right now.');
    button(down.part('alert'), 'Reload panel');
  });

  it('empty: the centred block under New rollout', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody([], []) } } });
    await ctx.panel.mount();
    expect(text(ctx.root.querySelector('[data-rollouts-empty]'))).toContain('No rollout in progress');
    button(ctx.root, 'New rollout');
  });

  it('card: kind, candidate, mode and share, days, arms, keys, the comparison table with n and verdicts, never the id', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody() } } });
    await ctx.panel.mount();
    const card = ctx.root.querySelector('[data-rollouts-card]') as FakeElement;
    const content = text(card);
    expect(content).toContain('Embedding profile: profile-b');
    expect(content).toContain('Share of workspaces: 10%');
    expect(content).toContain('Days running: 7');
    expect(content).toContain('Observation period: 7 days');
    expect(content).toContain('Current for everyone else: profile-a');
    expect(content).toContain('Workspaces on the candidate: 14');
    expect(content).toContain('Workspaces on the current one: 126');
    expect(content).toContain('Included: 1');
    expect(content).toContain('Excluded: 1');
    expect(content).toContain(A);
    expect(content).not.toContain(ROLLOUT_ID);
    const table = card.querySelector('table') as FakeElement;
    expect(text(table.querySelector('caption'))).toBe('Quality per language: profile-b');
    expect(table.querySelectorAll('th').filter((th) => th.getAttribute('scope') === 'col')).toHaveLength(6);
    expect(table.querySelectorAll('tbody th').every((th) => th.getAttribute('scope') === 'row')).toBe(true);
    const rows = table.querySelectorAll('tbody tr').map(text);
    expect(rows[0]).toContain('12.0%');
    expect(rows[0]).toContain('n = 240');
    expect(rows[0]).toContain('n = 2,400');
    expect(rows[0]).toContain('Holds');
    expect(rows[2]).toContain('No data');
    expect(rows[2]).toContain('Not measured');
    expect(rows[3]).toContain('Got worse');
    expect((table.parentNode as FakeElement).getAttribute('role')).toBe('region');
    expect(card.querySelector('[data-rollouts-ready]')?.getAttribute('data-rollouts-ready')).toBe('blocked');
    expect(button(card, 'Promote rollout').className).toContain('btn-primary');
    expect(button(card, 'Roll back rollout').className).not.toContain('btn-primary');
    expect(card.querySelectorAll('button').filter((b) => b.className.includes('btn-error'))).toHaveLength(0);
  });

  it('start form: invalid input marks the fields, focuses the first and sends nothing; valid input confirms then POSTs start', async () => {
    const ctx = setup({
      replies: {
        [LIST]: [
          { ok: true, status: 200, body: listBody([activeEntry()]) },
          { ok: true, status: 200, body: listBody([activeEntry(), activeEntry({ id: '00000000-0000-4000-8000-0000000000ab', kind: 'chunking_profile', candidate: ['general:cp-b'] })]) },
        ],
        [POST]: { ok: true, status: 201, body: { id: '00000000-0000-4000-8000-0000000000ab', kind: 'chunking_profile' } },
      },
    });
    await ctx.panel.mount();
    button(ctx.root, 'New rollout').click();
    const kind = ctx.doc.getElementById('rollouts-form-kind') as FakeElement;
    const embedding = kind.querySelectorAll('option').find((o) => o.getAttribute('value') === 'embedding_profile') as FakeElement;
    expect(embedding.hasAttribute('disabled')).toBe(true);
    expect((kind as unknown as { value: string }).value).toBe('chunking_profile');

    (kind as unknown as { value: string }).value = 'chunking_profile';
    kind.dispatch('change');
    const tenants = ctx.doc.getElementById('rollouts-form-tenants') as FakeElement & { value: string };
    tenants.value = `${A}\nnot-a-key`;
    tenants.dispatch('input');
    button(ctx.root, 'Start rollout').click();
    await settle();
    const candidate = ctx.doc.getElementById('rollouts-form-candidate') as FakeElement & { value: string };
    expect(candidate.getAttribute('aria-invalid')).toBe('true');
    expect(ctx.doc.activeElement).toBe(candidate);
    expect(ctx.doc.getElementById('rollouts-form-tenants')?.getAttribute('aria-invalid')).toBe('true');
    expect(text(ctx.root.querySelector('#rollouts-form'))).toContain('Line 2 is not a workspace key.');
    expect(ctx.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    candidate.value = 'general:cp-b';
    candidate.dispatch('input');
    const tenants2 = ctx.doc.getElementById('rollouts-form-tenants') as FakeElement & { value: string };
    tenants2.value = A.toUpperCase();
    tenants2.dispatch('input');
    button(ctx.root, 'Start rollout').click();
    const dialog = await confirmDialog(ctx, 'Start rollout');
    expect(text(dialog)).toContain('Start this rollout?');
    expect(text(dialog)).toContain('general:cp-b');
    const post = ctx.calls.find((call) => call.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({ action: 'start', kind: 'chunking_profile', candidate: ['general:cp-b'], mode: 'tenants', tenants: [A] });
    expect(post.body).not.toContain('salt');
    expect(text(ctx.part('status'))).toBe('Rollout started.');
    expect(ctx.root.querySelector('#rollouts-form')).toBeNull();
  });

  it('start form: a 409 for an active rollout keeps the values and shows the sentence at the form', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody([]) }, [POST]: { ok: false, status: 409, body: { code: 'active_exists' } } } });
    await ctx.panel.mount();
    button(ctx.root, 'New rollout').click();
    const candidate = ctx.doc.getElementById('rollouts-form-candidate') as FakeElement & { value: string };
    candidate.value = 'profile-b';
    candidate.dispatch('input');
    const share = ctx.doc.getElementById('rollouts-form-mode-share') as FakeElement & { checked: boolean };
    share.checked = true;
    share.dispatch('change');
    const shareInput = ctx.doc.getElementById('rollouts-form-share') as FakeElement & { value: string };
    shareInput.value = '10';
    shareInput.dispatch('input');
    button(ctx.root, 'Start rollout').click();
    await confirmDialog(ctx, 'Start rollout');
    expect(text(ctx.root.querySelector('[data-rollouts-form-refusal]'))).toContain('A rollout of this kind is already in progress.');
    expect((ctx.doc.getElementById('rollouts-form-candidate') as unknown as { value: string }).value).toBe('profile-b');
  });

  it('promote refused: 409 { code } becomes a plain-words warning inside the card and in the status region', async () => {
    for (const [code, sentence] of [
      ['rollout_observation_too_short', 'has not run long enough yet'],
      ['rollout_monitoring_insufficient:it', 'Italian has too few questions'],
      ['rollout_language_drop:it:refusal_rate', '“Information not available” answers'],
      ['external_not_ready:qdrant', 'Qdrant is not ready'],
      ['activation_refused: incomplete', 'activation_refused: incomplete'],
    ]) {
      const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody() }, [POST]: { ok: false, status: 409, body: { code } } } });
      await ctx.panel.mount();
      button(ctx.root.querySelector('[data-rollouts-card]') as FakeElement, 'Promote rollout').click();
      const dialog = await confirmDialog(ctx, 'Promote rollout');
      expect(text(dialog)).toContain('Promote profile-b to every workspace?');
      const refusal = ctx.root.querySelector('[data-rollouts-refusal]') as FakeElement;
      expect(text(refusal), code).toContain(sentence);
      expect(text(refusal)).toContain('Not promoted.');
      expect(text(ctx.part('status'))).toContain('Not promoted.');
      expect(ctx.root.querySelector('[data-rollouts-card]')).toBeTruthy();
      expect(JSON.parse(ctx.calls.find((call) => call.method === 'POST')!.body!)).toEqual({ action: 'promote', rolloutId: ROLLOUT_ID });
    }
  });

  it('promote accepted, roll back and exclude: confirmation, POST, announced in the polite status region', async () => {
    const ended = { id: ROLLOUT_ID, kind: 'embedding_profile', candidate: ['profile-b'], state: 'promoted', endedAt: '2026-11-28T00:00:00.000Z' };
    const ctx = setup({
      replies: {
        [LIST]: [{ ok: true, status: 200, body: listBody() }, { ok: true, status: 200, body: listBody([], [ended]) }],
        [POST]: { ok: true, status: 200, body: { id: ROLLOUT_ID, state: 'promoted' } },
      },
    });
    await ctx.panel.mount();
    button(ctx.root, 'Promote rollout').click();
    await confirmDialog(ctx, 'Promote rollout');
    expect(ctx.part('status').getAttribute('aria-live')).toBe('polite');
    expect(text(ctx.part('status'))).toBe('Promoted. profile-b is now active for every workspace.');
    expect(ctx.root.querySelector('[data-rollouts-card]')).toBeNull();
    expect(text(ctx.root.querySelector('table'))).toContain('Promoted');

    const back = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody() }, [POST]: { ok: true, status: 200, body: { id: ROLLOUT_ID, state: 'rolled_back' } } } });
    await back.panel.mount();
    button(back.root, 'Roll back rollout').click();
    const dialog = await confirmDialog(back, 'Roll back rollout');
    expect(text(dialog)).toContain('Keep rollout running');
    expect(text(back.part('status'))).toBe('Rollout rolled back. Every workspace is on the current one.');

    const exclude = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody() }, [POST]: { ok: true, status: 200, body: {} } } });
    await exclude.panel.mount();
    const row = exclude.root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === `Exclude workspace: ${A}`) as FakeElement;
    row.click();
    await confirmDialog(exclude, 'Exclude workspace');
    expect(JSON.parse(exclude.calls.find((call) => call.method === 'POST')!.body!)).toEqual({ action: 'exclude', rolloutId: ROLLOUT_ID, tenant: A });
    expect(text(exclude.part('status'))).toBe(`${A} is excluded and back on the current one.`);
  });

  it('include by key: a malformed key is marked at the field and nothing is sent; a 404 reloads with the changed sentence', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody() }, [POST]: { ok: false, status: 404, body: {} } } });
    await ctx.panel.mount();
    const input = ctx.doc.getElementById('rollouts-tenant-key-embedding_profile') as FakeElement & { value: string };
    input.value = 'u:not-a-uuid';
    input.dispatch('input');
    (ctx.root.querySelector('[data-rollouts-key-action="include"]') as FakeElement).click();
    await settle();
    expect(ctx.doc.getElementById('rollouts-tenant-key-embedding_profile')?.getAttribute('aria-invalid')).toBe('true');
    expect(ctx.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const again = ctx.doc.getElementById('rollouts-tenant-key-embedding_profile') as FakeElement & { value: string };
    again.value = 'S:DEFAULT';
    again.dispatch('change');
    (ctx.root.querySelector('[data-rollouts-key-action="include"]') as FakeElement).click();
    await confirmDialog(ctx, 'Include workspace');
    expect(JSON.parse(ctx.calls.find((call) => call.method === 'POST')!.body!).tenant).toBe('s:default');
    expect(text(ctx.part('alert'))).toContain('This rollout has changed or ended.');
  });

  it('server strings are inert: keys, ids and codes with markup create no element', async () => {
    const hostile = activeEntry({ candidate: [XSS], incumbent: [XSS], languages: [{ language: 'en', measures: [{ ...measure(XSS, 0.1, XSS) }] }] });
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody([hostile], [{ id: 'x', kind: 'embedding_profile', candidate: [XSS], state: XSS, endedAt: XSS }]) } } });
    await ctx.panel.mount();
    expect(injectedElements(ctx.root)).toEqual([]);
    expect(text(ctx.root)).toContain(XSS);
  });

  it('labels have zh, en and it parity, and the refusal helper names the language and the measure', () => {
    const en = Object.keys(mod.ROLLOUTS_LABELS.en).sort();
    expect(Object.keys(mod.ROLLOUTS_LABELS.zh).sort()).toEqual(en);
    expect(Object.keys(mod.ROLLOUTS_LABELS.it).sort()).toEqual(en);
    const drop = mod.rolloutsRefusal('rollout_language_drop:zh:not_helpful_rate', 'en');
    expect(drop.vars).toEqual({ language: 'Chinese', measure: 'Not-helpful votes' });
    expect(mod.rolloutsValidateForm({ kind: 'rebuild_run', candidate: 'x', mode: 'share', share: '101' }, 'en', []).errors.share).toBe('Enter a whole number from 1 to 100.');
  });

  it('index.html mounts the panel after the red-team panel and loads rollouts.js after red-team.js', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'scripts/config-ui/index.html'), 'utf8');
    expect(html.indexOf('id="rag-administration-rollouts"')).toBeGreaterThan(html.indexOf('id="rag-administration-red-team"'));
    expect(html.indexOf('rag-panels/rollouts.js')).toBeGreaterThan(html.indexOf('rag-panels/red-team.js'));
    for (const name of ['title', 'description', 'alert', 'content', 'status']) expect(html).toContain(`data-rollouts-${name}`);
  });
});

describe('UI review 07 fixes', () => {
  it('M-2: below 768px only Language (with Measure stacked under it) and Candidate now with the verdict stay as columns', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody() } } });
    await ctx.panel.mount();
    const table = (ctx.root.querySelector('[data-rollouts-card]') as FakeElement).querySelector('table') as FakeElement;
    const cols = table.querySelectorAll('th').filter((th) => th.getAttribute('scope') === 'col');
    const visible = cols.filter((th) => !/(^|\s)hidden(\s|$)/.test(th.className)).map(text);
    expect(visible).toEqual(['Language', 'Candidate now']);
    const first = table.querySelectorAll('tbody tr')[0] as FakeElement;
    const stacked = first.querySelector('[data-rollouts-measure-stacked]') as FakeElement;
    expect(stacked).toBeTruthy();
    expect(stacked.className).toContain('md:hidden');
    expect(text(stacked).length).toBeGreaterThan(0);
    const verdict = first.querySelector('[data-rollouts-verdict-stacked]') as FakeElement;
    expect(verdict.className).toContain('md:hidden');
    expect(text(verdict)).toContain('Holds');
  });

  it('M-3: invalid form fields get the error tint and the message is error-styled with an icon', async () => {
    const ctx = setup({ replies: { [LIST]: { ok: true, status: 200, body: listBody([activeEntry()]) } } });
    await ctx.panel.mount();
    button(ctx.root, 'New rollout').click();
    button(ctx.root, 'Start rollout').click();
    await settle();
    const candidate = ctx.doc.getElementById('rollouts-form-candidate') as FakeElement;
    expect(candidate.getAttribute('aria-invalid')).toBe('true');
    expect(candidate.className).toMatch(/\b(input|textarea)-error\b/);
    const message = ctx.doc.getElementById('rollouts-form-candidate-error') as FakeElement;
    expect(message.className).toContain('text-error');
    expect(message.querySelector('i')).toBeTruthy();
  });
});

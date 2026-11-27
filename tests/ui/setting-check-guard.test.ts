import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeText, type FakeNode, blockFrom, functionSource, injectedElements } from './helpers/html-fake-dom';

const require = createRequire(import.meta.url);

type Json = Record<string, unknown>;
type Decision = { proceed: boolean; gate?: Json; ignored?: boolean };
type Answer = { status: number; body?: unknown } | 'throw';
type Call = { url: string; method: string; headers: Record<string, string>; credentials?: string; body?: Json };

interface Guard {
  beforeSave: (request: Json) => Promise<Decision>;
  required: (request: Json) => Promise<Decision>;
  saved: (body: unknown) => void;
  saveFailed: (status: number, body: unknown) => Promise<Decision>;
  isOpen: () => boolean;
}

interface SettingCheckModule {
  settingCheckCreateGuard: (deps: Json) => Guard;
}

function load(): SettingCheckModule {
  return require('../../scripts/config-ui/rag-panels/setting-check.js') as SettingCheckModule;
}

function text(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  return node.childNodes.map(text).join('');
}

const CHECK_ID = '00000000-0000-4000-8000-000000000001';
const XSS = '<img src=x onerror=PWNED(1)>';

function done(extra: Json = {}): Json {
  return {
    check_id: CHECK_ID,
    status: 'done',
    mode: 'enforce',
    started_at: '2026-11-20T10:00:00Z',
    changed_keys: ['RAG_EXAMPLE_SETTING'],
    result: 'fail',
    layers: [
      { layer: 'deterministic', result: 'fail', checks: [{ check: 'false_answer_rate', slice: 'overall', measured: 0.15, numerator: 3, denominator: 20, limit: 0.05, limit_kind: 'max', result: 'failed' }] },
      { layer: 'live', result: 'skipped', reason: 'live_off', checks: [] },
      { layer: 'real_set', result: 'skipped', reason: 'no_real_set', checks: [] },
    ],
    not_evaluated: [],
    not_evaluated_on_real_set: [],
    uncalibrated_cells: [],
    ...extra,
  };
}

let doc: FakeDocument;
const holder = globalThis as unknown as { document?: unknown };
let previousDocument: unknown;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
  doc = new FakeDocument();
  previousDocument = holder.document;
  holder.document = doc;
});

afterEach(() => {
  vi.useRealTimers();
  holder.document = previousDocument;
});

function setup(opts: { mode?: string; start?: Answer[]; polls?: Answer[]; locale?: string } = {}) {
  const calls: Call[] = [];
  const toasts: Array<[string, string]> = [];
  const start = [...(opts.start ?? [])];
  const polls = [...(opts.polls ?? [])];
  const fetch = async (url: string, init: Json = {}) => {
    const call: Call = {
      url,
      method: String(init.method ?? 'GET'),
      headers: (init.headers as Record<string, string>) ?? {},
      credentials: init.credentials as string | undefined,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = call.method === 'POST' ? start.shift() : polls.shift();
    if (!answer || answer === 'throw') throw new Error('network');
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body ?? {} };
  };
  const opener = doc.createElement('button');
  doc.body.appendChild(opener);
  opener.focus();
  const guard = load().settingCheckCreateGuard({
    fetch,
    savedConfig: () => ({ RAG_CONFIG_GATE: opts.mode ?? 'enforce' }),
    locale: opts.locale ?? 'en',
    showToast: (message: string, type: string) => toasts.push([message, type]),
    labelFor: (name: string) => (name === 'RAG_EXAMPLE_SETTING' ? 'Example setting' : null),
  });
  return { guard, calls, toasts, opener };
}

const request = { kind: 'config', config: { RAG_EXAMPLE_SETTING: 'SYNTHETIC-VALUE-0001' }, changed: ['RAG_EXAMPLE_SETTING'] };

function dialog(): FakeElement {
  const el = doc.getElementById('rag-setting-check');
  expect(el, 'dialog#rag-setting-check').toBeTruthy();
  return el!;
}

function button(label: string): FakeElement {
  const found = dialog().querySelectorAll('button').find((b) => text(b).trim() === label);
  expect(found, `button ${label}`).toBeTruthy();
  return found!;
}

function buttons(): string[] {
  return dialog().querySelectorAll('.modal-action button').map((b) => text(b).trim());
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('beforeSave: no request when nothing needs a check (UI-SPEC 6.3.1, finding 4)', () => {
  it('mode off or unset resolves proceed with no request and no dialog', async () => {
    for (const mode of ['off', '']) {
      const { guard, calls } = setup({ mode });
      await expect(guard.beforeSave(request)).resolves.toEqual({ proceed: true });
      expect(calls).toEqual([]);
      expect(doc.getElementById('rag-setting-check')).toBeNull();
    }
  });

  it('an empty changed list resolves proceed with no request', async () => {
    const { guard, calls } = setup();
    await expect(guard.beforeSave({ kind: 'config', config: {}, changed: [] })).resolves.toEqual({ proceed: true });
    expect(calls).toEqual([]);
  });

  it('200 required false: no dialog, proceed; the request uses the config-server rules', async () => {
    const { guard, calls } = setup({ start: [{ status: 200, body: { required: false, mode: 'enforce' } }] });
    await expect(guard.beforeSave(request)).resolves.toEqual({ proceed: true });
    expect(doc.getElementById('rag-setting-check')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/config/rag-gate/check', method: 'POST', credentials: 'same-origin' });
    expect(calls[0]!.headers['x-config-ui']).toBe('1');
    expect(calls[0]!.body).toEqual({ kind: 'config', config: request.config });
  });

  it('maps the prompt and models requests onto the route bodies', async () => {
    const { guard, calls } = setup({ start: [{ status: 200, body: { required: false } }, { status: 200, body: { required: false } }] });
    await guard.beforeSave({ kind: 'prompt', preContext: 'synthetic pre', postContext: 'synthetic post' });
    await guard.beforeSave({ kind: 'models', models: { provider: 'openrouter', openrouterModels: [] } });
    expect(calls[0]!.body).toEqual({ kind: 'prompt', prompt: { preContext: 'synthetic pre', postContext: 'synthetic post' } });
    expect(calls[1]!.body).toEqual({ kind: 'models', models: { provider: 'openrouter', openrouterModels: [] } });
  });
});

describe('waiting (UI-SPEC 6.3.3)', () => {
  it('202 opens Checking and polls every 2 seconds for 30 seconds, then every 5', async () => {
    const running = { check_id: CHECK_ID, status: 'running', stage: 'deterministic', started_at: '2026-11-20T10:00:00Z', changed_keys: ['RAG_EXAMPLE_SETTING'] };
    const { guard, calls } = setup({ start: [{ status: 202, body: { check_id: CHECK_ID } }], polls: Array.from({ length: 40 }, () => ({ status: 200, body: running })) });
    void guard.beforeSave(request);
    await flush();
    expect(dialog().open).toBe(true);
    expect(text(dialog())).toContain('Checking these settings');
    expect(dialog().querySelector('progress')!.getAttribute('aria-label')).toBe('Setting check in progress');
    expect(buttons()).toEqual(['Edit settings']);
    const pollTimes = () => calls.filter((c) => c.method === 'GET').length;
    await advance(2000);
    expect(pollTimes()).toBe(1);
    expect(calls[1]!.url).toBe(`/api/config/rag-gate/check/${CHECK_ID}`);
    expect(calls[1]!.headers['x-config-ui']).toBe('1');
    await advance(28000);
    expect(pollTimes()).toBe(15);
    await advance(5000);
    expect(pollTimes()).toBe(16);
    expect(text(dialog())).toContain('Now running: Built-in test questions');
    expect(text(dialog())).toContain('Elapsed: 0:35');
    const elapsed = dialog().querySelectorAll('p').find((p) => text(p).startsWith('Elapsed'))!;
    expect(elapsed.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives up after 630 seconds with No result and reason no_answer', async () => {
    const running = { check_id: CHECK_ID, status: 'running', stage: 'live', changed_keys: ['RAG_EXAMPLE_SETTING'] };
    const { guard } = setup({ start: [{ status: 202, body: { check_id: CHECK_ID } }], polls: Array.from({ length: 200 }, () => ({ status: 200, body: running })) });
    void guard.beforeSave(request);
    await flush();
    await advance(629000);
    expect(text(dialog())).toContain('Checking these settings');
    await advance(2000);
    expect(text(dialog())).toContain('The check gave no result');
    expect(text(dialog())).toContain('The config server did not answer');
    expect(buttons()).toEqual(['Edit settings', 'Run check again', 'Save settings with reason']);
  });

  it('three failed polls in a row give No result', async () => {
    const { guard } = setup({ start: [{ status: 202, body: { check_id: CHECK_ID } }], polls: ['throw', { status: 500 }, 'throw'] });
    void guard.beforeSave(request);
    await flush();
    await advance(4000);
    expect(text(dialog())).toContain('Checking these settings');
    await advance(2000);
    expect(text(dialog())).toContain('The check gave no result');
  });

  it('a cached 200 opens on the result with checking.cached', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done({ cached: true, finished_at: '2026-11-20T09:50:00Z' }) }] });
    void guard.beforeSave(request);
    await flush();
    expect(text(dialog())).toContain('Check failed');
    expect(text(dialog())).toMatch(/Result from .+, for the same settings\./);
    expect(text(dialog())).toContain('False answers');
    expect(buttons()).toEqual(['Edit settings', 'Save settings with reason']);
  });

  it('409 rag_gate_busy opens Busy with the start time', async () => {
    const { guard } = setup({ start: [{ status: 409, body: { error: 'rag_gate_busy', running_since: '2026-11-20T09:58:00Z' } }] });
    void guard.beforeSave(request);
    await flush();
    expect(text(dialog())).toContain('Another check is running');
    expect(dialog().querySelector('time')!.getAttribute('datetime')).toBe('2026-11-20T09:58:00Z');
    expect(buttons()).toEqual(['Edit settings', 'Run check again', 'Save settings with reason']);
  });

  it('a network failure or 401 on start opens No result', async () => {
    for (const answer of ['throw', { status: 401 }] as Answer[]) {
      doc = new FakeDocument();
      holder.document = doc;
      const { guard } = setup({ start: [answer] });
      void guard.beforeSave(request);
      await flush();
      expect(text(dialog())).toContain('The check gave no result');
    }
  });
});

describe('decisions (UI-SPEC 6.3.4)', () => {
  it('Save settings with reason is disabled until the reason is valid, then resolves with override and check_id', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done() }] });
    const decision = guard.beforeSave(request);
    await flush();
    const save = button('Save settings with reason');
    expect(save.disabled).toBe(true);
    const area = dialog().querySelector('textarea')!;
    expect(area.getAttribute('maxlength')).toBe('500');
    expect(area.getAttribute('minlength')).toBe('10');
    area.value = 'short';
    area.dispatch('input');
    expect(button('Save settings with reason').disabled).toBe(true);
    expect(text(dialog())).toContain('The reason needs more characters: 5');
    expect(area.getAttribute('aria-invalid')).toBe('true');
    area.value = '  a synthetic reason text  ';
    area.dispatch('input');
    expect(text(dialog())).toContain('Characters: 23');
    button('Save settings with reason').click();
    await expect(decision).resolves.toEqual({ proceed: true, gate: { override: { reason: 'a synthetic reason text' }, check_id: CHECK_ID } });
    for (const b of dialog().querySelectorAll('button')) expect(b.disabled, text(b)).toBe(true);
    expect(dialog().querySelector('textarea')!.disabled).toBe(true);
    expect(text(button('Saving…'))).toContain('Saving…');
    expect(button('Saving…').querySelector('.loading')).toBeTruthy();
  });

  it('Escape during Saving does nothing', async () => {
    const { guard } = setup({ mode: 'warn', start: [{ status: 200, body: done({ mode: 'warn' }) }] });
    const decision = guard.beforeSave(request);
    await flush();
    button('Save settings anyway').click();
    await expect(decision).resolves.toEqual({ proceed: true, gate: { check_id: CHECK_ID } });
    const event = dialog().dispatch('cancel');
    expect(event.defaultPrevented).toBe(true);
    expect(dialog().open).toBe(true);
  });

  it('saved(response) shows the outcome with the record id and never the reason', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done() }] });
    const decision = guard.beforeSave(request);
    await flush();
    const area = dialog().querySelector('textarea')!;
    area.value = 'a synthetic reason text';
    area.dispatch('input');
    button('Save settings with reason').click();
    await decision;
    guard.saved({ success: true, ragGate: { record_id: 'rec-0001', gate_result: 'fail' } });
    expect(text(dialog())).toContain('Settings saved');
    expect(text(dialog())).toContain('Settings saved with your reason. Recorded as change rec-0001.');
    expect(text(dialog())).not.toContain('a synthetic reason text');
    expect(dialog().querySelector('textarea')).toBeNull();
    expect(buttons()).toEqual(['Close check']);
  });

  it('saveFailed(409 rag_gate_required) shows error.changed and keeps the reason', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done() }] });
    const decision = guard.beforeSave(request);
    await flush();
    const area = dialog().querySelector('textarea')!;
    area.value = 'a synthetic reason text';
    area.dispatch('input');
    button('Save settings with reason').click();
    await decision;
    void guard.saveFailed(409, { error: 'rag_gate_required' });
    expect(text(dialog())).toContain('Not saved. The settings changed after the check');
    expect(buttons()).toEqual(['Edit settings', 'Run check again']);
  });

  it('saveFailed(503 rag_gate_record_failed) keeps the reason text and offers the same save again', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done() }] });
    const first = guard.beforeSave(request);
    await flush();
    const area = dialog().querySelector('textarea')!;
    area.value = 'a synthetic reason text';
    area.dispatch('input');
    button('Save settings with reason').click();
    await first;
    const next = guard.saveFailed(503, { error: 'rag_gate_record_failed' });
    expect(text(dialog())).toContain('The reason could not be recorded');
    expect(dialog().querySelector('textarea')!.value).toBe('a synthetic reason text');
    button('Save settings with reason').click();
    await expect(next).resolves.toEqual({ proceed: true, gate: { override: { reason: 'a synthetic reason text' }, check_id: CHECK_ID } });
  });

  it('any other failure shows error.saveFailed with the status', async () => {
    const { guard } = setup({ mode: 'warn', start: [{ status: 200, body: done({ mode: 'warn' }) }] });
    const decision = guard.beforeSave(request);
    await flush();
    button('Save settings anyway').click();
    await decision;
    void guard.saveFailed(500, { error: 'boom' });
    expect(text(dialog())).toContain('The config server did not accept the settings (500)');
    expect(buttons()).toEqual(['Edit settings', 'Save settings anyway']);
  });

  it('Escape otherwise equals Edit settings: proceed false, focus back on the opener, held toast', async () => {
    const { guard, opener, toasts, calls } = setup({ start: [{ status: 200, body: done() }] });
    const decision = guard.beforeSave(request);
    await flush();
    expect(doc.activeElement && text(doc.activeElement)).toBe('Edit settings');
    const event = dialog().dispatch('cancel');
    expect(event.defaultPrevented).toBe(true);
    await expect(decision).resolves.toEqual({ proceed: false });
    expect(doc.getElementById('rag-setting-check')).toBeNull();
    expect(doc.activeElement).toBe(opener);
    expect(toasts).toEqual([['Nothing was saved. Your edits are still in the form.', 'info']]);
    expect(calls.filter((c) => c.url.startsWith('/api/config') && !c.url.includes('rag-gate'))).toEqual([]);
  });

  it('Edit settings during Checking resolves proceed false', async () => {
    const { guard } = setup({ start: [{ status: 202, body: { check_id: CHECK_ID } }] });
    const decision = guard.beforeSave(request);
    await flush();
    button('Edit settings').click();
    await expect(decision).resolves.toEqual({ proceed: false });
  });

  it('warn mode: Save settings without result during Checking resolves skipped', async () => {
    const { guard } = setup({ mode: 'warn', start: [{ status: 202, body: { check_id: CHECK_ID } }] });
    const decision = guard.beforeSave(request);
    await flush();
    button('Save settings without result').click();
    await expect(decision).resolves.toEqual({ proceed: true, gate: { skipped: true } });
  });

  it('a pass without a notice is saved at once', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done({ result: 'pass', layers: [{ layer: 'deterministic', result: 'pass', checks: [] }] }) }] });
    await expect(guard.beforeSave(request)).resolves.toEqual({ proceed: true, gate: { check_id: CHECK_ID } });
    guard.saved({ success: true, ragGate: { record_id: 'rec-0002', gate_result: 'pass' } });
    expect(text(dialog())).toContain('Check passed. Settings saved.');
    expect(buttons()).toEqual(['Close check']);
    button('Close check').click();
    expect(doc.getElementById('rag-setting-check')).toBeNull();
  });

  it('Run check again asks for a fresh run', async () => {
    const { guard, calls } = setup({ start: [{ status: 409, body: { error: 'rag_gate_busy', running_since: '2026-11-20T09:58:00Z' } }, { status: 202, body: { check_id: CHECK_ID } }] });
    void guard.beforeSave(request);
    await flush();
    button('Run check again').click();
    await flush();
    expect(calls[1]!.body).toEqual({ kind: 'config', config: request.config, force: true });
    expect(text(dialog())).toContain('Checking these settings');
  });

  it('a second save while the dialog is open is ignored', async () => {
    const { guard, calls } = setup({ start: [{ status: 202, body: { check_id: CHECK_ID } }] });
    void guard.beforeSave(request);
    await flush();
    await expect(guard.beforeSave(request)).resolves.toEqual({ proceed: false, ignored: true });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(guard.isOpen()).toBe(true);
  });

  it('required(request) opens the dialog and starts a check for the same request, even when the loaded mode is off', async () => {
    const { guard, calls } = setup({ mode: 'off', start: [{ status: 202, body: { check_id: CHECK_ID } }] });
    void guard.required(request);
    await flush();
    expect(calls[0]).toMatchObject({ url: '/api/config/rag-gate/check', method: 'POST' });
    expect(calls[0]!.body).toEqual({ kind: 'config', config: request.config });
    expect(dialog().open).toBe(true);
  });
});

describe('what the dialog never shows (UI-SPEC 11)', () => {
  it('lists names only, never a value', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done() }] });
    void guard.beforeSave(request);
    await flush();
    expect(text(dialog())).toContain('Example setting');
    expect(text(dialog())).toContain('RAG_EXAMPLE_SETTING');
    expect(text(dialog())).not.toContain('SYNTHETIC-VALUE-0001');
  });

  it('builds no element from markup in server strings', async () => {
    const { guard } = setup({
      start: [{
        status: 200,
        body: done({
          changed_keys: [XSS],
          error_reason: XSS,
          not_evaluated: [{ key: XSS, reason: XSS }],
          not_evaluated_on_real_set: [XSS],
          uncalibrated_cells: [XSS, `p|${XSS}|en|same`],
          layers: [{ layer: 'deterministic', result: XSS, reason: XSS, checks: [{ check: XSS, slice: XSS, measured: 1, result: XSS }] }],
        }),
      }],
    });
    void guard.beforeSave(request);
    await flush();
    expect(text(dialog())).toContain(XSS);
    expect(injectedElements(doc)).toEqual([]);
    expect(doc.innerHtmlWrites).toBe(0);
  });

  it('is a native modal dialog without backdrop close, labelled by its title and lead', async () => {
    const { guard } = setup({ start: [{ status: 200, body: done() }] });
    void guard.beforeSave(request);
    await flush();
    const el = dialog();
    expect(el.tagName).toBe('dialog');
    expect(el.className).toContain('modal');
    expect(el.querySelector('.modal-backdrop')).toBeNull();
    expect(el.querySelector('.modal-box')!.className).toContain('w-11/12 max-w-2xl');
    const title = doc.getElementById(el.getAttribute('aria-labelledby')!)!;
    expect(title.tagName).toBe('h3');
    expect(title.getAttribute('tabindex')).toBe('-1');
    expect(doc.getElementById(el.getAttribute('aria-describedby')!)).toBeTruthy();
    expect(el.querySelector('[role="status"]')!.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('lang')).toBe('en');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// The three save paths in index.html (UI-SPEC 6.3.1, plan 05.3-42 Task 3)

const indexHtml = fs.readFileSync('scripts/config-ui/index.html', 'utf8');

type PageCall = { url: string; method: string; headers: unknown; body: string | undefined };
type FakeGuard = {
  beforeSave: (r: Json) => Promise<Decision>;
  required: (r: Json) => Promise<Decision>;
  saved: (b: unknown) => void;
  saveFailed: (s: number, b: unknown) => Promise<Decision>;
  isOpen: () => boolean;
};

function pageContext(globals: Json, answers: Array<{ status: number; body?: unknown }>) {
  const calls: PageCall[] = [];
  const toasts: Array<[string, string]> = [];
  const page = new FakeDocument();
  for (const id of ['desktop-save-indicator', 'mobile-save-indicator']) {
    const el = page.createElement('div');
    el.id = id;
    el.className = 'alert hidden';
    page.body.appendChild(el);
  }
  const context: Json = {
    document: page,
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    CustomEvent: class {
      constructor(
        public type: string,
        public init: unknown,
      ) {}
    },
    showToast: (message: string, type: string) => toasts.push([message, type]),
    fetch: async (url: string, init: Json = {}) => {
      calls.push({ url, method: String(init.method ?? 'GET'), headers: init.headers, body: init.body as string | undefined });
      const answer = answers.shift() ?? { status: 200, body: { success: true } };
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, statusText: 'Status', json: async () => answer.body ?? {}, text: async () => JSON.stringify(answer.body ?? {}) };
    },
    ...globals,
  };
  context.window = context;
  (page as unknown as { dispatchEvent: () => boolean }).dispatchEvent = () => true;
  vm.createContext(context);
  for (const name of ['ragSettingCheckText', 'ragGateRequiredAnswer', 'ragGuardedSave', 'showRagSaveHeld', 'showRagGateRequiredToast']) {
    if (new RegExp(`function ${name}\\(`).test(indexHtml)) new vm.Script(functionSource(indexHtml, name)).runInContext(context);
  }
  return { context, calls, toasts, page };
}

function loadSaveConfig(globals: Json, answers: Array<{ status: number; body?: unknown }>, config: Json, savedConfig: Json) {
  const ctx = pageContext({ saveRagPrompt: async () => true, ...globals }, answers);
  const source = blockFrom(indexHtml, indexHtml.indexOf('async saveConfig() {'));
  const manager = vm.runInContext(`({ ${source}, showSaveIndicator() {} })`, ctx.context) as Json & { saveConfig: () => Promise<void> };
  manager.config = config;
  manager.savedConfig = savedConfig;
  return { ...ctx, manager };
}

function fakeGuard(decisions: Partial<Record<'beforeSave' | 'required' | 'saveFailed', Decision[]>>, log: string[] = []): FakeGuard {
  let open = false;
  const next = (name: 'beforeSave' | 'required' | 'saveFailed') => {
    const decision = decisions[name]?.shift() ?? { proceed: false };
    open = decision.proceed && Boolean(decision.gate);
    return decision;
  };
  return {
    beforeSave: async (r) => {
      log.push('beforeSave:' + JSON.stringify(r.changed ?? null));
      return next('beforeSave');
    },
    required: async (r) => {
      log.push('required:' + String(r.kind));
      return next('required');
    },
    saved: () => {
      log.push('saved');
      open = false;
    },
    saveFailed: async (s) => {
      log.push('saveFailed:' + s);
      return next('saveFailed');
    },
    isOpen: () => open,
  };
}

describe('saveConfig() through the setting check (UI-SPEC 6.3.1)', () => {
  it('with RAG_CONFIG_GATE off the request is the same as before this plan and no rag-gate request is made', async () => {
    const guard = load().settingCheckCreateGuard({ savedConfig: () => ({ RAG_CONFIG_GATE: 'off' }), fetch: async () => { throw new Error('no rag-gate request expected'); } });
    const { manager, calls } = loadSaveConfig({ ragSettingCheck: guard }, [], { RAG_PRE_CONTEXT: 'synthetic', RAG_CONFIG_GATE: 'off' }, { RAG_PRE_CONTEXT: 'old', RAG_CONFIG_GATE: 'off' });
    await manager.saveConfig();
    expect(calls).toEqual([
      { url: '/api/config', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { RAG_PRE_CONTEXT: 'synthetic', RAG_CONFIG_GATE: 'off' } }) },
    ]);
  });

  it('in enforce mode a changed RAG_PRE_CONTEXT awaits the guard; proceed false posts nothing, shows no error toast and the held indicator for 3 seconds', async () => {
    const log: string[] = [];
    const { manager, calls, toasts, page } = loadSaveConfig(
      { ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: false }] }, log) },
      [],
      { RAG_PRE_CONTEXT: 'synthetic', RAG_CONFIG_GATE: 'enforce' },
      { RAG_PRE_CONTEXT: 'old', RAG_CONFIG_GATE: 'enforce' },
    );
    await manager.saveConfig();
    expect(log).toEqual(['beforeSave:["RAG_PRE_CONTEXT"]']);
    expect(calls).toEqual([]);
    expect(toasts.filter(([, type]) => type === 'error')).toEqual([]);
    const indicator = page.getElementById('desktop-save-indicator')!;
    expect(indicator.textContent).toBe('Not saved');
    expect(indicator.className).toContain('alert-warning');
    expect(indicator.className).not.toContain('hidden');
    await vi.advanceTimersByTimeAsync(3000);
    expect(indicator.className).toContain('hidden');
  });

  it('posts ragGate with the decision and reports the answer back', async () => {
    const log: string[] = [];
    const gate = { override: { reason: 'a synthetic reason text' }, check_id: CHECK_ID };
    const { manager, calls } = loadSaveConfig(
      { ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: true, gate }] }, log) },
      [{ status: 200, body: { success: true, ragGate: { record_id: 'rec-0001' } } }],
      { RAG_PRE_CONTEXT: 'synthetic' },
      { RAG_PRE_CONTEXT: 'old' },
    );
    await manager.saveConfig();
    expect(JSON.parse(calls[0]!.body!)).toEqual({ config: { RAG_PRE_CONTEXT: 'synthetic' }, ragGate: gate });
    expect(log).toEqual(['beforeSave:["RAG_PRE_CONTEXT"]', 'saved']);
    expect(manager.savedConfig).toEqual({ RAG_PRE_CONTEXT: 'synthetic' });
  });

  it('a 409 rag_gate_required with no dialog open calls required once and shows no Failed to save toast', async () => {
    const log: string[] = [];
    const { manager, calls, toasts } = loadSaveConfig(
      { ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: true }], required: [{ proceed: true, gate: { check_id: CHECK_ID } }] }, log) },
      [{ status: 409, body: { error: 'rag_gate_required' } }, { status: 200, body: { success: true } }],
      { RAG_PRE_CONTEXT: 'synthetic' },
      { RAG_PRE_CONTEXT: 'old' },
    );
    await manager.saveConfig();
    expect(log).toEqual(['beforeSave:["RAG_PRE_CONTEXT"]', 'required:config', 'saved']);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ config: { RAG_PRE_CONTEXT: 'synthetic' }, ragGate: { check_id: CHECK_ID } });
    expect(toasts.map(([m]) => m)).not.toContain('Failed to save configuration');
  });

  it('a held required answer posts nothing more and shows no error', async () => {
    const log: string[] = [];
    const { manager, calls, toasts } = loadSaveConfig(
      { ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: true }], required: [{ proceed: false }] }, log) },
      [{ status: 409, body: { error: 'rag_gate_required' } }],
      { RAG_PRE_CONTEXT: 'synthetic' },
      { RAG_PRE_CONTEXT: 'old' },
    );
    await manager.saveConfig();
    expect(calls).toHaveLength(1);
    expect(toasts.filter(([, type]) => type === 'error')).toEqual([]);
  });

  it('with the guard script missing, saves post as today and a 409 shows the toast error.required', async () => {
    const { manager, calls, toasts } = loadSaveConfig({}, [{ status: 409, body: { error: 'rag_gate_required' } }], { RAG_PRE_CONTEXT: 'synthetic' }, { RAG_PRE_CONTEXT: 'old' });
    await manager.saveConfig();
    expect(calls).toEqual([{ url: '/api/config', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { RAG_PRE_CONTEXT: 'synthetic' } }) }]);
    expect(toasts).toEqual([['Not saved. These settings need a passed check or a reason. Reload the page, then save again to start the check.', 'error']]);
  });

  it('the Phase 3.2 impact guard runs first, and the setting check sees what remains', async () => {
    const log: string[] = [];
    const { manager } = loadSaveConfig(
      {
        ragIngestImpactGuard: async (next: Json) => {
          log.push('impact');
          return { ...next, RAG_TABLE_HEADER_REPEAT: 'profile' };
        },
        ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: false }] }, log),
      },
      [],
      { RAG_TABLE_HEADER_REPEAT: 'always', RAG_PRE_CONTEXT: 'synthetic' },
      { RAG_TABLE_HEADER_REPEAT: 'profile', RAG_PRE_CONTEXT: 'old' },
    );
    await manager.saveConfig();
    expect(log).toEqual(['impact', 'beforeSave:["RAG_PRE_CONTEXT"]']);
  });
});

describe('saveRagPrompt() and the model save through the setting check', () => {
  function loadPrompt(globals: Json, answers: Array<{ status: number; body?: unknown }>) {
    const ctx = pageContext(
      {
        ragPreContextArea: { value: 'synthetic pre' },
        ragPostContextArea: { value: 'synthetic post' },
        updateLivePreview() {},
        ...globals,
      },
      answers,
    );
    new vm.Script(functionSource(indexHtml, 'saveRagPrompt')).runInContext(ctx.context);
    return { ...ctx, saveRagPrompt: ctx.context.saveRagPrompt as (toast?: boolean) => Promise<unknown> };
  }

  it("returns 'held' when the guard holds the save and posts nothing", async () => {
    const log: string[] = [];
    const { saveRagPrompt, calls, toasts } = loadPrompt({ ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: false }] }, log) }, []);
    await expect(saveRagPrompt(false)).resolves.toBe('held');
    expect(calls).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('without a gate it posts the same body as before; with one it adds ragGate', async () => {
    const plain = loadPrompt({ ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: true }] }) }, [{ status: 200, body: { success: true } }]);
    await expect(plain.saveRagPrompt(false)).resolves.toBe(true);
    expect(plain.calls[0]).toEqual({ url: '/api/config/rag-prompt', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preContext: 'synthetic pre', postContext: 'synthetic post' }) });
    const gated = loadPrompt({ ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: true, gate: { check_id: CHECK_ID } }] }) }, [{ status: 200, body: { success: true } }]);
    await expect(gated.saveRagPrompt(false)).resolves.toBe(true);
    expect(JSON.parse(gated.calls[0]!.body!)).toEqual({ preContext: 'synthetic pre', postContext: 'synthetic post', ragGate: { check_id: CHECK_ID } });
  });

  it('the template chooser retry loop stops on held and its timeout waits while the dialog is open', () => {
    const start = indexHtml.indexOf('const maxRetries = 3;');
    expect(start).toBeGreaterThan(-1);
    const loop = indexHtml.slice(start, indexHtml.indexOf('// Verify save by reading back the data', start));
    expect(loop).toMatch(/if \(saveSuccess === 'held'\) \{[^}]*\bbreak;\s*\}/);
    expect(loop).toContain('ragSettingCheck.isOpen()');
    const after = indexHtml.slice(start, indexHtml.indexOf('} catch (error) {', indexHtml.indexOf('All save attempts failed', start)));
    expect(after).toMatch(/if \(saveSuccess === 'held'\)/);
  });

  it('the model save posts with ragGate after a decision', async () => {
    const modelConfig = { provider: 'openrouter', openaiModels: [], openrouterModels: [], groqModels: [] };
    const saveButton = { disabled: false, textContent: 'Save Model Configuration' };
    const ctx = pageContext(
      { modelConfig, event: { target: saveButton }, alert() {}, ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: true, gate: { check_id: CHECK_ID } }] }) },
      [{ status: 200, body: { success: true, config: modelConfig, ragGate: { record_id: 'rec-0003' } } }, { status: 200, body: {} }],
    );
    new vm.Script(functionSource(indexHtml, 'saveModelConfiguration')).runInContext(ctx.context);
    await (ctx.context.saveModelConfiguration as () => Promise<void>)();
    expect(ctx.calls[0]!.url).toBe('../api/config/models');
    expect(JSON.parse(ctx.calls[0]!.body!)).toEqual({ ...modelConfig, ragGate: { check_id: CHECK_ID } });
    expect(saveButton.disabled).toBe(false);
  });

  it('the model save posts the same body as before when the guard passes it through, and posts nothing when held', async () => {
    const modelConfig = { provider: 'openrouter', openaiModels: [], openrouterModels: [], groqModels: [] };
    const plain = pageContext({ modelConfig, event: { target: null }, alert() {}, ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: true }] }) }, [{ status: 200, body: { success: true, config: modelConfig } }]);
    new vm.Script(functionSource(indexHtml, 'saveModelConfiguration')).runInContext(plain.context);
    await (plain.context.saveModelConfiguration as () => Promise<void>)();
    expect(plain.calls[0]!.body).toBe(JSON.stringify(modelConfig));
    const saveButton = { disabled: false, textContent: 'Save Model Configuration' };
    const held = pageContext({ modelConfig, event: { target: saveButton }, alert() {}, ragSettingCheck: fakeGuard({ beforeSave: [{ proceed: false }] }) }, []);
    new vm.Script(functionSource(indexHtml, 'saveModelConfiguration')).runInContext(held.context);
    await (held.context.saveModelConfiguration as () => Promise<void>)();
    expect(held.calls).toEqual([]);
    expect(saveButton).toEqual({ disabled: false, textContent: 'Save Model Configuration' });
  });
});

describe('index.html wiring (UI-SPEC 6.1)', () => {
  it('loads setting-check.js after gates-ui.js and has the Setting checks section after Judge calibration', () => {
    const gates = indexHtml.indexOf('<script src="rag-panels/gates-ui.js"></script>');
    const tag = indexHtml.indexOf('<script src="rag-panels/setting-check.js"></script>');
    expect(gates).toBeGreaterThan(-1);
    expect(tag).toBeGreaterThan(gates);
    const judge = indexHtml.indexOf('id="rag-administration-judge"');
    const section = indexHtml.indexOf('id="rag-administration-setting-checks"');
    expect(section).toBeGreaterThan(judge);
    const tagEnd = indexHtml.indexOf('</section>', section);
    const body = indexHtml.slice(section, tagEnd);
    expect(body).toMatch(/<h3[^>]*tabindex="-1"/);
    expect(body).toContain('role="status"');
    expect(body).toContain('aria-live="polite"');
  });

  it('the RAG administration intro names setting checks and monitoring alerts', () => {
    expect(indexHtml).toContain('check settings before they apply, and follow monitoring alerts');
  });
});

import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeText, type FakeNode, injectedElements } from './helpers/html-fake-dom';

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

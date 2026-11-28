import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FakeDocument, FakeElement, injectedElements, XSS_PAYLOAD, type FakeEvent } from './helpers/html-fake-dom';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');
const panelSource = fs.readFileSync(path.join(configUiDir, 'rag-panels/scope-gate.js'), 'utf8');

type Json = Record<string, unknown>;

const ORG = 'c0000000-0000-4000-8000-000000000001';
const EX1 = 'e0000000-0000-4000-8000-000000000021';
const EX2 = 'e0000000-0000-4000-8000-000000000022';
const ACTOR = 'a0000000-0000-4000-8000-000000000031';
const JS_URL = 'javascript:alert(1)';
const BASE = '/api/rag/admin/scope-gate';
const CALIBRATE = 'uv run --directory eval python -m rag_eval.calibrate scope';
const CENTROIDS = 'npm run rag:scope-centroids -- --tenant <tenant-key>';

function section(id: string): string {
  const start = indexHtml.indexOf(`<section id="${id}"`);
  expect(start, id).toBeGreaterThan(-1);
  return indexHtml.slice(start, indexHtml.indexOf('</section>', start) + '</section>'.length);
}

function pointerRow(): string {
  const at = indexHtml.indexOf('data-scope-gate-pointer-text');
  const start = indexHtml.lastIndexOf('<div', at);
  return indexHtml.slice(start, indexHtml.indexOf('</div>', at) + '</div>'.length);
}

function status(extra: Json = {}): Json {
  return {
    success: true,
    running: { scopeGate: true, pipeline: 'v2', queryLayer: true, ragMode: 'strict', activeProfileId: 'profile-alpha-1536' },
    canSkip: true,
    readiness: [
      { row: 'switch', state: 'on' },
      { row: 'pipeline', state: 'ready' },
      { row: 'thresholds', state: 'ready', profileId: 'profile-alpha-1536', ragMode: 'strict', command: CALIBRATE },
      { row: 'scope_data', state: 'ready' },
    ],
    scopeData: {
      state: 'ready',
      kinds: [
        { kind: 'doc_type', referencePoints: 5 },
        { kind: 'scope_tag', referencePoints: 12 },
        { kind: 'tenant', referencePoints: 1 },
      ],
      chunksIncluded: 1240,
      updatedAt: '2026-11-24T10:00:00.000Z',
      rebuild: { browser: true, command: null },
    },
    examples: {
      rows: [
        { id: EX1, text: 'Neutral sample question one?', createdBy: ACTOR, createdAt: '2026-11-24T09:00:00.000Z', inUse: true },
        { id: EX2, text: 'Neutral sample question two?', createdBy: ACTOR, createdAt: '2026-11-24T09:30:00.000Z', inUse: true },
      ],
      total: 2,
      limit: 100,
      maxChars: 500,
    },
    thresholds: {
      present: true,
      valid: true,
      source: 'live',
      recordedAt: '2026-11-20T08:00:00.000Z',
      command: CALIBRATE,
      rows: [
        threshold({ embeddingProfileId: 'profile-alpha-1536', activeProfile: true, ragMode: 'strict' }),
        threshold({ embeddingProfileId: 'profile-alpha-1536', activeProfile: true, ragMode: 'balanced' }),
        threshold({ embeddingProfileId: 'profile-beta-1024', activeProfile: false, ragMode: 'strict', status: 'uncalibrated', threshold: null, margin: null, falseRefusalUpper95: null }),
      ],
    },
    ...extra,
  };
}

function threshold(extra: Json = {}): Json {
  return {
    embeddingProfileId: 'profile-alpha-1536',
    activeProfile: true,
    ragMode: 'strict',
    status: 'calibrated',
    source: 'live',
    threshold: 0.0371,
    margin: 0,
    falseRefusalRate: 0.0325,
    falseRefusalN: 123,
    falseRefusalUpper95: 0.0729,
    correctRefusalRate: 0.1176,
    correctRefusalN: 17,
    recordedAt: '2026-11-20T08:00:00.000Z',
    ...extra,
  };
}

function readiness(body: Json, row: string, entry: Json): Json {
  const rows = (body.readiness as Json[]).map((r) => (r.row === row ? { row, ...entry } : r));
  return { ...body, readiness: rows };
}

interface Call {
  key: string;
  path: string;
  method: string;
  query: URLSearchParams;
  body: unknown;
}
interface Reply {
  status?: number;
  body?: unknown;
  thrown?: boolean;
}
type Replies = Partial<Record<string, Reply | ((call: Call) => Reply | Promise<Reply>)>>;

function routeKey(p: string, method: string): string {
  const rest = p.slice(BASE.length).replace(/^\//, '');
  if (rest === '' && method === 'GET') return 'status';
  if (rest === 'examples' && method === 'POST') return 'add';
  if (rest.startsWith('examples/') && method === 'DELETE') return 'delete';
  if (rest === 'rebuild' && method === 'POST') return 'rebuild';
  return 'unknown';
}

interface PageOptions {
  locale?: string;
  multiTenant?: boolean;
  replies?: Replies;
  status?: Json | (() => Json);
  checked?: boolean;
  pipeline?: string;
  layer?: boolean;
}

function bubble(el: FakeElement, type: string, extra: Json = {}) {
  let stopped = false;
  const event: FakeEvent = {
    type,
    target: el,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    ...extra,
  };
  let current: FakeElement | null = el;
  while (current && !stopped) {
    event.currentTarget = current;
    for (const fn of [...(current.listeners.get(type) ?? [])]) fn(event);
    current = current.parentNode;
  }
  if (!stopped) for (const fn of [...(el.doc.listeners.get(type) ?? [])]) fn(event);
}

function loadPage(options: PageOptions = {}) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const configWrites: Array<[string, unknown]> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];

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
  selector.value = options.multiTenant ? ORG : '';
  doc.body.appendChild(selector);

  const links: Record<string, number> = { 'rag-modes': 0, 'rag-administration': 0 };
  for (const tab of Object.keys(links)) {
    const link = doc.createElement('a');
    link.className = 'menu-item';
    link.setAttribute('data-tab', tab);
    link.addEventListener('click', () => {
      links[tab]! += 1;
    });
    doc.body.appendChild(link);
  }
  const pipeline = doc.createElement('select');
  pipeline.id = 'RAG_PIPELINE';
  pipeline.value = options.pipeline ?? 'v2';
  doc.body.appendChild(pipeline);
  const layer = doc.createElement('input');
  layer.id = 'RAG_QUERY_LAYER';
  layer.setAttribute('type', 'checkbox');
  layer.checked = options.layer ?? true;
  doc.body.appendChild(layer);

  const card = doc.createElement('div');
  card.id = 'query-layer-card';
  card.innerHTML = pointerRow();
  doc.body.appendChild(card);

  const tab = doc.createElement('div');
  tab.id = 'rag-administration';
  tab.className = 'tab-content active';
  doc.body.appendChild(tab);
  const holder = doc.createElement('div');
  holder.innerHTML = section('rag-administration-scope-gate');
  tab.appendChild(holder);
  doc.innerHtmlWrites = 0;
  const box = doc.getElementById('RAG_SCOPE_GATE')!;
  box.checked = options.checked ?? true;

  doc.addEventListener('change', (event: FakeEvent) => {
    const target = event.target as FakeElement;
    if (target && target.id) configWrites.push([target.id, target.value]);
  });

  const ragFetch = async (apiPath: string, init: Json = {}) => {
    const method = String(init.method ?? 'GET');
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : init.body;
    const p = apiPath.split('?')[0]!;
    const query = new URLSearchParams(apiPath.includes('?') ? apiPath.slice(apiPath.indexOf('?') + 1) : '');
    const key = p.startsWith(BASE) ? routeKey(p, method) : 'unknown';
    const call: Call = { key, path: apiPath, method, query, body };
    calls.push(call);
    if (key === 'unknown') throw new TypeError('unexpected request ' + method + ' ' + apiPath);
    const current = typeof options.status === 'function' ? options.status() : (options.status ?? status());
    const defaults: Record<string, Reply> = {
      status: { status: 200, body: current },
      add: { status: 201, body: { success: true, example: { id: EX1, createdAt: '2026-11-25T00:00:00.000Z', createdBy: ACTOR } } },
      delete: { status: 200, body: { success: true } },
      rebuild: { status: 200, body: { success: true, status: 'done', kinds: [{ kind: 'doc_type', referencePoints: 4, chunksIncluded: 10 }, { kind: 'scope_tag', referencePoints: 2, chunksIncluded: 8 }, { kind: 'tenant', referencePoints: 1, chunksIncluded: 10 }] } },
    };
    const custom = options.replies?.[key];
    const reply = await (typeof custom === 'function' ? custom(call) : (custom ?? defaults[key]!));
    if (reply.thrown) throw new TypeError('network');
    const code = reply.status ?? 200;
    return { ok: code >= 200 && code < 300, status: code, body: reply.body === undefined ? null : JSON.parse(JSON.stringify(reply.body)) };
  };

  let copied: string | null = null;
  const context: Json = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: {
      language: options.locale ?? 'en-US',
      clipboard: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
    },
    location: { origin: 'http://config.local', search: '', hash: '' },
    currentConfig: options.multiTenant ? { NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'multi-tenant' } : {},
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    Intl,
    Date,
    ragFetch,
    configManager: {
      updateConfig(key: string, value: unknown) {
        configWrites.push([key, value]);
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['document-processing/status-monitor.js', 'rag-panels/rag-ui.js', 'rag-panels/scope-gate.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  const root = doc.getElementById('rag-administration-scope-gate')!;
  const page = {
    doc,
    root,
    calls,
    configWrites,
    timers,
    links,
    copied: () => copied,
    of: (key: string) => calls.filter((c) => c.key === key),
    status: () => root.querySelector('[data-scope-gate-status]')!,
    alert: () => root.querySelector('[data-scope-gate-alert]')!,
    block: (name: string) => root.querySelector(`[data-scope-gate-block="${name}"]`)!,
    row: (name: string) => root.querySelector(`[data-scope-gate-row="${name}"]`)!,
    textarea: () => root.querySelector('textarea')!,
    async open() {
      const init = context.initScopeGatePanel as (deps?: Json) => Promise<void>;
      await init({
        schedule: (fn: () => void, ms: number) => {
          timers.push({ fn, ms, cancelled: false });
          return timers.length - 1;
        },
        cancel: (id: number) => {
          if (timers[id]) timers[id]!.cancelled = true;
        },
      });
      await flush();
    },
    async fire() {
      const timer = timers.filter((t) => !t.cancelled).pop();
      expect(timer, 'a scheduled refresh').toBeTruthy();
      timer!.cancelled = true;
      timer!.fn();
      await flush();
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
  };
  return page;
}

async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function buttons(root: FakeElement, text: string): FakeElement[] {
  return root.querySelectorAll('button').filter((b) => b.textContent.trim() === text);
}

function button(root: FakeElement, text: string): FakeElement {
  const found = buttons(root, text)[0];
  expect(found, text).toBeTruthy();
  return found!;
}

function badgeWord(row: FakeElement): string {
  return row.querySelector('.badge')!.textContent.trim();
}

describe('Scope gate panel: mount and placement', () => {
  it('loads scope-gate.js once, after rag-fetch.js and rag-ui.js, and the panel sits directly after Refusal calibration', () => {
    expect(indexHtml.match(/rag-panels\/scope-gate\.js/g)).toHaveLength(1);
    const at = indexHtml.indexOf('rag-panels/scope-gate.js');
    expect(indexHtml.indexOf('rag-panels/rag-fetch.js')).toBeLessThan(at);
    expect(indexHtml.indexOf('rag-panels/rag-ui.js')).toBeLessThan(at);
    const refusalEnd = indexHtml.indexOf('</section>', indexHtml.indexOf('<section id="rag-administration-refusal"'));
    const next = indexHtml.indexOf('<section', refusalEnd);
    expect(indexHtml.slice(next, next + 60)).toContain('rag-administration-scope-gate');
    expect(panelSource).toContain('SCOPE_GATE_');
    expect(panelSource).not.toContain('innerHTML');
  });

  it('is idempotent: a second init refreshes and keeps the typed example', async () => {
    const page = loadPage();
    await page.open();
    page.textarea().value = 'Draft neutral question?';
    await page.open();
    expect(page.of('status')).toHaveLength(2);
    expect(page.textarea().value).toBe('Draft neutral question?');
    expect(page.root.querySelectorAll('[data-scope-gate-block="effect"]')).toHaveLength(1);
  });
});

describe('Scope gate panel: In effect now', () => {
  it('renders Switch, Pipeline, Thresholds and Scope data in order with four ready badges and the active headline', async () => {
    const page = loadPage();
    await page.open();
    const rows = page.root.querySelectorAll('[data-scope-gate-row]').map((r) => r.getAttribute('data-scope-gate-row'));
    expect(rows).toEqual(['switch', 'pipeline', 'thresholds', 'scope_data']);
    expect(page.root.querySelectorAll('dt').map((d) => d.textContent)).toEqual(['Switch', 'Pipeline', 'Thresholds', 'Scope data']);
    expect(page.root.querySelector('[data-scope-gate-headline]')!.textContent).toBe('The scope gate can skip retrieval in this workspace.');
    for (const name of ['pipeline', 'thresholds', 'scope_data']) expect(badgeWord(page.row(name))).toBe('Ready');
    expect(badgeWord(page.row('switch'))).toBe('On');
    expect(page.row('scope_data').textContent).toContain('Reference points: 18.');
    expect(page.row('scope_data').querySelector('time')).toBeTruthy();
    expect(page.status().textContent).toBe('Status loaded. Reference points: 18. Examples: 2.');
  });

  it('follows the server can-skip flag even when every row reads ready', async () => {
    const page = loadPage({ status: status({ canSkip: false }) });
    await page.open();
    expect(page.root.querySelector('[data-scope-gate-headline]')!.textContent).toBe('Every question is still retrieved in this workspace.');
  });

  it('shows each not-ready row with its reason and way forward', async () => {
    let body = status({ canSkip: false });
    body = readiness(body, 'pipeline', { state: 'layer_off' });
    body = readiness(body, 'thresholds', { state: 'eval_only', profileId: 'profile-alpha-1536', ragMode: 'balanced', command: CALIBRATE });
    const page = loadPage({ status: body });
    await page.open();
    expect(badgeWord(page.row('pipeline'))).toBe('Not ready');
    expect(page.row('pipeline').textContent).toContain('The query layer is off.');
    button(page.row('pipeline'), 'Open RAG Modes').click();
    expect(page.links['rag-modes']).toBe(1);
    expect(page.doc.activeElement?.id).toBe('RAG_PIPELINE');
    expect(badgeWord(page.row('thresholds'))).toBe('Fixture, eval only');
    expect(page.row('thresholds').querySelector('code')!.textContent).toBe('profile-alpha-1536');
    expect(page.row('thresholds').textContent).toContain('in Balanced mode');
    button(page.row('thresholds'), 'Copy command').click();
    await flush();
    expect(page.copied()).toBe(CALIBRATE);
    expect(page.status().textContent).toBe('Command copied.');
  });

  it('shows an unknown readiness state as its code in font-mono inside a full sentence', async () => {
    const page = loadPage({ status: readiness(status({ canSkip: false }), 'pipeline', { state: 'stage_disabled' }) });
    await page.open();
    const row = page.row('pipeline');
    expect(badgeWord(row)).toBe('Not ready');
    expect(row.textContent).toContain('This line is not ready. State: stage_disabled');
    expect(row.querySelector('code.font-mono')!.textContent).toBe('stage_disabled');
  });

  it('says when the settings differ from the running app, and warns under the switch when v2 or the layer is off', async () => {
    const page = loadPage({ status: readiness(status({ canSkip: false }), 'switch', { state: 'off' }), checked: true, layer: false });
    await page.open();
    expect(badgeWord(page.row('switch'))).toBe('Off');
    expect(page.row('switch').textContent).toContain('Settings show the scope gate On; the app uses Off until it restarts with the saved value.');
    const note = page.root.querySelector('[data-scope-gate-note]')!;
    expect(note.textContent).toContain('The scope gate runs only in the v2 pipeline with the query layer on.');
    const box = page.doc.getElementById('RAG_SCOPE_GATE')!;
    box.checked = false;
    box.dispatch('change');
    expect(note.textContent).toBe('');
    expect(page.row('switch').textContent).not.toContain('Settings show');
  });

  it('marks an invalid threshold file Not usable and shows the empty thresholds block with the command', async () => {
    const body = readiness(status({ canSkip: false, thresholds: { present: false, valid: false, source: null, recordedAt: null, command: CALIBRATE, rows: [] } }), 'thresholds', {
      state: 'invalid',
      profileId: 'profile-alpha-1536',
      ragMode: 'strict',
      command: CALIBRATE,
    });
    const page = loadPage({ status: body });
    await page.open();
    expect(badgeWord(page.row('thresholds'))).toBe('Not usable');
    expect(page.row('thresholds').textContent).toContain('is not valid, so no threshold is applied');
    const block = page.block('thresholds');
    expect(block.querySelector('[data-scope-gate-empty="cells.empty.title"]')).toBeTruthy();
    expect(block.textContent).toContain('No thresholds yet');
    expect(block.querySelector('code')!.textContent).toBe(CALIBRATE);
    expect(buttons(block, 'Copy command')).toHaveLength(1);
  });
});

describe('Scope gate panel: scope data and rebuild', () => {
  it('lists the three kinds in order; a kind without points shows 0, an em dash and Never built', async () => {
    const body = status();
    (body.scopeData as Json).kinds = [{ kind: 'tenant', referencePoints: 1 }];
    const page = loadPage({ status: body });
    await page.open();
    const rows = page.block('data').querySelectorAll('tbody tr');
    expect(rows.map((r) => r.getAttribute('data-scope-gate-kind'))).toEqual(['doc_type', 'scope_tag', 'tenant']);
    expect(rows[0]!.textContent).toBe('Document types00—Never built');
    expect(rows[2]!.textContent).toContain('1,240');
    expect(rows[2]!.querySelector('time')).toBeTruthy();
    expect(page.block('data').querySelector('caption.sr-only')!.textContent).toBe('Scope data by what it was built from');
    expect(page.block('data').querySelector('[role="region"]')!.getAttribute('tabindex')).toBe('0');
  });

  it('shows the empty block and a Missing row when nothing has been built', async () => {
    const body = readiness(status({ canSkip: false }), 'scope_data', { state: 'missing' });
    (body.scopeData as Json).state = 'missing';
    (body.scopeData as Json).kinds = [];
    const page = loadPage({ status: body });
    await page.open();
    expect(badgeWord(page.row('scope_data'))).toBe('Missing');
    expect(page.row('scope_data').textContent).toContain('No scope data for embedding profile profile-alpha-1536 in this workspace. Select Rebuild scope data.');
    expect(page.block('data').textContent).toContain('No scope data yet');
    expect(page.block('data').querySelector('table')).toBeNull();
    expect(page.root.querySelector('[data-scope-gate-headline]')!.textContent).toBe('Every question is still retrieved in this workspace.');
  });

  it('a finished rebuild announces the new count and reloads', async () => {
    const page = loadPage();
    await page.open();
    button(page.block('data'), 'Rebuild scope data').click();
    await flush();
    expect(page.of('rebuild')).toHaveLength(1);
    expect(page.of('status')).toHaveLength(2);
    expect(page.status().textContent).toBe('Scope data rebuilt. Reference points: 7.');
  });

  it('a 202 starts the 15-second refresh, stops after 20 refreshes with Still rebuilding, and pauses while the tab is hidden', async () => {
    const running = readiness(status({ canSkip: false }), 'scope_data', { state: 'rebuilding' });
    (running.scopeData as Json).state = 'rebuilding';
    let current: Json = status();
    const page = loadPage({ status: () => current, replies: { rebuild: { status: 202, body: { success: true, status: 'running' } } } });
    await page.open();
    current = running;
    button(page.block('data'), 'Rebuild scope data').click();
    await flush();
    expect(page.status().textContent).toBe('Rebuild started. This panel refreshes every 15 seconds until it finishes.');
    expect(badgeWord(page.row('scope_data'))).toBe('Rebuilding');
    expect(page.timers.at(-1)!.ms).toBe(15000);
    expect((page.block('data').querySelector('[data-scope-gate-rebuild]') as FakeElement).disabled).toBe(true);

    (page.doc as unknown as { visibilityState: string }).visibilityState = 'hidden';
    const before = page.of('status').length;
    await page.fire();
    expect(page.of('status')).toHaveLength(before);
    expect(page.pending()).toBe(0);
    (page.doc as unknown as { visibilityState: string }).visibilityState = 'visible';
    page.doc.dispatch('visibilitychange');
    expect(page.pending()).toBe(1);

    for (let i = 0; i < 20; i += 1) await page.fire();
    expect(page.of('status')).toHaveLength(before + 20);
    expect(page.pending()).toBe(0);
    expect(page.status().textContent).toBe('Still rebuilding. Select Refresh status to check again.');
  });

  it('a refresh that finds the rebuild finished stops polling and announces the count', async () => {
    const running = readiness(status({ canSkip: false }), 'scope_data', { state: 'rebuilding' });
    (running.scopeData as Json).state = 'rebuilding';
    let current: Json = running;
    const page = loadPage({ status: () => current, replies: { rebuild: { status: 409, body: { success: false, error: 'rebuild_running' } } } });
    await page.open();
    const rebuild = page.block('data').querySelector('[data-scope-gate-rebuild]') as FakeElement;
    rebuild.disabled = false;
    rebuild.click();
    await flush();
    expect(page.status().textContent).toContain('Rebuild started.');
    current = status();
    await page.fire();
    expect(page.pending()).toBe(0);
    expect(page.status().textContent).toBe('Scope data rebuilt. Reference points: 18.');
  });

  it('a failed rebuild says so with text-error and enables the button again', async () => {
    const page = loadPage({ replies: { rebuild: { status: 503, body: { success: false, error: 'scope_gate_unavailable' } } } });
    await page.open();
    const rebuild = button(page.block('data'), 'Rebuild scope data');
    rebuild.click();
    await flush();
    expect(page.status().textContent).toBe('Scope data was not rebuilt. Select Rebuild scope data again in a moment.');
    expect(page.status().classList.contains('text-error')).toBe(true);
    expect(rebuild.disabled).toBe(false);
  });

  it('shows the CLI command instead of a button when the browser cannot start it, and no control when unsupported', async () => {
    const cli = status();
    (cli.scopeData as Json).rebuild = { browser: false, command: CENTROIDS };
    const page = loadPage({ status: cli });
    await page.open();
    expect(buttons(page.block('data'), 'Rebuild scope data')).toHaveLength(0);
    expect(page.block('data').textContent).toContain('Rebuild from a terminal: ' + CENTROIDS);
    expect(buttons(page.block('data'), 'Copy command')).toHaveLength(1);

    const unsupported = readiness(status({ canSkip: false }), 'scope_data', { state: 'unsupported' });
    (unsupported.scopeData as Json).state = 'unsupported';
    (unsupported.scopeData as Json).rebuild = { browser: false, command: CENTROIDS };
    const other = loadPage({ status: unsupported });
    await other.open();
    expect(badgeWord(other.row('scope_data'))).toBe('Not usable');
    expect(buttons(other.block('data'), 'Rebuild scope data')).toHaveLength(0);
    expect(other.block('data').textContent).not.toContain('Rebuild from a terminal');
  });
});

describe('Scope gate panel: out-of-scope examples', () => {
  it('validates on submit with the button enabled: empty and too long keep focus and send nothing', async () => {
    const page = loadPage();
    await page.open();
    const add = button(page.block('examples'), 'Add example');
    expect(add.disabled).toBe(false);
    add.click();
    await flush();
    const area = page.textarea();
    expect(area.getAttribute('aria-invalid')).toBe('true');
    expect(page.block('examples').textContent).toContain('Enter a question.');
    expect(page.doc.activeElement).toBe(area);
    area.value = 'x'.repeat(501);
    add.click();
    await flush();
    expect(page.block('examples').textContent).toContain('Up to 500 characters. This has 501.');
    expect(page.of('add')).toHaveLength(0);
    expect(area.getAttribute('maxlength')).toBeNull();
  });

  it('Ctrl+Enter submits; success clears the field, keeps focus, reloads and announces', async () => {
    const page = loadPage();
    await page.open();
    const area = page.textarea();
    area.value = 'Another neutral question?';
    area.dispatch('keydown', { key: 'Enter', ctrlKey: true });
    await flush();
    expect(page.of('add')).toHaveLength(1);
    expect(page.of('add')[0]!.body).toEqual({ text: 'Another neutral question?' });
    expect(area.value).toBe('');
    expect(page.doc.activeElement).toBe(page.textarea());
    expect(page.of('status')).toHaveLength(2);
    expect(page.status().textContent).toBe('Example added.');
    area.value = 'line';
    area.dispatch('keydown', { key: 'Enter' });
    await flush();
    expect(page.of('add')).toHaveLength(1);
  });

  it('maps duplicate, embedding and limit codes and keeps the text in the field', async () => {
    for (const [reply, text] of [
      [{ status: 409, body: { success: false, error: 'example_exists' } }, 'This example is already in the list.'],
      [{ status: 503, body: { success: false, error: 'embedding_unavailable' } }, 'The example could not be prepared right now, so it was not saved.'],
      [{ status: 400, body: { success: false, error: 'text_too_long' } }, 'Up to 500 characters.'],
    ] as const) {
      const page = loadPage({ replies: { add: reply } });
      await page.open();
      page.textarea().value = 'Kept neutral question?';
      button(page.block('examples'), 'Add example').click();
      await flush();
      expect(page.block('examples').textContent).toContain(text);
      expect(page.textarea().value).toBe('Kept neutral question?');
      expect(page.textarea().getAttribute('aria-invalid')).toBe('true');
    }
    const full = status();
    (full.examples as Json).total = 100;
    const page = loadPage({ status: full });
    await page.open();
    expect(page.block('examples').textContent).toContain('The limit of 100 examples is reached. Delete one before adding another.');
    expect(page.block('examples').querySelector('textarea')).toBeNull();
    expect(page.block('examples').querySelector('[data-scope-gate-count]')!.textContent).toBe('Examples: 100 of 100');
  });

  it('a timeout reports the unknown outcome and reloads', async () => {
    const page = loadPage({ replies: { add: { thrown: true } } });
    await page.open();
    page.textarea().value = 'Timeout neutral question?';
    button(page.block('examples'), 'Add example').click();
    await flush();
    expect(page.status().textContent).toContain('The server did not answer, so the change may or may not have been made.');
    expect(page.of('status')).toHaveLength(2);
  });

  it('shows the in-flight text on Add example and disables the sibling buttons', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<Reply>((resolve) => {
      release = () => resolve({ status: 201, body: { success: true, example: { id: EX1, createdAt: '2026-11-25T00:00:00.000Z', createdBy: ACTOR } } });
    });
    const page = loadPage({ replies: { add: () => held } });
    await page.open();
    page.textarea().value = 'Slow neutral question?';
    const add = button(page.block('examples'), 'Add example');
    add.click();
    await flush(5);
    expect(add.textContent).toContain('Adding…');
    expect(add.disabled).toBe(true);
    expect(page.block('examples').querySelectorAll('[data-scope-gate-delete]').every((b) => b.disabled)).toBe(true);
    expect((page.block('data').querySelector('[data-scope-gate-rebuild]') as FakeElement).disabled).toBe(true);
    release!();
    await flush();
    expect(page.status().textContent).toBe('Example added.');
  });

  it('delete asks first with Keep example focused, deletes by id and moves focus to the next row', async () => {
    let deleted = false;
    const page = loadPage({
      multiTenant: true,
      status: () => {
        const body = status();
        if (deleted) {
          (body.examples as Json).rows = ((body.examples as Json).rows as Json[]).slice(1);
          (body.examples as Json).total = 1;
        }
        return body;
      },
      replies: {
        delete: () => {
          deleted = true;
          return { status: 200, body: { success: true } };
        },
      },
    });
    await page.open();
    const del = page.block('examples').querySelectorAll('[data-scope-gate-delete]')[0]!;
    expect(del.getAttribute('aria-label')).toBe('Delete example: Neutral sample question one?');
    del.click();
    await flush();
    const dialog = page.doc.body.querySelector('dialog')!;
    expect(dialog.textContent).toContain('Delete this out-of-scope example?');
    expect(page.doc.activeElement!.textContent).toBe('Keep example');
    button(dialog, 'Delete example').click();
    await flush();
    expect(page.of('delete')[0]!.path).toBe(`${BASE}/examples/${EX1}?organizationId=${ORG}`);
    expect(page.status().textContent).toBe('Example deleted.');
    expect(page.doc.activeElement!.getAttribute('data-scope-gate-delete')).toBe('0');
    expect(page.block('examples').querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('a 404 on delete says someone else changed it and reloads', async () => {
    const page = loadPage({ replies: { delete: { status: 404, body: { success: false, error: 'Example not found' } } } });
    await page.open();
    page.block('examples').querySelectorAll('[data-scope-gate-delete]')[1]!.click();
    await flush();
    button(page.doc.body.querySelector('dialog')!, 'Delete example').click();
    await flush();
    expect(page.status().textContent).toBe('This item was changed by someone else. The list has been reloaded.');
    expect(page.of('status')).toHaveLength(2);
  });

  it('shows the empty block, Not in use rows and the added-by id in font-mono', async () => {
    const empty = status();
    (empty.examples as Json).rows = [];
    (empty.examples as Json).total = 0;
    const page = loadPage({ status: empty });
    await page.open();
    expect(page.block('examples').textContent).toContain('No out-of-scope examples');
    expect(page.block('examples').querySelector('textarea')).toBeTruthy();

    const notInUse = status();
    ((notInUse.examples as Json).rows as Json[])[0]!.inUse = false;
    const other = loadPage({ status: notInUse });
    await other.open();
    const first = other.block('examples').querySelectorAll('tbody tr')[0]!;
    expect(first.textContent).toContain('Not in use');
    expect(first.textContent).toContain('Prepared for another embedding profile. Rebuild scope data to include it.');
    expect(first.querySelector('span.font-mono')!.textContent).toBe(ACTOR);
  });
});

describe('Scope gate panel: thresholds', () => {
  it('is read-only, marks the in-use rows, formats rates and never colours a number', async () => {
    const page = loadPage();
    await page.open();
    const block = page.block('thresholds');
    for (const tag of ['input', 'select', 'textarea']) expect(block.querySelectorAll(tag)).toHaveLength(0);
    expect(block.querySelectorAll('[contenteditable]')).toHaveLength(0);
    const rows = block.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('In use');
    expect(rows[0]!.textContent).toContain('0.037');
    expect(rows[0]!.textContent).toContain('3.3%');
    expect(rows[0]!.textContent).toContain('95% upper bound 7.3%');
    expect(rows[0]!.textContent).toContain('n = 123');
    expect(rows[2]!.textContent).not.toContain('In use');
    expect(rows[2]!.textContent).toContain('Not calibrated');
    expect(rows[2]!.textContent).toContain('None');
    expect(rows[2]!.textContent).not.toContain('upper bound');
    for (const cell of block.querySelectorAll('td')) expect(cell.className).not.toMatch(/text-(success|error|warning|info)/);
    expect(block.textContent).not.toMatch(/at most|≤|within target|meets the target/);
  });
});

describe('Scope gate panel: errors and isolation', () => {
  it('401 replaces the data blocks with the sign-in alert; the switch and its note still work', async () => {
    const page = loadPage({ replies: { status: { status: 401, body: { success: false, error: 'Unauthorized' } } }, layer: false });
    await page.open();
    expect(page.alert().textContent).toContain('Admin sign-in required');
    expect(buttons(page.alert(), 'Reload panel')).toHaveLength(1);
    expect(page.root.querySelector('[data-scope-gate-block="effect"]')).toBeNull();
    expect(page.root.querySelectorAll('input[type="password"]')).toHaveLength(0);
    const box = page.doc.getElementById('RAG_SCOPE_GATE')!;
    box.checked = true;
    box.dispatch('change');
    expect(page.root.querySelector('[data-scope-gate-note]')!.textContent).toContain('The scope gate runs only in the v2 pipeline');
  });

  it('403 Forbidden says the admin is not a member of the workspace', async () => {
    const page = loadPage({ replies: { status: { status: 403, body: { success: false, error: 'Forbidden' } } } });
    await page.open();
    expect(page.alert().textContent).toContain('Your admin account is not a member of this workspace.');
  });

  it('503 after content shows the unavailable sentence and keeps the earlier content dimmed', async () => {
    let fail = false;
    const page = loadPage({ replies: { status: () => (fail ? { status: 503, body: { success: false, error: 'scope_gate_unavailable' } } : { status: 200, body: status() }) } });
    await page.open();
    fail = true;
    button(page.root, 'Refresh status').click();
    await flush();
    expect(page.alert().textContent).toContain('The scope gate status is unavailable right now. Select Reload panel in a moment.');
    expect(page.block('effect')).toBeTruthy();
    expect(page.block('effect').parentNode!.classList.contains('opacity-60')).toBe(true);
  });

  it('a bubbling change from the example textarea never reaches the config writer', async () => {
    const page = loadPage();
    await page.open();
    page.textarea().value = 'Never a config key';
    bubble(page.textarea(), 'change');
    expect(page.configWrites).toEqual([]);
    bubble(page.doc.getElementById('RAG_SCOPE_GATE')!, 'change');
    expect(page.configWrites.map(([key]) => key)).toEqual(['RAG_SCOPE_GATE']);
  });

  it('renders markup and script in every server string as text, and never a tenant key, vector or score', async () => {
    const body = status({ tenantKey: 's:default', vector: [0.123456], score: 0.987654 });
    body.running = { ...(body.running as Json), activeProfileId: XSS_PAYLOAD };
    body.readiness = [
      { row: 'switch', state: XSS_PAYLOAD },
      { row: 'pipeline', state: JS_URL },
      { row: 'thresholds', state: 'missing', profileId: XSS_PAYLOAD, ragMode: XSS_PAYLOAD, command: JS_URL },
      { row: 'scope_data', state: 'missing' },
    ];
    (body.scopeData as Json).kinds = [{ kind: XSS_PAYLOAD, referencePoints: 2, centroid: [0.5] }];
    (body.scopeData as Json).state = 'missing';
    (body.examples as Json).rows = [{ id: EX1, text: XSS_PAYLOAD + ' ' + JS_URL, createdBy: XSS_PAYLOAD, createdByName: JS_URL, createdAt: '2026-11-24T09:00:00.000Z', inUse: true }];
    (body.thresholds as Json).rows = [threshold({ embeddingProfileId: XSS_PAYLOAD, ragMode: JS_URL, status: XSS_PAYLOAD })];
    const page = loadPage({ status: body, replies: { add: { status: 400, body: { success: false, error: 'Invalid request data', details: [{ path: 'text', message: XSS_PAYLOAD }] } } } });
    await page.open();
    page.textarea().value = 'Neutral question?';
    button(page.block('examples'), 'Add example').click();
    await flush();
    expect(injectedElements(page.doc)).toEqual([]);
    expect(page.doc.innerHtmlWrites).toBe(0);
    expect(page.doc.body.querySelectorAll('a').filter((a) => page.root.contains(a))).toHaveLength(0);
    const text = page.root.textContent;
    expect(text).toContain(XSS_PAYLOAD);
    expect(text).toContain(JS_URL);
    expect(text).not.toContain('s:default');
    expect(text).not.toContain('0.123456');
    expect(text).not.toContain('0.987654');
    for (const el of page.root.querySelectorAll('*')) expect(el.getAttribute('title')).toBeNull();
  });
});

describe('Scope gate panel: workspace, locale and pointer', () => {
  it('follows the workspace selector in multi-tenant mode and reloads on change', async () => {
    const page = loadPage({ multiTenant: true });
    await page.open();
    expect(page.of('status')[0]!.query.get('organizationId')).toBe(ORG);
    expect(page.root.querySelector('[data-scope-gate-workspace]')!.textContent).toBe('Workspace: Workspace One');
    const selector = page.doc.getElementById('workspace-selector')!;
    selector.value = '';
    selector.dispatch('change');
    await flush();
    expect(page.of('status')).toHaveLength(2);
    expect(page.of('status')[1]!.query.get('organizationId')).toBeNull();
    expect(page.root.querySelector('[data-scope-gate-workspace]')!.textContent).toBe('Workspace: Default workspace');

    const single = loadPage();
    await single.open();
    expect(single.root.querySelector('[data-scope-gate-workspace]')).toBeNull();
  });

  it('applies zh and it labels on mount, including the switch and the pointer', async () => {
    const zh = loadPage({ locale: 'zh-CN' });
    expect(zh.doc.querySelector('[data-scope-gate-pointer]')!.textContent).toBe('打开范围闸门');
    await zh.open();
    expect(zh.root.getAttribute('lang')).toBe('zh');
    expect(zh.doc.getElementById('rag-scope-gate-title')!.textContent).toBe('范围闸门');
    expect(zh.root.querySelector('[data-rag-i18n="switch.label"]')!.textContent).toBe('启用范围闸门（RAG_SCOPE_GATE）');
    expect(zh.root.querySelector('[data-rag-i18n="switch.label"] span')!.getAttribute('translate')).toBe('no');
    expect(zh.root.querySelector('[data-scope-gate-headline]')!.textContent).toBe('在此工作区，范围闸门可以跳过检索。');
    expect(zh.block('examples').querySelector('[data-scope-gate-count]')!.textContent).toBe('示例：2 / 100');

    const it_ = loadPage({ locale: 'it-IT' });
    await it_.open();
    expect(it_.doc.getElementById('rag-scope-gate-title')!.textContent).toBe('Filtro di ambito');
    expect(it_.doc.querySelector('[data-scope-gate-pointer-text]')!.textContent).toContain('RAG administration, Filtro di ambito');
    expect(it_.root.querySelectorAll('dt').map((d) => d.textContent)).toEqual(['Interruttore', 'Pipeline', 'Soglie', 'Dati di ambito']);
  });

  it('the Open scope gate pointer selects the tab and focuses the panel heading without a request', () => {
    const page = loadPage();
    page.doc.querySelector('[data-scope-gate-pointer]')!.click();
    expect(page.links['rag-administration']).toBeGreaterThan(0);
    expect(page.doc.activeElement?.id).toBe('rag-scope-gate-title');
  });

  it('every label table has the same keys in en, zh and it, and every count line is label: number', () => {
    const ctx: Json = {};
    vm.createContext(ctx);
    new vm.Script(panelSource + '\nthis.__labels = SCOPE_GATE_LABELS;').runInContext(ctx);
    const labels = ctx.__labels as Record<string, Record<string, string>>;
    const en = Object.keys(labels.en!).sort();
    expect(Object.keys(labels.zh!).sort()).toEqual(en);
    expect(Object.keys(labels.it!).sort()).toEqual(en);
    for (const loc of Object.values(labels)) for (const text of Object.values(loc)) expect(text).not.toMatch(/\(s\)|\{count, plural/);
  });
});

describe('UI review 06.2 fixes', () => {
  it('a first-load 404 shows its own not-available copy in a neutral alert, never error.changed, in en, zh and it', async () => {
    const expected: Record<string, string> = {
      'en-US': 'The scope gate is not available on this deployment. Update the app, then reload.',
      'zh-CN': '此部署中没有范围闸门。请更新应用，然后重新加载。',
      'it-IT': "Il filtro di ambito non è disponibile in questa distribuzione. Aggiorna l’app, poi ricarica.",
    };
    for (const locale of Object.keys(expected)) {
      const page = loadPage({ locale, replies: { status: { status: 404, body: { error: 'Not found' } } } });
      await page.open();
      const alert = page.root.querySelector('[data-scope-gate-not-available]')!;
      expect(alert).toBeTruthy();
      expect(alert.className).not.toContain('alert-error');
      expect(alert.textContent).toContain(expected[locale]!);
      expect(page.alert().textContent).not.toContain('changed by someone else');
    }
  });

  it('a load failure is shown once: the alert holds the sentence, the status line says Status not loaded.', async () => {
    const page = loadPage({ replies: { status: { status: 500, body: {} } } });
    await page.open();
    const alertText = page.alert().textContent.trim();
    expect(alertText.length).toBeGreaterThan(0);
    expect(page.status().textContent.trim()).toBe('Status not loaded.');
    expect(alertText).not.toContain('Status not loaded.');
  });

  it('the thresholds table fits at 1024: Recorded moves under the profile until xl and ids wrap at md and up', async () => {
    const page = loadPage();
    await page.open();
    const block = page.block('thresholds');
    const recordedHead = block.querySelectorAll('th').find((th) => th.textContent === 'Recorded')!;
    expect(recordedHead.className).toContain('max-xl:hidden');
    expect(recordedHead.className.split(' ')).not.toContain('hidden');
    const stacked = block.querySelector('[data-scope-gate-recorded-stacked]')!;
    expect(stacked).toBeTruthy();
    expect(stacked.className).toContain('max-lg:hidden');
    expect(stacked.className.split(' ')).not.toContain('hidden');
    expect(stacked.className).toContain('xl:hidden');
    expect(stacked.textContent).toContain('Recorded: ');
    const id = block.querySelector('tbody th span')!;
    expect(id.className).toContain('md:break-words');
  });
});

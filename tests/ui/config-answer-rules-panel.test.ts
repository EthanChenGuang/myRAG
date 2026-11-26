import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const ENDPOINT = '/api/config/answer-rules';

let root: string;
let server: http.Server;
let port: number;
let serverModule: { server: http.Server; answerRulesModelFamily: (id: string) => string | null };

interface Reply {
  status: number;
  body: string;
}

function call(method: string, url: string, options: { host?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${port}`, ...(options.headers ?? {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const DATA_FILES = [
  'eval/config/output-caps.json',
  'eval/config/groundedness-judge-thresholds.json',
  'config/rag/output-guard-rules.json',
  'config/rag/model-families.json',
  'config/rag/language-packs.json',
];
const dataPath = (file: string) => path.join(root, file);
const envPath = () => path.join(root, '.env.local');

function copyRealData() {
  for (const file of DATA_FILES) {
    fs.mkdirSync(path.dirname(dataPath(file)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, file), dataPath(file));
  }
}

function writeEnv(lines: string[]) {
  fs.writeFileSync(envPath(), [...lines, ''].join('\n'));
}

async function getSummary(): Promise<Record<string, unknown>> {
  const reply = await call('GET', ENDPOINT);
  expect(reply.status, reply.body).toBe(200);
  return JSON.parse(reply.body) as Record<string, unknown>;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-answer-rules-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  writeEnv([]);
  copyRealData();
  process.env.MYRAG_CONFIG_ROOT = root;
  serverModule = require('../../scripts/config-server.js');
  server = serverModule.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
});

beforeEach(() => {
  copyRealData();
  writeEnv(['RAG_SIDECAR_SECRET=placeholder-sidecar-secret', 'OPENROUTER_API_KEY=placeholder-openrouter-key']);
});

describe('GET /api/config/answer-rules endpoint (D-57, UI-SPEC 8.1)', () => {
  it('returns the named fields only', async () => {
    const body = await getSummary();
    expect(Object.keys(body).sort()).toEqual(['allowlist', 'caps', 'floor', 'judgeLanguages', 'ruleCounts', 'rulesVersion', 'sameFamily']);
    expect(body.caps).toEqual([
      { mode: 'strict', limit: null, source: 'default' },
      { mode: 'balanced', limit: null, source: 'default' },
    ]);
    expect(body.allowlist).toEqual([]);
    expect(body.sameFamily).toBeNull();
  });

  it('reports the floor that outputCapFloor() of the app computes (D-31)', async () => {
    const { outputCapFloor } = await import('@/lib/rag/generation/output-cap');
    const body = await getSummary();
    expect(typeof body.floor).toBe('number');
    expect(body.floor).toBe(outputCapFloor());
  });

  it('reports the cap cells written by the sweep', async () => {
    const caps = JSON.parse(fs.readFileSync(dataPath('eval/config/output-caps.json'), 'utf8'));
    caps.cells = [
      { config_hash: 'h1', limit: 900, mode: 'balanced', run_ids: ['r1'], source: 'sweep' },
      { config_hash: 'h1', limit: 700, mode: 'strict', run_ids: ['r1'], source: 'sweep' },
    ];
    fs.writeFileSync(dataPath('eval/config/output-caps.json'), JSON.stringify(caps));
    const body = await getSummary();
    expect(body.caps).toEqual([
      { mode: 'strict', limit: 700, source: 'sweep' },
      { mode: 'balanced', limit: 900, source: 'sweep' },
    ]);
    expect(JSON.stringify(body)).not.toContain('r1');
    expect(JSON.stringify(body)).not.toContain('h1');
  });

  it('reports the guard rule-set version and the rule counts per shipped language', async () => {
    const rules = JSON.parse(fs.readFileSync(dataPath('config/rag/output-guard-rules.json'), 'utf8'));
    const count = (lang: string) => rules.credential_rules.filter((r: { language: string }) => r.language === lang).length;
    const body = await getSummary();
    expect(body.rulesVersion).toBe(rules.version);
    expect(body.ruleCounts).toEqual({ zh: count('zh'), en: count('en'), it: count('it') });
    for (const rule of rules.credential_rules) expect(JSON.stringify(body)).not.toContain(rule.id);
  });

  it('lists judge languages as the languages without a groundedness scorer, with no number', async () => {
    writeEnv(['RAG_SUPPORTED_LANGUAGES=zh,en,it', 'RAG_PRIMARY_LANGUAGE=en']);
    expect((await getSummary()).judgeLanguages).toEqual([
      { language: 'zh', calibrated: false },
      { language: 'it', calibrated: false },
    ]);
    writeEnv(['RAG_SUPPORTED_LANGUAGES=zh,en,it', 'RAG_PRIMARY_LANGUAGE=en', 'RAG_GROUNDEDNESS_VECTARA_OPT_IN=true']);
    expect((await getSummary()).judgeLanguages).toEqual([{ language: 'it', calibrated: false }]);
    writeEnv([
      'RAG_SUPPORTED_LANGUAGES=zh,en,it',
      'RAG_PRIMARY_LANGUAGE=en',
      'RAG_GROUNDEDNESS_VECTARA_OPT_IN=true',
      'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=multi-tenant',
    ]);
    expect((await getSummary()).judgeLanguages).toEqual([
      { language: 'zh', calibrated: false },
      { language: 'it', calibrated: false },
    ]);
    writeEnv(['RAG_SUPPORTED_LANGUAGES=en', 'RAG_PRIMARY_LANGUAGE=en']);
    expect((await getSummary()).judgeLanguages).toEqual([]);
  });

  it('marks a language calibrated only for a calibrated cell of the configured judge model', async () => {
    writeEnv(['RAG_SUPPORTED_LANGUAGES=zh,en,it', 'RAG_PRIMARY_LANGUAGE=en', 'RAG_GROUNDEDNESS_JUDGE_MODEL=openai/gpt-5-mini']);
    const cell = {
      config_hash: 'cfg',
      fitted_at: null,
      judge_version: 'v0123456789abcde',
      max_unsupported_share: 0.25,
      precision: 0.91,
      recall: 0.87,
      run_ids: ['run-1'],
    };
    fs.writeFileSync(
      dataPath('eval/config/groundedness-judge-thresholds.json'),
      JSON.stringify({
        schema_version: 1,
        cells: [
          { ...cell, judge_model: 'openai/gpt-5-mini', language: 'it', source: 'calibrated' },
          { ...cell, judge_model: 'openai/gpt-5-mini', language: 'zh', source: 'fixture' },
          { ...cell, judge_model: 'google/gemini-2.5-pro', language: 'zh', source: 'calibrated' },
        ],
      }),
    );
    const body = await getSummary();
    expect(body.judgeLanguages).toEqual([
      { language: 'zh', calibrated: false },
      { language: 'it', calibrated: true },
    ]);
    const text = JSON.stringify(body);
    for (const value of ['0.25', '0.91', '0.87', 'run-1', 'cfg', 'v0123456789abcde']) expect(text).not.toContain(value);
  });

  it('compares the judge family with the default answer model', async () => {
    writeEnv(['RAG_GROUNDEDNESS_JUDGE_MODEL=anthropic/claude-haiku-5.5']);
    expect((await getSummary()).sameFamily).toBe(true);
    writeEnv(['RAG_GROUNDEDNESS_JUDGE_MODEL=openai/gpt-5-mini']);
    expect((await getSummary()).sameFamily).toBe(false);
    writeEnv([
      'RAG_GROUNDEDNESS_JUDGE_MODEL=openai/gpt-5-mini',
      `NEXT_PUBLIC_OPENROUTER_MODELS=${JSON.stringify([{ id: 'qwen/qwen3-32b' }, { id: 'openai/gpt-5', isDefault: true }])}`,
    ]);
    expect((await getSummary()).sameFamily).toBe(true);
    writeEnv(['RAG_GROUNDEDNESS_JUDGE_MODEL=mystery/model']);
    expect((await getSummary()).sameFamily).toBeNull();
    writeEnv(['RAG_GROUNDEDNESS_JUDGE_MODEL=']);
    expect((await getSummary()).sameFamily).toBeNull();
  });

  it('derives model families like modelFamily() of the app', async () => {
    const { modelFamily } = await import('@/lib/rag/generation/judge');
    const cases = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/rag/model-family-cases.json'), 'utf8')) as {
      families: Array<[string, string]>;
      unknown: string[];
    };
    for (const [id] of cases.families) expect(serverModule.answerRulesModelFamily(id), id).toBe(modelFamily(id));
    for (const id of cases.unknown) expect(serverModule.answerRulesModelFamily(id), id).toBeNull();
  });

  it('parses the allowlist into normalized host entries', async () => {
    writeEnv(['RAG_OUTPUT_LINK_ALLOWLIST= Docs.Example.com, https://cdn.example.org/path ,,not a host,*.example.net.']);
    expect((await getSummary()).allowlist).toEqual(['docs.example.com', 'cdn.example.org', 'example.net']);
  });

  it('returns no env value or secret', async () => {
    const reply = await call('GET', ENDPOINT);
    for (const value of ['placeholder-sidecar-secret', 'placeholder-openrouter-key']) expect(reply.body).not.toContain(value);
  });

  it('refuses a foreign Host exactly like GET /api/config', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:9999']) {
      const reply = await call('GET', ENDPOINT, { host });
      const reference = await call('GET', '/api/config', { host });
      expect(reply.status).toBe(403);
      expect(reply.body).toBe(reference.body);
      expect(reply.body).not.toContain('rulesVersion');
    }
  });

  it.each([
    ['missing caps file', () => fs.rmSync(dataPath('eval/config/output-caps.json')), 'answer_rules_caps_missing'],
    ['caps file that is not JSON', () => fs.writeFileSync(dataPath('eval/config/output-caps.json'), '{not json'), 'answer_rules_caps_invalid'],
    [
      'caps file with one cell',
      () => fs.writeFileSync(dataPath('eval/config/output-caps.json'), JSON.stringify({ schema_version: 1, cells: [{ mode: 'strict', limit: null, source: 'default' }] })),
      'answer_rules_caps_invalid',
    ],
    ['missing judge thresholds file', () => fs.rmSync(dataPath('eval/config/groundedness-judge-thresholds.json')), 'answer_rules_judge_missing'],
    ['missing guard rules file', () => fs.rmSync(dataPath('config/rag/output-guard-rules.json')), 'answer_rules_guard_missing'],
    [
      'guard rules without a version',
      () => fs.writeFileSync(dataPath('config/rag/output-guard-rules.json'), JSON.stringify({ schema_version: 1, credential_rules: [] })),
      'answer_rules_guard_invalid',
    ],
    ['missing family table', () => fs.rmSync(dataPath('config/rag/model-families.json')), 'answer_rules_families_missing'],
    ['missing language registry', () => fs.rmSync(dataPath('config/rag/language-packs.json')), 'answer_rules_languages_missing'],
  ])('a %s answers 500 with a code and no stack', async (_name, mutate, code) => {
    mutate();
    const reply = await call('GET', ENDPOINT);
    expect(reply.status).toBe(500);
    const body = JSON.parse(reply.body);
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe('string');
    expect(reply.body).not.toMatch(/at .*\.js:\d+|ENOENT|Unexpected token|SyntaxError/);
    expect(reply.body).not.toContain(root);
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// The panel script (UI-SPEC 6.11, 6.12, 12.3), run in a vm context over the card markup of index.html.

import vm from 'node:vm';
import { FakeDocument, type FakeElement } from './helpers/html-fake-dom';

const configUiDir = path.join(repoRoot, 'scripts/config-ui');
const indexHtml = fs.readFileSync(path.join(configUiDir, 'index.html'), 'utf8');

function cardMarkup(): string {
  const start = indexHtml.indexOf('<!-- Answer rules and output safety -->');
  const end = indexHtml.indexOf('<!-- Info Box -->', start);
  expect(start).toBeGreaterThan(-1);
  return indexHtml.slice(start, end);
}

function cardInlineScript(): string {
  const markup = cardMarkup();
  const start = markup.indexOf('<script>');
  return markup.slice(start + '<script>'.length, markup.indexOf('</script>', start));
}

const SWEEP_COMMAND = 'python -m rag_eval.sweep output-cap';
const JUDGE_COMMAND = 'python -m rag_eval.calibrate groundedness-judge';

function summary(overrides: Record<string, unknown> = {}) {
  return {
    caps: [
      { mode: 'strict', limit: null, source: 'default' },
      { mode: 'balanced', limit: null, source: 'default' },
    ],
    floor: 300,
    judgeLanguages: [
      { language: 'zh', calibrated: false },
      { language: 'it', calibrated: true },
    ],
    sameFamily: false,
    allowlist: ['docs.example.com', 'cdn.example.org'],
    rulesVersion: '2026-01-02.3',
    ruleCounts: { zh: 2, en: 3, it: 4 },
    ...overrides,
  };
}

interface MountOptions {
  locale?: string;
  reply?: { ok: boolean; status: number; body: unknown } | 'throw' | 'pending';
  allowlistField?: string | null;
  securityEventsHost?: boolean;
}

function mountPanel(options: MountOptions = {}) {
  const doc = new FakeDocument();
  const wrapper = doc.createElement('div');
  wrapper.id = 'rag-modes';
  wrapper.innerHTML = cardMarkup();
  doc.body.appendChild(wrapper);
  const extra = doc.createElement('div');
  extra.innerHTML = [
    '<a class="menu-item" data-tab="rag-modes">RAG Modes</a>',
    '<a class="menu-item" data-tab="rag-modes">RAG Modes</a>',
    '<a class="menu-item" data-tab="rag-administration">RAG administration</a>',
    '<input type="checkbox" id="RAG_CITATIONS">',
    '<input type="checkbox" id="RAG_CLAUDE_CITATIONS">',
    '<input type="checkbox" id="RAG_GROUNDEDNESS">',
    '<input type="hidden" id="RAG_SUPPORTED_LANGUAGES" value="">',
    '<select id="RAG_INGEST_PIPELINE"><option value="legacy">legacy</option><option value="unified">unified</option></select>',
  ].join('');
  doc.body.appendChild(extra);
  (doc.getElementById('RAG_INGEST_PIPELINE') as FakeElement).value = 'legacy';
  if (options.allowlistField !== undefined && options.allowlistField !== null) {
    const area = doc.createElement('textarea');
    area.id = 'RAG_OUTPUT_LINK_ALLOWLIST';
    area.value = options.allowlistField;
    doc.body.appendChild(area);
  }
  if (options.securityEventsHost) {
    const events = doc.createElement('section');
    events.id = 'rag-administration-security-events';
    doc.body.appendChild(events);
  }
  doc.innerHtmlWrites = 0;
  const hidden = doc.getElementById('RAG_MAX_OUTPUT_TOKENS') as FakeElement;
  hidden.value = 'off';
  for (const select of ['RAG_OUTPUT_GUARD', 'RAG_UPLOADER_HOLD']) (doc.getElementById(select) as FakeElement).value = 'off';
  (doc.querySelector('[data-answer-cap="mode"]') as FakeElement).value = 'off';

  const reply = options.reply ?? { ok: true, status: 200, body: summary() };
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
  let release: (() => void) | null = null;
  const copied: string[] = [];
  const respond = () =>
    reply === 'throw'
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ ok: (reply as { ok: boolean }).ok, status: (reply as { status: number }).status, json: async () => (reply as { body: unknown }).body });
  const fetchStub = (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init });
    if (reply === 'pending') return new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, json: async () => summary() })));
    return respond();
  };
  class Event {
    readonly type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  const context: Record<string, unknown> = {
    document: doc,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    navigator: { language: options.locale ?? 'en-US', clipboard: { writeText: async (text: string) => void copied.push(text) } },
    location: { origin: 'http://config.local' },
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    AbortController,
    Intl,
    URL,
    Event,
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['rag-panels/rag-ui.js', 'rag-panels/answer-rules.js']) {
    new vm.Script(fs.readFileSync(path.join(configUiDir, file), 'utf8'), { filename: file }).runInContext(context);
  }
  new vm.Script(cardInlineScript(), { filename: 'answer-rules-inline.js' }).runInContext(context);
  const byId = (id: string) => doc.getElementById(id) as FakeElement;
  const init = () => (context.initAnswerRulesPanel as () => Promise<unknown>)();
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const toggle = (id: string, checked: boolean) => {
    byId(id).checked = checked;
    byId(id).dispatch('change');
  };
  const setValue = (id: string, value: string, type = 'change') => {
    byId(id).value = value;
    byId(id).dispatch(type);
  };
  const warnings = () =>
    byId('rag-answer-rules-alerts')
      .querySelectorAll('[data-answer-rules-warning]')
      .map((el) => el.getAttribute('data-answer-rules-warning'));
  return { doc, context, calls, copied, byId, init, settle, toggle, setValue, warnings, release: () => release && release() };
}

const text = (el: FakeElement | null) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

describe('answer-rules.js: read-only blocks (UI-SPEC 6.12)', () => {
  it('renders the caps table, the floor and the sweep command with Copy command', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    const caps = ui.byId('rag-answer-rules-caps');
    const rows = caps.querySelectorAll('tbody tr').map((row) => row.querySelectorAll('td').map((cell) => text(cell)));
    expect(rows).toEqual([
      ['strict', 'No limit chosen', 'Default'],
      ['balanced', 'No limit chosen', 'Default'],
    ]);
    expect(text(caps)).toContain('Limits chosen by evaluation');
    expect(text(caps)).toContain('Smallest limit accepted: 300 tokens');
    expect(caps.querySelectorAll('code').map((c) => text(c))).toContain(SWEEP_COMMAND);
    const copy = caps.querySelectorAll('button').find((b) => text(b) === 'Copy command')!;
    copy.click();
    await ui.settle();
    expect(ui.copied).toEqual([SWEEP_COMMAND]);
    expect(text(caps)).toContain('Command copied.');
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.url).toBe('/api/config/answer-rules');
    expect(ui.calls[0]!.init.credentials).toBe('same-origin');
  });

  it('shows limits and sources chosen by a sweep', async () => {
    const ui = mountPanel({
      reply: {
        ok: true,
        status: 200,
        body: summary({ caps: [{ mode: 'strict', limit: 700, source: 'sweep' }, { mode: 'balanced', limit: 1200, source: 'sweep' }] }),
      },
    });
    await ui.init();
    await ui.settle();
    const rows = ui.byId('rag-answer-rules-caps').querySelectorAll('tbody tr').map((row) => row.querySelectorAll('td').map((cell) => text(cell)));
    expect(rows).toEqual([
      ['strict', '700', 'Evaluation run'],
      ['balanced', '1,200', 'Evaluation run'],
    ]);
  });

  it('renders the judge table with a status per language and no number', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    const judge = ui.byId('rag-answer-rules-judge-calibration');
    const rows = judge.querySelectorAll('tbody tr').map((row) => row.querySelectorAll('td').map((cell) => text(cell)));
    expect(rows).toEqual([
      ['zh', 'Not calibrated: the answer label stays “Not checked”; sentence marks still show'],
      ['it', 'Calibrated'],
    ]);
    expect(text(judge)).toContain('Judge calibration');
    expect(judge.querySelectorAll('code').map((c) => text(c))).toContain(JUDGE_COMMAND);
    expect(text(judge.querySelector('table'))).not.toMatch(/\d/);
  });

  it('says no judge is needed when every language has a scorer', async () => {
    const ui = mountPanel({ reply: { ok: true, status: 200, body: summary({ judgeLanguages: [] }) } });
    await ui.init();
    await ui.settle();
    const judge = ui.byId('rag-answer-rules-judge-calibration');
    expect(judge.querySelector('table')).toBeNull();
    expect(text(judge)).toContain('Every supported language has a groundedness scorer.');
  });

  it('lists the allowlist from the call as code entries, never links, with the always-allowed line', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    const list = ui.byId('rag-answer-rules-allowlist');
    const codes = list.querySelectorAll('li code');
    expect(codes.map((c) => text(c))).toEqual(['docs.example.com', 'cdn.example.org']);
    for (const code of codes) expect(code.getAttribute('translate')).toBe('no');
    expect(list.querySelectorAll('a')).toHaveLength(0);
    expect(text(list)).toContain('Always allowed:');
    expect(list.querySelectorAll('button').map((b) => text(b))).not.toContain('Edit allowlist');
  });

  it('reads the allowlist from the page field when present and offers Edit allowlist', async () => {
    const ui = mountPanel({ allowlistField: 'one.example\ntwo.example, one.example' });
    const opened: string[] = [];
    (ui.context as Record<string, unknown>).quarantinePanel = { tabs: { select: (name: string) => opened.push(name) } };
    let adminClicks = 0;
    ui.doc.querySelector('[data-tab="rag-administration"]')!.addEventListener('click', () => (adminClicks += 1));
    await ui.init();
    await ui.settle();
    const list = ui.byId('rag-answer-rules-allowlist');
    expect(list.querySelectorAll('li code').map((c) => text(c))).toEqual(['one.example', 'two.example']);
    const edit = list.querySelectorAll('button').find((b) => text(b) === 'Edit allowlist')!;
    expect(edit.className).toContain('btn-link');
    edit.click();
    expect(adminClicks).toBe(1);
    expect(opened).toEqual(['checks']);
    expect(ui.doc.activeElement).toBe(ui.byId('RAG_OUTPUT_LINK_ALLOWLIST'));
    ui.setValue('RAG_OUTPUT_LINK_ALLOWLIST', '', 'input');
    expect(text(list)).toContain('No domain is on the allowlist.');
  });

  it('renders the rule-set line with the version and counts per language', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    const line = ui.byId('rag-answer-rules-guard-rules');
    expect(text(line)).toBe('Sign-in request rules: version 2026-01-02.3; zh: 2, en: 3, it: 4');
    expect(line.querySelector('code')!.getAttribute('translate')).toBe('no');
  });

  it('recomputes the What it does now sentence from the guard select', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    const now = ui.byId('rag-answer-rules-guard-now');
    expect(text(now)).toBe('Answers are not checked.');
    ui.setValue('RAG_OUTPUT_GUARD', 'flag');
    expect(text(now)).toContain('recorded as security events');
    ui.setValue('RAG_OUTPUT_GUARD', 'enforce');
    expect(text(now)).toContain('(link removed)');
  });

  it('offers Open security events only when the panel exists on the page', async () => {
    const without = mountPanel();
    await without.init();
    await without.settle();
    expect(without.byId('rag-answer-rules-events-actions').querySelectorAll('button')).toHaveLength(0);
    const ui = mountPanel({ securityEventsHost: true });
    let adminClicks = 0;
    ui.doc.querySelector('[data-tab="rag-administration"]')!.addEventListener('click', () => (adminClicks += 1));
    await ui.init();
    await ui.settle();
    const open = ui.byId('rag-answer-rules-events-actions').querySelectorAll('button').find((b) => text(b) === 'Open security events')!;
    open.click();
    expect(adminClicks).toBe(1);
  });
});

describe('answer-rules.js: loading and failure (UI-SPEC 7.2)', () => {
  it('shows a spinner with data.loading in each read-only block while loading, with the switches usable', async () => {
    const ui = mountPanel({ reply: 'pending' });
    const pending = ui.init();
    await ui.settle();
    for (const id of ['rag-answer-rules-judge-calibration', 'rag-answer-rules-caps', 'rag-answer-rules-allowlist', 'rag-answer-rules-guard-rules']) {
      const host = ui.byId(id);
      expect(host.querySelector('.loading'), id).not.toBeNull();
      expect(text(host), id).toContain('Loading current values…');
    }
    for (const input of ui.doc.querySelectorAll('input, select')) expect(input.disabled).toBe(false);
    ui.release();
    await pending;
    await ui.settle();
    expect(ui.byId('rag-answer-rules-caps').querySelector('.loading')).toBeNull();
  });

  it.each([
    ['a 500 answer', { ok: false, status: 500, body: { error: 'eval/config/output-caps.json could not be read', code: 'answer_rules_caps_missing' } }],
    ['a thrown request', 'throw' as const],
    ['an unexpected shape', { ok: true, status: 200, body: { caps: 'x', extra: 1 } }],
  ])('on %s shows data.unavailable, an em dash per block, and keeps every switch usable', async (_name, reply) => {
    const ui = mountPanel({ reply });
    await ui.init();
    await ui.settle();
    const alerts = ui.byId('rag-answer-rules-alerts');
    expect(text(alerts)).toContain('Current values could not be read from the config server. The switches still work.');
    expect(text(alerts)).not.toContain('output-caps.json');
    for (const id of ['rag-answer-rules-judge-calibration', 'rag-answer-rules-caps', 'rag-answer-rules-guard-rules']) expect(text(ui.byId(id)), id).toBe('—');
    for (const input of ui.doc.querySelectorAll('input, select')) expect(input.disabled).toBe(false);
    ui.toggle('RAG_CLAIM_CHECK', true);
    expect(ui.warnings()).toContain('warn.claimNeedsGroundedness');
    expect(text(alerts)).toContain('Current values could not be read');
  });
});

describe('answer-rules.js: combination warnings (UI-SPEC 6.12, D-58)', () => {
  it('starts with no warning for the defaults', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    expect(ui.warnings()).toEqual([]);
  });

  it('shows each of the nine warnings exactly while its condition holds', async () => {
    const ui = mountPanel({ reply: { ok: true, status: 200, body: summary({ allowlist: [] }) } });
    await ui.init();
    await ui.settle();
    const cases: Array<[string, () => void, () => void]> = [
      ['warn.perSentenceNeedsCitations', () => ui.toggle('RAG_CITATION_PER_SENTENCE', true), () => ui.toggle('RAG_CITATIONS', true)],
      ['warn.claimNeedsGroundedness', () => ui.toggle('RAG_CLAIM_CHECK', true), () => ui.toggle('RAG_GROUNDEDNESS', true)],
      ['warn.judgeNeedsModel', () => ui.toggle('RAG_GROUNDEDNESS_LLM_JUDGE', true), () => ui.setValue('RAG_GROUNDEDNESS_JUDGE_MODEL', 'vendor/model-x', 'input')],
      ['warn.registryNeedsLanguages', () => ui.toggle('RAG_REGISTRY_TEXTS', true), () => ui.setValue('RAG_SUPPORTED_LANGUAGES', 'en')],
      ['warn.capAutoEmpty', () => ui.setValue('RAG_MAX_OUTPUT_TOKENS', 'auto'), () => ui.setValue('RAG_MAX_OUTPUT_TOKENS', 'off')],
      ['warn.guardEmptyAllowlist', () => ui.setValue('RAG_OUTPUT_GUARD', 'enforce'), () => ui.setValue('RAG_OUTPUT_GUARD', 'flag')],
      ['warn.alertNeedsEvents', () => ui.setValue('RAG_UPLOADER_ALERT_THRESHOLD', '3', 'input'), () => ui.toggle('RAG_SECURITY_EVENTS', true)],
      ['warn.holdNeedsApprovalPath', () => ui.setValue('RAG_UPLOADER_HOLD', 'manual'), () => ui.setValue('RAG_INGEST_PIPELINE', 'unified')],
    ];
    for (const [key, on, off] of cases) {
      on();
      expect(ui.warnings(), key).toContain(key);
      off();
      expect(ui.warnings(), key).not.toContain(key);
    }
    ui.setValue('RAG_UPLOADER_HOLD', 'off');
    ui.toggle('RAG_SECURITY_EVENTS', false);
    ui.setValue('RAG_UPLOADER_ALERT_THRESHOLD', '0', 'input');
    ui.setValue('RAG_UPLOADER_HOLD', 'auto');
    expect(ui.warnings()).toEqual(expect.arrayContaining(['warn.alertNeedsEvents']));
  });

  it('uses alert-info for the empty-allowlist information and alert-warning for the others', async () => {
    const ui = mountPanel({ reply: { ok: true, status: 200, body: summary({ allowlist: [] }) } });
    await ui.init();
    await ui.settle();
    ui.setValue('RAG_OUTPUT_GUARD', 'enforce');
    ui.toggle('RAG_CLAIM_CHECK', true);
    const alerts = ui.byId('rag-answer-rules-alerts');
    expect(alerts.querySelector('[data-answer-rules-warning="warn.guardEmptyAllowlist"]')!.className).toContain('alert-info');
    expect(alerts.querySelector('[data-answer-rules-warning="warn.claimNeedsGroundedness"]')!.className).toContain('alert-warning');
  });

  it('shows the same-family warning from the server while the judge model is unchanged', async () => {
    const ui = mountPanel({ reply: { ok: true, status: 200, body: summary({ sameFamily: true }) } });
    ui.byId('RAG_GROUNDEDNESS_JUDGE_MODEL').value = 'vendor/model-a';
    await ui.init();
    await ui.settle();
    expect(ui.warnings()).toContain('warn.judgeSameFamily');
    ui.setValue('RAG_GROUNDEDNESS_JUDGE_MODEL', 'vendor/model-b', 'input');
    expect(ui.warnings()).not.toContain('warn.judgeSameFamily');
  });

  it('shows the empty-cap warning only once the summary says no cell holds a limit', async () => {
    const ui = mountPanel({
      reply: { ok: true, status: 200, body: summary({ caps: [{ mode: 'strict', limit: 600, source: 'sweep' }, { mode: 'balanced', limit: null, source: 'default' }] }) },
    });
    await ui.init();
    await ui.settle();
    ui.setValue('RAG_MAX_OUTPUT_TOKENS', 'auto');
    expect(ui.warnings()).not.toContain('warn.capAutoEmpty');
  });
});

describe('answer-rules.js: answer length floor (UI-SPEC 6.12)', () => {
  it('takes the floor from the summary and marks a fixed limit under it invalid without changing the hidden value', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    const amount = ui.doc.querySelector('[data-answer-cap="value"]') as FakeElement;
    expect(amount.getAttribute('min')).toBe('300');
    const mode = ui.doc.querySelector('[data-answer-cap="mode"]') as FakeElement;
    mode.value = 'fixed';
    amount.value = '280';
    amount.dispatch('change');
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(text(ui.doc.querySelector('[data-answer-cap="value-error"]'))).toBe('Enter 300 or more.');
    expect(ui.byId('RAG_MAX_OUTPUT_TOKENS').value).toBe('off');
  });

  it('marks a stored fixed limit under the floor invalid on load', async () => {
    const ui = mountPanel();
    ui.setValue('RAG_MAX_OUTPUT_TOKENS', '270');
    await ui.init();
    await ui.settle();
    const amount = ui.doc.querySelector('[data-answer-cap="value"]') as FakeElement;
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(ui.byId('RAG_MAX_OUTPUT_TOKENS').value).toBe('270');
  });
});

describe('answer-rules.js: texts in zh and it (UI-SPEC 12.3)', () => {
  const keysInCard = () => [...new Set([...cardMarkup().matchAll(/data-rag-i18n="([^"]+)"/g)].map((m) => m[1]!))];

  it('has an en, zh and it text for every data-rag-i18n key of the card, en equal to the static HTML', async () => {
    const mod = (await import('../../scripts/config-ui/rag-panels/answer-rules.js')) as unknown as {
      ANSWER_RULES_LABELS: Record<'en' | 'zh' | 'it', Record<string, string>>;
    };
    const labels = (mod as unknown as { default?: typeof mod }).default?.ANSWER_RULES_LABELS ?? mod.ANSWER_RULES_LABELS;
    const ui = mountPanel();
    for (const key of keysInCard()) {
      for (const locale of ['en', 'zh', 'it'] as const) expect(typeof labels[locale][key], `${locale} ${key}`).toBe('string');
      const el = ui.doc.querySelector(`[data-rag-i18n="${key}"]`)!;
      expect(labels.en[key], key).toBe(text(el));
    }
  });

  it.each([
    ['zh-CN', '回答规则与输出安全', '由评估选定', '请输入不小于 {n} 的数值。', '正在加载当前值…'],
    ['it-IT', "Regole di risposta e sicurezza dell'output", 'Scelto dalla valutazione', 'Inserisci {n} o più.', 'Caricamento dei valori attuali…'],
  ])('applies the %s texts on mount', async (locale, title, autoOption, template, loading) => {
    const ui = mountPanel({ locale, reply: 'pending' });
    const pending = ui.init();
    await ui.settle();
    expect(text(ui.doc.querySelector('[data-rag-i18n="card.title"]'))).toBe(title);
    expect(text(ui.doc.querySelector('[data-rag-i18n="cap.mode.auto"]'))).toBe(autoOption);
    expect(ui.doc.querySelector('[data-answer-cap="value-error"]')!.getAttribute('data-template')).toBe(template);
    expect(text(ui.byId('rag-answer-rules-caps'))).toContain(loading);
    expect(ui.byId('rag-answer-rules').getAttribute('lang')).toBe(locale.slice(0, 2));
    ui.release();
    await pending;
  });

  it('keeps English for other browser languages', async () => {
    const ui = mountPanel({ locale: 'fr-FR' });
    await ui.init();
    await ui.settle();
    expect(text(ui.doc.querySelector('[data-rag-i18n="card.title"]'))).toBe('Answer rules and output safety');
    expect(ui.byId('rag-answer-rules').getAttribute('lang')).toBe('en');
  });
});

describe('answer-rules.js: mount (UI-SPEC 6.11)', () => {
  it('is idempotent: one request, no duplicate warnings or blocks', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.init();
    await ui.settle();
    expect(ui.calls).toHaveLength(1);
    ui.toggle('RAG_CLAIM_CHECK', true);
    expect(ui.warnings()).toEqual(['warn.claimNeedsGroundedness']);
    expect(ui.byId('rag-answer-rules-caps').querySelectorAll('table')).toHaveLength(1);
  });

  it('retries the request on the next mount after a failure', async () => {
    const ui = mountPanel({ reply: 'throw' });
    await ui.init();
    await ui.settle();
    await ui.init();
    await ui.settle();
    expect(ui.calls).toHaveLength(2);
  });

  it('binds to every RAG Modes tab link', async () => {
    const ui = mountPanel();
    ui.doc.dispatch('DOMContentLoaded');
    const links = ui.doc.querySelectorAll('[data-tab="rag-modes"]');
    expect(links).toHaveLength(2);
    links[1]!.click();
    await ui.settle();
    expect(ui.calls).toHaveLength(1);
    expect(ui.byId('rag-answer-rules-caps').querySelectorAll('table')).toHaveLength(1);
  });

  it('builds the DOM without innerHTML', async () => {
    const ui = mountPanel();
    await ui.init();
    await ui.settle();
    expect(ui.doc.innerHtmlWrites).toBe(0);
  });
});

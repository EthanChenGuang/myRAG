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

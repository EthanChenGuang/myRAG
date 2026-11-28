import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// LANG-11 (plan 07-52): POST /api/config/languages applies the same addition and removal rules as `npm run rag:languages`.

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_REGISTRY = path.join(REPO_ROOT, 'config', 'rag', 'language-packs.json');
const SAVED_ENV = ['# placeholder test env', 'RAG_PIPELINE=legacy', 'RAG_SUPPORTED_LANGUAGES=zh,en', 'RAG_PRIMARY_LANGUAGE=zh', ''].join('\n');

let root;
let server;
let port;
let app;
let counted;

const envPath = () => path.join(root, '.env.local');
const baselineDir = () => path.join(root, 'eval', 'baselines', 'languages');

function recordBaseline(code, language = code) {
  fs.mkdirSync(baselineDir(), { recursive: true });
  fs.writeFileSync(path.join(baselineDir(), `${code}.json`), JSON.stringify({ language, run_config_hash: 'a'.repeat(64), golden_sha256: 'b'.repeat(64) }));
}

function call(method, url, body) {
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Host: `127.0.0.1:${port}`, Origin: origin, 'X-Config-UI': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-languages-change-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config', 'rag'), { recursive: true });
  fs.copyFileSync(SHIPPED_REGISTRY, path.join(root, 'config', 'rag', 'language-packs.json'));
  process.env.MYRAG_CONFIG_ROOT = root;
  const mod = require('../config-server.js');
  server = mod.server;
  app = mod.app;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

beforeEach(() => {
  fs.writeFileSync(envPath(), SAVED_ENV);
  fs.rmSync(path.join(root, 'eval'), { recursive: true, force: true });
  counted = [];
  app.locals.languageAddCounts = async (normalized) => {
    counted.push(normalized.languages.join(','));
    return { groups: { und: 1, scanned: 2, stale: 3 }, total: 6 };
  };
});

after(async () => {
  delete app.locals.languageAddCounts;
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

test('an added language without a baseline answers 400 ending in language_baseline_missing and writes nothing', async () => {
  const res = await call('POST', '/api/config/languages', { languages: ['zh', 'en', 'it'], primary: 'zh' });
  assert.equal(res.status, 400);
  const codes = res.json.details.map((detail) => detail.code);
  assert.equal(codes[codes.length - 1], 'language_baseline_missing');
  assert.deepEqual(res.json.details.at(-1), { code: 'language_baseline_missing', language: 'it', command: 'npm run rag:languages -- baseline it' });
  assert.equal(fs.readFileSync(envPath(), 'utf8'), SAVED_ENV);
  assert.deepEqual(counted, []);
});

test('the baseline code comes after the validator codes, in the validator order', async () => {
  fs.writeFileSync(
    path.join(root, 'config', 'rag', 'embedding-model-languages.json'),
    JSON.stringify({ schema_version: 1, models: [{ provider: 'openai', model: 'text-embedding-3-small', supported_languages: ['zh', 'en'] }] }),
  );
  try {
    const res = await call('POST', '/api/config/languages', { languages: ['zh', 'en', 'it'], primary: 'zh' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json.details.map((detail) => detail.code), ['embedding_profile_unsupported', 'language_baseline_missing']);
  } finally {
    fs.rmSync(path.join(root, 'config', 'rag', 'embedding-model-languages.json'), { force: true });
  }
});

test('an accepted addition answers 200 with the warnings and the language_add selection counts', async () => {
  recordBaseline('it');
  const res = await call('POST', '/api/config/languages', { languages: ['zh', 'en', 'it'], primary: 'zh' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.added, ['it']);
  assert.deepEqual(res.json.removed, []);
  assert.deepEqual(res.json.rebuild, { selection: 'language_add', mechanism: 'reparse' });
  assert.deepEqual(res.json.selection, { groups: { und: 1, scanned: 2, stale: 3 }, total: 6 });
  assert.deepEqual(res.json.warnings, [{ code: 'groundedness_not_checked', language: 'it' }]);
  assert.match(fs.readFileSync(envPath(), 'utf8'), /^RAG_SUPPORTED_LANGUAGES=zh,en,it$/m);
  assert.deepEqual(counted, ['zh,en,it']);
});

test('a preview plans and counts without writing', async () => {
  recordBaseline('it');
  const res = await call('POST', '/api/config/languages', { languages: ['zh', 'en', 'it'], primary: 'zh', preview: true });
  assert.equal(res.status, 200);
  assert.equal(res.json.preview, true);
  assert.deepEqual(res.json.selection, { groups: { und: 1, scanned: 2, stale: 3 }, total: 6 });
  assert.equal(fs.readFileSync(envPath(), 'utf8'), SAVED_ENV);
  const bad = await call('POST', '/api/config/languages', { languages: ['zh'], primary: 'zh', preview: 'yes' });
  assert.equal(bad.status, 400);
});

test('a removal only answers 200 with zero to reprocess, no rebuild and the searchable note', async () => {
  const res = await call('POST', '/api/config/languages', { languages: ['zh'], primary: 'zh' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.removed, ['en']);
  assert.deepEqual(res.json.added, []);
  assert.equal(res.json.rebuild, null);
  assert.equal(res.json.selection, undefined);
  assert.deepEqual(res.json.notes, [{ code: 'removed_documents_stay_searchable', language: 'en' }]);
  assert.deepEqual(counted, []);
});

test('the language list marks a not-enabled language without a baseline, and clears it once the file exists', async () => {
  let res = await call('GET', '/api/config/languages');
  const flag = (code) => res.json.packs.find((pack) => pack.code === code).baselineMissing;
  assert.equal(flag('it'), true);
  assert.equal(flag('zh'), undefined, 'an enabled language is never marked');
  assert.equal(flag('en'), undefined);
  recordBaseline('it', 'en');
  res = await call('GET', '/api/config/languages');
  assert.equal(flag('it'), true, 'a record that names another language is not a baseline');
  recordBaseline('it');
  res = await call('GET', '/api/config/languages');
  assert.equal(flag('it'), undefined);
});

test('the first choice of languages (nothing saved) needs no baseline and answers as in Phase 3.2', async () => {
  fs.writeFileSync(envPath(), 'RAG_SUPPORTED_LANGUAGES=\nRAG_PRIMARY_LANGUAGE=\n');
  const list = await call('GET', '/api/config/languages');
  assert.ok(list.json.packs.every((pack) => pack.baselineMissing === undefined));
  const res = await call('POST', '/api/config/languages', { languages: ['zh', 'it'], primary: 'zh' });
  assert.equal(res.status, 200);
  assert.equal(res.json.added, undefined);
  assert.deepEqual(counted, []);
});

test('an added and a removed language: the addition rules for the added code, the note for the removed one', async () => {
  recordBaseline('it');
  const res = await call('POST', '/api/config/languages', { languages: ['zh', 'it'], primary: 'zh' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.added, ['it']);
  assert.deepEqual(res.json.removed, ['en']);
  assert.deepEqual(res.json.notes, [{ code: 'removed_documents_stay_searchable', language: 'en' }]);
  assert.deepEqual(res.json.selection.total, 6);
});

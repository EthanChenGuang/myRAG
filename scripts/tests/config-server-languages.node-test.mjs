import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_REGISTRY = path.join(REPO_ROOT, 'config', 'rag', 'language-packs.json');

const BASE_ENV = [
  '# placeholder test env',
  'NEXT_PUBLIC_APP_NAME=Demo',
  'RAG_PIPELINE=legacy',
  'RAG_SUPPORTED_LANGUAGES=',
  'RAG_PRIMARY_LANGUAGE=',
  'OPENAI_API_KEY=placeholder-openai',
  '',
].join('\n');

let root;
let server;
let port;

function envPath() {
  return path.join(root, '.env.local');
}

function declarationsPath() {
  return path.join(root, 'config', 'rag', 'embedding-model-languages.json');
}

function call(method, url, { body, ui = true, host } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  const headers = {
    Host: host ?? `127.0.0.1:${port}`,
    ...(ui ? { Origin: origin, 'X-Config-UI': '1' } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };
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
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function linesFor(content, name) {
  return content.split('\n').filter((line) => line.startsWith(`${name}=`));
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-languages-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config', 'rag'), { recursive: true });
  fs.copyFileSync(SHIPPED_REGISTRY, path.join(root, 'config', 'rag', 'language-packs.json'));
  process.env.MYRAG_CONFIG_ROOT = root;
  const mod = require('../config-server.js');
  server = mod.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

beforeEach(() => {
  fs.writeFileSync(envPath(), BASE_ENV);
  fs.rmSync(declarationsPath(), { force: true });
  fs.copyFileSync(SHIPPED_REGISTRY, path.join(root, 'config', 'rag', 'language-packs.json'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

test('GET answers the unconfigured state with every complete pack selectable', async () => {
  const res = await call('GET', '/api/config/languages');
  assert.equal(res.status, 200);
  assert.equal(res.json.configured, false);
  assert.deepEqual(res.json.languages, []);
  assert.equal(res.json.primary, null);
  assert.deepEqual(res.json.pipelines, {
    RAG_PIPELINE: { value: 'legacy', explicit: true },
    RAG_INGEST_PIPELINE: { value: null, explicit: false },
  });
  assert.equal(res.json.verifiedAgainstActiveProfile, false);
  assert.equal(res.json.embeddingProfile, null);
  assert.equal(res.json.reranker, null);
  assert.deepEqual(
    res.json.packs.map((pack) => pack.code),
    ['zh', 'en', 'it'],
  );
  const zh = res.json.packs[0];
  assert.deepEqual(zh, {
    code: 'zh',
    nativeName: '中文',
    englishName: 'Chinese',
    groundedness: 'hhem_2_3',
    selectable: true,
    reasons: [],
  });
});

test('GET reports a saved set, a v2 pipeline set explicitly and the active reranker', async () => {
  fs.writeFileSync(
    envPath(),
    'RAG_PIPELINE=v2\nRAG_RERANKER=local_bm25\nRAG_SUPPORTED_LANGUAGES=en,zh\nRAG_PRIMARY_LANGUAGE=en\n',
  );
  const res = await call('GET', '/api/config/languages');
  assert.equal(res.status, 200);
  assert.equal(res.json.configured, true);
  assert.deepEqual(res.json.languages, ['zh', 'en']);
  assert.equal(res.json.primary, 'en');
  assert.deepEqual(res.json.pipelines.RAG_PIPELINE, { value: 'v2', explicit: true });
  assert.deepEqual(res.json.reranker, { id: 'local_bm25' });
  assert.ok(res.json.packs.every((pack) => pack.selectable));
});

test('GET lists only complete packs', async () => {
  const registry = JSON.parse(fs.readFileSync(SHIPPED_REGISTRY, 'utf8'));
  registry.packs.find((pack) => pack.code === 'it').fixtures.golden_slices = false;
  fs.writeFileSync(path.join(root, 'config', 'rag', 'language-packs.json'), JSON.stringify(registry));
  const res = await call('GET', '/api/config/languages');
  assert.deepEqual(
    res.json.packs.map((pack) => pack.code),
    ['zh', 'en'],
  );
});

test('GET with the embedding declarations file blocks a language the default profile does not declare', async () => {
  fs.writeFileSync(
    declarationsPath(),
    JSON.stringify({
      schema_version: 1,
      models: [{ provider: 'openai', model: 'text-embedding-3-small', supported_languages: ['zh', 'en'] }],
    }),
  );
  const res = await call('GET', '/api/config/languages');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.embeddingProfile, { id: 'openai-3-small-1536' });
  assert.equal(res.json.verifiedAgainstActiveProfile, false);
  const it = res.json.packs.find((pack) => pack.code === 'it');
  assert.equal(it.selectable, false);
  assert.deepEqual(it.reasons, [{ code: 'embedding_profile_unsupported', id: 'openai-3-small-1536' }]);
  assert.equal(res.json.packs.find((pack) => pack.code === 'zh').selectable, true);
});

test('POST refuses primary_not_in_set with 400 and writes nothing', async () => {
  const before = fs.readFileSync(envPath(), 'utf8');
  const res = await call('POST', '/api/config/languages', { body: { languages: ['zh', 'en'], primary: 'it' } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json, {
    success: false,
    error: 'Invalid language settings',
    details: [{ code: 'primary_not_in_set', language: 'it' }],
  });
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
});

test('POST refuses a language the embedding profile does not declare when the file exists', async () => {
  fs.writeFileSync(
    declarationsPath(),
    JSON.stringify({
      schema_version: 1,
      models: [{ provider: 'openai', model: 'text-embedding-3-small', supported_languages: ['zh', 'en'] }],
    }),
  );
  const res = await call('POST', '/api/config/languages', { body: { languages: ['it', 'en'], primary: 'en' } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json.details, [{ code: 'embedding_profile_unsupported', language: 'it', id: 'openai-3-small-1536' }]);
});

test('POST refuses a newline smuggled into a value and writes nothing', async () => {
  const before = fs.readFileSync(envPath(), 'utf8');
  const res = await call('POST', '/api/config/languages', {
    body: { languages: ['en\nOPENAI_API_KEY=placeholder-attack'], primary: 'en' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.details[0].code, 'unknown_language');
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
});

test('POST refuses a body without a language list', async () => {
  const res = await call('POST', '/api/config/languages', { body: { languages: 'zh,en', primary: 'en' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.success, false);
  const malformed = await call('POST', '/api/config/languages', { body: '{"languages":' });
  assert.equal(malformed.status, 400);
});

test('POST saves a valid set in registry order with its warnings', async () => {
  const res = await call('POST', '/api/config/languages', { body: { languages: ['it', 'zh'], primary: 'zh' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    success: true,
    languages: ['zh', 'it'],
    primary: 'zh',
    warnings: [{ code: 'groundedness_not_checked', language: 'it' }],
    verifiedAgainstActiveProfile: false,
  });
  const content = fs.readFileSync(envPath(), 'utf8');
  assert.deepEqual(linesFor(content, 'RAG_SUPPORTED_LANGUAGES'), ['RAG_SUPPORTED_LANGUAGES=zh,it']);
  assert.deepEqual(linesFor(content, 'RAG_PRIMARY_LANGUAGE'), ['RAG_PRIMARY_LANGUAGE=zh']);
  assert.match(content, /^NEXT_PUBLIC_APP_NAME=Demo$/m);
  assert.match(content, /^OPENAI_API_KEY=placeholder-openai$/m);
  assert.match(content, /^# placeholder test env$/m);

  const reread = await call('GET', '/api/config/languages');
  assert.equal(reread.json.configured, true);
  assert.deepEqual(reread.json.languages, ['zh', 'it']);
});

test('POST appends the variables when .env.local lacks them', async () => {
  fs.writeFileSync(envPath(), 'NEXT_PUBLIC_APP_NAME=Demo\n');
  const res = await call('POST', '/api/config/languages', { body: { languages: ['en'], primary: 'en' } });
  assert.equal(res.status, 200);
  assert.equal(
    fs.readFileSync(envPath(), 'utf8'),
    'NEXT_PUBLIC_APP_NAME=Demo\nRAG_SUPPORTED_LANGUAGES=en\nRAG_PRIMARY_LANGUAGE=en\n',
  );
});

test('saving the same valid candidate twice gives the same answer and one line per variable', async () => {
  const body = { languages: ['en', 'zh'], primary: 'en' };
  const first = await call('POST', '/api/config/languages', { body });
  const afterFirst = fs.readFileSync(envPath(), 'utf8');
  const second = await call('POST', '/api/config/languages', { body });
  assert.equal(first.status, 200);
  assert.deepEqual(second.json, first.json);
  const content = fs.readFileSync(envPath(), 'utf8');
  assert.equal(content, afterFirst);
  assert.equal(linesFor(content, 'RAG_SUPPORTED_LANGUAGES').length, 1);
  assert.equal(linesFor(content, 'RAG_PRIMARY_LANGUAGE').length, 1);
});

test('two concurrent saves leave one line per variable and a set and primary from the same request', async () => {
  const [a, b] = await Promise.all([
    call('POST', '/api/config/languages', { body: { languages: ['zh', 'en'], primary: 'zh' } }),
    call('POST', '/api/config/languages', { body: { languages: ['it'], primary: 'it' } }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const content = fs.readFileSync(envPath(), 'utf8');
  const set = linesFor(content, 'RAG_SUPPORTED_LANGUAGES');
  const primary = linesFor(content, 'RAG_PRIMARY_LANGUAGE');
  assert.equal(set.length, 1);
  assert.equal(primary.length, 1);
  const pair = `${set[0]}|${primary[0]}`;
  assert.ok(
    pair === 'RAG_SUPPORTED_LANGUAGES=zh,en|RAG_PRIMARY_LANGUAGE=zh' ||
      pair === 'RAG_SUPPORTED_LANGUAGES=it|RAG_PRIMARY_LANGUAGE=it',
    pair,
  );
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('the routes sit behind the config-server guard', async () => {
  const before = fs.readFileSync(envPath(), 'utf8');
  const crossSite = await call('POST', '/api/config/languages', { body: { languages: ['en'], primary: 'en' }, ui: false });
  assert.equal(crossSite.status, 403);
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
  const rebinding = await call('GET', '/api/config/languages', { host: `attacker.example.test:${port}` });
  assert.equal(rebinding.status, 403);
  const foreignHost = await call('POST', '/api/config/languages', {
    body: { languages: ['en'], primary: 'en' },
    host: `attacker.example.test:${port}`,
  });
  assert.equal(foreignHost.status, 403);
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
});

import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHIPPED_REGISTRY = path.join(REPO_ROOT, 'config', 'rag', 'language-packs.json');
const initEnv = require('../init-env.js');

const roots = [];
let root;

function envPath() {
  return path.join(root, '.env.local');
}

function tty(stream) {
  stream.isTTY = true;
  return stream;
}

/** Fake terminal: the answers are queued on input; everything written to output is collected. */
function terminal(answers, { inputTTY = true, outputTTY = true } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (inputTTY) tty(input);
  if (outputTTY) tty(output);
  let text = '';
  output.on('data', (chunk) => {
    text += chunk.toString('utf8');
  });
  for (const answer of answers) input.write(`${answer}\n`);
  input.end();
  return { input, output, text: () => text };
}

function run(answers, options = {}) {
  const io = terminal(answers, options.io);
  return initEnv
    .runLanguagePicker({
      input: io.input,
      output: io.output,
      env: options.env ?? {},
      root,
      envPath: envPath(),
      fetchImpl: options.fetchImpl ?? (() => Promise.reject(new Error('no network in tests'))),
    })
    .then((result) => ({ result, text: io.text() }));
}

function linesFor(name) {
  return fs.readFileSync(envPath(), 'utf8').split('\n').filter((line) => line.startsWith(`${name}=`));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-init-env-languages-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'config', 'rag'), { recursive: true });
  fs.copyFileSync(SHIPPED_REGISTRY, path.join(root, 'config', 'rag', 'language-packs.json'));
  fs.writeFileSync(envPath(), 'NEXT_PUBLIC_APP_NAME=Demo\nRAG_SUPPORTED_LANGUAGES=\nRAG_PRIMARY_LANGUAGE=\n');
});

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

test('requiring init-env.js creates no file and prompts nothing', () => {
  assert.equal(typeof initEnv.checkAndCreateEnvFile, 'function');
  assert.equal(typeof initEnv.runLanguagePicker, 'function');
  assert.equal(typeof initEnv.shouldPromptForLanguages, 'function');
});

test('no prompt when stdin is not a TTY', async () => {
  const before = fs.readFileSync(envPath(), 'utf8');
  const { result, text } = await run(['1,2', '1'], { io: { inputTTY: false } });
  assert.equal(result.prompted, false);
  assert.equal(text, '');
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
});

test('no prompt when stdout is not a TTY', async () => {
  const { result, text } = await run(['1,2', '1'], { io: { outputTTY: false } });
  assert.equal(result.prompted, false);
  assert.equal(text, '');
});

test('no prompt when CI is set', async () => {
  const { result, text } = await run(['1,2', '1'], { env: { CI: '1' } });
  assert.equal(result.prompted, false);
  assert.equal(text, '');
});

test('no prompt when RAG_SUPPORTED_LANGUAGES has a value in .env.local or the environment', async () => {
  fs.writeFileSync(envPath(), 'RAG_SUPPORTED_LANGUAGES=en\nRAG_PRIMARY_LANGUAGE=en\n');
  const fromFile = await run(['1,2', '1']);
  assert.equal(fromFile.result.prompted, false);
  fs.writeFileSync(envPath(), 'RAG_SUPPORTED_LANGUAGES=\n');
  const fromEnv = await run(['1,2', '1'], { env: { RAG_SUPPORTED_LANGUAGES: 'zh' } });
  assert.equal(fromEnv.result.prompted, false);
  assert.equal(fs.readFileSync(envPath(), 'utf8'), 'RAG_SUPPORTED_LANGUAGES=\n');
});

test('the list shows native name, English name and code of each complete pack', async () => {
  const { text } = await run(['']);
  assert.match(text, /1\) 中文 · Chinese \(zh\)/);
  assert.match(text, /2\) English \(en\)/);
  assert.match(text, /3\) Italiano · Italian \(it\)/);
  assert.match(text, /not verified against the active (embedding )?profile/i);
});

test('only complete packs are listed', async () => {
  const registry = JSON.parse(fs.readFileSync(SHIPPED_REGISTRY, 'utf8'));
  registry.packs.find((pack) => pack.code === 'it').fixtures.corpus = false;
  fs.writeFileSync(path.join(root, 'config', 'rag', 'language-packs.json'), JSON.stringify(registry));
  const { text } = await run(['']);
  assert.doesNotMatch(text, /\(it\)/);
});

test('a multi-select answer and a primary write both variables in registry order', async () => {
  const { result, text } = await run(['3,1', '2']);
  assert.equal(result.prompted, true);
  assert.equal(result.saved, true);
  assert.deepEqual(linesFor('RAG_SUPPORTED_LANGUAGES'), ['RAG_SUPPORTED_LANGUAGES=zh,it']);
  assert.deepEqual(linesFor('RAG_PRIMARY_LANGUAGE'), ['RAG_PRIMARY_LANGUAGE=zh']);
  assert.match(fs.readFileSync(envPath(), 'utf8'), /^NEXT_PUBLIC_APP_NAME=Demo$/m);
  assert.match(text, /groundedness/i);
});

test('codes are accepted as answers', async () => {
  const { result } = await run(['en, zh', 'en']);
  assert.equal(result.saved, true);
  assert.deepEqual(linesFor('RAG_SUPPORTED_LANGUAGES'), ['RAG_SUPPORTED_LANGUAGES=zh,en']);
  assert.deepEqual(linesFor('RAG_PRIMARY_LANGUAGE'), ['RAG_PRIMARY_LANGUAGE=en']);
});

test('an empty answer writes nothing', async () => {
  const before = fs.readFileSync(envPath(), 'utf8');
  const { result } = await run(['']);
  assert.equal(result.prompted, true);
  assert.equal(result.saved, false);
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
});

test('closed input (no answer) writes nothing', async () => {
  const before = fs.readFileSync(envPath(), 'utf8');
  const { result } = await run([]);
  assert.equal(result.saved, false);
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
});

test('with one language chosen the primary question is skipped', async () => {
  const { result, text } = await run(['2']);
  assert.equal(result.saved, true);
  assert.deepEqual(linesFor('RAG_SUPPORTED_LANGUAGES'), ['RAG_SUPPORTED_LANGUAGES=en']);
  assert.deepEqual(linesFor('RAG_PRIMARY_LANGUAGE'), ['RAG_PRIMARY_LANGUAGE=en']);
  assert.doesNotMatch(text, /Primary language/);
});

test('an invalid answer shows the validator error and asks again', async () => {
  const { result, text } = await run(['xx', '1,2', '9', '1,2', '2']);
  assert.equal(result.saved, true);
  assert.match(text, /"xx"/);
  assert.match(text, /primary/i);
  assert.deepEqual(linesFor('RAG_SUPPORTED_LANGUAGES'), ['RAG_SUPPORTED_LANGUAGES=zh,en']);
  assert.deepEqual(linesFor('RAG_PRIMARY_LANGUAGE'), ['RAG_PRIMARY_LANGUAGE=en']);
});

test('after three invalid answers both variables stay unset', async () => {
  const before = fs.readFileSync(envPath(), 'utf8');
  const { result, text } = await run(['xx', 'yy', 'zz', '2']);
  assert.equal(result.saved, false);
  assert.equal(result.attempts, 3);
  assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
  assert.match(text, /unset/);
});

test('a language the default embedding profile does not declare is refused', async () => {
  fs.writeFileSync(
    path.join(root, 'config', 'rag', 'embedding-model-languages.json'),
    JSON.stringify({
      schema_version: 1,
      models: [{ provider: 'openai', model: 'text-embedding-3-small', supported_languages: ['zh', 'en'] }],
    }),
  );
  const { result, text } = await run(['3', '2']);
  assert.equal(result.saved, true);
  assert.match(text, /openai-3-small-1536/);
  assert.deepEqual(linesFor('RAG_SUPPORTED_LANGUAGES'), ['RAG_SUPPORTED_LANGUAGES=en']);
});

test('the reranker from RAG_RERANKER is checked', () => {
  const result = initEnv.validateLanguageChoice(
    { supported: 'zh,en', primary: 'en' },
    { root, env: { RAG_RERANKER: 'cohere' }, rerankerOverrides: { cohere: ['en'] } },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'reranker_unsupported', language: 'zh', id: 'cohere' }]);
  assert.equal(result.verifiedAgainstActiveProfile, false);
});

test('Supabase credentials in .env.local give suggestions from one request', async () => {
  fs.writeFileSync(
    envPath(),
    'NEXT_PUBLIC_SUPABASE_URL=https://project.example.test\nSUPABASE_SERVICE_ROLE_KEY=placeholder-service-role\nRAG_SUPPORTED_LANGUAGES=\n',
  );
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ language: 'zh' }, { language: 'zh' }, { language: 'en' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const { text, result } = await run([''], { fetchImpl });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://project.example.test/rest/v1/documents?'));
  assert.equal(calls[0].init.headers.apikey, 'placeholder-service-role');
  assert.match(text, /\(zh\).*suggested: 2 documents/);
  assert.match(text, /\(en\).*suggested: 1 document\b/);
  assert.doesNotMatch(text, /\(it\).*suggested/);
  assert.doesNotMatch(text, /placeholder-service-role/);
  assert.equal(result.saved, false);
  assert.deepEqual(linesFor('RAG_SUPPORTED_LANGUAGES'), ['RAG_SUPPORTED_LANGUAGES=']);
});

test('without Supabase credentials there is no request and no suggestion', async () => {
  let called = 0;
  const { text } = await run([''], {
    fetchImpl: async () => {
      called += 1;
      return new Response('[]');
    },
    env: { NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.test', SUPABASE_SERVICE_ROLE_KEY: 'placeholder' },
  });
  assert.equal(called, 0);
  assert.doesNotMatch(text, /suggested/);
});

test('a failed suggestion request means no suggestion', async () => {
  fs.writeFileSync(
    envPath(),
    'NEXT_PUBLIC_SUPABASE_URL=https://project.example.test\nSUPABASE_SERVICE_ROLE_KEY=placeholder-service-role\n',
  );
  const { text } = await run([''], { fetchImpl: async () => new Response('denied', { status: 401 }) });
  assert.doesNotMatch(text, /suggested/);
});

for (const [label, extra] of [
  ['CI=1', { CI: '1' }],
  ['piped stdin without CI', { CI: '' }],
]) {
  test(`a non-interactive run of the script (${label}) prompts nothing and leaves .env.local as it is`, () => {
    const before = fs.readFileSync(envPath(), 'utf8');
    const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'init-env.js')], {
      env: { ...process.env, ...extra, MYRAG_CONFIG_ROOT: root },
      input: '1,2\n1\n',
      timeout: 20000,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\.env\.local file found/);
    assert.doesNotMatch(res.stdout, /RAG_SUPPORTED_LANGUAGES/);
    assert.equal(fs.readFileSync(envPath(), 'utf8'), before);
  });
}

test('a non-interactive first run still creates the template and prompts nothing', () => {
  fs.rmSync(envPath());
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'init-env.js')], {
    env: { ...process.env, CI: '1', MYRAG_CONFIG_ROOT: root },
    timeout: 20000,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const created = fs.readFileSync(envPath(), 'utf8');
  assert.deepEqual(created.split('\n').filter((line) => line.startsWith('RAG_SUPPORTED_LANGUAGES=')), ['RAG_SUPPORTED_LANGUAGES=']);
  assert.doesNotMatch(res.stdout, /Languages \(numbers/);
});

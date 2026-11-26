import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SECRET = 'placeholder-sidecar-secret-0000000000000000';
const BASE_ENV = ['# placeholder test env', 'NEXT_PUBLIC_APP_NAME=Demo', 'OPENAI_API_KEY=placeholder-openai', 'RAG_HIDDEN_TEXT_CHECK=off', 'RAG_SIDECAR_URL=', 'RAG_SIDECAR_SECRET=', ''].join('\n');

let root;
let server;
let port;

const envPath = () => path.join(root, '.env.local');
const saved = () => fs.readFileSync(envPath(), 'utf8');
const valueOf = (name) => saved().split('\n').find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);

function post(config) {
  const origin = `http://127.0.0.1:${port}`;
  const body = JSON.stringify({ config });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/config',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'X-Config-UI': '1', 'Content-Type': 'application/json' },
      },
      (res) => {
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
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-hidden-text-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  process.env.MYRAG_CONFIG_ROOT = root;
  server = require('../config-server.js').server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

beforeEach(() => {
  fs.writeFileSync(envPath(), BASE_ENV);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

test('quarantine without a sidecar URL or secret is refused and nothing is written, other keys included', async () => {
  for (const sidecar of [{}, { RAG_SIDECAR_URL: 'http://sidecar.example.invalid:8080' }, { RAG_SIDECAR_SECRET: SECRET }]) {
    const before = saved();
    const res = await post({ NEXT_PUBLIC_APP_NAME: 'Changed', RAG_HIDDEN_TEXT_CHECK: 'quarantine', ...sidecar });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { success: false, error: 'hidden_text_needs_sidecar' });
    assert.equal(saved(), before, 'the file is unchanged');
  }
});

test('quarantine with a URL and secret in the request is saved', async () => {
  const res = await post({ RAG_HIDDEN_TEXT_CHECK: 'quarantine', RAG_SIDECAR_URL: 'http://sidecar.example.invalid:8080', RAG_SIDECAR_SECRET: SECRET, NEXT_PUBLIC_APP_NAME: 'Changed' });
  assert.equal(res.status, 200);
  assert.equal(valueOf('RAG_HIDDEN_TEXT_CHECK'), 'quarantine');
  assert.equal(valueOf('NEXT_PUBLIC_APP_NAME'), 'Changed');
});

test('quarantine is saved when .env.local already holds the URL and the secret (an empty posted secret means unchanged)', async () => {
  fs.writeFileSync(envPath(), BASE_ENV.replace('RAG_SIDECAR_URL=', 'RAG_SIDECAR_URL=http://sidecar.example.invalid:8080').replace('RAG_SIDECAR_SECRET=', `RAG_SIDECAR_SECRET=${SECRET}`));
  const res = await post({ RAG_HIDDEN_TEXT_CHECK: 'quarantine', RAG_SIDECAR_SECRET: '', NEXT_PUBLIC_APP_NAME: 'Demo' });
  assert.equal(res.status, 200);
  assert.equal(valueOf('RAG_HIDDEN_TEXT_CHECK'), 'quarantine');
  assert.equal(valueOf('RAG_SIDECAR_SECRET'), SECRET);
});

test('clearing the sidecar URL while quarantine is saved is refused', async () => {
  fs.writeFileSync(envPath(), BASE_ENV.replace('RAG_HIDDEN_TEXT_CHECK=off', 'RAG_HIDDEN_TEXT_CHECK=quarantine').replace('RAG_SIDECAR_URL=', 'RAG_SIDECAR_URL=http://sidecar.example.invalid:8080').replace('RAG_SIDECAR_SECRET=', `RAG_SIDECAR_SECRET=${SECRET}`));
  const res = await post({ RAG_SIDECAR_URL: '', NEXT_PUBLIC_APP_NAME: 'Demo' });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'hidden_text_needs_sidecar');
  assert.equal(valueOf('RAG_SIDECAR_URL'), 'http://sidecar.example.invalid:8080');
});

test('flag and off save without a sidecar', async () => {
  for (const mode of ['flag', 'off']) {
    const res = await post({ RAG_HIDDEN_TEXT_CHECK: mode, NEXT_PUBLIC_APP_NAME: 'Demo' });
    assert.equal(res.status, 200, mode);
    assert.equal(valueOf('RAG_HIDDEN_TEXT_CHECK'), mode);
  }
});

test('a save that touches neither the mode nor the sidecar is not checked', async () => {
  fs.writeFileSync(envPath(), BASE_ENV.replace('RAG_HIDDEN_TEXT_CHECK=off', 'RAG_HIDDEN_TEXT_CHECK=quarantine'));
  const res = await post({ NEXT_PUBLIC_APP_NAME: 'Changed' });
  assert.equal(res.status, 200);
  assert.equal(valueOf('NEXT_PUBLIC_APP_NAME'), 'Changed');
});

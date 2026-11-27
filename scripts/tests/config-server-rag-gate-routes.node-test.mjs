import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const security = require('../config-server-security.js');
const { registerRagGateRoutes } = require('../config-server-rag-gate.js');

const ID = '11111111-2222-4333-8444-555555555555';
const HASH = 'a'.repeat(64);

function checkObject(extra = {}) {
  return {
    check_id: ID,
    status: 'done',
    stage: null,
    started_at: '2026-11-27T10:00:00.000Z',
    finished_at: '2026-11-27T10:01:00.000Z',
    mode: 'enforce',
    cached: false,
    changed_keys: ['RAG_PRE_CONTEXT'],
    result: 'fail',
    error_reason: null,
    layers: [
      { layer: 'deterministic', result: 'fail', reason: null, set_hash: null, checks: [] },
      { layer: 'live', result: 'skipped', reason: 'switched_off', set_hash: null, checks: [] },
      { layer: 'real_set', result: 'skipped', reason: 'no_real_set', set_hash: null, checks: [] },
    ],
    rag_settings_hash: HASH,
    not_evaluated: [],
    not_evaluated_on_real_set: [],
    uncalibrated_cells: [],
    ...extra,
  };
}

function fakeRunner(overrides = {}) {
  const calls = [];
  return {
    calls,
    async start(input) {
      calls.push(input);
      return overrides.start ? overrides.start(input) : { status: 202, body: { check_id: ID } };
    },
    get(id) {
      return overrides.get ? overrides.get(id) : id === ID ? checkObject() : null;
    },
    latest() {
      return overrides.latest ? overrides.latest() : null;
    },
  };
}

const servers = [];
after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

async function mount(runner) {
  const app = express();
  app.use(security.securityMiddleware);
  app.use(express.json());
  registerRagGateRoutes(app, runner);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  return {
    base,
    post: (body, headers = {}) =>
      fetch(`${base}/api/config/rag-gate/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, 'x-config-ui': '1', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    get: (suffix) => fetch(`${base}/api/config/rag-gate/check/${suffix}`),
  };
}

test('POST without the x-config-ui header is refused by the middleware', async () => {
  const runner = fakeRunner();
  const app = await mount(runner);
  const res = await fetch(`${app.base}/api/config/rag-gate/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.base },
    body: JSON.stringify({ kind: 'prompt', prompt: { preContext: 'x' } }),
  });
  assert.equal(res.status, 403);
  assert.equal(runner.calls.length, 0);
});

test('POST from another origin is refused', async () => {
  const runner = fakeRunner();
  const app = await mount(runner);
  const res = await app.post({ kind: 'prompt', prompt: { preContext: 'x' } }, { origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(runner.calls.length, 0);
});

test('a valid body answers the runner status and body', async () => {
  const runner = fakeRunner();
  const app = await mount(runner);
  const res = await app.post({ kind: 'prompt', prompt: { preContext: 'Synthetic text', postContext: 'more' }, force: true });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { check_id: ID });
  assert.deepEqual(runner.calls[0], { kind: 'prompt', prompt: { preContext: 'Synthetic text', postContext: 'more' }, force: true });
});

test('required false, cached and busy answers pass through', async () => {
  for (const answer of [
    { status: 200, body: { required: false } },
    { status: 200, body: { ...checkObject(), cached: true } },
    { status: 409, body: { error: 'rag_gate_busy', running_since: '2026-11-27T10:00:00.000Z' } },
  ]) {
    const app = await mount(fakeRunner({ start: () => answer }));
    const res = await app.post({ kind: 'config', config: { RAG_PRE_CONTEXT: 'x' } });
    assert.equal(res.status, answer.status);
    assert.deepEqual(await res.json(), answer.body);
  }
});

test('malformed bodies answer 400 without starting a check', async () => {
  const runner = fakeRunner();
  const app = await mount(runner);
  const bodies = [
    {},
    { kind: 'other', config: {} },
    { kind: 'config' },
    { kind: 'config', config: [] },
    { kind: 'config', config: {}, extra: 1 },
    { kind: 'prompt', prompt: 'text' },
    { kind: 'prompt', prompt: { preContext: 1 } },
    { kind: 'prompt', prompt: { preContext: 'x', postContext: 2 } },
    { kind: 'models', models: { provider: 1 } },
    { kind: 'models', models: { provider: 'openrouter', openrouterModels: 'x' } },
    { kind: 'prompt', prompt: { preContext: 'x' }, force: 'yes' },
    { kind: 'config', config: {}, prompt: { preContext: 'x' } },
  ];
  for (const body of bodies) {
    const res = await app.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, 'invalid_body');
  }
  assert.equal(runner.calls.length, 0);
});

test('a runner failure answers 500 without detail', async () => {
  const app = await mount(
    fakeRunner({
      start: () => {
        throw new Error('placeholder internal detail');
      },
    }),
  );
  const res = await app.post({ kind: 'config', config: {} });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'rag_gate_failed');
  assert.ok(!JSON.stringify(body).includes('placeholder internal detail'));
});

test('GET latest is matched before :id; 404 when none is held; saved_as is present', async () => {
  const empty = await mount(fakeRunner());
  const none = await empty.get('latest');
  assert.equal(none.status, 404);
  const held = await mount(fakeRunner({ latest: () => checkObject() }));
  const res = await held.get('latest');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.check_id, ID);
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'saved_as'));
  assert.equal(body.saved_as, null);
});

test('GET :id returns the check object and 404 for unknown or malformed ids', async () => {
  const app = await mount(fakeRunner());
  const res = await app.get(ID);
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const key of ['status', 'stage', 'started_at', 'finished_at', 'mode', 'cached', 'changed_keys', 'result', 'error_reason', 'layers', 'not_evaluated_on_real_set', 'not_evaluated', 'uncalibrated_cells']) {
    assert.ok(Object.prototype.hasOwnProperty.call(body, key), key);
  }
  assert.equal((await app.get('99999999-2222-4333-8444-555555555555')).status, 404);
  assert.equal((await app.get('not-a-uuid')).status, 404);
});

test('responses drop fields outside the check object', async () => {
  const app = await mount(fakeRunner({ get: () => checkObject({ overlay_values: { RAG_PRE_CONTEXT: 'leak' } }) }));
  const body = await (await app.get(ID)).json();
  assert.equal(body.overlay_values, undefined);
});

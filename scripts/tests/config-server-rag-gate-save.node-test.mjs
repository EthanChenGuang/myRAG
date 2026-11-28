import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
const gateCore = require('../../src/lib/rag/config-gate/gate-core.cjs');
const { ragSettingsHash } = require('../../src/lib/rag/config-gate/settings-hash.cjs');
const ragGateModule = require('../config-server-rag-gate.js');
const RAG_NAMES = require('../../src/lib/rag/config-gate/rag-affecting.generated.json').names;

const PRE_BEFORE = 'Answer only from the supplied documents. If they do not contain the answer, say that it is not available.';
const PRE_AFTER = 'Answer the question using the supplied documents as helpful background material.';
const REASON = 'reviewed the synthetic prompt change by hand';

function baseEnv(mode) {
  return [
    '# placeholder test env',
    'NEXT_PUBLIC_APP_NAME=Demo',
    `RAG_CONFIG_GATE=${mode}`,
    'RAG_PIPELINE=legacy',
    `RAG_PRE_CONTEXT=${PRE_BEFORE}`,
    'RAG_MONITOR_WEBHOOK_URL=https://hooks.example.invalid/placeholder',
    'NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.invalid',
    'SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role',
    '',
  ].join('\n');
}

let root;
let server;
let port;
let app;
let clientCalls;
let insertedRows;
let insertMode;

function envPath() {
  return path.join(root, '.env.local');
}

function readEnv() {
  return fs.readFileSync(envPath(), 'utf8');
}

function fakeMakeClient() {
  clientCalls += 1;
  return {
    from(table) {
      assert.equal(table, 'rag_config_change_records');
      return {
        insert(row) {
          return {
            select() {
              return {
                async single() {
                  if (insertMode === 'fail') return { data: null, error: { message: 'insert failed' } };
                  insertedRows.push(row);
                  return { data: { id: crypto.randomUUID() }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

function call(method, url, body, targetPort = port) {
  const origin = `http://127.0.0.1:${targetPort}`;
  const headers = {
    Host: `127.0.0.1:${targetPort}`,
    Origin: origin,
    'X-Config-UI': '1',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: targetPort, method, path: url, headers }, (res) => {
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
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function storeCheck(values, result) {
  const id = crypto.randomUUID();
  const layerResult = result === 'pass' ? 'pass' : 'fail';
  const check = {
    check_id: id,
    status: 'done',
    stage: null,
    started_at: new Date(Date.now() - 60000).toISOString(),
    finished_at: new Date().toISOString(),
    mode: 'enforce',
    cached: false,
    changed_keys: ['RAG_PRE_CONTEXT'],
    result,
    error_reason: null,
    layers: [
      {
        layer: 'deterministic',
        result: layerResult,
        reason: null,
        set_hash: null,
        checks: [{ check: 'false_answer_rate', slice: 'overall', result: result === 'pass' ? 'passed' : 'failed' }],
      },
      { layer: 'live', result: 'skipped', reason: 'switched_off', set_hash: null, checks: [] },
      { layer: 'real_set', result: 'skipped', reason: 'no_real_set', set_hash: null, checks: [] },
    ],
    rag_settings_hash: ragSettingsHash(values, RAG_NAMES),
    not_evaluated: [],
    not_evaluated_on_real_set: [],
    uncalibrated_cells: [],
  };
  assert.equal(gateCore.writeCheck(root, check).ok, true);
  return id;
}

function proposed(overrides) {
  return { ...dotenv.parse(readEnv()), ...overrides };
}

function saveBody(extra = {}) {
  return { NEXT_PUBLIC_APP_NAME: 'Demo', RAG_PRE_CONTEXT: PRE_AFTER, ...extra };
}

const quiet = { log: console.log, warn: console.warn, error: console.error };

before(async () => {
  // The config server logs every save at length; silenced here so the node:test channel stays readable.
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-gate-save-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config', 'rag'), { recursive: true });
  fs.copyFileSync(
    path.join(path.dirname(require.resolve('../config-server.js')), '..', 'config', 'rag', 'language-packs.json'),
    path.join(root, 'config', 'rag', 'language-packs.json'),
  );
  process.env.MYRAG_CONFIG_ROOT = root;
  delete process.env.RAG_CONFIG_GATE;
  const mod = require('../config-server.js');
  app = mod.app;
  server = mod.server;
  app.locals.ragGateMakeClient = fakeMakeClient;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

beforeEach(() => {
  clientCalls = 0;
  insertedRows = [];
  insertMode = 'ok';
  fs.rmSync(path.join(root, 'eval'), { recursive: true, force: true });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.MYRAG_CONFIG_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  Object.assign(console, quiet);
});

describe('POST /api/config', () => {
  test('mode off reads no check, creates no client and writes the same file as a pass-through guard', async () => {
    const originalRead = gateCore.readCheck;
    let reads = 0;
    gateCore.readCheck = (...args) => {
      reads += 1;
      return originalRead(...args);
    };
    try {
      fs.writeFileSync(envPath(), baseEnv('off'));
      const res = await call('POST', '/api/config', saveBody({ ragGate: { check_id: crypto.randomUUID() } }));
      assert.equal(res.status, 200);
      assert.equal(res.json.ragGate, undefined);
      const guarded = readEnv();

      const realGuard = ragGateModule.guardEnvWrite;
      ragGateModule.guardEnvWrite = async () => ({ ok: true, ragGate: null });
      try {
        fs.writeFileSync(envPath(), baseEnv('off'));
        const stub = await call('POST', '/api/config', saveBody({ ragGate: { check_id: crypto.randomUUID() } }));
        assert.equal(stub.status, 200);
      } finally {
        ragGateModule.guardEnvWrite = realGuard;
      }
      assert.equal(guarded, readEnv());
      assert.equal(reads, 0);
      assert.equal(clientCalls, 0);
      assert.ok(!guarded.includes('ragGate'), 'the control field is never written as an env line');
    } finally {
      gateCore.readCheck = originalRead;
    }
  });

  test('enforce without ragGate answers 409 rag_gate_required and leaves the file unchanged', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', saveBody());
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'rag_gate_required');
    assert.equal(readEnv(), baseEnv('enforce'));
    assert.equal(insertedRows.length, 0);
  });

  test('enforce with a check_id that is not in the store answers 409 instead of throwing', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', saveBody({ ragGate: { check_id: crypto.randomUUID() } }));
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'rag_gate_required');
    assert.equal(readEnv(), baseEnv('enforce'));
  });

  test('enforce with a passed check of the same hash writes and records gate_result pass', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const checkId = storeCheck(proposed({ RAG_PRE_CONTEXT: PRE_AFTER }), 'pass');
    const res = await call('POST', '/api/config', saveBody({ ragGate: { check_id: checkId } }));
    assert.equal(res.status, 200);
    assert.equal(res.json.ragGate.gate_result, 'pass');
    assert.match(res.json.ragGate.record_id, /^[0-9a-f-]{36}$/);
    assert.equal(dotenv.parse(readEnv()).RAG_PRE_CONTEXT, PRE_AFTER);
    assert.equal(insertedRows.length, 1);
    const row = insertedRows[0];
    assert.equal(row.actor, 'local-config-ui');
    assert.equal(row.source, 'config_ui');
    assert.deepEqual(row.changed_keys, ['RAG_PRE_CONTEXT']);
    assert.equal(row.gate_result, 'pass');
    assert.notEqual(row.before_hash, row.after_hash);
    assert.equal(row.override_reason, null);
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes(PRE_AFTER) && !serialized.includes(PRE_BEFORE), 'the record holds no prompt text');
    assert.ok(!JSON.stringify(res.json).includes(PRE_AFTER), 'the response holds no prompt text');
  });

  test('enforce with a passed check of another hash answers 409 (stale check)', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const checkId = storeCheck(proposed({ RAG_PRE_CONTEXT: `${PRE_AFTER} Extra.` }), 'pass');
    const res = await call('POST', '/api/config', saveBody({ ragGate: { check_id: checkId } }));
    assert.equal(res.status, 409);
    assert.equal(readEnv(), baseEnv('enforce'));
  });

  test('enforce override with a reason and a failed check writes and records the reason', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const checkId = storeCheck(proposed({ RAG_PRE_CONTEXT: PRE_AFTER }), 'fail');
    const res = await call('POST', '/api/config', saveBody({ ragGate: { check_id: checkId, override: { reason: REASON } } }));
    assert.equal(res.status, 200);
    assert.equal(res.json.ragGate.gate_result, 'fail');
    assert.equal(insertedRows.length, 1);
    assert.equal(insertedRows[0].override_reason, REASON);
    assert.equal(insertedRows[0].gate_result, 'fail');
    assert.deepEqual(insertedRows[0].gate_summary.offenders, ['false_answer_rate']);
    assert.equal(dotenv.parse(readEnv()).RAG_PRE_CONTEXT, PRE_AFTER);
  });

  test('enforce override with a reason of 9 characters answers 400 invalid_reason and writes nothing', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', saveBody({ ragGate: { override: { reason: 'too short' } } }));
    assert.equal('too short'.length, 9);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_reason');
    assert.equal(readEnv(), baseEnv('enforce'));
  });

  test('enforce override whose record cannot be written answers 503 rag_gate_record_failed and writes nothing', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    insertMode = 'fail';
    const res = await call('POST', '/api/config', saveBody({ ragGate: { override: { reason: REASON } } }));
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'rag_gate_record_failed');
    assert.equal(readEnv(), baseEnv('enforce'));
  });

  test('W-1: lowering RAG_CONFIG_GATE in enforce answers 409 rag_gate_override_required without a reason, even with a passed check', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', { NEXT_PUBLIC_APP_NAME: 'Demo', RAG_CONFIG_GATE: 'off' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'rag_gate_override_required');
    assert.equal(readEnv(), baseEnv('enforce'));
    const checkId = storeCheck(proposed({ RAG_CONFIG_GATE: 'off' }), 'pass');
    const checked = await call('POST', '/api/config', { NEXT_PUBLIC_APP_NAME: 'Demo', RAG_CONFIG_GATE: 'off', ragGate: { check_id: checkId } });
    assert.equal(checked.status, 409);
    assert.equal(checked.json.error, 'rag_gate_override_required');
    assert.equal(readEnv(), baseEnv('enforce'));
    assert.equal(insertedRows.length, 0);
  });

  test('W-1: lowering RAG_CONFIG_GATE with a typed reason writes it and records the reason', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', { NEXT_PUBLIC_APP_NAME: 'Demo', RAG_CONFIG_GATE: 'warn', ragGate: { override: { reason: REASON } } });
    assert.equal(res.status, 200);
    assert.equal(dotenv.parse(readEnv()).RAG_CONFIG_GATE, 'warn');
    assert.equal(insertedRows.length, 1);
    assert.deepEqual(insertedRows[0].changed_keys, ['RAG_CONFIG_GATE']);
    assert.equal(insertedRows[0].override_reason, REASON);
  });

  test('enforce with a malformed ragGate answers 400 and writes nothing', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', saveBody({ ragGate: { check_id: 7 } }));
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_rag_gate');
    assert.equal(readEnv(), baseEnv('enforce'));
  });

  test('warn with skipped writes and records gate_result skipped; a failed insert only logs', async () => {
    fs.writeFileSync(envPath(), baseEnv('warn'));
    const res = await call('POST', '/api/config', saveBody({ ragGate: { skipped: true } }));
    assert.equal(res.status, 200);
    assert.equal(res.json.ragGate.gate_result, 'skipped');
    assert.equal(insertedRows[0].gate_result, 'skipped');

    fs.writeFileSync(envPath(), baseEnv('warn'));
    insertMode = 'fail';
    const failed = await call('POST', '/api/config', saveBody({ ragGate: { skipped: true } }));
    assert.equal(failed.status, 200);
    assert.equal(failed.json.ragGate, undefined);
    assert.equal(dotenv.parse(readEnv()).RAG_PRE_CONTEXT, PRE_AFTER);
  });

  test('a change of no RAG-affecting name is written without a check in enforce', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', { NEXT_PUBLIC_APP_NAME: 'Renamed' });
    assert.equal(res.status, 200);
    assert.equal(res.json.ragGate, undefined);
    assert.equal(dotenv.parse(readEnv()).NEXT_PUBLIC_APP_NAME, 'Renamed');
    assert.equal(clientCalls, 0);
  });

  test('the gate mode set in the process applies even when the file says off', async () => {
    fs.writeFileSync(envPath(), baseEnv('off'));
    process.env.RAG_CONFIG_GATE = 'enforce';
    try {
      const res = await call('POST', '/api/config', saveBody());
      assert.equal(res.status, 409);
      assert.equal(readEnv(), baseEnv('off'));
    } finally {
      delete process.env.RAG_CONFIG_GATE;
    }
  });

  test('clear empties RAG_MONITOR_WEBHOOK_URL only; any other name answers 400', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config', { clear: ['RAG_MONITOR_WEBHOOK_URL'] });
    assert.equal(res.status, 200);
    const values = dotenv.parse(readEnv());
    assert.equal(values.RAG_MONITOR_WEBHOOK_URL, '');
    assert.equal(values.RAG_PRE_CONTEXT, PRE_BEFORE);
    assert.equal(values.NEXT_PUBLIC_APP_NAME, 'Demo');
    assert.ok(!readEnv().includes('clear='), 'the control field is never written as an env line');

    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const refused = await call('POST', '/api/config', { clear: ['RAG_PRE_CONTEXT'] });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'invalid_clear');
    assert.equal(readEnv(), baseEnv('enforce'));
  });
});

describe('POST /api/config/create', () => {
  test('force over an existing file with a RAG-affecting difference answers 409 in enforce and writes nothing', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config/create', { template: 'minimal', force: true });
    assert.equal(res.status, 409);
    // W-1: the template has no RAG_CONFIG_GATE, so overwriting an enforcing file lowers the gate and needs a typed reason.
    assert.equal(res.json.error, 'rag_gate_override_required');
    assert.equal(readEnv(), baseEnv('enforce'));
  });

  test('force with a typed reason overwrites and records the override', async () => {
    fs.writeFileSync(envPath(), baseEnv('enforce'));
    const res = await call('POST', '/api/config/create', { template: 'minimal', force: true, ragGate: { override: { reason: REASON } } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ragGate.gate_result, 'skipped');
    assert.equal(insertedRows[0].override_reason, REASON);
    assert.notEqual(readEnv(), baseEnv('enforce'));
  });

  test('force in mode off overwrites without a record', async () => {
    fs.writeFileSync(envPath(), baseEnv('off'));
    const res = await call('POST', '/api/config/create', { template: 'minimal', force: true });
    assert.equal(res.status, 200);
    assert.equal(clientCalls, 0);
  });
});

describe('POST /api/config/languages', () => {
  test('a language change answers 409 in enforce without ragGate and writes nothing', async () => {
    fs.writeFileSync(envPath(), `${baseEnv('enforce')}RAG_SUPPORTED_LANGUAGES=en\nRAG_PRIMARY_LANGUAGE=en\n`);
    const beforeText = readEnv();
    const res = await call('POST', '/api/config/languages', { languages: ['en', 'it'], primary: 'en' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'rag_gate_required');
    assert.equal(readEnv(), beforeText);
  });
});

describe('guardEnvWrite', () => {
  test('an unreadable RAG-affecting list answers 409 in enforce and writes in warn', async () => {
    const input = {
      before: { RAG_PRE_CONTEXT: PRE_BEFORE },
      after: { RAG_PRE_CONTEXT: PRE_AFTER },
      repoRoot: root,
      processEnv: {},
      makeClient: fakeMakeClient,
      log: () => {},
      loadNames: () => {
        throw new Error('missing');
      },
    };
    const enforced = await ragGateModule.guardEnvWrite({ ...input, mode: 'enforce' });
    assert.equal(enforced.ok, false);
    assert.equal(enforced.status, 409);
    assert.equal(enforced.body.error, 'rag_gate_required');
    const warned = await ragGateModule.guardEnvWrite({ ...input, mode: 'warn' });
    assert.deepEqual(warned, { ok: true, ragGate: null });
  });

  test('clearableNames is exactly RAG_MONITOR_WEBHOOK_URL', () => {
    assert.deepEqual([...ragGateModule.clearableNames], ['RAG_MONITOR_WEBHOOK_URL']);
  });
});

describe('proxies', () => {
  let stub;
  let stubPort;
  let received;
  let reply;

  before(async () => {
    stub = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubPort = stub.address().port;
    process.env.MYRAG_APP_URL = `http://127.0.0.1:${stubPort}`;
  });

  after(async () => {
    delete process.env.MYRAG_APP_URL;
    await new Promise((resolve) => stub.close(resolve));
  });

  beforeEach(() => {
    received = [];
  });

  for (const route of ['/api/config/rag-prompt', '/api/config/models']) {
    const body =
      route === '/api/config/rag-prompt'
        ? { preContext: PRE_AFTER, postContext: '', ragGate: { override: { reason: REASON } } }
        : { provider: 'openrouter', openrouterModels: [], ragGate: { check_id: '11111111-2222-4333-8444-555555555555' } };

    test(`${route} forwards ragGate and passes 409 and 503 through unchanged`, async () => {
      for (const [status, payload] of [
        [409, { success: false, error: 'rag_gate_required', message: 'placeholder message' }],
        [503, { success: false, error: 'rag_gate_record_failed' }],
      ]) {
        reply = { status, body: payload };
        const res = await call('POST', route, body);
        assert.equal(res.status, status);
        assert.deepEqual(res.json, payload);
      }
      assert.equal(received.length, 2);
      assert.deepEqual(received[0].body.ragGate, body.ragGate);
    });
  }

  test('/api/config/rag-prompt passes the ragGate of a success through', async () => {
    reply = { status: 200, body: { success: true, assembledPrompt: 'x', ragGate: { record_id: 'r', gate_result: 'pass' } } };
    const res = await call('POST', '/api/config/rag-prompt', { preContext: PRE_AFTER });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.ragGate, { record_id: 'r', gate_result: 'pass' });
    assert.equal(received[0].body.ragGate, undefined);
  });
});

describe('unguarded writers', () => {
  test('POST /api/admin/setup writes only ADMIN_EMAIL and ADMIN_PASSWORD, which are not RAG-affecting', () => {
    assert.ok(!RAG_NAMES.includes('ADMIN_EMAIL'));
    assert.ok(!RAG_NAMES.includes('ADMIN_PASSWORD'));
    assert.ok(!RAG_NAMES.includes('RAG_MONITOR_WEBHOOK_URL'));
  });
});

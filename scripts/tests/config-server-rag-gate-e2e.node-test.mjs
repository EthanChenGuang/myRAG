import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Phase 5.3 success criterion 2 (D-13, D-15, D-16): a prompt without the refusal directive fails its real check, run with the
// real child process, and the config server refuses to save it in enforce mode. Runs with the phase gates (plan 05.3-48), not in
// pr-smoke. Never reads or writes the repository's .env.local; check files land only under the ignored eval/out/config-gate/.

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OVERLAY_FILE = path.join(REPO_ROOT, 'eval', 'fixtures', 'controls', 'no-refusal-directive.overlay.json');
const MEASUREMENT_FILE = path.join(REPO_ROOT, 'eval', 'reports', 'phase-05.3', 'absolute-gate-measurement.json');
const dotenv = require('dotenv');
const gateCore = require('../../src/lib/rag/config-gate/gate-core.cjs');
const { CHECK_TIMEOUT_MS, createRagGateRunner } = require('../config-server-rag-gate.js');

const CURRENT_PRE = 'Answer only from the supplied documents. If the documents do not contain the answer, say that the information is not available.';
const CURRENT_POST = 'Cite the documents you used.';
const REASON = 'accepted the failing control prompt for this synthetic test run';
const POLL_MS = 500;
// The value files createRagGateRunner writes into the run directory and must delete afterwards.
const VALUE_FILES = ['overlay.json', 'current-env.json', 'proposed-env.json', 'live-golden.jsonl', 'live-overlay.json', 'real-set-run-config.json'];

function onPath(command) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, command)));
}

function currentValues() {
  return { RAG_CONFIG_GATE: 'enforce', RAG_PRE_CONTEXT: CURRENT_PRE, RAG_POST_CONTEXT: CURRENT_POST, NEXT_PUBLIC_APP_NAME: 'Demo' };
}

function envText(values) {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function call(port, body) {
  const origin = `http://127.0.0.1:${port}`;
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
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('no-refusal-directive control prompt through the real check and the config-server save', { timeout: CHECK_TIMEOUT_MS + 120000 }, () => {
  let control;
  let check;
  let checkFile;
  let wallMs;
  let tempRoot;
  let server;
  let port;
  let app;
  const rows = [];
  const quiet = { log: console.log, warn: console.warn, error: console.error };

  before(() => {
    assert.ok(fs.existsSync(OVERLAY_FILE), 'eval/fixtures/controls/no-refusal-directive.overlay.json is missing (plan 05.3-16)');
    const measurement = JSON.parse(fs.readFileSync(MEASUREMENT_FILE, 'utf8'));
    assert.ok(Array.isArray(measurement.tiers) && measurement.tiers.length > 0, 'the measurement record has no tiers (plan 05.3-15)');
    assert.ok(onPath('uv'), 'uv is not on PATH; the deterministic layer needs it');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'tsx')), 'node_modules/tsx is missing; run npm ci');
    control = JSON.parse(fs.readFileSync(OVERLAY_FILE, 'utf8')).env;
    assert.equal(typeof control.RAG_PRE_CONTEXT, 'string');
  });

  after(async () => {
    Object.assign(console, quiet);
    if (server) await new Promise((resolve) => server.close(resolve));
    delete process.env.MYRAG_CONFIG_ROOT;
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    if (check) fs.rmSync(path.join(REPO_ROOT, gateCore.CHECK_DIR, check.check_id), { recursive: true, force: true });
    if (checkFile) fs.rmSync(checkFile, { force: true });
  });

  test('the real check of the control prompt ends fail on the deterministic false_answer_rate row', async () => {
    const lines = [];
    const runner = createRagGateRunner({
      repoRoot: REPO_ROOT,
      spawn: childProcess.spawn,
      readCurrentEnv: () => currentValues(),
      log: (line, data) => lines.push({ line, data }),
    });
    const started = Date.now();
    const answer = await runner.start({
      kind: 'prompt',
      force: true,
      prompt: { preContext: control.RAG_PRE_CONTEXT, postContext: control.RAG_POST_CONTEXT },
    });
    assert.equal(answer.status, 202, JSON.stringify(answer.body));
    const id = answer.body.check_id;
    while (Date.now() - started < CHECK_TIMEOUT_MS + 30000) {
      const current = runner.get(id);
      if (current && current.status === 'done') {
        check = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    wallMs = Date.now() - started;
    assert.ok(check, `the check did not finish within ${CHECK_TIMEOUT_MS} ms`);
    checkFile = path.join(REPO_ROOT, gateCore.CHECK_DIR, `${id}.json`);
    console.log(`[Config Gate e2e] check wall time ${(wallMs / 1000).toFixed(1)} s`);

    assert.equal(check.result, 'fail', `result ${check.result}, error_reason ${check.error_reason}`);
    const [deterministic, live] = check.layers;
    assert.equal(deterministic.layer, 'deterministic');
    assert.equal(deterministic.result, 'fail');
    const row = deterministic.checks.find((entry) => entry.check === 'false_answer_rate' && entry.slice === 'overall');
    assert.ok(row, 'no false_answer_rate row for slice overall');
    assert.equal(row.result, 'failed', 'the false_answer_rate row must fail, not be report_only');
    assert.notEqual(row.reason, 'baseline_failing');
    assert.equal(live.layer, 'live');
    assert.equal(live.result, 'skipped');
    assert.equal(live.reason, 'switched_off');

    const workDir = path.join(REPO_ROOT, gateCore.CHECK_DIR, id);
    const remaining = filesUnder(workDir);
    const valueFiles = remaining.filter((file) => VALUE_FILES.includes(path.basename(file)));
    assert.deepEqual(valueFiles, [], 'the overlay and environment files of the run are deleted');
    for (const file of remaining) {
      const text = fs.readFileSync(file, 'utf8');
      for (const value of [control.RAG_PRE_CONTEXT, control.RAG_POST_CONTEXT]) {
        if (value) assert.ok(!text.includes(value), `${path.relative(REPO_ROOT, file)} holds a control prompt value`);
      }
    }
    const stored = fs.readFileSync(checkFile, 'utf8');
    for (const value of [control.RAG_PRE_CONTEXT, control.RAG_POST_CONTEXT, CURRENT_PRE]) {
      if (value) assert.ok(!stored.includes(value), 'the stored check holds no prompt value');
    }
  });

  test('saving the control prompt in enforce with that check answers 409; an override with a reason writes and records fail', async () => {
    assert.ok(check, 'needs the finished check of the previous test');
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myrag-config-gate-e2e-'));
    fs.mkdirSync(path.join(tempRoot, 'public'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, gateCore.CHECK_DIR), { recursive: true });
    fs.copyFileSync(checkFile, path.join(tempRoot, gateCore.CHECK_DIR, `${check.check_id}.json`));
    const envFile = path.join(tempRoot, '.env.local');
    fs.writeFileSync(envFile, envText(currentValues()));
    const beforeBytes = fs.readFileSync(envFile);

    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    process.env.MYRAG_CONFIG_ROOT = tempRoot;
    delete process.env.RAG_CONFIG_GATE;
    const mod = require('../config-server.js');
    app = mod.app;
    server = mod.server;
    app.locals.ragGateMakeClient = () => ({
      from: () => ({
        insert: (row) => ({
          select: () => ({
            single: async () => {
              rows.push(row);
              return { data: { id: crypto.randomUUID() }, error: null };
            },
          }),
        }),
      }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;

    const save = { NEXT_PUBLIC_APP_NAME: 'Demo', RAG_PRE_CONTEXT: control.RAG_PRE_CONTEXT, RAG_POST_CONTEXT: control.RAG_POST_CONTEXT };
    const refused = await call(port, { ...save, ragGate: { check_id: check.check_id } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'rag_gate_required');
    assert.ok(fs.readFileSync(envFile).equals(beforeBytes), '.env.local is unchanged after the refused save');
    assert.equal(rows.length, 0);

    const overridden = await call(port, { ...save, ragGate: { check_id: check.check_id, override: { reason: REASON } } });
    Object.assign(console, quiet);
    assert.equal(overridden.status, 200, JSON.stringify(overridden.json));
    assert.equal(overridden.json.ragGate.gate_result, 'fail');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gate_result, 'fail');
    assert.equal(rows[0].override_reason, REASON);
    assert.equal(rows[0].source, 'config_ui');
    assert.ok(rows[0].gate_summary.offenders.includes('false_answer_rate'));
    assert.ok(!JSON.stringify(rows[0]).includes(control.RAG_PRE_CONTEXT), 'the record holds no prompt text');
    assert.equal(dotenv.parse(fs.readFileSync(envFile, 'utf8')).RAG_PRE_CONTEXT, control.RAG_PRE_CONTEXT);
  });
});
